# TLM — Tiny LLM Router

TLM is a small Node.js + TypeScript microservice that exposes an **OpenAI-compatible API** and routes
each request to one of several **OpenAI-compatible providers** (OpenAI, Groq, OpenRouter, vLLM,
Ollama, LM Studio, …) using configurable strategies, with automatic **fallbacks** for availability.

It does one thing: routing. See [What TLM does not do](#what-tlm-does-not-do).

## Features

- **OpenAI-compatible endpoints:** `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/models`.
- **Routes as virtual models:** clients ask for `"model": "smart"` and TLM decides which provider/model serves it.
- **Strategies:** `priority` (failover queue), `round-robin`, `weighted`, `random`, `least-latency`.
- **Fallbacks:** on network errors, timeouts and retryable statuses (`429`, `5xx`, …), including
  streaming requests that fail before the first byte.
- **Health tracking:** failing targets enter a cooldown and are deprioritized automatically.
- **Outbound proxy:** optional global HTTP(S) proxy with `noProxy` rules and per-provider overrides.
- **Configurable timeouts:** a total request timeout and a per-attempt timeout, each global with
  per-route overrides.
- **Environment-friendly config:** YAML with `${VAR}` references, including for numbers and booleans,
  plus `.env` support.
- **Hot reload:** the YAML configuration and `.env` are watched; valid changes apply without a restart.
- **Multimodal passthrough:** images, PDFs and audio content parts are forwarded untouched.
- **Observable:** structured logs (JSON or pretty) for every request, attempt, fallback and reload,
  with API keys scrubbed and base64 payloads summarized.

## What TLM does not do

TLM sits between your applications and the providers. It does not know who the end users are, so it
leaves per-user rules to the service that calls it:

- **No client authentication.** TLM is meant for private networks. Put a gateway in front of it if it
  must be exposed.
- **No rate limits, quotas or budgets.** A limit inside TLM would be shared by every user of a route,
  so one heavy user would block everyone else. Per-user or per-application limits belong in the
  consuming service, which knows its users. Provider rate limits (`429`) are still handled with
  fallbacks and cooldowns.
- **No prompt management, caching, UI or persistence.**

What TLM gives the consuming service to enforce its own rules:

- **`usage`** (prompt and completion tokens) is returned unchanged, so the consuming service can
  meter consumption per user. For streams, request it with `stream_options.include_usage`.
- **`x-request-id`** is reused if the caller sends it and echoed back, so a user's request can be
  correlated with TLM's logs. `x-tlm-provider` and `x-tlm-model` show which target served it.
- **The `user` field** of the request body is forwarded to the provider unchanged.

## Quick start

Requirements: Node.js 22.19 or later.

```bash
npm install
cp config.example.yaml config.yaml   # config.yaml is git-ignored
cp .env.example .env                 # optional: API keys referenced from config.yaml
npm run dev
```

TLM listens on port **30000** by default.

```bash
curl http://localhost:30000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model": "smart", "messages": [{"role": "user", "content": "Hello!"}]}'
```

Any OpenAI SDK works by pointing its base URL at TLM:

```ts
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://localhost:30000/v1', apiKey: 'unused' });
const completion = await client.chat.completions.create({
  model: 'smart',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

TLM does not authenticate clients. It is meant to run inside a private network. Provider API keys
stay in TLM's configuration and are never exposed to clients.

## Configuration

A minimal `config.yaml`:

```yaml
providers:
  openai:
    baseUrl: https://api.openai.com/v1
    apiKey: ${OPENAI_API_KEY}
  groq:
    baseUrl: https://api.groq.com/openai/v1
    apiKey: ${GROQ_API_KEY}

routes:
  smart:
    strategy: priority
    targets:
      - { provider: openai, model: gpt-4o }
      - { provider: groq, model: llama-3.3-70b-versatile }
```

- **Providers** are OpenAI-compatible endpoints (`baseUrl`, `apiKey`, extra `headers`, `timeoutMs`, `proxy`).
- **Routes** are the model names TLM exposes. Each has a `strategy` and an ordered list of `targets`
  (`provider` + upstream `model`).
  The configuration file is resolved from `--config <path>`, then `TLM_CONFIG`, then `./config.yaml`.

### Environment variables and `.env`

The YAML file is always the source of configuration, but any value in it can reference an
environment variable. Use this for secrets, or for settings you prefer to manage per deployment:

```yaml
server:
  port: ${TLM_PORT:-30000} # TLM_PORT, or 30000 if unset
  requestTimeoutMs: ${TLM_REQUEST_TIMEOUT_MS:-600000}
logging:
  level: ${TLM_LOG_LEVEL:-info}
providers:
  openai:
    baseUrl: https://api.openai.com/v1
    apiKey: ${OPENAI_API_KEY} # required: startup fails if unset
```

- `${VAR}` requires the variable. `${VAR:-default}` provides a fallback. `$${VAR}` is a literal `${VAR}`.
- Numbers, booleans and lists also accept their text form. For example, `TLM_PORT=8080` works, and
  `NO_PROXY=localhost,.internal` can feed `proxy.noProxy`.
- Variables come from the process environment and from a `.env` file next to the config file (or
  `--env-file <path>` / `TLM_ENV_FILE`). Real environment variables win over `.env`. See
  [.env.example](.env.example).
- Both files are watched, so editing `.env` triggers a hot reload too.

See [docs/configuration.md](docs/configuration.md) for every option, and
[config.example.yaml](config.example.yaml) for an annotated example.

## Routing strategies

| Strategy        | Order of attempts                                                                 |
| --------------- | --------------------------------------------------------------------------------- |
| `priority`      | Configuration order. The first target is primary, the rest are fallbacks.         |
| `round-robin`   | Rotates the starting target on each request, then continues in order.             |
| `weighted`      | Random order weighted by each target's `weight`.                                  |
| `random`        | Uniformly random order.                                                           |
| `least-latency` | Lowest recent latency first (moving average); unmeasured targets are tried first. |

After ordering, targets that are **cooling down** move to the end of the list. They are still tried
as a last resort. With `fallback: false` only the first target is tried; `maxAttempts` caps the number
of targets tried per request.

## Fallback rules

| Upstream outcome                                                     | What TLM does                                  |
| -------------------------------------------------------------------- | ---------------------------------------------- |
| Network error, connection refused, timeout                           | Record failure, try the next target            |
| Status in `upstream.retryOn` (default `408 409 429 500 502 503 504`) | Record failure, try the next target            |
| Other `4xx` (e.g. `400`, `401`, `404`)                               | Return it to the client as-is (no fallback)    |
| Stream fails **before** the first chunk                              | Try the next target                            |
| Stream fails **after** the first chunk                               | Connection is closed; no fallback is possible  |
| Every target failed                                                  | Return the last upstream error, or `502`/`504` |

## Timeouts

| Limit                                                                      | Global                                         | Override                                                     |
| -------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| **Request:** client ↔ TLM, whole request including fallbacks and streaming | `server.requestTimeoutMs` (10 min; `0` = none) | `routes.<name>.requestTimeoutMs`                             |
| **Attempt:** TLM ↔ one target                                              | `upstream.timeoutMs` (2 min)                   | `providers.<name>.timeoutMs`, then `routes.<name>.timeoutMs` |

The most specific value wins. A route without its own value uses the global one. When the request
timeout is exceeded, the client gets `504 request_timeout`, or the stream is closed if it has
already started. When an attempt times out, TLM falls back to the next target. See
[docs/configuration.md](docs/configuration.md#timeouts) for details.

## Responses

TLM passes upstream bodies through unchanged and adds these headers:

| Header           | Meaning                                                  |
| ---------------- | -------------------------------------------------------- |
| `x-request-id`   | Request id (taken from the incoming header or generated) |
| `x-tlm-route`    | Route that handled the request                           |
| `x-tlm-provider` | Provider that produced the response                      |
| `x-tlm-model`    | Upstream model name                                      |
| `x-tlm-attempts` | Number of targets tried                                  |

Upstream `x-ratelimit-*` headers are forwarded as well.

Other endpoints:

- `GET /v1/models` lists the configured routes as models. `GET /v1/models/{id}` returns a single one.
- `GET /health` reports the service status, the configuration generation, and per-target health
  (failures, cooldown, average latency).

Unknown models return `404` with an OpenAI-style `model_not_found` error.

## Logging

Set the level with `logging.level`: `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`.
Level changes are applied on hot reload.

- `info` logs each routed request, failed attempts, fallbacks, completions (with status, duration
  and token usage) and configuration reloads.
- `debug` also logs each attempt start (upstream model, timeout, proxy), stream start and time to
  first byte, and every HTTP response.
- `logging.logBodies: true` logs request and response bodies at `debug` level. Base64 payloads
  (images, PDFs, audio, `b64_json`) are logged as their size, for example
  `data:image/png;base64,…[1.2 MB]`, and embedding vectors as `[1536 numbers]`. Prompts and
  completions are still logged in full, so treat these logs as sensitive.
- `logging.pretty: true` prints human-readable single-line logs. Otherwise TLM writes JSON lines.

```
12:00:01.234 INFO: routing request {"route":"smart","strategy":"priority","stream":false,"plan":["openai/gpt-4o","groq/llama-3.3-70b-versatile"]}
12:00:01.560 WARN: attempt failed {"attempt":1,"target":"openai/gpt-4o","reason":"HTTP 429","next":"fallback"}
12:00:02.101 INFO: request completed {"status":200,"target":"groq/llama-3.3-70b-versatile","attempts":2,"durationMs":867,"usage":{...}}
```

**Credentials never reach the logs.** Before a log line is written, TLM replaces these values with
`[redacted]`:

- every provider `apiKey`;
- the values of sensitive provider headers (names containing `auth`, `key`, `token`, `secret`,
  `cookie`, `session` or `signature`);
- proxy passwords;
- any `Bearer <token>`.

This applies to every line, including upstream error bodies that echo a key. Upstream error bodies
returned to clients are scrubbed the same way. Successful responses pass through untouched. The list of secrets is
refreshed on every configuration reload. Values shorter than 8 characters are not matched, because
they would mangle unrelated text. Configuration errors do not print the YAML source.

## Images, documents and other multimodal input

TLM forwards request bodies unchanged apart from `model`, so multimodal content parts work with any
provider that supports them:

- **Images:** `image_url` parts, with an `https://` URL or a base64 `data:` URI.
- **PDFs and other documents:** `file` parts with base64 `file_data`.
- **Audio:** `input_audio` parts.

TLM does not check model capabilities. Every target in a vision or document route must accept that
input. If one does not, that is a configuration error: the provider's `400` is returned to the client
without a fallback. See the `vision` and `documents` routes in
[config.example.yaml](config.example.yaml).

Two things to keep in mind:

- **`server.bodyLimit` defaults to 10 MB.** Base64 payloads are about 33% larger than the original
  file. Raise the limit for image and document routes; the example config uses 50 MB. Requests over
  the limit get a `413`.
- **Uploaded files (`file_id`) are not supported.** A `file_id` only exists on the provider it was
  uploaded to, so it cannot be routed or used in a fallback. Send content inline instead.

## Outbound proxy

```yaml
proxy:
  url: http://user:pass@proxy.internal:3128
  noProxy: [localhost, 127.0.0.1, .internal]

providers:
  local:
    baseUrl: http://gpu-box:8000/v1
    proxy: false # always direct
  special:
    baseUrl: https://api.example.com/v1
    proxy: http://other-proxy:8080 # provider-specific proxy
```

HTTPS targets are tunnelled with `CONNECT`. Plain HTTP targets are forwarded through the proxy.

## Hot reload

TLM watches the configuration file and the `.env` file. When either changes:

- If the new file is valid, it replaces the active configuration. In-flight requests finish with the
  configuration they started with, and health state and round-robin counters are kept.
- If the new file is invalid, TLM logs the error and keeps the current configuration.

`server.host`, `server.port`, `server.bodyLimit` and `logging.pretty` only apply after a restart.
Sending `SIGHUP` forces a reload.

## Docker

```bash
docker build -t tlm .
docker run -p 30000:30000 -v "$PWD/deploy:/config:ro" -e OPENAI_API_KEY tlm
```

The image reads `/config/config.yaml`, and `/config/.env` if it exists. Mount the directory rather
than individual files, so hot reload also works with editors that replace files. Variables passed
with `-e` or `env_file:` (Compose) override the mounted `.env`.

## Development

```bash
npm run dev          # run with auto-restart on source changes
npm test             # run the test suite
npm run typecheck    # type-check sources and tests
npm run format       # format with Prettier
npm run check        # typecheck + format check + tests (what CI runs)
npm run build        # compile to dist/
npm start            # run the compiled build
```

See [docs/architecture.md](docs/architecture.md) for how the code is organized.

## License

[MIT](LICENSE) © Pablo Medina
