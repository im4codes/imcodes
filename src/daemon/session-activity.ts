/**
 * Process-local activity projection used by cheap orchestration/status tools.
 * Timeline persistence remains the source of history; this intentionally keeps
 * only the latest user/assistant message and provider tool-call timestamps so
 * a single status call never performs provider I/O or scans JSONL files.
 */
import { timelineEmitter } from './timeline-emitter.js';
import type { TimelineEvent } from './timeline-event.js';

export interface SessionActivitySnapshot {
  lastMessageAt?: number;
  lastToolCallAt?: number;
}

const activity = new Map<string, SessionActivitySnapshot>();

function note(event: TimelineEvent): void {
  // Supervision automation messages are control-plane traffic, not participant
  // activity; counting them would make a stuck pair look healthy forever.
  if (event.type === 'user.message' && (event.payload as Record<string, unknown>).automation === true) return;
  const current = activity.get(event.sessionId) ?? {};
  const ts = event.ts;
  if (event.type === 'user.message' || event.type === 'assistant.text') {
    current.lastMessageAt = Math.max(current.lastMessageAt ?? 0, ts);
  } else if (event.type === 'tool.call' || event.type === 'tool.result') {
    current.lastToolCallAt = Math.max(current.lastToolCallAt ?? 0, ts);
  }
  activity.set(event.sessionId, current);
}

// A few transport unit tests replace the timeline emitter with a narrow fake;
// the projection is optional in those isolated seams and must not make the
// send tool unimportable.
if (typeof timelineEmitter.on === 'function') timelineEmitter.on(note);

export function sessionActivityOf(sessionName: string): SessionActivitySnapshot | undefined {
  const value = activity.get(sessionName);
  return value ? { ...value } : undefined;
}

export function resetSessionActivityForTests(): void {
  activity.clear();
}
