import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/queries.js';
import {
  digestStepUpAction,
  finalizeStepUpChallenge,
  loadStepUpChallenge,
  storeStepUpChallenge,
  type AccountSession,
} from '../src/services/remote-desktop-account-auth.js';
import {
  OWNER_HOST_MANAGEMENT_ERROR,
  OwnerHostManagementError,
  getOwnerRemoteDesktopHostSummary,
  rotateOwnerPublicNodeId,
} from '../src/services/remote-desktop-owner-management.js';
import {
  hashBootstrapTicket,
  issueNodePasswordBootstrap,
} from '../src/services/remote-desktop-guest-bootstrap.js';

let db: Database;
const NOW = 1_700_000_000_000;
const PASSWORD_BROWSER_KEY = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
const PASSWORD_BROWSER_SPKI = (
  PASSWORD_BROWSER_KEY.export({ format: 'der', type: 'spki' }) as Buffer
).toString('base64url');
const PASSWORD_BROWSER_THUMBPRINT = createHash('sha256')
  .update(Buffer.from(PASSWORD_BROWSER_SPKI, 'base64url'))
  .digest('base64url');

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function interceptDatabase(base: Database, hooks: {
  beforeQueryOne?: (sql: string, params: unknown[]) => Promise<void> | void;
  afterExecute?: (sql: string, params: unknown[]) => Promise<void> | void;
}): Database {
  const wrapped = {
    query: <T>(sql: string, params: unknown[] = []) => base.query<T>(sql, params),
    queryOne: async <T>(sql: string, params: unknown[] = []) => {
      await hooks.beforeQueryOne?.(sql, params);
      return base.queryOne<T>(sql, params);
    },
    execute: async (sql: string, params: unknown[] = []) => {
      const result = await base.execute(sql, params);
      await hooks.afterExecute?.(sql, params);
      return result;
    },
    exec: (sql: string) => base.exec(sql),
    transaction: <T>(fn: (tx: Database) => Promise<T>) => (
      base.transaction((tx) => fn(interceptDatabase(tx, hooks)))
    ),
  };
  return wrapped as unknown as Database;
}

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});
afterAll(async () => { await db.close(); });

interface Fixture {
  ownerUserId: string;
  hostId: string;
  session: AccountSession;
  credentialId: string;
  publicNodeId: string;
}

async function fixture(): Promise<Fixture> {
  const ownerUserId = `u_${randomUUID()}`;
  await createUser(db, ownerUserId);
  const hostId = randomUUID();
  const publicNodeId = `5${String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0')}`;
  await db.execute(
    `INSERT INTO remote_desktop_hosts (id, owner_user_id, merge_state, created_at, updated_at)
     VALUES ($1, $2, 'resolved', $3, $3)`,
    [hostId, ownerUserId, NOW],
  );
  await db.execute(
    `INSERT INTO remote_desktop_public_ids (public_id, host_id, status, activated_at)
     VALUES ($1, $2, 'active', $3)`,
    [publicNodeId, hostId, NOW],
  );
  const credentialId = `cred_${randomUUID()}`;
  await db.execute(
    `INSERT INTO passkey_credentials (id, user_id, public_key, counter, created_at)
     VALUES ($1, $2, 'pk', 0, $3)`,
    [credentialId, ownerUserId, NOW],
  );
  return {
    ownerUserId,
    hostId,
    publicNodeId,
    credentialId,
    session: { kind: 'web', id: `session_${randomUUID()}`, userId: ownerUserId },
  };
}

async function seedPasswordIssuanceState(fx: Fixture): Promise<{
  serverId: string;
  generation: number;
  admittedSessionId: string;
}> {
  const serverId = `server_${randomUUID()}`;
  const generation = 7;
  await db.execute(
    `INSERT INTO servers
       (id, user_id, name, token_hash, status, last_heartbeat_at, created_at, node_role)
     VALUES ($1, $2, 'password-target', $3, 'online', $4, $4, 'full')`,
    [serverId, fx.ownerUserId, createHash('sha256').update(serverId).digest('hex'), NOW],
  );
  await db.execute(
    `INSERT INTO remote_desktop_host_endpoints
       (server_id, host_id, owner_user_id, endpoint_role, linked_at)
     VALUES ($1, $2, $3, 'full', $4)`,
    [serverId, fx.hostId, fx.ownerUserId, NOW],
  );
  await db.execute(
    `INSERT INTO remote_desktop_management_privacy
       (host_id, revision, phase, admission_open, created_at, updated_at)
     VALUES ($1, 0, 'idle', TRUE, $2, $2)`,
    [fx.hostId, NOW],
  );
  await db.execute(
    `INSERT INTO remote_desktop_unattended_passwords
       (host_id, verifier_version, verifier, salt, pepper_version,
        generation, changed_at)
     VALUES ($1, 'scrypt-v1', $2, $3, 'v1', $4, $5)`,
    [fx.hostId, 'a'.repeat(128), 'b'.repeat(64), generation, NOW],
  );
  const admittedSessionId = randomUUID();
  await db.execute(
    `INSERT INTO remote_desktop_guest_sessions
       (id, host_id, browser_key_hash, actor_kind, authority_generation,
        password_generation, state, created_at, updated_at)
     VALUES ($1, $2, 'browser-password', 'node_password', $3, $3, 'active', $4, $4)`,
    [admittedSessionId, fx.hostId, generation, NOW],
  );
  return { serverId, generation, admittedSessionId };
}

function requestId(): string {
  return randomBytes(32).toString('base64url');
}

async function mintGrant(
  fx: Fixture,
  action: Record<string, unknown>,
  id: string,
): Promise<string> {
  const { challengeId } = await storeStepUpChallenge(db, {
    accountSession: fx.session,
    canonicalHostId: fx.hostId,
    actionDigest: digestStepUpAction(action),
    requestId: id,
    challenge: randomBytes(32).toString('base64url'),
    rpId: 'imcodes.test',
    origin: 'https://imcodes.test',
    deadline: NOW + 120_000,
  }, NOW);
  const challenge = await loadStepUpChallenge(db, challengeId, NOW);
  const finalized = await finalizeStepUpChallenge(db, {
    challenge: challenge!,
    completingSession: fx.session,
    credentialId: fx.credentialId,
    expectedCounter: 0,
    newCounter: 1,
    userVerified: true,
  }, NOW);
  return finalized!.grantToken;
}

async function seedRotationState(fx: Fixture): Promise<{
  liveSessionId: string;
  livePasswordSessionId: string;
  pendingPasswordTicket: string;
  redeemedPasswordTicket: string;
  pendingLinkTicket: string;
}> {
  const linkId = randomUUID();
  await db.execute(
    `INSERT INTO remote_desktop_guest_links
       (id, host_id, owner_user_id, token_hash_version, token_hash,
        creation_request_id, normalized_policy_hash, label, attendance,
        access_mode, created_at, updated_at)
     VALUES ($1, $2, $3, 'v1', $4, $5, $6, 'desk', 'attended', 'view', $7, $7)`,
    [
      linkId, fx.hostId, fx.ownerUserId,
      createHash('sha256').update(`token:${linkId}`).digest('hex'),
      requestId(), createHash('sha256').update(`policy:${linkId}`).digest('hex'), NOW,
    ],
  );
  const liveSessionId = randomUUID();
  await db.execute(
    `INSERT INTO remote_desktop_guest_sessions
       (id, link_id, host_id, browser_key_hash, actor_kind, authority_generation,
        expiry_revision, state, created_at, updated_at)
     VALUES ($1, $2, $3, 'browser', 'attended_link', 1, 1, 'active', $4, $4)`,
    [liveSessionId, linkId, fx.hostId, NOW],
  );
  const livePasswordSessionId = randomUUID();
  await db.execute(
    `INSERT INTO remote_desktop_guest_sessions
       (id, host_id, browser_key_hash, actor_kind, authority_generation,
        password_generation, state, created_at, updated_at)
     VALUES ($1, $2, 'browser-password', 'node_password', 1, 1, 'active', $3, $3)`,
    [livePasswordSessionId, fx.hostId, NOW],
  );

  const pendingPasswordTicket = createHash('sha256').update(`pending-password:${fx.hostId}`).digest('hex');
  const redeemedPasswordTicket = createHash('sha256').update(`redeemed-password:${fx.hostId}`).digest('hex');
  const pendingLinkTicket = createHash('sha256').update(`pending-link:${fx.hostId}`).digest('hex');
  const common = [fx.hostId, 'server-1', 'view', 1, 1, 'browser', 's'.repeat(122), NOW + 60_000, NOW];
  await db.execute(
    `INSERT INTO remote_desktop_guest_bootstraps
       (ticket_hash, host_id, target_server_id, actor_source, mode,
        authority_generation, credential_generation, browser_key_hash,
        browser_public_key_spki, expires_at, created_at)
     VALUES ($1, $2, $3, 'node_password', $4, $5, $6, $7, $8, $9, $10)`,
    [pendingPasswordTicket, ...common],
  );
  await db.execute(
    `INSERT INTO remote_desktop_guest_bootstraps
       (ticket_hash, host_id, target_server_id, actor_source, mode,
        authority_generation, credential_generation, browser_key_hash,
        browser_public_key_spki, expires_at, created_at, redeemed_at, redeemed_by_server_id)
     VALUES ($1, $2, $3, 'node_password', $4, $5, $6, $7, $8, $9, $10, $11, $3)`,
    [redeemedPasswordTicket, ...common, NOW + 1],
  );
  await db.execute(
    `INSERT INTO remote_desktop_guest_bootstraps
       (ticket_hash, host_id, link_id, target_server_id, actor_source, mode,
        authority_generation, expiry_revision, credential_generation,
        browser_key_hash, browser_public_key_spki, expires_at, created_at)
     VALUES ($1, $2, $3, $4, 'attended_link', $5, $6, 1, $7, $8, $9, $10, $11)`,
    [pendingLinkTicket, fx.hostId, linkId, ...common.slice(1)],
  );
  return {
    liveSessionId,
    livePasswordSessionId,
    pendingPasswordTicket,
    redeemedPasswordTicket,
    pendingLinkTicket,
  };
}

describe('Owner public identity management (real PostgreSQL)', () => {
  it('returns only the authenticated Owner canonical-host summary', async () => {
    const fx = await fixture();
    await expect(getOwnerRemoteDesktopHostSummary(db, {
      accountSession: fx.session,
      hostId: fx.hostId,
    })).resolves.toEqual({
      hostId: fx.hostId,
      publicNodeId: fx.publicNodeId,
      mergeState: 'resolved',
    });

    const stranger = await fixture();
    await expect(getOwnerRemoteDesktopHostSummary(db, {
      accountSession: stranger.session,
      hostId: fx.hostId,
    })).rejects.toMatchObject({ code: OWNER_HOST_MANAGEMENT_ERROR.UNAUTHORIZED });
  });

  it('rotates for a current Web Owner without a configured Passkey', async () => {
    const fx = await fixture();
    await db.execute('DELETE FROM passkey_credentials WHERE user_id = $1', [fx.ownerUserId]);

    const rotated = await rotateOwnerPublicNodeId(db, {
      accountSession: fx.session,
      hostId: fx.hostId,
      requestId: requestId(),
      now: NOW + 1,
    });

    expect(rotated.previousPublicNodeId).toBe(fx.publicNodeId);
    expect(rotated.host.publicNodeId).not.toBe(fx.publicNodeId);
    expect(rotated.replayed).toBe(false);
  });

  it('atomically rotates with action-bound step-up, cancels only old-ID password bootstraps, and preserves admitted routes', async () => {
    const fx = await fixture();
    const seeded = await seedRotationState(fx);
    const id = requestId();
    const action = { kind: 'remote_desktop.public_id.rotate', hostId: fx.hostId };
    const grant = await mintGrant(fx, action, id);
    const rotated = await rotateOwnerPublicNodeId(db, {
      accountSession: fx.session,
      hostId: fx.hostId,
      requestId: id,
      stepUpToken: grant,
      now: NOW + 2,
    });

    expect(rotated.previousPublicNodeId).toBe(fx.publicNodeId);
    expect(rotated.host.publicNodeId).not.toBe(fx.publicNodeId);
    expect(rotated.replayed).toBe(false);
    expect(await db.queryOne(
      'SELECT ticket_hash FROM remote_desktop_guest_bootstraps WHERE ticket_hash = $1',
      [seeded.pendingPasswordTicket],
    )).toBeNull();
    expect(await db.queryOne(
      'SELECT ticket_hash FROM remote_desktop_guest_bootstraps WHERE ticket_hash = $1',
      [seeded.redeemedPasswordTicket],
    )).not.toBeNull();
    expect(await db.queryOne(
      'SELECT ticket_hash FROM remote_desktop_guest_bootstraps WHERE ticket_hash = $1',
      [seeded.pendingLinkTicket],
    )).not.toBeNull();
    expect(await db.queryOne<{ state: string }>(
      'SELECT state FROM remote_desktop_guest_sessions WHERE id = $1',
      [seeded.liveSessionId],
    )).toEqual({ state: 'active' });
    expect(await db.queryOne<{ state: string }>(
      'SELECT state FROM remote_desktop_guest_sessions WHERE id = $1',
      [seeded.livePasswordSessionId],
    )).toEqual({ state: 'active' });

    const replay = await rotateOwnerPublicNodeId(db, {
      accountSession: fx.session,
      hostId: fx.hostId,
      requestId: id,
      stepUpToken: grant,
      now: NOW + 3,
    });
    expect(replay).toEqual({ ...rotated, replayed: true });
  });

  it('rotation-first serializes on the active public-ID row and rejects the old proof snapshot', async () => {
    const fx = await fixture();
    const issuance = await seedPasswordIssuanceState(fx);
    const id = requestId();
    const action = { kind: 'remote_desktop.public_id.rotate', hostId: fx.hostId };
    const grant = await mintGrant(fx, action, id);
    const rotationHoldingId = deferred();
    const releaseRotation = deferred();
    let heldRotation = false;
    const rotationDb = interceptDatabase(db, {
      afterExecute: async (sql) => {
        const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
        if (!heldRotation
          && normalized.startsWith('update remote_desktop_public_ids')
          && normalized.includes("set status = 'retired'")) {
          heldRotation = true;
          rotationHoldingId.resolve();
          await releaseRotation.promise;
        }
      },
    });
    const rotation = rotateOwnerPublicNodeId(rotationDb, {
      accountSession: fx.session,
      hostId: fx.hostId,
      requestId: id,
      stepUpToken: grant,
      now: NOW + 10,
    });
    await rotationHoldingId.promise;

    const issuerAtIdLock = deferred();
    let issueSettled = false;
    const issueDb = interceptDatabase(db, {
      beforeQueryOne: (sql) => {
        const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
        if (normalized.startsWith('select public_id from remote_desktop_public_ids')
          && normalized.includes('public_id = $1')
          && normalized.endsWith('for update')) issuerAtIdLock.resolve();
      },
    });
    const issue = issueNodePasswordBootstrap(issueDb, {
      hostId: fx.hostId,
      publicNodeId: fx.publicNodeId,
      credentialGeneration: issuance.generation,
      browserPublicKeySpki: PASSWORD_BROWSER_SPKI,
      browserKeyThumbprint: PASSWORD_BROWSER_THUMBPRINT,
      now: NOW + 11,
      fullEndpointEligible: async (serverId) => serverId === issuance.serverId,
    }).finally(() => { issueSettled = true; });
    await issuerAtIdLock.promise;
    await nextTask();
    expect(issueSettled).toBe(false);

    releaseRotation.resolve();
    const [rotated, issued] = await Promise.all([rotation, issue]);
    expect(rotated.previousPublicNodeId).toBe(fx.publicNodeId);
    expect(issued).toBeNull();
    expect(await db.queryOne<{ generation: number }>(
      'SELECT generation FROM remote_desktop_unattended_passwords WHERE host_id = $1',
      [fx.hostId],
    )).toEqual({ generation: issuance.generation });
    expect(await db.queryOne<{ state: string }>(
      'SELECT state FROM remote_desktop_guest_sessions WHERE id = $1',
      [issuance.admittedSessionId],
    )).toEqual({ state: 'active' });
  });

  it('issuer-first makes rotation wait, then removes only the unredeemed old-ID bootstrap', async () => {
    const fx = await fixture();
    const issuance = await seedPasswordIssuanceState(fx);
    const id = requestId();
    const action = { kind: 'remote_desktop.public_id.rotate', hostId: fx.hostId };
    const grant = await mintGrant(fx, action, id);
    const issuerHoldingId = deferred();
    const releaseIssuer = deferred();
    let heldIssuer = false;
    const issueDb = interceptDatabase(db, {
      afterExecute: async (sql) => {
        const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
        if (!heldIssuer && normalized.startsWith('insert into remote_desktop_guest_bootstraps')) {
          heldIssuer = true;
          issuerHoldingId.resolve();
          await releaseIssuer.promise;
        }
      },
    });
    const issue = issueNodePasswordBootstrap(issueDb, {
      hostId: fx.hostId,
      publicNodeId: fx.publicNodeId,
      credentialGeneration: issuance.generation,
      browserPublicKeySpki: PASSWORD_BROWSER_SPKI,
      browserKeyThumbprint: PASSWORD_BROWSER_THUMBPRINT,
      now: NOW + 20,
      fullEndpointEligible: async (serverId) => serverId === issuance.serverId,
    });
    await issuerHoldingId.promise;

    const rotationAtTransactionLock = deferred();
    let rotationSettled = false;
    const rotationDb = interceptDatabase(db, {
      beforeQueryOne: (sql) => {
        const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
        // The uncommitted bootstrap's host FK key-share can make Owner's host
        // lock the first visible wait. After release, rotation also takes the
        // same active-public-ID row lock used by the issuer recheck.
        if (normalized.includes('from remote_desktop_hosts as host')
          && normalized.endsWith('for update of host')) rotationAtTransactionLock.resolve();
      },
    });
    const rotation = rotateOwnerPublicNodeId(rotationDb, {
      accountSession: fx.session,
      hostId: fx.hostId,
      requestId: id,
      stepUpToken: grant,
      now: NOW + 21,
    }).finally(() => { rotationSettled = true; });
    await rotationAtTransactionLock.promise;
    await nextTask();
    expect(rotationSettled).toBe(false);

    releaseIssuer.resolve();
    const [issued, rotated] = await Promise.all([issue, rotation]);
    expect(issued).not.toBeNull();
    expect(rotated.previousPublicNodeId).toBe(fx.publicNodeId);
    expect(await db.queryOne(
      'SELECT ticket_hash FROM remote_desktop_guest_bootstraps WHERE ticket_hash = $1',
      [hashBootstrapTicket(issued!.bootstrapTicket)],
    )).toBeNull();
    expect(await db.queryOne<{ generation: number }>(
      'SELECT generation FROM remote_desktop_unattended_passwords WHERE host_id = $1',
      [fx.hostId],
    )).toEqual({ generation: issuance.generation });
    expect(await db.queryOne<{ state: string }>(
      'SELECT state FROM remote_desktop_guest_sessions WHERE id = $1',
      [issuance.admittedSessionId],
    )).toEqual({ state: 'active' });
  });

  it('rejects a grant minted for another action without rotating', async () => {
    const fx = await fixture();
    const id = requestId();
    const grant = await mintGrant(fx, { kind: 'remote_desktop.link.create', hostId: fx.hostId }, id);
    const attempt = rotateOwnerPublicNodeId(db, {
      accountSession: fx.session,
      hostId: fx.hostId,
      requestId: id,
      stepUpToken: grant,
      now: NOW + 1,
    });
    await expect(attempt).rejects.toBeInstanceOf(OwnerHostManagementError);
    await expect(attempt).rejects.toMatchObject({ code: OWNER_HOST_MANAGEMENT_ERROR.STEP_UP_REQUIRED });
    expect((await getOwnerRemoteDesktopHostSummary(db, {
      accountSession: fx.session,
      hostId: fx.hostId,
    })).publicNodeId).toBe(fx.publicNodeId);
  });
});
