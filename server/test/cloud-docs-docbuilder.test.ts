import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { sha256Hex, signJwt, verifyJwt } from '../src/security/crypto.js';
import { LocalCloudDocStorage } from '../src/storage/cloud-doc-storage.js';
import {
  clearEphemeralDocBuilderScriptsForTests,
  createDbDocBuilderScriptStore,
  prepareOnlyOfficeDocBuilderScript,
  signDocBuilderScriptToken,
} from '../src/services/onlyoffice-docbuilder.js';
import type {
  CloudDocFolderRow,
  CloudDocRow,
  CloudDocShareRow,
} from '../src/db/cloud-docs.js';
import { CLOUD_DOCS_MAX_UPLOAD_BYTES, CLOUD_DOC_ERROR_CODES } from '../../shared/cloud-docs.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { SERVER_ID_HEADER } from '../../shared/http-header-names.js';

const JWT_KEY = 'cloud-docs-docbuilder-test-key-32chars!';
const OO_SECRET = 'cloud-docs-docbuilder-oo-secret-32chars!';

function createDocBuilderTestDb() {
  const users = new Map<string, { id: string; username: string; display_name: string; status: string; sessions_valid_after: number; is_admin: boolean }>([
    ['owner-1', { id: 'owner-1', username: 'alice', display_name: 'Alice', status: 'active', sessions_valid_after: 0, is_admin: false }],
    ['user-bob', { id: 'user-bob', username: 'bob', display_name: 'Bob', status: 'active', sessions_valid_after: 0, is_admin: false }],
    ['user-carol', { id: 'user-carol', username: 'carol', display_name: 'Carol', status: 'active', sessions_valid_after: 0, is_admin: false }],
  ]);
  const servers = new Map<string, { id: string; name: string; user_id: string; team_id: string | null; token_hash: string; node_role: string; revoked_at: number | null }>([
    ['srv-full', { id: 'srv-full', name: 'Full Node', user_id: 'owner-1', team_id: null, token_hash: sha256Hex('full-secret'), node_role: NODE_ROLE.FULL, revoked_at: null }],
    ['srv-ctrl', { id: 'srv-ctrl', name: 'Ctrl Node', user_id: 'owner-1', team_id: null, token_hash: sha256Hex('ctrl-secret'), node_role: NODE_ROLE.CONTROLLED, revoked_at: null }],
  ]);
  const folders = new Map<string, CloudDocFolderRow>();
  const docs = new Map<string, CloudDocRow>();
  const shares = new Map<string, CloudDocShareRow>();
  const scripts = new Map<string, { id: string; script: string; expires_at: number; created_at: number }>();

  const db: Database = {
    query: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.includes('FROM cloud_doc_shares WHERE target_kind = $1 AND target_id = $2 AND revoked_at IS NULL')) {
        const [kind, id] = params as [string, string];
        return [...shares.values()].filter((r) => r.target_kind === kind && r.target_id === id && r.revoked_at === null) as unknown as T[];
      }
      if (s.includes("FROM cloud_doc_shares WHERE revoked_at IS NULL AND share_mode = 'user' AND target_user_id = $1")) {
        const uid = params[0] as string;
        return [...shares.values()].filter((r) => r.revoked_at === null && r.share_mode === 'user' && r.target_user_id === uid) as unknown as T[];
      }
      if (s.includes("FROM cloud_doc_shares WHERE revoked_at IS NULL AND share_mode = 'team'")) {
        return [] as unknown as T[];
      }
      if (s.includes('FROM teams t JOIN team_members')) {
        return [] as unknown as T[];
      }
      if (s.includes('FROM cloud_doc_folders WHERE user_id = $1')) {
        const uid = params[0] as string;
        return [...folders.values()].filter((f) => f.user_id === uid) as unknown as T[];
      }
      if (s.includes('FROM cloud_docs WHERE user_id = $1')) {
        const uid = params[0] as string;
        return [...docs.values()].filter((d) => d.user_id === uid) as unknown as T[];
      }
      return [];
    },
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.includes('FROM users WHERE id = $1')) {
        const u = users.get(params[0] as string);
        return (u ? { ...u } : null) as unknown as T | null;
      }
      if (s.includes('FROM servers WHERE id = $1')) {
        const srv = servers.get(params[0] as string);
        if (!srv) return null;
        const owner = users.get(srv.user_id);
        return { ...srv, owner_status: owner?.status ?? 'active' } as unknown as T;
      }
      if (s.includes('FROM cloud_doc_folders WHERE id = $1 AND user_id = $2')) {
        const row = folders.get(params[0] as string);
        return (row && row.user_id === params[1] ? row : null) as unknown as T | null;
      }
      if (s.includes('FROM cloud_doc_folders WHERE id = $1')) {
        return (folders.get(params[0] as string) ?? null) as unknown as T | null;
      }
      if (s.includes('FROM cloud_docs WHERE id = $1 AND user_id = $2')) {
        const row = docs.get(params[0] as string);
        return (row && row.user_id === params[1] ? row : null) as unknown as T | null;
      }
      if (s.includes('FROM cloud_docs WHERE id = $1')) {
        return (docs.get(params[0] as string) ?? null) as unknown as T | null;
      }
      if (s.includes('FROM cloud_doc_shares WHERE target_kind = $1 AND target_id = $2 AND share_mode =')) {
        const [kind, id, targetRef] = params as [string, string, string | null];
        const mode = s.includes("share_mode = 'team'") ? 'team' : 'user';
        const match = [...shares.values()].find(
          (r) =>
            r.target_kind === kind &&
            r.target_id === id &&
            r.share_mode === mode &&
            r.revoked_at === null &&
            (mode === 'team' ? r.target_team_id === targetRef : r.target_user_id === targetRef),
        );
        return (match ?? null) as unknown as T | null;
      }
      if (s.includes('FROM cloud_doc_shares WHERE id = $1')) {
        return (shares.get(params[0] as string) ?? null) as unknown as T | null;
      }
      if (s.startsWith('INSERT INTO cloud_docs')) {
        const [id, userId, folderId, name, ext, mimeType, sizeBytes, sha, storageKey, createdAt, updatedAt] = params as [
          string, string, string | null, string, string, string, number, string, string, number, number,
        ];
        const row: CloudDocRow = {
          id,
          user_id: userId,
          folder_id: folderId,
          name,
          ext,
          mime_type: mimeType,
          size_bytes: sizeBytes,
          content_sha256: sha,
          storage_key: storageKey,
          doc_version: 1,
          created_at: createdAt,
          updated_at: updatedAt,
          last_opened_at: null,
        };
        docs.set(id, row);
        return row as unknown as T;
      }
      if (s.startsWith('UPDATE cloud_docs SET')) {
        const hasMeta = s.includes('name = COALESCE');
        const id = params[5] as string;
        const userId = params[6] as string;
        const expectedVersion = params[7] as number;
        const existing = docs.get(id);
        if (!existing || existing.user_id !== userId || Number(existing.doc_version) !== expectedVersion) {
          return null;
        }
        const nextRow: CloudDocRow = { ...existing };
        nextRow.storage_key = params[0] as string;
        nextRow.size_bytes = params[1] as number;
        nextRow.content_sha256 = params[2] as string;
        nextRow.doc_version = params[3] as number;
        nextRow.updated_at = params[4] as number;
        if (hasMeta) {
          if (params[8] !== null) nextRow.name = params[8] as string;
          if (params[9] !== null) nextRow.ext = params[9] as string;
          if (params[10] !== null) nextRow.mime_type = params[10] as string;
          if (params[11] === true) nextRow.folder_id = params[12] as string | null;
        }
        docs.set(id, nextRow);
        return nextRow as unknown as T;
      }
      if (s === 'SELECT script FROM onlyoffice_docbuilder_scripts WHERE id = $1 AND expires_at > $2') {
        const [id, now] = params as [string, number];
        const row = scripts.get(id);
        return (row && row.expires_at > now ? { script: row.script } : null) as unknown as T | null;
      }
      if (s === 'DELETE FROM onlyoffice_docbuilder_scripts WHERE id = $1 AND expires_at > $2 RETURNING script') {
        const [id, now] = params as [string, number];
        const row = scripts.get(id);
        scripts.delete(id);
        return (row && row.expires_at > now ? { script: row.script } : null) as unknown as T | null;
      }
      return null;
    },
    execute: async (sql: string, params: unknown[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('DELETE FROM onlyoffice_docbuilder_scripts WHERE expires_at <= $1')) {
        const [now] = params as [number];
        let deleted = 0;
        for (const [id, row] of scripts.entries()) {
          if (row.expires_at <= now) {
            scripts.delete(id);
            deleted += 1;
          }
        }
        return { changes: deleted, rowCount: deleted };
      }
      if (s.startsWith('INSERT INTO onlyoffice_docbuilder_scripts')) {
        const [id, script, expiresAt, createdAt] = params as [string, string, number, number];
        scripts.set(id, { id, script, expires_at: expiresAt, created_at: createdAt });
        return { changes: 1, rowCount: 1 };
      }
      if (s === 'DELETE FROM onlyoffice_docbuilder_scripts WHERE id = $1') {
        const [id] = params as [string];
        const existed = scripts.delete(id);
        return { changes: existed ? 1 : 0, rowCount: existed ? 1 : 0 };
      }
      if (s.startsWith('INSERT INTO cloud_doc_folders')) {
        const [id, userId, parentId, name, createdAt, updatedAt] = params as [string, string, string | null, string, number, number];
        const row: CloudDocFolderRow = { id, user_id: userId, parent_id: parentId, name, created_at: createdAt, updated_at: updatedAt };
        folders.set(id, row);
        return { changes: 1, rowCount: 1 };
      }
      if (s.startsWith('INSERT INTO cloud_doc_shares')) {
        const [id, targetKind, targetId, shareMode, targetTeamId, targetUserId, role, allowDownload, createdBy, createdAt, updatedAt] = params as [
          string, 'doc' | 'folder', string, 'team' | 'user', string | null, string | null, 'viewer' | 'editor', boolean, string, number, number,
        ];
        const row: CloudDocShareRow = {
          id,
          target_kind: targetKind,
          target_id: targetId,
          share_mode: shareMode,
          target_team_id: targetTeamId,
          target_user_id: targetUserId,
          role,
          allow_download: allowDownload,
          created_by: createdBy,
          created_at: createdAt,
          updated_at: updatedAt,
          revoked_at: null,
        };
        shares.set(id, row);
        return { rowCount: 1 };
      }
      if (s.startsWith('UPDATE cloud_doc_shares SET role =')) {
        const [role, allowDownload, updatedAt, id] = params as ['viewer' | 'editor', boolean, number, string];
        const existing = shares.get(id);
        if (existing) {
          shares.set(id, { ...existing, role, allow_download: allowDownload, updated_at: updatedAt });
          return { rowCount: 1 };
        }
      }
      return { rowCount: 0 };
    },
    transaction: async (fn) => fn(db),
  };

  return { db, docs, folders, shares, scripts };
}

function bearerHeader(userId: string): Record<string, string> {
  return { Authorization: `Bearer ${signJwt({ sub: userId, role: 'member' }, JWT_KEY, 3600)}` };
}

describe('cloud-docs DocBuilder, Converter, and binary file-update routes', () => {
  let tmpDir: string;
  let storage: LocalCloudDocStorage;
  let memDb: ReturnType<typeof createDocBuilderTestDb>;
  let appServer: http.Server;
  let ooServer: http.Server;
  let appBaseUrl: string;
  let ooBaseUrl: string;
  let env: Env;
  let app: ReturnType<typeof buildApp>;

  let lastScriptDownloaded = '';
  let lastDocbuilderArg: Record<string, unknown> | undefined;
  let lastInputFileDownloaded: Buffer | null = null;
  let ooDownloadFiles = new Map<string, Buffer>();
  let ooOutputsOverride: Record<string, Buffer> | null = null;

  beforeEach(async () => {
    clearEphemeralDocBuilderScriptsForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imcodes-cdoc-db-test-'));
    storage = new LocalCloudDocStorage(tmpDir);
    memDb = createDocBuilderTestDb();
    ooDownloadFiles = new Map();
    ooOutputsOverride = null;
    lastScriptDownloaded = '';
    lastDocbuilderArg = undefined;
    lastInputFileDownloaded = null;

    ooServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        (async () => {
          if (req.method === 'POST' && req.url === '/docbuilder') {
            const body = JSON.parse(rawBody) as { url?: string; argument?: Record<string, unknown>; token?: string };
            const bearer = req.headers.authorization?.replace(/^Bearer\s+/, '') ?? '';
            expect(verifyJwt(bearer, OO_SECRET)).toBeTruthy();
            expect(verifyJwt(String(body.token ?? ''), OO_SECRET)).toBeTruthy();

            // Fetch script from live Hono app endpoint!
            const scriptRes = await fetch(String(body.url));
            expect(scriptRes.status).toBe(200);
            expect(scriptRes.headers.get('cache-control')).toBe('no-store');
            lastScriptDownloaded = await scriptRes.text();
            lastDocbuilderArg = body.argument;

            // Second fetch of single-use script must return 404
            const secondFetch = await fetch(String(body.url));
            expect(secondFetch.status).toBe(404);

            // If argument.inputUrl is provided, download input document from Hono app
            if (body.argument && typeof body.argument.inputUrl === 'string') {
              const inputRes = await fetch(body.argument.inputUrl);
              expect(inputRes.status).toBe(200);
              lastInputFileDownloaded = Buffer.from(await inputRes.arrayBuffer());
            }

            const urls: Record<string, string> = {};
            if (ooOutputsOverride) {
              for (const [name, buf] of Object.entries(ooOutputsOverride)) {
                ooDownloadFiles.set(`/cache/files/${name}`, buf);
                urls[name] = `https://public.example.com/onlyoffice/cache/files/${name}`;
              }
            } else {
              const outKey = 'generated.docx';
              const produced = Buffer.from(
                `PK\x03\x04OO:${lastScriptDownloaded}|ARG:${JSON.stringify(lastDocbuilderArg ?? {})}|IN:${lastInputFileDownloaded?.toString('utf8') ?? ''}`,
              );
              ooDownloadFiles.set('/cache/files/generated.docx', produced);
              urls[outKey] = `https://public.example.com/onlyoffice/cache/files/generated.docx`;
            }

            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                error: 0,
                end: true,
                urls,
              }),
            );
            return;
          }

          if (req.method === 'POST' && req.url === '/ConvertService.ashx') {
            const body = JSON.parse(rawBody) as { url?: string; outputtype?: string; token?: string };
            expect(verifyJwt(String(body.token ?? ''), OO_SECRET)).toBeTruthy();
            const srcRes = await fetch(String(body.url));
            expect(srcRes.status).toBe(200);
            const srcBytes = Buffer.from(await srcRes.arrayBuffer());

            const outExt = String(body.outputtype || 'pdf');
            ooDownloadFiles.set(
              `/cache/conv/out.${outExt}`,
              Buffer.from(`CONVERTED(${outExt}):${srcBytes.toString('utf8')}`),
            );
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                endConvert: true,
                percent: 100,
                fileType: outExt,
                fileUrl: `${ooBaseUrl}/cache/conv/out.${outExt}`,
              }),
            );
            return;
          }

          if (req.method === 'GET' && req.url && ooDownloadFiles.has(req.url)) {
            res.statusCode = 200;
            res.end(ooDownloadFiles.get(req.url));
            return;
          }

          res.statusCode = 404;
          res.end('not_found');
        })().catch((err) => {
          res.statusCode = 500;
          res.end(String(err));
        });
      });
    });

    await new Promise<void>((resolve) => ooServer.listen(0, '127.0.0.1', () => resolve()));
    const ooAddr = ooServer.address() as { port: number };
    ooBaseUrl = `http://127.0.0.1:${ooAddr.port}`;

    appServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers.set(k, v);
        }
        const request = new Request(`${appBaseUrl}${req.url}`, {
          method: req.method,
          headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
        });
        Promise.resolve(app.fetch(request))
          .then(async (response) => {
            res.statusCode = response.status;
            response.headers.forEach((v, k) => res.setHeader(k, v));
            const buf = Buffer.from(await response.arrayBuffer());
            res.end(buf);
          })
          .catch((err) => {
            res.statusCode = 500;
            res.end(String(err));
          });
      });
    });

    await new Promise<void>((resolve) => appServer.listen(0, '127.0.0.1', () => resolve()));
    const appAddr = appServer.address() as { port: number };
    appBaseUrl = `http://127.0.0.1:${appAddr.port}`;

    env = {
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SIGNING_KEY: JWT_KEY,
      BOT_ENCRYPTION_KEY: 'b'.repeat(32),
      SERVER_URL: appBaseUrl,
      ONLYOFFICE_ENABLED: 'true',
      ONLYOFFICE_INTERNAL_URL: ooBaseUrl,
      ONLYOFFICE_PUBLIC_URL: 'https://public.example.com/onlyoffice',
      ONLYOFFICE_JWT_SECRET: OO_SECRET,
      DB: memDb.db,
    };

    app = buildApp(env, { cloudDocStorage: storage });
  });

  afterEach(async () => {
    clearEphemeralDocBuilderScriptsForTests();
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await new Promise<void>((resolve) => ooServer.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a document via POST /api/cloud-docs/docbuilder and enforces folder ACL & ONLYOFFICE disabled errors', async () => {
    const createRes = await app.request('/api/cloud-docs/docbuilder', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'docx',
        name: 'SalesProposal',
        script: 'builder.CreateFile("docx"); builder.SaveFile("docx", "generated.docx");',
        argument: { customer: 'Acme Corp' },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      doc: { id: string; name: string; ext: string; docVersion: number };
      bytesWritten: number;
      onlyofficeUrls?: Record<string, string>;
    };
    expect(created.doc.name).toBe('SalesProposal.docx');
    expect(created.doc.docVersion).toBe(1);
    expect(created.bytesWritten).toBeGreaterThan(0);
    expect(created.onlyofficeUrls?.['generated.docx']).toContain('/cache/files/generated.docx');
    expect(lastDocbuilderArg).toEqual({ customer: 'Acme Corp' });

    // Folder ACL: Bob has viewer share on folder -> 403
    const fldRes = await app.request('/api/cloud-docs/folders', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'SharedFolder' }),
    });
    const { folder } = (await fldRes.json()) as { folder: { id: string } };
    await app.request('/api/cloud-docs/shares', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'folder',
        targetId: folder.id,
        shareMode: 'user',
        targetUserId: 'user-bob',
        role: 'viewer',
      }),
    });

    const deniedRes = await app.request('/api/cloud-docs/docbuilder', {
      method: 'POST',
      headers: { ...bearerHeader('user-bob'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'docx',
        folderId: folder.id,
        script: 'builder.CreateFile("docx");',
      }),
    });
    expect(deniedRes.status).toBe(403);

    // Disabled ONLYOFFICE returns explicit 503 onlyoffice_disabled
    env.ONLYOFFICE_ENABLED = 'false';
    const disabledRes = await app.request('/api/cloud-docs/docbuilder', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'docx', script: 'builder.CreateFile("docx");' }),
    });
    expect(disabledRes.status).toBe(503);
    expect((await disabledRes.json()).error).toBe(CLOUD_DOC_ERROR_CODES.ONLYOFFICE_DISABLED);
  });

  it('validates /onlyoffice/script/:token JWT header and single-use behavior', async () => {
    const badTokRes = await app.request('/api/cloud-docs/onlyoffice/script/not-a-valid-token');
    expect(badTokRes.status).toBe(401);

    const store = createDbDocBuilderScriptStore(memDb.db);
    const sid = await store.put('console.log(1);', 60_000);
    const tok = signDocBuilderScriptToken(sid, JWT_KEY, 60);

    const badJwtRes = await app.request(`/api/cloud-docs/onlyoffice/script/${tok}`, {
      headers: { Authorization: 'Bearer invalid-oo-jwt' },
    });
    expect(badJwtRes.status).toBe(401);

    const okRes = await app.request(`/api/cloud-docs/onlyoffice/script/${tok}`, {
      headers: { Authorization: `Bearer ${signJwt({ test: true }, OO_SECRET, 60)}` },
    });
    expect(okRes.status).toBe(200);
    expect(await okRes.text()).toBe('console.log(1);');

    const replayRes = await app.request(`/api/cloud-docs/onlyoffice/script/${tok}`);
    expect(replayRes.status).toBe(404);
  });

  it('edits and exports existing doc via POST /api/cloud-docs/:id/docbuilder with CAS, ACL, save=false, and {{INPUT_URL}}', async () => {
    const createRes = await app.request('/api/cloud-docs/blank', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'docx', name: 'Contract.docx', content: 'Initial v1' }),
    });
    const { doc } = (await createRes.json()) as { doc: { id: string; docVersion: number } };
    const v1Key = memDb.docs.get(doc.id)!.storage_key;

    // Share as viewer to Bob, editor to Carol? Let's test Bob=viewer (403)
    await app.request('/api/cloud-docs/shares', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'doc',
        targetId: doc.id,
        shareMode: 'user',
        targetUserId: 'user-bob',
        role: 'viewer',
      }),
    });

    const viewerRes = await app.request(`/api/cloud-docs/${doc.id}/docbuilder`, {
      method: 'POST',
      headers: { ...bearerHeader('user-bob'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: 'builder.OpenFile(Argument.inputUrl);' }),
    });
    expect(viewerRes.status).toBe(403);

    // save=false does not mutate DB version
    const exportRes = await app.request(`/api/cloud-docs/${doc.id}/docbuilder`, {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        save: false,
        script: 'builder.OpenFile("{{INPUT_URL}}");',
        argument: { mode: 'extract' },
      }),
    });
    expect(exportRes.status).toBe(200);
    const exported = (await exportRes.json()) as {
      doc: { docVersion: number };
      bytesBase64: string;
      outputName: string;
      mimeType: string;
      bytesWritten: number;
    };
    expect(exported.doc.docVersion).toBe(1);
    expect(exported.bytesWritten).toBeGreaterThan(0);
    expect(Buffer.from(exported.bytesBase64, 'base64').toString('utf8')).toContain('/api/cloud-docs/onlyoffice/file/');
    expect(lastScriptDownloaded).not.toContain('{{INPUT_URL}}');
    expect(lastDocbuilderArg?.inputUrl).toContain('/api/cloud-docs/onlyoffice/file/');
    expect(lastDocbuilderArg?._imcodesInputUrl).toBe(lastDocbuilderArg?.inputUrl);

    // save=true with CAS expectedVersion=1 succeeds and bumps to v2, cleaning up v1 blob
    const updateRes = await app.request(`/api/cloud-docs/${doc.id}/docbuilder`, {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 1,
        script: 'builder.OpenFile(Argument.inputUrl); builder.SaveFile("docx", "generated.docx");',
      }),
    });
    expect(updateRes.status).toBe(200);
    expect(lastScriptDownloaded).toBe(
      `builder.OpenFile(${JSON.stringify(lastDocbuilderArg?.inputUrl)});\nbuilder.SaveFile("docx", "generated.docx");`,
    );
    const updated = (await updateRes.json()) as { doc: { docVersion: number }; role: string; bytesWritten: number };
    expect(updated.doc.docVersion).toBe(2);
    expect(updated.role).toBe('owner');
    expect(await storage.exists(v1Key)).toBe(false);

    // Stale CAS expectedVersion=1 -> 409 version_conflict
    const conflictRes = await app.request(`/api/cloud-docs/${doc.id}/docbuilder`, {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 1,
        script: 'builder.OpenFile(Argument.inputUrl);',
      }),
    });
    expect(conflictRes.status).toBe(409);
    expect((await conflictRes.json()).currentVersion).toBe(2);
  });

  it('converts documents via POST /api/cloud-docs/:id/convert (base64 & saveAsNew) and enforces allowDownload', async () => {
    const createRes = await app.request('/api/cloud-docs/blank', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'docx', name: 'SlidesBrief.docx', content: 'Hello Convert' }),
    });
    const { doc } = (await createRes.json()) as { doc: { id: string } };

    // Viewer with allowDownload=false -> 403 download_forbidden
    await app.request('/api/cloud-docs/shares', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'doc',
        targetId: doc.id,
        shareMode: 'user',
        targetUserId: 'user-bob',
        role: 'viewer',
        allowDownload: false,
      }),
    });

    const forbiddenConvert = await app.request(`/api/cloud-docs/${doc.id}/convert`, {
      method: 'POST',
      headers: { ...bearerHeader('user-bob'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType: 'pdf' }),
    });
    expect(forbiddenConvert.status).toBe(403);
    expect((await forbiddenConvert.json()).error).toBe(CLOUD_DOC_ERROR_CODES.DOWNLOAD_FORBIDDEN);

    // Owner converts to pdf base64
    const base64Res = await app.request(`/api/cloud-docs/${doc.id}/convert`, {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType: 'pdf' }),
    });
    expect(base64Res.status).toBe(200);
    const base64Body = (await base64Res.json()) as { fileName: string; mimeType: string; bytesWritten: number; bytesBase64: string };
    expect(base64Body.fileName).toBe('SlidesBrief.pdf');
    expect(base64Body.mimeType).toBe('application/pdf');
    expect(Buffer.from(base64Body.bytesBase64, 'base64').toString('utf8')).toContain('CONVERTED(pdf):');

    // Owner converts with saveAsNew: true -> 201 new doc
    const saveNewRes = await app.request(`/api/cloud-docs/${doc.id}/convert`, {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType: 'pdf', saveAsNew: true, name: 'ExportedBrief.pdf' }),
    });
    expect(saveNewRes.status).toBe(201);
    const savedNew = (await saveNewRes.json()) as { doc: { id: string; name: string; ext: string }; bytesWritten: number };
    expect(savedNew.doc.id).not.toBe(doc.id);
    expect(savedNew.doc.name).toBe('ExportedBrief.pdf');
    expect(savedNew.doc.ext).toBe('.pdf');
    expect(savedNew.bytesWritten).toBeGreaterThan(0);
  });

  it('replaces document bytes in-place via PUT /api/cloud-docs/:id/file with CAS, ACL, and upload bounds', async () => {
    const createRes = await app.request('/api/cloud-docs/blank', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'docx', name: 'RawBinary.docx' }),
    });
    const { doc } = (await createRes.json()) as { doc: { id: string } };
    const v1Key = memDb.docs.get(doc.id)!.storage_key;

    await app.request('/api/cloud-docs/shares', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'doc',
        targetId: doc.id,
        shareMode: 'user',
        targetUserId: 'user-bob',
        role: 'viewer',
      }),
    });

    const viewerForm = new FormData();
    viewerForm.append('file', new File([Buffer.from('PK\x03\x04hacked')], 'RawBinary.docx'));
    const viewerRes = await app.request(`/api/cloud-docs/${doc.id}/file`, {
      method: 'PUT',
      headers: bearerHeader('user-bob'),
      body: viewerForm,
    });
    expect(viewerRes.status).toBe(403);

    const okForm = new FormData();
    const nextPayload = Buffer.from('PK\x03\x04new-raw-binary-docx-payload');
    okForm.append('file', new File([nextPayload], 'UpdatedName.docx'));
    okForm.append('expectedVersion', '1');
    okForm.append('name', 'UpdatedName.docx');
    const okRes = await app.request(`/api/cloud-docs/${doc.id}/file`, {
      method: 'PUT',
      headers: bearerHeader('owner-1'),
      body: okForm,
    });
    expect(okRes.status).toBe(200);
    const updated = (await okRes.json()) as { ok: boolean; doc: { name: string; docVersion: number }; bytesWritten: number };
    expect(updated.ok).toBe(true);
    expect(updated.doc.docVersion).toBe(2);
    expect(updated.doc.name).toBe('UpdatedName.docx');
    expect(updated.bytesWritten).toBe(nextPayload.length);
    expect(await storage.exists(v1Key)).toBe(false);
    expect((await storage.read(memDb.docs.get(doc.id)!.storage_key)).equals(nextPayload)).toBe(true);

    // Stale CAS expectedVersion=1 -> 409
    const staleForm = new FormData();
    staleForm.append('file', new File([Buffer.from('PK\x03\x04stale')], 'UpdatedName.docx'));
    staleForm.append('expectedVersion', '1');
    const staleRes = await app.request(`/api/cloud-docs/${doc.id}/file`, {
      method: 'PUT',
      headers: bearerHeader('owner-1'),
      body: staleForm,
    });
    expect(staleRes.status).toBe(409);

    // Oversized Content-Length upload -> 413
    const tooBigRes = await app.request(`/api/cloud-docs/${doc.id}/file`, {
      method: 'PUT',
      headers: {
        ...bearerHeader('owner-1'),
        'Content-Type': 'multipart/form-data; boundary=----b',
        'Content-Length': String(CLOUD_DOCS_MAX_UPLOAD_BYTES + 2 * 1024 * 1024),
      },
      body: 'ignored',
    });
    expect(tooBigRes.status).toBe(413);
  });

  it('supports optional engine=docbuilder on POST /blank and PUT /:id/content', async () => {
    const blankRes = await app.request('/api/cloud-docs/blank', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'docx',
        name: 'EngineBlank.docx',
        engine: 'docbuilder',
        docbuilderScript: 'builder.CreateFile("docx");',
        content: 'From blank',
      }),
    });
    expect(blankRes.status).toBe(201);
    const { doc } = (await blankRes.json()) as { doc: { id: string; docVersion: number } };
    expect(lastDocbuilderArg?.content).toBe('From blank');

    const editRes = await app.request(`/api/cloud-docs/${doc.id}/content`, {
      method: 'PUT',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engine: 'docbuilder',
        docbuilderScript: 'builder.OpenFile(Argument.inputUrl);',
        expectedVersion: 1,
      }),
    });
    expect(editRes.status).toBe(200);
    expect((await editRes.json()).doc.docVersion).toBe(2);
  });

  it('admits FULL daemon token and denies CONTROLLED daemon token on all new cloud-docs routes', async () => {
    const fullHeaders = {
      [SERVER_ID_HEADER]: 'srv-full',
      Authorization: 'Bearer full-secret',
    };
    const ctrlHeaders = {
      [SERVER_ID_HEADER]: 'srv-ctrl',
      Authorization: 'Bearer ctrl-secret',
    };

    // FULL can create via /docbuilder
    const fullCreate = await app.request('/api/cloud-docs/docbuilder', {
      method: 'POST',
      headers: { ...fullHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'docx', script: 'builder.CreateFile("docx");' }),
    });
    expect(fullCreate.status).toBe(201);
    const { doc } = (await fullCreate.json()) as { doc: { id: string } };

    // FULL can edit via /:id/docbuilder, convert via /:id/convert, and update via /:id/file
    const fullEdit = await app.request(`/api/cloud-docs/${doc.id}/docbuilder`, {
      method: 'POST',
      headers: { ...fullHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: 'builder.OpenFile(Argument.inputUrl);' }),
    });
    expect(fullEdit.status).toBe(200);

    const fullConvert = await app.request(`/api/cloud-docs/${doc.id}/convert`, {
      method: 'POST',
      headers: { ...fullHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType: 'pdf' }),
    });
    expect(fullConvert.status).toBe(200);

    const fullFileForm = new FormData();
    fullFileForm.append('file', new File([Buffer.from('PK\x03\x04daemon-put')], 'Daemon.docx'));
    const fullFile = await app.request(`/api/cloud-docs/${doc.id}/file`, {
      method: 'PUT',
      headers: fullHeaders,
      body: fullFileForm,
    });
    expect(fullFile.status).toBe(200);

    // CONTROLLED is denied (403) on every route
    expect(
      (
        await app.request('/api/cloud-docs/docbuilder', {
          method: 'POST',
          headers: { ...ctrlHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'docx', script: 'builder.CreateFile("docx");' }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`/api/cloud-docs/${doc.id}/docbuilder`, {
          method: 'POST',
          headers: { ...ctrlHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ script: 'x' }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`/api/cloud-docs/${doc.id}/convert`, {
          method: 'POST',
          headers: { ...ctrlHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetType: 'pdf' }),
        })
      ).status,
    ).toBe(403);
    const ctrlForm = new FormData();
    ctrlForm.append('file', new File([Buffer.from('x')], 'x.docx'));
    expect(
      (
        await app.request(`/api/cloud-docs/${doc.id}/file`, {
          method: 'PUT',
          headers: ctrlHeaders,
          body: ctrlForm,
        })
      ).status,
    ).toBe(403);
  });

  it('F1: rejects wrong-format or missing outputName across create, edit, /blank, and /:id/content without corrupting storage/DB', async () => {
    // 1. POST /docbuilder requesting type=pdf when ONLYOFFICE produces generated.docx -> 422, no doc created
    const initialDocsCount = memDb.docs.size;
    const createMismatch = await app.request('/api/cloud-docs/docbuilder', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'pdf', name: 'Bad.pdf', script: 'builder.CreateFile("docx");' }),
    });
    expect(createMismatch.status).toBe(422);
    expect((await createMismatch.json()).error).toBe(CLOUD_DOC_ERROR_CODES.DOCBUILDER_OUTPUT_MISMATCH);
    expect(memDb.docs.size).toBe(initialDocsCount);

    // 2. POST /blank with engine=docbuilder type=xlsx when ONLYOFFICE produces generated.docx -> 422, no doc created
    const blankMismatch = await app.request('/api/cloud-docs/blank', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'xlsx',
        name: 'Sheet.xlsx',
        engine: 'docbuilder',
        docbuilderScript: 'builder.CreateFile("docx");',
      }),
    });
    expect(blankMismatch.status).toBe(422);
    expect((await blankMismatch.json()).error).toBe(CLOUD_DOC_ERROR_CODES.DOCBUILDER_OUTPUT_MISMATCH);
    expect(memDb.docs.size).toBe(initialDocsCount);

    // 3. Edit existing .docx doc with outputType=pdf -> 422, v1 bytes and docVersion untouched
    const seedRes = await app.request('/api/cloud-docs/blank', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'docx', name: 'Seed.docx', content: 'Seed v1' }),
    });
    const { doc: seedDoc } = (await seedRes.json()) as { doc: { id: string; docVersion: number } };
    const origKey = memDb.docs.get(seedDoc.id)!.storage_key;
    const origBytes = await storage.read(origKey);

    const editMismatch = await app.request(`/api/cloud-docs/${seedDoc.id}/docbuilder`, {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outputType: 'pdf',
        expectedVersion: 1,
        script: 'builder.OpenFile(Argument.inputUrl); builder.SaveFile("docx", "generated.docx");',
      }),
    });
    expect(editMismatch.status).toBe(422);
    expect((await editMismatch.json()).error).toBe(CLOUD_DOC_ERROR_CODES.DOCBUILDER_OUTPUT_MISMATCH);
    expect(Number(memDb.docs.get(seedDoc.id)!.doc_version)).toBe(1);
    expect((await storage.read(origKey)).equals(origBytes)).toBe(true);

    // 4. PUT /:id/content engine=docbuilder on .docx when ONLYOFFICE returns .pdf -> 422, v1 untouched
    ooOutputsOverride = { 'wrong.pdf': Buffer.from('%PDF-wrong') };
    const contentMismatch = await app.request(`/api/cloud-docs/${seedDoc.id}/content`, {
      method: 'PUT',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'replace',
        engine: 'docbuilder',
        docbuilderScript: 'builder.SaveFile("pdf", "wrong.pdf");',
      }),
    });
    expect(contentMismatch.status).toBe(422);
    expect((await contentMismatch.json()).error).toBe(CLOUD_DOC_ERROR_CODES.DOCBUILDER_OUTPUT_MISMATCH);
    expect(Number(memDb.docs.get(seedDoc.id)!.doc_version)).toBe(1);
    expect((await storage.read(origKey)).equals(origBytes)).toBe(true);

    // 5. outputName miss -> 422; multi-output positive picks matching ext & save=false unconstrained works
    ooOutputsOverride = {
      'alpha.docx': Buffer.from('PK\x03\x04alpha-docx'),
      'beta.pdf': Buffer.from('%PDF-beta'),
    };
    const missOutName = await app.request('/api/cloud-docs/docbuilder', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputName: 'missing.pdf', script: 'x' }),
    });
    expect(missOutName.status).toBe(422);
    expect((await missOutName.json()).error).toBe(CLOUD_DOC_ERROR_CODES.DOCBUILDER_OUTPUT_MISMATCH);

    const multiPdf = await app.request('/api/cloud-docs/docbuilder', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'pdf', name: 'Final.pdf', script: 'x' }),
    });
    expect(multiPdf.status).toBe(201);
    const createdPdf = (await multiPdf.json()) as { doc: { id: string; ext: string } };
    expect(createdPdf.doc.ext).toBe('.pdf');
    expect((await storage.read(memDb.docs.get(createdPdf.doc.id)!.storage_key)).equals(Buffer.from('%PDF-beta'))).toBe(true);

    const unconstrainedExport = await app.request(`/api/cloud-docs/${seedDoc.id}/docbuilder`, {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ save: false, script: 'x' }),
    });
    expect(unconstrainedExport.status).toBe(200);
    const exportedJson = (await unconstrainedExport.json()) as { outputName: string; bytesBase64: string };
    expect(exportedJson.outputName).toBe('alpha.docx');
    expect(Buffer.from(exportedJson.bytesBase64, 'base64').toString('utf8')).toBe('PK\x03\x04alpha-docx');
  });

  it('F2: ignores local CLI binary completely and fails closed with onlyoffice_disabled when ONLYOFFICE_ENABLED is false', async () => {
    const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imcodes-f2-sentinel-'));
    const sentinelFile = path.join(sentinelDir, 'sentinel.txt');
    const evilBin = path.join(sentinelDir, 'evil-docbuilder.sh');
    fs.writeFileSync(sentinelFile, 'untouched-sentinel', 'utf8');
    fs.writeFileSync(evilBin, `#!/bin/sh\necho PWNED > "${sentinelFile}"\n`, { mode: 0o755 });

    const prevEnabled = env.ONLYOFFICE_ENABLED;
    const prevProcessBin = process.env.ONLYOFFICE_DOCBUILDER_BIN;
    env.ONLYOFFICE_ENABLED = 'false';
    process.env.ONLYOFFICE_DOCBUILDER_BIN = evilBin;

    try {
      const beforeDocs = memDb.docs.size;
      const res = await app.request('/api/cloud-docs/docbuilder', {
        method: 'POST',
        headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'docx',
          script: `builderJS.CreateFile('docx'); builderJS.SaveFile('txt', ${JSON.stringify(sentinelFile)});`,
        }),
      });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe(CLOUD_DOC_ERROR_CODES.ONLYOFFICE_DISABLED);
      expect(fs.readFileSync(sentinelFile, 'utf8')).toBe('untouched-sentinel');
      expect(memDb.docs.size).toBe(beforeDocs);
    } finally {
      env.ONLYOFFICE_ENABLED = prevEnabled;
      if (prevProcessBin === undefined) {
        delete process.env.ONLYOFFICE_DOCBUILDER_BIN;
      } else {
        process.env.ONLYOFFICE_DOCBUILDER_BIN = prevProcessBin;
      }
      fs.rmSync(sentinelDir, { recursive: true, force: true });
    }
  });

  it('F3: serves script callbacks across independent server replicas using shared DB backing store', async () => {
    // Replica B runs as an independent HTTP server pointing to the same shared DB/storage,
    // and SERVER_URL routes ONLYOFFICE script callbacks strictly to Replica B (never Replica A).
    const appReplicaB = buildApp(env, { cloudDocStorage: storage });
    const replicaBServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
      }
      Promise.resolve(
        appReplicaB.request(url.pathname + url.search, {
          method: req.method,
          headers,
        }),
      )
        .then(async (r) => {
          res.statusCode = r.status;
          r.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await r.arrayBuffer()));
        })
        .catch((err) => {
          res.statusCode = 500;
          res.end(String(err));
        });
    });

    await new Promise<void>((resolve) => replicaBServer.listen(0, '127.0.0.1', () => resolve()));
    const replicaBAddr = replicaBServer.address() as { port: number };
    const replicaBUrl = `http://127.0.0.1:${replicaBAddr.port}`;

    // Also add an already-expired entry into shared DB to verify pruning on store
    const store = createDbDocBuilderScriptStore(memDb.db);
    await memDb.db.execute(
      `INSERT INTO onlyoffice_docbuilder_scripts (id, script, expires_at, created_at)
       VALUES ($1, $2, $3, $4)`,
      ['expired_seed', 'old();', Date.now() - 10_000, Date.now() - 20_000],
    );
    expect(await store.consume('expired_seed')).toBeNull();

    // Direct round-robin check: seeded on store -> HEAD on Replica A -> GET on Replica B -> replay GET on Replica A fails 404
    const rrId = await store.put('console.log("rr");', 60_000);
    const rrTok = signDocBuilderScriptToken(rrId, JWT_KEY, 60);
    expect((await app.request(`/api/cloud-docs/onlyoffice/script/${rrTok}`, { method: 'HEAD' })).status).toBe(200);
    const rrGetB = await fetch(`${replicaBUrl}/api/cloud-docs/onlyoffice/script/${rrTok}`);
    expect(rrGetB.status).toBe(200);
    expect(await rrGetB.text()).toBe('console.log("rr");');
    expect((await app.request(`/api/cloud-docs/onlyoffice/script/${rrTok}`)).status).toBe(404);

    const prevServerUrl = env.SERVER_URL;
    env.SERVER_URL = replicaBUrl;
    try {
      // Request submitted to Replica A (`app`), while ONLYOFFICE fetches script from Replica B (`replicaBUrl`)!
      const createRes = await app.request('/api/cloud-docs/docbuilder', {
        method: 'POST',
        headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'docx',
          name: 'CrossReplica.docx',
          script: 'builder.CreateFile("docx"); // from replica A to replica B',
        }),
      });
      expect(createRes.status).toBe(201);
      expect(lastScriptDownloaded).toContain('// from replica A to replica B');
      // After completion/consumption, no orphan scripts remain in shared DB
      expect(memDb.scripts.size).toBe(0);
    } finally {
      env.SERVER_URL = prevServerUrl;
      await new Promise<void>((resolve, reject) => replicaBServer.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it('prepareOnlyOfficeDocBuilderScript normalizes Argument inputUrl variants, {{INPUT_URL}}, standalone builder lines, and preserves strings/comments', () => {
    const sampleUrl = `https://docs.example.test/file?tok=a'b"c&x=1\`$y`;

    // 1. All 4 Argument.* inputUrl expressions (with spaces and optional semicolon) rewrite to JSON string literals
    expect(prepareOnlyOfficeDocBuilderScript('builder.OpenFile(Argument.inputUrl);', { inputUrl: sampleUrl }))
      .toBe(`builder.OpenFile(${JSON.stringify(sampleUrl)});`);
    expect(prepareOnlyOfficeDocBuilderScript('builder.OpenFile( Argument._imcodesInputUrl )', { inputUrl: sampleUrl }))
      .toBe(`builder.OpenFile(${JSON.stringify(sampleUrl)})`);
    expect(prepareOnlyOfficeDocBuilderScript("builder.OpenFile(Argument['inputUrl']);", { inputUrl: sampleUrl }))
      .toBe(`builder.OpenFile(${JSON.stringify(sampleUrl)});`);
    expect(prepareOnlyOfficeDocBuilderScript('builder.OpenFile( Argument[ "inputUrl" ] );', { inputUrl: sampleUrl }))
      .toBe(`builder.OpenFile(${JSON.stringify(sampleUrl)});`);

    // 2. Quote-safe {{INPUT_URL}} substitution across ", ', and ` literals (never inside comments)
    const placeholderScript = [
      '// {{INPUT_URL}} in line comment',
      '/* {{INPUT_URL}} in block comment */',
      'builder.OpenFile("{{INPUT_URL}}");',
      "var single = '{{INPUT_URL}}';",
      'var tpl = `prefix-{{INPUT_URL}}-${`nested-{{INPUT_URL}}`}`;',
    ].join('\n');
    const preparedPlaceholder = prepareOnlyOfficeDocBuilderScript(placeholderScript, { inputUrl: sampleUrl });
    expect(preparedPlaceholder).toContain('// {{INPUT_URL}} in line comment');
    expect(preparedPlaceholder).toContain('/* {{INPUT_URL}} in block comment */');
    expect(preparedPlaceholder).toContain(`builder.OpenFile(${JSON.stringify(sampleUrl)});`);
    expect(preparedPlaceholder).toContain(`var single = 'https://docs.example.test/file?tok=a\\'b"c&x=1\`$y';`);
    expect(preparedPlaceholder).toContain('var tpl = `prefix-https://docs.example.test/file?tok=a\'b"c&x=1\\`\\$y-${`nested-https://docs.example.test/file?tok=a\'b"c&x=1\\`\\$y`}`;');

    // 3. Single-line chained script splitting across all 4 builder file methods and nested parens
    const oneLiner =
      'builder.CreateFile("docx"); var oDoc = Api.GetDocument(); oDoc.Push(Api.CreateParagraph()); builder.SaveFile("docx", fmtName("a(1)", \')\')); builder.CloseFile();';
    expect(prepareOnlyOfficeDocBuilderScript(oneLiner)).toBe([
      'builder.CreateFile("docx");',
      'var oDoc = Api.GetDocument(); oDoc.Push(Api.CreateParagraph());',
      'builder.SaveFile("docx", fmtName("a(1)", \')\'));',
      'builder.CloseFile();',
    ].join('\n'));

    // 4. Strings, comments, and non-builder identifiers stay intact
    const guardedScript = [
      'var s = "builder.OpenFile(Argument.inputUrl); builder.SaveFile(\\"docx\\", \\"x.docx\\");";',
      '// builder.OpenFile(Argument.inputUrl); var keep = 1;',
      '/* builder.SaveFile("docx", "c.docx"); var keep2 = 2; */',
      'mybuilder.OpenFile(Argument.inputUrl); foo.builder.SaveFile("docx", "x.docx"); builder.OpenFileAsync(Argument.inputUrl);',
    ].join('\n');
    expect(prepareOnlyOfficeDocBuilderScript(guardedScript, { inputUrl: sampleUrl })).toBe(guardedScript);

    // 5. Idempotency and preserved indentation on well-formed multi-line scripts
    const multiline = [
      '  builder.OpenFile(Argument.inputUrl);',
      '  var oDoc = Api.GetDocument();',
      '  builder.SaveFile("docx", "edited.docx");',
      '  builder.CloseFile();',
    ].join('\n');
    const once = prepareOnlyOfficeDocBuilderScript(multiline, { inputUrl: sampleUrl });
    expect(once).toBe([
      `  builder.OpenFile(${JSON.stringify(sampleUrl)});`,
      '  var oDoc = Api.GetDocument();',
      '  builder.SaveFile("docx", "edited.docx");',
      '  builder.CloseFile();',
    ].join('\n'));
    expect(prepareOnlyOfficeDocBuilderScript(once, { inputUrl: sampleUrl })).toBe(once);

    // 6. Regex literals containing quotes/slashes/parens/braces do not desync string, arg, template, or builder detection
    const regexWithQuoteAndString = [
      'var re = /"/g;',
      'var text = "builder.CloseFile()";',
      'builder.CreateFile("docx");',
      'builder.SaveFile("docx", "out.docx");',
      'builder.CloseFile();',
    ].join('\n');
    expect(prepareOnlyOfficeDocBuilderScript(regexWithQuoteAndString)).toBe(regexWithQuoteAndString);
    expect(() => new Function('builder', 'Api', regexWithQuoteAndString)).not.toThrow();

    const regexBeforeOpenFile = [
      'var quotePattern = /"/g;',
      'builder.OpenFile(Argument.inputUrl);',
    ].join('\n');
    expect(prepareOnlyOfficeDocBuilderScript(regexBeforeOpenFile, { inputUrl: sampleUrl })).toBe([
      'var quotePattern = /"/g;',
      `builder.OpenFile(${JSON.stringify(sampleUrl)});`,
    ].join('\n'));

    // Regex inside template interpolation, inside char class, inside SaveFile args, and after division expressions
    const divisionAndRegex = [
      'var ratio = a / b / c;',
      'var half = (w + h) / 2;',
      'var charClassRe = /[/"\'`]/gi;',
      'var tplWithRe = `${/"/g}-${/}/g}-{{INPUT_URL}}`;',
      'builder.OpenFile(Argument.inputUrl); builder.SaveFile("docx", `${/[a)b]/.source}`.replace(/"/g, "x") + "{{INPUT_URL}}");',
    ].join('\n');
    const preparedDivisionAndRegex = prepareOnlyOfficeDocBuilderScript(divisionAndRegex, { inputUrl: sampleUrl });
    expect(preparedDivisionAndRegex).toBe([
      'var ratio = a / b / c;',
      'var half = (w + h) / 2;',
      'var charClassRe = /[/"\'`]/gi;',
      'var tplWithRe = `${/"/g}-${/}/g}-https://docs.example.test/file?tok=a\'b"c&x=1\\`\\$y`;',
      `builder.OpenFile(${JSON.stringify(sampleUrl)});`,
      'builder.SaveFile("docx", `${/[a)b]/.source}`.replace(/"/g, "x") + "https://docs.example.test/file?tok=a\'b\\"c&x=1`$y");',
    ].join('\n'));
    expect(() => new Function('builder', 'Api', 'a', 'b', 'c', 'w', 'h', preparedDivisionAndRegex)).not.toThrow();

    // 7. Regex statements immediately following control-statement closing `)` (`if`/`while`/`for`/`with`/`else`/block `}`)
    const controlHeaderRegexAndString = [
      'if (enabled) /"/g.test(text);',
      'var text = "builder.CloseFile()";',
      'builder.CloseFile();',
    ].join('\n');
    expect(prepareOnlyOfficeDocBuilderScript(controlHeaderRegexAndString)).toBe(controlHeaderRegexAndString);
    expect(() => new Function('enabled', 'text', 'builder', controlHeaderRegexAndString)).not.toThrow();

    const controlHeaderBeforeOpenFile = [
      'if (enabled) /"/g.test(text);',
      'builder.OpenFile(Argument.inputUrl);',
    ].join('\n');
    const preparedControlOpen = prepareOnlyOfficeDocBuilderScript(controlHeaderBeforeOpenFile, {
      inputUrl: sampleUrl,
    });
    expect(preparedControlOpen).toBe([
      'if (enabled) /"/g.test(text);',
      `builder.OpenFile(${JSON.stringify(sampleUrl)});`,
    ].join('\n'));
    expect(() => new Function('enabled', 'text', 'builder', preparedControlOpen)).not.toThrow();

    const nestedAndBlockControls = [
      'while ((w + h) / 2 > 0) /"/g.test(text);',
      'for (var k = 0; k < 1; k++) /"/g.test(text);',
      'if (enabled) { fn() / 2; } /"/g.test(text);',
      'var ratioDiv = (w + h) / 2 + fn() / 2;',
      'var t = `${(() => { if (enabled) /"/g.test(text); return /}/g.source; })()}-{{INPUT_URL}}`;',
      'builder.OpenFile(Argument.inputUrl); builder.SaveFile("docx", (() => { if (enabled) return /a\\)b/; return /c/; })().source);',
    ].join('\n');
    const preparedNested = prepareOnlyOfficeDocBuilderScript(nestedAndBlockControls, {
      inputUrl: sampleUrl,
    });
    expect(preparedNested).toBe([
      'while ((w + h) / 2 > 0) /"/g.test(text);',
      'for (var k = 0; k < 1; k++) /"/g.test(text);',
      'if (enabled) { fn() / 2; } /"/g.test(text);',
      'var ratioDiv = (w + h) / 2 + fn() / 2;',
      'var t = `${(() => { if (enabled) /"/g.test(text); return /}/g.source; })()}-https://docs.example.test/file?tok=a\'b"c&x=1\\`\\$y`;',
      `builder.OpenFile(${JSON.stringify(sampleUrl)});`,
      'builder.SaveFile("docx", (() => { if (enabled) return /a\\)b/; return /c/; })().source);',
    ].join('\n'));
    expect(() => new Function('enabled', 'text', 'w', 'h', 'fn', 'builder', preparedNested)).not.toThrow();
  });

  it('normalizes single-line chained scripts across create, docbuilder edit, and content docbuilder routes', async () => {
    const createRes = await app.request('/api/cloud-docs/docbuilder', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'docx',
        name: 'OneLineCreate.docx',
        script: 'builder.CreateFile("docx"); var oDoc = Api.GetDocument(); builder.SaveFile("docx", "OneLineCreate.docx"); builder.CloseFile();',
      }),
    });
    expect(createRes.status).toBe(201);
    expect(lastScriptDownloaded).toBe([
      'builder.CreateFile("docx");',
      'var oDoc = Api.GetDocument();',
      'builder.SaveFile("docx", "OneLineCreate.docx");',
      'builder.CloseFile();',
    ].join('\n'));
    const { doc } = (await createRes.json()) as { doc: { id: string } };

    const editContentRes = await app.request(`/api/cloud-docs/${doc.id}/content`, {
      method: 'PUT',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engine: 'docbuilder',
        expectedVersion: 1,
        docbuilderScript: "builder.OpenFile(Argument['inputUrl']); var d = Api.GetDocument(); builder.SaveFile('docx', 'edited.docx'); builder.CloseFile();",
      }),
    });
    expect(editContentRes.status).toBe(200);
    expect(lastScriptDownloaded).toBe([
      `builder.OpenFile(${JSON.stringify(lastDocbuilderArg?.inputUrl)});`,
      'var d = Api.GetDocument();',
      "builder.SaveFile('docx', 'edited.docx');",
      'builder.CloseFile();',
    ].join('\n'));

    const editBuilderRes = await app.request(`/api/cloud-docs/${doc.id}/docbuilder`, {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 2,
        script: 'builder.OpenFile("{{INPUT_URL}}"); var d = Api.GetDocument(); builder.SaveFile("docx", "edited2.docx"); builder.CloseFile();',
      }),
    });
    expect(editBuilderRes.status).toBe(200);
    expect(lastScriptDownloaded).toBe([
      `builder.OpenFile(${JSON.stringify(lastDocbuilderArg?.inputUrl)});`,
      'var d = Api.GetDocument();',
      'builder.SaveFile("docx", "edited2.docx");',
      'builder.CloseFile();',
    ].join('\n'));
  });
});
