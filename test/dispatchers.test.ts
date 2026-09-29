import { describe, expect, it } from 'vitest';
import { matchesNoProxy, redactUrl, resolveProxy } from '../src/upstream/dispatchers.js';

const provider = (baseUrl: string, proxy?: string | false) => ({ baseUrl, headers: {}, proxy });

describe('proxy resolution', () => {
  const global = { url: 'http://proxy:3128', noProxy: ['localhost', '.internal', '127.0.0.1'] };

  it('uses the global proxy by default', () => {
    expect(resolveProxy(provider('https://api.openai.com/v1'), global)).toBe('http://proxy:3128');
  });

  it('honours noProxy entries, including domain suffixes', () => {
    expect(resolveProxy(provider('http://localhost:11434/v1'), global)).toBeUndefined();
    expect(resolveProxy(provider('http://llm.internal/v1'), global)).toBeUndefined();
    expect(resolveProxy(provider('http://127.0.0.1:8000/v1'), global)).toBeUndefined();
  });

  it('lets providers override or disable the proxy', () => {
    expect(resolveProxy(provider('https://x.com', 'http://other:8080'), global)).toBe(
      'http://other:8080',
    );
    expect(resolveProxy(provider('https://x.com', false), global)).toBeUndefined();
    expect(resolveProxy(provider('https://x.com'), { noProxy: [] })).toBeUndefined();
  });

  it('matches wildcard, suffix and exact hosts only', () => {
    expect(matchesNoProxy('anything', ['*'])).toBe(true);
    expect(matchesNoProxy('notlocalhost', ['localhost'])).toBe(false);
    expect(matchesNoProxy('a.b.example.com', ['*.example.com'])).toBe(true);
  });

  it('redacts proxy credentials', () => {
    expect(redactUrl('http://user:secret@proxy:3128')).toBe('http://***@proxy:3128/');
  });
});
