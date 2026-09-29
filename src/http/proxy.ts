import { Readable } from 'node:stream';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import type { TargetConfig } from '../config/schema.js';
import { targetKey } from '../routing/strategies.js';
import type { Runtime } from '../runtime.js';
import { describeError, sendUpstream, type UpstreamResponse } from '../upstream/client.js';
import { sendError } from './errors.js';
import { extractUsage, UsageSniffer } from './sse.js';

/** OpenAI endpoints that TLM routes, relative to `/v1` and to each provider base URL. */
export const PROXIED_ENDPOINTS = ['/chat/completions', '/completions', '/embeddings'] as const;
export type ProxiedEndpoint = (typeof PROXIED_ENDPOINTS)[number];

/** Upstream response headers that are forwarded to the client. */
const FORWARDED_HEADER = /^(x-ratelimit-|openai-processing-ms$)/;

type Failure =
  | { kind: 'http'; status: number; body: string; contentType?: string }
  | { kind: 'network'; reason: string; timeout: boolean };

const elapsed = (since: number) => Math.round(performance.now() - since);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function header(res: UpstreamResponse, name: string): string | undefined {
  const value = res.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function setRoutingHeaders(
  reply: FastifyReply,
  res: UpstreamResponse,
  route: string,
  target: TargetConfig,
  attempts: number,
): void {
  for (const [name, value] of Object.entries(res.headers)) {
    if (value !== undefined && FORWARDED_HEADER.test(name)) reply.header(name, value);
  }
  reply
    .header('x-tlm-route', route)
    .header('x-tlm-provider', target.provider)
    .header('x-tlm-model', target.model)
    .header('x-tlm-attempts', String(attempts));
}

/**
 * Routes one OpenAI request: plans the targets for the requested route and tries them in order,
 * falling back on network errors, timeouts and retryable HTTP statuses.
 *
 * Streaming responses are committed only after the first chunk arrives, so a target that fails
 * before producing any output can still fall back. Once bytes reach the client, no fallback is possible.
 */
export async function proxyRequest(
  runtime: Runtime,
  endpoint: ProxiedEndpoint,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const generation = runtime.current;
  const { config } = generation;
  const body = request.body;

  if (!isObject(body)) {
    return sendError(reply, 400, 'Request body must be a JSON object.', 'invalid_request_error');
  }
  const routeName = body.model;
  if (typeof routeName !== 'string' || routeName === '') {
    return sendError(
      reply,
      400,
      "Missing required parameter: 'model'.",
      'invalid_request_error',
      null,
      'model',
    );
  }
  const route = config.routes[routeName];
  if (!route) {
    request.log.info({ route: routeName, endpoint }, 'unknown model requested');
    return sendError(
      reply,
      404,
      `The model '${routeName}' does not exist.`,
      'invalid_request_error',
      'model_not_found',
      'model',
    );
  }

  const stream = body.stream === true;
  const plan = runtime.router.plan(routeName, route);
  const log: FastifyBaseLogger = request.log.child({ route: routeName });
  log.info(
    {
      endpoint,
      strategy: route.strategy,
      stream,
      plan: plan.targets.map(targetKey),
      ...(plan.coolingDown.length > 0 && { coolingDown: plan.coolingDown }),
    },
    'routing request',
  );
  if (config.logging.logBodies) log.debug({ body }, 'request body');

  // Abort the upstream call if the client goes away before we finish responding.
  const abort = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) abort.abort();
  });

  const started = performance.now();
  let lastFailure: Failure | undefined;

  for (const [index, target] of plan.targets.entries()) {
    const attempt = index + 1;
    const key = targetKey(target);
    const hasNext = attempt < plan.targets.length;
    const provider = config.providers[target.provider]!;
    const { dispatcher, proxy } = generation.dispatchers.get(target.provider);
    const attemptLog = log.child({ attempt, target: key });
    const attemptStarted = performance.now();

    const fail = (failure: Failure): void => {
      lastFailure = failure;
      const reason = failure.kind === 'http' ? `HTTP ${failure.status}` : failure.reason;
      const { cooldownStarted, consecutiveFailures } = runtime.health.recordFailure(key, reason);
      attemptLog.warn(
        {
          reason,
          durationMs: elapsed(attemptStarted),
          consecutiveFailures,
          next: hasNext ? 'fallback' : 'give up',
        },
        'attempt failed',
      );
      if (cooldownStarted) {
        attemptLog.warn({ cooldownMs: config.health.cooldownMs }, 'target entered cooldown');
      }
    };

    // The deadline covers the response headers and the full body (buffered) or first chunk (stream).
    const timeoutMs = provider.timeoutMs ?? config.upstream.timeoutMs;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const signal = AbortSignal.any([abort.signal, deadline.signal]);
    const networkFailure = (error: unknown): Failure =>
      deadline.signal.aborted
        ? { kind: 'network', reason: `timed out after ${timeoutMs}ms`, timeout: true }
        : { kind: 'network', ...describeError(error) };

    attemptLog.debug(
      { upstreamModel: target.model, timeoutMs, ...(proxy && { proxy }) },
      'attempt started',
    );

    let res: UpstreamResponse;
    try {
      res = await sendUpstream({
        provider,
        dispatcher,
        path: endpoint,
        body: { ...body, model: target.model },
        timeoutMs,
        signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (abort.signal.aborted) return clientGone(log, reply, started);
      fail(networkFailure(error));
      continue;
    }

    const contentType = header(res, 'content-type');

    // Upstream error status: fall back if retryable, otherwise pass it through untouched.
    if (res.statusCode >= 400) {
      const errorBody = await res.body.text().catch(() => '');
      clearTimeout(timer);
      if (config.upstream.retryOn.includes(res.statusCode)) {
        fail({ kind: 'http', status: res.statusCode, body: errorBody, contentType });
        if (hasNext) continue;
      } else {
        attemptLog.info(
          { status: res.statusCode, durationMs: elapsed(attemptStarted) },
          'non-retryable upstream error; returning it to the client',
        );
      }
      if (config.logging.logBodies) attemptLog.debug({ body: errorBody }, 'upstream error body');
      setRoutingHeaders(reply, res, routeName, target, attempt);
      log.info(
        { status: res.statusCode, target: key, attempts: attempt, durationMs: elapsed(started) },
        'request failed',
      );
      return reply
        .code(res.statusCode)
        .type(contentType ?? 'application/json')
        .send(errorBody);
    }

    // Buffered (non-streaming) response.
    if (!stream) {
      let text: string;
      try {
        text = await res.body.text();
      } catch (error) {
        if (abort.signal.aborted) return clientGone(log, reply, started);
        fail(networkFailure(error));
        continue;
      } finally {
        clearTimeout(timer);
      }
      runtime.health.recordSuccess(key, elapsed(attemptStarted));
      if (config.logging.logBodies) attemptLog.debug({ body: text }, 'response body');
      log.info(
        {
          status: res.statusCode,
          target: key,
          attempts: attempt,
          durationMs: elapsed(started),
          usage: extractUsage(text),
        },
        'request completed',
      );
      setRoutingHeaders(reply, res, routeName, target, attempt);
      return reply
        .code(res.statusCode)
        .type(contentType ?? 'application/json')
        .send(text);
    }

    // Streaming response: wait for the first chunk before committing to this target.
    const iterator: AsyncIterator<Buffer> = res.body[Symbol.asyncIterator]();
    let first: IteratorResult<Buffer>;
    try {
      first = await iterator.next();
    } catch (error) {
      if (abort.signal.aborted) return clientGone(log, reply, started);
      fail(networkFailure(error));
      continue;
    } finally {
      clearTimeout(timer);
    }

    const firstByteMs = elapsed(attemptStarted);
    runtime.health.recordSuccess(key, firstByteMs);
    attemptLog.debug({ firstByteMs }, 'stream started');
    setRoutingHeaders(reply, res, routeName, target, attempt);

    async function* relay(): AsyncGenerator<Buffer> {
      const sniffer = new UsageSniffer();
      let bytes = 0;
      let completed = false;
      try {
        if (!first.done) {
          sniffer.push(first.value);
          bytes += first.value.length;
          yield first.value;
        }
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          sniffer.push(next.value);
          bytes += next.value.length;
          yield next.value;
        }
        completed = true;
      } catch (error) {
        if (!abort.signal.aborted) {
          const { reason } = describeError(error);
          runtime.health.recordFailure(key, reason);
          log.error(
            { target: key, reason, bytes },
            'upstream stream failed after the first byte; cannot fall back',
          );
        }
        throw error;
      } finally {
        if (!completed) await iterator.return?.().catch(() => undefined);
        const outcome = completed
          ? 'request completed'
          : abort.signal.aborted
            ? 'client disconnected'
            : 'stream interrupted';
        log[completed ? 'info' : 'warn'](
          {
            status: res.statusCode,
            target: key,
            attempts: attempt,
            stream: true,
            firstByteMs,
            durationMs: elapsed(started),
            bytes,
            usage: sniffer.usage,
          },
          outcome,
        );
      }
    }

    return reply
      .code(res.statusCode)
      .header('content-type', contentType ?? 'text/event-stream')
      .header('cache-control', 'no-cache')
      .header('x-accel-buffering', 'no')
      .send(Readable.from(relay()));
  }

  // Every target failed.
  const attempts = plan.targets.length;
  log.error({ attempts, durationMs: elapsed(started) }, 'all targets failed');
  reply.header('x-tlm-route', routeName).header('x-tlm-attempts', String(attempts));
  if (lastFailure?.kind === 'http') {
    return reply
      .code(lastFailure.status)
      .type(lastFailure.contentType ?? 'application/json')
      .send(lastFailure.body);
  }
  const timeout = lastFailure?.kind === 'network' && lastFailure.timeout;
  return sendError(
    reply,
    timeout ? 504 : 502,
    `All upstream targets for '${routeName}' failed. Last error: ${lastFailure?.kind === 'network' ? lastFailure.reason : 'unknown'}`,
    'upstream_error',
    timeout ? 'upstream_timeout' : 'upstream_unavailable',
  );
}

function clientGone(log: FastifyBaseLogger, reply: FastifyReply, started: number): FastifyReply {
  log.info({ durationMs: elapsed(started) }, 'client disconnected');
  return sendError(
    reply,
    499,
    'Client closed request.',
    'invalid_request_error',
    'client_closed_request',
  );
}
