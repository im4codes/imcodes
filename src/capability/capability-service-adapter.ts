import { createHash, randomUUID } from 'node:crypto';
import { closeSync, cpSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  CAPABILITY_AUDIT_VERDICT,
  CAPABILITY_CONFIRMATION_DECISION,
  CAPABILITY_ERROR,
  CAPABILITY_FINDING_SEVERITY,
  CAPABILITY_KIND,
  CAPABILITY_INSTALL_STATE,
  CAPABILITY_MCP_TRANSPORT,
  CAPABILITY_LIMITS,
  CAPABILITY_MANAGE_ACTION,
  CAPABILITY_READINESS,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_STATE,
  normalizeCapabilityMcpDefinition,
  isCapabilityInstallTerminal,
  isCapabilityInstallCancellable,
  validateCapabilityInstallRequest,
  type CapabilityErrorResult,
  type CapabilityFinding,
  type CapabilityInstallRequest,
  type CapabilityListRequest,
  type CapabilityListResult,
  type CapabilityManageRequest,
  type CapabilityManageResult,
  type CapabilityOperation,
  type CapabilityOperationAuthorizeFrame,
  type CapabilityOperationResult,
  type CapabilityService as SharedCapabilityService,
  type CapabilityStatusRequest,
  type CapabilityStatusResult,
  type CapabilitySummary,
  type CapabilityMcpDefinition,
  type CapabilitySyncBinding,
} from '../../shared/capability-management.js';
import type { ContextNamespace } from '../../shared/context-types.js';
import { DaemonCapabilityService, type CapabilityOperationView, type CapabilityReviewedSkillEvidence } from './capability-service.js';
import {
  buildMcpCapabilityAuditEnvelope,
  runCapabilityAudit,
  verifyCapabilityAuditEvidence,
  type CapabilityAuditEvidence,
  type CapabilityAuditRunner,
} from './capability-audit.js';
import { ClaudeCapabilityAuditRunner } from './claude-capability-audit-runner.js';
import type { SkillAcquisitionSource } from './skill-acquisition.js';
import { inventoryAgentSkillPackage } from './agent-skill-package.js';
import type { SkillScanResult } from './skill-scanner.js';
import {
  readManagedSkillIndex,
  manageExactLocalSkillBinding,
  writeManagedSkillIndex,
  verifyManagedSkillVersion,
  readManagedSkillManifest,
  type ManagedSkillBinding,
  type ManagedSkillIndexEntry,
  type ExactLocalSkillManageInput,
  type ExactLocalSkillManageResult,
} from './managed-skill-store.js';
import {
  getManagedSkillManifestPath,
  getManagedSkillRegistryRoot,
  getManagedSkillTrashRoot,
  getManagedSkillVersionPath,
} from './managed-skill-paths.js';
import {
  buildManagedSkillTransferArchive,
  type SkillTransferArchive,
} from './skill-transfer-archive.js';
import { activateCapabilitySkill } from './capability-skill-activation.js';

export interface DaemonCapabilityServiceAdapterOptions {
  ownerId: string;
  conversationIdentity: string;
  auditRunner?: CapabilityAuditRunner;
  homeDir?: string;
  namespace?: ContextNamespace;
  sessionId?: string;
  providerId?: string;
  serverId?: string;
  projectDir?: string;
  deleteCredentials?: (registryId: string, ownerId: string) => Promise<void>;
  onAuditEvent?: (event: { action: string; ownerId: string; registryId?: string; operationId?: string; outcome: string }) => void;
}

export interface DaemonCapabilityInstallStart {
  initial: CapabilityOperationResult | CapabilityErrorResult;
  completion: Promise<CapabilityOperationResult | CapabilityErrorResult>;
}

export interface DaemonCapabilityAuthorizedCommitInput {
  operationId: string;
  capability: CapabilitySummary;
  versionId: string;
  binding: CapabilitySyncBinding;
}

export interface DaemonCapabilityAuthorizedCommitResult {
  operation: CapabilityOperation;
  rollback(): void;
}

export type DaemonCapabilityRollbackSnapshot =
  | { kind: typeof CAPABILITY_KIND.SKILL; capabilityId: string; previous?: ManagedSkillIndexEntry; backupDirectory?: string }
  | { kind: typeof CAPABILITY_KIND.MCP; capabilityId: string; previous?: CapabilitySummary; previousVersions?: PersistedLocalMcpVersion[] };

export type DaemonCapabilityPublicationRecovery = 'committed' | 'restored' | 'failed';

interface LocalMcpOperation {
  operation: CapabilityOperation;
  definition: CapabilityMcpDefinition;
  sourceKind: CapabilityInstallRequest['source']['kind'];
  abortController?: AbortController;
  capability?: CapabilitySummary;
  scannerDigest?: string;
  auditEvidence?: CapabilityAuditEvidence;
}

export type DaemonCapabilityReviewedEvidence =
  | { kind: typeof CAPABILITY_KIND.SKILL; scan: SkillScanResult; audit: CapabilityAuditEvidence }
  | { kind: typeof CAPABILITY_KIND.MCP; scannerDigest: string; audit: CapabilityAuditEvidence };

interface PersistedLocalMcpVersion {
  capability: CapabilitySummary;
  definition: CapabilityMcpDefinition;
}

interface PersistedLocalMcpStore {
  schemaVersion: 1;
  ownerId: string;
  records: Array<{
    capabilityId: string;
    capability: CapabilitySummary;
    versions: PersistedLocalMcpVersion[];
  }>;
}

export type ExactLocalMcpManageResult =
  | { ok: true; capability: CapabilitySummary }
  | { ok: false; code: 'not_found' | 'forbidden' | 'conflict' | 'invalid_action' | 'integrity_failed' };

function localMcpStorePath(homeDir: string, ownerId: string): string {
  return join(homeDir, '.imcodes', 'capability-local-mcp', `${sha256(ownerId)}.json`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fsyncDirectory(path: string): void {
  const directory = openSync(path, 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function errorResult(reason: CapabilityErrorResult['reason'], error: string, retryable = false): CapabilityErrorResult {
  return { status: 'error', reason, error, retryable };
}

function sourceForSkill(input: CapabilityInstallRequest): SkillAcquisitionSource | CapabilityErrorResult {
  switch (input.source.kind) {
    case CAPABILITY_SOURCE_KIND.INLINE:
      return input.source.inlineFiles
        ? { kind: 'inline', files: { ...input.source.inlineFiles } }
        : errorResult(CAPABILITY_ERROR.INVALID_INPUT, 'inlineFiles is required for an inline Skill');
    case CAPABILITY_SOURCE_KIND.LOCAL_PATH:
      return input.source.value
        ? { kind: 'local_directory', path: input.source.value }
        : errorResult(CAPABILITY_ERROR.INVALID_INPUT, 'A daemon-local directory is required');
    case CAPABILITY_SOURCE_KIND.URL:
      return input.source.value
        ? { kind: 'https_archive', url: input.source.value }
        : errorResult(CAPABILITY_ERROR.INVALID_INPUT, 'An HTTPS archive URL is required');
    case CAPABILITY_SOURCE_KIND.REPOSITORY:
      return input.source.value
        ? { kind: 'repository', url: input.source.value, subdirectory: input.source.repositorySubdir }
        : errorResult(CAPABILITY_ERROR.INVALID_INPUT, 'A repository URL is required');
    default:
      return errorResult(CAPABILITY_ERROR.INVALID_INPUT, 'Skill source kind is invalid');
  }
}

function bindingForRequest(input: CapabilityInstallRequest, ownerId: string): ManagedSkillBinding {
  return {
    scope: input.scope,
    ownerId,
    ...(input.scope === CAPABILITY_SCOPE.PROJECT ? { projectId: input.scopeId } : {}),
    ...(input.scope === CAPABILITY_SCOPE.SESSION ? { sessionId: input.scopeId } : {}),
    ...(input.providers ? { providers: [...input.providers] } : {}),
    ...(input.machines ? { machines: [...input.machines] } : {}),
  };
}

function findingFromView(value: NonNullable<CapabilityOperationView['findings']>[number]): CapabilityFinding {
  const severity = value.severity === 'critical'
    ? CAPABILITY_FINDING_SEVERITY.CRITICAL
    : value.severity === 'high' || value.severity === 'block'
      ? CAPABILITY_FINDING_SEVERITY.HIGH
      : value.severity === 'medium' || value.severity === 'warning'
        ? CAPABILITY_FINDING_SEVERITY.MEDIUM
        : value.severity === 'low'
          ? CAPABILITY_FINDING_SEVERITY.LOW
          : CAPABILITY_FINDING_SEVERITY.INFO;
  return {
    code: value.code,
    severity,
    message: value.summary,
    ...(value.path ? { path: value.path } : {}),
    source: value.severity === 'block' || value.severity === 'warning' || value.severity === 'info' ? 'scanner' : 'auditor',
    blocking: severity === CAPABILITY_FINDING_SEVERITY.CRITICAL || severity === CAPABILITY_FINDING_SEVERITY.HIGH,
  };
}

function contentSafeSourceLabel(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? `https://${url.hostname}` : fallback;
  } catch {
    const leaf = basename(value).trim();
    return leaf && leaf.length <= CAPABILITY_LIMITS.DISPLAY_NAME_CHARS ? leaf : fallback;
  }
}

function skillUpdateDiff(
  operation: CapabilityOperationView,
  request: CapabilityInstallRequest | undefined,
  homeDir: string,
  ownerId: string,
): string[] | undefined {
  if (!request?.capabilityId || !operation.artifactDigest) return undefined;
  const facts = [
    `target_capability:${request.capabilityId}`,
    ...(request.bindingId ? [`target_binding:${request.bindingId}`] : []),
  ];
  const nextPermissions = new Set(operation.skill?.requestedTools ?? []);
  try {
    // Update comparison is exact-ID only. Never guess by display name, and do
    // not inspect a locally cached entry belonging to another account.
    const previous = readManagedSkillIndex(homeDir).entries.find((entry) => entry.registryId === request.capabilityId);
    const binding = previous?.bindings.find((candidate) => candidate.bindingId === request.bindingId && candidate.ownerId === ownerId);
    const previousVersionId = binding?.versionId;
    if (!previous || !previousVersionId) throw new Error('previous binding version unavailable');
    const manifest = verifyManagedSkillVersion(homeDir, previous.registryId, previousVersionId);
    const previousInventory = inventoryAgentSkillPackage(
      getManagedSkillVersionPath(homeDir, previous.registryId, previousVersionId),
    );
    facts.push(`artifact:${manifest.treeDigest}->${operation.artifactDigest}`);
    const previousPermissions = new Set(previousInventory.frontMatter.allowedTools ?? []);
    for (const permission of [...nextPermissions].sort()) {
      if (!previousPermissions.has(permission)) facts.push(`permission_added:${permission}`);
    }
    for (const permission of [...previousPermissions].sort()) {
      if (!nextPermissions.has(permission)) facts.push(`permission_removed:${permission}`);
    }
  } catch {
    facts.push(`artifact:previous_unavailable->${operation.artifactDigest}`);
  }
  return facts;
}

function mcpSourceLabel(definition: CapabilityMcpDefinition): string {
  if (definition.url) return contentSafeSourceLabel(definition.url, 'https-mcp');
  return `stdio:${contentSafeSourceLabel(definition.command, 'command')}`;
}

function mcpPermissions(definition: CapabilityMcpDefinition): string[] {
  const permissions = new Set<string>();
  permissions.add(definition.transport === CAPABILITY_MCP_TRANSPORT.STDIO ? 'process:stdio' : 'network:https');
  if (definition.credentialRef
    || Object.keys(definition.env ?? {}).length > 0
    || Object.keys(definition.headers ?? {}).length > 0) permissions.add('credential_ref');
  return [...permissions].sort();
}

function operationToShared(
  operation: CapabilityOperationView,
  request: CapabilityInstallRequest | undefined,
  homeDir: string,
  ownerId: string,
): CapabilityOperation {
  const permissions = [...(operation.skill?.requestedTools ?? [])];
  const updateDiff = skillUpdateDiff(operation, request, homeDir, ownerId);
  return {
    id: operation.operationId,
    ...(operation.registryId ? { capabilityId: operation.registryId } : {}),
    kind: CAPABILITY_KIND.SKILL,
    state: operation.state,
    revision: operation.revision,
    ...(operation.skill?.name ? { displayName: operation.skill.name } : {}),
    ...(operation.skill?.source ? {
      sourceLabel: contentSafeSourceLabel(operation.skill.source, 'skill-package'),
    } : {}),
    scope: request?.scope ?? CAPABILITY_SCOPE.LOCAL,
    ...(operation.artifactDigest ? { artifactDigest: operation.artifactDigest } : {}),
    ...(operation.auditDigest ? { auditDigest: operation.auditDigest } : {}),
    ...(operation.auditVerdict ? { auditVerdict: operation.auditVerdict } : {}),
    findings: (operation.findings ?? []).map(findingFromView),
    providers: [...(request?.providers ?? [])],
    machines: [...(request?.machines ?? [])],
    tools: [],
    permissions,
    ...(updateDiff ? { updateDiff } : {}),
    hasScripts: (operation.skill?.scripts.length ?? 0) > 0,
    hasExecutables: (operation.skill?.executables.length ?? 0) > 0,
    ...(operation.error ? {
      errorCode: operation.error.code === CAPABILITY_ERROR.RATE_LIMITED
        ? CAPABILITY_ERROR.RATE_LIMITED
        : operation.error.code.startsWith('audit_') ? CAPABILITY_ERROR.AUDIT_REWORK : CAPABILITY_ERROR.INTERNAL_ERROR,
      errorMessage: operation.error.code,
    } : {}),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}

function summaryFromEntry(entry: ManagedSkillIndexEntry, homeDir = homedir()): CapabilitySummary {
  const binding = entry.bindings[0];
  const scope = binding?.scope ?? CAPABILITY_SCOPE.LOCAL;
  const state = entry.state === CAPABILITY_STATE.ACTIVE
    ? CAPABILITY_STATE.ACTIVE
    : entry.state === CAPABILITY_STATE.DISABLED
      ? CAPABILITY_STATE.DISABLED
      : CAPABILITY_STATE.TOMBSTONED;
  const manifest = entry.activeVersionId
    ? verifyManagedSkillVersion(homeDir, entry.registryId, entry.activeVersionId)
    : undefined;
  return {
    id: entry.registryId,
    kind: CAPABILITY_KIND.SKILL,
    name: entry.name,
    state,
    scope,
    ...(entry.activeVersionId ? { versionId: entry.activeVersionId, artifactDigest: manifest?.treeDigest } : {}),
    ...(entry.activeVersionId ? { version: Math.max(1, entry.versions.indexOf(entry.activeVersionId) + 1) } : {}),
    readiness: entry.state === CAPABILITY_STATE.TOMBSTONED ? CAPABILITY_READINESS.CONTENT_MISSING : CAPABILITY_READINESS.READY,
    findings: [],
    revision: entry.authorityRevision ?? entry.revision,
    bindings: entry.bindings.map((value, index) => ({
      id: value.bindingId ?? `${entry.registryId}:${index}`,
      scope: value.scope,
      scopeId: value.projectId ?? value.sessionId ?? value.serverId,
      providers: value.providers ?? [],
      machines: value.machines ?? [],
      active: entry.state === CAPABILITY_STATE.ACTIVE && value.active !== false && value.removed !== true,
    })),
    updatedAt: entry.updatedAt,
  };
}

export class DaemonCapabilityServiceAdapter implements SharedCapabilityService {
  private readonly service: DaemonCapabilityService;
  private readonly installRequests = new Map<string, CapabilityInstallRequest>();
  private readonly mcpOperations = new Map<string, LocalMcpOperation>();
  private readonly mcpOperationByIdempotency = new Map<string, string>();
  private readonly mcpCapabilities = new Map<string, CapabilitySummary>();
  private readonly mcpVersionHistory = new Map<string, Map<string, PersistedLocalMcpVersion>>();

  constructor(private readonly options: DaemonCapabilityServiceAdapterOptions) {
    this.service = new DaemonCapabilityService({
      auditRunner: options.auditRunner ?? new ClaudeCapabilityAuditRunner(),
      homeDir: options.homeDir ?? homedir(),
      deleteCredentials: options.deleteCredentials,
      onAuditEvent: options.onAuditEvent,
    });
    this.loadLocalMcpStore();
  }

  private loadLocalMcpStore(): void {
    const path = localMcpStorePath(this.options.homeDir ?? homedir(), this.options.ownerId);
    const serverId = this.options.serverId;
    if (!serverId || !existsSync(path)) return;
    try {
      // Do not let an attacker-controlled local file allocate without bound.
      // Reading through the already-open descriptor also keeps the stat/read
      // decision on one file and detects growth or truncation during the read.
      const descriptor = openSync(path, 'r');
      let bytes: Buffer;
      try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile() || stat.size <= 0 || stat.size > CAPABILITY_LIMITS.PACKAGE_BYTES) return;
        bytes = Buffer.allocUnsafe(stat.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
          if (count === 0) break;
          offset += count;
        }
        if (offset !== stat.size) return;
        bytes = bytes.subarray(0, offset);
      } finally {
        closeSync(descriptor);
      }

      const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null && !Array.isArray(value);
      const hasOnlyKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
        Object.keys(value).every((key) => allowed.has(key));
      const boundedString = (value: unknown, maxBytes: number): value is string =>
        typeof value === 'string'
        && value.length > 0
        && Buffer.byteLength(value, 'utf8') <= maxBytes
        && !/[\u0000-\u001F\u007F]/.test(value);
      const boundedStrings = (value: unknown, maxItems: number, maxBytes: number): string[] | null => {
        if (!Array.isArray(value) || value.length > maxItems
          || !value.every((item) => boundedString(item, maxBytes))) return null;
        return [...value] as string[];
      };
      const isSafeInteger = (value: unknown, minimum = 0): value is number =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
      const optionalBoundedString = (value: unknown, maxBytes: number): value is string | undefined =>
        value === undefined || boundedString(value, maxBytes);
      const findingKeys = new Set(['code', 'severity', 'message', 'path', 'remediation', 'source', 'blocking']);
      const decodeFindings = (value: unknown): CapabilityFinding[] | null => {
        if (!Array.isArray(value) || value.length > CAPABILITY_LIMITS.FINDINGS) return null;
        const decoded: CapabilityFinding[] = [];
        for (const finding of value) {
          if (!isRecord(finding) || !hasOnlyKeys(finding, findingKeys)
            || !boundedString(finding.code, 128)
            || !Object.values(CAPABILITY_FINDING_SEVERITY).includes(finding.severity as CapabilityFinding['severity'])
            || !boundedString(finding.message, CAPABILITY_LIMITS.FINDING_TEXT_BYTES)
            || !optionalBoundedString(finding.path, CAPABILITY_LIMITS.PATH_BYTES)
            || !optionalBoundedString(finding.remediation, CAPABILITY_LIMITS.FINDING_TEXT_BYTES)
            || !['scanner', 'auditor', 'runtime'].includes(finding.source as string)
            || typeof finding.blocking !== 'boolean') return null;
          decoded.push({
            code: finding.code,
            severity: finding.severity as CapabilityFinding['severity'],
            message: finding.message,
            ...(finding.path ? { path: finding.path } : {}),
            ...(finding.remediation ? { remediation: finding.remediation } : {}),
            source: finding.source as CapabilityFinding['source'],
            blocking: finding.blocking,
          });
        }
        return decoded;
      };
      const bindingKeys = new Set([
        'id', 'capabilityId', 'versionId', 'scope', 'scopeId', 'providers', 'machines', 'active',
      ]);
      const decodeBindings = (
        value: unknown,
        capabilityId: string,
      ): CapabilitySyncBinding[] | null => {
        if (!Array.isArray(value) || value.length === 0 || value.length > CAPABILITY_LIMITS.SYNC_BINDINGS) return null;
        const decoded: CapabilitySyncBinding[] = [];
        for (const binding of value) {
          if (!isRecord(binding) || !hasOnlyKeys(binding, bindingKeys)
            || !boundedString(binding.id, 128)
            || binding.capabilityId !== capabilityId
            || !boundedString(binding.versionId, 128)
            || binding.scope !== CAPABILITY_SCOPE.LOCAL
            || binding.scopeId !== serverId
            || typeof binding.active !== 'boolean') return null;
          const providers = boundedStrings(binding.providers, CAPABILITY_LIMITS.PROVIDERS, 128);
          const machines = boundedStrings(binding.machines, CAPABILITY_LIMITS.MACHINES, 128);
          if (!providers || !machines) return null;
          decoded.push({
            id: binding.id,
            capabilityId,
            versionId: binding.versionId as string,
            scope: CAPABILITY_SCOPE.LOCAL,
            scopeId: serverId,
            providers,
            machines,
            active: binding.active,
          });
        }
        return decoded;
      };
      const availableVersionKeys = new Set(['id', 'label', 'version', 'createdAt']);
      const decodeAvailableVersions = (value: unknown): CapabilitySummary['availableVersions'] | null => {
        if (value === undefined) return undefined;
        if (!Array.isArray(value) || value.length > CAPABILITY_LIMITS.SYNC_VERSIONS) return null;
        const decoded: NonNullable<CapabilitySummary['availableVersions']>[number][] = [];
        for (const candidate of value) {
          if (!isRecord(candidate) || !hasOnlyKeys(candidate, availableVersionKeys)
            || !boundedString(candidate.id, 128)
            || !boundedString(candidate.label, CAPABILITY_LIMITS.DISPLAY_NAME_CHARS)
            || (candidate.version !== undefined && !isSafeInteger(candidate.version, 1))
            || (candidate.createdAt !== undefined && !isSafeInteger(candidate.createdAt))) return null;
          decoded.push({
            id: candidate.id,
            label: candidate.label,
            ...(candidate.version !== undefined ? { version: candidate.version } : {}),
            ...(candidate.createdAt !== undefined ? { createdAt: candidate.createdAt } : {}),
          });
        }
        return decoded;
      };
      const capabilityKeys = new Set([
        'id', 'revision', 'kind', 'name', 'state', 'scope', 'versionId', 'version',
        'availableVersions', 'artifactDigest', 'sourceKind', 'sourceLabel', 'readiness',
        'findings', 'bindings', 'tools', 'permissions', 'hasScripts', 'hasExecutables',
        'stdioCommand', 'credentialsRetained', 'updatedAt',
      ]);
      const decodeCapability = (value: unknown, capabilityId: string): CapabilitySummary | null => {
        if (!isRecord(value) || !hasOnlyKeys(value, capabilityKeys)
          || value.id !== capabilityId
          || value.kind !== CAPABILITY_KIND.MCP
          || value.scope !== CAPABILITY_SCOPE.LOCAL
          || !boundedString(value.name, CAPABILITY_LIMITS.DISPLAY_NAME_CHARS)
          || !boundedString(value.versionId, 128)
          || !isSafeInteger(value.revision, 1)
          || (value.version !== undefined && !isSafeInteger(value.version, 1))
          || !Object.values(CAPABILITY_STATE).includes(value.state as CapabilitySummary['state'])
          || !Object.values(CAPABILITY_READINESS).includes(value.readiness as CapabilitySummary['readiness'])
          || value.sourceKind !== CAPABILITY_SOURCE_KIND.MCP_CONFIG
          || !optionalBoundedString(value.sourceLabel, CAPABILITY_LIMITS.SOURCE_CHARS)
          || (value.artifactDigest !== undefined
            && (typeof value.artifactDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.artifactDigest)))
          || !isSafeInteger(value.updatedAt)) return null;
        const findings = decodeFindings(value.findings);
        const bindings = decodeBindings(value.bindings, capabilityId);
        const availableVersions = decodeAvailableVersions(value.availableVersions);
        const tools = value.tools === undefined ? undefined
          : boundedStrings(value.tools, CAPABILITY_LIMITS.FILE_COUNT, 128);
        const permissions = value.permissions === undefined ? undefined
          : boundedStrings(value.permissions, CAPABILITY_LIMITS.FILE_COUNT, 128);
        const stdioCommand = value.stdioCommand === undefined ? undefined
          : boundedStrings(value.stdioCommand, CAPABILITY_LIMITS.FILE_COUNT, CAPABILITY_LIMITS.PATH_BYTES);
        if (!findings || !bindings || availableVersions === null || tools === null
          || permissions === null || stdioCommand === null
          || (value.hasScripts !== undefined && typeof value.hasScripts !== 'boolean')
          || (value.hasExecutables !== undefined && typeof value.hasExecutables !== 'boolean')
          || (value.credentialsRetained !== undefined && typeof value.credentialsRetained !== 'boolean')) return null;
        return {
          id: capabilityId,
          revision: value.revision,
          kind: CAPABILITY_KIND.MCP,
          name: value.name,
          // Disk content is not runtime authority. Until the separately gated
          // gateway proves a live mount, every restored MCP remains pending.
          state: CAPABILITY_STATE.RUNTIME_PENDING,
          scope: CAPABILITY_SCOPE.LOCAL,
          versionId: value.versionId,
          ...(value.version !== undefined ? { version: value.version } : {}),
          ...(availableVersions !== undefined ? { availableVersions } : {}),
          ...(value.artifactDigest !== undefined ? { artifactDigest: value.artifactDigest } : {}),
          sourceKind: CAPABILITY_SOURCE_KIND.MCP_CONFIG,
          ...(value.sourceLabel !== undefined ? { sourceLabel: value.sourceLabel } : {}),
          readiness: CAPABILITY_READINESS.RUNTIME_PENDING,
          findings,
          bindings,
          ...(tools !== undefined ? { tools } : {}),
          ...(permissions !== undefined ? { permissions } : {}),
          ...(value.hasScripts !== undefined ? { hasScripts: value.hasScripts } : {}),
          ...(value.hasExecutables !== undefined ? { hasExecutables: value.hasExecutables } : {}),
          ...(stdioCommand !== undefined ? { stdioCommand } : {}),
          ...(value.credentialsRetained !== undefined ? { credentialsRetained: value.credentialsRetained } : {}),
          updatedAt: value.updatedAt,
        };
      };
      const root = JSON.parse(bytes.toString('utf8')) as unknown;
      const rootKeys = new Set(['schemaVersion', 'ownerId', 'records']);
      if (!isRecord(root) || !hasOnlyKeys(root, rootKeys)
        || root.schemaVersion !== 1 || root.ownerId !== this.options.ownerId
        || !Array.isArray(root.records) || root.records.length > CAPABILITY_LIMITS.SYNC_ITEMS) return;
      const recordKeys = new Set(['capabilityId', 'capability', 'versions']);
      const versionKeys = new Set(['capability', 'definition']);
      const seenCapabilityIds = new Set<string>();
      let totalVersions = 0;
      for (const value of root.records) {
        if (!isRecord(value) || !hasOnlyKeys(value, recordKeys)
          || !boundedString(value.capabilityId, 128) || seenCapabilityIds.has(value.capabilityId)
          || !Array.isArray(value.versions) || value.versions.length === 0) continue;
        totalVersions += value.versions.length;
        if (totalVersions > CAPABILITY_LIMITS.SYNC_VERSIONS) return;
        const current = decodeCapability(value.capability, value.capabilityId);
        if (!current) continue;
        const versions = new Map<string, PersistedLocalMcpVersion>();
        let recordIsValid = true;
        for (const candidate of value.versions) {
          if (!isRecord(candidate) || !hasOnlyKeys(candidate, versionKeys)) {
            recordIsValid = false;
            break;
          }
          const decodedCapability = decodeCapability(candidate.capability, value.capabilityId);
          const normalized = normalizeCapabilityMcpDefinition({
            kind: CAPABILITY_SOURCE_KIND.MCP_CONFIG,
            mcpConfig: isRecord(candidate.definition) ? { ...candidate.definition } : undefined,
          });
          if (!decodedCapability || !normalized || versions.has(decodedCapability.versionId!)) {
            recordIsValid = false;
            break;
          }
          versions.set(decodedCapability.versionId!, {
            capability: decodedCapability,
            definition: normalized,
          });
        }
        if (!recordIsValid || !versions.has(current.versionId!)
          || current.bindings?.some((binding) => !binding.versionId || !versions.has(binding.versionId))
          || [...versions.values()].some((historical) => historical.capability.bindings
            ?.some((binding) => !binding.versionId || !versions.has(binding.versionId)))) continue;
        seenCapabilityIds.add(value.capabilityId);
        this.mcpVersionHistory.set(value.capabilityId, versions);
        this.mcpCapabilities.set(value.capabilityId, current);
      }
    } catch {
      // Corrupt machine-local state is ignored fail-closed; it never reaches a
      // provider and a later authoritative snapshot/operation can repair it.
    }
  }

  private persistLocalMcpStore(): void {
    const records: PersistedLocalMcpStore['records'] = [];
    let totalVersions = 0;
    let totalBindings = 0;
    for (const [capabilityId, versions] of this.mcpVersionHistory) {
      const capability = this.mcpCapabilities.get(capabilityId);
      if (!capability?.versionId
        || !capability.bindings?.some((binding) => binding.scope === CAPABILITY_SCOPE.LOCAL)) continue;
      records.push({
        capabilityId,
        capability: structuredClone(capability),
        versions: [...versions.values()].map((entry) => structuredClone(entry)),
      });
      totalVersions += versions.size;
      totalBindings += capability.bindings?.length ?? 0;
      for (const historical of versions.values()) totalBindings += historical.capability.bindings?.length ?? 0;
      if (records.length > CAPABILITY_LIMITS.SYNC_ITEMS
        || totalVersions > CAPABILITY_LIMITS.SYNC_VERSIONS
        || totalBindings > CAPABILITY_LIMITS.SYNC_BINDINGS) {
        throw new Error('machine-local MCP store capacity exceeded');
      }
    }
    const serialized = `${JSON.stringify({
      schemaVersion: 1, ownerId: this.options.ownerId, records,
    } satisfies PersistedLocalMcpStore, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > CAPABILITY_LIMITS.PACKAGE_BYTES) {
      throw new Error('machine-local MCP store byte capacity exceeded');
    }
    const path = localMcpStorePath(this.options.homeDir ?? homedir(), this.options.ownerId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, serialized, {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      });
      const file = openSync(temporary, 'r');
      try { fsyncSync(file); } finally { closeSync(file); }
      renameSync(temporary, path);
      const directory = openSync(dirname(path), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private skillOperation(operation: CapabilityOperationView, request?: CapabilityInstallRequest): CapabilityOperation {
    return operationToShared(
      operation,
      request,
      this.options.homeDir ?? homedir(),
      this.options.ownerId,
    );
  }

  list(input: CapabilityListRequest): CapabilityListResult {
    const query = input.query?.trim().toLocaleLowerCase();
    const items = [
      ...this.service.list({ ownerId: this.options.ownerId, namespace: this.options.namespace, sessionId: this.options.sessionId })
        .map((entry) => summaryFromEntry(entry, this.options.homeDir ?? homedir())),
      ...this.mcpCapabilities.values(),
    ]
      .filter((item) => !input.kind || item.kind === input.kind)
      .filter((item) => !input.state || item.state === input.state)
      .filter((item) => !input.scope || item.scope === input.scope)
      .filter((item) => !query || item.name.toLocaleLowerCase().includes(query))
      .slice(0, Math.min(input.limit ?? CAPABILITY_LIMITS.LIST_DEFAULT, CAPABILITY_LIMITS.LIST_MAX));
    return { status: 'ok', items };
  }

  async install(input: CapabilityInstallRequest): Promise<CapabilityOperationResult | CapabilityErrorResult> {
    return this.startInstall(input).completion;
  }

  startInstall(
    input: CapabilityInstallRequest,
    onTransition?: (result: CapabilityOperationResult) => void,
  ): DaemonCapabilityInstallStart {
    const validation = validateCapabilityInstallRequest(input);
    if (validation) {
      const error = errorResult(CAPABILITY_ERROR.INVALID_INPUT, validation);
      return { initial: error, completion: Promise.resolve(error) };
    }
    if (input.kind === CAPABILITY_KIND.MCP) return this.startMcpInstall(input, onTransition);
    const source = sourceForSkill(input);
    if ('status' in source) return { initial: source, completion: Promise.resolve(source) };
    const started = this.service.startInstall({
      ownerId: this.options.ownerId,
      conversationIdentity: this.options.conversationIdentity,
      idempotencyKey: input.idempotencyKey,
      source,
      bindings: [bindingForRequest(input, this.options.ownerId)],
    }, onTransition ? (operation) => {
      onTransition({ status: 'ok', operation: this.skillOperation(operation, input) });
    } : undefined);
    this.installRequests.set(started.operation.operationId, structuredClone(input));
    return {
      initial: { status: 'ok', operation: this.skillOperation(started.operation, input) },
      completion: started.completion.then((operation) => ({
        status: 'ok' as const,
        operation: this.skillOperation(operation, input),
      })),
    };
  }

  candidateReviewEvidence(operationId: string): DaemonCapabilityReviewedEvidence | undefined {
    const mcp = this.mcpOperations.get(operationId);
    if (mcp?.scannerDigest && mcp.auditEvidence) {
      return { kind: CAPABILITY_KIND.MCP, scannerDigest: mcp.scannerDigest, audit: structuredClone(mcp.auditEvidence) };
    }
    const skill = this.service.reviewEvidence(operationId, this.options.ownerId);
    return skill ? { kind: CAPABILITY_KIND.SKILL, ...skill } : undefined;
  }

  async restoreReviewedCandidate(
    input: CapabilityInstallRequest,
    reviewed: CapabilityOperation,
    evidence: DaemonCapabilityReviewedEvidence,
  ): Promise<CapabilityOperationResult | CapabilityErrorResult> {
    if (input.kind === CAPABILITY_KIND.MCP) {
      if (evidence.kind !== CAPABILITY_KIND.MCP) return errorResult(CAPABILITY_ERROR.INTEGRITY_FAILED, 'Persisted MCP evidence kind changed');
      const definition = normalizeCapabilityMcpDefinition(input.source, input.displayName);
      if (!definition) return errorResult(CAPABILITY_ERROR.INTEGRITY_FAILED, 'Persisted MCP definition is invalid');
      const canonical = JSON.stringify(definition);
      const artifactDigest = sha256(canonical);
      const scannerDigest = sha256(`imcodes-mcp-scan-v1\0${canonical}`);
      if (artifactDigest !== reviewed.artifactDigest || scannerDigest !== evidence.scannerDigest
        || evidence.audit.artifactDigest !== artifactDigest
        || evidence.audit.scannerDigest !== scannerDigest
        || evidence.audit.verdict !== CAPABILITY_AUDIT_VERDICT.PASS
        || !verifyCapabilityAuditEvidence(evidence.audit)) {
        return errorResult(CAPABILITY_ERROR.INTEGRITY_FAILED, 'Persisted MCP reviewed evidence changed');
      }
      const operation: CapabilityOperation = {
        ...structuredClone(reviewed), id: randomUUID(), state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION,
        revision: Math.max(1, reviewed.revision), updatedAt: Date.now(),
      };
      const local: LocalMcpOperation = {
        operation, definition, sourceKind: input.source.kind,
        scannerDigest, auditEvidence: structuredClone(evidence.audit),
      };
      this.mcpOperations.set(operation.id, local);
      this.mcpOperationByIdempotency.set(input.idempotencyKey, operation.id);
      this.installRequests.set(operation.id, structuredClone(input));
      return { status: 'ok', operation: structuredClone(operation) };
    }
    if (evidence.kind !== CAPABILITY_KIND.SKILL) return errorResult(CAPABILITY_ERROR.INTEGRITY_FAILED, 'Persisted Skill evidence kind changed');
    const source = sourceForSkill(input);
    if ('status' in source) return source;
    const operation = await this.service.restoreReviewedInstall({
      ownerId: this.options.ownerId,
      conversationIdentity: this.options.conversationIdentity,
      idempotencyKey: input.idempotencyKey,
      source,
      bindings: [bindingForRequest(input, this.options.ownerId)],
    }, evidence as CapabilityReviewedSkillEvidence);
    this.installRequests.set(operation.operationId, structuredClone(input));
    return { status: 'ok', operation: this.skillOperation(operation, input) };
  }

  status(input: CapabilityStatusRequest): CapabilityStatusResult | CapabilityErrorResult {
    if (input.operationId) {
      const mcp = this.mcpOperations.get(input.operationId);
      if (mcp) return { status: 'ok', operation: structuredClone(mcp.operation) };
      const operation = this.service.status(input.operationId, this.options.ownerId);
      if (!operation) return errorResult(CAPABILITY_ERROR.NOT_FOUND, 'Capability operation not found');
      return { status: 'ok', operation: this.skillOperation(operation, this.installRequests.get(input.operationId)) };
    }
    if (input.capabilityId) {
      const mcp = this.mcpCapabilities.get(input.capabilityId);
      if (mcp) return input.activate
        ? errorResult(CAPABILITY_ERROR.INVALID_INPUT, 'Only Skills can be activated')
        : { status: 'ok', capability: structuredClone(mcp) };
      const capability = this.service.list({ ownerId: this.options.ownerId, namespace: this.options.namespace, sessionId: this.options.sessionId })
        .find((entry) => entry.registryId === input.capabilityId);
      const summary = capability ? summaryFromEntry(capability, this.options.homeDir ?? homedir()) : undefined;
      if (summary && input.activate) {
        return this.options.namespace && this.options.sessionId && this.options.providerId && this.options.serverId
          ? activateCapabilitySkill(summary, {
              ownerId: this.options.ownerId,
              namespace: this.options.namespace,
              sessionId: this.options.sessionId,
              providerId: this.options.providerId,
              serverId: this.options.serverId,
              projectDir: this.options.projectDir,
              homeDir: this.options.homeDir,
            })
          : errorResult(CAPABILITY_ERROR.FORBIDDEN, 'Current authenticated Skill activation context is unavailable');
      }
      return summary
        ? { status: 'ok', capability: summary }
        : errorResult(CAPABILITY_ERROR.NOT_FOUND, 'Capability not found');
    }
    return errorResult(CAPABILITY_ERROR.INVALID_INPUT, 'operationId or capabilityId is required');
  }

  failPreparedInstall(operationId: string, code: string): CapabilityOperationResult | CapabilityErrorResult {
    const mcp = this.mcpOperations.get(operationId);
    if (mcp && mcp.operation.state !== CAPABILITY_INSTALL_STATE.INSTALLED) {
      mcp.abortController?.abort(new Error(code));
      mcp.operation.errorCode = code as CapabilityErrorResult['reason'];
      this.transitionMcp(mcp, CAPABILITY_INSTALL_STATE.FAILED);
      return { status: 'ok', operation: structuredClone(mcp.operation) };
    }
    const operation = this.service.failPreparedInstall(operationId, this.options.ownerId, code);
    return operation
      ? { status: 'ok', operation: this.skillOperation(operation, this.installRequests.get(operationId)) }
      : errorResult(CAPABILITY_ERROR.NOT_FOUND, 'Capability operation not found');
  }

  async manage(input: CapabilityManageRequest): Promise<CapabilityManageResult | CapabilityErrorResult> {
    if (input.action === CAPABILITY_MANAGE_ACTION.CANCEL_OPERATION) {
      if (!input.operationId) return errorResult(CAPABILITY_ERROR.INVALID_INPUT, 'operationId is required');
      const mcp = this.mcpOperations.get(input.operationId);
      if (mcp) {
        if (!isCapabilityInstallTerminal(mcp.operation.state) && isCapabilityInstallCancellable(mcp.operation.state)) {
          mcp.abortController?.abort(new Error('capability operation cancelled'));
          this.transitionMcp(mcp, CAPABILITY_INSTALL_STATE.CANCELLED);
        }
        return { status: 'ok', operation: structuredClone(mcp.operation) };
      }
      const operation = this.service.cancel(input.operationId, this.options.ownerId);
      return operation
        ? { status: 'ok', operation: this.skillOperation(operation, this.installRequests.get(input.operationId)) }
        : errorResult(CAPABILITY_ERROR.NOT_FOUND, 'Capability operation not found');
    }
    if (
      (input.action === CAPABILITY_MANAGE_ACTION.UNINSTALL || input.action === CAPABILITY_MANAGE_ACTION.DELETE_CREDENTIALS)
      && !input.userIntent?.trim()
    ) {
      return errorResult(CAPABILITY_ERROR.INVALID_INPUT, 'Explicit user intent is required');
    }
    const result = await this.service.manage({
      ownerId: this.options.ownerId,
      registryId: input.capabilityId,
      name: input.name,
      action: input.action,
      versionId: input.versionId,
      scope: input.scope,
      expectedRevision: input.expectedRevision,
    });
    if (!result.ok) {
      if (result.code === 'ambiguous_target') {
        return {
          status: 'ambiguous',
          choices: result.choices.map((choice) => ({
            id: choice.registryId,
            kind: CAPABILITY_KIND.SKILL,
            name: choice.name,
            scope: (choice.scopes[0] ?? CAPABILITY_SCOPE.LOCAL) as CapabilitySummary['scope'],
            state: CAPABILITY_STATE.ACTIVE,
          })),
        };
      }
      if (result.code === 'conflict') return errorResult(CAPABILITY_ERROR.CONFLICT, result.code, true);
      return errorResult(result.code === 'not_found' ? CAPABILITY_ERROR.NOT_FOUND : CAPABILITY_ERROR.INVALID_INPUT, result.code);
    }
    if ('deletedCredentials' in result) return { status: 'ok' };
    return { status: 'ok', capability: summaryFromEntry(result.item, this.options.homeDir ?? homedir()) };
  }

  /** Browser-only installation decision. This method is intentionally absent from the four AI-facing tools. */
  confirm(input: {
    operationId: string;
    revision: number;
    artifactDigest: string;
    auditDigest: string;
    decision: typeof CAPABILITY_CONFIRMATION_DECISION[keyof typeof CAPABILITY_CONFIRMATION_DECISION];
  }): CapabilityOperationResult | CapabilityErrorResult {
    const mcp = this.mcpOperations.get(input.operationId);
    if (mcp) {
      const operation = mcp.operation;
      if (operation.state !== CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION
        || operation.revision !== input.revision
        || operation.artifactDigest !== input.artifactDigest
        || operation.auditDigest !== input.auditDigest) {
        return errorResult(CAPABILITY_ERROR.CONFIRMATION_STALE, 'Confirmation no longer matches reviewed MCP evidence');
      }
      if (input.decision === CAPABILITY_CONFIRMATION_DECISION.CANCEL) {
        this.transitionMcp(mcp, CAPABILITY_INSTALL_STATE.CANCELLED);
        return { status: 'ok', operation: structuredClone(operation) };
      }
      // Browser confirmation crosses the irreversible INSTALLING boundary,
      // but does not publish a local authority. The authenticated server must
      // return the exact item/version/binding in AUTHORIZE first.
      this.transitionMcp(mcp, CAPABILITY_INSTALL_STATE.INSTALLING);
      return { status: 'ok', operation: structuredClone(operation) };
    }
    const operation = this.service.confirm({
      ...input,
      ownerId: this.options.ownerId,
      origin: 'browser',
    });
    if (!operation) return errorResult(CAPABILITY_ERROR.NOT_FOUND, 'Capability operation not found');
    if (operation.state === CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION) {
      return errorResult(CAPABILITY_ERROR.CONFIRMATION_STALE, 'Installation confirmation is stale');
    }
    return { status: 'ok', operation: this.skillOperation(operation, this.installRequests.get(input.operationId)) };
  }

  mcpDefinition(operationId: string): CapabilityMcpDefinition | undefined {
    return this.mcpOperations.get(operationId)?.definition;
  }

  /** Deterministic source bytes for a later authenticated blob upload. */
  skillTransferArchive(operationId: string): SkillTransferArchive | undefined {
    const operation = this.service.status(operationId, this.options.ownerId);
    if (!operation?.artifactDigest) return undefined;
    if (operation.state === CAPABILITY_INSTALL_STATE.INSTALLING
      || operation.state === CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION) {
      return this.service.candidateTransferArchive(operationId, this.options.ownerId);
    }
    if (!operation.registryId || operation.state !== CAPABILITY_INSTALL_STATE.INSTALLED) return undefined;
    const installed = readManagedSkillIndex(this.options.homeDir ?? homedir()).entries
      .find((entry) => entry.registryId === operation.registryId);
    if (!installed?.activeVersionId) return undefined;
    return buildManagedSkillTransferArchive(
      this.options.homeDir ?? homedir(),
      operation.registryId,
      installed.activeVersionId,
    );
  }

  commitAuthorized(input: DaemonCapabilityAuthorizedCommitInput): DaemonCapabilityAuthorizedCommitResult | undefined {
    const mcp = this.mcpOperations.get(input.operationId);
    if (mcp) {
      if (mcp.operation.state !== CAPABILITY_INSTALL_STATE.INSTALLING
        || input.capability.kind !== CAPABILITY_KIND.MCP
        || input.binding.capabilityId !== input.capability.id
        || input.binding.versionId !== input.versionId) return undefined;
      const previous = this.mcpCapabilities.get(input.capability.id);
      const previousHistory = this.mcpVersionHistory.get(input.capability.id);
      const existingBindings = previous?.bindings ?? [];
      const bindings = [
        ...existingBindings.filter((binding) => binding.id !== input.binding.id),
        structuredClone(input.binding),
      ];
      const capability: CapabilitySummary = {
        ...structuredClone(input.capability),
        state: CAPABILITY_STATE.RUNTIME_PENDING,
        readiness: CAPABILITY_READINESS.RUNTIME_PENDING,
        bindings,
      };
      mcp.capability = capability;
      this.mcpCapabilities.set(capability.id, capability);
      const history = new Map(previousHistory ?? []);
      history.set(input.versionId, { capability: structuredClone(capability), definition: structuredClone(mcp.definition) });
      this.mcpVersionHistory.set(capability.id, history);
      try {
        this.persistLocalMcpStore();
      } catch {
        this.mcpCapabilities.delete(capability.id);
        if (previous) this.mcpCapabilities.set(previous.id, previous);
        if (previousHistory) this.mcpVersionHistory.set(capability.id, previousHistory);
        else this.mcpVersionHistory.delete(capability.id);
        return undefined;
      }
      mcp.operation.capabilityId = capability.id;
      this.transitionMcp(mcp, CAPABILITY_INSTALL_STATE.INSTALLED);
      return {
        operation: structuredClone(mcp.operation),
        rollback: () => {
          this.mcpCapabilities.delete(capability.id);
          mcp.capability = previous;
          if (previous) this.mcpCapabilities.set(previous.id, previous);
          if (previousHistory) this.mcpVersionHistory.set(capability.id, previousHistory);
          else this.mcpVersionHistory.delete(capability.id);
          this.persistLocalMcpStore();
          mcp.operation.capabilityId = previous?.id;
          mcp.operation.errorCode = CAPABILITY_ERROR.RUNTIME_PENDING;
          this.transitionMcp(mcp, CAPABILITY_INSTALL_STATE.FAILED);
        },
      };
    }
    if (input.capability.kind !== CAPABILITY_KIND.SKILL || !input.binding.authorization) return undefined;
    const result = this.service.commitAuthorized({
      operationId: input.operationId,
      ownerId: this.options.ownerId,
      registryId: input.capability.id,
      versionId: input.versionId,
      authorityRevision: input.capability.revision,
      binding: {
        bindingId: input.binding.id,
        versionId: input.binding.versionId,
        serverId: input.binding.scope === CAPABILITY_SCOPE.LOCAL ? input.binding.scopeId : undefined,
        scope: input.binding.scope,
        ownerId: this.options.ownerId,
        projectId: input.binding.scope === CAPABILITY_SCOPE.PROJECT ? input.binding.scopeId : undefined,
        sessionId: input.binding.scope === CAPABILITY_SCOPE.SESSION ? input.binding.scopeId : undefined,
        providers: [...input.binding.providers],
        machines: [...input.binding.machines],
        active: input.binding.active,
        authorization: structuredClone(input.binding.authorization),
      },
    });
    if (!result) return undefined;
    return {
      operation: this.skillOperation(result.operation, this.installRequests.get(input.operationId)),
      rollback: result.rollback,
    };
  }

  captureAuthorizedState(capabilityId: string, kind: CapabilityInstallRequest['kind']): DaemonCapabilityRollbackSnapshot {
    if (kind === CAPABILITY_KIND.SKILL) {
      const previous = readManagedSkillIndex(this.options.homeDir ?? homedir()).entries
        .find((entry) => entry.registryId === capabilityId);
      return { kind, capabilityId, ...(previous ? { previous: structuredClone(previous) } : {}) };
    }
    const previous = this.mcpCapabilities.get(capabilityId);
    const previousVersions = this.mcpVersionHistory.get(capabilityId);
    return {
      kind,
      capabilityId,
      ...(previous ? { previous: structuredClone(previous) } : {}),
      ...(previousVersions ? { previousVersions: [...previousVersions.values()].map((entry) => structuredClone(entry)) } : {}),
    };
  }

  rollbackAuthorizedState(snapshot: DaemonCapabilityRollbackSnapshot, committedVersionId: string): boolean {
    if (snapshot.kind === CAPABILITY_KIND.SKILL) {
      const homeDir = this.options.homeDir ?? homedir();
      const index = readManagedSkillIndex(homeDir);
      const current = index.entries.find((entry) => entry.registryId === snapshot.capabilityId);
      const versionPath = getManagedSkillVersionPath(homeDir, snapshot.capabilityId, committedVersionId);
      const manifestPath = getManagedSkillManifestPath(homeDir, snapshot.capabilityId, committedVersionId);
      const exactlyRestored = (snapshot.previous ? exactJson(current, snapshot.previous) : current === undefined)
        && !existsSync(versionPath) && !existsSync(manifestPath);
      if (exactlyRestored) return true;
      if (!current || current.activeVersionId !== committedVersionId) return false;
      rmSync(versionPath, { recursive: true, force: true });
      rmSync(manifestPath, { force: true });
      fsyncDirectory(getManagedSkillRegistryRoot(homeDir, snapshot.capabilityId));
      writeManagedSkillIndex({
        ...index,
        revision: index.revision + 1,
        entries: [
          ...index.entries.filter((entry) => entry.registryId !== snapshot.capabilityId),
          ...(snapshot.previous ? [structuredClone(snapshot.previous)] : []),
        ].sort((left, right) => left.registryId < right.registryId ? -1 : left.registryId > right.registryId ? 1 : 0),
      }, homeDir);
      return true;
    }
    const current = this.mcpCapabilities.get(snapshot.capabilityId);
    const currentVersions = this.mcpVersionHistory.get(snapshot.capabilityId);
    const previousVersions = snapshot.previousVersions
      ? new Map(snapshot.previousVersions.map((entry) => [entry.capability.versionId!, structuredClone(entry)]))
      : undefined;
    const exactlyRestored = (snapshot.previous ? exactJson(current, snapshot.previous) : current === undefined)
      && (previousVersions ? exactJson([...currentVersions?.values() ?? []], [...previousVersions.values()]) : currentVersions === undefined);
    if (exactlyRestored) return true;
    if (!current || current.versionId !== committedVersionId) return false;
    if (snapshot.previous) this.mcpCapabilities.set(snapshot.capabilityId, structuredClone(snapshot.previous));
    else this.mcpCapabilities.delete(snapshot.capabilityId);
    if (snapshot.previousVersions) {
      this.mcpVersionHistory.set(snapshot.capabilityId, new Map(snapshot.previousVersions.map((entry) => [entry.capability.versionId!, structuredClone(entry)])));
    } else this.mcpVersionHistory.delete(snapshot.capabilityId);
    this.persistLocalMcpStore();
    return true;
  }

  /**
   * Recovers the resolver-visible side of a Skill publication that crashed
   * between immutable package/manifest rename and index publication. The WAL
   * owns only the exact authoritative version id, so no name-based cleanup is
   * permitted. A complete exact package is deterministically indexed; a
   * partial/invalid orphan is removed and the prior index remains authoritative.
   */
  recoverAuthorizedPublication(
    snapshot: DaemonCapabilityRollbackSnapshot,
    authorize: CapabilityOperationAuthorizeFrame,
  ): DaemonCapabilityPublicationRecovery {
    if (snapshot.capabilityId !== authorize.capability.id || snapshot.kind !== authorize.capability.kind) return 'failed';
    if (snapshot.kind === CAPABILITY_KIND.MCP) {
      const current = this.mcpCapabilities.get(snapshot.capabilityId);
      if (current?.versionId === authorize.version.id
        && current.artifactDigest === authorize.version.artifactDigest) return 'committed';
      return this.restoreAuthorizedState(snapshot, authorize.version.id) ? 'restored' : 'failed';
    }

    const homeDir = this.options.homeDir ?? homedir();
    const index = readManagedSkillIndex(homeDir);
    const current = index.entries.find((entry) => entry.registryId === snapshot.capabilityId);
    if (current?.activeVersionId === authorize.version.id
      && current.authorityRevision === authorize.capability.revision) return 'committed';
    const priorUnchanged = snapshot.previous ? exactJson(current, snapshot.previous) : current === undefined;
    if (!priorUnchanged) return 'failed';

    const versionPath = getManagedSkillVersionPath(homeDir, snapshot.capabilityId, authorize.version.id);
    const manifestPath = getManagedSkillManifestPath(homeDir, snapshot.capabilityId, authorize.version.id);
    const hasVersion = existsSync(versionPath);
    const hasManifest = existsSync(manifestPath);
    if (!hasVersion && !hasManifest) return 'restored';
    if (hasVersion && hasManifest) {
      try {
        const manifest = readManagedSkillManifest(homeDir, snapshot.capabilityId, authorize.version.id);
        verifyManagedSkillVersion(homeDir, snapshot.capabilityId, authorize.version.id);
        if (manifest.treeDigest !== authorize.version.artifactDigest
          || manifest.auditDigest !== authorize.version.auditDigest
          || authorize.binding.versionId !== authorize.version.id
          || authorize.binding.capabilityId !== snapshot.capabilityId) throw new Error('publication evidence mismatch');
        const binding: ManagedSkillBinding = {
          bindingId: authorize.binding.id,
          versionId: authorize.binding.versionId,
          scope: authorize.binding.scope,
          ownerId: this.options.ownerId,
          ...(authorize.binding.scope === CAPABILITY_SCOPE.LOCAL ? { serverId: authorize.binding.scopeId } : {}),
          ...(authorize.binding.scope === CAPABILITY_SCOPE.PROJECT ? { projectId: authorize.binding.scopeId } : {}),
          ...(authorize.binding.scope === CAPABILITY_SCOPE.SESSION ? { sessionId: authorize.binding.scopeId } : {}),
          providers: [...authorize.binding.providers],
          machines: [...authorize.binding.machines],
          active: authorize.binding.active,
          ...(authorize.binding.authorization ? { authorization: structuredClone(authorize.binding.authorization) } : {}),
        };
        const entry: ManagedSkillIndexEntry = {
          registryId: snapshot.capabilityId,
          name: manifest.name,
          description: manifest.description,
          activeVersionId: authorize.version.id,
          versions: [...new Set([...(snapshot.previous?.versions ?? []), authorize.version.id])],
          bindings: [binding],
          versionBindings: {
            ...(snapshot.previous?.versionBindings ?? {}),
            [authorize.version.id]: [structuredClone(binding)],
          },
          state: CAPABILITY_STATE.ACTIVE,
          revision: (snapshot.previous?.revision ?? 0) + 1,
          authorityRevision: authorize.capability.revision,
          updatedAt: manifest.createdAt,
          ...(snapshot.previous?.trash ? { trash: structuredClone(snapshot.previous.trash) } : {}),
        };
        writeManagedSkillIndex({
          ...index,
          revision: index.revision + 1,
          entries: [...index.entries.filter((candidate) => candidate.registryId !== snapshot.capabilityId), entry]
            .sort((left, right) => left.registryId < right.registryId ? -1 : left.registryId > right.registryId ? 1 : 0),
        }, homeDir);
        return 'committed';
      } catch {
        // Fall through to exact-WAL orphan cleanup below.
      }
    }

    rmSync(versionPath, { recursive: true, force: true });
    rmSync(manifestPath, { force: true });
    const registryRoot = getManagedSkillRegistryRoot(homeDir, snapshot.capabilityId);
    if (existsSync(registryRoot)) fsyncDirectory(registryRoot);
    return 'restored';
  }

  authorizedPublicationComplete(authorize: CapabilityOperationAuthorizeFrame): boolean {
    if (authorize.capability.kind === CAPABILITY_KIND.MCP) {
      const current = this.mcpCapabilities.get(authorize.capability.id);
      return Boolean(current
        && current.versionId === authorize.version.id
        && current.revision === authorize.capability.revision
        && current.artifactDigest === authorize.version.artifactDigest);
    }
    const homeDir = this.options.homeDir ?? homedir();
    const entry = readManagedSkillIndex(homeDir).entries.find((candidate) => candidate.registryId === authorize.capability.id);
    if (!entry || entry.activeVersionId !== authorize.version.id
      || entry.authorityRevision !== authorize.capability.revision) return false;
    const binding = entry.bindings.find((candidate) => candidate.bindingId === authorize.binding.id);
    if (!binding || binding.versionId !== authorize.version.id
      || binding.scope !== authorize.binding.scope
      || (binding.scope === CAPABILITY_SCOPE.LOCAL && binding.serverId !== authorize.binding.scopeId)
      || (binding.scope === CAPABILITY_SCOPE.PROJECT && binding.projectId !== authorize.binding.scopeId)
      || (binding.scope === CAPABILITY_SCOPE.SESSION && binding.sessionId !== authorize.binding.scopeId)
      || !exactJson(binding.providers ?? [], authorize.binding.providers)
      || !exactJson(binding.machines ?? [], authorize.binding.machines)) return false;
    try {
      const manifest = verifyManagedSkillVersion(homeDir, authorize.capability.id, authorize.version.id);
      return manifest.treeDigest === authorize.version.artifactDigest
        && manifest.auditDigest === authorize.version.auditDigest;
    } catch {
      return false;
    }
  }

  /**
   * Recover an interrupted pre-publication WAL intent. Both the exact original
   * state (mutation never began) and the exact committed state (mutation won)
   * are handled without guessing by name or touching unrelated entries.
   */
  restoreAuthorizedState(snapshot: DaemonCapabilityRollbackSnapshot, committedVersionId: string): boolean {
    if (snapshot.kind === CAPABILITY_KIND.SKILL) {
      const homeDir = this.options.homeDir ?? homedir();
      const current = readManagedSkillIndex(homeDir).entries
        .find((entry) => entry.registryId === snapshot.capabilityId);
      if ((snapshot.previous ? exactJson(current, snapshot.previous) : current === undefined)
        && !existsSync(getManagedSkillVersionPath(homeDir, snapshot.capabilityId, committedVersionId))
        && !existsSync(getManagedSkillManifestPath(homeDir, snapshot.capabilityId, committedVersionId))) return true;
      return this.rollbackAuthorizedState(snapshot, committedVersionId);
    }
    const current = this.mcpCapabilities.get(snapshot.capabilityId);
    const currentVersions = this.mcpVersionHistory.get(snapshot.capabilityId);
    if ((snapshot.previous ? exactJson(current, snapshot.previous) : current === undefined)
      && (snapshot.previousVersions
        ? exactJson([...currentVersions?.values() ?? []], snapshot.previousVersions)
        : currentVersions === undefined)) return true;
    return this.rollbackAuthorizedState(snapshot, committedVersionId);
  }

  captureManageState(capabilityId: string): DaemonCapabilityRollbackSnapshot | undefined {
    const skill = readManagedSkillIndex(this.options.homeDir ?? homedir()).entries
      .find((entry) => entry.registryId === capabilityId);
    if (skill) {
      const homeDir = this.options.homeDir ?? homedir();
      const root = join(homeDir, '.imcodes', 'capability-operation-backups');
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const backupDirectory = join(root, `${sha256(`${this.options.ownerId}\0${capabilityId}`)}-${randomUUID()}`);
      const source = getManagedSkillRegistryRoot(homeDir, capabilityId);
      try {
        mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
        if (existsSync(source)) cpSync(source, join(backupDirectory, 'registry'), { recursive: true, dereference: false, errorOnExist: true });
        for (const trash of skill.trash ?? []) {
          const trashSource = this.validManagedTrashPath(trash.trashId);
          if (!trashSource || !existsSync(trashSource)) throw new Error('managed Skill trash state is incomplete');
          const trashBackup = join(backupDirectory, 'trash', trash.trashId);
          mkdirSync(dirname(trashBackup), { recursive: true, mode: 0o700 });
          cpSync(trashSource, trashBackup, { recursive: true, dereference: false, errorOnExist: true });
        }
        return { kind: CAPABILITY_KIND.SKILL, capabilityId, previous: structuredClone(skill), backupDirectory };
      } catch {
        rmSync(backupDirectory, { recursive: true, force: true });
        return undefined;
      }
    }
    if (this.mcpCapabilities.has(capabilityId)) return this.captureAuthorizedState(capabilityId, CAPABILITY_KIND.MCP);
    return undefined;
  }

  restoreManageState(snapshot: DaemonCapabilityRollbackSnapshot): boolean {
    if (snapshot.kind === CAPABILITY_KIND.MCP) {
      if (snapshot.previous) this.mcpCapabilities.set(snapshot.capabilityId, structuredClone(snapshot.previous));
      else this.mcpCapabilities.delete(snapshot.capabilityId);
      if (snapshot.previousVersions) {
        this.mcpVersionHistory.set(snapshot.capabilityId, new Map(snapshot.previousVersions.map((entry) => [entry.capability.versionId!, structuredClone(entry)])));
      } else this.mcpVersionHistory.delete(snapshot.capabilityId);
      this.persistLocalMcpStore();
      return true;
    }
    if (!snapshot.previous || !snapshot.backupDirectory || !this.validManageBackupPath(snapshot.backupDirectory)
      || !existsSync(snapshot.backupDirectory)) return false;
    const homeDir = this.options.homeDir ?? homedir();
    const registryBackup = join(snapshot.backupDirectory, 'registry');
    if (!existsSync(registryBackup)) return false;
    const previousTrash = new Map<string, string>();
    for (const trash of snapshot.previous.trash ?? []) {
      const destination = this.validManagedTrashPath(trash.trashId);
      const source = join(snapshot.backupDirectory, 'trash', trash.trashId);
      if (!destination || !this.validManageBackupChild(source, snapshot.backupDirectory) || !existsSync(source)) return false;
      previousTrash.set(trash.trashId, source);
    }
    const current = readManagedSkillIndex(homeDir).entries.find((entry) => entry.registryId === snapshot.capabilityId);
    const currentTrashIds = current?.trash?.map((trash) => trash.trashId) ?? [];
    if (currentTrashIds.some((trashId) => !this.validManagedTrashPath(trashId))) return false;
    const destination = getManagedSkillRegistryRoot(homeDir, snapshot.capabilityId);
    try {
      rmSync(destination, { recursive: true, force: true });
      cpSync(registryBackup, destination, { recursive: true, dereference: false, errorOnExist: true });
      for (const trashId of currentTrashIds) rmSync(this.validManagedTrashPath(trashId)!, { recursive: true, force: true });
      for (const [trashId, source] of previousTrash) {
        const trashDestination = this.validManagedTrashPath(trashId)!;
        rmSync(trashDestination, { recursive: true, force: true });
        mkdirSync(dirname(trashDestination), { recursive: true, mode: 0o700 });
        cpSync(source, trashDestination, { recursive: true, dereference: false, errorOnExist: true });
      }
      const index = readManagedSkillIndex(homeDir);
      writeManagedSkillIndex({
        ...index,
        revision: index.revision + 1,
        entries: [
          ...index.entries.filter((entry) => entry.registryId !== snapshot.capabilityId),
          structuredClone(snapshot.previous),
        ].sort((left, right) => left.registryId < right.registryId ? -1 : left.registryId > right.registryId ? 1 : 0),
      }, homeDir);
      return true;
    } catch {
      return false;
    }
  }

  discardRollbackSnapshot(snapshot: DaemonCapabilityRollbackSnapshot): void {
    if (snapshot.kind === CAPABILITY_KIND.SKILL && snapshot.backupDirectory
      && this.validManageBackupPath(snapshot.backupDirectory)) {
      rmSync(snapshot.backupDirectory, { recursive: true, force: true });
    }
  }

  private validManageBackupPath(path: string): boolean {
    const root = resolve(this.options.homeDir ?? homedir(), '.imcodes', 'capability-operation-backups');
    const candidate = resolve(path);
    const rel = relative(root, candidate);
    return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
  }

  private validManageBackupChild(path: string, backupDirectory: string): boolean {
    const root = resolve(backupDirectory);
    const candidate = resolve(path);
    const rel = relative(root, candidate);
    return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
  }

  private validManagedTrashPath(trashId: string): string | undefined {
    if (!trashId || basename(trashId) !== trashId || trashId === '.' || trashId === '..') return undefined;
    const root = resolve(getManagedSkillTrashRoot(this.options.homeDir ?? homedir()));
    const candidate = resolve(root, trashId);
    const rel = relative(root, candidate);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? candidate : undefined;
  }

  manageExactLocal(input: Omit<ExactLocalSkillManageInput, 'ownerId'>): ExactLocalSkillManageResult {
    return manageExactLocalSkillBinding({ ...input, ownerId: this.options.ownerId }, this.options.homeDir ?? homedir());
  }

  manageExactLocalMcp(input: {
    serverId: string;
    capabilityId: string;
    bindingId: string;
    action: Exclude<CapabilityManageRequest['action'], typeof CAPABILITY_MANAGE_ACTION.CANCEL_OPERATION | typeof CAPABILITY_MANAGE_ACTION.DELETE_CREDENTIALS>;
    expectedRevision: number;
    finalAuthorityRevision?: number;
    versionId?: string;
  }): ExactLocalMcpManageResult {
    const current = this.mcpCapabilities.get(input.capabilityId);
    if (!current) return { ok: false, code: 'not_found' };
    const bindingIndex = current.bindings?.findIndex((binding) => binding.id === input.bindingId) ?? -1;
    if (bindingIndex < 0) return { ok: false, code: 'not_found' };
    const binding = current.bindings![bindingIndex]!;
    if (binding.scope !== CAPABILITY_SCOPE.LOCAL || binding.scopeId !== input.serverId) return { ok: false, code: 'forbidden' };
    if (current.revision !== input.expectedRevision) return { ok: false, code: 'conflict' };
    const previous = structuredClone(current);
    const next = structuredClone(current);
    const nextBinding = next.bindings![bindingIndex]!;
    if (input.action === CAPABILITY_MANAGE_ACTION.ROLLBACK) {
      const historical = input.versionId
        ? this.mcpVersionHistory.get(input.capabilityId)?.get(input.versionId)
        : undefined;
      if (!historical) return { ok: false, code: 'integrity_failed' };
      next.versionId = input.versionId;
      next.version = historical.capability.version;
      next.artifactDigest = historical.capability.artifactDigest;
      next.sourceKind = historical.capability.sourceKind;
      next.sourceLabel = historical.capability.sourceLabel;
      next.tools = structuredClone(historical.capability.tools);
      next.permissions = structuredClone(historical.capability.permissions);
      next.hasScripts = historical.capability.hasScripts;
      next.hasExecutables = historical.capability.hasExecutables;
      next.stdioCommand = structuredClone(historical.capability.stdioCommand);
      nextBinding.versionId = input.versionId;
      nextBinding.active = true;
      next.revision = input.finalAuthorityRevision ?? input.expectedRevision + 1;
      next.state = CAPABILITY_STATE.RUNTIME_PENDING;
      next.readiness = CAPABILITY_READINESS.RUNTIME_PENDING;
    } else if (input.action === CAPABILITY_MANAGE_ACTION.ENABLE || input.action === CAPABILITY_MANAGE_ACTION.RESTORE) {
      if (!nextBinding.versionId || !this.mcpVersionHistory.get(input.capabilityId)?.has(nextBinding.versionId)) {
        return { ok: false, code: 'integrity_failed' };
      }
      nextBinding.active = true;
      next.state = CAPABILITY_STATE.RUNTIME_PENDING;
      next.readiness = CAPABILITY_READINESS.RUNTIME_PENDING;
      next.revision = input.finalAuthorityRevision ?? input.expectedRevision + 1;
    } else if (input.action === CAPABILITY_MANAGE_ACTION.DISABLE || input.action === CAPABILITY_MANAGE_ACTION.UNINSTALL) {
      nextBinding.active = false;
      const anyActive = next.bindings?.some((candidate) => candidate.active) ?? false;
      next.state = anyActive ? CAPABILITY_STATE.RUNTIME_PENDING
        : input.action === CAPABILITY_MANAGE_ACTION.UNINSTALL ? CAPABILITY_STATE.TOMBSTONED : CAPABILITY_STATE.DISABLED;
      next.revision = input.finalAuthorityRevision ?? input.expectedRevision + 1;
    } else {
      return { ok: false, code: 'invalid_action' };
    }
    next.updatedAt = Date.now();
    this.mcpCapabilities.set(input.capabilityId, next);
    try {
      this.persistLocalMcpStore();
    } catch {
      this.mcpCapabilities.set(input.capabilityId, previous);
      return { ok: false, code: 'integrity_failed' };
    }
    return { ok: true, capability: structuredClone(next) };
  }

  private startMcpInstall(
    input: CapabilityInstallRequest,
    onTransition?: (result: CapabilityOperationResult) => void,
  ): DaemonCapabilityInstallStart {
    const definition = normalizeCapabilityMcpDefinition(input.source, input.displayName);
    if (!definition) {
      const error = errorResult(CAPABILITY_ERROR.INVALID_INPUT, 'MCP definition is invalid, secret-bearing, or unsupported');
      return { initial: error, completion: Promise.resolve(error) };
    }
    const existingId = this.mcpOperationByIdempotency.get(input.idempotencyKey);
    const existing = existingId ? this.mcpOperations.get(existingId) : undefined;
    if (existing) {
      const result = { status: 'ok' as const, operation: structuredClone(existing.operation) };
      return { initial: result, completion: Promise.resolve(result) };
    }
    const terminal = [...this.mcpOperations.values()]
      .filter((candidate) => isCapabilityInstallTerminal(candidate.operation.state))
      .sort((left, right) => right.operation.updatedAt - left.operation.updatedAt);
    for (const candidate of terminal.slice(Math.max(0, CAPABILITY_LIMITS.RETAINED_TERMINAL_OPERATIONS - 1))) {
      this.mcpOperations.delete(candidate.operation.id);
      for (const [key, operationId] of this.mcpOperationByIdempotency) {
        if (operationId === candidate.operation.id) this.mcpOperationByIdempotency.delete(key);
      }
      this.installRequests.delete(candidate.operation.id);
    }
    const activeJobs = [...this.mcpOperations.values()]
      .filter((candidate) => !isCapabilityInstallTerminal(candidate.operation.state)).length;
    if (activeJobs >= CAPABILITY_LIMITS.ACTIVE_INSTALL_JOBS) {
      const limited = errorResult(CAPABILITY_ERROR.RATE_LIMITED, 'Too many active capability install jobs', true);
      return { initial: limited, completion: Promise.resolve(limited) };
    }
    const now = Date.now();
    const local: LocalMcpOperation = {
      definition,
      sourceKind: input.source.kind,
      operation: {
        id: randomUUID(), kind: CAPABILITY_KIND.MCP, state: CAPABILITY_INSTALL_STATE.QUEUED, revision: 1,
        displayName: definition.name, scope: input.scope, findings: [],
        sourceLabel: mcpSourceLabel(definition),
        providers: [...(input.providers ?? [])], machines: [...(input.machines ?? [])],
        tools: [...(definition.toolAllowlist ?? [])],
        permissions: mcpPermissions(definition),
        hasScripts: false, hasExecutables: definition.transport === CAPABILITY_MCP_TRANSPORT.STDIO,
        ...(definition.command ? { stdioCommand: [definition.command, ...(definition.args ?? [])] } : {}),
        createdAt: now, updatedAt: now,
      },
    };
    this.mcpOperations.set(local.operation.id, local);
    this.mcpOperationByIdempotency.set(input.idempotencyKey, local.operation.id);
    this.installRequests.set(local.operation.id, structuredClone(input));
    const notify = (): void => onTransition?.({ status: 'ok', operation: structuredClone(local.operation) });
    const completion = Promise.resolve().then(async (): Promise<CapabilityOperationResult | CapabilityErrorResult> => {
      try {
        this.transitionMcp(local, CAPABILITY_INSTALL_STATE.ACQUIRING); notify();
        const canonical = JSON.stringify(definition);
        local.operation.artifactDigest = sha256(canonical);
        if (input.capabilityId) {
          const current = this.mcpCapabilities.get(input.capabilityId);
          const binding = current?.bindings?.find((candidate) => candidate.id === input.bindingId);
          local.operation.updateDiff = [
            `target_capability:${input.capabilityId}`,
            ...(input.bindingId ? [`target_binding:${input.bindingId}`] : []),
            `artifact:${binding && current?.artifactDigest ? current.artifactDigest : 'previous_unavailable'}->${local.operation.artifactDigest}`,
          ];
        }
        local.operation.findings = definition.command ? [{
          code: 'stdio_command', severity: CAPABILITY_FINDING_SEVERITY.MEDIUM,
          message: 'This MCP definition launches a local stdio command after activation.',
          path: 'definition.command', source: 'scanner', blocking: false,
        }] : [];
        this.transitionMcp(local, CAPABILITY_INSTALL_STATE.SCANNING); notify();
        const scannerDigest = sha256(`imcodes-mcp-scan-v1\0${canonical}`);
        local.scannerDigest = scannerDigest;
        this.transitionMcp(local, CAPABILITY_INSTALL_STATE.AUDITING); notify();
        local.abortController = new AbortController();
        const evidence = await runCapabilityAudit({
          runner: this.options.auditRunner ?? new ClaudeCapabilityAuditRunner(),
          conversationIdentity: this.options.conversationIdentity,
          envelope: buildMcpCapabilityAuditEnvelope(definition, local.operation.artifactDigest, scannerDigest),
          signal: local.abortController.signal,
        });
        local.auditEvidence = structuredClone(evidence);
        local.abortController = undefined;
        if (local.operation.state === CAPABILITY_INSTALL_STATE.CANCELLED) return { status: 'ok', operation: structuredClone(local.operation) };
        local.operation.auditDigest = evidence.auditDigest;
        local.operation.auditVerdict = evidence.verdict;
        const scannerFindings = local.operation.findings.filter((finding) => finding.source === 'scanner');
        const auditFindings = evidence.findings.map(findingFromView);
        const scannerKeys = new Set(scannerFindings.map((finding) => `${finding.code}\0${finding.path ?? ''}\0${finding.message}`));
        local.operation.findings = [
          ...scannerFindings,
          ...auditFindings.filter((finding) => !scannerKeys.has(`${finding.code}\0${finding.path ?? ''}\0${finding.message}`)),
        ].slice(0, CAPABILITY_LIMITS.FINDINGS);
        this.transitionMcp(local, evidence.verdict === CAPABILITY_AUDIT_VERDICT.PASS
          ? CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION
          : CAPABILITY_INSTALL_STATE.REWORK);
        notify();
        return { status: 'ok', operation: structuredClone(local.operation) };
      } catch {
        local.abortController = undefined;
        if (local.operation.state !== CAPABILITY_INSTALL_STATE.CANCELLED) {
          local.operation.errorCode = CAPABILITY_ERROR.AUDIT_REWORK;
          local.operation.errorMessage = 'MCP admission audit was unavailable or invalid';
          this.transitionMcp(local, CAPABILITY_INSTALL_STATE.REWORK); notify();
        }
        return { status: 'ok', operation: structuredClone(local.operation) };
      }
    });
    const initial = { status: 'ok' as const, operation: structuredClone(local.operation) };
    return { initial, completion };
  }

  private transitionMcp(local: LocalMcpOperation, state: CapabilityOperation['state']): void {
    local.operation.state = state;
    local.operation.revision += 1;
    local.operation.updatedAt = Date.now();
  }

}

export function createDefaultCapabilityService(options: DaemonCapabilityServiceAdapterOptions): DaemonCapabilityServiceAdapter {
  return new DaemonCapabilityServiceAdapter(options);
}
