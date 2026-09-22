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
export declare const noopTransport: Transport;
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
/**
 * HTTP transport for the signed ingest endpoints. Matches the real deployed
 * Health Monitor ingest contract exactly (health-monitor/rebuild/src/{index,hmac}.ts):
 *   - X-PC-Product:   the product name (also embedded in the signature)
 *   - X-PC-Timestamp: ISO8601 send time (bounds the replay window server-side)
 *   - X-PC-Signature: hex HMAC-SHA256 over `${product}.${timestamp}.${rawBody}`
 * Throws on a non-2xx response so the client counts the drop; the client is
 * responsible for keeping that throw non-blocking.
 */
export declare function httpTransport(config: HttpTransportConfig): Transport;
//# sourceMappingURL=transport.d.ts.map