import { describe, expect, it } from 'vitest';
import { isRenderableLineIndex } from '../src/components/TerminalView.js';
import { TERMINAL_MAX_ROWS } from '@shared/terminal-limits.js';

/**
 * `applyDiff` has two consumers of `lineIdx`: the line array (which is then
 * sliced to `rows`) and the ANSI cursor-addressing path (which writes
 * `\x1b[<row>;1H` directly). They must agree on which rows exist.
 *
 * They previously did not: the array path sliced to `rows` while the ANSI path
 * only checked the absolute maximum, so a frame with `rows=1` and a line at
 * index 1000 dropped the line from the array yet still emitted a write for row
 * 1001 — outside the screen the frame had just declared. Both now go through
 * this single predicate.
 */
describe('isRenderableLineIndex', () => {
  it('accepts indices inside the frame', () => {
    expect(isRenderableLineIndex(0, 24)).toBe(true);
    expect(isRenderableLineIndex(23, 24)).toBe(true);
  });

  it('rejects indices at or past the frame height', () => {
    // The case the two paths used to disagree on.
    expect(isRenderableLineIndex(24, 24)).toBe(false);
    expect(isRenderableLineIndex(1000, 1)).toBe(false);
  });

  it('rejects anything past the protocol ceiling even when rows claims more', () => {
    expect(isRenderableLineIndex(TERMINAL_MAX_ROWS, TERMINAL_MAX_ROWS + 500)).toBe(false);
  });

  it('rejects non-integers, negatives and non-finite values', () => {
    expect(isRenderableLineIndex(-1, 24)).toBe(false);
    expect(isRenderableLineIndex(1.5, 24)).toBe(false);
    expect(isRenderableLineIndex(Number.NaN, 24)).toBe(false);
    expect(isRenderableLineIndex(Number.POSITIVE_INFINITY, 24)).toBe(false);
    expect(isRenderableLineIndex('3' as unknown, 24)).toBe(false);
  });
});
