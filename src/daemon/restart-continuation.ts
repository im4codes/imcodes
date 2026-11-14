/**
 * Durable one-shot auto-`continue` coordination across daemon upgrades,
 * graceful restarts, and unclean exits.
 *
 * Lifecycle:
 * 1. Pre-shutdown (`performShutdown`, BEFORE transports/ConPTY are killed)
 *    captures eligible sessions with an active in-flight turn into
 *    `~/.imcodes/restart-continuations.json`.
 * 2. Startup (`captureUncleanRestartContinuations`, right after `loadStore()`)
 *    handles crash/unclean restarts where shutdown capture never ran, by
 *    scanning persisted `running`/`queued` sessions or `handoff_inflight` /
 *    `dispatching` rows (unless explicitly stopped by the user).
 * 3. Restore:
 *    - Transport sessions with a pending marker are pulled into the fast first
 *      restore wave (`hasRestorableLocalTransportSessions` / `restoreTransportSessions`).
 *      Once runtime & queue recovery complete, `dispatchTransportRestartContinuation`
 *      re-validates exclusions (ineligible, user-stopped, non-empty pending/resend
 *      queue, Codex rollout `task_complete`), atomically consumes the marker, and
 *      dispatches a single system-origin `'continue'` with an epoch-scoped `commandId`.
 *    - Process sessions whose tmux pane stayed alive (`isLiveSession && paneAlive`)
 *      simply consume/discard the marker without disturbing the live CLI process.
 *      Restarted/respawned process sessions dispatch a single `'continue'` after
 *      `postLaunch` + init context injection finish.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CHAT_MESSAGE_ORIGINS, USER_MESSAGE_ORIGIN_FIELDS } from '../../shared/chat-message-origin.js';
import {
  DAEMON_RESTART_CONTINUATION_COMMAND_PREFIX,
  DAEMON_RESTART_CONTINUATION_FILE,
  DAEMON_RESTART_CONTINUATION_TTL_MS,
} from '../../shared/daemon-upgrade.js';
import { EXECUTION_CLONE_KIND } from '../../shared/execution-clone.js';
import { isIncognitoSession } from '../../shared/session-incognito-types.js';
import { isTransportAgent } from '../agent/detect.js';
import type { SessionRecord } from '../store/session-store.js';
import { imcodesStateDir } from '../util/imcodes-state-dir.js';
import logger from '../util/logger.js';

export interface PendingRestartContinuation {
  sessionName: string;
  runtimeType: 'transport' | 'process';
  agentType: string;
  providerId?: string;
  epoch: string;
  reason: 'graceful_shutdown' | 'unclean_exit';
  capturedAt: number;
  expiresAt: number;
}

interface RestartContinuationStoreData {
  version: 1;
  pending: Record<string, PendingRestartContinuation>;
  userStopped: Record<string, number>;
  consumedEpochs: string[];
}

export interface RestartContinuationRuntimeProbe {
  sending?: boolean;
  pendingCount?: number;
  backgroundWorkCount?: number;
  lastActivityAt?: number;
  getStatus: () => string;
}

export interface TransportRestartContinuationRuntime extends RestartContinuationRuntimeProbe {
  send: (
    payload: string,
    commandId?: string,
    attachments?: undefined,
    messagePreamble?: undefined,
    opts?: {
      queuePlacement?: 'front' | 'normal';
      timelineCommitted?: boolean;
      messageOrigin?: (typeof CHAT_MESSAGE_ORIGINS)[keyof typeof CHAT_MESSAGE_ORIGINS];
    },
  ) => unknown;
  reconcileCompletedCodexTurnFromRollout?: (opts?: { nowMs?: number }) => Promise<boolean>;
  hasCompletedCodexRolloutTurn?: () => Promise<boolean>;
}

const DEFAULT_STALE_TURN_MS = (() => {
  const raw = Number.parseInt(process.env.IMCODES_TRANSPORT_STALE_TURN_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60_000;
})();

const TRANSPORT_ACTIVE_STATUSES: ReadonlySet<string> = new Set(['thinking', 'streaming']);
const PROCESS_ACTIVE_STATES: ReadonlySet<string> = new Set(['running', 'queued']);
const EXCLUDED_AGENT_TYPES: ReadonlySet<string> = new Set(['shell', 'script']);
const MAX_CONSUMED_EPOCHS = 200;

export function restartContinuationPath(): string {
  return join(imcodesStateDir(), DAEMON_RESTART_CONTINUATION_FILE);
}

function emptyStore(): RestartContinuationStoreData {
  return {
    version: 1,
    pending: {},
    userStopped: {},
    consumedEpochs: [],
  };
}

function pruneStoreData(data: RestartContinuationStoreData, now: number): boolean {
  let changed = false;
  for (const [name, entry] of Object.entries(data.pending)) {
    if (!entry || typeof entry.expiresAt !== 'number' || now >= entry.expiresAt) {
      delete data.pending[name];
      changed = true;
    }
  }
  for (const [name, stoppedAt] of Object.entries(data.userStopped)) {
    if (typeof stoppedAt !== 'number' || !Number.isFinite(stoppedAt) || now - stoppedAt >= DAEMON_RESTART_CONTINUATION_TTL_MS) {
      delete data.userStopped[name];
      changed = true;
    }
  }
  if (data.consumedEpochs.length > MAX_CONSUMED_EPOCHS) {
    data.consumedEpochs = data.consumedEpochs.slice(-MAX_CONSUMED_EPOCHS);
    changed = true;
  }
  return changed;
}

function readStore(now = Date.now(), path = restartContinuationPath()): RestartContinuationStoreData {
  try {
    if (!existsSync(path)) return emptyStore();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RestartContinuationStoreData> | null;
    if (!parsed || typeof parsed !== 'object') return emptyStore();
    const data: RestartContinuationStoreData = {
      version: 1,
      pending: parsed.pending && typeof parsed.pending === 'object' ? { ...parsed.pending } : {},
      userStopped: parsed.userStopped && typeof parsed.userStopped === 'object' ? { ...parsed.userStopped } : {},
      consumedEpochs: Array.isArray(parsed.consumedEpochs)
        ? parsed.consumedEpochs.filter((item): item is string => typeof item === 'string')
        : [],
    };
    pruneStoreData(data, now);
    return data;
  } catch (err) {
    logger.warn({ err, path }, 'restart-continuation: failed to read store, resetting');
    return emptyStore();
  }
}

function writeStore(data: RestartContinuationStoreData, now = Date.now(), path = restartContinuationPath()): boolean {
  pruneStoreData(data, now);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    logger.warn({ err, path }, 'restart-continuation: failed to write store');
    return false;
  }
}

function epochKey(sessionName: string, epoch: string): string {
  return `${sessionName}:${epoch}`;
}

export function buildRestartContinuationCommandId(sessionName: string, epoch: string): string {
  return `${DAEMON_RESTART_CONTINUATION_COMMAND_PREFIX}${sessionName}:${epoch}`;
}

/** Whether a session record is ever eligible for automatic restart `continue`. */
export function isEligibleRestartContinuationSession(session: SessionRecord | undefined): session is SessionRecord {
  if (!session?.name) return false;
  if (session.state === 'stopped' || session.state === 'error') return false;
  if (isIncognitoSession(session)) return false;
  if (EXCLUDED_AGENT_TYPES.has(session.agentType)) return false;
  if (session.executionCloneMetadata?.kind === EXECUTION_CLONE_KIND) return false;
  return true;
}

/**
 * Record an explicit user stop/cancel so shutdown or crash recovery will never
 * auto-continue this interrupted turn. Returns whether the state change was persisted.
 */
export function markSessionUserStopped(sessionName: string, now = Date.now(), path = restartContinuationPath()): boolean {
  if (!sessionName) return false;
  pendingProcessRecoveryTokens.delete(sessionName);
  const data = readStore(now, path);
  data.userStopped[sessionName] = now;
  delete data.pending[sessionName];
  return writeStore(data, now, path);
}

/**
 * Retire any pending continuation marker and clear `userStopped` once a new
 * message or explicit reset/clear supersedes the previous turn. Returns whether
 * the retirement succeeded (true if already absent or persisted cleanly).
 */
export function retireRestartContinuation(sessionName: string, now = Date.now(), path = restartContinuationPath()): boolean {
  if (!sessionName) return false;
  pendingProcessRecoveryTokens.delete(sessionName);
  const data = readStore(now, path);
  const hadPending = Object.prototype.hasOwnProperty.call(data.pending, sessionName);
  const hadStopped = Object.prototype.hasOwnProperty.call(data.userStopped, sessionName);
  if (!hadPending && !hadStopped) return true;
  delete data.pending[sessionName];
  delete data.userStopped[sessionName];
  return writeStore(data, now, path);
}

/** Clear all restart-continuation state when a session is removed/closed. */
export function clearSessionRestartContinuation(sessionName: string, now = Date.now(), path = restartContinuationPath()): boolean {
  return retireRestartContinuation(sessionName, now, path);
}

export function isSessionUserStopped(sessionName: string, now = Date.now(), path = restartContinuationPath()): boolean {
  if (!sessionName) return false;
  const data = readStore(now, path);
  return typeof data.userStopped[sessionName] === 'number';
}

export function getPendingRestartContinuation(
  sessionName: string,
  now = Date.now(),
  path = restartContinuationPath(),
): PendingRestartContinuation | null {
  if (!sessionName) return null;
  const data = readStore(now, path);
  if (typeof data.userStopped[sessionName] === 'number') return null;
  const entry = data.pending[sessionName];
  if (!entry || now >= entry.expiresAt) return null;
  if (data.consumedEpochs.includes(epochKey(sessionName, entry.epoch))) return null;
  return entry;
}

export function hasPendingRestartContinuation(
  sessionName: string,
  now = Date.now(),
  path = restartContinuationPath(),
): boolean {
  return getPendingRestartContinuation(sessionName, now, path) !== null;
}

const pendingProcessRecoveryTokens = new Map<string, { token: symbol; runtimeEpoch?: string }>();

/**
 * Claim in-flight post-launch continuation ownership for a newly launched or
 * respawned process pane before returning from `launchSession` / `respawnSession` /
 * `startSubSession`. Until the returned release callback runs once post-launch
 * readiness completes (or launch fails), restore/rebuild replays must NOT treat
 * the replacement pane as a surviving pre-restart process and prematurely consume
 * its continuation marker.
 */
export function claimProcessRestartContinuationRecovery(
  sessionName: string,
  runtimeEpoch?: string,
): () => void {
  const token = Symbol(sessionName);
  pendingProcessRecoveryTokens.set(sessionName, { token, runtimeEpoch });
  return () => {
    const cur = pendingProcessRecoveryTokens.get(sessionName);
    if (cur?.token === token) {
      pendingProcessRecoveryTokens.delete(sessionName);
    }
  };
}

export function hasActiveProcessRestartContinuationRecovery(
  sessionName: string,
  runtimeEpoch?: string,
): boolean {
  const cur = pendingProcessRecoveryTokens.get(sessionName);
  if (!cur) return false;
  if (runtimeEpoch && cur.runtimeEpoch && cur.runtimeEpoch !== runtimeEpoch) {
    return false;
  }
  return true;
}

/** Whether a dead-pane process sub-session should be auto-respawned on restore. */
export function shouldAutoRespawnDeadProcessSubSession(
  session: SessionRecord | undefined,
  now = Date.now(),
  filePath = restartContinuationPath(),
): boolean {
  if (!session?.name) return false;
  if (session.runtimeType === 'transport' || isTransportAgent(session.agentType)) return false;
  if (!isEligibleRestartContinuationSession(session)) return false;
  if (isSessionUserStopped(session.name, now, filePath)) return false;
  return hasPendingRestartContinuation(session.name, now, filePath);
}

type ConsumeOutcome = {
  entry: PendingRestartContinuation | null;
  reason: 'consumed' | 'missing' | 'epoch_mismatch' | 'already_consumed' | 'expired' | 'persist_failed';
};

function consumeRestartContinuationDetailed(
  sessionName: string,
  expectedEpoch?: string,
  now = Date.now(),
  path = restartContinuationPath(),
): ConsumeOutcome {
  if (!sessionName) return { entry: null, reason: 'missing' };
  const data = readStore(now, path);
  const entry = data.pending[sessionName];
  if (!entry) return { entry: null, reason: 'missing' };
  if (expectedEpoch && entry.epoch !== expectedEpoch) return { entry: null, reason: 'epoch_mismatch' };
  const key = epochKey(sessionName, entry.epoch);
  const alreadyConsumed = data.consumedEpochs.includes(key);
  delete data.pending[sessionName];
  if (!alreadyConsumed) data.consumedEpochs.push(key);
  const written = writeStore(data, now, path);
  if (!written) {
    logger.warn(
      { sessionName, epoch: entry.epoch, path },
      'restart-continuation: failed to persist marker consumption; keeping pending marker and skipping dispatch',
    );
    return { entry: null, reason: 'persist_failed' };
  }
  if (alreadyConsumed) return { entry: null, reason: 'already_consumed' };
  if (now >= entry.expiresAt) return { entry: null, reason: 'expired' };
  return { entry, reason: 'consumed' };
}

/**
 * Atomically consume a pending continuation marker so any subsequent restore,
 * retry, or restart cannot fire it a second time. Returns `null` if missing,
 * already consumed, expired, or if persisting the consumption failed.
 */
export function consumeRestartContinuation(
  sessionName: string,
  expectedEpoch?: string,
  now = Date.now(),
  path = restartContinuationPath(),
): PendingRestartContinuation | null {
  return consumeRestartContinuationDetailed(sessionName, expectedEpoch, now, path).entry;
}

function isTransportRuntimeActiveAtShutdown(
  runtime: RestartContinuationRuntimeProbe,
  now: number,
  staleTurnMs: number,
): boolean {
  const status = runtime.getStatus();
  const backgroundWorkCount = Math.max(0, runtime.backgroundWorkCount ?? 0);
  const hasForegroundWork = Boolean(runtime.sending || TRANSPORT_ACTIVE_STATUSES.has(status));
  if (!hasForegroundWork && backgroundWorkCount === 0) return false;
  if (
    backgroundWorkCount === 0
    && typeof runtime.lastActivityAt === 'number'
    && Number.isFinite(runtime.lastActivityAt)
    && now - runtime.lastActivityAt >= staleTurnMs
  ) {
    return false;
  }
  return true;
}

export function captureRestartContinuationsBeforeShutdownDetailed(opts: {
  sessions: readonly SessionRecord[];
  getRuntime: (sessionName: string) => RestartContinuationRuntimeProbe | undefined;
  activeDispatchSessions?: ReadonlySet<string>;
  now?: number;
  epoch?: string;
  staleTurnMs?: number;
  filePath?: string;
}): { captured: PendingRestartContinuation[]; persisted: boolean } {
  const now = opts.now ?? Date.now();
  const epoch = opts.epoch ?? randomUUID();
  const staleTurnMs = opts.staleTurnMs ?? DEFAULT_STALE_TURN_MS;
  const path = opts.filePath ?? restartContinuationPath();
  const data = readStore(now, path);
  const captured: PendingRestartContinuation[] = [];
  let dirty = false;

  for (const session of opts.sessions) {
    const isEligible = isEligibleRestartContinuationSession(session);
    const isStoppedByUser = typeof data.userStopped[session.name] === 'number';
    if (!isEligible || isStoppedByUser) {
      if (data.pending[session.name]) {
        delete data.pending[session.name];
        dirty = true;
      }
      continue;
    }

    const isTransport = session.runtimeType === 'transport' || isTransportAgent(session.agentType);
    let active = false;
    if (isTransport) {
      const runtime = opts.getRuntime(session.name);
      if (runtime) {
        active = isTransportRuntimeActiveAtShutdown(runtime, now, staleTurnMs);
      } else {
        active = session.state === 'running' || Boolean(opts.activeDispatchSessions?.has(session.name));
      }
    } else {
      active = PROCESS_ACTIVE_STATES.has(session.state);
    }

    if (!active) continue;

    const entry: PendingRestartContinuation = {
      sessionName: session.name,
      runtimeType: isTransport ? 'transport' : 'process',
      agentType: session.agentType,
      ...(session.providerId ? { providerId: session.providerId } : {}),
      epoch,
      reason: 'graceful_shutdown',
      capturedAt: now,
      expiresAt: now + DAEMON_RESTART_CONTINUATION_TTL_MS,
    };
    data.pending[session.name] = entry;
    captured.push(entry);
    dirty = true;
  }

  let persisted = true;
  if (dirty || existsSync(path)) {
    persisted = writeStore(data, now, path);
  }
  return {
    captured: persisted ? captured : [],
    persisted,
  };
}

/**
 * Capture sessions whose active turns will be interrupted by a daemon shutdown
 * (upgrades, `systemctl restart`, SIGTERM/SIGINT). Must run BEFORE transports or
 * ConPTY sessions are torn down.
 */
export function captureRestartContinuationsBeforeShutdown(opts: {
  sessions: readonly SessionRecord[];
  getRuntime: (sessionName: string) => RestartContinuationRuntimeProbe | undefined;
  activeDispatchSessions?: ReadonlySet<string>;
  now?: number;
  epoch?: string;
  staleTurnMs?: number;
  filePath?: string;
}): PendingRestartContinuation[] {
  return captureRestartContinuationsBeforeShutdownDetailed(opts).captured;
}

/**
 * Fallback capture on startup after an unclean exit (SIGKILL / crash / OOM):
 * inspects persisted store/SQLite state BEFORE `restoreFromStore` or
 * `restoreTransportSessions` resets `state` to `'idle'`.
 */
export function captureUncleanRestartContinuationsDetailed(opts: {
  uncleanPreviousExit: boolean;
  sessions: readonly SessionRecord[];
  activeDispatchSessions?: ReadonlySet<string>;
  now?: number;
  epoch?: string;
  filePath?: string;
}): { captured: PendingRestartContinuation[]; persisted: boolean } {
  const now = opts.now ?? Date.now();
  const path = opts.filePath ?? restartContinuationPath();
  const data = readStore(now, path);
  if (!opts.uncleanPreviousExit) {
    // Still prune expired markers on clean startup if the file exists.
    const persisted = existsSync(path) ? writeStore(data, now, path) : true;
    return { captured: [], persisted };
  }

  const epoch = opts.epoch ?? randomUUID();
  const captured: PendingRestartContinuation[] = [];
  let dirty = false;

  for (const session of opts.sessions) {
    if (!isEligibleRestartContinuationSession(session)) continue;
    if (typeof data.userStopped[session.name] === 'number') continue;
    const existing = data.pending[session.name];
    if (existing && existing.expiresAt > now) continue;

    const isTransport = session.runtimeType === 'transport' || isTransportAgent(session.agentType);
    const activeOnCrash = PROCESS_ACTIVE_STATES.has(session.state)
      || (isTransport && Boolean(opts.activeDispatchSessions?.has(session.name)));
    if (!activeOnCrash) continue;

    const entry: PendingRestartContinuation = {
      sessionName: session.name,
      runtimeType: isTransport ? 'transport' : 'process',
      agentType: session.agentType,
      ...(session.providerId ? { providerId: session.providerId } : {}),
      epoch,
      reason: 'unclean_exit',
      capturedAt: now,
      expiresAt: now + DAEMON_RESTART_CONTINUATION_TTL_MS,
    };
    data.pending[session.name] = entry;
    captured.push(entry);
    dirty = true;
  }

  const persisted = dirty ? writeStore(data, now, path) : true;
  return {
    captured: persisted ? captured : [],
    persisted,
  };
}

export function captureUncleanRestartContinuations(opts: {
  uncleanPreviousExit: boolean;
  sessions: readonly SessionRecord[];
  activeDispatchSessions?: ReadonlySet<string>;
  now?: number;
  epoch?: string;
  filePath?: string;
}): PendingRestartContinuation[] {
  return captureUncleanRestartContinuationsDetailed(opts).captured;
}

export async function dispatchTransportRestartContinuation(opts: {
  preRestoreSession: SessionRecord;
  currentSession?: SessionRecord;
  runtime: TransportRestartContinuationRuntime;
  getResendCount: (sessionName: string) => number;
  hasQueuedDurableEntries: (sessionName: string) => boolean;
  emitUserMessage: (sessionName: string, commandId: string) => void;
  now?: number;
  filePath?: string;
}): Promise<{ dispatched: boolean; reason: string; commandId?: string }> {
  const now = opts.now ?? Date.now();
  const path = opts.filePath ?? restartContinuationPath();
  const sessionName = opts.preRestoreSession.name;
  const entry = getPendingRestartContinuation(sessionName, now, path);
  if (!entry) return { dispatched: false, reason: 'none' };

  const effectiveSession = opts.currentSession ?? opts.preRestoreSession;
  if (!isEligibleRestartContinuationSession(effectiveSession)) {
    consumeRestartContinuation(sessionName, entry.epoch, now, path);
    return { dispatched: false, reason: 'ineligible' };
  }
  if (isSessionUserStopped(sessionName, now, path)) {
    consumeRestartContinuation(sessionName, entry.epoch, now, path);
    return { dispatched: false, reason: 'user_stopped' };
  }

  if (
    (opts.runtime.pendingCount ?? 0) > 0
    || opts.runtime.sending
    || opts.getResendCount(sessionName) > 0
    || opts.hasQueuedDurableEntries(sessionName)
  ) {
    consumeRestartContinuation(sessionName, entry.epoch, now, path);
    return { dispatched: false, reason: 'pending_queue_nonempty' };
  }

  const effectiveProviderId = effectiveSession.providerId ?? effectiveSession.agentType;
  if (effectiveProviderId === 'codex-sdk') {
    let settled = false;
    if (typeof opts.runtime.reconcileCompletedCodexTurnFromRollout === 'function') {
      settled = await opts.runtime.reconcileCompletedCodexTurnFromRollout({ nowMs: now }).catch(() => false);
    }
    if (!settled && typeof opts.runtime.hasCompletedCodexRolloutTurn === 'function') {
      settled = await opts.runtime.hasCompletedCodexRolloutTurn().catch(() => false);
    }
    if (settled) {
      consumeRestartContinuation(sessionName, entry.epoch, now, path);
      return { dispatched: false, reason: 'codex_rollout_completed' };
    }
  }

  const consumed = consumeRestartContinuationDetailed(sessionName, entry.epoch, now, path);
  if (!consumed.entry) {
    return {
      dispatched: false,
      reason: consumed.reason === 'persist_failed' ? 'consume_persist_failed' : 'already_consumed',
    };
  }

  const commandId = buildRestartContinuationCommandId(sessionName, consumed.entry.epoch);
  opts.emitUserMessage(sessionName, commandId);
  opts.runtime.send('continue', commandId, undefined, undefined, {
    queuePlacement: 'front',
    timelineCommitted: true,
    messageOrigin: CHAT_MESSAGE_ORIGINS.SYSTEM,
  });
  return { dispatched: true, reason: consumed.entry.reason, commandId };
}

export async function dispatchProcessRestartContinuation(opts: {
  sessionName: string;
  currentSession?: SessionRecord;
  sendKeys: (sessionName: string, keys: string) => Promise<void>;
  emitUserMessage: (sessionName: string, commandId: string) => void;
  now?: number;
  filePath?: string;
}): Promise<{ dispatched: boolean; reason: string; commandId?: string }> {
  const now = opts.now ?? Date.now();
  const path = opts.filePath ?? restartContinuationPath();
  const entry = getPendingRestartContinuation(opts.sessionName, now, path);
  if (!entry) return { dispatched: false, reason: 'none' };
  if (entry.runtimeType !== 'process') return { dispatched: false, reason: 'wrong_runtime_type' };

  const session = opts.currentSession;
  if (!isEligibleRestartContinuationSession(session) || isSessionUserStopped(opts.sessionName, now, path)) {
    consumeRestartContinuation(opts.sessionName, entry.epoch, now, path);
    return { dispatched: false, reason: 'ineligible' };
  }
  if (session.state === 'running') {
    consumeRestartContinuation(opts.sessionName, entry.epoch, now, path);
    return { dispatched: false, reason: 'already_running' };
  }

  const consumed = consumeRestartContinuationDetailed(opts.sessionName, entry.epoch, now, path);
  if (!consumed.entry) {
    return {
      dispatched: false,
      reason: consumed.reason === 'persist_failed' ? 'consume_persist_failed' : 'already_consumed',
    };
  }

  const commandId = buildRestartContinuationCommandId(opts.sessionName, consumed.entry.epoch);
  opts.emitUserMessage(opts.sessionName, commandId);
  await opts.sendKeys(opts.sessionName, 'continue');
  return { dispatched: true, reason: consumed.entry.reason, commandId };
}

export function emitSystemContinueUserMessage(
  emit: (sessionName: string, type: 'user.message', payload: Record<string, unknown>, opts: { source: 'daemon'; confidence: 'high'; eventId: string }) => unknown,
  sessionName: string,
  commandId: string,
  kind: 'transport' | 'process',
): void {
  emit(
    sessionName,
    'user.message',
    {
      text: 'continue',
      clientMessageId: commandId,
      allowDuplicate: true,
      ...(kind === 'process' ? { memoryExcluded: true } : {}),
      [USER_MESSAGE_ORIGIN_FIELDS.ORIGIN]: CHAT_MESSAGE_ORIGINS.SYSTEM,
    },
    { source: 'daemon', confidence: 'high', eventId: `${kind}-user:${commandId}` },
  );
}
