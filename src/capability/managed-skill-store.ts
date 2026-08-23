import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  CAPABILITY_AUTHORIZATION_ALGORITHM,
  CAPABILITY_AUTHORITY_STATE,
  CAPABILITY_LIMITS,
  CAPABILITY_MANAGE_ACTION,
  CAPABILITY_SCOPE,
  CAPABILITY_STATE,
  canonicalCapabilityBindingAuthorizationPayload,
  type CapabilityAuthorityState,
  type CapabilityManagementAction,
  type CapabilitySkillAuthorizationEnvelope,
  type CapabilityScope,
} from '../../shared/capability-management.js';
import {
  MANAGED_SKILL_MANIFEST_SCHEMA_VERSION,
  assertManifestMatchesPackage,
  inventoryAgentSkillPackage,
  type ManagedSkillVersionManifest,
} from './agent-skill-package.js';
import {
  assertOpaqueCapabilityId,
  assertPathInsideManagedRoot,
  establishManagedSkillStore,
  getManagedSkillIndexPath,
  getManagedSkillManifestPath,
  getManagedSkillRegistryRoot,
  getManagedSkillTrashRoot,
  getManagedSkillVersionPath,
  isManagedSkillStoreEstablished,
} from './managed-skill-paths.js';

export const MANAGED_SKILL_INDEX_SCHEMA_VERSION = 1 as const;
export interface ManagedSkillBinding {
  /** Authoritative server binding identity. Legacy local entries may omit it. */
  bindingId?: string;
  versionId?: string;
  scope: CapabilityScope;
  ownerId?: string;
  /** Exact daemon identity for local-scope authority. */
  serverId?: string;
  projectId?: string;
  sessionId?: string;
  providers?: string[];
  machines?: string[];
  /** Omitted means enabled for backward compatibility. */
  active?: boolean;
  /** Recoverable exact-binding uninstall marker. */
  removed?: boolean;
  trashId?: string;
  authorization?: CapabilitySkillAuthorizationEnvelope;
}

export interface ManagedSkillIndexEntry {
  registryId: string;
  name: string;
  description: string;
  activeVersionId?: string;
  versions: string[];
  bindings: ManagedSkillBinding[];
  /** Signed bindings retained per immutable version for exact rollback. */
  versionBindings?: Record<string, ManagedSkillBinding[]>;
  state: typeof CAPABILITY_STATE.ACTIVE | typeof CAPABILITY_STATE.DISABLED | typeof CAPABILITY_STATE.TOMBSTONED;
  revision: number;
  /** Last authoritative server item revision, distinct from local index writes. */
  authorityRevision?: number;
  updatedAt: number;
  trash?: Array<{ versionId: string; trashId: string; removedAt: number }>;
}

export interface ManagedSkillIndex {
  schemaVersion: typeof MANAGED_SKILL_INDEX_SCHEMA_VERSION;
  revision: number;
  entries: ManagedSkillIndexEntry[];
}

const EMPTY_INDEX: ManagedSkillIndex = {
  schemaVersion: MANAGED_SKILL_INDEX_SCHEMA_VERSION,
  revision: 0,
  entries: [],
};

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const file = openSync(temporary, 'r');
    try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    rmSync(temporary, { force: true });
  }
}

function fsyncPublishedTree(root: string, files: readonly { path: string }[]): void {
  const directories = new Set<string>([root]);
  for (const entry of files) {
    const path = join(root, entry.path);
    const file = openSync(path, 'r');
    try { fsyncSync(file); } finally { closeSync(file); }
    let directory = dirname(path);
    while (directory.startsWith(root) && directory !== root) {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    const handle = openSync(directory, 'r');
    try { fsyncSync(handle); } finally { closeSync(handle); }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function contentSafeSourceLabel(value: string): string {
  const oneLine = value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!oneLine) return 'managed-package';
  try {
    const url = new URL(oneLine);
    return url.protocol === 'https:' ? `https://${url.hostname}` : 'managed-package';
  } catch {
    const leaf = oneLine.split(/[\\/]/).at(-1)?.trim() || 'managed-package';
    return Buffer.byteLength(leaf, 'utf8') <= 256 ? leaf : 'managed-package';
  }
}

function fsyncDirectory(path: string): void {
  const directory = openSync(path, 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

const INDEX_KEYS = new Set(['schemaVersion', 'revision', 'entries']);
const ENTRY_KEYS = new Set([
  'registryId', 'name', 'description', 'activeVersionId', 'versions', 'bindings',
  'versionBindings', 'state', 'revision', 'authorityRevision', 'updatedAt', 'trash',
]);
const BINDING_KEYS = new Set([
  'bindingId', 'versionId', 'scope', 'ownerId', 'serverId', 'projectId', 'sessionId',
  'providers', 'machines', 'active', 'removed', 'trashId', 'authorization',
]);
const AUTHORIZATION_KEYS = new Set([
  'schemaVersion', 'algorithm', 'keyId', 'ownerId', 'capabilityId', 'versionId',
  'artifactDigest', 'auditDigest', 'blobDigest', 'bindingId', 'bindingDigest',
  'itemRevision', 'bindingRevision', 'bindingState', 'issuedRevision', 'issuedAt', 'signature',
]);
const TRASH_KEYS = new Set(['versionId', 'trashId', 'removedAt']);
const MANIFEST_KEYS = new Set([
  'schemaVersion', 'kind', 'registryId', 'versionId', 'treeDigest', 'name', 'description',
  'source', 'createdAt', 'files', 'scannerDigest', 'auditDigest', 'auditPolicyVersion',
]);
const MANIFEST_FILE_KEYS = new Set(['path', 'size', 'sha256', 'executable']);
const MANAGED_SKILL_MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
let beforeVerifiedFileOpenForTest: (() => void) | undefined;

function invalidIndex(): never {
  throw new Error('Invalid managed Skill index');
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    && !/[\u0000-\u001F\u007F]/.test(value);
}

function optionalString(value: unknown, maxBytes: number): value is string | undefined {
  return value === undefined || boundedString(value, maxBytes);
}

function opaqueId(value: unknown): value is string {
  if (!boundedString(value, 128)) return false;
  try {
    assertOpaqueCapabilityId(value, 'managed Skill index ID');
    return true;
  } catch {
    return false;
  }
}

function stringList(value: unknown, maximum: number, maxBytes = 128): string[] | null {
  if (!Array.isArray(value) || value.length > maximum || !value.every((item) => boundedString(item, maxBytes))) return null;
  const result = [...value] as string[];
  return new Set(result).size === result.length ? result : null;
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function readBoundedRegularFile(path: string, maxBytes: number): Buffer {
  const pathStat = lstatSync(path);
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size < 0 || pathStat.size > maxBytes) {
    throw new Error('Managed Skill file is not a bounded regular file');
  }
  const descriptor = openSync(path, 'r');
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size !== pathStat.size || before.dev !== pathStat.dev || before.ino !== pathStat.ino) {
      throw new Error('Managed Skill file changed before open');
    }
    const bytes = Buffer.allocUnsafe(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (offset !== before.size || after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs) throw new Error('Managed Skill file changed during read');
    return bytes.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

function decodeManifest(value: unknown, registryId: string, versionId: string): ManagedSkillVersionManifest {
  const record = recordOf(value);
  if (!record || !onlyKeys(record, MANIFEST_KEYS)
    || record.schemaVersion !== MANAGED_SKILL_MANIFEST_SCHEMA_VERSION
    || record.kind !== 'skill'
    || record.registryId !== registryId
    || record.versionId !== versionId
    || !digest(record.treeDigest)
    || !boundedString(record.name, 64)
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.name)
    || !boundedString(record.description, 1024)
    || !boundedString(record.source, 1024)
    || !safeInteger(record.createdAt)
    || !Array.isArray(record.files)
    || record.files.length === 0
    || record.files.length > CAPABILITY_LIMITS.FILE_COUNT
    || !digest(record.scannerDigest)
    || !boundedString(record.auditDigest, 128)
    || !boundedString(record.auditPolicyVersion, 128)) throw new Error('Invalid managed Skill manifest');
  let totalBytes = 0;
  const paths = new Set<string>();
  const files = record.files.map((valueFile) => {
    const file = recordOf(valueFile);
    if (!file || !onlyKeys(file, MANIFEST_FILE_KEYS)
      || !boundedString(file.path, 1024)
      || file.path.startsWith('/') || file.path.startsWith('\\') || file.path.includes('\\')
      || file.path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
      || paths.has(file.path)
      || !safeInteger(file.size)
      || file.size > CAPABILITY_LIMITS.FILE_BYTES
      || !digest(file.sha256)
      || typeof file.executable !== 'boolean') throw new Error('Invalid managed Skill manifest');
    totalBytes += file.size;
    if (totalBytes > CAPABILITY_LIMITS.PACKAGE_BYTES) throw new Error('Invalid managed Skill manifest');
    paths.add(file.path);
    return { path: file.path, size: file.size, sha256: file.sha256, executable: file.executable };
  });
  if (!paths.has('SKILL.md')) throw new Error('Invalid managed Skill manifest');
  return {
    schemaVersion: MANAGED_SKILL_MANIFEST_SCHEMA_VERSION,
    kind: 'skill',
    registryId,
    versionId,
    treeDigest: record.treeDigest,
    name: record.name,
    description: record.description,
    source: record.source,
    createdAt: record.createdAt,
    files,
    scannerDigest: record.scannerDigest,
    auditDigest: record.auditDigest,
    auditPolicyVersion: record.auditPolicyVersion,
  };
}

function decodeAuthorization(
  value: unknown,
  input: {
    registryId: string;
    bindingId: string;
    versionId: string;
    ownerId: string;
    scope: CapabilityScope;
    scopeId?: string;
    providers: readonly string[];
    machines: readonly string[];
    active: boolean;
  },
): CapabilitySkillAuthorizationEnvelope | null {
  const record = recordOf(value);
  if (!record || !onlyKeys(record, AUTHORIZATION_KEYS)
    || record.schemaVersion !== 1
    || record.algorithm !== CAPABILITY_AUTHORIZATION_ALGORITHM.ED25519
    || !boundedString(record.keyId, 128)
    || record.ownerId !== input.ownerId
    || record.capabilityId !== input.registryId
    || record.versionId !== input.versionId
    || record.bindingId !== input.bindingId
    || !digest(record.artifactDigest)
    // Older on-disk entries may carry a bounded opaque audit evidence ID;
    // cryptographic/current-authority verification remains resolver-owned.
    || !boundedString(record.auditDigest, 128)
    || (record.blobDigest !== undefined && !digest(record.blobDigest))
    || !digest(record.bindingDigest)
    || !safeInteger(record.itemRevision)
    || !safeInteger(record.bindingRevision)
    || !Object.values(CAPABILITY_AUTHORITY_STATE).includes(record.bindingState as CapabilityAuthorityState)
    || !safeInteger(record.issuedRevision)
    || !safeInteger(record.issuedAt)
    || !boundedString(record.signature, 128)
    || !/^[A-Za-z0-9_-]+$/.test(record.signature)
    || Buffer.from(record.signature, 'base64url').length !== 64) return null;
  const expectedState = input.active
    ? CAPABILITY_AUTHORITY_STATE.ACTIVE
    : CAPABILITY_AUTHORITY_STATE.DISABLED;
  if (record.bindingState !== expectedState
    && !(record.bindingState === CAPABILITY_AUTHORITY_STATE.REMOVED && !input.active)) return null;
  const payload = {
    id: input.bindingId,
    capabilityId: input.registryId,
    versionId: input.versionId,
    scope: input.scope,
    ...(input.scopeId ? { scopeId: input.scopeId } : {}),
    providers: [...input.providers],
    machines: [...input.machines],
    active: input.active,
  };
  const bindingDigest = createHash('sha256')
    .update(canonicalCapabilityBindingAuthorizationPayload(payload))
    .digest('hex');
  if (record.bindingDigest !== bindingDigest) return null;
  return {
    schemaVersion: 1,
    algorithm: CAPABILITY_AUTHORIZATION_ALGORITHM.ED25519,
    keyId: record.keyId,
    ownerId: input.ownerId,
    capabilityId: input.registryId,
    versionId: input.versionId,
    artifactDigest: record.artifactDigest,
    auditDigest: record.auditDigest,
    ...(record.blobDigest ? { blobDigest: record.blobDigest } : {}),
    bindingId: input.bindingId,
    bindingDigest: record.bindingDigest,
    itemRevision: record.itemRevision,
    bindingRevision: record.bindingRevision,
    bindingState: record.bindingState as CapabilityAuthorityState,
    issuedRevision: record.issuedRevision,
    issuedAt: record.issuedAt,
    signature: record.signature,
  };
}

function decodeBinding(
  value: unknown,
  registryId: string,
  allowedVersions: ReadonlySet<string>,
): ManagedSkillBinding | null {
  const record = recordOf(value);
  if (!record || !onlyKeys(record, BINDING_KEYS)
    || !Object.values(CAPABILITY_SCOPE).includes(record.scope as CapabilityScope)
    || !optionalString(record.bindingId, 128)
    || !optionalString(record.versionId, 128)
    || !optionalString(record.ownerId, 128)
    || !optionalString(record.serverId, 128)
    || !optionalString(record.projectId, 128)
    || !optionalString(record.sessionId, 128)
    || !optionalString(record.trashId, 256)
    || (record.active !== undefined && typeof record.active !== 'boolean')
    || (record.removed !== undefined && typeof record.removed !== 'boolean')
    || (record.active === true && record.removed === true)
    || (record.versionId !== undefined && !allowedVersions.has(record.versionId))) return null;
  const scope = record.scope as CapabilityScope;
  if ((scope === CAPABILITY_SCOPE.LOCAL && (record.projectId !== undefined || record.sessionId !== undefined))
    || (scope === CAPABILITY_SCOPE.PROJECT && (record.serverId !== undefined || record.sessionId !== undefined))
    || (scope === CAPABILITY_SCOPE.SESSION && (record.serverId !== undefined || record.projectId !== undefined))
    || (scope === CAPABILITY_SCOPE.ACCOUNT
      && (record.serverId !== undefined || record.projectId !== undefined || record.sessionId !== undefined))) return null;
  const providers = record.providers === undefined ? [] : stringList(record.providers, CAPABILITY_LIMITS.PROVIDERS);
  const machines = record.machines === undefined ? [] : stringList(record.machines, CAPABILITY_LIMITS.MACHINES);
  if (!providers || !machines) return null;
  const modern = record.authorization !== undefined;
  if (modern && (!record.bindingId || !record.versionId || !record.ownerId
    || (scope === CAPABILITY_SCOPE.LOCAL && !record.serverId)
    || (scope === CAPABILITY_SCOPE.PROJECT && !record.projectId)
    || (scope === CAPABILITY_SCOPE.SESSION && !record.sessionId))) return null;
  const scopeId = scope === CAPABILITY_SCOPE.LOCAL ? record.serverId
    : scope === CAPABILITY_SCOPE.PROJECT ? record.projectId
      : scope === CAPABILITY_SCOPE.SESSION ? record.sessionId : undefined;
  const enabled = record.active !== false && record.removed !== true;
  const authorization = modern ? decodeAuthorization(record.authorization, {
    registryId,
    bindingId: record.bindingId!,
    versionId: record.versionId!,
    ownerId: record.ownerId!,
    scope,
    scopeId,
    providers,
    machines,
    active: enabled,
  }) : undefined;
  if (modern && !authorization) return null;
  return {
    ...(record.bindingId ? { bindingId: record.bindingId } : {}),
    ...(record.versionId ? { versionId: record.versionId } : {}),
    scope,
    ...(record.ownerId ? { ownerId: record.ownerId } : {}),
    ...(record.serverId ? { serverId: record.serverId } : {}),
    ...(record.projectId ? { projectId: record.projectId } : {}),
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(record.providers !== undefined ? { providers } : {}),
    ...(record.machines !== undefined ? { machines } : {}),
    ...(record.active !== undefined ? { active: record.active } : {}),
    ...(record.removed !== undefined ? { removed: record.removed } : {}),
    ...(record.trashId ? { trashId: record.trashId } : {}),
    ...(authorization ? { authorization } : {}),
  };
}

function parseIndex(value: unknown): ManagedSkillIndex {
  const record = recordOf(value);
  if (!record || !onlyKeys(record, INDEX_KEYS)
    || record.schemaVersion !== MANAGED_SKILL_INDEX_SCHEMA_VERSION
    || !safeInteger(record.revision)
    || !Array.isArray(record.entries)
    || record.entries.length > CAPABILITY_LIMITS.SYNC_ITEMS) return invalidIndex();
  const entries: ManagedSkillIndexEntry[] = [];
  const registryIds = new Set<string>();
  let totalVersions = 0;
  let totalBindings = 0;
  for (const valueEntry of record.entries) {
    const entry = recordOf(valueEntry);
    if (!entry || !onlyKeys(entry, ENTRY_KEYS) || !opaqueId(entry.registryId)
      || registryIds.has(entry.registryId)
      || !boundedString(entry.name, CAPABILITY_LIMITS.DISPLAY_NAME_CHARS)
      || !boundedString(entry.description, CAPABILITY_LIMITS.FINDING_TEXT_BYTES)
      || !optionalString(entry.activeVersionId, 128)
      || !Array.isArray(entry.versions)
      || !Array.isArray(entry.bindings)
      || !Object.values(CAPABILITY_STATE).includes(entry.state as ManagedSkillIndexEntry['state'])
      || ![CAPABILITY_STATE.ACTIVE, CAPABILITY_STATE.DISABLED, CAPABILITY_STATE.TOMBSTONED].includes(entry.state as ManagedSkillIndexEntry['state'])
      || !safeInteger(entry.revision)
      || (entry.authorityRevision !== undefined && !safeInteger(entry.authorityRevision))
      || !safeInteger(entry.updatedAt)) return invalidIndex();
    const registryId = entry.registryId as string;
    const versions = stringList(entry.versions, CAPABILITY_LIMITS.SYNC_VERSIONS, 128);
    if (!versions || !versions.every((versionId) => opaqueId(versionId))) return invalidIndex();
    totalVersions += versions.length;
    totalBindings += entry.bindings.length;
    if (totalVersions > CAPABILITY_LIMITS.SYNC_VERSIONS || totalBindings > CAPABILITY_LIMITS.SYNC_BINDINGS) return invalidIndex();
    const trash: NonNullable<ManagedSkillIndexEntry['trash']> = [];
    if (entry.trash !== undefined) {
      if (!Array.isArray(entry.trash) || entry.trash.length > CAPABILITY_LIMITS.SYNC_VERSIONS) return invalidIndex();
      for (const valueTrash of entry.trash) {
        const item = recordOf(valueTrash);
        if (!item || !onlyKeys(item, TRASH_KEYS) || !opaqueId(item.versionId)
          || !boundedString(item.trashId, 256) || !safeInteger(item.removedAt)) return invalidIndex();
        trash.push({ versionId: item.versionId, trashId: item.trashId, removedAt: item.removedAt });
      }
    }
    const allowedVersions = new Set([...versions, ...trash.map((item) => item.versionId)]);
    if (entry.activeVersionId !== undefined && !allowedVersions.has(entry.activeVersionId)) return invalidIndex();
    if (entry.state !== CAPABILITY_STATE.TOMBSTONED && !entry.activeVersionId) return invalidIndex();
    const bindings = entry.bindings.map((binding) => decodeBinding(binding, registryId, allowedVersions));
    if (bindings.some((binding) => !binding)) return invalidIndex();
    const decodedBindings = bindings as ManagedSkillBinding[];
    const owners = new Set(decodedBindings.flatMap((binding) => binding.ownerId ? [binding.ownerId] : []));
    const localServers = new Set(decodedBindings.flatMap((binding) =>
      binding.scope === CAPABILITY_SCOPE.LOCAL && binding.serverId ? [binding.serverId] : []));
    if (owners.size > 1 || localServers.size > 1) return invalidIndex();
    let versionBindings: Record<string, ManagedSkillBinding[]> | undefined;
    if (entry.versionBindings !== undefined) {
      const raw = recordOf(entry.versionBindings);
      if (!raw || Object.keys(raw).length > CAPABILITY_LIMITS.SYNC_VERSIONS) return invalidIndex();
      versionBindings = {};
      for (const [versionId, valueBindings] of Object.entries(raw)) {
        if (!opaqueId(versionId) || !allowedVersions.has(versionId) || !Array.isArray(valueBindings)) return invalidIndex();
        totalBindings += valueBindings.length;
        if (totalBindings > CAPABILITY_LIMITS.SYNC_BINDINGS) return invalidIndex();
        const decoded = valueBindings.map((binding) => decodeBinding(binding, registryId, allowedVersions));
        if (decoded.some((binding) => !binding)) return invalidIndex();
        versionBindings[versionId] = decoded as ManagedSkillBinding[];
      }
    }
    registryIds.add(registryId);
    entries.push({
      registryId,
      name: entry.name,
      description: entry.description,
      ...(entry.activeVersionId ? { activeVersionId: entry.activeVersionId } : {}),
      versions,
      bindings: decodedBindings,
      ...(versionBindings ? { versionBindings } : {}),
      state: entry.state as ManagedSkillIndexEntry['state'],
      revision: entry.revision,
      ...(entry.authorityRevision !== undefined ? { authorityRevision: entry.authorityRevision } : {}),
      updatedAt: entry.updatedAt,
      ...(entry.trash !== undefined ? { trash } : {}),
    });
  }
  return {
    schemaVersion: MANAGED_SKILL_INDEX_SCHEMA_VERSION,
    revision: record.revision,
    entries,
  };
}

function readManagedSkillIndexStrict(homeDir: string): ManagedSkillIndex {
  if (!isManagedSkillStoreEstablished(homeDir)) return { ...EMPTY_INDEX, entries: [] };
  const path = getManagedSkillIndexPath(homeDir);
  if (!existsSync(path)) return { ...EMPTY_INDEX, entries: [] };
  const descriptor = openSync(path, 'r');
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > CAPABILITY_LIMITS.PACKAGE_BYTES) return invalidIndex();
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== stat.size) return invalidIndex();
    return parseIndex(JSON.parse(bytes.subarray(0, offset).toString('utf8')) as unknown);
  } finally {
    closeSync(descriptor);
  }
}

export function readManagedSkillIndex(homeDir = homedir()): ManagedSkillIndex {
  try {
    return readManagedSkillIndexStrict(homeDir);
  } catch {
    // Resolver/startup are fail-closed consumers: malformed disk state is no
    // authority and therefore appears as an empty managed generation.
    return { ...EMPTY_INDEX, entries: [] };
  }
}

export function writeManagedSkillIndex(index: ManagedSkillIndex, homeDir = homedir()): void {
  establishManagedSkillStore(homeDir);
  // Never let a read-as-empty resolver fallback become a destructive repair.
  // Existing malformed state requires an explicit recovery path.
  if (existsSync(getManagedSkillIndexPath(homeDir))) readManagedSkillIndexStrict(homeDir);
  atomicWriteJson(getManagedSkillIndexPath(homeDir), parseIndex(index));
}

export interface PublishManagedSkillInput {
  registryId: string;
  versionId: string;
  quarantinePath: string;
  source: string;
  scannerDigest: string;
  auditDigest: string;
  auditPolicyVersion: string;
  bindings: ManagedSkillBinding[];
  now?: number;
}

export function publishManagedSkillVersion(input: PublishManagedSkillInput, homeDir = homedir()): ManagedSkillIndexEntry {
  establishManagedSkillStore(homeDir);
  const inventory = inventoryAgentSkillPackage(input.quarantinePath);
  const registryRoot = getManagedSkillRegistryRoot(homeDir, input.registryId);
  const finalPath = getManagedSkillVersionPath(homeDir, input.registryId, input.versionId);
  const finalManifestPath = getManagedSkillManifestPath(homeDir, input.registryId, input.versionId);
  mkdirSync(registryRoot, { recursive: true, mode: 0o700 });
  const temporaryPath = join(registryRoot, `.${input.versionId}.${randomUUID()}.tmp`);
  const temporaryManifestPath = `${temporaryPath}.manifest`;
  const now = input.now ?? Date.now();
  const manifest: ManagedSkillVersionManifest = {
    schemaVersion: MANAGED_SKILL_MANIFEST_SCHEMA_VERSION,
    kind: 'skill',
    registryId: input.registryId,
    versionId: input.versionId,
    treeDigest: inventory.treeDigest,
    name: inventory.frontMatter.name,
    description: inventory.frontMatter.description,
    source: contentSafeSourceLabel(input.source),
    createdAt: now,
    files: inventory.files,
    scannerDigest: input.scannerDigest,
    auditDigest: input.auditDigest,
    auditPolicyVersion: input.auditPolicyVersion,
  };
  const publishIndex = (previous: ManagedSkillIndex, publishedManifest: ManagedSkillVersionManifest): ManagedSkillIndexEntry => {
    const existing = previous.entries.find((entry) => entry.registryId === input.registryId);
    const bindingById = new Map((existing?.bindings ?? []).map((binding) => [binding.bindingId, structuredClone(binding)]));
    for (const binding of input.bindings) bindingById.set(binding.bindingId, structuredClone(binding));
    const mergedBindings = [...bindingById.values()];
    if (existing?.versions.includes(input.versionId)) {
      const next: ManagedSkillIndexEntry = {
        ...existing,
        name: publishedManifest.name,
        description: publishedManifest.description,
        activeVersionId: input.versionId,
        bindings: mergedBindings,
        versionBindings: {
          ...(existing.versionBindings ?? {}),
          [input.versionId]: structuredClone(input.bindings),
        },
        state: mergedBindings.some(bindingEnabled) ? CAPABILITY_STATE.ACTIVE : CAPABILITY_STATE.DISABLED,
        revision: existing.revision + 1,
        updatedAt: publishedManifest.createdAt,
      };
      writeManagedSkillIndex({
        ...previous,
        revision: previous.revision + 1,
        entries: previous.entries.map((candidate) => candidate.registryId === input.registryId ? next : candidate),
      }, homeDir);
      return next;
    }
    const entry: ManagedSkillIndexEntry = {
      registryId: input.registryId,
      name: publishedManifest.name,
      description: publishedManifest.description,
      activeVersionId: input.versionId,
      versions: [...new Set([...(existing?.versions ?? []), input.versionId])],
      bindings: mergedBindings,
      versionBindings: {
        ...(existing?.versionBindings ?? {}),
        [input.versionId]: structuredClone(input.bindings),
      },
      state: CAPABILITY_STATE.ACTIVE,
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: publishedManifest.createdAt,
      ...(existing?.trash ? { trash: existing.trash } : {}),
    };
    writeManagedSkillIndex({
      schemaVersion: MANAGED_SKILL_INDEX_SCHEMA_VERSION,
      revision: previous.revision + 1,
      entries: [...previous.entries.filter((candidate) => candidate.registryId !== input.registryId), entry]
        .sort((a, b) => a.registryId.localeCompare(b.registryId)),
    }, homeDir);
    return entry;
  };

  const exactExistingPublication = (): ManagedSkillIndexEntry | undefined => {
    if (!existsSync(finalPath) || !existsSync(finalManifestPath)) return undefined;
    const existingManifest = readManagedSkillManifest(homeDir, input.registryId, input.versionId);
    verifyManagedSkillVersion(homeDir, input.registryId, input.versionId);
    const expectedEvidence = {
      ...manifest,
      createdAt: existingManifest.createdAt,
    };
    if (canonicalJson(existingManifest) !== canonicalJson(expectedEvidence)) {
      throw new Error('Managed Skill version already exists with different evidence');
    }
    return publishIndex(readManagedSkillIndexStrict(homeDir), existingManifest);
  };

  const hasFinalPath = existsSync(finalPath);
  const hasFinalManifest = existsSync(finalManifestPath);
  if (hasFinalPath || hasFinalManifest) {
    if (hasFinalPath && hasFinalManifest) return exactExistingPublication()!;
    const previous = readManagedSkillIndexStrict(homeDir);
    const referenced = previous.entries.some((entry) => entry.registryId === input.registryId
      && (entry.activeVersionId === input.versionId || entry.versions.includes(input.versionId)));
    if (referenced) throw new Error('Managed Skill index references an incomplete immutable version');
    // The exact authoritative version id is owned by this publication input.
    // Remove only its unindexed partial paths; never inspect/delete by name.
    rmSync(finalPath, { recursive: true, force: true });
    rmSync(finalManifestPath, { force: true });
    fsyncDirectory(registryRoot);
  }
  // Cleanup must only remove paths published by this invocation. Another
  // concurrent publisher may win after the preflight existence check; the
  // losing invocation must never delete that winner's immutable package.
  let ownsFinalPath = false;
  let ownsFinalManifestPath = false;
  try {
    cpSync(input.quarantinePath, temporaryPath, { recursive: true, dereference: false, errorOnExist: true });
    assertManifestMatchesPackage(manifest, temporaryPath);
    fsyncPublishedTree(temporaryPath, manifest.files);
    writeFileSync(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, finalPath);
    ownsFinalPath = true;
    renameSync(temporaryManifestPath, finalManifestPath);
    ownsFinalManifestPath = true;
    const manifestFile = openSync(finalManifestPath, 'r');
    try { fsyncSync(manifestFile); } finally { closeSync(manifestFile); }
    const registryDirectory = openSync(registryRoot, 'r');
    try { fsyncSync(registryDirectory); } finally { closeSync(registryDirectory); }
    return publishIndex(readManagedSkillIndexStrict(homeDir), manifest);
  } catch (error) {
    rmSync(temporaryPath, { recursive: true, force: true });
    rmSync(temporaryManifestPath, { force: true });
    if (ownsFinalPath) rmSync(finalPath, { recursive: true, force: true });
    if (ownsFinalManifestPath) rmSync(finalManifestPath, { force: true });
    // A concurrent identical publisher may have won after our preflight. Its
    // paths were never owned by this invocation; verify and converge instead
    // of deleting or reporting a false conflict.
    if (!ownsFinalPath && !ownsFinalManifestPath && existsSync(finalPath) && existsSync(finalManifestPath)) {
      try { return exactExistingPublication()!; } catch { /* report original failure below */ }
    }
    throw error;
  }
}

export function readManagedSkillManifest(homeDir: string, registryId: string, versionId: string): ManagedSkillVersionManifest {
  const path = assertPathInsideManagedRoot(getManagedSkillManifestPath(homeDir, registryId, versionId), homeDir);
  const bytes = readBoundedRegularFile(path, MANAGED_SKILL_MANIFEST_MAX_BYTES);
  return decodeManifest(JSON.parse(bytes.toString('utf8')) as unknown, registryId, versionId);
}

export function verifyManagedSkillVersion(homeDir: string, registryId: string, versionId: string): ManagedSkillVersionManifest {
  const manifest = readManagedSkillManifest(homeDir, registryId, versionId);
  assertManifestMatchesPackage(manifest, getManagedSkillVersionPath(homeDir, registryId, versionId));
  return manifest;
}

/**
 * Reads one manifest-authorized package file from the same verified descriptor.
 * Replacing, growing, truncating, linking, or mutating the path between package
 * verification and activation fails closed on inode/stat/size/digest checks.
 */
export function readVerifiedManagedSkillFile(
  homeDir: string,
  registryId: string,
  versionId: string,
  relativePath: string,
  maxBytes = CAPABILITY_LIMITS.FILE_BYTES,
): { manifest: ManagedSkillVersionManifest; content: Buffer } {
  const manifest = verifyManagedSkillVersion(homeDir, registryId, versionId);
  const entry = manifest.files.find((candidate) => candidate.path === relativePath);
  if (!entry || entry.size > maxBytes) throw new Error('Managed Skill file is not authorized by the manifest');
  const path = assertPathInsideManagedRoot(
    join(getManagedSkillVersionPath(homeDir, registryId, versionId), relativePath),
    homeDir,
  );
  beforeVerifiedFileOpenForTest?.();
  const content = readBoundedRegularFile(path, maxBytes);
  if (content.byteLength !== entry.size
    || createHash('sha256').update(content).digest('hex') !== entry.sha256) {
    throw new Error('Managed Skill file digest changed during activation');
  }
  return { manifest, content };
}

export function updateManagedSkillEntry(
  registryId: string,
  update: (entry: ManagedSkillIndexEntry) => ManagedSkillIndexEntry,
  homeDir = homedir(),
): ManagedSkillIndexEntry {
  const index = readManagedSkillIndexStrict(homeDir);
  const current = index.entries.find((entry) => entry.registryId === registryId);
  if (!current) throw new Error('Managed Skill not found');
  const next = update(current);
  writeManagedSkillIndex({
    schemaVersion: MANAGED_SKILL_INDEX_SCHEMA_VERSION,
    revision: index.revision + 1,
    entries: index.entries.map((entry) => entry.registryId === registryId ? next : entry),
  }, homeDir);
  return next;
}

export interface ExactLocalSkillManageInput {
  ownerId: string;
  serverId: string;
  capabilityId: string;
  bindingId: string;
  expectedRevision: number;
  action: Exclude<CapabilityManagementAction, typeof CAPABILITY_MANAGE_ACTION.CANCEL_OPERATION | typeof CAPABILITY_MANAGE_ACTION.DELETE_CREDENTIALS>;
  versionId?: string;
  finalAuthorityRevision?: number;
  authorization?: CapabilitySkillAuthorizationEnvelope;
  now?: number;
}

export type ExactLocalSkillManageResult =
  | { ok: true; entry: ManagedSkillIndexEntry }
  | { ok: false; code: 'not_found' | 'forbidden' | 'conflict' | 'invalid_action' | 'integrity_failed' };

function bindingEnabled(binding: ManagedSkillBinding): boolean {
  return binding.active !== false && binding.removed !== true;
}

/**
 * Applies one server-authorized local binding mutation. Identity, scope,
 * owner, daemon and authority revision are checked before any filesystem
 * mutation. Package trash/restore and index publication are one recoverable
 * transaction; a failed index write restores the exact prior file layout.
 */
export function manageExactLocalSkillBinding(
  input: ExactLocalSkillManageInput,
  homeDir = homedir(),
): ExactLocalSkillManageResult {
  const index = readManagedSkillIndexStrict(homeDir);
  const entry = index.entries.find((candidate) => candidate.registryId === input.capabilityId);
  if (!entry) return { ok: false, code: 'not_found' };
  const bindingIndex = entry.bindings.findIndex((binding) => binding.bindingId === input.bindingId);
  if (bindingIndex < 0) return { ok: false, code: 'not_found' };
  const binding = entry.bindings[bindingIndex]!;
  if (binding.ownerId !== input.ownerId
    || binding.scope !== CAPABILITY_SCOPE.LOCAL
    || binding.serverId !== input.serverId) return { ok: false, code: 'forbidden' };
  if (entry.authorityRevision !== input.expectedRevision) return { ok: false, code: 'conflict' };
  const now = input.now ?? Date.now();
  const authorityRevision = input.finalAuthorityRevision ?? input.expectedRevision + 1;
  if (!Number.isSafeInteger(authorityRevision) || authorityRevision <= input.expectedRevision) {
    return { ok: false, code: 'conflict' };
  }
  const nextBindings = structuredClone(entry.bindings);
  let next: ManagedSkillIndexEntry;

  if (input.action === CAPABILITY_MANAGE_ACTION.ENABLE || input.action === CAPABILITY_MANAGE_ACTION.DISABLE) {
    if (binding.removed) return { ok: false, code: 'invalid_action' };
    if (input.action === CAPABILITY_MANAGE_ACTION.ENABLE) {
      if (!binding.versionId || !entry.versions.includes(binding.versionId)
        || (input.authorization && input.authorization.versionId !== binding.versionId)) {
        return { ok: false, code: 'integrity_failed' };
      }
      try { verifyManagedSkillVersion(homeDir, entry.registryId, binding.versionId); } catch { return { ok: false, code: 'integrity_failed' }; }
    }
    nextBindings[bindingIndex] = {
      ...binding,
      active: input.action === CAPABILITY_MANAGE_ACTION.ENABLE,
      ...(input.authorization ? { authorization: structuredClone(input.authorization) } : {}),
    };
    next = {
      ...entry,
      bindings: nextBindings,
      state: nextBindings.some(bindingEnabled) ? CAPABILITY_STATE.ACTIVE : CAPABILITY_STATE.DISABLED,
      revision: entry.revision + 1,
      authorityRevision,
      updatedAt: now,
    };
    writeManagedSkillIndex({
      ...index,
      revision: index.revision + 1,
      entries: index.entries.map((candidate) => candidate.registryId === entry.registryId ? next : candidate),
    }, homeDir);
    return { ok: true, entry: next };
  }

  if (input.action === CAPABILITY_MANAGE_ACTION.ROLLBACK) {
    if (!input.versionId || !entry.versions.includes(input.versionId)) return { ok: false, code: 'invalid_action' };
    try { verifyManagedSkillVersion(homeDir, entry.registryId, input.versionId); } catch { return { ok: false, code: 'integrity_failed' }; }
    nextBindings[bindingIndex] = {
      ...binding,
      versionId: input.versionId,
      active: true,
      removed: false,
      trashId: undefined,
      ...(input.authorization ? { authorization: structuredClone(input.authorization) } : {}),
    };
    next = {
      ...entry,
      activeVersionId: input.versionId,
      bindings: nextBindings,
      versionBindings: {
        ...(entry.versionBindings ?? {}),
        [input.versionId]: [
          ...(entry.versionBindings?.[input.versionId] ?? []).filter((candidate) => candidate.bindingId !== input.bindingId),
          structuredClone(nextBindings[bindingIndex]!),
        ],
      },
      state: nextBindings.some(bindingEnabled) ? CAPABILITY_STATE.ACTIVE : CAPABILITY_STATE.DISABLED,
      revision: entry.revision + 1,
      authorityRevision,
      updatedAt: now,
    };
    writeManagedSkillIndex({
      ...index,
      revision: index.revision + 1,
      entries: index.entries.map((candidate) => candidate.registryId === entry.registryId ? next : candidate),
    }, homeDir);
    return { ok: true, entry: next };
  }

  if (input.action !== CAPABILITY_MANAGE_ACTION.UNINSTALL && input.action !== CAPABILITY_MANAGE_ACTION.RESTORE) {
    return { ok: false, code: 'invalid_action' };
  }

  if (input.action === CAPABILITY_MANAGE_ACTION.UNINSTALL) {
    if (binding.removed || !binding.versionId) return { ok: false, code: 'invalid_action' };
    // A removed sibling without its own trash pointer still relies on the
    // shared immutable package for an exact later restore. Retain bytes until
    // the final sibling reference is physically trashed.
    const otherReferencesVersion = nextBindings.some((candidate, candidateIndex) => candidateIndex !== bindingIndex
      && candidate.versionId === binding.versionId && !candidate.trashId);
    if (otherReferencesVersion) {
      nextBindings[bindingIndex] = { ...binding, active: false, removed: true, ...(input.authorization ? { authorization: structuredClone(input.authorization) } : {}) };
      next = {
        ...entry,
        bindings: nextBindings,
        state: nextBindings.some(bindingEnabled) ? CAPABILITY_STATE.ACTIVE : CAPABILITY_STATE.DISABLED,
        revision: entry.revision + 1,
        authorityRevision,
        updatedAt: now,
      };
      writeManagedSkillIndex({
        ...index,
        revision: index.revision + 1,
        entries: index.entries.map((candidate) => candidate.registryId === entry.registryId ? next : candidate),
      }, homeDir);
      return { ok: true, entry: next };
    }
    try { verifyManagedSkillVersion(homeDir, entry.registryId, binding.versionId); } catch { return { ok: false, code: 'integrity_failed' }; }
    const versionId = binding.versionId;
    const trashId = `${entry.registryId}-${versionId}-${now}-${randomUUID()}`;
    const trashPath = join(getManagedSkillTrashRoot(homeDir), trashId);
    const versionPath = getManagedSkillVersionPath(homeDir, entry.registryId, versionId);
    const manifestPath = getManagedSkillManifestPath(homeDir, entry.registryId, versionId);
    mkdirSync(trashPath, { recursive: true, mode: 0o700 });
    renameSync(versionPath, join(trashPath, 'package'));
    try {
      renameSync(manifestPath, join(trashPath, 'manifest.json'));
      nextBindings[bindingIndex] = {
        ...binding,
        active: false,
        removed: true,
        trashId,
        ...(input.authorization ? { authorization: structuredClone(input.authorization) } : {}),
      };
      next = {
        ...entry,
        activeVersionId: nextBindings.find(bindingEnabled)?.versionId,
        versions: entry.versions.filter((candidate) => candidate !== versionId),
        bindings: nextBindings,
        state: nextBindings.some(bindingEnabled) ? CAPABILITY_STATE.ACTIVE : CAPABILITY_STATE.TOMBSTONED,
        revision: entry.revision + 1,
        authorityRevision,
        updatedAt: now,
        trash: [...(entry.trash ?? []), { versionId, trashId, removedAt: now }],
      };
      writeManagedSkillIndex({
        ...index,
        revision: index.revision + 1,
        entries: index.entries.map((candidate) => candidate.registryId === entry.registryId ? next : candidate),
      }, homeDir);
      return { ok: true, entry: next };
    } catch {
      if (existsSync(join(trashPath, 'manifest.json'))) renameSync(join(trashPath, 'manifest.json'), manifestPath);
      if (existsSync(join(trashPath, 'package'))) renameSync(join(trashPath, 'package'), versionPath);
      rmSync(trashPath, { recursive: true, force: true });
      return { ok: false, code: 'integrity_failed' };
    }
  }

  if (!binding.removed) return { ok: false, code: 'invalid_action' };
  // Removing one of several bindings does not trash the shared immutable
  // package. Restore that exact binding in place after verifying it still
  // targets the active version; never require a trash id that cannot exist.
  if (!binding.trashId) {
    if (!binding.versionId || !entry.versions.includes(binding.versionId)
      || (input.versionId !== undefined && input.versionId !== binding.versionId)) {
      return { ok: false, code: 'integrity_failed' };
    }
    try { verifyManagedSkillVersion(homeDir, entry.registryId, binding.versionId); } catch { return { ok: false, code: 'integrity_failed' }; }
    nextBindings[bindingIndex] = {
      ...binding, active: true, removed: false,
      ...(input.authorization ? { authorization: structuredClone(input.authorization) } : {}),
    };
    next = {
      ...entry, bindings: nextBindings, state: CAPABILITY_STATE.ACTIVE,
      revision: entry.revision + 1, authorityRevision, updatedAt: now,
    };
    writeManagedSkillIndex({
      ...index, revision: index.revision + 1,
      entries: index.entries.map((candidate) => candidate.registryId === entry.registryId ? next : candidate),
    }, homeDir);
    return { ok: true, entry: next };
  }
  const trashed = entry.trash?.find((candidate) => candidate.trashId === binding.trashId);
  if (!trashed) return { ok: false, code: 'integrity_failed' };
  const trashPath = join(getManagedSkillTrashRoot(homeDir), binding.trashId);
  const versionPath = getManagedSkillVersionPath(homeDir, entry.registryId, trashed.versionId);
  const manifestPath = getManagedSkillManifestPath(homeDir, entry.registryId, trashed.versionId);
  mkdirSync(dirname(versionPath), { recursive: true, mode: 0o700 });
  try {
    renameSync(join(trashPath, 'package'), versionPath);
    renameSync(join(trashPath, 'manifest.json'), manifestPath);
    verifyManagedSkillVersion(homeDir, entry.registryId, trashed.versionId);
    nextBindings[bindingIndex] = {
      ...binding,
      active: true,
      removed: false,
      trashId: undefined,
      ...(input.authorization ? { authorization: structuredClone(input.authorization) } : {}),
    };
    next = {
      ...entry,
      activeVersionId: entry.activeVersionId ?? trashed.versionId,
      versions: [...new Set([...entry.versions, trashed.versionId])],
      bindings: nextBindings,
      state: CAPABILITY_STATE.ACTIVE,
      revision: entry.revision + 1,
      authorityRevision,
      updatedAt: now,
      trash: entry.trash?.filter((candidate) => candidate.trashId !== binding.trashId),
    };
    writeManagedSkillIndex({
      ...index,
      revision: index.revision + 1,
      entries: index.entries.map((candidate) => candidate.registryId === entry.registryId ? next : candidate),
    }, homeDir);
    rmSync(trashPath, { recursive: true, force: true });
    return { ok: true, entry: next };
  } catch {
    if (existsSync(manifestPath)) renameSync(manifestPath, join(trashPath, 'manifest.json'));
    if (existsSync(versionPath)) renameSync(versionPath, join(trashPath, 'package'));
    return { ok: false, code: 'integrity_failed' };
  }
}

export function trashManagedSkillVersion(homeDir: string, registryId: string, versionId: string, now = Date.now()): string {
  const versionPath = getManagedSkillVersionPath(homeDir, registryId, versionId);
  const manifestPath = getManagedSkillManifestPath(homeDir, registryId, versionId);
  verifyManagedSkillVersion(homeDir, registryId, versionId);
  const trashId = `${registryId}-${versionId}-${now}-${randomUUID()}`;
  const trashPath = join(getManagedSkillTrashRoot(homeDir), trashId);
  mkdirSync(trashPath, { recursive: true, mode: 0o700 });
  renameSync(versionPath, join(trashPath, 'package'));
  try {
    renameSync(manifestPath, join(trashPath, 'manifest.json'));
  } catch (error) {
    renameSync(join(trashPath, 'package'), versionPath);
    rmSync(trashPath, { recursive: true, force: true });
    throw error;
  }
  try {
    updateManagedSkillEntry(registryId, (entry) => ({
      ...entry,
      activeVersionId: entry.activeVersionId === versionId ? undefined : entry.activeVersionId,
      versions: entry.versions.filter((candidate) => candidate !== versionId),
      trash: [...(entry.trash ?? []), { versionId, trashId, removedAt: now }],
      state: entry.activeVersionId === versionId ? CAPABILITY_STATE.TOMBSTONED : entry.state,
      revision: entry.revision + 1,
      updatedAt: now,
    }), homeDir);
  } catch (error) {
    renameSync(join(trashPath, 'package'), versionPath);
    renameSync(join(trashPath, 'manifest.json'), manifestPath);
    rmSync(trashPath, { recursive: true, force: true });
    throw error;
  }
  return trashId;
}

export function restoreManagedSkillVersion(homeDir: string, registryId: string, trashId: string, now = Date.now()): ManagedSkillIndexEntry {
  const index = readManagedSkillIndexStrict(homeDir);
  const entry = index.entries.find((candidate) => candidate.registryId === registryId);
  const trashed = entry?.trash?.find((candidate) => candidate.trashId === trashId);
  if (!entry || !trashed) throw new Error('Managed Skill trash entry not found');
  const trashPath = join(getManagedSkillTrashRoot(homeDir), trashId);
  const versionPath = getManagedSkillVersionPath(homeDir, registryId, trashed.versionId);
  const manifestPath = getManagedSkillManifestPath(homeDir, registryId, trashed.versionId);
  mkdirSync(dirname(versionPath), { recursive: true, mode: 0o700 });
  renameSync(join(trashPath, 'package'), versionPath);
  try {
    renameSync(join(trashPath, 'manifest.json'), manifestPath);
    verifyManagedSkillVersion(homeDir, registryId, trashed.versionId);
  } catch (error) {
    if (existsSync(versionPath)) renameSync(versionPath, join(trashPath, 'package'));
    throw error;
  }
  try {
    const updated = updateManagedSkillEntry(registryId, (current) => ({
      ...current,
      activeVersionId: trashed.versionId,
      versions: [...new Set([...current.versions, trashed.versionId])],
      trash: current.trash?.filter((candidate) => candidate.trashId !== trashId),
      state: CAPABILITY_STATE.ACTIVE,
      revision: current.revision + 1,
      updatedAt: now,
    }), homeDir);
    rmSync(trashPath, { recursive: true, force: true });
    return updated;
  } catch (error) {
    mkdirSync(trashPath, { recursive: true, mode: 0o700 });
    if (existsSync(versionPath)) renameSync(versionPath, join(trashPath, 'package'));
    if (existsSync(manifestPath)) renameSync(manifestPath, join(trashPath, 'manifest.json'));
    throw error;
  }
}

export const MANAGED_SKILL_STORE_TESTING = {
  atomicWriteJson,
  readBoundedRegularFile,
  setBeforeVerifiedFileOpen(callback?: () => void): void { beforeVerifiedFileOpenForTest = callback; },
};
