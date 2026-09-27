import { describe, expect, it } from 'vitest';
import { computeMeasuredScrollCorrection } from '../src/chat-scroll-anchoring.js';

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
});
