import { Agent, ProxyAgent, type Dispatcher } from 'undici';
import type { Config, ProviderConfig, ProxyConfig } from '../config/schema.js';

/** Returns true when `hostname` matches an entry of a NO_PROXY-style list. */
export function matchesNoProxy(hostname: string, noProxy: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return noProxy.some((raw) => {
    const entry = raw
      .trim()
      .toLowerCase()
      .replace(/^\*?\./, '');
    if (entry === '*') return true;
    return host === entry || host.endsWith(`.${entry}`);
  });
}

/** Resolves the proxy URL a provider should use, or undefined for a direct connection. */
export function resolveProxy(provider: ProviderConfig, global: ProxyConfig): string | undefined {
  if (provider.proxy === false) return undefined;
  if (typeof provider.proxy === 'string') return provider.proxy;
  if (!global.url) return undefined;
  const { hostname } = new URL(provider.baseUrl);
  return matchesNoProxy(hostname, global.noProxy) ? undefined : global.url;
}

/** Redacts credentials from a proxy URL so it can be logged. */
export function redactUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.username || parsed.password) {
    parsed.username = '***';
    parsed.password = '';
  }
  return parsed.toString();
}

/**
 * Owns the undici connection pools for one configuration generation.
 * Providers sharing a proxy share its pool; direct providers share a single agent.
 */
export class Dispatchers {
  private readonly direct = new Agent();
  private readonly proxies = new Map<string, ProxyAgent>();
  private readonly byProvider = new Map<string, { dispatcher: Dispatcher; proxy?: string }>();

  constructor(config: Config) {
    for (const [name, provider] of Object.entries(config.providers)) {
      const proxy = resolveProxy(provider, config.proxy);
      if (!proxy) {
        this.byProvider.set(name, { dispatcher: this.direct });
        continue;
      }
      let agent = this.proxies.get(proxy);
      if (!agent) {
        agent = new ProxyAgent({ uri: proxy });
        this.proxies.set(proxy, agent);
      }
      this.byProvider.set(name, { dispatcher: agent, proxy: redactUrl(proxy) });
    }
  }

  get(provider: string): { dispatcher: Dispatcher; proxy?: string } {
    const entry = this.byProvider.get(provider);
    if (!entry) throw new Error(`no dispatcher for provider "${provider}"`);
    return entry;
  }

  /** Gracefully closes all pools; in-flight requests are allowed to finish. */
  async close(): Promise<void> {
    await Promise.allSettled([
      this.direct.close(),
      ...[...this.proxies.values()].map((a) => a.close()),
    ]);
  }
}
