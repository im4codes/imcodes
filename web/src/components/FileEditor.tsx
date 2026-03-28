/**
 * FileEditor — inline text editor for FileBrowser with save + conflict detection.
 * Extracted from FileBrowser to keep component weight manageable for tests.
 */
import { useState, useCallback, useEffect, useRef } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { WsClient, ServerMessage } from '../ws-client.js';

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
      <button
        class="fb-diff-toggle"
        onClick={() => {
          if (isDirty && !window.confirm(t('fileBrowser.unsavedChanges'))) return;
          onClose();
        }}
      >{t('fileBrowser.preview')}</button>
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

/** Editor content area — textarea + conflict dialog */
export function FileEditorContent({ ws, path, content, mtime: _mtime, onMessage, onDirtyChange }: Omit<FileEditorProps, 'onClose' | 'onSaved'> & { onDirtyChange?: (dirty: boolean) => void }) {
  const { t } = useTranslation();
  const [editContent, setEditContent] = useState(content);
  const [isDirty, setIsDirty] = useState(false);
  const [conflictData, setConflictData] = useState<{ diskContent: string; diskMtime: number } | null>(null);
  const pendingWriteRef = useRef(new Map<string, string>());

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

  return (
    <>
      {conflictData && (
        <div class="fb-conflict-overlay">
          <div class="fb-conflict-dialog">
            <div class="fb-conflict-title">{t('fileBrowser.conflictTitle')}</div>
            <div class="fb-conflict-actions">
              <button class="btn btn-primary" onClick={() => {
                setConflictData(null);
                const requestId = ws.fsWriteFile(path, editContent);
                pendingWriteRef.current.set(requestId, path);
              }}>{t('fileBrowser.conflictKeepMine')}</button>
              <button class="btn btn-secondary" onClick={() => {
                setEditContent(conflictData.diskContent);
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
      <textarea
        class="fb-editor-textarea"
        value={editContent}
        onInput={(e) => {
          const val = (e.target as HTMLTextAreaElement).value;
          setEditContent(val);
          setIsDirty(val !== content);
        }}
        spellcheck={false}
      />
    </>
  );
}
