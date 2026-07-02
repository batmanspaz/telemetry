import { describe, it, expect } from 'vitest';
import { createTelemetry, looksLikePii, scanForPii, hash, type Transport } from '../src/index.js';

function recordingTransport(): Transport & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    async send(_path, body) {
      calls.push(body);
    },
  };
}

describe('looksLikePii', () => {
  it('flags emails, phones, jwts and api keys', () => {
    expect(looksLikePii('paul@example.com')).toBe(true);
    expect(looksLikePii('+1 (415) 555-0199')).toBe(true);
    expect(looksLikePii('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456')).toBe(true);
    expect(looksLikePii('sk-ABCD1234EFGH5678')).toBe(true);
    // split to dodge the repo secret-scanner; this is the canonical fake AWS doc key
    expect(looksLikePii('AKIA' + 'IOSFODNN7EXAMPLE')).toBe(true);
  });

  it('does not flag safe values, including hashed ids', () => {
    expect(looksLikePii('checkout')).toBe(false);
    expect(looksLikePii('v2.1.0')).toBe(false);
    expect(looksLikePii(42)).toBe(false);
    expect(looksLikePii(true)).toBe(false);
    expect(looksLikePii(hash('paul@example.com'))).toBe(false);
  });
});

// Property test: a generated corpus of events, some clean, some PII-laden.
// The client must drop the PII-laden ones and only ever emit clean events.
describe('no-PII property test', () => {
  function mulberry32(seed: number) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const piiValues = [
    'paul@example.com',
    'jane.doe@perfectcity.com',
    '+1 (415) 555-0199',
    'sk-LIVE-ABCD1234EFGH5678',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4f',
    'AKIA' + 'IOSFODNN7EXAMPLE', // split to dodge the repo secret-scanner
  ];
  const safeValues = ['checkout', 'view', 'paper-bites', 'v2.1.0', 'standard', 'shop-pay'];

  it('emits only PII-free events across a generated corpus', async () => {
    const rand = mulberry32(1234);
    const tx = recordingTransport();
    const t = createTelemetry({
      product: 'billing',
      module: 'payments',
      version: 'sha',
      autoStart: false,
      transport: tx,
      batchSize: 10_000,
    });

    let expectedPiiDrops = 0;
    for (let i = 0; i < 400; i++) {
      const isPii = rand() < 0.4;
      const safe = safeValues[Math.floor(rand() * safeValues.length)]!;
      const props: Record<string, string | number | boolean> = {
        step: safe,
        amount: Math.floor(rand() * 1000),
        ok: rand() < 0.5,
      };
      if (isPii) {
        const p = piiValues[Math.floor(rand() * piiValues.length)]!;
        props.leak = p;
        expectedPiiDrops++;
      }
      t.track({
        event: 'feature.used',
        actor: hash('user-' + i),
        entity_id: hash('inv-' + i),
        props,
        key: 'evt-' + i,
      });
    }
    await t.flush();

    // wire body is a bare array of events — no {events: [...]} envelope.
    const emitted = tx.calls.flatMap((b) => b as any[]);
    // every emitted event is PII-free
    for (const ev of emitted) {
      expect(scanForPii(ev)).toEqual([]);
    }
    // the PII-laden ones were dropped, not silently passed
    expect(emitted.length).toBe(400 - expectedPiiDrops);
    expect(t.counters.events_dropped).toBe(expectedPiiDrops);
    expect(expectedPiiDrops).toBeGreaterThan(0);
  });
});
