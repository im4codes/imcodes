import {
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
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import {
  cloudDocCreateClient,
  cloudDocDeleteClient,
  cloudDocEditClient,
  cloudDocListClient,
  cloudDocReadClient,
  cloudDocShareClient,
  type CloudDocsClientResult,
  type CloudDocsHttpCredentials,
} from './cloud-docs-mcp-client.js';
import { loadDaemonCredential, type DaemonCredential } from './machine-mcp-deps.js';

export interface CloudDocsToolDeps {
  listDocs: (input: { folderId?: string; search?: string; includeRecent?: boolean; signal?: AbortSignal }) => Promise<CloudDocsClientResult<{
    folders: CloudDocFolder[];
    docs: CloudDocItem[];
    sharedFolders: SharedCloudFolderItem[];
    sharedDocs: SharedCloudDocItem[];
    recentDocuments?: RecentDocumentItem[];
  }>>;
  readDoc: (input: { docId: string; maxChars?: number; signal?: AbortSignal }) => Promise<CloudDocsClientResult<CloudDocContentPayload>>;
  createDoc: (input: {
    kind?: 'doc' | 'folder';
    type?: CloudDocCreateType;
    name?: string;
    folderId?: string | null;
    content?: string;
    signal?: AbortSignal;
  }) => Promise<CloudDocsClientResult<{ doc?: CloudDocItem; folder?: CloudDocFolder }>>;
  editDoc: (input: {
    docId: string;
    content?: string;
    mode?: CloudDocEditMode;
    expectedVersion?: number;
    name?: string;
    folderId?: string | null;
    signal?: AbortSignal;
  }) => Promise<CloudDocsClientResult<{ doc: CloudDocItem; role?: CloudDocShareRole | 'owner'; bytesWritten?: number }>>;
  deleteDoc: (input: { targetKind?: CloudDocShareTargetKind; id: string; signal?: AbortSignal }) => Promise<CloudDocsClientResult<{ ok: true; deletedFolderIds?: string[] }>>;
  shareDoc: (input: {
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
    signal?: AbortSignal;
  }) => Promise<CloudDocsClientResult<{
    shares?: CloudDocShareRecord[];
    teams?: CloudDocTeamOption[];
    share?: CloudDocShareRecord;
    ok?: boolean;
  }>>;
}

export interface DaemonCloudDocsToolDepsOverrides {
  loadCredential?: () => Promise<DaemonCredential | null>;
  loadSharedMachineAuthority?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  listDocsClient?: typeof cloudDocListClient;
  readDocClient?: typeof cloudDocReadClient;
  createDocClient?: typeof cloudDocCreateClient;
  editDocClient?: typeof cloudDocEditClient;
  deleteDocClient?: typeof cloudDocDeleteClient;
  shareDocClient?: typeof cloudDocShareClient;
}

export function createDaemonCloudDocsToolDeps(overrides: DaemonCloudDocsToolDepsOverrides = {}): CloudDocsToolDeps {
  const load = overrides.loadCredential ?? loadDaemonCredential;
  const loadAuthority = overrides.loadSharedMachineAuthority ?? (async () => null);
  const listFn = overrides.listDocsClient ?? cloudDocListClient;
  const readFn = overrides.readDocClient ?? cloudDocReadClient;
  const createFn = overrides.createDocClient ?? cloudDocCreateClient;
  const editFn = overrides.editDocClient ?? cloudDocEditClient;
  const deleteFn = overrides.deleteDocClient ?? cloudDocDeleteClient;
  const shareFn = overrides.shareDocClient ?? cloudDocShareClient;

  const resolveCreds = async (
    signal?: AbortSignal,
  ): Promise<CloudDocsHttpCredentials | { status: 'error'; reason: typeof MCP_ERROR_REASONS.FEATURE_DISABLED | typeof MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE; message: string }> => {
    const creds = await load();
    if (!creds) {
      return {
        status: 'error',
        reason: MCP_ERROR_REASONS.FEATURE_DISABLED,
        message: 'daemon is not bound to a server',
      };
    }

    // Fail closed if shared turn authority lookup errors: never silently drop delegated turn identity.
    let sharedMachineAuthority: string | null;
    try {
      sharedMachineAuthority = await loadAuthority();
    } catch (err) {
      return {
        status: 'error',
        reason: MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE,
        message: err instanceof Error ? err.message : 'shared turn authority unavailable',
      };
    }

    return {
      serverUrl: creds.serverUrl,
      serverId: creds.serverId,
      token: creds.token,
      ...(sharedMachineAuthority ? { sharedMachineAuthority } : {}),
      ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
      ...(signal ? { signal } : {}),
    };
  };

  return {
    async listDocs({ signal, ...input }) {
      const creds = await resolveCreds(signal);
      if ('status' in creds) return creds;
      return listFn(creds, input);
    },
    async readDoc({ signal, ...input }) {
      const creds = await resolveCreds(signal);
      if ('status' in creds) return creds;
      return readFn(creds, input);
    },
    async createDoc({ signal, ...input }) {
      const creds = await resolveCreds(signal);
      if ('status' in creds) return creds;
      return createFn(creds, input);
    },
    async editDoc({ signal, ...input }) {
      const creds = await resolveCreds(signal);
      if ('status' in creds) return creds;
      return editFn(creds, input);
    },
    async deleteDoc({ signal, ...input }) {
      const creds = await resolveCreds(signal);
      if ('status' in creds) return creds;
      return deleteFn(creds, input);
    },
    async shareDoc({ signal, ...input }) {
      const creds = await resolveCreds(signal);
      if ('status' in creds) return creds;
      return shareFn(creds, input);
    },
  };
}
