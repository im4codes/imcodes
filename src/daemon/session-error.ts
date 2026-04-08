import type { TimelineSource } from './timeline-event.js';
import { timelineEmitter } from './timeline-emitter.js';

export function formatSessionErrorMessage(message: string): string {
  return message.startsWith('⚠️') ? message : `⚠️ Error: ${message}`;
}

export function emitSessionInlineError(
  sessionId: string,
  message: string,
  source: TimelineSource = 'daemon',
): void {
  timelineEmitter.emit(sessionId, 'assistant.text', {
    text: formatSessionErrorMessage(message),
    streaming: false,
  }, { source, confidence: 'high' });
}
