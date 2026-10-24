import { describe, it, expect, vi } from 'vitest';
import {
  HealthReportSchema,
  AnalyticsEventSchema,
  AnalyticsBatchSchema,
  createTelemetry,
  truncateDetail,
  parseLimitsMode,
  LIMITS,
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

describe('client truncates oversize check detail (never drops the report)', () => {
  it('sends the report with detail truncated to the cap and a marker', async () => {
    const sent: any[] = [];
    const tx: Transport = { async send(_p, b) { sent.push(b); } };
    const t = createTelemetry({ product: 'billing', module: 'payments', version: 'v', autoStart: false, transport: tx });
    await t.reportHealth({ status: 'ok', checks: [{ id: 'a', status: 'pass', detail: 'x'.repeat(CAP.checkDetail * 2) }] });
    expect(sent.length).toBe(1);
    const d = sent[0].checks[0].detail as string;
    expect(d.length).toBe(CAP.checkDetail);
    expect(d.endsWith('[truncated]')).toBe(true);
    expect(t.counters.health_dropped).toBe(0);
  });
  it('leaves in-cap detail untouched', () => {
    expect(truncateDetail('abc')).toBe('abc');
    const exact = 'y'.repeat(CAP.checkDetail);
    expect(truncateDetail(exact)).toBe(exact);
  });
});

describe('parseLimitsMode', () => {
  it('defaults to shadow; honours enforce/off/shadow', () => {
    expect(parseLimitsMode(undefined)).toBe('shadow');
    expect(parseLimitsMode('garbage')).toBe('shadow');
    expect(parseLimitsMode('')).toBe('shadow');
    expect(parseLimitsMode('enforce')).toBe('enforce');
    expect(parseLimitsMode('off')).toBe('off');
    expect(parseLimitsMode('shadow')).toBe('shadow');
  });
  it('exports LIMITS matching the contract', () => {
    expect(LIMITS.batch).toBe(CAP.batch);
    expect(LIMITS.ttlSeconds).toBe(CAP.ttl);
    expect(LIMITS.analyticsBodyBytes).toBe(1_048_576);
  });
});

describe('review fixes', () => {
  const cfg = { product: 'billing', module: 'payments', version: 'v', autoStart: false as const };
  it('reportHealth with exactly LIMITS.checks user checks still sends (slot reserved)', async () => {
    const sent: any[] = [];
    const tx: Transport = { async send(_p, b) { sent.push(b); } };
    const t = createTelemetry({ ...cfg, transport: tx });
    await t.reportHealth({ status: 'ok', checks: Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, status: 'pass' as const })) });
    expect(sent.length).toBe(1);
    expect(sent[0].checks.length).toBe(50);
    expect(sent[0].checks.some((c: any) => c.id === 'c49')).toBe(false); // 50th user check dropped
    expect(t.counters.dropped).toBe(1);
    expect(t.counters.health_dropped).toBe(0);
  });
  it('shrinks detail so the health body fits 32 KiB', async () => {
    const sent: any[] = [];
    const tx: Transport = { async send(_p, b) { sent.push(b); } };
    const t = createTelemetry({ ...cfg, transport: tx });
    await t.reportHealth({ status: 'ok', checks: Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, status: 'pass' as const, detail: 'x'.repeat(16000) })) });
    expect(sent.length).toBe(1);
    expect(JSON.stringify(sent[0]).length).toBeLessThanOrEqual(LIMITS.healthBodyBytes);
  });
  it('splits analytics chunks by bytes (1 MiB body cap)', async () => {
    const bytes: number[] = [];
    const tx: Transport = { async send(_p, b) { bytes.push(JSON.stringify(b).length); } };
    const t = createTelemetry({ ...cfg, transport: tx, batchSize: 100_000, batchIntervalMs: 0, maxBufferedEvents: 5000 });
    for (let i = 0; i < 600; i++) t.track({ event: 'invoice.created', key: `k${i}`, props: { a: 's'.repeat(1000), b: 's'.repeat(1000) } });
    await t.flush();
    expect(Math.max(...bytes)).toBeLessThanOrEqual(LIMITS.analyticsBodyBytes);
    expect(bytes.length).toBeGreaterThan(1);
  });
  it('concurrent flushes join one loop (no reordering)', async () => {
    let inFlight = 0, maxInFlight = 0;
    const tx: Transport = { async send() { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; } };
    const t = createTelemetry({ ...cfg, transport: tx, batchSize: 100_000, batchIntervalMs: 0, maxBufferedEvents: 5000 });
    for (let i = 0; i < 2500; i++) t.track({ event: 'invoice.created', key: `k${i}` });
    await Promise.all([t.flush(), t.flush(), t.flush()]);
    expect(maxInFlight).toBe(1);
    expect(t.counters.events_sent).toBe(2500);
  });
  it('truncateDetail clamps tiny max', () => {
    expect(truncateDetail('x'.repeat(100), 5).length).toBe(5);
    expect(truncateDetail('x'.repeat(100), 0)).toBe('');
  });
});

describe('delta-review fixes', () => {
  const cfg = { product: 'billing', module: 'payments', version: 'v', autoStart: false as const };
  it('trimmed-check count is NOT re-added by heartbeats', async () => {
    const sent: any[] = [];
    const tx: Transport = { async send(_p, b) { sent.push(b); } };
    vi.useFakeTimers();
    try {
      const t = createTelemetry({ ...cfg, transport: tx, heartbeatMs: 1000, autoStart: true });
      await t.reportHealth({ status: 'ok', checks: Array.from({ length: 52 }, (_, i) => ({ id: `c${i}`, status: 'pass' as const })) });
      expect(t.counters.dropped).toBe(3);
      await vi.advanceTimersByTimeAsync(3500);
      t.stop();
      expect(sent.length).toBeGreaterThan(1); // heartbeats really fired
      expect(t.counters.dropped).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it('one over-cap check drops only that check, report still sent', async () => {
    const sent: any[] = [];
    const tx: Transport = { async send(_p, b) { sent.push(b); } };
    const t = createTelemetry({ ...cfg, transport: tx });
    await t.reportHealth({ status: 'ok', checks: [
      { id: 'ok1', status: 'pass' },
      { id: 'x'.repeat(257), status: 'pass' },
      { id: 'badunit', status: 'pass', unit: 'u'.repeat(33) },
    ] });
    expect(sent.length).toBe(1);
    expect(sent[0].checks.map((c: any) => c.id)).toEqual(['ok1', 'telemetry.dropped', 'telemetry.clamped']);
    expect(t.counters.dropped).toBe(2);
    expect(t.counters.health_dropped).toBe(0);
  });
  it('truncateDetail never leaves a lone high surrogate', () => {
    const s = 'a'.repeat(100 - 14 - 1) + '\u{1F600}' + 'z'.repeat(50);
    const out = truncateDetail(s, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(out)).toBe(false);
  });
});

describe('clamp instead of dropping the whole report', () => {
  const cfg = { product: 'billing', module: 'payments', version: 'v', autoStart: false as const };
  it('clamps caller ttl_seconds, version and instance; report still sent; health_clamped counted once', async () => {
    const sent: any[] = [];
    const tx: Transport = { async send(_p, b) { sent.push(b); } };
    const t = createTelemetry({ ...cfg, transport: tx });
    await t.reportHealth({ status: 'ok', ttl_seconds: CAP.ttl * 2, version: 'v'.repeat(300), instance: 'i'.repeat(300) });
    expect(sent.length).toBe(1);
    expect(sent[0].ttl_seconds).toBe(CAP.ttl);
    expect(sent[0].version.length).toBe(256);
    expect(sent[0].instance.length).toBe(256);
    expect(t.counters.health_dropped).toBe(0);
    expect(t.counters.health_clamped).toBe(3);
  });
});

describe('0.7.1 follow-ups (tasks.db #2492)', () => {
  const cfg = { product: 'billing', module: 'payments', version: 'v', autoStart: false as const };
  const mk = (over: Record<string, unknown> = {}) => {
    const sent: any[] = [];
    const warns: string[] = [];
    const tx: Transport = { async send(_p, b) { sent.push(b); } };
    const t = createTelemetry({ ...cfg, transport: tx, onWarn: (m) => warns.push(m), ...over });
    return { t, sent, warns };
  };
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, status: 'pass' as const }));

  it('(1) trimmed/clamped are NOT counted by suppressed reportHealth calls', async () => {
    const { t, sent } = mk();
    await t.reportHealth({ status: 'ok', checks: many(52) });
    expect(t.counters.dropped).toBe(3);
    await t.reportHealth({ status: 'ok', checks: many(52), version: 'v'.repeat(300) }); // suppressed (same status)
    await t.reportHealth({ status: 'ok', checks: many(52), version: 'v'.repeat(300) }); // suppressed
    expect(sent.length).toBe(1);
    expect(t.counters.health_suppressed).toBe(2);
    expect(t.counters.dropped).toBe(3);
    expect(t.counters.health_clamped).toBe(0);
  });

  it('(2) one schema-invalid check (bad status / non-string detail / extra key) is dropped alone', async () => {
    const { t, sent } = mk();
    await t.reportHealth({ status: 'ok', checks: [
      { id: 'good', status: 'pass' },
      { id: 'badstatus', status: 'bogus' as any },
      { id: 'baddetail', status: 'pass', detail: 123 as any },
      { id: 'extra', status: 'pass', foo: 1 } as any,
      null as any,
    ] });
    expect(sent.length).toBe(1);
    expect(sent[0].checks.map((c: any) => c.id)).toEqual(['good', 'telemetry.dropped', 'telemetry.clamped']);
    expect(t.counters.health_dropped).toBe(0);
    expect(t.counters.dropped).toBe(4);
  });

  it('(3) ttl_seconds <=0 / float / NaN / Infinity clamps to the default, report still sent', async () => {
    for (const bad of [0, -5, 1.5, NaN, Infinity]) {
      const { t, sent } = mk({ ttlSeconds: 120 });
      await t.reportHealth({ status: 'ok', ttl_seconds: bad });
      expect(sent.length).toBe(1);
      expect(sent[0].ttl_seconds).toBe(120);
      expect(t.counters.health_dropped).toBe(0);
      expect(t.counters.health_clamped).toBe(1);
    }
  });

  it('(4) clamps/trims are self-reported as a telemetry.clamped check and via onWarn', async () => {
    const { t, sent, warns } = mk();
    await t.reportHealth({ status: 'ok', ttl_seconds: -1, checks: [{ id: 'a', status: 'pass' }, { id: 'b', status: 'x' as any }] });
    const c = sent[0].checks.find((x: any) => x.id === 'telemetry.clamped');
    expect(c).toBeTruthy();
    expect(c.status).toBe('warn');
    expect(c.metric).toBe(1);
    expect(c.detail).toMatch(/trimmed 1/);
    expect(warns.some((w) => /clamped|trimmed/.test(w))).toBe(true);
    expect(t.counters.health_trimmed).toBe(1);
    // clean report: no telemetry.clamped noise once nothing new... (cumulative stays visible)
    const clean = mk();
    await clean.t.reportHealth({ status: 'ok' });
    expect(clean.sent[0].checks.map((x: any) => x.id)).toEqual(['telemetry.dropped']);
  });

  it('(4b) never evicts user checks to make room for telemetry.clamped; stays within the cap', async () => {
    const { t, sent } = mk();
    await t.reportHealth({ status: 'ok', ttl_seconds: -1, checks: many(49) });
    expect(sent[0].checks.length).toBeLessThanOrEqual(50);
    expect(HealthReportSchema.safeParse(sent[0]).success).toBe(true);
  });

  it('(5) config.version / config.instance / config.ttlSeconds are clamped once at creation', async () => {
    const { t, sent, warns } = mk({ version: 'v'.repeat(300), instance: 'i'.repeat(300), ttlSeconds: -3 });
    expect(t.counters.health_clamped).toBe(3);
    expect(warns.length).toBeGreaterThan(0);
    await t.reportHealth({ status: 'ok' });
    await t.reportHealth({ status: 'degraded' });
    expect(sent.length).toBe(2);
    expect(sent[0].version.length).toBe(256);
    expect(sent[0].instance.length).toBe(256);
    expect(sent[0].ttl_seconds).toBeGreaterThan(0);
    expect(t.counters.health_clamped).toBe(3); // not re-counted per call
  });
});
