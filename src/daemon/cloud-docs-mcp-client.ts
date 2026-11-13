import {
  CLOUD_DOCS_API_PATH,
  RECENT_DOCUMENTS_API_PATH,
  type CloudDocContentPayload,
  type CloudDocCreateType,
  type CloudDocEditMode,
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

export interface CloudDocsHttpCredentials {
  serverUrl: string;
  serverId: string;
  token: string;
  sharedMachineAuthority?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type CloudDocsClientResult<T extends Record<string, unknown>> =
  | ({ status: 'ok' } & T)
  | { status: 'error'; reason: MCPErrorReason; message: string };

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
          : status === 400 || status === 404 || status === 413
            ? MCP_ERROR_REASONS.VALIDATION_FAILED
            : MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE;
  return {
    status: 'error',
    reason,
    message: sanitizeMcpErrorMessage(errMsg || `cloud docs request failed (${status})`),
  };
}

async function cloudDocsRequest<T extends Record<string, unknown>>(
  creds: CloudDocsHttpCredentials,
  method: DaemonHttpMethod,
  apiPath: string,
  bodyObj?: unknown,
): Promise<CloudDocsClientResult<T>> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  creds.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), creds.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();

  try {
    const url = daemonApiUrl(creds.serverUrl, method, apiPath);
    const response = await (creds.fetchImpl ?? fetch)(url, {
      method,
      headers: {
        ...daemonServerAuthHeaders({ serverId: creds.serverId, token: creds.token }),
        ...(creds.sharedMachineAuthority ? { [SHARED_MACHINE_AUTHORITY_HEADER]: creds.sharedMachineAuthority } : {}),
        ...(bodyObj !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(bodyObj !== undefined ? { body: JSON.stringify(bodyObj) } : {}),
      signal: controller.signal,
    });

    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      return mapHttpFailure(response.status, parsed);
    }
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
  },
): Promise<CloudDocsClientResult<{ doc?: CloudDocItem; folder?: CloudDocFolder }>> {
  if (input.kind === 'folder') {
    return cloudDocsRequest<{ folder: CloudDocFolder }>(creds, 'POST', `${CLOUD_DOCS_API_PATH}/folders`, {
      name: input.name ?? '',
      ...(input.folderId !== undefined ? { parentId: input.folderId } : {}),
    });
  }
  return cloudDocsRequest<{ doc: CloudDocItem }>(creds, 'POST', `${CLOUD_DOCS_API_PATH}/blank`, {
    type: input.type,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
    ...(input.content !== undefined ? { content: input.content } : {}),
  });
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
  },
): Promise<CloudDocsClientResult<{ doc: CloudDocItem; role?: CloudDocShareRole | 'owner'; bytesWritten?: number }>> {
  let latestDoc: CloudDocItem | undefined;
  let role: CloudDocShareRole | 'owner' | undefined;
  let bytesWritten: number | undefined;

  if (input.content !== undefined) {
    const contentRes = await cloudDocsRequest<{
      ok: true;
      doc: CloudDocItem;
      role?: CloudDocShareRole | 'owner';
      bytesWritten?: number;
    }>(creds, 'PUT', `${CLOUD_DOCS_API_PATH}/${encodeURIComponent(input.docId)}/content`, {
      content: input.content,
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
    });
    if (contentRes.status !== 'ok') return contentRes;
    latestDoc = contentRes.doc;
    role = contentRes.role;
    bytesWritten = contentRes.bytesWritten;
  }

  if (input.name !== undefined || input.folderId !== undefined) {
    const patchBody: Record<string, unknown> = {};
    if (input.name !== undefined) patchBody.name = input.name;
    if (input.folderId !== undefined) patchBody.folderId = input.folderId;
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
      message: 'cloud_doc_edit requires content, name, or folderId',
    };
  }

  return {
    status: 'ok',
    doc: latestDoc,
    ...(role ? { role } : {}),
    ...(bytesWritten !== undefined ? { bytesWritten } : {}),
  };
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
