// @perfectcity/telemetry — shared telemetry + health self-reporting client.
// Canonical, versioned schemas + a non-blocking, mockable emit client.

export {
  SCHEMA_VERSION,
  HealthStatusSchema,
  CheckStatusSchema,
  HealthCheckSchema,
  HealthReportSchema,
  AnalyticsEventSchema,
  AnalyticsBatchSchema,
  type HealthStatus,
  type CheckStatus,
  type HealthCheck,
  type HealthReport,
  type AnalyticsEvent,
  type AnalyticsBatch,
  type PropValue,
} from './schema.js';

export { hash } from './hash.js';
export { isStale } from './stale.js';
export { looksLikePii, scanForPii } from './pii.js';
export {
  noopTransport,
  httpTransport,
  type Transport,
  type HttpTransportConfig,
} from './transport.js';
export {
  createTelemetry,
  type Telemetry,
  type TelemetryConfig,
  type Counters,
  type HealthInput,
  type TrackInput,
} from './telemetry.js';
