import type { HealthReport } from './schema.js';

/**
 * Pure TTL helper. A report is stale once `now` is strictly past `ts + ttl_seconds`.
 * An unparseable timestamp is treated as stale (fail loud, never silently fresh).
 *
 * This is the same rule the central staleness sweeper applies server-side; it is
 * exported so products and tests can reason about freshness locally without the DB.
 */
export function isStale(
  report: Pick<HealthReport, 'ts' | 'ttl_seconds'>,
  nowMs: number,
): boolean {
  const tsMs = Date.parse(report.ts);
  if (Number.isNaN(tsMs)) return true;
  return nowMs > tsMs + report.ttl_seconds * 1000;
}
