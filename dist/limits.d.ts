/**
 * Single source of truth for wire-size caps (tasks.db #2471). Mirrored by the
 * ingest Workers (hx-analytics, hx-health-ingest, pc-health-platform), which enforce
 * them behind LIMITS_MODE=shadow|enforce|off (default shadow).
 * Headroom vs observed maxima is documented in telemetry-limits-REPORT.md.
 */
export declare const LIMITS: {
    /** events per POST /ingest/analytics request */
    readonly batch: 1000;
    /** checks per health report */
    readonly checks: 50;
    /** keys per event.props */
    readonly propKeys: 128;
    readonly propKeyLen: 128;
    readonly propStrLen: 1024;
    /** check.detail; the CLIENT truncates (never drops the report) */
    readonly checkDetail: 16384;
    readonly checkId: 256;
    readonly checkUnit: 32;
    /** product/module/instance/version/dedupe_key/entity_id/actor/session_id */
    readonly identifier: 256;
    readonly entityType: 64;
    readonly eventName: 128;
    /** health ttl_seconds: 30 days */
    readonly ttlSeconds: 2592000;
    /** analytics request body */
    readonly analyticsBodyBytes: 1048576;
    /** health request body (hx-health-ingest already enforces this) */
    readonly healthBodyBytes: 32768;
};
export declare const TRUNCATION_MARKER = "...[truncated]";
/** Truncate `s` to at most `max` chars, ending in a visible marker when cut. */
export declare function truncateDetail(s: string, max?: number): string;
export type LimitsMode = 'shadow' | 'enforce' | 'off';
/** Parse the LIMITS_MODE env var; anything unknown/unset falls back to 'shadow'. */
export declare function parseLimitsMode(v: string | undefined | null): LimitsMode;
//# sourceMappingURL=limits.d.ts.map