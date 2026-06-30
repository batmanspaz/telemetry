import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTelemetry, type Transport } from '../src/index.js';

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
  it('auto-fills identity + ts, validates, and batches by size', async () => {
    const tx = recordingTransport();
    const t = createTelemetry({ ...baseConfig, transport: tx, batchSize: 2 });
    t.track({ event: 'invoice.created', props: { n: 1 } });
    expect(tx.calls).toHaveLength(0); // batched, not yet flushed
    t.track({ event: 'payment.recorded', props: { n: 2 } });
    // size threshold reached -> flush scheduled
    await Promise.resolve();
    await t.flush();
    const sent = tx.calls.flatMap((c) => c.body.events ?? []);
    expect(sent.length).toBe(2);
    expect(sent[0].product).toBe('billing');
    expect(sent[0].schema_version).toBe(1);
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
    const sent = tx.calls.flatMap((c) => c.body.events ?? []);
    expect(sent.length).toBe(1);
    expect(t.counters.events_deduped).toBe(1);
  });

  it('survives a flaky transport: retry resends the same id, never duplicating', async () => {
    let attempt = 0;
    const sent: any[][] = [];
    const flaky: Transport = {
      async send(_path, body: any) {
        attempt++;
        if (attempt === 1) throw new Error('transient');
        sent.push(body.events);
      },
    };
    const t = createTelemetry({ ...baseConfig, transport: flaky });
    t.track({ event: 'invoice.created', props: { n: 1 }, key: 'inv-9' });
    await t.flush(); // fails, requeues
    await t.flush(); // succeeds
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(1);
    expect(sent[0]![0].id).toBe('inv-9');
    expect(t.counters.events_sent).toBe(1);
  });
});
