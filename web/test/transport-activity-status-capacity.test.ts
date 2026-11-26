import { describe, expect, it } from 'vitest';
import { getLatestTransportActivityDetail } from '../src/transport-activity-status.js';
import { deriveSessionLiveStatus } from '../src/session-live-status.js';
import { CAPACITY_RETRY_ACTIVITY_DETAIL_PREFIX } from '@shared/capacity-retry.js';
import type { TimelineEvent } from '../src/ws-client.js';
import en from '../src/i18n/locales/en.json';
import es from '../src/i18n/locales/es.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';
import ru from '../src/i18n/locales/ru.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';

function stateEvent(payload: Record<string, unknown>): TimelineEvent {
  return { type: 'session.state', payload } as unknown as TimelineEvent;
}

describe('capacity retry notice in the live status', () => {
  it('shows while the episode is active and clears with the next state that has no capacityRetry', () => {
    const active = stateEvent({ state: 'running', capacityRetry: { attempt: 1, retryAt: 0, since: 1, error: 'Selected model is at capacity' } });
    const detail = getLatestTransportActivityDetail([active]);
    expect(detail).toBe(`${CAPACITY_RETRY_ACTIVITY_DETAIL_PREFIX}1`);
    expect(deriveSessionLiveStatus({ sessionState: 'running', activeTransportTurn: true, transportActivityDetail: detail ?? undefined }).mode).toBe('waiting');
    // Capacity is back: the next state event carries no capacityRetry, so the notice is gone.
    const cleared = stateEvent({ state: 'running', blockingWorkCount: 1, busyReasons: ['runtime_dispatch'] });
    expect(getLatestTransportActivityDetail([active, cleared])).toBe('runtime_dispatch'); // the ordinary busy reason, not the capacity notice
    expect(getLatestTransportActivityDetail([active, stateEvent({ state: 'idle' })])).toBeNull();
  });

  it('every locale carries the notice (no missing key, no leftover countdown placeholders)', () => {
    for (const [locale, messages] of Object.entries({ en, es, ja, ko, ru, 'zh-CN': zhCN, 'zh-TW': zhTW })) {
      const text = (messages as { session: Record<string, string> }).session.capacity_retrying;
      expect(typeof text, locale).toBe('string');
      expect(text, locale).not.toMatch(/\{\{/);
      expect(text.length, locale).toBeGreaterThan(8);
    }
  });
});
