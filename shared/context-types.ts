export type CanonicalRepositoryIdentityKind = 'git-origin' | 'local-fallback';

export interface CanonicalRepositoryId {
  kind: CanonicalRepositoryIdentityKind;
  key: string;
  host?: string;
  owner?: string;
  repo?: string;
  originUrl?: string;
  remoteName?: string;
  cwd?: string;
}

export interface RepositoryAlias {
  aliasKey: string;
  canonicalKey: string;
  reason: 'ssh-https-equivalent' | 'explicit-migration' | 'local-fallback';
  createdAt?: number;
}

export type ContextScope = 'personal' | 'project_shared' | 'workspace_shared' | 'org_shared';

export interface ContextNamespace {
  scope: ContextScope;
  projectId: string;
  userId?: string;
  workspaceId?: string;
  enterpriseId?: string;
}

export interface SharedScopePolicyOverride {
  allowDegradedProvider?: boolean;
  allowLocalProcessedFallback?: boolean;
  requireFullProviderSupport?: boolean;
}

export interface SharedContextNamespaceResolution {
  namespace: ContextNamespace | null;
  canonicalRepoId: string;
  visibilityState: 'active' | 'pending_removal' | 'removed' | 'unenrolled';
  remoteProcessedFreshness: ContextFreshness;
  retryExhausted: boolean;
  sharedPolicyOverride?: SharedScopePolicyOverride;
  diagnostics: string[];
}

export type ContextFreshness = 'fresh' | 'stale' | 'missing';

export type ContextSendSurface = 'interactive_ws' | 'watch_http' | 'cli' | 'cron';

export type AuthoredContextBindingMode = 'required' | 'advisory';

export interface RuntimeAuthoredContextBinding {
  bindingId: string;
  documentVersionId: string;
  mode: AuthoredContextBindingMode;
  scope: Exclude<ContextScope, 'personal'>;
  repository?: string;
  language?: string;
  pathPattern?: string;
  content: string;
  active?: boolean;
  superseded?: boolean;
}

export interface ContextAuthorityDecision {
  namespace: ContextNamespace;
  authoritySource: 'processed_remote' | 'processed_local' | 'staged_local' | 'none';
  freshness: ContextFreshness;
  fallbackAllowed: boolean;
  retryScheduled: boolean;
  providerPolicyOutcome: 'allowed' | 'degraded-allowed' | 'degraded-blocked' | 'unsupported';
  diagnostics: string[];
}

export interface CompiledAgentContextArtifact {
  systemText?: string;
  messagePreamble?: string;
  requiredAuthoredContext: string[];
  advisoryAuthoredContext: string[];
  appliedDocumentVersionIds: string[];
  diagnostics: string[];
}

export type ProviderSupportClass =
  | 'full-normalized-context-injection'
  | 'degraded-message-side-context-mapping'
  | 'unsupported';

export interface ProviderContextPayload {
  userMessage: string;
  assembledMessage: string;
  systemText?: string;
  messagePreamble?: string;
  attachments?: unknown[];
  context: CompiledAgentContextArtifact;
  authority: ContextAuthorityDecision;
  supportClass: ProviderSupportClass;
  diagnostics: string[];
}

export type ContextTargetKind = 'session' | 'project';

export interface ContextTargetRef {
  namespace: ContextNamespace;
  kind: ContextTargetKind;
  sessionName?: string;
}

export interface LocalContextEvent {
  id: string;
  target: ContextTargetRef;
  eventType: string;
  content?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

/**
 * Event types eligible for memory processing.
 * Final assistant responses and user messages qualify.
 * Streaming deltas, tool calls/results, and system events are excluded.
 */
export type MemoryEligibleEventType = 'assistant.text' | 'user.turn' | 'user.message';

/** Event types explicitly excluded from memory processing. */
export const MEMORY_EXCLUDED_EVENT_TYPES = [
  'assistant.delta',
  'tool.call',
  'tool.result',
  'session.state',
] as const;

export function isMemoryEligibleEvent(eventType: string): boolean {
  return eventType === 'assistant.text'
    || eventType === 'assistant.turn'  // legacy mapped from assistant.text
    || eventType === 'user.turn'
    || eventType === 'user.message'
    || eventType === 'decision'
    || eventType === 'constraint'
    || eventType === 'preference';
}

export type ContextJobType = 'materialize_session' | 'materialize_project' | 'replicate_processed_context';
export type ContextJobTrigger = 'idle' | 'threshold' | 'schedule' | 'recovery' | 'manual';
export type ContextJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'materialization_failed';

export interface ContextDirtyTarget {
  target: ContextTargetRef;
  eventCount: number;
  oldestEventAt: number;
  newestEventAt: number;
  lastTrigger?: ContextJobTrigger;
  pendingJobId?: string;
}

export interface ContextJobRecord {
  id: string;
  target: ContextTargetRef;
  jobType: ContextJobType;
  trigger: ContextJobTrigger;
  status: ContextJobStatus;
  createdAt: number;
  updatedAt: number;
  attemptCount: number;
  error?: string;
}

export type ProcessedContextClass = 'recent_summary' | 'durable_memory_candidate';

export type ProcessedContextProjectionStatus = 'active' | 'archived';

export interface ProcessedContextProjection {
  id: string;
  namespace: ContextNamespace;
  class: ProcessedContextClass;
  sourceEventIds: string[];
  summary: string;
  content: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  hitCount?: number;
  lastUsedAt?: number;
  status?: ProcessedContextProjectionStatus;
}

export interface ContextReplicationState {
  namespace: ContextNamespace;
  lastReplicatedAt?: number;
  pendingProjectionIds: string[];
  lastError?: string;
}

export type SharedContextRuntimeBackend = 'claude-code-sdk' | 'codex-sdk' | 'qwen' | 'openclaw';

export interface ContextModelConfig {
  primaryContextBackend: SharedContextRuntimeBackend;
  primaryContextModel: string;
  primaryContextSdk?: string;
  backupContextBackend?: SharedContextRuntimeBackend;
  backupContextModel?: string;
  backupContextSdk?: string;
  /** Minimum interval between materialization runs per target (ms). Default 10000. */
  materializationMinIntervalMs?: number;
  enablePersonalMemorySync?: boolean;
}

export interface ContextMemoryStatsView {
  totalRecords: number;
  matchedRecords: number;
  recentSummaryCount: number;
  durableCandidateCount: number;
  projectCount: number;
  stagedEventCount: number;
  dirtyTargetCount: number;
  pendingJobCount: number;
}

export interface ContextMemoryRecordView {
  id: string;
  scope: 'personal' | 'project_shared' | 'workspace_shared' | 'org_shared';
  projectId: string;
  summary: string;
  projectionClass: 'recent_summary' | 'durable_memory_candidate';
  sourceEventCount: number;
  updatedAt: number;
  hitCount?: number;
  lastUsedAt?: number;
  status?: ProcessedContextProjectionStatus;
}

export interface ContextPendingEventView {
  id: string;
  projectId: string;
  sessionName?: string;
  eventType: string;
  content?: string;
  createdAt: number;
}

export interface ContextMemoryView {
  stats: ContextMemoryStatsView;
  records: ContextMemoryRecordView[];
  pendingRecords?: ContextPendingEventView[];
}

export interface ProcessedContextReplicationBody {
  namespace: ContextNamespace;
  projections: ProcessedContextProjection[];
}
