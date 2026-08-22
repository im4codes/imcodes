/** @vitest-environment jsdom */
/**
 * The windowed derivation has one job: produce exactly what the full
 * derivation would have produced for the part the reader can see, at a cost
 * that does not grow with how long the conversation is.
 *
 * The first half is what this file protects. A window that is subtly different
 * from the whole — a tool result that failed to merge, an assistant block cut
 * in half — would show up as a wrong row rather than a crash, so it is compared
 * item by item against the authoritative derivation.
 */
import { describe, expect, it, vi } from 'vitest';

// ChatView pulls in the i18n runtime on import; these tests exercise its pure
// derivation, so the runtime is stubbed rather than started.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key.split('.').pop() ?? key, i18n: { language: 'en' } }),
}));
vi.mock('../src/components/FileBrowser.js', () => ({ FileBrowser: () => null }));
vi.mock('../src/api.js', () => ({ downloadAttachment: vi.fn() }));
import {
  __buildViewItemsForTests,
  __buildViewItemsTailForTests,
} from '../src/components/ChatView.js';
import type { TimelineEvent } from '../src/ws-client.js';

function ev(seq: number, type: string, payload: Record<string, unknown>): TimelineEvent {
  return {
    eventId: `event_${seq}`,
    sessionId: 'tail-test',
    ts: 1_000 + seq,
    seq,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type,
    payload,
  } as TimelineEvent;
}

/** A conversation with text, tool calls and their results, and memory links. */
function mixedSession(turns: number): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  let seq = 0;
  for (let i = 0; i < turns; i++) {
    events.push(ev(seq++, 'user.message', { text: `question ${i}` }));
    events.push(ev(seq++, 'assistant.text', { text: `answer ${i} with some length to it` }));
    if (i % 3 === 0) {
      const callSeq = seq++;
      events.push({ ...ev(callSeq, 'tool.call', { tool: 'Bash', input: { command: `run ${i}` }, toolCallId: `call_${i}` }) });
      events.push(ev(seq++, 'tool.result', { output: `output ${i}`, toolCallId: `call_${i}` }));
    }
  }
  return events;
}

/** Compare items by the identity the renderer actually keys and renders on. */
function shape(items: ReturnType<typeof __buildViewItemsForTests>) {
  return items.map((item) => ({
    key: item.key,
    type: item.type,
    text: item.text,
    eventId: item.event?.eventId,
    toolEventIds: item.toolEvents?.map((event) => event.eventId),
    linkedEventIds: item.linkedEvents?.map((event) => event.eventId),
  }));
}

describe('windowed view-item derivation', () => {
  for (const showToolCalls of [true, false]) {
    it(`matches the full derivation for the visible tail (showToolCalls=${showToolCalls})`, () => {
      const events = mixedSession(400);
      const want = 150;
      const full = __buildViewItemsForTests(events, showToolCalls);
      const tail = __buildViewItemsTailForTests(events, showToolCalls, want);

      // Non-vacuity: the window really did stop short of the beginning, so this
      // is comparing a windowed derivation and not an accidental full one.
      expect(tail.windowStartIndex).toBeGreaterThan(0);
      expect(tail.items.length).toBeGreaterThanOrEqual(want);

      // The renderer shows the last `want` items. Those must be identical.
      expect(shape(tail.items.slice(-want))).toEqual(shape(full.slice(-want)));
    });
  }

  it('derives the whole history when it is short enough', () => {
    const events = mixedSession(10);
    const tail = __buildViewItemsTailForTests(events, true, 150);
    expect(tail.windowStartIndex).toBe(0);
    expect(shape(tail.items)).toEqual(shape(__buildViewItemsForTests(events, true)));
  });

  it('widens the window when the tail collapses into almost no items', () => {
    // The first guess at how many events a window needs is a multiple of the
    // items wanted. A long run of tool calls at the END of the session breaks
    // that guess badly: they group into a single item, so the guessed window
    // yields one item where a hundred were asked for. Without widening, the
    // reader would be handed a conversation consisting of one tool group and
    // nothing else — every message before it silently gone.
    const events: TimelineEvent[] = [];
    let seq = 0;
    for (let i = 0; i < 300; i++) {
      events.push(ev(seq++, 'user.message', { text: `question ${i}` }));
      events.push(ev(seq++, 'assistant.text', { text: `answer ${i}` }));
    }
    const conversationEvents = events.length;
    for (let i = 0; i < 3_000; i++) {
      events.push(ev(seq++, 'tool.call', { tool: 'Bash', input: { command: `step ${i}` }, toolCallId: `c${i}` }));
    }

    const tail = __buildViewItemsTailForTests(events, true, 150);

    // The guessed window is a few hundred events — all of them tool calls, all
    // one item. Reaching 150 items means it had to look much further back.
    expect(tail.items.length).toBeGreaterThanOrEqual(150);
    expect(tail.windowStartIndex).toBeLessThan(conversationEvents);
    // And it terminated rather than walking to the start for no reason.
    expect(tail.items.some((item) => item.type === 'tool-group' || item.type === 'tool-activity')).toBe(true);
  });

  it('examines the same number of events no matter how long the conversation is', () => {
    // The property that matters is that derivation reads a bounded window
    // rather than the whole session. Asserting that structurally rather than by
    // wall clock keeps it deterministic: timing sub-10ms work on a shared CI
    // host measures the host's mood, and a single slow sample on either side of
    // a ratio decides the result. The real end-to-end cost is guarded in a
    // browser by e2e/chat-timeline-scaling.perf.spec.ts.
    const examined = (events: TimelineEvent[]): number => {
      const { windowStartIndex } = __buildViewItemsTailForTests(events, true, 150);
      return events.length - windowStartIndex;
    };

    const long = examined(mixedSession(4_000));
    const muchLonger = examined(mixedSession(16_000));

    expect(muchLonger).toBe(long);
    // Non-vacuous: a window that covered everything would also be "the same".
    expect(muchLonger).toBeLessThan(4_000);
  });
});

describe('reaching a message older than the derivation window', () => {
  /**
   * The window is what makes an update cheap, and it is also the thing that can
   * quietly put a message out of reach. A pin exists precisely to jump to
   * something far back, so this is the one path where "not derived yet" must
   * never read as "not found".
   */
  it('widens far enough to derive a target near the beginning of a long session', () => {
    const events = mixedSession(2_000);
    const oldest = events[0]!;

    // As the renderer asks for it: the initial cap, which derives a window that
    // stops well short of this event.
    const initial = __buildViewItemsTailForTests(events, true, 60);
    expect(initial.windowStartIndex).toBeGreaterThan(0);
    expect(initial.items.some((item) => item.event?.eventId === oldest.eventId)).toBe(false);

    // ChatView's response is to raise the render limit, which widens the
    // window. Repeat that until the target is derived, exactly as the effect
    // does across renders, and check it terminates somewhere sane.
    let limit = 60;
    let found = false;
    let rounds = 0;
    while (!found && rounds < 40) {
      limit += 250;
      rounds += 1;
      const widened = __buildViewItemsTailForTests(events, true, limit);
      found = widened.items.some((item) => item.event?.eventId === oldest.eventId);
      if (widened.windowStartIndex === 0) break;
    }

    expect(found, 'the oldest message must become reachable by widening').toBe(true);
    // Bounded: a navigation that needed dozens of rounds would be a stall the
    // reader sees, not a jump.
    expect(rounds).toBeLessThan(40);
  });
});
