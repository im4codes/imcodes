/**
 * WsBridge: per-server WebSocket bridge between daemon and browser clients.
 * Replaces the CF DaemonBridge Durable Object.
 *
 * Binary routing: daemon binary raw frames are routed only to browsers
 * subscribed to the target session in raw mode (not broadcast). Subscription
 * state is tracked by intercepting terminal.subscribe/unsubscribe browser
 * messages.
 *
 * Per-(session,browser) forwarding queue: text snapshot frames and binary raw
 * frames share a single queue for ordered delivery. Overflow (512KB) triggers
 * terminal.stream_reset and unsubscribes the browser from that session.
 */

import WebSocket from 'ws';
import { performance } from 'node:perf_hooks';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import { MemoryRateLimiter } from './rate-limiter.js';
import { randomHex, sha256Hex } from '../security/crypto.js';
import { resolveServerRole } from '../security/authorization.js';
import { DAEMON_MSG } from '../../../shared/daemon-events.js';
import { RESOURCE_EVENT_MSG, type ResourceTopic } from '../../../shared/resource-events.js';
import { DAEMON_COMMAND_TYPES } from '../../../shared/daemon-command-types.js';
import { REPO_MSG, REPO_RELAY_TYPES } from '../../../shared/repo-types.js';
import { TRANSPORT_RELAY_TYPES, TRANSPORT_MSG } from '../../../shared/transport-events.js';
import {
  MEMORY_WS,
  isMemoryManagementRequestType,
  isMemoryManagementResponseType,
} from '../../../shared/memory-ws.js';
import {
  MEMORY_MANAGEMENT_CONTEXT_FIELD,
  type AuthenticatedMemoryManagementContext,
  type MemoryManagementBoundProject,
  type MemoryManagementRole,
} from '../../../shared/memory-management-context.js';
import {
  MEMORY_MANAGEMENT_BRIDGE_ERROR_CODES,
  MEMORY_MANAGEMENT_ERROR_CODES,
} from '../../../shared/memory-management.js';
import {
  MEMORY_FEATURE_CONFIG_MSG,
  MEMORY_FEATURE_CONFIG_PREF_KEY,
  MEMORY_FEATURE_FLAGS,
  encodeMemoryFeatureFlagValuesJson,
  getMemoryFeatureFlagDefinition,
  isMemoryFeatureFlag,
  memoryFeatureFlagEnvKey,
  parseMemoryFeatureFlagValuesJson,
  computeEffectiveMemoryFeatureFlags,
  resolveMemoryFeatureFlagValue,
  type FeatureFlagValueSource,
  type MemoryFeatureFlag,
  type MemoryFeatureFlagResolutionLayers,
  type MemoryFeatureFlagValues,
} from '../../../shared/feature-flags.js';
import {
  MSG_COMMAND_ACK,
  MSG_COMMAND_FAILED,
  MSG_DAEMON_ONLINE,
  MSG_DAEMON_OFFLINE,
  ACK_FAILURE_DAEMON_OFFLINE,
  ACK_FAILURE_ACK_TIMEOUT,
  ACK_FAILURE_DAEMON_ERROR,
  RECONNECT_GRACE_MS,
  ACK_TIMEOUT_MS,
  ACK_TIMEOUT_RETRY_LIMIT,
  ACK_DEDUP_TTL_MS,
  INFLIGHT_GC_TTL_MS,
  type AckFailureReason,
} from '../../../shared/ack-protocol.js';
import {
  PREVIEW_BINARY_FRAME,
  PREVIEW_ERROR,
  PREVIEW_LIMITS,
  PREVIEW_MSG,
  PREVIEW_TERMINAL_OUTCOME,
  packPreviewBinaryFrame,
  packPreviewWsFrame,
  parsePreviewBinaryFrame,
  parsePreviewWsFrame,
  type PreviewErrorMessage,
  type PreviewResponseStartMessage,
  type PreviewWsCloseMessage,
  type PreviewWsErrorMessage,
  type PreviewWsOpenedMessage,
} from '../../../shared/preview-types.js';
import { isStreamingResponse } from '../../../shared/preview-stream-policy.js';
import { getSessionRuntimeType } from '../../../shared/agent-types.js';
import { LocalWebPreviewRegistry, setPreviewActiveRelayHook, setPreviewEvictedHook } from '../preview/registry.js';
import { updateServerHeartbeat, updateServerStatus, upsertDiscussion, insertDiscussionRound, createSubSession, getSubSessionById, updateSubSession, upsertOrchestrationRun, updateProviderStatus, clearProviderStatus, updateProviderRemoteSessions, upsertSessionTextTailCacheEvent, getUserPref, setUserPref, deleteUserPref, getDbSessionsByServer, getUserById, insertDiscussionComment } from '../db/queries.js';
import { toDiscussionCommentView } from '../share/discussion-comment-view.js';
import { resolveCoveredSessionNames } from '../share/covered-sessions.js';
import logger from '../util/logger.js';
import { incrementCounter } from '../util/metrics.js';
import { pickReadableSessionDisplay } from '../../../shared/session-display.js';
import { isKnownTestSessionLike } from '../../../shared/test-session-guard.js';
import { PUSH_TIMELINE_EVENT_MAX_AGE_MS, TIMELINE_SUPPRESS_PUSH_FIELD } from '../../../shared/push-notifications.js';
import {
  DAEMON_UPGRADE_DELIVERY_STATUS,
} from '../../../shared/daemon-upgrade.js';
import {
  P2P_WORKFLOW_MSG,
  isP2pWorkflowRequestId,
  parseP2pWorkflowMessageType,
  type P2pWorkflowMessageDescriptor,
  type P2pWorkflowMessageType,
} from '../../../shared/p2p-workflow-messages.js';
import {
  P2P_BRIDGE_ERROR_CODES,
  P2P_BRIDGE_PENDING_REQUEST_TIMEOUT_MS,
  P2P_BRIDGE_PENDING_REQUESTS_GLOBAL,
  P2P_BRIDGE_PENDING_REQUESTS_PER_SOCKET,
  P2P_CAPABILITY_FRESHNESS_TTL_MS,
} from '../../../shared/p2p-workflow-constants.js';
import { DaemonUpgradeCoordinator, type DaemonUpgradeSource, type RequestDaemonUpgradeResult } from './daemon-upgrade-coordinator.js';
import {
  SHARE_REASONS,
  commandSessionName,
  evaluateShareCommand,
  filterShareDaemonMessage,
  resolveShareCoverageFromDb,
  shareStateCoversSession,
  shareTargetKey,
  type EffectiveCoverage,
  type ShareCoverageResolver,
  type ShareCommandDecision,
  type ShareReason,
  type ShareScopedSocketState,
  type ShareTarget,
} from './share-policy.js';
import {
  sanitizeP2pRunForPersistAndBroadcast,
  sanitizeP2pRunUpdateForBroadcast,
} from '../p2p-workflow-sanitize.js';
import { sanitizeProjectName } from '../../../shared/sanitize-project-name.js';
import {
  SESSION_GROUP_CLONE_CAPABILITY_V1,
  SESSION_GROUP_CLONE_MSG,
  SESSION_GROUP_CLONE_STATES,
  cloneP2pConfigWithSessionRemap,
  mainSessionNameForProjectSlug,
  type SessionGroupCloneCleanupResource,
  type SessionGroupCloneEvent,
  type SessionGroupCloneResult,
  type SessionGroupCloneSkippedMember,
  type SessionGroupCloneWarning,
} from '../../../shared/session-group-clone.js';
import { P2P_CONFIG_MSG } from '../../../shared/p2p-config-events.js';
import { p2pSessionConfigLegacyPrefKeys, p2pSessionConfigPrefKey } from '../../../shared/p2p-config-scope.js';
import { isP2pSavedConfig, type P2pSavedConfig } from '../../../shared/p2p-modes.js';
import { FS_READ_ERROR_CODES } from '../../../shared/fs-read-error-codes.js';
import {
  TIMELINE_MESSAGES,
  TIMELINE_PROTOCOL_CAPABILITY,
  TIMELINE_RESPONSE_SOURCES,
  TIMELINE_RESPONSE_STATUS,
} from '../../../shared/timeline-protocol.js';
import { TIMELINE_PAYLOAD_BUDGET_BYTES } from '../../../shared/timeline-payload-budget.js';
import type { DaemonBuildInfo } from '../../../shared/build-manifest-types.js';
import {
  TIMELINE_REQUEST_ERROR_REASONS,
  isRecoverableTimelineRequestErrorReason,
} from '../../../shared/timeline-history-errors.js';
import {
  deriveShareTransitionKey,
  normalizeExistingShareTarget,
  shareTargetFromSessionName,
  shareTargetRef,
  writeShareAuditEvent,
  type ShareAuditActionType,
  type ShareTargetInput,
} from '../db/tab-sharing.js';
import { evaluateSharedCommandRateLimit } from '../share/share-rate-limit.js';
import {
  SHARE_BROWSER_COMMANDS,
  SHARE_DISCUSSION_EVENTS,
  rawSubSessionIdFromDisplayName,
  type SharedActorEnvelope,
} from '../../../shared/tab-sharing.js';

const AUTH_TIMEOUT_MS = 5000;
const MAX_QUEUE_SIZE = 100;
const MAX_BROWSER_PAYLOAD = TIMELINE_PAYLOAD_BUDGET_BYTES.CHAT_HISTORY_TRACE_HARD_LIMIT;
const MAX_PENDING_MEMORY_MANAGEMENT_REQUESTS_PER_SOCKET = 32;
// Desktop with pinned panels + many sessions can fire 60+ subscribe/repo/repo
// detect / fs.git_status / chat.subscribe / ping messages on initial connect.
// A reconnect within 10s doubles that. 120 was right at the cliff edge and
// caused user-typed `session.send` messages to be dropped (and surfaced as
// instant `command.failed`) when the limiter consumed all tokens during init.
// 300 gives 3x headroom for normal init bursts without making abuse easier:
// real abuse patterns send orders-of-magnitude more.
const BROWSER_RATE_LIMIT = 300;
const BROWSER_RATE_WINDOW = 10_000; // 10s
const FS_PENDING_UNICAST_TIMEOUT_MS = 20_000;
const SESSION_GROUP_CLONE_CONTEXT_TTL_MS = 10 * 60 * 1000;
/**
 * Master switch for the per-browser rate limiter.
 *
 * Why this exists as a flag rather than a deletion: the browser-side burst
 * problem isn't fixed yet (a reconnect or multi-panel desktop tab still
 * fires 60+ messages within the first ~2 s, and a reconnect within the
 * 10 s window doubles that). Turning the limiter off avoids the worst
 * symptom — `session.send` getting dropped → instant `command.failed` →
 * UI bubble flips to failed within milliseconds — which surfaces in
 * production as the wall-of-`rate_limited`-errors users have been seeing.
 *
 * The proper fix is reducing the burst itself (coalescing fs.git_status /
 * repo.detect, debouncing terminal.subscribe replays, etc.) rather than
 * raising the limit further. Until that lands, leave this OFF. To turn
 * the limiter back on, flip the flag — no other changes required.
 */
const BROWSER_RATE_LIMIT_ENABLED = false;
// 4MB per (session, browser). Heavy output (build logs, large `cat`, log tail)
// can burst tens of KB per frame; at 1MB the queue overflowed within a few
// frames during heavy output and triggered stream_reset cascades, which the
// browser then de-rated to "几秒一次更新". 4MB gives ~1s of breathing room
// at typical egress rates without holding meaningful memory (a single ws
// per session, queue is reset on overflow anyway).
const QUEUE_MAX_BYTES = 4 * 1024 * 1024;
const SUBSESSION_OWNERSHIP_RETRY_DELAYS_MS = [50, 150, 350] as const;

/**
 * Safe ws.send: checks readyState, wraps in try/catch.
 * Returns true if sent, false if socket not open or send threw.
 * Calls onFail() if the send could not be delivered.
 */
function safeSend(ws: WebSocket, data: string | Buffer, onComplete?: (err?: Error) => void): boolean {
  if (ws.readyState !== WebSocket.OPEN) {
    onComplete?.(new Error('not open'));
    return false;
  }
  try {
    ws.send(data, { binary: Buffer.isBuffer(data) }, (err) => {
      onComplete?.(err);
    });
    return true;
  } catch (e) {
    onComplete?.(e instanceof Error ? e : new Error(String(e)));
    return false;
  }
}

/** Message types allowed to be forwarded from browser → daemon */
// Browser→daemon message filtering: auth + rate-limit + payload-size are the real
// security boundaries. The daemon command-handler ignores unknown types via its
// switch default. No whitelist needed — it only caused silent message drops when
// new features were added to the daemon but not mirrored here.

// ── Terminal forwarding queue (per (session, browser)) ────────────────────────

/**
 * Per-(session, browser) forwarding queue.
 * Tracks in-flight bytes via ws.send() callbacks.
 * On overflow, triggers the provided overflow handler (send reset, unsubscribe).
 */
class TerminalForwardQueue {
  private bufferedBytes = 0;

  send(ws: WebSocket, data: string | Buffer, onOverflow: () => void): void {
    const size = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
    this.bufferedBytes += size;

    if (this.bufferedBytes > QUEUE_MAX_BYTES) {
      this.bufferedBytes -= size;
      onOverflow();
      return;
    }

    safeSend(ws, data, (err) => {
      this.bufferedBytes -= size;
      if (err) {
        // Socket closed or errored — treat as overflow to trigger cleanup
        onOverflow();
      }
    });
  }
}

// ── Parse session name from binary frame header ───────────────────────────────

/**
 * Parse session name from binary frame v1 header.
 * Returns null if the frame is malformed.
 */
function parseRawFrameSession(data: Buffer): string | null {
  if (data.length < 3 || data[0] !== 0x01) return null;
  const nameLen = data.readUInt16BE(1);
  if (data.length < 3 + nameLen) return null;
  return data.subarray(3, 3 + nameLen).toString('utf8');
}

type PreviewStartPayload = {
  status: number;
  statusText?: string;
  headers: Record<string, string | string[]>;
};

export interface WatchRecentTextRow {
  eventId: string;
  type: 'user.message' | 'assistant.text' | 'session.error';
  text: string;
  ts: number;
}

export interface WatchActiveMainSessionRow {
  name: string;
  project: string;
  state: string;
  agentType: string;
  runtimeType?: string;
  label?: string;
}

type WatchActiveSubSessionRow = {
  name: string;
  parentSession?: string;
  agentType?: string;
  runtimeType?: string;
  label?: string;
};

interface DaemonP2pWorkflowCapabilities {
  daemonId: string;
  capabilities: string[];
  timelineProtocolCapability?: typeof TIMELINE_PROTOCOL_CAPABILITY;
  timelineProtocolRevision?: number;
  buildInfo?: DaemonBuildInfo;
  helloEpoch: number;
  sentAt: number;
  receivedAt: number;
}

type PendingPreviewRequest = {
  /**
   * Owning preview. Added (run 8a975732-23a P0.4.4) so the in-flight HTTP
   * concurrency floor can attribute per-preview counts and so cleanup×relay
   * (P1.4) can map a request to its preview. A pending request IS an in-flight
   * slot: it is created when the proxy decides to forward upstream and removed
   * on any terminal (complete/fail/abort/rejectAllPending).
   */
  previewId: string;
  readable: ReadableStream<Uint8Array>;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  started: boolean;
  terminalOutcome: string | null;
  responseBytes: number;
  /**
   * Decided ONCE at RESPONSE_START via the shared `isStreamingResponse`
   * predicate (run 8a975732-23a P1.1/P1.2). A streaming response is EXEMPT from
   * the cumulative `MAX_RESPONSE_BYTES` cap and instead bounded by the
   * unconsumed-buffer high-watermark below.
   */
  streaming: boolean;
  /**
   * Unconsumed (enqueued-but-not-yet-read) bytes sitting in the ReadableStream's
   * internal queue, tracked explicitly in BYTES (run 8a975732-23a P1.2 — MUST
   * NOT use `controller.desiredSize` as a byte measure). Incremented on enqueue,
   * decremented in the stream's `pull` (one chunk per consumed read). When it
   * exceeds `MAX_PREVIEW_STREAM_BUFFER_BYTES` the stream is deterministically
   * closed.
   */
  unconsumedBytes: number;
  /** FIFO of enqueued chunk byte-sizes, so `pull` can decrement `unconsumedBytes` exactly. */
  chunkSizes: number[];
  timer: ReturnType<typeof setTimeout>;
  timerMode: 'start' | 'idle';
  resolveStart: (payload: PreviewStartPayload) => void;
  rejectStart: (err: Error) => void;
};

type PendingP2pWorkflowRequest = {
  socket: WebSocket;
  timer: ReturnType<typeof setTimeout>;
  requestType: P2pWorkflowMessageType;
  expectedResponseType: P2pWorkflowMessageType;
  createdAt: number;
};

interface SessionGroupCloneOperationContext {
  userId: string;
  sourceMainSessionName: string;
  createdAt: number;
}

interface SessionGroupCloneCachedEvent {
  event: SessionGroupCloneEvent;
  createdAt: number;
}

// ── WS tunnel state ───────────────────────────────────────────────────────────

interface WsTunnelState {
  /** The browser-side WebSocket for this tunnel. */
  browserWs: WebSocket;
  previewId: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  openTimer: ReturnType<typeof setTimeout> | null;
  state: 'pending' | 'active';
  /** Messages queued while waiting for preview.ws.opened. */
  messageQueue: Buffer[];
  queueBytes: number;
  createdAt: number;
}

type PendingHttpTimelineRequest = {
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
  settled?: boolean;
};

type PendingTimelineRequest = {
  socket: WebSocket;
  timer: ReturnType<typeof setTimeout>;
};

type TimelineDataPlaneRoute = 'browser_request' | 'http_request' | 'subscriber_fallback';

type TimelineDataPlaneSendMeta = {
  type: string;
  route: TimelineDataPlaneRoute;
  recipientCount: number;
  requestIdFanoutCount: number;
  httpCallerCount: number;
  broadcastRecipientCount: number;
  chunkCount: number;
};

type TimelineDataPlaneQueueMetrics = {
  backlogAgeMs: number;
  queueDepthAtEnqueue: number;
  queueDepthBeforeDrain: number;
  queuedBehindCount: number;
  attachmentIndex?: number;
  attachmentCount?: number;
  fanoutYieldCount?: number;
};

type TimelineDataPlaneAttachment =
  | {
    origin: 'browser_request';
    requestId?: string;
    socket: WebSocket;
    payload: Record<string, unknown>;
  }
  | {
    origin: 'http_request';
    requestId: string;
    pending: PendingHttpTimelineRequest;
    payload: Record<string, unknown>;
  }
  | {
    origin: 'subscriber_fallback';
    sessionName: string;
    sockets: WebSocket[];
    payload: Record<string, unknown>;
  };

type TimelineDataPlaneJob = {
  meta: TimelineDataPlaneSendMeta;
  attachments: TimelineDataPlaneAttachment[];
  enqueuedAt: number;
  deadlineAt: number;
  queueDepthAtEnqueue: number;
  queuedBehindCount: number;
};

const WATCH_RECENT_TEXT_CAP = 5;
const WATCH_RECENT_TEXT_MAX_CHARS = 160;
const HTTP_TIMELINE_TIMEOUT_MS = 15_000;
const TIMELINE_PENDING_UNICAST_TIMEOUT_MS = 30_000;
// Bumped from 128 → 4096 and 15s → 60s as part of the commit-42dfabec
// regression fix. The original values were tight enough that any short
// burst of timeline.history / page / detail traffic could exceed them on
// weak links, and the bridge error response wasn't marked recoverable so
// `useTimeline` treated it as terminal. With `recoverable: true` (above)
// and a more generous ceiling, we recover automatically instead of
// forcing a manual page refresh.
const DEFAULT_TIMELINE_DATA_PLANE_QUEUE_CAP = 4096;
const DEFAULT_TIMELINE_DATA_PLANE_JOB_DEADLINE_MS = 60_000;
let timelineDataPlaneQueueCap = DEFAULT_TIMELINE_DATA_PLANE_QUEUE_CAP;
let timelineDataPlaneJobDeadlineMs = DEFAULT_TIMELINE_DATA_PLANE_JOB_DEADLINE_MS;
const BRIDGE_TIMELINE_LARGE_PAYLOAD_LOG_BYTES = TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_ENVELOPE;
const BRIDGE_TIMELINE_SLOW_SEND_LOG_MS = 50;
const TIMELINE_REQUEST_TYPES = new Set<string>([
  TIMELINE_MESSAGES.HISTORY_REQUEST,
  TIMELINE_MESSAGES.REPLAY_REQUEST,
  TIMELINE_MESSAGES.PAGE_REQUEST,
  TIMELINE_MESSAGES.DETAIL_REQUEST,
]);
const TIMELINE_RESPONSE_TYPES = new Set<string>([
  TIMELINE_MESSAGES.HISTORY,
  TIMELINE_MESSAGES.REPLAY,
  TIMELINE_MESSAGES.PAGE,
  TIMELINE_MESSAGES.DETAIL,
]);

const TIMELINE_RESPONSE_TYPE_BY_REQUEST = new Map<string, string>([
  [TIMELINE_MESSAGES.HISTORY_REQUEST, TIMELINE_MESSAGES.HISTORY],
  [TIMELINE_MESSAGES.REPLAY_REQUEST, TIMELINE_MESSAGES.REPLAY],
  [TIMELINE_MESSAGES.PAGE_REQUEST, TIMELINE_MESSAGES.PAGE],
  [TIMELINE_MESSAGES.DETAIL_REQUEST, TIMELINE_MESSAGES.DETAIL],
]);

function deferTimelineDataPlaneTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function __setTimelineDataPlaneQueueConfigForTests(config: {
  queueCap?: number;
  deadlineMs?: number;
}): () => void {
  const previous = {
    queueCap: timelineDataPlaneQueueCap,
    deadlineMs: timelineDataPlaneJobDeadlineMs,
  };
  if (typeof config.queueCap === 'number' && Number.isFinite(config.queueCap) && config.queueCap >= 0) {
    timelineDataPlaneQueueCap = Math.trunc(config.queueCap);
  }
  if (typeof config.deadlineMs === 'number' && Number.isFinite(config.deadlineMs) && config.deadlineMs >= 0) {
    timelineDataPlaneJobDeadlineMs = Math.trunc(config.deadlineMs);
  }
  return () => {
    timelineDataPlaneQueueCap = previous.queueCap;
    timelineDataPlaneJobDeadlineMs = previous.deadlineMs;
  };
}

function normalizeRecentText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) return null;
  return normalized.length > WATCH_RECENT_TEXT_MAX_CHARS
    ? `${normalized.slice(0, WATCH_RECENT_TEXT_MAX_CHARS - 1)}…`
    : normalized;
}

function recentTextRowFromTimelineEvent(rawEvent: Record<string, unknown>): WatchRecentTextRow | null {
  const sessionId = rawEvent.sessionId;
  const eventId = rawEvent.eventId;
  const ts = rawEvent.ts;
  const type = rawEvent.type;
  const payload = rawEvent.payload;
  if (typeof sessionId !== 'string' || typeof eventId !== 'string' || typeof ts !== 'number' || typeof type !== 'string') {
    return null;
  }
  if (type !== 'user.message' && type !== 'assistant.text') return null;
  const text = normalizeRecentText((payload as Record<string, unknown> | undefined)?.text);
  if (!text) return null;
  return { eventId, type, text, ts };
}

function mergeRecentTextRows(rows: WatchRecentTextRow[]): WatchRecentTextRow[] {
  const deduped = new Map<string, WatchRecentTextRow>();
  for (const row of rows) deduped.set(row.eventId, row);
  const merged = [...deduped.values()].sort((a, b) => a.ts - b.ts);
  if (merged.length > WATCH_RECENT_TEXT_CAP) {
    return merged.slice(merged.length - WATCH_RECENT_TEXT_CAP);
  }
  return merged;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function timelineResponseRequestIds(msg: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const primary = optionalString(msg.requestId);
  if (primary) ids.push(primary);
  const fanout = Array.isArray(msg.requestIds) ? msg.requestIds : [];
  for (const item of fanout) {
    if (typeof item !== 'string' || item.length === 0 || ids.includes(item)) continue;
    ids.push(item);
  }
  return ids;
}

function timelineResponseForRequestId(msg: Record<string, unknown>, requestId: string): Record<string, unknown> {
  const response: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(msg)) {
    if (key === 'requestIds') continue;
    response[key] = value;
  }
  response.requestId = requestId;
  return response;
}

function withBridgeActualPayloadBytes(msg: Record<string, unknown>): Record<string, unknown> {
  let actualPayloadBytes = 0;
  let next = { ...msg, actualPayloadBytes };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const encodedBytes = Buffer.byteLength(JSON.stringify(next), 'utf8');
    if (encodedBytes === actualPayloadBytes) break;
    actualPayloadBytes = encodedBytes;
    next = { ...msg, actualPayloadBytes };
  }
  return next;
}

function timelineDataPlaneErrorResponse(
  msg: Record<string, unknown>,
  type: string,
  errorReason: string,
): Record<string, unknown> {
  // Tag transient errors as `recoverable: true` so the web `useTimeline`
  // hook actually auto-retries them. Before this flag, any `errorReason`
  // hit `hasExplicitTimelineOutcome` and was treated as terminal; users
  // had to refresh the page to get past a queue-full or deadline blip
  // (regression observed after commit 42dfabec). The allow-list lives in
  // `shared/timeline-history-errors.ts` so server + client never disagree.
  const recoverable = isRecoverableTimelineRequestErrorReason(errorReason);
  return {
    type,
    ...(optionalString(msg.requestId) ? { requestId: optionalString(msg.requestId) } : {}),
    ...(optionalString(msg.sessionName) ? { sessionName: optionalString(msg.sessionName) } : {}),
    status: TIMELINE_RESPONSE_STATUS.ERROR,
    source: TIMELINE_RESPONSE_SOURCES.ERROR,
    errorReason,
    events: type === TIMELINE_MESSAGES.DETAIL ? undefined : [],
    payloadTruncated: false,
    hasMore: false,
    ...(recoverable ? { recoverable: true } : {}),
  };
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

type CloneOptionalStringResult =
  | { ok: true; value: string | null | undefined }
  | { ok: false };

const SESSION_GROUP_CLONE_TERMINAL_STATES = new Set<SessionGroupCloneEvent['state']>(
  SESSION_GROUP_CLONE_STATES.filter((state): state is SessionGroupCloneEvent['state'] => (
    state === 'succeeded'
    || state === 'failed'
    || state === 'cancelled'
    || state === 'cleanup_required'
  )),
);

function readCloneOptionalString(body: Record<string, unknown>, key: string): CloneOptionalStringResult {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return { ok: true, value: undefined };
  const value = body[key];
  if (value === null) return { ok: true, value: null };
  if (typeof value === 'string') return { ok: true, value };
  return { ok: false };
}

function sanitizeCloneWarnings(value: unknown): SessionGroupCloneWarning[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const warnings: SessionGroupCloneWarning[] = [];
  for (const item of value) {
    if (!isPlainRecord(item) || typeof item.code !== 'string') continue;
    warnings.push({
      code: item.code as SessionGroupCloneWarning['code'],
      ...(typeof item.fieldPath === 'string' ? { fieldPath: item.fieldPath } : {}),
      ...(typeof item.sourceSessionName === 'string' ? { sourceSessionName: item.sourceSessionName } : {}),
      ...(typeof item.message === 'string' ? { message: item.message } : {}),
    });
  }
  return warnings.length ? warnings : undefined;
}

function sanitizeCloneSkippedMembers(value: unknown): SessionGroupCloneSkippedMember[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const skippedMembers: SessionGroupCloneSkippedMember[] = [];
  for (const item of value) {
    if (!isPlainRecord(item) || typeof item.sessionName !== 'string' || typeof item.reason !== 'string') continue;
    skippedMembers.push({
      sessionName: item.sessionName,
      reason: item.reason as SessionGroupCloneSkippedMember['reason'],
    });
  }
  return skippedMembers.length ? skippedMembers : undefined;
}

function sanitizeCloneCleanupResources(value: unknown): SessionGroupCloneCleanupResource[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const resources: SessionGroupCloneCleanupResource[] = [];
  for (const item of value) {
    if (!isPlainRecord(item) || typeof item.kind !== 'string' || typeof item.id !== 'string') continue;
    resources.push({
      kind: item.kind as SessionGroupCloneCleanupResource['kind'],
      id: item.id,
      ...(typeof item.sessionName === 'string' ? { sessionName: item.sessionName } : {}),
      ...(typeof item.serverId === 'string' ? { serverId: item.serverId } : {}),
      ...(typeof item.providerId === 'string' ? { providerId: item.providerId } : {}),
      ...(typeof item.retriable === 'boolean' ? { retriable: item.retriable } : {}),
    });
  }
  return resources.length ? resources : undefined;
}

function sanitizeStringRecord(value: unknown): Record<string, string> {
  if (!isPlainRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function sanitizeCopiedSubSessionIds(value: unknown): Array<{ sourceId: string; clonedId: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isPlainRecord(item) || typeof item.sourceId !== 'string' || typeof item.clonedId !== 'string') return [];
    return [{ sourceId: item.sourceId, clonedId: item.clonedId }];
  });
}

function sanitizeCloneResult(value: unknown): SessionGroupCloneResult | undefined {
  if (!isPlainRecord(value)) return undefined;
  const operationId = optionalString(value.operationId);
  const idempotencyKey = optionalString(value.idempotencyKey);
  const sourceMainSession = optionalString(value.sourceMainSession);
  const clonedMainSession = optionalString(value.clonedMainSession);
  const targetProjectName = optionalString(value.targetProjectName);
  const targetProjectSlug = optionalString(value.targetProjectSlug);
  if (!operationId || !idempotencyKey || !sourceMainSession || !clonedMainSession || !targetProjectName || !targetProjectSlug) {
    return undefined;
  }
  return {
    operationId,
    idempotencyKey,
    sourceMainSession,
    clonedMainSession,
    targetProjectName,
    targetProjectSlug,
    sessionNameMap: sanitizeStringRecord(value.sessionNameMap),
    copiedSubSessionIds: sanitizeCopiedSubSessionIds(value.copiedSubSessionIds),
    skippedMembers: sanitizeCloneSkippedMembers(value.skippedMembers) ?? [],
    skippedCronJobs: optionalNumber(value.skippedCronJobs) ?? 0,
    skippedOrchestrationRuns: optionalNumber(value.skippedOrchestrationRuns) ?? 0,
    warnings: sanitizeCloneWarnings(value.warnings) ?? [],
  };
}

function sanitizeSessionGroupCloneEvent(msg: Record<string, unknown>): SessionGroupCloneEvent | null {
  const operationId = optionalString(msg.operationId);
  const idempotencyKey = optionalString(msg.idempotencyKey);
  const state = optionalString(msg.state);
  if (!operationId || !idempotencyKey || !state || !SESSION_GROUP_CLONE_STATES.includes(state as never)) {
    return null;
  }
  const event: SessionGroupCloneEvent = {
    type: SESSION_GROUP_CLONE_MSG.EVENT,
    operationId,
    idempotencyKey,
    state: state as SessionGroupCloneEvent['state'],
  };
  const sourceMainSessionName = optionalString(msg.sourceMainSessionName);
  if (sourceMainSessionName) event.sourceMainSessionName = sourceMainSessionName;
  const clonedMainSessionName = optionalString(msg.clonedMainSessionName);
  if (clonedMainSessionName) event.clonedMainSessionName = clonedMainSessionName;
  const totalSubSessions = optionalNumber(msg.totalSubSessions);
  if (totalSubSessions !== undefined) event.totalSubSessions = totalSubSessions;
  const subSessionsCreated = optionalNumber(msg.subSessionsCreated);
  if (subSessionsCreated !== undefined) event.subSessionsCreated = subSessionsCreated;
  const skippedMembers = sanitizeCloneSkippedMembers(msg.skippedMembers);
  if (skippedMembers) event.skippedMembers = skippedMembers;
  const skippedCronJobs = optionalNumber(msg.skippedCronJobs);
  if (skippedCronJobs !== undefined) event.skippedCronJobs = skippedCronJobs;
  const skippedOrchestrationRuns = optionalNumber(msg.skippedOrchestrationRuns);
  if (skippedOrchestrationRuns !== undefined) event.skippedOrchestrationRuns = skippedOrchestrationRuns;
  const warnings = sanitizeCloneWarnings(msg.warnings);
  if (warnings) event.warnings = warnings;
  const errorCode = optionalString(msg.errorCode);
  if (errorCode) event.errorCode = errorCode as SessionGroupCloneEvent['errorCode'];
  const cleanupRequired = optionalBoolean(msg.cleanupRequired);
  if (cleanupRequired !== undefined) event.cleanupRequired = cleanupRequired;
  const cleanupResources = sanitizeCloneCleanupResources(msg.cleanupResources);
  if (cleanupResources) event.cleanupResources = cleanupResources;
  const result = sanitizeCloneResult(msg.result);
  if (result) event.result = result;
  return event;
}

function parseStoredP2pConfig(raw: string | null): P2pSavedConfig | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isP2pSavedConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function getUserP2pConfigForRoot(
  db: Database,
  userId: string,
  serverId: string,
  rootSessionName: string,
): Promise<{ key: string; config: P2pSavedConfig } | null> {
  const keys = [
    p2pSessionConfigPrefKey(rootSessionName, serverId),
    ...p2pSessionConfigLegacyPrefKeys(rootSessionName),
  ];
  for (const key of keys) {
    const config = parseStoredP2pConfig(await getUserPref(db, userId, key));
    if (config) return { key, config };
  }
  return null;
}

function sourceProjectSlugFromMainSessionName(sessionName: string | undefined): string | null {
  if (!sessionName) return null;
  const match = sessionName.match(/^deck_(.+)_brain$/);
  return match?.[1] ?? null;
}

function numericCount(row: Record<string, unknown> | null): number {
  const value = row?.count;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function mergeSkippedScheduledWorkCounts(
  event: SessionGroupCloneEvent,
  counts: { skippedCronJobs: number; skippedOrchestrationRuns: number },
): SessionGroupCloneEvent {
  const skippedCronJobs = Math.max(event.skippedCronJobs ?? event.result?.skippedCronJobs ?? 0, counts.skippedCronJobs);
  const skippedOrchestrationRuns = Math.max(
    event.skippedOrchestrationRuns ?? event.result?.skippedOrchestrationRuns ?? 0,
    counts.skippedOrchestrationRuns,
  );
  return {
    ...event,
    skippedCronJobs,
    skippedOrchestrationRuns,
    ...(event.result ? {
      result: {
        ...event.result,
        skippedCronJobs,
        skippedOrchestrationRuns,
      },
    } : {}),
  };
}

class SessionGroupCloneServerP2pError extends Error {
  readonly cleanupResources: SessionGroupCloneCleanupResource[];

  constructor(message: string, cleanupResources: SessionGroupCloneCleanupResource[]) {
    super(message);
    this.name = 'SessionGroupCloneServerP2pError';
    this.cleanupResources = cleanupResources;
  }
}

async function writeSessionGroupCloneAudit(
  db: Database,
  entry: {
    userId?: string;
    serverId: string;
    action: string;
    details: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await db.execute(
      'INSERT INTO audit_log (id, user_id, server_id, action, details, ip, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [
        sha256Hex(`${entry.serverId}:${entry.userId ?? 'unknown'}:${entry.action}:${Date.now()}:${Math.random()}`).slice(0, 32),
        entry.userId ?? null,
        entry.serverId,
        entry.action,
        JSON.stringify(entry.details),
        null,
        Date.now(),
      ],
    );
  } catch (err) {
    logger.error({ action: entry.action, err }, 'Audit log write failed');
  }
}

// ── Inflight command bookkeeping (ack reliability) ───────────────────────

type InflightState = 'buffered' | 'dispatched' | 'acked';

interface InflightCommand {
  commandId: string;
  sessionName: string;
  browser: WebSocket;
  rawPayload: string;          // the original session.send JSON as received from browser
  state: InflightState;
  sentAt: number;              // when the inflight was created (dispatch or buffer)
  dispatchAttempts: number;    // daemon sends attempted by the bridge
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  share?: {
    userId: string;
    target: ShareTarget;
    requiredRole: 'participant';
  };
}

type FsPendingRouteKind =
  | 'fs.ls'
  | 'fs.read'
  | 'fs.git_status'
  | 'fs.git_diff'
  | 'file.search'
  | 'fs.write';

interface PendingFsRoute {
  socket: WebSocket;
  timer: ReturnType<typeof setTimeout>;
  kind: FsPendingRouteKind;
  requestId: string;
  path: string;
}

type PendingFsRouteMap = Map<string, PendingFsRoute>;

// Periodic cleanup interval handle (module-level, shared across all bridge instances)
let cleanupSweepHandle: ReturnType<typeof setInterval> | null = null;
let shareClockNow = (): number => Date.now();

export function __setShareBridgeClockForTests(clock: (() => number) | null): void {
  shareClockNow = clock ?? (() => Date.now());
}

// ── WsBridge ─────────────────────────────────────────────────────────────────

export class WsBridge {
  private static instances = new Map<string, WsBridge>();

  private daemonWs: WebSocket | null = null;
  private authenticated = false;
  private daemonVersion: string | null = null;
  private daemonUpgradeCoordinator = new DaemonUpgradeCoordinator();
  private browserSockets = new Set<WebSocket>();
  private mobileSockets = new Set<WebSocket>();
  private queue: string[] = [];
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Audit fix (78-server reconnect-storm investigation, 2026-05-11) —
   * holds the in-flight auth promise so concurrent message handlers
   * don't race against the DB lookup.
   *
   * The daemon sends `auth` immediately followed by `daemon.hello` on
   * every WS connect (`server-link.ts:201-202`). With the previous
   * `async` message handler, both messages started executing in
   * parallel; the `auth` handler awaited `db.queryOne(...)` for the
   * token check, and while that await was pending the `daemon.hello`
   * handler observed `this.authenticated === false` and
   * `msg.type !== 'auth'` → `ws.close(4001, 'auth_required')`. The
   * server logged "Daemon authenticated" (success path) AFTER the
   * close, but the daemon saw the 4001 first and reconnected — every
   * ~500 ms — producing the auth-storm we found in production logs.
   *
   * Fix: every message handler awaits this promise before evaluating
   * `this.authenticated`, so the `daemon.hello` cannot run until the
   * auth check has settled.
   */
  private authPromise: Promise<void> | null = null;
  private browserRateLimiter = new MemoryRateLimiter();

  /** browser socket → session name → raw-enabled flag */
  private browserSubscriptions = new Map<WebSocket, Map<string, boolean>>();

  /** browser socket → set of subscribed transport session IDs */
  private transportSubscriptions = new Map<WebSocket, Set<string>>();
  private transportSubscriptionRevisions = new Map<WebSocket, Map<string, number>>();

  /** browser socket → userId (for session ownership checks) */
  private browserUserIds = new Map<WebSocket, string>();
  /** browser socket → live share-scoped authorization state */
  private browserShareStates = new Map<WebSocket, ShareScopedSocketState>();
  private shareCoverageResolver: ShareCoverageResolver = resolveShareCoverageFromDb;
  private shareExpirySweepTimer: ReturnType<typeof setInterval> | null = null;
  private sessionRuntimeTypes = new Map<string, 'process' | 'transport' | 'unknown'>();
  private activeDispatchIds = new Map<string, string>();

  /** db reference for session ownership checks */
  private db: Database | null = null;

  /** Cached provider connection status — pushed to browsers on connect, persisted to DB. */
  private providerStatus = new Map<string, boolean>();
  /** Cached advanced P2P capabilities for the current authenticated daemon socket. */
  private daemonP2pWorkflowCapabilities: DaemonP2pWorkflowCapabilities | null = null;
  /** idempotencyKey → initiating user/source, used to copy user-scoped P2P preferences after daemon success. */
  private sessionGroupCloneContexts = new Map<string, SessionGroupCloneOperationContext>();
  /**
   * idempotencyKey → latest daemon operation event.
   * This server-side idempotency cache starts after the daemon has emitted an
   * operation event, because the daemon owns operationId creation.
   */
  private sessionGroupCloneEvents = new Map<string, SessionGroupCloneCachedEvent>();
  /** Cached remote sessions from providers — pushed to browsers on connect, persisted to DB. */
  private providerRemoteSessions = new Map<string, unknown[]>();

  /** Per-request FS/search pending maps used to single-cast daemon responses. */
  private pendingFsRequests: PendingFsRouteMap = new Map();
  private pendingFsReadRequests: PendingFsRouteMap = new Map();
  private pendingFsGitStatusRequests: PendingFsRouteMap = new Map();
  private pendingFsGitDiffRequests: PendingFsRouteMap = new Map();
  private pendingFileSearchRequests: PendingFsRouteMap = new Map();
  private pendingFsWriteRequests: PendingFsRouteMap = new Map();

  /** Per-request timeline pending map — routes responses via requestId unicast. */
  private pendingTimelineRequests = new Map<string, PendingTimelineRequest>();

  /** Per-request P2P workflow pending map — routes request-scoped responses via requestId unicast. */
  private pendingP2pWorkflowRequests = new Map<string, PendingP2pWorkflowRequest>();

  /** Per-request memory management pending map — routes sensitive admin responses via requestId unicast. */
  private pendingMemoryManagementRequests = new Map<string, { socket: WebSocket; timer: ReturnType<typeof setTimeout> }>();

  /** Per-request HTTP timeline/history relay pending map. */
  private pendingHttpTimelineRequests = new Map<string, PendingHttpTimelineRequest>();
  private pendingRecentTextBackfills = new Map<string, Promise<WatchRecentTextRow[]>>();

  private timelineDataPlaneQueue: TimelineDataPlaneJob[] = [];
  private timelineDataPlaneScheduled = false;
  private timelineDataPlaneActive = false;

  /** Lightweight per-session hot cache for Watch first-paint text. */
  private recentTextBySession = new Map<string, WatchRecentTextRow[]>();

  /** Latest daemon-owned active main-session snapshot for watch list responses. */
  private activeMainSessions = new Map<string, WatchActiveMainSessionRow>();
  /** Latest daemon-owned active sub-session snapshot for push title resolution. */
  private activeSubSessions = new Map<string, WatchActiveSubSessionRow>();
  private hasActiveMainSessionSnapshot = false;

  /**
   * File transfer correlation: requestId → { resolve, reject, timer }.
   * Used by HTTP upload/download handlers to await daemon responses.
   */
  private pendingFileTransfers = new Map<string, {
    resolve: (msg: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    onProgress?: (msg: Record<string, unknown>) => void;
  }>();

  /**
   * Cross-server projection source resolution correlation: requestId →
   * pending resolver. Populated by `sendMemorySourcesRequest()` (the
   * `/api/memory/sources` HTTP route's helper) and drained when the daemon
   * replies with `MEMORY_WS.GET_SOURCES_RESPONSE`. See
   * openspec/changes/memory-source-server-routing.
   */
  private pendingMemorySourcesRequests = new Map<string, {
    resolve: (msg: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private pendingPreviewRequests = new Map<string, PendingPreviewRequest>();

  /** Active preview WS tunnels: wsId → WsTunnelState */
  private previewWsTunnels = new Map<string, WsTunnelState>();

  /**
   * Deferred preview WS upgrades awaiting the upstream subprotocol (run
   * 8a975732-23a P1.5.1). The HTTP upgrade handshake is held open until the
   * daemon reports the upstream-negotiated subprotocol via `WS_OPENED.protocol`,
   * so the proxy can echo it in the `Sec-WebSocket-Protocol` handshake response
   * and the browser's `WebSocket.protocol` reads the correct value end-to-end.
   * On `WS_OPENED` we call `completeUpgrade(protocol)` to finish the handshake.
   */
  private pendingPreviewWsUpgrades = new Map<string, {
    previewId: string;
    /** Completes the held-open handshake selecting `protocol`; resolves the upgraded browser socket, null on failure. */
    completeUpgrade: (protocol: string | undefined) => Promise<WebSocket | null>;
    /** Open timeout guarding against a daemon that never replies WS_OPENED/WS_ERROR. */
    openTimer: ReturnType<typeof setTimeout>;
  }>();

  /**
   * Per-session subscription reference counts derived from browser sockets.
   * totalRefs tracks active browser subscribers; rawRefs tracks raw-enabled subscribers.
   */
  private daemonSessionRefs = new Map<string, { totalRefs: number; rawRefs: number }>();

  /**
   * browser socket → session name → monotonically increasing intent revision.
   * Used to ignore stale async subscribe callbacks when a later subscribe/unsubscribe wins.
   */
  private terminalSubscriptionRevisions = new Map<WebSocket, Map<string, number>>();

  /**
   * Per-(session, browser) forwarding queues.
   * Used for both terminal_update (snapshot JSON) and binary raw frames.
   * session → browser → queue
   */
  private terminalQueues = new Map<string, Map<WebSocket, TerminalForwardQueue>>();

  // ── Command ack reliability (see shared/ack-protocol.ts) ────────────────
  /** commandId → inflight state; sticky-pod makes this authoritative per daemon. */
  private inflightCommands = new Map<string, InflightCommand>();
  /** LRU-ish dedup for replayed acks from daemon outbox flushes. */
  private seenCommandAcks = new Map<string, number>();
  /** Set while the daemon WS is closed but we're still inside the grace window. */
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  /** True iff we have broadcast `daemon.offline` for the current outage (resets on online). */
  private daemonOfflineAnnounced = false;
  /** Periodic GC for inflightCommands + seenCommandAcks. */
  private ackHousekeepingTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(private serverId: string) {
    // Start periodic cleanup sweep (shared across all bridge instances)
    if (!cleanupSweepHandle) {
      cleanupSweepHandle = setInterval(() => {
        for (const bridge of WsBridge.instances.values()) {
          bridge.sweepStaleTunnels();
        }
      }, 60_000);
      // Don't keep the process alive just for cleanup
      cleanupSweepHandle.unref?.();
    }
    // Tell the registry which previews still have a live relay so its idle
    // cleanup skips them (run 8a975732-23a P1.4). Installed once; routes to the
    // owning bridge instance by serverId. Idempotent re-install is harmless.
    setPreviewActiveRelayHook((serverId, previewId) =>
      WsBridge.instances.get(serverId)?.hasActivePreviewRelay(previewId) ?? false,
    );
    // When the registry evicts a preview (idle or hard-lifetime), tear down any
    // relay that survived the race — abort pending HTTP relays + close WS
    // tunnels deterministically (P1.4.2). Routes to the owning bridge instance.
    setPreviewEvictedHook((serverId, previewId) =>
      WsBridge.instances.get(serverId)?.terminatePreviewRelaysForPreview(previewId),
    );
    this.shareExpirySweepTimer = setInterval(() => {
      void this.sweepShareSockets();
    }, 30_000);
    this.shareExpirySweepTimer.unref?.();
  }

  static get(serverId: string): WsBridge {
    let bridge = WsBridge.instances.get(serverId);
    if (!bridge) {
      bridge = new WsBridge(serverId);
      WsBridge.instances.set(serverId, bridge);
    }
    return bridge;
  }

  static getAll(): Map<string, WsBridge> {
    return WsBridge.instances;
  }

  /**
   * Generic browser pub/sub: tell every browser viewing `serverId` that a
   * server-scoped resource (identified by `topic`) changed, so open views can
   * refetch over HTTP instead of polling. No-op when no bridge/browsers exist on
   * this pod — pod-sticky routing guarantees the daemon's bridge (and thus its
   * browser viewers) live on the pod that handled the serverId-scoped request,
   * so the publisher and subscribers are always co-located.
   */
  static publishResourceChanged(serverId: string, topic: ResourceTopic, extra?: Record<string, unknown>): void {
    const bridge = WsBridge.instances.get(serverId);
    if (!bridge) return;
    bridge.broadcastToBrowsers(JSON.stringify({ type: RESOURCE_EVENT_MSG.CHANGED, topic, serverId, ...extra }));
  }

  private pendingFsRouteMap(kind: FsPendingRouteKind): PendingFsRouteMap {
    switch (kind) {
      case 'fs.ls':
        return this.pendingFsRequests;
      case 'fs.read':
        return this.pendingFsReadRequests;
      case 'fs.git_status':
        return this.pendingFsGitStatusRequests;
      case 'fs.git_diff':
        return this.pendingFsGitDiffRequests;
      case 'file.search':
        return this.pendingFileSearchRequests;
      case 'fs.write':
        return this.pendingFsWriteRequests;
    }
  }

  private registerPendingFsRoute(kind: FsPendingRouteKind, ws: WebSocket, msg: Record<string, unknown>): void {
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
    if (!requestId) return;
    const map = this.pendingFsRouteMap(kind);
    const previous = map.get(requestId);
    if (previous) {
      clearTimeout(previous.timer);
      logger.warn({ kind, requestId, serverId: this.serverId }, 'WsBridge: duplicate FS request id replaced');
    }
    const path = typeof msg.path === 'string' ? msg.path : '';
    const timer = setTimeout(() => this.timeoutPendingFsRoute(kind, requestId), FS_PENDING_UNICAST_TIMEOUT_MS);
    timer.unref?.();
    map.set(requestId, { socket: ws, timer, kind, requestId, path });
  }

  private timeoutPendingFsRoute(kind: FsPendingRouteKind, requestId: string): void {
    const map = this.pendingFsRouteMap(kind);
    const pending = map.get(requestId);
    if (!pending) return;
    map.delete(requestId);
    incrementCounter('ws_bridge_fs_pending_timeout', { kind });
    safeSend(pending.socket, JSON.stringify(this.buildPendingFsTimeoutResponse(pending)));
  }

  private buildPendingFsTimeoutResponse(pending: PendingFsRoute): Record<string, unknown> {
    const error = FS_READ_ERROR_CODES.PREVIEW_BRIDGE_TIMEOUT;
    switch (pending.kind) {
      case 'fs.ls':
        return { type: 'fs.ls_response', requestId: pending.requestId, path: pending.path, status: 'error', error };
      case 'fs.read':
        return { type: 'fs.read_response', requestId: pending.requestId, path: pending.path, status: 'error', error };
      case 'fs.git_status':
        return { type: 'fs.git_status_response', requestId: pending.requestId, path: pending.path, status: 'error', files: [], error };
      case 'fs.git_diff':
        return { type: 'fs.git_diff_response', requestId: pending.requestId, path: pending.path, status: 'error', error };
      case 'file.search':
        return { type: 'file.search_response', requestId: pending.requestId, results: [], error };
      case 'fs.write':
        return { type: 'fs.write_response', requestId: pending.requestId, path: pending.path, status: 'error', error };
    }
  }

  private forwardPendingFsRoute(kind: FsPendingRouteKind, requestId: string | undefined, msg: Record<string, unknown>): boolean {
    if (!requestId) return false;
    const map = this.pendingFsRouteMap(kind);
    const pending = map.get(requestId);
    if (!pending) {
      incrementCounter('ws_bridge_fs_unrouted_response', { kind });
      return false;
    }
    clearTimeout(pending.timer);
    map.delete(requestId);
    safeSend(pending.socket, JSON.stringify(msg));
    return true;
  }

  private clearPendingFsRoutesForSocket(ws: WebSocket): void {
    const maps = [
      this.pendingFsRequests,
      this.pendingFsReadRequests,
      this.pendingFsGitStatusRequests,
      this.pendingFsGitDiffRequests,
      this.pendingFileSearchRequests,
      this.pendingFsWriteRequests,
    ];
    for (const map of maps) {
      for (const [requestId, pending] of map) {
        if (pending.socket !== ws) continue;
        clearTimeout(pending.timer);
        map.delete(requestId);
      }
    }
  }

  private registerPendingTimelineRequest(ws: WebSocket, msg: Record<string, unknown>): void {
    const requestId = optionalString(msg.requestId);
    if (!requestId) return;
    const previous = this.pendingTimelineRequests.get(requestId);
    if (previous) {
      clearTimeout(previous.timer);
      logger.warn({ requestId, serverId: this.serverId, type: msg.type }, 'WsBridge: duplicate timeline request id replaced');
    }
    const timer = setTimeout(() => this.pendingTimelineRequests.delete(requestId), TIMELINE_PENDING_UNICAST_TIMEOUT_MS);
    timer.unref?.();
    this.pendingTimelineRequests.set(requestId, { socket: ws, timer });
  }

  private sendTimelineRequestError(
    ws: WebSocket,
    msg: Record<string, unknown>,
    errorReason: string,
  ): void {
    const responseType = typeof msg.type === 'string'
      ? TIMELINE_RESPONSE_TYPE_BY_REQUEST.get(msg.type)
      : undefined;
    if (!responseType) return;
    safeSend(ws, JSON.stringify(withBridgeActualPayloadBytes(
      timelineDataPlaneErrorResponse(msg, responseType, errorReason),
    )));
  }

  private async verifyTimelineBrowserRequest(ws: WebSocket, msg: Record<string, unknown>): Promise<boolean> {
    const sessionName = optionalString(msg.sessionName);
    if (!sessionName) {
      this.sendTimelineRequestError(ws, msg, TIMELINE_REQUEST_ERROR_REASONS.MALFORMED_REQUEST);
      return false;
    }
    const allowed = await this.verifySessionOwnership(sessionName);
    if (!allowed) {
      logger.warn({ serverId: this.serverId, sessionName, type: msg.type }, 'timeline request: session not owned by this server — rejected');
      this.sendTimelineRequestError(ws, msg, TIMELINE_REQUEST_ERROR_REASONS.REQUEST_UNAUTHORIZED);
      return false;
    }
    return true;
  }

  private settlePendingHttpTimelineRequest(
    requestId: string | null,
    pending: PendingHttpTimelineRequest,
    fn: () => void,
  ): void {
    if (pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    if (pending.abortSignal && pending.abortHandler) {
      pending.abortSignal.removeEventListener('abort', pending.abortHandler);
      pending.abortHandler = undefined;
    }
    if (requestId) this.pendingHttpTimelineRequests.delete(requestId);
    fn();
  }

  private scheduleTimelineDataPlaneDrain(): void {
    if (this.timelineDataPlaneScheduled || this.timelineDataPlaneActive) return;
    this.timelineDataPlaneScheduled = true;
    setImmediate(() => this.drainTimelineDataPlaneQueue());
  }

  private finishTimelineDataPlaneJob(): void {
    this.timelineDataPlaneActive = false;
    if (this.timelineDataPlaneQueue.length > 0) this.scheduleTimelineDataPlaneDrain();
  }

  private enqueueTimelineDataPlaneJob(
    meta: TimelineDataPlaneSendMeta,
    attachments: TimelineDataPlaneAttachment[],
    options: {
      deadlineMs?: number;
    } = {},
  ): boolean {
    if (attachments.length === 0) return true;
    const queuedBehindCount = this.timelineDataPlaneQueue.length;
    if (queuedBehindCount >= timelineDataPlaneQueueCap) {
      incrementCounter('ws_bridge_timeline_data_plane_queue_full', {
        type: meta.type,
        route: meta.route,
      });
      logger.warn({
        serverId: this.serverId,
        type: meta.type,
        route: meta.route,
        queueDepth: queuedBehindCount,
        queueCap: timelineDataPlaneQueueCap,
      }, 'WsBridge timeline data-plane queue full');
      return false;
    }
    const queueDepthAtEnqueue = queuedBehindCount + 1;
    const enqueuedAt = performance.now();
    this.timelineDataPlaneQueue.push({
      meta,
      attachments,
      enqueuedAt,
      deadlineAt: enqueuedAt + (options.deadlineMs ?? timelineDataPlaneJobDeadlineMs),
      queueDepthAtEnqueue,
      queuedBehindCount,
    });
    incrementCounter('ws_bridge_timeline_data_plane_enqueue', {
      type: meta.type,
      route: meta.route,
      backlog: queuedBehindCount > 0 ? 'queued' : 'empty',
    });
    this.scheduleTimelineDataPlaneDrain();
    return true;
  }

  private isTimelineDataPlaneJobCanceled(job: TimelineDataPlaneJob): boolean {
    return job.attachments.every((attachment) => this.isTimelineDataPlaneAttachmentCanceled(attachment));
  }

  private isTimelineDataPlaneAttachmentCanceled(attachment: TimelineDataPlaneAttachment): boolean {
    if (attachment.origin === 'browser_request') {
      return attachment.socket.readyState !== WebSocket.OPEN;
    }
    if (attachment.origin === 'http_request') {
      return attachment.pending.settled === true;
    }
    return attachment.sockets.every((socket) => socket.readyState !== WebSocket.OPEN);
  }

  private handleTimelineDataPlaneJobDeadline(job: TimelineDataPlaneJob): void {
    const { meta } = job;
    for (const attachment of job.attachments) {
      if (this.isTimelineDataPlaneAttachmentCanceled(attachment)) continue;
      if (attachment.origin === 'browser_request') {
        if (attachment.socket.readyState === WebSocket.OPEN) {
          safeSend(attachment.socket, JSON.stringify(withBridgeActualPayloadBytes(
            timelineDataPlaneErrorResponse(attachment.payload, meta.type, TIMELINE_REQUEST_ERROR_REASONS.DEADLINE_EXCEEDED),
          )));
        }
        continue;
      }
      if (attachment.origin === 'http_request') {
        this.settlePendingHttpTimelineRequest(null, attachment.pending, () => {
          attachment.pending.reject(new Error(TIMELINE_REQUEST_ERROR_REASONS.DEADLINE_EXCEEDED));
        });
      }
    }
  }

  private async runTimelineDataPlaneJob(job: TimelineDataPlaneJob, queue: TimelineDataPlaneQueueMetrics): Promise<void> {
    const { meta } = job;
    const canceledCount = job.attachments.filter((attachment) => this.isTimelineDataPlaneAttachmentCanceled(attachment)).length;
    if (canceledCount > 0) {
      incrementCounter('ws_bridge_timeline_data_plane_canceled', {
        type: job.meta.type,
        route: job.meta.route,
      });
    }
    const attachments = job.attachments.filter((attachment) => !this.isTimelineDataPlaneAttachmentCanceled(attachment));
    if (attachments.length === 0) return;
    let fanoutYieldCount = 0;
    for (let index = 0; index < attachments.length; index += 1) {
      if (index > 0) {
        fanoutYieldCount += 1;
        await deferTimelineDataPlaneTurn();
      }
      const attachment = attachments[index]!;
      if (this.isTimelineDataPlaneAttachmentCanceled(attachment)) {
        incrementCounter('ws_bridge_timeline_data_plane_canceled', {
          type: job.meta.type,
          route: job.meta.route,
        });
        continue;
      }
      await this.runTimelineDataPlaneAttachment(attachment, meta, {
        ...queue,
        attachmentIndex: index + 1,
        attachmentCount: attachments.length,
        fanoutYieldCount,
      });
    }
  }

  private runTimelineDataPlaneAttachment(
    attachment: TimelineDataPlaneAttachment,
    meta: TimelineDataPlaneSendMeta,
    queue: TimelineDataPlaneQueueMetrics,
  ): void | Promise<void> {
    if (attachment.origin === 'http_request') {
      if (attachment.pending.settled) return;
      const measured = withBridgeActualPayloadBytes(attachment.payload);
      this.settlePendingHttpTimelineRequest(null, attachment.pending, () => attachment.pending.resolve(measured));
      this.logTimelineDataPlaneSend(meta, {
        jsonBytes: optionalNumber(measured.actualPayloadBytes),
        stringifyMs: 0,
        sendWaitMs: 0,
        queue,
      });
      return;
    }

    if (attachment.origin === 'browser_request') {
      const serialized = this.stringifyTimelineDataPlaneResponse(attachment.payload, meta);
      if (!serialized) {
        if (attachment.socket.readyState === WebSocket.OPEN) {
          safeSend(attachment.socket, JSON.stringify(withBridgeActualPayloadBytes(
            timelineDataPlaneErrorResponse(attachment.payload, meta.type, TIMELINE_REQUEST_ERROR_REASONS.INTERNAL_ERROR),
          )));
        }
        return;
      }
      const sendStart = performance.now();
      return new Promise<void>((resolve) => {
        safeSend(attachment.socket, serialized.json, (err) => {
          this.logTimelineDataPlaneSend(meta, {
            jsonBytes: serialized.jsonBytes,
            stringifyMs: serialized.stringifyMs,
            sendWaitMs: performance.now() - sendStart,
            failed: !!err,
            queue,
          });
          resolve();
        });
      });
    }

    const serialized = this.stringifyTimelineDataPlaneResponse(attachment.payload, meta);
    if (!serialized) return;
    const sockets = attachment.sockets.filter((socket) => socket.readyState === WebSocket.OPEN);
    if (sockets.length === 0) return;
    const sendStart = performance.now();
    let pendingCallbacks = sockets.length;
    let failed = false;
    return new Promise<void>((resolve) => {
      for (const socket of sockets) {
        safeSend(socket, serialized.json, (err) => {
          pendingCallbacks -= 1;
          failed = failed || !!err;
          if (pendingCallbacks !== 0) return;
          this.logTimelineDataPlaneSend(meta, {
            jsonBytes: serialized.jsonBytes,
            stringifyMs: serialized.stringifyMs,
            sendWaitMs: performance.now() - sendStart,
            failed,
            queue,
          });
          resolve();
        });
      }
    });
  }

  private drainTimelineDataPlaneQueue(): void {
    this.timelineDataPlaneScheduled = false;
    if (this.timelineDataPlaneActive) return;
    const queueDepthBeforeDrain = this.timelineDataPlaneQueue.length;
    const job = this.timelineDataPlaneQueue.shift();
    if (!job) return;
    this.timelineDataPlaneActive = true;
    const queueMetrics: TimelineDataPlaneQueueMetrics = {
      backlogAgeMs: performance.now() - job.enqueuedAt,
      queueDepthAtEnqueue: job.queueDepthAtEnqueue,
      queueDepthBeforeDrain,
      queuedBehindCount: job.queuedBehindCount,
    };
    if (this.isTimelineDataPlaneJobCanceled(job)) {
      incrementCounter('ws_bridge_timeline_data_plane_canceled', {
        type: job.meta.type,
        route: job.meta.route,
      });
      this.finishTimelineDataPlaneJob();
      return;
    }
    if (performance.now() > job.deadlineAt) {
      incrementCounter('ws_bridge_timeline_data_plane_deadline_exceeded', {
        type: job.meta.type,
        route: job.meta.route,
      });
      logger.warn({
        serverId: this.serverId,
        type: job.meta.type,
        route: job.meta.route,
        backlogAgeMs: queueMetrics.backlogAgeMs,
        deadlineMs: Math.max(0, job.deadlineAt - job.enqueuedAt),
      }, 'WsBridge timeline data-plane deadline exceeded');
      this.handleTimelineDataPlaneJobDeadline(job);
      this.finishTimelineDataPlaneJob();
      return;
    }
    void Promise.resolve()
      .then(() => this.runTimelineDataPlaneJob(job, queueMetrics))
      .catch((err) => {
        logger.warn({ serverId: this.serverId, err, type: job.meta.type, route: job.meta.route }, 'WsBridge timeline data-plane delivery failed');
      })
      .finally(() => this.finishTimelineDataPlaneJob());
  }

  private stringifyTimelineDataPlaneResponse(
    msg: Record<string, unknown>,
    meta: TimelineDataPlaneSendMeta,
  ): { json: string; jsonBytes: number; stringifyMs: number } | null {
    const stringifyStart = performance.now();
    try {
      const measured = withBridgeActualPayloadBytes(msg);
      const json = JSON.stringify(measured);
      const stringifyMs = performance.now() - stringifyStart;
      const jsonBytes = Buffer.byteLength(json, 'utf8');
      return { json, jsonBytes, stringifyMs };
    } catch (err) {
      incrementCounter('ws_bridge_timeline_data_plane_serialize_error', { type: meta.type, route: meta.route });
      logger.warn({ serverId: this.serverId, err, type: meta.type, route: meta.route }, 'WsBridge failed to serialize timeline data-plane response');
      return null;
    }
  }

  private logTimelineDataPlaneSend(
    meta: TimelineDataPlaneSendMeta,
    timing: {
      jsonBytes?: number;
      stringifyMs?: number;
      sendWaitMs?: number;
      failed?: boolean;
      queue?: TimelineDataPlaneQueueMetrics;
    },
  ): void {
    incrementCounter('ws_bridge_timeline_data_plane_send', {
      type: meta.type,
      route: meta.route,
      result: timing.failed ? 'failed' : 'ok',
    });

    const jsonBytes = timing.jsonBytes ?? 0;
    const stringifyMs = timing.stringifyMs ?? 0;
    const sendWaitMs = timing.sendWaitMs ?? 0;
    const shouldLog = timing.failed
      || jsonBytes >= BRIDGE_TIMELINE_LARGE_PAYLOAD_LOG_BYTES
      || stringifyMs >= BRIDGE_TIMELINE_SLOW_SEND_LOG_MS
      || sendWaitMs >= BRIDGE_TIMELINE_SLOW_SEND_LOG_MS;
    if (!shouldLog) return;

    const payload = {
      serverId: this.serverId,
      type: meta.type,
      route: meta.route,
      dataPlaneClass: 'timeline',
      jsonBytes: timing.jsonBytes,
      stringifyMs: timing.stringifyMs,
      sendWaitMs: timing.sendWaitMs,
      recipientCount: meta.recipientCount,
      requestIdFanoutCount: meta.requestIdFanoutCount,
      httpCallerCount: meta.httpCallerCount,
      broadcastRecipientCount: meta.broadcastRecipientCount,
      chunkCount: meta.chunkCount,
      backlogAgeMs: timing.queue?.backlogAgeMs,
      queueDepthAtEnqueue: timing.queue?.queueDepthAtEnqueue,
      queueDepthBeforeDrain: timing.queue?.queueDepthBeforeDrain,
      queuedBehindCount: timing.queue?.queuedBehindCount,
      attachmentIndex: timing.queue?.attachmentIndex,
      attachmentCount: timing.queue?.attachmentCount,
      fanoutYieldCount: timing.queue?.fanoutYieldCount,
    };
    if (timing.failed) logger.warn(payload, 'WsBridge timeline data-plane send failed');
    else logger.info(payload, 'WsBridge timeline data-plane send');
  }

  private rejectTimelineDataPlaneAttachmentsQueueFull(
    attachments: TimelineDataPlaneAttachment[],
    meta: TimelineDataPlaneSendMeta,
  ): void {
    for (const attachment of attachments) {
      if (attachment.origin === 'browser_request') {
        if (attachment.socket.readyState === WebSocket.OPEN) {
          safeSend(attachment.socket, JSON.stringify(withBridgeActualPayloadBytes(
            timelineDataPlaneErrorResponse(attachment.payload, meta.type, TIMELINE_REQUEST_ERROR_REASONS.QUEUE_FULL),
          )));
        }
        continue;
      }
      if (attachment.origin === 'http_request') {
        this.settlePendingHttpTimelineRequest(attachment.requestId, attachment.pending, () => {
          attachment.pending.reject(new Error(TIMELINE_REQUEST_ERROR_REASONS.QUEUE_FULL));
        });
      }
    }
  }

  private enqueueTimelineDataPlaneFanout(
    attachments: TimelineDataPlaneAttachment[],
    meta: TimelineDataPlaneSendMeta,
  ): void {
    const queued = this.enqueueTimelineDataPlaneJob(meta, attachments);
    if (!queued) this.rejectTimelineDataPlaneAttachmentsQueueFull(attachments, meta);
  }

  private collectTimelineSubscriberSockets(sessionName: string): WebSocket[] {
    const sockets: WebSocket[] = [];
    const seen = new Set<WebSocket>();
    for (const [ws, sessions] of this.browserSubscriptions) {
      if (!sessions.has(sessionName) || seen.has(ws)) continue;
      seen.add(ws);
      sockets.push(ws);
    }
    for (const [ws, sessions] of this.transportSubscriptions) {
      if (!sessions.has(sessionName) || seen.has(ws)) continue;
      seen.add(ws);
      sockets.push(ws);
    }
    return sockets;
  }

  private enqueueTimelineDataPlaneSubscriberSend(sessionName: string, msg: Record<string, unknown>, type: string): void {
    const sockets = this.collectTimelineSubscriberSockets(sessionName);
    if (sockets.length === 0) return;
    const meta: TimelineDataPlaneSendMeta = {
      type,
      route: 'subscriber_fallback',
      recipientCount: sockets.length,
      requestIdFanoutCount: 0,
      httpCallerCount: 0,
      broadcastRecipientCount: sockets.length,
      chunkCount: 1,
    };
    this.enqueueTimelineDataPlaneJob(meta, [{
      origin: 'subscriber_fallback',
      sessionName,
      sockets,
      payload: msg,
    }]);
  }

  private handleTimelineDataPlaneResponse(msg: Record<string, unknown>, type: string): void {
    const requestIds = timelineResponseRequestIds(msg);
    if (requestIds.length > 0) {
      const socketDeliveries: Array<{ requestId: string; pending: PendingTimelineRequest }> = [];
      const httpDeliveries: Array<{ requestId: string; pending: PendingHttpTimelineRequest }> = [];
      for (const requestId of requestIds) {
        const pendingHttp = this.pendingHttpTimelineRequests.get(requestId);
        if (pendingHttp) {
          clearTimeout(pendingHttp.timer);
          this.pendingHttpTimelineRequests.delete(requestId);
          httpDeliveries.push({ requestId, pending: pendingHttp });
        }

        const pending = this.pendingTimelineRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingTimelineRequests.delete(requestId);
          socketDeliveries.push({ requestId, pending });
        }
      }

      const recipientCount = socketDeliveries.length + httpDeliveries.length;
      if (recipientCount === 0) {
        incrementCounter('ws_bridge_timeline_unrouted_response', { type });
        logger.warn({ serverId: this.serverId, type, requestIdCount: requestIds.length }, 'timeline response missing pending request - dropped');
        return;
      }

      const attachments: TimelineDataPlaneAttachment[] = [
        ...httpDeliveries.map(({ requestId, pending }): TimelineDataPlaneAttachment => ({
          origin: 'http_request',
          requestId,
          pending,
          payload: timelineResponseForRequestId(msg, requestId),
        })),
        ...socketDeliveries.map(({ requestId, pending }): TimelineDataPlaneAttachment => ({
          origin: 'browser_request',
          requestId,
          socket: pending.socket,
          payload: timelineResponseForRequestId(msg, requestId),
        })),
      ];
      this.enqueueTimelineDataPlaneFanout(attachments, {
        type,
        route: httpDeliveries.length > 0 && socketDeliveries.length === 0 ? 'http_request' : 'browser_request',
        recipientCount,
        requestIdFanoutCount: requestIds.length,
        httpCallerCount: httpDeliveries.length,
        broadcastRecipientCount: 0,
        chunkCount: 1,
      });
      return;
    }

    const sessionName = optionalString(msg.sessionName);
    if (!sessionName) {
      logger.warn({ serverId: this.serverId, type }, 'timeline message missing sessionName - discarded');
      return;
    }

    this.enqueueTimelineDataPlaneSubscriberSend(sessionName, msg, type);
  }

  private pruneSessionGroupCloneContexts(now = Date.now()): void {
    for (const [key, context] of this.sessionGroupCloneContexts.entries()) {
      if (now - context.createdAt > SESSION_GROUP_CLONE_CONTEXT_TTL_MS) {
        this.sessionGroupCloneContexts.delete(key);
      }
    }
    for (const [key, cached] of this.sessionGroupCloneEvents.entries()) {
      if (now - cached.createdAt > SESSION_GROUP_CLONE_CONTEXT_TTL_MS) {
        this.sessionGroupCloneEvents.delete(key);
      }
    }
  }

  registerSessionGroupCloneOperationContext(context: {
    idempotencyKey: string;
    userId: string;
    sourceMainSessionName: string;
  }): void {
    const idempotencyKey = context.idempotencyKey.trim();
    const userId = context.userId.trim();
    const sourceMainSessionName = context.sourceMainSessionName.trim();
    if (!idempotencyKey || !userId || !sourceMainSessionName) return;
    this.pruneSessionGroupCloneContexts();
    this.sessionGroupCloneContexts.set(idempotencyKey, {
      userId,
      sourceMainSessionName,
      createdAt: Date.now(),
    });
  }

  getSessionGroupCloneOperationEvent(idempotencyKey: string): SessionGroupCloneEvent | null {
    const key = idempotencyKey.trim();
    if (!key) return null;
    this.pruneSessionGroupCloneContexts();
    return this.sessionGroupCloneEvents.get(key)?.event ?? null;
  }

  async findExplicitSessionGroupCloneTargetConflict(targetProjectName: string | null | undefined): Promise<string | null> {
    if (typeof targetProjectName !== 'string' || !targetProjectName.trim()) return null;
    const targetMainSessionName = mainSessionNameForProjectSlug(sanitizeProjectName(targetProjectName.trim()));
    if (this.activeMainSessions.has(targetMainSessionName)) return targetMainSessionName;
    if (!this.db) return null;
    const row = await this.db.queryOne<Record<string, unknown>>(
      'SELECT 1 FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
      [this.serverId, targetMainSessionName],
    );
    return row ? targetMainSessionName : null;
  }

  private async getServerVisibleSessionNames(): Promise<string[]> {
    if (!this.db) return [];
    try {
      const sessions = await getDbSessionsByServer(this.db, this.serverId);
      return sessions
        .map((session) => session.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
    } catch (err) {
      logger.warn({ err, serverId: this.serverId }, 'session-group clone server-visible session lookup failed');
      return [];
    }
  }

  private rememberSessionGroupCloneOperationEvent(event: SessionGroupCloneEvent): void {
    this.pruneSessionGroupCloneContexts();
    this.sessionGroupCloneEvents.set(event.idempotencyKey, {
      event,
      createdAt: Date.now(),
    });
  }

  private registerMemoryManagementRequest(ws: WebSocket, msg: Record<string, unknown>): string | null {
    if (!isMemoryManagementRequestType(msg.type)) return null;
    const userId = this.browserUserIds.get(ws)?.trim();
    if (!userId) {
      safeSend(ws, JSON.stringify({
        type: 'error',
        code: MEMORY_MANAGEMENT_BRIDGE_ERROR_CODES.UNAUTHENTICATED,
        message: 'memory management requests require an authenticated browser session',
        originalType: msg.type,
      }));
      return null;
    }
    const pendingForSocket = [...this.pendingMemoryManagementRequests.values()].filter((pending) => pending.socket === ws).length;
    if (pendingForSocket >= MAX_PENDING_MEMORY_MANAGEMENT_REQUESTS_PER_SOCKET) {
      safeSend(ws, JSON.stringify({
        type: 'error',
        code: MEMORY_MANAGEMENT_BRIDGE_ERROR_CODES.TOO_MANY_PENDING_REQUESTS,
        message: 'too many pending memory management requests',
        originalType: msg.type,
      }));
      return null;
    }
    const requestId = typeof msg.requestId === 'string' && msg.requestId.trim()
      ? msg.requestId.trim()
      : null;
    if (!requestId) {
      safeSend(ws, JSON.stringify({
        type: 'error',
        code: MEMORY_MANAGEMENT_BRIDGE_ERROR_CODES.MISSING_REQUEST_ID,
        message: 'memory management requests require requestId',
        originalType: msg.type,
      }));
      return null;
    }
    const existing = this.pendingMemoryManagementRequests.get(requestId);
    if (existing) {
      safeSend(ws, JSON.stringify({
        type: 'error',
        code: MEMORY_MANAGEMENT_BRIDGE_ERROR_CODES.DUPLICATE_REQUEST_ID,
        message: 'memory management requestId is already pending',
        originalType: msg.type,
        requestId,
      }));
      return null;
    }
    const timer = setTimeout(() => this.pendingMemoryManagementRequests.delete(requestId), 30_000);
    this.pendingMemoryManagementRequests.set(requestId, { socket: ws, timer });
    return requestId;
  }

  private clearPendingMemoryManagementRequest(requestId: string): WebSocket | undefined {
    const pending = this.pendingMemoryManagementRequests.get(requestId);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pendingMemoryManagementRequests.delete(requestId);
    return pending.socket;
  }

  private failMemoryManagementForward(ws: WebSocket, msg: Record<string, unknown>, requestId: string, error: unknown): void {
    this.clearPendingMemoryManagementRequest(requestId);
    logger.warn({
      serverId: this.serverId,
      type: msg.type,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    }, 'memory management context injection failed');
    safeSend(ws, JSON.stringify({
      type: 'error',
      code: MEMORY_MANAGEMENT_BRIDGE_ERROR_CODES.CONTEXT_INJECTION_FAILED,
      message: 'memory management request could not be authorized',
      originalType: msg.type,
      requestId,
    }));
  }

  private readMemoryFeatureEnvironmentDefaults(): MemoryFeatureFlagValues {
    const environmentStartupDefault: MemoryFeatureFlagValues = {};
    for (const flag of MEMORY_FEATURE_FLAGS) {
      const key = memoryFeatureFlagEnvKey(flag);
      const raw = process.env[key];
      if (raw != null) environmentStartupDefault[flag] = raw === 'true' || raw === '1';
    }
    return environmentStartupDefault;
  }

  private memoryFeatureLayers(userConfig: MemoryFeatureFlagValues): MemoryFeatureFlagResolutionLayers {
    return {
      persistedConfig: userConfig,
      environmentStartupDefault: this.readMemoryFeatureEnvironmentDefaults(),
    };
  }

  private featureFlagValueSource(flag: MemoryFeatureFlag, layers: MemoryFeatureFlagResolutionLayers): FeatureFlagValueSource {
    if (layers.runtimeConfigOverride?.[flag] !== undefined) return 'runtime_config_override';
    if (layers.persistedConfig?.[flag] !== undefined) return 'persisted_config';
    if (layers.environmentStartupDefault?.[flag] !== undefined) return 'environment_startup_default';
    return 'registry_default';
  }

  private requestedMemoryFeatureFlags(layers: MemoryFeatureFlagResolutionLayers): MemoryFeatureFlagValues {
    const requested: MemoryFeatureFlagValues = {};
    for (const flag of MEMORY_FEATURE_FLAGS) {
      requested[flag] = resolveMemoryFeatureFlagValue(flag, layers);
    }
    return requested;
  }

  private buildMemoryFeatureAdminRecords(userConfig: MemoryFeatureFlagValues) {
    const layers = this.memoryFeatureLayers(userConfig);
    const requested = this.requestedMemoryFeatureFlags(layers);
    const effective = computeEffectiveMemoryFeatureFlags(requested);
    return MEMORY_FEATURE_FLAGS.map((flag) => {
      const definition = getMemoryFeatureFlagDefinition(flag);
      return {
        flag,
        requested: requested[flag] === true,
        enabled: effective[flag],
        source: this.featureFlagValueSource(flag, layers),
        envKey: memoryFeatureFlagEnvKey(flag),
        dependencies: definition.dependencies,
        dependencyBlocked: requested[flag] === true && !effective[flag]
          ? definition.dependencies.filter((dependency) => !effective[dependency])
          : [],
        disabledBehavior: definition.disabledBehavior,
      };
    });
  }

  private collectMemoryFeatureWithDependencies(flag: MemoryFeatureFlag, seen = new Set<MemoryFeatureFlag>()): Set<MemoryFeatureFlag> {
    if (seen.has(flag)) return seen;
    seen.add(flag);
    for (const dependency of getMemoryFeatureFlagDefinition(flag).dependencies) {
      this.collectMemoryFeatureWithDependencies(dependency, seen);
    }
    return seen;
  }

  private async readUserMemoryFeatureFlags(userId: string): Promise<MemoryFeatureFlagValues> {
    if (!this.db) return {};
    return parseMemoryFeatureFlagValuesJson(await getUserPref(this.db, userId, MEMORY_FEATURE_CONFIG_PREF_KEY));
  }

  private async writeUserMemoryFeatureFlags(userId: string, flags: MemoryFeatureFlagValues): Promise<MemoryFeatureFlagValues> {
    if (!this.db) throw new Error('database_unavailable');
    const normalized = parseMemoryFeatureFlagValuesJson(encodeMemoryFeatureFlagValuesJson(flags));
    await setUserPref(this.db, userId, MEMORY_FEATURE_CONFIG_PREF_KEY, encodeMemoryFeatureFlagValuesJson(normalized));
    return normalized;
  }

  private sendMemoryFeatureConfigApply(flags: MemoryFeatureFlagValues): void {
    this.sendToDaemon(JSON.stringify({
      type: MEMORY_FEATURE_CONFIG_MSG.APPLY,
      flags,
    }));
  }

  private async pushUserMemoryFeatureConfigToOnlineDaemons(userId: string, flags: MemoryFeatureFlagValues): Promise<void> {
    const entries = [...WsBridge.instances.values()];
    await Promise.all(entries.map(async (bridge) => {
      if (!bridge.authenticated || !bridge.daemonWs || !bridge.db) return;
      const row = await bridge.db.queryOne<{ user_id?: string }>(
        'SELECT user_id FROM servers WHERE id = $1',
        [bridge.serverId],
      ).catch(() => null);
      if (row?.user_id !== userId) return;
      try {
        bridge.sendMemoryFeatureConfigApply(flags);
      } catch (error) {
        logger.warn({ err: error, serverId: bridge.serverId }, 'failed to apply global memory feature config to daemon');
      }
    }));
  }

  private async handleMemoryFeaturesQuery(ws: WebSocket, msg: Record<string, unknown>): Promise<boolean> {
    if (msg.type !== MEMORY_WS.FEATURES_QUERY) return false;
    const requestId = this.registerMemoryManagementRequest(ws, msg);
    if (!requestId) return true;
    const userId = this.browserUserIds.get(ws)?.trim();
    try {
      const flags = userId ? await this.readUserMemoryFeatureFlags(userId) : {};
      this.clearPendingMemoryManagementRequest(requestId);
      safeSend(ws, JSON.stringify({
        type: MEMORY_WS.FEATURES_RESPONSE,
        requestId,
        records: this.buildMemoryFeatureAdminRecords(flags),
      }));
    } catch (error) {
      this.failMemoryManagementForward(ws, msg, requestId, error);
    }
    return true;
  }

  private async handleMemoryFeaturesSet(ws: WebSocket, msg: Record<string, unknown>): Promise<boolean> {
    if (msg.type !== MEMORY_WS.FEATURES_SET) return false;
    const requestId = this.registerMemoryManagementRequest(ws, msg);
    if (!requestId) return true;
    const userId = this.browserUserIds.get(ws)?.trim();
    const flag = typeof msg.flag === 'string' ? msg.flag : undefined;
    const enabled = msg.enabled;
    const sendSetResponse = (payload: Record<string, unknown>) => {
      this.clearPendingMemoryManagementRequest(requestId);
      safeSend(ws, JSON.stringify({
        type: MEMORY_WS.FEATURES_SET_RESPONSE,
        requestId,
        ...payload,
      }));
    };
    if (!userId) {
      sendSetResponse({ success: false, error: MEMORY_MANAGEMENT_BRIDGE_ERROR_CODES.UNAUTHENTICATED });
      return true;
    }
    if (!isMemoryFeatureFlag(flag) || typeof enabled !== 'boolean') {
      sendSetResponse({
        success: false,
        error: MEMORY_MANAGEMENT_ERROR_CODES.INVALID_FEATURE_FLAG,
        errorCode: MEMORY_MANAGEMENT_ERROR_CODES.INVALID_FEATURE_FLAG,
      });
      return true;
    }
    try {
      const current = await this.readUserMemoryFeatureFlags(userId);
      const updates: MemoryFeatureFlagValues = enabled
        ? Object.fromEntries([...this.collectMemoryFeatureWithDependencies(flag)].map((dependency) => [dependency, true])) as MemoryFeatureFlagValues
        : { [flag]: false };
      const next = await this.writeUserMemoryFeatureFlags(userId, { ...current, ...updates });
      await this.pushUserMemoryFeatureConfigToOnlineDaemons(userId, next);
      const records = this.buildMemoryFeatureAdminRecords(next);
      sendSetResponse({
        success: true,
        flag,
        requested: enabled,
        enabled: records.find((record) => record.flag === flag)?.enabled ?? false,
        records,
      });
    } catch (error) {
      logger.warn({ err: error, serverId: this.serverId, flag }, 'failed to persist global memory feature config');
      sendSetResponse({
        success: false,
        flag,
        requested: enabled,
        error: MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_CONFIG_WRITE_FAILED,
        errorCode: MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_CONFIG_WRITE_FAILED,
      });
    }
    return true;
  }

  private roleFromMembership(role: unknown, elevatedRole: Exclude<MemoryManagementRole, 'user'>): MemoryManagementRole {
    return role === 'owner' || role === 'admin' ? elevatedRole : 'user';
  }

  private async resolveMemoryManagementAuthorization(params: {
    userId: string;
    canonicalRepoId?: string;
    projectDir?: string;
    workspaceId?: string;
    orgId?: string;
  }): Promise<{ role: MemoryManagementRole; boundProjects: MemoryManagementBoundProject[] }> {
    if (!this.db) return { role: 'user', boundProjects: [] };
    const { userId, canonicalRepoId, projectDir, workspaceId, orgId } = params;
    try {
      if (canonicalRepoId) {
        const row = await this.db.queryOne<{ role?: string; workspace_id?: string | null; enterprise_id?: string | null }>(
          `SELECT tm.role, e.workspace_id, e.enterprise_id
             FROM shared_project_enrollments e
             JOIN team_members tm ON tm.team_id = e.enterprise_id AND tm.user_id = $2
            WHERE e.canonical_repo_id = $1
              AND e.status = 'active'
            ORDER BY CASE tm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END
            LIMIT 1`,
          [canonicalRepoId, userId],
        );
        if (typeof row?.role === 'string') {
          return {
            role: this.roleFromMembership(row.role, 'workspace_admin'),
            boundProjects: [{
              projectDir,
              canonicalRepoId,
              workspaceId: typeof row.workspace_id === 'string' ? row.workspace_id : undefined,
              orgId: typeof row.enterprise_id === 'string' ? row.enterprise_id : undefined,
            }],
          };
        }
        if (projectDir) {
          const localSession = await this.db.queryOne<{ name?: string }>(
            'SELECT name FROM sessions WHERE server_id = $1 AND project_dir = $2 LIMIT 1',
            [this.serverId, projectDir],
          );
          const localSubSession = localSession ? null : await this.db.queryOne<{ id?: string }>(
            'SELECT id FROM sub_sessions WHERE server_id = $1 AND cwd = $2 AND closed_at IS NULL LIMIT 1',
            [this.serverId, projectDir],
          );
          if (localSession || localSubSession) {
            return {
              role: 'user',
              boundProjects: [{ projectDir, canonicalRepoId }],
            };
          }
        }
        return { role: 'user', boundProjects: [] };
      }

      if (workspaceId) {
        const row = await this.db.queryOne<{ role?: string; enterprise_id?: string | null }>(
          `SELECT tm.role, w.enterprise_id
             FROM shared_context_workspaces w
             JOIN team_members tm ON tm.team_id = w.enterprise_id AND tm.user_id = $2
            WHERE w.id = $1`,
          [workspaceId, userId],
        );
        if (typeof row?.role === 'string') {
          return {
            role: this.roleFromMembership(row.role, 'workspace_admin'),
            boundProjects: [{
              workspaceId,
              orgId: typeof row.enterprise_id === 'string' ? row.enterprise_id : undefined,
            }],
          };
        }
        return { role: 'user', boundProjects: [] };
      }

      if (orgId) {
        const row = await this.db.queryOne<{ role?: string }>(
          'SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2',
          [orgId, userId],
        );
        if (typeof row?.role === 'string') {
          return {
            role: this.roleFromMembership(row.role, 'org_admin'),
            boundProjects: [{ orgId }],
          };
        }
      }
    } catch (error) {
      logger.warn({ err: error, serverId: this.serverId }, 'memory management authorization derivation failed');
    }
    return { role: 'user', boundProjects: [] };
  }

  private async withMemoryManagementContext(ws: WebSocket, msg: Record<string, unknown>, requestId: string): Promise<Record<string, unknown>> {
    const userId = this.browserUserIds.get(ws)?.trim();
    if (!userId) return msg;
    const canonicalRepoId = typeof msg.canonicalRepoId === 'string' && msg.canonicalRepoId.trim()
      ? msg.canonicalRepoId.trim()
      : undefined;
    const projectDir = typeof msg.projectDir === 'string' && msg.projectDir.trim() ? msg.projectDir.trim() : undefined;
    const workspaceId = typeof msg.workspaceId === 'string' && msg.workspaceId.trim() ? msg.workspaceId.trim() : undefined;
    const orgId = typeof msg.orgId === 'string' && msg.orgId.trim()
      ? msg.orgId.trim()
      : (typeof msg.enterpriseId === 'string' && msg.enterpriseId.trim() ? msg.enterpriseId.trim() : undefined);
    const authorization = await this.resolveMemoryManagementAuthorization({ userId, canonicalRepoId, projectDir, workspaceId, orgId });
    const context: AuthenticatedMemoryManagementContext = {
      actorId: userId,
      userId,
      role: authorization.role,
      serverId: this.serverId,
      requestId,
      source: 'server_bridge',
      boundProjects: authorization.boundProjects,
    };
    const { [MEMORY_MANAGEMENT_CONTEXT_FIELD]: _ignoredContext, managementContext: _ignoredLegacyContext, ...safeMsg } = msg;
    void _ignoredContext;
    void _ignoredLegacyContext;
    return {
      ...safeMsg,
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: context,
    };
  }

  // ── Daemon connection ──────────────────────────────────────────────────────

  handleDaemonConnection(ws: WebSocket, db: Database, env: Env, onAuthenticated?: () => void): void {
    this.db = db;
    // Replace existing daemon connection
    if (this.daemonWs) {
      try { this.daemonWs.close(1001, 'replaced'); } catch { /* ignore */ }
    }
    this.daemonWs = ws;
    this.authenticated = false;
    // New connection: drop any auth promise from a prior connection so
    // late-arriving messages don't await a stale (and possibly resolved
    // for a different `ws`) auth.
    this.authPromise = null;

    // Auth timeout
    this.authTimer = setTimeout(() => {
      if (!this.authenticated) {
        logger.warn({ serverId: this.serverId }, 'Daemon auth timeout');
        ws.close(4001, 'auth_timeout');
      }
    }, AUTH_TIMEOUT_MS);

    ws.on('message', async (data, isBinary) => {
      // Handle binary raw PTY frames
      if (isBinary) {
        this.routeBinaryFrame(data as Buffer);
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse((data as Buffer).toString()) as Record<string, unknown>;
      } catch {
        return;
      }

      // Audit fix (78-server reconnect-storm) — wait for any in-flight
      // auth handshake before evaluating `this.authenticated`. Without
      // this, `daemon.hello` (sent back-to-back with `auth` by every
      // daemon) raced the auth DB lookup and was rejected with
      // `ws.close(4001, 'auth_required')` even though auth was about to
      // succeed milliseconds later. See `authPromise` field doc above.
      if (this.authPromise) {
        try { await this.authPromise; } catch { /* ignore — closed below */ }
        // The connection may have been closed while we awaited (auth
        // failed / timed out / replaced). Bail out before processing.
        if (this.daemonWs !== ws) return;
      }

      if (!this.authenticated) {
        if (msg.type !== 'auth' || typeof msg.token !== 'string' || typeof msg.serverId !== 'string') {
          ws.close(4001, 'auth_required');
          return;
        }
        if (this.authTimer) clearTimeout(this.authTimer);

        // Capture the auth flow in `authPromise` so concurrent message
        // handlers (the `daemon.hello` that arrives ~1 ms after `auth`)
        // can `await` it instead of racing the DB lookup. The promise
        // ALWAYS resolves (never rejects) — failure modes are signaled
        // via `ws.close()` + `this.daemonWs = null`, which the awaiting
        // handlers detect with their `daemonWs !== ws` bail-out check.
        // Resolving (vs rejecting) avoids unhandled-rejection warnings
        // when no concurrent handler is currently awaiting.
        let resolveAuth!: () => void;
        this.authPromise = new Promise<void>((res) => { resolveAuth = res; });

        const tokenHash = sha256Hex(msg.token);
        let server: { token_hash: string; user_id?: string } | null = null;
        try {
          server = await db.queryOne<{ token_hash: string; user_id?: string }>(
            'SELECT token_hash, user_id FROM servers WHERE id = $1',
            [this.serverId],
          );
        } catch (err) {
          resolveAuth();
          this.authPromise = null;
          throw err;
        }

        if (!server || server.token_hash !== tokenHash) {
          logger.warn({ serverId: this.serverId }, 'Daemon auth failed');
          ws.close(4001, 'auth_failed');
          resolveAuth();
          this.authPromise = null;
          return;
        }

        this.authenticated = true;
        this.daemonVersion = typeof msg.daemonVersion === 'string' ? msg.daemonVersion : null;
        this.recentTextBySession.clear();
        this.activeMainSessions.clear();
        this.hasActiveMainSessionSnapshot = false;
        logger.info({ serverId: this.serverId, daemonVersion: this.daemonVersion }, 'Daemon authenticated');
        onAuthenticated?.();

        updateServerHeartbeat(db, this.serverId, this.daemonVersion).catch((err) =>
          logger.error({ err }, 'Failed to update heartbeat on auth'),
        );
        if (typeof server.user_id === 'string' && server.user_id.trim()) {
          try {
            this.sendMemoryFeatureConfigApply(await this.readUserMemoryFeatureFlags(server.user_id));
          } catch (err) {
            logger.warn({ err, serverId: this.serverId }, 'failed to push global memory feature config on daemon auth');
          }
        }
        this.daemonUpgradeCoordinator.clearIfTargetVersionMatches(this.daemonVersion);
        this.flushPendingDaemonUpgrade(ws);

        // Auto-upgrade: on reconnect, retry up to 3 times, but never schedule
        // more than one upgrade command per 15 minutes while the daemon remains
        // on a mismatched version. This protects npm global install from
        // reconnect storms and registry propagation windows.
        // Always target the server's exact version so dev↔stable mismatches converge to
        // the same channel in both directions.
        const serverVersion = process.env.APP_VERSION;
        const shouldUpgrade = Boolean(
          serverVersion
          && serverVersion !== '0.0.0'
          && this.daemonVersion
          && this.daemonVersion !== serverVersion,
        );
        if (shouldUpgrade) {
          const result = this.requestDaemonUpgrade({
            targetVersion: serverVersion,
            source: 'auto',
            isStillCurrent: () => this.daemonWs === ws && this.authenticated && this.daemonVersion !== serverVersion,
          });
          if (result.deliveryStatus === DAEMON_UPGRADE_DELIVERY_STATUS.SENT) {
            logger.info({
              serverId: this.serverId,
              daemonVersion: this.daemonVersion,
              serverVersion,
              upgradeId: result.upgradeId,
            }, 'Version mismatch — scheduling daemon.upgrade');
          } else if (result.deliveryStatus === DAEMON_UPGRADE_DELIVERY_STATUS.SUPPRESSED) {
            logger.info({
              serverId: this.serverId,
              daemonVersion: this.daemonVersion,
              serverVersion,
              nextAttemptAt: result.nextAttemptAt,
            }, 'Version mismatch — auto daemon.upgrade suppressed by 15-minute interval');
          } else if (result.deliveryStatus === DAEMON_UPGRADE_DELIVERY_STATUS.BACKOFF) {
            logger.warn({
              serverId: this.serverId,
              daemonVersion: this.daemonVersion,
              serverVersion,
              reason: result.reason,
            }, 'Version mismatch — auto daemon.upgrade in backoff');
          } else if (result.deliveryStatus === DAEMON_UPGRADE_DELIVERY_STATUS.PENDING_PUBLICATION) {
            logger.info({
              serverId: this.serverId,
              daemonVersion: this.daemonVersion,
              serverVersion,
              nextAttemptAt: result.nextAttemptAt,
              reason: result.reason,
            }, 'Version mismatch — waiting for daemon upgrade target to appear on npm');
          }
        } else {
          // Version matches or auto-upgrade does not apply — reset retry state.
          this.daemonUpgradeCoordinator.clearIfTargetVersionMatches(this.daemonVersion);
        }

        // Replay queued messages, skipping terminal.subscribe/unsubscribe — refs replay below is authoritative
        for (const queued of this.queue) {
          try {
            const parsed = JSON.parse(queued) as { type?: string };
            if (parsed.type === 'terminal.subscribe' || parsed.type === 'terminal.unsubscribe') continue;
            if (parsed.type === DAEMON_COMMAND_TYPES.DAEMON_UPGRADE) {
              this.requestDaemonUpgrade({
                targetVersion: (parsed as { targetVersion?: unknown }).targetVersion,
                source: 'replay',
                isStillCurrent: () => this.daemonWs === ws && this.authenticated,
              });
              continue;
            }
            ws.send(queued);
          } catch { /* ignore */ }
        }
        this.queue = [];

        this.broadcastToBrowsers(JSON.stringify({ type: DAEMON_MSG.RECONNECTED }));

        // Re-subscribe daemon to all sessions that still have active browser subscribers
        for (const [sessionName, refs] of this.daemonSessionRefs) {
          if (refs.totalRefs > 0) {
            try {
              ws.send(JSON.stringify({
                type: 'terminal.subscribe',
                session: sessionName,
                raw: refs.rawRefs > 0,
              }));
            } catch { /* ignore */ }
          }
        }

        // ── Ack reliability: cancel grace, replay inflight, announce online ──
        if (this.graceTimer) {
          clearTimeout(this.graceTimer);
          this.graceTimer = null;
        }
        this.daemonOfflineAnnounced = false;
        await this.replayInflightToDaemon();
        this.broadcastToBrowsers(JSON.stringify({ type: MSG_DAEMON_ONLINE }));
        this.startAckHousekeepingIfNeeded();

        // Audit fix (78-server reconnect-storm) — release waiters now
        // that auth + replay are complete. Concurrent message handlers
        // (e.g. the `daemon.hello` that landed before auth finished)
        // will resume past their `await this.authPromise` and observe
        // `this.authenticated === true`.
        resolveAuth();
        this.authPromise = null;
        return;
      }

      if (msg.type === P2P_WORKFLOW_MSG.DAEMON_HELLO) {
        this.handleDaemonP2pWorkflowHello(msg);
        return;
      }

      if (msg.type === 'heartbeat') {
        const heartbeatDaemonVersion = typeof msg.daemonVersion === 'string'
          ? msg.daemonVersion
          : this.daemonVersion;
        if (typeof heartbeatDaemonVersion === 'string') this.daemonVersion = heartbeatDaemonVersion;
        updateServerHeartbeat(db, this.serverId, heartbeatDaemonVersion).catch((err) =>
          logger.error({ err }, 'Failed to update heartbeat'),
        );
        // Ack heartbeat so daemon watchdog doesn't consider the connection dead
        try { ws.send(JSON.stringify({ type: 'heartbeat_ack' })); } catch { /* ignore */ }
      }

      this.relayToBrowsers(msg);

      // Push notifications for key events
      if (env) {
        const pushType = msg.type as string;
        if (pushType === 'session.idle' || pushType === 'session.notification' || pushType === 'session.error') {
          this.dispatchEventPush(db, env, msg).catch((err) =>
            logger.error({ err }, 'Push dispatch failed'),
          );
        }
        // Timeline events: session.state(idle) and ask.question
        if (pushType === TIMELINE_MESSAGES.EVENT) {
          const event = (msg as Record<string, unknown>).event as Record<string, unknown> | undefined;
          if (event?.type === 'ask.question') {
            this.dispatchEventPush(db, env, {
              type: 'ask.question',
              session: event.sessionId ?? '',
              ...event.payload as Record<string, unknown>,
            }).catch((err) => logger.error({ err }, 'Push dispatch failed'));
          }
          // session.state idle from timeline (covers all agent types: CC, codex, gemini)
          if (event?.type === 'session.state' && (event.payload as Record<string, unknown>)?.state === 'idle') {
            const payload = event.payload as Record<string, unknown>;
            const eventTs = typeof event.ts === 'number' ? event.ts : undefined;
            if (payload[TIMELINE_SUPPRESS_PUSH_FIELD] === true) return;
            if (eventTs && Date.now() - eventTs > PUSH_TIMELINE_EVENT_MAX_AGE_MS) return;
            this.dispatchEventPush(db, env, {
              type: 'session.idle',
              session: event.sessionId ?? '',
              lastText: (msg as Record<string, unknown>).lastText ?? '',
            }).catch((err) => logger.error({ err }, 'Push dispatch failed'));
          }
        }
      }
    });

    ws.on('close', () => {
      if (this.daemonWs === ws) {
        this.daemonWs = null;
        this.authenticated = false;
        // Audit fix (78-server reconnect-storm) — drop the auth promise
        // so the next reconnect's message handlers don't await a stale
        // pending promise. If auth was still in flight when the socket
        // closed, the awaiting handlers will fall through and observe
        // `this.daemonWs !== ws` and bail out.
        this.authPromise = null;
        this.recentTextBySession.clear();
        this.activeMainSessions.clear();
        this.activeSubSessions.clear();
        this.hasActiveMainSessionSnapshot = false;
        this.rejectAllPendingFileTransfers('daemon_disconnected');
        this.rejectAllPendingMemorySourcesRequests('daemon_disconnected');
        this.rejectAllPendingHttpTimelineRequests('daemon_disconnected');
        this.rejectAllPendingPreviewRequests('daemon_disconnected');
        // Close all preview WS tunnels — daemon is gone
        this.closeAllPreviewWsTunnels(1001, 'daemon disconnected');
        // Clear provider statuses — daemon is gone, providers are unreachable
        for (const [providerId] of this.providerStatus) {
          this.broadcastToBrowsers(JSON.stringify({ type: TRANSPORT_MSG.PROVIDER_STATUS, providerId, connected: false }));
        }
        this.providerStatus.clear();
        this.daemonP2pWorkflowCapabilities = null;
        this.broadcastToBrowsers(JSON.stringify({ type: DAEMON_MSG.DISCONNECTED }));
        void clearProviderStatus(db, this.serverId).catch(() => {});
        updateServerStatus(db, this.serverId, 'offline').catch((err) =>
          logger.error({ err }, 'Failed to mark server offline'),
        );

        // ── Ack reliability: start grace window, don't yet announce offline ──
        // If daemon reconnects within RECONNECT_GRACE_MS, we replay inflight
        // commands and users never see a failure.
        if (this.graceTimer) clearTimeout(this.graceTimer);
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null;
          this.onReconnectGraceExpired();
        }, RECONNECT_GRACE_MS);
      }
      this.maybeCleanup();
    });

    ws.on('error', (err) => {
      logger.error({ serverId: this.serverId, err }, 'Daemon WS error');
      this.rejectAllPendingFileTransfers('daemon_error');
      this.rejectAllPendingMemorySourcesRequests('daemon_error');
      this.rejectAllPendingHttpTimelineRequests('daemon_error');
      this.rejectAllPendingPreviewRequests('daemon_error');
    });
  }

  // ── Browser connection ─────────────────────────────────────────────────────

  setShareCoverageResolverForTests(resolver: ShareCoverageResolver): void {
    this.shareCoverageResolver = resolver;
  }

  handleShareBrowserConnection(
    ws: WebSocket,
    userId: string,
    db: Database,
    options: {
      ticketId: string;
      target: ShareTarget;
      snapshot: EffectiveCoverage;
      isMobile?: boolean;
    },
  ): void {
    this.browserShareStates.set(ws, {
      userId,
      actorDisplayName: userId,
      ticketId: options.ticketId,
      target: options.target,
      snapshot: options.snapshot,
      connectedAt: shareClockNow(),
      coveredSessionNames: this.baseCoveredSessionNames(options.target),
    });
    this.handleBrowserConnection(ws, userId, db, options.isMobile ?? false);
    void this.refreshShareActorDisplayName(ws);
    void this.refreshShareCoveredSessions(ws);
  }

  async revalidateShareSocketForTests(ws: WebSocket): Promise<void> {
    await this.revalidateShareSocket(ws);
  }

  async sweepShareSocketsForTests(): Promise<void> {
    await this.sweepShareSockets();
  }

  countSharePendingCommandsForUser(userId: string, sessionName: string, commandType: string): number {
    return [...this.inflightCommands.values()].filter((entry) => (
      entry.share?.userId === userId
      && entry.sessionName === sessionName
      && this.rawPayloadType(entry.rawPayload) === commandType
    )).length;
  }

  getActiveDispatchIdForSession(sessionName: string): string | null {
    return this.activeDispatchIds.get(sessionName) ?? null;
  }

  broadcastShareDiscussionComment(target: ShareTarget, payload: Record<string, unknown>): void {
    const serialized = JSON.stringify(payload);
    const targetRef = shareTargetKey(target);
    for (const [ws, state] of this.browserShareStates) {
      if (state.target.serverId !== target.serverId) continue;
      if (state.target.kind !== 'server' && shareTargetKey(state.target) !== targetRef) continue;
      safeSend(ws, serialized);
    }
  }

  async revalidateShareSocketsForUser(userId: string): Promise<void> {
    const sockets = [...this.browserShareStates]
      .filter(([, state]) => state.userId === userId)
      .map(([ws]) => ws);
    await Promise.all(sockets.map((ws) => this.revalidateShareSocket(ws)));
  }

  async revalidateShareSocketsForTarget(target: ShareTarget): Promise<void> {
    const sockets = [...this.browserShareStates]
      .filter(([, state]) => (
        state.target.serverId === target.serverId
        && (state.target.kind === 'server' || shareTargetKey(state.target) === shareTargetKey(target))
      ))
      .map(([ws]) => ws);
    await Promise.all(sockets.map((ws) => this.revalidateShareSocket(ws)));
  }

  handleBrowserConnection(ws: WebSocket, userId: string, db: Database, isMobile = false): void {
    this.db = db;
    this.browserSockets.add(ws);
    if (isMobile) this.mobileSockets.add(ws);
    this.browserSubscriptions.set(ws, new Map());
    this.transportSubscriptions.set(ws, new Set());
    this.browserUserIds.set(ws, userId);
    const shareState = this.browserShareStates.get(ws);

    // Push cached provider statuses so the browser has them immediately — no WS race.
    if (!shareState) {
      for (const [providerId, connected] of this.providerStatus) {
        safeSend(ws, JSON.stringify({ type: TRANSPORT_MSG.PROVIDER_STATUS, providerId, connected }));
      }
      // Push cached remote sessions for each connected provider
      for (const [providerId, sessions] of this.providerRemoteSessions) {
        safeSend(ws, JSON.stringify({ type: TRANSPORT_MSG.SESSIONS_RESPONSE, providerId, sessions }));
      }
    }
    /*
     * R3 v2 PR-σ — Replay the cached `daemon.hello` to newly-connected
     * browsers. Previously the daemon only sent hello on (a) WS
     * connect/reconnect and (b) capability change, and the bridge
     * forwarded it as it arrived but never replayed cached state. Any
     * browser that opened AFTER the daemon's most recent hello would
     * never receive one and its `capability_stale` 30 s TTL would
     * fire as a false-positive "lost contact with the daemon" banner
     * even though the daemon was healthy. Replaying the cached snapshot
     * here gives every newly-connected browser the same starting
     * capability picture as one that was open during the original
     * hello broadcast.
     */
    if (!shareState && this.daemonP2pWorkflowCapabilities) {
      safeSend(ws, JSON.stringify({
        type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
        daemonId: this.daemonP2pWorkflowCapabilities.daemonId,
        capabilities: this.daemonP2pWorkflowCapabilities.capabilities,
        ...(this.daemonP2pWorkflowCapabilities.timelineProtocolRevision !== undefined
          ? {
            timelineProtocolCapability: TIMELINE_PROTOCOL_CAPABILITY,
            timelineProtocolRevision: this.daemonP2pWorkflowCapabilities.timelineProtocolRevision,
          }
          : {}),
        helloEpoch: this.daemonP2pWorkflowCapabilities.helloEpoch,
        ...(this.daemonP2pWorkflowCapabilities.buildInfo ? { buildInfo: this.daemonP2pWorkflowCapabilities.buildInfo } : {}),
        sentAt: this.daemonP2pWorkflowCapabilities.sentAt,
      }));
    }

    ws.on('message', async (data) => {
      let raw = (data as Buffer).toString();
      if (Buffer.byteLength(raw, 'utf8') > MAX_BROWSER_PAYLOAD) {
        logger.warn({ serverId: this.serverId }, 'Browser message too large — dropped');
        try { ws.send(JSON.stringify({ type: 'error', error: 'payload_too_large' })); } catch { /* ignore */ }
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      // Browser rate limit — drop with error response so frontend can handle it.
      // Gated by BROWSER_RATE_LIMIT_ENABLED. See the constant's docs above for
      // why it's currently off; the entire block is preserved (and inert) so
      // re-enabling is a one-line flip with no semantic risk.
      if (BROWSER_RATE_LIMIT_ENABLED) {
        const browserId = this.getBrowserId(ws);
        if (!this.browserRateLimiter.check(browserId, BROWSER_RATE_LIMIT, BROWSER_RATE_WINDOW)) {
          logger.warn({ serverId: this.serverId, type: msg.type }, 'Browser rate limit exceeded — dropped');
          safeSend(ws, JSON.stringify({ type: 'error', code: 'rate_limited', message: 'Too many requests', originalType: msg.type, requestId: msg.requestId }));
          // If the dropped message is a session.send, also emit command.failed
          // so the web UI's optimistic bubble flips to failed immediately
          // instead of waiting 30s for the client-side timeout. Without this,
          // a mobile browser that flaps subscribe/unsubscribe can easily
          // exceed the per-browser rate limit — the user then sees their
          // send bubble spin for 30 full seconds with no signal why.
          if (msg.type === 'session.send' && typeof msg.commandId === 'string') {
            const rlSessionName = typeof msg.sessionName === 'string'
              ? msg.sessionName
              : (typeof msg.session === 'string' ? msg.session : '');
            if (rlSessionName) {
              safeSend(ws, JSON.stringify({
                type: MSG_COMMAND_FAILED,
                commandId: msg.commandId,
                session: rlSessionName,
                reason: ACK_FAILURE_DAEMON_ERROR,
                retryable: true,
              }));
            }
          }
          return;
        }
      }

      if (typeof msg.type !== 'string') {
        return;
      }

      if (this.browserShareStates.has(ws)) {
        const shareCommandDecision = await this.evaluateShareScopedBrowserCommand(ws, msg);
        if (!shareCommandDecision.allowed) {
          this.rejectShareScopedBrowserCommand(ws, msg, shareCommandDecision.reason);
          if (shareCommandDecision.closeSocket) {
            try { ws.close(1008, shareCommandDecision.reason); } catch { /* ignore */ }
          }
          return;
        }
        if ('stampedMessage' in shareCommandDecision && shareCommandDecision.stampedMessage) {
          msg = shareCommandDecision.stampedMessage;
          raw = JSON.stringify(msg);
        }
      }
      const browserMessageType = typeof msg.type === 'string' ? msg.type : '';
      if (!browserMessageType) {
        return;
      }

      if (msg.type === SESSION_GROUP_CLONE_MSG.START || msg.type === SESSION_GROUP_CLONE_MSG.CANCEL) {
        await this.handleBrowserSessionGroupCloneCommand(ws, msg);
        return;
      }

      const p2pBrowserMessage = parseP2pWorkflowMessageType(browserMessageType);
      if (p2pBrowserMessage.kind === 'drop' && p2pBrowserMessage.reason === 'unknown_p2p_message') {
        incrementCounter('p2p.bridge.unknown_message_drop', { direction: 'browser_to_daemon' });
        logger.warn({ serverId: this.serverId, type: browserMessageType }, 'unknown browser p2p message — dropped');
        return;
      }
      if (p2pBrowserMessage.kind === 'known') {
        const descriptor = p2pBrowserMessage.descriptor;
        if (
          !descriptor.allowedIngress.includes('browser')
          || descriptor.response
          || descriptor.serverHandling !== 'forward_to_daemon'
        ) {
          incrementCounter('p2p.bridge.wrong_peer_drop', { direction: 'browser_to_daemon', type: browserMessageType });
          logger.warn({ serverId: this.serverId, type: browserMessageType }, 'browser attempted disallowed p2p route — dropped');
          safeSend(ws, JSON.stringify({
            type: 'error',
            code: P2P_BRIDGE_ERROR_CODES.WRONG_PEER,
            originalType: browserMessageType,
            requestId: msg.requestId,
          }));
          return;
        }
        if (descriptor.requestScoped && !this.registerP2pWorkflowRequest(ws, msg, descriptor)) {
          return;
        }
      }

      if (this.isBrowserForbiddenDaemonCommandType(browserMessageType)) {
        logger.warn({ serverId: this.serverId, type: browserMessageType }, 'Browser attempted server-only daemon command — rejected');
        safeSend(ws, JSON.stringify({
          type: 'error',
          code: 'server_only_command',
          originalType: browserMessageType,
          requestId: msg.requestId,
        }));
        return;
      }

      if (msg.type === MEMORY_WS.FEATURES_QUERY) {
        await this.handleMemoryFeaturesQuery(ws, msg);
        return;
      }
      if (msg.type === MEMORY_WS.FEATURES_SET) {
        await this.handleMemoryFeaturesSet(ws, msg);
        return;
      }

      if (isMemoryManagementRequestType(msg.type)) {
        const requestId = this.registerMemoryManagementRequest(ws, msg);
        if (!requestId) return;
        try {
          this.sendToDaemon(JSON.stringify(await this.withMemoryManagementContext(ws, msg, requestId)));
        } catch (error) {
          this.failMemoryManagementForward(ws, msg, requestId, error);
        }
        return;
      }

      if (msg.type === REPO_MSG.CHECKOUT_BRANCH) {
        const authorized = await this.verifyRepoCheckoutAuthorization(ws, msg);
        if (!authorized) return;
      }

      // Track fs.ls requests for single-cast response routing
      if (msg.type === 'fs.ls' && typeof msg.requestId === 'string') {
        this.registerPendingFsRoute('fs.ls', ws, msg);
      }

      // Track fs.read requests for single-cast response routing
      if (msg.type === 'fs.read' && typeof msg.requestId === 'string') {
        this.registerPendingFsRoute('fs.read', ws, msg);
      }

      // Track fs.git_status requests for single-cast response routing
      if (msg.type === 'fs.git_status' && typeof msg.requestId === 'string') {
        this.registerPendingFsRoute('fs.git_status', ws, msg);
      }

      // Track fs.git_diff requests for single-cast response routing
      if (msg.type === 'fs.git_diff' && typeof msg.requestId === 'string') {
        this.registerPendingFsRoute('fs.git_diff', ws, msg);
      }

      // Track file.search requests for single-cast response routing
      if (msg.type === 'file.search' && typeof msg.requestId === 'string') {
        this.registerPendingFsRoute('file.search', ws, msg);
      }

      // Track fs.write requests for single-cast response routing
      if (msg.type === 'fs.write' && typeof msg.requestId === 'string') {
        this.registerPendingFsRoute('fs.write', ws, msg);
      }

      // Validate and track timeline request ids for single-cast response routing.
      // This eliminates the race where terminal.subscribe's async ownership check hasn't completed
      // before the daemon responds with timeline data - without this, the response is silently dropped.
      if (TIMELINE_REQUEST_TYPES.has(browserMessageType)) {
        if (!await this.verifyTimelineBrowserRequest(ws, msg)) return;
        if (typeof msg.requestId === 'string') {
          this.registerPendingTimelineRequest(ws, msg);
        }
      }

      // Track terminal subscriptions for binary routing + ref-counted daemon forwarding
      if (msg.type === 'terminal.subscribe' && typeof msg.session === 'string') {
        const sessionName = msg.session;
        const rawMode = typeof msg.raw === 'boolean' ? msg.raw : true;
        const revision = this.bumpTerminalSubscriptionRevision(ws, sessionName);
        void this.verifySessionOwnershipWithSubSessionRetry(sessionName).then((allowed) => {
          if (!allowed) {
            logger.warn({ serverId: this.serverId, sessionName }, 'terminal.subscribe: session not owned by this server — rejected');
            return;
          }
          if (!this.isCurrentTerminalSubscriptionRevision(ws, sessionName, revision)) return;
          this.addBrowserSessionSubscription(ws, sessionName, rawMode, raw, revision);
        });
        return;
      } else if (msg.type === 'terminal.unsubscribe' && typeof msg.session === 'string') {
        this.removeBrowserSessionSubscription(ws, msg.session);
        return; // forwarding handled inside (only on 1→0)
      }

      // Track transport (chat) subscriptions for session-scoped transport event delivery
      if (msg.type === TRANSPORT_MSG.CHAT_SUBSCRIBE && typeof msg.sessionId === 'string') {
        const sessionId = msg.sessionId;
        const hasForceHistoryFlag = Object.prototype.hasOwnProperty.call(msg, 'forceHistory');
        const forceHistory = (msg as { forceHistory?: unknown }).forceHistory === true;
        const alreadySubscribed = this.transportSubscriptions.get(ws)?.has(sessionId) ?? false;
        const revision = this.bumpTransportSubscriptionRevision(ws, sessionId);
        void this.verifySessionOwnershipWithSubSessionRetry(sessionId).then((allowed) => {
          if (!allowed) {
            logger.warn({ serverId: this.serverId, sessionId }, 'chat.subscribe: session not owned by this server — rejected');
            return;
          }
          if (!this.isCurrentTransportSubscriptionRevision(ws, sessionId, revision)) return;
          if (ws.readyState !== WebSocket.OPEN) return;
          this.transportSubscriptions.get(ws)?.add(sessionId);
          // Client v2 can explicitly send forceHistory:false to repair the
          // transport live subscription after a foreground probe without
          // triggering daemon chat.history replay. Legacy clients omit the flag,
          // so their first subscribe keeps the old replay behavior.
          if (forceHistory || (!hasForceHistoryFlag && !alreadySubscribed)) {
            this.sendToDaemon(raw);
          }
        });
        return;
      }
      if (msg.type === TRANSPORT_MSG.CHAT_UNSUBSCRIBE && typeof msg.sessionId === 'string') {
        this.bumpTransportSubscriptionRevision(ws, msg.sessionId);
        this.transportSubscriptions.get(ws)?.delete(msg.sessionId);
        return;
      }

      if (browserMessageType === SHARE_BROWSER_COMMANDS.DISCUSSION_COMMENT && this.browserShareStates.has(ws)) {
        await this.handleShareDiscussionCommentCommand(ws, msg);
        return;
      }

      // ── command.ack reliability: intercept user sends and cancels ───────
      //
      // Three cases:
      //   1. daemon fully offline (past grace)       → immediately command.failed
      //   2. daemon transiently offline (in grace)   → buffer + replay on reconnect
      //   3. daemon online                           → forward + arm 5s ack timeout
      //
      // In all cases we record an inflight entry so that the later command.ack
      // (or timeout / disconnect) can correlate back to the right browser.
      if ((msg.type === 'session.send' || msg.type === DAEMON_COMMAND_TYPES.SESSION_CANCEL) && typeof msg.commandId === 'string') {
        const sessionName = typeof msg.sessionName === 'string'
          ? msg.sessionName
          : (typeof msg.session === 'string' ? msg.session : '');
        if (sessionName) {
          this.handleOutboundSessionSend(ws, msg.commandId, sessionName, raw);
          return;
        }
        // Malformed: no sessionName — fall through to regular forwarding,
        // the daemon will ignore it. Don't drop silently here.
      }

      this.sendToDaemon(raw);
    });

    ws.on('close', () => {
      this.cleanupBrowserSocket(ws);
      this.maybeCleanup();
    });

    ws.on('error', () => {
      this.cleanupBrowserSocket(ws);
      this.maybeCleanup();
    });
  }

  private async evaluateShareScopedBrowserCommand(
    ws: WebSocket,
    msg: Record<string, unknown>,
  ): Promise<ShareCommandDecision> {
    const state = this.browserShareStates.get(ws);
    if (!state) return { allowed: true };
    const coverage = await this.resolveLiveShareCoverage(state);
    if (!coverage) {
      const decision: ShareCommandDecision = {
        allowed: false,
        reason: this.shareStateLooksExpired(state) ? SHARE_REASONS.EXPIRED : SHARE_REASONS.REVOKED,
        closeSocket: true,
      };
      await this.auditShareScopedBrowserCommand(state, msg, decision);
      return {
        allowed: false,
        reason: decision.reason,
        closeSocket: true,
      };
    }
    await this.refreshShareActorDisplayName(ws);
    const refreshedState = this.browserShareStates.get(ws) ?? state;
    const current = await this.applyShareCoverage(ws, refreshedState, coverage);
    const sessionName = commandSessionName(msg);
    const runtimeType = sessionName ? await this.resolveSessionRuntimeType(sessionName) : 'unknown';
    const decision = evaluateShareCommand({
      msg,
      state: current,
      now: shareClockNow(),
      runtimeType,
      activeDispatchId: sessionName ? this.activeDispatchIds.get(sessionName) ?? null : null,
    });
    if (decision.allowed && sessionName) {
      const rateLimitReason = this.evaluateShareScopedRateLimit(current, msg, sessionName, shareClockNow());
      if (rateLimitReason) {
        const rateLimitedDecision: ShareCommandDecision = { allowed: false, reason: rateLimitReason };
        await this.auditShareScopedBrowserCommand(current, msg, rateLimitedDecision);
        return rateLimitedDecision;
      }
    }
    await this.auditShareScopedBrowserCommand(current, msg, decision);
    return decision;
  }

  private async handleShareDiscussionCommentCommand(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const state = this.browserShareStates.get(ws);
    if (!state || !this.db) return;
    const now = shareClockNow();
    const requestId = typeof msg.requestId === 'string' && msg.requestId.trim() ? msg.requestId.trim() : this.shareCommandActionId(msg);
    const actionId = requestId ?? `share-comment-${randomHex(8)}`;
    const target = await this.resolveShareDiscussionCommentTarget(state, msg);
    if (!target) {
      await this.auditShareDiscussionComment(state, state.target, actionId, 'rejected', 'share-target-unavailable', now);
      this.rejectShareScopedBrowserCommand(ws, { ...msg, commandId: actionId }, SHARE_REASONS.TARGET_UNAVAILABLE);
      return;
    }
    const body = typeof msg.body === 'string' ? msg.body.trim() : '';
    if (!body || body.length > 20_000) {
      await this.auditShareDiscussionComment(state, target, actionId, 'rejected', 'share-comment-invalid', now);
      this.rejectShareScopedBrowserCommand(ws, { ...msg, commandId: actionId }, SHARE_REASONS.COMMENT_INVALID);
      return;
    }

    const user = await getUserById(this.db, state.userId);
    const actor: SharedActorEnvelope = {
      actorUserId: state.userId,
      actorDisplayName: user?.display_name ?? user?.username ?? state.userId,
      snapshot: state.snapshot,
      primaryShareId: state.snapshot.primaryShareId,
      effectiveActorRole: state.snapshot.effectiveRole,
      actionId,
      origin: target.kind === 'server' ? 'shared-server' : 'shared-tab',
      authorizedAt: state.snapshot.authorizedAt,
      queuedAt: now,
    };
    const commentId = randomHex(16);
    const comment = await insertDiscussionComment(this.db, {
      id: commentId,
      serverId: this.serverId,
      threadId: typeof msg.threadId === 'string' && msg.threadId.trim() ? msg.threadId.trim() : null,
      scope: target,
      createdByUserId: state.userId,
      actorEnvelope: actor,
      authorizationSnapshot: state.snapshot,
      body,
      createdAt: now,
    });
    await this.auditShareDiscussionComment(state, target, actionId, 'accepted', null, now);
    this.broadcastShareDiscussionComment(target, {
      type: SHARE_DISCUSSION_EVENTS.COMMENT_CREATED,
      requestId: requestId ?? undefined,
      comment: toDiscussionCommentView(comment),
      targetRef: shareTargetRef(target),
    });
  }

  private async resolveShareDiscussionCommentTarget(
    state: ShareScopedSocketState,
    msg: Record<string, unknown>,
  ): Promise<ShareTarget | null> {
    if (!this.db) return null;
    let target = state.target;
    if (msg.scope && typeof msg.scope === 'object') {
      const normalized = await normalizeExistingShareTarget(this.db, msg.scope as ShareTargetInput);
      if (!normalized) return null;
      target = normalized;
    }
    if (target.serverId !== this.serverId) return null;
    if (state.target.kind !== 'server' && shareTargetKey(state.target) !== shareTargetKey(target)) return null;
    return target;
  }

  private async auditShareDiscussionComment(
    state: ShareScopedSocketState,
    target: ShareTarget,
    actionId: string,
    decision: 'accepted' | 'rejected',
    reason: ShareReason | null,
    now: number,
  ): Promise<void> {
    if (!this.db) return;
    try {
      const auditEventId = randomHex(16);
      await writeShareAuditEvent(this.db, {
        id: auditEventId,
        serverId: this.serverId,
        actorKind: 'user',
        actorUserId: state.userId,
        targetUserId: state.userId,
        effectiveActorRole: state.snapshot.effectiveRole,
        target,
        actionType: SHARE_BROWSER_COMMANDS.DISCUSSION_COMMENT,
        decision,
        reason,
        snapshot: state.snapshot,
        primaryShareId: state.snapshot.primaryShareId,
        actionId,
        idempotencyKey: deriveShareTransitionKey({
          actionType: SHARE_BROWSER_COMMANDS.DISCUSSION_COMMENT,
          target,
          primaryShareId: state.snapshot.primaryShareId,
          transitionEpochMs: now,
          decision,
          attemptId: auditEventId,
        }),
        createdAt: now,
      });
    } catch (err) {
      logger.error({ err, serverId: this.serverId, actionId }, 'Share discussion comment audit write failed');
    }
  }

  private async auditShareScopedBrowserCommand(
    state: ShareScopedSocketState,
    msg: Record<string, unknown>,
    decision: ShareCommandDecision,
  ): Promise<void> {
    if (!this.db) return;
    const actionType = this.shareAuditActionTypeForCommand(msg);
    if (!actionType) return;
    const now = shareClockNow();
    const sessionName = commandSessionName(msg);
    const target = sessionName
      ? shareTargetFromSessionName(this.serverId, sessionName) ?? state.target
      : state.target;
    const actionId = this.shareCommandActionId(msg);
    try {
      const auditEventId = randomHex(16);
      await writeShareAuditEvent(this.db, {
        id: auditEventId,
        serverId: this.serverId,
        actorKind: 'user',
        actorUserId: state.userId,
        targetUserId: state.userId,
        effectiveActorRole: state.snapshot.effectiveRole,
        target,
        actionType,
        decision: decision.allowed ? 'accepted' : 'rejected',
        reason: decision.allowed ? null : decision.reason,
        snapshot: state.snapshot,
        primaryShareId: state.snapshot.primaryShareId,
        actionId,
        idempotencyKey: deriveShareTransitionKey({
          actionType,
          target,
          primaryShareId: state.snapshot.primaryShareId,
          transitionEpochMs: now,
          decision: decision.allowed ? 'accepted' : 'rejected',
          attemptId: auditEventId,
        }),
        createdAt: now,
      });
    } catch (err) {
      logger.error({ err, serverId: this.serverId, actionType, actionId }, 'Share command audit write failed');
    }
  }

  private shareAuditActionTypeForCommand(msg: Record<string, unknown>): ShareAuditActionType | null {
    const type = typeof msg.type === 'string' ? msg.type : '';
    if (type === 'session.send') return 'session.send';
    if (type === DAEMON_COMMAND_TYPES.SESSION_CANCEL) return 'session.cancel';
    if (type === 'discussion.start') return 'p2p.orchestration';
    return null;
  }

  private shareCommandActionId(msg: Record<string, unknown>): string | null {
    for (const key of ['actionId', 'commandId', 'requestId']) {
      const value = msg[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  }

  private evaluateShareScopedRateLimit(
    state: ShareScopedSocketState,
    msg: Record<string, unknown>,
    sessionName: string,
    now: number,
  ): ShareReason | null {
    const type = typeof msg.type === 'string' ? msg.type : '';
    if (type !== 'session.send' && type !== DAEMON_COMMAND_TYPES.SESSION_CANCEL) return null;
    const commandId = typeof msg.commandId === 'string' ? msg.commandId.trim() : '';
    if (commandId && this.inflightCommands.has(commandId)) return null;
    if (type === 'session.send') {
      const pending = [...this.inflightCommands.values()].filter((entry) => (
        entry.share?.userId === state.userId
        && entry.sessionName === sessionName
        && this.rawPayloadType(entry.rawPayload) === 'session.send'
      )).length;
      return evaluateSharedCommandRateLimit({
        userId: state.userId,
        serverId: this.serverId,
        sessionName,
        commandType: 'session.send',
        now,
        pendingSendCount: pending,
      });
    }
    return evaluateSharedCommandRateLimit({
      userId: state.userId,
      serverId: this.serverId,
      sessionName,
      commandType: 'session.cancel',
      now,
    });
  }

  private rejectShareScopedBrowserCommand(
    ws: WebSocket,
    msg: Record<string, unknown>,
    reason: ShareReason,
  ): void {
    const sessionName = commandSessionName(msg);
    if ((msg.type === 'session.send' || msg.type === DAEMON_COMMAND_TYPES.SESSION_CANCEL) && typeof msg.commandId === 'string' && sessionName) {
      this.emitCommandFailed(ws, msg.commandId, sessionName, reason);
      return;
    }
    safeSend(ws, JSON.stringify({
      type: 'error',
      code: reason,
      reason,
      originalType: msg.type,
      requestId: msg.requestId,
    }));
  }

  private async resolveLiveShareCoverage(state: ShareScopedSocketState): Promise<EffectiveCoverage | null> {
    if (!this.db) return null;
    return this.shareCoverageResolver({
      db: this.db,
      serverId: this.serverId,
      userId: state.userId,
      target: state.target,
      now: shareClockNow(),
    });
  }

  private async applyShareCoverage(
    ws: WebSocket,
    state: ShareScopedSocketState,
    coverage: EffectiveCoverage,
  ): Promise<ShareScopedSocketState> {
    const next: ShareScopedSocketState = {
      ...state,
      target: coverage.target,
      snapshot: coverage,
      coveredSessionNames: await this.resolveShareCoveredSessionNames(coverage.target),
    };
    if (state.snapshot.effectiveRole !== coverage.effectiveRole) {
      safeSend(ws, JSON.stringify({
        type: 'share.role_changed',
        reason: SHARE_REASONS.ROLE_CHANGED,
        effectiveRole: coverage.effectiveRole,
        target: coverage.target,
      }));
    }
    this.browserShareStates.set(ws, next);
    return next;
  }

  private baseCoveredSessionNames(target: ShareTarget): string[] | undefined {
    if (target.kind === 'server') return undefined;
    if (target.kind === 'main') return [target.sessionName];
    return [`deck_sub_${target.subSessionId}`];
  }

  private async refreshShareCoveredSessions(ws: WebSocket): Promise<void> {
    const state = this.browserShareStates.get(ws);
    if (!state) return;
    const coveredSessionNames = await this.resolveShareCoveredSessionNames(state.target);
    const current = this.browserShareStates.get(ws);
    if (!current || current.ticketId !== state.ticketId) return;
    this.browserShareStates.set(ws, { ...current, coveredSessionNames });
  }

  private async refreshShareActorDisplayName(ws: WebSocket): Promise<void> {
    const state = this.browserShareStates.get(ws);
    if (!state || !this.db) return;
    if (state.actorDisplayName !== state.userId) return;
    try {
      const user = await getUserById(this.db, state.userId);
      const current = this.browserShareStates.get(ws);
      if (!current || current.ticketId !== state.ticketId) return;
      this.browserShareStates.set(ws, {
        ...current,
        actorDisplayName: user?.display_name ?? user?.username ?? current.userId,
      });
    } catch (err) {
      logger.warn({ err, serverId: this.serverId, userId: state.userId }, 'Failed to resolve share actor display name');
    }
  }

  private async resolveShareCoveredSessionNames(target: ShareTarget): Promise<string[] | undefined> {
    if (!this.db) return this.baseCoveredSessionNames(target);
    try {
      return await resolveCoveredSessionNames(this.db, target);
    } catch (err) {
      logger.warn({ err, serverId: this.serverId, target }, 'Failed to refresh covered share sub-sessions');
    }
    return this.baseCoveredSessionNames(target);
  }

  private shareStateLooksExpired(state: ShareScopedSocketState): boolean {
    const next = state.snapshot.nextCoverageRecheckAt;
    return typeof next === 'number' && shareClockNow() >= next;
  }

  private async revalidateShareSocket(ws: WebSocket): Promise<void> {
    const state = this.browserShareStates.get(ws);
    if (!state) return;
    const coverage = await this.resolveLiveShareCoverage(state);
    if (!coverage) {
      this.teardownShareSocket(ws, this.shareStateLooksExpired(state) ? SHARE_REASONS.EXPIRED : SHARE_REASONS.REVOKED);
      return;
    }
    await this.applyShareCoverage(ws, state, coverage);
  }

  private async sweepShareSockets(): Promise<void> {
    const now = shareClockNow();
    const candidates = [...this.browserShareStates]
      .filter(([, state]) => typeof state.snapshot.nextCoverageRecheckAt === 'number' && state.snapshot.nextCoverageRecheckAt <= now);
    await Promise.all(candidates.map(([ws]) => this.revalidateShareSocket(ws)));
  }

  private teardownShareSocket(ws: WebSocket, reason: ShareReason): void {
    safeSend(ws, JSON.stringify({ type: 'share.teardown', reason }));
    this.cleanupBrowserSocket(ws);
    try { ws.close(1008, reason); } catch { /* ignore */ }
  }

  private async resolveSessionRuntimeType(sessionName: string): Promise<'process' | 'transport' | 'unknown'> {
    const cached = this.sessionRuntimeTypes.get(sessionName);
    if (cached) return cached;
    const activeMain = this.activeMainSessions.get(sessionName);
    if (activeMain?.runtimeType) return this.normalizeRuntimeType(activeMain.runtimeType);
    const activeSub = this.activeSubSessions.get(sessionName);
    if (activeSub?.runtimeType) return this.normalizeRuntimeType(activeSub.runtimeType);
    if (!this.db) return 'unknown';
    try {
      const subSessionId = sessionName.match(/^deck_sub_([A-Za-z0-9_-]+)$/)?.[1];
      const row = subSessionId
        ? await this.db.queryOne<{ runtime_type: string | null }>(
          'SELECT runtime_type FROM sub_sessions WHERE server_id = $1 AND id = $2 LIMIT 1',
          [this.serverId, subSessionId],
        )
        : await this.db.queryOne<{ runtime_type: string | null }>(
          'SELECT runtime_type FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
          [this.serverId, sessionName],
        );
      const runtimeType = this.normalizeRuntimeType(row?.runtime_type ?? null);
      this.sessionRuntimeTypes.set(sessionName, runtimeType);
      return runtimeType;
    } catch {
      return 'unknown';
    }
  }

  private normalizeRuntimeType(value: string | null | undefined): 'process' | 'transport' | 'unknown' {
    if (value === 'process' || value === 'transport') return value;
    return 'unknown';
  }

  private updateActiveDispatchFromDaemonMessage(sessionId: string, msg: Record<string, unknown>): void {
    const directDispatchId = this.firstStringField(msg, ['activeDispatchId', 'runningTurnId', 'dispatchId', 'messageId']);
    if (directDispatchId && msg.type !== 'chat.complete' && msg.type !== 'chat.error') {
      this.activeDispatchIds.set(sessionId, directDispatchId);
      return;
    }
    if (msg.type === 'chat.status' && msg.status === 'idle') {
      this.activeDispatchIds.delete(sessionId);
      return;
    }
    if (msg.type === 'chat.complete' || msg.type === 'chat.error') {
      this.activeDispatchIds.delete(sessionId);
    }
  }

  private firstStringField(msg: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = msg[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  }

  private async handleBrowserSessionGroupCloneCommand(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const type = msg.type;
    const requestId = msg.requestId;
    const sendError = (code: string, extra: Record<string, unknown> = {}) => {
      safeSend(ws, JSON.stringify({
        type: 'error',
        code,
        error: code,
        originalType: type,
        ...(typeof requestId === 'string' ? { requestId } : {}),
        ...extra,
      }));
    };

    if (msg.serverId !== this.serverId) {
      sendError('invalid_request', { reason: 'serverId_required' });
      return;
    }

    const db = this.db;
    const userId = this.browserUserIds.get(ws)?.trim();
    if (!db || !userId) {
      sendError('forbidden');
      return;
    }

    const role = await resolveServerRole(db, this.serverId, userId);
    if (role !== 'owner' && role !== 'admin') {
      await writeSessionGroupCloneAudit(db, {
        userId,
        serverId: this.serverId,
        action: 'session_group_clone.forbidden',
        details: {
          role,
          sourceMainSessionName: typeof msg.sourceMainSessionName === 'string' ? msg.sourceMainSessionName : undefined,
          idempotencyKey: typeof msg.idempotencyKey === 'string' && msg.idempotencyKey.trim() ? msg.idempotencyKey.trim() : undefined,
          errorCode: 'forbidden',
        },
      });
      sendError('forbidden');
      return;
    }

    if (type === SESSION_GROUP_CLONE_MSG.START) {
      const duplicateEvent = this.getSessionGroupCloneOperationEvent(
        typeof msg.idempotencyKey === 'string' ? msg.idempotencyKey : '',
      );
      if (duplicateEvent) {
        this.broadcastToBrowsers(JSON.stringify(duplicateEvent));
        return;
      }
    }

    if (!this.hasDaemonCapability(SESSION_GROUP_CLONE_CAPABILITY_V1)) {
      sendError('unsupported_command', { missingCapability: SESSION_GROUP_CLONE_CAPABILITY_V1 });
      return;
    }

    if (type === SESSION_GROUP_CLONE_MSG.CANCEL) {
      const operationId = typeof msg.operationId === 'string' ? msg.operationId.trim() : '';
      const idempotencyKey = typeof msg.idempotencyKey === 'string' ? msg.idempotencyKey.trim() : '';
      if (!operationId && !idempotencyKey) {
        sendError('invalid_request', { reason: 'operationId_or_idempotencyKey_required' });
        return;
      }
      this.sendToDaemon(JSON.stringify({
        type: SESSION_GROUP_CLONE_MSG.CANCEL,
        serverId: this.serverId,
        ...(operationId ? { operationId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }));
      return;
    }

    const sourceMainSessionName = typeof msg.sourceMainSessionName === 'string' ? msg.sourceMainSessionName.trim() : '';
    const idempotencyKey = typeof msg.idempotencyKey === 'string' ? msg.idempotencyKey.trim() : '';
    const targetProjectName = readCloneOptionalString(msg, 'targetProjectName');
    const cwdOverride = readCloneOptionalString(msg, 'cwdOverride');
    if (!sourceMainSessionName || !idempotencyKey || !targetProjectName.ok || !cwdOverride.ok) {
      sendError('invalid_request');
      return;
    }
    if (typeof targetProjectName.value === 'string' && targetProjectName.value.trim() === '') {
      sendError('blank_target_project');
      return;
    }
    const targetMainSessionName = await this.findExplicitSessionGroupCloneTargetConflict(targetProjectName.value);
    if (targetMainSessionName) {
      await writeSessionGroupCloneAudit(db, {
        userId,
        serverId: this.serverId,
        action: 'session_group_clone.failed',
        details: {
          role,
          sourceMainSessionName,
          idempotencyKey,
          targetProjectSlug: typeof targetProjectName.value === 'string' && targetProjectName.value.trim()
            ? sanitizeProjectName(targetProjectName.value.trim())
            : undefined,
          errorCode: 'name_taken',
        },
      });
      sendError('name_taken', { targetMainSessionName });
      return;
    }

    const payload: Record<string, unknown> = {
      type: SESSION_GROUP_CLONE_MSG.START,
      serverId: this.serverId,
      sourceMainSessionName,
      idempotencyKey,
    };
    if (targetProjectName.value !== undefined) payload.targetProjectName = targetProjectName.value;
    if (cwdOverride.value !== undefined) payload.cwdOverride = cwdOverride.value;
    const unavailableSessionNames = await this.getServerVisibleSessionNames();
    if (unavailableSessionNames.length > 0) payload.unavailableSessionNames = unavailableSessionNames;
    this.registerSessionGroupCloneOperationContext({ idempotencyKey, userId, sourceMainSessionName });
    this.sendToDaemon(JSON.stringify(payload));
    await writeSessionGroupCloneAudit(db, {
      userId,
      serverId: this.serverId,
      action: 'session_group_clone.accepted',
      details: {
        role,
        sourceMainSessionName,
        idempotencyKey,
        targetProjectSlug: typeof targetProjectName.value === 'string' && targetProjectName.value.trim()
          ? sanitizeProjectName(targetProjectName.value.trim())
          : undefined,
      },
    });
  }

  private auditSessionGroupCloneTerminalEvent(event: SessionGroupCloneEvent): void {
    if (!this.db || !SESSION_GROUP_CLONE_TERMINAL_STATES.has(event.state)) return;
    const result = event.result;
    void writeSessionGroupCloneAudit(this.db, {
      serverId: this.serverId,
      action: `session_group_clone.${event.state}`,
      details: {
        operationId: event.operationId,
        idempotencyKey: event.idempotencyKey,
        sourceMainSessionName: event.sourceMainSessionName ?? result?.sourceMainSession,
        clonedMainSessionName: event.clonedMainSessionName ?? result?.clonedMainSession,
        targetProjectSlug: result?.targetProjectSlug,
        clonedSubSessionCount: result?.copiedSubSessionIds.length,
        skippedCronJobs: event.skippedCronJobs ?? result?.skippedCronJobs,
        skippedOrchestrationRuns: event.skippedOrchestrationRuns ?? result?.skippedOrchestrationRuns,
        errorCode: event.errorCode,
        cleanupRequired: event.cleanupRequired === true ? true : undefined,
        cleanupResources: event.cleanupResources?.map((resource) => ({
          kind: resource.kind,
          id: resource.id,
          sessionName: resource.sessionName,
          serverId: resource.serverId,
          providerId: resource.providerId,
          retriable: resource.retriable,
        })),
      },
    });
  }

  private async prepareSucceededSessionGroupCloneEvent(event: SessionGroupCloneEvent): Promise<SessionGroupCloneEvent> {
    let finalEvent = event;
    try {
      const counts = await this.countSkippedScheduledWorkForClone(event);
      if (counts) finalEvent = mergeSkippedScheduledWorkCounts(event, counts);
    } catch (err) {
      logger.warn({ err, serverId: this.serverId, operationId: event.operationId }, 'session-group clone skipped scheduled-work count failed');
    }

    try {
      await this.copyServerSyncedP2pConfigForClone(finalEvent);
    } catch (err) {
      const cleanupResources = err instanceof SessionGroupCloneServerP2pError ? err.cleanupResources : [];
      logger.warn({ err, serverId: this.serverId, operationId: event.operationId }, 'session-group clone server-synced P2P preference copy failed');
      finalEvent = {
        ...finalEvent,
        state: 'cleanup_required',
        errorCode: 'server_p2p_commit_failed',
        cleanupRequired: true,
        ...(cleanupResources.length ? { cleanupResources } : {}),
      };
    }
    return finalEvent;
  }

  private async countSkippedScheduledWorkForClone(event: SessionGroupCloneEvent): Promise<{
    skippedCronJobs: number;
    skippedOrchestrationRuns: number;
  } | null> {
    const db = this.db;
    const result = event.result;
    if (!db || !result) return null;

    const sourceSessionNames = Array.from(new Set([
      ...Object.keys(result.sessionNameMap),
      result.sourceMainSession,
      event.sourceMainSessionName,
    ].filter((name): name is string => typeof name === 'string' && name.length > 0)));
    if (!sourceSessionNames.length) return null;

    const sourceProjectSlug = sourceProjectSlugFromMainSessionName(result.sourceMainSession || event.sourceMainSessionName);
    const cronRow = await db.queryOne<Record<string, unknown>>(
      `SELECT COUNT(*)::int AS count
       FROM cron_jobs
       WHERE server_id = $1
         AND (
           target_session_name = ANY($2)
           OR ($3::text IS NOT NULL AND target_role = $4 AND project_name = $3)
         )`,
      [this.serverId, sourceSessionNames, sourceProjectSlug, 'brain'],
    );
    const orchestrationRow = await db.queryOne<Record<string, unknown>>(
      `SELECT COUNT(*)::int AS count
       FROM discussion_orchestration_runs
       WHERE server_id = $1
         AND (
           main_session = ANY($2)
           OR initiator_session = ANY($2)
           OR current_target_session = ANY($2)
           OR final_return_session = ANY($2)
         )`,
      [this.serverId, sourceSessionNames],
    );

    return {
      skippedCronJobs: numericCount(cronRow),
      skippedOrchestrationRuns: numericCount(orchestrationRow),
    };
  }

  private async copyServerSyncedP2pConfigForClone(event: SessionGroupCloneEvent): Promise<void> {
    const db = this.db;
    const result = event.result;
    if (!db || event.state !== 'succeeded' || !result) return;

    this.pruneSessionGroupCloneContexts();
    const context = this.sessionGroupCloneContexts.get(event.idempotencyKey);
    if (!context) return;

    const sourceMainSessionName = result.sourceMainSession || event.sourceMainSessionName || context.sourceMainSessionName;
    const source = await getUserP2pConfigForRoot(db, context.userId, this.serverId, sourceMainSessionName);
    if (!source) return;

    const targetKey = p2pSessionConfigPrefKey(result.clonedMainSession, this.serverId);
    const previousTargetValue = await getUserPref(db, context.userId, targetKey);
    const remapped = cloneP2pConfigWithSessionRemap(source.config, result.sessionNameMap, Date.now(), {
      sourceGroupSessionNames: [
        ...Object.keys(result.sessionNameMap),
        ...result.skippedMembers.map((member) => member.sessionName),
      ],
    });

    try {
      await setUserPref(db, context.userId, targetKey, JSON.stringify(remapped.config));
      this.sendToDaemon(JSON.stringify({
        type: P2P_CONFIG_MSG.SAVE,
        requestId: `session-group-clone:${event.operationId}`,
        scopeSession: result.clonedMainSession,
        config: remapped.config,
      }));
      await writeSessionGroupCloneAudit(db, {
        userId: context.userId,
        serverId: this.serverId,
        action: 'session_group_clone.p2p_config_copied',
        details: {
          operationId: event.operationId,
          idempotencyKey: event.idempotencyKey,
          sourceMainSessionName,
          clonedMainSessionName: result.clonedMainSession,
          sourcePreferenceKey: source.key,
          targetPreferenceKey: targetKey,
          warningCount: remapped.warnings.length,
        },
      });
    } catch (err) {
      try {
        if (previousTargetValue === null) {
          await deleteUserPref(db, context.userId, targetKey);
        } else {
          await setUserPref(db, context.userId, targetKey, previousTargetValue);
        }
      } catch (restoreErr) {
        logger.warn({ err: restoreErr, serverId: this.serverId, targetKey }, 'session-group clone P2P preference rollback failed');
      }
      logger.warn({ err, serverId: this.serverId, operationId: event.operationId }, 'session-group clone server-synced P2P preference copy failed');
      await writeSessionGroupCloneAudit(db, {
        userId: context.userId,
        serverId: this.serverId,
        action: 'session_group_clone.p2p_config_failed',
        details: {
          operationId: event.operationId,
          idempotencyKey: event.idempotencyKey,
          sourceMainSessionName,
          clonedMainSessionName: result.clonedMainSession,
        },
      });
      throw new SessionGroupCloneServerP2pError('server-synced P2P preference copy failed', [{
        kind: 'server_p2p_pref',
        id: targetKey,
        sessionName: result.clonedMainSession,
        serverId: this.serverId,
        retriable: true,
      }]);
    }
  }

  private registerP2pWorkflowRequest(
    ws: WebSocket,
    msg: Record<string, unknown>,
    descriptor: P2pWorkflowMessageDescriptor,
  ): boolean {
    if (!isP2pWorkflowRequestId(msg.requestId)) {
      incrementCounter('p2p.bridge.invalid_request_id_drop', { type: descriptor.type });
      logger.warn({ serverId: this.serverId, type: descriptor.type }, 'p2p request missing valid requestId — dropped');
      safeSend(ws, JSON.stringify({
        type: 'error',
        code: P2P_BRIDGE_ERROR_CODES.INVALID_REQUEST_ID,
        originalType: descriptor.type,
        requestId: msg.requestId,
      }));
      return false;
    }
    const expectedResponseType = descriptor.expectedResponseType;
    if (!expectedResponseType) {
      incrementCounter('p2p.bridge.route_policy_drop', { direction: 'browser_to_daemon', type: descriptor.type });
      logger.warn({ serverId: this.serverId, type: descriptor.type }, 'p2p request missing expected response policy — dropped');
      safeSend(ws, JSON.stringify({
        type: 'error',
        code: P2P_BRIDGE_ERROR_CODES.ROUTE_POLICY_ERROR,
        originalType: descriptor.type,
        requestId: msg.requestId,
      }));
      return false;
    }

    const requestId = msg.requestId;
    const existing = this.pendingP2pWorkflowRequests.get(requestId);
    if (existing) {
      incrementCounter('p2p.bridge.duplicate_request_id_drop', { type: descriptor.type });
      logger.warn({ serverId: this.serverId, type: descriptor.type, requestId }, 'p2p duplicate active requestId — dropped');
      safeSend(ws, JSON.stringify({
        type: 'error',
        code: P2P_BRIDGE_ERROR_CODES.DUPLICATE_REQUEST_ID,
        originalType: descriptor.type,
        requestId,
      }));
      return false;
    }

    let socketPendingCount = 0;
    for (const pending of this.pendingP2pWorkflowRequests.values()) {
      if (pending.socket === ws) socketPendingCount += 1;
    }
    if (socketPendingCount >= P2P_BRIDGE_PENDING_REQUESTS_PER_SOCKET) {
      incrementCounter('p2p.bridge.pending_request_cap_drop', { scope: 'socket', type: descriptor.type });
      logger.warn({ serverId: this.serverId, type: descriptor.type, requestId }, 'p2p per-socket pending cap exceeded — dropped');
      safeSend(ws, JSON.stringify({
        type: 'error',
        code: P2P_BRIDGE_ERROR_CODES.PENDING_LIMIT_EXCEEDED,
        scope: 'socket',
        originalType: descriptor.type,
        requestId,
      }));
      return false;
    }
    if (this.pendingP2pWorkflowRequests.size >= P2P_BRIDGE_PENDING_REQUESTS_GLOBAL) {
      incrementCounter('p2p.bridge.pending_request_cap_drop', { scope: 'global', type: descriptor.type });
      logger.warn({ serverId: this.serverId, type: descriptor.type, requestId }, 'p2p global pending cap exceeded — dropped');
      safeSend(ws, JSON.stringify({
        type: 'error',
        code: P2P_BRIDGE_ERROR_CODES.PENDING_LIMIT_EXCEEDED,
        scope: 'global',
        originalType: descriptor.type,
        requestId,
      }));
      return false;
    }

    const timer = setTimeout(() => this.pendingP2pWorkflowRequests.delete(requestId), P2P_BRIDGE_PENDING_REQUEST_TIMEOUT_MS);
    this.pendingP2pWorkflowRequests.set(requestId, {
      socket: ws,
      timer,
      requestType: descriptor.type,
      expectedResponseType,
      createdAt: Date.now(),
    });
    return true;
  }

  // ── Relay helpers ──────────────────────────────────────────────────────────

  /**
   * Relay a daemon→browser message. Default-allow: unrecognised types are
   * broadcast to all browsers. Session-scoped types still require a session
   * identifier (missing → discard + warn). DB-only types (discussion.save,
   * subsession.sync, etc.) are consumed server-side and never forwarded.
   */
  private relayToBrowsers(msg: Record<string, unknown>): void {
    const type = msg.type as string;

    if (type === SESSION_GROUP_CLONE_MSG.EVENT) {
      const event = sanitizeSessionGroupCloneEvent(msg);
      if (!event) {
        logger.warn({ serverId: this.serverId }, 'session group clone event malformed — discarded');
        return;
      }
      if (event.state === 'succeeded') {
        void this.prepareSucceededSessionGroupCloneEvent(event)
          .then((finalEvent) => {
            this.auditSessionGroupCloneTerminalEvent(finalEvent);
            this.rememberSessionGroupCloneOperationEvent(finalEvent);
            this.broadcastToBrowsers(JSON.stringify(finalEvent));
          });
        return;
      }
      this.auditSessionGroupCloneTerminalEvent(event);
      this.rememberSessionGroupCloneOperationEvent(event);
      this.broadcastToBrowsers(JSON.stringify(event));
      return;
    }

    const p2pDaemonMessage = parseP2pWorkflowMessageType(type);
    if (p2pDaemonMessage.kind === 'known' && !p2pDaemonMessage.descriptor.allowedIngress.includes('daemon')) {
      incrementCounter('p2p.bridge.wrong_peer_drop', { direction: 'daemon_to_browser', type });
      logger.warn({ serverId: this.serverId, type }, 'daemon attempted disallowed p2p route — dropped');
      return;
    }
    if (p2pDaemonMessage.kind === 'known' && p2pDaemonMessage.descriptor.response && p2pDaemonMessage.descriptor.requestScoped) {
      const requestId = msg.requestId;
      if (!isP2pWorkflowRequestId(requestId)) {
        incrementCounter('p2p.bridge.unrouted_response_drop', { type });
        logger.warn({ serverId: this.serverId, type, requestId }, 'p2p response missing valid requestId — dropped');
        return;
      }
      const pending = this.pendingP2pWorkflowRequests.get(requestId);
      if (!pending) {
        incrementCounter('p2p.bridge.unrouted_response_drop', { type });
        logger.warn({ serverId: this.serverId, type, requestId }, 'p2p response missing pending request — dropped');
        return;
      }
      if (pending.expectedResponseType !== type) {
        incrementCounter('p2p.bridge.response_type_mismatch_drop', {
          expected: pending.expectedResponseType,
          received: type,
          requestType: pending.requestType,
        });
        logger.warn({
          serverId: this.serverId,
          requestId,
          requestType: pending.requestType,
          expectedResponseType: pending.expectedResponseType,
          receivedResponseType: type,
          createdAt: pending.createdAt,
        }, 'p2p response type mismatch — dropped without clearing pending request');
        return;
      }
      clearTimeout(pending.timer);
      this.pendingP2pWorkflowRequests.delete(requestId);
      if (pending.socket.readyState === WebSocket.OPEN) {
        pending.socket.send(JSON.stringify(msg));
      }
      return;
    }

    // ── Preview WS tunnel control messages ──────────────────────────────────
    if (type === PREVIEW_MSG.WS_OPENED) {
      this.resolvePreviewWsOpened(msg as unknown as PreviewWsOpenedMessage);
      return;
    }
    if (type === PREVIEW_MSG.WS_ERROR) {
      this.handlePreviewWsError(msg as unknown as PreviewWsErrorMessage);
      return;
    }
    if (type === PREVIEW_MSG.WS_CLOSE) {
      this.handlePreviewWsClose(msg as unknown as PreviewWsCloseMessage);
      return;
    }

    if (type === PREVIEW_MSG.RESPONSE_START) {
      this.resolvePreviewStart(msg as unknown as PreviewResponseStartMessage);
      return;
    }

    if (type === PREVIEW_MSG.RESPONSE_END) {
      this.completePreviewRequest((msg.requestId as string | undefined) ?? '', PREVIEW_TERMINAL_OUTCOME.RESPONSE_END);
      return;
    }

    if (type === PREVIEW_MSG.ERROR) {
      this.failPreviewRequest(msg as unknown as PreviewErrorMessage);
      return;
    }

    if (isMemoryManagementResponseType(type)) {
      const requestId = msg.requestId as string | undefined;
      const pending = requestId ? this.pendingMemoryManagementRequests.get(requestId) : undefined;
      if (!requestId || !pending) {
        incrementCounter('mem.bridge.unrouted_response', { type: String(type) });
        logger.warn({ serverId: this.serverId, type, requestId }, 'memory management response missing pending request — dropped');
        return;
      }
      this.clearPendingMemoryManagementRequest(requestId);
      if (pending.socket.readyState === WebSocket.OPEN) {
        pending.socket.send(JSON.stringify(msg));
      }
      return;
    }

    // ── fs.ls_response: single-cast back to requesting browser ────────────────
    if (type === 'fs.ls_response') {
      this.forwardPendingFsRoute('fs.ls', msg.requestId as string | undefined, msg);
      return;
    }

    // ── fs.read_response: single-cast back to requesting browser ─────────────
    if (type === 'fs.read_response') {
      this.forwardPendingFsRoute('fs.read', msg.requestId as string | undefined, msg);
      return;
    }

    // ── fs.git_status_response: single-cast back to requesting browser ────────
    if (type === 'fs.git_status_response') {
      this.forwardPendingFsRoute('fs.git_status', msg.requestId as string | undefined, msg);
      return;
    }

    // ── fs.git_diff_response: single-cast back to requesting browser ──────────
    if (type === 'fs.git_diff_response') {
      this.forwardPendingFsRoute('fs.git_diff', msg.requestId as string | undefined, msg);
      return;
    }

    // ── fs.write_response: single-cast back to requesting browser ────────────
    if (type === 'fs.write_response') {
      this.forwardPendingFsRoute('fs.write', msg.requestId as string | undefined, msg);
      return;
    }

    // ── file.search_response: single-cast back to requesting browser ─────────
    if (type === 'file.search_response') {
      this.forwardPendingFsRoute('file.search', msg.requestId as string | undefined, msg);
      return;
    }

    // ── File transfer responses: resolve HTTP handler Promises ─────────────────
    if (type === 'file.upload_progress') {
      const requestId = msg.uploadId as string | undefined;
      if (requestId) this.notifyFileTransferProgress(requestId, msg);
      return;
    }
    if (type === 'file.upload_done' || type === 'file.upload_error') {
      const requestId = msg.uploadId as string | undefined;
      if (requestId) this.resolveFileTransfer(requestId, msg);
      return;
    }
    if (type === 'file.download_done' || type === 'file.download_error') {
      const requestId = msg.downloadId as string | undefined;
      if (requestId) this.resolveFileTransfer(requestId, msg);
      return;
    }

    // ── memory.get_sources response: resolve HTTP /api/memory/sources caller ─
    // Mirrors the file-transfer pattern: a server-side route awaits a daemon
    // reply via a requestId-keyed pending map. See
    // openspec/changes/memory-source-server-routing.
    if (type === MEMORY_WS.GET_SOURCES_RESPONSE) {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined;
      if (requestId) this.resolveMemorySources(requestId, msg);
      return;
    }

    // ── Terminal diff: session-scoped ─────────────────────────────────────────
    if (type === 'terminal_update') {
      const sessionName = (msg.diff as Record<string, unknown> | undefined)?.sessionName as string | undefined;
      if (!sessionName) {
        logger.warn({ serverId: this.serverId }, 'terminal_update missing sessionName — discarded');
        return;
      }
      this.sendToSessionSubscribers(sessionName, JSON.stringify({ ...msg, type: 'terminal.diff' }));
      return;
    }

    // ── Lifecycle events: broadcast whitelist ─────────────────────────────────
    if (type === 'session_event') {
      this.broadcastToBrowsers(JSON.stringify({ ...msg, type: 'session.event' }));
      return;
    }

      if (type === 'session_list') {
        this.replaceActiveMainSessions(msg.sessions);
        this.pruneMainSessionRecentText(msg.sessions);
        this.broadcastToBrowsers(JSON.stringify({
        ...msg,
        daemonVersion: typeof msg.daemonVersion === 'string' ? msg.daemonVersion : this.daemonVersion,
      }));
      return;
    }

    // ── Timeline events: session-scoped ───────────────────────────────────────
    if (type === TIMELINE_MESSAGES.EVENT) {
      const rawEvent = msg.event as Record<string, unknown> | undefined;
      const sessionId = rawEvent?.sessionId as string | undefined;
      if (!rawEvent || !sessionId) {
        logger.warn({ serverId: this.serverId }, 'timeline event missing sessionId - discarded');
        return;
      }
      if (rawEvent.type === 'user.message') {
        const payload = rawEvent.payload as Record<string, unknown> | undefined;
        const commandId = typeof payload?.commandId === 'string'
          ? payload.commandId
          : typeof payload?.clientMessageId === 'string'
            ? payload.clientMessageId
            : '';
        if (commandId) this.clearInflightOnAuthoritativeEcho(commandId);
      }
      if (rawEvent.type === 'session.state') {
        const payload = rawEvent.payload as Record<string, unknown> | undefined;
        if (payload?.state === 'idle') this.activeDispatchIds.delete(sessionId);
      }
      this.ingestRecentTextFromTimelineEvent(rawEvent);
      if (this.db) {
        void upsertSessionTextTailCacheEvent(this.db, this.serverId, rawEvent)
          .catch((err) => logger.warn({ err, serverId: this.serverId, sessionId }, 'Failed to update session_text_tail_cache'));
      }
      // Bypass TerminalForwardQueue: timeline events are control-plane and
      // must never queue behind PTY data. Critical for cancel/stop UX —
      // session.state(idle) used to arrive seconds after the push notification.
      this.sendJsonToSessionSubscribers(sessionId, JSON.stringify(msg));
      return;
    }

    // Timeline history/replay/page/detail responses are data-plane. Defer
    // stringify/send so later control-plane messages can jump ahead, while
    // requestId responses remain unicast to browser or HTTP callers.
    if (TIMELINE_RESPONSE_TYPES.has(type)) {
      this.handleTimelineDataPlaneResponse(msg, type);
      return;
    }

    // ── Command & subsession: session-scoped ──────────────────────────────────
    if (type === MSG_COMMAND_ACK) {
      const sessionName = msg.session as string | undefined;
      if (!sessionName) {
        logger.warn({ serverId: this.serverId }, 'command.ack missing session — discarded');
        return;
      }
      const commandId = typeof msg.commandId === 'string' ? msg.commandId : null;
      if (commandId) {
        // Dedup replayed acks from daemon outbox flush (sticky-pod keeps this
        // LRU authoritative within a pod lifetime).
        if (this.seenCommandAcks.has(commandId) && !this.inflightCommands.has(commandId)) {
          logger.debug({ serverId: this.serverId, commandId }, 'command.ack dedup — dropping replay');
          return;
        }
        this.seenCommandAcks.set(commandId, Date.now());
        this.clearInflightOnAck(commandId);
      }
      // Control-plane: bypass the PTY queue. command.ack drives the UI
      // optimistic-bubble state — must never head-of-line block.
      this.sendJsonToSessionSubscribers(sessionName, JSON.stringify(msg));
      return;
    }

    // subsession.shells — broadcast to all browsers (response to detect_shells)
    if (type === 'subsession.shells') {
      this.broadcastToBrowsers(JSON.stringify(msg));
      return;
    }

    if (type === 'subsession.response') {
      const sessionName = msg.sessionName as string | undefined;
      if (!sessionName) {
        logger.warn({ serverId: this.serverId }, 'subsession.response missing sessionName — discarded');
        return;
      }
      // Control-plane: bypass the PTY queue.
      this.sendJsonToSessionSubscribers(sessionName, JSON.stringify(msg));
      return;
    }

    // ── Session notifications: session-scoped ─────────────────────────────────
    if (type === 'session.idle' || type === 'session.notification' || type === 'session.tool') {
      const sessionName = msg.session as string | undefined;
      if (!sessionName) {
        logger.warn({ serverId: this.serverId, type }, 'session notification missing session — discarded');
        return;
      }
      // Control-plane: bypass the PTY queue. session.idle is the WS twin
      // of the cancel/stop push notification — must arrive without queueing
      // behind PTY frames so the browser spinner clears in lockstep with
      // the push.
      this.sendJsonToSessionSubscribers(sessionName, JSON.stringify(msg));
      return;
    }

    // ── Sub-session sync: daemon creates sub-sessions → persist to DB ────────
    if (type === 'subsession.sync' && this.db) {
      const db = this.db;
      if (isKnownTestSessionLike({
        name: typeof msg.id === 'string' ? `deck_sub_${msg.id}` : undefined,
        cwd: typeof msg.cwd === 'string' ? msg.cwd : undefined,
        parentSession: typeof msg.parentSession === 'string' ? msg.parentSession : undefined,
      })) {
        return;
      }
      const subSessionName = `deck_sub_${String(msg.id ?? '')}`;
      if (subSessionName !== 'deck_sub_') {
        const label = typeof msg.label === 'string' && msg.label.trim() ? msg.label.trim() : undefined;
        const parentSession = typeof msg.parentSession === 'string' && msg.parentSession ? msg.parentSession : undefined;
        const agentType = typeof msg.sessionType === 'string' && msg.sessionType ? msg.sessionType : undefined;
        const runtimeType = typeof msg.runtimeType === 'string'
          ? msg.runtimeType
          : agentType
            ? getSessionRuntimeType(agentType)
            : undefined;
        this.activeSubSessions.set(subSessionName, { name: subSessionName, label, parentSession, agentType, runtimeType });
        this.sessionRuntimeTypes.set(subSessionName, this.normalizeRuntimeType(runtimeType));
        if (msg.state === 'idle') this.activeDispatchIds.delete(subSessionName);
      }
      void (async () => {
        const requestedType = typeof msg.sessionType === 'string' && msg.sessionType.trim()
          ? msg.sessionType.trim()
          : null;
        const persisted = requestedType ? null : await getSubSessionById(db, msg.id as string, this.serverId).catch(() => null);
        const sessionType = requestedType ?? persisted?.type ?? null;
        if (!sessionType) {
          logger.warn({ id: msg.id }, 'Skipping sub-session DB sync without sessionType');
          return;
        }
        const persistedRuntimeType = typeof msg.runtimeType === 'string'
          ? msg.runtimeType
          : sessionType
            ? getSessionRuntimeType(sessionType)
            : null;
        await createSubSession(
          db,
          msg.id as string,
          this.serverId,
          sessionType,
          (msg.shellBin as string) || null,
          (msg.cwd as string) || null,
          (msg.label as string) || null,
          (msg.ccSessionId as string) || null,
          (msg.geminiSessionId as string) || null,
          (msg.parentSession as string) || null,
          persistedRuntimeType,
          (msg.providerId as string) || null,
          (msg.providerSessionId as string) || null,
          (msg.description as string) || null,
          (msg.ccPresetId as string) || null,
          (msg.requestedModel as string) || null,
          ((msg.activeModel as string) || (msg.modelDisplay as string)) || null,
          (msg.effort as string) || null,
          (msg.transportConfig as Record<string, unknown>) || null,
        );
        // Notify browsers so sub-session appears immediately without page refresh
        this.broadcastToBrowsers(JSON.stringify({
          type: 'subsession.created',
          id: msg.id,
          sessionName: `deck_sub_${msg.id}`,
          sessionType,
          cwd: msg.cwd || null,
          label: msg.label || null,
          parentSession: msg.parentSession || null,
          ccPresetId: (msg.ccPresetId as string) || null,
          runtimeType: persistedRuntimeType,
          providerId: msg.providerId || null,
          providerSessionId: msg.providerSessionId || null,
          requestedModel: msg.requestedModel || null,
          activeModel: msg.activeModel || msg.modelDisplay || null,
          effort: msg.effort || null,
          transportConfig: msg.transportConfig || null,
          qwenModel: msg.qwenModel || null,
          qwenAuthType: msg.qwenAuthType || null,
          qwenAvailableModels: msg.qwenAvailableModels || null,
          modelDisplay: msg.modelDisplay || null,
          planLabel: msg.planLabel || null,
          quotaLabel: msg.quotaLabel || null,
          quotaUsageLabel: msg.quotaUsageLabel || null,
          quotaMeta: msg.quotaMeta || null,
          state: (msg.state as string) || 'idle',
        }));
      })().catch((e) => logger.error({ err: e, id: msg.id }, 'Failed to sync sub-session to DB'));
      return;
    }
    if (type === 'subsession.update_gemini_id' && this.db) {
      void updateSubSession(this.db, msg.id as string, this.serverId, {
        gemini_session_id: msg.geminiSessionId as string,
      }).catch((e) => logger.error({ err: e, id: msg.id }, 'Failed to update gemini_session_id'));
      return;
    }
    if (type === 'subsession.close' && this.db) {
      void updateSubSession(this.db, msg.id as string, this.serverId, { closed_at: Date.now() })
        .catch((e) => logger.error({ err: e, id: msg.id }, 'Failed to close sub-session in DB'));
      return;
    }

    // ── Discussion persistence: daemon → DB (not relayed to browsers) ────────
    if (type === 'discussion.save' && this.db) {
      void upsertDiscussion(this.db, {
        id: msg.id as string,
        serverId: this.serverId,
        topic: msg.topic as string,
        state: msg.state as string,
        maxRounds: msg.maxRounds as number,
        currentRound: (msg.currentRound as number) ?? 0,
        totalRounds: (msg.totalRounds as number) ?? 1,
        completedHops: (msg.completedHops as number) ?? 0,
        totalHops: (msg.totalHops as number) ?? 0,
        currentSpeaker: (msg.currentSpeaker as string) || null,
        participants: (msg.participants as string) || null,
        filePath: (msg.filePath as string) || null,
        conclusion: (msg.conclusion as string) || null,
        fileContent: (msg.fileContent as string) || null,
        error: (msg.error as string) || null,
        startedAt: msg.startedAt as number,
        finishedAt: (msg.finishedAt as number) || null,
      }).catch((e) => logger.error({ err: e, discussionId: msg.id }, 'Failed to save discussion'));
      return;
    }
    if (type === 'discussion.round_save' && this.db) {
      void insertDiscussionRound(this.db, {
        id: msg.roundId as string,
        discussionId: msg.discussionId as string,
        serverId: this.serverId,
        round: msg.round as number,
        speakerRole: msg.speakerRole as string,
        speakerAgent: msg.speakerAgent as string,
        speakerModel: (msg.speakerModel as string) || null,
        response: msg.response as string,
      }).catch((e) => logger.error({ err: e, discussionId: msg.discussionId }, 'Failed to save discussion round'));
      return;
    }

    // ── Discussion messages: broadcast to all browsers ────────────────────────
    if (
      type === 'discussion.started' ||
      type === 'discussion.update' ||
      type === 'discussion.done' ||
      type === 'discussion.error' ||
      type === 'discussion.list'
    ) {
      this.broadcastToBrowsers(JSON.stringify(msg));
      return;
    }

    // ── Sub-session closed by daemon → mark in DB + notify browsers ─────────
    if (type === 'subsession.closed' && this.db) {
      const id = msg.id as string;
      if (id) {
        void this.db.execute('UPDATE sub_sessions SET closed_at = $1 WHERE id = $2 AND server_id = $3',
          [Date.now(), id, this.serverId])
          .then(() => {
            const sessionName = `deck_sub_${id}`;
            this.recentTextBySession.delete(sessionName);
            this.activeSubSessions.delete(sessionName);
            this.broadcastToBrowsers(JSON.stringify({ type: 'subsession.removed', id, sessionName: msg.sessionName }));
            void this.revalidateShareSocketsForTarget({ kind: 'subsession', serverId: this.serverId, subSessionId: id });
          })
          .catch((err) => {
            logger.error({ err, id, sessionName: msg.sessionName }, 'Failed to persist sub-session close from daemon');
          });
      }
      return;
    }

    // ── P2P conflict → broadcast to browsers ────────────────────────────────
    if (type === P2P_WORKFLOW_MSG.CONFLICT) {
      this.broadcastToBrowsers(JSON.stringify(msg));
      return;
    }

    // ── Cron→P2P linking: update execution detail with discussion ID ──────
    if (type === 'cron.p2p_linked' && this.db) {
      const { jobId, discussionId } = msg as { jobId: string; discussionId: string };
      if (jobId && discussionId) {
        void this.db.execute(
          `UPDATE cron_executions SET detail = $1 WHERE id = (
             SELECT id FROM cron_executions WHERE job_id = $2 ORDER BY created_at DESC LIMIT 1
           )`,
          [`p2p:${discussionId}`, jobId],
        ).catch(() => {});
      }
      this.broadcastToBrowsers(JSON.stringify({ type: 'cron.p2p_linked', jobId, discussionId }));
      return;
    }

    // ── Cron command result: update execution detail with agent response ──
    if (type === 'cron.command_result' && this.db) {
      const { jobId, executionId, detail, status } = msg as { jobId: string; executionId?: string; detail: string; status?: string };
      if (jobId && detail) {
        const params: unknown[] = [detail.slice(0, 4000)];
        let sql = '';
        if (executionId) {
          if (status) {
            sql = 'UPDATE cron_executions SET detail = $1, status = $2 WHERE id = $3';
            params.push(status, executionId);
          } else {
            sql = 'UPDATE cron_executions SET detail = $1 WHERE id = $2';
            params.push(executionId);
          }
        } else if (status) {
          sql = `UPDATE cron_executions SET detail = $1, status = $2 WHERE id = (
             SELECT id FROM cron_executions WHERE job_id = $3 ORDER BY created_at DESC LIMIT 1
           )`;
          params.push(status, jobId);
        } else {
          sql = `UPDATE cron_executions SET detail = $1 WHERE id = (
             SELECT id FROM cron_executions WHERE job_id = $2 ORDER BY created_at DESC LIMIT 1
           )`;
          params.push(jobId);
        }
        void this.db.execute(sql, params).catch(() => {});
      }
      return;
    }

    // ── P2P orchestration run persistence + broadcast ────────────────────────
    // For RUN_SAVE/RUN_COMPLETE/RUN_ERROR we sanitize ONCE and reuse the same
    // workflow_projection (and the same JSON progress_snapshot bytes) for both
    // the DB upsert and the browser broadcast. This guarantees the diagnostic
    // code set the browser sees matches what gets persisted.
    if (type === P2P_WORKFLOW_MSG.RUN_SAVE) {
      const { persisted, broadcast } = sanitizeP2pRunForPersistAndBroadcast(msg.run, { serverId: this.serverId });
      if (this.db) void upsertOrchestrationRun(this.db, persisted).catch(() => {});
      this.broadcastToBrowsers(JSON.stringify({
        type: P2P_WORKFLOW_MSG.RUN_UPDATE,
        run: broadcast,
      }));
      return;
    }
    if (type === P2P_WORKFLOW_MSG.RUN_COMPLETE) {
      const completedAt = new Date().toISOString();
      const overrides = {
        serverId: this.serverId,
        status: 'completed',
        completedAt,
        updatedAt: completedAt,
      };
      const { persisted, broadcast } = sanitizeP2pRunForPersistAndBroadcast(msg.run, overrides);
      if (this.db) void upsertOrchestrationRun(this.db, persisted).catch(() => {});
      this.broadcastToBrowsers(JSON.stringify({
        type: P2P_WORKFLOW_MSG.RUN_UPDATE,
        run: broadcast,
      }));
      return;
    }
    if (type === P2P_WORKFLOW_MSG.RUN_ERROR) {
      const updatedAt = new Date().toISOString();
      const overrides = {
        serverId: this.serverId,
        updatedAt,
      };
      const { persisted, broadcast } = sanitizeP2pRunForPersistAndBroadcast(msg.run, overrides);
      if (this.db) void upsertOrchestrationRun(this.db, persisted).catch(() => {});
      this.broadcastToBrowsers(JSON.stringify({
        type: P2P_WORKFLOW_MSG.RUN_UPDATE,
        run: broadcast,
      }));
      return;
    }
    if (type === P2P_WORKFLOW_MSG.RUN_UPDATE) {
      const run = sanitizeP2pRunUpdateForBroadcast(msg.run, { serverId: this.serverId });
      this.broadcastToBrowsers(JSON.stringify({ type: P2P_WORKFLOW_MSG.RUN_UPDATE, run }));
      return;
    }
    if (
      p2pDaemonMessage.kind === 'known'
      && p2pDaemonMessage.descriptor.serverHandling === 'broadcast_to_browsers'
      && p2pDaemonMessage.descriptor.browserDelivery === 'broadcast'
    ) {
      this.broadcastToBrowsers(JSON.stringify(msg));
      return;
    }
    if (p2pDaemonMessage.kind === 'drop' && p2pDaemonMessage.reason === 'unknown_p2p_message') {
      incrementCounter('p2p.bridge.unknown_message_drop', { direction: 'daemon_to_browser' });
      logger.warn({ serverId: this.serverId, type }, 'unknown daemon p2p message — dropped');
      return;
    }
    if (p2pDaemonMessage.kind === 'known') {
      incrementCounter('p2p.bridge.route_policy_drop', { direction: 'daemon_to_browser', type });
      logger.warn({ serverId: this.serverId, type }, 'known daemon p2p message had no bridge route — dropped');
      return;
    }

    // ── Daemon stats: extract from heartbeat or standalone, broadcast to browsers ─
    if (type === 'daemon.stats' || (type === 'heartbeat' && msg.cpu !== undefined)) {
      if (typeof msg.daemonVersion === 'string') this.daemonVersion = msg.daemonVersion;
      this.broadcastToBrowsers(JSON.stringify({
        type: 'daemon.stats',
        daemonVersion: typeof msg.daemonVersion === 'string' ? msg.daemonVersion : this.daemonVersion,
        cpu: msg.cpu, memUsed: msg.memUsed, memTotal: msg.memTotal,
        load1: msg.load1, load5: msg.load5, load15: msg.load15, uptime: msg.uptime,
      }));
      return;
    }

    // Repo messages: use shared constants to prevent type-name drift between daemon and bridge
    if ((REPO_RELAY_TYPES as Set<string>).has(type)) {
      this.broadcastToBrowsers(JSON.stringify(msg));
      return;
    }

    // Provider status: cache + persist to DB + broadcast to all browsers
    if (type === TRANSPORT_MSG.PROVIDER_STATUS) {
      const providerId = msg.providerId as string;
      const connected = msg.connected as boolean;
      if (providerId) {
        this.providerStatus.set(providerId, connected);
        if (this.db) {
          void updateProviderStatus(this.db, this.serverId, providerId, connected)
            .catch((e) => logger.error({ err: e, providerId }, 'Failed to persist provider status'));
        }
      }
      this.broadcastToBrowsers(JSON.stringify(msg));
      return;
    }

    // Provider remote sessions sync: cache + persist to DB + broadcast to browsers
    if (type === 'provider.sync_sessions') {
      const providerId = msg.providerId as string;
      const sessions = msg.sessions as unknown[];
      if (providerId && Array.isArray(sessions)) {
        this.providerRemoteSessions.set(providerId, sessions);
        if (this.db) {
          void updateProviderRemoteSessions(this.db, this.serverId, providerId, sessions)
            .catch((e) => logger.error({ err: e, providerId }, 'Failed to sync provider remote sessions'));
        }
      }
      // Broadcast as sessions_response so browsers update immediately
      this.broadcastToBrowsers(JSON.stringify({
        type: TRANSPORT_MSG.SESSIONS_RESPONSE,
        providerId,
        sessions: sessions ?? [],
      }));
      return;
    }

    // Transport events: route to browsers subscribed to the transport session
    if ((TRANSPORT_RELAY_TYPES as Set<string>).has(type)) {
      const sessionId = msg.sessionId as string | undefined;
      if (sessionId) {
        this.updateActiveDispatchFromDaemonMessage(sessionId, msg);
        this.sendToTransportSubscribers(sessionId, JSON.stringify(msg));
      }
      return;
    }

    // ── Default-allow: forward unrecognised types to all browsers ─────────────
    this.broadcastToBrowsers(JSON.stringify(msg));
  }

  private handleDaemonP2pWorkflowHello(msg: Record<string, unknown>): void {
    const daemonId = typeof msg.daemonId === 'string' ? msg.daemonId : null;
    const helloEpoch = typeof msg.helloEpoch === 'number' && Number.isFinite(msg.helloEpoch)
      ? msg.helloEpoch
      : null;
    const sentAt = typeof msg.sentAt === 'number' && Number.isFinite(msg.sentAt)
      ? msg.sentAt
      : null;
    const capabilities = Array.isArray(msg.capabilities)
      ? msg.capabilities.filter((capability): capability is string => typeof capability === 'string')
      : null;
    if (!daemonId || helloEpoch === null || sentAt === null || !capabilities) {
      incrementCounter('p2p.bridge.invalid_daemon_hello_drop');
      logger.warn({ serverId: this.serverId }, 'invalid daemon.hello — dropped');
      return;
    }
    const existing = this.daemonP2pWorkflowCapabilities;
    if (existing && helloEpoch < existing.helloEpoch) {
      incrementCounter('p2p.bridge.stale_daemon_hello_drop');
      logger.warn({ serverId: this.serverId, helloEpoch, currentEpoch: existing.helloEpoch }, 'stale daemon.hello — dropped');
      return;
    }
    const sortedCapabilities = [...new Set(capabilities)].sort();
    const timelineProtocolRevision = sortedCapabilities.includes(TIMELINE_PROTOCOL_CAPABILITY)
      && typeof msg.timelineProtocolRevision === 'number'
      && Number.isFinite(msg.timelineProtocolRevision)
      ? msg.timelineProtocolRevision
      : undefined;
    const buildInfo = msg.buildInfo && typeof msg.buildInfo === 'object'
      ? msg.buildInfo as DaemonBuildInfo
      : undefined;
    this.daemonP2pWorkflowCapabilities = {
      daemonId,
      capabilities: sortedCapabilities,
      ...(timelineProtocolRevision !== undefined
        ? {
          timelineProtocolCapability: TIMELINE_PROTOCOL_CAPABILITY,
          timelineProtocolRevision,
        }
        : {}),
      ...(buildInfo ? { buildInfo } : {}),
      helloEpoch,
      sentAt,
      receivedAt: Date.now(),
    };
    // Forward a sanitized snapshot to all browsers connected to this serverId
    // so the web capability gate can react to missing/stale/downgraded caps.
    // Per the message registry this is `browserDelivery: 'broadcast'`.
    this.broadcastToBrowsers(JSON.stringify({
      type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
      daemonId,
      capabilities: sortedCapabilities,
      ...(timelineProtocolRevision !== undefined
        ? {
          timelineProtocolCapability: TIMELINE_PROTOCOL_CAPABILITY,
          timelineProtocolRevision,
        }
        : {}),
      ...(buildInfo ? { buildInfo } : {}),
      helloEpoch,
      sentAt,
    }));
  }

  private routeBinaryFrame(data: Buffer): void {
    // WS_DATA frames (type 0x04) are handled separately — parsePreviewBinaryFrame returns null for them.
    if (data.length > 0 && data[0] === PREVIEW_BINARY_FRAME.WS_DATA) {
      const wsFrame = parsePreviewWsFrame(data);
      if (wsFrame) {
        this.relayWsDataToBrowser(wsFrame.wsId, wsFrame.isBinary, wsFrame.payload);
      } else {
        logger.warn({ serverId: this.serverId }, 'Binary frame: malformed WS_DATA frame');
      }
      return;
    }

    const previewFrame = parsePreviewBinaryFrame(data);
    if (previewFrame && previewFrame.frameType === PREVIEW_BINARY_FRAME.RESPONSE_BODY) {
      this.pushPreviewResponseChunk(previewFrame.requestId, previewFrame.payload);
      return;
    }

    const sessionName = parseRawFrameSession(data);
    if (!sessionName) {
      logger.warn({ serverId: this.serverId }, 'Binary frame: invalid v1 header');
      return;
    }
    this.sendToRawSessionSubscribers(sessionName, data);
  }

  getActiveMainSessions(): WatchActiveMainSessionRow[] {
    return Array.from(this.activeMainSessions.values());
  }

  hasReceivedActiveMainSessionSnapshot(): boolean {
    return this.hasActiveMainSessionSnapshot;
  }

  private replaceActiveMainSessions(rawSessions: unknown): void {
    this.activeMainSessions.clear();
    this.hasActiveMainSessionSnapshot = true;
    if (!Array.isArray(rawSessions)) return;
    for (const item of rawSessions) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const name = typeof row.name === 'string' ? row.name : '';
      const project = typeof row.project === 'string' ? row.project : '';
      const state = typeof row.state === 'string' ? row.state : 'stopped';
      const agentType = typeof row.agentType === 'string' ? row.agentType : '';
      const runtimeType = typeof row.runtimeType === 'string' ? row.runtimeType : undefined;
      const label = typeof row.label === 'string' && row.label.trim() ? row.label.trim() : undefined;
      if (!name) continue;
      this.activeMainSessions.set(name, { name, project, state, agentType, runtimeType, label });
      this.sessionRuntimeTypes.set(name, this.normalizeRuntimeType(runtimeType));
      if (state === 'idle' || state === 'stopped') this.activeDispatchIds.delete(name);
    }
  }

  private pruneMainSessionRecentText(rawSessions: unknown): void {
    if (!Array.isArray(rawSessions)) return;
    const activeMainSessions = new Set<string>();
    for (const item of rawSessions) {
      if (!item || typeof item !== 'object') continue;
      const name = (item as Record<string, unknown>).name;
      if (typeof name === 'string' && name) activeMainSessions.add(name);
    }
    for (const sessionName of this.recentTextBySession.keys()) {
      if (sessionName.startsWith('deck_sub_')) continue;
      if (!activeMainSessions.has(sessionName)) this.recentTextBySession.delete(sessionName);
    }
  }

  private ingestRecentTextFromTimelineEvent(rawEvent: Record<string, unknown>): void {
    const sessionId = rawEvent.sessionId;
    const row = recentTextRowFromTimelineEvent(rawEvent);
    if (typeof sessionId !== 'string' || !row) return;
    const rows = this.recentTextBySession.get(sessionId) ?? [];
    this.recentTextBySession.set(sessionId, mergeRecentTextRows([...rows, row]));
  }

  private sendToSessionSubscribers(sessionName: string, data: string | Buffer): void {
    for (const [ws, sessions] of this.browserSubscriptions) {
      if (!sessions.has(sessionName)) continue;
      if (!this.canShareSocketReceiveSession(ws, sessionName, data)) continue;
      const queue = this.getOrCreateQueue(sessionName, ws);
      queue.send(ws, data, () => this.handleQueueOverflow(sessionName, ws));
    }
  }

  /**
   * Direct JSON delivery to session subscribers — bypasses the per-(session, ws)
   * TerminalForwardQueue used for backpressure on heavy PTY output AND fans
   * out across BOTH terminal-mode and transport-mode subscriptions.
   *
   * Why this exists:
   *
   * 1. Control-plane messages (command.ack, session.state, session.idle,
   *    timeline.event with assistant.text/user.message, etc.) are tiny but
   *    latency-critical. When PTY frames are queued (e.g. agent was streaming
   *    a long response right before a cancel), the old path queued cancel JSON
   *    behind hundreds of KB of PTY data — the push notification (out-of-band
   *    APNs/FCM) arrived seconds before the WS confirmation, leaving the
   *    browser spinner hanging. Direct `safeSend` jumps the queue.
   *
   * 2. Session subscriptions live in TWO maps: `browserSubscriptions` (filled
   *    by `terminal.subscribe`, used by process/tmux agents) and
   *    `transportSubscriptions` (filled by `chat.subscribe`, used by SDK
   *    agents like qwen / openclaw / codex-sdk / cursor-headless). Transport
   *    agents have no tmux pane so the web client never issues
   *    `terminal.subscribe` for them — meaning the browser appears in
   *    `transportSubscriptions` only.
   *
   *    Before this fan-out, control-plane messages routed via
   *    `browserSubscriptions` alone NEVER REACHED transport-only browsers.
   *    Result: the user pressed stop on a Codex-SDK / Qwen session, the SDK
   *    cancel completed, the push notification fired (proving the daemon
   *    saw idle), but the browser's chat record never received the matching
   *    session.idle / command.ack / session.state events — they were silently
   *    dropped on the floor. The chat list spinner stayed on indefinitely.
   *
   *    Fanning out to BOTH maps fixes that. Same WS may live in both maps
   *    simultaneously (a process session that the user also has chat-mode
   *    subscriptions to); we dedup per-WS so the same JSON is never sent
   *    twice.
   */
  private sendJsonToSessionSubscribers(sessionName: string, json: string): void {
    const sent = new Set<WebSocket>();
    for (const [ws, sessions] of this.browserSubscriptions) {
      if (!sessions.has(sessionName)) continue;
      if (sent.has(ws)) continue;
      const msg = this.tryParseJsonRecord(json);
      const outgoing = msg ? this.filterShareOutgoingJson(ws, msg, json) : json;
      if (!outgoing) continue;
      sent.add(ws);
      safeSend(ws, outgoing);
    }
    for (const [ws, sessions] of this.transportSubscriptions) {
      if (!sessions.has(sessionName)) continue;
      if (sent.has(ws)) continue;
      const msg = this.tryParseJsonRecord(json);
      const outgoing = msg ? this.filterShareOutgoingJson(ws, msg, json) : json;
      if (!outgoing) continue;
      sent.add(ws);
      safeSend(ws, outgoing);
    }
  }

  private sendToRawSessionSubscribers(sessionName: string, data: string | Buffer): void {
    for (const [ws, sessions] of this.browserSubscriptions) {
      if (sessions.get(sessionName) !== true) continue;
      if (!this.canShareSocketReceiveSession(ws, sessionName, data)) continue;
      const queue = this.getOrCreateQueue(sessionName, ws);
      queue.send(ws, data, () => this.handleQueueOverflow(sessionName, ws));
    }
  }

  private sendToTransportSubscribers(sessionId: string, data: string): void {
    for (const [ws, sessions] of this.transportSubscriptions) {
      if (!sessions.has(sessionId)) continue;
      const msg = this.tryParseJsonRecord(data);
      const outgoing = msg ? this.filterShareOutgoingJson(ws, msg, data) : data;
      if (!outgoing) continue;
      safeSend(ws, outgoing);
    }
  }

  private canShareSocketReceiveSession(ws: WebSocket, sessionName: string, data: string | Buffer): boolean {
    const state = this.browserShareStates.get(ws);
    if (!state) return true;
    if (!shareStateCoversSession(state, sessionName)) return false;
    if (typeof data !== 'string') return true;
    const msg = this.tryParseJsonRecord(data);
    return !msg || !!this.filterShareOutgoingJson(ws, msg, data);
  }

  private handleQueueOverflow(sessionName: string, ws: WebSocket): void {
    const resetMsg = JSON.stringify({
      type: 'terminal.stream_reset',
      session: sessionName,
      reason: 'backpressure',
    });

    const sent = safeSend(ws, resetMsg, (err) => {
      if (err) {
        // Browser actually disconnected (socket CLOSING/CLOSED). Real cleanup
        // — drop the subscription and force close.
        this.removeBrowserSessionSubscription(ws, sessionName);
        try { ws.close(1011, 'backpressure_notify_failed'); } catch { /* ignore */ }
      }
    });

    if (!sent) {
      logger.warn({ serverId: this.serverId, sessionName }, 'Backpressure reset failed to send — socket closed');
      return;
    }

    // Reset the per-(session, ws) queue to a fresh accounting state instead
    // of unsubscribing. Prior behavior unsubscribed on every overflow which
    // created a churn cycle on heavy shell output:
    //   heavy stdout → 1MB queue → overflow → server unsubscribes → daemon
    //   stops pipe-pane → client receives stream_reset → client retries
    //   subscribe → daemon restarts pipe → flood begins again → overflow.
    // Each cycle the client's `resetState` count climbs; once it crosses
    // the cooldown threshold the terminal sits frozen for 5s, and if the
    // session keeps producing output the cooldown re-engages indefinitely
    // — which is exactly the "shell terminal 断流, 刷新才能恢复" symptom.
    //
    // By keeping the subscription alive we let the client treat the reset
    // as a discontinuity (request a snapshot, redraw) without forcing a
    // full re-subscribe roundtrip. The fresh queue gives us a clean budget
    // for subsequent sends; orphaned in-flight callbacks from the old
    // queue still decrement only their own (now-unreachable) counter.
    const sessionQueues = this.terminalQueues.get(sessionName);
    if (sessionQueues?.has(ws)) {
      sessionQueues.set(ws, new TerminalForwardQueue());
    }
  }

  private getOrCreateQueue(sessionName: string, ws: WebSocket): TerminalForwardQueue {
    let sessionQueues = this.terminalQueues.get(sessionName);
    if (!sessionQueues) {
      sessionQueues = new Map();
      this.terminalQueues.set(sessionName, sessionQueues);
    }
    let queue = sessionQueues.get(ws);
    if (!queue) {
      queue = new TerminalForwardQueue();
      sessionQueues.set(ws, queue);
    }
    return queue;
  }

  /**
   * Add or update a browser subscription for sessionName.
   * totalRefs/rawRefs are derived from live browser sockets.
   * rawMsg is the original JSON string to forward on the first 0→1 transition.
   */
  private addBrowserSessionSubscription(ws: WebSocket, sessionName: string, raw: boolean, rawMsg: string, revision: number): void {
    if (!this.isCurrentTerminalSubscriptionRevision(ws, sessionName, revision)) return;

    const subs = this.browserSubscriptions.get(ws);
    if (!subs) return;

    const existing = subs.get(sessionName);
    if (existing === raw) return;

    const refs = this.getOrCreateSessionRefs(sessionName);

    if (existing === undefined) {
      subs.set(sessionName, raw);
      refs.totalRefs += 1;
      if (raw) refs.rawRefs += 1;
      this.daemonSessionRefs.set(sessionName, refs);

      if (refs.totalRefs === 1) {
        // First browser subscriber — tell daemon to start streaming
        this.sendToDaemon(rawMsg);
      }
      return;
    }

    subs.set(sessionName, raw);
    if (existing) refs.rawRefs = Math.max(0, refs.rawRefs - 1);
    if (raw) refs.rawRefs += 1;
    this.daemonSessionRefs.set(sessionName, refs);
  }

  private getOrCreateSessionRefs(sessionName: string): { totalRefs: number; rawRefs: number } {
    const existing = this.daemonSessionRefs.get(sessionName);
    if (existing) return existing;
    const refs = { totalRefs: 0, rawRefs: 0 };
    this.daemonSessionRefs.set(sessionName, refs);
    return refs;
  }

  /**
   * Remove a browser subscription for sessionName.
   * Forwards terminal.unsubscribe to daemon only on 1→0 transition.
   */
  private removeBrowserSessionSubscription(ws: WebSocket, sessionName: string): void {
    this.bumpTerminalSubscriptionRevision(ws, sessionName);

    const subs = this.browserSubscriptions.get(ws);
    if (!subs?.has(sessionName)) return; // not subscribed
    const wasRaw = subs.get(sessionName) === true;
    subs.delete(sessionName);

    this.terminalQueues.get(sessionName)?.delete(ws);
    if (this.terminalQueues.get(sessionName)?.size === 0) {
      this.terminalQueues.delete(sessionName);
    }

    const refs = this.daemonSessionRefs.get(sessionName);
    if (!refs) return;

    refs.totalRefs = Math.max(0, refs.totalRefs - 1);
    if (wasRaw) refs.rawRefs = Math.max(0, refs.rawRefs - 1);

    if (refs.totalRefs === 0) {
      this.daemonSessionRefs.delete(sessionName);
      // Last browser unsubscribed — tell daemon to stop streaming
      this.sendToDaemon(JSON.stringify({ type: 'terminal.unsubscribe', session: sessionName }));
    } else {
      this.daemonSessionRefs.set(sessionName, refs);
    }
  }

  private bumpTerminalSubscriptionRevision(ws: WebSocket, sessionName: string): number {
    let sessions = this.terminalSubscriptionRevisions.get(ws);
    if (!sessions) {
      sessions = new Map();
      this.terminalSubscriptionRevisions.set(ws, sessions);
    }
    const next = (sessions.get(sessionName) ?? 0) + 1;
    sessions.set(sessionName, next);
    return next;
  }

  private isCurrentTerminalSubscriptionRevision(ws: WebSocket, sessionName: string, revision: number): boolean {
    return this.terminalSubscriptionRevisions.get(ws)?.get(sessionName) === revision;
  }

  private bumpTransportSubscriptionRevision(ws: WebSocket, sessionId: string): number {
    let sessions = this.transportSubscriptionRevisions.get(ws);
    if (!sessions) {
      sessions = new Map();
      this.transportSubscriptionRevisions.set(ws, sessions);
    }
    const next = (sessions.get(sessionId) ?? 0) + 1;
    sessions.set(sessionId, next);
    return next;
  }

  private isCurrentTransportSubscriptionRevision(ws: WebSocket, sessionId: string, revision: number): boolean {
    return this.transportSubscriptionRevisions.get(ws)?.get(sessionId) === revision;
  }

  private cleanupBrowserSocket(ws: WebSocket): void {
    this.browserSockets.delete(ws);
    this.mobileSockets.delete(ws);
    this.browserUserIds.delete(ws);
    this.browserShareStates.delete(ws);
    const sessions = this.browserSubscriptions.get(ws);
    if (sessions) {
      for (const sessionName of [...sessions.keys()]) {
        // Use removeBrowserSessionSubscription to correctly handle ref counting + daemon notify
        this.removeBrowserSessionSubscription(ws, sessionName);
      }
    }
    this.browserSubscriptions.delete(ws);
    this.terminalSubscriptionRevisions.delete(ws);
    this.transportSubscriptionRevisions.delete(ws);
    this.transportSubscriptions.delete(ws);
    this.clearPendingFsRoutesForSocket(ws);
    // Clean up pending timeline requests for this socket
    for (const [reqId, pending] of this.pendingTimelineRequests) {
      if (pending.socket === ws) {
        clearTimeout(pending.timer);
        this.pendingTimelineRequests.delete(reqId);
      }
    }
    for (const [reqId, pending] of this.pendingMemoryManagementRequests) {
      if (pending.socket === ws) {
        clearTimeout(pending.timer);
        this.pendingMemoryManagementRequests.delete(reqId);
      }
    }
    for (const [reqId, pending] of this.pendingP2pWorkflowRequests) {
      if (pending.socket === ws) {
        clearTimeout(pending.timer);
        this.pendingP2pWorkflowRequests.delete(reqId);
      }
    }
  }

  /**
   * Verify that a session name belongs to this server.
   * Checks both regular sessions and sub-sessions.
   */
  private async verifySessionOwnership(sessionName: string): Promise<boolean> {
    if (!this.db) return true; // no db = dev/test mode, allow all
    if (this.activeSubSessions.has(sessionName)) return true;
    try {
      // Check regular sessions
      const row = await this.db.queryOne<Record<string, unknown>>(
        'SELECT 1 FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
        [this.serverId, sessionName],
      );
      if (row) return true;

      // Check sub-sessions: name is deck_sub_{id}
      const subMatch = sessionName.match(/^deck_sub_(.+)$/);
      if (subMatch) {
        const subId = subMatch[1];
        const subRow = await this.db.queryOne<Record<string, unknown>>(
          'SELECT 1 FROM sub_sessions WHERE server_id = $1 AND id = $2 LIMIT 1',
          [this.serverId, subId],
        );
        if (subRow) return true;
      }

      return false;
    } catch (err) {
      logger.warn({ serverId: this.serverId, sessionName, err }, 'verifySessionOwnership: db error — denying');
      return false; // fail-closed: deny on transient DB errors to prevent unauthorized access
    }
  }

  private async verifySessionOwnershipWithSubSessionRetry(sessionName: string): Promise<boolean> {
    if (await this.verifySessionOwnership(sessionName)) return true;
    if (!rawSubSessionIdFromDisplayName(sessionName)) return false;

    for (const delayMs of SUBSESSION_OWNERSHIP_RETRY_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (await this.verifySessionOwnership(sessionName)) return true;
    }
    return false;
  }

  private async verifyRepoCheckoutAuthorization(ws: WebSocket, msg: Record<string, unknown>): Promise<boolean> {
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined;
    const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : '';
    const projectDir = typeof msg.projectDir === 'string' ? msg.projectDir : '';
    const sendRepoError = (error: 'invalid_params' | 'unauthorized') => {
      safeSend(ws, JSON.stringify({
        type: REPO_MSG.ERROR,
        ...(requestId ? { requestId } : {}),
        ...(projectDir ? { projectDir } : {}),
        error,
      }));
    };

    if (!requestId || !sessionId || !projectDir || typeof msg.branch !== 'string') {
      sendRepoError('invalid_params');
      return false;
    }

    if (!this.db) return true;

    const userId = this.browserUserIds.get(ws)?.trim();
    if (!userId) {
      sendRepoError('unauthorized');
      return false;
    }

    try {
      const sessionRow = await this.db.queryOne<Record<string, unknown>>(
        `SELECT 1
           FROM sessions s
           JOIN servers srv ON srv.id = s.server_id
          WHERE s.server_id = $1
            AND s.name = $2
            AND s.project_dir = $3
            AND srv.user_id = $4
          LIMIT 1`,
        [this.serverId, sessionId, projectDir, userId],
      );
      if (sessionRow) return true;

      const subMatch = sessionId.match(/^deck_sub_([a-z0-9]+)$/);
      if (subMatch) {
        const subRow = await this.db.queryOne<Record<string, unknown>>(
          `SELECT 1
             FROM sub_sessions ss
             JOIN servers srv ON srv.id = ss.server_id
            WHERE ss.server_id = $1
              AND ss.id = $2
              AND ss.cwd = $3
              AND ss.closed_at IS NULL
              AND srv.user_id = $4
            LIMIT 1`,
          [this.serverId, subMatch[1], projectDir, userId],
        );
        if (subRow) return true;
      }

      sendRepoError('unauthorized');
      return false;
    } catch (err) {
      logger.warn({ serverId: this.serverId, sessionId, projectDir, err }, 'repo.checkout_branch: authorization check failed');
      sendRepoError('unauthorized');
      return false;
    }
  }

  private broadcastToBrowsers(json: string): void {
    const msg = this.tryParseJsonRecord(json);
    for (const bs of this.browserSockets) {
      try {
        const outgoing = msg ? this.filterShareOutgoingJson(bs, msg, json) : json;
        if (!outgoing) continue;
        bs.send(outgoing);
      } catch {
        this.browserSockets.delete(bs);
      }
    }
  }

  private tryParseJsonRecord(json: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(json) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  private filterShareOutgoingJson(ws: WebSocket, msg: Record<string, unknown>, originalJson: string): string | null {
    const state = this.browserShareStates.get(ws);
    if (!state) return originalJson;
    const filtered = filterShareDaemonMessage(msg, state);
    return filtered ? JSON.stringify(filtered) : null;
  }

  // ── Ack reliability helpers ────────────────────────────────────────────

  /**
   * Entry point for `session.send` interception. Registers an inflight entry
   * and dispatches / buffers / fast-fails based on current daemon state.
   */
  private handleOutboundSessionSend(
    ws: WebSocket,
    commandId: string,
    sessionName: string,
    raw: string,
  ): void {
    // Guard: if we already have an inflight for this commandId, the browser is
    // retrying / double-sending. Keep the existing inflight and wait for its
    // ack/timeout instead of forwarding another copy to the daemon.
    if (this.inflightCommands.has(commandId)) {
      return;
    }

    if (this.isDaemonConnected()) {
      const entry: InflightCommand = {
        commandId,
        sessionName,
        browser: ws,
        rawPayload: raw,
        state: 'dispatched',
        sentAt: Date.now(),
        dispatchAttempts: 0,
        timeoutTimer: null,
        share: this.inflightShareMetadata(ws),
      };
      this.inflightCommands.set(commandId, entry);
      void this.dispatchInflightToDaemon(entry, false);
      this.startAckHousekeepingIfNeeded();
      return;
    }

    // Buffer if either:
    //   (a) we are inside the post-disconnect grace window (`graceTimer` set)
    //   (b) a daemon WS is open but the auth handshake hasn't completed yet
    //       (`daemonWs` exists, `authenticated` is still false). Without (b),
    //       sends arriving during the brief auth window after a grace-expired
    //       reconnect were INSTANT-FAILED with reason=daemon_offline even
    //       though the daemon is literally about to come back. This was the
    //       "发消息瞬间失败, 连点 retry n 次才成功" symptom: each click only
    //       had a chance to land in the lucky few-ms window after auth
    //       completed but before the user's eyes registered the green badge.
    //       The buffered entries are replayed by `replayInflightToDaemon()`
    //       when the auth `replayInflightToDaemon` call fires (line ~516).
    const daemonHandshakeInProgress = !!this.daemonWs && !this.authenticated;
    if (this.graceTimer || daemonHandshakeInProgress) {
      const entry: InflightCommand = {
        commandId,
        sessionName,
        browser: ws,
        rawPayload: raw,
        state: 'buffered',
        sentAt: Date.now(),
        dispatchAttempts: 0,
        timeoutTimer: null,
        share: this.inflightShareMetadata(ws),
      };
      this.inflightCommands.set(commandId, entry);
      this.startAckHousekeepingIfNeeded();
      return;
    }

    // Fully offline (no daemon WS, no grace window): fail fast.
    this.emitCommandFailed(ws, commandId, sessionName, ACK_FAILURE_DAEMON_OFFLINE);
  }

  /** Replay buffered + dispatched commands to the daemon after reconnect. */
  private async replayInflightToDaemon(): Promise<void> {
    const ordered = [...this.inflightCommands.values()].sort((a, b) => a.sentAt - b.sentAt);
    for (const entry of ordered) {
      if (entry.state === 'acked') continue;
      try {
        await this.dispatchInflightToDaemon(entry, entry.dispatchAttempts > 0);
      } catch (err) {
        logger.warn({ commandId: entry.commandId, err }, 'replayInflightToDaemon failed for entry');
      }
    }
  }

  private async dispatchInflightToDaemon(entry: InflightCommand, markBridgeRetry: boolean): Promise<void> {
    if (!await this.revalidateInflightShareCommand(entry)) return;
    const rawPayload = markBridgeRetry
      ? this.withBridgeRetryMarker(entry.rawPayload, entry.dispatchAttempts + 1)
      : entry.rawPayload;
    this.sendToDaemon(rawPayload);
    if (entry.share && this.rawPayloadType(entry.rawPayload) === 'session.send') {
      this.activeDispatchIds.set(entry.sessionName, entry.commandId);
    }
    entry.dispatchAttempts += 1;
    entry.state = 'dispatched';
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
    entry.timeoutTimer = setTimeout(() => this.onAckTimeout(entry.commandId), ACK_TIMEOUT_MS);
  }

  private inflightShareMetadata(ws: WebSocket): InflightCommand['share'] {
    const state = this.browserShareStates.get(ws);
    if (!state) return undefined;
    return {
      userId: state.userId,
      target: state.target,
      requiredRole: 'participant',
    };
  }

  private async revalidateInflightShareCommand(entry: InflightCommand): Promise<boolean> {
    if (!entry.share) return true;
    const state = this.browserShareStates.get(entry.browser);
    if (!state || state.userId !== entry.share.userId) {
      this.emitCommandFailed(entry.browser, entry.commandId, entry.sessionName, SHARE_REASONS.REVOKED);
      this.removeInflight(entry.commandId);
      return false;
    }
    const coverage = await this.resolveLiveShareCoverage(state);
    if (!coverage) {
      this.emitCommandFailed(
        entry.browser,
        entry.commandId,
        entry.sessionName,
        this.shareStateLooksExpired(state) ? SHARE_REASONS.EXPIRED : SHARE_REASONS.REVOKED,
      );
      this.removeInflight(entry.commandId);
      return false;
    }
    const current = await this.applyShareCoverage(entry.browser, state, coverage);
    if (!shareStateCoversSession(current, entry.sessionName)) {
      this.emitCommandFailed(entry.browser, entry.commandId, entry.sessionName, SHARE_REASONS.TARGET_UNAVAILABLE);
      this.removeInflight(entry.commandId);
      return false;
    }
    const sameTarget = shareTargetKey(current.target) === shareTargetKey(entry.share.target);
    if (!sameTarget || !shareStateCoversSession(current, entry.sessionName)) {
      this.emitCommandFailed(entry.browser, entry.commandId, entry.sessionName, SHARE_REASONS.TARGET_UNAVAILABLE);
      this.removeInflight(entry.commandId);
      return false;
    }
    if (this.shareStateLooksExpired(current)) {
      this.emitCommandFailed(entry.browser, entry.commandId, entry.sessionName, SHARE_REASONS.EXPIRED);
      this.removeInflight(entry.commandId);
      return false;
    }
    if (entry.share.requiredRole === 'participant' && current.snapshot.effectiveRole !== 'participant') {
      this.emitCommandFailed(entry.browser, entry.commandId, entry.sessionName, SHARE_REASONS.ROLE_DENIED);
      this.removeInflight(entry.commandId);
      return false;
    }
    return true;
  }

  private withBridgeRetryMarker(rawPayload: string, retryAttempt: number): string {
    try {
      const msg = JSON.parse(rawPayload) as Record<string, unknown>;
      return JSON.stringify({
        ...msg,
        __bridgeRetry: true,
        __bridgeRetryAttempt: retryAttempt,
      });
    } catch {
      return rawPayload;
    }
  }

  private rawPayloadType(rawPayload: string): string | null {
    try {
      const parsed = JSON.parse(rawPayload) as Record<string, unknown>;
      return typeof parsed.type === 'string' ? parsed.type : null;
    } catch {
      return null;
    }
  }

  /** Called when RECONNECT_GRACE_MS elapses without the daemon coming back. */
  private onReconnectGraceExpired(): void {
    if (this.authenticated) return;  // daemon actually came back — nothing to do
    if (!this.daemonOfflineAnnounced) {
      this.daemonOfflineAnnounced = true;
      this.broadcastToBrowsers(JSON.stringify({ type: MSG_DAEMON_OFFLINE }));
    }
    for (const entry of [...this.inflightCommands.values()]) {
      this.emitCommandFailed(entry.browser, entry.commandId, entry.sessionName, ACK_FAILURE_DAEMON_OFFLINE);
      this.removeInflight(entry.commandId);
    }
  }

  /** Per-command ack timeout fired. */
  private onAckTimeout(commandId: string): void {
    const entry = this.inflightCommands.get(commandId);
    if (!entry) return;
    if (entry.state === 'acked') return;
    if (this.isDaemonConnected() && entry.dispatchAttempts <= ACK_TIMEOUT_RETRY_LIMIT) {
      logger.warn(
        {
          serverId: this.serverId,
          commandId,
          sessionName: entry.sessionName,
          dispatchAttempts: entry.dispatchAttempts,
          retryLimit: ACK_TIMEOUT_RETRY_LIMIT,
        },
        'command.ack timeout — retrying session.send',
      );
      void this.dispatchInflightToDaemon(entry, true);
      return;
    }
    if (!this.isDaemonConnected() && this.graceTimer) {
      entry.state = 'buffered';
      if (entry.timeoutTimer) {
        clearTimeout(entry.timeoutTimer);
        entry.timeoutTimer = null;
      }
      return;
    }
    logger.warn({ serverId: this.serverId, commandId, sessionName: entry.sessionName }, 'command.ack timeout');
    this.emitCommandFailed(entry.browser, commandId, entry.sessionName, ACK_FAILURE_ACK_TIMEOUT);
    this.removeInflight(commandId);
  }

  /** Ack arrived — clear timer + mark acked. */
  private clearInflightOnAck(commandId: string): void {
    const entry = this.inflightCommands.get(commandId);
    if (!entry) return;
    entry.state = 'acked';
    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = null;
    }
    // Leave the entry around briefly for housekeeping GC so duplicate acks
    // still hit dedup via `seenCommandAcks`.
    this.removeInflight(commandId);
  }

  /** A user.message carrying the client command id means the daemon accepted it. */
  private clearInflightOnAuthoritativeEcho(commandId: string): void {
    const entry = this.inflightCommands.get(commandId);
    if (!entry) return;
    this.removeInflight(commandId);
  }

  private removeInflight(commandId: string): void {
    const entry = this.inflightCommands.get(commandId);
    if (!entry) return;
    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = null;
    }
    this.inflightCommands.delete(commandId);
  }

  private emitCommandFailed(
    browser: WebSocket,
    commandId: string,
    sessionName: string,
    reason: AckFailureReason | ShareReason,
  ): void {
    const payload = {
      type: MSG_COMMAND_FAILED,
      commandId,
      session: sessionName,
      reason,
      retryable: true,
    };
    try {
      if (browser.readyState === WebSocket.OPEN) {
        browser.send(JSON.stringify(payload));
      }
    } catch (err) {
      logger.warn({ commandId, err }, 'failed to deliver command.failed to browser');
    }
  }

  /** Start periodic GC timer (idempotent). */
  private startAckHousekeepingIfNeeded(): void {
    if (this.ackHousekeepingTimer) return;
    this.ackHousekeepingTimer = setInterval(() => this.ackHousekeepingSweep(), 15_000);
    this.ackHousekeepingTimer.unref?.();
  }

  private ackHousekeepingSweep(): void {
    const now = Date.now();
    // GC stale inflight entries (shouldn't happen unless timers misfire)
    for (const [id, entry] of this.inflightCommands) {
      if (now - entry.sentAt > INFLIGHT_GC_TTL_MS) {
        logger.warn({ commandId: id, ageMs: now - entry.sentAt }, 'inflight GC: dropping stale entry');
        this.removeInflight(id);
      }
    }
    // GC dedup LRU
    for (const [id, ts] of this.seenCommandAcks) {
      if (now - ts > ACK_DEDUP_TTL_MS) this.seenCommandAcks.delete(id);
    }
    if (this.inflightCommands.size === 0 && this.seenCommandAcks.size === 0 && this.ackHousekeepingTimer) {
      clearInterval(this.ackHousekeepingTimer);
      this.ackHousekeepingTimer = null;
    }
  }

  /** Test-only accessor; prefer narrow APIs in production code. */
  _getInflightCountForTest(): number {
    return this.inflightCommands.size;
  }
  _isDaemonOfflineAnnouncedForTest(): boolean {
    return this.daemonOfflineAnnounced;
  }
  _hasSeenAckForTest(commandId: string): boolean {
    return this.seenCommandAcks.has(commandId);
  }

  requestDaemonUpgrade(input: {
    targetVersion?: unknown;
    source?: DaemonUpgradeSource;
    isStillCurrent?: () => boolean;
  } = {}): RequestDaemonUpgradeResult {
    return this.daemonUpgradeCoordinator.request({
      targetVersion: input.targetVersion,
      source: input.source ?? 'manual',
      isDaemonReady: () => this.isDaemonReadyForUpgrade(),
      isStillCurrent: input.isStillCurrent,
      send: (message) => this.sendDirectToDaemon(message),
    });
  }

  private flushPendingDaemonUpgrade(ws: WebSocket): void {
    const result = this.daemonUpgradeCoordinator.flushPending({
      isDaemonReady: () => this.isDaemonReadyForUpgrade(),
      isStillCurrent: () => this.daemonWs === ws && this.authenticated,
      send: (message) => this.sendDirectToDaemon(message),
    });
    if (result?.deliveryStatus === DAEMON_UPGRADE_DELIVERY_STATUS.SENT) {
      logger.info({
        serverId: this.serverId,
        targetVersion: result.targetVersion,
        upgradeId: result.upgradeId,
      }, 'Flushed pending daemon.upgrade after daemon auth');
    } else if (result?.deliveryStatus === DAEMON_UPGRADE_DELIVERY_STATUS.PENDING_PUBLICATION) {
      logger.info({
        serverId: this.serverId,
        targetVersion: result.targetVersion,
        nextAttemptAt: result.nextAttemptAt,
      }, 'Pending daemon.upgrade is waiting for npm publication');
    }
  }

  private isDaemonReadyForUpgrade(): boolean {
    return Boolean(this.daemonWs && this.authenticated);
  }

  private sendDirectToDaemon(message: Record<string, unknown>): void {
    if (!this.daemonWs || !this.authenticated) return;
    try {
      this.daemonWs.send(JSON.stringify(message));
    } catch (err) {
      logger.error({ serverId: this.serverId, err }, 'Failed to send daemon upgrade command');
    }
  }

  /** Force-close the daemon WebSocket. Use after token rotation to evict the stale connection. */
  kickDaemon(): void {
    if (this.daemonWs) {
      try { this.daemonWs.close(4001, 'token_rotated'); } catch { /* ignore */ }
      this.daemonWs = null;
      this.authenticated = false;
      this.authPromise = null;
      this.daemonP2pWorkflowCapabilities = null;
    }
  }

  sendToDaemon(message: string): void {
    const parsed = this.parseJsonObject(message);
    if (parsed?.type === DAEMON_COMMAND_TYPES.DAEMON_UPGRADE) {
      this.requestDaemonUpgrade({
        targetVersion: parsed.targetVersion,
        source: 'manual',
      });
      return;
    }
    if (this.daemonWs && this.authenticated) {
      try {
        this.daemonWs.send(message);
      } catch (err) {
        logger.error({ serverId: this.serverId, err }, 'Failed to send to daemon');
      }
    } else {
      if (this.queue.length < MAX_QUEUE_SIZE) {
        this.queue.push(message);
      }
    }
  }

  private parseJsonObject(message: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(message) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  private isBrowserForbiddenDaemonCommandType(type: string): boolean {
    return type === DAEMON_COMMAND_TYPES.SERVER_DELETE || type.startsWith('daemon.');
  }

  requestTimelineHistory(params: {
    sessionName: string;
    limit?: number;
    beforeTs?: number;
    afterTs?: number;
    budgetBytes?: number;
    includeDetails?: boolean;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  }): Promise<Record<string, unknown>> {
    if (!this.isDaemonConnected()) {
      return Promise.reject(new Error('daemon_offline'));
    }
    if (params.abortSignal?.aborted) {
      return Promise.reject(new Error(TIMELINE_REQUEST_ERROR_REASONS.REQUEST_CANCELED));
    }

    const requestId = `watch-hist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const timeoutMs = params.timeoutMs ?? HTTP_TIMELINE_TIMEOUT_MS;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let pending: PendingHttpTimelineRequest;
      const timer = setTimeout(() => {
        const current = this.pendingHttpTimelineRequests.get(requestId) ?? pending;
        this.settlePendingHttpTimelineRequest(requestId, current, () => reject(new Error('timeout')));
      }, timeoutMs);
      timer.unref?.();

      pending = { resolve, reject, timer, abortSignal: params.abortSignal };
      if (params.abortSignal) {
        pending.abortHandler = () => {
          incrementCounter('ws_bridge_timeline_data_plane_http_abort', {
            type: TIMELINE_MESSAGES.HISTORY,
            route: 'http_request',
          });
          this.settlePendingHttpTimelineRequest(requestId, pending, () => reject(new Error(TIMELINE_REQUEST_ERROR_REASONS.REQUEST_CANCELED)));
        };
        params.abortSignal.addEventListener('abort', pending.abortHandler, { once: true });
      }
      this.pendingHttpTimelineRequests.set(requestId, pending);

      try {
        this.daemonWs!.send(JSON.stringify({
          type: TIMELINE_MESSAGES.HISTORY_REQUEST,
          sessionName: params.sessionName,
          requestId,
          ...(typeof params.limit === 'number' ? { limit: params.limit } : {}),
          ...(typeof params.beforeTs === 'number' ? { beforeTs: params.beforeTs } : {}),
          ...(typeof params.afterTs === 'number' ? { afterTs: params.afterTs } : {}),
          ...(typeof params.budgetBytes === 'number' ? { budgetBytes: params.budgetBytes } : {}),
          ...(typeof params.includeDetails === 'boolean' ? { includeDetails: params.includeDetails } : {}),
        }));
      } catch (err) {
        const current = this.pendingHttpTimelineRequests.get(requestId) ?? pending;
        this.settlePendingHttpTimelineRequest(requestId, current, () => {
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      }
    });
  }

  getRecentText(sessionName: string): WatchRecentTextRow[] {
    const rows = this.recentTextBySession.get(sessionName);
    return rows ? rows.map((row) => ({ ...row })) : [];
  }

  async getRecentTextForWatch(sessionName: string, timeoutMs = 1500): Promise<WatchRecentTextRow[]> {
    const cached = this.getRecentText(sessionName);
    if (cached.length > 0 || !this.isDaemonConnected()) return cached;

    const pending = this.pendingRecentTextBackfills.get(sessionName);
    if (pending) return pending;

    const backfill = this.requestTimelineHistory({
      sessionName,
      limit: WATCH_RECENT_TEXT_CAP * 8,
      timeoutMs,
    }).then((response) => {
      const events = Array.isArray(response.events) ? response.events : [];
      const rows = mergeRecentTextRows(
        events
          .filter((event): event is Record<string, unknown> => !!event && typeof event === 'object')
          .map((event) => recentTextRowFromTimelineEvent(event))
          .filter((row): row is WatchRecentTextRow => row !== null),
      );
      if (rows.length > 0) {
        this.recentTextBySession.set(sessionName, rows);
      }
      return rows.map((row) => ({ ...row }));
    }).catch(() => []).finally(() => {
      this.pendingRecentTextBackfills.delete(sessionName);
    });

    this.pendingRecentTextBackfills.set(sessionName, backfill);
    return backfill;
  }

  /**
   * Register an in-flight preview HTTP relay and forward the response back as a
   * ReadableStream. The pending entry IS the in-flight slot (run 8a975732-23a
   * P0.4): callers MUST check `tryReservePreviewInflight(previewId)` BEFORE
   * calling this (the proxy "decides to forward upstream" only after passing the
   * concurrency floor). The slot is released on any terminal
   * (complete/fail/abort/rejectAllPending) — all of which delete the pending
   * entry.
   *
   * The stream uses an explicit unconsumed-byte counter (NOT desiredSize) so a
   * streaming response with a slow consumer is deterministically closed once the
   * server-side unconsumed buffer exceeds `MAX_PREVIEW_STREAM_BUFFER_BYTES`
   * (P1.2). `previewId` lets cleanup×relay (P1.4) treat live relays as non-idle.
   */
  createPreviewRelay(
    requestId: string,
    previewId: string,
    timeoutMs = PREVIEW_LIMITS.RESPONSE_START_TIMEOUT_MS,
  ): {
    start: Promise<PreviewStartPayload & { body: ReadableStream<Uint8Array> }>;
    abort: (reason?: string) => void;
  } {
    if (!this.isDaemonConnected()) {
      throw new Error(PREVIEW_ERROR.DAEMON_OFFLINE);
    }

    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    let resolveStart!: (payload: PreviewStartPayload & { body: ReadableStream<Uint8Array> }) => void;
    let rejectStart!: (err: Error) => void;

    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controllerRef = controller;
      },
      pull: () => {
        // A read drained one chunk from the internal queue — decrement the
        // explicit unconsumed-byte counter by exactly that chunk's size (FIFO).
        // Precise accounting: enqueue (pushPreviewResponseChunk) increments and
        // pushes the size; pull consumes one. `pull` is invoked by the stream
        // once per chunk pulled out as the consumer reads.
        const active = this.pendingPreviewRequests.get(requestId);
        if (!active) return;
        const consumed = active.chunkSizes.shift();
        if (consumed !== undefined) {
          active.unconsumedBytes = Math.max(0, active.unconsumedBytes - consumed);
        }
      },
      cancel: () => {
        this.abortPreviewRequest(requestId, PREVIEW_ERROR.ABORTED, true);
      },
    });

    const start = new Promise<PreviewStartPayload & { body: ReadableStream<Uint8Array> }>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });

    const timer = setTimeout(() => {
      this.failPreviewRequest({
        type: PREVIEW_MSG.ERROR,
        requestId,
        code: PREVIEW_ERROR.TIMEOUT,
        message: 'preview relay response start timeout',
        terminalOutcome: PREVIEW_TERMINAL_OUTCOME.TIMEOUT,
      });
      this.sendPreviewControl({ type: PREVIEW_MSG.ABORT, requestId, reason: PREVIEW_ERROR.TIMEOUT });
    }, timeoutMs);

    this.pendingPreviewRequests.set(requestId, {
      previewId,
      readable,
      controller: controllerRef,
      started: false,
      terminalOutcome: null,
      responseBytes: 0,
      streaming: false,
      unconsumedBytes: 0,
      chunkSizes: [],
      timer,
      timerMode: 'start',
      resolveStart: (payload) => resolveStart({ ...payload, body: readable }),
      rejectStart,
    });

    return {
      start,
      abort: (reason) => this.abortPreviewRequest(requestId, reason ?? PREVIEW_ERROR.ABORTED, true),
    };
  }

  /**
   * In-flight HTTP concurrency floor (run 8a975732-23a P0.4). Returns true if a
   * new request for `previewId` is allowed to be forwarded upstream (both the
   * per-preview and per-server in-flight ceilings have headroom). Pure read — it
   * does NOT reserve; the reservation happens implicitly when `createPreviewRelay`
   * adds the pending entry. Callers reject with
   * `PREVIEW_INFLIGHT_REJECT_HTTP_STATUS` (503) + `PREVIEW_ERROR.INFLIGHT_LIMIT`
   * when this returns false. WS tunnels are NOT counted here.
   */
  canAcceptPreviewInflight(previewId: string): boolean {
    if (this.pendingPreviewRequests.size >= PREVIEW_LIMITS.MAX_INFLIGHT_PREVIEW_HTTP_PER_SERVER) return false;
    let perPreview = 0;
    for (const pending of this.pendingPreviewRequests.values()) {
      if (pending.previewId === previewId) perPreview += 1;
    }
    return perPreview < PREVIEW_LIMITS.MAX_INFLIGHT_PREVIEW_HTTP_PER_PREVIEW;
  }

  /**
   * Whether `previewId` currently has any live relay — an in-flight HTTP request
   * OR an active/pending WS tunnel. Used by registry cleanup to skip live
   * previews (run 8a975732-23a P1.4.1).
   */
  hasActivePreviewRelay(previewId: string): boolean {
    for (const pending of this.pendingPreviewRequests.values()) {
      if (pending.previewId === previewId && !pending.terminalOutcome) return true;
    }
    for (const tunnel of this.previewWsTunnels.values()) {
      if (tunnel.previewId === previewId) return true;
    }
    return false;
  }

  sendPreviewControl(message: Record<string, unknown>): void {
    this.sendToDaemon(JSON.stringify(message));
  }

  sendPreviewRequestBodyChunk(requestId: string, payload: Uint8Array): void {
    if (!this.daemonWs || !this.authenticated) throw new Error(PREVIEW_ERROR.DAEMON_OFFLINE);
    this.daemonWs.send(packPreviewBinaryFrame(PREVIEW_BINARY_FRAME.REQUEST_BODY, requestId, payload));
  }

  // ── File transfer correlation ──────────────────────────────────────────────

  /** Returns true if the daemon WebSocket is connected and authenticated. */
  isDaemonConnected(): boolean {
    return !!(this.daemonWs && this.authenticated);
  }

  /**
   * Send a file transfer request to daemon and await the correlated response.
   * Rejects if daemon is offline or the request times out.
   */
  sendFileTransferRequest(
    requestId: string,
    message: Record<string, unknown>,
    timeoutMs: number,
    onProgress?: (msg: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> {
    if (!this.isDaemonConnected()) {
      return Promise.reject(new Error('daemon_offline'));
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFileTransfers.delete(requestId);
        reject(new Error('timeout'));
      }, timeoutMs);

      this.pendingFileTransfers.set(requestId, { resolve, reject, timer, onProgress });

      try {
        this.daemonWs!.send(JSON.stringify(message));
      } catch (err) {
        this.pendingFileTransfers.delete(requestId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Reject all pending file transfer requests (e.g. when daemon disconnects).
   */
  private rejectAllPendingFileTransfers(reason: string): void {
    for (const [, pending] of this.pendingFileTransfers) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingFileTransfers.clear();
  }

  private rejectAllPendingHttpTimelineRequests(reason: string): void {
    for (const [requestId, pending] of [...this.pendingHttpTimelineRequests]) {
      this.settlePendingHttpTimelineRequest(requestId, pending, () => pending.reject(new Error(reason)));
    }
  }

  /**
   * Try to resolve a pending file transfer request.
   * Returns true if a matching pending request was found and resolved.
   */
  resolveFileTransfer(requestId: string, msg: Record<string, unknown>): boolean {
    const pending = this.pendingFileTransfers.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingFileTransfers.delete(requestId);
    pending.resolve(msg);
    return true;
  }

  notifyFileTransferProgress(requestId: string, msg: Record<string, unknown>): boolean {
    const pending = this.pendingFileTransfers.get(requestId);
    if (!pending) return false;
    pending.onProgress?.(msg);
    return true;
  }

  // ── Memory source resolution correlation ───────────────────────────────
  //
  // Mirrors sendFileTransferRequest — a unicast request/response over the
  // daemon WS gated by requestId. The `/api/memory/sources` HTTP route
  // calls this after the ingress has pod-sticky-routed the request to this
  // pod (the one holding the target daemon's WS).

  /**
   * Send a memory source resolution request to the daemon and await the
   * correlated reply. Rejects with 'daemon_offline' when the WS is not
   * authenticated, 'timeout' on slow daemons.
   */
  sendMemorySourcesRequest(requestId: string, projectionId: string, expectedProjectId: string, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.isDaemonConnected()) {
      return Promise.reject(new Error('daemon_offline'));
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMemorySourcesRequests.delete(requestId);
        reject(new Error('timeout'));
      }, timeoutMs);

      this.pendingMemorySourcesRequests.set(requestId, { resolve, reject, timer });

      try {
        this.daemonWs!.send(JSON.stringify({
          type: MEMORY_WS.GET_SOURCES_REQUEST,
          requestId,
          projectionId,
          expectedProjectId,
          // The daemon stamps its own bound serverId on the reply, but we
          // also tell it our expected serverId so its log can flag mis-
          // routing when present.
          expectedServerId: this.serverId,
        }));
      } catch (err) {
        this.pendingMemorySourcesRequests.delete(requestId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Try to resolve a pending memory.get_sources request.
   * Returns true if a matching pending request was found and resolved.
   */
  resolveMemorySources(requestId: string, msg: Record<string, unknown>): boolean {
    const pending = this.pendingMemorySourcesRequests.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingMemorySourcesRequests.delete(requestId);
    pending.resolve(msg);
    return true;
  }

  /**
   * Reject all pending memory.get_sources requests (e.g. on daemon disconnect).
   */
  private rejectAllPendingMemorySourcesRequests(reason: string): void {
    for (const [, pending] of this.pendingMemorySourcesRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingMemorySourcesRequests.clear();
  }

  private resolvePreviewStart(msg: PreviewResponseStartMessage): void {
    const pending = this.pendingPreviewRequests.get(msg.requestId);
    if (!pending || pending.terminalOutcome) return;
    if (pending.started) return;
    pending.started = true;
    // Classify ONCE at RESPONSE_START via the SAME shared predicate the daemon
    // uses (run 8a975732-23a P1.1) so the two sides can never disagree (no
    // one-side-exempt/one-side-abort half-truncation). Streaming → exempt from
    // the cumulative MAX_RESPONSE_BYTES cap; bounded instead by stream-idle +
    // the unconsumed-buffer high-watermark.
    pending.streaming = isStreamingResponse(msg.headers);
    this.resetPreviewTimeout(msg.requestId, PREVIEW_LIMITS.STREAM_IDLE_TIMEOUT_MS, 'idle');
    pending.resolveStart({
      status: msg.status,
      statusText: msg.statusText,
      headers: msg.headers,
    });
  }

  private pushPreviewResponseChunk(requestId: string, chunk: Buffer): void {
    const pending = this.pendingPreviewRequests.get(requestId);
    if (!pending || pending.terminalOutcome) return;
    if (!pending.started || !pending.controller) {
      this.failPreviewRequest({
        type: PREVIEW_MSG.ERROR,
        requestId,
        code: PREVIEW_ERROR.INVALID_REQUEST,
        message: 'preview response body arrived before response start',
        terminalOutcome: PREVIEW_TERMINAL_OUTCOME.ERROR,
      });
      return;
    }

    pending.responseBytes += chunk.length;
    // Non-streaming responses keep the cumulative byte-cap protection. Streaming
    // responses (SSE / ndjson / chunked non-JSON) are EXEMPT (P1.2.1).
    if (!pending.streaming && pending.responseBytes > PREVIEW_LIMITS.MAX_RESPONSE_BYTES) {
      this.failPreviewRequest({
        type: PREVIEW_MSG.ERROR,
        requestId,
        code: PREVIEW_ERROR.LIMIT_EXCEEDED,
        message: 'preview response exceeded max bytes',
        terminalOutcome: PREVIEW_TERMINAL_OUTCOME.LIMIT_EXCEEDED,
      });
      this.sendPreviewControl({ type: PREVIEW_MSG.ABORT, requestId, reason: PREVIEW_ERROR.LIMIT_EXCEEDED });
      return;
    }

    // Unconsumed-buffer high-watermark (P1.2.2). Measured in BYTES via an
    // explicit counter — NOT controller.desiredSize. A slow consumer + fast
    // stream that lets unconsumed bytes exceed MAX_PREVIEW_STREAM_BUFFER_BYTES
    // is deterministically closed (emit terminal, not silent).
    pending.unconsumedBytes += chunk.length;
    pending.chunkSizes.push(chunk.length);
    if (pending.unconsumedBytes > PREVIEW_LIMITS.MAX_PREVIEW_STREAM_BUFFER_BYTES) {
      this.failPreviewRequest({
        type: PREVIEW_MSG.ERROR,
        requestId,
        code: PREVIEW_ERROR.LIMIT_EXCEEDED,
        message: 'preview stream unconsumed buffer exceeded high-watermark',
        terminalOutcome: PREVIEW_TERMINAL_OUTCOME.LIMIT_EXCEEDED,
      });
      this.sendPreviewControl({ type: PREVIEW_MSG.ABORT, requestId, reason: PREVIEW_ERROR.LIMIT_EXCEEDED });
      return;
    }

    this.resetPreviewTimeout(requestId, PREVIEW_LIMITS.STREAM_IDLE_TIMEOUT_MS, 'idle');
    // Slide the preview TTL while a stream is actively delivering data, so a
    // long-lived SSE (> preview_session_idle) is not idle-evicted (P1.3.2).
    // touch() is clamped by the absolute lifetime hard ceiling.
    LocalWebPreviewRegistry.get(this.serverId).touch(pending.previewId);
    pending.controller.enqueue(chunk);
  }

  private resetPreviewTimeout(requestId: string, timeoutMs: number, mode: 'start' | 'idle'): void {
    const pending = this.pendingPreviewRequests.get(requestId);
    if (!pending || pending.terminalOutcome) return;
    clearTimeout(pending.timer);
    pending.timerMode = mode;
    pending.timer = setTimeout(() => {
      const active = this.pendingPreviewRequests.get(requestId);
      if (!active || active.terminalOutcome) return;
      this.failPreviewRequest({
        type: PREVIEW_MSG.ERROR,
        requestId,
        code: PREVIEW_ERROR.TIMEOUT,
        message: mode === 'start' ? 'preview relay response start timeout' : 'preview relay stream idle timeout',
        terminalOutcome: PREVIEW_TERMINAL_OUTCOME.TIMEOUT,
      });
      this.sendPreviewControl({ type: PREVIEW_MSG.ABORT, requestId, reason: PREVIEW_ERROR.TIMEOUT });
    }, timeoutMs);
  }

  private completePreviewRequest(requestId: string, outcome: string): void {
    const pending = this.pendingPreviewRequests.get(requestId);
    if (!pending || pending.terminalOutcome) return;
    pending.terminalOutcome = outcome;
    clearTimeout(pending.timer);
    if (!pending.started) {
      pending.rejectStart(new Error(outcome));
    } else {
      pending.controller?.close();
    }
    this.pendingPreviewRequests.delete(requestId);
  }

  private failPreviewRequest(msg: PreviewErrorMessage): void {
    const pending = this.pendingPreviewRequests.get(msg.requestId);
    if (!pending || pending.terminalOutcome) return;
    pending.terminalOutcome = msg.terminalOutcome ?? PREVIEW_TERMINAL_OUTCOME.ERROR;
    clearTimeout(pending.timer);
    const error = new Error(msg.message || msg.code);
    if (!pending.started) pending.rejectStart(error);
    else pending.controller?.error(error);
    this.pendingPreviewRequests.delete(msg.requestId);
    logger.warn({
      serverId: this.serverId,
      requestId: msg.requestId,
      code: msg.code,
      message: msg.message,
    }, 'Preview relay failed');
  }

  private abortPreviewRequest(requestId: string, reason: string, propagate: boolean): void {
    const pending = this.pendingPreviewRequests.get(requestId);
    if (!pending || pending.terminalOutcome) return;
    pending.terminalOutcome = PREVIEW_TERMINAL_OUTCOME.ABORTED;
    clearTimeout(pending.timer);
    const error = new Error(reason);
    if (!pending.started) pending.rejectStart(error);
    else pending.controller?.error(error);
    this.pendingPreviewRequests.delete(requestId);
    if (propagate) this.sendPreviewControl({ type: PREVIEW_MSG.ABORT, requestId, reason });
  }

  private rejectAllPendingPreviewRequests(reason: string): void {
    for (const requestId of this.pendingPreviewRequests.keys()) {
      this.abortPreviewRequest(requestId, reason, false);
    }
  }

  /**
   * Tear down every relay belonging to `previewId` (run 8a975732-23a P1.4.2).
   * Called when the registry evicts the preview (idle/hard-lifetime) so the
   * client always sees a deterministic terminal: pending HTTP relays are aborted
   * (and the abort is propagated to the daemon so the upstream fetch stops), and
   * all WS tunnels for the preview are closed (NON-silent). MUST NOT leave a
   * half-dead SSE or silently 404 a freshly-requested sub-resource.
   */
  terminatePreviewRelaysForPreview(previewId: string): void {
    for (const [requestId, pending] of [...this.pendingPreviewRequests]) {
      if (pending.previewId !== previewId) continue;
      this.abortPreviewRequest(requestId, PREVIEW_ERROR.PREVIEW_EXPIRED, true);
    }
    this.closeAllPreviewWsForPreview(previewId);
  }

  // ── Preview WS Tunnel ──────────────────────────────────────────────────────

  /**
   * Begin a preview WS tunnel with a DEFERRED browser handshake (run
   * 8a975732-23a P1.5.1). Sends `preview.ws.open` to the daemon and holds the
   * browser HTTP upgrade open until the daemon reports the upstream-negotiated
   * subprotocol via `WS_OPENED.protocol`. Only then do we complete the handshake
   * (echoing that protocol) and promote to an active tunnel — so the browser's
   * `WebSocket.protocol` matches the upstream end-to-end. On WS_ERROR / open
   * timeout the handshake is failed without ever upgrading.
   *
   * `completeUpgrade(protocol)` MUST perform `wss.handleUpgrade(...)` selecting
   * `protocol` and resolve the upgraded `WebSocket` (or null on failure).
   */
  beginPreviewWsTunnel(args: {
    wsId: string;
    previewId: string;
    port: number;
    path: string;
    headers: Record<string, string>;
    protocols: string[];
    completeUpgrade: (protocol: string | undefined) => Promise<WebSocket | null>;
  }): void {
    const { wsId, previewId, port, path, headers, protocols, completeUpgrade } = args;
    const openTimer = setTimeout(() => {
      const pending = this.pendingPreviewWsUpgrades.get(wsId);
      if (!pending) return;
      this.pendingPreviewWsUpgrades.delete(wsId);
      logger.warn({ serverId: this.serverId, wsId, previewId }, 'Preview WS tunnel open timeout (deferred upgrade)');
      // Fail the handshake without upgrading. completeUpgrade(undefined) is the
      // caller's signal to reject the socket (it returns null and destroys it).
      void pending.completeUpgrade(undefined).catch(() => null);
      this.sendPreviewControl({ type: PREVIEW_MSG.WS_CLOSE, wsId, code: 1001, reason: 'open timeout' });
      this.maybeCleanup();
    }, PREVIEW_LIMITS.WS_OPEN_TIMEOUT_MS);
    openTimer.unref?.();

    this.pendingPreviewWsUpgrades.set(wsId, { previewId, completeUpgrade, openTimer });

    this.sendPreviewControl({
      type: PREVIEW_MSG.WS_OPEN,
      wsId,
      previewId,
      port,
      path,
      headers,
      protocols,
    });
  }

  /**
   * Create a new WS tunnel in pending state.
   * Sends preview.ws.open to daemon and starts open timeout timer.
   */
  createPreviewWsTunnel(
    wsId: string,
    previewId: string,
    port: number,
    path: string,
    browserWs: WebSocket,
    headers: Record<string, string>,
    protocols: string[],
  ): void {
    const openTimer = setTimeout(() => {
      const tunnel = this.previewWsTunnels.get(wsId);
      if (!tunnel) return;
      logger.warn({ serverId: this.serverId, wsId, previewId }, 'Preview WS tunnel open timeout');
      try { tunnel.browserWs.close(1001, 'open timeout'); } catch { /* ignore */ }
      this.cleanupTunnel(wsId);
    }, PREVIEW_LIMITS.WS_OPEN_TIMEOUT_MS);

    const tunnel: WsTunnelState = {
      browserWs,
      previewId,
      idleTimer: null,
      openTimer,
      state: 'pending',
      messageQueue: [],
      queueBytes: 0,
      createdAt: Date.now(),
    };
    this.previewWsTunnels.set(wsId, tunnel);

    // Wire browser WS events
    browserWs.on('message', (data: Buffer | string, isBinary: boolean) => {
      this.handleBrowserWsTunnelMessage(wsId, data, isBinary);
    });

    browserWs.on('close', (code: number, reason: Buffer) => {
      this.handleBrowserWsTunnelClose(wsId, code, reason.toString());
    });

    browserWs.on('error', () => {
      this.handleBrowserWsTunnelClose(wsId, 1011, 'error');
    });

    // Send preview.ws.open to daemon
    this.sendPreviewControl({
      type: PREVIEW_MSG.WS_OPEN,
      wsId,
      previewId,
      port,
      path,
      headers,
      protocols,
    });
  }

  /**
   * Adopt an already-upgraded browser socket into an ACTIVE tunnel (run
   * 8a975732-23a P1.5.1, deferred-upgrade path). The handshake has already been
   * completed by the caller with the upstream-negotiated `protocol`, and the
   * daemon's upstream WS is already open, so there is no pending state and no
   * message queue to flush — we start the idle timer and relay immediately.
   */
  private adoptActivePreviewWsTunnel(
    wsId: string,
    previewId: string,
    browserWs: WebSocket,
    protocol: string | undefined,
  ): void {
    const tunnel: WsTunnelState = {
      browserWs,
      previewId,
      idleTimer: null,
      openTimer: null,
      state: 'active',
      messageQueue: [],
      queueBytes: 0,
      createdAt: Date.now(),
    };
    this.previewWsTunnels.set(wsId, tunnel);

    browserWs.on('message', (data: Buffer | string, isBinary: boolean) => {
      this.handleBrowserWsTunnelMessage(wsId, data, isBinary);
    });
    browserWs.on('close', (code: number, reason: Buffer) => {
      this.handleBrowserWsTunnelClose(wsId, code, reason.toString());
    });
    browserWs.on('error', () => {
      this.handleBrowserWsTunnelClose(wsId, 1011, 'error');
    });

    this.resetWsTunnelIdleTimer(wsId);
    logger.info({ serverId: this.serverId, wsId, previewId, protocol }, 'Preview WS tunnel active (deferred upgrade)');
  }

  /**
   * Called when daemon sends preview.ws.opened.
   * Transitions tunnel to active state, flushes queued messages.
   */
  private resolvePreviewWsOpened(msg: PreviewWsOpenedMessage): void {
    // Deferred-upgrade path (P1.5.1): complete the held-open browser handshake
    // echoing the upstream-negotiated subprotocol, then promote to an active
    // tunnel. The browser's WebSocket.protocol now matches the upstream.
    const deferred = this.pendingPreviewWsUpgrades.get(msg.wsId);
    if (deferred) {
      this.pendingPreviewWsUpgrades.delete(msg.wsId);
      clearTimeout(deferred.openTimer);
      void deferred.completeUpgrade(msg.protocol).then((browserWs) => {
        if (!browserWs) {
          // Handshake failed after WS_OPENED — tell daemon to close upstream.
          this.sendPreviewControl({ type: PREVIEW_MSG.WS_CLOSE, wsId: msg.wsId, code: 1011, reason: 'handshake failed' });
          return;
        }
        this.adoptActivePreviewWsTunnel(msg.wsId, deferred.previewId, browserWs, msg.protocol);
      }).catch((err) => {
        logger.warn({ serverId: this.serverId, wsId: msg.wsId, err }, 'Preview WS deferred upgrade failed');
        this.sendPreviewControl({ type: PREVIEW_MSG.WS_CLOSE, wsId: msg.wsId, code: 1011, reason: 'handshake failed' });
      });
      return;
    }

    const tunnel = this.previewWsTunnels.get(msg.wsId);
    if (!tunnel) return;

    // Cancel open timeout
    if (tunnel.openTimer) {
      clearTimeout(tunnel.openTimer);
      tunnel.openTimer = null;
    }

    tunnel.state = 'active';

    // Flush queued messages to daemon
    for (const queued of tunnel.messageQueue) {
      const isBinary = (queued[0] & 0x01) !== 0;
      const payload = queued.subarray(1);
      if (this.daemonWs && this.authenticated) {
        try {
          this.daemonWs.send(packPreviewWsFrame(msg.wsId, isBinary, payload));
        } catch (err) {
          logger.warn({ serverId: this.serverId, wsId: msg.wsId, err }, 'Failed to flush queued WS message to daemon');
        }
      }
    }
    tunnel.messageQueue = [];
    tunnel.queueBytes = 0;

    // Start idle timer
    this.resetWsTunnelIdleTimer(msg.wsId);

    logger.info({ serverId: this.serverId, wsId: msg.wsId, previewId: tunnel.previewId, protocol: msg.protocol }, 'Preview WS tunnel active');
  }

  /**
   * Called when daemon sends preview.ws.error.
   * Closes browser WS with 1011 and cleans up.
   */
  private handlePreviewWsError(msg: PreviewWsErrorMessage): void {
    // Deferred-upgrade path: daemon rejected the upstream upgrade before
    // WS_OPENED. Fail the held-open browser handshake without upgrading.
    const deferred = this.pendingPreviewWsUpgrades.get(msg.wsId);
    if (deferred) {
      this.pendingPreviewWsUpgrades.delete(msg.wsId);
      clearTimeout(deferred.openTimer);
      logger.warn({ serverId: this.serverId, wsId: msg.wsId, error: msg.error }, 'Preview WS upstream error before upgrade');
      void deferred.completeUpgrade(undefined).catch(() => null);
      this.maybeCleanup();
      return;
    }
    const tunnel = this.previewWsTunnels.get(msg.wsId);
    if (!tunnel) return;
    logger.warn({ serverId: this.serverId, wsId: msg.wsId, error: msg.error }, 'Preview WS tunnel error from daemon');
    try { tunnel.browserWs.close(1011, 'upstream error'); } catch { /* ignore */ }
    this.cleanupTunnel(msg.wsId);
  }

  /**
   * Called when daemon sends preview.ws.close.
   * Forwards close frame to browser WS and cleans up.
   */
  private handlePreviewWsClose(msg: PreviewWsCloseMessage): void {
    // Deferred-upgrade path: daemon closed the upstream before WS_OPENED.
    const deferred = this.pendingPreviewWsUpgrades.get(msg.wsId);
    if (deferred) {
      this.pendingPreviewWsUpgrades.delete(msg.wsId);
      clearTimeout(deferred.openTimer);
      void deferred.completeUpgrade(undefined).catch(() => null);
      this.maybeCleanup();
      return;
    }
    const tunnel = this.previewWsTunnels.get(msg.wsId);
    if (!tunnel) return;
    try { tunnel.browserWs.close(msg.code, msg.reason); } catch { /* ignore */ }
    this.cleanupTunnel(msg.wsId);
  }

  /**
   * Relay a WS_DATA frame from daemon to the browser WS.
   */
  private relayWsDataToBrowser(wsId: string, isBinary: boolean, payload: Buffer): void {
    const tunnel = this.previewWsTunnels.get(wsId);
    if (!tunnel || tunnel.state !== 'active') return;

    // Enforce max message size
    if (payload.length > PREVIEW_LIMITS.MAX_WS_MESSAGE_BYTES) {
      logger.warn({ serverId: this.serverId, wsId, size: payload.length }, 'Preview WS: daemon→browser message too large — closing with 1009');
      try { tunnel.browserWs.close(1009, 'message too large'); } catch { /* ignore */ }
      this.sendPreviewControl({ type: PREVIEW_MSG.WS_CLOSE, wsId, code: 1009, reason: 'message too large' });
      this.cleanupTunnel(wsId);
      return;
    }

    this.resetWsTunnelIdleTimer(wsId);
    LocalWebPreviewRegistry.get(this.serverId).touch(tunnel.previewId);

    try {
      tunnel.browserWs.send(payload, { binary: isBinary });
    } catch (err) {
      logger.warn({ serverId: this.serverId, wsId, err }, 'Failed to relay WS_DATA to browser');
    }
  }

  /**
   * Handle message from browser on a WS tunnel connection.
   */
  private handleBrowserWsTunnelMessage(wsId: string, data: Buffer | string, isBinary: boolean): void {
    const tunnel = this.previewWsTunnels.get(wsId);
    if (!tunnel) return;

    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data as string);

    // Enforce max message size
    if (payload.length > PREVIEW_LIMITS.MAX_WS_MESSAGE_BYTES) {
      logger.warn({ serverId: this.serverId, wsId, size: payload.length }, 'Preview WS: browser→daemon message too large — closing with 1009');
      try { tunnel.browserWs.close(1009, 'message too large'); } catch { /* ignore */ }
      this.sendPreviewControl({ type: PREVIEW_MSG.WS_CLOSE, wsId, code: 1009, reason: 'message too large' });
      this.cleanupTunnel(wsId);
      return;
    }

    if (tunnel.state === 'pending') {
      // Queue message while waiting for preview.ws.opened
      // Encode binary flag in first byte: 1=binary, 0=text
      const flagByte = Buffer.allocUnsafe(1);
      flagByte[0] = isBinary ? 1 : 0;
      const entry = Buffer.concat([flagByte, payload]);
      const newBytes = tunnel.queueBytes + entry.length;

      if (newBytes > PREVIEW_LIMITS.MAX_WS_PENDING_QUEUE_BYTES) {
        logger.warn({ serverId: this.serverId, wsId }, 'Preview WS: pending queue overflow — closing with 1008');
        try { tunnel.browserWs.close(1008, 'policy violation'); } catch { /* ignore */ }
        this.sendPreviewControl({ type: PREVIEW_MSG.WS_CLOSE, wsId, code: 1008, reason: 'policy violation' });
        this.cleanupTunnel(wsId);
        return;
      }

      tunnel.messageQueue.push(entry);
      tunnel.queueBytes = newBytes;
      return;
    }

    // Active state — relay to daemon
    this.resetWsTunnelIdleTimer(wsId);
    LocalWebPreviewRegistry.get(this.serverId).touch(tunnel.previewId);

    if (this.daemonWs && this.authenticated) {
      try {
        this.daemonWs.send(packPreviewWsFrame(wsId, isBinary, payload));
      } catch (err) {
        logger.warn({ serverId: this.serverId, wsId, err }, 'Failed to relay browser WS message to daemon');
      }
    }
  }

  /**
   * Handle browser-side WS close on a tunnel connection.
   * Notifies daemon and cleans up.
   */
  private handleBrowserWsTunnelClose(wsId: string, code: number, reason: string): void {
    const tunnel = this.previewWsTunnels.get(wsId);
    if (!tunnel) return;
    this.sendPreviewControl({ type: PREVIEW_MSG.WS_CLOSE, wsId, code, reason });
    this.cleanupTunnel(wsId);
  }

  /**
   * Close all WS tunnels for a given previewId.
   * Called when the preview expires or is stopped.
   */
  closeAllPreviewWsForPreview(previewId: string): void {
    for (const [wsId, tunnel] of this.previewWsTunnels) {
      if (tunnel.previewId !== previewId) continue;
      try { tunnel.browserWs.close(1001, 'preview closed'); } catch { /* ignore */ }
      this.sendPreviewControl({ type: PREVIEW_MSG.WS_CLOSE, wsId, code: 1001, reason: 'preview closed' });
      this.cleanupTunnel(wsId);
    }
    // Also fail any deferred upgrades still awaiting WS_OPENED for this preview.
    for (const [wsId, pending] of [...this.pendingPreviewWsUpgrades]) {
      if (pending.previewId !== previewId) continue;
      this.pendingPreviewWsUpgrades.delete(wsId);
      clearTimeout(pending.openTimer);
      void pending.completeUpgrade(undefined).catch(() => null);
      this.sendPreviewControl({ type: PREVIEW_MSG.WS_CLOSE, wsId, code: 1001, reason: 'preview closed' });
    }
  }

  /**
   * Close all WS tunnels. Called on daemon disconnect.
   */
  private closeAllPreviewWsTunnels(code: number, reason: string): void {
    for (const [wsId, tunnel] of this.previewWsTunnels) {
      try { tunnel.browserWs.close(code, reason); } catch { /* ignore */ }
      this.cleanupTunnel(wsId);
    }
    // Fail any deferred upgrades — the daemon is gone, so the upstream can never open.
    for (const [wsId, pending] of [...this.pendingPreviewWsUpgrades]) {
      this.pendingPreviewWsUpgrades.delete(wsId);
      clearTimeout(pending.openTimer);
      void pending.completeUpgrade(undefined).catch(() => null);
    }
  }

  /**
   * Clean up a single tunnel entry (timers, map removal).
   * Does NOT close the browserWs or send preview.ws.close — callers handle that.
   */
  private cleanupTunnel(wsId: string): void {
    const tunnel = this.previewWsTunnels.get(wsId);
    if (!tunnel) return;
    if (tunnel.idleTimer) { clearTimeout(tunnel.idleTimer); tunnel.idleTimer = null; }
    if (tunnel.openTimer) { clearTimeout(tunnel.openTimer); tunnel.openTimer = null; }
    this.previewWsTunnels.delete(wsId);
    this.maybeCleanup();
  }

  /**
   * Reset (or start) the idle timer for a tunnel.
   */
  private resetWsTunnelIdleTimer(wsId: string): void {
    const tunnel = this.previewWsTunnels.get(wsId);
    if (!tunnel) return;
    if (tunnel.idleTimer) clearTimeout(tunnel.idleTimer);
    tunnel.idleTimer = setTimeout(() => {
      const t = this.previewWsTunnels.get(wsId);
      if (!t) return;
      logger.info({ serverId: this.serverId, wsId, previewId: t.previewId }, 'Preview WS tunnel idle timeout — closing with 1000');
      try { t.browserWs.close(1000, 'idle timeout'); } catch { /* ignore */ }
      this.sendPreviewControl({ type: PREVIEW_MSG.WS_CLOSE, wsId, code: 1000, reason: 'idle timeout' });
      this.cleanupTunnel(wsId);
    }, PREVIEW_LIMITS.WS_IDLE_TIMEOUT_MS);
  }

  /**
   * Periodic cleanup: remove tunnel entries where browser WS is no longer open.
   * Defense-in-depth against missed close events.
   */
  sweepStaleTunnels(): void {
    for (const [wsId, tunnel] of this.previewWsTunnels) {
      if (tunnel.browserWs.readyState !== WebSocket.OPEN) {
        logger.info({ serverId: this.serverId, wsId }, 'Preview WS tunnel sweep: removing stale entry');
        this.cleanupTunnel(wsId);
      }
    }
  }

  /**
   * Count WS tunnels for a given previewId (active + deferred-upgrade pending).
   * Used by the upgrade handler to enforce `MAX_WS_PER_PREVIEW`; pending upgrades
   * are counted so a flood of simultaneous handshakes can't bypass the ceiling.
   */
  getPreviewWsCount(previewId: string): number {
    let count = 0;
    for (const tunnel of this.previewWsTunnels.values()) {
      if (tunnel.previewId === previewId) count++;
    }
    for (const pending of this.pendingPreviewWsUpgrades.values()) {
      if (pending.previewId === previewId) count++;
    }
    return count;
  }

  /** Total WS tunnel count across all previews (active + deferred-upgrade pending). */
  getServerWsCount(): number {
    return this.previewWsTunnels.size + this.pendingPreviewWsUpgrades.size;
  }

  // ── Push notifications ──────────────────────────────────────────────────────

  /** Dedup: last push timestamp per session to avoid duplicate notifications. */
  private lastPushAt = new Map<string, number>();
  private static readonly PUSH_DEDUP_MS = 10_000;

  private async resolveReadablePushDisplay(
    db: Database,
    sessionName: string,
    daemonLabel: string | undefined,
    daemonParentLabel: string | undefined,
    daemonProject: string | undefined,
  ): Promise<{
    displayName: string;
    agentType?: string;
  }> {
    const visited = new Set<string>();
    const activeMainSession = this.activeMainSessions.get(sessionName);
    let effectiveAgentType = pickReadableSessionDisplay([activeMainSession?.agentType], sessionName);
    let currentSessionName: string | undefined = sessionName;
    let displayName = pickReadableSessionDisplay([daemonLabel], sessionName);

    while (currentSessionName && !visited.has(currentSessionName)) {
      visited.add(currentSessionName);

      const active = this.activeMainSessions.get(currentSessionName);
      const activeSubSession = this.activeSubSessions.get(currentSessionName);
      let sessionRow = await db.queryOne<{ project_name: string; agent_type: string; label: string | null }>(
        'SELECT project_name, agent_type, label FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
        [this.serverId, currentSessionName],
      ).catch(() => null);

      let parentSession: string | undefined;
      let subType: string | undefined;
      if (activeSubSession) {
        subType = activeSubSession.agentType;
        parentSession = activeSubSession.parentSession;
        const activeSubDisplay = pickReadableSessionDisplay([activeSubSession.label], currentSessionName);
        if (!displayName && activeSubDisplay) displayName = activeSubDisplay;
      }
      if (!sessionRow && currentSessionName.startsWith('deck_sub_')) {
        const subRow: { type: string; label: string | null; parent_session: string | null } | null = await db
          .queryOne<{ type: string; label: string | null; parent_session: string | null }>(
            'SELECT type, label, parent_session FROM sub_sessions WHERE server_id = $1 AND id = $2 LIMIT 1',
            [this.serverId, currentSessionName.replace(/^deck_sub_/, '')],
          )
          .catch(() => null);
        if (subRow) {
          subType = subRow.type;
          parentSession = subRow.parent_session ?? undefined;
          const subDisplay = pickReadableSessionDisplay([subRow.label], currentSessionName);
          if (!displayName && subDisplay) displayName = subDisplay;
        }
      }

      effectiveAgentType = effectiveAgentType
        || subType
        || active?.agentType
        || sessionRow?.agent_type
        || undefined;

      if (!displayName) {
        const candidate = pickReadableSessionDisplay(
          [
            active?.label,
            sessionRow?.label,
            active?.project,
            sessionRow?.project_name,
          ],
          currentSessionName,
        );
        if (candidate) displayName = candidate;
      }

      if (displayName) break;
      currentSessionName = parentSession;
    }

    displayName = displayName
      || pickReadableSessionDisplay([activeMainSession?.label, activeMainSession?.project, daemonParentLabel, daemonProject], sessionName)
      || sessionName;

    return {
      displayName,
      ...(effectiveAgentType ? { agentType: effectiveAgentType } : {}),
    };
  }

  private async dispatchEventPush(db: Database, env: Env, msg: Record<string, unknown>): Promise<void> {
    // Dedup: same session idle/error can fire from both hook and timeline paths
    const sessionKey = `${msg.type}:${msg.session ?? msg.sessionId ?? ''}`;
    const now = Date.now();
    const lastPush = this.lastPushAt.get(sessionKey);
    if (lastPush && now - lastPush < WsBridge.PUSH_DEDUP_MS) return;
    this.lastPushAt.set(sessionKey, now);

    const server = await db.queryOne<{ user_id: string; name: string }>('SELECT user_id, name FROM servers WHERE id = $1', [this.serverId]);
    if (!server) return;

    for (const mobileWs of this.mobileSockets) {
      if (mobileWs.readyState !== WebSocket.OPEN) continue;
      if (this.browserUserIds.get(mobileWs) !== server.user_id) continue;
      return;
    }

    const { dispatchPush } = await import('../routes/push.js').catch((err) => {
      logger.error({ err }, 'Failed to import push module — push notifications disabled');
      return { dispatchPush: null };
    });
    if (!dispatchPush) return;

    const sessionName = String(msg.session ?? msg.sessionId ?? '');
    const eventType = String(msg.type ?? '');
    const daemonLabel = msg.label ? String(msg.label) : undefined;
    const daemonParentLabel = msg.parentLabel ? String(msg.parentLabel) : undefined;
    const daemonProject = msg.project ? String(msg.project) : undefined;
    const resolved = await this.resolveReadablePushDisplay(db, sessionName, daemonLabel, daemonParentLabel, daemonProject);
    const displayName = resolved.displayName;
    const agentType = resolved.agentType || String(msg.agentType ?? '');
    const titleParts = [server.name, displayName];
    if (agentType) titleParts.push(agentType);
    const lastText = String(msg.lastText ?? msg.message ?? '').slice(0, 200);

    let title: string;
    let body: string;
    switch (eventType) {
      case 'session.idle':
        title = titleParts.join(' · ');
        body = lastText || 'Task complete — ready for input';
        break;
      case 'session.notification': {
        title = titleParts.join(' · ');
        body = String(msg.message ?? 'Notification');
        break;
      }
      case 'session.error':
        title = titleParts.join(' · ');
        body = `Error: ${String(msg.error ?? 'unknown')}`;
        break;
      case 'ask.question':
        title = titleParts.join(' · ');
        body = lastText || 'Waiting for your answer';
        break;
      default:
        return;
    }

    await dispatchPush({
      userId: server.user_id,
      title,
      body,
      data: { serverId: this.serverId, session: sessionName, type: eventType },
    }, env);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  private getBrowserId(ws: WebSocket): string {
    const id = (ws as WebSocket & { _bridgeId?: string })._bridgeId
      ?? ((ws as WebSocket & { _bridgeId?: string })._bridgeId = Math.random().toString(36).slice(2));
    return id;
  }

  private maybeCleanup(): void {
    if (
      !this.daemonWs
      && this.browserSockets.size === 0
      && this.previewWsTunnels.size === 0
      && this.pendingPreviewWsUpgrades.size === 0
    ) {
      this.browserRateLimiter.stop();
      if (this.shareExpirySweepTimer) {
        clearInterval(this.shareExpirySweepTimer);
        this.shareExpirySweepTimer = null;
      }
      WsBridge.instances.delete(this.serverId);
    }
  }

  get browserCount(): number {
    return this.browserSockets.size;
  }

  get isAuthenticated(): boolean {
    return this.authenticated;
  }

  getDaemonP2pWorkflowCapabilities(now = Date.now()): DaemonP2pWorkflowCapabilities | null {
    if (!this.daemonP2pWorkflowCapabilities) return null;
    if (now - this.daemonP2pWorkflowCapabilities.receivedAt > P2P_CAPABILITY_FRESHNESS_TTL_MS) {
      return null;
    }
    return {
      ...this.daemonP2pWorkflowCapabilities,
      capabilities: [...this.daemonP2pWorkflowCapabilities.capabilities],
    };
  }

  hasDaemonCapability(capability: string, _now = Date.now()): boolean {
    // Static feature gates (for example session-group clone) should remain
    // true while the daemon socket that sent the hello is still connected.
    // P2P workflow launch freshness continues to use
    // getDaemonP2pWorkflowCapabilities(now).
    if (!this.daemonWs || this.daemonWs.readyState !== WebSocket.OPEN) return false;
    return this.daemonP2pWorkflowCapabilities?.capabilities.includes(capability) ?? false;
  }
}
