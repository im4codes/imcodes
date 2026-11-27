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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/index.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createSubSession, createUser, upsertDbSession } from '../src/db/queries.js';
import { createOrUpdateShare } from '../src/db/tab-sharing.js';
import { signJwt } from '../src/security/crypto.js';
import { WsBridge } from '../src/ws/bridge.js';
import { dispatchJobNow, jobDispatchCron, readCronJobAndProvenanceLocked } from '../src/cron/job-dispatch.js';
import { CRON_STATUS, wrapExternalCliRestrictedCronAction } from '../../shared/cron-types.js';
import { IMCODES_EXTERNAL_CLI_SENDER } from '../../shared/imcodes-send.js';
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

  it('2. restricts a sub-session shared participant to only crons targeting that sub-session', async () => {
    await db.execute(
      `INSERT INTO cron_jobs (id, user_id, server_id, name, cron_expr, project_name, target_role, target_session_name, action, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
       ON CONFLICT (id) DO NOTHING`,
      [
        'cron-sub-seeded',
        OWNER_ID,
        SERVER_ID,
        'Sub-Session Check',
        '0 8 * * *',
        PROJECT_NAME,
        'brain',
        SUB_SESSION_NAME,
        JSON.stringify({ type: 'command', command: '/sub-check' }),
        CRON_STATUS.ACTIVE,
        Date.now(),
      ],
    );
    const res = await app.request(
      `/api/cron?serverId=${SERVER_ID}&sessionName=${SUB_SESSION_NAME}`,
      { headers: { Authorization: bearer(PARTICIPANT_ID) } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: Array<{ id: string; name: string; project_name: string }> };
    const jobIds = body.jobs.map((j) => j.id);
    expect(jobIds).toContain('cron-sub-seeded');
    expect(jobIds).not.toContain('cron-owner-seeded');
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

  it('4. allows participant PUT on in-scope owner cron with last-modifier provenance=shared, and clears shared provenance when owner edits back', async () => {
    const partEditRes = await app.request(
      `/api/cron/cron-owner-seeded?sessionName=${MAIN_SESSION}`,
      {
        method: 'PUT',
        headers: {
          Authorization: bearer(PARTICIPANT_ID),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Participant Updated Owner Job', cronExpr: '0 9 * * *' }),
      },
    );
    expect(partEditRes.status).toBe(200);
    const ownerJobProvAfterPart = await db.queryOne<{ shared: boolean; creator_user_id: string }>(
      'SELECT shared, creator_user_id FROM cron_job_provenance WHERE job_id = $1',
      ['cron-owner-seeded'],
    );
    expect(ownerJobProvAfterPart).toEqual({ shared: true, creator_user_id: PARTICIPANT_ID });

    const ownerReclaimRes = await app.request(
      '/api/cron/cron-owner-seeded',
      {
        method: 'PUT',
        headers: {
          Authorization: bearer(OWNER_ID),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Owner Reclaimed Cron', cronExpr: '0 9 * * *' }),
      },
    );
    expect(ownerReclaimRes.status).toBe(200);
    const ownerJobProvAfterOwner = await db.queryOne<{ shared: boolean; creator_user_id: string }>(
      'SELECT shared, creator_user_id FROM cron_job_provenance WHERE job_id = $1',
      ['cron-owner-seeded'],
    );
    expect(ownerJobProvAfterOwner).toBeNull();

    const sharedJobId = 'cron-shared-seeded';
    const now = Date.now();
    await db.execute(
      `INSERT INTO cron_jobs (id, user_id, server_id, name, cron_expr, project_name, target_role, action, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [sharedJobId, OWNER_ID, SERVER_ID, 'Shared Editable Job', '0 8 * * *', PROJECT_NAME, 'brain', JSON.stringify({ type: 'command', command: '/shared' }), CRON_STATUS.ACTIVE, now],
    );
    await db.execute(
      `INSERT INTO cron_job_provenance (job_id, creator_user_id, server_id, project_name, shared, created_at)
       VALUES ($1, $2, $3, $4, TRUE, $5)`,
      [sharedJobId, PARTICIPANT_ID, SERVER_ID, PROJECT_NAME, now],
    );

    const updatePayload = {
      name: 'Participant Updated Health Check',
      cronExpr: '0 9 * * *',
      targetRole: 'brain',
    };

    const res = await app.request(
      `/api/cron/${sharedJobId}?sessionName=${MAIN_SESSION}`,
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
      [sharedJobId],
    );
    expect(dbRow?.name).toBe('Participant Updated Health Check');
    expect(dbRow?.cron_expr).toBe('0 9 * * *');
    const provRow = await db.queryOne<{ shared: boolean; creator_user_id: string }>(
      'SELECT shared, creator_user_id FROM cron_job_provenance WHERE job_id = $1',
      [sharedJobId],
    );
    expect(provRow).toEqual({ shared: true, creator_user_id: PARTICIPANT_ID });
  });

  it('5. lets a shared participant PAUSE and RESUME an existing shared cron task', async () => {
    // Pause
    const pauseRes = await app.request(
      `/api/cron/cron-shared-seeded/status?sessionName=${MAIN_SESSION}`,
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
    let dbRow = await db.queryOne<{ status: string }>('SELECT status FROM cron_jobs WHERE id = $1', ['cron-shared-seeded']);
    expect(dbRow?.status).toBe(CRON_STATUS.PAUSED);

    // Resume
    const resumeRes = await app.request(
      `/api/cron/cron-shared-seeded/status?sessionName=${MAIN_SESSION}`,
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
    dbRow = await db.queryOne<{ status: string }>('SELECT status FROM cron_jobs WHERE id = $1', ['cron-shared-seeded']);
    expect(dbRow?.status).toBe(CRON_STATUS.ACTIVE);
  });

  it('6. lets a shared participant DELETE a shared cron task in the project', async () => {
    // Create a temporary shared cron to delete
    const tempId = 'cron-to-delete-part';
    const now = Date.now();
    await db.execute(
      `INSERT INTO cron_jobs (id, user_id, server_id, name, cron_expr, project_name, target_role, action, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [tempId, OWNER_ID, SERVER_ID, 'Temp Job To Delete', '0 1 * * *', PROJECT_NAME, 'brain', JSON.stringify({ type: 'command', command: '/rm' }), CRON_STATUS.ACTIVE, now],
    );
    await db.execute(
      `INSERT INTO cron_job_provenance (job_id, creator_user_id, server_id, project_name, shared, created_at)
       VALUES ($1, $2, $3, $4, TRUE, $5)`,
      [tempId, PARTICIPANT_ID, SERVER_ID, PROJECT_NAME, now],
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
  it('1. USER scope: denies a non-owner participant reading or mutating the machine owner user identity', async () => {
    const getRes = await app.request(
      `/api/server/${SERVER_ID}/sessions/${MAIN_SESSION}/identity?scope=${SESSION_IDENTITY_SCOPES.USER}`,
      { headers: { Authorization: bearer(PARTICIPANT_ID) } },
    );
    expect(getRes.status).toBe(403);

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
    expect(putRes.status).toBe(403);

    const dbRow = await db.queryOne<{ user_id: string; content: string }>(
      'SELECT user_id, content FROM session_identity_profiles WHERE user_id = $1 AND scope = $2',
      [OWNER_ID, SESSION_IDENTITY_SCOPES.USER],
    );
    expect(dbRow).toBeNull();
  });

  it('2. PROJECT scope: denies concrete session shares while allowing whole-server participants via canonical key', async () => {
    const deniedGet = await app.request(
      `/api/server/${SERVER_ID}/sessions/${MAIN_SESSION}/identity?scope=${SESSION_IDENTITY_SCOPES.PROJECT}`,
      { headers: { Authorization: bearer(PARTICIPANT_ID) } },
    );
    expect(deniedGet.status).toBe(403);

    const deniedPut = await app.request(
      `/api/server/${SERVER_ID}/sessions/${MAIN_SESSION}/identity`,
      {
        method: 'PUT',
        headers: {
          Authorization: bearer(PARTICIPANT_ID),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          scope: SESSION_IDENTITY_SCOPES.PROJECT,
          content: 'Project prompt customized by concrete session participant',
        }),
      },
    );
    expect(deniedPut.status).toBe(403);

    // Owner still retains full PROJECT identity access via canonical key
    const ownerGet = await app.request(
      `/api/server/${SERVER_ID}/sessions/${MAIN_SESSION}/identity?scope=${SESSION_IDENTITY_SCOPES.PROJECT}`,
      { headers: { Authorization: bearer(OWNER_ID) } },
    );
    expect(ownerGet.status).toBe(200);
    const getBody = (await ownerGet.json()) as { profile: { scope: string; scopeKey: string; content: string } };
    expect(getBody.profile.scope).toBe(SESSION_IDENTITY_SCOPES.PROJECT);
    expect(getBody.profile.scopeKey).toBe('canonical-realdeck-key');
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

describe('Real-machine test: daemon authored-bindings cross-tenant isolation', () => {
  it('excludes cross-tenant document, version, and enrollment bindings for a team-bound daemon', async () => {
    const now = Date.now();
    const daemonToken = 'authored-bindings-daemon-tok';
    const tokenHash = createHash('sha256').update(daemonToken).digest('hex');
    const authoredServerId = 'srv-authored-tenant-a';
    const teamA = 'team-authored-a';
    const teamB = 'team-authored-b';

    await db.execute(
      `INSERT INTO teams (id, name, owner_id, plan, created_at) VALUES ($1, 'Team A', $2, 'free', $3), ($4, 'Team B', $5, 'free', $3)`,
      [teamA, OWNER_ID, now, teamB, PARTICIPANT_ID],
    );
    await createServer(db, authoredServerId, OWNER_ID, 'Authored Daemon Node', tokenHash);
    await db.execute('UPDATE servers SET team_id = $1 WHERE id = $2', [teamA, authoredServerId]);

    await db.execute(
      `INSERT INTO shared_project_enrollments (id, enterprise_id, workspace_id, canonical_repo_id, display_name, scope, status, created_by, created_at, updated_at)
       VALUES ($1, $2, NULL, 'github.com/acme/repo', 'Repo A', 'project_shared', 'active', $3, $4, $4),
              ($5, $6, NULL, 'github.com/acme/repo', 'Repo B', 'project_shared', 'active', $7, $4, $4)`,
      ['enr-a', teamA, OWNER_ID, now, 'enr-b', teamB, PARTICIPANT_ID],
    );

    await db.execute(
      `INSERT INTO shared_context_documents (id, enterprise_id, kind, title, created_by, created_at, updated_at)
       VALUES ('doc-a', $1, 'standard', 'Doc A', $2, $3, $3),
              ('doc-b', $4, 'standard', 'Doc B', $5, $3, $3)`,
      [teamA, OWNER_ID, now, teamB, PARTICIPANT_ID],
    );

    await db.execute(
      `INSERT INTO shared_context_document_versions (id, document_id, version_number, label, content_md, status, created_by, created_at, activated_at)
       VALUES ('ver-a', 'doc-a', 1, 'v1', 'Allowed Tenant A rule', 'active', $1, $2, $2),
              ('ver-b', 'doc-b', 1, 'v1', 'SECRET Tenant B rule', 'active', $3, $2, $2)`,
      [OWNER_ID, now, PARTICIPANT_ID],
    );

    await db.execute(
      `INSERT INTO shared_context_document_bindings (id, enterprise_id, workspace_id, enrollment_id, document_id, version_id, binding_mode, status, created_by, created_at)
       VALUES ('bind-valid-a', $1, NULL, 'enr-a', 'doc-a', 'ver-a', 'required', 'active', $2, $3),
              ('bind-xtenant-doc', $1, NULL, 'enr-a', 'doc-b', 'ver-b', 'required', 'active', $2, $3),
              ('bind-xtenant-enr', $1, NULL, 'enr-b', 'doc-a', 'ver-a', 'required', 'active', $2, $3)`,
      [teamA, OWNER_ID, now],
    );

    const res = await app.request(`/api/server/${authoredServerId}/shared-context/authored-bindings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        namespace: {
          scope: 'project_shared',
          projectId: 'github.com/acme/repo',
          enterpriseId: teamA,
        },
        language: 'typescript',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { bindings: Array<{ bindingId: string; content: string }> };
    expect(body.bindings).toHaveLength(1);
    expect(body.bindings[0]).toMatchObject({
      bindingId: 'bind-valid-a',
      content: 'Allowed Tenant A rule',
    });
  });
});

describe('PostgreSQL READ COMMITTED lock-wait pairing: EvalPlanQual prevention', () => {
  const EPQ_JOB_LOCK = 'cron-epq-lock-001';
  const EPQ_JOB_TRIGGER_REVOKE = 'cron-epq-trigger-revoke-002';
  const EPQ_JOB_TRIGGER_ALLOW = 'cron-epq-trigger-allow-003';
  const EPQ_JOB_SCHED = 'cron-epq-sched-004';
  const EPQ_JOB_RECOVER = 'cron-epq-recover-005';

  afterEach(async () => {
    const ids = [EPQ_JOB_LOCK, EPQ_JOB_TRIGGER_REVOKE, EPQ_JOB_TRIGGER_ALLOW, EPQ_JOB_SCHED, EPQ_JOB_RECOVER];
    await db.execute(`DELETE FROM cron_executions WHERE job_id = ANY($1::text[])`, [ids]);
    await db.execute(`DELETE FROM cron_job_provenance WHERE job_id = ANY($1::text[])`, [ids]);
    await db.execute(`DELETE FROM cron_jobs WHERE id = ANY($1::text[])`, [ids]);
  });

  async function seedCronWithProvenance(opts: {
    id: string;
    name: string;
    action: Record<string, unknown>;
    creatorUserId: string;
    shared: boolean;
    targetRole?: string;
    targetSessionName?: string | null;
    nextRunAt?: number | null;
  }) {
    const now = Date.now();
    await db.execute(
      `INSERT INTO cron_jobs (id, user_id, server_id, name, cron_expr, project_name, target_role, target_session_name, action, status, next_run_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
      [
        opts.id,
        OWNER_ID,
        SERVER_ID,
        opts.name,
        '0 9 * * *',
        PROJECT_NAME,
        opts.targetRole ?? 'brain',
        opts.targetSessionName ?? MAIN_SESSION,
        JSON.stringify(opts.action),
        CRON_STATUS.ACTIVE,
        opts.nextRunAt ?? null,
        now,
      ],
    );
    await db.execute(
      `INSERT INTO cron_job_provenance (job_id, creator_user_id, server_id, project_name, shared, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [opts.id, opts.creatorUserId, SERVER_ID, PROJECT_NAME, opts.shared, now],
    );
  }

  it('readCronJobAndProvenanceLocked waits on writer lock and pairs v2 job with v2 provenance (never v2+v1)', async () => {
    await seedCronWithProvenance({
      id: EPQ_JOB_LOCK,
      name: 'EPQ Lock Pair Check',
      action: { type: 'send', target: MAIN_SESSION, message: 'v1-payload' },
      creatorUserId: OUTSIDER_ID,
      shared: true,
    });

    let writerLocked!: () => void;
    const writerLockedPromise = new Promise<void>((r) => { writerLocked = r; });
    let allowCommit!: () => void;
    const allowCommitPromise = new Promise<void>((r) => { allowCommit = r; });

    const writerTx = db.transaction(async (tx) => {
      await tx.queryOne('SELECT id FROM cron_jobs WHERE id = $1 FOR UPDATE', [EPQ_JOB_LOCK]);
      await tx.execute(
        'UPDATE cron_jobs SET action = $1, updated_at = $2 WHERE id = $3',
        [JSON.stringify({ type: 'send', target: MAIN_SESSION, message: 'v2-payload' }), Date.now(), EPQ_JOB_LOCK],
      );
      await tx.execute(
        'UPDATE cron_job_provenance SET creator_user_id = $1, shared = $2 WHERE job_id = $3',
        [PARTICIPANT_ID, true, EPQ_JOB_LOCK],
      );
      writerLocked();
      await allowCommitPromise;
    });

    await writerLockedPromise;

    let readerResolved = false;
    const readerTx = db.transaction(async (tx) => {
      const res = await readCronJobAndProvenanceLocked(tx, EPQ_JOB_LOCK);
      readerResolved = true;
      return res;
    });

    // Give Connection 2 time to hit Connection 1's row lock under READ COMMITTED
    await new Promise((r) => setTimeout(r, 50));
    expect(readerResolved).toBe(false);

    allowCommit();
    await writerTx;
    const locked = await readerTx;

    expect(locked.job).not.toBeNull();
    expect(JSON.parse(locked.job!.action)).toMatchObject({ type: 'send', message: 'v2-payload' });
    expect(locked.provenance).toEqual({
      ok: true,
      row: { creator_user_id: PARTICIPANT_ID, shared: true },
    });
  });

  it('POST /api/cron/:id/trigger under lock wait rejects when concurrent writer revokes provenance (v2+v2, 0 WS dispatches)', async () => {
    await seedCronWithProvenance({
      id: EPQ_JOB_TRIGGER_REVOKE,
      name: 'EPQ Trigger Revoke',
      action: { type: 'command', command: '/v1-safe' },
      creatorUserId: PARTICIPANT_ID,
      shared: true,
    });

    const bridge = WsBridge.get(SERVER_ID);
    const sendSpy = vi.spyOn(bridge, 'sendToDaemon').mockImplementation(() => true);
    vi.spyOn(bridge, 'hasDaemonCapability').mockReturnValue(true);

    let writerLocked!: () => void;
    const writerLockedPromise = new Promise<void>((r) => { writerLocked = r; });
    let allowCommit!: () => void;
    const allowCommitPromise = new Promise<void>((r) => { allowCommit = r; });

    const writerTx = db.transaction(async (tx) => {
      await tx.queryOne('SELECT id FROM cron_jobs WHERE id = $1 FOR UPDATE', [EPQ_JOB_TRIGGER_REVOKE]);
      await tx.execute(
        'UPDATE cron_jobs SET action = $1, updated_at = $2 WHERE id = $3',
        [JSON.stringify({ type: 'command', command: '/v2-revoked-escalated' }), Date.now(), EPQ_JOB_TRIGGER_REVOKE],
      );
      await tx.execute(
        'UPDATE cron_job_provenance SET creator_user_id = $1, shared = $2 WHERE job_id = $3',
        [OUTSIDER_ID, true, EPQ_JOB_TRIGGER_REVOKE],
      );
      writerLocked();
      await allowCommitPromise;
    });

    await writerLockedPromise;

    let triggerDone = false;
    const triggerPromise = app.request(`/api/cron/${EPQ_JOB_TRIGGER_REVOKE}/trigger`, {
      method: 'POST',
      headers: { Authorization: bearer(OWNER_ID) },
    }).then((res) => {
      triggerDone = true;
      return res;
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(triggerDone).toBe(false);

    allowCommit();
    await writerTx;
    const res = await triggerPromise;

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('share_revoked');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('POST /api/cron/:id/trigger under lock wait dispatches only paired v2 action when provenance becomes authorized', async () => {
    await seedCronWithProvenance({
      id: EPQ_JOB_TRIGGER_ALLOW,
      name: 'EPQ Trigger Allow',
      action: { type: 'send', target: MAIN_SESSION, message: 'v1-untrusted' },
      creatorUserId: OUTSIDER_ID,
      shared: true,
    });

    const bridge = WsBridge.get(SERVER_ID);
    const sendSpy = vi.spyOn(bridge, 'sendToDaemon').mockImplementation(() => true);
    vi.spyOn(bridge, 'hasDaemonCapability').mockReturnValue(true);

    let writerLocked!: () => void;
    const writerLockedPromise = new Promise<void>((r) => { writerLocked = r; });
    let allowCommit!: () => void;
    const allowCommitPromise = new Promise<void>((r) => { allowCommit = r; });

    const writerTx = db.transaction(async (tx) => {
      await tx.queryOne('SELECT id FROM cron_jobs WHERE id = $1 FOR UPDATE', [EPQ_JOB_TRIGGER_ALLOW]);
      await tx.execute(
        'UPDATE cron_jobs SET action = $1, target_role = $2, target_session_name = $3, updated_at = $4 WHERE id = $5',
        [
          JSON.stringify({ type: 'send', target: SUB_SESSION_NAME, message: 'v2-trusted' }),
          'subsession',
          SUB_SESSION_NAME,
          Date.now(),
          EPQ_JOB_TRIGGER_ALLOW,
        ],
      );
      await tx.execute(
        'UPDATE cron_job_provenance SET creator_user_id = $1, shared = $2 WHERE job_id = $3',
        [PARTICIPANT_ID, true, EPQ_JOB_TRIGGER_ALLOW],
      );
      writerLocked();
      await allowCommitPromise;
    });

    await writerLockedPromise;

    let triggerDone = false;
    const triggerPromise = app.request(`/api/cron/${EPQ_JOB_TRIGGER_ALLOW}/trigger`, {
      method: 'POST',
      headers: { Authorization: bearer(PARTICIPANT_ID) },
    }).then((res) => {
      triggerDone = true;
      return res;
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(triggerDone).toBe(false);

    allowCommit();
    await writerTx;
    const res = await triggerPromise;

    expect(res.status).toBe(200);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(sendSpy.mock.calls[0]![0] as string) as {
      action: { type: string; target?: string; message?: string };
      exactTargetSessionName?: string;
    };
    expect(sent.action).toMatchObject({ type: 'send', target: SUB_SESSION_NAME, message: 'v2-trusted' });
    expect(sent.exactTargetSessionName).toBe(SUB_SESSION_NAME);
  });

  it('jobDispatchCron claimDueJobs and recoverPendingDispatches consume only paired (v2, v2) under concurrent writer lock', async () => {
    const past = Date.now() - 10_000;
    await seedCronWithProvenance({
      id: EPQ_JOB_SCHED,
      name: 'EPQ Scheduled Claim',
      action: { type: 'send', target: MAIN_SESSION, message: 'v1-sched-untrusted' },
      creatorUserId: OUTSIDER_ID,
      shared: true,
      nextRunAt: past,
    });
    await seedCronWithProvenance({
      id: EPQ_JOB_RECOVER,
      name: 'EPQ Pending Recovery',
      action: { type: 'send', target: MAIN_SESSION, message: 'v1-recover-untrusted' },
      creatorUserId: OUTSIDER_ID,
      shared: true,
      nextRunAt: Date.now() + 3_600_000,
    });
    await db.execute(
      `INSERT INTO cron_executions (id, job_id, status, detail, created_at) VALUES ($1, $2, $3, $4, $5)`,
      ['exec-epq-recover-005', EPQ_JOB_RECOVER, 'pending_dispatch', null, past],
    );

    const bridge = WsBridge.get(SERVER_ID);
    const sendSpy = vi.spyOn(bridge, 'sendToDaemon').mockImplementation(() => true);
    vi.spyOn(bridge, 'hasDaemonCapability').mockReturnValue(true);

    let writerLocked!: () => void;
    const writerLockedPromise = new Promise<void>((r) => { writerLocked = r; });
    let allowCommit!: () => void;
    const allowCommitPromise = new Promise<void>((r) => { allowCommit = r; });

    const writerTx = db.transaction(async (tx) => {
      await tx.queryOne('SELECT id FROM cron_jobs WHERE id = ANY($1::text[]) FOR UPDATE', [[EPQ_JOB_SCHED, EPQ_JOB_RECOVER]]);
      await tx.execute(
        'UPDATE cron_jobs SET action = $1, target_role = $2, target_session_name = $3, updated_at = $4 WHERE id = $5',
        [
          JSON.stringify({ type: 'send', target: SUB_SESSION_NAME, message: 'v2-sched-trusted' }),
          'subsession',
          SUB_SESSION_NAME,
          Date.now(),
          EPQ_JOB_SCHED,
        ],
      );
      await tx.execute(
        'UPDATE cron_jobs SET action = $1, target_role = $2, target_session_name = $3, updated_at = $4 WHERE id = $5',
        [
          JSON.stringify({ type: 'send', target: SUB_SESSION_NAME, message: 'v2-recover-trusted' }),
          'subsession',
          SUB_SESSION_NAME,
          Date.now(),
          EPQ_JOB_RECOVER,
        ],
      );
      await tx.execute(
        'UPDATE cron_job_provenance SET creator_user_id = $1, shared = $2 WHERE job_id = ANY($3::text[])',
        [PARTICIPANT_ID, true, [EPQ_JOB_SCHED, EPQ_JOB_RECOVER]],
      );
      writerLocked();
      await allowCommitPromise;
    });

    await writerLockedPromise;

    const env = { DB: db } as unknown as Env;
    // While writer holds FOR UPDATE, SKIP LOCKED skips both rows instead of mixing snapshots
    await jobDispatchCron(env);
    expect(sendSpy).not.toHaveBeenCalled();

    allowCommit();
    await writerTx;

    await jobDispatchCron(env);
    const dispatched = sendSpy.mock.calls.map((c) => JSON.parse(c[0] as string) as {
      jobId: string;
      action: { message?: string; target?: string };
      exactTargetSessionName?: string;
    });
    const byJob = new Map(dispatched.map((d) => [d.jobId, d]));
    expect(byJob.get(EPQ_JOB_SCHED)?.action).toMatchObject({ target: SUB_SESSION_NAME, message: 'v2-sched-trusted' });
    expect(byJob.get(EPQ_JOB_SCHED)?.exactTargetSessionName).toBe(SUB_SESSION_NAME);
    expect(byJob.get(EPQ_JOB_RECOVER)?.action).toMatchObject({ target: SUB_SESSION_NAME, message: 'v2-recover-trusted' });
    expect(byJob.get(EPQ_JOB_RECOVER)?.exactTargetSessionName).toBe(SUB_SESSION_NAME);
  });
});

describe('PostgreSQL protection for external-CLI cron provenance (migration 120)', () => {
  const EXT_PROTECTED_JOB = 'cron-ext-pg-protect-001';
  const EXT_MAINT_JOB = 'cron-ext-pg-maint-002';
  const EXT_CASCADE_JOB = 'cron-ext-pg-cascade-003';
  const NORMAL_SHARED_JOB = 'cron-normal-pg-maint-004';

  afterEach(async () => {
    const ids = [EXT_PROTECTED_JOB, EXT_MAINT_JOB, EXT_CASCADE_JOB, NORMAL_SHARED_JOB];
    await db.execute('DELETE FROM cron_executions WHERE job_id = ANY($1::text[])', [ids]);
    // Deleting cron_jobs cascades FK deletion to cron_job_provenance cleanly.
    await db.execute('DELETE FROM cron_jobs WHERE id = ANY($1::text[])', [ids]);
  });

  async function seedJob(opts: {
    id: string;
    name: string;
    action: Record<string, unknown>;
    creatorUserId: string;
    shared: boolean;
    nextRunAt?: number | null;
  }) {
    const now = Date.now();
    await db.execute(
      `INSERT INTO cron_jobs (id, user_id, server_id, name, cron_expr, project_name, target_role, target_session_name, action, status, next_run_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
      [
        opts.id,
        OWNER_ID,
        SERVER_ID,
        opts.name,
        '0 9 * * *',
        PROJECT_NAME,
        'brain',
        MAIN_SESSION,
        JSON.stringify(opts.action),
        CRON_STATUS.ACTIVE,
        opts.nextRunAt ?? null,
        now,
      ],
    );
    await db.execute(
      `INSERT INTO cron_job_provenance (job_id, creator_user_id, server_id, project_name, shared, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [opts.id, opts.creatorUserId, SERVER_ID, PROJECT_NAME, opts.shared, now],
    );
  }

  it('rejects shared=false inserts, blocks legacy base owner/participant PUT mutations while keeping provenance intact, and keeps dispatch restricted', async () => {
    const past = Date.now() - 10_000;
    await seedJob({
      id: EXT_PROTECTED_JOB,
      name: 'Original Restricted Job',
      action: { type: 'send', target: SUB_SESSION_NAME, message: 'ping' },
      creatorUserId: IMCODES_EXTERNAL_CLI_SENDER,
      shared: true,
      nextRunAt: past,
    });

    // Direct DB insert with shared=false for external_cli must be rejected.
    await expect(db.execute(
      `INSERT INTO cron_job_provenance (job_id, creator_user_id, server_id, project_name, shared, created_at)
       VALUES ($1, $2, $3, $4, FALSE, $5)`,
      [EXT_MAINT_JOB, IMCODES_EXTERNAL_CLI_SENDER, SERVER_ID, PROJECT_NAME, Date.now()],
    )).rejects.toThrow(/external_cli_cron_provenance_requires_shared/);

    // Simulate legacy base owner PUT /:id transaction: UPDATE cron_jobs + DELETE FROM cron_job_provenance WHERE job_id = $1.
    await expect(db.transaction(async (tx) => {
      await tx.execute(
        'UPDATE cron_jobs SET name = $1, action = $2, updated_at = $3 WHERE id = $4',
        ['Escalated Owner Rename', JSON.stringify({ type: 'command', command: 'whoami' }), Date.now(), EXT_PROTECTED_JOB],
      );
      await tx.execute('DELETE FROM cron_job_provenance WHERE job_id = $1', [EXT_PROTECTED_JOB]);
    })).rejects.toThrow(/external_cli_cron_provenance_protected/);

    // Simulate legacy base shared-participant PUT /:id overwriting creator_user_id to PARTICIPANT_ID.
    await expect(db.transaction(async (tx) => {
      await tx.execute(
        'UPDATE cron_jobs SET name = $1, updated_at = $2 WHERE id = $3',
        ['Reassigned Creator', Date.now(), EXT_PROTECTED_JOB],
      );
      await tx.execute(
        `INSERT INTO cron_job_provenance (job_id, creator_user_id, server_id, project_name, shared, created_at)
         VALUES ($1, $2, $3, $4, TRUE, $5)
         ON CONFLICT (job_id) DO UPDATE
           SET creator_user_id = EXCLUDED.creator_user_id,
               server_id = EXCLUDED.server_id,
               project_name = EXCLUDED.project_name,
               shared = TRUE`,
        [EXT_PROTECTED_JOB, PARTICIPANT_ID, SERVER_ID, PROJECT_NAME, Date.now()],
      );
    })).rejects.toThrow(/external_cli_cron_provenance_immutable/);

    // Both cron_jobs and cron_job_provenance remain completely intact and rolled back.
    const jobRow = await db.queryOne<{ name: string; action: string }>('SELECT name, action FROM cron_jobs WHERE id = $1', [EXT_PROTECTED_JOB]);
    expect(jobRow?.name).toBe('Original Restricted Job');
    // Pre-migration unwrapped external_cli row is upgraded in-place when migration 120 runs.
    const rawPre120Action = JSON.parse(jobRow!.action) as { type: string; target?: string; message?: string };
    expect(rawPre120Action).toMatchObject({ type: 'send', target: SUB_SESSION_NAME, message: 'ping' });
    const mig120Sql = await readFile(join(import.meta.dirname, '../src/db/migrations/120_protect_external_cli_cron_provenance.sql'), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(mig120Sql);
    });
    const wrappedRow = await db.queryOne<{ action: string }>('SELECT action FROM cron_jobs WHERE id = $1', [EXT_PROTECTED_JOB]);
    expect(JSON.parse(wrappedRow!.action)).toMatchObject({
      type: 'external_cli_restricted',
      version: 1,
      action: { type: 'send', target: SUB_SESSION_NAME, message: 'ping' },
    });
    const provRow = await db.queryOne<{ creator_user_id: string; shared: boolean }>('SELECT creator_user_id, shared FROM cron_job_provenance WHERE job_id = $1', [EXT_PROTECTED_JOB]);
    expect(provRow).toEqual({ creator_user_id: IMCODES_EXTERNAL_CLI_SENDER, shared: true });

    // Dispatch via scheduler unwraps and executes with restricted external_cli sharedActor and no owner authority.
    const bridge = WsBridge.get(SERVER_ID);
    const sendSpy = vi.spyOn(bridge, 'sendToDaemon').mockImplementation(() => true);
    vi.spyOn(bridge, 'hasDaemonCapability').mockReturnValue(true);
    await jobDispatchCron({ DB: db } as unknown as Env);
    const dispatched = sendSpy.mock.calls.map((c) => JSON.parse(c[0] as string) as Record<string, unknown>);
    const extDispatch = dispatched.find((d) => d.jobId === EXT_PROTECTED_JOB);
    expect(extDispatch).toBeDefined();
    expect(extDispatch!.action).toMatchObject({ type: 'send', target: SUB_SESSION_NAME, message: 'ping' });
    expect((extDispatch!.sharedActor as Record<string, unknown>)?.actorUserId).toBe(IMCODES_EXTERNAL_CLI_SENDER);
    expect(extDispatch!.ownerMachineAuthority).toBeUndefined();

    // Legacy base manual-trigger shape (`skipReload: true` missing IMCODES_EXTERNAL_CLI_SENDER provenance)
    // must fail closed with 0 dispatches even if invoked on the persisted wrapped job.
    sendSpy.mockClear();
    const wrappedJobDb = await db.queryOne('SELECT * FROM cron_jobs WHERE id = $1', [EXT_PROTECTED_JOB]);
    await expect(dispatchJobNow({ DB: db } as unknown as Env, wrappedJobDb as never, {
      skipReload: true,
      verifiedProvenance: { ok: true, row: { creator_user_id: PARTICIPANT_ID, shared: true } },
    })).rejects.toThrow('share_revoked');
    await expect(dispatchJobNow({ DB: db } as unknown as Env, wrappedJobDb as never, {
      skipReload: true,
      verifiedProvenance: { ok: true, row: null },
    })).rejects.toThrow('share_revoked');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('allows new-server owner maintenance and whole-job cascade deletion while preserving normal user cron workflows', async () => {
    await seedJob({
      id: EXT_MAINT_JOB,
      name: 'New Server Maint Job',
      action: wrapExternalCliRestrictedCronAction({ type: 'send', target: SUB_SESSION_NAME, message: 'v1' }) as unknown as Record<string, unknown>,
      creatorUserId: IMCODES_EXTERNAL_CLI_SENDER,
      shared: true,
    });
    await seedJob({
      id: EXT_CASCADE_JOB,
      name: 'Cascade Delete Job',
      action: wrapExternalCliRestrictedCronAction({ type: 'send', target: SUB_SESSION_NAME, message: 'bye' }) as unknown as Record<string, unknown>,
      creatorUserId: IMCODES_EXTERNAL_CLI_SENDER,
      shared: true,
    });
    await seedJob({
      id: NORMAL_SHARED_JOB,
      name: 'Normal Shared Job',
      action: { type: 'command', command: '/status' },
      creatorUserId: PARTICIPANT_ID,
      shared: true,
    });

    // Owner on new server may rename / edit allowed send action, while DB action stays wrapped and provenance stays restricted.
    const allowRes = await app.request(`/api/cron/${EXT_MAINT_JOB}`, {
      method: 'PUT',
      headers: { Authorization: bearer(OWNER_ID), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'New Server Renamed Job',
        projectName: PROJECT_NAME,
        action: { type: 'send', target: SUB_SESSION_NAME, message: 'v2' },
      }),
    });
    expect(allowRes.status).toBe(200);
    const maintProv = await db.queryOne<{ creator_user_id: string; shared: boolean }>('SELECT creator_user_id, shared FROM cron_job_provenance WHERE job_id = $1', [EXT_MAINT_JOB]);
    expect(maintProv).toEqual({ creator_user_id: IMCODES_EXTERNAL_CLI_SENDER, shared: true });
    const maintRow = await db.queryOne<{ action: string }>('SELECT action FROM cron_jobs WHERE id = $1', [EXT_MAINT_JOB]);
    expect(JSON.parse(maintRow!.action)).toMatchObject({
      type: 'external_cli_restricted',
      version: 1,
      action: { type: 'send', target: SUB_SESSION_NAME, message: 'v2' },
    });

    // Public list API unwraps the stored action for UI/CLI consumers.
    const listRes = await app.request(`/api/cron?serverId=${SERVER_ID}`, {
      method: 'GET',
      headers: { Authorization: bearer(OWNER_ID) },
    });
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json() as { jobs: Array<{ id: string; action: string }> };
    const listedExt = listJson.jobs.find((j) => j.id === EXT_MAINT_JOB);
    expect(listedExt).toBeDefined();
    expect(JSON.parse(listedExt!.action)).toMatchObject({ type: 'send', target: SUB_SESSION_NAME, message: 'v2' });

    // Current manual trigger endpoint unwraps and dispatches with restricted external_cli sharedActor.
    const bridge = WsBridge.get(SERVER_ID);
    const trigSpy = vi.spyOn(bridge, 'sendToDaemon').mockImplementation(() => true);
    vi.spyOn(bridge, 'hasDaemonCapability').mockReturnValue(true);
    const trigExtRes = await app.request(`/api/cron/${EXT_MAINT_JOB}/trigger`, {
      method: 'POST',
      headers: { Authorization: bearer(OWNER_ID) },
    });
    expect(trigExtRes.status).toBe(200);
    const extManualPayload = JSON.parse(trigSpy.mock.calls.at(-1)![0] as string) as Record<string, unknown>;
    expect(extManualPayload.action).toMatchObject({ type: 'send', target: SUB_SESSION_NAME, message: 'v2' });
    expect((extManualPayload.sharedActor as Record<string, unknown>)?.actorUserId).toBe(IMCODES_EXTERNAL_CLI_SENDER);
    expect(extManualPayload.ownerMachineAuthority).toBeUndefined();

    // Owner on new server cannot escalate the restricted job to raw command / p2p.
    const denyRes = await app.request(`/api/cron/${EXT_MAINT_JOB}`, {
      method: 'PUT',
      headers: { Authorization: bearer(OWNER_ID), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: { type: 'p2p', mode: 'audit', topic: 'bad', participants: ['brain'] } }),
    });
    expect(denyRes.status).toBe(403);

    // Whole-job DELETE /api/cron/:id cascades deletion of cron_jobs + cron_job_provenance cleanly.
    const delRes = await app.request(`/api/cron/${EXT_CASCADE_JOB}`, {
      method: 'DELETE',
      headers: { Authorization: bearer(OWNER_ID) },
    });
    expect(delRes.status).toBe(200);
    expect(await db.queryOne('SELECT id FROM cron_jobs WHERE id = $1', [EXT_CASCADE_JOB])).toBeNull();
    expect(await db.queryOne('SELECT job_id FROM cron_job_provenance WHERE job_id = $1', [EXT_CASCADE_JOB])).toBeNull();

    // Normal participant-created job keeps unwrapped storage and can still be edited, reclaimed, and manually triggered by owner.
    const normalRes = await app.request(`/api/cron/${NORMAL_SHARED_JOB}`, {
      method: 'PUT',
      headers: { Authorization: bearer(OWNER_ID), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Owner Reclaimed Normal Job',
        action: { type: 'command', command: '/owner-raw' },
      }),
    });
    expect(normalRes.status).toBe(200);
    const normalRow = await db.queryOne<{ action: string }>('SELECT action FROM cron_jobs WHERE id = $1', [NORMAL_SHARED_JOB]);
    expect(JSON.parse(normalRow!.action)).toMatchObject({ type: 'command', command: '/owner-raw' });
    expect(await db.queryOne('SELECT job_id FROM cron_job_provenance WHERE job_id = $1', [NORMAL_SHARED_JOB])).toBeNull();
    const trigNormalRes = await app.request(`/api/cron/${NORMAL_SHARED_JOB}/trigger`, {
      method: 'POST',
      headers: { Authorization: bearer(OWNER_ID) },
    });
    expect(trigNormalRes.status).toBe(200);
    const normalManualPayload = JSON.parse(trigSpy.mock.calls.at(-1)![0] as string) as Record<string, unknown>;
    expect(normalManualPayload.action).toMatchObject({ type: 'command', command: '/owner-raw' });
    expect(normalManualPayload.sharedActor).toBeUndefined();
    expect(typeof normalManualPayload.ownerMachineAuthority).toBe('string');
  });
});
