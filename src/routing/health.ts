import type { HealthConfig } from '../config/schema.js';

/** Smoothing factor for the latency moving average. */
const LATENCY_ALPHA = 0.3;

interface TargetHealth {
  consecutiveFailures: number;
  cooldownUntil: number;
  latencyMs?: number;
  lastError?: string;
  lastFailureAt?: number;
  lastSuccessAt?: number;
}

export interface TargetHealthSnapshot {
  target: string;
  available: boolean;
  consecutiveFailures: number;
  cooldownRemainingMs: number;
  latencyMs?: number;
  lastError?: string;
  lastFailureAt?: string;
  lastSuccessAt?: string;
}

export interface FailureResult {
  /** True when this failure put the target into cooldown. */
  cooldownStarted: boolean;
  consecutiveFailures: number;
}

/**
 * Tracks per-target health (a target is `provider/model`).
 * After `failureThreshold` consecutive failures a target enters cooldown for `cooldownMs`.
 * State survives config reloads.
 */
export class HealthTracker {
  private readonly targets = new Map<string, TargetHealth>();

  constructor(
    private config: HealthConfig,
    private readonly now: () => number = Date.now,
  ) {}

  updateConfig(config: HealthConfig): void {
    this.config = config;
  }

  isAvailable(key: string): boolean {
    const state = this.targets.get(key);
    return !state || state.cooldownUntil <= this.now();
  }

  latency(key: string): number | undefined {
    return this.targets.get(key)?.latencyMs;
  }

  recordSuccess(key: string, latencyMs: number): void {
    const state = this.get(key);
    state.consecutiveFailures = 0;
    state.cooldownUntil = 0;
    state.lastSuccessAt = this.now();
    state.latencyMs =
      state.latencyMs === undefined
        ? latencyMs
        : LATENCY_ALPHA * latencyMs + (1 - LATENCY_ALPHA) * state.latencyMs;
  }

  recordFailure(key: string, reason: string): FailureResult {
    const state = this.get(key);
    const now = this.now();
    state.consecutiveFailures += 1;
    state.lastError = reason;
    state.lastFailureAt = now;

    const cooldownStarted =
      state.consecutiveFailures >= this.config.failureThreshold &&
      this.config.cooldownMs > 0 &&
      state.cooldownUntil <= now;
    if (cooldownStarted) state.cooldownUntil = now + this.config.cooldownMs;
    return { cooldownStarted, consecutiveFailures: state.consecutiveFailures };
  }

  snapshot(keys: Iterable<string>): TargetHealthSnapshot[] {
    const now = this.now();
    return [...new Set(keys)].map((key) => {
      const state = this.targets.get(key);
      const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : undefined);
      return {
        target: key,
        available: this.isAvailable(key),
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        cooldownRemainingMs: Math.max(0, (state?.cooldownUntil ?? 0) - now),
        latencyMs: state?.latencyMs === undefined ? undefined : Math.round(state.latencyMs),
        lastError: state?.lastError,
        lastFailureAt: iso(state?.lastFailureAt),
        lastSuccessAt: iso(state?.lastSuccessAt),
      };
    });
  }

  private get(key: string): TargetHealth {
    let state = this.targets.get(key);
    if (!state) {
      state = { consecutiveFailures: 0, cooldownUntil: 0 };
      this.targets.set(key, state);
    }
    return state;
  }
}
