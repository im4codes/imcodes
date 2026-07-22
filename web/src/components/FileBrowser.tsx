import { DAEMON_MSG } from '@shared/daemon-events.js';
import { FS_TRANSPORT_MSG } from '@shared/fs-transport-messages.js';
/**
 * FileBrowser — universal reusable file/directory browser.
 *
 * Modes:
 *   'dir-only'    — only directories shown, single select (for cwd pickers)
 *   'file-multi'  — files + dirs, multi-select with checkboxes (for chat insert)
 *   'file-single' — files + dirs, single select (for chat path-click)
 *
 * Layouts:
 *   'modal' — rendered as a full-screen overlay dialog
 *   'panel' — rendered inline (no overlay), fits inside a parent container
 */
import { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { WsClient, ServerMessage } from '../ws-client.js';
import { lazy, Suspense } from 'preact/compat';
import { parseUnifiedDiff } from '@shared/unified-diff.js';
import { isHtmlPreviewPath, type HtmlPreviewViewMode } from '@shared/html-preview.js';
import { FS_WRITE_ERROR } from '../../../src/shared/transport/fs.js';
import { FS_READ_ERROR_CODES } from '../../../shared/fs-read-error-codes.js';
import { FileEditor, FileEditorContent } from './file-editor-lazy.js';
const FilePreviewPane = lazy(() => import('./FilePreviewPane.js'));
const OfficePreview = lazy(() => import('./OfficePreview.js'));
import { HtmlFullscreenPreview, openHtmlPreviewInNewWindow, type HtmlFullscreenPreviewState } from './HtmlFullscreenPreview.js';
import { ImageLightbox } from './ImageLightbox.js';
import { buildAttachmentDownloadUrl, downloadAttachment } from '../api.js';
import {
  getSharedChangesKey,
  subscribeSharedChanges,
  subscribeSharedChangesStatus,
  requestSharedChanges,
  __resetSharedChangesForTests,
  type ChangeFile,
  type SharedChangesRequestStatus,
} from '../git-status-store.js';
import { filePreviewStatesEqual } from '../file-preview-state.js';
import { FILE_BROWSER_SNAPSHOT_KEY_PREFIX } from '../local-storage-quota.js';

const PREF_KEY = 'fb_prefer_editor';
const WINDOWS_DRIVES_ROOT = '__imcodes_windows_drives__';
/** Sentinel path that asks the daemon to list Windows drive roots. */
const WINDOWS_DRIVES_PATH = ':drives:';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render a unified diff as a split (side-by-side) HTML table, GitHub-style */
function renderDiff(diff: string): string {
  const parsed = parseUnifiedDiff(diff);

  // Build split rows: pair del+add lines from same hunk for side-by-side
  const rows: string[] = [];
  let i = 0;
  while (i < parsed.length) {
    const p = parsed[i];
    if (p.kind === 'file') {
      rows.push(`<tr class="diff-row-file"><td colspan="4" class="diff-file-header">${escapeHtml(p.text)}</td></tr>`);
      i++;
    } else if (p.kind === 'hunk') {
      rows.push(`<tr class="diff-row-hunk"><td colspan="4" class="diff-hunk-header">${escapeHtml(p.text)}</td></tr>`);
      i++;
    } else if (p.kind === 'ctx') {
      const ln = p.oldLineNumber ?? '';
      rows.push(`<tr class="diff-row-ctx"><td class="diff-ln">${ln}</td><td class="diff-cell diff-ctx">${escapeHtml(p.text)}</td><td class="diff-ln">${p.newLineNumber ?? ''}</td><td class="diff-cell diff-ctx">${escapeHtml(p.text)}</td></tr>`);
      i++;
    } else if (p.kind === 'del') {
      // Collect consecutive del/add pairs
      const dels = [];
      const adds = [];
      while (i < parsed.length && parsed[i].kind === 'del') { dels.push(parsed[i]); i++; }
      while (i < parsed.length && parsed[i].kind === 'add') { adds.push(parsed[i]); i++; }
      const maxLen = Math.max(dels.length, adds.length);
      for (let j = 0; j < maxLen; j++) {
        const d = dels[j];
        const a = adds[j];
        const oldLn = d ? String(d.oldLineNumber ?? '') : '';
        const newLn = a ? String(a.newLineNumber ?? '') : '';
        const oldCode = d ? escapeHtml(d.text) : '';
        const newCode = a ? escapeHtml(a.text) : '';
        const leftCls = d ? 'diff-cell diff-del' : 'diff-cell diff-empty';
        const rightCls = a ? 'diff-cell diff-add' : 'diff-cell diff-empty';
        rows.push(`<tr class="diff-row-change"><td class="diff-ln diff-ln-del">${oldLn}</td><td class="${leftCls}">${oldCode}</td><td class="diff-ln diff-ln-add">${newLn}</td><td class="${rightCls}">${newCode}</td></tr>`);
      }
    } else if (p.kind === 'add') {
      rows.push(`<tr class="diff-row-change"><td class="diff-ln"></td><td class="diff-cell diff-empty"></td><td class="diff-ln diff-ln-add">${p.newLineNumber ?? ''}</td><td class="diff-cell diff-add">${escapeHtml(p.text)}</td></tr>`);
      i++;
    } else {
      i++;
    }
  }

  return `<table class="diff-table"><colgroup><col style="width:36px"><col style="width:calc(50% - 36px)"><col style="width:36px"><col style="width:calc(50% - 36px)"></colgroup><tbody>${rows.join('')}</tbody></table>`;
}

function isBinaryContent(content: string): boolean {
  // Check first 8KB for null bytes (binary indicator)
  const sample = content.slice(0, 8192);
  return sample.includes('\0');
}

export type FileBrowserMode = 'dir-only' | 'file-multi' | 'file-single';

export interface FileBrowserProps {
  ws: WsClient;
  mode: FileBrowserMode;
  layout: 'modal' | 'panel';
  initialPath?: string;
  /** When set, pre-select this path on open (file-single / dir-only) */
  highlightPath?: string;
  /** When set, automatically open the file preview on mount (skips manual click) */
  autoPreviewPath?: string;
  /** When autoPreviewPath is set, start in diff mode instead of source mode. */
  autoPreviewPreferDiff?: boolean;
  /** When autoPreviewPath is set, start in source/diff/rendered HTML mode. */
  initialPreviewViewMode?: HtmlPreviewViewMode;
  /** Paths already inserted — shown with a badge to avoid duplicates */
  alreadyInserted?: string[];
  /** Hide the footer (select/confirm buttons) — for embedded panel views */
  hideFooter?: boolean;
  /** When set, show a git-changes section at bottom of Files view and a Changes tab */
  changesRootPath?: string;
  /** Increment to trigger a rate-limited git-changes refresh (min 5s between refreshes) */
  refreshTrigger?: number;
  /** Server ID for file transfer download API. If provided, enables download buttons. */
  serverId?: string;
  /** Session whose project directory scopes rename/delete requests. */
  sessionName?: string;
  onConfirm: (paths: string[]) => void;
  onClose?: () => void;
  /** Called after a new directory is successfully created. */
  onDirectoryCreated?: (path: string) => void;
  /** Seed external preview state so a new host can reuse an existing load. */
  initialPreview?: FileBrowserPreviewState;
  /** Keep an external preview host in sync with this FileBrowser's preview state. */
  onPreviewStateChange?: (update: FileBrowserPreviewUpdate) => void;
  /** Trust a hydrated loading preview instead of starting a second read immediately. */
  skipAutoPreviewIfLoading?: boolean;
  /** When set, file clicks open an external preview (e.g. floating window) instead of inline split */
  onPreviewFile?: (request: FileBrowserPreviewRequest) => void;
  /** Default panel tab — 'files' or 'changes'. Default: 'files' */
  defaultTab?: 'files' | 'changes';
  /**
   * Called when the user explicitly chooses to insert the previewed file's
   * path into the host (usually the chat composer). If provided, the preview
   * header shows an "Insert path" button alongside Edit/Download/Copy-path.
   * Separated from `onConfirm` because `onConfirm` is tied to the file-picker
   * flow; inserting from an already-open preview is a different user intent.
   */
  onInsertPath?: (path: string) => void;
}

type FsNode = {
  id: string;        // absolute resolved path
  name: string;
  isDir: boolean;
  hidden?: boolean;
  children?: FsNode[];  // undefined = leaf/file; [] = unloaded dir; [...] = loaded
  isLoading?: boolean;
};

interface FileBrowserSnapshot {
  savedAt: number;
  currentLabel: string;
  rootChildren: FsNode[];
}

const FILE_BROWSER_SNAPSHOT_TTL_MS = 5 * 60_000;
const FILE_BROWSER_SNAPSHOT_MAX_NODES = 400;

function buildFileBrowserSnapshotKey(
  startPath: string,
  includeFiles: boolean,
  showHidden: boolean,
  serverId?: string,
): string {
  return [
    FILE_BROWSER_SNAPSHOT_KEY_PREFIX,
    serverId || 'local',
    includeFiles ? 'files' : 'dirs',
    showHidden ? 'hidden' : 'visible',
    startPath,
  ].join(':');
}

function countFsNodes(nodes: readonly FsNode[]): number {
  let count = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    count += 1;
    if (node.children && node.children.length > 0) stack.push(...node.children);
  }
  return count;
}

function loadFileBrowserSnapshot(
  startPath: string,
  includeFiles: boolean,
  showHidden: boolean,
  serverId?: string,
): FileBrowserSnapshot | null {
  try {
    const raw = localStorage.getItem(buildFileBrowserSnapshotKey(startPath, includeFiles, showHidden, serverId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FileBrowserSnapshot>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > FILE_BROWSER_SNAPSHOT_TTL_MS) return null;
    if (typeof parsed.currentLabel !== 'string' || !Array.isArray(parsed.rootChildren)) return null;
    return {
      savedAt: parsed.savedAt,
      currentLabel: parsed.currentLabel,
      rootChildren: parsed.rootChildren as FsNode[],
    };
  } catch {
    return null;
  }
}

function saveFileBrowserSnapshot(
  startPath: string,
  includeFiles: boolean,
  showHidden: boolean,
  currentLabel: string,
  rootChildren: FsNode[],
  serverId?: string,
): void {
  try {
    if (countFsNodes(rootChildren) > FILE_BROWSER_SNAPSHOT_MAX_NODES) return;
    const snapshot: FileBrowserSnapshot = {
      savedAt: Date.now(),
      currentLabel,
      rootChildren,
    };
    localStorage.setItem(
      buildFileBrowserSnapshotKey(startPath, includeFiles, showHidden, serverId),
      JSON.stringify(snapshot),
    );
  } catch {
    /* ignore */
  }
}

export type FileBrowserPreviewState =
  | { status: 'idle' }
  | { status: 'loading'; path: string }
  | { status: 'ok'; path: string; content: string; diff?: string; diffHtml?: string; downloadId?: string }
  | { status: 'image'; path: string; dataUrl: string; downloadId?: string }
  | { status: 'office'; path: string; data: string; mimeType: string; downloadId?: string }
  | { status: 'video'; path: string; streamUrl: string; mimeType: string; downloadId?: string }
  | { status: 'audio'; path: string; streamUrl: string; mimeType: string; downloadId?: string }
  | { status: 'error'; path: string; error: string; downloadId?: string };

export interface FileBrowserPreviewRequest {
  path: string;
  /** Session whose project directory should scope writes from the preview host. */
  sessionName?: string;
  preferDiff?: boolean;
  previewViewMode?: HtmlPreviewViewMode;
  preview?: FileBrowserPreviewState;
  sourcePreviewLive?: boolean;
  /** Project/root directory used to keep the floating preview's Changes tab available. */
  rootPath?: string;
}

export interface FileBrowserPreviewUpdate {
  path: string;
  preferDiff?: boolean;
  previewViewMode?: HtmlPreviewViewMode;
  preview: FileBrowserPreviewState;
}

/**
 * Parent directory of a path, handling both Unix (/) and Windows (\) separators
 * and the Windows drive-root case (C: → C:\). Returns null when there is no
 * parent (already at a root). Mirrors the logic in `goUp`.
 */
export function getParentDir(p: string): string | null {
  const normalized = p.replace(/[/\\]+$/, '');
  const sep = normalized.includes('\\') ? '\\' : '/';
  const idx = normalized.lastIndexOf(sep);
  if (idx < 0) return null;
  if (idx === 0) return sep; // direct child of the unix root → '/'
  let parent = normalized.slice(0, idx);
  if (/^[A-Za-z]:$/.test(parent)) parent += '\\'; // Windows drive root: C: → C:\
  return parent;
}

export function mergePreviewState(
  current: FileBrowserPreviewState,
  incoming: FileBrowserPreviewState,
): FileBrowserPreviewState {
  if (current.status === 'idle') return incoming;
  const currentPath = 'path' in current ? current.path : null;
  const incomingPath = 'path' in incoming ? incoming.path : null;
  if (!currentPath || !incomingPath || currentPath !== incomingPath) return incoming;
  if (incoming.status === 'loading') return current;
  if (current.status === 'ok' && incoming.status === 'ok') {
    const merged: FileBrowserPreviewState = {
      ...current,
      ...incoming,
      diff: incoming.diff ?? current.diff,
      diffHtml: incoming.diffHtml ?? current.diffHtml,
      downloadId: incoming.downloadId ?? current.downloadId,
    };
    return filePreviewStatesEqual(current, merged) ? current : merged;
  }
  return filePreviewStatesEqual(current, incoming) ? current : incoming;
}

/** File extensions that can be previewed with office document libraries. */
const OFFICE_EXTENSIONS: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function getOfficeType(path: string): string | null {
  const ext = path.match(/\.[a-zA-Z0-9]+$/i)?.[0]?.toLowerCase();
  return ext ? (OFFICE_EXTENSIONS[ext] ?? null) : null;
}

/** File extensions playable in the browser <video> element. Mirrored from
 *  VIDEO_MIME in src/daemon/command-handler.ts — keep these in sync. */
const VIDEO_EXTENSIONS: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
};

function getVideoType(path: string): string | null {
  const ext = path.match(/\.[a-zA-Z0-9]+$/i)?.[0]?.toLowerCase();
  return ext ? (VIDEO_EXTENSIONS[ext] ?? null) : null;
}

/** File extensions playable in the browser <audio> element. Mirrored from
 *  AUDIO_MIME_BY_EXTENSION in src/daemon/file-preview-classifier.ts — keep these in sync. */
const AUDIO_EXTENSIONS: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.weba': 'audio/webm',
};

function getAudioType(path: string): string | null {
  const ext = path.match(/\.[a-zA-Z0-9]+$/i)?.[0]?.toLowerCase();
  return ext ? (AUDIO_EXTENSIONS[ext] ?? null) : null;
}

const REQUEST_TIMEOUT_MS = 15_000;
const PREVIEW_REQUEST_TIMEOUT_MS = 22_000;
const PREVIEW_REFRESH_INTERVAL_MS = 8_000;
const PREVIEW_REFRESH_FAILURE_BACKOFF_MS = 30_000;

function updateNode(nodes: FsNode[], targetId: string, patch: Partial<FsNode>): FsNode[] {
  return nodes.map((n) => {
    if (n.id === targetId) return { ...n, ...patch };
    if (n.children?.length) return { ...n, children: updateNode(n.children, targetId, patch) };
    return n;
  });
}

function findNodePath(nodes: FsNode[], targetId: string): string[] | null {
  for (const node of nodes) {
    if (node.id === targetId) return [node.id];
    if (node.children?.length) {
      const childPath = findNodePath(node.children, targetId);
      if (childPath) return [node.id, ...childPath];
    }
  }
  return null;
}

type PendingPreviewReason = 'interactive' | 'refresh';
type PendingPreviewRequest = { path: string; cycleId: number; reason?: PendingPreviewReason; startedAt?: number };
type PendingPreviewDiff = PendingPreviewRequest & { diff: string; diffHtml: string };
type PreviewScrollMode = Exclude<FileBrowserPreviewState['status'], 'idle' | 'ok'> | HtmlPreviewViewMode | 'edit';
type PreviewScrollSnapshot = { key: string; scrollTop: number; scrollLeft: number };

function previewCycleKey(path: string, cycleId: number): string {
  return `${cycleId}\0${path}`;
}

function getPreviewScrollMode(
  preview: FileBrowserPreviewState,
  isEditing: boolean,
  previewViewMode: HtmlPreviewViewMode,
  canRenderDiff: boolean,
): PreviewScrollMode | null {
  if (preview.status === 'idle') return null;
  if (preview.status === 'ok') {
    if (isEditing) return 'edit';
    if (previewViewMode === 'html-render') return 'html-render';
    return previewViewMode === 'diff' && canRenderDiff ? 'diff' : 'source';
  }
  return preview.status;
}

function previewScrollKey(path: string, mode: PreviewScrollMode): string {
  return `${mode}\0${path}`;
}

/** Backward-compat re-export so the existing FileBrowser test suite keeps
 *  working after the shared-changes cache moved to `git-status-store.ts`. */
export const __resetFileBrowserSharedChangesForTests = __resetSharedChangesForTests;

const DEFAULT_SHOW_HIDDEN_FILES = true;

type NewEntryKind = 'file' | 'folder';
type FileContextMenuState = { node: FsNode; x: number; y: number };

function shortenPathSegment(segment: string, maxLength: number): string {
  if (segment.length <= maxLength) return segment;
  const head = Math.max(6, Math.floor((maxLength - 1) * 0.55));
  const tail = Math.max(4, maxLength - 1 - head);
  return `${segment.slice(0, head)}…${segment.slice(-tail)}`;
}

function gitStatusClass(code: string): 'ignored' | 'untracked' | 'deleted' | 'added' | 'modified' {
  if (code === '!!') return 'ignored';
  if (code === '??') return 'untracked';
  if (code === 'D') return 'deleted';
  if (code === 'A') return 'added';
  return 'modified';
}

function gitStatusBadge(code: string): string {
  if (code === '!!') return 'I';
  if (code === '??') return 'U';
  return code;
}

export function FileBrowser({
  ws,
  mode,
  layout,
  initialPath,
  highlightPath,
  autoPreviewPath,
  autoPreviewPreferDiff = false,
  initialPreviewViewMode,
  alreadyInserted = [],
  hideFooter = false,
  changesRootPath,
  refreshTrigger,
  serverId,
  onConfirm,
  onClose,
  onDirectoryCreated,
  initialPreview,
  onPreviewStateChange,
  skipAutoPreviewIfLoading = false,
  onPreviewFile,
  defaultTab = 'files',
  onInsertPath,
  sessionName,
}: FileBrowserProps) {
  const { t } = useTranslation();
  const includeFiles = mode !== 'dir-only';
  const isMulti = mode === 'file-multi';

  const startPath = initialPath || '~';
  const initialTreeSnapshot = loadFileBrowserSnapshot(startPath, includeFiles, DEFAULT_SHOW_HIDDEN_FILES, serverId);
  const [data, setData] = useState<FsNode[]>([
    {
      id: startPath,
      name: startPath,
      isDir: true,
      children: initialTreeSnapshot?.rootChildren ?? [],
    },
  ]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(
    () => new Set(highlightPath ? [highlightPath] : []),
  );
  const [currentLabel, setCurrentLabel] = useState(initialTreeSnapshot?.currentLabel ?? startPath);
  // Refs so callbacks/handlers that are defined BEFORE `navigateTo` / read
  // `currentLabel` (fetchPreview, the WS message handler) can use the latest
  // value without a declaration-order or stale-closure problem.
  const navigateToRef = useRef<(path: string) => void>(() => {});
  const currentLabelRef = useRef(currentLabel);
  useEffect(() => { currentLabelRef.current = currentLabel; }, [currentLabel]);
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(DEFAULT_SHOW_HIDDEN_FILES);
  const [preview, setPreview] = useState<FileBrowserPreviewState>(() => initialPreview ?? { status: 'idle' });
  const previewRef = useRef<FileBrowserPreviewState>(preview);
  useEffect(() => { previewRef.current = preview; }, [preview]);
  const [showDiff, setShowDiff] = useState(() => {
    if (initialPreview?.status === 'ok' && initialPreview.diffHtml && autoPreviewPreferDiff) return true;
    return false;
  });
  const [previewViewMode, setPreviewViewMode] = useState<HtmlPreviewViewMode>(() => (
    initialPreviewViewMode ?? (autoPreviewPreferDiff ? 'diff' : 'source')
  ));
  const [lightbox, setLightbox] = useState<{ src: string; fileName?: string; onDownload?: () => void | Promise<void> } | null>(null);
  const [htmlFullscreenPreview, setHtmlFullscreenPreview] = useState<HtmlFullscreenPreviewState | null>(null);
  const closeHtmlFullscreenPreview = useCallback(() => {
    setHtmlFullscreenPreview(null);
  }, []);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // Transient "Copied!" label flips back to the default after 1.5s. Keyed by
  // path so rapidly switching between previews never shows a stale "Copied!"
  // badge on a file that wasn't the one the user copied.
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  // Editor state (logic lives in FileEditor component)
  const [isEditing, setIsEditing] = useState(() => {
    try { return localStorage.getItem(PREF_KEY) === '1'; } catch { return false; }
  });
  const [editDirty, setEditDirty] = useState(false);
  const [editContent, setEditContent] = useState('');
  const editDirtyRef = useRef(false);
  // Keep ref in sync with state
  useEffect(() => { editDirtyRef.current = editDirty; }, [editDirty]);
  const [originalMtime, setOriginalMtime] = useState<number | undefined>(undefined);
  // Message handlers registered by FileEditor
  const editorMsgHandlers = useRef(new Set<(msg: ServerMessage) => void>());
  const onEditorMessage = useCallback((handler: (msg: ServerMessage) => void) => {
    editorMsgHandlers.current.add(handler);
    return () => { editorMsgHandlers.current.delete(handler); };
  }, []);

  const [newEntry, setNewEntry] = useState<{ kind: NewEntryKind; parentPath: string } | null>(null);
  const [newEntryName, setNewEntryName] = useState('');
  const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null);
  const [modifiedFiles, setModifiedFiles] = useState<Map<string, string>>(new Map()); // path → git code
  // Panel view: 'files' shows tree + changes section; 'changes' shows only changed files
  // Restore last active tab from localStorage
  const [treeWidth, setTreeWidth] = useState<number>(() => {
    try { const v = localStorage.getItem('rcc_fb_tree_width'); return v ? parseInt(v, 10) : 240; } catch { return 240; }
  });
  useEffect(() => { try { localStorage.setItem('rcc_fb_tree_width', String(treeWidth)); } catch {} }, [treeWidth]);

  const [panelView, setPanelViewRaw] = useState<'files' | 'changes'>(() => {
    // A from-chat file preview (autoPreviewPath set) must open on the Files tab
    // so the left directory listing of the file's folder shows immediately —
    // ignore the shared `rcc_fb_tab` browse preference, which belongs to the
    // sidebar file manager and would otherwise drop us on the Changes tab.
    if (autoPreviewPath) return 'files';
    try {
      const saved = localStorage.getItem('rcc_fb_tab');
      if (saved === 'files' || saved === 'changes') return saved;
    } catch { /* ignore */ }
    return defaultTab;
  });
  const setPanelView = (v: 'files' | 'changes') => {
    setPanelViewRaw(v);
    try { localStorage.setItem('rcc_fb_tab', v); } catch { /* ignore */ }
  };
  const [changesFiles, setChangesFiles] = useState<ChangeFile[]>([]);
  const [changesRefreshStatus, setChangesRefreshStatus] = useState<SharedChangesRequestStatus>('idle');
  const changesRefreshFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadedRef = useRef(new Set<string>());
  const pendingRef = useRef(new Map<string, string>()); // requestId → nodeId
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingReadRef = useRef(new Map<string, PendingPreviewRequest>());
  const pendingGitStatusRef = useRef(new Map<string, string>()); // requestId → dirPath
  const pendingGitDiffRef = useRef(new Map<string, PendingPreviewRequest>());
  const pendingPreviewTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const previewRefreshBackoffUntilRef = useRef(0);
  const pendingPreviewDiffRef = useRef(new Map<string, PendingPreviewDiff>());
  const pendingMkdirRef = useRef(new Map<string, { parentPath: string; targetPath: string }>());
  const pendingCreateFileRef = useRef(new Map<string, { parentPath: string; targetPath: string }>());
  const pendingRenameRef = useRef(new Map<string, { parentPath: string; sourcePath: string; targetPath: string }>());
  const pendingDeleteRef = useRef(new Map<string, { parentPath: string | null; targetPath: string }>());
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const previewContentRef = useRef<HTMLDivElement | null>(null);
  const previewScrollSnapshotRef = useRef<PreviewScrollSnapshot | null>(null);
  const mountedRef = useRef(true);
  const dismissedAutoPreviewPathRef = useRef<string | null>(null);
  const autoPreviewPathRef = useRef(autoPreviewPath);
  useEffect(() => { autoPreviewPathRef.current = autoPreviewPath; }, [autoPreviewPath]);
  const previewTabOverridePathRef = useRef<string | null>(null);
  const nextPreviewCycleIdRef = useRef(1);
  const activePreviewCycleRef = useRef<PendingPreviewRequest | null>(null);

  // History navigation
  const historyRef = useRef<string[]>([startPath]);
  const historyIdxRef = useRef(0);
  const [canGoBack, setCanGoBack] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingRef.current.clear();
      pendingReadRef.current.clear();
      pendingGitStatusRef.current.clear();
      pendingGitDiffRef.current.clear();
      for (const timer of pendingPreviewTimersRef.current.values()) clearTimeout(timer);
      pendingPreviewTimersRef.current.clear();
      pendingPreviewDiffRef.current.clear();
      pendingMkdirRef.current.clear();
      pendingCreateFileRef.current.clear();
      pendingRenameRef.current.clear();
      pendingDeleteRef.current.clear();
      editorMsgHandlers.current.clear();
      if (pendingChangesTimerRef.current) clearTimeout(pendingChangesTimerRef.current);
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeWhenOutsideMenu = (event: Event) => {
      const menu = contextMenuRef.current;
      const target = event.target instanceof Node ? event.target : null;
      if (menu && target && menu.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', closeWhenOutsideMenu, true);
    document.addEventListener('mousedown', closeWhenOutsideMenu, true);
    document.addEventListener('contextmenu', closeWhenOutsideMenu, true);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', closeWhenOutsideMenu, true);
      document.removeEventListener('mousedown', closeWhenOutsideMenu, true);
      document.removeEventListener('contextmenu', closeWhenOutsideMenu, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    const root = data[0];
    if (!root || root.isLoading || !root.children) return;
    saveFileBrowserSnapshot(startPath, includeFiles, showHidden, currentLabel, root.children, serverId);
  }, [currentLabel, data, includeFiles, serverId, showHidden, startPath]);

  const getActivePreviewCycle = useCallback((path?: string): PendingPreviewRequest | null => {
    const active = activePreviewCycleRef.current;
    if (!active) return null;
    if (path && active.path !== path) return null;
    return active;
  }, []);

  const hasPendingPreviewWork = useCallback((kind: 'read' | 'diff', path: string, cycleId?: number): boolean => {
    const active = cycleId !== undefined ? { path, cycleId } : getActivePreviewCycle(path);
    if (!active) return false;
    const pending = kind === 'read' ? pendingReadRef.current : pendingGitDiffRef.current;
    for (const request of pending.values()) {
      if (request.path === active.path && request.cycleId === active.cycleId) return true;
    }
    return false;
  }, [getActivePreviewCycle]);

  const clearPendingPreviewRequest = useCallback((kind: 'read' | 'diff', requestId: string): PendingPreviewRequest | null => {
    const pending = kind === 'read' ? pendingReadRef.current : pendingGitDiffRef.current;
    const request = pending.get(requestId) ?? null;
    pending.delete(requestId);
    const timer = pendingPreviewTimersRef.current.get(requestId);
    if (timer) clearTimeout(timer);
    pendingPreviewTimersRef.current.delete(requestId);
    return request;
  }, []);

  const clearAllPendingPreviewRequests = useCallback(() => {
    pendingReadRef.current.clear();
    pendingGitDiffRef.current.clear();
    for (const timer of pendingPreviewTimersRef.current.values()) clearTimeout(timer);
    pendingPreviewTimersRef.current.clear();
  }, []);

  const handlePreviewRequestTimeout = useCallback((kind: 'read' | 'diff', requestId: string) => {
    const request = clearPendingPreviewRequest(kind, requestId);
    if (!request || !mountedRef.current) return;
    if (request.reason === 'refresh') {
      previewRefreshBackoffUntilRef.current = Date.now() + PREVIEW_REFRESH_FAILURE_BACKOFF_MS;
      return;
    }
    if (kind === 'diff') return;
    const active = getActivePreviewCycle();
    if (!active || active.path !== request.path || active.cycleId !== request.cycleId) return;
    activePreviewCycleRef.current = null;
    setPreview({ status: 'error', path: request.path, error: t('file_browser.preview_error') });
  }, [clearPendingPreviewRequest, getActivePreviewCycle, t]);

  const trackPendingPreviewRequest = useCallback((
    kind: 'read' | 'diff',
    requestId: string,
    request: PendingPreviewRequest,
  ) => {
    clearPendingPreviewRequest(kind, requestId);
    const pending = kind === 'read' ? pendingReadRef.current : pendingGitDiffRef.current;
    pending.set(requestId, { ...request, startedAt: Date.now() });
    const timer = setTimeout(() => handlePreviewRequestTimeout(kind, requestId), PREVIEW_REQUEST_TIMEOUT_MS);
    pendingPreviewTimersRef.current.set(requestId, timer);
  }, [clearPendingPreviewRequest, handlePreviewRequestTimeout]);

  const fetchDir = useCallback((nodePath: string) => {
    if (loadedRef.current.has(nodePath)) return;
    const inFlight = [...pendingRef.current.values()].includes(nodePath);
    if (inFlight) return;

    setData((prev) => updateNode(prev, nodePath, { isLoading: true }));
    let requestId: string;
    try {
      // Keep the initial directory list lightweight. The tree currently only
      // renders names/dir flags, so per-file metadata (size/mime/downloadId)
      // just adds avoidable stat work on first open, especially on mobile.
      requestId = ws.fsListDir(nodePath, includeFiles, false);
    } catch {
      setData((prev) => updateNode(prev, nodePath, { isLoading: false }));
      return;
    }
    pendingRef.current.set(requestId, nodePath);
    // Tree/subtree refreshes only need lightweight status without includeStats.
    try {
      const gitId = ws.fsGitStatus(nodePath);
      pendingGitStatusRef.current.set(gitId, nodePath);
    } catch { /* ws disconnected — skip git status */ }

    const timer = setTimeout(() => {
      if (!mountedRef.current) return;
      if (pendingRef.current.has(requestId)) {
        pendingRef.current.delete(requestId);
        timersRef.current.delete(requestId);
        setData((prev) => updateNode(prev, nodePath, { isLoading: false }));
        setError(t('file_browser.timeout_detail', { defaultValue: t('file_browser.timeout') }));
      }
    }, REQUEST_TIMEOUT_MS);
    timersRef.current.set(requestId, timer);
  }, [includeFiles, showHidden, t, ws]);

  // Listen for fs.ls_response and fs.read_response
  // IMPORTANT: Every setState call is guarded by mountedRef to prevent crashes
  // when responses arrive after component unmount (race condition with FloatingPanel close).
  useEffect(() => {
    return ws.onMessage((msg: ServerMessage) => {
      if (!mountedRef.current) return;

      // WS reconnected — clear loaded cache so directories re-fetch on next expand/navigate
      if (msg.type === DAEMON_MSG.RECONNECTED || (msg.type === 'session.event' && (msg as any).event === 'connected')) {
        loadedRef.current.clear();
        pendingRef.current.clear();
        clearAllPendingPreviewRequests();
        pendingCreateFileRef.current.clear();
        pendingRenameRef.current.clear();
        pendingDeleteRef.current.clear();
        const loadingPath = previewRef.current.status === 'loading' ? previewRef.current.path : null;
        activePreviewCycleRef.current = null;
        if (loadingPath) {
          setPreview({ status: 'error', path: loadingPath, error: t('file_browser.preview_error') });
        }
        // Re-fetch root and changes
        if (mountedRef.current) fetchDir(startPath);
        return;
      }

      if (msg.type === 'fs.ls_response') {
        const nodeId = pendingRef.current.get(msg.requestId);
        if (!nodeId) return;
        pendingRef.current.delete(msg.requestId);

        const timer = timersRef.current.get(msg.requestId);
        if (timer) { clearTimeout(timer); timersRef.current.delete(msg.requestId); }

        if (!mountedRef.current) return;

        if (msg.status === 'error') {
          setError(msg.error ?? 'Unknown error');
          setData((prev) => updateNode(prev, nodeId, { isLoading: false }));
          return;
        }

        const resolvedParent = msg.resolvedPath ?? nodeId;
        const entries = msg.entries ?? [];
        // Use the same path separator as the resolved parent (Windows \ vs Unix /)
        const pathSep = resolvedParent.includes('\\') ? '\\' : '/';
        const children: FsNode[] = entries
          .filter((e) => showHidden || !e.hidden)
          .map((e) => ({
            id: e.path ?? `${resolvedParent}${pathSep}${e.name}`,
            name: e.name,
            isDir: e.isDir,
            hidden: e.hidden,
            children: e.isDir ? [] : undefined,
          }));

        loadedRef.current.add(nodeId);
        if (resolvedParent !== nodeId) loadedRef.current.add(resolvedParent);

        setData((prev) => updateNode(prev, nodeId, {
          id: resolvedParent,
          name: resolvedParent === WINDOWS_DRIVES_ROOT ? t('file_browser.this_pc') : resolvedParent.split(/[/\\]/).pop() || resolvedParent,
          children,
          isLoading: false,
        }));
        // Keep the node expanded after its ID changes from alias (e.g. '~') to resolved path
        if (resolvedParent !== nodeId) {
          setExpandedPaths((prev) => {
            if (!prev.has(nodeId)) return prev;
            const next = new Set(prev);
            next.delete(nodeId);
            next.add(resolvedParent);
            return next;
          });
        }
        setCurrentLabel(resolvedParent === WINDOWS_DRIVES_ROOT ? t('file_browser.this_pc') : resolvedParent);
        setError(null);

        // If highlightPath is under this dir, auto-expand
        if (highlightPath && (highlightPath.startsWith(resolvedParent + '/') || highlightPath.startsWith(resolvedParent + '\\'))) {
          const nextSegment = highlightPath.slice(resolvedParent.length + 1).split(/[/\\]/)[0];
          const child = children.find((c) => c.name === nextSegment && c.isDir);
          if (child) setTimeout(() => { if (mountedRef.current) fetchDir(child.id); }, 0);
        }
        return;
      }

      if (msg.type === 'fs.read_response') {
        const pending = pendingReadRef.current.get(msg.requestId);
        if (!pending) return;
        clearPendingPreviewRequest('read', msg.requestId);
        const active = getActivePreviewCycle();
        if (!active || active.path !== pending.path || active.cycleId !== pending.cycleId) return;
        const filePath = pending.path;

        if (!mountedRef.current) return;

        const dlId = msg.downloadId;

        if (msg.status === 'error') {
          if (msg.error === FS_READ_ERROR_CODES.IS_DIRECTORY) {
            // The target is a directory, not a file — this is NOT a failed
            // preview. Open the folder's listing in the left tree and clear the
            // preview pane instead of showing "preview failed".
            // When the directory IS the auto-preview target (e.g. a folder path
            // clicked in chat), mark it dismissed first so the auto-preview
            // effect does not immediately re-trigger fetchPreview() for it —
            // otherwise navigate→idle→re-fetch loops forever and the UI flickers.
            if (filePath === autoPreviewPathRef.current) {
              dismissedAutoPreviewPathRef.current = filePath;
            }
            navigateToRef.current(filePath);
            setPreview({ status: 'idle' });
            return;
          }
          if (pending.reason === 'refresh') {
            previewRefreshBackoffUntilRef.current = Date.now() + PREVIEW_REFRESH_FAILURE_BACKOFF_MS;
            return;
          }
          const errKey = msg.error === FS_READ_ERROR_CODES.FILE_TOO_LARGE ? 'file_browser.preview_too_large'
            : msg.error === FS_READ_ERROR_CODES.FORBIDDEN_PATH ? 'file_browser.preview_error'
            : 'file_browser.preview_error';
          setPreview({ status: 'error', path: filePath, error: t(errKey), downloadId: dlId });
          return;
        }
        previewRefreshBackoffUntilRef.current = 0;

        // Media preview — daemon signals stream-mode (no inline content) and
        // we let the browser media element fetch bytes via the HTTP download endpoint.
        // This avoids dragging a full 100 MB base64 payload through the
        // WebSocket and preserves browser-native streaming/seeking.
        const videoType = getVideoType(filePath);
        if (
          videoType
          && (msg as { previewMode?: string }).previewMode === 'stream'
          && dlId
          && serverId
        ) {
          const mimeType = (msg.mimeType as string | undefined) ?? videoType;
          void buildAttachmentDownloadUrl(serverId, dlId)
            .then((streamUrl) => {
              if (!mountedRef.current) return;
              const stillActive = getActivePreviewCycle(filePath);
              if (!stillActive || stillActive.cycleId !== pending.cycleId) return;
              setPreview({ status: 'video', path: filePath, streamUrl, mimeType, downloadId: dlId });
            })
            .catch(() => {
              if (!mountedRef.current) return;
              const stillActive = getActivePreviewCycle(filePath);
              if (!stillActive || stillActive.cycleId !== pending.cycleId) return;
              setPreview({ status: 'error', path: filePath, error: t('file_browser.preview_error'), downloadId: dlId });
            });
          return;
        }

        const audioType = getAudioType(filePath);
        if (
          audioType
          && (msg as { previewMode?: string }).previewMode === 'stream'
          && dlId
          && serverId
        ) {
          const mimeType = (msg.mimeType as string | undefined) ?? audioType;
          void buildAttachmentDownloadUrl(serverId, dlId)
            .then((streamUrl) => {
              if (!mountedRef.current) return;
              const stillActive = getActivePreviewCycle(filePath);
              if (!stillActive || stillActive.cycleId !== pending.cycleId) return;
              setPreview({ status: 'audio', path: filePath, streamUrl, mimeType, downloadId: dlId });
            })
            .catch(() => {
              if (!mountedRef.current) return;
              const stillActive = getActivePreviewCycle(filePath);
              if (!stillActive || stillActive.cycleId !== pending.cycleId) return;
              setPreview({ status: 'error', path: filePath, error: t('file_browser.preview_error'), downloadId: dlId });
            });
          return;
        }

        // Office document preview (PDF, DOCX, XLSX) — check before image
        const officeType = getOfficeType(filePath);
        if (officeType && msg.encoding === 'base64') {
          setPreview({ status: 'office', path: filePath, data: msg.content ?? '', mimeType: officeType, downloadId: dlId });
          return;
        }

        // Image files: render as <img> from base64
        if (msg.encoding === 'base64' && msg.mimeType) {
          const dataUrl = `data:${msg.mimeType};base64,${msg.content ?? ''}`;
          setPreview({ status: 'image', path: filePath, dataUrl, downloadId: dlId });
          return;
        }

        const content = msg.content ?? '';
        if (isBinaryContent(content)) {
          setPreview({ status: 'error', path: filePath, error: t('file_browser.preview_binary'), downloadId: dlId });
          return;
        }

        // Store mtime for conflict detection
        if (msg.mtime !== undefined) {
          setOriginalMtime(msg.mtime);
        }
        setEditContent(content);

        const pendingDiff = pendingPreviewDiffRef.current.get(previewCycleKey(filePath, pending.cycleId));
        setPreview((prev) => {
          const existing = prev.status === 'ok' && prev.path === filePath ? prev : null;
          return {
            status: 'ok',
            path: filePath,
            content,
            diff: existing?.diff ?? pendingDiff?.diff,
            diffHtml: existing?.diffHtml ?? pendingDiff?.diffHtml,
            downloadId: dlId,
          };
        });
        pendingPreviewDiffRef.current.delete(previewCycleKey(filePath, pending.cycleId));
        return;
      }

      // Forward write responses to FileEditor component
      if (msg.type === 'fs.write_response') {
        const pendingCreate = pendingCreateFileRef.current.get(msg.requestId);
        if (pendingCreate) {
          pendingCreateFileRef.current.delete(msg.requestId);
          if (!mountedRef.current) return;
          if (msg.status === 'error' || msg.status === 'conflict') {
            setError(msg.error === FS_WRITE_ERROR.FILE_EXISTS ? t('file_browser.file_exists') : (msg.error ?? t('file_browser.create_file_failed')));
            return;
          }
          loadedRef.current.delete(pendingCreate.parentPath);
          setError(null);
          fetchDir(pendingCreate.parentPath);
          if (includeFiles) {
            setPanelView('files');
            setSelectedPaths(new Set([pendingCreate.targetPath]));
            fetchPreview(msg.resolvedPath ?? pendingCreate.targetPath);
          }
          return;
        }
        for (const h of editorMsgHandlers.current) h(msg);
        return;
      }

      if (msg.type === FS_TRANSPORT_MSG.RENAME_RESPONSE) {
        const pendingRename = pendingRenameRef.current.get(msg.requestId);
        if (!pendingRename) return;
        pendingRenameRef.current.delete(msg.requestId);
        if (!mountedRef.current) return;
        if (msg.status === 'error') {
          setError(msg.error === FS_WRITE_ERROR.FILE_EXISTS ? t('file_browser.file_exists') : (msg.error ?? t('file_browser.rename_failed')));
          return;
        }
        loadedRef.current.delete(pendingRename.parentPath);
        setError(null);
        setSelectedPaths(new Set([pendingRename.targetPath]));
        if (previewRef.current.status !== 'idle' && (previewRef.current as { path: string }).path === pendingRename.sourcePath) {
          setPreview({ status: 'idle' });
        }
        fetchDir(pendingRename.parentPath);
        return;
      }

      if (msg.type === FS_TRANSPORT_MSG.DELETE_RESPONSE) {
        const pendingDelete = pendingDeleteRef.current.get(msg.requestId);
        if (!pendingDelete) return;
        pendingDeleteRef.current.delete(msg.requestId);
        if (!mountedRef.current) return;
        if (msg.status === 'error') {
          setError(msg.error ?? t('file_browser.delete_failed'));
          return;
        }
        if (pendingDelete.parentPath) {
          loadedRef.current.delete(pendingDelete.parentPath);
          fetchDir(pendingDelete.parentPath);
        }
        setError(null);
        setSelectedPaths((prev) => {
          if (!prev.has(pendingDelete.targetPath)) return prev;
          const next = new Set(prev);
          next.delete(pendingDelete.targetPath);
          return next;
        });
        if (previewRef.current.status !== 'idle' && (previewRef.current as { path: string }).path === pendingDelete.targetPath) {
          setPreview({ status: 'idle' });
        }
        return;
      }

      if (msg.type === 'fs.git_status_response') {
        // Shared-cache path (changesRootPath, badges, etc.) is routed
        // into `git-status-store` by its per-ws bridge, so we only handle
        // the per-tree-node path here: requests we fired while expanding
        // a directory to annotate individual file rows with git state.
        const dirPath = pendingGitStatusRef.current.get(msg.requestId);
        if (!dirPath) return;
        pendingGitStatusRef.current.delete(msg.requestId);
        if (!mountedRef.current) return;
        if (msg.status === 'ok' && msg.files) {
          setModifiedFiles((prev) => {
            const next = new Map(prev);
            for (const [k] of next) {
              if (k.startsWith(dirPath + '/')) next.delete(k);
            }
            for (const f of msg.files!) {
              next.set(f.path, f.code);
            }
            return next;
          });
        }
        return;
      }

      if (msg.type === 'fs.git_diff_response') {
        const pending = pendingGitDiffRef.current.get(msg.requestId);
        if (!pending) return;
        clearPendingPreviewRequest('diff', msg.requestId);
        const active = getActivePreviewCycle();
        if (!active || active.path !== pending.path || active.cycleId !== pending.cycleId) return;
        const filePath = pending.path;
        if (!mountedRef.current) return;
        if (msg.status === 'ok') {
          const diff = msg.diff ?? '';
          const diffHtml = diff ? renderDiff(diff) : '';
          if (!diffHtml && previewTabOverridePathRef.current !== filePath) {
            setShowDiff(false);
          }
          const diffKey = previewCycleKey(filePath, pending.cycleId);
          const currentPreview = previewRef.current;
          if (diffHtml && !(currentPreview.status === 'ok' && currentPreview.path === filePath)) {
            pendingPreviewDiffRef.current.set(diffKey, {
              path: filePath,
              cycleId: pending.cycleId,
              diff,
              diffHtml,
            });
          } else {
            pendingPreviewDiffRef.current.delete(diffKey);
          }
          setPreview((prev) => {
            if (prev.status === 'ok' && prev.path === filePath) {
              return { ...prev, diff, diffHtml };
            }
            return prev;
          });
        }
        return;
      }

      if (msg.type === 'fs.mkdir_response') {
        const pending = pendingMkdirRef.current.get(msg.requestId);
        if (!pending) return;
        pendingMkdirRef.current.delete(msg.requestId);
        if (!mountedRef.current) return;

        if (msg.status === 'error') {
          setError(msg.error ?? t('file_browser.mkdir_failed'));
          return;
        }

        loadedRef.current.delete(pending.parentPath);
        const createdPath = msg.resolvedPath ?? pending.targetPath;
        setError(null);
        setSelectedPaths(new Set([createdPath]));
        fetchDir(pending.parentPath);
        onDirectoryCreated?.(createdPath);
        return;
      }
    });
  }, [clearAllPendingPreviewRequests, clearPendingPreviewRequest, fetchDir, getActivePreviewCycle, onDirectoryCreated, startPath, showHidden, highlightPath, t, ws]);

  const fetchPreview = useCallback((
    filePath: string,
    preferDiff = false,
    requestedViewMode?: HtmlPreviewViewMode,
  ) => {
    const nextViewMode = requestedViewMode ?? (preferDiff ? 'diff' : 'source');
    const shouldFetchDiff = nextViewMode !== 'html-render';
    if (editDirtyRef.current) {
      if (!window.confirm(t('fileBrowser.unsavedChanges'))) return;
    }
    // Keep the left tree in sync with the previewed file without discarding the
    // user's expanded tree. If the file's parent already exists in the current
    // tree, reveal/select it in-place. Only re-root when the preview came from
    // outside the current tree (for example an external chat path).
    const parentDir = getParentDir(filePath);
    if (parentDir && parentDir !== currentLabelRef.current) {
      const parentNodePath = findNodePath(dataRef.current, parentDir);
      if (parentNodePath) {
        setExpandedPaths((prev) => {
          const next = new Set(prev);
          for (const nodeId of parentNodePath) next.add(nodeId);
          return next;
        });
        setCurrentLabel(parentDir);
        fetchDir(parentDir);
      } else {
        navigateToRef.current(parentDir);
      }
      setSelectedPaths(new Set([filePath]));
    }
    if (onPreviewFile) {
      onPreviewFile({
        path: filePath,
        sessionName,
        preferDiff,
        previewViewMode: nextViewMode,
        preview: { status: 'loading', path: filePath },
      });
      return;
    }
    dismissedAutoPreviewPathRef.current = autoPreviewPath && filePath !== autoPreviewPath
      ? autoPreviewPath
      : null;
    previewTabOverridePathRef.current = null;
    setEditDirty(false);
    setEditContent('');
    setOriginalMtime(undefined);
    setIsEditing(() => { try { return localStorage.getItem(PREF_KEY) === '1'; } catch { return false; } });
    pendingPreviewDiffRef.current.clear();
    const active = getActivePreviewCycle(filePath);
    const cycleId = active && (hasPendingPreviewWork('read', filePath, active.cycleId) || hasPendingPreviewWork('diff', filePath, active.cycleId))
      ? active.cycleId
      : nextPreviewCycleIdRef.current++;
    activePreviewCycleRef.current = { path: filePath, cycleId };
    const loadingPreview: FileBrowserPreviewState = { status: 'loading', path: filePath };
    setPreview(loadingPreview);
    setPreviewViewMode(nextViewMode);
    setShowDiff(nextViewMode === 'diff');
    onPreviewStateChange?.({
      path: filePath,
      preferDiff,
      previewViewMode: nextViewMode,
      preview: loadingPreview,
    });
    if (!hasPendingPreviewWork('read', filePath, cycleId)) {
      const requestId = ws.fsReadFile(filePath);
      trackPendingPreviewRequest('read', requestId, { path: filePath, cycleId, reason: 'interactive' });
    }
    if (shouldFetchDiff && !hasPendingPreviewWork('diff', filePath, cycleId)) {
      const diffId = ws.fsGitDiff(filePath);
      trackPendingPreviewRequest('diff', diffId, { path: filePath, cycleId, reason: 'interactive' });
    }
  }, [autoPreviewPath, fetchDir, getActivePreviewCycle, hasPendingPreviewWork, onPreviewFile, onPreviewStateChange, t, trackPendingPreviewRequest, ws]);

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set([startPath]));

  const buildChildPath = useCallback((parentPath: string, childName: string) => {
    const sep = parentPath.includes('\\') ? '\\' : '/';
    return `${parentPath}${parentPath.endsWith(sep) ? '' : sep}${childName}`;
  }, []);

  const requestMkdir = useCallback((parentPath: string, folderName: string) => {
    const trimmed = folderName.trim();
    if (!trimmed) return;
    const fullPath = buildChildPath(parentPath, trimmed);
    const requestId = ws.fsMkdir(fullPath);
    pendingMkdirRef.current.set(requestId, { parentPath, targetPath: fullPath });
    setNewEntry(null);
    setNewEntryName('');
  }, [buildChildPath, ws]);

  const requestCreateFile = useCallback((parentPath: string, fileName: string) => {
    const trimmed = fileName.trim();
    if (!trimmed) return;
    const fullPath = buildChildPath(parentPath, trimmed);
    const requestId = ws.fsWriteFile(fullPath, '', { createOnly: true });
    pendingCreateFileRef.current.set(requestId, { parentPath, targetPath: fullPath });
    setNewEntry(null);
    setNewEntryName('');
  }, [buildChildPath, ws]);

  const requestRename = useCallback((node: FsNode) => {
    const parentPath = getParentDir(node.id);
    if (!parentPath) return;
    const nextName = window.prompt(t('file_browser.rename_prompt', { name: node.name }), node.name);
    const trimmed = nextName?.trim();
    if (!trimmed || trimmed === node.name) return;
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      setError(t('file_browser.invalid_name'));
      return;
    }
    const targetPath = buildChildPath(parentPath, trimmed);
    const requestId = sessionName
      ? ws.fsRename(node.id, targetPath, sessionName)
      : ws.fsRename(node.id, targetPath);
    pendingRenameRef.current.set(requestId, { parentPath, sourcePath: node.id, targetPath });
    setContextMenu(null);
  }, [buildChildPath, sessionName, t, ws]);

  const requestDelete = useCallback((node: FsNode) => {
    const confirmed = window.confirm(t('file_browser.delete_confirm', { name: node.name }));
    if (!confirmed) return;
    const requestId = sessionName ? ws.fsDelete(node.id, sessionName) : ws.fsDelete(node.id);
    pendingDeleteRef.current.set(requestId, { parentPath: getParentDir(node.id), targetPath: node.id });
    setContextMenu(null);
  }, [sessionName, t, ws]);

  const requestNewEntry = useCallback(() => {
    if (!newEntry) return;
    if (newEntry.kind === 'folder') {
      requestMkdir(newEntry.parentPath, newEntryName);
      return;
    }
    requestCreateFile(newEntry.parentPath, newEntryName);
  }, [newEntry, newEntryName, requestCreateFile, requestMkdir]);

  // Navigate to a path and push to history
  const jumpTo = useCallback((newPath: string) => {
    loadedRef.current.clear();
    setData([{ id: newPath, name: newPath, isDir: true, children: [] }]);
    setExpandedPaths(new Set([newPath]));
    setSelectedPaths(new Set());
    setCurrentLabel(newPath);
    fetchDir(newPath);
  }, [fetchDir]);

  const navigateTo = useCallback((newPath: string) => {
    // Trim forward entries if we navigated back before
    historyRef.current = historyRef.current.slice(0, historyIdxRef.current + 1);
    historyRef.current.push(newPath);
    historyIdxRef.current = historyRef.current.length - 1;
    setCanGoBack(historyIdxRef.current > 0);
    jumpTo(newPath);
  }, [jumpTo]);
  useEffect(() => { navigateToRef.current = navigateTo; }, [navigateTo]);

  const goBack = useCallback(() => {
    if (historyIdxRef.current <= 0) return;
    historyIdxRef.current -= 1;
    setCanGoBack(historyIdxRef.current > 0);
    jumpTo(historyRef.current[historyIdxRef.current]);
  }, [jumpTo]);

  const goUp = useCallback(() => {
    // Handle both Unix (/) and Windows (\) path separators
    const normalized = currentLabel.replace(/\/$/, '').replace(/\\$/, '');
    const sep = normalized.includes('\\') ? '\\' : '/';
    const parts = normalized.split(sep);
    if (parts.length > 1) {
      let parent = parts.slice(0, -1).join(sep) || sep;
      // Ensure Windows drive root has trailing backslash: C: → C:\
      if (/^[A-Za-z]:$/.test(parent)) parent += '\\';
      navigateTo(parent);
    }
  }, [currentLabel, navigateTo]);

  // Load root on mount and re-load when ws changes (server switch).
  // fetchDir changes when ws changes (useCallback dep), so this also re-runs on server switch.
  const prevWsRef = useRef(ws);
  useEffect(() => {
    if (ws !== prevWsRef.current) {
      prevWsRef.current = ws;
      // Clear stale state from previous ws instance
      loadedRef.current.clear();
      pendingRef.current.clear();
      clearAllPendingPreviewRequests();
      pendingCreateFileRef.current.clear();
      pendingPreviewDiffRef.current.clear();
      activePreviewCycleRef.current = null;
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
      const cached = loadFileBrowserSnapshot(startPath, includeFiles, showHidden, serverId);
      setData([{ id: startPath, name: startPath, isDir: true, children: cached?.rootChildren ?? [] }]);
      setCurrentLabel(cached?.currentLabel ?? startPath);
      setError(null);
    }
    fetchDir(startPath);
  }, [clearAllPendingPreviewRequests, fetchDir, includeFiles, serverId, showHidden, startPath]);

  useEffect(() => {
    if (!changesRootPath) return;
    const cacheKey = getSharedChangesKey(ws, changesRootPath);
    const unsubscribeFiles = subscribeSharedChanges(cacheKey, (files) => {
      if (!mountedRef.current) return;
      setChangesFiles(files);
      setModifiedFiles((prev) => {
        const next = new Map(prev);
        for (const [k] of next) {
          if (k.startsWith(changesRootPath + '/')) next.delete(k);
        }
        for (const file of files) next.set(file.path, file.code);
        return next;
      });
    });
    const unsubscribeStatus = subscribeSharedChangesStatus(cacheKey, (status) => {
      if (!mountedRef.current) return;
      if (changesRefreshFeedbackTimerRef.current) {
        clearTimeout(changesRefreshFeedbackTimerRef.current);
        changesRefreshFeedbackTimerRef.current = null;
      }
      setChangesRefreshStatus(status);
      if (status === 'success' || status === 'error') {
        changesRefreshFeedbackTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setChangesRefreshStatus('idle');
          changesRefreshFeedbackTimerRef.current = null;
        }, status === 'success' ? 1_500 : 3_000);
      } else if (status === 'refreshing') {
        changesRefreshFeedbackTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setChangesRefreshStatus('error');
          changesRefreshFeedbackTimerRef.current = null;
        }, 15_000);
      }
    });
    return () => {
      unsubscribeFiles();
      unsubscribeStatus();
      if (changesRefreshFeedbackTimerRef.current) {
        clearTimeout(changesRefreshFeedbackTimerRef.current);
        changesRefreshFeedbackTimerRef.current = null;
      }
      setChangesRefreshStatus('idle');
    };
  }, [changesRootPath, ws]);

  useEffect(() => {
    if (!initialPreview || initialPreview.status === 'idle') return;
    setPreview((prev) => mergePreviewState(prev, initialPreview));
  }, [initialPreview]);

  useEffect(() => {
    const nextMode = initialPreviewViewMode ?? (autoPreviewPreferDiff ? 'diff' : 'source');
    setPreviewViewMode(nextMode);
    setShowDiff(nextMode === 'diff');
  }, [autoPreviewPreferDiff, initialPreviewViewMode]);

  useEffect(() => {
    if (!autoPreviewPath) {
      dismissedAutoPreviewPathRef.current = null;
      return;
    }
    if (dismissedAutoPreviewPathRef.current && dismissedAutoPreviewPathRef.current !== autoPreviewPath) {
      dismissedAutoPreviewPathRef.current = null;
    }
  }, [autoPreviewPath]);

  useEffect(() => {
    if (!onPreviewStateChange) return;
    if (preview.status === 'idle') return;
    onPreviewStateChange({
      path: (preview as { path: string }).path,
      preferDiff: previewViewMode === 'diff' && showDiff,
      previewViewMode,
      preview,
    });
  }, [onPreviewStateChange, preview, previewViewMode, showDiff]);

  // Auto-preview file on open (e.g. when clicking a path link in chat)
  useEffect(() => {
    if (!autoPreviewPath) return;
    if (dismissedAutoPreviewPathRef.current === autoPreviewPath) return;
    const currentPreviewPath = preview.status !== 'idle' ? (preview as { path: string }).path : null;
    if (currentPreviewPath === autoPreviewPath && preview.status !== 'idle') {
      if (previewTabOverridePathRef.current !== autoPreviewPath) {
        const nextMode = initialPreviewViewMode ?? (autoPreviewPreferDiff ? 'diff' : 'source');
        setPreviewViewMode(nextMode);
        setShowDiff(nextMode === 'diff');
      }
      if (preview.status === 'loading' && initialPreview?.status === 'loading' && !skipAutoPreviewIfLoading) {
        const hasPendingRead = hasPendingPreviewWork('read', autoPreviewPath);
        if (!hasPendingRead) fetchPreview(autoPreviewPath, autoPreviewPreferDiff, initialPreviewViewMode);
      }
      return;
    }
    fetchPreview(autoPreviewPath, autoPreviewPreferDiff, initialPreviewViewMode);
  }, [autoPreviewPath, autoPreviewPreferDiff, fetchPreview, hasPendingPreviewWork, initialPreview, initialPreviewViewMode, preview, skipAutoPreviewIfLoading]);

  const dismissPreview = useCallback(() => {
    if (editDirty && !window.confirm(t('fileBrowser.unsavedChanges'))) return;
    if (autoPreviewPath) dismissedAutoPreviewPathRef.current = autoPreviewPath;
    previewTabOverridePathRef.current = null;
    activePreviewCycleRef.current = null;
    clearAllPendingPreviewRequests();
    pendingPreviewDiffRef.current.clear();
    setIsEditing(false);
    setEditDirty(false);
    setPreview({ status: 'idle' });
    if (autoPreviewPath && onClose) {
      onClose();
    }
  }, [autoPreviewPath, clearAllPendingPreviewRequests, editDirty, onClose, t]);

  // Auto-refresh preview content periodically when a file is being previewed (paused during editing).
  useEffect(() => {
    if (preview.status !== 'ok' && preview.status !== 'image') return;
    if (onPreviewFile) return; // external preview — don't poll here
    if (isEditing) return; // pause auto-refresh while editing
    const path = (preview as { path: string }).path;
    const timer = setInterval(() => {
      if (!mountedRef.current) return;
      if (Date.now() < previewRefreshBackoffUntilRef.current) return;
      const shouldRefreshDiff = previewViewMode === 'diff' && showDiff;
      if (hasPendingPreviewWork('read', path) || (shouldRefreshDiff && hasPendingPreviewWork('diff', path))) return;
      try {
        const cycleId = nextPreviewCycleIdRef.current++;
        activePreviewCycleRef.current = { path, cycleId };
        const reqId = ws.fsReadFile(path);
        trackPendingPreviewRequest('read', reqId, { path, cycleId, reason: 'refresh' });
        if (shouldRefreshDiff) {
          const diffId = ws.fsGitDiff(path);
          trackPendingPreviewRequest('diff', diffId, { path, cycleId, reason: 'refresh' });
        }
      } catch { /* ws disconnected */ }
    }, PREVIEW_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [preview.status, (preview as any).path, ws, onPreviewFile, isEditing, hasPendingPreviewWork, previewViewMode, showDiff, trackPendingPreviewRequest]);

  // Rate-limited git status refresh for the changes panel
  const CHANGES_RATE_LIMIT_MS = 5_000;
  const lastChangesRefreshRef = useRef(0);
  const pendingChangesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const changesVisible = !!changesRootPath && panelView === 'changes';

  const refreshChanges = useCallback(() => {
    if (!changesRootPath) return;
    const now = Date.now();
    const elapsed = now - lastChangesRefreshRef.current;
    if (elapsed >= CHANGES_RATE_LIMIT_MS) {
      lastChangesRefreshRef.current = now;
      requestSharedChanges(ws, changesRootPath);
    } else {
      // Schedule for when rate limit clears
      if (pendingChangesTimerRef.current) clearTimeout(pendingChangesTimerRef.current);
      pendingChangesTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        lastChangesRefreshRef.current = Date.now();
        requestSharedChanges(ws, changesRootPath, true);
      }, CHANGES_RATE_LIMIT_MS - elapsed);
    }
  }, [changesRootPath, ws]);

  // Initial fetch on mount
  useEffect(() => {
    if (!changesVisible) return;
    refreshChanges();
  }, [changesVisible, changesRootPath, ws]); // eslint-disable-line react-hooks/exhaustive-deps

  // 30s polling
  useEffect(() => {
    if (!changesVisible) return;
    const id = setInterval(() => {
      if (mountedRef.current) refreshChanges();
    }, 30_000);
    return () => clearInterval(id);
  }, [changesVisible, refreshChanges]);

  // External refresh trigger (e.g. from tool.call events in ChatView)
  useEffect(() => {
    if (!changesVisible) return;
    if (refreshTrigger === undefined || refreshTrigger === 0) return;
    refreshChanges();
  }, [changesVisible, refreshTrigger, refreshChanges]);

  // Reload tree when showHidden changes
  useEffect(() => {
    loadedRef.current.clear();
    const cached = loadFileBrowserSnapshot(startPath, includeFiles, showHidden, serverId);
    setData([{ id: startPath, name: startPath, isDir: true, children: cached?.rootChildren ?? [] }]);
    setCurrentLabel(cached?.currentLabel ?? startPath);
    fetchDir(startPath);
  }, [fetchDir, includeFiles, serverId, showHidden, startPath]);

  const toggleExpand = useCallback((nodeId: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) { next.delete(nodeId); } else {
        next.add(nodeId);
        fetchDir(nodeId);
      }
      return next;
    });
  }, [fetchDir]);

  const handleSelect = useCallback((nodeId: string, isDir: boolean) => {
    if (mode === 'dir-only' && !isDir) return;
    if (isMulti) {
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(nodeId)) { next.delete(nodeId); } else { next.add(nodeId); }
        return next;
      });
    } else {
      setSelectedPaths(new Set([nodeId]));
    }
    if (isDir) {
      const path = nodeId.split(/[/\\]/).pop() || nodeId;
      void path;
      setCurrentLabel(nodeId);
    }
  }, [mode, isMulti]);

  const handlePreview = useCallback((filePath: string) => {
    if (preview.status !== 'loading' || (preview as { path: string }).path !== filePath) {
      fetchPreview(filePath);
    }
  }, [fetchPreview, preview]);

  const handleNodeContextMenu = useCallback((node: FsNode, event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      node,
      x: Math.min(event.clientX, Math.max(0, window.innerWidth - 176)),
      y: Math.min(event.clientY, Math.max(0, window.innerHeight - 96)),
    });
  }, []);

  const handleConfirm = () => {
    if (selectedPaths.size === 0) {
      if (mode === 'dir-only') onConfirm([currentLabel]);
      return;
    }
    onConfirm([...selectedPaths]);
  };

  const title = mode === 'dir-only' ? t('file_browser.title_dir') : t('file_browser.title_file');
  const confirmLabel = mode === 'dir-only'
    ? t('file_browser.select')
    : selectedPaths.size > 0
      ? t('file_browser.insert', { count: selectedPaths.size })
      : t('file_browser.select');

  const alreadySet = new Set(alreadyInserted);
  const usesExternalPreview = !!onPreviewFile;
  const hasInlinePreview = mode !== 'dir-only' && preview.status !== 'idle' && !usesExternalPreview;
  const hasPreview = hasInlinePreview;

  const previewPath = preview.status !== 'idle' ? (preview as { path: string }).path : null;

  const contextMenuView = contextMenu ? (
    <div
      ref={contextMenuRef}
      class="fb-context-menu"
      style={{ left: contextMenu.x, top: contextMenu.y }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <button type="button" onClick={() => requestRename(contextMenu.node)}>{t('common.rename')}</button>
      <button type="button" class="danger" onClick={() => requestDelete(contextMenu.node)}>{t('common.delete')}</button>
    </div>
  ) : null;

  const tree = (
    <div class={`fb-tree${layout !== 'panel' && hasInlinePreview ? ' fb-tree-split' : ''}`}>
      {data.map((root) => (
        <FsTreeNode
          key={root.id}
          node={root}
          expandedPaths={expandedPaths}
          selectedPaths={selectedPaths}
          alreadySet={alreadySet}
          mode={mode}
          showHidden={showHidden}
          modifiedFiles={modifiedFiles}
          onToggleExpand={toggleExpand}
          onSelect={handleSelect}
          onPreview={handlePreview}
          onContextMenu={handleNodeContextMenu}
          previewPath={previewPath}
        />
      ))}
    </div>
  );

  const hasDiff = preview.status === 'ok' && (!!preview.diff || !!preview.diffHtml);
  const canRenderDiff = preview.status === 'ok' && !!preview.diffHtml;
  const isHtmlRenderMode = previewViewMode === 'html-render';
  const canRenderHtml = preview.status === 'ok' && isHtmlPreviewPath(preview.path);
  const previewScrollMode = getPreviewScrollMode(preview, isEditing, previewViewMode, canRenderDiff);
  const activePreviewScrollKey = previewScrollMode && preview.status !== 'idle'
    ? previewScrollKey((preview as { path: string }).path, previewScrollMode)
    : null;

  useEffect(() => {
    const el = previewContentRef.current;
    if (!el || !activePreviewScrollKey) return;
    const saveScroll = () => {
      previewScrollSnapshotRef.current = {
        key: activePreviewScrollKey,
        scrollTop: el.scrollTop,
        scrollLeft: el.scrollLeft,
      };
    };
    saveScroll();
    el.addEventListener('scroll', saveScroll, { passive: true });
    return () => {
      saveScroll();
      el.removeEventListener('scroll', saveScroll);
    };
  }, [activePreviewScrollKey]);

  useLayoutEffect(() => {
    const el = previewContentRef.current;
    const snapshot = previewScrollSnapshotRef.current;
    if (!el || !activePreviewScrollKey || !snapshot || snapshot.key !== activePreviewScrollKey) return;
    if (el.scrollTop !== snapshot.scrollTop) el.scrollTop = snapshot.scrollTop;
    if (el.scrollLeft !== snapshot.scrollLeft) el.scrollLeft = snapshot.scrollLeft;
  }, [activePreviewScrollKey, preview]);

  useEffect(() => {
    if (!canRenderHtml || !isHtmlRenderMode || isEditing) return;
    const next = { status: 'ok' as const, path: preview.path, content: preview.content };
    if (!openHtmlPreviewInNewWindow(next)) {
      setHtmlFullscreenPreview(next);
    }
    setPreviewViewMode('source');
    setShowDiff(false);
  }, [canRenderHtml, isEditing, isHtmlRenderMode, preview]);

  const downloadCurrentPreview = useCallback(async () => {
    if (!serverId || preview.status === 'idle' || !('downloadId' in preview) || !preview.downloadId) return;
    setDownloadError(null);
    try {
      await downloadAttachment(serverId, preview.downloadId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isStaleHandle = msg.includes('410') || msg.includes('expired') || msg.includes('not_found') || msg.includes('404');
      // Stale handle: silently re-request file to get a fresh downloadId, then auto-retry.
      if (isStaleHandle && 'path' in preview) {
        try {
          const freshId = await new Promise<string>((resolve, reject) => {
            const requestId = ws.fsReadFile(preview.path);
            const timer = setTimeout(() => reject(new Error('timeout')), 10_000);
            const off = ws.onMessage((m) => {
              if (m.type !== 'fs.read_response' || !('requestId' in m) || m.requestId !== requestId) return;
              off();
              clearTimeout(timer);
              if ('downloadId' in m && typeof m.downloadId === 'string') resolve(m.downloadId);
              else reject(new Error('no_handle'));
            });
          });
          setPreview((prev) => {
            if (prev.status === 'idle' || !('path' in prev)) return prev;
            return { ...prev, downloadId: freshId } as typeof prev;
          });
          await downloadAttachment(serverId, freshId);
          return;
        } catch { /* retry failed — fall through to show error */ }
      }
      if (msg.includes('daemon_offline') || msg.includes('503')) setDownloadError(t('upload.daemon_offline'));
      else if (isStaleHandle) setDownloadError(t('upload.download_expired'));
      else if (msg.includes('504') || msg.includes('timeout')) setDownloadError(t('upload.download_timeout'));
      else setDownloadError(t('upload.download_failed'));
      setTimeout(() => setDownloadError(null), 5000);
      throw err;
    }
  }, [preview, serverId, t, ws]);

  const previewPane = hasInlinePreview ? (
    <div class="fb-preview">
      <div class="fb-preview-header">
        <button class="fb-preview-back" onClick={() => {
          dismissPreview();
        }}>←</button>
        <span class="fb-preview-name">{previewPath!.split(/[/\\]/).pop()}</span>
        {preview.status === 'ok' && !isEditing && (
          <button class="fb-diff-toggle" onClick={() => {
            setIsEditing(true);
            try { localStorage.setItem(PREF_KEY, '1'); } catch {}
          }}>{t('fileBrowser.edit')}</button>
        )}
        {isEditing && preview.status === 'ok' && (
          <Suspense fallback={null}>
            <FileEditor
              ws={ws}
              path={preview.path}
              content={preview.content}
              currentContent={editContent}
              isDirty={editDirty}
              mtime={originalMtime}
              onClose={() => {
                if (editDirty && !window.confirm(t('fileBrowser.unsavedChanges'))) return;
                setIsEditing(false);
                setEditDirty(false);
                try { localStorage.setItem(PREF_KEY, '0'); } catch {}
              }}
              onSaved={(newMtime) => {
                setOriginalMtime(newMtime);
                setEditDirty(false);
                setPreview((prev) => prev.status === 'ok' && prev.path === preview.path
                  ? { ...prev, content: editContent, diff: undefined, diffHtml: undefined }
                  : prev);
              }}
              onMessage={onEditorMessage}
              onDirtyChange={setEditDirty}
              onContentChange={setEditContent}
            />
          </Suspense>
        )}
        {!isEditing && canRenderHtml && (
          <button
            class="fb-diff-toggle"
            onClick={() => {
              previewTabOverridePathRef.current = preview.path;
              const next = { status: 'ok' as const, path: preview.path, content: preview.content };
              if (!openHtmlPreviewInNewWindow(next)) {
                setHtmlFullscreenPreview(next);
              }
              setPreviewViewMode('source');
              setShowDiff(false);
            }}
            title={t('file_browser.view_rendered')}
            aria-label={t('file_browser.view_rendered')}
          >
            👁
          </button>
        )}
        {!isEditing && hasDiff && !isHtmlRenderMode && (
          <button
            class={`fb-diff-toggle${showDiff ? ' active' : ''}`}
            onClick={() => {
              previewTabOverridePathRef.current = preview.path;
              setPreviewViewMode((mode) => (mode === 'diff' ? 'source' : 'diff'));
              setShowDiff((v) => !v);
            }}
            title={showDiff ? t('file_browser.view_source') : t('file_browser.view_diff')}
          >
            {showDiff ? t('file_browser.view_source') : t('file_browser.view_diff')}
          </button>
        )}
        {(preview.status === 'ok' || preview.status === 'image' || preview.status === 'office' || preview.status === 'video' || preview.status === 'audio' || preview.status === 'error') && serverId && preview.downloadId && (
          <button
            class="fb-diff-toggle"
            title={downloadError || t('upload.download_file')}
            style={downloadError ? { color: '#ef4444' } : undefined}
            onClick={() => {
              void downloadCurrentPreview().catch(() => undefined);
            }}
          >
            {downloadError || t('upload.download_file')}
          </button>
        )}
        {/* Copy path / Insert path — available whenever we know the file path.
            Copy targets the clipboard via navigator.clipboard.writeText; Insert
            calls `onInsertPath` if the host wired it (ChatView does; standalone
            preview hosts may not, in which case the button is hidden to avoid
            a dead-end click). Inside the `hasInlinePreview` branch `preview`
            is already narrowed to a non-idle state, so every sub-variant has
            a `.path`. */}
        {'path' in preview && (
          <button
            class="fb-diff-toggle"
            title={preview.path}
            onClick={() => {
              const p = preview.path;
              void (async () => {
                try {
                  await navigator.clipboard.writeText(p);
                  setCopiedPath(p);
                  setTimeout(() => setCopiedPath((cur) => (cur === p ? null : cur)), 1500);
                } catch {
                  // Clipboard API can reject in insecure contexts or without a
                  // user gesture on some browsers — fall back silently; the
                  // user can still long-press the filename.
                }
              })();
            }}
          >
            {copiedPath === preview.path ? t('fileBrowser.copied') : t('fileBrowser.copyPath')}
          </button>
        )}
        {onInsertPath && 'path' in preview && (
          <button
            class="fb-diff-toggle"
            title={t('fileBrowser.insertPath')}
            onClick={() => {
              onInsertPath(preview.path);
              dismissPreview();
            }}
          >
            {t('fileBrowser.insertPath')}
          </button>
        )}
        <button class="fb-close" onClick={() => {
          dismissPreview();
        }}>✕</button>
      </div>
      {/* Conflict dialog rendered inside FileEditor */}
      <div class="fb-preview-content" ref={previewContentRef}>
        {preview.status === 'loading' && (
          <div class="fb-preview-loading">
            <div class="fb-loading-spinner" />
            <div class="fb-loading-text">{t('file_browser.preview_loading')}</div>
          </div>
        )}
        {preview.status === 'error' && (
          <div class="fb-preview-msg fb-preview-error">{preview.error}</div>
        )}
        {preview.status === 'image' && (
          <div class="fb-preview-image">
            <img
              src={preview.dataUrl}
              alt={preview.path.split(/[/\\]/).pop() ?? ''}
              onClick={() => setLightbox({
                src: preview.dataUrl,
                fileName: preview.path.split(/[/\\]/).pop() || undefined,
                onDownload: serverId && preview.downloadId ? downloadCurrentPreview : undefined,
              })}
              style={{ cursor: 'zoom-in' }}
            />
          </div>
        )}
        {preview.status === 'office' && (
          <Suspense fallback={<div class="fb-preview-loading"><div class="fb-loading-spinner" /></div>}>
            <OfficePreview data={preview.data} mimeType={preview.mimeType} path={preview.path} />
          </Suspense>
        )}
        {preview.status === 'video' && (
          <div class="fb-preview-video">
            <video
              key={preview.streamUrl}
              src={preview.streamUrl}
              controls
              preload="metadata"
              playsInline
              style={{ maxWidth: '100%', maxHeight: '100%', width: '100%', background: '#000' }}
            >
              <source src={preview.streamUrl} type={preview.mimeType} />
              {t('file_browser.preview_video_unsupported')}
            </video>
          </div>
        )}
        {preview.status === 'audio' && (
          <div class="fb-preview-audio">
            <div class="fb-preview-audio-card">
              <div class="fb-preview-audio-icon" aria-hidden="true">♪</div>
              <div class="fb-preview-audio-name">{preview.path.split(/[/\\]/).pop() ?? preview.path}</div>
              <audio
                key={preview.streamUrl}
                src={preview.streamUrl}
                controls
                preload="metadata"
                style={{ width: '100%' }}
              >
                <source src={preview.streamUrl} type={preview.mimeType} />
                {t('file_browser.preview_audio_unsupported')}
              </audio>
            </div>
          </div>
        )}
        {preview.status === 'ok' && isEditing && (
          <Suspense fallback={null}>
            <FileEditorContent
              ws={ws}
              path={preview.path}
              content={preview.content}
              currentContent={editContent}
              mtime={originalMtime}
              onMessage={onEditorMessage}
              onDirtyChange={setEditDirty}
              onContentChange={setEditContent}
              onSaved={(newMtime) => {
                setOriginalMtime(newMtime);
                setEditDirty(false);
                setPreview((prev) => prev.status === 'ok' && prev.path === preview.path
                  ? { ...prev, content: editContent, diff: undefined, diffHtml: undefined }
                  : prev);
              }}
              onMtimeUpdate={setOriginalMtime}
            />
          </Suspense>
        )}
        {preview.status === 'ok' && !isEditing && (!showDiff || !canRenderDiff) && (
          <Suspense fallback={<div class="fb-preview-loading"><div class="fb-loading-spinner" /></div>}>
            <FilePreviewPane content={preview.content} path={preview.path} />
          </Suspense>
        )}
        {preview.status === 'ok' && !isEditing && showDiff && canRenderDiff && (
          <div class="fb-diff" dangerouslySetInnerHTML={{ __html: preview.diffHtml ?? '' }} />
        )}
      </div>
      <HtmlFullscreenPreview preview={htmlFullscreenPreview} onClose={closeHtmlFullscreenPreview} />
    </div>
  ) : null;

  const footer = hideFooter ? null : (
    <div class="fb-footer">
      {isMulti && selectedPaths.size > 0 && (
        <span class="fb-count">{t('file_browser.selected_count', { count: selectedPaths.size })}</span>
      )}
      <div style={{ flex: 1 }} />
      {layout === 'modal' && (
        <button class="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
      )}
      <button
        class="btn btn-secondary fb-footer-copy-path"
        title={currentLabel}
        onClick={() => {
          const path = currentLabel;
          void (async () => {
            try {
              await navigator.clipboard.writeText(path);
              setCopiedPath(path);
              setTimeout(() => setCopiedPath((cur) => (cur === path ? null : cur)), 1500);
            } catch {
              // Clipboard access can be blocked in insecure contexts; keep the
              // file picker usable and leave the path visible in the title.
            }
          })();
        }}
      >
        {copiedPath === currentLabel ? t('fileBrowser.copied') : t('fileBrowser.copyPath')}
      </button>
      <button
        class="btn btn-primary"
        disabled={mode !== 'dir-only' && selectedPaths.size === 0}
        onClick={handleConfirm}
      >
        {confirmLabel}
      </button>
    </div>
  );

  // Git changes section (shown at bottom of Files view or as standalone Changes view)
  const STATUS_LABEL: Record<string, string> = {
    M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', '??': 'Untracked', '!!': 'Ignored',
  };
  const groupedChanges = useMemo(() => {
    const groups: Record<string, Array<{ path: string; code: string; additions?: number; deletions?: number }>> = {};
    for (const f of changesFiles) {
      const label = STATUS_LABEL[f.code] ?? f.code;
      if (!groups[label]) groups[label] = [];
      groups[label].push(f);
    }
    return groups;
  }, [changesFiles]);

  const changesRefreshLabel = changesRefreshStatus === 'refreshing'
    ? t('file_browser.refreshing_changes')
    : changesRefreshStatus === 'success'
      ? t('file_browser.refresh_changes_success')
      : changesRefreshStatus === 'error'
        ? t('file_browser.refresh_changes_failed')
        : t('file_browser.refresh_changes');
  const changesRefreshIcon = changesRefreshStatus === 'success'
    ? '✓'
    : changesRefreshStatus === 'error'
      ? '!'
      : '↻';
  const changesSection = (
    <div class="fb-changes-section">
      <div class="fb-changes-header">
        <span class="fb-changes-title">{t('file_browser.changes_title', { count: changesFiles.length })}</span>
        {changesRootPath && (
          <button
            class={`fb-changes-refresh is-${changesRefreshStatus}`}
            disabled={changesRefreshStatus === 'refreshing'}
            onClick={() => {
              try {
                requestSharedChanges(ws, changesRootPath!, true);
              } catch {
                setChangesRefreshStatus('error');
              }
            }}
            title={changesRefreshLabel}
            aria-label={changesRefreshLabel}
            aria-live="polite"
            aria-atomic="true"
          ><span class="fb-changes-refresh-icon" aria-hidden="true">{changesRefreshIcon}</span></button>
        )}
      </div>
      {changesFiles.length > 0 ? (
        <div class="fb-changes-list">
          {Object.entries(groupedChanges).map(([label, files]) => (
          <div key={label} class="fb-changes-group">
            <div class="fb-changes-group-label">{label} ({files.length})</div>
            {files.map((f) => {
              const name = f.path.split(/[/\\]/).pop() ?? f.path;
              const relPath = changesRootPath ? f.path.replace(changesRootPath + '/', '') : f.path;
              return (
                <div
                  key={f.path}
                  class={`fb-changes-item${previewPath === f.path ? ' active' : ''}`}
                  onClick={() => fetchPreview(f.path, true)}
                  title={f.path}
                >
                  <span class="fb-changes-item-badge">{f.code === '??' ? 'U' : f.code}</span>
                  <span class="fb-changes-item-name">{name}</span>
                  <span class="fb-changes-item-dir">{relPath !== name ? relPath.replace('/' + name, '') : ''}</span>
                  {(f.additions != null || f.deletions != null) && (
                    <span class="fb-changes-item-stats">
                      {f.additions ? <span style={{ color: '#4ade80' }}>+{f.additions}</span> : null}
                      {f.additions && f.deletions ? ' ' : ''}
                      {f.deletions ? <span style={{ color: '#f87171' }}>-{f.deletions}</span> : null}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          ))}
        </div>
      ) : (
        <div class="fb-preview-msg fb-changes-empty">{t('file_browser.no_changes')}</div>
      )}
    </div>
  );

  // Build breadcrumb segments from currentLabel (handles Unix / and Windows \ paths)
  const breadcrumbSegments = useMemo(() => {
    const label = currentLabel;
    if (label === '~' || label === '~/' || label === '~\\') {
      return [{ label: '~', path: '~' }];
    }
    if (label.startsWith('~/') || label.startsWith('~\\')) {
      const sep = label.includes('\\') ? '\\' : '/';
      const rest = label.slice(2).split(/[/\\]/).filter(Boolean);
      const segs: { label: string; path: string }[] = [{ label: '~', path: '~' }];
      for (let i = 0; i < rest.length; i++) {
        segs.push({ label: rest[i], path: '~' + sep + rest.slice(0, i + 1).join(sep) });
      }
      return segs;
    }
    // Windows drive letter path: C:\Users\... or D:/projects/...
    const driveMatch = label.match(/^([A-Za-z]:)[/\\]?/);
    if (driveMatch) {
      const sep = label.includes('\\') ? '\\' : '/';
      const root = driveMatch[1] + sep;
      const rest = label.slice(root.length).split(/[/\\]/).filter(Boolean);
      const segs: { label: string; path: string }[] = [{ label: root, path: root }];
      for (let i = 0; i < rest.length; i++) {
        segs.push({ label: rest[i], path: root + rest.slice(0, i + 1).join(sep) });
      }
      return segs;
    }
    // Unix absolute path starting with /
    if (label.startsWith('/')) {
      const parts = label.replace(/\/$/, '').split('/');
      const segs: { label: string; path: string }[] = [{ label: '/', path: '/' }];
      for (let i = 1; i < parts.length; i++) {
        if (!parts[i]) continue;
        segs.push({ label: parts[i], path: parts.slice(0, i + 1).join('/') || '/' });
      }
      return segs;
    }
    // Relative or unknown — single segment
    return [{ label, path: label }];
  }, [currentLabel]);

  // Show drive picker / home button on Windows daemons.
  // Detected by current path looking like a Windows path or label being the localized "This PC".
  const thisPcLabel = t('file_browser.this_pc');
  const looksLikeWindows = /^[A-Za-z]:[\\/]/.test(currentLabel) || currentLabel === thisPcLabel;
  const isAtDrives = currentLabel === thisPcLabel;

  const breadcrumb = (
    <div class="fb-nav-stack">
      <div class="fb-nav">
        <button class="fb-nav-btn" disabled={!canGoBack} onClick={goBack}>←</button>
        <button class="fb-nav-btn" onClick={goUp} title="Go up">⬆</button>
        {looksLikeWindows && (
          <button
            class="fb-nav-btn"
            onClick={() => navigateTo(isAtDrives ? '~' : WINDOWS_DRIVES_PATH)}
            title={isAtDrives ? t('file_browser.home') : t('file_browser.this_pc')}
          >{isAtDrives ? '🏠' : '💾'}</button>
        )}
        <div class="fb-nav-spacer" />
        <button
          class={`fb-nav-btn${error ? ' fb-nav-btn-error' : ''}`}
          title={error || 'Refresh'}
          onClick={() => { loadedRef.current.clear(); setError(null); fetchDir(currentLabel); }}
        >{error ? '⚠' : '↻'}</button>
        <label class="fb-nav-hidden-toggle" title={t('file_browser.show_hidden')}>
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden((e.target as HTMLInputElement).checked)} />
          {' ·'}
        </label>
        {includeFiles && (
          <button
            class="fb-create-btn fb-create-file-btn"
            title={t('chat.new_file')}
            aria-label={t('chat.new_file')}
            onClick={() => { setNewEntry({ kind: 'file', parentPath: currentLabel }); setNewEntryName(''); }}
          >
            <span class="fb-create-icon fb-create-icon-file" aria-hidden="true" />
            <span class="fb-create-plus" aria-hidden="true">+</span>
          </button>
        )}
        <button
          class="fb-create-btn fb-create-folder-btn"
          title={t('chat.new_folder')}
          aria-label={t('chat.new_folder')}
          onClick={() => { setNewEntry({ kind: 'folder', parentPath: currentLabel }); setNewEntryName(''); }}
        >
          <span class="fb-create-icon fb-create-icon-folder" aria-hidden="true" />
          <span class="fb-create-plus" aria-hidden="true">+</span>
        </button>
      </div>
      <div class="fb-breadcrumb-row" title={currentLabel}>
        <div class="fb-breadcrumb-segments">
          {breadcrumbSegments.map((seg, i) => {
            const isLast = i === breadcrumbSegments.length - 1;
            return (
              <>
                {i > 0 && <span class="fb-breadcrumb-sep">›</span>}
                <span
                  class={`fb-breadcrumb-seg${isLast ? ' active' : ''}`}
                  title={seg.path}
                  onClick={isLast ? undefined : () => navigateTo(seg.path)}
                >{shortenPathSegment(seg.label, isLast ? 26 : 16)}</span>
              </>
            );
          })}
        </div>
      </div>
    </div>
  );

  const newEntryDialog = newEntry !== null ? (
    <div class="fb-new-folder-bar">
      <input
        type="text"
        placeholder={newEntry.kind === 'folder' ? t('chat.new_folder_name') : t('chat.new_file_name')}
        value={newEntryName}
        onInput={(e) => setNewEntryName((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && newEntryName.trim()) requestNewEntry();
          if (e.key === 'Escape') setNewEntry(null);
        }}
        autoFocus
      />
      <button
        class="btn btn-primary"
        style={{ padding: '4px 10px', fontSize: 12 }}
        disabled={!newEntryName.trim()}
        onClick={requestNewEntry}
      >{t('chat.create')}</button>
      <button class="fb-close" onClick={() => setNewEntry(null)} style={{ fontSize: 12 }}>✕</button>
    </div>
  ) : null;

  const lightboxOverlay = lightbox ? (
    <ImageLightbox
      src={lightbox.src}
      fileName={lightbox.fileName}
      onDownload={lightbox.onDownload}
      onClose={() => setLightbox(null)}
    />
  ) : null;

  if (layout === 'panel') {
    const tabs = changesRootPath ? (
      <div class="fb-panel-tabs">
        <button class={`fb-panel-tab${panelView === 'files' ? ' active' : ''}`} onClick={() => setPanelView('files')}>{t('file_browser.tab_files')}</button>
        <button class={`fb-panel-tab${panelView === 'changes' ? ' active' : ''}`} onClick={() => setPanelView('changes')}>
          {t('file_browser.tab_changes')}
          {changesFiles.length > 0 && <span class="fb-panel-tab-badge">{changesFiles.length}</span>}
        </button>
      </div>
    ) : null;

    if (panelView === 'changes' && changesRootPath) {
      return (
        <>
          {lightboxOverlay}
          {contextMenuView}
          <div class="fb-panel">
            {tabs}
            {previewPane ? (
              <div class="fb-body fb-body-split">
                <div class="fb-tree fb-tree-split fb-changes-tree">{changesSection}</div>
                {previewPane}
              </div>
            ) : (
              <div class="fb-body">{changesSection ?? <div class="fb-preview-msg">{t('file_browser.no_changes')}</div>}</div>
            )}
          </div>
        </>
      );
    }

    return (
      <>
        {lightboxOverlay}
        {contextMenuView}
        <div class="fb-panel">
          {tabs}
          {breadcrumb}
          {newEntryDialog}
          <div class={`fb-body${hasPreview ? ' fb-body-split' : ''}`}>
            <div class={`fb-files-and-changes${hasPreview ? ' fb-tree-split' : ''}`} style={hasPreview && treeWidth ? { flex: 'none', width: treeWidth } : undefined}>
              {tree}
            </div>
            {hasPreview && (
              <div
                class="fb-resize-handle"
                onMouseDown={(e) => {
                  e.preventDefault();
                  const startX = e.clientX;
                  const startW = treeWidth || 240;
                  const onMove = (ev: MouseEvent) => setTreeWidth(Math.max(120, Math.min(600, startW + ev.clientX - startX)));
                  const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
                  document.addEventListener('mousemove', onMove);
                  document.addEventListener('mouseup', onUp);
                }}
              />
            )}
            {previewPane}
          </div>
          {footer}
        </div>
      </>
    );
  }

  return (
    <>
      {lightboxOverlay}
      {contextMenuView}
      <div class="fb-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
        <div class={`fb-modal${hasPreview ? ' fb-modal-wide' : ''}`} onClick={(e) => e.stopPropagation()}>
          <div class="fb-header">
            <span>{title}</span>
            <button class="fb-close" onClick={onClose}>✕</button>
          </div>
          {breadcrumb}
          {newEntryDialog}
          <div class={`fb-body${hasPreview ? ' fb-body-split' : ''}`}>
            {tree}
            {previewPane}
          </div>
          {footer}
        </div>
      </div>
    </>
  );
}

// ── Tree node ─────────────────────────────────────────────────────────────────

function FsTreeNode({
  node,
  expandedPaths,
  selectedPaths,
  alreadySet,
  mode,
  showHidden,
  modifiedFiles,
  onToggleExpand,
  onSelect,
  onPreview,
  onContextMenu,
  previewPath,
  depth = 0,
}: {
  node: FsNode;
  expandedPaths: Set<string>;
  selectedPaths: Set<string>;
  alreadySet: Set<string>;
  mode: FileBrowserMode;
  showHidden: boolean;
  modifiedFiles: Map<string, string>;
  onToggleExpand: (id: string) => void;
  onSelect: (id: string, isDir: boolean) => void;
  onPreview: (id: string) => void;
  onContextMenu: (node: FsNode, event: MouseEvent) => void;
  previewPath: string | null;
  depth?: number;
}) {
  const isExpanded = expandedPaths.has(node.id);
  const isSelected = selectedPaths.has(node.id);
  const isAlready = alreadySet.has(node.id);
  const isMulti = mode === 'file-multi';
  const isDisabled = mode === 'dir-only' && !node.isDir;
  const isPreviewing = previewPath === node.id;
  const gitCode = modifiedFiles.get(node.id);
  const gitClass = gitCode ? gitStatusClass(gitCode) : null;

  if (!showHidden && node.hidden) return null;

  return (
    <div>
      <div
        class={`fb-node${isSelected ? ' selected' : ''}${isAlready ? ' already' : ''}${isDisabled ? ' disabled' : ''}${isPreviewing ? ' previewing' : ''}${gitClass ? ` git-${gitClass}` : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => {
          if (!isMulti && !isDisabled) onSelect(node.id, node.isDir);
          if (node.isDir) onToggleExpand(node.id);
          if (!node.isDir && mode !== 'dir-only') onPreview(node.id);
        }}
        onContextMenu={(event) => {
          if (depth === 0) return;
          onContextMenu(node, event);
        }}
      >
        {isMulti && (
          <input
            type="checkbox"
            class="fb-node-check"
            checked={isSelected}
            disabled={isDisabled}
            onClick={(e) => e.stopPropagation()}
            onChange={() => { if (!isDisabled) onSelect(node.id, node.isDir); }}
          />
        )}
        <span class="fb-node-expand">
          {node.isDir ? (isExpanded ? '▾' : '▸') : ' '}
        </span>
        <span class="fb-node-icon">
          {node.isDir
            ? (node.isLoading ? <span class="fb-icon-spin">⟳</span> : (isExpanded ? '📂' : '📁'))
            : '📄'}
        </span>
        <span class="fb-node-name">{node.name}</span>
        {gitCode && gitClass && <span class={`fb-node-git-badge git-badge-${gitClass}`} title={`git: ${gitCode}`}>{gitStatusBadge(gitCode)}</span>}
        {isAlready && <span class="fb-node-badge">↑</span>}
      </div>
      {node.isDir && isExpanded && node.children && (
        <>
          {node.children.length === 0 && !node.isLoading && (
            <div class="fb-node-empty" style={{ paddingLeft: 8 + (depth + 1) * 16 }}>—</div>
          )}
          {node.children.map((child) => (
            <FsTreeNode
              key={child.id}
              node={child}
              expandedPaths={expandedPaths}
              selectedPaths={selectedPaths}
              alreadySet={alreadySet}
              mode={mode}
              showHidden={showHidden}
              modifiedFiles={modifiedFiles}
              onToggleExpand={onToggleExpand}
              onSelect={onSelect}
              onPreview={onPreview}
              onContextMenu={onContextMenu}
              previewPath={previewPath}
              depth={depth + 1}
            />
          ))}
        </>
      )}
    </div>
  );
}
