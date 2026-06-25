import { P2P_TERMINAL_RUN_STATUSES, type P2pRunStatus } from '../../shared/p2p-status.js';

export type P2pLaunchOriginKind = 'manual' | 'cron' | 'supervision' | 'openspec_auto_deliver';

export interface P2pAutoDeliverLaunchMetadata {
  runId: string;
  changeName: string;
  owningMainSessionName: string;
  generation: number;
  stage: string;
  roundIndex?: number;
  attemptId?: string;
  authoritativeResultPath?: string;
  selectedTeamComboId?: string;
  activeOpenSpecPromptId?: string;
}

export interface P2pLaunchOrigin {
  kind: P2pLaunchOriginKind;
  commandId?: string;
  cronJobId?: string;
  cronExecutionId?: string;
  supervisionRunId?: string;
  autoDeliver?: P2pAutoDeliverLaunchMetadata;
}

export interface P2pAdmissionRunSnapshot {
  id: string;
  mainSession: string;
  initiatorSession: string;
  status: P2pRunStatus;
  launchOrigin?: P2pLaunchOrigin;
}

export interface AutoDeliverP2pLock {
  runId: string;
  owningMainSessionName: string;
  generation: number;
  stage?: string;
  roundIndex?: number;
  selectedTeamComboId?: string;
  activeOpenSpecPromptId?: string;
}

export interface P2pLaunchAdmissionInput {
  mainSession: string;
  origin?: P2pLaunchOrigin;
  activeRuns: readonly P2pAdmissionRunSnapshot[];
}

export type P2pLaunchAdmissionResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'auto_deliver_active';
      activeAutoDeliverRunId: string;
      owningMainSessionName: string;
    };

const activeAutoDeliverLocks = new Map<string, AutoDeliverP2pLock>();

export function registerAutoDeliverP2pLock(lock: AutoDeliverP2pLock): void {
  activeAutoDeliverLocks.set(lock.owningMainSessionName, {
    ...lock,
  });
}

export function releaseAutoDeliverP2pLock(owningMainSessionName: string, runId?: string): boolean {
  const existing = activeAutoDeliverLocks.get(owningMainSessionName);
  if (!existing) return false;
  if (runId && existing.runId !== runId) return false;
  activeAutoDeliverLocks.delete(owningMainSessionName);
  return true;
}

export function getAutoDeliverP2pLock(owningMainSessionName: string): AutoDeliverP2pLock | undefined {
  const existing = activeAutoDeliverLocks.get(owningMainSessionName);
  return existing ? { ...existing } : undefined;
}

export function clearAutoDeliverP2pLocksForTests(): void {
  activeAutoDeliverLocks.clear();
}

export function evaluateP2pLaunchAdmission(input: P2pLaunchAdmissionInput): P2pLaunchAdmissionResult {
  const lock = activeAutoDeliverLocks.get(input.mainSession);
  if (!lock) return { ok: true };

  const autoDeliver = input.origin?.kind === 'openspec_auto_deliver'
    ? input.origin.autoDeliver
    : undefined;
  if (
    autoDeliver
    && autoDeliver.runId === lock.runId
    && autoDeliver.owningMainSessionName === lock.owningMainSessionName
    && autoDeliver.generation === lock.generation
    && lock.stage !== undefined
    && autoDeliver.stage === lock.stage
    && lock.roundIndex !== undefined
    && autoDeliver.roundIndex === lock.roundIndex
    && lock.selectedTeamComboId !== undefined
    && autoDeliver.selectedTeamComboId === lock.selectedTeamComboId
    && lock.activeOpenSpecPromptId !== undefined
    && autoDeliver.activeOpenSpecPromptId === lock.activeOpenSpecPromptId
  ) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: 'auto_deliver_active',
    activeAutoDeliverRunId: lock.runId,
    owningMainSessionName: lock.owningMainSessionName,
  };
}

export function sanitizeP2pLaunchOriginForProjection(origin: P2pLaunchOrigin | undefined): Record<string, unknown> | undefined {
  if (!origin) return undefined;
  const base: Record<string, unknown> = { kind: origin.kind };
  if (origin.commandId) base.commandId = origin.commandId;
  if (origin.cronJobId) base.cronJobId = origin.cronJobId;
  if (origin.cronExecutionId) base.cronExecutionId = origin.cronExecutionId;
  if (origin.supervisionRunId) base.supervisionRunId = origin.supervisionRunId;
  if (origin.autoDeliver) {
    base.autoDeliver = {
      runId: origin.autoDeliver.runId,
      changeName: origin.autoDeliver.changeName,
      owningMainSessionName: origin.autoDeliver.owningMainSessionName,
      generation: origin.autoDeliver.generation,
      stage: origin.autoDeliver.stage,
      ...(origin.autoDeliver.roundIndex != null ? { roundIndex: origin.autoDeliver.roundIndex } : {}),
      ...(origin.autoDeliver.attemptId ? { attemptId: origin.autoDeliver.attemptId } : {}),
      ...(origin.autoDeliver.authoritativeResultPath ? { authoritativeResultPath: origin.autoDeliver.authoritativeResultPath } : {}),
      ...(origin.autoDeliver.selectedTeamComboId ? { selectedTeamComboId: origin.autoDeliver.selectedTeamComboId } : {}),
      ...(origin.autoDeliver.activeOpenSpecPromptId ? { activeOpenSpecPromptId: origin.autoDeliver.activeOpenSpecPromptId } : {}),
    };
  }
  return base;
}

export function hasActiveP2pRunForMainSession(
  activeRuns: readonly P2pAdmissionRunSnapshot[],
  mainSession: string,
): boolean {
  return activeRuns.some((run) => run.mainSession === mainSession && !P2P_TERMINAL_RUN_STATUSES.has(run.status));
}
