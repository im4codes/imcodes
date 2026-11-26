import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { TIMELINE_MESSAGES } from '../../../shared/timeline-protocol.js';
import { TIMELINE_PERF_TARGET_SESSION } from './constants.js';

/**
 * Delete latency + main-thread stall on a production-shaped timeline (seed-timeline.ts).
 * Runs the REAL command handler, emitter, JSONL store and projection worker against a
 * pre-seeded scratch home; only unrelated daemon modules are stubbed. The same file runs
 * unchanged against the base commit and the fixed commit.
 *
 *   PERF_HOME=<seeded scratch home> PERF_LABEL=head npx vitest run --config vitest.perf.config.ts
 */
const HOME = process.env.PERF_HOME?.trim();
const LABEL = process.env.PERF_LABEL ?? 'run';
const OUT = process.env.PERF_OUT ?? `/tmp/perf-timeline-delete-${LABEL}.json`;
const ITERATIONS = Number(process.env.PERF_ITERATIONS ?? 25);
const RECENT = 'deck_perfdel_brain';
if (!HOME || HOME.includes('/.imcodes')) throw new Error('PERF_HOME must be a seeded scratch home (not a real ~/.imcodes)');
process.env.IMCODES_HOME = HOME;

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('../../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => []), getSession: getSessionMock, upsertSession: vi.fn(), removeSession: vi.fn(), updateSessionState: vi.fn(),
}));
vi.mock('../../../src/agent/session-manager.js', () => ({
  startProject: vi.fn(), stopProject: vi.fn(), teardownProject: vi.fn(), getTransportRuntime: vi.fn(() => undefined),
  launchTransportSession: vi.fn(), isProviderSessionBound: vi.fn(() => false), persistSessionRecord: vi.fn(),
  relaunchSessionWithSettings: vi.fn(), stopTransportRuntimeSession: vi.fn(),
}));
vi.mock('../../../src/agent/tmux.js', () => ({ sendKeys: vi.fn(), sendKeysDelayedEnter: vi.fn(), sendRawInput: vi.fn(), resizeSession: vi.fn(), sendKey: vi.fn(), getPaneStartCommand: vi.fn() }));
vi.mock('../../../src/router/message-router.js', () => ({ routeMessage: vi.fn() }));
vi.mock('../../../src/daemon/terminal-streamer.js', () => ({ terminalStreamer: { subscribe: vi.fn(), unsubscribe: vi.fn(), start: vi.fn(), stop: vi.fn() } }));
vi.mock('../../../src/daemon/subsession-manager.js', () => ({ startSubSession: vi.fn(), stopSubSession: vi.fn(), rebuildSubSessions: vi.fn(), detectShells: vi.fn().mockResolvedValue([]), readSubSessionResponse: vi.fn(), subSessionName: (id: string) => `deck_sub_${id}` }));
vi.mock('../../../src/daemon/p2p-orchestrator.js', () => ({ startP2pRun: vi.fn(), cancelP2pRun: vi.fn(), getP2pRun: vi.fn(() => undefined), listP2pRuns: vi.fn(() => []), serializeP2pRun: vi.fn() }));
vi.mock('../../../src/daemon/session-list.js', () => ({ buildSessionList: vi.fn(async () => []) }));
vi.mock('../../../src/daemon/repo-handler.js', () => ({ handleRepoCommand: vi.fn() }));
vi.mock('../../../src/daemon/file-transfer-handler.js', () => ({ handleFileUpload: vi.fn(), handleFileUploadFetch: vi.fn(), handleFileDownload: vi.fn(), createProjectFileHandle: vi.fn(), createProjectFileHandleFromValidatedPath: vi.fn(), tryCreateProjectFileHandle: vi.fn(), lookupAttachment: vi.fn(() => undefined) }));
vi.mock('../../../src/daemon/preview-relay.js', () => ({ handlePreviewCommand: vi.fn() }));
vi.mock('../../../src/daemon/provider-sessions.js', () => ({ listProviderSessions: vi.fn(() => []) }));
vi.mock('../../../src/daemon/supervision-broker.js', () => ({ supervisionBroker: { decide: vi.fn() } }));
vi.mock('../../../src/daemon/supervision-automation.js', () => ({ supervisionAutomation: { init: vi.fn(), setServerLink: vi.fn(), cancelSession: vi.fn(), queueTaskIntent: vi.fn(), updateQueuedTaskIntent: vi.fn(), removeQueuedTaskIntent: vi.fn(), registerTaskIntent: vi.fn(), applySnapshotUpdate: vi.fn() } }));

function pct(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!.toFixed(2) : 0;
}

describe('timeline delete latency on a production-shaped timeline', () => {
  it('reports per-case latency and main-thread stall', async () => {
    getSessionMock.mockReturnValue({ name: RECENT, projectName: 'perf', role: 'brain', agentType: 'claude-code-sdk', runtimeType: 'transport', state: 'idle' });
    const { handleWebCommand } = await import('../../../src/daemon/command-handler.js');
    const { timelineEmitter } = await import('../../../src/daemon/timeline-emitter.js');

    const sent: Array<Record<string, unknown>> = [];
    const serverLink = { send: (msg: Record<string, unknown>) => { sent.push(msg); }, sendBinary: () => undefined, sendTimelineEvent: () => undefined, daemonVersion: 'perf' };
    // Live ring buffer for the "recent message" case (a real session has recent events in memory).
    const recent: string[] = [];
    for (let i = 0; i < 300; i += 1) recent.push(timelineEmitter.emit(RECENT, 'assistant.text', { text: `recent ${i}`, streaming: false })!.eventId);

    const cases: Record<string, (i: number) => Record<string, unknown>> = {
      // ring buffer hit
      recent: (i) => ({ eventId: recent[i]! }),
      // seeded event older than the newest 5000 (index 100..): not buffered, not in the 5000-event tail read
      older_than_5000: (i) => ({ eventId: `evt_${RECENT.slice(-6)}_${100 + i * 7}`, eventTypes: {} }),
      // one rendered bubble made of 12 stored events (ids from the seeded head of the file)
      merged_block_12: (i) => {
        const ids = Array.from({ length: 12 }, (_, k) => `evt_${RECENT.slice(-6)}_${400 + i * 20 + k}`);
        return { eventId: ids[0], eventIds: ids };
      },
      // an id nobody holds
      unknown_id: (i) => ({ eventId: `evt_missing_${i}` }),
    };

    const results: Record<string, unknown> = {};
    for (const [name, build] of Object.entries(cases)) {
      const latencies: number[] = [];
      const stalls: number[] = [];
      const syncBlocks: number[] = [];
      const outcomes: Record<string, number> = {};
      for (let i = 0; i < ITERATIONS; i += 1) {
        const commandId = `perf-${name}-${i}`;
        const histogram = monitorEventLoopDelay({ resolution: 1 });
        histogram.enable();
        let lastTick = performance.now();
        let worstTick = 0;
        const timer = setInterval(() => { const now = performance.now(); worstTick = Math.max(worstTick, now - lastTick - 2); lastTick = now; }, 2);
        const start = performance.now();
        handleWebCommand({ type: TIMELINE_MESSAGES.DELETE, sessionName: RECENT, commandId, ...build(i) }, serverLink as never);
        // Everything the handler did synchronously before returning is time the daemon's
        // main thread could not run anything else (WS, timers, other sessions).
        syncBlocks.push(performance.now() - start);
        // Let timers run once so a stall the handler caused shows up in the tick lateness too.
        await new Promise((resolve) => setImmediate(resolve));
        // The handler answers with a command.ack; wait for it (bounded).
        let ack: Record<string, unknown> | undefined;
        for (let waited = 0; waited < 20_000 && !ack; waited += 1) {
          ack = sent.find((m) => m.type === 'command.ack' && m.commandId === commandId);
          if (!ack) await new Promise((resolve) => setTimeout(resolve, 1));
        }
        latencies.push(performance.now() - start);
        clearInterval(timer);
        histogram.disable();
        stalls.push(Math.max(worstTick, histogram.max / 1e6));
        const key = ack ? `${String(ack.status)}${ack.error ? `:${String(ack.error)}` : ''}` : 'no_ack';
        outcomes[key] = (outcomes[key] ?? 0) + 1;
      }
      results[name] = { iterations: ITERATIONS, outcomes, latencyMs: { p50: pct(latencies, 50), p99: pct(latencies, 99), max: pct(latencies, 100) }, handlerSyncBlockMs: { p50: pct(syncBlocks, 50), p99: pct(syncBlocks, 99), max: pct(syncBlocks, 100) }, mainThreadStallMs: { p50: pct(stalls, 50), p99: pct(stalls, 99), max: pct(stalls, 100) } };
    }
    writeFileSync(OUT, JSON.stringify({ label: LABEL, home: HOME, results }, null, 2));
    process.stdout.write(`${JSON.stringify({ label: LABEL, results })}\n`);
    if (process.env.PERF_ASSERT === '1') {
      for (const [name, r] of Object.entries(results as Record<string, { latencyMs: { max: number }; outcomes: Record<string, number> }>)) {
        expect(r.latencyMs.max, `${name} max latency`).toBeLessThan(200);
      }
    }
  }, 30 * 60_000);
});
