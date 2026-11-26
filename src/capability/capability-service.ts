import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { rmSync } from 'node:fs';
import type { ContextNamespace } from '../../shared/context-types.js';
import {
  CAPABILITY_AUDIT_VERDICT,
  CAPABILITY_CONFIRMATION_DECISION,
  CAPABILITY_ERROR,
  CAPABILITY_KIND,
  CAPABILITY_LIMITS,
  CAPABILITY_MANAGE_ACTION,
  CAPABILITY_INSTALL_STATES,
  CAPABILITY_INSTALL_STATE,
  CAPABILITY_SCOPE,
  CAPABILITY_STATE,
  isCapabilityInstallTerminal,
  isCapabilityInstallCancellable,
  CAPABILITY_MANAGEMENT_ACTIONS,
  type CapabilityInstallState,
  type CapabilityManagementAction,
} from '../../shared/capability-management.js';
import {
  CAPABILITY_AUDIT_POLICY_VERSION,
  CapabilityAuditError,
  buildCapabilityAuditEnvelope,
  mergeCapabilityAuditFindings,
  runCapabilityAudit,
  verifyCapabilityAuditEvidence,
  type CapabilityAuditEvidence,
  type CapabilityAuditRunner,
} from './capability-audit.js';
import { acquireSkillPackage, type AcquiredSkillPackage, type SkillAcquisitionSource } from './skill-acquisition.js';
import { inventoryAgentSkillPackage } from './agent-skill-package.js';
import {
  publishManagedSkillVersion,
  readManagedSkillIndex,
  restoreManagedSkillVersion,
  trashManagedSkillVersion,
  updateManagedSkillEntry,
  verifyManagedSkillVersion,
  writeManagedSkillIndex,
  type ManagedSkillBinding,
  type ManagedSkillIndexEntry,
} from './managed-skill-store.js';
import { getManagedSkillManifestPath, getManagedSkillVersionPath } from './managed-skill-paths.js';
import { buildSkillTransferArchive, type SkillTransferArchive } from './skill-transfer-archive.js';
import { scanAgentSkillPackage, type SkillScanResult } from './skill-scanner.js';

export const LOCAL_CAPABILITY_OPERATION_STATES = CAPABILITY_INSTALL_STATES;
export type LocalCapabilityOperationState = CapabilityInstallState;
export const LOCAL_CAPABILITY_MANAGEMENT_ACTIONS = CAPABILITY_MANAGEMENT_ACTIONS;
export type LocalCapabilityManagementAction = Exclude<CapabilityManagementAction, typeof CAPABILITY_MANAGE_ACTION.CANCEL_OPERATION>;

export interface CapabilityOperationView {
  operationId: string;
  state: LocalCapabilityOperationState;
  revision: number;
  kind: typeof CAPABILITY_KIND.SKILL;
  registryId?: string;
  artifactDigest?: string;
  scannerDigest?: string;
  auditDigest?: string;
  auditVerdict?: CapabilityAuditEvidence['verdict'];
  skill?: {
    name: string;
    description: string;
    source: string;
    scripts: string[];
    executables: string[];
    requestedTools: string[];
  };
  findings?: Array<{ code: string; severity: string; path?: string; summary: string }>;
  error?: { code: string; retryable: boolean };
  createdAt: number;
  updatedAt: number;
}

interface InternalCapabilityOperation extends CapabilityOperationView {
  ownerId: string;
  idempotencyKey: string;
  source: SkillAcquisitionSource;
  bindings: ManagedSkillBinding[];
  acquired?: AcquiredSkillPackage;
  scan?: SkillScanResult;
  audit?: CapabilityAuditEvidence;
  auditAbortController?: AbortController;
  cancelled: boolean;
}

export interface CapabilityInstallInput {
  ownerId: string;
  conversationIdentity: string;
  idempotencyKey: string;
  source: SkillAcquisitionSource;
  bindings: ManagedSkillBinding[];
}

export interface CapabilityInstallStart {
  operation: CapabilityOperationView;
  completion: Promise<CapabilityOperationView>;
}

export interface CapabilityReviewedSkillEvidence {
  scan: SkillScanResult;
  audit: CapabilityAuditEvidence;
}

export interface CapabilityConfirmationInput {
  operationId: string;
  ownerId: string;
  revision: number;
  artifactDigest: string;
  auditDigest: string;
  decision: 'install' | 'cancel';
  origin: 'browser';
}

export interface CapabilityAuthorizedCommitInput {
  operationId: string;
  ownerId: string;
  registryId: string;
  versionId: string;
  authorityRevision: number;
  binding: ManagedSkillBinding;
}

export interface CapabilityAuthorizedCommitResult {
  operation: CapabilityOperationView;
  rollback(): void;
}

export interface CapabilityManageInput {
  ownerId: string;
  registryId?: string;
  name?: string;
  action: LocalCapabilityManagementAction;
  versionId?: string;
  trashId?: string;
  scope?: ManagedSkillBinding['scope'];
  expectedRevision?: number;
}

export type CapabilityManageResult =
  | { ok: true; item: ManagedSkillIndexEntry }
  | { ok: true; deletedCredentials: true }
  | { ok: false; code: 'ambiguous_target'; choices: Array<{ registryId: string; name: string; scopes: string[] }> }
  | { ok: false; code: 'not_found' | 'invalid_action' | 'conflict' };

export interface CapabilityServiceOptions {
  auditRunner: CapabilityAuditRunner;
  homeDir?: string;
  now?: () => number;
  deleteCredentials?: (registryId: string, ownerId: string) => Promise<void>;
  onAuditEvent?: (event: { action: string; ownerId: string; registryId?: string; operationId?: string; outcome: string }) => void;
}

function cloneView(operation: InternalCapabilityOperation): CapabilityOperationView {
  const {
    ownerId,
    idempotencyKey,
    source,
    bindings,
    acquired,
    scan,
    audit,
    auditAbortController,
    cancelled,
    ...view
  } = operation;
  // Keep private installation state out of the public view without cloning
  // live objects such as AbortController.
  void ownerId;
  void idempotencyKey;
  void source;
  void bindings;
  void acquired;
  void scan;
  void audit;
  void auditAbortController;
  void cancelled;
  return structuredClone(view);
}

function operationError(error: unknown): { code: string; retryable: boolean } {
  const code = error instanceof CapabilityAuditError
    ? error.code
    : (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'capability_install_failed');
  return { code, retryable: code === 'audit_unavailable' || code === 'unsupported_source' };
}

export class DaemonCapabilityService {
  private readonly operations = new Map<string, InternalCapabilityOperation>();
  private readonly operationByIdempotency = new Map<string, string>();
  private readonly completionByOperation = new Map<string, Promise<CapabilityOperationView>>();
  private readonly listenersByOperation = new Map<string, Set<(operation: CapabilityOperationView) => void>>();
  private readonly homeDir: string;
  private readonly now: () => number;

  constructor(private readonly options: CapabilityServiceOptions) {
    this.homeDir = options.homeDir ?? homedir();
    this.now = options.now ?? Date.now;
  }

  list(input: { ownerId: string; namespace?: ContextNamespace; sessionId?: string }): ManagedSkillIndexEntry[] {
    return readManagedSkillIndex(this.homeDir).entries
      .filter((entry) => entry.bindings.some((binding) => this.bindingApplies(binding, input.ownerId, input.namespace, input.sessionId)))
      .map((entry) => structuredClone(entry));
  }

  status(operationId: string, ownerId: string): CapabilityOperationView | undefined {
    const operation = this.operations.get(operationId);
    return operation?.ownerId === ownerId ? cloneView(operation) : undefined;
  }

  reviewEvidence(operationId: string, ownerId: string): CapabilityReviewedSkillEvidence | undefined {
    const operation = this.operations.get(operationId);
    return operation?.ownerId === ownerId && operation.scan && operation.audit
      ? { scan: structuredClone(operation.scan), audit: structuredClone(operation.audit) }
      : undefined;
  }

  async restoreReviewedInstall(
    input: CapabilityInstallInput,
    evidence: CapabilityReviewedSkillEvidence,
  ): Promise<CapabilityOperationView> {
    this.evictTerminalOperations();
    const activeJobs = [...this.operations.values()].filter((candidate) => !isCapabilityInstallTerminal(candidate.state)).length;
    const now = this.now();
    const operation: InternalCapabilityOperation = {
      operationId: randomUUID(), state: CAPABILITY_INSTALL_STATE.SCANNING, revision: 1,
      kind: CAPABILITY_KIND.SKILL, ownerId: input.ownerId, idempotencyKey: input.idempotencyKey,
      source: structuredClone(input.source), bindings: structuredClone(input.bindings),
      cancelled: false, createdAt: now, updatedAt: now,
    };
    this.operations.set(operation.operationId, operation);
    this.operationByIdempotency.set(`${input.ownerId}\0${input.idempotencyKey}`, operation.operationId);
    if (activeJobs >= CAPABILITY_LIMITS.ACTIVE_INSTALL_JOBS) {
      operation.error = { code: CAPABILITY_ERROR.RATE_LIMITED, retryable: true };
      operation.state = CAPABILITY_INSTALL_STATE.FAILED;
      return cloneView(operation);
    }
    try {
      operation.acquired = await acquireSkillPackage(input.source, this.homeDir);
      const scan = scanAgentSkillPackage(operation.acquired.inventory);
      if (scan.outcome !== 'pass'
        || scan.artifactDigest !== evidence.scan.artifactDigest
        || scan.scannerDigest !== evidence.scan.scannerDigest
        || operation.acquired.inventory.treeDigest !== evidence.audit.artifactDigest
        || scan.scannerDigest !== evidence.audit.scannerDigest
        || evidence.audit.verdict !== CAPABILITY_AUDIT_VERDICT.PASS
        || !verifyCapabilityAuditEvidence(evidence.audit)) {
        throw new Error('persisted reviewed evidence changed');
      }
      operation.scan = structuredClone(scan);
      operation.audit = structuredClone(evidence.audit);
      operation.artifactDigest = scan.artifactDigest;
      operation.scannerDigest = scan.scannerDigest;
      operation.auditDigest = evidence.audit.auditDigest;
      operation.auditVerdict = evidence.audit.verdict;
      operation.findings = structuredClone(evidence.audit.findings);
      operation.skill = {
        name: operation.acquired.inventory.frontMatter.name,
        description: operation.acquired.inventory.frontMatter.description,
        source: operation.acquired.sourceLabel,
        scripts: scan.scriptPaths,
        executables: scan.executablePaths,
        requestedTools: scan.requestedTools,
      };
      this.transition(operation, CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION);
    } catch (error) {
      operation.acquired?.cleanup();
      operation.acquired = undefined;
      operation.error = operationError(error);
      this.transition(operation, CAPABILITY_INSTALL_STATE.FAILED);
    }
    return cloneView(operation);
  }

  failPreparedInstall(operationId: string, ownerId: string, code: string): CapabilityOperationView | undefined {
    const operation = this.operations.get(operationId);
    if (!operation || operation.ownerId !== ownerId || operation.state === CAPABILITY_INSTALL_STATE.INSTALLED) return undefined;
    operation.acquired?.cleanup();
    operation.acquired = undefined;
    operation.error = { code, retryable: code === CAPABILITY_ERROR.RATE_LIMITED };
    this.transition(operation, CAPABILITY_INSTALL_STATE.FAILED);
    return cloneView(operation);
  }

  async install(input: CapabilityInstallInput): Promise<CapabilityOperationView> {
    return this.startInstall(input).completion;
  }

  startInstall(
    input: CapabilityInstallInput,
    onTransition?: (operation: CapabilityOperationView) => void,
  ): CapabilityInstallStart {
    const idempotencyIdentity = `${input.ownerId}\0${input.idempotencyKey}`;
    const existingId = this.operationByIdempotency.get(idempotencyIdentity);
    if (existingId) {
      const existing = this.operations.get(existingId);
      if (existing) {
        if (onTransition) this.addTransitionListener(existingId, onTransition);
        return {
          operation: cloneView(existing),
          completion: this.completionByOperation.get(existingId) ?? Promise.resolve(cloneView(existing)),
        };
      }
    }
    this.evictTerminalOperations();
    const activeJobs = [...this.operations.values()].filter((candidate) => !isCapabilityInstallTerminal(candidate.state)).length;
    const now = this.now();
    const operation: InternalCapabilityOperation = {
      operationId: randomUUID(),
      state: activeJobs >= CAPABILITY_LIMITS.ACTIVE_INSTALL_JOBS
        ? CAPABILITY_INSTALL_STATE.FAILED
        : CAPABILITY_INSTALL_STATE.QUEUED,
      revision: 1,
      kind: CAPABILITY_KIND.SKILL,
      ownerId: input.ownerId,
      idempotencyKey: input.idempotencyKey,
      source: structuredClone(input.source),
      bindings: structuredClone(input.bindings),
      cancelled: false,
      createdAt: now,
      updatedAt: now,
      ...(activeJobs >= CAPABILITY_LIMITS.ACTIVE_INSTALL_JOBS
        ? { error: { code: CAPABILITY_ERROR.RATE_LIMITED, retryable: true } }
        : {}),
    };
    this.operations.set(operation.operationId, operation);
    this.operationByIdempotency.set(idempotencyIdentity, operation.operationId);
    if (onTransition) this.addTransitionListener(operation.operationId, onTransition);
    if (operation.state === CAPABILITY_INSTALL_STATE.FAILED) {
      const completion = Promise.resolve(cloneView(operation));
      this.completionByOperation.set(operation.operationId, completion);
      return { operation: cloneView(operation), completion };
    }
    // Starting on the next microtask is intentional: callers can publish the
    // external->local operation mapping before acquisition/audit begins, so a
    // concurrent CANCEL is never rejected merely because the auditor is slow.
    const completion = Promise.resolve().then(() => this.runInstall(operation, input));
    this.completionByOperation.set(operation.operationId, completion);
    void completion.finally(() => {
      this.listenersByOperation.delete(operation.operationId);
    }).catch(() => undefined);
    return { operation: cloneView(operation), completion };
  }

  private evictTerminalOperations(): void {
    const terminal = [...this.operations.values()]
      .filter((operation) => isCapabilityInstallTerminal(operation.state))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    // Reserve one slot for the operation about to be inserted so the retained
    // terminal cap remains true after this start, not one over the cap.
    for (const operation of terminal.slice(Math.max(0, CAPABILITY_LIMITS.RETAINED_TERMINAL_OPERATIONS - 1))) {
      this.operations.delete(operation.operationId);
      this.completionByOperation.delete(operation.operationId);
      this.listenersByOperation.delete(operation.operationId);
      this.operationByIdempotency.delete(`${operation.ownerId}\0${operation.idempotencyKey}`);
    }
  }

  private async runInstall(
    operation: InternalCapabilityOperation,
    input: CapabilityInstallInput,
  ): Promise<CapabilityOperationView> {
    try {
      this.assertNotCancelled(operation);
      this.transition(operation, CAPABILITY_INSTALL_STATE.ACQUIRING);
      operation.acquired = await acquireSkillPackage(input.source, this.homeDir);
      this.assertNotCancelled(operation);
      this.transition(operation, CAPABILITY_INSTALL_STATE.SCANNING);
      operation.scan = scanAgentSkillPackage(operation.acquired.inventory);
      operation.artifactDigest = operation.acquired.inventory.treeDigest;
      operation.scannerDigest = operation.scan.scannerDigest;
      operation.skill = {
        name: operation.acquired.inventory.frontMatter.name,
        description: operation.acquired.inventory.frontMatter.description,
        source: operation.acquired.sourceLabel,
        scripts: operation.scan.scriptPaths,
        executables: operation.scan.executablePaths,
        requestedTools: operation.scan.requestedTools,
      };
      if (operation.scan.outcome === 'blocked') {
        operation.findings = operation.scan.findings.map((entry) => ({
          code: entry.code,
          severity: entry.severity,
          path: entry.path,
          summary: entry.message,
        }));
        this.transition(operation, CAPABILITY_INSTALL_STATE.REWORK);
        operation.acquired.cleanup();
        operation.acquired = undefined;
        return cloneView(operation);
      }
      this.assertNotCancelled(operation);
      this.transition(operation, CAPABILITY_INSTALL_STATE.AUDITING);
      const envelope = buildCapabilityAuditEnvelope(operation.acquired.inventory, operation.scan);
      const auditAbortController = new AbortController();
      operation.auditAbortController = auditAbortController;
      try {
        operation.audit = await runCapabilityAudit({
          runner: this.options.auditRunner,
          conversationIdentity: input.conversationIdentity,
          envelope,
          signal: auditAbortController.signal,
        });
      } finally {
        if (operation.auditAbortController === auditAbortController) operation.auditAbortController = undefined;
      }
      operation.auditDigest = operation.audit.auditDigest;
      operation.auditVerdict = operation.audit.verdict;
      operation.findings = mergeCapabilityAuditFindings(operation.scan, operation.audit.findings);
      if (operation.audit.verdict !== CAPABILITY_AUDIT_VERDICT.PASS) {
        this.transition(operation, CAPABILITY_INSTALL_STATE.REWORK);
        operation.acquired.cleanup();
        operation.acquired = undefined;
        return cloneView(operation);
      }
      this.assertNotCancelled(operation);
      this.transition(operation, CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION);
      return cloneView(operation);
    } catch (error) {
      operation.acquired?.cleanup();
      operation.acquired = undefined;
      if (operation.cancelled) {
        if (operation.state !== CAPABILITY_INSTALL_STATE.CANCELLED) this.transition(operation, CAPABILITY_INSTALL_STATE.CANCELLED);
      } else {
        operation.error = operationError(error);
        this.transition(operation, error instanceof CapabilityAuditError ? CAPABILITY_INSTALL_STATE.REWORK : CAPABILITY_INSTALL_STATE.FAILED);
      }
      return cloneView(operation);
    }
  }

  cancel(operationId: string, ownerId: string): CapabilityOperationView | undefined {
    const operation = this.operations.get(operationId);
    if (!operation || operation.ownerId !== ownerId) return undefined;
    if (isCapabilityInstallTerminal(operation.state) || !isCapabilityInstallCancellable(operation.state)) return cloneView(operation);
    operation.cancelled = true;
    operation.auditAbortController?.abort(new Error('capability operation cancelled'));
    operation.auditAbortController = undefined;
    operation.acquired?.cleanup();
    operation.acquired = undefined;
    this.transition(operation, CAPABILITY_INSTALL_STATE.CANCELLED);
    return cloneView(operation);
  }

  confirm(input: CapabilityConfirmationInput): CapabilityOperationView | undefined {
    const operation = this.operations.get(input.operationId);
    if (!operation || operation.ownerId !== input.ownerId) return undefined;
    if (
      input.origin !== 'browser'
      || operation.state !== CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION
      || operation.revision !== input.revision
      || operation.artifactDigest !== input.artifactDigest
      || operation.auditDigest !== input.auditDigest
      || !operation.acquired
      || !operation.scan
      || !operation.audit
    ) {
      return cloneView(operation);
    }
    if (input.decision === 'cancel') {
      operation.acquired.cleanup();
      operation.acquired = undefined;
      this.transition(operation, CAPABILITY_INSTALL_STATE.CANCELLED);
      return cloneView(operation);
    }
    return this.prepareOperationCommit(operation);
  }

  private prepareOperationCommit(operation: InternalCapabilityOperation): CapabilityOperationView {
    const acquired = operation.acquired;
    if (!acquired) return cloneView(operation);
    try {
      this.transition(operation, CAPABILITY_INSTALL_STATE.INSTALLING);
      const currentInventory = inventoryAgentSkillPackage(acquired.quarantinePath);
      if (currentInventory.treeDigest !== operation.artifactDigest) {
        operation.error = { code: 'artifact_digest_mismatch', retryable: false };
        this.transition(operation, CAPABILITY_INSTALL_STATE.REWORK);
        return cloneView(operation);
      }
      return cloneView(operation);
    } catch (error) {
      operation.error = operationError(error);
      this.transition(operation, CAPABILITY_INSTALL_STATE.FAILED);
      return cloneView(operation);
    }
  }

  candidateTransferArchive(operationId: string, ownerId: string): SkillTransferArchive | undefined {
    const operation = this.operations.get(operationId);
    if (!operation || operation.ownerId !== ownerId
      || (operation.state !== CAPABILITY_INSTALL_STATE.INSTALLING
        && operation.state !== CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION)
      || !operation.acquired || !operation.artifactDigest) return undefined;
    return buildSkillTransferArchive(operation.acquired.quarantinePath, operation.artifactDigest);
  }

  commitAuthorized(input: CapabilityAuthorizedCommitInput): CapabilityAuthorizedCommitResult | undefined {
    const operation = this.operations.get(input.operationId);
    if (!operation || operation.ownerId !== input.ownerId || operation.state !== CAPABILITY_INSTALL_STATE.INSTALLING
      || !operation.acquired || !operation.artifactDigest || !operation.scannerDigest || !operation.auditDigest) return undefined;
    const currentInventory = inventoryAgentSkillPackage(operation.acquired.quarantinePath);
    if (currentInventory.treeDigest !== operation.artifactDigest) return undefined;
    const before = readManagedSkillIndex(this.homeDir);
    const previous = before.entries.find((entry) => entry.registryId === input.registryId);
    publishManagedSkillVersion({
      registryId: input.registryId,
      versionId: input.versionId,
      quarantinePath: operation.acquired.quarantinePath,
      source: operation.skill?.source ?? 'unknown',
      scannerDigest: operation.scannerDigest,
      auditDigest: operation.auditDigest,
      auditPolicyVersion: CAPABILITY_AUDIT_POLICY_VERSION,
      bindings: [input.binding],
      now: this.now(),
    }, this.homeDir);
    updateManagedSkillEntry(input.registryId, (entry) => ({
      ...entry,
      authorityRevision: input.authorityRevision,
    }), this.homeDir);
    operation.registryId = input.registryId;
    operation.acquired.cleanup();
    operation.acquired = undefined;
    this.transition(operation, CAPABILITY_INSTALL_STATE.INSTALLED);
    this.options.onAuditEvent?.({
      action: CAPABILITY_CONFIRMATION_DECISION.INSTALL,
      ownerId: operation.ownerId,
      registryId: input.registryId,
      operationId: operation.operationId,
      outcome: CAPABILITY_INSTALL_STATE.INSTALLED,
    });
    return {
      operation: cloneView(operation),
      rollback: () => {
        const current = readManagedSkillIndex(this.homeDir);
        const installed = current.entries.find((entry) => entry.registryId === input.registryId);
        if (!installed || installed.activeVersionId !== input.versionId) {
          throw new Error('Authorized Skill changed before commit compensation');
        }
        rmSync(getManagedSkillVersionPath(this.homeDir, input.registryId, input.versionId), { recursive: true, force: true });
        rmSync(getManagedSkillManifestPath(this.homeDir, input.registryId, input.versionId), { force: true });
        writeManagedSkillIndex({
          ...current,
          revision: current.revision + 1,
          entries: [
            ...current.entries.filter((entry) => entry.registryId !== input.registryId),
            ...(previous ? [previous] : []),
          ].sort((left, right) => left.registryId < right.registryId ? -1 : left.registryId > right.registryId ? 1 : 0),
        }, this.homeDir);
        operation.error = { code: 'commit_delivery_failed', retryable: true };
        this.transition(operation, CAPABILITY_INSTALL_STATE.FAILED);
      },
    };
  }

  async manage(input: CapabilityManageInput): Promise<CapabilityManageResult> {
    const candidates = readManagedSkillIndex(this.homeDir).entries.filter((entry) => (
      input.registryId ? entry.registryId === input.registryId : entry.name === input.name
    )).filter((entry) => entry.bindings.some((binding) => !binding.ownerId || binding.ownerId === input.ownerId));
    const scoped = input.scope
      ? candidates.filter((entry) => entry.bindings.some((binding) => binding.scope === input.scope))
      : candidates;
    if (scoped.length === 0) return { ok: false, code: 'not_found' };
    if (scoped.length > 1) {
      return {
        ok: false,
        code: 'ambiguous_target',
        choices: scoped.slice(0, 20).map((entry) => ({
          registryId: entry.registryId,
          name: entry.name,
          scopes: [...new Set(entry.bindings.map((binding) => binding.scope))],
        })),
      };
    }
    const item = scoped[0];
    if (input.expectedRevision !== undefined && input.expectedRevision !== item.revision) {
      return { ok: false, code: 'conflict' };
    }
    if (input.action === CAPABILITY_MANAGE_ACTION.DELETE_CREDENTIALS) {
      if (!this.options.deleteCredentials) return { ok: false, code: 'invalid_action' };
      await this.options.deleteCredentials(item.registryId, input.ownerId);
      this.options.onAuditEvent?.({ action: input.action, ownerId: input.ownerId, registryId: item.registryId, outcome: 'deleted' });
      return { ok: true, deletedCredentials: true };
    }
    let updated: ManagedSkillIndexEntry;
    if (input.action === CAPABILITY_MANAGE_ACTION.ENABLE || input.action === CAPABILITY_MANAGE_ACTION.DISABLE) {
      updated = updateManagedSkillEntry(item.registryId, (entry) => ({
        ...entry,
        state: input.action === CAPABILITY_MANAGE_ACTION.ENABLE ? CAPABILITY_STATE.ACTIVE : CAPABILITY_STATE.DISABLED,
        revision: entry.revision + 1,
        updatedAt: this.now(),
      }), this.homeDir);
    } else if (input.action === CAPABILITY_MANAGE_ACTION.ROLLBACK) {
      if (!input.versionId || !item.versions.includes(input.versionId)) return { ok: false, code: 'invalid_action' };
      verifyManagedSkillVersion(this.homeDir, item.registryId, input.versionId);
      updated = updateManagedSkillEntry(item.registryId, (entry) => ({
        ...entry,
        activeVersionId: input.versionId,
        state: CAPABILITY_STATE.ACTIVE,
        revision: entry.revision + 1,
        updatedAt: this.now(),
      }), this.homeDir);
    } else if (input.action === CAPABILITY_MANAGE_ACTION.UNINSTALL) {
      if (!item.activeVersionId) return { ok: false, code: 'invalid_action' };
      trashManagedSkillVersion(this.homeDir, item.registryId, item.activeVersionId, this.now());
      updated = readManagedSkillIndex(this.homeDir).entries.find((entry) => entry.registryId === item.registryId)!;
    } else if (input.action === CAPABILITY_MANAGE_ACTION.RESTORE) {
      const trashId = input.trashId ?? item.trash?.at(-1)?.trashId;
      if (!trashId) return { ok: false, code: 'invalid_action' };
      updated = restoreManagedSkillVersion(this.homeDir, item.registryId, trashId, this.now());
    } else {
      return { ok: false, code: 'invalid_action' };
    }
    this.options.onAuditEvent?.({ action: input.action, ownerId: input.ownerId, registryId: item.registryId, outcome: 'ok' });
    return { ok: true, item: updated };
  }

  private transition(operation: InternalCapabilityOperation, state: LocalCapabilityOperationState): void {
    operation.state = state;
    operation.revision += 1;
    operation.updatedAt = this.now();
    const view = cloneView(operation);
    for (const listener of this.listenersByOperation.get(operation.operationId) ?? []) {
      try { listener(view); } catch { /* observation cannot break the state machine */ }
    }
  }

  private addTransitionListener(operationId: string, listener: (operation: CapabilityOperationView) => void): void {
    const listeners = this.listenersByOperation.get(operationId) ?? new Set();
    listeners.add(listener);
    this.listenersByOperation.set(operationId, listeners);
  }

  private assertNotCancelled(operation: InternalCapabilityOperation): void {
    if (operation.cancelled) throw new Error('operation_cancelled');
  }

  private bindingApplies(binding: ManagedSkillBinding, ownerId: string, namespace?: ContextNamespace, sessionId?: string): boolean {
    if (binding.ownerId && binding.ownerId !== ownerId) return false;
    if (binding.scope === CAPABILITY_SCOPE.PROJECT && binding.projectId !== (namespace?.canonicalRepoId ?? namespace?.projectId)) return false;
    if (binding.scope === CAPABILITY_SCOPE.SESSION && binding.sessionId !== sessionId) return false;
    return true;
  }
}
