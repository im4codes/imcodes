/**
 * Provider-independent contracts for AI-managed MCP services and Agent Skills.
 *
 * Keep this module free of daemon/server/web dependencies. It is the one source
 * of truth for tool names, states, limits, DTOs, and JSON-schema descriptors.
 */

export const CAPABILITY_KIND = {
  SKILL: 'skill',
  MCP: 'mcp',
} as const;
export type CapabilityKind = typeof CAPABILITY_KIND[keyof typeof CAPABILITY_KIND];

export const CAPABILITY_MCP_TRANSPORT = {
  STDIO: 'stdio',
  STREAMABLE_HTTP: 'streamable_http',
} as const;
export type CapabilityMcpTransport = typeof CAPABILITY_MCP_TRANSPORT[keyof typeof CAPABILITY_MCP_TRANSPORT];

export interface CapabilityCredentialReference {
  credentialRef: string;
}

export interface CapabilityMcpDefinition {
  name: string;
  transport: CapabilityMcpTransport;
  command?: string;
  args?: readonly string[];
  url?: string;
  credentialRef?: string;
  env?: Readonly<Record<string, CapabilityCredentialReference>>;
  headers?: Readonly<Record<string, CapabilityCredentialReference>>;
  toolAllowlist?: readonly string[];
}

export const CAPABILITY_SCOPE = {
  LOCAL: 'local',
  ACCOUNT: 'account',
  PROJECT: 'project',
  SESSION: 'session',
} as const;
export type CapabilityScope = typeof CAPABILITY_SCOPE[keyof typeof CAPABILITY_SCOPE];

export const CAPABILITY_SOURCE_KIND = {
  URL: 'url',
  REPOSITORY: 'repository',
  LOCAL_PATH: 'local_path',
  INLINE: 'inline',
  MCP_CONFIG: 'mcp_config',
} as const;
export type CapabilitySourceKind = typeof CAPABILITY_SOURCE_KIND[keyof typeof CAPABILITY_SOURCE_KIND];

export const CAPABILITY_INSTALL_STATE = {
  QUEUED: 'queued',
  ACQUIRING: 'acquiring',
  SCANNING: 'scanning',
  AUDITING: 'auditing',
  AWAITING_CONFIRMATION: 'awaiting_confirmation',
  INSTALLING: 'installing',
  SYNCING: 'syncing',
  INSTALLED: 'installed',
  REWORK: 'rework',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
export const CAPABILITY_INSTALL_STATES = Object.values(CAPABILITY_INSTALL_STATE);
export type CapabilityInstallState = typeof CAPABILITY_INSTALL_STATE[keyof typeof CAPABILITY_INSTALL_STATE];

export const CAPABILITY_STATE = {
  PENDING: 'pending',
  ACTIVE: 'active',
  DISABLED: 'disabled',
  RUNTIME_PENDING: 'runtime_pending',
  TOMBSTONED: 'tombstoned',
  REMOVED: 'removed',
  DEGRADED: 'degraded',
} as const;
export const CAPABILITY_LIFECYCLE_STATES = Object.values(CAPABILITY_STATE);
export type CapabilityLifecycleState = typeof CAPABILITY_STATE[keyof typeof CAPABILITY_STATE];

export const CAPABILITY_MANAGE_ACTION = {
  ENABLE: 'enable',
  DISABLE: 'disable',
  ROLLBACK: 'rollback',
  UNINSTALL: 'uninstall',
  RESTORE: 'restore',
  DELETE_CREDENTIALS: 'delete_credentials',
  CANCEL_OPERATION: 'cancel_operation',
} as const;
export const CAPABILITY_MANAGEMENT_ACTIONS = Object.values(CAPABILITY_MANAGE_ACTION);
/** Actions truthfully available through the v1 AI/UI surface. */
export const CAPABILITY_AVAILABLE_MANAGEMENT_ACTIONS = CAPABILITY_MANAGEMENT_ACTIONS.filter(
  (action) => action !== CAPABILITY_MANAGE_ACTION.DELETE_CREDENTIALS,
);
export type CapabilityManagementAction = typeof CAPABILITY_MANAGE_ACTION[keyof typeof CAPABILITY_MANAGE_ACTION];

export const CAPABILITY_CONFIRMATION_DECISION = {
  INSTALL: 'install',
  CANCEL: 'cancel',
} as const;
export type CapabilityConfirmationDecision = typeof CAPABILITY_CONFIRMATION_DECISION[keyof typeof CAPABILITY_CONFIRMATION_DECISION];

export const CAPABILITY_HTTP_PATH = {
  LIST: '/api/capabilities',
  INSTALL: '/api/capabilities/install',
  OPERATION_PREFIX: '/api/capabilities/operations',
  MANAGE_PREFIX: '/api/capabilities',
  BLOB_PREFIX: '/api/capabilities/blobs',
} as const;

export const CAPABILITY_SYNC_MSG = {
  REQUEST: 'capability.sync.request',
  SNAPSHOT: 'capability.sync.snapshot',
  DELTA: 'capability.sync.delta',
  BLOB_CAPABILITY: 'capability.sync.blob_capability',
  TOMBSTONE: 'capability.sync.tombstone',
  READINESS: 'capability.sync.readiness',
  ACK: 'capability.sync.ack',
  AUTHORITY: 'capability.sync.authority',
} as const;
export type CapabilitySyncMessage = typeof CAPABILITY_SYNC_MSG[keyof typeof CAPABILITY_SYNC_MSG];

/**
 * Account-authenticated server <-> daemon operation frames. These are kept
 * separate from sync snapshots so accepting HTTP work never implies that the
 * daemon actually started or completed it.
 */
export const CAPABILITY_OPERATION_MSG = {
  INSTALL: 'capability.operation.install',
  PROGRESS: 'capability.operation.progress',
  CONFIRM: 'capability.operation.confirm',
  CANCEL: 'capability.operation.cancel',
  ACTIVATE: 'capability.operation.activate',
  AUTHORIZE: 'capability.operation.authorize',
  COMMIT_RESULT: 'capability.operation.commit_result',
  COMMIT_ACK: 'capability.operation.commit_ack',
  COMMIT_ABORT: 'capability.operation.commit_abort',
  MANAGE: 'capability.operation.manage',
  MANAGE_RESULT: 'capability.operation.manage_result',
  MANAGE_ACK: 'capability.operation.manage_ack',
} as const;
export type CapabilityOperationMessage = typeof CAPABILITY_OPERATION_MSG[keyof typeof CAPABILITY_OPERATION_MSG];

export const CAPABILITY_BLOB_ACTION = {
  UPLOAD: 'upload',
  DOWNLOAD: 'download',
} as const;
export type CapabilityBlobAction = typeof CAPABILITY_BLOB_ACTION[keyof typeof CAPABILITY_BLOB_ACTION];

/** Dedicated one-use blob grant; daemon identity stays in Authorization/X-Server-Id. */
export const CAPABILITY_BLOB_TOKEN_HEADER = 'X-Capability-Blob-Token' as const;

export const CAPABILITY_AUTHORIZATION_ALGORITHM = {
  ED25519: 'Ed25519',
} as const;
export type CapabilityAuthorizationAlgorithm = typeof CAPABILITY_AUTHORIZATION_ALGORITHM[keyof typeof CAPABILITY_AUTHORIZATION_ALGORITHM];

export const CAPABILITY_AUTHORITY_STATE = {
  ACTIVE: 'active',
  DISABLED: 'disabled',
  REMOVED: 'removed',
} as const;
export type CapabilityAuthorityState = typeof CAPABILITY_AUTHORITY_STATE[keyof typeof CAPABILITY_AUTHORITY_STATE];

export const CAPABILITY_MANAGE_PHASE = {
  PREPARE: 'prepare',
  COMMIT: 'commit',
  ABORT: 'abort',
} as const;
export type CapabilityManagePhase = typeof CAPABILITY_MANAGE_PHASE[keyof typeof CAPABILITY_MANAGE_PHASE];

export const CAPABILITY_MANAGE_RESULT_PHASE = {
  PREPARED: 'prepared',
  APPLIED: 'applied',
  ABORTED: 'aborted',
} as const;
export type CapabilityManageResultPhase = typeof CAPABILITY_MANAGE_RESULT_PHASE[keyof typeof CAPABILITY_MANAGE_RESULT_PHASE];

export function capabilityOperationPath(operationId: string): string {
  return `${CAPABILITY_HTTP_PATH.OPERATION_PREFIX}/${encodeURIComponent(operationId)}`;
}

export function capabilityConfirmationPath(operationId: string): string {
  return `${capabilityOperationPath(operationId)}/confirmation`;
}

export function capabilityCancellationPath(operationId: string): string {
  return `${capabilityOperationPath(operationId)}/cancel`;
}

export function capabilityManagePath(capabilityId: string): string {
  return `${CAPABILITY_HTTP_PATH.MANAGE_PREFIX}/${encodeURIComponent(capabilityId)}/manage`;
}

export function capabilityBlobAccessPath(versionId: string): string {
  return `${CAPABILITY_HTTP_PATH.BLOB_PREFIX}/${encodeURIComponent(versionId)}/access`;
}

export function capabilityBlobTransferPath(versionId: string): string {
  return `${CAPABILITY_HTTP_PATH.BLOB_PREFIX}/${encodeURIComponent(versionId)}`;
}

export const CAPABILITY_AUDIT_VERDICT = {
  PASS: 'PASS',
  REWORK: 'REWORK',
} as const;
export type CapabilityAuditVerdict = typeof CAPABILITY_AUDIT_VERDICT[keyof typeof CAPABILITY_AUDIT_VERDICT];

export const CAPABILITY_FINDING_SEVERITY = {
  INFO: 'info',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const;
export type CapabilityFindingSeverity = typeof CAPABILITY_FINDING_SEVERITY[keyof typeof CAPABILITY_FINDING_SEVERITY];

export const CAPABILITY_READINESS = {
  READY: 'ready',
  RUNTIME_PENDING: 'runtime_pending',
  CONTENT_MISSING: 'content_missing',
  INTEGRITY_FAILED: 'integrity_failed',
  DEPENDENCY_MISSING: 'dependency_missing',
  PROVIDER_UNSUPPORTED: 'provider_unsupported',
  MACHINE_OFFLINE: 'machine_offline',
} as const;
export type CapabilityReadiness = typeof CAPABILITY_READINESS[keyof typeof CAPABILITY_READINESS];

/**
 * Truthful v1 managed-Skill projection support. Providers share one startup
 * context, but IM.codes does not currently own their hot-resume/compaction
 * hooks or expose packaged resources. Consumers must render these as degraded
 * capabilities instead of inferring parity from a successful cold launch.
 */
export const MANAGED_SKILL_PROVIDER_COMPATIBILITY = {
  COLD_LAUNCH: 'supported',
  COLD_RESTORE: 'supported',
  PROVIDER_RELAUNCH: 'supported',
  APPEND_STEER: 'provider_retained_context',
  HOT_RESUME: 'degraded_provider_context_unverified',
  COMPACTION: 'degraded_provider_context_unverified',
  PACKAGED_RESOURCES: 'unavailable',
  NATIVE_INSTALL_INTERCEPTION: 'policy_only',
} as const;
export type ManagedSkillProviderCompatibility = typeof MANAGED_SKILL_PROVIDER_COMPATIBILITY;

export const CAPABILITY_ERROR = {
  INVALID_INPUT: 'invalid_input',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  AMBIGUOUS: 'ambiguous',
  CONFLICT: 'conflict',
  RATE_LIMITED: 'rate_limited',
  ACQUISITION_FAILED: 'acquisition_failed',
  SCAN_BLOCKED: 'scan_blocked',
  AUDIT_REWORK: 'audit_rework',
  AUDITOR_UNAVAILABLE: 'auditor_unavailable',
  CONFIRMATION_REQUIRED: 'confirmation_required',
  CONFIRMATION_STALE: 'confirmation_stale',
  INTEGRITY_FAILED: 'integrity_failed',
  RUNTIME_PENDING: 'runtime_pending',
  INTERNAL_ERROR: 'internal_error',
} as const;
export type CapabilityErrorCode = typeof CAPABILITY_ERROR[keyof typeof CAPABILITY_ERROR];

export const CAPABILITY_LIMITS = {
  OPAQUE_ID_BYTES: 128,
  DISPLAY_NAME_CHARS: 96,
  SOURCE_CHARS: 8_192,
  USER_INTENT_BYTES: 4 * 1024,
  INLINE_PACKAGE_BYTES: 512 * 1024,
  PACKAGE_BYTES: 16 * 1024 * 1024,
  FILE_BYTES: 4 * 1024 * 1024,
  FILE_COUNT: 256,
  PATH_BYTES: 1_024,
  TREE_DEPTH: 12,
  FINDINGS: 64,
  FINDING_TEXT_BYTES: 4 * 1024,
  AUDIT_ENVELOPE_BYTES: 256 * 1024,
  MCP_IMPORT_ENTRIES: 64,
  INSTALL_BATCH_CONCURRENCY: 4,
  LIST_DEFAULT: 50,
  LIST_MAX: 200,
  SYNC_ITEMS: 200,
  SYNC_VERSIONS: 256,
  SYNC_BINDINGS: 256,
  SYNC_TOMBSTONES: 200,
  /** Maximum encoded JSON size accepted by both WebSocket peers and persistence. */
  SYNC_FRAME_BYTES: 16 * 1024 * 1024,
  SYNC_ITEM_RECORD_BYTES: 4 * 1024,
  SYNC_VERSION_RECORD_BYTES: 32 * 1024,
  SYNC_BINDING_RECORD_BYTES: 12 * 1024,
  SYNC_TOMBSTONE_RECORD_BYTES: 2 * 1024,
  PERSISTED_VERSION_RECORD_BYTES: 512 * 1024,
  PROVIDERS: 16,
  PROVIDER_ID_BYTES: 64,
  MACHINES: 64,
  MACHINE_ID_BYTES: 128,
  AMBIGUOUS_CHOICES: 12,
  ACTIVE_INSTALL_JOBS: 8,
  RETAINED_TERMINAL_OPERATIONS: 64,
  RETAINED_AUDIT_EVENTS: 1_024,
  PERSISTED_CANDIDATES: 8,
  PERSISTED_CANDIDATE_BYTES: 40 * 1024 * 1024,
  /** Reviewed daemon candidate retention before confirmation/proposal expiry. */
  PERSISTED_CANDIDATE_TTL_MS: 30 * 60 * 1000,
} as const;

export const MANAGED_SKILL_ROOT_SEGMENTS = ['.imcodes', 'skills', 'managed'] as const;
export const MANAGED_SKILL_STORE_MARKER = '.imcodes-managed-skill-store-v1';

export interface CapabilityFinding {
  code: string;
  severity: CapabilityFindingSeverity;
  message: string;
  path?: string;
  remediation?: string;
  source: 'scanner' | 'auditor' | 'runtime';
  blocking: boolean;
}

export interface CapabilitySource {
  kind: CapabilitySourceKind;
  value?: string;
  repositorySubdir?: string;
  inlineFiles?: Readonly<Record<string, string>>;
  mcpConfig?: Readonly<Record<string, unknown>>;
}

export interface CapabilityBinding {
  id: string;
  /** Exact immutable version selected by this binding. */
  versionId?: string;
  scope: CapabilityScope;
  scopeId?: string;
  providers: readonly string[];
  machines: readonly string[];
  active: boolean;
}

export interface CapabilitySyncBinding extends CapabilityBinding {
  capabilityId: string;
  versionId: string;
  /** Required for every managed Skill binding; MCP bindings do not carry one. */
  authorization?: CapabilitySkillAuthorizationEnvelope;
}

/** Public verification key learned only over the authenticated daemon link. */
export interface CapabilityAuthorizationKey {
  keyId: string;
  algorithm: CapabilityAuthorizationAlgorithm;
  /** Base64url-encoded DER SubjectPublicKeyInfo. */
  publicKeySpki: string;
}

/**
 * Server-signed authority for one exact immutable Skill version and binding.
 * The public key stored beside a package is never a trust anchor; daemons must
 * verify with a key learned over their currently authenticated server link.
 */
export interface CapabilitySkillAuthorizationEnvelope {
  schemaVersion: 1;
  algorithm: typeof CAPABILITY_AUTHORIZATION_ALGORITHM.ED25519;
  keyId: string;
  ownerId: string;
  capabilityId: string;
  versionId: string;
  artifactDigest: string;
  auditDigest: string;
  blobDigest?: string;
  bindingId: string;
  bindingDigest: string;
  /** Exact final item revision reserved by the server for this authority. */
  itemRevision: number;
  /** Exact final binding revision reserved by the server for this authority. */
  bindingRevision: number;
  /** Current authority state; an old ACTIVE signature is invalid after this changes. */
  bindingState: CapabilityAuthorityState;
  issuedRevision: number;
  issuedAt: number;
  /** Base64url Ed25519 signature over canonicalCapabilitySkillAuthorizationPayload. */
  signature: string;
}

export function canonicalCapabilityBindingAuthorizationPayload(binding: Pick<CapabilitySyncBinding,
  'id' | 'capabilityId' | 'versionId' | 'scope' | 'scopeId' | 'providers' | 'machines' | 'active'>): string {
  return JSON.stringify(canonicalCapabilitySyncValue({
    id: binding.id,
    capabilityId: binding.capabilityId,
    versionId: binding.versionId,
    scope: binding.scope,
    scopeId: binding.scopeId,
    providers: [...binding.providers],
    machines: [...binding.machines],
    active: binding.active,
  }));
}

export interface CapabilityAuthorityRecord {
  capabilityId: string;
  versionId: string;
  bindingId: string;
  state: CapabilityAuthorityState;
  itemRevision: number;
  bindingRevision: number;
  /** Required for Skill authority records, absent for MCP metadata records. */
  authorization?: CapabilitySkillAuthorizationEnvelope;
}

export function canonicalCapabilitySkillAuthorizationPayload(
  envelope: Omit<CapabilitySkillAuthorizationEnvelope, 'signature'>,
): string {
  return JSON.stringify(canonicalCapabilitySyncValue(envelope));
}

export interface CapabilityVersion {
  id: string;
  capabilityId: string;
  version: number;
  artifactDigest: string;
  /** SHA-256 of the bounded transfer archive, distinct from artifactDigest's tree hash. */
  blobDigest?: string;
  blobByteSize?: number;
  /** Exact audited non-secret MCP definition; forbidden for Skill versions. */
  definition?: CapabilityMcpDefinition;
  auditDigest: string;
  auditVerdict: CapabilityAuditVerdict;
  sourceKind: CapabilitySourceKind;
  sourceLocator?: string;
  createdAt: number;
}

export interface CapabilitySummary {
  id: string;
  revision: number;
  kind: CapabilityKind;
  name: string;
  state: CapabilityLifecycleState;
  scope: CapabilityScope;
  versionId?: string;
  version?: number;
  availableVersions?: readonly {
    id: string;
    label: string;
    version?: number;
    createdAt?: number;
  }[];
  artifactDigest?: string;
  sourceKind?: CapabilitySourceKind;
  sourceLabel?: string;
  readiness: CapabilityReadiness;
  findings: readonly CapabilityFinding[];
  bindings?: readonly CapabilityBinding[];
  tools?: readonly string[];
  permissions?: readonly string[];
  hasScripts?: boolean;
  hasExecutables?: boolean;
  stdioCommand?: readonly string[];
  credentialsRetained?: boolean;
  updatedAt: number;
}

export interface CapabilityOperation {
  id: string;
  capabilityId?: string;
  kind: CapabilityKind;
  state: CapabilityInstallState;
  revision: number;
  displayName?: string;
  /** Content-safe provenance label (host/repository/basename), never a raw config or secret-bearing path. */
  sourceLabel?: string;
  scope: CapabilityScope;
  artifactDigest?: string;
  auditDigest?: string;
  auditVerdict?: CapabilityAuditVerdict;
  findings: readonly CapabilityFinding[];
  providers: readonly string[];
  machines: readonly string[];
  tools?: readonly string[];
  permissions?: readonly string[];
  updateDiff?: readonly string[];
  hasScripts: boolean;
  hasExecutables: boolean;
  stdioCommand?: readonly string[];
  errorCode?: CapabilityErrorCode;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CapabilityAuditEvidence {
  operationId: string;
  artifactDigest: string;
  scannerPolicyVersion: string;
  auditorPolicyVersion: string;
  auditorIdentity: string;
  verdict: CapabilityAuditVerdict;
  findings: readonly CapabilityFinding[];
  digest: string;
  createdAt: number;
}

export interface CapabilityConfirmation {
  operationId: string;
  revision: number;
  artifactDigest: string;
  auditDigest: string;
  scope: CapabilityScope;
  providers: readonly string[];
  machines: readonly string[];
  decision: CapabilityConfirmationDecision;
}

export interface CapabilityMachineReadiness {
  capabilityId: string;
  versionId?: string;
  serverId: string;
  readiness: CapabilityReadiness;
  reasons: readonly string[];
  revision: number;
  verifiedAt: number;
}

export interface CapabilityTombstone {
  id: string;
  capabilityId: string;
  scope: CapabilityScope;
  serverId?: string;
  accountRevision: number;
  expiresAt: number;
  createdAt: number;
}

export interface CapabilitySyncSnapshot {
  type: typeof CAPABILITY_SYNC_MSG.SNAPSHOT | typeof CAPABILITY_SYNC_MSG.DELTA;
  ownerId: string;
  revision: number;
  items: readonly CapabilitySummary[];
  versions: readonly CapabilityVersion[];
  bindings: readonly CapabilitySyncBinding[];
  tombstones: readonly CapabilityTombstone[];
  /** Runtime trust anchors delivered by the authenticated server link. */
  authorizationKeys: readonly CapabilityAuthorizationKey[];
  digest: string;
}

export interface CapabilitySyncTombstoneFrame {
  type: typeof CAPABILITY_SYNC_MSG.TOMBSTONE;
  ownerId: string;
  revision: number;
  tombstone: CapabilityTombstone;
  digest: string;
}

/**
 * Complete current resolver authority for one authenticated owner/daemon.
 * The daemon replaces its prior in-memory map atomically; omission revokes.
 */
export interface CapabilitySyncAuthorityFrame {
  type: typeof CAPABILITY_SYNC_MSG.AUTHORITY;
  ownerId: string;
  serverId: string;
  revision: number;
  records: readonly CapabilityAuthorityRecord[];
  authorizationKeys: readonly CapabilityAuthorizationKey[];
  digest: string;
}

export type CapabilitySyncDigestFrame = CapabilitySyncSnapshot | CapabilitySyncTombstoneFrame | CapabilitySyncAuthorityFrame;

function canonicalCapabilitySyncValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalCapabilitySyncValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => [key, canonicalCapabilitySyncValue(entry)]));
}

/**
 * Returns the environment-neutral canonical wire preimage used by both the
 * server and daemon. Array order is significant; object key order is not.
 */
export function canonicalCapabilitySyncDigestPayload(frame: CapabilitySyncDigestFrame): string {
  const payload = frame.type === CAPABILITY_SYNC_MSG.TOMBSTONE
    ? { type: frame.type, ownerId: frame.ownerId, revision: frame.revision, tombstone: frame.tombstone }
    : frame.type === CAPABILITY_SYNC_MSG.AUTHORITY
      ? {
          type: frame.type,
          ownerId: frame.ownerId,
          serverId: frame.serverId,
          revision: frame.revision,
          records: frame.records,
          authorizationKeys: frame.authorizationKeys,
        }
      : {
        type: frame.type,
        ownerId: frame.ownerId,
        revision: frame.revision,
        items: frame.items,
        versions: frame.versions,
        bindings: frame.bindings,
        tombstones: frame.tombstones,
        authorizationKeys: frame.authorizationKeys,
      };
  return JSON.stringify(canonicalCapabilitySyncValue(payload));
}

/** Hashes a canonical sync frame without coupling shared browser code to Node. */
export function computeCapabilitySyncDigest(
  frame: CapabilitySyncDigestFrame,
  digest: (canonicalPayload: string) => string,
): string {
  return digest(canonicalCapabilitySyncDigestPayload(frame));
}

export interface CapabilitySyncReadinessFrame {
  type: typeof CAPABILITY_SYNC_MSG.READINESS;
  capabilityId: string;
  readiness: CapabilityReadiness;
  reasons: readonly string[];
  revision: number;
  manifestDigest?: string;
}

export interface CapabilitySyncAck {
  type: typeof CAPABILITY_SYNC_MSG.ACK;
  revision: number;
  digest: string;
}

export interface CapabilityBlobAccess {
  action: CapabilityBlobAction;
  capabilityId: string;
  versionId: string;
  /** SHA-256 of the exact transfer bytes; never the package tree digest. */
  blobDigest: string;
  maxBytes: number;
  expiresAt: number;
  singleUseToken: string;
}

export interface CapabilityBlobAccessFrame {
  type: typeof CAPABILITY_SYNC_MSG.BLOB_CAPABILITY;
  /** Present only on the source-daemon upload grant so it can find reviewed bytes. */
  operationId?: string;
  /** Operation CAS revision used when reporting a missing/restarted candidate. */
  expectedRevision?: number;
  access: CapabilityBlobAccess;
}

export interface CapabilityInstallRequest {
  /** Exact existing server-authoritative item to update; never inferred by name. */
  capabilityId?: string;
  /** Exact existing binding to update; required together with capabilityId. */
  bindingId?: string;
  kind: CapabilityKind;
  source: CapabilitySource;
  displayName?: string;
  scope: CapabilityScope;
  scopeId?: string;
  providers?: readonly string[];
  machines?: readonly string[];
  idempotencyKey: string;
  userIntent?: string;
}

export interface CapabilityOperationInstallFrame {
  type: typeof CAPABILITY_OPERATION_MSG.INSTALL;
  operationId: string;
  revision: number;
  /** Bound by the authenticated server bridge; never accepted from a browser. */
  ownerId: string;
  request: CapabilityInstallRequest;
}

export interface CapabilityOperationProgressFrame {
  type: typeof CAPABILITY_OPERATION_MSG.PROGRESS;
  operationId: string;
  expectedRevision: number;
  state: CapabilityInstallState;
  artifactDigest?: string;
  auditDigest?: string;
  auditVerdict?: CapabilityAuditVerdict;
  findings?: readonly CapabilityFinding[];
  displayName?: string;
  sourceLabel?: string;
  tools?: readonly string[];
  permissions?: readonly string[];
  updateDiff?: readonly string[];
  hasScripts?: boolean;
  hasExecutables?: boolean;
  stdioCommand?: readonly string[];
  errorCode?: CapabilityErrorCode;
  errorMessage?: string;
}

export interface CapabilityOperationActivateFrame {
  type: typeof CAPABILITY_OPERATION_MSG.ACTIVATE;
  operationId: string;
  expectedRevision: number;
  capability: CapabilitySummary;
  version: CapabilityVersion;
  binding: CapabilitySyncBinding;
  /** Exact audited non-secret definition; present only for MCP activation. */
  definition?: CapabilityMcpDefinition;
}

/** Server-authoritative candidate identity and Skill authorization. */
export interface CapabilityOperationAuthorizeFrame {
  type: typeof CAPABILITY_OPERATION_MSG.AUTHORIZE;
  operationId: string;
  expectedRevision: number;
  capability: CapabilitySummary;
  version: CapabilityVersion;
  binding: CapabilitySyncBinding;
  authorizationKeys: readonly CapabilityAuthorizationKey[];
  /** Server candidate expiry; a daemon must not publish after this instant. */
  expiresAt: number;
}

/** Daemon acknowledgement after the exact authorized package/index is durable. */
export interface CapabilityOperationCommitResultFrame {
  type: typeof CAPABILITY_OPERATION_MSG.COMMIT_RESULT;
  operationId: string;
  expectedRevision: number;
  capabilityId: string;
  versionId: string;
  bindingId: string;
  authorityRevision: number;
  ok: boolean;
  errorCode?: CapabilityErrorCode;
  errorMessage?: string;
}

/** Server acknowledgement of an idempotently committed daemon outbox record. */
export interface CapabilityOperationCommitAckFrame {
  type: typeof CAPABILITY_OPERATION_MSG.COMMIT_ACK;
  operationId: string;
  capabilityId: string;
  versionId: string;
  bindingId: string;
  authorityRevision: number;
}

/** Server rejection/expiry directive; daemon rolls back only the exact candidate. */
export interface CapabilityOperationCommitAbortFrame {
  type: typeof CAPABILITY_OPERATION_MSG.COMMIT_ABORT;
  operationId: string;
  capabilityId: string;
  versionId: string;
  bindingId: string;
  authorityRevision: number;
  errorCode: CapabilityErrorCode;
  errorMessage?: string;
}

/** Browser decision relayed by the server to the exact daemon operation. */
export interface CapabilityOperationConfirmFrame {
  type: typeof CAPABILITY_OPERATION_MSG.CONFIRM;
  operationId: string;
  expectedRevision: number;
  decision: CapabilityConfirmationDecision;
  artifactDigest: string;
  auditDigest: string;
  scope: CapabilityScope;
  providers: readonly string[];
  machines: readonly string[];
}

export interface CapabilityOperationCancelFrame {
  type: typeof CAPABILITY_OPERATION_MSG.CANCEL;
  operationId: string;
  expectedRevision: number;
}

export type CapabilityLocalManagementAction = Exclude<CapabilityManagementAction,
  typeof CAPABILITY_MANAGE_ACTION.DELETE_CREDENTIALS | typeof CAPABILITY_MANAGE_ACTION.CANCEL_OPERATION>;

/** Exact local-scope mutation requested by the authoritative server. */
export interface CapabilityOperationManageFrame {
  type: typeof CAPABILITY_OPERATION_MSG.MANAGE;
  requestId: string;
  phase: CapabilityManagePhase;
  ownerId: string;
  serverId: string;
  capabilityId: string;
  bindingId: string;
  action: CapabilityLocalManagementAction;
  expectedRevision: number;
  /** Reserved final server authority revision shared by every replayed phase. */
  authorityRevision: number;
  versionId?: string;
  /** Required when a local Skill binding's signed authority changes. */
  authorization?: CapabilitySkillAuthorizationEnvelope;
}

/** Daemon result after the local managed store/index mutation is durable. */
export interface CapabilityOperationManageResultFrame {
  type: typeof CAPABILITY_OPERATION_MSG.MANAGE_RESULT;
  requestId: string;
  phase: CapabilityManageResultPhase;
  capabilityId: string;
  bindingId: string;
  action: CapabilityLocalManagementAction;
  expectedRevision: number;
  authorityRevision: number;
  ok: boolean;
  activeVersionId?: string;
  state?: CapabilityLifecycleState;
  errorCode?: CapabilityErrorCode;
  errorMessage?: string;
}


/** Final server acknowledgement; daemon retains/replays its journal until this arrives. */
export interface CapabilityOperationManageAckFrame {
  type: typeof CAPABILITY_OPERATION_MSG.MANAGE_ACK;
  requestId: string;
  capabilityId: string;
  bindingId: string;
  authorityRevision: number;
}

export type CapabilityOperationFrame =
  | CapabilityOperationInstallFrame
  | CapabilityOperationProgressFrame
  | CapabilityOperationConfirmFrame
  | CapabilityOperationCancelFrame
  | CapabilityOperationActivateFrame
  | CapabilityOperationAuthorizeFrame
  | CapabilityOperationCommitResultFrame
  | CapabilityOperationCommitAckFrame
  | CapabilityOperationCommitAbortFrame
  | CapabilityOperationManageFrame
  | CapabilityOperationManageResultFrame
  | CapabilityOperationManageAckFrame;

export interface CapabilityListRequest {
  kind?: CapabilityKind;
  state?: CapabilityLifecycleState;
  scope?: CapabilityScope;
  query?: string;
  limit?: number;
}

export interface CapabilityStatusRequest {
  operationId?: string;
  capabilityId?: string;
  /** Resolve one currently authorized Skill body for this exact caller context. */
  activate?: boolean;
}

export interface CapabilityManageRequest {
  action: CapabilityManagementAction;
  capabilityId?: string;
  /** Exact binding for scope-specific lifecycle actions. */
  bindingId?: string;
  operationId?: string;
  name?: string;
  kind?: CapabilityKind;
  scope?: CapabilityScope;
  versionId?: string;
  expectedRevision?: number;
  userIntent?: string;
}

export interface CapabilityConfirmationRequest extends CapabilityConfirmation {}

export interface CapabilityListResult {
  status: 'ok';
  items: readonly CapabilitySummary[];
}

export interface CapabilityOperationResult {
  status: 'ok';
  operation: CapabilityOperation;
}

export interface CapabilityStatusResult {
  status: 'ok';
  operation?: CapabilityOperation;
  capability?: CapabilitySummary;
  skillActivation?: {
    capabilityId: string;
    versionId: string;
    generationId: string;
    /** Sanitized bounded SKILL.md instructions only; never package resources or files. */
    instructions: string;
  };
}

export interface CapabilityManageResult {
  status: 'ok' | 'ambiguous';
  capability?: CapabilitySummary;
  operation?: CapabilityOperation;
  choices?: ReadonlyArray<Pick<CapabilitySummary, 'id' | 'kind' | 'name' | 'scope' | 'state'> & {
    bindingId?: string;
    scopeId?: string;
  }>;
}

export interface CapabilityErrorResult {
  status: 'error';
  reason: CapabilityErrorCode;
  error: string;
  retryable?: boolean;
}

export type CapabilityToolResult =
  | CapabilityListResult
  | CapabilityOperationResult
  | CapabilityStatusResult
  | CapabilityManageResult
  | CapabilityErrorResult;

export interface CapabilityService {
  list(input: CapabilityListRequest): Promise<CapabilityListResult | CapabilityErrorResult> | CapabilityListResult | CapabilityErrorResult;
  install(input: CapabilityInstallRequest): Promise<CapabilityOperationResult | CapabilityErrorResult> | CapabilityOperationResult | CapabilityErrorResult;
  status(input: CapabilityStatusRequest): Promise<CapabilityStatusResult | CapabilityErrorResult> | CapabilityStatusResult | CapabilityErrorResult;
  manage(input: CapabilityManageRequest): Promise<CapabilityManageResult | CapabilityErrorResult> | CapabilityManageResult | CapabilityErrorResult;
}

export const CAPABILITY_MCP_TOOL = {
  LIST: 'capability_list',
  INSTALL: 'capability_install',
  STATUS: 'capability_status',
  MANAGE: 'capability_manage',
} as const;
export type CapabilityMcpToolName = typeof CAPABILITY_MCP_TOOL[keyof typeof CAPABILITY_MCP_TOOL];
export const CAPABILITY_MCP_TOOL_NAMES = Object.values(CAPABILITY_MCP_TOOL) as readonly CapabilityMcpToolName[];

export const CAPABILITY_CANONICAL_INSTALL_POLICY = [
  'Manage MCP services and Agent Skills only through IM.codes capability tools.',
  'Managed Skills install only under ~/.imcodes/skills/managed; never write or invoke provider-native Skill installers/directories.',
  'Installation runs automatic deterministic scanning and one isolated AI audit.',
  'Only the user can confirm installation; never claim success before authoritative installed/readiness state.',
  'To use an installed Skill, find its exact ID with capability_list/search and then call capability_status with capabilityId and activate:true; never read managed files directly.',
  'If capability tools are unavailable, report that limitation instead of using shell, filesystem, or provider-native fallbacks.',
].join(' ');

export const CAPABILITY_AI_SYSTEM_INSTRUCTIONS = [
  'When the user asks in chat to install, update, list, inspect, use, enable, disable, roll back, uninstall, or restore an MCP service or Agent Skill, use the capability_list, capability_install, capability_status, and capability_manage tools directly.',
  'The current chat model handles the request; do not send the user to a settings form and do not ask them to choose a separate installation model.',
  'Ask a concise follow-up only when a material source, exact target, binding, or scope is genuinely missing or ambiguous.',
  CAPABILITY_CANONICAL_INSTALL_POLICY,
].join(' ');

export interface CapabilityJsonSchema {
  type: string;
  description?: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  additionalProperties?: boolean | CapabilityJsonSchema;
  required?: readonly string[];
  properties?: Readonly<Record<string, CapabilityJsonSchema>>;
  items?: CapabilityJsonSchema;
  maxItems?: number;
}

export interface CapabilityMcpToolContract {
  name: CapabilityMcpToolName;
  description: string;
  inputSchema: CapabilityJsonSchema;
}

const stringSchema = (description: string, extra: Partial<CapabilityJsonSchema> = {}): CapabilityJsonSchema => ({
  type: 'string',
  description,
  ...extra,
});
const arraySchema = (description: string, items: CapabilityJsonSchema, maxItems: number): CapabilityJsonSchema => ({
  type: 'array', description, items, maxItems,
});
const objectSchema = (
  description: string,
  properties: Readonly<Record<string, CapabilityJsonSchema>>,
  required: readonly string[] = [],
): CapabilityJsonSchema => ({ type: 'object', description, additionalProperties: false, properties, required });

const kindSchema: CapabilityJsonSchema = { type: 'string', enum: Object.values(CAPABILITY_KIND), description: 'Capability kind: portable Agent Skill or MCP service definition.' };
const scopeSchema: CapabilityJsonSchema = { type: 'string', enum: Object.values(CAPABILITY_SCOPE), description: 'Install scope. local stays on this daemon; account synchronizes; project/session require scopeId.' };
const providerSchema = arraySchema(
  'Optional managed provider filters; omit for every compatible provider.',
  stringSchema('One managed provider identifier.', { maxLength: CAPABILITY_LIMITS.PROVIDER_ID_BYTES }),
  CAPABILITY_LIMITS.PROVIDERS,
);
const machineSchema = arraySchema(
  'Optional target machine/server identifiers; omit for every compatible machine allowed by scope.',
  stringSchema('One target machine/server identifier.', { maxLength: CAPABILITY_LIMITS.MACHINE_ID_BYTES }),
  CAPABILITY_LIMITS.MACHINES,
);

export const CAPABILITY_MCP_TOOL_CONTRACTS: Readonly<Record<CapabilityMcpToolName, CapabilityMcpToolContract>> = {
  [CAPABILITY_MCP_TOOL.LIST]: {
    name: CAPABILITY_MCP_TOOL.LIST,
    description: `List visible IM.codes MCP services and Skills with state, scope, version, readiness, findings, and management hints. Read-only. ${CAPABILITY_CANONICAL_INSTALL_POLICY}`,
    inputSchema: objectSchema('Bounded inventory filter.', {
      kind: kindSchema,
      state: { type: 'string', enum: CAPABILITY_LIFECYCLE_STATES, description: 'Optional lifecycle-state filter.' },
      scope: scopeSchema,
      query: stringSchema('Optional case-insensitive name/source search text.', { maxLength: CAPABILITY_LIMITS.DISPLAY_NAME_CHARS }),
      limit: { type: 'number', description: `Optional result cap; defaults to ${CAPABILITY_LIMITS.LIST_DEFAULT}, maximum ${CAPABILITY_LIMITS.LIST_MAX}.`, minimum: 1, maximum: CAPABILITY_LIMITS.LIST_MAX },
    }),
  },
  [CAPABILITY_MCP_TOOL.INSTALL]: {
    name: CAPABILITY_MCP_TOOL.INSTALL,
    description: `Start one automatic IM.codes install from a URL, repository, local path, inline Skill package, or non-secret MCP config. Returns an operation; scanning and one isolated audit run automatically, then the user receives one confirmation card. ${CAPABILITY_CANONICAL_INSTALL_POLICY}`,
    inputSchema: objectSchema('One bounded capability install request.', {
      capabilityId: stringSchema('Optional exact installed capability id when updating; names are never used to guess an update target.'),
      bindingId: stringSchema('Exact installed binding id required with capabilityId; update never guesses among bindings.'),
      kind: kindSchema,
      source: objectSchema('Source descriptor. Never include raw credential values.', {
        kind: { type: 'string', enum: Object.values(CAPABILITY_SOURCE_KIND), description: 'Source form supplied by the user.' },
        value: stringSchema(`URL, repository locator, or daemon-local path, at most ${CAPABILITY_LIMITS.SOURCE_CHARS} characters.`, { maxLength: CAPABILITY_LIMITS.SOURCE_CHARS }),
        repositorySubdir: stringSchema('Optional repository-relative Skill directory; traversal and absolute paths are forbidden.', { maxLength: CAPABILITY_LIMITS.PATH_BYTES }),
        inlineFiles: { type: 'object', description: `Optional bounded portable package file map including SKILL.md; total UTF-8 bytes at most ${CAPABILITY_LIMITS.INLINE_PACKAGE_BYTES}.`, additionalProperties: stringSchema('UTF-8 file content.') },
        mcpConfig: { type: 'object', description: 'Optional normalized credential-free stdio or Streamable HTTP MCP definition. The Registry credential store is not ready in this release: authenticated definitions and all credentialRef fields are rejected with typed runtime_pending; never include token values.', additionalProperties: true },
      }, ['kind']),
      displayName: stringSchema('Optional user-facing name; source metadata is used when omitted.', { maxLength: CAPABILITY_LIMITS.DISPLAY_NAME_CHARS }),
      scope: scopeSchema,
      scopeId: stringSchema('Required canonical project/session id for project or session scope; never a local path.'),
      providers: providerSchema,
      machines: machineSchema,
      idempotencyKey: stringSchema('Required caller-stable retry key for one logical install request.', { maxLength: 128 }),
      userIntent: stringSchema('Optional bounded original user instruction for provenance; never treated as confirmation.', { maxLength: CAPABILITY_LIMITS.USER_INTENT_BYTES }),
    }, ['kind', 'source', 'scope', 'idempotencyKey']),
  },
  [CAPABILITY_MCP_TOOL.STATUS]: {
    name: CAPABILITY_MCP_TOOL.STATUS,
    description: 'Read authoritative progress and evidence for exactly one install operation or installed capability. When the user asks to use a listed Skill, pass its exact capabilityId with activate:true to receive one caller-bound, currently authorized, bounded instruction payload. Never read managed package files directly.',
    inputSchema: objectSchema('Status lookup by exactly one opaque id.', {
      operationId: stringSchema('Opaque operation id returned by capability_install.'),
      capabilityId: stringSchema('Opaque installed capability id returned by list/status.'),
      activate: { type: 'boolean', description: 'For an exact Skill capabilityId only, re-verify the current owner/scope/provider/machine authority and return bounded instructions.' },
    }),
  },
  [CAPABILITY_MCP_TOOL.MANAGE]: {
    name: CAPABILITY_MCP_TOOL.MANAGE,
    description: `Enable, disable, roll back, uninstall, restore, or cancel an operation. Explicit user language authorizes uninstall; if target or scope is ambiguous this returns choices so ask once. Uninstall is recoverable and retains credentials. ${CAPABILITY_CANONICAL_INSTALL_POLICY}`,
    inputSchema: objectSchema('One bounded management request.', {
      action: { type: 'string', enum: CAPABILITY_AVAILABLE_MANAGEMENT_ACTIONS, description: 'Requested management action currently available through AI management.' },
      capabilityId: stringSchema('Preferred exact opaque capability id.'),
      bindingId: stringSchema('Exact opaque binding id for enable, disable, uninstall, or restore. Omit only when one visible binding can be resolved unambiguously.'),
      operationId: stringSchema('Operation id; required only for cancel_operation.'),
      name: stringSchema('Fallback exact display name when id is unavailable; ambiguous matches return choices.', { maxLength: CAPABILITY_LIMITS.DISPLAY_NAME_CHARS }),
      kind: kindSchema,
      scope: scopeSchema,
      versionId: stringSchema('Immutable target version for rollback.'),
      expectedRevision: { type: 'number', description: 'Optional current entity revision for optimistic conflict detection.', minimum: 1 },
      userIntent: stringSchema('Original explicit user instruction; required for uninstall and delete_credentials.', { maxLength: CAPABILITY_LIMITS.USER_INTENT_BYTES }),
    }, ['action']),
  },
};

export function isCapabilityInstallState(value: unknown): value is CapabilityInstallState {
  return typeof value === 'string' && (CAPABILITY_INSTALL_STATES as readonly string[]).includes(value);
}

export function isCapabilityInstallTerminal(value: CapabilityInstallState): boolean {
  return value === CAPABILITY_INSTALL_STATE.INSTALLED
    || value === CAPABILITY_INSTALL_STATE.REWORK
    || value === CAPABILITY_INSTALL_STATE.FAILED
    || value === CAPABILITY_INSTALL_STATE.CANCELLED;
}

/** Cancellation is legal only before the server enters its INSTALLING boundary. */
export function isCapabilityInstallCancellable(value: CapabilityInstallState): boolean {
  return value === CAPABILITY_INSTALL_STATE.QUEUED
    || value === CAPABILITY_INSTALL_STATE.ACQUIRING
    || value === CAPABILITY_INSTALL_STATE.SCANNING
    || value === CAPABILITY_INSTALL_STATE.AUDITING
    || value === CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION;
}

export function isCapabilityLifecycleState(value: unknown): value is CapabilityLifecycleState {
  return typeof value === 'string' && (CAPABILITY_LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function isCapabilityMcpToolName(value: unknown): value is CapabilityMcpToolName {
  return typeof value === 'string' && (CAPABILITY_MCP_TOOL_NAMES as readonly string[]).includes(value);
}

export function hasCredentialShapedKey(value: unknown, depth = 0): boolean {
  // Exceeding the configured inspection depth is itself unsafe: returning
  // false here would let a caller hide a credential-shaped key one level past
  // the scanner's view.
  if (depth > CAPABILITY_LIMITS.TREE_DEPTH) return true;
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((item) => hasCredentialShapedKey(item, depth + 1));
  if (typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // Opaque credential references are the only secret-related fields allowed
    // in transport configuration. The referenced value lives in the encrypted
    // credential store; it is not a token. Still recurse into non-scalar values
    // so `{ credentialRef: { token: "..." } }` cannot hide raw material.
    const referenceKey = /^(?:credential|token|secret|password|private[_-]?key|api[_-]?key)[_-]?(?:ref|id)$/i.test(key);
    if (/(?:token|secret|password|private[_-]?key|api[_-]?key|authorization|cookie)/i.test(key) && !referenceKey) return true;
    if (hasCredentialShapedKey(child, depth + 1)) return true;
  }
  return false;
}

function boundedJsonIssue(value: unknown): string | null {
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const visit = (candidate: unknown, depth: number): string | null => {
    if (depth > CAPABILITY_LIMITS.TREE_DEPTH) return 'configuration is too deep';
    nodes += 1;
    if (nodes > CAPABILITY_LIMITS.FILE_COUNT * 8) return 'configuration has too many values';
    if (candidate === null || typeof candidate === 'boolean' || typeof candidate === 'number') {
      bytes += String(candidate).length;
      return null;
    }
    if (typeof candidate === 'string') {
      bytes += new TextEncoder().encode(candidate).length;
      return bytes > CAPABILITY_LIMITS.AUDIT_ENVELOPE_BYTES ? 'configuration is too large' : null;
    }
    if (typeof candidate !== 'object') return 'configuration contains an unsupported value';
    if (seen.has(candidate)) return 'configuration contains a cycle';
    seen.add(candidate);
    const entries = Array.isArray(candidate)
      ? candidate.map((entry, index) => [String(index), entry] as const)
      : Object.entries(candidate as Record<string, unknown>);
    if (entries.length > CAPABILITY_LIMITS.FILE_COUNT) return 'configuration has too many entries';
    for (const [key, child] of entries) {
      bytes += new TextEncoder().encode(key).length;
      if (bytes > CAPABILITY_LIMITS.AUDIT_ENVELOPE_BYTES) return 'configuration is too large';
      const issue = visit(child, depth + 1);
      if (issue) return issue;
    }
    seen.delete(candidate);
    return null;
  };
  return visit(value, 0);
}

function isCredentialShapedName(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === 'key'
    || normalized === 'sig'
    || normalized.includes('token')
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('privatekey')
    || normalized.includes('apikey')
    || normalized.includes('accesskey')
    || normalized.includes('authorization')
    || normalized.includes('cookie')
    || normalized.includes('signature')
    || normalized.startsWith('xamz');
}

function containsCredentialMaterial(value: string): boolean {
  return /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i.test(value)
    || /\b(?:sk|rk|pk)-(?:live|test|proj)?-?[A-Za-z0-9_-]{12,}\b/.test(value)
    || /\b(?:github_pat_|gh[pousr]_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/i.test(value)
    || /\bAKIA[A-Z0-9]{16}\b/.test(value)
    || /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/i.test(value)
    || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value);
}

/**
 * Accept only HTTPS endpoints whose URL itself carries no credential material.
 * Authentication must be represented by an opaque credentialRef instead.
 */
export function isCapabilityCredentialFreeHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    for (const [key, parameterValue] of url.searchParams) {
      if (isCredentialShapedName(key) || containsCredentialMaterial(parameterValue)) return false;
    }
    return !containsCredentialMaterial(url.pathname) && !containsCredentialMaterial(url.hash);
  } catch {
    return false;
  }
}

function areCapabilityMcpArgsCredentialFree(args: readonly string[]): boolean {
  for (const argument of args) {
    if (containsCredentialMaterial(argument)) return false;
    if (!argument.startsWith('-')) continue;
    const separator = argument.indexOf('=');
    const flag = separator >= 0 ? argument.slice(0, separator) : argument;
    if (isCredentialShapedName(flag.replace(/^-+/, ''))) return false;
  }
  return true;
}

function boundedMcpText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || new TextEncoder().encode(normalized).length > max || /[\u0000-\u001F\u007F]/.test(normalized)) return null;
  return normalized;
}

function boundedCredentialFreeMcpText(value: unknown, max: number): string | null {
  const normalized = boundedMcpText(value, max);
  return normalized && !containsCredentialMaterial(normalized) ? normalized : null;
}

function boundedMcpDefinition(value: CapabilityMcpDefinition): CapabilityMcpDefinition | null {
  return new TextEncoder().encode(JSON.stringify(value)).length <= CAPABILITY_LIMITS.SYNC_VERSION_RECORD_BYTES
    ? value
    : null;
}

/**
 * Normalize the only MCP definition shape this slice is allowed to persist.
 * Raw environment/header values are deliberately unsupported. The Registry
 * credential store is not implemented in this v1 slice, so credentialRef is
 * also rejected instead of pretending an opaque reference can be resolved.
 */
export function normalizeCapabilityMcpDefinition(
  source: CapabilitySource,
  displayName?: string,
): CapabilityMcpDefinition | null {
  let raw: Record<string, unknown>;
  if (source.kind === CAPABILITY_SOURCE_KIND.URL) {
    if (!isCapabilityCredentialFreeHttpsUrl(source.value)) return null;
    const url = new URL(source.value!);
    raw = {
      name: displayName?.trim() || url.hostname,
      transport: CAPABILITY_MCP_TRANSPORT.STREAMABLE_HTTP,
      url: url.toString(),
    };
  } else if (source.kind === CAPABILITY_SOURCE_KIND.MCP_CONFIG
    && source.mcpConfig
    && typeof source.mcpConfig === 'object'
    && !Array.isArray(source.mcpConfig)) {
    raw = { ...source.mcpConfig };
  } else {
    return null;
  }

  const allowedKeys = new Set([
    'name', 'transport', 'command', 'args', 'url', 'credentialRef',
    'env', 'headers', 'toolAllowlist',
  ]);
  if (Object.keys(raw).some((key) => !allowedKeys.has(key))) return null;
  const inferredTransport = raw.transport
    ?? (raw.command !== undefined ? CAPABILITY_MCP_TRANSPORT.STDIO : undefined)
    ?? (raw.url !== undefined ? CAPABILITY_MCP_TRANSPORT.STREAMABLE_HTTP : undefined);
  const transport = inferredTransport === 'streamable-http'
    ? CAPABILITY_MCP_TRANSPORT.STREAMABLE_HTTP
    : inferredTransport;
  if (!Object.values(CAPABILITY_MCP_TRANSPORT).includes(transport as CapabilityMcpTransport)) return null;
  const name = boundedCredentialFreeMcpText(displayName ?? raw.name, CAPABILITY_LIMITS.DISPLAY_NAME_CHARS);
  if (!name) return null;
  if (raw.credentialRef !== undefined || raw.env !== undefined || raw.headers !== undefined) return null;
  const toolAllowlist = raw.toolAllowlist === undefined
    ? undefined
    : Array.isArray(raw.toolAllowlist)
      && raw.toolAllowlist.length <= CAPABILITY_LIMITS.FINDINGS
      && raw.toolAllowlist.every((tool) => boundedCredentialFreeMcpText(tool, 128) !== null)
      ? raw.toolAllowlist.map((tool) => boundedCredentialFreeMcpText(tool, 128)!)
      : null;
  if (toolAllowlist === null) return null;

  if (transport === CAPABILITY_MCP_TRANSPORT.STDIO) {
    const command = boundedCredentialFreeMcpText(raw.command, CAPABILITY_LIMITS.PATH_BYTES);
    if (!command || raw.url !== undefined) return null;
    const args = raw.args === undefined
      ? []
      : Array.isArray(raw.args)
        && raw.args.length <= CAPABILITY_LIMITS.FILE_COUNT
        && raw.args.every((arg) => boundedMcpText(arg, CAPABILITY_LIMITS.PATH_BYTES) !== null)
        ? raw.args.map((arg) => boundedMcpText(arg, CAPABILITY_LIMITS.PATH_BYTES)!)
        : null;
    if (args === null || !areCapabilityMcpArgsCredentialFree(args)) return null;
    return boundedMcpDefinition({
      name,
      transport,
      command,
      args,
      ...(toolAllowlist ? { toolAllowlist } : {}),
    });
  }

  const url = boundedMcpText(raw.url, CAPABILITY_LIMITS.SOURCE_CHARS);
  if (!url || !isCapabilityCredentialFreeHttpsUrl(url) || raw.command !== undefined || raw.args !== undefined) return null;
  return boundedMcpDefinition({
    name,
    transport: CAPABILITY_MCP_TRANSPORT.STREAMABLE_HTTP,
    url: new URL(url).toString(),
    ...(toolAllowlist ? { toolAllowlist } : {}),
  });
}

export function validateCapabilityInstallRequest(input: CapabilityInstallRequest): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'request is invalid';
  const inputRecord = input as unknown as Record<string, unknown>;
  const allowedRequestKeys = new Set([
    'capabilityId', 'bindingId', 'kind', 'source', 'displayName', 'scope', 'scopeId',
    'providers', 'machines', 'idempotencyKey', 'userIntent',
  ]);
  if (Object.keys(inputRecord).some((key) => !allowedRequestKeys.has(key))) return 'request contains unsupported fields';
  if (!input.source || typeof input.source !== 'object' || Array.isArray(input.source)) return 'source is invalid';
  const sourceRecord = input.source as unknown as Record<string, unknown>;
  const allowedSourceKeys = new Set(['kind', 'value', 'repositorySubdir', 'inlineFiles', 'mcpConfig']);
  if (Object.keys(sourceRecord).some((key) => !allowedSourceKeys.has(key))) return 'source contains unsupported fields';
  const byteLength = (value: string): number => new TextEncoder().encode(value).length;
  const boundedText = (value: unknown, maxBytes: number, allowMultiline = false): value is string => (
    typeof value === 'string'
    && value.trim().length > 0
    && byteLength(value) <= maxBytes
    && (allowMultiline ? !/[\u0000\u000B\u000C\u000E-\u001F\u007F]/.test(value) : !/[\u0000-\u001F\u007F]/.test(value))
  );
  const boundedIdentifierList = (value: unknown, maxItems: number, maxBytes: number): value is readonly string[] => (
    value === undefined
    || (Array.isArray(value)
      && value.length <= maxItems
      && value.every((entry) => boundedText(entry, maxBytes) && !containsCredentialMaterial(entry))
      && new Set(value).size === value.length)
  );
  if (input.capabilityId !== undefined && !boundedText(input.capabilityId, CAPABILITY_LIMITS.OPAQUE_ID_BYTES)) {
    return 'capabilityId is invalid';
  }
  if (input.bindingId !== undefined && !boundedText(input.bindingId, CAPABILITY_LIMITS.OPAQUE_ID_BYTES)) {
    return 'bindingId is invalid';
  }
  if ((input.capabilityId === undefined) !== (input.bindingId === undefined)) {
    return 'capabilityId and bindingId must be supplied together';
  }
  if (!Object.values(CAPABILITY_KIND).includes(input.kind)) return 'kind is invalid';
  if (!Object.values(CAPABILITY_SOURCE_KIND).includes(input.source?.kind)) return 'source.kind is invalid';
  if (!Object.values(CAPABILITY_SCOPE).includes(input.scope)) return 'scope is invalid';
  const scoped = input.scope === CAPABILITY_SCOPE.PROJECT || input.scope === CAPABILITY_SCOPE.SESSION;
  if (scoped && !boundedText(input.scopeId, CAPABILITY_LIMITS.PATH_BYTES)) return 'scopeId is required for project/session scope';
  if (!scoped && input.scopeId !== undefined) return 'scopeId is forbidden for local/account scope';
  if (!boundedText(input.idempotencyKey, CAPABILITY_LIMITS.OPAQUE_ID_BYTES)
    || containsCredentialMaterial(input.idempotencyKey)) return 'idempotencyKey is invalid';
  if (input.displayName !== undefined
    && (!boundedText(input.displayName, CAPABILITY_LIMITS.DISPLAY_NAME_CHARS)
      || containsCredentialMaterial(input.displayName))) return 'displayName is invalid';
  if (input.userIntent !== undefined
    && (!boundedText(input.userIntent, CAPABILITY_LIMITS.USER_INTENT_BYTES, true)
      || containsCredentialMaterial(input.userIntent))) return 'userIntent is invalid';
  if (!boundedIdentifierList(input.providers, CAPABILITY_LIMITS.PROVIDERS, CAPABILITY_LIMITS.PROVIDER_ID_BYTES)) {
    return 'providers are invalid';
  }
  if (!boundedIdentifierList(input.machines, CAPABILITY_LIMITS.MACHINES, CAPABILITY_LIMITS.MACHINE_ID_BYTES)) {
    return 'machines are invalid';
  }
  if (input.source.value !== undefined
    && (!boundedText(input.source.value, CAPABILITY_LIMITS.SOURCE_CHARS)
      || containsCredentialMaterial(input.source.value))) return 'source value is invalid';
  if (input.source.repositorySubdir !== undefined) {
    const subdir = input.source.repositorySubdir;
    if (!boundedText(subdir, CAPABILITY_LIMITS.PATH_BYTES)
      || subdir.startsWith('/') || subdir.startsWith('\\') || /^[A-Za-z]:/.test(subdir)
      || subdir.includes('\\') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(subdir)) {
      return 'repositorySubdir is invalid';
    }
  }
  const hasValue = input.source.value !== undefined;
  const hasSubdir = input.source.repositorySubdir !== undefined;
  const hasInline = input.source.inlineFiles !== undefined;
  const hasMcpConfig = input.source.mcpConfig !== undefined;
  if (input.source.kind === CAPABILITY_SOURCE_KIND.URL && (!hasValue || hasSubdir || hasInline || hasMcpConfig)) return 'URL source shape is invalid';
  if (input.source.kind === CAPABILITY_SOURCE_KIND.REPOSITORY && (!hasValue || hasInline || hasMcpConfig)) return 'repository source shape is invalid';
  if (input.source.kind === CAPABILITY_SOURCE_KIND.LOCAL_PATH && (!hasValue || hasSubdir || hasInline || hasMcpConfig)) return 'local path source shape is invalid';
  if (input.source.kind === CAPABILITY_SOURCE_KIND.INLINE && (hasValue || hasSubdir || !hasInline || hasMcpConfig)) return 'inline source shape is invalid';
  if (input.source.kind === CAPABILITY_SOURCE_KIND.MCP_CONFIG && (hasValue || hasSubdir || hasInline || !hasMcpConfig)) return 'MCP source shape is invalid';
  if (input.source.kind === CAPABILITY_SOURCE_KIND.URL || input.source.kind === CAPABILITY_SOURCE_KIND.REPOSITORY) {
    if (!isCapabilityCredentialFreeHttpsUrl(input.source.value)) return 'source must be a credential-free HTTPS URL';
  }
  if (input.kind === CAPABILITY_KIND.SKILL) {
    const allowedSkillSources = new Set<CapabilitySourceKind>([
      CAPABILITY_SOURCE_KIND.URL,
      CAPABILITY_SOURCE_KIND.REPOSITORY,
      CAPABILITY_SOURCE_KIND.LOCAL_PATH,
      CAPABILITY_SOURCE_KIND.INLINE,
    ]);
    if (!allowedSkillSources.has(input.source.kind)) {
      return 'Skill source kind is invalid';
    }
    if (input.source.kind === CAPABILITY_SOURCE_KIND.INLINE) {
      if (!input.source.inlineFiles || typeof input.source.inlineFiles !== 'object'
        || Array.isArray(input.source.inlineFiles)) return 'inline package is invalid';
      const entries = Object.entries(input.source.inlineFiles ?? {});
      if (entries.length === 0 || entries.length > CAPABILITY_LIMITS.FILE_COUNT) return 'inline package file count is invalid';
      let totalBytes = 0;
      for (const [path, content] of entries) {
        if (!boundedText(path, CAPABILITY_LIMITS.PATH_BYTES)
          || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)
          || path.includes('\\') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path)
          || typeof content !== 'string') {
          return 'inline package path/content is invalid';
        }
        const size = new TextEncoder().encode(content).length;
        totalBytes += size;
        if (size > CAPABILITY_LIMITS.FILE_BYTES || totalBytes > CAPABILITY_LIMITS.INLINE_PACKAGE_BYTES) {
          return 'inline package is too large';
        }
      }
    }
  } else {
    const allowedMcpSources = new Set<CapabilitySourceKind>([
      CAPABILITY_SOURCE_KIND.URL,
      CAPABILITY_SOURCE_KIND.MCP_CONFIG,
    ]);
    if (!allowedMcpSources.has(input.source.kind)) return 'MCP source kind is invalid';
    if (input.source.kind === CAPABILITY_SOURCE_KIND.MCP_CONFIG && !input.source.mcpConfig) return 'mcpConfig is required';
    if (input.source.kind === CAPABILITY_SOURCE_KIND.MCP_CONFIG) {
      if (typeof input.source.mcpConfig !== 'object' || Array.isArray(input.source.mcpConfig)) {
        return 'mcpConfig is invalid';
      }
      const configIssue = boundedJsonIssue(input.source.mcpConfig);
      if (configIssue) return configIssue;
      if (hasCredentialShapedKey(input.source.mcpConfig)) return 'raw credential-shaped MCP fields are forbidden';
    }
    if (!normalizeCapabilityMcpDefinition(input.source, input.displayName)) return 'MCP definition is invalid or unsupported';
  }
  return null;
}
