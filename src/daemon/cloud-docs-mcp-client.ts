import { basename } from 'node:path';
import {
  CLOUD_DOCS_API_PATH,
  CLOUD_DOCS_CONVERT_SUBPATH,
  CLOUD_DOCS_DOCBUILDER_SUBPATH,
  CLOUD_DOCS_FILE_SUBPATH,
  CLOUD_DOC_CONVERT_DEFAULT_TIMEOUT_MS,
  CLOUD_DOC_DOCBUILDER_DEFAULT_TIMEOUT_MS,
  RECENT_DOCUMENTS_API_PATH,
  type CloudDocContentPayload,
  type CloudDocConvertRequest,
  type CloudDocConvertResponse,
  type CloudDocCreateType,
  type CloudDocDocBuilderCreateRequest,
  type CloudDocDocBuilderCreateResponse,
  type CloudDocDocBuilderEditRequest,
  type CloudDocDocBuilderEditResponse,
  type CloudDocEditMode,
  type CloudDocFileUpdateResponse,
  type CloudDocFolder,
  type CloudDocItem,
  type CloudDocShareMode,
  type CloudDocShareRecord,
  type CloudDocShareRole,
  type CloudDocShareTargetKind,
  type CloudDocTeamOption,
  type RecentDocumentItem,
  type SharedCloudDocItem,
  type SharedCloudFolderItem,
} from '../../shared/cloud-docs.js';
import { daemonApiUrl, type DaemonHttpMethod } from '../../shared/daemon-token-routes.js';
import { daemonServerAuthHeaders } from '../../shared/daemon-server-auth.js';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../shared/shared-machine-authority.js';
import { sanitizeMcpErrorMessage } from '../../shared/mcp-error-sanitize.js';
import { MCP_ERROR_REASONS, type MCPErrorReason } from '../../shared/memory-mcp-errors.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const HEAVY_TRANSFER_TIMEOUT_MS = 60_000;
const LONG_RUNNING_TIMEOUT_HEADROOM_MS = 15_000;

export interface CloudDocsHttpCredentials {
  serverUrl: string;
  serverId: string;
  token: string;
  sharedMachineAuthority?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type CloudDocsClientResult<T extends object> =
  | ({ status: 'ok' } & T)
  | { status: 'error'; reason: MCPErrorReason; message: string; code?: string; httpStatus?: number };

export function sanitizeCloudDocTransferFilename(raw: string): string {
  const parts = raw.trim().split(/[/\\]+/).filter((part) => part.length > 0 && part !== '.' && part !== '..');
  const last = parts.at(-1) ?? '';
  return last ? basename(last) : 'document';
}

export function parseContentDispositionFileName(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const starMatch = /filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;\r\n]+)/i.exec(header);
  if (starMatch?.[1]) {
    try {
      const decoded = decodeURIComponent(starMatch[1].trim().replace(/^["']|["']$/g, ''));
      const clean = sanitizeCloudDocTransferFilename(decoded);
      if (clean && clean !== 'document') return clean;
    } catch {
      // Fall through to plain filename parameter parsing.
    }
  }
  const plainMatch = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;\r\n]+)/i.exec(header);
  const rawName = (plainMatch?.[1] ?? plainMatch?.[2] ?? '').trim();
  if (!rawName) return undefined;
  return sanitizeCloudDocTransferFilename(rawName);
}

function mapHttpFailure(status: number, body: Record<string, unknown>): CloudDocsClientResult<never> {
  const errCode = typeof body.error === 'string' ? body.error : '';
  const errMsg = typeof body.message === 'string' && body.message ? `${errCode ? `${errCode}: ` : ''}${body.message}` : errCode;
  const reason: MCPErrorReason =
    status === 401
      ? MCP_ERROR_REASONS.IDENTITY_REJECTED
      : status === 403
        ? MCP_ERROR_REASONS.SCOPE_FORBIDDEN
        : status === 409
          ? MCP_ERROR_REASONS.REVISION_CONFLICT
          : status === 400 || status === 404 || status === 413 || status === 422
            ? MCP_ERROR_REASONS.VALIDATION_FAILED
            : MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE;
  return {
    status: 'error',
    reason,
    message: sanitizeMcpErrorMessage(errMsg || `cloud docs request failed (${status})`),
    ...(errCode ? { code: errCode } : {}),
    httpStatus: status,
  };
}

async function executeCloudDocsFetch<T extends object>(
  creds: CloudDocsHttpCredentials,
  method: DaemonHttpMethod,
  apiPath: string,
  init: { jsonBody?: unknown; formData?: FormData; binaryResponse?: false; timeoutMs?: number },
): Promise<CloudDocsClientResult<T>>;
async function executeCloudDocsFetch(
  creds: CloudDocsHttpCredentials,
  method: DaemonHttpMethod,
  apiPath: string,
  init: { binaryResponse: true; timeoutMs?: number },
): Promise<CloudDocsClientResult<{ bytes: Buffer; fileName?: string; contentType?: string; bytesRead: number }>>;
async function executeCloudDocsFetch<T extends object>(
  creds: CloudDocsHttpCredentials,
  method: DaemonHttpMethod,
  apiPath: string,
  init: { jsonBody?: unknown; formData?: FormData; binaryResponse?: boolean; timeoutMs?: number },
): Promise<CloudDocsClientResult<T> | CloudDocsClientResult<{ bytes: Buffer; fileName?: string; contentType?: string; bytesRead: number }>> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  creds.signal?.addEventListener('abort', onAbort, { once: true });
  const effectiveTimeoutMs = creds.timeoutMs ?? init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  timer.unref?.();

  try {
    const url = daemonApiUrl(creds.serverUrl, method, apiPath);
    const headers: Record<string, string> = {
      ...daemonServerAuthHeaders({ serverId: creds.serverId, token: creds.token }),
      ...(creds.sharedMachineAuthority ? { [SHARED_MACHINE_AUTHORITY_HEADER]: creds.sharedMachineAuthority } : {}),
      ...(init.jsonBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
    };
    const body = init.formData !== undefined
      ? init.formData
      : init.jsonBody !== undefined
        ? JSON.stringify(init.jsonBody)
        : undefined;

    const response = await (creds.fetchImpl ?? fetch)(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
    });

    if (!response.ok) {
      const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return mapHttpFailure(response.status, parsed);
    }

    if (init.binaryResponse) {
      const bytes = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') ?? undefined;
      const fileName = parseContentDispositionFileName(response.headers.get('content-disposition'));
      return {
        status: 'ok',
        bytes,
        bytesRead: bytes.length,
        ...(fileName ? { fileName } : {}),
        ...(contentType ? { contentType } : {}),
      };
    }

    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: 'ok', ...(parsed as T) };
  } catch (err) {
    return {
      status: 'error',
      reason: MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE,
      message: sanitizeMcpErrorMessage(err instanceof Error ? err.message : String(err)),
    };
  } finally {
    clearTimeout(timer);
    creds.signal?.removeEventListener('abort', onAbort);
  }
}

async function cloudDocsRequest<T extends object>(
  creds: CloudDocsHttpCredentials,
  method: DaemonHttpMethod,
  apiPath: string,
  bodyObj?: unknown,
  timeoutMs?: number,
): Promise<CloudDocsClientResult<T>> {
  return executeCloudDocsFetch<T>(creds, method, apiPath, {
    ...(bodyObj !== undefined ? { jsonBody: bodyObj } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

function longRunningClientTimeoutMs(serverTimeoutMs?: number, fallbackServerMs = CLOUD_DOC_DOCBUILDER_DEFAULT_TIMEOUT_MS): number {
  return (serverTimeoutMs ?? fallbackServerMs) + LONG_RUNNING_TIMEOUT_HEADROOM_MS;
}

export async function cloudDocListClient(
  creds: CloudDocsHttpCredentials,
  input: { folderId?: string; search?: string; includeRecent?: boolean },
): Promise<CloudDocsClientResult<{
  folders: CloudDocFolder[];
  docs: CloudDocItem[];
  sharedFolders: SharedCloudFolderItem[];
  sharedDocs: SharedCloudDocItem[];
  recentDocuments?: RecentDocumentItem[];
}>> {
  const qs = new URLSearchParams();
  if (input.folderId !== undefined) qs.set('folderId', input.folderId);
  if (input.search !== undefined) qs.set('search', input.search);
  const path = `${CLOUD_DOCS_API_PATH}${qs.toString() ? `?${qs.toString()}` : ''}`;

  const mainRes = await cloudDocsRequest<{
    folders: CloudDocFolder[];
    docs: CloudDocItem[];
    sharedFolders: SharedCloudFolderItem[];
    sharedDocs: SharedCloudDocItem[];
  }>(creds, 'GET', path);
  if (mainRes.status !== 'ok') return mainRes;

  if (!input.includeRecent) {
    return mainRes;
  }

  const recentRes = await cloudDocsRequest<{ items: RecentDocumentItem[] }>(creds, 'GET', RECENT_DOCUMENTS_API_PATH);
  if (recentRes.status !== 'ok') return recentRes;
  return {
    ...mainRes,
    recentDocuments: recentRes.items,
  };
}

export async function cloudDocReadClient(
  creds: CloudDocsHttpCredentials,
  input: { docId: string; maxChars?: number },
): Promise<CloudDocsClientResult<CloudDocContentPayload>> {
  const qs = new URLSearchParams();
  if (input.maxChars !== undefined) qs.set('maxChars', String(input.maxChars));
  const path = `${CLOUD_DOCS_API_PATH}/${encodeURIComponent(input.docId)}/content${qs.toString() ? `?${qs.toString()}` : ''}`;
  return cloudDocsRequest<CloudDocContentPayload>(creds, 'GET', path);
}

export async function cloudDocCreateClient(
  creds: CloudDocsHttpCredentials,
  input: {
    kind?: 'doc' | 'folder';
    type?: CloudDocCreateType;
    name?: string;
    folderId?: string | null;
    content?: string;
    engine?: 'docbuilder';
    docbuilderScript?: string;
    argument?: Record<string, unknown>;
    timeoutMs?: number;
  },
): Promise<CloudDocsClientResult<{ doc?: CloudDocItem; folder?: CloudDocFolder }>> {
  if (input.kind === 'folder') {
    return cloudDocsRequest<{ folder: CloudDocFolder }>(creds, 'POST', `${CLOUD_DOCS_API_PATH}/folders`, {
      name: input.name ?? '',
      ...(input.folderId !== undefined ? { parentId: input.folderId } : {}),
    });
  }
  const usesBuilder = input.engine === 'docbuilder' || input.docbuilderScript !== undefined;
  return cloudDocsRequest<{ doc: CloudDocItem }>(
    creds,
    'POST',
    `${CLOUD_DOCS_API_PATH}/blank`,
    {
      type: input.type,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.engine !== undefined ? { engine: input.engine } : {}),
      ...(input.docbuilderScript !== undefined ? { docbuilderScript: input.docbuilderScript } : {}),
      ...(input.argument !== undefined ? { argument: input.argument } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    },
    usesBuilder ? longRunningClientTimeoutMs(input.timeoutMs) : undefined,
  );
}

export async function cloudDocEditClient(
  creds: CloudDocsHttpCredentials,
  input: {
    docId: string;
    content?: string;
    mode?: CloudDocEditMode;
    expectedVersion?: number;
    name?: string;
    folderId?: string | null;
    engine?: 'docbuilder';
    docbuilderScript?: string;
    argument?: Record<string, unknown>;
    timeoutMs?: number;
  },
): Promise<CloudDocsClientResult<{ doc: CloudDocItem; role?: CloudDocShareRole | 'owner'; bytesWritten?: number }>> {
  let latestDoc: CloudDocItem | undefined;
  let role: CloudDocShareRole | 'owner' | undefined;
  let bytesWritten: number | undefined;
  const usesBuilder = input.engine === 'docbuilder' || input.docbuilderScript !== undefined;

  if (input.content !== undefined || usesBuilder) {
    const contentBody: Record<string, unknown> = {};
    if (input.content !== undefined) contentBody.content = input.content;
    if (input.mode !== undefined) contentBody.mode = input.mode;
    if (input.expectedVersion !== undefined) contentBody.expectedVersion = input.expectedVersion;
    if (input.name !== undefined) contentBody.name = input.name;
    if (input.folderId !== undefined) contentBody.folderId = input.folderId;
    if (input.engine !== undefined) contentBody.engine = input.engine;
    if (input.docbuilderScript !== undefined) contentBody.docbuilderScript = input.docbuilderScript;
    if (input.argument !== undefined) contentBody.argument = input.argument;
    if (input.timeoutMs !== undefined) contentBody.timeoutMs = input.timeoutMs;

    const contentRes = await cloudDocsRequest<{
      ok: true;
      doc: CloudDocItem;
      role?: CloudDocShareRole | 'owner';
      bytesWritten?: number;
    }>(
      creds,
      'PUT',
      `${CLOUD_DOCS_API_PATH}/${encodeURIComponent(input.docId)}/content`,
      contentBody,
      usesBuilder ? longRunningClientTimeoutMs(input.timeoutMs) : undefined,
    );
    if (contentRes.status !== 'ok') return contentRes;
    latestDoc = contentRes.doc;
    role = contentRes.role;
    bytesWritten = contentRes.bytesWritten;
  } else if (input.name !== undefined || input.folderId !== undefined) {
    const patchBody: Record<string, unknown> = {};
    if (input.name !== undefined) patchBody.name = input.name;
    if (input.folderId !== undefined) patchBody.folderId = input.folderId;
    if (input.expectedVersion !== undefined) patchBody.expectedVersion = input.expectedVersion;
    const metaRes = await cloudDocsRequest<{ doc: CloudDocItem }>(
      creds,
      'PATCH',
      `${CLOUD_DOCS_API_PATH}/${encodeURIComponent(input.docId)}`,
      patchBody,
    );
    if (metaRes.status !== 'ok') return metaRes;
    latestDoc = metaRes.doc;
  }

  if (!latestDoc) {
    return {
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
      message: 'edit requires content, script, name, or folderId',
    };
  }

  return {
    status: 'ok',
    doc: latestDoc,
    ...(role ? { role } : {}),
    ...(bytesWritten !== undefined ? { bytesWritten } : {}),
  };
}

export async function cloudDocDocBuilderCreateClient(
  creds: CloudDocsHttpCredentials,
  input: CloudDocDocBuilderCreateRequest,
): Promise<CloudDocsClientResult<CloudDocDocBuilderCreateResponse>> {
  return cloudDocsRequest<CloudDocDocBuilderCreateResponse>(
    creds,
    'POST',
    `${CLOUD_DOCS_API_PATH}${CLOUD_DOCS_DOCBUILDER_SUBPATH}`,
    input,
    longRunningClientTimeoutMs(input.timeoutMs),
  );
}

export async function cloudDocDocBuilderEditClient(
  creds: CloudDocsHttpCredentials,
  input: { docId: string } & CloudDocDocBuilderEditRequest,
): Promise<CloudDocsClientResult<CloudDocDocBuilderEditResponse>> {
  const { docId, ...body } = input;
  return cloudDocsRequest<CloudDocDocBuilderEditResponse>(
    creds,
    'POST',
    `${CLOUD_DOCS_API_PATH}/${encodeURIComponent(docId)}${CLOUD_DOCS_DOCBUILDER_SUBPATH}`,
    body,
    longRunningClientTimeoutMs(body.timeoutMs),
  );
}

export async function cloudDocConvertClient(
  creds: CloudDocsHttpCredentials,
  input: { docId: string } & CloudDocConvertRequest,
): Promise<CloudDocsClientResult<CloudDocConvertResponse>> {
  const { docId, ...body } = input;
  return cloudDocsRequest<CloudDocConvertResponse>(
    creds,
    'POST',
    `${CLOUD_DOCS_API_PATH}/${encodeURIComponent(docId)}${CLOUD_DOCS_CONVERT_SUBPATH}`,
    body,
    longRunningClientTimeoutMs(body.timeoutMs, CLOUD_DOC_CONVERT_DEFAULT_TIMEOUT_MS),
  );
}

export async function cloudDocUploadFileClient(
  creds: CloudDocsHttpCredentials,
  input: {
    fileBytes: Uint8Array | Buffer;
    fileName: string;
    name?: string;
    folderId?: string | null;
    mimeType?: string;
  },
): Promise<CloudDocsClientResult<{ doc: CloudDocItem }>> {
  const form = new FormData();
  const safeFileName = sanitizeCloudDocTransferFilename(input.fileName);
  const blob = new Blob([Uint8Array.from(input.fileBytes)], input.mimeType ? { type: input.mimeType } : undefined);
  form.append('file', blob, safeFileName);
  if (input.name !== undefined) form.append('name', input.name);
  if (input.folderId !== undefined && input.folderId !== null) form.append('folderId', input.folderId);

  return executeCloudDocsFetch<{ doc: CloudDocItem }>(
    creds,
    'POST',
    `${CLOUD_DOCS_API_PATH}/files`,
    { formData: form, timeoutMs: HEAVY_TRANSFER_TIMEOUT_MS },
  );
}

export async function cloudDocReplaceFileClient(
  creds: CloudDocsHttpCredentials,
  input: {
    docId: string;
    fileBytes: Uint8Array | Buffer;
    fileName: string;
    name?: string;
    folderId?: string | null;
    expectedVersion?: number;
    mimeType?: string;
  },
): Promise<CloudDocsClientResult<CloudDocFileUpdateResponse>> {
  const form = new FormData();
  const safeFileName = sanitizeCloudDocTransferFilename(input.fileName);
  const blob = new Blob([Uint8Array.from(input.fileBytes)], input.mimeType ? { type: input.mimeType } : undefined);
  form.append('file', blob, safeFileName);
  if (input.name !== undefined) form.append('name', input.name);
  if (input.folderId === null) {
    form.append('folderId', '');
  } else if (input.folderId !== undefined) {
    form.append('folderId', input.folderId);
  }
  if (input.expectedVersion !== undefined) {
    form.append('expectedVersion', String(input.expectedVersion));
  }

  return executeCloudDocsFetch<CloudDocFileUpdateResponse>(
    creds,
    'PUT',
    `${CLOUD_DOCS_API_PATH}/${encodeURIComponent(input.docId)}${CLOUD_DOCS_FILE_SUBPATH}`,
    { formData: form, timeoutMs: HEAVY_TRANSFER_TIMEOUT_MS },
  );
}

export async function cloudDocDownloadFileClient(
  creds: CloudDocsHttpCredentials,
  input: { docId: string },
): Promise<CloudDocsClientResult<{ bytes: Buffer; fileName?: string; contentType?: string; bytesRead: number }>> {
  return executeCloudDocsFetch(
    creds,
    'GET',
    `${CLOUD_DOCS_API_PATH}/${encodeURIComponent(input.docId)}/download?download=1`,
    { binaryResponse: true, timeoutMs: HEAVY_TRANSFER_TIMEOUT_MS },
  );
}

export async function cloudDocDeleteClient(
  creds: CloudDocsHttpCredentials,
  input: { targetKind?: CloudDocShareTargetKind; id: string },
): Promise<CloudDocsClientResult<{ ok: true; deletedFolderIds?: string[] }>> {
  const path = input.targetKind === 'folder'
    ? `${CLOUD_DOCS_API_PATH}/folders/${encodeURIComponent(input.id)}`
    : `${CLOUD_DOCS_API_PATH}/${encodeURIComponent(input.id)}`;
  return cloudDocsRequest<{ ok: true; deletedFolderIds?: string[] }>(creds, 'DELETE', path);
}

export async function cloudDocShareClient(
  creds: CloudDocsHttpCredentials,
  input: {
    action: 'list' | 'list_teams' | 'grant' | 'revoke';
    targetKind?: CloudDocShareTargetKind;
    targetId?: string;
    shareId?: string;
    shareMode?: CloudDocShareMode;
    targetTeamId?: string;
    targetUserId?: string;
    targetUsername?: string;
    role?: CloudDocShareRole;
    allowDownload?: boolean;
  },
): Promise<CloudDocsClientResult<{
  shares?: CloudDocShareRecord[];
  teams?: CloudDocTeamOption[];
  share?: CloudDocShareRecord;
  ok?: boolean;
}>> {
  if (input.action === 'list_teams') {
    return cloudDocsRequest<{ teams: CloudDocTeamOption[] }>(creds, 'GET', `${CLOUD_DOCS_API_PATH}/teams`);
  }
  if (input.action === 'list') {
    const kind = input.targetKind ?? 'doc';
    const targetId = input.targetId?.trim() ?? '';
    if (!targetId) {
      return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, message: 'targetId is required for list' };
    }
    return cloudDocsRequest<{ shares: CloudDocShareRecord[] }>(
      creds,
      'GET',
      `${CLOUD_DOCS_API_PATH}/shares/${encodeURIComponent(kind)}/${encodeURIComponent(targetId)}`,
    );
  }
  if (input.action === 'revoke') {
    const shareId = input.shareId?.trim() ?? '';
    if (!shareId) {
      return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, message: 'shareId is required for revoke' };
    }
    return cloudDocsRequest<{ ok: true }>(
      creds,
      'DELETE',
      `${CLOUD_DOCS_API_PATH}/shares/${encodeURIComponent(shareId)}`,
    );
  }
  const targetId = input.targetId?.trim() ?? '';
  if (!targetId || !input.shareMode || !input.role) {
    return {
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
      message: 'targetId, shareMode, and role are required for grant',
    };
  }
  return cloudDocsRequest<{ share: CloudDocShareRecord }>(creds, 'POST', `${CLOUD_DOCS_API_PATH}/shares`, {
    targetKind: input.targetKind ?? 'doc',
    targetId,
    shareMode: input.shareMode,
    ...(input.targetTeamId !== undefined ? { targetTeamId: input.targetTeamId } : {}),
    ...(input.targetUserId !== undefined ? { targetUserId: input.targetUserId } : {}),
    ...(input.targetUsername !== undefined ? { targetUsername: input.targetUsername } : {}),
    role: input.role,
    ...(input.allowDownload !== undefined ? { allowDownload: input.allowDownload } : {}),
  });
}
