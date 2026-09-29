import type { Logger } from 'pino';
import type { Config } from './config/schema.js';
import type { SecretScrubber } from './redact.js';
import { HealthTracker } from './routing/health.js';
import { Router } from './routing/router.js';
import { targetKey } from './routing/strategies.js';
import { Dispatchers } from './upstream/dispatchers.js';

/** One immutable configuration generation. Requests capture it once and use it throughout. */
export interface Generation {
  readonly id: number;
  readonly config: Config;
  readonly dispatchers: Dispatchers;
  readonly loadedAt: Date;
}

/**
 * Holds the active configuration and the state that must survive reloads
 * (target health, round-robin counters).
 */
export class Runtime {
  readonly health: HealthTracker;
  readonly router: Router;
  readonly startedAt = new Date();
  private generation: Generation;

  constructor(
    config: Config,
    private readonly logger: Logger,
    private readonly scrubber?: SecretScrubber,
  ) {
    this.health = new HealthTracker(config.health);
    this.router = new Router(this.health);
    this.generation = this.createGeneration(1, config);
  }

  get current(): Generation {
    return this.generation;
  }

  /** Swaps in a new configuration. Settings that need a restart are reported, not applied. */
  apply(config: Config): void {
    const previous = this.generation;
    const restartRequired: string[] = [];
    if (config.server.host !== previous.config.server.host) restartRequired.push('server.host');
    if (config.server.port !== previous.config.server.port) restartRequired.push('server.port');
    if (config.server.bodyLimit !== previous.config.server.bodyLimit)
      restartRequired.push('server.bodyLimit');
    if (config.logging.pretty !== previous.config.logging.pretty)
      restartRequired.push('logging.pretty');

    // Register the new secrets before anything logs with the new configuration.
    this.scrubber?.update(config);
    this.health.updateConfig(config.health);
    this.logger.level = config.logging.level;
    this.generation = this.createGeneration(previous.id + 1, config);

    // Let in-flight requests on the old pools finish before closing them.
    void previous.dispatchers.close();

    this.logger.info(
      {
        generation: this.generation.id,
        providers: Object.keys(config.providers).length,
        routes: Object.keys(config.routes),
      },
      'configuration reloaded',
    );
    if (restartRequired.length > 0) {
      this.logger.warn(
        { settings: restartRequired },
        'some changed settings only take effect after a restart',
      );
    }
  }

  /** Every `provider/model` key referenced by the current routes. */
  targetKeys(): string[] {
    return Object.values(this.generation.config.routes).flatMap((route) =>
      route.targets.map(targetKey),
    );
  }

  /** Removes provider credentials from text that leaves TLM (logs, upstream error bodies). */
  scrub(text: string): string {
    return this.scrubber ? this.scrubber.scrub(text) : text;
  }

  async close(): Promise<void> {
    await this.generation.dispatchers.close();
  }

  private createGeneration(id: number, config: Config): Generation {
    return { id, config, dispatchers: new Dispatchers(config), loadedAt: new Date() };
  }
}
