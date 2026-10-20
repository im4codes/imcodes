import type { TimelineEvent } from '../../src/shared/timeline/types.js';
import {
  DAEMON_USER_NOTICE_I18N_KEYS,
  isDaemonUserNoticeCode,
  normalizeDaemonUserNoticeParams,
} from '@shared/daemon-user-notices.js';

export type NoticeTranslator = (key: string, options?: Record<string, unknown>) => string;

/** Translate only authenticated daemon notices; legacy/unknown events retain text. */
export function localizeDaemonUserNoticeEvent(
  event: TimelineEvent,
  t: NoticeTranslator,
): TimelineEvent {
  if (
    event.type !== 'assistant.text'
    || event.source !== 'daemon'
    || event.confidence === 'low'
    || !isDaemonUserNoticeCode(event.payload.noticeCode)
  ) return event;
  const code = event.payload.noticeCode;
  const fallback = typeof event.payload.text === 'string' ? event.payload.text : '';
  const key = DAEMON_USER_NOTICE_I18N_KEYS[code];
  const params = normalizeDaemonUserNoticeParams(code, event.payload.noticeParams);
  let translated = t(key, {
    ...params,
    defaultValue: fallback,
  });
  // Diagnostic details are daemon-authored, bounded and redacted by the shared
  // contract. A locale may place {{detail}} itself; older locale resources use
  // the translated generic sentence as a prefix, so append the same safe detail
  // rather than silently replacing the actionable fallback with generic copy.
  const detail = typeof params.detail === 'string' ? params.detail : '';
  if (detail && translated && translated !== key && !translated.includes(detail)) {
    translated = `${translated} ${detail}`;
  }
  if (!translated || translated === key || translated === fallback) return event;
  return { ...event, payload: { ...event.payload, text: translated } };
}
