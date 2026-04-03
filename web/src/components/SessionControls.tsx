import { useState, useRef, useEffect, useCallback, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { RefObject } from 'preact';
import type { WsClient } from '../ws-client.js';
import type { SessionInfo } from '../types.js';
import { QuickInputPanel } from './QuickInputPanel.js';
import { getNavigableHistory } from './QuickInputPanel.js';
import type { UseQuickDataResult } from './QuickInputPanel.js';
import { FileBrowser } from './FileBrowser.js';
import { useSwipeBack } from '../hooks/useSwipeBack.js';
import * as VoiceInput from './VoiceInput.js';
import { VoiceOverlay } from './VoiceOverlay.js';
import { AtPicker } from './AtPicker.js';
import { P2pConfigPanel } from './P2pConfigPanel.js';
import { uploadFile, getUserPref, saveUserPref } from '../api.js';
import { isVisuallyBusy } from '../thinking-utils.js';
import { P2P_CONFIG_MODE, COMBO_PRESETS, COMBO_SEPARATOR } from '@shared/p2p-modes.js';
import type { P2pSavedConfig } from '@shared/p2p-modes.js';
import { getQwenAuthTier, QWEN_AUTH_TIERS } from '@shared/qwen-auth.js';
import { getKnownQwenModelDescription, getKnownQwenModelOptions } from '@shared/qwen-models.js';

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
  /** Called when Settings is selected in the menu. */
  onSettings?: () => void;
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
  /** Quoted text segments from chat messages. */
  quotes?: string[];
  /** Called to remove a quote by index. */
  onRemoveQuote?: (index: number) => void;
  /** Text to append into the input when arriving from "Go & quote". */
  pendingPrefillText?: string | null;
  /** Called after pendingPrefillText has been applied. */
  onPendingPrefillApplied?: () => void;
  /** Compact mode for sub-session cards — only input, @, ⚡, 📎, send. */
  compact?: boolean;
}

type MenuAction = 'restart' | 'new' | 'stop';
type ModelChoice = 'opus[1M]' | 'sonnet' | 'haiku';
type CodexModelChoice = 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.2';
type QwenModelChoice = string;
type P2pMode = string; // 'solo' | single modes | combo pipelines like 'brainstorm>discuss>plan' | typeof P2P_CONFIG_MODE

const MODEL_STORAGE_KEY = 'imcodes-model';
const CODEX_MODEL_STORAGE_KEY = 'imcodes-codex-model';
const QWEN_MODEL_STORAGE_KEY = 'imcodes-qwen-model';
const SINGLE_AGENT_PROMPT_PREF_KEY = 'atpicker_single_agent_prompt_dismissed';
const CODEX_MODELS: CodexModelChoice[] = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2'];
const SINGLE_P2P_MODES: string[] = ['solo', 'audit', 'review', 'plan', 'brainstorm', 'discuss'];
const P2P_MODES: string[] = [...SINGLE_P2P_MODES, ...COMBO_PRESETS.map((c) => c.key), P2P_CONFIG_MODE];
const P2P_MODE_I18N: Record<string, string> = { solo: 'p2p.mode_solo', audit: 'p2p.mode_audit', review: 'p2p.mode_review', plan: 'p2p.mode_plan', brainstorm: 'p2p.mode_brainstorm', discuss: 'p2p.mode_discuss', [P2P_CONFIG_MODE]: 'p2p.mode_config' };
const P2P_SINGLE_COLORS: Record<string, string> = { solo: '#6b7280', audit: '#f59e0b', review: '#3b82f6', plan: '#06b6d4', brainstorm: '#a78bfa', discuss: '#22c55e', [P2P_CONFIG_MODE]: '#94a3b8' };

function getP2pModeColor(mode: string): string {
  if (P2P_SINGLE_COLORS[mode]) return P2P_SINGLE_COLORS[mode];
  // Combo: use color of the last step (the deliverable)
  if (mode.includes(COMBO_SEPARATOR)) {
    const last = mode.split(COMBO_SEPARATOR).pop()?.trim();
    return last ? (P2P_SINGLE_COLORS[last] ?? '#94a3b8') : '#94a3b8';
  }
  return '#94a3b8';
}

function getP2pModeLabel(mode: string, t: (key: string) => string): string {
  if (P2P_MODE_I18N[mode]) return t(P2P_MODE_I18N[mode]);
  // Combo: join translated names with →
  if (mode.includes(COMBO_SEPARATOR)) {
    return mode.split(COMBO_SEPARATOR).map((m) => {
      const key = P2P_MODE_I18N[m.trim()];
      return key ? t(key) : m.trim();
    }).join('→');
  }
  return mode;
}

interface PendingAtTarget {
  session: string;
  mode: string;
  label: string;
}

interface PendingSendPayload {
  text: string;
  extra: Record<string, unknown>;
  singleAgentTargetSelected: boolean;
}

type ManualP2pTargetCandidate = {
  session: string;
  aliases: string[];
};

type ManualP2pResolveResult = {
  orderedTargets: Array<{ session: string; mode: string }>;
  cleanText: string;
};

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
    if (v === 'opus[1M]' || v === 'sonnet' || v === 'haiku') return v;
    if (v === 'opus') return 'opus[1M]';
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

function loadQwenModel(): QwenModelChoice | null {
  try {
    const v = localStorage.getItem(QWEN_MODEL_STORAGE_KEY);
    if (v?.trim()) return v;
  } catch { /* ignore */ }
  return null;
}

function normalizeP2pMode(mode: string): string | null {
  const normalized = mode.trim().toLowerCase();
  return P2P_MODES.includes(normalized as P2pMode) ? normalized : null;
}

function buildManualP2pCandidates(
  sessions: SessionInfo[] | undefined,
  subSessions: Props['subSessions'],
): ManualP2pTargetCandidate[] {
  const main = (sessions ?? []).map((s) => ({
    session: s.name,
    aliases: [s.label, s.name].filter((v): v is string => !!v && v.trim().length > 0),
  }));
  const subs = (subSessions ?? []).map((s) => ({
    session: s.sessionName,
    aliases: [s.label, s.sessionName, s.sessionName.replace(/^deck_sub_/, '')].filter((v): v is string => !!v && v.trim().length > 0),
  }));
  return [...main, ...subs];
}

function extractManualP2pTargets(
  text: string,
  candidates: ManualP2pTargetCandidate[],
): ManualP2pResolveResult {
  if (!text.includes('@@')) return { orderedTargets: [], cleanText: text };

  const aliasMap = new Map<string, string | null>();
  for (const candidate of candidates) {
    for (const alias of candidate.aliases) {
      const key = alias.trim().toLowerCase();
      if (!key || key === 'all' || key === 'discuss' || key === 'p2p-config') continue;
      const existing = aliasMap.get(key);
      if (existing === undefined) aliasMap.set(key, candidate.session);
      else if (existing !== candidate.session) aliasMap.set(key, null);
    }
  }

  const orderedTargets: Array<{ session: string; mode: string }> = [];
  const cleanText = text.replace(/@@([^()\n]+?)\(([^()\n]+)\)/g, (match, rawAlias: string, rawMode: string) => {
    const mode = normalizeP2pMode(rawMode);
    if (!mode) return match;
    const alias = rawAlias.trim().toLowerCase();
    if (alias === 'all') {
      orderedTargets.push({ session: '__all__', mode });
      return '';
    }
    const session = aliasMap.get(alias);
    if (!session) return match;
    orderedTargets.push({ session, mode });
    return '';
  }).replace(/\s+/g, ' ').trim();

  return { orderedTargets, cleanText };
}

export function SessionControls({ ws, activeSession, inputRef, onAfterAction, onStopProject, onRenameSession, onSettings, sessionDisplayName, quickData, detectedModel, hideShortcuts, onSend, onSubRestart, onSubNew, onSubStop, activeThinking, mobileFileBrowserOpen, onMobileFileBrowserClose, sessions, subSessions, serverId, quotes, onRemoveQuote, pendingPrefillText, onPendingPrefillApplied, compact }: Props) {
  const { t, i18n } = useTranslation();
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
  const [customCombos, setCustomCombos] = useState<string[]>([]);
  const [p2pConfigOpen, setP2pConfigOpen] = useState(false);
  const [p2pSavedConfig, setP2pSavedConfig] = useState<P2pSavedConfig | null>(null);
  const [model, setModel] = useState<ModelChoice | null>(loadModel);
  const [codexModel, setCodexModel] = useState<CodexModelChoice | null>(loadCodexModel);
  const [qwenModel, setQwenModel] = useState<QwenModelChoice | null>(loadQwenModel);
  const [queuedNoticeVisible, setQueuedNoticeVisible] = useState(false);
  const [confirm, setConfirm] = useState<MenuAction | null>(null);
  const [confirmLevel, setConfirmLevel] = useState(0); // 0=none, 1=first warning, 2=second warning (sub-session only)
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
  const [singleAgentPromptSuppressed, setSingleAgentPromptSuppressed] = useState(false);
  const [singleAgentPromptOpen, setSingleAgentPromptOpen] = useState(false);
  const [singleAgentPromptSkip, setSingleAgentPromptSkip] = useState(false);
  const pendingSendRef = useRef<PendingSendPayload | null>(null);

  // Keep external inputRef in sync so parent can call .focus()
  useEffect(() => {
    if (inputRef) (inputRef as { current: HTMLDivElement | null }).current = divRef.current;
  });

  useEffect(() => {
    if (!pendingPrefillText || !divRef.current) return;
    divRef.current.textContent = (divRef.current.textContent || '') + pendingPrefillText;
    setHasText(!!divRef.current.textContent.trim());
    divRef.current.dispatchEvent(new Event('input', { bubbles: true }));
    divRef.current.focus();
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(divRef.current);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch { /* ignore selection API failures */ }
    onPendingPrefillApplied?.();
  }, [pendingPrefillText, onPendingPrefillApplied]);

  useEffect(() => {
    let cancelled = false;
    void getUserPref(SINGLE_AGENT_PROMPT_PREF_KEY).then((raw) => {
      if (cancelled) return;
      setSingleAgentPromptSuppressed(raw === '1');
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

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
    if (detectedModel === 'opus[1M]' || detectedModel === 'sonnet' || detectedModel === 'haiku') {
      if (model !== detectedModel) setModel(detectedModel);
    }
    // Codex models
    if (detectedModel.startsWith('gpt-') && CODEX_MODELS.includes(detectedModel as CodexModelChoice)) {
      if (codexModel !== detectedModel) setCodexModel(detectedModel as CodexModelChoice);
    }
    if (activeSession?.agentType === 'qwen' && detectedModel) {
      if (qwenModel !== detectedModel) setQwenModel(detectedModel as QwenModelChoice);
    }
  }, [activeSession?.agentType, detectedModel, qwenModel, codexModel, model]);

  useEffect(() => {
    if (activeSession?.agentType !== 'qwen') return;
    if (activeSession.qwenModel && qwenModel !== activeSession.qwenModel) {
      setQwenModel(activeSession.qwenModel);
    }
  }, [activeSession?.agentType, activeSession?.qwenModel, qwenModel]);

  const connected = !!ws?.connected;
  const hasSession = !!activeSession;
  // Input only disabled when there's no session at all (can type while disconnected)
  const inputDisabled = !hasSession;
  // Send/action buttons disabled when disconnected or no session
  const disabled = !connected || !hasSession;
  const isClaudeCode = activeSession?.agentType === 'claude-code';
  const isShellLike = activeSession?.agentType === 'shell' || activeSession?.agentType === 'script';
  const isCodex = activeSession?.agentType === 'codex';
  const isQwen = activeSession?.agentType === 'qwen';
  const qwenTier = getQwenAuthTier(activeSession?.qwenAuthType);
  const qwenTierLabel = qwenTier === QWEN_AUTH_TIERS.FREE
    ? t('session.qwen_tier_free')
    : qwenTier === QWEN_AUTH_TIERS.PAID
      ? t('session.qwen_tier_paid')
      : qwenTier === QWEN_AUTH_TIERS.BYO
        ? t('session.qwen_tier_byo')
        : t('session.agentType.qwen');
  const qwenChoices = useMemo(() => {
    const known = getKnownQwenModelOptions(activeSession?.qwenAuthType);
    const shouldTrustKnownOnly = qwenTier === QWEN_AUTH_TIERS.FREE || qwenTier === QWEN_AUTH_TIERS.PAID;
    const ids = shouldTrustKnownOnly
      ? known.map((model) => model.id)
      : activeSession?.qwenAvailableModels?.length
        ? [...activeSession.qwenAvailableModels]
        : activeSession?.qwenModel
          ? [activeSession.qwenModel]
          : known.map((model) => model.id);
    if (detectedModel && !ids.includes(detectedModel)) ids.unshift(detectedModel);
    if (qwenModel && !ids.includes(qwenModel)) ids.unshift(qwenModel);
    return ids.map((id) => ({
      id,
      description: known.find((model) => model.id === id)?.description ?? getKnownQwenModelDescription(id),
    }));
  }, [activeSession?.qwenAuthType, activeSession?.qwenAvailableModels, detectedModel, qwenModel, qwenTier]);

  // P2P config loading moved after rootSession declaration below

  // Load custom combos from server
  useEffect(() => {
    void getUserPref('p2p_custom_combos').then((raw) => {
      if (raw && typeof raw === 'string') {
        try { setCustomCombos(JSON.parse(raw)); } catch { /* ignore */ }
      }
    });
  }, []);

  // Reset P2P mode on session change
  useEffect(() => { setP2pMode('solo'); setP2pOpen(false); }, [activeSession?.name]);

  // Close menus when clicking outside
  useEffect(() => {
    if (!menuOpen && !modelOpen && !p2pOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuOpen && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setConfirm(null);
        setConfirmLevel(0);
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

  const getCaretLineBoundary = (direction: 'up' | 'down') => {
    const root = divRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return true;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return true;

    const probe = range.cloneRange();
    probe.selectNodeContents(root);
    if (direction === 'up') {
      probe.setEnd(range.startContainer, range.startOffset);
    } else {
      probe.setStart(range.endContainer, range.endOffset);
    }
    const text = probe.toString();
    return !text.includes('\n');
  };

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

  /** Build a short display label for the input box — prefer sub-session label over raw ID. */
  const buildAgentLabel = (session: string, mode: string) => {
    const modeLabel = mode === P2P_CONFIG_MODE
      ? t('p2p.mode_config')
      : t(`p2p.mode.${mode}`);
    if (session === '__all__') return `@@all(${modeLabel})`;
    const sub = (subSessions ?? []).find(s => s.sessionName === session);
    const display = sub?.label || session.replace(/^deck_sub_/, '');
    return `@@${display}(${modeLabel})`;
  };

  /** Pending @-selected P2P targets + their display labels for removal at send time. */
  const pendingAtTargetsRef = useRef<PendingAtTarget[]>([]);
  /** Custom config/rounds override from @@all+ picker (cleared on send). */
  const pendingConfigOverrideRef = useRef<{ config: P2pSavedConfig; rounds: number; modeOverride: string } | null>(null);

  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * Extract @-picked agent targets in the order they appear in the textbox.
   * This lets users reorder or delete @@agent(mode) labels manually before send.
   */
  const extractOrderedAtTargets = (text: string, pendingTargets: PendingAtTarget[]) => {
    if (pendingTargets.length === 0) return { orderedTargets: [] as PendingAtTarget[], cleanText: text };

    const labelQueues = new Map<string, PendingAtTarget[]>();
    for (const target of pendingTargets) {
      const queue = labelQueues.get(target.label);
      if (queue) queue.push(target);
      else labelQueues.set(target.label, [target]);
    }

    const labels = [...labelQueues.keys()].sort((a, b) => b.length - a.length);
    if (labels.length === 0) return { orderedTargets: [] as PendingAtTarget[], cleanText: text };

    const matcher = new RegExp(labels.map(escapeRegExp).join('|'), 'g');
    const orderedTargets: PendingAtTarget[] = [];
    const cleanText = text.replace(matcher, (match) => {
      const queue = labelQueues.get(match);
      const target = queue?.shift();
      if (target) orderedTargets.push(target);
      return '';
    }).replace(/\s+/g, ' ').trim();

    return { orderedTargets, cleanText };
  };

  const buildSendPayload = useCallback((): PendingSendPayload | null => {
    let text = getText();
    if ((!text && attachments.length === 0) || !ws || !activeSession) return null;

    // Build P2P routing as structured WS fields — keep text clean for display.
    const extra: Record<string, unknown> = {};
    const pendingTargets = [...pendingAtTargetsRef.current];
    let singleAgentTargetSelected = false;

    if (pendingTargets.length > 0) {
      // @ picker was used — derive routing from the visible textbox order, then strip matched labels.
      const { orderedTargets, cleanText } = extractOrderedAtTargets(text, pendingTargets);
      text = cleanText;
      if (orderedTargets.length > 0) {
        extra.p2pAtTargets = orderedTargets.map(({ session, mode }) => ({ session, mode }));
      }
      // Attach config data when any target uses config mode
      const hasConfigTarget = orderedTargets.some(t => t.mode === 'config');
      if (extra.p2pAtTargets && hasConfigTarget) {
        const override = pendingConfigOverrideRef.current;
        const cfg = override?.config ?? p2pSavedConfig;
        if (cfg) {
          extra.p2pSessionConfig = cfg.sessions;
          extra.p2pRounds = override?.rounds ?? cfg.rounds ?? 1;
          if (cfg.extraPrompt) extra.p2pExtraPrompt = cfg.extraPrompt;
          if (cfg.hopTimeoutMinutes) extra.p2pHopTimeoutMs = Math.min(cfg.hopTimeoutMinutes * 60_000, 600_000);
        }
        // For non-config mode overrides (single or combo), send as p2pMode so the daemon uses it
        if (override?.modeOverride && override.modeOverride !== 'config') {
          extra.p2pMode = override.modeOverride;
        }
      }
    } else {
      const manual = extractManualP2pTargets(text, buildManualP2pCandidates(sessions, subSessions));
      if (manual.orderedTargets.length > 0) {
        text = manual.cleanText;
        extra.p2pAtTargets = manual.orderedTargets;
      } else if (p2pMode !== 'solo' && !text.includes('@@')) {
        // Dropdown P2P mode — daemon handles expansion
        if (p2pMode === P2P_CONFIG_MODE) {
          extra.p2pMode = 'config';
        } else {
          extra.p2pMode = p2pMode;
          if (p2pExcludeSameType) extra.p2pExcludeSameType = true;
        }
        if (p2pMode === P2P_CONFIG_MODE && p2pSavedConfig) {
          extra.p2pSessionConfig = p2pSavedConfig.sessions;
          extra.p2pRounds = p2pSavedConfig.rounds ?? 1;
          if (p2pSavedConfig.extraPrompt) extra.p2pExtraPrompt = p2pSavedConfig.extraPrompt;
          if (p2pSavedConfig.hopTimeoutMinutes) extra.p2pHopTimeoutMs = Math.min(p2pSavedConfig.hopTimeoutMinutes * 60_000, 600_000);
        }
      }
    }

    if (!extra.p2pAtTargets && p2pMode !== 'solo' && !text.includes('@@')) {
      // Dropdown P2P mode — daemon handles expansion
      if (p2pMode === P2P_CONFIG_MODE) {
        extra.p2pMode = 'config';
      } else {
        extra.p2pMode = p2pMode;
        if (p2pExcludeSameType) extra.p2pExcludeSameType = true;
      }
      if (p2pMode === P2P_CONFIG_MODE && p2pSavedConfig) {
        extra.p2pSessionConfig = p2pSavedConfig.sessions;
        extra.p2pRounds = p2pSavedConfig.rounds ?? 1;
        if (p2pSavedConfig.extraPrompt) extra.p2pExtraPrompt = p2pSavedConfig.extraPrompt;
      }
    }

    // Pass user locale for P2P language instruction
    if (extra.p2pAtTargets || extra.p2pMode) {
      extra.p2pLocale = i18n?.language ?? 'en';
    }

    // Prepend quotes
    if (quotes && quotes.length > 0) {
      const quoteBlock = quotes.map((q) => `> ${q.replace(/\n/g, '\n> ')}`).join('\n\n');
      text = text ? `${quoteBlock}\n\n${text}` : quoteBlock;
    }
    // Prepend attachment references
    if (attachments.length > 0) {
      const refs = attachments.map((a) => `@${a.path}`).join(' ');
      text = text ? `${refs} ${text}` : refs;
    }
    const parsedTargets = Array.isArray(extra.p2pAtTargets) ? extra.p2pAtTargets as Array<{ session: string; mode: string }> : [];
    singleAgentTargetSelected = parsedTargets.length === 1 && parsedTargets[0]?.session !== '__all__';
    return { text, extra, singleAgentTargetSelected };
  }, [attachments, activeSession, i18n?.language, onRemoveQuote, p2pExcludeSameType, p2pMode, p2pSavedConfig, quotes, sessions, subSessions, ws]);

  const finalizeSend = useCallback((payload: PendingSendPayload) => {
    if (!ws || !activeSession) return;
    if (activeSession.runtimeType === 'transport' && activeSession.state === 'running') {
      setQueuedNoticeVisible(true);
    }
    quickData.recordHistory(payload.text, activeSession.name);
    try {
      ws.sendSessionCommand('send', { sessionName: activeSession.name, text: payload.text, ...payload.extra });
    } catch {
      return;
    }
    pendingAtTargetsRef.current = [];
    pendingConfigOverrideRef.current = null;
    onSend?.(activeSession.name, payload.text);
    if (divRef.current) divRef.current.textContent = '';
    setHasText(false);
    setAttachments([]);
    // Clear quotes after send
    if (quotes && quotes.length > 0) {
      for (let i = quotes.length - 1; i >= 0; i--) onRemoveQuote?.(i);
    }
    atSelectionLockRef.current = false;
    atSelectionSnapshotRef.current = '';
    histIdxRef.current = -1;
    draftRef.current = '';
    if (draftKey) sessionStorage.removeItem(draftKey);
  }, [activeSession, draftKey, onRemoveQuote, onSend, quickData, quotes, ws]);

  useEffect(() => {
    if (!activeSession || activeSession.runtimeType !== 'transport' || activeSession.state !== 'running') {
      setQueuedNoticeVisible(false);
    }
  }, [activeSession?.name, activeSession?.runtimeType, activeSession?.state]);

  const persistSingleAgentPromptPref = useCallback(() => {
    if (!singleAgentPromptSkip) return;
    setSingleAgentPromptSuppressed(true);
    void saveUserPref(SINGLE_AGENT_PROMPT_PREF_KEY, '1').catch(() => {});
  }, [singleAgentPromptSkip]);

  const handleSend = useCallback(() => {
    const payload = buildSendPayload();
    if (!payload) return;
    if (payload.singleAgentTargetSelected && !singleAgentPromptSuppressed) {
      pendingSendRef.current = payload;
      setSingleAgentPromptSkip(false);
      setSingleAgentPromptOpen(true);
      return;
    }
    finalizeSend(payload);
  }, [buildSendPayload, finalizeSend, singleAgentPromptSuppressed]);

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
    if (activeSession.runtimeType === 'transport' && activeSession.state === 'running') {
      setQueuedNoticeVisible(true);
    }
    quickData.recordHistory(voiceText, activeSession.name);
    try {
      ws.sendSessionCommand('send', { sessionName: activeSession.name, text: voiceText, ...extra });
    } catch { return; }
    onSend?.(activeSession.name, voiceText);
  }, [ws, activeSession, quickData, onSend, p2pMode, p2pExcludeSameType, p2pSavedConfig]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && activeSession?.runtimeType === 'transport' && activeSession.state === 'running') {
      e.preventDefault();
      ws?.sendInput(activeSession.name, '\x1b');
      return;
    }

    // When @ picker is open, let it handle Enter/Arrow/Escape — don't send or navigate history
    // AtPicker registers a document-level capture handler that fires BEFORE this bubble handler.
    // AtPicker calls preventDefault + stopPropagation, so this code only runs if AtPicker didn't handle it.
    if (atPickerOpen && (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape')) {
      return;
    }
    // Block Enter right after picker closes (prevents accidental send from the same Enter that selected)
    if (e.key === 'Enter' && (atJustClosedRef.current || atSelectionLockRef.current)) {
      e.preventDefault();
      atJustClosedRef.current = false;
      atSelectionLockRef.current = false;
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSend();
      return;
    }

    // Use session-scoped history, falling back to global history if session has no entries
    const history = getNavigableHistory(quickData.data, activeSession?.name);
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && history.length > 0) {
      // Only intercept when caret is on first/last visual line to avoid breaking multiline editing
      const atTop = getCaretLineBoundary('up');
      const atBottom = getCaretLineBoundary('down');

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

  // Paste: upload files from clipboard, or insert plain text
  const handlePaste = (e: Event) => {
    const ce = e as ClipboardEvent;
    const files = ce.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      void handleFileUpload(files);
      return;
    }
    e.preventDefault();
    const text = ce.clipboardData?.getData('text/plain') ?? '';
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

  const resetConfirm = () => {
    setConfirm(null);
    setConfirmLevel(0);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
  };

  const startConfirm = (action: MenuAction, level = 1) => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirm(action);
    setConfirmLevel(level);
    confirmTimerRef.current = setTimeout(resetConfirm, 3000);
  };

  const handleMenuAction = (action: MenuAction) => {
    if (!ws || !activeSession) return;
    const isSub = !!onSubStop;
    const isStop = action === 'stop';

    if (isSub) {
      // Sub-session stop: 2-level (warn → execute), restart/new: 1-click
      if (confirm !== action) { startConfirm(action, 1); return; }
      if (action === 'stop') {
        onSubStop();
      } else if (action === 'restart') {
        onSubRestart ? onSubRestart() : ws.sendSessionCommand('restart', { project: activeSession.project });
      } else {
        onSubNew ? onSubNew() : ws.sendSessionCommand('restart', { project: activeSession.project, fresh: true });
      }
      setMenuOpen(false); resetConfirm(); onAfterAction?.();
      return;
    }

    // Main session
    if (isStop) {
      // Main session stop: 3-level (warn → danger → dialog)
      if (confirm !== action) { startConfirm(action, 1); return; }
      if (confirmLevel < 2) { startConfirm(action, 2); return; }
      if (!window.confirm(t('session.confirm_stop_dialog'))) { resetConfirm(); return; }
      onStopProject
        ? onStopProject(activeSession.project)
        : ws.sendSessionCommand('stop', { project: activeSession.project });
    } else {
      // Main session restart/new: 1-click confirmation
      if (confirm !== action) { startConfirm(action, 1); return; }
      if (!window.confirm(action === 'restart' ? t('session.confirm_restart_dialog') : t('session.confirm_new_dialog'))) { resetConfirm(); return; }
      ws.sendSessionCommand('restart', { project: activeSession.project, ...(action === 'new' ? { fresh: true } : {}) });
    }
    setMenuOpen(false); resetConfirm(); onAfterAction?.();
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

  const handleQwenModelSelect = (m: QwenModelChoice) => {
    if (!ws || !activeSession) return;
    setQwenModel(m);
    try { localStorage.setItem(QWEN_MODEL_STORAGE_KEY, m); } catch { /* ignore */ }
    ws.sendSessionCommand('send', { sessionName: activeSession.name, text: `/model ${m}` });
    setModelOpen(false);
    onAfterAction?.();
  };

  const placeholder = !hasSession ? t('session.no_session') : !connected ? t('session.send_queued') : t('session.send_placeholder', { name: sessionDisplayName ?? activeSession?.label ?? activeSession?.project ?? 'session' });

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
          serverId={serverId}
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
    <div class={`controls-wrapper${!compact && isVisuallyBusy(activeSession?.state, !!activeThinking) ? ' controls-wrapper-running' : ''}`}>
      {/* Shortcut row — hidden in chat mode and compact mode */}
      {!hideShortcuts && !compact && <div class="shortcuts-row">
        <div class="shortcuts">
          {/* Quick input trigger — shown here (before Esc) when shell terminal hides input row */}
          {isShellLike && (
            <button
              class="shortcut-btn shell-quick-trigger"
              title={t('quick_input.title')}
              onClick={() => setQuickOpen((o) => !o)}
            >⚡</button>
          )}
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
                {(['opus[1M]', 'sonnet', 'haiku'] as const).map((m) => (
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
        {isQwen && (
          <div class="shortcuts-model" ref={modelRef}>
            <button
              class="shortcut-btn"
              onClick={() => setModelOpen((o) => !o)}
              disabled={disabled}
              title={qwenModel
                ? t('session.qwen_model_title', { tier: qwenTierLabel, model: qwenModel })
                : t('session.qwen_source_title', { tier: qwenTierLabel })}
              style={{ color: qwenModel ? '#f59e0b' : '#6b7280', fontSize: 10 }}
            >
              {qwenTierLabel}
            </button>
            {modelOpen && (
              <div class="menu-dropdown menu-dropdown-models">
                {qwenChoices.map((m) => (
                  <button
                    key={m.id}
                    class={`menu-item ${qwenModel === m.id ? 'menu-item-active' : ''}`}
                    onClick={() => handleQwenModelSelect(m.id as QwenModelChoice)}
                    title={m.description || m.id}
                  >
                    {qwenModel === m.id ? '● ' : '○ '}{m.id}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {/* P2P mode selector — hidden for shell/script sessions */}
        {!isShellLike && <div class="shortcuts-model" ref={p2pRef}>
          <button
            class="shortcut-btn"
            data-onboarding="p2p-mode"
            onClick={() => setP2pOpen((o) => !o)}
            disabled={disabled}
            title={p2pMode === 'solo' ? t('p2p.mode_solo') : `P2P: ${getP2pModeLabel(p2pMode, t)}`}
            style={{ color: getP2pModeColor(p2pMode), fontSize: 10, fontWeight: p2pMode !== 'solo' ? 600 : 400 }}
          >
            {p2pMode === 'solo' ? t('p2p.mode_solo') : `P2P:${getP2pModeLabel(p2pMode, t)}`}
          </button>
          {/* Gear button for P2P config panel — always visible */}
          <button
            class="shortcut-btn"
            onClick={() => { setP2pOpen(false); setP2pConfigOpen(true); }}
            disabled={disabled}
            title={t('p2p.settings_title')}
            style={{ fontSize: 12, color: '#94a3b8', paddingLeft: 2, paddingRight: 2 }}
          >
            ⚙
          </button>
          {p2pOpen && (
            <div class="menu-dropdown">
              {/* Single modes */}
              {SINGLE_P2P_MODES.map((m) => (
                <button
                  key={m}
                  class={`menu-item ${p2pMode === m ? 'menu-item-active' : ''}`}
                  onClick={() => {
                    setP2pMode(m);
                    if (m === 'solo') setP2pExcludeSameType(false);
                    setP2pOpen(false);
                  }}
                  style={{ color: getP2pModeColor(m) }}
                >
                  {p2pMode === m ? '● ' : '○ '}{getP2pModeLabel(m, t)}
                </button>
              ))}
              {/* Combo presets */}
              <div class="menu-divider" />
              <div style={{ fontSize: 10, color: '#64748b', padding: '2px 12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('p2p.combo_label')}</div>
              {COMBO_PRESETS.map((c) => (
                <button
                  key={c.key}
                  class={`menu-item ${p2pMode === c.key ? 'menu-item-active' : ''}`}
                  onClick={() => { setP2pMode(c.key); setP2pOpen(false); }}
                  style={{ color: getP2pModeColor(c.key), fontSize: 12 }}
                >
                  {p2pMode === c.key ? '● ' : '○ '}{getP2pModeLabel(c.key, t)}
                </button>
              ))}
              {customCombos.filter((k) => !COMBO_PRESETS.some((p) => p.key === k)).map((key) => (
                <button
                  key={key}
                  class={`menu-item ${p2pMode === key ? 'menu-item-active' : ''}`}
                  onClick={() => { setP2pMode(key); setP2pOpen(false); }}
                  style={{ color: getP2pModeColor(key), fontSize: 12 }}
                >
                  {p2pMode === key ? '● ' : '○ '}{getP2pModeLabel(key, t)}
                </button>
              ))}
              {/* Config mode */}
              <div class="menu-divider" />
              <button
                class={`menu-item ${p2pMode === P2P_CONFIG_MODE ? 'menu-item-active' : ''}`}
                onClick={() => {
                  setP2pMode(P2P_CONFIG_MODE);
                  setP2pOpen(false);
                  if (!p2pSavedConfig) setP2pConfigOpen(true);
                }}
                style={{ color: getP2pModeColor(P2P_CONFIG_MODE) }}
              >
                {p2pMode === P2P_CONFIG_MODE ? '● ' : '○ '}{getP2pModeLabel(P2P_CONFIG_MODE, t)} ⚙
              </button>
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
        </div>}
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

      {/* Attachment badges — above input row */}
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

      {/* Quote badges — above input row */}
      {quotes && quotes.length > 0 && (
        <div class="attachment-badges">
          {quotes.map((q, i) => (
            <span key={i} class="attachment-badge quote-badge" title={q}>
              <span class="attachment-badge-icon">❝</span>
              <span class="attachment-badge-name">{q.slice(0, 30)}{q.length > 30 ? '…' : ''}</span>
              <button
                class="attachment-badge-remove"
                onClick={() => onRemoveQuote?.(i)}
                title={t('common.delete')}
              >×</button>
            </span>
          ))}
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
              if (activeSession.runtimeType === 'transport' && activeSession.state === 'running') {
                setQueuedNoticeVisible(true);
              }
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
            onSelectAllConfig={(config, rounds, modeOverride) => {
              // Show @@all(config) — daemon expands per config. Store custom rounds + config override.
              const text = divRef.current?.textContent ?? '';
              const before = text.replace(/@[^\s@]*$/, '');
              const labelMode = modeOverride === 'config' ? 'config' : modeOverride;
              const label = rounds > 1 ? `@@all(${labelMode} ×${rounds})` : `@@all(${labelMode})`;
              divRef.current!.textContent = `${before}${label} `;
              pendingAtTargetsRef.current.push({ session: '__all__', mode: 'config', label });
              // Store custom config + rounds for handleSend
              pendingConfigOverrideRef.current = { config, rounds, modeOverride };
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

        {/*
          contenteditable div — iOS does NOT show the password/keychain autofill bar
          for contenteditable elements, unlike <input> or <textarea>.
        */}
        <div
          ref={divRef}
          class={`controls-input${inputDisabled ? ' controls-input-disabled' : ''}${p2pMode !== 'solo' ? ' controls-input-p2p' : ''}`}
          data-onboarding="chat-input"
          contenteditable={inputDisabled ? 'false' : 'true'}
          role="textbox"
          aria-multiline="true"
          aria-label="Message input"
          data-placeholder={placeholder}
          spellcheck={false}
          style={p2pMode !== 'solo' ? { borderColor: getP2pModeColor(p2pMode), boxShadow: `0 0 0 1px ${getP2pModeColor(p2pMode)}40` } : undefined}
          onFocus={handleFocus}
          onInput={() => {
            const currentText = divRef.current?.textContent ?? '';
            setHasText(!!currentText.trim());
            if (atSelectionLockRef.current && currentText !== atSelectionSnapshotRef.current) {
              atSelectionLockRef.current = false;
              atSelectionSnapshotRef.current = currentText;
            }
            // Detect @/@@: use end of text (contentEditable anchorOffset is unreliable)
            const text = currentText;

            // @@ → jump straight to agents picker
            const doubleAt = text.match(/@@([^\s]*)$/);
            if (doubleAt) {
              setAtPickerOpen(true);
              setAtPickerStage('agents');
              setAtQuery(doubleAt[1]);
            } else {
              // Single @ → choose stage (files + agents menu)
              const singleAt = text.match(/@([^\s@]*)$/);
              if (singleAt) {
                const query = singleAt[1];
                if (!atPickerOpen) {
                  if (query.length === 0) {
                    setAtPickerOpen(true);
                    setAtPickerStage('choose');
                    setAtQuery('');
                  } else {
                    setAtPickerOpen(false);
                  }
                } else if (atPickerStage === 'choose') {
                  if (query.length === 0) {
                    setAtPickerOpen(true);
                    setAtQuery('');
                  } else {
                    setAtPickerOpen(false);
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
          style={p2pMode !== 'solo' ? { background: getP2pModeColor(p2pMode), borderColor: getP2pModeColor(p2pMode) } : undefined}
        >
          {p2pMode !== 'solo' ? getP2pModeLabel(p2pMode, t) : t('common.send')}
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

        {/* Menu button — hidden in compact mode */}
        {!compact && <div class="menu-wrap" ref={menuRef}>
          <button
            class="btn btn-secondary"
            onClick={() => { setMenuOpen((o) => !o); resetConfirm(); }}
            disabled={disabled}
            title={t('session.actions')}
            style={{ padding: '6px 10px' }}
          >
            ⋯
          </button>
          {menuOpen && (
            <div class="menu-dropdown">
              <button
                class={`menu-item ${confirm === 'restart' ? (confirmLevel >= 2 ? 'menu-item-danger' : 'menu-item-warn') : ''}`}
                onClick={() => handleMenuAction('restart')}
              >
                {confirm === 'restart'
                  ? (confirmLevel >= 2 ? t('session.confirm_sub_restart_2', { label: activeSession?.label || activeSession?.name }) : t('session.confirm_restart'))
                  : t('session.restart')}
              </button>
              <button
                class={`menu-item ${confirm === 'new' ? (confirmLevel >= 2 ? 'menu-item-danger' : 'menu-item-warn') : ''}`}
                onClick={() => handleMenuAction('new')}
              >
                {confirm === 'new'
                  ? (confirmLevel >= 2 ? t('session.confirm_sub_new_2', { label: activeSession?.label || activeSession?.name }) : t('session.confirm_new'))
                  : t('session.new')}
              </button>
              <button
                class="menu-item"
                onClick={() => { onRenameSession?.(); setMenuOpen(false); }}
              >
                {t('session.rename')}
              </button>
              {onSettings && (
                <button
                  class="menu-item"
                  onClick={() => { onSettings(); setMenuOpen(false); }}
                >
                  {t('session.settings')}
                </button>
              )}
              <div class="menu-divider" />
              <button
                class={`menu-item ${confirm === 'stop' ? 'menu-item-danger' : ''}`}
                onClick={() => handleMenuAction('stop')}
              >
                {confirm === 'stop'
                  ? (confirmLevel >= 2 ? t('session.confirm_sub_stop_2', { label: activeSession?.label || activeSession?.name }) : t('session.confirm_stop'))
                  : t('session.stop')}
              </button>
            </div>
          )}
        </div>}
      </div>
      {queuedNoticeVisible && (
        <div class="controls-queued-hint" role="status" aria-live="polite">
          {t('session.transport_send_queued')}
        </div>
      )}
    </div>
    {singleAgentPromptOpen && (
      <div class="ask-dialog-overlay" onClick={() => { setSingleAgentPromptOpen(false); pendingSendRef.current = null; }}>
        <div class="ask-dialog single-agent-dialog" onClick={(e) => e.stopPropagation()}>
          <div class="single-agent-dialog-icon">🧠</div>
          <div class="single-agent-dialog-title">{t('p2p.single_agent_prompt.title')}</div>
          <div class="single-agent-dialog-body">
            <div>{t('p2p.single_agent_prompt.body')}</div>
            <div>{t('p2p.single_agent_prompt.tip_multi')}</div>
            <div>{t('p2p.single_agent_prompt.tip_history')}</div>
            <div>{t('p2p.single_agent_prompt.tip_rounds')}</div>
          </div>
          <label class="single-agent-dialog-checkbox">
            <input
              type="checkbox"
              checked={singleAgentPromptSkip}
              onChange={(e) => setSingleAgentPromptSkip((e.target as HTMLInputElement).checked)}
            />
            <span>{t('p2p.single_agent_prompt.dont_show_again')}</span>
          </label>
          <div class="ask-actions">
            <button
              class="ask-btn-cancel"
              onClick={() => {
                persistSingleAgentPromptPref();
                setSingleAgentPromptOpen(false);
                pendingSendRef.current = null;
              }}
            >
              {t('common.cancel')}
            </button>
            <button
              class="ask-btn-cancel"
              onClick={() => {
                persistSingleAgentPromptPref();
                setSingleAgentPromptOpen(false);
                pendingSendRef.current = null;
                setAtQuery('');
                setAtPickerStage('agents');
                setAtPickerOpen(true);
                divRef.current?.focus();
              }}
            >
              {t('p2p.single_agent_prompt.more_agents')}
            </button>
            <button
              class="ask-btn-submit"
              onClick={() => {
                const pending = pendingSendRef.current;
                persistSingleAgentPromptPref();
                setSingleAgentPromptOpen(false);
                pendingSendRef.current = null;
                if (pending) finalizeSend(pending);
              }}
            >
              {t('p2p.single_agent_prompt.send_anyway')}
            </button>
          </div>
        </div>
      </div>
    )}
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
