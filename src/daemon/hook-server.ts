/**
 * Local HTTP server for agent hook callbacks.
 *
 * POST /notify  { event: "idle"|"notification"|"tool_start"|"tool_end", session, ... }
 * POST /send    { from, to, message, files?, context?, depth? }
 * POST /audit-reply  PeerAuditReplyEnvelope (sender bound by x-imcodes-session)
 *
 * Port selection:
 *   1. Load persisted port from ~/.imcodes/hook-port (remembered across restarts)
 *   2. Try to bind; if EADDRINUSE, increment and retry (up to 20 attempts)
 *   3. Save the successfully bound port back to the file
 *
 * After startHookServer() resolves, `activeHookPort` holds the actual port.
 * All hook scripts and plugins read this value at write time.
 */
import http from 'http';
import logger from '../util/logger.js';
import { timelineEmitter } from './timeline-emitter.js';
import { getSession, upsertSession, listSessions } from '../store/session-store.js';
import type { SessionRecord } from '../store/session-store.js';
import { refreshSessionWatcher } from './watcher-controls.js';
import { IMCODES_EXTERNAL_CLI_SENDER } from '../../shared/imcodes-send.js';
import { isDiscoverableInterAgentSession } from '../../shared/session-scope.js';
import { dispatchHookSend } from './send-tool.js';
import {
  DEFAULT_HOOK_PORT,
  HOOK_BIND_RETRY_SPAN,
  HOOK_REBIND_RETRY,
  publishHookAuthority,
  readSavedHookPort,
} from './hook-port.js';
import { boundedExponentialBackoffMs } from '../../shared/context-store-rpc.js';
import {
  HOOK_AUTHORITY_ERROR,
  HOOK_AUTHORITY_RECORD_VERSION,
  HOOK_IDENTITY_HOOK_PATH,
  type HookIdentityResponse,
} from '../../shared/hook-authority.js';
import { currentDaemonProcessIdentity } from './instance-lock.js';
import {
  containsLegacyAuditControlMarker,
  PEER_AUDIT_REPLY_ERRORS,
  PEER_AUDIT_REPLY_TOTAL_BYTES,
} from '../../shared/peer-audit.js';
import { submitPeerAuditReply } from './peer-audit-reply-ingress.js';
import { submitDelegationReply } from './delegation-reply-ingress.js';
import {
  AGENT_DELEGATION_REPLY_ERRORS,
  AGENT_DELEGATION_REPLY_TOTAL_BYTES,
} from '../../shared/agent-delegation.js';
import { getAuthenticatedCapabilityOwner } from '../capability/capability-authorization.js';
import { isMemoryScope, validateMemoryScopeIdentity } from '../../shared/memory-scope.js';
import type { ContextNamespace } from '../../shared/context-types.js';
import {
  MEMORY_MCP_SESSION_RESTART_HOOK_PATH,
  MEMORY_MCP_SEND_DELIVERY_MODES,
  type MemoryMcpSendDeliveryMode,
} from '../../shared/memory-mcp-contracts.js';
import { isSendMessageId, type SendMessageId } from '../../shared/send-message-id.js';
import { TASK_ADMISSION_HOOK_PATH, TASK_ADMISSION_OPERATION } from '../../shared/session-resource-lifecycle.js';
import { getDaemonTaskAdmissionController } from './daemon-task-admission.js';
import { measureSessionProcessTreeRssBytes } from './session-resource-service.js';
import {
  MEMORY_MCP_DAEMON_RPC_MAX_BODY_BYTES,
  MEMORY_MCP_DAEMON_RPC_PATH,
  isMemoryMcpDaemonToolName,
  type MemoryMcpDaemonToolName,
} from '../../shared/memory-mcp-daemon-rpc.js';
import { normalizeDaemonLocalMemoryNamespace, LEGACY_DAEMON_LOCAL_USER_ID } from '../../shared/memory-namespace.js';
import type { McpRuntimeCaller } from './memory-mcp-caller.js';
import { SHARED_MACHINE_AUTHORITY_HOOK_PATH } from '../../shared/shared-machine-authority.js';
import { readProcessSharedMachineAuthority } from './shared-machine-authority-context.js';

export { DEFAULT_HOOK_PORT };


/** Max body size: 1 MB */
const MAX_BODY_SIZE = 1024 * 1024;

/** Queue message expiry: 5 minutes */
const QUEUE_EXPIRY_MS = 5 * 60 * 1000;
/** Max send depth (circular send prevention) */
const MAX_SEND_DEPTH = 3;
/** Rate limit: max messages per source per window */
const RATE_LIMIT_MAX = 10;
/** Rate limit window: 60 seconds */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
/** Max broadcast recipients */
const MAX_BROADCAST_RECIPIENTS = 8;

function validCapabilityNamespace(value: unknown): value is ContextNamespace {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const namespace = value as ContextNamespace;
  if (!isMemoryScope(namespace.scope)) return false;
  return validateMemoryScopeIdentity(namespace.scope, {
    user_id: namespace.userId,
    project_id: namespace.projectId,
    workspace_id: namespace.workspaceId,
    org_id: namespace.enterpriseId,
    tenant_id: namespace.localTenant,
  }).ok;
}

function capabilityNamespaceForSession(session: SessionRecord, ownerId: string): ContextNamespace {
  const rawNamespace: unknown = session.contextNamespace;
  if (validCapabilityNamespace(rawNamespace)) {
    return { ...rawNamespace, userId: ownerId };
  }
  const candidateProjectId = rawNamespace && typeof rawNamespace === 'object'
    ? (rawNamespace as Record<string, unknown>).projectId
    : undefined;
  const priorProjectId = typeof candidateProjectId === 'string'
    && Buffer.byteLength(candidateProjectId, 'utf8') <= 512
    ? candidateProjectId
    : undefined;
  return { scope: 'personal', userId: ownerId, ...(priorProjectId ? { projectId: priorProjectId } : {}) };
}

/** The port the hook server is currently listening on. Set after startHookServer() resolves. */
export let activeHookPort: number = DEFAULT_HOOK_PORT;

export type HookPayload =
  | { event: 'idle'; session: string; agentType: string }
  | { event: 'notification'; session: string; title: string; message: string }
  | { event: 'tool_start'; session: string; tool: string }
  | { event: 'tool_end'; session: string };

export type HookCallback = (payload: HookPayload) => void;

/** @deprecated Use HookCallback instead */
export type IdleCallback = (sessionName: string, agentType: string) => void;

// ─── Queue-when-busy ─────────────────────────────────────────────────────────

export interface QueuedMessage {
  from: string;
  message: string;
  queuedAt: number;
  depth: number;
}

/** In-memory queue: target session name → queued messages (FIFO) */
const messageQueue = new Map<string, QueuedMessage[]>();

/** Rate limiter: source session → timestamps of recent sends */
const rateLimiter = new Map<string, number[]>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Preferred bind port: the last published record, else the default. Reading is
 *  delegated to `hook-port.ts` so there is exactly ONE parser for the record
 *  (the previous private copy here diverged - it fell back to
 *  `DEFAULT_HOOK_PORT` where the shared reader returns null, and it accepted
 *  `parseInt` prefixes like "51915abc"). */
function loadPreferredPort(home?: string): number {
  return (home === undefined ? readSavedHookPort() : readSavedHookPort(home)) ?? DEFAULT_HOOK_PORT;
}

/** Identity of the daemon generation that owns this hook endpoint. Captured
 *  ONCE so a republish after a rebind keeps the same owner and is therefore not
 *  fenced against itself. */
const hookOwnerIdentity = currentDaemonProcessIdentity();

/** Determinate outcome of a publish attempt. */
export interface PublishAttempt {
  published: boolean;
  reason?: string;
  error?: unknown;
}

/**
 * Publish (or republish) the endpoint record, fenced against a different live
 * owner.
 *
 * Returns a DETERMINATE result. It previously swallowed both refusal and write
 * errors and resolved `void`, so callers could not tell a successful
 * publication from a refused or failed one - which let the rebind path report
 * "rebound and republished authority" while clients stayed routed by stale or
 * never-written authority. A refusal is still not fatal at startup (the server
 * is already serving), but it MUST be reported, not inferred.
 */
async function publishAuthority(port: number, context: string, home?: string): Promise<PublishAttempt> {
  try {
    const result = await publishHookAuthority(port, {
      owner: hookOwnerIdentity,
      ...(home === undefined ? {} : { home, allowGlobalWriteInTests: true }),
    });
    if (result.published) {
      logger.info({ port, context, pid: hookOwnerIdentity.pid }, 'Hook server: published endpoint authority');
      return { published: true };
    }
    logger.warn(
      { port, context, reason: result.reason, heldBy: result.heldBy },
      'Hook server: endpoint authority publish refused (another live owner holds the record)',
    );
    return { published: false, ...(result.reason === undefined ? {} : { reason: result.reason }) };
  } catch (err) {
    // A write failure must not take a healthy listener down, but it also must
    // not be reported as success.
    logger.warn({ err, port, context }, 'Hook server: endpoint authority publish failed');
    return { published: false, reason: 'publish_write_failed', error: err };
  }
}

/** Raised when startup could not converge: a listener was bound but the
 *  owner-fenced authority could not be published within the bounded retry. The
 *  listener is closed before this escapes, so no live-but-undiscoverable
 *  endpoint is ever left behind. */
export class HookStartupPublishError extends Error {
  readonly port: number;
  readonly reason: string;
  readonly attempts: number;
  constructor(port: number, reason: string, attempts: number) {
    super(
      `hook server could not publish authority for port ${port} after ${attempts} attempt(s): ${reason}`,
    );
    this.name = 'HookStartupPublishError';
    this.port = port;
    this.reason = reason;
    this.attempts = attempts;
  }
}

/** Raised when a rebind bound a listener but could not publish the authority.
 *  Carried through the bounded retry so the endpoint is never reported as
 *  recovered while clients are still routed by the old record. */
class HookRebindPublishError extends Error {
  readonly port: number;
  readonly reason: string;
  readonly cause?: unknown;
  constructor(port: number, reason: string, cause?: unknown) {
    super(`hook authority publish failed after rebinding port ${port}: ${reason}`);
    this.name = 'HookRebindPublishError';
    this.port = port;
    this.reason = reason;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Servers whose close was REQUESTED by the daemon. */
const intentionallyClosing = new WeakSet<http.Server>();

/** Close the hook server and await it. Daemon shutdown MUST use this so the
 *  self-healing rebind is not armed in the middle of teardown. */
export function closeHookServer(server: http.Server): Promise<void> {
  intentionallyClosing.add(server);
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function tryBind(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function extractToolSummary(tool: string, input?: Record<string, unknown>): string {
  if (!input) return '';
  switch (tool) {
    case 'Bash': {
      const cmd = String(input['command'] ?? '');
      return cmd.split('\n').find((l) => l.trim()) ?? cmd;
    }
    case 'Read':
    case 'Write':
    case 'Edit':
      return String(input['file_path'] ?? '');
    case 'Glob':
      return String(input['pattern'] ?? '');
    case 'Grep':
      return `${input['pattern'] ?? ''}${input['path'] ? ` in ${input['path']}` : ''}`;
    case 'Agent':
      return String(input['description'] ?? '');
    default:
      return '';
  }
}

// ─── Target Resolution ───────────────────────────────────────────────────────

export type ResolveResult = {
  ok: true;
  targets: SessionRecord[];
} | {
  ok: false;
  error: string;
  available: string[];
}

function resolveSenderRecord(from: string, allSessions: SessionRecord[]): SessionRecord | null | 'ambiguous' {
  if (from === IMCODES_EXTERNAL_CLI_SENDER) return null;

  const byName = getSession(from);
  if (byName) return byName;

  const byLabel = allSessions.filter((s) => s.state !== 'stopped' && s.label && s.label.toLowerCase() === from.toLowerCase());
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) return 'ambiguous';
  return null;
}

/**
 * Resolve a target session name from the `to` field.
 *
 * Managed-session sender:
 * - Priority: label (case-insensitive) → session name → agent type.
 * - Scope: siblings of `from` session (same parentSession or same project).
 *
 * External CLI sender:
 * - There is no trustworthy sender scope, so only an exact non-stopped session
 *   name is accepted. This preserves shell-originated callback commands such as
 *   `imcodes send "deck_proj_brain" ...` without enabling global
 *   label/type/broadcast fan-out.
 */
/**
 * THE sibling-scope predicate. Defined once and used by every resolution path.
 *
 * A sub-session belongs to exactly ONE owning main. Scoping a main's siblings by
 * shared `projectName` therefore let a DIFFERENT main in the same project
 * address and control it -- with 94 unparented mains in one live project, every
 * main was a sibling of every other main's sub-sessions. A main now sees sibling
 * MAINS plus its OWN subtree, never another main's children.
 *
 * The owner comparison uses `fromRecord.name`, never the raw `from` request
 * field: `from` may be a label, and a label is not an identity.
 */
export function isSiblingSessionOf(candidate: SessionRecord, fromRecord: SessionRecord): boolean {
  if (candidate.name === fromRecord.name) return false;
  if (candidate.state === 'stopped') return false;
  if (fromRecord.parentSession) {
    // Sub-session: its owning main and that main's other children.
    return candidate.parentSession === fromRecord.parentSession
      || candidate.name === fromRecord.parentSession;
  }
  // Main session: sibling mains in the same project, plus its own children only.
  return (candidate.projectName === fromRecord.projectName && !candidate.parentSession)
    || candidate.parentSession === fromRecord.name;
}

export function resolveTarget(from: string, to: string): ResolveResult {
  const allSessions = listSessions();
  const fromRecord = resolveSenderRecord(from, allSessions);

  if (fromRecord === 'ambiguous') {
    return {
      ok: false,
      error: `sender session label "${from}" is ambiguous; set IMCODES_SESSION to the exact session name`,
      available: allSessions.filter((s) => s.state !== 'stopped').map((s) => s.name),
    };
  }

  if (!fromRecord) {
    const activeSessions = allSessions.filter((s) => s.state !== 'stopped');
    const byExactName = activeSessions.filter((s) => s.name === to);
    if (byExactName.length === 1) {
      return { ok: true, targets: [byExactName[0]] };
    }
    return {
      ok: false,
      error: 'sender session not found; exact active session name required when sending from outside a managed session',
      available: activeSessions.map((s) => s.name),
    };
  }

  // Determine siblings: sessions sharing the same parent or project (exclude stopped)
  const allSiblings = allSessions.filter((s) => isSiblingSessionOf(s, fromRecord));
  // Target discovery and every ordinary send mode must mirror what users can
  // identify. Raw legacy workers hidden by the frontend are internal sessions,
  // not user-addressable conversation targets.
  const siblings = allSiblings.filter(isDiscoverableInterAgentSession);

  const availableNames = siblings.map((s) => s.label || s.name);

  if (to === '*' || to === '--all') {
    const targets = siblings.slice(0, MAX_BROADCAST_RECIPIENTS);
    if (targets.length === 0) {
      return { ok: false, error: 'no sibling sessions found', available: availableNames };
    }
    return { ok: true, targets };
  }

  // 1. Match by label (case-insensitive)
  const byLabel = siblings.filter((s) => s.label && s.label.toLowerCase() === to.toLowerCase());
  if (byLabel.length === 1) return { ok: true, targets: [byLabel[0]] };
  if (byLabel.length > 1) {
    return { ok: false, error: `ambiguous target "${to}" matches ${byLabel.length} sessions`, available: availableNames };
  }

  // 2. Match by session name (exact, siblings only — no cross-project)
  const byName = siblings.filter((s) => s.name === to);
  if (byName.length === 1) return { ok: true, targets: [byName[0]] };

  // 3. Match by agent type
  const byType = siblings.filter((s) => s.agentType === to);
  if (byType.length === 1) return { ok: true, targets: [byType[0]] };
  if (byType.length > 1) {
    return { ok: false, error: `ambiguous target "${to}" matches ${byType.length} sessions by agent type`, available: availableNames };
  }

  return { ok: false, error: `target "${to}" not found`, available: availableNames };
}

// ─── Message Dispatch ────────────────────────────────────────────────────────

// ─── Circuit Breakers ────────────────────────────────────────────────────────

function checkRateLimit(from: string): boolean {
  const now = Date.now();
  const timestamps = rateLimiter.get(from) ?? [];
  const recent = timestamps.filter((t) => t > now - RATE_LIMIT_WINDOW_MS);
  rateLimiter.set(from, recent);
  return recent.length < RATE_LIMIT_MAX;
}

function recordSend(from: string): void {
  const timestamps = rateLimiter.get(from) ?? [];
  timestamps.push(Date.now());
  rateLimiter.set(from, timestamps);
}

/**
 * Drain queued messages for a session that just became idle.
 * Delivers FIFO, skipping expired messages.
 */
export async function drainQueue(sessionName: string): Promise<void> {
  const queue = messageQueue.get(sessionName);
  if (!queue || queue.length === 0) return;

  const now = Date.now();

  // Drain ONE message at a time. After sending, the session goes running → idle,
  // which triggers drainQueue again for the next message. This prevents burst-injecting
  // the entire backlog into a session that can only process one message at a time.
  while (queue.length > 0) {
    const msg = queue.shift()!;
    if (now - msg.queuedAt > QUEUE_EXPIRY_MS) {
      logger.debug({ target: sessionName, from: msg.from }, 'Skipping expired queued message');
      continue; // skip expired, try next
    }
    // Found a non-expired message — deliver it and stop
    const record = getSession(sessionName);
    if (!record) break;
    try {
      await dispatchHookSend({ from: msg.from, targetRecords: [record], message: msg.message });
      logger.info({ target: sessionName, from: msg.from }, 'Delivered queued message');
    } catch (err) {
      logger.warn({ err, target: sessionName, from: msg.from }, 'Failed to deliver queued message');
    }
    // Stop after one delivery — next idle transition will drain the next message
    break;
  }
  // Clean up empty queue entry
  if (queue.length === 0) messageQueue.delete(sessionName);
}

/** Get current queue for a target (for testing) */
export function getQueue(target: string): QueuedMessage[] {
  return messageQueue.get(target) ?? [];
}

/** Clear all queues (for testing) */
export function clearQueues(): void {
  messageQueue.clear();
  rateLimiter.clear();
}

// ─── /send Handler ───────────────────────────────────────────────────────────

interface SendRequest {
  from: string;
  to: string;
  message: string;
  files?: string[];
  context?: string;
  depth?: number;
  reply?: boolean;
  deliveryMode?: MemoryMcpSendDeliveryMode;
  supervision?: { taskId: string; assignmentId: string; auditAttemptId?: string; auditRevision?: string };
  messageId?: SendMessageId;
}

const SUPERVISION_SEND_BINDING_KEYS = new Set(['taskId', 'assignmentId', 'auditAttemptId', 'auditRevision']);

function validSupervisionSendBinding(value: unknown): value is NonNullable<SendRequest['supervision']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // Strict allow-list: unknown keys are still rejected outright. `auditAttemptId`
  // and `auditRevision` are optional and, when present, make the binding an exact
  // four-tuple that the resolver matches instead of scanning for a candidate.
  if (Object.keys(record).some((key) => !SUPERVISION_SEND_BINDING_KEYS.has(key))) return false;
  const validBoundedString = (candidate: unknown): boolean => typeof candidate === 'string'
    && candidate.trim().length > 0
    && Buffer.byteLength(candidate, 'utf8') <= 512;
  return validBoundedString(record.taskId)
    && validBoundedString(record.assignmentId)
    && (record.auditAttemptId === undefined || validBoundedString(record.auditAttemptId))
    && (record.auditRevision === undefined || validBoundedString(record.auditRevision));
}

async function handleSend(body: SendRequest): Promise<{ status: number; body: Record<string, unknown> }> {
  const { from, to, message, depth = 0 } = body;

  // Validate required fields
  if (!from || !to || !message) {
    return { status: 400, body: { ok: false, error: 'missing required fields: from, to, message' } };
  }

  if (body.context) {
    return { status: 501, body: { ok: false, error: 'context is not yet supported — send plain message only' } };
  }
  if (body.deliveryMode !== undefined
      && !Object.values(MEMORY_MCP_SEND_DELIVERY_MODES).includes(body.deliveryMode)) {
    return { status: 400, body: { ok: false, error: 'invalid delivery mode' } };
  }
  if (body.supervision !== undefined && !validSupervisionSendBinding(body.supervision)) {
    return { status: 400, body: { ok: false, error: 'invalid supervision binding' } };
  }
  if (body.messageId !== undefined && (!body.supervision || !isSendMessageId(body.messageId))) {
    return { status: 400, body: { ok: false, error: 'invalid supervised message id' } };
  }

  if (containsLegacyAuditControlMarker(message)) {
    return { status: 400, body: { ok: false, error: 'peer_audit_control_requires_dedicated_ingress' } };
  }

  // Circuit breaker: depth limit
  if (depth >= MAX_SEND_DEPTH) {
    return { status: 429, body: { ok: false, error: 'depth limit exceeded' } };
  }

  // Circuit breaker: rate limit
  if (!checkRateLimit(from)) {
    return { status: 429, body: { ok: false, error: 'rate limit exceeded' } };
  }

  // Resolve target
  const result = resolveTarget(from, to);
  if (!result.ok) {
    return { status: 404, body: { ok: false, error: result.error, available: result.available } };
  }
  if (body.supervision && result.targets.length !== 1) {
    return { status: 400, body: { ok: false, error: 'supervision binding requires one exact target' } };
  }

  // Record send after successful resolution (prevents invalid senders from polluting rate-limit map)
  recordSend(from);

  // Transport command liveness mandate (CLAUDE.md): `/stop` is a CONTROL
  // command and must take the priority stop path from EVERY ingress — never
  // the ordinary send queue. Without this, `imcodes send <target> "/stop"`
  // (CLI / MCP send_message pipeline) queues "/stop" as an ordinary message
  // behind the running turn and eventually delivers it to the MODEL as text
  // (observed live on 211: deck_cd_w41 answered "/stop isn't available in
  // this environment." while its running turn kept going). Exact-match only:
  // messages that merely contain "/stop" stay ordinary text.
  if (message.trim() === '/stop') {
    // Lazy import — same heavy-module-cycle rationale as handleStop below.
    const { stopSessionNow } = await import('./command-handler.js');
    const stopped: string[] = [];
    const notStopped: string[] = [];
    for (const target of result.targets) {
      if (stopSessionNow(target.name)) stopped.push(target.name);
      else notStopped.push(target.name);
    }
    if (result.targets.length === 1) {
      const target = result.targets[0].name;
      const ok = stopped.length === 1;
      return {
        status: 200,
        body: { ok, stopped: ok, target, ...(ok ? {} : { error: 'session not found or not stoppable' }) },
      };
    }
    return {
      status: 200,
      body: { ok: notStopped.length === 0, stopped, ...(notStopped.length > 0 ? { notStopped } : {}) },
    };
  }

  const sender = resolveSenderRecord(from, listSessions());
  const projectRoot = sender && sender !== 'ambiguous' ? sender.projectDir : null;
  let dispatch;
  try {
    dispatch = await dispatchHookSend({
      from,
      targetRecords: result.targets,
      message,
      files: body.files,
      projectRoot,
      reply: body.reply === true,
      ...(body.deliveryMode ? { deliveryMode: body.deliveryMode } : {}),
      ...(body.supervision ? { supervision: body.supervision } : {}),
      ...(body.messageId ? { messageId: body.messageId } : {}),
    });
  } catch (err) {
    return { status: 400, body: { ok: false, error: (err as Error).message } };
  }

  if (result.targets.length === 1) {
    const target = result.targets[0].name;
    const messageId = dispatch.messages[0]?.messageId;
    if (dispatch.delivered.length === 1) {
      return {
        status: 200,
        body: {
          ok: true,
          delivered: true,
          target,
          dispatchId: dispatch.dispatchId,
          messageId,
          ...(dispatch.messages[0]?.delegationId ? { delegationId: dispatch.messages[0].delegationId } : {}),
        },
      };
    }
    if (dispatch.queued.length === 1) {
      return {
        status: 200,
        body: {
          ok: true,
          queued: true,
          target,
          dispatchId: dispatch.dispatchId,
          messageId,
          ...(dispatch.messages[0]?.delegationId ? { delegationId: dispatch.messages[0].delegationId } : {}),
        },
      };
    }
    return { status: 500, body: { ok: false, error: dispatch.errors[0] ?? 'dispatch failed' } };
  }

  // Broadcast response
  return {
    status: 200,
    body: {
      ok: dispatch.errors.length === 0,
      delivered: dispatch.delivered,
      queued: dispatch.queued,
      dispatchId: dispatch.dispatchId,
      messages: dispatch.messages,
      ...(dispatch.errors.length > 0 ? { errors: dispatch.errors } : {}),
    },
  };
}

// ─── /stop Handler ───────────────────────────────────────────────────────────

interface StopRequest {
  from: string;
  to: string;
}

/**
 * Force-stop the active turn of a resolved sibling target. Mirrors /send target
 * resolution (label/name/type, sibling-scoped, broadcast via "*") but instead of
 * delivering a message it runs stopSessionNow on the priority lane. Used by the
 * send_stop MCP tool so a busy session (which would otherwise just queue a
 * message) can be interrupted.
 */
async function handleStop(body: StopRequest): Promise<{ status: number; body: Record<string, unknown> }> {
  const { from, to } = body;
  if (!from || !to) {
    return { status: 400, body: { ok: false, error: 'missing required fields: from, to' } };
  }
  if (!checkRateLimit(from)) {
    return { status: 429, body: { ok: false, error: 'rate limit exceeded' } };
  }

  const result = resolveTarget(from, to);
  if (!result.ok) {
    return { status: 404, body: { ok: false, error: result.error, available: result.available } };
  }
  recordSend(from);

  // Lazy import: command-handler pulls in the whole daemon graph, so importing
  // it eagerly here would create a heavy module cycle (and broke hook-server's
  // own tests). Only loaded when /stop is actually called.
  const { stopSessionNow } = await import('./command-handler.js');
  const stopped: string[] = [];
  const notStopped: string[] = [];
  for (const target of result.targets) {
    if (stopSessionNow(target.name)) stopped.push(target.name);
    else notStopped.push(target.name);
  }

  if (result.targets.length === 1) {
    const target = result.targets[0].name;
    const ok = stopped.length === 1;
    return {
      status: 200,
      body: { ok, stopped: ok, target, ...(ok ? {} : { error: 'session not found or not stoppable' }) },
    };
  }

  return {
    status: 200,
    body: { ok: notStopped.length === 0, stopped, ...(notStopped.length > 0 ? { notStopped } : {}) },
  };
}

// ─── Body Parser ─────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage, maxBytes = MAX_BODY_SIZE): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBytes) {
        rejected = true;
        reject(new Error('body too large'));
        req.resume(); // drain remaining data without storing
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => {
      // Decode once after framing is complete. Per-chunk toString() corrupts a
      // valid multi-byte UTF-8 scalar whenever TCP splits inside that scalar.
      if (!rejected) resolve(Buffer.concat(chunks, size).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!rejected) reject(err);
    });
  });
}

// ─── Server ──────────────────────────────────────────────────────────────────

export interface HookServerOptions {
  /** State directory for the endpoint authority pair (`hook-port` +
   *  `hook-authority.json`). Production leaves this unset and uses
   *  `IMCODES_HOME`/`~/.imcodes`.
   *
   *  Tests MUST set it to a temp directory: this is the injection seam whose
   *  absence let eight suites publish over the machine-global record. Setting it
   *  also authorises the write, so the publisher's test-runtime guard does not
   *  suppress a deliberately sandboxed publish. */
  authorityHome?: string;
  /** Rebind + republish the endpoint when the listener is lost without a
   *  `closeHookServer()` request. The daemon sets this; holders that manage the
   *  server's lifetime themselves (tests, embedders) leave it off so a plain
   *  `close()` stays a plain close. */
  rebindOnListenerLoss?: boolean;
  /** Overrides for the bounded rebind retry (see `HOOK_REBIND_RETRY`). */
  rebindRetry?: { maxAttempts?: number; baseDelayMs?: number; capDelayMs?: number };
  /** Test seam performing the owner-fenced authority publication. Injected so a
   *  transient publish failure can be reproduced deterministically: `fs` is an
   *  ESM namespace and cannot be spied on, and a chmod race is timing-dependent.
   *  Production leaves it unset. */
  publishRecord?: (port: number, context: string, home?: string) => Promise<PublishAttempt>;
  /** Test seam performing the actual `listen`. Injected so the bounded rebind
   *  retry can be driven deterministically instead of racing the OS for ports;
   *  a real `EADDRINUSE` sequence is otherwise impossible to reproduce reliably.
   *  MUST reject with `code: 'EADDRINUSE'` to mean "try the next port". */
  bindListener?: (server: http.Server, port: number) => Promise<void>;
  /** Test seam; production lazily binds the daemon-local memory handlers. */
  invokeMemoryMcpTool?: (
    caller: McpRuntimeCaller,
    tool: MemoryMcpDaemonToolName,
    input?: unknown,
  ) => Promise<Record<string, unknown>>;
  /** Exact ServerLink identity injected by the daemon, never by the MCP child. */
  memoryMcpServerId?: string;
  /** Test seam; production schedules the command-handler's exclusive relaunch. */
  restartSession?: (sessionName: string, options: { reset: boolean }) => Promise<boolean> | boolean;
}

async function invokeDaemonMemoryMcpTool(
  caller: McpRuntimeCaller,
  tool: MemoryMcpDaemonToolName,
  input?: unknown,
): Promise<Record<string, unknown>> {
  const { createMemoryMcpToolHandlers } = await import('./memory-mcp-tools.js');
  return createMemoryMcpToolHandlers(caller)[tool](input) as Promise<Record<string, unknown>>;
}

export async function startHookServer(
  onHook: HookCallback,
  options: HookServerOptions = {},
): Promise<{ server: http.Server; port: number }> {
  const preferredPort = loadPreferredPort(options.authorityHome);

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }

    const url = req.url;

    // Owner verification. Unauthenticated on purpose: every local client (the
    // stdio MCP child, `imcodes send`, the peer-audit CLI) must be able to ask
    // "who owns this port?" BEFORE it has any session/server credential. The
    // payload is loopback-only and carries no secret - just the process
    // identity already written to the on-disk record.
    if (url === HOOK_IDENTITY_HOOK_PATH) {
      const identity: HookIdentityResponse = {
        version: HOOK_AUTHORITY_RECORD_VERSION,
        port: activeHookPort,
        pid: hookOwnerIdentity.pid,
        startToken: hookOwnerIdentity.startToken,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(identity));
      return;
    }

    if (url === MEMORY_MCP_DAEMON_RPC_PATH) {
      const senderHeader = req.headers['x-imcodes-session'];
      const senderSessionName = Array.isArray(senderHeader) ? senderHeader[0] : senderHeader;
      const session = senderSessionName ? getSession(senderSessionName) : null;
      if (!session || session.state === 'stopped') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'daemon_memory_worker_identity_unavailable' }));
        return;
      }
      try {
        const body = JSON.parse(await readBody(req, MEMORY_MCP_DAEMON_RPC_MAX_BODY_BYTES)) as Record<string, unknown>;
        if (body.sessionInstanceId !== session.sessionInstanceId
          || body.runtimeEpoch !== session.runtimeEpoch) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'daemon_memory_worker_stale_runtime' }));
          return;
        }
        if (!isMemoryMcpDaemonToolName(body.tool)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'daemon_memory_worker_tool_forbidden' }));
          return;
        }
        const requestedServerId = typeof body.serverId === 'string' ? body.serverId.trim() : '';
        const authenticatedOwner = requestedServerId
          ? getAuthenticatedCapabilityOwner(requestedServerId)
          : undefined;
        const daemonServerId = options.memoryMcpServerId?.trim() ?? '';
        // Normalize the legacy implicit owner before validation. Validating
        // first rejects persisted personal namespaces that intentionally omit
        // userId, then silently falls back to a different user_private
        // namespace and makes every existing project memory row disappear.
        const normalizedStoredNamespace = session.contextNamespace
          ? normalizeDaemonLocalMemoryNamespace(session.contextNamespace)
          : null;
        const storedNamespace = validCapabilityNamespace(normalizedStoredNamespace)
          ? normalizedStoredNamespace
          : { scope: 'user_private' as const, userId: LEGACY_DAEMON_LOCAL_USER_ID };
        const storedUserId = storedNamespace.userId?.trim() || LEGACY_DAEMON_LOCAL_USER_ID;
        const isDaemonBoundLegacyNamespace = storedUserId === LEGACY_DAEMON_LOCAL_USER_ID
          && Boolean(daemonServerId)
          && requestedServerId === daemonServerId;
        if (requestedServerId
          && authenticatedOwner !== storedUserId
          && !isDaemonBoundLegacyNamespace) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'daemon_memory_worker_server_identity_unavailable' }));
          return;
        }
        const caller: McpRuntimeCaller = Object.freeze({
          userId: storedUserId,
          namespace: storedNamespace,
          sessionName: session.name,
          projectName: session.projectName,
          projectRoot: session.projectDir,
          serverId: requestedServerId || null,
          providerId: session.providerId ?? session.agentType,
          transport: 'in_process',
        });
        const invoke = options.invokeMemoryMcpTool ?? invokeDaemonMemoryMcpTool;
        const result = await invoke(caller, body.tool, body.input);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        const status = (error as Error).message === 'body too large' ? 413 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: status === 413 ? 'daemon_memory_worker_request_oversize' : 'daemon_memory_worker_failed',
        }));
      }
      return;
    }

    if (url === TASK_ADMISSION_HOOK_PATH) {
      const senderHeader = req.headers['x-imcodes-session'];
      const senderSessionName = Array.isArray(senderHeader) ? senderHeader[0] : senderHeader;
      const session = senderSessionName ? getSession(senderSessionName) : null;
      if (!session || session.state === 'stopped') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'task_admission_identity_unavailable' }));
        return;
      }
      try {
        const body = JSON.parse(await readBody(req, 4096)) as Record<string, unknown>;
        if (body.sessionInstanceId !== session.sessionInstanceId
          || body.runtimeEpoch !== session.runtimeEpoch) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'task_admission_stale_runtime' }));
          return;
        }
        const controller = getDaemonTaskAdmissionController();
        if (body.operation === TASK_ADMISSION_OPERATION.ACQUIRE) {
          const requestedBytes = typeof body.requestedBytes === 'number' ? body.requestedBytes : 0;
          const sessionRssBytes = await measureSessionProcessTreeRssBytes(session);
          const result = controller.acquire(session.name, requestedBytes, sessionRssBytes ?? Number.POSITIVE_INFINITY);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
          return;
        }
        if (body.operation === TASK_ADMISSION_OPERATION.RELEASE && typeof body.token === 'string') {
          const released = controller.release(session.name, body.token);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, released }));
          return;
        }
        throw new Error('invalid_task_admission_request');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'malformed' }));
      }
      return;
    }

    if (url === SHARED_MACHINE_AUTHORITY_HOOK_PATH) {
      const senderHeader = req.headers['x-imcodes-session'];
      const senderSessionName = Array.isArray(senderHeader) ? senderHeader[0] : senderHeader;
      try {
        const body = JSON.parse(await readBody(req, 4096)) as Record<string, unknown>;
        const session = senderSessionName ? getSession(senderSessionName) : null;
        if (!session || session.state === 'stopped'
          || typeof session.sessionInstanceId !== 'string' || !session.sessionInstanceId
          || typeof session.runtimeEpoch !== 'string' || !session.runtimeEpoch
          || body.sessionInstanceId !== session.sessionInstanceId
          || body.runtimeEpoch !== session.runtimeEpoch) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'shared_machine_authority_stale_runtime' }));
          return;
        }
        const { getTransportRuntime } = await import('../agent/session-manager.js');
        const runtime = getTransportRuntime(session.name);
        const processContext = readProcessSharedMachineAuthority(session.name, {
          sessionInstanceId: session.sessionInstanceId,
          runtimeEpoch: session.runtimeEpoch,
        });
        const required = runtime?.requiresSharedMachineAuthority() ?? processContext.required;
        const authority = runtime?.getActiveSharedMachineAuthority() ?? processContext.authority;
        if (required && !authority) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'shared_machine_authority_unavailable' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, required, authority }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'malformed' }));
      }
      return;
    }

    if (url === '/capability-identity') {
      const senderHeader = req.headers['x-imcodes-session'];
      const senderSessionName = Array.isArray(senderHeader) ? senderHeader[0] : senderHeader;
      try {
        const body = JSON.parse(await readBody(req, 4096)) as Record<string, unknown>;
        const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
        const serverId = typeof body.serverId === 'string' ? body.serverId.trim() : '';
        const session = senderSessionName ? getSession(senderSessionName) : null;
        const sessionProviderId = session?.providerId ?? session?.agentType;
        const ownerId = serverId ? getAuthenticatedCapabilityOwner(serverId) : undefined;
        const projectDir = session?.projectDir?.trim();
        if (!session || !providerId || !serverId || sessionProviderId !== providerId || !ownerId
          || (projectDir && Buffer.byteLength(projectDir, 'utf8') > 4096)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'capability_identity_unavailable' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true, ownerId, providerId, serverId, sessionId: session.name,
          namespace: capabilityNamespaceForSession(session, ownerId),
          ...(projectDir ? { projectDir } : {}),
        }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'malformed' }));
      }
      return;
    }

    if (url === '/audit-reply') {
      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.includes('application/json')) {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
        return;
      }
      try {
        const body = await readBody(req, PEER_AUDIT_REPLY_TOTAL_BYTES);
        const senderHeader = req.headers['x-imcodes-session'];
        const senderSessionName = Array.isArray(senderHeader) ? senderHeader[0] : senderHeader;
        const result = await submitPeerAuditReply({ rawBody: body, senderSessionName });
        const status = result.ok
          ? 200
          : result.error === PEER_AUDIT_REPLY_ERRORS.RATE_LIMITED
            ? 429
            : result.error === 'ingress_unavailable'
              ? 503
              : 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        const status = (err as Error).message === 'body too large' ? 413 : 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: status === 413 ? 'oversize' : 'malformed' }));
      }
      return;
    }

    if (url === '/delegation-reply') {
      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.includes('application/json')) {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
        return;
      }
      try {
        const body = await readBody(req, AGENT_DELEGATION_REPLY_TOTAL_BYTES);
        const senderHeader = req.headers['x-imcodes-session'];
        const senderSessionName = Array.isArray(senderHeader) ? senderHeader[0] : senderHeader;
        const result = await submitDelegationReply({ rawBody: body, senderSessionName });
        const status = result.ok
          ? 200
          : result.error === AGENT_DELEGATION_REPLY_ERRORS.RATE_LIMITED
            ? 429
            : result.error === 'ingress_unavailable'
              ? 503
              : 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        const status = (error as Error).message === 'body too large' ? 413 : 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: status === 413
            ? AGENT_DELEGATION_REPLY_ERRORS.OVERSIZE
            : AGENT_DELEGATION_REPLY_ERRORS.MALFORMED,
        }));
      }
      return;
    }

    if (url === '/list') {
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as { from?: string };
        const from = parsed.from || '';
        const fromRecord = from ? getSession(from) : null;
        const allSess = listSessions();
        const siblings = (fromRecord
          ? allSess.filter((s) => isSiblingSessionOf(s, fromRecord))
          : allSess.filter((s) => s.state !== 'stopped'))
          .filter(isDiscoverableInterAgentSession);
        const sessions = siblings.map((s) => ({
          name: s.name,
          label: s.label || undefined,
          agentType: s.agentType,
          state: s.state,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessions }));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: 'bad request' }));
      }
      return;
    }

    if (url === '/send') {
      // Content-Type validation for /send
      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.includes('application/json')) {
        res.writeHead(415);
        res.end(JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
        return;
      }

      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as SendRequest;
        const result = await handleSend(parsed);
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      } catch (err) {
        if ((err as Error).message === 'body too large') {
          res.writeHead(413);
          res.end(JSON.stringify({ ok: false, error: 'request body too large' }));
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'bad request' }));
        }
      }
      return;
    }

    if (url === MEMORY_MCP_SESSION_RESTART_HOOK_PATH) {
      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.includes('application/json')) {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
        return;
      }
      try {
        const body = JSON.parse(await readBody(req, 4096)) as Record<string, unknown>;
        const senderHeader = req.headers['x-imcodes-session'];
        const authenticatedSender = Array.isArray(senderHeader) ? senderHeader[0] : senderHeader;
        const from = typeof body.from === 'string' ? body.from.trim() : '';
        const to = typeof body.to === 'string' ? body.to.trim() : '';
        if (!from || !to || authenticatedSender !== from || typeof body.reset !== 'boolean') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid exact-session restart request' }));
          return;
        }
        const callerRecord = getSession(from);
        const targetRecord = getSession(to);
        if (!callerRecord || callerRecord.state === 'stopped') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'session restart caller identity is unavailable' }));
          return;
        }
        if (!targetRecord || targetRecord.projectName !== callerRecord.projectName) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'session restart target is unavailable' }));
          return;
        }
        if (!checkRateLimit(from)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'rate limit exceeded' }));
          return;
        }
        recordSend(from);
        const reset = body.reset;
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, accepted: true, target: targetRecord.name, reset }), () => {
          setImmediate(() => {
            void (async () => {
              const restart = options.restartSession ?? (async (sessionName: string, restartOptions: { reset: boolean }) => {
                const { restartSessionNow } = await import('./command-handler.js');
                return restartSessionNow(sessionName, restartOptions);
              });
              const accepted = await restart(targetRecord.name, { reset });
              if (!accepted) logger.warn({ sessionName: targetRecord.name, reset }, 'MCP session restart was not accepted');
            })().catch((err) => {
              logger.error({ err, sessionName: targetRecord.name, reset }, 'MCP session restart failed after acceptance');
            });
          });
        });
      } catch (err) {
        const status = (err as Error).message === 'body too large' ? 413 : 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: status === 413 ? 'request body too large' : 'bad request' }));
      }
      return;
    }

    if (url === '/stop') {
      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.includes('application/json')) {
        res.writeHead(415);
        res.end(JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
        return;
      }
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as StopRequest;
        const result = await handleStop(parsed);
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      } catch (err) {
        if ((err as Error).message === 'body too large') {
          res.writeHead(413);
          res.end(JSON.stringify({ ok: false, error: 'request body too large' }));
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'bad request' }));
        }
      }
      return;
    }

    if (url === '/sessions/live') {
      // Authoritative live session states for local tooling (`imcodes status`).
      // sessions.json is a multi-writer read-modify-write file whose `state`
      // can be resurrected stale (a slow spread-writer can bring back
      // 'running' minutes after the runtime settled idle). For sessions with a
      // live transport runtime the runtime IS the truth — report it, and
      // self-heal the drifted record so every record reader converges.
      try {
        // Lazy import — session-manager pulls in the whole daemon graph (same
        // heavy-module-cycle rationale as the command-handler import above).
        const { getTransportRuntime } = await import('../agent/session-manager.js');
        const sessions = listSessions().map((record) => {
          const runtime = getTransportRuntime(record.name);
          if (!runtime) {
            return { name: record.name, state: record.state, live: false };
          }
          // Reconcile the observable state before projecting it. An idle
          // runtime can still have provider-owned work (or a queued dispatch)
          // when a provider status callback arrived out of order; the runtime
          // promotes that state to tool_running / starts the drain here.
          runtime.drainPendingIfIdle?.('sessions-live');
          const status = runtime.getStatus();
          const state = status === 'idle' ? 'idle' : status === 'error' ? 'error' : 'running';
          if (record.state !== state && record.state !== 'stopped') {
            const fresh = getSession(record.name);
            if (fresh && fresh.state !== state && fresh.state !== 'stopped') {
              upsertSession({ ...fresh, state, updatedAt: Date.now() });
              logger.debug(
                { sessionName: record.name, recordState: fresh.state, runtimeState: state },
                'sessions/live: repaired drifted session record state from live runtime',
              );
            }
          }
          return { name: record.name, state, live: true, pendingCount: runtime.pendingCount };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessions }));
      } catch (err) {
        logger.warn({ err }, 'sessions/live: failed to assemble live session states');
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: 'failed to assemble live session states' }));
      }
      return;
    }

    if (url === '/notify') {
      // /notify handler — existing CC hook behavior (no Content-Type enforcement)
      let body = '';
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_SIZE) {
          req.destroy();
          return;
        }
        body += chunk.toString();
      });
      req.on('end', async () => {
        try {
          const msg = JSON.parse(body) as Record<string, unknown>;
          const event = msg['event'] as string | undefined;
          const session = msg['session'] as string | undefined;

          if (!event || !session) {
            res.writeHead(400);
            res.end('missing event or session');
            return;
          }

          // Layer 2: verify session belongs to a daemon-managed CC session.
          // Hooks are global (~/.claude/settings.json) so any CC instance triggers
          // them. Without this check, a manually-started CC whose tmux pane happens
          // to live in a deck_ session would misroute events.
          const record = getSession(session);
          if (!record || record.agentType !== 'claude-code') {
            logger.debug({ session, event, agentType: record?.agentType }, 'Hook: ignored — not a managed claude-code session');
            res.writeHead(200);
            res.end('ignored');
            return;
          }

          if (event === 'idle') {
            const agentType = (msg['agentType'] as string | undefined) ?? 'unknown';
            logger.info({ session, agentType }, 'Hook: session idle');
            await refreshSessionWatcher(session);
            onHook({ event: 'idle', session, agentType });
            timelineEmitter.emit(session, 'session.state', { state: 'idle' }, { source: 'hook' });
            const sess = getSession(session);
            if (sess) upsertSession({ ...sess, state: 'idle', updatedAt: Date.now() });
            // Drain queued messages when session becomes idle
            void drainQueue(session);
          } else if (event === 'notification') {
            const title = (msg['title'] as string | undefined) ?? '';
            const message = (msg['message'] as string | undefined) ?? '';
            logger.info({ session, title }, 'Hook: CC notification');
            onHook({ event: 'notification', session, title, message });
          } else if (event === 'tool_start') {
            const tool = (msg['tool'] as string | undefined) ?? 'unknown';
            const toolInput = msg['tool_input'] as Record<string, unknown> | undefined;
            const input = extractToolSummary(tool, toolInput);
            logger.debug({ session, tool }, 'Hook: tool start');
            onHook({ event: 'tool_start', session, tool });
            timelineEmitter.emit(session, 'session.state', { state: 'running' }, { source: 'hook' });
            timelineEmitter.emit(session, 'tool.call', { tool, ...(input ? { input } : {}) }, { source: 'hook' });
          } else if (event === 'tool_end') {
            logger.debug({ session }, 'Hook: tool end');
            onHook({ event: 'tool_end', session });
            timelineEmitter.emit(session, 'tool.result', {}, { source: 'hook' });
          } else if (event === 'mode_change') {
            const mode = (msg['mode'] as string | undefined) ?? '';
            const active = msg['active'] !== false;
            logger.debug({ session, mode, active }, 'Hook: mode change');
            timelineEmitter.emit(session, 'mode.state', { mode, active }, { source: 'hook' });
          }

          res.writeHead(200);
          res.end('ok');
        } catch {
          res.writeHead(400);
          res.end('bad request');
        }
      });
      return;
    }

    // Unknown route
    res.writeHead(404);
    res.end();
  });

  const bind = options.bindListener ?? tryBind;
  /** Single publication entry point for BOTH startup and rebind, so the seam and
   *  the production path cannot diverge. */
  const publishVia = (target: number, context: string): Promise<PublishAttempt> => (
    options.publishRecord
      ? options.publishRecord(target, context, options.authorityHome)
      : publishAuthority(target, context, options.authorityHome)
  );
  const bindWithin = async (from: number): Promise<number> => {
    for (let attempt = 0; attempt < HOOK_BIND_RETRY_SPAN; attempt++) {
      const port = from + attempt;
      try {
        await bind(server, port);
        activeHookPort = port;
        return port;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
        logger.debug({ port }, 'Hook server: port in use, trying next');
      }
    }
    throw new Error(
      `Hook server: could not bind to any port in range ${from}-${from + HOOK_BIND_RETRY_SPAN - 1}`,
    );
  };

  // A listener that dies after a successful bind used to leave the daemon with
  // NO hook endpoint and a record pointing at a dead port, recoverable only by
  // restarting the whole daemon. Rebind + republish in place instead.
  const rebindRetry = {
    maxAttempts: options.rebindRetry?.maxAttempts ?? HOOK_REBIND_RETRY.maxAttempts,
    baseDelayMs: options.rebindRetry?.baseDelayMs ?? HOOK_REBIND_RETRY.baseDelayMs,
    capDelayMs: options.rebindRetry?.capDelayMs ?? HOOK_REBIND_RETRY.capDelayMs,
  };

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });

  /** Close the listener if it is up. Re-entry is already blocked by
   *  `rebinding`, so the `'close'` this emits is ignored. */
  const releaseListener = async (): Promise<void> => {
    if (!server.listening) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  const rebindOnce = async (cause: string): Promise<number> => {
    // An `'error'` event does NOT imply the handle was released, and `listen()`
    // on a still-listening server throws ERR_SERVER_ALREADY_LISTEN - which is
    // not EADDRINUSE, so `bindWithin` rethrows and the whole recovery aborts.
    // Release the handle first.
    await releaseListener();
    const port = await bindWithin(loadPreferredPort(options.authorityHome));
    // Recovery is NOT complete until the authority is actually published:
    // clients route by the record, so a bound listener with a stale or
    // unwritten record leaves them pointed at the dead endpoint. Throwing keeps
    // the bounded retry running over BOTH steps.
    const attempt = await publishVia(port, `rebind:${cause}`);
    if (!attempt.published && attempt.reason !== HOOK_AUTHORITY_ERROR.publishSuppressedForTests) {
      // ROLL BACK THIS ATTEMPT'S LISTENER before failing.
      //
      // Previously only the NEXT `rebindOnce` closed it, so intermediate
      // attempts were cleaned up by accident and the FINAL failure left a live
      // listener bound to a port no client could discover - the listener /
      // authority split this work exists to eliminate, needing an unrelated
      // future close or a daemon restart to heal. An attempt that cannot
      // publish must leave nothing serving.
      await releaseListener();
      throw new HookRebindPublishError(port, attempt.reason ?? 'unknown', attempt.error);
    }
    return port;
  };

  let rebinding = false;
  const handleUnexpectedLoss = (cause: string, err?: unknown): void => {
    if (intentionallyClosing.has(server) || rebinding) return;
    if (!options.rebindOnListenerLoss) return;
    rebinding = true;
    logger.warn({ err, cause, port: activeHookPort }, 'Hook server: listener lost, rebinding');
    void (async () => {
      try {
        for (let attempt = 1; attempt <= rebindRetry.maxAttempts; attempt += 1) {
          try {
            const port = await rebindOnce(cause);
            logger.info({ port, cause, attempt }, 'Hook server: rebound and republished authority');
            return;
          } catch (rebindError) {
            if (attempt >= rebindRetry.maxAttempts) {
              // Belt and braces: `rebindOnce` already rolls back its own
              // listener, but the invariant asserted by the regression is
              // "after exhaustion nothing is serving", so enforce it here too
              // rather than relying on every failure path remembering.
              await releaseListener();
              logger.error(
                { err: rebindError, cause, attempts: attempt, listening: server.listening },
                'Hook server: rebind failed; hook endpoint is down',
              );
              return;
            }
            // Every candidate in the bind window can be momentarily occupied,
            // so back off and try the whole window again rather than declaring
            // the endpoint permanently dead.
            const delay = boundedExponentialBackoffMs(
              rebindRetry.baseDelayMs,
              attempt,
              rebindRetry.capDelayMs,
            );
            logger.warn(
              { err: rebindError, cause, attempt, delay },
              'Hook server: rebind attempt failed, retrying',
            );
            await sleep(delay);
          }
        }
      } finally {
        rebinding = false;
      }
    })();
  };
  // Attached only AFTER the initial bind resolves, so `tryBind`'s one-shot
  // error handler still owns EADDRINUSE during discovery.
  //
  // The 'close' arm is why this is OPT-IN. A first cut tried to infer intent by
  // wrapping `server.close()`; that broke callers which close the server
  // directly (the daemon test suites) - the listener rebound mid-teardown and
  // in-flight requests died with ECONNRESET. Rather than guess, the daemon
  // declares that it wants self-healing and anyone holding the handle for their
  // own lifecycle (tests, embedders) keeps plain close() semantics.
  const armLossHandlers = (): void => {
    server.on('error', (err) => handleUnexpectedLoss('error', err));
    server.on('close', () => handleUnexpectedLoss('close'));
  };

  const port = await bindWithin(preferredPort);
  if (port !== preferredPort) {
    logger.info({ port, preferredPort }, 'Hook server: port conflict, using new port');
  } else {
    logger.info({ port }, 'Hook server listening');
  }

  // ── Startup is ONE bounded convergence transaction: bind AND owner-fenced
  // publish, or nothing.
  //
  // This result used to be discarded, and the rebind handler only fires on a
  // later `error`/`close`. So a single startup write failure or fence refusal
  // left a LIVE listener paired with a stale or missing authority record -
  // permanently, until an unrelated listener loss or a daemon restart. That is
  // exactly the reported live-51941 / stale-51915 split, reached without any
  // subsequent failure. A started hook server must never be undiscoverable.
  let published: PublishAttempt = { published: false, reason: 'not_attempted' };
  for (let attempt = 1; attempt <= rebindRetry.maxAttempts; attempt += 1) {
    published = await publishVia(port, 'start');
    if (published.published) break;
    // `publishSuppressedForTests` means publication was DELIBERATELY skipped by
    // the containment guard, not that it failed: the caller is an in-process
    // test runner that must never write the machine-global record. Retrying or
    // failing the start would be wrong - there is nothing to converge on.
    if (published.reason === HOOK_AUTHORITY_ERROR.publishSuppressedForTests) {
      logger.debug({ port }, 'Hook server: authority publication suppressed for a test runtime');
      break;
    }
    if (attempt >= rebindRetry.maxAttempts) break;
    const delay = boundedExponentialBackoffMs(
      rebindRetry.baseDelayMs,
      attempt,
      rebindRetry.capDelayMs,
    );
    logger.warn(
      { port, attempt, delay, reason: published.reason },
      'Hook server: startup authority publish failed, retrying',
    );
    await sleep(delay);
  }

  if (!published.published
    && published.reason !== HOOK_AUTHORITY_ERROR.publishSuppressedForTests) {
    // Fail closed: tear the listener down so nothing is serving an endpoint no
    // client can discover, then fail the start.
    logger.error(
      { port, reason: published.reason, attempts: rebindRetry.maxAttempts },
      'Hook server: startup authority publish exhausted; closing listener and failing start',
    );
    await closeHookServer(server).catch(() => {});
    throw new HookStartupPublishError(port, published.reason ?? 'unknown', rebindRetry.maxAttempts);
  }

  armLossHandlers();
  return { server, port };
}
