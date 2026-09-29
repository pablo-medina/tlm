import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { Logger } from 'pino';
import { parseConfig } from './load.js';
import type { Config } from './schema.js';

export interface ConfigWatcherOptions {
  path: string;
  logger: Logger;
  onReload: (config: Config) => void;
  debounceMs?: number;
}

/**
 * Watches the configuration file and calls `onReload` with every valid new version.
 * The parent directory is watched (not the file) so editors that save by rename still work.
 * Invalid configurations are logged and ignored; the previous one stays active.
 */
export class ConfigWatcher {
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private lastHash?: string;
  private readonly path: string;

  constructor(private readonly options: ConfigWatcherOptions) {
    this.path = resolve(options.path);
  }

  async start(): Promise<void> {
    this.lastHash = await this.hashFile().catch(() => undefined);
    const file = basename(this.path);
    this.watcher = watch(dirname(this.path), (_event, changed) => {
      if (changed && changed.toString() !== file) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.reload(), this.options.debounceMs ?? 200);
    });
    this.watcher.on('error', (error) =>
      this.options.logger.error({ err: error }, 'configuration watcher failed'),
    );
    this.options.logger.info({ path: this.path }, 'watching configuration file for changes');
  }

  /** Re-reads the file; applies it only if its content changed and it is valid. */
  async reload(force = false): Promise<boolean> {
    const { logger, onReload } = this.options;
    let source: string;
    try {
      source = await readFile(this.path, 'utf8');
    } catch (error) {
      logger.error(
        { path: this.path, err: error },
        'cannot read configuration file; keeping current one',
      );
      return false;
    }

    const hash = createHash('sha256').update(source).digest('hex');
    if (!force && hash === this.lastHash) return false;

    try {
      const config = parseConfig(source);
      this.lastHash = hash;
      onReload(config);
      return true;
    } catch (error) {
      logger.error(
        { path: this.path, reason: (error as Error).message },
        'configuration change rejected; keeping current one',
      );
      return false;
    }
  }

  stop(): void {
    clearTimeout(this.timer);
    this.watcher?.close();
  }

  private async hashFile(): Promise<string> {
    return createHash('sha256')
      .update(await readFile(this.path, 'utf8'))
      .digest('hex');
  }
}
