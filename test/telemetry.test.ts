import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTelemetry, type Transport, type AnalyticsEvent } from '../src/index.js';

interface Recorded {
  path: string;
  body: any;
}

function recordingTransport(): Transport & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    async send(path, body) {
      calls.push({ path, body: structuredClone(body) });
    },
  };
}

/** Analytics sends a bare array body (no envelope) — pull it out of the recorded calls. */
function sentEvents(tx: { calls: Recorded[] }): AnalyticsEvent[] {
  return tx.calls.filter((c) => c.path === '/ingest/analytics').flatMap((c) => c.body as AnalyticsEvent[]);
}

const baseConfig = {
  product: 'billing',
  module: 'payments',
  version: 'sha-abc',
  autoStart: false as const,
};

describe('reportHealth', () => {
  it('auto-fills ts + schema_version and sends a schema-valid report', async () => {
    const tx = recordingTransport();
    const t = createTelemetry({ ...baseConfig, transport: tx, now: () => 1_700_000_000_000 });
    await t.reportHealth({ status: 'ok', checks: [{ id: 'db', status: 'pass' }] });

    expect(tx.calls).toHaveLength(1);
    expect(tx.calls[0]!.path).toBe('/ingest/health');
    const r = tx.calls[0]!.body;
    expect(r.schema_version).toBe(1);
    expect(r.product).toBe('billing');
    expect(r.module).toBe('payments');
    expect(r.status).toBe('ok');
    expect(typeof r.ts).toBe('string');
    expect(r.ts).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('emits immediately on a status change but not on a repeat of the same status', async () => {
    const tx = recordingTransport();
    const t = createTelemetry({ ...baseConfig, transport: tx });

    await t.reportHealth({ status: 'ok' }); // first -> send (1)
    await t.reportHealth({ status: 'ok' }); // same -> no send
    await t.reportHealth({ status: 'degraded' }); // change -> send (2)

    expect(tx.calls).toHaveLength(2);
    expect(tx.calls[0]!.body.status).toBe('ok');
    expect(tx.calls[1]!.body.status).toBe('degraded');
  });

  it('force-resends once forceResendMs elapses even with no status change, driven purely by explicit reportHealth() calls — no timer', async () => {
    const tx = recordingTransport();
    let clock = 1_700_000_000_000;
    const t = createTelemetry({
      ...baseConfig,
      transport: tx,
      now: () => clock,
      forceResendMs: 5_000,
    });

    await t.reportHealth({ status: 'ok' }); // 1: first send
    clock += 2_000;
    await t.reportHealth({ status: 'ok' }); // same status, only 2s elapsed -> no send
    clock += 4_000; // 6s elapsed since last send, past forceResendMs
    await t.reportHealth({ status: 'ok' }); // 2: forced resend

    expect(tx.calls).toHaveLength(2);
    expect(tx.calls[0]!.body.status).toBe('ok');
    expect(tx.calls[1]!.body.status).toBe('ok');
  });

  it('defaults forceResendMs to half the effective ttlSeconds, so a traffic-driven caller can never silently exceed its own ttl', async () => {
    const tx = recordingTransport();
    let clock = 1_700_000_000_000;
    const t = createTelemetry({ ...baseConfig, transport: tx, now: () => clock, ttlSeconds: 100 });

    await t.reportHealth({ status: 'ok' }); // 1
    clock += 49_000; // under half of ttlSeconds (50s) -> no send
    await t.reportHealth({ status: 'ok' });
    clock += 2_000; // 51s elapsed -> past the default forceResendMs
    await t.reportHealth({ status: 'ok' }); // 2: forced resend

    expect(tx.calls).toHaveLength(2);
  });

  it('forceResendMs: 0 disables forced resend, restoring pure change-only behavior', async () => {
    const tx = recordingTransport();
    let clock = 1_700_000_000_000;
    const t = createTelemetry({ ...baseConfig, transport: tx, now: () => clock, forceResendMs: 0 });

    await t.reportHealth({ status: 'ok' });
    clock += 10_000_000; // far past any reasonable ttl
    await t.reportHealth({ status: 'ok' });

    expect(tx.calls).toHaveLength(1);
  });

  it('sends on the heartbeat interval as well as on change', async () => {
    vi.useFakeTimers();
    try {
      const tx = recordingTransport();
      const t = createTelemetry({
        ...baseConfig,
        autoStart: true,
        heartbeatMs: 1000,
        transport: tx,
      });
      await t.reportHealth({ status: 'ok' }); // immediate (1)
      await vi.advanceTimersByTimeAsync(3500); // ~3 heartbeats
      t.stop();
      expect(tx.calls.length).toBeGreaterThanOrEqual(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is non-blocking and bumps telemetry.dropped when the transport fails', async () => {
    const failing: Transport = {
      async send() {
        throw new Error('network down');
      },
    };
    const t = createTelemetry({ ...baseConfig, transport: failing });
    await expect(t.reportHealth({ status: 'ok' })).resolves.toBeUndefined();
    expect(t.counters.dropped).toBeGreaterThanOrEqual(1);
    expect(t.counters.health_dropped).toBeGreaterThanOrEqual(1);
  });

  it('drops an off-schema report instead of sending it', async () => {
    const tx = recordingTransport();
    const t = createTelemetry({ ...baseConfig, transport: tx });
    // @ts-expect-error deliberately invalid status
    await t.reportHealth({ status: 'exploded' });
    expect(tx.calls).toHaveLength(0);
    expect(t.counters.dropped).toBeGreaterThanOrEqual(1);
  });

  it('surfaces the telemetry.dropped counter as a health check', async () => {
    // analytics ingest fails, health ingest succeeds
    const calls: Recorded[] = [];
    const splitTx: Transport = {
      async send(path, body) {
        if (path === '/ingest/analytics') throw new Error('analytics sink down');
        calls.push({ path, body: structuredClone(body) });
      },
    };
    const t = createTelemetry({ ...baseConfig, transport: splitTx });
    t.track({ event: 'invoice.created', props: { n: 1 } });
    await t.flush(); // fails -> dropped++
    await t.reportHealth({ status: 'ok' }); // health send succeeds

    const lastHealth = calls.at(-1)!.body;
    const droppedCheck = lastHealth.checks.find((c: any) => c.id === 'telemetry.dropped');
    expect(droppedCheck).toBeTruthy();
    expect(droppedCheck.metric).toBeGreaterThanOrEqual(1);
    expect(droppedCheck.status).toBe('warn');
  });
});

describe('track', () => {
  it('auto-fills identity + ts, validates, and batches by size — wire body is a bare array', async () => {
    const tx = recordingTransport();
    const t = createTelemetry({ ...baseConfig, transport: tx, batchSize: 2 });
    t.track({ event: 'invoice.created', props: { n: 1 } });
    expect(tx.calls).toHaveLength(0); // batched, not yet flushed
    t.track({ event: 'payment.recorded', props: { n: 2 } });
    // size threshold reached -> flush scheduled
    await Promise.resolve();
    await t.flush();

    expect(tx.calls).toHaveLength(1);
    expect(Array.isArray(tx.calls[0]!.body)).toBe(true); // no {events: [...]} envelope
    const sent = sentEvents(tx);
    expect(sent.length).toBe(2);
    expect(sent[0]!.product).toBe('billing');
    expect(sent[0]!.schema_version).toBe(1);
    expect(typeof sent[0]!.dedupe_key).toBe('string');
    expect(sent[0]!.dedupe_key.length).toBeGreaterThan(0);
  });

  it('does not throw and bumps dropped when a batch flush fails', async () => {
    const failing: Transport = {
      async send() {
        throw new Error('sink down');
      },
    };
    const t = createTelemetry({ ...baseConfig, transport: failing });
    expect(() => t.track({ event: 'invoice.created', props: { n: 1 } })).not.toThrow();
    await expect(t.flush()).resolves.toBeUndefined();
    expect(t.counters.dropped).toBeGreaterThanOrEqual(1);
  });

  it('drops an off-schema event (non-dotted name) without sending', async () => {
    const tx = recordingTransport();
    const t = createTelemetry({ ...baseConfig, transport: tx });
    t.track({ event: 'notdotted', props: { n: 1 } });
    await t.flush();
    expect(tx.calls).toHaveLength(0);
    expect(t.counters.events_dropped).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent: the same dedupe key is only buffered once', async () => {
    const tx = recordingTransport();
    const t = createTelemetry({ ...baseConfig, transport: tx });
    t.track({ event: 'invoice.created', props: { n: 1 }, key: 'inv-1' });
    t.track({ event: 'invoice.created', props: { n: 1 }, key: 'inv-1' });
    await t.flush();
    const sent = sentEvents(tx);
    expect(sent.length).toBe(1);
    expect(sent[0]!.dedupe_key).toBe('inv-1');
    expect(t.counters.events_deduped).toBe(1);
  });

  it('never grows the buffer past maxBufferedEvents while the sink is down — oldest dropped, newest kept', async () => {
    let down = true;
    const delivered: AnalyticsEvent[][] = [];
    const tx: Transport = {
      async send(_path, body) {
        if (down) throw new Error('sink down');
        delivered.push(body as AnalyticsEvent[]);
      },
    };
    // batchSize high enough that nothing auto-flushes; cap at 50.
    const t = createTelemetry({ ...baseConfig, transport: tx, batchSize: 10_000, maxBufferedEvents: 50 });
    for (let i = 0; i < 60; i++) {
      t.track({ event: 'cap.test', props: { i }, key: `cap-${i}` });
    }
    await t.flush(); // fails -> requeues, still capped
    down = false;
    await t.flush();

    expect(delivered).toHaveLength(1);
    const batch = delivered[0]!;
    expect(batch).toHaveLength(50);
    // Oldest 10 were dropped at the cap; newest survive in order.
    expect(batch[0]!.dedupe_key).toBe('cap-10');
    expect(batch[49]!.dedupe_key).toBe('cap-59');
    // The 10 overflow drops are counted as real drops.
    expect(t.counters.events_dropped).toBeGreaterThanOrEqual(10);
  });

  it('stays capped across repeated failed flushes with continued tracking', async () => {
    let down = true;
    const delivered: AnalyticsEvent[][] = [];
    const tx: Transport = {
      async send(_path, body) {
        if (down) throw new Error('sink down');
        delivered.push(body as AnalyticsEvent[]);
      },
    };
    const t = createTelemetry({ ...baseConfig, transport: tx, batchSize: 10_000, maxBufferedEvents: 50 });
    for (let i = 0; i < 40; i++) t.track({ event: 'cap.test', props: { i }, key: `a-${i}` });
    await t.flush(); // fails -> 40 requeued
    for (let i = 0; i < 20; i++) t.track({ event: 'cap.test', props: { i }, key: `b-${i}` });
    await t.flush(); // fails -> 60 would requeue; cap trims to 50
    down = false;
    await t.flush();

    const batch = delivered[0]!;
    expect(batch).toHaveLength(50);
    // The 10 oldest (a-0..a-9) fell off; the newest 20 all survive.
    expect(batch[0]!.dedupe_key).toBe('a-10');
    expect(batch[49]!.dedupe_key).toBe('b-19');
  });

  it('survives a flaky transport: retry resends the same dedupe_key, never duplicating', async () => {
    let attempt = 0;
    const sent: AnalyticsEvent[][] = [];
    const flaky: Transport = {
      async send(_path, body) {
        attempt++;
        if (attempt === 1) throw new Error('transient');
        sent.push(body as AnalyticsEvent[]);
      },
    };
    const t = createTelemetry({ ...baseConfig, transport: flaky });
    t.track({ event: 'invoice.created', props: { n: 1 }, key: 'inv-9' });
    await t.flush(); // fails, requeues
    await t.flush(); // succeeds
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(1);
    expect(sent[0]![0]!.dedupe_key).toBe('inv-9');
    expect(t.counters.events_sent).toBe(1);
  });
});

// 2026-08-06 — a fire-and-forget `void telemetry.reportHealth(...)` call site has no completion
// guarantee once a serverless response flushes (Vercel Fluid Compute ships `waitUntil`/`after`
// specifically because unawaited work is NOT otherwise kept alive). Live-repro'd on pagewright's
// collect:staging: 4 of 5 sequential real requests silently failed to send a health report — no
// ingest row, no health_dropped bump, i.e. execution was cut off before sendHealth's try/catch
// even ran. `keepAlive` lets a product hand the library's in-flight promise to the platform's own
// keep-alive primitive, closing the gap for every call site (including the library's own internal
// fire-and-forget spots) without requiring any product to change how it calls reportHealth/flush.
describe('keepAlive', () => {
  it('hands reportHealth a promise to keepAlive synchronously, so a void-called send still completes once the platform awaits it', async () => {
    const tx = recordingTransport();
    const registered: Promise<unknown>[] = [];
    const t = createTelemetry({ ...baseConfig, transport: tx, keepAlive: (p) => registered.push(p) });

    void t.reportHealth({ status: 'ok' }); // mimics a product call site that discards the promise

    expect(registered).toHaveLength(1); // registered synchronously, before the void-call returns
    await registered[0]; // simulates the platform's waitUntil actually awaiting it — must not throw
    expect(tx.calls).toHaveLength(1); // the send genuinely completed
    expect(tx.calls[0]!.body.status).toBe('ok');
  });

  it('omitting keepAlive preserves exact prior behavior (no-op default, no throw on a void-called send)', async () => {
    const tx = recordingTransport();
    const t = createTelemetry({ ...baseConfig, transport: tx });

    expect(() => void t.reportHealth({ status: 'ok' })).not.toThrow();
    await t.reportHealth({ status: 'degraded' }); // awaited call still works normally
    expect(tx.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('hands flush() a promise to keepAlive too', async () => {
    const tx = recordingTransport();
    const registered: Promise<unknown>[] = [];
    const t = createTelemetry({ ...baseConfig, transport: tx, keepAlive: (p) => registered.push(p) });

    t.track({ event: 'invoice.created', props: { n: 1 } });
    void t.flush();

    expect(registered).toHaveLength(1);
    await registered[0];
    expect(sentEvents(tx)).toHaveLength(1);
  });

  it('registers the heartbeat-interval-triggered resend with keepAlive too (the library\'s own internal fire-and-forget)', async () => {
    vi.useFakeTimers();
    try {
      const tx = recordingTransport();
      const registered: Promise<unknown>[] = [];
      const t = createTelemetry({
        ...baseConfig,
        autoStart: true,
        heartbeatMs: 1000,
        transport: tx,
        keepAlive: (p) => registered.push(p),
      });
      await t.reportHealth({ status: 'ok' }); // immediate send (1 registration)
      await vi.advanceTimersByTimeAsync(1500); // one heartbeat tick
      t.stop();

      // one registration for the initial reportHealth() + at least one for the heartbeat tick
      expect(registered.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('registers the batch-size-triggered and batch-interval-triggered flush with keepAlive too', async () => {
    vi.useFakeTimers();
    try {
      const tx = recordingTransport();
      const registered: Promise<unknown>[] = [];
      const t = createTelemetry({
        ...baseConfig,
        autoStart: true,
        batchSize: 2,
        batchIntervalMs: 1000,
        transport: tx,
        keepAlive: (p) => registered.push(p),
      });

      t.track({ event: 'test.a', props: {} });
      t.track({ event: 'test.b', props: {} }); // hits batchSize -> internal void flush()
      expect(registered.length).toBeGreaterThanOrEqual(1);

      const afterBatchSize = registered.length;
      t.track({ event: 'test.c', props: {} });
      await vi.advanceTimersByTimeAsync(1500); // batch interval tick -> internal void flush()
      t.stop();
      expect(registered.length).toBeGreaterThan(afterBatchSize);
    } finally {
      vi.useRealTimers();
    }
  });
});

// 2026-08-17 — from the InTake session's harness handoff.
//
// InTake shipped a bug to this: two health reports from the same process, same product/module,
// ~4s apart, both status ok, with DIFFERENT checks arrays. The second never arrived — absent from
// the append-only health_events table, so never transmitted, not merely superseded. It was the
// same-status debounce below, working as designed.
//
// The design is right; the SILENCE is the bug. The caller got no error, no return value, and
// `telemetry.dropped` stayed 0 throughout — so by the platform's own metric nothing was dropped.
// A counter that reads as "emission failures" while excluding deliberate suppression is a counter
// that lies at exactly the moment someone is trying to work out where their data went.
describe('suppression is visible, not silent', () => {
  it('counts a suppressed report in health_suppressed', async () => {
    const tx = recordingTransport();
    const t = createTelemetry({ ...baseConfig, transport: tx });
    await t.reportHealth({ status: 'ok', checks: [{ id: 'a', status: 'pass' }] });
    await t.reportHealth({ status: 'ok', checks: [{ id: 'a', status: 'pass' }] });
    expect(tx.calls).toHaveLength(1);
    expect(t.counters.health_suppressed).toBe(1);
  });

  it('does NOT count suppression as a drop — telemetry.dropped must keep meaning "we failed to send"', async () => {
    // Folding suppression into `dropped` would fix the silence by making an honest counter
    // dishonest in the other direction: every healthy service would report drops forever.
    const tx = recordingTransport();
    const t = createTelemetry({ ...baseConfig, transport: tx });
    await t.reportHealth({ status: 'ok' });
    await t.reportHealth({ status: 'ok' });
    expect(t.counters.dropped).toBe(0);
    expect(t.counters.health_dropped).toBe(0);
  });

  it('WARNS when the collapsed reports carry different checks — that is a caller mistake', async () => {
    // Identical repeats are exactly what the debounce is for; suppressing them silently is
    // correct. Differing checks mean the caller believes it is reporting something new and is
    // not — cheap for the client to detect, and impossible for the caller to notice.
    const warnings: string[] = [];
    const tx = recordingTransport();
    const t = createTelemetry({ ...baseConfig, transport: tx, onWarn: (m) => warnings.push(m) });
    await t.reportHealth({ status: 'ok', checks: [{ id: 'a', status: 'pass' }] });
    await t.reportHealth({ status: 'ok', checks: [{ id: 'b', status: 'pass' }] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/suppress/i);
    expect(warnings[0]).toMatch(/check/i);
  });

  it('does NOT warn when the checks are identical — the debounce doing its job is not news', async () => {
    const warnings: string[] = [];
    const tx = recordingTransport();
    const t = createTelemetry({ ...baseConfig, transport: tx, onWarn: (m) => warnings.push(m) });
    await t.reportHealth({ status: 'ok', checks: [{ id: 'a', status: 'pass' }] });
    await t.reportHealth({ status: 'ok', checks: [{ id: 'a', status: 'pass' }] });
    expect(warnings).toHaveLength(0);
  });

  it('detects a changed check STATUS, not just a changed id', async () => {
    const warnings: string[] = [];
    const tx = recordingTransport();
    const t = createTelemetry({ ...baseConfig, transport: tx, onWarn: (m) => warnings.push(m) });
    await t.reportHealth({ status: 'ok', checks: [{ id: 'a', status: 'pass' }] });
    await t.reportHealth({ status: 'ok', checks: [{ id: 'a', status: 'warn' }] });
    expect(warnings).toHaveLength(1);
  });

  it('no warning when the report is actually SENT — nothing was suppressed', async () => {
    const warnings: string[] = [];
    const tx = recordingTransport();
    const t = createTelemetry({ ...baseConfig, transport: tx, onWarn: (m) => warnings.push(m) });
    await t.reportHealth({ status: 'ok', checks: [{ id: 'a', status: 'pass' }] });
    await t.reportHealth({ status: 'down', checks: [{ id: 'a', status: 'fail' }] });
    expect(tx.calls).toHaveLength(2);
    expect(warnings).toHaveLength(0);
  });

  it('omitting onWarn is safe — the client must never require a hook to function', async () => {
    const tx = recordingTransport();
    const t = createTelemetry({ ...baseConfig, transport: tx });
    await t.reportHealth({ status: 'ok', checks: [{ id: 'a', status: 'pass' }] });
    await expect(t.reportHealth({ status: 'ok', checks: [{ id: 'b', status: 'pass' }] })).resolves.toBeUndefined();
  });
});
