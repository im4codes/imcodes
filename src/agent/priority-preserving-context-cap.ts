import { createHash } from 'node:crypto';
import type { IdentitySegmentSpan } from '../../shared/context-types.js';
import {
  SESSION_IDENTITY_BLOCK_CLOSE_TAG,
  SESSION_IDENTITY_BLOCK_OPEN_TAG,
} from '../../shared/session-identity.js';

/**
 * Provider-specific context budgets, shared by every provider that must cut an
 * over-budget system prompt.
 *
 * The user-authored identity sits in the middle of the stable system text, ahead
 * of the IM.codes runtime identity, the real-device and audit-convergence
 * (supervision) contracts and the memory/progress guidance; authored turn context
 * may follow after that. When the whole prompt is over budget, only the identity
 * body may shrink. Everything else is kept byte-for-byte.
 *
 * Trust rule: the identity boundary is carried structurally, as an
 * {@link IdentitySegmentSpan} recorded at composition time. It is NEVER
 * rediscovered by searching the composed text for identity delimiters, because
 * that text also carries user-authored description and authored context that can
 * contain forged delimiters. A span that fails verification is ignored, and the
 * prompt then falls back to an explicit whole-prompt truncation marker.
 */

/** How a provider measures its budget: UTF-16 units (JS string length) or UTF-8 bytes (argv). */
export type ContextMeasure = 'utf16' | 'utf8';

/** A composed prompt plus, when it contains one, the structural identity span. */
export interface SpannedText {
  text: string;
  identity?: IdentitySegmentSpan;
}

export function measureContext(text: string, measure: ContextMeasure): number {
  return measure === 'utf8' ? Buffer.byteLength(text, 'utf8') : text.length;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Longest prefix of `text` whose measure is at most `budget`, never ending inside
 * a code point: no lone UTF-16 surrogate, no partial UTF-8 sequence.
 */
export function prefixWithinBudget(text: string, budget: number, measure: ContextMeasure): string {
  if (budget <= 0) return '';
  if (measureContext(text, measure) <= budget) return text;
  if (measure === 'utf16') {
    const lastKept = text.charCodeAt(budget - 1);
    return text.slice(0, lastKept >= 0xd800 && lastKept <= 0xdbff ? budget - 1 : budget);
  }
  const bytes = Buffer.from(text, 'utf8');
  let cut = budget;
  // A byte of the form 10xxxxxx continues the sequence that started before it,
  // so cutting there would split a character. Back off to its lead byte.
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut -= 1;
  return bytes.subarray(0, cut).toString('utf8');
}

/**
 * Structural span of the shrinkable identity body within one identity segment.
 *
 * Only the outer frame of the trusted segment is inspected (does the segment as a
 * whole start with the open tag and end with the close tag?). Delimiters inside the
 * user-authored body are irrelevant: the body is everything between that frame.
 * A segment without the rendered frame is shrinkable as a whole.
 */
export function identitySpanForSegment(segment: string): IdentitySegmentSpan {
  const framed = segment.length >= SESSION_IDENTITY_BLOCK_OPEN_TAG.length + SESSION_IDENTITY_BLOCK_CLOSE_TAG.length
    && segment.startsWith(SESSION_IDENTITY_BLOCK_OPEN_TAG)
    && segment.endsWith(SESSION_IDENTITY_BLOCK_CLOSE_TAG);
  const start = framed ? SESSION_IDENTITY_BLOCK_OPEN_TAG.length : 0;
  const end = framed ? segment.length - SESSION_IDENTITY_BLOCK_CLOSE_TAG.length : segment.length;
  return { start, end, sha256: sha256Hex(segment.slice(start, end)) };
}

/** Accept a span only if it is in bounds and still covers exactly the recorded bytes. */
export function verifyIdentitySpan(text: string, span: IdentitySegmentSpan | undefined): IdentitySegmentSpan | undefined {
  if (!span) return undefined;
  const { start, end, sha256 } = span;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined;
  if (start < 0 || end < start || end > text.length) return undefined;
  if (typeof sha256 !== 'string' || sha256Hex(text.slice(start, end)) !== sha256) return undefined;
  return span;
}

/** Shift a span by `offset` code units, preserving its hash binding. */
export function offsetIdentitySpan(span: IdentitySegmentSpan | undefined, offset: number): IdentitySegmentSpan | undefined {
  return span ? { start: span.start + offset, end: span.end + offset, sha256: span.sha256 } : undefined;
}

/**
 * Join parts with `separator`, carrying the first part's identity span to its
 * position in the result. Offsets come from the parts' known lengths, not from
 * scanning the joined text. Empty parts are dropped exactly like `.filter(Boolean)`.
 */
export function joinSpanned(parts: ReadonlyArray<SpannedText | string | undefined>, separator: string): SpannedText | undefined {
  let text = '';
  let identity: IdentitySegmentSpan | undefined;
  let first = true;
  for (const part of parts) {
    const spanned = typeof part === 'string' ? { text: part } : part;
    if (!spanned?.text) continue;
    if (!first) text += separator;
    if (!identity && spanned.identity) identity = offsetIdentitySpan(spanned.identity, text.length);
    text += spanned.text;
    first = false;
  }
  return text ? { text, ...(identity ? { identity } : {}) } : undefined;
}

export interface PriorityPreservingCapMarkers {
  /** Explanation inserted in place of the dropped identity tail. */
  identityTruncated: (originalIdentityMeasure: number, maxUnits: number) => string;
  /** Explanation appended when there is no verified identity span or even an empty identity cannot fit. */
  contextTruncated: (originalMeasure: number, maxUnits: number) => string;
}

/**
 * Shrink only the verified identity body so the prompt fits `maxUnits`.
 * Returns undefined when there is no verified span, or when even an empty identity
 * would not fit, so the caller can fall back to plain truncation.
 */
export function shrinkIdentityBodyToFit(
  input: SpannedText,
  maxUnits: number,
  measure: ContextMeasure,
  markers: PriorityPreservingCapMarkers,
): string | undefined {
  const span = verifyIdentitySpan(input.text, input.identity);
  if (!span) return undefined;
  const before = input.text.slice(0, span.start);
  const body = input.text.slice(span.start, span.end);
  const after = input.text.slice(span.end);
  const marker = markers.identityTruncated(measureContext(body, measure), maxUnits);
  const keep = maxUnits
    - measureContext(before, measure)
    - measureContext(after, measure)
    - measureContext(marker, measure);
  if (keep < 0) return undefined;
  return `${before}${prefixWithinBudget(body, keep, measure).trimEnd()}${marker}${after}`;
}

export function capContextPreservingPriority(
  input: SpannedText | string,
  maxUnits: number,
  measure: ContextMeasure,
  markers: PriorityPreservingCapMarkers,
): string {
  const spanned = typeof input === 'string' ? { text: input } : input;
  const { text } = spanned;
  if (measureContext(text, measure) <= maxUnits) return text;
  const identityShrunk = shrinkIdentityBodyToFit(spanned, maxUnits, measure, markers);
  if (identityShrunk !== undefined) return identityShrunk;
  const marker = markers.contextTruncated(measureContext(text, measure), maxUnits);
  const markerSize = measureContext(marker, measure);
  if (maxUnits <= markerSize + 16) return prefixWithinBudget(text, maxUnits, measure);
  return `${prefixWithinBudget(text, maxUnits - markerSize, measure).trimEnd()}${marker}`;
}
