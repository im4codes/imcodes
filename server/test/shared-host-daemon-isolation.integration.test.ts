/**
 * Comprehensive PostgreSQL integration test for shared/contributed host isolation & cross-device privilege escalation.
 * Covers Vector A (participant shared-turn escalation), Vector B (contributed/shared daemon token lateral movement),
 * share & team revocation cron auto-pausing, whole-server share mutation blocks, and non-regression for Owner A
 * across private unshared hosts + authorized Participant B scoped actions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildApp } from '../src/index.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser, upsertDbSession } from '../src/db/queries.js';
import { createOrUpdateShare } from '../src/db/tab-sharing.js';
import { issueOwnerMachineAuthority, issueOwnerMachineAuthorityForSession, issueSharedMachineAuthority } from '../src/share/shared-machine-authority.js';
import { generateControlledNodeId } from '../src/services/controlled-node-identity.js';
import { randomHex, signJwt } from '../src/security/crypto.js';
import {
  OWNER_MACHINE_AUTHORITY_TYPE,
  SHARED_MACHINE_AUTHORITY_HEADER,
  SHARED_MACHINE_AUTHORITY_TYPE,
} from '../../shared/shared-machine-authority.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import type { Env } from '../src/env.js';

const JWT_KEY = 'test-jwt-key-shared-host-isolation-32chars!';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

let db: Database;
let app: ReturnType<typeof buildApp>;

const tag = randomHex(4);
const OWNER_A = `usr-a-${tag}`;
const USER_B = `usr-b-${tag}`;
const VIEWER_C = `usr-c-${tag}`;

const M_PRIV1 = `srv-priv1-${tag}`;
const M_PRIV2 = `srv-priv2-${tag}`;
const M_SHARED = `srv-shared-${tag}`;
const M_B = `srv-b-${tag}`;
const M_TEAM = `srv-team-${tag}`;
const M_WHOLE = `srv-whole-${tag}`;

const TOK_PRIV1 = `tok-priv1-${tag}`;
const TOK_SHARED = `tok-shared-${tag}`;
const TOK_TEAM = `tok-team-${tag}`;
const TOK_WHOLE = `tok-whole-${tag}`;
const TOK_B = `tok-b-${tag}`;

const SHARED_PROJ = `projshared${tag}`;
const SHARED_MAIN_SESSION = `deck_${SHARED_PROJ}_brain`;
const PRIV_MAIN_SESSION = `deck_priv${tag}_brain`;
const UNSHARED_ON_SHARED_HOST = `deck_privonshared${tag}_brain`;

const SHARE_ID = `share-${tag}`;
const WHOLE_SHARE_ID = `wshare-${tag}`;
const TEAM_ID = `team-${tag}`;

const OWNER_ALIAS = `owner-alias-${tag}`;
const OWNER_VM_ID = `vm-owner-${tag}`;
const OWNER_PIN_SHARED = `pin-owner-shared-${tag}`;
const OWNER_PIN_PRIV = `pin-owner-priv-${tag}`;
const OWNER_DOC_ID = `cdoc_owner_${tag}`;
const MEM_PROJ_PRIV_ID = `mproj_priv_${tag}`;
const CAP_ID = `cap_owner_${tag}`;
const CAP_VERSION_ID = `capv_owner_${tag}`;

function daemonHeaders(serverId: string, token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'X-Server-Id': serverId,
    ...extra,
  };
}

function userBearer(userId: string): string {
  return `Bearer ${signJwt({ sub: userId, type: 'web' }, JWT_KEY, 3600)}`;
}

function mintParticipantAuthority(params: {
  actorUserId: string;
  serverId: string;
  sessionName: string;
  projectName: string;
  shareTarget?: { kind: 'main'; serverId: string; sessionName: string } | { kind: 'server'; serverId: string };
}): string {
  return issueSharedMachineAuthority({
    type: SHARED_MACHINE_AUTHORITY_TYPE,
    sub: params.actorUserId,
    actionId: `act-${randomHex(4)}`,
    sourceServerId: params.serverId,
    sessionName: params.sessionName,
    projectName: params.projectName,
    shareTarget: params.shareTarget ?? {
      kind: 'main',
      serverId: params.serverId,
      sessionName: params.sessionName,
    },
  }, JWT_KEY);
}

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
  app = buildApp({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    JWT_SIGNING_KEY: JWT_KEY,
    BOT_ENCRYPTION_KEY: randomHex(32),
    DB: db,
    NODE_ENV: 'test',
    ALLOWED_ORIGINS: 'http://localhost',
  } as Env);

  await createUser(db, OWNER_A);
  await createUser(db, USER_B);
  await createUser(db, VIEWER_C);

  await createServer(db, M_PRIV1, OWNER_A, 'Owner Priv 1', sha256(TOK_PRIV1));
  await db.execute(
    `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, ref_name, node_id)
     VALUES ($1, $2, $3, $4, 'online', $5, $6, true, $7, $8)`,
    [M_PRIV2, OWNER_A, 'Owner Priv Controlled', sha256(`tok-priv2-${tag}`), Date.now(), NODE_ROLE.CONTROLLED, `ref-${M_PRIV2}`, generateControlledNodeId()],
  );
  await createServer(db, M_SHARED, OWNER_A, 'Shared Host', sha256(TOK_SHARED));
  await createServer(db, M_TEAM, OWNER_A, 'Team Contributed Host', sha256(TOK_TEAM));
  await createServer(db, M_WHOLE, OWNER_A, 'Whole Server Shared Host', sha256(TOK_WHOLE));
  await createServer(db, M_B, USER_B, 'User B Host', sha256(TOK_B));

  await upsertDbSession(db, `s-priv-${tag}`, M_PRIV1, PRIV_MAIN_SESSION, `priv${tag}`, 'brain', 'claude-code-sdk', '/work/priv', 'idle', 'Owner Priv Session');
  await upsertDbSession(db, `s-sh1-${tag}`, M_SHARED, SHARED_MAIN_SESSION, SHARED_PROJ, 'brain', 'claude-code-sdk', '/work/shared', 'idle', 'Shared Session');
  await upsertDbSession(db, `s-sh2-${tag}`, M_SHARED, UNSHARED_ON_SHARED_HOST, `privonshared${tag}`, 'brain', 'claude-code-sdk', '/work/p2', 'idle', 'Unshared on Shared');
  await upsertDbSession(db, `s-w-${tag}`, M_WHOLE, `deck_w_${tag}_brain`, `w_${tag}`, 'brain', 'claude-code-sdk', '/work/w', 'idle', 'Whole Session');

  const now = Date.now();
  await createOrUpdateShare(db, {
    id: SHARE_ID,
    target: { kind: 'main', serverId: M_SHARED, sessionName: SHARED_MAIN_SESSION },
    targetUserId: USER_B,
    role: 'participant',
    createdBy: OWNER_A,
    now,
  });
  await createOrUpdateShare(db, {
    id: `view-${tag}`,
    target: { kind: 'main', serverId: M_SHARED, sessionName: SHARED_MAIN_SESSION },
    targetUserId: VIEWER_C,
    role: 'viewer',
    createdBy: OWNER_A,
    now,
  });
  await createOrUpdateShare(db, {
    id: WHOLE_SHARE_ID,
    target: { kind: 'server', serverId: M_WHOLE },
    targetUserId: USER_B,
    role: 'participant',
    createdBy: OWNER_A,
    now,
  });

  await db.execute("INSERT INTO teams (id, name, owner_id, plan, created_at) VALUES ($1, $2, $3, 'free', $4)", [TEAM_ID, `Team-${tag}`, OWNER_A, now]);
  await db.execute("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)", [TEAM_ID, OWNER_A, now]);
  await db.execute("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'member', $3)", [TEAM_ID, USER_B, now]);
  await db.execute('INSERT INTO machine_groups (server_id, team_id, added_at) VALUES ($1, $2, $3)', [M_TEAM, TEAM_ID, now]);

  // Seed Owner A private records across all sensitive surfaces
  await db.execute(
    `INSERT INTO user_aliases (id, user_id, name, value, description, tags, source, created_at, updated_at)
     VALUES ($1, $2, $3, 'TOP_SECRET_KEY', 'owner secret alias', '[]', 'manual', $4, $4)`,
    [`alias-${tag}`, OWNER_A, OWNER_ALIAS, now],
  );
  await db.execute(
    `INSERT INTO verification_machine_profiles (id, user_id, scope, scope_key, alias, kind, target, enabled, revision, created_at, updated_at, last_verification_status, source)
     VALUES ($1, $2, 'user', $2, $3, 'controlled_node', $4, true, 1, $5, $5, 'unverified', 'web')`,
    [OWNER_VM_ID, OWNER_A, `vm-${tag}`, M_PRIV2, now],
  );
  await db.execute(
    `INSERT INTO message_pins (id, user_id, server_id, session_name, event_id, event_type, event_ts, text_snapshot, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'ev1', 'assistant.text', $5, 'owner pin on shared', $5, $5),
            ($6, $2, $7, $8, 'ev2', 'assistant.text', $5, 'owner pin on priv1', $5, $5)`,
    [OWNER_PIN_SHARED, OWNER_A, M_SHARED, SHARED_MAIN_SESSION, now, OWNER_PIN_PRIV, M_PRIV1, PRIV_MAIN_SESSION],
  );
  await db.execute(
    `INSERT INTO cloud_docs (id, user_id, name, ext, mime_type, size_bytes, content_sha256, storage_key, doc_version, created_at, updated_at)
     VALUES ($1, $2, 'Owner Secret Doc.txt', 'txt', 'text/plain', 12, $3, $4, 1, $5, $5)`,
    [OWNER_DOC_ID, OWNER_A, sha256('owner-doc'), `docs/${OWNER_DOC_ID}`, now],
  );
  await db.execute(
    `INSERT INTO shared_context_projections (id, server_id, scope, user_id, project_id, projection_class, source_event_ids_json, summary, content_json, created_at, updated_at, replicated_at)
     VALUES ($1, $2, 'personal', $3, $4, 'recent_summary', '[]'::jsonb, 'secret owner memory', '{"text":"secret"}'::jsonb, $5, $5, $5)`,
    [MEM_PROJ_PRIV_ID, M_PRIV1, OWNER_A, `priv${tag}`, now],
  );
  await db.execute(
    `INSERT INTO capability_items (id, owner_user_id, kind, name, lifecycle_state, revision, created_at, updated_at)
     VALUES ($1, $2, 'mcp', 'Owner Private MCP', 'active', 1, $3, $3)`,
    [CAP_ID, OWNER_A, now],
  );
  await db.execute(
    `INSERT INTO capability_versions (id, owner_user_id, item_id, version_number, artifact_digest, audit_digest, source_kind, created_at)
     VALUES ($1, $2, $3, 1, $4, $4, 'mcp_config', $5)`,
    [CAP_VERSION_ID, OWNER_A, CAP_ID, sha256('cap'), now],
  );
});

afterAll(async () => {
  await db.close();
});

describe('Vector B: Shared/contributed daemon token without shared-machine authority cannot access Owner A private account or other hosts', () => {
  it('blocks M_shared and M_team bare daemon tokens across all account-level and cross-server routes', async () => {
    for (const host of [
      { id: M_SHARED, tok: TOK_SHARED, label: 'M_shared (session share)' },
      { id: M_TEAM, tok: TOK_TEAM, label: 'M_team (team contributed)' },
    ]) {
      const hdrs = daemonHeaders(host.id, host.tok);

      const aliasesRes = await app.request('/api/aliases', { headers: hdrs });
      expect(aliasesRes.status, `${host.label} GET /api/aliases`).toBe(403);

      const vmRes = await app.request('/api/verification-machines', { headers: hdrs });
      expect(vmRes.status, `${host.label} GET /api/verification-machines`).toBe(403);

      const outRes = await app.request('/api/outbound', {
        method: 'POST',
        headers: { ...hdrs, 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId: 'b1', channelId: 'c1', text: 'exfil' }),
      });
      expect(outRes.status, `${host.label} POST /api/outbound`).toBe(403);

      const docRes = await app.request('/api/cloud-docs', { headers: hdrs });
      expect(docRes.status, `${host.label} GET /api/cloud-docs`).toBe(403);

      const pinRes = await app.request(`/api/message-pins?serverId=${host.id}`, { headers: hdrs });
      expect(pinRes.status, `${host.label} GET /api/message-pins`).toBe(403);

      const memOwnerRes = await app.request(`/api/memory/projection-owner?projectionId=${MEM_PROJ_PRIV_ID}`, { headers: hdrs });
      expect(memOwnerRes.status, `${host.label} GET /api/memory/projection-owner`).toBe(403);

      const scRes = await app.request('/api/shared-context/personal-memory', { headers: hdrs });
      expect(scRes.status, `${host.label} GET /api/shared-context/personal-memory`).toBe(403);

      const capGetRes = await app.request(`/api/capabilities/${CAP_ID}?serverId=${host.id}`, { headers: hdrs });
      expect(capGetRes.status, `${host.label} GET /api/capabilities/:id`).toBe(403);

      const capBlobRes = await app.request(`/api/capabilities/blobs/${CAP_VERSION_ID}/access`, {
        method: 'POST',
        headers: { ...hdrs, 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilityId: CAP_ID, action: 'download' }),
      });
      expect(capBlobRes.status, `${host.label} POST /api/capabilities/blobs/:id/access`).toBe(403);

      const execPrivRes = await app.request(`/api/machine/exec?serverId=${M_PRIV2}`, {
        method: 'POST',
        headers: { ...hdrs, 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'whoami' }),
      });
      expect(execPrivRes.status, `${host.label} POST /api/machine/exec -> M_priv2`).toBe(403);

      const sessPrivRes = await app.request(`/api/server/${M_PRIV1}/sessions`, { headers: hdrs });
      expect(sessPrivRes.status, `${host.label} GET /api/server/:M_priv1/sessions`).toBe(403);

      const subPrivRes = await app.request(`/api/server/${M_PRIV1}/sub-sessions`, { headers: hdrs });
      expect(subPrivRes.status, `${host.label} GET /api/server/:M_priv1/sub-sessions`).toBe(403);

      const ftPrivRes = await app.request(`/api/server/${M_PRIV1}/upload`, {
        method: 'POST',
        headers: hdrs,
      });
      expect(ftPrivRes.status, `${host.label} POST /api/server/:M_priv1/upload`).toBe(403);

      // Bare shared-host daemon tokens without authority must be blocked from owner-private memory routes
      const bareOwnerPrivWrite = await app.request(`/api/server/${host.id}/shared-context/owner-private`, {
        method: 'POST',
        headers: { ...hdrs, 'Content-Type': 'application/json' },
        body: JSON.stringify({ namespace: { scope: 'user_private', userId: OWNER_A }, records: [] }),
      });
      expect(bareOwnerPrivWrite.status, `${host.label} bare POST owner-private`).toBe(403);

      const bareOwnerPrivSearch = await app.request(`/api/server/${host.id}/shared-context/owner-private/search`, {
        method: 'POST',
        headers: { ...hdrs, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'secret' }),
      });
      expect(bareOwnerPrivSearch.status, `${host.label} bare POST owner-private/search`).toBe(403);

      // Own daemon-local session inventory sync MUST continue working on M_shared / M_team itself
      const ownSessRes = await app.request(`/api/server/${host.id}/sessions`, { headers: hdrs });
      expect(ownSessRes.status, `${host.label} own GET /sessions`).toBe(200);
      const ownSubRes = await app.request(`/api/server/${host.id}/sub-sessions`, { headers: hdrs });
      expect(ownSubRes.status, `${host.label} own GET /sub-sessions`).toBe(200);
    }
  });
});

describe('Vector A: Participant authority on M_shared is strictly scoped to User B and the shared session/server', () => {
  it('blocks Participant B shared-machine authority from Owner A account stores and M_priv1/M_priv2, and rejects forged authority tokens', async () => {
    const partToken = mintParticipantAuthority({
      actorUserId: USER_B,
      serverId: M_SHARED,
      sessionName: SHARED_MAIN_SESSION,
      projectName: SHARED_PROJ,
    });
    const partHdrs = daemonHeaders(M_SHARED, TOK_SHARED, {
      [SHARED_MACHINE_AUTHORITY_HEADER]: partToken,
    });

    expect((await app.request('/api/aliases', { headers: partHdrs })).status).toBe(403);
    expect((await app.request('/api/verification-machines', { headers: partHdrs })).status).toBe(403);
    expect((await app.request(`/api/capabilities/${CAP_ID}?serverId=${M_SHARED}`, { headers: partHdrs })).status).toBe(403);
    // Project/memory routes allow participant turns while strictly isolating rows to User B (Owner A's private records never leak)
    expect((await app.request(`/api/memory/projection-owner?projectionId=${MEM_PROJ_PRIV_ID}&projectId=${encodeURIComponent(`priv${tag}`)}`, { headers: partHdrs })).status).toBe(404);
    const partPersonalMemRes = await app.request('/api/shared-context/personal-memory', { headers: partHdrs });
    expect(partPersonalMemRes.status).toBe(200);
    expect((await partPersonalMemRes.json() as { records: unknown[] }).records).toEqual([]);
    // Server owner-private memory replication/search routes MUST reject participant_daemon authority
    const partOwnerPrivWrite = await app.request(`/api/server/${M_SHARED}/shared-context/owner-private`, {
      method: 'POST',
      headers: { ...partHdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: { scope: 'user_private', userId: OWNER_A }, records: [] }),
    });
    expect(partOwnerPrivWrite.status).toBe(403);

    const partOwnerPrivSearch = await app.request(`/api/server/${M_SHARED}/shared-context/owner-private/search`, {
      method: 'POST',
      headers: { ...partHdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'owner-secret' }),
    });
    expect(partOwnerPrivSearch.status).toBe(403);

    // Participant authority MUST NOT write owner personal projections via POST /processed or probe owner personal freshness via /resolve-namespace
    await db.execute(
      `INSERT INTO shared_context_projections (
        id, server_id, scope, enterprise_id, workspace_id, user_id, project_id,
        projection_class, source_event_ids_json, summary, content_json,
        content_hash, origin, created_at, updated_at, replicated_at
      ) VALUES ($1, $2, 'personal', NULL, NULL, $3, $4, 'recent_summary', '[]'::jsonb, 'owner private projection summary', '{}'::jsonb, 'hash-owner-only', 'chat_compacted', $5, $5, $5)
      ON CONFLICT (id) DO NOTHING`,
      [`proj-owner-only-${tag}`, M_SHARED, OWNER_A, `owner-only-repo-${tag}`, Date.now()],
    );
    const partProcPoison = await app.request(`/api/server/${M_SHARED}/shared-context/processed`, {
      method: 'POST',
      headers: { ...partHdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace: { scope: 'personal', projectId: `owner-only-repo-${tag}` },
        projections: [{
          id: `poison-personal-${tag}`,
          namespace: { scope: 'personal', projectId: `owner-only-repo-${tag}` },
          class: 'durable_memory_candidate',
          origin: 'chat_compacted',
          sourceEventIds: [],
          summary: 'participant attempted owner personal poisoning',
          content: {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }],
      }),
    });
    expect(partProcPoison.status).toBe(403);
    expect(await partProcPoison.json()).toMatchObject({ reason: 'shared_participant_forbidden' });
    const poisonedRow = await db.queryOne<{ id: string }>(
      'SELECT id FROM shared_context_projections WHERE id = $1',
      [`poison-personal-${tag}`],
    );
    expect(poisonedRow).toBeNull();

    const partResolveRes = await app.request(`/api/server/${M_SHARED}/shared-context/resolve-namespace`, {
      method: 'POST',
      headers: { ...partHdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ canonicalRepoId: `owner-only-repo-${tag}` }),
    });
    expect(partResolveRes.status).toBe(200);
    expect(await partResolveRes.json()).toMatchObject({ remoteProcessedFreshness: 'missing' });

    // Non-personal project_shared replication on M_SHARED with participant authority preserves parity without attributing to Owner A
    const sharedPartProc = await app.request(`/api/server/${M_SHARED}/shared-context/processed`, {
      method: 'POST',
      headers: { ...partHdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace: { scope: 'project_shared', projectId: SHARED_PROJ },
        projections: [{
          id: `proj-shared-part-${tag}`,
          namespace: { scope: 'project_shared', projectId: SHARED_PROJ },
          class: 'recent_summary',
          origin: 'chat_compacted',
          sourceEventIds: [],
          summary: 'shared project processed projection parity',
          content: {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }],
      }),
    });
    expect(sharedPartProc.status).toBe(200);
    const sharedPartRow = await db.queryOne<{ user_id: string | null }>(
      'SELECT user_id FROM shared_context_projections WHERE id = $1',
      [`proj-shared-part-${tag}`],
    );
    expect(sharedPartRow?.user_id).toBe(USER_B);
    // Outbound and session/sub-session management daemon routes block participant_daemon turns (403 shared_participant_forbidden)
    expect((await app.request('/api/outbound', {
      method: 'POST',
      headers: { ...partHdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'telegram', botId: 'b-nonexistent', channelId: 'c1', content: 'hi' }),
    })).status).toBe(403);
    expect((await app.request(`/api/server/${M_SHARED}/sessions`, { headers: partHdrs })).status).toBe(403);
    expect((await app.request(`/api/server/${M_SHARED}/sub-sessions`, { headers: partHdrs })).status).toBe(403);
    expect((await app.request(`/api/server/${M_PRIV1}/sessions`, { headers: partHdrs })).status).toBe(403);
    expect((await app.request(`/api/server/${M_PRIV1}/sub-sessions`, { headers: partHdrs })).status).toBe(403);
    expect((await app.request(`/api/machine/exec?serverId=${M_PRIV2}`, {
      method: 'POST',
      headers: { ...partHdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'id' }),
    })).status).toBe(403);

    // Whole-server participant on M_WHOLE can invoke server-scoped memory recall on M_WHOLE, never on M_PRIV1
    const wholePartToken = mintParticipantAuthority({
      actorUserId: USER_B,
      serverId: M_WHOLE,
      sessionName: `deck_w_${tag}_brain`,
      projectName: `w_${tag}`,
      shareTarget: { kind: 'server', serverId: M_WHOLE },
    });
    const wholePartHdrs = daemonHeaders(M_WHOLE, TOK_WHOLE, {
      [SHARED_MACHINE_AUTHORITY_HEADER]: wholePartToken,
    });
    expect((await app.request(`/api/shared-context/${M_WHOLE}/shared-context/memory/recall`, {
      method: 'POST',
      headers: { ...wholePartHdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'deploy note', projectId: `w_${tag}` }),
    })).status).toBe(200);
    expect((await app.request(`/api/shared-context/${M_PRIV1}/shared-context/memory/recall`, {
      method: 'POST',
      headers: { ...wholePartHdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'deploy note', projectId: `priv${tag}` }),
    })).status).toBe(403);

    // Forged authority token signed with wrong key
    const forgedToken = signJwt({
      type: SHARED_MACHINE_AUTHORITY_TYPE,
      actorUserId: OWNER_A,
      sourceServerId: M_SHARED,
      sessionName: SHARED_MAIN_SESSION,
      projectName: SHARED_PROJ,
      shareTarget: { kind: 'main', serverId: M_SHARED, sessionName: SHARED_MAIN_SESSION },
    }, 'wrong-key-wrong-key-wrong-key-0000', 3600);
    expect((await app.request(`/api/message-pins?serverId=${M_SHARED}`, {
      headers: daemonHeaders(M_SHARED, TOK_SHARED, { [SHARED_MACHINE_AUTHORITY_HEADER]: forgedToken }),
    })).status).toBe(403);
  });

  it('isolates message pins to User B and pins participant_daemon queries to the shared session', async () => {
    const partToken = mintParticipantAuthority({
      actorUserId: USER_B,
      serverId: M_SHARED,
      sessionName: SHARED_MAIN_SESSION,
      projectName: SHARED_PROJ,
    });
    const partHdrs = daemonHeaders(M_SHARED, TOK_SHARED, {
      [SHARED_MACHINE_AUTHORITY_HEADER]: partToken,
    });

    // Participant B cannot read Owner A's pin even on the shared session
    expect((await app.request(`/api/message-pins/${OWNER_PIN_SHARED}?serverId=${M_SHARED}`, { headers: partHdrs })).status).toBe(404);

    // Participant B cannot list pins of an unshared session on M_shared or on M_priv1
    expect((await app.request(`/api/message-pins?serverId=${M_SHARED}&sessionName=${encodeURIComponent(UNSHARED_ON_SHARED_HOST)}`, { headers: partHdrs })).status).toBe(403);
    expect((await app.request(`/api/message-pins?serverId=${M_PRIV1}&sessionName=${encodeURIComponent(PRIV_MAIN_SESSION)}`, { headers: partHdrs })).status).toBe(403);

    // Participant B CAN create and list their own pin on the shared session
    const createRes = await app.request(`/api/message-pins?serverId=${M_SHARED}&sessionName=${encodeURIComponent(SHARED_MAIN_SESSION)}`, {
      method: 'POST',
      headers: { ...partHdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: `ev-b-${tag}`,
        eventType: 'assistant.text',
        eventTs: Date.now(),
        text: 'User B own pin',
      }),
    });
    expect(createRes.status).toBe(201);

    const listRes = await app.request(`/api/message-pins?serverId=${M_SHARED}`, { headers: partHdrs });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { pins: Array<{ id: string; text: string }> };
    expect(listBody.pins.map((p) => p.text)).toEqual(['User B own pin']);
  });
});

describe('Share revocation and whole-server share boundaries', () => {
  it('blocks whole-server share participants from renaming/deleting owner server and share management while preserving owner control', async () => {
    // Whole-server share participant USER_B CANNOT rename M_whole
    const patchRes = await app.request(`/api/server/${M_WHOLE}/name`, {
      method: 'PATCH',
      headers: { Authorization: userBearer(USER_B), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Participant Renamed Server' }),
    });
    expect(patchRes.status).toBe(404);

    const ownerPatch = await app.request(`/api/server/${M_WHOLE}/name`, {
      method: 'PATCH',
      headers: { Authorization: userBearer(OWNER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Whole Server Valid Name' }),
    });
    expect(ownerPatch.status).toBe(200);

    // Whole-server participant USER_B MUST still be denied from viewing/inviting/updating/revoking shares
    expect((await app.request(`/api/server/${M_WHOLE}/shares`, {
      headers: { Authorization: userBearer(USER_B) },
    })).status).toBe(403);
    expect((await app.request(`/api/server/${M_WHOLE}/shares`, {
      method: 'POST',
      headers: { Authorization: userBearer(USER_B), 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { kind: 'server', serverId: M_WHOLE }, targetUserId: VIEWER_C, role: 'viewer' }),
    })).status).toBe(403);
    expect((await app.request(`/api/server/${M_WHOLE}/shares/${WHOLE_SHARE_ID}`, {
      method: 'PATCH',
      headers: { Authorization: userBearer(USER_B), 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' }),
    })).status).toBe(403);
    expect((await app.request(`/api/server/${M_WHOLE}/shares/${WHOLE_SHARE_ID}`, {
      method: 'DELETE',
      headers: { Authorization: userBearer(USER_B) },
    })).status).toBe(403);
    expect((await app.request(`/api/server/${M_WHOLE}/share-audit`, {
      headers: { Authorization: userBearer(USER_B) },
    })).status).toBe(403);

    // Whole-server participant USER_B CANNOT delete owner's server; only OWNER_A can
    const delSrvId = `srv-whole-del-${tag}`;
    await createServer(db, delSrvId, OWNER_A, 'Disposable Whole Server', sha256(`tok-del-${tag}`));
    await createOrUpdateShare(db, {
      id: `wshare-del-${tag}`,
      target: { kind: 'server', serverId: delSrvId },
      targetUserId: USER_B,
      role: 'participant',
      createdBy: OWNER_A,
      now: Date.now(),
    });
    const partDelRes = await app.request(`/api/server/${delSrvId}`, {
      method: 'DELETE',
      headers: { Authorization: userBearer(USER_B) },
    });
    expect(partDelRes.status).toBe(404);
    const ownerDelRes = await app.request(`/api/server/${delSrvId}`, {
      method: 'DELETE',
      headers: { Authorization: userBearer(OWNER_A) },
    });
    expect(ownerDelRes.status).toBe(200);
  });

  it('immediately pauses participant crons when the tab share or team membership is revoked', async () => {
    const cronShareId = `cron-sh-${tag}`;
    const cronTeamId = `cron-tm-${tag}`;
    const now = Date.now();

    await db.execute(
      `INSERT INTO cron_jobs (id, server_id, user_id, name, cron_expr, project_name, target_session_name, action, status, created_at)
       VALUES ($1, $2, $3, 'sh-cron', '*/5 * * * *', $4, $5, '{}', 'active', $6),
              ($7, $8, $3, 'tm-cron', '*/5 * * * *', 'teamproj', NULL, '{}', 'active', $6)`,
      [cronShareId, M_SHARED, USER_B, SHARED_PROJ, SHARED_MAIN_SESSION, now, cronTeamId, M_TEAM],
    );
    await db.execute(
      `INSERT INTO cron_job_provenance (job_id, creator_user_id, server_id, project_name, shared, created_at)
       VALUES ($1, $2, $3, $4, true, $5),
              ($6, $2, $7, 'teamproj', true, $5)`,
      [cronShareId, USER_B, M_SHARED, SHARED_PROJ, now, cronTeamId, M_TEAM],
    );

    const revokeShareRes = await app.request(`/api/server/${M_SHARED}/shares/${SHARE_ID}`, {
      method: 'DELETE',
      headers: { Authorization: userBearer(OWNER_A) },
    });
    expect(revokeShareRes.status).toBe(200);

    const row1 = await db.queryOne<{ status: string }>(
      'SELECT status FROM cron_jobs WHERE id = $1',
      [cronShareId],
    );
    expect(row1).toEqual({ status: 'paused' });

    const removeMemberRes = await app.request(`/api/team/${TEAM_ID}/member/${USER_B}`, {
      method: 'DELETE',
      headers: { Authorization: userBearer(OWNER_A) },
    });
    expect(removeMemberRes.status).toBe(200);

    const row2 = await db.queryOne<{ status: string }>(
      'SELECT status FROM cron_jobs WHERE id = $1',
      [cronTeamId],
    );
    expect(row2).toEqual({ status: 'paused' });
  });
});

describe('Positive regression guarantees: Owner A on unshared M_priv1 -> M_priv2 retains full cross-device and account capabilities', () => {
  it('allows M_priv1 daemon token to access aliases, verification machines, capabilities, memory, pins, session inventory, and machines listing', async () => {
    const hdrs = daemonHeaders(M_PRIV1, TOK_PRIV1);

    const aliasesRes = await app.request('/api/aliases', { headers: hdrs });
    expect(aliasesRes.status).toBe(200);
    const aliasesBody = await aliasesRes.json() as { aliases: Array<{ name: string }> };
    expect(aliasesBody.aliases.some((a) => a.name === OWNER_ALIAS)).toBe(true);

    const vmRes = await app.request('/api/verification-machines', { headers: hdrs });
    expect(vmRes.status).toBe(200);
    const vmBody = await vmRes.json() as { profiles: Array<{ id: string }> };
    expect(vmBody.profiles.some((p) => p.id === OWNER_VM_ID)).toBe(true);

    const capGetRes = await app.request(`/api/capabilities/${CAP_ID}?serverId=${M_PRIV1}`, { headers: hdrs });
    expect(capGetRes.status).toBe(200);

    const memOwnerRes = await app.request(`/api/memory/projection-owner?projectionId=${MEM_PROJ_PRIV_ID}&projectId=${encodeURIComponent(`priv${tag}`)}`, { headers: hdrs });
    expect(memOwnerRes.status).toBe(200);
    expect(await memOwnerRes.json()).toMatchObject({ originServerId: M_PRIV1 });

    const pinRes = await app.request(`/api/message-pins/${OWNER_PIN_PRIV}?serverId=${M_PRIV1}`, { headers: hdrs });
    expect(pinRes.status).toBe(200);

    const machinesRes = await app.request('/api/machines?includeOffline=true', { headers: hdrs });
    expect(machinesRes.status).toBe(200);
    const machinesBody = await machinesRes.json() as { machines: Array<{ serverId: string }> };
    expect(machinesBody.machines.some((m) => m.serverId === M_PRIV2)).toBe(true);

    const ownSessRes = await app.request(`/api/server/${M_PRIV1}/sessions`, { headers: hdrs });
    expect(ownSessRes.status).toBe(200);

    const ownSubSessRes = await app.request(`/api/server/${M_PRIV1}/sub-sessions`, { headers: hdrs });
    expect(ownSubSessRes.status).toBe(200);

    // Owner A on unshared M_priv1 retains legitimate cross-device exec dispatch to M_priv2 (passes authz; 409/502 when WS daemon offline in unit app)
    const crossOwnExecRes = await app.request(`/api/machine/exec?serverId=${M_PRIV2}`, {
      method: 'POST',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'echo ok' }),
    });
    expect(crossOwnExecRes.status).not.toBe(403);
    expect(crossOwnExecRes.status).not.toBe(401);
  });
});

describe('Owner-Turn Authority: Owner A operating on shared/contributed hosts M_shared and M_team', () => {
  it('allows verified Owner A turns on M_shared and M_team across machines, cross-device exec, account stores, and daemon-self endpoints', async () => {
    for (const host of [
      { id: M_SHARED, tok: TOK_SHARED, session: SHARED_MAIN_SESSION, project: SHARED_PROJ, label: 'M_shared' },
      { id: M_TEAM, tok: TOK_TEAM, session: `deck_team_${tag}_brain`, project: `team_${tag}`, label: 'M_team' },
    ]) {
      const ownerToken = await issueOwnerMachineAuthorityForSession(db, {
        actorUserId: OWNER_A,
        sourceServerId: host.id,
        sessionName: host.session,
        actionId: `owner-act-${randomHex(4)}`,
        signingKey: JWT_KEY,
      });
      expect(ownerToken, `${host.label} owner token minted`).toBeTruthy();
      const hdrs = daemonHeaders(host.id, host.tok, {
        [SHARED_MACHINE_AUTHORITY_HEADER]: ownerToken!,
      });

      const machinesRes = await app.request('/api/machines?includeOffline=true', { headers: hdrs });
      expect(machinesRes.status, `${host.label} GET /api/machines`).toBe(200);
      const machinesBody = await machinesRes.json() as { machines: Array<{ serverId: string }> };
      expect(machinesBody.machines.some((m) => m.serverId === M_PRIV2)).toBe(true);

      const crossExecRes = await app.request(`/api/machine/exec?serverId=${M_PRIV2}`, {
        method: 'POST',
        headers: { ...hdrs, 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'echo owner-ok' }),
      });
      expect(crossExecRes.status, `${host.label} cross-device exec not 403`).not.toBe(403);
      expect(crossExecRes.status, `${host.label} cross-device exec not 401`).not.toBe(401);

      const crossCuRes = await app.request(`/api/machine/computer-use?serverId=${M_PRIV2}`, {
        method: 'POST',
        headers: { ...hdrs, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'list_apps' }),
      });
      expect(crossCuRes.status, `${host.label} computer-use not 403`).not.toBe(403);
      expect(crossCuRes.status, `${host.label} computer-use not 401`).not.toBe(401);

      const aliasesRes = await app.request('/api/aliases', { headers: hdrs });
      expect(aliasesRes.status, `${host.label} GET /api/aliases`).toBe(200);

      const vmRes = await app.request('/api/verification-machines', { headers: hdrs });
      expect(vmRes.status, `${host.label} GET /api/verification-machines`).toBe(200);

      const capGetRes = await app.request(`/api/capabilities/${CAP_ID}?serverId=${host.id}`, { headers: hdrs });
      expect(capGetRes.status, `${host.label} GET /api/capabilities/:id`).toBe(200);

      const docRes = await app.request('/api/cloud-docs', { headers: hdrs });
      expect(docRes.status, `${host.label} GET /api/cloud-docs`).toBe(200);

      const memOwnerRes = await app.request(
        `/api/memory/projection-owner?projectionId=${MEM_PROJ_PRIV_ID}&projectId=${encodeURIComponent(`priv${tag}`)}`,
        { headers: hdrs },
      );
      expect(memOwnerRes.status, `${host.label} GET /api/memory/projection-owner`).toBe(200);

      const pinListRes = await app.request(`/api/message-pins?serverId=${host.id}`, { headers: hdrs });
      expect(pinListRes.status, `${host.label} GET /api/message-pins`).toBe(200);
      if (host.id === M_SHARED) {
        const pinRes = await app.request(`/api/message-pins/${OWNER_PIN_SHARED}?serverId=${M_SHARED}`, { headers: hdrs });
        expect(pinRes.status, `${host.label} GET /api/message-pins/:id`).toBe(200);
      }

      const ownSessRes = await app.request(`/api/server/${host.id}/sessions`, { headers: hdrs });
      expect(ownSessRes.status, `${host.label} GET /api/server/:id/sessions`).toBe(200);

      const subSessRes = await app.request(`/api/server/${host.id}/sub-sessions`, { headers: hdrs });
      expect(subSessRes.status, `${host.label} GET /api/server/:id/sub-sessions`).toBe(200);

      const cfgRes = await app.request(`/api/server/${host.id}/shared-context/runtime-config/daemon`, { headers: hdrs });
      expect(cfgRes.status, `${host.label} GET /api/server/:id/shared-context/runtime-config/daemon`).toBe(200);

      const supRes = await app.request(`/api/server/${host.id}/supervision/user-defaults/daemon`, { headers: hdrs });
      expect(supRes.status, `${host.label} GET /api/server/:id/supervision/user-defaults/daemon`).toBe(200);

      const outRes = await app.request('/api/outbound', {
        method: 'POST',
        headers: { ...hdrs, 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId: 'b1', channelId: 'c1', text: 'owner outbound' }),
      });
      expect(outRes.status, `${host.label} POST /api/outbound not 403`).not.toBe(403);
    }
  });

  it('refuses owner-turn minting and owner-turn claims for non-owners, whole-server share users, and mismatched source servers', async () => {
    // Whole-server-share user USER_B on M_WHOLE must never receive an owner token
    const wholeUserToken = await issueOwnerMachineAuthorityForSession(db, {
      actorUserId: USER_B,
      sourceServerId: M_WHOLE,
      sessionName: `deck_w_${tag}_brain`,
      actionId: `bad-whole-${randomHex(4)}`,
      signingKey: JWT_KEY,
    });
    expect(wholeUserToken).toBeNull();

    // Non-owner participant USER_B on M_SHARED must never receive an owner token
    const participantUserToken = await issueOwnerMachineAuthorityForSession(db, {
      actorUserId: USER_B,
      sourceServerId: M_SHARED,
      sessionName: SHARED_MAIN_SESSION,
      actionId: `bad-part-${randomHex(4)}`,
      signingKey: JWT_KEY,
    });
    expect(participantUserToken).toBeNull();

    // Even if a forged JWT claims OWNER_MACHINE_AUTHORITY_TYPE for USER_B or wrong server, M_SHARED rejects it with 403
    const forgedUserBOwner = issueOwnerMachineAuthority({
      type: OWNER_MACHINE_AUTHORITY_TYPE,
      sub: USER_B,
      sourceServerId: M_SHARED,
      sessionName: SHARED_MAIN_SESSION,
      projectName: SHARED_PROJ,
      actionId: `forge-b-${randomHex(4)}`,
    }, JWT_KEY);
    const wrongServerOwner = issueOwnerMachineAuthority({
      type: OWNER_MACHINE_AUTHORITY_TYPE,
      sub: OWNER_A,
      sourceServerId: M_PRIV1,
      sessionName: SHARED_MAIN_SESSION,
      projectName: SHARED_PROJ,
      actionId: `forge-srv-${randomHex(4)}`,
    }, JWT_KEY);

    for (const badToken of [forgedUserBOwner, wrongServerOwner]) {
      const hdrs = daemonHeaders(M_SHARED, TOK_SHARED, {
        [SHARED_MACHINE_AUTHORITY_HEADER]: badToken,
      });
      const res = await app.request('/api/machines?includeOffline=true', { headers: hdrs });
      expect(res.status).toBe(403);
      const execRes = await app.request(`/api/machine/exec?serverId=${M_PRIV2}`, {
        method: 'POST',
        headers: { ...hdrs, 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'id' }),
      });
      expect(execRes.status).toBe(403);
    }
  });
});
