import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../api.js';
import { FileBrowser } from './file-browser-lazy.js';
import type { WsClient } from '../ws-client.js';
import type { JSX, RefObject } from 'preact';

export interface QuickData {
  history: string[];                        // cross-session
  sessionHistory: Record<string, string[]>; // per-session, keyed by session name
  commands: string[];
  phrases: string[];
}

export const EMPTY_QUICK_DATA: QuickData = { history: [], sessionHistory: {}, commands: [], phrases: [] };

// ── Built-in defaults (not stored in D1, cannot be deleted) ───────────────

const DEFAULT_COMMANDS: Record<string, string[]> = {
  'claude-code': ['/compact', '/clear', '/usage', '/cost', '/status', '/help'],
  'claude-code-sdk': ['/compact', '/clear', '/model', '/thinking'],
  'copilot-sdk': ['/compact', '/clear', '/model', '/thinking'],
  'codex':       ['/compact', '/help', '/model', '/approval', '/clear'],
  'codex-sdk':   ['/compact', '/clear', '/model', '/thinking'],
  'cursor-headless': ['/compact', '/clear', '/model'],
  'opencode':    ['/compact', '/clear', '/model', '/help'],
  'qwen':        ['/compact', '/stop', '/clear', '/model', '/thinking'],
  'openclaw':    ['/compact', '/stop', '/clear', '/thinking'],
};
const DEFAULT_PHRASES = ['continue', 'fix', 'explain', 'refactor this', 'write tests', 'check errors', 'LGTM, commit', 'test & push', 'yes'];

const SESSION_HISTORY_MAX = 50;
const GLOBAL_HISTORY_MAX = 50;

// ── Data helpers ──────────────────────────────────────────────────────────

function dedupPrepend(list: string[], text: string, max: number): string[] {
  return [text, ...list.filter((h) => h !== text)].slice(0, max);
}

export function recordHistoryEntry(data: QuickData, text: string, sessionName?: string): QuickData {
  const trimmed = text.trim();
  if (!trimmed) return data;
  const next: QuickData = {
    ...data,
    history: dedupPrepend(data.history, trimmed, GLOBAL_HISTORY_MAX),
  };
  if (sessionName) {
    const prev = data.sessionHistory[sessionName] ?? [];
    next.sessionHistory = {
      ...data.sessionHistory,
      [sessionName]: dedupPrepend(prev, trimmed, SESSION_HISTORY_MAX),
    };
  }
  return next;
}

export function getNavigableHistory(data: QuickData, sessionName?: string): string[] {
  if (!sessionName) return data.history;
  const sessionHist = data.sessionHistory[sessionName] ?? [];
  return sessionHist.length > 0 ? sessionHist : data.history;
}

export function getAccountHistory(data: QuickData): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  const append = (items: string[]) => {
    for (const item of items) {
      if (!seen.has(item)) {
        seen.add(item);
        merged.push(item);
      }
    }
  };
  append(data.history);
  for (const items of Object.values(data.sessionHistory)) append(items);
  return merged;
}

// ── Hook ──────────────────────────────────────────────────────────────────

let _debounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(data: QuickData): void {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    apiFetch('/api/quick-data', { method: 'PUT', body: JSON.stringify({ data }) }).catch((err) => {
      console.error('[quick-data] save failed:', err);
    });
  }, 2000);
}

export interface UseQuickDataResult {
  data: QuickData;
  loaded: boolean;
  recordHistory: (text: string, sessionName?: string) => void;
  addCommand: (cmd: string) => void;
  addPhrase: (phrase: string) => void;
  removeCommand: (cmd: string) => void;
  removePhrase: (phrase: string) => void;
  removeHistory: (text: string) => void;
  removeSessionHistory: (sessionName: string, text: string) => void;
  clearHistory: () => void;
  clearSessionHistory: (sessionName: string) => void;
}

export function useQuickData(): UseQuickDataResult {
  const [data, setData] = useState<QuickData>(EMPTY_QUICK_DATA);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const fetchData = () => {
      apiFetch<{ data: QuickData }>('/api/quick-data').then((res) => {
        const d = res.data;
        if (!d.sessionHistory) d.sessionHistory = {};
        setData(d);
        setLoaded(true);
      }).catch(() => { setLoaded(true); });
    };
    fetchData();
    // Re-fetch when app resumes from background (mobile) or tab becomes visible
    const onVisibility = () => { if (document.visibilityState === 'visible') fetchData(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const recordHistory = (text: string, sessionName?: string) => {
    setData((prev) => {
      const next = recordHistoryEntry(prev, text, sessionName);
      scheduleSave(next);
      return next;
    });
  };

  const addCommand = (cmd: string) => {
    const trimmed = cmd.trim();
    if (!trimmed) return;
    setData((prev) => {
      if (prev.commands.includes(trimmed)) return prev;
      const next = { ...prev, commands: [...prev.commands, trimmed] };
      scheduleSave(next);
      return next;
    });
  };

  const addPhrase = (phrase: string) => {
    const trimmed = phrase.trim();
    if (!trimmed) return;
    setData((prev) => {
      if (prev.phrases.includes(trimmed)) return prev;
      const next = { ...prev, phrases: [...prev.phrases, trimmed] };
      scheduleSave(next);
      return next;
    });
  };

  const removeCommand = (cmd: string) => {
    setData((prev) => {
      const next = { ...prev, commands: prev.commands.filter((c) => c !== cmd) };
      scheduleSave(next);
      return next;
    });
  };
  const removePhrase = (phrase: string) => {
    setData((prev) => {
      const next = { ...prev, phrases: prev.phrases.filter((p) => p !== phrase) };
      scheduleSave(next);
      return next;
    });
  };
  const removeHistory = (text: string) => {
    setData((prev) => {
      const next = { ...prev, history: prev.history.filter((h) => h !== text) };
      scheduleSave(next);
      return next;
    });
  };
  const removeSessionHistory = (sessionName: string, text: string) => {
    setData((prev) => {
      const sh = prev.sessionHistory[sessionName] ?? [];
      const next = { ...prev, sessionHistory: { ...prev.sessionHistory, [sessionName]: sh.filter((h) => h !== text) } };
      scheduleSave(next);
      return next;
    });
  };
  const clearHistory = () => {
    setData((prev) => {
      const next = { ...prev, history: [] };
      scheduleSave(next);
      return next;
    });
  };
  const clearSessionHistory = (sessionName: string) => {
    setData((prev) => {
      const next = { ...prev, sessionHistory: { ...prev.sessionHistory, [sessionName]: [] } };
      scheduleSave(next);
      return next;
    });
  };

  return { data, loaded, recordHistory, addCommand, addPhrase, removeCommand, removePhrase, removeHistory, removeSessionHistory, clearHistory, clearSessionHistory };
}

// ── Panel component ───────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (text: string) => void;
  onSend: (text: string) => void;
  agentType: string;
  sessionName: string;
  data: QuickData;
  loaded: boolean;
  onAddCommand: (cmd: string) => void;
  onAddPhrase: (phrase: string) => void;
  onRemoveCommand: (cmd: string) => void;
  onRemovePhrase: (phrase: string) => void;
  onRemoveHistory: (text: string) => void;
  onRemoveSessionHistory: (sessionName: string, text: string) => void;
  onClearHistory: () => void;
  onClearSessionHistory: (sessionName: string) => void;
  /** When provided, enables the Files tab for browsing and inserting paths */
  ws?: WsClient | null;
  sessionCwd?: string;
  onAppendPaths?: (paths: string[]) => void;
  anchorRef?: RefObject<HTMLElement>;
}

const HISTORY_PAGE_SIZE = 10;
const TRUNCATE_THRESHOLD = 40;
type AddTarget = 'command' | 'phrase' | null;
type HistoryScope = 'session' | 'global';
type QpTab = 'quick' | 'files';

/** Truncate long text: "start of text...end of text" */
function truncateMiddle(text: string, max = TRUNCATE_THRESHOLD): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 3) / 2);
  return text.slice(0, half) + '...' + text.slice(-half);
}

export function QuickInputPanel({
  open, onClose, onSelect, onSend, agentType, sessionName,
  data, loaded,
  onAddCommand, onAddPhrase, onRemoveCommand, onRemovePhrase,
  onRemoveHistory, onRemoveSessionHistory, onClearHistory, onClearSessionHistory,
  ws, sessionCwd, onAppendPaths, anchorRef,
}: Props) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const [addTarget, setAddTarget] = useState<AddTarget>(null);
  const [addValue, setAddValue] = useState('');
  const [editingItem, setEditingItem] = useState<{ type: 'command' | 'phrase'; original: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyScope, setHistoryScope] = useState<HistoryScope>('session');
  const [activeTab, setActiveTab] = useState<QpTab>('quick');
  const [insertedPaths, setInsertedPaths] = useState<string[]>([]);
  const [layoutTick, setLayoutTick] = useState(0);

  // Reset page when scope or session changes
  useEffect(() => { setHistoryPage(0); }, [historyScope, sessionName]);

  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const refreshLayout = () => setLayoutTick((tick) => tick + 1);
    const viewport = window.visualViewport;
    window.addEventListener('resize', refreshLayout);
    viewport?.addEventListener('resize', refreshLayout);
    viewport?.addEventListener('scroll', refreshLayout);
    return () => {
      window.removeEventListener('resize', refreshLayout);
      viewport?.removeEventListener('resize', refreshLayout);
      viewport?.removeEventListener('scroll', refreshLayout);
    };
  }, [open]);

  // Close on outside click (exclude trigger button to avoid close→reopen flicker)
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current && !panelRef.current.contains(target)
        && !(anchorRef?.current && anchorRef.current.contains(target))) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose, anchorRef]);

  // Focus add/edit input when shown
  useEffect(() => {
    if (addTarget) setTimeout(() => addInputRef.current?.focus(), 50);
  }, [addTarget]);
  useEffect(() => {
    if (editingItem) setTimeout(() => editInputRef.current?.focus(), 50);
  }, [editingItem]);

  const panelStyle = useMemo(() => {
    if (!open) return undefined; // skip computation when closed
    if (typeof window === 'undefined' || window.innerWidth <= 640) return undefined;
    const trigger = anchorRef?.current;
    if (!trigger) return undefined;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const horizontalInset = 8;
    const verticalInset = 12;
    const triggerGap = 6;
    const width = Math.max(240, Math.min(Math.floor(viewportWidth * 0.75), 1050, viewportWidth - horizontalInset * 2));
    const maxLeft = Math.max(horizontalInset, viewportWidth - width - horizontalInset);
    const left = Math.min(Math.max(rect.left, horizontalInset), maxLeft);
    const rawAbove = Math.floor(rect.top - verticalInset);
    const rawBelow = Math.floor(viewportHeight - rect.bottom - verticalInset);
    const shouldOpenBelow = rawAbove < 200;
    const availableAbove = Math.max(120, rawAbove);
    const availableBelow = Math.max(120, rawBelow);

    const style: JSX.CSSProperties = {
      position: 'fixed',
      left: `${Math.round(left)}px`,
      width: `${Math.round(width)}px`,
      maxWidth: `${Math.round(width)}px`,
      maxHeight: `${shouldOpenBelow ? availableBelow : availableAbove}px`,
      zIndex: 10002,
    } as preact.JSX.CSSProperties;

    if (shouldOpenBelow) {
      style.top = `${Math.max(Math.round(rect.bottom + triggerGap), horizontalInset)}px`;
      style.bottom = 'auto'; // clear CSS default bottom: calc(100% + 6px)
    } else {
      style.bottom = `${Math.max(viewportHeight - rect.top + triggerGap, horizontalInset)}px`;
      style.top = 'auto';
    }

    return style;
  }, [anchorRef, layoutTick, open]);

  if (!open) return null;

  const defaultCmds = DEFAULT_COMMANDS[agentType] ?? DEFAULT_COMMANDS['claude-code'];
  const activeHistory = historyScope === 'session'
    ? (data.sessionHistory[sessionName] ?? [])
    : getAccountHistory(data);
  const totalHistoryPages = Math.ceil(activeHistory.length / HISTORY_PAGE_SIZE);
  const historySlice = activeHistory.slice(historyPage * HISTORY_PAGE_SIZE, (historyPage + 1) * HISTORY_PAGE_SIZE);

  const handleSelect = (text: string) => { onSelect(text); onClose(); };
  const handleSend = (text: string) => { onSend(text); onClose(); };

  const handleClear = () => {
    if (historyScope === 'session') onClearSessionHistory(sessionName);
    else onClearHistory();
  };

  const handleRemoveItem = (text: string) => {
    if (historyScope === 'session') onRemoveSessionHistory(sessionName, text);
    else onRemoveHistory(text);
  };

  const commitAdd = () => {
    const v = addValue.trim();
    if (v) {
      if (addTarget === 'command') onAddCommand(v);
      else if (addTarget === 'phrase') onAddPhrase(v);
    }
    setAddValue('');
    setAddTarget(null);
  };

  const handleAddKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); commitAdd(); }
    if (e.key === 'Escape') { setAddTarget(null); setAddValue(''); }
  };

  const startEdit = (type: 'command' | 'phrase', original: string) => {
    setEditingItem({ type, original });
    setEditValue(original);
  };

  const commitEdit = () => {
    if (!editingItem) return;
    const v = editValue.trim();
    const { type, original } = editingItem;
    if (v && v !== original) {
      if (type === 'command') { onRemoveCommand(original); onAddCommand(v); }
      else { onRemovePhrase(original); onAddPhrase(v); }
    }
    setEditingItem(null);
    setEditValue('');
  };

  const handleEditKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
    if (e.key === 'Escape') { setEditingItem(null); setEditValue(''); }
  };

  const panel = (
    <>
      <div class="qp-backdrop" onClick={onClose} />
      <div class="qp" ref={panelRef} style={panelStyle}>
        {/* Tab bar — shown when Files feature is available */}
        {ws && (
          <div class="qp-tabs">
            <button class={`qp-tab${activeTab === 'quick' ? ' active' : ''}`} onClick={() => setActiveTab('quick')}>
              ⚡ {t('quick_input.tab_quick')}
            </button>
            <button class={`qp-tab${activeTab === 'files' ? ' active' : ''}`} onClick={() => setActiveTab('files')}>
              📁 {t('quick_input.tab_files')}
            </button>
          </div>
        )}

        {/* Files tab */}
        {activeTab === 'files' && ws && (
          <FileBrowser
            ws={ws}
            mode="file-multi"
            layout="panel"
            initialPath={sessionCwd ?? '~'}
            alreadyInserted={insertedPaths}
            onConfirm={(paths) => {
              setInsertedPaths((prev) => [...new Set([...prev, ...paths])]);
              const cwd = sessionCwd;
              const rel = cwd
                ? paths.map((p) => '@' + (p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p) + ' ')
                : paths.map((p) => '@' + p + ' ');
              onAppendPaths?.(rel);
            }}
          />
        )}

        {/* Quick tab content */}
        {activeTab === 'quick' && <>
        {/* Toolbar */}
        {addTarget ? (
          <div class="qp-add-row">
            <span class="qp-add-label">{addTarget === 'command' ? t('quick_input.label_command') : t('quick_input.label_phrase')}</span>
            <input
              ref={addInputRef}
              class="qp-add-input"
              value={addValue}
              onInput={(e) => setAddValue((e.target as HTMLInputElement).value)}
              onKeyDown={handleAddKeyDown}
              placeholder={addTarget === 'command' ? '/compact' : t('quick_input.placeholder_phrase')}
            />
            <button class="qp-add-confirm" onClick={commitAdd}>＋</button>
            <button class="qp-add-cancel" onClick={() => { setAddTarget(null); setAddValue(''); }}>✕</button>
          </div>
        ) : (
          <div class="qp-toolbar">
            <button class="qp-toolbar-btn" onClick={() => setAddTarget('command')}>{t('quick_input.add_command')}</button>
            <button class="qp-toolbar-btn" onClick={() => setAddTarget('phrase')}>{t('quick_input.add_phrase')}</button>
            {activeHistory.length > 0 && (
              <button class="qp-toolbar-btn qp-toolbar-btn-danger" onClick={handleClear}>{t('quick_input.clear_history')}</button>
            )}
          </div>
        )}

        <div class="qp-list">
          {!loaded && <div class="qp-empty">{t('quick_input.loading')}</div>}

          {/* Commands — pill wrap */}
          {loaded && (
            <>
              <div class="qp-section-header">{t('quick_input.commands')}</div>
              <div class="qp-pills">
                {defaultCmds.map((cmd) => (
                  <button key={cmd} class="qp-pill qp-pill-default" onClick={() => handleSend(cmd)}>{cmd}</button>
                ))}
                {data.commands.map((cmd) => (
                  editingItem?.type === 'command' && editingItem.original === cmd ? (
                    <span key={cmd} class="qp-pill qp-pill-editing">
                      <input
                        ref={editInputRef}
                        class="qp-edit-input"
                        value={editValue}
                        onInput={(e) => setEditValue((e.target as HTMLInputElement).value)}
                        onKeyDown={handleEditKeyDown}
                        onBlur={commitEdit}
                      />
                    </span>
                  ) : (
                    <span key={cmd} class="qp-pill qp-pill-custom" title={cmd.length > TRUNCATE_THRESHOLD ? cmd : undefined}>
                      <span class="qp-pill-text" onClick={() => handleSend(cmd)}>{truncateMiddle(cmd)}</span>
                      <button class="qp-pill-edit" onClick={() => startEdit('command', cmd)}>✎</button>
                      <button class="qp-pill-del" onClick={() => { if (confirm(t('quick_input.confirm_delete'))) onRemoveCommand(cmd); }}>✕</button>
                    </span>
                  )
                ))}
              </div>
            </>
          )}

          {/* Phrases — pill wrap */}
          {loaded && (
            <>
              <div class="qp-section-header">{t('quick_input.phrases')}</div>
              <div class="qp-pills">
                {DEFAULT_PHRASES.map((phrase) => (
                  <button key={phrase} class="qp-pill qp-pill-default" onClick={() => handleSend(phrase)}>{phrase}</button>
                ))}
                {data.phrases.map((phrase) => (
                  editingItem?.type === 'phrase' && editingItem.original === phrase ? (
                    <span key={phrase} class="qp-pill qp-pill-editing">
                      <input
                        ref={editInputRef}
                        class="qp-edit-input"
                        value={editValue}
                        onInput={(e) => setEditValue((e.target as HTMLInputElement).value)}
                        onKeyDown={handleEditKeyDown}
                        onBlur={commitEdit}
                      />
                    </span>
                  ) : (
                    <span key={phrase} class="qp-pill qp-pill-custom" title={phrase.length > TRUNCATE_THRESHOLD ? phrase : undefined}>
                      <span class="qp-pill-text" onClick={() => handleSend(phrase)}>{truncateMiddle(phrase)}</span>
                      <button class="qp-pill-edit" onClick={() => startEdit('phrase', phrase)}>✎</button>
                      <button class="qp-pill-del" onClick={() => { if (confirm(t('quick_input.confirm_delete'))) onRemovePhrase(phrase); }}>✕</button>
                    </span>
                  )
                ))}
              </div>
            </>
          )}

          {/* History — scope toggle + rows */}
          {loaded && (
            <>
              <div class="qp-section-header qp-history-header">
                <span>{t('quick_input.history')}</span>
                <div class="qp-scope-toggle">
                  <button
                    class={`qp-scope-btn${historyScope === 'session' ? ' active' : ''}`}
                    onClick={() => setHistoryScope('session')}
                  >{t('quick_input.this_session')}</button>
                  <button
                    class={`qp-scope-btn${historyScope === 'global' ? ' active' : ''}`}
                    onClick={() => setHistoryScope('global')}
                  >{t('quick_input.all')}</button>
                </div>
              </div>
              {historySlice.length > 0 ? historySlice.map((text, i) => (
                <div key={historyPage * HISTORY_PAGE_SIZE + i} class="qp-item qp-item-history" onClick={() => handleSelect(text)} title={text.length > 60 ? text : undefined}>
                  <span class="qp-item-text">{truncateMiddle(text, 60)}</span>
                  <button class="qp-item-del" onClick={(e) => { e.stopPropagation(); handleRemoveItem(text); }}>✕</button>
                </div>
              )) : (
                <div class="qp-history-empty">
                  {historyScope === 'session' ? t('quick_input.no_history_session') : t('quick_input.no_history')}
                </div>
              )}
            </>
          )}
        </div>

        {/* Pagination */}
        {loaded && totalHistoryPages > 1 && (
          <div class="qp-pagination">
            <button class="qp-page-btn" disabled={historyPage === 0} onClick={() => setHistoryPage((p) => p - 1)}>{t('quick_input.newer')}</button>
            <span class="qp-page-info">{historyPage + 1} / {totalHistoryPages}</span>
            <button class="qp-page-btn" disabled={historyPage >= totalHistoryPages - 1} onClick={() => setHistoryPage((p) => p + 1)}>{t('quick_input.older')}</button>
          </div>
        )}
        </>}
      </div>
    </>
  );

  if (typeof document === 'undefined') return panel;
  return createPortal(panel, document.body);
}
