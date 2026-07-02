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
    /** Heartbeat interval in ms (default 60000). 0 disables the heartbeat. */
    heartbeatMs?: number;
    /** Default ttl_seconds stamped on health reports that don't set their own. */
    ttlSeconds?: number;
    /** Flush a batch once this many events are buffered (default 20). */
    batchSize?: number;
    /** Flush the batch at least this often in ms (default 5000). 0 disables. */
    batchIntervalMs?: number;
    /** Injectable clock (ms) for deterministic tests. */
    now?: () => number;
    /** Start the heartbeat + batch timers automatically (default true). */
    autoStart?: boolean;
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