/**
 * Shared structured timeline event types.
 * Used by daemon emitters and web timeline consumers.
 */

import type {
  ContextAuthorityDecision,
  MemoryRecallInjectionSurface,
  MemoryRecallRuntimeFamily,
  ProcessedContextClass,
  ProcessedContextProjectionStatus,
} from '../../../shared/context-types.js';
import { TIMELINE_EVENT_FILE_CHANGE } from '../../../shared/file-change.js';

export type TimelineEventType =
  | 'user.message'
  | 'assistant.text'
  | 'assistant.thinking'
  | 'tool.call'
  | 'tool.result'
  | typeof TIMELINE_EVENT_FILE_CHANGE
  | 'mode.state'
  | 'session.state'
  | 'terminal.snapshot'
  | 'command.ack'
  | 'agent.status'
  | 'usage.update'
  | 'ask.question'
  | 'memory.context';

export const TIMELINE_HISTORY_CONTENT_TYPES = [
  'user.message',
  'assistant.text',
  'assistant.thinking',
  'tool.call',
  'tool.result',
  TIMELINE_EVENT_FILE_CHANGE,
  'mode.state',
  'terminal.snapshot',
  'command.ack',
  'agent.status',
  'usage.update',
  'ask.question',
  'memory.context',
] as const satisfies readonly TimelineEventType[];

export const TIMELINE_HISTORY_STATE_TYPES = [
  'session.state',
] as const satisfies readonly TimelineEventType[];

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
  scope?: string;
  enterpriseId?: string;
  workspaceId?: string;
  userId?: string;
  summary: string;
  projectionClass?: ProcessedContextClass;
  hitCount?: number;
  lastUsedAt?: number;
  status?: ProcessedContextProjectionStatus;
  relevanceScore?: number;
}

export type MemoryContextTimelineStatus =
  | 'no_matches'
  | 'deduped_recently'
  | 'skipped_template_prompt'
  | 'skipped_short_prompt'
  | 'skipped_control_message'
  | 'failed';

export interface MemoryContextTimelinePayload {
  relatedToEventId?: string;
  query?: string;
  injectedText?: string;
  items: MemoryContextTimelineItem[];
  reason?: 'message' | 'startup';
  runtimeFamily?: MemoryRecallRuntimeFamily;
  injectionSurface?: MemoryRecallInjectionSurface;
  authoritySource?: ContextAuthorityDecision['authoritySource'];
  sourceKind?: 'local_processed' | 'remote_processed';
  status?: MemoryContextTimelineStatus;
  matchedCount?: number;
  dedupedCount?: number;
}
