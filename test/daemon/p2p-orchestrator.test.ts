import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const isDarwin = process.platform === 'darwin';
import { mkdir, readFile, readdir, rm, appendFile, writeFile, utimes, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  sendKeysDelayedEnterMock,
  capturePaneMock,
  sendKeyMock,
  getSessionMock,
  detectStatusMock,
  detectStatusAsyncMock,
  launchTransportSessionMock,
  stopTransportRuntimeSessionMock,
  serverLinkMock,
} = vi.hoisted(() => ({
  sendKeysDelayedEnterMock: vi.fn().mockResolvedValue(undefined),
  capturePaneMock: vi.fn().mockResolvedValue(['$']),
  sendKeyMock: vi.fn().mockResolvedValue(undefined),
  getSessionMock: vi.fn(),
  detectStatusMock: vi.fn().mockReturnValue('idle'),
  detectStatusAsyncMock: vi.fn().mockResolvedValue('idle'),
  launchTransportSessionMock: vi.fn().mockResolvedValue(undefined),
  stopTransportRuntimeSessionMock: vi.fn().mockResolvedValue(undefined),
  serverLinkMock: { send: vi.fn() },
}));

vi.mock('../../src/agent/tmux.js', () => ({
  sendKeysDelayedEnter: sendKeysDelayedEnterMock,
  sendKeys: sendKeysDelayedEnterMock,
  capturePane: capturePaneMock,
  sendKey: sendKeyMock,
}));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
}));

vi.mock('../../src/agent/detect.js', () => ({
  detectStatus: detectStatusMock,
  detectStatusAsync: detectStatusAsyncMock,
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  getTransportRuntime: vi.fn(),
  launchTransportSession: launchTransportSessionMock,
  stopTransportRuntimeSession: stopTransportRuntimeSessionMock,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  startP2pRun,
  cancelP2pRun,
  getP2pRun,
  listP2pRuns,
  notifySessionIdle,
  serializeP2pRun,
  _setFileSettleCycles,
  _setGracePeriodMs,
  _setIdlePollMs,
  _setMinProcessingMs,
  _setRoundHopCleanupDelayMs,
  type P2pRun,
  type P2pRunStatus,
} from '../../src/daemon/p2p-orchestrator.js';

let tempProjectDir: string;

function pathFromPrompt(prompt: string): string {
  const match = prompt.match(/\/\S+?\.md/);
  const extracted = match?.[0];
  if (!extracted) throw new Error(`No file path found in prompt: ${prompt}`);
  return extracted;
}

function headingFromPrompt(prompt: string): string {
  const match = prompt.match(/Add a new heading "## ([^"]+)"/) ?? prompt.match(/under "?## ([^"\n]+)"?/);
  return match?.[1] ?? 'Automated Test Output';
}

async function waitForStatus(runId: string, expected: P2pRunStatus[], maxMs = 10000): Promise<P2pRun> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const run = getP2pRun(runId);
    if (run && expected.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 25));
  }
  const run = getP2pRun(runId);
  if (!run) throw new Error(`Run ${runId} disappeared before reaching ${expected.join(', ')}`);
  throw new Error(`Run ${runId} ended in ${run.status}, expected ${expected.join(', ')}`);
}

async function waitForNoRoundHopArtifacts(projectDir: string, runId: string, maxMs = 1000): Promise<void> {
  const discussionsDir = join(projectDir, '.imc', 'discussions');
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const remainingArtifacts = (await readdir(discussionsDir).catch(() => [] as string[]))
      .filter((name) => name.startsWith(runId) && /\.round\d+\.hop\d+\.md$/.test(name));
    if (remainingArtifacts.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const remainingArtifacts = (await readdir(discussionsDir).catch(() => [] as string[]))
    .filter((name) => name.startsWith(runId) && /\.round\d+\.hop\d+\.md$/.test(name));
  expect(remainingArtifacts).toEqual([]);
}

beforeEach(async () => {
  vi.clearAllMocks();
  _setIdlePollMs(20);
  _setGracePeriodMs(80);
  _setMinProcessingMs(0);
  _setFileSettleCycles(1);
  _setRoundHopCleanupDelayMs(0);

  tempProjectDir = join(tmpdir(), `p2p-par-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(tempProjectDir, { recursive: true });

  getSessionMock.mockImplementation((name: string) => {
    if (name === 'deck_proj_brain') return { agentType: 'claude-code', projectDir: tempProjectDir, parentSession: undefined, label: 'brain' };
    if (name === 'deck_proj_w1') return { agentType: 'claude-code', projectDir: tempProjectDir, parentSession: undefined, label: 'w1' };
    if (name === 'deck_proj_w2') return { agentType: 'claude-code', projectDir: tempProjectDir, parentSession: undefined, label: 'w2' };
    if (name === 'deck_other_w2') return { agentType: 'claude-code', projectDir: join(tempProjectDir, 'other'), parentSession: undefined, label: 'w2x' };
    return null;
  });

  detectStatusMock.mockReturnValue('idle');
  detectStatusAsyncMock.mockResolvedValue('idle');

  sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
    const filePath = pathFromPrompt(prompt);
    const heading = headingFromPrompt(prompt);
    await appendFile(filePath, `\n## ${heading}\n\nOutput from ${session}.\n`, 'utf8');
    setTimeout(() => notifySessionIdle(session), 30);
  });
});

afterEach(async () => {
  // Cancel all active runs BEFORE deleting the temp dir to prevent background
  // async ops (file reads, idle polls) from throwing ENOENT on deleted files.
  await Promise.allSettled(listP2pRuns().map((r) => cancelP2pRun(r.id, serverLinkMock as any)));
  // Brief settle so in-flight promises flush before filesystem cleanup.
  await new Promise((r) => setTimeout(r, 50));

  _setIdlePollMs(3000);
  _setGracePeriodMs(180000);
  _setMinProcessingMs(30000);
  _setFileSettleCycles(3);
  _setRoundHopCleanupDelayMs(0);
  await rm(tempProjectDir, { recursive: true, force: true }).catch(() => {});
});

describe('P2P orchestrator — parallel rounds', () => {

  it('creates round-scoped hop artifact names with run id, round, and hop index', async () => {
    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'artifact naming',
      [],
      serverLinkMock as any,
    );

    const done = await waitForStatus(run.id, ['completed']);
    expect(done.hopStates).toHaveLength(1);
    expect(done.hopStates[0].artifact_path).toContain(`${done.id}.round1.hop1.md`);
  });

  it('removes legacy round hop artifacts after merging them into the main discussion file', async () => {
    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'legacy artifact cleanup',
      [],
      serverLinkMock as any,
    );

    const done = await waitForStatus(run.id, ['completed']);
    await waitForNoRoundHopArtifacts(tempProjectDir, done.id);
  });

  it('keeps legacy single-mode runs on the legacy payload path without advanced fields', async () => {
    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'legacy single mode',
      [],
      serverLinkMock as any,
    );

    const done = await waitForStatus(run.id, ['completed']);
    const payload = serializeP2pRun(done);

    expect(done.advancedP2pEnabled).toBe(false);
    expect(payload.advanced_p2p_enabled).toBeUndefined();
    expect(payload.helper_diagnostics).toBeUndefined();
    expect(payload.all_nodes?.length).toBeGreaterThan(0);
    expect(payload.mode_key).toBe('audit');
    expect(done.completedHops.map((hop) => hop.session)).toEqual(['deck_proj_w1']);
    expect(done.skippedHops).toEqual([]);
    expect(done.remainingTargets).toEqual([]);
  });

  it('preserves legacy combo-mode sequencing without advanced fields', async () => {
    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'brainstorm>discuss' as any }],
      'legacy combo mode',
      [],
      serverLinkMock as any,
      2,
      undefined,
      'brainstorm>discuss',
    );

    const done = await waitForStatus(run.id, ['completed']);
    const comboHops = done.hopStates.filter((hop) => hop.session === 'deck_proj_w1');

    expect(done.advancedP2pEnabled).toBe(false);
    expect(comboHops.map((hop) => hop.round_index)).toEqual([1, 2]);
    expect(comboHops.map((hop) => hop.mode)).toEqual(['brainstorm', 'discuss']);
    expect(done.completedHops.map((hop) => hop.session)).toEqual(['deck_proj_w1', 'deck_proj_w1']);
    expect(done.skippedHops).toEqual([]);
    expect(done.remainingTargets).toEqual([]);
    expect(done.resultSummary).toContain('Final Summary');
  });

  it.skipIf(isDarwin)('cleans stale orphan hop artifacts when a new run starts', async () => {
    const discussionsDir = join(tempProjectDir, '.imc', 'discussions');
    await mkdir(discussionsDir, { recursive: true });
    const orphan = join(discussionsDir, 'orphan.round9.hop9.md');
    await writeFile(orphan, 'stale', 'utf8');
    const old = new Date(Date.now() - (8 * 60 * 60_000));
    await utimes(orphan, old, old);

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'cleanup stale orphan',
      [],
      serverLinkMock as any,
    );

    await waitForStatus(run.id, ['completed']);
    await expect(access(orphan)).rejects.toBeTruthy();
  });
  it.skipIf(isDarwin)('does not delete recent hop artifacts for interrupted runs during orphan cleanup', async () => {
    const discussionsDir = join(tempProjectDir, '.imc', 'discussions');
    await mkdir(discussionsDir, { recursive: true });
    const runId = 'recentrun';
    const artifact = join(discussionsDir, `${runId}.round1.hop1.md`);
    const main = join(discussionsDir, `${runId}.md`);
    await writeFile(artifact, 'artifact', 'utf8');
    await writeFile(main, 'main', 'utf8');
    const old = new Date(Date.now() - (8 * 60 * 60_000));
    await utimes(artifact, old, old);
    await utimes(main, new Date(), new Date());

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'preserve recent interrupted artifacts',
      [],
      serverLinkMock as any,
    );

    await waitForStatus(run.id, ['completed']);
    await expect(access(artifact)).resolves.toBeUndefined();
  });

  it('dispatches phase-2 hops in parallel and waits for the barrier before summary', async () => {
    const events: Array<{ session: string; kind: 'dispatch' | 'idle'; at: number }> = [];

    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      events.push({ session, kind: 'dispatch', at: Date.now() });
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      const delay = session === 'deck_proj_w2' ? 140 : session === 'deck_proj_w1' ? 40 : 20;
      setTimeout(async () => {
        await appendFile(filePath, `\n## ${heading}\n\nOutput from ${session}.\n`, 'utf8');
        events.push({ session, kind: 'idle', at: Date.now() });
        notifySessionIdle(session);
      }, delay);
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [
        { session: 'deck_proj_w1', mode: 'audit' },
        { session: 'deck_proj_w2', mode: 'review' },
      ],
      'review this',
      [],
      serverLinkMock as any,
    );

    const done = await waitForStatus(run.id, ['completed']);
    expect(done.status).toBe('completed');

    const w1Dispatch = events.find((e) => e.session === 'deck_proj_w1' && e.kind === 'dispatch');
    const w2Dispatch = events.find((e) => e.session === 'deck_proj_w2' && e.kind === 'dispatch');
    const summaryDispatch = events.filter((e) => e.session === 'deck_proj_brain' && e.kind === 'dispatch')[1];
    const w2Idle = events.find((e) => e.session === 'deck_proj_w2' && e.kind === 'idle');

    expect(w1Dispatch).toBeDefined();
    expect(w2Dispatch).toBeDefined();
    expect(summaryDispatch).toBeDefined();
    expect(w2Idle).toBeDefined();
    expect(Math.abs((w1Dispatch?.at ?? 0) - (w2Dispatch?.at ?? 0))).toBeLessThan(80);
    expect((summaryDispatch?.at ?? 0)).toBeGreaterThan((w2Idle?.at ?? 0));
  });

  it('retains completed hop evidence with best-effort fallback when exact baseline slicing is not possible', async () => {
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      if (session === 'deck_proj_w1') {
        await writeFile(filePath, `## ${heading}\n\n${'REWRITTEN-FINDING '.repeat(200)}\n`, 'utf8');
      } else {
        await appendFile(filePath, `\n## ${heading}\n\nSUMMARY:${session}\n`, 'utf8');
      }
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'fallback evidence',
      [],
      serverLinkMock as any,
    );

    const done = await waitForStatus(run.id, ['completed']);
    const content = await readFile(done.contextFilePath, 'utf8');
    expect(content).toContain('REWRITTEN-FINDING');
    expect(content).toMatch(/Final Summary|Round 1\/1 Summary/);
  });

  it('collects completed hop evidence into the main file in hop order before summary', async () => {
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      const body = session === 'deck_proj_w1'
        ? 'FIRST-HOP-FINDING'
        : session === 'deck_proj_w2'
          ? 'SECOND-HOP-FINDING'
          : `SUMMARY:${session}`;
      await appendFile(filePath, `\n## ${heading}\n\n${body}\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [
        { session: 'deck_proj_w1', mode: 'audit' },
        { session: 'deck_proj_w2', mode: 'audit' },
      ],
      'collect findings',
      [],
      serverLinkMock as any,
    );

    const done = await waitForStatus(run.id, ['completed']);
    const content = await readFile(done.contextFilePath, 'utf8');
    expect(content).toContain('FIRST-HOP-FINDING');
    expect(content).toContain('SECOND-HOP-FINDING');
    expect(content.indexOf('FIRST-HOP-FINDING')).toBeLessThan(content.indexOf('SECOND-HOP-FINDING'));
    expect(content).toMatch(/Final Summary|Round 1\/1 Summary/);
  });

  it('still enters summary when zero hops complete in a round', async () => {
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      if (session === 'deck_proj_brain') {
        await appendFile(filePath, `\n## ${heading}\n\nEMPTY-EVIDENCE-SUMMARY\n`, 'utf8');
      }
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [
        { session: 'deck_proj_w1', mode: 'audit' },
        { session: 'deck_proj_w2', mode: 'audit' },
      ],
      'zero completed case',
      [],
      serverLinkMock as any,
      1,
      undefined,
      undefined,
      120,
    );

    const done = await waitForStatus(run.id, ['completed']);
    const content = await readFile(done.contextFilePath, 'utf8');
    expect(content).toContain('EMPTY-EVIDENCE-SUMMARY');
    expect(content).not.toContain('deck_proj_w1');
    expect(content).not.toContain('deck_proj_w2');
    expect(done.hopStates.every((h) => h.status !== 'completed')).toBe(true);
    expect(done.summaryPhase).toBe('completed');
  });

  it('completes the discussion when a single hop times out', async () => {
    detectStatusAsyncMock.mockImplementation(async (session: string) => (
      session === 'deck_proj_w1' ? 'running' : 'idle'
    ));
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      if (session === 'deck_proj_w1') return;
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      await appendFile(filePath, `\n## ${heading}\n\nBRAIN-${session}\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'single hop timeout should not fail the run',
      [],
      serverLinkMock as any,
      1,
      undefined,
      undefined,
      120,
    );

    const done = await waitForStatus(run.id, ['completed']);
    expect(done.status).toBe('completed');
    expect(done.hopStates).toHaveLength(1);
    expect(done.hopStates[0].status).toBe('timed_out');
    expect(done.summaryPhase).toBe('completed');
    const content = await readFile(done.contextFilePath, 'utf8');
    expect(content).toContain('BRAIN-deck_proj_brain');
  });

  it('preserves completed evidence and still summarizes on partial hop failure', async () => {
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      if (session === 'deck_proj_w2') {
        setTimeout(() => notifySessionIdle(session), 20);
        return;
      }
      await appendFile(filePath, `\n## ${heading}\n\nSUCCESS-${session}\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [
        { session: 'deck_proj_w1', mode: 'audit' },
        { session: 'deck_proj_w2', mode: 'audit' },
      ],
      'partial failure case',
      [],
      serverLinkMock as any,
      1,
      undefined,
      undefined,
      120,
    );

    const done = await waitForStatus(run.id, ['completed']);
    const content = await readFile(done.contextFilePath, 'utf8');
    expect(content).toContain('SUCCESS-deck_proj_w1');
    expect(content).not.toContain('SUCCESS-deck_proj_w2');

    const payload = serializeP2pRun(done);
    expect(payload.hop_counts?.completed).toBe(1);
    expect(payload.hop_counts?.failed || payload.hop_counts?.timed_out).toBeGreaterThanOrEqual(1);
    expect(payload.summary_phase).toBe('completed');
  });

  it('does not fail the whole run when the initiator goes idle without writing', async () => {
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      if (session === 'deck_proj_brain') {
        setTimeout(() => notifySessionIdle(session), 20);
        return;
      }
      await appendFile(filePath, `\n## ${heading}\n\nSUCCESS-${session}\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'initiator idle without file change should not fail run',
      [],
      serverLinkMock as any,
      1,
      undefined,
      undefined,
      120,
    );

    const done = await waitForStatus(run.id, ['completed']);
    expect(done.status).toBe('completed');
    expect(done.skippedHops).toContain('deck_proj_brain');
    expect(done.hopStates.some((hop) => hop.session === 'deck_proj_w1' && hop.status === 'completed')).toBe(true);
    const content = await readFile(done.contextFilePath, 'utf8');
    expect(content).toContain('SUCCESS-deck_proj_w1');
  });

  it('uses isolated cross-project hop copies and copies completed artifacts back to the main project hop file', async () => {
    await mkdir(join(tempProjectDir, 'other'), { recursive: true });
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') return { agentType: 'claude-code', projectDir: tempProjectDir, parentSession: undefined, label: 'brain' };
      if (name === 'deck_proj_w1') return { agentType: 'claude-code', projectDir: tempProjectDir, parentSession: undefined, label: 'w1' };
      if (name === 'deck_proj_w2') return { agentType: 'claude-code', projectDir: join(tempProjectDir, 'other'), parentSession: undefined, label: 'w2' };
      return null;
    });

    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      await appendFile(filePath, `\n## ${heading}\n\nCROSS-PROJECT-${session}\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w2', mode: 'audit' }],
      'cross project',
      [],
      serverLinkMock as any,
    );

    const done = await waitForStatus(run.id, ['completed']);
    const hop = done.hopStates.find((h) => h.session === 'deck_proj_w2');
    expect(hop).toBeDefined();
    expect(hop?.working_path).toContain(join(tempProjectDir, 'other'));
    expect(hop?.artifact_path).toContain(tempProjectDir);
    await expect(access(hop!.artifact_path)).rejects.toBeTruthy();
    const main = await readFile(done.contextFilePath, 'utf8');
    expect(main).toContain('CROSS-PROJECT-deck_proj_w2');
  });

  it('cancellation preserves completed hop outcomes and cancels unfinished hops', async () => {
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      if (session === 'deck_proj_w1') {
        setTimeout(async () => {
          await appendFile(filePath, `\n## ${heading}\n\nDONE-${session}\n`, 'utf8');
          notifySessionIdle(session);
        }, 20);
        return;
      }
      if (session === 'deck_proj_w2') {
        setTimeout(async () => {
          try { await appendFile(filePath, `\n## ${heading}\n\nLATE-${session}\n`, 'utf8'); } catch {}
        }, 200);
        return;
      }
      await appendFile(filePath, `\n## ${heading}\n\nINIT-${session}\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [
        { session: 'deck_proj_w1', mode: 'audit' },
        { session: 'deck_proj_w2', mode: 'audit' },
      ],
      'cancel case',
      [],
      serverLinkMock as any,
    );

    const start = Date.now();
    while (Date.now() - start < 500 && !run.hopStates.some((h) => h.session === 'deck_proj_w1' && h.status === 'completed')) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const cancelled = await cancelP2pRun(run.id, serverLinkMock as any);
    expect(cancelled).toBe(true);

    await new Promise((r) => setTimeout(r, 80));
    expect(run.status).toBe('cancelled');
    const completedSessions = run.hopStates.filter((h) => h.status === 'completed').map((h) => h.session);
    const cancelledSessions = run.hopStates.filter((h) => h.status === 'cancelled').map((h) => h.session);
    expect(completedSessions).toContain('deck_proj_w1');
    expect(cancelledSessions).toContain('deck_proj_w2');
    expect(sendKeyMock).toHaveBeenCalled();
  });

  it('treats cancel on a terminal run as close and removes it from memory', async () => {
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      if (session === 'deck_proj_w1') return;
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      await appendFile(filePath, `\n## ${heading}\n\nBRAIN-${session}\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'close failed/timed-out p2p',
      [],
      serverLinkMock as any,
      1,
      undefined,
      undefined,
      120,
    );

    await waitForStatus(run.id, ['completed']);
    expect(getP2pRun(run.id)?.status).toBe('completed');

    const closed = await cancelP2pRun(run.id, serverLinkMock as any);
    expect(closed).toBe(true);
    expect(getP2pRun(run.id)).toBeUndefined();
  });

  it('emits additive hop/run payload fields without breaking legacy fields', async () => {
    const run = await startP2pRun(
      'deck_proj_brain',
      [{ session: 'deck_proj_w1', mode: 'audit' }],
      'payload shape',
      [],
      serverLinkMock as any,
    );

    const done = await waitForStatus(run.id, ['completed']);
    const payload = serializeP2pRun(done);

    expect(payload.status).toBe('completed');
    expect(payload.mode_key).toBe('audit');
    expect(payload.active_phase).toBeDefined();
    expect(Array.isArray(payload.all_nodes)).toBe(true);
    expect(Array.isArray(payload.hop_states)).toBe(true);
    expect(payload.run_phase).toBe('completed');
    expect(payload.summary_phase).toBe('completed');
    expect(payload.hop_counts?.completed).toBeGreaterThanOrEqual(1);
  });

  it('preserves the active run phase when an advanced whole-run timeout fires', async () => {
    let runId = '';
    sendKeysDelayedEnterMock.mockImplementationOnce(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      await appendFile(filePath, `\n## ${heading}\n\nSlow output from ${session}.\n`, 'utf8');
      setTimeout(() => {
        const current = getP2pRun(runId);
        if (current) current.deadlineAt = Date.now() - 1;
        notifySessionIdle(session);
      }, 20);
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [],
      userText: 'timeout before final summary',
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRunTimeoutMs: 10,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'single_main',
          permissionScope: 'implementation',
        },
      ],
    });
    runId = run.id;

    const done = await waitForStatus(run.id, ['timed_out'], 15_000);
    const payload = serializeP2pRun(done);

    expect(payload.status).toBe('timed_out');
    expect(payload.run_phase).toBe('round_execution');
    expect(payload.summary_phase).toBeNull();
    expect(payload.error).toContain('advanced_run_timeout');
  }, 20_000);

  it('serializes helper diagnostics only for advanced runs with the documented shape', () => {
    const timestamp = Date.now();
    const run: P2pRun = {
      id: 'run_helper_diag',
      discussionId: 'disc_helper_diag',
      mainSession: 'deck_proj_brain',
      initiatorSession: 'deck_proj_brain',
      currentTargetSession: null,
      finalReturnSession: 'deck_proj_brain',
      remainingTargets: [],
      totalTargets: 0,
      mode: 'plan',
      status: 'running',
      runPhase: 'round_execution',
      summaryPhase: null,
      activePhase: 'hop',
      contextFilePath: '/tmp/run_helper_diag.md',
      userText: 'helper diagnostics payload',
      timeoutMs: 120000,
      resultSummary: null,
      completedHops: [],
      skippedHops: [],
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      rounds: 1,
      currentRound: 1,
      allTargets: [],
      extraPrompt: '',
      hopStartedAt: Date.now(),
      hopStates: [],
      activeTargetSessions: [],
      advancedP2pEnabled: true,
      resolvedRounds: [],
      helperEligibleSnapshot: [],
      contextReducer: undefined,
      advancedRunTimeoutMs: undefined,
      deadlineAt: null,
      currentRoundId: 'implementation',
      currentExecutionStep: 2,
      currentRoundAttempt: 3,
      roundAttemptCounts: { implementation: 3 },
      roundJumpCounts: {},
      routingHistory: [],
      helperDiagnostics: [
        {
          code: 'P2P_HELPER_FALLBACK_FAILED',
          attempt: 3,
          sourceSession: 'deck_sub_helper',
          templateSession: 'deck_proj_brain',
          fallbackSession: 'deck_sub_helper',
          timestamp,
          message: 'fallback session timed out',
        },
      ],
      _cancelled: false,
    };

    const payload = serializeP2pRun(run);

    expect(payload.helper_diagnostics).toEqual([
      {
        code: 'P2P_HELPER_FALLBACK_FAILED',
        attempt: 3,
        sourceSession: 'deck_sub_helper',
        templateSession: 'deck_proj_brain',
        fallbackSession: 'deck_sub_helper',
        timestamp,
        message: 'fallback session timed out',
      },
    ]);

    const legacyPayload = serializeP2pRun({
      ...run,
      id: 'run_helper_diag_legacy',
      advancedP2pEnabled: false,
    });
    expect(legacyPayload.helper_diagnostics).toBeUndefined();
  });

  it('serializes the latest routing step for looped advanced rounds', () => {
    const run: P2pRun = {
      id: 'run_advanced_latest_step',
      discussionId: 'disc_latest_step',
      mainSession: 'deck_proj_brain',
      initiatorSession: 'deck_proj_brain',
      currentTargetSession: null,
      finalReturnSession: 'deck_proj_brain',
      remainingTargets: [],
      totalTargets: 0,
      mode: 'discuss',
      status: 'running',
      runPhase: 'round_execution',
      summaryPhase: null,
      activePhase: 'hop',
      contextFilePath: '/tmp/run_advanced_latest_step.md',
      userText: 'latest step serialization',
      timeoutMs: 120000,
      resultSummary: null,
      completedHops: [],
      skippedHops: [],
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      rounds: 2,
      currentRound: 1,
      allTargets: [],
      extraPrompt: '',
      hopStartedAt: Date.now(),
      hopStates: [],
      activeTargetSessions: [],
      advancedP2pEnabled: true,
      resolvedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'multi_dispatch',
          permissionScope: 'implementation',
          promptSuffix: '',
          timeoutMs: 60_000,
          requiresVerdict: false,
          allowRouting: false,
          jumpRule: null,
          output: { kind: 'discussion_append' },
          helperTask: null,
          modeKey: 'discuss',
          verdictPolicy: 'none',
        },
        {
          id: 'implementation_audit',
          title: 'Implementation Audit',
          preset: 'implementation_audit',
          executionMode: 'single_main',
          permissionScope: 'analysis_only',
          promptSuffix: '',
          timeoutMs: 60_000,
          requiresVerdict: true,
          allowRouting: true,
          jumpRule: {
            targetRoundId: 'implementation',
            marker: 'REWORK',
            minTriggers: 0,
            maxTriggers: 2,
          },
          output: { kind: 'discussion_append' },
          helperTask: null,
          modeKey: 'audit',
          verdictPolicy: 'smart_gate',
        },
      ],
      helperEligibleSnapshot: ['deck_proj_brain'],
      contextReducer: undefined,
      advancedRunTimeoutMs: undefined,
      deadlineAt: null,
      currentRoundId: 'implementation',
      currentExecutionStep: 5,
      currentRoundAttempt: 3,
      roundAttemptCounts: {
        implementation: 3,
        implementation_audit: 2,
      },
      roundJumpCounts: {
        implementation_audit: 2,
      },
      routingHistory: [
        {
          fromRoundId: 'implementation_audit',
          toRoundId: 'implementation',
          trigger: 'REWORK',
          atStep: 3,
          atAttempt: 1,
          timestamp: 1,
        },
        {
          fromRoundId: 'implementation_audit',
          toRoundId: 'implementation',
          trigger: 'REWORK',
          atStep: 5,
          atAttempt: 2,
          timestamp: 2,
        },
      ],
      helperDiagnostics: [],
      _cancelled: false,
    };

    const payload = serializeP2pRun(run);

    expect(payload.advanced_nodes?.find((node) => node.id === 'implementation')).toMatchObject({
      attempt: 3,
      step: 5,
    });
  });

  it('projects all active hops into all_nodes for parallel round progress', () => {
    const run: P2pRun = {
      id: 'run_parallel',
      discussionId: 'disc_parallel',
      mainSession: 'deck_proj_brain',
      initiatorSession: 'deck_proj_brain',
      currentTargetSession: 'deck_proj_w1',
      finalReturnSession: 'deck_proj_brain',
      remainingTargets: [
        { session: 'deck_proj_w1', mode: 'audit' },
        { session: 'deck_proj_w2', mode: 'review' },
      ],
      totalTargets: 2,
      mode: 'discuss',
      status: 'running',
      runPhase: 'round_execution',
      summaryPhase: null,
      activePhase: 'hop',
      contextFilePath: '/tmp/run_parallel.md',
      userText: 'parallel progress',
      timeoutMs: 120000,
      resultSummary: null,
      completedHops: [],
      skippedHops: [],
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      rounds: 1,
      currentRound: 1,
      allTargets: [
        { session: 'deck_proj_w1', mode: 'audit' },
        { session: 'deck_proj_w2', mode: 'review' },
      ],
      extraPrompt: '',
      hopStartedAt: Date.now(),
      hopStates: [
        {
          hop_index: 1,
          round_index: 1,
          session: 'deck_proj_w1',
          mode: 'audit',
          status: 'running',
          started_at: Date.now(),
          completed_at: null,
          error: null,
          output_path: null,
          section_header: 'W1',
          artifact_path: '/tmp/run_parallel.round1.hop1.md',
          working_path: null,
          baseline_size: 0,
          baseline_content: '',
        },
        {
          hop_index: 2,
          round_index: 1,
          session: 'deck_proj_w2',
          mode: 'review',
          status: 'dispatched',
          started_at: Date.now(),
          completed_at: null,
          error: null,
          output_path: null,
          section_header: 'W2',
          artifact_path: '/tmp/run_parallel.round1.hop2.md',
          working_path: null,
          baseline_size: 0,
          baseline_content: '',
        },
      ],
      activeTargetSessions: ['deck_proj_w1', 'deck_proj_w2'],
      _cancelled: false,
    };

    const payload = serializeP2pRun(run);
    const activeNodes = payload.all_nodes?.filter((node) => node.phase === 'hop' && node.status === 'active') ?? [];
    const pendingNodes = payload.all_nodes?.filter((node) => node.phase === 'hop' && node.status === 'pending') ?? [];

    expect(activeNodes.map((node) => node.session)).toEqual(['deck_proj_w1', 'deck_proj_w2']);
    expect(pendingNodes).toHaveLength(0);
    expect(payload.current_target_session).toBe('deck_proj_w1');
    expect(payload.active_hop_number).toBe(1);
  });

  it('falls back to an sdk child helper when the primary reducer session fails', async () => {
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'brain' };
      if (name === 'deck_sub_helper') return { agentType: 'qwen', projectDir: tempProjectDir, parentSession: 'deck_proj_brain', label: 'helper' };
      return null;
    });

    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      if (prompt.includes('[P2P Helper Task') && session === 'deck_proj_brain') {
        throw new Error('primary reducer unavailable');
      }
      const filePath = [...prompt.matchAll(/\/\S+?\.md/g)].at(-1)?.[0] ?? pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      await appendFile(filePath, `\n## ${heading}\n\nOutput from ${session}.\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [{ session: 'deck_sub_helper', mode: 'audit' }],
      userText: 'x'.repeat(40_000),
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'single_main',
          permissionScope: 'implementation',
        },
      ],
      contextReducer: {
        mode: 'reuse_existing_session',
        sessionName: 'deck_proj_brain',
      },
    });

    const done = await waitForStatus(run.id, ['completed'], 15_000);
    expect(done.status).toBe('completed');
    expect(done.helperEligibleSnapshot).toEqual([
      { sessionName: 'deck_proj_brain', agentType: 'claude-code-sdk', parentSession: null },
      { sessionName: 'deck_sub_helper', agentType: 'qwen', parentSession: 'deck_proj_brain' },
    ]);
    expect(done.helperDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'P2P_HELPER_PRIMARY_FAILED',
        sourceSession: 'deck_proj_brain',
      }),
    ]));
    const reducerPath = join(tempProjectDir, '.imc', 'discussions', `${done.id}.reducer.1.md`);
    await expect(access(reducerPath)).rejects.toThrow();
    expect(done.error).toBeNull();
  }, 15_000);

  it('cleans up clone-mode temporary sdk helper sessions after reducer use', async () => {
    let helperName: string | null = null;
    launchTransportSessionMock.mockImplementation(async (opts: any) => {
      helperName = opts.name;
    });
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') {
        return {
          agentType: 'claude-code-sdk',
          runtimeType: 'transport',
          projectDir: tempProjectDir,
          projectName: 'proj',
          parentSession: undefined,
          label: 'brain',
          requestedModel: 'claude-sonnet',
          transportConfig: { source: 'test' },
        };
      }
      if (helperName && name === helperName) {
        return {
          agentType: 'claude-code-sdk',
          runtimeType: 'transport',
          projectDir: tempProjectDir,
          projectName: 'proj',
          parentSession: 'deck_proj_brain',
          label: helperName,
          requestedModel: 'claude-sonnet',
          transportConfig: { source: 'test' },
        };
      }
      return null;
    });

    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = [...prompt.matchAll(/\/\S+?\.md/g)].at(-1)?.[0] ?? pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      await appendFile(filePath, `\n## ${heading}\n\nOutput from ${session}.\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [],
      userText: `clone sdk helper cleanup ${'x'.repeat(40_000)}`,
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'single_main',
          permissionScope: 'implementation',
        },
      ],
      contextReducer: {
        mode: 'clone_sdk_session',
        templateSession: 'deck_proj_brain',
      },
    });

    const done = await waitForStatus(run.id, ['completed'], 15_000);
    expect(done.status).toBe('completed');
    expect(launchTransportSessionMock).toHaveBeenCalledTimes(1);
    expect(stopTransportRuntimeSessionMock).toHaveBeenCalledWith(helperName);
  }, 20_000);

  it('fails the run when both the primary reducer path and fallback child fail', async () => {
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'brain' };
      if (name === 'deck_sub_helper') return { agentType: 'qwen', projectDir: tempProjectDir, parentSession: 'deck_proj_brain', label: 'helper' };
      return null;
    });

    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      if (prompt.includes('[P2P Helper Task')) {
        throw new Error(`helper failed for ${session}`);
      }
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      await appendFile(filePath, `\n## ${heading}\n\nOutput from ${session}.\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [{ session: 'deck_sub_helper', mode: 'audit' }],
      userText: 'x'.repeat(40_000),
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'single_main',
          permissionScope: 'implementation',
        },
      ],
      contextReducer: {
        mode: 'reuse_existing_session',
        sessionName: 'deck_proj_brain',
      },
    });

    const done = await waitForStatus(run.id, ['failed'], 15_000);
    expect(done.error).toContain('helper_fallback_failed:deck_sub_helper');
    expect(done.helperDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'P2P_HELPER_PRIMARY_FAILED', sourceSession: 'deck_proj_brain' }),
      expect.objectContaining({ code: 'P2P_HELPER_FALLBACK_FAILED', sourceSession: 'deck_sub_helper' }),
    ]));
  }, 20_000);

  it('filters cli participants out of the advanced helper snapshot stored on the run', async () => {
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'brain' };
      if (name === 'deck_sub_helper') return { agentType: 'qwen', projectDir: tempProjectDir, parentSession: 'deck_proj_brain', label: 'helper' };
      if (name === 'deck_proj_cli') return { agentType: 'codex', projectDir: tempProjectDir, parentSession: undefined, label: 'cli' };
      return null;
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [
        { session: 'deck_sub_helper', mode: 'audit' },
        { session: 'deck_proj_cli', mode: 'review' },
      ],
      userText: 'helper snapshot should stay sdk-only',
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'single_main',
          permissionScope: 'implementation',
        },
      ],
      contextReducer: {
        mode: 'clone_sdk_session',
        templateSession: 'deck_proj_brain',
      },
    });

    expect(run.helperEligibleSnapshot).toEqual([
      { sessionName: 'deck_proj_brain', agentType: 'claude-code-sdk', parentSession: null },
      { sessionName: 'deck_sub_helper', agentType: 'qwen', parentSession: 'deck_proj_brain' },
    ]);

    await cancelP2pRun(run.id, serverLinkMock as any);
  });

  it('fails before creating a run when advanced config is rejected by the resolver', async () => {
    const beforeIds = listP2pRuns().map((run) => run.id);

    await expect(startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [],
      userText: 'invalid advanced config should not start',
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'single_main',
          permissionScope: 'implementation',
        },
        {
          id: 'implementation_audit',
          title: 'Implementation Audit',
          preset: 'implementation_audit',
          executionMode: 'single_main',
          permissionScope: 'analysis_only',
          verdictPolicy: 'smart_gate',
          jumpRule: {
            targetRoundId: 'implementation_audit',
            marker: 'REWORK',
            minTriggers: 0,
            maxTriggers: 2,
          },
        },
      ],
    })).rejects.toThrow(/jump backward/i);

    expect(listP2pRuns().map((run) => run.id)).toEqual(beforeIds);
  });

  it('launches and tears down clone-mode helper sessions', async () => {
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') return {
        agentType: 'claude-code-sdk',
        runtimeType: 'transport',
        projectDir: tempProjectDir,
        parentSession: undefined,
        label: 'brain',
        projectName: 'proj',
        requestedModel: 'claude-sonnet',
        activeModel: 'claude-sonnet',
        transportConfig: { baseUrl: 'http://localhost:1234' },
        effort: 'high',
      };
      if (name === 'deck_sub_helper') return { agentType: 'qwen', projectDir: tempProjectDir, parentSession: 'deck_proj_brain', label: 'helper' };
      return null;
    });

    let helperSessionName = '';
    launchTransportSessionMock.mockImplementation(async (opts: any) => {
      helperSessionName = opts.name;
      return undefined;
    });

    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = [...prompt.matchAll(/\/\S+?\.md/g)].at(-1)?.[0] ?? pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      await appendFile(filePath, `\n## ${heading}\n\nOutput from ${session}.\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [{ session: 'deck_sub_helper', mode: 'audit' }],
      userText: 'x'.repeat(40_000),
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'single_main',
          permissionScope: 'implementation',
        },
      ],
      contextReducer: {
        mode: 'clone_sdk_session',
        templateSession: 'deck_proj_brain',
      },
    });

    const done = await waitForStatus(run.id, ['completed'], 15_000);
    expect(done.status).toBe('completed');
    expect(launchTransportSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      agentType: 'claude-code-sdk',
      projectDir: tempProjectDir,
      requestedModel: 'claude-sonnet',
      transportConfig: { baseUrl: 'http://localhost:1234' },
      skipStore: true,
      fresh: true,
    }));
    expect(stopTransportRuntimeSessionMock).toHaveBeenCalledWith(helperSessionName);
  }, 15_000);

  it('treats missing advanced audit verdicts as rework and records jump history', async () => {
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'brain' };
      return null;
    });

    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      const body = heading.includes('Implementation Audit')
        ? 'Audit completed without verdict marker.'
        : `Output from ${session}.`;
      await appendFile(filePath, `\n## ${heading}\n\n${body}\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [],
      userText: 'loop until the audit stabilizes',
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'single_main',
          permissionScope: 'implementation',
        },
        {
          id: 'implementation_audit',
          title: 'Implementation Audit',
          preset: 'implementation_audit',
          executionMode: 'single_main',
          permissionScope: 'analysis_only',
          verdictPolicy: 'smart_gate',
          jumpRule: {
            targetRoundId: 'implementation',
            marker: 'REWORK',
            minTriggers: 0,
            maxTriggers: 2,
          },
        },
      ],
    });

    const done = await waitForStatus(run.id, ['completed'], 15_000);
    expect(done.status).toBe('completed');
    expect(done.roundJumpCounts.implementation_audit).toBe(2);
    expect(done.routingHistory).toHaveLength(2);
    expect(done.helperDiagnostics.filter((entry) => entry.code === 'P2P_VERDICT_MISSING').length).toBeGreaterThanOrEqual(1);
    expect(done.resultSummary).toContain('Final Summary');
  });

  it('forces the minimum rework loops before handing off to smart-gate evaluation', async () => {
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'brain' };
      return null;
    });

    let auditCount = 0;
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      let body = `Output from ${session}.`;
      if (heading.includes('Implementation Audit')) {
        auditCount += 1;
        body = `Audit pass ${auditCount}.\n<!-- P2P_VERDICT: PASS -->`;
      }
      await appendFile(filePath, `\n## ${heading}\n\n${body}\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [],
      userText: 'forced rework should ignore PASS until minTriggers is satisfied',
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'single_main',
          permissionScope: 'implementation',
        },
        {
          id: 'implementation_audit',
          title: 'Implementation Audit',
          preset: 'implementation_audit',
          executionMode: 'single_main',
          permissionScope: 'analysis_only',
          verdictPolicy: 'forced_rework',
          jumpRule: {
            targetRoundId: 'implementation',
            marker: 'REWORK',
            minTriggers: 2,
            maxTriggers: 3,
          },
        },
      ],
    });

    const done = await waitForStatus(run.id, ['completed'], 15_000);
    expect(done.status).toBe('completed');
    expect(auditCount).toBe(3);
    expect(done.roundJumpCounts.implementation_audit).toBe(2);
    expect(done.routingHistory).toHaveLength(2);
    expect(done.routingHistory.every((entry) => entry.trigger === 'PASS')).toBe(true);
  });

  it('hands off forced_rework rounds to smart-gate behavior after minTriggers is satisfied', async () => {
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'brain' };
      return null;
    });

    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      const body = heading.includes('Implementation Audit')
        ? '<!-- P2P_VERDICT: PASS -->\nAudit says pass.'
        : `Implementation output ${session}.`;
      await appendFile(filePath, `\n## ${heading}\n\n${body}\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [],
      userText: 'forced rework should stop looping once the minimum rework count is satisfied and audit passes',
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'single_main',
          permissionScope: 'implementation',
        },
        {
          id: 'implementation_audit',
          title: 'Implementation Audit',
          preset: 'implementation_audit',
          executionMode: 'single_main',
          permissionScope: 'analysis_only',
          verdictPolicy: 'forced_rework',
          jumpRule: {
            targetRoundId: 'implementation',
            marker: 'REWORK',
            minTriggers: 2,
            maxTriggers: 4,
          },
        },
      ],
    });

    const done = await waitForStatus(run.id, ['completed'], 15_000);
    expect(done.status).toBe('completed');
    expect(done.roundAttemptCounts.implementation).toBe(3);
    expect(done.roundAttemptCounts.implementation_audit).toBe(3);
    expect(done.roundJumpCounts.implementation_audit).toBe(2);
    expect(done.routingHistory).toHaveLength(2);
  }, 20_000);

  it('continues forced_rework routing on REWORK after minTriggers until maxTriggers is exhausted', async () => {
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'brain' };
      return null;
    });

    let auditCount = 0;
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      let body = `Implementation output ${session}.`;
      if (heading.includes('Implementation Audit')) {
        auditCount += 1;
        body = `Audit says rework ${auditCount}.\n<!-- P2P_VERDICT: REWORK -->`;
      }
      await appendFile(filePath, `\n## ${heading}\n\n${body}\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [],
      userText: 'keep reworking until the forced loop budget is exhausted',
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'single_main',
          permissionScope: 'implementation',
        },
        {
          id: 'implementation_audit',
          title: 'Implementation Audit',
          preset: 'implementation_audit',
          executionMode: 'single_main',
          permissionScope: 'analysis_only',
          verdictPolicy: 'forced_rework',
          jumpRule: {
            targetRoundId: 'implementation',
            marker: 'REWORK',
            minTriggers: 1,
            maxTriggers: 2,
          },
        },
      ],
    });

    const done = await waitForStatus(run.id, ['completed'], 15_000);
    expect(done.status).toBe('completed');
    expect(auditCount).toBe(3);
    expect(done.roundAttemptCounts.implementation).toBe(3);
    expect(done.roundAttemptCounts.implementation_audit).toBe(3);
    expect(done.roundJumpCounts.implementation_audit).toBe(2);
    expect(done.routingHistory).toHaveLength(2);
    expect(done.routingHistory.every((entry) => entry.trigger === 'REWORK')).toBe(true);
  }, 20_000);

  it('uses initiator synthesis as the authoritative verdict source for multi-dispatch audit rounds', async () => {
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'brain' };
      if (name === 'deck_proj_w1') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'w1' };
      return null;
    });

    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      let body = `Output from ${session}.`;
      if (heading.includes('Implementation Audit Synthesis')) {
        body = 'Synthesis accepts the implementation.\n<!-- P2P_VERDICT: PASS -->';
      } else if (heading.includes('Implementation Audit (hop')) {
        body = 'Worker thinks this still needs work.\n<!-- P2P_VERDICT: REWORK -->';
      }
      await appendFile(filePath, `\n## ${heading}\n\n${body}\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [{ session: 'deck_proj_w1', mode: 'audit' }],
      userText: 'worker verdicts must not override synthesis',
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'single_main',
          permissionScope: 'implementation',
        },
        {
          id: 'implementation_audit',
          title: 'Implementation Audit',
          preset: 'implementation_audit',
          executionMode: 'multi_dispatch',
          permissionScope: 'analysis_only',
          verdictPolicy: 'smart_gate',
          jumpRule: {
            targetRoundId: 'implementation',
            marker: 'REWORK',
            minTriggers: 0,
            maxTriggers: 2,
          },
        },
      ],
    });

    const done = await waitForStatus(run.id, ['completed'], 15_000);
    expect(done.status).toBe('completed');
    expect(done.routingHistory).toEqual([]);
    expect(done.roundJumpCounts.implementation_audit).toBeUndefined();
  }, 20_000);

  it('rejects invalid advanced configs before creating or running a daemon run', async () => {
    await expect(startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [],
      userText: 'invalid advanced config',
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'single_main',
          permissionScope: 'implementation',
        },
        {
          id: 'implementation_audit',
          title: 'Implementation Audit',
          preset: 'implementation_audit',
          executionMode: 'single_main',
          permissionScope: 'analysis_only',
          verdictPolicy: 'smart_gate',
          jumpRule: {
            targetRoundId: 'missing_round',
            marker: 'REWORK',
            minTriggers: 0,
            maxTriggers: 1,
          },
        },
      ],
    })).rejects.toThrow(/unknown target/i);

    expect(listP2pRuns()).toHaveLength(0);
    expect(serverLinkMock.send).not.toHaveBeenCalled();
  });

  it('times out if the whole-run deadline expires during final summary dispatch', async () => {
    let activeRunId = '';
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      await appendFile(filePath, `\n## ${heading}\n\nOutput from ${session}.\n`, 'utf8');
      if (heading.includes('Final Summary')) {
        setTimeout(() => {
          const current = getP2pRun(activeRunId);
          if (current) current.deadlineAt = Date.now() - 1;
        }, 0);
        setTimeout(() => {
          const current = getP2pRun(activeRunId);
          if (current) current.deadlineAt = Date.now() - 1;
          notifySessionIdle(session);
        }, 50);
        return;
      }
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [],
      userText: 'summary timeout boundary',
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRunTimeoutMs: 60_000,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'single_main',
          permissionScope: 'implementation',
        },
      ],
    });
    activeRunId = run.id;

    const done = await waitForStatus(run.id, ['timed_out'], 15_000);
    const payload = serializeP2pRun(done);

    expect(payload.status).toBe('timed_out');
    expect(payload.run_phase).toBe('summarizing');
    expect(payload.summary_phase).toBe('failed');
    expect(payload.error).toContain('advanced_run_timeout');
  }, 20_000);

  it('fails artifact_generation rounds when declared outputs are left stale', async () => {
    const stalePath = join(tempProjectDir, 'docs', 'plan.md');
    await mkdir(join(tempProjectDir, 'docs'), { recursive: true });
    await writeFile(stalePath, 'stale artifact\n', 'utf8');

    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      await appendFile(filePath, `\n## ${heading}\n\nOutput from ${session}.\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [],
      userText: 'artifact round must update the file',
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRounds: [
        {
          id: 'custom_artifact',
          title: 'Custom Artifact',
          preset: 'custom',
          executionMode: 'single_main',
          permissionScope: 'artifact_generation',
          artifactOutputs: ['docs/plan.md'],
        },
      ],
    });

    const done = await waitForStatus(run.id, ['failed'], 15_000);
    expect(done.error).toContain('Expected artifact not observably updated');
    expect(done.error).toContain('docs/plan.md');
  }, 20_000);

  it('completes the openspec preset after proposal artifacts are created and audit eventually passes', async () => {
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'brain' };
      if (name === 'deck_proj_w1') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'w1' };
      return null;
    });

    let auditCount = 0;
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      let body = `Output from ${session}.`;
      if (heading.includes('OpenSpec Propose')) {
        const changeDir = join(tempProjectDir, 'openspec', 'changes', 'smart-p2p-upgrade-e2e');
        await mkdir(join(changeDir, 'specs', 'smart-p2p-rounds'), { recursive: true });
        await writeFile(join(changeDir, 'proposal.md'), '# proposal\n', 'utf8');
        await writeFile(join(changeDir, 'design.md'), '# design\n', 'utf8');
        await writeFile(join(changeDir, 'tasks.md'), '# tasks\n', 'utf8');
        await writeFile(join(changeDir, 'specs', 'smart-p2p-rounds', 'spec.md'), '# spec\n', 'utf8');
        body = 'OpenSpec artifacts written.';
      } else if (heading.includes('Implementation Audit Synthesis') || heading.includes('Implementation Audit')) {
        auditCount += 1;
        body = auditCount === 1
          ? 'Audit requests another pass.\n<!-- P2P_VERDICT: REWORK -->'
          : 'Audit accepts the implementation.\n<!-- P2P_VERDICT: PASS -->';
      }
      await appendFile(filePath, `\n## ${heading}\n\n${body}\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [{ session: 'deck_proj_w1', mode: 'audit' }],
      userText: 'run the openspec preset end to end',
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedPresetKey: 'openspec',
    });

    const done = await waitForStatus(run.id, ['completed'], 20_000);
    expect(done.status).toBe('completed');
    expect(auditCount).toBe(2);
    expect(done.roundJumpCounts.implementation_audit).toBe(1);
    await expect(access(join(tempProjectDir, 'openspec', 'changes', 'smart-p2p-upgrade-e2e', 'proposal.md'))).resolves.toBeUndefined();
  }, 25_000);

  it('cleans up loop-generated hop artifacts after repeated advanced attempts settle', async () => {
    _setRoundHopCleanupDelayMs(20);

    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'brain' };
      if (name === 'deck_proj_w1') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'w1' };
      return null;
    });

    let auditCount = 0;
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      let body = `Output from ${session}.`;
      if (heading.includes('Implementation Audit')) {
        auditCount += 1;
        body = auditCount < 3
          ? `Audit iteration ${auditCount}.\n<!-- P2P_VERDICT: REWORK -->`
          : 'Audit accepts the latest attempt.\n<!-- P2P_VERDICT: PASS -->';
      }
      await appendFile(filePath, `\n## ${heading}\n\n${body}\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [{ session: 'deck_proj_w1', mode: 'audit' }],
      userText: 'loop cleanup regression',
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'multi_dispatch',
          permissionScope: 'implementation',
        },
        {
          id: 'implementation_audit',
          title: 'Implementation Audit',
          preset: 'implementation_audit',
          executionMode: 'single_main',
          permissionScope: 'analysis_only',
          verdictPolicy: 'smart_gate',
          jumpRule: {
            targetRoundId: 'implementation',
            marker: 'REWORK',
            minTriggers: 0,
            maxTriggers: 3,
          },
        },
      ],
    });

    const done = await waitForStatus(run.id, ['completed'], 20_000);
    expect(done.roundJumpCounts.implementation_audit).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 120));

    const discussionsDir = join(tempProjectDir, '.imc', 'discussions');
    const files = await readdir(discussionsDir);
    expect(files).toContain(`${done.id}.md`);
    expect(files.filter((file) => file.includes('.round'))).toEqual([]);
  }, 25_000);

  it('applies per-round timeout budgets for advanced rounds', async () => {
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      await appendFile(filePath, `\n## ${heading}\n\nSlow output from ${session}.\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 50);
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [],
      userText: 'per-round timeout should override the default hop timeout',
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRunTimeoutMs: 60_000,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'single_main',
          permissionScope: 'implementation',
          timeoutMinutes: 0,
        },
      ],
    });

    const done = await waitForStatus(run.id, ['timed_out'], 15_000);
    expect(done.status).toBe('timed_out');
    expect(done.runPhase).toBe('round_execution');
    expect(done.error).toContain('timed_out');
  }, 20_000);

  it('initializes advanced runs with deterministic bookkeeping fields', async () => {
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'brain' };
      if (name === 'deck_sub_helper') return { agentType: 'qwen', projectDir: tempProjectDir, parentSession: 'deck_proj_brain', label: 'helper' };
      return null;
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [{ session: 'deck_sub_helper', mode: 'audit' }],
      userText: 'bookkeeping init',
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedPresetKey: 'openspec',
      contextReducer: {
        mode: 'clone_sdk_session',
        templateSession: 'deck_proj_brain',
      },
      advancedRunTimeoutMs: 120_000,
    });

    expect(run.advancedP2pEnabled).toBe(true);
    expect(run.currentRoundId).toBe('discussion');
    expect(run.currentExecutionStep).toBe(1);
    expect(run.currentRoundAttempt).toBe(1);
    expect(run.roundAttemptCounts).toEqual({ discussion: 1 });
    expect(run.roundJumpCounts).toEqual({});
    expect(run.routingHistory).toEqual([]);
    expect(run.helperEligibleSnapshot).toEqual([
      { sessionName: 'deck_proj_brain', agentType: 'claude-code-sdk', parentSession: null },
      { sessionName: 'deck_sub_helper', agentType: 'qwen', parentSession: 'deck_proj_brain' },
    ]);
    expect(run.deadlineAt).toBeTypeOf('number');
    expect(run.deadlineAt).toBeGreaterThan(Date.now());

    await cancelP2pRun(run.id, serverLinkMock as any);
  });

  it('keeps advanced loop bookkeeping deterministic while legacy projections remain compatibility-only', async () => {
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'brain' };
      if (name === 'deck_proj_w1') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'w1' };
      return null;
    });

    let auditCount = 0;
    let finalSummaryCount = 0;
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      let body = `Output from ${session}.`;
      if (heading.includes('Implementation Audit')) {
        auditCount += 1;
        body = auditCount === 1
          ? 'Needs one more pass.\n<!-- P2P_VERDICT: REWORK -->'
          : 'Looks good now.\n<!-- P2P_VERDICT: PASS -->';
      }
      if (heading.includes('Final Summary')) finalSummaryCount += 1;
      await appendFile(filePath, `\n## ${heading}\n\n${body}\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [{ session: 'deck_proj_w1', mode: 'audit' }],
      userText: 'compatibility bookkeeping under loop-back',
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'multi_dispatch',
          permissionScope: 'implementation',
        },
        {
          id: 'implementation_audit',
          title: 'Implementation Audit',
          preset: 'implementation_audit',
          executionMode: 'single_main',
          permissionScope: 'analysis_only',
          verdictPolicy: 'smart_gate',
          jumpRule: {
            targetRoundId: 'implementation',
            marker: 'REWORK',
            minTriggers: 0,
            maxTriggers: 2,
          },
        },
      ],
    });

    const done = await waitForStatus(run.id, ['completed'], 20_000);
    const payload = serializeP2pRun(done);

    expect(finalSummaryCount).toBe(1);
    expect(done.roundAttemptCounts).toMatchObject({
      implementation: 2,
      implementation_audit: 2,
    });
    expect(done.currentExecutionStep).toBe(4);
    expect(done.routingHistory).toHaveLength(1);
    expect(done.remainingTargets).toEqual([]);
    expect(payload.remaining_count).toBe(0);
    expect(payload.completed_hops_count).toBe(1);
    expect(payload.hop_counts?.completed).toBe(1);
    expect(payload.advanced_p2p_enabled).toBe(true);
    expect(payload.advanced_nodes?.find((node) => node.id === 'implementation')?.attempt).toBe(2);
    expect(payload.all_nodes?.length).toBeGreaterThan(0);
  }, 25_000);

  it('injects reducer summaries into later loop prompts and keeps the helper prompt focused on the latest attempt context', async () => {
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'brain' };
      return null;
    });

    const helperPrompts: string[] = [];
    const implementationPrompts: string[] = [];
    let auditCount = 0;
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const helperPath = [...prompt.matchAll(/\/\S+?\.md/g)].at(-1)?.[0];
      const heading = headingFromPrompt(prompt);
      if (prompt.includes('[P2P Helper Task')) {
        helperPrompts.push(prompt);
        if (!helperPath) throw new Error('missing helper summary path');
        await appendFile(helperPath, `\n## ${heading}\n\nREDUCED-CONTEXT-LATEST\n`, 'utf8');
        setTimeout(() => notifySessionIdle(session), 20);
        return;
      }
      if (heading.includes('Implementation (attempt')) implementationPrompts.push(prompt);
      const filePath = pathFromPrompt(prompt);
      let body = `Output from ${session}.`;
      if (heading.includes('Implementation Audit')) {
        auditCount += 1;
        body = auditCount === 1
          ? 'Try once more.\n<!-- P2P_VERDICT: REWORK -->'
          : 'Pass now.\n<!-- P2P_VERDICT: PASS -->';
      }
      await appendFile(filePath, `\n## ${heading}\n\n${body}\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [],
      userText: `latest-attempt reducer focus ${'x'.repeat(40_000)}`,
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'single_main',
          permissionScope: 'implementation',
        },
        {
          id: 'implementation_audit',
          title: 'Implementation Audit',
          preset: 'implementation_audit',
          executionMode: 'single_main',
          permissionScope: 'analysis_only',
          verdictPolicy: 'smart_gate',
          jumpRule: {
            targetRoundId: 'implementation',
            marker: 'REWORK',
            minTriggers: 0,
            maxTriggers: 2,
          },
        },
      ],
      contextReducer: {
        mode: 'reuse_existing_session',
        sessionName: 'deck_proj_brain',
      },
    });

    const done = await waitForStatus(run.id, ['completed'], 20_000);
    expect(done.status).toBe('completed');
    expect(helperPrompts.length).toBeGreaterThan(0);
    expect(helperPrompts[0]).toContain('Focus on: latest implementation attempt, latest audit findings, declared artifact targets');
    const laterImplementationPrompt = implementationPrompts.find((entry) => entry.includes('attempt 2'));
    expect(laterImplementationPrompt).toContain('Reduced context for this attempt:');
    expect(laterImplementationPrompt).toContain('REDUCED-CONTEXT-LATEST');
  }, 25_000);

  it('cleans worker-hop artifacts after repeated loop attempts', async () => {
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'brain' };
      if (name === 'deck_proj_w1') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'w1' };
      return null;
    });

    let auditCount = 0;
    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      let body = `Output from ${session}.`;
      if (heading.includes('Implementation Audit')) {
        auditCount += 1;
        body = auditCount < 3
          ? `Needs more work ${auditCount}.\n<!-- P2P_VERDICT: REWORK -->`
          : 'Approved.\n<!-- P2P_VERDICT: PASS -->';
      }
      await appendFile(filePath, `\n## ${heading}\n\n${body}\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [{ session: 'deck_proj_w1', mode: 'audit' }],
      userText: 'artifact cleanup across repeated loop attempts',
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'multi_dispatch',
          permissionScope: 'implementation',
        },
        {
          id: 'implementation_audit',
          title: 'Implementation Audit',
          preset: 'implementation_audit',
          executionMode: 'single_main',
          permissionScope: 'analysis_only',
          verdictPolicy: 'smart_gate',
          jumpRule: {
            targetRoundId: 'implementation',
            marker: 'REWORK',
            minTriggers: 0,
            maxTriggers: 3,
          },
        },
      ],
    });

    const done = await waitForStatus(run.id, ['completed'], 25_000);
    expect(done.roundAttemptCounts.implementation).toBe(3);
    await waitForNoRoundHopArtifacts(tempProjectDir, done.id);
  }, 30_000);

  it('cleans worker-hop artifacts even when advanced synthesis fails before the run completes', async () => {
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'brain' };
      if (name === 'deck_proj_w1') return { agentType: 'claude-code-sdk', projectDir: tempProjectDir, parentSession: undefined, label: 'w1' };
      return null;
    });

    sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
      const filePath = pathFromPrompt(prompt);
      const heading = headingFromPrompt(prompt);
      if (heading.includes('Implementation Synthesis')) {
        throw new Error('synthesis unavailable');
      }
      await appendFile(filePath, `\n## ${heading}\n\nOutput from ${session}.\n`, 'utf8');
      setTimeout(() => notifySessionIdle(session), 20);
    });

    const run = await startP2pRun({
      initiatorSession: 'deck_proj_brain',
      targets: [{ session: 'deck_proj_w1', mode: 'audit' }],
      userText: 'cleanup worker artifacts on synthesis failure',
      fileContents: [],
      serverLink: serverLinkMock as any,
      advancedRounds: [
        {
          id: 'implementation',
          title: 'Implementation',
          preset: 'implementation',
          executionMode: 'multi_dispatch',
          permissionScope: 'implementation',
        },
      ],
    });

    const done = await waitForStatus(run.id, ['failed'], 20_000);
    expect(done.error).toContain('synthesis unavailable');
    await waitForNoRoundHopArtifacts(tempProjectDir, done.id);
  }, 25_000);
});
