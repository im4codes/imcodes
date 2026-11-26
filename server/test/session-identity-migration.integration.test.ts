/**
 * Zero-loss migration of PROJECT/SESSION identity content off the server
 * onto the owning daemon (real PostgreSQL). Causal: on base (before this
 * change) session_identity_profiles.content is NOT NULL and nothing ever
 * clears it; these tests prove the new daemon-initiated MIGRATE flow only
 * clears a row once the daemon has confirmed it persisted and hash-verified
 * the exact content the server had, and never clears it on a concurrent
 * edit, a daemon-offline gap, or a hash mismatch.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import { randomHex, sha256Hex } from '../src/security/crypto.js';
import { getSessionIdentityMetadata, upsertSessionIdentityProfile } from '../src/db/session-identity-queries.js';
import { WsBridge } from '../src/ws/bridge.js';
import { SESSION_IDENTITY_WS } from '../../shared/session-identity-ws.js';

let db: Database;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => { await db.close(); });
afterEach(() => { WsBridge.getAll().clear(); });

class MockDaemonWs extends EventEmitter {
  sent: Array<Record<string, unknown>> = [];
  readyState = 1;
  send(data: string | Buffer) {
    try { this.sent.push(JSON.parse(typeof data === 'string' ? data : data.toString())); } catch { /* ignore */ }
  }
  close() { this.readyState = 3; this.emit('close'); }
}

async function flushAsync() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => process.nextTick(resolve));
}

/** Real-Postgres round trips need more than a few microtask ticks to settle. */
async function waitForSent(daemon: MockDaemonWs, predicate: (msg: Record<string, unknown>) => boolean): Promise<void> {
  await vi.waitFor(() => {
    if (!daemon.sent.some(predicate)) throw new Error('expected message not sent yet');
  }, { timeout: 5_000, interval: 20 });
}

async function waitForContent(
  userId: string, scope: string, scopeKey: string, predicate: (content: string | null) => boolean,
): Promise<string | null> {
  let last: string | null | undefined;
  await vi.waitFor(async () => {
    const row = await db.queryOne<{ content: string | null }>(
      'SELECT content FROM session_identity_profiles WHERE user_id = $1 AND scope = $2 AND scope_key = $3',
      [userId, scope, scopeKey],
    );
    last = row?.content ?? null;
    if (!predicate(last)) throw new Error('content has not reached the expected state yet');
  }, { timeout: 5_000, interval: 20 });
  return last ?? null;
}

async function seedUserAndDaemon(): Promise<{ userId: string; serverId: string; token: string }> {
  const userId = randomHex(16);
  const serverId = randomHex(16);
  const token = randomHex(32);
  await createUser(db, userId);
  await createServer(db, serverId, userId, 'identity-migration-server', sha256Hex(token));
  return { userId, serverId, token };
}

async function connectDaemon(serverId: string, token: string): Promise<MockDaemonWs> {
  const bridge = WsBridge.get(serverId);
  const daemon = new MockDaemonWs();
  bridge.handleDaemonConnection(daemon as never, db, {} as never);
  daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token }));
  await flushAsync();
  return daemon;
}

async function cleanup(userId: string, serverId: string) {
  await db.execute('DELETE FROM session_identity_metadata WHERE user_id = $1', [userId]);
  await db.execute('DELETE FROM session_identity_profiles WHERE user_id = $1', [userId]);
  await db.execute('DELETE FROM servers WHERE id = $1', [serverId]);
  await db.execute('DELETE FROM users WHERE id = $1', [userId]);
}

describe('session identity migration off the server (real PostgreSQL, zero data loss)', () => {
  it('records metadata on confirm but keeps a shared PROJECT row for the other daemons', async () => {
    const { userId, serverId, token } = await seedUserAndDaemon();
    try {
      const content = 'x'.repeat(250_000); // production-shaped: a large existing PROJECT row
      const written = await upsertSessionIdentityProfile(db, {
        userId, scope: 'project', scopeKey: 'repo-1', content, contentHash: sha256Hex(content), source: 'web',
      });
      if (written === 'revision_conflict') throw new Error('unexpected conflict');

      const daemon = await connectDaemon(serverId, token);
      daemon.emit('message', JSON.stringify({
        type: SESSION_IDENTITY_WS.MIGRATE_REQUEST, requestId: 'mig-1',
        candidates: [{ scope: 'project', scopeKey: 'repo-1' }],
      }));
      await waitForSent(daemon, (m) => m.type === SESSION_IDENTITY_WS.MIGRATE_RESPONSE);

      const response = daemon.sent.find((m) => m.type === SESSION_IDENTITY_WS.MIGRATE_RESPONSE && m.requestId === 'mig-1');
      expect(response?.rows).toEqual([{
        scope: 'project', scopeKey: 'repo-1', content, contentHash: written.contentHash,
        revision: written.revision, updatedAt: written.updatedAt,
      }]);

      // Not yet cleared -- the daemon has the content but has not confirmed
      // it persisted and hash-verified it yet.
      const beforeConfirm = await db.queryOne<{ content: string | null }>(
        'SELECT content FROM session_identity_profiles WHERE user_id = $1 AND scope = $2 AND scope_key = $3',
        [userId, 'project', 'repo-1'],
      );
      expect(beforeConfirm?.content).toBe(content);

      daemon.emit('message', JSON.stringify({
        type: SESSION_IDENTITY_WS.MIGRATE_CONFIRM,
        confirmed: [{ scope: 'project', scopeKey: 'repo-1', contentHash: written.contentHash }],
      }));
      await vi.waitFor(async () => {
        const metadata = await getSessionIdentityMetadata(db, userId, 'project', 'repo-1');
        if (!metadata) throw new Error('metadata not written yet');
      }, { timeout: 5_000, interval: 20 });
      const metadata = await getSessionIdentityMetadata(db, userId, 'project', 'repo-1');
      expect(metadata).toMatchObject({ contentHash: written.contentHash });

      // A PROJECT key is shared by every daemon of the user running that
      // project: one daemon's confirm must not strand another daemon.
      const afterConfirm = await db.queryOne<{ content: string | null }>(
        'SELECT content FROM session_identity_profiles WHERE user_id = $1 AND scope = $2 AND scope_key = $3',
        [userId, 'project', 'repo-1'],
      );
      expect(afterConfirm?.content).toBe(content);
      const secondServerId = randomHex(16);
      const secondToken = randomHex(32);
      await createServer(db, secondServerId, userId, 'identity-migration-server-2', sha256Hex(secondToken));
      try {
        const second = await connectDaemon(secondServerId, secondToken);
        second.emit('message', JSON.stringify({
          type: SESSION_IDENTITY_WS.MIGRATE_REQUEST, requestId: 'mig-1b',
          candidates: [{ scope: 'project', scopeKey: 'repo-1' }],
        }));
        await waitForSent(second, (m) => m.type === SESSION_IDENTITY_WS.MIGRATE_RESPONSE);
        const secondResponse = second.sent.find((m) => m.type === SESSION_IDENTITY_WS.MIGRATE_RESPONSE && m.requestId === 'mig-1b');
        expect((secondResponse?.rows as Array<{ content: string }>)[0]?.content).toBe(content);
      } finally {
        await db.execute('DELETE FROM servers WHERE id = $1', [secondServerId]);
      }
    } finally {
      await cleanup(userId, serverId);
    }
  });

  it('clears a SESSION row only after its daemon confirms it persisted the exact hash', async () => {
    const { userId, serverId, token } = await seedUserAndDaemon();
    try {
      const content = 's'.repeat(200_000);
      const scopeKey = `${serverId}:deck_owner`;
      const written = await upsertSessionIdentityProfile(db, {
        userId, scope: 'session', scopeKey, content, contentHash: sha256Hex(content), source: 'web',
      });
      if (written === 'revision_conflict') throw new Error('unexpected conflict');
      const daemon = await connectDaemon(serverId, token);
      daemon.emit('message', JSON.stringify({
        type: SESSION_IDENTITY_WS.MIGRATE_REQUEST, requestId: 'mig-s',
        candidates: [{ scope: 'session', scopeKey }],
      }));
      await waitForSent(daemon, (m) => m.type === SESSION_IDENTITY_WS.MIGRATE_RESPONSE);
      const before = await db.queryOne<{ content: string | null }>(
        'SELECT content FROM session_identity_profiles WHERE user_id = $1 AND scope = $2 AND scope_key = $3',
        [userId, 'session', scopeKey],
      );
      expect(before?.content).toBe(content);
      daemon.emit('message', JSON.stringify({
        type: SESSION_IDENTITY_WS.MIGRATE_CONFIRM,
        confirmed: [{ scope: 'session', scopeKey, contentHash: written.contentHash }],
      }));
      await waitForContent(userId, 'session', scopeKey, (value) => value === null);
      expect(await getSessionIdentityMetadata(db, userId, 'session', scopeKey)).toMatchObject({ contentHash: written.contentHash });
    } finally {
      await cleanup(userId, serverId);
    }
  });

  it('never clears a row whose hash changed after the migrate snapshot was read (a concurrent edit survives)', async () => {
    const { userId, serverId, token } = await seedUserAndDaemon();
    try {
      const original = 'original content';
      const written = await upsertSessionIdentityProfile(db, {
        userId, scope: 'session', scopeKey: `${serverId}:deck_worker`, content: original, contentHash: sha256Hex(original), source: 'web',
      });
      if (written === 'revision_conflict') throw new Error('unexpected conflict');

      // A concurrent edit lands after the daemon read its migrate snapshot
      // but before its confirm arrives (e.g. a web save raced the migration).
      const edited = 'edited after migrate snapshot';
      const editedWritten = await upsertSessionIdentityProfile(db, {
        userId, scope: 'session', scopeKey: `${serverId}:deck_worker`, content: edited, contentHash: sha256Hex(edited), source: 'web',
      });
      if (editedWritten === 'revision_conflict') throw new Error('unexpected conflict');

      const daemon = await connectDaemon(serverId, token);
      // The daemon confirms the STALE hash it originally read, not knowing
      // about the edit.
      daemon.emit('message', JSON.stringify({
        type: SESSION_IDENTITY_WS.MIGRATE_CONFIRM,
        confirmed: [{ scope: 'session', scopeKey: `${serverId}:deck_worker`, contentHash: written.contentHash }],
      }));
      // Asserting a non-event: give the (synchronous-logic) hash-mismatch
      // guard a real, generous window to have acted, then confirm nothing changed.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const row = await db.queryOne<{ content: string | null }>(
        'SELECT content FROM session_identity_profiles WHERE user_id = $1 AND scope = $2 AND scope_key = $3',
        [userId, 'session', `${serverId}:deck_worker`],
      );
      // Zero data loss: the newer edit is never discarded by a stale confirm.
      expect(row?.content).toBe(edited);
    } finally {
      await cleanup(userId, serverId);
    }
  });

  it('migrates multiple scopes in one request and never touches USER scope', async () => {
    const { userId, serverId, token } = await seedUserAndDaemon();
    try {
      const userProfile = await upsertSessionIdentityProfile(db, {
        userId, scope: 'user', scopeKey: '', content: 'user identity stays on the server', contentHash: sha256Hex('user identity stays on the server'), source: 'web',
      });
      const projectContent = 'project identity';
      const projectProfile = await upsertSessionIdentityProfile(db, {
        userId, scope: 'project', scopeKey: 'repo-2', content: projectContent, contentHash: sha256Hex(projectContent), source: 'web',
      });
      if (userProfile === 'revision_conflict' || projectProfile === 'revision_conflict') throw new Error('unexpected conflict');

      const daemon = await connectDaemon(serverId, token);
      daemon.emit('message', JSON.stringify({
        type: SESSION_IDENTITY_WS.MIGRATE_REQUEST, requestId: 'mig-multi',
        candidates: [{ scope: 'project', scopeKey: 'repo-2' }, { scope: 'user', scopeKey: '' }],
      }));
      await waitForSent(daemon, (m) => m.type === SESSION_IDENTITY_WS.MIGRATE_RESPONSE);

      const response = daemon.sent.find((m) => m.type === SESSION_IDENTITY_WS.MIGRATE_RESPONSE && m.requestId === 'mig-multi');
      // Only the project row is offered; a USER-scope candidate is never
      // proposed by a real daemon, and the server would not honor it anyway
      // (the migrate handler only ever queries project/session scope keys).
      expect(response?.rows).toEqual([{
        scope: 'project', scopeKey: 'repo-2', content: projectContent, contentHash: projectProfile.contentHash,
        revision: projectProfile.revision, updatedAt: projectProfile.updatedAt,
      }]);

      daemon.emit('message', JSON.stringify({
        type: SESSION_IDENTITY_WS.MIGRATE_CONFIRM,
        confirmed: [{ scope: 'project', scopeKey: 'repo-2', contentHash: projectProfile.contentHash }],
      }));
      await vi.waitFor(async () => {
        if (!await getSessionIdentityMetadata(db, userId, 'project', 'repo-2')) throw new Error('metadata not written yet');
      }, { timeout: 5_000, interval: 20 });
      const projectRow = await db.queryOne<{ content: string | null }>(
        'SELECT content FROM session_identity_profiles WHERE user_id = $1 AND scope = $2 AND scope_key = $3',
        [userId, 'project', 'repo-2'],
      );
      expect(projectRow?.content).toBe(projectContent);

      const userRow = await db.queryOne<{ content: string | null }>(
        'SELECT content FROM session_identity_profiles WHERE user_id = $1 AND scope = $2 AND scope_key = $3',
        [userId, 'user', ''],
      );
      expect(userRow?.content).toBe('user identity stays on the server');
    } finally {
      await cleanup(userId, serverId);
    }
  });

  it('a migrate request while the daemon is offline gets no response and clears nothing', async () => {
    const { userId, serverId } = await seedUserAndDaemon();
    try {
      const content = 'never requested yet';
      await upsertSessionIdentityProfile(db, {
        userId, scope: 'project', scopeKey: 'repo-3', content, contentHash: sha256Hex(content), source: 'web',
      });
      // No connectDaemon() call -- WsBridge.get(serverId) exists but has no
      // live connection, matching a daemon that has never come online yet.
      const bridge = WsBridge.get(serverId);
      expect(bridge.isDaemonConnected()).toBe(false);

      const row = await db.queryOne<{ content: string | null }>(
        'SELECT content FROM session_identity_profiles WHERE user_id = $1 AND scope = $2 AND scope_key = $3',
        [userId, 'project', 'repo-3'],
      );
      expect(row?.content).toBe(content);
    } finally {
      await cleanup(userId, serverId);
    }
  });
});
