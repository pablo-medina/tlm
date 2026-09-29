import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, interpolateEnv, parseConfig, readEnvFile } from '../src/config/load.js';

const minimal = [
  'providers:',
  '  openai:',
  '    baseUrl: https://api.openai.com/v1',
  '    apiKey: ${OPENAI_API_KEY}',
  'routes:',
  '  smart:',
  '    targets:',
  '      - { provider: openai, model: gpt-4o }',
  '',
].join('\n');

const env = { OPENAI_API_KEY: 'sk-test' };

describe('interpolateEnv', () => {
  it('replaces variables recursively and applies defaults', () => {
    const result = interpolateEnv({ a: '${A}', list: ['x-${B:-fallback}'], n: 3 }, { A: 'one' });
    expect(result).toEqual({ a: 'one', list: ['x-fallback'], n: 3 });
  });

  it('reports every missing variable', () => {
    expect(() => interpolateEnv({ a: '${A}', b: '${B}' }, {})).toThrow(/A, B/);
  });
});

describe('parseConfig', () => {
  it('applies defaults', () => {
    const config = parseConfig(minimal, env);
    expect(config.server.port).toBe(30000);
    expect(config.server.host).toBe('0.0.0.0');
    expect(config.logging.level).toBe('info');
    expect(config.health).toEqual({ failureThreshold: 3, cooldownMs: 30000 });
    expect(config.upstream.retryOn).toContain(429);
    expect(config.proxy.noProxy).toEqual([]);
    expect(config.routes.smart).toMatchObject({ strategy: 'priority', fallback: true });
    expect(config.routes.smart!.targets[0]).toMatchObject({ weight: 1 });
    expect(config.providers.openai!.apiKey).toBe('sk-test');
  });

  it('rejects routes that reference unknown providers', () => {
    const source = minimal.replace('provider: openai', 'provider: nope');
    expect(() => parseConfig(source, env)).toThrow(/unknown provider "nope"/);
  });

  it('rejects unknown keys and bad values', () => {
    expect(() => parseConfig(`${minimal}foo: 1\n`, env)).toThrow(ConfigError);
    expect(() => parseConfig(`${minimal}server: { port: 0 }\n`, env)).toThrow(/port/);
  });

  it('accepts proxy settings', () => {
    const source = `${minimal}proxy: { url: 'http://proxy:3128', noProxy: [localhost] }\n`;
    const config = parseConfig(source.replace('apiKey:', 'proxy: false\n    apiKey:'), env);
    expect(config.proxy.url).toBe('http://proxy:3128');
    expect(config.proxy.noProxy).toEqual(['localhost']);
    expect(config.providers.openai!.proxy).toBe(false);
  });

  it('rejects invalid YAML', () => {
    expect(() => parseConfig('providers: [', {})).toThrow(/invalid YAML/);
  });

  it('applies timeout defaults and route overrides', () => {
    const source = minimal.replace(
      '    targets:',
      '    timeoutMs: 5000\n    requestTimeoutMs: 0\n    targets:',
    );
    const config = parseConfig(source, env);
    expect(config.server.requestTimeoutMs).toBe(600_000);
    expect(config.upstream.timeoutMs).toBe(120_000);
    expect(config.routes.smart).toMatchObject({ timeoutMs: 5000, requestTimeoutMs: 0 });
    expect(parseConfig(minimal, env).routes.smart!.requestTimeoutMs).toBeUndefined();
  });
});

describe('environment variables in non-string settings', () => {
  const withSettings = (settings: string) => `${settings}\n${minimal}`;

  it('accepts numbers, booleans and lists from placeholders', () => {
    const source = withSettings(
      [
        'server:',
        '  port: ${TLM_PORT}',
        '  requestTimeoutMs: ${TLM_REQUEST_TIMEOUT_MS}',
        'logging:',
        '  pretty: ${TLM_PRETTY}',
        '  logBodies: ${TLM_LOG_BODIES}',
        'proxy:',
        '  url: ${HTTPS_PROXY}',
        '  noProxy: ${NO_PROXY}',
        'upstream:',
        '  retryOn: ${TLM_RETRY_ON}',
      ].join('\n'),
    );
    const config = parseConfig(source, {
      ...env,
      TLM_PORT: '8080',
      TLM_REQUEST_TIMEOUT_MS: '0',
      TLM_PRETTY: 'TRUE',
      TLM_LOG_BODIES: 'false',
      HTTPS_PROXY: 'http://proxy:3128',
      NO_PROXY: 'localhost, 127.0.0.1,.internal',
      TLM_RETRY_ON: '429,503',
    });
    expect(config.server).toMatchObject({ port: 8080, requestTimeoutMs: 0 });
    expect(config.logging).toMatchObject({ pretty: true, logBodies: false });
    expect(config.proxy).toEqual({
      url: 'http://proxy:3128',
      noProxy: ['localhost', '127.0.0.1', '.internal'],
    });
    expect(config.upstream.retryOn).toEqual([429, 503]);
  });

  it('uses the default when a placeholder resolves to an empty string', () => {
    const source = withSettings('server:\n  port: ${TLM_PORT:-}\nlogging:\n  pretty: ${PRETTY:-}');
    const config = parseConfig(source, env);
    expect(config.server.port).toBe(30000);
    expect(config.logging.pretty).toBe(false);
  });

  it('supports inline defaults and provider-level values', () => {
    const source = minimal
      .replace(
        'apiKey:',
        'timeoutMs: ${OPENAI_TIMEOUT_MS:-45000}\n    proxy: ${OPENAI_PROXY:-false}\n    apiKey:',
      )
      .replace(
        'provider: openai, model: gpt-4o',
        'provider: openai, model: "${SMART_MODEL:-gpt-4o}"',
      );
    const config = parseConfig(source, { ...env, SMART_MODEL: 'gpt-4.1' });
    expect(config.providers.openai).toMatchObject({ timeoutMs: 45000, proxy: false });
    expect(config.routes.smart!.targets[0]!.model).toBe('gpt-4.1');
  });

  it('reports values that are not valid for the setting', () => {
    const source = withSettings('server:\n  port: ${TLM_PORT}');
    expect(() => parseConfig(source, { ...env, TLM_PORT: 'eighty' })).toThrow(/port/);
    expect(() =>
      parseConfig(withSettings('logging:\n  pretty: ${P}'), { ...env, P: 'maybe' }),
    ).toThrow(/pretty/);
  });

  it('keeps $${...} as a literal ${...}', () => {
    const result = interpolateEnv(
      { header: 'prefix-$${NOT_A_VAR}', mixed: '$${A}/${A}' },
      { A: 'x' },
    );
    expect(result).toEqual({ header: 'prefix-${NOT_A_VAR}', mixed: '${A}/x' });
  });

  it('treats an empty key as unset', () => {
    const config = parseConfig(minimal.replace('${OPENAI_API_KEY}', '${OPENAI_API_KEY:-}'), {});
    expect(config.providers.openai!.apiKey).toBeUndefined();
  });
});

describe('readEnvFile', () => {
  it('parses KEY=value files with comments and quotes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tlm-env-'));
    try {
      const path = join(dir, '.env');
      await writeFile(path, '# comment\nA=1\nB="two words"\nexport C=3\n');
      expect(await readEnvFile({ path, required: true })).toMatchObject({
        A: '1',
        B: 'two words',
      });
      expect(await readEnvFile({ path: join(dir, 'nope'), required: false })).toEqual({});
      await expect(readEnvFile({ path: join(dir, 'nope'), required: true })).rejects.toThrow(
        ConfigError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('config.example.yaml', () => {
  it('is valid', async () => {
    const source = await readFile(new URL('../config.example.yaml', import.meta.url), 'utf8');
    const config = parseConfig(source, { OPENAI_API_KEY: 'sk-1', GROQ_API_KEY: 'gsk-1' });
    expect(config.proxy.url).toBeUndefined();
    expect(Object.keys(config.routes).length).toBeGreaterThan(0);
  });

  it('enables the proxy when HTTPS_PROXY is set', async () => {
    const source = await readFile(new URL('../config.example.yaml', import.meta.url), 'utf8');
    const config = parseConfig(source, {
      OPENAI_API_KEY: 'sk-1',
      GROQ_API_KEY: 'gsk-1',
      HTTPS_PROXY: 'http://proxy:3128',
    });
    expect(config.proxy.url).toBe('http://proxy:3128');
  });
});
