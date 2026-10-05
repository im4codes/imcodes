import { parentPort, workerData } from 'node:worker_threads';
import WebSocket from 'ws';
import { CLOCK_SYNC_FIELD } from '../../shared/clock-sync.js';
import { coreLaneReceiptFrame, coreLaneSessionAuthorized, coreLaneSessionSendReceipt } from '../../shared/core-lane-receipt.js';
import { CoreLaneInboundInbox, replayCoreLaneInbound, type CoreLaneInboundRecord } from '../../shared/core-lane-inbox.js';
import {
  CORE_LANE_BUSY_THRESHOLD_MS,
  CORE_LANE_STALL_RESTART_DEFAULT_MS,
  coreLaneBlockedMs,
  shouldRequestCoreLaneRestart,
} from '../../shared/core-lane-liveness.js';
import { imcodesStateDir } from '../util/imcodes-state-dir.js';
import { join } from 'node:path';

const port = parentPort;
if (!port) throw new Error('server-link-worker requires parentPort');
type WorkerConfig = {
  url: string;
  auth?: string;
  daemonVersion?: string;
  stallRestartMs?: number;
  heartbeatMs?: number;
  connectTimeoutMs?: number;
  authorizedSessions?: string[];
  inboundInboxPath?: string;
};

const config = workerData as WorkerConfig;
let socket: WebSocket | null = null;
let stopping = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let reconnectAttempt = 0;
let mainLagMs = 0;
let opened = false;
let closing = false;

const HEARTBEAT_MS = Math.max(1_000, config.heartbeatMs ?? 5_000);
const CONNECT_TIMEOUT_MS = Math.max(1_000, config.connectTimeoutMs ?? 15_000);
const HEARTBEAT_ACK_TIMEOUT_MS = Math.max(HEARTBEAT_MS * 3, 15_000);
const SILENCE_TIMEOUT_MS = Math.max(HEARTBEAT_MS * 4, 30_000);
const SEND_QUEUE_HIGH_WATER_BYTES = 512 * 1024;
const SEND_QUEUE_TIMEOUT_MS = 10_000;
const INBOUND_HANDOFF_MAX_BYTES = 4 * 1024 * 1024;
let pendingHeartbeats: number[] = [];
let lastInboundAt = 0;
let sendQueueBlockedAt: number | null = null;
let lastMainLagSampleAt = 0;
let stallRestartRequested = false;
const inboundInbox = new CoreLaneInboundInbox(config.inboundInboxPath ?? join(imcodesStateDir(), 'core-lane-inbound.jsonl'));
let authorizedSessions = new Set(config.authorizedSessions ?? []);
let authorizedSessionsReady = Array.isArray(config.authorizedSessions);
let inboundHandoffBytes = inboundInbox.pending().reduce((total, entry) => total + Buffer.byteLength(entry.payload), 0);

function emitInbound(entry: CoreLaneInboundRecord): void {
  emit({ event: 'message', data: entry.payload, inboundId: entry.id });
}

function replayPendingInbound(): void {
  replayCoreLaneInbound(inboundInbox.pending(), emitInbound);
}

// A worker restart must replay every fsynced handoff. The main command dedup
// map makes replay exactly-once while the inbox remains durable across a
// process crash.
replayPendingInbound();

function emit(event: Record<string, unknown>, transfer?: ArrayBuffer[], force = false): void {
  if (stopping && !force) return;
  try { port!.postMessage(event, transfer ?? []); } catch { /* parent exited */ }
}

function stopTimers(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}

function sendHeartbeat(): void {
  const current = socket;
  if (!current || current.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  const oldestHeartbeat = pendingHeartbeats[0];
  if ((oldestHeartbeat !== undefined && now - oldestHeartbeat > HEARTBEAT_ACK_TIMEOUT_MS)
    || (lastInboundAt > 0 && now - lastInboundAt > SILENCE_TIMEOUT_MS)
    || (sendQueueBlockedAt !== null && now - sendQueueBlockedAt > SEND_QUEUE_TIMEOUT_MS)) {
    emit({ event: 'liveness_timeout', reason: oldestHeartbeat !== undefined ? 'heartbeat_ack_timeout' : 'socket_silence' });
    current.terminate();
    return;
  }
  const sentAt = now;
  const mainEventLoopBlockedMs = coreLaneBlockedMs(now, lastMainLagSampleAt);
  const stallRestartMs = Number(config.stallRestartMs ?? process.env.IMCODES_CORE_LANE_STALL_RESTART_MS ?? CORE_LANE_STALL_RESTART_DEFAULT_MS);
  if (!stallRestartRequested && shouldRequestCoreLaneRestart(now, lastMainLagSampleAt, stallRestartMs)) {
    stallRestartRequested = true;
    emit({ event: 'restart_request', reason: 'main_event_loop_stall', blockedMs: mainEventLoopBlockedMs });
    // This worker remains scheduled while the parent event loop is blocked,
    // so the existing SIGTERM lifecycle can take over even before the parent
    // processes another MessagePort event.
    try { process.kill(process.ppid, 'SIGTERM'); } catch { /* parent may already be exiting */ }
  }
  try {
    current.send(JSON.stringify({
      type: 'heartbeat',
      ...(config.daemonVersion ? { daemonVersion: config.daemonVersion } : {}),
      [CLOCK_SYNC_FIELD.SENT_AT]: sentAt,
      mainEventLoopLagMs: mainLagMs,
      mainEventLoopBlockedMs,
      mainEventLoopBusy: mainEventLoopBlockedMs >= CORE_LANE_BUSY_THRESHOLD_MS,
    }));
    pendingHeartbeats.push(sentAt);
    if (pendingHeartbeats.length > 16) pendingHeartbeats.splice(1, pendingHeartbeats.length - 16);
    if (current.bufferedAmount > SEND_QUEUE_HIGH_WATER_BYTES) sendQueueBlockedAt ??= now;
    else sendQueueBlockedAt = null;
  } catch (error) {
    emit({ event: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

function scheduleReconnect(code: number, reason: string): void {
  if (stopping || reconnectTimer) return;
  const delay = Math.min(30_000, 250 * (2 ** Math.min(reconnectAttempt++, 7)));
  emit({ event: 'reconnecting', code, reason, delayMs: delay });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delay);
}

function connect(): void {
  if (stopping) return;
  const current = new WebSocket(config.url);
  socket = current;
  let openedForAttempt = false;
  const connectTimeout = setTimeout(() => {
    if (!openedForAttempt && socket === current) current.terminate();
  }, CONNECT_TIMEOUT_MS);
  current.on('open', () => {
    openedForAttempt = true;
    clearTimeout(connectTimeout);
    reconnectAttempt = 0;
    opened = true;
    pendingHeartbeats = [];
    lastInboundAt = Date.now();
    lastMainLagSampleAt = lastInboundAt;
    sendQueueBlockedAt = null;
    try {
      if (config.auth) current.send(config.auth);
    } catch (error) {
      emit({ event: 'error', message: error instanceof Error ? error.message : String(error) });
    }
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
    emit({ event: 'open' });
    // Re-emit after the worker has re-authenticated as well as at startup.
    // This covers a crash after the receipt left the socket but before the
    // parent committed the handoff. Duplicate commandIds are idempotent.
    replayPendingInbound();
  });
  current.on('message', (data: WebSocket.RawData, binary: boolean) => {
    lastInboundAt = Date.now();
    if (!binary) {
      const text = data.toString();
      try {
        const message = JSON.parse(text) as Record<string, unknown>;
        const receipt = coreLaneSessionSendReceipt(message);
        let inboundId: string | undefined;
        if (receipt) {
          if (!coreLaneSessionAuthorized(receipt.session, authorizedSessions, authorizedSessionsReady)) {
            current.send(coreLaneReceiptFrame(receipt, 'error', 'session_not_found'));
            return;
          }
          const bytes = Buffer.byteLength(text);
          const existing = inboundInbox.pending().find((entry) => entry.commandId === receipt.commandId);
          if (existing) {
            inboundId = existing.id;
            current.send(coreLaneReceiptFrame(receipt, 'accepted'));
          } else if (inboundHandoffBytes + bytes <= INBOUND_HANDOFF_MAX_BYTES) {
            inboundId = `${receipt.commandId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
            inboundInbox.append({ id: inboundId, commandId: receipt.commandId, session: receipt.session, payload: text, ts: Date.now() });
            inboundHandoffBytes += bytes;
            // ACK only after the command is fsynced to the crash-safe inbox.
            // A worker/daemon crash can therefore replay it instead of losing
            // a command the server already considers accepted.
            current.send(coreLaneReceiptFrame(receipt, 'accepted'));
          } else {
            current.send(coreLaneReceiptFrame(receipt, 'error', 'daemon_busy'));
            return;
          }
        }
        if (message.type === 'heartbeat_ack') {
          const echoed = message[CLOCK_SYNC_FIELD.SENT_AT];
          if (typeof echoed === 'number' && Number.isFinite(echoed)) {
            pendingHeartbeats = pendingHeartbeats.filter((sentAt) => sentAt > echoed);
          } else {
            pendingHeartbeats.shift();
          }
        }
      } catch {
        // Protocol parsing remains the main thread's responsibility.
      }
      emit({ event: 'message', data: text });
      return;
    }
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as Uint8Array);
    const copy = Uint8Array.from(bytes);
    emit({ event: 'message', binary: true, data: copy.buffer }, [copy.buffer]);
  });
  current.on('error', (error: Error) => emit({ event: 'error', message: error.message }));
  current.on('close', (code: number, reason: Buffer) => {
    clearTimeout(connectTimeout);
    if (socket !== current) return;
    socket = null;
    stopTimers();
    const wasOpen = opened;
    opened = false;
    emit({ event: 'close', code, reason: reason.toString(), transient: !stopping && !closing }, undefined, true);
    if (!stopping && !closing && (wasOpen || !stopping)) scheduleReconnect(code, reason.toString());
  });
}

connect();

port.on('message', (command: { type: string; payload?: string | Uint8Array; code?: number; reason?: string; lagMs?: number; bytes?: number; inboundId?: string; sessions?: string[] }) => {
  try {
    if (command.type === 'send') {
      const current = socket;
      if (!current || current.readyState !== WebSocket.OPEN) throw new Error('core lane socket is not open');
      const payload = typeof command.payload === 'string' ? command.payload : Buffer.from(command.payload ?? []);
      const bytes = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
      current.send(payload, () => emit({ event: 'drained', bytes }));
      const now = Date.now();
      if (current.bufferedAmount > SEND_QUEUE_HIGH_WATER_BYTES) sendQueueBlockedAt ??= now;
      else sendQueueBlockedAt = null;
    } else if (command.type === 'inbound_commit') {
      const id = typeof command.inboundId === 'string' ? command.inboundId : '';
      const entry = id ? inboundInbox.pending().find((item) => item.id === id) : undefined;
      inboundInbox.acknowledge(id);
      inboundHandoffBytes = Math.max(0, inboundHandoffBytes - (entry ? Buffer.byteLength(entry.payload) : 0));
      // Let the parent forget this commit only after this worker has applied
      // the durable ack.  If the worker exits before this frame, the parent
      // re-sends the still-pending commit to the replacement generation.
      if (id) emit({ event: 'inbound_committed', inboundId: id });
    } else if (command.type === 'sessions') {
      if (Array.isArray(command.sessions)) {
        authorizedSessions = new Set(command.sessions.filter((name): name is string => typeof name === 'string' && name.length > 0));
        authorizedSessionsReady = true;
      }
    } else if (command.type === 'lag') {
      mainLagMs = Math.max(0, Math.trunc(command.lagMs ?? 0));
      lastMainLagSampleAt = Date.now();
    } else if (command.type === 'close') {
      closing = true;
      stopping = true;
      stopTimers();
      socket?.close(command.code, command.reason);
    } else if (command.type === 'terminate') {
      stopping = true;
      stopTimers();
      socket?.terminate();
      port.close();
    }
  } catch (error) {
    emit({ event: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
