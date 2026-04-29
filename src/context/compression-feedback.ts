import type { CompactionResultPayload } from '../../shared/compaction-events.js';

export interface ManualCompactionFeedbackInput {
  eventCount: number;
  inputTokens: number;
  summaryTokens: number;
  sourceEventIds: string[];
  elapsed: number;
}

export function summarizeManualCompaction(input: ManualCompactionFeedbackInput): CompactionResultPayload {
  const eventLabel = input.eventCount === 1 ? 'event' : 'events';
  return {
    headline: `Compressed ${input.eventCount} ${eventLabel} into one summary`,
    tokenLine: `~${input.inputTokens.toLocaleString()} → ~${input.summaryTokens.toLocaleString()} tokens in ${Math.max(0, Math.round(input.elapsed))}ms`,
    provenanceLine: `${input.sourceEventIds.length} source event${input.sourceEventIds.length === 1 ? '' : 's'} retrievable via chat_get_event`,
    sourceEventIds: input.sourceEventIds,
    class: undefined,
    dedupedIntoProjectionId: undefined,
    cosineToDedup: undefined,
  };
}
