import type { Database } from '../db/client.js';
import { resolveEffectiveShareCoverage } from '../db/tab-sharing.js';
import { evaluateP2pSendTargetScope } from '../share/p2p-send-scope.js';
import { DAEMON_COMMAND_TYPES } from '../../../shared/daemon-command-types.js';
import { TRANSPORT_MSG } from '../../../shared/transport-events.js';
import { P2P_WORKFLOW_MSG } from '../../../shared/p2p-workflow-messages.js';
import {
  SHARE_BROWSER_COMMANDS,
  rawSubSessionIdFromDisplayName,
  getShareScopedCommandPolicy,
  shareTargetKey,
  type EffectiveCoverage,
  type ShareAuthorizationSnapshot,
  type ShareDenialReason,
  type ShareScopedTicketClaims,
  type SharedActorEnvelope,
  type ShareTarget,
} from '../../../shared/tab-sharing.js';
import { REPO_MSG } from '../../../shared/repo-types.js';

export { shareTargetKey };
export type { EffectiveCoverage, ShareTarget };

export type ShareReason = Extract<
  ShareDenialReason,
  | 'share-role-denied'
  | 'share-direct-surface-denied'
  | 'share-rate-limited'
  | 'share-revoked'
  | 'share-expired'
  | 'share-target-unavailable'
  | 'share-role-changed'
  | 'share-ticket-invalid'
  | 'share-cancel-unsupported'
  | 'share-comment-invalid'
>;

export type ShareScopedSocketState = {
  userId: string;
  actorDisplayName: string;
  ticketId: string;
  target: ShareTarget;
  snapshot: ShareAuthorizationSnapshot;
  connectedAt: number;
  coveredSessionNames?: readonly string[];
};

export type ShareCoverageResolver = (input: {
  db: Database;
  serverId: string;
  userId: string;
  target: ShareTarget;
  now: number;
}) => Promise<EffectiveCoverage | null>;

export type ShareCommandDecision =
  | { allowed: true; requiresDaemon?: boolean; stampedMessage?: Record<string, unknown> }
  | { allowed: false; reason: ShareReason; closeSocket?: boolean };

type ShareCommandPolicy =
  | { kind: 'allow-covered-read'; requireTarget: boolean }
  | { kind: 'participant-discussion-start' }
  | { kind: 'participant-send' }
  | { kind: 'participant-cancel' }
  | { kind: 'deny'; reason: ShareReason };

export type ShareBridgeCommandInventoryEntry = {
  bridgeCommand: string;
  sharedCommand: string;
  policy: ShareCommandPolicy;
};

export const SHARE_WS_TICKET_TYPE = 'share-ws-ticket';

export const SHARE_REASONS = {
  ROLE_DENIED: 'share-role-denied',
  DIRECT_SURFACE_DENIED: 'share-direct-surface-denied',
  RATE_LIMITED: 'share-rate-limited',
  REVOKED: 'share-revoked',
  EXPIRED: 'share-expired',
  TARGET_UNAVAILABLE: 'share-target-unavailable',
  ROLE_CHANGED: 'share-role-changed',
  TICKET_INVALID: 'share-ticket-invalid',
  CANCEL_UNSUPPORTED: 'share-cancel-unsupported',
  COMMENT_INVALID: 'share-comment-invalid',
} as const satisfies Record<string, ShareReason>;

function denyFromShared(sharedCommand: string): ShareCommandPolicy {
  const policy = getShareScopedCommandPolicy(sharedCommand);
  if (policy.disposition !== 'deny' || !policy.reason) {
    throw new Error(`Share WS command ${sharedCommand} must be denied by shared policy`);
  }
  return { kind: 'deny', reason: policy.reason as ShareReason };
}

export const SHARE_WS_COMMAND_POLICY_INVENTORY: readonly ShareBridgeCommandInventoryEntry[] = [
  { bridgeCommand: 'terminal.subscribe', sharedCommand: SHARE_BROWSER_COMMANDS.TERMINAL_OUTPUT, policy: { kind: 'allow-covered-read', requireTarget: true } },
  { bridgeCommand: 'terminal.unsubscribe', sharedCommand: SHARE_BROWSER_COMMANDS.TERMINAL_OUTPUT, policy: { kind: 'allow-covered-read', requireTarget: true } },
  { bridgeCommand: 'terminal.snapshot_request', sharedCommand: SHARE_BROWSER_COMMANDS.TERMINAL_SNAPSHOT, policy: { kind: 'allow-covered-read', requireTarget: true } },
  { bridgeCommand: TRANSPORT_MSG.CHAT_SUBSCRIBE, sharedCommand: SHARE_BROWSER_COMMANDS.CHAT_HISTORY, policy: { kind: 'allow-covered-read', requireTarget: true } },
  { bridgeCommand: TRANSPORT_MSG.CHAT_UNSUBSCRIBE, sharedCommand: SHARE_BROWSER_COMMANDS.CHAT_HISTORY, policy: { kind: 'allow-covered-read', requireTarget: true } },
  { bridgeCommand: TRANSPORT_MSG.CHAT_HISTORY, sharedCommand: SHARE_BROWSER_COMMANDS.CHAT_HISTORY, policy: { kind: 'allow-covered-read', requireTarget: true } },
  { bridgeCommand: 'discussion.start', sharedCommand: SHARE_BROWSER_COMMANDS.DISCUSSION_START, policy: { kind: 'participant-discussion-start' } },
  { bridgeCommand: 'session.send', sharedCommand: SHARE_BROWSER_COMMANDS.SESSION_SEND, policy: { kind: 'participant-send' } },
  { bridgeCommand: DAEMON_COMMAND_TYPES.SESSION_CANCEL, sharedCommand: SHARE_BROWSER_COMMANDS.SESSION_CANCEL, policy: { kind: 'participant-cancel' } },
  { bridgeCommand: 'discussion.comment', sharedCommand: SHARE_BROWSER_COMMANDS.DISCUSSION_COMMENT, policy: { kind: 'allow-covered-read', requireTarget: false } },

  { bridgeCommand: 'session.start', sharedCommand: SHARE_BROWSER_COMMANDS.SESSION_START, policy: denyFromShared(SHARE_BROWSER_COMMANDS.SESSION_START) },
  { bridgeCommand: 'session.stop', sharedCommand: SHARE_BROWSER_COMMANDS.SESSION_STOP, policy: denyFromShared(SHARE_BROWSER_COMMANDS.SESSION_STOP) },
  { bridgeCommand: 'session.restart', sharedCommand: SHARE_BROWSER_COMMANDS.SESSION_RESTART, policy: denyFromShared(SHARE_BROWSER_COMMANDS.SESSION_RESTART) },
  { bridgeCommand: 'session.input', sharedCommand: SHARE_BROWSER_COMMANDS.TERMINAL_INPUT, policy: denyFromShared(SHARE_BROWSER_COMMANDS.TERMINAL_INPUT) },
  { bridgeCommand: 'session.resize', sharedCommand: SHARE_BROWSER_COMMANDS.TERMINAL_RESIZE, policy: denyFromShared(SHARE_BROWSER_COMMANDS.TERMINAL_RESIZE) },
  { bridgeCommand: 'session.edit_queued_message', sharedCommand: SHARE_BROWSER_COMMANDS.QUEUE_EDIT, policy: denyFromShared(SHARE_BROWSER_COMMANDS.QUEUE_EDIT) },
  { bridgeCommand: 'session.undo_queued_message', sharedCommand: SHARE_BROWSER_COMMANDS.QUEUE_UNDO, policy: denyFromShared(SHARE_BROWSER_COMMANDS.QUEUE_UNDO) },
  { bridgeCommand: 'subsession.start', sharedCommand: SHARE_BROWSER_COMMANDS.SUBSESSION_START, policy: denyFromShared(SHARE_BROWSER_COMMANDS.SUBSESSION_START) },
  { bridgeCommand: 'subsession.stop', sharedCommand: SHARE_BROWSER_COMMANDS.SUBSESSION_STOP, policy: denyFromShared(SHARE_BROWSER_COMMANDS.SUBSESSION_STOP) },
  { bridgeCommand: 'subsession.restart', sharedCommand: SHARE_BROWSER_COMMANDS.SUBSESSION_RESTART, policy: denyFromShared(SHARE_BROWSER_COMMANDS.SUBSESSION_RESTART) },
  { bridgeCommand: 'p2p.config.save', sharedCommand: SHARE_BROWSER_COMMANDS.P2P_CONFIG_SAVE, policy: denyFromShared(SHARE_BROWSER_COMMANDS.P2P_CONFIG_SAVE) },
  { bridgeCommand: TRANSPORT_MSG.APPROVAL_RESPONSE, sharedCommand: SHARE_BROWSER_COMMANDS.CHAT_APPROVAL_RESPONSE, policy: denyFromShared(SHARE_BROWSER_COMMANDS.CHAT_APPROVAL_RESPONSE) },
  { bridgeCommand: TRANSPORT_MSG.PROVIDER_STATUS, sharedCommand: SHARE_BROWSER_COMMANDS.PROVIDER_STATUS, policy: denyFromShared(SHARE_BROWSER_COMMANDS.PROVIDER_STATUS) },
  { bridgeCommand: TRANSPORT_MSG.LIST_SESSIONS, sharedCommand: SHARE_BROWSER_COMMANDS.PROVIDER_LIST, policy: denyFromShared(SHARE_BROWSER_COMMANDS.PROVIDER_LIST) },
  { bridgeCommand: 'provider.sync_sessions', sharedCommand: SHARE_BROWSER_COMMANDS.PROVIDER_LIST, policy: denyFromShared(SHARE_BROWSER_COMMANDS.PROVIDER_LIST) },
  { bridgeCommand: 'fs.ls', sharedCommand: SHARE_BROWSER_COMMANDS.FILE_BROWSE, policy: denyFromShared(SHARE_BROWSER_COMMANDS.FILE_BROWSE) },
  { bridgeCommand: 'fs.read', sharedCommand: SHARE_BROWSER_COMMANDS.FILE_READ, policy: denyFromShared(SHARE_BROWSER_COMMANDS.FILE_READ) },
  { bridgeCommand: 'fs.write', sharedCommand: SHARE_BROWSER_COMMANDS.FILE_WRITE, policy: denyFromShared(SHARE_BROWSER_COMMANDS.FILE_WRITE) },
  { bridgeCommand: 'fs.edit', sharedCommand: SHARE_BROWSER_COMMANDS.FILE_EDIT, policy: denyFromShared(SHARE_BROWSER_COMMANDS.FILE_EDIT) },
  { bridgeCommand: 'fs.delete', sharedCommand: SHARE_BROWSER_COMMANDS.FILE_DELETE, policy: denyFromShared(SHARE_BROWSER_COMMANDS.FILE_DELETE) },
  { bridgeCommand: 'fs.patch', sharedCommand: SHARE_BROWSER_COMMANDS.FILE_PATCH, policy: denyFromShared(SHARE_BROWSER_COMMANDS.FILE_PATCH) },
  { bridgeCommand: 'fs.git_status', sharedCommand: SHARE_BROWSER_COMMANDS.REPO_STATUS, policy: denyFromShared(SHARE_BROWSER_COMMANDS.REPO_STATUS) },
  { bridgeCommand: 'fs.git_diff', sharedCommand: SHARE_BROWSER_COMMANDS.REPO_DIFF, policy: denyFromShared(SHARE_BROWSER_COMMANDS.REPO_DIFF) },
  { bridgeCommand: 'file.search', sharedCommand: SHARE_BROWSER_COMMANDS.FILE_SEARCH, policy: denyFromShared(SHARE_BROWSER_COMMANDS.FILE_SEARCH) },
  { bridgeCommand: REPO_MSG.DETECT, sharedCommand: SHARE_BROWSER_COMMANDS.REPO_STATUS, policy: denyFromShared(SHARE_BROWSER_COMMANDS.REPO_STATUS) },
  { bridgeCommand: REPO_MSG.LIST_BRANCHES, sharedCommand: SHARE_BROWSER_COMMANDS.REPO_BRANCH, policy: denyFromShared(SHARE_BROWSER_COMMANDS.REPO_BRANCH) },
  { bridgeCommand: REPO_MSG.CHECKOUT_BRANCH, sharedCommand: SHARE_BROWSER_COMMANDS.REPO_BRANCH, policy: denyFromShared(SHARE_BROWSER_COMMANDS.REPO_BRANCH) },
  { bridgeCommand: REPO_MSG.LIST_COMMITS, sharedCommand: SHARE_BROWSER_COMMANDS.REPO_SEARCH, policy: denyFromShared(SHARE_BROWSER_COMMANDS.REPO_SEARCH) },
  { bridgeCommand: REPO_MSG.LIST_ISSUES, sharedCommand: SHARE_BROWSER_COMMANDS.REPO_SEARCH, policy: denyFromShared(SHARE_BROWSER_COMMANDS.REPO_SEARCH) },
  { bridgeCommand: REPO_MSG.LIST_PRS, sharedCommand: SHARE_BROWSER_COMMANDS.REPO_SEARCH, policy: denyFromShared(SHARE_BROWSER_COMMANDS.REPO_SEARCH) },
  { bridgeCommand: REPO_MSG.LIST_ACTIONS, sharedCommand: SHARE_BROWSER_COMMANDS.REPO_SEARCH, policy: denyFromShared(SHARE_BROWSER_COMMANDS.REPO_SEARCH) },
  { bridgeCommand: 'memory.skill.query', sharedCommand: SHARE_BROWSER_COMMANDS.MEMORY_QUERY, policy: denyFromShared(SHARE_BROWSER_COMMANDS.MEMORY_QUERY) },
  { bridgeCommand: 'cron.create', sharedCommand: SHARE_BROWSER_COMMANDS.CRON_MUTATE, policy: denyFromShared(SHARE_BROWSER_COMMANDS.CRON_MUTATE) },
];

function assertShareCommandInventoryEntry(entry: ShareBridgeCommandInventoryEntry): void {
  if (entry.policy.kind === 'deny') return;
  const sharedPolicy = getShareScopedCommandPolicy(entry.sharedCommand);
  if (sharedPolicy.disposition !== 'allow') {
    throw new Error(`Share WS command ${entry.sharedCommand} must be allowed by shared policy`);
  }
  if (entry.policy.kind === 'allow-covered-read') {
    if (entry.policy.requireTarget !== (sharedPolicy.scope === 'concrete-tab')) {
      throw new Error(`Share WS command ${entry.bridgeCommand} target requirement does not match shared policy`);
    }
    return;
  }
  if (sharedPolicy.minRole !== 'participant') {
    throw new Error(`Share WS command ${entry.sharedCommand} must require participant role`);
  }
}

export const SHARE_SCOPED_COMMAND_POLICY = new Map<string, ShareCommandPolicy>(
  SHARE_WS_COMMAND_POLICY_INVENTORY.map((entry) => {
    assertShareCommandInventoryEntry(entry);
    return [entry.bridgeCommand, entry.policy];
  }),
);

type DaemonMessagePolicy = {
  target: (msg: Record<string, unknown>) => ShareTarget | null;
  redact?: (msg: Record<string, unknown>, state: ShareScopedSocketState) => Record<string, unknown> | null;
};

export const SHARE_SCOPED_DAEMON_MESSAGE_POLICY = new Map<string, DaemonMessagePolicy>([
  ['terminal.diff', { target: terminalDiffTarget }],
  ['terminal_update', { target: terminalUpdateTarget }],
  ['terminal.stream_reset', { target: sessionFieldTarget }],
  ['session.event', { target: sessionFieldTarget }],
  ['session_event', { target: sessionFieldTarget }],
  ['session.idle', { target: sessionFieldTarget }],
  ['session.notification', { target: sessionFieldTarget }],
  ['session.tool', { target: sessionFieldTarget }],
  ['command.ack', { target: sessionFieldTarget }],
  ['command.failed', { target: sessionFieldTarget }],
  ['subsession.response', { target: sessionNameFieldTarget }],
  ['subsession.created', { target: subsessionCreatedTarget }],
  ['subsession.removed', { target: subsessionRemovedTarget }],
  ['timeline.event', {
    target: timelineEventTarget,
  }],
  [TRANSPORT_MSG.CHAT_HISTORY, {
    target: sessionIdFieldTarget,
    redact: redactTransportHistory,
  }],
  ['chat.delta', { target: sessionIdFieldTarget }],
  ['chat.complete', { target: sessionIdFieldTarget }],
  ['chat.error', { target: sessionIdFieldTarget }],
  ['chat.status', { target: sessionIdFieldTarget, redact: redactActiveDispatchForViewers }],
  ['chat.tool', { target: sessionIdFieldTarget }],
  ['chat.approval', { target: sessionIdFieldTarget }],
  ['discussion.started', { target: sharedActorTarget }],
  ['discussion.update', { target: sharedActorTarget }],
  ['discussion.done', { target: sharedActorTarget }],
  ['discussion.error', { target: sharedActorTarget }],
  ['discussion.list', { target: sharedActorTarget }],
  [P2P_WORKFLOW_MSG.RUN_STARTED, { target: p2pRunStartedTarget }],
  [P2P_WORKFLOW_MSG.RUN_UPDATE, { target: p2pRunScopedTarget }],
  [P2P_WORKFLOW_MSG.RUN_COMPLETE, { target: p2pRunScopedTarget }],
  [P2P_WORKFLOW_MSG.RUN_ERROR, { target: p2pRunScopedTarget }],
  ['session_list', {
    target: serverFieldTarget,
    redact: redactSessionList,
  }],
]);

export function normalizeShareTarget(input: unknown, expectedServerId?: string): ShareTarget | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const kind = record.kind;
  const serverId = typeof record.serverId === 'string' ? record.serverId : '';
  if (!serverId || (expectedServerId && serverId !== expectedServerId)) return null;
  if (kind === 'server') return { kind, serverId };
  if (kind === 'main' && typeof record.sessionName === 'string' && record.sessionName.trim()) {
    return { kind, serverId, sessionName: record.sessionName.trim() };
  }
  if (kind === 'subsession') {
    const rawSubSessionId = typeof record.subSessionId === 'string' ? record.subSessionId.trim() : '';
    const sessionName = typeof record.sessionName === 'string' ? record.sessionName.trim() : '';
    if (rawSubSessionId && sessionName) return null;
    if (rawSubSessionId && !rawSubSessionId.startsWith('deck_sub_')) {
      return { kind, serverId, subSessionId: rawSubSessionId };
    }
    const fromSessionName = parseSubSessionName(sessionName);
    if (fromSessionName) return { kind, serverId, subSessionId: fromSessionName };
  }
  return null;
}

export function sessionNameToShareTarget(serverId: string, sessionName: string): ShareTarget {
  const subSessionId = parseSubSessionName(sessionName);
  return subSessionId
    ? { kind: 'subsession', serverId, subSessionId }
    : { kind: 'main', serverId, sessionName };
}

export function shareTargetCoversSession(target: ShareTarget, sessionName: string): boolean {
  if (target.kind === 'server') return true;
  if (target.kind === 'main') return target.sessionName === sessionName;
  return parseSubSessionName(sessionName) === target.subSessionId;
}

export function shareStateCoversSession(state: ShareScopedSocketState, sessionName: string): boolean {
  return shareTargetCoversSession(state.target, sessionName)
    || !!state.coveredSessionNames?.includes(sessionName);
}

export function isConcreteShareTarget(target: ShareTarget): boolean {
  return target.kind === 'main' || target.kind === 'subsession';
}

export function buildSharedActorEnvelope(
  state: ShareScopedSocketState,
  actionId: string,
  now: number,
): SharedActorEnvelope {
  return {
    actorUserId: state.userId,
    actorDisplayName: state.actorDisplayName,
    snapshot: state.snapshot,
    primaryShareId: state.snapshot.primaryShareId,
    effectiveActorRole: state.snapshot.effectiveRole,
    actionId,
    origin: state.target.kind === 'server' ? 'shared-server' : 'shared-tab',
    authorizedAt: state.snapshot.authorizedAt,
    queuedAt: now,
  };
}

export function evaluateShareCommand(input: {
  msg: Record<string, unknown>;
  state: ShareScopedSocketState;
  now: number;
  runtimeType: 'process' | 'transport' | 'unknown';
  activeDispatchId: string | null;
}): ShareCommandDecision {
  const type = typeof input.msg.type === 'string' ? input.msg.type : '';
  const policy = SHARE_SCOPED_COMMAND_POLICY.get(type);
  if (!policy) return { allowed: false, reason: SHARE_REASONS.DIRECT_SURFACE_DENIED };
  if (policy.kind === 'deny') return { allowed: false, reason: policy.reason };

  const sessionName = commandSessionName(input.msg);
  if (policy.kind === 'allow-covered-read') {
    if (!sessionName) {
      return policy.requireTarget
        ? { allowed: false, reason: SHARE_REASONS.DIRECT_SURFACE_DENIED }
        : { allowed: true };
    }
    return shareStateCoversSession(input.state, sessionName)
      ? { allowed: true }
      : { allowed: false, reason: SHARE_REASONS.DIRECT_SURFACE_DENIED };
  }

  if (input.state.snapshot.effectiveRole !== 'participant') {
    return { allowed: false, reason: SHARE_REASONS.ROLE_DENIED };
  }

  if (policy.kind === 'participant-discussion-start') {
    if (hasUnscopedDiscussionParticipant(input.msg)) {
      return { allowed: false, reason: SHARE_REASONS.DIRECT_SURFACE_DENIED };
    }
    const referencedSessions = commandReferencedSessionNames(input.msg);
    if (referencedSessions.some((name) => !shareStateCoversSession(input.state, name))) {
      return { allowed: false, reason: SHARE_REASONS.DIRECT_SURFACE_DENIED };
    }
    const actionId = typeof input.msg.requestId === 'string' && input.msg.requestId.trim()
      ? input.msg.requestId.trim()
      : typeof input.msg.commandId === 'string' && input.msg.commandId.trim()
        ? input.msg.commandId.trim()
        : `share-action-${input.now}`;
    return {
      allowed: true,
      stampedMessage: {
        ...input.msg,
        sharedActor: buildSharedActorEnvelope(input.state, actionId, input.now),
        shareScope: {
          target: input.state.target,
          historyCutoffAt: input.state.snapshot.historyCutoffAt,
          primaryShareId: input.state.snapshot.primaryShareId,
          coveringShareIds: input.state.snapshot.coveringShareIds,
        },
      },
    };
  }

  if (!sessionName || !shareStateCoversSession(input.state, sessionName)) {
    return { allowed: false, reason: SHARE_REASONS.DIRECT_SURFACE_DENIED };
  }

  if (policy.kind === 'participant-send') {
    const p2pScopeReason = evaluateP2pSendScope(input.msg, input.state);
    if (p2pScopeReason) return { allowed: false, reason: p2pScopeReason };
    const actionId = typeof input.msg.actionId === 'string' && input.msg.actionId.trim()
      ? input.msg.actionId.trim()
      : typeof input.msg.commandId === 'string' && input.msg.commandId.trim()
        ? input.msg.commandId.trim()
        : `share-action-${input.now}`;
    return {
      allowed: true,
      stampedMessage: {
        ...input.msg,
        sharedActor: buildSharedActorEnvelope(input.state, actionId, input.now),
      },
    };
  }

  if (input.runtimeType !== 'transport') {
    return { allowed: false, reason: SHARE_REASONS.CANCEL_UNSUPPORTED };
  }
  const observedDispatchId = typeof input.msg.observedDispatchId === 'string' ? input.msg.observedDispatchId.trim() : '';
  if (!observedDispatchId || !input.activeDispatchId || observedDispatchId !== input.activeDispatchId) {
    return { allowed: false, reason: SHARE_REASONS.TARGET_UNAVAILABLE };
  }
  const actionId = typeof input.msg.actionId === 'string' && input.msg.actionId.trim()
    ? input.msg.actionId.trim()
    : typeof input.msg.commandId === 'string' && input.msg.commandId.trim()
      ? input.msg.commandId.trim()
      : `share-action-${input.now}`;
  return {
    allowed: true,
    stampedMessage: {
      ...input.msg,
      sharedActor: buildSharedActorEnvelope(input.state, actionId, input.now),
    },
  };
}

export function commandSessionName(msg: Record<string, unknown>): string | null {
  for (const key of ['sessionName', 'session', 'sessionId']) {
    const value = msg[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function commandReferencedSessionNames(msg: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const direct = commandSessionName(msg);
  if (direct) names.add(direct);
  const participants = Array.isArray(msg.participants) ? msg.participants : [];
  for (const participant of participants) {
    if (!participant || typeof participant !== 'object') continue;
    const sessionName = (participant as Record<string, unknown>).sessionName;
    if (typeof sessionName === 'string' && sessionName.trim()) names.add(sessionName.trim());
  }
  return [...names];
}

function hasUnscopedDiscussionParticipant(msg: Record<string, unknown>): boolean {
  if (msg.type !== 'discussion.start') return false;
  const participants = Array.isArray(msg.participants) ? msg.participants : [];
  if (participants.length === 0) return true;
  return participants.some((participant) => {
    if (!participant || typeof participant !== 'object') return true;
    const sessionName = (participant as Record<string, unknown>).sessionName;
    return !(typeof sessionName === 'string' && sessionName.trim());
  });
}

function evaluateP2pSendScope(msg: Record<string, unknown>, state: ShareScopedSocketState): ShareReason | null {
  return evaluateP2pSendTargetScope({
    msg,
    target: state.target,
    coversSession: (sessionName) => shareStateCoversSession(state, sessionName),
  }) as ShareReason | null;
}

export function filterShareDaemonMessage(
  msg: Record<string, unknown>,
  state: ShareScopedSocketState,
): Record<string, unknown> | null {
  const type = typeof msg.type === 'string' ? msg.type : '';
  const policy = SHARE_SCOPED_DAEMON_MESSAGE_POLICY.get(type);
  if (!policy) return null;
  const target = policy.target(msg);
  if (!target) return null;
  if (target.serverId && target.serverId !== state.target.serverId) return null;
  if (target.kind !== 'server' && !shareStateCoversSession(state, sessionNameFromTarget(target))) return null;
  return policy.redact ? policy.redact(msg, state) : msg;
}

export async function resolveShareCoverageFromDb(input: {
  db: Database;
  serverId: string;
  userId: string;
  target: ShareTarget;
  now: number;
}): Promise<EffectiveCoverage | null> {
  if (input.target.serverId !== input.serverId) return null;
  return resolveEffectiveShareCoverage(input.db, {
    userId: input.userId,
    target: input.target,
    now: input.now,
  });
}

export function parseShareWsTicketClaims(payload: Record<string, unknown> | null, serverId: string): ShareScopedTicketClaims | null {
  if (!payload || payload.type !== SHARE_WS_TICKET_TYPE) return null;
  if (payload.serverId !== serverId || typeof payload.sub !== 'string' || typeof payload.jti !== 'string') return null;
  if (typeof payload.expiresAt !== 'number' || !Number.isFinite(payload.expiresAt)) return null;
  if (typeof payload.issuedAt !== 'number' || !Number.isFinite(payload.issuedAt)) return null;
  const target = normalizeShareTarget(payload.target, serverId);
  const snapshot = normalizeSnapshot(payload.snapshot, serverId);
  if (!target || !snapshot || shareTargetKey(target) !== shareTargetKey(snapshot.target)) return null;
  return {
    type: SHARE_WS_TICKET_TYPE,
    sub: payload.sub,
    jti: payload.jti,
    serverId,
    target,
    snapshot,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  };
}

function normalizeSnapshot(value: unknown, expectedServerId: string): ShareAuthorizationSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const target = normalizeShareTarget(record.target, expectedServerId);
  if (!target) return null;
  const effectiveRole = record.effectiveRole;
  const historyCutoffAt = record.historyCutoffAt;
  const authorizedAt = record.authorizedAt;
  const nextCoverageRecheckAt = record.nextCoverageRecheckAt;
  const coveringShareIds = Array.isArray(record.coveringShareIds)
    ? record.coveringShareIds.filter((item): item is string => typeof item === 'string')
    : [];
  const primaryShareId = typeof record.primaryShareId === 'string' ? record.primaryShareId : null;
  if (effectiveRole !== 'viewer' && effectiveRole !== 'participant') return null;
  if (typeof historyCutoffAt !== 'number' || !Number.isFinite(historyCutoffAt)) return null;
  if (typeof authorizedAt !== 'number' || !Number.isFinite(authorizedAt)) return null;
  if (nextCoverageRecheckAt !== null && (typeof nextCoverageRecheckAt !== 'number' || !Number.isFinite(nextCoverageRecheckAt))) {
    return null;
  }
  return { target, effectiveRole, historyCutoffAt, nextCoverageRecheckAt, coveringShareIds, primaryShareId, authorizedAt };
}

function parseSubSessionName(sessionName: string): string | null {
  return rawSubSessionIdFromDisplayName(sessionName);
}

function sessionNameFromTarget(target: ShareTarget): string {
  if (target.kind === 'main') return target.sessionName;
  if (target.kind === 'subsession') return `deck_sub_${target.subSessionId}`;
  return '';
}

function serverFieldTarget(msg: Record<string, unknown>): ShareTarget | null {
  const serverId = typeof msg.serverId === 'string' ? msg.serverId : '';
  return { kind: 'server', serverId };
}

function sessionFieldTarget(msg: Record<string, unknown>): ShareTarget | null {
  const session = typeof msg.session === 'string' ? msg.session : '';
  return session ? sessionNameToShareTarget('', session) : null;
}

function sessionNameFieldTarget(msg: Record<string, unknown>): ShareTarget | null {
  const sessionName = typeof msg.sessionName === 'string' ? msg.sessionName : '';
  return sessionName ? sessionNameToShareTarget('', sessionName) : null;
}

function sessionIdFieldTarget(msg: Record<string, unknown>): ShareTarget | null {
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
  return sessionId ? sessionNameToShareTarget('', sessionId) : null;
}

function terminalDiffTarget(msg: Record<string, unknown>): ShareTarget | null {
  return terminalUpdateTarget({ ...msg, type: 'terminal_update' });
}

function terminalUpdateTarget(msg: Record<string, unknown>): ShareTarget | null {
  const diff = msg.diff && typeof msg.diff === 'object' ? msg.diff as Record<string, unknown> : null;
  const sessionName = typeof diff?.sessionName === 'string' ? diff.sessionName : '';
  return sessionName ? sessionNameToShareTarget('', sessionName) : null;
}

function timelineEventTarget(msg: Record<string, unknown>): ShareTarget | null {
  const event = msg.event && typeof msg.event === 'object' ? msg.event as Record<string, unknown> : null;
  const sessionId = typeof event?.sessionId === 'string' ? event.sessionId : '';
  return sessionId ? sessionNameToShareTarget('', sessionId) : null;
}

function sharedActorTarget(msg: Record<string, unknown>): ShareTarget | null {
  const scope = msg.shareScope && typeof msg.shareScope === 'object'
    ? msg.shareScope as Record<string, unknown>
    : null;
  const scopeTarget = normalizeShareTarget(scope?.target);
  if (scopeTarget) return scopeTarget;

  const actor = msg.sharedActor && typeof msg.sharedActor === 'object'
    ? msg.sharedActor as Record<string, unknown>
    : null;
  const snapshot = actor?.snapshot && typeof actor.snapshot === 'object'
    ? actor.snapshot as Record<string, unknown>
    : null;
  return normalizeShareTarget(snapshot?.target);
}

function p2pRunStartedTarget(msg: Record<string, unknown>): ShareTarget | null {
  const sessionName = typeof msg.session === 'string' ? msg.session : '';
  if (sessionName) return sessionNameToShareTarget('', sessionName);
  return p2pRunScopedTarget(msg);
}

function p2pRunScopedTarget(msg: Record<string, unknown>): ShareTarget | null {
  const directScope = msg.shareScope && typeof msg.shareScope === 'object'
    ? msg.shareScope as Record<string, unknown>
    : null;
  const directTarget = normalizeShareTarget(directScope?.target);
  if (directTarget) return directTarget;

  const run = msg.run && typeof msg.run === 'object'
    ? msg.run as Record<string, unknown>
    : null;
  const runScope = run?.shareScope && typeof run.shareScope === 'object'
    ? run.shareScope as Record<string, unknown>
    : null;
  const runScopeTarget = normalizeShareTarget(runScope?.target);
  if (runScopeTarget) return runScopeTarget;

  const runTarget = normalizeShareTarget(run?.share_target_snapshot ?? run?.shareTargetSnapshot);
  if (runTarget) return runTarget;

  const runActor = run?.sharedActor && typeof run.sharedActor === 'object'
    ? run.sharedActor as Record<string, unknown>
    : null;
  const runSnapshot = runActor?.snapshot && typeof runActor.snapshot === 'object'
    ? runActor.snapshot as Record<string, unknown>
    : null;
  return normalizeShareTarget(runSnapshot?.target) ?? sharedActorTarget(msg);
}

function subsessionCreatedTarget(msg: Record<string, unknown>): ShareTarget | null {
  const parentSession = typeof msg.parentSession === 'string' ? msg.parentSession.trim() : '';
  if (parentSession) return { kind: 'main', serverId: '', sessionName: parentSession };
  const id = typeof msg.id === 'string' ? msg.id : '';
  const sessionName = typeof msg.sessionName === 'string' ? msg.sessionName : (id ? `deck_sub_${id}` : '');
  return sessionName ? sessionNameToShareTarget('', sessionName) : null;
}

function subsessionRemovedTarget(msg: Record<string, unknown>): ShareTarget | null {
  return subsessionCreatedTarget(msg);
}

function redactSessionList(msg: Record<string, unknown>, state: ShareScopedSocketState): Record<string, unknown> | null {
  if (state.target.kind === 'server') return msg;
  const sessions = Array.isArray(msg.sessions)
    ? msg.sessions.filter((item) => {
      if (!item || typeof item !== 'object') return false;
      const name = (item as Record<string, unknown>).name;
      return typeof name === 'string' && shareStateCoversSession(state, name);
    })
    : [];
  return { ...msg, sessions };
}

function redactTransportHistory(msg: Record<string, unknown>, _state: ShareScopedSocketState): Record<string, unknown> | null {
  return msg;
}

function redactActiveDispatchForViewers(msg: Record<string, unknown>, state: ShareScopedSocketState): Record<string, unknown> | null {
  if (state.snapshot.effectiveRole === 'participant') return msg;
  const redacted = { ...msg };
  delete redacted.activeDispatchId;
  delete redacted.runningTurnId;
  delete redacted.dispatchId;
  return redacted;
}
