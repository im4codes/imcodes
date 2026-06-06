export const SHARE_ROLES = ['viewer', 'participant'] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];

export const EFFECTIVE_ACTOR_ROLES = [
  'viewer',
  'participant',
  'server-member',
  'server-manager',
  'system',
] as const;
export type EffectiveActorRole = (typeof EFFECTIVE_ACTOR_ROLES)[number];

export type ShareTarget =
  | { kind: 'server'; serverId: string }
  | { kind: 'main'; serverId: string; sessionName: string }
  | { kind: 'subsession'; serverId: string; subSessionId: string };

export type ShareTargetInput =
  | { kind: 'server'; serverId: string }
  | { kind: 'main'; serverId: string; sessionName: string }
  | {
      kind: 'subsession';
      serverId: string;
      subSessionId: string;
      subSessionDisplayName?: string;
    }
  | {
      kind: 'subsession';
      serverId: string;
      sessionName: `deck_sub_${string}`;
      subSessionDisplayName?: string;
    };

export interface ShareAuthorizationSnapshot {
  target: ShareTarget;
  effectiveRole: ShareRole;
  /**
   * Back-compat field retained in tickets, audit snapshots, and UI payloads.
   * Collaborative sharing exposes full target history by scope, so newly
   * resolved coverage sets this to 0 and policy code must not use it as an
   * invite-time history filter.
   */
  historyCutoffAt: number;
  nextCoverageRecheckAt: number | null;
  coveringShareIds: string[];
  primaryShareId: string | null;
  authorizedAt: number;
}

export type EffectiveCoverage = ShareAuthorizationSnapshot;

export interface ShareScopedTicketClaims {
  type: 'share-ws-ticket';
  sub: string;
  jti: string;
  serverId: string;
  target: ShareTarget;
  snapshot: ShareAuthorizationSnapshot;
  issuedAt: number;
  expiresAt: number;
}

export interface SharedActorEnvelope {
  actorUserId: string;
  actorDisplayName: string;
  snapshot: ShareAuthorizationSnapshot;
  primaryShareId: string | null;
  effectiveActorRole: EffectiveActorRole;
  actionId: string;
  origin: 'shared-server' | 'shared-tab' | 'server-member';
  authorizedAt: number;
  queuedAt?: number;
  daemonAckedAt?: number;
}

export const SHARE_DENIAL_REASONS = [
  'share-role-denied',
  'share-direct-surface-denied',
  'share-rate-limited',
  'share-revoked',
  'share-expired',
  'share-target-unavailable',
  'share-role-changed',
  'share-ticket-invalid',
  'share-cancel-unsupported',
  'share-audit-duplicate',
  'share-comment-invalid',
] as const;

export type ShareDenialReason = (typeof SHARE_DENIAL_REASONS)[number];

export const SHARE_ROLE_ORDER: Record<ShareRole, number> = {
  viewer: 1,
  participant: 2,
};

export interface ShareGrantLike {
  id: string;
  target: ShareTarget;
  role: ShareRole;
  createdAt: number;
  expiresAt?: number | null;
  revokedAt?: number | null;
}

export interface NormalizeShareTargetOptions {
  subSessionExists?: (subSessionId: string, serverId: string) => boolean;
}

export type NormalizeShareTargetResult =
  | { ok: true; target: ShareTarget }
  | { ok: false; reason: 'missing-identifier' | 'conflicting-identifiers' | 'malformed-subsession-id' | 'target-not-found' };

export type ShareCommandDisposition = 'allow' | 'deny';
export type ShareCommandScope = 'server' | 'concrete-tab' | 'direct-surface' | 'global';

export interface ShareCommandPolicyEntry {
  disposition: ShareCommandDisposition;
  minRole?: ShareRole;
  scope: ShareCommandScope;
  reason?: ShareDenialReason;
  requiresObservedDispatchId?: boolean;
  transportOnly?: boolean;
}

export const SHARE_BROWSER_COMMANDS = {
  OPEN_SHARED_ENTRY: 'share.open',
  LIST_SHARED_ENTRIES: 'share.list',
  ISSUE_WS_TICKET: 'share.ws_ticket',
  TERMINAL_OUTPUT: 'terminal.output',
  TERMINAL_SNAPSHOT: 'terminal.snapshot',
  TERMINAL_HISTORY: 'terminal.history',
  TERMINAL_INPUT: 'terminal.input',
  TERMINAL_RESIZE: 'terminal.resize',
  DISCUSSION_COMMENT: 'discussion.comment',
  DISCUSSION_START: 'discussion.start',
  P2P_STATUS: 'p2p.status',
  P2P_LIST_DISCUSSIONS: 'p2p.list_discussions',
  P2P_READ_DISCUSSION: 'p2p.read_discussion',
  P2P_RUN_START: 'p2p.run_start',
  P2P_CANCEL: 'p2p.cancel',
  P2P_CONFIG_SAVE: 'p2p.config.save',
  SESSION_SEND: 'session.send',
  SESSION_CANCEL: 'session.cancel',
  SESSION_STOP: 'session.stop',
  SESSION_START: 'session.start',
  SESSION_RESTART: 'session.restart',
  SUBSESSION_LIST: 'subsession.list',
  SUBSESSION_START: 'subsession.start',
  SUBSESSION_STOP: 'subsession.stop',
  SUBSESSION_RESTART: 'subsession.restart',
  QUEUE_EDIT: 'queue.edit',
  QUEUE_UNDO: 'queue.undo',
  QUEUE_CANCEL: 'queue.cancel',
  QUEUE_REMOVE: 'queue.remove',
  QUEUE_REORDER: 'queue.reorder',
  SESSION_GROUP_CLONE: 'session.group_clone',
  CHAT_HISTORY: 'chat.history',
  CHAT_APPROVAL_RESPONSE: 'chat.approval_response',
  PROVIDER_STATUS: 'provider.status',
  PROVIDER_LIST: 'provider.list',
  LOCAL_WEB_PREVIEW: 'local_web.preview',
  FILE_READ: 'file.read',
  FILE_WRITE: 'file.write',
  FILE_EDIT: 'file.edit',
  FILE_DELETE: 'file.delete',
  FILE_PATCH: 'file.patch',
  FILE_BROWSE: 'file.browse',
  FILE_SEARCH: 'file.search',
  REPO_STATUS: 'repo.status',
  REPO_DIFF: 'repo.diff',
  REPO_COMMIT: 'repo.commit',
  REPO_PUSH: 'repo.push',
  REPO_PULL: 'repo.pull',
  REPO_BRANCH: 'repo.branch',
  REPO_SEARCH: 'repo.search',
  MEMORY_QUERY: 'memory.query',
  MEMORY_MUTATE: 'memory.mutate',
  CRON_LIST: 'cron.list',
  CRON_MUTATE: 'cron.mutate',
  CREDENTIALS: 'credentials.manage',
  BILLING: 'billing.manage',
  MEMBERSHIP: 'membership.manage',
  ADMIN_SETTINGS: 'admin.settings',
} as const;

export type ShareBrowserCommand = (typeof SHARE_BROWSER_COMMANDS)[keyof typeof SHARE_BROWSER_COMMANDS];

export const SHARE_DISCUSSION_EVENTS = {
  COMMENT_CREATED: 'discussion.comment.created',
} as const;

export const SHARE_SCOPED_COMMAND_POLICY = {
  [SHARE_BROWSER_COMMANDS.OPEN_SHARED_ENTRY]: allow('server'),
  [SHARE_BROWSER_COMMANDS.LIST_SHARED_ENTRIES]: allow('server'),
  [SHARE_BROWSER_COMMANDS.ISSUE_WS_TICKET]: allow('server'),
  [SHARE_BROWSER_COMMANDS.TERMINAL_OUTPUT]: allow('concrete-tab'),
  [SHARE_BROWSER_COMMANDS.TERMINAL_SNAPSHOT]: allow('concrete-tab'),
  [SHARE_BROWSER_COMMANDS.TERMINAL_HISTORY]: allow('concrete-tab'),
  [SHARE_BROWSER_COMMANDS.DISCUSSION_COMMENT]: allow('server'),
  [SHARE_BROWSER_COMMANDS.P2P_STATUS]: allow('server'),
  [SHARE_BROWSER_COMMANDS.P2P_LIST_DISCUSSIONS]: allow('server'),
  [SHARE_BROWSER_COMMANDS.P2P_READ_DISCUSSION]: allow('server'),
  [SHARE_BROWSER_COMMANDS.CHAT_HISTORY]: allow('concrete-tab'),
  [SHARE_BROWSER_COMMANDS.DISCUSSION_START]: allowParticipant('server'),
  [SHARE_BROWSER_COMMANDS.P2P_RUN_START]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.P2P_CANCEL]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.SESSION_SEND]: allowParticipant('concrete-tab'),
  [SHARE_BROWSER_COMMANDS.SESSION_CANCEL]: {
    ...allowParticipant('concrete-tab'),
    requiresObservedDispatchId: true,
    transportOnly: true,
  },
  [SHARE_BROWSER_COMMANDS.TERMINAL_INPUT]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.TERMINAL_RESIZE]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.SESSION_STOP]: deny('global', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.SESSION_START]: deny('global', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.SESSION_RESTART]: deny('global', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.SUBSESSION_LIST]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.SUBSESSION_START]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.SUBSESSION_STOP]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.SUBSESSION_RESTART]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.QUEUE_EDIT]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.QUEUE_UNDO]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.QUEUE_CANCEL]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.QUEUE_REMOVE]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.QUEUE_REORDER]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.SESSION_GROUP_CLONE]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.P2P_CONFIG_SAVE]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.CHAT_APPROVAL_RESPONSE]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.PROVIDER_STATUS]: deny('global', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.PROVIDER_LIST]: deny('global', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.LOCAL_WEB_PREVIEW]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.FILE_READ]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.FILE_WRITE]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.FILE_EDIT]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.FILE_DELETE]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.FILE_PATCH]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.FILE_BROWSE]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.FILE_SEARCH]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.REPO_STATUS]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.REPO_DIFF]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.REPO_COMMIT]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.REPO_PUSH]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.REPO_PULL]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.REPO_BRANCH]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.REPO_SEARCH]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.MEMORY_QUERY]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.MEMORY_MUTATE]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.CRON_LIST]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.CRON_MUTATE]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.CREDENTIALS]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.BILLING]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.MEMBERSHIP]: deny('direct-surface', 'share-direct-surface-denied'),
  [SHARE_BROWSER_COMMANDS.ADMIN_SETTINGS]: deny('direct-surface', 'share-direct-surface-denied'),
} as const satisfies Record<ShareBrowserCommand, ShareCommandPolicyEntry>;

export const UNKNOWN_SHARE_COMMAND_POLICY: ShareCommandPolicyEntry = deny('global', 'share-direct-surface-denied');

export type ShareHttpRouteDisposition = 'share-aware' | 'share-denied' | 'not-applicable';

export interface ShareHttpRoutePolicyEntry {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pattern: string;
  command: ShareBrowserCommand;
  disposition: ShareHttpRouteDisposition;
  reason?: ShareDenialReason;
}

export const SHARE_HTTP_ROUTE_POLICY_INVENTORY = [
  { id: 'recipient-share-list', method: 'GET', pattern: '/api/shares', command: SHARE_BROWSER_COMMANDS.LIST_SHARED_ENTRIES, disposition: 'share-aware' },
  { id: 'recipient-share-open', method: 'POST', pattern: '/api/shares/open', command: SHARE_BROWSER_COMMANDS.OPEN_SHARED_ENTRY, disposition: 'share-aware' },
  { id: 'recipient-share-ws-ticket', method: 'POST', pattern: '/api/shares/ws-ticket', command: SHARE_BROWSER_COMMANDS.ISSUE_WS_TICKET, disposition: 'share-aware' },
  { id: 'watch-session-list', method: 'GET', pattern: '/api/watch/sessions', command: SHARE_BROWSER_COMMANDS.PROVIDER_LIST, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'timeline-history', method: 'GET', pattern: '/api/server/:id/timeline/history', command: SHARE_BROWSER_COMMANDS.CHAT_HISTORY, disposition: 'share-aware' },
  { id: 'timeline-history-full', method: 'GET', pattern: '/api/server/:id/timeline/history/full', command: SHARE_BROWSER_COMMANDS.CHAT_HISTORY, disposition: 'share-aware' },
  { id: 'timeline-text-tail', method: 'GET', pattern: '/api/server/:id/timeline/text-tail', command: SHARE_BROWSER_COMMANDS.TERMINAL_HISTORY, disposition: 'share-aware' },
  { id: 'discussion-list', method: 'GET', pattern: '/api/server/:id/discussions', command: SHARE_BROWSER_COMMANDS.P2P_LIST_DISCUSSIONS, disposition: 'share-aware' },
  { id: 'discussion-detail', method: 'GET', pattern: '/api/server/:id/discussions/:discussionId', command: SHARE_BROWSER_COMMANDS.P2P_READ_DISCUSSION, disposition: 'share-aware' },
  { id: 'discussion-comment', method: 'POST', pattern: '/api/server/:id/discussions/comments', command: SHARE_BROWSER_COMMANDS.DISCUSSION_COMMENT, disposition: 'share-aware' },
  { id: 'discussion-runs', method: 'GET', pattern: '/api/server/:id/discussions/:discussionId/runs', command: SHARE_BROWSER_COMMANDS.P2P_STATUS, disposition: 'share-aware' },
  { id: 'p2p-recent', method: 'GET', pattern: '/api/server/:id/p2p/runs', command: SHARE_BROWSER_COMMANDS.P2P_STATUS, disposition: 'share-aware' },
  { id: 'p2p-run-detail', method: 'GET', pattern: '/api/server/:id/p2p/runs/:runId', command: SHARE_BROWSER_COMMANDS.P2P_READ_DISCUSSION, disposition: 'share-aware' },
  { id: 'session-send', method: 'POST', pattern: '/api/server/:id/session/send', command: SHARE_BROWSER_COMMANDS.SESSION_SEND, disposition: 'share-aware' },
  { id: 'session-cancel', method: 'POST', pattern: '/api/server/:id/session/cancel', command: SHARE_BROWSER_COMMANDS.SESSION_CANCEL, disposition: 'share-aware' },
  { id: 'session-start', method: 'POST', pattern: '/api/server/:id/session/start', command: SHARE_BROWSER_COMMANDS.SESSION_START, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'session-stop', method: 'POST', pattern: '/api/server/:id/session/stop', command: SHARE_BROWSER_COMMANDS.SESSION_STOP, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'session-settings', method: 'PATCH', pattern: '/api/server/:id/sessions/:name', command: SHARE_BROWSER_COMMANDS.SESSION_RESTART, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'session-relabel', method: 'PATCH', pattern: '/api/server/:id/sessions/:name/label', command: SHARE_BROWSER_COMMANDS.SESSION_RESTART, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'session-rename', method: 'PATCH', pattern: '/api/server/:id/sessions/:name/rename', command: SHARE_BROWSER_COMMANDS.SESSION_RESTART, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'session-delete', method: 'DELETE', pattern: '/api/server/:id/sessions/:name', command: SHARE_BROWSER_COMMANDS.SESSION_STOP, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'session-group-clone', method: 'POST', pattern: '/api/server/:id/sessions/:rootSession/group-clone', command: SHARE_BROWSER_COMMANDS.SESSION_GROUP_CLONE, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'subsession-list', method: 'GET', pattern: '/api/server/:id/sub-sessions', command: SHARE_BROWSER_COMMANDS.SUBSESSION_LIST, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'subsession-create', method: 'POST', pattern: '/api/server/:id/sub-sessions', command: SHARE_BROWSER_COMMANDS.SUBSESSION_START, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'subsession-reorder', method: 'PATCH', pattern: '/api/server/:id/sub-sessions/reorder', command: SHARE_BROWSER_COMMANDS.SUBSESSION_RESTART, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'subsession-update', method: 'PATCH', pattern: '/api/server/:id/sub-sessions/:subId', command: SHARE_BROWSER_COMMANDS.SUBSESSION_RESTART, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'subsession-close', method: 'DELETE', pattern: '/api/server/:id/sub-sessions/:subId', command: SHARE_BROWSER_COMMANDS.SUBSESSION_STOP, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'local-web-preview-create', method: 'POST', pattern: '/api/server/:id/local-web-preview', command: SHARE_BROWSER_COMMANDS.LOCAL_WEB_PREVIEW, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'local-web-preview-close', method: 'DELETE', pattern: '/api/server/:id/local-web-preview/:previewId', command: SHARE_BROWSER_COMMANDS.LOCAL_WEB_PREVIEW, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'file-upload', method: 'POST', pattern: '/api/server/:id/upload', command: SHARE_BROWSER_COMMANDS.FILE_WRITE, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'file-download-token', method: 'POST', pattern: '/api/server/:id/uploads/:attachmentId/download-token', command: SHARE_BROWSER_COMMANDS.FILE_READ, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'file-download', method: 'GET', pattern: '/api/server/:id/uploads/:attachmentId/download', command: SHARE_BROWSER_COMMANDS.FILE_READ, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'memory-sources', method: 'GET', pattern: '/api/memory/sources', command: SHARE_BROWSER_COMMANDS.MEMORY_QUERY, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'cron-list', method: 'GET', pattern: '/api/server/:serverId/cron', command: SHARE_BROWSER_COMMANDS.CRON_LIST, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'cron-create', method: 'POST', pattern: '/api/server/:serverId/cron', command: SHARE_BROWSER_COMMANDS.CRON_MUTATE, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'cron-update', method: 'PUT', pattern: '/api/server/:serverId/cron/:id', command: SHARE_BROWSER_COMMANDS.CRON_MUTATE, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'cron-status', method: 'PATCH', pattern: '/api/server/:serverId/cron/:id/status', command: SHARE_BROWSER_COMMANDS.CRON_MUTATE, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'cron-delete', method: 'DELETE', pattern: '/api/server/:serverId/cron/:id', command: SHARE_BROWSER_COMMANDS.CRON_MUTATE, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'cron-trigger', method: 'POST', pattern: '/api/server/:serverId/cron/:id/trigger', command: SHARE_BROWSER_COMMANDS.CRON_MUTATE, disposition: 'share-denied', reason: 'share-direct-surface-denied' },
  { id: 'share-management-list', method: 'GET', pattern: '/api/server/:serverId/shares', command: SHARE_BROWSER_COMMANDS.MEMBERSHIP, disposition: 'not-applicable' },
  { id: 'share-management-create', method: 'POST', pattern: '/api/server/:serverId/shares', command: SHARE_BROWSER_COMMANDS.MEMBERSHIP, disposition: 'not-applicable' },
  { id: 'share-audit', method: 'GET', pattern: '/api/server/:serverId/share-audit', command: SHARE_BROWSER_COMMANDS.ADMIN_SETTINGS, disposition: 'not-applicable' },
] as const satisfies readonly ShareHttpRoutePolicyEntry[];

export type ShareDaemonMessageDelivery = 'allow' | 'drop';
export type ShareDaemonMessageTargetKind = 'server' | 'main' | 'subsession' | 'unknown';

export interface ShareDaemonMessagePolicyEntry {
  type: string;
  delivery: ShareDaemonMessageDelivery;
  targetKind: ShareDaemonMessageTargetKind;
  cutoffBounded: boolean;
  redactGlobalFields: boolean;
  reason?: ShareDenialReason;
}

export const SHARE_DAEMON_MESSAGE_TYPES = {
  SESSION_LIST: 'session_list',
  SESSION_EVENT: 'session.event',
  SESSION_IDLE: 'session.idle',
  SESSION_NOTIFICATION: 'session.notification',
  SESSION_ERROR: 'session.error',
  SESSION_TOOL: 'session.tool',
  TERMINAL_DIFF: 'terminal.diff',
  TERMINAL_HISTORY: 'terminal.history',
  TERMINAL_STREAM_RESET: 'terminal.stream_reset',
  TIMELINE_EVENT: 'timeline.event',
  TIMELINE_EVENTS: 'timeline.events',
  DISCUSSION_STARTED: 'discussion.started',
  DISCUSSION_UPDATE: 'discussion.update',
  DISCUSSION_SAVE: 'discussion.save',
  DISCUSSION_DONE: 'discussion.done',
  DISCUSSION_ERROR: 'discussion.error',
  DISCUSSION_LIST: 'discussion.list',
  P2P_STATUS_RESPONSE: 'p2p.status_response',
  P2P_LIST_DISCUSSIONS_RESPONSE: 'p2p.list_discussions_response',
  P2P_READ_DISCUSSION_RESPONSE: 'p2p.read_discussion_response',
  P2P_RUN_STARTED: 'p2p.run_started',
  P2P_RUN_UPDATE: 'p2p.run_update',
  P2P_RUN_COMPLETE: 'p2p.run_complete',
  P2P_RUN_ERROR: 'p2p.run_error',
  P2P_CANCEL_RESPONSE: 'p2p.cancel_response',
  QUEUE_STATE: 'queue.state',
} as const;

export type ShareDaemonMessageType = (typeof SHARE_DAEMON_MESSAGE_TYPES)[keyof typeof SHARE_DAEMON_MESSAGE_TYPES];

export const SHARE_SCOPED_DAEMON_MESSAGE_POLICY = {
  [SHARE_DAEMON_MESSAGE_TYPES.SESSION_LIST]: daemonAllow('server', false, true),
  [SHARE_DAEMON_MESSAGE_TYPES.SESSION_EVENT]: daemonAllow('main', true),
  [SHARE_DAEMON_MESSAGE_TYPES.SESSION_IDLE]: daemonAllow('main', true),
  [SHARE_DAEMON_MESSAGE_TYPES.SESSION_NOTIFICATION]: daemonAllow('main', true),
  [SHARE_DAEMON_MESSAGE_TYPES.SESSION_ERROR]: daemonAllow('main', true),
  [SHARE_DAEMON_MESSAGE_TYPES.SESSION_TOOL]: daemonAllow('main', true),
  [SHARE_DAEMON_MESSAGE_TYPES.TERMINAL_DIFF]: daemonAllow('main', true),
  [SHARE_DAEMON_MESSAGE_TYPES.TERMINAL_HISTORY]: daemonAllow('main', true),
  [SHARE_DAEMON_MESSAGE_TYPES.TERMINAL_STREAM_RESET]: daemonAllow('main', true),
  [SHARE_DAEMON_MESSAGE_TYPES.TIMELINE_EVENT]: daemonAllow('main', true),
  [SHARE_DAEMON_MESSAGE_TYPES.TIMELINE_EVENTS]: daemonAllow('main', true),
  [SHARE_DAEMON_MESSAGE_TYPES.DISCUSSION_STARTED]: daemonAllow('server', true),
  [SHARE_DAEMON_MESSAGE_TYPES.DISCUSSION_UPDATE]: daemonAllow('server', true),
  [SHARE_DAEMON_MESSAGE_TYPES.DISCUSSION_SAVE]: daemonAllow('server', true),
  [SHARE_DAEMON_MESSAGE_TYPES.DISCUSSION_DONE]: daemonAllow('server', true),
  [SHARE_DAEMON_MESSAGE_TYPES.DISCUSSION_ERROR]: daemonAllow('server', true),
  [SHARE_DAEMON_MESSAGE_TYPES.DISCUSSION_LIST]: daemonAllow('server', true),
  [SHARE_DAEMON_MESSAGE_TYPES.P2P_STATUS_RESPONSE]: daemonAllow('server', true),
  [SHARE_DAEMON_MESSAGE_TYPES.P2P_LIST_DISCUSSIONS_RESPONSE]: daemonAllow('server', true),
  [SHARE_DAEMON_MESSAGE_TYPES.P2P_READ_DISCUSSION_RESPONSE]: daemonAllow('server', true),
  [SHARE_DAEMON_MESSAGE_TYPES.P2P_RUN_STARTED]: daemonAllow('server', true),
  [SHARE_DAEMON_MESSAGE_TYPES.P2P_RUN_UPDATE]: daemonAllow('server', true),
  [SHARE_DAEMON_MESSAGE_TYPES.P2P_RUN_COMPLETE]: daemonAllow('server', true),
  [SHARE_DAEMON_MESSAGE_TYPES.P2P_RUN_ERROR]: daemonAllow('server', true),
  [SHARE_DAEMON_MESSAGE_TYPES.P2P_CANCEL_RESPONSE]: daemonAllow('server', true),
  [SHARE_DAEMON_MESSAGE_TYPES.QUEUE_STATE]: daemonAllow('main', true),
} as const satisfies Record<ShareDaemonMessageType, ShareDaemonMessagePolicyEntry>;

export const SHARE_DAEMON_RELAY_INVENTORY = Object.values(SHARE_DAEMON_MESSAGE_TYPES);

export const UNKNOWN_SHARE_DAEMON_MESSAGE_POLICY: ShareDaemonMessagePolicyEntry = {
  type: 'unknown',
  delivery: 'drop',
  targetKind: 'unknown',
  cutoffBounded: true,
  redactGlobalFields: true,
  reason: 'share-direct-surface-denied',
};

export const SHARE_TRUST_DISCLOSURE_I18N_KEY = 'share.trust_disclosure.participant' as const;
export const SHARE_REASON_LABEL_I18N_PREFIX = 'share.reason.' as const;
export const SHARE_ACTION_ID_IS_IDEMPOTENCY_KEY = false as const;

export function isShareRole(value: unknown): value is ShareRole {
  return typeof value === 'string' && (SHARE_ROLES as readonly string[]).includes(value);
}

export function compareShareRoles(a: ShareRole, b: ShareRole): number {
  return SHARE_ROLE_ORDER[a] - SHARE_ROLE_ORDER[b];
}

export function maxShareRole(a: ShareRole, b: ShareRole): ShareRole {
  return compareShareRoles(a, b) >= 0 ? a : b;
}

export function isActiveShareGrant(grant: Pick<ShareGrantLike, 'revokedAt' | 'expiresAt'>, now: number): boolean {
  return grant.revokedAt == null && (grant.expiresAt == null || grant.expiresAt > now);
}

export function normalizeShareTargetInput(
  input: ShareTargetInput | Record<string, unknown>,
  options: NormalizeShareTargetOptions = {},
): NormalizeShareTargetResult {
  if (!isRecord(input)) return { ok: false, reason: 'missing-identifier' };
  const record = input as Record<string, unknown>;
  const kind = record.kind;
  const serverId = normalizeNonEmptyString(record.serverId);
  if (kind !== 'server' && kind !== 'main' && kind !== 'subsession') return { ok: false, reason: 'missing-identifier' };
  if (!serverId) return { ok: false, reason: 'missing-identifier' };
  if (kind === 'server') return { ok: true, target: { kind, serverId } };
  if (kind === 'main') {
    const sessionName = normalizeNonEmptyString(record.sessionName);
    return sessionName ? { ok: true, target: { kind, serverId, sessionName } } : { ok: false, reason: 'missing-identifier' };
  }

  const rawId = normalizeNonEmptyString(record.subSessionId);
  const sessionName = normalizeNonEmptyString(record.sessionName);
  if (rawId && sessionName) return { ok: false, reason: 'conflicting-identifiers' };
  if (!rawId && !sessionName) return { ok: false, reason: 'missing-identifier' };
  const subSessionId = rawId ?? rawSubSessionIdFromDisplayName(sessionName ?? '');
  if (!subSessionId || subSessionId.startsWith('deck_sub_')) return { ok: false, reason: 'malformed-subsession-id' };
  if (options.subSessionExists && !options.subSessionExists(subSessionId, serverId)) {
    return { ok: false, reason: 'target-not-found' };
  }
  return { ok: true, target: { kind: 'subsession', serverId, subSessionId } };
}

export function rawSubSessionIdFromDisplayName(sessionName: string): string | null {
  const trimmed = sessionName.trim();
  if (!trimmed.startsWith('deck_sub_')) return null;
  const raw = trimmed.slice('deck_sub_'.length);
  if (!raw || raw.startsWith('deck_sub_') || /[\s/\\]/.test(raw)) return null;
  return raw;
}

export function shareTargetKey(target: ShareTarget): string {
  switch (target.kind) {
    case 'server':
      return `server:${target.serverId}`;
    case 'main':
      return `main:${target.serverId}:${target.sessionName}`;
    case 'subsession':
      return `subsession:${target.serverId}:${target.subSessionId}`;
  }
}

export function shareTargetsEqual(a: ShareTarget, b: ShareTarget): boolean {
  return shareTargetKey(a) === shareTargetKey(b);
}

export function shareGrantCoversTarget(grantTarget: ShareTarget, requestedTarget: ShareTarget): boolean {
  if (grantTarget.serverId !== requestedTarget.serverId) return false;
  if (grantTarget.kind === 'server') return true;
  return shareTargetsEqual(grantTarget, requestedTarget);
}

export function resolveEffectiveCoverageForTarget(
  requestedTarget: ShareTarget,
  grants: readonly ShareGrantLike[],
  now: number,
): EffectiveCoverage | null {
  const covering = grants
    .filter((grant) => isActiveShareGrant(grant, now) && shareGrantCoversTarget(grant.target, requestedTarget))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (covering.length === 0) return null;

  const effectiveRole = covering.reduce<ShareRole>((role, grant) => maxShareRole(role, grant.role), 'viewer');
  const primary = covering
    .slice()
    .sort((a, b) => compareShareRoles(b.role, a.role) || a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0] ?? null;
  const nextCoverageRecheckAt = minNullable(covering.map((grant) => grant.expiresAt ?? null));
  return {
    target: requestedTarget,
    effectiveRole,
    historyCutoffAt: 0,
    nextCoverageRecheckAt,
    coveringShareIds: covering.map((grant) => grant.id),
    primaryShareId: primary?.id ?? null,
    authorizedAt: now,
  };
}

export type ServerMembershipAuthority = 'owner' | 'admin' | 'member' | null | undefined;

export type ResolveEffectiveActorResult =
  | { kind: 'server-member'; effectiveActorRole: 'server-manager' | 'server-member' }
  | { kind: 'share'; effectiveActorRole: ShareRole; coverage: EffectiveCoverage }
  | { kind: 'none' };

export function resolveEffectiveActor(
  membership: ServerMembershipAuthority,
  coverage: EffectiveCoverage | null,
): ResolveEffectiveActorResult {
  if (membership === 'owner' || membership === 'admin') {
    return { kind: 'server-member', effectiveActorRole: 'server-manager' };
  }
  if (membership === 'member') {
    return { kind: 'server-member', effectiveActorRole: 'server-member' };
  }
  if (coverage) {
    return { kind: 'share', effectiveActorRole: coverage.effectiveRole, coverage };
  }
  return { kind: 'none' };
}

export function getShareScopedCommandPolicy(command: string): ShareCommandPolicyEntry {
  return (SHARE_SCOPED_COMMAND_POLICY as Record<string, ShareCommandPolicyEntry>)[command] ?? UNKNOWN_SHARE_COMMAND_POLICY;
}

export function isShareCommandAllowed(command: string, role: ShareRole): boolean {
  const policy = getShareScopedCommandPolicy(command);
  if (policy.disposition === 'deny') return false;
  return policy.minRole == null || SHARE_ROLE_ORDER[role] >= SHARE_ROLE_ORDER[policy.minRole];
}

export function getShareScopedDaemonMessagePolicy(type: string): ShareDaemonMessagePolicyEntry {
  return (SHARE_SCOPED_DAEMON_MESSAGE_POLICY as Record<string, ShareDaemonMessagePolicyEntry>)[type] ?? {
    ...UNKNOWN_SHARE_DAEMON_MESSAGE_POLICY,
    type,
  };
}

export function isShareDaemonMessageAllowed(type: string): boolean {
  return getShareScopedDaemonMessagePolicy(type).delivery === 'allow';
}

export function buildShareAuditIdempotencyKey(input: {
  actionType: string;
  targetKind: ShareTarget['kind'];
  targetRef: string;
  primaryShareId?: string | null;
  transitionEpochMs: number;
  decision?: string | null;
  attemptId?: string | null;
}): string {
  return [
    input.actionType,
    input.targetKind,
    input.targetRef,
    input.primaryShareId ?? 'none',
    input.transitionEpochMs,
    input.decision ?? 'transition',
    input.attemptId ?? 'transition',
  ].join(':');
}

function allow(scope: ShareCommandScope): ShareCommandPolicyEntry {
  return { disposition: 'allow', scope };
}

function allowParticipant(scope: ShareCommandScope): ShareCommandPolicyEntry {
  return { disposition: 'allow', scope, minRole: 'participant', reason: 'share-role-denied' };
}

function deny(scope: ShareCommandScope, reason: ShareDenialReason): ShareCommandPolicyEntry {
  return { disposition: 'deny', scope, reason };
}

function daemonAllow(
  targetKind: ShareDaemonMessageTargetKind,
  cutoffBounded: boolean,
  redactGlobalFields = false,
): ShareDaemonMessagePolicyEntry {
  return { type: '', delivery: 'allow', targetKind, cutoffBounded, redactGlobalFields };
}

function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function minNullable(values: readonly (number | null)[]): number | null {
  let min: number | null = null;
  for (const value of values) {
    if (value == null) continue;
    min = min == null ? value : Math.min(min, value);
  }
  return min;
}
