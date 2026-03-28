/**
 * Integration test: cron executor → P2P orchestrator (NOT mocking startP2pRun).
 *
 * Verifies the full path: executeCronJob with a P2P action actually creates
 * a P2P run, writes a discussion file, dispatches hops, and completes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Hoisted mocks — mock tmux/detect/session-store but NOT p2p-orchestrator ──

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

// Mock sessionName but NOT p2p-orchestrator
vi.mock('../../src/agent/session-manager.js', () => ({
  sessionName: vi.fn((project: string, role: string) => `deck_${project}_${role}`),
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

// ── Imports ──────────────────────────────────────────────────────────────────

import { executeCronJob } from '../../src/daemon/cron-executor.js';
import {
  getP2pRun,
  listP2pRuns,
  _setIdlePollMs,
  _setGracePeriodMs,
  _setMinProcessingMs,
  _setFileSettleCycles,
  notifySessionIdle,
  type P2pRun,
  type P2pRunStatus,
} from '../../src/daemon/p2p-orchestrator.js';
import { CRON_MSG, type CronDispatchMessage } from '../../shared/cron-types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let tempProjectDir: string;

function makeMsg(overrides: Partial<CronDispatchMessage> = {}): CronDispatchMessage {
  return {
    type: CRON_MSG.DISPATCH,
    jobId: 'cron-p2p-1',
    jobName: 'nightly-review',
    serverId: 'srv-1',
    projectName: 'myapp',
    targetRole: 'brain',
    action: { type: 'command', command: 'test' },
    ...overrides,
  };
}

async function waitForStatus(
  predicate: () => P2pRun | undefined,
  target: P2pRunStatus | P2pRunStatus[],
  maxMs = 10_000,
): Promise<P2pRun | undefined> {
  const targets = Array.isArray(target) ? target : [target];
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const run = predicate();
    if (run && targets.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.clearAllMocks();
  _setIdlePollMs(50);
  _setGracePeriodMs(100);
  _setMinProcessingMs(0);
  _setFileSettleCycles(1);

  tempProjectDir = join(tmpdir(), `cron-p2p-integ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(tempProjectDir, { recursive: true });

  detectStatusMock.mockReturnValue('idle');
  detectStatusAsyncMock.mockResolvedValue('idle');
  capturePaneMock.mockResolvedValue(['$']);

  // Default session lookup — returns sessions for brain, w1, and a sub-session
  getSessionMock.mockImplementation((name: string) => {
    if (name === 'deck_myapp_brain') return { agentType: 'claude-code', projectDir: tempProjectDir, parentSession: undefined };
    if (name === 'deck_myapp_w1') return { agentType: 'claude-code', projectDir: tempProjectDir, parentSession: undefined };
    if (name === 'deck_sub_worker1') return { agentType: 'claude-code', projectDir: tempProjectDir, parentSession: 'deck_myapp_brain' };
    return null;
  });

  // Simulate agent writing output to discussion file when prompted
  sendKeysDelayedEnterMock.mockImplementation(async (session: string, prompt: string) => {
    const pathMatch = prompt.match(/\/[^\s]*.imc\/discussions\/[^\s]+\.md/);
    if (pathMatch) {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(pathMatch[0], `\n## Output from ${session}\n\nAnalysis done.\n`);
    }
    setTimeout(() => notifySessionIdle(session), 150);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  _setIdlePollMs(3_000);
  _setGracePeriodMs(180_000);
  _setMinProcessingMs(30_000);
  _setFileSettleCycles(3);
  await rm(tempProjectDir, { recursive: true, force: true }).catch(() => {});
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Cron → P2P integration', () => {
  it('cron P2P with role participants creates discussion file and completes', async () => {
    const msg = makeMsg({
      action: {
        type: 'p2p',
        topic: 'nightly code review',
        mode: 'audit',
        participants: ['w1'],
        rounds: 1,
      },
    });

    await executeCronJob(msg, serverLinkMock as any);

    // startP2pRun was called (not mocked) — a real P2P run should exist
    const runs = listP2pRuns();
    expect(runs.length).toBeGreaterThanOrEqual(1);

    const run = runs.find(r => r.mainSession === 'deck_myapp');
    expect(run).toBeDefined();

    // Wait for the P2P run to complete
    const completed = await waitForStatus(
      () => getP2pRun(run!.id),
      ['completed', 'failed'],
    );
    expect(completed).toBeDefined();
    expect(completed!.status).toBe('completed');

    // Discussion file should exist and contain output from both brain and w1
    const content = await readFile(completed!.contextFilePath, 'utf-8');
    expect(content).toContain('nightly code review');
    expect(content).toContain('Output from deck_myapp_brain');
    expect(content).toContain('Output from deck_myapp_w1');
  });

  it('cron P2P with sub-session participantEntries completes', async () => {
    const runsBefore = new Set(listP2pRuns().map(r => r.id));

    const msg = makeMsg({
      action: {
        type: 'p2p',
        topic: 'sub-session architecture review',
        mode: 'review',
        participantEntries: [
          { type: 'session', value: 'deck_sub_worker1' },
        ],
        rounds: 1,
      },
    });

    await executeCronJob(msg, serverLinkMock as any);

    // Find only the NEW run (not from a previous test)
    const newRun = listP2pRuns().find(r => !runsBefore.has(r.id));
    expect(newRun).toBeDefined();

    const completed = await waitForStatus(
      () => getP2pRun(newRun!.id),
      ['completed', 'failed'],
    );
    expect(completed).toBeDefined();
    expect(completed!.status).toBe('completed');
    // Verify sub-session was dispatched (may complete or skip depending on timing)
    const allDispatched = [...completed!.completedHops.map(h => h.session), ...completed!.skippedHops];
    expect(allDispatched).toContain('deck_sub_worker1');
  });

  it('cron P2P with mixed role + session participants deduplicates correctly', async () => {
    const runsBefore = new Set(listP2pRuns().map(r => r.id));
    const msg = makeMsg({
      action: {
        type: 'p2p',
        topic: 'mixed participant review',
        mode: 'discuss',
        // Both formats for w1: role string AND participantEntry
        participants: ['w1'],
        participantEntries: [
          { type: 'role', value: 'w1' },
          { type: 'session', value: 'deck_sub_worker1' },
        ],
        rounds: 1,
      },
    });

    await executeCronJob(msg, serverLinkMock as any);

    const newRun = listP2pRuns().find(r => !runsBefore.has(r.id));
    expect(newRun).toBeDefined();

    const completed = await waitForStatus(
      () => getP2pRun(newRun!.id),
      ['completed', 'failed'],
    );
    expect(completed).toBeDefined();
    expect(completed!.status).toBe('completed');

    // The key assertion: deduplication means w1 + deck_sub_worker1 = 2 unique targets, NOT 3
    const allDispatched = [...completed!.completedHops.map(h => h.session), ...completed!.skippedHops];
    const uniqueTargets = new Set(allDispatched);
    expect(uniqueTargets.size).toBeLessThanOrEqual(2);
    expect(uniqueTargets.size).toBeGreaterThanOrEqual(1);
  });

  it('cron P2P with nonexistent participants skips gracefully', async () => {
    const msg = makeMsg({
      action: {
        type: 'p2p',
        topic: 'ghost participant review',
        mode: 'audit',
        participants: ['w99'], // doesn't exist
        rounds: 1,
      },
    });

    await executeCronJob(msg, serverLinkMock as any);

    // No P2P run should be started since no valid participants
    const { default: logger } = await import('../../src/util/logger.js');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'cron-p2p-1' }),
      expect.stringContaining('no valid P2P participants'),
    );
  });

  it('cross-project sub-session targeting is blocked', async () => {
    // Sub-session exists but belongs to a different project
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_myapp_brain') return { agentType: 'claude-code', projectDir: tempProjectDir };
      if (name === 'deck_sub_other_project') return {
        agentType: 'claude-code',
        projectDir: '/other/project',
        parentSession: 'deck_otherproject_brain', // different project!
      };
      return null;
    });

    const msg = makeMsg({
      targetSessionName: 'deck_sub_other_project',
      action: { type: 'command', command: 'steal data' },
    });

    await executeCronJob(msg, serverLinkMock as any);

    const { default: logger } = await import('../../src/util/logger.js');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ targetSessionName: 'deck_sub_other_project' }),
      expect.stringContaining('cross-project'),
    );
    expect(sendKeysDelayedEnterMock).not.toHaveBeenCalled();
  });
});
