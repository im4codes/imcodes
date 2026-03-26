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
import { useState, useRef, useEffect, useCallback, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { WsClient, ServerMessage } from '../ws-client.js';
import hljs from 'highlight.js/lib/core';
import hljsBash from 'highlight.js/lib/languages/bash';
import hljsC from 'highlight.js/lib/languages/c';
import hljsCpp from 'highlight.js/lib/languages/cpp';
import hljsCss from 'highlight.js/lib/languages/css';
import hljsDockerfile from 'highlight.js/lib/languages/dockerfile';
import hljsGo from 'highlight.js/lib/languages/go';
import hljsJava from 'highlight.js/lib/languages/java';
import hljsJs from 'highlight.js/lib/languages/javascript';
import hljsJson from 'highlight.js/lib/languages/json';
import hljsKotlin from 'highlight.js/lib/languages/kotlin';
import hljsLua from 'highlight.js/lib/languages/lua';
import hljsPython from 'highlight.js/lib/languages/python';
import hljsRuby from 'highlight.js/lib/languages/ruby';
import hljsRust from 'highlight.js/lib/languages/rust';
import hljsScala from 'highlight.js/lib/languages/scala';
import hljsSql from 'highlight.js/lib/languages/sql';
import hljsSwift from 'highlight.js/lib/languages/swift';
import hljsTs from 'highlight.js/lib/languages/typescript';
import hljsXml from 'highlight.js/lib/languages/xml';
import hljsYaml from 'highlight.js/lib/languages/yaml';
import { marked } from 'marked';
import { downloadAttachment } from '../api.js';

// Register languages
hljs.registerLanguage('bash', hljsBash);
hljs.registerLanguage('c', hljsC);
hljs.registerLanguage('cpp', hljsCpp);
hljs.registerLanguage('css', hljsCss);
hljs.registerLanguage('dockerfile', hljsDockerfile);
hljs.registerLanguage('go', hljsGo);
hljs.registerLanguage('java', hljsJava);
hljs.registerLanguage('javascript', hljsJs);
hljs.registerLanguage('json', hljsJson);
hljs.registerLanguage('kotlin', hljsKotlin);
hljs.registerLanguage('lua', hljsLua);
hljs.registerLanguage('python', hljsPython);
hljs.registerLanguage('ruby', hljsRuby);
hljs.registerLanguage('rust', hljsRust);
hljs.registerLanguage('scala', hljsScala);
hljs.registerLanguage('sql', hljsSql);
hljs.registerLanguage('swift', hljsSwift);
hljs.registerLanguage('typescript', hljsTs);
hljs.registerLanguage('xml', hljsXml);
hljs.registerLanguage('yaml', hljsYaml);

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  css: 'css',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  rs: 'rust',
  go: 'go',
  java: 'java',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', h: 'cpp', hpp: 'cpp',
  c: 'c',
  cs: 'javascript', // csharp not registered, fallback
  kt: 'kotlin', kts: 'kotlin',
  sql: 'sql',
  dockerfile: 'dockerfile',
  lua: 'lua',
  scala: 'scala',
  swift: 'swift',
};

function highlightCode(content: string, filename: string): { html: string; isMarkdown: boolean } {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'mdx') {
    return { html: marked(content) as string, isMarkdown: true };
  }
  const lang = EXT_LANG[ext];
  if (lang) {
    try {
      const result = hljs.highlight(content, { language: lang });
      return { html: result.value, isMarkdown: false };
    } catch {
      // fallback
    }
  }
  // Auto-detect for unknown extensions
  try {
    const result = hljs.highlightAuto(content.slice(0, 8192)); // limit for performance
    return { html: result.value, isMarkdown: false };
  } catch {
    return { html: escapeHtml(content), isMarkdown: false };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render a unified diff as a split (side-by-side) HTML table, GitHub-style */
function renderDiff(diff: string): string {
  const lines = diff.split('\n');
  let oldLine = 0;
  let newLine = 0;

  // Collect raw parsed lines
  type RawLine = { kind: 'file' | 'hunk' | 'add' | 'del' | 'ctx'; text: string; oldLn?: number; newLn?: number };
  const parsed: RawLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === lines.length - 1 && line === '') continue;
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('old mode') || line.startsWith('new mode')) {
      parsed.push({ kind: 'file', text: line });
    } else if (line.startsWith('@@')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldLine = parseInt(m[1]) - 1; newLine = parseInt(m[2]) - 1; }
      parsed.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('+')) {
      newLine++;
      parsed.push({ kind: 'add', text: line.slice(1), newLn: newLine });
    } else if (line.startsWith('-')) {
      oldLine++;
      parsed.push({ kind: 'del', text: line.slice(1), oldLn: oldLine });
    } else {
      oldLine++; newLine++;
      parsed.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldLn: oldLine, newLn: newLine });
    }
  }

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
      const ln = p.oldLn ?? '';
      rows.push(`<tr class="diff-row-ctx"><td class="diff-ln">${ln}</td><td class="diff-cell diff-ctx">${escapeHtml(p.text)}</td><td class="diff-ln">${p.newLn ?? ''}</td><td class="diff-cell diff-ctx">${escapeHtml(p.text)}</td></tr>`);
      i++;
    } else if (p.kind === 'del') {
      // Collect consecutive del/add pairs
      const dels: RawLine[] = [];
      const adds: RawLine[] = [];
      while (i < parsed.length && parsed[i].kind === 'del') { dels.push(parsed[i]); i++; }
      while (i < parsed.length && parsed[i].kind === 'add') { adds.push(parsed[i]); i++; }
      const maxLen = Math.max(dels.length, adds.length);
      for (let j = 0; j < maxLen; j++) {
        const d = dels[j];
        const a = adds[j];
        const oldLn = d ? String(d.oldLn ?? '') : '';
        const newLn = a ? String(a.newLn ?? '') : '';
        const oldCode = d ? escapeHtml(d.text) : '';
        const newCode = a ? escapeHtml(a.text) : '';
        const leftCls = d ? 'diff-cell diff-del' : 'diff-cell diff-empty';
        const rightCls = a ? 'diff-cell diff-add' : 'diff-cell diff-empty';
        rows.push(`<tr class="diff-row-change"><td class="diff-ln diff-ln-del">${oldLn}</td><td class="${leftCls}">${oldCode}</td><td class="diff-ln diff-ln-add">${newLn}</td><td class="${rightCls}">${newCode}</td></tr>`);
      }
    } else if (p.kind === 'add') {
      rows.push(`<tr class="diff-row-change"><td class="diff-ln"></td><td class="diff-cell diff-empty"></td><td class="diff-ln diff-ln-add">${p.newLn ?? ''}</td><td class="diff-cell diff-add">${escapeHtml(p.text)}</td></tr>`);
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
  onConfirm: (paths: string[]) => void;
  onClose?: () => void;
  /** When set, file clicks open an external preview (e.g. floating window) instead of inline split */
  onPreviewFile?: (path: string) => void;
  /** Default panel tab — 'files' or 'changes'. Default: 'files' */
  defaultTab?: 'files' | 'changes';
}

type FsNode = {
  id: string;        // absolute resolved path
  name: string;
  isDir: boolean;
  hidden?: boolean;
  children?: FsNode[];  // undefined = leaf/file; [] = unloaded dir; [...] = loaded
  isLoading?: boolean;
};

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; path: string }
  | { status: 'ok'; path: string; content: string; html: string; isMarkdown: boolean; diff?: string; diffHtml?: string; downloadId?: string }
  | { status: 'image'; path: string; dataUrl: string; downloadId?: string }
  | { status: 'error'; path: string; error: string; downloadId?: string };

const REQUEST_TIMEOUT_MS = 5_000;

function updateNode(nodes: FsNode[], targetId: string, patch: Partial<FsNode>): FsNode[] {
  return nodes.map((n) => {
    if (n.id === targetId) return { ...n, ...patch };
    if (n.children?.length) return { ...n, children: updateNode(n.children, targetId, patch) };
    return n;
  });
}


export function FileBrowser({
  ws,
  mode,
  layout,
  initialPath,
  highlightPath,
  autoPreviewPath,
  alreadyInserted = [],
  hideFooter = false,
  changesRootPath,
  refreshTrigger,
  serverId,
  onConfirm,
  onClose,
  onPreviewFile,
  defaultTab = 'files',
}: FileBrowserProps) {
  const { t } = useTranslation();
  const includeFiles = mode !== 'dir-only';
  const isMulti = mode === 'file-multi';

  const startPath = initialPath || '~';
  const [data, setData] = useState<FsNode[]>([
    { id: startPath, name: startPath, isDir: true, children: [] },
  ]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(
    () => new Set(highlightPath ? [highlightPath] : []),
  );
  const [currentLabel, setCurrentLabel] = useState(startPath);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const [showDiff, setShowDiff] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [modifiedFiles, setModifiedFiles] = useState<Map<string, string>>(new Map()); // path → git code
  // Panel view: 'files' shows tree + changes section; 'changes' shows only changed files
  const [panelView, setPanelView] = useState<'files' | 'changes'>(defaultTab);
  const [changesFiles, setChangesFiles] = useState<Array<{ path: string; code: string; additions?: number; deletions?: number }>>([]);
  const pendingChangesRef = useRef(new Set<string>()); // all in-flight changesRootPath git status requestIds

  const loadedRef = useRef(new Set<string>());
  const pendingRef = useRef(new Map<string, string>()); // requestId → nodeId
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingReadRef = useRef(new Map<string, string>()); // requestId → filePath
  const pendingGitStatusRef = useRef(new Map<string, string>()); // requestId → dirPath
  const pendingGitDiffRef = useRef(new Map<string, string>()); // requestId → filePath
  const mountedRef = useRef(true);

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
      pendingChangesRef.current.clear();
      if (pendingChangesTimerRef.current) clearTimeout(pendingChangesTimerRef.current);
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
    };
  }, []);

  // Listen for fs.ls_response and fs.read_response
  useEffect(() => {
    return ws.onMessage((msg: ServerMessage) => {
      if (!mountedRef.current) return;

      if (msg.type === 'fs.ls_response') {
        const nodeId = pendingRef.current.get(msg.requestId);
        if (!nodeId) return;
        pendingRef.current.delete(msg.requestId);

        const timer = timersRef.current.get(msg.requestId);
        if (timer) { clearTimeout(timer); timersRef.current.delete(msg.requestId); }

        if (msg.status === 'error') {
          setError(msg.error ?? 'Unknown error');
          setData((prev) => updateNode(prev, nodeId, { isLoading: false }));
          return;
        }

        const resolvedParent = msg.resolvedPath ?? nodeId;
        const entries = msg.entries ?? [];
        const children: FsNode[] = entries
          .filter((e) => showHidden || !e.hidden)
          .map((e) => ({
            id: `${resolvedParent}/${e.name}`,
            name: e.name,
            isDir: e.isDir,
            hidden: e.hidden,
            children: e.isDir ? [] : undefined,
          }));

        loadedRef.current.add(nodeId);
        if (resolvedParent !== nodeId) loadedRef.current.add(resolvedParent);

        setData((prev) => updateNode(prev, nodeId, { id: resolvedParent, name: resolvedParent.split('/').pop() || resolvedParent, children, isLoading: false }));
        setCurrentLabel(resolvedParent);
        setError(null);

        // If highlightPath is under this dir, auto-expand
        if (highlightPath && highlightPath.startsWith(resolvedParent + '/')) {
          const nextSegment = highlightPath.slice(resolvedParent.length + 1).split('/')[0];
          const child = children.find((c) => c.name === nextSegment && c.isDir);
          if (child) setTimeout(() => fetchDir(child.id), 0);
        }
        return;
      }

      if (msg.type === 'fs.read_response') {
        const filePath = pendingReadRef.current.get(msg.requestId);
        if (!filePath) return;
        pendingReadRef.current.delete(msg.requestId);

        const dlId = msg.downloadId;

        if (msg.status === 'error') {
          const errKey = msg.error === 'file_too_large' ? 'file_browser.preview_too_large'
            : msg.error === 'forbidden_path' ? 'file_browser.preview_error'
            : 'file_browser.preview_error';
          setPreview({ status: 'error', path: filePath, error: t(errKey), downloadId: dlId });
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

        const filename = filePath.split('/').pop() ?? '';
        const { html, isMarkdown } = highlightCode(content, filename);
        setPreview((prev) => {
          // Merge diff if already fetched
          const existing = prev.status === 'ok' && prev.path === filePath ? prev : null;
          return { status: 'ok', path: filePath, content, html, isMarkdown, diff: existing?.diff, diffHtml: existing?.diffHtml, downloadId: dlId };
        });
        return;
      }

      if (msg.type === 'fs.git_status_response') {
        // Check if this is a changesRootPath request
        if (pendingChangesRef.current.has(msg.requestId)) {
          pendingChangesRef.current.delete(msg.requestId);
          if (msg.status === 'ok' && msg.files) {
            setChangesFiles(msg.files as Array<{ path: string; code: string; additions?: number; deletions?: number }>);
            // Also update modifiedFiles map for tree indicators
            setModifiedFiles((prev) => {
              const next = new Map(prev);
              for (const f of msg.files!) next.set(f.path, f.code);
              return next;
            });
          }
          return;
        }
        const dirPath = pendingGitStatusRef.current.get(msg.requestId);
        if (!dirPath) return;
        pendingGitStatusRef.current.delete(msg.requestId);
        if (msg.status === 'ok' && msg.files) {
          setModifiedFiles((prev) => {
            const next = new Map(prev);
            // Remove stale entries for this dir
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
        const filePath = pendingGitDiffRef.current.get(msg.requestId);
        if (!filePath) return;
        pendingGitDiffRef.current.delete(msg.requestId);
        if (msg.status === 'ok') {
          const diff = msg.diff ?? '';
          const diffHtml = diff ? renderDiff(diff) : '';
          setPreview((prev) => {
            if (prev.status === 'ok' && prev.path === filePath) {
              return { ...prev, diff, diffHtml };
            }
            return prev;
          });
          // Don't auto-switch to diff view — preserve user's current view choice
        }
        return;
      }
    });
  }, [ws, showHidden, highlightPath, t]);

  const fetchDir = useCallback((nodePath: string) => {
    if (loadedRef.current.has(nodePath)) return;
    const inFlight = [...pendingRef.current.values()].includes(nodePath);
    if (inFlight) return;

    setData((prev) => updateNode(prev, nodePath, { isLoading: true }));
    const requestId = ws.fsListDir(nodePath, includeFiles, !!serverId);
    pendingRef.current.set(requestId, nodePath);
    // Fetch git status for this directory
    const gitId = ws.fsGitStatus(nodePath);
    pendingGitStatusRef.current.set(gitId, nodePath);

    const timer = setTimeout(() => {
      if (!mountedRef.current) return;
      if (pendingRef.current.has(requestId)) {
        pendingRef.current.delete(requestId);
        timersRef.current.delete(requestId);
        setData((prev) => updateNode(prev, nodePath, { isLoading: false }));
        setError(t('file_browser.timeout'));
      }
    }, REQUEST_TIMEOUT_MS);
    timersRef.current.set(requestId, timer);
  }, [ws, includeFiles, t]);

  const fetchPreview = useCallback((filePath: string) => {
    if (onPreviewFile) { onPreviewFile(filePath); return; }
    setPreview({ status: 'loading', path: filePath });
    setShowDiff(false);
    const requestId = ws.fsReadFile(filePath);
    pendingReadRef.current.set(requestId, filePath);
    // Also fetch git diff in parallel
    const diffId = ws.fsGitDiff(filePath);
    pendingGitDiffRef.current.set(diffId, filePath);
  }, [ws]);

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set([startPath]));

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

  const goBack = useCallback(() => {
    if (historyIdxRef.current <= 0) return;
    historyIdxRef.current -= 1;
    setCanGoBack(historyIdxRef.current > 0);
    jumpTo(historyRef.current[historyIdxRef.current]);
  }, [jumpTo]);

  const goUp = useCallback(() => {
    const parts = currentLabel.replace(/\/$/, '').split('/');
    if (parts.length > 1) {
      const parent = parts.slice(0, -1).join('/') || '/';
      navigateTo(parent);
    }
  }, [currentLabel, navigateTo]);

  // Load root on mount
  useEffect(() => { fetchDir(startPath); }, [startPath]);

  // Auto-preview file on open (e.g. when clicking a path link in chat)
  useEffect(() => {
    if (autoPreviewPath) fetchPreview(autoPreviewPath);
  }, [autoPreviewPath, fetchPreview]);

  // Auto-refresh preview content every 5s when a file is being previewed
  useEffect(() => {
    if (preview.status !== 'ok' && preview.status !== 'image') return;
    if (onPreviewFile) return; // external preview — don't poll here
    const path = (preview as { path: string }).path;
    const timer = setInterval(() => {
      const reqId = ws.fsReadFile(path);
      pendingReadRef.current.set(reqId, path);
      // Also refresh diff
      const diffId = ws.fsGitDiff(path);
      pendingGitDiffRef.current.set(diffId, path);
    }, 5000);
    return () => clearInterval(timer);
  }, [preview.status, (preview as any).path, ws, onPreviewFile]);

  // Rate-limited git status refresh for the changes panel
  const CHANGES_RATE_LIMIT_MS = 5_000;
  const lastChangesRefreshRef = useRef(0);
  const pendingChangesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshChanges = useCallback(() => {
    if (!changesRootPath) return;
    const now = Date.now();
    const elapsed = now - lastChangesRefreshRef.current;
    if (elapsed >= CHANGES_RATE_LIMIT_MS) {
      lastChangesRefreshRef.current = now;
      const requestId = ws.fsGitStatus(changesRootPath);
      pendingChangesRef.current.add(requestId);
    } else {
      // Schedule for when rate limit clears
      if (pendingChangesTimerRef.current) clearTimeout(pendingChangesTimerRef.current);
      pendingChangesTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        lastChangesRefreshRef.current = Date.now();
        const requestId = ws.fsGitStatus(changesRootPath);
        pendingChangesRef.current.add(requestId);
      }, CHANGES_RATE_LIMIT_MS - elapsed);
    }
  }, [changesRootPath, ws]);

  // Initial fetch on mount
  useEffect(() => {
    if (!changesRootPath) return;
    refreshChanges();
  }, [changesRootPath, ws]); // eslint-disable-line react-hooks/exhaustive-deps

  // 30s polling
  useEffect(() => {
    if (!changesRootPath) return;
    const id = setInterval(() => {
      if (mountedRef.current) refreshChanges();
    }, 30_000);
    return () => clearInterval(id);
  }, [changesRootPath, refreshChanges]);

  // External refresh trigger (e.g. from tool.call events in ChatView)
  useEffect(() => {
    if (refreshTrigger === undefined || refreshTrigger === 0) return;
    refreshChanges();
  }, [refreshTrigger, refreshChanges]);

  // Reload tree when showHidden changes
  useEffect(() => {
    loadedRef.current.clear();
    setData([{ id: startPath, name: startPath, isDir: true, children: [] }]);
    fetchDir(startPath);
  }, [showHidden]);

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
      const path = nodeId.split('/').pop() || nodeId;
      void path;
      setCurrentLabel(nodeId);
    }
  }, [mode, isMulti]);

  const handlePreview = useCallback((filePath: string) => {
    if (preview.status !== 'loading' || (preview as { path: string }).path !== filePath) {
      fetchPreview(filePath);
    }
  }, [fetchPreview, preview]);

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
  const hasPreview = mode !== 'dir-only' && preview.status !== 'idle';

  const previewPath = preview.status !== 'idle' ? (preview as { path: string }).path : null;

  const tree = (
    <div class={`fb-tree${hasPreview ? ' fb-tree-split' : ''}`}>
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
          previewPath={previewPath}
        />
      ))}
    </div>
  );

  const hasDiff = preview.status === 'ok' && !!preview.diff;

  const previewPane = hasPreview ? (
    <div class="fb-preview">
      <div class="fb-preview-header">
        <button class="fb-preview-back" onClick={() => setPreview({ status: 'idle' })}>←</button>
        <span class="fb-preview-name">{previewPath!.split('/').pop()}</span>
        {hasDiff && (
          <button
            class={`fb-diff-toggle${showDiff ? ' active' : ''}`}
            onClick={() => setShowDiff((v) => !v)}
            title="Toggle diff view"
          >
            {showDiff ? t('file_browser.view_source') : t('file_browser.view_diff')}
          </button>
        )}
        {(preview.status === 'ok' || preview.status === 'image' || preview.status === 'error') && serverId && preview.downloadId && (
          <button
            class="fb-diff-toggle"
            title={downloadError || t('upload.download_file')}
            style={downloadError ? { color: '#ef4444' } : undefined}
            onClick={() => {
              setDownloadError(null);
              void downloadAttachment(serverId, preview.downloadId!).catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes('daemon_offline')) setDownloadError(t('upload.daemon_offline'));
                else if (msg.includes('410') || msg.includes('expired')) setDownloadError(t('upload.download_expired'));
                else setDownloadError(t('upload.upload_failed'));
                setTimeout(() => setDownloadError(null), 5000);
              });
            }}
          >
            {downloadError || t('upload.download_file')}
          </button>
        )}
        <button class="fb-close" onClick={() => setPreview({ status: 'idle' })}>✕</button>
      </div>
      <div class="fb-preview-content">
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
            <img src={preview.dataUrl} alt={preview.path.split('/').pop() ?? ''} onClick={() => setLightbox(preview.dataUrl)} style={{ cursor: 'zoom-in' }} />
          </div>
        )}
        {preview.status === 'ok' && !showDiff && (
          preview.isMarkdown
            ? <div class="fb-preview-md" dangerouslySetInnerHTML={{ __html: preview.html }} />
            : <pre class="fb-preview-code hljs"><code dangerouslySetInnerHTML={{ __html: preview.html }} /></pre>
        )}
        {preview.status === 'ok' && showDiff && preview.diffHtml && (
          <div class="fb-diff" dangerouslySetInnerHTML={{ __html: preview.diffHtml }} />
        )}
      </div>
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

  const changesSection = changesFiles.length > 0 ? (
    <div class="fb-changes-section">
      <div class="fb-changes-header">
        <span class="fb-changes-title">{t('file_browser.changes_title', { count: changesFiles.length })}</span>
        {changesRootPath && (
          <button class="fb-changes-refresh" onClick={() => {
            const requestId = ws.fsGitStatus(changesRootPath!);
            pendingChangesRef.current.add(requestId);
          }} title="Refresh">↻</button>
        )}
      </div>
      <div class="fb-changes-list">
        {Object.entries(groupedChanges).map(([label, files]) => (
          <div key={label} class="fb-changes-group">
            <div class="fb-changes-group-label">{label} ({files.length})</div>
            {files.map((f) => {
              const name = f.path.split('/').pop() ?? f.path;
              const relPath = changesRootPath ? f.path.replace(changesRootPath + '/', '') : f.path;
              return (
                <div
                  key={f.path}
                  class={`fb-changes-item${previewPath === f.path ? ' active' : ''}`}
                  onClick={() => fetchPreview(f.path)}
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
    </div>
  ) : null;

  // Build breadcrumb segments from currentLabel
  const breadcrumbSegments = useMemo(() => {
    const label = currentLabel;
    if (label === '~' || (!label.startsWith('/') && !label.startsWith('~'))) {
      // Treat as single root segment
      return [{ label, path: label }];
    }
    if (label.startsWith('~/')) {
      const rest = label.slice(2).split('/').filter(Boolean);
      const segs: { label: string; path: string }[] = [{ label: '~', path: '~' }];
      for (let i = 0; i < rest.length; i++) {
        segs.push({ label: rest[i], path: '~/' + rest.slice(0, i + 1).join('/') });
      }
      return segs;
    }
    // Absolute path starting with /
    const parts = label.replace(/\/$/, '').split('/');
    // parts[0] === '' for absolute paths
    const segs: { label: string; path: string }[] = [{ label: '/', path: '/' }];
    for (let i = 1; i < parts.length; i++) {
      if (!parts[i]) continue;
      segs.push({ label: parts[i], path: parts.slice(0, i + 1).join('/') || '/' });
    }
    return segs;
  }, [currentLabel]);

  const breadcrumb = (
    <div class="fb-nav">
      <button class="fb-nav-btn" disabled={!canGoBack} onClick={goBack}>←</button>
      <button class="fb-nav-btn" onClick={goUp} title="Go up">⬆</button>
      <div class="fb-breadcrumb-segments">
        {breadcrumbSegments.map((seg, i) => {
          const isLast = i === breadcrumbSegments.length - 1;
          return (
            <>
              {i > 0 && <span class="fb-breadcrumb-sep">›</span>}
              <span
                class={`fb-breadcrumb-seg${isLast ? ' active' : ''}`}
                onClick={isLast ? undefined : () => navigateTo(seg.path)}
              >{seg.label}</span>
            </>
          );
        })}
      </div>
      {error && <span class="fb-error-inline">{error}</span>}
      <label class="fb-nav-hidden-toggle" title={t('file_browser.show_hidden')}>
        <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden((e.target as HTMLInputElement).checked)} />
        {' ·'}
      </label>
      <button
        class="fb-new-folder-btn"
        title={t('chat.new_folder')}
        onClick={() => { setNewFolderParent(currentLabel); setNewFolderName(''); }}
      >+</button>
    </div>
  );

  const newFolderDialog = newFolderParent !== null ? (
    <div class="fb-new-folder-bar">
      <input
        type="text"
        placeholder={t('chat.new_folder_name')}
        value={newFolderName}
        onInput={(e) => setNewFolderName((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && newFolderName.trim()) {
            const fullPath = `${newFolderParent}/${newFolderName.trim()}`;
            ws.fsMkdir(fullPath);
            // Refresh parent after a short delay
            setTimeout(() => {
              loadedRef.current.delete(newFolderParent!);
              toggleExpand(newFolderParent!);
              toggleExpand(newFolderParent!);
            }, 300);
            setNewFolderParent(null);
          }
          if (e.key === 'Escape') setNewFolderParent(null);
        }}
        autoFocus
      />
      <button
        class="btn btn-primary"
        style={{ padding: '4px 10px', fontSize: 12 }}
        disabled={!newFolderName.trim()}
        onClick={() => {
          if (!newFolderName.trim()) return;
          const fullPath = `${newFolderParent}/${newFolderName.trim()}`;
          ws.fsMkdir(fullPath);
          setTimeout(() => {
            loadedRef.current.delete(newFolderParent!);
            toggleExpand(newFolderParent!);
            toggleExpand(newFolderParent!);
          }, 300);
          setNewFolderParent(null);
        }}
      >{t('chat.create')}</button>
      <button class="fb-close" onClick={() => setNewFolderParent(null)} style={{ fontSize: 12 }}>✕</button>
    </div>
  ) : null;

  const lightboxOverlay = lightbox ? (
    <div class="fb-lightbox" onClick={() => setLightbox(null)}>
      <img src={lightbox} onClick={(e) => e.stopPropagation()} />
      <button class="fb-lightbox-close" onClick={() => setLightbox(null)}>✕</button>
    </div>
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
          <div class="fb-panel">
            {tabs}
            {previewPane ? (
              <div class="fb-body fb-body-split">
                <div class="fb-tree fb-tree-split">{changesSection}</div>
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
        <div class="fb-panel">
          {tabs}
          {breadcrumb}
          {newFolderDialog}
          <div class={`fb-body${hasPreview ? ' fb-body-split' : ''}${changesRootPath && changesFiles.length > 0 ? ' fb-body-with-changes' : ''}`}>
            <div class={`fb-files-and-changes${hasPreview ? ' fb-tree-split' : ''}`}>
              {tree}
              {changesSection}
            </div>
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
      <div class="fb-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
        <div class={`fb-modal${hasPreview ? ' fb-modal-wide' : ''}`} onClick={(e) => e.stopPropagation()}>
          <div class="fb-header">
            <span>{title}</span>
            <button class="fb-close" onClick={onClose}>✕</button>
          </div>
          {breadcrumb}
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

  if (!showHidden && node.hidden) return null;

  return (
    <div>
      <div
        class={`fb-node${isSelected ? ' selected' : ''}${isAlready ? ' already' : ''}${isDisabled ? ' disabled' : ''}${isPreviewing ? ' previewing' : ''}${gitCode ? ` git-${gitCode === '??' ? 'untracked' : gitCode === 'D' ? 'deleted' : gitCode === 'A' ? 'added' : 'modified'}` : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => {
          if (!isMulti && !isDisabled) onSelect(node.id, node.isDir);
          if (node.isDir) onToggleExpand(node.id);
          if (!node.isDir && mode !== 'dir-only') onPreview(node.id);
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
        {gitCode && <span class={`fb-node-git-badge git-badge-${gitCode === '??' ? 'untracked' : gitCode === 'D' ? 'deleted' : gitCode === 'A' ? 'added' : 'modified'}`} title={`git: ${gitCode}`}>{gitCode === '??' ? 'U' : gitCode}</span>}
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
              previewPath={previewPath}
              depth={depth + 1}
            />
          ))}
        </>
      )}
    </div>
  );
}
