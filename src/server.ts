import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { sendError } from './http/errors.js';
import { PROXIED_ENDPOINTS, proxyRequest } from './http/proxy.js';
import type { Runtime } from './runtime.js';

const REQUEST_ID = /^[\w.:-]{1,128}$/;

export function buildServer(runtime: Runtime, logger: Logger): FastifyInstance {
  const { server } = runtime.current.config;
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    // Requests are logged by the proxy handler, with routing context.
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
    bodyLimit: server.bodyLimit,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.debug(
      {
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'response sent',
    );
  });

  for (const endpoint of PROXIED_ENDPOINTS) {
    app.post(`/v1${endpoint}`, (request, reply) => proxyRequest(runtime, endpoint, request, reply));
  }

  const listModels = () => {
    const created = Math.floor(runtime.startedAt.getTime() / 1000);
    return Object.keys(runtime.current.config.routes).map((id) => ({
      id,
      object: 'model',
      created,
      owned_by: 'tlm',
    }));
  };

  app.get('/v1/models', async () => ({ object: 'list', data: listModels() }));

  app.get<{ Params: { '*': string } }>('/v1/models/*', async (request, reply) => {
    const model = listModels().find((m) => m.id === request.params['*']);
    if (model) return model;
    return sendError(
      reply,
      404,
      `The model '${request.params['*']}' does not exist.`,
      'invalid_request_error',
      'model_not_found',
      'model',
    );
  });

  app.get('/health', async () => {
    const { id, loadedAt } = runtime.current;
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      config: { generation: id, loadedAt: loadedAt.toISOString() },
      targets: runtime.health.snapshot(runtime.targetKeys()),
    };
  });

  app.setNotFoundHandler((request, reply) =>
    sendError(
      reply,
      404,
      `Unknown endpoint: ${request.method} ${request.url}`,
      'invalid_request_error',
      'not_found',
    ),
  );

  app.setErrorHandler((error: { statusCode?: number; message: string }, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'unhandled error');
    return sendError(
      reply,
      status,
      error.message,
      status >= 500 ? 'server_error' : 'invalid_request_error',
    );
  });

  return app;
}
