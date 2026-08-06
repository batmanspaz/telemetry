import { type HealthCheck, type HealthStatus, type PropValue } from './schema.js';
import { type Transport } from './transport.js';
export interface TelemetryConfig {
    /** Product identity, e.g. 'billing'. */
    product: string;
    /** Module identity within the product, e.g. 'payments'. */
    module: string;
    /** Build/git sha — surfaced so the dashboard shows what's deployed. */
    version: string;
    /** Worker id / host. */
    instance?: string;
    /** Where emissions go. Defaults to noopTransport (a safe mock). */
    transport?: Transport;
    /** Heartbeat interval in ms (default 60000). 0 disables the heartbeat.
     *  NOTE: this relies on a persistent setInterval and does NOT fire in
     *  request/response serverless functions (the process suspends once the
     *  response is sent, before the interval can tick). See `forceResendMs`
     *  for the mechanism that also works there. */
    heartbeatMs?: number;
    /** Default ttl_seconds stamped on health reports that don't set their own. */
    ttlSeconds?: number;
    /** Force a resend at least this often even without a status change,
     *  checked inline against `now()` on every `reportHealth()` call — no
     *  timer involved, so it works within a single request's lifecycle on
     *  serverless/edge platforms where `heartbeatMs`'s setInterval cannot run.
     *  Without this, a traffic-driven caller whose status never changes would
     *  send exactly once (at cold start) and then go stale forever, even under
     *  continuous real traffic, because "no status change" is architecturally
     *  indistinguishable from "no traffic" once the interval can't fire.
     *  Defaults to half of the effective `ttlSeconds`, so two reportHealth()
     *  calls anywhere inside a ttl window are enough to stay fresh regardless
     *  of platform. Set 0 to disable and rely purely on change-detection (only
     *  safe on a persistent process where the heartbeat interval actually runs). */
    forceResendMs?: number;
    /** Flush a batch once this many events are buffered (default 20). */
    batchSize?: number;
    /** Flush the batch at least this often in ms (default 5000). 0 disables. */
    batchIntervalMs?: number;
    /** Hard ceiling on buffered analytics events (default 1000). When the sink is
     *  down and requeues accumulate past this, the OLDEST events are dropped (and
     *  counted in events_dropped) so memory stays bounded. */
    maxBufferedEvents?: number;
    /** Injectable clock (ms) for deterministic tests. */
    now?: () => number;
    /** Start the heartbeat + batch timers automatically (default true). */
    autoStart?: boolean;
    /** Hand the platform's own keep-alive primitive (Vercel's `waitUntil` from
     *  `@vercel/functions`, Cloudflare Workers' `ctx.waitUntil`, etc.) every
     *  in-flight send this client fires. Without this, an unawaited call —
     *  `void telemetry.reportHealth(...)`, the common product call-site pattern —
     *  has no completion guarantee once a serverless response flushes (confirmed
     *  live 2026-08-06: pagewright's collect:staging silently dropped 4 of 5
     *  sequential real health reports this way, with no ingest row and no
     *  health_dropped bump — execution was cut off before sendHealth's own
     *  try/catch ran). Registered synchronously on every reportHealth()/flush()
     *  call (and the library's own internal heartbeat/batch fire-and-forget
     *  sends), so no product call site needs to change. Defaults to a no-op —
     *  omitting this preserves exactly today's behavior. */
    keepAlive?: (p: Promise<unknown>) => void;
}
export interface Counters {
    health_sent: number;
    health_dropped: number;
    events_tracked: number;
    events_sent: number;
    events_dropped: number;
    events_deduped: number;
    /** telemetry.dropped rollup (health + events) surfaced as a health check. */
    dropped: number;
}
export interface HealthInput {
    status: HealthStatus;
    checks?: HealthCheck[];
    score?: number;
    ttl_seconds?: number;
    instance?: string;
    version?: string;
}
export interface TrackInput {
    /** Dotted, lower-case event name, e.g. 'invoice.created'. */
    event: string;
    entity_type?: string;
    /** Hash sensitive ids with `hash()` before passing them here. */
    entity_id?: string;
    /** Hashed user/session id — never a raw email. */
    actor?: string;
    session_id?: string;
    props?: Record<string, PropValue>;
    /** Idempotency / dedupe key. Derived from content if omitted. */
    key?: string;
    /** Override timestamp (ms-resolution ISO derived from `now()` if omitted). */
    ts?: string;
}
export interface Telemetry {
    /** Validate + emit a health report. Sends immediately on status change. */
    reportHealth(input: HealthInput): Promise<void>;
    /** Validate + buffer an analytics event. Non-blocking, never throws. */
    track(input: TrackInput): void;
    /** Flush the analytics batch now. Non-blocking, never throws. */
    flush(): Promise<void>;
    /** Live counters (telemetry.dropped surfaced for self-reporting). */
    counters: Counters;
    /** Stop the heartbeat + batch timers (idempotent). */
    stop(): void;
}
export declare function createTelemetry(config: TelemetryConfig): Telemetry;
//# sourceMappingURL=telemetry.d.ts.map