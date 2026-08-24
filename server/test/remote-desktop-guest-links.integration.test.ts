/**
 * Owner link authority and post-proof sticky bootstrap — real PostgreSQL.
 *
 * Tasks 4.5, 4.7–4.10 and 5.1–5.4. Step-up grants are minted through the real
 * challenge/finalize path rather than inserted directly, so "the mutation
 * consumed a genuine action-bound grant" is actually being tested and not
 * assumed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomInt,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser, createServer } from '../src/db/queries.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { REMOTE_DESKTOP_CAPABILITY } from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_ACTOR_SOURCE,
  REMOTE_DESKTOP_BROWSER_CLAIM,
  REMOTE_DESKTOP_LINK_KIND,
  REMOTE_DESKTOP_LINK_MUTATION,
  REMOTE_DESKTOP_LINK_TOKEN,
  remoteDesktopBootstrapSignaturePreimage,
  remoteDesktopBrowserClaimSignaturePreimage,
} from '../../shared/remote-desktop-access.js';
import {
  digestStepUpAction,
  finalizeStepUpChallenge,
  loadStepUpChallenge,
  storeStepUpChallenge,
  type AccountSession,
} from '../src/services/remote-desktop-account-auth.js';
import {
  acknowledgeFreshFrame,
  beginPrivacyEnd,
  beginPrivacyEpoch,
} from '../src/services/remote-desktop-management-privacy.js';
import {
  LINK_REFUSAL,
  LinkAuthorityError,
  claimLinkBrowser,
  createGuestLink,
  hashLinkPolicy,
  listOwnerLinks,
  mutateGuestLink,
  openOrResumeLinkSession,
} from '../src/services/remote-desktop-guest-links.js';
import {
  hashLinkToken,
  hashBootstrapTicket,
  issueClaimChallenge,
  redeemBootstrap,
  redeemBootstrapForRoute,
  resolveLinkProof,
  sweepExpiredBootstraps,
} from '../src/services/remote-desktop-guest-bootstrap.js';

let db: Database;
const NOW = 1_700_000_000_000;
const RETAIN = NOW + 3_600_000;
const DAY = 86_400_000;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});
afterAll(async () => { await db.close(); });

interface Fixture {
  ownerUserId: string;
  hostId: string;
  serverId: string;
  session: AccountSession;
  credentialId: string;
  privacy: { epochId: string; revision: number };
}

/** Frozen client-side bearer: 32 CSPRNG bytes, base64url, hashed for the wire. */
function newBearer(): { token: string; tokenHash: string } {
  const raw = randomBytes(REMOTE_DESKTOP_LINK_TOKEN.RAW_BYTES);
  const token = raw.toString('base64url');
  return { token, tokenHash: hashLinkToken(token) };
}

function newRequestId(): string {
  return randomBytes(REMOTE_DESKTOP_LINK_TOKEN.CREATION_REQUEST_ID_BYTES).toString('base64url');
}

async function seedFixture(options: { openPrivacy?: boolean } = {}): Promise<Fixture> {
  const ownerUserId = `u_${randomUUID()}`;
  await createUser(db, ownerUserId);

  const credentialId = `cred_${randomUUID()}`;
  await db.execute(
    `INSERT INTO passkey_credentials (id, user_id, public_key, counter, created_at)
     VALUES ($1, $2, 'pk', 0, $3)`,
    [credentialId, ownerUserId, NOW],
  );

  const hostId = randomUUID();
  await db.execute(
    `INSERT INTO remote_desktop_hosts (id, owner_user_id, merge_state, created_at, updated_at)
     VALUES ($1, $2, 'resolved', $3, $3)`,
    [hostId, ownerUserId, NOW],
  );
  await db.execute(
    `INSERT INTO remote_desktop_public_ids
       (public_id, host_id, status, activated_at)
     VALUES ($1, $2, 'active', $3)`,
    [String(randomInt(5_000_000_000, 10_000_000_000)), hostId, NOW],
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

  const session: AccountSession = { kind: 'web', id: `sess_${randomUUID()}`, userId: ownerUserId };

  // A management-Web epoch on a route-free host shields immediately.
  let privacy = { epochId: '', revision: 0 };
  if (options.openPrivacy !== false) {
    const epochId = randomUUID();
    const started = await beginPrivacyEpoch(db, {
      hostId, epochId, presentationSource: 'management_web',
      initiatingSessionHash: 'hash', executionServerId: serverId,
      daemonGeneration: 1, leaseExpiresAt: NOW + 300_000, deadline: NOW + 60_000, now: NOW,
    });
    privacy = { epochId, revision: started.revision };
  }

  return { ownerUserId, hostId, serverId, session, credentialId, privacy };
}

/** Mint a real action-bound grant through challenge → finalize. */
async function mintGrant(fx: Fixture, action: Record<string, unknown>, requestId: string): Promise<string> {
  const actionDigest = digestStepUpAction(action);
  const { challengeId } = await storeStepUpChallenge(db, {
    accountSession: fx.session,
    canonicalHostId: fx.hostId,
    actionDigest,
    requestId,
    challenge: randomBytes(32).toString('base64url'),
    rpId: 'imcodes.test',
    origin: 'https://imcodes.test',
    deadline: NOW + 120_000,
  }, NOW);
  const challenge = await loadStepUpChallenge(db, challengeId, NOW);
  const counterRow = await db.queryOne<{ counter: number }>(
    'SELECT counter FROM passkey_credentials WHERE id = $1', [fx.credentialId],
  );
  const finalized = await finalizeStepUpChallenge(db, {
    challenge: challenge!,
    completingSession: fx.session,
    credentialId: fx.credentialId,
    expectedCounter: counterRow!.counter,
    newCounter: counterRow!.counter + 1,
    userVerified: true,
  }, NOW);
  return finalized!.grantToken;
}

function createAction(fx: Fixture, requestId: string, tokenHash: string, policyHash: string) {
  return {
    kind: 'remote_desktop.link.create',
    hostId: fx.hostId, creationRequestId: requestId, tokenHash, policyHash,
  };
}

async function createLink(fx: Fixture, overrides: Partial<{
  kind: 'attended' | 'unattended'; mode: 'view' | 'control'; label: string; durationMs: number;
}> = {}) {
  const { token, tokenHash } = newBearer();
  const requestId = newRequestId();
  const kind = overrides.kind ?? REMOTE_DESKTOP_LINK_KIND.ATTENDED;
  const mode = overrides.mode ?? 'control';
  const label = overrides.label ?? 'desk';
  const durationMs = kind === REMOTE_DESKTOP_LINK_KIND.UNATTENDED
    ? (overrides.durationMs ?? DAY) : undefined;
  const policyHash = hashLinkPolicy({ hostId: fx.hostId, kind, mode, durationMs, label });
  const grant = await mintGrant(fx, createAction(fx, requestId, tokenHash, policyHash), requestId);
  const result = await createGuestLink(db, {
    ownerUserId: fx.ownerUserId, accountSession: fx.session, stepUpToken: grant,
    hostId: fx.hostId, creationRequestId: requestId,
    tokenHashVersion: REMOTE_DESKTOP_LINK_TOKEN.HASH_VERSION, tokenHash,
    kind, mode, label, durationMs, privacy: fx.privacy, now: NOW,
  });
  return { ...result, token, tokenHash, requestId, grant, policyHash, kind, mode, label, durationMs };
}

async function mutate(fx: Fixture, linkId: string, mutation: string, extra: Record<string, unknown> = {}) {
  const requestId = newRequestId();
  const action = {
    kind: 'remote_desktop.link.mutate',
    hostId: fx.hostId, linkId, mutation,
    label: (extra.label as string | undefined) ?? null,
    expiresAt: (extra.expiresAt as number | undefined) ?? null,
  };
  const grant = await mintGrant(fx, action, requestId);
  return mutateGuestLink(db, {
    ownerUserId: fx.ownerUserId, accountSession: fx.session, stepUpToken: grant,
    requestId, hostId: fx.hostId, linkId,
    mutation: mutation as never,
    ...extra,
    privacy: fx.privacy, now: NOW, retainUntil: RETAIN,
  });
}

/**
 * Close the seeded epoch so admission reopens. Secret work happens behind the
 * barrier; guest proof only becomes possible once it ends.
 */
async function endPrivacy(fx: Fixture): Promise<void> {
  await beginPrivacyEnd(db, { hostId: fx.hostId, ...fx.privacy, now: NOW + 1 });
  await acknowledgeFreshFrame(db, {
    hostId: fx.hostId, ...fx.privacy, executionServerId: fx.serverId,
    daemonGeneration: 1, freshFrameGeneration: 99,
    acknowledgedRoutes: [], now: NOW + 2,
  });
}

/** Browser key hashes are globally unique, so each test needs its own. */
function newThumbprint(): string { return `tp-${randomUUID()}`; }

interface BrowserProofKey {
  privateKey: KeyObject;
  browserPublicKeySpki: string;
  browserKeyThumbprint: string;
}

function newBrowserProofKey(): BrowserProofKey {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    privateKey: pair.privateKey,
    browserPublicKeySpki: spki.toString('base64url'),
    browserKeyThumbprint: createHash('sha256').update(spki).digest('base64url'),
  };
}

async function proveLink(
  token: string,
  key: BrowserProofKey,
  options: { now?: number; ttlMs?: number } = {},
) {
  const now = options.now ?? NOW;
  const challenge = await issueClaimChallenge(db, { token, now });
  const signature = sign(
    'sha256',
    remoteDesktopBrowserClaimSignaturePreimage(
      Buffer.from(challenge.challengeId, 'base64url'),
      Buffer.from(challenge.challenge, 'base64url'),
      Buffer.from(key.browserKeyThumbprint, 'base64url'),
    ),
    { key: key.privateKey, dsaEncoding: 'ieee-p1363' },
  ).toString('base64url');
  return resolveLinkProof(db, {
    proof: {
      keyAlgorithm: REMOTE_DESKTOP_BROWSER_CLAIM.KEY_ALGORITHM,
      challengeId: challenge.challengeId,
      challenge: challenge.challenge,
      browserPublicKeySpki: key.browserPublicKeySpki,
      browserKeyThumbprint: key.browserKeyThumbprint,
      signature,
    },
    now,
    ttlMs: options.ttlMs,
  });
}

function makeBootstrapProof(ticket: string, key: BrowserProofKey) {
  return {
    ticket,
    browserKeyThumbprint: key.browserKeyThumbprint,
    signature: sign(
      'sha256',
      remoteDesktopBootstrapSignaturePreimage(
        Buffer.from(ticket, 'base64url'),
        Buffer.from(key.browserKeyThumbprint, 'base64url'),
      ),
      { key: key.privateKey, dsaEncoding: 'ieee-p1363' },
    ).toString('base64url'),
  };
}

async function expectRefusal(promise: Promise<unknown>, refusal: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(LinkAuthorityError);
  await promise.catch((err: LinkAuthorityError) => expect(err.refusal).toBe(refusal));
}

describe('Owner link creation (4.5)', () => {
  it('stores hash only and returns non-secret metadata', async () => {
    const fx = await seedFixture();
    const created = await createLink(fx);

    expect(created.link.mode).toBe('control');
    expect(created.link.authorityGeneration).toBe(1);
    // The response carries no bearer and no hash.
    expect(JSON.stringify(created.link)).not.toContain(created.token);
    expect(JSON.stringify(created.link)).not.toContain(created.tokenHash);

    const stored = await db.queryOne<{ token_hash: string }>(
      'SELECT token_hash FROM remote_desktop_guest_links WHERE id = $1', [created.link.id],
    );
    expect(stored?.token_hash).toBe(created.tokenHash);
    expect(stored?.token_hash).not.toBe(created.token);
  });

  it('creates the due row atomically for an unattended link', async () => {
    const fx = await seedFixture();
    const created = await createLink(fx, { kind: REMOTE_DESKTOP_LINK_KIND.UNATTENDED, durationMs: DAY });

    expect(created.link.expiresAt).toBe(NOW + DAY);
    const due = await db.query(
      'SELECT link_id FROM remote_desktop_guest_expiry_due WHERE link_id = $1', [created.link.id],
    );
    expect(due).toHaveLength(1);
  });

  it('replays the identical result for an exact retry after a lost response', async () => {
    const fx = await seedFixture();
    const first = await createLink(fx);

    // The client never saw the first response and retries with the grant it
    // still holds. A request id gets exactly one grant, so re-minting is not a
    // legitimate retry — replaying the same token is.
    const second = await createGuestLink(db, {
      ownerUserId: fx.ownerUserId, accountSession: fx.session, stepUpToken: first.grant,
      hostId: fx.hostId, creationRequestId: first.requestId,
      tokenHashVersion: 'v1', tokenHash: first.tokenHash,
      kind: first.kind, mode: first.mode, label: first.label, privacy: fx.privacy, now: NOW,
    });

    expect(second.link.id).toBe(first.link.id);
    expect(second.replayed).toBe(true);
    const all = await db.query('SELECT id FROM remote_desktop_guest_links WHERE host_id = $1', [fx.hostId]);
    expect(all).toHaveLength(1);
  });

  it('refuses a retry that changes the policy, at the step-up binding', async () => {
    const fx = await seedFixture();
    const first = await createLink(fx);
    // Same grant, changed policy: the grant is bound to the original action
    // digest, so this cannot authorize a different link.
    await expectRefusal(createGuestLink(db, {
      ownerUserId: fx.ownerUserId, accountSession: fx.session, stepUpToken: first.grant,
      hostId: fx.hostId, creationRequestId: first.requestId,
      tokenHashVersion: 'v1', tokenHash: first.tokenHash,
      kind: first.kind, mode: 'view', label: first.label, privacy: fx.privacy, now: NOW,
      // The grant's action digest covers the policy hash, so a changed policy
      // fails the outer step-up fence before the idempotency check is reached.
      // The inner conflict path is covered by the hash-collision case below.
    }), LINK_REFUSAL.STEP_UP_REQUIRED);
  });

  it('conflicts on a forced hash collision under a different request', async () => {
    const fx = await seedFixture();
    const first = await createLink(fx);
    const requestId = newRequestId();
    const policyHash = hashLinkPolicy({
      hostId: fx.hostId, kind: first.kind, mode: first.mode, label: 'other',
    });
    const grant = await mintGrant(fx, createAction(fx, requestId, first.tokenHash, policyHash), requestId);

    // Same hash, different request: this must never alias two authorities.
    await expectRefusal(createGuestLink(db, {
      ownerUserId: fx.ownerUserId, accountSession: fx.session, stepUpToken: grant,
      hostId: fx.hostId, creationRequestId: requestId,
      tokenHashVersion: 'v1', tokenHash: first.tokenHash,
      kind: first.kind, mode: first.mode, label: 'other', privacy: fx.privacy, now: NOW,
    }), LINK_REFUSAL.CONFLICT);
  });

  it('rejects malformed request ids and hashes before touching authority', async () => {
    const fx = await seedFixture();
    const base = {
      ownerUserId: fx.ownerUserId, accountSession: fx.session, stepUpToken: 'irrelevant',
      hostId: fx.hostId, tokenHashVersion: 'v1' as const,
      kind: REMOTE_DESKTOP_LINK_KIND.ATTENDED, mode: 'view' as const, label: 'x',
      privacy: fx.privacy, now: NOW,
    };
    await expectRefusal(createGuestLink(db, {
      ...base, creationRequestId: 'too-short', tokenHash: newBearer().tokenHash,
    }), LINK_REFUSAL.INVALID);
    await expectRefusal(createGuestLink(db, {
      ...base, creationRequestId: newRequestId(), tokenHash: 'NOTHEX',
    }), LINK_REFUSAL.INVALID);
    // Attended must not carry a duration; unattended must.
    await expectRefusal(createGuestLink(db, {
      ...base, creationRequestId: newRequestId(), tokenHash: newBearer().tokenHash, durationMs: DAY,
    }), LINK_REFUSAL.INVALID);
  });

  it('refuses another account acting on this host', async () => {
    const fx = await seedFixture();
    const intruder = await seedFixture();
    const { tokenHash } = newBearer();
    const requestId = newRequestId();
    const policyHash = hashLinkPolicy({
      hostId: fx.hostId, kind: REMOTE_DESKTOP_LINK_KIND.ATTENDED, mode: 'view', label: 'x',
    });
    // The intruder's own grant, aimed at someone else's host.
    const grant = await mintGrant(intruder, {
      kind: 'remote_desktop.link.create', hostId: fx.hostId,
      creationRequestId: requestId, tokenHash, policyHash,
    }, requestId);

    await expectRefusal(createGuestLink(db, {
      ownerUserId: intruder.ownerUserId, accountSession: intruder.session, stepUpToken: grant,
      hostId: fx.hostId, creationRequestId: requestId, tokenHashVersion: 'v1', tokenHash,
      kind: REMOTE_DESKTOP_LINK_KIND.ATTENDED, mode: 'view', label: 'x',
      privacy: fx.privacy, now: NOW,
    }), LINK_REFUSAL.STEP_UP_REQUIRED);
  });

  it('refuses a grant minted for a different action', async () => {
    const fx = await seedFixture();
    const { tokenHash } = newBearer();
    const requestId = newRequestId();
    const wrongGrant = await mintGrant(fx, {
      kind: 'remote_desktop.link.create', hostId: fx.hostId,
      creationRequestId: requestId, tokenHash, policyHash: 'a'.repeat(64),
    }, requestId);

    await expectRefusal(createGuestLink(db, {
      ownerUserId: fx.ownerUserId, accountSession: fx.session, stepUpToken: wrongGrant,
      hostId: fx.hostId, creationRequestId: requestId, tokenHashVersion: 'v1', tokenHash,
      kind: REMOTE_DESKTOP_LINK_KIND.ATTENDED, mode: 'view', label: 'x',
      privacy: fx.privacy, now: NOW,
    }), LINK_REFUSAL.STEP_UP_REQUIRED);
  });
});

describe('privacy prerequisite (4.4 / 4.5)', () => {
  it('refuses creation without a current shielded epoch', async () => {
    const fx = await seedFixture({ openPrivacy: false });
    const { tokenHash } = newBearer();
    const requestId = newRequestId();
    const policyHash = hashLinkPolicy({
      hostId: fx.hostId, kind: REMOTE_DESKTOP_LINK_KIND.ATTENDED, mode: 'view', label: 'x',
    });
    const grant = await mintGrant(fx, createAction(fx, requestId, tokenHash, policyHash), requestId);

    await expectRefusal(createGuestLink(db, {
      ownerUserId: fx.ownerUserId, accountSession: fx.session, stepUpToken: grant,
      hostId: fx.hostId, creationRequestId: requestId, tokenHashVersion: 'v1', tokenHash,
      kind: REMOTE_DESKTOP_LINK_KIND.ATTENDED, mode: 'view', label: 'x',
      privacy: { epochId: randomUUID(), revision: 1 }, now: NOW,
    }), LINK_REFUSAL.PRIVACY_REQUIRED);
  });

  it('refuses a stale epoch revision', async () => {
    const fx = await seedFixture();
    const { tokenHash } = newBearer();
    const requestId = newRequestId();
    const policyHash = hashLinkPolicy({
      hostId: fx.hostId, kind: REMOTE_DESKTOP_LINK_KIND.ATTENDED, mode: 'view', label: 'x',
    });
    const grant = await mintGrant(fx, createAction(fx, requestId, tokenHash, policyHash), requestId);

    await expectRefusal(createGuestLink(db, {
      ownerUserId: fx.ownerUserId, accountSession: fx.session, stepUpToken: grant,
      hostId: fx.hostId, creationRequestId: requestId, tokenHashVersion: 'v1', tokenHash,
      kind: REMOTE_DESKTOP_LINK_KIND.ATTENDED, mode: 'view', label: 'x',
      privacy: { epochId: fx.privacy.epochId, revision: fx.privacy.revision + 1 }, now: NOW,
    }), LINK_REFUSAL.PRIVACY_REQUIRED);
  });

  it('refuses ordinary management Web to open an epoch while a route exists', async () => {
    const fx = await seedFixture({ openPrivacy: false });
    await db.execute(
      `INSERT INTO remote_desktop_host_routes (
         route_id, route_generation, host_id, actor_source, state, reserved_at, activated_at, updated_at)
       VALUES ($1, 1, $2, 'account', 'active', $3, $3, $3)`,
      [`live-${randomUUID()}`, fx.hostId, NOW],
    );

    await expect(beginPrivacyEpoch(db, {
      hostId: fx.hostId, epochId: randomUUID(), presentationSource: 'management_web',
      initiatingSessionHash: 'h', executionServerId: fx.serverId, daemonGeneration: 1,
      leaseExpiresAt: NOW + 300_000, deadline: NOW + 60_000, now: NOW,
    })).rejects.toThrow();
  });
});

describe('Owner list and mutation matrix (4.7 / 4.8)', () => {
  it('lists only the Owner\'s links and never a hash', async () => {
    const fx = await seedFixture();
    const created = await createLink(fx);
    const intruder = await seedFixture();

    const mine = await listOwnerLinks(db, { ownerUserId: fx.ownerUserId, hostId: fx.hostId });
    expect(mine.map((l) => l.id)).toEqual([created.link.id]);
    expect(JSON.stringify(mine)).not.toContain(created.tokenHash);

    await expectRefusal(
      listOwnerLinks(db, { ownerUserId: intruder.ownerUserId, hostId: fx.hostId }),
      LINK_REFUSAL.UNAUTHORIZED,
    );
  });

  it('returns successful connection count, duration and bounded source-IP history for Owner audit', async () => {
    const fx = await seedFixture();
    const created = await createLink(fx);
    await db.execute(
      `INSERT INTO remote_desktop_guest_sessions
         (id, link_id, host_id, browser_key_hash, actor_kind, authority_generation,
          expiry_revision, state, source_ip, connected_at, created_at, updated_at, closed_at)
       VALUES
         ($1,$2,$3,'key-1','attended_link',1,1,'closed',$4::inet,$5,$5,$6,$6),
         ($7,$2,$3,'key-2','attended_link',1,1,'active',$8::inet,$9,$9,$9,NULL)`,
      [randomUUID(), created.link.id, fx.hostId, '203.0.113.42', NOW - 120_000, NOW - 60_000,
        randomUUID(), '2001:db8::42', NOW - 30_000],
    );

    const [audited] = await listOwnerLinks(db, {
      ownerUserId: fx.ownerUserId,
      hostId: fx.hostId,
      now: NOW,
    });
    expect(audited?.connectionAudit).toEqual({
      connectionCount: 2,
      totalDurationMs: 90_000,
      lastConnectedAt: NOW - 30_000,
      recentConnections: [
        {
          ipAddress: '2001:db8::42',
          connectedAt: NOW - 30_000,
          disconnectedAt: null,
          durationMs: 30_000,
        },
        {
          ipAddress: '203.0.113.42',
          connectedAt: NOW - 120_000,
          disconnectedAt: NOW - 60_000,
          durationMs: 60_000,
        },
      ],
    });
    expect(JSON.stringify(audited)).not.toContain('key-1');
  });

  it('advances neither counter on a label edit', async () => {
    const fx = await seedFixture();
    const created = await createLink(fx);
    const result = await mutate(fx, created.link.id, REMOTE_DESKTOP_LINK_MUTATION.SET_LABEL, { label: 'renamed' });

    expect(result.link.label).toBe('renamed');
    expect(result.link.authorityGeneration).toBe(created.link.authorityGeneration);
    expect(result.link.expiryRevision).toBe(created.link.expiryRevision);
    expect(result.effectsEmitted).toBe(0);
  });

  it('advances authorityGeneration on Control-to-View and records zero effects with no route', async () => {
    const fx = await seedFixture();
    const created = await createLink(fx, { mode: 'control' });
    const result = await mutate(fx, created.link.id, REMOTE_DESKTOP_LINK_MUTATION.REDUCE_TO_VIEW);

    expect(result.link.mode).toBe('view');
    expect(result.link.authorityGeneration).toBe(created.link.authorityGeneration + 1);
    expect(result.link.expiryRevision).toBe(created.link.expiryRevision);
    // No live route means no legitimate delivery target. The shared contract has
    // no host-scoped downgrade, so nothing is emitted — and that is recorded
    // explicitly rather than left ambiguous.
    expect(result.effectsEmitted).toBe(0);
    const log = await db.queryOne<{ mutation: string; effects_emitted: number; authority_generation: number }>(
      'SELECT mutation, effects_emitted, authority_generation FROM remote_desktop_link_authority_log WHERE link_id = $1',
      [created.link.id],
    );
    expect(log).toMatchObject({ mutation: 'reduce_to_view', effects_emitted: 0 });
    expect(log?.authority_generation).toBe(created.link.authorityGeneration + 1);
    const effects = await db.query(
      "SELECT id FROM remote_desktop_guest_outbox WHERE host_id = $1 AND effect_type = 'downgrade'", [fx.hostId],
    );
    expect(effects).toHaveLength(0);
  });

  it('emits a route-scoped downgrade when a live route exists', async () => {
    const tp = newThumbprint();
    const fx = await seedFixture();
    const created = await createLink(fx, { mode: 'control' });
    await claimLinkBrowser(db, { linkId: created.link.id, browserKeyThumbprint: tp, now: NOW });
    const session = await openOrResumeLinkSession(db, {
      linkId: created.link.id, hostId: fx.hostId, browserKeyThumbprint: tp, now: NOW,
    });
    const routeId = `route-${randomUUID()}`;
    await db.execute(
      `INSERT INTO remote_desktop_host_routes (
         route_id, route_generation, host_id, actor_source, actor_audit_id,
         execution_server_id, state, guest_session_id, reserved_at, activated_at, updated_at)
       VALUES ($1, 4, $2, 'attended_link', 'audit-1', $3, 'active', $4, $5, $5, $5)`,
      [routeId, fx.hostId, fx.serverId, session.sessionId, NOW],
    );
    await db.execute(
      "UPDATE remote_desktop_guest_sessions SET state = 'active', route_id = $2, route_generation = 4 WHERE id = $1",
      [session.sessionId, routeId],
    );

    const result = await mutate(fx, created.link.id, REMOTE_DESKTOP_LINK_MUTATION.REDUCE_TO_VIEW);
    expect(result.effectsEmitted).toBe(1);

    const effect = await db.queryOne<{ payload: { scope: string; effect: string; routeGeneration: number } }>(
      "SELECT payload FROM remote_desktop_guest_outbox WHERE host_id = $1 AND effect_type = 'downgrade'", [fx.hostId],
    );
    expect(effect?.payload.scope).toBe('route');
    expect(effect?.payload.routeGeneration).toBe(4);
  });

  it('advances only expiryRevision on shortening and replaces the due row', async () => {
    const fx = await seedFixture();
    const created = await createLink(fx, { kind: REMOTE_DESKTOP_LINK_KIND.UNATTENDED, durationMs: DAY });
    const earlier = NOW + DAY / 2;
    const result = await mutate(fx, created.link.id, REMOTE_DESKTOP_LINK_MUTATION.SHORTEN_EXPIRY, { expiresAt: earlier });

    expect(result.link.expiresAt).toBe(earlier);
    expect(result.link.expiryRevision).toBe(created.link.expiryRevision + 1);
    // Authority is untouched: a live route keeps running to the earlier deadline.
    expect(result.link.authorityGeneration).toBe(created.link.authorityGeneration);

    const due = await db.query<{ expiry_revision: number; state: string }>(
      'SELECT expiry_revision, state FROM remote_desktop_guest_expiry_due WHERE link_id = $1 ORDER BY expiry_revision',
      [created.link.id],
    );
    // The superseded row must not remain pending, or expiry fires twice.
    const pending = due.filter((d) => d.state === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].expiry_revision).toBe(created.link.expiryRevision + 1);
  });

  it('rejects extension, View-to-Control and host change', async () => {
    const fx = await seedFixture();
    const unattended = await createLink(fx, { kind: REMOTE_DESKTOP_LINK_KIND.UNATTENDED, durationMs: DAY });
    await expectRefusal(
      mutate(fx, unattended.link.id, REMOTE_DESKTOP_LINK_MUTATION.SHORTEN_EXPIRY, { expiresAt: NOW + DAY * 2 }),
      LINK_REFUSAL.INVALID,
    );

    const viewOnly = await createLink(fx, { mode: 'view' });
    // Already View: there is no widening path back to Control.
    await expectRefusal(
      mutate(fx, viewOnly.link.id, REMOTE_DESKTOP_LINK_MUTATION.REDUCE_TO_VIEW),
      LINK_REFUSAL.INVALID,
    );

    const other = await seedFixture();
    await expectRefusal(
      mutate(other, viewOnly.link.id, REMOTE_DESKTOP_LINK_MUTATION.SET_LABEL, { label: 'x' }),
      LINK_REFUSAL.NOT_FOUND,
    );
  });

  it('revokes with a terminal effect and closes live sessions', async () => {
    const tp = newThumbprint();
    const fx = await seedFixture();
    const created = await createLink(fx);
    await claimLinkBrowser(db, { linkId: created.link.id, browserKeyThumbprint: tp, now: NOW });
    const session = await openOrResumeLinkSession(db, {
      linkId: created.link.id, hostId: fx.hostId, browserKeyThumbprint: tp, now: NOW,
    });

    const result = await mutate(fx, created.link.id, REMOTE_DESKTOP_LINK_MUTATION.REVOKE);
    expect(result.link.state).toBe('revoked');
    expect(result.effectsEmitted).toBe(1);

    const closed = await db.queryOne<{ state: string }>(
      'SELECT state FROM remote_desktop_guest_sessions WHERE id = $1', [session.sessionId],
    );
    expect(closed?.state).toBe('closed');
    const terminal = await db.queryOne<{ payload: { scope: string } }>(
      "SELECT payload FROM remote_desktop_guest_outbox WHERE host_id = $1 AND effect_type = 'terminal'", [fx.hostId],
    );
    // No route existed, so host scope carries the ordered terminal fact.
    expect(terminal?.payload.scope).toBe('host');
  });

  it('isolates revoke to one link', async () => {
    const fx = await seedFixture();
    const a = await createLink(fx, { label: 'a' });
    const b = await createLink(fx, { label: 'b' });
    await mutate(fx, a.link.id, REMOTE_DESKTOP_LINK_MUTATION.REVOKE);

    const links = await listOwnerLinks(db, { ownerUserId: fx.ownerUserId, hostId: fx.hostId });
    expect(links.find((l) => l.id === a.link.id)?.state).toBe('revoked');
    expect(links.find((l) => l.id === b.link.id)?.state).toBe('active');
  });

  it('refuses a replayed grant for a second distinct mutation', async () => {
    const fx = await seedFixture();
    const created = await createLink(fx);
    const requestId = newRequestId();
    const action = {
      kind: 'remote_desktop.link.mutate', hostId: fx.hostId, linkId: created.link.id,
      mutation: REMOTE_DESKTOP_LINK_MUTATION.SET_LABEL, label: 'first', expiresAt: null,
    };
    const grant = await mintGrant(fx, action, requestId);
    await mutateGuestLink(db, {
      ownerUserId: fx.ownerUserId, accountSession: fx.session, stepUpToken: grant, requestId,
      hostId: fx.hostId, linkId: created.link.id,
      mutation: REMOTE_DESKTOP_LINK_MUTATION.SET_LABEL, label: 'first',
      privacy: fx.privacy, now: NOW, retainUntil: RETAIN,
    });

    // Same grant, different action: must not authorize the second change.
    await expectRefusal(mutateGuestLink(db, {
      ownerUserId: fx.ownerUserId, accountSession: fx.session, stepUpToken: grant, requestId,
      hostId: fx.hostId, linkId: created.link.id,
      mutation: REMOTE_DESKTOP_LINK_MUTATION.SET_LABEL, label: 'second',
      privacy: fx.privacy, now: NOW, retainUntil: RETAIN,
    }), LINK_REFUSAL.STEP_UP_REQUIRED);

    const links = await listOwnerLinks(db, { ownerUserId: fx.ownerUserId, hostId: fx.hostId });
    expect(links[0].label).toBe('first');
  });
});

describe('browser claim and session binding (4.9 / 4.10)', () => {
  it('gives the link to the first browser and refuses a competitor generically', async () => {
    const tp = newThumbprint();
    const fx = await seedFixture();
    const created = await createLink(fx);

    expect(await claimLinkBrowser(db, { linkId: created.link.id, browserKeyThumbprint: `${tp}-a`, now: NOW }))
      .toEqual({ claimed: true });
    // The competitor gets the same refusal an unknown link produces.
    await expectRefusal(
      claimLinkBrowser(db, { linkId: created.link.id, browserKeyThumbprint: `${tp}-b`, now: NOW + 1 }),
      LINK_REFUSAL.NOT_FOUND,
    );
    // The original browser re-proving is not a second claim.
    expect(await claimLinkBrowser(db, { linkId: created.link.id, browserKeyThumbprint: `${tp}-a`, now: NOW + 2 }))
      .toEqual({ claimed: false });
  });

  it('resolves a concurrent first claim to exactly one owner', async () => {
    const tp = newThumbprint();
    const fx = await seedFixture();
    const created = await createLink(fx);
    const results = await Promise.allSettled([
      claimLinkBrowser(db, { linkId: created.link.id, browserKeyThumbprint: `${tp}-a`, now: NOW }),
      claimLinkBrowser(db, { linkId: created.link.id, browserKeyThumbprint: `${tp}-b`, now: NOW }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled' && r.value.claimed);
    expect(won).toHaveLength(1);
  });

  it('refuses a lost-key browser without disclosing the claim', async () => {
    const tp = newThumbprint();
    const fx = await seedFixture();
    const created = await createLink(fx);
    await claimLinkBrowser(db, { linkId: created.link.id, browserKeyThumbprint: `${tp}-orig`, now: NOW });

    // The user cleared storage and generated a new key.
    await expectRefusal(openOrResumeLinkSession(db, {
      linkId: created.link.id, hostId: fx.hostId, browserKeyThumbprint: `${tp}-new`, now: NOW + 1,
    }), LINK_REFUSAL.NOT_FOUND);
  });

  it('resumes the exact session rather than opening a duplicate', async () => {
    const tp = newThumbprint();
    const fx = await seedFixture();
    const created = await createLink(fx);
    await claimLinkBrowser(db, { linkId: created.link.id, browserKeyThumbprint: tp, now: NOW });

    const first = await openOrResumeLinkSession(db, {
      linkId: created.link.id, hostId: fx.hostId, browserKeyThumbprint: tp, now: NOW,
    });
    const second = await openOrResumeLinkSession(db, {
      linkId: created.link.id, hostId: fx.hostId, browserKeyThumbprint: tp, now: NOW + 5,
    });

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.resumed).toBe(true);
    const live = await db.query(
      "SELECT id FROM remote_desktop_guest_sessions WHERE link_id = $1 AND state IN ('admitting','active')",
      [created.link.id],
    );
    expect(live).toHaveLength(1);
  });
});

describe('public proof and sticky bootstrap (5.1–5.4)', () => {
  it('returns one identical unavailable body for every pre-proof failure', async () => {
    const key = newBrowserProofKey();
    const fx = await seedFixture();
    const created = await createLink(fx);
    await mutate(fx, created.link.id, REMOTE_DESKTOP_LINK_MUTATION.REVOKE);

    const outcomes = await Promise.all([
      proveLink('not-canonical', key),
      proveLink(newBearer().token, key),
      proveLink(created.token, key),
    ]);

    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      // Byte-identical: unknown, malformed and revoked are indistinguishable.
      expect(JSON.stringify(outcome)).toBe(JSON.stringify(outcomes[0]));
      expect(JSON.stringify(outcome)).not.toContain(fx.serverId);
      expect(JSON.stringify(outcome)).not.toContain(fx.hostId);
    }
  });

  it('discloses serverId and a bootstrap only after successful proof', async () => {
    const key = newBrowserProofKey();
    const fx = await seedFixture();
    const created = await createLink(fx);

    await endPrivacy(fx);
    const proof = await proveLink(created.token, key);
    expect(proof.ok).toBe(true);
    if (!proof.ok) return;
    expect(proof.serverId).toBe(fx.serverId);
    expect(proof.bootstrapTicket).toHaveLength(43);

    // Stored hash-only.
    const stored = await db.queryOne<{ ticket_hash: string }>(
      'SELECT ticket_hash FROM remote_desktop_guest_bootstraps WHERE host_id = $1', [fx.hostId],
    );
    expect(stored?.ticket_hash).not.toBe(proof.bootstrapTicket);
  });

  it('redeems once on the owning pod and refuses replay', async () => {
    const key = newBrowserProofKey();
    const fx = await seedFixture();
    const created = await createLink(fx);
    await endPrivacy(fx);
    const proof = await proveLink(created.token, key);
    if (!proof.ok) throw new Error('proof failed');

    const redeemed = await redeemBootstrap(db, {
      proof: makeBootstrapProof(proof.bootstrapTicket, key),
      redeemingServerId: fx.serverId,
      now: NOW + 10,
    });
    expect(redeemed?.hostId).toBe(fx.hostId);

    expect(await redeemBootstrap(db, {
      proof: makeBootstrapProof(proof.bootstrapTicket, key),
      redeemingServerId: fx.serverId,
      now: NOW + 11,
    })).toBeNull();
  });

  it('atomically binds redemption to one durable session and privacy-registry route', async () => {
    const key = newBrowserProofKey();
    const fx = await seedFixture();
    const created = await createLink(fx);
    await endPrivacy(fx);
    const proof = await proveLink(created.token, key);
    if (!proof.ok) throw new Error('proof failed');

    const admitted = await redeemBootstrapForRoute({
      db,
      proof: makeBootstrapProof(proof.bootstrapTicket, key),
      redeemingServerId: fx.serverId,
      routeGeneration: 17,
      clientIp: '203.0.113.77',
      now: NOW + 10,
    });
    expect(admitted).toMatchObject({
      sessionId: expect.any(String),
      routeGeneration: 17,
      actor: {
        source: REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK,
        hostId: fx.hostId,
      },
    });
    const durable = await db.queryOne<{
      state: string; route_id: string; route_generation: number; actor_source: string;
      guest_session_id: string;
      source_ip: string;
    }>(
      `SELECT s.state, s.route_id, s.route_generation, host(s.source_ip) AS source_ip,
              r.actor_source, r.guest_session_id
         FROM remote_desktop_guest_sessions s
         JOIN remote_desktop_host_routes r
           ON r.guest_session_id = s.id AND r.route_id = s.route_id
        WHERE s.id = $1`,
      [admitted!.sessionId],
    );
    expect(durable).toEqual({
      state: 'admitting',
      route_id: admitted!.sessionId,
      route_generation: 17,
      actor_source: REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK,
      guest_session_id: admitted!.sessionId,
      source_ip: '203.0.113.77',
    });
    const duplicate = await proveLink(created.token, key);
    if (!duplicate.ok) throw new Error('duplicate proof failed');
    expect(await redeemBootstrapForRoute({
      db,
      proof: makeBootstrapProof(duplicate.bootstrapTicket, key),
      redeemingServerId: fx.serverId,
      routeGeneration: 17,
      clientIp: '203.0.113.77',
      now: NOW + 11,
    })).toBeNull();
    expect(await db.queryOne<{ redeemed_at: number | null }>(
      'SELECT redeemed_at FROM remote_desktop_guest_bootstraps WHERE ticket_hash = $1',
      [hashBootstrapTicket(duplicate.bootstrapTicket)],
    )).toEqual({ redeemed_at: null });
    expect(await redeemBootstrapForRoute({
      db,
      proof: makeBootstrapProof(proof.bootstrapTicket, key),
      redeemingServerId: fx.serverId,
      routeGeneration: 17,
      clientIp: '203.0.113.77',
      now: NOW + 11,
    })).toBeNull();
  });

  it('refuses wrong pod, wrong browser, expiry and superseded generation', async () => {
    const key = newBrowserProofKey();
    const fx = await seedFixture();
    const created = await createLink(fx, { mode: 'control' });
    await endPrivacy(fx);

    const wrongPod = await proveLink(created.token, key);
    if (!wrongPod.ok) throw new Error('proof failed');
    expect(await redeemBootstrap(db, {
      proof: makeBootstrapProof(wrongPod.bootstrapTicket, key),
      redeemingServerId: 'srv-other-pod',
      now: NOW + 1,
    })).toBeNull();

    const wrongBrowser = await proveLink(created.token, key);
    if (!wrongBrowser.ok) throw new Error('proof failed');
    const otherKey = newBrowserProofKey();
    expect(await redeemBootstrap(db, {
      proof: makeBootstrapProof(wrongBrowser.bootstrapTicket, otherKey),
      redeemingServerId: fx.serverId,
      now: NOW + 1,
    })).toBeNull();

    const expired = await proveLink(created.token, key, { ttlMs: 1_000 });
    if (!expired.ok) throw new Error('proof failed');
    expect(await redeemBootstrap(db, {
      proof: makeBootstrapProof(expired.bootstrapTicket, key),
      redeemingServerId: fx.serverId,
      now: NOW + 5_000,
    })).toBeNull();

    // Issue, then narrow the authority underneath it.
    const stale = await proveLink(created.token, key);
    if (!stale.ok) throw new Error('proof failed');
    // Reopen a fresh epoch: the reduction is a secret-bearing mutation.
    const epochId = randomUUID();
    const reopened = await beginPrivacyEpoch(db, {
      hostId: fx.hostId, epochId, presentationSource: 'management_web',
      initiatingSessionHash: 'h', executionServerId: fx.serverId, daemonGeneration: 1,
      leaseExpiresAt: NOW + 300_000, deadline: NOW + 60_000, now: NOW,
    });
    fx.privacy = { epochId, revision: reopened.revision };
    await mutate(fx, created.link.id, REMOTE_DESKTOP_LINK_MUTATION.REDUCE_TO_VIEW);
    expect(await redeemBootstrap(db, {
      proof: makeBootstrapProof(stale.bootstrapTicket, key),
      redeemingServerId: fx.serverId,
      now: NOW + 1,
    })).toBeNull();
  });

  it('treats a fabricated ticket as unredeemable', async () => {
    const key = newBrowserProofKey();
    const fx = await seedFixture();
    const ticket = randomBytes(32).toString('base64url');
    expect(await redeemBootstrap(db, {
      proof: makeBootstrapProof(ticket, key),
      redeemingServerId: fx.serverId,
      now: NOW,
    })).toBeNull();
  });

  it('refuses proof while the host privacy gate is closed', async () => {
    const key = newBrowserProofKey();
    const fx = await seedFixture();
    const created = await createLink(fx);
    // The epoch opened during seeding is still live, so admission is closed.
    const proof = await proveLink(created.token, key);
    expect(proof.ok).toBe(false);
  });

  it('sweeps expired unredeemed tickets and keeps redeemed ones', async () => {
    const key = newBrowserProofKey();
    const fx = await seedFixture();
    const created = await createLink(fx);
    await endPrivacy(fx);
    const keep = await proveLink(created.token, key);
    if (!keep.ok) throw new Error('proof failed');
    await redeemBootstrap(db, {
      proof: makeBootstrapProof(keep.bootstrapTicket, key),
      redeemingServerId: fx.serverId,
      now: NOW + 1,
    });
    await proveLink(created.token, key, { ttlMs: 1_000 });

    // The sweep is fleet-wide, so assert on this host rather than a global count.
    await sweepExpiredBootstraps(db, { now: NOW + 10_000 });
    const rows = await db.query<{ redeemed_at: number | null }>(
      'SELECT redeemed_at FROM remote_desktop_guest_bootstraps WHERE host_id = $1', [fx.hostId],
    );
    expect(rows).toHaveLength(1);
    // The surviving row is the redeemed one; redeemed tickets are kept for audit.
    expect(rows[0].redeemed_at).not.toBeNull();
  });
});

describe('hash discipline', () => {
  it('uses the frozen domain-separated preimage', async () => {
    const raw = randomBytes(32);
    const token = raw.toString('base64url');
    const expected = createHash('sha256')
      .update(REMOTE_DESKTOP_LINK_TOKEN.HASH_DOMAIN, 'utf8')
      .update(Buffer.from([0]))
      .update(raw)
      .digest('hex');
    expect(hashLinkToken(token)).toBe(expected);
    // A bare digest without domain separation must not match.
    expect(hashLinkToken(token)).not.toBe(createHash('sha256').update(raw).digest('hex'));
  });
});
