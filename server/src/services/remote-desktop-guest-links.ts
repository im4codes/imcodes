/**
 * Owner link authority: create, list, mutate, claim, resume.
 *
 * Three rules shape everything here.
 *
 * 1. The Server never sees a raw bearer. The client generates 32 CSPRNG bytes,
 *    hashes them under the frozen domain-separated preimage, and sends only the
 *    hash. A database read therefore yields no usable credential.
 * 2. Every authority mutation re-verifies Owner, canonical host and a currently
 *    shielded privacy epoch inside one transaction. The ordinary management Web
 *    may create under its current Owner account session; signed-shell creation
 *    and every narrowing mutation additionally consume an action-bound step-up.
 * 3. Mutations only ever narrow authority, and each narrowing advances exactly
 *    the counter that describes it: Control-to-View advances
 *    `authorityGeneration` (derived routes die), expiry shortening advances
 *    only `expiryRevision` (a live route survives to the earlier deadline), and
 *    a label edit advances neither.
 *
 * NOT WIRED to the Router. Guest routes are not admitted from here; the actor
 * side of admission is a separate track. Everything below is callable and
 * tested, but nothing dispatches to a daemon.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/client.js';
import {
  REMOTE_DESKTOP_ACTOR_SOURCE,
  REMOTE_DESKTOP_LINK_KIND,
  REMOTE_DESKTOP_LINK_USE_POLICY,
  REMOTE_DESKTOP_LINK_MUTATION,
  REMOTE_DESKTOP_LINK_TOKEN,
  REMOTE_DESKTOP_OUTBOX_EFFECT,
  REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND,
  REMOTE_DESKTOP_OUTBOX_SCOPE,
  isCanonicalRemoteDesktopCreationRequestId,
  isMonotonicRemoteDesktopLinkMutation,
  isRemoteDesktopLinkTokenHash,
} from '../../../shared/remote-desktop-access.js';
import { REMOTE_DESKTOP_ACCESS_MODE } from '../../../shared/remote-desktop.js';
import type { RemoteDesktopAccessMode } from '../../../shared/remote-desktop.js';
import type {
  RemoteDesktopLinkKind,
  RemoteDesktopLinkMutation,
  RemoteDesktopLinkPolicy,
  RemoteDesktopLinkUsePolicy,
} from '../../../shared/remote-desktop-access.js';
import {
  consumeActionBoundStepUpGrant,
  type AccountSession,
} from './remote-desktop-account-auth.js';
import {
  appendGuestEffectTx,
  createGuestLinkRowsTx,
  replaceExpiryDueTx,
} from './remote-desktop-guest-authority.js';
import { requireShieldedEpochTx } from './remote-desktop-management-privacy.js';

/**
 * One generic refusal class per failure family. Callers map these to a single
 * client-facing shape; a caller must not be able to tell "not your host" from
 * "no such link" by probing.
 */
export const LINK_REFUSAL = {
  UNAUTHORIZED: 'unauthorized',
  CONFLICT: 'conflict',
  INVALID: 'invalid',
  NOT_FOUND: 'not_found',
  PRIVACY_REQUIRED: 'privacy_required',
  STEP_UP_REQUIRED: 'step_up_required',
} as const;
export type LinkRefusal = (typeof LINK_REFUSAL)[keyof typeof LINK_REFUSAL];

export class LinkAuthorityError extends Error {
  constructor(readonly refusal: LinkRefusal) {
    super(refusal);
    this.name = 'LinkAuthorityError';
  }
}

/** Non-secret identity metadata. Never carries the hash or any bearer. */
export interface OwnerLinkConnectionAuditEntry {
  ipAddress: string;
  connectedAt: number;
  disconnectedAt: number | null;
  durationMs: number;
}

export interface OwnerLinkConnectionAudit {
  connectionCount: number;
  totalDurationMs: number;
  lastConnectedAt: number | null;
  recentConnections: OwnerLinkConnectionAuditEntry[];
}

export interface OwnerLinkView {
  id: string;
  hostId: string;
  label: string;
  kind: RemoteDesktopLinkKind;
  mode: RemoteDesktopAccessMode;
  usePolicy: RemoteDesktopLinkUsePolicy;
  expiresAt: number | null;
  authorityGeneration: number;
  expiryRevision: number;
  commitRevision: number;
  state: 'active' | 'revoked' | 'expired';
  claimed: boolean;
  createdAt: number;
  connectionAudit: OwnerLinkConnectionAudit;
}

interface LinkRow {
  id: string;
  host_id: string;
  owner_user_id: string;
  token_hash: string;
  creation_request_id: string;
  normalized_policy_hash: string;
  label: string;
  attendance: string;
  access_mode: string;
  use_policy: string;
  expires_at: number | null;
  authority_generation: number;
  expiry_revision: number;
  commit_revision: number;
  state: string;
  created_at: number;
}

const LINK_COLUMNS = `id, host_id, owner_user_id, token_hash, creation_request_id,
  normalized_policy_hash, label, attendance, access_mode, use_policy, expires_at,
  authority_generation, expiry_revision, commit_revision, state, created_at`;

function emptyConnectionAudit(): OwnerLinkConnectionAudit {
  return {
    connectionCount: 0,
    totalDurationMs: 0,
    lastConnectedAt: null,
    recentConnections: [],
  };
}

function toView(
  row: LinkRow,
  claimed: boolean,
  connectionAudit: OwnerLinkConnectionAudit = emptyConnectionAudit(),
): OwnerLinkView {
  return {
    id: row.id,
    hostId: row.host_id,
    label: row.label,
    kind: row.attendance as RemoteDesktopLinkKind,
    mode: row.access_mode as RemoteDesktopAccessMode,
    usePolicy: row.use_policy as RemoteDesktopLinkUsePolicy,
    expiresAt: row.expires_at,
    authorityGeneration: row.authority_generation,
    expiryRevision: row.expiry_revision,
    commitRevision: row.commit_revision,
    state: row.state as OwnerLinkView['state'],
    claimed,
    createdAt: row.created_at,
    connectionAudit,
  };
}

/**
 * Deterministic hash of the complete committed policy.
 *
 * An exact retry is only exact if every normative field matches, so the digest
 * covers all of them in a fixed order. Two spellings of one policy must not
 * hash alike, and one spelling must not hash two ways across pods.
 */
export function hashLinkPolicy(policy: RemoteDesktopLinkPolicy): string {
  const canonical = JSON.stringify([
    policy.hostId, policy.kind, policy.mode,
    ...(policy.usePolicy === undefined ? [] : [policy.usePolicy]),
    policy.durationMs ?? null, policy.label,
  ]);
  return createHash('sha256')
    .update('imcodes.remote-desktop.link-policy.v1', 'utf8')
    .update(Buffer.from([0]))
    .update(canonical, 'utf8')
    .digest('hex');
}

/** Server-side hash of a browser key thumbprint. Thumbprints are not secrets, but storing them raw invites reuse as an identifier elsewhere. */
export function hashBrowserKey(thumbprint: string): string {
  return createHash('sha256')
    .update('imcodes.remote-desktop.browser-key.v1', 'utf8')
    .update(Buffer.from([0]))
    .update(thumbprint, 'utf8')
    .digest('hex');
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

async function assertOwnedHostTx(tx: Database, hostId: string, ownerUserId: string): Promise<void> {
  const row = await tx.queryOne<{ owner_user_id: string }>(
    'SELECT owner_user_id FROM remote_desktop_hosts WHERE id = $1',
    [hostId],
  );
  // Same refusal for "no such host" and "not yours": ownership must not be
  // probeable through the difference.
  if (!row || row.owner_user_id !== ownerUserId) {
    throw new LinkAuthorityError(LINK_REFUSAL.UNAUTHORIZED);
  }
}

export interface PrivacyEpochRef { epochId: string; revision: number }

export interface CreateLinkInput {
  ownerUserId: string;
  accountSession: AccountSession;
  /** Required for the signed native shell; ordinary Web Owner creation uses the current account session. */
  stepUpToken?: string;
  hostId: string;
  creationRequestId: string;
  tokenHashVersion: typeof REMOTE_DESKTOP_LINK_TOKEN.HASH_VERSION;
  tokenHash: string;
  kind: RemoteDesktopLinkKind;
  mode: RemoteDesktopAccessMode;
  usePolicy?: RemoteDesktopLinkUsePolicy;
  label: string;
  durationMs?: number;
  privacy: PrivacyEpochRef;
  now: number;
}

/**
 * Create exactly one link plus its due row, or return the original result.
 *
 * Idempotency is keyed on (owner, host, creationRequestId) *and* verified
 * against the stored token hash and full-policy digest. A retry that matches
 * everything replays the same non-secret metadata; a retry that changed any
 * normative field is a conflict, not a second link — otherwise a lost response
 * could be turned into two live authorities.
 */
export async function createGuestLink(
  db: Database,
  input: CreateLinkInput,
): Promise<{ link: OwnerLinkView; replayed: boolean }> {
  if (!isCanonicalRemoteDesktopCreationRequestId(input.creationRequestId)
    || !isRemoteDesktopLinkTokenHash(input.tokenHash)
    || input.tokenHashVersion !== REMOTE_DESKTOP_LINK_TOKEN.HASH_VERSION) {
    throw new LinkAuthorityError(LINK_REFUSAL.INVALID);
  }
  const isUnattended = input.kind === REMOTE_DESKTOP_LINK_KIND.UNATTENDED;
  if (isUnattended !== (input.durationMs !== undefined)) {
    throw new LinkAuthorityError(LINK_REFUSAL.INVALID);
  }

  const policy: RemoteDesktopLinkPolicy = {
    hostId: input.hostId, kind: input.kind, mode: input.mode,
    usePolicy: input.usePolicy, durationMs: input.durationMs, label: input.label,
  };
  const policyHash = hashLinkPolicy(policy);

  if (input.ownerUserId !== input.accountSession.userId) {
    throw new LinkAuthorityError(LINK_REFUSAL.UNAUTHORIZED);
  }

  const createTx = async (tx: Database): Promise<{ link: OwnerLinkView; replayed: boolean }> => {
    await assertOwnedHostTx(tx, input.hostId, input.ownerUserId);
    // The barrier must be authoritative at the moment of commit, not merely
    // at the moment the client opened its dialog.
    await requirePrivacyTx(tx, input.hostId, input.privacy);

    const existing = await findExistingCreateTx(tx, input, policyHash);
    if (existing) return { link: existing, replayed: true };

    const id = randomUUID();
    // A duration is committed to an absolute expiry once, here, so a retry
    // recovers the original deadline rather than recomputing a later one.
    const expiresAt = input.durationMs === undefined ? null : input.now + input.durationMs;
    await createGuestLinkRowsTx(tx, {
      id,
      hostId: input.hostId,
      ownerUserId: input.ownerUserId,
      tokenHash: input.tokenHash,
      creationRequestId: input.creationRequestId,
      normalizedPolicyHash: policyHash,
      label: input.label,
      attendance: input.kind,
      accessMode: input.mode,
      usePolicy: input.usePolicy ?? REMOTE_DESKTOP_LINK_USE_POLICY.REUSABLE,
      expiresAt,
      now: input.now,
    });

    const row = await tx.queryOne<LinkRow>(
      `SELECT ${LINK_COLUMNS} FROM remote_desktop_guest_links WHERE id = $1`, [id],
    );
    if (!row) throw new LinkAuthorityError(LINK_REFUSAL.CONFLICT);
    return { link: toView(row, false), replayed: false };
  };

  if (input.accountSession.kind === 'web' && !input.stepUpToken) {
    return db.transaction(createTx);
  }

  if (!input.stepUpToken) {
    throw new LinkAuthorityError(LINK_REFUSAL.STEP_UP_REQUIRED);
  }

  const used = await consumeActionBoundStepUpGrant<{ link: OwnerLinkView; replayed: boolean }>(
    db,
    {
      token: input.stepUpToken,
      accountSession: input.accountSession,
      canonicalHostId: input.hostId,
      action: {
        kind: 'remote_desktop.link.create',
        hostId: input.hostId,
        creationRequestId: input.creationRequestId,
        tokenHash: input.tokenHash,
        policyHash,
      },
      requestId: input.creationRequestId,
    },
    createTx,
    input.now,
  );

  if (!used.ok) throw new LinkAuthorityError(LINK_REFUSAL.STEP_UP_REQUIRED);
  return {
    link: used.result.link,
    replayed: used.replayed || used.result.replayed,
  };
}

async function findExistingCreateTx(
  tx: Database,
  input: CreateLinkInput,
  policyHash: string,
): Promise<OwnerLinkView | null> {
  const byRequest = await tx.queryOne<LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM remote_desktop_guest_links
      WHERE owner_user_id = $1 AND host_id = $2 AND creation_request_id = $3`,
    [input.ownerUserId, input.hostId, input.creationRequestId],
  );
  if (byRequest) {
    // Exact retry only. Any changed normative field is a conflict.
    if (!constantTimeEqualHex(byRequest.token_hash, input.tokenHash)
      || byRequest.normalized_policy_hash !== policyHash) {
      throw new LinkAuthorityError(LINK_REFUSAL.CONFLICT);
    }
    return toView(byRequest, await isClaimedTx(tx, byRequest.id));
  }

  // A hash reused under a different request, owner or host is a collision, not
  // a retry. It must never alias two authorities onto one secret.
  const byHash = await tx.queryOne<{ id: string }>(
    'SELECT id FROM remote_desktop_guest_links WHERE token_hash = $1',
    [input.tokenHash],
  );
  if (byHash) throw new LinkAuthorityError(LINK_REFUSAL.CONFLICT);
  return null;
}

async function isClaimedTx(tx: Database, linkId: string): Promise<boolean> {
  const row = await tx.queryOne<{ link_id: string }>(
    'SELECT link_id FROM remote_desktop_guest_browser_claims WHERE link_id = $1', [linkId],
  );
  return row !== null;
}

async function requirePrivacyTx(tx: Database, hostId: string, privacy: PrivacyEpochRef): Promise<void> {
  try {
    await requireShieldedEpochTx(tx, {
      hostId, epochId: privacy.epochId, revision: privacy.revision,
    });
  } catch {
    throw new LinkAuthorityError(LINK_REFUSAL.PRIVACY_REQUIRED);
  }
}

/** Owner-only inventory. Returns non-secret metadata for one canonical host. */
export async function listOwnerLinks(
  db: Database,
  input: { ownerUserId: string; hostId: string; limit?: number; now?: number },
): Promise<OwnerLinkView[]> {
  await db.transaction((tx) => assertOwnedHostTx(tx, input.hostId, input.ownerUserId));
  const now = input.now ?? Date.now();
  const rows = await db.query<LinkRow & {
    claimed: boolean;
    connection_count: number | string;
    total_duration_ms: number | string;
    last_connected_at: number | null;
  }>(
    `SELECT ${LINK_COLUMNS.split(', ').map((c) => `l.${c.trim()}`).join(', ')},
            EXISTS (
              SELECT 1 FROM remote_desktop_guest_browser_claims c WHERE c.link_id = l.id
            ) AS claimed,
            audit.connection_count, audit.total_duration_ms, audit.last_connected_at
       FROM remote_desktop_guest_links l
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS connection_count,
                COALESCE(SUM(GREATEST(0, COALESCE(s.closed_at, $4) - s.connected_at)), 0)
                  AS total_duration_ms,
                MAX(s.connected_at) AS last_connected_at
           FROM remote_desktop_guest_sessions s
          WHERE s.link_id = l.id AND s.connected_at IS NOT NULL
       ) audit ON TRUE
      WHERE l.owner_user_id = $1 AND l.host_id = $2
      ORDER BY l.created_at DESC
      LIMIT $3`,
    [input.ownerUserId, input.hostId, Math.min(input.limit ?? 100, 200), now],
  );
  if (rows.length === 0) return [];

  const recentRows = await db.query<{
    link_id: string;
    source_ip: string;
    connected_at: number;
    closed_at: number | null;
    duration_ms: number | string;
  }>(
    `SELECT link_id, host(source_ip) AS source_ip, connected_at, closed_at,
            GREATEST(0, COALESCE(closed_at, $1) - connected_at) AS duration_ms
       FROM (
         SELECT link_id, source_ip, connected_at, closed_at,
                ROW_NUMBER() OVER (PARTITION BY link_id ORDER BY connected_at DESC) AS audit_rank
           FROM remote_desktop_guest_sessions
          WHERE link_id = ANY($2::text[]) AND connected_at IS NOT NULL AND source_ip IS NOT NULL
       ) recent
      WHERE audit_rank <= 20
      ORDER BY connected_at DESC`,
    [now, rows.map((row) => row.id)],
  );
  const recentByLink = new Map<string, OwnerLinkConnectionAuditEntry[]>();
  for (const row of recentRows) {
    const recent = recentByLink.get(row.link_id) ?? [];
    recent.push({
      ipAddress: row.source_ip,
      connectedAt: row.connected_at,
      disconnectedAt: row.closed_at,
      durationMs: Number(row.duration_ms),
    });
    recentByLink.set(row.link_id, recent);
  }
  return rows.map((row) => toView(row, row.claimed, {
    connectionCount: Number(row.connection_count),
    totalDurationMs: Number(row.total_duration_ms),
    lastConnectedAt: row.last_connected_at,
    recentConnections: recentByLink.get(row.id) ?? [],
  }));
}

export interface MutateLinkInput {
  ownerUserId: string;
  accountSession: AccountSession;
  stepUpToken: string;
  requestId: string;
  hostId: string;
  linkId: string;
  mutation: RemoteDesktopLinkMutation;
  label?: string;
  /** Absolute, and strictly earlier than the current expiry. */
  expiresAt?: number;
  privacy: PrivacyEpochRef;
  now: number;
  /** Retention horizon for any emitted outbox effect. */
  retainUntil: number;
}

export interface MutateLinkResult {
  link: OwnerLinkView;
  /** How many outbox effects this mutation actually produced. Zero is explicit. */
  effectsEmitted: number;
}

/**
 * Apply exactly one narrowing mutation.
 *
 * Which counter advances is the whole contract:
 *   set_label       — neither. A rename must not kill a live session.
 *   reduce_to_view  — authorityGeneration. Derived Control routes are invalid.
 *   shorten_expiry  — expiryRevision, plus a replaced due row and a
 *                     non-terminal deadline update. A live route keeps running
 *                     to the earlier deadline.
 *   revoke          — authorityGeneration, plus a terminal effect.
 */
export async function mutateGuestLink(
  db: Database,
  input: MutateLinkInput,
): Promise<MutateLinkResult> {
  if (!isCanonicalRemoteDesktopCreationRequestId(input.requestId)) {
    throw new LinkAuthorityError(LINK_REFUSAL.INVALID);
  }

  const used = await consumeActionBoundStepUpGrant<MutateLinkResult>(
    db,
    {
      token: input.stepUpToken,
      accountSession: input.accountSession,
      canonicalHostId: input.hostId,
      action: {
        kind: 'remote_desktop.link.mutate',
        hostId: input.hostId,
        linkId: input.linkId,
        mutation: input.mutation,
        label: input.label ?? null,
        expiresAt: input.expiresAt ?? null,
      },
      requestId: input.requestId,
    },
    async (tx) => {
      await assertOwnedHostTx(tx, input.hostId, input.ownerUserId);
      await requirePrivacyTx(tx, input.hostId, input.privacy);

      const row = await tx.queryOne<LinkRow>(
        `SELECT ${LINK_COLUMNS} FROM remote_desktop_guest_links
          WHERE id = $1 AND host_id = $2 AND owner_user_id = $3
          FOR UPDATE`,
        [input.linkId, input.hostId, input.ownerUserId],
      );
      if (!row) throw new LinkAuthorityError(LINK_REFUSAL.NOT_FOUND);
      if (row.state !== 'active') throw new LinkAuthorityError(LINK_REFUSAL.CONFLICT);

      const current: RemoteDesktopLinkPolicy = {
        hostId: row.host_id,
        kind: row.attendance as RemoteDesktopLinkKind,
        mode: row.access_mode as RemoteDesktopAccessMode,
        usePolicy: row.use_policy as RemoteDesktopLinkUsePolicy,
        durationMs: row.expires_at === null ? undefined : Math.max(1, row.expires_at - row.created_at),
        label: row.label,
      };

      const applied = await applyMutationTx(tx, { input, row, current });
      const updated = await tx.queryOne<LinkRow>(
        `SELECT ${LINK_COLUMNS} FROM remote_desktop_guest_links WHERE id = $1`, [input.linkId],
      );
      if (!updated) throw new LinkAuthorityError(LINK_REFUSAL.CONFLICT);

      // Durable record of what this mutation did, including the deliberate
      // zero-effect case, so "nothing to deliver" is never mistaken for
      // "delivery pending".
      await tx.execute(
        `INSERT INTO remote_desktop_link_authority_log (
           id, link_id, host_id, owner_user_id, mutation, authority_generation,
           expiry_revision, commit_revision, effects_emitted, step_up_request_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          randomUUID(), input.linkId, input.hostId, input.ownerUserId, input.mutation,
          updated.authority_generation, updated.expiry_revision, updated.commit_revision,
          applied.effectsEmitted, input.requestId, input.now,
        ],
      );

      return { link: toView(updated, await isClaimedTx(tx, input.linkId)), effectsEmitted: applied.effectsEmitted };
    },
    input.now,
  );

  if (!used.ok) throw new LinkAuthorityError(LINK_REFUSAL.STEP_UP_REQUIRED);
  return used.result;
}

/** The live route a link's effects should target, if any. */
async function liveRouteForLinkTx(tx: Database, linkId: string): Promise<{
  routeId: string; routeGeneration: number; serverId: string; auditId: string;
} | null> {
  const row = await tx.queryOne<{
    route_id: string | null; route_generation: number | null;
    execution_server_id: string | null; actor_audit_id: string | null; id: string;
  }>(
    `SELECT r.route_id, r.route_generation, r.execution_server_id, r.actor_audit_id, s.id
       FROM remote_desktop_guest_sessions s
       JOIN remote_desktop_host_routes r ON r.guest_session_id = s.id AND r.state <> 'closed'
      WHERE s.link_id = $1 AND s.state IN ('admitting', 'active')
      LIMIT 1`,
    [linkId],
  );
  if (!row || row.route_id === null || row.route_generation === null || row.execution_server_id === null) {
    return null;
  }
  return {
    routeId: row.route_id,
    routeGeneration: row.route_generation,
    serverId: row.execution_server_id,
    auditId: row.actor_audit_id ?? row.id,
  };
}

async function applyMutationTx(tx: Database, ctx: {
  input: MutateLinkInput; row: LinkRow; current: RemoteDesktopLinkPolicy;
}): Promise<{ effectsEmitted: number }> {
  const { input, row, current } = ctx;
  const now = input.now;

  if (input.mutation === REMOTE_DESKTOP_LINK_MUTATION.SET_LABEL) {
    if (input.label === undefined
      || !isMonotonicRemoteDesktopLinkMutation(current, { label: input.label })) {
      throw new LinkAuthorityError(LINK_REFUSAL.INVALID);
    }
    // Neither counter moves: a rename is not an authority change.
    await tx.execute(
      `UPDATE remote_desktop_guest_links
          SET label = $2, commit_revision = commit_revision + 1, updated_at = $3
        WHERE id = $1`,
      [row.id, input.label, now],
    );
    return { effectsEmitted: 0 };
  }

  if (input.mutation === REMOTE_DESKTOP_LINK_MUTATION.REDUCE_TO_VIEW) {
    if (row.access_mode !== REMOTE_DESKTOP_ACCESS_MODE.CONTROL
      || !isMonotonicRemoteDesktopLinkMutation(current, { mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW })) {
      throw new LinkAuthorityError(LINK_REFUSAL.INVALID);
    }
    await tx.execute(
      `UPDATE remote_desktop_guest_links
          SET access_mode = 'view',
              authority_generation = authority_generation + 1,
              commit_revision = commit_revision + 1,
              updated_at = $2
        WHERE id = $1`,
      [row.id, now],
    );
    const route = await liveRouteForLinkTx(tx, row.id);
    if (!route) {
      // No delivery target exists. The shared contract has no host-scoped
      // downgrade effect, and inventing one — or emitting a route-scoped row
      // with a placeholder target — would create a row no pod can legitimately
      // apply. The authority change is already durable; the log row above is
      // the audit fact.
      return { effectsEmitted: 0 };
    }
    await appendGuestEffectTx(tx, {
      id: randomUUID(),
      targetRouteId: route.routeId,
      event: {
        idempotencyKey: `downgrade:${row.id}:${row.authority_generation + 1}`,
        effect: REMOTE_DESKTOP_OUTBOX_EFFECT.DOWNGRADE,
        authorityKind: REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.LINK,
        scope: REMOTE_DESKTOP_OUTBOX_SCOPE.ROUTE,
        hostId: row.host_id,
        actorAuditId: route.auditId,
        authorityGeneration: row.authority_generation + 1,
        expiryRevision: row.expiry_revision,
        commitRevision: row.commit_revision + 1,
        targetServerId: route.serverId,
        routeGeneration: route.routeGeneration,
      },
      now,
      sloAnchorAt: now,
      retainUntil: input.retainUntil,
    });
    return { effectsEmitted: 1 };
  }

  if (input.mutation === REMOTE_DESKTOP_LINK_MUTATION.SHORTEN_EXPIRY) {
    if (input.expiresAt === undefined
      || row.expires_at === null
      || input.expiresAt >= row.expires_at
      || input.expiresAt <= now) {
      throw new LinkAuthorityError(LINK_REFUSAL.INVALID);
    }
    const nextRevision = row.expiry_revision + 1;
    await tx.execute(
      `UPDATE remote_desktop_guest_links
          SET expires_at = $2,
              expiry_revision = expiry_revision + 1,
              commit_revision = commit_revision + 1,
              updated_at = $3
        WHERE id = $1`,
      [row.id, input.expiresAt, now],
    );
    // The due row is replaced, not added to: two due rows would fire twice.
    await replaceExpiryDueTx(tx, {
      linkId: row.id, expiryRevision: nextRevision, expiresAt: input.expiresAt, now,
    });
    const route = await liveRouteForLinkTx(tx, row.id);
    if (!route) return { effectsEmitted: 0 };
    await appendGuestEffectTx(tx, {
      id: randomUUID(),
      targetRouteId: route.routeId,
      event: {
        idempotencyKey: `deadline:${row.id}:${nextRevision}`,
        effect: REMOTE_DESKTOP_OUTBOX_EFFECT.DEADLINE_UPDATE,
        authorityKind: REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.LINK,
        scope: REMOTE_DESKTOP_OUTBOX_SCOPE.ROUTE,
        hostId: row.host_id,
        actorAuditId: route.auditId,
        // Authority is untouched: the route stays valid, it just ends sooner.
        authorityGeneration: row.authority_generation,
        expiryRevision: nextRevision,
        commitRevision: row.commit_revision + 1,
        targetServerId: route.serverId,
        routeGeneration: route.routeGeneration,
        deadlineAt: input.expiresAt,
      },
      now,
      sloAnchorAt: now,
      retainUntil: input.retainUntil,
    });
    return { effectsEmitted: 1 };
  }

  // Revoke.
  await tx.execute(
    `UPDATE remote_desktop_guest_links
        SET state = 'revoked', revoked_at = $2,
            authority_generation = authority_generation + 1,
            commit_revision = commit_revision + 1,
            updated_at = $2
      WHERE id = $1`,
    [row.id, now],
  );
  await tx.execute(
    `UPDATE remote_desktop_guest_sessions
        SET state = 'closed', closed_at = $2, updated_at = $2
      WHERE link_id = $1 AND state IN ('admitting', 'active')`,
    [row.id, now],
  );
  const route = await liveRouteForLinkTx(tx, row.id);
  await appendGuestEffectTx(tx, {
    id: randomUUID(),
    targetRouteId: route?.routeId ?? null,
    event: route
      ? {
        idempotencyKey: `terminal:${row.id}:${row.authority_generation + 1}`,
        effect: REMOTE_DESKTOP_OUTBOX_EFFECT.TERMINAL,
        authorityKind: REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.LINK,
        scope: REMOTE_DESKTOP_OUTBOX_SCOPE.ROUTE,
        hostId: row.host_id,
        actorAuditId: route.auditId,
        authorityGeneration: row.authority_generation + 1,
        expiryRevision: row.expiry_revision,
        commitRevision: row.commit_revision + 1,
        targetServerId: route.serverId,
        routeGeneration: route.routeGeneration,
      }
      : {
        // Revocation with no live route still needs one ordered terminal fact
        // so a reconnect cannot revive the authority. Host scope exists for
        // exactly this, and only for terminal.
        idempotencyKey: `terminal:${row.id}:${row.authority_generation + 1}`,
        effect: REMOTE_DESKTOP_OUTBOX_EFFECT.TERMINAL,
        authorityKind: REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.LINK,
        scope: REMOTE_DESKTOP_OUTBOX_SCOPE.HOST,
        hostId: row.host_id,
        actorAuditId: row.id,
        authorityGeneration: row.authority_generation + 1,
        expiryRevision: row.expiry_revision,
        commitRevision: row.commit_revision + 1,
        targetServerId: null,
        routeGeneration: null,
      },
    now,
    sloAnchorAt: now,
    retainUntil: input.retainUntil,
  });
  return { effectsEmitted: 1 };
}

/** Bind one browser key under the link's single-use/reusable policy. */
export async function claimLinkBrowser(
  db: Database,
  input: { linkId: string; browserKeyThumbprint: string; now: number },
): Promise<{ claimed: boolean }> {
  const keyHash = hashBrowserKey(input.browserKeyThumbprint);
  return db.transaction(async (tx) => {
    const link = await tx.queryOne<{ id: string; state: string; use_policy: string }>(
      `SELECT id, state, use_policy FROM remote_desktop_guest_links WHERE id = $1 FOR UPDATE`,
      [input.linkId],
    );
    if (!link || link.state !== 'active') throw new LinkAuthorityError(LINK_REFUSAL.NOT_FOUND);

    const inserted = await tx.queryOne<{ link_id: string }>(
      `INSERT INTO remote_desktop_guest_browser_claims
         (link_id, browser_key_hash, browser_key_hash_version, claimed_at, last_proved_at)
       VALUES ($1, $2, 'v1', $3, $3)
       ON CONFLICT (link_id, browser_key_hash) DO NOTHING
       RETURNING link_id`,
      [input.linkId, keyHash, input.now],
    );
    if (inserted) {
      if (link.use_policy === REMOTE_DESKTOP_LINK_USE_POLICY.SINGLE_USE) {
        const claimCount = await tx.queryOne<{ count: number | string }>(
          'SELECT COUNT(*) AS count FROM remote_desktop_guest_browser_claims WHERE link_id = $1',
          [input.linkId],
        );
        if (Number(claimCount?.count ?? 0) !== 1) {
          throw new LinkAuthorityError(LINK_REFUSAL.NOT_FOUND);
        }
      }
      return { claimed: true };
    }
    await tx.execute(
      `UPDATE remote_desktop_guest_browser_claims SET last_proved_at = $3
        WHERE link_id = $1 AND browser_key_hash = $2`,
      [input.linkId, keyHash, input.now],
    );
    return { claimed: false };
  });
}

/**
 * One live session per link/browser key, with exact-session resume.
 *
 * The same browser reconnecting recovers its own session id rather than opening
 * a second one, so a link can never hold two PeerConnection authorities.
 */
export async function openOrResumeLinkSession(
  db: Database,
  input: { linkId: string; hostId: string; browserKeyThumbprint: string; now: number },
): Promise<{ sessionId: string; resumed: boolean }> {
  const keyHash = hashBrowserKey(input.browserKeyThumbprint);
  return db.transaction(async (tx) => {
    const link = await tx.queryOne<LinkRow>(
      `SELECT ${LINK_COLUMNS} FROM remote_desktop_guest_links
        WHERE id = $1 AND host_id = $2 FOR UPDATE`,
      [input.linkId, input.hostId],
    );
    if (!link || link.state !== 'active') throw new LinkAuthorityError(LINK_REFUSAL.NOT_FOUND);

    const claim = await tx.queryOne<{ browser_key_hash: string }>(
      `SELECT browser_key_hash FROM remote_desktop_guest_browser_claims
        WHERE link_id = $1 AND browser_key_hash = $2`,
      [input.linkId, keyHash],
    );
    if (!claim || !constantTimeEqualHex(claim.browser_key_hash, keyHash)) {
      throw new LinkAuthorityError(LINK_REFUSAL.NOT_FOUND);
    }

    const live = await tx.queryOne<{ id: string; browser_key_hash: string | null }>(
      `SELECT id, browser_key_hash FROM remote_desktop_guest_sessions
        WHERE link_id = $1 AND browser_key_hash = $2 AND state IN ('admitting', 'active')`,
      [input.linkId, keyHash],
    );
    if (live) {
      // A different browser must not adopt an existing session.
      if (live.browser_key_hash !== null && !constantTimeEqualHex(live.browser_key_hash, keyHash)) {
        throw new LinkAuthorityError(LINK_REFUSAL.NOT_FOUND);
      }
      return { sessionId: live.id, resumed: true };
    }

    const sessionId = randomUUID();
    const actorKind = link.attendance === REMOTE_DESKTOP_LINK_KIND.UNATTENDED
      ? REMOTE_DESKTOP_ACTOR_SOURCE.UNATTENDED_LINK
      : REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK;
    await tx.execute(
      `INSERT INTO remote_desktop_guest_sessions
         (id, link_id, host_id, browser_key_hash, actor_kind, authority_generation,
          expiry_revision, absolute_expires_at, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'admitting', $9, $9)`,
      [
        sessionId, input.linkId, input.hostId, keyHash, actorKind,
        link.authority_generation, link.expiry_revision, link.expires_at, input.now,
      ],
    );
    return { sessionId, resumed: false };
  });
}
