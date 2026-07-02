import { HealthReportSchema, AnalyticsEventSchema, SCHEMA_VERSION, } from './schema.js';
import { hash } from './hash.js';
import { scanForPii } from './pii.js';
import { noopTransport } from './transport.js';
const HEALTH_PATH = '/ingest/health';
const ANALYTICS_PATH = '/ingest/analytics';
/** Stable dedupe key derived from event content (used when the caller omits `key`). */
function deriveKey(event, entityId, ts, props) {
    const propKeys = Object.keys(props).sort();
    const canonicalProps = propKeys.map((k) => `${k}=${String(props[k])}`).join('&');
    return hash([event, entityId ?? '', ts, canonicalProps].join('|'));
}
export function createTelemetry(config) {
    const transport = config.transport ?? noopTransport;
    const now = config.now ?? (() => Date.now());
    const heartbeatMs = config.heartbeatMs ?? 60_000;
    const batchSize = config.batchSize ?? 20;
    const batchIntervalMs = config.batchIntervalMs ?? 5_000;
    const ttlSeconds = config.ttlSeconds ?? Math.max(90, Math.ceil((heartbeatMs / 1000) * 2));
    const autoStart = config.autoStart ?? true;
    const counters = {
        health_sent: 0,
        health_dropped: 0,
        events_tracked: 0,
        events_sent: 0,
        events_dropped: 0,
        events_deduped: 0,
        dropped: 0,
    };
    let lastInput = null;
    let lastSentStatus = null;
    // Buffer holds fully-validated AnalyticsEvent objects (each already carries its
    // own dedupe_key) — the wire body is this array, verbatim, with no envelope.
    const buffer = [];
    const seenKeys = new Set();
    let heartbeatTimer = null;
    let batchTimer = null;
    function bumpDropped(kind, n = 1) {
        counters.dropped += n;
        if (kind === 'health')
            counters.health_dropped += n;
        else
            counters.events_dropped += n;
    }
    function isoNow() {
        return new Date(now()).toISOString();
    }
    function buildHealth(input) {
        const checks = input.checks ? [...input.checks] : [];
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
    async function sendHealth(report) {
        try {
            await transport.send(HEALTH_PATH, report);
            counters.health_sent++;
            lastSentStatus = report.status;
        }
        catch {
            bumpDropped('health');
        }
    }
    async function reportHealth(input) {
        try {
            lastInput = input;
            const report = buildHealth(input);
            if (!report)
                return;
            // Emit immediately on a status change (debounced vs the last sent status).
            // The heartbeat handles steady-state re-reporting.
            if (lastSentStatus !== report.status) {
                await sendHealth(report);
            }
        }
        catch {
            bumpDropped('health');
        }
    }
    function track(input) {
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
            if (buffer.length >= batchSize) {
                void flush();
            }
        }
        catch {
            bumpDropped('event');
        }
    }
    async function flush() {
        if (buffer.length === 0)
            return;
        const batch = buffer.splice(0, buffer.length);
        try {
            // The wire body is a bare array of events — matches the server's
            // AnalyticsBatch schema exactly (no wrapping envelope).
            await transport.send(ANALYTICS_PATH, batch);
            counters.events_sent += batch.length;
        }
        catch {
            // Requeue (keys stay in seenKeys, so no re-buffering) and count the drop.
            // Each event's own dedupe_key means the eventual successful send is
            // idempotent downstream even after a retried batch.
            buffer.unshift(...batch);
            bumpDropped('event', batch.length);
        }
    }
    function start() {
        if (heartbeatMs > 0 && !heartbeatTimer) {
            heartbeatTimer = setInterval(() => {
                if (!lastInput)
                    return;
                const report = buildHealth(lastInput);
                if (report)
                    void sendHealth(report);
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
    function stop() {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
        if (batchTimer) {
            clearInterval(batchTimer);
            batchTimer = null;
        }
    }
    if (autoStart)
        start();
    return { reportHealth, track, flush, counters, stop };
}
//# sourceMappingURL=telemetry.js.map