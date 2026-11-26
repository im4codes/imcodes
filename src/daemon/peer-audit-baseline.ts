import { randomUUID } from 'node:crypto';

export interface CompletedAuditBaseline {
  baselineId: string;
  auditedSessionInstanceId: string;
  auditedRuntimeEpoch: string;
  taskCommandId: string;
  generationOrEpoch: number;
  userText: string;
  assistantText: string;
  completedEventId: string;
  completedAt: number;
  supervisorRationale?: string;
}

export interface PeerAuditWorkState {
  foreground: boolean;
  background: boolean;
  pendingCompletion: boolean;
  subagent: boolean;
}

export type PeerAuditBaselineInvalidationReason =
  | 'new_intent'
  | 'queued_edit'
  | 'stop'
  | 'cancel'
  | 'session_replaced'
  | 'runtime_replaced'
  | 'session_deleted'
  | 'daemon_restart'
  | 'work_resumed';

interface PendingTopLevelTask {
  auditedSessionInstanceId: string;
  auditedRuntimeEpoch: string;
  taskCommandId: string;
  generationOrEpoch: number;
  userText: string;
  terminalResult?: {
    assistantText: string;
    completedEventId: string;
    completedAt: number;
    supervisorRationale?: string;
  };
}

interface SessionBaselineState {
  offModeEpoch: number;
  work: PeerAuditWorkState;
  pending?: PendingTopLevelTask;
  completed?: CompletedAuditBaseline;
  lastInvalidationReason?: PeerAuditBaselineInvalidationReason;
}

const ACTIVE_FOREGROUND: PeerAuditWorkState = {
  foreground: true,
  background: false,
  pendingCompletion: false,
  subagent: false,
};

const NO_WORK: PeerAuditWorkState = {
  foreground: false,
  background: false,
  pendingCompletion: false,
  subagent: false,
};

function hasBlockingWork(work: PeerAuditWorkState): boolean {
  return work.foreground || work.background || work.pendingCompletion || work.subagent;
}

export interface PeerAuditBaselineTrackerOptions {
  createBaselineId?: () => string;
}

/**
 * Ephemeral daemon authority for atomic user-task/result pairs. The tracker
 * deliberately has no persistence API: constructing it after restart starts
 * empty, so an old terminal result can never be audited as a fresh baseline.
 */
export class PeerAuditBaselineTracker {
  readonly #states = new Map<string, SessionBaselineState>();
  readonly #createBaselineId: () => string;

  constructor(options: PeerAuditBaselineTrackerOptions = {}) {
    this.#createBaselineId = options.createBaselineId ?? randomUUID;
  }

  #state(sessionName: string): SessionBaselineState {
    const current = this.#states.get(sessionName);
    if (current) return current;
    const created: SessionBaselineState = {
      offModeEpoch: 0,
      work: { ...NO_WORK },
    };
    this.#states.set(sessionName, created);
    return created;
  }

  beginTopLevelIntent(input: {
    sessionName: string;
    auditedSessionInstanceId: string;
    auditedRuntimeEpoch: string;
    taskCommandId: string;
    userText: string;
    generationOrEpoch?: number;
  }): number {
    const state = this.#state(input.sessionName);
    state.completed = undefined;
    state.lastInvalidationReason = 'new_intent';
    const generationOrEpoch = input.generationOrEpoch ?? state.offModeEpoch + 1;
    if (input.generationOrEpoch === undefined) state.offModeEpoch = generationOrEpoch;
    state.pending = {
      auditedSessionInstanceId: input.auditedSessionInstanceId,
      auditedRuntimeEpoch: input.auditedRuntimeEpoch,
      taskCommandId: input.taskCommandId,
      generationOrEpoch,
      userText: input.userText,
    };
    state.work = { ...ACTIVE_FOREGROUND };
    return generationOrEpoch;
  }

  recordTerminalTopLevelResult(input: {
    sessionName: string;
    auditedSessionInstanceId: string;
    auditedRuntimeEpoch: string;
    taskCommandId: string;
    generationOrEpoch: number;
    assistantText: string;
    completedEventId: string;
    completedAt: number;
    terminal: boolean;
    topLevel: boolean;
    supervisorRationale?: string;
  }): CompletedAuditBaseline | undefined {
    const state = this.#states.get(input.sessionName);
    const pending = state?.pending;
    if (!state || !pending || !input.terminal || !input.topLevel) return undefined;
    if (pending.taskCommandId !== input.taskCommandId
      || pending.generationOrEpoch !== input.generationOrEpoch
      || pending.auditedSessionInstanceId !== input.auditedSessionInstanceId
      || pending.auditedRuntimeEpoch !== input.auditedRuntimeEpoch) {
      return undefined;
    }
    if (pending.terminalResult
      || pending.userText.trim().length === 0
      || input.assistantText.trim().length === 0
      || input.completedEventId.trim().length === 0) {
      return undefined;
    }
    pending.terminalResult = {
      assistantText: input.assistantText,
      completedEventId: input.completedEventId,
      completedAt: input.completedAt,
      ...(input.supervisorRationale ? { supervisorRationale: input.supervisorRationale } : {}),
    };
    return this.#commitIfStable(input.sessionName, state);
  }

  updateWorkState(sessionName: string, work: PeerAuditWorkState): CompletedAuditBaseline | undefined {
    const state = this.#state(sessionName);
    state.work = { ...work };
    if (hasBlockingWork(work) && state.completed) {
      state.completed = undefined;
      state.lastInvalidationReason = 'work_resumed';
    }
    return this.#commitIfStable(sessionName, state);
  }

  #commitIfStable(sessionName: string, state: SessionBaselineState): CompletedAuditBaseline | undefined {
    const pending = state.pending;
    if (!pending?.terminalResult || hasBlockingWork(state.work)) return undefined;
    const baseline: CompletedAuditBaseline = {
      baselineId: this.#createBaselineId(),
      auditedSessionInstanceId: pending.auditedSessionInstanceId,
      auditedRuntimeEpoch: pending.auditedRuntimeEpoch,
      taskCommandId: pending.taskCommandId,
      generationOrEpoch: pending.generationOrEpoch,
      userText: pending.userText,
      assistantText: pending.terminalResult.assistantText,
      completedEventId: pending.terminalResult.completedEventId,
      completedAt: pending.terminalResult.completedAt,
      ...(pending.terminalResult.supervisorRationale
        ? { supervisorRationale: pending.terminalResult.supervisorRationale }
        : {}),
    };
    state.pending = undefined;
    state.completed = baseline;
    state.lastInvalidationReason = undefined;
    this.#states.set(sessionName, state);
    return baseline;
  }

  getCompletedBaseline(input: {
    sessionName: string;
    auditedSessionInstanceId: string;
    auditedRuntimeEpoch: string;
  }): CompletedAuditBaseline | undefined {
    const state = this.#states.get(input.sessionName);
    const baseline = state?.completed;
    if (!baseline) return undefined;
    if (baseline.auditedSessionInstanceId !== input.auditedSessionInstanceId
      || baseline.auditedRuntimeEpoch !== input.auditedRuntimeEpoch
      || hasBlockingWork(state.work)) {
      return undefined;
    }
    return baseline;
  }

  getOffModeEpoch(sessionName: string): number {
    return this.#states.get(sessionName)?.offModeEpoch ?? 0;
  }

  getLastInvalidationReason(sessionName: string): PeerAuditBaselineInvalidationReason | undefined {
    return this.#states.get(sessionName)?.lastInvalidationReason;
  }

  invalidate(sessionName: string, reason: PeerAuditBaselineInvalidationReason): boolean {
    const state = this.#states.get(sessionName);
    if (!state) return false;
    const changed = Boolean(state.pending || state.completed);
    state.pending = undefined;
    state.completed = undefined;
    state.lastInvalidationReason = reason;
    state.work = { ...NO_WORK };
    return changed;
  }

  queuedEdit(sessionName: string): boolean {
    return this.invalidate(sessionName, 'queued_edit');
  }

  stop(sessionName: string): boolean {
    return this.invalidate(sessionName, 'stop');
  }

  cancel(sessionName: string): boolean {
    return this.invalidate(sessionName, 'cancel');
  }

  replaceSession(sessionName: string): boolean {
    return this.invalidate(sessionName, 'session_replaced');
  }

  replaceRuntime(sessionName: string): boolean {
    return this.invalidate(sessionName, 'runtime_replaced');
  }

  deleteSession(sessionName: string): boolean {
    const existed = this.#states.has(sessionName);
    this.#states.delete(sessionName);
    return existed;
  }

  resetForDaemonRestart(): void {
    this.#states.clear();
  }
}
