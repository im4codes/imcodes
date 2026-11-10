import { describe, expect, it, vi } from 'vitest';
import { isGuaranteedVisibleTimelineEvent, projectAssistantTextForDisplay } from '../../src/shared/timeline/types.js';
import { createTimelineDisplayProjectionCache } from '../src/timeline/display-projection-cache.js';
const { isGuaranteedVisibleTimelineEventCached, projectAssistantEventForDisplay } = createTimelineDisplayProjectionCache(
  projectAssistantTextForDisplay, isGuaranteedVisibleTimelineEvent,
);
import type { TimelineEvent } from '../src/ws-client.js';

const event = (text: unknown): TimelineEvent => ({ eventId: 'display', sessionId: 'display', type: 'assistant.text',
  epoch: 1, seq: 1, ts: 1, source: 'daemon', confidence: 'high', payload: { text } });

describe('source-owned display projection cache', () => {
  it('reuses a stable payload and invalidates an edit, replacement and A→B→A', () => {
    const a = event(' first\n\n\nanswer ');
    const projected = projectAssistantEventForDisplay(a);
    expect(projectAssistantEventForDisplay({ ...a })).toBe(projected);
    expect(projected).toEqual(projectAssistantTextForDisplay(a.payload.text));
    expect(projectAssistantEventForDisplay({ ...a, sessionId: `srv:${a.sessionId}`, payload: { ...a.payload } })).toBe(projected);
    for (const text of ['second', ' first\n\n\nanswer ']) {
      a.payload.text = text;
      expect(projectAssistantEventForDisplay(a)).toEqual(projectAssistantTextForDisplay(text));
      if (text === 'second') expect(projectAssistantEventForDisplay(a)).not.toBe(projected);
    }
    expect(projectAssistantEventForDisplay({ ...a, payload: { text: 'replacement' } }).text).toBe('replacement');
  });

  it('keeps shared visibility semantics across edits, hidden/type and stream/final transitions', () => {
    const row = event('<!-- IMCODES_TASK WORKING tsk_cache -->');
    for (const patch of [
      { text: '', streaming: true }, { text: 'visible', streaming: false },
      { text: ' \n\n ', streaming: false }, { text: '<!-- IMCODES_TASK WORKING tsk_cache -->', pending: true },
      { pending: false, streaming: false },
    ]) {
      Object.assign(row.payload, patch);
      for (const hidden of [false, true, false]) {
        row.hidden = hidden;
        expect(isGuaranteedVisibleTimelineEventCached(row)).toBe(isGuaranteedVisibleTimelineEvent(row));
      }
    }
    for (const type of ['tool.call', 'session.state', 'user.message', 'assistant.text']) {
      row.type = type as TimelineEvent['type'];
      expect(isGuaranteedVisibleTimelineEventCached(row)).toBe(isGuaranteedVisibleTimelineEvent(row));
    }
  });

  it('does not memoize mutable custom string coercion or share results by eventId', () => {
    let text = 'old';
    const row = event({ toString: () => text });
    expect(projectAssistantEventForDisplay(row).text).toBe('old');
    text = '';
    expect(projectAssistantEventForDisplay(row).text).toBe('');
    expect(isGuaranteedVisibleTimelineEventCached(row)).toBe(false);
    text = 'new';
    expect(isGuaranteedVisibleTimelineEventCached(row)).toBe(true);
    expect(projectAssistantEventForDisplay(event('independent')).text).toBe('independent');
  });
});


it('keeps the safe per-payload path when WeakRef is unavailable', async () => {
  vi.stubGlobal('WeakRef', undefined);
  vi.resetModules();
  try {
    const { createTimelineDisplayProjectionCache } = await import('../src/timeline/display-projection-cache.js');
    const cache = createTimelineDisplayProjectionCache(projectAssistantTextForDisplay, isGuaranteedVisibleTimelineEvent);
    const row = event('fallback');
    const value = cache.projectAssistantEventForDisplay(row);
    expect(cache.projectAssistantEventForDisplay(row)).toBe(value);
    expect(cache.isGuaranteedVisibleTimelineEventCached(row)).toBe(true);
    row.payload.text = '';
    expect(cache.isGuaranteedVisibleTimelineEventCached(row)).toBe(false);
  } finally { vi.unstubAllGlobals(); vi.resetModules(); }
});
