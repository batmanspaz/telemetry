import { describe, it, expect } from 'vitest';
import {
  HealthReportSchema,
  AnalyticsEventSchema,
  AnalyticsBatchSchema,
  SCHEMA_VERSION,
} from '../src/index.js';

const validHealth = {
  schema_version: 1,
  product: 'billing',
  module: 'payments',
  instance: 'worker-1',
  status: 'ok',
  score: 99,
  checks: [{ id: 'db.ping', status: 'pass', detail: 'ok', metric: 12, unit: 'ms' }],
  version: 'abc123',
  ts: '2026-06-29T00:00:00.000Z',
  ttl_seconds: 90,
};

const validEvent = {
  schema_version: 1,
  event: 'invoice.created',
  product: 'billing',
  module: 'payments',
  entity_type: 'invoice',
  entity_id: 'inv_1',
  actor: 'deadbeef',
  session_id: 'sess_1',
  props: { amount: 1200, currency: 'usd', test: true },
  ts: '2026-06-29T00:00:00.000Z',
  dedupe_key: 'inv_1:created',
};

describe('SCHEMA_VERSION', () => {
  it('is 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});

describe('HealthReportSchema', () => {
  it('accepts a fully-formed report', () => {
    expect(HealthReportSchema.safeParse(validHealth).success).toBe(true);
  });

  it('accepts the minimal required shape (no optionals)', () => {
    const { instance, score, ...min } = validHealth;
    expect(HealthReportSchema.safeParse(min).success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(HealthReportSchema.safeParse({ ...validHealth, status: 'exploded' }).success).toBe(false);
  });

  it('rejects schema_version other than 1', () => {
    expect(HealthReportSchema.safeParse({ ...validHealth, schema_version: 2 }).success).toBe(false);
  });

  it('rejects a score above 100', () => {
    expect(HealthReportSchema.safeParse({ ...validHealth, score: 101 }).success).toBe(false);
  });

  it('rejects a non-positive ttl', () => {
    expect(HealthReportSchema.safeParse({ ...validHealth, ttl_seconds: 0 }).success).toBe(false);
  });

  it('rejects an unknown extra key (strict)', () => {
    expect(HealthReportSchema.safeParse({ ...validHealth, surprise: 1 }).success).toBe(false);
  });

  it('rejects an invalid check status', () => {
    const bad = { ...validHealth, checks: [{ id: 'x', status: 'broken' }] };
    expect(HealthReportSchema.safeParse(bad).success).toBe(false);
  });
});

describe('AnalyticsEventSchema', () => {
  it('accepts a fully-formed event', () => {
    expect(AnalyticsEventSchema.safeParse(validEvent).success).toBe(true);
  });

  it('requires a dotted event name', () => {
    expect(AnalyticsEventSchema.safeParse({ ...validEvent, event: 'invoicecreated' }).success).toBe(false);
  });

  it('rejects an event name starting with a digit', () => {
    expect(AnalyticsEventSchema.safeParse({ ...validEvent, event: '1invoice.created' }).success).toBe(false);
  });

  it('rejects props that are not string/number/boolean', () => {
    const bad = { ...validEvent, props: { nested: { a: 1 } } };
    expect(AnalyticsEventSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects schema_version other than 1', () => {
    expect(AnalyticsEventSchema.safeParse({ ...validEvent, schema_version: 99 }).success).toBe(false);
  });

  it('requires dedupe_key', () => {
    const { dedupe_key, ...missing } = validEvent;
    expect(AnalyticsEventSchema.safeParse(missing).success).toBe(false);
  });

  it('rejects an unknown extra key (strict) — in particular, the old "id" field name', () => {
    expect(AnalyticsEventSchema.safeParse({ ...validEvent, surprise: 1 }).success).toBe(false);
    expect(AnalyticsEventSchema.safeParse({ ...validEvent, id: 'x' }).success).toBe(false);
  });
});

describe('AnalyticsBatchSchema', () => {
  // The wire body for POST /ingest/analytics is a bare array — no wrapping
  // envelope object (no {events: [...]}). This is the contract the server
  // (health-monitor/rebuild) actually validates against.
  it('accepts a non-empty array of valid events', () => {
    expect(AnalyticsBatchSchema.safeParse([validEvent]).success).toBe(true);
  });

  it('rejects an empty array', () => {
    expect(AnalyticsBatchSchema.safeParse([]).success).toBe(false);
  });

  it('rejects a wrapped envelope object instead of a bare array', () => {
    expect(AnalyticsBatchSchema.safeParse({ events: [validEvent] }).success).toBe(false);
  });
});
