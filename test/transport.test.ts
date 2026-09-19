import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { noopTransport, httpTransport } from '../src/index.js';

describe('noopTransport', () => {
  it('resolves without doing anything', async () => {
    await expect(noopTransport.send('/ingest/health', { a: 1 })).resolves.toBeUndefined();
  });
});

describe('httpTransport', () => {
  // Contract pinned against the real deployed Health Monitor ingest
  // (health-monitor/rebuild/src/{index,hmac}.ts): X-PC-Product / X-PC-Timestamp /
  // X-PC-Signature headers, signature = HMAC-SHA256 over `${product}.${ts}.${body}`.
  // The previous `x-telemetry-signature: sha256=<hex over body only>` scheme, with
  // no product/timestamp binding, does not match the server and was never caught
  // because only a mock transport was exercised in the telemetry client's own tests.
  it('POSTs to baseUrl + path with X-PC-Product/Timestamp/Signature headers matching the server contract', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200 } as Response;
    });
    const t = httpTransport({
      baseUrl: 'https://ingest.example.com/',
      product: 'billing',
      hmacKey: 'topsecret',
      fetch: fakeFetch as unknown as typeof fetch,
      now: () => Date.parse('2026-07-02T00:00:00.000Z'),
    });

    const body = { hello: 'world' };
    await t.send('/ingest/health', body);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://ingest.example.com/ingest/health');
    expect(calls[0]!.init.method).toBe('POST');

    const payload = JSON.stringify(body);
    const ts = '2026-07-02T00:00:00.000Z';
    const expectedSig = createHmac('sha256', 'topsecret').update(`billing.${ts}.${payload}`).digest('hex');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-PC-Product']).toBe('billing');
    expect(headers['X-PC-Timestamp']).toBe(ts);
    expect(headers['X-PC-Signature']).toBe(expectedSig);
    expect(headers['content-type']).toBe('application/json');
    expect(calls[0]!.init.body).toBe(payload);
  });

  it('throws on a non-ok response (so the client can count the drop)', async () => {
    const fakeFetch = vi.fn(async () => ({ ok: false, status: 503 }) as Response);
    const t = httpTransport({
      baseUrl: 'https://ingest.example.com',
      product: 'billing',
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
      product: 'billing',
      hmacKey: 'SUPER_SECRET_KEY',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await t.send('/ingest/health', { a: 1 });
    expect(seen).not.toContain('SUPER_SECRET_KEY');
  });

  // tasks.db #1089: a hung POST (dead TCP connection, black-holed request, a
  // server that never answers) previously blocked the calling module's
  // reportHealth()/track() indefinitely — there was no HTTP timeout at all.
  // This is the reproduction: a fetch that never settles. Before the fix,
  // `t.send()` never resolves or rejects, so the race below always times out
  // at the OUTER 'still-pending' guard (bounded at 500ms so the test itself
  // can't hang forever even while red).
  describe('timeout (tasks.db #1089)', () => {
    it('rejects instead of hanging forever when the request never settles', async () => {
      const hangingFetch = vi.fn(() => new Promise<Response>(() => {}));
      const t = httpTransport({
        baseUrl: 'https://ingest.example.com',
        product: 'billing',
        hmacKey: 'k',
        fetch: hangingFetch as unknown as typeof fetch,
        timeoutMs: 30,
      });

      const started = Date.now();
      const outcome = await Promise.race([
        t.send('/ingest/health', { a: 1 }).then(
          () => 'resolved' as const,
          () => 'rejected' as const,
        ),
        new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 500)),
      ]);

      expect(outcome).toBe('rejected');
      // Failed fast (bounded by timeoutMs), not by luck near the 500ms guard.
      expect(Date.now() - started).toBeLessThan(300);

      // Best-effort real cancellation: the underlying fetch was actually aborted,
      // not just raced away client-side (matters for a real network socket).
      const init = hangingFetch.mock.calls[0]![1] as RequestInit;
      expect((init.signal as AbortSignal).aborted).toBe(true);
    });

    it('surfaces a descriptive, catchable timeout error (never a silent swallow)', async () => {
      const hangingFetch = vi.fn(() => new Promise<Response>(() => {}));
      const t = httpTransport({
        baseUrl: 'https://ingest.example.com',
        product: 'billing',
        hmacKey: 'k',
        fetch: hangingFetch as unknown as typeof fetch,
        timeoutMs: 20,
      });

      await expect(t.send('/ingest/health', {})).rejects.toThrow(/timed?\s*out|timeout/i);
    });

    it('defaults to a 5000ms timeout when none is configured', async () => {
      vi.useFakeTimers();
      try {
        const hangingFetch = vi.fn(() => new Promise<Response>(() => {}));
        const t = httpTransport({
          baseUrl: 'https://ingest.example.com',
          product: 'billing',
          hmacKey: 'k',
          fetch: hangingFetch as unknown as typeof fetch,
        });

        let settled: 'resolved' | 'rejected' | undefined;
        t.send('/ingest/health', {}).then(
          () => (settled = 'resolved'),
          () => (settled = 'rejected'),
        );

        await vi.advanceTimersByTimeAsync(4_999);
        expect(settled).toBeUndefined();

        await vi.advanceTimersByTimeAsync(2);
        expect(settled).toBe('rejected');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not time out a request that resolves well within the budget', async () => {
      const fakeFetch = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
      const t = httpTransport({
        baseUrl: 'https://ingest.example.com',
        product: 'billing',
        hmacKey: 'k',
        fetch: fakeFetch as unknown as typeof fetch,
        timeoutMs: 5_000,
      });
      await expect(t.send('/ingest/health', { a: 1 })).resolves.toBeUndefined();
    });

    it('still throws the original error for a fast non-ok response (timeout logic does not mask it)', async () => {
      const fakeFetch = vi.fn(async () => ({ ok: false, status: 503 }) as Response);
      const t = httpTransport({
        baseUrl: 'https://ingest.example.com',
        product: 'billing',
        hmacKey: 'k',
        fetch: fakeFetch as unknown as typeof fetch,
        timeoutMs: 5_000,
      });
      await expect(t.send('/ingest/analytics', {})).rejects.toThrow(/503/);
    });
  });
});
