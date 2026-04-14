import { useState, useRef, useEffect, useCallback, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { RefObject } from 'preact';
import type { WsClient, ServerMessage } from '../ws-client.js';
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
import { useP2pCustomCombos } from './p2p-combos.js';
import { uploadFile, getUserPref, saveUserPref, onUserPrefChanged } from '../api.js';
import { isRunningSessionState } from '../thinking-utils.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import {
  buildP2pConfigSelection,
  P2P_CONFIG_MODE,
  COMBO_SEPARATOR,
  isComboMode,
} from '@shared/p2p-modes.js';
import { P2P_CONFIG_ERROR, P2P_CONFIG_MSG } from '@shared/p2p-config-events.js';
import type { P2pSavedConfig } from '@shared/p2p-modes.js';
import { getQwenAuthTier, QWEN_AUTH_TIERS } from '@shared/qwen-auth.js';
import { getKnownQwenModelDescription, getKnownQwenModelOptions } from '@shared/qwen-models.js';
import { CLAUDE_CODE_MODEL_IDS, CODEX_MODEL_IDS, normalizeClaudeCodeModelId } from '../../../src/shared/models/options.js';
import { CLAUDE_SDK_EFFORT_LEVELS, CODEX_SDK_EFFORT_LEVELS, OPENCLAW_THINKING_LEVELS, QWEN_EFFORT_LEVELS, type TransportEffortLevel } from '@shared/effort-levels.js';

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
  /** Legacy prop retained for callers that still pass thinking state for labels/timers. */
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
  /** Notifies parent when the quick input panel opens/closes. */
  onQuickOpenChange?: (open: boolean) => void;
  /** Notifies parent when any floating overlay/dropdown is open. */
  onOverlayOpenChange?: (open: boolean) => void;
}

type MenuAction = 'restart' | 'new' | 'stop';
type ModelChoice = 'opus[1M]' | 'sonnet' | 'haiku';
type CodexModelChoice = 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.2';
type QwenModelChoice = string;
type P2pMode = string; // 'solo' | single modes | combo pipelines like 'brainstorm>discuss>plan' | typeof P2P_CONFIG_MODE

const MODEL_STORAGE_KEY = 'imcodes-model';
const CODEX_MODEL_STORAGE_KEY = 'imcodes-codex-model';
const QWEN_MODEL_STORAGE_KEY = 'imcodes-qwen-model';
const QUEUED_HINT_EXPANDED_STORAGE_KEY = 'imcodes-queued-hint-expanded';
const QUEUED_HINT_EXPANDED_EVENT = 'imcodes:queued-hint-expanded';
const P2P_COMBO_CONFIRM_SKIP_PREF_KEY = 'p2p_combo_direct_send_skip_confirm';
const CODEX_MODELS: CodexModelChoice[] = [...CODEX_MODEL_IDS] as CodexModelChoice[];
const P2P_BASE_MODES = ['solo', 'audit', 'review', 'plan', 'brainstorm', 'discuss', P2P_CONFIG_MODE] as const;
const P2P_MODE_I18N: Record<string, string> = { solo: 'p2p.mode_solo', audit: 'p2p.mode_audit', review: 'p2p.mode_review', plan: 'p2p.mode_plan', brainstorm: 'p2p.mode_brainstorm', discuss: 'p2p.mode_discuss', [P2P_CONFIG_MODE]: 'p2p.mode_config' };
const P2P_SINGLE_COLORS: Record<string, string> = { solo: '#dbe7f5', audit: '#f59e0b', review: '#3b82f6', plan: '#06b6d4', brainstorm: '#a78bfa', discuss: '#22c55e', [P2P_CONFIG_MODE]: '#94a3b8' };

function getP2pSoloDisplayLabel(): string {
  return 'P2P';
}

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
  if (mode === 'solo') return getP2pSoloDisplayLabel();
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

function getP2pMenuItemColor(mode: string, active: boolean): string {
  if (mode === 'solo') return active ? '#f8fafc' : '#dbe7f5';
  return getP2pModeColor(mode);
}

type OptionalP2pAdvancedConfig = {
  advancedPresetKey?: unknown;
  advancedRounds?: unknown;
  advancedRunTimeoutMinutes?: unknown;
  contextReducer?: unknown;
};

interface PendingAtTarget {
  session: string;
  mode: string;
  label: string;
}

interface PendingSendPayload {
  text: string;
  extra: Record<string, unknown>;
}

interface BuildSendPayloadOptions {
  modeOverride?: string;
  syntheticAtTargets?: PendingAtTarget[];
  syntheticConfigOverride?: {
    config: P2pSavedConfig;
    rounds: number;
    modeOverride: string;
  } | null;
}

interface PendingComboSendConfirmation {
  payload: PendingSendPayload;
  modeLabel: string;
  clearComposer: boolean;
}

type ManualP2pTargetCandidate = {
  session: string;
  aliases: string[];
};

type ManualP2pResolveResult = {
  orderedTargets: Array<{ session: string; mode: string }>;
  cleanText: string;
};

type P2pConfigTab = 'participants' | 'combos';

type P2pConfigPersistResult = { ok: boolean; error?: string };

type PendingP2pConfigSave = {
  resolve: (result: P2pConfigPersistResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

function appendOptionalAdvancedP2pConfig(extra: Record<string, unknown>, config: P2pSavedConfig): void {
  const advanced = config as P2pSavedConfig & OptionalP2pAdvancedConfig;
  if (advanced.advancedPresetKey) extra.p2pAdvancedPresetKey = advanced.advancedPresetKey;
  if (advanced.advancedRounds) extra.p2pAdvancedRounds = advanced.advancedRounds;
  if (advanced.advancedRunTimeoutMinutes != null) {
    extra.p2pAdvancedRunTimeoutMinutes = advanced.advancedRunTimeoutMinutes;
  }
  if (advanced.contextReducer) extra.p2pContextReducer = advanced.contextReducer;
}

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
    return normalizeClaudeCodeModelId(localStorage.getItem(MODEL_STORAGE_KEY)) ?? null;
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

function loadQueuedHintExpanded(): boolean {
  try {
    return localStorage.getItem(QUEUED_HINT_EXPANDED_STORAGE_KEY) !== '0';
  } catch { /* ignore */ }
  return true;
}

function normalizeP2pMode(mode: string): string | null {
  const normalized = mode.trim().toLowerCase();
  if ((P2P_BASE_MODES as readonly string[]).includes(normalized)) return normalized;
  return isComboMode(normalized) ? normalized : null;
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

export function SessionControls({ ws, activeSession, inputRef, onAfterAction, onStopProject, onRenameSession, onSettings, sessionDisplayName, quickData, detectedModel, hideShortcuts, onSend, onSubRestart, onSubNew, onSubStop, activeThinking: _activeThinking, mobileFileBrowserOpen, onMobileFileBrowserClose, sessions, subSessions, serverId, quotes, onRemoveQuote, pendingPrefillText, onPendingPrefillApplied, compact, onQuickOpenChange, onOverlayOpenChange }: Props) {
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
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [p2pMode, setP2pMode] = useState<P2pMode>('solo');
  const [p2pExcludeSameType, setP2pExcludeSameType] = useState(true);
  const [p2pOpen, setP2pOpen] = useState(false);
  const [p2pConfigOpen, setP2pConfigOpen] = useState(false);
  const [p2pConfigInitialTab, setP2pConfigInitialTab] = useState<P2pConfigTab>('participants');
  const [p2pSavedConfig, setP2pSavedConfig] = useState<P2pSavedConfig | null>(null);
  const [openSpecOpen, setOpenSpecOpen] = useState(false);
  const [openSpecChanges, setOpenSpecChanges] = useState<string[]>([]);
  const [openSpecLoading, setOpenSpecLoading] = useState(false);
  const [openSpecError, setOpenSpecError] = useState<string | null>(null);
  const [openSpecAuditMenu, setOpenSpecAuditMenu] = useState<string | null>(null);
  const [openSpecProposeMenuOpen, setOpenSpecProposeMenuOpen] = useState(false);
  const [openSpecExpandedChange, setOpenSpecExpandedChange] = useState<string | null>(null);
  const [openSpecLayoutTick, setOpenSpecLayoutTick] = useState(0);
  const [model, setModel] = useState<ModelChoice | null>(loadModel);
  const [codexModel, setCodexModel] = useState<CodexModelChoice | null>(loadCodexModel);
  const [qwenModel, setQwenModel] = useState<QwenModelChoice | null>(loadQwenModel);
  const [queuedHintExpanded, setQueuedHintExpanded] = useState(loadQueuedHintExpanded);
  const [mobileComposerMultiline, setMobileComposerMultiline] = useState(false);
  const [mobileComposerExpanded, setMobileComposerExpanded] = useState(false);
  const [confirm, setConfirm] = useState<MenuAction | null>(null);
  const [confirmLevel, setConfirmLevel] = useState(0); // 0=none, 1=first warning, 2=second warning (sub-session only)
  const [skipComboSendConfirm, setSkipComboSendConfirm] = useState(false);
  const [pendingComboSendConfirm, setPendingComboSendConfirm] = useState<PendingComboSendConfirmation | null>(null);
  const [rememberComboSendChoice, setRememberComboSendChoice] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const p2pRef = useRef<HTMLDivElement>(null);
  const openSpecRef = useRef<HTMLDivElement>(null);
  const openSpecRequestIdRef = useRef<string | null>(null);
  const quickWrapRef = useRef<HTMLDivElement>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showRunningSweep = !compact && isRunningSessionState(activeSession?.state);
  const queuedTransportEntries = activeSession?.runtimeType === 'transport'
    ? (activeSession.transportPendingMessageEntries ?? (activeSession.transportPendingMessages ?? []).map((text, index) => ({
        clientMessageId: `${activeSession.name}:legacy:${index}:${text}`,
        text,
      })))
    : [];
  const queuedTransportMessages = queuedTransportEntries.map((entry) => entry.text);
  const queuedTransportLatestMessage = queuedTransportMessages[queuedTransportMessages.length - 1] ?? '';
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
  const [sendWarning, setSendWarning] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Array<{ path: string; name: string }>>([]);
  const sendWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const clearSendWarning = useCallback(() => {
    if (sendWarningTimerRef.current) {
      clearTimeout(sendWarningTimerRef.current);
      sendWarningTimerRef.current = null;
    }
    setSendWarning(null);
  }, []);

  const showSendWarning = useCallback((message: string) => {
    if (sendWarningTimerRef.current) clearTimeout(sendWarningTimerRef.current);
    setSendWarning(message);
    sendWarningTimerRef.current = setTimeout(() => {
      sendWarningTimerRef.current = null;
      setSendWarning(null);
    }, 5000);
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

  useEffect(() => () => {
    if (sendWarningTimerRef.current) clearTimeout(sendWarningTimerRef.current);
  }, []);

  // Auto-sync model selector with detected model from terminal/ctx
  // Detection is the real-time truth — always override the selector
  useEffect(() => {
    if (!detectedModel) return;
    // CC models
    const normalizedClaudeModel = normalizeClaudeCodeModelId(detectedModel);
    if (normalizedClaudeModel) {
      if (model !== normalizedClaudeModel) setModel(normalizedClaudeModel);
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
  const isClaudeCode = activeSession?.agentType === 'claude-code' || activeSession?.agentType === 'claude-code-sdk';
  const isShellLike = activeSession?.agentType === 'shell' || activeSession?.agentType === 'script';
  const isTransport = activeSession?.runtimeType === 'transport';
  const isCodex = activeSession?.agentType === 'codex' || activeSession?.agentType === 'codex-sdk';
  const isQwen = activeSession?.agentType === 'qwen';
  const thinkingLevels = useMemo((): readonly TransportEffortLevel[] => (
    activeSession?.agentType === 'claude-code-sdk'
      ? CLAUDE_SDK_EFFORT_LEVELS
      : activeSession?.agentType === 'codex-sdk'
        ? CODEX_SDK_EFFORT_LEVELS
        : activeSession?.agentType === 'qwen'
          ? QWEN_EFFORT_LEVELS
        : activeSession?.agentType === 'openclaw'
          ? OPENCLAW_THINKING_LEVELS
          : []
  ), [activeSession?.agentType]);
  const supportsThinking = thinkingLevels.length > 0;
  const currentThinking = (activeSession?.effort as TransportEffortLevel | undefined)
    ?? (activeSession?.agentType === 'qwen' || activeSession?.agentType === 'openclaw'
      ? 'high'
      : undefined);
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
  const { allCombos } = useP2pCustomCombos();
  const comboMenuItems = useMemo(
    () => [...allCombos.presets.map((combo) => combo.key), ...allCombos.custom],
    [allCombos],
  );

  // P2P config loading moved after rootSession declaration below

  useEffect(() => {
    void getUserPref(P2P_COMBO_CONFIRM_SKIP_PREF_KEY).then((raw) => {
      if (raw === true || raw === 'true') setSkipComboSendConfirm(true);
    });
  }, []);

  useEffect(() => {
    onQuickOpenChange?.(quickOpen);
    return () => onQuickOpenChange?.(false);
  }, [onQuickOpenChange, quickOpen]);

  const overlayOpen = quickOpen
    || menuOpen
    || modelOpen
    || thinkingOpen
    || atPickerOpen
    || p2pOpen
    || p2pConfigOpen
    || openSpecOpen
    || openSpecAuditMenu !== null
    || openSpecProposeMenuOpen
    || voiceOpen
    || !!mobileFileBrowserOpen;

  useEffect(() => {
    onOverlayOpenChange?.(overlayOpen);
    return () => onOverlayOpenChange?.(false);
  }, [mobileFileBrowserOpen, onOverlayOpenChange, overlayOpen]);

  useEffect(() => {
    const syncQueuedHintExpanded = () => setQueuedHintExpanded(loadQueuedHintExpanded());
    const handleStorage = (event: StorageEvent) => {
      if (event.key && event.key !== QUEUED_HINT_EXPANDED_STORAGE_KEY) return;
      syncQueuedHintExpanded();
    };
    window.addEventListener('storage', handleStorage);
    window.addEventListener(QUEUED_HINT_EXPANDED_EVENT, syncQueuedHintExpanded);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(QUEUED_HINT_EXPANDED_EVENT, syncQueuedHintExpanded);
    };
  }, []);

  // Reset P2P mode on session change
  useEffect(() => { setP2pMode('solo'); setP2pOpen(false); }, [activeSession?.name]);
  useEffect(() => {
    setPendingComboSendConfirm(null);
    setRememberComboSendChoice(false);
  }, [activeSession?.name]);
  useEffect(() => {
    setOpenSpecOpen(false);
    setOpenSpecChanges([]);
    setOpenSpecError(null);
    setOpenSpecLoading(false);
    setOpenSpecAuditMenu(null);
    setOpenSpecExpandedChange(null);
    openSpecRequestIdRef.current = null;
  }, [activeSession?.projectDir]);

  // Close menus when clicking outside
  useEffect(() => {
    if (!menuOpen && !modelOpen && !p2pOpen && !thinkingOpen && !openSpecOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuOpen && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setConfirm(null);
        setConfirmLevel(0);
      }
      if (modelOpen && modelRef.current && !modelRef.current.contains(e.target as Node)) {
        setModelOpen(false);
      }
      if (thinkingOpen && thinkingRef.current && !thinkingRef.current.contains(e.target as Node)) {
        setThinkingOpen(false);
      }
      if (p2pOpen && p2pRef.current && !p2pRef.current.contains(e.target as Node)) {
        setP2pOpen(false);
      }
      if (openSpecOpen && openSpecRef.current && !openSpecRef.current.contains(e.target as Node)) {
        setOpenSpecOpen(false);
        setOpenSpecAuditMenu(null);
        setOpenSpecProposeMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen, modelOpen, openSpecOpen, p2pOpen, thinkingOpen]);

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

  const syncMobileComposerMetrics = useCallback(() => {
    if (typeof window === 'undefined' || window.innerWidth > 640) {
      setMobileComposerMultiline(false);
      return;
    }
    const root = divRef.current;
    if (!root) return;
    const computed = window.getComputedStyle(root);
    const lineHeight = Number.parseFloat(computed.lineHeight || '') || 20;
    const verticalPadding = (Number.parseFloat(computed.paddingTop || '') || 0)
      + (Number.parseFloat(computed.paddingBottom || '') || 0);
    const multilineThreshold = (lineHeight * 2) + verticalPadding + 4;
    setMobileComposerMultiline(root.scrollHeight > multilineThreshold);
  }, []);

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
    syncMobileComposerMetrics();
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
    syncMobileComposerMetrics();
  };

  const toComposerReference = useCallback((path: string) => {
    const cwd = activeSession?.projectDir;
    if (cwd) {
      const unixPrefix = `${cwd}/`;
      const winPrefix = `${cwd}\\`;
      if (path.startsWith(unixPrefix)) return `@${path.slice(unixPrefix.length)}`;
      if (path.startsWith(winPrefix)) return `@${path.slice(winPrefix.length).replace(/\\/g, '/')}`;
    }
    return `@${path.replace(/\\/g, '/')}`;
  }, [activeSession?.projectDir]);

  const openSpecChangesPath = useMemo(() => {
    const cwd = activeSession?.projectDir;
    if (!cwd) return null;
    return `${cwd.replace(/[\\/]+$/, '')}/openspec/changes`;
  }, [activeSession?.projectDir]);

  const openP2pConfigPanel = useCallback((tab: P2pConfigTab = 'participants') => {
    setP2pConfigInitialTab(tab);
    setP2pConfigOpen(true);
  }, []);

  const refreshOpenSpecChanges = useCallback(() => {
    if (!ws || !openSpecChangesPath) return;
    setOpenSpecLoading(true);
    setOpenSpecError(null);
    openSpecRequestIdRef.current = ws.fsListDir(openSpecChangesPath, false, false);
  }, [openSpecChangesPath, ws]);

  const insertOpenSpecPrompt = useCallback((kind: 'audit_implementation' | 'audit_spec' | 'implement' | 'propose_from_discussion' | 'propose_from_description', reference?: string) => {
    const prompt = kind === 'audit_implementation'
      ? t('openspec.audit_implementation_prompt', { reference })
      : kind === 'audit_spec'
        ? t('openspec.audit_spec_prompt', { reference })
        : kind === 'implement'
          ? t('openspec.implement_prompt', { reference })
          : kind === 'propose_from_discussion'
            ? t('openspec.propose_from_discussion_prompt')
            : t('openspec.propose_from_description_prompt');
    appendToInput([prompt]);
  }, [t]);

  const openSpecDropdownStyle = useMemo(() => {
    if (!openSpecOpen || typeof window === 'undefined') return undefined;
    const rect = openSpecRef.current?.getBoundingClientRect();
    if (!rect) return undefined;
    const availableHeight = Math.max(96, Math.floor(rect.top - 12));
    if (window.innerWidth > 640) {
      return {
        position: 'fixed',
        right: Math.max(window.innerWidth - rect.right, 8),
        bottom: Math.max(window.innerHeight - rect.top + 4, 8),
        maxHeight: `${availableHeight}px`,
        zIndex: 2147483646,
      } as const;
    }
    return {
      position: 'fixed',
      left: 8,
      right: 8,
      bottom: Math.max(window.innerHeight - rect.top + 4, 72),
      width: 'auto',
      maxWidth: 'none',
      maxHeight: `${availableHeight}px`,
      zIndex: 2147483646,
    } as const;
  }, [openSpecLayoutTick, openSpecOpen]);

  const isOpenSpecMobile = useMemo(
    () => typeof window !== 'undefined' && window.innerWidth <= 640,
    [openSpecLayoutTick, openSpecOpen],
  );

  const openSpecAuditDropdownStyle = isOpenSpecMobile
    ? {
        position: 'fixed',
        left: 8,
        right: 8,
        bottom: 72,
        minWidth: 0,
        width: 'auto',
        maxWidth: 'none',
        zIndex: 2147483647,
      } as const
    : {
        right: 0,
        bottom: 'calc(100% + 6px)',
        minWidth: 180,
        zIndex: 2147483647,
      } as const;

  const openSpecProposeDropdownStyle = isOpenSpecMobile
    ? {
        position: 'fixed',
        left: 8,
        right: 8,
        bottom: 72,
        minWidth: 0,
        width: 'auto',
        maxWidth: 'none',
        zIndex: 2147483647,
      } as const
    : {
        right: 0,
        bottom: 'calc(100% + 6px)',
        minWidth: 220,
        zIndex: 2147483647,
      } as const;

  useEffect(() => {
    if (!openSpecOpen || typeof window === 'undefined') return;
    const refreshLayout = () => setOpenSpecLayoutTick((tick) => tick + 1);
    const viewport = window.visualViewport;
    window.addEventListener('resize', refreshLayout);
    viewport?.addEventListener('resize', refreshLayout);
    viewport?.addEventListener('scroll', refreshLayout);
    return () => {
      window.removeEventListener('resize', refreshLayout);
      viewport?.removeEventListener('resize', refreshLayout);
      viewport?.removeEventListener('scroll', refreshLayout);
    };
  }, [openSpecOpen]);

  const activeSub = (subSessions ?? []).find((s) => s.sessionName === activeSession?.name);
  const rootSession = activeSub?.parentSession || activeSession?.name || '';
  const hasConfiguredP2pParticipants = useMemo(() => {
    if (!p2pSavedConfig?.sessions) return false;
    return Object.values(p2pSavedConfig.sessions).some((entry) => entry?.enabled && entry.mode !== 'skip');
  }, [p2pSavedConfig]);

  // P2P config is per main-session (sub-sessions follow parent), stored on server for cross-device sync
  const p2pConfigKey = rootSession ? `p2p_session_config:${rootSession}` : null;
  const lastDaemonP2pSyncRef = useRef<string>('');
  const pendingP2pConfigSavesRef = useRef<Map<string, PendingP2pConfigSave>>(new Map());
  const resolvePendingP2pConfigSave = useCallback((requestId: string, result: P2pConfigPersistResult) => {
    const pending = pendingP2pConfigSavesRef.current.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingP2pConfigSavesRef.current.delete(requestId);
    pending.resolve(result);
  }, []);
  const rejectAllPendingP2pConfigSaves = useCallback((error: string) => {
    for (const [requestId, pending] of pendingP2pConfigSavesRef.current.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error });
      pendingP2pConfigSavesRef.current.delete(requestId);
    }
  }, []);
  const persistP2pConfigToDaemon = useCallback((
    scopeSession: string,
    config: P2pSavedConfig,
    options?: { awaitAck?: boolean },
  ): Promise<P2pConfigPersistResult> => {
    if (!ws) return Promise.resolve({ ok: false, error: P2P_CONFIG_ERROR.SAVE_TIMEOUT });
    const requestId = globalThis.crypto?.randomUUID?.() ?? `p2p-config-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const awaitAck = options?.awaitAck !== false;
    if (!awaitAck) {
      try {
        ws.send({ type: P2P_CONFIG_MSG.SAVE, requestId, scopeSession, config });
        return Promise.resolve({ ok: true });
      } catch {
        return Promise.resolve({ ok: false, error: P2P_CONFIG_ERROR.SAVE_TIMEOUT });
      }
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolvePendingP2pConfigSave(requestId, { ok: false, error: P2P_CONFIG_ERROR.SAVE_TIMEOUT });
      }, 3000);
      pendingP2pConfigSavesRef.current.set(requestId, { resolve, timer });
      try {
        ws.send({ type: P2P_CONFIG_MSG.SAVE, requestId, scopeSession, config });
      } catch {
        resolvePendingP2pConfigSave(requestId, { ok: false, error: P2P_CONFIG_ERROR.SAVE_TIMEOUT });
      }
    });
  }, [resolvePendingP2pConfigSave, ws]);
  const reloadP2pSavedConfig = useCallback(() => {
    if (!p2pConfigKey) {
      setP2pSavedConfig(null);
      return;
    }
    const apply = (raw: unknown) => {
      if (raw && typeof raw === 'string') {
        try { setP2pSavedConfig(JSON.parse(raw) as P2pSavedConfig); } catch { setP2pSavedConfig(null); }
      } else {
        setP2pSavedConfig(null);
      }
    };
    void getUserPref(p2pConfigKey).then((raw) => {
      if (raw) { apply(raw); return; }
      void getUserPref('p2p_session_config').then((legacyRaw) => {
        if (legacyRaw && typeof legacyRaw === 'string') {
          void saveUserPref(p2pConfigKey, legacyRaw).catch(() => {});
        }
        apply(legacyRaw);
      });
    });
  }, [p2pConfigKey]);
  useEffect(() => {
    reloadP2pSavedConfig();
  }, [reloadP2pSavedConfig]);

  useEffect(() => {
    if (!p2pConfigKey) return;
    return onUserPrefChanged((key) => {
      if (key === p2pConfigKey || key === 'p2p_session_config') {
        reloadP2pSavedConfig();
      }
    });
  }, [p2pConfigKey, reloadP2pSavedConfig]);

  useEffect(() => {
    if (!ws || !rootSession || !p2pSavedConfig) return;
    const signature = `${rootSession}:${JSON.stringify(p2pSavedConfig)}`;
    if (lastDaemonP2pSyncRef.current === signature) return;
    void persistP2pConfigToDaemon(rootSession, p2pSavedConfig, { awaitAck: false }).then((result) => {
      if (result.ok) {
        lastDaemonP2pSyncRef.current = signature;
      }
    });
  }, [persistP2pConfigToDaemon, rootSession, p2pSavedConfig, ws]);

  useEffect(() => {
    return () => {
      rejectAllPendingP2pConfigSaves(P2P_CONFIG_ERROR.SAVE_TIMEOUT);
    };
  }, [rejectAllPendingP2pConfigSaves]);

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((msg: ServerMessage) => {
      if (msg.type === P2P_CONFIG_MSG.SAVE_RESPONSE) {
        resolvePendingP2pConfigSave(msg.requestId, { ok: msg.ok, error: msg.error });
        return;
      }
      if (msg.type === DAEMON_MSG.DISCONNECTED) {
        rejectAllPendingP2pConfigSaves(P2P_CONFIG_ERROR.SAVE_TIMEOUT);
        return;
      }
      if (msg.type === DAEMON_MSG.RECONNECTED) {
        lastDaemonP2pSyncRef.current = '';
        if (rootSession && p2pSavedConfig) {
          void persistP2pConfigToDaemon(rootSession, p2pSavedConfig, { awaitAck: false }).then((result) => {
            if (result.ok) {
              lastDaemonP2pSyncRef.current = `${rootSession}:${JSON.stringify(p2pSavedConfig)}`;
            }
          });
        }
        return;
      }
      const requestId = openSpecRequestIdRef.current;
      if (!requestId || msg.type !== 'fs.ls_response' || msg.requestId !== requestId) return;
      openSpecRequestIdRef.current = null;
      setOpenSpecLoading(false);
      if (msg.status === 'error') {
        const errorText = msg.error ?? 'Unable to scan OpenSpec changes';
        if (/enoent|not found|no such file/i.test(errorText)) {
          setOpenSpecChanges([]);
          setOpenSpecError(null);
          return;
        }
        setOpenSpecChanges([]);
        setOpenSpecError(errorText);
        return;
      }
      const changeNames = (msg.entries ?? [])
        .filter((entry) => entry.isDir)
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
      setOpenSpecChanges(changeNames);
      setOpenSpecError(null);
    });
  }, [persistP2pConfigToDaemon, p2pSavedConfig, rejectAllPendingP2pConfigSaves, resolvePendingP2pConfigSave, rootSession, ws]);

  useEffect(() => {
    if (!hasConfiguredP2pParticipants && isComboMode(p2pMode)) {
      setP2pMode('solo');
    }
  }, [hasConfiguredP2pParticipants, p2pMode]);

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

  const applySavedP2pConfigSelection = useCallback((extra: Record<string, unknown>, mode: string) => {
    if (!p2pSavedConfig || (mode !== P2P_CONFIG_MODE && !isComboMode(mode))) return;
    const selection = buildP2pConfigSelection(p2pSavedConfig, mode);
    extra.p2pSessionConfig = selection.config.sessions;
    extra.p2pRounds = selection.rounds;
    if (selection.config.extraPrompt) extra.p2pExtraPrompt = selection.config.extraPrompt;
    if (selection.config.hopTimeoutMinutes != null) extra.p2pHopTimeoutMs = Math.min(selection.config.hopTimeoutMinutes * 60_000, 600_000);
    if (mode === P2P_CONFIG_MODE) appendOptionalAdvancedP2pConfig(extra, selection.config);
  }, [p2pSavedConfig]);

  const buildSendPayload = useCallback((options?: string | BuildSendPayloadOptions): PendingSendPayload | null => {
    const normalizedOptions: BuildSendPayloadOptions =
      typeof options === 'string' ? { modeOverride: options } : (options ?? {});
    let text = getText();
    if (normalizedOptions.syntheticAtTargets && normalizedOptions.syntheticAtTargets.length > 0) {
      const syntheticPrefix = normalizedOptions.syntheticAtTargets.map((target) => target.label).join(' ');
      text = text ? `${syntheticPrefix} ${text}` : syntheticPrefix;
    }
    const effectiveMode = normalizedOptions.modeOverride ?? p2pMode;
    const syntheticModeOverride = normalizedOptions.syntheticConfigOverride?.modeOverride;
    const allowEmptyCombo = (
      (!!normalizedOptions.modeOverride && isComboMode(normalizedOptions.modeOverride)) ||
      (!!syntheticModeOverride && isComboMode(syntheticModeOverride))
    );
    if (((!text && attachments.length === 0) && !allowEmptyCombo) || !ws || !activeSession) return null;

    // Build P2P routing as structured WS fields — keep text clean for display.
    const extra: Record<string, unknown> = {};
    const pendingTargets = normalizedOptions.syntheticAtTargets
      ? [...normalizedOptions.syntheticAtTargets]
      : [...pendingAtTargetsRef.current];

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
        const override = normalizedOptions.syntheticConfigOverride ?? pendingConfigOverrideRef.current;
        const cfg = override?.config ?? p2pSavedConfig;
        if (cfg) {
          extra.p2pSessionConfig = cfg.sessions;
          extra.p2pRounds = override?.rounds ?? cfg.rounds ?? 1;
          if (cfg.extraPrompt) extra.p2pExtraPrompt = cfg.extraPrompt;
          if (cfg.hopTimeoutMinutes != null) extra.p2pHopTimeoutMs = Math.min(cfg.hopTimeoutMinutes * 60_000, 600_000);
          if (!override?.modeOverride || override.modeOverride === P2P_CONFIG_MODE) appendOptionalAdvancedP2pConfig(extra, cfg);
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
      } else if (effectiveMode !== 'solo' && !text.includes('@@')) {
        // Dropdown P2P mode — daemon handles expansion
        if (effectiveMode === P2P_CONFIG_MODE) {
          extra.p2pMode = 'config';
        } else {
          extra.p2pMode = effectiveMode;
          if (p2pExcludeSameType) extra.p2pExcludeSameType = true;
        }
        applySavedP2pConfigSelection(extra, effectiveMode);
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
    return { text, extra };
  }, [activeSession, applySavedP2pConfigSelection, attachments, i18n?.language, onRemoveQuote, p2pExcludeSameType, p2pMode, p2pSavedConfig, quotes, sessions, subSessions, ws]);

  const buildModeOnlySendPayload = useCallback((rawText: string, modeOverride?: string): PendingSendPayload | null => {
    const text = rawText.trim();
    const effectiveMode = modeOverride ?? p2pMode;
    const allowEmptyCombo = !!modeOverride && isComboMode(modeOverride);
    if ((!text && !allowEmptyCombo) || !ws || !activeSession) return null;

    const extra: Record<string, unknown> = {};
    const manual = extractManualP2pTargets(text, buildManualP2pCandidates(sessions, subSessions));
    let cleanText = manual.cleanText;

    if (manual.orderedTargets.length > 0) {
      extra.p2pAtTargets = manual.orderedTargets;
    } else if (effectiveMode !== 'solo' && !text.includes('@@')) {
      extra.p2pMode = effectiveMode === P2P_CONFIG_MODE ? 'config' : effectiveMode;
      if (p2pExcludeSameType && effectiveMode !== P2P_CONFIG_MODE) extra.p2pExcludeSameType = true;
      applySavedP2pConfigSelection(extra, effectiveMode);
    }

    if (extra.p2pAtTargets || extra.p2pMode) {
      extra.p2pLocale = i18n?.language ?? 'en';
    }

    return { text: cleanText, extra };
  }, [activeSession, applySavedP2pConfigSelection, i18n?.language, p2pExcludeSameType, p2pMode, p2pSavedConfig, sessions, subSessions, ws]);

  const sendSessionMessage = useCallback((text: string, extra: Record<string, unknown> = {}) => {
    if (!ws || !activeSession) return false;
    const commandId = globalThis.crypto?.randomUUID?.() ?? `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    ws.sendSessionCommand('send', {
      sessionName: activeSession.name,
      text,
      ...extra,
      commandId,
    });
    return true;
  }, [activeSession, ws]);

  const finalizeSend = useCallback((payload: PendingSendPayload, options?: { clearComposer?: boolean }) => {
    if (!activeSession) return;
    quickData.recordHistory(payload.text, activeSession.name);
    try {
      if (!sendSessionMessage(payload.text, payload.extra)) return;
    } catch {
      return;
    }
    onSend?.(activeSession.name, payload.text);
    if (options?.clearComposer) {
      pendingAtTargetsRef.current = [];
      pendingConfigOverrideRef.current = null;
      if (divRef.current) divRef.current.textContent = '';
      setHasText(false);
      setMobileComposerExpanded(false);
      setMobileComposerMultiline(false);
      setAttachments([]);
      if (quotes && quotes.length > 0) {
        for (let i = quotes.length - 1; i >= 0; i--) onRemoveQuote?.(i);
      }
      atSelectionLockRef.current = false;
      atSelectionSnapshotRef.current = '';
      histIdxRef.current = -1;
      draftRef.current = '';
      if (draftKey) sessionStorage.removeItem(draftKey);
    }
  }, [activeSession, draftKey, onRemoveQuote, onSend, quickData, quotes, sendSessionMessage]);

  const maybePersistComboSendSkip = useCallback(() => {
    if (!rememberComboSendChoice) return;
    setSkipComboSendConfirm(true);
    void saveUserPref(P2P_COMBO_CONFIRM_SKIP_PREF_KEY, true).catch(() => {});
  }, [rememberComboSendChoice]);

  const getSendValidationError = useCallback((payload: PendingSendPayload): string | null => {
    const text = payload.text.trim();
    const routedModes: string[] = [];
    const directMode = payload.extra.p2pMode;
    if (typeof directMode === 'string') routedModes.push(directMode);
    const atTargets = payload.extra.p2pAtTargets;
    if (Array.isArray(atTargets)) {
      for (const target of atTargets) {
        if (target && typeof target === 'object' && 'mode' in target && typeof target.mode === 'string') {
          routedModes.push(target.mode);
        }
      }
    }
    if (!text && routedModes.some((mode) => isComboMode(mode))) {
      return t('p2p.combo_empty_message_warning');
    }
    if (!hasConfiguredP2pParticipants && routedModes.some((mode) => isComboMode(mode))) {
      return t('p2p.combo_requires_participants_hint');
    }
    return null;
  }, [hasConfiguredP2pParticipants, t]);

  const requestSend = useCallback((payload: PendingSendPayload | null, options?: { clearComposer?: boolean }) => {
    if (!payload) return;
    const validationError = getSendValidationError(payload);
    if (validationError) {
      showSendWarning(validationError);
      return;
    }
    clearSendWarning();
    const comboMode = typeof payload.extra.p2pMode === 'string' ? payload.extra.p2pMode : null;
    if (comboMode && isComboMode(comboMode) && !skipComboSendConfirm) {
      setRememberComboSendChoice(false);
      setPendingComboSendConfirm({
        payload,
        modeLabel: getP2pModeLabel(comboMode, t),
        clearComposer: !!options?.clearComposer,
      });
      return;
    }
    finalizeSend(payload, options);
  }, [clearSendWarning, finalizeSend, getSendValidationError, showSendWarning, skipComboSendConfirm, t]);

  const handleSend = useCallback(() => {
    requestSend(buildSendPayload(), { clearComposer: true });
  }, [buildSendPayload, requestSend]);

  const handleDirectComboSelect = useCallback((mode: string) => {
    setP2pOpen(false);
    const selection = p2pSavedConfig ? buildP2pConfigSelection(p2pSavedConfig, mode) : null;
    const payloadOptions: BuildSendPayloadOptions = selection
      ? {
          modeOverride: mode,
          syntheticAtTargets: [{
            session: '__all__',
            mode: 'config',
            label: selection.rounds > 1 ? `@@all(${selection.modeOverride} ×${selection.rounds})` : `@@all(${selection.modeOverride})`,
          }],
          syntheticConfigOverride: selection,
        }
      : { modeOverride: mode };
    requestSend(buildSendPayload(payloadOptions), { clearComposer: true });
  }, [buildSendPayload, p2pSavedConfig, requestSend]);

  const handleComboSendCancel = useCallback(() => {
    maybePersistComboSendSkip();
    setPendingComboSendConfirm(null);
    setRememberComboSendChoice(false);
  }, [maybePersistComboSendSkip]);

  const handleComboSendConfirm = useCallback(() => {
    const pending = pendingComboSendConfirm;
    if (!pending) return;
    maybePersistComboSendSkip();
    setPendingComboSendConfirm(null);
    setRememberComboSendChoice(false);
    finalizeSend(pending.payload, { clearComposer: pending.clearComposer });
  }, [finalizeSend, maybePersistComboSendSkip, pendingComboSendConfirm]);

  const sendOpenSpecPrompt = useCallback((text: string) => {
    finalizeSend({ text, extra: {} }, { clearComposer: false });
  }, [finalizeSend]);

  // Voice overlay send handler — applies same P2P mode as text send
  const handleVoiceSend = useCallback((voiceText: string) => {
    requestSend(buildModeOnlySendPayload(voiceText));
  }, [buildModeOnlySendPayload, requestSend]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && activeSession?.runtimeType === 'transport' && activeSession.state === 'running') {
      e.preventDefault();
      sendSessionMessage('/stop');
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
    if (!activeSession) return;
    setModel(m);
    try { localStorage.setItem(MODEL_STORAGE_KEY, m); } catch { /* ignore */ }
    sendSessionMessage(`/model ${m}`);
    setModelOpen(false);
    onAfterAction?.();
  };

  const handleCodexModelSelect = (m: CodexModelChoice) => {
    if (!ws || !activeSession) return;
    setCodexModel(m);
    try { localStorage.setItem(CODEX_MODEL_STORAGE_KEY, m); } catch { /* ignore */ }
    if (activeSession.agentType === 'codex-sdk') {
      sendSessionMessage(`/model ${m}`);
    } else {
      const isBrain = activeSession.role === 'brain';
      if (isBrain) {
        sendSessionMessage(`/model ${m} medium`);
      } else {
        ws.subSessionSetModel(activeSession.name, m, activeSession.projectDir);
      }
    }
    setModelOpen(false);
    onAfterAction?.();
  };

  const handleQwenModelSelect = (m: QwenModelChoice) => {
    if (!activeSession) return;
    setQwenModel(m);
    try { localStorage.setItem(QWEN_MODEL_STORAGE_KEY, m); } catch { /* ignore */ }
    sendSessionMessage(`/model ${m}`);
    setModelOpen(false);
    onAfterAction?.();
  };

  const handleThinkingSelect = (level: TransportEffortLevel) => {
    if (!activeSession) return;
    setThinkingOpen(false);
    sendSessionMessage(`/thinking ${level}`);
    onAfterAction?.();
  };

  const toggleQueuedHintExpanded = useCallback(() => {
    setQueuedHintExpanded((current) => {
      const next = !current;
      try {
        localStorage.setItem(QUEUED_HINT_EXPANDED_STORAGE_KEY, next ? '1' : '0');
        window.dispatchEvent(new CustomEvent(QUEUED_HINT_EXPANDED_EVENT));
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  const isMobileLayout = typeof window !== 'undefined' && window.innerWidth <= 640;
  const showEmbeddedVoiceButton = isMobileLayout && VoiceInput.isAvailable() && !hasText;
  const showCompactMetaControls = !!(openSpecChangesPath || isClaudeCode || isCodex || isQwen || supportsThinking || !isShellLike);
  const basePlaceholder = !hasSession
    ? t('session.no_session')
    : !connected
      ? t('session.send_queued')
      : t('session.send_placeholder', { name: sessionDisplayName ?? activeSession?.label ?? activeSession?.project ?? 'session' });
  const placeholder = !hasSession || !connected || isMobileLayout
    ? basePlaceholder
    : compact
      ? basePlaceholder
      : t('session.send_placeholder_desktop_upload', { placeholder: basePlaceholder });

  useEffect(() => {
    if (!isMobileLayout) {
      setMobileComposerExpanded(false);
      setMobileComposerMultiline(false);
      return;
    }
    syncMobileComposerMetrics();
  }, [hasText, isMobileLayout, syncMobileComposerMetrics]);

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
    <div class={`controls-wrapper${showRunningSweep ? ' controls-wrapper-running' : ''}${mobileComposerExpanded ? ' controls-wrapper-mobile-expanded' : ''}`}>
      {/* Header control row — compact mode keeps meta controls but still hides terminal shortcuts */}
      {!hideShortcuts && (!compact || showCompactMetaControls) && <div class="shortcuts-row">
        {!compact && <div class="shortcuts">
          {/* Quick input trigger — shown here (before Esc) when shell terminal hides input row */}
          {isShellLike && (
            <button
              class="shortcut-btn shell-quick-trigger"
              title={t('quick_input.title')}
              onClick={() => setQuickOpen((o) => !o)}
            >⚡</button>
          )}
          {/* Transport sessions: single Stop button instead of terminal shortcuts */}
          {isTransport ? (
            <button
              class="shortcut-btn shortcut-btn-wide"
              title="Stop (/stop)"
              disabled={disabled || activeSession?.state === 'stopped'}
              onClick={() => {
                sendSessionMessage('/stop');
              }}
              style={activeSession?.state === 'running' ? { color: '#f87171' } : undefined}
            >
              Stop
            </button>
          ) : SHORTCUTS.map((s) => (
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
        </div>}

        {/* Model selector — outside overflow-x scroll area so dropdown isn't clipped */}
        {openSpecChangesPath && (
          <div class="shortcuts-model" ref={openSpecRef}>
            <button
              class="shortcut-btn"
              onClick={() => {
                setOpenSpecOpen((open) => {
                  const next = !open;
                  if (!next) {
                    setOpenSpecAuditMenu(null);
                    setOpenSpecProposeMenuOpen(false);
                  }
                  if (next) refreshOpenSpecChanges();
                  return next;
                });
              }}
              disabled={disabled}
              title="OpenSpec changes"
              style={{ color: '#f97316', fontSize: 10, fontWeight: 600 }}
            >
              {t('openspec.title')}
            </button>
            {openSpecOpen && (
              <div class="menu-dropdown menu-dropdown-openspec" style={openSpecDropdownStyle}>
                <div class="openspec-dropdown-scroll">
                <div class="p2p-menu-section-label openspec-section-label">{t('openspec.changes')}</div>
                {openSpecLoading && (
                  <div class="p2p-menu-section-label openspec-section-meta">{t('common.loading')}</div>
                )}
                {!openSpecLoading && openSpecError && (
                  <div class="p2p-menu-section-label openspec-section-meta openspec-section-error">
                    {openSpecError}
                  </div>
                )}
                {!openSpecLoading && !openSpecError && openSpecChanges.length === 0 && (
                  <div class="p2p-menu-section-label openspec-section-meta">{t('openspec.empty')}</div>
                )}
                {!openSpecLoading && !openSpecError && openSpecChanges.map((changeName) => (
                  <div
                    key={changeName}
                    class={`openspec-change-row${isOpenSpecMobile ? ' openspec-change-row-mobile' : ''}${openSpecExpandedChange === changeName ? ' openspec-change-row-expanded' : ''}`}
                  >
                    <div class="openspec-change-header">
                      <button
                        class="menu-item openspec-change-name"
                        onClick={() => {
                          if (!openSpecChangesPath) return;
                          appendToInput([toComposerReference(`${openSpecChangesPath}/${changeName}`)]);
                          setOpenSpecAuditMenu(null);
                          setOpenSpecProposeMenuOpen(false);
                          setOpenSpecOpen(false);
                        }}
                      >
                        {changeName}
                      </button>
                      {isOpenSpecMobile && (
                        <button
                          type="button"
                          class="openspec-change-toggle"
                          aria-label={openSpecExpandedChange === changeName ? `collapse ${changeName}` : `expand ${changeName}`}
                          aria-expanded={openSpecExpandedChange === changeName}
                          onClick={() => {
                            setOpenSpecAuditMenu(null);
                            setOpenSpecProposeMenuOpen(false);
                            setOpenSpecExpandedChange((current) => current === changeName ? null : changeName);
                          }}
                        >
                          {openSpecExpandedChange === changeName ? '▾' : '▸'}
                        </button>
                      )}
                    </div>
                    <div
                      class={`openspec-change-actions${!isOpenSpecMobile || openSpecExpandedChange === changeName ? ' openspec-change-actions-visible' : ''}`}
                      hidden={isOpenSpecMobile && openSpecExpandedChange !== changeName}
                    >
                      <div class="openspec-change-action-wrap">
                        <button
                          class="btn btn-secondary openspec-change-action-btn"
                          onClick={() => {
                            setOpenSpecProposeMenuOpen(false);
                            setOpenSpecAuditMenu((current) => current === changeName ? null : changeName);
                          }}
                        >
                          {t('openspec.audit_action')}
                        </button>
                        {openSpecAuditMenu === changeName && (
                          <div class="menu-dropdown openspec-submenu" style={openSpecAuditDropdownStyle}>
                            <button
                              class="menu-item"
                              onClick={() => {
                                if (!openSpecChangesPath) return;
                                const reference = toComposerReference(`${openSpecChangesPath}/${changeName}`);
                                insertOpenSpecPrompt('audit_implementation', reference);
                                setOpenSpecAuditMenu(null);
                                setOpenSpecOpen(false);
                              }}
                            >
                              {t('openspec.audit_implementation_action')}
                            </button>
                            <button
                              class="menu-item"
                              onClick={() => {
                                if (!openSpecChangesPath) return;
                                const reference = toComposerReference(`${openSpecChangesPath}/${changeName}`);
                                insertOpenSpecPrompt('audit_spec', reference);
                                setOpenSpecAuditMenu(null);
                                setOpenSpecOpen(false);
                              }}
                            >
                              {t('openspec.audit_spec_action')}
                            </button>
                          </div>
                        )}
                      </div>
                      <button
                        class="btn btn-secondary openspec-change-action-btn"
                        onClick={() => {
                          if (!openSpecChangesPath) return;
                          const reference = toComposerReference(`${openSpecChangesPath}/${changeName}`);
                          insertOpenSpecPrompt('implement', reference);
                          setOpenSpecAuditMenu(null);
                          setOpenSpecProposeMenuOpen(false);
                          setOpenSpecOpen(false);
                        }}
                      >
                        {t('openspec.implement_action')}
                      </button>
                      <button
                        class="btn btn-secondary openspec-change-action-btn"
                        onClick={() => {
                          if (!openSpecChangesPath) return;
                          const reference = toComposerReference(`${openSpecChangesPath}/${changeName}`);
                          sendOpenSpecPrompt(t('openspec.achieve_prompt', { reference }));
                          setOpenSpecAuditMenu(null);
                          setOpenSpecProposeMenuOpen(false);
                          setOpenSpecOpen(false);
                        }}
                      >
                        {t('openspec.achieve_action')}
                      </button>
                    </div>
                  </div>
                ))}
                </div>
                <div class="openspec-dropdown-footer">
                  <div class="openspec-change-action-wrap openspec-footer-action-wrap">
                    <button
                      class="btn btn-secondary openspec-change-action-btn"
                      style={{ width: '100%', justifyContent: 'center' }}
                      onClick={() => {
                        setOpenSpecAuditMenu(null);
                        setOpenSpecProposeMenuOpen((open) => !open);
                      }}
                    >
                      {t('openspec.propose_action')}
                    </button>
                    {openSpecProposeMenuOpen && (
                      <div class="menu-dropdown openspec-submenu" style={openSpecProposeDropdownStyle}>
                        <button
                          class="menu-item"
                          onClick={() => {
                            insertOpenSpecPrompt('propose_from_discussion');
                            setOpenSpecAuditMenu(null);
                            setOpenSpecProposeMenuOpen(false);
                            setOpenSpecOpen(false);
                          }}
                        >
                          {t('openspec.propose_from_discussion_action')}
                        </button>
                        <button
                          class="menu-item"
                          onClick={() => {
                            insertOpenSpecPrompt('propose_from_description');
                            setOpenSpecAuditMenu(null);
                            setOpenSpecProposeMenuOpen(false);
                            setOpenSpecOpen(false);
                          }}
                        >
                          {t('openspec.propose_from_description_action')}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
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
                {CLAUDE_CODE_MODEL_IDS.map((m) => (
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
        {supportsThinking && (
          <div class="shortcuts-model" ref={thinkingRef}>
            <button
              class="shortcut-btn"
              onClick={() => setThinkingOpen((o) => !o)}
              disabled={disabled}
              title={currentThinking ? t('session.thinking_title', { value: currentThinking }) : t('session.thinking')}
              style={{ color: currentThinking ? '#38bdf8' : '#6b7280', fontSize: 10 }}
            >
              {currentThinking ?? t('session.thinking')}
            </button>
            {thinkingOpen && (
              <div class="menu-dropdown">
                {thinkingLevels.map((level) => (
                  <button
                    key={level}
                    class={`menu-item ${currentThinking === level ? 'menu-item-active' : ''}`}
                    onClick={() => handleThinkingSelect(level)}
                  >
                    {currentThinking === level ? '● ' : '○ '}{level}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {/* P2P mode selector — hidden for shell/script sessions */}
        {!isShellLike && <div class="shortcuts-model" ref={p2pRef}>
          <button
            class={`shortcut-btn p2p-mode-btn${p2pMode === 'solo' ? ' p2p-mode-btn-solo' : ''}`}
            data-onboarding="p2p-mode"
            onClick={() => setP2pOpen((o) => !o)}
            disabled={disabled}
            title={p2pMode === 'solo' ? getP2pModeLabel('solo', t) : `P2P: ${getP2pModeLabel(p2pMode, t)}`}
            style={{ color: getP2pModeColor(p2pMode), fontSize: 10, fontWeight: p2pMode === 'solo' ? 600 : 700 }}
          >
            {p2pMode === 'solo' ? getP2pModeLabel('solo', t) : `P2P:${getP2pModeLabel(p2pMode, t)}`}
          </button>
          <button
            class="shortcut-btn p2p-settings-btn"
            onClick={() => { setP2pOpen(false); openP2pConfigPanel('participants'); }}
            disabled={disabled}
            title={t('p2p.settings_title')}
            aria-label={t('p2p.settings_button')}
          >
            <span class="p2p-settings-icon" aria-hidden="true">⚙</span>
            <span class="p2p-settings-label">{t('p2p.settings_button')}</span>
          </button>
          {p2pOpen && (
            <div class="menu-dropdown menu-dropdown-p2p">
              <button
                class={`menu-item ${p2pMode === 'solo' ? 'menu-item-active' : ''}`}
                onClick={() => {
                  setP2pMode('solo');
                  setP2pExcludeSameType(false);
                  setP2pOpen(false);
                }}
                style={{ color: getP2pMenuItemColor('solo', p2pMode === 'solo'), fontWeight: p2pMode === 'solo' ? 700 : 600 }}
              >
                {p2pMode === 'solo' ? '● ' : '○ '}{getP2pModeLabel('solo', t)}
              </button>
              <div class="menu-divider" />
              <div class="p2p-menu-section-label">{t('p2p.combo_label')}</div>
              {!hasConfiguredP2pParticipants && (
                <div class="p2p-menu-section-label" style={{ textTransform: 'none', letterSpacing: 'normal', color: '#fbbf24', marginTop: 4 }}>
                  {t('p2p.combo_requires_participants_hint')}
                </div>
              )}
              {comboMenuItems.map((key) => (
                <button
                  key={key}
                  class="menu-item"
                  onClick={() => {
                    if (!hasConfiguredP2pParticipants) return;
                    handleDirectComboSelect(key);
                  }}
                  disabled={!hasConfiguredP2pParticipants}
                  title={!hasConfiguredP2pParticipants ? t('p2p.combo_requires_participants_hint') : undefined}
                  style={{ color: getP2pModeColor(key), fontSize: 12, opacity: hasConfiguredP2pParticipants ? 1 : 0.45, cursor: hasConfiguredP2pParticipants ? 'pointer' : 'not-allowed' }}
                >
                  ○ {getP2pModeLabel(key, t)}
                </button>
              ))}
              <div class="menu-divider" />
              <button
                class="menu-item"
                onClick={() => {
                  setP2pOpen(false);
                  openP2pConfigPanel('combos');
                }}
              >
                {t('p2p.settings_button')}
              </button>
              {p2pMode !== 'solo' && (
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

      {sendWarning && (
        <div style={{ padding: '4px 12px', fontSize: 12, color: '#fbbf24', background: 'rgba(251,191,36,0.12)', borderRadius: 4, margin: '0 8px 4px', border: '1px solid rgba(251,191,36,0.25)' }}>
          {sendWarning}
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
      <div class={`controls${isMobileLayout && mobileComposerMultiline ? ' controls-mobile-multiline' : ''}`}>
        {/* Quick input trigger — left of input */}
        <div class="qp-trigger-wrap" ref={quickWrapRef}>
          {isMobileLayout && (mobileComposerMultiline || mobileComposerExpanded) && (
            <button
              class="btn btn-input-expand btn-input-expand-floating"
              onClick={() => {
                setMobileComposerExpanded((prev) => !prev);
                setTimeout(() => divRef.current?.focus(), 0);
              }}
              title={mobileComposerExpanded ? 'collapse composer' : 'expand composer'}
              aria-label={mobileComposerExpanded ? 'collapse composer' : 'expand composer'}
            >
              {mobileComposerExpanded ? '✕' : '⤢'}
            </button>
          )}
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
              requestSend(buildModeOnlySendPayload(text));
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
        {mobileComposerExpanded && <div class="controls-composer-backdrop" onClick={() => setMobileComposerExpanded(false)} />}
        <div class={`controls-composer${showEmbeddedVoiceButton ? ' controls-composer-with-voice' : ''}${mobileComposerExpanded ? ' controls-composer-mobile-expanded' : ''}`}>
          <div
            ref={divRef}
            class={`controls-input${inputDisabled ? ' controls-input-disabled' : ''}${p2pMode !== 'solo' ? ' controls-input-p2p' : ''}${showEmbeddedVoiceButton ? ' controls-input-with-trailing' : ''}`}
            data-onboarding="chat-input"
            contenteditable={inputDisabled ? 'false' : 'true'}
            role="textbox"
            aria-multiline="true"
            aria-label="Message input"
            data-placeholder={placeholder}
            spellcheck={false}
            enterkeyhint={isMobileLayout ? 'send' : undefined}
            style={p2pMode !== 'solo' ? { borderColor: getP2pModeColor(p2pMode), boxShadow: `0 0 0 1px ${getP2pModeColor(p2pMode)}40` } : undefined}
            onFocus={handleFocus}
            onInput={() => {
              const currentText = divRef.current?.textContent ?? '';
              setHasText(!!currentText.trim());
              syncMobileComposerMetrics();
              if (sendWarning) clearSendWarning();
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
          {showEmbeddedVoiceButton && (
            <button
              class="btn btn-voice btn-voice-embedded"
              onClick={() => setVoiceOpen(true)}
              disabled={inputDisabled}
              title={t('voice.voice_input')}
              aria-label={t('voice.voice_input')}
            >
              🎙
            </button>
          )}
        </div>
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
        {!isMobileLayout && VoiceInput.isAvailable() && (
          <button
            class="btn btn-voice"
            onClick={() => setVoiceOpen(true)}
            disabled={inputDisabled}
            title={t('voice.voice_input')}
          >
            🎙
          </button>
        )}
        {!isMobileLayout && (
          <button
            class="btn btn-primary"
            onClick={handleSend}
            disabled={inputDisabled || (!hasText && attachments.length === 0) || !connected}
          >
            {t('common.send')}
          </button>
        )}
        {/* Config mode: show gear to open settings panel inline with send row */}
        {p2pMode === P2P_CONFIG_MODE && (
          <button
            class="btn btn-secondary"
            onClick={() => openP2pConfigPanel('participants')}
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
      {queuedTransportMessages.length > 0 && (
        <div class="controls-queued-hint" role="status" aria-live="polite">
          <div class="controls-queued-header">
            <div>{t('session.transport_send_queued')}</div>
            <button type="button" class="controls-queued-toggle" onClick={toggleQueuedHintExpanded}>
              {queuedHintExpanded ? t('common.hide') : t('common.show')}
            </button>
          </div>
          <div class="controls-queued-list">
            {queuedHintExpanded ? (
              queuedTransportEntries.map((entry) => (
                <div class="controls-queued-item" key={entry.clientMessageId}>
                  {entry.text}
                </div>
              ))
            ) : (
              <>
                <div class="controls-queued-summary">
                  {t('session.transport_send_queued_collapsed', { count: queuedTransportMessages.length })}
                </div>
                <div class="controls-queued-item" key={`${activeSession?.name ?? 'session'}:latest:${queuedTransportLatestMessage}`}>
                  {queuedTransportLatestMessage}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
    {pendingComboSendConfirm && (
      <div class="dialog-overlay">
        <div class="dialog" style={{ maxWidth: 420 }}>
          <div class="dialog-header">
            <h2>{t('p2p.combo_send_confirm_title')}</h2>
            <button class="dialog-close" onClick={handleComboSendCancel} aria-label={t('common.close')}>×</button>
          </div>
          <div class="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.5 }}>
              {t('p2p.combo_send_confirm_body', { mode: pendingComboSendConfirm.modeLabel })}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#94a3b8', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={rememberComboSendChoice}
                onChange={(e) => setRememberComboSendChoice((e.target as HTMLInputElement).checked)}
              />
              {t('p2p.combo_send_confirm_skip')}
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button class="btn btn-secondary" onClick={handleComboSendCancel}>{t('common.cancel')}</button>
              <button class="btn btn-primary" onClick={handleComboSendConfirm}>{t('common.send')}</button>
            </div>
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
        initialTab={p2pConfigInitialTab}
        onClose={() => setP2pConfigOpen(false)}
        onPersistDaemonConfig={(scopeSession, cfg) => persistP2pConfigToDaemon(scopeSession, cfg)}
        onSave={(cfg) => {
          setP2pSavedConfig(cfg);
        }}
      />
    )}
    </>
  );
}
