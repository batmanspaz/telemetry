import { createHmac } from 'node:crypto';

/**
 * Injected transport seam. The telemetry client never talks to the network
 * directly — it calls `transport.send(path, body)`. This keeps the client pure
 * and mockable, and lets CF-Worker products swap in a service-binding transport.
 */
export interface Transport {
  send(path: string, body: unknown): Promise<void>;
}

/**
 * Default transport: drops everything on the floor. Safe default so a
 * misconfigured product emits nothing rather than crashing, and the obvious
 * choice for unit tests / local dev.
 */
export const noopTransport: Transport = {
  async send() {
    /* no-op */
  },
};

export interface HttpTransportConfig {
  /** Base URL of the central ingest Worker, e.g. https://pc-health-platform.<acct>.workers.dev */
  baseUrl: string;
  /** This product's identity — binds the signature and fills X-PC-Product. */
  product: string;
  /** Per-product HMAC key, sourced from config/env at runtime — never hard-coded. */
  hmacKey: string;
  /** Injectable fetch (defaults to global fetch); pass one in Workers/tests. */
  fetch?: typeof fetch;
  /** Extra headers (e.g. CF Access service token) merged into every request. */
  headers?: Record<string, string>;
  /** Injectable clock (ms), for deterministic tests. */
  now?: () => number;
  /** HTTP timeout for each outbound POST, in ms (tasks.db #1089). Without this,
   *  a hung request (dead TCP connection, a server that never answers) blocks
   *  the calling module's `reportHealth()`/`track()` indefinitely — there is no
   *  other bound anywhere in the client. On expiry the request is aborted and
   *  `send()` rejects, so the caller's existing catch path (`sendHealth`/
   *  `doFlush` in telemetry.ts) counts it as a drop and, if `onTransportError`
   *  is configured, reports it — a timeout is observable, never a silent hang
   *  or a silent swallow. Default 5000ms, matching the existing
   *  AbortController+setTimeout convention already used for outbound HTTP
   *  elsewhere on this platform (perfectcity/health-monitor/rebuild/src/uptime.ts
   *  TIMEOUT_MS). */
  timeoutMs?: number;
  /** Number of ADDITIONAL attempts after the first failed send, before finally
   *  throwing (tasks.db #1095 — CollageSoup, 2026-09-21: four HTTP 401s against
   *  hx-health-ingest in one day, escalating to 92 events dropped in a single
   *  `health-resend-cron` tick, with zero retry anywhere in this client — a
   *  transient blip became PERMANENT data loss purely because nothing ever
   *  retried). Default 0 — every existing consumer of this shared package keeps
   *  today's exact single-attempt behavior until it explicitly opts in; a
   *  global default-on change has portfolio-wide blast radius (every harness
   *  tenant, every product) this incident alone does not justify taking on
   *  unreviewed. Each retry recomputes `ts`/signature fresh (see `send` below)
   *  — a stale replayed timestamp must never be what finally lands. */
  retries?: number;
  /** Base delay in ms for exponential backoff between retry attempts (default
   *  250ms, doubling each attempt: 250ms, 500ms, 1000ms, ...). Only consulted
   *  when `retries` > 0. */
  retryBaseDelayMs?: number;
  /** Injectable delay, defaults to a real `setTimeout`-based sleep. Tests pass
   *  a no-op (or one that also advances an injected clock) to run instantly
   *  and deterministically. */
  sleep?: (ms: number) => Promise<void>;
  /** HTTP status codes that are NEVER retried even when `retries` > 0 — the
   *  failure is deterministic (the request itself is malformed), so a retry
   *  would just waste an attempt and add latency with no chance of success.
   *  Default: [400]. 401/403/5xx and network-level failures (fetch throwing)
   *  ARE retried by default, since those can be transient (a brief clock-skew
   *  edge, a momentary ingest-side hiccup, a dropped connection). */
  noRetryStatusCodes?: number[];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort response body capture for the thrown error (tasks.db #1095 —
 *  previously the thrown error carried ONLY the numeric status; a 401's actual
 *  reason text from the server (e.g. `"unauthorized: timestamp outside replay
 *  window"` vs `"unauthorized: signature mismatch"`) was discarded entirely and
 *  never surfaced anywhere — not in this error, not in any log — leaving no way
 *  to diagnose WHY a rejection happened after the fact. Defensive: some mocks
 *  and edge-runtime Response-likes don't implement `.text()` at all, and the
 *  body may already be consumed or the read may itself throw — none of that
 *  should ever prevent the original status-code error from being thrown. */
async function safeResponseText(res: Response): Promise<string | undefined> {
  try {
    if (typeof (res as { text?: unknown }).text === 'function') {
      const text = await res.text();
      return text ? text : undefined;
    }
  } catch {
    /* the original status-code error is what matters; a body-read failure is not fatal */
  }
  return undefined;
}

/**
 * HTTP transport for the signed ingest endpoints. Matches the real deployed
 * Health Monitor ingest contract exactly (health-monitor/rebuild/src/{index,hmac}.ts):
 *   - X-PC-Product:   the product name (also embedded in the signature)
 *   - X-PC-Timestamp: ISO8601 send time (bounds the replay window server-side)
 *   - X-PC-Signature: hex HMAC-SHA256 over `${product}.${timestamp}.${rawBody}`
 * Throws on a non-2xx response so the client counts the drop; the client is
 * responsible for keeping that throw non-blocking.
 */
export function httpTransport(config: HttpTransportConfig): Transport {
  const maybeFetch = config.fetch ?? (globalThis.fetch as typeof fetch | undefined);
  if (!maybeFetch) {
    throw new Error('httpTransport: no fetch available — pass config.fetch');
  }
  // Re-bound to a non-optional type: `maybeFetch`'s `if (!x) throw` narrowing above does not
  // carry into the `attempt` closure below (a separate function scope) — TS widens a captured
  // `const` back to its declared (possibly-undefined) type across a function boundary. `doFetch`
  // is never reassigned, so this is exactly as safe as the narrowing it replaces.
  const doFetch: typeof fetch = maybeFetch;
  const base = config.baseUrl.replace(/\/+$/, '');
  const now = config.now ?? Date.now;
  const timeoutMs = config.timeoutMs ?? 5_000;
  const retries = config.retries ?? 0;
  const retryBaseDelayMs = config.retryBaseDelayMs ?? 250;
  const sleep = config.sleep ?? defaultSleep;
  const noRetryStatusCodes = new Set(config.noRetryStatusCodes ?? [400]);

  /** A single attempt: fresh ts/signature, real timeout, and status-aware error
   *  capture. Extracted so the retry loop below can call it unchanged on every
   *  attempt — a retry must never replay a stale timestamp. */
  async function attempt(path: string, payload: string): Promise<{ ok: true } | { ok: false; error: Error; status?: number }> {
    const ts = new Date(now()).toISOString();
    const signature = createHmac('sha256', config.hmacKey)
      .update(`${config.product}.${ts}.${payload}`)
      .digest('hex');

    // AbortController drives real cancellation of the underlying request.
    // The `timeoutPromise` leg is what actually bounds this attempt's own
    // promise even if a mock/edge-case fetch implementation ignores the
    // abort signal entirely (a genuinely black-holed connection never
    // settles on its own) — the abort() call remains best-effort real
    // cancellation for a fetch that DOES honor it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const timeoutPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new Error(`telemetry ingest ${path} timed out after ${timeoutMs}ms`)),
        { once: true },
      );
    });

    try {
      const res = await Promise.race([
        doFetch(`${base}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-PC-Product': config.product,
            'X-PC-Timestamp': ts,
            'X-PC-Signature': signature,
            ...config.headers,
          },
          body: payload,
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
      if (!res.ok) {
        const bodyText = await safeResponseText(res);
        return {
          ok: false,
          status: res.status,
          error: new Error(`telemetry ingest ${path} failed: ${res.status}${bodyText ? ` — ${bodyText}` : ''}`),
        };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async send(path, body) {
      const payload = JSON.stringify(body);
      const maxAttempts = retries + 1;
      let lastError: Error = new Error(`telemetry ingest ${path} failed: no attempt was made`);

      for (let attemptNum = 1; attemptNum <= maxAttempts; attemptNum++) {
        const result = await attempt(path, payload);
        if (result.ok) return;
        lastError = result.error;
        if (result.status !== undefined && noRetryStatusCodes.has(result.status)) break;
        if (attemptNum < maxAttempts) {
          await sleep(retryBaseDelayMs * 2 ** (attemptNum - 1));
        }
      }
      throw lastError;
    },
  };
}
