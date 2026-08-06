# @perfectcity/telemetry

Shared telemetry + health self-reporting client for the **PerfectCity portfolio**
(Billing, Email Ingestor, Health Monitor, CollageSoup/Pagewright, …).

This is the **only** way a product emits health and analytics. No product hand-rolls
its own emitter. It implements the canonical contract in
`~/claude/infra/telemetry-health-standard.md` to the letter — one versioned
`HealthReport` schema, one versioned `AnalyticsEvent` schema, pushed (never scraped)
to a central signed ingest.

Clean-room build, Phase T0. TypeScript · ESM · zod · vitest. TDD'd and mockable.

## Principles (why it's shaped this way)

- **Emit, don't scrape.** Modules push heartbeats + events to a central ingest.
- **Canonical, versioned schemas.** Off-schema payloads are rejected, never sent.
- **Realtime + staleness, never silent.** Every report carries `ttl_seconds`; past
  TTL the central store flips the module to `stale`. `isStale()` is exported so you
  can reason about freshness locally.
- **Non-blocking + self-reporting.** Emitting never throws or blocks the caller. A
  dropped emission bumps the `telemetry.dropped` counter, which is itself surfaced
  as a health check — observability can't fail silently.
- **Privacy by construction.** No PII/secrets in either stream. `props` are typed and
  PII-free; hash `actor`/sensitive ids with `hash()`. Enforced by a property test.

## Install

Workspace package (private). Depend on it by name:

```jsonc
// package.json
"dependencies": { "@perfectcity/telemetry": "workspace:*" }
```

```bash
pnpm build      # tsc -> dist/
pnpm test       # vitest run
pnpm typecheck  # tsc --noEmit
```

## Quick start — wiring product/module identity

```ts
import { createTelemetry, httpTransport, hash } from '@perfectcity/telemetry';

const telemetry = createTelemetry({
  product: 'billing',          // product identity
  module: 'payments',          // module identity within the product
  version: process.env.GIT_SHA ?? 'dev',
  instance: process.env.WORKER_ID,
  heartbeatMs: 60_000,         // health heartbeat (default 60s)
  transport: httpTransport({
    baseUrl: process.env.TELEMETRY_INGEST_URL!,   // central ingest Worker
    hmacKey: process.env.TELEMETRY_HMAC_KEY!,     // per-product key, from env — never hard-coded
    // fetch,                                      // injectable (Workers / tests)
  }),
});
```

Default transport is `noopTransport` (a safe mock) — omit `transport` for local dev
and unit tests.

### Health — heartbeat + on-change + force-resend

```ts
// Call whenever the module computes its health. Sends immediately on a status
// change; also force-resends once forceResendMs has elapsed since the last
// send, even with no status change (default: half of ttlSeconds).
await telemetry.reportHealth({
  status: 'ok',                       // 'ok' | 'degraded' | 'down' | 'stale'
  score: 98,                          // optional 0-100 rollup
  checks: [
    { id: 'db.ping', status: 'pass', metric: 12, unit: 'ms' },
    { id: 'queue.depth', status: 'warn', metric: 240, unit: 'msgs' },
  ],
  // ttl_seconds defaults from config; product/module/version/ts auto-filled.
});
```

**Serverless / edge functions (Vercel, Workers, Lambda, etc.):** call
`reportHealth()` on every request (or every N requests). `heartbeatMs`'s
`setInterval` cannot fire once the process suspends after the response is
sent — there is no persistent event loop to run it — so on these platforms
the *only* thing keeping a module fresh between status changes is the inline
`forceResendMs` check inside `reportHealth()` itself. This is on by default
(`forceResendMs` defaults to half of the effective `ttlSeconds`), so as long
as `reportHealth()` is actually invoked somewhere in your request path at
least that often, you don't need to do anything extra. If your traffic is too
sparse to guarantee that cadence, either lower `ttlSeconds` expectations
accordingly or add your own scheduled trigger (cron) that calls
`reportHealth()` directly — `heartbeatMs`'s timer is not a substitute on
these platforms, only `forceResendMs` is.

**`forceResendMs` still needs its own request to be delivered.** Product call
sites almost always call `reportHealth()`/`flush()` fire-and-forget —
`void telemetry.reportHealth(...)` — so the response can return without
waiting on the network round-trip. On Vercel Fluid Compute (and similar
platforms) an unawaited call has **no completion guarantee** once the
response flushes; live-confirmed 2026-08-06, a fast-returning handler with
little I/O ahead of the telemetry call silently dropped 4 of 5 sequential
sends (no ingest row, no `health_dropped` bump — execution was cut off
before `sendHealth`'s own try/catch ran). Pass `keepAlive` to close this:

```ts
import { waitUntil } from '@vercel/functions'; // or ctx.waitUntil on CF Workers

const telemetry = createPagewrightTelemetry({
  module: 'collect',
  keepAlive: waitUntil, // registers every in-flight send with the platform
  // ...
});
```

`keepAlive(promise)` is called synchronously on every `reportHealth()` and
`flush()` call (and the library's own internal heartbeat/batch
fire-and-forget sends) — **no product call site needs to change.** Omit it
and behavior is exactly as before (a safe no-op default).

`reportHealth` auto-fills `schema_version`, `ts`, `product`, `module`, `version`, and
appends a `telemetry.dropped` check so drops are always visible.

### Analytics — key events + usage

```ts
// Key/domain events: what happened.
telemetry.track({
  event: 'invoice.created',           // dotted, lower-case
  entity_type: 'invoice',
  entity_id: hash(invoiceId),         // hash sensitive ids
  actor: hash(userEmail),             // never a raw email
  props: { amount: 1200, currency: 'usd', plan: 'pro' },  // typed, PII-free
});

// Usage events: how it's used.
telemetry.track({ event: 'feature.used', props: { feature: 'bulk-export' } });

await telemetry.flush();              // force a batch flush (also auto-flushes by size/time)
```

`track` is **non-blocking** (never throws), **batched** (by size + interval), and
**idempotent** — pass `key` for an explicit dedupe/idempotency key, or it's derived
from event content. A retried batch carries stable ids and never double-counts.

### Counters (self-reporting)

```ts
telemetry.counters; // { health_sent, health_dropped, events_tracked, events_sent,
                     //   events_dropped, events_deduped, dropped }
```

`counters.dropped` is the `telemetry.dropped` rollup surfaced as a health check.

### Shutdown

```ts
telemetry.stop();   // clears heartbeat + batch timers (idempotent)
```

## Public API

| Export | Purpose |
|---|---|
| `createTelemetry(config)` | `{ reportHealth, track, flush, counters, stop }` |
| `HealthReportSchema`, `AnalyticsEventSchema` | canonical versioned Zod schemas |
| `SCHEMA_VERSION` | `1` |
| `HealthReport`, `AnalyticsEvent`, `HealthStatus`, `HealthCheck`, `Counters`, … | types |
| `isStale(report, nowMs)` | pure TTL freshness helper |
| `hash(value)` | one-way SHA-256 for actor/sensitive ids |
| `looksLikePii(value)`, `scanForPii(event)` | privacy guard utilities |
| `noopTransport` | default mock transport |
| `httpTransport({ baseUrl, hmacKey, fetch? })` | HMAC-signed HTTP ingest transport |

## Transport seam

The client never touches the network directly — it calls `transport.send(path, body)`.
Ship `noopTransport` (default mock) and `httpTransport` (HMAC-SHA256 signed, injectable
`fetch`). CF-Worker products can supply a service-binding transport implementing the same
`Transport` interface.

## Phase-0 invariants (tested)

`stale after TTL` · `status-change emits immediately` · `off-schema rejected` ·
`emission failure non-blocking AND bumps telemetry.dropped` · `batched + idempotent
(retry → no dup)` · `no-PII property test over a generated event corpus` ·
`keepAlive registered synchronously on reportHealth/flush + internal heartbeat/batch sends`.

```bash
pnpm test   # 55 tests green
```

No secrets in code — the HMAC key is sourced from config/env at runtime.
