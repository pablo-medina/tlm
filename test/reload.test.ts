import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfigSource, type ConfigSource } from '../src/config/load.js';
import { ConfigWatcher } from '../src/config/watcher.js';
import { Runtime } from '../src/runtime.js';

const yaml = (routes: string[]) =>
  [
    'logging: { level: silent }',
    'providers:',
    '  a: { baseUrl: "http://127.0.0.1:1/v1" }',
    'routes:',
    ...routes.map((name) => `  ${name}: { targets: [{ provider: a, model: "\${MODEL:-m}" }] }`),
    '',
  ].join('\n');

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('config hot reload', () => {
  let dir: string;
  let path: string;
  let envPath: string;
  let source: ConfigSource;
  let runtime: Runtime;
  let watcher: ConfigWatcher;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlm-test-'));
    path = join(dir, 'config.yaml');
    envPath = join(dir, '.env');
    source = { configPath: path, envFile: { path: envPath, required: false } };
    await writeFile(path, yaml(['first']));
    const logger = pino({ level: 'silent' });
    const load = () => loadConfigSource(source, {});
    runtime = new Runtime(await load(), logger);
    watcher = new ConfigWatcher({
      files: [path, envPath],
      load,
      logger,
      debounceMs: 20,
      onReload: (config) => runtime.apply(config),
    });
    await watcher.start();
  });

  afterEach(async () => {
    watcher.stop();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('applies valid changes', async () => {
    await writeFile(path, yaml(['first', 'second']));
    await waitFor(() => 'second' in runtime.current.config.routes);
    expect(runtime.current.id).toBe(2);
  });

  it('keeps the current configuration when the new one is invalid', async () => {
    await writeFile(path, yaml(['first']).replace('provider: a', 'provider: missing'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(runtime.current.id).toBe(1);

    await writeFile(path, yaml(['fixed']));
    await waitFor(() => 'fixed' in runtime.current.config.routes);
  });

  it('keeps target health across reloads', async () => {
    runtime.health.recordFailure('a/m', 'boom');
    await writeFile(path, yaml(['first', 'second']));
    await waitFor(() => runtime.current.id === 2);
    expect(runtime.health.snapshot(['a/m'])[0]!.consecutiveFailures).toBe(1);
  });

  it('ignores writes that do not change the content', async () => {
    await writeFile(path, yaml(['first']));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(runtime.current.id).toBe(1);
  });

  const firstModel = () => runtime.current.config.routes.first!.targets[0]!.model;

  it('reloads when the .env file is created or changed', async () => {
    expect(firstModel()).toBe('m');
    await writeFile(envPath, 'MODEL=from-dotenv\n');
    await waitFor(() => firstModel() === 'from-dotenv');
    await writeFile(envPath, 'MODEL=changed\n');
    await waitFor(() => firstModel() === 'changed');
  });

  it('gives the process environment precedence over .env', async () => {
    await writeFile(envPath, 'MODEL=from-dotenv\n');
    const config = await loadConfigSource(source, { MODEL: 'from-process' });
    expect(config.routes.first!.targets[0]!.model).toBe('from-process');
  });

  it('fails when an explicit env file is missing', async () => {
    const explicit = { ...source, envFile: { path: join(dir, 'missing.env'), required: true } };
    await expect(loadConfigSource(explicit, {})).rejects.toThrow(/cannot read env file/);
  });
});
