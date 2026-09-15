/**
 * Public proof resolution and post-proof sticky bootstrap.
 *
 * The privacy boundary here is asymmetric on purpose:
 *
 *   before proof — every failure is one bounded shape. Unknown link, revoked
 *                  link, wrong browser, expired, offline host, unsupported
 *                  host and malformed input are indistinguishable. No
 *                  `serverId`, host name, owner, topology or existence signal
 *                  crosses this line.
 *
 *   after proof  — the caller learns the exact internal `serverId` as a routing
 *                  key, plus one short-lived single-use bootstrap. `serverId`
 *                  is not authorization: without the ticket, the right browser
 *                  key and the right generation, holding it lists nothing,
 *                  dispatches nothing and mints no lease.
 *
 * `redeemBootstrapForRoute` is the Router boundary: it consumes the proof and
 * reserves the durable guest session/privacy-registry row atomically. PREPARE
 * and capability minting remain in the Router and cannot precede that commit.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Database } from '../db/client.js';
import {
  REMOTE_DESKTOP_ACTOR_SOURCE,
  REMOTE_DESKTOP_LINK_KIND,
  REMOTE_DESKTOP_LINK_USE_POLICY,
  REMOTE_DESKTOP_LINK_TOKEN,
  REMOTE_DESKTOP_BROWSER_CLAIM,
  REMOTE_DESKTOP_PUBLIC_LOOKUP_UNAVAILABLE,
  isCanonicalRemoteDesktopLinkToken,
  isRemoteDesktopPublicNodeId,
} from '../../../shared/remote-desktop-access.js';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  type RemoteDesktopAccessMode,
} from '../../../shared/remote-desktop.js';
import type {
  RemoteDesktopActor,
  RemoteDesktopActorSource,
  RemoteDesktopBootstrapProof,
  RemoteDesktopClaimChallenge,
  RemoteDesktopClaimProof,
} from '../../../shared/remote-desktop-access.js';
import { hashBrowserKey } from './remote-desktop-guest-links.js';
import {
  isGuestAdmissionReady,
  resolveExecutionEndpoint,
  type FullEndpointEligibility,
} from './remote-desktop-host-identity.js';
import {
  CHALLENGE_HASH_DOMAIN,
  hashChallengeMaterial,
  verifyBootstrapProof,
  verifyBrowserClaimProof,
  isRemoteDesktopBrowserKeyBindingValid,
} from './remote-desktop-guest-crypto.js';
import { reserveRouteTx } from './remote-desktop-management-privacy.js';

/** Bounded ticket format, mirroring the frozen link-bearer shape. */
export const BOOTSTRAP_TICKET = {
  RAW_BYTES: 32,
  HASH_VERSION: 'v1',
  HASH_DOMAIN: 'imcodes.remote-desktop.bootstrap.v1',
  DEFAULT_TTL_MS: 30_000,
} as const;

/** The single pre-proof failure shape. Never varies, never carries a target. */
export const PUBLIC_UNAVAILABLE = REMOTE_DESKTOP_PUBLIC_LOOKUP_UNAVAILABLE;

export function hashBootstrapTicket(raw: string): string {
  return createHash('sha256')
    .update(BOOTSTRAP_TICKET.HASH_DOMAIN, 'utf8')
    .update(Buffer.from([0]))
    .update(raw, 'utf8')
    .digest('hex');
}

/** Client-supplied token hashed under the frozen link preimage. */
export function hashLinkToken(token: string): string {
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== REMOTE_DESKTOP_LINK_TOKEN.RAW_BYTES) {
    throw new Error('remote_desktop_link_token_length');
  }
  return createHash(REMOTE_DESKTOP_LINK_TOKEN.HASH_ALGORITHM.replace('-', ''))
    .update(REMOTE_DESKTOP_LINK_TOKEN.HASH_DOMAIN, 'utf8')
    .update(Buffer.from([REMOTE_DESKTOP_LINK_TOKEN.HASH_DOMAIN_SEPARATOR_BYTE]))
    .update(raw)
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

export interface ProofSuccess {
  ok: true;
  /** Routing key only. Disclosed exclusively after successful proof. */
  serverId: string;
  hostId: string;
  /** Raw ticket, returned once and stored only as a hash. */
  bootstrapTicket: string;
  expiresAt: number;
  mode: RemoteDesktopAccessMode;
  source: RemoteDesktopActorSource;
}

export interface ProofFailure { ok: false; body: typeof PUBLIC_UNAVAILABLE }

export type ProofResult = ProofSuccess | ProofFailure;

const FAIL: ProofFailure = { ok: false, body: PUBLIC_UNAVAILABLE };

export interface ResolveLinkProofInput {
  /** Signature proof. The browser never sends, or learns, an internal link id. */
  proof: RemoteDesktopClaimProof;
  now: number;
  ttlMs?: number;
  /** Injected liveness seam for FULL daemons; absent means only controlled endpoints qualify. */
  fullEndpointEligible?: FullEndpointEligibility;
}

export interface IssueChallengeInput {
  token: string;
  now: number;
  ttlMs?: number;
}

/**
 * Mint a claim challenge for a presented bearer.
 *
 * Deliberately unconditional. A token that resolves to nothing still produces a
 * challenge row with a null `link_id` and an identical response, so the issuing
 * step cannot be used to enumerate links. The existence question is answered
 * only at proof time, and answered there with the same generic unavailable body
 * as every other failure.
 */
export async function issueClaimChallenge(
  db: Database,
  input: IssueChallengeInput,
): Promise<RemoteDesktopClaimChallenge> {
  const challengeId = randomBytes(REMOTE_DESKTOP_BROWSER_CLAIM.CHALLENGE_ID_BYTES).toString('base64url');
  const challenge = randomBytes(REMOTE_DESKTOP_BROWSER_CLAIM.CHALLENGE_BYTES).toString('base64url');

  let linkId: string | null = null;
  if (isCanonicalRemoteDesktopLinkToken(input.token)) {
    try {
      const tokenHash = hashLinkToken(input.token);
      const link = await db.queryOne<{ id: string }>(
        `SELECT id FROM remote_desktop_guest_links WHERE token_hash = $1`,
        [tokenHash],
      );
      linkId = link?.id ?? null;
    } catch {
      linkId = null;
    }
  }

  const expiresAt = input.now + (input.ttlMs ?? REMOTE_DESKTOP_BROWSER_CLAIM.CHALLENGE_TTL_MS);
  await db.execute(
    `INSERT INTO remote_desktop_guest_claim_challenges
       (challenge_id_hash, challenge_hash, challenge_hash_version, link_id, expires_at, created_at)
     VALUES ($1, $2, 'v1', $3, $4, $5)`,
    [
      hashChallengeMaterial(CHALLENGE_HASH_DOMAIN.ID, challengeId),
      hashChallengeMaterial(CHALLENGE_HASH_DOMAIN.VALUE, challenge),
      linkId, expiresAt, input.now,
    ],
  );

  return {
    keyAlgorithm: REMOTE_DESKTOP_BROWSER_CLAIM.KEY_ALGORITHM,
    challengeId,
    challenge,
    expiresAt,
  };
}

/**
 * Resolve a bearer by verifying private-key possession.
 *
 * The order is load-bearing:
 *
 *   1. consume the challenge (single-use, conditional UPDATE) — a replayed
 *      proof is dead here, before any link is touched;
 *   2. verify the signature against the *stored* challenge material, so the
 *      caller cannot choose the bytes it signs;
 *   3. prove that admission currently has a qualified endpoint;
 *   4. only then bind or re-check the browser claim and issue a ticket.
 *
 * The readiness check MUST precede the first claim write.  A management
 * privacy epoch can still be ending when the Owner copies a newly-created
 * invitation.  Persisting the claim before discovering that admission is
 * temporarily closed would bind the link without issuing a bootstrap, leaving
 * a retry from a freshly loaded page unable to prove the abandoned key.
 *
 * Every rejection returns the identical bounded body. The function does not
 * branch its return shape on *why* it failed, which is what keeps an
 * enumeration probe from distinguishing a real link from a fabricated one.
 */
export async function resolveLinkProof(
  db: Database,
  input: ResolveLinkProofInput,
): Promise<ProofResult> {
  const { proof } = input;

  return db.transaction(async (tx) => {
    // 1. Consume the challenge. Conditional so two concurrent proofs cannot
    //    both spend it, and so a replay finds nothing.
    const consumed = await tx.queryOne<{
      challenge_hash: string; link_id: string | null; expires_at: number;
    }>(
      `UPDATE remote_desktop_guest_claim_challenges
          SET consumed_at = $2
        WHERE challenge_id_hash = $1 AND consumed_at IS NULL
        RETURNING challenge_hash, link_id, expires_at`,
      [hashChallengeMaterial(CHALLENGE_HASH_DOMAIN.ID, proof.challengeId), input.now],
    );
    if (!consumed) return FAIL;
    if (consumed.expires_at <= input.now) return FAIL;
    if (!constantTimeEqualHex(
      consumed.challenge_hash,
      hashChallengeMaterial(CHALLENGE_HASH_DOMAIN.VALUE, proof.challenge),
    )) return FAIL;

    // 2. Prove possession of the private key. A bare thumbprint proves nothing.
    if (!verifyBrowserClaimProof({
      proof,
      expectedChallengeId: proof.challengeId,
      expectedChallenge: proof.challenge,
    })) return FAIL;

    // The challenge was minted for an unresolved bearer. Everything above still
    // ran, so the cost and shape of this path match a real one.
    if (consumed.link_id === null) return FAIL;

    const link = await tx.queryOne<{
      id: string; host_id: string; access_mode: string; attendance: string;
      use_policy: string;
      state: string; expires_at: number | null;
      authority_generation: number; expiry_revision: number;
    }>(
      `SELECT id, host_id, access_mode, attendance, use_policy, state, expires_at,
              authority_generation, expiry_revision
         FROM remote_desktop_guest_links
        WHERE id = $1
        FOR UPDATE`,
      [consumed.link_id],
    );
    if (!link) return FAIL;
    if (link.state !== 'active') return FAIL;
    if (link.expires_at !== null && link.expires_at <= input.now) return FAIL;

    // 3. Only a currently qualified endpoint may be disclosed.  Keep this
    // before the first browser-claim write: a transiently closed privacy gate
    // must consume this one-use challenge without poisoning the durable link.
    const endpoint = await resolveQualifiedEndpointTx(tx, link.host_id, input.fullEndpointEligible);
    if (!endpoint) return FAIL;

    // 4. Bind this browser key under the link's policy. The locked link row
    // serializes the single-use first-claim decision; reusable links keep one
    // claim row per independently proving browser key.
    const browserHash = hashBrowserKey(proof.browserKeyThumbprint);
    const inserted = await tx.queryOne<{ link_id: string }>(
      `INSERT INTO remote_desktop_guest_browser_claims
         (link_id, browser_key_hash, browser_key_hash_version,
          browser_public_key_spki, claimed_at, last_proved_at)
       VALUES ($1, $2, 'v1', $3, $4, $4)
       ON CONFLICT (link_id, browser_key_hash) DO NOTHING
       RETURNING link_id`,
      [link.id, browserHash, proof.browserPublicKeySpki, input.now],
    );
    if (inserted && link.use_policy === REMOTE_DESKTOP_LINK_USE_POLICY.SINGLE_USE) {
      const claimCount = await tx.queryOne<{ count: number | string }>(
        'SELECT COUNT(*) AS count FROM remote_desktop_guest_browser_claims WHERE link_id = $1',
        [link.id],
      );
      if (Number(claimCount?.count ?? 0) !== 1) {
        await tx.execute(
          `DELETE FROM remote_desktop_guest_browser_claims
            WHERE link_id = $1 AND browser_key_hash = $2`,
          [link.id, browserHash],
        );
        return FAIL;
      }
    }
    if (!inserted) {
      await tx.execute(
        `UPDATE remote_desktop_guest_browser_claims
            SET last_proved_at = $2,
                browser_public_key_spki = COALESCE(browser_public_key_spki, $3)
          WHERE link_id = $1 AND browser_key_hash = $4`,
        [link.id, input.now, proof.browserPublicKeySpki, browserHash],
      );
    }

    const source = link.attendance === REMOTE_DESKTOP_LINK_KIND.UNATTENDED
      ? REMOTE_DESKTOP_ACTOR_SOURCE.UNATTENDED_LINK
      : REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK;

    const issued = await issueBootstrapTx(tx, {
      hostId: link.host_id,
      linkId: link.id,
      targetServerId: endpoint,
      actorSource: source,
      mode: link.access_mode as RemoteDesktopAccessMode,
      authorityGeneration: link.authority_generation,
      expiryRevision: link.expiry_revision,
      credentialGeneration: link.authority_generation,
      browserKeyHash: browserHash,
      browserPublicKeySpki: proof.browserPublicKeySpki,
      now: input.now,
      ttlMs: input.ttlMs ?? BOOTSTRAP_TICKET.DEFAULT_TTL_MS,
    });

    return {
      ok: true as const,
      serverId: endpoint,
      hostId: link.host_id,
      bootstrapTicket: issued.raw,
      expiresAt: issued.expiresAt,
      mode: link.access_mode as RemoteDesktopAccessMode,
      source,
    };
  });
}

/**
 * The endpoint currently executing for a canonical host.
 *
 * Guest admission must not be offered while the host's privacy barrier is
 * closed or a linkage conflict is unresolved, so both are checked here rather
 * than left to the caller.
 */
async function resolveQualifiedEndpointTx(
  tx: Database,
  hostId: string,
  fullEndpointEligible?: FullEndpointEligibility,
): Promise<string | null> {
  const privacy = await tx.queryOne<{ phase: string; admission_open: boolean }>(
    `SELECT phase, admission_open
       FROM remote_desktop_management_privacy
      WHERE host_id = $1`,
    [hostId],
  );
  if (!privacy || privacy.phase !== 'idle' || !privacy.admission_open) return null;
  if (!await isGuestAdmissionReady({ db: tx, hostId, fullEndpointEligible })) return null;
  return (await resolveExecutionEndpoint({ db: tx, hostId, fullEndpointEligible }))?.serverId ?? null;
}

async function issueBootstrapTx(tx: Database, input: {
  hostId: string;
  linkId: string | null;
  targetServerId: string;
  actorSource: RemoteDesktopActorSource;
  mode: RemoteDesktopAccessMode;
  authorityGeneration: number;
  expiryRevision: number | null;
  credentialGeneration: number;
  browserKeyHash: string;
  browserPublicKeySpki: string;
  now: number;
  ttlMs: number;
}): Promise<{ raw: string; expiresAt: number }> {
  const raw = randomBytes(BOOTSTRAP_TICKET.RAW_BYTES).toString('base64url');
  const expiresAt = input.now + input.ttlMs;
  await tx.execute(
    `INSERT INTO remote_desktop_guest_bootstraps (
       ticket_hash, ticket_hash_version, host_id, link_id, target_server_id,
       actor_source, mode, authority_generation, expiry_revision,
       credential_generation, browser_key_hash, browser_public_key_spki,
       expires_at, created_at
     ) VALUES ($1, 'v1', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      hashBootstrapTicket(raw), input.hostId, input.linkId, input.targetServerId,
      input.actorSource, input.mode, input.authorityGeneration, input.expiryRevision,
      input.credentialGeneration, input.browserKeyHash, input.browserPublicKeySpki,
      expiresAt, input.now,
    ],
  );
  return { raw, expiresAt };
}

/**
 * Password-proof issue seam. The exact public ID used by proof, credential
 * generation, privacy/readiness, endpoint and key binding are rechecked inside
 * the same transaction that persists the ticket.
 *
 * Locking the active public-ID row is also the serialization point shared with
 * Owner rotation: rotation-first makes this recheck fail, while issuer-first
 * makes rotation wait and then delete the still-unredeemed ticket.
 */
export async function issueNodePasswordBootstrap(db: Database, input: {
  hostId: string;
  publicNodeId: string;
  credentialGeneration: number;
  browserPublicKeySpki: string;
  browserKeyThumbprint: string;
  now: number;
  ttlMs?: number;
  fullEndpointEligible?: FullEndpointEligibility;
}): Promise<ProofSuccess | null> {
  if (!isRemoteDesktopBrowserKeyBindingValid(input)
    || !isRemoteDesktopPublicNodeId(Number(input.publicNodeId))) return null;
  return db.transaction(async (tx) => {
    const activePublicId = await tx.queryOne<{ public_id: string }>(
      `SELECT public_id
         FROM remote_desktop_public_ids
        WHERE public_id = $1 AND host_id = $2 AND status = 'active'
        FOR UPDATE`,
      [input.publicNodeId, input.hostId],
    );
    if (!activePublicId || activePublicId.public_id !== input.publicNodeId) return null;
    const credential = await tx.queryOne<{ generation: number; disabled_at: number | null }>(
      `SELECT generation, disabled_at
         FROM remote_desktop_unattended_passwords
        WHERE host_id = $1
        FOR UPDATE`,
      [input.hostId],
    );
    if (!credential || credential.disabled_at !== null
      || credential.generation !== input.credentialGeneration) return null;
    const endpoint = await resolveQualifiedEndpointTx(tx, input.hostId, input.fullEndpointEligible);
    if (!endpoint) return null;
    const issued = await issueBootstrapTx(tx, {
      hostId: input.hostId,
      linkId: null,
      targetServerId: endpoint,
      actorSource: REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      authorityGeneration: credential.generation,
      expiryRevision: null,
      credentialGeneration: credential.generation,
      browserKeyHash: hashBrowserKey(input.browserKeyThumbprint),
      browserPublicKeySpki: input.browserPublicKeySpki,
      now: input.now,
      ttlMs: input.ttlMs ?? BOOTSTRAP_TICKET.DEFAULT_TTL_MS,
    });
    return {
      ok: true,
      serverId: endpoint,
      hostId: input.hostId,
      bootstrapTicket: issued.raw,
      expiresAt: issued.expiresAt,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      source: REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD,
    };
  });
}

export interface RedeemBootstrapInput {
  proof: RemoteDesktopBootstrapProof;
  /** The pod attempting redemption. Must own the target endpoint. */
  redeemingServerId: string;
  now: number;
}

export interface RedeemedBootstrap {
  hostId: string;
  linkId: string | null;
  serverId: string;
  actorSource: RemoteDesktopActorSource;
  mode: RemoteDesktopAccessMode;
  authorityGeneration: number;
  expiryRevision: number | null;
  credentialGeneration: number;
  browserPublicKeySpki: string;
  browserKeyThumbprint: string;
  sessionId: string | null;
}

/**
 * Atomically redeem a bootstrap on the owning pod.
 *
 * Single-use is enforced by a conditional update rather than a read-then-write,
 * so two pods racing the same ticket cannot both admit. Everything else fails
 * closed and, critically, fails *before* any daemon dispatch: wrong target pod,
 * replay, expiry, browser mismatch and superseded generation all return null
 * without touching the Router.
 */
async function redeemBootstrapTx(
  db: Database,
  input: RedeemBootstrapInput,
): Promise<RedeemedBootstrap | null> {
  const ticketHash = hashBootstrapTicket(input.proof.ticket);
  const browserHash = hashBrowserKey(input.proof.browserKeyThumbprint);

  return (async (tx: Database) => {
    const row = await tx.queryOne<{
      host_id: string; link_id: string | null; target_server_id: string;
      actor_source: string; mode: string; authority_generation: number;
      expiry_revision: number | null; credential_generation: number;
      browser_key_hash: string; resume_session_id: string | null;
      browser_public_key_spki: string;
      expires_at: number; redeemed_at: number | null;
    }>(
      `SELECT host_id, link_id, target_server_id, actor_source, mode,
              authority_generation, expiry_revision, credential_generation,
              browser_key_hash, browser_public_key_spki, resume_session_id,
              expires_at, redeemed_at
         FROM remote_desktop_guest_bootstraps
        WHERE ticket_hash = $1
        FOR UPDATE`,
      [ticketHash],
    );
    if (!row) return null;
    if (row.redeemed_at !== null) return null;
    if (row.expires_at <= input.now) return null;
    // serverId alone is not authority, and neither is being any pod: only the
    // pod owning this exact endpoint may redeem.
    if (row.target_server_id !== input.redeemingServerId) return null;
    if (!constantTimeEqualHex(row.browser_key_hash, browserHash)) return null;
    if (!verifyBootstrapProof({
      ticket: input.proof.ticket,
      browserKeyThumbprint: input.proof.browserKeyThumbprint,
      signature: input.proof.signature,
      storedSpki: row.browser_public_key_spki,
    })) return null;

    // The authority may have narrowed between issue and redemption.
    if (row.link_id !== null) {
      if (row.actor_source === REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD) return null;
      const link = await tx.queryOne<{
        state: string; attendance: string; access_mode: string;
        authority_generation: number; expires_at: number | null;
      }>(
        `SELECT state, attendance, access_mode, authority_generation, expires_at
           FROM remote_desktop_guest_links WHERE id = $1 FOR UPDATE`,
        [row.link_id],
      );
      if (!link || link.state !== 'active') return null;
      const expectedSource = link.attendance === REMOTE_DESKTOP_LINK_KIND.ATTENDED
        ? REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK
        : REMOTE_DESKTOP_ACTOR_SOURCE.UNATTENDED_LINK;
      if (row.actor_source !== expectedSource || row.mode !== link.access_mode) return null;
      if (link.authority_generation !== row.authority_generation) return null;
      if (link.expires_at !== null && link.expires_at <= input.now) return null;
    } else {
      if (row.actor_source !== REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD) return null;
      if (row.mode !== REMOTE_DESKTOP_ACCESS_MODE.CONTROL) return null;
      const password = await tx.queryOne<{ generation: number; disabled_at: number | null }>(
        `SELECT generation, disabled_at
           FROM remote_desktop_unattended_passwords
          WHERE host_id = $1
          FOR UPDATE`,
        [row.host_id],
      );
      if (!password || password.disabled_at !== null
        || password.generation !== row.credential_generation) return null;
    }

    const consumed = await tx.execute(
      `UPDATE remote_desktop_guest_bootstraps
          SET redeemed_at = $2, redeemed_by_server_id = $3
        WHERE ticket_hash = $1 AND redeemed_at IS NULL`,
      [ticketHash, input.now, input.redeemingServerId],
    );
    if (consumed.changes !== 1) return null;

    return {
      hostId: row.host_id,
      linkId: row.link_id,
      serverId: row.target_server_id,
      actorSource: row.actor_source as RemoteDesktopActorSource,
      mode: row.mode as RemoteDesktopAccessMode,
      authorityGeneration: row.authority_generation,
      expiryRevision: row.expiry_revision,
      credentialGeneration: row.credential_generation,
      browserPublicKeySpki: row.browser_public_key_spki,
      browserKeyThumbprint: input.proof.browserKeyThumbprint,
      sessionId: row.resume_session_id,
    };
  })(db);
}

export async function redeemBootstrap(
  db: Database,
  input: RedeemBootstrapInput,
): Promise<RedeemedBootstrap | null> {
  return db.transaction((tx) => redeemBootstrapTx(tx, input));
}

export interface RedeemedGuestAdmission {
  actor: RemoteDesktopActor;
  sessionId: string;
  routeGeneration: number;
  registryAuthority:
    | {
      actorSource: typeof REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK
        | typeof REMOTE_DESKTOP_ACTOR_SOURCE.UNATTENDED_LINK;
      actorAuditId: string;
      authorityGeneration: number;
      expiryRevision: number;
      commitRevision: number;
    }
    | {
      actorSource: typeof REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD;
      actorAuditId: string;
      sessionAuditId: string;
      passwordGeneration: number;
    };
}

class GuestAdmissionRefused extends Error {}

/**
 * Consume a bootstrap, create its durable guest session and reserve the
 * privacy-registry route in one transaction. A ticket is never burned while
 * leaving an unclassified route behind.
 */
export async function redeemBootstrapForRoute(input: {
  db: Database;
  proof: RemoteDesktopBootstrapProof;
  redeemingServerId: string;
  routeGeneration: number;
  clientIp: string;
  now: number;
}): Promise<RedeemedGuestAdmission | null> {
  if (isIP(input.clientIp) === 0) return null;
  return input.db.transaction(async (tx) => {
    const redeemed = await redeemBootstrapTx(tx, input);
    if (!redeemed) return null;
    const keyHash = hashBrowserKey(redeemed.browserKeyThumbprint);
    let sessionId: string;
    let expiresAt = 0;
    let commitRevision = 1;
    let publicNodeId = 0;

    if (redeemed.linkId !== null) {
      const link = await tx.queryOne<{
        expires_at: number | null;
        commit_revision: number;
        access_mode: RemoteDesktopAccessMode;
      }>(
        `SELECT expires_at, commit_revision, access_mode
           FROM remote_desktop_guest_links WHERE id = $1 FOR UPDATE`,
        [redeemed.linkId],
      );
      if (!link || link.access_mode !== redeemed.mode) throw new GuestAdmissionRefused();
      expiresAt = link.expires_at ?? 0;
      commitRevision = link.commit_revision;
      const live = await tx.queryOne<{
        id: string;
        browser_key_hash: string | null;
        route_id: string | null;
      }>(
        `SELECT id, browser_key_hash, route_id
           FROM remote_desktop_guest_sessions
          WHERE link_id = $1 AND browser_key_hash = $2
            AND state IN ('admitting', 'active')
          FOR UPDATE`,
        [redeemed.linkId, keyHash],
      );
      // Exact reconnect is possible only after the old route closes and clears
      // its durable route binding. A concurrent live socket never gets adopted.
      if (live) {
        if (live.route_id !== null || live.browser_key_hash === null
          || !constantTimeEqualHex(live.browser_key_hash, keyHash)) throw new GuestAdmissionRefused();
        sessionId = live.id;
      } else {
        sessionId = randomUUID();
        await tx.execute(
          `INSERT INTO remote_desktop_guest_sessions
             (id, link_id, host_id, browser_key_hash, actor_kind,
              authority_generation, expiry_revision, absolute_expires_at,
              state, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'admitting',$9,$9)`,
          [sessionId, redeemed.linkId, redeemed.hostId, keyHash, redeemed.actorSource,
            redeemed.authorityGeneration, redeemed.expiryRevision, expiresAt || null, input.now],
        );
      }
    } else {
      const publicId = await tx.queryOne<{ public_id: string }>(
        "SELECT public_id FROM remote_desktop_public_ids WHERE host_id = $1 AND status = 'active'",
        [redeemed.hostId],
      );
      if (!publicId) throw new GuestAdmissionRefused();
      publicNodeId = Number(publicId.public_id);
      sessionId = randomUUID();
      await tx.execute(
        `INSERT INTO remote_desktop_guest_sessions
           (id, link_id, host_id, browser_key_hash, actor_kind,
            authority_generation, expiry_revision, password_generation,
            absolute_expires_at, state, created_at, updated_at)
         VALUES ($1,NULL,$2,$3,$4,$5,NULL,$5,NULL,'admitting',$6,$6)`,
        [sessionId, redeemed.hostId, keyHash, redeemed.actorSource,
          redeemed.credentialGeneration, input.now],
      );
    }

    const actorAuditId = redeemed.linkId
      ?? `password:${redeemed.hostId}:${redeemed.credentialGeneration}`;
    const bound = await tx.execute(
      `UPDATE remote_desktop_guest_sessions
          SET route_id = $2, route_generation = $3, source_ip = $4::inet, updated_at = $5
        WHERE id = $1 AND state = 'admitting'`,
      [sessionId, sessionId, input.routeGeneration, input.clientIp, input.now],
    );
    if (bound.changes !== 1) throw new GuestAdmissionRefused();
    await reserveRouteTx(tx, {
      hostId: redeemed.hostId,
      routeId: sessionId,
      routeGeneration: input.routeGeneration,
      actorSource: redeemed.actorSource,
      actorAuditId,
      executionServerId: redeemed.serverId,
      guestSessionId: sessionId,
      now: input.now,
    });

    const actor: RemoteDesktopActor = redeemed.linkId !== null
      ? {
        source: redeemed.actorSource as typeof REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK
          | typeof REMOTE_DESKTOP_ACTOR_SOURCE.UNATTENDED_LINK,
        auditId: actorAuditId,
        hostId: redeemed.hostId,
        endpointGeneration: input.routeGeneration,
        modeCeiling: redeemed.mode,
        authorityGeneration: redeemed.authorityGeneration,
        expiryRevision: redeemed.expiryRevision ?? 1,
        expiresAt,
        linkId: redeemed.linkId,
        browserKeyThumbprint: redeemed.browserKeyThumbprint,
      }
      : {
        source: REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD,
        auditId: actorAuditId,
        hostId: redeemed.hostId,
        endpointGeneration: input.routeGeneration,
        modeCeiling: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        authorityGeneration: redeemed.credentialGeneration,
        expiryRevision: 0,
        expiresAt: 0,
        publicNodeId,
      };
    const registryAuthority = redeemed.linkId !== null
      ? {
        actorSource: actor.source as typeof REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK
          | typeof REMOTE_DESKTOP_ACTOR_SOURCE.UNATTENDED_LINK,
        actorAuditId,
        authorityGeneration: redeemed.authorityGeneration,
        expiryRevision: redeemed.expiryRevision ?? 1,
        commitRevision,
      }
      : {
        actorSource: REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD,
        actorAuditId,
        sessionAuditId: sessionId,
        passwordGeneration: redeemed.credentialGeneration,
      };
    return { actor, sessionId, routeGeneration: input.routeGeneration, registryAuthority };
  }).catch((error: unknown) => {
    if (error instanceof GuestAdmissionRefused) return null;
    throw error;
  });
}

/** Re-resolve the original guest authority without trusting process memory. */
export async function resolveRedeemedGuestActor(input: {
  db: Database;
  previous: RemoteDesktopActor;
  serverId: string;
  endpointGeneration: number;
  now: number;
}): Promise<RemoteDesktopActor | null> {
  if (input.previous.source === REMOTE_DESKTOP_ACTOR_SOURCE.ACCOUNT) return null;
  const endpoint = await input.db.queryOne<{ host_id: string }>(
    'SELECT host_id FROM remote_desktop_host_endpoints WHERE server_id = $1',
    [input.serverId],
  );
  if (!endpoint || endpoint.host_id !== input.previous.hostId) return null;
  if (input.previous.source === REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK
    || input.previous.source === REMOTE_DESKTOP_ACTOR_SOURCE.UNATTENDED_LINK) {
    const row = await input.db.queryOne<{
      state: string;
      attendance: string;
      access_mode: RemoteDesktopAccessMode;
      authority_generation: number;
      expiry_revision: number;
      expires_at: number | null;
      browser_key_hash: string | null;
    }>(
      `SELECT l.state, l.attendance, l.access_mode, l.authority_generation,
              l.expiry_revision, l.expires_at, c.browser_key_hash
         FROM remote_desktop_guest_links l
         LEFT JOIN remote_desktop_guest_browser_claims c
           ON c.link_id = l.id AND c.browser_key_hash = $3
        WHERE l.id = $1 AND l.host_id = $2`,
      [input.previous.linkId, input.previous.hostId,
        hashBrowserKey(input.previous.browserKeyThumbprint)],
    );
    const expectedSource = row?.attendance === REMOTE_DESKTOP_LINK_KIND.ATTENDED
      ? REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK
      : REMOTE_DESKTOP_ACTOR_SOURCE.UNATTENDED_LINK;
    if (!row || row.state !== 'active' || expectedSource !== input.previous.source
      || row.browser_key_hash === null
      || !constantTimeEqualHex(row.browser_key_hash, hashBrowserKey(input.previous.browserKeyThumbprint))
      || (row.expires_at !== null && row.expires_at <= input.now)) return null;
    return {
      ...input.previous,
      endpointGeneration: input.endpointGeneration,
      modeCeiling: row.access_mode,
      authorityGeneration: row.authority_generation,
      expiryRevision: row.expiry_revision,
      expiresAt: row.expires_at ?? 0,
    };
  }
  if (input.previous.source !== REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD) return null;
  const row = await input.db.queryOne<{
    generation: number;
    disabled_at: number | null;
    public_id: string | null;
  }>(
    `SELECT p.generation, p.disabled_at, i.public_id
       FROM remote_desktop_unattended_passwords p
       LEFT JOIN remote_desktop_public_ids i
         ON i.host_id = p.host_id AND i.status = 'active'
      WHERE p.host_id = $1`,
    [input.previous.hostId],
  );
  const previousPassword = input.previous as Extract<RemoteDesktopActor, {
    source: typeof REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD;
  }>;
  if (!row || row.disabled_at !== null || Number(row.public_id) !== previousPassword.publicNodeId) return null;
  return {
    ...input.previous,
    endpointGeneration: input.endpointGeneration,
    authorityGeneration: row.generation,
  };
}

/** Drop expired unredeemed tickets. Redeemed rows are retained for audit. */
export async function sweepExpiredBootstraps(
  db: Database,
  input: { now: number; limit?: number },
): Promise<{ removed: number }> {
  const result = await db.execute(
    `DELETE FROM remote_desktop_guest_bootstraps
      WHERE ticket_hash IN (
        SELECT ticket_hash FROM remote_desktop_guest_bootstraps
         WHERE redeemed_at IS NULL AND expires_at <= $1
         ORDER BY expires_at LIMIT $2
      )`,
    [input.now, input.limit ?? 500],
  );
  return { removed: result.changes };
}

export { randomUUID as newBootstrapCorrelationId };
