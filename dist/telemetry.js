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
    const maxBufferedEvents = config.maxBufferedEvents ?? 1_000;
    const ttlSeconds = config.ttlSeconds ?? Math.max(90, Math.ceil((heartbeatMs / 1000) * 2));
    const forceResendMs = config.forceResendMs ?? Math.floor((ttlSeconds * 1000) / 2);
    const autoStart = config.autoStart ?? true;
    const keepAlive = config.keepAlive ?? (() => { });
    const counters = {
        health_sent: 0,
        health_dropped: 0,
        events_tracked: 0,
        events_sent: 0,
        events_dropped: 0,
        events_deduped: 0,
        health_suppressed: 0,
        dropped: 0,
    };
    let lastInput = null;
    let lastSentStatus = null;
    let lastSentAtMs = null;
    /** The checks actually transmitted last, so a suppressed report can be compared against what
     *  the platform genuinely holds — not against the previous call, which may itself have been
     *  suppressed. */
    let lastSentChecksKey = null;
    const onWarn = config.onWarn;
    const checksKey = (checks) => JSON.stringify((checks ?? []).map((c) => [c.id, c.status]).sort());
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
            lastSentAtMs = now();
        }
        catch {
            bumpDropped('health');
        }
    }
    async function doReportHealth(input) {
        try {
            lastInput = input;
            const report = buildHealth(input);
            if (!report)
                return;
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
                lastSentChecksKey = checksKey(input.checks);
                return;
            }
            // Suppressed. Make it VISIBLE — this branch used to return in total silence, which is how
            // InTake lost a report on 2026-08-17: no error, no return value, and `telemetry.dropped`
            // still 0, so by the platform's own metric nothing had happened.
            counters.health_suppressed += 1;
            const key = checksKey(input.checks);
            if (onWarn && lastSentChecksKey !== null && key !== lastSentChecksKey) {
                // Identical repeats are exactly what the debounce is for and are not worth a word.
                // DIFFERING checks mean the caller believes it is reporting something new and is not —
                // cheap to detect here, impossible to notice from the call site.
                onWarn(`[telemetry] suppressed a health report whose checks DIFFER from the last one sent ` +
                    `(${config.product}/${config.module}, status unchanged: ${report.status}). The debounce ` +
                    `only re-sends on a status change or after forceResendMs, so this payload was never ` +
                    `transmitted. If these checks belong to a distinct concern, give them their own module.`);
            }
        }
        catch {
            bumpDropped('health');
        }
    }
    // Registers every send with `keepAlive` synchronously, before returning the promise, so a
    // caller's `void telemetry.reportHealth(...)` — the common product call-site pattern — still
    // gets kept alive by the platform when configured. No call site needs to change.
    function reportHealth(input) {
        const p = doReportHealth(input);
        keepAlive(p);
        return p;
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
            trimBufferToCap();
            if (buffer.length >= batchSize) {
                void flush();
            }
        }
        catch {
            bumpDropped('event');
        }
    }
    async function doFlush() {
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
            trimBufferToCap();
        }
    }
    // Same keepAlive registration as reportHealth() above, for the same reason.
    function flush() {
        const p = doFlush();
        keepAlive(p);
        return p;
    }
    /** Bounded-memory guarantee: the oldest buffered events fall off past the cap.
     *  Their keys stay in seenKeys (same rule as requeue), so a re-track of an
     *  identical event dedupes rather than resurrecting a dropped one. */
    function trimBufferToCap() {
        if (buffer.length <= maxBufferedEvents)
            return;
        const excess = buffer.length - maxBufferedEvents;
        buffer.splice(0, excess);
        bumpDropped('event', excess);
    }
    function start() {
        if (heartbeatMs > 0 && !heartbeatTimer) {
            heartbeatTimer = setInterval(() => {
                if (!lastInput)
                    return;
                const report = buildHealth(lastInput);
                if (report)
                    keepAlive(sendHealth(report));
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