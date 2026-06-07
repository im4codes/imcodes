import { useState, useRef, useEffect, useCallback, useMemo } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import type { ComponentChildren, RefObject } from 'preact';
import type { WsClient, ServerMessage } from '../ws-client.js';
import type { SessionInfo } from '../types.js';
import { QuickInputPanel } from './QuickInputPanel.js';
import { getNavigableHistory } from './QuickInputPanel.js';
import type { UseQuickDataResult } from './QuickInputPanel.js';
import { FileBrowser } from './file-browser-lazy.js';
import { CloneSessionGroupDialog } from './CloneSessionGroupDialog.js';
import { useSwipeBack } from '../hooks/useSwipeBack.js';
import { SessionActionMenuIcon } from './SessionActionMenuIcon.js';
import * as VoiceInput from './VoiceInput.js';
import { VoiceOverlay } from './VoiceOverlay.js';
import { AtPicker } from './AtPicker.js';
import { MobileDpad, DPAD_ARROW_SEQUENCES } from './MobileDpad.js';
import { P2pConfigPanel, buildP2pWorkflowLaunchEnvelopeFromConfig } from './P2pConfigPanel.js';
import {
  OpenSpecAutoDeliverCurrentRunEntry,
  OpenSpecAutoDeliverDetailsPanel,
  OpenSpecAutoDeliverLauncher,
} from './OpenSpecAutoDeliver.js';
import { OpenSpecChangeRow } from './OpenSpecChangeRow.js';
import { useOpenSpecAutoDeliver } from '../hooks/useOpenSpecAutoDeliver.js';
import { isOpenSpecAutoDeliverActiveProjection } from '../openspec-auto-deliver.js';
import type { OpenSpecAutoDeliverMaterializedLimits, OpenSpecAutoDeliverPresetId } from '../openspec-auto-deliver.js';
import { isFutureWorkflowSchema } from '@shared/p2p-workflow-validators.js';
import {
  P2P_CAPABILITY_FRESHNESS_TTL_MS,
  P2P_WORKFLOW_CAPABILITY_V1,
} from '@shared/p2p-workflow-constants.js';
import { isRecommendedCombo, useP2pCustomCombos } from './p2p-combos.js';
import { parseBooleanish, usePref } from '../hooks/usePref.js';
import { useSupervisorDefaults } from '../hooks/useSupervisorDefaults.js';
import { PREF_KEY_P2P_COMBO_CONFIRM_SKIP, PREF_KEY_P2P_DROPDOWN_TAB, p2pSessionConfigLegacyPrefKeys, p2pSessionConfigPrefKey } from '../constants/prefs.js';
import { parseP2pSavedConfig, serializeP2pSavedConfig } from '../preferences/p2p-config-pref.js';
import { uploadFile, sendSessionViaHttp, cancelSessionViaHttp } from '../api.js';
import { patchSession, patchSubSession } from '../api.js';
import { isImeComposingKeyEvent } from '../ime-keyboard.js';
import { isRunningSessionState } from '../thinking-utils.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import { MSG_COMMAND_FAILED } from '@shared/ack-protocol.js';
import { FS_READ_ERROR_CODES } from '@shared/fs-read-error-codes.js';
import { isLegacyTransportPendingMessageId, normalizeTransportPendingEntries } from '../transport-queue.js';
import { formatSharedActorLabel } from '../tab-sharing-ui.js';
import { resolveSessionInfoRuntimeType } from '../runtime-type.js';
import {
  buildP2pConfigSelection,
  P2P_CONFIG_MODE,
  COMBO_SEPARATOR,
  isComboMode,
} from '@shared/p2p-modes.js';
import { P2P_CONFIG_ERROR, P2P_CONFIG_MSG } from '@shared/p2p-config-events.js';
import { TRANSPORT_MSG } from '@shared/transport-events.js';
import type { P2pSavedConfig } from '@shared/p2p-modes.js';
import { migrateLegacyWorkflowDraft, normalizeWorkflowLibrary } from '@shared/p2p-workflow-library.js';
import type { P2pWorkflowDraft } from '@shared/p2p-workflow-types.js';
import { getQwenAuthTier, QWEN_AUTH_TIERS, QWEN_AUTH_TYPES } from '@shared/qwen-auth.js';
import { getKnownQwenModelDescription, getKnownQwenModelOptions } from '@shared/qwen-models.js';
import { CLAUDE_CODE_MODEL_IDS, CODEX_MODEL_IDS, GEMINI_MODEL_IDS, mergeModelSuggestions, normalizeClaudeCodeModelId } from '../../../src/shared/models/options.js';
import { CLAUDE_SDK_EFFORT_LEVELS, CODEX_SDK_EFFORT_LEVELS, COPILOT_SDK_EFFORT_LEVELS, OPENCLAW_THINKING_LEVELS, QWEN_EFFORT_LEVELS, formatEffortLevel, type TransportEffortLevel } from '@shared/effort-levels.js';
import { resolveEffectiveSessionModel } from '@shared/session-model.js';
import { useTransportModels, supportsDynamicTransportModels } from '../hooks/useTransportModels.js';
import { loadCodexModelPreference, loadLegacyCodexModelPreferenceForModelessSession, saveCodexModelPreference } from '../codex-model-preference.js';
import {
  buildTransportConfigWithSupervision,
  extractSessionSupervisionSnapshot,
  hasInvalidSessionSupervisionSnapshot,
  parseSessionSupervisionSnapshot,
  isSupportedSupervisionTargetSessionType,
  SUPERVISION_MODE,
  type SessionSupervisionSnapshot,
  type SupervisionMode,
} from '@shared/supervision-config.js';
import { FILE_TRANSFER_LIMITS } from '@shared/transport/file-transfer.js';
import { shouldHideOptimisticUserMessageForSessionControl } from '@shared/session-control-commands.js';
import type { SharedActorEnvelope } from '@shared/tab-sharing.js';

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
  /** Called when Share is selected in the send-adjacent more menu. */
  onShareSession?: (session: SessionInfo, subSessionId?: string | null) => void;
  /** Whether the active session tab is pinned. */
  sessionPinned?: boolean;
  /** Whether stopping the active project is blocked because one of its tabs is pinned. */
  stopBlockedByPinned?: boolean;
  /** Called when the active session should be pinned/unpinned from the menu. */
  onToggleSessionPin?: (sessionName: string) => void;
  /** Sub-session id when the active control surface belongs to a sub-session. */
  subSessionId?: string;
  /** Display name (rename label) for the active session — shown in placeholder. */
  sessionDisplayName?: string | null;
  /** Quick data hook result from parent (loaded once at app level). */
  quickData: UseQuickDataResult;
  /** Model detected from terminal output or usage events for the active session. */
  detectedModel?: string;
  /** Hide the shortcuts row (e.g. in chat mode). */
  hideShortcuts?: boolean;
  /** Called after a message is sent — for local UX only (e.g. optimistic display).
   *  Does not emit timeline events. The `commandId` lets the consumer reconcile
   *  the optimistic bubble with the eventual command.ack / echoed user.message.
   *  `attachments` is the original attachment list so the pending bubble can
   *  surface the same badges the confirmed message will. `extra` is the raw
   *  session.send extras (p2p targets, mode, locale, etc.) — kept so the retry
   *  path can replay the original send faithfully. */
  onSend?: (
    sessionName: string,
    text: string,
    meta?: {
      commandId: string;
      attachments?: Array<Record<string, unknown>>;
      extra?: Record<string, unknown>;
      localFailure?: string;
    },
  ) => void;
  /** Sub-session overrides — when set, menu actions use these instead of main session commands. */
  onSubRestart?: () => void;
  onSubNew?: () => void;
  onSubStop?: () => void;
  /** Legacy prop retained for callers that still pass thinking state for labels/timers. */
  activeThinking?: boolean;
  /** True while transport timeline tail shows an in-flight turn, even if session.state has not caught up. */
  activeTransportTurn?: boolean;
  /** Mobile: open full-screen file browser overlay. */
  mobileFileBrowserOpen?: boolean;
  onMobileFileBrowserClose?: () => void;
  /** All sessions — for @ picker agent list. */
  sessions?: SessionInfo[];
  /** Sub-sessions — for @ picker agent list (includes deck_sub_*). */
  subSessions?: Array<{ sessionName: string; type: string; label?: string | null; state: string; parentSession?: string | null }>;
  /** Server ID — required for file upload. */
  serverId?: string;
  /** Optional larger drop target that should behave like the composer upload area. */
  fileDropTargetRef?: RefObject<HTMLElement>;
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
  /** Optional local optimistic update when transport config changes through quick controls. */
  onTransportConfigSaved?: (transportConfig: Record<string, unknown> | null) => void;
  /** Gate version-sensitive panels when the loaded frontend is stale. */
  onVersionSensitiveAction?: (featureLabel: string, action: () => void) => void;
}

const MAX_UPLOAD_SIZE_MB = Math.round(FILE_TRANSFER_LIMITS.MAX_FILE_SIZE / (1024 * 1024));
export const OPENSPEC_LIST_REQUEST_TIMEOUT_MS = 12_000;
const OPENSPEC_NON_CHANGE_DIR_NAMES = new Set(['archive']);
const TRANSPORT_QUEUE_HIDDEN_KEY_PREFIX = 'imcodes:transport-queue-hidden:';
type LocalQueuedTransportEntry = {
  clientMessageId: string;
  text: string;
  status?: 'sending' | 'queued' | 'failed';
  sharedActor?: SharedActorEnvelope;
};

function transportQueueHiddenStorageKey(serverId: string | undefined, sessionName: string): string {
  const serverPart = encodeURIComponent(serverId || 'local');
  const sessionPart = encodeURIComponent(sessionName);
  return `${TRANSPORT_QUEUE_HIDDEN_KEY_PREFIX}${serverPart}:${sessionPart}`;
}

function readTransportQueueHidden(serverId: string | undefined, sessionName: string | undefined): boolean {
  if (!sessionName) return false;
  try {
    return window.localStorage.getItem(transportQueueHiddenStorageKey(serverId, sessionName)) === '1';
  } catch {
    return false;
  }
}

function writeTransportQueueHidden(storageKey: string | null, hidden: boolean): void {
  if (!storageKey) return;
  try {
    window.localStorage.setItem(storageKey, hidden ? '1' : '0');
  } catch {
    // localStorage may be unavailable in privacy modes; keep in-memory state.
  }
}

type MenuAction = 'restart' | 'new' | 'stop';
type ModelChoice = 'opus[1M]' | 'sonnet' | 'haiku';

const INLINE_PASTE_TEXT_CHAR_LIMIT = 1200;

/*
 * R3 v2 PR-ρ — Composer attachments now carry a per-composer sequence
 * number `seq` (1, 2, 3, ...) so the user can reference them in chat
 * text via short tags like `#1`, `#2`. The badge UI surfaces the tag
 * (`#1 screenshot.png`) and the send-payload text-prepend uses
 * `#1:(/full/daemon/path)` so the LLM sees the short reference and the
 * exact path it can read. The counter resets naturally on send because
 * `clearComposer` clears the attachments array.
 */
type ComposerAttachment = { path: string; name: string; seq: number };

/**
 * Renumber attachments so `seq` is `1..N` in array order. Used after
 * removing a middle attachment so the remaining ones renumber to stay
 * consecutive (otherwise `#1`, `#3`, `#5` gaps would confuse users).
 */
function renumberAttachments(list: ComposerAttachment[]): ComposerAttachment[] {
  return list.map((entry, index) => ({ ...entry, seq: index + 1 }));
}

function buildComposerDraftScope(activeSession: SessionInfo | null, subSessionId?: string): string | null {
  if (subSessionId && subSessionId.trim()) return `sub:${subSessionId.trim()}`;
  if (activeSession?.name?.trim()) return `session:${activeSession.name.trim()}`;
  return null;
}

function buildPastedTextFileName(now = new Date()): string {
  const compact = now.toISOString().replace(/[:.]/g, '-');
  return `pasted-text-${compact}.txt`;
}

function dataTransferHasFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.files && dataTransfer.files.length > 0) return true;
  try {
    return Array.from(dataTransfer.types ?? []).includes('Files');
  } catch {
    return false;
  }
}

function normalizeQueuedText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function parseStoredComposerAttachments(raw: string | null): ComposerAttachment[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    /*
     * R3 v2 PR-ρ — Backward-compat: pre-PR-ρ stored entries have
     * `{ path, name }` only (no `seq`). We renumber the surviving
     * entries 1..N in array order so the badge labels stay
     * consecutive across reloads even when the old entries lack
     * `seq`.
     */
    const list: ComposerAttachment[] = parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const path = typeof (entry as { path?: unknown }).path === 'string'
        ? (entry as { path: string }).path.trim()
        : '';
      const name = typeof (entry as { name?: unknown }).name === 'string'
        ? (entry as { name: string }).name.trim()
        : '';
      if (!path || !name) return [];
      return [{ path, name, seq: 0 }];
    });
    return renumberAttachments(list);
  } catch {
    return [];
  }
}

function appendStoredComposerAttachment(storageKey: string, attachment: ComposerAttachment): ComposerAttachment[] {
  const current = parseStoredComposerAttachments(window.sessionStorage.getItem(storageKey));
  const next = renumberAttachments([...current, attachment]);
  window.sessionStorage.setItem(storageKey, JSON.stringify(next));
  return next;
}

type ComposerUploadSnapshot = {
  uploading: boolean;
  progress: number;
  error: string | null;
};

type ComposerUploadEntry = {
  snapshot: ComposerUploadSnapshot;
  listeners: Set<(snapshot: ComposerUploadSnapshot) => void>;
};

const DEFAULT_COMPOSER_UPLOAD_STATE: ComposerUploadSnapshot = {
  uploading: false,
  progress: 0,
  error: null,
};
const composerUploadStore = new Map<string, ComposerUploadEntry>();

function getComposerUploadEntry(key: string): ComposerUploadEntry {
  let entry = composerUploadStore.get(key);
  if (!entry) {
    entry = { snapshot: { ...DEFAULT_COMPOSER_UPLOAD_STATE }, listeners: new Set() };
    composerUploadStore.set(key, entry);
  }
  return entry;
}

function getComposerUploadSnapshot(key: string): ComposerUploadSnapshot {
  return { ...getComposerUploadEntry(key).snapshot };
}

function updateComposerUploadSnapshot(key: string, patch: Partial<ComposerUploadSnapshot>): void {
  const entry = getComposerUploadEntry(key);
  entry.snapshot = { ...entry.snapshot, ...patch };
  const next = { ...entry.snapshot };
  for (const listener of entry.listeners) listener(next);
}

function subscribeComposerUploadSnapshot(key: string, listener: (snapshot: ComposerUploadSnapshot) => void): () => void {
  const entry = getComposerUploadEntry(key);
  entry.listeners.add(listener);
  listener({ ...entry.snapshot });
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0 && !entry.snapshot.uploading && !entry.snapshot.error) {
      composerUploadStore.delete(key);
    }
  };
}
type CodexModelChoice = string;
type QwenModelChoice = string;
type P2pMode = string; // 'solo' | single modes | combo pipelines like 'brainstorm>discuss>plan' | typeof P2P_CONFIG_MODE

const MODEL_STORAGE_KEY = 'imcodes-model';
const QWEN_MODEL_STORAGE_KEY = 'imcodes-qwen-model';
const CODEX_MODELS: CodexModelChoice[] = [...CODEX_MODEL_IDS];
const CURSOR_HEADLESS_MODEL_SUGGESTIONS = ['gpt-5.2'] as const;
const COPILOT_SDK_MODEL_SUGGESTIONS = ['gpt-5.4', 'gpt-5.4-mini'] as const;
const GEMINI_SDK_MODEL_SUGGESTIONS = [...GEMINI_MODEL_IDS] as const;
const P2P_BASE_MODES = ['solo', 'audit', 'review', 'plan', 'brainstorm', 'discuss', P2P_CONFIG_MODE] as const;
const P2P_DROPDOWN_ROUND_OPTIONS = [1, 2, 3, 5] as const;
const P2P_MODE_I18N: Record<string, string> = { solo: 'p2p.mode_solo', audit: 'p2p.mode_audit', review: 'p2p.mode_review', plan: 'p2p.mode_plan', brainstorm: 'p2p.mode_brainstorm', discuss: 'p2p.mode_discuss', [P2P_CONFIG_MODE]: 'p2p.mode_config' };
const P2P_SINGLE_COLORS: Record<string, string> = { solo: '#dbe7f5', audit: '#f59e0b', review: '#3b82f6', plan: '#06b6d4', brainstorm: '#a78bfa', discuss: '#22c55e', [P2P_CONFIG_MODE]: '#94a3b8' };

function getP2pSoloDisplayLabel(): string {
  return 'Team';
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

function getAnchoredOverlayStyle(
  trigger: DOMRect,
  minWidth: number,
  viewportWidth: number,
  viewportHeight: number,
): React.CSSProperties {
  const horizontalInset = 8;
  const verticalInset = 12;
  const triggerGap = 6;
  const preferredWidth = Math.max(minWidth, Math.ceil(trigger.width));
  const width = Math.min(preferredWidth, viewportWidth - horizontalInset * 2);
  const maxLeft = Math.max(horizontalInset, viewportWidth - width - horizontalInset);
  const left = Math.min(Math.max(trigger.right - width, horizontalInset), maxLeft);
  const rawAbove = Math.floor(trigger.top - verticalInset);
  const rawBelow = Math.floor(viewportHeight - trigger.bottom - verticalInset);
  const shouldOpenBelow = rawBelow >= 180 || rawBelow >= rawAbove;
  const availableAbove = Math.max(96, rawAbove);
  const availableBelow = Math.max(96, rawBelow);

  const style = {
    position: 'fixed',
    left: `${Math.round(left)}px`,
    width: `${Math.round(width)}px`,
    minWidth: `${Math.round(width)}px`,
    maxWidth: `${Math.round(width)}px`,
    maxHeight: `${shouldOpenBelow ? availableBelow : availableAbove}px`,
  } as React.CSSProperties;

  if (shouldOpenBelow) {
    style.top = `${Math.max(Math.round(trigger.bottom + triggerGap), horizontalInset)}px`;
    style.bottom = 'auto'; // clear CSS default bottom: calc(100% + 4px)
  } else {
    style.bottom = `${Math.max(viewportHeight - trigger.top + triggerGap, horizontalInset)}px`;
    style.top = 'auto';
  }

  return style;
}

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

type P2pConfigTab = 'participants' | 'combos' | 'advanced';

type P2pConfigPersistResult = { ok: boolean; error?: string };

type PendingP2pConfigSave = {
  resolve: (result: P2pConfigPersistResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingTransportApproval = {
  sessionId: string;
  requestId: string;
  description: string;
  tool?: string;
};

/** Compute the launch-time capability gate from the live WS client + saved
 *  config. Returns `stale=true` when no daemon.hello has been observed (or the
 *  cached snapshot has aged past `P2P_CAPABILITY_FRESHNESS_TTL_MS`),
 *  `missing` is the set of required capabilities not present, and
 *  `futureSchema=true` if the saved draft/envelope encodes a workflow schema
 *  this client cannot speak. The launch path uses these to decide whether to
 *  attach the envelope. */
function computeAdvancedLaunchCapabilityGate(
  ws: WsClient | null,
  config: P2pSavedConfig,
): { stale: boolean; missing: string[]; futureSchema: boolean } {
  const futureSchema = (config.workflowLaunchEnvelope && isFutureWorkflowSchema(config.workflowLaunchEnvelope))
    || (config.workflowDraft && isFutureWorkflowSchema(config.workflowDraft))
    || false;
  const snapshot = ws?.getDaemonCapabilitySnapshot() ?? null;
  const stale = !snapshot
    || (Date.now() - snapshot.observedAt) > P2P_CAPABILITY_FRESHNESS_TTL_MS;
  const required = new Set<string>([P2P_WORKFLOW_CAPABILITY_V1]);
  const envelopeCaps = config.workflowLaunchEnvelope?.requiredDaemonCapabilities;
  if (Array.isArray(envelopeCaps)) {
    for (const cap of envelopeCaps) if (typeof cap === 'string' && cap) required.add(cap);
  }
  const have = stale ? new Set<string>() : new Set(snapshot?.capabilities ?? []);
  const missing = stale ? [...required] : [...required].filter((cap) => !have.has(cap));
  return { stale, missing, futureSchema };
}

function appendOptionalAdvancedP2pConfig(
  extra: Record<string, unknown>,
  config: P2pSavedConfig,
  launchContext?: { sessionName?: string; projectDir?: string; cwd?: string; userText?: string; locale?: string },
  capabilityGate?: { stale: boolean; missing: string[]; futureSchema: boolean },
): void {
  const hasNewWorkflowConfig = Boolean(config.workflowDraft || config.workflowLaunchEnvelope);
  const hasLegacyAdvancedConfig = Boolean(
    config.advancedPresetKey ||
    config.advancedRounds?.length ||
    config.advancedRunTimeoutMinutes != null ||
    config.contextReducer,
  );
  if (!hasNewWorkflowConfig && !hasLegacyAdvancedConfig) return;
  // smart-p2p-upgrade 9.5–9.7: refuse to attach the launch envelope when the
  // daemon's capability state is stale, the required capability is missing,
  // or the saved config encodes a future schema this client cannot speak.
  // The panel surfaces the matching diagnostic banner; here we just no-op so
  // the daemon never receives an unsupported launch.
  if (capabilityGate?.stale || capabilityGate?.futureSchema) return;
  if ((capabilityGate?.missing.length ?? 0) > 0) return;
  const envelope = buildP2pWorkflowLaunchEnvelopeFromConfig(config, launchContext);
  if (envelope) extra.p2pWorkflowLaunchEnvelope = envelope;
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

function loadQwenModel(): QwenModelChoice | null {
  try {
    const v = localStorage.getItem(QWEN_MODEL_STORAGE_KEY);
    if (v?.trim()) return v;
  } catch { /* ignore */ }
  return null;
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

export function SessionControls({ ws, activeSession, inputRef, onAfterAction, onStopProject, onRenameSession, onSettings, onShareSession, sessionPinned = false, stopBlockedByPinned = false, onToggleSessionPin, subSessionId, sessionDisplayName, quickData, detectedModel, hideShortcuts, onSend, onSubRestart, onSubNew, onSubStop, activeThinking = false, activeTransportTurn = false, mobileFileBrowserOpen, onMobileFileBrowserClose, sessions, subSessions, serverId, fileDropTargetRef, quotes, onRemoveQuote, pendingPrefillText, onPendingPrefillApplied, compact, onQuickOpenChange, onOverlayOpenChange, onTransportConfigSaved, onVersionSensitiveAction }: Props) {
  const { t, i18n } = useTranslation();
  const swipeBackRef = useSwipeBack(onMobileFileBrowserClose);
  const [hasText, setHasText] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [atPickerOpen, setAtPickerOpen] = useState(false);
  const [atQuery, setAtQuery] = useState('');
  const [atPickerStage, setAtPickerStage] = useState<'choose' | 'files' | 'agents' | 'mode' | 'team'>('choose');
  const atJustClosedRef = useRef(false);
  const atSelectionLockRef = useRef(false);
  const atSelectionSnapshotRef = useRef('');
  const [modelOpen, setModelOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
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
  const [openSpecFolderPath, setOpenSpecFolderPath] = useState<string | null>(null);
  const [openSpecAutoLauncherChange, setOpenSpecAutoLauncherChange] = useState<string | null>(null);
  const [openSpecAutoLaunchingChange, setOpenSpecAutoLaunchingChange] = useState<string | null>(null);
  const [openSpecAutoDetailsOpen, setOpenSpecAutoDetailsOpen] = useState(false);
  const [openSpecLayoutTick, setOpenSpecLayoutTick] = useState(0);
  const [model, setModel] = useState<ModelChoice | null>(loadModel);
  const [codexModel, setCodexModel] = useState<CodexModelChoice | null>(loadCodexModelPreference);
  const [qwenModel, setQwenModel] = useState<QwenModelChoice | null>(loadQwenModel);
  const [editingQueuedMessageId, setEditingQueuedMessageId] = useState<string | null>(null);
  const queuedHiddenStorageKey = useMemo(() => (
    activeSession?.name ? transportQueueHiddenStorageKey(serverId, activeSession.name) : null
  ), [activeSession?.name, serverId]);
  const [queuedHintExpanded, setQueuedHintExpanded] = useState(() => (
    !readTransportQueueHidden(serverId, activeSession?.name)
  ));
  const toggleQueuedHintExpanded = useCallback(() => {
    setQueuedHintExpanded((expanded) => {
      const nextExpanded = !expanded;
      writeTransportQueueHidden(queuedHiddenStorageKey, !nextExpanded);
      return nextExpanded;
    });
  }, [queuedHiddenStorageKey]);
  const [optimisticQueuedEntries, setOptimisticQueuedEntries] = useState<LocalQueuedTransportEntry[] | null>(null);
  const [mobileComposerMultiline, setMobileComposerMultiline] = useState(false);
  const [mobileComposerExpanded, setMobileComposerExpanded] = useState(false);
  const [confirm, setConfirm] = useState<MenuAction | null>(null);
  const [confirmLevel, setConfirmLevel] = useState(0); // 0=none, 1=first warning, 2=second warning (sub-session only)
  const [skipComboSendConfirm, setSkipComboSendConfirm] = useState(false);
  const [pendingComboSendConfirm, setPendingComboSendConfirm] = useState<PendingComboSendConfirmation | null>(null);
  const [rememberComboSendChoice, setRememberComboSendChoice] = useState(false);
  const [pendingTransportApproval, setPendingTransportApproval] = useState<PendingTransportApproval | null>(null);
  const [fileDragActive, setFileDragActive] = useState(false);
  const controlsWrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const autoRef = useRef<HTMLDivElement>(null);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const p2pRef = useRef<HTMLDivElement>(null);
  const p2pDropdownRef = useRef<HTMLDivElement | null>(null);
  const openSpecRef = useRef<HTMLDivElement>(null);
  const openSpecDropdownRef = useRef<HTMLDivElement | null>(null);
  const openSpecSubmenuRef = useRef<HTMLDivElement | null>(null);
  const openSpecButtonRef = useRef<HTMLButtonElement | null>(null);
  const openSpecAuditButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const openSpecProposeButtonRef = useRef<HTMLButtonElement | null>(null);
  const openSpecRequestIdRef = useRef<string | null>(null);
  const openSpecRequestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quickWrapRef = useRef<HTMLDivElement>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showRunningSweep = !compact && isRunningSessionState(activeSession?.state);
  const openSpecAutoDeliver = useOpenSpecAutoDeliver({
    ws,
    serverId,
    sessionName: activeSession?.name,
    openSpecOpen,
  });
  const openSpecAutoProjection = openSpecAutoDeliver.projection;
  const openSpecAutoActive = isOpenSpecAutoDeliverActiveProjection(openSpecAutoProjection);
  const openSpecAutoActionLockReason = openSpecAutoActive ? t('openspec.auto.lock_manual_actions') : undefined;
  const effectiveRuntimeType = activeSession ? resolveSessionInfoRuntimeType(activeSession) : undefined;
  const transportSendShouldQueue = effectiveRuntimeType === 'transport'
    && !!activeSession
    && (isRunningSessionState(activeSession.state) || activeThinking || activeTransportTurn);
  const incomingQueuedTransportEntries = effectiveRuntimeType === 'transport'
    ? normalizeTransportPendingEntries(
        activeSession?.transportPendingMessageEntries,
        activeSession?.transportPendingMessages,
        activeSession?.name ?? '',
      )
    : [];
  const queuedTransportEntries = useMemo<LocalQueuedTransportEntry[]>(() => {
    if (optimisticQueuedEntries === null) return incomingQueuedTransportEntries;
    if (optimisticQueuedEntries.length === 0) return [];
    if (incomingQueuedTransportEntries.length === 0) return optimisticQueuedEntries;
    const byId = new Map<string, LocalQueuedTransportEntry>();
    for (const entry of incomingQueuedTransportEntries) byId.set(entry.clientMessageId, { ...entry, status: 'queued' });
    for (const entry of optimisticQueuedEntries) {
      byId.set(entry.clientMessageId, entry);
    }
    return [...byId.values()];
  }, [incomingQueuedTransportEntries, optimisticQueuedEntries]);

  const clearOpenSpecRequestTimer = useCallback(() => {
    if (openSpecRequestTimerRef.current) {
      clearTimeout(openSpecRequestTimerRef.current);
      openSpecRequestTimerRef.current = null;
    }
  }, []);

  const formatOpenSpecLoadError = useCallback((error?: string | null) => {
    const raw = error?.trim();
    if (!raw) return t('openspec.load_error');
    if (raw === FS_READ_ERROR_CODES.PREVIEW_BRIDGE_TIMEOUT || raw === FS_READ_ERROR_CODES.FS_LIST_TIMEOUT) {
      return t('openspec.load_timeout');
    }
    return raw;
  }, [t]);
  const queuedTransportMessages = queuedTransportEntries.map((entry) => entry.text);
  const queuedTransportLatestMessage = queuedTransportMessages[queuedTransportMessages.length - 1] ?? '';
  const editingQueuedEntry = editingQueuedMessageId
    ? queuedTransportEntries.find((entry) => entry.clientMessageId === editingQueuedMessageId) ?? null
    : null;

  const isEditableQueuedEntry = useCallback((entry: { clientMessageId: string }) => (
    !!activeSession && !isLegacyTransportPendingMessageId(entry.clientMessageId, activeSession.name)
  ), [activeSession]);
  const isLocalQueuedEntry = useCallback((entry: { clientMessageId: string }) => (
    !!optimisticQueuedEntries?.some((item) => item.clientMessageId === entry.clientMessageId)
    && !incomingQueuedTransportEntries.some((item) => item.clientMessageId === entry.clientMessageId)
  ), [incomingQueuedTransportEntries, optimisticQueuedEntries]);
  // Internal ref for contenteditable — also written to the external inputRef
  const divRef = useRef<HTMLDivElement>(null);
  // History navigation state
  const histIdxRef = useRef(-1);   // -1 = not navigating; 0 = most recent
  const draftRef = useRef('');      // saved unsent text while navigating
  const imeComposingRef = useRef(false);
  const attachmentDraftRef = useRef<ComposerAttachment[]>([]);
  const composerDraftScope = buildComposerDraftScope(activeSession, subSessionId);
  const draftKey = composerDraftScope ? `rcc_draft_${composerDraftScope}` : null;
  const attachmentDraftKey = composerDraftScope ? `rcc_draft_attachments_${composerDraftScope}` : null;
  const attachmentDraftKeyRef = useRef<string | null>(attachmentDraftKey);
  attachmentDraftKeyRef.current = attachmentDraftKey;
  const mountedRef = useRef(true);
  const composerUploadKey = composerDraftScope ? `composer:${composerDraftScope}` : 'composer:global';
  // File upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadSnapshot, setUploadSnapshot] = useState(() => getComposerUploadSnapshot(composerUploadKey));
  const uploading = uploadSnapshot.uploading;
  const uploadProgress = uploadSnapshot.progress;
  const uploadError = uploadSnapshot.error;
  const [sendWarning, setSendWarning] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const sendWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [localTransportConfig, setLocalTransportConfig] = useState<Record<string, unknown> | null>(activeSession?.transportConfig ?? null);

  // Keep external inputRef in sync so parent can call .focus()
  useEffect(() => {
    if (inputRef) (inputRef as { current: HTMLDivElement | null }).current = divRef.current;
  });

  useEffect(() => {
    const el = divRef.current;
    if (!el) return;
    const handleCompositionStart = () => { imeComposingRef.current = true; };
    const handleCompositionEnd = () => { imeComposingRef.current = false; };
    el.addEventListener('compositionstart', handleCompositionStart);
    el.addEventListener('compositionend', handleCompositionEnd);
    return () => {
      el.removeEventListener('compositionstart', handleCompositionStart);
      el.removeEventListener('compositionend', handleCompositionEnd);
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
  const [hydratedAttachmentDraftKey, setHydratedAttachmentDraftKey] = useState<string | null>(null);
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

  useEffect(() => {
    setHydratedAttachmentDraftKey(null);
    if (!attachmentDraftKey) {
      setAttachments([]);
      attachmentDraftRef.current = [];
      return;
    }
    const saved = parseStoredComposerAttachments(sessionStorage.getItem(attachmentDraftKey));
    setAttachments(saved);
    attachmentDraftRef.current = saved;
    setHydratedAttachmentDraftKey(attachmentDraftKey);
  }, [attachmentDraftKey]);

  useEffect(() => {
    attachmentDraftRef.current = attachments;
    if (!attachmentDraftKey || hydratedAttachmentDraftKey !== attachmentDraftKey) return;
    try {
      if (attachments.length > 0) sessionStorage.setItem(attachmentDraftKey, JSON.stringify(attachments));
      else sessionStorage.removeItem(attachmentDraftKey);
    } catch {
      /* ignore */
    }
  }, [attachmentDraftKey, attachments, hydratedAttachmentDraftKey]);

  useEffect(() => subscribeComposerUploadSnapshot(composerUploadKey, setUploadSnapshot), [composerUploadKey]);

  useEffect(() => () => {
    if (sendWarningTimerRef.current) clearTimeout(sendWarningTimerRef.current);
  }, []);

  useEffect(() => {
    setLocalTransportConfig(activeSession?.transportConfig ?? null);
  }, [activeSession?.name, activeSession?.transportConfig]);

  useEffect(() => {
    setPendingTransportApproval((current) => {
      if (!current) return current;
      if (effectiveRuntimeType !== 'transport') return null;
      return current.sessionId === activeSession?.name ? current : null;
    });
  }, [activeSession?.name, effectiveRuntimeType]);

  const connected = !!ws?.connected;

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((msg) => {
      if (!activeSession || effectiveRuntimeType !== 'transport') return;
      if (msg.type === TRANSPORT_MSG.CHAT_APPROVAL && msg.sessionId === activeSession.name) {
        setPendingTransportApproval({
          sessionId: msg.sessionId,
          requestId: msg.requestId,
          description: msg.description,
          ...(msg.tool ? { tool: msg.tool } : {}),
        });
        return;
      }
      if (msg.type === TRANSPORT_MSG.APPROVAL_RESPONSE && msg.sessionId === activeSession.name) {
        setPendingTransportApproval((current) => (
          current?.sessionId === msg.sessionId && current.requestId === msg.requestId
            ? null
            : current
        ));
      }
    });
  }, [activeSession, effectiveRuntimeType, ws]);

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
    if (detectedModel.startsWith('gpt-')) {
      if (codexModel !== detectedModel) setCodexModel(detectedModel);
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

  const hasSession = !!activeSession;
  const canShowCloneGroupAction = !!activeSession
    && !subSessionId
    && !compact
    && activeSession.role === 'brain'
    && !activeSession.name.startsWith('deck_sub_')
    && activeSession.userCreated !== false;
  const canShowPinAction = !!activeSession
    && !subSessionId
    && !compact
    && !!onToggleSessionPin;
  const sharedState = activeSession?.sharedState ?? null;
  const isShareScopedSession = !!sharedState;
  const canSharedSessionSend = !isShareScopedSession
    || (sharedState?.status === 'active' && sharedState.effectiveRole === 'participant');
  // Input only disabled when there's no session or the active share cannot dispatch messages.
  const inputDisabled = !hasSession || !canSharedSessionSend;
  // Send/action buttons disabled when disconnected, missing a session, or share-scoped direct controls are unavailable.
  const disabled = !connected || !hasSession || isShareScopedSession;
  const isClaudeCode = activeSession?.agentType === 'claude-code' || activeSession?.agentType === 'claude-code-sdk';
  const isShellLike = activeSession?.agentType === 'shell' || activeSession?.agentType === 'script';
  const isTransport = effectiveRuntimeType === 'transport';
  const currentTransportConfig = localTransportConfig ?? activeSession?.transportConfig ?? null;
  const hasInvalidSupervisionConfig = hasInvalidSessionSupervisionSnapshot(currentTransportConfig);
  const supervisionSnapshot = extractSessionSupervisionSnapshot(currentTransportConfig);
  const quickSupervisionMode = supervisionSnapshot?.mode ?? SUPERVISION_MODE.OFF;
  const canQuickControlSupervision = !!(
    activeSession
    && serverId
    && isTransport
    && isSupportedSupervisionTargetSessionType(activeSession.agentType)
  );
  const supervisorDefaultsPref = useSupervisorDefaults(canQuickControlSupervision);
  const isCodex = activeSession?.agentType === 'codex' || activeSession?.agentType === 'codex-sdk';
  const isQwen = activeSession?.agentType === 'qwen';
  const isCopilot = activeSession?.agentType === 'copilot-sdk';
  const isCursorHeadless = activeSession?.agentType === 'cursor-headless';
  const isGeminiSdk = activeSession?.agentType === 'gemini-sdk';
  const isKimiSdk = activeSession?.agentType === 'kimi-sdk';
  const supportsGenericTransportModelSelect = isCopilot || isCursorHeadless || isGeminiSdk || isKimiSdk;
  // Source-of-truth priority for the model picker:
  //   1. `useTransportModels` — live daemon probe via `transport.list_models`
  //      WS round-trip. Works uniformly for main sessions AND sub-sessions
  //      (sub-session SessionInfo records aren't hydrated with
  //      provider-specific availableModels, so we can't rely on activeSession).
  //   2. `activeSession?.{copilot,cursor}AvailableModels` — cached
  //      hydration set by `buildSessionList()` for main sessions (first
  //      paint before the WS probe reply arrives).
  //   3. Provider-specific fallback constants where available.
  const dynamicModelsAgentType = supportsDynamicTransportModels(activeSession?.agentType)
    ? activeSession!.agentType
    : null;
  const dynamicTransportModels = useTransportModels(ws, dynamicModelsAgentType);
  const genericTransportModelSuggestions: readonly string[] = useMemo(() => {
    if (dynamicTransportModels.models.length > 0) {
      const dynamicModelIds = dynamicTransportModels.models.map((m) => m.id);
      return isGeminiSdk
        ? mergeModelSuggestions(GEMINI_SDK_MODEL_SUGGESTIONS, dynamicModelIds)
        : dynamicModelIds;
    }
    if (isCopilot) {
      const probed = activeSession?.copilotAvailableModels;
      if (probed && probed.length > 0) return probed;
      return COPILOT_SDK_MODEL_SUGGESTIONS;
    }
    if (isCursorHeadless) {
      const probed = activeSession?.cursorAvailableModels;
      if (probed && probed.length > 0) return probed;
      return CURSOR_HEADLESS_MODEL_SUGGESTIONS;
    }
    if (isGeminiSdk) {
      return GEMINI_SDK_MODEL_SUGGESTIONS;
    }
    if (isKimiSdk) {
      return dynamicTransportModels.models.map((m) => m.id);
    }
    return [];
  }, [
    dynamicTransportModels.models,
    isCopilot,
    isCursorHeadless,
    isGeminiSdk,
    isKimiSdk,
    activeSession?.copilotAvailableModels,
    activeSession?.cursorAvailableModels,
  ]);
  const codexModelSuggestions: readonly string[] = useMemo(() => {
    if (activeSession?.agentType !== 'codex-sdk') return CODEX_MODELS;
    if (dynamicTransportModels.models.length > 0) {
      return dynamicTransportModels.models.map((m) => m.id);
    }
    if (activeSession?.codexAvailableModels?.length) return activeSession.codexAvailableModels;
    return CODEX_MODELS;
  }, [
    activeSession?.agentType,
    activeSession?.codexAvailableModels,
    dynamicTransportModels.models,
  ]);
  const legacyCodexModel = loadLegacyCodexModelPreferenceForModelessSession(activeSession, detectedModel);
  const genericTransportModel = resolveEffectiveSessionModel(activeSession, detectedModel, legacyCodexModel) ?? null;
  const displayedCodexModel = activeSession?.agentType === 'codex-sdk'
    ? genericTransportModel
    : (genericTransportModel ?? codexModel);
  const qwenCompatibleApiSession = activeSession?.agentType === 'qwen'
    && (!!activeSession?.ccPreset || activeSession?.qwenAuthType === QWEN_AUTH_TYPES.API_KEY);
  const thinkingLevels = useMemo((): readonly TransportEffortLevel[] => (
    activeSession?.agentType === 'claude-code-sdk'
      ? CLAUDE_SDK_EFFORT_LEVELS
      : activeSession?.agentType === 'codex-sdk'
        ? CODEX_SDK_EFFORT_LEVELS
        : activeSession?.agentType === 'qwen'
          ? (qwenCompatibleApiSession ? ['high'] : QWEN_EFFORT_LEVELS)
          : activeSession?.agentType === 'copilot-sdk'
            ? COPILOT_SDK_EFFORT_LEVELS
          : activeSession?.agentType === 'openclaw'
            ? OPENCLAW_THINKING_LEVELS
            : []
  ), [activeSession?.agentType, qwenCompatibleApiSession]);
  const supportsThinking = thinkingLevels.length > 0;
  // Default the pill to a sensible value whenever the agent supports thinking
  // but the session doesn't yet have an `effort` persisted. Prefer 'high' if
  // the agent's level set includes it (true for every current transport type),
  // otherwise pick the last level which is conventionally the strongest.
  const defaultThinkingForAgent: TransportEffortLevel | undefined = supportsThinking
    ? (thinkingLevels.includes('high' as TransportEffortLevel)
        ? 'high'
        : thinkingLevels[thinkingLevels.length - 1])
    : undefined;
  const persistedThinking = activeSession?.effort as TransportEffortLevel | undefined;
  const currentThinking = persistedThinking && thinkingLevels.includes(persistedThinking)
    ? persistedThinking
    : defaultThinkingForAgent;
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

  // R3 v2 PR-κ — Workflow library list available for the active session.
  // Normalised + migrated from legacy single-draft on read so the dropdown
  // never sees malformed entries even when an older client wrote the
  // saved config.
  const workflowLibraryItems = useMemo(() => {
    if (!p2pSavedConfig) return [] as P2pWorkflowDraft[];
    const migrated = migrateLegacyWorkflowDraft(p2pSavedConfig);
    return normalizeWorkflowLibrary(migrated.workflowLibrary ?? []);
  }, [p2pSavedConfig]);

  // R3 v2 PR-κ — Persist the dropdown's active tab globally so the user's
  // choice ("combos" vs. "workflows") follows them across sessions and
  // survives a page reload. Default falls back to the safer "combos" tab
  // because that's what the dropdown shipped with for years.
  const dropdownTabPref = usePref<string>(PREF_KEY_P2P_DROPDOWN_TAB);
  type P2pDropdownTab = 'combos' | 'workflows';
  const dropdownActiveTab: P2pDropdownTab = dropdownTabPref.value === 'workflows' ? 'workflows' : 'combos';
  const setDropdownActiveTab = useCallback((tab: P2pDropdownTab) => {
    void dropdownTabPref.save(tab).catch(() => {});
  }, [dropdownTabPref]);

  const comboSkipPref = usePref<boolean>(PREF_KEY_P2P_COMBO_CONFIRM_SKIP, { parse: parseBooleanish });
  useEffect(() => {
    if (comboSkipPref.value === true) setSkipComboSendConfirm(true);
  }, [comboSkipPref.value]);

  useEffect(() => {
    onQuickOpenChange?.(quickOpen);
    return () => onQuickOpenChange?.(false);
  }, [onQuickOpenChange, quickOpen]);

  const overlayOpen = quickOpen
    || menuOpen
    || modelOpen
    || autoOpen
    || thinkingOpen
    || atPickerOpen
    || p2pOpen
    || p2pConfigOpen
    || openSpecOpen
    || cloneDialogOpen
    || openSpecAuditMenu !== null
    || openSpecProposeMenuOpen
    || !!openSpecFolderPath
    || voiceOpen
    || !!mobileFileBrowserOpen;

  useEffect(() => {
    onOverlayOpenChange?.(overlayOpen);
    return () => onOverlayOpenChange?.(false);
  }, [mobileFileBrowserOpen, onOverlayOpenChange, overlayOpen]);

  useEffect(() => {
    setQueuedHintExpanded(!readTransportQueueHidden(serverId, activeSession?.name));
  }, [activeSession?.name, serverId]);

  useEffect(() => {
    if (!editingQueuedMessageId) return;
    if (!queuedTransportEntries.some((entry) => entry.clientMessageId === editingQueuedMessageId)) {
      setEditingQueuedMessageId(null);
    }
  }, [editingQueuedMessageId, queuedTransportEntries]);

  const incomingQueuedTransportEntriesKey = useMemo(
    () => JSON.stringify(incomingQueuedTransportEntries),
    [incomingQueuedTransportEntries],
  );
  const lastIncomingQueuedTransportEntriesKeyRef = useRef(incomingQueuedTransportEntriesKey);
  const lastIncomingQueuedTransportEntriesCountRef = useRef(incomingQueuedTransportEntries.length);
  const lastIncomingQueuedTransportEntryIdsRef = useRef(new Set(incomingQueuedTransportEntries.map((entry) => entry.clientMessageId)));
  useEffect(() => {
    if (effectiveRuntimeType !== 'transport') {
      setOptimisticQueuedEntries(null);
      lastIncomingQueuedTransportEntriesKeyRef.current = incomingQueuedTransportEntriesKey;
      lastIncomingQueuedTransportEntriesCountRef.current = incomingQueuedTransportEntries.length;
      lastIncomingQueuedTransportEntryIdsRef.current = new Set(incomingQueuedTransportEntries.map((entry) => entry.clientMessageId));
      return;
    }
    const previousIds = lastIncomingQueuedTransportEntryIdsRef.current;
    const previousCount = lastIncomingQueuedTransportEntriesCountRef.current;
    const incomingChanged = lastIncomingQueuedTransportEntriesKeyRef.current !== incomingQueuedTransportEntriesKey;
    if (incomingChanged && incomingQueuedTransportEntries.length > 0) {
      const incomingIds = new Set(incomingQueuedTransportEntries.map((entry) => entry.clientMessageId));
      setOptimisticQueuedEntries((prev) => {
        if (!prev) return null;
        const remaining = prev.filter((entry) => !incomingIds.has(entry.clientMessageId));
        return remaining.length > 0 ? remaining : null;
      });
    } else if (incomingChanged && previousCount > 0 && incomingQueuedTransportEntries.length === 0) {
      setOptimisticQueuedEntries((prev) => {
        if (!prev) return null;
        const remaining = prev.filter((entry) => !previousIds.has(entry.clientMessageId));
        return remaining.length > 0 ? remaining : null;
      });
    }
    lastIncomingQueuedTransportEntriesKeyRef.current = incomingQueuedTransportEntriesKey;
    lastIncomingQueuedTransportEntriesCountRef.current = incomingQueuedTransportEntries.length;
    lastIncomingQueuedTransportEntryIdsRef.current = new Set(incomingQueuedTransportEntries.map((entry) => entry.clientMessageId));
  }, [activeSession?.name, effectiveRuntimeType, incomingQueuedTransportEntries.length, incomingQueuedTransportEntriesKey]);

  useEffect(() => {
    if (!ws || !activeSession) return;
    return ws.onMessage((msg: ServerMessage) => {
      const removeLocalQueuedEntry = (commandId: string, text?: string) => {
        if (!commandId && !text) return;
        const normalizedText = typeof text === 'string' ? normalizeQueuedText(text) : '';
        setOptimisticQueuedEntries((prev) => {
          if (!prev) return prev;
          const next = prev.filter((entry) => {
            if (commandId && entry.clientMessageId === commandId) return false;
            if (!commandId && normalizedText && normalizeQueuedText(entry.text) === normalizedText) return false;
            return true;
          });
          return next.length > 0 ? next : null;
        });
      };
      const markLocalQueuedEntry = (commandId: string, status: LocalQueuedTransportEntry['status']) => {
        if (!commandId) return;
        setOptimisticQueuedEntries((prev) => {
          if (!prev) return prev;
          let changed = false;
          const next = prev.map((entry) => {
            if (entry.clientMessageId !== commandId || entry.status === status) return entry;
            changed = true;
            return { ...entry, status };
          });
          return changed ? next : prev;
        });
      };

      if (msg.type === 'command.ack') {
        if (msg.session && msg.session !== activeSession.name) return;
        if (msg.status === 'error' || msg.status === 'conflict') {
          markLocalQueuedEntry(msg.commandId, 'failed');
        } else {
          markLocalQueuedEntry(msg.commandId, 'queued');
        }
        return;
      }
      if (msg.type === MSG_COMMAND_FAILED) {
        if (msg.session && msg.session !== activeSession.name) return;
        markLocalQueuedEntry(msg.commandId, 'failed');
        return;
      }
      if (msg.type !== 'timeline.event') return;
      const event = msg.event;
      if (event.sessionId !== activeSession.name) return;
      if (event.type === 'user.message') {
        const commandId = typeof event.payload.commandId === 'string'
          ? event.payload.commandId
          : typeof event.payload.clientMessageId === 'string'
            ? event.payload.clientMessageId
            : '';
        removeLocalQueuedEntry(commandId, typeof event.payload.text === 'string' ? event.payload.text : undefined);
      } else if (event.type === 'session.state') {
        const hasPendingSnapshot = Object.prototype.hasOwnProperty.call(event.payload ?? {}, 'pendingMessageEntries')
          || Object.prototype.hasOwnProperty.call(event.payload ?? {}, 'pendingMessages');
        const queuedEntries = normalizeTransportPendingEntries(
          event.payload.pendingMessageEntries,
          event.payload.pendingMessages,
          activeSession.name,
        );
        if (queuedEntries.length === 0) {
          if (hasPendingSnapshot) setOptimisticQueuedEntries(null);
          return;
        }
        const queuedIds = new Set(queuedEntries.map((entry) => entry.clientMessageId));
        setOptimisticQueuedEntries((prev) => {
          if (!prev) return prev;
          const next = prev.filter((entry) => !queuedIds.has(entry.clientMessageId));
          return next.length > 0 ? next : null;
        });
      }
    });
  }, [activeSession, ws]);

  // Reset P2P mode on session change
  useEffect(() => { setP2pMode('solo'); setP2pOpen(false); }, [activeSession?.name]);
  useEffect(() => { setCloneDialogOpen(false); }, [activeSession?.name]);
  useEffect(() => {
    setPendingComboSendConfirm(null);
    setRememberComboSendChoice(false);
  }, [activeSession?.name]);
  useEffect(() => () => clearOpenSpecRequestTimer(), [clearOpenSpecRequestTimer]);
  useEffect(() => {
    clearOpenSpecRequestTimer();
    setOpenSpecOpen(false);
    setOpenSpecChanges([]);
    setOpenSpecError(null);
    setOpenSpecLoading(false);
    setOpenSpecAuditMenu(null);
    setOpenSpecProposeMenuOpen(false);
    setOpenSpecExpandedChange(null);
    setOpenSpecFolderPath(null);
    setOpenSpecAutoLauncherChange(null);
    setOpenSpecAutoDetailsOpen(false);
    openSpecRequestIdRef.current = null;
  }, [activeSession?.projectDir, clearOpenSpecRequestTimer]);

  // Close menus as soon as the pointer starts outside. On Android Chrome, waiting
  // for the synthesized click can leave a model dropdown in front of the next
  // sub-session tap after the viewport/layout shifts.
  useEffect(() => {
    if (!menuOpen && !modelOpen && !autoOpen && !p2pOpen && !thinkingOpen && !openSpecOpen) return;
    const handleOutsidePointer = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return;
      if (menuOpen && menuRef.current && !menuRef.current.contains(target)) {
        setMenuOpen(false);
        setConfirm(null);
        setConfirmLevel(0);
      }
      if (modelOpen && modelRef.current && !modelRef.current.contains(target)) {
        setModelOpen(false);
      }
      if (autoOpen && autoRef.current && !autoRef.current.contains(target)) {
        setAutoOpen(false);
      }
      if (thinkingOpen && thinkingRef.current && !thinkingRef.current.contains(target)) {
        setThinkingOpen(false);
      }
      if (
        p2pOpen
        && p2pRef.current
        && !p2pRef.current.contains(target)
        && !p2pDropdownRef.current?.contains(target)
      ) {
        setP2pOpen(false);
      }
      if (
        openSpecOpen
        && openSpecRef.current
        && !openSpecRef.current.contains(target)
        && !openSpecDropdownRef.current?.contains(target)
        && !openSpecSubmenuRef.current?.contains(target)
      ) {
        setOpenSpecOpen(false);
        setOpenSpecAuditMenu(null);
        setOpenSpecProposeMenuOpen(false);
        setOpenSpecAutoLauncherChange(null);
      }
    };
    const handlePointerDown = (e: PointerEvent) => handleOutsidePointer(e.target);
    const handleTouchStart = (e: TouchEvent) => handleOutsidePointer(e.target);
    const handleMouseDown = (e: MouseEvent) => handleOutsidePointer(e.target);
    const pointerOptions = { capture: true } as AddEventListenerOptions;
    const touchOptions = { capture: true, passive: true } as AddEventListenerOptions;
    document.addEventListener('pointerdown', handlePointerDown, pointerOptions);
    document.addEventListener('touchstart', handleTouchStart, touchOptions);
    document.addEventListener('mousedown', handleMouseDown, pointerOptions);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, pointerOptions);
      document.removeEventListener('touchstart', handleTouchStart, touchOptions);
      document.removeEventListener('mousedown', handleMouseDown, pointerOptions);
    };
  }, [autoOpen, menuOpen, modelOpen, openSpecOpen, p2pOpen, thinkingOpen]);

  const quickAutoColor = quickSupervisionMode === SUPERVISION_MODE.SUPERVISED
    ? '#34d399'
    : quickSupervisionMode === SUPERVISION_MODE.SUPERVISED_AUDIT
      ? '#f59e0b'
      : '#94a3b8';

  const persistTransportConfig = useCallback(async (transportConfig: Record<string, unknown> | null) => {
    if (!serverId || !activeSession) return;
    if (subSessionId) {
      await patchSubSession(serverId, subSessionId, { transportConfig });
    } else {
      await patchSession(serverId, activeSession.name, { transportConfig });
    }
    setLocalTransportConfig(transportConfig);
    onTransportConfigSaved?.(transportConfig);
  }, [activeSession, onTransportConfigSaved, serverId, subSessionId]);

  const handleQuickSupervisionModeSelect = useCallback(async (nextMode: SupervisionMode) => {
    if (!activeSession || !serverId || !canQuickControlSupervision) return;

    if (nextMode === SUPERVISION_MODE.OFF) {
      const nextTransportConfig = buildTransportConfigWithSupervision(currentTransportConfig, { mode: SUPERVISION_MODE.OFF });
      try {
        await persistTransportConfig(nextTransportConfig);
        setAutoOpen(false);
      } catch {
        showSendWarning(t('upload.upload_failed'));
      }
      return;
    }

    if (hasInvalidSupervisionConfig) {
      setAutoOpen(false);
      onSettings?.();
      return;
    }

    const rawSupervision = currentTransportConfig && typeof currentTransportConfig === 'object' && !Array.isArray(currentTransportConfig)
      ? (currentTransportConfig.supervision as Record<string, unknown> | undefined)
      : undefined;
    let nextSnapshot: Partial<SessionSupervisionSnapshot> | null = null;
    if (supervisionSnapshot) {
      const auditCandidate = nextMode === SUPERVISION_MODE.SUPERVISED_AUDIT && rawSupervision
        ? parseSessionSupervisionSnapshot({ ...rawSupervision, mode: SUPERVISION_MODE.SUPERVISED_AUDIT })
        : null;
      if (nextMode === SUPERVISION_MODE.SUPERVISED_AUDIT && !auditCandidate) {
        setAutoOpen(false);
        onSettings?.();
        return;
      }
      nextSnapshot = { ...supervisionSnapshot, mode: nextMode };
    } else {
      const defaults = supervisorDefaultsPref.value ?? (supervisorDefaultsPref.loaded ? null : await supervisorDefaultsPref.reload());
      if (!defaults) {
        setAutoOpen(false);
        onSettings?.();
        return;
      }
      if (nextMode === SUPERVISION_MODE.SUPERVISED_AUDIT) {
        setAutoOpen(false);
        onSettings?.();
        return;
      }
      nextSnapshot = {
        mode: nextMode,
        backend: defaults.backend,
        model: defaults.model,
        timeoutMs: defaults.timeoutMs,
        promptVersion: defaults.promptVersion,
        maxAutoContinueStreak: defaults.maxAutoContinueStreak,
        maxAutoContinueTotal: defaults.maxAutoContinueTotal,
      };
    }

    const nextTransportConfig = buildTransportConfigWithSupervision(currentTransportConfig, nextSnapshot);
    try {
      await persistTransportConfig(nextTransportConfig);
      setAutoOpen(false);
    } catch {
      showSendWarning(t('upload.upload_failed'));
    }
  }, [
    activeSession,
    canQuickControlSupervision,
    currentTransportConfig,
    hasInvalidSupervisionConfig,
    onSettings,
    persistTransportConfig,
    quickSupervisionMode,
    serverId,
    showSendWarning,
    supervisionSnapshot,
    supervisorDefaultsPref.loaded,
    supervisorDefaultsPref.reload,
    supervisorDefaultsPref.value,
    t,
  ]);

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

  const openOpenSpecChangeFolder = useCallback((changeName: string) => {
    if (!openSpecChangesPath) return;
    setOpenSpecFolderPath(`${openSpecChangesPath}/${changeName}`);
    setOpenSpecAuditMenu(null);
    setOpenSpecProposeMenuOpen(false);
    setOpenSpecAutoLauncherChange(null);
    setOpenSpecOpen(false);
  }, [openSpecChangesPath]);

  const openOpenSpecAutoLauncher = useCallback((changeName: string) => {
    setOpenSpecAuditMenu(null);
    setOpenSpecProposeMenuOpen(false);
    setOpenSpecAutoLauncherChange(changeName);
  }, []);

  const launchOpenSpecAutoDeliver = useCallback((changeName: string, presetId: OpenSpecAutoDeliverPresetId, options?: {
    selectedTeamComboId: string;
    materializedLimits: OpenSpecAutoDeliverMaterializedLimits;
  }) => {
    const requestId = openSpecAutoDeliver.launch({ changeName, presetId, ...options });
    if (!requestId) return;
    setOpenSpecAutoLaunchingChange(changeName);
  }, [openSpecAutoDeliver]);

  useEffect(() => {
    if (!openSpecAutoLaunchingChange || !openSpecAutoProjection) return;
    if (openSpecAutoProjection.changeName !== openSpecAutoLaunchingChange) return;
    setOpenSpecAutoLaunchingChange(null);
    setOpenSpecAutoLauncherChange(null);
    setOpenSpecOpen(false);
    setOpenSpecAutoDetailsOpen(true);
  }, [openSpecAutoLaunchingChange, openSpecAutoProjection]);

  const openP2pConfigPanel = useCallback((tab: P2pConfigTab = 'participants') => {
    const open = () => {
      setP2pConfigInitialTab(tab);
      setP2pConfigOpen(true);
    };
    if (onVersionSensitiveAction) onVersionSensitiveAction(t('p2p.settings_title', 'Team settings'), open);
    else open();
  }, [onVersionSensitiveAction, t]);

  const refreshOpenSpecChanges = useCallback(() => {
    clearOpenSpecRequestTimer();
    openSpecRequestIdRef.current = null;
    if (!ws || !openSpecChangesPath) {
      setOpenSpecLoading(false);
      setOpenSpecChanges([]);
      setOpenSpecError(null);
      return;
    }
    setOpenSpecLoading(true);
    setOpenSpecError(null);
    let requestId: string;
    try {
      requestId = ws.fsListDir(openSpecChangesPath, false, false);
    } catch {
      setOpenSpecLoading(false);
      setOpenSpecChanges([]);
      setOpenSpecError(t('openspec.load_unavailable'));
      return;
    }
    openSpecRequestIdRef.current = requestId;
    openSpecRequestTimerRef.current = setTimeout(() => {
      if (openSpecRequestIdRef.current !== requestId) return;
      openSpecRequestIdRef.current = null;
      openSpecRequestTimerRef.current = null;
      setOpenSpecLoading(false);
      setOpenSpecChanges([]);
      setOpenSpecError(t('openspec.load_timeout'));
    }, OPENSPEC_LIST_REQUEST_TIMEOUT_MS);
  }, [clearOpenSpecRequestTimer, openSpecChangesPath, t, ws]);

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
    const rect = (openSpecButtonRef.current ?? openSpecRef.current)?.getBoundingClientRect();
    if (!rect) {
      // Fallback: position at bottom-right so portaled dropdown is never off-screen
      return { position: 'fixed', bottom: '60px', right: '12px', maxHeight: '60vh', zIndex: 2147483646 } as const;
    }
    const availableHeight = Math.max(96, Math.floor(rect.top - 12));
    if (window.innerWidth > 640) {
      const rightOffset = Math.max(window.innerWidth - rect.right, 8);
      return {
        position: 'fixed',
        right: rightOffset,
        bottom: Math.max(window.innerHeight - rect.top + 4, 8),
        maxHeight: `${availableHeight}px`,
        maxWidth: `${window.innerWidth - rightOffset - 8}px`,
        zIndex: 2147483646,
      } as const;
    }
    return {
      ...getAnchoredOverlayStyle(rect, window.innerWidth - 16, window.innerWidth, window.innerHeight),
      zIndex: 2147483646,
    } as const;
  }, [openSpecLayoutTick, openSpecOpen]);

  const isOpenSpecMobile = useMemo(
    () => typeof window !== 'undefined' && window.innerWidth <= 640,
    [openSpecLayoutTick, openSpecOpen],
  );

  const getOpenSpecSubmenuStyle = useCallback((trigger: HTMLElement | null, minWidth: number): React.CSSProperties => {
    if (!trigger || typeof window === 'undefined') {
      // Fallback: position at center-bottom so portaled submenu is never off-screen
      return { position: 'fixed', bottom: '80px', left: '50%', transform: 'translateX(-50%)', minWidth: `${minWidth}px`, zIndex: 2147483647 } as React.CSSProperties;
    }
    return {
      ...getAnchoredOverlayStyle(trigger.getBoundingClientRect(), minWidth, window.innerWidth, window.innerHeight),
      zIndex: 2147483647,
    } as React.CSSProperties;
  }, []);

  const renderOpenSpecSubmenu = useCallback((content: ComponentChildren, trigger: HTMLElement | null, minWidth: number) => {
    if (isOpenSpecMobile) {
      return (
        <div class="menu-dropdown openspec-submenu openspec-submenu-inline">
          {content}
        </div>
      );
    }
    if (typeof document === 'undefined') return null;
    return createPortal(
      <div
        class="menu-dropdown openspec-submenu"
        ref={openSpecSubmenuRef}
        style={getOpenSpecSubmenuStyle(trigger, minWidth)}
      >
        {content}
      </div>,
      document.body,
    );
  }, [getOpenSpecSubmenuStyle, isOpenSpecMobile]);

  const renderP2pDropdown = useCallback((content: ComponentChildren) => {
    const dropdown = (
      <div class="menu-dropdown menu-dropdown-p2p" ref={p2pDropdownRef} data-testid="p2p-dropdown">
        {content}
      </div>
    );
    if (isOpenSpecMobile && typeof document !== 'undefined') {
      return createPortal(dropdown, document.body);
    }
    return dropdown;
  }, [isOpenSpecMobile]);

  const renderOpenSpecDropdown = useCallback((content: ComponentChildren) => {
    if (isOpenSpecMobile) {
      if (typeof document === 'undefined') return null;
      return createPortal(
        <div
          class="menu-dropdown menu-dropdown-openspec menu-dropdown-openspec-inline"
          ref={openSpecDropdownRef}
        >
          <div class="openspec-mobile-header">
            <span class="openspec-mobile-title">{t('openspec.title')}</span>
            <button
              class="openspec-mobile-close"
              onClick={() => {
                clearOpenSpecRequestTimer();
                openSpecRequestIdRef.current = null;
                setOpenSpecLoading(false);
                setOpenSpecOpen(false);
                setOpenSpecAuditMenu(null);
                setOpenSpecProposeMenuOpen(false);
              }}
            >
              ✕
            </button>
          </div>
          {content}
        </div>,
        document.body,
      );
    }
    if (typeof document === 'undefined') return null;
    return createPortal(
      <div
        class="menu-dropdown menu-dropdown-openspec"
        ref={openSpecDropdownRef}
        style={openSpecDropdownStyle}
      >
        {content}
      </div>,
      document.body,
    );
  }, [clearOpenSpecRequestTimer, isOpenSpecMobile, openSpecDropdownStyle, t]);

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

  // A session that is itself an enabled P2P participant ("member") must not
  // start its own Team discussion from its Team dropdown — discussions spawn
  // their own sub-sessions, so a member launching one would nest the team
  // under a participant. The host/root session (the launcher) is never a
  // member. When this is true we reject the combo/workflow launch and steer
  // the user to start the discussion from another (non-member) session.
  const isCurrentSessionP2pMember = useMemo(() => {
    const name = activeSession?.name;
    if (!name || name === rootSession) return false;
    const entry = p2pSavedConfig?.sessions?.[name];
    return !!entry?.enabled && entry.mode !== 'skip';
  }, [activeSession?.name, rootSession, p2pSavedConfig]);

  // P2P config is per server + main-session (sub-sessions follow parent), stored on server for cross-device sync.
  const p2pConfigKey = rootSession ? p2pSessionConfigPrefKey(rootSession, serverId) : null;
  const p2pSavedConfigPref = usePref<P2pSavedConfig>(p2pConfigKey, {
    legacyKey: rootSession ? p2pSessionConfigLegacyPrefKeys(rootSession) : undefined,
    parse: parseP2pSavedConfig,
    serialize: serializeP2pSavedConfig,
  });
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

  const handleP2pDropdownRoundsChange = useCallback((nextRounds: number) => {
    const cfg: P2pSavedConfig = {
      ...(p2pSavedConfig ?? { sessions: {}, rounds: 1 }),
      rounds: nextRounds,
      updatedAt: Date.now(),
    };
    setP2pSavedConfig(cfg);
    void p2pSavedConfigPref.save(cfg).catch(() => {});
    if (rootSession) {
      void persistP2pConfigToDaemon(rootSession, cfg, { awaitAck: false });
    }
  }, [p2pSavedConfig, p2pSavedConfigPref, persistP2pConfigToDaemon, rootSession]);

  useEffect(() => {
    setP2pSavedConfig(p2pSavedConfigPref.value);
  }, [p2pSavedConfigPref.value]);

  useEffect(() => {
    if (!ws || !rootSession || !p2pSavedConfig) return;
    const signature = `${serverId ?? ''}:${rootSession}:${JSON.stringify(p2pSavedConfig)}`;
    if (lastDaemonP2pSyncRef.current === signature) return;
    void persistP2pConfigToDaemon(rootSession, p2pSavedConfig, { awaitAck: false }).then((result) => {
      if (result.ok) {
        lastDaemonP2pSyncRef.current = signature;
      }
    });
  }, [persistP2pConfigToDaemon, rootSession, p2pSavedConfig, serverId, ws]);

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
        if (openSpecRequestIdRef.current) {
          clearOpenSpecRequestTimer();
          openSpecRequestIdRef.current = null;
          setOpenSpecLoading(false);
          setOpenSpecChanges([]);
          setOpenSpecError(t('openspec.load_unavailable'));
        }
        return;
      }
      if (msg.type === DAEMON_MSG.RECONNECTED) {
        lastDaemonP2pSyncRef.current = '';
        if (rootSession && p2pSavedConfig) {
          void persistP2pConfigToDaemon(rootSession, p2pSavedConfig, { awaitAck: false }).then((result) => {
            if (result.ok) {
              lastDaemonP2pSyncRef.current = `${serverId ?? ''}:${rootSession}:${JSON.stringify(p2pSavedConfig)}`;
            }
          });
        }
        if (openSpecOpen) refreshOpenSpecChanges();
        return;
      }
      const requestId = openSpecRequestIdRef.current;
      if (!requestId || msg.type !== 'fs.ls_response' || msg.requestId !== requestId) return;
      openSpecRequestIdRef.current = null;
      clearOpenSpecRequestTimer();
      setOpenSpecLoading(false);
      if (msg.status === 'error') {
        const errorText = msg.error ?? null;
        if (errorText === FS_READ_ERROR_CODES.FORBIDDEN_PATH || /enoent|not found|no such file/i.test(errorText ?? '')) {
          setOpenSpecChanges([]);
          setOpenSpecError(null);
          return;
        }
        setOpenSpecChanges([]);
        setOpenSpecError(formatOpenSpecLoadError(errorText));
        return;
      }
      const changeNames = (msg.entries ?? [])
        .filter((entry) => entry.isDir && !OPENSPEC_NON_CHANGE_DIR_NAMES.has(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
      setOpenSpecChanges(changeNames);
      setOpenSpecError(null);
    });
  }, [clearOpenSpecRequestTimer, formatOpenSpecLoadError, openSpecOpen, persistP2pConfigToDaemon, p2pSavedConfig, refreshOpenSpecChanges, rejectAllPendingP2pConfigSaves, resolvePendingP2pConfigSave, rootSession, serverId, t, ws]);

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

  const applySavedP2pConfigSelection = useCallback((extra: Record<string, unknown>, mode: string, userText?: string) => {
    if (!p2pSavedConfig || (mode !== P2P_CONFIG_MODE && !isComboMode(mode))) return;
    const selection = buildP2pConfigSelection(p2pSavedConfig, mode);
    extra.p2pSessionConfig = selection.config.sessions;
    extra.p2pRounds = selection.rounds;
    if (selection.config.extraPrompt) extra.p2pExtraPrompt = selection.config.extraPrompt;
    if (selection.config.hopTimeoutMinutes != null) extra.p2pHopTimeoutMs = Math.min(selection.config.hopTimeoutMinutes * 60_000, 600_000);
    if (mode === P2P_CONFIG_MODE) appendOptionalAdvancedP2pConfig(extra, selection.config, {
      sessionName: activeSession?.name,
      projectDir: activeSession?.projectDir,
      userText,
      locale: i18n?.language ?? 'en',
    }, computeAdvancedLaunchCapabilityGate(ws, selection.config));
  }, [activeSession?.name, activeSession?.projectDir, i18n?.language, p2pSavedConfig, ws]);

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
    if (((!text && attachments.length === 0) && !allowEmptyCombo) || !activeSession) return null;

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
          if (!override?.modeOverride || override.modeOverride === P2P_CONFIG_MODE) appendOptionalAdvancedP2pConfig(extra, cfg, {
            sessionName: activeSession?.name,
            projectDir: activeSession?.projectDir,
            userText: text,
            locale: i18n?.language ?? 'en',
          }, computeAdvancedLaunchCapabilityGate(ws, cfg));
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
        applySavedP2pConfigSelection(extra, effectiveMode, text);
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
    // Prepend attachment references.
    // R3 v2 PR-ρ/υ — Keep the compact user-facing tag (`#1`, `#2`, ...)
    // but map it to the full daemon path, not just the display filename.
    // The path is what the receiving LLM can actually open.
    if (attachments.length > 0) {
      const refs = attachments.map((a) => `#${a.seq}:(${a.path})`).join(' ');
      text = text ? `${refs} ${text}` : refs;
    }
    return { text, extra };
  }, [activeSession, applySavedP2pConfigSelection, attachments, i18n?.language, onRemoveQuote, p2pExcludeSameType, p2pMode, p2pSavedConfig, quotes, sessions, subSessions]);

  const buildModeOnlySendPayload = useCallback((rawText: string, modeOverride?: string): PendingSendPayload | null => {
    const text = rawText.trim();
    const effectiveMode = modeOverride ?? p2pMode;
    const allowEmptyCombo = !!modeOverride && isComboMode(modeOverride);
    if ((!text && !allowEmptyCombo) || !activeSession) return null;

    const extra: Record<string, unknown> = {};
    const manual = extractManualP2pTargets(text, buildManualP2pCandidates(sessions, subSessions));
    let cleanText = manual.cleanText;

    if (manual.orderedTargets.length > 0) {
      extra.p2pAtTargets = manual.orderedTargets;
    } else if (effectiveMode !== 'solo' && !text.includes('@@')) {
      extra.p2pMode = effectiveMode === P2P_CONFIG_MODE ? 'config' : effectiveMode;
      if (p2pExcludeSameType && effectiveMode !== P2P_CONFIG_MODE) extra.p2pExcludeSameType = true;
      applySavedP2pConfigSelection(extra, effectiveMode, cleanText);
    }

    if (extra.p2pAtTargets || extra.p2pMode) {
      extra.p2pLocale = i18n?.language ?? 'en';
    }

    return { text: cleanText, extra };
  }, [activeSession, applySavedP2pConfigSelection, i18n?.language, p2pExcludeSameType, p2pMode, p2pSavedConfig, sessions, subSessions]);

  const makeCommandId = useCallback(() => (
    globalThis.crypto?.randomUUID?.() ?? `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`
  ), []);

  const cancelActiveTransportTurn = useCallback((commandId = makeCommandId()): string | null => {
    if (!activeSession) return null;
    const payload = {
      sessionName: activeSession.name,
      commandId,
      ...(activeSession.sharedState?.activeDispatchId ? { observedDispatchId: activeSession.sharedState.activeDispatchId } : {}),
    };
    if (!ws) {
      if (!serverId) return null;
      void cancelSessionViaHttp(serverId, payload).catch((fallbackErr) => {
        console.warn('session.cancel HTTP fallback failed', fallbackErr);
      });
      return commandId;
    }
    try {
      ws.sendSessionCommandUrgent('cancel', payload);
    } catch (err) {
      if (!serverId) throw err;
      void cancelSessionViaHttp(serverId, payload).catch((fallbackErr) => {
        console.warn('session.cancel HTTP fallback failed', fallbackErr);
      });
    }
    return commandId;
  }, [activeSession, makeCommandId, serverId, ws]);

  // Optimistic stop feedback. The cancel command is fire-and-forget on a
  // priority lane (server/daemon never queue it), but the button only flips
  // colour/state after the session.state round-trip + the provider actually
  // interrupting the model (up to ~1.5s for the Claude SDK). Without local
  // feedback the tap looks ignored. Fire on pointerdown (don't wait for the
  // ~300ms synthetic click, which is also dispatched late when streaming
  // jank keeps the main thread busy) and show a "stopping" pulse instantly.
  const [stopRequested, setStopRequested] = useState(false);
  const stopPressGuardRef = useRef(0);

  const showStopFeedback = useCallback(() => {
    stopPressGuardRef.current = Date.now();
    setStopRequested(true);
  }, []);

  const handleStopPress = useCallback(() => {
    const now = Date.now();
    if (now - stopPressGuardRef.current < 600) return; // dedupe pointerdown + click
    showStopFeedback();
    cancelActiveTransportTurn();
  }, [cancelActiveTransportTurn, showStopFeedback]);

  // Clear the optimistic state once the turn actually settles (session leaves
  // the running state) or after a safety timeout so a stuck turn re-enables it.
  useEffect(() => {
    if (!stopRequested) return;
    if (!isRunningSessionState(activeSession?.state)) { setStopRequested(false); return; }
    const timer = setTimeout(() => setStopRequested(false), 4000);
    return () => clearTimeout(timer);
  }, [stopRequested, activeSession?.state]);

  const sendSessionMessage = useCallback((text: string, extra: Record<string, unknown> = {}, commandId = makeCommandId()): string | null => {
    if (!activeSession) return null;
    if (effectiveRuntimeType === 'transport' && text.trim() === '/stop') {
      showStopFeedback();
      return cancelActiveTransportTurn(commandId);
    }
    const payload = {
      sessionName: activeSession.name,
      text,
      ...extra,
      commandId,
    };
    if (!ws) {
      if (!serverId) return null;
      void sendSessionViaHttp(serverId, payload).catch((fallbackErr) => {
        console.warn('session.send HTTP fallback failed', fallbackErr);
      });
      return commandId;
    }
    try {
      ws.sendSessionCommand('send', payload);
    } catch (err) {
      if (!serverId) throw err;
      void sendSessionViaHttp(serverId, payload).catch((fallbackErr) => {
        console.warn('session.send HTTP fallback failed', fallbackErr);
      });
    }
    return commandId;
  }, [activeSession, cancelActiveTransportTurn, effectiveRuntimeType, makeCommandId, serverId, showStopFeedback, ws]);

  const sendQueuedMessageMutation = useCallback((type: 'session.edit_queued_message' | 'session.undo_queued_message', payload: Record<string, unknown>) => {
    if (!ws || !activeSession) return false;
    const commandId = globalThis.crypto?.randomUUID?.() ?? `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    ws.send({
      type,
      sessionName: activeSession.name,
      commandId,
      ...payload,
    });
    return true;
  }, [activeSession, ws]);

  const finalizeSend = useCallback((payload: PendingSendPayload, options?: { clearComposer?: boolean }) => {
    if (!activeSession) return;
    const isP2pSend = (
      Array.isArray(payload.extra.p2pAtTargets) && payload.extra.p2pAtTargets.length > 0
      || (typeof payload.extra.p2pMode === 'string' && payload.extra.p2pMode.length > 0)
      || (payload.extra.p2pSessionConfig != null && typeof payload.extra.p2pSessionConfig === 'object')
    );
    const clearComposerState = () => {
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
      if (attachmentDraftKey) sessionStorage.removeItem(attachmentDraftKey);
    };
    if (effectiveRuntimeType === 'transport' && !isP2pSend && payload.text.trim() === '/stop') {
      showStopFeedback();
      if (!cancelActiveTransportTurn()) return;
      if (options?.clearComposer) clearComposerState();
      return;
    }
    if (editingQueuedMessageId && effectiveRuntimeType === 'transport') {
      try {
        if (!sendQueuedMessageMutation('session.edit_queued_message', {
          clientMessageId: editingQueuedMessageId,
          text: payload.text,
        })) return;
      } catch {
        return;
      }
      setEditingQueuedMessageId(null);
      setOptimisticQueuedEntries((prev) => {
        const source = prev ?? incomingQueuedTransportEntries;
        return source.map((entry) => (
          entry.clientMessageId === editingQueuedMessageId
            ? { ...entry, text: payload.text }
            : entry
        ));
      });
      if (options?.clearComposer) {
        clearComposerState();
      }
      return;
    }
    quickData.recordHistory(payload.text, activeSession.name);
    const commandId = makeCommandId();
    let localFailure: string | undefined;
    try {
      if (!sendSessionMessage(payload.text, payload.extra, commandId)) return;
    } catch (err) {
      localFailure = err instanceof Error ? err.message : String(err || 'Send failed');
    }
    const shouldShowAsQueued = effectiveRuntimeType === 'transport'
      && transportSendShouldQueue
      && !isP2pSend
      && !payload.text.trim().startsWith('/');
    if (shouldShowAsQueued) {
      setOptimisticQueuedEntries((prev) => {
        const source = prev ?? incomingQueuedTransportEntries;
        if (source.some((entry) => entry.clientMessageId === commandId)) return source;
        return [...source, { clientMessageId: commandId, text: payload.text, status: localFailure ? 'failed' : 'sending' }];
      });
    }
    // Snapshot attachments before clearComposer wipes them so the optimistic
    // bubble surfaces the same badges the confirmed message will.
    const attachmentSnapshot = attachments.length > 0
      ? attachments.map((a) => ({
          id: a.path,
          daemonPath: a.path,
          originalName: a.name,
      }))
      : undefined;
    const suppressOptimisticUserBubble = shouldHideOptimisticUserMessageForSessionControl(payload.text) && !localFailure;
    if (!shouldShowAsQueued && !suppressOptimisticUserBubble) {
      onSend?.(activeSession.name, payload.text, {
        commandId,
        ...(attachmentSnapshot ? { attachments: attachmentSnapshot } : {}),
        ...(payload.extra && Object.keys(payload.extra).length > 0 ? { extra: payload.extra } : {}),
        ...(localFailure ? { localFailure } : {}),
      });
    }
    if (options?.clearComposer) {
      clearComposerState();
    }
  }, [activeSession, attachmentDraftKey, cancelActiveTransportTurn, draftKey, editingQueuedMessageId, effectiveRuntimeType, incomingQueuedTransportEntries, makeCommandId, onRemoveQuote, onSend, quickData, quotes, sendQueuedMessageMutation, sendSessionMessage, showStopFeedback, transportSendShouldQueue]);

  const handleQueuedMessageEdit = useCallback((entry: { clientMessageId: string; text: string }) => {
    if (!isEditableQueuedEntry(entry)) return;
    fillInput(entry.text);
    setEditingQueuedMessageId(entry.clientMessageId);
  }, [isEditableQueuedEntry]);

  const handleQueuedMessageDelete = useCallback((entry: { clientMessageId: string; text: string }) => {
    if (!isEditableQueuedEntry(entry)) return;
    if (editingQueuedMessageId === entry.clientMessageId || (!editingQueuedMessageId && getText() === entry.text)) {
      if (divRef.current) divRef.current.textContent = '';
      setHasText(false);
      setMobileComposerExpanded(false);
      setMobileComposerMultiline(false);
    }
    if (editingQueuedMessageId === entry.clientMessageId) setEditingQueuedMessageId(null);
    setOptimisticQueuedEntries((prev) => {
      const source = prev ?? incomingQueuedTransportEntries;
      return source.filter((item) => item.clientMessageId !== entry.clientMessageId);
    });
    if (isLocalQueuedEntry(entry)) return;
    try {
      sendQueuedMessageMutation('session.undo_queued_message', {
        clientMessageId: entry.clientMessageId,
      });
    } catch {
      /* ignore */
    }
  }, [editingQueuedMessageId, incomingQueuedTransportEntries, isEditableQueuedEntry, isLocalQueuedEntry, sendQueuedMessageMutation]);

  const handleQueuedMessageRetry = useCallback((entry: LocalQueuedTransportEntry) => {
    if (entry.status !== 'failed') return;
    let commandId: string | null = null;
    try {
      commandId = sendSessionMessage(entry.text);
    } catch {
      commandId = null;
    }
    if (!commandId) return;
    setOptimisticQueuedEntries((prev) => {
      const source = prev ?? [];
      const next = source.filter((item) => item.clientMessageId !== entry.clientMessageId);
      next.push({ clientMessageId: commandId, text: entry.text, status: 'sending' });
      return next;
    });
  }, [sendSessionMessage]);

  const maybePersistComboSendSkip = useCallback(() => {
    if (!rememberComboSendChoice) return;
    setSkipComboSendConfirm(true);
    void comboSkipPref.save(true).catch(() => {});
  }, [comboSkipPref, rememberComboSendChoice]);

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

  const handleDirectComboSelect = useCallback((mode: string, roundsOverride?: number) => {
    setP2pOpen(false);
    if (isCurrentSessionP2pMember) {
      showSendWarning(t('p2p.member_cannot_initiate_discussion'));
      return;
    }
    const selection = p2pSavedConfig
      ? buildP2pConfigSelection(p2pSavedConfig, mode, roundsOverride ?? p2pSavedConfig.rounds ?? 1)
      : null;
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
  }, [buildSendPayload, isCurrentSessionP2pMember, p2pSavedConfig, requestSend, showSendWarning, t]);

  /*
   * R3 v2 PR-κ — Click-to-launch a saved workflow from the P2P dropdown.
   * Builds a config snapshot with the chosen workflow as active so the
   * launch envelope (built downstream by `appendOptionalAdvancedP2pConfig`
   * via `getActiveWorkflowFromConfig`) carries the user-picked entry. We
   * pass the snapshot through `syntheticConfigOverride` so the picked
   * workflow takes effect for THIS turn even if the saved config still
   * names a different active id (the user did not commit the picked id
   * via the panel — they just one-shot launched it).
   */
  const handleDirectWorkflowSelect = useCallback((workflowId: string) => {
    setP2pOpen(false);
    if (isCurrentSessionP2pMember) {
      showSendWarning(t('p2p.member_cannot_initiate_discussion'));
      return;
    }
    if (!p2pSavedConfig || workflowLibraryItems.length === 0) return;
    const target = workflowLibraryItems.find((entry) => entry.id === workflowId);
    if (!target) return;
    const chosenConfig: P2pSavedConfig = { ...p2pSavedConfig, activeWorkflowId: workflowId };
    const selection = buildP2pConfigSelection(chosenConfig, P2P_CONFIG_MODE);
    const titleLabel = (target.title?.trim() || workflowId).slice(0, 40);
    const payloadOptions: BuildSendPayloadOptions = {
      modeOverride: P2P_CONFIG_MODE,
      syntheticAtTargets: [{
        session: '__all__',
        mode: 'config',
        label: `@@all(workflow:${titleLabel})`,
      }],
      syntheticConfigOverride: selection,
    };
    requestSend(buildSendPayload(payloadOptions), { clearComposer: true });
  }, [buildSendPayload, isCurrentSessionP2pMember, p2pSavedConfig, requestSend, showSendWarning, t, workflowLibraryItems]);

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
    if (imeComposingRef.current || isImeComposingKeyEvent(e)) return;

    if (e.key === 'Escape' && effectiveRuntimeType === 'transport' && isRunningSessionState(activeSession?.state)) {
      e.preventDefault();
      handleStopPress();
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

  const uploadAttachmentFiles = useCallback(async (files: readonly File[]): Promise<boolean> => {
    if (files.length === 0 || !serverId) return false;
    const uploadKey = composerUploadKey;
    const uploadAttachmentDraftKey = attachmentDraftKey;
    updateComposerUploadSnapshot(uploadKey, { uploading: true, progress: 0, error: null });
    let uploadedAny = false;
    for (const file of files) {
      try {
        const result = await uploadFile(serverId, file, (pct) => updateComposerUploadSnapshot(uploadKey, { progress: pct }));
        if (result.attachment?.daemonPath) {
          uploadedAny = true;
          const attachment = { path: result.attachment.daemonPath, name: file.name, seq: 0 };
          if (uploadAttachmentDraftKey) {
            const next = appendStoredComposerAttachment(uploadAttachmentDraftKey, attachment);
            if (mountedRef.current && attachmentDraftKeyRef.current === uploadAttachmentDraftKey) {
              setAttachments(next);
            }
          } else {
            setAttachments((prev) => renumberAttachments([...prev, attachment]));
          }
        }
      } catch (err) {
        console.error('[upload] failed:', err);
        const body = err instanceof Error ? err.message : String(err);
        let errorMessage: string;
        if (body.includes('daemon_offline')) {
          errorMessage = t('upload.daemon_offline');
        } else if (body.includes('file_too_large')) {
          errorMessage = t('upload.file_too_large', { max: MAX_UPLOAD_SIZE_MB });
        } else {
          errorMessage = t('upload.upload_failed');
        }
        updateComposerUploadSnapshot(uploadKey, { error: errorMessage });
        setTimeout(() => updateComposerUploadSnapshot(uploadKey, { error: null }), 5000);
      }
    }
    updateComposerUploadSnapshot(uploadKey, { uploading: false, progress: uploadedAny ? 100 : 0 });
    return uploadedAny;
  }, [attachmentDraftKey, composerUploadKey, serverId, t]);

  const handleFileUpload = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    await uploadAttachmentFiles(Array.from(files));
  }, [uploadAttachmentFiles]);

  const handleFileDragEnter = useCallback((e: DragEvent) => {
    if (inputDisabled || !dataTransferHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = serverId ? 'copy' : 'none';
    setFileDragActive(true);
  }, [inputDisabled, serverId]);

  const handleFileDragOver = useCallback((e: DragEvent) => {
    if (inputDisabled || !dataTransferHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = serverId ? 'copy' : 'none';
    setFileDragActive(true);
  }, [inputDisabled, serverId]);

  const handleFileDragLeave = useCallback((e: DragEvent) => {
    if (!dataTransferHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    const current = e.currentTarget as Node | null;
    const related = e.relatedTarget as Node | null;
    if (current && related && current.contains(related)) return;
    setFileDragActive(false);
  }, []);

  const handleFileDrop = useCallback((e: DragEvent) => {
    if (!dataTransferHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setFileDragActive(false);
    if (inputDisabled) return;
    void handleFileUpload(e.dataTransfer?.files ?? null);
  }, [handleFileUpload, inputDisabled]);

  useEffect(() => {
    const target = fileDropTargetRef?.current;
    if (!target) return;
    target.addEventListener('dragenter', handleFileDragEnter, true);
    target.addEventListener('dragover', handleFileDragOver, true);
    target.addEventListener('dragleave', handleFileDragLeave, true);
    target.addEventListener('drop', handleFileDrop, true);
    return () => {
      target.removeEventListener('dragenter', handleFileDragEnter, true);
      target.removeEventListener('dragover', handleFileDragOver, true);
      target.removeEventListener('dragleave', handleFileDragLeave, true);
      target.removeEventListener('drop', handleFileDrop, true);
    };
  }, [fileDropTargetRef, handleFileDragEnter, handleFileDragLeave, handleFileDragOver, handleFileDrop]);

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
    if (!text) return;
    if (text.length > INLINE_PASTE_TEXT_CHAR_LIMIT) {
      if (!serverId) {
        showSendWarning(t('upload.long_text_requires_attachment'));
        return;
      }
      const fileName = buildPastedTextFileName();
      const textFile = new File([text], fileName, { type: 'text/plain' });
      void (async () => {
        const uploaded = await uploadAttachmentFiles([textFile]);
        if (uploaded) {
          showSendWarning(t('upload.long_text_attached', { name: fileName }));
          divRef.current?.focus();
        }
      })();
      return;
    }
    document.execCommand('insertText', false, text);
    setHasText(!!(divRef.current?.textContent?.trim()));
  };

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
      if (stopBlockedByPinned) {
        try { window.alert(t('session.unpin_to_stop')); } catch { /* ignore */ }
        setMenuOpen(false); resetConfirm(); onAfterAction?.();
        return;
      }
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
    saveCodexModelPreference(m, activeSession.name);
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

  const handleGenericTransportModelSelect = (m: string) => {
    if (!activeSession) return;
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

  const dropOverlayStyle = (() => {
    if (!fileDragActive) return null;
    const target = fileDropTargetRef?.current ?? controlsWrapperRef.current;
    const rect = target?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return { inset: '0px' };
    return {
      left: `${Math.max(0, rect.left)}px`,
      top: `${Math.max(0, rect.top)}px`,
      width: `${Math.min(window.innerWidth - Math.max(0, rect.left), rect.width)}px`,
      height: `${Math.min(window.innerHeight - Math.max(0, rect.top), rect.height)}px`,
    };
  })();

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
    {openSpecFolderPath && ws && activeSession && (
      <div class="fb-overlay openspec-folder-overlay" onClick={() => setOpenSpecFolderPath(null)}>
        <div class="fb-modal openspec-folder-modal" onClick={(event) => event.stopPropagation()}>
          <div class="fb-header openspec-folder-header">
            <span class="fb-breadcrumb-path">{toComposerReference(openSpecFolderPath)}</span>
            <button class="fb-close" onClick={() => setOpenSpecFolderPath(null)}>✕</button>
          </div>
          <FileBrowser
            key={`${serverId ?? 'local'}:${openSpecFolderPath}`}
            ws={ws}
            serverId={serverId}
            mode="file-multi"
            layout="panel"
            initialPath={openSpecFolderPath}
            defaultTab="files"
            hideFooter={false}
            onConfirm={(paths) => {
              appendToInput(paths.map((path) => toComposerReference(path)));
              setOpenSpecFolderPath(null);
            }}
            onClose={() => setOpenSpecFolderPath(null)}
          />
        </div>
      </div>
    )}
    <div ref={controlsWrapperRef} class={`controls-wrapper${showRunningSweep ? ' controls-wrapper-running' : ''}${mobileComposerExpanded ? ' controls-wrapper-mobile-expanded' : ''}`}>
      {dropOverlayStyle && createPortal(
        <div class="session-file-drop-overlay" style={dropOverlayStyle}>
          <div class="session-file-drop-card">
            <div class="session-file-drop-icon">📎</div>
            <div class="session-file-drop-title">{t('upload.drop_overlay_title')}</div>
            <div class="session-file-drop-hint">{t('upload.drop_overlay_hint')}</div>
          </div>
        </div>,
        document.body,
      )}
      {openSpecAutoDetailsOpen && (
        <OpenSpecAutoDeliverDetailsPanel
          projection={openSpecAutoProjection}
          stopPending={openSpecAutoDeliver.stopPending}
          onClose={() => setOpenSpecAutoDetailsOpen(false)}
          onStop={() => { openSpecAutoDeliver.stop(); }}
        />
      )}
      {/* Header control row — compact mode keeps meta controls but still hides terminal shortcuts */}
      {!hideShortcuts && (!compact || showCompactMetaControls) && <div class="shortcuts-row">
        {!compact && <div class={`shortcuts${isTransport ? ' shortcuts-transport' : ''}`}>
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
              class={`shortcut-btn shortcut-btn-icon shortcut-btn-stop${stopRequested ? ' shortcut-btn-stop-pending' : ''}`}
              title={`${t('session.stop_plain')} (/stop)`}
              aria-label={t('session.stop_plain')}
              disabled={disabled || activeSession?.state === 'stopped'}
              onPointerDown={(e) => { e.preventDefault(); handleStopPress(); }}
              onClick={handleStopPress}
              style={isRunningSessionState(activeSession?.state) ? { color: '#f87171' } : undefined}
            >
              <span aria-hidden="true">■</span>
            </button>
          ) : SHORTCUTS.map((s) => {
            // Mobile: collapse the separate ↑/↓ buttons into one drag D-pad
            // (rendered once at the ↑ slot; ↓ is folded in). It sends the
            // same standard arrow sequences down the same handleShortcut path,
            // so ncdu/vim/less TUI handling is inherited unchanged, and adds
            // left/right. Desktop keeps the discrete buttons.
            if (isMobileLayout && s.data === DPAD_ARROW_SEQUENCES.down) return null;
            if (isMobileLayout && s.data === DPAD_ARROW_SEQUENCES.up) {
              return (
                <MobileDpad
                  key="dpad"
                  disabled={disabled}
                  title={t('chat.dpad.title')}
                  ariaLabel={t('chat.dpad.title')}
                  onDirection={(seq) => handleShortcut(seq)}
                />
              );
            }
            return (
              <button
                key={s.label}
                class={`shortcut-btn${s.wide ? ' shortcut-btn-wide' : ''}`}
                title={s.title}
                disabled={disabled}
                onClick={() => handleShortcut(s.data)}
              >
                {s.label}
              </button>
            );
          })}
        </div>}

        {canQuickControlSupervision && (
          <div class="shortcuts-model" ref={autoRef}>
            <button
              class="shortcut-btn shortcut-btn-auto"
              onClick={() => setAutoOpen((open) => !open)}
              disabled={disabled}
              title={t('session.supervision.quickTitle')}
              aria-label={t('session.supervision.quickLabel')}
            >
              <span
                class="shortcut-btn-auto-dot"
                aria-hidden="true"
                style={{ background: quickAutoColor }}
              />
              <span class="shortcut-btn-auto-label">{t('session.supervision.quickLabel')}</span>
              <span class="shortcut-btn-auto-caret" aria-hidden="true">▾</span>
            </button>
            {autoOpen && (
              <div class="menu-dropdown menu-dropdown-auto">
                <button
                  class={`menu-item ${quickSupervisionMode === SUPERVISION_MODE.OFF ? 'menu-item-active' : ''}`}
                  onClick={() => { void handleQuickSupervisionModeSelect(SUPERVISION_MODE.OFF); }}
                >
                  {quickSupervisionMode === SUPERVISION_MODE.OFF ? '● ' : '○ '}{t('session.supervision.mode.off')}
                </button>
                <button
                  class={`menu-item ${quickSupervisionMode === SUPERVISION_MODE.SUPERVISED ? 'menu-item-active' : ''}`}
                  onClick={() => { void handleQuickSupervisionModeSelect(SUPERVISION_MODE.SUPERVISED); }}
                >
                  {quickSupervisionMode === SUPERVISION_MODE.SUPERVISED ? '● ' : '○ '}{t('session.supervision.mode.supervised')}
                </button>
                <button
                  class={`menu-item ${quickSupervisionMode === SUPERVISION_MODE.SUPERVISED_AUDIT ? 'menu-item-active' : ''}`}
                  onClick={() => { void handleQuickSupervisionModeSelect(SUPERVISION_MODE.SUPERVISED_AUDIT); }}
                >
                  {quickSupervisionMode === SUPERVISION_MODE.SUPERVISED_AUDIT ? '● ' : '○ '}{t('session.supervision.mode.supervised_audit')}
                </button>
                {!!onSettings && (
                  <>
                    <div class="menu-divider" />
                    <button
                      class="menu-item"
                      onClick={() => {
                        setAutoOpen(false);
                        onSettings?.();
                      }}
                    >
                      {t('session.settings')}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Model selector — outside overflow-x scroll area so dropdown isn't clipped */}
        {openSpecChangesPath && (
          <div class="shortcuts-model" ref={openSpecRef}>
            <button
              class="shortcut-btn"
              ref={openSpecButtonRef}
              onClick={() => {
                setOpenSpecOpen((open) => {
                  const next = !open;
                  if (!next) {
                    clearOpenSpecRequestTimer();
                    openSpecRequestIdRef.current = null;
                    setOpenSpecLoading(false);
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
            {openSpecOpen && renderOpenSpecDropdown(
              <>
                <div class="openspec-dropdown-scroll">
                {openSpecAutoProjection && (
                  <OpenSpecAutoDeliverCurrentRunEntry
                    projection={openSpecAutoProjection}
                    onView={() => setOpenSpecAutoDetailsOpen(true)}
                  />
                )}
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
                  <OpenSpecChangeRow
                    key={changeName}
                    changeName={changeName}
                    mobile={isOpenSpecMobile}
                    expanded={openSpecExpandedChange === changeName}
                    auditMenuOpen={openSpecAuditMenu === changeName}
                    actionsDisabled={openSpecAutoActive}
                    disabledReason={openSpecAutoActionLockReason}
                    onAppendReference={() => {
                      if (!openSpecChangesPath) return;
                      appendToInput([toComposerReference(`${openSpecChangesPath}/${changeName}`)]);
                      setOpenSpecAuditMenu(null);
                      setOpenSpecProposeMenuOpen(false);
                      setOpenSpecAutoLauncherChange(null);
                      setOpenSpecOpen(false);
                    }}
                    onOpenFolder={() => openOpenSpecChangeFolder(changeName)}
                    onToggleExpanded={() => {
                      setOpenSpecAuditMenu(null);
                      setOpenSpecProposeMenuOpen(false);
                      setOpenSpecAutoLauncherChange(null);
                      setOpenSpecExpandedChange((current) => current === changeName ? null : changeName);
                    }}
                    onToggleAuditMenu={() => {
                      setOpenSpecProposeMenuOpen(false);
                      setOpenSpecAutoLauncherChange(null);
                      setOpenSpecAuditMenu((current) => current === changeName ? null : changeName);
                    }}
                    onAuditImplementation={() => {
                      if (!openSpecChangesPath) return;
                      const reference = toComposerReference(`${openSpecChangesPath}/${changeName}`);
                      insertOpenSpecPrompt('audit_implementation', reference);
                      setOpenSpecAuditMenu(null);
                      setOpenSpecOpen(false);
                    }}
                    onAuditSpec={() => {
                      if (!openSpecChangesPath) return;
                      const reference = toComposerReference(`${openSpecChangesPath}/${changeName}`);
                      insertOpenSpecPrompt('audit_spec', reference);
                      setOpenSpecAuditMenu(null);
                      setOpenSpecOpen(false);
                    }}
                    onImplement={() => {
                      if (!openSpecChangesPath) return;
                      const reference = toComposerReference(`${openSpecChangesPath}/${changeName}`);
                      insertOpenSpecPrompt('implement', reference);
                      setOpenSpecAuditMenu(null);
                      setOpenSpecProposeMenuOpen(false);
                      setOpenSpecOpen(false);
                    }}
                    onAchieve={() => {
                      if (!openSpecChangesPath) return;
                      const reference = toComposerReference(`${openSpecChangesPath}/${changeName}`);
                      sendOpenSpecPrompt(t('openspec.achieve_prompt', { reference }));
                      setOpenSpecAuditMenu(null);
                      setOpenSpecProposeMenuOpen(false);
                      setOpenSpecOpen(false);
                    }}
                    onAuto={() => openOpenSpecAutoLauncher(changeName)}
                    auditButtonRef={(el) => {
                      if (el) openSpecAuditButtonRefs.current.set(changeName, el);
                      else openSpecAuditButtonRefs.current.delete(changeName);
                    }}
                    renderAuditSubmenu={(content, minWidth) => renderOpenSpecSubmenu(
                      content,
                      openSpecAuditButtonRefs.current.get(changeName) ?? null,
                      minWidth,
                    )}
                  />
                ))}
                </div>
                <OpenSpecAutoDeliverLauncher
                  open={!!openSpecAutoLauncherChange}
                  changeName={openSpecAutoLauncherChange}
                  conflictProjection={openSpecAutoProjection}
                  launchPending={openSpecAutoDeliver.launchPending}
                  error={openSpecAutoDeliver.lastError}
                  onClose={() => {
                    openSpecAutoDeliver.clearError();
                    setOpenSpecAutoLaunchingChange(null);
                    setOpenSpecAutoLauncherChange(null);
                  }}
                  onLaunch={launchOpenSpecAutoDeliver}
                  onViewCurrent={() => setOpenSpecAutoDetailsOpen(true)}
                />
                <div class="openspec-dropdown-footer">
                  <div class="openspec-change-action-wrap openspec-footer-action-wrap">
                    <button
                      class="btn btn-secondary openspec-change-action-btn"
                      style={{ width: '100%', justifyContent: 'center' }}
                      ref={(el) => {
                        openSpecProposeButtonRef.current = el;
                      }}
                      disabled={openSpecAutoActive}
                      title={openSpecAutoActionLockReason}
                      onClick={() => {
                        if (openSpecAutoActive) return;
                        setOpenSpecAuditMenu(null);
                        setOpenSpecAutoLauncherChange(null);
                        setOpenSpecProposeMenuOpen((open) => !open);
                      }}
                    >
                      {t('openspec.propose_action')}
                    </button>
                    {openSpecProposeMenuOpen && renderOpenSpecSubmenu(
                      <>
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
                      </>,
                      openSpecProposeButtonRef.current,
                      220,
                    )}
                  </div>
                </div>
              </>
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
              title={displayedCodexModel ? `Model: ${displayedCodexModel}` : 'Model: default — tap to select'}
              style={{ color: displayedCodexModel ? '#34d399' : '#6b7280', fontSize: 10 }}
            >
              {displayedCodexModel ?? 'default'}
            </button>
            {modelOpen && (
              <div class="menu-dropdown">
                {codexModelSuggestions.map((m) => (
                  <button
                    key={m}
                    class={`menu-item ${displayedCodexModel === m ? 'menu-item-active' : ''}`}
                    onClick={() => handleCodexModelSelect(m)}
                  >
                    {displayedCodexModel === m ? '● ' : '○ '}{m}
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
        {supportsGenericTransportModelSelect && (
          <div class="shortcuts-model" ref={modelRef}>
            <button
              class="shortcut-btn"
              onClick={() => setModelOpen((o) => !o)}
              disabled={disabled}
              title={genericTransportModel ? `Model: ${genericTransportModel}` : 'Model: default — tap to select'}
              style={{ color: genericTransportModel ? '#34d399' : '#6b7280', fontSize: 10 }}
            >
              {genericTransportModel ?? 'default'}
            </button>
            {modelOpen && (
              <div class="menu-dropdown">
                {genericTransportModelSuggestions.map((m) => (
                  <button
                    key={m}
                    class={`menu-item ${genericTransportModel === m ? 'menu-item-active' : ''}`}
                    onClick={() => handleGenericTransportModelSelect(m)}
                  >
                    {genericTransportModel === m ? '● ' : '○ '}{m}
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
                    {currentThinking === level ? '● ' : '○ '}{formatEffortLevel(level)}
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
            onClick={() => {
              if (openSpecAutoActive) return;
              setP2pOpen((o) => !o);
            }}
            disabled={disabled || openSpecAutoActive}
            title={openSpecAutoActionLockReason ?? (p2pMode === 'solo' ? getP2pModeLabel('solo', t) : `${t('p2p.team_button', 'Team')}: ${getP2pModeLabel(p2pMode, t)}`)}
            style={{ color: getP2pModeColor(p2pMode), fontSize: 10, fontWeight: p2pMode === 'solo' ? 600 : 700 }}
          >
            {p2pMode === 'solo' ? getP2pModeLabel('solo', t) : `${t('p2p.team_button', 'Team')}:${getP2pModeLabel(p2pMode, t)}`}
          </button>
          <button
            class="shortcut-btn p2p-settings-btn"
            onClick={() => { setP2pOpen(false); openP2pConfigPanel('participants'); }}
            disabled={disabled || openSpecAutoActive}
            title={openSpecAutoActionLockReason ?? t('p2p.settings_title')}
            aria-label={t('p2p.settings_button')}
          >
            <span class="p2p-settings-icon" aria-hidden="true">⚙</span>
            <span class="p2p-settings-label">{t('p2p.settings_button')}</span>
          </button>
          {p2pOpen && renderP2pDropdown(
            <>
              <div
                class="p2p-dropdown-rounds"
                data-testid="p2p-dropdown-rounds"
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <span class="p2p-menu-section-label" style={{ padding: 0 }}>{t('p2p.settings_rounds')}</span>
                  <span
                    class="p2p-dropdown-rounds-hint"
                    title={t('p2p.settings_rounds_explanation')}
                    style={{ fontSize: 10, whiteSpace: 'normal', textAlign: 'right' }}
                  >
                    {t('p2p.settings_rounds_hint')}
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: `repeat(${P2P_DROPDOWN_ROUND_OPTIONS.length}, minmax(0, 1fr))`, gap: 6 }}>
                  {P2P_DROPDOWN_ROUND_OPTIONS.map((roundOption) => {
                    const active = (p2pSavedConfig?.rounds ?? 1) === roundOption;
                    return (
                      <button
                        key={roundOption}
                        type="button"
                        class={`menu-item p2p-dropdown-round ${active ? 'menu-item-active' : ''}`}
                        data-testid={`p2p-dropdown-round-${roundOption}`}
                        data-active={active ? 'true' : 'false'}
                        onClick={() => handleP2pDropdownRoundsChange(roundOption)}
                      >
                        {roundOption}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div
                class="p2p-dropdown-intro"
                title={t('p2p.dropdown.team_intro_tooltip', 'Discussion → summary → implementation → review. More rounds repeat the loop on the previous result.')}
              >
                <div class="p2p-dropdown-intro-title">{t('p2p.dropdown.team_intro_title', 'Team discussion')}</div>
                <div class="p2p-dropdown-intro-body">
                  {t('p2p.dropdown.team_intro_body', 'Agents discuss, summarize, implement, then review the result. Extra rounds repeat the loop to harden the outcome.')}
                </div>
              </div>
              <div class="menu-divider" />
              <button
                class={`menu-item ${p2pMode === 'solo' ? 'menu-item-active' : ''}`}
                onClick={() => {
                  setP2pMode('solo');
                  setP2pExcludeSameType(false);
                  setP2pOpen(false);
                }}
                style={{ color: getP2pMenuItemColor('solo', p2pMode === 'solo'), fontWeight: p2pMode === 'solo' ? 700 : 600 }}
              >
                {p2pMode === 'solo' ? '● ' : '○ '}{t('p2p.dropdown.solo_hint', 'Select a flow below to start a workflow')}
              </button>
              <div class="menu-divider" />
              {/*
               * R3 v2 PR-κ — Tab switcher between the original combo
               * presets list and the saved advanced workflow library.
               * Tab choice persists globally via PREF_KEY_P2P_DROPDOWN_TAB
               * so the user's preference follows them across sessions.
               */}
              <div
                class="p2p-dropdown-tabs"
                data-testid="p2p-dropdown-tabs"
              >
                <button
                  type="button"
                  class={`menu-item p2p-dropdown-tab ${dropdownActiveTab === 'combos' ? 'menu-item-active' : ''}`}
                  data-testid="p2p-dropdown-tab-combos"
                  data-active={dropdownActiveTab === 'combos' ? 'true' : 'false'}
                  onClick={() => setDropdownActiveTab('combos')}
                >
                  {t('p2p.dropdown.tab_combos', t('p2p.combo_label', 'Combos'))}
                </button>
                <button
                  type="button"
                  class={`menu-item p2p-dropdown-tab ${dropdownActiveTab === 'workflows' ? 'menu-item-active' : ''}`}
                  data-testid="p2p-dropdown-tab-workflows"
                  data-active={dropdownActiveTab === 'workflows' ? 'true' : 'false'}
                  onClick={() => setDropdownActiveTab('workflows')}
                >
                  <span>{t('p2p.dropdown.tab_workflows', 'Workflows')}</span>
                  <span class="p2p-alpha-badge" title={t('p2p.alpha_hint', 'Experimental capability; not formally validated yet.')}>
                    {t('p2p.alpha_badge', 'Alpha')}
                  </span>
                </button>
              </div>
              {dropdownActiveTab === 'combos' ? (
                <>
                  {!hasConfiguredP2pParticipants && (
                    <div class="p2p-menu-section-label" style={{ textTransform: 'none', letterSpacing: 'normal', color: '#fbbf24', marginTop: 4 }}>
                      {t('p2p.combo_requires_participants_hint')}
                    </div>
                  )}
                  {comboMenuItems.map((key) => (
                    <button
                      key={key}
                      class={`menu-item p2p-dropdown-combo-item ${isRecommendedCombo(key) ? 'p2p-dropdown-combo-recommended' : ''}`}
                      onClick={() => {
                        if (!hasConfiguredP2pParticipants) return;
                        handleDirectComboSelect(key);
                      }}
                      disabled={!hasConfiguredP2pParticipants}
                      title={!hasConfiguredP2pParticipants
                        ? t('p2p.combo_requires_participants_hint')
                        : isRecommendedCombo(key)
                          ? t('p2p.combo_recommended_hint', 'Recommended for most audit tasks.')
                          : undefined}
                      style={{ color: getP2pModeColor(key), fontSize: 12, opacity: hasConfiguredP2pParticipants ? 1 : 0.45, cursor: hasConfiguredP2pParticipants ? 'pointer' : 'not-allowed' }}
                    >
                      <span class="p2p-dropdown-combo-name">○ {getP2pModeLabel(key, t)}</span>
                      {isRecommendedCombo(key) && (
                        <span class="p2p-recommended-icon" aria-hidden="true">★</span>
                      )}
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
                </>
              ) : (
                <div data-testid="p2p-dropdown-workflows-body">
                  {!hasConfiguredP2pParticipants && (
                    <div class="p2p-menu-section-label" style={{ textTransform: 'none', letterSpacing: 'normal', color: '#fbbf24', marginTop: 4 }}>
                      {t('p2p.combo_requires_participants_hint')}
                    </div>
                  )}
                  {workflowLibraryItems.length === 0 ? (
                    <div
                      class="p2p-menu-section-label"
                      style={{ textTransform: 'none', letterSpacing: 'normal', color: '#94a3b8', padding: '8px 12px', whiteSpace: 'normal' }}
                      data-testid="p2p-dropdown-workflows-empty"
                    >
                      {t('p2p.dropdown.workflows_empty', 'No saved workflows yet. Open Settings → Advanced Workflow to design one.')}
                    </div>
                  ) : (
                    workflowLibraryItems.map((entry) => {
                      const isActive = entry.id === p2pSavedConfig?.activeWorkflowId;
                      const titleText = entry.title?.trim() ? entry.title : t('p2p.tab.advanced_workflow_starter_title', 'Untitled workflow');
                      return (
                        <button
                          key={entry.id}
                          class="menu-item"
                          data-testid={`p2p-dropdown-workflow-${entry.id}`}
                          data-active={isActive ? 'true' : 'false'}
                          onClick={() => {
                            if (!hasConfiguredP2pParticipants) return;
                            handleDirectWorkflowSelect(entry.id);
                          }}
                          disabled={!hasConfiguredP2pParticipants}
                          title={!hasConfiguredP2pParticipants ? t('p2p.combo_requires_participants_hint') : titleText}
                          style={{
                            fontSize: 12,
                            opacity: hasConfiguredP2pParticipants ? 1 : 0.45,
                            cursor: hasConfiguredP2pParticipants ? 'pointer' : 'not-allowed',
                            color: isActive ? '#bfdbfe' : '#e2e8f0',
                            fontWeight: isActive ? 600 : 500,
                          }}
                        >
                          {isActive ? '● ' : '○ '}{titleText}
                        </button>
                      );
                    })
                  )}
                  <div class="menu-divider" />
                  <button
                    class="menu-item"
                    data-testid="p2p-dropdown-workflows-manage"
                    onClick={() => {
                      setP2pOpen(false);
                      openP2pConfigPanel('advanced');
                    }}
                  >
                    {t('p2p.dropdown.workflows_manage', 'Manage workflows')}
                  </button>
                </div>
              )}
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
            </>
          )}
        </div>}
      </div>}

      {pendingTransportApproval && effectiveRuntimeType === 'transport' && (
        <div
          class="transport-approval-banner"
          style={{
            margin: '0 8px 4px',
            padding: '6px 8px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            borderRadius: 8,
            border: '1px solid rgba(96,165,250,0.35)',
            background: 'rgba(30,41,59,0.82)',
            color: '#e2e8f0',
            fontSize: 12,
            lineHeight: 1.25,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{t('session.approval.pending')}</div>
            <div style={{ color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {pendingTransportApproval.tool
                ? t('session.approval.tool', { tool: pendingTransportApproval.tool })
                : pendingTransportApproval.description}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button
              class="btn btn-secondary"
              style={{ minWidth: 64, padding: '4px 8px', fontSize: 12 }}
              disabled={disabled}
              onClick={() => {
                if (!ws || !activeSession || effectiveRuntimeType !== 'transport') return;
                try {
                  ws.respondTransportApproval(activeSession.name, pendingTransportApproval.requestId, true);
                  setPendingTransportApproval(null);
                } catch {
                  // leave the approval visible so the user can retry
                }
              }}
            >
              {t('session.approval.allow')}
            </button>
            <button
              class="btn btn-secondary"
              style={{ minWidth: 64, padding: '4px 8px', fontSize: 12 }}
              disabled={disabled}
              onClick={() => {
                if (!ws || !activeSession || effectiveRuntimeType !== 'transport') return;
                try {
                  ws.respondTransportApproval(activeSession.name, pendingTransportApproval.requestId, false);
                  setPendingTransportApproval(null);
                } catch {
                  // leave the approval visible so the user can retry
                }
              }}
            >
              {t('session.approval.deny')}
            </button>
          </div>
        </div>
      )}

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
            <span
              key={a.path}
              class="attachment-badge"
              title={`#${a.seq} ${a.path}`}
              data-attachment-seq={a.seq}
            >
              {/*
                * R3 v2 PR-ρ — Surface the per-composer sequence number
                * as a `#N` prefix so the user can reference the file in
                * chat text via the same short tag (`#1`, `#2`, ...). The
                * counter resets on send (the attachments array is wiped
                * by `clearComposer`).
                */}
              <span class="attachment-badge-icon" data-testid={`attachment-tag-${a.seq}`}>#{a.seq}</span>
              <span class="attachment-badge-name">{a.name}</span>
              <button
                class="attachment-badge-remove"
                onClick={() => setAttachments((prev) => renumberAttachments(prev.filter((_, j) => j !== i)))}
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
            anchorRef={quickWrapRef}
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
            onLaunchTeam={(modeKey, rounds) => {
              // From the @ picker → TEAM stage: strip the @, close the picker,
              // and launch the discussion directly (reuses the member-gated
              // combo launcher with the chosen round count).
              const text = divRef.current?.textContent ?? '';
              const before = text.replace(/@[^\s@]*$/, '');
              if (divRef.current) divRef.current.textContent = before;
              setHasText(before.trim().length > 0);
              setAtPickerOpen(false);
              setAtPickerStage('choose');
              atJustClosedRef.current = true;
              setTimeout(() => { atJustClosedRef.current = false; atSelectionLockRef.current = false; }, 150);
              handleDirectComboSelect(modeKey, rounds);
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
            class={`controls-input${inputDisabled ? ' controls-input-disabled' : ''}${p2pMode !== 'solo' ? ' controls-input-p2p' : ''}${showEmbeddedVoiceButton ? ' controls-input-with-trailing' : ''}${fileDragActive ? ' controls-input-file-drag-over' : ''}`}
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

              // @@ → open the TEAM dropdown (combos / workflows). Selecting one
              // launches a team discussion immediately with the current composer
              // text as the topic. (Single-agent @@ selection was removed — it
              // had little value vs. the combo/flow team discussion.) Strip the
              // @@ trigger but keep the preceding text as the topic.
              const doubleAt = text.match(/@@[\w-]*$/);
              if (doubleAt) {
                const before = text.replace(/@@[\w-]*$/, '');
                if (divRef.current) divRef.current.textContent = before;
                setHasText(!!before.trim());
                setAtPickerOpen(false);
                setAtPickerStage('choose');
                setP2pOpen(true);
                try {
                  const sel = window.getSelection();
                  const range = document.createRange();
                  range.selectNodeContents(divRef.current!);
                  range.collapse(false);
                  sel?.removeAllRanges();
                  sel?.addRange(range);
                } catch { /* jsdom lacks Selection API */ }
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
            onDragEnter={handleFileDragEnter}
            onDragOver={handleFileDragOver}
            onDragLeave={handleFileDragLeave}
            onDrop={handleFileDrop}
          />
          {showEmbeddedVoiceButton && (
            <button
              class="btn btn-voice btn-voice-embedded"
              // Open on pointerdown (fires synchronously at touch-start) so the
              // tap is never lost to the ~300ms click delay or to a re-render
              // unmounting this conditionally-rendered button mid-gesture (the
              // timeline re-renders constantly while an agent streams).
              // preventDefault stops the tap from falling through to focus the
              // input. onClick is kept as an idempotent fallback.
              onPointerDown={(e) => { e.preventDefault(); setVoiceOpen(true); }}
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
            class="btn btn-secondary controls-icon-btn"
            onClick={() => openP2pConfigPanel('participants')}
            disabled={disabled}
            title={t('p2p.settings_title')}
          >
            ⚙
          </button>
        )}

        {/* Menu button — hidden in compact mode */}
        {!compact && <div class="menu-wrap" ref={menuRef}>
          <button
            class="btn btn-secondary controls-icon-btn"
            onClick={() => { setMenuOpen((o) => !o); resetConfirm(); }}
            disabled={disabled}
            title={t('session.actions')}
          >
            ⋯
          </button>
          {menuOpen && (
            <div class="menu-dropdown session-actions-menu">
              {canShowPinAction && (
                <>
                  <button
                    class="menu-item session-action-menu-item"
                    onClick={() => {
                      if (!activeSession) return;
                      onToggleSessionPin?.(activeSession.name);
                      setMenuOpen(false);
                      resetConfirm();
                    }}
                  >
                    <SessionActionMenuIcon kind={sessionPinned ? 'unpin' : 'pin'} />
                    <span class="session-action-menu-label">{sessionPinned ? t('session.unpin_plain') : t('session.pin_plain')}</span>
                  </button>
                  <div class="menu-divider" />
                </>
              )}
              <button
                class={`menu-item session-action-menu-item ${confirm === 'restart' ? (confirmLevel >= 2 ? 'menu-item-danger' : 'menu-item-warn') : ''}`}
                onClick={() => handleMenuAction('restart')}
              >
                <SessionActionMenuIcon kind="restart" />
                <span class="session-action-menu-label">
                  {confirm === 'restart'
                    ? (confirmLevel >= 2 ? t('session.confirm_sub_restart_2', { label: activeSession?.label || activeSession?.name }) : t('session.confirm_restart'))
                    : t('session.restart_plain')}
                </span>
              </button>
              <button
                class={`menu-item session-action-menu-item ${confirm === 'new' ? (confirmLevel >= 2 ? 'menu-item-danger' : 'menu-item-warn') : ''}`}
                onClick={() => handleMenuAction('new')}
              >
                <SessionActionMenuIcon kind="new" />
                <span class="session-action-menu-label">
                  {confirm === 'new'
                    ? (confirmLevel >= 2 ? t('session.confirm_sub_new_2', { label: activeSession?.label || activeSession?.name }) : t('session.confirm_new'))
                    : t('session.start_fresh')}
                </span>
              </button>
              <button
                class="menu-item session-action-menu-item"
                onClick={() => { onRenameSession?.(); setMenuOpen(false); }}
              >
                <SessionActionMenuIcon kind="rename" />
                <span class="session-action-menu-label">{t('session.rename_plain')}</span>
              </button>
              {onSettings && (
                <button
                  class="menu-item session-action-menu-item"
                  onClick={() => { onSettings(); setMenuOpen(false); }}
                >
                  <SessionActionMenuIcon kind="settings" />
                  <span class="session-action-menu-label">{t('session.settings')}</span>
                </button>
              )}
              {canShowCloneGroupAction && (
                <button
                  class="menu-item session-action-menu-item"
                  onClick={() => {
                    setCloneDialogOpen(true);
                    setMenuOpen(false);
                    resetConfirm();
                  }}
                >
                  <SessionActionMenuIcon kind="clone" />
                  <span class="session-action-menu-label">{t('session.clone.menu')}</span>
                </button>
              )}
              {onShareSession && activeSession && (
                <button
                  class="menu-item session-action-menu-item"
                  onClick={() => {
                    onShareSession(activeSession, subSessionId ?? null);
                    setMenuOpen(false);
                    resetConfirm();
                  }}
                >
                  <SessionActionMenuIcon kind="share" />
                  <span class="session-action-menu-label">{t('share.menu.shareTab')}</span>
                </button>
              )}
              <div class="menu-divider" />
              <button
                class={`menu-item session-action-menu-item ${stopBlockedByPinned || confirm === 'stop' ? 'menu-item-danger' : ''}`}
                disabled={stopBlockedByPinned}
                title={stopBlockedByPinned ? t('session.unpin_to_stop') : undefined}
                onClick={() => handleMenuAction('stop')}
              >
                <SessionActionMenuIcon kind={stopBlockedByPinned ? 'unpin' : 'stop'} />
                <span class="session-action-menu-label">
                  {stopBlockedByPinned
                    ? t('session.unpin_to_stop')
                    : confirm === 'stop'
                      ? (confirmLevel >= 2 ? t('session.confirm_sub_stop_2', { label: activeSession?.label || activeSession?.name }) : t('session.confirm_stop'))
                      : t('session.stop_plain')}
                </span>
              </button>
            </div>
          )}
        </div>}
      </div>
      {cloneDialogOpen && activeSession && (
        <CloneSessionGroupDialog
          ws={ws}
          serverId={serverId}
          sourceSession={activeSession}
          sessions={sessions}
          subSessions={subSessions}
          onClose={() => setCloneDialogOpen(false)}
        />
      )}
      {queuedTransportMessages.length > 0 && (
        queuedHintExpanded ? (
          <div class="controls-queued-hint" role="status" aria-live="polite">
            <div class="controls-queued-header">
              <div>{t('session.transport_send_queued')}</div>
              <button type="button" class="controls-queued-toggle" onClick={toggleQueuedHintExpanded}>
                {t('common.hide')}
              </button>
            </div>
            <div class="controls-queued-list">
              {queuedTransportEntries.map((entry) => {
                const sharedActorLabel = formatSharedActorLabel(t, entry.sharedActor);
                return (
                <div class="controls-queued-item" key={entry.clientMessageId}>
                  <span class="controls-queued-item-text">{entry.text}</span>
                  {sharedActorLabel && (
                    <span class="controls-queued-item-actor" title={sharedActorLabel}>
                      {sharedActorLabel}
                    </span>
                  )}
                  <span
                    class={`controls-queued-item-status controls-queued-item-status-${entry.status ?? 'queued'}`}
                    aria-label={
                      entry.status === 'failed'
                        ? t('chat.sendFailedLabel', 'Send failed')
                        : entry.status === 'sending'
                          ? t('chat.sendingLabel', 'Sending')
                          : t('session.transport_send_queued')
                    }
                    title={
                      entry.status === 'failed'
                        ? t('chat.sendFailedLabel', 'Send failed')
                        : entry.status === 'sending'
                          ? t('chat.sendingLabel', 'Sending')
                          : t('session.transport_send_queued')
                    }
                  />
                  {(isEditableQueuedEntry(entry) || entry.status === 'failed') && (
                    <span class="controls-queued-item-actions">
                      {entry.status === 'failed' ? (
                        <button type="button" class="controls-queued-action" onClick={() => handleQueuedMessageRetry(entry)}>
                          {t('chat.retrySend', 'Retry')}
                        </button>
                      ) : (
                        <button type="button" class="controls-queued-action" onClick={() => handleQueuedMessageEdit(entry)}>
                          {t('settings.edit')}
                        </button>
                      )}
                      <button type="button" class="controls-queued-action controls-queued-action-danger" onClick={() => handleQueuedMessageDelete(entry)}>
                        {t('common.delete')}
                      </button>
                    </span>
                  )}
                </div>
                );
              })}
            </div>
          </div>
        ) : (
          // Collapsed — render a single compact pill (count only) instead of
          // the full hint. The full header+summary+preview was occupying too
          // much vertical space above the composer on mobile.
          <button
            type="button"
            class="controls-queued-pill"
            onClick={toggleQueuedHintExpanded}
            aria-live="polite"
            title={queuedTransportLatestMessage}
          >
            {t('session.transport_send_queued_count', { count: queuedTransportMessages.length })}
          </button>
        )
      )}
      {editingQueuedEntry && (
        <div class="controls-queued-editing">
          <span>{t('session.transport_send_queued')} · {t('settings.edit')}</span>
          <button type="button" class="controls-queued-action" onClick={() => setEditingQueuedMessageId(null)}>
            {t('common.cancel')}
          </button>
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
        serverId={serverId}
        initialTab={p2pConfigInitialTab}
        onClose={() => setP2pConfigOpen(false)}
        onPersistDaemonConfig={(scopeSession, cfg) => persistP2pConfigToDaemon(scopeSession, cfg)}
        onSave={(cfg) => {
          setP2pSavedConfig(cfg);
        }}
        daemonCapabilitySource={ws ? {
          getSnapshot: () => ws.getDaemonCapabilitySnapshot(),
          subscribe: (listener) => ws.onDaemonCapabilitySnapshot(listener),
          // Audit fix (7c2570e9 follow-up to e940d73f-a8e / N4) — expose
          // the WS client's staleness judgment so the panel does not
          // recompute it from `observedAt` (which only refreshes on
          // `daemon.hello`). The WS client tracks a separate
          // `daemonLastSeenAt` that is bumped on every daemon-originated
          // message; this is the only definition that stays accurate
          // during long-lived sessions.
          isStale: (now) => ws.isDaemonCapabilityStale(now),
        } : null}
      />
    )}
    </>
  );
}
