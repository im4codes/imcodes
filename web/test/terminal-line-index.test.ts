import { describe, expect, it } from 'vitest';
import { isRenderableLineIndex, resolveDiffRows } from '../src/components/TerminalView.js';
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

  it('still accepts real line indices when the frame declares no usable rows', () => {
    // Regression: clamping an absent `rows` to 0 made every index unrenderable,
    // so incremental frames painted nothing and output only appeared when the
    // next full frame redrew the screen — streaming looked like one big dump.
    const { rows } = resolveDiffRows(undefined);
    expect(isRenderableLineIndex(0, rows)).toBe(true);
    expect(isRenderableLineIndex(23, rows)).toBe(true);
  });

  it('rejects non-integers, negatives and non-finite values', () => {
    expect(isRenderableLineIndex(-1, 24)).toBe(false);
    expect(isRenderableLineIndex(1.5, 24)).toBe(false);
    expect(isRenderableLineIndex(Number.NaN, 24)).toBe(false);
    expect(isRenderableLineIndex(Number.POSITIVE_INFINITY, 24)).toBe(false);
    expect(isRenderableLineIndex('3' as unknown, 24)).toBe(false);
  });
});

describe('resolveDiffRows', () => {
  it('reports what a well-formed frame declares', () => {
    expect(resolveDiffRows(24)).toEqual({ declaredRows: 24, rows: 24 });
  });

  it('separates "declares nothing" from "declares zero"', () => {
    // The distinction the regression collapsed. `declaredRows: 0` means the
    // frame really says the screen is empty and the buffer should be truncated;
    // `null` means it said nothing, and the buffer must be left alone.
    expect(resolveDiffRows(0)).toEqual({ declaredRows: 0, rows: 0 });
    expect(resolveDiffRows(undefined).declaredRows).toBeNull();
    expect(resolveDiffRows(Number.NaN).declaredRows).toBeNull();
    expect(resolveDiffRows('24' as unknown).declaredRows).toBeNull();
  });

  it('falls back to the protocol ceiling rather than to zero', () => {
    expect(resolveDiffRows(undefined).rows).toBe(TERMINAL_MAX_ROWS);
  });

  it('still caps a frame that claims more rows than the protocol allows', () => {
    expect(resolveDiffRows(TERMINAL_MAX_ROWS + 5_000)).toEqual({
      declaredRows: TERMINAL_MAX_ROWS,
      rows: TERMINAL_MAX_ROWS,
    });
  });
});
