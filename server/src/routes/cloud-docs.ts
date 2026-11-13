import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../env.js';
import { authFailureResponse, resolveAuthOutcome } from '../security/authorization.js';
import { sha256Hex, signJwt, verifyJwt } from '../security/crypto.js';
import { resolveUserByIdentifier } from '../db/user-lookup.js';
import { WsBridge } from '../ws/bridge.js';
import {
  buildBlankDocumentBytes,
  getOnlyOfficeDocumentMeta,
  resolveLiveOnlyOfficeAccess,
  resolveOnlyOfficeJwtSecret,
  resolveTrustedOnlyOfficeDownloadUrl,
} from './onlyoffice.js';
import {
  type CloudDocStorage,
  buildCloudDocStorageKey,
} from '../storage/cloud-doc-storage.js';
import {
  commitCloudDocContent,
  createCloudDocFolder,
  deleteCloudDocFolderTree,
  deleteCloudDocRecord,
  deleteRecentDocument,
  getCloudDocById,
  getCloudDocFolderById,
  insertCloudDoc,
  isDefinitelyUncommittedDbError,
  isDescendantFolder,
  listCloudDocFolders,
  listCloudDocSharesForTarget,
  listCloudDocs,
  listRecentDocumentsRaw,
  listSharedCloudItemsForUser,
  listUserTeamsForCloudDocs,
  resolveCloudDocAccess,
  revokeCloudDocShare,
  rowToCloudDocItem,
  rowToRecentDocumentBase,
  touchCloudDocOpened,
  updateCloudDocFolder,
  updateCloudDocMetadata,
  upsertCloudDocShare,
  upsertRecentDocument,
} from '../db/cloud-docs.js';
import {
  CLOUD_DOCS_MAX_UPLOAD_BYTES,
  CLOUD_DOCS_RECENT_DEFAULT_LIMIT,
  type RecentDocumentAccessReason,
  type RecentDocumentItem,
  getCloudDocMeta,
  isBlankCloudDocType,
  normalizeCloudDocFolderName,
  normalizeCloudDocName,
  normalizeRecentFilePath,
} from '../../../shared/cloud-docs.js';

type RouteContext = Context<{ Bindings: Env; Variables: { userId: string; role: string } }>;

export interface CloudDocOnlyOfficeTokenClaims {
  type: 'onlyoffice-cloud-doc';
  cloudDocId: string;
  userId: string;
  actorName: string;
  docVersion: number;
  documentKey: string;
  iat?: number;
  exp?: number;
}

export function computeCloudDocDocumentKey(cloudDocId: string, docVersion: number): string {
  return sha256Hex(`cloud-doc:${cloudDocId}:v${docVersion}`).slice(0, 32);
}

export function signCloudDocOnlyOfficeToken(
  claims: Omit<CloudDocOnlyOfficeTokenClaims, 'type' | 'iat' | 'exp'>,
  signingKey: string,
  ttlSeconds = 4 * 3600,
): string {
  return signJwt(
    {
      ...claims,
      type: 'onlyoffice-cloud-doc',
    },
    signingKey,
    ttlSeconds,
  );
}

export function verifyCloudDocOnlyOfficeToken(
  token: string,
  signingKey: string,
): CloudDocOnlyOfficeTokenClaims | null {
  const payload = verifyJwt(token, signingKey);
  if (!payload || payload.type !== 'onlyoffice-cloud-doc') return null;
  if (
    typeof payload.cloudDocId !== 'string' ||
    typeof payload.userId !== 'string' ||
    typeof payload.actorName !== 'string' ||
    typeof payload.docVersion !== 'number' ||
    typeof payload.documentKey !== 'string'
  ) {
    return null;
  }
  return {
    type: 'onlyoffice-cloud-doc',
    cloudDocId: payload.cloudDocId,
    userId: payload.userId,
    actorName: payload.actorName,
    docVersion: payload.docVersion,
    documentKey: payload.documentKey,
    iat: typeof payload.iat === 'number' ? payload.iat : undefined,
    exp: typeof payload.exp === 'number' ? payload.exp : undefined,
  };
}

export const CLOUD_DOC_DOWNLOAD_TICKET_TTL_SECONDS = 120;

export interface CloudDocDownloadTicketClaims {
  type: 'cloud-doc-download-ticket';
  cloudDocId: string;
  userId: string;
  inline: boolean;
  jti: string;
  iat?: number;
  exp?: number;
}

export function signCloudDocDownloadTicket(
  claims: Omit<CloudDocDownloadTicketClaims, 'type' | 'jti' | 'iat' | 'exp'>,
  signingKey: string,
  ttlSeconds = CLOUD_DOC_DOWNLOAD_TICKET_TTL_SECONDS,
): string {
  return signJwt(
    {
      ...claims,
      type: 'cloud-doc-download-ticket',
      jti: randomUUID(),
    },
    signingKey,
    ttlSeconds,
  );
}

export function verifyCloudDocDownloadTicket(
  token: string,
  signingKey: string,
): CloudDocDownloadTicketClaims | null {
  const payload = verifyJwt(token, signingKey);
  if (!payload || payload.type !== 'cloud-doc-download-ticket') return null;
  if (
    typeof payload.cloudDocId !== 'string' ||
    typeof payload.userId !== 'string' ||
    typeof payload.inline !== 'boolean' ||
    typeof payload.jti !== 'string'
  ) {
    return null;
  }
  return {
    type: 'cloud-doc-download-ticket',
    cloudDocId: payload.cloudDocId,
    userId: payload.userId,
    inline: payload.inline,
    jti: payload.jti,
    iat: typeof payload.iat === 'number' ? payload.iat : undefined,
    exp: typeof payload.exp === 'number' ? payload.exp : undefined,
  };
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('file_too_large');
    this.name = 'PayloadTooLargeError';
  }
}

async function readStreamBytesBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onExceed?: () => void,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        onExceed?.();
        await reader.cancel('payload_too_large').catch(() => {});
        throw new PayloadTooLargeError();
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

async function readResponseBytesBounded(
  res: Response,
  maxBytes: number,
  controller?: AbortController,
): Promise<Buffer> {
  const contentLengthHeader = res.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      controller?.abort('payload_too_large');
      await res.body?.cancel?.('payload_too_large').catch(() => {});
      throw new PayloadTooLargeError();
    }
  }
  if (res.body) {
    return readStreamBytesBounded(res.body, maxBytes, () => controller?.abort('payload_too_large'));
  }
  const arrayBuf = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  if (buf.length > maxBytes) {
    throw new PayloadTooLargeError();
  }
  return buf;
}

const cloudDocCommitLocks = new Map<string, Promise<void>>();
async function lockCloudDocCommit<T>(docId: string, fn: () => Promise<T>): Promise<T> {
  const prev = cloudDocCommitLocks.get(docId) ?? Promise.resolve();
  let releaseNext!: () => void;
  const next = new Promise<void>((resolve) => { releaseNext = resolve; });
  cloudDocCommitLocks.set(docId, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    releaseNext();
    if (cloudDocCommitLocks.get(docId) === next) {
      cloudDocCommitLocks.delete(docId);
    }
  }
}

async function requireRegularUser(c: RouteContext): Promise<{ userId: string } | Response> {
  const outcome = await resolveAuthOutcome(c);
  if (!outcome.auth) {
    return authFailureResponse(c, outcome);
  }
  if (outcome.auth.scope === 'doc_collaborator') {
    return c.json({ error: 'forbidden' }, 403);
  }
  return { userId: outcome.auth.userId };
}

export function createCloudDocsRoutes(storage: CloudDocStorage) {
  const routes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

  // ── Cloud Docs: List folders, documents & shared items ──────────────────────
  routes.get('/cloud-docs', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const folderIdParam = c.req.query('folderId');
    const allFolders = folderIdParam === undefined || folderIdParam === '*';
    const folderId = !allFolders ? (folderIdParam ? folderIdParam.trim() : null) : undefined;
    const search = c.req.query('search') ?? '';

    const [folders, docs, shared] = await Promise.all([
      listCloudDocFolders(c.env.DB, auth.userId),
      listCloudDocs(c.env.DB, auth.userId, {
        folderId,
        allFolders,
        search,
      }),
      listSharedCloudItemsForUser(c.env.DB, auth.userId, { search }),
    ]);

    return c.json({
      folders,
      docs,
      sharedFolders: shared.sharedFolders,
      sharedDocs: shared.sharedDocs,
    });
  });

  // ── Cloud Docs: Global controlled-node groups (teams) available for sharing ─
  routes.get('/cloud-docs/teams', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const teams = await listUserTeamsForCloudDocs(c.env.DB, auth.userId);
    return c.json({ teams });
  });

  // ── Cloud Docs: Share grants CRUD (owner-only) ──────────────────────────────
  routes.get('/cloud-docs/shares/:targetKind/:id', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const targetKind = c.req.param('targetKind');
    const targetId = c.req.param('id');
    if (targetKind !== 'doc' && targetKind !== 'folder') {
      return c.json({ error: 'invalid_target_kind' }, 400);
    }

    if (targetKind === 'doc') {
      const owned = await getCloudDocById(c.env.DB, targetId, auth.userId);
      if (!owned) {
        const anyDoc = await getCloudDocById(c.env.DB, targetId);
        return c.json({ error: anyDoc ? 'forbidden' : 'not_found' }, anyDoc ? 403 : 404);
      }
    } else {
      const owned = await getCloudDocFolderById(c.env.DB, auth.userId, targetId);
      if (!owned) {
        return c.json({ error: 'folder_not_found' }, 404);
      }
    }

    const shares = await listCloudDocSharesForTarget(c.env.DB, targetKind, targetId);
    return c.json({ shares });
  });

  routes.post('/cloud-docs/shares', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    let body: {
      targetKind?: string;
      targetId?: string;
      shareMode?: string;
      targetTeamId?: string;
      targetUserId?: string;
      targetUsername?: string;
      role?: string;
      allowDownload?: boolean;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const targetKind = body.targetKind;
    const targetId = body.targetId?.trim() || '';
    const shareMode = body.shareMode;
    const role = body.role;
    const allowDownload = body.allowDownload !== false;

    if (targetKind !== 'doc' && targetKind !== 'folder') {
      return c.json({ error: 'invalid_target_kind' }, 400);
    }
    if (!targetId) {
      return c.json({ error: 'invalid_target_id' }, 400);
    }
    if (shareMode !== 'team' && shareMode !== 'user') {
      return c.json({ error: 'invalid_share_mode' }, 400);
    }
    if (role !== 'viewer' && role !== 'editor') {
      return c.json({ error: 'invalid_role' }, 400);
    }

    if (targetKind === 'doc') {
      const owned = await getCloudDocById(c.env.DB, targetId, auth.userId);
      if (!owned) {
        const anyDoc = await getCloudDocById(c.env.DB, targetId);
        return c.json({ error: anyDoc ? 'forbidden' : 'not_found' }, anyDoc ? 403 : 404);
      }
    } else {
      const owned = await getCloudDocFolderById(c.env.DB, auth.userId, targetId);
      if (!owned) {
        return c.json({ error: 'folder_not_found' }, 404);
      }
    }

    let resolvedTeamId: string | null = null;
    let resolvedUserId: string | null = null;

    if (shareMode === 'team') {
      const teamId = body.targetTeamId?.trim() || '';
      if (!teamId) return c.json({ error: 'team_id_required' }, 400);
      const userTeams = await listUserTeamsForCloudDocs(c.env.DB, auth.userId);
      if (!userTeams.some((t) => t.id === teamId)) {
        return c.json({ error: 'forbidden' }, 403);
      }
      resolvedTeamId = teamId;
    } else {
      let targetUser: { id: string; status?: string } | null = null;
      if (body.targetUserId?.trim()) {
        targetUser = await c.env.DB.queryOne<{ id: string; status: string }>(
          'SELECT id, status FROM users WHERE id = $1',
          [body.targetUserId.trim()],
        );
      } else if (body.targetUsername?.trim()) {
        const found = await resolveUserByIdentifier(c.env.DB, body.targetUsername.trim());
        if (found) {
          targetUser = await c.env.DB.queryOne<{ id: string; status: string }>(
            'SELECT id, status FROM users WHERE id = $1',
            [found.id],
          );
        }
      }
      if (!targetUser) return c.json({ error: 'user_not_found' }, 404);
      if (targetUser.status && targetUser.status !== 'active') {
        return c.json({ error: 'user_disabled' }, 400);
      }
      if (targetUser.id === auth.userId) {
        return c.json({ error: 'cannot_share_to_self' }, 400);
      }
      resolvedUserId = targetUser.id;
    }

    const share = await upsertCloudDocShare(c.env.DB, {
      targetKind,
      targetId,
      shareMode,
      targetTeamId: resolvedTeamId,
      targetUserId: resolvedUserId,
      role,
      allowDownload,
      createdBy: auth.userId,
    });
    return c.json({ share }, 201);
  });

  routes.delete('/cloud-docs/shares/:shareId', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const shareId = c.req.param('shareId');
    const revoked = await revokeCloudDocShare(c.env.DB, {
      shareId,
      createdBy: auth.userId,
    });
    if (!revoked) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });

  // ── Cloud Docs: Folder CRUD ─────────────────────────────────────────────────
  routes.post('/cloud-docs/folders', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    let body: { name?: string; parentId?: string | null };
    try {
      body = (await c.req.json()) as { name?: string; parentId?: string | null };
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const name = normalizeCloudDocFolderName(body.name);
    if (!name) {
      return c.json({ error: 'invalid_name' }, 400);
    }

    const parentId = typeof body.parentId === 'string' && body.parentId.trim()
      ? body.parentId.trim()
      : null;
    if (parentId) {
      const parent = await getCloudDocFolderById(c.env.DB, auth.userId, parentId);
      if (!parent) {
        return c.json({ error: 'folder_not_found' }, 404);
      }
    }

    const folder = await createCloudDocFolder(c.env.DB, {
      userId: auth.userId,
      name,
      parentId,
    });
    return c.json({ folder }, 201);
  });

  routes.patch('/cloud-docs/folders/:id', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const folderId = c.req.param('id');
    let body: { name?: string; parentId?: string | null };
    try {
      body = (await c.req.json()) as { name?: string; parentId?: string | null };
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    let nextName: string | undefined;
    if (body.name !== undefined) {
      const normalized = normalizeCloudDocFolderName(body.name);
      if (!normalized) return c.json({ error: 'invalid_name' }, 400);
      nextName = normalized;
    }

    const hasParentId = Object.prototype.hasOwnProperty.call(body, 'parentId');
    let nextParentId: string | null = null;
    if (hasParentId) {
      nextParentId = typeof body.parentId === 'string' && body.parentId.trim()
        ? body.parentId.trim()
        : null;
      if (nextParentId) {
        const targetParent = await getCloudDocFolderById(c.env.DB, auth.userId, nextParentId);
        if (!targetParent) return c.json({ error: 'folder_not_found' }, 404);
        if (await isDescendantFolder(c.env.DB, auth.userId, nextParentId, folderId)) {
          return c.json({ error: 'invalid_move' }, 400);
        }
      }
    }

    const updated = await updateCloudDocFolder(c.env.DB, {
      userId: auth.userId,
      folderId,
      name: nextName,
      parentId: nextParentId,
      hasParentId,
    });
    if (!updated) return c.json({ error: 'folder_not_found' }, 404);
    return c.json({ folder: updated });
  });

  routes.delete('/cloud-docs/folders/:id', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const folderId = c.req.param('id');
    const deleted = await deleteCloudDocFolderTree(c.env.DB, auth.userId, folderId);
    if (!deleted) return c.json({ error: 'folder_not_found' }, 404);

    // Best-effort blob cleanup strictly after DB delete commits
    await Promise.all(deleted.storageKeys.map((key) => storage.delete(key).catch(() => {})));
    return c.json({ ok: true, deletedFolderIds: deleted.deletedFolderIds });
  });

  // ── Cloud Docs: Create blank document ───────────────────────────────────────
  routes.post('/cloud-docs/blank', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    let body: { type?: string; name?: string; folderId?: string | null };
    try {
      body = (await c.req.json()) as { type?: string; name?: string; folderId?: string | null };
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    if (!isBlankCloudDocType(body.type)) {
      return c.json({ error: 'unsupported_document_type' }, 400);
    }

    const folderId = typeof body.folderId === 'string' && body.folderId.trim()
      ? body.folderId.trim()
      : null;
    if (folderId) {
      const folder = await getCloudDocFolderById(c.env.DB, auth.userId, folderId);
      if (!folder) return c.json({ error: 'folder_not_found' }, 404);
    }

    const ext = `.${body.type}`;
    const defaultName = body.name?.trim() || `Untitled.${body.type}`;
    const safeName = normalizeCloudDocName(defaultName, ext);
    if (!safeName) return c.json({ error: 'invalid_name' }, 400);

    const meta = getCloudDocMeta(safeName);
    if (!meta) return c.json({ error: 'unsupported_document_type' }, 400);

    const docId = `cdoc_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const storageKey = buildCloudDocStorageKey(auth.userId, docId, 1);
    const bytes = buildBlankDocumentBytes(ext);

    let writeResult: { sizeBytes: number; sha256: string };
    try {
      writeResult = await storage.write(storageKey, bytes);
    } catch {
      return c.json({ error: 'cloud_doc_storage_error' }, 500);
    }

    try {
      const row = await insertCloudDoc(c.env.DB, {
        id: docId,
        userId: auth.userId,
        folderId,
        name: safeName,
        ext: meta.ext,
        mimeType: meta.mimeType,
        sizeBytes: writeResult.sizeBytes,
        contentSha256: writeResult.sha256,
        storageKey,
      });
      return c.json({ doc: rowToCloudDocItem(row) }, 201);
    } catch (err) {
      // Partial-failure rollback: only delete the written blob when DB guarantees no row was committed
      if (isDefinitelyUncommittedDbError(err)) {
        await storage.delete(storageKey).catch(() => {});
      }
      return c.json({ error: 'cloud_doc_db_error' }, 500);
    }
  });

  // ── Cloud Docs: Upload file (multipart/form-data) ───────────────────────────
  const handleUploadCloudDoc = async (c: RouteContext): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const maxMultipartBytes = CLOUD_DOCS_MAX_UPLOAD_BYTES + 1024 * 1024;
    const rawLength = Number(c.req.header('Content-Length') ?? '0');
    if (Number.isFinite(rawLength) && rawLength > maxMultipartBytes) {
      return c.json({ error: 'file_too_large', maxBytes: CLOUD_DOCS_MAX_UPLOAD_BYTES }, 413);
    }

    let form: FormData;
    try {
      const rawBodyStream = c.req.raw.body;
      if (rawBodyStream) {
        const rawBytes = await readStreamBytesBounded(rawBodyStream, maxMultipartBytes);
        const boundedHeaders = new Headers(c.req.raw.headers);
        boundedHeaders.delete('content-length');
        form = await new Request(c.req.raw.url, {
          method: c.req.raw.method,
          headers: boundedHeaders,
          body: new Uint8Array(rawBytes),
        }).formData();
      } else {
        form = await c.req.formData();
      }
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        return c.json({ error: 'file_too_large', maxBytes: CLOUD_DOCS_MAX_UPLOAD_BYTES }, 413);
      }
      return c.json({ error: 'invalid_multipart' }, 400);
    }

    const fileEntry = form.get('file');
    if (!fileEntry || typeof fileEntry === 'string' || typeof (fileEntry as Blob).arrayBuffer !== 'function') {
      return c.json({ error: 'missing_file' }, 400);
    }
    const uploadedFile = fileEntry as File;
    if (uploadedFile.size > CLOUD_DOCS_MAX_UPLOAD_BYTES) {
      return c.json({ error: 'file_too_large', maxBytes: CLOUD_DOCS_MAX_UPLOAD_BYTES }, 413);
    }

    const rawFolderId = form.get('folderId');
    const folderId = typeof rawFolderId === 'string' && rawFolderId.trim()
      ? rawFolderId.trim()
      : null;
    if (folderId) {
      const folder = await getCloudDocFolderById(c.env.DB, auth.userId, folderId);
      if (!folder) return c.json({ error: 'folder_not_found' }, 404);
    }

    const requestedName = form.get('name');
    const candidateName = typeof requestedName === 'string' && requestedName.trim()
      ? requestedName.trim()
      : (uploadedFile.name || '');

    // Reject path traversal strings before normalizing filename
    if (candidateName.includes('/') || candidateName.includes('\\')) {
      return c.json({ error: 'invalid_name' }, 400);
    }
    const safeName = normalizeCloudDocName(candidateName);
    if (!safeName) {
      const hasAnyName = candidateName.trim().length > 0;
      return c.json({ error: hasAnyName ? 'unsupported_document_type' : 'invalid_name' }, 400);
    }

    const meta = getCloudDocMeta(safeName);
    if (!meta) {
      return c.json({ error: 'unsupported_document_type' }, 400);
    }

    const arrayBuf = await uploadedFile.arrayBuffer();
    const bytes = Buffer.from(arrayBuf);
    if (bytes.length > CLOUD_DOCS_MAX_UPLOAD_BYTES) {
      return c.json({ error: 'file_too_large', maxBytes: CLOUD_DOCS_MAX_UPLOAD_BYTES }, 413);
    }

    const docId = `cdoc_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const storageKey = buildCloudDocStorageKey(auth.userId, docId, 1);

    let writeResult: { sizeBytes: number; sha256: string };
    try {
      writeResult = await storage.write(storageKey, bytes);
    } catch {
      return c.json({ error: 'cloud_doc_storage_error' }, 500);
    }

    try {
      const row = await insertCloudDoc(c.env.DB, {
        id: docId,
        userId: auth.userId,
        folderId,
        name: safeName,
        ext: meta.ext,
        mimeType: meta.mimeType,
        sizeBytes: writeResult.sizeBytes,
        contentSha256: writeResult.sha256,
        storageKey,
      });
      return c.json({ doc: rowToCloudDocItem(row) }, 201);
    } catch (err) {
      if (isDefinitelyUncommittedDbError(err)) {
        await storage.delete(storageKey).catch(() => {});
      }
      return c.json({ error: 'cloud_doc_db_error' }, 500);
    }
  };
  routes.post('/cloud-docs/files', handleUploadCloudDoc);
  routes.post('/cloud-docs/upload', handleUploadCloudDoc);

  // ── Cloud Docs: ONLYOFFICE file download (token-authenticated) ─────────────
  routes.get('/cloud-docs/onlyoffice/file/:token', async (c): Promise<Response> => {
    const token = c.req.param('token') ?? '';
    const claims = verifyCloudDocOnlyOfficeToken(token, c.env.JWT_SIGNING_KEY);
    if (!claims) {
      return c.json({ error: 'invalid_doc_token' }, 401);
    }

    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const ooSecret = resolveOnlyOfficeJwtSecret(c.env);
      const verified = verifyJwt(authHeader.slice(7), ooSecret);
      if (!verified) {
        return c.json({ error: 'invalid_onlyoffice_jwt' }, 401);
      }
    }

    const access = await resolveCloudDocAccess(c.env.DB, claims.cloudDocId, claims.userId);
    if (!access.allowed) {
      return c.json({ error: access.reason === 'not_found' ? 'not_found' : 'access_denied' }, access.reason === 'not_found' ? 404 : 403);
    }
    const row = access.doc;

    let bytes: Buffer;
    try {
      bytes = await storage.read(row.storage_key);
    } catch {
      return c.json({ error: 'cloud_doc_file_missing' }, 404);
    }

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': row.mime_type || 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'Content-Disposition': `inline; filename="${encodeURIComponent(row.name)}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  });

  // ── Cloud Docs: ONLYOFFICE save callback (strict JWT + CAS atomic save) ─────
  routes.post('/cloud-docs/onlyoffice/callback/:token', async (c): Promise<Response> => {
    const token = c.req.param('token') ?? '';
    const claims = verifyCloudDocOnlyOfficeToken(token, c.env.JWT_SIGNING_KEY);
    if (!claims) {
      return c.json({ error: 1, message: 'invalid_doc_token' }, 401);
    }

    const preAccess = await resolveCloudDocAccess(c.env.DB, claims.cloudDocId, claims.userId);
    if (!preAccess.allowed) {
      return c.json(
        { error: 1, message: preAccess.reason === 'not_found' ? 'not_found' : 'access_denied' },
        preAccess.reason === 'not_found' ? 404 : 403,
      );
    }
    if (preAccess.role !== 'editor') {
      return c.json({ error: 1, message: 'access_denied' }, 403);
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 1, message: 'invalid_json' }, 400);
    }

    const ooSecret = resolveOnlyOfficeJwtSecret(c.env);
    const bearerToken = c.req.header('Authorization')?.startsWith('Bearer ')
      ? c.req.header('Authorization')!.slice(7).trim()
      : null;
    const bodyToken = typeof body.token === 'string' ? body.token.trim() : null;
    const rawOoJwt = bodyToken || bearerToken;

    if (!rawOoJwt) {
      return c.json({ error: 1, message: 'missing_onlyoffice_jwt' }, 401);
    }

    const verifiedJwt = verifyJwt(rawOoJwt, ooSecret);
    if (!verifiedJwt) {
      return c.json({ error: 1, message: 'invalid_onlyoffice_jwt' }, 401);
    }

    const nestedPayload =
      verifiedJwt.payload && typeof verifiedJwt.payload === 'object' && !Array.isArray(verifiedJwt.payload)
        ? (verifiedJwt.payload as Record<string, unknown>)
        : verifiedJwt;

    // Reject browser editor-config tokens reused as callback credentials
    if (
      nestedPayload.tokenKind === 'editor_config' ||
      nestedPayload.editorConfig !== undefined ||
      nestedPayload.document !== undefined ||
      typeof nestedPayload.status !== 'number'
    ) {
      return c.json({ error: 1, message: 'invalid_onlyoffice_callback_jwt' }, 401);
    }

    if (body.status !== undefined && body.status !== nestedPayload.status) {
      return c.json({ error: 1, message: 'callback_payload_mismatch' }, 401);
    }
    const signedUrl = typeof nestedPayload.url === 'string' ? nestedPayload.url.trim() : '';
    if (typeof body.url === 'string' && body.url.trim() && body.url.trim() !== signedUrl) {
      return c.json({ error: 1, message: 'callback_payload_mismatch' }, 401);
    }
    const signedKey = typeof nestedPayload.key === 'string' ? nestedPayload.key.trim() : '';
    if (typeof body.key === 'string' && body.key.trim() && signedKey && body.key.trim() !== signedKey) {
      return c.json({ error: 1, message: 'callback_payload_mismatch' }, 401);
    }

    if (signedKey && signedKey !== claims.documentKey) {
      return c.json({ error: 1, message: 'callback_key_mismatch' }, 401);
    }

    const status = nestedPayload.status;
    if (status !== 2 && status !== 6) {
      return c.json({ error: 0 });
    }

    if (!signedUrl) {
      return c.json({ error: 1, message: 'missing_download_url' }, 400);
    }

    const trustedUrl = resolveTrustedOnlyOfficeDownloadUrl(signedUrl, c.env);
    if (!trustedUrl) {
      return c.json({ error: 1, message: 'untrusted_download_url' }, 400);
    }

    const downloadController = new AbortController();
    let docRes: Response;
    try {
      docRes = await fetch(trustedUrl.internalFetchUrl, {
        redirect: 'error',
        signal: downloadController.signal,
      });
    } catch (fetchErr) {
      if (trustedUrl.fallbackPublicUrl && trustedUrl.fallbackPublicUrl !== trustedUrl.internalFetchUrl) {
        docRes = await fetch(trustedUrl.fallbackPublicUrl, {
          redirect: 'error',
          signal: downloadController.signal,
        });
      } else {
        throw fetchErr;
      }
    }

    if (!docRes.ok) {
      return c.json({ error: 1, message: 'failed_to_download_edited_file' }, 502);
    }

    let bytes: Buffer;
    try {
      bytes = await readResponseBytesBounded(docRes, CLOUD_DOCS_MAX_UPLOAD_BYTES, downloadController);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        return c.json({ error: 1, message: 'file_too_large' }, 413);
      }
      return c.json({ error: 1, message: 'failed_to_download_edited_file' }, 502);
    }

    return lockCloudDocCommit(claims.cloudDocId, async () => {
      const liveAccess = await resolveCloudDocAccess(c.env.DB, claims.cloudDocId, claims.userId);
      if (!liveAccess.allowed) {
        return c.json(
          { error: 1, message: liveAccess.reason === 'not_found' ? 'not_found' : 'access_denied' },
          liveAccess.reason === 'not_found' ? 404 : 403,
        );
      }
      if (liveAccess.role !== 'editor') {
        return c.json({ error: 1, message: 'access_denied' }, 403);
      }
      const current = liveAccess.doc;

      const currentVersion = Number(current.doc_version);
      const currentDocKey = computeCloudDocDocumentKey(current.id, currentVersion);
      if (currentVersion !== claims.docVersion || currentDocKey !== claims.documentKey) {
        return c.json({ error: 1, message: 'stale_document_key' }, 409);
      }

      const isFinalSave = status === 2;
      const newStorageKey = buildCloudDocStorageKey(
        current.user_id,
        current.id,
        isFinalSave ? currentVersion + 1 : currentVersion,
      );

      let writeResult: { sizeBytes: number; sha256: string };
      try {
        writeResult = await storage.write(newStorageKey, bytes);
      } catch {
        return c.json({ error: 1, message: 'storage_write_failed' }, 500);
      }

      try {
        const committed = await commitCloudDocContent(c.env.DB, {
          docId: current.id,
          userId: current.user_id,
          expectedVersion: currentVersion,
          bumpVersion: isFinalSave,
          newStorageKey,
          sizeBytes: writeResult.sizeBytes,
          contentSha256: writeResult.sha256,
        });
        if (committed.status === 'conflict') {
          if (newStorageKey !== current.storage_key) {
            await storage.delete(newStorageKey).catch(() => {});
          }
          return c.json({ error: 1, message: 'stale_document_key' }, 409);
        }
      } catch (err) {
        if (newStorageKey !== current.storage_key && isDefinitelyUncommittedDbError(err)) {
          await storage.delete(newStorageKey).catch(() => {});
        }
        return c.json({ error: 1, message: 'cloud_doc_commit_failed' }, 500);
      }

      if (current.storage_key !== newStorageKey) {
        await storage.delete(current.storage_key).catch(() => {});
      }

      return c.json({ error: 0 });
    });
  });

  // ── Cloud Docs: ONLYOFFICE config & recent history auto-record ──────────────
  routes.get('/cloud-docs/:id/onlyoffice/config', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const docId = c.req.param('id');
    const access = await resolveCloudDocAccess(c.env.DB, docId, auth.userId);
    if (!access.allowed) {
      return c.json({ error: 'not_found' }, 404);
    }
    const row = access.doc;

    if (!(await storage.exists(row.storage_key))) {
      return c.json({ error: 'cloud_doc_file_missing' }, 404);
    }

    const meta = getOnlyOfficeDocumentMeta(row.name);
    if (!meta) {
      return c.json({ error: 'unsupported_document_type' }, 400);
    }

    const requestedMode = c.req.query('mode');
    const canUserEdit = access.role === 'editor' && meta.isEditable;
    const effectiveMode: 'view' | 'edit' =
      canUserEdit && requestedMode !== 'view' ? 'edit' : 'view';

    const userRow = await c.env.DB.queryOne<{ username: string | null; display_name: string | null }>(
      'SELECT username, display_name FROM users WHERE id = $1',
      [auth.userId],
    );
    const actorName = userRow?.display_name || userRow?.username || auth.userId;

    const docVersion = Number(row.doc_version) || 1;
    const documentKey = computeCloudDocDocumentKey(row.id, docVersion);

    const docToken = signCloudDocOnlyOfficeToken(
      {
        cloudDocId: row.id,
        userId: auth.userId,
        actorName,
        docVersion,
        documentKey,
      },
      c.env.JWT_SIGNING_KEY,
      4 * 3600,
    );

    const serverBaseUrl = (c.env.SERVER_URL || 'http://localhost:19138').replace(/\/$/, '');
    const publicUrl = (c.env.ONLYOFFICE_PUBLIC_URL || `${serverBaseUrl}/onlyoffice`).replace(/\/$/, '');
    const scriptUrl = `${publicUrl}/web-apps/apps/api/documents/api.js`;
    const fileUrl = `${serverBaseUrl}/api/cloud-docs/onlyoffice/file/${docToken}`;
    const callbackUrl = `${serverBaseUrl}/api/cloud-docs/onlyoffice/callback/${docToken}`;

    // Automatically record open into recent_documents & touch last_opened_at (best-effort)
    try {
      await touchCloudDocOpened(c.env.DB, row.id);
      await upsertRecentDocument(c.env.DB, {
        userId: auth.userId,
        sourceKind: 'cloud_doc',
        cloudDocId: row.id,
        title: row.name,
        mimeType: row.mime_type,
        openMode: effectiveMode,
      });
    } catch {
      // Do not block opening document if recent history write fails transiently
    }

    if (c.env.ONLYOFFICE_ENABLED !== 'true') {
      return c.json({
        enabled: false,
        fallbackReason: 'onlyoffice_disabled',
        role: access.role,
        allowDownload: access.allowDownload,
        canManageShare: access.isOwner,
        isOwner: access.isOwner,
        mode: effectiveMode,
        docToken,
        fileUrl,
      });
    }

    const canEdit = effectiveMode === 'edit' && canUserEdit;
    const editorConfigPayload = {
      documentType: meta.documentType,
      document: {
        fileType: meta.fileType,
        key: documentKey,
        title: row.name,
        url: fileUrl,
        permissions: {
          edit: canEdit,
          download: access.allowDownload,
          print: access.allowDownload,
          copy: access.allowDownload,
          review: canEdit,
          comment: canEdit,
        },
      },
      editorConfig: {
        mode: effectiveMode,
        callbackUrl,
        lang: c.req.query('lang') || 'en',
        user: {
          id: auth.userId,
          name: actorName,
        },
        customization: {
          forcesave: true,
          compactHeader: true,
        },
      },
    };

    const ooSecret = resolveOnlyOfficeJwtSecret(c.env);
    const ooJwt = signJwt(
      {
        ...editorConfigPayload,
        tokenKind: 'editor_config',
      } as unknown as Record<string, unknown>,
      ooSecret,
      4 * 3600,
    );

    return c.json({
      enabled: true,
      role: access.role,
      allowDownload: access.allowDownload,
      canManageShare: access.isOwner,
      isOwner: access.isOwner,
      mode: effectiveMode,
      publicUrl,
      scriptUrl,
      docToken,
      fileUrl,
      token: ooJwt,
      config: {
        ...editorConfigPayload,
        token: ooJwt,
      },
    });
  });

  const serveCloudDocDownload = async (
    storageKey: string,
    mimeType: string | null,
    fileName: string,
    forceDownload: boolean,
  ): Promise<Response> => {
    let bytes: Buffer;
    try {
      bytes = await storage.read(storageKey);
    } catch {
      return new Response(JSON.stringify({ error: 'cloud_doc_file_missing' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const disposition = forceDownload ? 'attachment' : 'inline';
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': mimeType || 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'Content-Disposition': `${disposition}; filename="${encodeURIComponent(fileName)}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  };

  // ── Cloud Docs: Short-lived single-purpose download ticket (for native/cookie-less clients) ──
  routes.post('/cloud-docs/:id/download-ticket', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const docId = c.req.param('id');
    const access = await resolveCloudDocAccess(c.env.DB, docId, auth.userId);
    if (!access.allowed) return c.json({ error: 'not_found' }, 404);
    if (!access.allowDownload) return c.json({ error: 'download_forbidden' }, 403);
    if (!(await storage.exists(access.doc.storage_key))) {
      return c.json({ error: 'cloud_doc_file_missing' }, 404);
    }

    let inline = c.req.query('inline') === '1';
    try {
      const contentType = c.req.header('Content-Type') ?? '';
      if (contentType.includes('application/json')) {
        const body = (await c.req.json()) as { inline?: unknown };
        if (typeof body?.inline === 'boolean') inline = body.inline;
      }
    } catch {
      // Ignore empty/malformed optional JSON body
    }

    const ticket = signCloudDocDownloadTicket(
      {
        cloudDocId: docId,
        userId: auth.userId,
        inline,
      },
      c.env.JWT_SIGNING_KEY,
    );

    return c.json({
      ticket,
      downloadPath: `/api/cloud-docs/download/${encodeURIComponent(ticket)}`,
      expiresInSeconds: CLOUD_DOC_DOWNLOAD_TICKET_TTL_SECONDS,
    });
  });

  // ── Cloud Docs: Ticket-authenticated download (re-checks live access & allowDownload) ──
  routes.get('/cloud-docs/download/:ticket', async (c): Promise<Response> => {
    const ticket = c.req.param('ticket') ?? '';
    const claims = verifyCloudDocDownloadTicket(ticket, c.env.JWT_SIGNING_KEY);
    if (!claims) {
      return c.json({ error: 'invalid_download_ticket' }, 401);
    }

    const access = await resolveCloudDocAccess(c.env.DB, claims.cloudDocId, claims.userId);
    if (!access.allowed) {
      return c.json(
        { error: access.reason === 'not_found' ? 'not_found' : 'access_denied' },
        access.reason === 'not_found' ? 404 : 403,
      );
    }
    if (!access.allowDownload) {
      return c.json({ error: 'download_forbidden' }, 403);
    }

    const downloadQuery = c.req.query('download');
    const forceDownload = downloadQuery === '1'
      ? true
      : downloadQuery === '0'
        ? false
        : !claims.inline;

    return serveCloudDocDownload(
      access.doc.storage_key,
      access.doc.mime_type,
      access.doc.name,
      forceDownload,
    );
  });

  // ── Cloud Docs: Authenticated download ──────────────────────────────────────
  routes.get('/cloud-docs/:id/download', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const docId = c.req.param('id');
    const access = await resolveCloudDocAccess(c.env.DB, docId, auth.userId);
    if (!access.allowed) return c.json({ error: 'not_found' }, 404);
    if (!access.allowDownload) return c.json({ error: 'download_forbidden' }, 403);
    const row = access.doc;

    const forceDownload = c.req.query('download') === '1';
    return serveCloudDocDownload(row.storage_key, row.mime_type, row.name, forceDownload);
  });

  // ── Cloud Docs: Rename / Move ───────────────────────────────────────────────
  routes.patch('/cloud-docs/:id', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const docId = c.req.param('id');
    const existing = await getCloudDocById(c.env.DB, docId, auth.userId);
    if (!existing) {
      const access = await resolveCloudDocAccess(c.env.DB, docId, auth.userId);
      if (access.allowed) return c.json({ error: 'forbidden' }, 403);
      return c.json({ error: 'not_found' }, 404);
    }

    let body: { name?: string; folderId?: string | null };
    try {
      body = (await c.req.json()) as { name?: string; folderId?: string | null };
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    let nextName: string | undefined;
    let nextExt: string | undefined;
    let nextMime: string | undefined;
    if (body.name !== undefined) {
      const normalized = normalizeCloudDocName(body.name, existing.ext);
      if (!normalized) return c.json({ error: 'invalid_name' }, 400);
      const meta = getCloudDocMeta(normalized);
      if (!meta) return c.json({ error: 'unsupported_document_type' }, 400);
      nextName = normalized;
      nextExt = meta.ext;
      nextMime = meta.mimeType;
    }

    const hasFolderId = Object.prototype.hasOwnProperty.call(body, 'folderId');
    let nextFolderId: string | null = null;
    if (hasFolderId) {
      nextFolderId = typeof body.folderId === 'string' && body.folderId.trim()
        ? body.folderId.trim()
        : null;
      if (nextFolderId) {
        const folder = await getCloudDocFolderById(c.env.DB, auth.userId, nextFolderId);
        if (!folder) return c.json({ error: 'folder_not_found' }, 404);
      }
    }

    const updated = await updateCloudDocMetadata(c.env.DB, {
      userId: auth.userId,
      docId,
      name: nextName,
      ext: nextExt,
      mimeType: nextMime,
      folderId: nextFolderId,
      hasFolderId,
    });
    if (!updated) return c.json({ error: 'not_found' }, 404);

    return c.json({ doc: rowToCloudDocItem(updated) });
  });

  // ── Cloud Docs: Delete ──────────────────────────────────────────────────────
  routes.delete('/cloud-docs/:id', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const docId = c.req.param('id');
    const deleted = await deleteCloudDocRecord(c.env.DB, docId, auth.userId);
    if (!deleted) {
      const access = await resolveCloudDocAccess(c.env.DB, docId, auth.userId);
      if (access.allowed) return c.json({ error: 'forbidden' }, 403);
      return c.json({ error: 'not_found' }, 404);
    }

    await storage.delete(deleted.storage_key).catch(() => {});
    return c.json({ ok: true });
  });

  // ── Recent Documents: List with real-time per-server & per-doc access ──────
  routes.get('/recent-documents', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const limitParam = Number(c.req.query('limit') ?? CLOUD_DOCS_RECENT_DEFAULT_LIMIT);
    const rows = await listRecentDocumentsRaw(
      c.env.DB,
      auth.userId,
      Number.isFinite(limitParam) ? limitParam : CLOUD_DOCS_RECENT_DEFAULT_LIMIT,
    );

    const items: RecentDocumentItem[] = await Promise.all(rows.map(async (row) => {
      const base = rowToRecentDocumentBase(row);

      if (row.source_kind === 'cloud_doc') {
        const access = row.cloud_doc_id
          ? await resolveCloudDocAccess(c.env.DB, row.cloud_doc_id, auth.userId)
          : { allowed: false as const, reason: 'not_found' as const };
        if (!access.allowed) {
          return {
            ...base,
            accessible: false,
            serverOnline: true,
            accessReason: (access.reason === 'not_found' ? 'cloud_doc_missing' : 'access_denied') as RecentDocumentAccessReason,
          };
        }
        return {
          ...base,
          title: access.doc.name,
          mimeType: access.doc.mime_type,
          openMode: access.role === 'editor' ? base.openMode : 'view',
          accessible: true,
          serverOnline: true,
          accessReason: null,
          role: access.role,
          allowDownload: access.allowDownload,
        };
      }

      // server_file: verify live permission against DB + server daemon online state
      const serverId = row.server_id ?? '';
      const filePath = row.file_path ?? '';
      if (!serverId || !filePath) {
        return {
          ...base,
          accessible: false,
          serverOnline: false,
          accessReason: 'server_not_found' as RecentDocumentAccessReason,
        };
      }

      const [access, serverRow] = await Promise.all([
        resolveLiveOnlyOfficeAccess(c.env.DB, {
          serverId,
          userId: auth.userId,
          sessionName: row.session_name,
          filePath,
        }),
        c.env.DB.queryOne<{ name: string | null }>('SELECT name FROM servers WHERE id = $1', [serverId]),
      ]);

      const serverOnline = WsBridge.find(serverId)?.isDaemonConnected() ?? false;
      const accessReason: RecentDocumentAccessReason = !access.allowed
        ? (access.reason === 'server_not_found' ? 'server_not_found' : 'access_denied')
        : (!serverOnline ? 'server_offline' : null);

      return {
        ...base,
        serverName: serverRow?.name ?? base.serverName,
        accessible: access.allowed,
        serverOnline,
        accessReason,
      };
    }));

    return c.json({ items });
  });

  // ── Recent Documents: Explicit record (e.g. local preview in FileBrowser) ──
  routes.post('/recent-documents/record', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    let body: {
      sourceKind?: string;
      serverId?: string;
      sessionName?: string | null;
      filePath?: string;
      cloudDocId?: string;
      title?: string;
      mimeType?: string;
      openMode?: 'view' | 'edit';
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    if (body.sourceKind === 'cloud_doc') {
      const cloudDocId = body.cloudDocId?.trim();
      if (!cloudDocId) return c.json({ error: 'invalid_cloud_doc_id' }, 400);
      const access = await resolveCloudDocAccess(c.env.DB, cloudDocId, auth.userId);
      if (!access.allowed) {
        return c.json(
          { error: access.reason === 'not_found' ? 'not_found' : 'forbidden' },
          access.reason === 'not_found' ? 404 : 403,
        );
      }
      const doc = access.doc;
      const effectiveMode: 'view' | 'edit' =
        access.role === 'editor' && body.openMode !== 'view' ? 'edit' : 'view';

      await touchCloudDocOpened(c.env.DB, doc.id);
      const row = await upsertRecentDocument(c.env.DB, {
        userId: auth.userId,
        sourceKind: 'cloud_doc',
        cloudDocId: doc.id,
        title: doc.name,
        mimeType: doc.mime_type,
        openMode: effectiveMode,
      });
      if (!row) return c.json({ error: 'record_failed' }, 400);
      return c.json({
        item: {
          ...rowToRecentDocumentBase(row),
          accessible: true,
          serverOnline: true,
          accessReason: null,
          role: access.role,
          allowDownload: access.allowDownload,
        } satisfies RecentDocumentItem,
      });
    }

    if (body.sourceKind === 'server_file') {
      const serverId = body.serverId?.trim() || '';
      const normPath = normalizeRecentFilePath(body.filePath);
      if (!serverId || !normPath) {
        return c.json({ error: 'invalid_path' }, 400);
      }

      const access = await resolveLiveOnlyOfficeAccess(c.env.DB, {
        serverId,
        userId: auth.userId,
        sessionName: body.sessionName?.trim() || null,
        filePath: normPath,
      });
      if (!access.allowed || !access.role) {
        const status = access.reason === 'server_not_found' ? 404 : 403;
        return c.json({ error: 'forbidden', reason: access.reason ?? 'access_denied' }, status);
      }

      const serverRow = await c.env.DB.queryOne<{ name: string | null }>(
        'SELECT name FROM servers WHERE id = $1',
        [serverId],
      );
      const meta = getOnlyOfficeDocumentMeta(normPath);
      const title = body.title?.trim() || path.posix.basename(normPath) || normPath;
      const mimeType = meta?.mimeType || body.mimeType?.trim() || 'application/octet-stream';
      const effectiveMode: 'view' | 'edit' =
        access.role === 'editor' && (meta?.isEditable ?? false) && body.openMode !== 'view'
          ? 'edit'
          : 'view';

      const row = await upsertRecentDocument(c.env.DB, {
        userId: auth.userId,
        sourceKind: 'server_file',
        serverId,
        serverName: serverRow?.name ?? null,
        sessionName: body.sessionName?.trim() || null,
        filePath: normPath,
        title,
        mimeType,
        openMode: effectiveMode,
      });
      if (!row) return c.json({ error: 'record_failed' }, 400);

      const serverOnline = WsBridge.find(serverId)?.isDaemonConnected() ?? false;
      return c.json({
        item: {
          ...rowToRecentDocumentBase(row),
          accessible: true,
          serverOnline,
          accessReason: serverOnline ? null : 'server_offline',
        } satisfies RecentDocumentItem,
      });
    }

    return c.json({ error: 'invalid_source_kind' }, 400);
  });

  // ── Recent Documents: Remove from history ───────────────────────────────────
  routes.delete('/recent-documents/:id', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const id = c.req.param('id');
    const deleted = await deleteRecentDocument(c.env.DB, auth.userId, id);
    if (!deleted) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });

  return routes;
}
