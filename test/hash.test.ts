import { describe, it, expect } from 'vitest';
import { hash } from '../src/index.js';

describe('hash', () => {
  it('is deterministic', () => {
    expect(hash('paul@example.com')).toBe(hash('paul@example.com'));
  });

  it('produces different output for different input', () => {
    expect(hash('a@example.com')).not.toBe(hash('b@example.com'));
  });

  it('does not contain the raw input', () => {
    const out = hash('paul@example.com');
    expect(out).not.toContain('paul');
    expect(out).not.toContain('@');
  });

  it('returns a 64-char lowercase hex digest', () => {
    expect(hash('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});
