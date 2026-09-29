import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { Logger } from 'pino';
import type { Config } from './schema.js';

export interface ConfigWatcherOptions {
  /** Files whose changes trigger a reload (the config file and the env file). */
  files: string[];
  /** Loads and validates the configuration from those files. */
  load: () => Promise<Config>;
  logger: Logger;
  onReload: (config: Config) => void;
  debounceMs?: number;
}

/**
 * Watches the configuration inputs and calls `onReload` with every valid new configuration.
 * Parent directories are watched (not the files) so editors that save by rename still work, and so
 * a file that does not exist yet (an optional `.env`) is picked up when it is created.
 * Invalid configurations are logged and ignored; the previous one stays active.
 */
export class ConfigWatcher {
  private readonly watchers: FSWatcher[] = [];
  private timer?: NodeJS.Timeout;
  private lastHash?: string;
  private readonly files: string[];

  constructor(private readonly options: ConfigWatcherOptions) {
    this.files = [...new Set(options.files.map((file) => resolve(file)))];
  }

  async start(): Promise<void> {
    this.lastHash = await this.hashFiles();

    const namesByDir = new Map<string, Set<string>>();
    for (const file of this.files) {
      const names = namesByDir.get(dirname(file)) ?? new Set<string>();
      names.add(basename(file));
      namesByDir.set(dirname(file), names);
    }

    for (const [dir, names] of namesByDir) {
      const watcher = watch(dir, (_event, changed) => {
        if (changed && !names.has(changed.toString())) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.reload(), this.options.debounceMs ?? 200);
      });
      watcher.on('error', (error) =>
        this.options.logger.error({ err: error, dir }, 'configuration watcher failed'),
      );
      this.watchers.push(watcher);
    }
    this.options.logger.info({ files: this.files }, 'watching configuration files for changes');
  }

  /** Reloads if any watched file changed (or always, with `force`) and the result is valid. */
  async reload(force = false): Promise<boolean> {
    const { logger, onReload, load } = this.options;
    const hash = await this.hashFiles();
    if (!force && hash === this.lastHash) return false;

    try {
      const config = await load();
      this.lastHash = hash;
      onReload(config);
      return true;
    } catch (error) {
      logger.error(
        { reason: (error as Error).message },
        'configuration change rejected; keeping current one',
      );
      return false;
    }
  }

  stop(): void {
    clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.close();
  }

  /** Hash of every watched file's content; missing files count as empty. */
  private async hashFiles(): Promise<string> {
    const hash = createHash('sha256');
    for (const file of this.files) {
      const content = await readFile(file, 'utf8').catch(() => '');
      hash.update(file).update('\0').update(content).update('\0');
    }
    return hash.digest('hex');
  }
}
