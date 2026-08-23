import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CAPABILITY_AUDIT_VERDICT,
  CAPABILITY_AUTHORIZATION_ALGORITHM,
  CAPABILITY_AUTHORITY_STATE,
  CAPABILITY_FINDING_SEVERITY,
  CAPABILITY_KIND,
  CAPABILITY_LIFECYCLE_STATES,
  CAPABILITY_LIMITS,
  CAPABILITY_READINESS,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_STATE,
  CAPABILITY_SYNC_MSG,
  computeCapabilitySyncDigest,
  normalizeCapabilityMcpDefinition,
  type CapabilityAuditVerdict,
  type CapabilityAuthorizationKey,
  type CapabilityAuthorityRecord,
  type CapabilityBinding,
  type CapabilityFinding,
  type CapabilityKind,
  type CapabilityLifecycleState,
  type CapabilityMachineReadiness,
  type CapabilityReadiness,
  type CapabilityScope,
  type CapabilitySourceKind,
  type CapabilitySummary,
  type CapabilitySyncAck,
  type CapabilitySyncAuthorityFrame,
  type CapabilitySyncBinding,
  type CapabilitySyncDigestFrame,
  type CapabilitySyncReadinessFrame,
  type CapabilitySyncSnapshot,
  type CapabilitySyncTombstoneFrame,
  type CapabilitySkillAuthorizationEnvelope,
  type CapabilityTombstone,
  type CapabilityVersion,
} from '../../shared/capability-management.js';
import {
  clearCapabilityAuthorizationKeys,
  getCapabilityAuthorityRevision,
  setCapabilityAuthority,
  validateCapabilityAuthorizationKeys,
  verifyCapabilitySkillAuthorization,
} from './capability-authorization.js';
import { inventoryAgentSkillPackage } from './agent-skill-package.js';
import {
  readManagedSkillIndex,
  updateManagedSkillEntry,
  verifyManagedSkillVersion,
  type ManagedSkillIndexEntry,
} from './managed-skill-store.js';
import { assertOpaqueCapabilityId } from './managed-skill-paths.js';

const CAPABILITY_SYNC_STATE_SCHEMA_VERSION = 1 as const;
const SYNC_DIRECTORY = 'capability-sync';
const SYNC_STATE_FILE = 'state.json';
const SYNC_AUTHORITY_CURSOR_FILE = 'authority-cursor.json';
const SYNC_STAGING_DIRECTORY = 'staging';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

export const CAPABILITY_SYNC_ERROR = {
  INVALID_FRAME: 'invalid_frame',
  OWNER_MISMATCH: 'owner_mismatch',
  DIGEST_MISMATCH: 'digest_mismatch',
  STALE_REVISION: 'stale_revision',
  REVISION_GAP: 'revision_gap',
  CURSOR_CORRUPT: 'cursor_corrupt',
  CONTENT_INTEGRITY_FAILED: 'content_integrity_failed',
  PUBLISH_FAILED: 'publish_failed',
} as const;
export type CapabilitySyncErrorCode = typeof CAPABILITY_SYNC_ERROR[keyof typeof CAPABILITY_SYNC_ERROR];

export class CapabilitySyncError extends Error {
  constructor(readonly code: CapabilitySyncErrorCode, message: string = code) {
    super(message);
    this.name = 'CapabilitySyncError';
  }
}

export type CapabilitySyncSkillContent =
  | { status: 'missing' }
  | {
      status: 'available';
      /** Exact downloaded archive bytes used for blob digest/size verification. */
      blob: Uint8Array;
      /** A provider-owned extracted directory. It is copied before tree validation. */
      sourceDirectory: string;
      /** Releases downloaded bytes and the extracted temporary directory. */
      cleanup?: () => void | Promise<void>;
    };

export interface CapabilitySyncPreparedSkill {
  capability: CapabilitySummary;
  version: CapabilityVersion;
  bindings: readonly CapabilitySyncBinding[];
  stagingDirectory: string;
}

export type CapabilitySyncPreparedSkillMetadata = Omit<CapabilitySyncPreparedSkill, 'stagingDirectory'>;

export interface CapabilitySyncPublication {
  rollback(): void | Promise<void>;
}

export interface CapabilitySyncServiceOptions {
  ownerId: string;
  serverId: string;
  homeDir?: string;
  now?: () => number;
  loadSkillContent?: (input: {
    capability: CapabilitySummary;
    version: CapabilityVersion;
  }) => Promise<CapabilitySyncSkillContent>;
  /**
   * The publisher owns the final atomic rename and returns an exact rollback.
   * It is intentionally required for publication: metadata-only wire frames
   * must never be mistaken for transferable package content.
   */
  publishSkill?: (input: CapabilitySyncPreparedSkill) => Promise<CapabilitySyncPublication>;
  /** Reconciles authoritative bindings without reinstalling verified bytes. */
  reconcileSkill?: (input: CapabilitySyncPreparedSkillMetadata) => Promise<CapabilitySyncPublication | null>;
  removeSkill?: (input: {
    capabilityId: string;
    tombstone?: CapabilityTombstone;
  }) => Promise<CapabilitySyncPublication | null>;
  /** Testable durability seam; production defaults to restrictive atomic JSON. */
  persistState?: (path: string, state: unknown) => void;
  send?: (frame: CapabilitySyncReadinessFrame | CapabilitySyncAck) => void | Promise<void>;
}

interface CapabilitySyncPersistentState {
  schemaVersion: typeof CAPABILITY_SYNC_STATE_SCHEMA_VERSION;
  ownerId: string;
  serverId: string;
  revision: number;
  cursorDigest: string;
  items: CapabilitySummary[];
  versions: CapabilityVersion[];
  bindings: CapabilitySyncBinding[];
  tombstones: CapabilityTombstone[];
  readiness: CapabilityMachineReadiness[];
  updatedAt: number;
  stateDigest: string;
}

interface MutableSyncData {
  items: CapabilitySummary[];
  versions: CapabilityVersion[];
  bindings: CapabilitySyncBinding[];
  tombstones: CapabilityTombstone[];
}

type SyncDataView = { readonly [Key in keyof MutableSyncData]: readonly MutableSyncData[Key][number][] };

export interface CapabilitySyncApplyResult {
  accepted: boolean;
  revision: number;
  digest: string;
  outbound: readonly (CapabilitySyncReadinessFrame | CapabilitySyncAck)[];
  idempotent: boolean;
}


function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value: unknown, max: number = CAPABILITY_LIMITS.SOURCE_CHARS, allowEmpty = false): string | null {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max) return null;
  if (!allowEmpty && value.length === 0) return null;
  return value;
}

function opaqueId(value: unknown): string | null {
  const candidate = boundedString(value, 128);
  return candidate && OPAQUE_ID_PATTERN.test(candidate) && candidate !== '.' && candidate !== '..' ? candidate : null;
}

function digest(value: unknown): string | null {
  return typeof value === 'string' && SHA256_PATTERN.test(value) ? value : null;
}

function unsignedInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function enumValue<T extends string>(value: unknown, candidates: readonly T[]): T | null {
  return typeof value === 'string' && candidates.includes(value as T) ? value as T : null;
}

function boundedStringArray(value: unknown, maxItems: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const output: string[] = [];
  for (const entry of value) {
    const candidate = boundedString(entry, CAPABILITY_LIMITS.PATH_BYTES, true);
    if (candidate === null) return null;
    output.push(candidate);
  }
  return output;
}

function parseFinding(value: unknown): CapabilityFinding | null {
  if (!record(value) || !exactKeys(
    value,
    ['code', 'severity', 'message', 'source', 'blocking'],
    ['path', 'remediation'],
  )) return null;
  const code = boundedString(value.code, 128);
  const severity = enumValue(value.severity, Object.values(CAPABILITY_FINDING_SEVERITY));
  const message = boundedString(value.message, CAPABILITY_LIMITS.FINDING_TEXT_BYTES);
  const source = enumValue(value.source, ['scanner', 'auditor', 'runtime'] as const);
  const path = value.path === undefined ? undefined : boundedString(value.path, CAPABILITY_LIMITS.PATH_BYTES);
  const remediation = value.remediation === undefined
    ? undefined
    : boundedString(value.remediation, CAPABILITY_LIMITS.FINDING_TEXT_BYTES);
  if (!code || !severity || !message || !source || typeof value.blocking !== 'boolean'
    || path === null || remediation === null) return null;
  return {
    code,
    severity,
    message,
    source,
    blocking: value.blocking,
    ...(path === undefined ? {} : { path }),
    ...(remediation === undefined ? {} : { remediation }),
  };
}

function parseAuthorizationEnvelope(value: unknown): CapabilitySkillAuthorizationEnvelope | null {
  if (!record(value) || !exactKeys(value, [
    'schemaVersion', 'algorithm', 'keyId', 'ownerId', 'capabilityId', 'versionId',
    'artifactDigest', 'auditDigest', 'bindingId', 'bindingDigest', 'itemRevision',
    'bindingRevision', 'bindingState', 'issuedRevision',
    'issuedAt', 'signature',
  ], ['blobDigest'])) return null;
  const keyId = opaqueId(value.keyId);
  const ownerId = boundedString(value.ownerId, CAPABILITY_LIMITS.SOURCE_CHARS);
  const capabilityId = opaqueId(value.capabilityId);
  const versionId = opaqueId(value.versionId);
  const artifactDigest = digest(value.artifactDigest);
  const auditDigest = digest(value.auditDigest);
  const blobDigest = value.blobDigest === undefined ? undefined : digest(value.blobDigest);
  const bindingId = opaqueId(value.bindingId);
  const bindingDigest = digest(value.bindingDigest);
  const itemRevision = unsignedInteger(value.itemRevision);
  const bindingRevision = unsignedInteger(value.bindingRevision);
  const bindingState = enumValue(value.bindingState, Object.values(CAPABILITY_AUTHORITY_STATE));
  const issuedRevision = unsignedInteger(value.issuedRevision);
  const issuedAt = unsignedInteger(value.issuedAt);
  const signature = boundedString(value.signature, 512);
  if (value.schemaVersion !== 1 || value.algorithm !== CAPABILITY_AUTHORIZATION_ALGORITHM.ED25519
    || !keyId || !ownerId || !capabilityId || !versionId || !artifactDigest || !auditDigest
    || blobDigest === null || !bindingId || !bindingDigest || itemRevision === null
    || bindingRevision === null || !bindingState || issuedRevision === null
    || issuedAt === null || !signature) return null;
  return {
    schemaVersion: 1,
    algorithm: CAPABILITY_AUTHORIZATION_ALGORITHM.ED25519,
    keyId,
    ownerId,
    capabilityId,
    versionId,
    artifactDigest,
    auditDigest,
    ...(blobDigest ? { blobDigest } : {}),
    bindingId,
    bindingDigest,
    itemRevision,
    bindingRevision,
    bindingState,
    issuedRevision,
    issuedAt,
    signature,
  };
}

function parseAuthorityRecord(value: unknown): CapabilityAuthorityRecord | null {
  if (!record(value) || !exactKeys(value, [
    'capabilityId', 'versionId', 'bindingId', 'state', 'itemRevision', 'bindingRevision',
  ], ['authorization'])) return null;
  const capabilityId = opaqueId(value.capabilityId);
  const versionId = opaqueId(value.versionId);
  const bindingId = opaqueId(value.bindingId);
  const state = enumValue(value.state, Object.values(CAPABILITY_AUTHORITY_STATE));
  const itemRevision = unsignedInteger(value.itemRevision);
  const bindingRevision = unsignedInteger(value.bindingRevision);
  const authorization = value.authorization === undefined ? undefined : parseAuthorizationEnvelope(value.authorization);
  if (!capabilityId || !versionId || !bindingId || !state || itemRevision === null
    || bindingRevision === null || authorization === null) return null;
  return {
    capabilityId,
    versionId,
    bindingId,
    state,
    itemRevision,
    bindingRevision,
    ...(authorization ? { authorization } : {}),
  };
}

function parseAuthorizationKey(value: unknown): CapabilityAuthorizationKey | null {
  if (!record(value) || !exactKeys(value, ['keyId', 'algorithm', 'publicKeySpki'])) return null;
  const keyId = opaqueId(value.keyId);
  const publicKeySpki = boundedString(value.publicKeySpki, 2048);
  if (!keyId || value.algorithm !== CAPABILITY_AUTHORIZATION_ALGORITHM.ED25519 || !publicKeySpki) return null;
  return { keyId, algorithm: CAPABILITY_AUTHORIZATION_ALGORITHM.ED25519, publicKeySpki };
}

function parseBinding(value: unknown, sync: true): CapabilitySyncBinding | null;
function parseBinding(value: unknown, sync: false): CapabilityBinding | null;
function parseBinding(value: unknown, sync: boolean): CapabilitySyncBinding | CapabilityBinding | null {
  if (!record(value)) return null;
  const required = sync
    ? ['id', 'capabilityId', 'versionId', 'scope', 'providers', 'machines', 'active']
    : ['id', 'scope', 'providers', 'machines', 'active'];
  if (!exactKeys(value, required, sync ? ['scopeId', 'authorization'] : ['scopeId'])) return null;
  const id = opaqueId(value.id);
  const scope = enumValue(value.scope, Object.values(CAPABILITY_SCOPE));
  const providers = boundedStringArray(value.providers, CAPABILITY_LIMITS.PROVIDERS);
  const machines = boundedStringArray(value.machines, CAPABILITY_LIMITS.MACHINES);
  const scopeId = value.scopeId === undefined ? undefined : boundedString(value.scopeId, CAPABILITY_LIMITS.PATH_BYTES);
  if (!id || !scope || !providers || !machines || typeof value.active !== 'boolean' || scopeId === null) return null;
  const common: CapabilityBinding = {
    id,
    scope,
    providers,
    machines,
    active: value.active,
    ...(scopeId === undefined ? {} : { scopeId }),
  };
  if (!sync) return common;
  const capabilityId = opaqueId(value.capabilityId);
  const versionId = opaqueId(value.versionId);
  const authorization = value.authorization === undefined ? undefined : parseAuthorizationEnvelope(value.authorization);
  if (!capabilityId || !versionId || authorization === null) return null;
  return { ...common, capabilityId, versionId, ...(authorization ? { authorization } : {}) };
}

function parseSummary(value: unknown): CapabilitySummary | null {
  if (!record(value) || !exactKeys(
    value,
    ['id', 'revision', 'kind', 'name', 'state', 'scope', 'readiness', 'findings', 'updatedAt'],
    [
      'versionId', 'version', 'availableVersions', 'artifactDigest', 'sourceKind', 'sourceLabel', 'bindings',
      'tools', 'permissions', 'hasScripts', 'hasExecutables', 'stdioCommand', 'credentialsRetained',
    ],
  )) return null;
  const id = opaqueId(value.id);
  const revision = unsignedInteger(value.revision);
  const kind = enumValue<CapabilityKind>(value.kind, Object.values(CAPABILITY_KIND));
  const name = boundedString(value.name, CAPABILITY_LIMITS.DISPLAY_NAME_CHARS);
  const state = enumValue<CapabilityLifecycleState>(value.state, CAPABILITY_LIFECYCLE_STATES);
  const scope = enumValue<CapabilityScope>(value.scope, Object.values(CAPABILITY_SCOPE));
  const readiness = enumValue<CapabilityReadiness>(value.readiness, Object.values(CAPABILITY_READINESS));
  const updatedAt = unsignedInteger(value.updatedAt);
  if (!id || revision === null || !kind || !name || !state || !scope || !readiness || updatedAt === null) return null;
  if (!Array.isArray(value.findings) || value.findings.length > CAPABILITY_LIMITS.FINDINGS) return null;
  const findings = value.findings.map(parseFinding);
  if (findings.some((entry) => entry === null)) return null;

  const versionId = value.versionId === undefined ? undefined : opaqueId(value.versionId);
  const version = value.version === undefined ? undefined : unsignedInteger(value.version);
  const artifactDigest = value.artifactDigest === undefined ? undefined : digest(value.artifactDigest);
  const sourceKind = value.sourceKind === undefined
    ? undefined
    : enumValue<CapabilitySourceKind>(value.sourceKind, Object.values(CAPABILITY_SOURCE_KIND));
  const sourceLabel = value.sourceLabel === undefined
    ? undefined
    : boundedString(value.sourceLabel, CAPABILITY_LIMITS.SOURCE_CHARS, true);
  if (versionId === null || version === null || artifactDigest === null || sourceKind === null || sourceLabel === null) return null;

  let availableVersions: CapabilitySummary['availableVersions'];
  if (value.availableVersions !== undefined) {
    if (!Array.isArray(value.availableVersions) || value.availableVersions.length > CAPABILITY_LIMITS.LIST_MAX) return null;
    const parsed = value.availableVersions.map((entry) => {
      if (!record(entry) || !exactKeys(entry, ['id', 'label'], ['version', 'createdAt'])) return null;
      const entryId = opaqueId(entry.id);
      const label = boundedString(entry.label, CAPABILITY_LIMITS.DISPLAY_NAME_CHARS);
      const entryVersion = entry.version === undefined ? undefined : unsignedInteger(entry.version);
      const createdAt = entry.createdAt === undefined ? undefined : unsignedInteger(entry.createdAt);
      if (!entryId || !label || entryVersion === null || createdAt === null) return null;
      return { id: entryId, label, ...(entryVersion === undefined ? {} : { version: entryVersion }), ...(createdAt === undefined ? {} : { createdAt }) };
    });
    if (parsed.some((entry) => entry === null)) return null;
    availableVersions = parsed as NonNullable<CapabilitySummary['availableVersions']>;
  }

  let bindings: CapabilityBinding[] | undefined;
  if (value.bindings !== undefined) {
    if (!Array.isArray(value.bindings) || value.bindings.length > CAPABILITY_LIMITS.LIST_MAX) return null;
    const parsed = value.bindings.map((entry) => parseBinding(entry, false));
    if (parsed.some((entry) => entry === null)) return null;
    bindings = parsed as CapabilityBinding[];
  }
  const tools = value.tools === undefined ? undefined : boundedStringArray(value.tools, CAPABILITY_LIMITS.FINDINGS);
  const permissions = value.permissions === undefined ? undefined : boundedStringArray(value.permissions, CAPABILITY_LIMITS.FINDINGS);
  const stdioCommand = value.stdioCommand === undefined
    ? undefined
    : boundedStringArray(value.stdioCommand, CAPABILITY_LIMITS.PATH_BYTES);
  if (tools === null || permissions === null || stdioCommand === null) return null;
  for (const flag of ['hasScripts', 'hasExecutables', 'credentialsRetained'] as const) {
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean') return null;
  }
  const hasScripts = typeof value.hasScripts === 'boolean' ? value.hasScripts : undefined;
  const hasExecutables = typeof value.hasExecutables === 'boolean' ? value.hasExecutables : undefined;
  const credentialsRetained = typeof value.credentialsRetained === 'boolean' ? value.credentialsRetained : undefined;
  return {
    id,
    revision,
    kind,
    name,
    state,
    scope,
    readiness,
    findings: findings as CapabilityFinding[],
    updatedAt,
    ...(versionId === undefined ? {} : { versionId }),
    ...(version === undefined ? {} : { version }),
    ...(availableVersions === undefined ? {} : { availableVersions }),
    ...(artifactDigest === undefined ? {} : { artifactDigest }),
    ...(sourceKind === undefined ? {} : { sourceKind }),
    ...(sourceLabel === undefined ? {} : { sourceLabel }),
    ...(bindings === undefined ? {} : { bindings }),
    ...(tools === undefined ? {} : { tools }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(hasScripts === undefined ? {} : { hasScripts }),
    ...(hasExecutables === undefined ? {} : { hasExecutables }),
    ...(stdioCommand === undefined ? {} : { stdioCommand }),
    ...(credentialsRetained === undefined ? {} : { credentialsRetained }),
  };
}

function parseVersion(value: unknown): CapabilityVersion | null {
  if (!record(value) || !exactKeys(
    value,
    ['id', 'capabilityId', 'version', 'artifactDigest', 'auditDigest', 'auditVerdict', 'sourceKind', 'createdAt'],
    ['blobDigest', 'blobByteSize', 'definition', 'sourceLocator'],
  )) return null;
  const id = opaqueId(value.id);
  const capabilityId = opaqueId(value.capabilityId);
  const version = unsignedInteger(value.version);
  const artifactDigest = digest(value.artifactDigest);
  const blobDigest = value.blobDigest === undefined ? undefined : digest(value.blobDigest);
  const blobByteSize = value.blobByteSize === undefined ? undefined : unsignedInteger(value.blobByteSize);
  const definition = value.definition === undefined
    ? undefined
    : normalizeCapabilityMcpDefinition({
        kind: CAPABILITY_SOURCE_KIND.MCP_CONFIG,
        mcpConfig: record(value.definition) ? value.definition : undefined,
      }, record(value.definition) && typeof value.definition.name === 'string' ? value.definition.name : undefined);
  const auditDigest = digest(value.auditDigest);
  const auditVerdict = enumValue<CapabilityAuditVerdict>(value.auditVerdict, Object.values(CAPABILITY_AUDIT_VERDICT));
  const sourceKind = enumValue<CapabilitySourceKind>(value.sourceKind, Object.values(CAPABILITY_SOURCE_KIND));
  const sourceLocator = value.sourceLocator === undefined
    ? undefined
    : boundedString(value.sourceLocator, CAPABILITY_LIMITS.SOURCE_CHARS, true);
  const createdAt = unsignedInteger(value.createdAt);
  if (!id || !capabilityId || version === null || !artifactDigest
    || blobDigest === null || blobByteSize === null || definition === null
    || ((blobDigest === undefined) !== (blobByteSize === undefined))
    || (blobByteSize !== undefined && (blobByteSize < 1 || blobByteSize > CAPABILITY_LIMITS.PACKAGE_BYTES))
    || !auditDigest || !auditVerdict || !sourceKind
    || sourceLocator === null || createdAt === null) return null;
  return {
    id,
    capabilityId,
    version,
    artifactDigest,
    ...(blobDigest === undefined ? {} : { blobDigest, blobByteSize }),
    ...(definition === undefined ? {} : { definition }),
    auditDigest,
    auditVerdict,
    sourceKind,
    createdAt,
    ...(sourceLocator === undefined ? {} : { sourceLocator }),
  };
}

function parseTombstone(value: unknown): CapabilityTombstone | null {
  if (!record(value) || !exactKeys(
    value,
    ['id', 'capabilityId', 'scope', 'accountRevision', 'expiresAt', 'createdAt'],
    ['serverId'],
  )) return null;
  const id = opaqueId(value.id);
  const capabilityId = opaqueId(value.capabilityId);
  const scope = enumValue<CapabilityScope>(value.scope, Object.values(CAPABILITY_SCOPE));
  const serverId = value.serverId === undefined ? undefined : opaqueId(value.serverId);
  const accountRevision = unsignedInteger(value.accountRevision);
  const expiresAt = unsignedInteger(value.expiresAt);
  const createdAt = unsignedInteger(value.createdAt);
  if (!id || !capabilityId || !scope || serverId === null || accountRevision === null || expiresAt === null || createdAt === null) return null;
  return { id, capabilityId, scope, accountRevision, expiresAt, createdAt, ...(serverId === undefined ? {} : { serverId }) };
}

function parseArray<T>(value: unknown, maxItems: number, parser: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const parsed = value.map(parser);
  return parsed.some((entry) => entry === null) ? null : parsed as T[];
}

function encodedWithin(value: unknown, maximum: number): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maximum;
  } catch {
    return false;
  }
}

function parseBoundedArray<T>(
  value: unknown,
  maxItems: number,
  maxRecordBytes: number,
  parser: (entry: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const parsed: T[] = [];
  for (const entry of value) {
    if (!encodedWithin(entry, maxRecordBytes)) return null;
    const decoded = parser(entry);
    if (decoded === null) return null;
    parsed.push(decoded);
  }
  return parsed;
}

export function parseCapabilitySyncFrame(value: unknown): CapabilitySyncDigestFrame {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
  }
  if (Buffer.byteLength(serialized, 'utf8') > CAPABILITY_LIMITS.SYNC_FRAME_BYTES || !record(value)) {
    throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
  }
  if (value.type === CAPABILITY_SYNC_MSG.TOMBSTONE) {
    if (!exactKeys(value, ['type', 'ownerId', 'revision', 'tombstone', 'digest'])) {
      throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
    }
    const ownerId = boundedString(value.ownerId, CAPABILITY_LIMITS.SOURCE_CHARS);
    const revision = unsignedInteger(value.revision);
    const tombstone = encodedWithin(value.tombstone, CAPABILITY_LIMITS.SYNC_TOMBSTONE_RECORD_BYTES)
      ? parseTombstone(value.tombstone) : null;
    const frameDigest = digest(value.digest);
    if (!ownerId || revision === null || !tombstone || !frameDigest || tombstone.accountRevision !== revision) {
      throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
    }
    return { type: CAPABILITY_SYNC_MSG.TOMBSTONE, ownerId, revision, tombstone, digest: frameDigest };
  }
  if (value.type === CAPABILITY_SYNC_MSG.AUTHORITY) {
    if (!exactKeys(value, ['type', 'ownerId', 'serverId', 'revision', 'records', 'authorizationKeys', 'digest'])) {
      throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
    }
    const ownerId = boundedString(value.ownerId, CAPABILITY_LIMITS.SOURCE_CHARS);
    const serverId = opaqueId(value.serverId);
    const revision = unsignedInteger(value.revision);
    const records = parseBoundedArray(
      value.records,
      CAPABILITY_LIMITS.SYNC_BINDINGS,
      CAPABILITY_LIMITS.SYNC_BINDING_RECORD_BYTES,
      parseAuthorityRecord,
    );
    const authorizationKeys = parseArray(value.authorizationKeys, 16, parseAuthorizationKey);
    const frameDigest = digest(value.digest);
    if (!ownerId || !serverId || revision === null || !records || !authorizationKeys || !frameDigest) {
      throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
    }
    assertUnique(records.map((entry) => `${entry.capabilityId}\0${entry.versionId}\0${entry.bindingId}`));
    return {
      type: CAPABILITY_SYNC_MSG.AUTHORITY,
      ownerId,
      serverId,
      revision,
      records,
      authorizationKeys,
      digest: frameDigest,
    } satisfies CapabilitySyncAuthorityFrame;
  }
  if (value.type !== CAPABILITY_SYNC_MSG.SNAPSHOT && value.type !== CAPABILITY_SYNC_MSG.DELTA) {
    throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
  }
  if (!exactKeys(value, ['type', 'ownerId', 'revision', 'items', 'versions', 'bindings', 'tombstones', 'authorizationKeys', 'digest'])) {
    throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
  }
  const ownerId = boundedString(value.ownerId, CAPABILITY_LIMITS.SOURCE_CHARS);
  const revision = unsignedInteger(value.revision);
  const items = parseBoundedArray(value.items, CAPABILITY_LIMITS.SYNC_ITEMS, CAPABILITY_LIMITS.SYNC_ITEM_RECORD_BYTES, parseSummary);
  const versions = parseBoundedArray(value.versions, CAPABILITY_LIMITS.SYNC_VERSIONS, CAPABILITY_LIMITS.SYNC_VERSION_RECORD_BYTES, parseVersion);
  const bindings = parseBoundedArray(
    value.bindings,
    CAPABILITY_LIMITS.SYNC_BINDINGS,
    CAPABILITY_LIMITS.SYNC_BINDING_RECORD_BYTES,
    (entry) => parseBinding(entry, true),
  );
  const tombstones = parseBoundedArray(
    value.tombstones,
    CAPABILITY_LIMITS.SYNC_TOMBSTONES,
    CAPABILITY_LIMITS.SYNC_TOMBSTONE_RECORD_BYTES,
    parseTombstone,
  );
  const authorizationKeys = parseArray(value.authorizationKeys, 16, parseAuthorizationKey);
  const frameDigest = digest(value.digest);
  if (!ownerId || revision === null || !items || !versions || !bindings || !tombstones || !authorizationKeys || !frameDigest) {
    throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
  }
  if (tombstones.some((entry) => entry.accountRevision > revision)) {
    throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
  }
  const frame: CapabilitySyncSnapshot = {
    type: value.type,
    ownerId,
    revision,
    items,
    versions,
    bindings,
    tombstones,
    authorizationKeys,
    digest: frameDigest,
  };
  assertUnique(frame.items.map((entry) => entry.id));
  assertUnique(frame.versions.map((entry) => entry.id));
  assertUnique(frame.bindings.map((entry) => entry.id));
  assertUnique(frame.tombstones.map((entry) => entry.id));
  return frame;
}

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => [key, canonicalJsonValue(entry)]));
}

function syncStatePreimage(state: Omit<CapabilitySyncPersistentState, 'stateDigest'>): string {
  return JSON.stringify(canonicalJsonValue({
    schemaVersion: state.schemaVersion,
    ownerId: state.ownerId,
    serverId: state.serverId,
    revision: state.revision,
    cursorDigest: state.cursorDigest,
    items: state.items,
    versions: state.versions,
    bindings: state.bindings,
    tombstones: state.tombstones,
    readiness: state.readiness,
    updatedAt: state.updatedAt,
  }));
}

function stateDirectory(homeDir: string, ownerId: string, serverId: string): string {
  return join(homeDir, '.imcodes', SYNC_DIRECTORY, sha256(`${ownerId}\0${serverId}`));
}

function emptyState(ownerId: string, serverId: string): CapabilitySyncPersistentState {
  const base: Omit<CapabilitySyncPersistentState, 'stateDigest'> = {
    schemaVersion: CAPABILITY_SYNC_STATE_SCHEMA_VERSION,
    ownerId,
    serverId,
    revision: 0,
    cursorDigest: sha256(''),
    items: [],
    versions: [],
    bindings: [],
    tombstones: [],
    readiness: [],
    updatedAt: 0,
  };
  return { ...base, stateDigest: sha256(syncStatePreimage(base)) };
}

function parsePersistentState(value: unknown, ownerId: string, serverId: string): CapabilitySyncPersistentState {
  if (!record(value) || !exactKeys(value, [
    'schemaVersion', 'ownerId', 'serverId', 'revision', 'cursorDigest', 'items', 'versions', 'bindings',
    'tombstones', 'readiness', 'updatedAt', 'stateDigest',
  ])) throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.CURSOR_CORRUPT);
  if (value.schemaVersion !== CAPABILITY_SYNC_STATE_SCHEMA_VERSION || value.ownerId !== ownerId || value.serverId !== serverId) {
    throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.CURSOR_CORRUPT);
  }
  const snapshot = parseCapabilitySyncFrame({
    type: CAPABILITY_SYNC_MSG.SNAPSHOT,
    ownerId,
    revision: value.revision,
    items: value.items,
    versions: value.versions,
    bindings: value.bindings,
    tombstones: value.tombstones,
    authorizationKeys: [],
    digest: value.cursorDigest,
  }) as CapabilitySyncSnapshot;
  if (!Array.isArray(value.readiness) || value.readiness.length > CAPABILITY_LIMITS.LIST_MAX) {
    throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.CURSOR_CORRUPT);
  }
  const readiness: CapabilityMachineReadiness[] = [];
  for (const raw of value.readiness) {
    if (!record(raw) || !exactKeys(raw, ['capabilityId', 'serverId', 'readiness', 'reasons', 'revision', 'verifiedAt'], ['versionId'])) {
      throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.CURSOR_CORRUPT);
    }
    const capabilityId = opaqueId(raw.capabilityId);
    const versionId = raw.versionId === undefined ? undefined : opaqueId(raw.versionId);
    const parsedServerId = opaqueId(raw.serverId);
    const parsedReadiness = enumValue<CapabilityReadiness>(raw.readiness, Object.values(CAPABILITY_READINESS));
    const reasons = boundedStringArray(raw.reasons, CAPABILITY_LIMITS.FINDINGS);
    const revision = unsignedInteger(raw.revision);
    const verifiedAt = unsignedInteger(raw.verifiedAt);
    if (!capabilityId || versionId === null || !parsedServerId || !parsedReadiness || !reasons || revision === null || verifiedAt === null) {
      throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.CURSOR_CORRUPT);
    }
    readiness.push({ capabilityId, serverId: parsedServerId, readiness: parsedReadiness, reasons, revision, verifiedAt, ...(versionId === undefined ? {} : { versionId }) });
  }
  const cursorDigest = digest(value.cursorDigest);
  const updatedAt = unsignedInteger(value.updatedAt);
  const stateDigest = digest(value.stateDigest);
  if (!cursorDigest || updatedAt === null || !stateDigest) throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.CURSOR_CORRUPT);
  const base: Omit<CapabilitySyncPersistentState, 'stateDigest'> = {
    schemaVersion: CAPABILITY_SYNC_STATE_SCHEMA_VERSION,
    ownerId,
    serverId,
    revision: snapshot.revision,
    cursorDigest,
    items: [...snapshot.items],
    versions: [...snapshot.versions],
    bindings: [...snapshot.bindings],
    tombstones: [...snapshot.tombstones],
    readiness,
    updatedAt,
  };
  if (sha256(syncStatePreimage(base)) !== stateDigest) throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.CURSOR_CORRUPT);
  return { ...base, stateDigest };
}

function validateRelationships(data: SyncDataView): void {
  if (
    data.items.length > CAPABILITY_LIMITS.SYNC_ITEMS
    || data.versions.length > CAPABILITY_LIMITS.SYNC_VERSIONS
    || data.bindings.length > CAPABILITY_LIMITS.SYNC_BINDINGS
    || data.tombstones.length > CAPABILITY_LIMITS.SYNC_TOMBSTONES
  ) throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
  const itemIds = new Set(data.items.map((entry) => entry.id));
  const itemKinds = new Map(data.items.map((entry) => [entry.id, entry.kind]));
  const versionsById = new Map(data.versions.map((entry) => [entry.id, entry]));
  for (const version of data.versions) {
    if (!itemIds.has(version.capabilityId)
      || version.auditVerdict !== CAPABILITY_AUDIT_VERDICT.PASS
      || (itemKinds.get(version.capabilityId) === CAPABILITY_KIND.SKILL && version.definition !== undefined)) {
      throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
    }
  }
  for (const item of data.items) {
    if (!item.versionId) continue;
    const version = versionsById.get(item.versionId);
    if (!version || version.capabilityId !== item.id || item.artifactDigest !== version.artifactDigest) {
      throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
    }
  }
  for (const binding of data.bindings) {
    const version = versionsById.get(binding.versionId);
    if (!itemIds.has(binding.capabilityId) || !version || version.capabilityId !== binding.capabilityId) {
      throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
    }
  }
}

function validateSkillAuthorizations(
  data: SyncDataView,
  ownerId: string,
  serverId: string,
  revision: number,
  authorizationKeys: readonly CapabilityAuthorizationKey[],
): void {
  if (!validateCapabilityAuthorizationKeys(authorizationKeys)) {
    throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
  }
  const kinds = new Map(data.items.map((entry) => [entry.id, entry.kind]));
  const versions = new Map(data.versions.map((entry) => [entry.id, entry]));
  for (const binding of data.bindings) {
    const kind = kinds.get(binding.capabilityId);
    const version = versions.get(binding.versionId);
    if (!kind || !version) throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
    if (kind === CAPABILITY_KIND.MCP) {
      if (binding.authorization !== undefined) throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
      continue;
    }
    if (!binding.authorization
      || binding.authorization.issuedRevision > revision
      || !verifyCapabilitySkillAuthorization({
        ownerId,
        serverId,
        capabilityId: binding.capabilityId,
        version,
        binding,
        envelope: binding.authorization,
        authorizationKeys,
      })) throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
  }
}

function sanitizedFrameItems(frame: CapabilitySyncSnapshot): CapabilitySummary[] {
  const nonLocalBindings = new Map<string, CapabilitySyncBinding[]>();
  for (const binding of frame.bindings) {
    if (binding.scope === CAPABILITY_SCOPE.LOCAL) continue;
    const existing = nonLocalBindings.get(binding.capabilityId) ?? [];
    existing.push(binding);
    nonLocalBindings.set(binding.capabilityId, existing);
  }
  return frame.items.flatMap((entry) => {
    const authoritativeBindings = nonLocalBindings.get(entry.id) ?? [];
    if (entry.scope === CAPABILITY_SCOPE.LOCAL && authoritativeBindings.length === 0) return [];
    const nestedBindings = entry.bindings?.filter((binding) => binding.scope !== CAPABILITY_SCOPE.LOCAL);
    return [{
      ...entry,
      scope: entry.scope === CAPABILITY_SCOPE.LOCAL ? authoritativeBindings[0]!.scope : entry.scope,
      ...(entry.bindings === undefined ? {} : { bindings: nestedBindings ?? [] }),
    }];
  });
}

function filteredBatch(frame: CapabilitySyncSnapshot): MutableSyncData {
  const tombstones = frame.tombstones.filter((entry) => entry.scope !== CAPABILITY_SCOPE.LOCAL);
  const tombstoned = new Set(tombstones.map((entry) => entry.capabilityId));
  const items = sanitizedFrameItems(frame).filter((entry) => !tombstoned.has(entry.id));
  const itemIds = new Set(items.map((entry) => entry.id));
  const versions = frame.versions.filter((entry) => itemIds.has(entry.capabilityId));
  const versionIds = new Set(versions.map((entry) => entry.id));
  const bindings = frame.bindings.filter((entry) => (
    entry.scope !== CAPABILITY_SCOPE.LOCAL
    && itemIds.has(entry.capabilityId)
    && versionIds.has(entry.versionId)
  ));
  const data = { items, versions, bindings, tombstones };
  validateRelationships(data);
  return data;
}

function applyStandaloneTombstone(
  current: CapabilitySyncPersistentState,
  frame: CapabilitySyncTombstoneFrame,
): MutableSyncData {
  if (frame.tombstone.scope === CAPABILITY_SCOPE.LOCAL) {
    return {
      items: [...current.items],
      versions: [...current.versions],
      bindings: [...current.bindings],
      tombstones: [...current.tombstones],
    };
  }
  const capabilityId = frame.tombstone.capabilityId;
  return {
    items: current.items.filter((entry) => entry.id !== capabilityId),
    versions: current.versions.filter((entry) => entry.capabilityId !== capabilityId),
    bindings: current.bindings.filter((entry) => entry.capabilityId !== capabilityId),
    tombstones: [
      ...current.tombstones.filter((entry) => entry.capabilityId !== capabilityId),
      frame.tombstone,
    ].sort((left, right) => left.accountRevision - right.accountRevision)
      .slice(-CAPABILITY_LIMITS.SYNC_TOMBSTONES),
  };
}

function applicableBindings(bindings: readonly CapabilitySyncBinding[], capabilityId: string, serverId: string): CapabilitySyncBinding[] {
  return bindings.filter((entry) => (
    entry.capabilityId === capabilityId
    && entry.active
    && (entry.machines.length === 0 || entry.machines.includes(serverId))
  ));
}

function frameReadiness(
  capability: CapabilitySummary,
  revision: number,
  serverId: string,
  readiness: CapabilityReadiness,
  now: number,
): { persisted: CapabilityMachineReadiness; outbound: CapabilitySyncReadinessFrame } {
  const reasons = [readiness];
  return {
    persisted: {
      capabilityId: capability.id,
      ...(capability.versionId ? { versionId: capability.versionId } : {}),
      serverId,
      readiness,
      reasons,
      revision,
      verifiedAt: now,
    },
    outbound: {
      type: CAPABILITY_SYNC_MSG.READINESS,
      capabilityId: capability.id,
      readiness,
      reasons,
      revision,
      ...(capability.artifactDigest ? { manifestDigest: capability.artifactDigest } : {}),
    },
  };
}

function readBoundedStateFile(path: string): string {
  const pathStat = lstatSync(path);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()
    || pathStat.size < 0 || pathStat.size > CAPABILITY_LIMITS.SYNC_FRAME_BYTES) {
    throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.CURSOR_CORRUPT);
  }
  const descriptor = openSync(path, 'r');
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size !== pathStat.size
      || before.dev !== pathStat.dev || before.ino !== pathStat.ino) {
      throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.CURSOR_CORRUPT);
    }
    const bytes = Buffer.allocUnsafe(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (offset !== before.size || after.size !== before.size
      || after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) {
      throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.CURSOR_CORRUPT);
    }
    return bytes.subarray(0, offset).toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > CAPABILITY_LIMITS.SYNC_FRAME_BYTES) {
    throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.PUBLISH_FAILED, 'Capability sync state exceeds its durable byte limit');
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const file = openSync(temporary, 'r');
    try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    rmSync(temporary, { force: true });
  }
}

function atomicWriteState(path: string, state: CapabilitySyncPersistentState): void {
  atomicWriteJson(path, state);
}

export class CapabilitySyncService {
  private readonly homeDir: string;
  private readonly statePath: string;
  private state: CapabilitySyncPersistentState;
  private authorityCursor: { revision: number; digest: string };

  constructor(private readonly options: CapabilitySyncServiceOptions) {
    assertOpaqueCapabilityId(options.serverId, 'server ID');
    if (!boundedString(options.ownerId, CAPABILITY_LIMITS.SOURCE_CHARS)) {
      throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME, 'Invalid owner ID');
    }
    this.homeDir = options.homeDir ?? homedir();
    this.statePath = join(stateDirectory(this.homeDir, options.ownerId, options.serverId), SYNC_STATE_FILE);
    this.state = this.readState();
    this.authorityCursor = this.readAuthorityCursor();
  }

  private readAuthorityCursor(): { revision: number; digest: string } {
    const path = join(dirname(this.statePath), SYNC_AUTHORITY_CURSOR_FILE);
    if (!existsSync(path)) return { revision: 0, digest: sha256('') };
    try {
      const value = JSON.parse(readBoundedStateFile(path)) as Record<string, unknown>;
      const revision = unsignedInteger(value.revision);
      const cursorDigest = digest(value.digest);
      if (!exactKeys(value, ['revision', 'digest']) || revision === null || !cursorDigest) throw new Error('invalid authority cursor');
      return { revision, digest: cursorDigest };
    } catch {
      throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.CURSOR_CORRUPT, 'Capability authority cursor is corrupt');
    }
  }

  private persistAuthorityCursor(next: { revision: number; digest: string }): void {
    const path = join(dirname(this.statePath), SYNC_AUTHORITY_CURSOR_FILE);
    atomicWriteJson(path, next);
  }

  get cursor(): Readonly<{ revision: number; digest: string }> {
    return { revision: this.state.revision, digest: this.state.cursorDigest };
  }

  get snapshot(): Readonly<CapabilitySyncPersistentState> {
    return structuredClone(this.state);
  }


  private readState(): CapabilitySyncPersistentState {
    if (!existsSync(this.statePath)) return emptyState(this.options.ownerId, this.options.serverId);
    try {
      return parsePersistentState(JSON.parse(readBoundedStateFile(this.statePath)), this.options.ownerId, this.options.serverId);
    } catch (error) {
      if (error instanceof CapabilitySyncError) throw error;
      throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.CURSOR_CORRUPT);
    }
  }

  async apply(value: unknown): Promise<CapabilitySyncApplyResult> {
    const frame = parseCapabilitySyncFrame(value);
    if (frame.ownerId !== this.options.ownerId) throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.OWNER_MISMATCH);
    const computed = computeCapabilitySyncDigest(frame, sha256);
    if (computed !== frame.digest) throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.DIGEST_MISMATCH);

    if (frame.type === CAPABILITY_SYNC_MSG.AUTHORITY) {
      const idempotent = frame.revision === this.authorityCursor.revision && frame.digest === this.authorityCursor.digest;
      if (frame.revision < this.authorityCursor.revision
        || (frame.revision === this.authorityCursor.revision && frame.digest !== this.authorityCursor.digest)) {
        throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.STALE_REVISION);
      }
      if (frame.serverId !== this.options.serverId
        || !setCapabilityAuthority(
          frame.ownerId,
          frame.serverId,
          frame.revision,
          frame.records,
          frame.authorizationKeys,
        )) throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
      try {
        this.persistAuthorityCursor({ revision: frame.revision, digest: frame.digest });
        this.authorityCursor = { revision: frame.revision, digest: frame.digest };
      } catch (error) {
        clearCapabilityAuthorizationKeys(frame.ownerId, frame.serverId);
        throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.PUBLISH_FAILED, error instanceof Error ? error.message : undefined);
      }
      const ack: CapabilitySyncAck = { type: CAPABILITY_SYNC_MSG.ACK, revision: frame.revision, digest: frame.digest };
      await this.emit([ack]);
      return {
        accepted: true,
        revision: frame.revision,
        digest: frame.digest,
        outbound: [ack],
        idempotent,
      };
    }
    if (frame.type !== CAPABILITY_SYNC_MSG.TOMBSTONE
      && frame.revision < (getCapabilityAuthorityRevision(frame.ownerId, this.options.serverId) ?? 0)) {
      throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.STALE_REVISION);
    }
    // SNAPSHOT/DELTA carry signed package metadata but are not the runtime
    // authority channel. Validate the complete wire frame before filtering
    // tombstoned entries so a REMOVED envelope cannot evade verification.
    // Only a separate complete-current AUTHORITY frame can grant/revoke
    // resolver authority; this avoids inferring DISABLED vs REMOVED for MCP,
    // whose snapshot binding has only an `active` bit.
    if (frame.type !== CAPABILITY_SYNC_MSG.TOMBSTONE) {
      validateRelationships(frame);
      validateSkillAuthorizations(
        frame,
        frame.ownerId,
        this.options.serverId,
        frame.revision,
        frame.authorizationKeys,
      );
    }

    const hasRetryableMissingContent = this.state.readiness.some((entry) => (
      entry.readiness === CAPABILITY_READINESS.CONTENT_MISSING
      || entry.readiness === CAPABILITY_READINESS.INTEGRITY_FAILED
    ));
    if (frame.revision === this.state.revision && this.state.updatedAt !== 0 && frame.digest !== this.state.cursorDigest) {
      throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.STALE_REVISION);
    }
    if (frame.revision === this.state.revision
      && !(frame.type === CAPABILITY_SYNC_MSG.SNAPSHOT && this.state.updatedAt === 0)
      && !hasRetryableMissingContent) {
      if (frame.type !== CAPABILITY_SYNC_MSG.TOMBSTONE) {
        const replay = filteredBatch(frame);
        validateRelationships(replay);
      }
      const ack: CapabilitySyncAck = { type: CAPABILITY_SYNC_MSG.ACK, revision: frame.revision, digest: frame.digest };
      await this.emit([ack]);
      return { accepted: true, revision: frame.revision, digest: frame.digest, outbound: [ack], idempotent: true };
    }
    if (frame.revision < this.state.revision) throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.STALE_REVISION);
    if (frame.type !== CAPABILITY_SYNC_MSG.SNAPSHOT && frame.revision !== this.state.revision + 1) {
      throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.REVISION_GAP);
    }

    // Server SNAPSHOT and DELTA frames are both complete-current-state
    // projections. DELTA only describes the revision transport, not a sparse
    // merge. Replacing the synchronized projection is what makes omitted or
    // disabled bindings revoke locally while local-only store entries remain
    // outside this state and untouched.
    const data = frame.type === CAPABILITY_SYNC_MSG.TOMBSTONE
      ? applyStandaloneTombstone(this.state, frame)
      : filteredBatch(frame);
    validateRelationships(data);
    const now = this.options.now?.() ?? Date.now();
    const stagingRoot = join(stateDirectory(this.homeDir, this.options.ownerId, this.options.serverId), SYNC_STAGING_DIRECTORY);
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const batchStaging = mkdtempSync(join(stagingRoot, 'batch-'));
    const readiness: CapabilityMachineReadiness[] = [];
    const readinessFrames: CapabilitySyncReadinessFrame[] = [];
    const prepared: CapabilitySyncPreparedSkill[] = [];
    const reconciliations: CapabilitySyncPreparedSkillMetadata[] = [];
    const publications: CapabilitySyncPublication[] = [];
    const batchTombstones = (frame.type === CAPABILITY_SYNC_MSG.TOMBSTONE ? [frame.tombstone] : frame.tombstones)
      .filter((entry) => entry.scope !== CAPABILITY_SCOPE.LOCAL);
    const tombstoneByCapability = new Map(batchTombstones.map((entry) => [entry.capabilityId, entry]));
    const revokeSkillIds = new Set(batchTombstones.map((entry) => entry.capabilityId));
    for (const current of this.state.items) {
      if (current.kind !== CAPABILITY_KIND.SKILL) continue;
      const wasApplicable = applicableBindings(this.state.bindings, current.id, this.options.serverId).length > 0;
      const remainsApplicable = applicableBindings(data.bindings, current.id, this.options.serverId).length > 0;
      if (wasApplicable && !remainsApplicable) revokeSkillIds.add(current.id);
    }

    try {
      const versionsById = new Map(data.versions.map((entry) => [entry.id, entry]));
      for (const capability of data.items) {
        const bindings = applicableBindings(data.bindings, capability.id, this.options.serverId);
        if (bindings.length === 0) continue;
        if (capability.kind === CAPABILITY_KIND.MCP) {
          const result = frameReadiness(
            capability,
            frame.revision,
            this.options.serverId,
            CAPABILITY_READINESS.RUNTIME_PENDING,
            now,
          );
          readiness.push(result.persisted);
          readinessFrames.push(result.outbound);
          continue;
        }
        const bindingsByVersion = new Map<string, CapabilitySyncBinding[]>();
        for (const binding of bindings) {
          const group = bindingsByVersion.get(binding.versionId) ?? [];
          group.push(binding);
          bindingsByVersion.set(binding.versionId, group);
        }
        const localPrepared: CapabilitySyncPreparedSkill[] = [];
        let contentMissing = false;
        for (const [versionId, versionBindings] of [...bindingsByVersion].sort(([left], [right]) => left.localeCompare(right))) {
          const version = versionsById.get(versionId);
          if (!version || version.capabilityId !== capability.id) throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
          try {
            const installed = verifyManagedSkillVersion(this.homeDir, capability.id, versionId);
            if (installed.treeDigest === version.artifactDigest) continue;
          } catch {
            // An absent or invalid local copy is resolved through the blob seam.
          }
          const content = version.blobDigest && version.blobByteSize && this.options.loadSkillContent
            ? await this.options.loadSkillContent({ capability, version })
            : { status: 'missing' as const };
          if (content.status !== 'available' || !this.options.publishSkill) {
            if (content.status === 'available') await content.cleanup?.();
            contentMissing = true;
            continue;
          }
          try {
            if (
              content.blob.byteLength !== version.blobByteSize
              || content.blob.byteLength > CAPABILITY_LIMITS.PACKAGE_BYTES
              || createHash('sha256').update(content.blob).digest('hex') !== version.blobDigest
            ) throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.CONTENT_INTEGRITY_FAILED);
            const stagingDirectory = join(batchStaging, `${capability.id}-${versionId}`);
            cpSync(content.sourceDirectory, stagingDirectory, { recursive: true, dereference: false, errorOnExist: true });
            const inventory = inventoryAgentSkillPackage(stagingDirectory);
            if (inventory.treeDigest !== version.artifactDigest) throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.CONTENT_INTEGRITY_FAILED);
            localPrepared.push({ capability, version, bindings: versionBindings, stagingDirectory });
          } catch (error) {
            const failed = frameReadiness(capability, frame.revision, this.options.serverId, CAPABILITY_READINESS.INTEGRITY_FAILED, now);
            await this.emit([failed.outbound]);
            if (error instanceof CapabilitySyncError) throw error;
            throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.CONTENT_INTEGRITY_FAILED);
          } finally {
            await content.cleanup?.();
          }
        }
        if (contentMissing) {
          const result = frameReadiness(capability, frame.revision, this.options.serverId, CAPABILITY_READINESS.CONTENT_MISSING, now);
          readiness.push(result.persisted);
          readinessFrames.push(result.outbound);
          continue;
        }
        prepared.push(...localPrepared);
        const preferredVersion = versionsById.get(capability.versionId ?? bindings[0]!.versionId);
        if (!preferredVersion) throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME);
        reconciliations.push({ capability, version: preferredVersion, bindings });
      }

      // Every available blob is verified before the first tombstone or publish
      // mutates provider-visible state. Tombstones are then committed first.
      for (const capabilityId of revokeSkillIds) {
        const removal = await this.removeSkill(capabilityId, tombstoneByCapability.get(capabilityId));
        if (removal) publications.push(removal);
      }
      for (const entry of prepared) publications.push(await this.options.publishSkill!(entry));
      for (const entry of reconciliations) {
        const reconciliation = await this.options.reconcileSkill?.(entry);
        if (reconciliation) publications.push(reconciliation);
      }
      for (const entry of reconciliations) {
        const result = frameReadiness(entry.capability, frame.revision, this.options.serverId, CAPABILITY_READINESS.READY, now);
        readiness.push(result.persisted);
        readinessFrames.push(result.outbound);
      }
      const nextReadiness = [
        ...this.state.readiness.filter((entry) => !data.items.some((item) => item.id === entry.capabilityId)),
        ...readiness.filter((entry, index, array) => array.findIndex((candidate) => candidate.capabilityId === entry.capabilityId) === index),
      ].filter((entry) => data.items.some((item) => item.id === entry.capabilityId));
      const base: Omit<CapabilitySyncPersistentState, 'stateDigest'> = {
        schemaVersion: CAPABILITY_SYNC_STATE_SCHEMA_VERSION,
        ownerId: this.options.ownerId,
        serverId: this.options.serverId,
        revision: frame.revision,
        cursorDigest: frame.digest,
        items: data.items,
        versions: data.versions,
        bindings: data.bindings,
        tombstones: data.tombstones,
        readiness: nextReadiness,
        updatedAt: now,
      };
      const next = { ...base, stateDigest: sha256(syncStatePreimage(base)) };
      try {
        (this.options.persistState ?? atomicWriteState)(this.statePath, next);
      } catch (error) {
        throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.PUBLISH_FAILED, error instanceof Error ? error.message : undefined);
      }
      this.state = next;
      const ack: CapabilitySyncAck = { type: CAPABILITY_SYNC_MSG.ACK, revision: frame.revision, digest: frame.digest };
      const outbound = [...readinessFrames, ack];
      await this.emit(outbound);
      return { accepted: true, revision: frame.revision, digest: frame.digest, outbound, idempotent: false };
    } catch (error) {
      if (publications.length > 0) await this.rollback(publications);
      if (error instanceof CapabilitySyncError) throw error;
      throw new CapabilitySyncError(CAPABILITY_SYNC_ERROR.PUBLISH_FAILED, error instanceof Error ? error.message : undefined);
    } finally {
      rmSync(batchStaging, { recursive: true, force: true });
    }
  }

  private async rollback(publications: readonly CapabilitySyncPublication[]): Promise<void> {
    for (const publication of [...publications].reverse()) {
      try {
        await publication.rollback();
      } catch {
        // The original transaction remains failed; callers must surface repair.
      }
    }
  }

  private async removeSkill(capabilityId: string, tombstone?: CapabilityTombstone): Promise<CapabilitySyncPublication | null> {
    if (this.options.removeSkill) return this.options.removeSkill({ capabilityId, ...(tombstone ? { tombstone } : {}) });
    const previous = readManagedSkillIndex(this.homeDir).entries.find((entry) => entry.registryId === capabilityId);
    if (!previous) return null;
    const snapshot = structuredClone(previous) as ManagedSkillIndexEntry;
    updateManagedSkillEntry(capabilityId, (entry) => {
      const localBindings = entry.bindings.filter((binding) => binding.scope === CAPABILITY_SCOPE.LOCAL);
      const localVersionIds = new Set(localBindings.flatMap((binding) => binding.versionId ? [binding.versionId] : []));
      const retainedVersions = localBindings.length === 0
        ? entry.versions
        : entry.versions.filter((versionId) => localVersionIds.has(versionId));
      const retainedVersionBindings = localBindings.length === 0
        ? entry.versionBindings
        : Object.fromEntries(Object.entries(entry.versionBindings ?? {})
          .flatMap(([versionId, bindings]) => {
            const local = bindings.filter((binding) => binding.scope === CAPABILITY_SCOPE.LOCAL);
            return local.length > 0 && localVersionIds.has(versionId) ? [[versionId, local]] : [];
          }));
      const anyLocalActive = localBindings.some((binding) => binding.active !== false && binding.removed !== true);
      return {
        ...entry,
        activeVersionId: localBindings.find((binding) => binding.active !== false && binding.removed !== true)?.versionId
          ?? localBindings[0]?.versionId,
        versions: retainedVersions,
        bindings: localBindings,
        versionBindings: retainedVersionBindings,
        state: localBindings.length === 0 ? CAPABILITY_STATE.TOMBSTONED
          : anyLocalActive ? CAPABILITY_STATE.ACTIVE : CAPABILITY_STATE.DISABLED,
        revision: entry.revision + 1,
        updatedAt: this.options.now?.() ?? Date.now(),
      };
    }, this.homeDir);
    return {
      rollback: () => {
        updateManagedSkillEntry(capabilityId, () => snapshot, this.homeDir);
      },
    };
  }

  private async emit(frames: readonly (CapabilitySyncReadinessFrame | CapabilitySyncAck)[]): Promise<void> {
    if (!this.options.send) return;
    for (const frame of frames) {
      try {
        await this.options.send(frame);
      } catch {
        // Delivery is retryable on the next identical frame/reconnect. A
        // network failure after commit must never roll back durable content.
      }
    }
  }
}

export const CAPABILITY_SYNC_SERVICE_TESTING = {
  stateDirectory,
};
