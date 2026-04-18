import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSession } from '../store/session-store.js';
import { getTransportRuntime } from '../agent/session-manager.js';
import { startP2pRun, cancelP2pRun, getP2pRun } from './p2p-orchestrator.js';
import type { ServerLink } from './server-link.js';
import { timelineEmitter } from './timeline-emitter.js';
import { supervisionBroker } from './supervision-broker.js';
import logger from '../util/logger.js';
import {
  SUPERVISION_CONTRACT_IDS,
  SUPERVISION_MODE,
  SUPERVISION_UNAVAILABLE_REASONS,
  extractSessionSupervisionSnapshot,
  parseAuditVerdictDetailsFromText,
  type SessionSupervisionSnapshot,
  type SupervisionUnavailableReason,
  type TaskRunTerminalState,
} from '../../shared/supervision-config.js';
import { parseModePipeline } from '../../shared/p2p-modes.js';
import type { P2pAdvancedRound, P2pRoundVerdictPolicy } from '../../shared/p2p-advanced.js';
import {
  buildSupervisionContinuePrompt,
  buildContextualAutomationAuditPromptAppend,
  buildOpenSpecAutomationAuditPromptAppend,
  buildReworkBriefPrompt,
} from './supervision-prompts.js';
import { TIMELINE_EVENT_FILE_CHANGE, type FileChangePatch } from '../../shared/file-change.js';

type TaskRunPhase = 'execution' | 'auditing';

const MAX_AUTO_CONTINUE_STEPS = 8;
const SUPERVISION_WAITING_LABEL = 'Supervised: analyzing completion...';
const SUPERVISION_AUDIT_WAITING_LABEL = 'Supervised: running automated audit...';
const SUPERVISION_COMPLETE_LABEL = 'Supervised: task looks complete.';
const SUPERVISION_CONTINUE_LABEL = 'Supervised: sent a continue prompt.';
const SUPERVISION_NEEDS_INPUT_LABEL = 'Supervised: returned control to you.';
const SUPERVISION_AUDIT_PASS_LABEL = 'Supervised: audit passed.';
const SUPERVISION_REWORK_LABEL = 'Supervised: audit requested rework; brief sent.';
const SUPERVISION_BLOCKED_LABEL = 'Supervised: stopped because the session is blocked.';

interface ActiveTaskRunState {
  generation: number;
  sessionName: string;
  commandId: string;
  snapshot: SessionSupervisionSnapshot;
  userText: string;
  phase: TaskRunPhase;
  continueLoops: number;
  evaluating: boolean;
  sawAssistantOutput: boolean;
  awaitingAssistantAfterIdle: boolean;
  lastAssistantText?: string;
  terminalState?: TaskRunTerminalState;
  auditRunId?: string;
  // Number of rework briefs that have been dispatched back into the session
  // since the run started. `maxAuditLoops = N` permits up to N rework dispatches
  // per supervised-task-audit-loop spec; see `handleCompletedAudit`.
  reworkDispatches: number;
  startedAt: number;
}

interface PendingTaskIntent {
  commandId: string;
  text: string;
  snapshot: SessionSupervisionSnapshot;
}

interface RecentTaskCandidate {
  commandId: string;
  text: string;
  sequence: number;
}

interface LatestAssistantText {
  text: string;
  sequence: number;
}

interface AuditBaseline {
  kind: 'openspec' | 'contextual';
  userText: string;
  fileContents: Array<{ path: string; content: string }>;
  changeDir?: string;
}

interface TimelineAuditArtifacts {
  changedFiles: Array<{ path: string; content: string }>;
  validationOutputs: Array<{ path: string; content: string }>;
}

type DirEntryLike = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
};

function trimString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function formatUnavailableReason(reason: SupervisionUnavailableReason | undefined): string | null {
  switch (reason) {
    case SUPERVISION_UNAVAILABLE_REASONS.PROVIDER_NOT_CONNECTED:
      return 'Automation could not reach the configured supervisor provider. Manual continuation is required.';
    case SUPERVISION_UNAVAILABLE_REASONS.INVALID_SNAPSHOT:
      return 'Automation configuration is invalid. Repair the Auto settings before continuing.';
    case SUPERVISION_UNAVAILABLE_REASONS.QUEUE_TIMEOUT:
      return 'Automation timed out waiting for supervisor capacity. Manual continuation is required.';
    case SUPERVISION_UNAVAILABLE_REASONS.DECISION_TIMEOUT:
      return 'Automation timed out waiting for a supervisor decision. Manual continuation is required.';
    case SUPERVISION_UNAVAILABLE_REASONS.INVALID_OUTPUT:
      return 'Automation could not parse a valid supervisor decision. Manual continuation is required.';
    case SUPERVISION_UNAVAILABLE_REASONS.PROVIDER_ERROR:
      return 'Automation failed because the supervisor provider returned an error. Manual continuation is required.';
    default:
      return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readMarkdownTree(root: string, maxFiles = 50): Promise<Array<{ path: string; content: string }>> {
  const results: Array<{ path: string; content: string }> = [];
  const queue: Array<{ absPath: string; relPath: string }> = [{ absPath: root, relPath: path.basename(root) }];

  while (queue.length > 0 && results.length < maxFiles) {
    const item = queue.shift()!;
    let entries: DirEntryLike[];
    try {
      entries = (await readdir(item.absPath, { withFileTypes: true })) as unknown as DirEntryLike[];
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const absPath = path.join(item.absPath, entry.name);
      const relPath = path.join(item.relPath, entry.name);
      if (entry.isDirectory()) {
        queue.push({ absPath, relPath });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      try {
        const content = await readFile(absPath, 'utf8');
        results.push({ path: relPath.replaceAll(path.sep, '/'), content });
      } catch {
        // Ignore unreadable files; audit can still proceed with the rest.
      }
    }
  }

  return results;
}

function stringifyAuditValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => stringifyAuditValue(entry))
      .filter((entry): entry is string => !!entry);
    return parts.length > 0 ? parts.join('\n') : null;
  }
  if (value && typeof value === 'object') {
    try {
      const text = JSON.stringify(value, null, 2);
      return text === '{}' ? null : text;
    } catch {
      return null;
    }
  }
  return null;
}

function summarizeFileChangePatch(patch: FileChangePatch): string {
  const header = [
    `${patch.operation.toUpperCase()} ${patch.filePath}`,
    patch.oldPath ? `(from ${patch.oldPath})` : '',
    `[${patch.confidence}]`,
  ].filter(Boolean).join(' ');
  const body = patch.unifiedDiff
    ?? patch.afterText
    ?? patch.beforeText
    ?? stringifyAuditValue(patch.raw)
    ?? '(no diff payload)';
  return `${header}\n${body}`.trim();
}

function collectTimelineAuditArtifacts(sessionName: string): TimelineAuditArtifacts {
  const events = timelineEmitter.replay(sessionName, 0).events.slice(-200);
  const changedFileEntries: string[] = [];
  const validationEntries: string[] = [];

  for (const event of events) {
    if (event.type === TIMELINE_EVENT_FILE_CHANGE) {
      const batch = event.payload.batch as { patches?: FileChangePatch[] } | undefined;
      for (const patch of batch?.patches ?? []) {
        changedFileEntries.push(summarizeFileChangePatch(patch));
      }
      continue;
    }
    if (event.type === 'tool.result') {
      const text = stringifyAuditValue(
        event.payload.output
        ?? event.payload.result
        ?? event.payload.text
        ?? event.payload.content,
      );
      if (text) validationEntries.push(text);
      continue;
    }
    if (event.type === 'command.ack' && typeof event.payload.error === 'string' && event.payload.error.trim()) {
      validationEntries.push(`Command error: ${event.payload.error.trim()}`);
    }
  }

  return {
    changedFiles: changedFileEntries.length > 0
      ? [{ path: 'changed-files.txt', content: changedFileEntries.join('\n\n---\n\n') }]
      : [],
    validationOutputs: validationEntries.length > 0
      ? [{ path: 'validation-output.txt', content: validationEntries.join('\n\n---\n\n') }]
      : [],
  };
}

function resolveReferencedOpenSpecChangeName(
  run: ActiveTaskRunState,
  changeNames: string[],
): string | null {
  const haystack = `${run.userText}\n${run.lastAssistantText ?? ''}`;
  const explicitPathMatches = changeNames.filter((changeName) => haystack.includes(`openspec/changes/${changeName}`));
  if (explicitPathMatches.length === 1) return explicitPathMatches[0]!;
  if (explicitPathMatches.length > 1) return null;

  const directNameMatches = changeNames.filter((changeName) => {
    const escaped = changeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
  });
  return directNameMatches.length === 1 ? directNameMatches[0]! : null;
}

async function resolveAuditBaseline(sessionName: string, run: ActiveTaskRunState): Promise<AuditBaseline> {
  const timelineArtifacts = collectTimelineAuditArtifacts(sessionName);
  const record = getSession(sessionName);
  const projectDir = record?.projectDir?.trim();
  const openspecChangesDir = projectDir ? path.join(projectDir, 'openspec', 'changes') : undefined;
  const changeCandidates: Array<{ dir: string; mdFiles: Array<{ path: string; content: string }> }> = [];

  if (openspecChangesDir && await fileExists(openspecChangesDir)) {
    let entries: DirEntryLike[];
    try {
      entries = (await readdir(openspecChangesDir, { withFileTypes: true })) as unknown as DirEntryLike[];
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const changeDir = path.join(openspecChangesDir, entry.name);
      const tasksMd = path.join(changeDir, 'tasks.md');
      const proposalMd = path.join(changeDir, 'proposal.md');
      const designMd = path.join(changeDir, 'design.md');
      if (!(await fileExists(tasksMd)) || !(await fileExists(proposalMd)) || !(await fileExists(designMd))) continue;
      const mdFiles = await readMarkdownTree(changeDir);
      changeCandidates.push({ dir: changeDir, mdFiles });
    }
  }

  const referencedChangeName = resolveReferencedOpenSpecChangeName(
    run,
    changeCandidates.map((candidate) => path.basename(candidate.dir)),
  );
  if (referencedChangeName) {
    const candidate = changeCandidates.find((entry) => path.basename(entry.dir) === referencedChangeName);
    if (!candidate) {
      throw new Error(`Referenced OpenSpec change not found: ${referencedChangeName}`);
    }
    const changeName = path.basename(candidate.dir);
    return {
      kind: 'openspec',
      changeDir: candidate.dir,
      fileContents: [...candidate.mdFiles, ...timelineArtifacts.changedFiles, ...timelineArtifacts.validationOutputs],
      userText: [
        `OpenSpec implementation audit for change: ${changeName}`,
        `Audit verdict contract: ${SUPERVISION_CONTRACT_IDS.OPENSPEC_IMPLEMENTATION_AUDIT}`,
        `Selected automation audit mode: ${run.snapshot.auditMode}`,
        '',
        `The completed implementation claims the task is ${run.terminalState ?? 'complete'}. Audit the implementation-only path against proposal, design, tasks, and specs.`,
        'Do not rerun discussion or proposal phases.',
      ].join('\n'),
    };
  }

  const summary = [
    `Contextual implementation audit for session ${sessionName}.`,
    `Audit verdict contract: ${SUPERVISION_CONTRACT_IDS.CONTEXTUAL_AUDIT}`,
    `Selected automation audit mode: ${run.snapshot.auditMode}`,
    `Task request: ${run.userText}`,
    `Last assistant output: ${run.lastAssistantText ?? '(none)'}`,
    `Task terminal state: ${run.terminalState ?? 'missing'}`,
  ].join('\n');

  return {
    kind: 'contextual',
    userText: summary,
    fileContents: [
      { path: 'contextual-audit-summary.md', content: summary },
      ...timelineArtifacts.changedFiles,
      ...timelineArtifacts.validationOutputs,
    ],
  };
}

function buildAuditRoundPromptAppend(baseline: AuditBaseline, run: ActiveTaskRunState): string {
  if (baseline.kind === 'openspec' && baseline.changeDir) {
    return buildOpenSpecAutomationAuditPromptAppend(
      run.snapshot.auditMode,
      run.userText,
      run.terminalState ?? 'missing',
      baseline.changeDir,
    );
  } else {
    return buildContextualAutomationAuditPromptAppend(
      run.snapshot.auditMode,
      run.userText,
      run.terminalState ?? 'missing',
    );
  }
}

// Expand a user-selected `auditMode` (single mode or combo like `audit>review>plan`)
// into a concrete P2P advanced-round pipeline. Each step becomes one advanced round;
// the last non-plan step owns the authoritative `smart_gate` verdict so the existing
// rework-loop path still fires on REWORK. Plan rounds never produce a verdict — they
// append context for the auditor to consume.
// See openspec/changes/supervised-task-automation/specs/session-supervision-modes/spec.md
// and supervised-task-audit-loop/spec.md for the contract.
function buildAutomationAuditRounds(
  auditMode: string,
  basePromptAppend: string,
  opts: { timeoutMinutes: number } = { timeoutMinutes: 6 },
): P2pAdvancedRound[] {
  const steps = parseModePipeline(auditMode).filter(Boolean);
  if (steps.length === 0) {
    // Shouldn't happen — snapshot normalization rejects empty auditMode — but guard
    // against malformed input so downstream P2P validation gets a useful shape.
    return [{
      id: 'implementation_audit',
      title: 'Implementation Audit',
      preset: 'implementation_audit',
      executionMode: 'single_main',
      permissionScope: 'analysis_only',
      timeoutMinutes: opts.timeoutMinutes,
      verdictPolicy: 'smart_gate',
      promptAppend: basePromptAppend,
    }];
  }

  // The authoritative verdict must come from an audit-style round. Plan rounds
  // accumulate context without voting. Locate the last audit/review index — that's
  // where we attach `smart_gate`. If the pipeline is only plan rounds (not valid per
  // SUPERVISION_AUDIT_MODES, but defensively), fall back to the last round.
  const verdictStepIndex = (() => {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      if (steps[i] === 'audit' || steps[i] === 'review') return i;
    }
    return steps.length - 1;
  })();

  return steps.map((step, idx) => {
    const verdictPolicy: P2pRoundVerdictPolicy = idx === verdictStepIndex ? 'smart_gate' : 'none';
    const title = step === 'plan'
      ? `Plan Round ${idx + 1}`
      : step === 'review'
        ? `Implementation Review ${idx + 1}`
        : `Implementation Audit ${idx + 1}`;
    return {
      id: `automation_${step}_${idx + 1}`,
      title,
      preset: step === 'plan' ? 'custom' : 'implementation_audit',
      executionMode: 'single_main',
      permissionScope: 'analysis_only',
      timeoutMinutes: opts.timeoutMinutes,
      verdictPolicy,
      promptAppend: basePromptAppend,
    };
  });
}

function buildReworkBrief(run: ActiveTaskRunState, verdictText: string): string {
  return buildReworkBriefPrompt(run.sessionName, run.userText, run.lastAssistantText, verdictText);
}

function isFinalAssistantPayload(payload: Record<string, unknown>): boolean {
  return payload.streaming === false || payload.streaming === undefined;
}

class SupervisionAutomation {
  private activeRuns = new Map<string, ActiveTaskRunState>();
  private pendingTaskIntents = new Map<string, PendingTaskIntent>();
  private recentTaskCandidates = new Map<string, RecentTaskCandidate>();
  private latestAssistantTexts = new Map<string, LatestAssistantText>();
  private awaitingImplicitAssistantAfterIdle = new Set<string>();
  private pollers = new Map<string, ReturnType<typeof setInterval>>();
  private initialized = false;
  private serverLink: ServerLink | null = null;
  private eventSequence = 0;

  private emitWarning(sessionName: string, text: string): void {
    timelineEmitter.emit(
      sessionName,
      'assistant.text',
      { text: `⚠️ ${text}`, streaming: false, automation: true, automationKind: 'supervision-warning', memoryExcluded: true },
      { source: 'daemon', confidence: 'high', eventId: `supervision-warning:${randomUUID()}` },
    );
  }

  private emitAutomationNote(sessionName: string, text: string, kind: string): void {
    timelineEmitter.emit(
      sessionName,
      'assistant.text',
      { text, streaming: false, automation: true, automationKind: kind, memoryExcluded: true },
      { source: 'daemon', confidence: 'high', eventId: `supervision-note:${kind}:${randomUUID()}` },
    );
  }

  private emitStatus(sessionName: string, status: string, label: string): void {
    timelineEmitter.emit(
      sessionName,
      'agent.status',
      { status, label },
      { source: 'daemon', confidence: 'high', eventId: `supervision-status:${sessionName}:${status}` },
    );
  }

  private clearStatus(sessionName: string): void {
    timelineEmitter.emit(
      sessionName,
      'agent.status',
      { status: null, label: null },
      { source: 'daemon', confidence: 'high', eventId: `supervision-status:${sessionName}:clear` },
    );
  }

  private emitTerminalStatus(sessionName: string, status: string, label: string): void {
    this.emitStatus(sessionName, status, label);
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    timelineEmitter.on((event) => {
      this.handleTimelineEvent(event);
    });
  }

  setServerLink(serverLink: ServerLink | null): void {
    this.serverLink = serverLink;
  }

  cancelSession(sessionName: string): void {
    const state = this.activeRuns.get(sessionName);
    if (state?.auditRunId) {
      cancelP2pRun(state.auditRunId, this.serverLink);
    }
    this.clearPoller(sessionName);
    this.activeRuns.delete(sessionName);
    this.pendingTaskIntents.delete(sessionName);
    this.recentTaskCandidates.delete(sessionName);
    this.latestAssistantTexts.delete(sessionName);
    this.awaitingImplicitAssistantAfterIdle.delete(sessionName);
    this.clearStatus(sessionName);
  }

  applySnapshotUpdate(sessionName: string, snapshot: SessionSupervisionSnapshot | null | undefined): void {
    if (!snapshot || snapshot.mode === SUPERVISION_MODE.OFF) {
      this.cancelSession(sessionName);
      return;
    }
    const active = this.activeRuns.get(sessionName);
    if (active) {
      active.snapshot = snapshot;
    }
    const pending = this.pendingTaskIntents.get(sessionName);
    if (pending) {
      this.pendingTaskIntents.set(sessionName, { ...pending, snapshot });
    }
    // Regression fix: if supervision was freshly enabled on an already-idle
    // session (user flipped Auto ON after the assistant had already finished a
    // turn), we must evaluate the most recent turn NOW. Waiting for the next
    // idle boundary would mean "nothing ever happens" until the user sends
    // another message — which is exactly the symptom reported as
    // "idle 后依旧不触发任何动作和效果".
    //
    // We reuse the same implicit-idle preconditions as `handleTimelineEvent`
    // (recent task candidate + newer assistant response) so the guardrails
    // against stale turns stay identical.
    if (!active) {
      this.maybeTriggerImplicitRun(sessionName, snapshot);
    }
  }

  private maybeTriggerImplicitRun(
    sessionName: string,
    snapshot: SessionSupervisionSnapshot,
  ): void {
    const candidate = this.recentTaskCandidates.get(sessionName);
    const latestAssistant = this.latestAssistantTexts.get(sessionName);
    if (!candidate || !latestAssistant) return;
    if (latestAssistant.sequence <= candidate.sequence) return;
    const implicitRun = this.registerTaskIntent(sessionName, candidate.commandId, candidate.text, snapshot);
    if (!implicitRun) return;
    this.awaitingImplicitAssistantAfterIdle.delete(sessionName);
    implicitRun.lastAssistantText = latestAssistant.text;
    implicitRun.sawAssistantOutput = true;
    implicitRun.evaluating = true;
    this.emitStatus(sessionName, 'supervision_waiting', SUPERVISION_WAITING_LABEL);
    this.emitAutomationNote(sessionName, 'Auto: checking whether the task is complete...', 'supervision-status');
    void this.evaluateExecutionTurn(implicitRun).catch((error) => {
      logger.warn({ session: sessionName, err: error }, 'Supervision implicit execution evaluation failed on snapshot update');
      this.clearStatus(sessionName);
      this.emitWarning(sessionName, 'Automation could not determine whether the task is complete. Manual continuation is required.');
      this.finishRun(sessionName, 'needs_input');
    });
  }

  queueTaskIntent(
    sessionName: string,
    commandId: string,
    text: string,
    snapshot: SessionSupervisionSnapshot,
  ): void {
    if (snapshot.mode === SUPERVISION_MODE.OFF) return;
    this.cancelSession(sessionName);
    this.pendingTaskIntents.set(sessionName, { commandId, text, snapshot });
  }

  updateQueuedTaskIntent(sessionName: string, commandId: string, text: string): void {
    const pending = this.pendingTaskIntents.get(sessionName);
    if (!pending || pending.commandId !== commandId) return;
    this.pendingTaskIntents.set(sessionName, { ...pending, text });
  }

  removeQueuedTaskIntent(sessionName: string, commandId: string): void {
    const pending = this.pendingTaskIntents.get(sessionName);
    if (!pending || pending.commandId !== commandId) return;
    this.pendingTaskIntents.delete(sessionName);
  }

  registerTaskIntent(
    sessionName: string,
    commandId: string,
    text: string,
    snapshot: SessionSupervisionSnapshot,
  ): ActiveTaskRunState | null {
    if (snapshot.mode === SUPERVISION_MODE.OFF) return null;
    const existing = this.activeRuns.get(sessionName);
    if (existing?.auditRunId) {
      cancelP2pRun(existing.auditRunId, this.serverLink);
    }
    this.clearPoller(sessionName);
    const next: ActiveTaskRunState = {
      generation: (existing?.generation ?? 0) + 1,
      sessionName,
      commandId,
      snapshot,
      userText: text,
      phase: 'execution',
      continueLoops: 0,
      evaluating: false,
      sawAssistantOutput: false,
      awaitingAssistantAfterIdle: false,
      reworkDispatches: 0,
      startedAt: Date.now(),
    };
    this.recentTaskCandidates.delete(sessionName);
    this.activeRuns.set(sessionName, next);
    return next;
  }

  getActiveRun(sessionName: string): ActiveTaskRunState | undefined {
    return this.activeRuns.get(sessionName);
  }

  private handleTimelineEvent(event: { sessionId: string; type: string; payload: Record<string, unknown> }): void {
    const sequence = ++this.eventSequence;

    if (event.type === 'user.message') {
      const pending = this.pendingTaskIntents.get(event.sessionId);
      const clientMessageId = trimString(event.payload.clientMessageId);
      const automation = event.payload.automation === true;
      const text = trimString(event.payload.text);
      if (!automation && text && !text.startsWith('/')) {
        this.awaitingImplicitAssistantAfterIdle.delete(event.sessionId);
        this.recentTaskCandidates.set(event.sessionId, {
          commandId: clientMessageId ?? `implicit:${Date.now()}`,
          text,
          sequence,
        });
      }
      if (pending && !automation && clientMessageId === pending.commandId) {
        this.pendingTaskIntents.delete(event.sessionId);
        this.registerTaskIntent(event.sessionId, pending.commandId, pending.text, pending.snapshot);
      }
    }

    if (event.type === 'assistant.text' && isFinalAssistantPayload(event.payload)) {
      if (event.payload.automation === true) return;
      const text = typeof event.payload.text === 'string' ? event.payload.text : '';
      this.latestAssistantTexts.set(event.sessionId, { text, sequence });
      const run = this.activeRuns.get(event.sessionId);
      if (!run) {
        if (this.awaitingImplicitAssistantAfterIdle.has(event.sessionId)) {
          const record = getSession(event.sessionId);
          const snapshot = record?.agentType
            ? extractSessionSupervisionSnapshot(record.transportConfig ?? null)
            : null;
          if (snapshot && snapshot.mode !== SUPERVISION_MODE.OFF) {
            this.maybeTriggerImplicitRun(event.sessionId, snapshot);
          }
        }
        return;
      }
      run.lastAssistantText = text;
      run.sawAssistantOutput = true;
      if (run.phase === 'execution' && run.awaitingAssistantAfterIdle && !run.evaluating) {
        run.awaitingAssistantAfterIdle = false;
        run.evaluating = true;
        this.emitStatus(run.sessionName, 'supervision_waiting', SUPERVISION_WAITING_LABEL);
        this.emitAutomationNote(run.sessionName, 'Auto: checking whether the task is complete...', 'supervision-status');
        void this.evaluateExecutionTurn(run).catch((error) => {
          logger.warn({ session: run.sessionName, err: error }, 'Supervision execution evaluation failed after delayed assistant output');
          this.clearStatus(run.sessionName);
          this.emitWarning(run.sessionName, 'Automation could not determine whether the task is complete. Manual continuation is required.');
          this.finishRun(run.sessionName, 'needs_input');
        });
      }
      return;
    }

    if (event.type === 'session.state') {
      const run = this.activeRuns.get(event.sessionId);
      const state = trimString(event.payload.state);
      if (state === 'idle' && !run) {
        const candidate = this.recentTaskCandidates.get(event.sessionId);
        const record = getSession(event.sessionId);
        const snapshot = record?.agentType
          ? extractSessionSupervisionSnapshot(record.transportConfig ?? null)
          : null;
        const latestAssistant = this.latestAssistantTexts.get(event.sessionId);
        if (candidate && snapshot && snapshot.mode !== SUPERVISION_MODE.OFF && latestAssistant && latestAssistant.sequence > candidate.sequence) {
          const implicitRun = this.registerTaskIntent(event.sessionId, candidate.commandId, candidate.text, snapshot);
          if (implicitRun) {
            this.awaitingImplicitAssistantAfterIdle.delete(event.sessionId);
            implicitRun.lastAssistantText = latestAssistant.text;
            implicitRun.sawAssistantOutput = true;
            implicitRun.evaluating = true;
            void this.evaluateExecutionTurn(implicitRun).catch((error) => {
              logger.warn({ session: implicitRun.sessionName, err: error }, 'Supervision implicit execution evaluation failed');
              this.emitWarning(implicitRun.sessionName, 'Automation could not determine whether the task is complete. Manual continuation is required.');
              this.finishRun(implicitRun.sessionName, 'needs_input');
            });
          }
        } else if (candidate && snapshot && snapshot.mode !== SUPERVISION_MODE.OFF) {
          this.awaitingImplicitAssistantAfterIdle.add(event.sessionId);
        } else {
          this.awaitingImplicitAssistantAfterIdle.delete(event.sessionId);
        }
        // Intentionally: do NOT delete the candidate when supervision is OFF
        // at idle. The user may enable Auto afterwards, and
        // `applySnapshotUpdate` uses this candidate to kick off an implicit
        // run against the most recent completed turn. Clearing here was the
        // reason "idle 后依旧不触发任何动作和效果" when Auto was turned on
        // against an already-idle session.
        return;
      }
      if (!run) return;
      if (state === 'idle' && run.phase === 'execution' && !run.evaluating) {
        if (!run.sawAssistantOutput) {
          run.awaitingAssistantAfterIdle = true;
          return;
        }
        run.awaitingAssistantAfterIdle = false;
        this.emitStatus(run.sessionName, 'supervision_waiting', SUPERVISION_WAITING_LABEL);
        this.emitAutomationNote(run.sessionName, 'Auto: checking whether the task is complete...', 'supervision-status');
        run.evaluating = true;
        void this.evaluateExecutionTurn(run).catch((error) => {
          logger.warn({ session: run.sessionName, err: error }, 'Supervision execution evaluation failed');
          this.clearStatus(run.sessionName);
          this.emitWarning(run.sessionName, 'Automation could not determine whether the task is complete. Manual continuation is required.');
          this.finishRun(run.sessionName, 'needs_input');
        });
      }
      if ((state === 'stopped' || state === 'error') && run.phase === 'execution') {
        this.emitTerminalStatus(run.sessionName, 'supervision_blocked', SUPERVISION_BLOCKED_LABEL);
        this.emitWarning(run.sessionName, 'Supervision stopped because the session entered a blocked state.');
        this.finishRun(run.sessionName, 'blocked', { preserveStatus: true });
      }
    }
  }

  private async evaluateExecutionTurn(run: ActiveTaskRunState): Promise<void> {
    const current = this.activeRuns.get(run.sessionName);
    if (!current || current.generation !== run.generation || current.phase !== 'execution') return;

    const record = getSession(run.sessionName);
    let decision;
    try {
      decision = await supervisionBroker.decide({
        snapshot: current.snapshot,
        taskRequest: current.userText,
        assistantResponse: current.lastAssistantText,
        cwd: record?.projectDir,
        description: record?.description,
      });
    } finally {
      this.clearStatus(run.sessionName);
    }

    const latest = this.activeRuns.get(run.sessionName);
    if (!latest || latest.generation !== run.generation || latest.phase !== 'execution') return;
    latest.evaluating = false;

    switch (decision.decision) {
      case 'complete': {
        latest.terminalState = 'complete';
        if (latest.snapshot.mode === SUPERVISION_MODE.SUPERVISED_AUDIT) {
          await this.startAudit(latest);
        } else {
          this.emitAutomationNote(run.sessionName, 'Auto: task looks complete.', 'supervision-complete');
          this.emitTerminalStatus(run.sessionName, 'supervision_complete', SUPERVISION_COMPLETE_LABEL);
          this.finishRun(run.sessionName, 'complete', { preserveStatus: true });
        }
        return;
      }
      case 'continue': {
        if (latest.continueLoops >= MAX_AUTO_CONTINUE_STEPS) {
          this.emitWarning(run.sessionName, 'Automation reached the maximum auto-continue limit. Manual continuation is required.');
          this.finishRun(run.sessionName, 'needs_input');
          return;
        }
        await this.dispatchContinue(latest, decision.reason);
        return;
      }
      case 'ask_human':
      default: {
        const unavailableText = formatUnavailableReason(decision.unavailableReason);
        this.emitTerminalStatus(run.sessionName, 'supervision_needs_input', SUPERVISION_NEEDS_INPUT_LABEL);
        this.emitWarning(run.sessionName, unavailableText ?? `Automation returned control to the human: ${decision.reason}`);
        this.finishRun(run.sessionName, 'needs_input', { preserveStatus: true });
      }
    }
  }

  private finishRun(
    sessionName: string,
    state: TaskRunTerminalState,
    options: { preserveStatus?: boolean } = {},
  ): void {
    const run = this.activeRuns.get(sessionName);
    if (!run) return;
    run.terminalState = state;
    this.clearPoller(sessionName);
    this.activeRuns.delete(sessionName);
    if (!options.preserveStatus) this.clearStatus(sessionName);
  }

  private async startAudit(run: ActiveTaskRunState): Promise<void> {
    if (run.phase !== 'execution' || this.activeRuns.get(run.sessionName)?.generation !== run.generation) return;
    const baseline = await resolveAuditBaseline(run.sessionName, run);
    const current = this.activeRuns.get(run.sessionName);
    if (!current || current.generation !== run.generation) return;

    current.phase = 'auditing';
    current.evaluating = false;
    this.emitStatus(current.sessionName, 'supervision_audit_waiting', SUPERVISION_AUDIT_WAITING_LABEL);
    this.emitAutomationNote(current.sessionName, 'Auto: running the configured audit pipeline...', 'supervision-audit');

    // Build the advanced-round pipeline from the stored auditMode so combo modes
    // like `audit>plan` and `audit>review>plan` actually expand into multiple rounds.
    // Prior to this, `modeOverride` was silently ignored whenever `advancedRounds`
    // was non-empty (see shared/p2p-advanced.ts:349-369), collapsing every combo
    // mode to a single `implementation_audit` round.
    const auditRounds = buildAutomationAuditRounds(
      current.snapshot.auditMode,
      buildAuditRoundPromptAppend(baseline, current),
      { timeoutMinutes: 6 },
    );

    try {
      const started = await startP2pRun({
        initiatorSession: current.sessionName,
        targets: [],
        userText: baseline.userText,
        fileContents: baseline.fileContents,
        serverLink: this.serverLink,
        // modeOverride is intentionally omitted — resolveP2pRoundPlan ignores it
        // whenever advancedRounds is non-empty, so leaving it undefined makes the
        // single source of routing truth explicit.
        rounds: auditRounds.length,
        advancedRounds: auditRounds,
      });
      current.auditRunId = started.id;
      this.startAuditPoller(current.sessionName, current.generation, started.id);
    } catch (error) {
      this.clearPoller(current.sessionName);
      this.activeRuns.delete(current.sessionName);
      this.clearStatus(current.sessionName);
      throw error;
    }
  }

  private startAuditPoller(sessionName: string, generation: number, runId: string): void {
    this.clearPoller(sessionName);
    const poller = setInterval(() => {
      const state = this.activeRuns.get(sessionName);
      if (!state || state.generation !== generation || state.auditRunId !== runId || state.phase !== 'auditing') {
        this.clearPoller(sessionName);
        return;
      }
      const run = getP2pRun(runId);
      if (!run) return;
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
        void this.handleCompletedAudit(state, run.status === 'completed' ? (run.resultSummary ?? '') : '').catch((error) => {
          logger.warn({ session: sessionName, err: error }, 'Supervision audit completion handling failed');
          this.activeRuns.delete(sessionName);
          this.clearPoller(sessionName);
          this.clearStatus(sessionName);
        });
      }
    }, 1_000);
    this.pollers.set(sessionName, poller);
  }

  private clearPoller(sessionName: string): void {
    const poller = this.pollers.get(sessionName);
    if (poller) clearInterval(poller);
    this.pollers.delete(sessionName);
  }

  private async handleCompletedAudit(state: ActiveTaskRunState, resultSummary: string): Promise<void> {
    const current = this.activeRuns.get(state.sessionName);
    if (!current || current.generation !== state.generation || current.phase !== 'auditing') return;
    this.clearStatus(state.sessionName);
    const parsedVerdict = parseAuditVerdictDetailsFromText(resultSummary);
    const verdict = parsedVerdict.verdict;
    if (!verdict) {
      this.emitWarning(state.sessionName, parsedVerdict.markerCount > 1
        ? 'Automation audit returned multiple verdict markers. Manual review is required.'
        : 'Automation audit did not return a valid verdict marker. Manual review is required.');
      this.activeRuns.delete(state.sessionName);
      this.clearPoller(state.sessionName);
      return;
    }

    if (verdict === 'PASS') {
      this.emitAutomationNote(state.sessionName, 'Auto: audit passed.', 'supervision-audit-pass');
      this.emitTerminalStatus(state.sessionName, 'supervision_audit_pass', SUPERVISION_AUDIT_PASS_LABEL);
      this.activeRuns.delete(state.sessionName);
      this.clearPoller(state.sessionName);
      return;
    }

    // `maxAuditLoops = N` means "up to N rework dispatches". Per the audit-loop spec,
    // we must check BEFORE incrementing so a max of N allows exactly N dispatches.
    // (Previous code incremented first, which yielded N-1 dispatches in practice.)
    this.clearPoller(state.sessionName);
    if (current.reworkDispatches >= current.snapshot.maxAuditLoops) {
      this.emitWarning(state.sessionName, 'Automation audit reached the configured rework-loop limit. Manual review is required.');
      this.activeRuns.delete(state.sessionName);
      return;
    }
    current.reworkDispatches += 1;

    const transportRuntime = getTransportRuntime(state.sessionName);
    if (!transportRuntime) {
      this.activeRuns.delete(state.sessionName);
      return;
    }

    const reworkBrief = buildReworkBrief(current, resultSummary);
    current.phase = 'execution';
    current.auditRunId = undefined;
    current.evaluating = false;
    current.sawAssistantOutput = false;
    current.awaitingAssistantAfterIdle = false;
    current.terminalState = undefined;
    current.lastAssistantText = undefined;

    timelineEmitter.emit(
      state.sessionName,
      'user.message',
      { text: reworkBrief, allowDuplicate: true, automation: true, automationKind: 'supervision-rework' },
      { source: 'daemon', confidence: 'high', eventId: `supervision-rework:${state.generation}:${current.reworkDispatches}:${randomUUID()}` },
    );
    try {
      transportRuntime.send(reworkBrief, `supervision-rework-${state.generation}-${current.reworkDispatches}`);
      this.emitAutomationNote(state.sessionName, 'Auto: audit requested rework; rework brief sent.', 'supervision-rework-status');
      this.emitTerminalStatus(state.sessionName, 'supervision_rework_sent', SUPERVISION_REWORK_LABEL);
    } catch (error) {
      logger.warn({ session: state.sessionName, err: error }, 'Supervision rework dispatch failed');
      this.emitWarning(state.sessionName, 'Automation could not send the rework brief back into the session. Manual continuation is required.');
      this.activeRuns.delete(state.sessionName);
    }
  }

  private async dispatchContinue(run: ActiveTaskRunState, reason: string): Promise<void> {
    const current = this.activeRuns.get(run.sessionName);
    if (!current || current.generation !== run.generation || current.phase !== 'execution') return;
    const transportRuntime = getTransportRuntime(run.sessionName);
    if (!transportRuntime) {
      this.finishRun(run.sessionName, 'blocked');
      return;
    }

    const continuePrompt = buildSupervisionContinuePrompt(
      current.userText,
      current.lastAssistantText,
      reason,
    );
    current.continueLoops += 1;
    current.sawAssistantOutput = false;
    current.awaitingAssistantAfterIdle = false;
    current.lastAssistantText = undefined;
    current.terminalState = undefined;

    timelineEmitter.emit(
      run.sessionName,
      'user.message',
      { text: continuePrompt, allowDuplicate: true, automation: true, automationKind: 'supervision-continue' },
      { source: 'daemon', confidence: 'high', eventId: `supervision-continue:${run.generation}:${current.continueLoops}:${randomUUID()}` },
    );

    try {
      transportRuntime.send(continuePrompt, `supervision-continue-${run.generation}-${current.continueLoops}`);
      this.emitAutomationNote(run.sessionName, 'Auto: sent a continue prompt to keep the task moving.', 'supervision-continue-status');
      this.emitTerminalStatus(run.sessionName, 'supervision_continue_sent', SUPERVISION_CONTINUE_LABEL);
    } catch (error) {
      logger.warn({ session: run.sessionName, err: error }, 'Supervision continue dispatch failed');
      this.emitWarning(run.sessionName, 'Automation could not continue the task. Manual continuation is required.');
      this.finishRun(run.sessionName, 'blocked');
    }
  }
}

export const supervisionAutomation = new SupervisionAutomation();
