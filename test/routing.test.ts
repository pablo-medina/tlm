import { describe, expect, it } from 'vitest';
import { HealthTracker } from '../src/routing/health.js';
import { Router } from '../src/routing/router.js';
import { targetKey } from '../src/routing/strategies.js';
import { makeConfig } from './helpers.js';

const providers = {
  a: { baseUrl: 'http://a.test/v1' },
  b: { baseUrl: 'http://b.test/v1' },
  c: { baseUrl: 'http://c.test/v1' },
};
const targets = [
  { provider: 'a', model: 'm' },
  { provider: 'b', model: 'm' },
  { provider: 'c', model: 'm' },
];

function setup(route: Record<string, unknown>) {
  const config = makeConfig({ providers, routes: { r: { targets, ...route } } });
  let now = 1_000;
  const health = new HealthTracker(config.health, () => now);
  const router = new Router(health);
  const plan = () =>
    router
      .plan('r', config.routes.r!)
      .targets.map((t) => t.provider)
      .join('');
  return { health, plan, advance: (ms: number) => (now += ms) };
}

describe('strategies', () => {
  it('priority keeps configuration order', () => {
    const { plan } = setup({ strategy: 'priority' });
    expect([plan(), plan()]).toEqual(['abc', 'abc']);
  });

  it('round-robin rotates the starting target', () => {
    const { plan } = setup({ strategy: 'round-robin' });
    expect([plan(), plan(), plan(), plan()]).toEqual(['abc', 'bca', 'cab', 'abc']);
  });

  it('weighted respects weights', () => {
    const weightedTargets = [
      { provider: 'a', model: 'm', weight: 1 },
      { provider: 'b', model: 'm', weight: 3 },
    ];
    const config = makeConfig({
      providers,
      routes: { r: { strategy: 'weighted', targets: weightedTargets } },
    });
    const router = new Router(new HealthTracker(config.health));
    let firstIsB = 0;
    for (let i = 0; i < 4000; i++) {
      const plan = router.plan('r', config.routes.r!).targets;
      expect(plan).toHaveLength(2);
      if (plan[0]!.provider === 'b') firstIsB += 1;
    }
    expect(firstIsB / 4000).toBeGreaterThan(0.68);
    expect(firstIsB / 4000).toBeLessThan(0.82);
  });

  it('random returns a permutation of all targets', () => {
    const { plan } = setup({ strategy: 'random' });
    expect(plan().split('').sort().join('')).toBe('abc');
  });

  it('least-latency prefers unmeasured, then fastest targets', () => {
    const { health, plan } = setup({ strategy: 'least-latency' });
    health.recordSuccess('a/m', 300);
    health.recordSuccess('b/m', 100);
    expect(plan()).toBe('cba');
    health.recordSuccess('c/m', 200);
    expect(plan()).toBe('bca');
  });
});

describe('Router', () => {
  it('moves cooling-down targets to the end and restores them after cooldown', () => {
    const { health, plan, advance } = setup({ strategy: 'priority' });
    for (let i = 0; i < 3; i++) health.recordFailure('a/m', 'boom');
    expect(plan()).toBe('bca');
    advance(30_000);
    expect(plan()).toBe('abc');
  });

  it('limits attempts when fallback is disabled or maxAttempts is set', () => {
    expect(setup({ fallback: false }).plan()).toBe('a');
    expect(setup({ maxAttempts: 2 }).plan()).toBe('ab');
  });
});

describe('HealthTracker', () => {
  it('starts cooldown only at the threshold and resets on success', () => {
    let now = 0;
    const health = new HealthTracker({ failureThreshold: 2, cooldownMs: 100 }, () => now);
    expect(health.recordFailure('x', 'e').cooldownStarted).toBe(false);
    expect(health.recordFailure('x', 'e').cooldownStarted).toBe(true);
    expect(health.isAvailable('x')).toBe(false);
    now = 100;
    expect(health.isAvailable('x')).toBe(true);
    health.recordSuccess('x', 10);
    expect(health.snapshot(['x'])[0]).toMatchObject({
      consecutiveFailures: 0,
      latencyMs: 10,
      available: true,
    });
  });

  it('computes a moving latency average', () => {
    const health = new HealthTracker({ failureThreshold: 3, cooldownMs: 1 });
    health.recordSuccess('x', 100);
    health.recordSuccess('x', 200);
    expect(health.latency('x')).toBeCloseTo(130);
  });

  it('keys targets as provider/model', () => {
    expect(targetKey({ provider: 'p', model: 'org/model' })).toBe('p/org/model');
  });
});
