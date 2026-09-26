import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CAPABILITY_AUDIT_VERDICT,
  CAPABILITY_AUTHORITY_STATE,
  CAPABILITY_BLOB_ACTION,
  CAPABILITY_CONFIRMATION_DECISION,
  CAPABILITY_ERROR,
  CAPABILITY_KIND,
  CAPABILITY_LIMITS,
  CAPABILITY_INSTALL_STATE,
  CAPABILITY_MANAGE_ACTION,
  CAPABILITY_MANAGE_PHASE,
  CAPABILITY_MANAGE_RESULT_PHASE,
  CAPABILITY_OPERATION_MSG,
  CAPABILITY_READINESS,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_STATE,
  CAPABILITY_SYNC_MSG,
  isCapabilityInstallTerminal,
  type CapabilityBlobAccessFrame,
  type CapabilityAuthorityRecord,
  type CapabilityAuthorizationKey,
  type CapabilityErrorCode,
  type CapabilityInstallRequest,
  type CapabilityOperationActivateFrame,
  type CapabilityOperationAuthorizeFrame,
  type CapabilityOperationCancelFrame,
  type CapabilityOperationCommitResultFrame,
  type CapabilityOperationCommitAckFrame,
  type CapabilityOperationCommitAbortFrame,
  type CapabilityOperationConfirmFrame,
  type CapabilityOperationInstallFrame,
  type CapabilityOperationProgressFrame,
  type CapabilityOperationManageFrame,
  type CapabilityOperationManageAckFrame,
  type CapabilityOperationManageResultFrame,
  type CapabilityOperationResult,
  type CapabilityToolResult,
  type CapabilityVersion,
  type CapabilitySyncBinding,
} from '../../shared/capability-management.js';
import { DaemonCapabilityServiceAdapter } from './capability-service-adapter.js';
import type { DaemonCapabilityRollbackSnapshot } from './capability-service-adapter.js';
import { CapabilityJournalCapacityError, CapabilityOperationJournal } from './capability-operation-journal.js';
import { extractSkillTransferArchive } from './skill-transfer-archive.js';
import { CapabilityBlobHttpError, type CapabilityBlobHttpClient } from './capability-blob-http-client.js';
import type { CapabilitySourceConvergenceStore } from './capability-source-convergence.js';
import {
  getCapabilityAuthorizationKeys,
  setCapabilityAuthorizationKeys,
  verifyCapabilityAuthorityRecord,
  verifyCapabilitySkillAuthorization,
} from './capability-authorization.js';

export interface CapabilityBlobUploadFailure {
  capabilityId: string;
  versionId: string;
  readiness: typeof CAPABILITY_READINESS.CONTENT_MISSING;
  errorCode: CapabilityErrorCode;
}

export interface CapabilityOperationHandlerOptions {
  serviceForOwner(ownerId: string): DaemonCapabilityServiceAdapter;
  isFullDaemon: boolean;
  /** Exact identity of the authenticated daemon link. */
  serverId: string;
  send(frame: CapabilityOperationProgressFrame | CapabilityOperationActivateFrame
    | CapabilityOperationCommitResultFrame | CapabilityOperationManageResultFrame): void | Promise<void>;
  blobClient?: Pick<CapabilityBlobHttpClient, 'upload'>;
  convergenceStore?: Pick<CapabilitySourceConvergenceStore, 'recordUpload'>;
  homeDir?: string;
  onBlobUploadFailure?(failure: CapabilityBlobUploadFailure): void | Promise<void>;
  /** Fault-injection seam after disk mutation and before APPLIED WAL commit. */
  afterManageMutation?(): void;
  /** Fault-injection seam after authorized publication and before COMMIT_RESULT WAL finalization. */
  afterAuthorizedMutation?(): void;
  /** Deterministic retention clock for candidate expiry and tests. */
  now?(): number;
}

interface ExternalOperationRecord {
  ownerId: string;
  service: DaemonCapabilityServiceAdapter;
  localOperationId: string;
  request: CapabilityInstallRequest;
  requestDigest: string;
  nextExpectedRevision: number;
  sendChain: Promise<void>;
}

interface PendingCommit {
  ownerId: string;
  result: CapabilityOperationCommitResultFrame;
  authorize?: CapabilityOperationAuthorizeFrame;
  rollback: () => boolean;
  abort?: CapabilityOperationCommitAbortFrame;
  authority?: CapabilityAuthorityRecord;
  authorizationKeys?: readonly CapabilityAuthorizationKey[];
  rollbackSnapshot?: DaemonCapabilityRollbackSnapshot;
}

interface PendingManage {
  ownerId: string;
  frame: CapabilityOperationManageFrame;
  result: CapabilityOperationManageResultFrame;
  rollbackSnapshot?: DaemonCapabilityRollbackSnapshot;
}

interface PendingActivation {
  ownerId: string;
  frame: CapabilityOperationActivateFrame;
  expiresAt: number;
}

function digestRequest(request: CapabilityInstallRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

function durableInstallRequest(
  request: CapabilityInstallRequest,
  mcpDefinition?: ReturnType<DaemonCapabilityServiceAdapter['mcpDefinition']>,
): CapabilityInstallRequest {
  const persisted = structuredClone(request);
  delete persisted.userIntent;
  persisted.idempotencyKey = `sha256:${createHash('sha256').update(request.idempotencyKey).digest('hex')}`;
  // Skill recovery uses the already reviewed, digest-bound transfer archive;
  // never duplicate free-form URLs, repository strings, inline source text, or
  // user prose into the durable control journal.
  if (persisted.kind === CAPABILITY_KIND.SKILL) {
    persisted.source = { kind: CAPABILITY_SOURCE_KIND.INLINE, inlineFiles: {} };
  } else if (mcpDefinition) {
    persisted.source = { kind: CAPABILITY_SOURCE_KIND.MCP_CONFIG, mcpConfig: { ...structuredClone(mcpDefinition) } };
  }
  return persisted;
}

function canonicalFrameIdentity(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalFrameIdentity).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalFrameIdentity(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function authorizedPublicationMatches(
  service: DaemonCapabilityServiceAdapter,
  ownerId: string,
  serverId: string,
  frame: CapabilityOperationAuthorizeFrame,
): boolean {
  if (!service.authorizedPublicationComplete(frame)) return false;
  const status = service.status({ capabilityId: frame.capability.id });
  const capability = status.status === 'ok' ? status.capability : undefined;
  const binding = capability?.bindings?.find((candidate) => candidate.id === frame.binding.id);
  if (!capability || capability.kind !== frame.capability.kind
    || capability.versionId !== frame.version.id
    || capability.artifactDigest !== frame.version.artifactDigest
    || !binding
    || binding.scope !== frame.binding.scope
    || binding.scopeId !== frame.binding.scopeId
    || arraysEqual(binding.providers, frame.binding.providers) === false
    || arraysEqual(binding.machines, frame.binding.machines) === false) return false;
  if (frame.capability.kind !== CAPABILITY_KIND.SKILL) return true;
  return Boolean(frame.binding.authorization
    && frame.binding.authorization.ownerId === ownerId
    && verifyCapabilitySkillAuthorization({
      ownerId,
      serverId,
      capabilityId: frame.capability.id,
      version: frame.version,
      binding: frame.binding,
      envelope: frame.binding.authorization,
      authorizationKeys: frame.authorizationKeys,
    }));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isInstallFrame(value: unknown): value is CapabilityOperationInstallFrame {
  if (!isObject(value) || value.type !== CAPABILITY_OPERATION_MSG.INSTALL) return false;
  return typeof value.operationId === 'string'
    && value.operationId.length > 0
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) > 0
    && typeof value.ownerId === 'string'
    && value.ownerId.length > 0
    && value.ownerId.length <= 256
    && isObject(value.request);
}

function isConfirmFrame(value: unknown): value is CapabilityOperationConfirmFrame {
  if (!isObject(value) || value.type !== CAPABILITY_OPERATION_MSG.CONFIRM) return false;
  return typeof value.operationId === 'string'
    && value.operationId.length > 0
    && Number.isSafeInteger(value.expectedRevision)
    && Number(value.expectedRevision) > 0
    && (value.decision === CAPABILITY_CONFIRMATION_DECISION.INSTALL
      || value.decision === CAPABILITY_CONFIRMATION_DECISION.CANCEL)
    && typeof value.artifactDigest === 'string'
    && typeof value.auditDigest === 'string'
    && Object.values(CAPABILITY_SCOPE).includes(value.scope as never)
    && Array.isArray(value.providers)
    && Array.isArray(value.machines);
}

function isCancelFrame(value: unknown): value is CapabilityOperationCancelFrame {
  if (!isObject(value) || value.type !== CAPABILITY_OPERATION_MSG.CANCEL) return false;
  return typeof value.operationId === 'string'
    && value.operationId.length > 0
    && Number.isSafeInteger(value.expectedRevision)
    && Number(value.expectedRevision) > 0;
}

function isAuthorizeFrame(value: unknown): value is CapabilityOperationAuthorizeFrame {
  return isObject(value)
    && value.type === CAPABILITY_OPERATION_MSG.AUTHORIZE
    && typeof value.operationId === 'string'
    && value.operationId.length > 0
    && Number.isSafeInteger(value.expectedRevision)
    && Number(value.expectedRevision) > 0
    && isObject(value.capability)
    && isObject(value.version)
    && isObject(value.binding)
    && Array.isArray(value.authorizationKeys)
    && Number.isSafeInteger(value.expiresAt) && Number(value.expiresAt) > 0;
}

function isManageFrame(value: unknown): value is CapabilityOperationManageFrame {
  return isObject(value)
    && value.type === CAPABILITY_OPERATION_MSG.MANAGE
    && typeof value.requestId === 'string' && value.requestId.length > 0 && value.requestId.length <= 256
    && typeof value.ownerId === 'string' && value.ownerId.length > 0 && value.ownerId.length <= 256
    && typeof value.serverId === 'string' && value.serverId.length > 0 && value.serverId.length <= 256
    && typeof value.capabilityId === 'string' && value.capabilityId.length > 0 && value.capabilityId.length <= 256
    && typeof value.bindingId === 'string' && value.bindingId.length > 0 && value.bindingId.length <= 256
    && Number.isSafeInteger(value.expectedRevision) && Number(value.expectedRevision) >= 0
    && Number.isSafeInteger(value.authorityRevision) && Number(value.authorityRevision) > 0
    && Object.values(CAPABILITY_MANAGE_PHASE).includes(value.phase as never)
    && (value.action === CAPABILITY_MANAGE_ACTION.ENABLE
      || value.action === CAPABILITY_MANAGE_ACTION.DISABLE
      || value.action === CAPABILITY_MANAGE_ACTION.ROLLBACK
      || value.action === CAPABILITY_MANAGE_ACTION.UNINSTALL
      || value.action === CAPABILITY_MANAGE_ACTION.RESTORE)
    && (value.versionId === undefined || (typeof value.versionId === 'string' && value.versionId.length > 0 && value.versionId.length <= 256));
}

function isCommitAckFrame(value: unknown): value is CapabilityOperationCommitAckFrame {
  return isObject(value) && value.type === CAPABILITY_OPERATION_MSG.COMMIT_ACK
    && typeof value.operationId === 'string' && value.operationId.length > 0
    && typeof value.capabilityId === 'string' && typeof value.versionId === 'string'
    && typeof value.bindingId === 'string'
    && Number.isSafeInteger(value.authorityRevision) && Number(value.authorityRevision) > 0;
}

function isCommitAbortFrame(value: unknown): value is CapabilityOperationCommitAbortFrame {
  return isObject(value) && value.type === CAPABILITY_OPERATION_MSG.COMMIT_ABORT
    && typeof value.operationId === 'string' && value.operationId.length > 0
    && typeof value.capabilityId === 'string' && typeof value.versionId === 'string'
    && typeof value.bindingId === 'string'
    && Number.isSafeInteger(value.authorityRevision) && Number(value.authorityRevision) > 0
    && typeof value.errorCode === 'string';
}

function isManageAckFrame(value: unknown): value is CapabilityOperationManageAckFrame {
  return isObject(value) && value.type === CAPABILITY_OPERATION_MSG.MANAGE_ACK
    && typeof value.requestId === 'string' && value.requestId.length > 0
    && typeof value.capabilityId === 'string' && typeof value.bindingId === 'string'
    && Number.isSafeInteger(value.authorityRevision) && Number(value.authorityRevision) > 0;
}

function isBlobUploadFrame(value: unknown): value is CapabilityBlobAccessFrame & { operationId: string } {
  if (!isObject(value) || value.type !== CAPABILITY_SYNC_MSG.BLOB_CAPABILITY || !isObject(value.access)) return false;
  const access = value.access;
  return typeof value.operationId === 'string'
    && value.operationId.length > 0
    && value.operationId.length <= 256
    && access.action === CAPABILITY_BLOB_ACTION.UPLOAD
    && typeof access.capabilityId === 'string'
    && typeof access.versionId === 'string'
    && typeof access.blobDigest === 'string'
    && typeof access.maxBytes === 'number'
    && (value.expectedRevision === undefined || (Number.isSafeInteger(value.expectedRevision) && Number(value.expectedRevision) > 0))
    && typeof access.expiresAt === 'number'
    && typeof access.singleUseToken === 'string';
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function errorState(code: CapabilityErrorCode): CapabilityOperationProgressFrame['state'] {
  return code === CAPABILITY_ERROR.SCAN_BLOCKED
    || code === CAPABILITY_ERROR.AUDIT_REWORK
    || code === CAPABILITY_ERROR.AUDITOR_UNAVAILABLE
    ? CAPABILITY_INSTALL_STATE.REWORK
    : CAPABILITY_INSTALL_STATE.FAILED;
}

function progressFromResult(
  operationId: string,
  expectedRevision: number,
  result: CapabilityToolResult,
): CapabilityOperationProgressFrame {
  if (result.status !== 'ok' || !('operation' in result) || !result.operation) {
    const errorCode = result.status === 'error' ? result.reason : CAPABILITY_ERROR.INTERNAL_ERROR;
    return {
      type: CAPABILITY_OPERATION_MSG.PROGRESS,
      operationId,
      expectedRevision,
      state: errorState(errorCode),
      errorCode,
      errorMessage: result.status === 'error' ? result.error : 'Capability operation did not return progress',
    };
  }
  const operation = result.operation;
  return {
    type: CAPABILITY_OPERATION_MSG.PROGRESS,
    operationId,
    expectedRevision,
    state: operation.state,
    ...(operation.artifactDigest ? { artifactDigest: operation.artifactDigest } : {}),
    ...(operation.auditDigest ? { auditDigest: operation.auditDigest } : {}),
    ...(operation.auditVerdict ? { auditVerdict: operation.auditVerdict } : {}),
    ...(operation.findings.length > 0 ? { findings: operation.findings } : {}),
    ...(operation.displayName ? { displayName: operation.displayName } : {}),
    ...(operation.sourceLabel ? { sourceLabel: operation.sourceLabel } : {}),
    ...(operation.tools ? { tools: operation.tools } : {}),
    ...(operation.permissions ? { permissions: operation.permissions } : {}),
    ...(operation.updateDiff ? { updateDiff: operation.updateDiff } : {}),
    ...(operation.hasScripts ? { hasScripts: true } : {}),
    ...(operation.hasExecutables ? { hasExecutables: true } : {}),
    ...(operation.stdioCommand ? { stdioCommand: operation.stdioCommand } : {}),
    ...(operation.errorCode ? { errorCode: operation.errorCode } : {}),
    ...(operation.errorMessage ? { errorMessage: operation.errorMessage } : {}),
  };
}

function confirmationMatches(
  frame: CapabilityOperationConfirmFrame,
  request: CapabilityInstallRequest,
  operation: CapabilityOperationResult['operation'],
): boolean {
  return (operation.state === CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION || operation.state === CAPABILITY_INSTALL_STATE.INSTALLED)
    && operation.artifactDigest === frame.artifactDigest
    && operation.auditDigest === frame.auditDigest
    && request.scope === frame.scope
    && arraysEqual(request.providers ?? [], frame.providers)
    && arraysEqual(request.machines ?? [], frame.machines);
}

export class CapabilityOperationHandler {
  private readonly operations = new Map<string, ExternalOperationRecord>();
  private readonly blobUploadAttempts = new Set<string>();
  private readonly pendingCommits = new Map<string, PendingCommit>();
  private readonly pendingManages = new Map<string, PendingManage>();
  private readonly pendingActivations = new Map<string, PendingActivation>();
  /** Serializes duplicate AUTHORIZE delivery for one immutable operation. */
  private readonly authorizeChains = new Map<string, Promise<void>>();
  private readonly terminalOperationOrder: string[] = [];
  private readonly journal: CapabilityOperationJournal;
  private readonly now: () => number;
  private restorePromise?: Promise<void>;

  constructor(private readonly options: CapabilityOperationHandlerOptions) {
    this.journal = new CapabilityOperationJournal(options.serverId, options.homeDir);
    this.now = options.now ?? Date.now;
    for (const durable of this.journal.commits()) {
      const service = options.serviceForOwner(durable.ownerId);
      if (durable.committing) {
        if (durable.authorize && authorizedPublicationMatches(
          service, durable.ownerId, options.serverId, durable.authorize,
        )) {
          durable.committing = false;
          this.journal.putCommit(durable);
        } else {
          const recovery = durable.authorize
            ? service.recoverAuthorizedPublication(durable.rollback, durable.authorize)
            : (service.restoreAuthorizedState(durable.rollback, durable.result.versionId) ? 'restored' : 'failed');
          if (recovery === 'committed') {
            durable.committing = false;
            this.journal.putCommit(durable);
          } else if (recovery === 'restored') {
            // Mutation never began or its exact partial orphan was removed.
            // Keep the durable candidate/ACTIVATE proposal so the server can
            // authorize the same immutable evidence again.
            this.journal.deleteCommit(durable.result.operationId);
            continue;
          } else {
            durable.committing = false;
            durable.result = {
              ...durable.result,
              ok: false,
              errorCode: CAPABILITY_ERROR.INTEGRITY_FAILED,
              errorMessage: 'Interrupted authorized publication could not be recovered exactly',
            };
            this.journal.putCommit(durable);
          }
        }
      }
      this.pendingCommits.set(durable.result.operationId, {
        ownerId: durable.ownerId,
        result: durable.result,
        rollbackSnapshot: durable.rollback,
        rollback: () => service.rollbackAuthorizedState(durable.rollback, durable.result.versionId),
        ...(durable.abort ? { abort: durable.abort } : {}),
        ...(durable.authorize ? { authorize: durable.authorize } : {}),
        ...(durable.authority ? { authority: durable.authority } : {}),
        ...(durable.authorizationKeys ? { authorizationKeys: durable.authorizationKeys } : {}),
      });
    }
    for (const durable of this.journal.manages()) {
      if (durable.committing && durable.rollback) {
        const restored = options.serviceForOwner(durable.ownerId).restoreManageState(durable.rollback);
        durable.result = {
          ...durable.result,
          phase: CAPABILITY_MANAGE_RESULT_PHASE.ABORTED,
          ok: false,
          errorCode: restored ? CAPABILITY_ERROR.INTERNAL_ERROR : CAPABILITY_ERROR.INTEGRITY_FAILED,
          errorMessage: restored
            ? 'Interrupted local management was rolled back before replay'
            : 'Interrupted local management rollback failed closed',
        };
        durable.committing = false;
        this.journal.putManage(durable);
      }
      this.pendingManages.set(durable.frame.requestId, {
        ownerId: durable.ownerId,
        frame: durable.frame,
        result: durable.result,
        ...(durable.rollback ? { rollbackSnapshot: durable.rollback } : {}),
      });
    }
  }

  async replayPending(): Promise<void> {
    await this.cleanupExpiredCandidates();
    await this.ensureRestored();
    for (const progress of this.journal.progresses()) {
      try {
        await this.options.send(progress);
        this.journal.deleteProgress(progress.operationId);
      } catch {
        // Keep the durable terminal update for the next reconnect/replay.
      }
    }
    for (const [operationId, record] of this.operations) {
      if (this.pendingActivations.has(operationId) || this.pendingCommits.has(operationId)) continue;
      const status = record.service.status({ operationId: record.localOperationId });
      if (status.status === 'ok' && status.operation?.state === CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION) {
        await this.options.send(progressFromResult(operationId, record.nextExpectedRevision++, status));
      }
    }
    for (const [operationId, pending] of this.pendingActivations) {
      if (pending.expiresAt <= this.now()) {
        const durable = this.journal.candidates().find((candidate) => candidate.operationId === operationId);
        if (durable) await this.expireCandidate(durable, 'Confirmed capability activation expired before authorization');
        else {
          const record = this.operations.get(operationId);
          if (record) record.service.failPreparedInstall(record.localOperationId, CAPABILITY_ERROR.CONFIRMATION_STALE);
          this.pendingActivations.delete(operationId);
          this.operations.delete(operationId);
        }
        continue;
      }
      await this.options.send(pending.frame);
    }
    for (const [operationId, pending] of [...this.pendingCommits]) {
      if (pending.abort) {
        await this.compensateCommitAbort(operationId, pending);
        continue;
      }
      await this.options.send(pending.result);
    }
    for (const pending of this.pendingManages.values()) await this.options.send(pending.result);
  }

  private ensureRestored(): Promise<void> {
    this.restorePromise ??= this.restoreCandidates();
    return this.restorePromise;
  }

  private persistCandidate(operationId: string, record: ExternalOperationRecord, operation: CapabilityOperationResult['operation']): void {
    if (!operation || (operation.state !== CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION
      && operation.state !== CAPABILITY_INSTALL_STATE.INSTALLING)) return;
    const archive = record.request.kind === CAPABILITY_KIND.SKILL
      ? record.service.skillTransferArchive(record.localOperationId)
      : undefined;
    if (record.request.kind === CAPABILITY_KIND.SKILL && !archive) return;
    const reviewedEvidence = record.service.candidateReviewEvidence(record.localOperationId);
    if (!reviewedEvidence || reviewedEvidence.kind !== record.request.kind) {
      throw new Error('Reviewed candidate evidence is unavailable');
    }
    const existing = this.journal.candidates().find((candidate) => candidate.operationId === operationId);
    const resetForCommit = operation.state === CAPABILITY_INSTALL_STATE.INSTALLING
      && existing?.operation.state !== CAPABILITY_INSTALL_STATE.INSTALLING;
    const priorCreatedAt = existing && Number.isSafeInteger(existing.createdAt)
      ? existing.createdAt
      : existing && Number.isSafeInteger(existing.operation.createdAt)
        ? existing.operation.createdAt
        : this.now();
    const createdAt = !existing || resetForCommit ? this.now() : priorCreatedAt;
    const expiresAt = !existing || resetForCommit
      ? createdAt + CAPABILITY_LIMITS.PERSISTED_CANDIDATE_TTL_MS
      : Number.isSafeInteger(existing.expiresAt)
        ? existing.expiresAt
        : createdAt + CAPABILITY_LIMITS.PERSISTED_CANDIDATE_TTL_MS;
    this.journal.putCandidate({
      operationId,
      ownerId: record.ownerId,
      createdAt,
      expiresAt,
      request: durableInstallRequest(record.request, record.service.mcpDefinition(record.localOperationId)),
      requestDigest: record.requestDigest,
      expectedRevision: record.nextExpectedRevision,
      operation: structuredClone(operation),
      reviewedEvidence: structuredClone(reviewedEvidence),
      ...(archive ? {
        archiveBase64: archive.bytes.toString('base64'),
        blobDigest: archive.blobDigest,
        blobByteSize: archive.blobByteSize,
      } : {}),
    });
  }

  /**
   * Drops only expired candidates that have not advanced into ACTIVATE/COMMIT.
   * The local adapter is failed first so quarantine, audit listeners and active
   * job capacity are released before the durable record/map disappears.
   */
  async cleanupExpiredCandidates(now = this.now()): Promise<number> {
    let removed = 0;
    for (const durable of this.journal.candidates()) {
      const expiresAt = Number.isSafeInteger(durable.expiresAt)
        ? durable.expiresAt
        : (Number.isSafeInteger(durable.createdAt) ? durable.createdAt : durable.operation.createdAt)
          + CAPABILITY_LIMITS.PERSISTED_CANDIDATE_TTL_MS;
      if (this.pendingCommits.has(durable.operationId)) continue;
      const activationExpiresAt = durable.activationExpiresAt ?? expiresAt;
      if (durable.activation || this.pendingActivations.has(durable.operationId)) {
        if (activationExpiresAt > now) continue;
        await this.expireCandidate(durable, 'Confirmed capability activation expired before authorization');
        removed += 1;
        continue;
      }
      if (expiresAt > now) continue;
      await this.expireCandidate(durable, 'Reviewed capability candidate expired before confirmation');
      removed += 1;
    }
    return removed;
  }

  private async expireCandidate(
    durable: ReturnType<CapabilityOperationJournal['candidates']>[number],
    errorMessage: string,
  ): Promise<void> {
    const record = this.operations.get(durable.operationId);
    if (record) record.service.failPreparedInstall(record.localOperationId, CAPABILITY_ERROR.CONFIRMATION_STALE);
    this.operations.delete(durable.operationId);
    this.pendingActivations.delete(durable.operationId);
    const progress: CapabilityOperationProgressFrame = {
      type: CAPABILITY_OPERATION_MSG.PROGRESS,
      operationId: durable.operationId,
      expectedRevision: durable.expectedRevision,
      state: CAPABILITY_INSTALL_STATE.FAILED,
      artifactDigest: durable.operation.artifactDigest,
      auditDigest: durable.operation.auditDigest,
      auditVerdict: durable.operation.auditVerdict,
      errorCode: CAPABILITY_ERROR.CONFIRMATION_STALE,
      errorMessage,
    };
    this.journal.putProgress(progress);
    this.journal.deleteCandidate(durable.operationId);
    try {
      await this.options.send(progress);
      this.journal.deleteProgress(durable.operationId);
    } catch {
      // Durable terminal progress is replayed after the link reconnects.
    }
  }

  private retainTerminalOperation(operationId: string): void {
    const existing = this.terminalOperationOrder.indexOf(operationId);
    if (existing >= 0) this.terminalOperationOrder.splice(existing, 1);
    this.terminalOperationOrder.push(operationId);
    while (this.terminalOperationOrder.length > CAPABILITY_LIMITS.RETAINED_TERMINAL_OPERATIONS) {
      const evicted = this.terminalOperationOrder.shift();
      if (evicted && !this.pendingCommits.has(evicted) && !this.pendingActivations.has(evicted)) {
        this.operations.delete(evicted);
      }
    }
  }

  private async restoreCandidates(): Promise<void> {
    for (const durable of this.journal.candidates()) {
      if (this.operations.has(durable.operationId) || this.pendingCommits.has(durable.operationId)) continue;
      if (durable.activation && durable.activationExpiresAt !== undefined
        && durable.activationExpiresAt <= this.now()) {
        await this.expireCandidate(durable, 'Confirmed capability activation expired before authorization');
        continue;
      }
      const service = this.options.serviceForOwner(durable.ownerId);
      let request = structuredClone(durable.request);
      let temporary: string | undefined;
      let record: ExternalOperationRecord | undefined;
      try {
        if (request.kind === CAPABILITY_KIND.SKILL) {
          if (!durable.archiveBase64 || !durable.blobDigest || !durable.blobByteSize) {
            this.journal.deleteCandidate(durable.operationId);
            continue;
          }
          const bytes = Buffer.from(durable.archiveBase64, 'base64');
          if (bytes.byteLength !== durable.blobByteSize) throw new Error('persisted candidate byte size changed');
          const root = join(this.options.homeDir ?? homedir(), '.imcodes', 'capability-operations', 'restore');
          mkdirSync(root, { recursive: true, mode: 0o700 });
          temporary = mkdtempSync(join(root, 'candidate-'));
          const restoredName = durable.operation.displayName;
          if (!restoredName || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(restoredName)) {
            throw new Error('persisted candidate name is invalid');
          }
          const destination = join(temporary, restoredName);
          extractSkillTransferArchive({
            bytes,
            blobDigest: durable.blobDigest,
            treeDigest: durable.operation.artifactDigest!,
            destination,
          });
          request = { ...request, source: { kind: CAPABILITY_SOURCE_KIND.LOCAL_PATH, value: destination } };
        }
        if (!durable.reviewedEvidence) throw new Error('persisted reviewed evidence is unavailable');
        const completed = await service.restoreReviewedCandidate(request, durable.operation, durable.reviewedEvidence);
        if (completed.status !== 'ok') throw new Error('persisted candidate could not restart');
        record = {
          ownerId: durable.ownerId,
          service,
          localOperationId: completed.operation.id,
          request: structuredClone(durable.request),
          requestDigest: durable.requestDigest,
          nextExpectedRevision: durable.expectedRevision,
          sendChain: Promise.resolve(),
        };
        this.operations.set(durable.operationId, record);
        if (completed.status !== 'ok' || completed.operation.state !== CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION
          || completed.operation.artifactDigest !== durable.operation.artifactDigest
          || completed.operation.auditDigest !== durable.operation.auditDigest) throw new Error('persisted reviewed evidence changed');
        if (durable.operation.state === CAPABILITY_INSTALL_STATE.INSTALLING) {
          const confirmed = service.confirm({
            operationId: record.localOperationId,
            revision: completed.operation.revision,
            artifactDigest: completed.operation.artifactDigest!,
            auditDigest: completed.operation.auditDigest!,
            decision: CAPABILITY_CONFIRMATION_DECISION.INSTALL,
          });
          if (confirmed.status !== 'ok' || confirmed.operation.state !== CAPABILITY_INSTALL_STATE.INSTALLING) {
            throw new Error('persisted confirmed candidate could not restore');
          }
          this.persistCandidate(durable.operationId, record, confirmed.operation);
          if (durable.activation && durable.activationExpiresAt
            && durable.activation.operationId === durable.operationId
            && durable.activation.version.artifactDigest === durable.operation.artifactDigest
            && durable.activation.version.auditDigest === durable.operation.auditDigest
            && durable.activation.capability.kind === durable.request.kind) {
            this.pendingActivations.set(durable.operationId, {
              ownerId: durable.ownerId,
              frame: structuredClone(durable.activation),
              expiresAt: durable.activationExpiresAt,
            });
            this.journal.putActivation(
              durable.operationId,
              durable.activation,
              durable.activationExpiresAt,
            );
          }
        }
      } catch {
        if (record) record.service.failPreparedInstall(record.localOperationId, CAPABILITY_ERROR.INTEGRITY_FAILED);
        this.operations.delete(durable.operationId);
        this.journal.deleteCandidate(durable.operationId);
      } finally {
        if (temporary) rmSync(temporary, { recursive: true, force: true });
      }
    }
  }

  async handle(value: unknown): Promise<boolean> {
    if (!isObject(value)) return false;
    await this.cleanupExpiredCandidates();
    await this.ensureRestored();
    if (value.type === CAPABILITY_OPERATION_MSG.INSTALL) {
      if (!isInstallFrame(value)) return true;
      await this.handleInstall(value);
      return true;
    }
    if (value.type === CAPABILITY_OPERATION_MSG.CONFIRM) {
      if (!isConfirmFrame(value)) return true;
      await this.handleConfirm(value);
      return true;
    }
    if (value.type === CAPABILITY_OPERATION_MSG.CANCEL) {
      if (!isCancelFrame(value)) return true;
      await this.handleCancel(value);
      return true;
    }
    if (value.type === CAPABILITY_OPERATION_MSG.AUTHORIZE) {
      if (!isAuthorizeFrame(value)) return true;
      await this.handleAuthorizeSerialized(value);
      return true;
    }
    if (value.type === CAPABILITY_OPERATION_MSG.COMMIT_ACK) {
      if (!isCommitAckFrame(value)) return true;
      this.handleCommitAck(value);
      return true;
    }
    if (value.type === CAPABILITY_OPERATION_MSG.COMMIT_ABORT) {
      if (!isCommitAbortFrame(value)) return true;
      await this.handleCommitAbort(value);
      return true;
    }
    if (value.type === CAPABILITY_OPERATION_MSG.MANAGE) {
      if (!isManageFrame(value)) return true;
      await this.handleManage(value);
      return true;
    }
    if (value.type === CAPABILITY_OPERATION_MSG.MANAGE_ACK) {
      if (!isManageAckFrame(value)) return true;
      this.handleManageAck(value);
      return true;
    }
    if (value.type === CAPABILITY_SYNC_MSG.BLOB_CAPABILITY) {
      if (!isBlobUploadFrame(value)) return true;
      await this.handleBlobUpload(value);
      return true;
    }
    return false;
  }

  private async handleAuthorizeSerialized(frame: CapabilityOperationAuthorizeFrame): Promise<void> {
    const previous = this.authorizeChains.get(frame.operationId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await this.handleAuthorize(frame);
    });
    this.authorizeChains.set(frame.operationId, next);
    try {
      await next;
    } finally {
      if (this.authorizeChains.get(frame.operationId) === next) {
        this.authorizeChains.delete(frame.operationId);
      }
    }
  }

  private async reportBlobUploadFailure(
    frame: CapabilityBlobAccessFrame,
    errorCode: CapabilityErrorCode,
  ): Promise<void> {
    await this.options.onBlobUploadFailure?.({
      capabilityId: frame.access.capabilityId,
      versionId: frame.access.versionId,
      readiness: CAPABILITY_READINESS.CONTENT_MISSING,
      errorCode,
    });
    if (frame.expectedRevision !== undefined) {
      await this.options.send({
        type: CAPABILITY_OPERATION_MSG.PROGRESS,
        operationId: 'operationId' in frame && typeof frame.operationId === 'string' ? frame.operationId : 'unknown',
        expectedRevision: frame.expectedRevision,
        state: CAPABILITY_INSTALL_STATE.FAILED,
        errorCode,
        errorMessage: 'Reviewed capability blob candidate is unavailable on this daemon',
      });
    }
  }

  private async handleBlobUpload(frame: CapabilityBlobAccessFrame & { operationId: string }): Promise<void> {
    const record = this.operations.get(frame.operationId);
    if (!this.options.isFullDaemon || !record || !this.options.blobClient) {
      await this.reportBlobUploadFailure(
        frame,
        !record ? CAPABILITY_ERROR.NOT_FOUND : !this.options.isFullDaemon ? CAPABILITY_ERROR.FORBIDDEN : CAPABILITY_ERROR.RUNTIME_PENDING,
      );
      return;
    }
    const status = record.service.status({ operationId: record.localOperationId });
    const archive = record.service.skillTransferArchive(record.localOperationId);
    if (status.status !== 'ok'
      || (status.operation?.state !== CAPABILITY_INSTALL_STATE.INSTALLING
        && status.operation?.state !== CAPABILITY_INSTALL_STATE.INSTALLED)
      || record.request.kind !== CAPABILITY_KIND.SKILL
      || !archive
      || archive.blobDigest !== frame.access.blobDigest
      || archive.blobByteSize !== frame.access.maxBytes) {
      await this.reportBlobUploadFailure(frame, CAPABILITY_ERROR.INTEGRITY_FAILED);
      return;
    }
    // A server grant is single-use. Hash the bearer rather than retaining it in
    // daemon state or logs, and mark it before I/O so concurrent duplicate
    // frames cannot upload the same grant twice.
    const attemptKey = createHash('sha256')
      .update(frame.operationId)
      .update('\0')
      .update(frame.access.singleUseToken)
      .digest('hex');
    if (this.blobUploadAttempts.has(attemptKey)) return;
    this.blobUploadAttempts.add(attemptKey);
    try {
      const localCapabilityId = status.operation.capabilityId;
      const localCapabilityStatus = localCapabilityId
        ? record.service.status({ capabilityId: localCapabilityId })
        : undefined;
      const localVersionId = localCapabilityStatus?.status === 'ok'
        ? localCapabilityStatus.capability?.versionId
        : undefined;
      const artifactDigest = status.operation.artifactDigest;
      const auditDigest = status.operation.auditDigest;
      // Convergence evidence is meaningful only after a package has actually
      // been committed locally. A pending candidate upload never retires or
      // supersedes any prior resolver-visible source version.
      if (status.operation.state === CAPABILITY_INSTALL_STATE.INSTALLED
        && localCapabilityId && localVersionId && artifactDigest && auditDigest) {
        this.options.convergenceStore?.recordUpload({
          ownerId: record.ownerId,
          operationId: frame.operationId,
          localRegistryId: localCapabilityId,
          localVersionId,
          authoritativeCapabilityId: frame.access.capabilityId,
          authoritativeVersionId: frame.access.versionId,
          artifactDigest,
          auditDigest,
          blobDigest: frame.access.blobDigest,
          blobByteSize: frame.access.maxBytes,
        });
      }
      await this.options.blobClient.upload(frame.access, archive.bytes);
    } catch (error) {
      await this.reportBlobUploadFailure(
        frame,
        error instanceof CapabilityBlobHttpError ? error.code : CAPABILITY_ERROR.RUNTIME_PENDING,
      );
    }
  }

  private async handleInstall(frame: CapabilityOperationInstallFrame): Promise<void> {
    if (!this.options.isFullDaemon || !frame.ownerId.trim()) {
      await this.options.send({
        type: CAPABILITY_OPERATION_MSG.PROGRESS,
        operationId: frame.operationId,
        expectedRevision: frame.revision,
        state: CAPABILITY_INSTALL_STATE.FAILED,
        errorCode: CAPABILITY_ERROR.FORBIDDEN,
        errorMessage: 'Capability installation requires an authenticated owner on a FULL daemon',
      });
      return;
    }
    const requestDigest = digestRequest(frame.request);
    const existing = this.operations.get(frame.operationId);
    if (existing && (existing.requestDigest !== requestDigest || existing.ownerId !== frame.ownerId)) {
      await this.options.send({
        type: CAPABILITY_OPERATION_MSG.PROGRESS,
        operationId: frame.operationId,
        expectedRevision: frame.revision,
        state: CAPABILITY_INSTALL_STATE.FAILED,
        errorCode: CAPABILITY_ERROR.CONFLICT,
        errorMessage: 'Operation retry changed the install request',
      });
      return;
    }
    if (existing) {
      const status = existing.service.status({ operationId: existing.localOperationId });
      await this.options.send(progressFromResult(frame.operationId, frame.revision, status));
      return;
    }
    const service = this.options.serviceForOwner(frame.ownerId);
    let record: ExternalOperationRecord | undefined;
    const started = service.startInstall(frame.request, (result) => {
      if (record) this.enqueueTransition(frame.operationId, record, result);
    });
    if (started.initial.status === 'ok') {
      if (isCapabilityInstallTerminal(started.initial.operation.state)) {
        await this.options.send(progressFromResult(frame.operationId, frame.revision, started.initial));
        return;
      }
      record = {
        ownerId: frame.ownerId,
        service,
        localOperationId: started.initial.operation.id,
        request: structuredClone(frame.request),
        requestDigest,
        nextExpectedRevision: frame.revision,
        sendChain: Promise.resolve(),
      };
      this.operations.set(frame.operationId, record);
      // Keep the completion observed so an unexpected adapter failure cannot
      // become an unhandled rejection. State transitions themselves are sent
      // through the listener above in exact server-revision order.
      void started.completion.catch(async () => {
        if (!record) return;
        const failed: CapabilityOperationProgressFrame = {
          type: CAPABILITY_OPERATION_MSG.PROGRESS,
          operationId: frame.operationId,
          expectedRevision: record.nextExpectedRevision++,
          state: CAPABILITY_INSTALL_STATE.FAILED,
          errorCode: CAPABILITY_ERROR.INTERNAL_ERROR,
          errorMessage: 'Capability operation failed unexpectedly',
        };
        record.sendChain = record.sendChain.then(async () => { await this.options.send(failed); });
        await record.sendChain;
      });
      return;
    }
    await this.options.send(progressFromResult(frame.operationId, frame.revision, started.initial));
  }

  private enqueueTransition(
    operationId: string,
    record: ExternalOperationRecord,
    result: CapabilityOperationResult,
  ): void {
    const state = result.operation.state;
    if (state === CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION) {
      try {
        this.persistCandidate(operationId, record, result.operation);
      } catch (error) {
        const code = error instanceof CapabilityJournalCapacityError
          ? CAPABILITY_ERROR.RATE_LIMITED
          : CAPABILITY_ERROR.INTERNAL_ERROR;
        const failed = record.service.failPreparedInstall(record.localOperationId, code);
        this.journal.deleteCandidate(operationId);
        const frame = progressFromResult(operationId, record.nextExpectedRevision++, failed);
        record.sendChain = record.sendChain.then(async () => { await this.options.send(frame); });
        void record.sendChain.catch(() => undefined);
        this.retainTerminalOperation(operationId);
        return;
      }
    }
    // The server confirmation transaction owns the `installing` transition,
    // ACTIVATE owns `installed`, and CANCEL is already authoritative server-
    // side before delivery. Do not replay those as optimistic progress.
    if (state === CAPABILITY_INSTALL_STATE.QUEUED || state === CAPABILITY_INSTALL_STATE.INSTALLING || state === CAPABILITY_INSTALL_STATE.SYNCING
      || state === CAPABILITY_INSTALL_STATE.INSTALLED || state === CAPABILITY_INSTALL_STATE.CANCELLED) return;
    const frame = progressFromResult(operationId, record.nextExpectedRevision++, result);
    record.sendChain = record.sendChain.then(async () => { await this.options.send(frame); });
    void record.sendChain.catch(() => undefined);
    if (state === CAPABILITY_INSTALL_STATE.FAILED || state === CAPABILITY_INSTALL_STATE.REWORK) {
      this.retainTerminalOperation(operationId);
    }
  }

  private async handleConfirm(frame: CapabilityOperationConfirmFrame): Promise<void> {
    const record = this.operations.get(frame.operationId);
    if (!this.options.isFullDaemon || !record) {
      await this.options.send({
        type: CAPABILITY_OPERATION_MSG.PROGRESS,
        operationId: frame.operationId,
        expectedRevision: frame.expectedRevision,
        state: CAPABILITY_INSTALL_STATE.FAILED,
        errorCode: record ? CAPABILITY_ERROR.FORBIDDEN : CAPABILITY_ERROR.NOT_FOUND,
        errorMessage: record ? 'Capability confirmation is not authorized' : 'Capability operation is not present on this daemon',
      });
      return;
    }
    const current = record.service.status({ operationId: record.localOperationId });
    if (frame.decision === CAPABILITY_CONFIRMATION_DECISION.CANCEL
      && current.status === 'ok'
      && current.operation?.state === CAPABILITY_INSTALL_STATE.CANCELLED) {
      await this.options.send(progressFromResult(frame.operationId, frame.expectedRevision, current));
      return;
    }
    if (current.status !== 'ok' || !current.operation || !confirmationMatches(frame, record.request, current.operation)) {
      await this.options.send({
        type: CAPABILITY_OPERATION_MSG.PROGRESS,
        operationId: frame.operationId,
        expectedRevision: frame.expectedRevision,
        state: CAPABILITY_INSTALL_STATE.FAILED,
        errorCode: CAPABILITY_ERROR.CONFIRMATION_STALE,
        errorMessage: 'Capability confirmation does not match current reviewed evidence',
      });
      return;
    }
    const confirmed = record.service.confirm({
      operationId: record.localOperationId,
      revision: current.operation.revision,
      artifactDigest: frame.artifactDigest,
      auditDigest: frame.auditDigest,
      decision: frame.decision,
    });
    if (frame.decision === CAPABILITY_CONFIRMATION_DECISION.CANCEL) {
      this.journal.deleteCandidate(frame.operationId);
    }
    if (confirmed.status !== 'ok' || confirmed.operation.state !== CAPABILITY_INSTALL_STATE.INSTALLING) {
      await this.options.send(progressFromResult(frame.operationId, frame.expectedRevision, confirmed));
      return;
    }
    try {
      this.persistCandidate(frame.operationId, record, confirmed.operation);
    } catch (error) {
      const code = error instanceof CapabilityJournalCapacityError
        ? CAPABILITY_ERROR.RATE_LIMITED
        : CAPABILITY_ERROR.INTERNAL_ERROR;
      const failed = record.service.failPreparedInstall(record.localOperationId, code);
      this.journal.deleteCandidate(frame.operationId);
      this.retainTerminalOperation(frame.operationId);
      await this.options.send(progressFromResult(frame.operationId, frame.expectedRevision, failed));
      return;
    }
    const candidateCapabilityId = record.request.capabilityId ?? frame.operationId;
    const candidateVersionId = confirmed.operation.artifactDigest!;
    const skillTransfer = record.request.kind === CAPABILITY_KIND.SKILL
      ? record.service.skillTransferArchive(record.localOperationId)
      : undefined;
    if (record.request.kind === CAPABILITY_KIND.SKILL && !skillTransfer) {
      await this.options.send(progressFromResult(frame.operationId, frame.expectedRevision, {
        status: 'error', reason: CAPABILITY_ERROR.INTEGRITY_FAILED,
        error: 'Reviewed Skill candidate transfer bytes could not be verified',
      }));
      return;
    }
    const binding: CapabilitySyncBinding = {
      id: `${frame.operationId}:candidate`,
      capabilityId: candidateCapabilityId,
      versionId: candidateVersionId,
      scope: record.request.scope,
      ...(record.request.scope === CAPABILITY_SCOPE.LOCAL
        ? { scopeId: this.options.serverId }
        : record.request.scopeId ? { scopeId: record.request.scopeId } : {}),
      providers: [...(record.request.providers ?? [])],
      machines: [...(record.request.machines ?? [])],
      active: true,
    };
    const capability = {
      id: candidateCapabilityId,
      revision: 1,
      kind: record.request.kind,
      name: confirmed.operation.displayName ?? record.request.displayName ?? record.request.kind,
      state: CAPABILITY_STATE.PENDING,
      scope: record.request.scope,
      versionId: candidateVersionId,
      version: 1,
      artifactDigest: confirmed.operation.artifactDigest,
      sourceKind: record.request.source.kind,
      findings: confirmed.operation.findings,
      sourceLabel: confirmed.operation.sourceLabel,
      tools: confirmed.operation.tools ?? [],
      permissions: confirmed.operation.permissions ?? [],
      hasScripts: confirmed.operation.hasScripts,
      hasExecutables: confirmed.operation.hasExecutables,
      ...(confirmed.operation.stdioCommand ? { stdioCommand: confirmed.operation.stdioCommand } : {}),
      readiness: record.request.kind === CAPABILITY_KIND.MCP
        ? CAPABILITY_READINESS.RUNTIME_PENDING
        : CAPABILITY_READINESS.CONTENT_MISSING,
      bindings: [binding],
      updatedAt: confirmed.operation.updatedAt,
    };
    const version: CapabilityVersion = {
      id: candidateVersionId,
      capabilityId: candidateCapabilityId,
      version: 1,
      artifactDigest: confirmed.operation.artifactDigest!,
      ...(skillTransfer ? {
        blobDigest: skillTransfer.blobDigest,
        blobByteSize: skillTransfer.blobByteSize,
      } : {}),
      auditDigest: confirmed.operation.auditDigest!,
      auditVerdict: CAPABILITY_AUDIT_VERDICT.PASS,
      sourceKind: record.request.source.kind,
      createdAt: confirmed.operation.updatedAt,
    };
    const activation: CapabilityOperationActivateFrame = {
      type: CAPABILITY_OPERATION_MSG.ACTIVATE,
      operationId: frame.operationId,
      expectedRevision: frame.expectedRevision,
      capability,
      version,
      binding,
      ...(record.request.kind === CAPABILITY_KIND.MCP
        ? { definition: record.service.mcpDefinition(record.localOperationId) }
        : {}),
    };
    const expiresAt = this.now() + CAPABILITY_LIMITS.PERSISTED_CANDIDATE_TTL_MS;
    if (!this.journal.putActivation(frame.operationId, activation, expiresAt)) {
      await this.options.send(progressFromResult(frame.operationId, frame.expectedRevision, {
        status: 'error', reason: CAPABILITY_ERROR.INTEGRITY_FAILED,
        error: 'Activation proposal could not be persisted', retryable: true,
      }));
      return;
    }
    this.pendingActivations.set(frame.operationId, { ownerId: record.ownerId, frame: activation, expiresAt });
    // Delivery failure is not proposal failure. The durable outbox is replayed
    // on reconnect/restart until AUTHORIZE advances the two-phase commit.
    await this.options.send(activation);
  }

  private async handleAuthorize(frame: CapabilityOperationAuthorizeFrame): Promise<void> {
    const record = this.operations.get(frame.operationId);
    const authorityRevision = frame.binding.authorization?.issuedRevision ?? frame.capability.revision;
    const fail = async (code: CapabilityErrorCode, message: string): Promise<void> => {
      await this.options.send({
        type: CAPABILITY_OPERATION_MSG.COMMIT_RESULT,
        operationId: frame.operationId,
        expectedRevision: frame.expectedRevision,
        capabilityId: typeof frame.capability.id === 'string' ? frame.capability.id : 'invalid',
        versionId: typeof frame.version.id === 'string' ? frame.version.id : 'invalid',
        bindingId: typeof frame.binding.id === 'string' ? frame.binding.id : 'invalid',
        authorityRevision,
        ok: false,
        errorCode: code,
        errorMessage: message,
      });
    };
    const pending = this.pendingCommits.get(frame.operationId);
    if (pending) {
      if (!pending.authorize
        || pending.result.capabilityId !== frame.capability.id
        || pending.result.versionId !== frame.version.id
        || pending.result.bindingId !== frame.binding.id
        || pending.result.authorityRevision !== authorityRevision
        || canonicalFrameIdentity(pending.authorize) !== canonicalFrameIdentity(frame)
        || (frame.binding.authorization !== undefined
          && frame.binding.authorization.ownerId !== pending.ownerId)) {
        await fail(CAPABILITY_ERROR.INTEGRITY_FAILED, 'Repeated authorization changed committed authority');
        return;
      }
      await this.options.send(pending.result);
      return;
    }
    if (!this.options.isFullDaemon || !record) {
      await fail(record ? CAPABILITY_ERROR.FORBIDDEN : CAPABILITY_ERROR.NOT_FOUND, 'Capability operation is not authorized on this daemon');
      return;
    }
    if (frame.expiresAt <= this.now()) {
      await fail(CAPABILITY_ERROR.CONFIRMATION_STALE, 'Capability authorization has expired');
      return;
    }
    const current = record.service.status({ operationId: record.localOperationId });
    if (current.status === 'ok'
      && current.operation?.state === CAPABILITY_INSTALL_STATE.INSTALLED
      && current.operation.capabilityId === frame.capability.id
      && current.operation.artifactDigest === frame.version.artifactDigest
      && current.operation.auditDigest === frame.version.auditDigest) {
      const committedStatus = record.service.status({ capabilityId: frame.capability.id });
      const committedBinding = committedStatus.status === 'ok'
        ? committedStatus.capability?.bindings?.find((binding) => binding.id === frame.binding.id)
        : undefined;
      const idempotent = committedStatus?.status === 'ok'
        && committedStatus.capability?.versionId === frame.version.id
        && committedStatus.capability.artifactDigest === frame.version.artifactDigest
        && committedBinding?.scope === frame.binding.scope
        && committedBinding.scopeId === frame.binding.scopeId
        && arraysEqual(committedBinding.providers, frame.binding.providers)
        && arraysEqual(committedBinding.machines, frame.binding.machines)
        && (record.request.kind !== CAPABILITY_KIND.SKILL
          || (frame.binding.authorization !== undefined
            && frame.binding.authorization.itemRevision === frame.capability.revision
            && frame.binding.authorization.issuedRevision === authorityRevision
            && verifyCapabilitySkillAuthorization({
              ownerId: record.ownerId,
              serverId: this.options.serverId,
              capabilityId: frame.capability.id,
              version: frame.version,
              binding: frame.binding,
              envelope: frame.binding.authorization,
              authorizationKeys: frame.authorizationKeys,
            })));
      if (!idempotent) {
        await fail(CAPABILITY_ERROR.INTEGRITY_FAILED, 'Repeated authorization does not match committed authority');
        return;
      }
      if (record.request.kind === CAPABILITY_KIND.SKILL
        && !setCapabilityAuthorizationKeys(record.ownerId, this.options.serverId, frame.authorizationKeys)) {
        await fail(CAPABILITY_ERROR.INTEGRITY_FAILED, 'Authorization trust keys are invalid');
        return;
      }
      const result: CapabilityOperationCommitResultFrame = {
        type: CAPABILITY_OPERATION_MSG.COMMIT_RESULT,
        operationId: frame.operationId,
        expectedRevision: frame.expectedRevision,
        capabilityId: frame.capability.id,
        versionId: frame.version.id,
        bindingId: frame.binding.id,
        authorityRevision,
        ok: true,
      };
      const rollbackSnapshot = record.service.captureAuthorizedState(frame.capability.id, record.request.kind);
      this.pendingCommits.set(frame.operationId, {
        ownerId: record.ownerId,
        result,
        authorize: structuredClone(frame),
        rollback: () => true,
        rollbackSnapshot,
        ...(frame.binding.authorization ? {
          authority: {
            capabilityId: frame.capability.id,
            versionId: frame.version.id,
            bindingId: frame.binding.id,
            state: frame.binding.authorization.bindingState,
            itemRevision: frame.binding.authorization.itemRevision,
            bindingRevision: frame.binding.authorization.bindingRevision,
            authorization: frame.binding.authorization,
          },
          authorizationKeys: frame.authorizationKeys,
        } : {}),
      });
      this.journal.putCommit({
        ownerId: record.ownerId,
        result,
        rollback: rollbackSnapshot,
        authorize: structuredClone(frame),
        ...(frame.binding.authorization ? { authority: this.pendingCommits.get(frame.operationId)!.authority, authorizationKeys: frame.authorizationKeys } : {}),
      });
      this.pendingActivations.delete(frame.operationId);
      this.journal.clearActivation(frame.operationId);
      await this.options.send(result);
      return;
    }
    const archive = record.request.kind === CAPABILITY_KIND.SKILL
      ? record.service.skillTransferArchive(record.localOperationId)
      : undefined;
    const exact = current.status === 'ok'
      && current.operation?.state === CAPABILITY_INSTALL_STATE.INSTALLING
      && frame.capability.kind === record.request.kind
      && (!record.request.capabilityId || record.request.capabilityId === frame.capability.id)
      && frame.version.capabilityId === frame.capability.id
      && frame.binding.capabilityId === frame.capability.id
      && frame.binding.versionId === frame.version.id
      && frame.version.artifactDigest === current.operation.artifactDigest
      && frame.version.auditDigest === current.operation.auditDigest
      && frame.binding.scope === record.request.scope
      && frame.binding.scopeId === (record.request.scope === CAPABILITY_SCOPE.LOCAL
        ? this.options.serverId
        : record.request.scopeId)
      && arraysEqual(frame.binding.providers, record.request.providers ?? [])
      && arraysEqual(frame.binding.machines, record.request.machines ?? [])
      && (record.request.kind !== CAPABILITY_KIND.SKILL
        || (archive !== undefined
          && archive.blobDigest === frame.version.blobDigest
          && archive.blobByteSize === frame.version.blobByteSize
          && frame.binding.authorization !== undefined
          && frame.binding.authorization.itemRevision === frame.capability.revision
          && frame.binding.authorization.issuedRevision === authorityRevision
          && verifyCapabilitySkillAuthorization({
            ownerId: record.ownerId,
            serverId: this.options.serverId,
            capabilityId: frame.capability.id,
            version: frame.version,
            binding: frame.binding,
            envelope: frame.binding.authorization,
            authorizationKeys: frame.authorizationKeys,
          })));
    if (!exact) {
      await fail(CAPABILITY_ERROR.INTEGRITY_FAILED, 'Authoritative capability identity or reviewed evidence does not match');
      return;
    }
    if (record.request.kind === CAPABILITY_KIND.SKILL
      && !setCapabilityAuthorizationKeys(record.ownerId, this.options.serverId, frame.authorizationKeys)) {
      await fail(CAPABILITY_ERROR.INTEGRITY_FAILED, 'Authorization trust keys are invalid');
      return;
    }
    const rollbackSnapshot = record.service.captureAuthorizedState(frame.capability.id, record.request.kind);
    const result: CapabilityOperationCommitResultFrame = {
      type: CAPABILITY_OPERATION_MSG.COMMIT_RESULT,
      operationId: frame.operationId,
      expectedRevision: frame.expectedRevision,
      capabilityId: frame.capability.id,
      versionId: frame.version.id,
      bindingId: frame.binding.id,
      authorityRevision,
      ok: true,
    };
    const authority = frame.binding.authorization ? {
      capabilityId: frame.capability.id,
      versionId: frame.version.id,
      bindingId: frame.binding.id,
      state: frame.binding.authorization.bindingState,
      itemRevision: frame.binding.authorization.itemRevision,
      bindingRevision: frame.binding.authorization.bindingRevision,
      authorization: frame.binding.authorization,
    } : undefined;
    // Pre-publication WAL: the exact prior state and authoritative proposal
    // must be durable before any resolver-visible package/store mutation.
    this.journal.putCommit({
      ownerId: record.ownerId,
      result,
      rollback: rollbackSnapshot,
      authorize: structuredClone(frame),
      ...(authority ? { authority, authorizationKeys: frame.authorizationKeys } : {}),
      committing: true,
    });
    const committed = record.service.commitAuthorized({
      operationId: record.localOperationId,
      capability: frame.capability,
      versionId: frame.version.id,
      binding: frame.binding,
    });
    if (!committed) {
      this.journal.deleteCommit(frame.operationId);
      await fail(CAPABILITY_ERROR.INTEGRITY_FAILED, 'Authorized candidate could not be published');
      return;
    }
    this.options.afterAuthorizedMutation?.();
    this.pendingCommits.set(frame.operationId, {
      ownerId: record.ownerId,
      result,
      authorize: structuredClone(frame),
      rollback: () => { committed.rollback(); return true; },
      rollbackSnapshot,
      ...(authority ? {
        authority,
        authorizationKeys: frame.authorizationKeys,
      } : {}),
    });
    const durable = this.pendingCommits.get(frame.operationId)!;
    this.journal.putCommit({
      ownerId: durable.ownerId,
      result: durable.result,
      rollback: rollbackSnapshot,
      authorize: structuredClone(frame),
      ...(durable.authority ? { authority: durable.authority } : {}),
      ...(durable.authorizationKeys ? { authorizationKeys: durable.authorizationKeys } : {}),
      committing: false,
    });
    this.pendingActivations.delete(frame.operationId);
    this.journal.clearActivation(frame.operationId);
    // Delivery failure is not commit failure. Retain the durable/local outbox
    // and replay it on duplicate AUTHORIZE or reconnect until ACK/ABORT.
    await this.options.send(result);
  }

  private handleCommitAck(frame: CapabilityOperationCommitAckFrame): void {
    const pending = this.pendingCommits.get(frame.operationId);
    if (!pending || pending.result.capabilityId !== frame.capabilityId
      || pending.result.versionId !== frame.versionId
      || pending.result.bindingId !== frame.bindingId
      || pending.result.authorityRevision !== frame.authorityRevision) return;
    // ACK closes the durable transaction only. Resolver authority is replaced
    // exclusively by the next complete-current AUTHORITY frame; item/binding
    // revisions are not interchangeable with the account authority cursor.
    this.pendingCommits.delete(frame.operationId);
    this.journal.deleteCommit(frame.operationId);
    this.journal.deleteCandidate(frame.operationId);
    this.operations.delete(frame.operationId);
  }

  private async handleCommitAbort(frame: CapabilityOperationCommitAbortFrame): Promise<void> {
    const pending = this.pendingCommits.get(frame.operationId);
    if (!pending || pending.result.capabilityId !== frame.capabilityId
      || pending.result.versionId !== frame.versionId
      || pending.result.bindingId !== frame.bindingId
      || pending.result.authorityRevision !== frame.authorityRevision) return;
    pending.abort = structuredClone(frame);
    if (pending.rollbackSnapshot) {
      this.journal.putCommit({
        ownerId: pending.ownerId, result: pending.result, rollback: pending.rollbackSnapshot,
        ...(pending.authorize ? { authorize: pending.authorize } : {}),
        ...(pending.authority ? { authority: pending.authority } : {}),
        ...(pending.authorizationKeys ? { authorizationKeys: pending.authorizationKeys } : {}),
        abort: structuredClone(frame), committing: false,
      });
    }
    await this.compensateCommitAbort(frame.operationId, pending);
  }

  private async compensateCommitAbort(operationId: string, pending: PendingCommit): Promise<boolean> {
    let rolledBack = false;
    try {
      rolledBack = pending.rollback();
    } catch {
      rolledBack = false;
    }
    if (!rolledBack) return false;
    this.pendingCommits.delete(operationId);
    this.journal.deleteCommit(operationId);
    this.journal.deleteCandidate(operationId);
    this.operations.delete(operationId);
    return true;
  }

  private async handleManage(frame: CapabilityOperationManageFrame): Promise<void> {
    const makeResult = (result: Omit<CapabilityOperationManageResultFrame, 'type' | 'requestId' | 'capabilityId' | 'bindingId' | 'action' | 'expectedRevision' | 'authorityRevision'>): CapabilityOperationManageResultFrame => ({
        type: CAPABILITY_OPERATION_MSG.MANAGE_RESULT,
        requestId: frame.requestId,
        capabilityId: frame.capabilityId,
        bindingId: frame.bindingId,
        action: frame.action,
        expectedRevision: frame.expectedRevision,
        authorityRevision: frame.authorityRevision,
        ...result,
      });
    const send = async (result: Omit<CapabilityOperationManageResultFrame, 'type' | 'requestId' | 'capabilityId' | 'bindingId' | 'action' | 'expectedRevision' | 'authorityRevision'>): Promise<CapabilityOperationManageResultFrame> => {
      const outbound = makeResult(result);
      await this.options.send(outbound);
      return outbound;
    };
    if (!this.options.isFullDaemon || frame.serverId !== this.options.serverId) {
      await send({ phase: CAPABILITY_MANAGE_RESULT_PHASE.ABORTED, ok: false, errorCode: CAPABILITY_ERROR.FORBIDDEN, errorMessage: 'Local capability management requires a FULL daemon' });
      return;
    }
    const ownerService = this.options.serviceForOwner(frame.ownerId);
    const existing = this.pendingManages.get(frame.requestId);
    if (!existing && this.pendingManages.size >= CAPABILITY_LIMITS.RETAINED_TERMINAL_OPERATIONS) {
      await send({
        phase: CAPABILITY_MANAGE_RESULT_PHASE.ABORTED,
        ok: false,
        errorCode: CAPABILITY_ERROR.RATE_LIMITED,
        errorMessage: 'Too many unacknowledged local capability management operations',
      });
      return;
    }
    if (existing) {
      const unchanged = existing.ownerId === frame.ownerId
        && existing.frame.serverId === frame.serverId
        && existing.frame.capabilityId === frame.capabilityId
        && existing.frame.bindingId === frame.bindingId
        && existing.frame.action === frame.action
        && existing.frame.expectedRevision === frame.expectedRevision
        && existing.frame.authorityRevision === frame.authorityRevision
        && existing.frame.versionId === frame.versionId;
      if (!unchanged) {
        await send({ phase: CAPABILITY_MANAGE_RESULT_PHASE.ABORTED, ok: false, errorCode: CAPABILITY_ERROR.CONFLICT, errorMessage: 'Management retry changed the exact authority target' });
        return;
      }
      if (frame.phase === CAPABILITY_MANAGE_PHASE.ABORT) {
        if (existing.result.phase === CAPABILITY_MANAGE_RESULT_PHASE.APPLIED && existing.rollbackSnapshot) {
          if (!ownerService.restoreManageState(existing.rollbackSnapshot)) {
            await send({ phase: CAPABILITY_MANAGE_RESULT_PHASE.ABORTED, ok: false, errorCode: CAPABILITY_ERROR.INTEGRITY_FAILED, errorMessage: 'Exact management rollback failed closed' });
            return;
          }
        }
        const aborted = makeResult({ phase: CAPABILITY_MANAGE_RESULT_PHASE.ABORTED, ok: true });
        const next = { ownerId: frame.ownerId, frame: structuredClone(frame), result: aborted, ...(existing.rollbackSnapshot ? { rollbackSnapshot: existing.rollbackSnapshot } : {}) };
        this.pendingManages.set(frame.requestId, next);
        this.journal.putManage({ ownerId: next.ownerId, frame: next.frame, result: next.result, ...(next.rollbackSnapshot ? { rollback: next.rollbackSnapshot } : {}) });
        await this.options.send(aborted);
        return;
      }
      if (frame.phase === CAPABILITY_MANAGE_PHASE.PREPARE || existing.result.phase === CAPABILITY_MANAGE_RESULT_PHASE.APPLIED) {
        await this.options.send(existing.result);
        return;
      }
    }
    if (frame.phase === CAPABILITY_MANAGE_PHASE.ABORT) {
      const aborted = await send({ phase: CAPABILITY_MANAGE_RESULT_PHASE.ABORTED, ok: true });
      this.pendingManages.set(frame.requestId, { ownerId: frame.ownerId, frame: structuredClone(frame), result: aborted });
      this.journal.putManage({ ownerId: frame.ownerId, frame: structuredClone(frame), result: aborted });
      return;
    }
    if (frame.phase === CAPABILITY_MANAGE_PHASE.PREPARE) {
      const status = ownerService.status({ capabilityId: frame.capabilityId });
      const capability = status.status === 'ok' ? status.capability : undefined;
      const binding = capability?.bindings?.find((candidate) => candidate.id === frame.bindingId);
      if (!capability || !binding) {
        await send({ phase: CAPABILITY_MANAGE_RESULT_PHASE.ABORTED, ok: false, errorCode: CAPABILITY_ERROR.NOT_FOUND, errorMessage: 'Exact local capability binding was not found' });
        return;
      }
      if (binding.scope !== CAPABILITY_SCOPE.LOCAL || binding.scopeId !== frame.serverId) {
        await send({ phase: CAPABILITY_MANAGE_RESULT_PHASE.ABORTED, ok: false, errorCode: CAPABILITY_ERROR.FORBIDDEN, errorMessage: 'Capability binding is not owned by this daemon' });
        return;
      }
      if (capability.revision !== frame.expectedRevision || frame.authorityRevision <= frame.expectedRevision) {
        await send({ phase: CAPABILITY_MANAGE_RESULT_PHASE.ABORTED, ok: false, errorCode: CAPABILITY_ERROR.CONFLICT, errorMessage: 'Capability authority revision is stale' });
        return;
      }
      if (capability.kind === CAPABILITY_KIND.SKILL) {
        const state = frame.action === CAPABILITY_MANAGE_ACTION.UNINSTALL
          ? CAPABILITY_AUTHORITY_STATE.REMOVED
          : frame.action === CAPABILITY_MANAGE_ACTION.DISABLE
            ? CAPABILITY_AUTHORITY_STATE.DISABLED
            : CAPABILITY_AUTHORITY_STATE.ACTIVE;
        const keys = getCapabilityAuthorizationKeys(frame.ownerId, frame.serverId);
        if (!frame.authorization || !keys || !verifyCapabilityAuthorityRecord(frame.ownerId, {
          capabilityId: frame.capabilityId,
          versionId: frame.authorization.versionId,
          bindingId: frame.bindingId,
          state,
          itemRevision: frame.authorization.itemRevision,
          bindingRevision: frame.authorization.bindingRevision,
          authorization: frame.authorization,
        }, keys) || frame.authorization.issuedRevision !== frame.authorityRevision) {
          await send({ phase: CAPABILITY_MANAGE_RESULT_PHASE.ABORTED, ok: false, errorCode: CAPABILITY_ERROR.INTEGRITY_FAILED, errorMessage: 'Management authorization is invalid or stale' });
          return;
        }
      }
      const prepared = makeResult({ phase: CAPABILITY_MANAGE_RESULT_PHASE.PREPARED, ok: true, activeVersionId: capability.versionId, state: capability.state });
      this.pendingManages.set(frame.requestId, { ownerId: frame.ownerId, frame: structuredClone(frame), result: prepared });
      this.journal.putManage({ ownerId: frame.ownerId, frame: structuredClone(frame), result: prepared });
      await this.options.send(prepared);
      return;
    }
    if (!existing || existing.result.phase !== CAPABILITY_MANAGE_RESULT_PHASE.PREPARED) {
      await send({ phase: CAPABILITY_MANAGE_RESULT_PHASE.ABORTED, ok: false, errorCode: CAPABILITY_ERROR.CONFLICT, errorMessage: 'Management COMMIT has no matching durable PREPARE' });
      return;
    }
    const rollbackSnapshot = ownerService.captureManageState(frame.capabilityId);
    if (!rollbackSnapshot) {
      await send({ phase: CAPABILITY_MANAGE_RESULT_PHASE.ABORTED, ok: false, errorCode: CAPABILITY_ERROR.NOT_FOUND, errorMessage: 'Exact local capability state is unavailable' });
      return;
    }
    // WAL boundary: durable exact rollback bytes and intent must reach disk
    // before any package/index/local-MCP mutation can begin.
    this.pendingManages.set(frame.requestId, {
      ownerId: frame.ownerId,
      frame: structuredClone(frame),
      result: existing.result,
      rollbackSnapshot,
    });
    this.journal.putManage({
      ownerId: frame.ownerId,
      frame: structuredClone(frame),
      result: existing.result,
      rollback: rollbackSnapshot,
      committing: true,
    });
    const skillResult = ownerService.manageExactLocal({
      serverId: frame.serverId,
      capabilityId: frame.capabilityId,
      bindingId: frame.bindingId,
      action: frame.action,
      expectedRevision: frame.expectedRevision,
      finalAuthorityRevision: frame.authorityRevision,
      ...(frame.authorization ? { authorization: frame.authorization } : {}),
      ...(frame.versionId ? { versionId: frame.versionId } : {}),
    });
    const result = !skillResult.ok && skillResult.code === 'not_found'
      ? ownerService.manageExactLocalMcp({
        serverId: frame.serverId,
        capabilityId: frame.capabilityId,
        bindingId: frame.bindingId,
        action: frame.action,
        expectedRevision: frame.expectedRevision,
        finalAuthorityRevision: frame.authorityRevision,
        ...(frame.versionId ? { versionId: frame.versionId } : {}),
      })
      : skillResult;
    if (result.ok) this.options.afterManageMutation?.();
    if (!result.ok) {
      ownerService.discardRollbackSnapshot(rollbackSnapshot);
      const code = result.code === 'not_found' ? CAPABILITY_ERROR.NOT_FOUND
        : result.code === 'forbidden' ? CAPABILITY_ERROR.FORBIDDEN
          : result.code === 'conflict' ? CAPABILITY_ERROR.CONFLICT
            : result.code === 'integrity_failed' ? CAPABILITY_ERROR.INTEGRITY_FAILED
              : CAPABILITY_ERROR.INVALID_INPUT;
      const failed = await send({ phase: CAPABILITY_MANAGE_RESULT_PHASE.ABORTED, ok: false, errorCode: code, errorMessage: `Local capability ${result.code}` });
      this.pendingManages.set(frame.requestId, { ownerId: frame.ownerId, frame: structuredClone(frame), result: failed });
      this.journal.putManage({ ownerId: frame.ownerId, frame: structuredClone(frame), result: failed });
      return;
    }
    const activeVersionId = 'entry' in result ? result.entry.activeVersionId : result.capability.versionId;
    const state = 'entry' in result ? result.entry.state : result.capability.state;
    const applied = makeResult({
      phase: CAPABILITY_MANAGE_RESULT_PHASE.APPLIED,
      ok: true,
      ...(activeVersionId ? { activeVersionId } : {}),
      state,
    });
    this.pendingManages.set(frame.requestId, { ownerId: frame.ownerId, frame: structuredClone(frame), result: applied, rollbackSnapshot });
    this.journal.putManage({ ownerId: frame.ownerId, frame: structuredClone(frame), result: applied, rollback: rollbackSnapshot });
    await this.options.send(applied);
  }

  private handleManageAck(frame: CapabilityOperationManageAckFrame): void {
    const pending = this.pendingManages.get(frame.requestId);
    if (!pending || pending.frame.capabilityId !== frame.capabilityId
      || pending.frame.bindingId !== frame.bindingId
      || pending.frame.authorityRevision !== frame.authorityRevision) return;
    // As with install ACK, management ACK only releases the WAL. The exact
    // current authority becomes visible when the authenticated complete
    // AUTHORITY frame arrives, never from this item-revision acknowledgement.
    if (pending.rollbackSnapshot) this.options.serviceForOwner(pending.ownerId).discardRollbackSnapshot(pending.rollbackSnapshot);
    this.pendingManages.delete(frame.requestId);
    this.journal.deleteManage(frame.requestId);
  }

  private async handleCancel(frame: CapabilityOperationCancelFrame): Promise<void> {
    const record = this.operations.get(frame.operationId);
    if (!this.options.isFullDaemon || !record) {
      await this.options.send({
        type: CAPABILITY_OPERATION_MSG.PROGRESS,
        operationId: frame.operationId,
        expectedRevision: frame.expectedRevision,
        state: CAPABILITY_INSTALL_STATE.FAILED,
        errorCode: record ? CAPABILITY_ERROR.FORBIDDEN : CAPABILITY_ERROR.NOT_FOUND,
        errorMessage: record
          ? 'Capability cancellation is not authorized on this daemon'
          : 'Capability operation is not present on this daemon',
      });
      return;
    }
    const cancelled = await record.service.manage({
      action: CAPABILITY_MANAGE_ACTION.CANCEL_OPERATION,
      operationId: record.localOperationId,
    });
    if (cancelled.status === 'ok' && cancelled.operation?.state === CAPABILITY_INSTALL_STATE.CANCELLED) {
      this.journal.deleteCandidate(frame.operationId);
      this.retainTerminalOperation(frame.operationId);
    }
    if (cancelled.status === 'ok' && cancelled.operation?.state === CAPABILITY_INSTALL_STATE.INSTALLING) {
      await this.options.send({
        type: CAPABILITY_OPERATION_MSG.PROGRESS,
        operationId: frame.operationId,
        expectedRevision: frame.expectedRevision,
        state: CAPABILITY_INSTALL_STATE.INSTALLING,
        errorCode: CAPABILITY_ERROR.CONFLICT,
        errorMessage: 'Capability commit is already irreversible and cannot be cancelled',
      });
      return;
    }
    await this.options.send(progressFromResult(frame.operationId, frame.expectedRevision, cancelled));
  }
}

export const CAPABILITY_OPERATION_HANDLER_TESTING = {
  isInstallFrame,
  isConfirmFrame,
  isCancelFrame,
  isAuthorizeFrame,
  isManageFrame,
  isBlobUploadFrame,
  progressFromResult,
};
