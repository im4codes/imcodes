/**
 * FileEditor — inline text editor for FileBrowser with save + conflict detection.
 * Uses CodeMirror 6 for syntax highlighting, line numbers, and code editing.
 * Extracted from FileBrowser to keep component weight manageable for tests.
 */
import { useState, useCallback, useEffect, useRef } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { WsClient, ServerMessage } from '../ws-client.js';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { sql } from '@codemirror/lang-sql';
import { php } from '@codemirror/lang-php';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { sass } from '@codemirror/lang-sass';
import { less } from '@codemirror/lang-less';
import { wast } from '@codemirror/lang-wast';
import { oneDark } from '@codemirror/theme-one-dark';

export interface FileEditorProps {
  ws: WsClient;
  path: string;
  content: string;
  mtime: number | undefined;
  onClose: () => void;
  /** Called after successful save with new mtime */
  onSaved: (newMtime: number) => void;
  /** Subscribe to WS messages — returns unsubscribe fn */
  onMessage: (handler: (msg: ServerMessage) => void) => (() => void);
  /** Notify parent when dirty state changes */
  onDirtyChange?: (dirty: boolean) => void;
}

/** Detect CodeMirror language extension from file path */
function getLanguageExtension(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts': case 'tsx': return javascript({ typescript: true, jsx: ext === 'tsx' });
    case 'js': case 'jsx': case 'mjs': case 'cjs': return javascript({ jsx: ext === 'jsx' });
    case 'py': case 'pyi': case 'pyw': return python();
    case 'json': case 'jsonc': case 'json5': return json();
    case 'html': case 'htm': return html();
    case 'css': return css();
    case 'md': case 'mdx': case 'markdown': return markdown();
    case 'java': case 'kt': case 'kts': return java();
    case 'c': case 'h': case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'hxx': case 'hh': return cpp();
    case 'rs': return rust();
    case 'go': return go();
    case 'sql': case 'sqlite': case 'ddl': return sql();
    case 'php': return php();
    case 'xml': case 'svg': case 'xsl': case 'xsd': case 'wsdl': case 'plist': return xml();
    case 'yaml': case 'yml': return yaml();
    case 'sass': case 'scss': return sass({ indented: ext === 'sass' });
    case 'less': return less();
    case 'wat': case 'wast': return wast();
    default: return null;
  }
}

export function FileEditor({ ws, path, content, mtime, onClose, onSaved, onMessage, onDirtyChange }: FileEditorProps) {
  const { t } = useTranslation();
  const [originalMtime, setOriginalMtime] = useState(mtime);
  const [isDirty, setIsDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error' | 'timeout'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const pendingWriteRef = useRef(new Map<string, string>());
  // Track latest content from FileEditorContent for save
  const editContentRef = useRef(content);

  // Listen for fs.write_response
  useEffect(() => {
    return onMessage((msg) => {
      if (msg.type !== 'fs.write_response') return;
      const filePath = pendingWriteRef.current.get(msg.requestId);
      if (!filePath) return;
      pendingWriteRef.current.delete(msg.requestId);

      if (msg.status === 'ok') {
        setOriginalMtime(msg.mtime);
        setIsDirty(false);
        setSaveStatus('success');
        setSaveError(null);
        if (msg.mtime) onSaved(msg.mtime);
        setTimeout(() => setSaveStatus((s) => s === 'success' ? 'idle' : s), 2000);
      } else if (msg.status === 'conflict') {
        setSaveStatus('idle');
        // Conflict handled by FileEditorContent
      } else {
        setSaveStatus('error');
        setSaveError(msg.error === 'file_too_large' ? t('fileBrowser.fileTooLarge') : t('fileBrowser.saveError'));
        setTimeout(() => setSaveStatus((s) => s === 'error' ? 'idle' : s), 3000);
      }
    });
  }, [onMessage, onSaved, t]);

  const doSave = useCallback((forceWrite = false) => {
    setSaveStatus('saving');
    setSaveError(null);
    const requestId = ws.fsWriteFile(path, editContentRef.current, forceWrite ? undefined : originalMtime);
    pendingWriteRef.current.set(requestId, path);
    setTimeout(() => {
      if (pendingWriteRef.current.has(requestId)) {
        pendingWriteRef.current.delete(requestId);
        setSaveStatus('timeout');
        setSaveError(t('fileBrowser.saveTimeout'));
        setTimeout(() => setSaveStatus((s) => s === 'timeout' ? 'idle' : s), 4000);
      }
    }, 30_000);
  }, [ws, path, originalMtime, t]);

  // Cmd+S / Ctrl+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (isDirty) doSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isDirty, doSave]);

  /** Expose dirty state to parent */
  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange]);

  return (
    <>
      {/* Toolbar buttons — rendered inline in parent's header */}
      <button class="fb-diff-toggle" onClick={onClose}>{t('fileBrowser.preview')}</button>
      <button
        class={`fb-diff-toggle fb-save-btn${isDirty ? ' fb-save-dirty' : ''}${saveStatus === 'saving' ? ' fb-save-saving' : ''}`}
        disabled={saveStatus === 'saving' || !isDirty}
        onClick={() => doSave()}
      >
        {saveStatus === 'saving' ? t('fileBrowser.saving') : t('fileBrowser.save')}
        {isDirty && saveStatus !== 'saving' && <span class="fb-dirty-dot" />}
      </button>
      {saveStatus === 'success' && <span class="fb-save-success">{t('fileBrowser.saveSuccess')}</span>}
      {(saveStatus === 'error' || saveStatus === 'timeout') && saveError && <span class="fb-save-error">{saveError}</span>}
    </>
  );
}

/** Editor content area — CodeMirror editor + conflict dialog */
export function FileEditorContent({ ws, path, content, mtime: _mtime, onMessage, onDirtyChange }: Omit<FileEditorProps, 'onClose' | 'onSaved'> & { onDirtyChange?: (dirty: boolean) => void }) {
  const { t } = useTranslation();
  const [isDirty, setIsDirty] = useState(false);
  const [conflictData, setConflictData] = useState<{ diskContent: string; diskMtime: number } | null>(null);
  const pendingWriteRef = useRef(new Map<string, string>());
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep a ref to current content for conflict resolution
  const currentContentRef = useRef(content);

  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange]);

  useEffect(() => {
    return onMessage((msg) => {
      if (msg.type !== 'fs.write_response') return;
      const filePath = pendingWriteRef.current.get(msg.requestId);
      if (!filePath) return;
      pendingWriteRef.current.delete(msg.requestId);
      if (msg.status === 'conflict') {
        setConflictData({ diskContent: msg.diskContent ?? '', diskMtime: msg.diskMtime ?? 0 });
      }
    });
  }, [onMessage]);

  // Initialize CodeMirror editor
  useEffect(() => {
    if (!containerRef.current) return;

    const langExt = getLanguageExtension(path);
    const extensions = [
      basicSetup,
      oneDark,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const newContent = update.state.doc.toString();
          currentContentRef.current = newContent;
          const dirty = newContent !== content;
          setIsDirty(dirty);
          onDirtyChange?.(dirty);
        }
      }),
      EditorView.theme({
        '&': { height: '100%', fontSize: '12px', fontFamily: "'Menlo', 'Monaco', 'Consolas', monospace" },
        '.cm-scroller': { overflow: 'auto' },
      }),
    ];
    if (langExt) extensions.push(langExt);

    const state = EditorState.create({
      doc: content,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]); // Re-create editor when path changes

  // When content prop changes externally (e.g. file reload), update editor if not dirty
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (isDirty) return; // Don't overwrite user's edits
    const currentDoc = view.state.doc.toString();
    if (currentDoc === content) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
    });
    currentContentRef.current = content;
  }, [content, isDirty]);

  return (
    <>
      {conflictData && (
        <div class="fb-conflict-overlay">
          <div class="fb-conflict-dialog">
            <div class="fb-conflict-title">{t('fileBrowser.conflictTitle')}</div>
            <div class="fb-conflict-actions">
              <button class="btn btn-primary" onClick={() => {
                setConflictData(null);
                const requestId = ws.fsWriteFile(path, currentContentRef.current);
                pendingWriteRef.current.set(requestId, path);
              }}>{t('fileBrowser.conflictKeepMine')}</button>
              <button class="btn btn-secondary" onClick={() => {
                // Replace editor content with disk version
                const view = viewRef.current;
                if (view) {
                  view.dispatch({
                    changes: { from: 0, to: view.state.doc.length, insert: conflictData.diskContent },
                  });
                  currentContentRef.current = conflictData.diskContent;
                }
                setIsDirty(false);
                setConflictData(null);
              }}>{t('fileBrowser.conflictUseDisk')}</button>
              <button class="btn btn-secondary" onClick={() => setConflictData(null)}>
                {t('fileBrowser.conflictCancel')}
              </button>
            </div>
          </div>
        </div>
      )}
      <div ref={containerRef} class="fb-editor-cm" />
    </>
  );
}
