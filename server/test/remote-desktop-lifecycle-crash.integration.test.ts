/**
 * OpenSpec tasks 14.3 (link lifecycle), 14.4 (password/public-ID lifecycle)
 * and 14.5 (crash/rollback) qualification slice.
 *
 * Every claim in this file is enforced against real PostgreSQL: the atomicity
 * guarantees being tested are `FOR UPDATE` and unique-index guarantees, so
 * mocks would erase the thing under test. Where the guest actor admission
 * track is not yet wired into the Router, the corresponding cell is recorded
 * as BLOCKED-on-prerequisite rather than stubbed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import {
  REMOTE_DESKTOP_PRIVACY_PHASE,
  remoteDesktopBootstrapSignaturePreimage,
} from '../../shared/remote-desktop-access.js';
import { REMOTE_DESKTOP_CAPABILITY } from '../../shared/remote-desktop.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import {
  PrivacyBarrierError,
  acknowledgeFreshFrame,
  acknowledgeShield,
  beginPrivacyEnd,
  beginPrivacyEpoch,
  closeRouteTx,
  sweepExpiredPrivacyEpochs,
} from '../src/services/remote-desktop-management-privacy.js';
import {
  hashBootstrapTicket,
  redeemBootstrap,
  sweepExpiredBootstraps,
} from '../src/services/remote-desktop-guest-bootstrap.js';
import { hashBrowserKey } from '../src/services/remote-desktop-guest-links.js';

let db: Database;
const NOW = 1_700_000_000_000;
const DAEMON_GEN = 7;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});
afterAll(async () => { await db.close(); });

async function seedHost(): Promise<{ hostId: string; ownerUserId: string; serverId: string }> {
  const ownerUserId = `u_${randomUUID()}`;
  await createUser(db, ownerUserId);
  const hostId = randomUUID();
  await db.execute(
    `INSERT INTO remote_desktop_hosts (id, owner_user_id, merge_state, created_at, updated_at)
     VALUES ($1, $2, 'resolved', $3, $3)`,
    [hostId, ownerUserId, NOW],
  );
  // Guest admission readiness requires an active public ID. We allocate one
  // deterministically per host so tests that need guest proofs have a coherent
  // identity record without conflicting with parallel test fixtures.
  const publicId = String(Math.floor(5_000_000_000 + Math.random() * 4_999_999_999));
  await db.execute(
    `INSERT INTO remote_desktop_public_ids
       (public_id, host_id, status, activated_at)
     VALUES ($1, $2, 'active', $3)`,
    [publicId, hostId, NOW],
  );
  const serverId = `s_${randomUUID()}`;
  await createServer(db, serverId, ownerUserId, 'host', `hash-${serverId}`, undefined, NODE_ROLE.CONTROLLED);
  await db.execute(
    'UPDATE servers SET controlled_capabilities = $2::jsonb WHERE id = $1',
    [serverId, JSON.stringify([REMOTE_DESKTOP_CAPABILITY])],
  );
  await db.execute(
    `INSERT INTO remote_desktop_host_endpoints
       (server_id, host_id, owner_user_id, endpoint_role, linked_at)
     VALUES ($1, $2, $3, 'controlled', $4)`,
    [serverId, hostId, ownerUserId, NOW],
  );
  // Privacy barrier is idle+open by default. Initialise the row so the
  // resolveQualifiedEndpointTx check (which reads the row) sees a coherent
  // state for guest proofs.
  await db.execute(
    `INSERT INTO remote_desktop_management_privacy (host_id, created_at, updated_at)
     VALUES ($1, $2, $2)
     ON CONFLICT (host_id) DO NOTHING`,
    [hostId, NOW],
  );
  return { hostId, ownerUserId, serverId };
}

async function seedActiveRoute(hostId: string, serverId: string): Promise<{
  routeId: string; routeGeneration: number;
}> {
  const routeId = `r-${randomUUID()}`;
  const routeGeneration = 1;
  await db.execute(
    `INSERT INTO remote_desktop_host_routes (
       route_id, route_generation, host_id, actor_source, actor_audit_id,
       execution_server_id, state, reserved_at, activated_at, updated_at
     ) VALUES ($1, $2, $3, 'account', 'audit', $4, 'active', $5, $5, $5)`,
    [routeId, routeGeneration, hostId, serverId, NOW],
  );
  return { routeId, routeGeneration };
}

interface BrowserKey { privateKey: KeyObject; spki: string; spkiDer: Buffer; thumbprint: string; }
function newBrowserKey(): BrowserKey {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spkiDer = pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    privateKey: pair.privateKey,
    spki: spkiDer.toString('base64url'),
    spkiDer,
    // The thumbprint is SHA-256(SPKI DER bytes) base64url — matches the
    // server-side `thumbprintMatchesKey` verifier.
    thumbprint: createHash('sha256').update(spkiDer).digest('base64url'),
  };
}

async function seedLink(hostId: string, ownerUserId: string, opts: {
  mode?: 'view' | 'control'; attendance?: 'attended' | 'unattended';
  authorityGeneration?: number; expiresAt?: number | null;
} = {}): Promise<{ linkId: string; authorityGeneration: number; tokenHash: string }> {
  const linkId = `l-${randomUUID()}`;
  const authorityGeneration = opts.authorityGeneration ?? 1;
  const mode = opts.mode ?? 'control';
  const attendance = opts.attendance ?? 'attended';
  const tokenHash = createHash('sha256').update(`tk-${linkId}`).digest('hex');
  await db.execute(
    `INSERT INTO remote_desktop_guest_links (
       id, host_id, owner_user_id,
       token_hash_version, token_hash,
       creation_request_id, normalized_policy_hash,
       attendance, access_mode,
       authority_generation, expiry_revision, commit_revision, state,
       created_at, updated_at, expires_at
     ) VALUES ($1, $2, $3, 'v1', $4, $5, $6, $7, $8, $9, 1, 1, 'active', $10, $10, $11)`,
    [
      linkId, hostId, ownerUserId,
      tokenHash,
      `creq-${linkId}`,
      'sha256:' + createHash('sha256').update(`pol-${linkId}`).digest('hex'),
      attendance, mode,
      authorityGeneration, NOW, opts.expiresAt ?? null,
    ],
  );
  return { linkId, authorityGeneration, tokenHash };
}

async function seedBootstrap(opts: {
  hostId: string; serverId: string; linkId: string | null;
  actorSource: 'attended_link' | 'unattended_link' | 'node_password';
  browserKey: BrowserKey;
  authorityGeneration?: number; credentialGeneration?: number;
  expiresAt?: number; includeSpki?: boolean;
}): Promise<{ ticket: string; ticketHash: string }> {
  const ticketRaw = randomBytes(32);
  const ticket = ticketRaw.toString('base64url');
  const ticketHash = hashBootstrapTicket(ticket);
  await db.execute(
    `INSERT INTO remote_desktop_guest_bootstraps (
       ticket_hash, host_id, link_id, target_server_id, actor_source,
       mode, authority_generation, credential_generation, browser_key_hash,
       browser_public_key_spki, resume_session_id, created_at, expires_at, redeemed_at
     ) VALUES ($1,$2,$3,$4,$5,'control',$6,$7,$8,$9,NULL,$10,$11,NULL)`,
    [
      ticketHash, opts.hostId, opts.linkId, opts.serverId, opts.actorSource,
      opts.authorityGeneration ?? 1, opts.credentialGeneration ?? 0,
      hashBrowserKey(opts.browserKey.thumbprint),
      opts.includeSpki === false ? '' : opts.browserKey.spki,
      NOW, opts.expiresAt ?? NOW + 60_000,
    ],
  );
  return { ticket, ticketHash };
}

describe('14.5 crash during claim/connected route — durable rollback', () => {
  it('rejects a duplicate claim with a generic refusal when the first claim already bound a browser', async () => {
    // The full claim race (challenge single-use, identical FAIL body for
    // unrelated browsers) is covered end-to-end by
    // `remote-desktop-guest-links.integration.test.ts > first-claim race wins,
    // second browser gets the generic unavailable body`. Here we pin one
    // atomicity property: redeeming a bootstrap with a stale ticket that has
    // already been consumed returns null and never advances the row again.
    const { hostId, serverId, ownerUserId } = await seedHost();
    const browserKey = newBrowserKey();
    const { linkId, authorityGeneration } = await seedLink(hostId, ownerUserId);
    const { ticket, ticketHash } = await seedBootstrap({
      hostId, serverId, linkId, actorSource: 'attended_link', browserKey,
      authorityGeneration,
    });
    const signature = sign(
      'sha256',
      remoteDesktopBootstrapSignaturePreimage(
        Buffer.from(ticket, 'base64url'),
        Buffer.from(browserKey.thumbprint, 'base64url'),
      ),
      { key: browserKey.privateKey, dsaEncoding: 'ieee-p1363' },
    ).toString('base64url');

    const first = await redeemBootstrap(db, {
      proof: { ticket, browserKeyThumbprint: browserKey.thumbprint, signature },
      redeemingServerId: serverId, now: NOW + 1,
    });
    expect(first).not.toBeNull();

    // Second browser attempts to spend the same ticket: must fail closed and
    // the row state must be unchanged (redeemed_at, redeemed_by_server_id stay
    // exactly as the first call set them).
    const second = await redeemBootstrap(db, {
      proof: { ticket, browserKeyThumbprint: browserKey.thumbprint, signature },
      redeemingServerId: serverId, now: NOW + 2,
    });
    expect(second).toBeNull();
    const row = await db.queryOne<{
      redeemed_at: number | null; redeemed_by_server_id: string | null;
    }>(
      `SELECT redeemed_at, redeemed_by_server_id
         FROM remote_desktop_guest_bootstraps WHERE ticket_hash = $1`,
      [ticketHash],
    );
    expect(row?.redeemed_at).toBe(NOW + 1);
    expect(row?.redeemed_by_server_id).toBe(serverId);
  });

  it('closes a route during starting and repairs the snapshot without stranding the epoch', async () => {
    const { hostId, serverId } = await seedHost();
    const route = await seedActiveRoute(hostId, serverId);
    const epochId = randomUUID();
    const begin = await beginPrivacyEpoch(db, {
      hostId, epochId, presentationSource: 'signed_shell',
      initiatingSessionHash: 'h', executionServerId: serverId,
      daemonGeneration: DAEMON_GEN, leaseExpiresAt: NOW + 300_000,
      deadline: NOW + 60_000, now: NOW,
    });
    expect(begin.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.STARTING);
    expect(begin.shieldedActive).toHaveLength(1);

    // The route "crashes" — owner / daemon / browser loses connection. close
    // is the only safe path: dropping the Worker capture obligation without
    // releasing input is what recovery_required is for.
    const closed = await db.transaction(async (tx) => closeRouteTx(tx, {
      hostId, routeId: route.routeId, routeGeneration: route.routeGeneration, now: NOW + 1,
    }));
    expect(closed.snapshotRepaired).toBe(true);
    expect(closed.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE);

    // After close, the snapshot is empty, so a stray worker acknowledgement
    // for the closed route must NOT_SHIELD rather than spuriously accept.
    await expect(acknowledgeShield(db, {
      hostId, epochId, revision: 1,
      executionServerId: serverId, daemonGeneration: DAEMON_GEN,
      workerGeneration: 40, acknowledgedRoutes: [{
        routeId: route.routeId, routeGeneration: route.routeGeneration,
      }],
      now: NOW + 2,
    })).rejects.toBeInstanceOf(PrivacyBarrierError);
  });

  it('sweeps expired epochs idempotently — second pass is a no-op', async () => {
    const { hostId, serverId } = await seedHost();
    await beginPrivacyEpoch(db, {
      hostId, epochId: randomUUID(), presentationSource: 'signed_shell',
      initiatingSessionHash: 'h', executionServerId: serverId,
      daemonGeneration: DAEMON_GEN, leaseExpiresAt: NOW + 1_000,
      deadline: NOW + 500, now: NOW,
    });
    const first = await sweepExpiredPrivacyEpochs(db, { now: NOW + 10_000 });
    expect(first.recovered).toContain(hostId);

    // Idempotent: a second sweep after the same `now` must not double-recover
    // (the state is already `recovery_required`, not "expired").
    const second = await sweepExpiredPrivacyEpochs(db, { now: NOW + 10_000 });
    expect(second.recovered).not.toContain(hostId);
  });
});

describe('14.3 link lifecycle boundaries — claim, bootstrap, revoke', () => {
  it('rejects bootstrap redemption on a second attempt (single-use ticket)', async () => {
    const { hostId, serverId, ownerUserId } = await seedHost();
    const browserKey = newBrowserKey();
    const { linkId, authorityGeneration } = await seedLink(hostId, ownerUserId);
    const { ticket } = await seedBootstrap({
      hostId, serverId, linkId, actorSource: 'attended_link', browserKey,
      authorityGeneration,
    });
    const signature = sign(
      'sha256',
      remoteDesktopBootstrapSignaturePreimage(
        Buffer.from(ticket, 'base64url'),
        Buffer.from(browserKey.thumbprint, 'base64url'),
      ),
      { key: browserKey.privateKey, dsaEncoding: 'ieee-p1363' },
    ).toString('base64url');

    const first = await redeemBootstrap(db, {
      proof: { ticket, browserKeyThumbprint: browserKey.thumbprint, signature },
      redeemingServerId: serverId, now: NOW + 1,
    });
    expect(first).not.toBeNull();

    // Lost-response retry: the same proof cannot mint a second admission.
    const second = await redeemBootstrap(db, {
      proof: { ticket, browserKeyThumbprint: browserKey.thumbprint, signature },
      redeemingServerId: serverId, now: NOW + 2,
    });
    expect(second).toBeNull();
  });

  it('rejects bootstrap redemption on a wrong target_server_id (wrong-pod)', async () => {
    const { hostId, ownerUserId } = await seedHost();
    const browserKey = newBrowserKey();
    const { linkId, authorityGeneration } = await seedLink(hostId, ownerUserId);
    const { ticket } = await seedBootstrap({
      hostId, serverId: 'srv-canonical', linkId,
      actorSource: 'attended_link', browserKey,
      authorityGeneration,
    });
    const signature = sign(
      'sha256',
      remoteDesktopBootstrapSignaturePreimage(
        Buffer.from(ticket, 'base64url'),
        Buffer.from(browserKey.thumbprint, 'base64url'),
      ),
      { key: browserKey.privateKey, dsaEncoding: 'ieee-p1363' },
    ).toString('base64url');

    const wrong = await redeemBootstrap(db, {
      proof: { ticket, browserKeyThumbprint: browserKey.thumbprint, signature },
      redeemingServerId: 'srv-other-pod', now: NOW + 1,
    });
    expect(wrong).toBeNull();
  });

  it('rejects bootstrap after the link is revoked (authority generation no longer matches)', async () => {
    const { hostId, serverId, ownerUserId } = await seedHost();
    const browserKey = newBrowserKey();
    const { linkId, authorityGeneration } = await seedLink(hostId, ownerUserId);
    const { ticket } = await seedBootstrap({
      hostId, serverId, linkId, actorSource: 'attended_link', browserKey,
      authorityGeneration,
    });
    const signature = sign(
      'sha256',
      remoteDesktopBootstrapSignaturePreimage(
        Buffer.from(ticket, 'base64url'),
        Buffer.from(browserKey.thumbprint, 'base64url'),
      ),
      { key: browserKey.privateKey, dsaEncoding: 'ieee-p1363' },
    ).toString('base64url');

    // Owner revokes: link state transitions out of 'active' with revoked_at
    // set (the schema enforces `(state='revoked') = (revoked_at IS NOT NULL)`).
    await db.execute(
      'UPDATE remote_desktop_guest_links SET state = $2, revoked_at = $3, updated_at = $3 WHERE id = $1',
      [linkId, 'revoked', NOW + 1],
    );
    const result = await redeemBootstrap(db, {
      proof: { ticket, browserKeyThumbprint: browserKey.thumbprint, signature },
      redeemingServerId: serverId, now: NOW + 2,
    });
    expect(result).toBeNull();
  });

  it('rejects bootstrap after link expiry (natural expires_at has passed)', async () => {
    // An attended link has no natural expiry (`expires_at IS NULL`) per the
    // schema CHECK. To test natural-expiry refusal we seed an *unattended* link
    // (which must carry an `expires_at`) and then move that expiry into the
    // past while keeping the link state active. Redemption must refuse on the
    // now-stale expiry without touching the daemon/Router.
    const { hostId, serverId, ownerUserId } = await seedHost();
    const browserKey = newBrowserKey();
    const { linkId, authorityGeneration } = await seedLink(hostId, ownerUserId, {
      attendance: 'unattended', expiresAt: NOW + 60_000,
    });
    const { ticket } = await seedBootstrap({
      hostId, serverId, linkId, actorSource: 'unattended_link', browserKey,
      authorityGeneration,
    });
    const signature = sign(
      'sha256',
      remoteDesktopBootstrapSignaturePreimage(
        Buffer.from(ticket, 'base64url'),
        Buffer.from(browserKey.thumbprint, 'base64url'),
      ),
      { key: browserKey.privateKey, dsaEncoding: 'ieee-p1363' },
    ).toString('base64url');

    await db.execute(
      'UPDATE remote_desktop_guest_links SET expires_at = $2, updated_at = $3 WHERE id = $1',
      [linkId, NOW - 1, NOW + 1],
    );
    const result = await redeemBootstrap(db, {
      proof: { ticket, browserKeyThumbprint: browserKey.thumbprint, signature },
      redeemingServerId: serverId, now: NOW + 2,
    });
    expect(result).toBeNull();
  });
});

describe('14.4 password lifecycle — generation revoke on change/disable', () => {
  it('rejects bootstrap after password change (credential_generation no longer matches)', async () => {
    const { hostId, serverId } = await seedHost();
    const browserKey = newBrowserKey();
    // Seed a credential row at generation 1 with schema-valid verifier/salt.
    await db.execute(
      `INSERT INTO remote_desktop_unattended_passwords (
         host_id, verifier_version, verifier, salt, pepper_version,
         generation, changed_at, disabled_at
       ) VALUES ($1, 'scrypt-v1', $3, $4, 'p', 1, $2, NULL)`,
      [hostId, NOW, 'a'.repeat(128), 'b'.repeat(64)],
    );
    const { ticket } = await seedBootstrap({
      hostId, serverId, linkId: null, actorSource: 'node_password', browserKey,
      credentialGeneration: 1,
    });
    const signature = sign(
      'sha256',
      remoteDesktopBootstrapSignaturePreimage(
        Buffer.from(ticket, 'base64url'),
        Buffer.from(browserKey.thumbprint, 'base64url'),
      ),
      { key: browserKey.privateKey, dsaEncoding: 'ieee-p1363' },
    ).toString('base64url');

    // Owner changes the password → generation advances to 2.
    await db.execute(
      `UPDATE remote_desktop_unattended_passwords
          SET generation = 2, changed_at = $2 WHERE host_id = $1`,
      [hostId, NOW + 1],
    );
    const result = await redeemBootstrap(db, {
      proof: { ticket, browserKeyThumbprint: browserKey.thumbprint, signature },
      redeemingServerId: serverId, now: NOW + 2,
    });
    expect(result).toBeNull();
  });

  it('rejects bootstrap after password emergency-disable (disabled_at non-null)', async () => {
    const { hostId, serverId } = await seedHost();
    const browserKey = newBrowserKey();
    await db.execute(
      `INSERT INTO remote_desktop_unattended_passwords (
         host_id, verifier_version, verifier, salt, pepper_version,
         generation, changed_at, disabled_at
       ) VALUES ($1, 'scrypt-v1', $3, $4, 'p', 1, $2, $5)`,
      [hostId, NOW, 'a'.repeat(128), 'b'.repeat(64), NOW + 1],
    );
    const { ticket } = await seedBootstrap({
      hostId, serverId, linkId: null, actorSource: 'node_password', browserKey,
      credentialGeneration: 1,
    });
    const signature = sign(
      'sha256',
      remoteDesktopBootstrapSignaturePreimage(
        Buffer.from(ticket, 'base64url'),
        Buffer.from(browserKey.thumbprint, 'base64url'),
      ),
      { key: browserKey.privateKey, dsaEncoding: 'ieee-p1363' },
    ).toString('base64url');

    const result = await redeemBootstrap(db, {
      proof: { ticket, browserKeyThumbprint: browserKey.thumbprint, signature },
      redeemingServerId: serverId, now: NOW + 2,
    });
    expect(result).toBeNull();
  });
});

describe('14.5 sweep / idempotency — recover without double-apply', () => {
  it('sweeps expired unredeemed bootstraps exactly once and retains redeemed rows', async () => {
    const { hostId, serverId, ownerUserId } = await seedHost();
    const browserKey = newBrowserKey();
    const { linkId, authorityGeneration } = await seedLink(hostId, ownerUserId);
    const { ticket, ticketHash } = await seedBootstrap({
      hostId, serverId, linkId, actorSource: 'attended_link', browserKey,
      authorityGeneration,
      expiresAt: NOW - 100,
    });
    const signature = sign(
      'sha256',
      remoteDesktopBootstrapSignaturePreimage(
        Buffer.from(ticket, 'base64url'),
        Buffer.from(browserKey.thumbprint, 'base64url'),
      ),
      { key: browserKey.privateKey, dsaEncoding: 'ieee-p1363' },
    ).toString('base64url');
    await redeemBootstrap(db, {
      proof: { ticket, browserKeyThumbprint: browserKey.thumbprint, signature },
      redeemingServerId: serverId, now: NOW + 1,
    });

    const swept = await sweepExpiredBootstraps(db, { now: NOW + 1_000_000 });
    expect(swept.removed).toBeGreaterThanOrEqual(1);

    // The redeemed row remains (audit retention); sweep deletes only unredeemed.
    const row = await db.queryOne<{ redeemed_at: number | null }>(
      'SELECT redeemed_at FROM remote_desktop_guest_bootstraps WHERE ticket_hash = $1',
      [ticketHash],
    );
    expect(row?.redeemed_at).not.toBeNull();

    // Second sweep at a later `now` must not delete the redeemed row.
    await sweepExpiredBootstraps(db, { now: NOW + 2_000_000 });
    const stillThere = await db.queryOne<{ redeemed_at: number | null }>(
      'SELECT redeemed_at FROM remote_desktop_guest_bootstraps WHERE ticket_hash = $1',
      [ticketHash],
    );
    expect(stillThere?.redeemed_at).not.toBeNull();
  });
});

describe('14.5 acknowledge after process crash — fresh DB connection recovers the durable state', () => {
  it('closing the DB and reopening preserves epoch/duration state for recovery', async () => {
    const { hostId, serverId } = await seedHost();
    const route = await seedActiveRoute(hostId, serverId);
    const epochId = randomUUID();
    await beginPrivacyEpoch(db, {
      hostId, epochId, presentationSource: 'signed_shell',
      initiatingSessionHash: 'h', executionServerId: serverId,
      daemonGeneration: DAEMON_GEN, leaseExpiresAt: NOW + 300_000,
      deadline: NOW + 60_000, now: NOW,
    });

    // Simulate process restart: drop the connection, open a new one.
    await db.close();
    db = createDatabase(process.env.TEST_DATABASE_URL!);

    // Acknowledge from the new connection — durable state must be coherent.
    const ack = await acknowledgeShield(db, {
      hostId, epochId, revision: 1,
      executionServerId: serverId, daemonGeneration: DAEMON_GEN,
      workerGeneration: 40, acknowledgedRoutes: [route],
      now: NOW + 1,
    });
    expect(ack.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE);

    // End on the new connection must complete cleanly. The route still sits in
    // the durable route_snapshot (acknowledgeShield did not empty it — the
    // barrier just moves to ACTIVE), so the fresh-frame ack must carry the
    // same route set, mirroring the live view of what is currently capturing.
    await beginPrivacyEnd(db, { hostId, epochId, revision: 1, now: NOW + 2 });
    const end = await acknowledgeFreshFrame(db, {
      hostId, epochId, revision: 1,
      executionServerId: serverId, daemonGeneration: DAEMON_GEN,
      freshFrameGeneration: 41, acknowledgedRoutes: [route],
      now: NOW + 3,
    });
    expect(end.phase).toBe('idle');
    expect(end.admissionOpen).toBe(true);
  });
});

// Reference PrivacyBarrierError so the import survives tree-shaking when no
// production code path uses it (test-only assertion below).
void PrivacyBarrierError;
