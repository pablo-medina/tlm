import type { Config } from './config/schema.js';

const REDACTED = '[redacted]';

/** Secrets shorter than this are not scrubbed by value (too likely to mangle unrelated text). */
const MIN_SECRET_LENGTH = 8;

/** Provider header names whose values are treated as secrets. */
const SENSITIVE_HEADER = /auth|key|token|secret|cookie|session|signature/i;

/** Any `Bearer <token>` that reaches a log line, whatever its origin. */
const BEARER = /(bearer\s+)[\w.~+/=-]{8,}/gi;

/**
 * Removes credentials from serialized log lines.
 *
 * It scrubs, by value, every provider API key, sensitive provider header and proxy password in the
 * active configuration, plus any `Bearer` token. It runs on the final log line, so it also covers
 * upstream error bodies, error messages and stack traces that echo a key.
 */
export class SecretScrubber {
  private secrets: string[] = [];

  constructor(config?: Config) {
    if (config) this.update(config);
  }

  /** Replaces the known secrets with the ones in `config` (called on startup and on every reload). */
  update(config: Config): void {
    const found = new Set<string>();
    const addUrlPassword = (url: string | undefined) => {
      if (!url) return;
      const { password } = new URL(url);
      if (password) {
        found.add(password);
        found.add(decodeURIComponent(password));
      }
    };

    for (const provider of Object.values(config.providers)) {
      if (provider.apiKey) found.add(provider.apiKey);
      for (const [name, value] of Object.entries(provider.headers)) {
        if (!SENSITIVE_HEADER.test(name)) continue;
        found.add(value);
        found.add(value.replace(/^\s*(bearer|basic|token)\s+/i, ''));
      }
      if (typeof provider.proxy === 'string') addUrlPassword(provider.proxy);
    }
    addUrlPassword(config.proxy.url);

    // Longest first, so a secret that contains another one is replaced as a whole.
    this.secrets = [...found]
      .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
      .sort((a, b) => b.length - a.length);
  }

  scrub(line: string): string {
    let result = line;
    for (const secret of this.secrets) {
      if (result.includes(secret)) result = result.split(secret).join(REDACTED);
    }
    return result.replace(BEARER, `$1${REDACTED}`);
  }
}

/** Strings longer than this are candidates for summarizing. */
const MAX_INLINE_STRING = 256;
/** Numeric arrays longer than this (e.g. embeddings) are summarized. */
const MAX_INLINE_NUMBERS = 16;
/** Non-JSON bodies longer than this are truncated. */
const MAX_RAW_TEXT = 4096;

const DATA_URI_PREFIX = /^data:[^,]*;base64,/i;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const decodedSize = (base64Length: number) => formatBytes(Math.floor((base64Length * 3) / 4));

function summarizeString(value: string): string {
  if (value.length <= MAX_INLINE_STRING) return value;
  const prefix = DATA_URI_PREFIX.exec(value)?.[0];
  if (prefix) return `${prefix}…[${decodedSize(value.length - prefix.length)}]`;
  if (BASE64.test(value)) return `[base64 ${decodedSize(value.length)}]`;
  return value;
}

/**
 * Returns a copy of a JSON value that is safe and compact to log: base64 payloads (images,
 * PDFs, audio, `b64_json`) are replaced by their size, and long numeric arrays (embeddings) by
 * their length. Everything else is kept, so logged bodies stay readable.
 */
export function summarizeForLog(value: unknown): unknown {
  if (typeof value === 'string') return summarizeString(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_INLINE_NUMBERS && value.every((item) => typeof item === 'number')) {
      return `[${value.length} numbers]`;
    }
    return value.map(summarizeForLog);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, summarizeForLog(child)]),
    );
  }
  return value;
}

/** Like `summarizeForLog`, for a raw response body: parsed if it is JSON, truncated otherwise. */
export function summarizeTextForLog(text: string): unknown {
  try {
    return summarizeForLog(JSON.parse(text));
  } catch {
    const summarized = summarizeString(text);
    return summarized.length > MAX_RAW_TEXT
      ? `${summarized.slice(0, MAX_RAW_TEXT)}…[${formatBytes(summarized.length)} total]`
      : summarized;
  }
}
