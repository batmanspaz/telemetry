import { HealthReportSchema, HealthCheckSchema, AnalyticsEventSchema, SCHEMA_VERSION, } from './schema.js';
import { LIMITS, truncateDetail } from './limits.js';
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
    // Caller-supplied config values are sanitised ONCE here (not per call): a bad value is clamped
    // to the wire caps/default instead of making every report fail schema validation.
    let configClamped = 0;
    const clampIdent = (v) => {
        if (typeof v === 'string' && v.length > LIMITS.identifier) {
            configClamped++;
            const c = v.charCodeAt(LIMITS.identifier - 1);
            return v.slice(0, c >= 0xd800 && c <= 0xdbff ? LIMITS.identifier - 1 : LIMITS.identifier);
        }
        return v;
    };
    let defaultTtl = Math.max(90, Math.ceil((heartbeatMs / 1000) * 2));
    if (!Number.isInteger(defaultTtl))
        defaultTtl = 90;
    let ttlSeconds = config.ttlSeconds ?? defaultTtl;
    if (typeof ttlSeconds !== 'number' || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
        ttlSeconds = defaultTtl;
        configClamped++;
    }
    else if (ttlSeconds > LIMITS.ttlSeconds) {
        ttlSeconds = LIMITS.ttlSeconds;
        configClamped++;
    }
    const cfgVersion = clampIdent(config.version);
    const cfgInstance = clampIdent(config.instance);
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
        health_clamped: configClamped,
        health_trimmed: 0,
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
    if (configClamped > 0 && onWarn) {
        try {
            onWarn(`[telemetry] ${config.product}/${config.module}: clamped ${configClamped} config value(s) (version/instance/ttlSeconds) to the wire caps.`);
        }
        catch {
            /* hook failure must never break the client */
        }
    }
    const onTransportError = config.onTransportError;
    /** Invokes onTransportError defensively — a hook that itself throws (or, if async, rejects)
     *  must never propagate out of the client's own try/catch and break the "never throws"
     *  contract for callers who didn't write the hook (e.g. a shared config object passed in by
     *  a different part of the app).
     *
     *  The declared hook type is `(info: TransportErrorInfo) => void`, but TS's void-return-type
     *  assignability lets a caller pass an ASYNC function — the obvious real use case being a
     *  Slack/PagerDuty alerting hook. A `try/catch` around the call only catches a SYNCHRONOUS
     *  throw; an async function that throws doesn't throw synchronously, it returns an
     *  already-rejecting Promise, which the try/catch here would let sail right past uncaught. If
     *  nothing ever attaches a rejection handler to that Promise, Node surfaces it as an
     *  'unhandledRejection' — a real process-crash risk under default Node behavior. So: call the
     *  hook inside try/catch for the sync case, AND, if what comes back looks thenable, attach a
     *  no-op `.catch()` to it for the async case. Both paths are exercised in
     *  test/telemetry.test.ts's `onTransportError` suite, including a scoped
     *  `process.on('unhandledRejection', ...)` listener that proves nothing escapes. */
    function reportTransportError(info) {
        if (!onTransportError)
            return;
        try {
            // Cast past the declared `=> void` signature to observe the real return value —
            // TypeScript allows a caller to pass an async (Promise-returning) function against a
            // `=> void` hook type, so at runtime this may genuinely be a thenable.
            const result = onTransportError(info);
            if (result != null && typeof result.then === 'function') {
                Promise.resolve(result).catch(() => {
                    /* the hook's own async failure is not this client's problem to propagate */
                });
            }
        }
        catch {
            /* the hook's own synchronous failure is not this client's problem to propagate */
        }
    }
    const checksKey = (checks) => JSON.stringify((Array.isArray(checks) ? checks : []).map((c) => [c?.id, c?.status]).sort());
    // Buffer holds fully-validated AnalyticsEvent objects (each already carries its
    // own dedupe_key) — the wire body is this array, verbatim, with no envelope.
    const buffer = [];
    const seenKeys = new Set();
    // CS-0209: reference point for the inline batchIntervalMs force-flush check in
    // track() below — starts at client construction (not null/never), so the interval
    // countdown begins immediately rather than forcing a flush on the very first
    // track() call (an elapsed-since-null "Infinity" would defeat batching entirely).
    let lastFlushAtMs = now();
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
    function byteLen(str) {
        return new TextEncoder().encode(str).length;
    }
    /** Stats of a suppressed fresh call whose input was never sent; counted by the next send (heartbeat or report). */
    let pendingStats = null;
    /** Pure builder: never touches counters. The caller counts `stats` only if the report is
     *  actually SENT (a debounce-suppressed call must not inflate them). */
    function buildHealth(input, pending = false) {
        const stats = { trimmed: 0, clamped: 0 };
        const rawChecks = Array.isArray(input.checks) ? input.checks : [];
        // Truncate over-long detail first (never grounds to drop), then validate EACH check against
        // the wire schema: one invalid check (bad status/unit/id, non-string detail, extra key) is
        // dropped on its own, never the whole report.
        const truncAt = (c, cap) => c && typeof c === 'object' && typeof c.detail === 'string' && c.detail.length > cap
            ? { ...c, detail: truncateDetail(c.detail, cap) }
            : c;
        let valid = [];
        for (const c of rawChecks) {
            const r = HealthCheckSchema.safeParse(truncAt(c, LIMITS.checkDetail));
            if (r.success)
                valid.push(r.data);
            else
                stats.trimmed++;
        }
        // One slot is reserved for the auto `telemetry.dropped` check below; checks beyond the cap
        // are trimmed (and counted) rather than dropping the whole report.
        if (valid.length > LIMITS.checks - 1) {
            stats.trimmed += valid.length - (LIMITS.checks - 1);
            valid = valid.slice(0, LIMITS.checks - 1);
        }
        let detailCap = LIMITS.checkDetail;
        const shape = (cap) => valid.map((c) => truncAt(c, cap));
        let checks = shape(detailCap);
        // The server also caps the request body (32 KiB on hx-health-ingest): shrink detail
        // budgets until the checks fit, so truncation actually guarantees delivery.
        while (detailCap > 64 && byteLen(JSON.stringify(checks)) > LIMITS.healthBodyBytes - 2048) {
            detailCap = Math.floor(detailCap / 2);
            checks = shape(detailCap);
        }
        // Clamp (never drop the report) caller-supplied per-call values that violate the wire caps.
        const clampStr = (v) => {
            if (typeof v === 'string' && v.length > LIMITS.identifier) {
                stats.clamped++;
                const c = v.charCodeAt(LIMITS.identifier - 1);
                return v.slice(0, c >= 0xd800 && c <= 0xdbff ? LIMITS.identifier - 1 : LIMITS.identifier);
            }
            return v;
        };
        let ttl = input.ttl_seconds ?? ttlSeconds;
        if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl <= 0) {
            ttl = ttlSeconds; // NaN / Infinity / float / <=0 -> the (already sanitised) default
            stats.clamped++;
        }
        else if (ttl > LIMITS.ttlSeconds) {
            ttl = LIMITS.ttlSeconds;
            stats.clamped++;
        }
        const clInstance = input.instance !== undefined ? clampStr(input.instance) : cfgInstance;
        const clVersion = input.version !== undefined ? clampStr(input.version) : cfgVersion;
        // Self-report the dropped-emission counter so the observability layer can't
        // fail silently — a non-zero drop count shows up as a warn check.
        // `pending` = this build is a fresh reportHealth that will be counted if sent; heartbeat
        // rebuilds (pending=false) were already counted, so their stats must not be added again.
        const addT = pending ? stats.trimmed : 0;
        const addC = pending ? stats.clamped : 0;
        checks.push({
            id: 'telemetry.dropped',
            status: counters.dropped + addT > 0 ? 'warn' : 'pass',
            metric: counters.dropped + addT,
            unit: 'count',
        });
        // Self-report clamps/trims so the health platform sees them (not only a local counter).
        // Appended only when there is room: user checks are never evicted for it.
        const clampedTotal = counters.health_clamped + addC;
        const trimmedTotal = counters.health_trimmed + addT;
        if ((clampedTotal > 0 || trimmedTotal > 0) && checks.length < LIMITS.checks) {
            checks.push({
                id: 'telemetry.clamped',
                status: 'warn',
                metric: clampedTotal,
                unit: 'count',
                detail: `clamped ${clampedTotal} caller value(s) to wire caps; trimmed ${trimmedTotal} check(s)`,
            });
        }
        const candidate = {
            schema_version: SCHEMA_VERSION,
            product: config.product,
            module: config.module,
            instance: clInstance,
            status: input.status,
            score: input.score,
            checks,
            version: clVersion,
            ts: isoNow(),
            ttl_seconds: ttl,
        };
        const parsed = HealthReportSchema.safeParse(candidate);
        if (!parsed.success) {
            bumpDropped('health');
            return { report: null, stats };
        }
        return { report: parsed.data, stats };
    }
    /** Count + warn about a fresh report's clamps/trims; called only on the SEND path. */
    function noteBuildStats(stats) {
        if (stats.trimmed > 0) {
            counters.dropped += stats.trimmed;
            counters.health_trimmed += stats.trimmed;
        }
        if (stats.clamped > 0)
            counters.health_clamped += stats.clamped;
        if ((stats.trimmed > 0 || stats.clamped > 0) && onWarn) {
            try {
                onWarn(`[telemetry] health report for ${config.product}/${config.module}: clamped ${stats.clamped} ` +
                    `caller value(s) and trimmed ${stats.trimmed} check(s) to fit the wire caps.`);
            }
            catch {
                /* hook failure must never break the client */
            }
        }
    }
    async function sendHealth(report) {
        try {
            await transport.send(HEALTH_PATH, report);
            counters.health_sent++;
            lastSentStatus = report.status;
            lastSentAtMs = now();
        }
        catch (error) {
            bumpDropped('health');
            reportTransportError({ kind: 'health', path: HEALTH_PATH, error });
        }
    }
    async function doReportHealth(input) {
        try {
            lastInput = input;
            const { report, stats } = buildHealth(input, true);
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
                pendingStats = null;
                noteBuildStats(stats);
                await sendHealth(report);
                lastSentChecksKey = checksKey(input.checks);
                return;
            }
            // Suppressed. Make it VISIBLE — this branch used to return in total silence, which is how
            // InTake lost a report on 2026-08-17: no error, no return value, and `telemetry.dropped`
            // still 0, so by the platform's own metric nothing had happened.
            pendingStats = stats;
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
            // CS-0209: force a flush once batchIntervalMs has elapsed since the last flush
            // attempt, even under batchSize — checked inline against now() here, not a
            // timer, so this is what actually keeps a sub-batchSize caller's buffer from
            // growing forever on serverless (the setInterval batchTimer below is a bonus
            // for persistent processes, not the correctness guarantee — same relationship
            // forceResendMs has to the heartbeat timer for health).
            const elapsedSinceFlush = now() - lastFlushAtMs;
            const intervalDue = batchIntervalMs > 0 && elapsedSinceFlush >= batchIntervalMs;
            if (buffer.length >= batchSize || intervalDue) {
                void flush();
            }
        }
        catch {
            bumpDropped('event');
        }
    }
    let flushing = null;
    // Serialized: a second flush while one is in flight joins it (the running loop drains
    // newly tracked events too), so a failed chunk can never be requeued behind later sends.
    function doFlush() {
        if (flushing)
            return flushing;
        flushing = flushLoop().finally(() => {
            flushing = null;
        });
        return flushing;
    }
    async function flushLoop() {
        if (buffer.length === 0)
            return;
        lastFlushAtMs = now();
        // Chunk to the server's batch cap: a request over LIMITS.batch is rejected whole
        // (data loss), so a large maxBufferedEvents must never become one giant request.
        while (buffer.length > 0) {
            let n = Math.min(buffer.length, LIMITS.batch);
            // Byte-aware: halve until the serialized chunk fits the server's body cap (1 MiB,
            // with headroom). A single event is always sent as-is (props caps bound it).
            while (n > 1 && byteLen(JSON.stringify(buffer.slice(0, n))) > LIMITS.analyticsBodyBytes - 4096) {
                n = Math.floor(n / 2);
            }
            const batch = buffer.splice(0, n);
            try {
                // The wire body is a bare array of events — matches the server's
                // AnalyticsBatch schema exactly (no wrapping envelope).
                await transport.send(ANALYTICS_PATH, batch);
                counters.events_sent += batch.length;
            }
            catch (error) {
                // Requeue (keys stay in seenKeys, so no re-buffering) and count the drop.
                // Each event's own dedupe_key means the eventual successful send is
                // idempotent downstream even after a retried batch. Stop on failure; the
                // remaining chunks stay buffered for the next flush.
                buffer.unshift(...batch);
                bumpDropped('event', batch.length);
                trimBufferToCap();
                reportTransportError({ kind: 'event', path: ANALYTICS_PATH, error, count: batch.length });
                return;
            }
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
                try {
                    const owed = pendingStats;
                    const { report } = buildHealth(lastInput, owed !== null);
                    if (report) {
                        if (owed) {
                            pendingStats = null;
                            noteBuildStats(owed);
                        }
                        keepAlive(sendHealth(report));
                    }
                }
                catch {
                    bumpDropped('health');
                }
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