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
  /** Base URL of the central ingest Worker, e.g. https://telemetry.perfectcity.com */
  baseUrl: string;
  /** Per-product HMAC key, sourced from config/env at runtime — never hard-coded. */
  hmacKey: string;
  /** Injectable fetch (defaults to global fetch); pass one in Workers/tests. */
  fetch?: typeof fetch;
  /** Extra headers (e.g. CF Access service token) merged into every request. */
  headers?: Record<string, string>;
}

/**
 * HTTP transport for the signed ingest endpoints. Signs the exact JSON body with
 * HMAC-SHA256 and sends it as `x-telemetry-signature: sha256=<hex>`. Throws on a
 * non-2xx response so the client counts the drop; the client is responsible for
 * keeping that throw non-blocking.
 */
export function httpTransport(config: HttpTransportConfig): Transport {
  const doFetch = config.fetch ?? (globalThis.fetch as typeof fetch | undefined);
  if (!doFetch) {
    throw new Error('httpTransport: no fetch available — pass config.fetch');
  }
  const base = config.baseUrl.replace(/\/+$/, '');
  return {
    async send(path, body) {
      const payload = JSON.stringify(body);
      const signature = createHmac('sha256', config.hmacKey).update(payload).digest('hex');
      const res = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telemetry-signature': `sha256=${signature}`,
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
