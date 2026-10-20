import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { taskPairTitleAuthorityRoutes } from '../src/routes/task-pair-title-authority.js';
import { issueSharedMachineAuthority } from '../src/share/shared-machine-authority.js';
import { sha256Hex } from '../src/security/crypto.js';
import { SHARED_MACHINE_AUTHORITY_TYPE, SHARED_MACHINE_AUTHORITY_HEADER } from '../../shared/shared-machine-authority.js';
import { TASK_PAIR_TITLE_AUTHORITY_PATH } from '../../shared/task-pair-title-access.js';
import { activeUserAnswer } from './helpers/user-status.js';

const KEY = 'pair-title-authority-unit-key-at-least-32-bytes';
const TOKEN = 'pair-title-scoped-daemon-unit-token';
function environment(role: 'participant' | 'viewer' | null = 'participant', nodeRole = 'full', revoked = false): Env {
  const DB = {
    queryOne: async (sql: string) => activeUserAnswer(sql) ?? (sql.includes('FROM servers WHERE id')
      ? { token_hash: sha256Hex(TOKEN), user_id: 'owner', node_role: nodeRole, revoked_at: revoked ? Date.now() : null, owner_status: 'active' }
      : sql.includes('SELECT EXISTS') ? { exists: true }
      : sql.includes('FROM sessions') ? { project_name: 'project-a' } : null),
    query: async (sql: string) => !role || !sql.includes('FROM session_shares') ? [] : [{
      target_kind: 'main', id: 'share-1', server_id: 'source-1', session_name: 'deck_a', sub_session_id: null,
      target_user_id: 'alice', role, created_by: 'owner', created_at: 1, updated_at: 1, expires_at: null, revoked_at: null,
    }],
  } as unknown as Database;
  return { DB, JWT_SIGNING_KEY: KEY } as Env;
}
function authority(overrides: Record<string, unknown> = {}) {
  return issueSharedMachineAuthority({ type: SHARED_MACHINE_AUTHORITY_TYPE, sub: 'alice', sourceServerId: 'source-1',
    sessionName: 'deck_a', projectName: 'project-a', shareTarget: { kind: 'main', serverId: 'source-1', sessionName: 'deck_a' }, actionId: 'action-1', ...overrides } as never, KEY);
}
function request(env: Env, token: string | undefined = authority()) {
  const app = new Hono<{ Bindings: Env }>();
  app.route(TASK_PAIR_TITLE_AUTHORITY_PATH, taskPairTitleAuthorityRoutes);
  return app.request(`${TASK_PAIR_TITLE_AUTHORITY_PATH}?serverId=source-1`, { headers: {
    Authorization: `Bearer ${TOKEN}`, 'X-Server-Id': 'source-1', ...(token ? { [SHARED_MACHINE_AUTHORITY_HEADER]: token } : {}),
  } }, env);
}
describe('title actor REST verifier uses existing signed/live share admission', () => {
  it('returns only the exact current actor binding, not owner/private task data', async () => {
    const response = await request(environment());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ serverId: 'source-1', userId: 'alice', sessionName: 'deck_a', projectName: 'project-a' });
  });
  it.each([
    ['viewer', environment('viewer'), authority()], ['revoked share', environment(null), authority()],
    ['wrong project', environment(), authority({ projectName: 'other' })],
    ['wrong session', environment(), authority({ sessionName: 'other' })],
    ['wrong source', environment(), authority({ sourceServerId: 'other' })],
    ['forged signature', environment(), `${authority()}x`], ['missing turn token', environment(), ''],
    ['controlled node', environment('participant', 'controlled'), authority()],
    ['revoked daemon', environment('participant', 'full', true), authority()],
  ])('denies %s without owner fallback', async (_name, env, token) => expect((await request(env, token)).status).toBeGreaterThanOrEqual(400));
});
