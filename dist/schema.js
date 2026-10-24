import { z } from 'zod';
import { LIMITS } from './limits.js';
/**
 * Canonical schema version for both HealthReport and AnalyticsEvent.
 * Bump only with a coordinated migration across the portfolio + central ingest.
 *
 * These schemas are hand-mirrored from the single source of truth — the deployed
 * Health Monitor ingest (`health-monitor/rebuild/src/schemas.ts`). They must stay
 * field-for-field identical (including `.strict()`), since the central ingest
 * rejects anything off-schema. There is no shared import across those two repos,
 * so any change here needs a matching change there and vice versa.
 */
export const SCHEMA_VERSION = 1;
export const HealthStatusSchema = z.enum(['ok', 'degraded', 'down', 'stale']);
export const CheckStatusSchema = z.enum(['pass', 'warn', 'fail']);
export const HealthCheckSchema = z
    .object({
    id: z.string().min(1).max(LIMITS.checkId),
    status: CheckStatusSchema,
    detail: z.string().max(LIMITS.checkDetail).optional(),
    metric: z.number().optional(),
    unit: z.string().max(LIMITS.checkUnit).optional(),
})
    .strict();
const ident = z.string().min(1).max(LIMITS.identifier);
export const HealthReportSchema = z
    .object({
    schema_version: z.literal(SCHEMA_VERSION),
    product: ident,
    module: ident,
    instance: z.string().max(LIMITS.identifier).optional(),
    status: HealthStatusSchema,
    score: z.number().min(0).max(100).optional(),
    checks: z.array(HealthCheckSchema).max(LIMITS.checks),
    version: ident,
    ts: z.string().datetime({ offset: true }),
    ttl_seconds: z.number().int().positive().max(LIMITS.ttlSeconds),
})
    .strict();
const PropValueSchema = z.union([z.string().max(LIMITS.propStrLen), z.number(), z.boolean()]);
// z.record has no .max(), and refinements run only after every value has parsed,
// so a 500k-key object would collect 500k issues first. Pre-guard the key count
// (cheap, no per-value work) and let .pipe() abort before the record parses.
const PropsSchema = z
    .custom((v) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
        return false;
    let n = 0;
    for (const k in v) {
        if (Object.prototype.hasOwnProperty.call(v, k) && ++n > LIMITS.propKeys)
            return false;
    }
    return true;
}, { message: `props must be an object with at most ${LIMITS.propKeys} keys` })
    .pipe(z.record(z.string().max(LIMITS.propKeyLen), PropValueSchema));
export const AnalyticsEventSchema = z
    .object({
    schema_version: z.literal(SCHEMA_VERSION),
    // dotted, lower-case event name, e.g. 'invoice.created', 'payment.recorded' —
    // must start with a letter (matches the server's regex exactly).
    event: z
        .string()
        .min(1)
        .max(LIMITS.eventName)
        .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, 'event must be dotted lower_snake'),
    product: ident,
    module: ident,
    entity_type: z.string().max(LIMITS.entityType).optional(),
    entity_id: z.string().max(LIMITS.identifier).optional(),
    actor: z.string().max(LIMITS.identifier).optional(),
    session_id: z.string().max(LIMITS.identifier).optional(),
    props: PropsSchema,
    ts: z.string().datetime({ offset: true }),
    // Idempotency key — makes ingest safe to retry. The wire field name is
    // `dedupe_key`, matching the server's schema exactly (it is NOT called `id`).
    dedupe_key: ident,
})
    .strict();
// The wire body for POST /ingest/analytics is a bare JSON array of events —
// there is no wrapping envelope object. Matches the server's `AnalyticsBatch`.
export const AnalyticsBatchSchema = z.array(AnalyticsEventSchema).min(1).max(LIMITS.batch);
//# sourceMappingURL=schema.js.map