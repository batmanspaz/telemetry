import { createHash } from 'node:crypto';

/**
 * Deterministic, one-way hash for actor / sensitive entity ids.
 * Use this on any value that could identify a person (email, user id, session)
 * BEFORE putting it in an AnalyticsEvent's `actor` / `entity_id` field.
 *
 * Returns a 64-char lowercase hex SHA-256 digest. Pure-hex output is
 * intentionally NOT treated as PII by the privacy guard, so hashed ids pass.
 */
export function hash(value: string | number): string {
  return createHash('sha256').update(String(value)).digest('hex');
}
