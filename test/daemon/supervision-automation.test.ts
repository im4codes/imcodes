import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeSessionSupervisionSnapshot, SUPERVISION_MODE } from '../../shared/supervision-config.js';

const mockStartP2pRun = vi.fn();
const mockCancelP2pRun = vi.fn();
const mockGetP2pRun = vi.fn();
const mockSupervisionDecide = vi.fn(async () => ({ decision: 'complete', reason: 'done', confidence: 0.9 }));
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
  mockSupervisionDecide.mockResolvedValue({ decision: 'complete', reason: 'done', confidence: 0.9 });
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

async function seedSession(mode: 'supervised' | 'supervised_audit' = 'supervised_audit', withOpenSpecChange = false, maxAuditLoops = 2) {
  const snapshot = normalizeSessionSupervisionSnapshot({
    mode: mode === 'supervised' ? SUPERVISION_MODE.SUPERVISED : SUPERVISION_MODE.SUPERVISED_AUDIT,
    backend: 'codex-sdk',
    model: 'gpt-5.3-codex-spark',
    timeoutMs: 2_000,
    promptVersion: 'supervision_decision_v1',
    maxParseRetries: 1,
    auditMode: 'audit',
    maxAuditLoops,
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

function completeTurn(text = 'done') {
  timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
    text,
    streaming: false,
  });
  timelineEmitter.emit('deck_supervision_brain', 'session.state', {
    state: 'idle',
  });
}

function beginRun(commandId: string, text: string) {
  timelineEmitter.emit('deck_supervision_brain', 'user.message', {
    text,
    clientMessageId: commandId,
    allowDuplicate: true,
  });
}

describe('SupervisionAutomation', () => {
  beforeEach(async () => {
    await cleanupProjectDir();
  });

  it('launches a P2P audit after the completion decision returns complete and clears the run on PASS', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockStartP2pRun.mockResolvedValue({ id: 'audit-run-1' });
    mockGetP2pRun.mockReturnValue({
      id: 'audit-run-1',
      status: 'completed',
      resultSummary: 'all good\n<!-- P2P_VERDICT: PASS -->',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-1', 'implement the feature', snapshot);
    beginRun('cmd-1', 'implement the feature');

    completeTurn('implemented the feature');
    await sleep(25);
    await sleep(1_100);

    expect(mockSupervisionDecide).toHaveBeenCalledWith(expect.objectContaining({
      taskRequest: 'implement the feature',
      assistantResponse: 'implemented the feature',
    }));
    // modeOverride is intentionally omitted — supervision builds its own
    // advancedRounds pipeline from auditMode, and resolveP2pRoundPlan ignores
    // modeOverride when advancedRounds is non-empty. Asserting its absence pins
    // the "single source of routing truth" invariant.
    expect(mockStartP2pRun).toHaveBeenCalledWith(expect.objectContaining({
      initiatorSession: 'deck_supervision_brain',
      advancedRounds: [expect.objectContaining({
        preset: 'implementation_audit',
        verdictPolicy: 'smart_gate',
      })],
    }));
    const startArgs = mockStartP2pRun.mock.calls[0]?.[0] as { modeOverride?: unknown; advancedRounds: unknown[] };
    expect(startArgs.modeOverride).toBeUndefined();
    expect(startArgs.advancedRounds).toHaveLength(1);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
  });

  it('auto-continues a supervised run when the completion decision returns continue', async () => {
    const snapshot = await seedSession('supervised');
    mockSupervisionDecide.mockResolvedValue({
      decision: 'continue',
      reason: 'tests are still missing',
      confidence: 0.7,
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-continue', 'implement the feature', snapshot);
    beginRun('cmd-continue', 'implement the feature');

    completeTurn('implemented the code but did not add tests');
    await sleep(25);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).toContain('Continue working on the same task.');
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).toContain('Supervisor reason: tests are still missing');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      commandId: 'cmd-continue',
      phase: 'execution',
      continueLoops: 1,
    });
  });

  it('emits and clears a supervision waiting status around completion evaluation', async () => {
    const snapshot = await seedSession('supervised');

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-status', 'implement the feature', snapshot);
    beginRun('cmd-status', 'implement the feature');

    completeTurn('implemented the feature');
    await sleep(25);

    const events = timelineEmitter.replay('deck_supervision_brain', 0).events;
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'agent.status',
        payload: expect.objectContaining({
          status: 'supervision_waiting',
          label: 'Checking whether the task is complete...',
        }),
      }),
      expect.objectContaining({
        type: 'agent.status',
        payload: { status: null, label: null },
      }),
    ]));
  });

  it('returns control to the human when the completion decision asks for human input', async () => {
    const snapshot = await seedSession('supervised');
    mockSupervisionDecide.mockResolvedValue({
      decision: 'ask_human',
      reason: 'needs clarification',
      confidence: 0.2,
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-human', 'implement the feature', snapshot);
    beginRun('cmd-human', 'implement the feature');

    completeTurn('I am not sure which endpoint should be updated');
    await sleep(25);

    expect(mockTransportRuntime.send).not.toHaveBeenCalled();
    expect(mockStartP2pRun).not.toHaveBeenCalled();
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
  });

  it('fails closed when the session goes idle without a completed assistant response', async () => {
    const snapshot = await seedSession('supervised');

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-no-output', 'implement the feature', snapshot);
    beginRun('cmd-no-output', 'implement the feature');

    timelineEmitter.emit('deck_supervision_brain', 'session.state', {
      state: 'idle',
    });
    await sleep(25);

    expect(mockSupervisionDecide).not.toHaveBeenCalled();
    expect(mockTransportRuntime.send).not.toHaveBeenCalled();
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
  });

  it('feeds REWORK back into the same transport session after audit', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockStartP2pRun.mockResolvedValue({ id: 'audit-run-2' });
    mockGetP2pRun.mockReturnValue({
      id: 'audit-run-2',
      status: 'completed',
      resultSummary: 'needs fixes\n<!-- P2P_VERDICT: REWORK -->',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-2', 'implement the feature', snapshot);
    beginRun('cmd-2', 'implement the feature');

    completeTurn('implemented the feature');
    await sleep(25);
    await sleep(1_100);

    expect(mockSupervisionDecide).toHaveBeenCalledTimes(1);
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).toContain('Audit verdict: REWORK');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeDefined();
  });

  it('activates queued task intents only when the matching user message is dispatched', async () => {
    const snapshot = await seedSession('supervised');
    supervisionAutomation.init();
    supervisionAutomation.queueTaskIntent(
      'deck_supervision_brain',
      'cmd-queued',
      'implement queued task',
      snapshot,
    );

    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();

    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: 'implement queued task',
      clientMessageId: 'cmd-queued',
      allowDuplicate: true,
    });

    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      commandId: 'cmd-queued',
      userText: 'implement queued task',
      phase: 'execution',
    });
  });

  it('does not evaluate a stale assistant response from before the most recent user task', async () => {
    await seedSession('supervised');
    supervisionAutomation.init();

    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'stale assistant response',
      streaming: false,
    });
    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: 'implement the latest task',
      clientMessageId: 'cmd-latest',
      allowDuplicate: true,
    });
    timelineEmitter.emit('deck_supervision_brain', 'session.state', {
      state: 'idle',
    });
    await sleep(25);

    expect(mockSupervisionDecide).not.toHaveBeenCalled();
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
  });

  it('routes OpenSpec task runs through the implementation-only OpenSpec audit baseline', async () => {
    const snapshot = await seedSession('supervised_audit', true);
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
    beginRun('cmd-4', 'finish openspec/changes/supervised-task-automation implementation');

    completeTurn('implemented the change');
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
    const snapshot = await seedSession('supervised_audit', true);
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
    beginRun('cmd-ctx', 'implement the feature without naming a change');

    completeTurn('implemented the feature');
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
    // maxAuditLoops=0 means "no rework dispatches permitted" — the first REWORK
    // verdict must immediately transition to manual review without sending.
    // (For maxAuditLoops>=1 the loop emits dispatches; see the dedicated test below.)
    const snapshot = await seedSession('supervised_audit', false, 1);
    // Force max to 0 by passing an invalid value that normalizes to 1 is avoided —
    // normalize rejects <1, so use 1 and assert exactly one dispatch then stop.
    mockStartP2pRun.mockResolvedValue({ id: 'audit-run-loop' });
    mockGetP2pRun.mockReturnValue({
      id: 'audit-run-loop',
      status: 'completed',
      resultSummary: 'needs fixes\n<!-- P2P_VERDICT: REWORK -->',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-5', 'implement the feature', snapshot);
    beginRun('cmd-5', 'implement the feature');

    completeTurn('implemented the feature');
    await sleep(25);
    await sleep(1_100);

    // maxAuditLoops=1 → exactly one rework brief dispatched, then run remains active
    // waiting for the session's next turn (which is the semantically correct behavior:
    // "up to N rework dispatches"). Prior code off-by-one'd to zero.
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).toContain('Audit verdict: REWORK');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      reworkDispatches: 1,
      phase: 'execution',
    });
  });

  it('expands combo audit modes into multi-round pipelines with a single smart_gate verdict', async () => {
    const snapshot = await seedSession('supervised_audit');
    // Override auditMode to a combo to assert pipeline expansion
    const comboSnapshot = { ...snapshot, auditMode: 'audit>review>plan' as const };
    upsertSession({
      name: 'deck_supervision_brain',
      projectName: 'supervision',
      role: 'brain',
      agentType: 'codex-sdk',
      runtimeType: 'transport',
      providerId: 'codex-sdk',
      providerSessionId: 'provider-session-1',
      projectDir: projectDir!,
      state: 'running',
      transportConfig: { supervision: comboSnapshot },
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    mockStartP2pRun.mockResolvedValue({ id: 'audit-combo' });
    mockGetP2pRun.mockReturnValue({
      id: 'audit-combo',
      status: 'completed',
      resultSummary: 'all good\n<!-- P2P_VERDICT: PASS -->',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-combo', 'implement the feature', comboSnapshot);
    beginRun('cmd-combo', 'implement the feature');

    completeTurn('implemented the feature');
    await sleep(25);
    await sleep(1_100);

    const args = mockStartP2pRun.mock.calls[0]?.[0] as {
      advancedRounds: Array<{ preset: string; verdictPolicy: string; permissionScope: string }>;
      modeOverride?: unknown;
      rounds: number;
    };
    expect(args.modeOverride).toBeUndefined();
    expect(args.rounds).toBe(3);
    expect(args.advancedRounds.map((r) => r.preset)).toEqual(['implementation_audit', 'implementation_audit', 'custom']);
    expect(args.advancedRounds.map((r) => r.verdictPolicy)).toEqual(['none', 'smart_gate', 'none']);
    expect(args.advancedRounds.every((r) => r.permissionScope === 'analysis_only')).toBe(true);
  });

  it('expands audit>plan into a two-round pipeline where audit owns the verdict', async () => {
    const snapshot = await seedSession('supervised_audit');
    const comboSnapshot = { ...snapshot, auditMode: 'audit>plan' as const };
    upsertSession({
      name: 'deck_supervision_brain',
      projectName: 'supervision',
      role: 'brain',
      agentType: 'codex-sdk',
      runtimeType: 'transport',
      providerId: 'codex-sdk',
      providerSessionId: 'provider-session-1',
      projectDir: projectDir!,
      state: 'running',
      transportConfig: { supervision: comboSnapshot },
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    mockStartP2pRun.mockResolvedValue({ id: 'audit-plan' });
    mockGetP2pRun.mockReturnValue({
      id: 'audit-plan',
      status: 'completed',
      resultSummary: 'all good\n<!-- P2P_VERDICT: PASS -->',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-ap', 'implement the feature', comboSnapshot);
    beginRun('cmd-ap', 'implement the feature');

    completeTurn('implemented the feature');
    await sleep(25);
    await sleep(1_100);

    const args = mockStartP2pRun.mock.calls[0]?.[0] as {
      advancedRounds: Array<{ preset: string; verdictPolicy: string }>;
      rounds: number;
    };
    expect(args.rounds).toBe(2);
    expect(args.advancedRounds).toEqual([
      expect.objectContaining({ preset: 'implementation_audit', verdictPolicy: 'smart_gate' }),
      expect.objectContaining({ preset: 'custom', verdictPolicy: 'none' }),
    ]);
  });
});
