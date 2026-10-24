import { describe, it, expect } from 'vitest';
import {
  HealthReportSchema,
  AnalyticsEventSchema,
  AnalyticsBatchSchema,
  createTelemetry,
  type Transport,
} from '../src/index.js';

/**
 * Phase 0 RED contract: upper bounds on the wire schemas.
 * Why: zod >= 4.6.6 (GHSA-mrhx-c7xc-m3w5) only short-circuits arrays that HAVE a .max();
 * a .min(1)-only array still collects one issue per bad element (500k elements -> 500k
 * issues). Numbers below are the PLAN's proposed caps (see telemetry-limits-REPORT.md);
 * they are hard-coded on purpose so a failure is an assertion failure, not an import error.
 */
const CAP = {
  batch: 1000,
  checks: 50,
  propKeys: 128,
  propKeyLen: 128,
  propStrLen: 1024,
  checkDetail: 16384,
  idLike: 256,
  ttl: 2_592_000,
  maxIssues: 10,
} as const;

const ts = '2026-06-29T00:00:00.000Z';
const ev = (i = 0, over: Record<string, unknown> = {}) => ({
  schema_version: 1, event: 'invoice.created', product: 'billing', module: 'payments',
  props: {}, ts, dedupe_key: `k${i}`, ...over,
});
const health = (over: Record<string, unknown> = {}) => ({
  schema_version: 1, product: 'billing', module: 'payments', status: 'ok',
  checks: [], version: 'abc123', ts, ttl_seconds: 90, ...over,
});
const issuesOf = (r: { success: boolean; error?: { issues: unknown[] } }) => (r.success ? 0 : r.error!.issues.length);

describe('batch cap', () => {
  it('rejects a 500k-element bad batch FAST with a bounded number of issues', () => {
    const bad = Array.from({ length: 500_000 }, () => ({}));
    const t0 = performance.now();
    const r = AnalyticsBatchSchema.safeParse(bad);
    const ms = performance.now() - t0;
    expect(r.success).toBe(false);
    expect(issuesOf(r as never)).toBeLessThanOrEqual(CAP.maxIssues);
    expect(ms).toBeLessThan(250);
  });
  it('accepts exactly the cap and rejects cap+1 (valid events)', () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ev(i));
    expect(AnalyticsBatchSchema.safeParse(mk(CAP.batch)).success).toBe(true);
    const over = AnalyticsBatchSchema.safeParse(mk(CAP.batch + 1));
    expect(over.success).toBe(false);
    expect(issuesOf(over as never)).toBeLessThanOrEqual(CAP.maxIssues);
  });
  it('still rejects an empty batch', () => {
    expect(AnalyticsBatchSchema.safeParse([]).success).toBe(false);
  });
});

describe('checks cap', () => {
  const chk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, status: 'pass' }));
  it('accepts the cap and rejects cap+1', () => {
    expect(HealthReportSchema.safeParse(health({ checks: chk(CAP.checks) })).success).toBe(true);
    expect(HealthReportSchema.safeParse(health({ checks: chk(CAP.checks + 1) })).success).toBe(false);
  });
  it('rejects 500k bad checks fast with bounded issues', () => {
    const bad = Array.from({ length: 500_000 }, () => ({}));
    const t0 = performance.now();
    const r = HealthReportSchema.safeParse(health({ checks: bad }));
    expect(r.success).toBe(false);
    expect(issuesOf(r as never)).toBeLessThanOrEqual(CAP.maxIssues);
    expect(performance.now() - t0).toBeLessThan(250);
  });
  it('bounds check detail / id / unit lengths', () => {
    const one = (o: Record<string, unknown>) => HealthReportSchema.safeParse(health({ checks: [{ id: 'a', status: 'pass', ...o }] })).success;
    expect(one({ detail: 'x'.repeat(CAP.checkDetail) })).toBe(true);
    expect(one({ detail: 'x'.repeat(CAP.checkDetail + 1) })).toBe(false);
    expect(one({ id: 'x'.repeat(CAP.idLike) })).toBe(true);
    expect(one({ id: 'x'.repeat(CAP.idLike + 1) })).toBe(false);
    expect(one({ unit: 'x'.repeat(33) })).toBe(false);
  });
});

describe('props caps', () => {
  const props = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
  it('accepts cap keys and rejects cap+1', () => {
    expect(AnalyticsEventSchema.safeParse(ev(0, { props: props(CAP.propKeys) })).success).toBe(true);
    expect(AnalyticsEventSchema.safeParse(ev(0, { props: props(CAP.propKeys + 1) })).success).toBe(false);
  });
  it('rejects 500k bad-valued props fast with bounded issues', () => {
    const bad = Object.fromEntries(Array.from({ length: 500_000 }, (_, i) => [`k${i}`, null]));
    const t0 = performance.now();
    const r = AnalyticsEventSchema.safeParse(ev(0, { props: bad }));
    expect(r.success).toBe(false);
    expect(issuesOf(r as never)).toBeLessThanOrEqual(CAP.maxIssues);
    expect(performance.now() - t0).toBeLessThan(250);
  });
  it('bounds prop key length and string value length', () => {
    const p = (o: Record<string, unknown>) => AnalyticsEventSchema.safeParse(ev(0, { props: o })).success;
    expect(p({ ['k'.repeat(CAP.propKeyLen)]: 1 })).toBe(true);
    expect(p({ ['k'.repeat(CAP.propKeyLen + 1)]: 1 })).toBe(false);
    expect(p({ a: 's'.repeat(CAP.propStrLen) })).toBe(true);
    expect(p({ a: 's'.repeat(CAP.propStrLen + 1) })).toBe(false);
  });
});

describe('scalar caps', () => {
  it('bounds identifier-like strings at 256 (event/product/module/dedupe_key/entity_id/actor/session_id)', () => {
    for (const f of ['product', 'module', 'dedupe_key', 'entity_id', 'actor', 'session_id']) {
      expect(AnalyticsEventSchema.safeParse(ev(0, { [f]: 'x'.repeat(CAP.idLike) })).success, `${f} at cap`).toBe(true);
      expect(AnalyticsEventSchema.safeParse(ev(0, { [f]: 'x'.repeat(CAP.idLike + 1) })).success, `${f} cap+1`).toBe(false);
    }
    const long = `a.${'b'.repeat(200)}`;
    expect(AnalyticsEventSchema.safeParse(ev(0, { event: long })).success).toBe(false); // event cap 128
  });
  it('bounds health product/module/instance/version at 256', () => {
    for (const f of ['product', 'module', 'instance', 'version']) {
      expect(HealthReportSchema.safeParse(health({ [f]: 'x'.repeat(CAP.idLike) })).success, `${f} at cap`).toBe(true);
      expect(HealthReportSchema.safeParse(health({ [f]: 'x'.repeat(CAP.idLike + 1) })).success, `${f} cap+1`).toBe(false);
    }
  });
  it('bounds ttl_seconds at 30 days (observed legit max: 8.04 days)', () => {
    expect(HealthReportSchema.safeParse(health({ ttl_seconds: 694_800 })).success).toBe(true);
    expect(HealthReportSchema.safeParse(health({ ttl_seconds: CAP.ttl })).success).toBe(true);
    expect(HealthReportSchema.safeParse(health({ ttl_seconds: CAP.ttl + 1 })).success).toBe(false);
  });
});

describe('client behaviour at the caps', () => {
  const cfg = { product: 'billing', module: 'payments', version: 'v', autoStart: false as const };
  it('track() drops (and counts) an event whose props exceed the cap instead of buffering it', async () => {
    const calls: unknown[] = [];
    const tx: Transport = { async send(_p, b) { calls.push(b); } };
    const t = createTelemetry({ ...cfg, transport: tx, batchSize: 10_000 });
    const big = Object.fromEntries(Array.from({ length: CAP.propKeys + 1 }, (_, i) => [`k${i}`, i]));
    t.track({ event: 'invoice.created', props: big });
    await t.flush();
    expect(calls.length).toBe(0);
    expect(t.counters.events_dropped).toBeGreaterThan(0);
  });
  it('flush() never sends more than the batch cap in one request, even with a large maxBufferedEvents', async () => {
    const sizes: number[] = [];
    const tx: Transport = { async send(_p, b) { sizes.push((b as unknown[]).length); } };
    const t = createTelemetry({ ...cfg, transport: tx, batchSize: 100_000, batchIntervalMs: 0, maxBufferedEvents: 5000 });
    for (let i = 0; i < 2500; i++) t.track({ event: 'invoice.created', key: `k${i}` });
    await t.flush();
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(2500); // nothing lost
    expect(Math.max(...sizes)).toBeLessThanOrEqual(CAP.batch);
  });
});
