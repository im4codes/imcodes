import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  createBlankCloudDocApi,
  createCloudDocFolderApi,
  deleteCloudDocApi,
  deleteCloudDocFolderApi,
  deleteRecentDocumentApi,
  getCloudDocDownloadUrl,
  listCloudDocSharesApi,
  listCloudDocTeamsApi,
  listCloudDocsApi,
  listRecentDocumentsApi,
  revokeCloudDocShareApi,
  updateCloudDocApi,
  updateCloudDocFolderApi,
  uploadCloudDocApi,
  upsertCloudDocShareApi,
} from '../api.js';
import {
  CLOUD_DOCS_MAX_UPLOAD_BYTES,
  CLOUD_DOC_BLANK_TYPES,
  CLOUD_DOC_SUPPORTED_EXTENSIONS,
  type CloudDocBlankType,
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
  isSupportedCloudDocFilename,
} from '@shared/cloud-docs.js';

const OfficePreview = lazy(() => import('./OfficePreview.js'));

export type CloudDocsTab = 'recent' | 'my_docs' | 'shared';

export interface CloudDocsPanelProps {
  onClose?: () => void;
  initialTab?: CloudDocsTab;
}

type PreviewTarget =
  | {
      kind: 'cloud_doc';
      id: string;
      name: string;
      mimeType: string;
      readOnly: boolean;
      allowDownload: boolean;
    }
  | {
      kind: 'server_file';
      recentId: string;
      serverId: string;
      serverName: string | null;
      sessionName: string | null;
      path: string;
      title: string;
      mimeType: string;
      readOnly: boolean;
    };

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

function docIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.ods') || lower.endsWith('.csv')) return '📊';
  if (lower.endsWith('.pptx') || lower.endsWith('.ppt') || lower.endsWith('.odp')) return '📽️';
  if (lower.endsWith('.pdf')) return '📕';
  return '📄';
}

export function CloudDocsPanel({ onClose, initialTab = 'recent' }: CloudDocsPanelProps) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [activeTab, setActiveTab] = useState<CloudDocsTab>(initialTab);
  const [search, setSearch] = useState('');
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);

  const [folders, setFolders] = useState<CloudDocFolder[]>([]);
  const [docs, setDocs] = useState<CloudDocItem[]>([]);
  const [sharedFolders, setSharedFolders] = useState<SharedCloudFolderItem[]>([]);
  const [sharedDocs, setSharedDocs] = useState<SharedCloudDocItem[]>([]);
  const [sharedCurrentFolderId, setSharedCurrentFolderId] = useState<string | null>(null);
  const [teams, setTeams] = useState<CloudDocTeamOption[]>([]);
  const [recentItems, setRecentItems] = useState<RecentDocumentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentBlockedNotice, setRecentBlockedNotice] = useState<RecentDocumentItem | null>(null);

  const [shareTarget, setShareTarget] = useState<{ kind: CloudDocShareTargetKind; id: string; name: string } | null>(null);
  const [shareList, setShareList] = useState<CloudDocShareRecord[]>([]);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareMode, setShareMode] = useState<CloudDocShareMode>('team');
  const [shareTeamId, setShareTeamId] = useState('');
  const [shareUsername, setShareUsername] = useState('');
  const [shareRole, setShareRole] = useState<CloudDocShareRole>('viewer');
  const [shareAllowDownload, setShareAllowDownload] = useState(true);

  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);

  // Inline creation / edit modals (no window.prompt so mobile WebViews & tests stay predictable)
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newDocType, setNewDocType] = useState<CloudDocBlankType | null>(null);
  const [newDocName, setNewDocName] = useState('');
  const [renamingTarget, setRenamingTarget] = useState<
    | { kind: 'folder'; id: string; value: string }
    | { kind: 'doc'; id: string; value: string }
    | null
  >(null);
  const [movingDocId, setMovingDocId] = useState<string | null>(null);
  const [movingFolderTargetId, setMovingFolderTargetId] = useState<string>('');
  const [confirmDelete, setConfirmDelete] = useState<
    | { kind: 'folder'; id: string; name: string }
    | { kind: 'doc'; id: string; name: string }
    | null
  >(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const loadSeqRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadAbortRef.current?.abort();
    };
  }, []);

  const refreshData = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const [cloudRes, recentRes, teamsRes] = await Promise.all([
        listCloudDocsApi({ allFolders: true, signal: controller.signal }),
        listRecentDocumentsApi({ signal: controller.signal }),
        listCloudDocTeamsApi(controller.signal).catch(() => ({ teams: [] as CloudDocTeamOption[] })),
      ]);
      if (!mountedRef.current || controller.signal.aborted || seq !== loadSeqRef.current) return;
      setFolders(cloudRes.folders);
      setDocs(cloudRes.docs);
      setSharedFolders(cloudRes.sharedFolders ?? []);
      setSharedDocs(cloudRes.sharedDocs ?? []);
      setRecentItems(recentRes.items);
      setTeams(teamsRes.teams);
      if (teamsRes.teams.length > 0) {
        setShareTeamId((prev) => (prev && teamsRes.teams.some((tm) => tm.id === prev) ? prev : teamsRes.teams[0]!.id));
      }
    } catch (err: unknown) {
      if (!mountedRef.current || controller.signal.aborted || seq !== loadSeqRef.current) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const msg = err instanceof ApiError ? err.message : (err instanceof Error ? err.message : String(err));
      setError(msg || tRef.current('cloud_docs.errors.load_failed', 'Failed to load documents'));
    } finally {
      if (mountedRef.current && seq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refreshData();
  }, [refreshData]);

  const folderMap = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);

  const breadcrumbs = useMemo(() => {
    const chain: CloudDocFolder[] = [];
    const seen = new Set<string>();
    let curId = currentFolderId;
    while (curId && !seen.has(curId)) {
      seen.add(curId);
      const folder = folderMap.get(curId);
      if (!folder) break;
      chain.unshift(folder);
      curId = folder.parentId;
    }
    return chain;
  }, [currentFolderId, folderMap]);

  const normalizedSearch = search.trim().toLowerCase();

  const visibleFolders = useMemo(() => {
    if (normalizedSearch) {
      return folders.filter((f) => f.name.toLowerCase().includes(normalizedSearch));
    }
    return folders.filter((f) => (f.parentId ?? null) === currentFolderId);
  }, [folders, currentFolderId, normalizedSearch]);

  const visibleDocs = useMemo(() => {
    if (normalizedSearch) {
      return docs.filter((d) => d.name.toLowerCase().includes(normalizedSearch));
    }
    return docs.filter((d) => (d.folderId ?? null) === currentFolderId);
  }, [docs, currentFolderId, normalizedSearch]);

  const visibleRecentItems = useMemo(() => {
    if (!normalizedSearch) return recentItems;
    return recentItems.filter((item) =>
      item.title.toLowerCase().includes(normalizedSearch)
      || (item.serverName ?? '').toLowerCase().includes(normalizedSearch)
      || (item.filePath ?? '').toLowerCase().includes(normalizedSearch),
    );
  }, [recentItems, normalizedSearch]);

  const sharedFolderMap = useMemo(
    () => new Map(sharedFolders.map((f) => [f.id, f])),
    [sharedFolders],
  );

  const sharedBreadcrumbs = useMemo(() => {
    const chain: SharedCloudFolderItem[] = [];
    const seen = new Set<string>();
    let curId = sharedCurrentFolderId;
    while (curId && !seen.has(curId)) {
      seen.add(curId);
      const folder = sharedFolderMap.get(curId);
      if (!folder) break;
      chain.unshift(folder);
      curId = folder.parentId && sharedFolderMap.has(folder.parentId) ? folder.parentId : null;
    }
    return chain;
  }, [sharedCurrentFolderId, sharedFolderMap]);

  const visibleSharedFolders = useMemo(() => {
    if (normalizedSearch) {
      return sharedFolders.filter(
        (f) => f.name.toLowerCase().includes(normalizedSearch) || f.ownerName.toLowerCase().includes(normalizedSearch),
      );
    }
    if (sharedCurrentFolderId === null) {
      return sharedFolders.filter((f) => !f.parentId || !sharedFolderMap.has(f.parentId));
    }
    return sharedFolders.filter((f) => f.parentId === sharedCurrentFolderId);
  }, [sharedFolders, sharedCurrentFolderId, sharedFolderMap, normalizedSearch]);

  const visibleSharedDocs = useMemo(() => {
    if (normalizedSearch) {
      return sharedDocs.filter(
        (d) => d.name.toLowerCase().includes(normalizedSearch) || d.ownerName.toLowerCase().includes(normalizedSearch),
      );
    }
    if (sharedCurrentFolderId === null) {
      return sharedDocs.filter((d) => !d.folderId || !sharedFolderMap.has(d.folderId));
    }
    return sharedDocs.filter((d) => d.folderId === sharedCurrentFolderId);
  }, [sharedDocs, sharedCurrentFolderId, sharedFolderMap, normalizedSearch]);

  const handleCreateFolder = async (e: Event) => {
    e.preventDefault();
    const trimmed = newFolderName.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createCloudDocFolderApi({ name: trimmed, parentId: currentFolderId });
      if (!mountedRef.current) return;
      setNewFolderName('');
      setNewFolderMode(false);
      await refreshData();
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleCreateBlankDoc = async (e: Event) => {
    e.preventDefault();
    if (!newDocType || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createBlankCloudDocApi({
        type: newDocType,
        name: newDocName.trim() || undefined,
        folderId: currentFolderId,
      });
      if (!mountedRef.current) return;
      setNewDocType(null);
      setNewDocName('');
      await refreshData();
      if (!mountedRef.current) return;
      setPreviewTarget({
        kind: 'cloud_doc',
        id: res.doc.id,
        name: res.doc.name,
        mimeType: res.doc.mimeType,
        readOnly: false,
        allowDownload: true,
      });
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleUploadChange = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || busy) return;

    if (file.size > CLOUD_DOCS_MAX_UPLOAD_BYTES) {
      setError(t('cloud_docs.errors.file_too_large', 'File exceeds the 50 MB limit'));
      return;
    }
    if (!isSupportedCloudDocFilename(file.name)) {
      setError(t('cloud_docs.errors.unsupported_format', 'Unsupported document format'));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await uploadCloudDocApi(file, { folderId: currentFolderId });
      if (!mountedRef.current) return;
      await refreshData();
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleRenameSubmit = async (e: Event) => {
    e.preventDefault();
    if (!renamingTarget || busy) return;
    const trimmed = renamingTarget.value.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      if (renamingTarget.kind === 'folder') {
        await updateCloudDocFolderApi(renamingTarget.id, { name: trimmed });
      } else {
        await updateCloudDocApi(renamingTarget.id, { name: trimmed });
      }
      if (!mountedRef.current) return;
      setRenamingTarget(null);
      await refreshData();
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleMoveSubmit = async (e: Event) => {
    e.preventDefault();
    if (!movingDocId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await updateCloudDocApi(movingDocId, { folderId: movingFolderTargetId || null });
      if (!mountedRef.current) return;
      setMovingDocId(null);
      setMovingFolderTargetId('');
      await refreshData();
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (confirmDelete.kind === 'folder') {
        await deleteCloudDocFolderApi(confirmDelete.id);
        if (currentFolderId === confirmDelete.id) {
          setCurrentFolderId(null);
        }
      } else {
        await deleteCloudDocApi(confirmDelete.id);
      }
      if (!mountedRef.current) return;
      setConfirmDelete(null);
      await refreshData();
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleDeleteRecent = async (recentId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteRecentDocumentApi(recentId);
      if (!mountedRef.current) return;
      if (recentBlockedNotice?.id === recentId) {
        setRecentBlockedNotice(null);
      }
      setRecentItems((prev) => prev.filter((item) => item.id !== recentId));
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleOpenRecentItem = (item: RecentDocumentItem) => {
    setRecentBlockedNotice(null);
    if (!item.accessible) {
      setRecentBlockedNotice(item);
      return;
    }
    if (item.sourceKind === 'cloud_doc' && item.cloudDocId) {
      setPreviewTarget({
        kind: 'cloud_doc',
        id: item.cloudDocId,
        name: item.title,
        mimeType: item.mimeType,
        readOnly: item.role ? item.role !== 'editor' : item.openMode === 'view',
        allowDownload: item.allowDownload !== false,
      });
      return;
    }
    if (item.sourceKind === 'server_file' && item.serverId && item.filePath) {
      setPreviewTarget({
        kind: 'server_file',
        recentId: item.id,
        serverId: item.serverId,
        serverName: item.serverName,
        sessionName: item.sessionName,
        path: item.filePath,
        title: item.title,
        mimeType: item.mimeType,
        readOnly: item.openMode === 'view',
      });
    }
  };

  const handleOpenCloudDoc = (doc: CloudDocItem) => {
    setRecentBlockedNotice(null);
    setPreviewTarget({
      kind: 'cloud_doc',
      id: doc.id,
      name: doc.name,
      mimeType: doc.mimeType,
      readOnly: false,
      allowDownload: true,
    });
  };

  const handleOpenSharedCloudDoc = (doc: SharedCloudDocItem) => {
    setRecentBlockedNotice(null);
    setPreviewTarget({
      kind: 'cloud_doc',
      id: doc.id,
      name: doc.name,
      mimeType: doc.mimeType,
      readOnly: doc.role !== 'editor',
      allowDownload: doc.allowDownload,
    });
  };

  const openShareDialog = async (kind: CloudDocShareTargetKind, id: string, name: string) => {
    setShareTarget({ kind, id, name });
    setShareList([]);
    setShareLoading(true);
    setError(null);
    try {
      const [sharesRes, teamsRes] = await Promise.all([
        listCloudDocSharesApi(kind, id),
        listCloudDocTeamsApi().catch(() => ({ teams })),
      ]);
      if (!mountedRef.current) return;
      setShareList(sharesRes.shares);
      setTeams(teamsRes.teams);
      if (teamsRes.teams.length > 0 && !shareTeamId) {
        setShareTeamId(teamsRes.teams[0]!.id);
      }
      if (teamsRes.teams.length === 0) {
        setShareMode('user');
      }
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setShareLoading(false);
    }
  };

  const handleCreateShare = async (e: Event) => {
    e.preventDefault();
    if (!shareTarget) return;
    if (shareMode === 'team' && !shareTeamId) return;
    if (shareMode === 'user' && !shareUsername.trim()) return;

    setBusy(true);
    setError(null);
    try {
      await upsertCloudDocShareApi({
        targetKind: shareTarget.kind,
        targetId: shareTarget.id,
        shareMode,
        targetTeamId: shareMode === 'team' ? shareTeamId : undefined,
        targetUsername: shareMode === 'user' ? shareUsername.trim() : undefined,
        role: shareRole,
        allowDownload: shareAllowDownload,
      });
      const res = await listCloudDocSharesApi(shareTarget.kind, shareTarget.id);
      if (!mountedRef.current) return;
      setShareList(res.shares);
      setShareUsername('');
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleRevokeShare = async (shareId: string) => {
    if (!shareTarget) return;
    setBusy(true);
    setError(null);
    try {
      await revokeCloudDocShareApi(shareId);
      if (!mountedRef.current) return;
      setShareList((prev) => prev.filter((s) => s.id !== shareId));
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  if (previewTarget) {
    return (
      <div class="cloud-docs-panel" data-testid="cloud-docs-panel">
        <div class="cloud-docs-preview-header">
          <button
            type="button"
            class="cloud-docs-btn"
            data-testid="cloud-docs-preview-back"
            onClick={() => {
              setPreviewTarget(null);
              void refreshData();
            }}
          >
            ← {t('cloud_docs.actions.back_to_list', 'Back')}
          </button>
          <span class="cloud-docs-preview-title" title={previewTarget.kind === 'cloud_doc' ? previewTarget.name : previewTarget.path}>
            {previewTarget.kind === 'cloud_doc' ? previewTarget.name : previewTarget.title}
          </span>
          {previewTarget.kind === 'cloud_doc' && previewTarget.allowDownload && (
            <a
              class="cloud-docs-btn"
              data-testid="cloud-docs-preview-download"
              href={getCloudDocDownloadUrl(previewTarget.id)}
              download={previewTarget.name}
            >
              {t('cloud_docs.actions.download', 'Download')}
            </a>
          )}
        </div>
        <div class="cloud-docs-preview-stage">
          <Suspense fallback={<div class="cloud-docs-loading">…</div>}>
            {previewTarget.kind === 'cloud_doc' ? (
              <OfficePreview
                cloudDocId={previewTarget.id}
                srcUrl={previewTarget.allowDownload ? getCloudDocDownloadUrl(previewTarget.id, true) : undefined}
                mimeType={previewTarget.mimeType}
                path={previewTarget.name}
                readOnly={previewTarget.readOnly}
                initialMode={previewTarget.readOnly ? 'view' : 'edit'}
              />
            ) : (
              <OfficePreview
                serverId={previewTarget.serverId}
                sessionName={previewTarget.sessionName ?? undefined}
                mimeType={previewTarget.mimeType}
                path={previewTarget.path}
                readOnly={previewTarget.readOnly}
                initialMode={previewTarget.readOnly ? 'view' : 'edit'}
              />
            )}
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <div class="cloud-docs-panel" data-testid="cloud-docs-panel">
      <div class="cloud-docs-header">
        <div class="cloud-docs-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'recent'}
            data-testid="cloud-docs-tab-recent"
            class={`cloud-docs-tab${activeTab === 'recent' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('recent')}
          >
            {t('cloud_docs.tabs.recent', 'Recent')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'my_docs'}
            data-testid="cloud-docs-tab-my-docs"
            class={`cloud-docs-tab${activeTab === 'my_docs' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('my_docs')}
          >
            {t('cloud_docs.tabs.my_docs', 'Cloud Docs')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'shared'}
            data-testid="cloud-docs-tab-shared"
            class={`cloud-docs-tab${activeTab === 'shared' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('shared')}
          >
            {t('cloud_docs.tabs.shared', 'Shared')}
            {(sharedFolders.length + sharedDocs.length) > 0 ? ` (${sharedFolders.length + sharedDocs.length})` : ''}
          </button>
        </div>

        <div class="cloud-docs-header-right">
          <input
            type="search"
            class="cloud-docs-search"
            data-testid="cloud-docs-search"
            placeholder={t('cloud_docs.search_placeholder', 'Search documents...')}
            value={search}
            onInput={(e) => setSearch((e.currentTarget as HTMLInputElement).value)}
          />
          <button
            type="button"
            class="cloud-docs-btn"
            data-testid="cloud-docs-refresh"
            onClick={() => void refreshData()}
            disabled={loading || busy}
            title={t('common.refresh', 'Refresh')}
          >
            ↻
          </button>
          {onClose && (
            <button
              type="button"
              class="cloud-docs-btn"
              onClick={onClose}
              aria-label={t('window.close', 'Close')}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {error && (
        <div class="cloud-docs-banner is-error" data-testid="cloud-docs-error">
          <span>{error}</span>
          <button type="button" class="cloud-docs-link-btn" onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {recentBlockedNotice && (
        <div class="cloud-docs-banner is-warning" data-testid="cloud-docs-recent-blocked">
          <span>
            {recentBlockedNotice.accessReason === 'server_not_found'
              ? t('cloud_docs.errors.server_not_found', 'This server no longer exists or is unavailable.')
              : recentBlockedNotice.accessReason === 'cloud_doc_missing'
                ? t('cloud_docs.errors.doc_missing', 'This cloud document is no longer available.')
                : t('cloud_docs.errors.access_denied', 'You no longer have permission to open this document.')}
          </span>
          <button
            type="button"
            class="cloud-docs-btn"
            data-testid="cloud-docs-remove-blocked-recent"
            onClick={() => void handleDeleteRecent(recentBlockedNotice.id)}
          >
            {t('cloud_docs.actions.remove_recent', 'Remove from Recent')}
          </button>
        </div>
      )}

      {activeTab === 'my_docs' && (
        <div class="cloud-docs-toolbar">
          <div class="cloud-docs-breadcrumbs">
            <button
              type="button"
              class={`cloud-docs-crumb${currentFolderId === null ? ' is-current' : ''}`}
              onClick={() => setCurrentFolderId(null)}
            >
              {t('cloud_docs.root_folder', 'Root')}
            </button>
            {breadcrumbs.map((folder) => (
              <span key={folder.id} class="cloud-docs-crumb-sep">
                <span>/</span>
                <button
                  type="button"
                  class={`cloud-docs-crumb${currentFolderId === folder.id ? ' is-current' : ''}`}
                  onClick={() => setCurrentFolderId(folder.id)}
                >
                  {folder.name}
                </button>
              </span>
            ))}
          </div>

          <div class="cloud-docs-actions">
            <button
              type="button"
              class="cloud-docs-btn"
              data-testid="cloud-docs-new-folder-btn"
              onClick={() => {
                setNewFolderMode((v) => !v);
                setNewDocType(null);
              }}
              disabled={busy}
            >
              + {t('cloud_docs.actions.new_folder', 'New Folder')}
            </button>
            {CLOUD_DOC_BLANK_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                class="cloud-docs-btn"
                data-testid={`cloud-docs-new-${type}-btn`}
                onClick={() => {
                  setNewDocType(type);
                  setNewDocName('');
                  setNewFolderMode(false);
                }}
                disabled={busy}
              >
                + {t(`cloud_docs.blank_type.${type}`, type.toUpperCase())}
              </button>
            ))}
            <button
              type="button"
              class="cloud-docs-btn is-primary"
              data-testid="cloud-docs-upload-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              ↑ {t('cloud_docs.actions.upload', 'Upload')}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={CLOUD_DOC_SUPPORTED_EXTENSIONS.join(',')}
              style={{ display: 'none' }}
              onChange={(e) => void handleUploadChange(e)}
            />
          </div>
        </div>
      )}

      {activeTab === 'my_docs' && newFolderMode && (
        <form class="cloud-docs-inline-form" onSubmit={(e) => void handleCreateFolder(e)}>
          <input
            type="text"
            class="cloud-docs-input"
            data-testid="cloud-docs-new-folder-input"
            placeholder={t('cloud_docs.placeholders.folder_name', 'Folder name')}
            value={newFolderName}
            onInput={(e) => setNewFolderName((e.currentTarget as HTMLInputElement).value)}
          />
          <button type="submit" class="cloud-docs-btn is-primary" data-testid="cloud-docs-create-folder-submit" disabled={busy || !newFolderName.trim()}>
            {t('cloud_docs.actions.create', 'Create')}
          </button>
          <button type="button" class="cloud-docs-btn" onClick={() => { setNewFolderMode(false); setNewFolderName(''); }}>
            {t('common.cancel', 'Cancel')}
          </button>
        </form>
      )}

      {activeTab === 'my_docs' && newDocType && (
        <form class="cloud-docs-inline-form" onSubmit={(e) => void handleCreateBlankDoc(e)}>
          <span class="cloud-docs-inline-label">.{newDocType}</span>
          <input
            type="text"
            class="cloud-docs-input"
            data-testid="cloud-docs-new-doc-input"
            placeholder={t('cloud_docs.placeholders.doc_name', 'Document name (optional)')}
            value={newDocName}
            onInput={(e) => setNewDocName((e.currentTarget as HTMLInputElement).value)}
          />
          <button type="submit" class="cloud-docs-btn is-primary" data-testid="cloud-docs-create-doc-submit" disabled={busy}>
            {t('cloud_docs.actions.create', 'Create')}
          </button>
          <button type="button" class="cloud-docs-btn" onClick={() => { setNewDocType(null); setNewDocName(''); }}>
            {t('common.cancel', 'Cancel')}
          </button>
        </form>
      )}

      {renamingTarget && (
        <form class="cloud-docs-inline-form" onSubmit={(e) => void handleRenameSubmit(e)}>
          <input
            type="text"
            class="cloud-docs-input"
            data-testid="cloud-docs-rename-input"
            value={renamingTarget.value}
            onInput={(e) => {
              const val = (e.currentTarget as HTMLInputElement).value;
              setRenamingTarget((prev) => (prev ? { ...prev, value: val } : null));
            }}
          />
          <button type="submit" class="cloud-docs-btn is-primary" data-testid="cloud-docs-rename-submit" disabled={busy || !renamingTarget.value.trim()}>
            {t('common.save', 'Save')}
          </button>
          <button type="button" class="cloud-docs-btn" onClick={() => setRenamingTarget(null)}>
            {t('common.cancel', 'Cancel')}
          </button>
        </form>
      )}

      {movingDocId && (
        <form class="cloud-docs-inline-form" onSubmit={(e) => void handleMoveSubmit(e)}>
          <select
            class="cloud-docs-input"
            data-testid="cloud-docs-move-select"
            value={movingFolderTargetId}
            onInput={(e) => setMovingFolderTargetId((e.currentTarget as HTMLSelectElement).value)}
            onChange={(e) => setMovingFolderTargetId((e.currentTarget as HTMLSelectElement).value)}
          >
            <option value="">{t('cloud_docs.root_folder', 'Root')}</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>{folder.name}</option>
            ))}
          </select>
          <button type="submit" class="cloud-docs-btn is-primary" data-testid="cloud-docs-move-submit" disabled={busy}>
            {t('cloud_docs.actions.move', 'Move')}
          </button>
          <button type="button" class="cloud-docs-btn" onClick={() => { setMovingDocId(null); setMovingFolderTargetId(''); }}>
            {t('common.cancel', 'Cancel')}
          </button>
        </form>
      )}

      {shareTarget && (
        <div class="cloud-docs-share-panel" data-testid="cloud-docs-share-panel">
          <div class="cloud-docs-share-head">
            <span>
              {t('cloud_docs.share.title', 'Share "{{name}}"', { name: shareTarget.name })}
            </span>
            <button type="button" class="cloud-docs-btn" onClick={() => setShareTarget(null)}>
              ✕
            </button>
          </div>
          <form class="cloud-docs-share-form" onSubmit={(e) => void handleCreateShare(e)}>
            <select
              class="cloud-docs-input"
              data-testid="cloud-docs-share-mode-select"
              value={shareMode}
              onInput={(e) => setShareMode((e.currentTarget as HTMLSelectElement).value as CloudDocShareMode)}
              onChange={(e) => setShareMode((e.currentTarget as HTMLSelectElement).value as CloudDocShareMode)}
            >
              <option value="team">{t('cloud_docs.share.mode_team', 'Node Group (Team)')}</option>
              <option value="user">{t('cloud_docs.share.mode_user', 'User')}</option>
            </select>
            {shareMode === 'team' ? (
              teams.length > 0 ? (
                <select
                  class="cloud-docs-input"
                  data-testid="cloud-docs-share-team-select"
                  value={shareTeamId}
                  onInput={(e) => setShareTeamId((e.currentTarget as HTMLSelectElement).value)}
                  onChange={(e) => setShareTeamId((e.currentTarget as HTMLSelectElement).value)}
                >
                  {teams.map((tm) => (
                    <option key={tm.id} value={tm.id}>{tm.name}</option>
                  ))}
                </select>
              ) : (
                <span class="cloud-docs-share-hint" data-testid="cloud-docs-share-no-teams">
                  {t('cloud_docs.share.no_teams', 'No controlled-node groups available')}
                </span>
              )
            ) : (
              <input
                type="text"
                class="cloud-docs-input"
                data-testid="cloud-docs-share-user-input"
                placeholder={t('cloud_docs.share.user_placeholder', 'Username or user ID')}
                value={shareUsername}
                onInput={(e) => setShareUsername((e.currentTarget as HTMLInputElement).value)}
              />
            )}
            <select
              class="cloud-docs-input"
              data-testid="cloud-docs-share-role-select"
              value={shareRole}
              onInput={(e) => setShareRole((e.currentTarget as HTMLSelectElement).value as CloudDocShareRole)}
              onChange={(e) => setShareRole((e.currentTarget as HTMLSelectElement).value as CloudDocShareRole)}
            >
              <option value="viewer">{t('cloud_docs.share.role_viewer', 'Viewer')}</option>
              <option value="editor">{t('cloud_docs.share.role_editor', 'Editor')}</option>
            </select>
            <label class="cloud-docs-share-checkbox">
              <input
                type="checkbox"
                data-testid="cloud-docs-share-download-checkbox"
                checked={shareAllowDownload}
                onInput={(e) => setShareAllowDownload((e.currentTarget as HTMLInputElement).checked)}
                onChange={(e) => setShareAllowDownload((e.currentTarget as HTMLInputElement).checked)}
              />
              <span>{t('cloud_docs.share.allow_download', 'Allow Download')}</span>
            </label>
            <button
              type="submit"
              class="cloud-docs-btn is-primary"
              data-testid="cloud-docs-share-submit"
              disabled={busy || (shareMode === 'team' ? !shareTeamId : !shareUsername.trim())}
            >
              {t('cloud_docs.share.submit', 'Share')}
            </button>
          </form>
          {shareLoading ? (
            <div class="cloud-docs-share-hint">{t('common.loading', 'Loading...')}</div>
          ) : shareList.length > 0 && (
            <div class="cloud-docs-share-list" data-testid="cloud-docs-share-list">
              {shareList.map((s) => (
                <div key={s.id} class="cloud-docs-share-item" data-testid={`cloud-doc-share-item-${s.id}`}>
                  <span>
                    {s.shareMode === 'team'
                      ? `👥 ${s.targetTeamName || s.targetTeamId}`
                      : `👤 ${s.targetUserName || s.targetUserUsername || s.targetUserId}`}
                    {' · '}
                    {s.role === 'editor'
                      ? t('cloud_docs.share.role_editor', 'Editor')
                      : t('cloud_docs.share.role_viewer', 'Viewer')}
                    {!s.allowDownload ? ` · ${t('cloud_docs.share.no_download', 'No Download')}` : ''}
                  </span>
                  <button
                    type="button"
                    class="cloud-docs-btn is-danger"
                    data-testid={`revoke-cloud-share-${s.id}`}
                    onClick={() => void handleRevokeShare(s.id)}
                    disabled={busy}
                  >
                    {t('cloud_docs.share.revoke', 'Revoke')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {confirmDelete && (
        <div class="cloud-docs-banner is-warning" data-testid="cloud-docs-delete-confirm">
          <span>
            {t('cloud_docs.confirm_delete', 'Delete "{{name}}"?', { name: confirmDelete.name })}
          </span>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button type="button" class="cloud-docs-btn is-danger" data-testid="cloud-docs-confirm-delete-btn" onClick={() => void handleConfirmDelete()} disabled={busy}>
              {t('common.delete', 'Delete')}
            </button>
            <button type="button" class="cloud-docs-btn" onClick={() => setConfirmDelete(null)}>
              {t('common.cancel', 'Cancel')}
            </button>
          </div>
        </div>
      )}

      <div class="cloud-docs-body">
        {loading ? (
          <div class="cloud-docs-empty" data-testid="cloud-docs-loading">{t('common.loading', 'Loading...')}</div>
        ) : activeTab === 'recent' ? (
          visibleRecentItems.length === 0 ? (
            <div class="cloud-docs-empty" data-testid="cloud-docs-recent-empty">
              {t('cloud_docs.empty.recent', 'No recently viewed documents yet. Open any document in File Browser or Cloud Docs to see it here.')}
            </div>
          ) : (
            <div class="cloud-docs-list" data-testid="cloud-docs-recent-list">
              {visibleRecentItems.map((item) => (
                <div
                  key={item.id}
                  class={`cloud-docs-row${!item.accessible ? ' is-inaccessible' : ''}`}
                  data-testid={`recent-doc-row-${item.id}`}
                >
                  <button
                    type="button"
                    class="cloud-docs-row-main"
                    onClick={() => handleOpenRecentItem(item)}
                  >
                    <span class="cloud-docs-row-icon">{docIcon(item.title)}</span>
                    <div class="cloud-docs-row-meta">
                      <div class="cloud-docs-row-title">{item.title}</div>
                      <div class="cloud-docs-row-sub">
                        <span class={`cloud-docs-badge ${item.sourceKind === 'cloud_doc' ? 'is-cloud' : 'is-server'}`}>
                          {item.sourceKind === 'cloud_doc'
                            ? t('cloud_docs.source.cloud_doc', 'Cloud Doc')
                            : (item.serverName || item.serverId || t('cloud_docs.source.server_file', 'Server'))}
                        </span>
                        {item.filePath && <span class="cloud-docs-path">{item.filePath}</span>}
                        {!item.accessible && (
                          <span class="cloud-docs-badge is-warn">
                            {t('cloud_docs.badges.no_access', 'Unavailable')}
                          </span>
                        )}
                        {item.accessible && item.sourceKind === 'server_file' && !item.serverOnline && (
                          <span class="cloud-docs-badge is-muted">
                            {t('cloud_docs.badges.server_offline', 'Offline')}
                          </span>
                        )}
                        <span class="cloud-docs-time">{formatTime(item.lastOpenedAt)}</span>
                      </div>
                    </div>
                  </button>
                  <div class="cloud-docs-row-actions">
                    <button
                      type="button"
                      class="cloud-docs-btn"
                      data-testid={`remove-recent-${item.id}`}
                      onClick={() => void handleDeleteRecent(item.id)}
                      title={t('cloud_docs.actions.remove_recent', 'Remove')}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : activeTab === 'shared' ? (
          <>
            {sharedBreadcrumbs.length > 0 && (
              <div class="cloud-docs-toolbar">
                <div class="cloud-docs-breadcrumbs">
                  <button
                    type="button"
                    class={`cloud-docs-crumb${sharedCurrentFolderId === null ? ' is-current' : ''}`}
                    onClick={() => setSharedCurrentFolderId(null)}
                  >
                    {t('cloud_docs.tabs.shared', 'Shared')}
                  </button>
                  {sharedBreadcrumbs.map((folder) => (
                    <span key={folder.id} class="cloud-docs-crumb-sep">
                      <span>/</span>
                      <button
                        type="button"
                        class={`cloud-docs-crumb${sharedCurrentFolderId === folder.id ? ' is-current' : ''}`}
                        onClick={() => setSharedCurrentFolderId(folder.id)}
                      >
                        {folder.name}
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {visibleSharedFolders.length === 0 && visibleSharedDocs.length === 0 ? (
              <div class="cloud-docs-empty" data-testid="cloud-docs-shared-empty">
                {t('cloud_docs.empty.shared', 'No cloud documents or folders have been shared with you yet.')}
              </div>
            ) : (
              <div class="cloud-docs-list" data-testid="cloud-docs-shared-list">
                {visibleSharedFolders.map((folder) => (
                  <div key={folder.id} class="cloud-docs-row" data-testid={`shared-cloud-folder-row-${folder.id}`}>
                    <button
                      type="button"
                      class="cloud-docs-row-main"
                      onClick={() => setSharedCurrentFolderId(folder.id)}
                    >
                      <span class="cloud-docs-row-icon">📁</span>
                      <div class="cloud-docs-row-meta">
                        <div class="cloud-docs-row-title">{folder.name}</div>
                        <div class="cloud-docs-row-sub">
                          <span class="cloud-docs-badge is-cloud">
                            {folder.role === 'editor'
                              ? t('cloud_docs.share.role_editor', 'Editor')
                              : t('cloud_docs.share.role_viewer', 'Viewer')}
                          </span>
                          <span>{folder.ownerName}</span>
                          {folder.sharedTeamName && <span>· 👥 {folder.sharedTeamName}</span>}
                        </div>
                      </div>
                    </button>
                  </div>
                ))}
                {visibleSharedDocs.map((doc) => (
                  <div key={doc.id} class="cloud-docs-row" data-testid={`shared-cloud-doc-row-${doc.id}`}>
                    <button
                      type="button"
                      class="cloud-docs-row-main"
                      onClick={() => handleOpenSharedCloudDoc(doc)}
                    >
                      <span class="cloud-docs-row-icon">{docIcon(doc.name)}</span>
                      <div class="cloud-docs-row-meta">
                        <div class="cloud-docs-row-title">{doc.name}</div>
                        <div class="cloud-docs-row-sub">
                          <span class="cloud-docs-badge is-cloud">
                            {doc.role === 'editor'
                              ? t('cloud_docs.share.role_editor', 'Editor')
                              : t('cloud_docs.share.role_viewer', 'Viewer')}
                          </span>
                          <span>{doc.ownerName}</span>
                          {doc.sharedTeamName && <span>· 👥 {doc.sharedTeamName}</span>}
                          <span>{formatBytes(doc.sizeBytes)}</span>
                        </div>
                      </div>
                    </button>
                    <div class="cloud-docs-row-actions">
                      {doc.allowDownload && (
                        <a
                          class="cloud-docs-btn"
                          data-testid={`download-shared-doc-${doc.id}`}
                          href={getCloudDocDownloadUrl(doc.id)}
                          download={doc.name}
                        >
                          ↓
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : visibleFolders.length === 0 && visibleDocs.length === 0 ? (
          <div class="cloud-docs-empty" data-testid="cloud-docs-my-docs-empty">
            {t('cloud_docs.empty.my_docs', 'This folder is empty. Create a blank Office document or upload one to get started.')}
          </div>
        ) : (
          <div class="cloud-docs-list" data-testid="cloud-docs-my-docs-list">
            {visibleFolders.map((folder) => (
              <div key={folder.id} class="cloud-docs-row" data-testid={`cloud-folder-row-${folder.id}`}>
                <button
                  type="button"
                  class="cloud-docs-row-main"
                  onClick={() => setCurrentFolderId(folder.id)}
                >
                  <span class="cloud-docs-row-icon">📁</span>
                  <div class="cloud-docs-row-meta">
                    <div class="cloud-docs-row-title">{folder.name}</div>
                    <div class="cloud-docs-row-sub">
                      <span>{t('cloud_docs.folder_label', 'Folder')}</span>
                    </div>
                  </div>
                </button>
                <div class="cloud-docs-row-actions">
                  <button
                    type="button"
                    class="cloud-docs-btn"
                    data-testid={`share-cloud-folder-${folder.id}`}
                    onClick={() => void openShareDialog('folder', folder.id, folder.name)}
                  >
                    {t('cloud_docs.actions.share', 'Share')}
                  </button>
                  <button
                    type="button"
                    class="cloud-docs-btn"
                    onClick={() => setRenamingTarget({ kind: 'folder', id: folder.id, value: folder.name })}
                  >
                    {t('cloud_docs.actions.rename', 'Rename')}
                  </button>
                  <button
                    type="button"
                    class="cloud-docs-btn is-danger"
                    onClick={() => setConfirmDelete({ kind: 'folder', id: folder.id, name: folder.name })}
                  >
                    {t('common.delete', 'Delete')}
                  </button>
                </div>
              </div>
            ))}

            {visibleDocs.map((doc) => (
              <div key={doc.id} class="cloud-docs-row" data-testid={`cloud-doc-row-${doc.id}`}>
                <button
                  type="button"
                  class="cloud-docs-row-main"
                  onClick={() => handleOpenCloudDoc(doc)}
                >
                  <span class="cloud-docs-row-icon">{docIcon(doc.name)}</span>
                  <div class="cloud-docs-row-meta">
                    <div class="cloud-docs-row-title">{doc.name}</div>
                    <div class="cloud-docs-row-sub">
                      <span>{formatBytes(doc.sizeBytes)}</span>
                      <span class="cloud-docs-time">{formatTime(doc.updatedAt)}</span>
                    </div>
                  </div>
                </button>
                <div class="cloud-docs-row-actions">
                  <a
                    class="cloud-docs-btn"
                    href={getCloudDocDownloadUrl(doc.id)}
                    download={doc.name}
                  >
                    ↓
                  </a>
                  <button
                    type="button"
                    class="cloud-docs-btn"
                    data-testid={`share-cloud-doc-${doc.id}`}
                    onClick={() => void openShareDialog('doc', doc.id, doc.name)}
                  >
                    {t('cloud_docs.actions.share', 'Share')}
                  </button>
                  <button
                    type="button"
                    class="cloud-docs-btn"
                    onClick={() => setRenamingTarget({ kind: 'doc', id: doc.id, value: doc.name })}
                  >
                    {t('cloud_docs.actions.rename', 'Rename')}
                  </button>
                  <button
                    type="button"
                    class="cloud-docs-btn"
                    onClick={() => {
                      setMovingDocId(doc.id);
                      setMovingFolderTargetId(doc.folderId ?? '');
                    }}
                  >
                    {t('cloud_docs.actions.move', 'Move')}
                  </button>
                  <button
                    type="button"
                    class="cloud-docs-btn is-danger"
                    onClick={() => setConfirmDelete({ kind: 'doc', id: doc.id, name: doc.name })}
                  >
                    {t('common.delete', 'Delete')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
