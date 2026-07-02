import { createHmac } from 'node:crypto';
/**
 * Default transport: drops everything on the floor. Safe default so a
 * misconfigured product emits nothing rather than crashing, and the obvious
 * choice for unit tests / local dev.
 */
export const noopTransport = {
    async send() {
        /* no-op */
    },
};
/**
 * HTTP transport for the signed ingest endpoints. Matches the real deployed
 * Health Monitor ingest contract exactly (health-monitor/rebuild/src/{index,hmac}.ts):
 *   - X-PC-Product:   the product name (also embedded in the signature)
 *   - X-PC-Timestamp: ISO8601 send time (bounds the replay window server-side)
 *   - X-PC-Signature: hex HMAC-SHA256 over `${product}.${timestamp}.${rawBody}`
 * Throws on a non-2xx response so the client counts the drop; the client is
 * responsible for keeping that throw non-blocking.
 */
export function httpTransport(config) {
    const doFetch = config.fetch ?? globalThis.fetch;
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
//# sourceMappingURL=transport.js.map