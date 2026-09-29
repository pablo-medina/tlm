# Configuration reference

TLM reads a single YAML file. It is resolved from `--config <path>` (or `-c`), then the `TLM_CONFIG`
environment variable, then `./config.yaml`.

Unknown keys are rejected, so typos surface as errors instead of being silently ignored.

## Environment variables

Any string value can reference environment variables:

| Syntax             | Result                                                        |
| ------------------ | ------------------------------------------------------------- |
| `${VAR}`           | Value of `VAR`. Startup/reload fails if it is unset or empty. |
| `${VAR:-fallback}` | Value of `VAR`, or `fallback` if it is unset or empty.        |
| `${VAR:-}`         | Value of `VAR`, or an empty string.                           |

If a `.env` file exists in the working directory, it is loaded at startup. Variables that are
already set are not overridden.

## `server`

| Key         | Type   | Default    | Notes                                        |
| ----------- | ------ | ---------- | -------------------------------------------- |
| `host`      | string | `0.0.0.0`  | Restart required to change.                  |
| `port`      | int    | `30000`    | Restart required to change.                  |
| `bodyLimit` | int    | `10485760` | Max request body in bytes. Restart required. |

## `logging`

| Key         | Type    | Default | Notes                                                                         |
| ----------- | ------- | ------- | ----------------------------------------------------------------------------- |
| `level`     | enum    | `info`  | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`. Hot-reloadable. |
| `pretty`    | boolean | `false` | Human-readable single-line output. Restart required.                          |
| `logBodies` | boolean | `false` | Log request/response bodies at `debug` level. Hot-reloadable.                 |

## `proxy`

Optional outbound proxy for upstream calls.

| Key       | Type     | Default | Notes                                                                                                                                                                                  |
| --------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`     | URL      | —       | `http://` or `https://`, credentials allowed (`http://user:pass@host:port`). Empty string disables it.                                                                                 |
| `noProxy` | string[] | `[]`    | Hosts that bypass the proxy. Matches exact hosts and subdomains (`example.com`, `.example.com` and `*.example.com` all match `api.example.com`). `*` disables the proxy for all hosts. |

Each provider can override this with its own `proxy` setting (see below).

## `upstream`

| Key         | Type  | Default                               | Notes                                                            |
| ----------- | ----- | ------------------------------------- | ---------------------------------------------------------------- |
| `timeoutMs` | int   | `120000`                              | Default per-attempt timeout (see [Timeouts](#timeouts)).         |
| `retryOn`   | int[] | `[408, 409, 429, 500, 502, 503, 504]` | Upstream statuses that count as failures and trigger a fallback. |

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

| Key         | Type               | Default | Notes                                                                                                   |
| ----------- | ------------------ | ------- | ------------------------------------------------------------------------------------------------------- |
| `baseUrl`   | URL                | —       | Required. Must include the API prefix, e.g. `https://api.openai.com/v1`.                                |
| `apiKey`    | string             | —       | Sent as `Authorization: Bearer <apiKey>`. Omit for keyless servers.                                     |
| `headers`   | map<string,string> | `{}`    | Extra headers sent on every request (e.g. `HTTP-Referer` for OpenRouter).                               |
| `timeoutMs` | int                | —       | Overrides `upstream.timeoutMs` for this provider.                                                       |
| `proxy`     | URL or `false`     | —       | Provider-specific proxy, or `false` to always connect directly. If omitted, the global `proxy` applies. |

TLM calls `{baseUrl}/chat/completions`, `{baseUrl}/completions` and `{baseUrl}/embeddings`.

## `routes`

A map of route name → settings. The route name is the `model` clients send. It can contain any
characters, including `/`. At least one route is required.

| Key           | Type     | Default    | Notes                                                             |
| ------------- | -------- | ---------- | ----------------------------------------------------------------- |
| `strategy`    | enum     | `priority` | `priority`, `round-robin`, `weighted`, `random`, `least-latency`. |
| `targets`     | target[] | —          | Required, at least one.                                           |
| `fallback`    | boolean  | `true`     | When `false`, only the first target (after ordering) is tried.    |
| `maxAttempts` | int      | all        | Maximum targets tried per request.                                |

Target:

| Key        | Type   | Default | Notes                                                           |
| ---------- | ------ | ------- | --------------------------------------------------------------- |
| `provider` | string | —       | Must be a key of `providers`.                                   |
| `model`    | string | —       | Model name sent upstream (replaces the route name in the body). |
| `weight`   | number | `1`     | Relative weight for the `weighted` strategy.                    |

## Timeouts

For each attempt, the timeout (`provider.timeoutMs`, or `upstream.timeoutMs` if unset) covers:

- **Non-streaming:** everything from sending the request to receiving the full response body.
- **Streaming:** everything from sending the request to receiving the first chunk. After that, the
  same value is used as the idle timeout between chunks.

A timed-out attempt counts as a failure and falls back to the next target. If the last attempt
times out, the client receives `504` with the error code `upstream_timeout`.

## Hot reload

The file is watched. The containing directory is watched, not the file itself, so atomic saves from
editors also work. After a change:

1. The file is re-read. If its content did not change, nothing happens.
2. It is parsed and validated. If it is invalid, TLM logs an error and keeps the current configuration.
3. It becomes the active configuration. New connection pools are created and the old ones close
   once their in-flight requests finish.

Settings marked "restart required" are reported with a warning and ignored until the next restart.
`SIGHUP` forces a reload (on platforms that support it).
