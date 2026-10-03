import { describe, expect, it } from 'vitest';
import { computeMeasuredScrollCorrection, computeReaderAnchorDelta, pickReaderAnchor, reconcileTopOffset, topOffsetStyle } from '../src/chat-scroll-anchoring.js';

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

  it('picks the first row that reaches into the viewport as the reader anchor, in scroll-content coordinates', () => {
    const rows = [
      { id: 'a', top: -300, bottom: -120 },
      { id: 'b', top: -40, bottom: 60 }, // straddles the viewport top
      { id: 'c', top: 60, bottom: 160 },
    ];
    // viewport top at 0, scrolled 900px down: row b's top sits at 900 - 40 in the content.
    expect(pickReaderAnchor(rows, 0, 900)).toEqual({ id: 'b', contentTop: 860 });
    // the viewport itself sits 80px down the page: viewport-relative tops are shifted by it
    expect(pickReaderAnchor(rows.map((r) => ({ ...r, top: r.top + 80, bottom: r.bottom + 80 })), 80, 900)).toEqual({ id: 'b', contentTop: 860 });
    expect(pickReaderAnchor([], 0, 0)).toBeNull();
    expect(pickReaderAnchor([{ id: 'x', top: -50, bottom: 0.5 }], 0, 0)).toBeNull();
  });

  it('a reader scrolling (touch, momentum, wheel) never looks like a layout shift', () => {
    // Anchor recorded at scrollTop 900 with the row 40px above the viewport top.
    const anchor = pickReaderAnchor([{ id: 'b', top: -40, bottom: 60 }], 0, 900)!;
    // The reader scrolls 500px further up: scrollTop 400 and the row is now 460px BELOW the viewport top.
    const currentContentTop = 460 + 400;
    expect(computeReaderAnchorDelta(anchor.contentTop, currentContentTop)).toBe(0);
  });

  it('measures the layout shift above the anchor exactly, once, ignoring sub-pixel noise', () => {
    expect(computeReaderAnchorDelta(860, 1010)).toBe(150); // pushed down by 150
    expect(computeReaderAnchorDelta(860, 860)).toBe(0);
    expect(computeReaderAnchorDelta(860, 860.3)).toBe(0);
    expect(computeReaderAnchorDelta(860, 828)).toBe(-32); // content above shrank
  });

  it('renders a top offset as a spacer height, or as a negative margin when it is below the scroll origin', () => {
    expect(topOffsetStyle(120)).toEqual({ height: 120, marginTop: 0 });
    expect(topOffsetStyle(0)).toEqual({ height: 0, marginTop: 0 });
    expect(topOffsetStyle(-300)).toEqual({ height: 0, marginTop: -300 });
  });

  it('reconciles an unreachable top offset with one compensating scrollTop delta', () => {
    expect(reconcileTopOffset(-300, false, 40)).toEqual({ x: 0, scrollTopDelta: 300 });
    // a blank gap above the first message is closed, taking it off scrollTop
    expect(reconcileTopOffset(200, true, 1_000)).toEqual({ x: 0, scrollTopDelta: -200 });
    // parked near the top: scrollTop gives what it has, the rest stays as top padding
    expect(reconcileTopOffset(200, true, 50)).toEqual({ x: 150, scrollTopDelta: -50 });
    // at the very top nothing can move without moving the message being read
    expect(reconcileTopOffset(15, true, 0)).toBeNull();
    // a positive offset with rows still above the mounted range is a normal spacer
    expect(reconcileTopOffset(200, false, 1_000)).toBeNull();
    expect(reconcileTopOffset(0, true, 1_000)).toBeNull();
  });
});
