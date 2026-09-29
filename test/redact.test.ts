import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { SecretScrubber, summarizeForLog, summarizeTextForLog } from '../src/redact.js';
import { makeConfig } from './helpers.js';

const base64 = (bytes: number) => Buffer.alloc(bytes, 7).toString('base64');

describe('summarizeForLog', () => {
  it('replaces base64 data URIs with their size', () => {
    const body = {
      model: 'vision',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64(1_258_291)}` } },
            { type: 'file', file: { file_data: `data:application/pdf;base64,${base64(2048)}` } },
          ],
        },
      ],
    };

    const summarized = summarizeForLog(body) as typeof body;
    const [text, image, file] = summarized.messages[0]!.content as Array<Record<string, any>>;

    expect(text).toEqual({ type: 'text', text: 'Describe this image' });
    expect(image!.image_url.url).toBe('data:image/png;base64,…[1.2 MB]');
    expect(file!.file.file_data).toBe('data:application/pdf;base64,…[2.0 KB]');
    expect(body.messages[0]!.content[1]).toMatchObject({
      image_url: { url: expect.stringMatching(/^data:image\/png;base64,.{1000,}/) },
    });
  });

  it('replaces bare base64 payloads and long numeric arrays', () => {
    const summarized = summarizeForLog({
      input_audio: { data: base64(4096), format: 'wav' },
      data: [{ embedding: Array.from({ length: 1536 }, () => 0.1) }],
    });
    expect(summarized).toEqual({
      input_audio: { data: '[base64 4.0 KB]', format: 'wav' },
      data: [{ embedding: '[1536 numbers]' }],
    });
  });

  it('keeps short strings, prose and remote URLs', () => {
    const prose = 'word '.repeat(200);
    const url = `https://example.com/${'a'.repeat(300)}.png`;
    expect(summarizeForLog({ prose, url, short: 'abc', n: [1, 2, 3] })).toEqual({
      prose,
      url,
      short: 'abc',
      n: [1, 2, 3],
    });
  });

  it('parses JSON response bodies and truncates long raw text', () => {
    expect(summarizeTextForLog(JSON.stringify({ b64_json: base64(10_000) }))).toEqual({
      b64_json: '[base64 9.8 KB]',
    });
    const raw = summarizeTextForLog('<html>' + 'x '.repeat(5000)) as string;
    expect(raw.length).toBeLessThan(4200);
    expect(raw).toMatch(/…\[9\.8 KB total\]$/);
  });
});

describe('SecretScrubber', () => {
  const config = makeConfig({
    proxy: { url: 'http://user:proxy-p%40ssword@proxy:3128' },
    providers: {
      a: { baseUrl: 'http://a.test/v1', apiKey: 'sk-live-aaaaaaaaaaaa' },
      b: {
        baseUrl: 'http://b.test/v1',
        headers: {
          'api-key': 'azure-key-bbbbbbbb',
          'x-custom-auth': 'Bearer tok-cccccccc',
          referer: 'https://my.app',
        },
      },
      c: { baseUrl: 'http://c.test/v1', apiKey: 'short' },
    },
    routes: { r: { targets: [{ provider: 'a', model: 'm' }] } },
  });

  it('removes configured secrets and bearer tokens', () => {
    const scrubber = new SecretScrubber(config);
    const line = JSON.stringify({
      msg: 'Incorrect API key provided: sk-live-aaaaaaaaaaaa',
      headers: 'api-key: azure-key-bbbbbbbb; x-custom-auth: Bearer tok-cccccccc',
      proxy: 'proxy-p@ssword and proxy-p%40ssword',
      other: 'Authorization: Bearer someone-elses-token-123',
      referer: 'https://my.app',
    });

    const scrubbed = scrubber.scrub(line);

    for (const secret of [
      'sk-live-aaaaaaaaaaaa',
      'azure-key-bbbbbbbb',
      'tok-cccccccc',
      'proxy-p@ssword',
      'proxy-p%40ssword',
      'someone-elses-token-123',
    ]) {
      expect(scrubbed).not.toContain(secret);
    }
    expect(scrubbed).toContain('https://my.app');
    expect(scrubbed).toContain('Bearer [redacted]');
  });

  it('forgets old secrets and learns new ones on update', () => {
    const scrubber = new SecretScrubber(config);
    const next = makeConfig({
      providers: { a: { baseUrl: 'http://a.test/v1', apiKey: 'sk-rotated-zzzzzzzz' } },
      routes: { r: { targets: [{ provider: 'a', model: 'm' }] } },
    });
    scrubber.update(next);
    expect(scrubber.scrub('sk-rotated-zzzzzzzz')).toBe('[redacted]');
    expect(scrubber.scrub('sk-live-aaaaaaaaaaaa')).toBe('sk-live-aaaaaaaaaaaa');
  });
});

describe('config errors', () => {
  it('do not echo the YAML source (which may contain a hard-coded key)', () => {
    const source = 'providers:\n  a: { baseUrl: x, apiKey: sk-hardcoded-secret\n';
    expect(() => parseConfig(source, {})).toThrow(/invalid YAML/);
    try {
      parseConfig(source, {});
    } catch (error) {
      expect((error as Error).message).not.toContain('sk-hardcoded-secret');
    }
  });
});
