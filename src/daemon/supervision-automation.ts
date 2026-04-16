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
  parseAuditVerdictDetailsFromText,
  parseTaskRunTerminalStateDetailsFromText,
  type SessionSupervisionSnapshot,
  type TaskRunTerminalState,
} from '../../shared/supervision-config.js';
import {
  buildContextualAutomationAuditPromptAppend,
  buildOpenSpecAutomationAuditPromptAppend,
  buildReworkBriefPrompt,
} from './supervision-prompts.js';

type TaskRunPhase = 'execution' | 'auditing';

interface ActiveTaskRunState {
  generation: number;
  sessionName: string;
  commandId: string;
  snapshot: SessionSupervisionSnapshot;
  userText: string;
  phase: TaskRunPhase;
  awaitingMarker: boolean;
  lastAssistantText?: string;
  terminalState?: TaskRunTerminalState;
  auditRunId?: string;
  auditLoops: number;
  startedAt: number;
}

interface PendingTaskIntent {
  commandId: string;
  text: string;
  snapshot: SessionSupervisionSnapshot;
}

interface AuditBaseline {
  kind: 'openspec' | 'contextual';
  userText: string;
  fileContents: Array<{ path: string; content: string }>;
  changeDir?: string;
}

type DirEntryLike = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
};

function trimString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
      fileContents: candidate.mdFiles,
      userText: [
        `OpenSpec implementation audit for change: ${changeName}`,
        `Task run marker contract: ${SUPERVISION_CONTRACT_IDS.TASK_RUN_STATUS}`,
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
    `Task run marker contract: ${SUPERVISION_CONTRACT_IDS.TASK_RUN_STATUS}`,
    `Audit verdict contract: ${SUPERVISION_CONTRACT_IDS.CONTEXTUAL_AUDIT}`,
    `Selected automation audit mode: ${run.snapshot.auditMode}`,
    `Task request: ${run.userText}`,
    `Last assistant output: ${run.lastAssistantText ?? '(none)'}`,
    `Task terminal state: ${run.terminalState ?? 'missing'}`,
  ].join('\n');

  return {
    kind: 'contextual',
    userText: summary,
    fileContents: [{ path: 'contextual-audit-summary.md', content: summary }],
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

function buildReworkBrief(run: ActiveTaskRunState, verdictText: string): string {
  return buildReworkBriefPrompt(run.sessionName, run.userText, run.lastAssistantText, verdictText);
}

function isFinalAssistantPayload(payload: Record<string, unknown>): boolean {
  return payload.streaming === false || payload.streaming === undefined;
}

class SupervisionAutomation {
  private activeRuns = new Map<string, ActiveTaskRunState>();
  private pendingTaskIntents = new Map<string, PendingTaskIntent>();
  private pollers = new Map<string, ReturnType<typeof setInterval>>();
  private initialized = false;
  private serverLink: ServerLink | null = null;

  private emitWarning(sessionName: string, text: string): void {
    timelineEmitter.emit(
      sessionName,
      'assistant.text',
      { text: `⚠️ ${text}`, streaming: false, automation: true, automationKind: 'supervision-warning' },
      { source: 'daemon', confidence: 'high', eventId: `supervision-warning:${randomUUID()}` },
    );
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
    if (!state) return;
    if (state.auditRunId) {
      cancelP2pRun(state.auditRunId, this.serverLink);
    }
    this.clearPoller(sessionName);
    this.activeRuns.delete(sessionName);
    this.pendingTaskIntents.delete(sessionName);
  }

  queueTaskIntent(
    sessionName: string,
    commandId: string,
    text: string,
    snapshot: SessionSupervisionSnapshot,
  ): void {
    if (snapshot.mode !== SUPERVISION_MODE.SUPERVISED_AUDIT) return;
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
    if (snapshot.mode !== SUPERVISION_MODE.SUPERVISED_AUDIT) return null;
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
      awaitingMarker: false,
      auditLoops: 0,
      startedAt: Date.now(),
    };
    this.activeRuns.set(sessionName, next);
    return next;
  }

  getActiveRun(sessionName: string): ActiveTaskRunState | undefined {
    return this.activeRuns.get(sessionName);
  }

  private handleTimelineEvent(event: { sessionId: string; type: string; payload: Record<string, unknown> }): void {
    if (event.type === 'user.message') {
      const pending = this.pendingTaskIntents.get(event.sessionId);
      const clientMessageId = trimString(event.payload.clientMessageId);
      const automation = event.payload.automation === true;
      if (pending && !automation && clientMessageId === pending.commandId) {
        this.pendingTaskIntents.delete(event.sessionId);
        this.registerTaskIntent(event.sessionId, pending.commandId, pending.text, pending.snapshot);
      }
    }

    const run = this.activeRuns.get(event.sessionId);
    if (!run) return;

    if (event.type === 'assistant.text' && isFinalAssistantPayload(event.payload)) {
      const text = trimString(event.payload.text) ?? '';
      if (!text) return;
      run.lastAssistantText = text;
      if (run.phase !== 'execution') return;
      const parsedMarker = parseTaskRunTerminalStateDetailsFromText(text);
      const terminalState = parsedMarker.state;
      if (!terminalState) {
        run.awaitingMarker = true;
        if (parsedMarker.markerCount > 1) {
          this.emitWarning(run.sessionName, 'Heavy supervision expected exactly one task-run marker but received multiple markers. Automation returned to manual control.');
          this.finishRun(run.sessionName, 'needs_input');
        }
        return;
      }
      run.terminalState = terminalState;
      run.awaitingMarker = false;
      if (terminalState === 'complete') {
        if (run.snapshot.mode === SUPERVISION_MODE.SUPERVISED_AUDIT) {
          void this.startAudit(run).catch((error) => {
            logger.warn({ session: run.sessionName, err: error }, 'Supervision audit start failed');
            this.emitWarning(run.sessionName, 'Automation audit could not be started. Manual continuation is required.');
            this.finishRun(run.sessionName, 'blocked');
          });
        } else {
          this.finishRun(run.sessionName, 'complete');
        }
        return;
      }
      this.finishRun(run.sessionName, terminalState);
      return;
    }

    if (event.type === 'session.state') {
      const state = trimString(event.payload.state);
      if (state === 'idle' && run.phase === 'execution' && run.awaitingMarker && !run.terminalState) {
        this.emitWarning(run.sessionName, 'Heavy supervision expected a terminal task-run marker but none was found. Automation returned to manual control.');
        this.finishRun(run.sessionName, 'needs_input');
      }
      if ((state === 'stopped' || state === 'error') && run.phase === 'execution') {
        this.emitWarning(run.sessionName, 'Heavy supervision stopped because the session entered a blocked state.');
        this.finishRun(run.sessionName, 'blocked');
      }
    }
  }

  private finishRun(sessionName: string, state: TaskRunTerminalState): void {
    const run = this.activeRuns.get(sessionName);
    if (!run) return;
    run.terminalState = state;
    this.clearPoller(sessionName);
    this.activeRuns.delete(sessionName);
  }

  private async startAudit(run: ActiveTaskRunState): Promise<void> {
    if (run.phase !== 'execution' || this.activeRuns.get(run.sessionName)?.generation !== run.generation) return;
    const baseline = await resolveAuditBaseline(run.sessionName, run);
    const current = this.activeRuns.get(run.sessionName);
    if (!current || current.generation !== run.generation) return;

    current.phase = 'auditing';
    current.awaitingMarker = false;
    const auditRound = {
      id: 'implementation_audit',
      title: 'Implementation Audit',
      preset: 'implementation_audit' as const,
      executionMode: 'single_main' as const,
      permissionScope: 'analysis_only' as const,
      timeoutMinutes: 6,
      verdictPolicy: 'smart_gate' as const,
      promptAppend: buildAuditRoundPromptAppend(baseline, current),
    };

    try {
      const started = await startP2pRun({
        initiatorSession: current.sessionName,
        targets: [],
        userText: baseline.userText,
        fileContents: baseline.fileContents,
        serverLink: this.serverLink,
        modeOverride: current.snapshot.auditMode,
        rounds: 1,
        advancedRounds: [auditRound],
      });
      current.auditRunId = started.id;
      this.startAuditPoller(current.sessionName, current.generation, started.id);
    } catch (error) {
      this.clearPoller(current.sessionName);
      this.activeRuns.delete(current.sessionName);
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
      this.activeRuns.delete(state.sessionName);
      this.clearPoller(state.sessionName);
      return;
    }

    current.auditLoops += 1;
    this.clearPoller(state.sessionName);
    if (current.auditLoops >= current.snapshot.maxAuditLoops) {
      this.emitWarning(state.sessionName, 'Automation audit reached the configured rework-loop limit. Manual review is required.');
      this.activeRuns.delete(state.sessionName);
      return;
    }

    const transportRuntime = getTransportRuntime(state.sessionName);
    if (!transportRuntime) {
      this.activeRuns.delete(state.sessionName);
      return;
    }

    const reworkBrief = buildReworkBrief(current, resultSummary);
    const record = getSession(state.sessionName);
    const decision = await supervisionBroker.decide({
      snapshot: current.snapshot,
      prompt: reworkBrief,
      cwd: record?.projectDir,
      description: record?.description,
    });
    if (decision.decision !== 'approve') {
      this.emitWarning(
        state.sessionName,
        `Automation rework was not auto-dispatched because supervision returned ${decision.decision}: ${decision.reason}`,
      );
      this.activeRuns.delete(state.sessionName);
      return;
    }

    current.phase = 'execution';
    current.auditRunId = undefined;
    current.awaitingMarker = false;
    current.terminalState = undefined;

    timelineEmitter.emit(
      state.sessionName,
      'user.message',
      { text: reworkBrief, allowDuplicate: true, automation: true, automationKind: 'supervision-rework' },
      { source: 'daemon', confidence: 'high', eventId: `supervision-rework:${state.generation}:${current.auditLoops}:${randomUUID()}` },
    );
    try {
      transportRuntime.send(reworkBrief, `supervision-rework-${state.generation}-${current.auditLoops}`);
    } catch (error) {
      logger.warn({ session: state.sessionName, err: error }, 'Supervision rework dispatch failed');
      this.emitWarning(state.sessionName, 'Automation could not send the rework brief back into the session. Manual continuation is required.');
      this.activeRuns.delete(state.sessionName);
    }
  }
}

export const supervisionAutomation = new SupervisionAutomation();
