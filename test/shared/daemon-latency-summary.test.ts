import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { TIMELINE_MESSAGES } from '../../shared/timeline-protocol.js';

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = join(process.cwd(), 'scripts/summarize-daemon-latency.mjs');

let tempDirs: string[] = [];

function writeNdjson(path: string, records: Array<Record<string, unknown>>): void {
  // Synthetic-only fixture data. Do not paste real daemon/user JSONL logs here.
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

describe('daemon latency summary', () => {
  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  it('reports attribution coverage, payloads, command bursts, process samples, and bridge fan-out from synthetic logs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'imc-latency-summary-'));
    tempDirs.push(dir);
    const latencyTrace = join(dir, 'latency-trace.ndjson');
    const procTrace = join(dir, 'daemon-proc-trace-pid123.ndjson');
    const daemonLog = join(dir, 'daemon.log');

    writeNdjson(latencyTrace, [
      { event: 'web_command_received', type: TIMELINE_MESSAGES.HISTORY_REQUEST },
      { event: 'web_command_received', type: TIMELINE_MESSAGES.HISTORY_REQUEST },
      { event: 'web_command_received', type: 'fs.ls' },
      { event: 'server_send', msgType: TIMELINE_MESSAGES.HISTORY, jsonBytes: 600_000, totalMs: 120 },
      { event: 'server_send', msgType: TIMELINE_MESSAGES.REPLAY, actualPayloadBytes: 650_000, totalMs: 130 },
      { event: 'span', name: 'web_command.timeline_history', durationMs: 2400, meta: { type: TIMELINE_MESSAGES.HISTORY_REQUEST } },
      { event: 'event_loop_block', driftMs: 800, likelyRecentSpan: 'web_command.timeline_history' },
      { event: 'event_loop_block', driftMs: 250, reason: 'unknown' },
      { event: 'event_loop_block', driftMs: 300 },
      { event: 'event_loop_block', driftMs: 100, attributionReason: 'gc', likelyGcKind: 4 },
      { event: 'event_loop_block', driftMs: 450, attributionReason: 'recent_command', likelyRecentCommandType: 'fs.git_status', commandBurst: 3, commandBurstType: 'fs.git_status' },
      { event: 'event_loop_block', driftMs: 550, attributionReason: 'recent_server_send', likelyRecentServerSendType: 'fs.git_status_response', likelyRecentServerSendBytes: 500_000 },
      { event: 'command_ack_send', msgType: 'command.ack', commandType: 'session.send', ackLatencyMs: 42, jsonBytes: 120, totalMs: 2 },
      { event: 'command_ack_send', msgType: 'command.ack', commandType: 'session.send', ackLatencyMs: 80, jsonBytes: 121, totalMs: 2 },
      {
        event: 'bridge_fanout',
        msgType: TIMELINE_MESSAGES.HISTORY,
        recipientCount: 4,
        requestIdFanOutCount: 3,
        httpCallerCount: 1,
        broadcastRecipientCount: 2,
        chunkCount: 5,
        jsonBytes: 700_000,
      },
      { event: 'bridge_queue_job', queueDepth: 6, queueWaitMs: 140, backlogAgeMs: 300, canceled: true },
      { event: 'bridge_queue_deadline', queueDepth: 4, deadlineExceeded: true, skippedCount: 2 },
      { event: 'fs_git_status_worker', commandType: 'fs.git_status', queueDepth: 5, queueWaitMs: 90, workerExecutionMs: 375, cacheStatus: 'miss', terminalReason: 'ok' },
      { event: 'fs_list_worker', commandType: 'fs.ls', queueDepth: 2, queueWaitMs: 25, workerExecutionMs: 120, cacheStatus: 'stale', terminalReason: 'worker_timeout', lateResultSkip: true },
      { event: 'web_command_received', type: 'terminal.subscribe' },
      { event: 'web_command_received', type: 'terminal.subscribe' },
      { event: 'web_command_received', type: 'terminal.unsubscribe' },
      { event: 'process_sample', cpuPctOneCore: 55, rssMB: 123 },
    ]);
    writeNdjson(procTrace, [
      { event: 'proc_sample', cpuPctOneCore: 75, rssMB: 234 },
    ]);
    writeNdjson(daemonLog, [
      { msg: 'timeline.history served', totalMs: 3225, bytes: 1_048_576 },
    ]);

    const { stdout } = await execFileAsync(process.execPath, [
      SCRIPT_PATH,
      '--latency-trace',
      latencyTrace,
      '--daemon-log',
      daemonLog,
      '--proc-trace',
      procTrace,
      '--json',
    ]);
    const summary = JSON.parse(stdout);

    expect(summary.eventLoopBlocks.count).toBe(6);
    expect(summary.eventLoopBlocks.reasonFieldCoverage).toBe(0.8333);
    expect(summary.eventLoopBlocks.attributedCoverage).toBe(0.6667);
    expect(summary.eventLoopBlocks.unattributedBlockCount).toBe(2);
    expect(summary.eventLoopBlocks.explicitUnknownCount).toBe(1);
    expect(summary.ackLatency.p95Ms).toBe(80);
    expect(summary.highFrequencyCommandCounts[TIMELINE_MESSAGES.HISTORY_REQUEST]).toBe(2);
    expect(summary.highFrequencyCommandCounts['terminal.subscribe']).toBe(2);
    expect(summary.highFrequencyCommandCounts['terminal.unsubscribe']).toBe(1);
    expect(summary.highFrequencyCommandCounts['fs.ls']).toBe(1);
    expect(summary.process.maxCpuPctOneCore).toBe(75);
    expect(summary.process.maxRssMB).toBe(234);
    expect(summary.bridgeFanOutMetrics.maxRecipientCount).toBe(4);
    expect(summary.bridgeFanOutMetrics.maxRequestIdFanOutCount).toBe(3);
    expect(summary.bridgeFanOutMetrics.maxHttpCallerCount).toBe(1);
    expect(summary.bridgeFanOutMetrics.maxChunkCount).toBe(5);
    expect(summary.bridgeQueueMetrics).toMatchObject({
      count: 2,
      maxQueueDepth: 6,
      maxQueueWaitMs: 140,
      maxBacklogAgeMs: 300,
      canceledCount: 1,
      skippedCount: 2,
      deadlineExceededCount: 1,
    });
    expect(summary.fsGitWorkerMetrics).toMatchObject({
      count: 2,
      maxQueueDepth: 5,
      maxQueueWaitMs: 90,
      maxWorkerExecutionMs: 375,
      lateResultSkipCount: 1,
    });
    expect(summary.fsGitWorkerMetrics.byCommand).toMatchObject({ 'fs.git_status': 1, 'fs.ls': 1 });
    expect(summary.fsGitWorkerMetrics.cacheStatusCounts).toMatchObject({ miss: 1, stale: 1 });
    expect(summary.fsGitWorkerMetrics.terminalReasons).toMatchObject({ ok: 1, worker_timeout: 1 });
    expect(summary.largestPayloads[0]).toMatchObject({ bytes: 1_048_576, label: 'timeline.history served' });
    expect(summary.largestPayloads[1]).toMatchObject({ bytes: 700_000, label: TIMELINE_MESSAGES.HISTORY });
    expect(summary.largestPayloads[2]).toMatchObject({ bytes: 650_000, label: TIMELINE_MESSAGES.REPLAY });
    expect(summary.slowestSpans[0]).toMatchObject({ durationMs: 2400, name: 'web_command.timeline_history' });
    expect(summary.daemonLog.timelineHistoryServed).toMatchObject({
      count: 1,
      maxTotalMs: 3225,
      maxBytes: 1_048_576,
    });
  });
});
