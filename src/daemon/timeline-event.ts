/**
 * Structured timeline event types for the mobile chat view.
 * Events are the authoritative data source for the chat timeline.
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
  /** tmux session name — same value as sessionName in WS commands */
  sessionId: string;
  ts: number;
  /** Per-session monotonic counter (resets on daemon restart, tracked via epoch) */
  seq: number;
  /** daemon startup timestamp — changes on restart, used for seq continuity detection */
  epoch: number;
  source: TimelineSource;
  confidence: TimelineConfidence;
  type: TimelineEventType;
  payload: Record<string, unknown>;
  hidden?: boolean;
}
