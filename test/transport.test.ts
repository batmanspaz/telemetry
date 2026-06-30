import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { noopTransport, httpTransport } from '../src/index.js';

describe('noopTransport', () => {
  it('resolves without doing anything', async () => {
    await expect(noopTransport.send('/ingest/health', { a: 1 })).resolves.toBeUndefined();
  });
});

describe('httpTransport', () => {
  it('POSTs to baseUrl + path with an HMAC signature header', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200 } as Response;
    });
    const t = httpTransport({
      baseUrl: 'https://ingest.example.com/',
      hmacKey: 'topsecret',
      fetch: fakeFetch as unknown as typeof fetch,
    });

    const body = { hello: 'world' };
    await t.send('/ingest/health', body);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://ingest.example.com/ingest/health');
    expect(calls[0]!.init.method).toBe('POST');

    const payload = JSON.stringify(body);
    const expectedSig = 'sha256=' + createHmac('sha256', 'topsecret').update(payload).digest('hex');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-telemetry-signature']).toBe(expectedSig);
    expect(headers['content-type']).toBe('application/json');
    expect(calls[0]!.init.body).toBe(payload);
  });

  it('throws on a non-ok response (so the client can count the drop)', async () => {
    const fakeFetch = vi.fn(async () => ({ ok: false, status: 503 }) as Response);
    const t = httpTransport({
      baseUrl: 'https://ingest.example.com',
      hmacKey: 'k',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await expect(t.send('/ingest/analytics', {})).rejects.toThrow(/503/);
  });

  it('does not leak the hmac key into the request body or headers', async () => {
    let seen = '';
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      seen = JSON.stringify(init);
      return { ok: true, status: 200 } as Response;
    });
    const t = httpTransport({
      baseUrl: 'https://x',
      hmacKey: 'SUPER_SECRET_KEY',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await t.send('/ingest/health', { a: 1 });
    expect(seen).not.toContain('SUPER_SECRET_KEY');
  });
});
