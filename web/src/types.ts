import type { SessionContextBootstrapState } from '../../shared/session-context-bootstrap.js';
import type { SharedStateSummary } from './tab-sharing-ui.js';

export type Priority = 0 | 1 | 2 | 3;

export interface TrackerIssue {
  id: string;
  title: string;
  body: string;
  priority: Priority;
  labels: string[];
  url: string;
  assignee?: string;
  state: 'open' | 'closed';
  createdAt: number;
  updatedAt: number;
}

export interface AutoFixTaskStatus {
  id: string;
  title: string;
  state: 'planning' | 'design_review' | 'implementing' | 'code_review' | 'approved' | 'done' | 'failed';
  discussionRounds: number;
  maxDiscussionRounds: number;
  coderSession: string;
  auditorSession: string;
  branch?: string;
  issueId?: string;
  startedAt: number;
  updatedAt: number;
  error?: string;
}

export interface SessionInfo {
  name: string;
  project: string;
  role: 'brain' | `w${number}`;
  agentType: string;
  agentVersion?: string;
  state: 'queued' | 'running' | 'idle' | 'stopped' | 'stopping' | 'error' | 'unknown';
  label?: string | null;
  userCreated?: boolean;
  projectDir?: string;
  description?: string | null;
  /** Runtime backing: 'process' for tmux-backed, 'transport' for network-backed. */
  runtimeType?: 'process' | 'transport';
  qwenModel?: string;
  ccPreset?: string | null;
  requestedModel?: string;
  activeModel?: string;
  qwenAuthType?: string;
  qwenAuthLimit?: string;
  qwenAvailableModels?: string[];
  copilotAvailableModels?: string[];
  cursorAvailableModels?: string[];
  codexAvailableModels?: string[];
  modelDisplay?: string;
  planLabel?: string;
  permissionLabel?: string;
  quotaLabel?: string;
  quotaUsageLabel?: string;
  quotaMeta?: import('../../shared/provider-quota.js').ProviderQuotaMeta | null;
  effort?: import('../../shared/effort-levels.js').TransportEffortLevel;
  contextNamespace?: SessionContextBootstrapState['contextNamespace'];
  contextNamespaceDiagnostics?: string[];
  transportConfig?: Record<string, unknown> | null;
  transportPendingMessages?: string[];
  transportPendingMessageEntries?: import('./transport-queue.js').TransportPendingMessageEntry[];
  /** Newest pending-queue version the UI has applied for this session.
   *  Used to drop stale out-of-order snapshots. See transport-queue.ts. */
  transportPendingMessageVersion?: number;
  /** Passive, share-scoped state supplied by share-aware server/bootstrap paths. */
  sharedState?: SharedStateSummary | null;
  /** DAEMON-AUTHORITATIVE: whether this session may serve as an execution-clone
   *  template. The UI renders this flag rather than recomputing eligibility. */
  executionTemplateEligible?: boolean;
  /** DAEMON-AUTHORITATIVE: ineligibility reason (meaningful only when
   *  `executionTemplateEligible === false`). */
  executionTemplateIneligibleReason?: string;
}

export interface ServerInfo {
  id: string;
  name: string;
  online: boolean;
  lastSeen?: number;
}

export type { TerminalDiff } from '../../src/shared/transport/terminal.js';
