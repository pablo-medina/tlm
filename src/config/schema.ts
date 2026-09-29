import { z } from 'zod';

export const STRATEGIES = [
  'priority',
  'round-robin',
  'weighted',
  'random',
  'least-latency',
] as const;
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export const DEFAULT_PORT = 30000;

const proxyUrl = z.url({ protocol: /^https?$/ });

/*
 * `${VAR}` placeholders always resolve to strings, so non-string settings also accept their string
 * form (`port: ${TLM_PORT:-30000}`). An empty string means "not set": the default applies.
 */
const emptyAsUndefined = (value: unknown) => (value === '' ? undefined : value);

const toNumber = (value: unknown) => {
  if (typeof value !== 'string') return value;
  return value.trim() === '' ? undefined : Number(value.trim());
};

const toBoolean = (value: unknown) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return undefined;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return value;
};

/** Lists also accept a comma-separated string (`noProxy: ${NO_PROXY:-}`). */
const toList = (value: unknown) => {
  if (typeof value !== 'string') return value;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const num = <T extends z.ZodType>(schema: T) => z.preprocess(toNumber, schema);
const bool = <T extends z.ZodType>(schema: T) => z.preprocess(toBoolean, schema);
const list = <T extends z.ZodType>(schema: T) => z.preprocess(toList, schema);

const timeoutMs = z.number().int().positive();
/** `0` disables the limit. */
const requestTimeoutMs = z.number().int().nonnegative();

const serverSchema = z.strictObject({
  host: z.string().min(1).default('0.0.0.0'),
  port: num(z.number().int().min(1).max(65535).default(DEFAULT_PORT)),
  /** Maximum accepted request body size in bytes. */
  bodyLimit: num(
    z
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
  ),
  /**
   * Maximum time (ms) TLM spends on a client request, across all attempts and including streaming.
   * Routes can override it. `0` disables the limit.
   */
  requestTimeoutMs: num(requestTimeoutMs.default(600_000)),
});

const loggingSchema = z.strictObject({
  level: z.enum(LOG_LEVELS).default('info'),
  /** Human-readable output instead of JSON lines. */
  pretty: bool(z.boolean().default(false)),
  /** Log request and response bodies at debug level. */
  logBodies: bool(z.boolean().default(false)),
});

const proxySchema = z.strictObject({
  /** Outbound proxy used for every provider unless overridden. */
  url: z.preprocess(emptyAsUndefined, proxyUrl.optional()),
  /** Hostnames (or domain suffixes) that bypass the global proxy. */
  noProxy: list(z.array(z.string().min(1)).default([])),
});

const upstreamSchema = z.strictObject({
  /** Default per-attempt timeout (ms): response headers + full body, or first chunk when streaming. */
  timeoutMs: num(timeoutMs.default(120_000)),
  /** Upstream HTTP status codes that trigger a fallback to the next target. */
  retryOn: list(
    z.array(num(z.number().int().min(400).max(599))).default([408, 409, 429, 500, 502, 503, 504]),
  ),
});

const healthSchema = z.strictObject({
  /** Consecutive failures before a target is put in cooldown. */
  failureThreshold: num(z.number().int().positive().default(3)),
  /** How long (ms) a target stays in cooldown. */
  cooldownMs: num(z.number().int().nonnegative().default(30_000)),
});

const providerSchema = z.strictObject({
  baseUrl: z.url({ protocol: /^https?$/ }),
  apiKey: z.preprocess(emptyAsUndefined, z.string().optional()),
  headers: z.record(z.string(), z.string()).default({}),
  /** Per-attempt timeout (ms) for this provider; overrides `upstream.timeoutMs`. */
  timeoutMs: num(timeoutMs.optional()),
  /** Proxy URL for this provider, or `false` to bypass the global proxy. */
  proxy: z.preprocess(
    (value) => toBoolean(emptyAsUndefined(value)),
    z.union([proxyUrl, z.literal(false)]).optional(),
  ),
});

const targetSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  /** Relative weight, used by the `weighted` strategy. */
  weight: num(z.number().positive().default(1)),
});

const routeSchema = z.strictObject({
  strategy: z.enum(STRATEGIES).default('priority'),
  targets: z.array(targetSchema).min(1),
  /** Try the next target when one fails. */
  fallback: bool(z.boolean().default(true)),
  /** Maximum number of targets tried per request (defaults to all). */
  maxAttempts: num(z.number().int().positive().optional()),
  /** Per-attempt timeout (ms) for this route; overrides the provider and `upstream.timeoutMs`. */
  timeoutMs: num(timeoutMs.optional()),
  /** Total request time limit (ms) for this route; overrides `server.requestTimeoutMs`. */
  requestTimeoutMs: num(requestTimeoutMs.optional()),
});

export const configSchema = z
  .strictObject({
    server: serverSchema.prefault({}),
    logging: loggingSchema.prefault({}),
    proxy: proxySchema.prefault({}),
    upstream: upstreamSchema.prefault({}),
    health: healthSchema.prefault({}),
    providers: z.record(z.string().min(1), providerSchema),
    routes: z.record(z.string().min(1), routeSchema),
  })
  .superRefine((config, ctx) => {
    if (Object.keys(config.providers).length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['providers'],
        message: 'at least one provider is required',
      });
    }
    if (Object.keys(config.routes).length === 0) {
      ctx.addIssue({ code: 'custom', path: ['routes'], message: 'at least one route is required' });
    }
    for (const [routeName, route] of Object.entries(config.routes)) {
      route.targets.forEach((target, index) => {
        if (!(target.provider in config.providers)) {
          ctx.addIssue({
            code: 'custom',
            path: ['routes', routeName, 'targets', index, 'provider'],
            message: `unknown provider "${target.provider}"`,
          });
        }
      });
    }
  });

export type Config = z.infer<typeof configSchema>;
export type ProviderConfig = Config['providers'][string];
export type RouteConfig = Config['routes'][string];
export type TargetConfig = RouteConfig['targets'][number];
export type StrategyName = (typeof STRATEGIES)[number];
export type LoggingConfig = Config['logging'];
export type HealthConfig = Config['health'];
export type ProxyConfig = Config['proxy'];
