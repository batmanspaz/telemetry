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
  const doFetch = config.fetch ?? (globalThis.fetch as typeof fetch | undefined);
  if (!doFetch) {
    throw new Error('httpTransport: no fetch available — pass config.fetch');
  }
  const base = config.baseUrl.replace(/\/+$/, '');
  const now = config.now ?? Date.now;
  const timeoutMs = config.timeoutMs ?? 5_000;

  return {
    async send(path, body) {
      const payload = JSON.stringify(body);
      const ts = new Date(now()).toISOString();
      const signature = createHmac('sha256', config.hmacKey)
        .update(`${config.product}.${ts}.${payload}`)
        .digest('hex');

      // AbortController drives real cancellation of the underlying request.
      // The `timeoutPromise` leg is what actually bounds `send()`'s own
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
          throw new Error(`telemetry ingest ${path} failed: ${res.status}`);
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
