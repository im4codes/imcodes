import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../env.js';
import { authFailureResponse, resolveAuthOutcome } from '../security/authorization.js';
import { randomHex, sha256Hex, signJwt, verifyJwt } from '../security/crypto.js';
import { resolveUserByIdentifier } from '../db/user-lookup.js';
import { WsBridge } from '../ws/bridge.js';
import { resolveMachineOperationalUser } from '../share/shared-machine-authority.js';
import {
  getOnlyOfficeDocumentMeta,
  resolveLiveOnlyOfficeAccess,
  resolveOnlyOfficeJwtSecret,
  resolveTrustedOnlyOfficeDownloadUrl,
} from './onlyoffice.js';
import { buildOnlyOfficeEditorPresentation, parseOnlyOfficeMobileParam } from '../../../shared/onlyoffice-service.js';
import {
  CloudDocContentError,
  applyCloudDocContentEdit,
  buildCloudDocBytesFromContent,
  extractCloudDocContent,
} from '../services/cloud-doc-content.js';
import {
  OnlyOfficeServiceError,
  convertViaOnlyOfficeConverter,
  createDbDocBuilderScriptStore,
  executeOnlyOfficeDocBuilder,
  verifyDocBuilderScriptToken,
} from '../services/onlyoffice-docbuilder.js';
import {
  PayloadTooLargeError,
  readResponseBytesBounded,
  readStreamBytesBounded,
} from '../util/bounded-stream.js';
import {
  type CloudDocStorage,
  buildCloudDocStorageKey,
} from '../storage/cloud-doc-storage.js';
import {
  type CloudDocRow,
  commitCloudDocContent,
  createCloudDocFolder,
  deleteCloudDocFolderTree,
  deleteCloudDocRecord,
  deleteRecentDocument,
  getCloudDocById,
  getCloudDocFolderById,
  getCloudDocShareById,
  insertCloudDoc,
  isDefinitelyUncommittedDbError,
  isDescendantFolder,
  listCloudDocFolders,
  listCloudDocSharesForTarget,
  listCloudDocs,
  listRecentDocumentsRaw,
  listSharedCloudItemsForUser,
  listUserTeamsForCloudDocs,
  parseCloudDocVersion,
  resolveCloudDocAccess,
  resolveCloudDocFolderAccess,
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
  CLOUD_DOCS_ONLYOFFICE_FILE_PATH,
  CLOUD_DOCS_RECENT_DEFAULT_LIMIT,
  CLOUD_DOC_CONTENT_MAX_CHARS,
  CLOUD_DOC_CONVERT_MAX_TIMEOUT_MS,
  CLOUD_DOC_DOCBUILDER_MAX_ARGUMENT_BYTES,
  CLOUD_DOC_DOCBUILDER_MAX_SCRIPT_BYTES,
  CLOUD_DOC_DOCBUILDER_MAX_TIMEOUT_MS,
  CLOUD_DOC_EDIT_MODES,
  CLOUD_DOC_ERROR_CODES,
  type CloudDocEditMode,
  type RecentDocumentAccessReason,
  type RecentDocumentItem,
  getCloudDocExt,
  getCloudDocMeta,
  isConvertTargetType,
  isCreateCloudDocType,
  isDocBuilderOutputType,
  isInternalUploadTempFilePath,
  isMarkdownFilePath,
  normalizeCloudDocFolderName,
  normalizeCloudDocName,
  normalizeRecentFilePath,
} from '../../../shared/cloud-docs.js';
import { FS_GENERIC_ERROR_CODES } from '../../../shared/fs-error-codes.js';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../../shared/shared-machine-authority.js';
import { NODE_ROLE } from '../../../shared/remote-exec.js';

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

function onlyOfficeErrorResponse(c: RouteContext, err: OnlyOfficeServiceError): Response {
  return c.json(
    {
      error: err.code,
      message: err.message,
      ...(err.onlyofficeErrorCode !== undefined ? { onlyofficeErrorCode: err.onlyofficeErrorCode } : {}),
    },
    err.statusCode,
  );
}

function validatePersistedOutputExt(
  c: RouteContext,
  actualOutputName: string,
  expectedExt: string,
): Response | null {
  if (getCloudDocExt(actualOutputName) !== expectedExt) {
    return c.json(
      {
        error: CLOUD_DOC_ERROR_CODES.DOCBUILDER_OUTPUT_MISMATCH,
        message: `ONLYOFFICE DocBuilder produced "${actualOutputName}" instead of expected extension "${expectedExt}"`,
      },
      422,
    );
  }
  return null;
}

function validateTimeoutMs(
  raw: unknown,
  maxMs: number,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 50 || raw > maxMs) {
    return { ok: false, error: CLOUD_DOC_ERROR_CODES.INVALID_TIMEOUT };
  }
  return { ok: true, value: raw };
}

function validateDocBuilderScriptAndArgument(
  c: RouteContext,
  rawScript: unknown,
  rawArgument: unknown,
  rawTimeoutMs: unknown,
): { script: string; argument?: Record<string, unknown>; timeoutMs?: number } | Response {
  if (typeof rawScript !== 'string' || !rawScript.trim()) {
    return c.json({ error: CLOUD_DOC_ERROR_CODES.INVALID_SCRIPT }, 400);
  }
  if (Buffer.byteLength(rawScript, 'utf8') > CLOUD_DOC_DOCBUILDER_MAX_SCRIPT_BYTES) {
    return c.json(
      { error: CLOUD_DOC_ERROR_CODES.SCRIPT_TOO_LARGE, maxBytes: CLOUD_DOC_DOCBUILDER_MAX_SCRIPT_BYTES },
      413,
    );
  }
  let argument: Record<string, unknown> | undefined;
  if (rawArgument !== undefined) {
    if (typeof rawArgument !== 'object' || rawArgument === null || Array.isArray(rawArgument)) {
      return c.json({ error: CLOUD_DOC_ERROR_CODES.INVALID_ARGUMENT }, 400);
    }
    const serialized = JSON.stringify(rawArgument);
    if (Buffer.byteLength(serialized, 'utf8') > CLOUD_DOC_DOCBUILDER_MAX_ARGUMENT_BYTES) {
      return c.json(
        { error: CLOUD_DOC_ERROR_CODES.INVALID_ARGUMENT, maxBytes: CLOUD_DOC_DOCBUILDER_MAX_ARGUMENT_BYTES },
        413,
      );
    }
    argument = rawArgument as Record<string, unknown>;
  }
  const timeout = validateTimeoutMs(rawTimeoutMs, CLOUD_DOC_DOCBUILDER_MAX_TIMEOUT_MS);
  if (!timeout.ok) {
    return c.json({ error: timeout.error }, 400);
  }
  return { script: rawScript, argument, timeoutMs: timeout.value };
}

async function resolveTargetFolderOwner(
  c: RouteContext,
  rawFolderId: unknown,
  actorUserId: string,
): Promise<{ folderId: string | null; docOwnerUserId: string } | Response> {
  if (rawFolderId !== undefined && rawFolderId !== null && typeof rawFolderId !== 'string') {
    return c.json({ error: 'invalid_folder_id' }, 400);
  }
  const folderId = typeof rawFolderId === 'string' && rawFolderId.trim() ? rawFolderId.trim() : null;
  let docOwnerUserId = actorUserId;
  if (folderId) {
    const folderAccess = await resolveCloudDocFolderAccess(c.env.DB, folderId, actorUserId);
    if (!folderAccess.allowed) return c.json({ error: 'folder_not_found' }, 404);
    if (folderAccess.role !== 'editor') return c.json({ error: 'forbidden' }, 403);
    docOwnerUserId = folderAccess.folder.user_id;
  }
  return { folderId, docOwnerUserId };
}

async function resolveExistingDocMoveFolder(
  c: RouteContext,
  rawFolderId: unknown,
  actorUserId: string,
  docOwnerUserId: string,
  isOwner: boolean,
): Promise<{ folderId: string | null } | Response> {
  const nextFolderId = typeof rawFolderId === 'string' && rawFolderId.trim() ? rawFolderId.trim() : null;
  if (!nextFolderId && !isOwner) {
    return c.json({ error: 'forbidden' }, 403);
  }
  if (nextFolderId) {
    const folderAccess = await resolveCloudDocFolderAccess(c.env.DB, nextFolderId, actorUserId);
    if (!folderAccess.allowed) return c.json({ error: 'folder_not_found' }, 404);
    if (folderAccess.role !== 'editor' || folderAccess.folder.user_id !== docOwnerUserId) {
      return c.json({ error: 'forbidden' }, 403);
    }
  }
  return { folderId: nextFolderId };
}

async function parseBoundedMultipartForm(c: RouteContext): Promise<FormData | Response> {
  const maxMultipartBytes = CLOUD_DOCS_MAX_UPLOAD_BYTES + 1024 * 1024;
  const rawLength = Number(c.req.header('Content-Length') ?? '0');
  if (Number.isFinite(rawLength) && rawLength > maxMultipartBytes) {
    return c.json({ error: FS_GENERIC_ERROR_CODES.FILE_TOO_LARGE, maxBytes: CLOUD_DOCS_MAX_UPLOAD_BYTES }, 413);
  }

  try {
    const rawBodyStream = c.req.raw.body;
    if (rawBodyStream) {
      const rawBytes = await readStreamBytesBounded(rawBodyStream, maxMultipartBytes);
      const boundedHeaders = new Headers(c.req.raw.headers);
      boundedHeaders.delete('content-length');
      return await new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: boundedHeaders,
        body: new Uint8Array(rawBytes),
      }).formData();
    }
    return await c.req.formData();
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return c.json({ error: FS_GENERIC_ERROR_CODES.FILE_TOO_LARGE, maxBytes: CLOUD_DOCS_MAX_UPLOAD_BYTES }, 413);
    }
    return c.json({ error: 'invalid_multipart' }, 400);
  }
}

async function persistNewCloudDoc(
  c: RouteContext,
  storage: CloudDocStorage,
  params: {
    userId: string;
    folderId: string | null;
    name: string;
    ext: string;
    mimeType: string;
    bytes: Buffer;
  },
): Promise<{ row: CloudDocRow; bytesWritten: number } | Response> {
  const docId = `cdoc_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const storageKey = buildCloudDocStorageKey(params.userId, docId, 1);

  let writeResult: { sizeBytes: number; sha256: string };
  try {
    writeResult = await storage.write(storageKey, params.bytes);
  } catch {
    return c.json({ error: 'cloud_doc_storage_error' }, 500);
  }

  try {
    const row = await insertCloudDoc(c.env.DB, {
      id: docId,
      userId: params.userId,
      folderId: params.folderId,
      name: params.name,
      ext: params.ext,
      mimeType: params.mimeType,
      sizeBytes: writeResult.sizeBytes,
      contentSha256: writeResult.sha256,
      storageKey,
    });
    return { row, bytesWritten: writeResult.sizeBytes };
  } catch (err) {
    if (isDefinitelyUncommittedDbError(err)) {
      await storage.delete(storageKey).catch(() => {});
    }
    return c.json({ error: 'cloud_doc_db_error' }, 500);
  }
}

async function commitUpdatedCloudDocBytes(
  c: RouteContext,
  storage: CloudDocStorage,
  params: {
    current: CloudDocRow;
    currentVersion: number;
    nextBytes: Buffer;
    name?: string;
    ext?: string;
    mimeType?: string;
    folderId?: string | null;
    hasFolderId?: boolean;
  },
): Promise<{ doc: CloudDocRow; bytesWritten: number } | Response> {
  const nextVersion = params.currentVersion + 1;
  const newStorageKey = buildCloudDocStorageKey(params.current.user_id, params.current.id, nextVersion);
  let writeResult: { sizeBytes: number; sha256: string };
  try {
    writeResult = await storage.write(newStorageKey, params.nextBytes);
  } catch {
    return c.json({ error: 'cloud_doc_storage_error' }, 500);
  }

  try {
    const committed = await commitCloudDocContent(c.env.DB, {
      docId: params.current.id,
      userId: params.current.user_id,
      expectedVersion: params.currentVersion,
      bumpVersion: true,
      newStorageKey,
      sizeBytes: writeResult.sizeBytes,
      contentSha256: writeResult.sha256,
      name: params.name,
      ext: params.ext,
      mimeType: params.mimeType,
      folderId: params.folderId,
      hasFolderId: params.hasFolderId,
    });
    if (committed.status === 'conflict') {
      await storage.delete(newStorageKey).catch(() => {});
      return c.json({ error: 'version_conflict', currentVersion: params.currentVersion }, 409);
    }
    if (params.current.storage_key !== newStorageKey) {
      await storage.delete(params.current.storage_key).catch(() => {});
    }
    return { doc: committed.doc, bytesWritten: writeResult.sizeBytes };
  } catch (err) {
    if (isDefinitelyUncommittedDbError(err)) {
      await storage.delete(newStorageKey).catch(() => {});
    }
    return c.json({ error: 'cloud_doc_db_error' }, 500);
  }
}

function buildInternalOnlyOfficeDocUrl(
  c: RouteContext,
  doc: CloudDocRow,
  docVersion: number,
  userId: string,
  actorName: string,
  ttlSeconds = 300,
): string {
  const documentKey = computeCloudDocDocumentKey(doc.id, docVersion);
  const fileToken = signCloudDocOnlyOfficeToken(
    {
      cloudDocId: doc.id,
      userId,
      actorName,
      docVersion,
      documentKey,
    },
    c.env.JWT_SIGNING_KEY,
    ttlSeconds,
  );
  const serverBaseUrl = (c.env.SERVER_URL || 'http://localhost:19138').replace(/\/$/, '');
  return `${serverBaseUrl}${CLOUD_DOCS_ONLYOFFICE_FILE_PATH}/${fileToken}`;
}

async function requireRegularUser(c: RouteContext): Promise<{ userId: string } | Response> {
  const outcome = await resolveAuthOutcome(c);
  if (!outcome.auth) {
    return authFailureResponse(c, outcome);
  }
  if (outcome.auth.scope === 'doc_collaborator') {
    return c.json({ error: 'forbidden' }, 403);
  }
  if (outcome.auth.nodeRole !== undefined || outcome.auth.serverId !== undefined) {
    if (outcome.auth.nodeRole !== NODE_ROLE.FULL || !outcome.auth.serverId) {
      return c.json({ error: 'forbidden', reason: 'controlled_node_forbidden' }, 403);
    }
    const operational = await resolveMachineOperationalUser(c.env.DB, {
      token: c.req.header(SHARED_MACHINE_AUTHORITY_HEADER),
      signingKey: c.env.JWT_SIGNING_KEY,
      authenticatedSourceServerId: outcome.auth.serverId,
      sourceOwnerUserId: outcome.auth.userId,
      now: Date.now(),
    });
    if (!operational) {
      return c.json({ error: 'forbidden', reason: 'invalid_shared_machine_authority' }, 403);
    }
    return { userId: operational.delegatedActorUserId ?? operational.userId };
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
        const access = await resolveCloudDocFolderAccess(c.env.DB, targetId, auth.userId);
        return c.json({ error: access.allowed ? 'forbidden' : 'folder_not_found' }, access.allowed ? 403 : 404);
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
        const access = await resolveCloudDocFolderAccess(c.env.DB, targetId, auth.userId);
        return c.json({ error: access.allowed ? 'forbidden' : 'folder_not_found' }, access.allowed ? 403 : 404);
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
    if (!revoked) {
      const existingShare = await getCloudDocShareById(c.env.DB, shareId);
      if (existingShare && existingShare.revoked_at === null) {
        const targetAccess = existingShare.target_kind === 'doc'
          ? await resolveCloudDocAccess(c.env.DB, existingShare.target_id, auth.userId)
          : await resolveCloudDocFolderAccess(c.env.DB, existingShare.target_id, auth.userId);
        if (targetAccess.allowed) {
          return c.json({ error: 'forbidden' }, 403);
        }
      }
      return c.json({ error: 'not_found' }, 404);
    }
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
    let folderOwnerUserId = auth.userId;
    if (parentId) {
      const parentAccess = await resolveCloudDocFolderAccess(c.env.DB, parentId, auth.userId);
      if (!parentAccess.allowed) {
        return c.json({ error: 'folder_not_found' }, 404);
      }
      if (parentAccess.role !== 'editor') {
        return c.json({ error: 'forbidden' }, 403);
      }
      folderOwnerUserId = parentAccess.folder.user_id;
    }

    const folder = await createCloudDocFolder(c.env.DB, {
      userId: folderOwnerUserId,
      name,
      parentId,
    });
    return c.json({ folder }, 201);
  });

  routes.patch('/cloud-docs/folders/:id', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const folderId = c.req.param('id');
    const folderAccess = await resolveCloudDocFolderAccess(c.env.DB, folderId, auth.userId);
    if (!folderAccess.allowed) {
      return c.json({ error: 'folder_not_found' }, 404);
    }
    if (folderAccess.role !== 'editor') {
      return c.json({ error: 'forbidden' }, 403);
    }

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
      if (!nextParentId && !folderAccess.isOwner) {
        return c.json({ error: 'forbidden' }, 403);
      }
      if (nextParentId) {
        const targetAccess = await resolveCloudDocFolderAccess(c.env.DB, nextParentId, auth.userId);
        if (!targetAccess.allowed) return c.json({ error: 'folder_not_found' }, 404);
        if (targetAccess.role !== 'editor' || targetAccess.folder.user_id !== folderAccess.folder.user_id) {
          return c.json({ error: 'forbidden' }, 403);
        }
        if (await isDescendantFolder(c.env.DB, folderAccess.folder.user_id, nextParentId, folderId)) {
          return c.json({ error: 'invalid_move' }, 400);
        }
      }
    }

    const updated = await updateCloudDocFolder(c.env.DB, {
      userId: folderAccess.folder.user_id,
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
    const folderAccess = await resolveCloudDocFolderAccess(c.env.DB, folderId, auth.userId);
    if (!folderAccess.allowed) return c.json({ error: 'folder_not_found' }, 404);
    if (!folderAccess.isOwner) return c.json({ error: 'forbidden' }, 403);

    const deleted = await deleteCloudDocFolderTree(c.env.DB, auth.userId, folderId);
    if (!deleted) return c.json({ error: 'folder_not_found' }, 404);

    // Best-effort blob cleanup strictly after DB delete commits
    await Promise.all(deleted.storageKeys.map((key) => storage.delete(key).catch(() => {})));
    return c.json({ ok: true, deletedFolderIds: deleted.deletedFolderIds });
  });

  // ── Cloud Docs: Create blank / initial-content document ─────────────────────
  routes.post('/cloud-docs/blank', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    let body: {
      type?: string;
      name?: string;
      folderId?: string | null;
      content?: unknown;
      engine?: unknown;
      docbuilderScript?: unknown;
      argument?: unknown;
      timeoutMs?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    if (!isCreateCloudDocType(body.type)) {
      return c.json({ error: 'unsupported_document_type' }, 400);
    }
    if (body.content !== undefined && typeof body.content !== 'string') {
      return c.json({ error: 'invalid_content' }, 400);
    }

    const useDocBuilder =
      body.engine === 'docbuilder' ||
      (typeof body.docbuilderScript === 'string' && body.docbuilderScript.trim().length > 0);
    let validatedBuilder: { script: string; argument?: Record<string, unknown>; timeoutMs?: number } | null = null;
    if (useDocBuilder) {
      const checked = validateDocBuilderScriptAndArgument(
        c,
        body.docbuilderScript,
        body.argument,
        body.timeoutMs,
      );
      if (checked instanceof Response) return checked;
      validatedBuilder = checked;
    }

    const folderResult = await resolveTargetFolderOwner(c, body.folderId, auth.userId);
    if (folderResult instanceof Response) return folderResult;

    const ext = `.${body.type}`;
    const defaultName = body.name?.trim() || `Untitled.${body.type}`;
    const safeName = normalizeCloudDocName(defaultName, ext);
    if (!safeName) return c.json({ error: 'invalid_name' }, 400);

    const meta = getCloudDocMeta(safeName);
    if (!meta) return c.json({ error: 'unsupported_document_type' }, 400);

    let bytes: Buffer;
    if (validatedBuilder) {
      try {
        const mergedArg =
          body.content !== undefined
            ? { content: body.content, ...(validatedBuilder.argument ?? {}) }
            : validatedBuilder.argument;
        const result = await executeOnlyOfficeDocBuilder({
          env: c.env,
          db: c.env.DB,
          script: validatedBuilder.script,
          argument: mergedArg,
          requiredExt: meta.ext,
          timeoutMs: validatedBuilder.timeoutMs,
        });
        const extMismatch = validatePersistedOutputExt(c, result.outputName, meta.ext);
        if (extMismatch) return extMismatch;
        bytes = result.bytes;
      } catch (err) {
        if (err instanceof OnlyOfficeServiceError) {
          return onlyOfficeErrorResponse(c, err);
        }
        return c.json({ error: CLOUD_DOC_ERROR_CODES.DOCBUILDER_FAILED }, 502);
      }
    } else {
      try {
        bytes = buildCloudDocBytesFromContent(ext, body.content as string | undefined);
      } catch (err) {
        if (err instanceof CloudDocContentError) {
          return c.json({ error: err.code, message: err.message }, err.statusCode);
        }
        return c.json({ error: 'unsupported_document_type' }, 400);
      }
    }

    const persisted = await persistNewCloudDoc(c, storage, {
      userId: folderResult.docOwnerUserId,
      folderId: folderResult.folderId,
      name: safeName,
      ext: meta.ext,
      mimeType: meta.mimeType,
      bytes,
    });
    if (persisted instanceof Response) return persisted;
    return c.json({ doc: rowToCloudDocItem(persisted.row) }, 201);
  });

  // ── Cloud Docs: Create document via ONLYOFFICE Document Builder ─────────────
  routes.post('/cloud-docs/docbuilder', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    let body: {
      script?: unknown;
      type?: unknown;
      name?: unknown;
      folderId?: unknown;
      argument?: unknown;
      outputName?: unknown;
      timeoutMs?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const validated = validateDocBuilderScriptAndArgument(
      c,
      body.script,
      body.argument,
      body.timeoutMs,
    );
    if (validated instanceof Response) return validated;

    let requestedType: string | undefined;
    if (body.type !== undefined) {
      if (typeof body.type !== 'string' || !body.type.trim()) {
        return c.json({ error: 'unsupported_document_type' }, 400);
      }
      const normType = body.type.trim().replace(/^\./, '').toLowerCase();
      if (!isDocBuilderOutputType(normType) || !getCloudDocMeta(`.${normType}`)) {
        return c.json({ error: 'unsupported_document_type' }, 400);
      }
      requestedType = normType;
    }

    let outputName: string | undefined;
    if (body.outputName !== undefined) {
      if (typeof body.outputName !== 'string' || !body.outputName.trim() || body.outputName.includes('/') || body.outputName.includes('\\')) {
        return c.json({ error: 'invalid_name' }, 400);
      }
      outputName = body.outputName.trim();
    }

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.includes('/') || body.name.includes('\\')) {
        return c.json({ error: 'invalid_name' }, 400);
      }
      const preCheck = requestedType
        ? normalizeCloudDocName(body.name, `.${requestedType}`)
        : normalizeCloudDocName(body.name);
      if (!preCheck) {
        return c.json({ error: 'invalid_name' }, 400);
      }
    }

    const requiredExt = requestedType
      ? `.${requestedType}`
      : (typeof body.name === 'string' && body.name.trim() ? getCloudDocMeta(body.name)?.ext : undefined);

    if (outputName && requiredExt && getCloudDocExt(outputName) !== requiredExt) {
      return c.json(
        {
          error: CLOUD_DOC_ERROR_CODES.DOCBUILDER_OUTPUT_MISMATCH,
          message: `outputName "${outputName}" does not match required extension "${requiredExt}"`,
        },
        422,
      );
    }

    const folderResult = await resolveTargetFolderOwner(c, body.folderId, auth.userId);
    if (folderResult instanceof Response) return folderResult;

    let result: Awaited<ReturnType<typeof executeOnlyOfficeDocBuilder>>;
    try {
      result = await executeOnlyOfficeDocBuilder({
        env: c.env,
        db: c.env.DB,
        script: validated.script,
        argument: validated.argument,
        outputName,
        requiredExt,
        timeoutMs: validated.timeoutMs,
      });
    } catch (err) {
      if (err instanceof OnlyOfficeServiceError) {
        return onlyOfficeErrorResponse(c, err);
      }
      return c.json({ error: CLOUD_DOC_ERROR_CODES.DOCBUILDER_FAILED }, 502);
    }

    if (requiredExt) {
      const extMismatch = validatePersistedOutputExt(c, result.outputName, requiredExt);
      if (extMismatch) return extMismatch;
    }

    const meta = getCloudDocMeta(result.outputName);
    if (!meta) {
      return c.json({ error: CLOUD_DOC_ERROR_CODES.UNSUPPORTED_FORMAT }, 422);
    }

    const rawCandidateName =
      (typeof body.name === 'string' && body.name.trim()) ||
      result.outputName ||
      `Untitled${meta.ext}`;
    const safeName = normalizeCloudDocName(rawCandidateName, meta.ext);
    if (!safeName) {
      return c.json({ error: 'invalid_name' }, 400);
    }

    const persisted = await persistNewCloudDoc(c, storage, {
      userId: folderResult.docOwnerUserId,
      folderId: folderResult.folderId,
      name: safeName,
      ext: meta.ext,
      mimeType: meta.mimeType,
      bytes: result.bytes,
    });
    if (persisted instanceof Response) return persisted;

    return c.json(
      {
        doc: rowToCloudDocItem(persisted.row),
        bytesWritten: persisted.bytesWritten,
        ...(result.onlyofficeUrls ? { onlyofficeUrls: result.onlyofficeUrls } : {}),
      },
      201,
    );
  });

  // ── Cloud Docs: Upload file (multipart/form-data) ───────────────────────────
  const handleUploadCloudDoc = async (c: RouteContext): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const form = await parseBoundedMultipartForm(c);
    if (form instanceof Response) return form;

    const fileEntry = form.get('file');
    if (!fileEntry || typeof fileEntry === 'string' || typeof (fileEntry as Blob).arrayBuffer !== 'function') {
      return c.json({ error: 'missing_file' }, 400);
    }
    const uploadedFile = fileEntry as File;
    if (uploadedFile.size > CLOUD_DOCS_MAX_UPLOAD_BYTES) {
      return c.json({ error: FS_GENERIC_ERROR_CODES.FILE_TOO_LARGE, maxBytes: CLOUD_DOCS_MAX_UPLOAD_BYTES }, 413);
    }

    const rawFolderId = form.get('folderId');
    if (rawFolderId !== null && typeof rawFolderId !== 'string') {
      return c.json({ error: 'invalid_folder_id' }, 400);
    }
    const folderResult = await resolveTargetFolderOwner(c, rawFolderId, auth.userId);
    if (folderResult instanceof Response) return folderResult;

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
      return c.json({ error: FS_GENERIC_ERROR_CODES.FILE_TOO_LARGE, maxBytes: CLOUD_DOCS_MAX_UPLOAD_BYTES }, 413);
    }

    const persisted = await persistNewCloudDoc(c, storage, {
      userId: folderResult.docOwnerUserId,
      folderId: folderResult.folderId,
      name: safeName,
      ext: meta.ext,
      mimeType: meta.mimeType,
      bytes,
    });
    if (persisted instanceof Response) return persisted;
    return c.json({ doc: rowToCloudDocItem(persisted.row) }, 201);
  };
  routes.post('/cloud-docs/files', handleUploadCloudDoc);
  routes.post('/cloud-docs/upload', handleUploadCloudDoc);

  // ── Cloud Docs: Ephemeral ONLYOFFICE DocBuilder script download ─────────────
  routes.get('/cloud-docs/onlyoffice/script/:token', async (c): Promise<Response> => {
    const token = c.req.param('token') ?? '';
    const claims = verifyDocBuilderScriptToken(token, c.env.JWT_SIGNING_KEY);
    if (!claims) {
      return c.json({ error: 'invalid_script_token' }, 401);
    }

    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const ooSecret = resolveOnlyOfficeJwtSecret(c.env);
      const verified = verifyJwt(authHeader.slice(7), ooSecret);
      if (!verified) {
        return c.json({ error: 'invalid_onlyoffice_jwt' }, 401);
      }
    }

    const scriptStore = createDbDocBuilderScriptStore(c.env.DB);
    const script = await scriptStore.consume(claims.scriptId, {
      peekOnly: c.req.method === 'HEAD',
    });
    if (!script) {
      return c.json({ error: 'script_not_found' }, 404);
    }

    return new Response(script, {
      status: 200,
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(script, 'utf8')),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  });

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
        return c.json({ error: 1, message: FS_GENERIC_ERROR_CODES.FILE_TOO_LARGE }, 413);
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

      const currentVersion = parseCloudDocVersion(current.doc_version);
      if (currentVersion === null) {
        return c.json({ error: 1, message: 'cloud_doc_invalid_version' }, 500);
      }
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

    const docVersion = parseCloudDocVersion(row.doc_version);
    if (docVersion === null) {
      return c.json({ error: 'cloud_doc_invalid_version' }, 500);
    }
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

    // Automatically record non-Markdown ONLYOFFICE opens into recent_documents & touch last_opened_at (best-effort).
    // Markdown (.md) docs are recorded only after the frontend ONLYOFFICE component confirms DocsAPI initialization.
    try {
      await touchCloudDocOpened(c.env.DB, row.id);
      if (!isMarkdownFilePath(row.name, row.mime_type)) {
        await upsertRecentDocument(c.env.DB, {
          userId: auth.userId,
          sourceKind: 'cloud_doc',
          cloudDocId: row.id,
          title: row.name,
          mimeType: row.mime_type,
          openMode: effectiveMode,
          openedWithOnlyOffice: true,
        });
      }
    } catch {
      // Do not block opening document if recent history write fails transiently
    }

    const canEdit = effectiveMode === 'edit' && canUserEdit;
    const isMobile = parseOnlyOfficeMobileParam(c.req.query('mobile'));
    const presentation = buildOnlyOfficeEditorPresentation({
      mode: effectiveMode,
      mobile: isMobile,
    });
    const editorConfigPayload = {
      ...(presentation.type ? { type: presentation.type } : {}),
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
        customization: presentation.customization,
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

  // ── Cloud Docs: Read extracted text / structured content ──────────────────
  routes.get('/cloud-docs/:id/content', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const docId = c.req.param('id');
    const access = await resolveCloudDocAccess(c.env.DB, docId, auth.userId);
    if (!access.allowed) {
      return c.json({ error: 'not_found' }, 404);
    }

    if (!(await storage.exists(access.doc.storage_key))) {
      return c.json({ error: 'cloud_doc_file_missing' }, 404);
    }

    const rawMaxChars = Number(c.req.query('maxChars'));
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars > 0
      ? Math.min(Math.floor(rawMaxChars), CLOUD_DOC_CONTENT_MAX_CHARS)
      : CLOUD_DOC_CONTENT_MAX_CHARS;

    let bytes: Buffer;
    try {
      bytes = await storage.read(access.doc.storage_key);
    } catch {
      return c.json({ error: 'cloud_doc_storage_error' }, 500);
    }

    try {
      const extracted = extractCloudDocContent(access.doc.ext, bytes, maxChars);
      return c.json({
        doc: rowToCloudDocItem(access.doc),
        role: access.isOwner ? 'owner' : access.role,
        allowDownload: access.allowDownload,
        ...extracted,
      });
    } catch (err) {
      if (err instanceof CloudDocContentError) {
        return c.json({ error: err.code, message: err.message }, err.statusCode);
      }
      return c.json({ error: 'unsupported_document_type' }, 400);
    }
  });

  // ── Cloud Docs: Edit / Replace / Append document content ────────────────────
  routes.put('/cloud-docs/:id/content', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const docId = c.req.param('id');
    const initialAccess = await resolveCloudDocAccess(c.env.DB, docId, auth.userId);
    if (!initialAccess.allowed) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (initialAccess.role !== 'editor') {
      return c.json({ error: 'forbidden' }, 403);
    }

    let body: {
      content?: unknown;
      mode?: unknown;
      expectedVersion?: unknown;
      name?: unknown;
      folderId?: unknown;
      engine?: unknown;
      docbuilderScript?: unknown;
      argument?: unknown;
      timeoutMs?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const useDocBuilder =
      body.engine === 'docbuilder' ||
      (typeof body.docbuilderScript === 'string' && body.docbuilderScript.trim().length > 0);
    let validatedBuilder: { script: string; argument?: Record<string, unknown>; timeoutMs?: number } | null = null;
    if (useDocBuilder) {
      const checked = validateDocBuilderScriptAndArgument(
        c,
        body.docbuilderScript,
        body.argument,
        body.timeoutMs,
      );
      if (checked instanceof Response) return checked;
      validatedBuilder = checked;
      if (body.content !== undefined && typeof body.content !== 'string') {
        return c.json({ error: 'invalid_content' }, 400);
      }
    } else if (typeof body.content !== 'string') {
      return c.json({ error: 'invalid_content' }, 400);
    }

    const mode: CloudDocEditMode = body.mode === undefined ? 'replace' : (body.mode as CloudDocEditMode);
    if (!(CLOUD_DOC_EDIT_MODES as readonly string[]).includes(mode)) {
      return c.json({ error: 'invalid_mode' }, 400);
    }
    if (body.expectedVersion !== undefined && (!Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 1)) {
      return c.json({ error: 'invalid_expected_version' }, 400);
    }
    if (body.name !== undefined && typeof body.name !== 'string') {
      return c.json({ error: 'invalid_name' }, 400);
    }
    const hasFolderId = Object.prototype.hasOwnProperty.call(body, 'folderId') && body.folderId !== undefined;
    if (hasFolderId && body.folderId !== null && typeof body.folderId !== 'string') {
      return c.json({ error: 'invalid_folder_id' }, 400);
    }

    return lockCloudDocCommit(docId, async () => {
      const liveAccess = await resolveCloudDocAccess(c.env.DB, docId, auth.userId);
      if (!liveAccess.allowed) return c.json({ error: 'not_found' }, 404);
      if (liveAccess.role !== 'editor') return c.json({ error: 'forbidden' }, 403);

      const current = liveAccess.doc;
      const currentVersion = parseCloudDocVersion(current.doc_version);
      if (currentVersion === null) {
        return c.json({ error: 'cloud_doc_invalid_version' }, 500);
      }
      if (typeof body.expectedVersion === 'number' && body.expectedVersion !== currentVersion) {
        return c.json({ error: 'version_conflict', currentVersion }, 409);
      }

      // Validate all metadata and ACL constraints before touching storage so combined
      // content + metadata edits are all-or-nothing.
      let nextName: string | undefined;
      let nextExt: string | undefined;
      let nextMime: string | undefined;
      if (typeof body.name === 'string') {
        const normalized = normalizeCloudDocName(body.name, current.ext);
        if (!normalized) return c.json({ error: 'invalid_name' }, 400);
        const meta = getCloudDocMeta(normalized);
        if (!meta) return c.json({ error: 'unsupported_document_type' }, 400);
        if (meta.ext !== current.ext) {
          return c.json({ error: 'unsupported_content_edit', message: 'Cannot change document extension during content edit' }, 400);
        }
        nextName = normalized;
        nextExt = meta.ext;
        nextMime = meta.mimeType;
      }

      let nextFolderId: string | null = null;
      if (hasFolderId) {
        const moveResult = await resolveExistingDocMoveFolder(
          c,
          body.folderId,
          auth.userId,
          current.user_id,
          liveAccess.isOwner,
        );
        if (moveResult instanceof Response) return moveResult;
        nextFolderId = moveResult.folderId;
      }

      let nextBytes: Buffer;
      if (validatedBuilder) {
        if (!(await storage.exists(current.storage_key))) {
          return c.json({ error: 'cloud_doc_file_missing' }, 404);
        }
        const inputUrl = buildInternalOnlyOfficeDocUrl(c, current, currentVersion, auth.userId, 'docbuilder');
        const effectiveArgument: Record<string, unknown> = {
          ...(validatedBuilder.argument ?? {}),
          ...(body.content !== undefined ? { content: body.content } : {}),
          mode,
          inputUrl,
          _imcodesInputUrl: inputUrl,
        };
        const targetExt = nextExt ?? current.ext;
        try {
          const result = await executeOnlyOfficeDocBuilder({
            env: c.env,
            db: c.env.DB,
            script: validatedBuilder.script,
            argument: effectiveArgument,
            requiredExt: targetExt,
            timeoutMs: validatedBuilder.timeoutMs,
          });
          const extMismatch = validatePersistedOutputExt(c, result.outputName, targetExt);
          if (extMismatch) return extMismatch;
          nextBytes = result.bytes;
        } catch (err) {
          if (err instanceof OnlyOfficeServiceError) {
            return onlyOfficeErrorResponse(c, err);
          }
          return c.json({ error: CLOUD_DOC_ERROR_CODES.DOCBUILDER_FAILED }, 502);
        }
      } else {
        let existingBytes: Buffer = Buffer.alloc(0);
        if (mode === 'append') {
          if (!(await storage.exists(current.storage_key))) {
            return c.json({ error: 'cloud_doc_file_missing' }, 404);
          }
          try {
            existingBytes = await storage.read(current.storage_key);
          } catch {
            return c.json({ error: 'cloud_doc_storage_error' }, 500);
          }
        }

        try {
          nextBytes = applyCloudDocContentEdit({
            ext: current.ext,
            existingBytes,
            mode,
            content: body.content as string,
          });
        } catch (err) {
          if (err instanceof CloudDocContentError) {
            return c.json({ error: err.code, message: err.message }, err.statusCode);
          }
          return c.json({ error: 'unsupported_document_type' }, 400);
        }
      }

      const committed = await commitUpdatedCloudDocBytes(c, storage, {
        current,
        currentVersion,
        nextBytes,
        name: nextName,
        ext: nextExt,
        mimeType: nextMime,
        folderId: nextFolderId,
        hasFolderId,
      });
      if (committed instanceof Response) return committed;

      return c.json({
        ok: true,
        doc: rowToCloudDocItem(committed.doc),
        role: liveAccess.isOwner ? 'owner' : liveAccess.role,
        bytesWritten: committed.bytesWritten,
      });
    });
  });

  // ── Cloud Docs: Run ONLYOFFICE DocBuilder against existing document ─────────
  routes.post('/cloud-docs/:id/docbuilder', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const docId = c.req.param('id');
    const initialAccess = await resolveCloudDocAccess(c.env.DB, docId, auth.userId);
    if (!initialAccess.allowed) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (initialAccess.role !== 'editor') {
      return c.json({ error: 'forbidden' }, 403);
    }

    let body: {
      script?: unknown;
      argument?: unknown;
      outputType?: unknown;
      outputName?: unknown;
      save?: unknown;
      expectedVersion?: unknown;
      name?: unknown;
      folderId?: unknown;
      timeoutMs?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const validated = validateDocBuilderScriptAndArgument(
      c,
      body.script,
      body.argument,
      body.timeoutMs,
    );
    if (validated instanceof Response) return validated;

    const save = body.save === undefined ? true : body.save;
    if (typeof save !== 'boolean') {
      return c.json({ error: 'invalid_save' }, 400);
    }
    if (body.expectedVersion !== undefined && (!Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 1)) {
      return c.json({ error: 'invalid_expected_version' }, 400);
    }

    let targetOutputExt: string | undefined;
    if (body.outputType !== undefined) {
      if (typeof body.outputType !== 'string' || !body.outputType.trim()) {
        return c.json({ error: 'unsupported_document_type' }, 400);
      }
      const normType = body.outputType.trim().replace(/^\./, '').toLowerCase();
      if (!isDocBuilderOutputType(normType) || (save && !getCloudDocMeta(`.${normType}`))) {
        return c.json({ error: 'unsupported_document_type' }, 400);
      }
      targetOutputExt = `.${normType}`;
    }

    let outputName: string | undefined;
    if (body.outputName !== undefined) {
      if (typeof body.outputName !== 'string' || !body.outputName.trim() || body.outputName.includes('/') || body.outputName.includes('\\')) {
        return c.json({ error: 'invalid_name' }, 400);
      }
      outputName = body.outputName.trim();
    }

    if (body.name !== undefined && typeof body.name !== 'string') {
      return c.json({ error: 'invalid_name' }, 400);
    }
    const hasFolderId = Object.prototype.hasOwnProperty.call(body, 'folderId') && body.folderId !== undefined;
    if (hasFolderId && body.folderId !== null && typeof body.folderId !== 'string') {
      return c.json({ error: 'invalid_folder_id' }, 400);
    }

    return lockCloudDocCommit(docId, async () => {
      const liveAccess = await resolveCloudDocAccess(c.env.DB, docId, auth.userId);
      if (!liveAccess.allowed) return c.json({ error: 'not_found' }, 404);
      if (liveAccess.role !== 'editor') return c.json({ error: 'forbidden' }, 403);

      const current = liveAccess.doc;
      const currentVersion = parseCloudDocVersion(current.doc_version);
      if (currentVersion === null) {
        return c.json({ error: 'cloud_doc_invalid_version' }, 500);
      }
      if (typeof body.expectedVersion === 'number' && body.expectedVersion !== currentVersion) {
        return c.json({ error: 'version_conflict', currentVersion }, 409);
      }
      if (!(await storage.exists(current.storage_key))) {
        return c.json({ error: 'cloud_doc_file_missing' }, 404);
      }

      let nextName: string | undefined;
      let nextExt: string | undefined;
      let nextMime: string | undefined;
      let nextFolderId: string | null = null;
      const effectiveExt = targetOutputExt ?? current.ext;

      if (save) {
        if (typeof body.name === 'string') {
          if (body.name.includes('/') || body.name.includes('\\')) {
            return c.json({ error: 'invalid_name' }, 400);
          }
          const normalized = normalizeCloudDocName(body.name, effectiveExt);
          if (!normalized) return c.json({ error: 'invalid_name' }, 400);
          const meta = getCloudDocMeta(normalized);
          if (!meta) return c.json({ error: 'unsupported_document_type' }, 400);
          nextName = normalized;
          nextExt = meta.ext;
          nextMime = meta.mimeType;
        } else if (targetOutputExt && targetOutputExt !== current.ext) {
          const meta = getCloudDocMeta(targetOutputExt);
          if (!meta) return c.json({ error: 'unsupported_document_type' }, 400);
          const stem = current.name.endsWith(current.ext)
            ? current.name.slice(0, -current.ext.length)
            : current.name;
          const renamed = normalizeCloudDocName(`${stem || 'Untitled'}${targetOutputExt}`, targetOutputExt);
          if (!renamed) return c.json({ error: 'invalid_name' }, 400);
          nextName = renamed;
          nextExt = meta.ext;
          nextMime = meta.mimeType;
        }

        if (hasFolderId) {
          const moveResult = await resolveExistingDocMoveFolder(
            c,
            body.folderId,
            auth.userId,
            current.user_id,
            liveAccess.isOwner,
          );
          if (moveResult instanceof Response) return moveResult;
          nextFolderId = moveResult.folderId;
        }
      }

      const persistedExt = save ? (nextExt ?? current.ext) : targetOutputExt;
      if (outputName && persistedExt && getCloudDocExt(outputName) !== persistedExt) {
        return c.json(
          {
            error: CLOUD_DOC_ERROR_CODES.DOCBUILDER_OUTPUT_MISMATCH,
            message: `outputName "${outputName}" does not match required extension "${persistedExt}"`,
          },
          422,
        );
      }

      const inputUrl = buildInternalOnlyOfficeDocUrl(c, current, currentVersion, auth.userId, 'docbuilder');
      const effectiveArgument: Record<string, unknown> = {
        ...(validated.argument ?? {}),
        inputUrl,
        _imcodesInputUrl: inputUrl,
      };

      let result: Awaited<ReturnType<typeof executeOnlyOfficeDocBuilder>>;
      try {
        result = await executeOnlyOfficeDocBuilder({
          env: c.env,
          db: c.env.DB,
          script: validated.script,
          argument: effectiveArgument,
          outputName,
          requiredExt: persistedExt,
          timeoutMs: validated.timeoutMs,
        });
      } catch (err) {
        if (err instanceof OnlyOfficeServiceError) {
          return onlyOfficeErrorResponse(c, err);
        }
        return c.json({ error: CLOUD_DOC_ERROR_CODES.DOCBUILDER_FAILED }, 502);
      }

      if (!save) {
        return c.json({
          doc: rowToCloudDocItem(current),
          bytesBase64: result.bytes.toString('base64'),
          outputName: result.outputName,
          mimeType: result.mimeType,
          bytesWritten: result.bytes.length,
          ...(result.onlyofficeUrls ? { onlyofficeUrls: result.onlyofficeUrls } : {}),
        });
      }

      const saveExtMismatch = validatePersistedOutputExt(c, result.outputName, nextExt ?? current.ext);
      if (saveExtMismatch) return saveExtMismatch;

      const committed = await commitUpdatedCloudDocBytes(c, storage, {
        current,
        currentVersion,
        nextBytes: result.bytes,
        name: nextName,
        ext: nextExt,
        mimeType: nextMime,
        folderId: nextFolderId,
        hasFolderId,
      });
      if (committed instanceof Response) return committed;

      return c.json({
        doc: rowToCloudDocItem(committed.doc),
        role: liveAccess.isOwner ? 'owner' : liveAccess.role,
        bytesWritten: committed.bytesWritten,
        ...(result.onlyofficeUrls ? { onlyofficeUrls: result.onlyofficeUrls } : {}),
      });
    });
  });

  // ── Cloud Docs: Convert document via ONLYOFFICE Converter ─────────────────
  routes.post('/cloud-docs/:id/convert', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const docId = c.req.param('id');
    const access = await resolveCloudDocAccess(c.env.DB, docId, auth.userId);
    if (!access.allowed) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (!access.allowDownload && access.role !== 'editor') {
      return c.json({ error: CLOUD_DOC_ERROR_CODES.DOWNLOAD_FORBIDDEN }, 403);
    }

    let body: {
      targetType?: unknown;
      saveAsNew?: unknown;
      name?: unknown;
      folderId?: unknown;
      timeoutMs?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    if (typeof body.targetType !== 'string' || !body.targetType.trim()) {
      return c.json({ error: 'unsupported_document_type' }, 400);
    }
    const targetType = body.targetType.trim().replace(/^\./, '').toLowerCase();
    if (!isConvertTargetType(targetType)) {
      return c.json({ error: 'unsupported_document_type' }, 400);
    }

    if (body.saveAsNew !== undefined && typeof body.saveAsNew !== 'boolean') {
      return c.json({ error: 'invalid_save_as_new' }, 400);
    }
    const saveAsNew = body.saveAsNew === true;
    if (saveAsNew && !getCloudDocMeta(`.${targetType}`)) {
      return c.json({ error: 'unsupported_document_type' }, 400);
    }

    const timeout = validateTimeoutMs(body.timeoutMs, CLOUD_DOC_CONVERT_MAX_TIMEOUT_MS);
    if (!timeout.ok) {
      return c.json({ error: timeout.error }, 400);
    }

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.includes('/') || body.name.includes('\\')) {
        return c.json({ error: 'invalid_name' }, 400);
      }
      if (saveAsNew && !normalizeCloudDocName(body.name, `.${targetType}`)) {
        return c.json({ error: 'invalid_name' }, 400);
      }
    }

    let folderTarget: { folderId: string | null; docOwnerUserId: string } | null = null;
    if (saveAsNew) {
      const folderResult = await resolveTargetFolderOwner(c, body.folderId, auth.userId);
      if (folderResult instanceof Response) return folderResult;
      folderTarget = folderResult;
    }

    const current = access.doc;
    if (!(await storage.exists(current.storage_key))) {
      return c.json({ error: 'cloud_doc_file_missing' }, 404);
    }

    const currentVersion = parseCloudDocVersion(current.doc_version);
    if (currentVersion === null) {
      return c.json({ error: 'cloud_doc_invalid_version' }, 500);
    }

    const fileUrl = buildInternalOnlyOfficeDocUrl(c, current, currentVersion, auth.userId, 'converter');
    const sourceFileType = current.ext.replace(/^\./, '').toLowerCase();
    const convertKey = `${computeCloudDocDocumentKey(current.id, currentVersion)}_${randomHex(4)}`;

    let converted: Awaited<ReturnType<typeof convertViaOnlyOfficeConverter>>;
    try {
      converted = await convertViaOnlyOfficeConverter({
        env: c.env,
        fileUrl,
        filetype: sourceFileType,
        outputtype: targetType,
        title: current.name,
        key: convertKey,
        timeoutMs: timeout.value,
      });
    } catch (err) {
      if (err instanceof OnlyOfficeServiceError) {
        return onlyOfficeErrorResponse(c, err);
      }
      return c.json({ error: CLOUD_DOC_ERROR_CODES.CONVERTER_FAILED }, 502);
    }

    const stem = current.name.endsWith(current.ext)
      ? current.name.slice(0, -current.ext.length)
      : current.name;

    if (saveAsNew && folderTarget) {
      const rawName = (typeof body.name === 'string' && body.name.trim()) || `${stem || 'Untitled'}.${converted.fileType}`;
      const safeName = normalizeCloudDocName(rawName, `.${converted.fileType}`);
      if (!safeName) return c.json({ error: 'invalid_name' }, 400);
      const meta = getCloudDocMeta(safeName);
      if (!meta) return c.json({ error: 'unsupported_document_type' }, 400);

      const persisted = await persistNewCloudDoc(c, storage, {
        userId: folderTarget.docOwnerUserId,
        folderId: folderTarget.folderId,
        name: safeName,
        ext: meta.ext,
        mimeType: meta.mimeType,
        bytes: converted.bytes,
      });
      if (persisted instanceof Response) return persisted;
      return c.json({ doc: rowToCloudDocItem(persisted.row), bytesWritten: persisted.bytesWritten }, 201);
    }

    const fileName =
      typeof body.name === 'string' && body.name.trim()
        ? path.posix.basename(body.name.trim())
        : `${stem || 'Untitled'}.${converted.fileType}`;

    return c.json({
      fileName,
      mimeType: converted.mimeType,
      bytesWritten: converted.bytes.length,
      bytesBase64: converted.bytes.toString('base64'),
    });
  });

  // ── Cloud Docs: In-place raw binary file update (multipart/form-data) ───────
  routes.put('/cloud-docs/:id/file', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const docId = c.req.param('id');
    const initialAccess = await resolveCloudDocAccess(c.env.DB, docId, auth.userId);
    if (!initialAccess.allowed) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (initialAccess.role !== 'editor') {
      return c.json({ error: 'forbidden' }, 403);
    }

    const form = await parseBoundedMultipartForm(c);
    if (form instanceof Response) return form;

    const fileEntry = form.get('file');
    if (!fileEntry || typeof fileEntry === 'string' || typeof (fileEntry as Blob).arrayBuffer !== 'function') {
      return c.json({ error: 'missing_file' }, 400);
    }
    const uploadedFile = fileEntry as File;
    if (uploadedFile.size > CLOUD_DOCS_MAX_UPLOAD_BYTES) {
      return c.json({ error: FS_GENERIC_ERROR_CODES.FILE_TOO_LARGE, maxBytes: CLOUD_DOCS_MAX_UPLOAD_BYTES }, 413);
    }

    let expectedVersion: number | undefined;
    const rawExpectedVersion = form.get('expectedVersion');
    if (rawExpectedVersion !== null) {
      if (typeof rawExpectedVersion !== 'string') {
        return c.json({ error: 'invalid_expected_version' }, 400);
      }
      const trimmed = rawExpectedVersion.trim();
      if (trimmed.length > 0) {
        if (!/^\d+$/.test(trimmed)) {
          return c.json({ error: 'invalid_expected_version' }, 400);
        }
        const parsed = Number(trimmed);
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          return c.json({ error: 'invalid_expected_version' }, 400);
        }
        expectedVersion = parsed;
      }
    }

    const rawName = form.get('name');
    if (rawName !== null && typeof rawName !== 'string') {
      return c.json({ error: 'invalid_name' }, 400);
    }
    let nextName: string | undefined;
    let nextExt: string | undefined;
    let nextMime: string | undefined;
    if (typeof rawName === 'string' && rawName.trim()) {
      if (rawName.includes('/') || rawName.includes('\\')) {
        return c.json({ error: 'invalid_name' }, 400);
      }
      const normalized = normalizeCloudDocName(rawName.trim());
      if (!normalized) {
        return c.json({ error: 'unsupported_document_type' }, 400);
      }
      const meta = getCloudDocMeta(normalized);
      if (!meta) {
        return c.json({ error: 'unsupported_document_type' }, 400);
      }
      nextName = normalized;
      nextExt = meta.ext;
      nextMime = meta.mimeType;
    }

    const hasFolderId = form.has('folderId');
    const rawFolderId = hasFolderId ? form.get('folderId') : undefined;
    if (hasFolderId && rawFolderId !== null && typeof rawFolderId !== 'string') {
      return c.json({ error: 'invalid_folder_id' }, 400);
    }

    const arrayBuf = await uploadedFile.arrayBuffer();
    const bytes = Buffer.from(arrayBuf);
    if (bytes.length > CLOUD_DOCS_MAX_UPLOAD_BYTES) {
      return c.json({ error: FS_GENERIC_ERROR_CODES.FILE_TOO_LARGE, maxBytes: CLOUD_DOCS_MAX_UPLOAD_BYTES }, 413);
    }

    return lockCloudDocCommit(docId, async () => {
      const liveAccess = await resolveCloudDocAccess(c.env.DB, docId, auth.userId);
      if (!liveAccess.allowed) return c.json({ error: 'not_found' }, 404);
      if (liveAccess.role !== 'editor') return c.json({ error: 'forbidden' }, 403);

      const current = liveAccess.doc;
      const currentVersion = parseCloudDocVersion(current.doc_version);
      if (currentVersion === null) {
        return c.json({ error: 'cloud_doc_invalid_version' }, 500);
      }
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        return c.json({ error: 'version_conflict', currentVersion }, 409);
      }

      let nextFolderId: string | null = null;
      if (hasFolderId) {
        const moveResult = await resolveExistingDocMoveFolder(
          c,
          rawFolderId,
          auth.userId,
          current.user_id,
          liveAccess.isOwner,
        );
        if (moveResult instanceof Response) return moveResult;
        nextFolderId = moveResult.folderId;
      }

      const committed = await commitUpdatedCloudDocBytes(c, storage, {
        current,
        currentVersion,
        nextBytes: bytes,
        name: nextName,
        ext: nextExt,
        mimeType: nextMime,
        folderId: nextFolderId,
        hasFolderId,
      });
      if (committed instanceof Response) return committed;

      return c.json({
        ok: true,
        doc: rowToCloudDocItem(committed.doc),
        role: liveAccess.isOwner ? 'owner' : liveAccess.role,
        bytesWritten: committed.bytesWritten,
      });
    });
  });

  // ── Cloud Docs: Rename / Move ───────────────────────────────────────────────
  routes.patch('/cloud-docs/:id', async (c): Promise<Response> => {
    const auth = await requireRegularUser(c);
    if (auth instanceof Response) return auth;

    const docId = c.req.param('id');

    let body: { name?: unknown; folderId?: unknown; expectedVersion?: unknown };
    try {
      body = (await c.req.json()) as { name?: unknown; folderId?: unknown; expectedVersion?: unknown };
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    if (body.expectedVersion !== undefined && (!Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 1)) {
      return c.json({ error: 'invalid_expected_version' }, 400);
    }
    if (body.name !== undefined && typeof body.name !== 'string') {
      return c.json({ error: 'invalid_name' }, 400);
    }
    const hasFolderId = Object.prototype.hasOwnProperty.call(body, 'folderId') && body.folderId !== undefined;
    if (hasFolderId && body.folderId !== null && typeof body.folderId !== 'string') {
      return c.json({ error: 'invalid_folder_id' }, 400);
    }

    return lockCloudDocCommit(docId, async () => {
      const access = await resolveCloudDocAccess(c.env.DB, docId, auth.userId);
      if (!access.allowed) {
        return c.json({ error: 'not_found' }, 404);
      }
      if (access.role !== 'editor') {
        return c.json({ error: 'forbidden' }, 403);
      }
      const existing = access.doc;
      const currentVersion = parseCloudDocVersion(existing.doc_version);
      if (currentVersion === null) {
        return c.json({ error: 'cloud_doc_invalid_version' }, 500);
      }
      if (typeof body.expectedVersion === 'number' && body.expectedVersion !== currentVersion) {
        return c.json({ error: 'version_conflict', currentVersion }, 409);
      }

      let nextName: string | undefined;
      let nextExt: string | undefined;
      let nextMime: string | undefined;
      if (typeof body.name === 'string') {
        const normalized = normalizeCloudDocName(body.name, existing.ext);
        if (!normalized) return c.json({ error: 'invalid_name' }, 400);
        const meta = getCloudDocMeta(normalized);
        if (!meta) return c.json({ error: 'unsupported_document_type' }, 400);
        nextName = normalized;
        nextExt = meta.ext;
        nextMime = meta.mimeType;
      }

      let nextFolderId: string | null = null;
      if (hasFolderId) {
        nextFolderId = typeof body.folderId === 'string' && body.folderId.trim()
          ? body.folderId.trim()
          : null;
        if (!nextFolderId && !access.isOwner) {
          return c.json({ error: 'forbidden' }, 403);
        }
        if (nextFolderId) {
          const folderAccess = await resolveCloudDocFolderAccess(c.env.DB, nextFolderId, auth.userId);
          if (!folderAccess.allowed) return c.json({ error: 'folder_not_found' }, 404);
          if (folderAccess.role !== 'editor' || folderAccess.folder.user_id !== existing.user_id) {
            return c.json({ error: 'forbidden' }, 403);
          }
        }
      }

      const updated = await updateCloudDocMetadata(c.env.DB, {
        userId: existing.user_id,
        docId,
        expectedVersion: currentVersion,
        name: nextName,
        ext: nextExt,
        mimeType: nextMime,
        folderId: nextFolderId,
        hasFolderId,
      });
      if (!updated) return c.json({ error: 'version_conflict', currentVersion }, 409);

      return c.json({ doc: rowToCloudDocItem(updated) });
    });
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
      openedWithOnlyOffice?: boolean;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const openedWithOnlyOffice = body.openedWithOnlyOffice === true;

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
      if (isMarkdownFilePath(doc.name, doc.mime_type)) {
        if (c.env.ONLYOFFICE_ENABLED !== 'true') {
          return c.json({ error: 'onlyoffice_disabled' }, 400);
        }
        if (!openedWithOnlyOffice) {
          return c.json({ error: 'markdown_requires_onlyoffice' }, 400);
        }
      }
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
        openedWithOnlyOffice,
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
      if (!serverId || !normPath || isInternalUploadTempFilePath(normPath)) {
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
      if (isMarkdownFilePath(normPath, mimeType) || isMarkdownFilePath(title, mimeType)) {
        if (c.env.ONLYOFFICE_ENABLED !== 'true') {
          return c.json({ error: 'onlyoffice_disabled' }, 400);
        }
        if (!openedWithOnlyOffice) {
          return c.json({ error: 'markdown_requires_onlyoffice' }, 400);
        }
      }
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
        openedWithOnlyOffice,
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
