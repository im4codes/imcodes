import { describe, expect, it } from 'vitest';
import { computeMeasuredScrollCorrection, computeReaderAnchorDelta, pickReaderAnchor } from '../src/chat-scroll-anchoring.js';

describe('chat scroll anchoring', () => {
  it('pins using the pre-growth bottom state, not the post-growth distance', () => {
    // The row grew while scrollTop still has the old bottom value.  The
    // post-growth distance is 120px, but this is still a pinned stream and
    // must advance to the new bottom rather than applying an anchor delta.
    expect(computeMeasuredScrollCorrection({
      wasAtBottom: true,
      autoFollow: true,
      currentTop: 1_000,
      scrollHeight: 1_320,
      clientHeight: 200,
      anchorDelta: 120,
    })).toEqual({ kind: 'pin', targetTop: 1_120 });
  });

  it('compensates a reader anchor exactly once when content grows above it', () => {
    expect(computeMeasuredScrollCorrection({
      wasAtBottom: false,
      autoFollow: false,
      currentTop: 640,
      scrollHeight: 1_800,
      clientHeight: 400,
      anchorDelta: 48,
    })).toEqual({ kind: 'anchor', delta: 48 });
  });

  it('does not re-engage a reader or fight an explicit scroll-away', () => {
    expect(computeMeasuredScrollCorrection({
      wasAtBottom: true,
      autoFollow: false,
      currentTop: 1_000,
      scrollHeight: 1_320,
      clientHeight: 200,
      anchorDelta: 120,
    })).toBeNull();
  });

  it('picks the first row that reaches into the viewport as the reader anchor', () => {
    const rows = [
      { id: 'a', top: -300, bottom: -120 },
      { id: 'b', top: -40, bottom: 60 }, // straddles the viewport top
      { id: 'c', top: 60, bottom: 160 },
    ];
    expect(pickReaderAnchor(rows, 0, 900)).toEqual({ id: 'b', offset: -40, scrollTop: 900 });
    expect(pickReaderAnchor([], 0, 0)).toBeNull();
    expect(pickReaderAnchor([{ id: 'x', top: -50, bottom: 0.5 }], 0, 0)).toBeNull();
  });

  it('re-aligns a reader anchor by exactly the layout shift, once, ignoring sub-pixel noise', () => {
    expect(computeReaderAnchorDelta(-40, 110)).toBe(150);
    expect(computeReaderAnchorDelta(-40, -40)).toBe(0);
    expect(computeReaderAnchorDelta(-40, -39.7)).toBe(0);
    expect(computeReaderAnchorDelta(20, -12)).toBe(-32);
  });
});
