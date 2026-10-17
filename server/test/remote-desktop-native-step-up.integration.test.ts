import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/queries.js';
import {
  REMOTE_DESKTOP_NATIVE_CLIENT,
  claimVerifiedNativeStepUpGrant,
  digestStepUpAction,
  finalizeStepUpChallenge,
  loadStepUpChallenge,
  storeStepUpChallenge,
  verifyNativeStepUpChallenge,
  type AccountSession,
} from '../src/services/remote-desktop-account-auth.js';

const NOW = 1_700_000_000_000;
let db: Database;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  await db.close();
});

async function fixture() {
  const userId = `u_${randomUUID()}`;
  await createUser(db, userId);
  const nativeSession: AccountSession = {
    kind: 'native',
    id: randomBytes(32).toString('base64url'),
    userId,
  };
  await db.execute(
    `INSERT INTO remote_desktop_native_sessions
       (id, session_hash, user_id, originating_session_id, client_id,
        issuer, audience, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, 'https://imcodes.test', $6, $7, $8)`,
    [
      nativeSession.id,
      createHash('sha256').update(`native:${nativeSession.id}`).digest('hex'),
      userId,
      `web_${randomUUID()}`,
      REMOTE_DESKTOP_NATIVE_CLIENT.clientId,
      REMOTE_DESKTOP_NATIVE_CLIENT.audience,
      NOW + 600_000,
      NOW,
    ],
  );
  const credentialId = `cred_${randomUUID()}`;
  await db.execute(
    `INSERT INTO passkey_credentials
       (id, user_id, public_key, counter, created_at)
     VALUES ($1, $2, 'cHVibGljLWtleQ==', 7, $3)`,
    [credentialId, userId, NOW],
  );
  const action = { kind: 'remote_desktop.host.rotate', hostId: `host_${randomUUID()}` };
  const requestId = randomBytes(32).toString('base64url');
  const stored = await storeStepUpChallenge(db, {
    accountSession: nativeSession,
    canonicalHostId: action.hostId,
    actionDigest: digestStepUpAction(action),
    requestId,
    challenge: randomBytes(32).toString('base64url'),
    rpId: 'imcodes.test',
    origin: 'https://imcodes.test',
    deadline: NOW + 60_000,
  }, NOW);
  const challenge = await loadStepUpChallenge(db, stored.challengeId, NOW);
  if (!challenge) throw new Error('challenge_not_seeded');
  return {
    userId,
    nativeSession,
    browserSession: { kind: 'web', id: `web_${randomUUID()}`, userId } as AccountSession,
    credentialId,
    challenge,
  };
}

describe('native-shell two-stage action-bound step-up', () => {
  it('keeps the raw grant out of the browser and persistence, then lets only the initiating native bearer claim once', async () => {
    const fx = await fixture();
    expect(await verifyNativeStepUpChallenge(db, {
      challenge: fx.challenge,
      completingSession: fx.browserSession,
      credentialId: fx.credentialId,
      expectedCounter: 7,
      newCounter: 8,
      userVerified: true,
    }, NOW + 1)).toEqual({ status: 'verified' });

    const marked = await db.queryOne<{ native_verified_at: number | null }>(
      'SELECT native_verified_at FROM remote_desktop_step_up_challenges WHERE id = $1',
      [fx.challenge.id],
    );
    expect(marked?.native_verified_at).toBe(NOW + 1);

    const wrongSession = { ...fx.nativeSession, id: randomBytes(32).toString('base64url') };
    expect(await claimVerifiedNativeStepUpGrant(db, {
      accountSession: wrongSession,
      challengeId: fx.challenge.id,
    }, NOW + 2)).toBeNull();

    const grant = await claimVerifiedNativeStepUpGrant(db, {
      accountSession: fx.nativeSession,
      challengeId: fx.challenge.id,
    }, NOW + 2);
    expect(grant?.grantToken).toMatch(/^rdsg_[A-Za-z0-9_-]{43}$/);
    expect(await claimVerifiedNativeStepUpGrant(db, {
      accountSession: fx.nativeSession,
      challengeId: fx.challenge.id,
    }, NOW + 3)).toBeNull();

    const persisted = await db.queryOne<{ grant_hash: string }>(
      `SELECT grant_hash FROM remote_desktop_step_up_grants
        WHERE account_session_id = $1 AND request_id = $2`,
      [fx.nativeSession.id, fx.challenge.request_id],
    );
    expect(persisted?.grant_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted?.grant_hash).not.toContain(grant!.grantToken);
  });

  it('does not let the ordinary browser completion path mint a native-session grant', async () => {
    const fx = await fixture();
    expect(await finalizeStepUpChallenge(db, {
      challenge: fx.challenge,
      completingSession: fx.browserSession,
      credentialId: fx.credentialId,
      expectedCounter: 7,
      newCounter: 8,
      userVerified: true,
    }, NOW + 1)).toBeNull();
    expect(await loadStepUpChallenge(db, fx.challenge.id, NOW + 1)).not.toBeNull();
  });

  it('fails closed on duplicate browser verification and preserves one passkey counter advance', async () => {
    const fx = await fixture();
    const input = {
      challenge: fx.challenge,
      completingSession: fx.browserSession,
      credentialId: fx.credentialId,
      expectedCounter: 7,
      newCounter: 8,
      userVerified: true,
    };
    expect(await verifyNativeStepUpChallenge(db, input, NOW + 1)).toEqual({ status: 'verified' });
    expect(await verifyNativeStepUpChallenge(db, input, NOW + 2)).toBeNull();
    const credential = await db.queryOne<{ counter: number }>(
      'SELECT counter FROM passkey_credentials WHERE id = $1',
      [fx.credentialId],
    );
    expect(credential?.counter).toBe(8);
  });
});
