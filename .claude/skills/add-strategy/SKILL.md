---
name: add-strategy
description: Add a new routing strategy to TLM (e.g. least-connections, cost-based). Use when the user asks for a new way to order or pick targets within a route.
---

# Add a routing strategy

Strategies are pure functions that return **every** target of a route in attempt order. They never
filter targets. Cooldown ordering, `fallback` and `maxAttempts` are applied afterwards by
`Router.plan` in `src/routing/router.ts`. Do not duplicate that logic in the strategy.

## Steps

1. **Name it.** Add the kebab-case name to `STRATEGIES` in `src/config/schema.ts`.
2. **Implement it** in `src/routing/strategies.ts`:
   - Signature: `const myStrategy: Strategy = (ctx) => TargetConfig[]`.
   - Available context: `routeName`, `targets`, `health` (latency, availability), `counters`
     (per-route state that persists across requests and reloads), `random` (injectable for tests).
   - Return a new array. Never mutate `ctx.targets`.
   - Add a doc comment that explains the ordering in one or two lines.
   - Register it in the `strategies` record. TypeScript will fail until you do.
3. **Per-target settings.** If the strategy needs one (like `weight`), add it to `targetSchema` with a
   sensible default. If it needs extra runtime data (for example in-flight counts), record it in
   `HealthTracker` or pass it through `StrategyContext`, and update it from `src/http/proxy.ts`.
4. **Test it** in `test/routing.test.ts`, using the `setup()` helper. Cover the ordering, and make sure
   the result is a permutation of all targets.
5. **Document it:**
   - Add a row to the strategies table in `README.md`.
   - Add it to the `strategy` row in `docs/configuration.md`.
   - Add an example route to `config.example.yaml`.
6. Run `npm run check`.

All code, comments and docs must be in English.
