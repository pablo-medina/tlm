import type { RouteConfig, TargetConfig } from '../config/schema.js';
import type { HealthTracker } from './health.js';
import { strategies, targetKey } from './strategies.js';

export interface RoutePlan {
  /** Targets to attempt, in order. */
  targets: TargetConfig[];
  /** Keys of targets that were deprioritized because they are cooling down. */
  coolingDown: string[];
}

/**
 * Turns a route into an ordered list of targets to attempt:
 * 1. the route strategy orders all targets;
 * 2. targets in cooldown are moved to the end (still tried as a last resort);
 * 3. the list is truncated to 1 (fallback disabled) or `maxAttempts`.
 */
export class Router {
  private readonly counters = new Map<string, number>();

  constructor(
    private readonly health: HealthTracker,
    private readonly random: () => number = Math.random,
  ) {}

  plan(routeName: string, route: RouteConfig): RoutePlan {
    const ordered = strategies[route.strategy]({
      routeName,
      targets: route.targets,
      health: this.health,
      counters: this.counters,
      random: this.random,
    });

    const available: TargetConfig[] = [];
    const cooling: TargetConfig[] = [];
    for (const target of ordered) {
      (this.health.isAvailable(targetKey(target)) ? available : cooling).push(target);
    }

    const limit = route.fallback ? (route.maxAttempts ?? ordered.length) : 1;
    return {
      targets: [...available, ...cooling].slice(0, limit),
      coolingDown: cooling.map(targetKey),
    };
  }
}
