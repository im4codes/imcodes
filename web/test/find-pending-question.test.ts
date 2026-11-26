import { describe, it, expect } from 'vitest';
import { findTrailingAskQuestion, resolveAskQuestionAnswerMap } from '../src/find-pending-question.js';

const ask = (over: Record<string, unknown> = {}) => ({
  type: 'ask.question',
  payload: { toolUseId: 't1', questions: [{ question: 'Pick one', options: [{ label: 'A' }] }], waitMs: 5000, ...over },
});
const text = (streaming = false) => ({ type: 'assistant.text', payload: { text: 'ok', streaming } });
const user = () => ({ type: 'user.message', payload: { text: 'A' } });
const usage = () => ({ type: 'usage.update', payload: { inputTokens: 1 } });
const state = () => ({ type: 'session.state', payload: { state: 'idle' } });

describe('findTrailingAskQuestion', () => {
  it('returns the question when it is the trailing visible event', () => {
    const q = findTrailingAskQuestion([user(), text(), ask()]);
    expect(q).toEqual({ toolUseId: 't1', questions: [{ question: 'Pick one', options: [{ label: 'A' }] }], waitMs: 5000 });
  });

  it('ignores trailing non-visible events (usage.update / session.state)', () => {
    const q = findTrailingAskQuestion([ask(), usage(), state()]);
    expect(q?.toolUseId).toBe('t1');
  });

  it('ignores a trailing streaming assistant.text (not a real message)', () => {
    const q = findTrailingAskQuestion([ask(), text(true)]);
    expect(q?.toolUseId).toBe('t1');
  });

  it('returns null when a user answer follows the question', () => {
    expect(findTrailingAskQuestion([ask(), user()])).toBeNull();
  });

  it('returns null when the model self-continued (final assistant.text after)', () => {
    expect(findTrailingAskQuestion([ask(), text(false)])).toBeNull();
  });

  it('returns null when there is no question, or it has no questions', () => {
    expect(findTrailingAskQuestion([user(), text()])).toBeNull();
    expect(findTrailingAskQuestion([ask({ questions: [] })])).toBeNull();
  });

  it('normalizes string[] options and is_multi_select on canonical ask.question events', () => {
    const q = findTrailingAskQuestion([{
      type: 'ask.question',
      payload: {
        toolUseId: 'agy-1',
        questions: [{ question: 'Pick env', is_multi_select: true, options: ['Dev', 'Prod'] }],
      },
    }]);
    expect(q).toEqual({
      toolUseId: 'agy-1',
      questions: [{ question: 'Pick env', multiSelect: true, options: [{ label: 'Dev' }, { label: 'Prod' }] }],
    });
  });

  it('detects trailing raw tool.call ask_question from older daemons and resolves id', () => {
    const q = findTrailingAskQuestion([
      user(),
      {
        eventId: 'ev-call-1',
        type: 'tool.call',
        payload: {
          tool: 'ask_question',
          toolCallId: 'tc-99',
          input: { question: 'Proceed?', is_multi_select: true, options: ['Yes', 'No'] },
        },
      },
      usage(),
      state(),
      text(true),
    ]);
    expect(q).toEqual({
      toolUseId: 'tc-99',
      questions: [{ question: 'Proceed?', multiSelect: true, options: [{ label: 'Yes' }, { label: 'No' }] }],
    });
  });

  it('returns null for raw tool.call ask_question followed by tool.result, user.message, or final assistant.text', () => {
    const rawCall = {
      eventId: 'ev-call-2',
      type: 'tool.call',
      payload: {
        tool: 'ask_question',
        toolCallId: 'tc-2',
        input: JSON.stringify({ question: 'Confirm?', options: ['A', 'B'] }),
      },
    };
    expect(findTrailingAskQuestion([rawCall, { type: 'tool.result', payload: { toolCallId: 'tc-2', output: 'A' } }])).toBeNull();
    expect(findTrailingAskQuestion([rawCall, user()])).toBeNull();
    expect(findTrailingAskQuestion([rawCall, text(false)])).toBeNull();
    expect(findTrailingAskQuestion([{
      ...rawCall,
      payload: { ...rawCall.payload, _merged: true, _callPayloadInput: rawCall.payload.input },
    }])).toBeNull();
  });

  it('detects "Run ask_question" and inline-JSON variants when unmerged, and returns null once merged or answered', () => {
    const runCall = {
      eventId: 'ev-run-1',
      type: 'tool.call',
      payload: {
        tool: 'Run ask_question',
        toolCallId: 'tc-run-1',
        input: { question: 'Proceed?', is_multi_select: false, options: ['Yes', 'No'] },
      },
    };
    expect(findTrailingAskQuestion([user(), runCall])).toEqual({
      toolUseId: 'tc-run-1',
      questions: [{ question: 'Proceed?', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] }],
    });

    const inlineCall = {
      eventId: 'ev-run-inline',
      type: 'tool.call',
      payload: {
        tool: 'Run ask_question {"is_multi_select":false,"options":["A","B"],"question":"Pick inline?"}',
        toolCallId: 'tc-run-inline',
      },
    };
    expect(findTrailingAskQuestion([inlineCall])).toEqual({
      toolUseId: 'tc-run-inline',
      questions: [{ question: 'Pick inline?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }],
    });

    expect(findTrailingAskQuestion([{ ...runCall, payload: { ...runCall.payload, _merged: true } }])).toBeNull();
    expect(findTrailingAskQuestion([{ ...runCall, payload: { ...runCall.payload, _toolFailed: true } }])).toBeNull();
    expect(findTrailingAskQuestion([runCall, { type: 'tool.result', payload: { toolCallId: 'tc-run-1', output: 'Yes' } }])).toBeNull();
    expect(findTrailingAskQuestion([runCall, user()])).toBeNull();
    expect(findTrailingAskQuestion([runCall, text(false)])).toBeNull();
  });

  it('continues past an empty ask_question tool.call to find the canonical ask.question and clears once tool.result completes it', () => {
    const emptyCall = {
      eventId: 'ev-empty-call',
      type: 'tool.call',
      payload: { tool: 'ask_question', toolCallId: 't1', input: {} },
    };
    const transient = [
      { type: 'agent.status', payload: { status: 'waiting' } },
      { type: 'assistant.thinking', payload: { text: 'hmm' } },
      usage(),
      state(),
    ];
    expect(findTrailingAskQuestion([ask(), emptyCall, ...transient])).toEqual({
      toolUseId: 't1',
      questions: [{ question: 'Pick one', options: [{ label: 'A' }] }],
      waitMs: 5000,
    });
    expect(findTrailingAskQuestion([ask(), { type: 'tool.result', payload: { toolCallId: 't1', output: 'A' } }])).toBeNull();
  });

  it('tolerates legacy daemon pre-ask assistant.text flushed within 2000ms after ask.question (and raw ask_question tool.call)', () => {
    const askAt = { ...ask(), ts: 1_700_000_000_000 };
    const flushed59ms = { ...text(false), ts: 1_700_000_000_059 };
    const flushedAtBoundary = { ...text(false), ts: 1_700_000_002_000 };
    const memoryCompression = { type: 'memory.compression', ts: 1_700_000_001_800, payload: {} };

    expect(findTrailingAskQuestion([askAt, flushed59ms, memoryCompression])?.toolUseId).toBe('t1');
    expect(findTrailingAskQuestion([askAt, flushedAtBoundary])?.toolUseId).toBe('t1');

    const rawCallAt = {
      eventId: 'ev-call-reorder',
      type: 'tool.call',
      ts: 1_700_000_010_000,
      payload: {
        tool: 'ask_question',
        toolCallId: 'tc-reorder',
        input: { question: 'Which target?', options: ['A', 'B'] },
      },
    };
    expect(findTrailingAskQuestion([rawCallAt, { ...text(false), ts: 1_700_000_010_059 }])?.toolUseId).toBe('tc-reorder');
  });

  it('returns null when trailing assistant.text exceeds 2000ms, precedes ask.ts, lacks ts, or is followed by user.message / tool.result', () => {
    const askAt = { ...ask(), ts: 1_700_000_000_000 };
    // > 2000ms later is treated as a real continuation
    expect(findTrailingAskQuestion([askAt, { ...text(false), ts: 1_700_000_002_001 }])).toBeNull();
    // Negative delta or missing ts on either side does not tolerate
    expect(findTrailingAskQuestion([askAt, { ...text(false), ts: 1_699_999_999_999 }])).toBeNull();
    expect(findTrailingAskQuestion([askAt, text(false)])).toBeNull();
    expect(findTrailingAskQuestion([ask(), { ...text(false), ts: 1_700_000_000_059 }])).toBeNull();
    // user.message or matching tool.result still clears pending even with a 59ms text
    expect(findTrailingAskQuestion([askAt, { ...text(false), ts: 1_700_000_000_059 }, user()])).toBeNull();
    expect(findTrailingAskQuestion([
      askAt,
      { ...text(false), ts: 1_700_000_000_059 },
      { type: 'tool.result', payload: { toolCallId: 't1', output: 'A' } },
    ])).toBeNull();
  });
});

describe('resolveAskQuestionAnswerMap', () => {
  it('resolves local submit, explicit askToolUseId user reply over earlier tool.result, raw tool.result compat, and unattributed immediate reply while stopping before unrelated turns', () => {
    const events = [
      {
        eventId: 'ask-toolid',
        type: 'ask.question',
        ts: 1_700_000_000_000,
        payload: { toolUseId: 'tu-1', questions: [{ question: 'Pick env', options: [{ label: 'Staging' }, { label: 'Prod' }] }] },
      },
      {
        eventId: 'u-interleaved',
        type: 'user.message',
        ts: 1_700_000_000_500,
        payload: { text: 'Other note' },
      },
      {
        eventId: 'u-match',
        type: 'user.message',
        ts: 1_700_000_001_000,
        payload: { text: 'Prod', askToolUseId: 'tu-1' },
      },
      {
        eventId: 'tc-ask',
        type: 'tool.call',
        ts: 1_700_000_002_000,
        payload: { tool: 'ask_question', toolCallId: 'tc-9', input: { question: 'Branch?', options: ['main', 'dev'] } },
      },
      {
        eventId: 'tr-ask',
        type: 'tool.result',
        ts: 1_700_000_002_500,
        payload: { toolCallId: 'tc-9', output: 'dev' },
      },
      {
        eventId: 'tc-prefer-user',
        type: 'tool.call',
        ts: 1_700_000_002_700,
        payload: { tool: 'ask_question', toolCallId: 'tc-10', input: { question: 'Target?', options: ['A', 'B'] } },
      },
      {
        eventId: 'tr-early',
        type: 'tool.result',
        ts: 1_700_000_002_800,
        payload: { toolCallId: 'tc-10', output: 'Tool summary' },
      },
      {
        eventId: 'u-explicit-after-tr',
        type: 'user.message',
        ts: 1_700_000_002_900,
        payload: { text: 'Explicit B', askToolUseId: 'tc-10' },
      },
      {
        eventId: 'ask-other-id',
        type: 'ask.question',
        ts: 1_700_000_003_000,
        payload: { toolUseId: 'tu-a', questions: [{ question: 'Other id?', options: [{ label: 'X' }] }] },
      },
      {
        eventId: 'u-other-id',
        type: 'user.message',
        ts: 1_700_000_003_500,
        payload: { text: 'Restart worker', askToolUseId: 'tu-b' },
      },
      {
        eventId: 'ask-assistant-stop',
        type: 'ask.question',
        ts: 1_700_000_010_000,
        payload: { toolUseId: 'tu-stop', questions: [{ question: 'Assistant next?', options: [{ label: 'A' }] }] },
      },
      {
        eventId: 'a-100ms',
        type: 'assistant.text',
        ts: 1_700_000_010_100,
        payload: { text: 'Continuing automatically', streaming: false },
      },
      {
        eventId: 'u-later-cmd',
        type: 'user.message',
        ts: 1_700_000_010_500,
        payload: { text: 'Restart worker' },
      },
      {
        eventId: 'ask-empty-boundary',
        type: 'ask.question',
        ts: 1_700_000_020_000,
        payload: { toolUseId: 'tu-eb', questions: [{ question: 'Superseded by empty ask?', options: [{ label: 'A' }] }] },
      },
      {
        eventId: 'ask-empty',
        type: 'ask.question',
        ts: 1_700_000_020_100,
        payload: { toolUseId: 'tu-empty', questions: [] },
      },
      {
        eventId: 'u-after-empty-ask',
        type: 'user.message',
        ts: 1_700_000_020_200,
        payload: { text: 'Restart worker' },
      },
      {
        eventId: 'ask-canonical-tr-stop',
        type: 'ask.question',
        ts: 1_700_000_022_000,
        payload: { toolUseId: 'tu-trstop', questions: [{ question: 'Canonical TR stop?', options: [{ label: 'Yes' }] }] },
      },
      {
        eventId: 'tr-canonical-stop',
        type: 'tool.result',
        ts: 1_700_000_022_100,
        payload: { toolCallId: 'tu-trstop', output: 'Tool summary' },
      },
      {
        eventId: 'u-after-canonical-tr',
        type: 'user.message',
        ts: 1_700_000_022_200,
        payload: { text: 'Restart worker' },
      },
      {
        eventId: 'ask-unattributed',
        type: 'ask.question',
        ts: 1_700_000_025_000,
        payload: { toolUseId: 'tu-legacy', questions: [{ question: 'Legacy immediate?', options: [{ label: 'Yes' }] }] },
      },
      {
        eventId: 'u-legacy',
        type: 'user.message',
        ts: 1_700_000_025_500,
        payload: { text: 'Yes' },
      },
      {
        eventId: 'ask-just-submitted',
        type: 'ask.question',
        ts: 1_700_000_030_000,
        payload: { toolUseId: 'tu-live', questions: [{ question: 'Live?', options: [{ label: 'Now' }] }] },
      },
    ];

    const map = resolveAskQuestionAnswerMap(events, { 'ask-just-submitted': 'Now' });
    expect(map.get('ask-toolid')).toBe('Prod');
    expect(map.get('tc-ask')).toBe('dev');
    expect(map.get('tc-prefer-user')).toBe('Explicit B');
    expect(map.has('ask-other-id')).toBe(false);
    expect(map.has('ask-assistant-stop')).toBe(false);
    expect(map.has('ask-empty-boundary')).toBe(false);
    expect(map.has('ask-canonical-tr-stop')).toBe(false);
    expect(map.get('ask-unattributed')).toBe('Yes');
    expect(map.get('ask-just-submitted')).toBe('Now');
  });
});
