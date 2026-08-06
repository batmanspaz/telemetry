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
  /** Heartbeat interval in ms (default 60000). 0 disables the heartbeat.
   *  NOTE: this relies on a persistent setInterval and does NOT fire in
   *  request/response serverless functions (the process suspends once the
   *  response is sent, before the interval can tick). See `forceResendMs`
   *  for the mechanism that also works there. */
  heartbeatMs?: number;
  /** Default ttl_seconds stamped on health reports that don't set their own. */
  ttlSeconds?: number;
  /** Force a resend at least this often even without a status change,
   *  checked inline against `now()` on every `reportHealth()` call — no
   *  timer involved, so it works within a single request's lifecycle on
   *  serverless/edge platforms where `heartbeatMs`'s setInterval cannot run.
   *  Without this, a traffic-driven caller whose status never changes would
   *  send exactly once (at cold start) and then go stale forever, even under
   *  continuous real traffic, because "no status change" is architecturally
   *  indistinguishable from "no traffic" once the interval can't fire.
   *  Defaults to half of the effective `ttlSeconds`, so two reportHealth()
   *  calls anywhere inside a ttl window are enough to stay fresh regardless
   *  of platform. Set 0 to disable and rely purely on change-detection (only
   *  safe on a persistent process where the heartbeat interval actually runs). */
  forceResendMs?: number;
  /** Flush a batch once this many events are buffered (default 20). */
  batchSize?: number;
  /** Flush the batch at least this often in ms (default 5000). 0 disables. */
  batchIntervalMs?: number;
  /** Hard ceiling on buffered analytics events (default 1000). When the sink is
   *  down and requeues accumulate past this, the OLDEST events are dropped (and
   *  counted in events_dropped) so memory stays bounded. */
  maxBufferedEvents?: number;
  /** Injectable clock (ms) for deterministic tests. */
  now?: () => number;
  /** Start the heartbeat + batch timers automatically (default true). */
  autoStart?: boolean;
  /** Hand the platform's own keep-alive primitive (Vercel's `waitUntil` from
   *  `@vercel/functions`, Cloudflare Workers' `ctx.waitUntil`, etc.) every
   *  in-flight send this client fires. Without this, an unawaited call —
   *  `void telemetry.reportHealth(...)`, the common product call-site pattern —
   *  has no completion guarantee once a serverless response flushes (confirmed
   *  live 2026-08-06: pagewright's collect:staging silently dropped 4 of 5
   *  sequential real health reports this way, with no ingest row and no
   *  health_dropped bump — execution was cut off before sendHealth's own
   *  try/catch ran). Registered synchronously on every reportHealth()/flush()
   *  call (and the library's own internal heartbeat/batch fire-and-forget
   *  sends), so no product call site needs to change. Defaults to a no-op —
   *  omitting this preserves exactly today's behavior. */
  keepAlive?: (p: Promise<unknown>) => void;
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

/** Stable dedupe key derived from event content (used when the caller omits `key`). */
function deriveKey(event: string, entityId: string | undefined, ts: string, props: Record<string, PropValue>): string {
  const propKeys = Object.keys(props).sort();
  const canonicalProps = propKeys.map((k) => `${k}=${String(props[k])}`).join('&');
  return hash([event, entityId ?? '', ts, canonicalProps].join('|'));
}

export function createTelemetry(config: TelemetryConfig): Telemetry {
  const transport = config.transport ?? noopTransport;
  const now = config.now ?? (() => Date.now());
  const heartbeatMs = config.heartbeatMs ?? 60_000;
  const batchSize = config.batchSize ?? 20;
  const batchIntervalMs = config.batchIntervalMs ?? 5_000;
  const maxBufferedEvents = config.maxBufferedEvents ?? 1_000;
  const ttlSeconds = config.ttlSeconds ?? Math.max(90, Math.ceil((heartbeatMs / 1000) * 2));
  const forceResendMs = config.forceResendMs ?? Math.floor((ttlSeconds * 1000) / 2);
  const autoStart = config.autoStart ?? true;
  const keepAlive = config.keepAlive ?? (() => {});

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
  let lastSentAtMs: number | null = null;

  // Buffer holds fully-validated AnalyticsEvent objects (each already carries its
  // own dedupe_key) — the wire body is this array, verbatim, with no envelope.
  const buffer: AnalyticsEvent[] = [];
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
      lastSentAtMs = now();
    } catch {
      bumpDropped('health');
    }
  }

  async function doReportHealth(input: HealthInput): Promise<void> {
    try {
      lastInput = input;
      const report = buildHealth(input);
      if (!report) return;
      // Emit immediately on a status change (debounced vs the last sent status).
      // Also force a resend once forceResendMs has elapsed since the last send,
      // even with no status change — checked inline against now() here, not a
      // timer, so this branch is what actually keeps a traffic-driven caller
      // fresh on serverless (the setInterval heartbeat below is a bonus for
      // persistent processes, not the correctness guarantee).
      const statusChanged = lastSentStatus !== report.status;
      const elapsedSinceSend = lastSentAtMs === null ? Infinity : now() - lastSentAtMs;
      const forceDue = forceResendMs > 0 && elapsedSinceSend >= forceResendMs;
      if (statusChanged || forceDue) {
        await sendHealth(report);
      }
    } catch {
      bumpDropped('health');
    }
  }

  // Registers every send with `keepAlive` synchronously, before returning the promise, so a
  // caller's `void telemetry.reportHealth(...)` — the common product call-site pattern — still
  // gets kept alive by the platform when configured. No call site needs to change.
  function reportHealth(input: HealthInput): Promise<void> {
    const p = doReportHealth(input);
    keepAlive(p);
    return p;
  }

  function track(input: TrackInput): void {
    try {
      counters.events_tracked++;
      const ts = input.ts ?? isoNow();
      const props = input.props ?? {};
      const dedupeKey = input.key ?? deriveKey(input.event, input.entity_id, ts, props);

      const candidate = {
        schema_version: SCHEMA_VERSION,
        event: input.event,
        product: config.product,
        module: config.module,
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        actor: input.actor,
        session_id: input.session_id,
        props,
        ts,
        dedupe_key: dedupeKey,
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

      if (seenKeys.has(event.dedupe_key)) {
        counters.events_deduped++;
        return;
      }
      seenKeys.add(event.dedupe_key);
      buffer.push(event);
      trimBufferToCap();

      if (buffer.length >= batchSize) {
        void flush();
      }
    } catch {
      bumpDropped('event');
    }
  }

  async function doFlush(): Promise<void> {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    try {
      // The wire body is a bare array of events — matches the server's
      // AnalyticsBatch schema exactly (no wrapping envelope).
      await transport.send(ANALYTICS_PATH, batch);
      counters.events_sent += batch.length;
    } catch {
      // Requeue (keys stay in seenKeys, so no re-buffering) and count the drop.
      // Each event's own dedupe_key means the eventual successful send is
      // idempotent downstream even after a retried batch.
      buffer.unshift(...batch);
      bumpDropped('event', batch.length);
      trimBufferToCap();
    }
  }

  // Same keepAlive registration as reportHealth() above, for the same reason.
  function flush(): Promise<void> {
    const p = doFlush();
    keepAlive(p);
    return p;
  }

  /** Bounded-memory guarantee: the oldest buffered events fall off past the cap.
   *  Their keys stay in seenKeys (same rule as requeue), so a re-track of an
   *  identical event dedupes rather than resurrecting a dropped one. */
  function trimBufferToCap(): void {
    if (buffer.length <= maxBufferedEvents) return;
    const excess = buffer.length - maxBufferedEvents;
    buffer.splice(0, excess);
    bumpDropped('event', excess);
  }

  function start(): void {
    if (heartbeatMs > 0 && !heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        if (!lastInput) return;
        const report = buildHealth(lastInput);
        if (report) keepAlive(sendHealth(report));
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
