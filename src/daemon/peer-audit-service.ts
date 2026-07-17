import { createHash, randomBytes } from 'node:crypto';
import {
  PEER_AUDIT_CONFIG_ERRORS,
  PEER_AUDIT_COMMAND_ERRORS,
  PEER_AUDIT_COMPLETED_TURN_PAYLOAD_FIELD,
  PEER_AUDIT_PROMPT_VERSION,
  PEER_AUDIT_PREFLIGHT_ERRORS,
  PEER_AUDIT_REPLY_ERRORS,
  type PeerAuditCancelCommand,
  type PeerAuditCandidateList,
  type PeerAuditListCandidatesCommand,
  type PeerAuditQuickStartCommand,
  type PeerAuditReplyError,
  type PeerAuditReplyEnvelope,
  type PeerAuditValidationItem,
  type PeerAuditCompletedTurnEvidence,
} from '../../shared/peer-audit.js';
import {
  patchPeerAuditTargetInTransportConfig,
  readSupervisionSnapshotFromTransportConfig,
} from '../../shared/supervision-config.js';
import { persistSessionRecord } from '../agent/session-manager.js';
import { getTransportRuntime } from '../agent/session-manager.js';
import { getSession, listSessions, upsertSession, type SessionRecord } from '../store/session-store.js';
import type { TimelineEvent } from './timeline-event.js';
import { timelineEmitter } from './timeline-emitter.js';
import { PeerAuditBaselineTracker, type CompletedAuditBaseline, type PeerAuditWorkState } from './peer-audit-baseline.js';
import {
  revalidatePeerAuditCandidateSelection,
  resolvePeerAuditCandidateList,
  resolvePeerAuditNormalizedModelId,
  resolvePeerAuditTargetConfigRevision,
} from './peer-audit-candidates.js';
import {
  PeerAuditController,
  type PeerAuditControllerEffect,
  type PeerAuditTerminalRecord,
} from './peer-audit-controller.js';
import {
  peerAuditCapabilityMatches,
  processPeerAuditReplyAuthority,
  registerPeerAuditReplyIngressHandler,
} from './peer-audit-reply-ingress.js';
import { emitPeerAuditResult, emitPeerAuditStatus, peerAuditResultEventId } from './peer-audit-result.js';
import { buildPeerAuditBriefV1 } from './supervision-prompts.js';
import { cancelQueuedPeerAuditMessage, dispatchPeerAuditMessage } from './session-dispatch.js';

interface AttemptContext {
  brief: string;
  auditorSessionName: string;
  auditorLabel: string;
  baselineId: string;
  targetConfigRevision: string;
  candidateRevision: string;
  baselineValid: () => boolean;
  onAutomaticTerminal?: (terminal: PeerAuditTerminalRecord) => void;
}

type PeerAuditListCandidatesResult =
  | { ok: true; list: PeerAuditCandidateList }
  | { ok: false; error: string };

type PeerAuditQuickStartResult =
  | { ok: true; attemptId: string; resultEventId: string }
  | { ok: false; error: PeerAuditServiceError };

type PeerAuditCancelResult = { ok: boolean; error?: PeerAuditServiceError };

const PEER_AUDIT_COMMAND_REPLAY_CAPACITY = 1024;

function commandReplayKey(command: { commandId: string; auditedSessionInstanceId: string }): string {
  return `${command.auditedSessionInstanceId}:${command.commandId}`;
}

function rememberBoundedCommand<T>(map: Map<string, T>, key: string, value: T): T {
  map.set(key, value);
  while (map.size > PEER_AUDIT_COMMAND_REPLAY_CAPACITY) {
    const oldest = map.keys().next().value as string | undefined;
    if (!oldest) break;
    map.delete(oldest);
  }
  return value;
}

export interface StartAutomaticPeerAuditInput {
  audited: SessionRecord;
  taskCommandId: string;
  generationOrEpoch: number;
  userText: string;
  assistantText: string;
  completedAt?: number;
  supervisorRationale?: string;
  changePath?: string;
  changedPaths?: readonly string[];
  validations?: readonly PeerAuditValidationItem[];
  isStillValid: () => boolean;
  onTerminal: (terminal: PeerAuditTerminalRecord) => void;
}

interface ObservedBaselineTurn {
  taskCommandId: string;
  generationOrEpoch: number;
  auditedSessionInstanceId: string;
  auditedRuntimeEpoch: string;
}

export type PeerAuditServiceError =
  | typeof PEER_AUDIT_PREFLIGHT_ERRORS[keyof typeof PEER_AUDIT_PREFLIGHT_ERRORS]
  | typeof PEER_AUDIT_CONFIG_ERRORS[keyof typeof PEER_AUDIT_CONFIG_ERRORS]
  | typeof PEER_AUDIT_COMMAND_ERRORS.AUDITED_SESSION_UNAVAILABLE
  | typeof PEER_AUDIT_COMMAND_ERRORS.AUDITED_IDENTITY_CHANGED;

function opaqueId(): string {
  return randomBytes(24).toString('base64url');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function targetConfigRevision(record: SessionRecord): string {
  return resolvePeerAuditTargetConfigRevision(record);
}

export class PeerAuditService {
  readonly baseline = new PeerAuditBaselineTracker();
  readonly #controllers = new Map<string, PeerAuditController>();
  readonly #attemptToSession = new Map<string, string>();
  readonly #contexts = new Map<string, AttemptContext>();
  readonly #observedTurns = new Map<string, Map<string, ObservedBaselineTurn>>();
  readonly #listCommandResults = new Map<string, PeerAuditListCandidatesResult>();
  readonly #quickCommandResults = new Map<string, Promise<PeerAuditQuickStartResult>>();
  readonly #cancelCommandResults = new Map<string, PeerAuditCancelResult>();
  #timelineUnsubscribe?: () => void;

  constructor() {
    registerPeerAuditReplyIngressHandler((input) => this.acceptReply(input.envelope, input.sender, input.receivedAt));
  }

  /**
   * Attach the off-mode baseline authority to the real timeline exactly once.
   * This is deliberately explicit instead of a constructor side effect so
   * unit tests importing the service do not mutate the global event bus.
   */
  init(): void {
    if (this.#timelineUnsubscribe) return;
    this.baseline.resetForDaemonRestart();
    this.#observedTurns.clear();
    this.#timelineUnsubscribe = timelineEmitter.on((event) => this.#observeTimelineEvent(event));
  }

  shutdown(): void {
    this.#timelineUnsubscribe?.();
    this.#timelineUnsubscribe = undefined;
    for (const controller of this.#controllers.values()) controller.shutdown();
    this.#controllers.clear();
    this.#attemptToSession.clear();
    this.#contexts.clear();
    this.#listCommandResults.clear();
    this.#quickCommandResults.clear();
    this.#cancelCommandResults.clear();
    this.#observedTurns.clear();
    this.baseline.resetForDaemonRestart();
    registerPeerAuditReplyIngressHandler(null);
  }

  #observeTimelineEvent(event: TimelineEvent): void {
    const payload = event.payload as Record<string, unknown>;
    if (event.type === 'transport.queue.delivery') {
      const messageId = typeof payload.clientMessageId === 'string' ? payload.clientMessageId : '';
      const queueEpoch = typeof payload.queueEpoch === 'string' ? payload.queueEpoch : '';
      if (!messageId || !queueEpoch) return;
      for (const [auditedSessionName, controller] of this.#controllers) {
        const pending = controller.pending;
        if (!pending || pending.phase !== 'queued' || pending.messageId !== messageId
          || pending.queueEpoch !== queueEpoch || pending.auditorSessionName !== event.sessionId) continue;
        const target = getSession(event.sessionId);
        if (!target?.sessionInstanceId || !target.runtimeEpoch) {
          controller.dispatchFailed({
            attemptId: pending.attemptId,
            effectRevision: pending.revision,
            reason: 'queued_target_identity_changed',
          });
          return;
        }
        const transitioned = controller.queueDelivered({
          attemptId: pending.attemptId,
          effectRevision: pending.revision,
          targetSessionInstanceId: target.sessionInstanceId,
          targetRuntimeEpoch: target.runtimeEpoch,
        });
        if (transitioned.status === 'applied' && transitioned.pending) {
          this.#emitStatus(auditedSessionName, transitioned.pending, 'queue_delivered');
        }
        return;
      }
      return;
    }
    if (event.type === 'user.message') {
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (!text || text.startsWith('/') || payload.automation === true || payload.memoryExcluded === true) return;
      const record = getSession(event.sessionId);
      if (!record?.sessionInstanceId || !record.runtimeEpoch) return;
      const taskCommandId = typeof payload.clientMessageId === 'string' && payload.clientMessageId.trim()
        ? payload.clientMessageId.trim()
        : event.eventId;
      const generationOrEpoch = this.beginTopLevelIntent(record, taskCommandId, text);
      if (generationOrEpoch === undefined) return;
      const turns = this.#observedTurns.get(event.sessionId) ?? new Map<string, ObservedBaselineTurn>();
      turns.set(taskCommandId, {
        taskCommandId,
        generationOrEpoch,
        auditedSessionInstanceId: record.sessionInstanceId,
        auditedRuntimeEpoch: record.runtimeEpoch,
      });
      while (turns.size > 32) {
        const oldest = turns.keys().next().value as string | undefined;
        if (!oldest) break;
        turns.delete(oldest);
      }
      this.#observedTurns.set(event.sessionId, turns);
      return;
    }

    if (event.type !== 'session.state') return;
    const state = typeof payload.state === 'string' ? payload.state : '';
    this.#revalidatePendingSessionIdentity(event.sessionId, state);
    if (state === 'stopping' || state === 'stopped' || state === 'error') {
      this.baseline.stop(event.sessionId);
      this.#controllers.get(event.sessionId)?.baselineInvalidated(`audited_session_${state}`);
      this.#observedTurns.delete(event.sessionId);
      return;
    }
    const evidence = this.#parseCompletedTurnEvidence(payload[PEER_AUDIT_COMPLETED_TURN_PAYLOAD_FIELD]);
    if (!evidence) return;
    const turns = this.#observedTurns.get(event.sessionId);
    const observed = turns?.get(evidence.taskCommandId);
    if (!observed) return;
    const record = getSession(event.sessionId);
    if (!record || record.sessionInstanceId !== observed.auditedSessionInstanceId) {
      this.baseline.replaceSession(event.sessionId);
      turns?.delete(evidence.taskCommandId);
      return;
    }
    if (record.runtimeEpoch !== observed.auditedRuntimeEpoch) {
      this.baseline.replaceRuntime(event.sessionId);
      turns?.delete(evidence.taskCommandId);
      return;
    }
    const runtime = getTransportRuntime(event.sessionId);
    const diagnostics = runtime?.getDiagnosticSnapshot();
    const hasSubagent = diagnostics?.busyReasons.includes('provider_background') ?? false;
    const work: PeerAuditWorkState = {
      foreground: state !== 'idle' || (diagnostics?.blockingWorkCount ?? 0) > 0,
      background: hasSubagent,
      pendingCompletion: (diagnostics?.pendingCount ?? 0) > 0 || (diagnostics?.activeDispatchCount ?? 0) > 0,
      subagent: hasSubagent || (diagnostics?.activeToolCount ?? 0) > 0,
    };
    this.updateWorkState(event.sessionId, work);
    if (state !== 'idle') return;
    this.recordTerminalResult({
      sessionName: event.sessionId,
      auditedSessionInstanceId: observed.auditedSessionInstanceId,
      auditedRuntimeEpoch: observed.auditedRuntimeEpoch,
      taskCommandId: observed.taskCommandId,
      generationOrEpoch: observed.generationOrEpoch,
      assistantText: evidence.assistantText,
      completedEventId: evidence.completedEventId,
      completedAt: evidence.completedAt,
      terminal: true,
      topLevel: true,
    });
    this.updateWorkState(event.sessionId, work);
    if (!work.foreground && !work.background && !work.pendingCompletion && !work.subagent) {
      turns?.delete(evidence.taskCommandId);
      if (turns?.size === 0) this.#observedTurns.delete(event.sessionId);
    }
  }

  #parseCompletedTurnEvidence(value: unknown): PeerAuditCompletedTurnEvidence | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => ![
      'taskCommandId', 'assistantText', 'completedEventId', 'completedAt', 'generationOrEpoch',
    ].includes(key))) return null;
    if (typeof record.taskCommandId !== 'string' || !record.taskCommandId.trim()
      || typeof record.assistantText !== 'string' || !record.assistantText.trim()
      || typeof record.completedEventId !== 'string' || !record.completedEventId.trim()
      || typeof record.completedAt !== 'number' || !Number.isFinite(record.completedAt)
      || typeof record.generationOrEpoch !== 'number' || !Number.isSafeInteger(record.generationOrEpoch)
      || record.generationOrEpoch < 0) return null;
    return {
      taskCommandId: record.taskCommandId,
      assistantText: record.assistantText,
      completedEventId: record.completedEventId,
      completedAt: record.completedAt,
      generationOrEpoch: record.generationOrEpoch,
    };
  }

  #controller(sessionName: string): PeerAuditController {
    const existing = this.#controllers.get(sessionName);
    if (existing) return existing;
    const controller = new PeerAuditController(sessionName, {
      onEffects: (effects) => { void this.#applyEffects(sessionName, effects); },
    });
    this.#controllers.set(sessionName, controller);
    return controller;
  }

  #revalidatePendingSessionIdentity(sessionName: string, state: string): void {
    const current = getSession(sessionName);
    for (const controller of this.#controllers.values()) {
      const pending = controller.pending;
      if (!pending) continue;
      if (pending.auditedSessionName === sessionName) {
        if (!current || current.sessionInstanceId !== pending.auditedSessionInstanceId
          || current.runtimeEpoch !== pending.auditedRuntimeEpoch) {
          controller.baselineInvalidated(PEER_AUDIT_COMMAND_ERRORS.AUDITED_IDENTITY_CHANGED);
        }
        continue;
      }
      if (pending.auditorSessionName !== sessionName) continue;
      if (!current || current.sessionInstanceId !== pending.auditorSessionInstanceId
        || current.runtimeEpoch !== pending.auditorRuntimeEpoch
        || state === 'stopping' || state === 'stopped' || state === 'error') {
        controller.targetInvalidated('auditor_identity_or_state_changed');
      }
    }
  }

  listCandidates(command: PeerAuditListCandidatesCommand): PeerAuditListCandidatesResult {
    const replayKey = commandReplayKey(command);
    const replay = this.#listCommandResults.get(replayKey);
    if (replay) return replay;
    const audited = getSession(command.auditedSessionName);
    if (!audited) return rememberBoundedCommand(this.#listCommandResults, replayKey, { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.AUDITED_SESSION_UNAVAILABLE });
    if (audited.sessionInstanceId !== command.auditedSessionInstanceId) {
      return rememberBoundedCommand(this.#listCommandResults, replayKey, { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.AUDITED_IDENTITY_CHANGED });
    }
    const result = resolvePeerAuditCandidateList({
      auditedSessionName: command.auditedSessionName,
      allSessions: listSessions(),
    });
    return rememberBoundedCommand(
      this.#listCommandResults,
      replayKey,
      result.ok ? { ok: true, list: result.list } : { ok: false, error: result.error },
    );
  }

  startQuick(command: PeerAuditQuickStartCommand): Promise<PeerAuditQuickStartResult> {
    const replayKey = commandReplayKey(command);
    const replay = this.#quickCommandResults.get(replayKey);
    if (replay) return replay;
    return rememberBoundedCommand(this.#quickCommandResults, replayKey, this.#startQuick(command));
  }

  async #startQuick(command: PeerAuditQuickStartCommand): Promise<PeerAuditQuickStartResult> {
    const audited = getSession(command.auditedSessionName);
    if (!audited) return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.AUDITED_SESSION_UNAVAILABLE };
    if (audited.sessionInstanceId !== command.auditedSessionInstanceId || !audited.runtimeEpoch) {
      return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.AUDITED_IDENTITY_CHANGED };
    }
    const baseline = this.baseline.getCompletedBaseline({
      sessionName: audited.name,
      auditedSessionInstanceId: audited.sessionInstanceId,
      auditedRuntimeEpoch: audited.runtimeEpoch,
    });
    if (!baseline) return { ok: false, error: PEER_AUDIT_PREFLIGHT_ERRORS.BASELINE_NO_RESULT };

    const selection = revalidatePeerAuditCandidateSelection({
      auditedSessionName: audited.name,
      targetSessionName: command.target.auditorSessionName,
      targetSessionInstanceId: command.target.auditorSessionInstanceId,
      targetRuntimeEpoch: command.target.auditorRuntimeEpoch,
      expectedRevision: command.candidateRevision,
      allSessions: listSessions(),
    });
    if (!selection.ok) return { ok: false, error: selection.error };
    const candidate = selection.candidate;
    const candidateModelKnown = candidate.normalizedModelId !== 'unknown';
    if (command.selectionIntent === 'remembered_fast_path') {
      const auditedModel = resolvePeerAuditNormalizedModelId(audited);
      const remembered = readSupervisionSnapshotFromTransportConfig(audited.transportConfig);
      const fingerprint = remembered.auditTargetFingerprint;
      if (remembered.auditTargetSessionName !== candidate.name
        || !fingerprint
        || fingerprint.sessionInstanceId !== candidate.sessionInstanceId
        || fingerprint.normalizedModelId !== candidate.normalizedModelId
        || fingerprint.providerFamily !== candidate.providerFamily) {
        return { ok: false, error: PEER_AUDIT_PREFLIGHT_ERRORS.CANDIDATE_REFRESH_REQUIRED };
      }
      if (!candidateModelKnown || auditedModel === 'unknown' || candidate.normalizedModelId === auditedModel) {
        return { ok: false, error: PEER_AUDIT_PREFLIGHT_ERRORS.MODEL_NOT_DIFFERENT };
      }
    }

    // A failed/busy Quick start must not persist a target selection. Install
    // the no-pending preflight before the target-only CAS/write below.
    if (this.#controller(audited.name).pending) {
      return { ok: false, error: PEER_AUDIT_PREFLIGHT_ERRORS.PEER_AUDIT_BUSY };
    }

    const latest = getSession(audited.name);
    if (!latest || latest.sessionInstanceId !== audited.sessionInstanceId) {
      return { ok: false, error: PEER_AUDIT_CONFIG_ERRORS.CONFIG_CONFLICT };
    }
    if (targetConfigRevision(latest) !== command.targetConfigRevision) {
      return { ok: false, error: PEER_AUDIT_CONFIG_ERRORS.CONFIG_CONFLICT };
    }
    const nextRecord: SessionRecord = {
      ...latest,
      transportConfig: patchPeerAuditTargetInTransportConfig(latest.transportConfig, {
        auditTargetSessionName: candidate.name,
        auditTargetFingerprint: {
          sessionInstanceId: candidate.sessionInstanceId,
          normalizedModelId: candidate.normalizedModelId,
          providerFamily: candidate.providerFamily,
        },
      }),
      updatedAt: Date.now(),
    };
    upsertSession(nextRecord);
    persistSessionRecord(nextRecord, nextRecord.name);

    const attemptId = opaqueId();
    const capability = randomBytes(32).toString('base64url');
    const configRevision = targetConfigRevision(nextRecord);
    const brief = this.#buildBrief(baseline, attemptId, capability, nextRecord);
    this.#contexts.set(attemptId, {
      brief,
      auditorSessionName: candidate.name,
      auditorLabel: candidate.label,
      baselineId: baseline.baselineId,
      targetConfigRevision: configRevision,
      candidateRevision: command.candidateRevision,
      baselineValid: () => this.baseline.getCompletedBaseline({
        sessionName: nextRecord.name,
        auditedSessionInstanceId: nextRecord.sessionInstanceId!,
        auditedRuntimeEpoch: nextRecord.runtimeEpoch!,
      })?.baselineId === baseline.baselineId,
    });
    this.#attemptToSession.set(attemptId, audited.name);
    const requested = this.#controller(audited.name).request({
      attemptId,
      trigger: 'quick',
      baselineId: baseline.baselineId,
      candidateRevision: command.candidateRevision,
      targetConfigRevision: configRevision,
      auditedSessionName: audited.name,
      auditedSessionInstanceId: audited.sessionInstanceId,
      auditedRuntimeEpoch: audited.runtimeEpoch,
      auditorSessionName: candidate.name,
      auditorSessionInstanceId: candidate.sessionInstanceId,
      auditorRuntimeEpoch: candidate.runtimeEpoch,
      selectionIntent: command.selectionIntent,
      capabilityHash: hash(capability),
    });
    if (requested.status !== 'started') {
      this.#contexts.delete(attemptId);
      this.#attemptToSession.delete(attemptId);
      return { ok: false, error: PEER_AUDIT_PREFLIGHT_ERRORS.PEER_AUDIT_BUSY };
    }
    return { ok: true, attemptId, resultEventId: peerAuditResultEventId(attemptId) };
  }

  async startAutomatic(input: StartAutomaticPeerAuditInput): Promise<
    | { ok: true; attemptId: string; awaitingSlot: boolean }
    | { ok: false; error: PeerAuditServiceError }
  > {
    const audited = getSession(input.audited.name);
    if (!audited?.sessionInstanceId || !audited.runtimeEpoch
      || audited.sessionInstanceId !== input.audited.sessionInstanceId
      || audited.runtimeEpoch !== input.audited.runtimeEpoch) {
      return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.AUDITED_IDENTITY_CHANGED };
    }
    const snapshot = readSupervisionSnapshotFromTransportConfig(audited.transportConfig);
    const targetName = snapshot.auditTargetSessionName;
    const fingerprint = snapshot.auditTargetFingerprint;
    if (!targetName || !fingerprint || snapshot.peerAuditPromptVersion !== PEER_AUDIT_PROMPT_VERSION) {
      return { ok: false, error: PEER_AUDIT_CONFIG_ERRORS.MISSING_TARGET_FINGERPRINT };
    }
    const candidateList = resolvePeerAuditCandidateList({ auditedSessionName: audited.name, allSessions: listSessions() });
    if (!candidateList.ok) return { ok: false, error: PEER_AUDIT_PREFLIGHT_ERRORS.TARGET_INELIGIBLE };
    const candidate = candidateList.list.candidates.find((entry) => entry.name === targetName
      && entry.sessionInstanceId === fingerprint.sessionInstanceId
      && entry.normalizedModelId === fingerprint.normalizedModelId
      && entry.providerFamily === fingerprint.providerFamily);
    if (!candidate?.eligible) return { ok: false, error: PEER_AUDIT_PREFLIGHT_ERRORS.TARGET_INELIGIBLE };

    const baseline: CompletedAuditBaseline = {
      baselineId: hash(JSON.stringify({
        sessionInstanceId: audited.sessionInstanceId,
        runtimeEpoch: audited.runtimeEpoch,
        taskCommandId: input.taskCommandId,
        generationOrEpoch: input.generationOrEpoch,
        assistantText: input.assistantText,
      })),
      auditedSessionInstanceId: audited.sessionInstanceId,
      auditedRuntimeEpoch: audited.runtimeEpoch,
      taskCommandId: input.taskCommandId,
      generationOrEpoch: input.generationOrEpoch,
      userText: input.userText,
      assistantText: input.assistantText,
      completedEventId: `supervision:${audited.name}:${input.generationOrEpoch}`,
      completedAt: input.completedAt ?? Date.now(),
      ...(input.supervisorRationale ? { supervisorRationale: input.supervisorRationale } : {}),
    };
    const attemptId = opaqueId();
    const capability = randomBytes(32).toString('base64url');
    const configRevision = targetConfigRevision(audited);
    const context: AttemptContext = {
      brief: this.#buildBrief(baseline, attemptId, capability, audited, {
        changePath: input.changePath,
        changedPaths: input.changedPaths,
        validations: input.validations,
      }),
      auditorSessionName: candidate.name,
      auditorLabel: candidate.label,
      baselineId: baseline.baselineId,
      targetConfigRevision: configRevision,
      candidateRevision: candidateList.list.revision,
      baselineValid: input.isStillValid,
      onAutomaticTerminal: input.onTerminal,
    };
    this.#contexts.set(attemptId, context);
    this.#attemptToSession.set(attemptId, audited.name);
    const request = {
      attemptId,
      trigger: 'automatic' as const,
      baselineId: baseline.baselineId,
      candidateRevision: candidateList.list.revision,
      targetConfigRevision: configRevision,
      auditedSessionName: audited.name,
      auditedSessionInstanceId: audited.sessionInstanceId,
      auditedRuntimeEpoch: audited.runtimeEpoch,
      auditorSessionName: candidate.name,
      auditorSessionInstanceId: candidate.sessionInstanceId,
      auditorRuntimeEpoch: candidate.runtimeEpoch,
      selectionIntent: 'remembered_fast_path' as const,
      capabilityHash: hash(capability),
    };
    const requested = this.#controller(audited.name).request(request, {
      // A repeated automatic evaluation for the same completed baseline is
      // the same waiter, not a second queued audit.
      waiterId: baseline.baselineId,
      generationOrEpoch: input.generationOrEpoch,
      baselineId: baseline.baselineId,
      configRevision,
      targetRevision: candidateList.list.revision,
    });
    if (requested.status === 'busy') {
      this.#contexts.delete(attemptId);
      this.#attemptToSession.delete(attemptId);
      return { ok: false, error: PEER_AUDIT_PREFLIGHT_ERRORS.PEER_AUDIT_BUSY };
    }
    if (requested.status === 'duplicate' && requested.kind === 'automatic_waiter') {
      this.#contexts.delete(attemptId);
      this.#attemptToSession.delete(attemptId);
      return {
        ok: true,
        attemptId: requested.waiter.request.attemptId,
        awaitingSlot: true,
      };
    }
    if (requested.status === 'duplicate') {
      this.#contexts.delete(attemptId);
      this.#attemptToSession.delete(attemptId);
      return { ok: false, error: PEER_AUDIT_PREFLIGHT_ERRORS.ATTEMPT_NOT_FOUND };
    }
    return { ok: true, attemptId, awaitingSlot: requested.status === 'awaiting_slot' };
  }

  cancel(command: PeerAuditCancelCommand): PeerAuditCancelResult {
    const replayKey = commandReplayKey(command);
    const replay = this.#cancelCommandResults.get(replayKey);
    if (replay) return replay;
    const record = getSession(command.auditedSessionName);
    if (!record || record.sessionInstanceId !== command.auditedSessionInstanceId) {
      return rememberBoundedCommand(this.#cancelCommandResults, replayKey, { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.AUDITED_IDENTITY_CHANGED });
    }
    const controller = this.#controllers.get(command.auditedSessionName);
    if (!controller?.pending || controller.pending.attemptId !== command.attemptId) {
      return rememberBoundedCommand(this.#cancelCommandResults, replayKey, { ok: false, error: PEER_AUDIT_PREFLIGHT_ERRORS.ATTEMPT_NOT_FOUND });
    }
    controller.cancel({ attemptId: command.attemptId, reason: 'user_cancelled' });
    return rememberBoundedCommand(this.#cancelCommandResults, replayKey, { ok: true });
  }

  cancelAutomatic(sessionName: string, reason: string): void {
    const controller = this.#controllers.get(sessionName);
    if (controller?.pending?.trigger === 'automatic') {
      controller.cancel({ attemptId: controller.pending.attemptId, reason });
    }
  }

  applyAutomaticConfiguration(sessionName: string, runnable: boolean): void {
    const controller = this.#controllers.get(sessionName);
    if (!controller) return;
    const current = getSession(sessionName);
    const currentRevision = current ? targetConfigRevision(current) : undefined;
    const pending = controller.pending;
    if (pending && currentRevision !== pending.targetConfigRevision) {
      controller.configurationInvalidated('target_configuration_changed');
      return;
    }
    const waiter = controller.automaticWaiter;
    if (waiter && currentRevision !== waiter.configRevision) {
      controller.invalidateAutomaticWaiter('target_configuration_changed');
    }
    controller.modeChanged({ automaticRunnable: runnable });
  }

  async acceptReply(
    envelope: PeerAuditReplyEnvelope,
    sender: SessionRecord,
    receivedAt: number,
  ): Promise<{ ok: true } | { ok: false; error: PeerAuditReplyError }> {
    const sessionName = this.#attemptToSession.get(envelope.attemptId);
    const controller = sessionName ? this.#controllers.get(sessionName) : undefined;
    const pending = controller?.pending;
    if (!pending || pending.attemptId !== envelope.attemptId) {
      return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.INVALID_CAPABILITY };
    }
    const audited = getSession(pending.auditedSessionName);
    const context = this.#contexts.get(pending.attemptId);
    const result = processPeerAuditReplyAuthority({
      envelope,
      receivedAt,
      authority: {
        attemptId: pending.attemptId,
        sender: {
          sessionName: pending.auditorSessionName,
          sessionInstanceId: pending.auditorSessionInstanceId,
          runtimeEpoch: pending.auditorRuntimeEpoch,
        },
        destination: {
          sessionName: pending.auditedSessionName,
          sessionInstanceId: pending.auditedSessionInstanceId,
          runtimeEpoch: pending.auditedRuntimeEpoch,
        },
        baselineId: pending.baselineId,
        targetRevision: pending.candidateRevision,
        configRevision: pending.targetConfigRevision,
        controllerRevision: pending.revision,
        deadlineAt: pending.deadlineAt,
      },
      current: {
        sender: sender.sessionInstanceId && sender.runtimeEpoch ? {
          sessionName: sender.name,
          sessionInstanceId: sender.sessionInstanceId,
          runtimeEpoch: sender.runtimeEpoch,
        } : undefined,
        destination: audited?.sessionInstanceId && audited.runtimeEpoch ? {
          sessionName: audited.name,
          sessionInstanceId: audited.sessionInstanceId,
          runtimeEpoch: audited.runtimeEpoch,
        } : undefined,
        baselineId: context?.baselineId,
        baselineValid: Boolean(context?.baselineValid()),
        targetRevision: context?.candidateRevision,
        configRevision: audited ? targetConfigRevision(audited) : undefined,
        controllerRevision: controller.pending?.revision,
      },
      capabilityMatches: (provided) => peerAuditCapabilityMatches(
        pending.capabilityHash,
        hash(provided),
      ),
      onInvalidReply: () => { controller.invalidReply({ attemptId: envelope.attemptId }); },
      onDeadline: () => { controller.timeout({ attemptId: pending.attemptId, occurredAt: receivedAt }); },
      reduce: (reply) => {
        const transition = controller.replyAccepted({
          attemptId: pending.attemptId,
          attemptRevision: reply.controllerRevision,
          receivedAt: reply.receivedAt,
          verdict: reply.verdict,
          findings: reply.findings,
        });
        return transition.status === 'applied'
          ? { accepted: true, value: undefined }
          : { accepted: false };
      },
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  #buildBrief(
    baseline: CompletedAuditBaseline,
    attemptId: string,
    capability: string,
    record: SessionRecord,
    context: {
      changePath?: string;
      changedPaths?: readonly string[];
      validations?: readonly PeerAuditValidationItem[];
    } = {},
  ): string {
    return buildPeerAuditBriefV1({
      attemptId,
      replyCapability: capability,
      taskRequest: baseline.userText,
      completedResult: baseline.assistantText,
      acceptanceCriteria: [
        `Satisfy this exact user request: ${baseline.userText}`,
        'Identify concrete correctness, regression, security, and missing-test risks.',
        'Use applicable non-destructive executable validation and report exact evidence.',
      ],
      projectPath: record.projectDir,
      changePath: context.changePath,
      changedPaths: context.changedPaths,
      validations: context.validations,
      supervisorRationale: baseline.supervisorRationale,
    });
  }

  async #applyEffects(sessionName: string, effects: readonly PeerAuditControllerEffect[]): Promise<void> {
    for (const effect of effects) {
      if (effect.type === 'dispatch') {
        const controller = this.#controllers.get(sessionName);
        const pending = controller?.pending;
        const context = this.#contexts.get(effect.attemptId);
        const target = pending ? getSession(pending.auditorSessionName) : undefined;
        if (!controller || !pending || !context || !target) {
          controller?.dispatchFailed({ attemptId: effect.attemptId, effectRevision: effect.effectRevision, reason: 'target_unavailable' });
          continue;
        }
        this.#emitStatus(sessionName, pending, 'dispatch_preparing');
        try {
          const dispatched = await dispatchPeerAuditMessage({
            target,
            brief: context.brief,
            attemptId: effect.attemptId,
            isEffectCurrent: () => {
              const current = controller.pending;
              const audited = getSession(sessionName);
              return current?.attemptId === effect.attemptId
                && current.revision === effect.effectRevision
                && context.baselineValid()
                && audited?.sessionInstanceId === current.auditedSessionInstanceId
                && audited.runtimeEpoch === current.auditedRuntimeEpoch
                && targetConfigRevision(audited) === current.targetConfigRevision;
            },
          });
          if (!dispatched.ok) {
            controller.dispatchFailed({ attemptId: effect.attemptId, effectRevision: effect.effectRevision, reason: dispatched.error });
            continue;
          }
          const transition = controller.dispatchResolved({
            attemptId: effect.attemptId,
            effectRevision: effect.effectRevision,
            receipt: dispatched.receipt,
          });
          if (transition.status === 'applied' && transition.pending) {
            this.#emitStatus(sessionName, transition.pending, 'dispatch_accepted');
          }
          if (transition.status === 'applied' && dispatched.receipt.disposition !== 'queued' && transition.pending) {
            const waiting = controller.markWaitingReply({ attemptId: effect.attemptId, effectRevision: transition.pending.revision });
            if (waiting.status === 'applied' && waiting.pending) this.#emitStatus(sessionName, waiting.pending, 'waiting_reply');
          }
        } catch {
          controller.dispatchFailed({ attemptId: effect.attemptId, effectRevision: effect.effectRevision, reason: 'dispatch_failed' });
        }
      } else if (effect.type === 'remove_queued_message') {
        const auditor = this.#contexts.get(effect.attemptId)?.auditorSessionName;
        if (auditor) cancelQueuedPeerAuditMessage(auditor, effect.messageId);
      } else if (effect.type === 'emit_terminal') {
        this.#emitTerminal(sessionName, effect.terminal);
      } else if (effect.type === 'automatic_slot_available') {
        const context = this.#contexts.get(effect.waiter.request.attemptId);
        const record = getSession(sessionName);
        const candidates = resolvePeerAuditCandidateList({ auditedSessionName: sessionName, allSessions: listSessions() });
        const stillValid = Boolean(context?.baselineValid()
          && record?.sessionInstanceId === effect.waiter.request.auditedSessionInstanceId
          && record.runtimeEpoch === effect.waiter.request.auditedRuntimeEpoch
          && targetConfigRevision(record) === effect.waiter.configRevision
          && candidates.ok && candidates.list.revision === effect.waiter.targetRevision);
        if (!stillValid) {
          this.#emitTerminal(sessionName, {
            attemptId: effect.waiter.request.attemptId,
            revision: 1,
            trigger: 'automatic',
            outcome: 'invalid_configuration',
            reason: 'automatic_waiter_invalidated',
            completedAt: Date.now(),
            elapsedMs: 0,
          });
          continue;
        }
        this.#controller(sessionName).request(effect.waiter.request);
      } else if (effect.type === 'automatic_waiter_invalidated') {
        this.#emitTerminal(sessionName, {
          attemptId: effect.waiter.request.attemptId,
          revision: effect.effectRevision,
          trigger: 'automatic',
          outcome: 'invalid_configuration',
          reason: effect.reason,
          completedAt: Date.now(),
          elapsedMs: 0,
        });
      }
    }
  }

  #emitStatus(sessionName: string, pending: NonNullable<PeerAuditController['pending']>, reason: string): void {
    const context = this.#contexts.get(pending.attemptId);
    emitPeerAuditStatus({
      auditedSessionName: sessionName,
      attemptId: pending.attemptId,
      revision: pending.revision,
      trigger: pending.trigger,
      phase: pending.phase,
      auditorSessionName: pending.auditorSessionName,
      auditorLabel: context?.auditorLabel,
      disposition: pending.disposition,
      reason,
    });
  }

  #emitTerminal(sessionName: string, terminal: PeerAuditTerminalRecord): void {
    const controller = this.#controllers.get(sessionName);
    const context = this.#contexts.get(terminal.attemptId);
    const tombstone = controller?.getTombstone(terminal.attemptId);
    const pending = tombstone ? this.#attemptToSession.get(terminal.attemptId) : undefined;
    const record = getSession(sessionName);
    const snapshot = record ? readSupervisionSnapshotFromTransportConfig(record.transportConfig) : undefined;
    emitPeerAuditResult({
      auditedSessionName: sessionName,
      attemptId: terminal.attemptId,
      trigger: terminal.trigger,
      outcome: terminal.outcome,
      auditorSessionName: context?.auditorSessionName ?? snapshot?.auditTargetSessionName ?? 'unavailable',
      auditorLabel: context?.auditorLabel,
      elapsedMs: terminal.elapsedMs,
      disposition: terminal.disposition,
      findings: terminal.findings,
      reason: terminal.reason,
    });
    context?.onAutomaticTerminal?.(terminal);
    void pending;
    this.#contexts.delete(terminal.attemptId);
    this.#attemptToSession.delete(terminal.attemptId);
  }

  beginTopLevelIntent(record: SessionRecord, taskCommandId: string, userText: string, generationOrEpoch?: number): number | undefined {
    if (!record.sessionInstanceId || !record.runtimeEpoch) return undefined;
    this.#controllers.get(record.name)?.baselineInvalidated('new_intent');
    return this.baseline.beginTopLevelIntent({
      sessionName: record.name,
      auditedSessionInstanceId: record.sessionInstanceId,
      auditedRuntimeEpoch: record.runtimeEpoch,
      taskCommandId,
      userText,
      generationOrEpoch,
    });
  }

  invalidateQueuedEdit(sessionName: string): void {
    this.baseline.queuedEdit(sessionName);
    this.#controllers.get(sessionName)?.baselineInvalidated('queued_edit');
    this.#observedTurns.delete(sessionName);
  }

  invalidateCancel(sessionName: string): void {
    this.baseline.cancel(sessionName);
    this.#controllers.get(sessionName)?.baselineInvalidated('cancel');
    this.#observedTurns.delete(sessionName);
  }

  recordTerminalResult(input: Parameters<PeerAuditBaselineTracker['recordTerminalTopLevelResult']>[0]): CompletedAuditBaseline | undefined {
    return this.baseline.recordTerminalTopLevelResult(input);
  }

  updateWorkState(sessionName: string, work: PeerAuditWorkState): CompletedAuditBaseline | undefined {
    return this.baseline.updateWorkState(sessionName, work);
  }
}

export const peerAuditService = new PeerAuditService();
