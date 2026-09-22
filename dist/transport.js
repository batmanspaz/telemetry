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
function defaultSleep(ms) {
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
async function safeResponseText(res) {
    try {
        if (typeof res.text === 'function') {
            const text = await res.text();
            return text ? text : undefined;
        }
    }
    catch {
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
export function httpTransport(config) {
    const maybeFetch = config.fetch ?? globalThis.fetch;
    if (!maybeFetch) {
        throw new Error('httpTransport: no fetch available — pass config.fetch');
    }
    // Re-bound to a non-optional type: `maybeFetch`'s `if (!x) throw` narrowing above does not
    // carry into the `attempt` closure below (a separate function scope) — TS widens a captured
    // `const` back to its declared (possibly-undefined) type across a function boundary. `doFetch`
    // is never reassigned, so this is exactly as safe as the narrowing it replaces.
    const doFetch = maybeFetch;
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
    async function attempt(path, payload) {
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
        const timeoutPromise = new Promise((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(new Error(`telemetry ingest ${path} timed out after ${timeoutMs}ms`)), { once: true });
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
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
        }
        finally {
            clearTimeout(timer);
        }
    }
    return {
        async send(path, body) {
            const payload = JSON.stringify(body);
            const maxAttempts = retries + 1;
            let lastError = new Error(`telemetry ingest ${path} failed: no attempt was made`);
            for (let attemptNum = 1; attemptNum <= maxAttempts; attemptNum++) {
                const result = await attempt(path, payload);
                if (result.ok)
                    return;
                lastError = result.error;
                if (result.status !== undefined && noRetryStatusCodes.has(result.status))
                    break;
                if (attemptNum < maxAttempts) {
                    await sleep(retryBaseDelayMs * 2 ** (attemptNum - 1));
                }
            }
            throw lastError;
        },
    };
}
//# sourceMappingURL=transport.js.map