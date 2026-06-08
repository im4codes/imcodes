import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  OPENSPEC_AUTO_DELIVER_MSG,
  OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS,
} from '../../shared/openspec-auto-deliver-constants.js';
import { formatOpenSpecPromptTemplate } from '../../shared/openspec-prompt-templates.js';

interface MockP2pRun {
  id: string;
  status: string;
  contextFilePath: string;
  mainSession?: string;
  launchOrigin?: unknown;
  userText?: string;
  locale?: string;
  resultSummary?: string | null;
  strictAuthoritativeResult?: string | null;
  error?: string | null;
}

const { getSessionMock, listSessionsMock, getSavedP2pConfigMock, getTransportRuntimeMock, serverLinkMock, transportSendMock, p2pRuns, startP2pRunMock, getP2pRunMock, listP2pRunsMock, cancelP2pRunMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  listSessionsMock: vi.fn(),
  getSavedP2pConfigMock: vi.fn(),
  getTransportRuntimeMock: vi.fn(),
  serverLinkMock: { send: vi.fn() },
  transportSendMock: vi.fn(() => 'sent'),
  p2pRuns: new Map<string, MockP2pRun>(),
  startP2pRunMock: vi.fn(),
  getP2pRunMock: vi.fn((id: string) => p2pRuns.get(id)),
  listP2pRunsMock: vi.fn(() => [...p2pRuns.values()]),
  cancelP2pRunMock: vi.fn(async (id: string) => {
    const run = p2pRuns.get(id);
    if (run) run.status = 'cancelled';
    return !!run;
  }),
}));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
  listSessions: listSessionsMock,
}));

vi.mock('../../src/store/p2p-config-store.js', () => ({
  getSavedP2pConfig: getSavedP2pConfigMock,
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  getTransportRuntime: getTransportRuntimeMock,
}));

vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({
  startP2pRun: startP2pRunMock,
  getP2pRun: getP2pRunMock,
  listP2pRuns: listP2pRunsMock,
  cancelP2pRun: cancelP2pRunMock,
}));

import {
  clearOpenSpecAutoDeliverRunsForTests,
  getOpenSpecAutoDeliverTransitionTarget,
  handleOpenSpecAutoDeliverDaemonRestartCleanup,
  handleOpenSpecAutoDeliverCommand,
} from '../../src/daemon/openspec-auto-deliver-orchestrator.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { getAutoDeliverP2pLock } from '../../src/daemon/p2p-launch-admission.js';

let projectDir: string;
let extraTempDirs: string[];
const execFileAsync = promisify(execFile);

async function makeChange(name: string, tasks = '- [ ] first\n- [x] second\n'): Promise<void> {
  const root = join(projectDir, 'openspec', 'changes', name);
  await mkdir(join(root, 'specs', 'demo'), { recursive: true });
  await writeFile(join(root, 'proposal.md'), '# Proposal\n', 'utf8');
  await writeFile(join(root, 'tasks.md'), tasks, 'utf8');
  await writeFile(join(root, 'specs', 'demo', 'spec.md'), '## ADDED Requirements\n\n### Requirement: Demo\n\n#### Scenario: Demo\n- **WHEN** demo\n- **THEN** demo\n', 'utf8');
}

async function waitForSend(predicate: (msg: Record<string, unknown>) => boolean, maxMs = 1000): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const found = serverLinkMock.send.mock.calls.map((call) => call[0] as Record<string, unknown>).find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected websocket send was not observed');
}

async function waitForTransportSend(predicate: (text: string) => boolean, maxMs = 1000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const found = transportSendMock.mock.calls.map((call) => String(call[0] ?? '')).find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected transport send was not observed');
}

async function git(args: string[], cwd = projectDir): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout?.toString?.() ?? '';
}

async function initializeGitWithRemote(): Promise<string> {
  const remoteDir = await mkdtemp(join(tmpdir(), `imcodes-auto-deliver-remote-${Date.now()}-`));
  extraTempDirs.push(remoteDir);
  await execFileAsync('git', ['init', '--bare', remoteDir], { timeout: 30_000 });
  await execFileAsync('git', ['init', projectDir], { timeout: 30_000 });
  await git(['config', 'user.email', 'auto-deliver@example.test']);
  await git(['config', 'user.name', 'Auto Deliver Test']);
  await git(['checkout', '-B', 'main']);
  await git(['add', '--', '.']);
  await git(['commit', '-m', 'Initial project']);
  await git(['remote', 'add', 'origin', remoteDir]);
  await git(['push', '-u', 'origin', 'main']);
  return remoteDir;
}

function auditPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: 'PASS',
    module_scores: OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS.map((module) => ({
      module,
      score: 9,
      max_score: 10,
      summary: `${module} ok`,
    })),
    unchecked_tasks: [],
    required_changes: [],
    repairs_applied: [],
    evidence: [{ source: 'audit_reported', summary: 'audit passed' }],
    ...overrides,
  };
}

function parseAuditMetadata(run: MockP2pRun): Record<string, unknown> {
  const text = run.userText ?? '';
  const lineValue = (label: string): string => {
    const found = text.split('\n').find((line) => line.startsWith(`${label}: `));
    return found?.slice(label.length + 2).trim() ?? '';
  };
  const origin = (run.launchOrigin as { autoDeliver?: Record<string, unknown> } | undefined)?.autoDeliver ?? {};
  return {
    runId: lineValue('Run id') || origin.runId,
    changeName: origin.changeName,
    resolvedChangeRootIdentity: lineValue('Resolved change root identity'),
    stage: lineValue('Stage') || origin.stage,
    selectedTeamComboId: lineValue('Selected Team combo id') || origin.selectedTeamComboId,
    activeOpenSpecPromptId: lineValue('Active OpenSpec prompt id') || origin.activeOpenSpecPromptId,
    roundIndex: Number((lineValue('Round') || '0/0').split('/')[0]),
    attemptId: lineValue('Attempt id') || origin.attemptId,
    authoritativeResultPath: lineValue('Authoritative result file'),
    owningMainSessionName: lineValue('Owning main session') || origin.owningMainSessionName,
    executionSessionName: lineValue('Execution session'),
    generation: Number(lineValue('Generation') || origin.generation),
  };
}

function expectAuditPromptWithoutVerdictSkeleton(text: string): void {
  expect(text).not.toContain('```');
  expect(text).not.toContain('```json');
  expect(text).not.toContain('"auto_deliver"');
  expect(text).not.toContain('"verdict"');
  expect(text).not.toContain('"module_scores"');
  expect(text).not.toContain('PASS | REWORK | BLOCKED');
}

function expectAuthoritativeResultSchemaHints(text: string): void {
  expect(text).toContain('Allowed verdict values: PASS, REWORK, BLOCKED');
  expect(text).toContain('module_scores must contain exactly one entry for each module');
  expect(text).toContain('Each module_scores entry uses fields: module, score, max_score, summary; max_score must be 10');
  expect(text).toContain('Each repairs_applied entry uses fields: files, reason');
  expect(text).toContain('Each evidence entry requires fields: source, summary; optional fields: command, exitCode');
  expect(text).toContain('PASS must leave unchecked_tasks and required_changes empty');
}

async function completeLatestAudit(status = 'completed', payloadOverrides: Record<string, unknown> = {}): Promise<void> {
  const run = [...p2pRuns.values()].at(-1);
  if (!run) throw new Error('No mocked P2P run exists');
  run.status = status;
  const origin = parseAuditMetadata(run);
  const resultJson = JSON.stringify(auditPayload({ auto_deliver: origin, ...payloadOverrides }), null, 2);
  run.resultSummary = `# audit result\n\nWrote authoritative result to ${origin.authoritativeResultPath}.`;
  run.strictAuthoritativeResult = null;
  await writeFile(run.contextFilePath, run.resultSummary, 'utf8');
  await writeFile(String(origin.authoritativeResultPath), resultJson, 'utf8');
}

async function startFastImplementationAudit(requestId: string): Promise<MockP2pRun> {
  await makeChange('demo-change', '- [x] first\n- [x] second\n');
  await handleOpenSpecAutoDeliverCommand({
    type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
    requestId,
    sessionName: 'deck_demo_brain',
    changeName: 'demo-change',
    presetId: 'fast',
  }, serverLinkMock as never);
  timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
  await waitForSend((msg) =>
    msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
    && msg.projection?.stage === 'implementation_audit_repair',
    2500,
  );
  return [...p2pRuns.values()].at(-1)!;
}

describe('OpenSpec Auto Deliver daemon orchestrator', () => {
  beforeEach(async () => {
    projectDir = join(tmpdir(), `imcodes-auto-deliver-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    extraTempDirs = [];
    await makeChange('demo-change');
    serverLinkMock.send.mockClear();
    transportSendMock.mockClear();
    p2pRuns.clear();
    startP2pRunMock.mockReset();
    getP2pRunMock.mockClear();
    listP2pRunsMock.mockImplementation(() => [...p2pRuns.values()]);
    cancelP2pRunMock.mockClear();
    startP2pRunMock.mockImplementation(async (opts: { launchOrigin?: unknown; userText?: string; initiatorSession?: string; locale?: string }) => {
      const id = `p2p-${p2pRuns.size + 1}`;
      const contextFilePath = join(projectDir, '.imc', 'discussions', `${id}.md`);
      await mkdir(join(projectDir, '.imc', 'discussions'), { recursive: true });
      await writeFile(contextFilePath, '# mocked p2p\n', 'utf8');
      const run = { id, status: 'queued', contextFilePath, mainSession: opts.initiatorSession, launchOrigin: opts.launchOrigin, userText: opts.userText, locale: opts.locale };
      p2pRuns.set(id, run);
      return run;
    });
    getTransportRuntimeMock.mockReset();
    getTransportRuntimeMock.mockImplementation(() => ({ send: transportSendMock }));
    clearOpenSpecAutoDeliverRunsForTests();
    getSessionMock.mockImplementation((name: string) => ({
      name,
      projectName: 'demo',
      projectDir,
      role: name.startsWith('deck_sub_') ? 'w1' : 'brain',
      agentType: 'codex-sdk',
      runtimeType: 'transport',
      state: 'idle',
      parentSession: name.startsWith('deck_sub_') ? 'deck_demo_brain' : undefined,
    }));
    listSessionsMock.mockImplementation(() => [
      getSessionMock('deck_demo_brain'),
      getSessionMock('deck_sub_worker'),
      getSessionMock('deck_sub_peer'),
    ]);
    getSavedP2pConfigMock.mockResolvedValue({
      sessions: {
        deck_demo_brain: { enabled: true, mode: 'audit' },
        deck_sub_worker: { enabled: true, mode: 'review' },
        deck_sub_peer: { enabled: true, mode: 'plan' },
      },
      rounds: 1,
    });
  });

  afterEach(async () => {
    clearOpenSpecAutoDeliverRunsForTests();
    await rm(projectDir, { recursive: true, force: true });
    await Promise.all(extraTempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('launches from a sub-session, parses tasks, and returns idempotent launch ack', async () => {
    const command = {
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-1',
      sessionName: 'deck_sub_worker',
      changeName: 'demo-change',
      presetId: 'standard',
    };
    await handleOpenSpecAutoDeliverCommand(command, serverLinkMock as never);
    await handleOpenSpecAutoDeliverCommand(command, serverLinkMock as never);

    const acks = serverLinkMock.send.mock.calls
      .map((call) => call[0])
      .filter((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ACK);
    expect(acks).toHaveLength(2);
    expect(acks[0].projection.runId).toBe(acks[1].projection.runId);
    expect(acks[0].projection.owningMainSessionName).toBe('deck_demo_brain');
    expect(acks[0].projection.launchedFromSessionName).toBe('deck_sub_worker');
    expect(acks[0].projection.targetImplementationSessionName).toBe('deck_sub_worker');
    expect(acks[0].projection.taskStats).toMatchObject({ total: 2, checked: 1, unchecked: 1 });
    expect(startP2pRunMock).toHaveBeenCalledTimes(1);
    expect(startP2pRunMock).toHaveBeenCalledWith(expect.objectContaining({
      initiatorSession: 'deck_sub_worker',
      targets: [
        { session: 'deck_demo_brain', mode: 'audit>review>plan' },
        { session: 'deck_sub_peer', mode: 'audit>review>plan' },
      ],
    }));
    expect(startP2pRunMock).not.toHaveBeenCalledWith(expect.objectContaining({
      initiatorSession: 'deck_demo_brain',
    }));
  });

  it('passes the selected UI locale through Auto Deliver Team/P2P audit launches', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-locale',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
      locale: 'zh-CN',
    }, serverLinkMock as never);

    expect(startP2pRunMock).toHaveBeenCalledWith(expect.objectContaining({
      locale: 'zh-CN',
    }));
    const audit = [...p2pRuns.values()].at(-1)!;
    expect(audit.locale).toBe('zh-CN');
  });

  it('scopes spec-audit verdicts to artifact readiness rather than unfinished implementation tasks', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-spec-verdict-scope',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    const audit = [...p2pRuns.values()].at(-1)!;
    expect(audit.userText).toContain('Spec-stage verdict scope:');
    expect(audit.userText).toContain('Return PASS when proposal.md, design.md, specs/**/spec.md, and tasks.md are internally consistent');
    expect(audit.userText).toContain('Do not return REWORK merely because product implementation or product tests remain unfinished');
    expect(audit.userText).toContain('leave unchecked_tasks and required_changes empty');
    expect(audit.userText).toContain('Return REWORK only when the OpenSpec artifacts themselves still need another spec-audit repair attempt');
  });

  it('preserves an explicit single implementation audit limit in launched audit prompts', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');

    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-impl-limit-one',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'deep',
      materializedLimits: {
        specAuditRepairRounds: 0,
        implementationAuditRepairRounds: 1,
        maxImplementationPrompts: 24,
        maxElapsedMinutes: 480,
      },
    }, serverLinkMock as never);
    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });

    const audit = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_audit_repair',
      2500,
    );
    const p2pRun = [...p2pRuns.values()].at(-1)!;
    expect(audit.projection.materializedLimits.implementationAuditRepairRounds).toBe(1);
    expect(p2pRun.userText).toContain('Round: 1/1');
    expect(startP2pRunMock).toHaveBeenLastCalledWith(expect.objectContaining({
      rounds: 1,
      modeOverride: 'audit>review>plan',
    }));
  });

  it('records only final implementation assistant text as evidence before the audit prompt', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-final-evidence',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    timelineEmitter.emit('deck_demo_brain', 'assistant.text', { text: 'Open', streaming: true });
    timelineEmitter.emit('deck_demo_brain', 'assistant.text', { text: 'OpenSpec now reports `143', streaming: true });
    timelineEmitter.emit('deck_demo_brain', 'assistant.text', {
      text: 'Implemented final text with exact validation commands.',
      streaming: false,
    });

    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_audit_repair',
      2500,
    );

    const audit = [...p2pRuns.values()].at(-1)!;
    expect(audit.userText).toContain('- implementation_reported: Implemented final text with exact validation commands.');
    expect(audit.userText).not.toContain('- implementation_reported: Open');
    expect(audit.userText).not.toContain('OpenSpec now reports `143');
  });

  it('rejects launch before lock when no Team member configuration is saved', async () => {
    getSavedP2pConfigMock.mockResolvedValue(undefined);

    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-no-team-config',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    const error = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ERROR
      && msg.error === 'no_saved_config',
    );
    expect(error.error).toBe('no_saved_config');
    expect(startP2pRunMock).not.toHaveBeenCalled();
    expect(getAutoDeliverP2pLock('deck_demo_brain')).toBeUndefined();
  });

  it('keeps the fixed state transition table fail-closed for unlisted transitions', () => {
    expect(getOpenSpecAutoDeliverTransitionTarget('proposed', 'spec_audit_started')).toBe('spec_audit_repair');
    expect(getOpenSpecAutoDeliverTransitionTarget('proposed', 'implementation_prompt_dispatched')).toBe('implementation_task_loop');
    expect(getOpenSpecAutoDeliverTransitionTarget('spec_audit_repair', 'spec_audit_pass')).toBe('implementation_task_loop');
    expect(getOpenSpecAutoDeliverTransitionTarget('spec_audit_repair', 'spec_audit_rework')).toBe('implementation_task_loop');
    expect(getOpenSpecAutoDeliverTransitionTarget('spec_audit_repair', 'spec_audit_blocked')).toBe('implementation_task_loop');
    expect(getOpenSpecAutoDeliverTransitionTarget('implementation_task_loop', 'implementation_idle_incomplete')).toBe('implementation_task_loop');
    expect(getOpenSpecAutoDeliverTransitionTarget('implementation_task_loop', 'implementation_idle_all_checked')).toBe('implementation_audit_repair');
    expect(getOpenSpecAutoDeliverTransitionTarget('implementation_audit_repair', 'implementation_audit_pass')).toBe('passed');
    expect(getOpenSpecAutoDeliverTransitionTarget('implementation_audit_repair', 'implementation_audit_rework')).toBe('passed');
    expect(getOpenSpecAutoDeliverTransitionTarget('implementation_audit_repair', 'implementation_audit_blocked')).toBe('passed');
    expect(getOpenSpecAutoDeliverTransitionTarget('implementation_audit_repair', 'auto_commit_push_dispatched')).toBe('commit_push');
    expect(getOpenSpecAutoDeliverTransitionTarget('commit_push', 'implementation_audit_pass')).toBeNull();
    expect(getOpenSpecAutoDeliverTransitionTarget('passed', 'implementation_prompt_dispatched')).toBeNull();
    expect(getOpenSpecAutoDeliverTransitionTarget('needs_human', 'implementation_audit_pass')).toBeNull();
    expect(getOpenSpecAutoDeliverTransitionTarget('stopped', 'spec_audit_started')).toBeNull();
  });

  it('rejects a second active run and stop returns terminal projection', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-1',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-2',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    const error = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ERROR);
    expect(error?.error).toBe('auto_deliver_active');

    const runId = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ACK).projection.runId;
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.STOP,
      requestId: 'stop-1',
      sessionName: 'deck_demo_brain',
      runId,
    }, serverLinkMock as never);
    const stopAck = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.STOP_ACK);
    expect(stopAck?.ok).toBe(true);
    expect(stopAck?.projection.status).toBe('stopped');
  });

  it('continues implementation prompts until tasks.md is fully checked', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-loop',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    const firstImplementationPrompt = await waitForTransportSend((text) =>
      text.includes('Drive the implementation of @openspec/changes/demo-change aggressively.'),
    );
    expect(firstImplementationPrompt).toContain('Break the work into concrete sub-tasks');
    expect(firstImplementationPrompt).toContain('OpenSpec Auto Deliver context for @openspec/changes/demo-change.');
    expect(firstImplementationPrompt).toContain('Remaining tasks:');

    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && (msg.projection as { implementationPromptCount?: number } | undefined)?.implementationPromptCount === 2,
    );

    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });

    const auditProjection = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && (msg.projection as { stage?: string } | undefined)?.stage === 'implementation_audit_repair',
    );
    expect(auditProjection.projection.selectedTeamComboId).toBe('audit>review>plan');
    expect(auditProjection.projection.activeOpenSpecPromptId).toBe('implementation_audit');
    expect(auditProjection.projection.implementationAuditRound).toEqual({ current: 0, total: 1 });
    const implementationLaunch = startP2pRunMock.mock.calls.at(-1)?.[0] as {
      modeOverride?: string;
      rounds?: number;
      advanced?: unknown;
      advancedRounds?: unknown;
      fileContents?: Array<{ path: string; content: string }>;
      targets?: Array<{ session: string; mode: string }>;
      userText?: string;
    };
    expect(implementationLaunch.modeOverride).toBe('audit>review>plan');
    expect(implementationLaunch.rounds).toBe(1);
    expect(implementationLaunch.advanced).toBeUndefined();
    expect(implementationLaunch.advancedRounds).toBeUndefined();
    expect(implementationLaunch.fileContents).toEqual([]);
    expect(implementationLaunch.targets).toEqual([
      { session: 'deck_sub_peer', mode: 'audit>review>plan' },
      { session: 'deck_sub_worker', mode: 'audit>review>plan' },
    ]);
    expect(implementationLaunch.userText).toContain('Change reference: @openspec/changes/demo-change');
    expect(implementationLaunch.userText).toContain('This discussion intentionally references only the change folder instead of embedding artifact contents.');
    expect(implementationLaunch.userText).not.toContain('Resolved change root: ');
    expect(implementationLaunch.userText).toContain('Perform a strict implementation audit for @openspec/changes/demo-change against its OpenSpec artifacts.');
    expect(implementationLaunch.userText).toContain('normal Team/P2P combo flow (audit>review>plan)');
    expect(implementationLaunch.userText).toContain('implementation_audit criteria');

    await completeLatestAudit('completed');
    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 8000);
    expect(terminal?.projection.status).toBe('passed');
    expect(terminal?.projection.terminalReason).toBe('final_audit_passed');
  });

  it('asks the implementation LLM to commit&push, then verifies product changes after final implementation audit PASS when opted in', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await writeFile(join(projectDir, '.gitignore'), '.imc/\n', 'utf8');
    const remoteDir = await initializeGitWithRemote();
    await mkdir(join(projectDir, 'src'), { recursive: true });
    await writeFile(join(projectDir, 'src', 'preexisting.ts'), 'export const preexisting = true;\n', 'utf8');

    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-auto-commit',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
      autoCommitPush: true,
    }, serverLinkMock as never);

    await writeFile(join(projectDir, 'src', 'feature.ts'), 'export const delivered = true;\n', 'utf8');
    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_audit_repair',
      2500,
    );

    await completeLatestAudit('completed', {
      repairs_applied: [{ files: ['src/feature.ts'], reason: 'Implemented the product change.' }],
    });
    const prompt = await waitForTransportSend((text) => text === 'commit&push', 2500);
    expect(prompt).toBe('commit&push');
    const commitMessage = 'Implement delivered feature';
    await git(['add', '--', 'src/feature.ts']);
    await git(['commit', '-m', commitMessage]);
    await git(['push']);
    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 8000);
    expect(terminal?.projection.status).toBe('passed');
    expect(terminal?.projection.evidence?.map((entry: { summary?: string }) => entry.summary).join('\n')).toContain('Auto commit/push verified by daemon');

    expect(await git(['status', '--porcelain', '--', 'src/feature.ts'])).toBe('');
    expect(await git(['status', '--porcelain', '--', 'src/preexisting.ts'])).toContain('src/preexisting.ts');
    expect(await git(['log', '--oneline', '-1'])).toContain(commitMessage);
    const remoteLog = await execFileAsync('git', ['--git-dir', remoteDir, 'log', '--oneline', 'main', '-1'], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    expect(remoteLog.stdout?.toString?.() ?? '').toContain(commitMessage);
  }, 15_000);

  it('runs the Standard preset from spec audit through implementation audit PASS', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-standard-e2e',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    const specAuditProjection = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'spec_audit_repair');
    expect(specAuditProjection.projection.specAuditRound).toEqual({ current: 0, total: 1 });
    await completeLatestAudit('completed');
    const implementationPromptProjection = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && (msg.projection as { stage?: string; implementationPromptCount?: number }).stage === 'implementation_task_loop'
      && (msg.projection as { implementationPromptCount?: number }).implementationPromptCount === 1,
      2500,
    );
    expect(implementationPromptProjection.projection.specAuditRound).toEqual({ current: 1, total: 1 });

    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    const implementationAuditProjection = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');
    expect(implementationAuditProjection.projection.implementationAuditRound).toEqual({ current: 0, total: 2 });
    await completeLatestAudit('completed');
    await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_audit_repair'
      && msg.projection?.implementationAuditRound?.current === 1,
      2500,
    );
    await completeLatestAudit('completed');

    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('passed');
    expect(terminal?.projection.moduleScores).toHaveLength(OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS.length);
    expect(terminal?.projection.implementationAuditRound).toEqual({ current: 2, total: 2 });
    expect(terminal?.projection.auditResults).toHaveLength(3);
  });

  it('starts the materialized spec audit-repair stage for presets with spec rounds', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-spec-audit',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    expect(startP2pRunMock).toHaveBeenCalledWith(expect.objectContaining({
      modeOverride: 'audit>review>plan',
      rounds: 1,
      targets: [
        { session: 'deck_sub_peer', mode: 'audit>review>plan' },
        { session: 'deck_sub_worker', mode: 'audit>review>plan' },
      ],
      launchOrigin: expect.objectContaining({
        kind: 'openspec_auto_deliver',
        autoDeliver: expect.objectContaining({
          selectedTeamComboId: 'audit>review>plan',
          activeOpenSpecPromptId: 'proposal_audit',
          stage: 'spec_audit_repair',
        }),
      }),
    }));
    const specLaunch = startP2pRunMock.mock.calls.at(-1)?.[0] as {
      modeOverride?: string;
      rounds?: number;
      advanced?: unknown;
      advancedRounds?: unknown;
      fileContents?: Array<{ path: string; content: string }>;
      targets?: Array<{ session: string; mode: string }>;
      userText?: string;
    };
    expect(specLaunch.modeOverride).toBe('audit>review>plan');
    expect(specLaunch.rounds).toBe(1);
    expect(specLaunch.advanced).toBeUndefined();
    expect(specLaunch.advancedRounds).toBeUndefined();
    expect(specLaunch.fileContents).toEqual([]);
    expect(specLaunch.targets).toEqual([
      { session: 'deck_sub_peer', mode: 'audit>review>plan' },
      { session: 'deck_sub_worker', mode: 'audit>review>plan' },
    ]);
    expect(specLaunch.userText).toContain('Change reference: @openspec/changes/demo-change');
    expect(specLaunch.userText).toContain('This discussion intentionally references only the change folder instead of embedding artifact contents.');
    expect(specLaunch.userText).not.toContain('Resolved change root: ');
    expect(specLaunch.userText).toContain('Perform a strict specification audit for @openspec/changes/demo-change.');
    expect(specLaunch.userText).toContain('then directly update the change artifacts under @openspec/changes/demo-change (proposal, design, specs, tasks)');
    expect(specLaunch.userText).toContain('normal Team/P2P combo flow (audit>review>plan)');
    expect(specLaunch.userText).toContain('proposal_audit criteria');
    const projection = serverLinkMock.send.mock.calls
      .map((call) => call[0])
      .find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'spec_audit_repair');
    expect(projection?.projection.activeP2pRunId).toBe('p2p-1');
  });

  it('builds audit prompts from canonical OpenSpec templates with authoritative result path metadata', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-audit-prompt-metadata',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    const reference = '@openspec/changes/demo-change';
    const specRun = [...p2pRuns.values()].at(-1)!;
    const specMetadata = parseAuditMetadata(specRun);
    const specPath = String(specMetadata.authoritativeResultPath);
    const specOrigin = specRun.launchOrigin as { autoDeliver?: Record<string, unknown> };
    expect(specRun.userText).toContain(formatOpenSpecPromptTemplate('audit_spec', reference));
    expect(specRun.userText).toContain(`Authoritative result file: ${specPath}`);
    expect(specRun.userText).toContain('Required auto_deliver fields:');
    expect(specRun.userText).toContain('authoritativeResultPath');
    expectAuthoritativeResultSchemaHints(specRun.userText ?? '');
    expect(specOrigin.autoDeliver?.authoritativeResultPath).toBe(specPath);
    expectAuditPromptWithoutVerdictSkeleton(specRun.userText ?? '');

    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await completeLatestAudit('completed');
    await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_task_loop',
      2500,
    );
    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_audit_repair',
      2500,
    );

    const implementationRun = [...p2pRuns.values()].at(-1)!;
    const implementationMetadata = parseAuditMetadata(implementationRun);
    const implementationPath = String(implementationMetadata.authoritativeResultPath);
    const implementationOrigin = implementationRun.launchOrigin as { autoDeliver?: Record<string, unknown> };
    expect(implementationRun.userText).toContain(formatOpenSpecPromptTemplate('audit_implementation', reference));
    expect(implementationRun.userText).toContain(`Authoritative result file: ${implementationPath}`);
    expect(implementationRun.userText).toContain('Required auto_deliver fields:');
    expect(implementationRun.userText).toContain('authoritativeResultPath');
    expectAuthoritativeResultSchemaHints(implementationRun.userText ?? '');
    expect(implementationOrigin.autoDeliver?.authoritativeResultPath).toBe(implementationPath);
    expectAuditPromptWithoutVerdictSkeleton(implementationRun.userText ?? '');
  });

  it('rejects launch while a manual Team run is active for the owning session', async () => {
    p2pRuns.set('manual-1', {
      id: 'manual-1',
      mainSession: 'deck_demo_brain',
      status: 'running',
      contextFilePath: join(projectDir, '.imc', 'discussions', 'manual-1.md'),
    });

    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-busy',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    const error = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ERROR);
    expect(error?.error).toBe('team_lane_busy');
  });

  it('adds one audit-fix round when final audit PASS still has unchecked tasks', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-final-gate',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');
    await makeChange('demo-change', '- [ ] first\n- [x] second\n');
    await completeLatestAudit('completed');

    const gate = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.lastMessage === 'audit_pass_with_unchecked_tasks',
      2500,
    );
    expect(gate.projection.status).toBe('implementation_audit_repair');
    expect(gate.projection.implementationAuditRound).toEqual({ current: 1, total: 2 });

    await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_audit_repair'
      && msg.projection?.activeP2pRunId === 'p2p-2',
      2500,
    );
    expect([...p2pRuns.values()]).toHaveLength(2);
  });

  it('continues after a sufficiently scored spec audit REWORK and records the round scores', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-spec-rework',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'spec_audit_repair');
    await completeLatestAudit('completed', {
      verdict: 'REWORK',
      required_changes: ['clarify acceptance criteria'],
    });

    const next = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_task_loop',
      2500,
    );
    expect(next.projection.latestVerdict).toBe('REWORK');
    expect(next.projection.moduleScores).toHaveLength(OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS.length);
    expect(next.projection.auditResults).toHaveLength(1);
    expect(next.projection.auditResults?.[0]?.requiredChanges).toEqual(['clarify acceptance criteria']);
    expect([...p2pRuns.values()]).toHaveLength(1);
  });

  it('completes with final scores when the final implementation audit reports sufficiently scored REWORK', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-rework',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');

    await completeLatestAudit('completed', {
      verdict: 'REWORK',
      required_changes: ['tighten tests'],
    });

    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('passed');
    expect(terminal?.projection.terminalReason).toBe('final_audit_rework_scored');
    expect(terminal?.projection.moduleScores).toHaveLength(OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS.length);
    expect(terminal?.projection.auditResults).toHaveLength(1);
    expect([...p2pRuns.values()]).toHaveLength(1);
  });

  it('adds one audit-fix round by default when a module score is below the quality threshold', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-low-score',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');
    await completeLatestAudit('completed', {
      module_scores: OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS.map((module) => ({
        module,
        score: module === 'tests' ? 5 : 8,
        max_score: 10,
        summary: `${module} scored`,
      })),
    });

    const gate = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && String(msg.projection?.lastMessage ?? '').startsWith('quality_gate_low_score:'),
      2500,
    );
    expect(gate.projection.status).toBe('implementation_audit_repair');
    expect(gate.projection.implementationAuditRound).toEqual({ current: 1, total: 2 });
    expect(gate.projection.auditResults).toHaveLength(1);

    await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_audit_repair'
      && msg.projection?.activeP2pRunId === 'p2p-2',
      2500,
    );
    expect([...p2pRuns.values()]).toHaveLength(2);
  });

  it('keeps valid missing authoritative result files classified as missing JSON', async () => {
    const firstAudit = await startFastImplementationAudit('req-valid-missing-result-file');
    const origin = parseAuditMetadata(firstAudit);
    firstAudit.status = 'completed';
    firstAudit.resultSummary = null;
    firstAudit.strictAuthoritativeResult = null;

    const repairPrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver needs the authoritative audit result file')
      && text.includes('Problem: missing_authoritative_json'),
      2500,
    );
    expect(repairPrompt).toContain(`Authoritative result file: ${origin.authoritativeResultPath}`);
    expect(repairPrompt).not.toContain('invalid_authoritative_result_path');
  });

  it('requests authoritative result file repair before consuming another audit-repair round', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-missing-json-retry',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');

    const firstAudit = [...p2pRuns.values()].at(-1)!;
    const origin = parseAuditMetadata(firstAudit);
    firstAudit.status = 'completed';
    firstAudit.resultSummary = null;
    firstAudit.strictAuthoritativeResult = null;
    const repairPrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver needs the authoritative audit result file')
      && text.includes('Problem: missing_authoritative_json'),
      2500,
    );
    expect(repairPrompt).toContain('do not redo the full audit from scratch');
    expect(repairPrompt).toContain(`Authoritative result file: ${origin.authoritativeResultPath}`);
    expect(repairPrompt).toContain(`"authoritativeResultPath": "${origin.authoritativeResultPath}"`);
    await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_audit_repair'
      && msg.projection?.implementationAuditRepairRound === 1
      && msg.projection?.lastMessage === 'authoritative_result_file_repair_prompt_dispatched',
      2500,
    );

    expect([...p2pRuns.values()]).toHaveLength(1);
    await writeFile(String(origin.authoritativeResultPath), JSON.stringify(auditPayload({ auto_deliver: origin }), null, 2), 'utf8');

    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('passed');
    expect(terminal?.projection.terminalReason).toBe('final_audit_passed');
  });

  it('keeps result-file repair prompts stage-scoped for spec audit repair', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-spec-missing-json-repair',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'spec_audit_repair');
    const firstAudit = [...p2pRuns.values()].at(-1)!;
    firstAudit.status = 'completed';
    firstAudit.resultSummary = null;
    firstAudit.strictAuthoritativeResult = null;

    const repairPrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver needs the authoritative audit result file')
      && text.includes('Spec-stage verdict scope:'),
      2500,
    );
    expect(repairPrompt).toContain('PASS means the OpenSpec artifacts are implementation-ready');
    expect(repairPrompt).toContain('implementation/test tasks in tasks.md remain unchecked for the next stage');
    expect(repairPrompt).toContain('Do not put implementation-stage follow-up tasks in unchecked_tasks or required_changes');
    expect(repairPrompt).toContain('REWORK means the OpenSpec artifacts themselves still require another spec-audit repair attempt');
    expect(repairPrompt).toContain('The top-level auto_deliver object must exactly equal this metadata object');
    expectAuthoritativeResultSchemaHints(repairPrompt);
    expect(repairPrompt).not.toContain('```');
    expect(repairPrompt).not.toContain('"module_scores"');
  });

  it('starts another full audit-repair round only after result-file repair also fails', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-missing-json-full-retry',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'spec_audit_repair');
    await completeLatestAudit('completed');
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_task_loop', 2500);
    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');

    const firstAudit = [...p2pRuns.values()].at(-1)!;
    firstAudit.status = 'completed';
    firstAudit.resultSummary = null;
    firstAudit.strictAuthoritativeResult = null;
    await waitForTransportSend((text) => text.includes('Problem: missing_authoritative_json'), 2500);
    await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_audit_repair'
      && msg.projection?.implementationAuditRepairRound === 2,
      3000,
    );

    const retryAudit = [...p2pRuns.values()].at(-1)!;
    expect(retryAudit.id).not.toBe(firstAudit.id);
    expect(retryAudit.userText).toContain('Previous audit-repair attempt did not produce a usable authoritative JSON result: missing_authoritative_json');
    expect(retryAudit.userText).toContain('Retry by writing the final raw JSON object to the authoritative result file path above');

    await completeLatestAudit('completed');
    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('passed');
    expect(terminal?.projection.terminalReason).toBe('final_audit_passed');
  });

  it('continues after a sufficiently scored spec audit BLOCKED verdict and records the round scores', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-blocked',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'spec_audit_repair');
    await completeLatestAudit('completed', {
      verdict: 'BLOCKED',
      required_changes: ['scope is unclear'],
    });

    const next = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_task_loop',
      2500,
    );
    expect(next.projection.latestVerdict).toBe('BLOCKED');
    expect(next.projection.moduleScores).toHaveLength(OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS.length);
    expect(next.projection.auditResults).toHaveLength(1);
  });

  it('rejects stale metadata and malformed or missing authoritative result files', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-stale-audit',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');
    await completeLatestAudit('completed', {
      auto_deliver: {
        ...parseAuditMetadata([...p2pRuns.values()].at(-1)!),
        generation: 999,
      },
    });
    let terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('needs_human');
    expect(terminal?.projection.terminalReason).toBe('audit_metadata_mismatch');
    expect(getAutoDeliverP2pLock('deck_demo_brain')).toBeUndefined();

    const terminalCountAfterStale = serverLinkMock.send.mock.calls.filter((call) =>
      call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL,
    ).length;
    const projectionCountAfterStale = serverLinkMock.send.mock.calls.filter((call) =>
      call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION,
    ).length;
    await completeLatestAudit('completed');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(serverLinkMock.send.mock.calls.filter((call) => call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL)).toHaveLength(terminalCountAfterStale);
    expect(serverLinkMock.send.mock.calls.filter((call) => call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION)).toHaveLength(projectionCountAfterStale);

    clearOpenSpecAutoDeliverRunsForTests();
    serverLinkMock.send.mockClear();
    p2pRuns.clear();
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-multiple-json',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);
    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');
    const run = [...p2pRuns.values()].at(-1)!;
    run.status = 'completed';
    run.resultSummary = null;
    run.strictAuthoritativeResult = null;
    terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.terminalReason).toBe('missing_authoritative_json');

    clearOpenSpecAutoDeliverRunsForTests();
    serverLinkMock.send.mockClear();
    p2pRuns.clear();
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-malformed-json-file',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);
    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');
    const malformedRun = [...p2pRuns.values()].at(-1)!;
    malformedRun.status = 'completed';
    await writeFile(String(parseAuditMetadata(malformedRun).authoritativeResultPath), '{not json', 'utf8');
    terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.terminalReason).toBe('malformed_authoritative_json');
  }, 10_000);

  it('rejects authoritative result files that symlink outside .imc/discussions', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-result-symlink-escape',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');
    const run = [...p2pRuns.values()].at(-1)!;
    run.status = 'completed';
    const origin = parseAuditMetadata(run);
    const outsideDir = await mkdtemp(join(tmpdir(), 'imcodes-auto-deliver-outside-result-'));
    extraTempDirs.push(outsideDir);
    const outsideResult = join(outsideDir, 'authoritative.json');
    await writeFile(outsideResult, JSON.stringify(auditPayload({ auto_deliver: origin }), null, 2), 'utf8');
    await symlink(outsideResult, String(origin.authoritativeResultPath), 'file');

    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('needs_human');
    expect(terminal?.projection.terminalReason).toBe('invalid_authoritative_result_path');
    expect(transportSendMock.mock.calls.some((call) => String(call[0] ?? '').includes('Problem: invalid_authoritative_result_path'))).toBe(false);
  });

  it('rejects .imc/discussions directory symlink escapes with the same invalid-path classification', async () => {
    await rm(join(projectDir, '.imc'), { recursive: true, force: true });
    await mkdir(join(projectDir, '.imc'), { recursive: true });
    const outsideDiscussions = await mkdtemp(join(tmpdir(), 'imcodes-auto-deliver-outside-discussions-'));
    extraTempDirs.push(outsideDiscussions);
    await symlink(outsideDiscussions, join(projectDir, '.imc', 'discussions'), 'dir');
    await makeChange('demo-change', '- [x] first\n- [x] second\n');

    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-discussions-symlink-escape',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');
    const run = [...p2pRuns.values()].at(-1)!;
    run.status = 'completed';

    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('needs_human');
    expect(terminal?.projection.terminalReason).toBe('invalid_authoritative_result_path');
    expect(transportSendMock.mock.calls.some((call) => String(call[0] ?? '').includes('Problem: invalid_authoritative_result_path'))).toBe(false);
  });

  it('ignores discussion JSON when the authoritative result file is missing', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-result-summary',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');
    const run = [...p2pRuns.values()].at(-1)!;
    run.status = 'completed';
    const origin = parseAuditMetadata(run);
    run.resultSummary = [
      'final result',
      '```json',
      JSON.stringify(auditPayload({ auto_deliver: origin }), null, 2),
      '```',
    ].join('\n');
    run.strictAuthoritativeResult = run.resultSummary;
    await writeFile(run.contextFilePath, 'participant example\n```json\n{}\n```\n', 'utf8');

    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('needs_human');
    expect(terminal?.projection.terminalReason).toBe('missing_authoritative_json');
  });

  it('uses an authoritative result file larger than the generic P2P summary tail', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-large-strict-result',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');
    const run = [...p2pRuns.values()].at(-1)!;
    run.status = 'completed';
    const origin = parseAuditMetadata(run);
    const largePayload = auditPayload({
      auto_deliver: origin,
      module_scores: OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS.map((module) => ({
        module,
        score: 9,
        max_score: 10,
        summary: `${module} ${'x'.repeat(700)}`,
      })),
    });
    const resultJson = JSON.stringify(largePayload, null, 2);
    expect(resultJson.length).toBeGreaterThan(2_000);
    run.strictAuthoritativeResult = null;
    run.resultSummary = resultJson.slice(-2_000);
    await writeFile(String(origin.authoritativeResultPath), resultJson, 'utf8');

    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('passed');
  });

  it('surfaces wrapper P2P failures instead of misreporting missing authoritative JSON', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-failed-p2p-valid-result-file',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');
    const p2pRun = [...p2pRuns.values()].at(-1)!;
    p2pRun.error = 'dispatch_failed: tmux send-keys failed: can\'t find pane: deck_demo_brain';
    await completeLatestAudit('failed');

    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('needs_human');
    expect(terminal?.projection.terminalReason).toBe('audit_p2p_failed');
    expect(terminal?.projection.evidence?.some((entry: { summary?: string }) => entry.summary?.includes('dispatch_failed'))).toBe(true);
    expect(transportSendMock.mock.calls.some((call) => String(call[0] ?? '').includes('Problem: missing_authoritative_json'))).toBe(false);
  });

  it('rejects invalid presets and zero-task changes before acquiring a run', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-invalid-preset',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'not-a-preset',
    }, serverLinkMock as never);
    let error = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ERROR);
    expect(error?.error).toBe('invalid_preset_id');

    serverLinkMock.send.mockClear();
    await makeChange('empty-tasks', '# no checkboxes\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-empty-tasks',
      sessionName: 'deck_demo_brain',
      changeName: 'empty-tasks',
      presetId: 'fast',
    }, serverLinkMock as never);
    error = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ERROR);
    expect(error?.error).toBe('tasks_missing_checkboxes');
  });

  it('does not advance on unrelated idle events and rejects invalid change slugs', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-bad-slug',
      sessionName: 'deck_demo_brain',
      changeName: '../demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);
    const error = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ERROR);
    expect(error?.error).toBe('invalid_change_name');
    serverLinkMock.send.mockClear();

    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-unmatched-idle',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);
    timelineEmitter.emit('deck_other_brain', 'session.state', { state: 'idle' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const advanced = serverLinkMock.send.mock.calls.some((call) =>
      call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && call[0]?.projection?.implementationPromptCount === 2,
    );
    expect(advanced).toBe(false);
  });

  it('rejects unsupported runtimes, missing artifacts, and symlink escapes', async () => {
    getSessionMock.mockImplementationOnce((name: string) => ({
      name,
      projectName: 'demo',
      projectDir,
      role: 'brain',
      agentType: 'codex-sdk',
      runtimeType: 'process',
      state: 'idle',
    }));
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-unsupported-runtime',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);
    let error = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ERROR);
    expect(error?.error).toBe('unsupported_runtime');

    serverLinkMock.send.mockClear();
    await mkdir(join(projectDir, 'openspec', 'changes', 'missing-artifacts'), { recursive: true });
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-missing-artifacts',
      sessionName: 'deck_demo_brain',
      changeName: 'missing-artifacts',
      presetId: 'fast',
    }, serverLinkMock as never);
    error = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ERROR);
    expect(error?.error).toBe('missing_required_artifacts');

    serverLinkMock.send.mockClear();
    const outsideRoot = join(projectDir, 'outside-change');
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(join(outsideRoot, 'proposal.md'), '# escape\n', 'utf8');
    await writeFile(join(outsideRoot, 'tasks.md'), '- [ ] outside\n', 'utf8');
    await symlink(outsideRoot, join(projectDir, 'openspec', 'changes', 'escape-change'), 'dir');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-symlink-escape',
      sessionName: 'deck_demo_brain',
      changeName: 'escape-change',
      presetId: 'fast',
    }, serverLinkMock as never);
    error = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ERROR);
    expect(error?.error).toBe('invalid_change_root');
    expect(getAutoDeliverP2pLock('deck_demo_brain')).toBeUndefined();
    expect(startP2pRunMock).not.toHaveBeenCalled();
  });

  it('rejects specs symlink escapes before launch lock acquisition', async () => {
    const changeRoot = join(projectDir, 'openspec', 'changes', 'specs-escape');
    const outsideSpecsRoot = join(projectDir, 'outside-specs');
    await mkdir(join(changeRoot), { recursive: true });
    await mkdir(join(outsideSpecsRoot, 'demo'), { recursive: true });
    await writeFile(join(changeRoot, 'proposal.md'), '# Proposal\n', 'utf8');
    await writeFile(join(changeRoot, 'tasks.md'), '- [ ] first\n', 'utf8');
    await writeFile(join(outsideSpecsRoot, 'demo', 'spec.md'), '## ADDED Requirements\n\n### Requirement: Escaped\n\n#### Scenario: Escaped\n- **WHEN** demo\n- **THEN** demo\n', 'utf8');
    await symlink(outsideSpecsRoot, join(changeRoot, 'specs'), 'dir');

    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-specs-symlink-escape',
      sessionName: 'deck_demo_brain',
      changeName: 'specs-escape',
      presetId: 'fast',
    }, serverLinkMock as never);

    const error = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ERROR);
    expect(error?.error).toBe('missing_spec_delta');
    expect(getAutoDeliverP2pLock('deck_demo_brain')).toBeUndefined();
    expect(startP2pRunMock).not.toHaveBeenCalled();
  });

  it('bounds implementation prompts and instructs agents not to commit, push, or stage', async () => {
    await writeFile(join(projectDir, 'package.json'), JSON.stringify({
      scripts: {
        test: 'vitest run',
        typecheck: 'tsc --noEmit',
        deploy: 'serverless deploy',
      },
    }), 'utf8');
    await writeFile(join(projectDir, 'pnpm-lock.yaml'), '', 'utf8');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-prompt-limit',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    expect(transportSendMock.mock.calls[0]?.[0]).toContain('Do not commit, push, or stage files.');
    expect(transportSendMock.mock.calls[0]?.[0]).toContain('Validation command candidates:');
    expect(transportSendMock.mock.calls[0]?.[0]).toContain('project-specific candidates only');
    expect(transportSendMock.mock.calls[0]?.[0]).toContain('Discovered safe validation command candidates from project manifests: pnpm typecheck; pnpm test');
    expect(transportSendMock.mock.calls[0]?.[0]).toContain('Unsafe validation commands were skipped: pnpm deploy');
    expect(transportSendMock.mock.calls[0]?.[0]).not.toContain('Recommended validation commands:');
    for (let expectedCount = 2; expectedCount <= 6; expectedCount += 1) {
      timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
      await waitForSend((msg) =>
        msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
        && msg.projection?.implementationPromptCount === expectedCount,
        1000,
      );
    }
    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });

    const terminal = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL
      && msg.projection?.terminalReason === 'implementation_prompt_limit_reached',
      2500,
    );
    expect(terminal?.projection.status).toBe('needs_human');
  });

  it('captures implementation-reported validation evidence before final audit', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-implementation-evidence',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    timelineEmitter.emit('deck_demo_brain', 'assistant.text', { text: 'Ran npm test: passed' });
    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });

    const projection = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_audit_repair',
    );
    expect(projection.projection.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'implementation_reported',
        summary: 'Ran npm test: passed',
      }),
    ]));
  });

  it('cancels the active Auto-owned P2P audit run when stopped', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-stop-audit',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    const ack = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ACK);
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'spec_audit_repair');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.STOP,
      requestId: 'req-stop-active-audit',
      sessionName: 'deck_demo_brain',
      runId: ack.projection.runId,
    }, serverLinkMock as never);

    expect(cancelP2pRunMock).toHaveBeenCalledWith('p2p-1', serverLinkMock, expect.objectContaining({
      source: 'openspec_auto_deliver_terminalize',
      reason: 'user_stopped',
      requestedBySession: 'deck_demo_brain',
    }));
    const terminal = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL);
    expect(terminal?.projection.status).toBe('stopped');
  });

  it('ignores late audit results after stop terminalization and releases the P2P lock', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-stop-late-audit',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    const ack = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ACK);
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'spec_audit_repair');
    expect(getAutoDeliverP2pLock('deck_demo_brain')).toMatchObject({ runId: ack.projection.runId });

    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.STOP,
      requestId: 'req-stop-before-late-audit',
      sessionName: 'deck_demo_brain',
      runId: ack.projection.runId,
    }, serverLinkMock as never);
    const stopAck = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.STOP_ACK && msg.requestId === 'req-stop-before-late-audit');
    expect(stopAck?.ok).toBe(true);
    expect(stopAck?.projection.status).toBe('stopped');
    expect(stopAck?.projection.generation).toBe(ack.projection.generation + 1);
    const stopTerminal = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL && msg.projection?.terminalReason === 'user_stopped');
    expect(stopTerminal?.projection.status).toBe('stopped');
    expect(stopTerminal?.projection.generation).toBe(ack.projection.generation + 1);
    expect(getAutoDeliverP2pLock('deck_demo_brain')).toBeUndefined();

    const terminalCountAfterStop = serverLinkMock.send.mock.calls.filter((call) =>
      call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL,
    ).length;
    const projectionCountAfterStop = serverLinkMock.send.mock.calls.filter((call) =>
      call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION,
    ).length;
    await completeLatestAudit('completed');
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(serverLinkMock.send.mock.calls.filter((call) => call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL)).toHaveLength(terminalCountAfterStop);
    expect(serverLinkMock.send.mock.calls.filter((call) => call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION)).toHaveLength(projectionCountAfterStop);
    expect(getAutoDeliverP2pLock('deck_demo_brain')).toBeUndefined();
  });

  it('ignores late implementation idle after stop and does not start audit-repair', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-stop-late-implementation',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    const ack = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ACK);
    await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_task_loop',
    );
    expect(startP2pRunMock).not.toHaveBeenCalled();

    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.STOP,
      requestId: 'req-stop-before-late-implementation',
      sessionName: 'deck_demo_brain',
      runId: ack.projection.runId,
    }, serverLinkMock as never);
    const stopAck = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.STOP_ACK && msg.requestId === 'req-stop-before-late-implementation');
    expect(stopAck?.projection.status).toBe('stopped');
    expect(stopAck?.projection.generation).toBe(ack.projection.generation + 1);
    expect(getAutoDeliverP2pLock('deck_demo_brain')).toBeUndefined();

    const terminalCountAfterStop = serverLinkMock.send.mock.calls.filter((call) =>
      call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL,
    ).length;
    const projectionCountAfterStop = serverLinkMock.send.mock.calls.filter((call) =>
      call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION,
    ).length;
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(startP2pRunMock).not.toHaveBeenCalled();
    expect(serverLinkMock.send.mock.calls.filter((call) => call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL)).toHaveLength(terminalCountAfterStop);
    expect(serverLinkMock.send.mock.calls.filter((call) => call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION)).toHaveLength(projectionCountAfterStop);
    expect(getAutoDeliverP2pLock('deck_demo_brain')).toBeUndefined();
  });

  it.each<[string, () => void, string]>([
    ['returns-false', () => cancelP2pRunMock.mockResolvedValueOnce(false), 'cancelP2pRun returned false'],
    ['rejects', () => cancelP2pRunMock.mockRejectedValueOnce(new Error('cancel transport unavailable')), 'cancelP2pRun rejected'],
  ])('records P2P cancel failure diagnostically when cancelP2pRun %s', async (_label, setupCancelFailure, expectedDiagnostic) => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: `req-stop-cancel-diagnostic-${_label}`,
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    const ack = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ACK);
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'spec_audit_repair');
    setupCancelFailure();
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.STOP,
      requestId: `req-stop-cancel-diagnostic-stop-${_label}`,
      sessionName: 'deck_demo_brain',
      runId: ack.projection.runId,
    }, serverLinkMock as never);

    const stopAck = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.STOP_ACK && msg.requestId === `req-stop-cancel-diagnostic-stop-${_label}`);
    expect(stopAck?.projection.status).toBe('stopped');
    expect(stopAck?.projection.terminalReason).toBe('user_stopped');

    const diagnosticProjection = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.status === 'stopped'
      && msg.projection?.terminalReason === 'user_stopped'
      && msg.projection?.evidence?.some((entry: { summary?: string }) => entry.summary?.includes(expectedDiagnostic)),
      2500,
    );
    expect(diagnosticProjection.projection.generation).toBe(ack.projection.generation + 1);
    expect(diagnosticProjection.projection.terminalReason).toBe('user_stopped');
    expect(serverLinkMock.send.mock.calls.filter((call) => call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL)).toHaveLength(1);
  });

  it('denies non-participant sibling stop and preserves terminal status on late stop', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-stop-auth',
      sessionName: 'deck_sub_worker',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);
    const ack = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ACK);
    const runId = ack.projection.runId;

    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.STOP,
      requestId: 'req-stop-sibling',
      sessionName: 'deck_sub_sibling',
      runId,
    }, serverLinkMock as never);
    const forbidden = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.STOP_ACK && msg.requestId === 'req-stop-sibling');
    expect(forbidden?.ok).toBe(false);
    expect(forbidden?.error).toBe('forbidden');

    timelineEmitter.emit('deck_sub_worker', 'session.state', { state: 'idle' });
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');
    await completeLatestAudit('completed');
    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL && msg.projection?.status === 'passed', 2500);
    expect(terminal?.projection.terminalReason).toBe('final_audit_passed');

    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.STOP,
      requestId: 'req-stop-terminal',
      sessionName: 'deck_sub_worker',
      runId,
    }, serverLinkMock as never);
    const lateStop = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.STOP_ACK && msg.requestId === 'req-stop-terminal');
    expect(lateStop?.projection.status).toBe('passed');
    expect(lateStop?.projection.terminalReason).toBe('final_audit_passed');
  });

  it('fails active runs closed and releases locks during daemon restart cleanup', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-restart-cleanup',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'spec_audit_repair');
    handleOpenSpecAutoDeliverDaemonRestartCleanup(serverLinkMock as never);

    const terminal = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL && msg.projection?.terminalReason === 'daemon_restart_cleared');
    expect(terminal?.projection.status).toBe('failed');
    expect(cancelP2pRunMock).toHaveBeenCalledWith('p2p-1', serverLinkMock, expect.objectContaining({
      source: 'openspec_auto_deliver_terminalize',
      reason: 'daemon_restart_cleared',
      requestedBySession: 'deck_demo_brain',
    }));

    serverLinkMock.send.mockClear();
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-after-restart-cleanup',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);
    const ack = serverLinkMock.send.mock.calls.map((call) => call[0]).find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ACK);
    expect(ack?.projection.status).toBe('proposed');
  });

  it('allows supplemental user input in the target implementation session during implementation', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-supplemental-input',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    serverLinkMock.send.mockClear();
    timelineEmitter.emit('deck_demo_brain', 'user.message', { text: 'manual prompt', commandId: 'manual-command-1' }, { source: 'daemon', confidence: 'high', eventId: 'manual' });

    expect(serverLinkMock.send.mock.calls.some((call) => call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL)).toBe(false);
  });

  it('does not treat daemon-internal target-session messages without commandId as out-of-band user input', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-oob-internal',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    serverLinkMock.send.mockClear();
    timelineEmitter.emit('deck_demo_brain', 'user.message', { text: 'internal p2p-style prompt' }, {
      source: 'daemon',
      confidence: 'high',
      eventId: 'p2p-internal-message',
    });

    expect(serverLinkMock.send.mock.calls.some((call) => call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL)).toBe(false);
  });
});
