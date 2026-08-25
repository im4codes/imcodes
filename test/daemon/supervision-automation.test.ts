import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  normalizeSessionSupervisionSnapshot,
  SUPERVISION_AUDIT_MARKER_CORRECTION_AUTOMATION_KIND,
  SUPERVISION_AUDIT_TARGET_RECOVERY_AUTOMATION_KIND,
  SUPERVISION_CONTRACT_IDS,
  SUPERVISION_MODE,
  SUPERVISION_UNAVAILABLE_REASONS,
} from '../../shared/supervision-config.js';
import {
  PEER_AUDIT_DEADLINE_MS,
  PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS,
} from '../../shared/peer-audit.js';
import {
  AGENT_DELEGATION_COMPLETION_NOTIFICATION_MARKER,
  AGENT_DELEGATION_REPLY_TIMELINE_EVENT,
  AGENT_DELEGATION_PURPOSES,
  buildAgentDelegationReplyInstruction,
} from '../../shared/agent-delegation.js';
import { createSendDispatchId, createSendMessageId } from '../../shared/send-message-id.js';
import { PROVIDER_ERROR_CODES } from '../../src/agent/transport-provider.js';
import { getCounter, resetMetricsForTests } from '../../src/util/metrics.js';

const mockStartP2pRun = vi.fn();
const mockCancelP2pRun = vi.fn();
const mockGetP2pRun = vi.fn();
// Audit:R3 hardening / task 10.4 — supervision now consults
// `listP2pRuns()` + `loadDaemonP2pStaticPolicy(serverLink)` to honour the
// daemon admission cap. Mock returns "no active runs" so the bounded retry
// helper never trips on `daemon_busy`.
const mockListP2pRuns = vi.fn(() => [] as unknown[]);
const mockSupervisionDecide = vi.fn(async () => ({ decision: 'complete', reason: 'done', confidence: 0.9 }));
let mockTransportRuntimeWorking = false;
const mockTransportRuntime = {
  send: vi.fn(),
  pendingCount: 0,
  pendingMessages: [],
  pendingEntries: [],
  getDiagnosticSnapshot: vi.fn(() => ({
    status: mockTransportRuntimeWorking ? 'running' : 'idle',
    sending: mockTransportRuntimeWorking,
    pendingCount: 0,
    activeDispatchCount: mockTransportRuntimeWorking ? 1 : 0,
    blockingWorkCount: mockTransportRuntimeWorking ? 1 : 0,
  })),
};
let mockAuditTargetStatus = 'idle';
let mockAuditTargetSending = false;
let mockAuditTargetLastProviderError: {
  code: string;
  message: string;
  recoverable: boolean;
  at: number;
} | null = null;
const mockAuditTargetRuntime = {
  send: vi.fn(() => 'sent' as const),
  get lastProviderError() {
    return mockAuditTargetLastProviderError;
  },
  getDiagnosticSnapshot: vi.fn(() => ({
    status: mockAuditTargetStatus,
    sending: mockAuditTargetSending,
    pendingCount: 0,
    activeDispatchCount: mockAuditTargetSending ? 1 : 0,
    blockingWorkCount: mockAuditTargetSending ? 1 : 0,
  })),
};
const mockPersistSessionRecord = vi.fn();

vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({
  startP2pRun: mockStartP2pRun,
  cancelP2pRun: mockCancelP2pRun,
  getP2pRun: mockGetP2pRun,
  listP2pRuns: mockListP2pRuns,
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  getTransportRuntime: vi.fn((sessionName: string) => sessionName === 'deck_sub_reviewer'
    ? mockAuditTargetRuntime
    : mockTransportRuntime),
  persistSessionRecord: mockPersistSessionRecord,
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

// Timeline recovery deliberately reads the durable JSONL tail. Keep that tail
// process-local: audit agents and CI shards can run this file concurrently,
// and fixed session names under the real ~/.imcodes directory otherwise let
// one process delete or recover another process's fixture events.
const originalHome = process.env.HOME;
const originalTimelineProjectionDbPath = process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH;
const supervisionTestHome = await mkdtemp(path.join(os.tmpdir(), 'imcodes-supervision-home-'));
process.env.HOME = supervisionTestHome;
process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH = path.join(
  supervisionTestHome,
  '.imcodes',
  'timeline.sqlite',
);

const {
  supervisionAutomation,
  enrichSnapshotWithGlobalDefaults,
} = await import('../../src/daemon/supervision-automation.js');
const {
  __resetSupervisorDefaultsCacheForTests,
  __setCachedSupervisorDefaultsForTests,
} = await import('../../src/daemon/supervisor-defaults-cache.js');
const { timelineEmitter } = await import('../../src/daemon/timeline-emitter.js');
const { timelineStore } = await import('../../src/daemon/timeline-store.js');
const { flushStore, getSession, upsertSession, removeSession } = await import('../../src/store/session-store.js');
const { createDelegationReplyAuthority } = await import('../../src/daemon/delegation-reply-authority.js');
const { emitDelegationReplyDelivered } = await import('../../src/daemon/delegation-reply-events.js');

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

/** Wait until the automation has finished the run (no active run left).
 *  Same real-check-queue yield as `waitForRunPhase`, so a terminal run cannot
 *  be asserted before the automation has actually torn it down. */
async function waitForRunEnd(timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (supervisionAutomation.getActiveRun('deck_supervision_brain') !== undefined) {
    if (performance.now() >= deadline) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitForTransportSendCount(expectedCount: number, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (mockTransportRuntime.send.mock.calls.length < expectedCount) {
    if (performance.now() >= deadline) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

let projectDir: string | null = null;

beforeEach(async () => {
  supervisionAutomation.cancelSession('deck_supervision_brain');
  supervisionAutomation.cancelSession('deck_sub_reviewer');
  await timelineStore.flushSession('deck_supervision_brain');
  await timelineStore.flushSession('deck_sub_reviewer');
  await rm(timelineStore.filePath('deck_supervision_brain'), { force: true });
  await rm(timelineStore.filePath('deck_sub_reviewer'), { force: true });
  timelineEmitter.forgetSession('deck_supervision_brain');
  timelineEmitter.forgetSession('deck_sub_reviewer');
  vi.clearAllMocks();
  resetMetricsForTests();
  vi.useRealTimers();
  mockSupervisionDecide.mockReset();
  mockSupervisionDecide.mockResolvedValue({ decision: 'complete', reason: 'done', confidence: 0.9 });
  __resetSupervisorDefaultsCacheForTests();
  mockAuditTargetStatus = 'idle';
  mockAuditTargetSending = false;
  mockAuditTargetLastProviderError = null;
  mockTransportRuntimeWorking = false;
  mockAuditTargetRuntime.send.mockReturnValue('sent');
  removeSession('deck_supervision_brain');
  removeSession('deck_sub_reviewer');
});

afterEach(async () => {
  vi.useRealTimers();
  supervisionAutomation.cancelSession('deck_supervision_brain');
  supervisionAutomation.cancelSession('deck_sub_reviewer');
  await timelineStore.flushSession('deck_supervision_brain');
  await timelineStore.flushSession('deck_sub_reviewer');
  timelineEmitter.forgetSession('deck_supervision_brain');
  timelineEmitter.forgetSession('deck_sub_reviewer');
  removeSession('deck_supervision_brain');
  removeSession('deck_sub_reviewer');
  await cleanupProjectDir();
});

afterAll(async () => {
  supervisionAutomation.cancelSession('deck_supervision_brain');
  supervisionAutomation.cancelSession('deck_sub_reviewer');
  removeSession('deck_supervision_brain');
  removeSession('deck_sub_reviewer');
  await timelineStore.flushSession('deck_supervision_brain');
  await timelineStore.flushSession('deck_sub_reviewer');
  await flushStore();
  await rm(supervisionTestHome, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalTimelineProjectionDbPath === undefined) {
    delete process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH;
  } else {
    process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH = originalTimelineProjectionDbPath;
  }
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

function recreateReviewer(label = 'Replacement reviewer') {
  removeSession('deck_sub_reviewer');
  upsertSession({
    name: 'deck_sub_reviewer',
    label,
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
  const reviewer = getSession('deck_sub_reviewer');
  if (!reviewer?.sessionInstanceId) throw new Error('replacement reviewer identity was not created');
  return reviewer;
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

function beginAuditTargetTurn(attemptId: string) {
  timelineEmitter.emit('deck_sub_reviewer', 'user.message', {
    text: [
      'Task: independently audit the current implementation.',
      `Automatic audit attempt ID: ${attemptId}`,
      buildAgentDelegationReplyInstruction('deck_supervision_brain'),
    ].join('\n'),
    allowDuplicate: true,
    sharedActor: { actorUserId: 'deck_supervision_brain' },
  });
  mockAuditTargetStatus = 'running';
  mockAuditTargetSending = true;
  timelineEmitter.emit('deck_sub_reviewer', 'session.state', { state: 'running' });
}

async function startAuditForRecoveryTest(commandId: string) {
  const snapshot = await seedSession('supervised_audit');
  supervisionAutomation.init();
  supervisionAutomation.registerTaskIntent('deck_supervision_brain', commandId, 'implement the feature', snapshot);
  beginRun(commandId, 'implement the feature');
  completeTurn('implemented and validated the feature');
  await waitForRunPhase('auditing');
  const run = supervisionAutomation.getActiveRun('deck_supervision_brain');
  if (!run?.auditAttemptId) throw new Error('automatic audit did not start');
  return run.auditAttemptId;
}

function finishAuditRecoveryTestCleanup() {
  if (supervisionAutomation.getActiveRun('deck_supervision_brain')?.phase === 'auditing') {
    completeDelegatedAudit('PASS', 'Audit recovery test cleanup.');
  }
  supervisionAutomation.cancelSession('deck_supervision_brain');
}

describe('SupervisionAutomation', () => {
  beforeEach(async () => {
    await cleanupProjectDir();
  });

  it('keeps durable recovery fixtures inside the process-local test home', () => {
    const relativeTimelinePath = path.relative(
      supervisionTestHome,
      timelineStore.filePath('deck_supervision_brain'),
    );
    expect(relativeTimelinePath).not.toMatch(/^\.\.(?:\/|\\|$)/u);
    expect(relativeTimelinePath).toBe(path.join('.imcodes', 'timeline', 'deck_supervision_brain.jsonl'));
  });

  it('applies one cached global primary and backup runtime to every legacy session snapshot', async () => {
    const snapshot = await seedSession('supervised', false, 2, {
      backend: 'claude-code-sdk',
      model: 'sonnet',
      timeoutMs: 45_000,
    });
    __setCachedSupervisorDefaultsForTests({
      backend: 'qwen',
      model: 'qwen3-coder-plus',
      preset: 'Qwen Team',
      backupBackend: 'codex-sdk',
      backupModel: 'gpt-5.3-codex-spark',
      timeoutMs: 30_000,
      promptVersion: 'supervision_decision_v1',
      customInstructions: 'Use the account-level runtime.',
    });

    expect(enrichSnapshotWithGlobalDefaults(snapshot)).toMatchObject({
      mode: 'supervised',
      backend: 'qwen',
      model: 'qwen3-coder-plus',
      preset: 'Qwen Team',
      backupBackend: 'codex-sdk',
      backupModel: 'gpt-5.3-codex-spark',
      timeoutMs: 30_000,
      globalCustomInstructions: 'Use the account-level runtime.',
    });
  });

  it('skips peer audit when the supervisor classifies a completed turn as ordinary read-only work', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'complete',
      reason: 'read-only deployment status check is complete',
      confidence: 0.96,
      requiresAudit: false,
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-read-only-check',
      '检查当前测试环境的部署状态',
      snapshot,
    );
    beginRun('cmd-read-only-check', '检查当前测试环境的部署状态');

    completeTurn('当前环境尚未部署最新提交。');
    await sleep(25);

    expect(mockTransportRuntime.send).not.toHaveBeenCalled();
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
    expect(timelineEmitter.replay('deck_supervision_brain', 0).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'assistant.text',
        payload: expect.objectContaining({
          automationKind: 'supervision-audit-skipped',
        }),
      }),
    ]));
  });

  it('forces peer audit when the supervisor misclassifies completed engineering and push as read-only', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'complete',
      reason: 'The completion report needs no additional review.',
      confidence: 0.97,
      requiresAudit: false,
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-model-skipped-audit',
      '修复桌面墙独立打开和状态恢复，然后提交并推送',
      snapshot,
    );
    beginRun('cmd-model-skipped-audit', '修复桌面墙独立打开和状态恢复，然后提交并推送');
    completeTurn([
      '全量 Web 测试与生产构建已经通过。',
      '已完成并推送到 dev。',
      '- Commit: 6cb4ac9ce fix(remote-desktop): expose wall state and standalone view',
      '- Push: origin/dev 成功',
    ].join('\n'));
    await sleep(25);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).toContain('Automatic audit attempt ID:');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      requiresAudit: false,
    });
    completeDelegatedAudit('PASS', 'Forced audit cleanup passed.');
    await sleep(25);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
  });

  it('adopts an existing reply-enabled audit delegation and sends no second request before its receipt', async () => {
    const snapshot = await seedSession('supervised_audit');

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-existing-audit',
      'implement the feature',
      snapshot,
    );
    beginRun('cmd-existing-audit', 'implement the feature');

    timelineEmitter.emit('deck_sub_reviewer', 'user.message', {
      text: [
        'Task: Independently audit the completed implementation and return PASS or REWORK.',
        buildAgentDelegationReplyInstruction('deck_supervision_brain'),
      ].join('\n'),
      allowDuplicate: true,
      sharedActor: { actorUserId: 'deck_supervision_brain', actorDisplayName: 'Brain' },
    });

    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      requiresAudit: false,
      auditReplyObserved: false,
    });
    expect(mockTransportRuntime.send).not.toHaveBeenCalled();

    completeTurn('已将只读审计交给 CC1，等待 PASS/REWORK 回执。');
    await sleep(25);
    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'idle' });
    await sleep(25);

    expect(mockSupervisionDecide).not.toHaveBeenCalled();
    expect(mockTransportRuntime.send).not.toHaveBeenCalled();
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      requiresAudit: false,
      auditReplyObserved: false,
    });

    completeDelegatedAudit('PASS', 'Existing delegated audit passed.');
    await sleep(25);

    expect(mockTransportRuntime.send).not.toHaveBeenCalled();
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
  });

  it('binds the ordinary imcodes send --reply fallback and accepts one anchored text PASS', async () => {
    const snapshot = await seedSession('supervised_audit');
    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-legacy-cli-audit',
      'implement and independently audit the feature',
      snapshot,
    );
    beginRun('cmd-legacy-cli-audit', 'implement and independently audit the feature');

    const origin = getSession('deck_supervision_brain');
    const target = getSession('deck_sub_reviewer');
    if (!target) throw new Error('reviewer was not seeded');
    const authority = createDelegationReplyAuthority({
      origin,
      target,
      dispatchId: createSendDispatchId(),
      messageId: createSendMessageId(),
    });
    if (!authority) throw new Error('legacy delegation authority was not created');

    timelineEmitter.emit('deck_sub_reviewer', 'user.message', {
      text: [
        'Task: independently audit the completed implementation and return PASS or REWORK.',
        'Automatic audit attempt ID: cli_fallback_audit_1',
        buildAgentDelegationReplyInstruction('deck_supervision_brain', authority.authority),
      ].join('\n'),
      allowDuplicate: true,
      sharedActor: { actorUserId: 'deck_supervision_brain' },
    });

    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      auditAttemptId: 'cli_fallback_audit_1',
      auditDelegationId: authority.record.delegationId,
      auditReplyObserved: false,
    });

    emitDelegationReplyDelivered({
      ...authority.record,
      status: 'delivered',
      result: 'Independent checks passed.',
      deliveredAt: Date.now(),
    });
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: '## 独立审计: PASS\n\nFocused tests and typecheck passed.',
      streaming: false,
    });
    await sleep(10);

    expect(mockTransportRuntime.send).not.toHaveBeenCalled();
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
  });

  it('skips a model-requested duplicate audit after the completed turn reports an independent PASS', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'continue',
      reason: 'No reply-enabled audit was observed, so another audit brief should be sent.',
      confidence: 0.9,
      requiresAudit: true,
      gap: 'A reply-enabled peer audit request has not been dispatched.',
      nextAction: 'Construct and send a reply-enabled independent audit brief to the configured auditor.',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-redundant-audit',
      'fix, audit, commit, and push the bug',
      snapshot,
    );
    beginRun('cmd-redundant-audit', 'fix, audit, commit, and push the bug');
    completeTurn([
      '修复、测试、提交和推送均已完成。',
      '审计 PASS，并已完成推送。',
      '- HEAD == origin/dev',
    ].join('\n'));
    await sleep(25);

    expect(mockTransportRuntime.send).not.toHaveBeenCalled();
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
    expect(timelineEmitter.replay('deck_supervision_brain', 0).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'assistant.text',
        payload: expect.objectContaining({ automationKind: 'supervision-audit-already-passed' }),
      }),
    ]));
  });

  it('passes recent task turns and structured peer-audit results to the supervisor model', async () => {
    const snapshot = await seedSession('supervised');
    const sessionInstanceId = getSession('deck_supervision_brain')?.sessionInstanceId;
    expect(sessionInstanceId).toBeTruthy();
    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-recent-evidence',
      'finish the current bug fix',
      snapshot,
    );
    beginRun('cmd-recent-evidence', 'finish the current bug fix');
    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: 'Also verify the audit result before finishing.',
      clientMessageId: 'cmd-recent-refinement',
    });
    timelineEmitter.emit('deck_supervision_brain', 'peer_audit.result', {
      memoryExcluded: true,
      trigger: 'automatic',
      outcome: 'pass',
      auditorSessionName: 'deck_sub_reviewer',
      elapsedMs: 123,
      findingsPreview: 'Focused tests passed.',
    });
    completeTurn('The audited fix is complete.');
    await sleep(25);

    expect(mockSupervisionDecide).toHaveBeenCalledWith(expect.objectContaining({
      targetSessionId: sessionInstanceId,
      recentEvidence: expect.arrayContaining([
        expect.objectContaining({ kind: 'user', text: 'Also verify the audit result before finishing.' }),
        expect.objectContaining({
          kind: 'peer_audit_result',
          outcome: 'pass',
          auditorSessionName: 'deck_sub_reviewer',
          findings: 'Focused tests passed.',
        }),
      ]),
    }));
  });

  it('adopts the production v1 终审 wording once and keeps deferred 211 validation behind PASS', async () => {
    const snapshot = await seedSession('supervised_audit');
    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-production-final-audit',
      '开始实现审计后 在211 完整测试 全部通过后推送',
      snapshot,
    );
    beginRun('cmd-production-final-audit', '开始实现审计后 在211 完整测试 全部通过后推送');

    timelineEmitter.emit('deck_sub_reviewer', 'user.message', {
      text: [
        'Task: 独立只读终审当前未提交实现，完成后回复 PASS 或 REWORK。',
        buildAgentDelegationReplyInstruction('deck_supervision_brain'),
      ].join('\n'),
      allowDuplicate: true,
      sharedActor: { actorUserId: 'deck_supervision_brain' },
    });

    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      requiresAudit: false,
      auditReplyObserved: false,
      deferredFinalization: {
        nextAction: expect.stringContaining('post-audit tests'),
      },
    });

    completeTurn('已发送终审，等待 CC1 回复。');
    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'idle' });
    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'idle' });
    await sleep(25);

    expect(mockSupervisionDecide).not.toHaveBeenCalled();
    expect(mockTransportRuntime.send).not.toHaveBeenCalled();
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      auditReplyObserved: false,
    });

    completeDelegatedAudit('PASS', 'Production wording audit passed.');
    await sleep(10);
    completeTurn('211 full validation and repository finalization completed.');
    await waitForRunEnd();
  });

  it('does not misclassify an ordinary reply-enabled delegation to the configured auditor', async () => {
    const snapshot = await seedSession('supervised_audit');
    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-ordinary-delegation',
      'implement the feature',
      snapshot,
    );
    beginRun('cmd-ordinary-delegation', 'implement the feature');

    timelineEmitter.emit('deck_sub_reviewer', 'user.message', {
      text: [
        'Task: brainstorm alternative names for this feature.',
        buildAgentDelegationReplyInstruction('deck_supervision_brain'),
      ].join('\n'),
      allowDuplicate: true,
      sharedActor: { actorUserId: 'deck_supervision_brain' },
    });

    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'execution',
    });
  });

  it('does not misclassify an ordinary v2 delegation authority as a supervised audit', async () => {
    const snapshot = await seedSession('supervised_audit');
    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-ordinary-structured-delegation',
      'implement the feature',
      snapshot,
    );
    beginRun('cmd-ordinary-structured-delegation', 'implement the feature');

    const origin = getSession('deck_supervision_brain');
    const target = getSession('deck_sub_reviewer');
    if (!target) throw new Error('reviewer was not seeded');
    const authority = createDelegationReplyAuthority({
      origin,
      target,
      dispatchId: createSendDispatchId(),
      messageId: createSendMessageId(),
    });
    if (!authority) throw new Error('ordinary delegation authority was not created');

    timelineEmitter.emit('deck_sub_reviewer', 'user.message', {
      text: [
        'Task: brainstorm alternative names for this feature.',
        buildAgentDelegationReplyInstruction('deck_supervision_brain', authority.authority),
      ].join('\n'),
      allowDuplicate: true,
      sharedActor: { actorUserId: 'deck_supervision_brain' },
    });

    const activeRun = supervisionAutomation.getActiveRun('deck_supervision_brain');
    expect(activeRun).toMatchObject({ phase: 'execution' });
    expect(activeRun).not.toHaveProperty('auditDelegationId');
    expect(mockTransportRuntime.send).not.toHaveBeenCalled();
  });

  it('registers a v2 audit by delegation authority and releases deferred validation only after its delivery', async () => {
    const snapshot = await seedSession('supervised_audit');
    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-structured-audit',
      '审计 PASS 后在 211 完整测试，全部通过后提交并推送',
      snapshot,
    );
    beginRun('cmd-structured-audit', '审计 PASS 后在 211 完整测试，全部通过后提交并推送');

    const origin = getSession('deck_supervision_brain');
    const target = getSession('deck_sub_reviewer');
    if (!target) throw new Error('reviewer was not seeded');
    const authority = createDelegationReplyAuthority({
      origin,
      target,
      dispatchId: createSendDispatchId(),
      messageId: createSendMessageId(),
      audit: {
        kind: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
        attemptId: 'automatic_audit_attempt_structured_1',
      },
    });
    if (!authority) throw new Error('structured audit authority was not created');

    timelineEmitter.emit('deck_sub_reviewer', 'user.message', {
      text: [
        'Task: this text intentionally contains no audit keyword.',
        buildAgentDelegationReplyInstruction('deck_supervision_brain', authority.authority),
      ].join('\n'),
      allowDuplicate: true,
      sharedActor: { actorUserId: 'deck_supervision_brain' },
    });

    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      auditAttemptId: 'automatic_audit_attempt_structured_1',
      auditDelegationId: authority.record.delegationId,
      auditReplyObserved: false,
      deferredFinalization: expect.any(Object),
    });

    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'idle' });
    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'idle' });
    await sleep(10);
    expect(mockSupervisionDecide).not.toHaveBeenCalled();
    expect(mockTransportRuntime.send).not.toHaveBeenCalled();

    emitDelegationReplyDelivered({
      ...authority.record,
      status: 'delivered',
      result: 'PASS with independent evidence.',
      deliveredAt: Date.now(),
    });
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      auditDelegationId: authority.record.delegationId,
      auditReplyObserved: true,
    });

    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: `Structured audit passed.\n${PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS.PASS}`,
      streaming: false,
    });
    await sleep(10);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).toContain('在 211 完整测试');
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).toContain('post-audit tests');
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).not.toContain('Target ID (pass directly to send_message; do not look it up):');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'finalizing',
    });
  });

  it('does not treat a structured audit completion notification as a new task after PASS', async () => {
    const snapshot = await seedSession('supervised_audit');
    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-structured-audit-no-repeat',
      'implement the feature',
      snapshot,
    );

    const origin = getSession('deck_supervision_brain');
    const target = getSession('deck_sub_reviewer');
    if (!target) throw new Error('reviewer was not seeded');
    const authority = createDelegationReplyAuthority({
      origin,
      target,
      dispatchId: createSendDispatchId(),
      messageId: createSendMessageId(),
      audit: {
        kind: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
        attemptId: 'automatic_audit_attempt_no_repeat',
      },
    });
    if (!authority) throw new Error('structured audit authority was not created');

    timelineEmitter.emit('deck_sub_reviewer', 'user.message', {
      text: [
        'Task: independently audit this implementation.',
        buildAgentDelegationReplyInstruction('deck_supervision_brain', authority.authority),
      ].join('\n'),
      allowDuplicate: true,
      sharedActor: { actorUserId: 'deck_supervision_brain' },
    });

    // Runtime delivery sends the trusted completion notification into the
    // origin timeline before the delivered event opens the verdict gate.
    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: [
        AGENT_DELEGATION_COMPLETION_NOTIFICATION_MARKER,
  AGENT_DELEGATION_REPLY_TIMELINE_EVENT,
        'A delegated agent completed the requested work.',
        `Delegation ID: ${authority.record.delegationId}`,
        'From session: deck_sub_reviewer',
        '',
        'RECOMMENDATION: PASS',
      ].join('\n'),
      allowDuplicate: true,
    });
    emitDelegationReplyDelivered({
      ...authority.record,
      status: 'delivered',
      result: 'RECOMMENDATION: PASS',
      deliveredAt: Date.now(),
    });

    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: `Structured audit passed.\n${PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS.PASS}`,
      streaming: false,
    });
    await sleep(10);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();

    mockSupervisionDecide.mockClear();
    mockTransportRuntime.send.mockClear();
    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'idle' });
    await sleep(25);

    expect(mockSupervisionDecide).not.toHaveBeenCalled();
    expect(mockTransportRuntime.send).not.toHaveBeenCalled();
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
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
    expect(orchestrationPrompt).toContain('Target ID (pass directly to send_message; do not look it up): deck_sub_reviewer');
    expect(orchestrationPrompt).toContain('imcodes send --reply "deck_sub_reviewer"');
    expect(orchestrationPrompt).toContain('send exactly one reply-enabled audit request to deck_sub_reviewer');
    expect(orchestrationPrompt).toContain('Include this exact attempt ID in the delegated audit brief');
    expect(orchestrationPrompt).toContain('"kind":"supervision_audit"');
    expect(orchestrationPrompt).toContain('"attemptId":');
    expect(orchestrationPrompt).toContain('Do not choose another session or send a second audit');
    expect(orchestrationPrompt).toContain('You—not the daemon—must prepare the brief');
    expect(orchestrationPrompt).toContain('do not modify, commit, push, or deploy');
    expect(orchestrationPrompt).not.toContain('A reply-enabled send gives the delegate');
    expect(orchestrationPrompt).not.toContain('If the user selected or mentioned multiple @ delegates');
    expect(Buffer.byteLength(orchestrationPrompt, 'utf8')).toBeLessThan(5 * 1024);
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
    expect(mockSupervisionDecide).toHaveBeenCalledTimes(1);
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);

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

  it('continues the exact audit target after its correlated turn falls idle with a provider error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const attemptId = await startAuditForRecoveryTest('cmd-audit-target-provider-error');

      // An idle/error projection before the delegated audit task is observed
      // belongs to older target work and must never trigger recovery.
      mockAuditTargetLastProviderError = {
        code: 'OVERLOADED',
        message: 'provider overloaded',
        recoverable: true,
        at: Date.now(),
      };
      timelineEmitter.emit('deck_sub_reviewer', 'session.state', { state: 'idle' });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockAuditTargetRuntime.send).not.toHaveBeenCalled();

      beginAuditTargetTurn(attemptId);
      mockAuditTargetStatus = 'idle';
      mockAuditTargetSending = false;
      mockAuditTargetLastProviderError = {
        code: 'OVERLOADED',
        message: 'provider overloaded',
        recoverable: true,
        at: Date.now(),
      };
      timelineEmitter.emit('deck_sub_reviewer', 'session.state', { state: 'idle' });

      await vi.advanceTimersByTimeAsync(1_499);
      expect(mockAuditTargetRuntime.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(mockAuditTargetRuntime.send).toHaveBeenCalledTimes(1);
      const recoveryPrompt = String(mockAuditTargetRuntime.send.mock.calls[0]?.[0]);
      expect(recoveryPrompt).toContain(`[Contract: ${SUPERVISION_CONTRACT_IDS.AUDIT_TARGET_RECOVERY}]`);
      expect(recoveryPrompt).toContain(`Automatic audit attempt ID: ${attemptId}`);
      expect(recoveryPrompt).toContain('Audited session ID: deck_supervision_brain');
      expect(recoveryPrompt).toContain('Audit target session ID: deck_sub_reviewer');
      expect(recoveryPrompt).toContain(buildAgentDelegationReplyInstruction('deck_supervision_brain'));
      expect(timelineEmitter.replay('deck_sub_reviewer', 0).events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'user.message',
          payload: expect.objectContaining({
            automation: true,
            automationKind: SUPERVISION_AUDIT_TARGET_RECOVERY_AUTOMATION_KIND,
          }),
        }),
      ]));

      // Duplicate idle/error projections for the same failed turn are
      // de-duplicated until a new active edge proves that recovery started.
      timelineEmitter.emit('deck_sub_reviewer', 'session.state', { state: 'idle' });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockAuditTargetRuntime.send).toHaveBeenCalledTimes(1);

      // A delivered recovery receives a fresh audit deadline instead of
      // timing out at the original deadline while the reviewer is resuming.
      await vi.advanceTimersByTimeAsync(PEER_AUDIT_DEADLINE_MS - 2_001);
      expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({ phase: 'auditing' });
      await vi.advanceTimersByTimeAsync(1);
      expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
    } finally {
      finishAuditRecoveryTestCleanup();
      vi.useRealTimers();
    }
  });

  it('continues a correlated audit target after its active turn enters stopped state', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const attemptId = await startAuditForRecoveryTest('cmd-audit-target-stopped');
      beginAuditTargetTurn(attemptId);
      mockAuditTargetStatus = 'idle';
      mockAuditTargetSending = false;
      mockAuditTargetLastProviderError = null;
      timelineEmitter.emit('deck_sub_reviewer', 'session.state', { state: 'stopped' });

      await vi.advanceTimersByTimeAsync(1_500);
      expect(mockAuditTargetRuntime.send).toHaveBeenCalledTimes(1);
      expect(String(mockAuditTargetRuntime.send.mock.calls[0]?.[0])).toContain('Observed failed state: stopped');
    } finally {
      finishAuditRecoveryTestCleanup();
      vi.useRealTimers();
    }
  });

  it('does not continue a correlated audit target after a healthy idle completion', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const attemptId = await startAuditForRecoveryTest('cmd-audit-target-healthy-idle');
      beginAuditTargetTurn(attemptId);
      mockAuditTargetStatus = 'idle';
      mockAuditTargetSending = false;
      mockAuditTargetLastProviderError = null;
      timelineEmitter.emit('deck_sub_reviewer', 'session.state', { state: 'idle' });

      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockAuditTargetRuntime.send).not.toHaveBeenCalled();
    } finally {
      finishAuditRecoveryTestCleanup();
      vi.useRealTimers();
    }
  });

  it('cancels a scheduled audit-target continue when the same turn becomes active again or returns its reply', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const attemptId = await startAuditForRecoveryTest('cmd-audit-target-recovers');
      beginAuditTargetTurn(attemptId);
      mockAuditTargetStatus = 'idle';
      mockAuditTargetSending = false;
      mockAuditTargetLastProviderError = {
        code: 'TRANSIENT',
        message: 'temporary failure',
        recoverable: true,
        at: Date.now(),
      };
      timelineEmitter.emit('deck_sub_reviewer', 'session.state', { state: 'error' });

      await vi.advanceTimersByTimeAsync(500);
      mockAuditTargetStatus = 'running';
      mockAuditTargetSending = true;
      timelineEmitter.emit('deck_sub_reviewer', 'session.state', { state: 'running' });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockAuditTargetRuntime.send).not.toHaveBeenCalled();

      mockAuditTargetStatus = 'idle';
      mockAuditTargetSending = false;
      mockAuditTargetLastProviderError = {
        code: 'TRANSIENT_AGAIN',
        message: 'temporary failure again',
        recoverable: true,
        at: Date.now(),
      };
      timelineEmitter.emit('deck_sub_reviewer', 'session.state', { state: 'error' });
      completeDelegatedAudit('PASS', 'The audit completed before recovery backoff elapsed.');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockAuditTargetRuntime.send).not.toHaveBeenCalled();
      expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
    } finally {
      finishAuditRecoveryTestCleanup();
      vi.useRealTimers();
    }
  });

  it('caps audit-target recovery at two continues', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const attemptId = await startAuditForRecoveryTest('cmd-audit-target-recovery-cap');
      beginAuditTargetTurn(attemptId);

      for (let recovery = 1; recovery <= 2; recovery += 1) {
        mockAuditTargetStatus = 'error';
        mockAuditTargetSending = false;
        mockAuditTargetLastProviderError = {
          code: `TRANSIENT_${recovery}`,
          message: `temporary failure ${recovery}`,
          recoverable: true,
          at: Date.now(),
        };
        timelineEmitter.emit('deck_sub_reviewer', 'session.state', { state: 'error' });
        await vi.advanceTimersByTimeAsync(1_500);
        expect(mockAuditTargetRuntime.send).toHaveBeenCalledTimes(recovery);
        mockAuditTargetStatus = 'running';
        mockAuditTargetSending = true;
        timelineEmitter.emit('deck_sub_reviewer', 'session.state', { state: 'running' });
        await vi.advanceTimersByTimeAsync(1);
      }

      mockAuditTargetStatus = 'error';
      mockAuditTargetSending = false;
      timelineEmitter.emit('deck_sub_reviewer', 'session.state', { state: 'error' });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockAuditTargetRuntime.send).toHaveBeenCalledTimes(2);
      expect(timelineEmitter.replay('deck_supervision_brain', 0).events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'assistant.text',
          payload: expect.objectContaining({
            text: expect.stringContaining('automatic recovery limit'),
            automationKind: 'supervision-warning',
          }),
        }),
      ]));
    } finally {
      finishAuditRecoveryTestCleanup();
      vi.useRealTimers();
    }
  });

  it('does not continue a replacement session that reused the configured audit target name', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const attemptId = await startAuditForRecoveryTest('cmd-audit-target-identity-change');
      beginAuditTargetTurn(attemptId);
      mockAuditTargetStatus = 'error';
      mockAuditTargetSending = false;
      timelineEmitter.emit('deck_sub_reviewer', 'session.state', { state: 'error' });
      recreateReviewer();
      await vi.advanceTimersByTimeAsync(1_500);

      expect(mockAuditTargetRuntime.send).not.toHaveBeenCalled();
      expect(timelineEmitter.replay('deck_supervision_brain', 0).events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'assistant.text',
          payload: expect.objectContaining({
            text: expect.stringContaining('changed identity'),
            automationKind: 'supervision-warning',
          }),
        }),
      ]));
    } finally {
      finishAuditRecoveryTestCleanup();
      vi.useRealTimers();
    }
  });

  it('settles a reply-backed PASS immediately without a later idle edge or false timeout', async () => {
    const snapshot = await seedSession('supervised_audit');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      supervisionAutomation.init();
      supervisionAutomation.registerTaskIntent(
        'deck_supervision_brain',
        'cmd-pass-without-idle',
        'implement the feature',
        snapshot,
      );
      beginRun('cmd-pass-without-idle', 'implement the feature');
      completeTurn('implemented the feature');
      await waitForRunPhase('auditing');
      expect(supervisionAutomation.getActiveRun('deck_supervision_brain')?.auditAttemptId).toBeTruthy();
      const priorResultCount = timelineEmitter.replay('deck_supervision_brain', 0).events.filter((event) =>
        event.type === 'peer_audit.result').length;

      timelineEmitter.emit('deck_supervision_brain', 'user.message', {
        text: 'Task: independent audit\nResult: PASS with evidence.',
        allowDuplicate: true,
      });
      timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
        text: `PASS with evidence.\n${PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS.PASS}`,
        streaming: false,
      });
      await Promise.resolve();

      // Intentionally do not emit session.state=idle. The final assistant
      // boundary must settle the audit and disarm the six-minute deadline.
      expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
      await vi.advanceTimersByTimeAsync(PEER_AUDIT_DEADLINE_MS);

      const results = timelineEmitter.replay('deck_supervision_brain', 0).events.filter((event) =>
        event.type === 'peer_audit.result').slice(priorResultCount);
      expect(results.filter((event) => event.payload.outcome === 'pass')).toHaveLength(1);
      expect(results.filter((event) => event.payload.outcome === 'timeout')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat finalized intermediate tool-round text as the final audit judgment', async () => {
    const snapshot = await seedSession('supervised_audit');
    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-multi-message-audit-turn',
      'implement the feature',
      snapshot,
    );
    beginRun('cmd-multi-message-audit-turn', 'implement the feature');
    completeTurn('implemented the feature');
    await waitForRunPhase('auditing');

    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: 'Task: independent audit\nResult: PASS with evidence.',
      allowDuplicate: true,
    });
    // Some providers finalize one assistant text block before each tool call.
    // The origin session can still look idle from the previous turn, so the
    // runtime activity snapshot is the load-bearing guard here.
    mockTransportRuntimeWorking = true;
    for (const text of [
      'I am checking the changed files.',
      'The focused tests are running.',
      'I am reconciling the evidence.',
    ]) {
      timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
        text,
        streaming: false,
      });
      await Promise.resolve();
    }

    const warningsBeforeFinal = timelineEmitter.replay('deck_supervision_brain', 0).events.filter((event) =>
      event.type === 'assistant.text'
      && event.payload.automationKind === 'supervision-warning'
      && String(event.payload.text ?? '').includes('PASS/REWORK audit marker'));
    expect(warningsBeforeFinal).toHaveLength(0);
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      auditReplyObserved: true,
    });

    mockTransportRuntimeWorking = false;
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: `Concrete findings: no blocker.\n${PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS.PASS}`,
      streaming: false,
    });
    await Promise.resolve();

    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
    const warningsAfterFinal = timelineEmitter.replay('deck_supervision_brain', 0).events.filter((event) =>
      event.type === 'assistant.text'
      && event.payload.automationKind === 'supervision-warning'
      && String(event.payload.text ?? '').includes('PASS/REWORK audit marker'));
    expect(warningsAfterFinal).toHaveLength(0);
  });

  it('self-corrects one missing audit marker and de-duplicates later warnings', async () => {
    const snapshot = await seedSession('supervised_audit');
    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-audit-marker-correction',
      'implement the feature',
      snapshot,
    );
    beginRun('cmd-audit-marker-correction', 'implement the feature');
    completeTurn('implemented the feature');
    await waitForRunPhase('auditing');
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);

    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: 'Task: independent audit\nResult: PASS with evidence.',
      allowDuplicate: true,
    });
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'Concrete findings are clean, but this response omitted the control marker.',
      streaming: false,
    });
    await Promise.resolve();

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);
    const correctionPrompt = String(mockTransportRuntime.send.mock.calls[1]?.[0]);
    expect(correctionPrompt).toContain(`[Contract: ${SUPERVISION_CONTRACT_IDS.AUDIT_MARKER_CORRECTION}]`);
    expect(correctionPrompt).toContain(PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS.PASS);
    expect(correctionPrompt).toContain(PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS.REWORK);
    expect(correctionPrompt).toContain('Do not delegate again');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      auditVerdictCorrectionAttempts: 1,
      sawAssistantOutput: false,
    });

    // If the bounded correction is malformed too, repeated final/idle
    // projections surface only one warning rather than one per projection.
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'Still missing the exact marker.',
      streaming: false,
    });
    await Promise.resolve();
    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'idle' });
    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'idle' });

    const warnings = timelineEmitter.replay('deck_supervision_brain', 0).events.filter((event) =>
      event.type === 'assistant.text'
      && event.payload.automationKind === 'supervision-warning'
      && String(event.payload.text ?? '').includes('PASS/REWORK audit marker'));
    expect(warnings).toHaveLength(1);
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);
    expect(timelineEmitter.replay('deck_supervision_brain', 0).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'user.message',
        payload: expect.objectContaining({
          automationKind: SUPERVISION_AUDIT_MARKER_CORRECTION_AUTOMATION_KIND,
        }),
      }),
    ]));

    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: `Concrete findings: no blocker.\n${PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS.PASS}`,
      streaming: false,
    });
    await Promise.resolve();
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
  });

  it('ignores the audit turn idle when it arrives after fallback settlement starts finalization', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide
      .mockResolvedValueOnce({
        decision: 'continue',
        reason: 'implementation is complete but repository finalization remains',
        confidence: 0.9,
        nextAction: 'Commit and push the audited changes.',
      })
      .mockResolvedValueOnce({
        decision: 'complete',
        reason: 'post-audit finalization completed',
        confidence: 0.95,
      });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-delayed-audit-idle',
      'implement the feature',
      snapshot,
    );
    beginRun('cmd-delayed-audit-idle', 'implement the feature');
    completeTurn('Implementation is complete; commit and push remain.');
    await waitForRunPhase('auditing');
    const priorPassCount = timelineEmitter.replay('deck_supervision_brain', 0).events.filter((event) =>
      event.type === 'peer_audit.result' && event.payload.outcome === 'pass').length;

    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: 'Task: independent audit\nResult: PASS with evidence.',
      allowDuplicate: true,
    });
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: `PASS with evidence.\n${PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS.PASS}`,
      streaming: false,
    });
    await Promise.resolve();

    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({ phase: 'finalizing' });
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);

    // This is the trailing idle for the audit turn, delivered after the
    // assistant-text fallback has already dispatched finalization. It must
    // not evaluate the PASS text as finalization output or terminate the run.
    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'idle' });
    expect(mockSupervisionDecide).toHaveBeenCalledTimes(1);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({ phase: 'finalizing' });

    completeTurn('Committed and pushed the audited changes.');
    await sleep(25);

    expect(mockSupervisionDecide).toHaveBeenCalledTimes(2);
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'idle' });
    await Promise.resolve();
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);
    const results = timelineEmitter.replay('deck_supervision_brain', 0).events.filter((event) =>
      event.type === 'peer_audit.result');
    expect(results.filter((event) => event.payload.outcome === 'pass')).toHaveLength(priorPassCount + 1);
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
    expect(new Set(cancelled.map((event) => event.eventId)).size).toBe(1);
    expect(getCounter('peer_audit.terminal', {
      contractVersion: 'peer_audit_v1',
      disposition: 'sent',
      outcome: 'cancelled',
      reason: 'session_supervision_cancelled',
      trigger: 'automatic',
    })).toBe(1);
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

  it('delegates to the current same-name session without blocking on a stale fingerprint', async () => {
    const snapshot = await seedSession('supervised_audit');
    const replacement = recreateReviewer();

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-stale-auditor', 'implement the feature', snapshot);
    beginRun('cmd-stale-auditor', 'implement the feature');
    completeTurn('implemented the feature');
    await sleep(50);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).toContain('imcodes send --reply');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      auditTargetSessionInstanceId: replacement.sessionInstanceId,
      snapshot: { auditTargetSessionName: replacement.name },
    });
  });

  it('starts automatic audit from a name-only target saved by settings', async () => {
    const snapshot = await seedSession('supervised_audit', false, 2, {
      auditTargetFingerprint: undefined,
    });
    expect(snapshot.auditTargetSessionName).toBe('deck_sub_reviewer');
    expect(snapshot.auditTargetFingerprint).toBeUndefined();

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-name-only-auditor', 'implement the feature', snapshot);
    beginRun('cmd-name-only-auditor', 'implement the feature');
    completeTurn('implemented the feature');
    await sleep(50);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).toContain('Target ID (pass directly to send_message; do not look it up): deck_sub_reviewer');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      snapshot: { auditTargetSessionName: 'deck_sub_reviewer' },
    });
  });

  it('uses the latest persisted target name when an in-flight snapshot is stale', async () => {
    const staleSnapshot = await seedSession('supervised_audit');
    const replacement = recreateReviewer('Repaired reviewer');
    const repairedSnapshot = normalizeSessionSupervisionSnapshot({
      ...staleSnapshot,
      auditTargetSessionName: replacement.name,
      auditTargetFingerprint: {
        sessionInstanceId: replacement.sessionInstanceId,
        normalizedModelId: 'claude-sonnet-4-6',
        providerFamily: 'anthropic',
      },
    });
    const audited = getSession('deck_supervision_brain');
    if (!audited) throw new Error('audited session was not created');
    upsertSession({
      ...audited,
      transportConfig: { ...audited.transportConfig, supervision: repairedSnapshot },
      updatedAt: Date.now(),
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-repaired-auditor',
      'implement the feature',
      staleSnapshot,
    );
    beginRun('cmd-repaired-auditor', 'implement the feature');
    completeTurn('implemented the feature');
    await sleep(50);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).toContain('imcodes send --reply');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      snapshot: {
        auditTargetSessionName: replacement.name,
      },
      auditTargetSessionInstanceId: replacement.sessionInstanceId,
    });
  });

  it('does not require or rewrite model fingerprint metadata before delegating', async () => {
    const initial = await seedSession('supervised_audit');
    const reviewer = getSession('deck_sub_reviewer');
    const audited = getSession('deck_supervision_brain');
    if (!reviewer?.sessionInstanceId || !audited) throw new Error('seeded sessions are unavailable');
    const aliasSnapshot = normalizeSessionSupervisionSnapshot({
      ...initial,
      auditTargetFingerprint: {
        sessionInstanceId: reviewer.sessionInstanceId,
        normalizedModelId: 'opus[1m]',
        providerFamily: 'anthropic',
      },
    });
    upsertSession({
      ...reviewer,
      requestedModel: 'opus',
      modelDisplay: 'claude-opus-4-8',
      activeModel: 'claude-opus-4-8',
      updatedAt: Date.now(),
    });
    upsertSession({
      ...audited,
      transportConfig: { ...audited.transportConfig, supervision: aliasSnapshot },
      updatedAt: Date.now(),
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-authoritative-model-repair',
      'implement the feature',
      aliasSnapshot,
    );
    beginRun('cmd-authoritative-model-repair', 'implement the feature');
    completeTurn('implemented the feature');
    await waitForRunPhase('auditing');

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      snapshot: {
        auditTargetFingerprint: {
          sessionInstanceId: reviewer.sessionInstanceId,
          normalizedModelId: 'opus[1m]',
          providerFamily: 'anthropic',
        },
      },
    });
    expect(getSession('deck_supervision_brain')?.transportConfig?.supervision).toMatchObject({
      auditTargetFingerprint: {
        sessionInstanceId: reviewer.sessionInstanceId,
        normalizedModelId: 'opus[1m]',
        providerFamily: 'anthropic',
      },
    });
    expect(mockPersistSessionRecord).not.toHaveBeenCalled();
  });

  it('does not block delegation when the selected session changes model', async () => {
    const snapshot = await seedSession('supervised_audit');
    const reviewer = getSession('deck_sub_reviewer');
    if (!reviewer) throw new Error('seeded reviewer is unavailable');
    upsertSession({
      ...reviewer,
      requestedModel: 'opus',
      modelDisplay: 'claude-opus-4-8',
      activeModel: 'claude-opus-4-8',
      updatedAt: Date.now(),
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-genuine-model-change',
      'implement the feature',
      snapshot,
    );
    beginRun('cmd-genuine-model-change', 'implement the feature');
    completeTurn('implemented the feature');
    await sleep(25);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(mockPersistSessionRecord).not.toHaveBeenCalled();
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      snapshot: { auditTargetSessionName: reviewer.name },
    });
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

  it('resumes explicit global commit and push after PASS when a complete decision starts the audit', async () => {
    const snapshot = await seedSession('supervised_audit', false, 2, {
      globalCustomInstructions: 'Check for uncommitted code and always commit and push after coding and testing.',
    });
    mockSupervisionDecide
      .mockResolvedValueOnce({
        decision: 'complete',
        reason: 'implementation and tests are complete, subject to peer audit',
        confidence: 0.95,
        requiresAudit: true,
      })
      .mockResolvedValueOnce({
        decision: 'complete',
        reason: 'the required repository finalization is complete',
        confidence: 0.95,
        requiresAudit: false,
      });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-complete-before-required-finalization',
      'implement the feature',
      snapshot,
    );
    beginRun('cmd-complete-before-required-finalization', 'implement the feature');
    completeTurn('Implementation and tests are complete. Git commit and push have not been run.');
    await waitForRunPhase('auditing');

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      deferredFinalization: {
        nextAction: expect.stringContaining('stage/commit/push'),
      },
    });

    completeDelegatedAudit('PASS', 'The implementation and tests are correct.');
    await waitForRunPhase('finalizing');
    await waitForTransportSendCount(2);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);
    const finalizationPrompt = String(mockTransportRuntime.send.mock.calls[1]?.[0]);
    expect(finalizationPrompt).toContain('[Contract: supervision_continue_v1]');
    expect(finalizationPrompt).toContain('stage/commit/push');
    expect(finalizationPrompt).not.toContain('Target ID (pass directly to send_message; do not look it up):');
    expect(timelineEmitter.replay('deck_supervision_brain', 0).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'user.message',
        payload: expect.objectContaining({ automationKind: 'supervision-post-audit-finalization' }),
      }),
    ]));

    // Repeated idle boundaries after PASS must not inject another finalization
    // turn while the first one is still pending.
    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'idle' });
    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'idle' });
    await sleep(25);
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);

    completeTurn('Committed and pushed the audited changes.');
    await waitForRunEnd();

    expect(mockSupervisionDecide).toHaveBeenCalledTimes(2);
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
  });

  it('does not invent finalization after PASS when explicit instructions prohibit git changes', async () => {
    const snapshot = await seedSession('supervised_audit', false, 2, {
      globalCustomInstructions: 'This is a read-only verification. Do not stage, commit, or push any files.',
    });
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'complete',
      reason: 'the read-only verification is complete, subject to peer audit',
      confidence: 0.95,
      requiresAudit: true,
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-complete-without-finalization',
      'review the implementation without modifying the repository',
      snapshot,
    );
    beginRun('cmd-complete-without-finalization', 'review the implementation without modifying the repository');
    completeTurn('The read-only review is complete.');
    await waitForRunPhase('auditing');

    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({ phase: 'auditing' });
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')?.deferredFinalization).toBeUndefined();

    completeDelegatedAudit('PASS', 'The read-only review is correct.');
    await waitForRunEnd();

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
  });

  it('does not release complete-path finalization when peer audit requests REWORK', async () => {
    const snapshot = await seedSession('supervised_audit', false, 1, {
      globalCustomInstructions: 'Always commit and push after coding and testing.',
    });
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'complete',
      reason: 'implementation and tests are complete, subject to peer audit',
      confidence: 0.95,
      requiresAudit: true,
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-complete-rework-before-required-finalization',
      'implement the feature',
      snapshot,
    );
    beginRun('cmd-complete-rework-before-required-finalization', 'implement the feature');
    completeTurn('Implementation and tests are complete. Git has not been changed.');
    await waitForRunPhase('auditing');

    const priorFinalizationEventCount = timelineEmitter.replay('deck_supervision_brain', 0).events.filter((event) =>
      event.type === 'user.message'
      && event.payload.automationKind === 'supervision-post-audit-finalization').length;
    completeDelegatedAudit('REWORK', 'A regression test is still missing.');
    await waitForRunPhase('execution');

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);
    expect(String(mockTransportRuntime.send.mock.calls[1]?.[0])).toContain('Audit verdict: REWORK');
    expect(String(mockTransportRuntime.send.mock.calls[1]?.[0])).not.toContain('stage/commit/push');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'execution',
      deferredFinalization: {
        nextAction: expect.stringContaining('stage/commit/push'),
      },
    });
    expect(timelineEmitter.replay('deck_supervision_brain', 0).events.filter((event) =>
      event.type === 'user.message'
      && event.payload.automationKind === 'supervision-post-audit-finalization')).toHaveLength(priorFinalizationEventCount);
  });

  it('starts peer audit when commit-only finalization is qualified by audit-pass wording', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'continue',
      reason: '实现和验证均已完成，只剩仓库收尾',
      confidence: 0.9,
      gap: '存在未提交的代码变更',
      nextAction: '在 peer-audit PASS 后处理未提交变更并执行 git add、commit 和 push。',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-audit-qualified-commit', 'implement the feature', snapshot);
    beginRun('cmd-audit-qualified-commit', 'implement the feature');
    completeTurn('实现与测试均已完成，当前改动尚未提交。');
    await sleep(25);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    const auditPrompt = String(mockTransportRuntime.send.mock.calls[0]?.[0]);
    expect(auditPrompt).toContain('imcodes send --reply');
    expect(auditPrompt).not.toContain('Complete only the remaining substantive implementation or validation work');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      deferredFinalization: {
        nextAction: '在 peer-audit PASS 后处理未提交变更并执行 git add、commit 和 push。',
      },
    });
  });

  it('starts exactly one addressed audit when completion evidence contradicts a mixed validation and finalization action', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'continue',
      reason: '该轮修复和验证已经完成且通过，但当前存在未提交改动；按用户规则必须提交并推送。',
      confidence: 0.9,
      gap: '工作区尚有未提交修改，且尚未执行 git add/commit/push。',
      // This is the contradictory shape observed in production. Before the
      // fix, the generic validation words kept the run in `execution`, so the
      // assistant manually sent an audit without the daemon knowing and every
      // subsequent idle injected another supervision_continue_v1 prompt.
      nextAction: 'Complete only the remaining substantive implementation or validation work, then commit and push after peer-audit PASS.',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-completed-mixed-finalization',
      '修复解析错误',
      snapshot,
    );
    beginRun('cmd-completed-mixed-finalization', '修复解析错误');
    completeTurn('修复与验证已经完成并通过。当前未提交，等待本轮自动审计后再 commit/push。');
    await vi.waitFor(() => {
      expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    }, { timeout: 4_000 });
    const auditPrompt = String(mockTransportRuntime.send.mock.calls[0]?.[0]);
    expect(auditPrompt).toContain('Target ID (pass directly to send_message; do not look it up): deck_sub_reviewer');
    expect(auditPrompt).toContain('imcodes send --reply "deck_sub_reviewer"');
    expect(auditPrompt).toContain('send exactly one reply-enabled audit request to deck_sub_reviewer');
    expect(auditPrompt).not.toContain('[Contract: supervision_continue_v1]');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      deferredFinalization: {
        nextAction: expect.stringContaining('Do not request or start another audit'),
      },
    });

    // Acknowledging the one dispatch and going idle must not run the
    // supervisor again or emit a second audit/continue request.
    completeTurn('审计已发送，等待 reply-enabled 回执。');
    await sleep(25);
    expect(mockSupervisionDecide).toHaveBeenCalledTimes(1);
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({ phase: 'auditing' });

    completeDelegatedAudit('PASS', 'The completion-evidenced fix is correct.');
    await sleep(25);
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);
    const finalizationPrompt = String(mockTransportRuntime.send.mock.calls[1]?.[0]);
    expect(finalizationPrompt).toContain('Do not request or start another audit');
    expect(finalizationPrompt).not.toContain('Target ID (pass directly to send_message; do not look it up):');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({ phase: 'finalizing' });

    completeTurn('已提交并推送审计通过的改动。');
    await sleep(25);
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);
    expect(mockTransportRuntime.send.mock.calls.filter((call) =>
      String(call[0]).includes('Target ID (pass directly to send_message; do not look it up):'))).toHaveLength(1);
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
    const reworkPrompt = String(mockTransportRuntime.send.mock.calls[1]?.[0]);
    expect(reworkPrompt).toContain('Audit verdict: REWORK');
    expect(reworkPrompt).toContain('Do not stage, commit, push, merge, release, publish, or deploy until the fresh matching audit returns PASS.');
    expect(reworkPrompt).not.toContain('Commit the completed changes and push to origin/dev.');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'execution',
      reworkDispatches: 1,
    });
  });

  it('requires a fresh PASS after REWORK before releasing deferred commit and push', async () => {
    const snapshot = await seedSession('supervised_audit', false, 1);
    mockSupervisionDecide
      .mockResolvedValueOnce({
        decision: 'continue',
        reason: 'only repository finalization remains',
        confidence: 0.9,
        gap: 'changes are uncommitted',
        nextAction: 'Commit the completed changes and push to origin/dev.',
      })
      .mockResolvedValueOnce({
        decision: 'complete',
        reason: 'the rework and validation are complete',
        confidence: 0.9,
        requiresAudit: false,
      });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-rework-fresh-pass-before-push',
      'implement the feature',
      snapshot,
    );
    beginRun('cmd-rework-fresh-pass-before-push', 'implement the feature');
    completeTurn('Implementation and validation are complete.');
    await waitForRunPhase('auditing');

    completeDelegatedAudit('REWORK', 'Add the missing regression coverage.');
    await waitForRunPhase('execution');
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);

    completeTurn('The requested rework and validation are complete; no repository finalization was performed.');
    await waitForRunPhase('auditing');
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(3);
    expect(String(mockTransportRuntime.send.mock.calls[2]?.[0])).toContain('imcodes send --reply');
    expect(mockTransportRuntime.send.mock.calls.some((call) =>
      String(call[0]).includes('Commit the completed changes and push to origin/dev.'))).toBe(false);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      freshAuditRequiredAfterRework: true,
      deferredFinalization: {
        nextAction: 'Commit the completed changes and push to origin/dev.',
      },
    });

    completeDelegatedAudit('PASS', 'The corrected implementation and regression coverage pass.');
    await waitForRunPhase('finalizing');
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(4);
    expect(String(mockTransportRuntime.send.mock.calls[3]?.[0])).toContain(
      'Commit the completed changes and push to origin/dev.',
    );
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'finalizing',
      freshAuditRequiredAfterRework: false,
    });
  });

  it.each([
    ['merge', 'Merge the repaired branch into master.'],
    ['release', 'Create the release for the repaired change.'],
    ['publish', 'Publish the repaired package.'],
    ['deploy', 'Deploy the repaired change to production.'],
    ['Chinese merge', '将当前分支合并到 master。'],
    ['Chinese release', '发布当前版本。'],
    ['Chinese deploy', '部署当前版本到生产环境。'],
    ['Chinese go-live', '将当前版本上线。'],
  ])('holds %s finalization after REWORK until a fresh PASS', async (_kind, finalizationAction) => {
    const snapshot = await seedSession('supervised_audit', false, 1);
    mockSupervisionDecide
      .mockResolvedValueOnce({
        decision: 'complete',
        reason: 'the initial implementation is ready for audit',
        confidence: 0.9,
        requiresAudit: true,
      })
      .mockResolvedValueOnce({
        decision: 'continue',
        reason: 'the requested rework and validation are complete; only delivery finalization remains',
        confidence: 0.9,
        requiresAudit: false,
        gap: 'the repaired change has not been finalized',
        nextAction: finalizationAction,
      });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      `cmd-rework-${_kind}-fresh-pass`,
      'implement and deliver the feature',
      snapshot,
    );
    beginRun(`cmd-rework-${_kind}-fresh-pass`, 'implement and deliver the feature');
    completeTurn('The initial implementation and validation are complete.');
    await waitForRunPhase('auditing');

    completeDelegatedAudit('REWORK', 'Repair the audit finding before delivery.');
    await waitForRunPhase('execution');
    completeTurn('The audit finding is repaired and validation passes. No finalization was performed.');
    await waitForRunPhase('auditing');

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(3);
    expect(String(mockTransportRuntime.send.mock.calls[2]?.[0])).toContain('imcodes send --reply');
    expect(mockTransportRuntime.send.mock.calls.some((call) =>
      String(call[0]).includes(finalizationAction))).toBe(false);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      freshAuditRequiredAfterRework: true,
      deferredFinalization: { nextAction: finalizationAction },
    });

    completeDelegatedAudit('PASS', 'The repaired change passes the fresh audit.');
    await waitForRunPhase('finalizing');
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(4);
    expect(String(mockTransportRuntime.send.mock.calls[3]?.[0])).toContain(finalizationAction);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'finalizing',
      freshAuditRequiredAfterRework: false,
    });
  });

  it('strips mixed pre-audit validation and publish/deploy finalization until fresh PASS', async () => {
    const snapshot = await seedSession('supervised_audit', false, 1);
    const mixedAction = 'Run the focused tests, then deploy and publish the repaired release.';
    const finalizationAction = 'Deploy and publish the repaired release.';
    mockSupervisionDecide
      .mockResolvedValueOnce({
        decision: 'complete',
        reason: 'the initial implementation is ready for audit',
        confidence: 0.9,
        requiresAudit: true,
      })
      .mockResolvedValueOnce({
        decision: 'continue',
        reason: 'focused validation remains before delivery finalization',
        confidence: 0.9,
        requiresAudit: false,
        gap: 'the focused tests have not run',
        nextAction: mixedAction,
      })
      .mockResolvedValueOnce({
        decision: 'continue',
        reason: 'the repaired implementation and focused tests are complete; only delivery finalization remains',
        confidence: 0.9,
        requiresAudit: false,
        gap: 'the repaired release has not been delivered',
        nextAction: finalizationAction,
      });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-rework-mixed-publish-deploy',
      'implement and deliver the feature',
      snapshot,
    );
    beginRun('cmd-rework-mixed-publish-deploy', 'implement and deliver the feature');
    completeTurn('The initial implementation is complete.');
    await waitForRunPhase('auditing');

    completeDelegatedAudit('REWORK', 'Repair the finding and run focused tests.');
    await waitForRunPhase('execution');
    completeTurn('The finding is repaired, but the focused tests still need to run.');
    await waitForTransportSendCount(3);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(3);
    const preAuditContinue = String(mockTransportRuntime.send.mock.calls[2]?.[0]);
    expect(preAuditContinue).toContain('Complete only the remaining substantive implementation or validation work');
    expect(preAuditContinue).toContain('Do not stage, commit, or push; do not merge, release, publish, or deploy.');
    expect(preAuditContinue).not.toContain(mixedAction);
    expect(preAuditContinue).not.toContain(finalizationAction);

    completeTurn('The repaired implementation and focused tests now pass; no finalization was performed.');
    await waitForRunPhase('auditing');
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(4);
    expect(String(mockTransportRuntime.send.mock.calls[3]?.[0])).toContain('imcodes send --reply');
    expect(mockTransportRuntime.send.mock.calls.some((call) =>
      String(call[0]).includes(finalizationAction))).toBe(false);

    completeDelegatedAudit('PASS', 'The repaired implementation and focused tests pass audit.');
    await waitForRunPhase('finalizing');
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(5);
    expect(String(mockTransportRuntime.send.mock.calls[4]?.[0])).toContain(finalizationAction);
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

  it('keeps Chinese substantive work in the pre-audit loop when commit is also mentioned', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'continue',
      reason: '提交前仍有失败的验证项',
      confidence: 0.8,
      nextAction: '先运行测试并修复失败，再执行 git commit 和 push。',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-chinese-tests-before-audit', 'implement the feature', snapshot);
    beginRun('cmd-chinese-tests-before-audit', 'implement the feature');
    completeTurn('实现存在，但验证仍未完成。');
    await sleep(25);

    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    const continuePrompt = String(mockTransportRuntime.send.mock.calls[0]?.[0]);
    expect(continuePrompt).toContain('Complete only the remaining substantive implementation or validation work');
    expect(continuePrompt).not.toContain('imcodes send --reply');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({ phase: 'execution' });
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
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).toContain('Action: tests are still missing');
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
      expect.objectContaining({
        type: 'assistant.text',
        eventId: 'supervision-note:deck_supervision_brain',
        payload: expect.objectContaining({
          automation: true,
          automationKind: 'supervision-complete',
          text: 'Auto: task looks complete.',
        }),
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

    expect(noteEvents).toHaveLength(1);
    expect(noteEvents[0]).toEqual(expect.objectContaining({
      eventId: 'supervision-note:deck_supervision_brain',
      payload: expect.objectContaining({
        text: 'Auto: task looks complete.',
      }),
    }));
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

  it('reports the supervisor provider failure category and exhausted attempt count', async () => {
    const snapshot = await seedSession('supervised');
    mockSupervisionDecide.mockResolvedValue({
      decision: 'ask_human',
      reason: 'upstream provider failed token=supersecret',
      confidence: 0,
      unavailableReason: SUPERVISION_UNAVAILABLE_REASONS.PROVIDER_ERROR,
      providerFailure: {
        code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        attempts: 3,
      },
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-provider-error', 'implement the feature', snapshot);
    beginRun('cmd-provider-error', 'implement the feature');

    completeTurn('implemented the feature');
    await sleep(25);

    const warning = timelineEmitter.replay('deck_supervision_brain', 0).events.filter((event) =>
      event.type === 'assistant.text'
      && event.payload.automationKind === 'supervision-warning',
    ).at(-1);
    expect(warning?.payload.text).toBe(
      '⚠️ Automation could not obtain a decision from supervisor model codex-sdk/gpt-5.3-codex-spark after 3 attempts: upstream provider failed token=[redacted]. Manual continuation is required.',
    );
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
  });

  it('fails closed when a supervised run reaches idle without a completed assistant response', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const snapshot = await seedSession('supervised');
    try {
      supervisionAutomation.init();
      supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-no-output', 'implement the feature', snapshot);
      beginRun('cmd-no-output', 'implement the feature');

      timelineEmitter.emit('deck_supervision_brain', 'session.state', {
        state: 'idle',
      });
      await vi.advanceTimersByTimeAsync(1_999);

      expect(mockSupervisionDecide).not.toHaveBeenCalled();
      expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeTruthy();

      await vi.advanceTimersByTimeAsync(1);
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
    } finally {
      vi.useRealTimers();
    }
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

  it('starts a fresh continue streak for REWORK so repair can reach the next audit', async () => {
    const snapshot = await seedSession('supervised_audit', false, 2, {
      maxAutoContinueStreak: 1,
      maxAutoContinueTotal: 0,
    });
    mockSupervisionDecide
      .mockResolvedValueOnce({
        decision: 'continue',
        reason: 'write the missing regression tests',
        confidence: 0.8,
      })
      .mockResolvedValueOnce({
        decision: 'complete',
        reason: 'the first implementation and tests are ready for audit',
        confidence: 0.9,
        requiresAudit: true,
      })
      .mockResolvedValueOnce({
        decision: 'continue',
        reason: 'write the repaired regression tests',
        confidence: 0.8,
      });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-rework-resets-continue-streak',
      'implement and audit the feature',
      snapshot,
    );
    beginRun('cmd-rework-resets-continue-streak', 'implement and audit the feature');

    completeTurn('implemented the first version');
    await waitForTransportSendCount(1);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      continueStreakCount: 1,
      lastContinueBucket: 'test_verify',
    });

    completeTurn('added the first regression tests');
    await waitForRunPhase('auditing');
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);

    completeDelegatedAudit('REWORK', 'Repair the edge case and add its regression test.');
    await waitForRunPhase('execution');
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(3);
    expect(String(mockTransportRuntime.send.mock.calls[2]?.[0])).toContain(
      'the daemon will start one fresh peer audit automatically',
    );
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      continueStreakCount: 0,
      phase: 'execution',
    });
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')?.lastContinueBucket).toBeUndefined();

    completeTurn('repaired the edge case');
    await waitForTransportSendCount(4);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      continueStreakCount: 1,
      lastContinueBucket: 'test_verify',
      phase: 'execution',
    });
    expect(timelineEmitter.replay('deck_supervision_brain', 0).events.some((event) =>
      event.type === 'assistant.text'
      && event.payload.automationKind === 'supervision-warning'
      && String(event.payload.text ?? '').includes('repeated auto-continue limit'))).toBe(false);
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

  it('does not seed a second implicit run from a queued message appended to the active turn', async () => {
    const snapshot = await seedSession('supervised');
    supervisionAutomation.init();
    supervisionAutomation.queueTaskIntent('deck_supervision_brain', 'cmd-original', 'implement original task', snapshot);
    beginRun('cmd-original', 'implement original task');

    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: 'also handle this queued follow-up',
      clientMessageId: 'cmd-appended',
      queueAppended: true,
      allowDuplicate: true,
    });
    completeTurn('implemented both requests');
    await sleep(25);

    expect(mockSupervisionDecide).toHaveBeenCalledTimes(1);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();

    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'idle' });
    await sleep(25);
    expect(mockSupervisionDecide).toHaveBeenCalledTimes(1);
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

  it('keeps automatic-audit routing and result markers ahead of oversized path truncation', async () => {
    const snapshot = await seedSession('supervised_audit', true);
    const specsDir = path.join(
      projectDir!,
      'openspec',
      'changes',
      'supervised-task-automation',
      'specs',
    );
    await Promise.all(Array.from({ length: 47 }, (_, index) => writeFile(
      path.join(specsDir, `audit-context-${String(index).padStart(2, '0')}-${'x'.repeat(120)}.md`),
      '# Audit context\n',
    )));

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-large-audit-context',
      'finish openspec/changes/supervised-task-automation implementation',
      snapshot,
    );
    beginRun(
      'cmd-large-audit-context',
      'finish openspec/changes/supervised-task-automation implementation',
    );

    completeTurn('implemented the large change');
    await waitForTransportSendCount(1);

    const prompt = String(mockTransportRuntime.send.mock.calls[0]?.[0]);
    expect(prompt).toContain('[truncated]');
    expect(prompt).toContain('Target ID (pass directly to send_message; do not look it up): deck_sub_reviewer');
    expect(prompt).toContain('send_message(target="deck_sub_reviewer", reply=true)');
    expect(prompt).toContain('Do not call send_list_targets.');
    expect(prompt).toContain('imcodes send --reply "deck_sub_reviewer"');
    expect(prompt).toContain('"kind":"supervision_audit"');
    expect(prompt).toContain('"attemptId":');
    expect(prompt).toContain('While waiting: do not modify, commit, push, or deploy.');
    expect(prompt).toContain(PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS.PASS);
    expect(prompt).toContain(PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS.REWORK);
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

    // Each step waits for the phase it depends on instead of a fixed sleep.
    // Dispatching the audit is async (broker decision + filesystem baseline
    // discovery); sleep(25) covered that locally but not on a loaded CI runner.
    // Completing the delegated audit before the run reached `auditing` derailed
    // the sequence, and call[1] then held the audit-orchestration prompt rather
    // than the rework brief — the macOS CI failure this replaces.
    completeTurn('implemented the feature');
    await waitForRunPhase('auditing');
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);

    completeDelegatedAudit('REWORK', 'first audit needs fixes');
    await waitForRunPhase('execution');
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(2);
    expect(String(mockTransportRuntime.send.mock.calls[1]?.[0])).toContain('Audit verdict: REWORK');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      reworkDispatches: 1,
      phase: 'execution',
    });

    completeTurn('implemented the requested rework');
    await waitForRunPhase('auditing');
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(3);
    expect(String(mockTransportRuntime.send.mock.calls[2]?.[0])).toContain('imcodes send --reply');

    // maxAuditLoops = 1, so the second REWORK must end the run WITHOUT another
    // rework dispatch. Wait for teardown, then assert the count never grew.
    completeDelegatedAudit('REWORK', 'second audit still needs fixes');
    await waitForRunEnd();
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(3);
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

  it('starts the addressed audit instead of parking when no peer audit was actually dispatched', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'waiting',
      reason: 'The implementation and validation are complete, but the audit-order rule forbids git finalization until peer-audit PASS.',
      confidence: 0.94,
      requiresAudit: false,
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-undispatched-audit-wait',
      '修复共享会话刷新回归并完成提交推送',
      snapshot,
    );
    beginRun('cmd-undispatched-audit-wait', '修复共享会话刷新回归并完成提交推送');
    completeTurn('实现与验证已经完成并通过；当前阻塞于 peer-audit PASS，尚未执行 git commit/push。');

    await vi.waitFor(() => {
      expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    }, { timeout: 4_000 });

    const auditPrompt = String(mockTransportRuntime.send.mock.calls[0]?.[0]);
    expect(auditPrompt).toContain('Target ID (pass directly to send_message; do not look it up): deck_sub_reviewer');
    expect(auditPrompt).toContain('imcodes send --reply "deck_sub_reviewer"');
    expect(auditPrompt).toContain('send exactly one reply-enabled audit request to deck_sub_reviewer');
    expect(auditPrompt).not.toContain('[Contract: supervision_continue_v1]');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      phase: 'auditing',
      deferredFinalization: {
        nextAction: expect.stringContaining('Peer-audit has passed'),
      },
    });
    const events = timelineEmitter.replay('deck_supervision_brain', 0).events;
    expect(events.some((event) => event.type === 'agent.status'
      && event.payload.status === 'supervision_parked')).toBe(false);
  });

  it('normalizes a model-authored P2P audit continue into the dedicated current-session audit handoff', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'continue',
      reason: '实现和测试已完成，现在需要独立审计。',
      gap: '尚未获得 peer-audit PASS。',
      nextAction: '通过 P2P 发起 peer-audit，方向为 audit>plan。',
      confidence: 0.92,
      requiresAudit: true,
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-model-audit-drift',
      '修复共享会话刷新回归',
      snapshot,
    );
    beginRun('cmd-model-audit-drift', '修复共享会话刷新回归');
    completeTurn('实现和定向测试已全部完成。');

    await vi.waitFor(() => {
      expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    }, { timeout: 4_000 });

    const prompt = String(mockTransportRuntime.send.mock.calls[0]?.[0]);
    expect(prompt).toContain('Target ID (pass directly to send_message; do not look it up): deck_sub_reviewer');
    expect(prompt).toContain('imcodes send --reply "deck_sub_reviewer"');
    expect(prompt).not.toContain('[Contract: supervision_continue_v1]');
    expect(prompt).not.toContain('audit>plan');
    expect(mockStartP2pRun).not.toHaveBeenCalled();
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({ phase: 'auditing' });
  });

  it('reserves the audit phase before baseline I/O so a repeated idle boundary cannot dispatch twice', async () => {
    const snapshot = await seedSession('supervised_audit', true);
    mockSupervisionDecide.mockImplementationOnce(async () => {
      setImmediate(() => completeTurn('重复 idle 边界：仍然是同一个已完成回合。'));
      return {
        decision: 'complete',
        reason: '实现与验证已完成。',
        confidence: 0.95,
        requiresAudit: true,
      } as const;
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-audit-baseline-race',
      'implement supervised-task-automation',
      snapshot,
    );
    beginRun('cmd-audit-baseline-race', 'implement supervised-task-automation');
    completeTurn('Implementation and validation are complete.');

    await waitForTransportSendCount(1);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockSupervisionDecide).toHaveBeenCalledTimes(1);
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({ phase: 'auditing' });
  });

  it('recovers a supervised audit from timeline when restart clears the in-memory task candidate', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'complete',
      reason: '实现和验证已完成，需要独立审计。',
      confidence: 0.96,
      requiresAudit: true,
    });

    supervisionAutomation.init();
    const baseTs = Date.now();
    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: '通过 acp 接入 Hermes Agent 并完成测试',
      clientMessageId: 'cmd-restart-lost-candidate',
      allowDuplicate: true,
    }, { ts: baseTs });
    await timelineStore.flushSession('deck_supervision_brain');

    // Simulate the production failure mode: the daemon restarts during a long
    // provider turn, so supervision's in-memory candidate/run maps and the
    // timeline ring buffer are gone, while the JSONL conversation tail remains.
    supervisionAutomation.cancelSession('deck_supervision_brain');
    timelineEmitter.forgetSession('deck_supervision_brain');
    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: 'continue',
      clientMessageId: 'cmd-midturn-continue-after-restart',
      allowDuplicate: true,
    }, { ts: baseTs + 1 });
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'Hermes Agent ACP 接入已完成，验证通过；等待自动独立审计，尚未提交。',
      streaming: false,
    }, { ts: baseTs + 2 });
    timelineEmitter.emit('deck_supervision_brain', 'session.state', {
      state: 'idle',
    }, { ts: baseTs + 3 });

    await waitForTransportSendCount(1);

    expect(mockSupervisionDecide).toHaveBeenCalledWith(expect.objectContaining({
      taskRequest: '通过 acp 接入 Hermes Agent 并完成测试',
      assistantResponse: expect.stringContaining('Hermes Agent ACP 接入已完成'),
    }));
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
    expect(String(mockTransportRuntime.send.mock.calls[0]?.[0])).toContain('Target ID (pass directly to send_message; do not look it up): deck_sub_reviewer');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({ phase: 'auditing' });

    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'running' });
    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'idle' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
  });

  it('keeps the original recovered task when a bare continue follows an assistant completion', async () => {
    await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'complete',
      reason: 'the resumed implementation is complete',
      confidence: 0.96,
      requiresAudit: true,
    });

    supervisionAutomation.init();
    const baseTs = Date.now();
    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: 'finish the durable supervision recovery fix',
      clientMessageId: 'cmd-recovery-before-post-completion-continue',
      allowDuplicate: true,
    }, { ts: baseTs });
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'first completion before the user resumes the same task',
      streaming: false,
    }, { ts: baseTs + 1 });
    await timelineStore.flushSession('deck_supervision_brain');

    // Restart loses the in-memory candidate. A later control-only continue and
    // assistant completion must remain attached to the original user task.
    supervisionAutomation.cancelSession('deck_supervision_brain');
    timelineEmitter.forgetSession('deck_supervision_brain');
    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: 'continue',
      clientMessageId: 'cmd-post-completion-continue',
      allowDuplicate: true,
    }, { ts: baseTs + 2 });
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'resumed completion after the control-only continue',
      streaming: false,
    }, { ts: baseTs + 3 });
    timelineEmitter.emit('deck_supervision_brain', 'session.state', {
      state: 'idle',
    }, { ts: baseTs + 4 });

    await waitForTransportSendCount(1);

    expect(mockSupervisionDecide).toHaveBeenCalledWith(expect.objectContaining({
      taskRequest: 'finish the durable supervision recovery fix',
      assistantResponse: 'resumed completion after the control-only continue',
    }));
    expect(mockSupervisionDecide).not.toHaveBeenCalledWith(expect.objectContaining({
      taskRequest: 'continue',
    }));
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
  });

  it('resumes the original recovered task after STOP and bare continue without auditing continue itself', async () => {
    await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'complete',
      reason: 'the explicitly resumed implementation is complete',
      confidence: 0.96,
      requiresAudit: true,
    });

    supervisionAutomation.init();
    const baseTs = Date.now();
    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: 'finish the stoppable supervision task',
      clientMessageId: 'cmd-recovery-before-stop',
      allowDuplicate: true,
    }, { ts: baseTs });
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'completion produced immediately before STOP',
      streaming: false,
    }, { ts: baseTs + 1 });
    supervisionAutomation.cancelForUserStop('deck_supervision_brain');
    timelineEmitter.emit('deck_supervision_brain', 'session.state', {
      state: 'idle',
      resetReason: 'command_handler_cancel_idle',
    }, { ts: baseTs + 2 });
    await timelineStore.flushSession('deck_supervision_brain');

    // Simulate restart, then the user explicitly resumes the stopped task.
    // The STOP barrier must remain until the new completion, while the bare
    // continue itself must never replace the original task request.
    supervisionAutomation.cancelSession('deck_supervision_brain');
    timelineEmitter.forgetSession('deck_supervision_brain');
    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: '继续',
      clientMessageId: 'cmd-continue-after-stop',
      allowDuplicate: true,
    }, { ts: baseTs + 3 });
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'completion after explicitly resuming the stopped task',
      streaming: false,
    }, { ts: baseTs + 4 });
    timelineEmitter.emit('deck_supervision_brain', 'session.state', {
      state: 'idle',
    }, { ts: baseTs + 5 });

    await waitForTransportSendCount(1);

    expect(mockSupervisionDecide).toHaveBeenCalledWith(expect.objectContaining({
      taskRequest: 'finish the stoppable supervision task',
      assistantResponse: 'completion after explicitly resuming the stopped task',
    }));
    expect(mockSupervisionDecide).not.toHaveBeenCalledWith(expect.objectContaining({
      taskRequest: '继续',
    }));
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
  });


  it('does not recover a stopped turn when a late assistant final arrives without user resume', async () => {
    await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValue({
      decision: 'complete',
      reason: 'late final should remain stopped',
      confidence: 0.96,
      requiresAudit: true,
    });

    supervisionAutomation.init();
    const baseTs = Date.now();
    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: 'finish the task that will be stopped',
      clientMessageId: 'cmd-stop-before-late-final',
      allowDuplicate: true,
    }, { ts: baseTs });
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'completion before STOP',
      streaming: false,
    }, { ts: baseTs + 1 });
    supervisionAutomation.cancelForUserStop('deck_supervision_brain');
    timelineEmitter.emit('deck_supervision_brain', 'session.state', {
      state: 'idle',
      resetReason: 'command_handler_cancel_idle',
    }, { ts: baseTs + 2 });
    await timelineStore.flushSession('deck_supervision_brain');

    // After restart, in-memory STOP suppression is gone. The durable STOP
    // barrier must still reject provider/transport late-final rows unless the
    // user first sends an explicit resume control such as `continue` / `继续`.
    supervisionAutomation.cancelSession('deck_supervision_brain');
    timelineEmitter.forgetSession('deck_supervision_brain');
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'late final after STOP with no user resume',
      streaming: false,
    }, { ts: baseTs + 3 });
    timelineEmitter.emit('deck_supervision_brain', 'session.state', {
      state: 'idle',
    }, { ts: baseTs + 4 });
    await sleep(25);

    expect(mockSupervisionDecide).not.toHaveBeenCalled();
    expect(mockTransportRuntime.send).not.toHaveBeenCalled();
  });


  it('does not recover a stopped in-flight turn when the first assistant final arrives without user resume', async () => {
    await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValue({
      decision: 'complete',
      reason: 'in-flight late final should remain stopped',
      confidence: 0.96,
      requiresAudit: true,
    });

    supervisionAutomation.init();
    const baseTs = Date.now();
    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: 'finish the in-flight task that will be stopped',
      clientMessageId: 'cmd-inflight-stop-before-final',
      allowDuplicate: true,
    }, { ts: baseTs });
    supervisionAutomation.cancelForUserStop('deck_supervision_brain');
    timelineEmitter.emit('deck_supervision_brain', 'session.state', {
      state: 'idle',
      resetReason: 'command_handler_cancel_idle',
    }, { ts: baseTs + 1 });
    await timelineStore.flushSession('deck_supervision_brain');

    // Production STOP can be persisted before the provider emits any terminal
    // assistant row. After restart, that first late final must still be blocked
    // until the user explicitly resumes the stopped task.
    supervisionAutomation.cancelSession('deck_supervision_brain');
    timelineEmitter.forgetSession('deck_supervision_brain');
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'first assistant final after STOP with no user resume',
      streaming: false,
    }, { ts: baseTs + 2 });
    timelineEmitter.emit('deck_supervision_brain', 'session.state', {
      state: 'idle',
    }, { ts: baseTs + 3 });
    await sleep(25);

    expect(mockSupervisionDecide).not.toHaveBeenCalled();
    expect(mockTransportRuntime.send).not.toHaveBeenCalled();
  });


  it('does not replay an implementation turn after a delegated audit reply and PASS final survive restart', async () => {
    await seedSession('supervised_audit');

    supervisionAutomation.init();
    const baseTs = Date.now();
    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: 'implement the audited feature',
      clientMessageId: 'cmd-before-delegated-reply',
      allowDuplicate: true,
    }, { ts: baseTs });
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'implementation complete; waiting for peer audit',
      streaming: false,
    }, { ts: baseTs + 1 });
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'Auto: peer audit was dispatched.',
      streaming: false,
      automation: true,
      automationKind: 'supervision-audit-started',
      memoryExcluded: true,
    }, { ts: baseTs + 2, eventId: 'supervision-note:deck_supervision_brain' });
    await timelineStore.flushSession('deck_supervision_brain');

    // A daemon restart drops the active audit run. The delegated reply and this
    // session's PASS/REWORK final are audit/control-plane traffic, not a new
    // implementation completion for the original task.
    supervisionAutomation.cancelSession('deck_supervision_brain');
    timelineEmitter.forgetSession('deck_supervision_brain');
    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: [
        AGENT_DELEGATION_COMPLETION_NOTIFICATION_MARKER,
        'A delegated agent completed the requested work.',
        'Delegation ID: audit-1',
        'From session: deck_sub_reviewer',
        '',
        'Verdict: PASS',
      ].join('\n'),
      clientMessageId: 'cmd-delegation-notification',
      allowDuplicate: true,
    }, { ts: baseTs + 3 });
    timelineEmitter.emit('deck_supervision_brain', AGENT_DELEGATION_REPLY_TIMELINE_EVENT, {
      memoryExcluded: true,
      sourceSessionName: 'deck_sub_reviewer',
      result: 'Verdict: PASS',
    }, { ts: baseTs + 4, eventId: 'delegation-reply:audit-1' });
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'Verdict: PASS\nAudit found no blockers.',
      streaming: false,
    }, { ts: baseTs + 5 });
    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'idle' }, { ts: baseTs + 6 });
    await sleep(25);

    expect(mockSupervisionDecide).not.toHaveBeenCalled();
    expect(mockTransportRuntime.send).not.toHaveBeenCalled();
  });

  it('recovers the original user task after more than one thousand non-conversation events', async () => {
    await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'complete',
      reason: 'long noisy task complete',
      confidence: 0.96,
      requiresAudit: true,
    });

    supervisionAutomation.init();
    const baseTs = Date.now();
    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: 'complete the very noisy long-running task',
      clientMessageId: 'cmd-noisy-long-task',
      allowDuplicate: true,
    }, { ts: baseTs });
    for (let index = 0; index < 1_200; index += 1) {
      timelineEmitter.emit('deck_supervision_brain', 'tool.call', {
        id: `tool-noise-${index}`,
        name: 'noop',
        input: {},
      }, { ts: baseTs + 1 + index });
    }
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'the noisy long-running task is complete',
      streaming: false,
    }, { ts: baseTs + 1_205 });
    await timelineStore.flushSession('deck_supervision_brain');

    supervisionAutomation.cancelSession('deck_supervision_brain');
    timelineEmitter.forgetSession('deck_supervision_brain');
    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'idle' }, { ts: baseTs + 1_206 });

    await waitForTransportSendCount(1);

    expect(mockSupervisionDecide).toHaveBeenCalledWith(expect.objectContaining({
      taskRequest: 'complete the very noisy long-running task',
      assistantResponse: 'the noisy long-running task is complete',
    }));
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
  });

  it('does not recover an already-evaluated turn after restart when durable supervision notes follow completion', async () => {
    const snapshot = await seedSession('supervised');
    mockSupervisionDecide.mockResolvedValue({
      decision: 'complete',
      reason: 'done',
      confidence: 0.9,
      requiresAudit: false,
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-first-evaluated', 'implement first task', snapshot);
    beginRun('cmd-first-evaluated', 'implement first task');
    completeTurn('first task complete');
    await waitForRunEnd();

    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-second-evaluated', 'implement second task', snapshot);
    beginRun('cmd-second-evaluated', 'implement second task');
    completeTurn('second task complete');
    await waitForRunEnd();
    expect(mockSupervisionDecide).toHaveBeenCalledTimes(2);
    await timelineStore.flushSession('deck_supervision_brain');

    // Simulate daemon restart: in-memory completion keys disappear, so the
    // durable post-completion supervision notes/append order must be the
    // authority that prevents re-evaluating the old completed turn.
    supervisionAutomation.cancelSession('deck_supervision_brain');
    timelineEmitter.forgetSession('deck_supervision_brain');
    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'running' });
    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'idle' });
    await sleep(25);

    expect(mockSupervisionDecide).toHaveBeenCalledTimes(2);
    expect(mockTransportRuntime.send).not.toHaveBeenCalled();
  });

  it('treats user STOP cancel-idle as a recovery barrier until the next real task', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValue({
      decision: 'complete',
      reason: 'done',
      confidence: 0.9,
      requiresAudit: true,
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-stop-before-idle', 'implement stoppable task', snapshot);
    beginRun('cmd-stop-before-idle', 'implement stoppable task');
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'stoppable task reached a final response',
      streaming: false,
    });

    supervisionAutomation.cancelForUserStop('deck_supervision_brain');
    timelineEmitter.emit('deck_supervision_brain', 'session.state', {
      state: 'idle',
      resetReason: 'command_handler_cancel_idle',
    });
    await sleep(25);

    expect(mockSupervisionDecide).not.toHaveBeenCalled();
    expect(mockTransportRuntime.send).not.toHaveBeenCalled();

    beginRun('cmd-after-stop', 'implement next task');
    completeTurn('next task complete');
    await waitForTransportSendCount(1);

    expect(mockSupervisionDecide).toHaveBeenCalledWith(expect.objectContaining({
      taskRequest: 'implement next task',
      assistantResponse: 'next task complete',
    }));
    expect(mockTransportRuntime.send).toHaveBeenCalledTimes(1);
  });

  it('does not recover a previous incarnation of the same session name', async () => {
    await seedSession('supervised_audit');
    supervisionAutomation.init();
    const oldTs = Date.now() - 10_000;
    timelineEmitter.emit('deck_supervision_brain', 'user.message', {
      text: 'old incarnation task',
      clientMessageId: 'cmd-old-incarnation',
      allowDuplicate: true,
    }, { ts: oldTs });
    timelineEmitter.emit('deck_supervision_brain', 'assistant.text', {
      text: 'old incarnation completed',
      streaming: false,
    }, { ts: oldTs + 1 });
    await timelineStore.flushSession('deck_supervision_brain');

    removeSession('deck_supervision_brain');
    removeSession('deck_sub_reviewer');
    supervisionAutomation.cancelSession('deck_supervision_brain');
    const newSnapshot = await seedSession('supervised_audit');
    expect(newSnapshot.mode).toBe('supervised_audit');
    timelineEmitter.forgetSession('deck_supervision_brain');
    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'running' });
    timelineEmitter.emit('deck_supervision_brain', 'session.state', { state: 'idle' });
    await sleep(25);

    expect(mockSupervisionDecide).not.toHaveBeenCalled();
    expect(mockTransportRuntime.send).not.toHaveBeenCalled();
  });

  // A session that dispatched an external validation request and is barred
  // from touching the repo until it returns can only be classified `continue`
  // out of the old three-value enum, so automation re-prompted it forever and
  // it answered "still blocked" every time.
  it('parks on a waiting decision instead of sending another continue contract', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValue({
      decision: 'waiting',
      reason: 'blocked awaiting the delegated validation reply',
      confidence: 0.9,
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent(
      'deck_supervision_brain',
      'cmd-parked',
      'implement the feature',
      snapshot,
    );
    beginRun('cmd-parked', 'implement the feature');
    completeTurn('Still blocked on the delegated validation reply; not touching the repository.');

    await vi.waitFor(() => {
      const events = timelineEmitter.replay('deck_supervision_brain', 0).events;
      expect(events.some((event) => event.type === 'agent.status'
        && event.payload.status === 'supervision_parked')).toBe(true);
    }, { timeout: 4_000 });

    // No continue prompt was pushed at the session …
    const prompts = mockTransportRuntime.send.mock.calls.map((call) => String(call[0]));
    expect(prompts.some((prompt) => prompt.includes('[Contract: supervision_continue_v1]'))).toBe(false);
    // … and the run is still alive, so the reply's turn can resume it.
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({ phase: 'execution' });
  });

  it('resumes the SAME parked run when the awaited reply produces the next turn', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide
      .mockResolvedValueOnce({
        decision: 'waiting',
        reason: 'blocked awaiting the delegated validation reply',
        confidence: 0.9,
      })
      .mockResolvedValueOnce({
        decision: 'complete',
        reason: 'delegated validation returned and the work is done',
        confidence: 0.95,
        requiresAudit: false,
      });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-park-resume', 'implement the feature', snapshot);
    beginRun('cmd-park-resume', 'implement the feature');
    completeTurn('Still blocked on the delegated validation reply.');
    await vi.waitFor(() => {
      expect(mockSupervisionDecide).toHaveBeenCalledTimes(1);
    }, { timeout: 4_000 });

    // Pin the run's identity BEFORE the wake. Asserting only "decide ran twice"
    // is satisfiable by an implicit re-registration after the first run ended,
    // which would prove nothing about resumption.
    const parked = supervisionAutomation.getActiveRun('deck_supervision_brain');
    expect(parked).toMatchObject({ phase: 'execution', commandId: 'cmd-park-resume' });
    const parkedGeneration = parked!.generation;

    completeTurn('Delegated validation returned; everything is finished.');
    await vi.waitFor(() => {
      expect(mockSupervisionDecide).toHaveBeenCalledTimes(2);
    }, { timeout: 4_000 });

    // The second decision was applied to the same run, not a fresh one.
    await vi.waitFor(() => {
      const events = timelineEmitter.replay('deck_supervision_brain', 0).events;
      expect(events.some((event) => event.type === 'agent.status'
        && event.payload.status === 'supervision_complete')).toBe(true);
    }, { timeout: 4_000 });
    const after = supervisionAutomation.getActiveRun('deck_supervision_brain');
    if (after) expect(after.generation).toBe(parkedGeneration);
  });

  it('stops the supervisor that drives a session the user stopped', async () => {
    // STOP on the audit TARGET used to leave the driving run on the supervisor
    // session armed, so it woke on its deadline and kept re-sending continue
    // prompts at the session the user had just stopped.
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValue({
      decision: 'waiting',
      reason: 'blocked awaiting the delegated validation reply',
      confidence: 0.9,
    });
    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-stop-target', 'task', snapshot);
    beginRun('cmd-stop-target', 'task');
    completeTurn('Blocked on the delegated validation reply.');
    await vi.waitFor(async () => {
      expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeDefined();
    }, { timeout: 4_000 });

    // The user stops the TARGET, not the supervisor.
    supervisionAutomation.cancelForUserStop('deck_sub_reviewer');

    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
    // Never leave teardown to the behaviour under test.
    supervisionAutomation.cancelSession('deck_supervision_brain');
  });

  it('cancels the stopped session\'s own run as well', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValue({
      decision: 'waiting',
      reason: 'blocked awaiting the delegated validation reply',
      confidence: 0.9,
    });
    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-stop-self', 'task', snapshot);
    beginRun('cmd-stop-self', 'task');
    completeTurn('Blocked on the delegated validation reply.');
    await vi.waitFor(async () => {
      expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeDefined();
    }, { timeout: 4_000 });

    supervisionAutomation.cancelForUserStop('deck_supervision_brain');

    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
    supervisionAutomation.cancelSession('deck_supervision_brain');
  });

  it('does not let a cancelled run\'s park timer terminate a later run', async () => {
    // `generation` restarts at 1 when a run is cancelled rather than replaced,
    // so a surviving timer from run A matched run B on generation+phase and
    // finished it 30 minutes later.
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValue({
      decision: 'waiting',
      reason: 'blocked awaiting the delegated validation reply',
      confidence: 0.9,
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      supervisionAutomation.init();
      supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-park-a', 'task A', snapshot);
      beginRun('cmd-park-a', 'task A');
      completeTurn('Blocked on the delegated validation reply.');
      await vi.waitFor(async () => {
        expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({ phase: 'execution' });
      }, { timeout: 4_000 });

      supervisionAutomation.cancelSession('deck_supervision_brain');
      expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();

      // A brand-new run, which the stale timer must not touch.
      mockSupervisionDecide.mockResolvedValue({
        decision: 'continue',
        reason: 'work remains',
        confidence: 0.9,
        nextAction: 'Run the test suite.',
      });
      supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-park-b', 'task B', snapshot);
      beginRun('cmd-park-b', 'task B');

      await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);

      const survivor = supervisionAutomation.getActiveRun('deck_supervision_brain');
      expect(survivor?.commandId).toBe('cmd-park-b');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not discard a verdict that lands while the deadline is expiring', async () => {
    // The timer stayed armed across `await supervisionBroker.decide(...)`, so a
    // reply arriving just before the deadline could be evaluated while the
    // timer fired underneath, finishing the run and dropping the verdict.
    const snapshot = await seedSession('supervised_audit');
    let releaseSecondDecision: (() => void) | undefined;
    mockSupervisionDecide
      .mockResolvedValueOnce({
        decision: 'waiting',
        reason: 'blocked awaiting the delegated validation reply',
        confidence: 0.9,
      })
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseSecondDecision = () => resolve({
          decision: 'complete',
          reason: 'delegated validation returned and the work is done',
          confidence: 0.95,
          requiresAudit: false,
        });
      }));

    // This file does not reset supervision state between tests, and a run left
    // active by an earlier test changes which branch the second decision takes
    // — enough to make this assertion pass while the defect is present.
    supervisionAutomation.cancelSession('deck_supervision_brain');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      supervisionAutomation.init();
      supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-park-race', 'implement the feature', snapshot);
      beginRun('cmd-park-race', 'implement the feature');
      completeTurn('Blocked on the delegated validation reply.');
      await vi.waitFor(async () => {
        expect(mockSupervisionDecide).toHaveBeenCalledTimes(1);
      }, { timeout: 4_000 });

      // The verdict lands; evaluation starts but the broker has not answered.
      completeTurn('Delegated validation returned; everything is finished.');
      await vi.waitFor(async () => {
        expect(mockSupervisionDecide).toHaveBeenCalledTimes(2);
      }, { timeout: 4_000 });

      // Baseline BEFORE advancing: the timeout warning would be emitted DURING
      // the advance, so capturing after it would slice the very event under
      // test out of the window. (The timeline is not reset between tests in
      // this file, hence the slice rather than replaying from 0.)
      const before = timelineEmitter.replay('deck_supervision_brain', 0).events.length;

      // Push past the original deadline while that decision is still in flight.
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
      expect(releaseSecondDecision).toBeDefined();
      releaseSecondDecision!();

      // Let the released decision settle, then assert the park did NOT expire.
      // (`complete` in supervised_audit mode starts an audit rather than
      // emitting supervision_complete, so the timeout warning — not a
      // completion status — is what distinguishes the two outcomes here.)
      await vi.advanceTimersByTimeAsync(50);
      const fresh = timelineEmitter.replay('deck_supervision_brain', 0).events.slice(before);
      const expired = fresh.some((event) => typeof event.payload?.text === 'string'
        && event.payload.text.includes('parked-wait limit'));
      // (A `complete` decision legitimately ends the run, so the run's absence
      // proves nothing here — the timeout warning is the only signal that
      // separates "verdict applied" from "park expired and dropped it".)
      expect(expired).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a rejected evaluation after cancellation instead of terminating its replacement run', async () => {
    const snapshot = await seedSession('supervised_audit');
    let rejectOldDecision: ((error: Error) => void) | undefined;
    mockSupervisionDecide.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectOldDecision = reject;
    }));

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-old-evaluation', 'old task', snapshot);
    beginRun('cmd-old-evaluation', 'old task');
    completeTurn('old task completion');
    await vi.waitFor(() => {
      expect(mockSupervisionDecide).toHaveBeenCalledTimes(1);
    }, { timeout: 4_000 });

    supervisionAutomation.cancelSession('deck_supervision_brain');
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-replacement', 'replacement task', snapshot);
    beginRun('cmd-replacement', 'replacement task');
    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      commandId: 'cmd-replacement',
      phase: 'execution',
    });

    rejectOldDecision?.(new Error('old broker request failed after cancellation'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({
      commandId: 'cmd-replacement',
      phase: 'execution',
    });
    expect(timelineEmitter.replay('deck_supervision_brain', 0).events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'assistant.text',
        payload: expect.objectContaining({
          automationKind: 'supervision-warning',
          text: expect.stringContaining('could not determine whether the task is complete'),
        }),
      }),
    ]));
  });

  it('hands a parked run back to the human when the reply never arrives', async () => {
    const snapshot = await seedSession('supervised_audit');
    mockSupervisionDecide.mockResolvedValue({
      decision: 'waiting',
      reason: 'blocked awaiting the delegated validation reply',
      confidence: 0.9,
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      supervisionAutomation.init();
      supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-park-timeout', 'implement the feature', snapshot);
      beginRun('cmd-park-timeout', 'implement the feature');
      completeTurn('Still blocked on the delegated validation reply.');

      await vi.waitFor(async () => {
        expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toMatchObject({ phase: 'execution' });
      }, { timeout: 4_000 });

      // Parking must not be permanent: a lost reply has to surface, not strand.
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
      expect(supervisionAutomation.getActiveRun('deck_supervision_brain')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
  it('scopes the delegated audit when the broker calls the change narrow', async () => {
    // requiresAudit is a yes/no, so a two-line stylesheet tweak was billed the
    // same full audit as a cross-layer state-machine change. That is the main
    // reason supervised sessions feel audited constantly.
    const snapshot = await seedSession('supervised_audit');
    supervisionAutomation.cancelSession('deck_supervision_brain');
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'complete',
      reason: 'presentational tweak only',
      confidence: 0.95,
      requiresAudit: true,
      auditDepth: 'narrow',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-narrow', 'tweak the spacing', snapshot);
    beginRun('cmd-narrow', 'tweak the spacing');
    completeTurn('Adjusted one CSS rule.');

    await vi.waitFor(() => {
      expect(mockTransportRuntime.send).toHaveBeenCalled();
    }, { timeout: 4_000 });
    const auditPrompt = String(mockTransportRuntime.send.mock.calls.at(-1)?.[0]);
    expect(auditPrompt).toContain('this change is NARROW');
    // Proportionate, not lax: evidence is still required.
    expect(auditPrompt).toContain('executable evidence');
  });

  it('does not scope the audit for a standard change', async () => {
    const snapshot = await seedSession('supervised_audit');
    supervisionAutomation.cancelSession('deck_supervision_brain');
    mockSupervisionDecide.mockResolvedValueOnce({
      decision: 'complete',
      reason: 'cross-layer state machine change',
      confidence: 0.95,
      requiresAudit: true,
      auditDepth: 'standard',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-standard', 'rework the queue', snapshot);
    beginRun('cmd-standard', 'rework the queue');
    completeTurn('Reworked the transport queue.');

    await vi.waitFor(() => {
      expect(mockTransportRuntime.send).toHaveBeenCalled();
    }, { timeout: 4_000 });
    expect(String(mockTransportRuntime.send.mock.calls.at(-1)?.[0])).not.toContain('this change is NARROW');
  });
  it('re-opens the full surface after a REWORK even if the broker still says narrow', async () => {
    // The previous verdict already said a narrow read was not enough; letting
    // the re-audit stay narrow would re-run the same insufficient check.
    const snapshot = await seedSession('supervised_audit');
    supervisionAutomation.cancelSession('deck_supervision_brain');
    mockSupervisionDecide.mockResolvedValue({
      decision: 'complete',
      reason: 'small change',
      confidence: 0.95,
      requiresAudit: true,
      auditDepth: 'narrow',
    });

    supervisionAutomation.init();
    supervisionAutomation.registerTaskIntent('deck_supervision_brain', 'cmd-narrow-rework', 'tweak it', snapshot);
    beginRun('cmd-narrow-rework', 'tweak it');
    completeTurn('Adjusted one rule.');
    await waitForRunPhase('auditing');

    completeDelegatedAudit('REWORK', 'Blocking: the tweak breaks an adjacent case.');
    await waitForRunPhase('execution');

    mockTransportRuntime.send.mockClear();
    completeTurn('Fixed the adjacent case.');
    await vi.waitFor(() => {
      expect(mockTransportRuntime.send).toHaveBeenCalled();
    }, { timeout: 4_000 });

    // Broker still says narrow, but the rework must force the full surface.
    expect(String(mockTransportRuntime.send.mock.calls.at(-1)?.[0])).not.toContain('this change is NARROW');
  });
});
