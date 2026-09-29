# Architecture

TLM is intentionally small. Every request goes through the same path:

```
client ──► Fastify route ──► proxyRequest ──► Router.plan ──► attempt loop ──► undici ──► provider
                                  │                │                │
                                  │                │                └─ HealthTracker (success/failure, latency)
                                  │                └─ strategy (priority, round-robin, …) + cooldown ordering
                                  └─ Runtime.current (immutable config generation)
```

## Source layout

```
src/
  index.ts              Entry point: CLI args, .env, startup, signals, graceful shutdown
  server.ts             Fastify app: routes, request ids, error/404 handlers
  runtime.ts            Active config generation + state that survives reloads
  logger.ts             pino logger factory
  config/
    schema.ts           zod schema, defaults and derived types (single source of truth)
    load.ts             YAML parsing, ${ENV} interpolation, validation errors
    watcher.ts          File watcher for hot reload
  routing/
    strategies.ts       Strategy functions: route targets → attempt order
    router.ts           Applies strategy, cooldown ordering, fallback/maxAttempts limits
    health.ts           Per-target failure counters, cooldowns, latency moving average
  upstream/
    client.ts           Sends the JSON request to a provider (undici)
    dispatchers.ts      Connection pools per config generation, proxy resolution
  http/
    proxy.ts            The attempt/fallback loop for /v1/chat/completions, /completions, /embeddings
    sse.ts              Token usage extraction for logs (JSON and SSE)
    errors.ts           OpenAI-style error bodies
test/                   vitest suites with mock upstreams and a mock forward proxy
```

## Key design decisions

**Config generations.** `Runtime.current` returns an immutable `Generation` (config + connection
pools). A request captures it once at the start, so a hot reload never changes a request halfway.
Health state and round-robin counters live on the `Runtime` itself, so they survive reloads.

**Strategies are pure ordering functions.** A strategy only returns every target in the order they
should be attempted. It never filters. The router applies the cross-cutting rules (cooldown
ordering, `fallback`, `maxAttempts`), so new strategies stay trivial.

**Health is per target (`provider/model`).** One model being rate-limited or unavailable should not
penalize other models from the same provider.

**Streaming commits on the first chunk.** For `stream: true`, TLM waits for the first upstream chunk
before sending headers to the client. Until then, a failure can still fall back. After that, errors
close the connection.

**Bodies pass through.** TLM parses the request only to read `model` and `stream` and to replace
`model` with the upstream name. Everything else (tools, response_format, provider-specific fields) is
forwarded unchanged. Upstream responses are forwarded unchanged as well.

**Timeouts use an AbortSignal per attempt.** undici's own timers are coarse (about one second), so
each attempt has a precise deadline combined with the client-disconnect signal. undici's
`bodyTimeout` remains the idle timeout for streams.

**No client auth.** TLM is designed for private networks. Put it behind a gateway if it must be
exposed.
