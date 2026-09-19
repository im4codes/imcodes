import { randomUUID } from 'node:crypto';
import {
  CAPABILITY_CONFIRMATION_DECISION,
  CAPABILITY_AUTHORITY_STATE,
  CAPABILITY_BLOB_ACTION,
  CAPABILITY_ERROR,
  CAPABILITY_KIND,
  CAPABILITY_INSTALL_STATE,
  CAPABILITY_LIMITS,
  CAPABILITY_MANAGE_ACTION,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_STATE,
  isCapabilityInstallTerminal,
  isCapabilityInstallCancellable,
  normalizeCapabilityMcpDefinition,
  type CapabilityAuditVerdict,
  type CapabilityAuthorityState,
  type CapabilityAuthorityRecord,
  type CapabilityBlobAction,
  type CapabilityConfirmationDecision,
  type CapabilityErrorCode,
  type CapabilityInstallState,
  type CapabilityKind,
  type CapabilityLifecycleState,
  type CapabilityLocalManagementAction,
  type CapabilityManagementAction,
  type CapabilityReadiness,
  type CapabilityScope,
  type CapabilitySkillAuthorizationEnvelope,
} from '../../../shared/capability-management.js';
import { sha256Hex } from '../security/crypto.js';
import type { CapabilityAuthorizationSigner } from '../services/capability-authorization.js';
import type { Database } from './client.js';


function canonicalCapabilityJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalCapabilityJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalCapabilityJson(record[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface CapabilityVersionView {
  id: string;
  versionNumber: number;
  artifactDigest: string;
  blobDigest: string | null;
  blobByteSize: number | null;
  auditDigest: string;
  sourceKind: string;
  sourceSummary: string;
  manifest: Record<string, unknown>;
  definition: Record<string, unknown> | null;
  permissionSummary: unknown[];
  publicationState: 'pending' | 'active' | 'failed';
  createdAt: number;
}

export interface CapabilityBindingView {
  id: string;
  versionId: string;
  scope: CapabilityScope;
  projectKey: string | null;
  sessionKey: string | null;
  serverId: string | null;
  providerFilter: string[];
  machineFilter: string[];
  authorization: CapabilitySkillAuthorizationEnvelope | null;
  authorityState: CapabilityAuthorityState;
  enabled: boolean;
  revision: number;
  updatedAt: number;
}

export interface CapabilityReadinessView {
  serverId: string;
  state: CapabilityReadiness;
  reasonCode: string | null;
  accountRevision: number;
  manifestDigest: string | null;
  acknowledgedAt: number;
}

export interface CapabilityItemView {
  id: string;
  kind: CapabilityKind;
  name: string;
  lifecycleState: CapabilityLifecycleState;
  activeVersionId: string | null;
  revision: number;
  tombstonedAt: number | null;
  removedAt: number | null;
  createdAt: number;
  updatedAt: number;
  activeVersion: CapabilityVersionView | null;
  versions: CapabilityVersionView[];
  bindings: CapabilityBindingView[];
  readiness: CapabilityReadinessView[];
}

export interface CapabilityEvidenceView {
  id: string;
  kind: 'scan' | 'audit';
  evidenceDigest: string;
  artifactDigest: string;
  policyVersion: string;
  verdict: CapabilityAuditVerdict | null;
  findings: unknown[];
  createdAt: number;
}

export interface CapabilityConfirmationView {
  id: string;
  operationRevision: number;
  decision: CapabilityConfirmationDecision;
  artifactDigest: string;
  auditDigest: string;
  targetSummary: Record<string, unknown>;
  createdAt: number;
}

export interface CapabilityOperationView {
  id: string;
  itemId: string | null;
  kind: 'install' | 'manage';
  state: CapabilityInstallState;
  requestSummary: Record<string, unknown>;
  artifactDigest: string | null;
  auditDigest: string | null;
  errorCode: CapabilityErrorCode | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  evidence: CapabilityEvidenceView[];
  confirmation: CapabilityConfirmationView | null;
}

interface CapabilityItemRow {
  id: string;
  kind: CapabilityKind;
  name: string;
  lifecycle_state: CapabilityLifecycleState;
  active_version_id: string | null;
  revision: number;
  tombstoned_at: number | null;
  removed_at: number | null;
  created_at: number;
  updated_at: number;
}

interface CapabilityVersionRow {
  id: string;
  version_number: number;
  artifact_digest: string;
  blob_digest: string | null;
  blob_byte_size: number | null;
  audit_digest: string;
  source_kind: string;
  source_summary: string;
  manifest: Record<string, unknown>;
  definition: Record<string, unknown> | null;
  permission_summary: unknown[];
  publication_state: 'pending' | 'active' | 'failed';
  created_at: number;
}

interface CapabilityBindingRow {
  id: string;
  version_id: string;
  scope: CapabilityScope;
  project_key: string | null;
  session_key: string | null;
  server_id: string | null;
  provider_filter: string[];
  machine_filter: string[];
  authorization_envelope: CapabilitySkillAuthorizationEnvelope | null;
  authority_state: CapabilityAuthorityState;
  enabled: boolean;
  revision: number;
  updated_at: number;
}

interface CapabilityReadinessRow {
  server_id: string;
  readiness_state: CapabilityReadiness;
  reason_code: string | null;
  account_revision: number;
  manifest_digest: string | null;
  acknowledged_at: number;
}

interface CapabilityOperationRow {
  id: string;
  item_id: string | null;
  operation_kind: 'install' | 'manage';
  state: CapabilityInstallState;
  request_summary: Record<string, unknown>;
  artifact_digest: string | null;
  audit_digest: string | null;
  error_code: CapabilityErrorCode | null;
  revision: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface CapabilityEvidenceRow {
  id: string;
  evidence_kind: 'scan' | 'audit';
  evidence_digest: string;
  artifact_digest: string;
  policy_version: string;
  verdict: CapabilityAuditVerdict | null;
  findings: unknown[];
  created_at: number;
}

interface CapabilityConfirmationRow {
  id: string;
  operation_revision: number;
  decision: CapabilityConfirmationDecision;
  artifact_digest: string;
  audit_digest: string;
  target_summary: Record<string, unknown>;
  created_at: number;
}

function toVersion(row: CapabilityVersionRow): CapabilityVersionView {
  return {
    id: row.id,
    versionNumber: row.version_number,
    artifactDigest: row.artifact_digest,
    blobDigest: row.blob_digest,
    blobByteSize: row.blob_byte_size,
    auditDigest: row.audit_digest,
    sourceKind: row.source_kind,
    sourceSummary: row.source_summary,
    manifest: row.manifest,
    definition: row.definition,
    permissionSummary: row.permission_summary,
    publicationState: row.publication_state,
    createdAt: row.created_at,
  };
}

function toBinding(row: CapabilityBindingRow): CapabilityBindingView {
  return {
    id: row.id,
    versionId: row.version_id,
    scope: row.scope,
    projectKey: row.project_key,
    sessionKey: row.session_key,
    serverId: row.server_id,
    providerFilter: row.provider_filter,
    machineFilter: row.machine_filter,
    authorization: row.authorization_envelope,
    authorityState: row.authority_state,
    enabled: row.enabled,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

function toReadiness(row: CapabilityReadinessRow): CapabilityReadinessView {
  return {
    serverId: row.server_id,
    state: row.readiness_state,
    reasonCode: row.reason_code,
    accountRevision: row.account_revision,
    manifestDigest: row.manifest_digest,
    acknowledgedAt: row.acknowledged_at,
  };
}

function toEvidence(row: CapabilityEvidenceRow): CapabilityEvidenceView {
  return {
    id: row.id,
    kind: row.evidence_kind,
    evidenceDigest: row.evidence_digest,
    artifactDigest: row.artifact_digest,
    policyVersion: row.policy_version,
    verdict: row.verdict,
    findings: row.findings,
    createdAt: row.created_at,
  };
}

function toConfirmation(row: CapabilityConfirmationRow): CapabilityConfirmationView {
  return {
    id: row.id,
    operationRevision: row.operation_revision,
    decision: row.decision,
    artifactDigest: row.artifact_digest,
    auditDigest: row.audit_digest,
    targetSummary: row.target_summary,
    createdAt: row.created_at,
  };
}

async function hydrateItem(
  db: Database,
  ownerUserId: string,
  row: CapabilityItemRow,
  versionLimit = 64,
): Promise<CapabilityItemView> {
  // Keep these sequential: Database may wrap a single pg transaction client,
  // and concurrent client.query() calls are deprecated/unsafe in pg.
  const versionRow = row.active_version_id
    ? await db.queryOne<CapabilityVersionRow>(`
        SELECT id, version_number, artifact_digest, blob_digest, blob_byte_size,
               audit_digest, source_kind,
               source_summary, manifest, definition, permission_summary,
               publication_state, created_at
        FROM capability_versions
        WHERE owner_user_id = $1 AND item_id = $2 AND id = $3
          AND publication_state = 'active'
      `, [ownerUserId, row.id, row.active_version_id])
    : null;
  const bindingRows = await db.query<CapabilityBindingRow>(`
    SELECT id, version_id, scope, project_key, session_key, server_id,
           provider_filter, machine_filter, authorization_envelope, authority_state,
           enabled, revision, updated_at
    FROM capability_bindings
    WHERE owner_user_id = $1 AND item_id = $2
    ORDER BY updated_at DESC, id
  `, [ownerUserId, row.id]);
  const readinessRows = await db.query<CapabilityReadinessRow>(`
    SELECT server_id, readiness_state, reason_code, account_revision,
           manifest_digest, acknowledged_at
    FROM capability_machine_readiness
    WHERE owner_user_id = $1 AND item_id = $2
    ORDER BY server_id
  `, [ownerUserId, row.id]);
  const versionRows = await db.query<CapabilityVersionRow>(`
    SELECT id, version_number, artifact_digest, blob_digest, blob_byte_size,
           audit_digest, source_kind,
           source_summary, manifest, definition, permission_summary,
           publication_state, created_at
    FROM capability_versions
    WHERE owner_user_id = $1 AND item_id = $2 AND publication_state = 'active'
    ORDER BY version_number DESC, created_at DESC, id
    LIMIT $3
  `, [ownerUserId, row.id, versionLimit]);
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    lifecycleState: row.lifecycle_state,
    activeVersionId: row.active_version_id,
    revision: row.revision,
    tombstonedAt: row.tombstoned_at,
    removedAt: row.removed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activeVersion: versionRow ? toVersion(versionRow) : null,
    versions: versionRows.map(toVersion),
    bindings: bindingRows.map(toBinding),
    readiness: readinessRows.map(toReadiness),
  };
}

const ITEM_COLUMNS = `
  id, kind, name, lifecycle_state, active_version_id, revision,
  tombstoned_at, removed_at, created_at, updated_at
`;

const BINDING_COLUMNS = `
  id, version_id, scope, project_key, session_key, server_id,
  provider_filter, machine_filter, authorization_envelope, authority_state,
  enabled, revision, updated_at
`;

export async function listCapabilities(
  db: Database,
  params: {
    ownerUserId: string;
    limit: number;
    cursor?: { updatedAt: number; id: string };
    includeRemoved?: boolean;
    kind?: CapabilityKind;
    state?: CapabilityLifecycleState;
    scope?: CapabilityScope;
    query?: string;
  },
): Promise<{ items: CapabilityItemView[]; nextCursor: { updatedAt: number; id: string } | null }> {
  const normalizedQuery = params.query?.trim().toLocaleLowerCase() || null;
  const values: unknown[] = [
    params.ownerUserId,
    params.limit + 1,
    params.kind ?? null,
    params.state ?? null,
    params.scope ?? null,
    normalizedQuery ? `%${normalizedQuery}%` : null,
    params.cursor?.updatedAt ?? null,
    params.cursor?.id ?? null,
  ];
  // A new synchronized Skill candidate exists only so the source daemon can
  // upload reviewed bytes. It is not user-visible authority until the blob
  // transaction publishes it.
  const removedClause = params.includeRemoved
    ? ` AND lifecycle_state <> 'pending'`
    : ` AND lifecycle_state NOT IN ('pending', 'removed')`;
  const rows = await db.query<CapabilityItemRow>(`
    SELECT ${ITEM_COLUMNS}
    FROM capability_items ci
    WHERE owner_user_id = $1${removedClause}
      AND ($3::text IS NULL OR ci.kind = $3)
      AND ($4::text IS NULL OR ci.lifecycle_state = $4)
      AND ($5::text IS NULL OR EXISTS (
        SELECT 1 FROM capability_bindings cb
        WHERE cb.owner_user_id = ci.owner_user_id AND cb.item_id = ci.id AND cb.scope = $5
      ))
      AND ($6::text IS NULL OR lower(ci.name) LIKE $6 OR EXISTS (
        SELECT 1 FROM capability_versions cv
        WHERE cv.owner_user_id = ci.owner_user_id AND cv.item_id = ci.id
          AND lower(cv.source_summary) LIKE $6
      ))
      AND ($7::bigint IS NULL OR (ci.updated_at, ci.id) < ($7, $8))
    ORDER BY ci.updated_at DESC, ci.id DESC
    LIMIT $2
  `, values);
  const pageRows = rows.slice(0, params.limit);
  const items: CapabilityItemView[] = [];
  for (const row of pageRows) items.push(await hydrateItem(db, params.ownerUserId, row));
  const last = rows.length > params.limit ? pageRows.at(-1) : undefined;
  return { items, nextCursor: last ? { updatedAt: last.updated_at, id: last.id } : null };
}

export async function getCapability(
  db: Database,
  params: { ownerUserId: string; itemId: string },
): Promise<CapabilityItemView | null> {
  const row = await db.queryOne<CapabilityItemRow>(`
    SELECT ${ITEM_COLUMNS}
    FROM capability_items
    WHERE owner_user_id = $1 AND id = $2
  `, [params.ownerUserId, params.itemId]);
  return row ? hydrateItem(db, params.ownerUserId, row) : null;
}

export async function createInstallOperation(
  db: Database,
  params: { ownerUserId: string; idempotencyKey: string; requestSummary: Record<string, unknown>; now?: number },
): Promise<{ operation: CapabilityOperationView; created: boolean }> {
  const now = params.now ?? Date.now();
  return db.transaction(async (tx) => {
    await tx.queryOne('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      JSON.stringify([params.ownerUserId, params.idempotencyKey]),
    ]);
    const existing = await tx.queryOne<CapabilityOperationRow>(`
      SELECT id, item_id, operation_kind, state, request_summary, artifact_digest,
             audit_digest, error_code, revision, created_at, updated_at, completed_at
      FROM capability_operations
      WHERE owner_user_id = $1 AND idempotency_key = $2
    `, [params.ownerUserId, params.idempotencyKey]);
    if (existing) return { operation: await hydrateOperation(tx, params.ownerUserId, existing), created: false };

    const row = await tx.queryOne<CapabilityOperationRow>(`
      INSERT INTO capability_operations (
        id, owner_user_id, operation_kind, idempotency_key, state,
        request_summary, revision, created_at, updated_at
      ) VALUES ($1, $2, 'install', $3, 'queued', $4, 1, $5, $5)
      RETURNING id, item_id, operation_kind, state, request_summary, artifact_digest,
                audit_digest, error_code, revision, created_at, updated_at, completed_at
    `, [randomUUID(), params.ownerUserId, params.idempotencyKey, params.requestSummary, now]);
    if (!row) throw new Error('capability_operation_insert_failed');
    await insertAuditEvent(tx, {
      ownerUserId: params.ownerUserId,
      operationId: row.id,
      action: 'install_intake',
      outcome: CAPABILITY_INSTALL_STATE.QUEUED,
      actorKind: 'owner',
      metadata: { sourceKind: params.requestSummary.sourceKind ?? null },
      now,
    });
    return { operation: await hydrateOperation(tx, params.ownerUserId, row), created: true };
  });
}

async function hydrateOperation(
  db: Database,
  ownerUserId: string,
  row: CapabilityOperationRow,
): Promise<CapabilityOperationView> {
  const evidenceRows = await db.query<CapabilityEvidenceRow>(`
    SELECT id, evidence_kind, evidence_digest, artifact_digest, policy_version,
           verdict, findings, created_at
    FROM capability_evidence
    WHERE owner_user_id = $1 AND operation_id = $2
    ORDER BY created_at, id
  `, [ownerUserId, row.id]);
  const confirmationRow = await db.queryOne<CapabilityConfirmationRow>(`
    SELECT id, operation_revision, decision, artifact_digest, audit_digest,
           target_summary, created_at
    FROM capability_confirmations
    WHERE owner_user_id = $1 AND operation_id = $2
    ORDER BY operation_revision DESC
    LIMIT 1
  `, [ownerUserId, row.id]);
  return {
    id: row.id,
    itemId: row.item_id,
    kind: row.operation_kind,
    state: row.state,
    requestSummary: row.request_summary,
    artifactDigest: row.artifact_digest,
    auditDigest: row.audit_digest,
    errorCode: row.error_code,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    evidence: evidenceRows.map(toEvidence),
    confirmation: confirmationRow ? toConfirmation(confirmationRow) : null,
  };
}

export async function getCapabilityOperation(
  db: Database,
  params: { ownerUserId: string; operationId: string },
): Promise<CapabilityOperationView | null> {
  const row = await db.queryOne<CapabilityOperationRow>(`
    SELECT id, item_id, operation_kind, state, request_summary, artifact_digest,
           audit_digest, error_code, revision, created_at, updated_at, completed_at
    FROM capability_operations
    WHERE owner_user_id = $1 AND id = $2
  `, [params.ownerUserId, params.operationId]);
  return row ? hydrateOperation(db, params.ownerUserId, row) : null;
}

export async function listRecentCapabilityOperations(
  db: Database,
  params: {
    ownerUserId: string;
    activeLimit: number;
    terminalLimit: number;
  },
): Promise<CapabilityOperationView[]> {
  const terminalStates: CapabilityInstallState[] = [
    CAPABILITY_INSTALL_STATE.INSTALLED,
    CAPABILITY_INSTALL_STATE.REWORK,
    CAPABILITY_INSTALL_STATE.FAILED,
    CAPABILITY_INSTALL_STATE.CANCELLED,
  ];
  const operationColumns = `
    id, item_id, operation_kind, state, request_summary, artifact_digest,
    audit_digest, error_code, revision, created_at, updated_at, completed_at
  `;
  const activeRows = await db.query<CapabilityOperationRow>(`
    SELECT ${operationColumns}
    FROM capability_operations
    WHERE owner_user_id = $1 AND NOT (state = ANY($2::text[]))
    ORDER BY updated_at DESC, id DESC
    LIMIT $3
  `, [params.ownerUserId, terminalStates, params.activeLimit]);
  const terminalRows = await db.query<CapabilityOperationRow>(`
    SELECT ${operationColumns}
    FROM capability_operations
    WHERE owner_user_id = $1 AND state = ANY($2::text[])
    ORDER BY updated_at DESC, id DESC
    LIMIT $3
  `, [params.ownerUserId, terminalStates, params.terminalLimit]);
  const operations: CapabilityOperationView[] = [];
  for (const row of [...activeRows, ...terminalRows]) {
    operations.push(await hydrateOperation(db, params.ownerUserId, row));
  }
  return operations;
}

export async function failCapabilityOperationsForDisconnectedServer(
  db: Database,
  params: { ownerUserId: string; serverId: string; now?: number },
): Promise<CapabilityOperationView[]> {
  const now = params.now ?? Date.now();
  return db.transaction(async (tx) => {
    const rows = await tx.query<CapabilityOperationRow>(`
      UPDATE capability_operations
      SET state = 'failed', error_code = 'runtime_pending', revision = revision + 1,
          updated_at = $3, completed_at = $3
      WHERE owner_user_id = $1
        AND request_summary->>'targetServerId' = $2
        AND state IN (
          'queued', 'acquiring', 'scanning', 'auditing'
        )
      RETURNING id, item_id, operation_kind, state, request_summary, artifact_digest,
                audit_digest, error_code, revision, created_at, updated_at, completed_at
    `, [params.ownerUserId, params.serverId, now]);
    const operations: CapabilityOperationView[] = [];
    for (const row of rows) {
      await discardPendingCapabilityActivation(tx, {
        ownerUserId: params.ownerUserId,
        operationId: row.id,
        now,
      });
      await insertAuditEvent(tx, {
        ownerUserId: params.ownerUserId,
        operationId: row.id,
        action: 'daemon_disconnect',
        outcome: CAPABILITY_INSTALL_STATE.FAILED,
        actorKind: 'system',
        metadata: { serverId: params.serverId, errorCode: CAPABILITY_ERROR.RUNTIME_PENDING },
        now,
      });
      operations.push(await hydrateOperation(tx, params.ownerUserId, row));
    }
    return operations;
  });
}

/**
 * Expires the durable pre-ACTIVATE commit window. INSTALLING deliberately
 * survives a socket disconnect because the daemon may already have persisted
 * its candidate and must be able to replay ACTIVATE after reconnect. This
 * bounded sweep is the terminal authority when that replay never arrives.
 */
export async function expireCapabilityPreActivationOperations(
  db: Database,
  params: { ownerUserId: string; serverId: string; now?: number; limit?: number },
): Promise<CapabilityOperationView[]> {
  const now = params.now ?? Date.now();
  return db.transaction(async (tx) => {
    const rows = await tx.query<CapabilityOperationRow>(`
      UPDATE capability_operations
      SET state = 'failed', error_code = 'runtime_pending', revision = revision + 1,
          updated_at = $3, completed_at = $3
      WHERE id IN (
        SELECT id
        FROM capability_operations
        WHERE owner_user_id = $1
          AND request_summary->>'targetServerId' = $2
          AND state IN ('awaiting_confirmation', 'installing')
          AND CASE
            WHEN state = 'installing'
              AND request_summary->>'commitExpiresAt' ~ '^[0-9]{1,16}$'
              THEN (request_summary->>'commitExpiresAt')::bigint
            ELSE updated_at + $4
          END <= $3
        ORDER BY updated_at, id
        LIMIT $5
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, item_id, operation_kind, state, request_summary, artifact_digest,
                audit_digest, error_code, revision, created_at, updated_at, completed_at
    `, [
      params.ownerUserId,
      params.serverId,
      now,
      CAPABILITY_LIMITS.PERSISTED_CANDIDATE_TTL_MS,
      params.limit ?? CAPABILITY_LIMITS.LIST_MAX,
    ]);
    const operations: CapabilityOperationView[] = [];
    for (const row of rows) {
      await insertAuditEvent(tx, {
        ownerUserId: params.ownerUserId,
        operationId: row.id,
        action: 'install_pre_activation_expired',
        outcome: CAPABILITY_INSTALL_STATE.FAILED,
        actorKind: 'system',
        metadata: { serverId: params.serverId, errorCode: CAPABILITY_ERROR.RUNTIME_PENDING },
        now,
      });
      operations.push(await hydrateOperation(tx, params.ownerUserId, row));
    }
    return operations;
  });
}

/** Cross-pod-safe periodic backstop for daemons that never reconnect. */
export async function sweepExpiredCapabilityPreActivationOperations(
  db: Database,
  params: { now?: number; groupLimit?: number } = {},
): Promise<number> {
  const now = params.now ?? Date.now();
  const groups = await db.query<{ owner_user_id: string; target_server_id: string }>(`
    SELECT owner_user_id, request_summary->>'targetServerId' AS target_server_id
    FROM capability_operations
    WHERE state IN ('awaiting_confirmation', 'installing')
      AND request_summary->>'targetServerId' IS NOT NULL
      AND CASE
        WHEN state = 'installing'
          AND request_summary->>'commitExpiresAt' ~ '^[0-9]{1,16}$'
          THEN (request_summary->>'commitExpiresAt')::bigint
        ELSE updated_at + $1
      END <= $2
    GROUP BY owner_user_id, request_summary->>'targetServerId'
    ORDER BY owner_user_id, request_summary->>'targetServerId'
    LIMIT $3
  `, [
    CAPABILITY_LIMITS.PERSISTED_CANDIDATE_TTL_MS,
    now,
    params.groupLimit ?? CAPABILITY_LIMITS.LIST_MAX,
  ]);
  let expired = 0;
  for (const group of groups) {
    expired += (await expireCapabilityPreActivationOperations(db, {
      ownerUserId: group.owner_user_id,
      serverId: group.target_server_id,
      now,
    })).length;
  }
  return expired;
}

async function discardPendingCapabilityActivation(
  db: Database,
  params: { ownerUserId: string; operationId: string; now: number },
): Promise<void> {
  const pending = await db.queryOne<{
    item_id: string;
    version_id: string;
    created_item: boolean;
  }>(`
    DELETE FROM capability_pending_activations
    WHERE owner_user_id = $1 AND operation_id = $2
    RETURNING item_id, version_id, created_item
  `, [params.ownerUserId, params.operationId]);
  if (!pending) return;
  if (pending.created_item) {
    await db.execute(`
      DELETE FROM capability_items
      WHERE owner_user_id = $1 AND id = $2 AND lifecycle_state = 'pending'
        AND active_version_id IS NULL
    `, [params.ownerUserId, pending.item_id]);
  } else {
    await db.execute(`
      UPDATE capability_versions
      SET publication_state = 'failed'
      WHERE owner_user_id = $1 AND item_id = $2 AND id = $3
        AND publication_state = 'pending'
    `, [params.ownerUserId, pending.item_id, pending.version_id]);
  }
}

/**
 * Compact fully removed synchronized history only after its recoverability
 * tombstone expires.  Local bindings keep an item alive, and audit/operation
 * rows retain their content-safe history with a null item reference.
 */
async function compactExpiredSynchronizedCapabilityHistory(
  db: Database,
  ownerUserId: string,
  now: number,
): Promise<number> {
  const rows = await db.query<{ item_id: string }>(`
    SELECT ct.item_id
    FROM capability_tombstones ct
    WHERE ct.owner_user_id = $1 AND ct.scope <> 'local' AND ct.expires_at <= $2
      AND NOT EXISTS (
        SELECT 1 FROM capability_bindings cb
        WHERE cb.owner_user_id = ct.owner_user_id AND cb.item_id = ct.item_id
          AND (cb.scope = 'local' OR cb.enabled = TRUE OR cb.authority_state <> 'removed')
      )
      AND NOT EXISTS (
        SELECT 1 FROM capability_pending_activations pa
        WHERE pa.owner_user_id = ct.owner_user_id AND pa.item_id = ct.item_id
      )
    ORDER BY ct.item_id
    LIMIT $3
    FOR UPDATE OF ct SKIP LOCKED
  `, [ownerUserId, now, CAPABILITY_LIMITS.SYNC_ITEMS]);
  const itemIds = [...new Set(rows.map((row) => row.item_id))];
  if (itemIds.length === 0) return 0;
  await db.execute(`
    UPDATE capability_operations SET item_id = NULL
    WHERE owner_user_id = $1 AND item_id = ANY($2::text[])
  `, [ownerUserId, itemIds]);
  await db.execute(`
    UPDATE capability_audit_events SET item_id = NULL
    WHERE owner_user_id = $1 AND item_id = ANY($2::text[])
  `, [ownerUserId, itemIds]);
  await db.execute(`
    DELETE FROM capability_items
    WHERE owner_user_id = $1 AND id = ANY($2::text[])
  `, [ownerUserId, itemIds]);
  await db.execute(`
    DELETE FROM capability_blobs cb
    WHERE cb.owner_user_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM capability_versions cv
        WHERE cv.owner_user_id = cb.owner_user_id AND cv.blob_digest = cb.digest
      )
  `, [ownerUserId]);
  await nextAccountRevision(db, ownerUserId, now);
  return itemIds.length;
}

/** Cross-pod-safe retention sweep; account revision fan-out occurs on the next heartbeat. */
export async function sweepExpiredCapabilityHistory(
  db: Database,
  params: { now?: number; ownerLimit?: number } = {},
): Promise<number> {
  const now = params.now ?? Date.now();
  const owners = await db.query<{ owner_user_id: string }>(`
    SELECT DISTINCT owner_user_id
    FROM capability_tombstones
    WHERE scope <> 'local' AND expires_at <= $1
    ORDER BY owner_user_id
    LIMIT $2
  `, [now, params.ownerLimit ?? CAPABILITY_LIMITS.LIST_MAX]);
  let compacted = 0;
  for (const owner of owners) {
    compacted += await db.transaction(async (tx) => {
      await tx.queryOne(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `capability-sync-quota:${owner.owner_user_id}`,
      ]);
      return compactExpiredSynchronizedCapabilityHistory(tx, owner.owner_user_id, now);
    });
  }
  return compacted;
}

export async function failCapabilityPendingActivation(
  db: Database,
  params: {
    ownerUserId: string;
    operationId: string;
    errorCode: CapabilityErrorCode;
    expectedRevision?: number;
    capabilityId?: string;
    versionId?: string;
    bindingId?: string;
    authorityRevision?: number;
    targetServerId?: string;
    now?: number;
  },
): Promise<CapabilityOperationView | null> {
  const now = params.now ?? Date.now();
  return db.transaction(async (tx) => {
    const pending = await tx.queryOne<{
      item_id: string;
      version_id: string;
      binding_id: string;
      authority_item_revision: number;
      operation_revision: number;
      request_summary: Record<string, unknown>;
    }>(`
      SELECT pa.item_id, pa.version_id, pa.binding_id, pa.authority_item_revision,
             co.revision AS operation_revision, co.request_summary
      FROM capability_pending_activations pa
      JOIN capability_operations co
        ON co.owner_user_id = pa.owner_user_id AND co.id = pa.operation_id
      WHERE pa.owner_user_id = $1 AND pa.operation_id = $2
        AND co.state = 'syncing'
      FOR UPDATE OF pa, co
    `, [params.ownerUserId, params.operationId]);
    if (!pending
      || (params.expectedRevision !== undefined && pending.operation_revision !== params.expectedRevision)
      || (params.capabilityId !== undefined && pending.item_id !== params.capabilityId)
      || (params.versionId !== undefined && pending.version_id !== params.versionId)
      || (params.bindingId !== undefined && pending.binding_id !== params.bindingId)
      || (params.authorityRevision !== undefined
        && pending.authority_item_revision !== params.authorityRevision)
      || (params.targetServerId !== undefined
        && pending.request_summary.targetServerId !== params.targetServerId)) return null;
    const updated = await tx.queryOne<CapabilityOperationRow>(`
      UPDATE capability_operations
      SET state = 'failed', error_code = $3, revision = revision + 1,
          updated_at = $4, completed_at = $4
      WHERE owner_user_id = $1 AND id = $2 AND state = 'syncing'
        AND revision = $5
      RETURNING id, item_id, operation_kind, state, request_summary, artifact_digest,
                audit_digest, error_code, revision, created_at, updated_at, completed_at
    `, [params.ownerUserId, params.operationId, params.errorCode, now, pending.operation_revision]);
    if (!updated) return null;
    await discardPendingCapabilityActivation(tx, {
      ownerUserId: params.ownerUserId,
      operationId: params.operationId,
      now,
    });
    await insertAuditEvent(tx, {
      ownerUserId: params.ownerUserId,
      operationId: params.operationId,
      action: 'install_blob_failed',
      outcome: CAPABILITY_INSTALL_STATE.FAILED,
      actorKind: 'system',
      metadata: { errorCode: params.errorCode },
      now,
    });
    return getCapabilityOperation(tx, {
      ownerUserId: params.ownerUserId,
      operationId: params.operationId,
    });
  });
}

export async function failCapabilityPendingActivationByVersion(
  db: Database,
  params: {
    ownerUserId: string;
    capabilityId: string;
    versionId: string;
    errorCode: CapabilityErrorCode;
    now?: number;
  },
): Promise<CapabilityOperationView | null> {
  const row = await db.queryOne<{ operation_id: string }>(`
    SELECT operation_id
    FROM capability_pending_activations
    WHERE owner_user_id = $1 AND item_id = $2 AND version_id = $3
  `, [params.ownerUserId, params.capabilityId, params.versionId]);
  return row ? failCapabilityPendingActivation(db, {
    ownerUserId: params.ownerUserId,
    operationId: row.operation_id,
    errorCode: params.errorCode,
    now: params.now,
  }) : null;
}

/**
 * Fails bounded installation candidates that can no longer be committed.
 * Existing active authority is untouched; only the unpublished version/new
 * pending item is discarded. Safe to run from polling and reconnect paths.
 */
export async function expireCapabilityPendingActivations(
  db: Database,
  params: { ownerUserId?: string; targetServerId?: string; now?: number; limit?: number } = {},
): Promise<Array<{
  operation: CapabilityOperationView;
  targetServerId: string;
  capabilityId: string;
  versionId: string;
  bindingId: string;
  authorityRevision: number;
}>> {
  const now = params.now ?? Date.now();
  return db.transaction(async (tx) => {
    const expired = await tx.query<{
      operation_id: string;
      owner_user_id: string;
      operation_revision: number;
      item_id: string;
      version_id: string;
      binding_id: string;
      authority_item_revision: number;
      request_summary: Record<string, unknown>;
    }>(`
      SELECT pa.operation_id, pa.owner_user_id, co.revision AS operation_revision,
             pa.item_id, pa.version_id, pa.binding_id, pa.authority_item_revision,
             co.request_summary
      FROM capability_pending_activations pa
      JOIN capability_operations co
        ON co.owner_user_id = pa.owner_user_id AND co.id = pa.operation_id
      WHERE pa.expires_at <= $1 AND co.state = 'syncing'
        AND ($2::text IS NULL OR pa.owner_user_id = $2)
        AND ($3::text IS NULL OR co.request_summary->>'targetServerId' = $3)
      ORDER BY pa.expires_at, pa.operation_id
      LIMIT $4
      FOR UPDATE OF pa, co SKIP LOCKED
    `, [now, params.ownerUserId ?? null, params.targetServerId ?? null, params.limit ?? CAPABILITY_LIMITS.LIST_MAX]);
    const failed: Array<{
      operation: CapabilityOperationView;
      targetServerId: string;
      capabilityId: string;
      versionId: string;
      bindingId: string;
      authorityRevision: number;
    }> = [];
    for (const entry of expired) {
      const updated = await tx.queryOne<CapabilityOperationRow>(`
        UPDATE capability_operations
        SET state = 'failed', error_code = $4, revision = revision + 1,
            updated_at = $5, completed_at = $5
        WHERE owner_user_id = $1 AND id = $2 AND revision = $3
          AND state = 'syncing'
        RETURNING id, item_id, operation_kind, state, request_summary, artifact_digest,
                  audit_digest, error_code, revision, created_at, updated_at, completed_at
      `, [
        entry.owner_user_id,
        entry.operation_id,
        entry.operation_revision,
        CAPABILITY_ERROR.RUNTIME_PENDING,
        now,
      ]);
      if (!updated) continue;
      await discardPendingCapabilityActivation(tx, {
        ownerUserId: entry.owner_user_id,
        operationId: entry.operation_id,
        now,
      });
      await insertAuditEvent(tx, {
        ownerUserId: entry.owner_user_id,
        operationId: entry.operation_id,
        action: 'install_candidate_expired',
        outcome: CAPABILITY_INSTALL_STATE.FAILED,
        actorKind: 'system',
        metadata: { errorCode: CAPABILITY_ERROR.RUNTIME_PENDING },
        now,
      });
      const targetServerId = typeof entry.request_summary.targetServerId === 'string'
        ? entry.request_summary.targetServerId
        : '';
      failed.push({
        operation: await hydrateOperation(tx, entry.owner_user_id, updated),
        targetServerId,
        capabilityId: entry.item_id,
        versionId: entry.version_id,
        bindingId: entry.binding_id,
        authorityRevision: entry.authority_item_revision,
      });
    }
    return failed;
  });
}

export async function updateCapabilityOperation(
  db: Database,
  params: {
    ownerUserId: string;
    operationId: string;
    expectedRevision: number;
    state: CapabilityInstallState;
    artifactDigest?: string | null;
    auditDigest?: string | null;
    errorCode?: CapabilityErrorCode | null;
    itemId?: string | null;
    requestSummaryPatch?: Record<string, unknown>;
    allowedCurrentStates?: CapabilityInstallState[];
    now?: number;
  },
): Promise<CapabilityOperationView | null> {
  const now = params.now ?? Date.now();
  const terminal = isCapabilityInstallTerminal(params.state);
  const row = await db.queryOne<CapabilityOperationRow>(`
    UPDATE capability_operations
    SET state = $4,
        artifact_digest = COALESCE($5, artifact_digest),
        audit_digest = COALESCE($6, audit_digest),
        error_code = $7,
        item_id = COALESCE($8, item_id),
        revision = revision + 1,
        updated_at = $9::bigint,
        completed_at = CASE WHEN $10::boolean THEN $9::bigint ELSE NULL END,
        request_summary = request_summary || $11::jsonb
    WHERE owner_user_id = $1 AND id = $2 AND revision = $3
      AND ($12::text[] IS NULL OR state = ANY($12::text[]))
    RETURNING id, item_id, operation_kind, state, request_summary, artifact_digest,
              audit_digest, error_code, revision, created_at, updated_at, completed_at
  `, [
    params.ownerUserId,
    params.operationId,
    params.expectedRevision,
    params.state,
    params.artifactDigest ?? null,
    params.auditDigest ?? null,
    params.errorCode ?? null,
    params.itemId ?? null,
    now,
    terminal,
    params.requestSummaryPatch ?? {},
    params.allowedCurrentStates ?? null,
  ]);
  return row ? hydrateOperation(db, params.ownerUserId, row) : null;
}

/** CAS the public operation state and persist its digest-bound evidence in one transaction. */
export async function advanceCapabilityOperation(
  db: Database,
  params: Parameters<typeof updateCapabilityOperation>[1] & {
    evidence?: {
      kind: 'scan' | 'audit';
      evidenceDigest: string;
      artifactDigest: string;
      policyVersion: string;
      verdict?: CapabilityAuditVerdict | null;
      findings: unknown[];
    };
  },
): Promise<CapabilityOperationView | null> {
  return db.transaction(async (tx) => {
    const updated = await updateCapabilityOperation(tx, params);
    if (!updated) return null;
    if (params.evidence) {
      await recordCapabilityEvidence(tx, {
        ownerUserId: params.ownerUserId,
        operationId: params.operationId,
        ...params.evidence,
      });
    }
    return getCapabilityOperation(tx, {
      ownerUserId: params.ownerUserId,
      operationId: params.operationId,
    });
  });
}

export async function recordCapabilityEvidence(
  db: Database,
  params: {
    ownerUserId: string;
    operationId: string;
    kind: 'scan' | 'audit';
    evidenceDigest: string;
    artifactDigest: string;
    policyVersion: string;
    verdict?: CapabilityAuditVerdict | null;
    findings: unknown[];
    now?: number;
  },
): Promise<CapabilityEvidenceView> {
  const row = await db.queryOne<CapabilityEvidenceRow>(`
    INSERT INTO capability_evidence (
      id, owner_user_id, operation_id, evidence_kind, evidence_digest,
      artifact_digest, policy_version, verdict, findings, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (operation_id, evidence_kind, evidence_digest)
    DO UPDATE SET findings = EXCLUDED.findings
    RETURNING id, evidence_kind, evidence_digest, artifact_digest, policy_version,
              verdict, findings, created_at
  `, [
    randomUUID(),
    params.ownerUserId,
    params.operationId,
    params.kind,
    params.evidenceDigest,
    params.artifactDigest,
    params.policyVersion,
    params.verdict ?? null,
    JSON.stringify(params.findings),
    params.now ?? Date.now(),
  ]);
  if (!row) throw new Error('capability_evidence_insert_failed');
  return toEvidence(row);
}

export type ConfirmCapabilityResult =
  | { status: 'ok'; operation: CapabilityOperationView }
  | { status: 'not_found' | 'stale' | 'invalid_state' };

export async function confirmCapabilityOperation(
  db: Database,
  params: {
    ownerUserId: string;
    operationId: string;
    expectedRevision: number;
    decision: 'install' | 'cancel';
    artifactDigest: string;
    auditDigest: string;
    targetSummary: Record<string, unknown>;
    now?: number;
  },
): Promise<ConfirmCapabilityResult> {
  const now = params.now ?? Date.now();
  const commitExpiresAt = Math.max(now, Date.now()) + CAPABILITY_LIMITS.PERSISTED_CANDIDATE_TTL_MS;
  return db.transaction(async (tx) => {
    const current = await tx.queryOne<CapabilityOperationRow>(`
      SELECT id, item_id, operation_kind, state, request_summary, artifact_digest,
             audit_digest, error_code, revision, created_at, updated_at, completed_at
      FROM capability_operations
      WHERE owner_user_id = $1 AND id = $2
      FOR UPDATE
    `, [params.ownerUserId, params.operationId]);
    if (!current) return { status: 'not_found' };
    if (current.revision !== params.expectedRevision
      || current.artifact_digest !== params.artifactDigest
      || current.audit_digest !== params.auditDigest) return { status: 'stale' };
    if (current.state !== CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION) return { status: 'invalid_state' };
    if (params.decision === CAPABILITY_CONFIRMATION_DECISION.INSTALL) {
      const passedAudit = await tx.queryOne<{ id: string }>(`
        SELECT id FROM capability_evidence
        WHERE owner_user_id = $1 AND operation_id = $2
          AND evidence_kind = 'audit' AND evidence_digest = $3
          AND artifact_digest = $4 AND verdict = 'PASS'
        LIMIT 1
      `, [params.ownerUserId, params.operationId, params.auditDigest, params.artifactDigest]);
      if (!passedAudit) return { status: 'invalid_state' };
    }

    const inserted = await tx.queryOne<{ id: string }>(`
      INSERT INTO capability_confirmations (
        id, owner_user_id, operation_id, operation_revision, decision,
        artifact_digest, audit_digest, target_summary, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (operation_id, operation_revision) DO NOTHING
      RETURNING id
    `, [
      randomUUID(), params.ownerUserId, params.operationId, params.expectedRevision,
      params.decision, params.artifactDigest, params.auditDigest, params.targetSummary, now,
    ]);
    if (!inserted) return { status: 'stale' };

    const nextState: CapabilityInstallState = params.decision === CAPABILITY_CONFIRMATION_DECISION.INSTALL
      ? CAPABILITY_INSTALL_STATE.INSTALLING
      : CAPABILITY_INSTALL_STATE.CANCELLED;
    const updated = await tx.queryOne<CapabilityOperationRow>(`
      UPDATE capability_operations
      SET state = $3, revision = revision + 1, updated_at = $4::bigint,
          completed_at = CASE WHEN $3 = 'cancelled' THEN $4::bigint ELSE NULL END,
          request_summary = CASE WHEN $3 = 'installing'
            THEN request_summary || jsonb_build_object('commitExpiresAt', $6::bigint)
            ELSE request_summary END
      WHERE owner_user_id = $1 AND id = $2 AND revision = $5
      RETURNING id, item_id, operation_kind, state, request_summary, artifact_digest,
                audit_digest, error_code, revision, created_at, updated_at, completed_at
    `, [
      params.ownerUserId,
      params.operationId,
      nextState,
      now,
      params.expectedRevision,
      commitExpiresAt,
    ]);
    if (!updated) throw new Error('capability_confirmation_update_failed');
    await insertAuditEvent(tx, {
      ownerUserId: params.ownerUserId,
      operationId: params.operationId,
      action: 'install_confirmation',
      outcome: params.decision,
      actorKind: 'browser_owner',
      metadata: {
        operationRevision: params.expectedRevision,
        artifactDigest: params.artifactDigest,
        auditDigest: params.auditDigest,
      },
      now,
    });
    return { status: 'ok', operation: await hydrateOperation(tx, params.ownerUserId, updated) };
  });
}

export type CancelCapabilityOperationResult =
  | { status: 'ok'; operation: CapabilityOperationView }
  | { status: 'not_found' | 'stale' | 'terminal' | 'committing' };

/**
 * Authoritatively cancels non-terminal work using owner + revision locking.
 * Daemon cleanup is deliberately outside this transaction and best-effort, so
 * an offline machine can never prevent the owner from stopping an operation.
 */
export async function cancelCapabilityOperation(
  db: Database,
  params: { ownerUserId: string; operationId: string; expectedRevision: number; now?: number },
): Promise<CancelCapabilityOperationResult> {
  const now = params.now ?? Date.now();
  return db.transaction(async (tx) => {
    const current = await tx.queryOne<CapabilityOperationRow>(`
      SELECT id, item_id, operation_kind, state, request_summary, artifact_digest,
             audit_digest, error_code, revision, created_at, updated_at, completed_at
      FROM capability_operations
      WHERE owner_user_id = $1 AND id = $2
      FOR UPDATE
    `, [params.ownerUserId, params.operationId]);
    if (!current) return { status: 'not_found' };
    if (current.revision !== params.expectedRevision) return { status: 'stale' };
    // INSTALLING is entered transactionally before the CONFIRM frame is
    // dispatched. From this point the daemon may already be publishing the
    // reviewed bytes, so cancellation would permit an impossible
    // cancelled+installed split brain. SYNCING is the same commit lifecycle
    // after the daemon has accepted the authorization.
    if (isCapabilityInstallTerminal(current.state)) return { status: 'terminal' };
    if (!isCapabilityInstallCancellable(current.state)) return { status: 'committing' };
    const updated = await tx.queryOne<CapabilityOperationRow>(`
      UPDATE capability_operations
      SET state = 'cancelled', revision = revision + 1, updated_at = $4,
          completed_at = $4
      WHERE owner_user_id = $1 AND id = $2 AND revision = $3
      RETURNING id, item_id, operation_kind, state, request_summary, artifact_digest,
                audit_digest, error_code, revision, created_at, updated_at, completed_at
    `, [params.ownerUserId, params.operationId, params.expectedRevision, now]);
    if (!updated) return { status: 'stale' };
    await insertAuditEvent(tx, {
      ownerUserId: params.ownerUserId,
      operationId: params.operationId,
      action: 'cancel_operation',
      outcome: CAPABILITY_INSTALL_STATE.CANCELLED,
      actorKind: 'owner',
      metadata: { operationRevision: params.expectedRevision },
      now,
    });
    return { status: 'ok', operation: await hydrateOperation(tx, params.ownerUserId, updated) };
  });
}

async function nextAccountRevision(db: Database, ownerUserId: string, now: number): Promise<number> {
  const row = await db.queryOne<{ revision: number }>(`
    INSERT INTO capability_account_revisions (owner_user_id, revision, updated_at)
    VALUES ($1, 1, $2)
    ON CONFLICT (owner_user_id)
    DO UPDATE SET revision = capability_account_revisions.revision + 1, updated_at = EXCLUDED.updated_at
    RETURNING revision
  `, [ownerUserId, now]);
  if (!row) throw new Error('capability_revision_increment_failed');
  return row.revision;
}

export async function activateCapabilityVersion(
  db: Database,
  params: {
    ownerUserId: string;
    targetServerId: string;
    operationId: string;
    expectedOperationRevision: number;
    requestedItemId?: string;
    requestedBindingId?: string;
    name: string;
    kind: CapabilityKind;
    sourceKind: string;
    sourceSummary: string;
    artifactDigest: string;
    blobDigest?: string | null;
    blobByteSize?: number | null;
    auditDigest: string;
    manifest: Record<string, unknown>;
    definition?: unknown;
    permissionSummary: unknown[];
    scope: CapabilityScope;
    projectKey?: string | null;
    sessionKey?: string | null;
    serverId?: string | null;
    providerFilter?: string[];
    machineFilter?: string[];
    authorizationSigner: CapabilityAuthorizationSigner;
    now?: number;
  },
): Promise<{
  item: CapabilityItemView;
  accountRevision: number;
  pendingBlob: boolean;
  operation: CapabilityOperationView;
  candidate: {
    versionId: string;
    versionNumber: number;
    bindingId: string;
    authorityRevision: number;
    authorityBindingRevision: number;
    authorization: CapabilitySkillAuthorizationEnvelope | null;
  };
}> {
  const now = params.now ?? Date.now();
  const synchronizedSkill = params.kind === CAPABILITY_KIND.SKILL && params.scope !== CAPABILITY_SCOPE.LOCAL;
  const validBlobMetadata = typeof params.blobDigest === 'string'
    && /^[0-9a-f]{64}$/.test(params.blobDigest)
    && Number.isSafeInteger(params.blobByteSize)
    && (params.blobByteSize ?? 0) > 0
    && (params.blobByteSize ?? 0) <= 16 * 1024 * 1024;
  if ((synchronizedSkill && !validBlobMetadata)
    || (!synchronizedSkill && (params.blobDigest != null || params.blobByteSize != null))) {
    throw new Error('capability_activation_blob_policy');
  }
  const definitionRecord = params.definition && typeof params.definition === 'object' && !Array.isArray(params.definition)
    ? params.definition as Record<string, unknown>
    : null;
  const normalizedDefinition = params.kind === CAPABILITY_KIND.MCP && definitionRecord
    ? normalizeCapabilityMcpDefinition({
      kind: CAPABILITY_SOURCE_KIND.MCP_CONFIG,
      mcpConfig: definitionRecord,
    })
    : null;
  if ((params.kind === CAPABILITY_KIND.MCP && !normalizedDefinition)
    || (params.kind === CAPABILITY_KIND.SKILL && params.definition != null)) {
    throw new Error('capability_activation_definition_policy');
  }
  const versionRecordBytes = Buffer.byteLength(JSON.stringify({
    artifactDigest: params.artifactDigest,
    blobDigest: params.blobDigest ?? null,
    blobByteSize: params.blobByteSize ?? null,
    auditDigest: params.auditDigest,
    sourceKind: params.sourceKind,
    sourceSummary: params.sourceSummary,
    manifest: params.manifest,
    definition: normalizedDefinition,
    permissionSummary: params.permissionSummary,
  }), 'utf8');
  if (versionRecordBytes > CAPABILITY_LIMITS.PERSISTED_VERSION_RECORD_BYTES) {
    throw new Error('capability_version_record_too_large');
  }
  return db.transaction(async (tx) => {
    const operation = await tx.queryOne<CapabilityOperationRow>(`
      SELECT id, item_id, operation_kind, state, request_summary, artifact_digest,
             audit_digest, error_code, revision, created_at, updated_at, completed_at
      FROM capability_operations
      WHERE owner_user_id = $1 AND id = $2
      FOR UPDATE
    `, [params.ownerUserId, params.operationId]);
    if (operation?.state === CAPABILITY_INSTALL_STATE.SYNCING) {
      const replay = await tx.queryOne<PendingCapabilityAuthorizationRow & {
        version_number: number;
        version_artifact_digest: string;
        blob_digest: string | null;
        blob_byte_size: number | null;
        version_audit_digest: string;
        source_kind: string;
        source_summary: string;
        manifest: Record<string, unknown>;
        definition: Record<string, unknown> | null;
        permission_summary: unknown[];
      }>(`
        SELECT pa.operation_id, pa.item_id, pa.version_id, pa.binding_id, pa.scope,
               pa.project_key, pa.session_key, pa.server_id, pa.provider_filter,
               pa.machine_filter, pa.authorization_envelope, pa.authority_item_revision,
               pa.authority_binding_revision, pa.blob_ready, pa.expires_at,
               co.request_summary, co.revision AS operation_revision,
               cv.version_number, cv.artifact_digest AS version_artifact_digest,
               cv.blob_digest, cv.blob_byte_size, cv.audit_digest AS version_audit_digest,
               cv.source_kind, cv.source_summary, cv.manifest, cv.definition,
               cv.permission_summary
        FROM capability_pending_activations pa
        JOIN capability_operations co
          ON co.owner_user_id = pa.owner_user_id AND co.id = pa.operation_id
        JOIN capability_versions cv
          ON cv.owner_user_id = pa.owner_user_id
         AND cv.item_id = pa.item_id AND cv.id = pa.version_id
        WHERE pa.owner_user_id = $1 AND pa.operation_id = $2
          AND pa.expires_at > $3 AND cv.publication_state = 'pending'
        FOR UPDATE OF pa, cv
      `, [params.ownerUserId, params.operationId, now]);
      const item = operation.item_id
        ? await getCapability(tx, { ownerUserId: params.ownerUserId, itemId: operation.item_id })
        : null;
      const exactReplay = replay
        && item
        && operation.revision === params.expectedOperationRevision + 1
        && operation.artifact_digest === params.artifactDigest
        && operation.audit_digest === params.auditDigest
        && operation.request_summary.targetServerId === params.targetServerId
        && (typeof operation.request_summary.capabilityId !== 'string'
          || operation.request_summary.capabilityId === params.requestedItemId)
        && (typeof operation.request_summary.bindingId !== 'string'
          || operation.request_summary.bindingId === replay.binding_id)
        && item.id === replay.item_id
        && item.kind === params.kind
        && item.name === params.name
        && replay.version_artifact_digest === params.artifactDigest
        && replay.version_audit_digest === params.auditDigest
        && replay.blob_digest === (params.blobDigest ?? null)
        && replay.blob_byte_size === (params.blobByteSize ?? null)
        && replay.source_kind === params.sourceKind
        && replay.source_summary === params.sourceSummary
        && canonicalCapabilityJson(replay.manifest) === canonicalCapabilityJson(params.manifest)
        && canonicalCapabilityJson(replay.definition) === canonicalCapabilityJson(normalizedDefinition)
        && canonicalCapabilityJson(replay.permission_summary) === canonicalCapabilityJson(params.permissionSummary)
        && replay.scope === params.scope
        && replay.project_key === (params.projectKey ?? null)
        && replay.session_key === (params.sessionKey ?? null)
        && replay.server_id === (params.serverId ?? null)
        && canonicalCapabilityJson(replay.provider_filter)
          === canonicalCapabilityJson(normalizedStringSet(params.providerFilter))
        && canonicalCapabilityJson(replay.machine_filter)
          === canonicalCapabilityJson(normalizedStringSet(params.machineFilter));
      if (!exactReplay || !replay || !item) throw new Error('capability_activation_stale_operation');
      return {
        item,
        accountRevision: await currentAccountRevision(tx, params.ownerUserId),
        pendingBlob: synchronizedSkill && !replay.blob_ready,
        operation: await hydrateOperation(tx, params.ownerUserId, operation),
        candidate: {
          versionId: replay.version_id,
          versionNumber: replay.version_number,
          bindingId: replay.binding_id,
          authorityRevision: replay.authority_item_revision,
          authorityBindingRevision: replay.authority_binding_revision,
          authorization: replay.authorization_envelope,
        },
      };
    }
    if (!operation || operation.state !== CAPABILITY_INSTALL_STATE.INSTALLING
      || operation.revision !== params.expectedOperationRevision
      || operation.artifact_digest !== params.artifactDigest
      || operation.audit_digest !== params.auditDigest
      || operation.request_summary.targetServerId !== params.targetServerId) {
      throw new Error('capability_activation_stale_operation');
    }
    const explicitUpdateItemId = typeof operation.request_summary.capabilityId === 'string'
      && operation.request_summary.capabilityId.length > 0
      && operation.request_summary.capabilityId.length <= 128
      ? operation.request_summary.capabilityId
      : null;
    const explicitUpdateBindingId = typeof operation.request_summary.bindingId === 'string'
      && operation.request_summary.bindingId.length > 0
      && operation.request_summary.bindingId.length <= CAPABILITY_LIMITS.OPAQUE_ID_BYTES
      ? operation.request_summary.bindingId
      : null;
    if ((explicitUpdateItemId === null) !== (explicitUpdateBindingId === null)) {
      throw new Error('capability_activation_update_target_incomplete');
    }
    if (explicitUpdateBindingId && params.requestedBindingId !== explicitUpdateBindingId) {
      throw new Error('capability_activation_update_binding_mismatch');
    }
    if (explicitUpdateItemId && params.requestedItemId !== explicitUpdateItemId) {
      throw new Error('capability_activation_update_target_mismatch');
    }
    const confirmation = await tx.queryOne<{
      decision: CapabilityConfirmationDecision;
      artifact_digest: string;
      audit_digest: string;
      target_summary: Record<string, unknown>;
    }>(`
      SELECT decision, artifact_digest, audit_digest, target_summary
      FROM capability_confirmations
      WHERE owner_user_id = $1 AND operation_id = $2 AND operation_revision = $3
      LIMIT 1
    `, [params.ownerUserId, params.operationId, params.expectedOperationRevision - 1]);
    const requestedScope = confirmation?.target_summary.scope;
    const confirmedUpdateItemId = typeof confirmation?.target_summary.capabilityId === 'string'
      ? confirmation.target_summary.capabilityId
      : null;
    const confirmedUpdateBindingId = typeof confirmation?.target_summary.bindingId === 'string'
      ? confirmation.target_summary.bindingId
      : null;
    const requestedProviders = normalizedStringSet(confirmation?.target_summary.providers);
    const requestedMachines = normalizedStringSet(confirmation?.target_summary.machines);
    const requestedScopeId = typeof confirmation?.target_summary.scopeId === 'string'
      ? confirmation.target_summary.scopeId
      : null;
    const activatedScopeId = params.scope === CAPABILITY_SCOPE.PROJECT
      ? params.projectKey ?? null
      : params.scope === CAPABILITY_SCOPE.SESSION
        ? params.sessionKey ?? null
        : null;
    if (!confirmation
      || confirmation.decision !== CAPABILITY_CONFIRMATION_DECISION.INSTALL
      || confirmation.artifact_digest !== params.artifactDigest
      || confirmation.audit_digest !== params.auditDigest
      || confirmedUpdateItemId !== explicitUpdateItemId
      || confirmedUpdateBindingId !== explicitUpdateBindingId
      || requestedScope !== params.scope
      || JSON.stringify(requestedProviders) !== JSON.stringify(normalizedStringSet(params.providerFilter))
      || JSON.stringify(requestedMachines) !== JSON.stringify(normalizedStringSet(params.machineFilter))
      || requestedScopeId !== activatedScopeId
      || (params.scope === CAPABILITY_SCOPE.LOCAL
        && operation.request_summary.targetServerId !== params.serverId)) {
      throw new Error('capability_activation_confirmation_mismatch');
    }

    if (params.scope !== CAPABILITY_SCOPE.LOCAL) {
      await tx.queryOne(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `capability-sync-quota:${params.ownerUserId}`,
      ]);
      await compactExpiredSynchronizedCapabilityHistory(tx, params.ownerUserId, now);
    }

    // A daemon may refer to an existing server id learned from sync, but a new
    // daemon-local id is never inserted directly. This owner-scoped lookup
    // permits version updates without allowing cross-account PK collisions.
    let item = operation.item_id
      ? await tx.queryOne<CapabilityItemRow>(`
      SELECT ${ITEM_COLUMNS}
      FROM capability_items
      WHERE owner_user_id = $1 AND id = $2
      FOR UPDATE
    `, [params.ownerUserId, operation.item_id])
      : explicitUpdateItemId
        ? await tx.queryOne<CapabilityItemRow>(`
          SELECT ${ITEM_COLUMNS}
          FROM capability_items
          WHERE owner_user_id = $1 AND id = $2
          FOR UPDATE
        `, [params.ownerUserId, explicitUpdateItemId])
        : null;
    if (explicitUpdateItemId && !item) throw new Error('capability_update_target_missing');
    if (item) {
      const pendingAuthority = await tx.queryOne<{ operation_id: string }>(`
        SELECT operation_id FROM capability_pending_activations
        WHERE owner_user_id = $1 AND item_id = $2
        LIMIT 1
        FOR UPDATE
      `, [params.ownerUserId, item.id]);
      if (pendingAuthority) throw new Error('capability_item_activation_pending');
      const reservedLocalMutation = await tx.queryOne<{ request_id: string }>(`
        SELECT request_id FROM capability_local_manage_requests
        WHERE owner_user_id = $1 AND item_id = $2 AND expires_at > $3
        LIMIT 1
      `, [params.ownerUserId, item.id, now]);
      if (reservedLocalMutation) throw new Error('capability_item_manage_reserved');
    }
    const createdItem = !item;
    const itemId = item?.id ?? randomUUID();
    if (!item) {
      item = await tx.queryOne<CapabilityItemRow>(`
        INSERT INTO capability_items (
          id, owner_user_id, kind, name, lifecycle_state, revision, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'pending', 1, $5, $5)
        RETURNING ${ITEM_COLUMNS}
      `, [itemId, params.ownerUserId, params.kind, params.name, now]);
    }
    if (!item || item.kind !== params.kind) throw new Error('capability_item_kind_conflict');

    const existingBinding = explicitUpdateBindingId
      ? await tx.queryOne<CapabilityBindingRow>(`
        SELECT ${BINDING_COLUMNS}
        FROM capability_bindings
        WHERE owner_user_id = $1 AND item_id = $2 AND id = $3
        FOR UPDATE
      `, [params.ownerUserId, itemId, explicitUpdateBindingId])
      : null;
    if (explicitUpdateBindingId && !existingBinding) throw new Error('capability_update_binding_missing');
    if (existingBinding
      && (existingBinding.scope !== params.scope
        || existingBinding.project_key !== (params.projectKey ?? null)
        || existingBinding.session_key !== (params.sessionKey ?? null)
        || existingBinding.server_id !== (params.serverId ?? null)
        || canonicalCapabilityJson(existingBinding.provider_filter)
          !== canonicalCapabilityJson(normalizedStringSet(params.providerFilter))
        || canonicalCapabilityJson(existingBinding.machine_filter)
          !== canonicalCapabilityJson(normalizedStringSet(params.machineFilter)))) {
      throw new Error('capability_update_binding_mismatch');
    }

    let introducesSynchronizedItem = false;
    if (params.scope !== CAPABILITY_SCOPE.LOCAL) {
      // One account-wide lock protects item, version and binding admission so
      // concurrent updates cannot push a complete-current snapshot beyond its
      // wire bounds.
      const existingSynchronizedAuthority = await tx.queryOne<{ present: boolean }>(`
        SELECT TRUE AS present
        FROM capability_bindings
        WHERE owner_user_id = $1 AND item_id = $2 AND scope <> 'local'
        LIMIT 1
      `, [params.ownerUserId, itemId]);
      introducesSynchronizedItem = !existingSynchronizedAuthority;
      if (introducesSynchronizedItem) {
        const quota = await tx.queryOne<{ item_count: number }>(`
          SELECT COUNT(*)::int AS item_count
          FROM (
            SELECT DISTINCT item_id
            FROM capability_bindings
            WHERE owner_user_id = $1 AND scope <> 'local'
            UNION
            SELECT item_id
            FROM capability_pending_activations
            WHERE owner_user_id = $1 AND introduces_synchronized_item = TRUE
          ) synchronized_items
        `, [params.ownerUserId]);
        if ((quota?.item_count ?? 0) >= CAPABILITY_LIMITS.SYNC_ITEMS) {
          throw new Error('capability_sync_item_quota_exceeded');
        }
      }
      const metadataQuota = await tx.queryOne<{ version_count: number; binding_count: number }>(`
        SELECT
          (SELECT COUNT(*)::int
            FROM capability_versions cv
            WHERE cv.owner_user_id = $1 AND (
              EXISTS (
                SELECT 1 FROM capability_bindings cb
                WHERE cb.owner_user_id = cv.owner_user_id
                  AND cb.item_id = cv.item_id AND cb.scope <> 'local'
              ) OR EXISTS (
                SELECT 1 FROM capability_pending_activations pa
                WHERE pa.owner_user_id = cv.owner_user_id AND pa.item_id = cv.item_id
              )
            )) AS version_count,
          ((SELECT COUNT(*)::int FROM capability_bindings
            WHERE owner_user_id = $1 AND scope <> 'local')
            + (SELECT COUNT(*)::int FROM capability_pending_activations
              WHERE owner_user_id = $1)) AS binding_count
      `, [params.ownerUserId]);
      if ((metadataQuota?.version_count ?? 0) >= CAPABILITY_LIMITS.SYNC_VERSIONS) {
        throw new Error('capability_sync_version_quota_exceeded');
      }
      if (!existingBinding
        && (metadataQuota?.binding_count ?? 0) >= CAPABILITY_LIMITS.SYNC_BINDINGS) {
        throw new Error('capability_sync_binding_quota_exceeded');
      }
    }

    const numberRow = await tx.queryOne<{ next_number: number }>(`
      SELECT COALESCE(MAX(version_number), 0)::int + 1 AS next_number
      FROM capability_versions
      WHERE owner_user_id = $1 AND item_id = $2
    `, [params.ownerUserId, itemId]);
    const versionId = randomUUID();
    await tx.execute(`
      INSERT INTO capability_versions (
        id, owner_user_id, item_id, version_number, artifact_digest, blob_digest,
        blob_byte_size, audit_digest, source_kind, source_summary, manifest,
        definition, permission_summary, publication_state, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `, [
      versionId,
      params.ownerUserId,
      itemId,
      numberRow?.next_number ?? 1,
      params.artifactDigest,
      params.blobDigest ?? null,
      params.blobByteSize ?? null,
      params.auditDigest,
      params.sourceKind,
      params.sourceSummary,
      params.manifest,
      normalizedDefinition,
      JSON.stringify(params.permissionSummary),
      'pending',
      now,
    ]);

    const bindingId = existingBinding?.id ?? randomUUID();
    const existingReadyBlob = synchronizedSkill && params.blobDigest
      ? await tx.queryOne<{ present: boolean }>(`
        SELECT TRUE AS present FROM capability_blobs
        WHERE owner_user_id = $1 AND digest = $2 AND byte_size = $3
          AND storage_state = 'ready' AND content IS NOT NULL
        LIMIT 1
      `, [params.ownerUserId, params.blobDigest, params.blobByteSize])
      : null;
    const blobReady = !synchronizedSkill || Boolean(existingReadyBlob);
    const candidateExpiresAt = Math.max(now, Date.now()) + CAPABILITY_LIMITS.PERSISTED_CANDIDATE_TTL_MS;
    // The daemon persists this envelope beside the canonical package. Its
    // authority revision must be the exact item revision that will become
    // visible after COMMIT_RESULT, not the unrelated operation CAS revision.
    // Both a fresh pending item and an existing item advance exactly once in
    // completeCapabilityCommit.
    const candidateAuthorityRevision = item.revision + 1;
    const candidateBinding = {
      id: bindingId,
      capabilityId: itemId,
      versionId,
      scope: params.scope,
      ...(params.scope === CAPABILITY_SCOPE.PROJECT && params.projectKey
        ? { scopeId: params.projectKey }
        : params.scope === CAPABILITY_SCOPE.SESSION && params.sessionKey
          ? { scopeId: params.sessionKey }
          : params.scope === CAPABILITY_SCOPE.LOCAL && params.serverId
            ? { scopeId: params.serverId }
            : {}),
      providers: normalizedStringSet(params.providerFilter),
      machines: normalizedStringSet(params.machineFilter),
      active: true,
    };
    const candidateBindingRevision = (existingBinding?.revision ?? 0) + 1;
    const authorization = params.kind === CAPABILITY_KIND.SKILL
      ? params.authorizationSigner.signSkill({
        ownerId: params.ownerUserId,
        capabilityId: itemId,
        versionId,
        artifactDigest: params.artifactDigest,
        auditDigest: params.auditDigest,
        ...(params.blobDigest ? { blobDigest: params.blobDigest } : {}),
        binding: candidateBinding,
        itemRevision: candidateAuthorityRevision,
        bindingRevision: candidateBindingRevision,
        bindingState: CAPABILITY_AUTHORITY_STATE.ACTIVE,
        issuedRevision: candidateAuthorityRevision,
        issuedAt: now,
      })
      : null;
    if (Buffer.byteLength(JSON.stringify({
      ...candidateBinding,
      ...(authorization ? { authorization } : {}),
    }), 'utf8') > CAPABILITY_LIMITS.SYNC_BINDING_RECORD_BYTES) {
      throw new Error('capability_sync_binding_record_too_large');
    }
    await tx.execute(`
      INSERT INTO capability_pending_activations (
        operation_id, owner_user_id, item_id, version_id, binding_id, scope,
        project_key, session_key, server_id, provider_filter, machine_filter,
        authorization_envelope, authority_item_revision, authority_binding_revision,
        blob_ready, created_item,
        introduces_synchronized_item, created_at, expires_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17, $18, $19
      )
    `, [
      params.operationId, params.ownerUserId, itemId, versionId, bindingId,
      params.scope, params.projectKey ?? null, params.sessionKey ?? null,
      params.serverId ?? null, JSON.stringify(normalizedStringSet(params.providerFilter)),
      JSON.stringify(normalizedStringSet(params.machineFilter)), authorization,
      candidateAuthorityRevision, candidateBindingRevision,
      blobReady, createdItem, introducesSynchronizedItem, now,
      candidateExpiresAt,
    ]);
    const pendingOperation = await tx.queryOne<CapabilityOperationRow>(`
      UPDATE capability_operations
      SET item_id = $3, state = 'syncing', revision = revision + 1,
          updated_at = $4, completed_at = NULL
      WHERE owner_user_id = $1 AND id = $2 AND revision = $5
        AND state = 'installing'
      RETURNING id, item_id, operation_kind, state, request_summary, artifact_digest,
                audit_digest, error_code, revision, created_at, updated_at, completed_at
    `, [params.ownerUserId, params.operationId, itemId, now, params.expectedOperationRevision]);
    if (!pendingOperation) throw new Error('capability_activation_stale_operation');
    await insertAuditEvent(tx, {
      ownerUserId: params.ownerUserId,
      itemId,
      operationId: params.operationId,
      action: 'install_candidate_authorized',
      outcome: CAPABILITY_INSTALL_STATE.SYNCING,
      actorKind: 'daemon',
      scope: params.scope,
      metadata: {
        artifactDigest: params.artifactDigest,
        auditDigest: params.auditDigest,
        versionId,
        bindingId,
        keyId: authorization?.keyId ?? null,
        blobReady,
      },
      now,
    });
    const hydrated = await getCapability(tx, { ownerUserId: params.ownerUserId, itemId });
    if (!hydrated) throw new Error('capability_activation_missing_item');
    return {
      item: hydrated,
      accountRevision: await currentAccountRevision(tx, params.ownerUserId),
      pendingBlob: synchronizedSkill && !blobReady,
      operation: await hydrateOperation(tx, params.ownerUserId, pendingOperation),
      candidate: {
        versionId,
        versionNumber: numberRow?.next_number ?? 1,
        bindingId,
        authorityRevision: candidateAuthorityRevision,
        authorityBindingRevision: candidateBindingRevision,
        authorization,
      },
    };
  });
}

interface PendingCapabilityAuthorizationRow {
  operation_id: string;
  item_id: string;
  version_id: string;
  binding_id: string;
  scope: CapabilityScope;
  project_key: string | null;
  session_key: string | null;
  server_id: string | null;
  provider_filter: string[];
  machine_filter: string[];
  authorization_envelope: CapabilitySkillAuthorizationEnvelope | null;
  authority_item_revision: number;
  authority_binding_revision: number;
  blob_ready: boolean;
  expires_at: number;
  request_summary: Record<string, unknown>;
  operation_revision: number;
}

export interface PendingCapabilityAuthorizationView {
  operationId: string;
  expectedRevision: number;
  expiresAt: number;
  authorityRevision: number;
  authorityBindingRevision: number;
  targetServerId: string;
  item: CapabilityItemView;
  version: CapabilityVersionView;
  binding: CapabilityBindingView;
}

async function hydratePendingCapabilityAuthorization(
  db: Database,
  ownerUserId: string,
  row: PendingCapabilityAuthorizationRow,
): Promise<PendingCapabilityAuthorizationView | null> {
  const targetServerId = typeof row.request_summary.targetServerId === 'string'
    ? row.request_summary.targetServerId
    : null;
  if (!targetServerId) return null;
  const item = await getCapability(db, { ownerUserId, itemId: row.item_id });
  const versionRow = await db.queryOne<CapabilityVersionRow>(`
    SELECT id, version_number, artifact_digest, blob_digest, blob_byte_size,
           audit_digest, source_kind, source_summary, manifest, definition,
           permission_summary, publication_state, created_at
    FROM capability_versions
    WHERE owner_user_id = $1 AND item_id = $2 AND id = $3
      AND publication_state = 'pending'
  `, [ownerUserId, row.item_id, row.version_id]);
  if (!item || !versionRow) return null;
  const version = toVersion(versionRow);
  return {
    operationId: row.operation_id,
    expectedRevision: row.operation_revision,
    expiresAt: row.expires_at,
    authorityRevision: row.authority_item_revision,
    authorityBindingRevision: row.authority_binding_revision,
    targetServerId,
    item,
    version,
    binding: {
      id: row.binding_id,
      versionId: row.version_id,
      scope: row.scope,
      projectKey: row.project_key,
      sessionKey: row.session_key,
      serverId: row.server_id,
      providerFilter: row.provider_filter,
      machineFilter: row.machine_filter,
      authorization: row.authorization_envelope,
      authorityState: CAPABILITY_AUTHORITY_STATE.ACTIVE,
      enabled: true,
      revision: 1,
      updatedAt: version.createdAt,
    },
  };
}

export async function getPendingCapabilityAuthorization(
  db: Database,
  params: { ownerUserId: string; operationId: string },
): Promise<PendingCapabilityAuthorizationView | null> {
  const row = await db.queryOne<PendingCapabilityAuthorizationRow>(`
    SELECT pa.operation_id, pa.item_id, pa.version_id, pa.binding_id, pa.scope,
           pa.project_key, pa.session_key, pa.server_id, pa.provider_filter,
           pa.machine_filter, pa.authorization_envelope, pa.authority_item_revision,
           pa.authority_binding_revision, pa.blob_ready, pa.expires_at, co.request_summary,
           co.revision AS operation_revision
    FROM capability_pending_activations pa
    JOIN capability_operations co
      ON co.owner_user_id = pa.owner_user_id AND co.id = pa.operation_id
    WHERE pa.owner_user_id = $1 AND pa.operation_id = $2
      AND pa.blob_ready = TRUE AND pa.expires_at > $3 AND co.state = 'syncing'
  `, [params.ownerUserId, params.operationId, Date.now()]);
  return row ? hydratePendingCapabilityAuthorization(db, params.ownerUserId, row) : null;
}

export async function listPendingCapabilityAuthorizations(
  db: Database,
  params: { ownerUserId: string; serverId: string; limit?: number },
): Promise<PendingCapabilityAuthorizationView[]> {
  const rows = await db.query<PendingCapabilityAuthorizationRow>(`
    SELECT pa.operation_id, pa.item_id, pa.version_id, pa.binding_id, pa.scope,
           pa.project_key, pa.session_key, pa.server_id, pa.provider_filter,
           pa.machine_filter, pa.authorization_envelope, pa.authority_item_revision,
           pa.authority_binding_revision, pa.blob_ready, pa.expires_at, co.request_summary,
           co.revision AS operation_revision
    FROM capability_pending_activations pa
    JOIN capability_operations co
      ON co.owner_user_id = pa.owner_user_id AND co.id = pa.operation_id
    WHERE pa.owner_user_id = $1 AND pa.blob_ready = TRUE AND pa.expires_at > $4 AND co.state = 'syncing'
      AND co.request_summary->>'targetServerId' = $2
    ORDER BY pa.created_at, pa.operation_id
    LIMIT $3
  `, [params.ownerUserId, params.serverId, params.limit ?? CAPABILITY_LIMITS.LIST_MAX, Date.now()]);
  const hydrated: PendingCapabilityAuthorizationView[] = [];
  for (const row of rows) {
    const entry = await hydratePendingCapabilityAuthorization(db, params.ownerUserId, row);
    if (entry) hydrated.push(entry);
  }
  return hydrated;
}

export async function listPendingCapabilityBlobUploads(
  db: Database,
  params: { ownerUserId: string; serverId: string; limit?: number },
): Promise<Array<{ operationId: string; expectedRevision: number; capabilityId: string; versionId: string }>> {
  const rows = await db.query<{
    operation_id: string;
    item_id: string;
    version_id: string;
    operation_revision: number;
  }>(`
    SELECT pa.operation_id, pa.item_id, pa.version_id, co.revision AS operation_revision
    FROM capability_pending_activations pa
    JOIN capability_operations co
      ON co.owner_user_id = pa.owner_user_id AND co.id = pa.operation_id
    JOIN capability_versions cv
      ON cv.owner_user_id = pa.owner_user_id
     AND cv.item_id = pa.item_id AND cv.id = pa.version_id
    WHERE pa.owner_user_id = $1 AND pa.blob_ready = FALSE AND pa.expires_at > $4
      AND co.state = 'syncing' AND co.request_summary->>'targetServerId' = $2
      AND cv.publication_state = 'pending' AND cv.blob_digest IS NOT NULL
    ORDER BY pa.created_at, pa.operation_id
    LIMIT $3
  `, [params.ownerUserId, params.serverId, params.limit ?? CAPABILITY_LIMITS.LIST_MAX, Date.now()]);
  return rows.map((row) => ({
    operationId: row.operation_id,
    expectedRevision: row.operation_revision,
    capabilityId: row.item_id,
    versionId: row.version_id,
  }));
}

export type CompleteCapabilityCommitResult =
  | {
    status: 'ok';
    item: CapabilityItemView;
    operation: CapabilityOperationView;
    accountRevision: number;
    synchronized: boolean;
  }
  | { status: 'not_found' | 'stale' | 'not_ready' };

export async function completeCapabilityCommit(
  db: Database,
  params: {
    ownerUserId: string;
    targetServerId: string;
    operationId: string;
    expectedRevision: number;
    capabilityId: string;
    versionId: string;
    bindingId: string;
    authorityRevision: number;
    now?: number;
  },
): Promise<CompleteCapabilityCommitResult> {
  const now = params.now ?? Date.now();
  await expireCapabilityPendingActivations(db, {
    ownerUserId: params.ownerUserId,
    targetServerId: params.targetServerId,
    now,
  });
  return db.transaction(async (tx) => {
    const receipt = await tx.queryOne<{
      item_id: string;
      operation_revision: number;
      item_revision: number;
      account_revision: number;
      synchronized: boolean;
    }>(`
      SELECT item_id, operation_revision, item_revision, account_revision, synchronized
      FROM capability_install_commits
      WHERE owner_user_id = $1 AND operation_id = $2
        AND target_server_id = $3 AND item_id = $4
        AND version_id = $5 AND binding_id = $6
    `, [
      params.ownerUserId,
      params.operationId,
      params.targetServerId,
      params.capabilityId,
      params.versionId,
      params.bindingId,
    ]);
    if (receipt) {
      if (receipt.operation_revision !== params.expectedRevision
        || receipt.item_revision !== params.authorityRevision) return { status: 'stale' };
      const item = await getCapability(tx, { ownerUserId: params.ownerUserId, itemId: receipt.item_id });
      const operation = await getCapabilityOperation(tx, {
        ownerUserId: params.ownerUserId,
        operationId: params.operationId,
      });
      if (!item || !operation || operation.state !== CAPABILITY_INSTALL_STATE.INSTALLED) {
        return { status: 'stale' };
      }
      return {
        status: 'ok',
        item,
        operation,
        accountRevision: receipt.account_revision,
        synchronized: receipt.synchronized,
      };
    }
    const pending = await tx.queryOne<PendingCapabilityAuthorizationRow>(`
      SELECT pa.operation_id, pa.item_id, pa.version_id, pa.binding_id, pa.scope,
             pa.project_key, pa.session_key, pa.server_id, pa.provider_filter,
             pa.machine_filter, pa.authorization_envelope, pa.authority_item_revision,
             pa.authority_binding_revision, pa.blob_ready, pa.expires_at, co.request_summary,
             co.revision AS operation_revision
      FROM capability_pending_activations pa
      JOIN capability_operations co
        ON co.owner_user_id = pa.owner_user_id AND co.id = pa.operation_id
      WHERE pa.owner_user_id = $1 AND pa.operation_id = $2
      FOR UPDATE OF pa, co
    `, [params.ownerUserId, params.operationId]);
    if (!pending) return { status: 'not_found' };
    if (pending.operation_revision !== params.expectedRevision
      || pending.item_id !== params.capabilityId
      || pending.version_id !== params.versionId
      || pending.binding_id !== params.bindingId
      || pending.authority_item_revision !== params.authorityRevision
      || pending.request_summary.targetServerId !== params.targetServerId) return { status: 'stale' };
    if (!pending.blob_ready) return { status: 'not_ready' };
    const reservedLocalMutation = await tx.queryOne<{ request_id: string }>(`
      SELECT request_id FROM capability_local_manage_requests
      WHERE owner_user_id = $1 AND item_id = $2 AND expires_at > $3
      LIMIT 1
    `, [params.ownerUserId, pending.item_id, now]);
    if (reservedLocalMutation) return { status: 'stale' };

    const currentItemAuthority = await tx.queryOne<{ revision: number }>(`
      SELECT revision FROM capability_items
      WHERE owner_user_id = $1 AND id = $2
      FOR UPDATE
    `, [params.ownerUserId, pending.item_id]);
    if (currentItemAuthority?.revision !== pending.authority_item_revision - 1) {
      return { status: 'stale' };
    }
    const existingBinding = await tx.queryOne<{ id: string; revision: number }>(`
      SELECT id, revision FROM capability_bindings
      WHERE owner_user_id = $1 AND item_id = $2 AND id = $3
      FOR UPDATE
    `, [params.ownerUserId, pending.item_id, pending.binding_id]);
    if (existingBinding && existingBinding.revision !== pending.authority_binding_revision - 1) {
      return { status: 'stale' };
    }
    if (!existingBinding && pending.authority_binding_revision !== 1) return { status: 'stale' };

    const version = await tx.queryOne<CapabilityVersionRow>(`
      SELECT id, version_number, artifact_digest, blob_digest, blob_byte_size,
             audit_digest, source_kind, source_summary, manifest, definition,
             permission_summary, publication_state, created_at
      FROM capability_versions
      WHERE owner_user_id = $1 AND item_id = $2 AND id = $3
      FOR UPDATE
    `, [params.ownerUserId, pending.item_id, pending.version_id]);
    if (!version || version.publication_state !== 'pending') return { status: 'stale' };
    await tx.execute(`
      UPDATE capability_versions SET publication_state = 'active'
      WHERE owner_user_id = $1 AND item_id = $2 AND id = $3
    `, [params.ownerUserId, pending.item_id, pending.version_id]);
    const lifecycle: CapabilityLifecycleState = version.definition
      ? CAPABILITY_STATE.RUNTIME_PENDING
      : CAPABILITY_STATE.ACTIVE;
    const committedItem = await tx.queryOne<{ revision: number }>(`
      UPDATE capability_items
      SET active_version_id = $3, lifecycle_state = $4, tombstoned_at = NULL,
          removed_at = NULL, revision = revision + 1, updated_at = $5
      WHERE owner_user_id = $1 AND id = $2 AND revision = $6
      RETURNING revision
    `, [
      params.ownerUserId,
      pending.item_id,
      pending.version_id,
      lifecycle,
      now,
      pending.authority_item_revision - 1,
    ]);
    if (committedItem?.revision !== pending.authority_item_revision) {
      throw new Error('capability_commit_item_revision_invariant');
    }
    if (existingBinding) {
      const committedBinding = await tx.queryOne<{ revision: number }>(`
        UPDATE capability_bindings
        SET version_id = $4, provider_filter = $5, machine_filter = $6,
            authorization_envelope = $7, authority_state = 'active', enabled = TRUE,
            revision = revision + 1, updated_at = $8
        WHERE owner_user_id = $1 AND item_id = $2 AND id = $3 AND revision = $9
        RETURNING revision
      `, [
        params.ownerUserId, pending.item_id, pending.binding_id, pending.version_id,
        JSON.stringify(pending.provider_filter), JSON.stringify(pending.machine_filter),
        pending.authorization_envelope, now, pending.authority_binding_revision - 1,
      ]);
      if (committedBinding?.revision !== pending.authority_binding_revision) {
        throw new Error('capability_commit_binding_revision_invariant');
      }
    } else {
      await tx.execute(`
        INSERT INTO capability_bindings (
          id, owner_user_id, item_id, version_id, scope, project_key, session_key,
          server_id, provider_filter, machine_filter, authorization_envelope, enabled,
          authority_state, revision, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, 'active', $12, $13, $13)
      `, [
        pending.binding_id, params.ownerUserId, pending.item_id, pending.version_id,
        pending.scope, pending.project_key, pending.session_key, pending.server_id,
        JSON.stringify(pending.provider_filter), JSON.stringify(pending.machine_filter),
        pending.authorization_envelope, pending.authority_binding_revision, now,
      ]);
    }
    const installed = await tx.queryOne<CapabilityOperationRow>(`
      UPDATE capability_operations
      SET state = 'installed', revision = revision + 1,
          updated_at = $4, completed_at = $4
      WHERE owner_user_id = $1 AND id = $2 AND revision = $3 AND state = 'syncing'
      RETURNING id, item_id, operation_kind, state, request_summary, artifact_digest,
                audit_digest, error_code, revision, created_at, updated_at, completed_at
    `, [params.ownerUserId, params.operationId, params.expectedRevision, now]);
    if (!installed) return { status: 'stale' };
    await tx.execute(`
      DELETE FROM capability_pending_activations
      WHERE owner_user_id = $1 AND operation_id = $2
    `, [params.ownerUserId, params.operationId]);
    const synchronized = pending.scope !== CAPABILITY_SCOPE.LOCAL;
    // This cursor also versions the per-daemon complete AUTHORITY map. Local
    // bindings are absent from account snapshots but still must advance it.
    const accountRevision = await nextAccountRevision(tx, params.ownerUserId, now);
    await tx.execute(`
      INSERT INTO capability_install_commits (
        operation_id, owner_user_id, target_server_id, item_id, version_id,
        binding_id, operation_revision, item_revision, account_revision,
        synchronized, committed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      params.operationId,
      params.ownerUserId,
      params.targetServerId,
      pending.item_id,
      pending.version_id,
      pending.binding_id,
      params.expectedRevision,
      pending.authority_item_revision,
      accountRevision,
      synchronized,
      now,
    ]);
    await insertAuditEvent(tx, {
      ownerUserId: params.ownerUserId,
      itemId: pending.item_id,
      operationId: params.operationId,
      action: 'install_commit',
      outcome: lifecycle,
      actorKind: 'daemon',
      scope: pending.scope,
      metadata: {
        versionId: pending.version_id,
        bindingId: pending.binding_id,
        keyId: pending.authorization_envelope?.keyId ?? null,
        accountRevision,
      },
      now,
    });
    const item = await getCapability(tx, { ownerUserId: params.ownerUserId, itemId: pending.item_id });
    if (!item) throw new Error('capability_commit_item_missing');
    return {
      status: 'ok',
      item,
      operation: await hydrateOperation(tx, params.ownerUserId, installed),
      accountRevision,
      synchronized,
    };
  });
}

function normalizedStringSet(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))].sort();
}

async function currentAccountRevision(db: Database, ownerUserId: string): Promise<number> {
  const row = await db.queryOne<{ revision: number }>(`
    SELECT revision FROM capability_account_revisions WHERE owner_user_id = $1
  `, [ownerUserId]);
  return row?.revision ?? 0;
}

export type ManageCapabilityResult =
  | { status: 'ok'; item: CapabilityItemView; accountRevision: number; synchronized: boolean }
  | { status: 'ambiguous_binding'; bindings: CapabilityBindingView[] }
  | { status: 'not_found' | 'binding_not_found' | 'stale' | 'invalid_action' | 'version_not_found' | 'runtime_pending' };

export async function resolveCapabilityManagementTarget(
  db: Database,
  params: {
    ownerUserId: string;
    itemId: string;
    expectedRevision: number;
    bindingId?: string | null;
    targetVersionId?: string | null;
  },
): Promise<
  | { status: 'ok'; item: CapabilityItemView; binding: CapabilityBindingView }
  | { status: 'not_found' | 'stale' | 'binding_not_found' | 'version_not_found' }
  | { status: 'ambiguous_binding'; bindings: CapabilityBindingView[] }
> {
  const item = await getCapability(db, { ownerUserId: params.ownerUserId, itemId: params.itemId });
  if (!item) return { status: 'not_found' };
  if (item.revision !== params.expectedRevision) return { status: 'stale' };
  const bindings = params.bindingId
    ? item.bindings.filter((entry) => entry.id === params.bindingId)
    : item.bindings;
  if (bindings.length === 0) return { status: 'binding_not_found' };
  if (!params.bindingId && bindings.length > 1) {
    return { status: 'ambiguous_binding', bindings: bindings.slice(0, CAPABILITY_LIMITS.AMBIGUOUS_CHOICES) };
  }
  if (params.targetVersionId
    && !await db.queryOne<{ present: boolean }>(`
      SELECT TRUE AS present
      FROM capability_versions
      WHERE owner_user_id = $1 AND item_id = $2 AND id = $3
        AND publication_state = 'active'
      LIMIT 1
    `, [params.ownerUserId, params.itemId, params.targetVersionId])) {
      return { status: 'version_not_found' };
  }
  return { status: 'ok', item, binding: bindings[0]! };
}

type LocalCapabilityManageJournalPhase =
  | 'prepare_sent'
  | 'prepared'
  | 'commit_sent'
  | 'applied'
  | 'committed'
  | 'aborted';

interface LocalCapabilityManageRequestRow {
  request_id: string;
  owner_user_id: string;
  item_id: string;
  binding_id: string;
  server_id: string;
  action: CapabilityLocalManagementAction;
  expected_revision: number;
  authority_revision: number;
  target_version_id: string | null;
  authorization_envelope: CapabilitySkillAuthorizationEnvelope | null;
  phase: LocalCapabilityManageJournalPhase;
  result_error_code: CapabilityErrorCode | null;
  result_item_revision: number | null;
  result_account_revision: number | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

const LOCAL_MANAGE_REQUEST_COLUMNS = `
  request_id, owner_user_id, item_id, binding_id, server_id, action,
  expected_revision, authority_revision, target_version_id,
  authorization_envelope, phase, result_error_code, result_item_revision,
  result_account_revision, created_at, updated_at, expires_at
`;

export interface LocalCapabilityManageRequestView {
  requestId: string;
  ownerUserId: string;
  itemId: string;
  bindingId: string;
  serverId: string;
  action: CapabilityLocalManagementAction;
  expectedRevision: number;
  authorityRevision: number;
  targetVersionId: string | null;
  authorization: CapabilitySkillAuthorizationEnvelope | null;
  phase: LocalCapabilityManageJournalPhase;
  errorCode: CapabilityErrorCode | null;
  resultItemRevision: number | null;
  resultAccountRevision: number | null;
  expiresAt: number;
}

function toLocalCapabilityManageRequest(row: LocalCapabilityManageRequestRow): LocalCapabilityManageRequestView {
  return {
    requestId: row.request_id,
    ownerUserId: row.owner_user_id,
    itemId: row.item_id,
    bindingId: row.binding_id,
    serverId: row.server_id,
    action: row.action,
    expectedRevision: row.expected_revision,
    authorityRevision: row.authority_revision,
    targetVersionId: row.target_version_id,
    authorization: row.authorization_envelope,
    phase: row.phase,
    errorCode: row.result_error_code,
    resultItemRevision: row.result_item_revision,
    resultAccountRevision: row.result_account_revision,
    expiresAt: row.expires_at,
  };
}

export async function reserveLocalCapabilityManage(
  db: Database,
  params: {
    requestId: string;
    ownerUserId: string;
    itemId: string;
    bindingId: string;
    serverId: string;
    action: CapabilityLocalManagementAction;
    expectedRevision: number;
    targetVersionId?: string | null;
    timeoutMs: number;
    authorizationSigner: CapabilityAuthorizationSigner;
    now?: number;
  },
): Promise<{ status: 'ok'; request: LocalCapabilityManageRequestView } | { status: 'conflict' | 'not_found' }> {
  const now = params.now ?? Date.now();
  return db.transaction(async (tx) => {
    await tx.execute(`
      UPDATE capability_local_manage_requests
      SET phase = 'aborted', result_error_code = $2, updated_at = $1
      WHERE expires_at <= $1 AND phase IN ('prepare_sent', 'prepared')
    `, [now, CAPABILITY_ERROR.RUNTIME_PENDING]);
    await tx.execute(`
      DELETE FROM capability_local_manage_requests
      WHERE phase IN ('committed', 'aborted') AND updated_at < $1
    `, [now - 30 * 24 * 60 * 60 * 1000]);
    const replay = await tx.queryOne<LocalCapabilityManageRequestRow>(`
      SELECT ${LOCAL_MANAGE_REQUEST_COLUMNS}
      FROM capability_local_manage_requests
      WHERE owner_user_id = $1 AND item_id = $2 AND binding_id = $3
        AND server_id = $4 AND action = $5 AND expected_revision = $6
        AND target_version_id IS NOT DISTINCT FROM $7
        AND phase <> 'aborted'
      ORDER BY updated_at DESC
      LIMIT 1
      FOR UPDATE
    `, [
      params.ownerUserId,
      params.itemId,
      params.bindingId,
      params.serverId,
      params.action,
      params.expectedRevision,
      params.targetVersionId ?? null,
    ]);
    if (replay) return { status: 'ok', request: toLocalCapabilityManageRequest(replay) };
    const item = await tx.queryOne<CapabilityItemRow>(`
      SELECT ${ITEM_COLUMNS} FROM capability_items
      WHERE owner_user_id = $1 AND id = $2 AND revision = $3
      FOR UPDATE
    `, [params.ownerUserId, params.itemId, params.expectedRevision]);
    const binding = await tx.queryOne<CapabilityBindingRow>(`
      SELECT ${BINDING_COLUMNS} FROM capability_bindings
      WHERE owner_user_id = $1 AND item_id = $2 AND id = $3
        AND scope = 'local' AND server_id = $4
      FOR UPDATE
    `, [params.ownerUserId, params.itemId, params.bindingId, params.serverId]);
    if (!item || !binding) return { status: 'not_found' };
    const activeRequest = await tx.queryOne<LocalCapabilityManageRequestRow>(`
      SELECT ${LOCAL_MANAGE_REQUEST_COLUMNS}
      FROM capability_local_manage_requests
      WHERE owner_user_id = $1 AND binding_id = $2
        AND phase NOT IN ('committed', 'aborted')
      FOR UPDATE
    `, [params.ownerUserId, params.bindingId]);
    if (activeRequest) {
      const sameIntent = activeRequest.item_id === params.itemId
        && activeRequest.server_id === params.serverId
        && activeRequest.action === params.action
        && activeRequest.expected_revision === params.expectedRevision
        && activeRequest.target_version_id === (params.targetVersionId ?? null);
      return sameIntent
        ? { status: 'ok', request: toLocalCapabilityManageRequest(activeRequest) }
        : { status: 'conflict' };
    }
    const versionId = params.action === CAPABILITY_MANAGE_ACTION.ROLLBACK
      ? params.targetVersionId
      : binding.version_id;
    if (!versionId) return { status: 'not_found' };
    const version = await tx.queryOne<CapabilityVersionRow>(`
      SELECT id, version_number, artifact_digest, blob_digest, blob_byte_size,
             audit_digest, source_kind, source_summary, manifest, definition,
             permission_summary, publication_state, created_at
      FROM capability_versions
      WHERE owner_user_id = $1 AND item_id = $2 AND id = $3
        AND publication_state = 'active'
    `, [params.ownerUserId, params.itemId, versionId]);
    if (!version) return { status: 'not_found' };
    const authorityState = params.action === CAPABILITY_MANAGE_ACTION.UNINSTALL
      ? CAPABILITY_AUTHORITY_STATE.REMOVED
      : params.action === CAPABILITY_MANAGE_ACTION.DISABLE
        ? CAPABILITY_AUTHORITY_STATE.DISABLED
        : CAPABILITY_AUTHORITY_STATE.ACTIVE;
    const authorityRevision = item.revision + 1;
    const authorization = item.kind === CAPABILITY_KIND.SKILL
      ? params.authorizationSigner.signSkill({
        ownerId: params.ownerUserId,
        capabilityId: params.itemId,
        versionId: version.id,
        artifactDigest: version.artifact_digest,
        auditDigest: version.audit_digest,
        ...(version.blob_digest ? { blobDigest: version.blob_digest } : {}),
        binding: {
          id: binding.id,
          capabilityId: params.itemId,
          versionId: version.id,
          scope: binding.scope,
          scopeId: binding.server_id ?? undefined,
          providers: binding.provider_filter,
          machines: binding.machine_filter,
          active: authorityState === CAPABILITY_AUTHORITY_STATE.ACTIVE,
        },
        itemRevision: authorityRevision,
        bindingRevision: binding.revision + 1,
        bindingState: authorityState,
        issuedRevision: authorityRevision,
        issuedAt: now,
      })
      : null;
    const row = await tx.queryOne<LocalCapabilityManageRequestRow>(`
      INSERT INTO capability_local_manage_requests (
        request_id, owner_user_id, item_id, binding_id, server_id, action,
        expected_revision, authority_revision, target_version_id,
        authorization_envelope, phase, created_at, updated_at, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'prepare_sent', $11, $11, $12)
      RETURNING ${LOCAL_MANAGE_REQUEST_COLUMNS}
    `, [
      params.requestId, params.ownerUserId, params.itemId, params.bindingId,
      params.serverId, params.action, params.expectedRevision,
      authorityRevision, params.targetVersionId ?? null, authorization,
      now, now + params.timeoutMs,
    ]);
    return row
      ? { status: 'ok', request: toLocalCapabilityManageRequest(row) }
      : { status: 'conflict' };
  });
}

export async function releaseLocalCapabilityManage(
  db: Database,
  params: { requestId: string; ownerUserId: string },
): Promise<void> {
  await db.execute(`
    UPDATE capability_local_manage_requests
    SET phase = 'aborted', result_error_code = $3, updated_at = $4
    WHERE request_id = $1 AND owner_user_id = $2
      AND phase IN ('prepare_sent', 'prepared')
  `, [params.requestId, params.ownerUserId, CAPABILITY_ERROR.RUNTIME_PENDING, Date.now()]);
}

export async function getLocalCapabilityManageRequest(
  db: Database,
  params: { requestId: string; ownerUserId: string },
): Promise<LocalCapabilityManageRequestView | null> {
  const row = await db.queryOne<LocalCapabilityManageRequestRow>(`
    SELECT ${LOCAL_MANAGE_REQUEST_COLUMNS}
    FROM capability_local_manage_requests
    WHERE request_id = $1 AND owner_user_id = $2
  `, [params.requestId, params.ownerUserId]);
  return row ? toLocalCapabilityManageRequest(row) : null;
}

export async function listReplayableLocalCapabilityManageRequests(
  db: Database,
  params: { ownerUserId: string; serverId: string; limit?: number },
): Promise<LocalCapabilityManageRequestView[]> {
  const rows = await db.query<LocalCapabilityManageRequestRow>(`
    SELECT ${LOCAL_MANAGE_REQUEST_COLUMNS}
    FROM capability_local_manage_requests
    WHERE owner_user_id = $1 AND server_id = $2
    ORDER BY CASE WHEN phase IN ('committed', 'aborted') THEN 1 ELSE 0 END,
             updated_at DESC, request_id
    LIMIT $3
  `, [params.ownerUserId, params.serverId, params.limit ?? CAPABILITY_LIMITS.LIST_MAX]);
  return rows.map(toLocalCapabilityManageRequest);
}

export async function advanceLocalCapabilityManageResult(
  db: Database,
  params: {
    requestId: string;
    ownerUserId: string;
    serverId: string;
    itemId: string;
    bindingId: string;
    action: CapabilityLocalManagementAction;
    expectedRevision: number;
    authorityRevision: number;
    resultPhase: 'prepared' | 'applied' | 'aborted';
    ok: boolean;
    errorCode?: CapabilityErrorCode | null;
    now?: number;
  },
): Promise<LocalCapabilityManageRequestView | null> {
  const now = params.now ?? Date.now();
  const nextPhase = params.ok ? params.resultPhase : 'aborted';
  const allowed = params.resultPhase === 'prepared'
    ? ['prepare_sent', 'prepared']
    : params.resultPhase === 'applied'
      ? ['commit_sent', 'applied', 'committed']
      : ['prepare_sent', 'prepared', 'commit_sent', 'applied', 'aborted'];
  const row = await db.queryOne<LocalCapabilityManageRequestRow>(`
    UPDATE capability_local_manage_requests
    SET phase = CASE WHEN phase = 'committed' THEN phase ELSE $10 END,
        result_error_code = CASE WHEN phase = 'committed' THEN result_error_code ELSE $11 END,
        updated_at = $12
    WHERE request_id = $1 AND owner_user_id = $2 AND server_id = $3
      AND item_id = $4 AND binding_id = $5 AND action = $6
      AND expected_revision = $7 AND authority_revision = $8
      AND phase = ANY($9::text[])
    RETURNING ${LOCAL_MANAGE_REQUEST_COLUMNS}
  `, [
    params.requestId,
    params.ownerUserId,
    params.serverId,
    params.itemId,
    params.bindingId,
    params.action,
    params.expectedRevision,
    params.authorityRevision,
    allowed,
    nextPhase,
    params.ok ? null : params.errorCode ?? CAPABILITY_ERROR.CONFLICT,
    now,
  ]);
  return row ? toLocalCapabilityManageRequest(row) : null;
}

export async function markLocalCapabilityManageCommitSent(
  db: Database,
  params: { requestId: string; ownerUserId: string; serverId: string; now?: number },
): Promise<LocalCapabilityManageRequestView | null> {
  const row = await db.queryOne<LocalCapabilityManageRequestRow>(`
    UPDATE capability_local_manage_requests
    SET phase = 'commit_sent', updated_at = $4
    WHERE request_id = $1 AND owner_user_id = $2 AND server_id = $3
      AND phase IN ('prepared', 'commit_sent')
    RETURNING ${LOCAL_MANAGE_REQUEST_COLUMNS}
  `, [params.requestId, params.ownerUserId, params.serverId, params.now ?? Date.now()]);
  return row ? toLocalCapabilityManageRequest(row) : null;
}

export async function manageCapability(
  db: Database,
  params: {
    ownerUserId: string;
    itemId: string;
    expectedRevision: number;
    action: CapabilityManagementAction;
    bindingId?: string | null;
    targetVersionId?: string | null;
    scope?: CapabilityScope;
    serverId?: string | null;
    now?: number;
    retentionMs?: number;
    localRequestId?: string | null;
    authorizationSigner?: CapabilityAuthorizationSigner;
  },
): Promise<ManageCapabilityResult> {
  const now = params.now ?? Date.now();
  return db.transaction(async (tx) => {
    const item = await tx.queryOne<CapabilityItemRow>(`
      SELECT ${ITEM_COLUMNS}
      FROM capability_items
      WHERE owner_user_id = $1 AND id = $2
      FOR UPDATE
    `, [params.ownerUserId, params.itemId]);
    if (!item) return { status: 'not_found' };
    if (params.localRequestId) {
      const receipt = await tx.queryOne<LocalCapabilityManageRequestRow>(`
        SELECT ${LOCAL_MANAGE_REQUEST_COLUMNS}
        FROM capability_local_manage_requests
        WHERE request_id = $1 AND owner_user_id = $2 AND item_id = $3
          AND action = $4 AND expected_revision = $5
        FOR UPDATE
      `, [
        params.localRequestId,
        params.ownerUserId,
        params.itemId,
        params.action,
        params.expectedRevision,
      ]);
      if (receipt?.phase === 'committed') {
        const hydrated = await getCapability(tx, {
          ownerUserId: params.ownerUserId,
          itemId: params.itemId,
        });
        if (!hydrated || receipt.result_account_revision === null) return { status: 'runtime_pending' };
        return {
          status: 'ok',
          item: hydrated,
          accountRevision: receipt.result_account_revision,
          synchronized: false,
        };
      }
    }
    if (item.revision !== params.expectedRevision) return { status: 'stale' };
    const pendingAuthority = await tx.queryOne<{ operation_id: string }>(`
      SELECT operation_id FROM capability_pending_activations
      WHERE owner_user_id = $1 AND item_id = $2
      LIMIT 1
      FOR UPDATE
    `, [params.ownerUserId, params.itemId]);
    if (pendingAuthority) return { status: 'stale' };
    const conflictingReservation = await tx.queryOne<{ request_id: string }>(`
      SELECT request_id FROM capability_local_manage_requests
      WHERE owner_user_id = $1 AND item_id = $2
        AND phase NOT IN ('committed', 'aborted')
        AND ($3::text IS NULL OR request_id <> $3)
      LIMIT 1
    `, [params.ownerUserId, params.itemId, params.localRequestId ?? null]);
    if (conflictingReservation) return { status: 'stale' };

    // The dependency change that owns encrypted MCP credential storage has not
    // landed. Recording a successful deletion here would be a dangerous lie:
    // no retained value has been deleted. Keep the attempted action auditable
    // while returning a typed unavailable outcome without mutating authority.
    if (params.action === CAPABILITY_MANAGE_ACTION.DELETE_CREDENTIALS) {
      await insertAuditEvent(tx, {
        ownerUserId: params.ownerUserId,
        itemId: params.itemId,
        action: params.action,
        outcome: CAPABILITY_ERROR.RUNTIME_PENDING,
        actorKind: 'owner',
        scope: params.scope,
        metadata: { reason: 'credential_store_unavailable' },
        now,
      });
      return { status: 'runtime_pending' };
    }

    const bindingScopedAction = params.action === CAPABILITY_MANAGE_ACTION.ENABLE
      || params.action === CAPABILITY_MANAGE_ACTION.DISABLE
      || params.action === CAPABILITY_MANAGE_ACTION.ROLLBACK
      || params.action === CAPABILITY_MANAGE_ACTION.UNINSTALL
      || params.action === CAPABILITY_MANAGE_ACTION.RESTORE;
    let selectedBinding: CapabilityBindingView | null = null;
    if (bindingScopedAction) {
      const bindingRows = await tx.query<CapabilityBindingRow>(`
        SELECT ${BINDING_COLUMNS}
        FROM capability_bindings
        WHERE owner_user_id = $1 AND item_id = $2
          AND ($3::text IS NULL OR id = $3)
        ORDER BY updated_at DESC, id
        LIMIT $4
        FOR UPDATE
      `, [params.ownerUserId, params.itemId, params.bindingId ?? null, CAPABILITY_LIMITS.AMBIGUOUS_CHOICES + 1]);
      if (params.bindingId && bindingRows.length === 0) return { status: 'binding_not_found' };
      if (!params.bindingId && bindingRows.length > 1) {
        return { status: 'ambiguous_binding', bindings: bindingRows.slice(0, CAPABILITY_LIMITS.AMBIGUOUS_CHOICES).map(toBinding) };
      }
      if (bindingRows.length !== 1) return { status: 'binding_not_found' };
      selectedBinding = toBinding(bindingRows[0]!);
      if ((params.scope && params.scope !== selectedBinding.scope)
        || (selectedBinding.scope === CAPABILITY_SCOPE.LOCAL
          && (!params.serverId || params.serverId !== selectedBinding.serverId))) {
        return { status: 'binding_not_found' };
      }
    }

    const scope = selectedBinding?.scope ?? params.scope ?? CAPABILITY_SCOPE.ACCOUNT;
    let localReservedAuthorization: CapabilitySkillAuthorizationEnvelope | null | undefined;
    if (selectedBinding?.scope === CAPABILITY_SCOPE.LOCAL) {
      if (!params.localRequestId) return { status: 'runtime_pending' };
      const reservation = await tx.queryOne<LocalCapabilityManageRequestRow>(`
        SELECT ${LOCAL_MANAGE_REQUEST_COLUMNS}
        FROM capability_local_manage_requests
        WHERE request_id = $1 AND owner_user_id = $2 AND item_id = $3
          AND binding_id = $4 AND server_id = $5 AND action = $6
          AND expected_revision = $7
          AND target_version_id IS NOT DISTINCT FROM $8
          AND phase IN ('applied', 'committed')
        FOR UPDATE
      `, [
        params.localRequestId, params.ownerUserId, params.itemId, selectedBinding.id,
        selectedBinding.serverId, params.action, params.expectedRevision,
        params.targetVersionId ?? null,
      ]);
      if (!reservation) return { status: 'runtime_pending' };
      localReservedAuthorization = reservation.authorization_envelope;
      if (reservation.authority_revision !== item.revision + 1) return { status: 'stale' };
    }
    let lifecycle = item.lifecycle_state;
    let activeVersionId = item.active_version_id;
    let tombstonedAt = item.tombstoned_at;
    let removedAt = item.removed_at;
    let authorityState: CapabilityAuthorityState = CAPABILITY_AUTHORITY_STATE.ACTIVE;
    let authorityVersionId = selectedBinding!.versionId;
    if (params.action === CAPABILITY_MANAGE_ACTION.ROLLBACK) {
      if (!params.targetVersionId) return { status: 'version_not_found' };
      authorityVersionId = params.targetVersionId;
      lifecycle = item.kind === CAPABILITY_KIND.MCP ? CAPABILITY_STATE.RUNTIME_PENDING : CAPABILITY_STATE.ACTIVE;
    } else if (params.action === CAPABILITY_MANAGE_ACTION.ENABLE) {
      lifecycle = item.kind === CAPABILITY_KIND.MCP ? CAPABILITY_STATE.RUNTIME_PENDING : CAPABILITY_STATE.ACTIVE;
    } else if (params.action === CAPABILITY_MANAGE_ACTION.DISABLE) {
      authorityState = CAPABILITY_AUTHORITY_STATE.DISABLED;
      const otherEnabled = await hasEnabledCapabilityBinding(
        tx, params.ownerUserId, params.itemId, selectedBinding!.id,
      );
      lifecycle = otherEnabled
        ? item.lifecycle_state
        : CAPABILITY_STATE.DISABLED;
    } else if (params.action === CAPABILITY_MANAGE_ACTION.UNINSTALL) {
      authorityState = CAPABILITY_AUTHORITY_STATE.REMOVED;
      if (await hasEnabledCapabilityBinding(tx, params.ownerUserId, params.itemId, selectedBinding!.id)) {
        lifecycle = item.kind === CAPABILITY_KIND.MCP ? CAPABILITY_STATE.RUNTIME_PENDING : CAPABILITY_STATE.ACTIVE;
      } else {
        lifecycle = CAPABILITY_STATE.TOMBSTONED;
        tombstonedAt = now;
      }
    } else if (params.action === CAPABILITY_MANAGE_ACTION.RESTORE) {
      lifecycle = item.kind === CAPABILITY_KIND.MCP ? CAPABILITY_STATE.RUNTIME_PENDING : CAPABILITY_STATE.ACTIVE;
      tombstonedAt = null;
      removedAt = null;
    } else {
      return { status: 'invalid_action' };
    }

    const authorityVersion = await tx.queryOne<CapabilityVersionRow>(`
      SELECT id, version_number, artifact_digest, blob_digest, blob_byte_size,
             audit_digest, source_kind, source_summary, manifest, definition,
             permission_summary, publication_state, created_at
      FROM capability_versions
      WHERE owner_user_id = $1 AND item_id = $2 AND id = $3
        AND publication_state = 'active'
      FOR SHARE
    `, [params.ownerUserId, params.itemId, authorityVersionId]);
    if (!authorityVersion) return { status: 'version_not_found' };
    if (item.kind === CAPABILITY_KIND.SKILL && !params.authorizationSigner) {
      return { status: 'runtime_pending' };
    }
    const bindingActive = authorityState === CAPABILITY_AUTHORITY_STATE.ACTIVE;
    const authorization = item.kind === CAPABILITY_KIND.SKILL
      ? localReservedAuthorization !== undefined
        ? localReservedAuthorization
        : params.authorizationSigner!.signSkill({
        ownerId: params.ownerUserId,
        capabilityId: params.itemId,
        versionId: authorityVersion.id,
        artifactDigest: authorityVersion.artifact_digest,
        auditDigest: authorityVersion.audit_digest,
        ...(authorityVersion.blob_digest ? { blobDigest: authorityVersion.blob_digest } : {}),
        binding: {
          id: selectedBinding!.id,
          capabilityId: params.itemId,
          versionId: authorityVersion.id,
          scope: selectedBinding!.scope,
          ...(selectedBinding!.projectKey ?? selectedBinding!.sessionKey ?? selectedBinding!.serverId
            ? {
              scopeId: selectedBinding!.projectKey
                ?? selectedBinding!.sessionKey
                ?? selectedBinding!.serverId
                ?? undefined,
            }
            : {}),
          providers: selectedBinding!.providerFilter,
          machines: selectedBinding!.machineFilter,
          active: bindingActive,
        },
        itemRevision: item.revision + 1,
        bindingRevision: selectedBinding!.revision + 1,
        bindingState: authorityState,
        issuedRevision: item.revision + 1,
        issuedAt: now,
        })
      : null;
    const updatedBinding = await tx.queryOne<{ revision: number }>(`
      UPDATE capability_bindings
      SET version_id = $4, authorization_envelope = $5, authority_state = $6,
          enabled = $7, revision = revision + 1, updated_at = $8
      WHERE owner_user_id = $1 AND item_id = $2 AND id = $3 AND revision = $9
      RETURNING revision
    `, [
      params.ownerUserId,
      params.itemId,
      selectedBinding!.id,
      authorityVersion.id,
      authorization,
      authorityState,
      bindingActive,
      now,
      selectedBinding!.revision,
    ]);
    if (updatedBinding?.revision !== selectedBinding!.revision + 1) {
      throw new Error('capability_manage_binding_revision_invariant');
    }

    // `active_version_id` is a bounded item-summary representative, never the
    // authority for a scoped binding. Preserve it while another enabled
    // binding still references that version; otherwise select one current
    // binding deterministically. Resolver/sync authority always uses each
    // binding's own version_id.
    const representative = await tx.queryOne<{ version_id: string }>(`
      SELECT version_id
      FROM capability_bindings
      WHERE owner_user_id = $1 AND item_id = $2 AND enabled = TRUE
      ORDER BY CASE WHEN version_id = $3 THEN 0 ELSE 1 END, updated_at DESC, id
      LIMIT 1
    `, [params.ownerUserId, params.itemId, activeVersionId]);
    activeVersionId = representative?.version_id ?? authorityVersionId;

    await tx.execute(`
      UPDATE capability_items
      SET lifecycle_state = $3, active_version_id = $4, tombstoned_at = $5,
          removed_at = $6, revision = revision + 1, updated_at = $7
      WHERE owner_user_id = $1 AND id = $2
    `, [params.ownerUserId, params.itemId, lifecycle, activeVersionId, tombstonedAt, removedAt, now]);

    // Account revision also versions the complete per-daemon authority map,
    // including local-only bindings.
    const accountRevision = await nextAccountRevision(tx, params.ownerUserId, now);
    if (params.action === CAPABILITY_MANAGE_ACTION.UNINSTALL) {
      const noEnabledBindings = !(await hasEnabledCapabilityBinding(tx, params.ownerUserId, params.itemId));
      if (noEnabledBindings) {
        // Current-set replacement needs at most one retained removal marker per
        // synchronized item. Compact older per-scope markers transactionally so
        // the 200-item quota also bounds the tombstone window.
        await tx.execute(`
          DELETE FROM capability_tombstones
          WHERE owner_user_id = $1 AND item_id = $2
        `, [params.ownerUserId, params.itemId]);
        await tx.execute(`
          INSERT INTO capability_tombstones (
            id, owner_user_id, item_id, scope, server_id, account_revision, expires_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          randomUUID(), params.ownerUserId, params.itemId, scope,
          scope === CAPABILITY_SCOPE.LOCAL ? selectedBinding?.serverId ?? null : null,
          accountRevision, now + (params.retentionMs ?? 30 * 24 * 60 * 60 * 1000), now,
        ]);
      }
    } else if (params.action === CAPABILITY_MANAGE_ACTION.RESTORE) {
      await tx.execute(`
        DELETE FROM capability_tombstones
        WHERE owner_user_id = $1 AND item_id = $2
      `, [params.ownerUserId, params.itemId]);
    }

    await insertAuditEvent(tx, {
      ownerUserId: params.ownerUserId,
      itemId: params.itemId,
      action: params.action,
      outcome: lifecycle,
      actorKind: 'owner',
      scope,
      metadata: {
        ...(params.action === CAPABILITY_MANAGE_ACTION.ROLLBACK ? { targetVersionId: authorityVersionId } : {}),
        ...(selectedBinding ? { bindingId: selectedBinding.id } : {}),
      },
      now,
    });
    if (params.localRequestId) {
      const committedJournal = await tx.queryOne<{ request_id: string }>(`
        UPDATE capability_local_manage_requests
        SET phase = 'committed', result_error_code = NULL,
            result_item_revision = $3, result_account_revision = $4,
            updated_at = $5
        WHERE request_id = $1 AND owner_user_id = $2 AND phase = 'applied'
        RETURNING request_id
      `, [params.localRequestId, params.ownerUserId, item.revision + 1, accountRevision, now]);
      if (!committedJournal) throw new Error('capability_local_manage_commit_journal_invariant');
    }
    const hydrated = await getCapability(tx, { ownerUserId: params.ownerUserId, itemId: params.itemId });
    if (!hydrated) throw new Error('capability_manage_missing_item');
    const synchronized = selectedBinding?.scope !== CAPABILITY_SCOPE.LOCAL;
    return { status: 'ok', item: hydrated, accountRevision, synchronized };
  });
}

async function hasEnabledCapabilityBinding(
  db: Database,
  ownerUserId: string,
  itemId: string,
  excludingBindingId?: string,
): Promise<boolean> {
  const row = await db.queryOne<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM capability_bindings
      WHERE owner_user_id = $1 AND item_id = $2 AND enabled = TRUE
        AND ($3::text IS NULL OR id <> $3)
    ) AS present
  `, [ownerUserId, itemId, excludingBindingId ?? null]);
  return row?.present === true;
}

interface AuditEventParams {
  ownerUserId: string;
  itemId?: string;
  operationId?: string;
  action: string;
  outcome: string;
  actorKind: string;
  scope?: string;
  metadata?: Record<string, unknown>;
  now: number;
}

async function insertAuditEvent(db: Database, params: AuditEventParams): Promise<void> {
  await db.execute(`
    INSERT INTO capability_audit_events (
      id, owner_user_id, item_id, operation_id, action, outcome,
      actor_kind, scope, metadata, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [
    randomUUID(), params.ownerUserId, params.itemId ?? null, params.operationId ?? null,
    params.action, params.outcome, params.actorKind, params.scope ?? null,
    params.metadata ?? {}, params.now,
  ]);
  await db.execute(`
    DELETE FROM capability_audit_events
    WHERE owner_user_id = $1 AND id NOT IN (
      SELECT id FROM capability_audit_events
      WHERE owner_user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    )
  `, [params.ownerUserId, CAPABILITY_LIMITS.RETAINED_AUDIT_EVENTS]);
  await db.execute(`
    DELETE FROM capability_operations
    WHERE owner_user_id = $1
      AND state = ANY($2::text[])
      AND id NOT IN (
        SELECT id FROM capability_operations
        WHERE owner_user_id = $1 AND state = ANY($2::text[])
        ORDER BY updated_at DESC, id DESC
        LIMIT $3
      )
  `, [
    params.ownerUserId,
    [
      CAPABILITY_INSTALL_STATE.INSTALLED,
      CAPABILITY_INSTALL_STATE.REWORK,
      CAPABILITY_INSTALL_STATE.FAILED,
      CAPABILITY_INSTALL_STATE.CANCELLED,
    ],
    CAPABILITY_LIMITS.RETAINED_TERMINAL_OPERATIONS,
  ]);
}

export async function listCapabilityAuditEvidence(
  db: Database,
  params: { ownerUserId: string; itemId?: string; operationId?: string; limit: number },
): Promise<Array<{
  id: string;
  itemId: string | null;
  operationId: string | null;
  action: string;
  outcome: string;
  actorKind: string;
  scope: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}>> {
  const rows = await db.query<{
    id: string; item_id: string | null; operation_id: string | null; action: string;
    outcome: string; actor_kind: string; scope: string | null; metadata: Record<string, unknown>; created_at: number;
  }>(`
    SELECT id, item_id, operation_id, action, outcome, actor_kind, scope, metadata, created_at
    FROM capability_audit_events
    WHERE owner_user_id = $1
      AND ($2::text IS NULL OR item_id = $2)
      AND ($3::text IS NULL OR operation_id = $3)
    ORDER BY created_at DESC, id DESC
    LIMIT $4
  `, [params.ownerUserId, params.itemId ?? null, params.operationId ?? null, params.limit]);
  return rows.map((row) => ({
    id: row.id,
    itemId: row.item_id,
    operationId: row.operation_id,
    action: row.action,
    outcome: row.outcome,
    actorKind: row.actor_kind,
    scope: row.scope,
    metadata: row.metadata,
    createdAt: row.created_at,
  }));
}

export async function acknowledgeCapabilityReadiness(
  db: Database,
  params: {
    ownerUserId: string;
    itemId: string;
    serverId: string;
    state: CapabilityReadiness;
    reasonCode?: string | null;
    accountRevision: number;
    manifestDigest?: string | null;
    now?: number;
  },
): Promise<CapabilityReadinessView | null> {
  const row = await db.queryOne<CapabilityReadinessRow>(`
    INSERT INTO capability_machine_readiness (
      owner_user_id, item_id, server_id, readiness_state, reason_code,
      account_revision, manifest_digest, acknowledged_at
    )
    SELECT $1, ci.id, s.id, $4, $5, $6, $7, $8
    FROM capability_items ci
    JOIN servers s ON s.id = $3 AND s.user_id = $1
    WHERE ci.id = $2 AND ci.owner_user_id = $1
    ON CONFLICT (owner_user_id, item_id, server_id)
    DO UPDATE SET readiness_state = EXCLUDED.readiness_state,
                  reason_code = EXCLUDED.reason_code,
                  account_revision = EXCLUDED.account_revision,
                  manifest_digest = EXCLUDED.manifest_digest,
                  acknowledged_at = EXCLUDED.acknowledged_at
    RETURNING server_id, readiness_state, reason_code, account_revision,
              manifest_digest, acknowledged_at
  `, [
    params.ownerUserId, params.itemId, params.serverId, params.state,
    params.reasonCode ?? null, params.accountRevision, params.manifestDigest ?? null,
    params.now ?? Date.now(),
  ]);
  return row ? toReadiness(row) : null;
}

export interface CapabilitySyncSnapshotRecord {
  ownerId: string;
  revision: number;
  items: CapabilityItemView[];
  tombstones: Array<{
    id: string;
    itemId: string;
    scope: CapabilityScope;
    accountRevision: number;
    expiresAt: number;
    createdAt: number;
  }>;
  digest: string;
}

export interface CapabilityAuthorityRecordSet {
  ownerId: string;
  serverId: string;
  revision: number;
  records: CapabilityAuthorityRecord[];
}

/** Complete current binding authority for one authenticated FULL daemon. */
export async function getCapabilityAuthorityRecordSet(
  db: Database,
  params: { ownerUserId: string; serverId: string },
): Promise<CapabilityAuthorityRecordSet> {
  const revision = await currentAccountRevision(db, params.ownerUserId);
  const rows = await db.query<{
    capability_id: string;
    version_id: string;
    binding_id: string;
    authority_state: CapabilityAuthorityState;
    item_revision: number;
    binding_revision: number;
    kind: CapabilityKind;
    authorization_envelope: CapabilitySkillAuthorizationEnvelope | null;
  }>(`
    SELECT cb.item_id AS capability_id, cb.version_id, cb.id AS binding_id,
           cb.authority_state, ci.revision AS item_revision,
           cb.revision AS binding_revision, ci.kind, cb.authorization_envelope
    FROM capability_bindings cb
    JOIN capability_items ci
      ON ci.owner_user_id = cb.owner_user_id AND ci.id = cb.item_id
    WHERE cb.owner_user_id = $1
      AND (
        (cb.scope = 'local' AND cb.server_id = $2)
        OR (cb.scope <> 'local' AND (
          jsonb_array_length(cb.machine_filter) = 0 OR cb.machine_filter ? $2
        ))
      )
    ORDER BY cb.id
  `, [params.ownerUserId, params.serverId]);
  return {
    ownerId: params.ownerUserId,
    serverId: params.serverId,
    revision,
    records: rows.map((row) => ({
      capabilityId: row.capability_id,
      versionId: row.version_id,
      bindingId: row.binding_id,
      state: row.authority_state,
      // Skill authorization is binding-scoped. An unrelated binding mutation
      // may advance the item's display revision without revoking this exact
      // binding/version envelope; the complete AUTHORITY set provides current
      // selection while the signed envelope supplies its own item revision.
      itemRevision: row.kind === CAPABILITY_KIND.SKILL && row.authorization_envelope
        ? row.authorization_envelope.itemRevision
        : row.item_revision,
      bindingRevision: row.binding_revision,
      ...(row.kind === CAPABILITY_KIND.SKILL && row.authorization_envelope
        ? { authorization: row.authorization_envelope }
        : {}),
    })),
  };
}

export async function getCapabilitySyncSnapshot(
  db: Database,
  params: { ownerUserId: string; maxItems: number; afterRevision?: number },
): Promise<CapabilitySyncSnapshotRecord> {
  // A handful of bridge unit tests use intentionally minimal read-only DB
  // doubles. Production Database instances always expose transaction(); keep
  // those doubles useful without weakening the real snapshot boundary.
  if (typeof db.transaction !== 'function') {
    return getCapabilitySyncSnapshotLocked(db, params);
  }
  return db.transaction((tx) => getCapabilitySyncSnapshotLocked(tx, params));
}

async function getCapabilitySyncSnapshotLocked(
  db: Database,
  params: { ownerUserId: string; maxItems: number; afterRevision?: number },
): Promise<CapabilitySyncSnapshotRecord> {
  // Every authority mutation updates this row in the same transaction as its
  // item/blob/tombstone writes. Holding a shared row lock makes the multi-query
  // snapshot a coherent view of exactly this revision under READ COMMITTED.
  const revisionRow = await db.queryOne<{ revision: number }>(`
    SELECT revision FROM capability_account_revisions
    WHERE owner_user_id = $1
    FOR SHARE
  `, [params.ownerUserId]);
  const revision = revisionRow?.revision ?? 0;
  // DELTA frames intentionally carry the bounded current item/version/binding
  // set, not sparse row diffs. Only tombstones use afterRevision filtering;
  // this makes reconnect application deterministic and idempotent.
  const itemRows = await db.query<CapabilityItemRow>(`
    SELECT DISTINCT ${ITEM_COLUMNS.replace(/\b(id|kind|name|lifecycle_state|active_version_id|revision|tombstoned_at|removed_at|created_at|updated_at)\b/g, 'ci.$1')}
    FROM capability_items ci
    JOIN capability_bindings cb ON cb.item_id = ci.id AND cb.owner_user_id = ci.owner_user_id
    WHERE ci.owner_user_id = $1 AND cb.scope <> 'local'
      AND (ci.kind <> 'skill' OR EXISTS (
        SELECT 1
        FROM capability_versions cv
        JOIN capability_blobs cbl
          ON cbl.owner_user_id = cv.owner_user_id
         AND cbl.digest = cv.blob_digest
         AND cbl.storage_state = 'ready'
        WHERE cv.owner_user_id = ci.owner_user_id
          AND cv.item_id = ci.id
          AND cv.id = ci.active_version_id
      ))
    ORDER BY ci.updated_at DESC, ci.id DESC
    LIMIT $2
  `, [params.ownerUserId, params.maxItems + 1]);
  if (itemRows.length > params.maxItems) {
    throw new Error('capability_sync_item_window_exceeded');
  }
  const readyBlobRows = await db.query<{ digest: string }>(`
    SELECT digest FROM capability_blobs
    WHERE owner_user_id = $1 AND storage_state = 'ready'
  `, [params.ownerUserId]);
  const readyBlobDigests = new Set(readyBlobRows.map((row) => row.digest));
  const items: CapabilityItemView[] = [];
  for (const row of itemRows) {
    const item = await hydrateItem(db, params.ownerUserId, row, CAPABILITY_LIMITS.SYNC_VERSIONS);
    if (item.kind === CAPABILITY_KIND.SKILL) {
      const versions = item.versions.filter((version) => (
        version.blobDigest !== null && readyBlobDigests.has(version.blobDigest)
      ));
      const versionIds = new Set(versions.map((version) => version.id));
      items.push({
        ...item,
        versions,
        bindings: item.bindings.filter((binding) => versionIds.has(binding.versionId)),
      });
    } else {
      items.push(item);
    }
  }
  const tombstones = await db.query<{
    id: string; item_id: string; scope: CapabilityScope; account_revision: number; expires_at: number; created_at: number;
  }>(`
    SELECT id, item_id, scope, account_revision, expires_at, created_at
    FROM capability_tombstones
    WHERE owner_user_id = $1 AND scope <> 'local' AND account_revision > $2
    ORDER BY account_revision, id
    LIMIT $3
  `, [params.ownerUserId, params.afterRevision ?? -1, params.maxItems + 1]);
  if (tombstones.length > params.maxItems) {
    throw new Error('capability_sync_tombstone_window_exceeded');
  }
  const snapshotBase = {
    ownerId: params.ownerUserId,
    revision,
    items,
    tombstones: tombstones.map((row) => ({
      id: row.id,
      itemId: row.item_id,
      scope: row.scope,
      accountRevision: row.account_revision,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    })),
  };
  return { ...snapshotBase, digest: sha256Hex(JSON.stringify(snapshotBase)) };
}

export interface CapabilityBlobRecord {
  digest: string;
  objectKey: string;
  byteSize: number;
  state: 'pending' | 'ready' | 'failed' | 'deleted';
  createdAt: number;
  updatedAt: number;
}

export async function registerCapabilityBlob(
  db: Database,
  params: { ownerUserId: string; digest: string; byteSize: number; now?: number },
): Promise<CapabilityBlobRecord> {
  const now = params.now ?? Date.now();
  const ownerPartition = sha256Hex(params.ownerUserId).slice(0, 32);
  const objectKey = `capability-packages/${ownerPartition}/${params.digest}`;
  const row = await db.queryOne<{
    digest: string; object_key: string; byte_size: number; storage_state: CapabilityBlobRecord['state']; created_at: number; updated_at: number;
  }>(`
    INSERT INTO capability_blobs (
      digest, owner_user_id, object_key, byte_size, storage_state, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, 'pending', $5, $5)
    ON CONFLICT (owner_user_id, digest)
    DO UPDATE SET updated_at = EXCLUDED.updated_at
      WHERE capability_blobs.byte_size = EXCLUDED.byte_size
    RETURNING digest, object_key, byte_size, storage_state, created_at, updated_at
  `, [params.digest, params.ownerUserId, objectKey, params.byteSize, now]);
  if (!row) throw new Error('capability_blob_size_conflict');
  return {
    digest: row.digest,
    objectKey: row.object_key,
    byteSize: row.byte_size,
    state: row.storage_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getCapabilityVersionBlobMetadata(
  db: Database,
  params: {
    ownerUserId: string;
    serverId: string;
    capabilityId: string;
    versionId: string;
    action: CapabilityBlobAction;
  },
): Promise<{ blobDigest: string; blobByteSize: number } | null> {
  const row = await db.queryOne<{ blob_digest: string | null; blob_byte_size: number | null }>(`
    SELECT cv.blob_digest, cv.blob_byte_size
    FROM capability_versions cv
    JOIN servers s ON s.id = $4 AND s.user_id = cv.owner_user_id
      AND s.revoked_at IS NULL AND COALESCE(s.node_role, 'full') = 'full'
    WHERE cv.owner_user_id = $1 AND cv.item_id = $2 AND cv.id = $3
      AND (
        ($5 = '${CAPABILITY_BLOB_ACTION.UPLOAD}' AND cv.publication_state = 'pending' AND EXISTS (
          SELECT 1
          FROM capability_pending_activations pa
          JOIN capability_operations co
            ON co.owner_user_id = pa.owner_user_id AND co.id = pa.operation_id
          WHERE pa.owner_user_id = cv.owner_user_id
            AND pa.item_id = cv.item_id AND pa.version_id = cv.id
            AND pa.expires_at > $6
            AND co.state = 'syncing'
            AND co.request_summary->>'targetServerId' = $4
        ))
        OR ($5 = '${CAPABILITY_BLOB_ACTION.DOWNLOAD}' AND EXISTS (
        SELECT 1
        FROM capability_bindings cb
        WHERE cb.owner_user_id = cv.owner_user_id
          AND cb.item_id = cv.item_id
          AND cb.version_id = cv.id
          AND cb.enabled = TRUE
          AND (
            (cb.scope = 'local' AND cb.server_id = $4)
            OR (cb.scope <> 'local' AND (
              jsonb_array_length(cb.machine_filter) = 0
              OR cb.machine_filter ? $4
            ))
          )
        ))
      )
  `, [params.ownerUserId, params.capabilityId, params.versionId, params.serverId, params.action, Date.now()]);
  return row?.blob_digest && row.blob_byte_size
    ? { blobDigest: row.blob_digest, blobByteSize: row.blob_byte_size }
    : null;
}

export async function getCapabilityBlob(
  db: Database,
  params: { ownerUserId: string; digest: string },
): Promise<(CapabilityBlobRecord & { content: Buffer | null }) | null> {
  const row = await db.queryOne<{
    digest: string;
    object_key: string;
    byte_size: number;
    storage_state: CapabilityBlobRecord['state'];
    content: Buffer | null;
    created_at: number;
    updated_at: number;
  }>(`
    SELECT digest, object_key, byte_size, storage_state, content, created_at, updated_at
    FROM capability_blobs
    WHERE owner_user_id = $1 AND digest = $2
  `, [params.ownerUserId, params.digest]);
  return row ? {
    digest: row.digest,
    objectKey: row.object_key,
    byteSize: row.byte_size,
    state: row.storage_state,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

export async function storeCapabilityBlobBytes(
  db: Database,
  params: { ownerUserId: string; digest: string; byteSize: number; content: Buffer; now?: number },
): Promise<{
  stored: boolean;
  accountRevision: number;
  authorizationOperationIds: string[];
}> {
  const now = params.now ?? Date.now();
  return db.transaction(async (tx) => {
    const row = await tx.queryOne<{ digest: string }>(`
      UPDATE capability_blobs
      SET content = $4, storage_state = 'ready', updated_at = $5
      WHERE owner_user_id = $1 AND digest = $2 AND byte_size = $3
        AND storage_state IN ('pending', 'failed')
      RETURNING digest
    `, [params.ownerUserId, params.digest, params.byteSize, params.content, now]);
    if (!row) {
      return {
        stored: false,
        accountRevision: await currentAccountRevision(tx, params.ownerUserId),
        authorizationOperationIds: [],
      };
    }
    const ready = await tx.query<{ operation_id: string }>(`
      UPDATE capability_pending_activations pa
      SET blob_ready = TRUE
      FROM capability_versions cv, capability_operations co
      WHERE pa.owner_user_id = $1
        AND cv.owner_user_id = pa.owner_user_id
        AND cv.item_id = pa.item_id
        AND cv.id = pa.version_id
        AND cv.blob_digest = $2
        AND cv.publication_state = 'pending'
        AND co.owner_user_id = pa.owner_user_id
        AND co.id = pa.operation_id
        AND co.state = 'syncing'
        AND co.artifact_digest = cv.artifact_digest
        AND co.audit_digest = cv.audit_digest
        AND pa.expires_at > $3
      RETURNING pa.operation_id
    `, [params.ownerUserId, params.digest, now]);
    return {
      stored: true,
      accountRevision: await currentAccountRevision(tx, params.ownerUserId),
      authorizationOperationIds: ready.map((entry) => entry.operation_id),
    };
  });
}

export async function recordCapabilityBlobToken(
  db: Database,
  params: {
    jti: string;
    ownerUserId: string;
    serverId: string;
    capabilityId: string;
    versionId: string;
    action: 'upload' | 'download';
    blobDigest: string;
    expiresAt: number;
    now?: number;
  },
): Promise<boolean> {
  const now = params.now ?? Date.now();
  const result = await db.execute(`
    INSERT INTO capability_blob_tokens (
      jti, owner_user_id, server_id, capability_id, version_id, action,
      blob_digest, expires_at, created_at
    )
    SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
    WHERE EXISTS (
      SELECT 1 FROM servers
      WHERE id = $3 AND user_id = $2 AND revoked_at IS NULL
        AND COALESCE(node_role, 'full') = 'full'
    )
  `, [
    params.jti, params.ownerUserId, params.serverId, params.capabilityId,
    params.versionId, params.action, params.blobDigest, params.expiresAt, now,
  ]);
  return result.changes === 1;
}

export async function consumeCapabilityBlobToken(
  db: Database,
  params: {
    jti: string;
    ownerUserId: string;
    serverId: string;
    capabilityId: string;
    versionId: string;
    action: 'upload' | 'download';
    blobDigest: string;
    now?: number;
  },
): Promise<boolean> {
  const now = params.now ?? Date.now();
  const row = await db.queryOne<{ jti: string }>(`
    UPDATE capability_blob_tokens
    SET consumed_at = $8
    WHERE jti = $1 AND owner_user_id = $2 AND server_id = $3
      AND capability_id = $4 AND version_id = $5 AND action = $6
      AND blob_digest = $7 AND consumed_at IS NULL AND expires_at > $8
    RETURNING jti
  `, [
    params.jti, params.ownerUserId, params.serverId, params.capabilityId,
    params.versionId, params.action, params.blobDigest, now,
  ]);
  return row?.jti === params.jti;
}
