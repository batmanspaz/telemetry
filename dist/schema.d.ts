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
export declare const SCHEMA_VERSION: 1;
export declare const HealthStatusSchema: z.ZodEnum<["ok", "degraded", "down", "stale"]>;
export declare const CheckStatusSchema: z.ZodEnum<["pass", "warn", "fail"]>;
export declare const HealthCheckSchema: z.ZodObject<{
    id: z.ZodString;
    status: z.ZodEnum<["pass", "warn", "fail"]>;
    detail: z.ZodOptional<z.ZodString>;
    metric: z.ZodOptional<z.ZodNumber>;
    unit: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    id: string;
    status: "pass" | "warn" | "fail";
    detail?: string | undefined;
    metric?: number | undefined;
    unit?: string | undefined;
}, {
    id: string;
    status: "pass" | "warn" | "fail";
    detail?: string | undefined;
    metric?: number | undefined;
    unit?: string | undefined;
}>;
export declare const HealthReportSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<1>;
    product: z.ZodString;
    module: z.ZodString;
    instance: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<["ok", "degraded", "down", "stale"]>;
    score: z.ZodOptional<z.ZodNumber>;
    checks: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        status: z.ZodEnum<["pass", "warn", "fail"]>;
        detail: z.ZodOptional<z.ZodString>;
        metric: z.ZodOptional<z.ZodNumber>;
        unit: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        id: string;
        status: "pass" | "warn" | "fail";
        detail?: string | undefined;
        metric?: number | undefined;
        unit?: string | undefined;
    }, {
        id: string;
        status: "pass" | "warn" | "fail";
        detail?: string | undefined;
        metric?: number | undefined;
        unit?: string | undefined;
    }>, "many">;
    version: z.ZodString;
    ts: z.ZodString;
    ttl_seconds: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    status: "ok" | "degraded" | "down" | "stale";
    schema_version: 1;
    product: string;
    module: string;
    checks: {
        id: string;
        status: "pass" | "warn" | "fail";
        detail?: string | undefined;
        metric?: number | undefined;
        unit?: string | undefined;
    }[];
    version: string;
    ts: string;
    ttl_seconds: number;
    instance?: string | undefined;
    score?: number | undefined;
}, {
    status: "ok" | "degraded" | "down" | "stale";
    schema_version: 1;
    product: string;
    module: string;
    checks: {
        id: string;
        status: "pass" | "warn" | "fail";
        detail?: string | undefined;
        metric?: number | undefined;
        unit?: string | undefined;
    }[];
    version: string;
    ts: string;
    ttl_seconds: number;
    instance?: string | undefined;
    score?: number | undefined;
}>;
declare const PropValueSchema: z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean]>;
export declare const AnalyticsEventSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<1>;
    event: z.ZodString;
    product: z.ZodString;
    module: z.ZodString;
    entity_type: z.ZodOptional<z.ZodString>;
    entity_id: z.ZodOptional<z.ZodString>;
    actor: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
    props: z.ZodRecord<z.ZodString, z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean]>>;
    ts: z.ZodString;
    dedupe_key: z.ZodString;
}, "strict", z.ZodTypeAny, {
    schema_version: 1;
    product: string;
    module: string;
    ts: string;
    event: string;
    props: Record<string, string | number | boolean>;
    dedupe_key: string;
    entity_type?: string | undefined;
    entity_id?: string | undefined;
    actor?: string | undefined;
    session_id?: string | undefined;
}, {
    schema_version: 1;
    product: string;
    module: string;
    ts: string;
    event: string;
    props: Record<string, string | number | boolean>;
    dedupe_key: string;
    entity_type?: string | undefined;
    entity_id?: string | undefined;
    actor?: string | undefined;
    session_id?: string | undefined;
}>;
export declare const AnalyticsBatchSchema: z.ZodArray<z.ZodObject<{
    schema_version: z.ZodLiteral<1>;
    event: z.ZodString;
    product: z.ZodString;
    module: z.ZodString;
    entity_type: z.ZodOptional<z.ZodString>;
    entity_id: z.ZodOptional<z.ZodString>;
    actor: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
    props: z.ZodRecord<z.ZodString, z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean]>>;
    ts: z.ZodString;
    dedupe_key: z.ZodString;
}, "strict", z.ZodTypeAny, {
    schema_version: 1;
    product: string;
    module: string;
    ts: string;
    event: string;
    props: Record<string, string | number | boolean>;
    dedupe_key: string;
    entity_type?: string | undefined;
    entity_id?: string | undefined;
    actor?: string | undefined;
    session_id?: string | undefined;
}, {
    schema_version: 1;
    product: string;
    module: string;
    ts: string;
    event: string;
    props: Record<string, string | number | boolean>;
    dedupe_key: string;
    entity_type?: string | undefined;
    entity_id?: string | undefined;
    actor?: string | undefined;
    session_id?: string | undefined;
}>, "many">;
export type HealthStatus = z.infer<typeof HealthStatusSchema>;
export type CheckStatus = z.infer<typeof CheckStatusSchema>;
export type HealthCheck = z.infer<typeof HealthCheckSchema>;
export type HealthReport = z.infer<typeof HealthReportSchema>;
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;
export type AnalyticsBatch = z.infer<typeof AnalyticsBatchSchema>;
export type PropValue = z.infer<typeof PropValueSchema>;
export {};
//# sourceMappingURL=schema.d.ts.map