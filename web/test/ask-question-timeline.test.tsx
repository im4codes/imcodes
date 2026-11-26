/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { h } from 'preact';
import type { TimelineEvent } from '../src/ws-client.js';
import {
  isAskQuestionSessionVisible,
  type AskQuestionSessionVisibilityState,
} from '../src/ask-question-visibility.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      typeof opts?.defaultValue === 'string' ? opts.defaultValue : key,
    i18n: { language: 'en' },
  }),
}));

import { ChatView } from '../src/components/ChatView.js';

afterEach(() => {
  cleanup();
});

function makeAskEvent(
  eventId: string,
  questions: unknown,
  toolUseId = `tu-${eventId}`,
  ts = 1_700_000_000_000,
): TimelineEvent {
  return {
    eventId,
    sessionId: 'deck_proj_brain',
    ts,
    seq: Number(eventId.replace(/\D/g, '') || 1),
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type: 'ask.question',
    payload: { toolUseId, questions },
  };
}

function makeTextEvent(
  eventId: string,
  type: 'user.message' | 'assistant.text',
  text: string,
  streaming = false,
  ts = 1_700_000_001_000,
): TimelineEvent {
  return {
    eventId,
    sessionId: 'deck_proj_brain',
    ts,
    seq: Number(eventId.replace(/\D/g, '') || 2),
    epoch: 1,
    source: type === 'user.message' ? 'user' : 'daemon',
    confidence: 'high',
    type,
    payload: type === 'assistant.text' ? { text, streaming } : { text },
  };
}

describe('ask.question timeline card in ChatView', () => {
  it('renders single-question header, text, and option labels + descriptions inline', () => {
    const events = [
      makeAskEvent('ask-1', [
        {
          header: 'Deploy target',
          question: 'Where should we deploy this build?',
          options: [
            { label: 'Staging', description: 'Internal verification environment' },
            { label: 'Production' },
          ],
        },
      ]),
      makeTextEvent('u-2', 'user.message', 'Staging'),
    ];

    const { container } = render(
      <ChatView
        events={events}
        loading={false}
        preview
      />,
    );

    const card = container.querySelector('[data-event-id="ask-1"].ask-question-timeline-card');
    expect(card).not.toBeNull();
    expect(card?.classList.contains('ask-question-timeline-card-compact')).toBe(true);
    expect(card?.classList.contains('ask-question-timeline-card-answered')).toBe(true);
    expect(card?.getAttribute('data-ask-state')).toBe('answered');
    const badge = card?.querySelector('.ask-question-compact-badge');
    expect(badge?.textContent).toBe('Answered');
    expect(badge?.classList.contains('is-unanswered')).toBe(false);
    expect(card?.textContent).toContain('Deploy target');
    expect(card?.textContent).toContain('Where should we deploy this build?');
    expect(card?.querySelector('.ask-question-compact-answer')?.textContent).toBe('Staging');
    // Compact answered card must omit unselected option boxes and every interactive control
    expect(card?.textContent).not.toContain('Internal verification environment');
    expect(card?.textContent).not.toContain('Production');
    expect(card?.querySelector('input')).toBeNull();
    expect(card?.querySelector('button')).toBeNull();
    expect(card?.querySelector('label')).toBeNull();
    expect(card?.querySelector('.ask-question-timeline-options')).toBeNull();
  });

  it('renders multi-question payloads as compact non-interactive summary after superseded by assistant.text', () => {
    const events = [
      makeAskEvent('ask-multi', [
        {
          header: 'Scope',
          question: 'Which checks should run?',
          options: [{ label: 'Unit' }, { label: 'Integration' }],
        },
        {
          question: 'Any release notes?',
        },
      ]),
      // Model self-continued well after the 2s pre-ask flush tolerance window
      makeTextEvent('a-2', 'assistant.text', 'Continuing with defaults.', false, 1_700_000_005_000),
    ];

    const onAskAnswer = vi.fn();
    const { container } = render(
      <ChatView
        events={events}
        loading={false}
        preview={false}
        onAskAnswer={onAskAnswer}
      />,
    );

    const card = container.querySelector('[data-event-id="ask-multi"].ask-question-timeline-card');
    expect(card).not.toBeNull();
    expect(card?.classList.contains('ask-question-timeline-card-compact')).toBe(true);
    expect(card?.getAttribute('data-ask-state')).toBe('answered');
    const badge = card?.querySelector('.ask-question-compact-badge');
    expect(badge?.textContent).toBe('Question asked');
    expect(badge?.classList.contains('is-unanswered')).toBe(true);
    expect(card?.textContent).toContain('Scope');
    expect(card?.textContent).toContain('Which checks should run?');
    expect(card?.textContent).toContain('Any release notes?');
    // Superseded unanswered card does not render verbose option lists, Answered badge, or inputs
    expect(card?.textContent).not.toContain('Answered');
    expect(card?.querySelector('.ask-question-compact-answer')).toBeNull();
    expect(card?.querySelector('.ask-question-timeline-options')).toBeNull();
    expect(card?.querySelector('input')).toBeNull();
    expect(card?.querySelector('button.ask-btn-submit')).toBeNull();
  });

  it('uses Question asked badge when an ask card has no attributed answer after a 100ms assistant continuation + unrelated user message', () => {
    const events = [
      makeAskEvent('ask-100ms', [{ header: 'Check', question: 'Confirm rollout?', options: [{ label: 'Yes' }] }], 'tu-100ms', 1_700_000_000_000),
      makeTextEvent('a-100ms', 'assistant.text', 'Proceeding without answer.', false, 1_700_000_000_100),
      makeTextEvent('u-unrelated', 'user.message', 'Restart worker', false, 1_700_000_000_500),
    ];

    const { container } = render(<ChatView events={events} loading={false} />);
    const card = container.querySelector('[data-event-id="ask-100ms"].ask-question-timeline-card');
    expect(card).not.toBeNull();
    expect(card?.classList.contains('ask-question-timeline-card-compact')).toBe(true);
    expect(card?.getAttribute('data-ask-state')).toBe('answered');
    const badge = card?.querySelector('.ask-question-compact-badge');
    expect(badge?.textContent).toBe('Question asked');
    expect(badge?.classList.contains('is-unanswered')).toBe(true);
    expect(card?.querySelector('.ask-question-compact-answer')).toBeNull();
  });

  it('allows selecting a single-select option and submitting inline for the trailing pending question', () => {
    const onAskAnswer = vi.fn(() => true);
    const events = [
      makeAskEvent('ask-old', [{ header: 'Old', question: 'Old question?', options: [{ label: 'Yes' }] }], 'tu-old', 1_700_000_000_000),
      makeTextEvent('u-old', 'user.message', 'Yes', false, 1_700_000_000_500),
      makeAskEvent('ask-live', [
        {
          header: 'Mode',
          question: 'Pick execution mode',
          options: [
            { label: 'Fast', description: 'Skip slow checks' },
            { label: 'Full', description: 'Run entire suite' },
          ],
        },
      ], 'tu-live', 1_700_000_001_000),
    ];

    const { container } = render(
      <ChatView
        events={events}
        loading={false}
        onAskAnswer={onAskAnswer}
      />,
    );

    const oldCard = container.querySelector('[data-event-id="ask-old"]');
    expect(oldCard?.querySelector('button.ask-btn-submit')).toBeNull();

    const liveCard = container.querySelector('[data-event-id="ask-live"]');
    expect(liveCard).not.toBeNull();
    const radios = liveCard!.querySelectorAll('input[type="radio"]');
    expect(radios.length).toBe(2);

    fireEvent.click(radios[1]!);
    const submitBtn = liveCard!.querySelector('button.ask-btn-submit') as HTMLButtonElement | null;
    expect(submitBtn).not.toBeNull();
    fireEvent.click(submitBtn!);

    expect(onAskAnswer).toHaveBeenCalledTimes(1);
    expect(onAskAnswer).toHaveBeenCalledWith('tu-live', '[Mode] Full');
    // Transitions cleanly to read-only after successful submit
    expect(container.querySelector('[data-event-id="ask-live"] button.ask-btn-submit')).toBeNull();
  });

  it('supports multiSelect checkboxes, custom text, multi-question submit, and retry when send fails', () => {
    let returnOk = false;
    const onAskAnswer = vi.fn(() => returnOk);
    const events = [
      makeAskEvent('ask-m', [
        {
          header: 'Targets',
          question: 'Select targets',
          multiSelect: true,
          options: [{ label: 'Web' }, { label: 'Server' }, { label: 'CLI' }],
        },
        {
          header: 'Notes',
          question: 'Extra notes',
        },
      ], 'tu-m'),
      // Streaming assistant.text does NOT resolve a trailing ask.question
      makeTextEvent('a-stream', 'assistant.text', 'working...', true),
    ];

    const { container } = render(
      <ChatView
        events={events}
        loading={false}
        onAskAnswer={onAskAnswer}
      />,
    );

    const card = container.querySelector('[data-event-id="ask-m"]')!;
    const checkboxes = card.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(3);

    fireEvent.click(checkboxes[0]!);
    fireEvent.click(checkboxes[2]!);

    const inputs = card.querySelectorAll('input.ask-custom-input');
    expect(inputs.length).toBe(2);
    fireEvent.input(inputs[0]!, { target: { value: 'urgent' } });
    fireEvent.input(inputs[1]!, { target: { value: 'ship tonight' } });

    const submitBtn = card.querySelector('button.ask-btn-submit') as HTMLButtonElement;
    fireEvent.click(submitBtn);
    expect(onAskAnswer).toHaveBeenLastCalledWith('tu-m', '[Targets] Web, CLI, urgent\n[Notes] ship tonight');
    // Returning false keeps the inline selector open with selections intact for retry
    expect(card.querySelector('button.ask-btn-submit')).not.toBeNull();

    returnOk = true;
    fireEvent.click(card.querySelector('button.ask-btn-submit')!);
    expect(onAskAnswer).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.chat-pending-ask-dock')).toBeNull();
    expect(container.querySelector('[data-event-id="ask-m"] button.ask-btn-submit')).toBeNull();
  });

  it('renders malformed and empty ask.question payloads safely without throwing', () => {
    const events = [
      makeAskEvent('ask-empty', []),
      makeAskEvent('ask-null', null),
      makeAskEvent('ask-bad', [null, { question: '' }, { question: 123 }, { options: 'bad' }]),
    ];

    const { container } = render(
      <ChatView
        events={events}
        loading={false}
        onAskAnswer={vi.fn()}
      />,
    );

    for (const id of ['ask-empty', 'ask-null', 'ask-bad']) {
      const card = container.querySelector(`[data-event-id="${id}"].ask-question-timeline-card`);
      expect(card).not.toBeNull();
      expect(card?.textContent).toContain('Question asked');
      expect(card?.querySelector('button.ask-btn-submit')).toBeNull();
    }
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull();
  });

  it('normalizes canonical ask.question with string[] options and is_multi_select and renders raw ask_question tool.call as interactive card even in Simple view', () => {
    localStorage.setItem('imcodes_chat_show_tool_calls', 'false');
    const onAskAnswer = vi.fn(() => true);
    const events: TimelineEvent[] = [
      {
        eventId: 'ask-str',
        sessionId: 'deck_proj_brain',
        ts: 1_700_000_000_000,
        seq: 1,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'ask.question',
        payload: {
          toolUseId: 'tu-str',
          questions: [{ question: 'Canonical question?', is_multi_select: true, options: ['Alpha', 'Beta'] }],
        },
      },
      makeTextEvent('u-1', 'user.message', 'Alpha', false, 1_700_000_000_500),
      {
        eventId: 'tc-read',
        sessionId: 'deck_proj_brain',
        ts: 1_700_000_000_600,
        seq: 2,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'tool.call',
        payload: { tool: 'Read', input: '/tmp/a.ts' },
      },
      {
        eventId: 'tc-agy',
        sessionId: 'deck_proj_brain',
        ts: 1_700_000_001_000,
        seq: 3,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'tool.call',
        payload: {
          tool: 'ask_question',
          toolCallId: 'tc-agy-1',
          input: {
            question: 'Deploy targets?',
            header: 'Deploy',
            is_multi_select: true,
            options: ['Staging', 'Production'],
          },
        },
      },
    ];

    try {
      const { container } = render(
        <ChatView
          events={events}
          loading={false}
          onAskAnswer={onAskAnswer}
        />,
      );

      // Historical ask.question renders compact non-interactive answered card with answer summary
      const oldCard = container.querySelector('[data-event-id="ask-str"].ask-question-timeline-card');
      expect(oldCard).not.toBeNull();
      expect(oldCard?.classList.contains('ask-question-timeline-card-compact')).toBe(true);
      expect(oldCard?.querySelector('.ask-question-compact-question')?.textContent).toBe('Canonical question?');
      expect(oldCard?.querySelector('.ask-question-compact-answer')?.textContent).toBe('Alpha');
      expect(oldCard?.textContent).not.toContain('Beta');
      expect(oldCard?.querySelector('button.ask-btn-submit')).toBeNull();

      // Trailing raw ask_question tool.call is NOT swallowed into Simple-view summary or ToolBlockFold
      const rawCard = container.querySelector('[data-event-id="tc-agy"].ask-question-timeline-card');
      expect(rawCard).not.toBeNull();
      expect(container.querySelector('.chat-tool-fold-header .chat-tool-name')?.textContent ?? '').not.toContain('ask_question');
      const checkboxes = rawCard!.querySelectorAll('input[type="checkbox"]');
      expect(checkboxes.length).toBe(2);

      fireEvent.click(checkboxes[0]!);
      fireEvent.click(checkboxes[1]!);
      fireEvent.click(rawCard!.querySelector('button.ask-btn-submit')!);

      expect(onAskAnswer).toHaveBeenCalledWith('tc-agy-1', '[Deploy] Staging, Production');
    } finally {
      localStorage.removeItem('imcodes_chat_show_tool_calls');
    }
  });

  it('renders completed merged ask_question tool.call as read-only and falls back malformed ask_question to ToolBlockFold', () => {
    const events: TimelineEvent[] = [
      {
        eventId: 'tc-agy-done',
        sessionId: 'deck_proj_brain',
        ts: 1_700_000_001_000,
        seq: 1,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'tool.call',
        payload: {
          tool: 'ask_question',
          toolCallId: 'tc-agy-done-1',
          input: { question: 'Which branch?', options: ['main', 'dev'] },
        },
      },
      {
        eventId: 'tr-agy-done',
        sessionId: 'deck_proj_brain',
        ts: 1_700_000_001_500,
        seq: 2,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'tool.result',
        payload: { toolCallId: 'tc-agy-done-1', output: 'dev' },
      },
      {
        eventId: 'tc-agy-bad',
        sessionId: 'deck_proj_brain',
        ts: 1_700_000_002_000,
        seq: 3,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'tool.call',
        payload: { tool: 'ask_question', input: {} },
      },
    ];

    const { container } = render(
      <ChatView
        events={events}
        loading={false}
        onAskAnswer={vi.fn()}
      />,
    );

    const doneCard = container.querySelector('[data-event-id="tc-agy-done"].ask-question-timeline-card');
    expect(doneCard).not.toBeNull();
    expect(doneCard?.classList.contains('ask-question-timeline-card-compact')).toBe(true);
    expect(doneCard?.textContent).toContain('Which branch?');
    expect(doneCard?.querySelector('.ask-question-compact-answer')?.textContent).toBe('dev');
    expect(doneCard?.textContent).not.toContain('main');
    expect(doneCard?.querySelector('button.ask-btn-submit')).toBeNull();

    // Malformed empty ask_question safely falls back to normal tool row
    expect(container.querySelector('[data-event-id="tc-agy-bad"].ask-question-timeline-card')).toBeNull();
    expect(container.textContent).toContain('ask_question');
  });

  it('renders raw "Run ask_question" and inline-JSON tool.call as AskQuestionTimelineCard outside tool groups, while keeping "Run echo ask_question" in tool rows', () => {
    localStorage.setItem('imcodes_chat_show_tool_calls', 'false');
    const onAskAnswer = vi.fn(() => true);
    const events: TimelineEvent[] = [
      {
        eventId: 'tc-run-done',
        sessionId: 'deck_proj_brain',
        ts: 1_700_000_001_000,
        seq: 1,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'tool.call',
        payload: {
          tool: 'Run ask_question',
          toolCallId: 'tc-run-done-1',
          input: { question: 'Earlier question?', options: ['One', 'Two'] },
        },
      },
      {
        eventId: 'tr-run-done',
        sessionId: 'deck_proj_brain',
        ts: 1_700_000_001_200,
        seq: 2,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'tool.result',
        payload: { toolCallId: 'tc-run-done-1', output: 'One' },
      },
      {
        eventId: 'tc-echo-ask',
        sessionId: 'deck_proj_brain',
        ts: 1_700_000_001_400,
        seq: 3,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'tool.call',
        payload: { tool: 'Run echo ask_question', input: '{"question":"ignored"}' },
      },
      {
        eventId: 'tc-run-inline',
        sessionId: 'deck_proj_brain',
        ts: 1_700_000_002_000,
        seq: 4,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'tool.call',
        payload: {
          tool: 'Run ask_question {"is_multi_select":false,"options":["Local","Remote"],"question":"Target host?"}',
          toolCallId: 'tc-run-inline-1',
        },
      },
    ];

    try {
      const { container } = render(
        <ChatView
          events={events}
          loading={false}
          onAskAnswer={onAskAnswer}
        />,
      );

      // Merged historical "Run ask_question" still renders as a read-only card
      const doneCard = container.querySelector('[data-event-id="tc-run-done"].ask-question-timeline-card');
      expect(doneCard).not.toBeNull();
      expect(doneCard?.textContent).toContain('Earlier question?');
      expect(doneCard?.querySelector('button.ask-btn-submit')).toBeNull();

      // "Run echo ask_question" is NOT treated as an interactive question card
      expect(container.querySelector('[data-event-id="tc-echo-ask"].ask-question-timeline-card')).toBeNull();

      // Trailing "Run ask_question {...}" renders as interactive card even in Simple view
      const liveCard = container.querySelector('[data-event-id="tc-run-inline"].ask-question-timeline-card');
      expect(liveCard).not.toBeNull();
      expect(liveCard?.textContent).toContain('Target host?');
      const radios = liveCard!.querySelectorAll('input[type="radio"]');
      expect(radios.length).toBe(2);
      fireEvent.click(radios[1]!);
      fireEvent.click(liveCard!.querySelector('button.ask-btn-submit')!);
      expect(onAskAnswer).toHaveBeenCalledWith('tc-run-inline-1', 'Remote');
    } finally {
      localStorage.removeItem('imcodes_chat_show_tool_calls');
    }
  });

  it('deduplicates tool.call + ask.question sharing the same toolUseId in either order and keeps the canonical ask.question card interactive', () => {
    const onAskAnswer = vi.fn(() => true);
    const makeToolAsk = (eventId: string): TimelineEvent => ({
      eventId,
      sessionId: 'deck_proj_brain',
      ts: 1_700_000_001_000,
      seq: 1,
      epoch: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'tool.call',
      payload: {
        tool: 'ask_question',
        toolCallId: 'tu-shared',
        input: { question: 'Choose env', options: ['Dev', 'Prod'] },
      },
    });
    const canonicalAsk = makeAskEvent('ask-canonical', [
      { header: 'Env', question: 'Choose env', options: [{ label: 'Dev' }, { label: 'Prod' }] },
    ], 'tu-shared', 1_700_000_001_100);
    const trailingStatus: TimelineEvent = {
      eventId: 'st-1',
      sessionId: 'deck_proj_brain',
      ts: 1_700_000_001_200,
      seq: 3,
      epoch: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'agent.status',
      payload: { status: 'waiting' },
    };

    for (const events of [
      [makeToolAsk('tc-first'), canonicalAsk, trailingStatus],
      [canonicalAsk, makeToolAsk('tc-second'), trailingStatus],
    ]) {
      cleanup();
      const { container } = render(
        <ChatView
          events={events}
          loading={false}
          onAskAnswer={onAskAnswer}
        />,
      );
      const cards = container.querySelectorAll('.ask-question-timeline-card');
      expect(cards.length).toBe(1);
      expect(cards[0]?.getAttribute('data-event-id')).toBe('ask-canonical');
      expect(cards[0]?.querySelectorAll('input[type="radio"]').length).toBe(2);
      expect(cards[0]?.querySelector('button.ask-btn-submit')).not.toBeNull();
    }

    const activeCard = document.querySelector('[data-event-id="ask-canonical"]')!;
    fireEvent.click(activeCard.querySelectorAll('input[type="radio"]')[1]!);
    fireEvent.click(activeCard.querySelector('button.ask-btn-submit')!);
    expect(onAskAnswer).toHaveBeenCalledWith('tu-shared', '[Env] Prod');
  });

  it('docks unanswered ask.question in the bottom fixed dock with interactive highlight border, keeps single instance on delayed pre-ask text / non-answer events, and restores inline read-only after submit', () => {
    const onAskAnswer = vi.fn(() => true);
    const events: TimelineEvent[] = [
      makeTextEvent('u-prev', 'user.message', 'Start', false, 1_700_000_000_000),
      makeAskEvent('ask-docked', [
        {
          header: 'Choice',
          question: 'Pick rollout strategy',
          options: [{ label: 'Canary' }, { label: 'All-at-once' }],
        },
      ], 'tu-docked', 1_700_000_001_000),
      // Legacy 59ms delayed pre-ask assistant text + non-answer memory.compression
      makeTextEvent('a-59ms', 'assistant.text', 'Checking config first...', false, 1_700_000_001_059),
      {
        eventId: 'mc-1',
        sessionId: 'deck_proj_brain',
        ts: 1_700_000_001_200,
        seq: 99,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'memory.compression',
        payload: {},
      },
    ];

    const { container } = render(
      <ChatView
        events={events}
        loading={false}
        onAskAnswer={onAskAnswer}
      />,
    );

    const dock = container.querySelector('[data-testid="chat-pending-ask-dock"].chat-pending-ask-dock');
    expect(dock).not.toBeNull();
    const dockedCard = dock!.querySelector('[data-event-id="ask-docked"].ask-question-timeline-card.ask-question-timeline-card-interactive');
    expect(dockedCard).not.toBeNull();
    // Scrollable timeline must not render a duplicate interactive card while docked
    expect(container.querySelectorAll('[data-event-id="ask-docked"]')).toHaveLength(1);
    expect(container.querySelector('.chat-view [data-event-id="ask-docked"]')).toBeNull();

    const radios = dockedCard!.querySelectorAll('input[type="radio"]');
    fireEvent.click(radios[0]!);
    fireEvent.click(dockedCard!.querySelector('button.ask-btn-submit')!);

    expect(onAskAnswer).toHaveBeenCalledWith('tu-docked', '[Choice] Canary');
    // Dock disappears and the card transitions to compact non-interactive answered card with submitted text
    expect(container.querySelector('.chat-pending-ask-dock')).toBeNull();
    const settledCard = container.querySelector('.chat-view [data-event-id="ask-docked"].ask-question-timeline-card');
    expect(settledCard).not.toBeNull();
    expect(settledCard?.classList.contains('ask-question-timeline-card-interactive')).toBe(false);
    expect(settledCard?.classList.contains('ask-question-timeline-card-compact')).toBe(true);
    expect(settledCard?.classList.contains('ask-question-timeline-card-answered')).toBe(true);
    expect(settledCard?.getAttribute('data-ask-state')).toBe('answered');
    const settledBadge = settledCard?.querySelector('.ask-question-compact-badge');
    expect(settledBadge?.textContent).toBe('Answered');
    expect(settledBadge?.classList.contains('is-unanswered')).toBe(false);
    expect(settledCard?.querySelector('.ask-question-compact-answer')?.textContent).toBe('[Choice] Canary');
    expect(settledCard?.textContent).not.toContain('All-at-once');
    expect(settledCard?.querySelector('input')).toBeNull();
    expect(settledCard?.querySelector('button')).toBeNull();
    expect(settledCard?.querySelector('label')).toBeNull();
    expect(settledCard?.querySelector('.ask-question-timeline-options')).toBeNull();
  });

  it('never mounts the bottom ask dock in preview mode or read-only shared view without onAskAnswer', () => {
    const events = [
      makeAskEvent('ask-ro', [{ question: 'Pick?', options: [{ label: 'A' }] }], 'tu-ro', 1_700_000_001_000),
    ];

    const previewRender = render(<ChatView events={events} loading={false} preview onAskAnswer={vi.fn()} />);
    expect(previewRender.container.querySelector('.chat-pending-ask-dock')).toBeNull();
    expect(previewRender.container.querySelector('.ask-question-timeline-card-interactive')).toBeNull();
    cleanup();

    const readOnlyRender = render(<ChatView events={events} loading={false} />);
    expect(readOnlyRender.container.querySelector('.chat-pending-ask-dock')).toBeNull();
    expect(readOnlyRender.container.querySelector('.ask-question-timeline-card-interactive')).toBeNull();
  });
});

describe('isAskQuestionSessionVisible', () => {
  const baseState: AskQuestionSessionVisibilityState = {
    chatObscured: false,
    isMobile: false,
    activeSession: 'deck_proj_brain',
    defaultViewMode: 'terminal',
    viewModes: { deck_proj_brain: 'chat' },
    openSubSessionIds: new Set(['sub-1']),
    hasMaximizedSubSession: false,
    subSessions: [{ id: 'sub-1', sessionName: 'deck_sub_1' }],
    subSessionViewModes: { deck_sub_1: 'chat' },
  };

  it('suppresses modal when the user is viewing that main session in chat mode', () => {
    expect(isAskQuestionSessionVisible('deck_proj_brain', baseState)).toBe(true);
  });

  it('pops up modal when the user is viewing a different main session', () => {
    expect(isAskQuestionSessionVisible('deck_other_brain', baseState)).toBe(false);
  });

  it('pops up modal when the main session is in terminal view mode', () => {
    expect(
      isAskQuestionSessionVisible('deck_proj_brain', {
        ...baseState,
        viewModes: { deck_proj_brain: 'terminal' },
      }),
    ).toBe(false);
  });

  it('pops up modal when chat is obscured by another page, dashboard, or remote desktop', () => {
    expect(
      isAskQuestionSessionVisible('deck_proj_brain', {
        ...baseState,
        chatObscured: true,
      }),
    ).toBe(false);
  });

  it('suppresses modal for an open visible sub-session in chat mode, and pops up when closed or in terminal mode', () => {
    expect(isAskQuestionSessionVisible('deck_sub_1', baseState)).toBe(true);
    expect(
      isAskQuestionSessionVisible('deck_sub_1', {
        ...baseState,
        openSubSessionIds: new Set(),
      }),
    ).toBe(false);
    expect(
      isAskQuestionSessionVisible('deck_sub_1', {
        ...baseState,
        subSessionViewModes: { deck_sub_1: 'terminal' },
      }),
    ).toBe(false);
  });

  it('pops up modal for the main session when covered by an open mobile or maximized sub-session', () => {
    expect(
      isAskQuestionSessionVisible('deck_proj_brain', {
        ...baseState,
        isMobile: true,
      }),
    ).toBe(false);
    expect(
      isAskQuestionSessionVisible('deck_proj_brain', {
        ...baseState,
        hasMaximizedSubSession: true,
      }),
    ).toBe(false);
  });

  it('suppresses modal on desktop for transport main sessions via activeSessionViewMode even with defaultViewMode terminal or stale viewModes', () => {
    expect(
      isAskQuestionSessionVisible('deck_proj_brain', {
        ...baseState,
        defaultViewMode: 'terminal',
        viewModes: {},
        activeSessionViewMode: 'chat',
      }),
    ).toBe(true);
    expect(
      isAskQuestionSessionVisible('deck_proj_brain', {
        ...baseState,
        defaultViewMode: 'terminal',
        viewModes: { deck_proj_brain: 'terminal' },
        activeSessionViewMode: 'chat',
      }),
    ).toBe(true);
    expect(
      isAskQuestionSessionVisible('deck_proj_brain', {
        ...baseState,
        defaultViewMode: 'terminal',
        viewModes: {},
        activeSessionViewMode: 'terminal',
      }),
    ).toBe(false);
  });

  it('suppresses modal for visible pinned sub-sessions in chat mode without hiding the desktop main session', () => {
    const pinnedState: AskQuestionSessionVisibilityState = {
      ...baseState,
      openSubSessionIds: new Set(),
      pinnedSubSessions: [
        { sessionName: 'deck_sub_pinned_chat', viewMode: 'chat' },
        { sessionName: 'deck_sub_pinned_term', viewMode: 'terminal' },
      ],
    };
    expect(isAskQuestionSessionVisible('deck_sub_pinned_chat', pinnedState)).toBe(true);
    expect(isAskQuestionSessionVisible('deck_sub_pinned_term', pinnedState)).toBe(false);
    expect(isAskQuestionSessionVisible('deck_proj_brain', pinnedState)).toBe(true);
    expect(
      isAskQuestionSessionVisible('deck_sub_pinned_chat', {
        ...pinnedState,
        pinnedSubSessions: [],
      }),
    ).toBe(false);
  });
});

describe('ask.question timeline card option clickability & indicators', () => {
  it('selects single-select and toggles multi-select options by clicking visible label/description/indicator and submits cleanly', () => {
    const onAskAnswer = vi.fn(() => true);
    const events = [
      makeAskEvent('ask-click', [
        {
          header: 'Engine',
          question: 'Choose runtime',
          options: [
            { label: 'Node', description: 'V8 runtime' },
            { label: 'Bun', description: 'JavaScriptCore runtime' },
          ],
        },
        {
          header: 'Flags',
          question: 'Pick flags',
          multiSelect: true,
          options: [
            { label: 'Strict', description: 'Enable strict checks' },
            { label: 'Verbose', description: 'Detailed output' },
          ],
        },
      ], 'tu-click'),
    ];

    const { container } = render(
      <ChatView
        events={events}
        loading={false}
        onAskAnswer={onAskAnswer}
      />,
    );

    const card = container.querySelector('[data-event-id="ask-click"].ask-question-timeline-card-interactive')!;
    expect(card).not.toBeNull();

    const options = Array.from(card.querySelectorAll('label.ask-option.ask-question-timeline-option'));
    expect(options.length).toBe(4);
    for (const optEl of options) {
      expect(optEl.querySelector('.ask-option-indicator')).not.toBeNull();
      expect(optEl.querySelector('.ask-option-content .ask-option-label')).not.toBeNull();
    }

    // Click visible description span on option 1 ("Bun" -> "JavaScriptCore runtime")
    fireEvent.click(screen.getByText('JavaScriptCore runtime'));
    expect(options[1]!.classList.contains('ask-option-selected')).toBe(true);
    expect((options[1]!.querySelector('input') as HTMLInputElement).checked).toBe(true);
    expect(options[0]!.classList.contains('ask-option-selected')).toBe(false);

    // Click label text on multi-select options ("Strict" and "Verbose"), then toggle "Strict" off
    fireEvent.click(screen.getByText('Strict'));
    fireEvent.click(screen.getByText('Verbose'));
    expect(options[2]!.classList.contains('ask-option-selected')).toBe(true);
    expect(options[3]!.classList.contains('ask-option-selected')).toBe(true);
    // Single-select question 0 stayed untouched
    expect(options[1]!.classList.contains('ask-option-selected')).toBe(true);

    fireEvent.click(screen.getByText('Strict'));
    expect(options[2]!.classList.contains('ask-option-selected')).toBe(false);
    expect(options[3]!.classList.contains('ask-option-selected')).toBe(true);

    fireEvent.click(card.querySelector('button.ask-btn-submit') as HTMLButtonElement);
    expect(onAskAnswer).toHaveBeenCalledWith('tu-click', '[Engine] Bun\n[Flags] Verbose');
  });

  it('keeps answered/read-only cards strictly compact and non-interactive without options, labels, indicators, or inputs', () => {
    const events = [
      makeAskEvent('ask-ro', [
        {
          header: 'Done',
          question: 'Already answered',
          options: [
            { label: 'Alpha', description: 'First choice' },
            { label: 'Beta', description: 'Second choice' },
          ],
        },
      ]),
      makeTextEvent('u-ro', 'user.message', 'Alpha'),
    ];

    const { container } = render(<ChatView events={events} loading={false} />);
    const card = container.querySelector('[data-event-id="ask-ro"].ask-question-timeline-card')!;
    expect(card.classList.contains('ask-question-timeline-card-interactive')).toBe(false);
    expect(card.classList.contains('ask-question-timeline-card-compact')).toBe(true);
    expect(card.classList.contains('ask-question-timeline-card-answered')).toBe(true);
    expect(card.getAttribute('data-ask-state')).toBe('answered');
    expect(card.querySelectorAll('input').length).toBe(0);
    expect(card.querySelectorAll('button').length).toBe(0);
    expect(card.querySelectorAll('label').length).toBe(0);
    expect(card.querySelectorAll('.ask-option-indicator').length).toBe(0);
    expect(card.querySelectorAll('.ask-question-timeline-options').length).toBe(0);
    expect(card.querySelectorAll('.ask-question-timeline-option').length).toBe(0);
    expect(card.querySelector('.ask-question-compact-question')?.textContent).toBe('Already answered');
    expect(card.querySelector('.ask-question-compact-answer')?.textContent).toBe('Alpha');
    expect(card.textContent).not.toContain('Second choice');
  });

  it('does not open the chat selection menu or highlight on coarse-pointer touch long-press inside an interactive ask card (with ordinary message positive control)', async () => {
    const origMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    vi.useFakeTimers();
    try {
      const events = [
        makeTextEvent('a-normal', 'assistant.text', 'Ordinary assistant message', false, 1_700_000_000_000),
        makeAskEvent('ask-touch', [
          {
            header: 'Touch',
            question: 'Pick one on mobile',
            options: [{ label: 'Alpha', description: 'Tap or hold' }],
          },
        ], 'tu-touch', 1_700_000_001_000),
      ];
      const { container } = render(
        <ChatView
          events={events}
          loading={false}
          onAskAnswer={vi.fn(() => true)}
        />,
      );

      // Positive control: long-pressing a normal chat assistant message opens .chat-sel-menu + .chat-highlight
      const assistantBubble = container.querySelector('.chat-assistant[data-event-id="a-normal"]')!;
      expect(assistantBubble).not.toBeNull();
      fireEvent.touchStart(assistantBubble, { touches: [{ clientX: 20, clientY: 20 }] });
      await vi.advanceTimersByTimeAsync(700);
      expect(container.querySelectorAll('.chat-sel-menu').length).toBe(1);
      expect(container.querySelectorAll('.chat-highlight').length).toBe(1);

      cleanup();

      // Target: long-pressing an interactive ask.question option must NOT open .chat-sel-menu or add .chat-highlight
      const view2 = render(
        <ChatView
          events={events}
          loading={false}
          onAskAnswer={vi.fn(() => true)}
        />,
      );
      const label = view2.container.querySelector('[data-event-id="ask-touch"] label.ask-option')!;
      fireEvent.touchStart(label, { touches: [{ clientX: 20, clientY: 20 }] });
      await vi.advanceTimersByTimeAsync(700);
      expect(view2.container.querySelectorAll('.chat-sel-menu').length).toBe(0);
      expect(view2.container.querySelectorAll('.chat-highlight').length).toBe(0);
    } finally {
      vi.useRealTimers();
      window.matchMedia = origMatchMedia;
    }
  });
});
