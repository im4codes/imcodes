/** Bounded identity synchronization against real PostgreSQL. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import { randomHex, sha256Hex } from '../src/security/crypto.js';
import { listSessionIdentityProfiles } from '../src/db/session-identity-queries.js';
import {
  SESSION_IDENTITY_SYNC_MAX_PROFILES,
  SESSION_IDENTITY_SYNC_MAX_BYTES,
} from '../../shared/session-identity.js';
import type { Env } from '../src/env.js';

let db: Database;
const JWT_KEY = 'identity-sync-test-jwt-key-000000000000';

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => { await db.close(); });

function app() {
  return buildApp({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    JWT_SIGNING_KEY: JWT_KEY,
    BOT_ENCRYPTION_KEY: randomHex(32),
    DB: db,
    NODE_ENV: 'test',
    ALLOWED_ORIGINS: 'http://localhost',
  } as Env);
}

describe('session identity synchronization bounds', () => {
  it('bounds a production-shaped snapshot while preserving every key form', async () => {
    const userId = randomHex(16);
    const serverId = randomHex(16);
    const token = randomHex(32);
    await createUser(db, userId);
    await createServer(db, serverId, userId, 'identity-sync-server', sha256Hex(token));
    const now = Date.now();
    await db.execute(
      `INSERT INTO sessions (id, server_id, name, project_name, role, agent_type, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'worker', 'codex-sdk', $5, $6, $6)`,
      [randomHex(8), serverId, 'deck_live', 'repo-live', 'idle', now],
    );
    await db.execute(
      `INSERT INTO sub_sessions (id, server_id, type, created_at, updated_at)
       VALUES ($1, $2, 'codex', $3, $3)`,
      ['deck_sub_1', serverId, now],
    );
    await db.execute(
      `INSERT INTO sessions (id, server_id, name, project_name, role, agent_type, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'worker', 'codex-sdk', 'stopped', $5, $5)`,
      [randomHex(8), serverId, 'deck_stopped', 'repo-stopped', now],
    );
    const profile = (scope: string, scopeKey: string, content: string) => db.execute(
      `INSERT INTO session_identity_profiles
         (user_id, scope, scope_key, content, content_hash, source, revision, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'mcp', 1, $6)`,
      [userId, scope, scopeKey, content, sha256Hex(content), now],
    );
    await profile('user', '', 'global');
    await profile('project', 'github-im4codes/im4codes/imcodes', 'project-id project');
    await profile('project', 'repo-live', 'live project');
    await profile('project', 'repo-stopped', 'stale project');
    await profile('session', `${serverId}:deck_live`, 'live session');
    await profile('session', `${serverId}:deck_sub_1`, 'sub session');
    await profile('session', `${serverId}:deck_stopped`, 'stale session');
    for (let i = 0; i < SESSION_IDENTITY_SYNC_MAX_PROFILES + 40; i += 1) {
      // Sort these after the representative project/main/sub-session keys so
      // the bounded snapshot proves each key form survives the cap.
      const name = `zz_many_${i}`;
      await db.execute(
        `INSERT INTO sessions (id, server_id, name, project_name, role, agent_type, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'worker', 'codex-sdk', 'idle', $5, $5)`,
        [randomHex(8), serverId, name, `repo-many-${i}`, now],
      );
      await profile('session', `${serverId}:${name}`, 'x'.repeat(64));
    }

    const started = Date.now();
    const profiles = await listSessionIdentityProfiles(db, userId, serverId);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(profiles.length).toBeLessThanOrEqual(SESSION_IDENTITY_SYNC_MAX_PROFILES);
    expect(profiles.some((item) => item.scope === 'user' && item.content === 'global')).toBe(true);
    expect(profiles.some((item) => item.scopeKey === 'github-im4codes/im4codes/imcodes')).toBe(true);
    expect(profiles.some((item) => item.scopeKey === 'repo-live')).toBe(true);
    expect(profiles.some((item) => item.scopeKey === `${serverId}:deck_sub_1`)).toBe(true);
    expect(profiles.reduce((bytes, item) => bytes + Buffer.byteLength(item.content), 0))
      .toBeLessThanOrEqual(SESSION_IDENTITY_SYNC_MAX_BYTES);

    const response = await app().request(`/api/session-identities/all?serverId=${serverId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Server-Id': serverId,
      },
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { profiles: unknown[] }).profiles.length)
      .toBeLessThanOrEqual(SESSION_IDENTITY_SYNC_MAX_PROFILES);

    await db.execute('DELETE FROM session_identity_profiles WHERE user_id = $1', [userId]);
    await db.execute('DELETE FROM sub_sessions WHERE server_id = $1', [serverId]);
    await db.execute('DELETE FROM sessions WHERE server_id = $1', [serverId]);
    await db.execute('DELETE FROM servers WHERE id = $1', [serverId]);
    await db.execute('DELETE FROM users WHERE id = $1', [userId]);
  });
});
