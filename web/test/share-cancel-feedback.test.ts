import { describe, expect, it, vi } from 'vitest';
import en from '../src/i18n/locales/en.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';
import es from '../src/i18n/locales/es.json';
import ru from '../src/i18n/locales/ru.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';
import { SHARE_DENIAL_REASONS } from '../../shared/tab-sharing.js';
import {
  SHARE_CANCEL_FAILED_EVENT,
  notifyShareCancelFailure,
  shareCancelFailureFromHttpError,
  shareCancelFailureReasonKey,
  takeTrackedShareCancel,
  trackShareCancelCommand,
} from '../src/share-cancel-feedback.js';

const LOCALES = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, es, ru, ja, ko } as Record<string, { share: { cancel_failed: { title: string; reason: Record<string, string> } } }>;

describe('share cancel feedback', () => {
  it('maps every share denial reason to a translated message in all 7 locales (never a raw code)', () => {
    const keys = new Set([...SHARE_DENIAL_REASONS, 'something-new', null, undefined].map((reason) => shareCancelFailureReasonKey(reason)));
    for (const [name, locale] of Object.entries(LOCALES)) {
      expect(locale.share.cancel_failed.title, name).toBeTruthy();
      for (const key of keys) expect(locale.share.cancel_failed.reason[key], `${name}:${key}`).toBeTruthy();
    }
    expect(shareCancelFailureReasonKey('share-rate-limited')).toBe('rate_limited');
    expect(shareCancelFailureReasonKey('share-dispatch-changed')).toBe('dispatch_changed');
    expect(shareCancelFailureReasonKey('not-a-share-reason')).toBe('generic');
  });

  it('reports a refusal only for a cancel the browser sent, once', () => {
    trackShareCancelCommand('cancel-1');
    expect(takeTrackedShareCancel('cancel-1')).toBe(true);
    expect(takeTrackedShareCancel('cancel-1')).toBe(false);
    expect(takeTrackedShareCancel('someone-elses')).toBe(false);
  });

  it('bounds how many cancels are remembered', () => {
    for (let i = 0; i < 200; i += 1) trackShareCancelCommand(`c-${i}`);
    expect(takeTrackedShareCancel('c-0')).toBe(false);
    expect(takeTrackedShareCancel('c-199')).toBe(true);
  });

  it('dispatches a window event the app turns into a toast', () => {
    const listener = vi.fn();
    window.addEventListener(SHARE_CANCEL_FAILED_EVENT, listener);
    notifyShareCancelFailure({ reason: 'share-dispatch-changed', activeDispatchId: 'turn-2', session: 'deck_proj_brain' });
    window.removeEventListener(SHARE_CANCEL_FAILED_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toEqual({ reason: 'share-dispatch-changed', activeDispatchId: 'turn-2', session: 'deck_proj_brain' });
  });

  it('reads the refusal out of an HTTP cancel error and ignores any other failure', () => {
    expect(shareCancelFailureFromHttpError({ body: JSON.stringify({ error: 'not_canceled', reason: 'share-dispatch-changed', activeDispatchId: 'turn-2' }) }))
      .toEqual({ reason: 'share-dispatch-changed', activeDispatchId: 'turn-2' });
    expect(shareCancelFailureFromHttpError({ body: JSON.stringify({ error: 'forbidden', reason: 'share-rate-limited' }) })).toEqual({ reason: 'share-rate-limited' });
    expect(shareCancelFailureFromHttpError(new Error('network'))).toBeNull();
    expect(shareCancelFailureFromHttpError({ body: 'not json' })).toBeNull();
  });
});
