import {
  REMOTE_DESKTOP_OUTBOX_EFFECT,
  REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND,
  REMOTE_DESKTOP_OUTBOX_SCOPE,
  REMOTE_DESKTOP_PRIVACY_PHASE,
  containsRemoteDesktopSecretField,
  type RemoteDesktopOutboxEvent,
  type RemoteDesktopOutboxEventWithoutSequence,
  type RemoteDesktopOutboxEffect,
} from '../../../shared/remote-desktop-access.js';
import type {
  RemoteDesktopPresentationSource,
  RemoteDesktopPrivacyPhase,
} from '../../../shared/remote-desktop-access.js';
import type { Database } from '../db/client.js';

export const REMOTE_DESKTOP_GUEST_OUTBOX_CHANNEL = 'remote_desktop_guest_outbox';

type JsonRecord = Record<string, unknown>;

const OUTBOX_EVENT_COMMON_KEYS = [
  'idempotencyKey',
  'sequence',
  'effect',
  'scope',
  'hostId',
  'targetServerId',
  'actorAuditId',
  'routeGeneration',
] as const;

const LINK_AUTHORITY_KEYS = [
  'authorityKind',
  'authorityGeneration',
  'expiryRevision',
  'commitRevision',
] as const;

const PASSWORD_AUTHORITY_KEYS = [
  'authorityKind',
  'sessionAuditId',
  'passwordGeneration',
] as const;

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Strict runtime firewall for the shared task-2.7 outbox contract. */
export function parseRemoteDesktopOutboxEvent(value: unknown): RemoteDesktopOutboxEvent {
  const event = asRecord(value);
  if (!event || containsRemoteDesktopSecretField(event)) throw new Error('invalid_outbox_payload');
  if (!Object.values(REMOTE_DESKTOP_OUTBOX_EFFECT).includes(event.effect as RemoteDesktopOutboxEffect)) {
    throw new Error('invalid_outbox_effect');
  }
  const effect = event.effect as RemoteDesktopOutboxEffect;
  const authorityKind = event.authorityKind;
  const expectedKeys = authorityKind === REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.LINK
    ? [
      ...OUTBOX_EVENT_COMMON_KEYS,
      ...LINK_AUTHORITY_KEYS,
      ...(effect === REMOTE_DESKTOP_OUTBOX_EFFECT.DEADLINE_UPDATE ? ['deadlineAt'] : []),
    ]
    : authorityKind === REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.PASSWORD
      ? [...OUTBOX_EVENT_COMMON_KEYS, ...PASSWORD_AUTHORITY_KEYS]
      : null;
  if (!expectedKeys) throw new Error('invalid_outbox_authority');
  if (!hasExactKeys(event, expectedKeys)) throw new Error('invalid_outbox_keys');
  if (
    typeof event.idempotencyKey !== 'string' || event.idempotencyKey.length === 0
    || typeof event.hostId !== 'string' || event.hostId.length === 0
    || typeof event.actorAuditId !== 'string' || event.actorAuditId.length === 0
    || !isPositiveInteger(event.sequence)
    || (effect === REMOTE_DESKTOP_OUTBOX_EFFECT.DEADLINE_UPDATE
      && (typeof event.deadlineAt !== 'number'
        || !Number.isSafeInteger(event.deadlineAt)
        || event.deadlineAt < 0))
  ) throw new Error('invalid_outbox_payload');
  if (authorityKind === REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.LINK) {
    if (!isPositiveInteger(event.authorityGeneration)
      || !isPositiveInteger(event.expiryRevision)
      || !isPositiveInteger(event.commitRevision)) throw new Error('invalid_outbox_payload');
  } else if (effect !== REMOTE_DESKTOP_OUTBOX_EFFECT.TERMINAL
    || event.scope !== REMOTE_DESKTOP_OUTBOX_SCOPE.ROUTE
    || typeof event.sessionAuditId !== 'string' || event.sessionAuditId.length === 0
    || !isPositiveInteger(event.passwordGeneration)) {
    throw new Error('invalid_outbox_payload');
  }
  if (event.scope === REMOTE_DESKTOP_OUTBOX_SCOPE.ROUTE) {
    if (typeof event.targetServerId !== 'string' || event.targetServerId.length === 0
      || !isNonNegativeInteger(event.routeGeneration)) throw new Error('invalid_outbox_payload');
  } else if (event.scope === REMOTE_DESKTOP_OUTBOX_SCOPE.HOST) {
    if (authorityKind !== REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.LINK
      || effect !== REMOTE_DESKTOP_OUTBOX_EFFECT.TERMINAL
      || event.targetServerId !== null || event.routeGeneration !== null) {
      throw new Error('invalid_outbox_payload');
    }
  } else {
    throw new Error('invalid_outbox_payload');
  }
  return event as unknown as RemoteDesktopOutboxEvent;
}

export interface CreateGuestLinkRowInput {
  id: string;
  hostId: string;
  ownerUserId: string;
  tokenHash: string;
  creationRequestId: string;
  normalizedPolicyHash: string;
  label: string;
  attendance: 'attended' | 'unattended';
  accessMode: 'view' | 'control';
  usePolicy: 'single_use' | 'reusable';
  expiresAt: number | null;
  now: number;
}

export interface BeginPrivacyEpochInput {
  hostId: string;
  epochId: string;
  presentationSource: RemoteDesktopPresentationSource;
  initiatingSessionHash: string;
  executionServerId: string;
  daemonGeneration: number;
  routeSnapshot: readonly unknown[];
  leaseExpiresAt: number;
  deadline: number;
  now: number;
}

export interface CurrentPrivacyEpoch {
  epochId: string;
  revision: number;
  phase: RemoteDesktopPrivacyPhase;
  presentationSource: RemoteDesktopPresentationSource;
}

interface PrivacyRow {
  epoch_id: string | null;
  revision: number;
  phase: string;
  presentation_source: string | null;
  admission_open: boolean;
}

function assertSafeTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid_${name}`);
}

/**
 * Install the host's privacy gate in the same caller-owned transaction that
 * snapshots admission. Only an idle host can begin a new epoch; a failed or
 * abandoned epoch must be recovered rather than overwritten.
 */
export async function beginManagementPrivacyEpochTx(
  tx: Database,
  input: BeginPrivacyEpochInput,
): Promise<CurrentPrivacyEpoch> {
  assertSafeTimestamp(input.leaseExpiresAt, 'privacy_lease');
  assertSafeTimestamp(input.deadline, 'privacy_deadline');
  assertSafeTimestamp(input.now, 'privacy_time');
  const row = await tx.queryOne<PrivacyRow>(
    `INSERT INTO remote_desktop_management_privacy (
       host_id, epoch_id, revision, phase, admission_open,
       presentation_source, initiating_session_hash, execution_server_id,
       daemon_generation, route_snapshot, acknowledged_routes,
       lease_expires_at, deadline, created_at, updated_at
     ) VALUES ($1, $2, 1, 'starting', FALSE, $3, $4, $5, $6, $7::jsonb,
               '[]'::jsonb, $8, $9, $10, $10)
     ON CONFLICT (host_id) DO UPDATE SET
       epoch_id = EXCLUDED.epoch_id,
       revision = remote_desktop_management_privacy.revision + 1,
       phase = 'starting', admission_open = FALSE,
       presentation_source = EXCLUDED.presentation_source,
       initiating_session_hash = EXCLUDED.initiating_session_hash,
       execution_server_id = EXCLUDED.execution_server_id,
       daemon_generation = EXCLUDED.daemon_generation,
       worker_generation = NULL,
       route_snapshot = EXCLUDED.route_snapshot,
       acknowledged_routes = '[]'::jsonb,
       lease_expires_at = EXCLUDED.lease_expires_at,
       deadline = EXCLUDED.deadline,
       recovery_reason = NULL,
       fresh_frame_generation = NULL,
       updated_at = EXCLUDED.updated_at
     WHERE remote_desktop_management_privacy.phase = 'idle'
       AND remote_desktop_management_privacy.admission_open = TRUE
     RETURNING epoch_id, revision, phase, presentation_source, admission_open`,
    [
      input.hostId,
      input.epochId,
      input.presentationSource,
      input.initiatingSessionHash,
      input.executionServerId,
      input.daemonGeneration,
      JSON.stringify(input.routeSnapshot),
      input.leaseExpiresAt,
      input.deadline,
      input.now,
    ],
  );
  if (!row || row.epoch_id !== input.epochId || row.admission_open) {
    throw new Error('privacy_epoch_busy');
  }
  return {
    epochId: row.epoch_id,
    revision: row.revision,
    phase: row.phase as CurrentPrivacyEpoch['phase'],
    presentationSource: row.presentation_source as CurrentPrivacyEpoch['presentationSource'],
  };
}

/** Lock and verify the exact shielded epoch before any secret-bearing write. */
export async function requireShieldedPrivacyEpochTx(
  tx: Database,
  input: { hostId: string; epochId: string; revision: number; now: number },
): Promise<CurrentPrivacyEpoch> {
  const row = await tx.queryOne<PrivacyRow>(
    `SELECT epoch_id, revision, phase, presentation_source, admission_open
       FROM remote_desktop_management_privacy
      WHERE host_id = $1
      FOR UPDATE`,
    [input.hostId],
  );
  if (
    !row
    || row.epoch_id !== input.epochId
    || row.revision !== input.revision
    || row.phase !== REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE
    || row.admission_open
  ) {
    throw new Error('privacy_epoch_not_shielded');
  }
  return {
    epochId: row.epoch_id,
    revision: row.revision,
    phase: REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE,
    presentationSource: row.presentation_source as CurrentPrivacyEpoch['presentationSource'],
  };
}

/**
 * Persist a hash-only link and its due record. The caller owns the surrounding
 * transaction that consumes step-up and verifies the privacy epoch.
 */
export async function createGuestLinkRowsTx(
  tx: Database,
  input: CreateGuestLinkRowInput,
): Promise<void> {
  assertSafeTimestamp(input.now, 'link_time');
  if (input.attendance === 'unattended') {
    if (input.expiresAt === null) throw new Error('missing_link_expiry');
    assertSafeTimestamp(input.expiresAt, 'link_expiry');
  } else if (input.expiresAt !== null) {
    throw new Error('attended_link_has_expiry');
  }

  await tx.execute(
    `INSERT INTO remote_desktop_guest_links (
       id, host_id, owner_user_id, token_hash_version, token_hash,
       creation_request_id, normalized_policy_hash, label, attendance,
       access_mode, use_policy, expires_at, authority_generation, expiry_revision,
       state, created_at, updated_at
     ) VALUES ($1, $2, $3, 'v1', $4, $5, $6, $7, $8, $9, $10, $11, 1, 1,
               'active', $12, $12)`,
    [
      input.id,
      input.hostId,
      input.ownerUserId,
      input.tokenHash,
      input.creationRequestId,
      input.normalizedPolicyHash,
      input.label,
      input.attendance,
      input.accessMode,
      input.usePolicy,
      input.expiresAt,
      input.now,
    ],
  );
  if (input.expiresAt !== null) {
    await replaceExpiryDueTx(tx, {
      linkId: input.id,
      expiryRevision: 1,
      expiresAt: input.expiresAt,
      now: input.now,
    });
  }
}

export async function replaceExpiryDueTx(tx: Database, input: {
  linkId: string;
  expiryRevision: number;
  expiresAt: number;
  now: number;
}): Promise<void> {
  assertSafeTimestamp(input.expiresAt, 'link_expiry');
  assertSafeTimestamp(input.now, 'link_time');
  // Two statements, two calls: `pg` uses the extended query protocol whenever
  // parameters are supplied, and that protocol rejects multiple commands in one
  // prepared statement. Both run inside the caller's transaction, so the
  // supersede-then-insert pair is still atomic.
  await tx.execute(
    `UPDATE remote_desktop_guest_expiry_due
        SET state = 'stale', claimed_by = NULL, claim_expires_at = NULL,
            updated_at = $3
      WHERE link_id = $1 AND expiry_revision <> $2
        AND state IN ('pending', 'claimed')`,
    [input.linkId, input.expiryRevision, input.now],
  );
  await tx.execute(
    `INSERT INTO remote_desktop_guest_expiry_due (
       link_id, expiry_revision, expires_at, state, created_at, updated_at
     ) VALUES ($1, $2, $4, 'pending', $3, $3)
     ON CONFLICT (link_id, expiry_revision) DO UPDATE SET
       expires_at = EXCLUDED.expires_at, state = 'pending',
       claimed_by = NULL, claim_expires_at = NULL, updated_at = EXCLUDED.updated_at`,
    [input.linkId, input.expiryRevision, input.now, input.expiresAt],
  );
}

/** Allocate one monotonic host sequence and append a typed effect atomically. */
export async function appendGuestEffectTx(tx: Database, input: {
  id: string;
  targetRouteId: string | null;
  event: RemoteDesktopOutboxEventWithoutSequence;
  now: number;
  sloAnchorAt: number;
  retainUntil: number;
}): Promise<number> {
  assertSafeTimestamp(input.now, 'effect_time');
  assertSafeTimestamp(input.sloAnchorAt, 'effect_slo_anchor');
  assertSafeTimestamp(input.retainUntil, 'effect_retention');
  if (input.sloAnchorAt > input.now) throw new Error('effect_slo_anchor_in_future');
  const provisionalEvent = parseRemoteDesktopOutboxEvent({ ...input.event, sequence: 1 });
  const { sequence: _provisionalSequence, ...eventBase } = provisionalEvent;
  const eventWithoutSequence = JSON.stringify(eventBase);
  const existing = await tx.queryOne<{ sequence: number }>(
    `SELECT sequence FROM remote_desktop_guest_outbox
      WHERE idempotency_key = $1 AND host_id = $2 AND effect_type = $3
        AND payload - 'sequence' = $4::jsonb
      FOR UPDATE`,
    [eventBase.idempotencyKey, eventBase.hostId, eventBase.effect, eventWithoutSequence],
  );
  if (existing) return existing.sequence;
  const sequenceRow = await tx.queryOne<{ sequence: number }>(
    `INSERT INTO remote_desktop_host_effect_sequences (host_id, next_sequence)
     VALUES ($1, 2)
     ON CONFLICT (host_id) DO UPDATE SET
       next_sequence = remote_desktop_host_effect_sequences.next_sequence + 1
     RETURNING next_sequence - 1 AS sequence`,
    [eventBase.hostId],
  );
  if (!sequenceRow) throw new Error('effect_sequence_unavailable');
  const event = parseRemoteDesktopOutboxEvent({
    ...eventBase,
    sequence: sequenceRow.sequence,
  });
  const payload = JSON.stringify(event);
  const inserted = await tx.queryOne<{ sequence: number }>(
    `INSERT INTO remote_desktop_guest_outbox (
       id, idempotency_key, host_id, target_server_id, target_route_id,
       target_route_generation, sequence, effect_type, payload, state,
       created_at, available_at, slo_anchor_at, retain_until
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'pending',
               $10, $10, $11, $12)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING sequence`,
    [
      input.id,
      event.idempotencyKey,
      event.hostId,
      event.targetServerId,
      input.targetRouteId,
      event.routeGeneration,
      event.sequence,
      event.effect,
      payload,
      input.now,
      input.sloAnchorAt,
      input.retainUntil,
    ],
  );
  if (inserted) {
    // pg_notify is transactional: rolled-back authority mutations produce no
    // wake-up, while committed rows wake the dedicated listener. Polling is
    // still authoritative and covers lost notifications or listener restart.
    await tx.execute('SELECT pg_notify($1, $2)', [
      REMOTE_DESKTOP_GUEST_OUTBOX_CHANNEL,
      event.hostId,
    ]);
    return inserted.sequence;
  }
  const raced = await tx.queryOne<{ sequence: number }>(
    `SELECT sequence FROM remote_desktop_guest_outbox
      WHERE idempotency_key = $1 AND host_id = $2 AND effect_type = $3
        AND payload - 'sequence' = $4::jsonb
      FOR UPDATE`,
    [event.idempotencyKey, event.hostId, event.effect, eventWithoutSequence],
  );
  if (!raced) throw new Error('effect_idempotency_conflict');
  return raced.sequence;
}
