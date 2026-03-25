import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { RefObject } from 'preact';
import type { WsClient } from '../ws-client.js';
import type { SessionInfo } from '../types.js';
import { QuickInputPanel } from './QuickInputPanel.js';
import type { UseQuickDataResult } from './QuickInputPanel.js';
import { FileBrowser } from './FileBrowser.js';
import { useSwipeBack } from '../hooks/useSwipeBack.js';
import * as VoiceInput from './VoiceInput.js';
import { VoiceOverlay } from './VoiceOverlay.js';
import { AtPicker } from './AtPicker.js';
import { P2pConfigPanel } from './P2pConfigPanel.js';
import { uploadFile, getUserPref, saveUserPref } from '../api.js';
import { isVisuallyBusy } from '../thinking-utils.js';
import { P2P_CONFIG_MODE } from '@shared/p2p-modes.js';
import type { P2pSavedConfig } from '@shared/p2p-modes.js';

interface Props {
  ws: WsClient | null;
  activeSession: SessionInfo | null;
  inputRef?: RefObject<HTMLDivElement>;
  /** Called after each shortcut/action button click — use to restore focus to xterm on desktop. */
  onAfterAction?: () => void;
  /** Called when stop is confirmed — immediately removes tab from state. */
  onStopProject?: (project: string) => void;
  /** Called when Rename is selected in the menu. */
  onRenameSession?: () => void;
  /** Display name (rename label) for the active session — shown in placeholder. */
  sessionDisplayName?: string | null;
  /** Quick data hook result from parent (loaded once at app level). */
  quickData: UseQuickDataResult;
  /** Model detected from terminal output or usage events for the active session. */
  detectedModel?: string;
  /** Hide the shortcuts row (e.g. in chat mode). */
  hideShortcuts?: boolean;
  /** Called after a message is sent — for local UX only (e.g. optimistic display). Does not emit timeline events. */
  onSend?: (sessionName: string, text: string) => void;
  /** Sub-session overrides — when set, menu actions use these instead of main session commands. */
  onSubRestart?: () => void;
  onSubNew?: () => void;
  onSubStop?: () => void;
  /** When true, show the scan-sweep animation even if session state is not 'running'. */
  activeThinking?: boolean;
  /** Mobile: open full-screen file browser overlay. */
  mobileFileBrowserOpen?: boolean;
  onMobileFileBrowserClose?: () => void;
  /** All sessions — for @ picker agent list. */
  sessions?: SessionInfo[];
  /** Sub-sessions — for @ picker agent list (includes deck_sub_*). */
  subSessions?: Array<{ sessionName: string; type: string; label?: string | null; state: string; parentSession?: string | null }>;
  /** Server ID — required for file upload. */
  serverId?: string;
}

type MenuAction = 'restart' | 'new' | 'stop';
type ModelChoice = 'opus' | 'sonnet' | 'haiku';
type CodexModelChoice = 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.2';
type P2pMode = 'solo' | 'audit' | 'review' | 'brainstorm' | 'discuss' | typeof P2P_CONFIG_MODE;

const MODEL_STORAGE_KEY = 'imcodes-model';
const CODEX_MODEL_STORAGE_KEY = 'imcodes-codex-model';
const CODEX_MODELS: CodexModelChoice[] = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2'];
const P2P_MODES: P2pMode[] = ['solo', 'audit', 'review', 'brainstorm', 'discuss', P2P_CONFIG_MODE];
const P2P_MODE_I18N: Record<P2pMode, string> = { solo: 'p2p.mode_solo', audit: 'p2p.mode_audit', review: 'p2p.mode_review', brainstorm: 'p2p.mode_brainstorm', discuss: 'p2p.mode_discuss', [P2P_CONFIG_MODE]: 'p2p.mode_config' };
const P2P_MODE_COLORS: Record<P2pMode, string> = { solo: '#6b7280', audit: '#f59e0b', review: '#3b82f6', brainstorm: '#a78bfa', discuss: '#22c55e', [P2P_CONFIG_MODE]: '#94a3b8' };

// Enter moved after ↓ arrow
const SHORTCUTS: Array<{ label: string; title: string; data: string; wide?: boolean }> = [
  { label: 'Esc',  title: 'Escape',     data: '\x1b' },
  { label: '^C',   title: 'Ctrl+C',     data: '\x03' },
  { label: '^B²',  title: 'Ctrl+B ×2',  data: '\x02\x02' },
  { label: '↑',    title: 'Up arrow',   data: '\x1b[A' },
  { label: '↓',    title: 'Down arrow', data: '\x1b[B' },
  { label: '↵',    title: 'Enter',      data: '\r', wide: true },
  { label: 'Tab',  title: 'Tab',        data: '\t' },
  { label: '↑Tab', title: 'Shift+Tab',  data: '\x1b[Z' },
  { label: '/',    title: 'Slash',      data: '/' },
  { label: '⌫',    title: 'Backspace',  data: '\x7f' },
];

function loadModel(): ModelChoice | null {
  try {
    const v = localStorage.getItem(MODEL_STORAGE_KEY);
    if (v === 'opus' || v === 'sonnet' || v === 'haiku') return v;
  } catch { /* ignore */ }
  return null;
}

function loadCodexModel(): CodexModelChoice | null {
  try {
    const v = localStorage.getItem(CODEX_MODEL_STORAGE_KEY);
    if (CODEX_MODELS.includes(v as CodexModelChoice)) return v as CodexModelChoice;
  } catch { /* ignore */ }
  return null;
}

export function SessionControls({ ws, activeSession, inputRef, onAfterAction, onStopProject, onRenameSession, sessionDisplayName, quickData, detectedModel, hideShortcuts, onSend, onSubRestart, onSubNew, onSubStop, activeThinking, mobileFileBrowserOpen, onMobileFileBrowserClose, sessions, subSessions, serverId }: Props) {
  const { t } = useTranslation();
  const swipeBackRef = useSwipeBack(onMobileFileBrowserClose);
  const [hasText, setHasText] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [atPickerOpen, setAtPickerOpen] = useState(false);
  const [atQuery, setAtQuery] = useState('');
  const [atPickerStage, setAtPickerStage] = useState<'choose' | 'files' | 'agents' | 'mode'>('choose');
  const atJustClosedRef = useRef(false);
  const atSelectionLockRef = useRef(false);
  const atSelectionSnapshotRef = useRef('');
  const [modelOpen, setModelOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [p2pMode, setP2pMode] = useState<P2pMode>('solo');
  const [p2pExcludeSameType, setP2pExcludeSameType] = useState(true);
  const [p2pOpen, setP2pOpen] = useState(false);
  const [p2pConfigOpen, setP2pConfigOpen] = useState(false);
  const [p2pSavedConfig, setP2pSavedConfig] = useState<P2pSavedConfig | null>(null);
  const [model, setModel] = useState<ModelChoice | null>(loadModel);
  const [codexModel, setCodexModel] = useState<CodexModelChoice | null>(loadCodexModel);
  const [confirm, setConfirm] = useState<MenuAction | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const p2pRef = useRef<HTMLDivElement>(null);
  const quickWrapRef = useRef<HTMLDivElement>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Internal ref for contenteditable — also written to the external inputRef
  const divRef = useRef<HTMLDivElement>(null);
  // History navigation state
  const histIdxRef = useRef(-1);   // -1 = not navigating; 0 = most recent
  const draftRef = useRef('');      // saved unsent text while navigating
  // File upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Array<{ path: string; name: string }>>([]);

  // Keep external inputRef in sync so parent can call .focus()
  useEffect(() => {
    if (inputRef) (inputRef as { current: HTMLDivElement | null }).current = divRef.current;
  });

  // Persist input draft across unmount/remount (sub-session minimize/restore)
  const draftKey = activeSession ? `rcc_draft_${activeSession.name}` : null;
  useEffect(() => {
    if (!draftKey || !divRef.current) return;
    const saved = sessionStorage.getItem(draftKey);
    if (saved) {
      divRef.current.textContent = saved;
      setHasText(!!saved.trim());
    }
    return () => {
      const text = divRef.current?.textContent ?? '';
      if (draftKey) sessionStorage.setItem(draftKey, text);
    };
  }, [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-sync model selector with detected model from terminal/ctx
  // Detection is the real-time truth — always override the selector
  useEffect(() => {
    if (!detectedModel) return;
    // CC models
    if (detectedModel === 'opus' || detectedModel === 'sonnet' || detectedModel === 'haiku') {
      if (model !== detectedModel) setModel(detectedModel);
    }
    // Codex models
    if (detectedModel.startsWith('gpt-') && CODEX_MODELS.includes(detectedModel as CodexModelChoice)) {
      if (codexModel !== detectedModel) setCodexModel(detectedModel as CodexModelChoice);
    }
  }, [detectedModel]);

  const connected = !!ws?.connected;
  const hasSession = !!activeSession;
  // Input only disabled when there's no session at all (can type while disconnected)
  const inputDisabled = !hasSession;
  // Send/action buttons disabled when disconnected or no session
  const disabled = !connected || !hasSession;
  const isClaudeCode = activeSession?.agentType === 'claude-code';
  const isCodex = activeSession?.agentType === 'codex';

  // P2P config loading moved after rootSession declaration below

  // Reset P2P mode on session change
  useEffect(() => { setP2pMode('solo'); setP2pOpen(false); }, [activeSession?.name]);

  // Close menus when clicking outside
  useEffect(() => {
    if (!menuOpen && !modelOpen && !p2pOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuOpen && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setConfirm(null);
      }
      if (modelOpen && modelRef.current && !modelRef.current.contains(e.target as Node)) {
        setModelOpen(false);
      }
      if (p2pOpen && p2pRef.current && !p2pRef.current.contains(e.target as Node)) {
        setP2pOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen, modelOpen, p2pOpen]);

  const getText = () => (divRef.current?.textContent ?? '').trim();

  const fillInput = (text: string) => {
    if (divRef.current) {
      divRef.current.textContent = text;
      // Place cursor at end
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(divRef.current);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
      divRef.current.focus();
    }
    setHasText(!!text.trim());
  };

  const appendToInput = (paths: string[]) => {
    if (!paths.length) return;
    const suffix = paths.join(' ');
    if (divRef.current) {
      const current = divRef.current.textContent ?? '';
      divRef.current.textContent = current ? `${current} ${suffix}` : suffix;
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(divRef.current);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
      divRef.current.focus();
    }
    setHasText(true);
  };

  const activeSub = (subSessions ?? []).find((s) => s.sessionName === activeSession?.name);
  const rootSession = activeSub?.parentSession || activeSession?.name || '';

  // P2P config is per main-session (sub-sessions follow parent), stored on server for cross-device sync
  const p2pConfigKey = rootSession ? `p2p_session_config:${rootSession}` : null;
  useEffect(() => {
    if (!p2pConfigKey) { setP2pSavedConfig(null); return; }
    const apply = (raw: unknown) => {
      if (raw && typeof raw === 'string') {
        try { setP2pSavedConfig(JSON.parse(raw) as P2pSavedConfig); } catch { setP2pSavedConfig(null); }
      } else {
        setP2pSavedConfig(null);
      }
    };
    void getUserPref(p2pConfigKey).then((raw) => {
      if (raw) { apply(raw); return; }
      // Fallback: migrate from legacy global key
      void getUserPref('p2p_session_config').then((legacyRaw) => {
        if (legacyRaw && typeof legacyRaw === 'string') {
          void saveUserPref(p2pConfigKey!, legacyRaw).catch(() => {});
        }
        apply(legacyRaw);
      });
    });
  }, [p2pConfigKey]);

  /** Build a short display label for the input box — the full token is sent via WS extra fields. */
  const buildAgentLabel = (session: string, _mode: string) =>
    session === '__all__' ? '@@all' : `@@${session.replace(/^deck_sub_/, '')}`;

  /** Pending @-selected P2P targets + their display labels for removal at send time. */
  const pendingAtTargetsRef = useRef<Array<{ session: string; mode: string; label: string }>>([]);

  /** Strip only the exact @@labels we inserted (preserves single-@ file references). */
  const stripAtLabels = (text: string, labels: string[]): string => {
    let result = text;
    for (const label of labels) {
      result = result.replace(label, '');
    }
    return result.replace(/\s+/g, ' ').trim();
  };

  const handleSend = useCallback(() => {
    let text = getText();
    if ((!text && attachments.length === 0) || !ws || !activeSession) return;

    // Build P2P routing as structured WS fields — keep text clean for display.
    const extra: Record<string, unknown> = {};
    const atTargets = pendingAtTargetsRef.current.splice(0);

    if (atTargets.length > 0) {
      // @ picker was used — send targets as structured field, strip @@labels from text
      text = stripAtLabels(text, atTargets.map(t => t.label));
      extra.p2pAtTargets = atTargets.map(({ session, mode }) => ({ session, mode }));
    } else if (p2pMode !== 'solo' && !text.includes('@@')) {
      // Dropdown P2P mode — daemon handles expansion
      if (p2pMode === P2P_CONFIG_MODE) {
        extra.p2pMode = 'config';
      } else {
        extra.p2pMode = p2pMode;
        if (p2pExcludeSameType) extra.p2pExcludeSameType = true;
      }
    }

    if (p2pMode === P2P_CONFIG_MODE && p2pSavedConfig) {
      extra.p2pSessionConfig = p2pSavedConfig.sessions;
      extra.p2pRounds = p2pSavedConfig.rounds ?? 1;
      if (p2pSavedConfig.extraPrompt) extra.p2pExtraPrompt = p2pSavedConfig.extraPrompt;
    }

    // Prepend attachment references
    if (attachments.length > 0) {
      const refs = attachments.map((a) => `@${a.path}`).join(' ');
      text = text ? `${refs} ${text}` : refs;
    }
    quickData.recordHistory(text, activeSession.name);
    try {
      ws.sendSessionCommand('send', { sessionName: activeSession.name, text, ...extra });
    } catch {
      return;
    }
    onSend?.(activeSession.name, text);
    if (divRef.current) divRef.current.textContent = '';
    setHasText(false);
    setAttachments([]);
    atSelectionLockRef.current = false;
    atSelectionSnapshotRef.current = '';
    histIdxRef.current = -1;
    draftRef.current = '';
    if (draftKey) sessionStorage.removeItem(draftKey);
  }, [ws, activeSession, quickData, onSend, attachments, p2pMode, p2pExcludeSameType, p2pSavedConfig]);

  // Voice overlay send handler — applies same P2P mode as text send
  const handleVoiceSend = useCallback((voiceText: string) => {
    if (!ws || !activeSession) return;
    const extra: Record<string, unknown> = {};
    if (p2pMode !== 'solo') {
      extra.p2pMode = p2pMode === P2P_CONFIG_MODE ? 'config' : p2pMode;
      if (p2pExcludeSameType && p2pMode !== P2P_CONFIG_MODE) extra.p2pExcludeSameType = true;
    }
    if (p2pMode === P2P_CONFIG_MODE && p2pSavedConfig) {
      extra.p2pSessionConfig = p2pSavedConfig.sessions;
      extra.p2pRounds = p2pSavedConfig.rounds ?? 1;
      if (p2pSavedConfig.extraPrompt) extra.p2pExtraPrompt = p2pSavedConfig.extraPrompt;
    }
    quickData.recordHistory(voiceText, activeSession.name);
    try {
      ws.sendSessionCommand('send', { sessionName: activeSession.name, text: voiceText, ...extra });
    } catch { return; }
    onSend?.(activeSession.name, voiceText);
  }, [ws, activeSession, quickData, onSend, p2pMode, p2pExcludeSameType, p2pSavedConfig]);

  const handleKeyDown = (e: KeyboardEvent) => {
    // When @ picker is open, let it handle Enter/Arrow/Escape — don't send or navigate history
    if (atPickerOpen && (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape')) {
      // AtPicker's document-level keydown handler will handle these
      return;
    }
    // Block Enter right after picker closes (prevents accidental send from the same Enter that selected)
    if (e.key === 'Enter' && (atJustClosedRef.current || atSelectionLockRef.current)) {
      e.preventDefault();
      atJustClosedRef.current = false;
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSend();
      return;
    }

    // Use session-scoped history, falling back to global history if session has no entries
    const sessionHist = activeSession
      ? (quickData.data.sessionHistory[activeSession.name] ?? [])
      : [];
    const history = sessionHist.length > 0 ? sessionHist : quickData.data.history;
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && history.length > 0) {
      // Only intercept when caret is on first/last line to avoid breaking multiline editing
      const sel = window.getSelection();
      const atTop = !sel || sel.anchorOffset === 0;
      const atBottom = !sel || sel.anchorOffset === (divRef.current?.textContent?.length ?? 0);

      if (e.key === 'ArrowUp' && atTop) {
        e.preventDefault();
        if (histIdxRef.current === -1) {
          // Save current draft before navigating
          draftRef.current = divRef.current?.textContent ?? '';
          if (draftKey) sessionStorage.setItem(draftKey, draftRef.current);
        }
        const next = Math.min(histIdxRef.current + 1, history.length - 1);
        if (next !== histIdxRef.current || histIdxRef.current === -1) {
          histIdxRef.current = next;
          fillInput(history[next]);
        }
        return;
      }

      if (e.key === 'ArrowDown' && atBottom) {
        e.preventDefault();
        if (histIdxRef.current === -1) return;
        const next = histIdxRef.current - 1;
        if (next < 0) {
          histIdxRef.current = -1;
          fillInput(draftRef.current);
        } else {
          histIdxRef.current = next;
          fillInput(history[next]);
        }
        return;
      }
    }

    // Any other key while navigating: exit history nav, keep current text as new draft
    if (histIdxRef.current !== -1 && e.key !== 'Shift' && !e.metaKey && !e.ctrlKey) {
      histIdxRef.current = -1;
      // Preserve current input as draft so Up→Down still restores it
      draftRef.current = divRef.current?.textContent ?? '';
    }
  };

  // On mobile, focusing contenteditable can scroll the document body — force it back
  const handleFocus = () => {
    if (window.scrollY !== 0) window.scrollTo(0, 0);
    if (document.documentElement.scrollTop !== 0) document.documentElement.scrollTop = 0;
    if (document.body.scrollTop !== 0) document.body.scrollTop = 0;
  };

  // Plain-text only paste
  const handlePaste = (e: Event) => {
    e.preventDefault();
    const text = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
    document.execCommand('insertText', false, text);
    setHasText(!!(divRef.current?.textContent?.trim()));
  };

  const handleFileUpload = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0 || !serverId) return;
    setUploading(true);
    setUploadProgress(0);
    setUploadError(null);
    for (const file of Array.from(files)) {
      try {
        const result = await uploadFile(serverId, file, (pct) => setUploadProgress(pct));
        if (result.attachment?.daemonPath) {
          setAttachments((prev) => [...prev, { path: result.attachment!.daemonPath, name: file.name }]);
        }
      } catch (err) {
        console.error('[upload] failed:', err);
        const body = err instanceof Error ? err.message : String(err);
        if (body.includes('daemon_offline')) {
          setUploadError(t('upload.daemon_offline'));
        } else if (body.includes('file_too_large')) {
          setUploadError(t('upload.file_too_large', { max: 20 }));
        } else {
          setUploadError(t('upload.upload_failed'));
        }
        setTimeout(() => setUploadError(null), 5000);
      }
    }
    setUploading(false);
  }, [serverId, t]);

  const handleShortcut = (data: string) => {
    if (!ws || !activeSession) return;
    ws.sendInput(activeSession.name, data);
    onAfterAction?.();
  };

  const startConfirm = (action: MenuAction) => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirm(action);
    confirmTimerRef.current = setTimeout(() => setConfirm(null), 3000);
  };

  const handleMenuAction = (action: MenuAction) => {
    if (!ws || !activeSession) return;
    if (confirm === action) {
      if (action === 'restart') {
        onSubRestart
          ? onSubRestart()
          : ws.sendSessionCommand('restart', { project: activeSession.project });
      } else if (action === 'new') {
        onSubNew
          ? onSubNew()
          : ws.sendSessionCommand('restart', { project: activeSession.project, fresh: true });
      } else {
        onSubStop
          ? onSubStop()
          : onStopProject
            ? onStopProject(activeSession.project)
            : ws.sendSessionCommand('stop', { project: activeSession.project });
      }
      setMenuOpen(false);
      setConfirm(null);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      onAfterAction?.();
    } else {
      startConfirm(action);
    }
  };

  const handleModelSelect = (m: ModelChoice) => {
    if (!ws || !activeSession) return;
    setModel(m);
    try { localStorage.setItem(MODEL_STORAGE_KEY, m); } catch { /* ignore */ }
    ws.sendSessionCommand('send', { sessionName: activeSession.name, text: `/model ${m}` });
    setModelOpen(false);
    onAfterAction?.();
  };

  const handleCodexModelSelect = (m: CodexModelChoice) => {
    if (!ws || !activeSession) return;
    setCodexModel(m);
    try { localStorage.setItem(CODEX_MODEL_STORAGE_KEY, m); } catch { /* ignore */ }
    const isBrain = activeSession.role === 'brain';
    if (isBrain) {
      // Send /model command directly to Codex terminal (like CC)
      ws.sendSessionCommand('send', { sessionName: activeSession.name, text: `/model ${m} medium` });
    } else {
      // Sub-sessions: restart with new model
      ws.subSessionSetModel(activeSession.name, m, activeSession.projectDir);
    }
    setModelOpen(false);
    onAfterAction?.();
  };

  const placeholder = !hasSession ? t('session.no_session') : !connected ? t('session.send_queued') : t('session.send_placeholder', { name: sessionDisplayName ?? activeSession?.name ?? 'session' });

  return (
    <>
    {mobileFileBrowserOpen && ws && activeSession && (
      <div class="mobile-fb-overlay" ref={swipeBackRef}>
        <div class="mobile-fb-header">
          <span style={{ fontSize: 13, fontWeight: 600 }}>📁 Files</span>
          <button class="fb-close" onClick={onMobileFileBrowserClose}>✕</button>
        </div>
        <FileBrowser
          ws={ws}
          mode="file-multi"
          layout="panel"
          initialPath={activeSession.projectDir ?? '~'}
          changesRootPath={activeSession.projectDir ?? undefined}
          hideFooter={false}
          onConfirm={(paths) => {
            const cwd = activeSession.projectDir;
            const rel = cwd
              ? paths.map((p) => '@' + (p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p) + ' ')
              : paths.map((p) => '@' + p + ' ');
            appendToInput(rel);
            onMobileFileBrowserClose?.();
          }}
          onClose={onMobileFileBrowserClose}
        />
      </div>
    )}
    <div class={`controls-wrapper${isVisuallyBusy(activeSession?.state, !!activeThinking) ? ' controls-wrapper-running' : ''}`}>
      {/* Shortcut row — hidden in chat mode */}
      {!hideShortcuts && <div class="shortcuts-row">
        <div class="shortcuts">
          {SHORTCUTS.map((s) => (
            <button
              key={s.label}
              class={`shortcut-btn${s.wide ? ' shortcut-btn-wide' : ''}`}
              title={s.title}
              disabled={disabled}
              onClick={() => handleShortcut(s.data)}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Model selector — outside overflow-x scroll area so dropdown isn't clipped */}
        {isClaudeCode && (
          <div class="shortcuts-model" ref={modelRef}>
            <button
              class="shortcut-btn"
              onClick={() => setModelOpen((o) => !o)}
              disabled={disabled}
              title={model ? `Model: ${model}` : 'Model: Unknown — tap to select'}
              style={{ color: model ? '#a78bfa' : '#6b7280', fontSize: 10 }}
            >
              {model ?? 'unknown'}
            </button>
            {modelOpen && (
              <div class="menu-dropdown">
                {(['opus', 'sonnet', 'haiku'] as const).map((m) => (
                  <button
                    key={m}
                    class={`menu-item ${model === m ? 'menu-item-active' : ''}`}
                    onClick={() => handleModelSelect(m)}
                  >
                    {model === m ? '● ' : '○ '}{m.charAt(0).toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {isCodex && (
          <div class="shortcuts-model" ref={modelRef}>
            <button
              class="shortcut-btn"
              onClick={() => setModelOpen((o) => !o)}
              disabled={disabled}
              title={codexModel ? `Model: ${codexModel}` : 'Model: default — tap to select'}
              style={{ color: codexModel ? '#34d399' : '#6b7280', fontSize: 10 }}
            >
              {codexModel ?? 'default'}
            </button>
            {modelOpen && (
              <div class="menu-dropdown">
                {CODEX_MODELS.map((m) => (
                  <button
                    key={m}
                    class={`menu-item ${codexModel === m ? 'menu-item-active' : ''}`}
                    onClick={() => handleCodexModelSelect(m)}
                  >
                    {codexModel === m ? '● ' : '○ '}{m}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {/* P2P mode selector */}
        <div class="shortcuts-model" ref={p2pRef}>
          <button
            class="shortcut-btn"
            onClick={() => setP2pOpen((o) => !o)}
            disabled={disabled}
            title={p2pMode === 'solo' ? t('p2p.mode_solo') : `P2P: ${t(P2P_MODE_I18N[p2pMode])}`}
            style={{ color: P2P_MODE_COLORS[p2pMode], fontSize: 10, fontWeight: p2pMode !== 'solo' ? 600 : 400 }}
          >
            {p2pMode === 'solo' ? t('p2p.mode_solo') : `P2P:${t(P2P_MODE_I18N[p2pMode])}`}
          </button>
          {/* Gear button for config panel — only shown when config mode is selected */}
          {p2pMode === P2P_CONFIG_MODE && (
            <button
              class="shortcut-btn"
              onClick={() => { setP2pOpen(false); setP2pConfigOpen(true); }}
              disabled={disabled}
              title={t('p2p.settings_title')}
              style={{ fontSize: 12, color: '#94a3b8', paddingLeft: 2, paddingRight: 2 }}
            >
              ⚙
            </button>
          )}
          {p2pOpen && (
            <div class="menu-dropdown">
              {P2P_MODES.map((m) => (
                <button
                  key={m}
                  class={`menu-item ${p2pMode === m ? 'menu-item-active' : ''}`}
                  onClick={() => {
                    setP2pMode(m);
                    if (m === 'solo') setP2pExcludeSameType(false);
                    setP2pOpen(false);
                    // Only open config panel if no saved config exists yet
                    if (m === P2P_CONFIG_MODE && !p2pSavedConfig) setP2pConfigOpen(true);
                  }}
                  style={{ color: P2P_MODE_COLORS[m] }}
                >
                  {p2pMode === m ? '● ' : '○ '}{t(P2P_MODE_I18N[m])}
                  {m === P2P_CONFIG_MODE && ' ⚙'}
                </button>
              ))}
              {p2pMode !== 'solo' && p2pMode !== P2P_CONFIG_MODE && (
                <>
                  <div class="menu-divider" />
                  <button
                    class="menu-item"
                    onClick={() => setP2pExcludeSameType((v) => !v)}
                    style={{ fontSize: 11 }}
                  >
                    {p2pExcludeSameType ? '☑' : '☐'} {t('p2p.exclude_same_type')}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>}

      {/* Upload progress bar */}
      {uploading && (
        <div style={{ margin: '0 8px 4px', height: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ width: `${uploadProgress}%`, height: '100%', background: '#3b82f6', borderRadius: 2, transition: 'width 0.2s ease' }} />
          </div>
          <span style={{ fontSize: 11, color: '#94a3b8', minWidth: 32 }}>{uploadProgress}%</span>
        </div>
      )}

      {/* Upload error banner */}
      {uploadError && (
        <div style={{ padding: '4px 12px', fontSize: 12, color: '#ef4444', background: 'rgba(239,68,68,0.1)', borderRadius: 4, margin: '0 8px 4px' }}>
          {uploadError}
        </div>
      )}

      {/* Main input row */}
      <div class="controls">
        {/* Quick input trigger — left of input */}
        <div class="qp-trigger-wrap" ref={quickWrapRef}>
          <button
            class="qp-trigger"
            title={t('quick_input.title')}
            onClick={() => setQuickOpen((o) => !o)}
          >
            ⚡
          </button>
          <QuickInputPanel
            open={quickOpen}
            onClose={() => setQuickOpen(false)}
            onSelect={fillInput}
            onSend={(text: string) => {
              if (!ws || !activeSession) return;
              quickData.recordHistory(text, activeSession.name);
              ws.sendSessionCommand('send', { sessionName: activeSession.name, text });
            }}
            agentType={activeSession?.agentType ?? 'claude-code'}
            sessionName={activeSession?.name ?? ''}
            data={quickData.data}
            loaded={quickData.loaded}
            onAddCommand={quickData.addCommand}
            onAddPhrase={quickData.addPhrase}
            onRemoveCommand={quickData.removeCommand}
            onRemovePhrase={quickData.removePhrase}
            onRemoveHistory={quickData.removeHistory}
            onRemoveSessionHistory={quickData.removeSessionHistory}
            onClearHistory={quickData.clearHistory}
            onClearSessionHistory={quickData.clearSessionHistory}
            ws={ws}
            sessionCwd={activeSession?.projectDir}
            onAppendPaths={appendToInput}
          />
        </div>

        {/* @ mention picker */}
        {atPickerOpen && ws && activeSession && (
          <AtPicker
            query={atQuery}
            sessions={[
              // Main sessions
              ...(sessions ?? []).map(s => ({
                name: s.name,
                agentType: s.agentType,
                state: s.state,
                label: s.label ?? null,
                parentSession: null,
                isSelf: s.name === activeSession.name,
              })),
              // Sub-sessions
              ...(subSessions ?? []).map(s => ({
                name: s.sessionName,
                agentType: s.type,
                state: s.state,
                label: s.label ?? null,
                parentSession: s.parentSession ?? null,
                isSelf: s.sessionName === activeSession.name,
              })),
            ]}
            rootSession={rootSession}
            wsClient={ws}
            projectDir={activeSession.projectDir ?? ''}
            onSelectFile={(path) => {
              const text = divRef.current?.textContent ?? '';
              const before = text.replace(/@[^\s@]*$/, '');
              divRef.current!.textContent = `${before}@${path} `;
              atSelectionSnapshotRef.current = divRef.current!.textContent;
              atSelectionLockRef.current = true;
              setAtPickerOpen(false);
              setAtPickerStage('choose');
              atJustClosedRef.current = true;
              setTimeout(() => { atJustClosedRef.current = false; atSelectionLockRef.current = false; }, 150);
              setHasText(true);
              // Move cursor to end
              try {
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(divRef.current!);
                range.collapse(false);
                sel?.removeAllRanges();
                sel?.addRange(range);
              } catch { /* jsdom lacks Selection API */ }
            }}
            onSelectAgent={(session, mode) => {
              const text = divRef.current?.textContent ?? '';
              const before = text.replace(/@[^\s@]*$/, '');
              // Show short @@label in input (double-@ = P2P, single-@ = file ref)
              const label = buildAgentLabel(session, mode);
              divRef.current!.textContent = `${before}${label} `;
              pendingAtTargetsRef.current.push({ session, mode, label });
              atSelectionSnapshotRef.current = divRef.current!.textContent;
              atSelectionLockRef.current = true;
              setAtPickerOpen(false);
              setAtPickerStage('choose');
              atJustClosedRef.current = true;
              setTimeout(() => { atJustClosedRef.current = false; atSelectionLockRef.current = false; }, 150);
              setHasText(true);
              // Move cursor to end
              try {
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(divRef.current!);
                range.collapse(false);
                sel?.removeAllRanges();
                sel?.addRange(range);
              } catch { /* jsdom lacks Selection API */ }
            }}
            onSelectAllConfig={(cfg, rounds) => {
              // Store config targets as structured data — don't expand into text
              const text = divRef.current?.textContent ?? '';
              const before = text.replace(/@[^\s@]*$/, '');
              const targets = Object.entries(cfg.sessions)
                .filter(([, entry]) => entry.enabled && entry.mode !== 'skip')
                .map(([session, entry]) => ({ session, mode: entry.mode, label: `@@${session.replace(/^deck_sub_/, '')}` }));
              const labels = targets.map(t => t.label).join(' ');
              divRef.current!.textContent = `${before}${labels} `;
              for (const t of targets) pendingAtTargetsRef.current.push(t);
              // Store rounds + config for handleSend
              setP2pSavedConfig({ sessions: cfg.sessions, rounds });
              setP2pMode(P2P_CONFIG_MODE);
              atSelectionSnapshotRef.current = divRef.current!.textContent;
              atSelectionLockRef.current = true;
              setAtPickerOpen(false);
              setAtPickerStage('choose');
              atJustClosedRef.current = true;
              setTimeout(() => { atJustClosedRef.current = false; atSelectionLockRef.current = false; }, 150);
              setHasText(true);
              try {
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(divRef.current!);
                range.collapse(false);
                sel?.removeAllRanges();
                sel?.addRange(range);
              } catch { /* jsdom lacks Selection API */ }
            }}
            p2pConfig={p2pSavedConfig}
            onClose={() => { setAtPickerOpen(false); setAtPickerStage('choose'); }}
            onStageChange={setAtPickerStage}
            visible={true}
          />
        )}

        {/* Attachment badges */}
        {attachments.length > 0 && (
          <div class="attachment-badges">
            {attachments.map((a, i) => (
              <span key={a.path} class="attachment-badge" title={a.path}>
                <span class="attachment-badge-icon">📎</span>
                <span class="attachment-badge-name">{a.name}</span>
                <button
                  class="attachment-badge-remove"
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  title={t('common.delete')}
                >×</button>
              </span>
            ))}
          </div>
        )}

        {/*
          contenteditable div — iOS does NOT show the password/keychain autofill bar
          for contenteditable elements, unlike <input> or <textarea>.
        */}
        <div
          ref={divRef}
          class={`controls-input${inputDisabled ? ' controls-input-disabled' : ''}${p2pMode !== 'solo' ? ' controls-input-p2p' : ''}`}
          contenteditable={inputDisabled ? 'false' : 'true'}
          role="textbox"
          aria-multiline="true"
          aria-label="Message input"
          data-placeholder={placeholder}
          spellcheck={false}
          style={p2pMode !== 'solo' ? { borderColor: P2P_MODE_COLORS[p2pMode], boxShadow: `0 0 0 1px ${P2P_MODE_COLORS[p2pMode]}40` } : undefined}
          onFocus={handleFocus}
          onInput={() => {
            const currentText = divRef.current?.textContent ?? '';
            setHasText(!!currentText.trim());
            if (atSelectionLockRef.current && currentText !== atSelectionSnapshotRef.current) {
              atSelectionLockRef.current = false;
              atSelectionSnapshotRef.current = currentText;
            }
            // Detect @/@@: single @ → choose (files/agents), @@ → jump to agents
            const text = currentText;
            const sel = window.getSelection();
            const cursorPos = sel?.anchorOffset ?? text.length;
            const beforeCursor = text.slice(0, cursorPos);

            // @@ → jump straight to agents picker
            const doubleAt = beforeCursor.match(/@@([^\s]*)$/);
            if (doubleAt) {
              setAtPickerOpen(true);
              setAtPickerStage('agents');
              setAtQuery(doubleAt[1]);
            } else {
              // Single @ → choose stage (files + agents menu)
              const singleAt = beforeCursor.match(/@([^\s@]*)$/);
              if (singleAt) {
                const query = singleAt[1];
                if (!atPickerOpen) {
                  if (query.length === 0) {
                    setAtPickerOpen(true);
                    setAtPickerStage('choose');
                    setAtQuery('');
                  } else {
                    setAtPickerOpen(false);
                    setAtPickerStage('choose');
                    setAtQuery('');
                  }
                } else if (atPickerStage === 'choose') {
                  if (query.length === 0) {
                    setAtPickerOpen(true);
                    setAtQuery('');
                  } else {
                    setAtPickerOpen(false);
                    setAtPickerStage('choose');
                    setAtQuery('');
                  }
                } else {
                  setAtPickerOpen(true);
                  setAtQuery(query);
                }
              } else {
                setAtPickerOpen(false);
                setAtPickerStage('choose');
                setAtQuery('');
              }
            }
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
        {serverId && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const input = e.target as HTMLInputElement;
                void handleFileUpload(input.files);
                input.value = '';
              }}
            />
            <button
              class="btn btn-voice"
              onClick={() => fileInputRef.current?.click()}
              disabled={inputDisabled || uploading}
              title={uploading ? t('upload.uploading') : t('upload.upload_file')}
            >
              {uploading ? '...' : '\u{1F4CE}'}
            </button>
          </>
        )}
        {VoiceInput.isAvailable() && (
          <button
            class="btn btn-voice"
            onClick={() => setVoiceOpen(true)}
            disabled={inputDisabled}
            title={t('voice.voice_input')}
          >
            🎙
          </button>
        )}
        <button
          class="btn btn-primary"
          onClick={handleSend}
          disabled={inputDisabled || (!hasText && attachments.length === 0) || !connected}
          style={p2pMode !== 'solo' ? { background: P2P_MODE_COLORS[p2pMode], borderColor: P2P_MODE_COLORS[p2pMode] } : undefined}
        >
          {p2pMode !== 'solo' ? `${t(P2P_MODE_I18N[p2pMode])}` : t('common.send')}
        </button>
        {/* Config mode: show gear to open settings panel inline with send row */}
        {p2pMode === P2P_CONFIG_MODE && (
          <button
            class="btn btn-secondary"
            onClick={() => setP2pConfigOpen(true)}
            disabled={disabled}
            title={t('p2p.settings_title')}
            style={{ padding: '6px 10px' }}
          >
            ⚙
          </button>
        )}

        {/* Menu button */}
        <div class="menu-wrap" ref={menuRef}>
          <button
            class="btn btn-secondary"
            onClick={() => { setMenuOpen((o) => !o); setConfirm(null); }}
            disabled={disabled}
            title={t('session.actions')}
            style={{ padding: '6px 10px' }}
          >
            ⋯
          </button>
          {menuOpen && (
            <div class="menu-dropdown">
              <button
                class={`menu-item ${confirm === 'restart' ? 'menu-item-warn' : ''}`}
                onClick={() => handleMenuAction('restart')}
              >
                {confirm === 'restart' ? t('session.confirm_restart') : t('session.restart')}
              </button>
              <button
                class={`menu-item ${confirm === 'new' ? 'menu-item-warn' : ''}`}
                onClick={() => handleMenuAction('new')}
              >
                {confirm === 'new' ? t('session.confirm_new') : t('session.new')}
              </button>
              <button
                class="menu-item"
                onClick={() => { onRenameSession?.(); setMenuOpen(false); }}
              >
                {t('session.rename')}
              </button>
              <div class="menu-divider" />
              <button
                class={`menu-item ${confirm === 'stop' ? 'menu-item-danger' : ''}`}
                onClick={() => handleMenuAction('stop')}
              >
                {confirm === 'stop' ? t('session.confirm_stop') : t('session.stop')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
    <VoiceOverlay open={voiceOpen} onClose={() => setVoiceOpen(false)} onSend={handleVoiceSend} initialText={divRef.current?.textContent ?? ''} />
    {p2pConfigOpen && (
      <P2pConfigPanel
        sessions={(sessions ?? []).map(s => ({ name: s.name, agentType: s.agentType, state: s.state }))}
        subSessions={subSessions ?? []}
        activeSession={activeSession?.name}
        onClose={() => setP2pConfigOpen(false)}
        onSave={(cfg) => {
          setP2pSavedConfig(cfg);
          if (p2pConfigKey) void saveUserPref(p2pConfigKey, JSON.stringify(cfg));
        }}
      />
    )}
    </>
  );
}
