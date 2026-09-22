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

  it('includes the response body text in the thrown error when the mock/real Response exposes .text() (tasks.db #1095 — a 401 reason code like "unauthorized: signature mismatch" was previously discarded entirely, leaving no way to diagnose WHY an ingest call was rejected)', async () => {
    const fakeFetch = vi.fn(
      async () =>
        ({ ok: false, status: 401, text: async () => 'unauthorized: timestamp outside replay window' }) as Response,
    );
    const t = httpTransport({
      baseUrl: 'https://ingest.example.com',
      product: 'billing',
      hmacKey: 'k',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await expect(t.send('/ingest/health', {})).rejects.toThrow(/401.*unauthorized: timestamp outside replay window/);
  });

  it('still throws cleanly when the Response has no .text() method (defensive — some mocks/edge runtimes omit it)', async () => {
    const fakeFetch = vi.fn(async () => ({ ok: false, status: 503 }) as Response);
    const t = httpTransport({
      baseUrl: 'https://ingest.example.com',
      product: 'billing',
      hmacKey: 'k',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await expect(t.send('/ingest/health', {})).rejects.toThrow(/503/);
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

  // tasks.db #1095 (CollageSoup 2026-09-21 — four HTTP 401s against hx-health-ingest in one day,
  // escalating from a handful of events to 92 in a single `health-resend-cron` tick). Root cause
  // of the individual 401s could not be pinned down deterministically (key pair confirmed
  // unchanged, endpoint confirmed reachable) — this is the bounded safety net regardless: a
  // TRANSIENT failure (a blip, a brief clock-skew/timing edge, a momentary ingest-side hiccup)
  // must not silently become PERMANENT data loss just because nothing ever retried. Opt-in via
  // `retries` (default 0 — unchanged behavior for every other consumer of this shared package
  // until they choose to opt in; a global default-on change has portfolio-wide blast radius this
  // incident does not justify taking on unreviewed).
  describe('retry-with-backoff (tasks.db #1095)', () => {
    it('defaults to zero retries — a single failed attempt still throws immediately (existing behavior, unchanged)', async () => {
      const fakeFetch = vi.fn(async () => ({ ok: false, status: 401 }) as Response);
      const t = httpTransport({
        baseUrl: 'https://ingest.example.com',
        product: 'billing',
        hmacKey: 'k',
        fetch: fakeFetch as unknown as typeof fetch,
      });
      await expect(t.send('/ingest/health', {})).rejects.toThrow(/401/);
      expect(fakeFetch).toHaveBeenCalledTimes(1);
    });

    it('retries a failing send up to `retries` additional times, with backoff, before giving up', async () => {
      let calls = 0;
      const fakeFetch = vi.fn(async () => {
        calls++;
        return { ok: false, status: 401 } as Response;
      });
      const sleeps: number[] = [];
      const t = httpTransport({
        baseUrl: 'https://ingest.example.com',
        product: 'billing',
        hmacKey: 'k',
        fetch: fakeFetch as unknown as typeof fetch,
        retries: 2,
        retryBaseDelayMs: 100,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });
      await expect(t.send('/ingest/health', {})).rejects.toThrow(/401/);
      expect(calls).toBe(3); // 1 initial attempt + 2 retries
      expect(sleeps).toEqual([100, 200]); // exponential backoff between attempts, none after the last
    });

    it('succeeds without exhausting retries once a retry attempt lands ok', async () => {
      let calls = 0;
      const fakeFetch = vi.fn(async () => {
        calls++;
        if (calls < 3) return { ok: false, status: 401 } as Response;
        return { ok: true, status: 200 } as Response;
      });
      const t = httpTransport({
        baseUrl: 'https://ingest.example.com',
        product: 'billing',
        hmacKey: 'k',
        fetch: fakeFetch as unknown as typeof fetch,
        retries: 3,
        retryBaseDelayMs: 0,
        sleep: async () => {},
      });
      await expect(t.send('/ingest/health', {})).resolves.toBeUndefined();
      expect(calls).toBe(3);
    });

    it('recomputes a fresh timestamp + signature on every retry attempt (a stale replayed ts must never be what finally lands)', async () => {
      let calls = 0;
      let clock = Date.parse('2026-09-21T00:00:00.000Z');
      const seenTimestamps: string[] = [];
      const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
        calls++;
        seenTimestamps.push((init.headers as Record<string, string>)['X-PC-Timestamp']!);
        if (calls < 2) return { ok: false, status: 401 } as Response;
        return { ok: true, status: 200 } as Response;
      });
      const t = httpTransport({
        baseUrl: 'https://ingest.example.com',
        product: 'billing',
        hmacKey: 'k',
        fetch: fakeFetch as unknown as typeof fetch,
        now: () => clock,
        retries: 1,
        retryBaseDelayMs: 0,
        sleep: async () => {
          clock += 5_000; // time genuinely passes during the backoff wait
        },
      });
      await t.send('/ingest/health', {});
      expect(seenTimestamps).toHaveLength(2);
      expect(seenTimestamps[0]).not.toBe(seenTimestamps[1]);
    });

    it('does not retry a 400 (deterministically-malformed payload — a retry can never fix it)', async () => {
      const fakeFetch = vi.fn(async () => ({ ok: false, status: 400 }) as Response);
      const t = httpTransport({
        baseUrl: 'https://ingest.example.com',
        product: 'billing',
        hmacKey: 'k',
        fetch: fakeFetch as unknown as typeof fetch,
        retries: 3,
        retryBaseDelayMs: 0,
        sleep: async () => {},
      });
      await expect(t.send('/ingest/health', {})).rejects.toThrow(/400/);
      expect(fakeFetch).toHaveBeenCalledTimes(1);
    });

    it('retries a network-level failure (fetch throwing) the same as a non-ok response', async () => {
      let calls = 0;
      const fakeFetch = vi.fn(async () => {
        calls++;
        if (calls < 2) throw new Error('ECONNRESET');
        return { ok: true, status: 200 } as Response;
      });
      const t = httpTransport({
        baseUrl: 'https://ingest.example.com',
        product: 'billing',
        hmacKey: 'k',
        fetch: fakeFetch as unknown as typeof fetch,
        retries: 2,
        retryBaseDelayMs: 0,
        sleep: async () => {},
      });
      await expect(t.send('/ingest/health', {})).resolves.toBeUndefined();
      expect(calls).toBe(2);
    });
  });
});
