/**
 * Real-machine / PostgreSQL integration test for:
 * 1. Scheduled cron tasks visibility and mutation for shared session participants:
 *    - Participant can view project cron jobs (GET /api/cron)
 *    - Participant can create cron jobs in the covered project (POST /api/cron)
 *    - Participant can edit cron jobs in the covered project (PUT /api/cron/:id)
 *    - Participant can pause/resume cron jobs (PATCH /api/cron/:id/status)
 *    - Participant can delete cron jobs in the covered project (DELETE /api/cron/:id)
 *    - Sub-session share participant can also view and manage project cron jobs
 *    - Viewers have read-only access (403 on mutation)
 *    - Outsiders are forbidden (403)
 * 2. 3-level session identity (user, project, session) for shared session participants:
 *    - Participant can view and edit user scope identity (persisted to owner's account)
 *    - Participant can view and edit project scope identity (relayed to daemon, metadata updated)
 *    - Participant can view and edit session scope identity (relayed to daemon, metadata updated)
 *    - Viewers are denied access (403 share-role-denied)
 *    - Outsiders are forbidden (403)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/index.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createSubSession, createUser, upsertDbSession } from '../src/db/queries.js';
import { createOrUpdateShare } from '../src/db/tab-sharing.js';
import { signJwt } from '../src/security/crypto.js';
import { WsBridge } from '../src/ws/bridge.js';
import { CRON_STATUS } from '../../shared/cron-types.js';
import { SESSION_IDENTITY_SCOPES } from '../../shared/session-identity.js';
import type { Env } from '../src/env.js';

const JWT_KEY = 'test-jwt-key-real-machine-32chars!';
let db: Database;
let app: ReturnType<typeof buildApp>;

const OWNER_ID = 'usr-real-owner-001';
const PARTICIPANT_ID = 'usr-real-part-002';
const VIEWER_ID = 'usr-real-view-003';
const OUTSIDER_ID = 'usr-real-out-004';
const SERVER_ID = 'srv-real-machine-001';
const PROJECT_NAME = 'realdeck';
const MAIN_SESSION = `deck_${PROJECT_NAME}_brain`;
const SUB_SESSION_RAW_ID = 'sub-worker-001';
const SUB_SESSION_NAME = `deck_sub_${SUB_SESSION_RAW_ID}`;

function bearer(userId: string) {
  return `Bearer ${signJwt({ sub: userId, type: 'web' }, JWT_KEY, 3600)}`;
}

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);

  // Seed real users
  await createUser(db, OWNER_ID);
  await createUser(db, PARTICIPANT_ID);
  await createUser(db, VIEWER_ID);
  await createUser(db, OUTSIDER_ID);

  // Seed real server
  await createServer(db, SERVER_ID, OWNER_ID, 'Real Machine Node', 'token-hash-real-001');

  // Seed real main session
  const now = Date.now();
  await upsertDbSession(
    db,
    'sess-main-001',
    SERVER_ID,
    MAIN_SESSION,
    PROJECT_NAME,
    'brain',
    'codex-sdk',
    '/home/k/realdeck',
    'idle',
    'Main Brain Session',
  );

  // Seed real subsession
  await createSubSession(
    db,
    SUB_SESSION_RAW_ID,
    SERVER_ID,
    'codex-sdk',
    null,
    '/home/k/realdeck',
    'Worker SubSession',
    null,
    null,
    MAIN_SESSION,
  );

  // Share main session to participant with role 'participant'
  await createOrUpdateShare(db, {
    id: 'share-main-part',
    target: { kind: 'main', serverId: SERVER_ID, sessionName: MAIN_SESSION },
    targetUserId: PARTICIPANT_ID,
    role: 'participant',
    createdBy: OWNER_ID,
    now,
  });

  // Share main session to viewer with role 'viewer'
  await createOrUpdateShare(db, {
    id: 'share-main-view',
    target: { kind: 'main', serverId: SERVER_ID, sessionName: MAIN_SESSION },
    targetUserId: VIEWER_ID,
    role: 'viewer',
    createdBy: OWNER_ID,
    now,
  });

  // Share subsession to participant with role 'participant'
  await createOrUpdateShare(db, {
    id: 'share-sub-part',
    target: { kind: 'subsession', serverId: SERVER_ID, subSessionId: SUB_SESSION_RAW_ID },
    targetUserId: PARTICIPANT_ID,
    role: 'participant',
    createdBy: OWNER_ID,
    now,
  });

  // Seed an initial cron job for the project owned by OWNER_ID
  await db.execute(
    `INSERT INTO cron_jobs (id, user_id, server_id, name, cron_expr, project_name, target_role, action, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
    [
      'cron-owner-seeded',
      OWNER_ID,
      SERVER_ID,
      'Seeded Project Health Check',
      '0 8 * * *',
      PROJECT_NAME,
      'brain',
      JSON.stringify({ type: 'command', command: '/health-check' }),
      CRON_STATUS.ACTIVE,
      now,
    ],
  );

  // Seed an unrelated cron job belonging to another project
  await db.execute(
    `INSERT INTO cron_jobs (id, user_id, server_id, name, cron_expr, project_name, target_role, action, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
    [
      'cron-other-seeded',
      OWNER_ID,
      SERVER_ID,
      'Unrelated Project Task',
      '0 12 * * *',
      'unrelated_project',
      'brain',
      JSON.stringify({ type: 'command', command: '/other-task' }),
      CRON_STATUS.ACTIVE,
      now,
    ],
  );

  app = buildApp({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    JWT_SIGNING_KEY: JWT_KEY,
    BOT_ENCRYPTION_KEY: 'test-bot-encryption-key-32chars!',
    SERVER_URL: 'http://localhost:19138',
    DB: db,
    NODE_ENV: 'test',
    ALLOWED_ORIGINS: 'http://localhost',
  } as Env);
});

beforeEach(() => {
  // Bridge hooks for daemon-local RPC
  const bridge = WsBridge.get(SERVER_ID);
  vi.spyOn(bridge, 'isDaemonConnected').mockReturnValue(true);
  vi.spyOn(bridge, 'resolveSessionIdentityProjectKey').mockImplementation((_name) => 'canonical-realdeck-key');
  vi.spyOn(bridge, 'sendSessionIdentityLocalRequest').mockImplementation(async (_reqId, payload) => {
    if (payload.op === 'set') {
      return {
        status: 'ok',
        contentHash: 'hash-real-daemon-123',
        revision: 2,
        updatedAt: Date.now(),
      };
    }
    if (payload.op === 'delete') {
      return { status: 'ok' };
    }
    return {
      status: 'ok',
      content: `Daemon stored content for ${payload.scope}`,
      contentHash: 'hash-real-daemon-123',
      revision: 1,
      updatedAt: Date.now(),
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.close();
});

describe('Real-machine test: Shared session participant cron management', () => {
  it('1. lets a shared participant see the corresponding project cron jobs while hiding unrelated projects', async () => {
    const res = await app.request(
      `/api/cron?serverId=${SERVER_ID}&projectName=${PROJECT_NAME}&sessionName=${MAIN_SESSION}`,
      { headers: { Authorization: bearer(PARTICIPANT_ID) } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: Array<{ id: string; name: string; project_name: string }> };
    const jobIds = body.jobs.map((j) => j.id);
    expect(jobIds).toContain('cron-owner-seeded');
    expect(jobIds).not.toContain('cron-other-seeded');
  });

  it('2. lets a sub-session shared participant see the corresponding project cron jobs', async () => {
    const res = await app.request(
      `/api/cron?serverId=${SERVER_ID}&sessionName=${SUB_SESSION_NAME}`,
      { headers: { Authorization: bearer(PARTICIPANT_ID) } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: Array<{ id: string; name: string; project_name: string }> };
    const jobIds = body.jobs.map((j) => j.id);
    expect(jobIds).toContain('cron-owner-seeded');
  });

  it('3. lets a shared participant CREATE a new scheduled cron task in the project', async () => {
    const payload = {
      name: 'Participant Automated Nightly Sync',
      cronExpr: '0 2 * * *',
      serverId: SERVER_ID,
      projectName: PROJECT_NAME,
      targetRole: 'brain',
      action: { type: 'command', command: '/git sync' },
    };

    const res = await app.request(
      `/api/cron?sessionName=${MAIN_SESSION}`,
      {
        method: 'POST',
        headers: {
          Authorization: bearer(PARTICIPANT_ID),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; job: { id: string; name: string } };
    expect(body.id).toBeDefined();

    // Verify row persisted in real PostgreSQL DB under the server owner
    const dbRow = await db.queryOne<{ id: string; user_id: string; name: string; project_name: string }>(
      'SELECT id, user_id, name, project_name FROM cron_jobs WHERE id = $1',
      [body.id],
    );
    expect(dbRow).toBeDefined();
    expect(dbRow?.user_id).toBe(OWNER_ID);
    expect(dbRow?.name).toBe('Participant Automated Nightly Sync');
    expect(dbRow?.project_name).toBe(PROJECT_NAME);
  });

  it('4. lets a shared participant EDIT an existing cron task in the project', async () => {
    const updatePayload = {
      name: 'Participant Updated Health Check',
      cronExpr: '0 9 * * *',
      targetRole: 'brain',
    };

    const res = await app.request(
      `/api/cron/cron-owner-seeded?sessionName=${MAIN_SESSION}`,
      {
        method: 'PUT',
        headers: {
          Authorization: bearer(PARTICIPANT_ID),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updatePayload),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const dbRow = await db.queryOne<{ name: string; cron_expr: string }>(
      'SELECT name, cron_expr FROM cron_jobs WHERE id = $1',
      ['cron-owner-seeded'],
    );
    expect(dbRow?.name).toBe('Participant Updated Health Check');
    expect(dbRow?.cron_expr).toBe('0 9 * * *');
  });

  it('5. lets a shared participant PAUSE and RESUME an existing cron task', async () => {
    // Pause
    const pauseRes = await app.request(
      `/api/cron/cron-owner-seeded/status?sessionName=${MAIN_SESSION}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: bearer(PARTICIPANT_ID),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: CRON_STATUS.PAUSED }),
      },
    );
    expect(pauseRes.status).toBe(200);
    let dbRow = await db.queryOne<{ status: string }>('SELECT status FROM cron_jobs WHERE id = $1', ['cron-owner-seeded']);
    expect(dbRow?.status).toBe(CRON_STATUS.PAUSED);

    // Resume
    const resumeRes = await app.request(
      `/api/cron/cron-owner-seeded/status?sessionName=${MAIN_SESSION}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: bearer(PARTICIPANT_ID),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: CRON_STATUS.ACTIVE }),
      },
    );
    expect(resumeRes.status).toBe(200);
    dbRow = await db.queryOne<{ status: string }>('SELECT status FROM cron_jobs WHERE id = $1', ['cron-owner-seeded']);
    expect(dbRow?.status).toBe(CRON_STATUS.ACTIVE);
  });

  it('6. lets a shared participant DELETE a cron task in the project', async () => {
    // Create a temporary cron to delete
    const tempId = 'cron-to-delete-part';
    await db.execute(
      `INSERT INTO cron_jobs (id, user_id, server_id, name, cron_expr, project_name, target_role, action, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [tempId, OWNER_ID, SERVER_ID, 'Temp Job To Delete', '0 1 * * *', PROJECT_NAME, 'brain', JSON.stringify({ type: 'command', command: '/rm' }), CRON_STATUS.ACTIVE, Date.now()],
    );

    const deleteRes = await app.request(
      `/api/cron/${tempId}?sessionName=${MAIN_SESSION}`,
      {
        method: 'DELETE',
        headers: { Authorization: bearer(PARTICIPANT_ID) },
      },
    );
    expect(deleteRes.status).toBe(200);
    const checkDb = await db.queryOne('SELECT id FROM cron_jobs WHERE id = $1', [tempId]);
    expect(checkDb).toBeNull();
  });

  it('7. restricts shared viewers to read-only (disallowing create, update, status change, delete)', async () => {
    // Viewer CAN read
    const getRes = await app.request(
      `/api/cron?serverId=${SERVER_ID}&projectName=${PROJECT_NAME}&sessionName=${MAIN_SESSION}`,
      { headers: { Authorization: bearer(VIEWER_ID) } },
    );
    expect(getRes.status).toBe(200);

    // Viewer CANNOT create
    const createRes = await app.request(
      `/api/cron?sessionName=${MAIN_SESSION}`,
      {
        method: 'POST',
        headers: { Authorization: bearer(VIEWER_ID), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Viewer Forbidden Job',
          cronExpr: '0 3 * * *',
          serverId: SERVER_ID,
          projectName: PROJECT_NAME,
          targetRole: 'brain',
          action: { type: 'command', command: '/forbidden' },
        }),
      },
    );
    expect(createRes.status).toBe(403);
    expect(await createRes.json()).toEqual({ error: 'forbidden', reason: 'share-role-denied' });

    // Viewer CANNOT update
    const updateRes = await app.request(
      `/api/cron/cron-owner-seeded?sessionName=${MAIN_SESSION}`,
      {
        method: 'PUT',
        headers: { Authorization: bearer(VIEWER_ID), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hacked Name' }),
      },
    );
    expect(updateRes.status).toBe(403);
    expect(await updateRes.json()).toEqual({ error: 'forbidden', reason: 'share-role-denied' });

    // Viewer CANNOT change status
    const statusRes = await app.request(
      `/api/cron/cron-owner-seeded/status?sessionName=${MAIN_SESSION}`,
      {
        method: 'PATCH',
        headers: { Authorization: bearer(VIEWER_ID), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: CRON_STATUS.PAUSED }),
      },
    );
    expect(statusRes.status).toBe(403);
    expect(await statusRes.json()).toEqual({ error: 'forbidden', reason: 'share-role-denied' });

    // Viewer CANNOT delete
    const deleteRes = await app.request(
      `/api/cron/cron-owner-seeded?sessionName=${MAIN_SESSION}`,
      {
        method: 'DELETE',
        headers: { Authorization: bearer(VIEWER_ID) },
      },
    );
    expect(deleteRes.status).toBe(403);
    expect(await deleteRes.json()).toEqual({ error: 'forbidden', reason: 'share-role-denied' });
  });

  it('8. strictly denies outsider users who have no share grant', async () => {
    const res = await app.request(
      `/api/cron?serverId=${SERVER_ID}&projectName=${PROJECT_NAME}&sessionName=${MAIN_SESSION}`,
      { headers: { Authorization: bearer(OUTSIDER_ID) } },
    );
    expect(res.status).toBe(403);
  });
});

describe('Real-machine test: Shared session participant 3-level session identity', () => {
  it('1. USER scope: allows a covered participant to read and update the machine owner user identity', async () => {
    // Participant reads user identity
    const getRes = await app.request(
      `/api/server/${SERVER_ID}/sessions/${MAIN_SESSION}/identity?scope=${SESSION_IDENTITY_SCOPES.USER}`,
      { headers: { Authorization: bearer(PARTICIPANT_ID) } },
    );
    expect(getRes.status).toBe(200);

    // Participant writes user identity
    const putRes = await app.request(
      `/api/server/${SERVER_ID}/sessions/${MAIN_SESSION}/identity`,
      {
        method: 'PUT',
        headers: {
          Authorization: bearer(PARTICIPANT_ID),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          scope: SESSION_IDENTITY_SCOPES.USER,
          content: 'Owner user prompt customized by participant',
        }),
      },
    );
    expect(putRes.status).toBe(200);
    const body = (await putRes.json()) as { profile: { scope: string; content: string } };
    expect(body.profile.scope).toBe(SESSION_IDENTITY_SCOPES.USER);
    expect(body.profile.content).toBe('Owner user prompt customized by participant');

    // Verify row written to PostgreSQL under OWNER_ID
    const dbRow = await db.queryOne<{ user_id: string; content: string }>(
      'SELECT user_id, content FROM session_identity_profiles WHERE user_id = $1 AND scope = $2',
      [OWNER_ID, SESSION_IDENTITY_SCOPES.USER],
    );
    expect(dbRow?.user_id).toBe(OWNER_ID);
    expect(dbRow?.content).toBe('Owner user prompt customized by participant');
  });

  it('2. PROJECT scope: allows a covered participant to read and update project identity via canonical key', async () => {
    // Participant reads project identity
    const getRes = await app.request(
      `/api/server/${SERVER_ID}/sessions/${MAIN_SESSION}/identity?scope=${SESSION_IDENTITY_SCOPES.PROJECT}`,
      { headers: { Authorization: bearer(PARTICIPANT_ID) } },
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { profile: { scope: string; scopeKey: string; content: string } };
    expect(getBody.profile.scope).toBe(SESSION_IDENTITY_SCOPES.PROJECT);
    expect(getBody.profile.scopeKey).toBe('canonical-realdeck-key');
    expect(getBody.profile.content).toBe('Daemon stored content for project');

    // Participant writes project identity
    const putRes = await app.request(
      `/api/server/${SERVER_ID}/sessions/${MAIN_SESSION}/identity`,
      {
        method: 'PUT',
        headers: {
          Authorization: bearer(PARTICIPANT_ID),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          scope: SESSION_IDENTITY_SCOPES.PROJECT,
          content: 'Project prompt customized by participant',
        }),
      },
    );
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { profile: { scope: string; scopeKey: string; content: string } };
    expect(putBody.profile.scope).toBe(SESSION_IDENTITY_SCOPES.PROJECT);
    expect(putBody.profile.scopeKey).toBe('canonical-realdeck-key');
    expect(putBody.profile.content).toBe('Project prompt customized by participant');

    // Verify metadata projected in real DB under OWNER_ID
    const metaRow = await db.queryOne<{ user_id: string; scope: string; scope_key: string }>(
      'SELECT user_id, scope, scope_key FROM session_identity_metadata WHERE user_id = $1 AND scope = $2',
      [OWNER_ID, SESSION_IDENTITY_SCOPES.PROJECT],
    );
    expect(metaRow?.user_id).toBe(OWNER_ID);
    expect(metaRow?.scope_key).toBe('canonical-realdeck-key');
  });

  it('3. SESSION scope: allows a covered participant to read and update session identity pinned to the session', async () => {
    // Participant reads session identity
    const getRes = await app.request(
      `/api/server/${SERVER_ID}/sessions/${MAIN_SESSION}/identity?scope=${SESSION_IDENTITY_SCOPES.SESSION}`,
      { headers: { Authorization: bearer(PARTICIPANT_ID) } },
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { profile: { scope: string; scopeKey: string } };
    expect(getBody.profile.scope).toBe(SESSION_IDENTITY_SCOPES.SESSION);
    expect(getBody.profile.scopeKey).toBe(`${SERVER_ID}:${MAIN_SESSION}`);

    // Participant writes session identity
    const putRes = await app.request(
      `/api/server/${SERVER_ID}/sessions/${MAIN_SESSION}/identity`,
      {
        method: 'PUT',
        headers: {
          Authorization: bearer(PARTICIPANT_ID),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          scope: SESSION_IDENTITY_SCOPES.SESSION,
          content: 'Specific session prompt customized by participant',
        }),
      },
    );
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { profile: { scope: string; scopeKey: string; content: string } };
    expect(putBody.profile.scope).toBe(SESSION_IDENTITY_SCOPES.SESSION);
    expect(putBody.profile.scopeKey).toBe(`${SERVER_ID}:${MAIN_SESSION}`);
    expect(putBody.profile.content).toBe('Specific session prompt customized by participant');

    // Verify metadata projected in real DB
    const metaRow = await db.queryOne<{ user_id: string; scope_key: string }>(
      'SELECT user_id, scope_key FROM session_identity_metadata WHERE user_id = $1 AND scope = $2',
      [OWNER_ID, SESSION_IDENTITY_SCOPES.SESSION],
    );
    expect(metaRow?.user_id).toBe(OWNER_ID);
    expect(metaRow?.scope_key).toBe(`${SERVER_ID}:${MAIN_SESSION}`);
  });

  it('4. restricts shared viewers from accessing or mutating machine owner session identity', async () => {
    // Viewer cannot read machine owner session identity (participants only)
    const getRes = await app.request(
      `/api/server/${SERVER_ID}/sessions/${MAIN_SESSION}/identity?scope=${SESSION_IDENTITY_SCOPES.USER}`,
      { headers: { Authorization: bearer(VIEWER_ID) } },
    );
    expect(getRes.status).toBe(403);
    expect(await getRes.json()).toEqual({ error: 'forbidden', reason: 'share-role-denied' });

    // Viewer CANNOT update
    const putRes = await app.request(
      `/api/server/${SERVER_ID}/sessions/${MAIN_SESSION}/identity`,
      {
        method: 'PUT',
        headers: {
          Authorization: bearer(VIEWER_ID),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          scope: SESSION_IDENTITY_SCOPES.USER,
          content: 'Viewer unauthorized write',
        }),
      },
    );
    expect(putRes.status).toBe(403);
    expect(await putRes.json()).toEqual({ error: 'forbidden', reason: 'share-role-denied' });

    // Viewer CANNOT delete
    const deleteRes = await app.request(
      `/api/server/${SERVER_ID}/sessions/${MAIN_SESSION}/identity?scope=${SESSION_IDENTITY_SCOPES.USER}`,
      {
        method: 'DELETE',
        headers: { Authorization: bearer(VIEWER_ID) },
      },
    );
    expect(deleteRes.status).toBe(403);
    expect(await deleteRes.json()).toEqual({ error: 'forbidden', reason: 'share-role-denied' });
  });

  it('5. strictly denies outsider users on session identity', async () => {
    const getRes = await app.request(
      `/api/server/${SERVER_ID}/sessions/${MAIN_SESSION}/identity?scope=${SESSION_IDENTITY_SCOPES.USER}`,
      { headers: { Authorization: bearer(OUTSIDER_ID) } },
    );
    expect(getRes.status).toBe(403);

    const putRes = await app.request(
      `/api/server/${SERVER_ID}/sessions/${MAIN_SESSION}/identity`,
      {
        method: 'PUT',
        headers: {
          Authorization: bearer(OUTSIDER_ID),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          scope: SESSION_IDENTITY_SCOPES.USER,
          content: 'Outsider write',
        }),
      },
    );
    expect(putRes.status).toBe(403);
  });
});
