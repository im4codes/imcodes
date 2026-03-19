/**
 * Shared structured timeline event types.
 * Used by daemon emitters and web timeline consumers.
 */

export type TimelineEventType =
  | 'user.message'
  | 'assistant.text'
  | 'assistant.thinking'
  | 'tool.call'
  | 'tool.result'
  | 'mode.state'
  | 'session.state'
  | 'terminal.snapshot'
  | 'command.ack'
  | 'agent.status'
  | 'usage.update'
  | 'ask.question';

export type TimelineSource = 'daemon' | 'hook' | 'terminal-parse';
export type TimelineConfidence = 'high' | 'medium' | 'low';

export interface TimelineEvent {
  eventId: string;
  sessionId: string;
  ts: number;
  seq: number;
  epoch: number;
  source: TimelineSource;
  confidence: TimelineConfidence;
  type: TimelineEventType;
  payload: Record<string, unknown>;
  hidden?: boolean;
}
