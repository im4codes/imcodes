#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_LOG_DIR = join(homedir(), '.imcodes', 'logs');
const DEFAULT_LATENCY_TRACE = join(DEFAULT_LOG_DIR, 'latency-trace.ndjson');
const DEFAULT_DAEMON_LOG = join(DEFAULT_LOG_DIR, 'daemon.log');
const DEFAULT_PROC_TRACE = join(DEFAULT_LOG_DIR, 'daemon-proc-trace-*.ndjson');

function usage() {
  console.log(`Usage: node scripts/summarize-daemon-latency.mjs [options]

Options:
  --latency-trace <path>  Latency NDJSON path (repeatable; default: ${DEFAULT_LATENCY_TRACE})
  --daemon-log <path>     Daemon app log path (repeatable; default: ${DEFAULT_DAEMON_LOG})
  --proc-trace <path>     Process trace NDJSON path or glob (repeatable; default: ${DEFAULT_PROC_TRACE})
  --limit <n>             Number of top records to keep (default: 10)
  --json                  Print JSON instead of text
  --help                  Show this help
`);
}

function parseArgs(argv) {
  const args = {
    latencyTraces: [],
    daemonLogs: [],
    procTraces: [],
    limit: 10,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--latency-trace') {
      args.latencyTraces.push(argv[++i]);
    } else if (arg === '--daemon-log') {
      args.daemonLogs.push(argv[++i]);
    } else if (arg === '--proc-trace') {
      args.procTraces.push(argv[++i]);
    } else if (arg === '--limit') {
      args.limit = Math.max(1, Number(argv[++i]) || 10);
    } else if (arg === '--json') {
      args.json = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.latencyTraces.length === 0) args.latencyTraces.push(DEFAULT_LATENCY_TRACE);
  if (args.daemonLogs.length === 0) args.daemonLogs.push(DEFAULT_DAEMON_LOG);
  if (args.procTraces.length === 0) args.procTraces.push(DEFAULT_PROC_TRACE);
  return args;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expandPath(pattern) {
  if (!pattern.includes('*')) return existsSync(pattern) ? [pattern] : [];
  const dir = dirname(pattern);
  if (!existsSync(dir)) return [];
  const filePattern = basename(pattern);
  const regex = new RegExp(`^${filePattern.split('*').map(escapeRegExp).join('.*')}$`);
  return readdirSync(dir)
    .map((entry) => join(dir, entry))
    .filter((path) => regex.test(basename(path)) && statSync(path).isFile())
    .sort();
}

function parseJsonLine(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function readRecords(paths, sourceKind) {
  const records = [];
  const expanded = paths.flatMap(expandPath);
  for (const path of expanded) {
    const raw = readFileSync(path, 'utf8');
    const lines = raw.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      const parsed = parseJsonLine(line);
      if (parsed) records.push({ ...parsed, __sourceKind: sourceKind, __sourcePath: path, __line: index + 1 });
    }
  }
  return { records, paths: expanded };
}

function asNumber(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function firstNumber(record, keys) {
  for (const key of keys) {
    const value = asNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstString(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function describeRecord(record) {
  return firstString(record, ['msgType', 'type', 'name', 'event', 'msg']) ?? '<unknown>';
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(3));
}

function pushTop(list, entry, limit, field) {
  list.push(entry);
  list.sort((a, b) => b[field] - a[field]);
  if (list.length > limit) list.length = limit;
}

function isUnknownReason(value) {
  return /^(unknown|unattributed|none)$/i.test(String(value ?? '').trim());
}

function eventLoopBlockAttribution(record) {
  const reason = firstString(record, [
    'reason',
    'reasonField',
    'likelyReason',
    'eventLoopReason',
    'attributionReason',
    'cause',
    'attribution',
  ]);
  const attributedByField = Boolean(
    record.likelyRecentSpan
    || record.likelySpan
    || record.likelySpanName
    || record.activeSpan
    || record.recentSpan
    || record.likelyActiveSpan
    || record.likelyGcKind
    || record.likelyGcDurationMs
    || record.gcKind
    || record.gcDurationMs
    || record.nativeReason
    || record.commandBurst
    || record.commandBurstType
    || record.sendBacklog
    || record.backlogAgeMs
    || record.sendBacklogAgeMs
    || record.likelyRecentCommandType
    || record.likelyRecentRequestId
    || record.likelyRecentServerSendType
    || record.likelyRecentServerSendBytes
    || record.likelyRecentServerSendQueueDepth
    || record.attributed === true
  );
  const explicitUnknown = isUnknownReason(reason) || record.unknown === true || record.unattributed === true;
  const hasReason = Boolean(reason) || attributedByField || record.unknown === true || record.unattributed === true;
  const attributedByReason = Boolean(reason) && !isUnknownReason(reason);
  const attributed = !explicitUnknown && (attributedByField || attributedByReason);
  return { hasReason, attributed, explicitUnknown };
}

function isBridgeFanOutRecord(record) {
  const event = String(record.event ?? record.name ?? record.msg ?? '');
  return /bridge/i.test(event) && Boolean(
    record.recipientCount !== undefined
    || record.fanOutCount !== undefined
    || record.requestIdFanOutCount !== undefined
    || record.httpCallerCount !== undefined
    || record.broadcastRecipientCount !== undefined
    || record.chunkCount !== undefined
    || record.pageCount !== undefined
  );
}

function isBridgeQueueRecord(record) {
  const event = String(record.event ?? record.name ?? record.msg ?? '');
  return /bridge/i.test(event) && Boolean(
    record.queueDepth !== undefined
    || record.queueWaitMs !== undefined
    || record.backlogAgeMs !== undefined
    || record.canceled !== undefined
    || record.cancelCount !== undefined
    || record.deadlineExceeded !== undefined
    || record.deadlineExceededCount !== undefined
    || record.skipped !== undefined
    || record.skippedCount !== undefined
  );
}

function isFsGitWorkerRecord(record) {
  const event = String(record.event ?? record.name ?? record.msg ?? '');
  const command = firstString(record, ['commandType', 'type', 'msgType', 'command']);
  const hasWorkerMetric = Boolean(
    record.queueDepth !== undefined
    || record.workerQueueDepth !== undefined
    || record.queueWaitMs !== undefined
    || record.workerQueueWaitMs !== undefined
    || record.workerExecutionMs !== undefined
    || record.workerDurationMs !== undefined
    || record.cacheStatus !== undefined
    || record.terminalReason !== undefined
    || record.lateResultSkip !== undefined
    || record.lateResultSkipped !== undefined
    || record.lateResultSkipCount !== undefined
  );
  if (!hasWorkerMetric) return false;
  return /fs[_.-]?(ls|list|git)|git[_.-]?status/i.test(event)
    || command === 'fs.ls'
    || command === 'fs.git_status';
}

function summarize(inputs, limit) {
  const ackLatencies = [];
  const timelineHistoryTotals = [];
  const timelineHistoryBytes = [];
  const commandCounts = new Map();
  const blocks = [];
  const largestPayloads = [];
  const slowestSpans = [];
  const largestEventLoopBlocks = [];
  const processSamples = [];
  const bridgeFanOutMetrics = {
    count: 0,
    maxRecipientCount: 0,
    maxFanOutCount: 0,
    maxRequestIdFanOutCount: 0,
    maxHttpCallerCount: 0,
    maxBroadcastRecipientCount: 0,
    maxChunkCount: 0,
    maxPageCount: 0,
    largestJsonBytes: 0,
  };
  const bridgeQueueMetrics = {
    count: 0,
    maxQueueDepth: 0,
    maxQueueWaitMs: 0,
    maxBacklogAgeMs: 0,
    canceledCount: 0,
    skippedCount: 0,
    deadlineExceededCount: 0,
    maxQueueLength: 0,
  };
  const fsGitWorkerMetrics = {
    count: 0,
    byCommand: {},
    maxQueueDepth: 0,
    maxQueueWaitMs: 0,
    maxWorkerExecutionMs: 0,
    terminalReasons: {},
    cacheStatusCounts: {},
    lateResultSkipCount: 0,
  };

  function processRecord(record) {
    const bytes = firstNumber(record, ['actualPayloadBytes', 'jsonBytes', 'payloadBytes', 'responseBytes', 'bytes', 'sizeBytes', 'contentLength', 'totalBytes']);
    if (bytes !== undefined) {
      pushTop(largestPayloads, {
        bytes,
        label: describeRecord(record),
        source: record.__sourceKind,
        path: record.__sourcePath,
        line: record.__line,
      }, limit, 'bytes');
    }

    if (record.event === 'web_command_received') {
      const type = firstString(record, ['type']) ?? '<unknown>';
      commandCounts.set(type, (commandCounts.get(type) ?? 0) + 1);
    }

    if (record.event === 'command_ack_send') {
      const ackLatencyMs = asNumber(record.ackLatencyMs);
      if (ackLatencyMs !== undefined) ackLatencies.push(ackLatencyMs);
    }

    if (record.event === 'span') {
      const durationMs = asNumber(record.durationMs);
      if (durationMs !== undefined) {
        pushTop(slowestSpans, {
          durationMs,
          name: firstString(record, ['name']) ?? '<unknown>',
          type: typeof record.meta?.type === 'string' ? record.meta.type : undefined,
          source: record.__sourceKind,
          path: record.__sourcePath,
          line: record.__line,
        }, limit, 'durationMs');
      }
    }

    if (record.event === 'event_loop_block') {
      const driftMs = firstNumber(record, ['driftMs', 'durationMs', 'delayMs']);
      blocks.push(record);
      if (driftMs !== undefined) {
        pushTop(largestEventLoopBlocks, {
          driftMs,
          reason: firstString(record, ['reason', 'reasonField', 'likelyReason', 'eventLoopReason', 'attributionReason', 'cause', 'attribution']),
          likelyRecentSpan: firstString(record, ['likelyRecentSpan', 'likelySpan', 'likelySpanName', 'activeSpan', 'recentSpan']),
          likelyRecentCommandType: firstString(record, ['likelyRecentCommandType']),
          likelyRecentServerSendType: firstString(record, ['likelyRecentServerSendType']),
          source: record.__sourceKind,
          path: record.__sourcePath,
          line: record.__line,
        }, limit, 'driftMs');
      }
    }

    if (record.event === 'process_sample' || record.event === 'proc_sample') {
      const cpuPctOneCore = asNumber(record.cpuPctOneCore);
      const rssMB = asNumber(record.rssMB);
      processSamples.push({ cpuPctOneCore, rssMB, source: record.__sourceKind, path: record.__sourcePath, line: record.__line });
    }

    if (isBridgeFanOutRecord(record)) {
      bridgeFanOutMetrics.count += 1;
      bridgeFanOutMetrics.maxRecipientCount = Math.max(bridgeFanOutMetrics.maxRecipientCount, firstNumber(record, ['recipientCount']) ?? 0);
      bridgeFanOutMetrics.maxFanOutCount = Math.max(bridgeFanOutMetrics.maxFanOutCount, firstNumber(record, ['fanOutCount']) ?? 0);
      bridgeFanOutMetrics.maxRequestIdFanOutCount = Math.max(bridgeFanOutMetrics.maxRequestIdFanOutCount, firstNumber(record, ['requestIdFanOutCount']) ?? 0);
      bridgeFanOutMetrics.maxHttpCallerCount = Math.max(bridgeFanOutMetrics.maxHttpCallerCount, firstNumber(record, ['httpCallerCount']) ?? 0);
      bridgeFanOutMetrics.maxBroadcastRecipientCount = Math.max(bridgeFanOutMetrics.maxBroadcastRecipientCount, firstNumber(record, ['broadcastRecipientCount']) ?? 0);
      bridgeFanOutMetrics.maxChunkCount = Math.max(bridgeFanOutMetrics.maxChunkCount, firstNumber(record, ['chunkCount']) ?? 0);
      bridgeFanOutMetrics.maxPageCount = Math.max(bridgeFanOutMetrics.maxPageCount, firstNumber(record, ['pageCount']) ?? 0);
      bridgeFanOutMetrics.largestJsonBytes = Math.max(bridgeFanOutMetrics.largestJsonBytes, firstNumber(record, ['jsonBytes', 'payloadBytes', 'responseBytes', 'bytes']) ?? 0);
    }

    if (isBridgeQueueRecord(record)) {
      bridgeQueueMetrics.count += 1;
      bridgeQueueMetrics.maxQueueDepth = Math.max(bridgeQueueMetrics.maxQueueDepth, firstNumber(record, ['queueDepth', 'depth', 'dataPlaneQueueDepth']) ?? 0);
      bridgeQueueMetrics.maxQueueWaitMs = Math.max(bridgeQueueMetrics.maxQueueWaitMs, firstNumber(record, ['queueWaitMs', 'waitMs']) ?? 0);
      bridgeQueueMetrics.maxBacklogAgeMs = Math.max(bridgeQueueMetrics.maxBacklogAgeMs, firstNumber(record, ['backlogAgeMs', 'queueAgeMs']) ?? 0);
      bridgeQueueMetrics.maxQueueLength = Math.max(bridgeQueueMetrics.maxQueueLength, firstNumber(record, ['queueLength', 'pendingJobs']) ?? 0);
      bridgeQueueMetrics.canceledCount += firstNumber(record, ['cancelCount', 'canceledCount']) ?? (record.canceled === true ? 1 : 0);
      bridgeQueueMetrics.skippedCount += firstNumber(record, ['skippedCount']) ?? (record.skipped === true ? 1 : 0);
      bridgeQueueMetrics.deadlineExceededCount += firstNumber(record, ['deadlineExceededCount']) ?? (record.deadlineExceeded === true ? 1 : 0);
    }

    if (isFsGitWorkerRecord(record)) {
      fsGitWorkerMetrics.count += 1;
      const command = firstString(record, ['commandType', 'type', 'msgType', 'command']) ?? '<unknown>';
      fsGitWorkerMetrics.byCommand[command] = (fsGitWorkerMetrics.byCommand[command] ?? 0) + 1;
      fsGitWorkerMetrics.maxQueueDepth = Math.max(fsGitWorkerMetrics.maxQueueDepth, firstNumber(record, ['queueDepth', 'workerQueueDepth']) ?? 0);
      fsGitWorkerMetrics.maxQueueWaitMs = Math.max(fsGitWorkerMetrics.maxQueueWaitMs, firstNumber(record, ['queueWaitMs', 'workerQueueWaitMs']) ?? 0);
      fsGitWorkerMetrics.maxWorkerExecutionMs = Math.max(fsGitWorkerMetrics.maxWorkerExecutionMs, firstNumber(record, ['workerExecutionMs', 'workerDurationMs', 'durationMs']) ?? 0);
      const terminalReason = firstString(record, ['terminalReason', 'reason', 'error', 'errorReason']);
      if (terminalReason) fsGitWorkerMetrics.terminalReasons[terminalReason] = (fsGitWorkerMetrics.terminalReasons[terminalReason] ?? 0) + 1;
      const cacheStatus = firstString(record, ['cacheStatus', 'cache']);
      if (cacheStatus) fsGitWorkerMetrics.cacheStatusCounts[cacheStatus] = (fsGitWorkerMetrics.cacheStatusCounts[cacheStatus] ?? 0) + 1;
      fsGitWorkerMetrics.lateResultSkipCount += firstNumber(record, ['lateResultSkipCount']) ?? (record.lateResultSkip === true || record.lateResultSkipped === true ? 1 : 0);
    }

    if (record.__sourceKind === 'daemon-log' && String(record.msg ?? '').includes('timeline.history served')) {
      const totalMs = firstNumber(record, ['totalMs', 'durationMs', 'bridgeMs']);
      const logBytes = firstNumber(record, ['jsonBytes', 'payloadBytes', 'responseBytes', 'bytes', 'totalBytes']);
      if (totalMs !== undefined) timelineHistoryTotals.push(totalMs);
      if (logBytes !== undefined) timelineHistoryBytes.push(logBytes);
    }
  }

  for (const record of inputs.latencyRecords) processRecord(record);
  for (const record of inputs.procRecords) processRecord(record);
  for (const record of inputs.daemonLogRecords) processRecord(record);

  const reasonCount = blocks.filter((block) => eventLoopBlockAttribution(block).hasReason).length;
  const attributedCount = blocks.filter((block) => eventLoopBlockAttribution(block).attributed).length;
  const explicitUnknownCount = blocks.filter((block) => eventLoopBlockAttribution(block).explicitUnknown).length;
  const maxCpuPctOneCore = Math.max(0, ...processSamples.map((sample) => sample.cpuPctOneCore ?? 0));
  const maxRssMB = Math.max(0, ...processSamples.map((sample) => sample.rssMB ?? 0));
  const latestProcessSample = processSamples.at(-1) ?? {};

  return {
    inputs: {
      latencyTraces: inputs.latencyPaths,
      daemonLogs: inputs.daemonLogPaths,
      procTraces: inputs.procPaths,
    },
    largestPayloads,
    slowestSpans,
    largestEventLoopBlocks,
    ackLatency: {
      count: ackLatencies.length,
      p50Ms: percentile(ackLatencies, 50),
      p95Ms: percentile(ackLatencies, 95),
      p99Ms: percentile(ackLatencies, 99),
      maxMs: percentile(ackLatencies, 100),
    },
    highFrequencyCommandCounts: Object.fromEntries([...commandCounts.entries()].sort((a, b) => b[1] - a[1])),
    process: {
      sampleCount: processSamples.length,
      maxCpuPctOneCore,
      maxRssMB,
      latestCpuPctOneCore: latestProcessSample.cpuPctOneCore ?? null,
      latestRssMB: latestProcessSample.rssMB ?? null,
    },
    bridgeFanOutMetrics,
    bridgeQueueMetrics,
    fsGitWorkerMetrics,
    eventLoopBlocks: {
      count: blocks.length,
      reasonFieldCoverage: blocks.length === 0 ? 1 : Number((reasonCount / blocks.length).toFixed(4)),
      attributedCoverage: blocks.length === 0 ? 1 : Number((attributedCount / blocks.length).toFixed(4)),
      unattributedBlockCount: blocks.length - attributedCount,
      explicitUnknownCount,
    },
    daemonLog: {
      timelineHistoryServed: {
        count: timelineHistoryTotals.length,
        maxTotalMs: percentile(timelineHistoryTotals, 100),
        p95TotalMs: percentile(timelineHistoryTotals, 95),
        maxBytes: percentile(timelineHistoryBytes, 100),
      },
    },
  };
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function printText(summary) {
  console.log('Daemon latency trace summary');
  console.log(`inputs: latency=${summary.inputs.latencyTraces.length}, daemonLog=${summary.inputs.daemonLogs.length}, proc=${summary.inputs.procTraces.length}`);
  console.log(`ack latency: count=${summary.ackLatency.count}, p95=${summary.ackLatency.p95Ms ?? 'n/a'}ms, max=${summary.ackLatency.maxMs ?? 'n/a'}ms`);
  console.log(`event-loop blocks: count=${summary.eventLoopBlocks.count}, reasonFieldCoverage=${formatPercent(summary.eventLoopBlocks.reasonFieldCoverage)}, attributedCoverage=${formatPercent(summary.eventLoopBlocks.attributedCoverage)}, unattributed=${summary.eventLoopBlocks.unattributedBlockCount}`);
  console.log(`process: samples=${summary.process.sampleCount}, maxCpuOneCore=${summary.process.maxCpuPctOneCore}%, maxRss=${summary.process.maxRssMB}MB`);
  console.log(`bridge fan-out: count=${summary.bridgeFanOutMetrics.count}, maxRecipients=${summary.bridgeFanOutMetrics.maxRecipientCount}, maxRequestIdFanOut=${summary.bridgeFanOutMetrics.maxRequestIdFanOutCount}`);
  console.log(`bridge queue: count=${summary.bridgeQueueMetrics.count}, maxDepth=${summary.bridgeQueueMetrics.maxQueueDepth}, canceled=${summary.bridgeQueueMetrics.canceledCount}, deadlineExceeded=${summary.bridgeQueueMetrics.deadlineExceededCount}`);
  console.log(`fs/git worker: count=${summary.fsGitWorkerMetrics.count}, maxQueueDepth=${summary.fsGitWorkerMetrics.maxQueueDepth}, maxQueueWait=${summary.fsGitWorkerMetrics.maxQueueWaitMs}ms, maxWorker=${summary.fsGitWorkerMetrics.maxWorkerExecutionMs}ms, lateSkips=${summary.fsGitWorkerMetrics.lateResultSkipCount}`);
  console.log('high-frequency command counts:');
  for (const [type, count] of Object.entries(summary.highFrequencyCommandCounts).slice(0, 20)) {
    console.log(`  ${type}: ${count}`);
  }
  console.log('largest payloads:');
  for (const payload of summary.largestPayloads) {
    console.log(`  ${payload.bytes}B ${payload.label} (${payload.source}:${payload.line})`);
  }
  console.log('slowest spans:');
  for (const span of summary.slowestSpans) {
    console.log(`  ${span.durationMs}ms ${span.name}${span.type ? ` type=${span.type}` : ''}`);
  }
  console.log('largest event-loop blocks:');
  for (const block of summary.largestEventLoopBlocks) {
    console.log(`  ${block.driftMs}ms${block.reason ? ` reason=${block.reason}` : ''}${block.likelyRecentSpan ? ` span=${block.likelyRecentSpan}` : ''}${block.likelyRecentCommandType ? ` command=${block.likelyRecentCommandType}` : ''}${block.likelyRecentServerSendType ? ` send=${block.likelyRecentServerSendType}` : ''}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const latency = readRecords(args.latencyTraces, 'latency-trace');
  const daemonLog = readRecords(args.daemonLogs, 'daemon-log');
  const proc = readRecords(args.procTraces, 'proc-trace');
  const summary = summarize({
    latencyRecords: latency.records,
    daemonLogRecords: daemonLog.records,
    procRecords: proc.records,
    latencyPaths: latency.paths,
    daemonLogPaths: daemonLog.paths,
    procPaths: proc.paths,
  }, args.limit);

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printText(summary);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
