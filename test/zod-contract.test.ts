import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  HealthReportSchema,
  AnalyticsEventSchema,
  AnalyticsBatchSchema,
  createTelemetry,
} from '../src/index.js';

/**
 * Pins zod behaviours that the wire format depends on, so a zod major bump cannot
 * silently change which payloads the client emits or the ingest accepts.
 * (Added with the zod 3 -> 4.6.6+ bump for GHSA-mrhx-c7xc-m3w5.)
 */

const require_ = createRequire(import.meta.url);
const health = {
  schema_version: 1,
  product: 'billing',
  module: 'payments',
  status: 'ok',
  checks: [],
  version: 'abc123',
  ts: '2026-06-29T00:00:00.000Z',
  ttl_seconds: 90,
};
const event = {
  schema_version: 1,
  event: 'invoice.created',
  product: 'billing',
  module: 'payments',
  props: {},
  ts: '2026-06-29T00:00:00.000Z',
  dedupe_key: 'k1',
};

describe('zod version floor (GHSA-mrhx-c7xc-m3w5)', () => {
  const atLeast = (v: string, floor: number[]) => {
    const p = v.split('.').map((n) => parseInt(n, 10));
    for (let i = 0; i < 3; i++) {
      if (p[i] !== floor[i]) return p[i] > floor[i];
    }
    return true;
  };
  it('package.json declares zod >=4.6.6', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const range: string = pkg.dependencies.zod;
    const m = range.match(/(\d+)\.(\d+)\.(\d+)/);
    expect(m, `unparseable zod range ${range}`).not.toBeNull();
    expect(atLeast(`${m![1]}.${m![2]}.${m![3]}`, [4, 6, 6])).toBe(true);
  });
  it('installed zod resolves to >=4.6.6', () => {
    const v: string = require_('zod/package.json').version;
    expect(atLeast(v, [4, 6, 6])).toBe(true);
  });
  it('pnpm-lock.yaml resolves exactly one zod, >=4.6.6', () => {
    const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
    const vers = [...new Set([...lock.matchAll(/^\s{2}zod@(\d+\.\d+\.\d+):/gm)].map((m) => m[1]))];
    expect(vers.length).toBe(1);
    expect(atLeast(vers[0]!, [4, 6, 6])).toBe(true);
  });
});

describe('ts: datetime({offset:true}) — every timestamp the client emits is accepted', () => {
  const ok = [
    new Date(0).toISOString(),
    new Date('2026-10-23T12:34:56.789Z').toISOString(),
    '2026-06-29T00:00:00Z',
    '2026-06-29T05:30:00+05:30',
    '2026-06-29T05:30:00.5-08:00',
  ];
  const bad = [
    '2026-06-29T00:00:00', // no offset
    '2026-06-29',
    '2026-06-29 00:00:00Z', // space separator
    '2026-02-30T00:00:00Z', // impossible date
    '2026-06-29T24:00:00Z',
    '2026-06-29T00:00:00z', // lower-case z
    ' 2026-06-29T00:00:00Z',
    '2026-06-29T05:30:00+05', // hour-only offset
    // zod 3 accepted the next two; zod 4 is stricter (documented difference).
    '2026-06-29T05:30:00+0530', // offset without colon
    '2026-06-29T00:00Z', // no seconds
    'not-a-date',
    '',
  ];
  for (const ts of ok) {
    it(`accepts ${ts}`, () => {
      expect(HealthReportSchema.safeParse({ ...health, ts }).success).toBe(true);
      expect(AnalyticsEventSchema.safeParse({ ...event, ts }).success).toBe(true);
    });
  }
  for (const ts of bad) {
    it(`rejects ${JSON.stringify(ts)}`, () => {
      expect(HealthReportSchema.safeParse({ ...health, ts }).success).toBe(false);
      expect(AnalyticsEventSchema.safeParse({ ...event, ts }).success).toBe(false);
    });
  }
});

describe('strict / optional / record semantics', () => {
  it('strict rejects unknown keys with an unrecognized_keys issue', () => {
    const r = HealthReportSchema.safeParse({ ...health, extra: 1 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.code)).toContain('unrecognized_keys');
  });
  it('strict applies to nested checks', () => {
    const r = HealthReportSchema.safeParse({
      ...health,
      checks: [{ id: 'a', status: 'pass', bogus: 1 }],
    });
    expect(r.success).toBe(false);
  });
  it('optional fields accept absent and explicit undefined, reject null', () => {
    expect(AnalyticsEventSchema.safeParse(event).success).toBe(true);
    expect(AnalyticsEventSchema.safeParse({ ...event, actor: undefined }).success).toBe(true);
    expect(AnalyticsEventSchema.safeParse({ ...event, actor: null }).success).toBe(false);
    expect(HealthReportSchema.safeParse({ ...health, score: null }).success).toBe(false);
  });
  it('parse output omits absent optionals and does not inject defaults', () => {
    const r = AnalyticsEventSchema.parse(event);
    expect(Object.keys(r).sort()).toEqual(Object.keys(event).sort());
  });
  it('props record(string, string|number|boolean): accepts scalars, rejects null/array/undefined/nested', () => {
    expect(AnalyticsEventSchema.safeParse({ ...event, props: { a: 1, b: 'x', c: false } }).success).toBe(true);
    for (const v of [null, [1], undefined, { n: 1 }]) {
      expect(AnalyticsEventSchema.safeParse({ ...event, props: { a: v } }).success).toBe(false);
    }
    expect(AnalyticsEventSchema.safeParse({ ...event, props: [] }).success).toBe(false);
    expect(AnalyticsEventSchema.safeParse({ ...event, props: null }).success).toBe(false);
    expect(AnalyticsEventSchema.safeParse({ ...event, props: undefined }).success).toBe(false);
  });
  it('union props reject the whole event with an issue at props.<key>', () => {
    const r = AnalyticsEventSchema.safeParse({ ...event, props: { bad: null } });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path[0] === 'props')).toBe(true);
  });
  it('literal schema_version only accepts numeric 1', () => {
    for (const v of ['1', 2, 0, null, undefined]) {
      expect(HealthReportSchema.safeParse({ ...health, schema_version: v }).success).toBe(false);
    }
  });
  it('empty strings fail min(1) fields', () => {
    for (const k of ['product', 'module', 'version'] as const) {
      expect(HealthReportSchema.safeParse({ ...health, [k]: '' }).success).toBe(false);
    }
    expect(AnalyticsEventSchema.safeParse({ ...event, dedupe_key: '' }).success).toBe(false);
  });
  it('event regex: valid names accepted, invalid rejected', () => {
    for (const e of ['a.b', 'invoice.created', 'a_b.c_d.e1']) {
      expect(AnalyticsEventSchema.safeParse({ ...event, event: e }).success).toBe(true);
    }
    for (const e of ['a', 'A.b', '1a.b', 'a.', '.a', 'a..b', 'a.B']) {
      expect(AnalyticsEventSchema.safeParse({ ...event, event: e }).success).toBe(false);
    }
  });
});

describe('numeric edge cases (zod 4 is stricter: documented difference)', () => {
  it('score bounds are inclusive 0..100', () => {
    for (const s of [0, 100, 55.5]) expect(HealthReportSchema.safeParse({ ...health, score: s }).success).toBe(true);
    for (const s of [-0.1, 100.1]) expect(HealthReportSchema.safeParse({ ...health, score: s }).success).toBe(false);
  });
  it('non-finite numbers are rejected (zod 3 let Infinity through for metric/props)', () => {
    const chk = (metric: number) => ({ ...health, checks: [{ id: 'a', status: 'pass', metric }] });
    expect(HealthReportSchema.safeParse(chk(Infinity)).success).toBe(false);
    expect(HealthReportSchema.safeParse(chk(NaN)).success).toBe(false);
    expect(AnalyticsEventSchema.safeParse({ ...event, props: { n: Infinity } }).success).toBe(false);
    expect(AnalyticsEventSchema.safeParse({ ...event, props: { n: NaN } }).success).toBe(false);
  });
  it('ttl_seconds must be a positive safe integer', () => {
    for (const t of [1, 90, 86400]) expect(HealthReportSchema.safeParse({ ...health, ttl_seconds: t }).success).toBe(true);
    for (const t of [0, -1, 1.5, 2 ** 53, 1e300]) {
      expect(HealthReportSchema.safeParse({ ...health, ttl_seconds: t }).success).toBe(false);
    }
  });
});

describe('golden payloads (wire shape)', () => {
  it('realistic health report', () => {
    const golden = {
      schema_version: 1,
      product: 'ledger-app',
      module: 'importer',
      instance: 'pc-server',
      status: 'degraded',
      score: 72.5,
      checks: [
        { id: 'db.ping', status: 'pass', detail: 'ok', metric: 4, unit: 'ms' },
        { id: 'queue.depth', status: 'warn', metric: 1400, unit: 'items' },
        { id: 'smtp', status: 'fail', detail: 'ECONNREFUSED' },
      ],
      version: '7b068b4',
      ts: '2026-10-23T08:30:00.123Z',
      ttl_seconds: 300,
    };
    const r = HealthReportSchema.parse(golden);
    expect(r).toEqual(golden);
  });
  it('analytics wire body is a bare ARRAY of events; envelope object is rejected', () => {
    const batch = [
      { ...event, entity_type: 'invoice', entity_id: 'inv_1', actor: 'deadbeef', session_id: 's1',
        props: { amount: 1200, currency: 'usd', test: true } },
      { ...event, event: 'payment.recorded', dedupe_key: 'k2', props: { amount_cents: 500 } },
    ];
    expect(AnalyticsBatchSchema.parse(batch)).toEqual(batch);
    expect(AnalyticsBatchSchema.safeParse({ events: batch }).success).toBe(false);
    expect(AnalyticsBatchSchema.safeParse([]).success).toBe(false);
    expect(AnalyticsBatchSchema.safeParse([batch[0], { ...batch[1], id: 'x' }]).success).toBe(false);
  });
  it('client-produced payloads (sent through a fake transport) validate against the real schemas', async () => {
    const sent: { path: string; body: unknown }[] = [];
    const t = createTelemetry({
      product: 'ledger-app',
      module: 'importer',
      version: '1.2.3',
      autoStart: false,
      transport: { async send(path, body) { sent.push({ path, body: structuredClone(body) }); } },
    });
    t.track({ event: 'invoice.created', props: { amount: 12, ok: true, c: 'usd' } });
    await t.reportHealth({ status: 'ok', checks: [{ id: 'db', status: 'pass', metric: 3, unit: 'ms' }] });
    await t.flush();
    const h = sent.find((s) => s.path.includes('health'));
    const a = sent.find((s) => s.path.includes('analytics'));
    expect(h, 'health payload sent').toBeTruthy();
    expect(a, 'analytics payload sent').toBeTruthy();
    expect(HealthReportSchema.safeParse(h!.body).success).toBe(true);
    expect(Array.isArray(a!.body)).toBe(true);
    expect(AnalyticsBatchSchema.safeParse(a!.body).success).toBe(true);
  });
});
