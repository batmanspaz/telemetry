// @perfectcity/telemetry — shared telemetry + health self-reporting client.
// Canonical, versioned schemas + a non-blocking, mockable emit client.
export { SCHEMA_VERSION, HealthStatusSchema, CheckStatusSchema, HealthCheckSchema, HealthReportSchema, AnalyticsEventSchema, AnalyticsBatchSchema, } from './schema.js';
export { hash } from './hash.js';
export { isStale } from './stale.js';
export { looksLikePii, scanForPii } from './pii.js';
export { noopTransport, httpTransport, } from './transport.js';
export { createTelemetry, } from './telemetry.js';
//# sourceMappingURL=index.js.map