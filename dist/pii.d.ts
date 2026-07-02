import type { AnalyticsEvent } from './schema.js';
/**
 * True if a single value looks like PII or a secret. Numbers/booleans are
 * always safe; only strings are inspected.
 */
export declare function looksLikePii(value: unknown): boolean;
/**
 * Scan an analytics event for PII leaks. Returns the list of field paths whose
 * value looks like PII (empty array = clean). Inspects every `props` value plus
 * the free-form identity fields (`actor`, `entity_id`, `session_id`) — those are
 * supposed to be hashed, so a raw email/phone there is a leak too.
 */
export declare function scanForPii(event: Pick<AnalyticsEvent, 'props' | 'actor' | 'entity_id' | 'session_id'>): string[];
//# sourceMappingURL=pii.d.ts.map