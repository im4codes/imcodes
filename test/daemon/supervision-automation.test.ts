import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeSessionSupervisionSnapshot, SUPERVISION_MODE } from '../../shared/supervision-config.js';

const mockStartP2pRun = vi.fn();
const mockCancelP2pRun = vi.fn();
const mockGetP2pRun = vi.fn();
const mockSupervisionDecide = vi.fn(async () => ({ decision: 'approve', reason: 'ok', confidence: 0.9 }));
const mockTransportRuntime = {
  send: vi.fn(),
  pendingCount: 0,
  pendingMessages: [],
  pendingEntries: [],
};

vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({
  startP2pRun: mockStartP2pRun,
  cancelP2pRun: mockCancelP2pRun,
  getP2pRun: mockGetP2pRun,
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  getTransportRuntime: vi.fn(() => mockTransportRuntime),
}));

vi.mock('../../src/daemon/supervision-broker.js', () => ({
  supervisionBroker: {
    decide: mockSupervisionDecide,
  },
}));

const { supervisionAutomation } = await import('../../src/daemon/supervision-automation.js');
const { timelineEmitter } = await import('../../src/daemon/timeline-emitter.js');
const { upsertSession, removeSession } = await import('../../src/store/session-store.js');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let projectDir: string | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mockSupervisionDecide.mockResolvedValue({ decision: 'approve', reason: 'ok', confidence: 0.9 });
  supervisionAutomation.cancelSession('deck_supervision_brain');
  removeSession('deck_supervision_brain');
});

async function seedProjectDir(withOpenSpecChange = false) {
  projectDir = await mkdtemp(path.join(os.tmpdir(), 'imcodes-supervision-'));
  if (!withOpenSpecChange) return projectDir;
  const changeDir = path.join(projectDir, 'openspec', 'changes', 'supervised-task-automation');
  await mkdir(path.join(changeDir, 'specs'), { recursive: true });
  await writeFile(path.join(changeDir, 'proposal.md'), '# Proposal\n');
  await writeFile(path.join(changeDir, 'design.md'), '# Design\n');
  await writeFile(path.join(changeDir, 'tasks.md'), '- [ ] demo\n');
  await writeFile(path.join(changeDir, 'specs', 'demo.md'), '## ADDED Requirements\n');
  return projectDir;
}

async function cleanupProjectDir() {
  if (!projectDir) return;
  await rm(projectDir, { recursive: true, force: true });
  projectDir = null;
}

async function seedSession(withOpenSpecChange = false) {
  const snapshot = normalizeSessionSupervisionSnapshot({
    mode: SUPERVISION_MODE.SUPERVISED_AUDIT,
    backend: 'codex-sdk',
    model: 'gpt-5.3-codex-spark',
    timeoutMs: 2_000,
    promptVersion: 'supervision_decision_v1',
    maxParseRetries: 1,
    auditMode: 'audit',
    maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    });
  const seededProjectDir = await seedProjectDir(withOpenSpecChange);
  upsertSession({
    name: 'deck_supervision_brain',
    projectName: 'supervision',
    role: 'brain',
    agentType: 'codex-sdk',
    runtimeType: 'transport',
    providerId: 'codex-sdk',
    providerSessionId: 'provider-session-1',
    projectDir: seededProjectDir,
    state: 'running',
    transportConfig: { supervision: snapshot },
    restarts: 0,
    restartTimestamps: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return snapshot;
}

describe('SupervisionAutomation', () => {
  beforeEach(async () => {
    await cleanupProjectDir();
  });

  it('launches a P2P audit after COMPLETE and clears the run on PASS', async () => {
    const snapshot = await seedSession();
    mockStartP2pRun.mockResolvedValue({ id: 'audit-run-1' });
    mockGetP2pRun.mockReturnValue({
      id: 'audit-run-1',
      status: 'completed',
      resultSummary: 'all good\n<!-- P2P_VERDICT: PASS -->',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-1',
      'implement the feature',
      snapshot,
    );

    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'done\n<!-- IMCODES_TASK_RUN: COMPLETE -->',
      streaming: false,
    });

    await sleep(25);
    await sleep(1_100);

    expect(mockStartP2pRun).toHaveBeenCalledTimes(1);
    expect(mockStartP2pRun).toHaveBeenCalledWith(expect.objectContaining({
      initiatorSession: 'deck_supervision_brain',
      targets: [],
      modeOverride: 'audit',
    }));
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
  });

  it('feeds REWORK back into the same transport session', async () => {
    const snapshot = await seedSession();
    mockStartP2pRun.mockResolvedValue({ id: 'audit-run-2' });
    mockGetP2pRun.mockReturnValue({
      id: 'audit-run-2',
      status: 'completed',
      resultSummary: 'needs fixes\n<!-- P2P_VERDICT: REWORK -->',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-2',
      'implement the feature',
      snapshot,
    );

    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'done\n<!-- IMCODES_TASK_RUN: COMPLETE -->',
      streaming: false,
    });

    await sleep(25);
    await sleep(1_100);

    expect(mockSupervisionDecide).toHaveBeenCalledTimes(1);
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).toContain('Audit verdict: REWORK');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeDefined();
  });

  it('fails closed when supervision denies the automated rework dispatch', async () => {
    const snapshot = await seedSession();
    mockStartP2pRun.mockResolvedValue({ id: 'audit-run-denied-rework' });
    mockGetP2pRun.mockReturnValue({
      id: 'audit-run-denied-rework',
      status: 'completed',
      resultSummary: 'needs fixes\n<!-- P2P_VERDICT: REWORK -->',
    });
    mockSupervisionDecide.mockResolvedValue({
      decision: 'ask_human',
      reason: 'needs manual confirmation',
      confidence: 0.2,
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-rework-denied',
      'implement the feature',
      snapshot,
    );

    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'done\n<!-- IMCODES_TASK_RUN: COMPLETE -->',
      streaming: false,
    });

    await sleep(25);
    await sleep(1_100);

    expect(mockSupervisionDecide).toHaveBeenCalledTimes(1);
    expect(mockTransportRuntime.send).not.toHaveBeenCalled();
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
  });

  it('does not launch audit when the terminal marker is missing', async () => {
    const snapshot = await seedSession();
    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-3',
      'implement the feature',
      snapshot,
    );

    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'done without marker',
      streaming: false,
    });
    timelineEmitter.emit('deck_supervision_brain', 'session.state', {
      state: 'idle',
    });

    await sleep(25);

    expect(mockStartP2pRun).not.toHaveBeenCalled();
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
  });

  it('activates queued heavy-mode task intents only when the matching user message is dispatched', async () => {
    const snapshot = await seedSession();
    supervisionAutomation.init();
    supervisionAutomation.queueTaskIntent(
      'deck_supervision_brain',
      'cmd-queued-heavy',
      'implement queued task',
      snapshot,
    );

    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();

    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: 'implement queued task',
      clientMessageId: 'cmd-queued-heavy',
      allowDuplicate: true,
    });

    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      commandId: 'cmd-queued-heavy',
      userText: 'implement queued task',
      phase: 'execution',
    });
  });

  it('routes OpenSpec task runs through the implementation-only OpenSpec audit baseline', async () => {
    const snapshot = await seedSession(true);
    mockStartP2pRun.mockResolvedValue({ id: 'audit-run-openspec' });
    mockGetP2pRun.mockReturnValue({
      id: 'audit-run-openspec',
      status: 'completed',
      resultSummary: 'all good\n<!-- P2P_VERDICT: PASS -->',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-4',
      'finish openspec/changes/supervised-task-automation implementation',
      snapshot,
    );

    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'done\n<!-- IMCODES_TASK_RUN: COMPLETE -->',
      streaming: false,
    });

    await sleep(25);
    await sleep(1_100);

    expect(mockStartP2pRun).toHaveBeenCalledWith(expect.objectContaining({
      userText: expect.stringContaining('OpenSpec implementation audit for change: supervised-task-automation'),
      advancedRounds: [expect.objectContaining({
        promptAppend: expect.stringContaining('Do not rerun discussion or proposal phases.'),
      })],
    }));
  });

  it('falls back to contextual audit when the task does not resolve to a specific OpenSpec change', async () => {
    const snapshot = await seedSession(true);
    mockStartP2pRun.mockResolvedValue({ id: 'audit-run-contextual' });
    mockGetP2pRun.mockReturnValue({
      id: 'audit-run-contextual',
      status: 'completed',
      resultSummary: 'all good\n<!-- P2P_VERDICT: PASS -->',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-ctx',
      'implement the feature without naming a change',
      snapshot,
    );

    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'done\n<!-- IMCODES_TASK_RUN: COMPLETE -->',
      streaming: false,
    });

    await sleep(25);
    await sleep(1_100);

    expect(mockStartP2pRun).toHaveBeenCalledWith(expect.objectContaining({
      userText: expect.stringContaining('Contextual implementation audit'),
      advancedRounds: [expect.objectContaining({
        promptAppend: expect.stringContaining('Audit the implementation result against the original request'),
      })],
    }));
  });

  it('stops after the configured rework-loop limit', async () => {
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED_AUDIT,
      backend: 'codex-sdk',
      model: 'gpt-5.3-codex-spark',
      timeoutMs: 2_000,
      promptVersion: 'supervision_decision_v1',
      maxParseRetries: 1,
      auditMode: 'audit',
      maxAuditLoops: 1,
      taskRunPromptVersion: 'task_run_status_v1',
    });
    const seededProjectDir = await seedProjectDir();
    upsertSession({
      name: 'deck_supervision_brain',
      projectName: 'supervision',
      role: 'brain',
      agentType: 'codex-sdk',
      runtimeType: 'transport',
      providerId: 'codex-sdk',
      providerSessionId: 'provider-session-1',
      projectDir: seededProjectDir,
      state: 'running',
      transportConfig: { supervision: snapshot },
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    mockStartP2pRun.mockResolvedValue({ id: 'audit-run-loop' });
    mockGetP2pRun.mockReturnValue({
      id: 'audit-run-loop',
      status: 'completed',
      resultSummary: 'needs fixes\n<!-- P2P_VERDICT: REWORK -->',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-5',
      'implement the feature',
      snapshot,
    );

    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'done\n<!-- IMCODES_TASK_RUN: COMPLETE -->',
      streaming: false,
    });

    await sleep(25);
    await sleep(1_100);

    expect(mockTransportRuntime.send).not.toHaveBeenCalled();
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
  });
});
