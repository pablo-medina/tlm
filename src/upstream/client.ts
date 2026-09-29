import { request, type Dispatcher } from 'undici';
import type { ProviderConfig } from '../config/schema.js';

export interface UpstreamRequest {
  provider: ProviderConfig;
  dispatcher: Dispatcher;
  /** Path relative to the provider base URL, e.g. `/chat/completions`. */
  path: string;
  body: unknown;
  timeoutMs: number;
  signal: AbortSignal;
}

export type UpstreamResponse = Dispatcher.ResponseData;

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Sends a JSON POST to an OpenAI-compatible provider. The caller must consume or dump the body. */
export function sendUpstream(req: UpstreamRequest): Promise<UpstreamResponse> {
  const headers: Record<string, string> = {
    ...req.provider.headers,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (req.provider.apiKey) headers.authorization = `Bearer ${req.provider.apiKey}`;

  return request(joinUrl(req.provider.baseUrl, req.path), {
    method: 'POST',
    headers,
    body: JSON.stringify(req.body),
    dispatcher: req.dispatcher,
    signal: req.signal,
    headersTimeout: req.timeoutMs,
    bodyTimeout: req.timeoutMs,
  });
}

/** Human-readable reason for a network-level failure. */
export function describeError(error: unknown): { reason: string; timeout: boolean } {
  const err = error as {
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  const code = err?.code ?? err?.cause?.code;
  const timeout =
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT';
  const message = err?.cause?.message ?? err?.message ?? String(error);
  return { reason: code ? `${code}: ${message}` : message, timeout };
}
