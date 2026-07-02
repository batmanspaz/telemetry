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

  return {
    async send(path, body) {
      const payload = JSON.stringify(body);
      const ts = new Date(now()).toISOString();
      const signature = createHmac('sha256', config.hmacKey)
        .update(`${config.product}.${ts}.${payload}`)
        .digest('hex');
      const res = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-PC-Product': config.product,
          'X-PC-Timestamp': ts,
          'X-PC-Signature': signature,
          ...config.headers,
        },
        body: payload,
      });
      if (!res.ok) {
        throw new Error(`telemetry ingest ${path} failed: ${res.status}`);
      }
    },
  };
}
