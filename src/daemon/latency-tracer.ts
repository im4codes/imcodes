import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, loadavg } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import logger from '../util/logger.js';

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
  meta?: JsonRecord;
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
let lastCpu = process.cpuUsage();
let lastCpuAt = performance.now();
let lastElu = performance.eventLoopUtilization();
let expectedDriftAt = 0;
const commandReceipts = new Map<string, CommandReceipt>();
let recentHeavySpan: RecentSpan | null = null;

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

function maybeRecordSpan(name: string, durationMs: number, meta: JsonRecord | undefined, thresholdMs: number, force = false): void {
  if (!enabled) return;
  const duration = roundMs(durationMs);
  if (durationMs >= thresholdMs) {
    recentHeavySpan = {
      name,
      durationMs: duration,
      endedAt: performance.now(),
      ...(meta ? { meta } : {}),
    };
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
    const recent = recentHeavySpan && now - recentHeavySpan.endedAt < 2_000 ? recentHeavySpan : null;
    writeTrace('event_loop_block', {
      driftMs: roundMs(drift),
      thresholdMs: driftThresholdMs(),
      ...(recent ? {
        likelyRecentSpan: recent.name,
        likelyRecentSpanDurationMs: recent.durationMs,
        likelyRecentSpanMeta: recent.meta,
      } : {}),
    });
  }, driftMs);
  driftTimer.unref?.();

  logger.info({ logFile: logFilePath() }, 'latency-tracer: started');
}

export function traceSync<T>(name: string, meta: JsonRecord | undefined, fn: () => T, options?: { thresholdMs?: number; force?: boolean }): T {
  if (!enabled) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    maybeRecordSpan(name, performance.now() - start, meta, options?.thresholdMs ?? spanThresholdMs(), options?.force);
  }
}

export async function traceAsync<T>(name: string, meta: JsonRecord | undefined, fn: () => Promise<T>, options?: { thresholdMs?: number; force?: boolean }): Promise<T> {
  if (!enabled) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    maybeRecordSpan(name, performance.now() - start, meta, options?.thresholdMs ?? asyncThresholdMs(), options?.force);
  }
}

export function traceWebCommandReceived(cmd: Record<string, unknown>): void {
  if (!enabled) return;
  const type = typeof cmd.type === 'string' ? cmd.type : '<non-string>';
  const commandId = typeof cmd.commandId === 'string' && cmd.commandId.trim() ? cmd.commandId.trim() : undefined;
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
  writeTrace('web_command_received', {
    type,
    ...(commandId ? { commandId } : {}),
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

export function recordServerSend(input: {
  msgType?: string;
  commandId?: string;
  jsonBytes: number;
  stringifyMs: number;
  wsSendMs: number;
  success: boolean;
}): void {
  if (!enabled) return;
  const sendTotalMs = input.stringifyMs + input.wsSendMs;
  const isAck = input.msgType === 'command.ack';
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
  if (!slow && !isAck) return;

  writeTrace(isAck ? 'command_ack_send' : 'server_send', {
    msgType: input.msgType ?? '<unknown>',
    ...(input.commandId ? { commandId: input.commandId } : {}),
    ...(commandType ? { commandType } : {}),
    ...(sessionName ? { sessionName } : {}),
    jsonBytes: input.jsonBytes,
    stringifyMs: roundMs(input.stringifyMs),
    wsSendMs: roundMs(input.wsSendMs),
    totalMs: roundMs(sendTotalMs),
    success: input.success,
    ...(ackLatencyMs !== undefined ? { ackLatencyMs: roundMs(ackLatencyMs), ackSlowThresholdMs: ackSlowMs() } : {}),
  });
}

export function recordTimelineEmit(input: JsonRecord & { durationMs: number; type: string; sessionId: string }): void {
  maybeRecordSpan('timeline.emit', input.durationMs, input, spanThresholdMs(), false);
}

