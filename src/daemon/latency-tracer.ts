import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, loadavg } from 'node:os';
import { PerformanceObserver, monitorEventLoopDelay, performance } from 'node:perf_hooks';
import logger from '../util/logger.js';
import { MSG_COMMAND_ACK } from '../../shared/ack-protocol.js';
import { TIMELINE_MESSAGES } from '../../shared/timeline-protocol.js';
import { TRANSPORT_EVENT, TRANSPORT_MSG } from '../../shared/transport-events.js';

type JsonRecord = Record<string, unknown>;

interface CommandReceipt {
  type: string;
  receivedAt: number;
  commandId: string;
  sessionName?: string;
}

interface RecentSpan {
  name: string;
  durationMs: number;
  endedAt: number;
  startedAt: number;
  meta?: JsonRecord;
}

interface GcMarker {
  kind: number;
  durationMs: number;
  endedAt: number;
}

interface RecentCommand {
  type: string;
  receivedAt: number;
  commandId?: string;
  requestId?: string;
  sessionName?: string;
  commandBytes?: number;
}

interface RecentServerSend {
  msgType: string;
  endedAt: number;
  jsonBytes: number;
  totalMs: number;
  stringifyMs: number;
  wsSendMs: number;
  plane: ServerSendPlane;
  outboundQueueDepth?: number;
  outboundQueueAgeMs?: number;
  sendBacklogAgeMs?: number;
}

const TRUE_RE = /^(1|true|yes|on|debug)$/i;
const DEFAULT_LOG_DIR = join(homedir(), '.imcodes', 'logs');
const DEFAULT_FLAG_FILE = join(homedir(), '.imcodes', 'latency-trace.enabled');
const DEFAULT_LOG_FILE = join(DEFAULT_LOG_DIR, 'latency-trace.ndjson');
const MAX_LOG_SIZE = 100 * 1024 * 1024;
const MAX_OLD_LOGS = 3;
const COMMAND_RECEIPT_TTL_MS = 60_000;
const COMMAND_RECEIPT_MAX = 2_000;

let enabled = envFlag('IMCODES_DAEMON_LATENCY_TRACE') || existsSync(process.env.IMCODES_DAEMON_LATENCY_TRACE_FLAG ?? DEFAULT_FLAG_FILE);
let stream: WriteStream | null = null;
let started = false;
let sampleTimer: ReturnType<typeof setInterval> | null = null;
let driftTimer: ReturnType<typeof setInterval> | null = null;
let eventLoopMonitor: ReturnType<typeof monitorEventLoopDelay> | null = null;
let gcObserver: PerformanceObserver | null = null;
let lastCpu = process.cpuUsage();
let lastCpuAt = performance.now();
let lastElu = performance.eventLoopUtilization();
let expectedDriftAt = 0;
const commandReceipts = new Map<string, CommandReceipt>();
const activeSpanStack: RecentSpan[] = [];
const recentSpans: RecentSpan[] = [];
const recentGcMarkers: GcMarker[] = [];
const recentCommands: RecentCommand[] = [];
const recentServerSends: RecentServerSend[] = [];
const RECENT_SPAN_MAX = 64;
const RECENT_GC_MAX = 32;
const RECENT_COMMAND_MAX = 256;
const RECENT_COMMAND_WINDOW_MS = 5_000;
const RECENT_SEND_MAX = 64;
const RECENT_SEND_WINDOW_MS = 5_000;

function envFlag(name: string): boolean {
  return TRUE_RE.test(String(process.env[name] ?? ''));
}

function numberEnv(name: string, fallback: number, min: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, value);
}

function logFilePath(): string {
  return process.env.IMCODES_DAEMON_LATENCY_TRACE_FILE || DEFAULT_LOG_FILE;
}

function spanThresholdMs(): number {
  return numberEnv('IMCODES_DAEMON_LATENCY_TRACE_SPAN_MS', 25, 1);
}

function asyncThresholdMs(): number {
  return numberEnv('IMCODES_DAEMON_LATENCY_TRACE_ASYNC_MS', 100, 1);
}

function sendThresholdMs(): number {
  return numberEnv('IMCODES_DAEMON_LATENCY_TRACE_SEND_MS', 20, 1);
}

function largeSendTraceBytes(): number {
  return numberEnv('IMCODES_DAEMON_LATENCY_TRACE_LARGE_SEND_BYTES', 64 * 1024, 1);
}

function ackSlowMs(): number {
  return numberEnv('IMCODES_DAEMON_LATENCY_TRACE_ACK_MS', 500, 1);
}

function driftThresholdMs(): number {
  return numberEnv('IMCODES_DAEMON_LATENCY_TRACE_DRIFT_MS', 75, 1);
}

function sampleIntervalMs(): number {
  return numberEnv('IMCODES_DAEMON_LATENCY_TRACE_SAMPLE_MS', 1_000, 100);
}

function rotateTraceLog(filePath: string): void {
  try {
    if (!existsSync(filePath)) return;
    if (statSync(filePath).size < MAX_LOG_SIZE) return;
    for (let i = MAX_OLD_LOGS; i >= 1; i--) {
      const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
      const dst = `${filePath}.${i}`;
      try {
        if (existsSync(src)) renameSync(src, dst);
      } catch {
        // best effort
      }
    }
    try { unlinkSync(`${filePath}.${MAX_OLD_LOGS + 1}`); } catch { /* best effort */ }
  } catch {
    // best effort
  }
}

function ensureStream(): WriteStream | null {
  if (!enabled) return null;
  if (stream) return stream;
  const filePath = logFilePath();
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    rotateTraceLog(filePath);
    stream = createWriteStream(filePath, { flags: 'a' });
    stream.on('error', () => {
      stream = null;
    });
    return stream;
  } catch (err) {
    enabled = false;
    logger.warn({ err, filePath }, 'latency-tracer: disabled, failed to open trace log');
    return null;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function roundMs(value: number): number {
  return Number(value.toFixed(3));
}

function byteLength(value: string): number {
  return Buffer.byteLength(value);
}

function writeTrace(event: string, fields: JsonRecord = {}): void {
  if (!enabled) return;
  const out = ensureStream();
  if (!out) return;
  const record = {
    ts: nowIso(),
    monotonicMs: roundMs(performance.now()),
    pid: process.pid,
    event,
    ...fields,
  };
  try {
    out.write(`${JSON.stringify(record)}\n`);
  } catch {
    // Tracing must never affect daemon behavior.
  }
}

function cleanupCommandReceipts(now = performance.now()): void {
  if (commandReceipts.size === 0) return;
  for (const [commandId, receipt] of commandReceipts) {
    if (now - receipt.receivedAt > COMMAND_RECEIPT_TTL_MS) commandReceipts.delete(commandId);
  }
  if (commandReceipts.size <= COMMAND_RECEIPT_MAX) return;
  const removeCount = commandReceipts.size - COMMAND_RECEIPT_MAX;
  let removed = 0;
  for (const key of commandReceipts.keys()) {
    commandReceipts.delete(key);
    removed += 1;
    if (removed >= removeCount) break;
  }
}

function rememberRecentSpan(span: RecentSpan): void {
  recentSpans.push(span);
  if (recentSpans.length > RECENT_SPAN_MAX) recentSpans.splice(0, recentSpans.length - RECENT_SPAN_MAX);
}

function rememberGcMarker(marker: GcMarker): void {
  recentGcMarkers.push(marker);
  if (recentGcMarkers.length > RECENT_GC_MAX) recentGcMarkers.splice(0, recentGcMarkers.length - RECENT_GC_MAX);
}

function rememberRecentCommand(command: RecentCommand): void {
  recentCommands.push(command);
  if (recentCommands.length > RECENT_COMMAND_MAX) recentCommands.splice(0, recentCommands.length - RECENT_COMMAND_MAX);
}

function rememberRecentServerSend(send: RecentServerSend): void {
  recentServerSends.push(send);
  if (recentServerSends.length > RECENT_SEND_MAX) recentServerSends.splice(0, recentServerSends.length - RECENT_SEND_MAX);
}

function findRecentSpan(now: number): RecentSpan | null {
  for (let index = recentSpans.length - 1; index >= 0; index -= 1) {
    const span = recentSpans[index]!;
    if (now - span.endedAt < 2_000) return span;
  }
  return null;
}

function findRecentCommand(now: number): RecentCommand | null {
  for (let index = recentCommands.length - 1; index >= 0; index -= 1) {
    const command = recentCommands[index]!;
    if (now - command.receivedAt < RECENT_COMMAND_WINDOW_MS) return command;
  }
  return null;
}

function summarizeRecentCommandBurst(now: number): { count: number; type: string } | null {
  const counts = new Map<string, number>();
  for (let index = recentCommands.length - 1; index >= 0; index -= 1) {
    const command = recentCommands[index]!;
    if (now - command.receivedAt >= RECENT_COMMAND_WINDOW_MS) break;
    counts.set(command.type, (counts.get(command.type) ?? 0) + 1);
  }
  let top: { count: number; type: string } | null = null;
  for (const [type, count] of counts) {
    if (!top || count > top.count) top = { type, count };
  }
  return top && top.count >= 3 ? top : null;
}

function findRecentServerSend(now: number): RecentServerSend | null {
  for (let index = recentServerSends.length - 1; index >= 0; index -= 1) {
    const send = recentServerSends[index]!;
    if (now - send.endedAt < RECENT_SEND_WINDOW_MS) return send;
  }
  return null;
}

function findRecentGc(now: number): GcMarker | null {
  for (let index = recentGcMarkers.length - 1; index >= 0; index -= 1) {
    const marker = recentGcMarkers[index]!;
    if (now - marker.endedAt < 2_000) return marker;
  }
  return null;
}

function removeActiveSpan(span: RecentSpan): void {
  const index = activeSpanStack.lastIndexOf(span);
  if (index >= 0) activeSpanStack.splice(index, 1);
}

function maybeRecordSpan(name: string, durationMs: number, meta: JsonRecord | undefined, thresholdMs: number, force = false, startedAt = performance.now() - durationMs): void {
  if (!enabled) return;
  const duration = roundMs(durationMs);
  if (durationMs >= thresholdMs) {
    rememberRecentSpan({
      name,
      durationMs: duration,
      endedAt: performance.now(),
      startedAt,
      ...(meta ? { meta } : {}),
    });
  }
  if (!force && durationMs < thresholdMs) return;
  writeTrace('span', {
    name,
    durationMs: duration,
    thresholdMs,
    ...(meta ? { meta } : {}),
  });
}

export function isLatencyTracerEnabled(): boolean {
  return enabled;
}

export function startLatencyTracer(): void {
  if (started) return;
  started = true;
  if (!enabled) return;

  ensureStream();
  writeTrace('tracer_start', {
    logFile: logFilePath(),
    flagFile: process.env.IMCODES_DAEMON_LATENCY_TRACE_FLAG ?? DEFAULT_FLAG_FILE,
    sampleIntervalMs: sampleIntervalMs(),
    driftThresholdMs: driftThresholdMs(),
    spanThresholdMs: spanThresholdMs(),
    asyncThresholdMs: asyncThresholdMs(),
    sendThresholdMs: sendThresholdMs(),
    ackSlowMs: ackSlowMs(),
  });

  try {
    eventLoopMonitor = monitorEventLoopDelay({ resolution: 10 });
    eventLoopMonitor.enable();
  } catch (err) {
    logger.debug({ err }, 'latency-tracer: monitorEventLoopDelay unavailable');
  }

  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const detail = entry as unknown as { kind?: number };
        rememberGcMarker({
          kind: typeof detail.kind === 'number' ? detail.kind : 0,
          durationMs: roundMs(entry.duration),
          endedAt: performance.now(),
        });
      }
    });
    gcObserver.observe({ entryTypes: ['gc'] });
  } catch (err) {
    gcObserver = null;
    logger.debug({ err }, 'latency-tracer: gc PerformanceObserver unavailable');
  }

  const sampleMs = sampleIntervalMs();
  sampleTimer = setInterval(() => {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const elapsedMs = Math.max(1, now - lastCpuAt);
    const cpuDeltaMicros = (cpu.user - lastCpu.user) + (cpu.system - lastCpu.system);
    const cpuPctOneCore = (cpuDeltaMicros / 1000 / elapsedMs) * 100;
    const mem = process.memoryUsage();
    const eluDelta = performance.eventLoopUtilization(lastElu);
    const [load1, load5, load15] = loadavg();
    const activeHandles = typeof (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles === 'function'
      ? (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles().length
      : undefined;
    const activeRequests = typeof (process as unknown as { _getActiveRequests?: () => unknown[] })._getActiveRequests === 'function'
      ? (process as unknown as { _getActiveRequests: () => unknown[] })._getActiveRequests().length
      : undefined;

    writeTrace('process_sample', {
      elapsedMs: roundMs(elapsedMs),
      cpuPctOneCore: Number(cpuPctOneCore.toFixed(1)),
      eluUtilization: Number(eluDelta.utilization.toFixed(4)),
      rssMB: Number((mem.rss / 1024 / 1024).toFixed(1)),
      heapUsedMB: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
      heapTotalMB: Number((mem.heapTotal / 1024 / 1024).toFixed(1)),
      externalMB: Number((mem.external / 1024 / 1024).toFixed(1)),
      load1: Number(load1.toFixed(2)),
      load5: Number(load5.toFixed(2)),
      load15: Number(load15.toFixed(2)),
      pendingCommandReceipts: commandReceipts.size,
      recentCommands: recentCommands.length,
      recentServerSends: recentServerSends.length,
      ...(activeHandles !== undefined ? { activeHandles } : {}),
      ...(activeRequests !== undefined ? { activeRequests } : {}),
      ...(eventLoopMonitor ? {
        eventLoopDelayP99Ms: roundMs(eventLoopMonitor.percentile(99) / 1e6),
        eventLoopDelayMaxMs: roundMs(eventLoopMonitor.max / 1e6),
        eventLoopDelayMeanMs: roundMs(eventLoopMonitor.mean / 1e6),
      } : {}),
    });

    if (eventLoopMonitor) eventLoopMonitor.reset();
    cleanupCommandReceipts(now);
    lastCpu = cpu;
    lastCpuAt = now;
    lastElu = performance.eventLoopUtilization();
  }, sampleMs);
  sampleTimer.unref?.();

  const driftMs = 100;
  expectedDriftAt = performance.now() + driftMs;
  driftTimer = setInterval(() => {
    const now = performance.now();
    const drift = now - expectedDriftAt;
    expectedDriftAt = now + driftMs;
    if (drift < driftThresholdMs()) return;
    const active = activeSpanStack.at(-1) ?? null;
    const recent = findRecentSpan(now);
    const recentSend = findRecentServerSend(now);
    const recentGc = findRecentGc(now);
    const recentCommand = findRecentCommand(now);
    const commandBurst = summarizeRecentCommandBurst(now);
    const reason = active ? 'active_span' : recent ? 'recent_span' : recentSend ? 'recent_server_send' : recentGc ? 'gc' : recentCommand ? 'recent_command' : 'unknown';
    writeTrace('event_loop_block', {
      driftMs: roundMs(drift),
      thresholdMs: driftThresholdMs(),
      attributionReason: reason,
      attributed: reason !== 'unknown',
      ...(active ? {
        likelyActiveSpan: active.name,
        likelyActiveSpanMeta: active.meta,
      } : {}),
      ...(recent ? {
        likelyRecentSpan: recent.name,
        likelyRecentSpanDurationMs: recent.durationMs,
        likelyRecentSpanMeta: recent.meta,
      } : {}),
      ...(recentSend ? {
        likelyRecentServerSendType: recentSend.msgType,
        likelyRecentServerSendBytes: recentSend.jsonBytes,
        likelyRecentServerSendTotalMs: recentSend.totalMs,
        likelyRecentServerSendStringifyMs: recentSend.stringifyMs,
        likelyRecentServerSendWsSendMs: recentSend.wsSendMs,
        likelyRecentServerSendPlane: recentSend.plane,
        ...(recentSend.outboundQueueDepth !== undefined ? { likelyRecentServerSendQueueDepth: recentSend.outboundQueueDepth } : {}),
        ...(recentSend.outboundQueueAgeMs !== undefined ? { likelyRecentServerSendQueueAgeMs: recentSend.outboundQueueAgeMs } : {}),
        ...(recentSend.sendBacklogAgeMs !== undefined ? { likelyRecentServerSendBacklogAgeMs: recentSend.sendBacklogAgeMs } : {}),
      } : {}),
      ...(recentGc ? {
        likelyGcKind: recentGc.kind,
        likelyGcDurationMs: recentGc.durationMs,
      } : {}),
      ...(recentCommand ? {
        likelyRecentCommandType: recentCommand.type,
        likelyRecentCommandAgeMs: roundMs(now - recentCommand.receivedAt),
        ...(recentCommand.commandId ? { likelyRecentCommandId: recentCommand.commandId } : {}),
        ...(recentCommand.requestId ? { likelyRecentRequestId: recentCommand.requestId } : {}),
        ...(recentCommand.sessionName ? { likelyRecentCommandSessionName: recentCommand.sessionName } : {}),
        ...(recentCommand.commandBytes !== undefined ? { likelyRecentCommandBytes: recentCommand.commandBytes } : {}),
      } : {}),
      ...(commandBurst ? {
        commandBurst: commandBurst.count,
        commandBurstType: commandBurst.type,
        commandBurstWindowMs: RECENT_COMMAND_WINDOW_MS,
      } : {}),
    });
  }, driftMs);
  driftTimer.unref?.();

  logger.info({ logFile: logFilePath() }, 'latency-tracer: started');
}

export function traceSync<T>(name: string, meta: JsonRecord | undefined, fn: () => T, options?: { thresholdMs?: number; force?: boolean }): T {
  if (!enabled) return fn();
  const start = performance.now();
  const span: RecentSpan = { name, durationMs: 0, startedAt: start, endedAt: start, ...(meta ? { meta } : {}) };
  activeSpanStack.push(span);
  try {
    return fn();
  } finally {
    const duration = performance.now() - start;
    removeActiveSpan(span);
    maybeRecordSpan(name, duration, meta, options?.thresholdMs ?? spanThresholdMs(), options?.force, start);
  }
}

export async function traceAsync<T>(name: string, meta: JsonRecord | undefined, fn: () => Promise<T>, options?: { thresholdMs?: number; force?: boolean }): Promise<T> {
  if (!enabled) return fn();
  const start = performance.now();
  const span: RecentSpan = { name, durationMs: 0, startedAt: start, endedAt: start, ...(meta ? { meta } : {}) };
  activeSpanStack.push(span);
  try {
    return await fn();
  } finally {
    const duration = performance.now() - start;
    removeActiveSpan(span);
    maybeRecordSpan(name, duration, meta, options?.thresholdMs ?? asyncThresholdMs(), options?.force, start);
  }
}

export function traceWebCommandReceived(cmd: Record<string, unknown>): void {
  if (!enabled) return;
  const type = typeof cmd.type === 'string' ? cmd.type : '<non-string>';
  const commandId = typeof cmd.commandId === 'string' && cmd.commandId.trim() ? cmd.commandId.trim() : undefined;
  const requestId = typeof cmd.requestId === 'string' && cmd.requestId.trim() ? cmd.requestId.trim() : undefined;
  const sessionName = typeof cmd.sessionName === 'string'
    ? cmd.sessionName
    : (typeof cmd.session === 'string' ? cmd.session : undefined);
  if (commandId) {
    commandReceipts.set(commandId, {
      type,
      receivedAt: performance.now(),
      commandId,
      ...(sessionName ? { sessionName } : {}),
    });
  }
  let commandBytes: number | undefined;
  try {
    commandBytes = byteLength(JSON.stringify(cmd));
  } catch {
    commandBytes = undefined;
  }
  rememberRecentCommand({
    type,
    receivedAt: performance.now(),
    ...(commandId ? { commandId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(sessionName ? { sessionName } : {}),
    ...(commandBytes !== undefined ? { commandBytes } : {}),
  });
  writeTrace('web_command_received', {
    type,
    ...(commandId ? { commandId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(sessionName ? { sessionName } : {}),
    ...(commandBytes !== undefined ? { commandBytes } : {}),
  });
}

export function traceCommandAsync(cmd: Record<string, unknown>, name: string, fn: () => Promise<void>): Promise<void> {
  const type = typeof cmd.type === 'string' ? cmd.type : '<non-string>';
  const commandId = typeof cmd.commandId === 'string' ? cmd.commandId : undefined;
  const sessionName = typeof cmd.sessionName === 'string'
    ? cmd.sessionName
    : (typeof cmd.session === 'string' ? cmd.session : undefined);
  return traceAsync(name, {
    type,
    ...(commandId ? { commandId } : {}),
    ...(sessionName ? { sessionName } : {}),
  }, fn);
}

export function stringifyForServerSend(msg: unknown, seq: number): { payload: string; msgType?: string; commandId?: string; jsonBytes: number; stringifyMs: number } {
  const outgoing = { ...((msg as object) ?? {}), seq };
  const msgRecord = outgoing as Record<string, unknown>;
  const start = performance.now();
  const payload = JSON.stringify(outgoing);
  const stringifyMs = performance.now() - start;
  return {
    payload,
    msgType: typeof msgRecord.type === 'string' ? msgRecord.type : undefined,
    commandId: typeof msgRecord.commandId === 'string' ? msgRecord.commandId : undefined,
    jsonBytes: byteLength(payload),
    stringifyMs,
  };
}

export type ServerSendPlane = 'control' | 'data' | 'unknown';

export function recordServerSend(input: {
  msgType?: string;
  commandId?: string;
  jsonBytes: number;
  stringifyMs: number;
  wsSendMs: number;
  bufferedAmountBefore?: number;
  bufferedAmountAfter?: number;
  sendBacklogAgeMs?: number;
  outboundQueueDepth?: number;
  outboundQueueAgeMs?: number;
  recipientCount?: number;
  success: boolean;
}): void {
  if (!enabled) return;
  const sendTotalMs = input.stringifyMs + input.wsSendMs;
  const isAck = input.msgType === MSG_COMMAND_ACK;
  const plane = classifyServerSendPlane(input.msgType);
  let ackLatencyMs: number | undefined;
  let commandType: string | undefined;
  let sessionName: string | undefined;
  if (isAck && input.commandId) {
    const receipt = commandReceipts.get(input.commandId);
    if (receipt) {
      ackLatencyMs = performance.now() - receipt.receivedAt;
      commandType = receipt.type;
      sessionName = receipt.sessionName;
      commandReceipts.delete(input.commandId);
    }
  }

  const slow = sendTotalMs >= sendThresholdMs()
    || input.stringifyMs >= sendThresholdMs()
    || (ackLatencyMs !== undefined && ackLatencyMs >= ackSlowMs());
  const largePayload = input.jsonBytes >= largeSendTraceBytes();
  const queuedOrBacklogged = plane === 'data' && (
    (input.outboundQueueDepth ?? 0) > 0
    || (input.outboundQueueAgeMs ?? 0) >= driftThresholdMs()
    || (input.sendBacklogAgeMs ?? 0) >= driftThresholdMs()
  );
  if (slow || largePayload || queuedOrBacklogged) {
    rememberRecentServerSend({
      msgType: input.msgType ?? '<unknown>',
      endedAt: performance.now(),
      jsonBytes: input.jsonBytes,
      totalMs: roundMs(sendTotalMs),
      stringifyMs: roundMs(input.stringifyMs),
      wsSendMs: roundMs(input.wsSendMs),
      plane,
      ...(input.outboundQueueDepth !== undefined ? { outboundQueueDepth: input.outboundQueueDepth } : {}),
      ...(input.outboundQueueAgeMs !== undefined ? { outboundQueueAgeMs: roundMs(input.outboundQueueAgeMs) } : {}),
      ...(input.sendBacklogAgeMs !== undefined ? { sendBacklogAgeMs: roundMs(input.sendBacklogAgeMs) } : {}),
    });
  }
  if (!slow && !isAck && !largePayload && !queuedOrBacklogged) return;

  writeTrace(isAck ? 'command_ack_send' : 'server_send', {
    msgType: input.msgType ?? '<unknown>',
    ...(input.commandId ? { commandId: input.commandId } : {}),
    ...(commandType ? { commandType } : {}),
    ...(sessionName ? { sessionName } : {}),
    jsonBytes: input.jsonBytes,
    stringifyMs: roundMs(input.stringifyMs),
    wsSendMs: roundMs(input.wsSendMs),
    totalMs: roundMs(sendTotalMs),
    plane,
    traceReason: slow ? 'slow_send' : largePayload ? 'large_payload' : queuedOrBacklogged ? 'queued_or_backlogged' : 'ack',
    largeSendThresholdBytes: largeSendTraceBytes(),
    ...(input.bufferedAmountBefore !== undefined ? { bufferedAmountBefore: input.bufferedAmountBefore } : {}),
    ...(input.bufferedAmountAfter !== undefined ? { bufferedAmountAfter: input.bufferedAmountAfter } : {}),
    ...(input.sendBacklogAgeMs !== undefined ? { sendBacklogAgeMs: roundMs(input.sendBacklogAgeMs) } : {}),
    ...(input.outboundQueueDepth !== undefined ? { outboundQueueDepth: input.outboundQueueDepth } : {}),
    ...(input.outboundQueueAgeMs !== undefined ? { outboundQueueAgeMs: roundMs(input.outboundQueueAgeMs) } : {}),
    ...(input.recipientCount !== undefined ? { recipientCount: input.recipientCount } : {}),
    success: input.success,
    ...(ackLatencyMs !== undefined ? { ackLatencyMs: roundMs(ackLatencyMs), ackSlowThresholdMs: ackSlowMs() } : {}),
  });
}

export function classifyServerSendPlane(msgType: string | undefined): ServerSendPlane {
  if (!msgType) return 'unknown';
  if (
    msgType === MSG_COMMAND_ACK
    || msgType === 'command.error'
    || msgType.endsWith('.cancel_response')
    || msgType === 'session.idle'
    || msgType === 'daemon.hello'
    || msgType === 'daemon.stats'
    || msgType === 'heartbeat'
    // Live timeline events carry the chat stream/typewriter updates and
    // session.state transitions. They must bypass bulk history/data replay.
    || msgType === TIMELINE_MESSAGES.EVENT
    || msgType === TRANSPORT_EVENT.CHAT_DELTA
    || msgType === TRANSPORT_EVENT.CHAT_COMPLETE
    || msgType === TRANSPORT_EVENT.CHAT_ERROR
    || msgType === TRANSPORT_EVENT.CHAT_STATUS
    || msgType === TRANSPORT_EVENT.CHAT_TOOL
    || msgType === TRANSPORT_EVENT.CHAT_APPROVAL
    || msgType === TRANSPORT_MSG.CHAT_APPROVAL
    || msgType === TRANSPORT_MSG.APPROVAL_RESPONSE
    || msgType === TRANSPORT_MSG.PROVIDER_STATUS
  ) {
    return 'control';
  }
  if (
    (Object.values(TIMELINE_MESSAGES) as string[]).includes(msgType)
    || msgType.startsWith('fs.')
    || msgType === 'transport.models_response'
    || msgType === 'chat.history'
    || msgType === 'diagnostics.response'
  ) {
    return 'data';
  }
  return 'unknown';
}

export function recordTimelineEmit(input: JsonRecord & { durationMs: number; type: string; sessionId: string }): void {
  maybeRecordSpan('timeline.emit', input.durationMs, input, spanThresholdMs(), false);
}

export function recordFsWorkerMetric(input: JsonRecord & {
  commandType: 'fs.ls' | 'fs.git_status';
  cacheStatus: string;
  terminalReason: string;
}): void {
  if (!enabled) return;
  writeTrace(input.commandType === 'fs.ls' ? 'fs_list_worker' : 'fs_git_status_worker', input);
}

export function recordServerLinkDataPlaneBackpressure(input: JsonRecord): void {
  if (!enabled) return;
  writeTrace('serverlink_data_plane_backpressure', input);
}

export function recordServerLinkDataPlaneStaleDropped(input: JsonRecord): void {
  if (!enabled) return;
  writeTrace('serverlink_data_plane_stale_dropped', input);
}

export function recordTimelineBudgetShape(input: JsonRecord): void {
  if (!enabled) return;
  writeTrace('timeline_budget_shape', input);
}

export function recordTransportListModelsStaleCompletion(input: JsonRecord): void {
  if (!enabled) return;
  writeTrace('transport_list_models_stale_completion', input);
}
