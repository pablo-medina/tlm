import { afterEach, describe, expect, it } from 'vitest';
import {
  chat,
  createApp,
  makeConfig,
  okHandler,
  startForwardProxy,
  startMockUpstream,
  statusHandler,
  streamHandler,
  type MockUpstream,
} from './helpers.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

async function upstream(...args: Parameters<typeof startMockUpstream>): Promise<MockUpstream> {
  const mock = await startMockUpstream(...args);
  cleanup.push(mock.close);
  return mock;
}

function app(input: Record<string, unknown>) {
  const instance = createApp(makeConfig(input));
  cleanup.push(instance.close);
  return instance;
}

describe('routing', () => {
  it('forwards to the target with the upstream model name and API key', async () => {
    const a = await upstream(okHandler('hello'));
    const { app: server } = app({
      providers: { a: { baseUrl: a.url, apiKey: 'sk-a', headers: { 'x-extra': '1' } } },
      routes: { smart: { targets: [{ provider: 'a', model: 'real-model' }] } },
    });

    const res = await server.inject(chat('smart', { temperature: 0.2 }));

    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe('hello');
    expect(res.headers['x-tlm-provider']).toBe('a');
    expect(res.headers['x-tlm-model']).toBe('real-model');
    expect(res.headers['x-tlm-attempts']).toBe('1');
    expect(res.headers['x-ratelimit-remaining-requests']).toBe('99');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(a.received[0]).toMatchObject({
      path: '/v1/chat/completions',
      body: { model: 'real-model', temperature: 0.2 },
    });
    expect(a.received[0]!.headers.authorization).toBe('Bearer sk-a');
    expect(a.received[0]!.headers['x-extra']).toBe('1');
  });

  it('returns 404 for unknown models', async () => {
    const a = await upstream();
    const { app: server } = app({
      providers: { a: { baseUrl: a.url } },
      routes: { smart: { targets: [{ provider: 'a', model: 'm' }] } },
    });

    const res = await server.inject(chat('gpt-unknown'));

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('model_not_found');
    expect(a.received).toHaveLength(0);
  });

  it('returns 400 when the model is missing', async () => {
    const a = await upstream();
    const { app: server } = app({
      providers: { a: { baseUrl: a.url } },
      routes: { smart: { targets: [{ provider: 'a', model: 'm' }] } },
    });
    const res = await server.inject({ method: 'POST', url: '/v1/chat/completions', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('routes embeddings and completions too', async () => {
    const a = await upstream((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.path }));
    });
    const { app: server } = app({
      providers: { a: { baseUrl: a.url } },
      routes: { emb: { targets: [{ provider: 'a', model: 'm' }] } },
    });

    for (const path of ['/v1/embeddings', '/v1/completions']) {
      const res = await server.inject({ method: 'POST', url: path, payload: { model: 'emb' } });
      expect(res.json()).toEqual({ path });
    }
  });

  it('lists routes as models', async () => {
    const a = await upstream();
    const { app: server } = app({
      providers: { a: { baseUrl: a.url } },
      routes: {
        fast: { targets: [{ provider: 'a', model: 'm' }] },
        'org/smart': { targets: [{ provider: 'a', model: 'm' }] },
      },
    });

    const list = await server.inject({ method: 'GET', url: '/v1/models' });
    expect(list.json().data.map((m: { id: string }) => m.id)).toEqual(['fast', 'org/smart']);
    expect((await server.inject({ method: 'GET', url: '/v1/models/org/smart' })).statusCode).toBe(
      200,
    );
    expect((await server.inject({ method: 'GET', url: '/v1/models/nope' })).statusCode).toBe(404);
  });
});

describe('fallback', () => {
  it('falls back to the next target on retryable statuses', async () => {
    const a = await upstream(statusHandler(503));
    const b = await upstream(okHandler('from b'));
    const { app: server, runtime } = app({
      providers: { a: { baseUrl: a.url }, b: { baseUrl: b.url } },
      routes: {
        smart: {
          targets: [
            { provider: 'a', model: 'm1' },
            { provider: 'b', model: 'm2' },
          ],
        },
      },
    });

    const res = await server.inject(chat('smart'));

    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe('from b');
    expect(res.headers['x-tlm-provider']).toBe('b');
    expect(res.headers['x-tlm-attempts']).toBe('2');
    expect(runtime.health.snapshot(['a/m1'])[0]!.consecutiveFailures).toBe(1);
  });

  it('falls back on network errors', async () => {
    const b = await upstream(okHandler('from b'));
    const { app: server } = app({
      providers: { dead: { baseUrl: 'http://127.0.0.1:1/v1' }, b: { baseUrl: b.url } },
      routes: {
        smart: {
          targets: [
            { provider: 'dead', model: 'm' },
            { provider: 'b', model: 'm' },
          ],
        },
      },
    });

    const res = await server.inject(chat('smart'));
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-tlm-provider']).toBe('b');
  });

  it('falls back on timeouts and reports 504 when every target times out', async () => {
    const slow = await upstream(async (req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      okHandler('slow')(req, res);
    });
    const b = await upstream(okHandler('fast'));
    const { app: server } = app({
      providers: { slow: { baseUrl: slow.url, timeoutMs: 100 }, b: { baseUrl: b.url } },
      routes: {
        smart: {
          targets: [
            { provider: 'slow', model: 'm' },
            { provider: 'b', model: 'm' },
          ],
        },
        only: { targets: [{ provider: 'slow', model: 'm' }] },
      },
    });

    expect((await server.inject(chat('smart'))).headers['x-tlm-provider']).toBe('b');

    const res = await server.inject(chat('only'));
    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe('upstream_timeout');
  });

  it('does not fall back on client errors (4xx not in retryOn)', async () => {
    const a = await upstream(statusHandler(400, 'bad messages'));
    const b = await upstream(okHandler('from b'));
    const { app: server, runtime } = app({
      providers: { a: { baseUrl: a.url }, b: { baseUrl: b.url } },
      routes: {
        smart: {
          targets: [
            { provider: 'a', model: 'm' },
            { provider: 'b', model: 'm' },
          ],
        },
      },
    });

    const res = await server.inject(chat('smart'));

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('bad messages');
    expect(b.received).toHaveLength(0);
    expect(runtime.health.snapshot(['a/m'])[0]!.consecutiveFailures).toBe(0);
  });

  it('returns the last upstream error when every target fails', async () => {
    const a = await upstream(statusHandler(500));
    const b = await upstream(statusHandler(429, 'slow down'));
    const { app: server } = app({
      providers: { a: { baseUrl: a.url }, b: { baseUrl: b.url } },
      routes: {
        smart: {
          targets: [
            { provider: 'a', model: 'm' },
            { provider: 'b', model: 'm' },
          ],
        },
      },
    });

    const res = await server.inject(chat('smart'));
    expect(res.statusCode).toBe(429);
    expect(res.json().error.message).toBe('slow down');
    expect(res.headers['x-tlm-attempts']).toBe('2');
  });

  it('only tries the first target when fallback is disabled', async () => {
    const a = await upstream(statusHandler(503));
    const b = await upstream(okHandler('from b'));
    const { app: server } = app({
      providers: { a: { baseUrl: a.url }, b: { baseUrl: b.url } },
      routes: {
        smart: {
          fallback: false,
          targets: [
            { provider: 'a', model: 'm' },
            { provider: 'b', model: 'm' },
          ],
        },
      },
    });

    expect((await server.inject(chat('smart'))).statusCode).toBe(503);
    expect(b.received).toHaveLength(0);
  });

  it('skips targets in cooldown', async () => {
    const a = await upstream(statusHandler(500));
    const b = await upstream(okHandler('from b'));
    const { app: server } = app({
      health: { failureThreshold: 1, cooldownMs: 60_000 },
      providers: { a: { baseUrl: a.url }, b: { baseUrl: b.url } },
      routes: {
        smart: {
          targets: [
            { provider: 'a', model: 'm' },
            { provider: 'b', model: 'm' },
          ],
        },
      },
    });

    await server.inject(chat('smart'));
    const res = await server.inject(chat('smart'));

    expect(res.headers['x-tlm-attempts']).toBe('1');
    expect(a.received).toHaveLength(1);
    expect(b.received).toHaveLength(2);
  });
});

describe('streaming', () => {
  it('relays server-sent events', async () => {
    const a = await upstream(streamHandler(['Hel', 'lo']));
    const { app: server } = app({
      providers: { a: { baseUrl: a.url } },
      routes: { smart: { targets: [{ provider: 'a', model: 'm' }] } },
    });

    const res = await server.inject(chat('smart', { stream: true }));

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['x-tlm-provider']).toBe('a');
    expect(res.body).toContain('"Hel"');
    expect(res.body).toContain('"lo"');
    expect(res.body.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('falls back when a stream fails before the first byte', async () => {
    const a = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      setTimeout(() => res.destroy(), 10);
    });
    const b = await upstream(streamHandler(['from b']));
    const { app: server } = app({
      providers: { a: { baseUrl: a.url }, b: { baseUrl: b.url } },
      routes: {
        smart: {
          targets: [
            { provider: 'a', model: 'm' },
            { provider: 'b', model: 'm' },
          ],
        },
      },
    });

    const res = await server.inject(chat('smart', { stream: true }));

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-tlm-provider']).toBe('b');
    expect(res.body).toContain('from b');
  });
});

describe('outbound proxy', () => {
  it('sends upstream traffic through the configured proxy', async () => {
    const proxy = await startForwardProxy();
    cleanup.push(proxy.close);
    const a = await upstream(okHandler('via proxy'));
    const { app: server } = app({
      proxy: { url: proxy.url },
      providers: { a: { baseUrl: a.url } },
      routes: { smart: { targets: [{ provider: 'a', model: 'm' }] } },
    });

    const res = await server.inject(chat('smart'));

    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe('via proxy');
    expect(proxy.hits).toHaveLength(1);
    expect(proxy.hits[0]).toContain(new URL(a.url).host);
  });

  it('bypasses the proxy for noProxy hosts and providers with proxy: false', async () => {
    const proxy = await startForwardProxy();
    cleanup.push(proxy.close);
    const a = await upstream(okHandler('direct'));
    const { app: server } = app({
      proxy: { url: proxy.url, noProxy: ['127.0.0.1'] },
      providers: {
        a: { baseUrl: a.url },
        b: { baseUrl: a.url.replace('127.0.0.1', 'localhost'), proxy: false },
      },
      routes: {
        viaNoProxy: { targets: [{ provider: 'a', model: 'm' }] },
        viaFalse: { targets: [{ provider: 'b', model: 'm' }] },
      },
    });

    expect((await server.inject(chat('viaNoProxy'))).statusCode).toBe(200);
    expect((await server.inject(chat('viaFalse'))).statusCode).toBe(200);
    expect(proxy.hits).toHaveLength(0);
  });
});

describe('health endpoint', () => {
  it('reports per-target health', async () => {
    const a = await upstream(statusHandler(500));
    const { app: server } = app({
      providers: { a: { baseUrl: a.url } },
      routes: { smart: { targets: [{ provider: 'a', model: 'm' }] } },
    });
    await server.inject(chat('smart'));

    const res = await server.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ok',
      config: { generation: 1 },
      targets: [{ target: 'a/m', consecutiveFailures: 1, lastError: 'HTTP 500' }],
    });
  });
});
