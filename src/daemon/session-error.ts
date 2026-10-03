import type { TimelineSource } from './timeline-event.js';
import { timelineEmitter } from './timeline-emitter.js';
import { attachDaemonUserNotice, DAEMON_USER_NOTICE_CODE } from '../../shared/daemon-user-notices.js';

export function formatSessionErrorMessage(message: string): string {
  return message.startsWith('⚠️') ? message : `⚠️ Error: ${message}`;
}

export function emitSessionInlineError(
  sessionId: string,
  message: string,
  source: TimelineSource = 'daemon',
): void {
  timelineEmitter.emit(sessionId, 'assistant.text', {
    ...attachDaemonUserNotice(
      DAEMON_USER_NOTICE_CODE.SESSION_INLINE_ERROR,
      formatSessionErrorMessage(message),
      { detail: message },
    ),
    streaming: false,
    memoryExcluded: true,
  }, { source, confidence: 'high' });
}
