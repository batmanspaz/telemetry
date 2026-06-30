import type { AnalyticsEvent } from './schema.js';

/**
 * Privacy-by-construction guard. The portfolio rule is that no PII or secrets
 * ever enter the analytics stream: `props` must be typed + PII-free, and
 * `actor` / sensitive `entity_id` must be hashed (see `hash`).
 *
 * These detectors are intentionally shape-based and conservative:
 * - they catch the obvious leak shapes (email, phone, JWT, API keys, AWS keys)
 * - they do NOT flag pure-hex SHA-256 digests, so hashed ids pass cleanly
 *   (the phone matcher requires non-alphanumeric boundaries, so digit runs
 *    inside a hex digest never match).
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

// 10+ digits with optional separators, bounded by non-alphanumerics so a run of
// digits inside a hex hash / token cannot match.
const PHONE = /(?<![A-Za-z0-9])\+?\d(?:[\s().-]*\d){9,}(?![A-Za-z0-9])/;

// JWT: three base64url segments.
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/;

// Common API/secret key prefixes (Stripe, GitHub, Slack, generic sk/pk/rk/ak).
const KEYISH =
  /\b(?:sk|pk|rk|ak|ghp|gho|ghs|ghu|github_pat|xox[baprs]|glpat)[-_][A-Za-z0-9/+_-]{8,}/i;

// AWS access key ids.
const AWS_KEY = /\b(?:AKIA|ASIA|AGPA|AIDA)[0-9A-Z]{12,}\b/;

const DETECTORS = [EMAIL, PHONE, JWT, KEYISH, AWS_KEY];

/**
 * True if a single value looks like PII or a secret. Numbers/booleans are
 * always safe; only strings are inspected.
 */
export function looksLikePii(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return DETECTORS.some((re) => re.test(value));
}

/**
 * Scan an analytics event for PII leaks. Returns the list of field paths whose
 * value looks like PII (empty array = clean). Inspects every `props` value plus
 * the free-form identity fields (`actor`, `entity_id`, `session_id`) — those are
 * supposed to be hashed, so a raw email/phone there is a leak too.
 */
export function scanForPii(
  event: Pick<AnalyticsEvent, 'props' | 'actor' | 'entity_id' | 'session_id'>,
): string[] {
  const leaks: string[] = [];
  for (const [key, val] of Object.entries(event.props ?? {})) {
    if (looksLikePii(val)) leaks.push(`props.${key}`);
  }
  for (const field of ['actor', 'entity_id', 'session_id'] as const) {
    if (looksLikePii(event[field])) leaks.push(field);
  }
  return leaks;
}
