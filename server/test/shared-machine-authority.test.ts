import { activeUserAnswer } from './helpers/user-status.js';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/db/client.js';
import {
  issueOwnerMachineAuthority,
  issueSharedMachineAuthority,
  resolveMachineOperationalUser,
} from '../src/share/shared-machine-authority.js';
import {
  OWNER_MACHINE_AUTHORITY_TYPE,
  SHARED_MACHINE_AUTHORITY_TYPE,
} from '../../shared/shared-machine-authority.js';

const KEY = 'shared-machine-authority-unit-key-at-least-32-bytes';

function fakeDb(role: 'participant' | 'viewer' | null = 'participant'): Database {
  return {
    queryOne: async (sql: string) => activeUserAnswer(sql) ?? (sql.includes('SELECT EXISTS')
      ? { exists: true }
      : sql.includes('FROM sessions')
        ? { project_name: 'project-a' }
        : null),
    query: async (sql: string) => {
      if (!role || !sql.includes('FROM session_shares')) return [];
      return [{
        target_kind: 'main', id: 'share-1', server_id: 'source-1', session_name: 'deck_a',
        sub_session_id: null, target_user_id: 'participant-1', role, created_by: 'owner-1',
        created_at: 1, updated_at: 1, expires_at: null, revoked_at: null,
      }];
    },
  } as unknown as Database;
}

function token(overrides: Record<string, unknown> = {}): string {
  return issueSharedMachineAuthority({
    type: SHARED_MACHINE_AUTHORITY_TYPE,
    sub: 'participant-1',
    sourceServerId: 'source-1',
    sessionName: 'deck_a',
    projectName: 'project-a',
    shareTarget: { kind: 'main', serverId: 'source-1', sessionName: 'deck_a' },
    actionId: 'action-1',
    ...overrides,
  } as never, KEY);
}

describe('shared-session machine authority', () => {
  it('maps a live participant to the authenticated source owner', async () => {
    await expect(resolveMachineOperationalUser(fakeDb(), {
      token: token(), signingKey: KEY, authenticatedSourceServerId: 'source-1',
      sourceOwnerUserId: 'owner-1', now: 10,
    })).resolves.toEqual({ userId: 'owner-1', delegatedActorUserId: 'participant-1', authorityKind: 'participant' });
  });

  it.each([
    ['viewer', fakeDb('viewer'), token()],
    ['revoked', fakeDb(null), token()],
    ['wrong project', fakeDb(), token({ projectName: 'project-b' })],
    ['foreign session', fakeDb(), token({ sessionName: 'deck_b' })],
    ['foreign source', fakeDb(), token({ sourceServerId: 'source-2' })],
    ['forged signature', fakeDb(), `${token()}x`],
  ])('rejects %s with no owner fallback', async (_name, db, authority) => {
    await expect(resolveMachineOperationalUser(db, {
      token: authority, signingKey: KEY, authenticatedSourceServerId: 'source-1',
      sourceOwnerUserId: 'owner-1', now: 10,
    })).resolves.toBeNull();
  });

  it('preserves ordinary owner calls when no delegated token is present', async () => {
    await expect(resolveMachineOperationalUser(fakeDb(), {
      token: undefined, signingKey: KEY, authenticatedSourceServerId: 'source-1',
      sourceOwnerUserId: 'owner-1', now: 10,
    })).resolves.toEqual({ userId: 'owner-1', authorityKind: 'absent' });
  });

  it('resolves verified server-signed owner-turn authority and rejects whole-server-share / foreign / forged claims', async () => {
    const ownerDb = (opts: { wholeServerShare?: boolean; active?: boolean } = {}): Database => ({
      queryOne: async (sql: string) => {
        if (sql.includes('FROM users')) return { status: opts.active === false ? 'disabled' : 'active' };
        if (sql.includes('FROM servers')) return { user_id: 'owner-1' };
        if (sql.includes('FROM sessions')) return { project_name: 'project-a' };
        return null;
      },
      query: async (sql: string) => {
        if (sql.includes('FROM server_shares')) return [{ shared: opts.wholeServerShare === true }];
        return [];
      },
    } as unknown as Database);

    const ownerToken = (overrides: Record<string, unknown> = {}) => issueOwnerMachineAuthority({
      type: OWNER_MACHINE_AUTHORITY_TYPE,
      sub: 'owner-1',
      sourceServerId: 'source-1',
      sessionName: 'deck_a',
      projectName: 'project-a',
      actionId: 'owner-act-1',
      ...overrides,
    } as never, KEY);

    await expect(resolveMachineOperationalUser(ownerDb(), {
      token: ownerToken(), signingKey: KEY, authenticatedSourceServerId: 'source-1',
      sourceOwnerUserId: 'owner-1', now: 10,
    })).resolves.toEqual({ userId: 'owner-1', authorityKind: 'owner' });

    await expect(resolveMachineOperationalUser(ownerDb({ wholeServerShare: true }), {
      token: ownerToken(), signingKey: KEY, authenticatedSourceServerId: 'source-1',
      sourceOwnerUserId: 'owner-1', now: 10,
    })).resolves.toBeNull();

    await expect(resolveMachineOperationalUser(ownerDb({ active: false }), {
      token: ownerToken(), signingKey: KEY, authenticatedSourceServerId: 'source-1',
      sourceOwnerUserId: 'owner-1', now: 10,
    })).resolves.toBeNull();

    for (const badToken of [
      ownerToken({ sub: 'participant-1' }),
      ownerToken({ sourceServerId: 'source-2' }),
      ownerToken({ projectName: 'project-b' }),
      `${ownerToken()}tamper`,
    ]) {
      await expect(resolveMachineOperationalUser(ownerDb(), {
        token: badToken, signingKey: KEY, authenticatedSourceServerId: 'source-1',
        sourceOwnerUserId: 'owner-1', now: 10,
      })).resolves.toBeNull();
    }
  });
});
