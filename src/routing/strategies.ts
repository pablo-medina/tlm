import type { StrategyName, TargetConfig } from '../config/schema.js';
import type { HealthTracker } from './health.js';

export interface StrategyContext {
  routeName: string;
  targets: readonly TargetConfig[];
  health: HealthTracker;
  /** Per-route counters that persist across requests (and config reloads). */
  counters: Map<string, number>;
  random: () => number;
}

/** Returns every target of the route in the order they should be attempted. */
export type Strategy = (ctx: StrategyContext) => TargetConfig[];

export const targetKey = (target: Pick<TargetConfig, 'provider' | 'model'>): string =>
  `${target.provider}/${target.model}`;

/** Always in configuration order: the first target is the primary, the rest are fallbacks. */
const priority: Strategy = ({ targets }) => [...targets];

/** Rotates the starting target on every request; the rest follow in configuration order. */
const roundRobin: Strategy = ({ routeName, targets, counters }) => {
  const current = counters.get(routeName) ?? 0;
  counters.set(routeName, current + 1);
  const start = current % targets.length;
  return [...targets.slice(start), ...targets.slice(0, start)];
};

/** Weighted random order (sampling without replacement). */
const weighted: Strategy = ({ targets, random }) => {
  const pool = [...targets];
  const ordered: TargetConfig[] = [];
  while (pool.length > 0) {
    const total = pool.reduce((sum, target) => sum + target.weight, 0);
    let pick = random() * total;
    let index = pool.findIndex((target) => (pick -= target.weight) < 0);
    if (index === -1) index = pool.length - 1;
    ordered.push(...pool.splice(index, 1));
  }
  return ordered;
};

/** Uniform random order (Fisher-Yates shuffle). */
const randomOrder: Strategy = ({ targets, random }) => {
  const shuffled = [...targets];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled;
};

/**
 * Lowest average latency first. Targets without measurements go first so they get measured;
 * ties keep configuration order.
 */
const leastLatency: Strategy = ({ targets, health }) =>
  targets
    .map((target, index) => ({ target, index, latency: health.latency(targetKey(target)) ?? -1 }))
    .sort((a, b) => a.latency - b.latency || a.index - b.index)
    .map(({ target }) => target);

export const strategies: Record<StrategyName, Strategy> = {
  priority,
  'round-robin': roundRobin,
  weighted,
  random: randomOrder,
  'least-latency': leastLatency,
};
