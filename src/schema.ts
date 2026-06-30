import { z } from 'zod';

/**
 * Canonical schema version for both HealthReport and AnalyticsEvent.
 * Bump only with a coordinated migration across the portfolio + central ingest.
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
    instance: z.string().min(1).optional(),
    status: HealthStatusSchema,
    score: z.number().min(0).max(100).optional(),
    checks: z.array(HealthCheckSchema),
    version: z.string().min(1),
    ts: z.string().datetime(),
    ttl_seconds: z.number().int().positive(),
  })
  .strict();

const PropValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const AnalyticsEventSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    // dotted, lower-case event name, e.g. 'invoice.created', 'payment.recorded'
    event: z
      .string()
      .regex(/^[a-z0-9]+(?:\.[a-z0-9_]+)+$/, 'event must be a dotted lower-case name'),
    product: z.string().min(1),
    module: z.string().min(1),
    entity_type: z.string().optional(),
    entity_id: z.string().optional(),
    actor: z.string().optional(),
    session_id: z.string().optional(),
    props: z.record(z.string(), PropValueSchema),
    ts: z.string().datetime(),
  })
  .strict();

export type HealthStatus = z.infer<typeof HealthStatusSchema>;
export type CheckStatus = z.infer<typeof CheckStatusSchema>;
export type HealthCheck = z.infer<typeof HealthCheckSchema>;
export type HealthReport = z.infer<typeof HealthReportSchema>;
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;
export type PropValue = z.infer<typeof PropValueSchema>;
