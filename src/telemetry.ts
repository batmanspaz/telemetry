import {
  HealthReportSchema,
  AnalyticsEventSchema,
  SCHEMA_VERSION,
  type HealthReport,
  type HealthCheck,
  type HealthStatus,
  type AnalyticsEvent,
  type PropValue,
} from './schema.js';
import { hash } from './hash.js';
import { scanForPii } from './pii.js';
import { noopTransport, type Transport } from './transport.js';

const HEALTH_PATH = '/ingest/health';
const ANALYTICS_PATH = '/ingest/analytics';

export interface TelemetryConfig {
  /** Product identity, e.g. 'billing'. */
  product: string;
  /** Module identity within the product, e.g. 'payments'. */
  module: string;
  /** Build/git sha — surfaced so the dashboard shows what's deployed. */
  version: string;
  /** Worker id / host. */
  instance?: string;
  /** Where emissions go. Defaults to noopTransport (a safe mock). */
  transport?: Transport;
  /** Heartbeat interval in ms (default 60000). 0 disables the heartbeat. */
  heartbeatMs?: number;
  /** Default ttl_seconds stamped on health reports that don't set their own. */
  ttlSeconds?: number;
  /** Flush a batch once this many events are buffered (default 20). */
  batchSize?: number;
  /** Flush the batch at least this often in ms (default 5000). 0 disables. */
  batchIntervalMs?: number;
  /** Injectable clock (ms) for deterministic tests. */
  now?: () => number;
  /** Start the heartbeat + batch timers automatically (default true). */
  autoStart?: boolean;
}

export interface Counters {
  health_sent: number;
  health_dropped: number;
  events_tracked: number;
  events_sent: number;
  events_dropped: number;
  events_deduped: number;
  /** telemetry.dropped rollup (health + events) surfaced as a health check. */
  dropped: number;
}

export interface HealthInput {
  status: HealthStatus;
  checks?: HealthCheck[];
  score?: number;
  ttl_seconds?: number;
  instance?: string;
  version?: string;
}

export interface TrackInput {
  /** Dotted, lower-case event name, e.g. 'invoice.created'. */
  event: string;
  entity_type?: string;
  /** Hash sensitive ids with `hash()` before passing them here. */
  entity_id?: string;
  /** Hashed user/session id — never a raw email. */
  actor?: string;
  session_id?: string;
  props?: Record<string, PropValue>;
  /** Idempotency / dedupe key. Derived from content if omitted. */
  key?: string;
  /** Override timestamp (ms-resolution ISO derived from `now()` if omitted). */
  ts?: string;
}

export interface Telemetry {
  /** Validate + emit a health report. Sends immediately on status change. */
  reportHealth(input: HealthInput): Promise<void>;
  /** Validate + buffer an analytics event. Non-blocking, never throws. */
  track(input: TrackInput): void;
  /** Flush the analytics batch now. Non-blocking, never throws. */
  flush(): Promise<void>;
  /** Live counters (telemetry.dropped surfaced for self-reporting). */
  counters: Counters;
  /** Stop the heartbeat + batch timers (idempotent). */
  stop(): void;
}

interface BufferedEvent {
  event: AnalyticsEvent;
  key: string;
}

/** Stable dedupe key derived from event content. */
function deriveKey(event: AnalyticsEvent): string {
  const propKeys = Object.keys(event.props).sort();
  const canonicalProps = propKeys.map((k) => `${k}=${String(event.props[k])}`).join('&');
  return hash([event.event, event.entity_id ?? '', event.ts, canonicalProps].join('|'));
}

export function createTelemetry(config: TelemetryConfig): Telemetry {
  const transport = config.transport ?? noopTransport;
  const now = config.now ?? (() => Date.now());
  const heartbeatMs = config.heartbeatMs ?? 60_000;
  const batchSize = config.batchSize ?? 20;
  const batchIntervalMs = config.batchIntervalMs ?? 5_000;
  const ttlSeconds = config.ttlSeconds ?? Math.max(90, Math.ceil((heartbeatMs / 1000) * 2));
  const autoStart = config.autoStart ?? true;

  const counters: Counters = {
    health_sent: 0,
    health_dropped: 0,
    events_tracked: 0,
    events_sent: 0,
    events_dropped: 0,
    events_deduped: 0,
    dropped: 0,
  };

  let lastInput: HealthInput | null = null;
  let lastSentStatus: HealthStatus | null = null;

  const buffer: BufferedEvent[] = [];
  const seenKeys = new Set<string>();

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let batchTimer: ReturnType<typeof setInterval> | null = null;

  function bumpDropped(kind: 'health' | 'event', n = 1): void {
    counters.dropped += n;
    if (kind === 'health') counters.health_dropped += n;
    else counters.events_dropped += n;
  }

  function isoNow(): string {
    return new Date(now()).toISOString();
  }

  function buildHealth(input: HealthInput): HealthReport | null {
    const checks: HealthCheck[] = input.checks ? [...input.checks] : [];
    // Self-report the dropped-emission counter so the observability layer can't
    // fail silently — a non-zero drop count shows up as a warn check.
    checks.push({
      id: 'telemetry.dropped',
      status: counters.dropped > 0 ? 'warn' : 'pass',
      metric: counters.dropped,
      unit: 'count',
    });

    const candidate = {
      schema_version: SCHEMA_VERSION,
      product: config.product,
      module: config.module,
      instance: input.instance ?? config.instance,
      status: input.status,
      score: input.score,
      checks,
      version: input.version ?? config.version,
      ts: isoNow(),
      ttl_seconds: input.ttl_seconds ?? ttlSeconds,
    };

    const parsed = HealthReportSchema.safeParse(candidate);
    if (!parsed.success) {
      bumpDropped('health');
      return null;
    }
    return parsed.data;
  }

  async function sendHealth(report: HealthReport): Promise<void> {
    try {
      await transport.send(HEALTH_PATH, report);
      counters.health_sent++;
      lastSentStatus = report.status;
    } catch {
      bumpDropped('health');
    }
  }

  async function reportHealth(input: HealthInput): Promise<void> {
    try {
      lastInput = input;
      const report = buildHealth(input);
      if (!report) return;
      // Emit immediately on a status change (debounced vs the last sent status).
      // The heartbeat handles steady-state re-reporting.
      if (lastSentStatus !== report.status) {
        await sendHealth(report);
      }
    } catch {
      bumpDropped('health');
    }
  }

  function track(input: TrackInput): void {
    try {
      counters.events_tracked++;
      const candidate = {
        schema_version: SCHEMA_VERSION,
        event: input.event,
        product: config.product,
        module: config.module,
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        actor: input.actor,
        session_id: input.session_id,
        props: input.props ?? {},
        ts: input.ts ?? isoNow(),
      };

      const parsed = AnalyticsEventSchema.safeParse(candidate);
      if (!parsed.success) {
        bumpDropped('event');
        return;
      }
      const event = parsed.data;

      // Privacy by construction: refuse to emit anything that looks like PII.
      if (scanForPii(event).length > 0) {
        bumpDropped('event');
        return;
      }

      const key = input.key ?? deriveKey(event);
      if (seenKeys.has(key)) {
        counters.events_deduped++;
        return;
      }
      seenKeys.add(key);
      buffer.push({ event, key });

      if (buffer.length >= batchSize) {
        void flush();
      }
    } catch {
      bumpDropped('event');
    }
  }

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    const body = {
      schema_version: SCHEMA_VERSION,
      product: config.product,
      module: config.module,
      batch_id: hash(batch.map((b) => b.key).join(',')),
      ts: isoNow(),
      // Each event carries its idempotency `id` so a retried batch can't double-count.
      events: batch.map((b) => ({ ...b.event, id: b.key })),
    };
    try {
      await transport.send(ANALYTICS_PATH, body);
      counters.events_sent += batch.length;
    } catch {
      // Requeue (keys stay in seenKeys, so no re-buffering) and count the drop.
      // The stable ids mean the eventual successful send is idempotent downstream.
      buffer.unshift(...batch);
      bumpDropped('event', batch.length);
    }
  }

  function start(): void {
    if (heartbeatMs > 0 && !heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        if (!lastInput) return;
        const report = buildHealth(lastInput);
        if (report) void sendHealth(report);
      }, heartbeatMs);
      heartbeatTimer.unref?.();
    }
    if (batchIntervalMs > 0 && !batchTimer) {
      batchTimer = setInterval(() => {
        void flush();
      }, batchIntervalMs);
      batchTimer.unref?.();
    }
  }

  function stop(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (batchTimer) {
      clearInterval(batchTimer);
      batchTimer = null;
    }
  }

  if (autoStart) start();

  return { reportHealth, track, flush, counters, stop };
}
