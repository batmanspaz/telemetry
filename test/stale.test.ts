import { describe, it, expect } from 'vitest';
import { isStale } from '../src/index.js';

describe('isStale', () => {
  const base = '2026-06-29T00:00:00.000Z';
  const baseMs = Date.parse(base);
  const report = { ts: base, ttl_seconds: 60 };

  it('is fresh exactly at the ttl boundary', () => {
    expect(isStale(report, baseMs + 60_000)).toBe(false);
  });

  it('is fresh before the ttl elapses', () => {
    expect(isStale(report, baseMs + 59_000)).toBe(false);
  });

  it('is stale once now exceeds ts + ttl', () => {
    expect(isStale(report, baseMs + 60_001)).toBe(true);
  });

  it('treats an unparseable ts as stale', () => {
    expect(isStale({ ts: 'not-a-date', ttl_seconds: 60 }, baseMs)).toBe(true);
  });
});
