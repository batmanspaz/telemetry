import { z } from 'zod';

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
export const SCHEMA_VERSION = 1 as const;

export const HealthStatusSchema = z.enum(['ok', 'degraded', 'down', 'stale']);

export const CheckStatusSchema = z.enum(['pass', 'warn', 'fail']);

export const HealthCheckSchema = z
  .object({
    id: z.string().min(1),
    status: CheckStatusSchema,
    detail: z.string().optional(),
    metric: z.number().optional(),
    unit: z.string().optional(),
  })
  .strict();

export const HealthReportSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    product: z.string().min(1),
    module: z.string().min(1),
    instance: z.string().optional(),
    status: HealthStatusSchema,
    score: z.number().min(0).max(100).optional(),
    checks: z.array(HealthCheckSchema),
    version: z.string().min(1),
    ts: z.string().datetime({ offset: true }),
    ttl_seconds: z.number().int().positive(),
  })
  .strict();

const PropValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const AnalyticsEventSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    // dotted, lower-case event name, e.g. 'invoice.created', 'payment.recorded' —
    // must start with a letter (matches the server's regex exactly).
    event: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, 'event must be dotted lower_snake'),
    product: z.string().min(1),
    module: z.string().min(1),
    entity_type: z.string().optional(),
    entity_id: z.string().optional(),
    actor: z.string().optional(),
    session_id: z.string().optional(),
    props: z.record(z.string(), PropValueSchema),
    ts: z.string().datetime({ offset: true }),
    // Idempotency key — makes ingest safe to retry. The wire field name is
    // `dedupe_key`, matching the server's schema exactly (it is NOT called `id`).
    dedupe_key: z.string().min(1),
  })
  .strict();

// The wire body for POST /ingest/analytics is a bare JSON array of events —
// there is no wrapping envelope object. Matches the server's `AnalyticsBatch`.
export const AnalyticsBatchSchema = z.array(AnalyticsEventSchema).min(1);

export type HealthStatus = z.infer<typeof HealthStatusSchema>;
export type CheckStatus = z.infer<typeof CheckStatusSchema>;
export type HealthCheck = z.infer<typeof HealthCheckSchema>;
export type HealthReport = z.infer<typeof HealthReportSchema>;
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;
export type AnalyticsBatch = z.infer<typeof AnalyticsBatchSchema>;
export type PropValue = z.infer<typeof PropValueSchema>;
