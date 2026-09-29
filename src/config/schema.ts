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
/** Empty strings (e.g. an unset `${HTTPS_PROXY:-}`) mean "no proxy". */
const emptyAsUndefined = (value: unknown) => (value === '' ? undefined : value);

const serverSchema = z.strictObject({
  host: z.string().min(1).default('0.0.0.0'),
  port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
  /** Maximum accepted request body size in bytes. */
  bodyLimit: z
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
});

const loggingSchema = z.strictObject({
  level: z.enum(LOG_LEVELS).default('info'),
  /** Human-readable output instead of JSON lines. */
  pretty: z.boolean().default(false),
  /** Log request and response bodies at debug level. */
  logBodies: z.boolean().default(false),
});

const proxySchema = z.strictObject({
  /** Outbound proxy used for every provider unless overridden. */
  url: z.preprocess(emptyAsUndefined, proxyUrl.optional()),
  /** Hostnames (or domain suffixes) that bypass the global proxy. */
  noProxy: z.array(z.string().min(1)).default([]),
});

const upstreamSchema = z.strictObject({
  /** Default timeout (ms) for response headers and between streamed chunks. */
  timeoutMs: z.number().int().positive().default(120_000),
  /** Upstream HTTP status codes that trigger a fallback to the next target. */
  retryOn: z.array(z.number().int().min(400).max(599)).default([408, 409, 429, 500, 502, 503, 504]),
});

const healthSchema = z.strictObject({
  /** Consecutive failures before a target is put in cooldown. */
  failureThreshold: z.number().int().positive().default(3),
  /** How long (ms) a target stays in cooldown. */
  cooldownMs: z.number().int().nonnegative().default(30_000),
});

const providerSchema = z.strictObject({
  baseUrl: z.url({ protocol: /^https?$/ }),
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().positive().optional(),
  /** Proxy URL for this provider, or `false` to bypass the global proxy. */
  proxy: z.preprocess(emptyAsUndefined, z.union([proxyUrl, z.literal(false)]).optional()),
});

const targetSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  /** Relative weight, used by the `weighted` strategy. */
  weight: z.number().positive().default(1),
});

const routeSchema = z.strictObject({
  strategy: z.enum(STRATEGIES).default('priority'),
  targets: z.array(targetSchema).min(1),
  /** Try the next target when one fails. */
  fallback: z.boolean().default(true),
  /** Maximum number of targets tried per request (defaults to all). */
  maxAttempts: z.number().int().positive().optional(),
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
