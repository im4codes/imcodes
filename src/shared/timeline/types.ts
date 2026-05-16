/**
 * Shared structured timeline event types.
 * Used by daemon emitters and web timeline consumers.
 */

import type {
  ContextAuthorityDecision,
  MemoryRecallInjectionSurface,
  MemoryRecallRuntimeFamily,
  MemoryRecallSourceKind,
  ProcessedContextClass,
  ProcessedContextProjectionStatus,
} from '../../../shared/context-types.js';
import { TIMELINE_EVENT_FILE_CHANGE } from '../../../shared/file-change.js';
import type { TimelineDetailRef, TimelineEventCompleteness } from '../../../shared/timeline-protocol.js';

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
  | 'memory.context'
  // Emitted once per memory-compression call (NOT manual /compact, which is
  // forwarded to the SDK transport unchanged). Carries the backend+model that
  // did the compression plus token telemetry. Persisted to JSONL history for
  // operator queries; the web UI renders this event COLLAPSED by default —
  // a small one-liner in the chat stream that the user clicks to expand.
  | 'memory.compression';

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
  'memory.compression',
] as const satisfies readonly TimelineEventType[];

/** Payload schema for the `memory.compression` timeline event.
 *  Pinned here so daemon emit + web render share one source of truth. */
export interface MemoryCompressionTimelinePayload {
  backend: string;
  model: string;
  /** True when primary backend failed and we fell through to backup. */
  usedBackup: boolean;
  /** False ⇒ local-fallback path (no LLM ran); operators usually want to
   *  filter these out of cost analysis. */
  fromSdk: boolean;
  /** Materialization trigger that started the compression. */
  trigger?: string;
  /** Compression mode passed to compressWithSdk. */
  mode?: 'auto' | 'manual';
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  targetTokens: number;
  durationMs: number;
  /** Outcome category — same enum as the context_compression_runs table. */
  outcome: 'success' | 'fallback' | 'error' | 'admission_closed' | 'noop';
  /** When `outcome ≠ 'success'`, the classified compression error code. */
  errorCode?: string;
  /** Linked durable projection id when the run produced one. */
  projectionId?: string;
}

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
  payload: Record<string, unknown> & {
    completeness?: TimelineEventCompleteness;
    timelineCompleteness?: TimelineEventCompleteness;
    detailRefs?: TimelineDetailRef[];
  };
  completeness?: TimelineEventCompleteness;
  timelineCompleteness?: TimelineEventCompleteness;
  detailRefs?: TimelineDetailRef[];
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
  sourceKind?: MemoryRecallSourceKind;
  status?: MemoryContextTimelineStatus;
  matchedCount?: number;
  dedupedCount?: number;
}
