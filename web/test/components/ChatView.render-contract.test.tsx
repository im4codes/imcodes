/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';
import type { TimelineEvent } from '../../src/ws-client.js';
import {
  TIMELINE_HISTORY_CONTENT_TYPES,
  isGuaranteedVisibleTimelineEvent,
  isNeverRenderedTimelineEventType,
} from '../../../src/shared/timeline/types.js';
import { EXECUTION_CLONE_TIMELINE } from '../../../shared/execution-clone.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ChatView, __ChatEventForTests, __buildViewItemsForTests } from '../../src/components/ChatView.js';

/**
 * The drift guard.
 *
 * Whether an event type can be drawn lives in `ChatEvent`'s switch, but three
 * other places act on the same question: the ViewItem push suppression, the
 * bootstrap "is this pane starved" check, and the post-drain "does the pane
 * have content yet" check. A hand-maintained list of exceptions drifted the
 * moment it was written — `peer_audit.status` returns null explicitly, and
 * `ask.question` / `memory.compression` / `execution_clone.terminal` fall
 * through to `default: return null` — and every one of them still produced a
 * ViewItem that drew nothing.
 *
 * So this asserts the INVARIANT rather than a list: for every content type the
 * timeline can store, a pane containing only that type must never offer to load
 * more history while showing nothing. Any future type added without a renderer
 * fails here instead of silently reproducing the blank pane.
 */

const ALL_CONTENT_TYPES = [
  ...TIMELINE_HISTORY_CONTENT_TYPES,
  EXECUTION_CLONE_TIMELINE.TERMINAL,
];

function ev(type: string, hidden = false): TimelineEvent {
  return {
    eventId: `e-${type}`,
    ...(hidden ? { hidden: true } : {}),
    sessionId: 'session-a',
    ts: 1,
    epoch: 1,
    seq: 1,
    source: 'daemon',
    confidence: 'high',
    type,
    // Enough shape for the renderers that do exist; irrelevant for the rest.
    // Some renderers are payload-dependent (FileChangeCard draws nothing for an
    // empty batch), so the fixture has to be valid or the measurement would be
    // testing the fixture rather than the type.
    payload: {
      text: `body of ${type}`,
      state: 'running',
      detail: `detail of ${type}`,
      status: 'succeeded',
      verdict: 'PASS',
      batch: {
        provider: 'claude-code',
        patches: [{
          filePath: 'a.ts',
          operation: 'update',
          confidence: 'exact',
          beforeText: 'x',
          afterText: 'y',
        }],
      },
    },
  } as unknown as TimelineEvent;
}

function renderOnly(type: string) {
  return render(
    <ChatView
      events={[ev(type)]}
      loading={false}
      ws={{} as never}
      workdir="/repo"
      sessionId="session-a"
      onLoadOlder={() => { /* makes the button eligible */ }}
    />,
  );
}

function loadOlderOffered(container: HTMLElement): boolean {
  return [...container.querySelectorAll('button')]
    .some((node) => (node.textContent ?? '').includes('chat.load_older'));
}

describe('ChatView render capability contract', () => {
  afterEach(() => cleanup());

  it.each(ALL_CONTENT_TYPES.map((type) => [type]))(
    'classifies %s to match what the renderer actually draws',
    (type) => {
      // Ground truth, measured — not asserted from the same list under test.
      const direct = render(
        h(__ChatEventForTests as never, { event: ev(type as string) } as never),
      );
      const drawsSomething = type === 'assistant.text'
        ? true
        : (direct.container.innerHTML ?? '').trim().length > 0;
      cleanup();

      expect(
        isNeverRenderedTimelineEventType(type as string),
        `${type} draws ${drawsSomething ? 'something' : 'nothing'}, but is classified as `
          + `${isNeverRenderedTimelineEventType(type as string) ? 'never-rendered' : 'renderable'}`,
      ).toBe(!drawsSomething);
    },
  );

  it.each(ALL_CONTENT_TYPES.map((type) => [type]))(
    'a %s the cache calls guaranteed-visible really does survive the full pipeline',
    (type) => {
      // The full production path — isVisibleChatTimelineEvent -> buildViewItems
      // -> ChatEvent — not the renderer in isolation. `useTimeline` trusts
      // `isGuaranteedVisibleTimelineEvent` to decide whether a pane still needs
      // repairing, so anything it calls visible must actually reach the screen.
      const event = ev(type as string);
      if (!isGuaranteedVisibleTimelineEvent(event)) return;

      for (const showToolCalls of [true, false]) {
        expect(
          __buildViewItemsForTests([event], showToolCalls).length,
          `${type} is called guaranteed-visible but produced no ViewItem `
            + `(showToolCalls=${showToolCalls})`,
        ).toBeGreaterThan(0);
      }

      const { container } = renderOnly(type as string);
      expect(
        (container.textContent ?? '').includes('chat.no_events'),
        `${type} is called guaranteed-visible but the pane rendered the empty state`,
      ).toBe(false);
    },
  );

  it.each(ALL_CONTENT_TYPES.map((type) => [type]))(
    'a hidden %s is never counted as visible content',
    (type) => {
      // Deleted messages are re-emitted with hidden:true and persisted, so they
      // really do appear at the top of restored windows.
      const hiddenEvent = ev(type as string, true);
      expect(
        isGuaranteedVisibleTimelineEvent(hiddenEvent),
        `a hidden ${type} was classified as visible content`,
      ).toBe(false);
      for (const showToolCalls of [true, false]) {
        expect(
          __buildViewItemsForTests([hiddenEvent], showToolCalls).length,
          `a hidden ${type} still produced a ViewItem (showToolCalls=${showToolCalls})`,
        ).toBe(0);
      }
    },
  );

  it.each([[''], ['   '], ['\n\n  \n']])(
    'a blank assistant.text (%j) is never counted as visible content',
    (blank) => {
      // Same payload-granularity class as `hidden`: the type is renderable, the
      // event is not.
      const blankEvent = {
        ...ev('assistant.text'),
        payload: { text: blank },
      } as unknown as TimelineEvent;

      expect(
        isGuaranteedVisibleTimelineEvent(blankEvent),
        'a blank assistant row was classified as visible content',
      ).toBe(false);
      for (const showToolCalls of [true, false]) {
        expect(
          __buildViewItemsForTests([blankEvent], showToolCalls).length,
          `a blank assistant row still produced a ViewItem (showToolCalls=${showToolCalls})`,
        ).toBe(0);
      }
    },
  );

  it.each(ALL_CONTENT_TYPES.map((type) => [type]))(
    'never offers older history for a pane made only of %s unless it drew something',
    (type) => {
      const { container } = renderOnly(type as string);
      if (!loadOlderOffered(container)) return;
      expect(
        (container.textContent ?? '').includes('chat.no_events'),
        `${type} offered "load earlier" while rendering the empty-state placeholder`,
      ).toBe(false);
    },
  );
});
