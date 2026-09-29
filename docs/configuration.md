# Configuration reference

TLM reads a single YAML file. The path comes from `--config <path>` (or `-c`), then the
`TLM_CONFIG` environment variable, then `./config.yaml`.

Unknown keys are rejected, so typos surface as errors instead of being silently ignored.

## Environment variables

The YAML file is always the source of configuration. Any value in it can **reference** an
environment variable instead of containing a literal. This is useful for secrets (API keys) and for
settings that change per deployment (port, log level, proxy):

```yaml
server:
  port: ${TLM_PORT:-30000}
logging:
  level: ${TLM_LOG_LEVEL:-info}
providers:
  openai:
    baseUrl: https://api.openai.com/v1
    apiKey: ${OPENAI_API_KEY}
```

| Syntax            | Result                                                                 |
| ----------------- | ---------------------------------------------------------------------- |
| `${VAR}`          | Value of `VAR`. Startup or reload fails if it is unset or empty.       |
| `${VAR:-default}` | Value of `VAR`, or `default` if it is unset or empty.                  |
| `${VAR:-}`        | Value of `VAR`, or empty, which means "not set" (the default applies). |
| `$${VAR}`         | A literal `${VAR}` (escape).                                           |

Placeholders can appear anywhere inside a string (`"https://${LLM_HOST}/v1"`), but only in
**values**, not in keys.

**Types.** Placeholders always resolve to text. Numbers, booleans and lists also accept their text
form, so they can come from environment variables:

- **Numbers:** `"8080"`.
- **Booleans:** `"true"` or `"false"`, case-insensitive.
- **Lists** (`proxy.noProxy`, `upstream.retryOn`): a comma-separated string, as in
  `NO_PROXY=localhost,.internal`.

An empty value makes TLM use the setting's default. An invalid value (`port: "eighty"`) is a
validation error that names the setting.

### `.env` file

Variables are resolved from two sources, in this order of precedence:

1. The **process environment**. Real environment variables always win.
2. A **`.env` file**, in standard `KEY=value` format with `#` comments and quoted values.

TLM looks for the `.env` file in the **same directory as the config file**, and it is optional there.
You can point to a different one with `--env-file <path>` (or `-e`) or with `TLM_ENV_FILE`; in that
case the file must exist. TLM never writes the file's values into `process.env`. They are only used
to resolve `${VAR}` references, and the `.env` file is watched together with the config file (see
[Hot reload](#hot-reload)).

`TLM_CONFIG` and `TLM_ENV_FILE` locate the files, so they can only come from the real environment,
not from `.env`.

See [`.env.example`](../.env.example) for the variables used by the example configuration.

## `server`

| Key                | Type   | Default    | Notes                                                                                                                                                             |
| ------------------ | ------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`             | string | `0.0.0.0`  | Restart required to change.                                                                                                                                       |
| `port`             | int    | `30000`    | Restart required to change.                                                                                                                                       |
| `bodyLimit`        | int    | `10485760` | Max request body in bytes. Base64 images and PDFs are about 33% larger than the file, so raise it for vision/document routes (e.g. `52428800`). Restart required. |
| `requestTimeoutMs` | int    | `600000`   | Total time TLM spends on a client request, across all attempts and including streaming. `0` = no limit. Routes can override it (see [Timeouts](#timeouts)).       |

## `logging`

| Key         | Type    | Default | Notes                                                                                                |
| ----------- | ------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `level`     | enum    | `info`  | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`.                                        |
| `pretty`    | boolean | `false` | Human-readable single-line output. Restart required.                                                 |
| `logBodies` | boolean | `false` | Log request/response bodies at `debug` level, with base64 payloads and embedding vectors summarized. |

API keys, sensitive provider headers, proxy passwords and `Bearer` tokens are always scrubbed from
log output, whatever the level (see the README's Logging section).

## `proxy`

Optional outbound proxy for upstream calls.

| Key       | Type     | Default | Notes                                                                                                                                                                                  |
| --------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`     | URL      | —       | `http://` or `https://`, credentials allowed (`http://user:pass@host:port`). Empty string disables it.                                                                                 |
| `noProxy` | string[] | `[]`    | Hosts that bypass the proxy. Matches exact hosts and subdomains (`example.com`, `.example.com` and `*.example.com` all match `api.example.com`). `*` disables the proxy for all hosts. |

Each provider can override this with its own `proxy` setting (see below).

## `upstream`

| Key         | Type  | Default                               | Notes                                                                                          |
| ----------- | ----- | ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `timeoutMs` | int   | `120000`                              | Default per-attempt timeout. Providers and routes can override it (see [Timeouts](#timeouts)). |
| `retryOn`   | int[] | `[408, 409, 429, 500, 502, 503, 504]` | Upstream statuses that count as failures and trigger a fallback.                               |

## `health`

| Key                | Type | Default | Notes                                                 |
| ------------------ | ---- | ------- | ----------------------------------------------------- |
| `failureThreshold` | int  | `3`     | Consecutive failures before a target enters cooldown. |
| `cooldownMs`       | int  | `30000` | Cooldown duration. `0` disables cooldowns.            |

Health is tracked per **target** (`provider/model`). A successful response resets the failure count.
Targets in cooldown are moved to the end of the attempt list, not removed. If every target is cooling
down, TLM still tries them in order. Health state survives configuration reloads.

## `providers`

A map of provider name → settings. At least one provider is required.

| Key         | Type               | Default | Notes                                                                                                      |
| ----------- | ------------------ | ------- | ---------------------------------------------------------------------------------------------------------- |
| `baseUrl`   | URL                | —       | Required. Must include the API prefix, e.g. `https://api.openai.com/v1`.                                   |
| `apiKey`    | string             | —       | Sent as `Authorization: Bearer <apiKey>`. Omit (or leave empty) for keyless servers.                       |
| `headers`   | map<string,string> | `{}`    | Extra headers sent on every request (e.g. `HTTP-Referer` for OpenRouter).                                  |
| `timeoutMs` | int                | —       | Per-attempt timeout for this provider. Overrides `upstream.timeoutMs`; a route's `timeoutMs` overrides it. |
| `proxy`     | URL or `false`     | —       | Provider-specific proxy, or `false` to always connect directly. If omitted, the global `proxy` applies.    |

TLM calls `{baseUrl}/chat/completions`, `{baseUrl}/completions` and `{baseUrl}/embeddings`.

## `routes`

A map of route name → settings. The route name is the `model` clients send. It can contain any
characters, including `/`. At least one route is required.

| Key                | Type     | Default    | Notes                                                                                              |
| ------------------ | -------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `strategy`         | enum     | `priority` | `priority`, `round-robin`, `weighted`, `random`, `least-latency`.                                  |
| `targets`          | target[] | —          | Required, at least one.                                                                            |
| `fallback`         | boolean  | `true`     | When `false`, only the first target (after ordering) is tried.                                     |
| `maxAttempts`      | int      | all        | Maximum targets tried per request.                                                                 |
| `timeoutMs`        | int      | —          | Per-attempt timeout for this route. Overrides the provider's `timeoutMs` and `upstream.timeoutMs`. |
| `requestTimeoutMs` | int      | —          | Total request time limit for this route. Overrides `server.requestTimeoutMs`; `0` = no limit.      |

Target:

| Key        | Type   | Default | Notes                                                           |
| ---------- | ------ | ------- | --------------------------------------------------------------- |
| `provider` | string | —       | Must be a key of `providers`.                                   |
| `model`    | string | —       | Model name sent upstream (replaces the route name in the body). |
| `weight`   | number | `1`     | Relative weight for the `weighted` strategy.                    |

## Timeouts

There are two independent limits. If a route does not define its own value, it uses the global one.

| Limit                          | Global                    | Per provider            | Per route                   |
| ------------------------------ | ------------------------- | ----------------------- | --------------------------- |
| **Request** (client ↔ TLM)     | `server.requestTimeoutMs` | —                       | `routes.*.requestTimeoutMs` |
| **Attempt** (TLM ↔ one target) | `upstream.timeoutMs`      | `providers.*.timeoutMs` | `routes.*.timeoutMs`        |

For each setting, the most specific value wins: route, then provider, then global.

### Request timeout

The request timeout is the maximum time TLM spends on a client request. It counts from when TLM
receives the request until the response is finished, including every fallback attempt and the whole
stream. When it is exceeded:

- **Before the response starts:** the current attempt is aborted, no more targets are tried, and the
  client receives `504` with the error code `request_timeout`.
- **While streaming:** the connection is closed, because the status has already been sent. The log
  shows `request timed out while streaming`.
- **Target health is not affected.** Running out of the request budget is not the target's fault.

`0` disables the limit. The default is 10 minutes. Long-running routes, such as reasoning models or
large documents, usually need a higher value on the route. Clients should use a timeout that is at
least as long as TLM's.

### Attempt timeout

The attempt timeout is the maximum time one target has to respond:

- **Non-streaming:** from sending the request until the full response body arrives.
- **Streaming:** from sending the request until the first chunk arrives. After that, the same value
  is the idle timeout between chunks.

A timed-out attempt counts as a failure for the target and falls back to the next one. If the last
attempt times out, the client receives `504` with the error code `upstream_timeout`. The request
timeout still applies on top of it.

```yaml
server:
  requestTimeoutMs: 600000 # 10 min per client request (global)
upstream:
  timeoutMs: 120000 # 2 min per attempt (global)
providers:
  groq:
    baseUrl: https://api.groq.com/openai/v1
    timeoutMs: 30000 # fast provider: fall back sooner
routes:
  documents:
    timeoutMs: 300000 # 5 min per attempt for this route
    requestTimeoutMs: 900000 # 15 min for the whole request
    targets:
      - { provider: openai, model: gpt-4.1 }
```

## Hot reload

TLM watches the config file and the `.env` file. It watches their directories rather than the files
themselves, so atomic saves from editors work and a `.env` created later is picked up. After a change:

1. Both files are re-read. If neither changed, nothing happens.
2. The configuration is parsed, `${VAR}` references are resolved, and the result is validated. If it
   is invalid, TLM logs an error and keeps the current configuration.
3. It becomes the active configuration. New connection pools are created and the old ones close
   once their in-flight requests finish.

Everything is applied on reload except the settings marked "restart required", which are reported
with a warning. Changes to the process environment cannot be detected; they require a restart.
`SIGHUP` forces a reload on platforms that support it.
