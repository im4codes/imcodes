export const COMPACTION_RESULT_EVENT = 'compaction.result' as const;

export interface CompactionResultPayload {
  headline: string;
  tokenLine: string;
  provenanceLine: string;
  sourceEventIds?: string[];
  class?: string;
  dedupedIntoProjectionId?: string;
  cosineToDedup?: number;
}
