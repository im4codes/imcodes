import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const isDarwin = process.platform === 'darwin';
import { mkdir, readFile, rm, appendFile, writeFile, utimes, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  sendKeysDelayedEnterMock,
  capturePaneMock,
  sendKeyMock,
  getSessionMock,
  detectStatusMock,
  detectStatusAsyncMock,
  serverLinkMock,
} = vi.hoisted(() => ({
  sendKeysDelayedEnterMock: vi.fn().mockResolvedValue(undefined),
  capturePaneMock: vi.fn().mockResolvedValue(['$']),
  sendKeyMock: vi.fn().mockResolvedValue(undefined),
  getSessionMock: vi.fn(),
  detectStatusMock: vi.fn().mockReturnValue('idle'),
  detectStatusAsyncMock: vi.fn().mockResolvedValue('idle'),
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
  const match = prompt.match(/Add a new heading "## ([^"]+)"/);
  if (!match) throw new Error(`No heading found in prompt: ${prompt}`);
  return match[1];
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

beforeEach(async () => {
  vi.clearAllMocks();
  _setIdlePollMs(20);
  _setGracePeriodMs(80);
  _setMinProcessingMs(0);
  _setFileSettleCycles(1);

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
    const artifact = await readFile(hop!.artifact_path, 'utf8');
    expect(artifact).toContain('CROSS-PROJECT-deck_proj_w2');
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
});
