import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ConfigError, interpolateEnv, parseConfig } from '../src/config/load.js';

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
