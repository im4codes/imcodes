/**
 * Shared structured timeline event types.
 * Used by daemon emitters and web timeline consumers.
 */

import type { ProcessedContextClass, ProcessedContextProjectionStatus } from '../../../shared/context-types.js';

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
  | 'ask.question'
  | 'memory.context';

export type TimelineSource = 'daemon' | 'hook' | 'terminal-parse' | 'terminal-spinner';
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

export interface MemoryContextTimelineItem {
  id: string;
  projectId: string;
  summary: string;
  projectionClass?: ProcessedContextClass;
  hitCount?: number;
  lastUsedAt?: number;
  status?: ProcessedContextProjectionStatus;
  relevanceScore?: number;
}

export interface MemoryContextTimelinePayload {
  relatedToEventId?: string;
  query?: string;
  injectedText: string;
  items: MemoryContextTimelineItem[];
  reason?: 'message' | 'startup';
}
