import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { pino } from 'pino';
import { configSchema, type Config } from '../src/config/schema.js';
import { Runtime } from '../src/runtime.js';
import { buildServer } from '../src/server.js';

export interface ReceivedRequest {
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

export type MockHandler = (req: ReceivedRequest, res: ServerResponse) => void | Promise<void>;

export interface MockUpstream {
  url: string;
  received: ReceivedRequest[];
  setHandler(handler: MockHandler): void;
  close(): Promise<void>;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A fake OpenAI-compatible provider. Its base URL ends in `/v1`. */
export async function startMockUpstream(
  handler: MockHandler = okHandler('ok'),
): Promise<MockUpstream> {
  const received: ReceivedRequest[] = [];
  let current = handler;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const entry: ReceivedRequest = {
      path: req.url ?? '',
      headers: req.headers,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    };
    received.push(entry);
    await current(entry, res);
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/v1`,
    received,
    setHandler: (next) => (current = next),
    close: () => closeServer(server),
  };
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-ratelimit-remaining-requests': '99',
  });
  res.end(JSON.stringify(body));
}

export function okHandler(content: string): MockHandler {
  return (req, res) =>
    json(res, 200, {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      model: req.body.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
}

export function streamHandler(tokens: string[]): MockHandler {
  return async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const token of tokens) {
      const chunk = { model: req.body.model, choices: [{ delta: { content: token } }] };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    res.write(
      `data: ${JSON.stringify({ choices: [], usage: { total_tokens: tokens.length } })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  };
}

export function statusHandler(status: number, message = `error ${status}`): MockHandler {
  return (_req, res) =>
    json(res, status, { error: { message, type: 'upstream', code: null, param: null } });
}

/** A minimal HTTP forward proxy (absolute-form requests and CONNECT tunnels) that records hits. */
export async function startForwardProxy(): Promise<{
  url: string;
  hits: string[];
  close(): Promise<void>;
}> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const target = new URL(req.url ?? '');
    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: req.method,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  server.on('connect', (req, socket, head) => {
    hits.push(`CONNECT ${req.url}`);
    const [host, port] = (req.url ?? '').split(':');
    const upstream = connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, hits, close: () => closeServer(server) };
}

export function makeConfig(input: Record<string, unknown>): Config {
  return configSchema.parse({ logging: { level: 'silent' }, ...input });
}

export function createApp(config: Config) {
  const logger = pino({ level: config.logging.level });
  const runtime = new Runtime(config, logger);
  const app = buildServer(runtime, logger);
  return {
    app,
    runtime,
    close: async () => {
      await app.close();
      await runtime.close();
    },
  };
}

export const chat = (model: string, extra: Record<string, unknown> = {}) => ({
  method: 'POST' as const,
  url: '/v1/chat/completions',
  payload: { model, messages: [{ role: 'user', content: 'hi' }], ...extra },
});
