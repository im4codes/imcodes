import {
  CAPABILITY_AUDIT_VERDICT,
  CAPABILITY_KIND,
  CAPABILITY_LIMITS,
  CAPABILITY_OPERATION_MSG,
  CAPABILITY_READINESS,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_STATE,
  CAPABILITY_SYNC_MSG,
  computeCapabilitySyncDigest,
  normalizeCapabilityMcpDefinition,
  isCapabilityInstallTerminal,
  type CapabilityFinding,
  type CapabilityAuthorizationKey,
  type CapabilityOperationAuthorizeFrame,
  type CapabilityOperation,
  type CapabilityReadiness,
  type CapabilityScope,
  type CapabilitySourceKind,
  type CapabilitySummary,
  type CapabilitySyncSnapshot,
  type CapabilitySyncAuthorityFrame,
  type CapabilityVersion,
} from '../../../shared/capability-management.js';
import { sha256Hex } from '../security/crypto.js';
import type {
  CapabilityItemView,
  CapabilityOperationView,
  PendingCapabilityAuthorizationView,
  CapabilitySyncSnapshotRecord,
  CapabilityAuthorityRecordSet,
} from '../db/capabilities.js';

function stringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).filter((entry): entry is string => typeof entry === 'string');
}

function findings(value: unknown): CapabilityFinding[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, CAPABILITY_LIMITS.FINDINGS).filter((entry): entry is CapabilityFinding => (
    typeof entry === 'object'
    && entry !== null
    && typeof (entry as { code?: unknown }).code === 'string'
    && typeof (entry as { message?: unknown }).message === 'string'
    && typeof (entry as { severity?: unknown }).severity === 'string'
    && typeof (entry as { source?: unknown }).source === 'string'
    && typeof (entry as { blocking?: unknown }).blocking === 'boolean'
  ));
}

function sourceKind(value: string | undefined): CapabilitySourceKind | undefined {
  return Object.values(CAPABILITY_SOURCE_KIND).find((candidate) => candidate === value);
}

function itemReadiness(item: CapabilityItemView): CapabilityReadiness {
  const firstReady = item.readiness.find((entry) => entry.state === CAPABILITY_READINESS.READY);
  if (firstReady) return firstReady.state;
  const first = item.readiness[0];
  if (first) return first.state;
  if (item.kind === CAPABILITY_KIND.MCP) return CAPABILITY_READINESS.RUNTIME_PENDING;
  return item.activeVersion ? CAPABILITY_READINESS.READY : CAPABILITY_READINESS.CONTENT_MISSING;
}

export function toCapabilitySummary(item: CapabilityItemView): CapabilitySummary {
  const binding = item.bindings[0];
  const manifest = item.activeVersion?.manifest ?? {};
  const definition = item.activeVersion?.definition ?? {};
  const scripts = Array.isArray(manifest.scripts) ? manifest.scripts : [];
  const executables = Array.isArray(manifest.executables) ? manifest.executables : [];
  const stdioCommand = Array.isArray(definition.command)
    ? definition.command.filter((part): part is string => typeof part === 'string')
    : typeof definition.command === 'string'
      ? [definition.command, ...stringArray(definition.args, CAPABILITY_LIMITS.PATH_BYTES)]
      : undefined;
  return {
    id: item.id,
    revision: item.revision,
    kind: item.kind,
    name: item.name,
    state: item.lifecycleState,
    scope: binding?.scope ?? CAPABILITY_SCOPE.ACCOUNT,
    versionId: item.activeVersion?.id,
    version: item.activeVersion?.versionNumber,
    availableVersions: item.versions.map((version) => ({
      id: version.id,
      label: `v${version.versionNumber}`,
      version: version.versionNumber,
      createdAt: version.createdAt,
    })),
    artifactDigest: item.activeVersion?.artifactDigest,
    sourceKind: sourceKind(item.activeVersion?.sourceKind),
    sourceLabel: item.activeVersion?.sourceSummary,
    readiness: itemReadiness(item),
    findings: findings(manifest.findings),
    bindings: item.bindings.map((entry) => ({
      id: entry.id,
      versionId: entry.versionId,
      scope: entry.scope,
      scopeId: entry.projectKey ?? entry.sessionKey ?? entry.serverId ?? undefined,
      providers: entry.providerFilter,
      machines: entry.machineFilter,
      active: entry.enabled,
    })),
    tools: stringArray(manifest.tools, CAPABILITY_LIMITS.FINDINGS),
    permissions: item.activeVersion?.permissionSummary.filter((permission): permission is string => typeof permission === 'string'),
    hasScripts: scripts.length > 0,
    hasExecutables: executables.length > 0,
    stdioCommand,
    // The encrypted Registry credential store is owned by the dependency
    // change and is not present yet. Do not advertise a destructive action
    // that this slice cannot execute truthfully.
    credentialsRetained: false,
    updatedAt: item.updatedAt,
  };
}

export function toCapabilityOperationWire(
  operation: CapabilityOperationView,
): CapabilityOperation & { terminal: boolean } {
  const request = operation.requestSummary;
  const matchingEvidence = operation.evidence.filter((entry) => (
    operation.artifactDigest !== null && entry.artifactDigest === operation.artifactDigest
  ));
  const latestAudit = [...matchingEvidence].reverse().find((entry) => (
    entry.kind === 'audit'
    && operation.auditDigest !== null
    && entry.evidenceDigest === operation.auditDigest
  ));
  const latestEvidence = latestAudit
    ?? [...matchingEvidence].reverse().find((entry) => entry.kind === 'scan');
  const hasCurrentEvidence = latestEvidence !== undefined;
  const kind = request.kind === CAPABILITY_KIND.MCP ? CAPABILITY_KIND.MCP : CAPABILITY_KIND.SKILL;
  const scope = Object.values(CAPABILITY_SCOPE).includes(request.scope as CapabilityScope)
    ? request.scope as CapabilityScope
    : CAPABILITY_SCOPE.ACCOUNT;
  return {
    id: operation.id,
    capabilityId: operation.itemId
      ?? (typeof request.capabilityId === 'string' ? request.capabilityId : undefined),
    kind,
    state: operation.state,
    revision: operation.revision,
    displayName: typeof request.displayName === 'string' ? request.displayName : undefined,
    sourceLabel: typeof request.sourceLabel === 'string' ? request.sourceLabel : undefined,
    scope,
    artifactDigest: operation.artifactDigest ?? undefined,
    auditDigest: operation.auditDigest ?? undefined,
    auditVerdict: latestAudit?.verdict ?? undefined,
    findings: latestEvidence ? findings(latestEvidence.findings) : [],
    providers: stringArray(request.providers, CAPABILITY_LIMITS.PROVIDERS),
    machines: stringArray(request.machines, CAPABILITY_LIMITS.MACHINES),
    ...(hasCurrentEvidence ? {
      tools: stringArray(request.tools, CAPABILITY_LIMITS.FINDINGS),
      permissions: stringArray(request.permissions, CAPABILITY_LIMITS.FINDINGS),
      updateDiff: stringArray(request.updateDiff, CAPABILITY_LIMITS.FINDINGS),
    } : {}),
    hasScripts: hasCurrentEvidence && request.hasScripts === true,
    hasExecutables: hasCurrentEvidence && request.hasExecutables === true,
    ...(hasCurrentEvidence
      ? { stdioCommand: stringArray(request.stdioCommand, CAPABILITY_LIMITS.PATH_BYTES) }
      : {}),
    errorCode: operation.errorCode ?? undefined,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    terminal: isCapabilityInstallTerminal(operation.state),
  };
}

export function toCapabilityOperationAuthorizeFrame(
  pending: PendingCapabilityAuthorizationView,
  authorizationKeys: readonly CapabilityAuthorizationKey[],
): CapabilityOperationAuthorizeFrame {
  const normalizedSourceKind = sourceKind(pending.version.sourceKind);
  if (!normalizedSourceKind) throw new Error('capability_authorize_invalid_source_kind');
  const capability = {
    ...toCapabilitySummary(pending.item),
    id: pending.item.id,
    revision: pending.authorityRevision,
    kind: pending.item.kind,
    name: pending.item.name,
    state: CAPABILITY_STATE.PENDING,
    scope: pending.binding.scope,
    versionId: pending.version.id,
    version: pending.version.versionNumber,
    artifactDigest: pending.version.artifactDigest,
    sourceKind: normalizedSourceKind,
    sourceLabel: pending.version.sourceSummary,
    bindings: [{
      id: pending.binding.id,
      scope: pending.binding.scope,
      scopeId: pending.binding.projectKey ?? pending.binding.sessionKey ?? pending.binding.serverId ?? undefined,
      providers: pending.binding.providerFilter,
      machines: pending.binding.machineFilter,
      active: true,
    }],
  };
  return {
    type: CAPABILITY_OPERATION_MSG.AUTHORIZE,
    operationId: pending.operationId,
    expectedRevision: pending.expectedRevision,
    capability,
    version: {
      id: pending.version.id,
      capabilityId: pending.item.id,
      version: pending.version.versionNumber,
      artifactDigest: pending.version.artifactDigest,
      ...(pending.version.blobDigest && pending.version.blobByteSize
        ? { blobDigest: pending.version.blobDigest, blobByteSize: pending.version.blobByteSize }
        : {}),
      ...(pending.version.definition ? { definition: normalizeCapabilityMcpDefinition({
        kind: CAPABILITY_SOURCE_KIND.MCP_CONFIG,
        mcpConfig: pending.version.definition,
      })! } : {}),
      auditDigest: pending.version.auditDigest,
      auditVerdict: CAPABILITY_AUDIT_VERDICT.PASS,
      sourceKind: normalizedSourceKind,
      sourceLocator: pending.version.sourceSummary || undefined,
      createdAt: pending.version.createdAt,
    },
    binding: {
      id: pending.binding.id,
      capabilityId: pending.item.id,
      versionId: pending.version.id,
      scope: pending.binding.scope,
      scopeId: pending.binding.projectKey ?? pending.binding.sessionKey ?? pending.binding.serverId ?? undefined,
      providers: pending.binding.providerFilter,
      machines: pending.binding.machineFilter,
      active: true,
      ...(pending.binding.authorization ? { authorization: pending.binding.authorization } : {}),
    },
    authorizationKeys,
    expiresAt: pending.expiresAt,
  };
}

export function toCapabilitySyncSnapshot(
  record: CapabilitySyncSnapshotRecord,
  type: typeof CAPABILITY_SYNC_MSG.SNAPSHOT | typeof CAPABILITY_SYNC_MSG.DELTA = CAPABILITY_SYNC_MSG.SNAPSHOT,
  authorizationKeys: readonly CapabilityAuthorizationKey[] = [],
): CapabilitySyncSnapshot {
  const items: CapabilitySummary[] = record.items.map((item) => {
    const summary = toCapabilitySummary(item);
    // Complete sync carries immutable versions and bindings in their own
    // top-level bounded arrays. Duplicating them inside every item would make
    // an otherwise valid current state exceed the single-frame wire budget.
    const { availableVersions: _availableVersions, bindings: _bindings, ...wireItem } = summary;
    return wireItem;
  });
  const versions: CapabilityVersion[] = record.items.flatMap((item) => item.versions.flatMap((version) => {
    const normalizedSourceKind = sourceKind(version.sourceKind);
    if (!normalizedSourceKind) return [];
    const definition = item.kind === CAPABILITY_KIND.MCP && version.definition
      ? normalizeCapabilityMcpDefinition({
        kind: CAPABILITY_SOURCE_KIND.MCP_CONFIG,
        mcpConfig: version.definition,
      })
      : null;
    if ((item.kind === CAPABILITY_KIND.MCP && !definition)
      || (item.kind === CAPABILITY_KIND.SKILL && version.definition !== null)) {
      throw new Error('capability_sync_invalid_definition');
    }
    if ((item.kind === CAPABILITY_KIND.SKILL && (!version.blobDigest || !version.blobByteSize))
      || (item.kind === CAPABILITY_KIND.MCP && (version.blobDigest !== null || version.blobByteSize !== null))) {
      throw new Error('capability_sync_invalid_blob_metadata');
    }
    return [{
      id: version.id,
      capabilityId: item.id,
      version: version.versionNumber,
      artifactDigest: version.artifactDigest,
      ...(version.blobDigest && version.blobByteSize
        ? { blobDigest: version.blobDigest, blobByteSize: version.blobByteSize }
        : {}),
      ...(definition ? { definition } : {}),
      auditDigest: version.auditDigest,
      auditVerdict: CAPABILITY_AUDIT_VERDICT.PASS,
      sourceKind: normalizedSourceKind,
      sourceLocator: version.sourceSummary || undefined,
      createdAt: version.createdAt,
    }];
  }));
  const bindings = record.items.flatMap((item) => item.bindings
    .filter((binding) => binding.scope !== CAPABILITY_SCOPE.LOCAL)
    .map((binding) => ({
      id: binding.id,
      capabilityId: item.id,
      versionId: binding.versionId,
      scope: binding.scope,
      scopeId: binding.projectKey ?? binding.sessionKey ?? undefined,
      providers: binding.providerFilter,
      machines: binding.machineFilter,
      active: binding.enabled,
      ...(binding.authorization ? { authorization: binding.authorization } : {}),
    })));
  const frame: CapabilitySyncSnapshot = {
    type,
    ownerId: record.ownerId,
    revision: record.revision,
    items,
    versions,
    bindings,
    tombstones: record.tombstones.map((entry) => ({
      id: entry.id,
      capabilityId: entry.itemId,
      scope: entry.scope,
      accountRevision: entry.accountRevision,
      expiresAt: entry.expiresAt,
      createdAt: entry.createdAt,
    })),
    authorizationKeys,
    digest: '',
  };
  for (const item of items) {
    if (Buffer.byteLength(JSON.stringify(item), 'utf8') > CAPABILITY_LIMITS.SYNC_ITEM_RECORD_BYTES) {
      throw new Error('capability_sync_item_record_too_large');
    }
  }
  for (const version of versions) {
    if (Buffer.byteLength(JSON.stringify(version), 'utf8') > CAPABILITY_LIMITS.SYNC_VERSION_RECORD_BYTES) {
      throw new Error('capability_sync_version_record_too_large');
    }
  }
  for (const binding of bindings) {
    if (Buffer.byteLength(JSON.stringify(binding), 'utf8') > CAPABILITY_LIMITS.SYNC_BINDING_RECORD_BYTES) {
      throw new Error('capability_sync_binding_record_too_large');
    }
  }
  for (const tombstone of frame.tombstones) {
    if (Buffer.byteLength(JSON.stringify(tombstone), 'utf8') > CAPABILITY_LIMITS.SYNC_TOMBSTONE_RECORD_BYTES) {
      throw new Error('capability_sync_tombstone_record_too_large');
    }
  }
  const resolved = { ...frame, digest: computeCapabilitySyncDigest(frame, sha256Hex) };
  if (Buffer.byteLength(JSON.stringify(resolved), 'utf8') > CAPABILITY_LIMITS.SYNC_FRAME_BYTES) {
    throw new Error('capability_sync_frame_too_large');
  }
  return resolved;
}

export function toCapabilitySyncAuthorityFrame(
  record: CapabilityAuthorityRecordSet,
  authorizationKeys: readonly CapabilityAuthorizationKey[],
): CapabilitySyncAuthorityFrame {
  const frame: CapabilitySyncAuthorityFrame = {
    type: CAPABILITY_SYNC_MSG.AUTHORITY,
    ownerId: record.ownerId,
    serverId: record.serverId,
    revision: record.revision,
    records: record.records,
    authorizationKeys,
    digest: '',
  };
  const resolved = {
    ...frame,
    digest: computeCapabilitySyncDigest(frame, sha256Hex),
  };
  if (Buffer.byteLength(JSON.stringify(resolved), 'utf8') > CAPABILITY_LIMITS.SYNC_FRAME_BYTES) {
    throw new Error('capability_sync_frame_too_large');
  }
  return resolved;
}
