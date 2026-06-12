import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  OPENSPEC_AUTO_DELIVER_MAX_IMPLEMENTATION_MARKER_REMINDERS,
  OPENSPEC_AUTO_DELIVER_MSG,
  OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS,
} from '../../shared/openspec-auto-deliver-constants.js';
import { formatOpenSpecAuditStandardTemplate, formatOpenSpecPromptTemplate } from '../../shared/openspec-prompt-templates.js';
import { isPostSummaryExecutionGateFailure } from '../../shared/p2p-execution-marker.js';

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

function implementationReminderCount(): number {
  return transportSendMock.mock.calls
    .filter((call) => String(call[0] ?? '').includes('OpenSpec Auto Deliver implementation is not complete yet'))
    .length;
}

async function waitForImplementationReminderCount(n: number, maxMs = 2500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (implementationReminderCount() >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected >= ${n} implementation reminders, saw ${implementationReminderCount()}`);
}

async function writeLatestImplementationMarker(overrides: Record<string, unknown> = {}): Promise<boolean> {
  const prompt = [...transportSendMock.mock.calls]
    .map((call) => String(call[0] ?? ''))
    .reverse()
    .find((text) => text.includes('Implementation completion marker (required):'));
  if (!prompt) return false;
  const markerPath = prompt.match(/write this exact JSON marker to: ([^\n]+)/)?.[1]?.trim();
  const markerBody = prompt.match(/Completed marker:\n```json\n([\s\S]*?)\n```/)?.[1];
  if (!markerPath || !markerBody) return false;
  const marker = { ...(JSON.parse(markerBody) as Record<string, unknown>), ...overrides };
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  return true;
}

async function emitDeckDemoIdle(): Promise<void> {
  await writeLatestImplementationMarker();
  timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
}

async function emitSessionIdle(sessionName: string): Promise<void> {
  await writeLatestImplementationMarker();
  timelineEmitter.emit(sessionName, 'session.state', { state: 'idle' });
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

function repairCompletion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'complete',
    previous_items_complete: true,
    completed_items: ['all previous repair items verified'],
    incomplete_items: [],
    blocked_items: [],
    summary: 'Previous repair checklist is complete.',
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
    authoritativeResultPath: lineValue('Authoritative result file') || origin.authoritativeResultPath,
    owningMainSessionName: lineValue('Owning main session') || origin.owningMainSessionName,
    executionSessionName: lineValue('Execution session'),
    generation: Number(lineValue('Generation') || origin.generation),
  };
}

function parseAutoDeliverMetadataBlock(text: string): Record<string, unknown> {
  const marker = 'The top-level auto_deliver object must exactly equal this metadata object:';
  const start = text.indexOf(marker);
  if (start < 0) throw new Error('Missing auto_deliver metadata block');
  const afterMarker = text.slice(start + marker.length);
  const end = afterMarker.indexOf('\n\nRequired top-level fields:');
  if (end < 0) throw new Error('Missing auto_deliver metadata block terminator');
  return JSON.parse(afterMarker.slice(0, end).trim()) as Record<string, unknown>;
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
  expect(text).toContain('Final acceptance audits must include repair_completion with fields');
  expect(text).toContain('evidence.source is informational only');
  expect(text).toContain('PASS must leave unchecked_tasks and required_changes empty');
}

function expectFinalAcceptanceScoringDiscipline(text: string): void {
  expect(text).toContain('Repair completion decision (required for this final acceptance audit):');
  expect(text).toContain('Include a top-level repair_completion object in the JSON.');
  expect(text).toContain('repair_completion.previous_items_complete must answer whether ALL previous required_changes');
  expect(text).toContain('Use status="complete" and previous_items_complete=true only when the prior repair checklist is complete');
  expect(text).toContain('Scoring discipline:');
  expect(text).toContain('Score from 10 downward based on current repaired evidence');
  expect(text).toContain('do not start from PASS or assume high scores because a repair prompt completed');
  expect(text).toContain('Treat the repair turn, checked tasks.md, and discussion summaries as claims to verify, not proof');
  expect(text).toContain('repair scorecard item');
  expect(text).toContain('repair task checklist item');
  // Baseline is a starting point, not a ceiling: a verified fix MUST raise the score.
  expect(text).toContain('Use the repair scorecard baseline as the STARTING point, not a ceiling');
  expect(text).toContain('you MUST raise that module above its baseline in proportion to what was actually resolved');
  expect(text).toContain('an unchanged (flat) score is WRONG');
  // Anti-gaming guards retained on the other side.
  expect(text).toContain('do not exceed the repair scorecard full-score conditions, and do not restore points for claims you could not verify');
  expect(text).toContain('Award 9 or 10 only when fresh post-repair evidence shows the relevant module is complete');
  expect(text).toContain('If any previous finding remains unresolved or only unverified, verdict must be REWORK');
  expect(text).toContain('Evidence that only restates the prompt, promises future work, or cites the Team discussion without inspecting repaired files is insufficient for PASS');
}

function expectTeamRepairScorecardLocation(text: string, discussionPath: string): void {
  expect(text).toContain('Team repair scorecard location:');
  expect(text).toContain(`- File: ${discussionPath}`);
  expect(text).toContain('- Heading to find: "repair scorecard".');
  expect(text).toContain('- You MUST locate the latest matching section before assigning module_scores.');
  expect(text).toContain('- Treat that section as the binding deduction/recovery table for module_scores.');
  expect(text).toContain('- If the heading is absent, state that in evidence, set verdict to REWORK, and cap every module score at 6.');
  expect(text).toContain('Team repair task checklist location:');
  expect(text).toContain(`- File: ${discussionPath}`);
  expect(text).toContain('- Heading to find: "repair task checklist".');
  expect(text).toContain('- You MUST locate the latest matching section and verify each checklist item against repaired files and validation evidence.');
  expect(text).toContain('- If the heading is absent, fall back to the latest final summary / Implementation Plan in the same discussion file');
  expect(text).toContain('Do not fail or cap scores solely because this optional heading is absent.');
}

function expectTeamRepairScorecardInstructions(text: string): void {
  expect(text).toContain('repair scorecard');
  expect(text).toContain('include the exact heading "repair scorecard"');
  expect(text).toContain('This is not the final authoritative module_scores JSON');
  expect(text).toContain('baseline score before repair, deduction reasons, concrete recovery conditions, and full-score conditions');
  expect(text).toContain('Phrase recovery conditions as evidence gates, not bonus points');
  expect(text).toContain('will use this scorecard as a checklist and may restore points only for conditions proven by post-repair evidence');
  expect(text).toContain('repair task checklist');
  expect(text).toContain('include the exact heading "repair task checklist"');
  expect(text).toContain('ordered executable repair plan');
  expect(text).toContain('will read this checklist and complete it item by item before final acceptance scoring');
}

/**
 * The discussion REQUEST must carry only the hop-level guidance: feed
 * per-module ingredients, and explicitly do NOT write a scorecard section —
 * the full scorecard format goes exclusively to the final-summary turn via
 * finalSummaryExtraInstruction. When the full instructions sat in the request
 * text, every hop wrote its own scorecard each round, corrupting the
 * acceptance audit's latest-scorecard lookup.
 */
function expectTeamScorecardHopGuidanceOnly(text: string): void {
  expect(text).toContain('so the final Team summary can assemble the repair scorecard');
  expect(text).toContain('Do NOT write a "repair scorecard" section in individual hop outputs');
  expect(text).not.toContain('include the exact heading "repair scorecard"');
  expect(text).not.toContain('baseline score before repair, deduction reasons, concrete recovery conditions, and full-score conditions');
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

async function completeLatestDiscussion(status = 'completed', summary = '# implementation audit discussion\n\nRepair the remaining gaps before final scoring.'): Promise<MockP2pRun> {
  const run = [...p2pRuns.values()].at(-1);
  if (!run) throw new Error('No mocked P2P run exists');
  run.status = status;
  run.resultSummary = summary;
  run.strictAuthoritativeResult = null;
  await writeFile(run.contextFilePath, summary, 'utf8');
  return run;
}

async function completeAcceptanceAuditFromPrompt(text: string, payloadOverrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const origin = parseAutoDeliverMetadataBlock(text);
  const resultJson = JSON.stringify(auditPayload({
    auto_deliver: origin,
    repair_completion: repairCompletion(),
    ...payloadOverrides,
  }), null, 2);
  await writeFile(String(origin.authoritativeResultPath), resultJson, 'utf8');
  return origin;
}

async function startFinalAcceptanceAuditPrompt(requestId: string): Promise<string> {
  await startFastImplementationAudit(requestId);
  await completeLatestDiscussion();
  await waitForTransportSend((text) =>
    text.includes('Audit findings to repair now:')
    && text.includes('Reason: implementation_audit_followup_repair'),
    2500,
  );
  await emitDeckDemoIdle();
  return waitForTransportSend((text) =>
    text.includes('OpenSpec Auto Deliver final implementation acceptance audit for @openspec/changes/demo-change'),
    2500,
  );
}

async function completeSpecAuditDiscussionToImplementation(): Promise<void> {
  await completeLatestDiscussion('completed', '# spec audit discussion\n\nRepair the OpenSpec artifacts before implementation.');
  await waitForTransportSend((text) =>
    text.includes('OpenSpec Auto Deliver spec-artifact repair context for @openspec/changes/demo-change'),
    2500,
  );
  await emitDeckDemoIdle();
  const specAcceptancePrompt = await waitForTransportSend((text) =>
    text.includes('OpenSpec Auto Deliver final specification acceptance audit for @openspec/changes/demo-change'),
    2500,
  );
  await completeAcceptanceAuditFromPrompt(specAcceptancePrompt);
  await emitDeckDemoIdle();
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
  await emitDeckDemoIdle();
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
    projectDir = await realpath(projectDir);
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

  it('passes the saved Team hop timeout through Auto Deliver Team/P2P audit launches', async () => {
    getSavedP2pConfigMock.mockResolvedValue({
      sessions: {
        deck_demo_brain: { enabled: true, mode: 'audit' },
        deck_sub_worker: { enabled: true, mode: 'review' },
        deck_sub_peer: { enabled: true, mode: 'plan' },
      },
      rounds: 1,
      hopTimeoutMinutes: 7,
    });

    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-hop-timeout',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    expect(startP2pRunMock).toHaveBeenCalledWith(expect.objectContaining({
      hopTimeoutMs: 420_000,
    }));
  });

  it('scopes spec Team audit discussions to artifact repair guidance before final scoring', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-spec-verdict-scope',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    const audit = [...p2pRuns.values()].at(-1)!;
    expect(audit.userText).toContain('Audit only the OpenSpec artifacts under this change: proposal.md, design.md, specs/**/spec.md, and tasks.md.');
    expect(audit.userText).toContain('Use the OpenSpec specification audit prompt above as the audit-and-repair standard; preserve concrete artifact repair instructions in the discussion output.');
    expect(audit.userText).toContain('Do not write authoritative JSON. Do not assign final module scores.');
    expect(audit.userText).toContain('The execution model will use this discussion file to repair the artifacts');
    expect(audit.userText).toContain('a separate single-model final specification acceptance audit will score the repaired state and write the authoritative JSON');
    expect(audit.userText).not.toContain('Spec-stage verdict scope:');
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
    await emitDeckDemoIdle();

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

  it('sends launch ack before collecting the implementation product baseline', async () => {
    await makeChange('demo-change', '- [ ] first\n');
    await initializeGitWithRemote();
    const binDir = await mkdtemp(join(tmpdir(), `imcodes-auto-deliver-git-${Date.now()}-`));
    extraTempDirs.push(binDir);
    const oldPath = process.env.PATH;
    const realGit = (await execFileAsync('which', ['git'])).stdout.toString().trim();
    await writeFile(join(binDir, 'git'), `#!/bin/bash
if [ "$3" = "status" ] && [ "$4" = "--porcelain=v1" ]; then
  sleep 1
fi
exec "${realGit}" "$@"
`, 'utf8');
    await chmod(join(binDir, 'git'), 0o755);
    process.env.PATH = `${binDir}:${oldPath ?? ''}`;
    try {
      const pending = handleOpenSpecAutoDeliverCommand({
        type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
        requestId: 'req-launch-ack-before-baseline',
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

      const ack = await waitForSend((msg) =>
        msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ACK
        && msg.requestId === 'req-launch-ack-before-baseline',
        300,
      );
      expect(ack.projection?.stage).toBe('proposed');
      await pending;
      expect(transportSendMock).toHaveBeenCalledWith(
        expect.stringContaining('OpenSpec Auto Deliver context for @openspec/changes/demo-change'),
        expect.stringContaining(':implementation:'),
      );
    } finally {
      process.env.PATH = oldPath;
    }
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
    await emitDeckDemoIdle();
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
    expect(getOpenSpecAutoDeliverTransitionTarget('spec_audit_repair', 'spec_audit_rework')).toBe('spec_audit_repair');
    expect(getOpenSpecAutoDeliverTransitionTarget('spec_audit_repair', 'spec_audit_blocked')).toBe('needs_human');
    expect(getOpenSpecAutoDeliverTransitionTarget('implementation_task_loop', 'implementation_idle_incomplete')).toBe('implementation_task_loop');
    expect(getOpenSpecAutoDeliverTransitionTarget('implementation_task_loop', 'implementation_idle_all_checked')).toBe('implementation_audit_repair');
    expect(getOpenSpecAutoDeliverTransitionTarget('implementation_audit_repair', 'implementation_prompt_dispatched')).toBe('implementation_task_loop');
    expect(getOpenSpecAutoDeliverTransitionTarget('implementation_audit_repair', 'implementation_audit_pass')).toBe('passed');
    expect(getOpenSpecAutoDeliverTransitionTarget('implementation_audit_repair', 'implementation_audit_rework')).toBe('implementation_audit_repair');
    expect(getOpenSpecAutoDeliverTransitionTarget('implementation_audit_repair', 'implementation_audit_blocked')).toBe('needs_human');
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
    expect(stopAck?.projection.canContinue).toBe(true);
  });

  it('continues a stopped audit run from its checkpoint', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-continue-stopped',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    const activeAudit = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'spec_audit_repair'
      && msg.projection?.activeP2pRunId === 'p2p-1',
      2500,
    );
    const runId = activeAudit.projection.runId;

    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.STOP,
      requestId: 'stop-continue-1',
      sessionName: 'deck_demo_brain',
      runId,
    }, serverLinkMock as never);
    const stopAck = serverLinkMock.send.mock.calls
      .map((call) => call[0])
      .find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.STOP_ACK && msg.requestId === 'stop-continue-1');
    expect(stopAck?.projection.status).toBe('stopped');
    expect(stopAck?.projection.resumeStage).toBe('spec_audit_repair');
    expect(stopAck?.projection.canContinue).toBe(true);

    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.CONTINUE,
      requestId: 'continue-1',
      sessionName: 'deck_demo_brain',
      runId,
    }, serverLinkMock as never);

    const continueAck = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.CONTINUE_ACK
      && msg.requestId === 'continue-1',
      2500,
    );
    expect(continueAck.ok).toBe(true);
    expect(continueAck.projection.status).toBe('spec_audit_repair');
    expect(continueAck.projection.canStop).toBe(true);
    expect(continueAck.projection.canContinue).toBe(false);

    await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'spec_audit_repair'
      && msg.projection?.activeP2pRunId === 'p2p-2',
      2500,
    );
    expect([...p2pRuns.values()]).toHaveLength(2);
  });

  it('keeps one implementation prompt active until tasks.md is fully checked', async () => {
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
    expect(firstImplementationPrompt).toContain(`Project root: ${projectDir}`);
    expect(firstImplementationPrompt).toContain(`Change root: ${join(projectDir, 'openspec', 'changes', 'demo-change')}`);
    expect(firstImplementationPrompt).toContain('Before inspecting, editing, validating, or committing anything, work from the project root above.');
    expect(firstImplementationPrompt).toContain('Remaining tasks:');

    await emitDeckDemoIdle();
    const reminderPrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver implementation is not complete yet for @openspec/changes/demo-change.')
      && text.includes('Reason: implementation_tasks_still_unchecked'),
    );
    expect(reminderPrompt).toContain('Drive the implementation of @openspec/changes/demo-change aggressively.');
    expect(reminderPrompt).toContain('dispatch sub-agents with clear ownership');
    expect(serverLinkMock.send.mock.calls.some((call) =>
      call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && (call[0]?.projection as { implementationPromptCount?: number } | undefined)?.implementationPromptCount === 2,
    )).toBe(false);

    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await emitDeckDemoIdle();

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
      finalSummaryExtraInstruction?: string;
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
    expect(implementationLaunch.userText).toContain(`Project root: ${projectDir}`);
    expect(implementationLaunch.userText).toContain(`Resolved change root identity: ${join(projectDir, 'openspec', 'changes', 'demo-change')}`);
    expect(implementationLaunch.userText).toContain('All referenced relative paths are relative to the project root above');
    // Audit-only discussion embeds the audit STANDARD without the canonical
    // template's "then fix the code … Do not stop at a report" repair
    // directive, which contradicted the "do not repair in this turn" contract.
    expect(implementationLaunch.userText).toContain(formatOpenSpecAuditStandardTemplate('audit_implementation', '@openspec/changes/demo-change'));
    expect(implementationLaunch.userText).not.toContain('then fix the code');
    expect(implementationLaunch.userText).not.toContain('Do not stop at a report');
    expect(implementationLaunch.userText).toContain('Use the OpenSpec implementation audit prompt above as the audit-and-repair standard; preserve concrete repair instructions in the discussion output.');
    expect(implementationLaunch.userText).toContain('Do not write authoritative JSON. Do not assign final module scores.');
    expect(implementationLaunch.userText).toContain('The execution model will use this discussion file to repair code/tests/tasks');
    expect(implementationLaunch.userText).toContain('Treat high apparent quality as still requiring a repair pass');
    expectTeamScorecardHopGuidanceOnly(implementationLaunch.userText ?? '');
    // Implementation-stage scorecard keeps code semantics — the spec-stage
    // artifact reinterpretation must NOT leak into this stage.
    expectTeamRepairScorecardInstructions(implementationLaunch.finalSummaryExtraInstruction ?? '');
    expect(implementationLaunch.finalSummaryExtraInstruction ?? '').not.toContain('Spec-stage module semantics');

    const discussion = await completeLatestDiscussion();
    const repairPrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver implementation repair for @openspec/changes/demo-change')
      && text.includes(`Audit discussion file: ${discussion.contextFilePath}`)
      && text.includes('Reason: implementation_audit_followup_repair')
      && text.includes('This repair pass is required even when the implementation audit passed'),
      2500,
    );
    expect(repairPrompt).toContain('Drive the implementation of @openspec/changes/demo-change aggressively.');
    expect(repairPrompt).toContain('dispatch sub-agents with clear ownership');
    expect(repairPrompt).toContain('Do not write another audit report. Edit the product code, tests, and tasks.md now');
    expect(repairPrompt).not.toContain(formatOpenSpecPromptTemplate('audit_implementation', '@openspec/changes/demo-change'));
    expect(repairPrompt).not.toContain('Changed files:');
    expect(repairPrompt).not.toContain('Diff stat:');
    await emitDeckDemoIdle();
    const acceptancePrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver final implementation acceptance audit for @openspec/changes/demo-change')
      && text.includes(`Previous audit discussion file: ${discussion.contextFilePath}`)
      && !text.includes('quick verification'),
      2500,
    );
    expect(acceptancePrompt).not.toContain('Changed files:');
    expect(acceptancePrompt).not.toContain('Diff stat:');
    expectFinalAcceptanceScoringDiscipline(acceptancePrompt);
    expect(acceptancePrompt).toContain('For implementation-stage scoring, tests means actual test coverage plus executed validation');
    expect(acceptancePrompt).toContain('cap implementation and risk at 7 and cap tests at 6');
    await completeAcceptanceAuditFromPrompt(acceptancePrompt);
    await emitDeckDemoIdle();
    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 8000);
    expect(terminal?.projection.status).toBe('passed');
    expect(terminal?.projection.terminalReason).toBe('final_audit_passed');
  });

  it('keeps implementation active when idle arrives without a completion marker', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-missing-implementation-marker',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    const implementationPrompt = await waitForTransportSend((text) =>
      text.includes('Implementation completion marker (required):')
      && text.includes('write this exact JSON marker to:'),
      2500,
    );
    expect(implementationPrompt).toContain('After you have completed implementation, tasks.md updates, and reasonable validation');

    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });

    const reminderPrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver implementation is not complete yet for @openspec/changes/demo-change.')
      && text.includes('Reason: implementation_marker_missing')
      && text.includes('finish the required code, test, and tasks.md work')
      && text.includes('Write the completed marker only after the implementation is genuinely finished and validated'),
      2500,
    );
    expect(reminderPrompt).toContain('Drive the implementation of @openspec/changes/demo-change aggressively.');
    expect(reminderPrompt).toContain('dispatch sub-agents with clear ownership');
    expect(reminderPrompt).toContain('Run the appropriate validation for the files you touched.');
    expect(startP2pRunMock).not.toHaveBeenCalled();

    expect(await writeLatestImplementationMarker()).toBe(true);
    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });

    await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_audit_repair',
      2500,
    );
    expect(startP2pRunMock).toHaveBeenCalledTimes(1);
  });

  it('continues implementation when the agent reports an incomplete failed marker', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-failed-implementation-marker-continues',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    await waitForTransportSend((text) =>
      text.includes('Implementation completion marker (required):')
      && text.includes('write this exact JSON marker to:'),
      2500,
    );

    expect(await writeLatestImplementationMarker({
      status: 'failed',
      error: 'remaining repair checklist gaps',
    })).toBe(true);
    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });

    const reminderPrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver implementation is not complete yet for @openspec/changes/demo-change.')
      && text.includes('Reason: implementation_marker_failed:remaining repair checklist gaps')
      && text.includes('incomplete checklist work means continue implementing, not stop'),
      2500,
    );
    expect(reminderPrompt).toContain('finish the required code, test, and tasks.md work');
    expect(serverLinkMock.send.mock.calls.some((call) =>
      call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL
      && call[0]?.projection?.terminalReason === 'implementation_marker_failed:remaining repair checklist gaps',
    )).toBe(false);

    expect(await writeLatestImplementationMarker()).toBe(true);
    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });

    await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_audit_repair',
      2500,
    );
    expect(startP2pRunMock).toHaveBeenCalledTimes(1);
  });

  it('escalates to needs_human after too many idle reminders without a completion marker', async () => {
    // Regression: a session that kept going idle without writing the completion
    // marker re-sent the "implementation is not complete yet" reminder forever
    // (only the hours-long elapsed limit stopped it). The reminder loop is now
    // bounded.
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-implementation-marker-reminder-cap',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    await waitForTransportSend((text) =>
      text.includes('Implementation completion marker (required):')
      && text.includes('write this exact JSON marker to:'),
      2500,
    );

    // Each idle without a marker (and without task progress) sends one reminder,
    // up to the cap; the next idle escalates instead of re-prompting forever.
    for (let i = 1; i <= OPENSPEC_AUTO_DELIVER_MAX_IMPLEMENTATION_MARKER_REMINDERS; i++) {
      timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
      await waitForImplementationReminderCount(i);
    }

    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('needs_human');
    expect(String((terminal?.projection as { terminalReason?: string })?.terminalReason ?? ''))
      .toContain('implementation_marker_reminders_exhausted');
    // No extra reminder beyond the cap was sent.
    expect(implementationReminderCount()).toBe(OPENSPEC_AUTO_DELIVER_MAX_IMPLEMENTATION_MARKER_REMINDERS);
  });

  it('throttles bursty idle reminders to the minimum interval', async () => {
    // Regression: reminders used to fire on every idle. A burst of idles within
    // the cooldown window must collapse to a single (deferred) reminder.
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-implementation-marker-reminder-throttle',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    await waitForTransportSend((text) =>
      text.includes('Implementation completion marker (required):')
      && text.includes('write this exact JSON marker to:'),
      2500,
    );

    // First idle -> first reminder (no prior reminder, nothing to throttle).
    timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    await waitForImplementationReminderCount(1);

    // Burst of idles inside the cooldown -> collapses to one deferred reminder.
    for (let k = 0; k < 5; k++) {
      timelineEmitter.emit('deck_demo_brain', 'session.state', { state: 'idle' });
    }
    // Settle well under the test min-interval (40ms): the deferred reminder has
    // not fired yet, so the burst produced no extra reminder.
    await new Promise((resolve) => setTimeout(resolve, 12));
    expect(implementationReminderCount()).toBe(1);

    // Exactly one throttled reminder is delivered after the interval (not five).
    await waitForImplementationReminderCount(2);
    expect(implementationReminderCount()).toBe(2);
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
    await emitDeckDemoIdle();
    await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_audit_repair',
      2500,
    );

    await completeLatestDiscussion();
    await waitForTransportSend((text) =>
      text.includes('Audit findings to repair now:')
      && text.includes('Reason: implementation_audit_followup_repair'),
      2500,
    );
    await emitDeckDemoIdle();
    const acceptancePrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver final implementation acceptance audit for @openspec/changes/demo-change'),
      2500,
    );
    await completeAcceptanceAuditFromPrompt(acceptancePrompt, {
      repairs_applied: [{ files: ['src/feature.ts'], reason: 'Implemented the product change.' }],
    });
    await emitDeckDemoIdle();
    const prompt = await waitForTransportSend((text) => text === 'commit&push', 2500);
    expect(prompt).toBe('commit&push');
    const commitMessage = 'Implement delivered feature';
    await git(['add', '--', 'src/feature.ts']);
    await git(['commit', '-m', commitMessage]);
    await git(['push']);
    await emitDeckDemoIdle();
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
    const specDiscussion = await completeLatestDiscussion('completed', '# spec audit discussion\n\nRepair the OpenSpec artifacts before final scoring.');
    const specRepairPrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver spec-artifact repair context for @openspec/changes/demo-change')
      && text.includes(`Spec audit discussion file: ${specDiscussion.contextFilePath}`),
      2500,
    );
    expect(specRepairPrompt).toContain(formatOpenSpecPromptTemplate('audit_spec', '@openspec/changes/demo-change'));
    await emitDeckDemoIdle();
    const specAcceptancePrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver final specification acceptance audit for @openspec/changes/demo-change'),
      2500,
    );
    await completeAcceptanceAuditFromPrompt(specAcceptancePrompt);
    await emitDeckDemoIdle();
    const implementationPromptProjection = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && (msg.projection as { stage?: string; implementationPromptCount?: number }).stage === 'implementation_task_loop'
      && (msg.projection as { implementationPromptCount?: number }).implementationPromptCount === 1,
      2500,
    );
    expect(implementationPromptProjection.projection.specAuditRound).toEqual({ current: 1, total: 1 });

    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await emitDeckDemoIdle();
    const implementationAuditProjection = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');
    expect(implementationAuditProjection.projection.implementationAuditRound).toEqual({ current: 0, total: 2 });
    const discussion = await completeLatestDiscussion();
    const repairPrompt = await waitForTransportSend((text) =>
      text.includes('Audit findings to repair now:')
      && text.includes(`Audit discussion file: ${discussion.contextFilePath}`)
      && text.includes('Reason: implementation_audit_followup_repair'),
      2500,
    );
    expect(repairPrompt).toContain('Drive the implementation of @openspec/changes/demo-change aggressively.');
    expect(repairPrompt).toContain('dispatch sub-agents with clear ownership');
    expect(repairPrompt).toContain('OpenSpec Auto Deliver implementation repair for @openspec/changes/demo-change');
    expect(repairPrompt).not.toContain(formatOpenSpecPromptTemplate('audit_implementation', '@openspec/changes/demo-change'));
    expect([...p2pRuns.values()]).toHaveLength(2);
    await emitDeckDemoIdle();
    const acceptancePrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver final implementation acceptance audit for @openspec/changes/demo-change'),
      2500,
    );
    await completeAcceptanceAuditFromPrompt(acceptancePrompt);
    await emitDeckDemoIdle();

    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('passed');
    expect(terminal?.projection.moduleScores).toHaveLength(OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS.length);
    expect(terminal?.projection.auditBeforeRepair).toBeUndefined();
    expect(terminal?.projection.finalAfterRepair).toMatchObject({
      phase: 'final_after_repair',
      stage: 'implementation_audit_repair',
      verdict: 'PASS',
      roundIndex: 1,
    });
    expect(terminal?.projection.finalAfterRepair?.moduleScores).toHaveLength(OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS.length);
    expect(terminal?.projection.implementationAuditRound).toEqual({ current: 1, total: 2 });
    expect(terminal?.projection.auditResults).toHaveLength(2);
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
      finalSummaryExtraInstruction?: string;
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
    expect(specLaunch.userText).toContain(`Project root: ${projectDir}`);
    expect(specLaunch.userText).toContain(`Resolved change root identity: ${join(projectDir, 'openspec', 'changes', 'demo-change')}`);
    expect(specLaunch.userText).toContain('All referenced relative paths are relative to the project root above');
    expect(specLaunch.userText).toContain('Perform a strict specification audit for @openspec/changes/demo-change.');
    // The repair directive must NOT leak into the audit-only discussion turn —
    // it told the team to edit artifacts in a turn whose contract is review-only.
    expect(specLaunch.userText).not.toContain('then directly update the change artifacts');
    expect(specLaunch.userText).not.toContain('Do not stop at review notes');
    expect(specLaunch.userText).toContain('Use the OpenSpec specification audit prompt above as the audit-and-repair standard; preserve concrete artifact repair instructions in the discussion output.');
    expect(specLaunch.userText).toContain('Do not write authoritative JSON. Do not assign final module scores.');
    expect(specLaunch.userText).toContain('The execution model will use this discussion file to repair the artifacts');
    expectTeamScorecardHopGuidanceOnly(specLaunch.userText ?? '');
    // With the post-summary execution gate skipped (no full request restatement
    // on the final summary turn), the scorecard output contract must reach the
    // final summary via finalSummaryExtraInstruction — the acceptance audit
    // hard-depends on the "repair scorecard" heading being present.
    expectTeamRepairScorecardInstructions(specLaunch.finalSummaryExtraInstruction ?? '');
    // Spec-stage semantics: without these, teams gate implementation/tests/risk
    // recovery on product code that this stage never produces → modules parked
    // at baseline forever → spec stage loops on the <6 quality gate.
    expect(specLaunch.finalSummaryExtraInstruction ?? '').toContain('Spec-stage module semantics');
    expect(specLaunch.finalSummaryExtraInstruction ?? '').toContain('MUST NOT be gated on product code or product tests');
    const projection = serverLinkMock.send.mock.calls
      .map((call) => call[0])
      .find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'spec_audit_repair');
    expect(projection?.projection.activeP2pRunId).toBe('p2p-1');
  });

  it('builds Team audit prompts from canonical OpenSpec templates and final acceptance prompts with authoritative metadata', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-audit-prompt-metadata',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    const reference = '@openspec/changes/demo-change';
    const specRun = [...p2pRuns.values()].at(-1)!;
    const specOrigin = specRun.launchOrigin as { autoDeliver?: Record<string, unknown> };
    const specPath = String(specOrigin.autoDeliver?.authoritativeResultPath);
    expect(specPath).toBeTruthy();
    expect(specRun.userText).toContain(formatOpenSpecAuditStandardTemplate('audit_spec', reference));
    expect(specRun.userText).not.toContain('then directly update the change artifacts');
    expect(specRun.userText).toContain('Use the OpenSpec specification audit prompt above as the audit-and-repair standard; preserve concrete artifact repair instructions in the discussion output.');
    expect(specRun.userText).toContain('Do not write authoritative JSON. Do not assign final module scores.');
    expect(specRun.userText).toContain('The execution model will use this discussion file to repair the artifacts');
    expectTeamScorecardHopGuidanceOnly(specRun.userText ?? '');
    expect(specRun.userText).not.toContain('Authoritative result file:');
    expect(specRun.userText).not.toContain('Required top-level fields:');
    expect(specOrigin.autoDeliver?.authoritativeResultPath).toBe(specPath);
    expectAuditPromptWithoutVerdictSkeleton(specRun.userText ?? '');

    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await completeLatestDiscussion('completed', '# spec audit discussion\n\nRepair artifacts before final scoring.');
    await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver spec-artifact repair context for @openspec/changes/demo-change'),
      2500,
    );
    await emitDeckDemoIdle();
    const specAcceptancePrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver final specification acceptance audit for @openspec/changes/demo-change'),
      2500,
    );
    expect(specAcceptancePrompt).toContain(`Authoritative result file:`);
    expect(specAcceptancePrompt).toContain('Required top-level fields:');
    // The acceptance audit MUST write to a path distinct from the team
    // discussion's authoritative file at the same (stage, round) — otherwise it
    // re-stamps the discussion's stale scores and clobbers the team scorecard.
    const specAcceptancePath = (specAcceptancePrompt.split(/\r?\n/)
      .find((line) => line.startsWith('Authoritative result file:')) ?? '')
      .replace('Authoritative result file:', '').trim();
    expect(specAcceptancePath).toBeTruthy();
    expect(specAcceptancePath).not.toBe(specPath);
    expect(specAcceptancePath).toContain('.acceptance.');
    expectAuthoritativeResultSchemaHints(specAcceptancePrompt);
    expectFinalAcceptanceScoringDiscipline(specAcceptancePrompt);
    expectTeamRepairScorecardLocation(specAcceptancePrompt, specRun.contextFilePath);
    expect(specAcceptancePrompt).toContain('For spec-stage scoring, tests means testability of requirements, scenarios, and acceptance criteria');
    expect(specAcceptancePrompt).toContain('cap spec, tasks, tests, and risk at 7');
    // Spec-stage module semantics + the out-of-stage precedence rule: a team
    // scorecard that gates implementation/tests/risk on product code at spec
    // stage must not park those modules at the baseline forever.
    expect(specAcceptancePrompt).toContain('Spec-stage module semantics: implementation = implementation-readiness of the artifacts');
    expect(specAcceptancePrompt).toContain('that condition is OUT OF STAGE');
    await completeAcceptanceAuditFromPrompt(specAcceptancePrompt);
    await emitDeckDemoIdle();
    await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_task_loop',
      2500,
    );
    await emitDeckDemoIdle();
    await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_audit_repair',
      2500,
    );

    const implementationRun = [...p2pRuns.values()].at(-1)!;
    const implementationOrigin = implementationRun.launchOrigin as { autoDeliver?: Record<string, unknown> };
    expect(implementationRun.userText).toContain('OpenSpec Auto Deliver implementation audit discussion');
    expect(implementationRun.userText).toContain(formatOpenSpecAuditStandardTemplate('audit_implementation', reference));
    expect(implementationRun.userText).not.toContain('then fix the code');
    expect(implementationRun.userText).toContain('Use the OpenSpec implementation audit prompt above as the audit-and-repair standard; preserve concrete repair instructions in the discussion output.');
    expect(implementationRun.userText).toContain('Do not write authoritative JSON. Do not assign final module scores.');
    expect(implementationRun.userText).toContain('The execution model will use this discussion file to repair code/tests/tasks');
    expectTeamScorecardHopGuidanceOnly(implementationRun.userText ?? '');
    expect(implementationRun.userText).not.toContain('Authoritative result file:');
    expect(implementationRun.userText).not.toContain('Required top-level fields:');
    expect(implementationOrigin.autoDeliver?.stage).toBe('implementation_audit_repair');
    expect(implementationOrigin.autoDeliver?.authoritativeResultPath).toBeTruthy();
    expectAuditPromptWithoutVerdictSkeleton(implementationRun.userText ?? '');

    await completeLatestDiscussion('completed', '# implementation audit discussion\n\nRepair implementation before final scoring.');
    await waitForTransportSend((text) =>
      text.includes('Audit findings to repair now:')
      && text.includes('Reason: implementation_audit_followup_repair'),
      2500,
    );
    await emitDeckDemoIdle();
    const implementationAcceptancePrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver final implementation acceptance audit for @openspec/changes/demo-change'),
      2500,
    );
    expectFinalAcceptanceScoringDiscipline(implementationAcceptancePrompt);
    expectTeamRepairScorecardLocation(implementationAcceptancePrompt, implementationRun.contextFilePath);
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

  it('feeds final audit PASS safety failures back into implementation repair', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-final-gate',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    await emitDeckDemoIdle();
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');
    await completeLatestDiscussion('completed', '# implementation audit discussion\n\nCheck task truthfulness before final acceptance.');

    await waitForTransportSend((text) =>
      text.includes('Audit findings to repair now:')
      && text.includes('Reason: implementation_audit_followup_repair'),
      2500,
    );
    await emitDeckDemoIdle();
    const failingAcceptancePrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver final implementation acceptance audit for @openspec/changes/demo-change'),
      2500,
    );
    await makeChange('demo-change', '- [ ] first\n- [x] second\n');
    await completeAcceptanceAuditFromPrompt(failingAcceptancePrompt);
    await emitDeckDemoIdle();

    const repairPrompt = await waitForTransportSend((text) =>
      text.includes('Audit findings to repair now:')
      && text.includes('Reason: audit_pass_with_unchecked_tasks')
      && text.includes('Do not write another audit report. Edit the product code, tests, and tasks.md now'),
      2500,
    );
    expect(repairPrompt).toContain('Previous implementation audit verdict: PASS');
    const gate = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && String(msg.projection?.lastMessage ?? '').includes('audit_pass_with_unchecked_tasks'),
      2500,
    );
    expect(gate.projection.status).toBe('implementation_task_loop');
    expect(gate.projection.implementationPromptCount).toBe(3);
    expect(gate.projection.implementationAuditRound).toEqual({ current: 1, total: 1 });

    expect([...p2pRuns.values()]).toHaveLength(1);
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await emitDeckDemoIdle();

    const acceptancePrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver final implementation acceptance audit for @openspec/changes/demo-change')
      && text.includes('Previous audit verdict: PASS')
      && text.includes('final implementation acceptance audit')
      && !text.includes('quick verification'),
      2500,
    );
    expect([...p2pRuns.values()]).toHaveLength(1);
    await completeAcceptanceAuditFromPrompt(acceptancePrompt);
    await emitDeckDemoIdle();

    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('passed');
    expect(terminal?.projection.finalAfterRepair).toMatchObject({
      phase: 'final_after_repair',
      verdict: 'PASS',
      roundIndex: 1,
    });
  });

  it('keeps spec audit REWORK in audit repair instead of advancing to implementation', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-spec-rework',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'spec_audit_repair');
    await completeLatestDiscussion('completed', '# spec audit discussion\n\nClarify acceptance criteria before final scoring.');
    await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver spec-artifact repair context for @openspec/changes/demo-change'),
      2500,
    );
    await emitDeckDemoIdle();
    const specAcceptancePrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver final specification acceptance audit for @openspec/changes/demo-change'),
      2500,
    );
    await completeAcceptanceAuditFromPrompt(specAcceptancePrompt, {
      verdict: 'REWORK',
      required_changes: ['clarify acceptance criteria'],
      repair_completion: repairCompletion({
        status: 'incomplete',
        previous_items_complete: false,
        completed_items: [],
        incomplete_items: ['clarify acceptance criteria'],
        summary: 'The previous spec repair checklist is still incomplete.',
      }),
    });
    await emitDeckDemoIdle();

    const repairPrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver spec-artifact repair context for @openspec/changes/demo-change')
      && text.includes('Reason: spec_audit_rework_requires_repair')
      && text.includes('clarify acceptance criteria'),
      2500,
    );
    expect(repairPrompt).toContain('Must-fix items flagged by the previous spec audit');
    const gate = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'spec_audit_repair'
      && String(msg.projection?.lastMessage ?? '').includes('spec_audit_rework_requires_repair'),
      2500,
    );
    expect(gate.projection.latestVerdict).toBe('REWORK');
    expect(gate.projection.moduleScores).toHaveLength(OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS.length);
    expect(gate.projection.auditResults).toHaveLength(1);
    expect(gate.projection.auditResults?.[0]?.requiredChanges).toEqual(['clarify acceptance criteria']);
    expect(gate.projection.specAuditRound).toEqual({ current: 1, total: 1 });
    expect([...p2pRuns.values()]).toHaveLength(1);
    expect(transportSendMock.mock.calls.some((call) =>
      String(call[0] ?? '').includes('Drive the implementation of @openspec/changes/demo-change aggressively.'),
    )).toBe(false);
  });

  it('inlines the previous spec acceptance audit required_changes into the next spec repair prompt', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-spec-repair-requirements',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'spec_audit_repair');
    await completeLatestDiscussion('completed', '# spec audit discussion\n\nClarify acceptance criteria before final scoring.');
    // The first repair prompt has no prior acceptance audit result yet → no must-fix list.
    const firstRepairPrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver spec-artifact repair context for @openspec/changes/demo-change'),
      2500,
    );
    expect(firstRepairPrompt).not.toContain('Must-fix items flagged by the previous spec audit');
    expect(firstRepairPrompt).toContain('Locate the latest "repair task checklist" section and complete it item by item');
    expect(firstRepairPrompt).toContain('if that heading is absent, use the latest final summary / Implementation Plan');
    await emitDeckDemoIdle();
    const specAcceptancePrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver final specification acceptance audit for @openspec/changes/demo-change'),
      2500,
    );
    const flaggedChange = 'design.md:281 — remove the BigInt-vs-cap either/or and the owner-decision marker';
    await completeAcceptanceAuditFromPrompt(specAcceptancePrompt, {
      verdict: 'REWORK',
      required_changes: [flaggedChange],
      repair_completion: repairCompletion({
        status: 'incomplete',
        previous_items_complete: false,
        completed_items: [],
        incomplete_items: [flaggedChange],
        summary: 'The flagged acceptance repair item is still incomplete.',
      }),
    });
    await emitDeckDemoIdle();

    // The acceptance audit's required_changes go straight back into the next
    // spec repair prompt; they do not consume or inflate another Team audit round.
    await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'spec_audit_repair'
      && String(msg.projection?.lastMessage ?? '').includes('spec_audit_rework_requires_repair'),
      2500,
    );
    const secondRepairPrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver spec-artifact repair context for @openspec/changes/demo-change')
      && text.includes('Must-fix items flagged by the previous spec audit'),
      2500,
    );
    expect(secondRepairPrompt).toContain(`- ${flaggedChange}`);
    expect(secondRepairPrompt).toContain('Locate the latest "repair task checklist" section and complete it item by item');
    expect(secondRepairPrompt).toContain('if that heading is absent, use the latest final summary / Implementation Plan');
    expect([...p2pRuns.values()]).toHaveLength(1);
  });

  it('starts another Team audit only after final acceptance says previous spec repairs are complete but still insufficient', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-spec-rework-complete-new-round',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'spec_audit_repair');
    await completeLatestDiscussion('completed', '# spec audit discussion\n\nRepair the artifact checklist before final scoring.');
    await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver spec-artifact repair context for @openspec/changes/demo-change'),
      2500,
    );
    await emitDeckDemoIdle();
    const specAcceptancePrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver final specification acceptance audit for @openspec/changes/demo-change'),
      2500,
    );
    await completeAcceptanceAuditFromPrompt(specAcceptancePrompt, {
      verdict: 'REWORK',
      required_changes: ['new cross-spec ambiguity remains'],
      repair_completion: repairCompletion({
        completed_items: ['previous artifact checklist completed'],
        summary: 'Previous repair checklist is complete; a newly found ambiguity remains.',
      }),
    });
    await emitDeckDemoIdle();

    const start = Date.now();
    while (Date.now() - start < 2500 && [...p2pRuns.values()].length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect([...p2pRuns.values()]).toHaveLength(2);
    const projection = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'spec_audit_repair'
      && msg.projection?.specAuditRepairRound === 2,
      2500,
    );
    expect(projection.projection.specAuditRepairRound).toBe(2);
    expect(projection.projection.specAuditRound).toEqual({ current: 1, total: 2 });
    expect(transportSendMock.mock.calls.some((call) =>
      String(call[0] ?? '').includes('Reason: spec_audit_rework_requires_repair'),
    )).toBe(false);
  });

  it('does not start another Team audit after final implementation acceptance PASS with perfect scores', async () => {
    const acceptancePrompt = await startFinalAcceptanceAuditPrompt('req-perfect-final-pass');
    await completeAcceptanceAuditFromPrompt(acceptancePrompt, {
      module_scores: OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS.map((module) => ({
        module,
        score: 10,
        max_score: 10,
        summary: `${module} perfect`,
      })),
    });
    await emitDeckDemoIdle();

    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('passed');
    expect(terminal?.projection.terminalReason).toBe('final_audit_passed');
    expect(terminal?.projection.implementationAuditRound).toEqual({ current: 1, total: 1 });
    expect([...p2pRuns.values()]).toHaveLength(1);
  });

  it('does not start another spec Team round after final spec acceptance PASS with acceptable scores', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-spec-pass-does-not-fill-budget',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'deep',
      materializedLimits: {
        specAuditRepairRounds: 3,
        implementationAuditRepairRounds: 1,
        maxImplementationPrompts: 24,
        maxElapsedMinutes: 480,
      },
    }, serverLinkMock as never);

    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'spec_audit_repair');
    await completeLatestDiscussion('completed', '# spec audit discussion\n\nRepair artifacts before final scoring.');
    await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver spec-artifact repair context for @openspec/changes/demo-change'),
      2500,
    );
    await emitDeckDemoIdle();
    const specAcceptancePrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver final specification acceptance audit for @openspec/changes/demo-change'),
      2500,
    );
    await completeAcceptanceAuditFromPrompt(specAcceptancePrompt, {
      module_scores: OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS.map((module) => ({
        module,
        score: module === 'risk' ? 7 : 8,
        max_score: 10,
        summary: `${module} acceptable`,
      })),
    });
    await emitDeckDemoIdle();

    const implementationProjection = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_task_loop',
      2500,
    );
    expect(implementationProjection.projection.finalAfterRepair).toMatchObject({
      phase: 'final_after_repair',
      verdict: 'PASS',
      summary: 'spec_audit_passed',
    });
    expect(implementationProjection.projection.moduleScores?.some((score: { score?: number }) => score.score === 7)).toBe(true);
    expect([...p2pRuns.values()]).toHaveLength(1);
  });

  it('stops for human input when spec audit reports BLOCKED', async () => {
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-blocked',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'spec_audit_repair');
    await completeLatestDiscussion('completed', '# spec audit discussion\n\nScope remains externally blocked.');
    await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver spec-artifact repair context for @openspec/changes/demo-change'),
      2500,
    );
    await emitDeckDemoIdle();
    const specAcceptancePrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver final specification acceptance audit for @openspec/changes/demo-change'),
      2500,
    );
    await completeAcceptanceAuditFromPrompt(specAcceptancePrompt, {
      verdict: 'BLOCKED',
      required_changes: ['scope is unclear'],
    });
    await emitDeckDemoIdle();

    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('needs_human');
    expect(terminal?.projection.terminalReason).toBe('spec_audit_blocked');
    expect(terminal?.projection.latestVerdict).toBe('BLOCKED');
    expect([...p2pRuns.values()]).toHaveLength(1);
  });

  it('feeds implementation audit REWORK back into implementation repair before re-auditing', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-rework',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    await emitDeckDemoIdle();
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');
    const firstAuditRun = [...p2pRuns.values()].at(-1)!;

    await completeLatestDiscussion('completed', '# implementation audit discussion\n\nRequired repair: tighten tests.\n');

    const repairPrompt = await waitForTransportSend((text) =>
      text.includes('Audit findings to repair now:')
      && text.includes('Reason: implementation_audit_followup_repair')
      && text.includes('Audit discussion file:')
      && text.includes('Do not write another audit report'),
      2500,
    );
    expect(repairPrompt).toContain('This repair pass is required even when the implementation audit passed');
    expect(repairPrompt).toContain(`Audit discussion file: ${firstAuditRun.contextFilePath}`);
    expect(repairPrompt).toContain('Before editing, read the audit discussion file above for the full review/plan context');
    expect(repairPrompt).toContain('Locate the latest "repair task checklist" section and complete it item by item');
    expect(repairPrompt).toContain('if that heading is absent, use the latest final summary / Implementation Plan');
    const gate = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_task_loop'
      && String(msg.projection?.lastMessage ?? '').includes('implementation_audit_followup_repair'),
      2500,
    );
    expect(gate.projection.status).toBe('implementation_task_loop');
    expect(gate.projection.latestVerdict).toBeUndefined();
    expect(gate.projection.moduleScores).toBeUndefined();
    expect(gate.projection.auditBeforeRepair).toBeUndefined();
    expect(gate.projection.finalAfterRepair).toBeUndefined();
    expect(gate.projection.auditResults).toBeUndefined();
    expect(gate.projection.implementationAuditRound).toEqual({ current: 1, total: 1 });

    expect([...p2pRuns.values()]).toHaveLength(1);
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await emitDeckDemoIdle();

    const acceptancePrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver final implementation acceptance audit for @openspec/changes/demo-change')
      && text.includes('Previous audit discussion file:')
      && text.includes('Previous audit required_changes to verify:')
      && !text.includes('quick verification'),
      2500,
    );
    expect([...p2pRuns.values()]).toHaveLength(1);
    await completeAcceptanceAuditFromPrompt(acceptancePrompt, {
      repairs_applied: [{ files: ['test/demo.test.ts'], reason: 'tighten tests' }],
    });
    await emitDeckDemoIdle();

    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('passed');
    expect(terminal?.projection.terminalReason).toBe('final_audit_passed');
    expect(terminal?.projection.auditBeforeRepair).toBeUndefined();
    expect(terminal?.projection.finalAfterRepair).toMatchObject({
      phase: 'final_after_repair',
      verdict: 'PASS',
      summary: 'final_audit_passed',
      roundIndex: 1,
    });
    expect(terminal?.projection.auditResults).toHaveLength(1);
  });

  it('feeds low implementation audit scores back into implementation repair', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-low-score',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    await emitDeckDemoIdle();
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');
    await completeLatestDiscussion('completed', '# implementation audit discussion\n\nTests need a targeted regression case.\n');

    const repairPrompt = await waitForTransportSend((text) =>
      text.includes('Audit findings to repair now:')
      && text.includes('Reason: implementation_audit_followup_repair')
      && text.includes('Audit discussion file:')
      && text.includes('Do not write another audit report'),
      2500,
    );
    expect(repairPrompt).toContain('This repair pass is required even when the implementation audit passed');
    const gate = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && String(msg.projection?.lastMessage ?? '').includes('implementation_audit_followup_repair'),
      2500,
    );
    expect(gate.projection.status).toBe('implementation_task_loop');
    expect(gate.projection.implementationPromptCount).toBe(2);
    expect(gate.projection.implementationAuditRound).toEqual({ current: 1, total: 1 });
    expect(gate.projection.auditBeforeRepair).toBeUndefined();
    expect(gate.projection.finalAfterRepair).toBeUndefined();
    expect(gate.projection.auditResults).toBeUndefined();

    expect([...p2pRuns.values()]).toHaveLength(1);
    await emitDeckDemoIdle();

    const acceptancePrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver final implementation acceptance audit for @openspec/changes/demo-change')
      && text.includes('Previous audit discussion file:')
      && !text.includes('quick verification'),
      2500,
    );
    expect([...p2pRuns.values()]).toHaveLength(1);
    await completeAcceptanceAuditFromPrompt(acceptancePrompt);
    await emitDeckDemoIdle();

    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('passed');
    expect(terminal?.projection.finalAfterRepair).toMatchObject({
      phase: 'final_after_repair',
      verdict: 'PASS',
      summary: 'final_audit_passed',
      roundIndex: 1,
    });
  });

  it('feeds final acceptance REWORK back into implementation repair before extending audit rounds', async () => {
    const acceptancePrompt = await startFinalAcceptanceAuditPrompt('req-final-rework-followup-repair');
    const unresolved = 'test/postgres-review.test.ts:77 — add Postgres failure-injection coverage for rollback';
    await completeAcceptanceAuditFromPrompt(acceptancePrompt, {
      verdict: 'REWORK',
      required_changes: [unresolved],
      repair_completion: repairCompletion({
        status: 'incomplete',
        previous_items_complete: false,
        completed_items: [],
        incomplete_items: [unresolved],
        summary: 'The Postgres rollback evidence requested by the previous audit is still missing.',
      }),
      module_scores: OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS.map((module) => ({
        module,
        score: module === 'tasks' || module === 'tests' || module === 'risk' ? 5 : 8,
        max_score: 10,
        summary: `${module} final acceptance`,
      })),
    });
    await emitDeckDemoIdle();

    const repairPrompt = await waitForTransportSend((text) =>
      text.includes('Audit findings to repair now:')
      && text.includes('Reason: quality_gate_low_score:tasks=5,tests=5,risk=5')
      && text.includes(unresolved)
      && text.includes('Do not write another audit report. Edit the product code, tests, and tasks.md now'),
      2500,
    );
    expect(repairPrompt).toContain('Previous implementation audit verdict: REWORK');
    expect(repairPrompt).toContain('Must-fix items flagged by the previous implementation audit');
    const gate = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && String(msg.projection?.lastMessage ?? '').includes('quality_gate_low_score:tasks=5,tests=5,risk=5'),
      2500,
    );
    expect(gate.projection.status).toBe('implementation_task_loop');
    expect(gate.projection.implementationPromptCount).toBe(3);
    expect(gate.projection.implementationAuditRound).toEqual({ current: 1, total: 1 });
    expect([...p2pRuns.values()]).toHaveLength(1);

    await emitDeckDemoIdle();
    const nextAcceptancePrompt = await waitForTransportSend((text) =>
      text !== acceptancePrompt
      && text.includes('OpenSpec Auto Deliver final implementation acceptance audit for @openspec/changes/demo-change')
      && text.includes(unresolved),
      2500,
    );
    expect(nextAcceptancePrompt).toContain('Previous audit verdict: REWORK');
    expect([...p2pRuns.values()]).toHaveLength(1);
  });

  it('starts another Team implementation audit only after final acceptance says previous repairs are complete but still low scoring', async () => {
    const acceptancePrompt = await startFinalAcceptanceAuditPrompt('req-final-complete-low-score-new-round');
    await completeAcceptanceAuditFromPrompt(acceptancePrompt, {
      verdict: 'REWORK',
      required_changes: ['new transaction edge case remains after previous repairs'],
      repair_completion: repairCompletion({
        completed_items: ['previous implementation checklist completed'],
        summary: 'Previous implementation repair checklist is complete; a newly found transaction edge case remains.',
      }),
      module_scores: OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS.map((module) => ({
        module,
        score: module === 'risk' ? 5 : 8,
        max_score: 10,
        summary: `${module} final acceptance`,
      })),
    });
    await emitDeckDemoIdle();

    const start = Date.now();
    while (Date.now() - start < 2500 && [...p2pRuns.values()].length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect([...p2pRuns.values()]).toHaveLength(2);
    const projection = await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_audit_repair'
      && msg.projection?.implementationAuditRepairRound === 2,
      2500,
    );
    expect(projection.projection.implementationAuditRepairRound).toBe(2);
    expect(projection.projection.implementationAuditRound).toEqual({ current: 1, total: 2 });
    expect(transportSendMock.mock.calls.filter((call) =>
      String(call[0] ?? '').includes('Reason: quality_gate_low_score:risk=5'),
    )).toHaveLength(0);
  });

  it('keeps valid missing authoritative result files classified as missing JSON', async () => {
    const acceptancePrompt = await startFinalAcceptanceAuditPrompt('req-valid-missing-result-file');
    const origin = parseAutoDeliverMetadataBlock(acceptancePrompt);
    await emitDeckDemoIdle();

    const repairPrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver needs the final implementation acceptance audit authoritative result file')
      && text.includes('Problem: missing_authoritative_json'),
      2500,
    );
    expect(repairPrompt).toContain(`Authoritative result file: ${origin.authoritativeResultPath}`);
    expect(repairPrompt).not.toContain('invalid_authoritative_result_path');
  });

  it('requests authoritative result file repair before consuming another audit-repair round', async () => {
    const acceptancePrompt = await startFinalAcceptanceAuditPrompt('req-missing-json-retry');
    const origin = parseAutoDeliverMetadataBlock(acceptancePrompt);
    await emitDeckDemoIdle();
    const repairPrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver needs the final implementation acceptance audit authoritative result file')
      && text.includes('Problem: missing_authoritative_json'),
      2500,
    );
    expect(repairPrompt).toContain('Do not perform a new audit. Only correct the authoritative JSON file');
    expect(repairPrompt).toContain(`Authoritative result file: ${origin.authoritativeResultPath}`);
    expect(repairPrompt).toContain(`"authoritativeResultPath": "${origin.authoritativeResultPath}"`);
    await waitForSend((msg) =>
      msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && msg.projection?.stage === 'implementation_audit_repair'
      && msg.projection?.implementationAuditRepairRound === 1
      && msg.projection?.lastMessage === 'post_repair_result_file_repair_prompt_dispatched',
      2500,
    );

    expect([...p2pRuns.values()]).toHaveLength(1);
    await writeFile(String(origin.authoritativeResultPath), JSON.stringify(auditPayload({
      auto_deliver: origin,
      repair_completion: repairCompletion(),
    }), null, 2), 'utf8');
    await emitDeckDemoIdle();

    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('passed');
    expect(terminal?.projection.terminalReason).toBe('final_audit_passed');
  });

  it('requests authoritative result file repair for verdict payload format errors', async () => {
    const acceptancePrompt = await startFinalAcceptanceAuditPrompt('req-invalid-verdict-payload-repair');
    const origin = parseAutoDeliverMetadataBlock(acceptancePrompt);
    await writeFile(String(origin.authoritativeResultPath), JSON.stringify(auditPayload({
      auto_deliver: origin,
      evidence: [{ source: 'OpenSpec CLI', summary: '' }],
    }), null, 2), 'utf8');
    await emitDeckDemoIdle();

    const repairPrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver needs the final implementation acceptance audit authoritative result file')
      && text.includes('Problem: invalid_evidence_summary'),
      2500,
    );
    expect(repairPrompt).toContain(`Authoritative result file: ${origin.authoritativeResultPath}`);
    expect(repairPrompt).toContain('Allowed verdict values: PASS, REWORK, BLOCKED');
    expect(repairPrompt).toContain('module_scores must contain exactly one entry for each module');
    expectAuthoritativeResultSchemaHints(repairPrompt);
    expect([...p2pRuns.values()]).toHaveLength(1);

    await writeFile(String(origin.authoritativeResultPath), JSON.stringify(auditPayload({
      auto_deliver: origin,
      repair_completion: repairCompletion(),
    }), null, 2), 'utf8');
    await emitDeckDemoIdle();
    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('passed');
    expect(terminal?.projection.terminalReason).toBe('final_audit_passed');
  });

  it('requires repair_completion before consuming a final acceptance result', async () => {
    const acceptancePrompt = await startFinalAcceptanceAuditPrompt('req-missing-repair-completion');
    const origin = parseAutoDeliverMetadataBlock(acceptancePrompt);
    await writeFile(String(origin.authoritativeResultPath), JSON.stringify(auditPayload({
      auto_deliver: origin,
    }), null, 2), 'utf8');
    await emitDeckDemoIdle();

    const repairPrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver needs the final implementation acceptance audit authoritative result file')
      && text.includes('Problem: missing_repair_completion'),
      2500,
    );
    expect(repairPrompt).toContain(`Authoritative result file: ${origin.authoritativeResultPath}`);
    expect(repairPrompt).toContain('Final acceptance audits must include repair_completion with fields');
    expect([...p2pRuns.values()]).toHaveLength(1);

    await writeFile(String(origin.authoritativeResultPath), JSON.stringify(auditPayload({
      auto_deliver: origin,
      repair_completion: repairCompletion(),
    }), null, 2), 'utf8');
    await emitDeckDemoIdle();
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
    await completeLatestDiscussion('completed', '# spec audit discussion\n\nRepair artifacts before final scoring.');
    await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver spec-artifact repair context for @openspec/changes/demo-change'),
      2500,
    );
    await emitDeckDemoIdle();
    await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver final specification acceptance audit for @openspec/changes/demo-change'),
      2500,
    );
    await emitDeckDemoIdle();

    const repairPrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver needs the final specification acceptance audit authoritative result file')
      && text.includes('Problem: missing_authoritative_json'),
      2500,
    );
    expect(repairPrompt).toContain('The top-level auto_deliver object must exactly equal this metadata object');
    expectAuthoritativeResultSchemaHints(repairPrompt);
    expect(repairPrompt).not.toContain('```');
    expect(repairPrompt).not.toContain('"module_scores"');
  });

  it('stops for human input when final acceptance result-file repair also fails', async () => {
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-missing-json-full-retry',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'standard',
    }, serverLinkMock as never);

    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'spec_audit_repair');
    await completeSpecAuditDiscussionToImplementation();
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_task_loop', 2500);
    await emitDeckDemoIdle();
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');

    await completeLatestDiscussion('completed', '# implementation audit discussion\n\nRepair before final scoring.');
    await waitForTransportSend((text) =>
      text.includes('Audit findings to repair now:')
      && text.includes('Reason: implementation_audit_followup_repair'),
      2500,
    );
    await emitDeckDemoIdle();
    await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver final implementation acceptance audit for @openspec/changes/demo-change'),
      2500,
    );
    await emitDeckDemoIdle();
    await waitForTransportSend((text) => text.includes('Problem: missing_authoritative_json'), 2500);
    await emitDeckDemoIdle();
    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('needs_human');
    expect(terminal?.projection.terminalReason).toBe('missing_authoritative_json');
  });

  it('stops for human input when implementation audit reports BLOCKED', async () => {
    const acceptancePrompt = await startFinalAcceptanceAuditPrompt('req-implementation-blocked');
    await completeAcceptanceAuditFromPrompt(acceptancePrompt, {
      verdict: 'BLOCKED',
      required_changes: ['external dependency is unavailable'],
    });
    await emitDeckDemoIdle();

    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('needs_human');
    expect(terminal?.projection.terminalReason).toBe('implementation_audit_blocked');
    expect(terminal?.projection.latestVerdict).toBe('BLOCKED');
    expect(terminal?.projection.moduleScores).toHaveLength(OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS.length);
    expect(terminal?.projection.auditResults).toHaveLength(1);
  });

  it('rejects stale metadata and malformed or missing authoritative result files', async () => {
    const stalePrompt = await startFinalAcceptanceAuditPrompt('req-stale-audit');
    await completeAcceptanceAuditFromPrompt(stalePrompt, {
      auto_deliver: {
        ...parseAutoDeliverMetadataBlock(stalePrompt),
        generation: 999,
      },
    });
    await emitDeckDemoIdle();
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
    await completeAcceptanceAuditFromPrompt(stalePrompt);
    await emitDeckDemoIdle();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(serverLinkMock.send.mock.calls.filter((call) => call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL)).toHaveLength(terminalCountAfterStale);
    expect(serverLinkMock.send.mock.calls.filter((call) => call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION)).toHaveLength(projectionCountAfterStale);

    clearOpenSpecAutoDeliverRunsForTests();
    serverLinkMock.send.mockClear();
    transportSendMock.mockClear();
    p2pRuns.clear();
    await startFinalAcceptanceAuditPrompt('req-multiple-json');
    await emitDeckDemoIdle();
    await waitForTransportSend((text) => text.includes('Problem: missing_authoritative_json'), 2500);
    await emitDeckDemoIdle();
    terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.terminalReason).toBe('missing_authoritative_json');

    clearOpenSpecAutoDeliverRunsForTests();
    serverLinkMock.send.mockClear();
    transportSendMock.mockClear();
    p2pRuns.clear();
    const malformedPrompt = await startFinalAcceptanceAuditPrompt('req-malformed-json-file');
    await writeFile(String(parseAutoDeliverMetadataBlock(malformedPrompt).authoritativeResultPath), '{not json', 'utf8');
    await emitDeckDemoIdle();
    await waitForTransportSend((text) => text.includes('Problem: malformed_authoritative_json'), 2500);
    await emitDeckDemoIdle();
    terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.terminalReason).toBe('malformed_authoritative_json');
  }, 10_000);

  it('rejects authoritative result files that symlink outside .imc/discussions', async () => {
    const acceptancePrompt = await startFinalAcceptanceAuditPrompt('req-result-symlink-escape');
    const origin = parseAutoDeliverMetadataBlock(acceptancePrompt);
    const outsideDir = await mkdtemp(join(tmpdir(), 'imcodes-auto-deliver-outside-result-'));
    extraTempDirs.push(outsideDir);
    const outsideResult = join(outsideDir, 'authoritative.json');
    await writeFile(outsideResult, JSON.stringify(auditPayload({ auto_deliver: origin }), null, 2), 'utf8');
    await symlink(outsideResult, String(origin.authoritativeResultPath), 'file');
    await emitDeckDemoIdle();

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

    await emitDeckDemoIdle();
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');
    await completeLatestDiscussion('completed', '# implementation audit discussion\n\nResult path must stay inside project discussions.');
    await waitForTransportSend((text) =>
      text.includes('Audit findings to repair now:')
      && text.includes('Reason: implementation_audit_followup_repair'),
      2500,
    );
    await emitDeckDemoIdle();
    await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver final implementation acceptance audit for @openspec/changes/demo-change'),
      2500,
    );
    await emitDeckDemoIdle();

    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('needs_human');
    expect(terminal?.projection.terminalReason).toBe('invalid_authoritative_result_path');
    expect(transportSendMock.mock.calls.some((call) => String(call[0] ?? '').includes('Problem: invalid_authoritative_result_path'))).toBe(false);
  });

  it('ignores discussion JSON when the authoritative result file is missing', async () => {
    const acceptancePrompt = await startFinalAcceptanceAuditPrompt('req-result-summary');
    const origin = parseAutoDeliverMetadataBlock(acceptancePrompt);
    const summaryWithJson = [
      'final result',
      '```json',
      JSON.stringify(auditPayload({ auto_deliver: origin }), null, 2),
      '```',
    ].join('\n');
    expect(summaryWithJson).toContain('"verdict"');
    await emitDeckDemoIdle();
    await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver needs the final implementation acceptance audit authoritative result file')
      && text.includes('Problem: missing_authoritative_json'),
      2500,
    );
    await emitDeckDemoIdle();
    const terminal = await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, 2500);
    expect(terminal?.projection.status).toBe('needs_human');
    expect(terminal?.projection.terminalReason).toBe('missing_authoritative_json');
  });

  it('uses an authoritative result file larger than the generic P2P summary tail', async () => {
    const acceptancePrompt = await startFinalAcceptanceAuditPrompt('req-large-strict-result');
    const origin = parseAutoDeliverMetadataBlock(acceptancePrompt);
    const largePayload = auditPayload({
      auto_deliver: origin,
      repair_completion: repairCompletion(),
      module_scores: OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS.map((module) => ({
        module,
        score: 9,
        max_score: 10,
        summary: `${module} ${'x'.repeat(700)}`,
      })),
    });
    const resultJson = JSON.stringify(largePayload, null, 2);
    expect(resultJson.length).toBeGreaterThan(2_000);
    await writeFile(String(origin.authoritativeResultPath), resultJson, 'utf8');
    await emitDeckDemoIdle();

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

    await emitDeckDemoIdle();
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

  it('proceeds to repair + scoring on a post-summary execution-gate failure instead of audit_p2p_failed', async () => {
    // Regression: the Team audit discussion's by-design post-summary execution
    // gate may end with a `failed` marker when the agent could not finish ALL the
    // repair in one hop — but the discussion analysis is complete. The run must
    // PROCEED to the separate repair + acceptance scoring (which produces the
    // score), NOT terminalize as audit_p2p_failed and NOT re-run the discussion
    // (which would loop, incrementing rounds without ever producing a score).
    // Contrast the dispatch_failed infrastructure case above, which still hard-fails.
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-post-summary-exec-proceed',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    await emitDeckDemoIdle();
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && (msg.projection as { stage?: string })?.stage === 'implementation_audit_repair');
    const p2pRun = [...p2pRuns.values()].at(-1)!;
    p2pRun.error = 'post_summary_execution_failed: implementation repair scope not completed in this turn';
    await completeLatestAudit('failed');

    // The run proceeds to the implementation repair dispatch (which leads to the
    // acceptance audit that produces the score) rather than re-running the audit.
    await waitForTransportSend((text) =>
      text.includes('Audit findings to repair now:')
      && text.includes('Reason: implementation_audit_followup_repair'),
      2500,
    );

    // And it does NOT hard-fail the delivery as audit_p2p_failed.
    const auditP2pFailedTerminal = serverLinkMock.send.mock.calls
      .map((call) => call[0] as { type?: string; projection?: { terminalReason?: string } })
      .find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL && msg.projection?.terminalReason === 'audit_p2p_failed');
    expect(auditP2pFailedTerminal).toBeUndefined();
  });

  it('proceeds to repair + scoring when the audit discussion times out (a hop ran out of its time box)', async () => {
    // Regression: a hop/discussion timeout leaves partial-but-usable analysis in
    // the file, but the run used to hard-fail as audit_p2p_failed. It must PROCEED
    // to repair + scoring like the gate-failure case. This path is keyed on the
    // P2P run status being `timed_out` (not on the post-summary error string).
    await makeChange('demo-change', '- [x] first\n- [x] second\n');
    await handleOpenSpecAutoDeliverCommand({
      type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      requestId: 'req-audit-hop-timeout-proceed',
      sessionName: 'deck_demo_brain',
      changeName: 'demo-change',
      presetId: 'fast',
    }, serverLinkMock as never);

    await emitDeckDemoIdle();
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && (msg.projection as { stage?: string })?.stage === 'implementation_audit_repair');
    const p2pRun = [...p2pRuns.values()].at(-1)!;
    p2pRun.error = 'timed_out: hop_timeout';
    await completeLatestAudit('timed_out');

    await waitForTransportSend((text) =>
      text.includes('Audit findings to repair now:')
      && text.includes('Reason: implementation_audit_followup_repair'),
      2500,
    );

    const auditP2pFailedTerminal = serverLinkMock.send.mock.calls
      .map((call) => call[0] as { type?: string; projection?: { terminalReason?: string } })
      .find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL && msg.projection?.terminalReason === 'audit_p2p_failed');
    expect(auditP2pFailedTerminal).toBeUndefined();
  });

  it('classifies post-summary execution gate failures as recoverable and infra failures as terminal', () => {
    expect(isPostSummaryExecutionGateFailure('post_summary_execution_failed: implementation repair scope not completed in this turn')).toBe(true);
    expect(isPostSummaryExecutionGateFailure('timed_out: post_summary_execution_timeout')).toBe(true);
    expect(isPostSummaryExecutionGateFailure('dispatch_failed: tmux send-keys failed: can\'t find pane')).toBe(false);
    expect(isPostSummaryExecutionGateFailure('timed_out: hop_timeout')).toBe(false);
    expect(isPostSummaryExecutionGateFailure(null)).toBe(false);
    expect(isPostSummaryExecutionGateFailure(undefined)).toBe(false);
    expect(isPostSummaryExecutionGateFailure('')).toBe(false);
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

  it('does not resend the full implementation prompt when tasks remain unchecked after idle', async () => {
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
    expect(transportSendMock.mock.calls[0]?.[0]).toContain('Validation candidates:');
    expect(transportSendMock.mock.calls[0]?.[0]).toContain('project-specific hints only');
    expect(transportSendMock.mock.calls[0]?.[0]).toContain('Discovered safe validation command candidates from project manifests: pnpm typecheck; pnpm test');
    expect(transportSendMock.mock.calls[0]?.[0]).toContain('Unsafe validation commands were skipped: pnpm deploy');
    expect(transportSendMock.mock.calls[0]?.[0]).not.toContain('Recommended validation commands:');
    await emitDeckDemoIdle();

    const reminderPrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver implementation is not complete yet for @openspec/changes/demo-change.')
      && text.includes('Reason: implementation_tasks_still_unchecked'),
      2500,
    );
    expect(reminderPrompt).toContain('Drive the implementation of @openspec/changes/demo-change aggressively.');
    expect(reminderPrompt).toContain('dispatch sub-agents with clear ownership');
    expect(reminderPrompt).toContain('Continue from the current implementation state');
    const fullImplementationPrompts = transportSendMock.mock.calls
      .map((call) => String(call[0] ?? ''))
      .filter((text) => text.includes('Implementation prompt:'));
    expect(fullImplementationPrompts).toHaveLength(1);
    expect(fullImplementationPrompts[0]).toContain('Implementation prompt: 1/6');
    expect(serverLinkMock.send.mock.calls.some((call) =>
      call[0]?.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
      && call[0]?.projection?.implementationPromptCount > 1,
    )).toBe(false);
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
    await emitDeckDemoIdle();

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
    await emitDeckDemoIdle();
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

    await emitSessionIdle('deck_sub_worker');
    await waitForSend((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION && msg.projection?.stage === 'implementation_audit_repair');
    await completeLatestDiscussion('completed', '# implementation audit discussion\n\nNo remaining issues.');
    await waitForTransportSend((text) =>
      text.includes('Audit findings to repair now:')
      && text.includes('Reason: implementation_audit_followup_repair'),
      2500,
    );
    await emitSessionIdle('deck_sub_worker');
    const acceptancePrompt = await waitForTransportSend((text) =>
      text.includes('OpenSpec Auto Deliver final implementation acceptance audit for @openspec/changes/demo-change'),
      2500,
    );
    await completeAcceptanceAuditFromPrompt(acceptancePrompt);
    await emitSessionIdle('deck_sub_worker');
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
