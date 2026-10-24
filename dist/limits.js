/**
 * Single source of truth for wire-size caps (tasks.db #2471). Mirrored by the
 * ingest Workers (hx-analytics, hx-health-ingest, pc-health-platform), which enforce
 * them behind LIMITS_MODE=shadow|enforce|off (default shadow).
 * Headroom vs observed maxima is documented in telemetry-limits-REPORT.md.
 */
export const LIMITS = {
    /** events per POST /ingest/analytics request */
    batch: 1000,
    /** checks per health report */
    checks: 50,
    /** keys per event.props */
    propKeys: 128,
    propKeyLen: 128,
    propStrLen: 1024,
    /** check.detail; the CLIENT truncates (never drops the report) */
    checkDetail: 16384,
    checkId: 256,
    checkUnit: 32,
    /** product/module/instance/version/dedupe_key/entity_id/actor/session_id */
    identifier: 256,
    entityType: 64,
    eventName: 128,
    /** health ttl_seconds: 30 days */
    ttlSeconds: 2_592_000,
    /** analytics request body */
    analyticsBodyBytes: 1_048_576,
    /** health request body (hx-health-ingest already enforces this) */
    healthBodyBytes: 32_768,
};
export const TRUNCATION_MARKER = '...[truncated]';
/** Truncate `s` to at most `max` chars, ending in a visible marker when cut. */
export function truncateDetail(s, max = LIMITS.checkDetail) {
    if (s.length <= max)
        return s;
    if (max <= TRUNCATION_MARKER.length)
        return s.slice(0, Math.max(0, max));
    let cut = max - TRUNCATION_MARKER.length;
    const c = s.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff)
        cut--; // never end on a lone high surrogate
    return s.slice(0, cut) + TRUNCATION_MARKER;
}
/** Parse the LIMITS_MODE env var; anything unknown/unset falls back to 'shadow'. */
export function parseLimitsMode(v) {
    return v === 'enforce' || v === 'off' || v === 'shadow' ? v : 'shadow';
}
//# sourceMappingURL=limits.js.map