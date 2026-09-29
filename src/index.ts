import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfigSource, type ConfigSource } from './config/load.js';
import { ConfigWatcher } from './config/watcher.js';
import { createLogger } from './logger.js';
import { SecretScrubber } from './redact.js';
import { Runtime } from './runtime.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      'env-file': { type: 'string', short: 'e' },
    },
  });

  const configPath = resolve(values.config ?? process.env.TLM_CONFIG ?? 'config.yaml');
  // An explicit env file must exist; the default `.env` next to the config file is optional.
  const explicitEnvFile = values['env-file'] ?? process.env.TLM_ENV_FILE;
  const source: ConfigSource = {
    configPath,
    envFile: explicitEnvFile
      ? { path: resolve(explicitEnvFile), required: true }
      : { path: join(dirname(configPath), '.env'), required: false },
  };

  const config = await loadConfigSource(source);
  const scrubber = new SecretScrubber(config);
  const logger = createLogger(config.logging, scrubber);
  const runtime = new Runtime(config, logger, scrubber);
  const app = buildServer(runtime, logger);

  const watcher = new ConfigWatcher({
    files: [source.configPath, source.envFile.path],
    load: () => loadConfigSource(source),
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
      envFile: source.envFile.path,
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
