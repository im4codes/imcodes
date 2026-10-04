/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { h } from 'preact';
import type { TimelineEvent } from '../../src/ws-client.js';
import {
  TIMELINE_HISTORY_CONTENT_TYPES,
  isGuaranteedVisibleTimelineEvent,
  isNeverRenderedTimelineEventType,
  projectAssistantTextForDisplay,
} from '../../../src/shared/timeline/types.js';
import { EXECUTION_CLONE_TIMELINE } from '../../../shared/execution-clone.js';
import {
  SUPERVISION_EXECUTION_STATES,
  SUPERVISION_EXECUTION_STATUS_MARKERS,
  parseSupervisionExecutionStateDetailsFromText,
} from '../../../shared/supervision-config.js';

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

  it('renders task-pair events as a full-width left-aligned card with role links', () => {
    const event = {
      ...ev('task_pair.event'),
      payload: {
        taskId: 'tsk_card_1234567890',
        title: 'A deliberately long task title that must wrap safely',
        writer: 'deck_brain',
        verb: 'REWORK',
        toStatus: 'rework',
        executor: 'deck_executor',
        executorLabel: 'Executor',
        auditor: 'deck_auditor',
        auditorLabel: 'Auditor',
        severityCounts: { P0: 1, P1: 0, P2: 2, P3: 0, P4: 0 },
        verdictJudgement: 'consistent',
      },
    } as unknown as TimelineEvent;
    const { container } = render(h(__ChatEventForTests as never, { event } as never));
    const card = container.querySelector('.task-pair-event-card') as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card?.getAttribute('data-task-id')).toBe('tsk_card_1234567890');
    expect(card?.classList.contains('task-pair-chip--rework')).toBe(true);
    expect(card?.textContent).toContain('A deliberately long task title');
    expect(card?.querySelector('.task-pair-card-body')).toBeNull();
    fireEvent.click(card?.querySelector('.task-pair-card-toggle')!);
    expect(card?.textContent).toContain('taskPair.card_executor');
    expect(card?.textContent).toContain('taskPair.card_auditor');
  });

  it('projects a daemon task creation notice into one card and suppresses its raw text', () => {
    const notice = '[IM.codes task tsk_notice "Create a card"]\nNeeds your decision: a participant is waiting on input. Executor deck_exec, auditor deck_aud, status rework, round 1.\nWhy: verify the exact head.';
    const assistant = {
      ...ev('assistant.text'),
      eventId: 'notice-text',
      payload: { text: notice },
    } as unknown as TimelineEvent;
    const items = __buildViewItemsForTests([assistant], true);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'assistant-block',
      taskPairNotification: expect.objectContaining({ taskId: 'tsk_notice', title: 'Create a card', toStatus: 'rework' }),
    });
    const { container } = render(<ChatView
      events={[assistant]}
      loading={false}
      ws={{} as never}
      workdir="/repo"
      sessionId="session-a"
    />);
    expect(container.querySelectorAll('.task-pair-event-card')).toHaveLength(1);
    expect(container.textContent).toContain('Create a card');
    expect(container.textContent).not.toContain('[IM.codes task tsk_notice');
  });

  it('keeps one structured card when the same task notice is also persisted as assistant text', () => {
    const taskId = 'tsk_duplicate';
    const assistant = {
      ...ev('assistant.text'),
      eventId: 'duplicate-text',
      payload: { text: `[IM.codes task ${taskId} "Duplicate"]\nPASS recorded for ${taskId}, status passed.` },
    } as unknown as TimelineEvent;
    const structured = {
      ...ev('task_pair.event'),
      eventId: 'duplicate-event',
      payload: { taskId, title: 'Duplicate', writer: 'daemon', verb: 'PASS', toStatus: 'passed', unusual: false },
    } as unknown as TimelineEvent;
    const items = __buildViewItemsForTests([assistant, structured], true);
    expect(items.filter((item) => item.type === 'assistant-block')).toHaveLength(0);
    expect(items.filter((item) => item.type === 'event')).toHaveLength(1);
  });

  it('cards inline dispatched-from-queue notices and suppresses the raw protocol text', () => {
    const notice = '[IM.codes task tsk_queue_dispatch "Queue dispatch"] dispatched from the queue: executor=deck_exec, auditor=deck_aud, status=working.';
    const assistant = {
      ...ev('assistant.text'),
      eventId: 'queue-dispatch-text',
      payload: { text: notice },
    } as unknown as TimelineEvent;
    const items = __buildViewItemsForTests([assistant], true);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'assistant-block',
      taskPairNotification: expect.objectContaining({
        taskId: 'tsk_queue_dispatch',
        title: 'Queue dispatch',
        verb: 'DISPATCH',
        toStatus: 'working',
        executor: 'deck_exec',
        auditor: 'deck_aud',
      }),
    });
    const { container } = render(<ChatView
      events={[assistant]}
      loading={false}
      ws={{} as never}
      workdir="/repo"
      sessionId="session-a"
    />);
    expect(container.querySelectorAll('.task-pair-event-card')).toHaveLength(1);
    expect(container.textContent).toContain('Queue dispatch');
    expect(container.textContent).not.toContain('dispatched from the queue');
  });

  it('cards audited PASS summaries and keeps task metadata in the expandable payload', () => {
    const notice = '[IM.codes task tsk_audited_done "Two-line collapse"]\nAudited pair done: executor deck_exec. Auditor deck_aud verdict: PASS (p0=0 p1=0).\nWorktree: /repo/task.';
    const assistant = {
      ...ev('assistant.text'),
      eventId: 'audited-pass-text',
      payload: { text: notice },
    } as unknown as TimelineEvent;
    const items = __buildViewItemsForTests([assistant], true);
    expect(items).toHaveLength(1);
    expect(items[0].taskPairNotification).toMatchObject({
      taskId: 'tsk_audited_done',
      title: 'Two-line collapse',
      verb: 'DONE',
      toStatus: 'done',
      executor: 'deck_exec',
      auditor: 'deck_aud',
    });
    const { container } = render(<ChatView
      events={[assistant]}
      loading={false}
      ws={{} as never}
      workdir="/repo"
      sessionId="session-a"
    />);
    const card = container.querySelector('.task-pair-event-card') as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(container.textContent).not.toContain('[IM.codes task tsk_audited_done');
    fireEvent.click(card?.querySelector('.task-pair-card-toggle')!);
    expect(card?.textContent).toContain('Audited pair done');
    expect(card?.querySelector('.task-pair-card-payload')?.textContent).toContain('tsk_audited_done');
  });

  it('cards a strict headerless audited summary when lifecycle and audit fields are present', () => {
    const assistant = {
      ...ev('assistant.text'),
      eventId: 'headerless-audited-pass',
      payload: { text: 'Audited pair done: tsk_headerless "Headerless audit"; executor deck_exec; auditor deck_aud; verdict PASS.' },
    } as unknown as TimelineEvent;
    const items = __buildViewItemsForTests([assistant], true);
    expect(items).toHaveLength(1);
    expect(items[0].taskPairNotification).toMatchObject({
      taskId: 'tsk_headerless',
      title: 'Headerless audit',
      verb: 'DONE',
      toStatus: 'done',
    });
  });

  it('keeps a completed audited-pair summary as DONE when its verdict is PASS', () => {
    const assistant = {
      ...ev('assistant.text'),
      eventId: 'audited-done-pass-verdict',
      payload: { text: '[IM.codes task tsk_done_pass "Completed pair"]\nAudited pair done: executor deck_exec.\nAuditor deck_aud verdict: PASS (p0=0 p1=0).\nWorktree: /repo/task.' },
    } as unknown as TimelineEvent;
    const items = __buildViewItemsForTests([assistant], true);
    expect(items).toHaveLength(1);
    expect(items[0].taskPairNotification).toMatchObject({
      taskId: 'tsk_done_pass',
      verb: 'DONE',
      toStatus: 'done',
    });
  });

  it.each([
    ['READY_FOR_AUDIT', 'in_audit'],
    ['DONE', 'done'],
    ['REWORK', 'rework'],
  ])('cards %s audit lifecycle summaries', (verb, status) => {
    const assistant = {
      ...ev('assistant.text'),
      eventId: `audit-${verb.toLowerCase()}`,
      payload: { text: `[IM.codes task tsk_audit_${verb.toLowerCase()} "Audit ${verb}"]\n${verb} status ${status}. executor deck_exec, auditor deck_aud.` },
    } as unknown as TimelineEvent;
    const items = __buildViewItemsForTests([assistant], true);
    expect(items).toHaveLength(1);
    expect(items[0].taskPairNotification).toMatchObject({ verb, toStatus: status });
  });

  it('does not reinterpret an ordinary sentence mentioning an audit summary', () => {
    const assistant = {
      ...ev('assistant.text'),
      eventId: 'audit-prose',
      payload: { text: 'Audited pair tsk_demo is a historical note, not a lifecycle status.' },
    } as unknown as TimelineEvent;
    const items = __buildViewItemsForTests([assistant], true);
    expect(items[0]).not.toHaveProperty('taskPairNotification');
  });

  it('keeps consecutive task notices as separate cards instead of dropping the first', () => {
    const first = {
      ...ev('assistant.text'),
      eventId: 'notice-first',
      ts: 1,
      payload: { text: '[IM.codes task tsk_first "First task"]\nDISPATCH status working.' },
    } as unknown as TimelineEvent;
    const second = {
      ...ev('assistant.text'),
      eventId: 'notice-second',
      ts: 2,
      payload: { text: '[IM.codes task tsk_second "Second task"]\nDISPATCH status working.' },
    } as unknown as TimelineEvent;

    const items = __buildViewItemsForTests([first, second], true);
    const cards = items.filter((item) => item.type === 'assistant-block');
    expect(cards).toHaveLength(2);
    expect(cards.map((item) => item.taskPairNotification?.taskId)).toEqual(['tsk_first', 'tsk_second']);
  });

  it('keeps incremental text for one notice in a single card', () => {
    const first = {
      ...ev('assistant.text'),
      eventId: 'notice-same-first',
      ts: 1,
      payload: { text: '[IM.codes task tsk_same "Same task"]\nQUEUE status queued.' },
    } as unknown as TimelineEvent;
    const second = {
      ...ev('assistant.text'),
      eventId: 'notice-same-second',
      ts: 2,
      payload: { text: '[IM.codes task tsk_same "Same task"]\nQUEUE status queued.\nWhy: waiting for a worker.' },
    } as unknown as TimelineEvent;

    const items = __buildViewItemsForTests([first, second], true);
    expect(items).toHaveLength(1);
    expect(items[0].taskPairNotification?.taskId).toBe('tsk_same');
    expect(items[0].text).toContain('waiting for a worker');
    expect(items[0].eventIds).toEqual(['notice-same-first', 'notice-same-second']);
  });

  it('converts strict protocol markers but leaves fenced examples and user prose untouched', () => {
    const marker = {
      ...ev('assistant.text'),
      eventId: 'dispatch-marker',
      payload: { text: '<!-- IMCODES_TASK DISPATCH tsk_marker title="Dispatch card" -->' },
    } as unknown as TimelineEvent;
    const fenced = {
      ...ev('assistant.text'),
      eventId: 'fenced-marker',
      payload: { text: '```\n[IM.codes task tsk_fake "Example"]\nstatus rework\n```' },
    } as unknown as TimelineEvent;
    const prose = {
      ...ev('user.message'),
      eventId: 'user-prose',
      payload: { text: 'Please discuss [IM.codes task tsk_prose "not a task"] in this sentence.' },
    } as unknown as TimelineEvent;
    const markerItems = __buildViewItemsForTests([marker], true);
    expect(markerItems[0]).toMatchObject({ taskPairNotification: expect.objectContaining({ taskId: 'tsk_marker', verb: 'DISPATCH' }) });
    const fencedItems = __buildViewItemsForTests([fenced], true);
    expect(fencedItems[0]).not.toHaveProperty('taskPairNotification');
    expect(fencedItems[0]).toMatchObject({ type: 'assistant-block' });
    const proseItems = __buildViewItemsForTests([prose], true);
    expect(proseItems[0]).toMatchObject({ type: 'event', event: prose });
  });

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

  it('hides machine-only supervision markers while preserving the assistant message', () => {
    const event = {
      ...ev('assistant.text'),
      payload: {
        text: `仍在等待已委派任务。\n${SUPERVISION_EXECUTION_STATUS_MARKERS.WAITING}`,
      },
    } as unknown as TimelineEvent;
    const items = __buildViewItemsForTests([event], false);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'assistant-block', text: '仍在等待已委派任务。' });

    const markerOnly = {
      ...event,
      eventId: 'marker-only',
      payload: { text: SUPERVISION_EXECUTION_STATUS_MARKERS.NEEDS_INPUT },
    } as unknown as TimelineEvent;
    expect(__buildViewItemsForTests([markerOnly], false)).toEqual([
      expect.objectContaining({
        type: 'assistant-block',
        text: '',
        executionState: SUPERVISION_EXECUTION_STATES.NEEDS_INPUT,
      }),
    ]);
    expect(isGuaranteedVisibleTimelineEvent(markerOnly)).toBe(true);
  });

  it('keeps daemon execution parsing authoritative while the display projection hides only active markers', () => {
    for (const [marker, state] of [
      [SUPERVISION_EXECUTION_STATUS_MARKERS.WAITING, SUPERVISION_EXECUTION_STATES.WAITING],
      [SUPERVISION_EXECUTION_STATUS_MARKERS.NEEDS_INPUT, SUPERVISION_EXECUTION_STATES.NEEDS_INPUT],
    ] as const) {
      const raw = `Visible answer\n${marker}`;
      expect(parseSupervisionExecutionStateDetailsFromText(raw).state).toBe(state);
      expect(projectAssistantTextForDisplay(raw)).toEqual({ text: 'Visible answer', executionState: state });
      expect(projectAssistantTextForDisplay(marker)).toEqual({ text: '', executionState: state });
    }

    const ordinary = 'Ordinary assistant answer';
    expect(parseSupervisionExecutionStateDetailsFromText(ordinary).state).toBeNull();
    expect(projectAssistantTextForDisplay(ordinary)).toEqual({ text: ordinary, executionState: null });

    const examples = [
      `> ${SUPERVISION_EXECUTION_STATUS_MARKERS.WAITING}`,
      '```md',
      SUPERVISION_EXECUTION_STATUS_MARKERS.NEEDS_INPUT,
      '```',
    ].join('\n');
    expect(parseSupervisionExecutionStateDetailsFromText(examples).state).toBeNull();
    expect(projectAssistantTextForDisplay(examples)).toEqual({ text: examples, executionState: null });
  });

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
