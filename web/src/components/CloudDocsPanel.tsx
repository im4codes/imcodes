import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  createBlankCloudDocApi,
  createCloudDocFolderApi,
  deleteCloudDocApi,
  deleteCloudDocFolderApi,
  deleteRecentDocumentApi,
  downloadCloudDocApi,
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
  getCloudDocExt,
  getCloudDocMeta,
  isSupportedCloudDocFilename,
  normalizeCloudDocName,
} from '@shared/cloud-docs.js';
import { dismissHtmlSplashForDirectEntry } from '../html-splash.js';

const OfficePreview = lazy(() => import('./OfficePreview.js'));

export type CloudDocsTab = 'recent' | 'my_docs' | 'shared';
export type CloudDocsViewMode = 'list' | 'grid';
export type CloudDocsSortBy = 'updated' | 'name' | 'size';
export type CloudDocsTypeFilter = 'all' | 'word' | 'cell' | 'slide' | 'pdf';

export interface CloudDocsPanelProps {
  onClose?: () => void;
  initialTab?: CloudDocsTab;
  standalone?: boolean;
  initialFolderId?: string | null;
  initialDocId?: string | null;
}

type PreviewTarget =
  | {
      kind: 'cloud_doc';
      id: string;
      name: string;
      mimeType: string;
      readOnly: boolean;
      allowDownload: boolean;
      isOwner: boolean;
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

type MenuTarget =
  | { kind: 'folder'; id: string }
  | { kind: 'doc'; id: string };

type ContextMenuTarget =
  | { kind: 'doc'; doc: CloudDocItem }
  | { kind: 'folder'; folder: CloudDocFolder }
  | { kind: 'shared-doc'; doc: SharedCloudDocItem }
  | { kind: 'shared-folder'; folder: SharedCloudFolderItem }
  | { kind: 'recent-doc'; item: RecentDocumentItem }
  | { kind: 'canvas' };

interface ContextMenuState {
  rawX: number;
  rawY: number;
  x: number;
  y: number;
  target: ContextMenuTarget;
}

const CONTEXT_MENU_PADDING = 8;
const DEFAULT_CONTEXT_MENU_WIDTH = 216;
const DEFAULT_CONTEXT_MENU_HEIGHT = 260;

/**
 * Clamp right-click context menu coordinates cleanly inside the current viewport.
 */
export function clampCloudDocsContextMenuPosition(
  rawX: number,
  rawY: number,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth = DEFAULT_CONTEXT_MENU_WIDTH,
  menuHeight = DEFAULT_CONTEXT_MENU_HEIGHT,
): { x: number; y: number } {
  const safeVw = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1024;
  const safeVh = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 768;
  const safeW = Number.isFinite(menuWidth) && menuWidth > 0 ? menuWidth : DEFAULT_CONTEXT_MENU_WIDTH;
  const safeH = Number.isFinite(menuHeight) && menuHeight > 0 ? menuHeight : DEFAULT_CONTEXT_MENU_HEIGHT;
  const maxX = Math.max(CONTEXT_MENU_PADDING, safeVw - safeW - CONTEXT_MENU_PADDING);
  const maxY = Math.max(CONTEXT_MENU_PADDING, safeVh - safeH - CONTEXT_MENU_PADDING);
  return {
    x: Math.min(Math.max(CONTEXT_MENU_PADDING, Math.round(rawX)), Math.round(maxX)),
    y: Math.min(Math.max(CONTEXT_MENU_PADDING, Math.round(rawY)), Math.round(maxY)),
  };
}

/**
 * Toolbar glyph depicting a folded document sheet with a cloud superscript badge.
 */
export function CloudDocsGlyphIcon({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      class={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path
        d="M5.5 3.5h7.25L16.5 7.25V19a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19V5a1.5 1.5 0 0 1 1.5-1.5Z"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linejoin="round"
      />
      <path d="M12.5 3.75v3.5h3.5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
      <path d="M7.25 11.5h6M7.25 14.5h6M7.25 17.5h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      <path
        d="M15.7 9.8h4.2a2.1 2.1 0 0 0 .25-4.18 2.85 2.85 0 0 0-5.4-.52A2.35 2.35 0 0 0 15.7 9.8Z"
        fill="#38bdf8"
        stroke="#0f172a"
        stroke-width="1.2"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function getDocVisualKind(name: string): 'word' | 'cell' | 'slide' | 'pdf' {
  return getCloudDocMeta(name)?.documentType ?? 'word';
}

function DocKindIcon({ name, size = 20 }: { name: string; size?: number }) {
  const kind = getDocVisualKind(name);
  const bg = kind === 'cell' ? '#059669' : kind === 'slide' ? '#d97706' : kind === 'pdf' ? '#dc2626' : '#2563eb';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="3" y="2" width="18" height="20" rx="4" fill={bg} />
      {kind === 'cell' ? (
        <path
          d="M7 8.5h10M7 12h10M7 15.5h10M12 8.5v7"
          stroke="#ffffff"
          stroke-width="1.5"
          stroke-linecap="round"
        />
      ) : kind === 'slide' ? (
        <>
          <rect x="6.5" y="7.5" width="11" height="7" rx="1.2" stroke="#ffffff" stroke-width="1.5" />
          <path d="M12 14.5v3M9.5 17.5h5" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" />
        </>
      ) : kind === 'pdf' ? (
        <path
          d="M8 15.5V8.5h2.2a2 2 0 1 1 0 4H8m5.5-4h2a2 2 0 0 1 0 4v3"
          stroke="#ffffff"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      ) : (
        <path d="M7.5 8.5h9M7.5 12h9M7.5 15.5h6" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" />
      )}
    </svg>
  );
}

function FolderSvgIcon({ shared = false, size = 20 }: { shared?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <path
        d="M3.5 6.5A1.75 1.75 0 0 1 5.25 4.75h4.1l1.7 1.75h7.7a1.75 1.75 0 0 1 1.75 1.75v9A1.75 1.75 0 0 1 18.75 19H5.25A1.75 1.75 0 0 1 3.5 17.25V6.5Z"
        fill={shared ? '#1d4ed8' : '#475569'}
        stroke={shared ? '#60a5fa' : '#94a3b8'}
        stroke-width="1.3"
      />
      {shared && (
        <circle cx="15.5" cy="13.5" r="2.2" fill="#e0f2fe" />
      )}
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
      <path d="m16.5 16.5 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.6 4.5M20 20v-4.5h-4.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function CloseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
  );
}

function BackArrowIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M19 12H5m0 0 6-6m-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 16V5m0 0-4 4m4-4 4 4M5 19h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="18" cy="5" r="2.75" stroke="currentColor" stroke-width="1.8" />
      <circle cx="6" cy="12" r="2.75" stroke="currentColor" stroke-width="1.8" />
      <circle cx="18" cy="19" r="2.75" stroke="currentColor" stroke-width="1.8" />
      <path d="m8.4 10.7 7.2-4.2m-7.2 6.8 7.2 4.2" stroke="currentColor" stroke-width="1.8" />
    </svg>
  );
}

function MoreVertIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5.5" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <circle cx="12" cy="18.5" r="1.75" />
    </svg>
  );
}

function ViewListIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
  );
}

function ViewGridIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" stroke="currentColor" stroke-width="1.8" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" stroke="currentColor" stroke-width="1.8" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" stroke="currentColor" stroke-width="1.8" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" stroke="currentColor" stroke-width="1.8" />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4.2l1.6 1.75H19a1.5 1.5 0 0 1 1.5 1.5V18A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18V6.5Z" stroke="currentColor" stroke-width="1.8" />
      <path d="M12 10.5v5M9.5 13h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M14.5 5.5 18.5 9.5M4 20h4l10.2-10.2a1.4 1.4 0 0 0 0-2L16.2 5.8a1.4 1.4 0 0 0-2 0L4 16v4Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
    </svg>
  );
}

function PrincipalIcon({ mode }: { mode: CloudDocShareMode }) {
  return mode === 'team' ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="9" cy="8.5" r="3" stroke="currentColor" stroke-width="1.8" />
      <path d="M3.5 18.5a5.5 5.5 0 0 1 11 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      <path d="M16.5 7.5a2.5 2.5 0 0 1 0 5M18 18.5a4 4 0 0 0-2-3.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="8.5" r="3.2" stroke="currentColor" stroke-width="1.8" />
      <path d="M5.5 19a6.5 6.5 0 0 1 13 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    </svg>
  );
}

function OpenDocIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M14 4h6v6m0-6-9 9M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function MoveFolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l1.6 1.75H19a1.5 1.5 0 0 1 1.5 1.5V18A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18V6.5Z" stroke="currentColor" stroke-width="1.8" />
      <path d="M9.5 13h5m0 0-2-2m2 2-2 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4.5 7h15M9.5 4.5h5M8 7v11.5a1.5 1.5 0 0 0 1.5 1.5h5a1.5 1.5 0 0 0 1.5-1.5V7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function buildUniqueAutoDocName(
  type: CloudDocBlankType,
  existingDocs: readonly CloudDocItem[],
  folderId: string | null,
  baseTitle: string,
): string {
  const ext = `.${type}`;
  const cleanBase = baseTitle.trim() || 'Untitled';
  const existing = new Set(
    existingDocs
      .filter((doc) => (doc.folderId ?? null) === folderId)
      .map((doc) => doc.name.toLowerCase()),
  );
  const firstCandidate = normalizeCloudDocName(`${cleanBase}${ext}`, ext) ?? `Untitled${ext}`;
  if (!existing.has(firstCandidate.toLowerCase())) {
    return firstCandidate;
  }
  const maxAttempt = existing.size + 2;
  for (let idx = 2; idx <= maxAttempt; idx += 1) {
    const candidate = normalizeCloudDocName(`${cleanBase} ${idx}${ext}`, ext);
    if (candidate && !existing.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return normalizeCloudDocName(`${cleanBase} ${maxAttempt + 1}${ext}`, ext) ?? firstCandidate;
}

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

export function CloudDocsPanel({
  onClose,
  initialTab = 'recent',
  standalone = false,
  initialFolderId = null,
  initialDocId = null,
}: CloudDocsPanelProps) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [activeTab, setActiveTab] = useState<CloudDocsTab>(initialTab);
  const [viewMode, setViewMode] = useState<CloudDocsViewMode>('list');
  const [sortBy, setSortBy] = useState<CloudDocsSortBy>('updated');
  const [typeFilter, setTypeFilter] = useState<CloudDocsTypeFilter>('all');
  const [search, setSearch] = useState('');
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(initialFolderId);

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
  const [dragActive, setDragActive] = useState(false);
  const [recentBlockedNotice, setRecentBlockedNotice] = useState<RecentDocumentItem | null>(null);

  const [shareTarget, setShareTarget] = useState<{ kind: CloudDocShareTargetKind; id: string; name: string } | null>(null);
  const [shareList, setShareList] = useState<CloudDocShareRecord[]>([]);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareSubmitting, setShareSubmitting] = useState(false);
  const [shareMode, setShareMode] = useState<CloudDocShareMode>('team');
  const [shareTeamId, setShareTeamId] = useState('');
  const [shareUsername, setShareUsername] = useState('');
  const [shareRole, setShareRole] = useState<CloudDocShareRole>('viewer');
  const [shareAllowDownload, setShareAllowDownload] = useState(true);

  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);
  const [previewTitleDraft, setPreviewTitleDraft] = useState('');
  const [previewTitleStatus, setPreviewTitleStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  const [openMenu, setOpenMenu] = useState<MenuTarget | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
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
  const docsHydratedRef = useRef(false);
  const authoritativeDocsRef = useRef<CloudDocItem[]>([]);
  const activeLoadPromiseRef = useRef<Promise<CloudDocItem[] | null> | null>(null);
  const shareSeqRef = useRef(0);
  const shareAbortRef = useRef<AbortController | null>(null);
  const shareTargetRef = useRef<{ kind: CloudDocShareTargetKind; id: string; name: string } | null>(null);
  const previewTitleInputRef = useRef<HTMLInputElement | null>(null);
  const previewTitleCancelledRef = useRef(false);
  const savedStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editGenCounterRef = useRef(0);
  const activePreviewRef = useRef<{ docId: string | null; previewSeq: number; editGen: number }>({
    docId: null,
    previewSeq: 0,
    editGen: 0,
  });
  type TitleSaveIntent = {
    name: string;
    fallbackMime: string;
    editGen: number;
  };
  type TitleSaveQueueEntry = {
    inFlight: boolean;
    activeIntent: TitleSaveIntent | null;
    lastQueuedName: string;
    pending: TitleSaveIntent | null;
  };
  const titleSaveQueueRef = useRef<Map<string, TitleSaveQueueEntry>>(new Map());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadAbortRef.current?.abort();
      shareSeqRef.current += 1;
      shareAbortRef.current?.abort();
      shareAbortRef.current = null;
      shareTargetRef.current = null;
      if (savedStatusTimerRef.current) clearTimeout(savedStatusTimerRef.current);
    };
  }, []);

  useLayoutEffect(() => {
    if (standalone) {
      dismissHtmlSplashForDirectEntry();
    }
  }, [standalone]);

  // Invalidates any pre-mutation list read so stale GET responses/errors cannot roll back newer projections.
  const invalidatePendingRefresh = useCallback(() => {
    loadSeqRef.current += 1;
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    activeLoadPromiseRef.current = null;
    if (mountedRef.current) setLoading(false);
  }, []);

  const applyDocsProjection = useCallback((updater: (current: CloudDocItem[]) => CloudDocItem[]) => {
    invalidatePendingRefresh();
    const next = updater(authoritativeDocsRef.current);
    authoritativeDocsRef.current = next;
    if (mountedRef.current) setDocs(next);
  }, [invalidatePendingRefresh]);

  const invalidateDocsAuthority = useCallback(() => {
    invalidatePendingRefresh();
    docsHydratedRef.current = false;
  }, [invalidatePendingRefresh]);

  const openPreview = useCallback((target: PreviewTarget | null) => {
    if (savedStatusTimerRef.current) {
      clearTimeout(savedStatusTimerRef.current);
      savedStatusTimerRef.current = null;
    }
    const nextPreviewSeq = activePreviewRef.current.previewSeq + 1;
    previewTitleCancelledRef.current = false;
    setContextMenu(null);
    setPreviewTarget(target);
    if (!target) {
      activePreviewRef.current = {
        docId: null,
        previewSeq: nextPreviewSeq,
        editGen: ++editGenCounterRef.current,
      };
      setPreviewTitleDraft('');
      setPreviewTitleStatus('idle');
    } else if (target.kind === 'cloud_doc') {
      const q = titleSaveQueueRef.current.get(target.id);
      const activeSave = q && (q.inFlight || q.pending) ? (q.pending ?? q.activeIntent) : null;
      activePreviewRef.current = {
        docId: target.id,
        previewSeq: nextPreviewSeq,
        editGen: activeSave ? activeSave.editGen : ++editGenCounterRef.current,
      };
      setPreviewTitleDraft(activeSave ? q!.lastQueuedName : target.name);
      setPreviewTitleStatus(activeSave ? 'saving' : 'idle');
    } else {
      activePreviewRef.current = {
        docId: null,
        previewSeq: nextPreviewSeq,
        editGen: ++editGenCounterRef.current,
      };
      setPreviewTitleDraft(target.title);
      setPreviewTitleStatus('idle');
    }
  }, []);

  // Close open overflow menu, right-click context menu, or share dialog cleanly on outside click / Escape / blur / resize.
  useEffect(() => {
    if (!openMenu && !shareTarget && !contextMenu) return;
    const onPointerDown = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (openMenu && !target?.closest('.cloud-docs-menu-wrap')) {
        setOpenMenu(null);
      }
      if (contextMenu && !target?.closest('[data-testid="cloud-docs-context-menu"]')) {
        setContextMenu(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (openMenu) setOpenMenu(null);
      if (contextMenu) setContextMenu(null);
      if (shareTarget) closeShareDialog();
    };
    const onWindowDismiss = () => {
      if (contextMenu) setContextMenu(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', onWindowDismiss);
    window.addEventListener('resize', onWindowDismiss);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onWindowDismiss);
      window.removeEventListener('resize', onWindowDismiss);
    };
  }, [openMenu, shareTarget, contextMenu]);

  const contextMenuTargetKey = contextMenu
    ? (
      contextMenu.target.kind === 'canvas'
        ? 'canvas'
        : contextMenu.target.kind === 'recent-doc'
          ? `recent:${contextMenu.target.item.id}`
          : contextMenu.target.kind === 'folder' || contextMenu.target.kind === 'shared-folder'
            ? `${contextMenu.target.kind}:${contextMenu.target.folder.id}`
            : `${contextMenu.target.kind}:${contextMenu.target.doc.id}`
    )
    : null;

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const rect = contextMenuRef.current.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const clamped = clampCloudDocsContextMenuPosition(
      contextMenu.rawX,
      contextMenu.rawY,
      window.innerWidth,
      window.innerHeight,
      rect.width,
      rect.height,
    );
    if (clamped.x !== contextMenu.x || clamped.y !== contextMenu.y) {
      setContextMenu((prev) => (prev ? { ...prev, x: clamped.x, y: clamped.y } : null));
    }
  }, [contextMenuTargetKey, contextMenu?.rawX, contextMenu?.rawY]);

  const openContextMenu = useCallback((e: MouseEvent, target: ContextMenuTarget) => {
    e.preventDefault();
    e.stopPropagation();
    setOpenMenu(null);
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
    const clamped = clampCloudDocsContextMenuPosition(e.clientX, e.clientY, vw, vh);
    setContextMenu({
      rawX: e.clientX,
      rawY: e.clientY,
      x: clamped.x,
      y: clamped.y,
      target,
    });
  }, []);

  const refreshData = useCallback((): Promise<CloudDocItem[] | null> => {
    const seq = ++loadSeqRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;

    setLoading(true);
    setError(null);
    const promise = (async (): Promise<CloudDocItem[] | null> => {
      try {
        const [cloudRes, recentRes, teamsRes] = await Promise.all([
          listCloudDocsApi({ allFolders: true, signal: controller.signal }),
          listRecentDocumentsApi({ signal: controller.signal }),
          listCloudDocTeamsApi(controller.signal).catch(() => ({ teams: [] as CloudDocTeamOption[] })),
        ]);
        if (!mountedRef.current || controller.signal.aborted || seq !== loadSeqRef.current) return null;
        docsHydratedRef.current = true;
        authoritativeDocsRef.current = cloudRes.docs;
        setFolders(cloudRes.folders);
        setDocs(cloudRes.docs);
        setSharedFolders(cloudRes.sharedFolders ?? []);
        setSharedDocs(cloudRes.sharedDocs ?? []);
        setRecentItems(recentRes.items);
        setTeams(teamsRes.teams);
        if (teamsRes.teams.length > 0) {
          setShareTeamId((prev) => (prev && teamsRes.teams.some((tm) => tm.id === prev) ? prev : teamsRes.teams[0]!.id));
        }
        return cloudRes.docs;
      } catch (err: unknown) {
        if (!mountedRef.current || controller.signal.aborted || seq !== loadSeqRef.current) return null;
        if (err instanceof DOMException && err.name === 'AbortError') return null;
        docsHydratedRef.current = false;
        const msg = err instanceof ApiError ? err.message : (err instanceof Error ? err.message : String(err));
        setError(msg || tRef.current('cloud_docs.errors.load_failed', 'Failed to load documents'));
        return null;
      } finally {
        if (mountedRef.current && seq === loadSeqRef.current) {
          setLoading(false);
        }
        if (seq === loadSeqRef.current) {
          activeLoadPromiseRef.current = null;
        }
      }
    })();
    activeLoadPromiseRef.current = promise;
    return promise;
  }, []);

  useEffect(() => {
    void refreshData();
  }, [refreshData]);

  useEffect(() => {
    if (!standalone) return;
    document.title = t('cloud_docs.title', 'Cloud Docs');
  }, [standalone, t]);

  const consumedInitialDocRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialDocId || consumedInitialDocRef.current === initialDocId || loading) return;
    const ownDoc = docs.find((d) => d.id === initialDocId);
    if (ownDoc) {
      consumedInitialDocRef.current = initialDocId;
      openPreview({
        kind: 'cloud_doc',
        id: ownDoc.id,
        name: ownDoc.name,
        mimeType: ownDoc.mimeType,
        readOnly: false,
        allowDownload: true,
        isOwner: true,
      });
      return;
    }
    const sharedDoc = sharedDocs.find((d) => d.id === initialDocId);
    if (sharedDoc) {
      consumedInitialDocRef.current = initialDocId;
      openPreview({
        kind: 'cloud_doc',
        id: sharedDoc.id,
        name: sharedDoc.name,
        mimeType: sharedDoc.mimeType,
        readOnly: sharedDoc.role !== 'editor',
        allowDownload: sharedDoc.allowDownload,
        isOwner: false,
      });
    }
  }, [initialDocId, loading, docs, sharedDocs, openPreview]);

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

  const sortFoldersList = useCallback(
    <T extends { name: string; updatedAt: number }>(list: readonly T[]): T[] => (
      [...list].sort((a, b) => (
        sortBy === 'name'
          ? a.name.localeCompare(b.name)
          : (b.updatedAt - a.updatedAt) || a.name.localeCompare(b.name)
      ))
    ),
    [sortBy],
  );

  const sortDocsList = useCallback(
    <T extends { name: string; updatedAt: number; sizeBytes: number }>(list: readonly T[]): T[] => (
      [...list].sort((a, b) => {
        if (sortBy === 'name') return a.name.localeCompare(b.name);
        if (sortBy === 'size') return (b.sizeBytes - a.sizeBytes) || a.name.localeCompare(b.name);
        return (b.updatedAt - a.updatedAt) || a.name.localeCompare(b.name);
      })
    ),
    [sortBy],
  );

  const matchesTypeFilter = useCallback(
    (name: string) => typeFilter === 'all' || getDocVisualKind(name) === typeFilter,
    [typeFilter],
  );

  const visibleFolders = useMemo(() => {
    const base = normalizedSearch
      ? folders.filter((f) => f.name.toLowerCase().includes(normalizedSearch))
      : folders.filter((f) => (f.parentId ?? null) === currentFolderId);
    return sortFoldersList(base);
  }, [folders, currentFolderId, normalizedSearch, sortFoldersList]);

  const visibleDocs = useMemo(() => {
    const base = normalizedSearch
      ? docs.filter((d) => d.name.toLowerCase().includes(normalizedSearch))
      : docs.filter((d) => (d.folderId ?? null) === currentFolderId);
    return sortDocsList(base.filter((d) => matchesTypeFilter(d.name)));
  }, [docs, currentFolderId, normalizedSearch, matchesTypeFilter, sortDocsList]);

  const visibleRecentItems = useMemo(() => {
    const searched = !normalizedSearch
      ? recentItems
      : recentItems.filter((item) =>
          item.title.toLowerCase().includes(normalizedSearch)
          || (item.serverName ?? '').toLowerCase().includes(normalizedSearch)
          || (item.filePath ?? '').toLowerCase().includes(normalizedSearch),
        );
    const filtered = searched.filter((item) => matchesTypeFilter(item.title));
    return [...filtered].sort((a, b) => (
      sortBy === 'name' ? a.title.localeCompare(b.title) : b.lastOpenedAt - a.lastOpenedAt
    ));
  }, [recentItems, normalizedSearch, matchesTypeFilter, sortBy]);

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
    const base = normalizedSearch
      ? sharedFolders.filter(
          (f) => f.name.toLowerCase().includes(normalizedSearch) || f.ownerName.toLowerCase().includes(normalizedSearch),
        )
      : sharedCurrentFolderId === null
        ? sharedFolders.filter((f) => !f.parentId || !sharedFolderMap.has(f.parentId))
        : sharedFolders.filter((f) => f.parentId === sharedCurrentFolderId);
    return sortFoldersList(base);
  }, [sharedFolders, sharedCurrentFolderId, sharedFolderMap, normalizedSearch, sortFoldersList]);

  const visibleSharedDocs = useMemo(() => {
    const base = normalizedSearch
      ? sharedDocs.filter(
          (d) => d.name.toLowerCase().includes(normalizedSearch) || d.ownerName.toLowerCase().includes(normalizedSearch),
        )
      : sharedCurrentFolderId === null
        ? sharedDocs.filter((d) => !d.folderId || !sharedFolderMap.has(d.folderId))
        : sharedDocs.filter((d) => d.folderId === sharedCurrentFolderId);
    return sortDocsList(base.filter((d) => matchesTypeFilter(d.name)));
  }, [sharedDocs, sharedCurrentFolderId, sharedFolderMap, normalizedSearch, matchesTypeFilter, sortDocsList]);

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

  const handleCreateBlankInstant = async (type: CloudDocBlankType) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setOpenMenu(null);
    setNewFolderMode(false);
    const targetFolderId = activeTab === 'my_docs' ? currentFolderId : null;
    const baseTitle = type === 'xlsx'
      ? t('cloud_docs.untitled_name.xlsx', 'Untitled spreadsheet')
      : type === 'pptx'
        ? t('cloud_docs.untitled_name.pptx', 'Untitled presentation')
        : t('cloud_docs.untitled_name.docx', 'Untitled document');
    try {
      let currentDocs = authoritativeDocsRef.current;
      if (!docsHydratedRef.current) {
        let hydrated: CloudDocItem[] | null = null;
        if (activeLoadPromiseRef.current) {
          const prevSeq = loadSeqRef.current;
          hydrated = await activeLoadPromiseRef.current;
          if (!mountedRef.current) return;
          if (hydrated === null && !docsHydratedRef.current && loadSeqRef.current !== prevSeq) {
            hydrated = activeLoadPromiseRef.current
              ? await activeLoadPromiseRef.current
              : await refreshData();
          }
        } else {
          hydrated = await refreshData();
        }
        if (!mountedRef.current || hydrated === null) return;
        currentDocs = hydrated;
      }
      const uniqueName = buildUniqueAutoDocName(type, currentDocs, targetFolderId, baseTitle);
      const res = await createBlankCloudDocApi({
        type,
        name: uniqueName,
        folderId: targetFolderId,
      });
      if (!mountedRef.current) return;
      if (res?.doc) {
        applyDocsProjection((prev) => [...prev.filter((d) => d.id !== res.doc.id), res.doc]);
      } else {
        invalidateDocsAuthority();
      }
      await refreshData();
      if (!mountedRef.current) return;
      openPreview({
        kind: 'cloud_doc',
        id: res.doc.id,
        name: res.doc.name,
        mimeType: res.doc.mimeType,
        readOnly: false,
        allowDownload: true,
        isOwner: true,
      });
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const uploadSelectedFile = async (file: File) => {
    if (busy) return;
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
      const res = await uploadCloudDocApi(file, { folderId: activeTab === 'my_docs' ? currentFolderId : null });
      if (!mountedRef.current) return;
      if (res?.doc) {
        applyDocsProjection((prev) => [...prev.filter((d) => d.id !== res.doc.id), res.doc]);
      } else {
        invalidateDocsAuthority();
      }
      await refreshData();
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
    if (!file) return;
    await uploadSelectedFile(file);
  };

  const handleDropUpload = (e: DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    if (activeTab === 'shared') return;
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      void uploadSelectedFile(file);
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
        const res = await updateCloudDocApi(renamingTarget.id, { name: trimmed });
        if (mountedRef.current) {
          applyDocsProjection((prev) =>
            prev.map((d) => (d.id === renamingTarget.id ? (res?.doc ?? { ...d, name: trimmed }) : d)),
          );
        }
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

  const commitPreviewTitleRename = async (explicitRaw?: string) => {
    if (!previewTarget || previewTarget.kind !== 'cloud_doc' || previewTarget.readOnly || !previewTarget.isOwner) return;
    const raw = (explicitRaw ?? previewTitleDraft).trim();
    if (!raw) {
      setPreviewTitleDraft(previewTarget.name);
      return;
    }
    const requiredExt = getCloudDocExt(previewTarget.name);
    const nextName = normalizeCloudDocName(raw, requiredExt || undefined);
    if (!nextName) {
      setPreviewTitleDraft(previewTarget.name);
      return;
    }

    const docId = previewTarget.id;
    const existingEntry = titleSaveQueueRef.current.get(docId);
    const currentEffectiveName = existingEntry && (existingEntry.inFlight || existingEntry.pending)
      ? existingEntry.lastQueuedName
      : previewTarget.name;
    if (nextName === currentEffectiveName) {
      if (!existingEntry?.inFlight && !existingEntry?.pending) {
        setPreviewTitleDraft(previewTarget.name);
      }
      return;
    }

    const intent: TitleSaveIntent = {
      name: nextName,
      fallbackMime: previewTarget.mimeType,
      editGen: activePreviewRef.current.editGen,
    };

    const entry: TitleSaveQueueEntry = existingEntry ?? {
      inFlight: false,
      activeIntent: null,
      lastQueuedName: nextName,
      pending: null,
    };
    entry.lastQueuedName = nextName;
    entry.pending = intent;
    titleSaveQueueRef.current.set(docId, entry);

    if (savedStatusTimerRef.current) {
      clearTimeout(savedStatusTimerRef.current);
      savedStatusTimerRef.current = null;
    }
    setPreviewTitleStatus('saving');
    setError(null);

    if (entry.inFlight) return;
    entry.inFlight = true;

    try {
      while (entry.pending) {
        const currentIntent = entry.pending;
        entry.pending = null;
        entry.activeIntent = currentIntent;
        if (mountedRef.current && activePreviewRef.current.docId === docId) {
          setPreviewTitleStatus('saving');
        }
        const res = await updateCloudDocApi(docId, { name: currentIntent.name });
        if (!mountedRef.current) return;
        const finalName = res?.doc?.name || currentIntent.name;
        const finalMime = res?.doc?.mimeType || currentIntent.fallbackMime;

        applyDocsProjection((prev) =>
          prev.map((d) => (d.id === docId ? (res?.doc ?? { ...d, name: finalName, mimeType: finalMime }) : d)),
        );
        setRecentItems((prev) => prev.map((r) => (
          r.cloudDocId === docId ? { ...r, title: finalName, mimeType: finalMime } : r
        )));
        setPreviewTarget((prev) => (
          prev && prev.kind === 'cloud_doc' && prev.id === docId
            ? { ...prev, name: finalName, mimeType: finalMime }
            : prev
        ));

        const sameDocActive = activePreviewRef.current.docId === docId;
        const hasMorePending = entry.pending !== null;
        const noNewerLocalEdit = activePreviewRef.current.editGen === currentIntent.editGen;
        if (sameDocActive && !hasMorePending && noNewerLocalEdit) {
          setPreviewTitleDraft(finalName);
          setPreviewTitleStatus('saved');
          if (savedStatusTimerRef.current) clearTimeout(savedStatusTimerRef.current);
          const timerDocId = docId;
          const timerEditGen = currentIntent.editGen;
          savedStatusTimerRef.current = setTimeout(() => {
            if (
              mountedRef.current
              && activePreviewRef.current.docId === timerDocId
              && activePreviewRef.current.editGen === timerEditGen
            ) {
              setPreviewTitleStatus('idle');
            }
          }, 1800);
        } else if (sameDocActive && !hasMorePending && !noNewerLocalEdit) {
          setPreviewTitleStatus('idle');
        }
      }
    } catch (err: unknown) {
      entry.pending = null;
      entry.activeIntent = null;
      entry.lastQueuedName = '';
      if (!mountedRef.current) return;
      if (activePreviewRef.current.docId === docId) {
        setPreviewTitleStatus('idle');
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      entry.inFlight = false;
      entry.activeIntent = null;
      if (!entry.pending) {
        titleSaveQueueRef.current.delete(docId);
      }
    }
  };

  const handleMoveSubmit = async (e: Event) => {
    e.preventDefault();
    if (!movingDocId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const nextFolderId = movingFolderTargetId || null;
      const res = await updateCloudDocApi(movingDocId, { folderId: nextFolderId });
      if (!mountedRef.current) return;
      applyDocsProjection((prev) =>
        prev.map((d) => (d.id === movingDocId ? (res?.doc ?? { ...d, folderId: nextFolderId }) : d)),
      );
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
        invalidateDocsAuthority();
        if (currentFolderId === confirmDelete.id) {
          setCurrentFolderId(null);
        }
      } else {
        await deleteCloudDocApi(confirmDelete.id);
        if (mountedRef.current) {
          applyDocsProjection((prev) => prev.filter((d) => d.id !== confirmDelete.id));
        }
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
    if (!item.accessible || (item.sourceKind === 'server_file' && !item.serverOnline)) {
      setRecentBlockedNotice(item);
      return;
    }
    if (item.sourceKind === 'cloud_doc' && item.cloudDocId) {
      const isShared = sharedDocs.some((sd) => sd.id === item.cloudDocId);
      const isOwned = docs.some((d) => d.id === item.cloudDocId) || !isShared;
      openPreview({
        kind: 'cloud_doc',
        id: item.cloudDocId,
        name: item.title,
        mimeType: item.mimeType,
        readOnly: item.role ? item.role !== 'editor' : item.openMode === 'view',
        allowDownload: item.allowDownload !== false,
        isOwner: isOwned,
      });
      return;
    }
    if (item.sourceKind === 'server_file' && item.serverId && item.filePath) {
      openPreview({
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
    setOpenMenu(null);
    openPreview({
      kind: 'cloud_doc',
      id: doc.id,
      name: doc.name,
      mimeType: doc.mimeType,
      readOnly: false,
      allowDownload: true,
      isOwner: true,
    });
  };

  const handleOpenSharedCloudDoc = (doc: SharedCloudDocItem) => {
    setRecentBlockedNotice(null);
    setOpenMenu(null);
    openPreview({
      kind: 'cloud_doc',
      id: doc.id,
      name: doc.name,
      mimeType: doc.mimeType,
      readOnly: doc.role !== 'editor',
      allowDownload: doc.allowDownload,
      isOwner: false,
    });
  };

  const isCurrentShareTarget = (seq: number, kind: CloudDocShareTargetKind, id: string): boolean => (
    mountedRef.current
    && shareSeqRef.current === seq
    && shareTargetRef.current?.kind === kind
    && shareTargetRef.current?.id === id
  );

  function closeShareDialog() {
    shareSeqRef.current += 1;
    shareAbortRef.current?.abort();
    shareAbortRef.current = null;
    shareTargetRef.current = null;
    setShareTarget(null);
    setShareList([]);
    setShareLoading(false);
    setShareSubmitting(false);
  }

  const handleDownloadCloudDoc = async (docId: string, filename: string) => {
    try {
      await downloadCloudDocApi(docId, filename);
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const openShareDialog = async (kind: CloudDocShareTargetKind, id: string, name: string) => {
    setOpenMenu(null);
    const seq = ++shareSeqRef.current;
    shareAbortRef.current?.abort();
    const controller = new AbortController();
    shareAbortRef.current = controller;
    const nextTarget = { kind, id, name };
    shareTargetRef.current = nextTarget;

    setShareTarget(nextTarget);
    setShareList([]);
    setShareLoading(true);
    setShareSubmitting(false);
    setError(null);
    try {
      const [sharesRes, teamsRes] = await Promise.all([
        listCloudDocSharesApi(kind, id, controller.signal),
        listCloudDocTeamsApi(controller.signal).catch(() => ({ teams })),
      ]);
      if (!isCurrentShareTarget(seq, kind, id) || controller.signal.aborted) return;
      setShareList(sharesRes.shares);
      setTeams(teamsRes.teams);
      if (teamsRes.teams.length > 0 && !shareTeamId) {
        setShareTeamId(teamsRes.teams[0]!.id);
      }
      if (teamsRes.teams.length === 0) {
        setShareMode('user');
      }
    } catch (err: unknown) {
      if (!isCurrentShareTarget(seq, kind, id) || controller.signal.aborted) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isCurrentShareTarget(seq, kind, id)) {
        setShareLoading(false);
      }
    }
  };

  const handleCreateShare = async (e: Event) => {
    e.preventDefault();
    const target = shareTargetRef.current ?? shareTarget;
    if (!target || shareSubmitting) return;
    if (shareMode === 'team' && !shareTeamId) return;
    if (shareMode === 'user' && !shareUsername.trim()) return;

    const seq = shareSeqRef.current;
    const controller = shareAbortRef.current;
    setShareSubmitting(true);
    setError(null);
    try {
      await upsertCloudDocShareApi(
        {
          targetKind: target.kind,
          targetId: target.id,
          shareMode,
          targetTeamId: shareMode === 'team' ? shareTeamId : undefined,
          targetUsername: shareMode === 'user' ? shareUsername.trim() : undefined,
          role: shareRole,
          allowDownload: shareAllowDownload,
        },
        controller?.signal,
      );
      if (!isCurrentShareTarget(seq, target.kind, target.id) || controller?.signal.aborted) return;
      const res = await listCloudDocSharesApi(target.kind, target.id, controller?.signal);
      if (!isCurrentShareTarget(seq, target.kind, target.id) || controller?.signal.aborted) return;
      setShareList(res.shares);
      setShareUsername('');
    } catch (err: unknown) {
      if (!isCurrentShareTarget(seq, target.kind, target.id) || controller?.signal.aborted) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isCurrentShareTarget(seq, target.kind, target.id)) {
        setShareSubmitting(false);
      }
    }
  };

  const handleRevokeShare = async (shareId: string) => {
    const target = shareTargetRef.current ?? shareTarget;
    if (!target || shareSubmitting) return;
    const seq = shareSeqRef.current;
    const controller = shareAbortRef.current;
    setShareSubmitting(true);
    setError(null);
    try {
      await revokeCloudDocShareApi(shareId, controller?.signal);
      if (!isCurrentShareTarget(seq, target.kind, target.id) || controller?.signal.aborted) return;
      setShareList((prev) => prev.filter((s) => s.id !== shareId));
    } catch (err: unknown) {
      if (!isCurrentShareTarget(seq, target.kind, target.id) || controller?.signal.aborted) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isCurrentShareTarget(seq, target.kind, target.id)) {
        setShareSubmitting(false);
      }
    }
  };

  const renderShareModal = () => {
    if (!shareTarget) return null;
    return (
      <div
        class="cloud-docs-modal-backdrop"
        role="dialog"
        aria-modal="true"
        onClick={(e) => {
          if (e.target === e.currentTarget) closeShareDialog();
        }}
      >
        <div class="cloud-docs-share-panel" data-testid="cloud-docs-share-panel">
          <div class="cloud-docs-share-head">
            <span class="cloud-docs-share-title">
              <ShareIcon />
              <span>{t('cloud_docs.share.title', 'Share "{{name}}"', { name: shareTarget.name })}</span>
            </span>
            <button
              type="button"
              class="cloud-docs-icon-btn"
              data-testid="cloud-docs-share-close"
              onClick={closeShareDialog}
              aria-label={t('window.close', 'Close')}
            >
              <CloseIcon />
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
              disabled={busy || shareSubmitting || (shareMode === 'team' ? !shareTeamId : !shareUsername.trim())}
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
                  <span class="cloud-docs-share-principal">
                    <PrincipalIcon mode={s.shareMode} />
                    <span>
                      {s.shareMode === 'team'
                        ? (s.targetTeamName || s.targetTeamId)
                        : (s.targetUserName || s.targetUserUsername || s.targetUserId)}
                      {' · '}
                      {s.role === 'editor'
                        ? t('cloud_docs.share.role_editor', 'Editor')
                        : t('cloud_docs.share.role_viewer', 'Viewer')}
                      {!s.allowDownload ? ` · ${t('cloud_docs.share.no_download', 'No Download')}` : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    class="cloud-docs-btn is-danger"
                    data-testid={`revoke-cloud-share-${s.id}`}
                    onClick={() => void handleRevokeShare(s.id)}
                    disabled={busy || shareSubmitting}
                  >
                    {t('cloud_docs.share.revoke', 'Revoke')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderContextMenu = () => {
    if (!contextMenu) return null;
    const { target, x, y } = contextMenu;
    const runAction = (fn: () => void) => {
      setContextMenu(null);
      fn();
    };

    const renderOwnedDocItems = (doc: CloudDocItem) => (
      <>
        <button
          type="button"
          role="menuitem"
          class="cloud-docs-popover-item"
          data-testid="cloud-docs-ctx-open"
          onClick={() => runAction(() => handleOpenCloudDoc(doc))}
        >
          <OpenDocIcon />
          <span>{t('cloud_docs.actions.edit', 'Edit')}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="cloud-docs-popover-item"
          data-testid="cloud-docs-ctx-download"
          onClick={() => runAction(() => { void handleDownloadCloudDoc(doc.id, doc.name); })}
        >
          <DownloadIcon />
          <span>{t('cloud_docs.actions.download', 'Download')}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="cloud-docs-popover-item"
          data-testid="cloud-docs-ctx-share"
          onClick={() => runAction(() => { void openShareDialog('doc', doc.id, doc.name); })}
        >
          <ShareIcon />
          <span>{t('cloud_docs.actions.share', 'Share')}</span>
        </button>
        <div class="cloud-docs-context-divider" role="separator" />
        <button
          type="button"
          role="menuitem"
          class="cloud-docs-popover-item"
          data-testid="cloud-docs-ctx-rename"
          disabled={busy}
          onClick={() => runAction(() => setRenamingTarget({ kind: 'doc', id: doc.id, value: doc.name }))}
        >
          <PencilIcon />
          <span>{t('cloud_docs.actions.rename', 'Rename')}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="cloud-docs-popover-item"
          data-testid="cloud-docs-ctx-move"
          disabled={busy}
          onClick={() => runAction(() => {
            setMovingDocId(doc.id);
            setMovingFolderTargetId(doc.folderId ?? '');
          })}
        >
          <MoveFolderIcon />
          <span>{t('cloud_docs.actions.move', 'Move')}</span>
        </button>
        <div class="cloud-docs-context-divider" role="separator" />
        <button
          type="button"
          role="menuitem"
          class="cloud-docs-popover-item is-danger"
          data-testid="cloud-docs-ctx-delete"
          disabled={busy}
          onClick={() => runAction(() => setConfirmDelete({ kind: 'doc', id: doc.id, name: doc.name }))}
        >
          <TrashIcon />
          <span>{t('common.delete', 'Delete')}</span>
        </button>
      </>
    );

    const renderOwnedFolderItems = (folder: CloudDocFolder) => (
      <>
        <button
          type="button"
          role="menuitem"
          class="cloud-docs-popover-item"
          data-testid="cloud-docs-ctx-open"
          onClick={() => runAction(() => setCurrentFolderId(folder.id))}
        >
          <OpenDocIcon />
          <span>{t('cloud_docs.actions.open', 'Open')}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="cloud-docs-popover-item"
          data-testid="cloud-docs-ctx-share"
          onClick={() => runAction(() => { void openShareDialog('folder', folder.id, folder.name); })}
        >
          <ShareIcon />
          <span>{t('cloud_docs.actions.share', 'Share')}</span>
        </button>
        <div class="cloud-docs-context-divider" role="separator" />
        <button
          type="button"
          role="menuitem"
          class="cloud-docs-popover-item"
          data-testid="cloud-docs-ctx-rename"
          disabled={busy}
          onClick={() => runAction(() => setRenamingTarget({ kind: 'folder', id: folder.id, value: folder.name }))}
        >
          <PencilIcon />
          <span>{t('cloud_docs.actions.rename', 'Rename')}</span>
        </button>
        <div class="cloud-docs-context-divider" role="separator" />
        <button
          type="button"
          role="menuitem"
          class="cloud-docs-popover-item is-danger"
          data-testid="cloud-docs-ctx-delete"
          disabled={busy}
          onClick={() => runAction(() => setConfirmDelete({ kind: 'folder', id: folder.id, name: folder.name }))}
        >
          <TrashIcon />
          <span>{t('common.delete', 'Delete')}</span>
        </button>
      </>
    );

    const renderSharedDocItems = (doc: SharedCloudDocItem) => (
      <>
        <button
          type="button"
          role="menuitem"
          class="cloud-docs-popover-item"
          data-testid="cloud-docs-ctx-open"
          onClick={() => runAction(() => handleOpenSharedCloudDoc(doc))}
        >
          <OpenDocIcon />
          <span>
            {doc.role === 'editor'
              ? t('cloud_docs.actions.edit', 'Edit')
              : t('cloud_docs.actions.view', 'View')}
          </span>
        </button>
        {doc.allowDownload && (
          <button
            type="button"
            role="menuitem"
            class="cloud-docs-popover-item"
            data-testid="cloud-docs-ctx-download"
            onClick={() => runAction(() => { void handleDownloadCloudDoc(doc.id, doc.name); })}
          >
            <DownloadIcon />
            <span>{t('cloud_docs.actions.download', 'Download')}</span>
          </button>
        )}
      </>
    );

    const renderSharedFolderItems = (folder: SharedCloudFolderItem) => (
      <button
        type="button"
        role="menuitem"
        class="cloud-docs-popover-item"
        data-testid="cloud-docs-ctx-open"
        onClick={() => runAction(() => setSharedCurrentFolderId(folder.id))}
      >
        <OpenDocIcon />
        <span>{t('cloud_docs.actions.open', 'Open')}</span>
      </button>
    );

    const renderRecentDocItems = (item: RecentDocumentItem) => {
      const isOwnedCloudDoc = Boolean(
        item.sourceKind === 'cloud_doc'
        && item.cloudDocId
        && docs.some((d) => d.id === item.cloudDocId),
      );
      const ownedDoc = isOwnedCloudDoc ? docs.find((d) => d.id === item.cloudDocId) ?? null : null;
      const canEdit = item.role ? item.role === 'editor' : item.openMode === 'edit';
      const canDownloadCloud = Boolean(
        item.sourceKind === 'cloud_doc'
        && item.cloudDocId
        && item.accessible
        && item.allowDownload !== false,
      );
      return (
        <>
          <button
            type="button"
            role="menuitem"
            class="cloud-docs-popover-item"
            data-testid="cloud-docs-ctx-open"
            onClick={() => runAction(() => handleOpenRecentItem(item))}
          >
            <OpenDocIcon />
            <span>
              {canEdit
                ? t('cloud_docs.actions.edit', 'Edit')
                : item.role === 'viewer' || item.openMode === 'view'
                  ? t('cloud_docs.actions.view', 'View')
                  : t('cloud_docs.actions.open', 'Open')}
            </span>
          </button>
          {canDownloadCloud && item.cloudDocId && (
            <button
              type="button"
              role="menuitem"
              class="cloud-docs-popover-item"
              data-testid="cloud-docs-ctx-download"
              onClick={() => runAction(() => { void handleDownloadCloudDoc(item.cloudDocId!, item.title); })}
            >
              <DownloadIcon />
              <span>{t('cloud_docs.actions.download', 'Download')}</span>
            </button>
          )}
          {ownedDoc && (
            <button
              type="button"
              role="menuitem"
              class="cloud-docs-popover-item"
              data-testid="cloud-docs-ctx-share"
              onClick={() => runAction(() => { void openShareDialog('doc', ownedDoc.id, ownedDoc.name); })}
            >
              <ShareIcon />
              <span>{t('cloud_docs.actions.share', 'Share')}</span>
            </button>
          )}
          <div class="cloud-docs-context-divider" role="separator" />
          <button
            type="button"
            role="menuitem"
            class="cloud-docs-popover-item is-danger"
            data-testid="cloud-docs-ctx-remove-recent"
            disabled={busy}
            onClick={() => runAction(() => { void handleDeleteRecent(item.id); })}
          >
            <CloseIcon size={13} />
            <span>{t('cloud_docs.actions.remove_recent', 'Remove from Recent')}</span>
          </button>
        </>
      );
    };

    const renderCanvasItems = () => (
      <>
        {activeTab !== 'shared' && (
          <>
            <button
              type="button"
              role="menuitem"
              class="cloud-docs-popover-item"
              data-testid="cloud-docs-ctx-new-docx"
              disabled={busy}
              onClick={() => runAction(() => { void handleCreateBlankInstant('docx'); })}
            >
              <DocKindIcon name="new.docx" size={14} />
              <span>{t('cloud_docs.gallery.blank_docx', 'Blank document')}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              class="cloud-docs-popover-item"
              data-testid="cloud-docs-ctx-new-xlsx"
              disabled={busy}
              onClick={() => runAction(() => { void handleCreateBlankInstant('xlsx'); })}
            >
              <DocKindIcon name="new.xlsx" size={14} />
              <span>{t('cloud_docs.gallery.blank_xlsx', 'Blank spreadsheet')}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              class="cloud-docs-popover-item"
              data-testid="cloud-docs-ctx-new-pptx"
              disabled={busy}
              onClick={() => runAction(() => { void handleCreateBlankInstant('pptx'); })}
            >
              <DocKindIcon name="new.pptx" size={14} />
              <span>{t('cloud_docs.gallery.blank_pptx', 'Blank presentation')}</span>
            </button>
            {activeTab === 'my_docs' && (
              <button
                type="button"
                role="menuitem"
                class="cloud-docs-popover-item"
                data-testid="cloud-docs-ctx-new-folder"
                disabled={busy}
                onClick={() => runAction(() => setNewFolderMode(true))}
              >
                <FolderPlusIcon />
                <span>{t('cloud_docs.actions.new_folder', 'New Folder')}</span>
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              class="cloud-docs-popover-item"
              data-testid="cloud-docs-ctx-upload"
              disabled={busy}
              onClick={() => runAction(() => fileInputRef.current?.click())}
            >
              <UploadIcon />
              <span>{t('cloud_docs.actions.upload', 'Upload')}</span>
            </button>
            <div class="cloud-docs-context-divider" role="separator" />
          </>
        )}
        <button
          type="button"
          role="menuitem"
          class="cloud-docs-popover-item"
          data-testid="cloud-docs-ctx-toggle-view"
          onClick={() => runAction(() => setViewMode((prev) => (prev === 'grid' ? 'list' : 'grid')))}
        >
          {viewMode === 'grid' ? <ViewListIcon /> : <ViewGridIcon />}
          <span>
            {viewMode === 'grid'
              ? t('cloud_docs.view.list', 'List view')
              : t('cloud_docs.view.grid', 'Grid view')}
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="cloud-docs-popover-item"
          data-testid="cloud-docs-ctx-refresh"
          disabled={loading || busy}
          onClick={() => runAction(() => { void refreshData(); })}
        >
          <RefreshIcon />
          <span>{t('common.refresh', 'Refresh')}</span>
        </button>
      </>
    );

    return (
      <div
        ref={contextMenuRef}
        class="cloud-docs-context-menu"
        data-testid="cloud-docs-context-menu"
        data-target-kind={target.kind}
        role="menu"
        style={{ left: `${x}px`, top: `${y}px` }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {target.kind === 'doc' && renderOwnedDocItems(target.doc)}
        {target.kind === 'folder' && renderOwnedFolderItems(target.folder)}
        {target.kind === 'shared-doc' && renderSharedDocItems(target.doc)}
        {target.kind === 'shared-folder' && renderSharedFolderItems(target.folder)}
        {target.kind === 'recent-doc' && renderRecentDocItems(target.item)}
        {target.kind === 'canvas' && renderCanvasItems()}
      </div>
    );
  };

  if (previewTarget) {
    const targetName = previewTarget.kind === 'cloud_doc' ? previewTarget.name : previewTarget.title;
    const canRenameInPreview = previewTarget.kind === 'cloud_doc' && !previewTarget.readOnly && previewTarget.isOwner;
    const canShareInPreview = previewTarget.kind === 'cloud_doc' && previewTarget.isOwner;

    return (
      <div class={`cloud-docs-panel${standalone ? ' is-standalone' : ''}`} data-testid="cloud-docs-panel">
        <div class="cloud-docs-preview-header" data-testid="cloud-docs-preview-header">
          <button
            type="button"
            class="cloud-docs-btn"
            data-testid="cloud-docs-preview-back"
            aria-label={t('cloud_docs.actions.back_to_list', 'Back')}
            title={t('cloud_docs.actions.back_to_list', 'Back')}
            onClick={() => {
              openPreview(null);
              void refreshData();
            }}
          >
            <BackArrowIcon />
            <span class="cloud-docs-preview-btn-label">{t('cloud_docs.actions.back_to_list', 'Back')}</span>
          </button>
          <DocKindIcon name={targetName} size={22} />
          {canRenameInPreview ? (
            <div class="cloud-docs-preview-title-wrap" data-testid="cloud-docs-preview-title-wrap">
              <input
                ref={previewTitleInputRef}
                type="text"
                class="cloud-docs-preview-title-input"
                data-testid="cloud-docs-preview-title-input"
                aria-label={t('cloud_docs.preview.rename_aria', 'Document title')}
                value={previewTitleDraft}
                onFocus={() => {
                  previewTitleCancelledRef.current = false;
                }}
                onInput={(e) => {
                  const val = (e.currentTarget as HTMLInputElement).value;
                  previewTitleCancelledRef.current = false;
                  activePreviewRef.current.editGen = ++editGenCounterRef.current;
                  if (savedStatusTimerRef.current) {
                    clearTimeout(savedStatusTimerRef.current);
                    savedStatusTimerRef.current = null;
                  }
                  setPreviewTitleDraft(val);
                  setPreviewTitleStatus((prev) => (prev === 'saved' ? 'idle' : prev));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const val = (e.currentTarget as HTMLInputElement).value;
                    void commitPreviewTitleRename(val);
                    (e.currentTarget as HTMLInputElement).blur();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    previewTitleCancelledRef.current = true;
                    activePreviewRef.current.editGen = ++editGenCounterRef.current;
                    if (savedStatusTimerRef.current) {
                      clearTimeout(savedStatusTimerRef.current);
                      savedStatusTimerRef.current = null;
                    }
                    setPreviewTitleDraft(previewTarget.name);
                    setPreviewTitleStatus('idle');
                    (e.currentTarget as HTMLInputElement).blur();
                  }
                }}
                onBlur={(e) => {
                  if (previewTitleCancelledRef.current) {
                    previewTitleCancelledRef.current = false;
                    return;
                  }
                  void commitPreviewTitleRename((e.currentTarget as HTMLInputElement).value);
                }}
              />
              <span
                class="cloud-docs-preview-edit-hint"
                aria-hidden="true"
                onClick={() => previewTitleInputRef.current?.focus()}
              >
                <PencilIcon />
              </span>
              {previewTitleStatus === 'saving' && (
                <span class="cloud-docs-preview-save-state" data-testid="cloud-docs-preview-saving">
                  {t('cloud_docs.preview.saving', 'Saving...')}
                </span>
              )}
              {previewTitleStatus === 'saved' && (
                <span class="cloud-docs-preview-save-state is-saved" data-testid="cloud-docs-preview-saved">
                  {t('cloud_docs.preview.saved', 'Saved')}
                </span>
              )}
            </div>
          ) : (
            <div class="cloud-docs-preview-title-wrap" data-testid="cloud-docs-preview-title-wrap">
              <span
                class="cloud-docs-preview-title"
                data-testid="cloud-docs-preview-title"
                title={previewTarget.kind === 'cloud_doc' ? previewTarget.name : previewTarget.path}
              >
                {targetName}
              </span>
              {previewTarget.readOnly && (
                <span class="cloud-docs-badge is-muted">{t('cloud_docs.preview.read_only', 'Read-only')}</span>
              )}
            </div>
          )}
          <div class="cloud-docs-preview-actions">
            {canShareInPreview && (
              <button
                type="button"
                class="cloud-docs-btn is-primary"
                data-testid="cloud-docs-preview-share"
                aria-label={t('cloud_docs.actions.share', 'Share')}
                title={t('cloud_docs.actions.share', 'Share')}
                onClick={() => void openShareDialog('doc', previewTarget.id, previewTarget.name)}
              >
                <ShareIcon />
                <span class="cloud-docs-preview-btn-label">{t('cloud_docs.actions.share', 'Share')}</span>
              </button>
            )}
            {previewTarget.kind === 'cloud_doc' && previewTarget.allowDownload && (
              <button
                type="button"
                class="cloud-docs-btn"
                data-testid="cloud-docs-preview-download"
                aria-label={t('cloud_docs.actions.download', 'Download')}
                title={t('cloud_docs.actions.download', 'Download')}
                onClick={() => void handleDownloadCloudDoc(previewTarget.id, previewTarget.name)}
              >
                <DownloadIcon />
                <span class="cloud-docs-preview-btn-label">{t('cloud_docs.actions.download', 'Download')}</span>
              </button>
            )}
          </div>
        </div>
        {error && (
          <div class="cloud-docs-banner is-error" data-testid="cloud-docs-error">
            <span>{error}</span>
            <button type="button" class="cloud-docs-link-btn" onClick={() => setError(null)}><CloseIcon /></button>
          </div>
        )}
        <div class="cloud-docs-preview-stage">
          <Suspense fallback={<div class="cloud-docs-loading">…</div>}>
            {previewTarget.kind === 'cloud_doc' ? (
              <OfficePreview
                cloudDocId={previewTarget.id}
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
        {renderShareModal()}
      </div>
    );
  }

  const listContainerClass = viewMode === 'grid' ? 'cloud-docs-grid' : 'cloud-docs-list';
  const showGallery = activeTab === 'recent' || activeTab === 'my_docs';

  return (
    <div class={`cloud-docs-panel${standalone ? ' is-standalone' : ''}`} data-testid="cloud-docs-panel">
      <div class="cloud-docs-header">
        <div class="cloud-docs-header-brand">
          <div class="cloud-docs-brand-mark">
            <CloudDocsGlyphIcon size={20} />
            <span class="cloud-docs-brand-title">{t('cloud_docs.title', 'Cloud Docs')}</span>
          </div>
          <div class="cloud-docs-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'recent'}
              data-testid="cloud-docs-tab-recent"
              class={`cloud-docs-tab${activeTab === 'recent' ? ' is-active' : ''}`}
              onClick={() => { setContextMenu(null); setActiveTab('recent'); }}
            >
              {t('cloud_docs.tabs.recent', 'Recent')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'my_docs'}
              data-testid="cloud-docs-tab-my-docs"
              class={`cloud-docs-tab${activeTab === 'my_docs' ? ' is-active' : ''}`}
              onClick={() => { setContextMenu(null); setActiveTab('my_docs'); }}
            >
              {t('cloud_docs.tabs.my_docs', 'Cloud Docs')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'shared'}
              data-testid="cloud-docs-tab-shared"
              class={`cloud-docs-tab${activeTab === 'shared' ? ' is-active' : ''}`}
              onClick={() => { setContextMenu(null); setActiveTab('shared'); }}
            >
              {t('cloud_docs.tabs.shared', 'Shared')}
              {(sharedFolders.length + sharedDocs.length) > 0 && (
                <span class="cloud-docs-tab-count">{sharedFolders.length + sharedDocs.length}</span>
              )}
            </button>
          </div>
        </div>

        <div class="cloud-docs-header-right">
          <div class="cloud-docs-search-pill">
            <span class="cloud-docs-search-icon"><SearchIcon /></span>
            <input
              type="search"
              class="cloud-docs-search"
              data-testid="cloud-docs-search"
              placeholder={t('cloud_docs.search_placeholder', 'Search documents...')}
              value={search}
              onInput={(e) => setSearch((e.currentTarget as HTMLInputElement).value)}
            />
            {search && (
              <button
                type="button"
                class="cloud-docs-search-clear"
                onClick={() => setSearch('')}
                aria-label={t('cloud_docs.actions.clear_search', 'Clear search')}
              >
                <CloseIcon size={12} />
              </button>
            )}
          </div>

          <select
            class="cloud-docs-select"
            data-testid="cloud-docs-type-filter"
            aria-label={t('cloud_docs.filter.all', 'All types')}
            value={typeFilter}
            onInput={(e) => setTypeFilter((e.currentTarget as HTMLSelectElement).value as CloudDocsTypeFilter)}
            onChange={(e) => setTypeFilter((e.currentTarget as HTMLSelectElement).value as CloudDocsTypeFilter)}
          >
            <option value="all">{t('cloud_docs.filter.all', 'All types')}</option>
            <option value="word">{t('cloud_docs.filter.word', 'Documents')}</option>
            <option value="cell">{t('cloud_docs.filter.cell', 'Spreadsheets')}</option>
            <option value="slide">{t('cloud_docs.filter.slide', 'Presentations')}</option>
            <option value="pdf">{t('cloud_docs.filter.pdf', 'PDFs')}</option>
          </select>

          <select
            class="cloud-docs-select"
            data-testid="cloud-docs-sort-select"
            aria-label={t('cloud_docs.sort.label', 'Sort by')}
            value={sortBy}
            onInput={(e) => setSortBy((e.currentTarget as HTMLSelectElement).value as CloudDocsSortBy)}
            onChange={(e) => setSortBy((e.currentTarget as HTMLSelectElement).value as CloudDocsSortBy)}
          >
            <option value="updated">{t('cloud_docs.sort.updated', 'Last modified')}</option>
            <option value="name">{t('cloud_docs.sort.name', 'Name')}</option>
            <option value="size">{t('cloud_docs.sort.size', 'Size')}</option>
          </select>

          <div class="cloud-docs-view-toggle" role="group">
            <button
              type="button"
              class={`cloud-docs-icon-btn${viewMode === 'list' ? ' is-active' : ''}`}
              data-testid="cloud-docs-view-list"
              onClick={() => setViewMode('list')}
              title={t('cloud_docs.view.list', 'List view')}
              aria-pressed={viewMode === 'list'}
            >
              <ViewListIcon />
            </button>
            <button
              type="button"
              class={`cloud-docs-icon-btn${viewMode === 'grid' ? ' is-active' : ''}`}
              data-testid="cloud-docs-view-grid"
              onClick={() => setViewMode('grid')}
              title={t('cloud_docs.view.grid', 'Grid view')}
              aria-pressed={viewMode === 'grid'}
            >
              <ViewGridIcon />
            </button>
          </div>

          <button
            type="button"
            class="cloud-docs-icon-btn"
            data-testid="cloud-docs-refresh"
            onClick={() => void refreshData()}
            disabled={loading || busy}
            title={t('common.refresh', 'Refresh')}
            aria-label={t('common.refresh', 'Refresh')}
          >
            <RefreshIcon />
          </button>
          {onClose && (
            <button
              type="button"
              class="cloud-docs-icon-btn"
              onClick={onClose}
              aria-label={t('window.close', 'Close')}
            >
              <CloseIcon />
            </button>
          )}
        </div>
      </div>

      {error && (
        <div class="cloud-docs-banner is-error" data-testid="cloud-docs-error">
          <span>{error}</span>
          <button type="button" class="cloud-docs-link-btn" onClick={() => setError(null)}><CloseIcon /></button>
        </div>
      )}

      {recentBlockedNotice && (
        <div class="cloud-docs-banner is-warning" data-testid="cloud-docs-recent-blocked">
          <span>
            {recentBlockedNotice.accessReason === 'server_offline' || (recentBlockedNotice.sourceKind === 'server_file' && !recentBlockedNotice.serverOnline)
              ? t('cloud_docs.errors.server_offline', 'The server is currently offline. Reconnect the server and refresh, or remove this entry.')
              : recentBlockedNotice.accessReason === 'server_not_found'
                ? t('cloud_docs.errors.server_not_found', 'This server no longer exists or is unavailable.')
                : recentBlockedNotice.accessReason === 'cloud_doc_missing'
                  ? t('cloud_docs.errors.doc_missing', 'This cloud document is no longer available.')
                  : t('cloud_docs.errors.access_denied', 'You no longer have permission to open this document.')}
          </span>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            {(recentBlockedNotice.accessReason === 'server_offline' || (recentBlockedNotice.sourceKind === 'server_file' && !recentBlockedNotice.serverOnline)) && (
              <button
                type="button"
                class="cloud-docs-btn"
                data-testid="cloud-docs-refresh-blocked-recent"
                onClick={() => void refreshData()}
              >
                {t('common.refresh', 'Refresh')}
              </button>
            )}
            <button
              type="button"
              class="cloud-docs-btn"
              data-testid="cloud-docs-remove-blocked-recent"
              onClick={() => void handleDeleteRecent(recentBlockedNotice.id)}
            >
              {t('cloud_docs.actions.remove_recent', 'Remove from Recent')}
            </button>
          </div>
        </div>
      )}

      {showGallery && (
        <div class="cloud-docs-gallery-section" data-testid="cloud-docs-template-gallery">
          <div class="cloud-docs-gallery-head">
            <span class="cloud-docs-gallery-title">{t('cloud_docs.gallery.title', 'Start a new document')}</span>
            <div class="cloud-docs-gallery-actions">
              {activeTab === 'my_docs' && (
                <button
                  type="button"
                  class="cloud-docs-btn"
                  data-testid="cloud-docs-new-folder-btn"
                  onClick={() => setNewFolderMode((v) => !v)}
                  disabled={busy}
                >
                  <FolderPlusIcon />
                  <span>{t('cloud_docs.actions.new_folder', 'New Folder')}</span>
                </button>
              )}
              <button
                type="button"
                class="cloud-docs-btn is-primary"
                data-testid="cloud-docs-upload-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
              >
                <UploadIcon />
                <span>{t('cloud_docs.actions.upload', 'Upload')}</span>
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

          <div class="cloud-docs-gallery-strip" data-testid="cloud-docs-gallery-strip">
            {CLOUD_DOC_BLANK_TYPES.map((type) => {
              const cardTitle = type === 'xlsx'
                ? t('cloud_docs.gallery.blank_xlsx', 'Blank spreadsheet')
                : type === 'pptx'
                  ? t('cloud_docs.gallery.blank_pptx', 'Blank presentation')
                  : t('cloud_docs.gallery.blank_docx', 'Blank document');
              return (
                <button
                  key={type}
                  type="button"
                  class={`cloud-docs-template-card is-${type}`}
                  data-testid={`cloud-docs-new-${type}-btn`}
                  onClick={() => void handleCreateBlankInstant(type)}
                  disabled={busy}
                  title={cardTitle}
                  aria-label={cardTitle}
                >
                  <DocKindIcon name={`new.${type}`} size={16} />
                  <span class="cloud-docs-template-plus" aria-hidden="true">+</span>
                  <span class="cloud-docs-template-ext">{t(`cloud_docs.blank_type.${type}`, type.toUpperCase())}</span>
                </button>
              );
            })}
          </div>
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

      <div
        class={`cloud-docs-body${dragActive ? ' is-drag-over' : ''}`}
        data-testid="cloud-docs-canvas"
        onContextMenu={(e) => openContextMenu(e as unknown as MouseEvent, { kind: 'canvas' })}
        onScroll={() => { if (contextMenu) setContextMenu(null); }}
        onDragOver={(e) => {
          if (activeTab === 'shared') return;
          e.preventDefault();
          if (!dragActive) setDragActive(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragActive(false);
        }}
        onDrop={(e) => handleDropUpload(e as unknown as DragEvent)}
      >
        {dragActive && (
          <div class="cloud-docs-drop-overlay" data-testid="cloud-docs-drop-overlay">
            <UploadIcon />
            <span>{t('cloud_docs.drop_hint', 'Drop supported Office or PDF file to upload')}</span>
          </div>
        )}

        {loading ? (
          <div class="cloud-docs-empty" data-testid="cloud-docs-loading">{t('common.loading', 'Loading...')}</div>
        ) : activeTab === 'recent' ? (
          visibleRecentItems.length === 0 ? (
            <div class="cloud-docs-empty" data-testid="cloud-docs-recent-empty">
              <div class="cloud-docs-empty-icon"><CloudDocsGlyphIcon size={36} /></div>
              <p>{t('cloud_docs.empty.recent', 'No recently viewed documents yet. Open any document in File Browser or Cloud Docs to see it here.')}</p>
            </div>
          ) : (
            <div class={listContainerClass} data-testid="cloud-docs-recent-list">
              {viewMode === 'list' && (
                <div class="cloud-docs-list-head" aria-hidden="true">
                  <span>{t('cloud_docs.columns.name', 'Name')}</span>
                  <span>{t('cloud_docs.columns.details', 'Location / Owner')}</span>
                  <span>{t('cloud_docs.columns.modified', 'Modified')}</span>
                  <span>{t('cloud_docs.columns.actions', 'Actions')}</span>
                </div>
              )}
              {visibleRecentItems.map((item) => (
                <div
                  key={item.id}
                  class={`cloud-docs-row${viewMode === 'grid' ? ' is-card' : ''}${!item.accessible ? ' is-inaccessible' : ''}`}
                  data-testid={`recent-doc-row-${item.id}`}
                  onContextMenu={(e) => openContextMenu(e as unknown as MouseEvent, { kind: 'recent-doc', item })}
                >
                  <button
                    type="button"
                    class="cloud-docs-row-main"
                    onClick={() => handleOpenRecentItem(item)}
                  >
                    <span class="cloud-docs-row-icon"><DocKindIcon name={item.title} size={viewMode === 'grid' ? 28 : 22} /></span>
                    <div class="cloud-docs-row-meta">
                      <div class="cloud-docs-row-title" title={item.title}>{item.title}</div>
                    </div>
                  </button>
                  <div class="cloud-docs-row-col is-details">
                    <span class={`cloud-docs-badge ${item.sourceKind === 'cloud_doc' ? 'is-cloud' : 'is-server'}`}>
                      {item.sourceKind === 'cloud_doc'
                        ? t('cloud_docs.source.cloud_doc', 'Cloud Doc')
                        : (item.serverName || item.serverId || t('cloud_docs.source.server_file', 'Server'))}
                    </span>
                    {item.filePath && <span class="cloud-docs-path" title={item.filePath}>{item.filePath}</span>}
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
                  </div>
                  <div class="cloud-docs-row-col is-metric">
                    <span class="cloud-docs-time">{formatTime(item.lastOpenedAt)}</span>
                  </div>
                  <div class="cloud-docs-row-actions">
                    <button
                      type="button"
                      class="cloud-docs-icon-btn"
                      data-testid={`remove-recent-${item.id}`}
                      onClick={() => void handleDeleteRecent(item.id)}
                      title={t('cloud_docs.actions.remove_recent', 'Remove')}
                      aria-label={t('cloud_docs.actions.remove_recent', 'Remove')}
                    >
                      <CloseIcon size={13} />
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
                <div class="cloud-docs-empty-icon"><FolderSvgIcon shared size={36} /></div>
                <p>{t('cloud_docs.empty.shared', 'No cloud documents or folders have been shared with you yet.')}</p>
              </div>
            ) : (
              <div class={listContainerClass} data-testid="cloud-docs-shared-list">
                {viewMode === 'list' && (
                  <div class="cloud-docs-list-head" aria-hidden="true">
                    <span>{t('cloud_docs.columns.name', 'Name')}</span>
                    <span>{t('cloud_docs.columns.details', 'Location / Owner')}</span>
                    <span>{t('cloud_docs.columns.size', 'Size')}</span>
                    <span>{t('cloud_docs.columns.actions', 'Actions')}</span>
                  </div>
                )}
                {visibleSharedFolders.map((folder) => (
                  <div
                    key={folder.id}
                    class={`cloud-docs-row${viewMode === 'grid' ? ' is-card' : ''}`}
                    data-testid={`shared-cloud-folder-row-${folder.id}`}
                    onContextMenu={(e) => openContextMenu(e as unknown as MouseEvent, { kind: 'shared-folder', folder })}
                  >
                    <button
                      type="button"
                      class="cloud-docs-row-main"
                      onClick={() => setSharedCurrentFolderId(folder.id)}
                    >
                      <span class="cloud-docs-row-icon"><FolderSvgIcon shared size={viewMode === 'grid' ? 28 : 22} /></span>
                      <div class="cloud-docs-row-meta">
                        <div class="cloud-docs-row-title" title={folder.name}>{folder.name}</div>
                      </div>
                    </button>
                    <div class="cloud-docs-row-col is-details">
                      <span class="cloud-docs-badge is-cloud">
                        {folder.role === 'editor'
                          ? t('cloud_docs.share.role_editor', 'Editor')
                          : t('cloud_docs.share.role_viewer', 'Viewer')}
                      </span>
                      <span>{folder.ownerName}</span>
                      {folder.sharedTeamName && (
                        <span class="cloud-docs-team-chip">
                          <PrincipalIcon mode="team" />
                          <span>{folder.sharedTeamName}</span>
                        </span>
                      )}
                    </div>
                    <div class="cloud-docs-row-col is-metric">
                      <span class="cloud-docs-time">{t('cloud_docs.folder_label', 'Folder')}</span>
                    </div>
                    <div class="cloud-docs-row-actions" />
                  </div>
                ))}
                {visibleSharedDocs.map((doc) => (
                  <div
                    key={doc.id}
                    class={`cloud-docs-row${viewMode === 'grid' ? ' is-card' : ''}`}
                    data-testid={`shared-cloud-doc-row-${doc.id}`}
                    onContextMenu={(e) => openContextMenu(e as unknown as MouseEvent, { kind: 'shared-doc', doc })}
                  >
                    <button
                      type="button"
                      class="cloud-docs-row-main"
                      onClick={() => handleOpenSharedCloudDoc(doc)}
                    >
                      <span class="cloud-docs-row-icon"><DocKindIcon name={doc.name} size={viewMode === 'grid' ? 28 : 22} /></span>
                      <div class="cloud-docs-row-meta">
                        <div class="cloud-docs-row-title" title={doc.name}>{doc.name}</div>
                      </div>
                    </button>
                    <div class="cloud-docs-row-col is-details">
                      <span class="cloud-docs-badge is-cloud">
                        {doc.role === 'editor'
                          ? t('cloud_docs.share.role_editor', 'Editor')
                          : t('cloud_docs.share.role_viewer', 'Viewer')}
                      </span>
                      <span>{doc.ownerName}</span>
                      {doc.sharedTeamName && (
                        <span class="cloud-docs-team-chip">
                          <PrincipalIcon mode="team" />
                          <span>{doc.sharedTeamName}</span>
                        </span>
                      )}
                    </div>
                    <div class="cloud-docs-row-col is-metric">
                      <span>{formatBytes(doc.sizeBytes)}</span>
                    </div>
                    <div class="cloud-docs-row-actions">
                      {doc.allowDownload && (
                        <button
                          type="button"
                          class="cloud-docs-icon-btn"
                          data-testid={`download-shared-doc-${doc.id}`}
                          onClick={() => void handleDownloadCloudDoc(doc.id, doc.name)}
                          title={t('cloud_docs.actions.download', 'Download')}
                          aria-label={t('cloud_docs.actions.download', 'Download')}
                        >
                          <DownloadIcon />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : visibleFolders.length === 0 && visibleDocs.length === 0 ? (
          <div class="cloud-docs-empty" data-testid="cloud-docs-my-docs-empty">
            <div class="cloud-docs-empty-icon"><CloudDocsGlyphIcon size={36} /></div>
            <p>{t('cloud_docs.empty.my_docs', 'This folder is empty. Create a blank Office document or upload one to get started.')}</p>
          </div>
        ) : (
          <div class={listContainerClass} data-testid="cloud-docs-my-docs-list">
            {viewMode === 'list' && (
              <div class="cloud-docs-list-head" aria-hidden="true">
                <span>{t('cloud_docs.columns.name', 'Name')}</span>
                <span>{t('cloud_docs.columns.modified', 'Modified')}</span>
                <span>{t('cloud_docs.columns.size', 'Size')}</span>
                <span>{t('cloud_docs.columns.actions', 'Actions')}</span>
              </div>
            )}
            {visibleFolders.map((folder) => {
              const isMenuOpen = openMenu?.kind === 'folder' && openMenu.id === folder.id;
              return (
                <div
                  key={folder.id}
                  class={`cloud-docs-row${viewMode === 'grid' ? ' is-card' : ''}`}
                  data-testid={`cloud-folder-row-${folder.id}`}
                  onContextMenu={(e) => openContextMenu(e as unknown as MouseEvent, { kind: 'folder', folder })}
                >
                  <button
                    type="button"
                    class="cloud-docs-row-main"
                    onClick={() => setCurrentFolderId(folder.id)}
                  >
                    <span class="cloud-docs-row-icon"><FolderSvgIcon size={viewMode === 'grid' ? 28 : 22} /></span>
                    <div class="cloud-docs-row-meta">
                      <div class="cloud-docs-row-title" title={folder.name}>{folder.name}</div>
                    </div>
                  </button>
                  <div class="cloud-docs-row-col is-details">
                    <span class="cloud-docs-time">{formatTime(folder.updatedAt) || t('cloud_docs.folder_label', 'Folder')}</span>
                  </div>
                  <div class="cloud-docs-row-col is-metric">
                    <span class="cloud-docs-time">{t('cloud_docs.folder_label', 'Folder')}</span>
                  </div>
                  <div class="cloud-docs-row-actions">
                    <button
                      type="button"
                      class="cloud-docs-icon-btn"
                      data-testid={`share-cloud-folder-${folder.id}`}
                      onClick={() => void openShareDialog('folder', folder.id, folder.name)}
                      title={t('cloud_docs.actions.share', 'Share')}
                      aria-label={t('cloud_docs.actions.share', 'Share')}
                    >
                      <ShareIcon />
                    </button>
                    <div class="cloud-docs-menu-wrap">
                      <button
                        type="button"
                        class="cloud-docs-icon-btn"
                        data-testid={`cloud-folder-more-${folder.id}`}
                        aria-expanded={isMenuOpen}
                        aria-label={t('cloud_docs.actions.more', 'More actions')}
                        onClick={() => {
                          setContextMenu(null);
                          setOpenMenu(isMenuOpen ? null : { kind: 'folder', id: folder.id });
                        }}
                      >
                        <MoreVertIcon />
                      </button>
                      {isMenuOpen && (
                        <div class="cloud-docs-popover-menu" data-testid="cloud-docs-row-menu" role="menu">
                          <button
                            type="button"
                            class="cloud-docs-popover-item"
                            data-testid={`rename-cloud-folder-${folder.id}`}
                            onClick={() => {
                              setOpenMenu(null);
                              setRenamingTarget({ kind: 'folder', id: folder.id, value: folder.name });
                            }}
                          >
                            {t('cloud_docs.actions.rename', 'Rename')}
                          </button>
                          <button
                            type="button"
                            class="cloud-docs-popover-item is-danger"
                            data-testid={`delete-cloud-folder-${folder.id}`}
                            onClick={() => {
                              setOpenMenu(null);
                              setConfirmDelete({ kind: 'folder', id: folder.id, name: folder.name });
                            }}
                          >
                            {t('common.delete', 'Delete')}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {visibleDocs.map((doc) => {
              const isMenuOpen = openMenu?.kind === 'doc' && openMenu.id === doc.id;
              return (
                <div
                  key={doc.id}
                  class={`cloud-docs-row${viewMode === 'grid' ? ' is-card' : ''}`}
                  data-testid={`cloud-doc-row-${doc.id}`}
                  onContextMenu={(e) => openContextMenu(e as unknown as MouseEvent, { kind: 'doc', doc })}
                >
                  <button
                    type="button"
                    class="cloud-docs-row-main"
                    onClick={() => handleOpenCloudDoc(doc)}
                  >
                    <span class="cloud-docs-row-icon"><DocKindIcon name={doc.name} size={viewMode === 'grid' ? 28 : 22} /></span>
                    <div class="cloud-docs-row-meta">
                      <div class="cloud-docs-row-title" title={doc.name}>{doc.name}</div>
                    </div>
                  </button>
                  <div class="cloud-docs-row-col is-details">
                    <span class="cloud-docs-time">{formatTime(doc.updatedAt)}</span>
                  </div>
                  <div class="cloud-docs-row-col is-metric">
                    <span>{formatBytes(doc.sizeBytes)}</span>
                  </div>
                  <div class="cloud-docs-row-actions">
                    <button
                      type="button"
                      class="cloud-docs-icon-btn"
                      data-testid={`download-cloud-doc-${doc.id}`}
                      onClick={() => void handleDownloadCloudDoc(doc.id, doc.name)}
                      title={t('cloud_docs.actions.download', 'Download')}
                      aria-label={t('cloud_docs.actions.download', 'Download')}
                    >
                      <DownloadIcon />
                    </button>
                    <button
                      type="button"
                      class="cloud-docs-icon-btn"
                      data-testid={`share-cloud-doc-${doc.id}`}
                      onClick={() => void openShareDialog('doc', doc.id, doc.name)}
                      title={t('cloud_docs.actions.share', 'Share')}
                      aria-label={t('cloud_docs.actions.share', 'Share')}
                    >
                      <ShareIcon />
                    </button>
                    <div class="cloud-docs-menu-wrap">
                      <button
                        type="button"
                        class="cloud-docs-icon-btn"
                        data-testid={`cloud-doc-more-${doc.id}`}
                        aria-expanded={isMenuOpen}
                        aria-label={t('cloud_docs.actions.more', 'More actions')}
                        onClick={() => {
                          setContextMenu(null);
                          setOpenMenu(isMenuOpen ? null : { kind: 'doc', id: doc.id });
                        }}
                      >
                        <MoreVertIcon />
                      </button>
                      {isMenuOpen && (
                        <div class="cloud-docs-popover-menu" data-testid="cloud-docs-row-menu" role="menu">
                          <button
                            type="button"
                            class="cloud-docs-popover-item"
                            data-testid={`rename-cloud-doc-${doc.id}`}
                            onClick={() => {
                              setOpenMenu(null);
                              setRenamingTarget({ kind: 'doc', id: doc.id, value: doc.name });
                            }}
                          >
                            {t('cloud_docs.actions.rename', 'Rename')}
                          </button>
                          <button
                            type="button"
                            class="cloud-docs-popover-item"
                            data-testid={`move-cloud-doc-${doc.id}`}
                            onClick={() => {
                              setOpenMenu(null);
                              setMovingDocId(doc.id);
                              setMovingFolderTargetId(doc.folderId ?? '');
                            }}
                          >
                            {t('cloud_docs.actions.move', 'Move')}
                          </button>
                          <button
                            type="button"
                            class="cloud-docs-popover-item is-danger"
                            data-testid={`delete-cloud-doc-${doc.id}`}
                            onClick={() => {
                              setOpenMenu(null);
                              setConfirmDelete({ kind: 'doc', id: doc.id, name: doc.name });
                            }}
                          >
                            {t('common.delete', 'Delete')}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {renderContextMenu()}
      {renderShareModal()}
    </div>
  );
}
