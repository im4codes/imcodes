import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeSessionSupervisionSnapshot, SUPERVISION_MODE } from '../../shared/supervision-config.js';
import {
  PEER_AUDIT_DEADLINE_MS,
  PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS,
} from '../../shared/peer-audit.js';

const mockStartP2pRun = vi.fn();
const mockCancelP2pRun = vi.fn();
const mockGetP2pRun = vi.fn();
// Audit:R3 hardening / task 10.4 — supervision now consults
// `listP2pRuns()` + `loadDaemonP2pStaticPolicy(serverLink)` to honour the
// daemon admission cap. Mock returns "no active runs" so the bounded retry
// helper never trips on `daemon_busy`.
const mockListP2pRuns = vi.fn(() => [] as unknown[]);
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
  listP2pRuns: mockListP2pRuns,
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  getTransportRuntime: vi.fn(() => mockTransportRuntime),
}));

vi.mock('../../src/daemon/supervision-broker.js', () => ({
  supervisionBroker: {
    decide: mockSupervisionDecide,
  },
}));

vi.mock('../../src/daemon/peer-audit-service.js', () => ({
  peerAuditService: {
    cancelAutomatic: vi.fn(),
    applyAutomaticConfiguration: vi.fn(),
  },
}));

const { supervisionAutomation } = await import('../../src/daemon/supervision-automation.js');
const { timelineEmitter } = await import('../../src/daemon/timeline-emitter.js');
const { getSession, upsertSession, removeSession } = await import('../../src/store/session-store.js');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRunPhase(phase: 'execution' | 'auditing' | 'finalizing', timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (supervisionAutomation.getActiveRun('deck_supervision_brain')?.phase !== phase) {
    if (performance.now() >= deadline) return;
    // `setTimeout` is deliberately faked by the deadline test below. Yield on
    // the real check queue so async filesystem baseline discovery can finish
    // without advancing the six-minute audit deadline.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

let projectDir: string | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mockSupervisionDecide.mockReset();
  mockSupervisionDecide.mockResolvedValue({ decision: 'complete', reason: 'done', confidence: 0.9 });
  supervisionAutomation.cancelSession('deck_supervision_brain');
  removeSession('deck_supervision_brain');
  removeSession('deck_sub_reviewer');
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

async function seedSession(
  mode: 'supervised' | 'supervised_audit' = 'supervised_audit',
  withOpenSpecChange = false,
  maxAuditLoops = 2,
  overrides: Record<string, unknown> = {},
) {
  const seededProjectDir = await seedProjectDir(withOpenSpecChange);
  upsertSession({
    name: 'deck_sub_reviewer',
    label: 'Reviewer',
    projectName: 'supervision',
    role: 'w1',
    agentType: 'claude-code-sdk',
    runtimeType: 'transport',
    providerId: 'claude-code-sdk',
    providerSessionId: 'provider-session-reviewer',
    activeModel: 'claude-sonnet-4-6',
    projectDir: seededProjectDir,
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const reviewerSessionInstanceId = getSession('deck_sub_reviewer')?.sessionInstanceId;
  if (!reviewerSessionInstanceId) throw new Error('reviewer session identity was not created');
  const snapshot = normalizeSessionSupervisionSnapshot({
    mode: mode === 'supervised' ? SUPERVISION_MODE.SUPERVISED : SUPERVISION_MODE.SUPERVISED_AUDIT,
    backend: 'codex-sdk',
    model: 'gpt-5.3-codex-spark',
    timeoutMs: 2_000,
    promptVersion: 'supervision_decision_v1',
    maxParseRetries: 1,
    auditMode: 'audit',
    auditTargetSessionName: 'deck_sub_reviewer',
    auditTargetFingerprint: {
      sessionInstanceId: reviewerSessionInstanceId,
      normalizedModelId: 'claude-sonnet-4-6',
      providerFamily: 'anthropic',
    },
    maxAuditLoops,
    taskRunPromptVersion: 'task_run_status_v1',
    ...overrides,
  });
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

function completeDelegatedAudit(verdict: 'PASS' | 'REWORK', findings = 'Independent audit evidence.') {
  timelineEmitter.emit('deck_supervision_brain', 'user.message', {
    text: `Task: independent audit\nResult: ${findings}`,
    allowDuplicate: true,
  });
  timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
    text: `${findings}\n${PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS[verdict]}`,
    streaming: false,
  });
  timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'idle' });
}

describe('SupervisionAutomation', () => {
  beforeEach(async () => {
    await cleanupProjectDir();
  });

  it('asks the current session to prepare and delegate the audit, then clears only after the reply-backed PASS', async () => {
    const snapshot = await seedSession('supervised_audit');

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-1', 'implement the feature', snapshot);
    beginRun('cmd-1', 'implement the feature');

    completeTurn('implemented the feature');
    await sleep(25);
    expect(mockSupervisionDecide).toHaveBeenCalledWith(expect.objectContaining({
      taskRequest: 'implement the feature',
      assistantResponse: 'implemented the feature',
    }));
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    const orchestrationPrompt = String(mockTransportRuntime.send.mock.calls[0]?.[0]);
    expect(orchestrationPrompt).toContain('You are the current session orchestrator for an agent delegation.');
    expect(orchestrationPrompt).toContain('Exact delegate target session: deck_sub_reviewer');
    expect(orchestrationPrompt).toContain('imcodes send --reply');
    expect(orchestrationPrompt).toContain('You—not the daemon—must prepare the audit background');
    expect(orchestrationPrompt).toContain('Do not commit, push, deploy');
    expect(mockStartP2pRun).not.toHaveBeenCalled();
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      auditReplyObserved: false,
    });

    // The current session acknowledging the orchestration request is not an
    // audit result. It must remain pending until a reply-enabled delegation
    // response actually returns to this session.
    completeTurn('Audit delegated; waiting for the selected agent reply.');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({ phase: 'auditing' });

    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: 'Unrelated shared participant message.',
      allowDuplicate: true,
      sharedActor: { actorUserId: 'someone-else', actorDisplayName: 'Someone else' },
    });
    completeTurn(`Premature marker must not pass.\n${PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS.PASS}`);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      auditReplyObserved: false,
    });

    completeDelegatedAudit('PASS');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
    expect(timelineEmitter.replay('deck_supervision_brain', 0).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'peer_audit.result',
        payload: expect.objectContaining({
          trigger: 'automatic',
          outcome: 'pass',
          auditorSessionName: 'deck_sub_reviewer',
        }),
      }),
    ]));
  });

  it('cancels an in-flight orchestrated audit exactly once when supervision is stopped', async () => {
    const snapshot = await seedSession('supervised_audit');
    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-cancel-audit', 'implement the feature', snapshot);
    beginRun('cmd-cancel-audit', 'implement the feature');
    completeTurn('implemented the feature');
    await sleep(50);

    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({ phase: 'auditing' });
    supervisionAutomation.cancelSession('deck_supervision_brain');
    supervisionAutomation.cancelSession('deck_supervision_brain');

    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
    const cancelled = timelineEmitter.replay('deck_supervision_brain', 0).events.filter((event) =>
      event.type === 'peer_audit.result' && event.payload.outcome === 'cancelled');
    expect(cancelled).toHaveLength(1);
  });

  it('times out an orchestrated audit at the deadline without releasing held finalization', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'continue',
      reason: 'repository finalization remains',
      confidence: 0.9,
      nextAction: 'Commit the completed changes and push to origin/dev.',
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      supervisionAutomation.init();
      supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-timeout-audit', 'implement the feature', snapshot);
      beginRun('cmd-timeout-audit', 'implement the feature');
      completeTurn('Implementation and tests are complete.');

      await waitForRunPhase('auditing');
      expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
        phase: 'auditing',
        deferredFinalization: expect.any(Object),
      });
      expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(PEER_AUDIT_DEADLINE_MS);

      expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
      expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
      expect(timelineEmitter.replay('deck_supervision_brain', 0).events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'peer_audit.result',
          payload: expect.objectContaining({ outcome: 'timeout', reason: 'deadline_expired' }),
        }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the stale audit generation when a new task intent replaces it', async () => {
    const snapshot = await seedSession('supervised_audit');
    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-old-audit', 'implement the old feature', snapshot);
    beginRun('cmd-old-audit', 'implement the old feature');
    completeTurn('implemented the old feature');
    await sleep(50);

    const oldGeneration = supervisionAutomation.getActiveRun('deck_supervision_brain')?.generation;
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({ phase: 'auditing' });
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-new-task', 'implement the new feature', snapshot);

    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      commandId: 'cmd-new-task',
      phase: 'execution',
      generation: (oldGeneration ?? 0) + 1,
    });
    const cancelled = timelineEmitter.replay('deck_supervision_brain', 0).events.filter((event) =>
      event.type === 'peer_audit.result'
      && event.payload.outcome === 'cancelled'
      && event.payload.reason === 'new_task_intent_replaced_existing_audit');
    expect(cancelled).toHaveLength(1);
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
  });

  it('fails closed instead of delegating when the configured auditor fingerprint is stale', async () => {
    const snapshot = await seedSession('supervised_audit');
    removeSession('deck_sub_reviewer');
    upsertSession({
      name: 'deck_sub_reviewer',
      label: 'Replacement reviewer',
      projectName: 'supervision',
      role: 'w1',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      providerId: 'claude-code-sdk',
      providerSessionId: 'provider-session-replacement',
      activeModel: 'claude-sonnet-4-6',
      projectDir: projectDir!,
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-stale-auditor', 'implement the feature', snapshot);
    beginRun('cmd-stale-auditor', 'implement the feature');
    completeTurn('implemented the feature');
    await sleep(50);

    expect(mockTransportRuntime.send).not.toHaveBeenCalled();
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
    expect(timelineEmitter.replay('deck_supervision_brain', 0).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'assistant.text',
        payload: expect.objectContaining({
          automationKind: 'supervision-warning',
          text: expect.stringContaining('configured auditor'),
        }),
      }),
    ]));
  });

  it('holds commit and push until PASS and allows multi-turn finalization without a second audit', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide
      .mockResolvedValueOnce({
        decision: 'continue',
        reason: 'implementation and validation are complete, but repository finalization remains',
        confidence: 0.9,
        gap: 'the completed changes are not committed or pushed',
        nextAction: 'Run git add -A, commit the completed changes, and push to origin/dev.',
      })
      .mockResolvedValueOnce({
        decision: 'continue',
        reason: 'the commit is complete but the audited branch still needs to be pushed',
        confidence: 0.9,
        nextAction: 'Push the remaining audited commit to origin/dev.',
      })
      .mockResolvedValueOnce({ decision: 'complete', reason: 'post-audit finalization completed', confidence: 0.95 });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-audit-before-commit', 'implement the feature', snapshot);
    beginRun('cmd-audit-before-commit', 'implement the feature');
    completeTurn('Implementation and tests are complete. Changes are not committed yet.');
    await sleep(25);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).toContain('imcodes send --reply');
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).not.toContain('Run git add -A');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      deferredFinalization: {
        nextAction: 'Run git add -A, commit the completed changes, and push to origin/dev.',
      },
    });
    expect(timelineEmitter.replay('deck_supervision_brain', 0).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'agent.status',
        payload: expect.objectContaining({
          status: 'supervision_audit_waiting',
          label: expect.stringContaining('commit/push paused'),
        }),
      }),
      expect.objectContaining({
        type: 'assistant.text',
        payload: expect.objectContaining({
          automationKind: 'supervision-audit',
          text: expect.stringContaining('Commit/push is paused until PASS'),
        }),
      }),
    ]));

    completeDelegatedAudit('PASS');
    await sleep(25);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);
    expect(String(mockTransportRuntime.send.mock.calls[1]?.[0])).toContain('Run git add -A, commit the completed changes, and push to origin/dev.');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({ phase: 'finalizing' });

    completeTurn('Committed the audited changes; push is still pending.');
    await sleep(25);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(3);
    expect(String(mockTransportRuntime.send.mock.calls[2]?.[0])).toContain('Push the remaining audited commit to origin/dev.');
    expect(String(mockTransportRuntime.send.mock.calls[2]?.[0])).not.toContain('Do not stage, commit, or push');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({ phase: 'finalizing' });

    completeTurn('Pushed the audited changes.');
    await sleep(25);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(3);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
  });

  it('never releases held commit and push when peer audit requests REWORK', async () => {
    const snapshot = await seedSession('supervised_audit', false, 1);
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'continue',
      reason: 'only repository finalization remains',
      confidence: 0.9,
      gap: 'changes are uncommitted',
      nextAction: 'Commit the completed changes and push to origin/dev.',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-rework-before-commit', 'implement the feature', snapshot);
    beginRun('cmd-rework-before-commit', 'implement the feature');
    completeTurn('Implementation and tests are complete.');
    await sleep(25);
    completeDelegatedAudit('REWORK', 'needs fixes');
    await sleep(25);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);
    expect(String(mockTransportRuntime.send.mock.calls[1]?.[0])).toContain('Audit verdict: REWORK');
    expect(String(mockTransportRuntime.send.mock.calls[1]?.[0])).not.toContain('Commit the completed changes and push to origin/dev.');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'execution',
      reworkDispatches: 1,
    });
  });

  it('keeps ordinary supervised commit and push continuation immediate', async () => {
    const snapshot = await seedSession('supervised');
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'continue',
      reason: 'repository finalization remains',
      confidence: 0.9,
      nextAction: 'Commit the completed changes and push to origin/dev.',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-ordinary-commit', 'implement the feature', snapshot);
    beginRun('cmd-ordinary-commit', 'implement the feature');
    completeTurn('Implementation and tests are complete.');
    await sleep(25);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).toContain('Commit the completed changes and push to origin/dev.');
  });

  it('does not defer substantive validation work merely because commit is also mentioned', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'continue',
      reason: 'validation still remains before repository finalization',
      confidence: 0.8,
      nextAction: 'Run the focused tests, fix failures, then commit and push.',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-tests-before-audit', 'implement the feature', snapshot);
    beginRun('cmd-tests-before-audit', 'implement the feature');
    completeTurn('Implementation is present but validation is still pending.');
    await sleep(25);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    const continuePrompt = String(mockTransportRuntime.send.mock.calls[0]?.[0]);
    expect(continuePrompt).toContain('Complete only the remaining substantive implementation or validation work');
    expect(continuePrompt).toContain('Do not stage, commit, or push');
    expect(continuePrompt).not.toContain('Run the focused tests, fix failures, then commit and push.');
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
    const events = timelineEmitter.replay('deck_supervision_brain', 0).events;
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'assistant.text',
        payload: expect.objectContaining({
          automation: true,
          automationKind: 'supervision-continue-status',
          text: 'Auto: sent a continue prompt to keep the task moving.',
        }),
      }),
      expect.objectContaining({
        type: 'agent.status',
        payload: expect.objectContaining({
          status: 'supervision_continue_sent',
          label: 'Supervised: sent a continue prompt.',
        }),
      }),
    ]));
  });

  it('stops after the configured repeated continue streak for the same bucket', async () => {
    const snapshot = await seedSession('supervised', false, 2, {
      maxAutoContinueStreak: 2,
      maxAutoContinueTotal: 0,
    });
    mockSupervisionDecide
      .mockResolvedValueOnce({ decision: 'continue', reason: 'write tests for the missing cases', confidence: 0.7 })
      .mockResolvedValueOnce({ decision: 'continue', reason: 'write tests for edge cases too', confidence: 0.7 })
      .mockResolvedValueOnce({ decision: 'continue', reason: 'write tests for regressions as well', confidence: 0.7 });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-streak', 'implement the feature', snapshot);
    beginRun('cmd-streak', 'implement the feature');

    completeTurn('implemented the code');
    await sleep(25);
    completeTurn('added a first batch of tests');
    await sleep(25);
    completeTurn('added another batch of tests');
    await sleep(25);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
    expect(timelineEmitter.replay('deck_supervision_brain', 0).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'assistant.text',
        payload: expect.objectContaining({
          automationKind: 'supervision-warning',
          text: '⚠️ Automation reached the repeated auto-continue limit (2) for test_verify; handing control back to the human.',
        }),
      }),
    ]));
  });

  it('allows different continue types until the hard total limit is reached', async () => {
    const snapshot = await seedSession('supervised', false, 2, {
      maxAutoContinueStreak: 2,
      maxAutoContinueTotal: 2,
    });
    mockSupervisionDecide
      .mockResolvedValueOnce({ decision: 'continue', reason: 'write missing tests', confidence: 0.7 })
      .mockResolvedValueOnce({ decision: 'continue', reason: 'restart the daemon to pick up the config', confidence: 0.7 })
      .mockResolvedValueOnce({ decision: 'continue', reason: 'inspect the logs again', confidence: 0.7 });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-total', 'implement the feature', snapshot);
    beginRun('cmd-total', 'implement the feature');

    completeTurn('implemented the code');
    await sleep(25);
    completeTurn('added tests');
    await sleep(25);
    completeTurn('restarted the daemon');
    await sleep(25);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
    expect(timelineEmitter.replay('deck_supervision_brain', 0).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'assistant.text',
        payload: expect.objectContaining({
          automationKind: 'supervision-warning',
          text: '⚠️ Automation reached the auto-continue hard limit (2); handing control back to the human.',
        }),
      }),
    ]));
  });

  it('treats zero auto-continue limits as unlimited', async () => {
    const snapshot = await seedSession('supervised', false, 2, {
      maxAutoContinueStreak: 0,
      maxAutoContinueTotal: 0,
    });
    mockSupervisionDecide
      .mockResolvedValueOnce({ decision: 'continue', reason: 'write missing tests', confidence: 0.7 })
      .mockResolvedValueOnce({ decision: 'continue', reason: 'write more missing tests', confidence: 0.7 })
      .mockResolvedValueOnce({ decision: 'continue', reason: 'write final missing tests', confidence: 0.7 });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-unlimited', 'implement the feature', snapshot);
    beginRun('cmd-unlimited', 'implement the feature');

    completeTurn('implemented the code');
    await sleep(25);
    completeTurn('added a first batch of tests');
    await sleep(25);
    completeTurn('added a second batch of tests');
    await sleep(25);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(3);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      continueLoops: 3,
      continueStreakCount: 3,
      lastContinueBucket: 'test_verify',
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
        type: 'assistant.text',
        payload: expect.objectContaining({
          automation: true,
          automationKind: 'supervision-status',
          text: 'Auto: checking whether the task is complete...',
        }),
      }),
      expect.objectContaining({
        type: 'agent.status',
        payload: expect.objectContaining({
          status: 'supervision_waiting',
          label: 'Supervised: analyzing completion...',
        }),
      }),
      expect.objectContaining({
        type: 'agent.status',
        payload: { status: null, label: null },
      }),
    ]));
  });

  it('emits a visible completion result and leaves a footer status when supervised execution completes', async () => {
    const snapshot = await seedSession('supervised');

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-complete', 'implement the feature', snapshot);
    beginRun('cmd-complete', 'implement the feature');

    completeTurn('implemented the feature');
    await sleep(25);

    const events = timelineEmitter.replay('deck_supervision_brain', 0).events;
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'assistant.text',
        payload: expect.objectContaining({
          automation: true,
          automationKind: 'supervision-complete',
          text: 'Auto: task looks complete.',
        }),
      }),
      expect.objectContaining({
        type: 'agent.status',
        payload: expect.objectContaining({
          status: 'supervision_complete',
          label: 'Supervised: task looks complete.',
        }),
      }),
    ]));
  });

  it('reuses a single visible Auto note id across supervision status transitions', async () => {
    const snapshot = await seedSession('supervised');

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-note-id', 'implement the feature', snapshot);
    beginRun('cmd-note-id', 'implement the feature');

    completeTurn('implemented the feature');
    await sleep(25);

    const noteEvents = timelineEmitter
      .replay('deck_supervision_brain', 0)
      .events
      .filter((event) => event.type === 'assistant.text' && event.payload.automation === true);

    expect(noteEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventId: 'supervision-note:deck_supervision_brain',
        payload: expect.objectContaining({
          text: 'Auto: checking whether the task is complete...',
        }),
      }),
      expect.objectContaining({
        eventId: 'supervision-note:deck_supervision_brain',
        payload: expect.objectContaining({
          text: 'Auto: task looks complete.',
        }),
      }),
    ]));
  });

  it('updates an in-flight run to the latest supervision snapshot when Auto settings change live', async () => {
    const supervised = await seedSession('supervised');
    const upgraded = normalizeSessionSupervisionSnapshot({
      ...supervised,
      mode: 'supervised_audit',
      auditMode: 'audit>plan',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-live', 'implement the feature', supervised);
    supervisionAutomation.applySnapshotUpdate('deck_supervision_brain', upgraded);
    beginRun('cmd-live', 'implement the feature');

    completeTurn('implemented the feature');
    await sleep(25);
    await sleep(25);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).toContain('imcodes send --reply');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({ phase: 'auditing' });
    expect(mockStartP2pRun).not.toHaveBeenCalled();
  });

  it('picks up an in-flight task at idle when Auto is enabled after the user message was already sent', async () => {
    const snapshot = await seedSession('supervised');

    supervisionAutomation.init();
    beginRun('cmd-midturn', 'implement the feature');
    supervisionAutomation.applySnapshotUpdate('deck_supervision_brain', snapshot);

    completeTurn('implemented the feature');
    await sleep(25);

    expect(mockSupervisionDecide).toHaveBeenCalledWith(expect.objectContaining({
      taskRequest: 'implement the feature',
      assistantResponse: 'implemented the feature',
    }));
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
  });

  it('does not evaluate before idle when Auto is enabled after the assistant reply but before the idle boundary', async () => {
    const snapshot = await seedSession('supervised');

    supervisionAutomation.init();
    beginRun('cmd-pre-idle', 'implement the feature');
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'implemented the feature',
      streaming: false,
    });

    supervisionAutomation.applySnapshotUpdate('deck_supervision_brain', snapshot);
    await sleep(25);

    expect(mockSupervisionDecide).not.toHaveBeenCalled();

    timelineEmitter.emit('deck_supervision_brain', 'session.state', {
      state: 'idle',
    });
    await sleep(25);

    expect(mockSupervisionDecide).toHaveBeenCalledWith(expect.objectContaining({
      taskRequest: 'implement the feature',
      assistantResponse: 'implemented the feature',
    }));
  });

  it('cancels active automation immediately when supervision is turned off live', async () => {
    const snapshot = await seedSession('supervised');
    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-off', 'implement the feature', snapshot);

    supervisionAutomation.applySnapshotUpdate('deck_supervision_brain', null);

    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
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

  it('fails closed when a supervised run reaches idle without a completed assistant response', async () => {
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
    const events = timelineEmitter.replay('deck_supervision_brain', 0).events;
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'assistant.text',
        payload: expect.objectContaining({
          automation: true,
          automationKind: 'supervision-warning',
          text: '⚠️ Automation stopped because no completed assistant response was available for that turn. Manual continuation is required.',
        }),
      }),
      expect.objectContaining({
        type: 'agent.status',
        payload: expect.objectContaining({
          status: 'supervision_needs_input',
          label: 'Supervised: returned control to you.',
        }),
      }),
    ]));
  });

  it('evaluates an empty final assistant response instead of skipping the Auto check', async () => {
    const snapshot = await seedSession('supervised');

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-empty-output', 'implement the feature', snapshot);
    beginRun('cmd-empty-output', 'implement the feature');

    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: '',
      streaming: false,
    });
    timelineEmitter.emit('deck_supervision_brain', 'session.state', {
      state: 'idle',
    });
    await sleep(25);

    expect(mockSupervisionDecide).toHaveBeenCalledWith(expect.objectContaining({
      taskRequest: 'implement the feature',
      assistantResponse: '',
    }));
  });

  it('feeds REWORK back into the same transport session after audit', async () => {
    const snapshot = await seedSession('supervised_audit');

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-2', 'implement the feature', snapshot);
    beginRun('cmd-2', 'implement the feature');

    completeTurn('implemented the feature');
    await sleep(25);
    completeDelegatedAudit('REWORK', 'needs fixes');
    await sleep(25);

    expect(mockSupervisionDecide).toHaveBeenCalledTimes(1);
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);
    expect(String(mockTransportRuntime.send.mock.calls[1]?.[0])).toContain('Audit verdict: REWORK');
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

  it('ignores automation-tagged assistant rows when deciding whether an implicit run has a matching completion', async () => {
    const snapshot = await seedSession('supervised');
    supervisionAutomation.init();

    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: 'implement the latest task',
      clientMessageId: 'cmd-transport-control',
      allowDuplicate: true,
    });
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'Switched model to gpt-5.4',
      streaming: false,
      automation: true,
      memoryExcluded: true,
    });
    timelineEmitter.emit('deck_supervision_brain', 'session.state', {
      state: 'idle',
    });
    await sleep(25);

    expect(mockSupervisionDecide).not.toHaveBeenCalled();

    supervisionAutomation.applySnapshotUpdate('deck_supervision_brain', snapshot);
    await sleep(25);

    expect(mockSupervisionDecide).not.toHaveBeenCalled();
  });

  it('routes OpenSpec task runs through the implementation-only OpenSpec audit baseline', async () => {
    const snapshot = await seedSession('supervised_audit', true);
    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-4',
      'finish openspec/changes/supervised-task-automation implementation',
      snapshot,
    );
    timelineEmitter.emit('deck_supervision_brain', 'file.change', {
      batch: {
        provider: 'codex-sdk',
        patches: [{
          filePath: 'src/demo.ts',
          operation: 'update',
          confidence: 'exact',
          unifiedDiff: '@@ -1 +1 @@\n-console.log(\"old\")\n+console.log(\"new\")',
        }],
      },
    });
    timelineEmitter.emit('deck_supervision_brain', 'tool.result', {
      text: 'npm test\nPASS src/demo.test.ts',
    });
    beginRun('cmd-4', 'finish openspec/changes/supervised-task-automation implementation');

    completeTurn('implemented the change');
    await sleep(25);
    await sleep(25);

    const orchestrationPrompt = String(mockTransportRuntime.send.mock.calls[0]?.[0]);
    expect(orchestrationPrompt).toContain('Relevant OpenSpec change:');
    expect(orchestrationPrompt).toContain('openspec/changes/supervised-task-automation');
    expect(orchestrationPrompt).toContain('supervised-task-automation/proposal.md');
    expect(orchestrationPrompt).toContain('changed-files.txt');
    expect(orchestrationPrompt).toContain('validation-output.txt');
    expect(mockStartP2pRun).not.toHaveBeenCalled();
  });

  it('falls back to contextual audit when the task does not resolve to a specific OpenSpec change', async () => {
    const snapshot = await seedSession('supervised_audit', true);

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
    await sleep(25);

    const orchestrationPrompt = String(mockTransportRuntime.send.mock.calls[0]?.[0]);
    expect(orchestrationPrompt).toContain('independently audit this session\'s most recent work');
    expect(orchestrationPrompt).not.toContain('Relevant OpenSpec change:');
  });

  it('dispatches zero rework briefs when maxAuditLoops is zero', async () => {
    const snapshot = await seedSession('supervised_audit', false, 0);

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-loop-zero', 'implement the feature', snapshot);
    beginRun('cmd-loop-zero', 'implement the feature');

    completeTurn('implemented the feature');
    await sleep(25);
    completeDelegatedAudit('REWORK', 'needs fixes');
    await sleep(25);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).toContain('imcodes send --reply');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
  });

  it('dispatches exactly one rework brief for maxAuditLoops one and stops on the next REWORK', async () => {
    const snapshot = await seedSession('supervised_audit', false, 1);

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-loop-one', 'implement the feature', snapshot);
    beginRun('cmd-loop-one', 'implement the feature');

    completeTurn('implemented the feature');
    await sleep(25);
    completeDelegatedAudit('REWORK', 'first audit needs fixes');
    await sleep(25);
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);
    expect(String(mockTransportRuntime.send.mock.calls[1]?.[0])).toContain('Audit verdict: REWORK');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      reworkDispatches: 1,
      phase: 'execution',
    });

    completeTurn('implemented the requested rework');
    await sleep(25);
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(3);
    expect(String(mockTransportRuntime.send.mock.calls[2]?.[0])).toContain('imcodes send --reply');
    completeDelegatedAudit('REWORK', 'second audit still needs fixes');
    await sleep(25);
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(3);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
  });

  it('ignores deprecated combo auditMode and still starts exactly one lightweight peer audit', async () => {
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

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-combo', 'implement the feature', comboSnapshot);
    beginRun('cmd-combo', 'implement the feature');

    completeTurn('implemented the feature');
    await sleep(25);
    await sleep(25);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).toContain('imcodes send --reply');
    expect(mockStartP2pRun).not.toHaveBeenCalled();
  });

  it('keeps manual P2P untouched while deprecated automatic audit>plan uses ordinary reply delegation', async () => {
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

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-ap', 'implement the feature', comboSnapshot);
    beginRun('cmd-ap', 'implement the feature');

    completeTurn('implemented the feature');
    await sleep(25);
    await sleep(25);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).toContain('imcodes send --reply');
    expect(mockStartP2pRun).not.toHaveBeenCalled();
  });
});
