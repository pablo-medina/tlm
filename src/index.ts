import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from './config/load.js';
import { ConfigWatcher } from './config/watcher.js';
import { createLogger } from './logger.js';
import { Runtime } from './runtime.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { config: { type: 'string', short: 'c' } },
  });
  if (existsSync('.env')) process.loadEnvFile('.env');

  const configPath = resolve(values.config ?? process.env.TLM_CONFIG ?? 'config.yaml');
  const config = await loadConfig(configPath);
  const logger = createLogger(config.logging);
  const runtime = new Runtime(config, logger);
  const app = buildServer(runtime, logger);

  const watcher = new ConfigWatcher({
    path: configPath,
    logger,
    onReload: (next) => runtime.apply(next),
  });
  await watcher.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    watcher.stop();
    await app.close();
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void watcher.reload(true));

  await app.listen({ host: config.server.host, port: config.server.port });
  logger.info(
    {
      config: configPath,
      routes: Object.keys(config.routes),
      providers: Object.keys(config.providers),
    },
    'TLM ready',
  );
}

main().catch((error: unknown) => {
  const message =
    error instanceof ConfigError ? error.message : ((error as Error)?.stack ?? String(error));
  console.error(`tlm: ${message}`);
  process.exit(1);
});
