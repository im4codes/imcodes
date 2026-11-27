import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, useImperativeHandle } from 'preact/hooks';
import { createPortal, forwardRef, memo } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import type { ComponentChildren, JSX, RefObject } from 'preact';
import type { WsClient, ServerMessage, TimelineEvent } from '../ws-client.js';
import type { SessionInfo } from '../types.js';
import { QuickInputPanel } from './QuickInputPanel.js';
import { getNavigableHistory } from './QuickInputPanel.js';
import type { UseQuickDataResult } from './QuickInputPanel.js';
import {
  getModelCommandSuggestions,
  getQuickPhraseSuggestions,
  getSlashCommandSuggestions,
  matchModelCommandTrigger,
  matchQuickPhraseTrigger,
  matchSlashCommandTrigger,
} from '../quick-commands.js';
import { FileBrowser } from './file-browser-lazy.js';
import { useNodeGroupsNav } from './node-groups-nav.js';
import { CloneSessionGroupDialog } from './CloneSessionGroupDialog.js';
import { ConfirmButton } from './ConfirmButton.js';
import { useSwipeBack } from '../hooks/useSwipeBack.js';
import { useNowTicker } from '../hooks/useNowTicker.js';
import { useListboxNavigation } from '../hooks/useListboxNavigation.js';
import { SessionActionMenuIcon } from './SessionActionMenuIcon.js';
import { SupervisionHeartbeatBadge } from './SupervisionHeartbeatBadge.js';
import * as VoiceInput from './VoiceInput.js';
import * as RemoteVoiceClient from '../remote-voice-client.js';
import { normalizeVoiceWaveformLevel } from '../voice-waveform.js';
import {
  formatActiveVoiceServiceLabel,
  formatRemoteVoiceFallbackReason,
  getActiveVoiceServiceFrom,
  isIosNativePlatform,
  subscribeActiveVoiceServiceFrom,
  type ActiveVoiceServiceInfo,
} from '../voice-recognition-backend.js';
import { VoiceOverlay } from './VoiceOverlay.js';
import {
  VoiceStreamingRobot,
  applyVoiceRobotLevel,
  clampVoiceRobotLevel,
  clearVoiceRobotLevel,
} from './VoiceStreamingRobot.js';
import { moveCaretToEnd, registerComposerFocusHandler, type FocusComposerOptions } from '../util/composer-focus.js';
import { INLINE_PASTE_TEXT_CHAR_LIMIT } from '../composer-inline-limit.js';
import {
  buildNotepadInlineMessage,
  buildNotepadTranscriptFileName,
  needsNotepadTranscriptAttachment,
  readVoiceNotepadDraft,
  type VoiceNotepadSendOutcome,
  type VoiceNotepadSendRequest,
} from '../voice-notepad.js';
import { AtPicker } from './AtPicker.js';
import { listAgentSkills } from '../api/agent-skills.js';
import type { AgentSkillEntry } from '@shared/agent-skills.js';
import { agentSkillSourceLabel, buildAgentSkillMarker } from '@shared/agent-skill-references.js';
import { FS_SESSION_ROOT_PATH } from '../../../src/shared/transport/fs.js';
import { QuickAgentDelegationDialog, type QuickAgentDelegationCandidate } from './QuickAgentDelegationDialog.js';
import { getActiveCssZoom } from '../ui-scale.js';
import { useAliases } from '../hooks/useAliases.js';
import { insertAliasMarkerAtCaret } from '../util/alias-insert.js';
import { buildAliasSendExtra } from '../util/alias-send.js';
import { filterMachines, useMachines } from '../hooks/useMachines.js';
import {
  MACHINE_GROUP_ALL,
  machineGroupsOf,
  machinesInGroup,
  resolveMachineGroup,
  stepMachineGroupTab,
  useRememberedMachineGroup,
} from '../machine-grouping.js';
import { MachineGroupTabs } from './MachineGroupTabs.js';
import { insertMachineMarkerAtCaret } from '../util/machine-insert.js';
import { buildMachineSendExtra } from '../util/machine-send.js';
import { matchInlineMachineTrigger, stripInlineMachineTrigger } from '../util/machine-trigger.js';
import { MACHINE_IDENTITY_UNAVAILABLE } from '@shared/machine-reference.js';
import { parseAliasMarkers } from '@shared/alias-types.js';
import { filterTaskPairReferences, matchTaskPairReferenceTrigger, openTaskPairReferences, replaceTaskPairReferenceTrigger, taskPairReferenceStatusKey, type TaskPairReference } from '../util/task-pair-reference.js';
import {
  filterCloudDocReferences,
  matchInlineCloudDocTrigger,
  mergeCloudDocReferences,
  normalizeCloudDocReferences,
  replaceInlineCloudDocTrigger,
  type CloudDocReferenceItem,
} from '../util/cloud-doc-reference.js';
import { CODEX_FAST_OFF_COMMAND, isCodexFastServiceTier } from '@shared/codex-service-tier.js';
import {
  computeModelDropdownStyle,
  readSafeAreaBottomPx,
  readSafeAreaTopPx,
} from '../util/model-dropdown-style.js';

export { computeModelDropdownStyle };
import { isInsufficientCapacityError } from '../upload-error.js';
import { MobileDpad, DPAD_ARROW_SEQUENCES } from './MobileDpad.js';
import { P2pConfigPanel, buildP2pWorkflowLaunchEnvelopeFromConfig } from './P2pConfigPanel.js';
import { useExecutionRouting } from '../hooks/useExecutionRouting.js';
import { boundedVisualViewportHeight, createSettledViewportUpdater } from '../visual-viewport.js';
import { getMobileKeyboardState, measureMobileKeyboardShrink } from '../mobile-keyboard.js';
import { buildExecutionTemplateLabel } from '../execution-template-label.js';
import { formatLabel, formatSessionTabLabel } from '../format-label.js';
import {
  OpenSpecAutoDeliverCurrentRunEntry,
  OpenSpecAutoDeliverDetailsPanel,
  OpenSpecAutoDeliverLauncher,
} from './OpenSpecAutoDeliver.js';
import { OpenSpecChangeRow } from './OpenSpecChangeRow.js';
import { useOpenSpecAutoDeliver } from '../hooks/useOpenSpecAutoDeliver.js';
import { requestActiveTimelineRefreshAfterUserAction } from '../hooks/useTimeline.js';
import { isIncognitoTimelineSession } from '../incognito-session-registry.js';
import { isIncognitoSession } from '@shared/session-incognito-types.js';
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
import { cancelSessionViaHttp, deleteAttachment, listCloudDocsApi } from '../api.js';
import { dispatchSessionSend } from '../session-send-transport.js';
import { SHARE_CANCEL_FAILED_EVENT, notifyShareCancelFailure, shareCancelFailureFromHttpError, trackShareCancelCommand } from '../share-cancel-feedback.js';
import { ComposerAttachmentBadge } from './ComposerAttachmentBadge.js';
import { forgetAttachmentPreview, rememberAttachmentPreview } from '../attachment-preview-cache.js';
import { safeSessionStorageGetItem, safeSessionStorageRemoveItem, safeSessionStorageSetItem } from '../local-storage-quota.js';
import { attachmentDownloadId } from '../attachment-refs.js';
import { formatTransferBytes, formatTransferDuration } from '../util/transfer-format.js';
import { DIRECT_FILE_TRANSFER_ERROR } from '@shared/direct-file-transfer.js';
import { SUBSESSION_CREATED_BATCH_MSG } from '@shared/scale-limits.js';
import { getPcAppBridge, isNativeMacDesktop, isPcAppInlineVoiceSupported, type PcAppVoiceInputDevice } from '../native-platform.js';
import { setBackgroundTransferKeepAliveLabels } from '../background-transfer-keepalive.js';
import { getUploadBackgroundEpoch, isUploadEnvironmentSuspended } from '../upload-suspend-wait.js';
import {
  deletePendingUpload,
  listPendingUploadsForKey,
  PENDING_UPLOAD_MAX_FILE_BYTES,
  persistPendingUploadFile,
} from '../pending-upload-store.js';
import { isMobileDevice, subscribeDeviceLayoutChange } from '../mobile-device.js';
import { registerMacVoiceComposerHandler } from '../mac-voice-shortcut.js';
import { DirectFileTransferFailure, FILE_UPLOAD_TRANSPORT_MODE, prewarmDirectFileLease, resolveResumableUploadIdentity, uploadFileWithDirectFallback, type FileUploadTransportMode } from '../direct-file-transfer.js';
import { patchSessionSupervision } from '../api.js';
import { isImeComposingKeyEvent } from '../ime-keyboard.js';
import { collectSettledQueuedIds } from '../session-controls-queue.js';
import { deriveSessionLiveStatus, isRunningSessionState } from '../session-live-status.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import {
  TRANSPORT_STOP_QUEUE_FIELDS,
  TRANSPORT_STOP_QUEUE_OUTCOMES,
  TRANSPORT_STOP_QUEUE_TIMEOUT_MS,
  TRANSPORT_QUEUE_COMMANDS,
  TRANSPORT_QUEUE_DELIVERY_EVENT_TYPE,
} from '@shared/transport-queue-types.js';
import {
  queuedMessageDeliveryLabelKey,
  type QueueDeliveryPolicy,
  DEFAULT_SESSION_SEND_DELIVERY_MODE,
  SESSION_SEND_DELIVERY_MODES,
  SESSION_SEND_DELIVERY_USER_PREF_KEY,
  type SessionSendDeliveryMode,
} from '@shared/session-send-delivery.js';
import { MSG_COMMAND_FAILED } from '@shared/ack-protocol.js';
import { FS_READ_ERROR_CODES } from '@shared/fs-read-error-codes.js';
import {
  buildTransportPendingSyncPatch,
  hasTransportPendingSyncSnapshot,
  normalizeTransportPendingEntries,
} from '../transport-queue.js';
import { canSharedActorControlSession, canSharedActorManageServer, formatSharedActorLabel } from '../tab-sharing-ui.js';
import { resolveSessionInfoRuntimeType } from '../runtime-type.js';
import {
  buildP2pConfigSelection,
  P2P_CONFIG_MODE,
  COMBO_SEPARATOR,
  getEnabledP2pMemberNames,
  isComboMode,
  sanitizeP2pSavedConfig,
} from '@shared/p2p-modes.js';
import { P2P_CONFIG_ERROR, P2P_CONFIG_MSG } from '@shared/p2p-config-events.js';
import { TRANSPORT_MSG } from '@shared/transport-events.js';
import type { P2pSavedConfig } from '@shared/p2p-modes.js';
import { migrateLegacyWorkflowDraft, normalizeWorkflowLibrary } from '@shared/p2p-workflow-library.js';
import type { P2pWorkflowDraft } from '@shared/p2p-workflow-types.js';
import { getQwenAuthTier, QWEN_AUTH_TIERS, QWEN_AUTH_TYPES } from '@shared/qwen-auth.js';
import { getKnownQwenModelDescription, getKnownQwenModelOptions } from '@shared/qwen-models.js';
import { AGY_MODEL_IDS, CLAUDE_CODE_MODEL_IDS, CODEX_MODEL_IDS, mergeModelSuggestions, normalizeClaudeCodeModelId } from '../../../src/shared/models/options.js';
import { CLAUDE_SDK_EFFORT_LEVELS, CODEX_SDK_EFFORT_LEVELS, COPILOT_SDK_EFFORT_LEVELS, MUSE_SDK_EFFORT_LEVELS, OPENCLAW_THINKING_LEVELS, QWEN_EFFORT_LEVELS, clampTransportEffort, formatEffortLevel, type TransportEffortLevel } from '@shared/effort-levels.js';
import { resolveEffectiveSessionModel } from '@shared/session-model.js';
import { shortModelLabel } from '../model-label.js';
import { CUSTOM_PROVIDER_SDK_AGENT_TYPES } from '@shared/cc-presets.js';
import { useTransportModels, supportsDynamicTransportModels } from '../hooks/useTransportModels.js';
import { loadCodexModelPreference, loadLegacyCodexModelPreferenceForModelessSession, saveCodexModelPreference } from '../codex-model-preference.js';
import { saveAgyModelPreference } from '../agy-model-preference.js';
import { dispatchSessionModelSwitch } from '../session-model-switch.js';
import {
  canSessionRoleOwnAutomaticSupervision,
  extractSessionSupervisionSnapshot,
  hasInvalidSessionSupervisionSnapshot,
  isSupportedSupervisionTargetSessionType,
  SUPERVISION_MODE,
  type SessionSupervisionSnapshot,
  type SupervisionMode,
  evaluateAutomaticSupervisionEnablement,
} from '@shared/supervision-config.js';
import { FILE_TRANSFER_LIMITS } from '@shared/transport/file-transfer.js';
import { SESSION_MODEL_COMMAND, shouldHideOptimisticUserMessageForSessionControl } from '@shared/session-control-commands.js';
import { resizeHandleHoverEvents } from './window-resize.js';
import type { SharedActorEnvelope } from '@shared/tab-sharing.js';
import { EXECUTION_CLONE_KIND } from '@shared/execution-clone.js';
import {
  CODEBUDDY_CHINA_MODEL_FALLBACK,
  CODEBUDDY_INTERNATIONAL_MODEL_FALLBACK,
  CODEBUDDY_PROVIDER_IDS,
  isCodeBuddyProviderId,
} from '@shared/codebuddy.js';
import { HERMES_AGENT_PROVIDER_ID } from '@shared/hermes-agent.js';
import { AGY_SDK_PROVIDER_ID } from '@shared/agy-agent.js';
import {
  buildAgentDelegationOrchestrationPrompt,
  isDelegationUnsupportedControlText,
  type QuickAgentDelegationPreset,
} from '@shared/agent-delegation.js';
import {
  type SessionSettingsOpenIntent,
} from '../session-settings-open-intent.js';
import type { PendingSharedSessionUpload } from '../services/share-receiver.js';
import { recordPerfRender } from '../perf-render-debug.js';

export const COMPOSER_HEIGHT_STORAGE_KEY = 'imcodes_composer_height_v1';
export const ATTACHMENT_BADGE_COLLAPSE_THRESHOLD = 3;
export const ATTACHMENT_BADGE_COLLAPSED_VISIBLE_COUNT = 2;
const VOICE_HOLD_TAP_GUARD_MS = 145;
const VOICE_HOLD_UNFOCUSED_DELAY_MS = 175;
const VOICE_HOLD_SLIDE_INTENT_MS = 90;
const VOICE_HOLD_SLIDE_PROMOTE_PX = 14;
const VOICE_HOLD_MOVE_SLOP_PX = 18;
const VOICE_HOLD_SCROLL_ABORT_PX = 40;
const VOICE_HOLD_CANCEL_THRESHOLD_PX = 44;
const VOICE_HOLD_EDIT_THRESHOLD_PX = 44;
const VOICE_HOLD_SLIDE_MAX_PX = 84;
const VOICE_HOLD_START_TIMEOUT_MS = 10_000;
const VOICE_HOLD_FAILED_DRAIN_TIMEOUT_MS = 2500;
const VOICE_HOLD_DROP_ANIMATION_MS = 300;
export const VOICE_HOLD_COMPOSER_CLEARANCE_GAP_PX = 16;
const VOICE_HOLD_BAR_COUNT = 28;
const VOICE_HOLD_BAR_MIN_PX = 5;
const VOICE_HOLD_BAR_MAX_PX = 27;

interface VoiceHoldWaveformHandle {
  pushLevel: (level: number) => void;
  reset: () => void;
}

/**
 * Isolated 28-bar GPU-composited waveform (`scaleY` + `opacity` via DOM refs) so live audio
 * level ticks never re-render `SessionControls` or trigger layout reflow.
 */
const VoiceHoldWaveform = memo(
  forwardRef<VoiceHoldWaveformHandle, { recording: boolean; liveAudio: boolean; ended: boolean; starting?: boolean }>(
    function VoiceHoldWaveform({ recording, liveAudio, ended, starting = false }, ref) {
      const barElsRef = useRef<Array<HTMLSpanElement | null>>(Array(VOICE_HOLD_BAR_COUNT).fill(null));
      const levelsRef = useRef<number[]>(Array(VOICE_HOLD_BAR_COUNT).fill(0));

      const applyLevels = useCallback((levels: number[]) => {
        const els = barElsRef.current;
        for (let i = 0; i < VOICE_HOLD_BAR_COUNT; i++) {
          const el = els[i];
          if (!el) continue;
          const level = levels[i] ?? 0;
          const centerNorm = 1 - Math.abs((i / Math.max(1, VOICE_HOLD_BAR_COUNT - 1)) * 2 - 1);
          const envelope = 0.38 + 0.62 * Math.sin((centerNorm * Math.PI) / 2);
          const scale = (VOICE_HOLD_BAR_MIN_PX + level * 22 * envelope) / VOICE_HOLD_BAR_MAX_PX;
          el.style.transform = `scaleY(${scale.toFixed(6)})`;
          el.style.opacity = String(0.45 + level * 0.55);
        }
      }, []);

      useImperativeHandle(ref, () => ({
        pushLevel(level: number) {
          const prev = levelsRef.current;
          let isEmpty = true;
          for (let i = 0; i < prev.length; i++) {
            if (prev[i]! >= 0.01) {
              isEmpty = false;
              break;
            }
          }
          if (isEmpty && level > 0.01) {
            for (let i = 0; i < prev.length; i++) {
              prev[i] = level * (0.55 + ((i * 7) % 5) * 0.11);
            }
            applyLevels(prev);
            return;
          }
          prev.copyWithin(0, 1);
          prev[prev.length - 1] = level;
          applyLevels(prev);
        },
        reset() {
          levelsRef.current.fill(0);
          applyLevels(levelsRef.current);
        },
      }), [applyLevels]);

      useLayoutEffect(() => {
        applyLevels(levelsRef.current);
      }, [applyLevels]);

      return (
        <div
          class={`voice-hold-hud-waveform${starting ? ' is-starting' : ''}${recording && !liveAudio ? ' is-ambient-wave' : ''}${ended ? ' is-ended' : ''}`}
          aria-hidden="true"
        >
          {Array.from({ length: VOICE_HOLD_BAR_COUNT }, (_, idx) => (
            <span
              key={idx}
              ref={(el) => {
                barElsRef.current[idx] = el;
              }}
              class="voice-hold-hud-bar"
            />
          ))}
        </div>
      );
    },
  ),
);

interface VoiceHoldHudHandle {
  setDragX: (dragX: number) => void;
  pushLevel: (level: number) => void;
  resetBars: () => void;
  getBottomPx: () => number | null;
}

interface VoiceHoldHudProps {
  active: boolean;
  phase: 'starting' | 'recording' | 'ended' | 'draining' | 'dropping';
  zone: 'send' | 'cancel' | 'edit';
  dragXRef: RefObject<number>;
  dropY: number | null;
  bottomClearance: number | null;
  text: string;
  recognizing: boolean;
  liveAudio: boolean;
  modelLoading?: boolean;
  serviceLabel?: string;
  fallbackReason?: string | null;
  transcriptRef: RefObject<HTMLDivElement>;
}

/**
 * Isolated hold-to-talk HUD portal: high-frequency horizontal drag offset (`--voice-slide-x`)
 * and audio level bars mutate DOM refs directly without reconciling `SessionControls`.
 */
const VoiceHoldHud = memo(
  forwardRef<VoiceHoldHudHandle, VoiceHoldHudProps>(function VoiceHoldHud(
    { active, phase, zone, dragXRef, dropY, bottomClearance, text, recognizing, liveAudio, modelLoading = false, serviceLabel = '', fallbackReason = null, transcriptRef },
    ref,
  ) {
    const { t } = useTranslation();
    const hudElRef = useRef<HTMLDivElement | null>(null);
    const waveformRef = useRef<VoiceHoldWaveformHandle | null>(null);

    useImperativeHandle(ref, () => ({
      setDragX(dragX: number) {
        if (hudElRef.current) {
          hudElRef.current.style.setProperty('--voice-slide-x', `${dragX}px`);
        }
      },
      pushLevel(level: number) {
        waveformRef.current?.pushLevel(level);
        applyVoiceRobotLevel(transcriptRef.current, level);
      },
      resetBars() {
        waveformRef.current?.reset();
        clearVoiceRobotLevel(transcriptRef.current);
      },
      getBottomPx() {
        const rect = hudElRef.current?.getBoundingClientRect();
        return rect && Number.isFinite(rect.bottom) && rect.height > 0 ? rect.bottom : null;
      },
    }), []);

    if (!active || typeof document === 'undefined') return null;

    const voiceHoldStarting = phase === 'starting';
    const voiceHoldRecording = phase === 'recording';
    const voiceHoldEnded = phase === 'ended';
    const voiceHoldDraining = phase === 'draining';
    const voiceHoldDropping = phase === 'dropping';
    const voiceHoldActuallyRecognizing = (voiceHoldRecording && recognizing) || voiceHoldDraining;
    const voiceHoldStartingEmpty = voiceHoldStarting && !text.trim();
    const voiceHoldTranscriptDisplay = text.trim()
      ? text
      : voiceHoldEnded
        ? t('voice.no_speech')
        : voiceHoldDraining
          ? t('voice.buffering_hint')
          : voiceHoldStarting
            ? (modelLoading ? t('voice.loading_model') : t('voice.preparing_wait'))
            : voiceHoldRecording
              ? (voiceHoldActuallyRecognizing ? t('voice.buffering_hint') : t('voice.speak_now'))
              : '';
    const voiceHoldStatusLabel = voiceHoldEnded
      ? (text.trim() ? t('voice.ended') : t('voice.no_speech'))
      : voiceHoldStarting
        ? (modelLoading ? t('voice.loading_model') : t('voice.starting'))
        : voiceHoldActuallyRecognizing
          ? t('voice.recognizing')
          : t('voice.listening');

    return createPortal(
      <div
        ref={hudElRef}
        class={`voice-hold-hud voice-hold-hud-zone-${zone}${voiceHoldDropping ? ' is-dropping' : ''}`}
        data-zone={zone}
        data-phase={phase}
        style={{
          '--voice-slide-x': `${dragXRef.current ?? 0}px`,
          ...(dropY !== null ? { '--voice-drop-y': `${dropY}px` } : {}),
          ...(bottomClearance !== null ? { '--voice-hud-bottom-clearance': `${bottomClearance}px` } : {}),
        } as JSX.CSSProperties}
        role="status"
        aria-live="polite"
      >
        <div class="voice-hold-hud-atmosphere" aria-hidden="true">
          <div class="voice-hold-hud-aurora" />
          <div class="voice-hold-hud-aurora-core" />
        </div>
        <div class="voice-hold-hud-transcript-stage">
          <div ref={transcriptRef} class={`voice-hold-hud-transcript${voiceHoldStartingEmpty ? ' is-starting' : ''}`}>
            {voiceHoldTranscriptDisplay}
            <VoiceStreamingRobot active={voiceHoldActuallyRecognizing} />
          </div>
        </div>
        <div class="voice-hold-hud-card">
          <div class="voice-hold-hud-header">
            <span class={`voice-hold-hud-recognizing${voiceHoldStarting ? ' is-starting' : ''}${voiceHoldActuallyRecognizing ? ' is-recognizing' : ''}${voiceHoldEnded ? ' is-ended' : ''}`}>
              {voiceHoldStarting ? (
                <span class="voice-hold-starting-spinner" aria-hidden="true" />
              ) : (
                <span
                  class={`voice-status-dot${voiceHoldRecording || voiceHoldDraining ? ' voice-status-dot-active' : ''}${voiceHoldActuallyRecognizing ? ' voice-status-dot-recognizing' : ''}${voiceHoldEnded ? ' voice-status-dot-ended' : ''}`}
                  aria-hidden="true"
                />
              )}
              {(voiceHoldRecording || voiceHoldDraining) && (
                <span class="voice-recognizing-dots" aria-hidden="true">
                  <i /><i /><i />
                </span>
              )}
              {voiceHoldStatusLabel && <span>{voiceHoldStatusLabel}</span>}
            </span>
            {serviceLabel && (
              <span
                class="voice-hold-hud-service"
                data-testid="voice-hold-service-badge"
                title={serviceLabel}
              >
                {serviceLabel}
              </span>
            )}
            {fallbackReason && (
              <span
                class="voice-hold-hud-fallback-reason"
                data-testid="voice-hold-fallback-reason"
                title={fallbackReason}
              >
                {fallbackReason}
              </span>
            )}
          </div>
          <div class={`voice-hold-hud-active-hint is-${zone}`}>
            {zone === 'cancel'
              ? t('voice.release_to_cancel')
              : zone === 'edit'
                ? t('voice.release_to_edit')
                : voiceHoldStarting
                  ? t('voice.preparing_wait')
                  : t('voice.release_to_send')}
          </div>
          <VoiceHoldWaveform
            ref={waveformRef}
            recording={voiceHoldRecording}
            liveAudio={liveAudio}
            ended={voiceHoldEnded}
            starting={voiceHoldStarting}
          />
          <div class="voice-hold-hud-zones">
            {(['cancel', 'send', 'edit'] as const).map((z) => {
              const isActive = zone === z;
              const label = z === 'cancel'
                ? t('voice.slide_left_cancel')
                : z === 'edit'
                  ? t('voice.slide_right_edit')
                  : t('voice.release_to_send');
              return (
                <div
                  key={z}
                  class={`voice-hold-zone voice-hold-zone-${z}${isActive ? ' is-active' : ''}`}
                  data-zone-target={z}
                >
                  {z === 'cancel' && (
                    <svg
                      class="voice-hold-zone-arrow"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M19 12H5" />
                      <path d="M12 19l-7-7 7-7" />
                    </svg>
                  )}
                  {z === 'send' && (
                    <svg
                      class="voice-hold-zone-arrow voice-hold-zone-send-icon"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.1"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 19V5" />
                      <path d="M5 12l7-7 7 7" />
                    </svg>
                  )}
                  <span class="voice-hold-zone-label">{label}</span>
                  {z === 'edit' && (
                    <svg
                      class="voice-hold-zone-arrow"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M5 12h14" />
                      <path d="M12 5l7 7-7 7" />
                    </svg>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>,
      document.body,
    );
  }),
);

function applyComposerVoiceTouchLock(el: HTMLDivElement | null, lockContentEditable: boolean): void {
  if (!el) return;
  const style = el.style as CSSStyleDeclaration & {
    webkitUserSelect?: string;
    webkitTouchCallout?: string;
    webkitUserModify?: string;
  };
  style.userSelect = 'none';
  style.setProperty('-webkit-user-select', 'none');
  style.webkitUserSelect = 'none';
  style.setProperty('-webkit-touch-callout', 'none');
  style.webkitTouchCallout = 'none';
  style.setProperty('-webkit-user-modify', 'read-only');
  style.webkitUserModify = 'read-only';
  if (lockContentEditable) {
    el.setAttribute('contenteditable', 'false');
  }
}

function clearComposerVoiceTouchLock(el: HTMLDivElement | null, disabled: boolean): void {
  if (!el) return;
  const composer = el.closest('.controls-composer');
  if (composer) {
    // Strip pending/holding classes synchronously so -webkit-user-modify: read-only !important
    // is lifted before el.focus() executes in the same pointerup/fallback user-gesture turn.
    composer.classList.remove('controls-composer-voice-pending', 'controls-composer-voice-holding');
  }
  const style = el.style as CSSStyleDeclaration & {
    webkitUserSelect?: string;
    webkitTouchCallout?: string;
    webkitUserModify?: string;
  };
  style.removeProperty('user-select');
  style.removeProperty('-webkit-user-select');
  style.removeProperty('-webkit-touch-callout');
  style.removeProperty('-webkit-user-modify');
  style.webkitUserSelect = '';
  style.webkitTouchCallout = '';
  style.webkitUserModify = '';
  el.setAttribute('contenteditable', disabled ? 'false' : 'true');
}

function prefersVoiceHoldReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Compute CSS pixel bottom padding needed so `.voice-hold-hud-card` and `.voice-hold-hud-zones`
 * sit cleanly above `.controls-composer` rather than under the holding finger.
 */
export function computeVoiceHoldBottomClearancePx(
  composerEl: HTMLElement | null,
  viewportHeightPx: number,
  cssZoom = 1,
): number | null {
  if (!composerEl) return null;
  if (!Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0) return null;
  const rect = composerEl.getBoundingClientRect();
  if (
    !rect
    || !Number.isFinite(rect.top)
    || !Number.isFinite(rect.bottom)
    || !Number.isFinite(rect.width)
    || !Number.isFinite(rect.height)
    || (rect.width <= 0 && rect.height <= 0)
  ) {
    return null;
  }
  const safeZoom = Number.isFinite(cssZoom) && cssZoom > 0 ? cssZoom : 1;
  const distanceFromBottomPx = (viewportHeightPx - rect.top) / safeZoom;
  if (!Number.isFinite(distanceFromBottomPx) || distanceFromBottomPx <= 0) {
    return null;
  }
  const clearance = Math.round(distanceFromBottomPx + VOICE_HOLD_COMPOSER_CLEARANCE_GAP_PX);
  return Number.isFinite(clearance) && clearance > 0 ? clearance : null;
}

function computeVoiceHoldDropOffsetPx(
  transcriptEl: HTMLElement | null,
  composerEl: HTMLElement | null,
): number | null {
  if (!transcriptEl || !composerEl) return null;
  const tRect = transcriptEl.getBoundingClientRect();
  const cRect = composerEl.getBoundingClientRect();
  if (!tRect || !cRect || (tRect.height <= 0 && tRect.width <= 0) || (cRect.height <= 0 && cRect.width <= 0)) {
    return null;
  }
  const tCenterY = tRect.top + tRect.height / 2;
  const cCenterY = cRect.top + cRect.height / 2;
  const delta = Math.round(cCenterY - tCenterY);
  return delta > 24 ? Math.min(delta, 560) : null;
}

function prewarmVoiceInput(options?: { requestPermission?: boolean }): void {
  if (!Object.prototype.hasOwnProperty.call(VoiceInput, 'prewarm')) return;
  const fn = (VoiceInput as { prewarm?: (opts?: { requestPermission?: boolean }) => Promise<void> }).prewarm;
  if (typeof fn === 'function') {
    void fn(options);
  }
}

function readVoiceInputMethod<T extends (...args: never[]) => unknown>(key: string): T | undefined {
  if (!Object.prototype.hasOwnProperty.call(VoiceInput, key)) return undefined;
  const candidate = (VoiceInput as Record<string, unknown>)[key];
  return typeof candidate === 'function' ? (candidate as T) : undefined;
}

function shouldPrimeVoiceInputOnPointerDown(): boolean {
  if (Object.prototype.hasOwnProperty.call(VoiceInput, 'needsPointerDownGesturePrime')) {
    const fn = (VoiceInput as { needsPointerDownGesturePrime?: () => boolean }).needsPointerDownGesturePrime;
    if (typeof fn === 'function') return fn();
  }
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (typeof cap?.isNativePlatform === 'function' && cap.isNativePlatform()) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(VoiceInput, 'primeVoiceGesture')
    || Object.prototype.hasOwnProperty.call(VoiceInput, 'primeWebGesture');
}

function primeVoiceInputGesture(options?: { deferAudioPause?: boolean }): boolean {
  if (Object.prototype.hasOwnProperty.call(VoiceInput, 'primeVoiceGesture')) {
    const fn = (VoiceInput as { primeVoiceGesture?: (opts?: { deferAudioPause?: boolean }) => boolean }).primeVoiceGesture;
    if (typeof fn === 'function') return fn(options);
  }
  if (!Object.prototype.hasOwnProperty.call(VoiceInput, 'primeWebGesture')) return false;
  const fn = (VoiceInput as { primeWebGesture?: (opts?: { deferAudioPause?: boolean }) => boolean }).primeWebGesture;
  return typeof fn === 'function' ? fn(options) : false;
}

function cancelVoiceInputGesturePrime(): void {
  if (Object.prototype.hasOwnProperty.call(VoiceInput, 'cancelVoiceGesturePrime')) {
    const fn = (VoiceInput as { cancelVoiceGesturePrime?: () => void }).cancelVoiceGesturePrime;
    if (typeof fn === 'function') {
      fn();
      return;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(VoiceInput, 'cancelWebGesturePrime')) return;
  const fn = (VoiceInput as { cancelWebGesturePrime?: () => void }).cancelWebGesturePrime;
  if (typeof fn === 'function') fn();
}

function triggerVoiceHoldHaptic(
  style: VoiceInput.HapticFeedbackStyle = 'medium',
  durationMs = 20,
): void {
  if (Object.prototype.hasOwnProperty.call(VoiceInput, 'triggerHapticFeedback')) {
    const fn = (VoiceInput as {
      triggerHapticFeedback?: (ms?: number, style?: VoiceInput.HapticFeedbackStyle) => Promise<void>;
    }).triggerHapticFeedback;
    if (typeof fn === 'function') {
      void fn(durationMs, style);
      return;
    }
  }
  try {
    navigator.vibrate?.(durationMs);
  } catch {
    /* ignore */
  }
}
/**
 * Floor for the shared desktop composer height, matching the three-row resting
 * size the desktop stylesheet sets.
 *
 * It has to be enforced here as well as in CSS, not instead of it: once the
 * user has resized, the pinned height is written as an inline `minHeight` on
 * the input, and an inline style beats any stylesheet rule. A lower floor here
 * would let a drag — or a height stored before this floor existed — shrink the
 * composer back below three rows. `readStoredComposerHeight` re-clamps on read,
 * so raising this migrates older stored values on its own.
 *
 * Desktop-only in effect: the pinned height is not applied on mobile, and the
 * resize affordances that write it are hidden there.
 *
 * The value is the computed input height from `styles.css`: `(2 x 1.45em) +
 * 10px` at the composer's 13px font size = 48px. The box rests three rows tall
 * in total, with the control row underneath making up the third. If either the
 * type scale or the composer padding changes, both must move together.
 */
export const COMPOSER_HEIGHT_MIN_PX = 48;
export const COMPOSER_HEIGHT_MAX_PX = 360;
const COMPOSER_HEIGHT_STEP_PX = 16;
const COMPOSER_HEIGHT_EVENT = 'imcodes:composer-height';

function clampComposerHeight(height: number): number {
  return Math.min(COMPOSER_HEIGHT_MAX_PX, Math.max(COMPOSER_HEIGHT_MIN_PX, Math.round(height)));
}

function readStoredComposerHeight(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = Number.parseInt(window.localStorage.getItem(COMPOSER_HEIGHT_STORAGE_KEY) ?? '', 10);
    return Number.isFinite(parsed) ? clampComposerHeight(parsed) : null;
  } catch {
    return null;
  }
}

function broadcastComposerHeight(height: number): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<number>(COMPOSER_HEIGHT_EVENT, { detail: clampComposerHeight(height) }));
}

function persistComposerHeight(height: number): void {
  const next = clampComposerHeight(height);
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COMPOSER_HEIGHT_STORAGE_KEY, String(next));
  } catch {
    // Private browsing/storage denial must not disable live resizing.
  }
  broadcastComposerHeight(next);
}

function useSharedComposerHeight(): number | null {
  const [height, setHeight] = useState<number | null>(readStoredComposerHeight);

  useEffect(() => {
    const syncStoredHeight = (event: StorageEvent) => {
      if (event.key === COMPOSER_HEIGHT_STORAGE_KEY || event.key === null) {
        setHeight(readStoredComposerHeight());
      }
    };
    const syncLiveHeight = (event: Event) => {
      const next = (event as CustomEvent<number>).detail;
      if (Number.isFinite(next)) setHeight(clampComposerHeight(next));
    };
    window.addEventListener('storage', syncStoredHeight);
    window.addEventListener(COMPOSER_HEIGHT_EVENT, syncLiveHeight);
    setHeight(readStoredComposerHeight());
    return () => {
      window.removeEventListener('storage', syncStoredHeight);
      window.removeEventListener(COMPOSER_HEIGHT_EVENT, syncLiveHeight);
    };
  }, []);

  return height;
}

function isExecutionCloneTemplateLike(sub: { executionCloneKind?: string | null; parentRunId?: string | null }): boolean {
  return sub.executionCloneKind === EXECUTION_CLONE_KIND || typeof sub.parentRunId === 'string';
}

interface Props {
  ws: WsClient | null;
  activeSession: SessionInfo | null;
  /** React-owned browser/server WS state. Prefer this over ws.connected, which can change without a render. */
  connected?: boolean;
  inputRef?: RefObject<HTMLDivElement>;
  /** Called after each shortcut/action button click — use to restore focus to xterm on desktop. */
  onAfterAction?: () => void;
  /** Called when stop is confirmed — immediately removes tab from state. */
  onStopProject?: (project: string) => void;
  /** Called when Rename is selected in the menu. */
  onRenameSession?: () => void;
  /** Called when Settings is selected in the menu. */
  onSettings?: (intent?: SessionSettingsOpenIntent) => void;
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
  /** Hide workflow toolbar controls (Quick Audit, Supervision dropdown, OpenSpec) in mini floats and sub-session windows. */
  hideWorkflowControls?: boolean;
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
      /** The user explicitly appended this row to the active turn. */
      queueAppend?: boolean;
    },
  ) => void;
  /** Remove an optimistic append row when provider admission is rejected. */
  onRemoveOptimisticMessage?: (commandId: string) => void;
  /** Flip a timeline optimistic bubble to retryable failed state when HTTP fallback rejects. */
  onSendFailed?: (commandId: string, error?: string) => void;
  /** Sub-session overrides — when set, menu actions use these instead of main session commands. */
  onSubRestart?: () => void;
  onSubNew?: () => void;
  onSubStop?: () => void;
  /** Legacy prop retained for callers that still pass thinking state for labels/timers. */
  activeThinking?: boolean;
  /** True while transport timeline tail shows an in-flight turn, even if session.state has not caught up. */
  activeTransportTurn?: boolean;
  /**
   * Materialized timeline for the controlled session. A committed user-message
   * or queue-delivery fact is stronger evidence than any stale queue snapshot:
   * once either exists, that clientMessageId must never remain editable in the
   * queue card. This also closes event-before-listener and reconnect/replay gaps.
   */
  transportTimelineEvents?: readonly TimelineEvent[];
  /**
   * Precomputed `collectSettledQueuedIds(transportTimelineEvents, …)`, supplied by
   * StableSessionControls so this component need not re-render (or rescan the
   * timeline) when only unrelated timeline events changed.
   */
  timelineSettledQueuedIds?: ReadonlySet<string>;
  /** Mobile: open full-screen file browser overlay. */
  mobileFileBrowserOpen?: boolean;
  onMobileFileBrowserClose?: () => void;
  /** Open Controlled Nodes management (passed through to FileBrowser / DocShareDialog). */
  onOpenNodeGroups?: () => void;
  /** All sessions — for @ picker agent list. */
  sessions?: SessionInfo[];
  /** Sub-sessions — for @ picker agent list (includes deck_sub_*).
   *  `executionTemplateEligible` / `executionTemplateIneligibleReason` are
   *  DAEMON-AUTHORITATIVE flags (optional; absent on legacy daemons) consumed
   *  by the OpenSpec Execute dropdown and the Team Settings template picker. */
  subSessions?: Array<{
    sessionName: string;
    type: string;
    /** Provider/env preset name (e.g. a custom-API preset). Optional/graceful —
     *  shown in the OpenSpec Execute candidate label when present. */
    ccPresetId?: string | null;
    label?: string | null;
    state: string;
    parentSession?: string | null;
    executionCloneKind?: string | null;
    parentRunId?: string | null;
    qwenModel?: string | null;
    requestedModel?: string | null;
    activeModel?: string | null;
    sessionInstanceId?: string | null;
    runtimeEpoch?: string | null;
    providerId?: string | null;
    agentType?: string | null;
    modelDisplay?: string | null;
    executionTemplateEligible?: boolean;
    executionTemplateIneligibleReason?: string;
  }>;
  /** Server ID — required for file upload. */
  serverId?: string;
  /** Optional larger drop target that should behave like the composer upload area. */
  fileDropTargetRef?: RefObject<HTMLElement>;
  /** Quoted text segments from chat messages. */
  quotes?: string[];
  /** Called to remove a quote by index. */
  onRemoveQuote?: (index: number) => void;
  /** Task-jump reference quote attached automatically from Task Mode (separate provenance from manual quotes). */
  taskQuote?: string | null;
  /** Called to remove the attached task-jump quote. */
  onRemoveTaskQuote?: () => void;
  /** Text to append into the input when arriving from "Go & quote". */
  pendingPrefillText?: string | null;
  /** Called after pendingPrefillText has been applied. */
  onPendingPrefillApplied?: () => void;
  /** Pending shared files/text from external app share target modal. */
  pendingSharedUpload?: PendingSharedSessionUpload | null;
  /** Called after pendingSharedUpload has been consumed by the target session composer. */
  onPendingSharedUploadConsumed?: (id: string) => void;
  /** Compact mode for sub-session cards — only input, @, ⚡, 📎, send. */
  compact?: boolean;
  /** Whether this full control surface is the active keyboard target for window-level shortcuts. */
  keyboardActive?: boolean;
  /** Notifies parent when the quick input panel opens/closes. */
  onQuickOpenChange?: (open: boolean) => void;
  /** Notifies parent when any floating overlay/dropdown is open. */
  onOverlayOpenChange?: (open: boolean) => void;
  /** Optional local optimistic update when transport config changes through quick controls. */
  onTransportConfigSaved?: (transportConfig: Record<string, unknown> | null) => void;
  /** Gate version-sensitive panels when the loaded frontend is stale. */
  onVersionSensitiveAction?: (featureLabel: string, action: () => void) => void;
  /** Reports the current composer text to parent surfaces (e.g. footer actions). */
  onComposerTextChange?: (text: string) => void;
  /** Allow opening DocShare controls from embedded FileBrowser overlays (false for shared-in callers). */
  canManageFileShares?: boolean;
}

const MAX_UPLOAD_SIZE_MB = Math.round(FILE_TRANSFER_LIMITS.MAX_FILE_SIZE / (1024 * 1024));
export const OPENSPEC_LIST_REQUEST_TIMEOUT_MS = 12_000;
const OPENSPEC_NON_CHANGE_DIR_NAMES = new Set(['archive']);
// Agent types never offered as execution-clone templates (no cloneable runtime).
// Mirrors `EXCLUDED_TYPES` in P2pConfigPanel's execution-template scan.
const OPENSPEC_EXEC_EXCLUDED_TYPES = new Set(['shell', 'script']);

/** OpenSpec Execute candidate label: session short name + SDK (agent type) +
 *  preset name, so identical-looking workers (w2…wN) are distinguishable. */
function formatExecLabel(shortName: string, sdk?: string | null, preset?: string | null, model?: string | null): string {
  return buildExecutionTemplateLabel({
    shortName,
    agentType: sdk,
    ccPreset: preset,
    modelDisplay: model,
  });
}

type OpenSpecTaskStatsSummary = {
  total: number;
  checked: number;
  unchecked: number;
};

function ComposerDeliveryModeIcon({ append }: { append: boolean }) {
  return append ? (
    <svg class="composer-delivery-mode-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.5 5.25h7.25M3.5 9.75h5.25" />
      <path d="M8.5 9.75h3.25a3.75 3.75 0 0 1 3.75 3.75v.75" />
      <path d="m12.75 14.1 1.65 1.65 2.85-3.25" />
    </svg>
  ) : (
    <svg class="composer-delivery-mode-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.25 5.25h7.5M3.25 9.5h6" />
      <circle cx="13.5" cy="13" r="3.5" />
      <path d="M13.5 11v2.25l1.5.9" />
    </svg>
  );
}

type OpenSpecChangeListItem = {
  name: string;
  taskStats?: OpenSpecTaskStatsSummary;
};

type OpenSpecChangeListCacheEntry = {
  changes: OpenSpecChangeListItem[];
};

function buildOpenSpecChangeListCacheKey(serverId: string | undefined, changesPath: string): string {
  return `${serverId ?? 'local'}:${changesPath.replace(/[\\/]+$/, '')}`;
}

function normalizeOpenSpecTaskStats(value: unknown): OpenSpecTaskStatsSummary | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { total?: unknown; checked?: unknown; unchecked?: unknown };
  const total = typeof record.total === 'number' && Number.isFinite(record.total) ? Math.max(0, Math.trunc(record.total)) : null;
  const checked = typeof record.checked === 'number' && Number.isFinite(record.checked) ? Math.max(0, Math.trunc(record.checked)) : null;
  const unchecked = typeof record.unchecked === 'number' && Number.isFinite(record.unchecked) ? Math.max(0, Math.trunc(record.unchecked)) : null;
  if (total === null || checked === null || unchecked === null) return undefined;
  const safeChecked = Math.min(checked, total);
  return {
    total,
    checked: safeChecked,
    unchecked: Math.min(unchecked, total - safeChecked),
  };
}

function collectOpenSpecTaskStats(entries: ReadonlyArray<{ isDir?: unknown; name?: unknown; openSpecTaskStats?: unknown }> | undefined): Map<string, OpenSpecTaskStatsSummary> {
  const stats = new Map<string, OpenSpecTaskStatsSummary>();
  for (const entry of entries ?? []) {
    if (entry.isDir !== true || typeof entry.name !== 'string') continue;
    const normalized = normalizeOpenSpecTaskStats(entry.openSpecTaskStats);
    if (normalized) stats.set(entry.name, normalized);
  }
  return stats;
}

function openSpecTaskStatsCacheKey(changesPath: string, changeName: string): string {
  return `${changesPath.replace(/[\\/]+$/, '')}/${changeName}`;
}

function mergeOpenSpecTaskStats(
  changes: OpenSpecChangeListItem[],
  stats: Map<string, OpenSpecTaskStatsSummary> | null,
): OpenSpecChangeListItem[] {
  if (!stats || stats.size === 0) return changes;
  return changes.map((change) => {
    const taskStats = stats.get(change.name);
    return taskStats ? { ...change, taskStats } : change;
  });
}

const TRANSPORT_QUEUE_HIDDEN_KEY_PREFIX = 'imcodes:transport-queue-hidden:';
type LocalQueuedTransportEntry = QueueDeliveryPolicy & {
  clientMessageId: string;
  text: string;
  status?: 'sending' | 'queued' | 'failed';
  sharedActor?: SharedActorEnvelope;
  /** Queue version visible when this local optimistic entry was created. */
  queuedAfterVersion?: number;
  /** Creation time used to break same-version realtime empty snapshot races. */
  queuedAtMs?: number;
};

type RealtimeTransportQueueOverride = {
  sessionName: string;
  pendingEntries: LocalQueuedTransportEntry[];
  failedEntries: LocalQueuedTransportEntry[];
  version?: number;
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

function isModalKeyboardOwnerOpen(): boolean {
  if (typeof document === 'undefined') return false;
  // A lightbox owns Escape: it must close without changing the running
  // session. True modals and the HTML fullscreen preview have the same
  // exclusive keyboard ownership.
  return !!document.querySelector('[role="dialog"][aria-modal="true"], .fb-lightbox, .html-fullscreen-preview');
}

function isTextEntryKeyboardOwner(node: EventTarget | Node | null | undefined): boolean {
  if (!(node instanceof HTMLElement)) return false;
  const tag = node.tagName;
  return tag === 'INPUT'
    || tag === 'TEXTAREA'
    || tag === 'SELECT'
    || node.isContentEditable
    || node.getAttribute('contenteditable') === 'true'
    || node.classList.contains('xterm-helper-textarea');
}

type MenuAction = 'restart' | 'new' | 'stop';
type ModelChoice = string;

const IME_ESCAPE_CANCEL_GRACE_MS = 800;
/**
 * How long a voice-notepad send waits for the composer's attachment list to
 * catch up (its uploaded transcript present, a stale one gone) before
 * reporting the send as failed. Uploads and removals have already finished by
 * then; this only bounds a render.
 */
const NOTEPAD_ATTACHMENT_SEND_TIMEOUT_MS = 10_000;

interface PendingNotepadAttachmentSend {
  /** True once the composer's attachments are what this message needs. */
  ready: (attachments: readonly ComposerAttachmentRecord[]) => boolean;
  text: string;
  onAccepted: () => void;
  resolve: (outcome: VoiceNotepadSendOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

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
type ComposerAttachmentRecord = ComposerAttachment & { id?: string; serverId?: string };

/**
 * Renumber attachments so `seq` is `1..N` in array order. Used after
 * removing a middle attachment so the remaining ones renumber to stay
 * consecutive (otherwise `#1`, `#3`, `#5` gaps would confuse users).
 */
function renumberAttachments(list: ComposerAttachmentRecord[]): ComposerAttachmentRecord[] {
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

function appendComposerNewline(parts: string[]): void {
  if (parts.length === 0 || parts[parts.length - 1] !== '\n') parts.push('\n');
}

export function readComposerElementText(
  root: HTMLElement,
  options?: { preserveEditingLines?: boolean },
): string {
  const preserveEditingLines = Boolean(options?.preserveEditingLines);
  const parts: string[] = [];
  let pendingBlockBreak = false;
  let hasContentBeforeBlock = false;
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? '';
      if (!preserveEditingLines) {
        parts.push(value);
        return;
      }
      if (pendingBlockBreak && value.length > 0) {
        parts.push('\n');
        pendingBlockBreak = false;
        hasContentBeforeBlock = false;
      }
      if (value.length > 0) hasContentBeforeBlock = true;
      parts.push(value);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    if (element.dataset?.inlineVoiceRobot === 'true') return;
    const tag = element.tagName;
    const isBlock = isComposerBlockTag(tag);
    if (tag === 'BR') {
      if (!preserveEditingLines) {
        appendComposerNewline(parts);
        return;
      }
      if (pendingBlockBreak) {
        parts.push('\n');
        pendingBlockBreak = false;
      }
      if (hasFollowingVisibleContentInBlock(element, root)) {
        parts.push('\n');
        hasContentBeforeBlock = false;
      } else {
        hasContentBeforeBlock = true;
      }
      return;
    }
    if (!preserveEditingLines) {
      if (isBlock && parts.length > 0) appendComposerNewline(parts);
      element.childNodes.forEach(walk);
      if (isBlock) appendComposerNewline(parts);
      return;
    }
    if (isBlock && (pendingBlockBreak || hasContentBeforeBlock)) {
      parts.push('\n');
      pendingBlockBreak = false;
      hasContentBeforeBlock = false;
    }
    element.childNodes.forEach(walk);
    if (isBlock) {
      pendingBlockBreak = true;
      hasContentBeforeBlock = false;
    }
  };
  root.childNodes.forEach(walk);
  const raw = parts.join('');
  return preserveEditingLines ? raw : raw.replace(/\n+$/g, '');
}

function setComposerElementText(root: HTMLElement, text: string): void {
  root.textContent = text.replace(/\r\n?/g, '\n');
}

function measureComposerOffsetAtPoint(root: HTMLElement, targetNode: Node, targetOffset: number): number {
  let length = 0;
  let pendingBlockBreak = false;
  let hasContentBeforeBlock = false;
  let stopped = false;

  const walk = (node: Node): void => {
    if (stopped) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const full = node.textContent ?? '';
      const slice = node === targetNode ? full.slice(0, targetOffset) : full;
      if (pendingBlockBreak && slice.length > 0) {
        length += 1;
        pendingBlockBreak = false;
        hasContentBeforeBlock = false;
      }
      if (slice.length > 0) hasContentBeforeBlock = true;
      length += slice.length;
      if (node === targetNode) {
        stopped = true;
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    if (element.dataset?.inlineVoiceRobot === 'true') return;
    const tag = element.tagName;
    const isBlock = isComposerBlockTag(tag);
    if (tag === 'BR') {
      if (pendingBlockBreak) {
        length += 1;
        pendingBlockBreak = false;
      }
      if (hasFollowingVisibleContentInBlock(element, root)) {
        length += 1;
        hasContentBeforeBlock = false;
      } else {
        hasContentBeforeBlock = true;
      }
      if (node === targetNode) stopped = true;
      return;
    }
    if (isBlock && (pendingBlockBreak || hasContentBeforeBlock)) {
      length += 1;
      pendingBlockBreak = false;
      hasContentBeforeBlock = false;
    }
    const maxChildren = node === targetNode ? Math.min(targetOffset, element.childNodes.length) : element.childNodes.length;
    for (let i = 0; i < maxChildren; i++) {
      walk(element.childNodes[i]);
      if (stopped) return;
    }
    if (node === targetNode) {
      stopped = true;
      return;
    }
    if (isBlock) {
      pendingBlockBreak = true;
      hasContentBeforeBlock = false;
    }
  };

  if (root === targetNode) {
    const maxChildren = Math.min(targetOffset, root.childNodes.length);
    for (let i = 0; i < maxChildren; i++) {
      walk(root.childNodes[i]);
      if (stopped) break;
    }
    return length;
  }

  for (let i = 0; i < root.childNodes.length; i++) {
    walk(root.childNodes[i]);
    if (stopped) break;
  }
  return length;
}

function getComposerSelectionOffsets(root: HTMLElement): { start: number; end: number } | null {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  try {
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
      return null;
    }
    const start = measureComposerOffsetAtPoint(root, range.startContainer, range.startOffset);
    const end = range.collapsed
      ? start
      : measureComposerOffsetAtPoint(root, range.endContainer, range.endOffset);
    return start <= end ? { start, end } : { start: end, end: start };
  } catch {
    return null;
  }
}

function setComposerCaretOffset(root: HTMLElement, offset: number): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  try {
    const sel = window.getSelection();
    if (!sel || typeof document.createRange !== 'function') return;
    let remaining = Math.max(0, offset);
    const range = document.createRange();
    let placed = false;

    const walk = (node: Node): void => {
      if (placed) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const len = node.textContent?.length ?? 0;
        if (remaining <= len) {
          range.setStart(node, remaining);
          range.collapse(true);
          placed = true;
          return;
        }
        remaining -= len;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node as HTMLElement;
      if (element.dataset?.inlineVoiceRobot === 'true') return;
      if (element.tagName === 'BR') {
        if (remaining <= 0) {
          range.setStartBefore(element);
          range.collapse(true);
          placed = true;
          return;
        }
        remaining = Math.max(0, remaining - 1);
        return;
      }
      for (let i = 0; i < element.childNodes.length; i++) {
        walk(element.childNodes[i]);
        if (placed) return;
      }
    };

    for (let i = 0; i < root.childNodes.length; i++) {
      walk(root.childNodes[i]);
      if (placed) break;
    }
    if (!placed) {
      range.selectNodeContents(root);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    /* ignore selection errors in environments lacking full Range support */
  }
}

function createInlineVoiceRobotHost(): HTMLSpanElement {
  const host = document.createElement('span');
  host.className = 'controls-inline-voice-robot-host';
  host.setAttribute('contenteditable', 'false');
  host.dataset.inlineVoiceRobot = 'true';
  host.setAttribute('aria-hidden', 'true');
  return host;
}

function detachInlineVoiceRobotHost(host: HTMLSpanElement | null): void {
  if (!host) return;
  const parent = host.parentNode;
  if (!parent) return;
  host.remove();
  if (typeof (parent as Element).normalize === 'function') {
    (parent as Element).normalize();
  }
}

function writeInlineVoiceSegmentDom(
  root: HTMLElement,
  before: string,
  after: string,
  robotHost: HTMLSpanElement | null,
  restoreCaret: boolean,
): void {
  while (root.firstChild) {
    root.removeChild(root.firstChild);
  }
  const cleanBefore = before.replace(/\r\n?/g, '\n');
  const cleanAfter = after.replace(/\r\n?/g, '\n');
  let beforeNode: Text | null = null;
  if (cleanBefore.length > 0) {
    beforeNode = document.createTextNode(cleanBefore);
    root.appendChild(beforeNode);
  }
  if (robotHost) {
    root.appendChild(robotHost);
  }
  if (cleanAfter.length > 0) {
    root.appendChild(document.createTextNode(cleanAfter));
  }
  if (restoreCaret && typeof window !== 'undefined' && typeof document !== 'undefined') {
    try {
      const sel = window.getSelection();
      if (sel && typeof document.createRange === 'function') {
        const range = document.createRange();
        if (beforeNode) {
          range.setStart(beforeNode, beforeNode.data.length);
        } else {
          range.setStart(root, 0);
        }
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch {
      /* ignore */
    }
  }
}

const COMPOSER_LINE_RECT_TOLERANCE_PX = 3;

function isCaretLineRect(rect: DOMRect | undefined): rect is DOMRect {
  return Boolean(rect && rect.height > 0.5);
}

function getRangeClientRects(range: Range): DOMRect[] {
  if (typeof range.getClientRects !== 'function') return [];
  return Array.from(range.getClientRects()).filter(isCaretLineRect);
}

function resolveComposerCaretRect(
  range: Range,
  upProbe: Range,
  downProbe: Range,
): DOMRect | null {
  const caretRects = getRangeClientRects(range);
  if (caretRects.length > 0) return caretRects[0];
  const downRects = getRangeClientRects(downProbe);
  if (downRects.length > 0) return downRects[0];
  const upRects = getRangeClientRects(upProbe);
  if (upRects.length > 0) return upRects[upRects.length - 1];
  return null;
}

function isComposerBlockTag(tagName: string): boolean {
  return tagName === 'DIV' || tagName === 'P' || tagName === 'LI';
}

function hasVisibleComposerNodeContent(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').length > 0;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as HTMLElement;
  if (element.tagName === 'BR') return true;
  for (let i = 0; i < element.childNodes.length; i += 1) {
    if (hasVisibleComposerNodeContent(element.childNodes[i])) return true;
  }
  return false;
}

function hasFollowingVisibleContentInBlock(node: Node, root: HTMLElement): boolean {
  // Climb past transparent inline wrappers (span/b/i/etc.) while stopping at
  // the enclosing block boundary or composer root so a trailing sentinel <br>
  // inside a block does not double-count with the block's own line break.
  let current: Node | null = node;
  while (current && current !== root) {
    let sibling: Node | null = current.nextSibling;
    while (sibling) {
      if (hasVisibleComposerNodeContent(sibling)) return true;
      sibling = sibling.nextSibling;
    }
    const parent: Node | null = current.parentNode;
    if (!parent || parent === root) break;
    if (parent.nodeType === Node.ELEMENT_NODE && isComposerBlockTag((parent as HTMLElement).tagName)) {
      break;
    }
    current = parent;
  }
  return false;
}

function hasStructuralLineBreakRelativeToCaret(
  root: HTMLElement,
  range: Range,
  direction: 'up' | 'down',
): boolean {
  // Linearize structural line indices alongside the caret in document order so
  // `\n`, `<br>`, and block elements (`div`/`p`/`li`) are all detected even
  // when layout rects are absent (e.g. jsdom), without letting a trailing
  // sentinel `<br>` trap `ArrowDown`.
  let line = 0;
  let caretLine: number | null = null;
  let pendingBlockBreak = false;
  let hasContentBeforeBlock = false;

  const maybePlaceCaretAtBoundary = (container: Node, offset: number) => {
    if (caretLine === null && range.startContainer === container && range.startOffset === offset) {
      caretLine = line;
    }
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? '';
      if (pendingBlockBreak && value.length > 0) {
        line += 1;
        pendingBlockBreak = false;
        hasContentBeforeBlock = false;
      }
      if (value.length > 0) hasContentBeforeBlock = true;
      if (range.startContainer === node) {
        const clampedOffset = Math.max(0, Math.min(range.startOffset, value.length));
        for (let i = 0; i < clampedOffset; i += 1) {
          if (value[i] === '\n') line += 1;
        }
        caretLine = line;
        for (let i = clampedOffset; i < value.length; i += 1) {
          if (value[i] === '\n') line += 1;
        }
      } else {
        for (let i = 0; i < value.length; i += 1) {
          if (value[i] === '\n') line += 1;
        }
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    if (element.dataset?.inlineVoiceRobot === 'true') return;
    const tag = element.tagName;
    if (tag === 'BR') {
      if (pendingBlockBreak) {
        line += 1;
        pendingBlockBreak = false;
      }
      if (hasFollowingVisibleContentInBlock(element, root)) {
        line += 1;
        hasContentBeforeBlock = false;
      } else {
        hasContentBeforeBlock = true;
      }
      return;
    }

    const isBlock = element !== root && isComposerBlockTag(tag);
    if (isBlock && (pendingBlockBreak || hasContentBeforeBlock)) {
      line += 1;
      pendingBlockBreak = false;
      hasContentBeforeBlock = false;
    }

    const children = element.childNodes;
    for (let i = 0; i < children.length; i += 1) {
      maybePlaceCaretAtBoundary(element, i);
      walk(children[i]);
    }
    maybePlaceCaretAtBoundary(element, children.length);

    if (isBlock) {
      pendingBlockBreak = true;
      hasContentBeforeBlock = false;
    }
  };

  walk(root);
  if (caretLine === null) return false;
  return direction === 'up' ? caretLine > 0 : caretLine < line;
}

/**
 * Determine whether the collapsed selection caret in a `contenteditable` composer
 * currently sits on the first (`'up'`) or last (`'down'`) visual line.
 * Uses Range client rects when layout geometry exists (covering soft line wraps
 * as well as explicit breaks) and falls back to DOM structural line tracking.
 */
export function isCaretAtComposerLineBoundary(
  root: HTMLElement | null,
  direction: 'up' | 'down',
): boolean {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  if (!root || !sel || sel.rangeCount === 0) return true;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return true;
  if (!sel.isCollapsed) return false;

  const upProbe = range.cloneRange();
  upProbe.selectNodeContents(root);
  upProbe.setEnd(range.startContainer, range.startOffset);

  const downProbe = range.cloneRange();
  downProbe.selectNodeContents(root);
  downProbe.setStart(range.endContainer, range.endOffset);

  const caretRect = resolveComposerCaretRect(range, upProbe, downProbe);
  if (caretRect) {
    const probeRects = getRangeClientRects(direction === 'up' ? upProbe : downProbe);
    if (probeRects.length === 0) return true;
    const hasOtherLine = probeRects.some((rect) => (
      direction === 'up'
        ? rect.top < caretRect.top - COMPOSER_LINE_RECT_TOLERANCE_PX
          && rect.bottom <= caretRect.top + COMPOSER_LINE_RECT_TOLERANCE_PX
        : rect.bottom > caretRect.bottom + COMPOSER_LINE_RECT_TOLERANCE_PX
          && rect.top >= caretRect.bottom - COMPOSER_LINE_RECT_TOLERANCE_PX
    ));
    return !hasOtherLine;
  }

  return !hasStructuralLineBreakRelativeToCaret(root, range, direction);
}

/**
 * Inline `;` alias-autocomplete trigger. Matches a single `;` that sits at a
 * word boundary (start of text or after whitespace) and is followed by ZERO or
 * more valid alias-name characters, capturing the typed query at the end of the
 * composer text. Zero chars means a bare `;` (at a word boundary) opens the
 * picker with the full alias list; each further char filters it. The char class
 * mirrors `ALIAS_NAME_PATTERN` (`\p{L}\p{N}._-`). A double `;;` (a marker
 * prefix) is excluded so re-editing an inserted `;;(name)` marker does not
 * re-open the picker. Returns the query (possibly empty) or `null` if not triggered.
 */
const ALIAS_INLINE_TRIGGER_RE = /(?:^|\s);([\p{L}\p{N}._-]{0,20})$/u;
export function matchInlineAliasTrigger(text: string): string | null {
  const m = ALIAS_INLINE_TRIGGER_RE.exec(text);
  if (!m) return null;
  // Reject when the char just before the matched `;` is itself a `;` (i.e. the
  // user is inside a `;;(...)` marker prefix). The lead boundary already blocks
  // most cases, but `a;;x` would otherwise match on the second `;`.
  const semiIdx = text.length - 1 - m[1].length;
  if (semiIdx > 0 && text[semiIdx - 1] === ';') return null;
  return m[1];
}

/** Inline `$` skill autocomplete. Numeric-only queries stay ordinary amounts. */
export function matchInlineSkillTrigger(text: string): string | null {
  const m = /(?:^|\s)\$([a-z0-9._-]*)$/iu.exec(text);
  if (!m) return null;
  const query = m[1] ?? '';
  // A lone dollar is ordinary prose/currency; autocomplete starts once the
  // user has typed at least one skill-name character.
  if (!query) return null;
  if (query && /^\d[\d._-]*$/u.test(query)) return null;
  const dollarIdx = text.length - query.length - 1;
  if (dollarIdx > 0 && text[dollarIdx - 1] === '$') return null;
  return query;
}

// Inline `;` alias dropdown styles — mirror the AtPicker dropdown look so the
// two inline autocompletes feel identical.
const aliasPickerContainerStyle: Record<string, string | number> = {
  position: 'absolute',
  bottom: '100%',
  left: 0,
  right: 0,
  maxHeight: 280,
  overflowY: 'auto',
  background: '#1e293b',
  border: '1px solid #334155',
  borderRadius: 8,
  boxShadow: '0 -4px 12px rgba(0,0,0,0.4)',
  zIndex: 50,
  padding: '4px 0',
};
const aliasPickerGroupLabelStyle: Record<string, string | number> = {
  padding: '4px 10px 2px',
  fontSize: 10,
  fontWeight: 600,
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};
const aliasPickerItemStyle: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 10px',
  cursor: 'pointer',
  fontSize: 13,
  color: '#e2e8f0',
  whiteSpace: 'nowrap',
};
const aliasPickerItemHighlightStyle: Record<string, string | number> = {
  ...aliasPickerItemStyle,
  background: '#334155',
};
const aliasPickerDimStyle: Record<string, string | number> = {
  color: '#64748b',
  fontSize: 11,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  marginLeft: 4,
};
const aliasPickerEmptyStyle: Record<string, string | number> = {
  ...aliasPickerItemStyle,
  color: '#64748b',
  justifyContent: 'center',
  cursor: 'default',
};

function parseStoredComposerAttachments(raw: string | null): ComposerAttachmentRecord[] {
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
    const list: ComposerAttachmentRecord[] = parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const path = typeof (entry as { path?: unknown }).path === 'string'
        ? (entry as { path: string }).path.trim()
        : '';
      const name = typeof (entry as { name?: unknown }).name === 'string'
        ? (entry as { name: string }).name.trim()
        : '';
      if (!path || !name) return [];
      const id = typeof (entry as { id?: unknown }).id === 'string'
        ? (entry as { id: string }).id.trim()
        : undefined;
      const storedServerId = typeof (entry as { serverId?: unknown }).serverId === 'string'
        ? (entry as { serverId: string }).serverId.trim()
        : undefined;
      return [{ path, name, seq: 0, ...(id ? { id } : {}), ...(storedServerId ? { serverId: storedServerId } : {}) }];
    });
    return renumberAttachments(list);
  } catch {
    return [];
  }
}

// Keep the persisted-draft append primitive for single-completion callers and
// compatibility with older composer integrations.  Batched uploads call it
// first, then immediately rewrite the draft in selection order below.
// Best-effort: the transfer has already committed on the daemon, so a storage
// quota/security error must never turn a finished upload into "failed" (the
// guarded helpers keep an in-memory copy when storage refuses).
function appendStoredComposerAttachment(storageKey: string, attachment: ComposerAttachmentRecord): ComposerAttachmentRecord[] {
  const current = parseStoredComposerAttachments(safeSessionStorageGetItem(storageKey));
  const next = renumberAttachments([...current, attachment]);
  safeSessionStorageSetItem(storageKey, JSON.stringify(next), Number.MAX_SAFE_INTEGER);
  return next;
}

type ComposerUploadSnapshot = {
  uploads: ComposerUploadItem[];
  error: string | null;
};

type ComposerUploadItem = {
  id: string;
  name: string;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  transport: FileUploadTransportMode;
  totalBytes: number;
  startedAt: number;
  lastSampleAt: number;
  lastSampleBytes: number;
  speedBps: number;
  updatedAt: number;
  /** The daemon path is recorded before the transient row can become done. */
  attachmentPath?: string;
  /** False when failure is permanent (e.g. expired content:// URI needing reselect). */
  retryable?: boolean;
  /** Tracks the wake epoch (connect + online + background) of the last auto-retry. */
  lastAutoRetryEpoch?: string;
  /** Number of automatic wake/reconnect retries attempted for this item. */
  autoRetryCount?: number;
  /** True when hydrated/queued while disconnected or suspended, waiting to start transport on reconnect/resume. */
  waitingForConnection?: boolean;
};

type ComposerUploadEntry = {
  snapshot: ComposerUploadSnapshot;
  listeners: Set<(snapshot: ComposerUploadSnapshot) => void>;
};

const DEFAULT_COMPOSER_UPLOAD_STATE: ComposerUploadSnapshot = {
  uploads: [],
  error: null,
};
const MAX_COMPOSER_AUTO_RETRIES = 10;
const composerUploadStore = new Map<string, ComposerUploadEntry>();
const composerUploadAbortControllers = new Map<string, AbortController>();
// Keep the user-selected File alive for an explicit retry.  The transport's
// persisted clientUploadId then resumes the receiver's confirmed prefix rather
// than forcing the user to pick and resend the whole file after a transient
// direct+HTTP failure.
const composerUploadRetryFiles = new Map<string, File>();
const composerUploadClientIds = new Map<string, string>();
const recoveredPendingUploadIds = new Set<string>();
let composerUploadIdCounter = 0;
let composerUploadConnectEpoch = 0;
let composerUploadOnlineEpoch = 0;

function getComposerUploadWakeEpoch(): string {
  return `${composerUploadConnectEpoch}:${composerUploadOnlineEpoch}:${getUploadBackgroundEpoch()}`;
}

export function resetPendingUploadRecoveryForTests(): void {
  recoveredPendingUploadIds.clear();
  composerUploadClientIds.clear();
  composerUploadRetryFiles.clear();
  composerUploadAbortControllers.clear();
  composerUploadStore.clear();
  composerUploadConnectEpoch = 0;
  composerUploadOnlineEpoch = 0;
}

function createComposerUploadId(): string {
  composerUploadIdCounter += 1;
  return `upload-${composerUploadIdCounter}`;
}

function getComposerUploadEntry(key: string): ComposerUploadEntry {
  let entry = composerUploadStore.get(key);
  if (!entry) {
    entry = { snapshot: { ...DEFAULT_COMPOSER_UPLOAD_STATE }, listeners: new Set() };
    composerUploadStore.set(key, entry);
  }
  return entry;
}

function getComposerUploadSnapshot(key: string): ComposerUploadSnapshot {
  const snapshot = getComposerUploadEntry(key).snapshot;
  return { ...snapshot, uploads: snapshot.uploads.map((item) => ({ ...item })) };
}

function updateComposerUploadSnapshot(key: string, patch: Partial<ComposerUploadSnapshot>): void {
  const entry = getComposerUploadEntry(key);
  entry.snapshot = {
    ...entry.snapshot,
    ...patch,
    uploads: patch.uploads ? patch.uploads.map((item) => ({ ...item })) : entry.snapshot.uploads,
  };
  const next = getComposerUploadSnapshot(key);
  for (const listener of entry.listeners) listener(next);
}

function addComposerUploadItems(key: string, items: ComposerUploadItem[]): void {
  const entry = getComposerUploadEntry(key);
  updateComposerUploadSnapshot(key, {
    error: null,
    uploads: [...entry.snapshot.uploads, ...items],
  });
}

function updateComposerUploadItem(key: string, id: string, patch: Partial<ComposerUploadItem>): void {
  const entry = getComposerUploadEntry(key);
  updateComposerUploadSnapshot(key, {
    uploads: entry.snapshot.uploads.map((item) => (
      item.id === id ? { ...item, ...patch } : item
    )),
  });
}

function updateComposerUploadProgress(key: string, id: string, rawProgress: number, now = Date.now()): void {
  const entry = getComposerUploadEntry(key);
  const existing = entry.snapshot.uploads.find((item) => item.id === id);
  if (!existing) return;
  const clamped = Math.max(0, Math.min(100, Math.round(rawProgress)));
  const progress = Math.max(existing.progress, clamped);
  const transferredBytes = Math.round((existing.totalBytes * progress) / 100);
  const sampleElapsedMs = now - existing.lastSampleAt;
  let speedBps = existing.speedBps;
  let lastSampleAt = existing.lastSampleAt;
  let lastSampleBytes = existing.lastSampleBytes;
  if (transferredBytes > existing.lastSampleBytes && sampleElapsedMs >= 250) {
    const instantSpeed = ((transferredBytes - existing.lastSampleBytes) * 1000) / sampleElapsedMs;
    speedBps = existing.speedBps > 0
      ? (existing.speedBps * 0.7) + (instantSpeed * 0.3)
      : instantSpeed;
    lastSampleAt = now;
    lastSampleBytes = transferredBytes;
  }
  if (progress === existing.progress && speedBps === existing.speedBps) {
    return;
  }
  updateComposerUploadSnapshot(key, {
    uploads: entry.snapshot.uploads.map((item) => (
      item.id === id
        ? {
            ...item,
            progress,
            speedBps,
            lastSampleAt,
            lastSampleBytes,
            updatedAt: now,
          }
        : item
    )),
  });
}

export const __composerUploadProgressForTests = {
  addItems: addComposerUploadItems,
  updateProgress: updateComposerUploadProgress,
  getSnapshot: getComposerUploadSnapshot,
  subscribe: (key: string, listener: (snapshot: ComposerUploadSnapshot) => void) => {
    const entry = getComposerUploadEntry(key);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  },
};

function updateComposerUploadTransport(
  key: string,
  id: string,
  transport: FileUploadTransportMode,
  now = Date.now(),
): void {
  const entry = getComposerUploadEntry(key);
  updateComposerUploadSnapshot(key, {
    uploads: entry.snapshot.uploads.map((item) => {
      if (item.id !== id || item.transport === transport) return item;
      const enteringDirect = transport === FILE_UPLOAD_TRANSPORT_MODE.DIRECT;
      const restartingForRelay = transport === FILE_UPLOAD_TRANSPORT_MODE.FALLING_BACK
        || (transport === FILE_UPLOAD_TRANSPORT_MODE.RELAY
          && item.transport !== FILE_UPLOAD_TRANSPORT_MODE.FALLING_BACK);
      const resetPhase = enteringDirect || restartingForRelay;
      return {
        ...item,
        transport,
        ...(restartingForRelay ? { progress: 0 } : {}),
        ...(resetPhase ? {
          lastSampleAt: now,
          lastSampleBytes: 0,
          speedBps: 0,
        } : {}),
        updatedAt: now,
      };
    }),
  });
}

function removeComposerUploadItems(key: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  const entry = getComposerUploadEntry(key);
  updateComposerUploadSnapshot(key, {
    uploads: entry.snapshot.uploads.filter((item) => !idSet.has(item.id)),
  });
}

function subscribeComposerUploadSnapshot(key: string, listener: (snapshot: ComposerUploadSnapshot) => void): () => void {
  const entry = getComposerUploadEntry(key);
  entry.listeners.add(listener);
  listener(getComposerUploadSnapshot(key));
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0 && entry.snapshot.uploads.length === 0 && !entry.snapshot.error) {
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
const MUSE_SDK_MODEL_SUGGESTIONS = ['muse-spark-1.3', 'muse-spark', 'muse-wonder', 'muse-fast'] as const;
const AGY_SDK_MODEL_SUGGESTIONS = [...AGY_MODEL_IDS] as const;
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

interface PendingDelegateTarget {
  session: string;
  label: string;
}

interface PendingSendPayload {
  text: string;
  extra: Record<string, unknown>;
  delegation?: {
    targetSession: string;
    targetLabel: string;
    task: string;
  };
}

interface BuildSendPayloadOptions {
  textOverride?: string;
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
  retainOnRejection: boolean;
  onConfirmedAccepted?: () => void;
  onConfirmedRejected?: () => void;
  onCanceled?: () => void;
}

type ManualP2pTargetCandidate = {
  session: string;
  aliases: string[];
};

type ManualP2pResolveResult = {
  orderedTargets: Array<{ session: string; mode: string }>;
  cleanText: string;
};

type P2pConfigTab = 'participants' | 'combos' | 'advanced' | 'execution';

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
  provider?: string;
  providerGeneration?: number;
  providerToolUseId?: string;
  inputPreview?: string;
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

interface ComposerTargetBubbleProps {
  visibleBase: boolean;
  composerFocusedRef: { current: boolean };
  subscribeFocus: (listener: (focused: boolean) => void) => () => void;
  composerTargetPath: string;
  composerParentName: string;
  composerTargetName: string;
}

const ComposerTargetBubble = memo(function ComposerTargetBubble({
  visibleBase,
  composerFocusedRef,
  subscribeFocus,
  composerTargetPath,
  composerParentName,
  composerTargetName,
}: ComposerTargetBubbleProps) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(() => composerFocusedRef.current);
  useEffect(() => {
    setFocused(composerFocusedRef.current);
    return subscribeFocus(setFocused);
  }, [composerFocusedRef, subscribeFocus]);
  if (!visibleBase || !focused) return null;
  return (
    <div
      class="controls-target-bubble"
      role="status"
      aria-live="polite"
      aria-label={t('session.composer_target_aria', { name: composerTargetPath })}
    >
      <span class="controls-target-pulse" aria-hidden="true" />
      <span class="controls-target-label">{t('session.composer_target_label')}</span>
      <span class="controls-target-name" title={composerTargetPath}>
        {composerParentName && composerParentName !== composerTargetName && (
          <>
            <span class="controls-target-parent">{composerParentName}</span>
            <span class="controls-target-arrow" aria-hidden="true">→</span>
          </>
        )}
        <span class="controls-target-child">{composerTargetName}</span>
      </span>
    </div>
  );
});

export function SessionControls({ ws, activeSession, connected: connectedProp, inputRef, onAfterAction, onStopProject, onRenameSession, onSettings, onShareSession, sessionPinned = false, stopBlockedByPinned = false, onToggleSessionPin, subSessionId, sessionDisplayName, quickData, detectedModel, hideShortcuts, hideWorkflowControls = false, onSend, onRemoveOptimisticMessage, onSendFailed, onSubRestart, onSubNew, onSubStop, activeThinking = false, activeTransportTurn = false, transportTimelineEvents, timelineSettledQueuedIds: timelineSettledQueuedIdsProp, mobileFileBrowserOpen, onMobileFileBrowserClose, onOpenNodeGroups, sessions, subSessions, serverId, fileDropTargetRef, quotes, onRemoveQuote, taskQuote, onRemoveTaskQuote, pendingPrefillText, onPendingPrefillApplied, pendingSharedUpload, onPendingSharedUploadConsumed, compact, keyboardActive, onQuickOpenChange, onOverlayOpenChange, onTransportConfigSaved, onVersionSensitiveAction, onComposerTextChange, canManageFileShares = true }: Props) {
  const baseOpenNodeGroups = useNodeGroupsNav(onOpenNodeGroups);
  const handleOpenNodeGroupsFromBrowser = useCallback(() => {
    onMobileFileBrowserClose?.();
    setOpenSpecFolderPath(null);
    baseOpenNodeGroups?.();
  }, [onMobileFileBrowserClose, baseOpenNodeGroups]);
  recordPerfRender(activeSession?.name?.startsWith('deck_sub_') ? 'SessionControls:sub' : 'SessionControls:main');
  const { t, i18n } = useTranslation();
  const deliveryModePref = usePref<SessionSendDeliveryMode>(SESSION_SEND_DELIVERY_USER_PREF_KEY, {
    parse: (raw) => Object.values(SESSION_SEND_DELIVERY_MODES).includes(raw as SessionSendDeliveryMode)
      ? raw as SessionSendDeliveryMode
      : null,
  });
  const deliveryMode = deliveryModePref.value ?? DEFAULT_SESSION_SEND_DELIVERY_MODE;
  const directAppendMode = deliveryMode === SESSION_SEND_DELIVERY_MODES.APPEND;
  const swipeBackRef = useSwipeBack(onMobileFileBrowserClose);
  const [hasText, setHasText] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const composerFocusListenersRef = useRef<Set<(focused: boolean) => void>>(new Set());
  const subscribeComposerFocus = useCallback((listener: (focused: boolean) => void) => {
    composerFocusListenersRef.current.add(listener);
    return () => {
      composerFocusListenersRef.current.delete(listener);
    };
  }, []);
  const [macDesktop, setMacDesktop] = useState(() => isNativeMacDesktop());
  const macDesktopRef = useRef(macDesktop);
  macDesktopRef.current = macDesktop;
  const [pcAppInlineVoice, setPcAppInlineVoice] = useState(() => isPcAppInlineVoiceSupported());
  const inlineDesktopVoice = macDesktop || pcAppInlineVoice;
  const inlineDesktopVoiceRef = useRef(inlineDesktopVoice);
  inlineDesktopVoiceRef.current = inlineDesktopVoice;
  useEffect(() => subscribeDeviceLayoutChange(() => {
    setMacDesktop(isNativeMacDesktop());
    setPcAppInlineVoice(isPcAppInlineVoiceSupported());
  }, { includeResize: false }), []);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceOverlayInitialText, setVoiceOverlayInitialText] = useState<string | null>(null);
  const [voiceOverlayAutoStart, setVoiceOverlayAutoStart] = useState(true);
  const [inlineVoiceActive, setInlineVoiceActive] = useState(false);
  const [inlineVoiceRecognizing, setInlineVoiceRecognizing] = useState(false);
  const [voiceModelLoading, setVoiceModelLoading] = useState(false);
  const [inlineVoiceLevel, setInlineVoiceLevel] = useState(0);
  const [inlineVoicePermissionTarget, setInlineVoicePermissionTarget] = useState<'mic' | 'speech' | null>(null);
  const inlineVoiceActiveRef = useRef(false);
  const inlineVoiceTokenRef = useRef(0);
  const inlineVoiceDrainingTokenRef = useRef<number | null>(null);
  const inlineVoiceRecognizingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inlineVoiceRobotHostRef = useRef<HTMLSpanElement | null>(null);
  const programmaticVoiceWriteRef = useRef(false);
  const inlineVoiceSegmentRef = useRef<{
    prefix: string;
    selectedText: string;
    suffix: string;
    partial: string;
    hasCommittedPartial: boolean;
    caretAfterSegment: number;
  }>({
    prefix: '',
    selectedText: '',
    suffix: '',
    partial: '',
    hasCommittedPartial: false,
    caretAfterSegment: 0,
  });
  const interruptInlineVoiceRef = useRef<(() => void) | null>(null);
  const [voiceHoldActive, setVoiceHoldActive] = useState(false);
  const [voiceHoldHudActive, setVoiceHoldHudActive] = useState(false);
  const [voiceHoldZone, setVoiceHoldZone] = useState<'send' | 'cancel' | 'edit'>('send');
  const voiceHoldDragXRef = useRef(0);
  const voiceHoldHudRef = useRef<VoiceHoldHudHandle | null>(null);
  const [voiceHoldDropY, setVoiceHoldDropY] = useState<number | null>(null);
  const [voiceHoldBottomClearance, setVoiceHoldBottomClearance] = useState<number | null>(null);
  const [voiceHoldText, setVoiceHoldText] = useState('');
  const [voiceHoldPhase, setVoiceHoldPhase] = useState<'starting' | 'recording' | 'ended' | 'draining' | 'dropping'>('starting');
  const [voiceHoldRecognizing, setVoiceHoldRecognizing] = useState(false);
  const [voiceHoldLiveAudio, setVoiceHoldLiveAudio] = useState(false);
  const [voiceHoldError, setVoiceHoldError] = useState<string | null>(null);
  const [activeVoiceService, setActiveVoiceService] = useState<ActiveVoiceServiceInfo | null>(() => getActiveVoiceServiceFrom(VoiceInput));
  const [voiceHoldService, setVoiceHoldService] = useState<ActiveVoiceServiceInfo | null>(null);
  const [remoteVoiceFallbackNotice, setRemoteVoiceFallbackNotice] = useState<string | null>(() => {
    if (!Object.prototype.hasOwnProperty.call(RemoteVoiceClient, 'getRemoteVoiceState')) return null;
    const fn = (RemoteVoiceClient as { getRemoteVoiceState?: () => { fallbackNotice?: string | null } }).getRemoteVoiceState;
    return typeof fn === 'function' ? fn()?.fallbackNotice ?? null : null;
  });

  useEffect(() => {
    setActiveVoiceService(getActiveVoiceServiceFrom(VoiceInput));
    return subscribeActiveVoiceServiceFrom(VoiceInput, (info) => {
      setActiveVoiceService(info);
      if (info && (voiceHoldActiveRef.current || voiceHoldTxRef.current !== null)) {
        setVoiceHoldService(info);
      }
    });
  }, []);

  useEffect(() => {
    if (!Object.prototype.hasOwnProperty.call(RemoteVoiceClient, 'getRemoteVoiceState')
      && !Object.prototype.hasOwnProperty.call(RemoteVoiceClient, 'subscribeRemoteVoiceState')) {
      return undefined;
    }
    const readFn = Object.prototype.hasOwnProperty.call(RemoteVoiceClient, 'getRemoteVoiceState')
      ? (RemoteVoiceClient as { getRemoteVoiceState?: () => { fallbackNotice?: string | null } }).getRemoteVoiceState
      : undefined;
    if (typeof readFn === 'function') {
      setRemoteVoiceFallbackNotice(readFn()?.fallbackNotice ?? null);
    }
    const subFn = Object.prototype.hasOwnProperty.call(RemoteVoiceClient, 'subscribeRemoteVoiceState')
      ? (RemoteVoiceClient as {
          subscribeRemoteVoiceState?: (cb: (state: { fallbackNotice?: string | null }) => void) => () => void;
        }).subscribeRemoteVoiceState
      : undefined;
    return typeof subFn === 'function'
      ? subFn((state) => {
          setRemoteVoiceFallbackNotice(state?.fallbackNotice ?? null);
        })
      : undefined;
  }, []);

  const isIosVoiceRuntime = isIosNativePlatform();
  const activeOrHoldVoiceService = voiceHoldService ?? activeVoiceService;
  const inlineVoiceServiceLabel = inlineVoiceActive
    ? formatActiveVoiceServiceLabel(activeVoiceService, t, isIosVoiceRuntime)
    : '';
  const [voiceHudMount, setVoiceHudMount] = useState<{ root: HTMLElement; mode: string } | null>(null);
  useEffect(() => {
    if (!inlineVoiceActive && !voiceModelLoading) {
      setVoiceHudMount(null);
      return;
    }
    if (typeof document === 'undefined' || !document.body) {
      setVoiceHudMount(null);
      return;
    }

    let currentRoot: HTMLElement | null = null;
    let attrObserver: MutationObserver | null = null;

    const readVisibleHud = (): { root: HTMLElement; mode: string } | null => {
      const el = document.getElementById('imcodes-voice-hud-root');
      if (!el) return null;
      const mode = el.getAttribute('data-mode') ?? '';
      if (mode === 'hidden' || el.style.display === 'none') return null;
      return { root: el, mode };
    };

    const syncHudMount = () => {
      const el = document.getElementById('imcodes-voice-hud-root');
      if (el !== currentRoot) {
        attrObserver?.disconnect();
        attrObserver = null;
        currentRoot = el;
        if (currentRoot && typeof MutationObserver !== 'undefined') {
          attrObserver = new MutationObserver(() => {
            syncHudMount();
          });
          attrObserver.observe(currentRoot, {
            attributes: true,
            attributeFilter: ['data-mode', 'style'],
          });
        }
      }
      const next = readVisibleHud();
      setVoiceHudMount((prev) => {
        if (prev?.root === next?.root && prev?.mode === next?.mode) return prev;
        return next;
      });
    };

    syncHudMount();
    const bodyObserver = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => {
          syncHudMount();
        })
      : null;
    bodyObserver?.observe(document.body, { childList: true });

    return () => {
      bodyObserver?.disconnect();
      attrObserver?.disconnect();
      setVoiceHudMount(null);
    };
  }, [inlineVoiceActive, voiceModelLoading]);
  const voiceHoldServiceLabel = voiceHoldHudActive
    ? formatActiveVoiceServiceLabel(activeOrHoldVoiceService, t, isIosVoiceRuntime)
    : '';
  const voiceHoldFallbackReason = voiceHoldHudActive && activeOrHoldVoiceService?.isFallback
    ? formatRemoteVoiceFallbackReason(remoteVoiceFallbackNotice)
    : null;
  const voiceHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceHoldSlideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceHoldStartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceHoldStartTimeoutOwnerRef = useRef<NonNullable<typeof voiceHoldTxRef.current> | null>(null);
  const voiceHoldRecognizingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceHoldDropTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceHoldDropCancelRef = useRef<(() => void) | null>(null);
  const voiceHoldPointerRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    wasFocused: boolean;
    pointerType: string;
    slideIntentDx: number | null;
    downAt: number;
    lastActivityAt: number;
    captureLost: boolean;
  } | null>(null);
  const pendingMobileInitialEndFocusRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    pointerType: string;
  } | null>(null);
  const voiceHoldPendingRef = useRef(false);
  const didPrimeVoiceGestureRef = useRef(false);
  const voiceHoldActiveRef = useRef(false);
  const voiceHoldZoneRef = useRef<'send' | 'cancel' | 'edit'>('send');
  const voiceHoldTokenRef = useRef(0);
  const voiceHoldTxRef = useRef<{
    id: number;
    baseText: string;
    transcript: string;
    zone: 'send' | 'cancel' | 'edit';
    phase: 'starting' | 'recording' | 'ended' | 'draining' | 'dropping' | 'failed' | 'settled';
    error: string | null;
    pointerType: string;
    didStartRecording: boolean;
    settled: boolean;
    startSettled: boolean;
    awaitingNativePermission: boolean;
    pointerEndedDuringPermissionPrompt: 'up' | 'cancel' | null;
    startPromise: Promise<boolean> | null;
    drainPromise: Promise<void> | null;
  } | null>(null);
  const voiceHoldLiveAudioRef = useRef(false);
  const voiceHoldTranscriptRef = useRef<HTMLDivElement | null>(null);
  const inputDisabledRef = useRef(false);
  const voiceHoldReadyRef = useRef(false);
  const composerFocusedRef = useRef(false);
  const voiceWindowCleanupRef = useRef<(() => void) | null>(null);
  const voicePointerMoveHandlerRef = useRef<(event: PointerEvent) => void>(() => {});
  const voicePointerEndHandlerRef = useRef<(event: PointerEvent, cancelled?: boolean) => void>(() => {});
  const handledVoicePointerEventsRef = useRef<WeakSet<Event>>(new WeakSet());
  const touchTapCompatShieldCleanupRef = useRef<(() => void) | null>(null);
  const suppressComposerClickFocusRef = useRef(false);
  const suppressComposerClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNextVoiceButtonClickRef = useRef(false);
  const suppressNextVoiceButtonClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceOpenRef = useRef(voiceOpen);
  voiceOpenRef.current = voiceOpen;
  const [menuOpen, setMenuOpen] = useState(false);
  const [atPickerOpen, setAtPickerOpen] = useState(false);
  const [atQuery, setAtQuery] = useState('');
  const [atPickerStage, setAtPickerStage] = useState<'choose' | 'files' | 'agents' | 'mode' | 'team' | 'aliases' | 'machines' | 'skills'>('choose');
  const atJustClosedRef = useRef(false);
  const atSelectionLockRef = useRef(false);
  const atSelectionSnapshotRef = useRef('');
  // Inline `;` alias autocomplete — mirrors the `@` picker's inline trigger.
  const [aliasPickerOpen, setAliasPickerOpen] = useState(false);
  const [aliasQuery, setAliasQuery] = useState('');
  const [aliasHighlightIdx, setAliasHighlightIdx] = useState(0);
  const aliasJustClosedRef = useRef(false);
  // Set for the input event immediately following a paste so pasted text ending
  // in `;name` never opens the inline alias picker (paste must not trigger).
  const aliasPasteSuppressRef = useRef(false);
  // Inline `^` machine autocomplete — mirrors the inline `;` alias trigger, but
  // for a `^^(name)` machine target marker. Connectivity is informational;
  // offline nodes remain selectable so a request can target their stable ref.
  const [machinePickerOpen, setMachinePickerOpen] = useState(false);
  const [machineQuery, setMachineQuery] = useState('');
  const [machineHighlightIdx, setMachineHighlightIdx] = useState(0);
  const machineJustClosedRef = useRef(false);
  // Set for the input event immediately following a paste so pasted text ending
  // in `^name` never opens the inline machine picker (paste must not trigger).
  const machinePasteSuppressRef = useRef(false);
  const currentTaskPairReferences = () => {
    const snapshot = (window as Window & { __imcodesTaskPairSnapshot?: { serverId?: string } }).__imcodesTaskPairSnapshot;
    return snapshot?.serverId && snapshot.serverId !== serverId ? [] : openTaskPairReferences(snapshot);
  };
  const [taskPairReferences, setTaskPairReferences] = useState<TaskPairReference[]>(currentTaskPairReferences);
  const [taskPairPickerOpen, setTaskPairPickerOpen] = useState(false);
  const [taskPairQuery, setTaskPairQuery] = useState('');
  const [taskPairHighlightIdx, setTaskPairHighlightIdx] = useState(0);
  const taskPairPickerRef = useRef<HTMLDivElement>(null);
  const taskPairJustClosedRef = useRef(false);
  // Quick phrases are user-input affordances. Programmatic composer writes and
  // paste may contain attachment-like `#...` text, so suppress their one
  // corresponding input event without disabling later keyboard edits.
  const quickPhraseInputSuppressRef = useRef(false);
  const [quickSuggestionKind, setQuickSuggestionKind] = useState<'command' | 'phrase' | 'model' | 'skill' | null>(null);
  const [quickSuggestionQuery, setQuickSuggestionQuery] = useState('');
  const [quickSuggestionHighlightIdx, setQuickSuggestionHighlightIdx] = useState(0);
  const [agentSkills, setAgentSkills] = useState<AgentSkillEntry[]>([]);
  const closeQuickSuggestions = useCallback(() => {
    setQuickSuggestionKind(null);
    setQuickSuggestionQuery('');
    setQuickSuggestionHighlightIdx(0);
  }, []);
  useEffect(() => {
    const onSnapshot = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.authoritative === false) return;
      if (detail?.scopeReset || detail?.authorityUnavailable) {
        setTaskPairReferences([]);
        setTaskPairPickerOpen(false);
        setTaskPairQuery('');
        return;
      }
      if (detail?.serverId && detail.serverId !== serverId) return;
      setTaskPairReferences(openTaskPairReferences(detail));
    };
    window.addEventListener('supervision:task-pairs', onSnapshot);
    return () => window.removeEventListener('supervision:task-pairs', onSnapshot);
  }, [serverId]);
  useEffect(() => {
    setTaskPairReferences(currentTaskPairReferences());
    setTaskPairPickerOpen(false);
    setTaskPairQuery('');
  }, [serverId, activeSession?.name]);
  const filteredTaskPairReferences = useMemo(
    () => filterTaskPairReferences(taskPairReferences, taskPairQuery),
    [taskPairReferences, taskPairQuery],
  );
  const {
    activeIndex: activeTaskPairIndex,
    handleNavigationKey: handleTaskPairNavigationKey,
  } = useListboxNavigation({
    activeIndex: taskPairHighlightIdx,
    containerRef: taskPairPickerRef,
    itemCount: filteredTaskPairReferences.length,
    open: taskPairPickerOpen,
    setActiveIndex: setTaskPairHighlightIdx,
  });
  // Inline `&` Cloud Docs search & citation picker.
  const [cloudDocPickerOpen, setCloudDocPickerOpen] = useState(false);
  const [cloudDocQuery, setCloudDocQuery] = useState('');
  const [cloudDocItems, setCloudDocItems] = useState<CloudDocReferenceItem[]>([]);
  const [cloudDocLoading, setCloudDocLoading] = useState(false);
  const [cloudDocError, setCloudDocError] = useState<string | null>(null);
  const [cloudDocHighlightIdx, setCloudDocHighlightIdx] = useState(0);
  const cloudDocPickerRef = useRef<HTMLDivElement>(null);
  const cloudDocJustClosedRef = useRef(false);
  const cloudDocPasteSuppressRef = useRef(false);
  const cloudDocImeCommitAtRef = useRef(0);
  const cloudDocInitialAbortRef = useRef<AbortController | null>(null);
  const cloudDocSearchAbortRef = useRef<AbortController | null>(null);
  const cloudDocCachedUnfilteredRef = useRef<CloudDocReferenceItem[] | null>(null);
  const closeCloudDocPicker = useCallback((withJustClosedGuard = false) => {
    cloudDocInitialAbortRef.current?.abort();
    cloudDocInitialAbortRef.current = null;
    cloudDocSearchAbortRef.current?.abort();
    cloudDocSearchAbortRef.current = null;
    cloudDocCachedUnfilteredRef.current = null;
    cloudDocImeCommitAtRef.current = 0;
    setCloudDocPickerOpen(false);
    setCloudDocQuery('');
    setCloudDocItems((prev) => (prev.length === 0 ? prev : []));
    setCloudDocLoading(false);
    setCloudDocError(null);
    if (withJustClosedGuard) {
      cloudDocJustClosedRef.current = true;
      setTimeout(() => { cloudDocJustClosedRef.current = false; }, 150);
    }
  }, []);
  useEffect(() => {
    closeCloudDocPicker();
  }, [serverId, activeSession?.name, closeCloudDocPicker]);
  useEffect(() => {
    if (!cloudDocPickerOpen || !activeSession) {
      cloudDocInitialAbortRef.current?.abort();
      cloudDocInitialAbortRef.current = null;
      return;
    }
    const controller = new AbortController();
    cloudDocInitialAbortRef.current?.abort();
    cloudDocInitialAbortRef.current = controller;
    setCloudDocLoading(true);
    setCloudDocError(null);
    void listCloudDocsApi({ allFolders: true, signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        const normalized = normalizeCloudDocReferences(res);
        cloudDocCachedUnfilteredRef.current = normalized;
        setCloudDocItems((prev) => (prev.length > 0 ? mergeCloudDocReferences(normalized, prev) : normalized));
        setCloudDocError(null);
        setCloudDocLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setCloudDocError(err instanceof Error ? err.message : 'error');
        setCloudDocLoading(false);
      });
    return () => {
      controller.abort();
      if (cloudDocInitialAbortRef.current === controller) {
        cloudDocInitialAbortRef.current = null;
      }
    };
  }, [cloudDocPickerOpen, serverId, activeSession?.name]);
  useEffect(() => {
    if (!cloudDocPickerOpen || !activeSession) {
      cloudDocSearchAbortRef.current?.abort();
      cloudDocSearchAbortRef.current = null;
      return;
    }
    const trimmed = cloudDocQuery.trim();
    if (!trimmed) {
      cloudDocSearchAbortRef.current?.abort();
      cloudDocSearchAbortRef.current = null;
      if (cloudDocCachedUnfilteredRef.current) {
        setCloudDocItems(cloudDocCachedUnfilteredRef.current);
      }
      return;
    }
    const controller = new AbortController();
    cloudDocSearchAbortRef.current?.abort();
    cloudDocSearchAbortRef.current = controller;
    const timer = setTimeout(() => {
      if (controller.signal.aborted || !mountedRef.current) return;
      setCloudDocLoading(true);
      void listCloudDocsApi({ allFolders: true, search: trimmed, signal: controller.signal })
        .then((res) => {
          if (controller.signal.aborted || !mountedRef.current) return;
          const normalized = normalizeCloudDocReferences(res);
          const base = cloudDocCachedUnfilteredRef.current ?? [];
          setCloudDocItems(mergeCloudDocReferences(base, normalized));
          setCloudDocError(null);
          setCloudDocLoading(false);
        })
        .catch((err) => {
          if (controller.signal.aborted || !mountedRef.current) return;
          if (err instanceof Error && err.name === 'AbortError') return;
          setCloudDocError(err instanceof Error ? err.message : 'error');
          setCloudDocLoading(false);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
      if (cloudDocSearchAbortRef.current === controller) {
        cloudDocSearchAbortRef.current = null;
      }
    };
  }, [cloudDocPickerOpen, cloudDocQuery, serverId, activeSession?.name]);
  const filteredCloudDocs = useMemo(
    () => filterCloudDocReferences(cloudDocItems, cloudDocQuery),
    [cloudDocItems, cloudDocQuery],
  );
  const {
    activeIndex: activeCloudDocIndex,
    handleNavigationKey: handleCloudDocNavigationKey,
  } = useListboxNavigation({
    activeIndex: cloudDocHighlightIdx,
    containerRef: cloudDocPickerRef,
    itemCount: filteredCloudDocs.length,
    open: cloudDocPickerOpen,
    setActiveIndex: setCloudDocHighlightIdx,
  });
  useEffect(() => {
    if (!serverId) { setAgentSkills([]); return; }
    let cancelled = false;
    void listAgentSkills(serverId, activeSession ? { sessionName: activeSession.name, projectDir: activeSession.projectDir } : undefined).then((skills) => {
      if (!cancelled) setAgentSkills(skills);
    }).catch(() => {
      if (!cancelled) setAgentSkills([]);
    });
    return () => { cancelled = true; };
  }, [serverId, activeSession?.name, activeSession?.projectDir]);
  const [modelOpen, setModelOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const [peerAuditOpen, setPeerAuditOpen] = useState(false);
  const [quickDelegationError, setQuickDelegationError] = useState<string | null>(null);
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
  const [openSpecChanges, setOpenSpecChanges] = useState<OpenSpecChangeListItem[]>([]);
  const [openSpecLoading, setOpenSpecLoading] = useState(false);
  const [openSpecError, setOpenSpecError] = useState<string | null>(null);
  const [openSpecAuditMenu, setOpenSpecAuditMenu] = useState<string | null>(null);
  const [openSpecProposeMenuOpen, setOpenSpecProposeMenuOpen] = useState(false);
  // Per-change OpenSpec Execute dropdown: holds the change name whose Execute
  // menu is open (null = none), mirroring the per-change audit menu state.
  const [openSpecExecuteMenu, setOpenSpecExecuteMenu] = useState<string | null>(null);
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
  // Queue mutations are overlaid on top of the latest authoritative snapshot.
  // Keep removals as explicit tombstones: representing a deletion only by
  // omitting the item from `optimisticQueuedEntries` is insufficient when
  // another queued item remains, because the render merge starts from the
  // (temporarily stale) authoritative snapshot and would add the deleted item
  // straight back. This was visible as "delete does nothing" with 2+ queued
  // messages even though the daemon and SQLite deletion had succeeded.
  const [optimisticallyRemovedQueuedIds, setOptimisticallyRemovedQueuedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [realtimeQueueOverride, setRealtimeQueueOverride] = useState<RealtimeTransportQueueOverride | null>(null);
  const reconciledMissingAppendCommandIdsRef = useRef<Set<string>>(new Set());
  /**
   * How many authoritative queue snapshots this session has ACCEPTED.
   *
   * Append rollback restores the pre-click queue, which is the right answer only
   * while the click is still the newest thing that happened. Comparing queue
   * epoch/authority/version at rollback time cannot express that: an accepted
   * reset moves to a NEW epoch with version 0, which is not "newer" by any
   * ordering on versions. A monotonic count of accepted snapshots says exactly
   * what matters -- "authority has answered since you clicked" -- for an empty
   * snapshot, a partial one, a version bump and a reset alike.
   */
  const acceptedQueueSnapshotSeqRef = useRef(0);
  const lastRealtimeEmptyQueueSnapshotRef = useRef<{ sessionName: string; version?: number; observedAtMs: number } | null>(null);
  const failedQueuedCommandIdsRef = useRef<Set<string>>(new Set());
  const queueTranslationRef = useRef(t);
  queueTranslationRef.current = t;
  const pendingStopQueueRef = useRef<{ commandId: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const queuedMutationRollbackRef = useRef<Map<string,
    | { type: 'edit' | 'undo'; entry: LocalQueuedTransportEntry }
    // `acceptedSnapshotSeq` is the accepted-snapshot count as it stood when the
    // click was made. Without it the rollback cannot tell "nothing happened
    // since" from "authority already answered", and a delayed error ack
    // restored a pre-click queue on top of newer truth.
    | {
      type: 'append';
      entries: LocalQueuedTransportEntry[];
      queue: LocalQueuedTransportEntry[];
      acceptedSnapshotSeq: number;
    }
  >>(new Map());
  // Command ids that have reached the timeline (a `user.message` event) and are
  // therefore NO LONGER queued — the timeline is the authoritative truth for
  // "delivered". The displayed queue filters these out so a delivered message
  // can never linger as an undismissable "Queued" zombie even when a stale
  // daemon `session.state` snapshot still lists it as pending (e.g. the resend /
  // auto-deliver "queued" emit that isn't superseded until the turn goes idle).
  // Only DELIVERED ids are added, so in-flight sends (no user.message yet) are
  // never hidden. Per-session: reset on session switch (the timeline replay
  // rebuilds it). Bounded to the most recent ids to cap long-session growth.
  const [settledQueuedIds, setSettledQueuedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [mobileComposerMultiline, setMobileComposerMultiline] = useState(false);
  const [mobileComposerExpanded, setMobileComposerExpanded] = useState(false);
  const mobileComposerExpandedRef = useRef(false);
  const sharedComposerHeight = useSharedComposerHeight();
  const composerResizeCleanupRef = useRef<(() => void) | null>(null);
  const [confirm, setConfirm] = useState<MenuAction | null>(null);
  const [confirmLevel, setConfirmLevel] = useState(0); // 0=none, 1=first warning, 2=second warning (sub-session only)
  const [skipComboSendConfirm, setSkipComboSendConfirm] = useState(false);
  const [pendingComboSendConfirm, setPendingComboSendConfirm] = useState<PendingComboSendConfirmation | null>(null);
  const pendingComboSendConfirmRef = useRef<PendingComboSendConfirmation | null>(null);
  const [rememberComboSendChoice, setRememberComboSendChoice] = useState(false);
  const [pendingTransportApproval, setPendingTransportApproval] = useState<PendingTransportApproval | null>(null);
  const [fileDragActive, setFileDragActive] = useState(false);
  const controlsWrapperRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const aliasPickerRef = useRef<HTMLDivElement>(null);
  const machinePickerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement | null>(null);
  const modelButtonRef = useRef<HTMLButtonElement | null>(null);
  const [modelLayoutTick, setModelLayoutTick] = useState(0);
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
  const openSpecExecuteButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const openSpecRequestIdRef = useRef<string | null>(null);
  const openSpecTaskStatsRequestIdRef = useRef<string | null>(null);
  const openSpecTaskStatsCacheRef = useRef<Map<string, OpenSpecTaskStatsSummary>>(new Map());
  const openSpecChangeListCacheRef = useRef<Map<string, OpenSpecChangeListCacheEntry>>(new Map());
  const openSpecRequestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quickWrapRef = useRef<HTMLDivElement>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionLiveStatus = deriveSessionLiveStatus({
    sessionState: activeSession?.state,
    activeThinking,
    activeTransportTurn,
    isAgentless: activeSession?.agentType === 'shell' || activeSession?.agentType === 'script',
  });
  const showRunningSweep = !compact && activeSessionLiveStatus.sweep;
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
    && activeSessionLiveStatus.busy;
  const activeSessionPendingEntries = effectiveRuntimeType === 'transport'
    ? normalizeTransportPendingEntries(
        activeSession?.transportPendingMessageEntries,
        undefined,
        activeSession?.name ?? '',
        {
          // This is already-normalized session state, not a raw daemon payload.
          hasEntriesField: Array.isArray(activeSession?.transportPendingMessageEntries)
            && (activeSession.transportPendingMessageEntries.length > 0
              || typeof activeSession.transportPendingMessageVersion === 'number'),
          hasMessagesField: false,
        },
      )
    : [];
  const activeSessionFailedEntries: LocalQueuedTransportEntry[] = effectiveRuntimeType === 'transport'
    ? (activeSession?.failedMessageEntries ?? []).map((entry) => ({ ...entry, status: 'failed' as const }))
    : [];
  const activeSessionPendingVersion = typeof activeSession?.transportPendingMessageVersion === 'number'
    ? activeSession.transportPendingMessageVersion
    : undefined;
  const shouldUseRealtimeQueueOverride = !!activeSession?.name
    && realtimeQueueOverride?.sessionName === activeSession.name
    && (
      realtimeQueueOverride.version === undefined
      || activeSessionPendingVersion === undefined
      || realtimeQueueOverride.version >= activeSessionPendingVersion
    );
  const incomingPendingTransportEntries = shouldUseRealtimeQueueOverride
    ? realtimeQueueOverride.pendingEntries
    : activeSessionPendingEntries;
  const incomingFailedTransportEntries = shouldUseRealtimeQueueOverride
    ? realtimeQueueOverride.failedEntries
    : activeSessionFailedEntries;
  const incomingQueuedTransportEntries: LocalQueuedTransportEntry[] = [
    ...incomingPendingTransportEntries,
    ...incomingFailedTransportEntries.filter((failed) => (
      !incomingPendingTransportEntries.some((pending) => pending.clientMessageId === failed.clientMessageId)
    )),
  ];
  const incomingQueuedTransportVersion = shouldUseRealtimeQueueOverride
    ? realtimeQueueOverride.version
    : activeSessionPendingVersion;
  const timelineSettledQueuedIds = useMemo(
    () => timelineSettledQueuedIdsProp ?? collectSettledQueuedIds(transportTimelineEvents, activeSession?.name),
    [activeSession?.name, timelineSettledQueuedIdsProp, transportTimelineEvents],
  );
  const queuedTransportEntries = useMemo<LocalQueuedTransportEntry[]>(() => {
    let merged: LocalQueuedTransportEntry[];
    if (optimisticQueuedEntries === null) merged = incomingQueuedTransportEntries;
    else if (optimisticQueuedEntries.length === 0) merged = [];
    else if (incomingQueuedTransportEntries.length === 0) merged = optimisticQueuedEntries;
    else {
      const byId = new Map<string, LocalQueuedTransportEntry>();
      for (const entry of incomingQueuedTransportEntries) byId.set(entry.clientMessageId, entry);
      for (const entry of optimisticQueuedEntries) {
        byId.set(entry.clientMessageId, entry);
      }
      merged = [...byId.values()];
    }
    // Authoritative override: a message that reached the timeline is delivered,
    // so drop it from the queue even if a stale daemon snapshot still lists it.
    if (
      settledQueuedIds.size === 0
      && timelineSettledQueuedIds.size === 0
      && optimisticallyRemovedQueuedIds.size === 0
    ) return merged;
    const filtered = merged.filter((entry) => (
      !settledQueuedIds.has(entry.clientMessageId)
      && !timelineSettledQueuedIds.has(entry.clientMessageId)
      && !optimisticallyRemovedQueuedIds.has(entry.clientMessageId)
    ));
    return filtered.length === merged.length ? merged : filtered;
  }, [incomingQueuedTransportEntries, optimisticQueuedEntries, optimisticallyRemovedQueuedIds, settledQueuedIds, timelineSettledQueuedIds]);

  // Settled ids and optimistic queue overlays are scoped to the active session.
  // Reset the local overlay on switch; canonical session/app state remains
  // responsible for retaining or clearing authoritative pending entries.
  useEffect(() => {
    setSettledQueuedIds(new Set());
    setOptimisticallyRemovedQueuedIds(new Set());
    setOptimisticQueuedEntries(null);
    setRealtimeQueueOverride(null);
    reconciledMissingAppendCommandIdsRef.current.clear();
    lastRealtimeEmptyQueueSnapshotRef.current = null;
    setEditingQueuedMessageId(null);
    queuedMutationRollbackRef.current.clear();
    failedQueuedCommandIdsRef.current.clear();
  }, [activeSession?.name]);

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
  const sharedState = activeSession?.sharedState ?? null;
  // `outgoing` describes grants owned by the current user. Their viewer/
  // participant role belongs to the recipient and must never turn the owner's
  // own composer into a share-scoped, read-only surface.
  const isShareScopedSession = !!sharedState && sharedState.outgoing !== true;
  const canSharedSessionSend = !isShareScopedSession
    || (sharedState?.status === 'active' && sharedState.effectiveRole === 'participant');
  const canManageSharedServer = canSharedActorManageServer(sharedState);
  // Session settings mutate the owner session, so shared access is a positive
  // role grant rather than a consequence of the menu being reachable. Active
  // participants use the owner's existing settings surface; viewers and stale
  // shares remain read-only.
  const canOpenSessionSettings = canSharedSessionSend;
  // A share viewer cannot dispatch anything, so appending is denied at the
  // bridge too. Offering the control would only produce a rollback plus a raw
  // denial code; participants and owners keep it.
  const activeQueuedTransportEntries = queuedTransportEntries.filter((entry) => entry.status !== 'failed');
  const appendableQueuedTransportEntries = canSharedSessionSend
    ? activeQueuedTransportEntries
    : [];
  const appendAllConfirmationScope = JSON.stringify({
    serverId: serverId ?? '',
    sessionName: activeSession?.name ?? '',
    subSessionId: subSessionId ?? '',
    queueEpoch: activeSession?.queueEpoch ?? '',
    queueAuthorityId: activeSession?.queueAuthorityId ?? '',
    version: incomingQueuedTransportVersion ?? null,
    entries: appendableQueuedTransportEntries.map((entry) => ({
      clientMessageId: entry.clientMessageId,
      text: entry.text,
      status: entry.status ?? 'queued',
    })),
  });
  const queuedTransportLatestMessage = queuedTransportMessages[queuedTransportMessages.length - 1] ?? '';
  const editingQueuedEntry = editingQueuedMessageId
    ? queuedTransportEntries.find((entry) => entry.clientMessageId === editingQueuedMessageId) ?? null
    : null;

  const isEditableQueuedEntry = useCallback((entry: { clientMessageId: string }) => (
    !!activeSession && !!entry.clientMessageId
  ), [activeSession]);
  // Internal ref for contenteditable — also written to the external inputRef
  const divRef = useRef<HTMLDivElement>(null);
  const stopComposerResize = useCallback(() => {
    composerResizeCleanupRef.current?.();
    composerResizeCleanupRef.current = null;
  }, []);

  // Only the top edge resizes now. The corner grip was removed when the
  // controls moved under the input: it had nowhere to sit that was not either
  // stranded mid-box or fighting Send for the bottom-right corner, and the top
  // border is the edge that actually moves when the composer grows.
  const startComposerTopResize = useCallback((
    event: JSX.TargetedPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0 || window.innerWidth <= 640) return;
    event.preventDefault();
    stopComposerResize();

    const startY = event.clientY;
    const startHeight = clampComposerHeight(
      sharedComposerHeight ?? divRef.current?.getBoundingClientRect().height ?? COMPOSER_HEIGHT_MIN_PX,
    );
    let latestHeight = startHeight;
    document.body.classList.add('composer-height-resizing', 'composer-height-resizing-top');

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = startY - moveEvent.clientY;
      latestHeight = clampComposerHeight(startHeight + delta);
      broadcastComposerHeight(latestHeight);
    };
    const cleanupResize = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
      document.body.classList.remove('composer-height-resizing', 'composer-height-resizing-top');
    };
    const handlePointerEnd = () => {
      cleanupResize();
      composerResizeCleanupRef.current = null;
      persistComposerHeight(latestHeight);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    composerResizeCleanupRef.current = cleanupResize;
  }, [sharedComposerHeight, stopComposerResize]);

  const handleComposerResizeKeyDown = useCallback((event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    const current = sharedComposerHeight
      ?? divRef.current?.getBoundingClientRect().height
      ?? COMPOSER_HEIGHT_MIN_PX;
    let next: number | null = null;
    if (event.key === 'ArrowUp') next = current + COMPOSER_HEIGHT_STEP_PX;
    if (event.key === 'ArrowDown') next = current - COMPOSER_HEIGHT_STEP_PX;
    if (event.key === 'Home') next = COMPOSER_HEIGHT_MIN_PX;
    if (event.key === 'End') next = COMPOSER_HEIGHT_MAX_PX;
    if (next === null) return;
    event.preventDefault();
    persistComposerHeight(next);
  }, [sharedComposerHeight]);

  useEffect(() => () => stopComposerResize(), [stopComposerResize]);
  // Shared alias data — feeds compose-time resolution (A′) on send and the
  // inline `;` autocomplete. `aliasFiltered` is the name+description filtered
  // view for the current inline query; `aliasAll` is the full list used to
  // resolve markers into the out-of-band `resolvedAliases` map at send time.
  const {
    aliases: aliasAll,
    filtered: aliasFiltered,
    loaded: aliasLoaded,
    error: aliasError,
    refetch: refetchAliases,
  } = useAliases(aliasQuery);
  const {
    activeIndex: activeAliasIndex,
    handleNavigationKey: handleAliasNavigationKey,
  } = useListboxNavigation({
    activeIndex: aliasHighlightIdx,
    containerRef: aliasPickerRef,
    itemCount: aliasFiltered.length,
    open: aliasPickerOpen,
    setActiveIndex: setAliasHighlightIdx,
  });
  // Shared machine data — feeds compose-time resolution on send (the out-of-band
  // `resolvedMachines` hint) and the inline `^` autocomplete. `machineAll` is
  // the full list used to resolve markers at send time; `visibleMachines` applies
  // the remembered group filter (when groups exist) plus the inline `machineQuery`.
  // Unlike aliases there is NO fail-closed gate: an unresolved `^^(name)` marker
  // is left literal (a visible hint the server re-validates), so no loaded/error
  // state is needed here.
  const {
    machines: machineAll,
  } = useMachines();
  const [rememberedMachineGroup, setMachineGroup] = useRememberedMachineGroup(machinePickerOpen);
  const machineGroups = useMemo(() => machineGroupsOf(machineAll), [machineAll]);
  const activeMachineGroup = useMemo(
    () => (machineGroups.length > 0 ? resolveMachineGroup(rememberedMachineGroup, machineAll) : MACHINE_GROUP_ALL),
    [machineAll, machineGroups.length, rememberedMachineGroup],
  );
  const machineGroupFiltered = useMemo(
    () => (machineGroups.length > 0 ? machinesInGroup(machineAll, activeMachineGroup) : machineAll),
    [activeMachineGroup, machineAll, machineGroups.length],
  );
  const visibleMachines = useMemo(
    () => filterMachines(machineGroupFiltered, machineQuery),
    [machineGroupFiltered, machineQuery],
  );
  const {
    activeIndex: activeMachineIndex,
    handleNavigationKey: handleMachineNavigationKey,
  } = useListboxNavigation({
    activeIndex: machineHighlightIdx,
    containerRef: machinePickerRef,
    itemCount: visibleMachines.length,
    open: machinePickerOpen,
    setActiveIndex: setMachineHighlightIdx,
  });
  const publishComposerText = useCallback((text: string) => {
    onComposerTextChange?.(text);
  }, [onComposerTextChange]);
  // History navigation state
  const histIdxRef = useRef(-1);   // -1 = not navigating; 0 = most recent
  const draftRef = useRef('');      // saved unsent text while navigating
  const historyEditsRef = useRef<Map<number, string>>(new Map()); // per-index edits while browsing history
  const imeComposingRef = useRef(false);
  const lastImeCompositionAtRef = useRef(0);
  const attachmentDraftRef = useRef<ComposerAttachmentRecord[]>([]);
  const activeSessionIncognito = isIncognitoSession(activeSession)
    || (activeSession?.name ? isIncognitoTimelineSession(serverId ?? null, activeSession.name) : false);
  const composerDraftScope = buildComposerDraftScope(activeSession, subSessionId);
  useEffect(() => {
    histIdxRef.current = -1;
    draftRef.current = '';
    historyEditsRef.current.clear();
  }, [serverId, composerDraftScope, activeSessionIncognito]);
  const draftKey = !activeSessionIncognito && composerDraftScope ? `rcc_draft_${composerDraftScope}` : null;
  const attachmentDraftKey = !activeSessionIncognito && composerDraftScope ? `rcc_draft_attachments_${composerDraftScope}` : null;
  const attachmentDraftKeyRef = useRef<string | null>(attachmentDraftKey);
  attachmentDraftKeyRef.current = attachmentDraftKey;
  const mountedRef = useRef(true);
  const composerUploadKey = composerDraftScope ? `composer:${composerDraftScope}` : 'composer:global';
  // A voice notepad's local draft is kept per session exactly like the
  // composer's own draft (main sessions and sub-sessions alike), and per
  // server, so two servers' same-named sessions never share one.
  const voiceNotepadDraftScope = !activeSessionIncognito && composerDraftScope
    ? (serverId ? `${serverId}:${composerDraftScope}` : composerDraftScope)
    : null;
  const [hasVoiceNotepadDraft, setHasVoiceNotepadDraft] = useState(false);
  useEffect(() => {
    // Re-read when the overlay closes: that is when a notepad is left behind
    // (closed without sending) or settled (sent or discarded).
    if (voiceOpen) return;
    setHasVoiceNotepadDraft(
      !!voiceNotepadDraftScope && readVoiceNotepadDraft(voiceNotepadDraftScope) !== null,
    );
  }, [voiceNotepadDraftScope, voiceOpen]);
  // File upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadSnapshot, setUploadSnapshot] = useState(() => getComposerUploadSnapshot(composerUploadKey));
  const uploadRows = uploadSnapshot.uploads;
  // A row is pending until its resolved daemon path is attached to the
  // composer.  The path check closes the small render window between a
  // transfer settling and the attachment list update (and also fails closed
  // for any stale row restored from an older build).
  const uploading = uploadRows.some((item) => (
    item.status === 'uploading' || (item.status === 'done' && !item.attachmentPath)
  ));
  const uploadNow = useNowTicker(uploading);
  const uploadError = uploadSnapshot.error;
  const [sendWarning, setSendWarning] = useState<string | null>(null);
  const [appendSuccessNotice, setAppendSuccessNotice] = useState<string | null>(null);
  const [deliveryModeNotice, setDeliveryModeNotice] = useState<{ append: boolean; message: string } | null>(null);
  const [supervisionModeNotice, setSupervisionModeNotice] = useState<string | null>(null);
  const [effortClampNotice, setEffortClampNotice] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachmentRecord[]>([]);
  const [attachmentsExpanded, setAttachmentsExpanded] = useState(false);
  const [deletingAttachmentKeys, setDeletingAttachmentKeys] = useState<Set<string>>(() => new Set());
  const [pendingDelegateTarget, setPendingDelegateTarget] = useState<PendingDelegateTarget | null>(null);
  const sendWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appendSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deliveryModeNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supervisionModeNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const effortClampNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const effortClampAppliedRef = useRef<string | null>(null);
  const [localTransportConfig, setLocalTransportConfig] = useState<Record<string, unknown> | null>(activeSession?.transportConfig ?? null);

  const setComposerVoicePending = useCallback((pending: boolean) => {
    voiceHoldPendingRef.current = pending;
    composerRef.current?.classList.toggle('controls-composer-voice-pending', pending);
  }, []);

  const updateComposerFocused = useCallback((focused: boolean) => {
    composerFocusedRef.current = focused;
    for (const listener of composerFocusListenersRef.current) {
      listener(focused);
    }
    if (mobileLayoutRef.current || voiceHoldReadyRef.current) {
      setComposerFocused((prev) => (prev === focused ? prev : focused));
    }
  }, []);

  /**
   * Intentionally transition the composer out of unfocused read-only voice lock
   * into an editable `contenteditable="true"` state and focus it for typing.
   * Refuses while disabled or during an active/pending voice hold gesture.
   */
  const focusComposerForTyping = useCallback((options?: FocusComposerOptions): boolean => {
    const el = divRef.current;
    if (!el || !el.isConnected) return false;
    if (inputDisabledRef.current || voiceHoldPendingRef.current || voiceHoldActiveRef.current) {
      return false;
    }
    clearComposerVoiceTouchLock(el, false);
    composerFocusedRef.current = true;
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
    if (document.activeElement !== el) {
      composerFocusedRef.current = false;
      updateComposerFocused(false);
      clearComposerVoiceTouchLock(el, inputDisabledRef.current || voiceHoldReadyRef.current);
      didPrimeVoiceGestureRef.current = false;
      cancelVoiceInputGesturePrime();
      return false;
    }
    if (options?.moveCursorToEnd) {
      moveCaretToEnd(el);
    }
    updateComposerFocused(true);
    didPrimeVoiceGestureRef.current = false;
    cancelVoiceInputGesturePrime();
    return true;
  }, [updateComposerFocused]);

  // Keep external inputRef and focus handler in sync so external callers can enter typing mode.
  useEffect(() => {
    if (inputRef) (inputRef as { current: HTMLDivElement | null }).current = divRef.current;
    return registerComposerFocusHandler(divRef.current, focusComposerForTyping);
  }, [inputRef, focusComposerForTyping]);
  useEffect(() => () => {
    if (inputRef) (inputRef as { current: HTMLDivElement | null }).current = null;
  }, [inputRef]);

  useEffect(() => {
    const el = divRef.current;
    if (!el) return;
    const markImeActivity = () => { lastImeCompositionAtRef.current = Date.now(); };
    const handleCompositionStart = () => {
      imeComposingRef.current = true;
      cloudDocImeCommitAtRef.current = 0;
      markImeActivity();
      if (inlineVoiceActiveRef.current && !programmaticVoiceWriteRef.current) {
        interruptInlineVoiceRef.current?.();
      }
    };
    const handleCompositionEnd = () => {
      imeComposingRef.current = false;
      cloudDocImeCommitAtRef.current = Date.now();
      markImeActivity();
      // Re-run onInput now that composition committed. On many mobile IMEs the
      // input event carrying the composed text fires WHILE isComposing is still
      // true (so the inline `;` alias + `@` triggers were suppressed) and no
      // input fires after compositionend — so a CJK query like `;服务` never
      // registers (while a plain edit like deleting a char does). Dispatching a
      // synthetic input re-evaluates the final committed text. Same pattern the
      // pending-prefill effect uses.
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const handleNativeBlur = () => {
      updateComposerFocused(false);
      closeQuickSuggestions();
      closeCloudDocPicker();
    };
    el.addEventListener('compositionstart', handleCompositionStart);
    el.addEventListener('compositionupdate', markImeActivity);
    el.addEventListener('compositionend', handleCompositionEnd);
    el.addEventListener('blur', handleNativeBlur);
    return () => {
      el.removeEventListener('compositionstart', handleCompositionStart);
      el.removeEventListener('compositionupdate', markImeActivity);
      el.removeEventListener('compositionend', handleCompositionEnd);
      el.removeEventListener('blur', handleNativeBlur);
    };
  }, [closeQuickSuggestions, closeCloudDocPicker]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!pendingPrefillText || !divRef.current) return;
    const nextText = `${readComposerElementText(divRef.current)}${pendingPrefillText}`;
    quickPhraseInputSuppressRef.current = true;
    closeQuickSuggestions();
    setComposerElementText(divRef.current, nextText);
    setHasText(!!nextText.trim());
    publishComposerText(nextText);
    divRef.current.dispatchEvent(new Event('input', { bubbles: true }));
    focusComposerForTyping({ moveCursorToEnd: true });
    onPendingPrefillApplied?.();
  }, [closeQuickSuggestions, focusComposerForTyping, pendingPrefillText, onPendingPrefillApplied, publishComposerText]);

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
  const showAppendSuccessNotice = useCallback((message: string) => {
    if (appendSuccessTimerRef.current) clearTimeout(appendSuccessTimerRef.current);
    setAppendSuccessNotice(message);
    appendSuccessTimerRef.current = setTimeout(() => {
      appendSuccessTimerRef.current = null;
      setAppendSuccessNotice(null);
    }, 3500);
  }, []);
  const showDeliveryModeNotice = useCallback((append: boolean) => {
    if (deliveryModeNoticeTimerRef.current) clearTimeout(deliveryModeNoticeTimerRef.current);
    setDeliveryModeNotice({
      append,
      message: t(append ? 'session.delivery_mode_append_toast' : 'session.delivery_mode_queue_toast'),
    });
    deliveryModeNoticeTimerRef.current = setTimeout(() => {
      deliveryModeNoticeTimerRef.current = null;
      setDeliveryModeNotice(null);
    }, 2200);
  }, [t]);
  const showSupervisionModeNotice = useCallback((mode: SupervisionMode) => {
    if (supervisionModeNoticeTimerRef.current) clearTimeout(supervisionModeNoticeTimerRef.current);
    setSupervisionModeNotice(t('session.supervision.modeSaved', {
      mode: t(`session.supervision.mode.${mode}`),
    }));
    supervisionModeNoticeTimerRef.current = setTimeout(() => {
      supervisionModeNoticeTimerRef.current = null;
      setSupervisionModeNotice(null);
    }, 3500);
  }, [t]);
  const showEffortClampNotice = useCallback((from: TransportEffortLevel, to: TransportEffortLevel) => {
    if (effortClampNoticeTimerRef.current) clearTimeout(effortClampNoticeTimerRef.current);
    setEffortClampNotice(t('session.thinking_clamped', { from: formatEffortLevel(from), to: formatEffortLevel(to) }));
    effortClampNoticeTimerRef.current = setTimeout(() => {
      effortClampNoticeTimerRef.current = null;
      setEffortClampNotice(null);
    }, 4500);
  }, [t]);
  useEffect(() => () => {
    if (pendingStopQueueRef.current) clearTimeout(pendingStopQueueRef.current.timer);
    pendingStopQueueRef.current = null;
  }, [activeSession?.name]);

  const transportQueueAppendFailedLabel = t('session.transport_queue_append_failed');

  // Persist input draft across unmount/remount (sub-session minimize/restore)
  const [hydratedAttachmentDraftKey, setHydratedAttachmentDraftKey] = useState<string | null>(null);
  useEffect(() => {
    if (!draftKey || !divRef.current) return;
    const saved = safeSessionStorageGetItem(draftKey);
    if (saved) {
      setComposerElementText(divRef.current, saved);
      setHasText(!!saved.trim());
      publishComposerText(saved);
    } else {
      publishComposerText('');
    }
    syncMobileComposerMetrics();
    return () => {
      const text = divRef.current ? readComposerElementText(divRef.current) : '';
      if (draftKey) safeSessionStorageSetItem(draftKey, text);
    };
  }, [draftKey, publishComposerText]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setHydratedAttachmentDraftKey(null);
    setAttachmentsExpanded(false);
    if (!attachmentDraftKey) {
      setAttachments([]);
      setAttachmentsExpanded(false);
      attachmentDraftRef.current = [];
      return;
    }
    const saved = parseStoredComposerAttachments(safeSessionStorageGetItem(attachmentDraftKey));
    setAttachments(saved);
    attachmentDraftRef.current = saved;
    setHydratedAttachmentDraftKey(attachmentDraftKey);
  }, [attachmentDraftKey]);

  useEffect(() => {
    attachmentDraftRef.current = attachments;
    if (attachments.length <= ATTACHMENT_BADGE_COLLAPSE_THRESHOLD) {
      setAttachmentsExpanded(false);
    }
    closeQuickSuggestions();
    if (!attachmentDraftKey || hydratedAttachmentDraftKey !== attachmentDraftKey) return;
    try {
      // Unbounded: the default draft cap would truncate this JSON.
      if (attachments.length > 0) safeSessionStorageSetItem(attachmentDraftKey, JSON.stringify(attachments), Number.MAX_SAFE_INTEGER);
      else safeSessionStorageRemoveItem(attachmentDraftKey);
    } catch {
      /* ignore */
    }
  }, [attachmentDraftKey, attachments, closeQuickSuggestions, hydratedAttachmentDraftKey]);

  useEffect(() => subscribeComposerUploadSnapshot(composerUploadKey, setUploadSnapshot), [composerUploadKey]);

  useEffect(() => () => {
    if (sendWarningTimerRef.current) clearTimeout(sendWarningTimerRef.current);
    if (appendSuccessTimerRef.current) clearTimeout(appendSuccessTimerRef.current);
    if (deliveryModeNoticeTimerRef.current) clearTimeout(deliveryModeNoticeTimerRef.current);
    if (supervisionModeNoticeTimerRef.current) clearTimeout(supervisionModeNoticeTimerRef.current);
    if (effortClampNoticeTimerRef.current) clearTimeout(effortClampNoticeTimerRef.current);
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

  const connected = connectedProp ?? !!ws?.connected;
  const connectedRef = useRef(connected);
  connectedRef.current = connected;

  useEffect(() => {
    if (!ws
      || !serverId
      || !activeSession
      || !connected
      || typeof ws.targetsServer !== 'function'
      || !ws.targetsServer(serverId)) return;
    return prewarmDirectFileLease(ws, serverId);
  }, [activeSession?.name, connected, serverId, ws]);

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
          ...(msg.provider ? { provider: msg.provider } : {}),
          ...(typeof msg.providerGeneration === 'number' ? { providerGeneration: msg.providerGeneration } : {}),
          ...(msg.providerToolUseId ? { providerToolUseId: msg.providerToolUseId } : {}),
          ...(msg.inputPreview ? { inputPreview: msg.inputPreview } : {}),
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
  // Input only disabled when there's no session or the active share cannot dispatch messages.
  const inputDisabled = !hasSession || !canSharedSessionSend;
  inputDisabledRef.current = inputDisabled;
  const participantControlDisabled = !connected || !hasSession || !canSharedSessionSend;
  // A participant can use every session-scoped action except stopping the
  // session. Viewers and inactive shares remain read-only.
  const disabled = participantControlDisabled;
  const modelSwitchDisabled = participantControlDisabled;
  const isClaudeCode = activeSession?.agentType === 'claude-code' || activeSession?.agentType === 'claude-code-sdk';
  const isShellLike = activeSession?.agentType === 'shell' || activeSession?.agentType === 'script';
  const isTransport = effectiveRuntimeType === 'transport';
  const currentTransportConfig = localTransportConfig ?? activeSession?.transportConfig ?? null;
  const hasInvalidSupervisionConfig = hasInvalidSessionSupervisionSnapshot(currentTransportConfig);
  const supervisionSnapshot = extractSessionSupervisionSnapshot(currentTransportConfig);
  const quickSupervisionMode = isShareScopedSession
    ? activeSession?.supervisionMode ?? SUPERVISION_MODE.OFF
    : supervisionSnapshot?.mode ?? SUPERVISION_MODE.OFF;
  const auditedSessionName = activeSession?.name ?? null;
  const supportsSupervisionSurface = !!(
    activeSession
    && serverId
    && isTransport
    && isSupportedSupervisionTargetSessionType(activeSession.agentType)
  );
  const workflowControlsHidden = !!(hideWorkflowControls || subSessionId);
  const canQuickPeerAudit = !workflowControlsHidden && supportsSupervisionSurface;
  const canQuickViewSupervision = canQuickPeerAudit
    && canSessionRoleOwnAutomaticSupervision(activeSession?.role)
    && (!isShareScopedSession || (
      sharedState?.status === 'active'
      && sharedState.effectiveRole === 'participant'
    ));
  const canQuickControlSupervision = canQuickViewSupervision && canSharedActorControlSession(sharedState);
  const supervisorDefaultsPref = useSupervisorDefaults(
    canQuickControlSupervision,
    serverId && activeSession?.name ? { serverId, sessionName: activeSession.name } : null,
  );
  const isCodex = activeSession?.agentType === 'codex' || activeSession?.agentType === 'codex-sdk';
  const isQwen = activeSession?.agentType === 'qwen';
  const isCopilot = activeSession?.agentType === 'copilot-sdk';
  const isCursorHeadless = activeSession?.agentType === 'cursor-headless';
  const isDeepseekHarness = activeSession?.agentType === 'deepseek-harness';
  const isPi = activeSession?.agentType === 'pi';
  const isGrokSdk = activeSession?.agentType === 'grok-sdk';
  const isKimiSdk = activeSession?.agentType === 'kimi-sdk';
  const isHermesAgent = activeSession?.agentType === HERMES_AGENT_PROVIDER_ID;
  const isAgySdk = activeSession?.agentType === AGY_SDK_PROVIDER_ID;
  const isOpenCodeSdk = activeSession?.agentType === 'opencode-sdk';
  const isCodeBuddy = isCodeBuddyProviderId(activeSession?.agentType);
  const isMuseSdk = activeSession?.agentType === 'muse-code-sdk';
  const supportsGenericTransportModelSelect = isCopilot || isCursorHeadless || isDeepseekHarness || isPi || isGrokSdk || isKimiSdk || isHermesAgent || isAgySdk || isOpenCodeSdk || isCodeBuddy || isMuseSdk;
  // Source-of-truth priority for the model picker:
  //   1. `useTransportModels` — live daemon probe via `transport.list_models`
  //      WS round-trip. Works uniformly for main sessions AND sub-sessions
  //      (sub-session SessionInfo records aren't hydrated with
  //      provider-specific availableModels, so we can't rely on activeSession).
  //   2. `activeSession?.{copilot,cursor}AvailableModels` — cached
  //      hydration set by `buildSessionList()` for main sessions (first
  //      paint before the WS probe reply arrives).
  //   3. Provider-specific fallback constants where available.
  const dynamicModelsAgentType = canSharedSessionSend && supportsDynamicTransportModels(activeSession?.agentType)
    ? activeSession!.agentType
    : null;
  const dynamicTransportModels = useTransportModels(
    ws,
    dynamicModelsAgentType,
    activeSession && CUSTOM_PROVIDER_SDK_AGENT_TYPES.has(activeSession.agentType)
      ? activeSession.ccPreset
      : undefined,
    activeSession?.name,
  );
  const genericTransportModelSuggestions: readonly string[] = useMemo(() => {
    if (dynamicTransportModels.models.length > 0) {
      const dynamicModelIds = dynamicTransportModels.models.map((m) => m.id);
      return isMuseSdk
        ? mergeModelSuggestions(MUSE_SDK_MODEL_SUGGESTIONS, dynamicModelIds)
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
    if (isMuseSdk) {
      return MUSE_SDK_MODEL_SUGGESTIONS;
    }
    if (isAgySdk) {
      return AGY_SDK_MODEL_SUGGESTIONS;
    }
    if (isKimiSdk || isHermesAgent || isGrokSdk) {
      return dynamicTransportModels.models.map((m) => m.id);
    }
    if (activeSession?.agentType === CODEBUDDY_PROVIDER_IDS.CHINA) {
      return CODEBUDDY_CHINA_MODEL_FALLBACK;
    }
    if (activeSession?.agentType === CODEBUDDY_PROVIDER_IDS.INTERNATIONAL) {
      return CODEBUDDY_INTERNATIONAL_MODEL_FALLBACK;
    }
    return [];
  }, [
    dynamicTransportModels.models,
    isCopilot,
    isCursorHeadless,
    isGrokSdk,
    isKimiSdk,
    isHermesAgent,
    isAgySdk,
    isOpenCodeSdk,
    isCodeBuddy,
    isMuseSdk,
    activeSession?.agentType,
    activeSession?.copilotAvailableModels,
    activeSession?.cursorAvailableModels,
  ]);
  const legacyCodexModel = loadLegacyCodexModelPreferenceForModelessSession(activeSession, detectedModel);
  const genericTransportModel = resolveEffectiveSessionModel(activeSession, detectedModel, legacyCodexModel) ?? null;
  const displayedCodexModel = activeSession?.agentType === 'codex-sdk'
    ? genericTransportModel
    : (genericTransportModel ?? codexModel);
  const codexModelSuggestions: readonly string[] = useMemo(() => {
    if (activeSession?.ccPreset) {
      const candidates: string[] = [];
      if (displayedCodexModel) candidates.push(displayedCodexModel);
      if (activeSession.requestedModel && !candidates.includes(activeSession.requestedModel)) {
        candidates.push(activeSession.requestedModel);
      }
      if (activeSession.activeModel && !candidates.includes(activeSession.activeModel)) {
        candidates.push(activeSession.activeModel);
      }
      const dynamicIds = dynamicTransportModels.models.map((m) => m.id);
      const probed = activeSession.codexAvailableModels ?? [];
      const merged = mergeModelSuggestions(candidates, [...dynamicIds, ...probed]);
      return merged.length > 0 ? merged : (displayedCodexModel ? [displayedCodexModel] : []);
    }
    if (activeSession?.agentType !== 'codex-sdk') return CODEX_MODELS;
    if (dynamicTransportModels.models.length > 0) {
      return dynamicTransportModels.models.map((m) => m.id);
    }
    if (activeSession?.codexAvailableModels?.length) return activeSession.codexAvailableModels;
    return CODEX_MODELS;
  }, [
    activeSession?.agentType,
    activeSession?.ccPreset,
    activeSession?.requestedModel,
    activeSession?.activeModel,
    activeSession?.codexAvailableModels,
    displayedCodexModel,
    dynamicTransportModels.models,
  ]);
  const claudeSessionModel = activeSession?.agentType === 'claude-code-sdk'
    ? (resolveEffectiveSessionModel(activeSession, detectedModel) ?? null)
    : null;
  const claudePinnedModel = claudeSessionModel && (
    !!activeSession?.ccPreset
    || !normalizeClaudeCodeModelId(claudeSessionModel)
  )
    ? claudeSessionModel
    : null;
  const displayedClaudeModel = claudePinnedModel ?? model;
  const claudeModelSuggestions = activeSession?.agentType === 'claude-code-sdk'
    && activeSession.ccPreset
    ? mergeModelSuggestions(
        claudePinnedModel ? [claudePinnedModel] : [],
        dynamicTransportModels.models.map((candidate) => candidate.id),
      )
    : claudePinnedModel
      ? [claudePinnedModel]
      : CLAUDE_CODE_MODEL_IDS;
  const qwenCompatibleApiSession = activeSession?.agentType === 'qwen'
    && (!!activeSession?.ccPreset || activeSession?.qwenAuthType === QWEN_AUTH_TYPES.API_KEY);
  const selectedDynamicModel = useMemo(
    () => dynamicTransportModels.models.find((candidate) => candidate.id === displayedCodexModel || candidate.id === genericTransportModel),
    [displayedCodexModel, genericTransportModel, dynamicTransportModels.models],
  );
  const thinkingLevels = useMemo((): readonly TransportEffortLevel[] => (
    activeSession?.agentType === 'claude-code-sdk'
      ? CLAUDE_SDK_EFFORT_LEVELS
      : activeSession?.agentType === 'codex-sdk'
        ? (selectedDynamicModel?.supportedEffortLevels ?? CODEX_SDK_EFFORT_LEVELS)
        : activeSession?.agentType === 'qwen'
          ? (qwenCompatibleApiSession ? ['high'] : QWEN_EFFORT_LEVELS)
          : activeSession?.agentType === 'copilot-sdk'
            ? COPILOT_SDK_EFFORT_LEVELS
          : activeSession?.agentType === 'muse-code-sdk'
            ? (selectedDynamicModel?.supportedEffortLevels ?? MUSE_SDK_EFFORT_LEVELS)
          : activeSession?.agentType === 'openclaw'
            ? OPENCLAW_THINKING_LEVELS
            : []
  ), [activeSession?.agentType, qwenCompatibleApiSession, selectedDynamicModel?.supportedEffortLevels]);
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
  const availableModelSuggestions: readonly string[] = isClaudeCode
    ? claudeModelSuggestions
    : isCodex
      ? codexModelSuggestions
      : isQwen
        ? qwenChoices.map((choice) => choice.id)
        : supportsGenericTransportModelSelect
          ? genericTransportModelSuggestions
          : [];
  const quickSuggestions = useMemo(() => {
    if (quickSuggestionKind === 'phrase') {
      return getQuickPhraseSuggestions(quickData.data.phrases, quickSuggestionQuery);
    }
    if (quickSuggestionKind === 'model') {
      return getModelCommandSuggestions(availableModelSuggestions, quickSuggestionQuery);
    }
    return getSlashCommandSuggestions(
      activeSession?.agentType ?? 'claude-code',
      quickData.data.commands,
      quickSuggestionQuery,
    );
  }, [
    activeSession?.agentType,
    availableModelSuggestions,
    quickData.data.commands,
    quickData.data.phrases,
    quickSuggestionKind,
    quickSuggestionQuery,
  ]);
  const skillSuggestions = useMemo(() => {
    if (quickSuggestionKind !== 'skill') return [] as AgentSkillEntry[];
    const needle = quickSuggestionQuery.trim().toLocaleLowerCase();
    return agentSkills.filter((skill) => !needle || [skill.name, skill.description, skill.source, skill.sourceUrl]
      .some((value) => value?.toLocaleLowerCase().includes(needle)));
  }, [agentSkills, quickSuggestionKind, quickSuggestionQuery]);
  const quickSuggestionPickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (quickSuggestionKind === 'phrase' && quickSuggestions.length === 0) {
      closeQuickSuggestions();
    }
  }, [closeQuickSuggestions, quickSuggestionKind, quickSuggestions.length]);
  const {
    activeIndex: activeQuickSuggestionIndex,
    handleNavigationKey: handleQuickSuggestionNavigationKey,
  } = useListboxNavigation({
    activeIndex: quickSuggestionHighlightIdx,
    containerRef: quickSuggestionPickerRef,
    itemCount: quickSuggestionKind === 'skill' ? skillSuggestions.length : quickSuggestions.length,
    open: quickSuggestionKind !== null,
    setActiveIndex: setQuickSuggestionHighlightIdx,
  });
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
  const lastIncomingQueuedTransportVersionRef = useRef(incomingQueuedTransportVersion);
  useEffect(() => {
    if (effectiveRuntimeType !== 'transport') {
      setOptimisticQueuedEntries(null);
      lastIncomingQueuedTransportEntriesKeyRef.current = incomingQueuedTransportEntriesKey;
      lastIncomingQueuedTransportEntriesCountRef.current = incomingQueuedTransportEntries.length;
      lastIncomingQueuedTransportEntryIdsRef.current = new Set(incomingQueuedTransportEntries.map((entry) => entry.clientMessageId));
      lastIncomingQueuedTransportVersionRef.current = incomingQueuedTransportVersion;
      return;
    }
    const previousIds = lastIncomingQueuedTransportEntryIdsRef.current;
    const previousCount = lastIncomingQueuedTransportEntriesCountRef.current;
    const previousVersion = lastIncomingQueuedTransportVersionRef.current;
    const incomingChanged = lastIncomingQueuedTransportEntriesKeyRef.current !== incomingQueuedTransportEntriesKey;
    const versionChanged = previousVersion !== incomingQueuedTransportVersion;
    const emptySnapshotAdvanced = incomingQueuedTransportEntries.length === 0
      && incomingQueuedTransportVersion !== undefined
      && versionChanged
      && (
        previousVersion === undefined
          ? incomingQueuedTransportVersion > 0
          : incomingQueuedTransportVersion === 0 || incomingQueuedTransportVersion >= previousVersion
      );
    if (incomingChanged && incomingQueuedTransportEntries.length > 0) {
      const incomingIds = new Set(incomingQueuedTransportEntries.map((entry) => entry.clientMessageId));
      setOptimisticQueuedEntries((prev) => {
        if (!prev) return null;
        const remaining = prev.filter((entry) => !incomingIds.has(entry.clientMessageId));
        if (remaining.length === prev.length) return prev;
        return remaining.length > 0 ? remaining : null;
      });
    } else if ((incomingChanged && previousCount > 0 && incomingQueuedTransportEntries.length === 0) || emptySnapshotAdvanced) {
      setOptimisticQueuedEntries((prev) => {
        if (!prev) return null;
        if (emptySnapshotAdvanced) return null;
        const remaining = prev.filter((entry) => !previousIds.has(entry.clientMessageId));
        if (remaining.length === prev.length) return prev;
        return remaining.length > 0 ? remaining : null;
      });
    }
    if (incomingQueuedTransportEntries.length === 0 && incomingQueuedTransportVersion !== undefined) {
      // Race guard: a fast daemon drain can advance the authoritative empty
      // queue before Preact commits the local optimistic entry. Re-check local
      // entries against the version they were created after so an already-
      // drained optimistic card cannot linger in the frontend queue, while a
      // new send created after the current empty baseline is preserved.
      setOptimisticQueuedEntries((prev) => {
        if (!prev) return null;
        const emptySnapshot = lastRealtimeEmptyQueueSnapshotRef.current;
        const remaining = prev.filter((entry) => (
          entry.queuedAfterVersion === undefined
          || incomingQueuedTransportVersion < entry.queuedAfterVersion
          || (
            incomingQueuedTransportVersion === entry.queuedAfterVersion
            && (
              !emptySnapshot
              || emptySnapshot.sessionName !== activeSession?.name
              || emptySnapshot.version !== incomingQueuedTransportVersion
              || entry.queuedAtMs === undefined
              || entry.queuedAtMs > emptySnapshot.observedAtMs
            )
          )
        ));
        if (remaining.length === prev.length) return prev;
        return remaining.length > 0 ? remaining : null;
      });
    }
    lastIncomingQueuedTransportEntriesKeyRef.current = incomingQueuedTransportEntriesKey;
    lastIncomingQueuedTransportEntriesCountRef.current = incomingQueuedTransportEntries.length;
    lastIncomingQueuedTransportEntryIdsRef.current = new Set(incomingQueuedTransportEntries.map((entry) => entry.clientMessageId));
    lastIncomingQueuedTransportVersionRef.current = incomingQueuedTransportVersion;
  }, [activeSession?.name, effectiveRuntimeType, incomingQueuedTransportEntries.length, incomingQueuedTransportEntriesKey, incomingQueuedTransportVersion, optimisticQueuedEntries]);

  // Keep the queue listener mounted for the lifetime of the session. Timeline
  // bursts update `activeSession` in the parent before every consumer has seen
  // the same burst; depending on the whole object here used to tear this
  // listener down between an authoritative empty queue snapshot and the
  // following `user.message`. The chat timeline (a separate listener) advanced,
  // while this queue card stayed stale until the sub-session window remounted.
  // Read mutable queue/session metadata through a ref so ordinary state merges
  // never create a live-delivery gap.
  const realtimeQueueStateRef = useRef({
    activeSession,
    incomingQueuedTransportEntries,
    incomingQueuedTransportVersion,
  });
  realtimeQueueStateRef.current = {
    activeSession,
    incomingQueuedTransportEntries,
    incomingQueuedTransportVersion,
  };

  useEffect(() => {
    const sessionName = activeSession?.name;
    if (!ws || !sessionName) return;
    const handleRealtimeQueueMessage = (msg: ServerMessage) => {
      const applyRealtimeQueueSnapshot = (payload: Record<string, unknown>, snapshotSessionName: string): boolean => {
        if (snapshotSessionName !== sessionName || !hasTransportPendingSyncSnapshot(payload)) return false;
        const current = realtimeQueueStateRef.current;
        const currentSession = current.activeSession;
        if (!currentSession || currentSession.name !== sessionName) return false;
        const patch = buildTransportPendingSyncPatch({
          transportPendingMessageEntries: current.incomingQueuedTransportEntries,
          transportPendingMessageVersion: current.incomingQueuedTransportVersion,
          queueEpoch: currentSession.queueEpoch,
          queueAuthorityId: currentSession.queueAuthorityId,
          failedMessageEntries: currentSession.failedMessageEntries,
          transportPendingSettledMessageIds: currentSession.transportPendingSettledMessageIds,
        }, payload, snapshotSessionName);
        if (Object.keys(patch).length === 0) return false;
        const pendingEntries = (patch.transportPendingMessageEntries ?? []).map((entry) => ({
          ...entry,
          status: 'queued' as const,
        }));
        const failedEntries = (patch.failedMessageEntries ?? []).map((entry) => ({
          ...entry,
          status: 'failed' as const,
        }));
        const queueReconcilesCommandId = typeof payload.queueReconcilesCommandId === 'string'
          ? payload.queueReconcilesCommandId.trim()
          : '';
        if (
          queueReconcilesCommandId
          && queuedMutationRollbackRef.current.get(queueReconcilesCommandId)?.type === 'append'
        ) {
          reconciledMissingAppendCommandIdsRef.current.add(queueReconcilesCommandId);
        }
        setRealtimeQueueOverride({
          sessionName: snapshotSessionName,
          pendingEntries,
          failedEntries,
          version: patch.transportPendingMessageVersion,
        });
        // Several authoritative frames can arrive in one websocket burst,
        // before React commits the state update above. Advance the mutable
        // reducer baseline synchronously so an older session_list/subsession
        // frame in that same burst cannot overwrite this snapshot and revive a
        // retired Retry card.
        realtimeQueueStateRef.current = {
          activeSession: {
            ...currentSession,
            queueEpoch: patch.queueEpoch,
            queueAuthorityId: patch.queueAuthorityId,
            transportPendingMessageVersion: patch.transportPendingMessageVersion,
            transportPendingMessageEntries: patch.transportPendingMessageEntries,
            failedMessageEntries: patch.failedMessageEntries,
          },
          incomingQueuedTransportEntries: [...pendingEntries, ...failedEntries],
          incomingQueuedTransportVersion: patch.transportPendingMessageVersion,
        };
        // Once an authoritative snapshot no longer contains an optimistically
        // removed id, its deletion is fully reconciled and the tombstone can be
        // discarded. Keep tombstones that are still present in a stale/equal
        // snapshot so those cards cannot flash back into the UI.
        const authoritativeIds = new Set(
          [...pendingEntries, ...failedEntries].map((entry) => entry.clientMessageId),
        );
        setOptimisticallyRemovedQueuedIds((prev) => {
          if (prev.size === 0) return prev;
          const next = new Set([...prev].filter((id) => authoritativeIds.has(id)));
          return next.size === prev.size ? prev : next;
        });
        if (pendingEntries.length === 0) {
          lastRealtimeEmptyQueueSnapshotRef.current = {
            sessionName: snapshotSessionName,
            version: patch.transportPendingMessageVersion,
            observedAtMs: Date.now(),
          };
          setOptimisticQueuedEntries(null);
        } else {
          lastRealtimeEmptyQueueSnapshotRef.current = null;
        }
        acceptedQueueSnapshotSeqRef.current += 1;
        return true;
      };
      const removeLocalQueuedEntry = (commandId: string, text?: string) => {
        void text;
        if (!commandId) return;
        setOptimisticQueuedEntries((prev) => {
          if (!prev) return prev;
          const next = prev.filter((entry) => entry.clientMessageId !== commandId);
          if (next.length === prev.length) return prev;
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
      const rememberSettledQueuedId = (commandId: string) => {
        if (!commandId) return;
        setSettledQueuedIds((prev) => {
          if (prev.has(commandId)) return prev;
          const ids = [...prev, commandId];
          return new Set(ids.length > 500 ? ids.slice(-500) : ids);
        });
      };

      if (msg.type === 'session_list') {
        const session = msg.sessions.find((item) => item.name === sessionName);
        if (session) applyRealtimeQueueSnapshot(session as Record<string, unknown>, sessionName);
        return;
      }
      const applySubsessionPayload = (payload: Record<string, unknown>) => {
        const snapshotSessionName = typeof payload.sessionName === 'string'
          ? payload.sessionName
          : typeof payload.id === 'string'
            ? `deck_sub_${payload.id}`
            : '';
        if (snapshotSessionName !== sessionName) return;
        applyRealtimeQueueSnapshot(payload, snapshotSessionName);
      };
      if (msg.type === 'subsession.sync' || msg.type === 'subsession.created') {
        applySubsessionPayload(msg as unknown as Record<string, unknown>);
        return;
      }
      if (msg.type === SUBSESSION_CREATED_BATCH_MSG) {
        if (Array.isArray(msg.items)) {
          for (const item of msg.items) {
            if (item && typeof item === 'object') {
              applySubsessionPayload(item as unknown as Record<string, unknown>);
            }
          }
        }
        return;
      }
      if (msg.type === 'command.ack') {
        if (msg.session && msg.session !== sessionName) return;
        const stopPending = pendingStopQueueRef.current;
        if (stopPending?.commandId === msg.commandId) {
          clearTimeout(stopPending.timer);
          pendingStopQueueRef.current = null;
          const stopOutcome = (msg as unknown as Record<string, unknown>)[TRANSPORT_STOP_QUEUE_FIELDS.OUTCOME];
          if (msg.status === 'accepted' && stopOutcome === TRANSPORT_STOP_QUEUE_OUTCOMES.APPENDED) {
            showAppendSuccessNotice(queueTranslationRef.current('session.stop_appended_queue'));
          } else if (msg.status === 'accepted' && stopOutcome === TRANSPORT_STOP_QUEUE_OUTCOMES.STOPPED_AND_DISPATCHED) {
            showAppendSuccessNotice(queueTranslationRef.current('session.stop_queue_stopped'));
          } else if (stopOutcome !== TRANSPORT_STOP_QUEUE_OUTCOMES.ALREADY_DELIVERED) {
            // Old peers may acknowledge the real Stop receipt without a queue
            // outcome. Never invent a native-append success from that receipt.
            showSendWarning(msg.error || queueTranslationRef.current('session.stop_queue_unconfirmed'));
          }
        }
        const rollback = queuedMutationRollbackRef.current.get(msg.commandId);
        // Authority BEFORE rollback. The daemon also broadcasts this snapshot on
        // a timeline session.state for other subscribers, but that frame is
        // best-effort: when it was the only carrier, losing it meant the append
        // rollback restored a card the canonical queue no longer had, and the
        // next click answered "Queued message not found" again. The ack is the
        // reliable, replayable frame, so the snapshot it carries is applied here
        // first and the rollback then runs against post-reconciliation state.
        //
        // `applyRealtimeQueueSnapshot` is the SAME gate the timeline path uses:
        // it returns false for a foreign session, a payload with no snapshot, or
        // any epoch/authority/stale-version violation, so a rejected snapshot
        // can never clear a still-valid card.
        const ackReconcilesCommandId = typeof msg.queueReconcilesCommandId === 'string'
          ? msg.queueReconcilesCommandId.trim()
          : '';
        if (applyRealtimeQueueSnapshot(msg as unknown as Record<string, unknown>, sessionName)
          && ackReconcilesCommandId
          && queuedMutationRollbackRef.current.get(ackReconcilesCommandId)?.type === 'append') {
          reconciledMissingAppendCommandIdsRef.current.add(ackReconcilesCommandId);
          // The optimistic post-append array is obsolete the moment the queue
          // authority answers, and an EMPTY one hard-overrides the snapshot
          // rather than merging with it, so leaving it in place hid a survivor
          // the authority still listed. Dropping it lets the snapshot alone
          // decide: the missing card stays gone, the real one stays visible.
          setOptimisticQueuedEntries(null);
        }
        if (msg.status === 'error' || msg.status === 'conflict') {
          if (rollback) {
            if (rollback.type === 'undo') {
              setOptimisticallyRemovedQueuedIds((prev) => {
                if (!prev.has(rollback.entry.clientMessageId)) return prev;
                const next = new Set(prev);
                next.delete(rollback.entry.clientMessageId);
                return next;
              });
            } else if (rollback.type === 'append') {
              const rollbackIds = new Set(rollback.entries.map((entry) => entry.clientMessageId));
              setOptimisticallyRemovedQueuedIds((prev) => {
                if (![...rollbackIds].some((id) => prev.has(id))) return prev;
                const next = new Set(prev);
                for (const id of rollbackIds) next.delete(id);
                return next;
              });
              // Rollback restores the PRE-CLICK queue, which is only the right
              // answer while the click is still the newest thing that happened.
              // Two ways it stops being that:
              //
              //  - this ack carried a snapshot that reconciled this exact
              //    commandId (marked above), or
              //  - any authoritative snapshot was accepted AFTER the click,
              //    carrying no queueReconcilesCommandId of its own.
              //
              // The second case is how a ghost came back: click at v7, an
              // ordinary v9 snapshot retires the ghost, then a delayed/replayed
              // not-found ack arrives at v8. The ack snapshot is correctly
              // rejected as stale -- so it is NOT reconciliation -- and the
              // rollback then reinstated the v7 ghost over v9 and stamped it
              // with v9's version, which made it look authoritative.
              //
              // Comparing against the authority captured at click time settles
              // it without trusting the late ack's own version. A normal
              // provider error with no newer authority still rolls back.
              // Supersession is scoped to the ABSENT case, and deliberately so.
              //
              // A newer authoritative snapshot may legitimately omit a selected
              // row merely because this append reserved it. When admission then
              // fails for a provider reason, that row still exists and rollback
              // must put it back ahead of whatever arrived meanwhile -- an
              // existing contract, pinned by the ordering test above. So
              // "authority answered since the click" cannot supersede on its own.
              //
              // `queueReconcilesCommandId` is the discriminator: the daemon
              // attaches it only on the not_found branch, i.e. only when it has
              // established the selected rows are ABSENT, never for a provider
              // error. Combined with an accepted post-click snapshot it says
              // exactly what is needed -- the rows are gone AND newer truth is
              // already on screen -- so the pre-click queue must not return.
              //
              // Only the DECLARATION is taken from the ack here, never its queue
              // contents: a delayed or replayed not-found ack can be stale (its
              // own snapshot rightly rejected), yet it remains truthful about a
              // commandId this client issued. The displayed queue still comes
              // from the snapshot that was actually accepted.
              const appendSuperseded = reconciledMissingAppendCommandIdsRef.current.delete(msg.commandId)
                || (ackReconcilesCommandId === msg.commandId
                  && acceptedQueueSnapshotSeqRef.current > rollback.acceptedSnapshotSeq);
              if (appendSuperseded) {
                // The optimistic post-append array is obsolete, and an EMPTY one
                // hard-overrides the authoritative snapshot instead of merging
                // with it, which would hide a survivor the authority still lists.
                setOptimisticQueuedEntries(null);
              }
              if (!appendSuperseded) {
                // The queue row was moved into the timeline optimistically when
                // the user clicked Append. A genuine provider rejection returns
                // it to the queue, so remove that pending timeline projection in
                // the same reconciliation turn instead of showing it twice. A
                // not-found result superseded by newer authority keeps the row:
                // it may already be delivered and the exact echo/backfill owns
                // its final reconciliation.
                for (const entry of rollback.entries) {
                  onRemoveOptimisticMessage?.(entry.clientMessageId);
                }
                const rollbackQueueIds = new Set(rollback.queue.map((entry) => entry.clientMessageId));
                const restoreAppendQueue = (source: LocalQueuedTransportEntry[]) => [
                  ...rollback.queue,
                  ...source.filter((entry) => !rollbackQueueIds.has(entry.clientMessageId)),
                ];
                const currentQueue = realtimeQueueStateRef.current;
                const restored = restoreAppendQueue(currentQueue.incomingQueuedTransportEntries);
                // Keep the incoming/base order aligned with the optimistic
                // rollback. Merely returning an ordered optimistic array is not
                // enough: the merge map preserves the prior authoritative
                // insertion order for ids that exist in both arrays.
                setRealtimeQueueOverride({
                  sessionName,
                  pendingEntries: restored.filter((entry) => entry.status !== 'failed'),
                  failedEntries: restored.filter((entry) => entry.status === 'failed'),
                  version: currentQueue.incomingQueuedTransportVersion,
                });
                setOptimisticQueuedEntries((prev) => restoreAppendQueue(
                  prev ?? currentQueue.incomingQueuedTransportEntries,
                ));
              }
            }
            if (rollback.type !== 'append') {
              setOptimisticQueuedEntries((prev) => {
                const source = prev ?? realtimeQueueStateRef.current.incomingQueuedTransportEntries;
                if (rollback.type === 'edit') {
                  return source.map((entry) => (
                    entry.clientMessageId === rollback.entry.clientMessageId ? rollback.entry : entry
                  ));
                }
                const sourceIds = new Set(source.map((entry) => entry.clientMessageId));
                return sourceIds.has(rollback.entry.clientMessageId) ? source : [...source, rollback.entry];
              });
            }
            if (rollback.type === 'append') {
              showSendWarning(msg.error || transportQueueAppendFailedLabel);
            }
            queuedMutationRollbackRef.current.delete(msg.commandId);
          } else {
            markLocalQueuedEntry(msg.commandId, 'failed');
          }
        } else {
          reconciledMissingAppendCommandIdsRef.current.delete(msg.commandId);
          failedQueuedCommandIdsRef.current.delete(msg.commandId);
          if (rollback) queuedMutationRollbackRef.current.delete(msg.commandId);
          markLocalQueuedEntry(msg.commandId, 'queued');
        }
        return;
      }
      if (msg.type === MSG_COMMAND_FAILED) {
        if (msg.session && msg.session !== sessionName) return;
        markLocalQueuedEntry(msg.commandId, 'failed');
        return;
      }
      const maybeQueueDelivery = msg as unknown as {
        type?: string;
        sessionName?: string;
        clientMessageId?: string;
      };
      if (maybeQueueDelivery.type === TRANSPORT_QUEUE_DELIVERY_EVENT_TYPE) {
        // The wire validator requires sessionName on delivery facts — a frame
        // without one is malformed and must NOT default to clearing the active
        // session's optimistic entries.
        if (!maybeQueueDelivery.sessionName || maybeQueueDelivery.sessionName !== sessionName) return;
        const clientMessageId = typeof maybeQueueDelivery.clientMessageId === 'string'
          ? maybeQueueDelivery.clientMessageId.trim()
          : '';
        removeLocalQueuedEntry(clientMessageId);
        rememberSettledQueuedId(clientMessageId);
        return;
      }
      if (msg.type !== 'timeline.event') return;
      const event = msg.event;
      if (event.sessionId !== sessionName) return;
      if (event.type === 'user.message') {
        const clientMessageId = typeof event.payload.clientMessageId === 'string' ? event.payload.clientMessageId : '';
        const commandId = typeof event.payload.commandId === 'string' ? event.payload.commandId : '';
        const deliveredText = typeof event.payload.text === 'string' ? event.payload.text : undefined;
        // Settle/remove by BOTH ids. Queue entries — the authoritative snapshot
        // AND the realtime override — are keyed by clientMessageId, but the
        // recovery/resend drain path emits a user.message carrying BOTH commandId
        // and clientMessageId where commandId != clientMessageId. Settling only
        // commandId (the old behavior) missed the clientMessageId-keyed entries,
        // so a message that had already drained into the timeline stayed in the
        // queue card until the window remounted — the '不切窗口不清空' regression
        // once stale turns began draining via the recovery path.
        const idsToSettle = [clientMessageId, commandId].filter((v): v is string => !!v);
        for (const id of idsToSettle) {
          removeLocalQueuedEntry(id, deliveredText);
          rememberSettledQueuedId(id);
        }
      } else if (event.type === TRANSPORT_QUEUE_DELIVERY_EVENT_TYPE) {
        const payload = event.payload as Record<string, unknown>;
        const clientMessageId = typeof payload.clientMessageId === 'string' ? payload.clientMessageId.trim() : '';
        removeLocalQueuedEntry(clientMessageId);
        rememberSettledQueuedId(clientMessageId);
      } else if (event.type === 'session.state') {
        const payload = event.payload as Record<string, unknown>;
        const hasPendingSnapshot = applyRealtimeQueueSnapshot(payload, sessionName);
        const queuedEntries = normalizeTransportPendingEntries(
          payload.pendingMessageEntries,
          undefined,
          sessionName,
          { hasEntriesField: Object.prototype.hasOwnProperty.call(payload, 'pendingMessageEntries') },
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
    };
    return ws.onMessage(handleRealtimeQueueMessage);
  }, [activeSession?.name, onRemoveOptimisticMessage, showAppendSuccessNotice, showSendWarning, transportQueueAppendFailedLabel, ws]);

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
    openSpecTaskStatsRequestIdRef.current = null;
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
      if (
        modelOpen
        && modelRef.current
        && !modelRef.current.contains(target)
        && !modelDropdownRef.current?.contains(target)
      ) {
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
        setOpenSpecExecuteMenu(null);
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

  const quickAutoModeClass = quickSupervisionMode === SUPERVISION_MODE.SUPERVISED
    ? 'shortcut-btn-auto-supervised shortcut-btn-auto-active'
    : quickSupervisionMode === SUPERVISION_MODE.SUPERVISED_AUDIT
      ? 'shortcut-btn-auto-audit shortcut-btn-auto-active'
      : 'shortcut-btn-auto-off';
  const quickSupervisionLabel = quickSupervisionMode === SUPERVISION_MODE.SUPERVISED
    ? t('session.supervision.mode.supervised')
    : quickSupervisionMode === SUPERVISION_MODE.SUPERVISED_AUDIT
      ? t('session.supervision.quickAuditLabel')
      : t('session.supervision.quickLabel');

  const persistTransportConfig = useCallback(async (supervision: Partial<SessionSupervisionSnapshot>) => {
    if (!serverId || !activeSession) return;
    const persistedTransportConfig = await patchSessionSupervision(serverId, activeSession.name, supervision);
    setLocalTransportConfig(persistedTransportConfig);
    onTransportConfigSaved?.(persistedTransportConfig);
  }, [activeSession, onTransportConfigSaved, serverId]);

  const handleQuickSupervisionModeSelect = useCallback(async (nextMode: SupervisionMode) => {
    if (!activeSession || !serverId || !canQuickControlSupervision) return;

    const openSettingsForMode = () => {
      setAutoOpen(false);
      onSettings?.({
        surface: 'supervision',
        ...(nextMode === SUPERVISION_MODE.SUPERVISED_AUDIT
          ? { supervisionMode: SUPERVISION_MODE.SUPERVISED_AUDIT }
          : {}),
      });
    };

    if (nextMode === SUPERVISION_MODE.OFF) {
      const nextSnapshot = supervisionSnapshot
        ? (() => {
            const {
              auditTargetSessionName: _legacyTarget,
              auditTargetFingerprint: _legacyFingerprint,
              peerAuditPromptVersion: _legacyPrompt,
              ...automaticSnapshot
            } = supervisionSnapshot;
            return { ...automaticSnapshot, mode: SUPERVISION_MODE.OFF };
          })()
        : { mode: SUPERVISION_MODE.OFF };
      try {
        await persistTransportConfig(nextSnapshot);
        setAutoOpen(false);
        showSupervisionModeNotice(nextMode);
      } catch {
        showSendWarning(t('session.supervision.modeSaveFailed'));
      }
      return;
    }

    // Share-scoped rows never see the owner's actual stored snapshot (see
    // `quickSupervisionMode` above), so `supervisionSnapshot` is always empty
    // here and the branch below falls through to `supervisorDefaultsPref`,
    // the owner's account-level runtime config exposed read/write to a
    // participant via the scoped defaults endpoint. The server independently
    // re-derives its own authoritative existing-snapshot merge (or accepts
    // this as a fresh config when the session was never configured before),
    // so a participant can never overwrite fields it cannot see.
    if (hasInvalidSupervisionConfig) {
      openSettingsForMode();
      return;
    }

    let nextSnapshot: Partial<SessionSupervisionSnapshot> | null = null;
    if (supervisionSnapshot) {
      const {
        auditTargetSessionName: _legacyTarget,
        auditTargetFingerprint: _legacyFingerprint,
        peerAuditPromptVersion: _legacyPrompt,
        ...automaticSnapshot
      } = supervisionSnapshot;
      nextSnapshot = { ...automaticSnapshot, mode: nextMode };
    } else {
      const defaults = supervisorDefaultsPref.value ?? (supervisorDefaultsPref.loaded ? null : await supervisorDefaultsPref.reload());
      if (!defaults) {
        openSettingsForMode();
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
        // Carry the configured pools through. Dropping them here would both
        // lose the operator's choice and make the pool gate below unsatisfiable
        // for any session enabled straight from defaults.
        executionPools: defaults.executionPools,
      };
    }

    // Fail closed on execution pools, asking the SAME shared question the
    // authoritative save entry asks, so the toggle can never enable a mode the
    // server will refuse. Guidance is already localized in shared/, so it is
    // not restated here as seven more web-only strings.
    const poolGate = evaluateAutomaticSupervisionEnablement({
      mode: nextMode,
      executionPools: (nextSnapshot as Partial<SessionSupervisionSnapshot>)?.executionPools ?? null,
      uiLocale: i18n?.resolvedLanguage ?? i18n?.language,
    });
    if (!poolGate.ok) {
      showSendWarning(poolGate.guidance);
      openSettingsForMode();
      return;
    }

    try {
      await persistTransportConfig(nextSnapshot);
      setAutoOpen(false);
      showSupervisionModeNotice(nextMode);
    } catch {
      showSendWarning(t('session.supervision.modeSaveFailed'));
    }
  }, [
    activeSession,
    canQuickControlSupervision,
    currentTransportConfig,
    hasInvalidSupervisionConfig,
    onSettings,
    persistTransportConfig,
    serverId,
    showSendWarning,
    showSupervisionModeNotice,
    supervisionSnapshot,
    supervisorDefaultsPref.loaded,
    supervisorDefaultsPref.reload,
    supervisorDefaultsPref.value,
    t,
  ]);

  const getText = () => (divRef.current ? readComposerElementText(divRef.current) : '').trim();

  const getCaretLineBoundary = (direction: 'up' | 'down') => (
    isCaretAtComposerLineBoundary(divRef.current, direction)
  );

  const syncHistoryEditOrDraft = useCallback((text: string, history?: readonly string[]) => {
    const idx = histIdxRef.current;
    if (idx === -1) {
      draftRef.current = text;
      return;
    }
    const original = history?.[idx];
    if (original !== undefined && text === original) {
      historyEditsRef.current.delete(idx);
    } else {
      historyEditsRef.current.set(idx, text);
    }
  }, []);

  const syncMobileComposerMetrics = useCallback(() => {
    if (typeof window === 'undefined' || window.innerWidth > 640) {
      setMobileComposerMultiline(false);
      return;
    }
    // Skip the reflow while an IME is composing: reading scrollHeight to flip the
    // multiline class realigns the composer box, which displaces the caret on
    // every compositionupdate / candidate-bar toggle (a major "focus jumps"
    // cause when typing CJK). The `input` event fired after `compositionend`
    // (imeComposingRef already false) runs the deferred final sync.
    if (imeComposingRef.current || mobileComposerExpandedRef.current) return;
    const root = divRef.current;
    if (!root) return;
    const computed = window.getComputedStyle(root);
    const lineHeight = Number.parseFloat(computed.lineHeight || '') || 20;
    const verticalPadding = (Number.parseFloat(computed.paddingTop || '') || 0)
      + (Number.parseFloat(computed.paddingBottom || '') || 0);
    // When real styles are active (verticalPadding > 0) and the composer has no
    // child nodes at all, empty placeholder text must never trigger multiline.
    // (Keeps unstyled jsdom metric mocks where verticalPadding === 0 intact.)
    if (verticalPadding > 0 && root.childNodes.length === 0) {
      setMobileComposerMultiline(false);
      return;
    }
    const currentHasText = !!readComposerElementText(root).trim();
    const singleLineTrailingCount = serverId
      ? (VoiceInput.isAvailable() && (inlineDesktopVoiceRef.current || !currentHasText) ? 2 : 1)
      : 0;
    // Require real second-line clearance beyond single-line font/ascender/subpixel
    // variance (mobile 16px * 1.45 = 23.2px + 14px padding = 37.2px for 1 line vs
    // 60.4px for 2 lines; ~52.3px avoids both false positives and late flips).
    const multilineThreshold = lineHeight + verticalPadding + Math.max(lineHeight * 0.65, 12);
    let measuredScrollHeight = root.scrollHeight;
    if (singleLineTrailingCount > 0) {
      // Measure against the single-line trailing padding so removing the embedded
      // attachment button in multiline mode does not reclaim padding-right width
      // and cause single/multiline oscillation near the right edge.
      const desiredClass = `controls-input-with-trailing-${singleLineTrailingCount}`;
      const hasTrailing = root.classList.contains('controls-input-with-trailing');
      const hasDesired = root.classList.contains(desiredClass);
      const otherClass = singleLineTrailingCount === 1
        ? 'controls-input-with-trailing-2'
        : 'controls-input-with-trailing-1';
      const hasOther = root.classList.contains(otherClass);
      if (!hasTrailing || !hasDesired || hasOther) {
        const prevClassName = root.className;
        root.classList.remove('controls-input-with-trailing-1', 'controls-input-with-trailing-2');
        root.classList.add('controls-input-with-trailing', desiredClass);
        try {
          measuredScrollHeight = root.scrollHeight;
        } finally {
          root.className = prevClassName;
        }
      }
    }
    setMobileComposerMultiline(measuredScrollHeight > multilineThreshold);
  }, [serverId]);

  const fillInput = useCallback((text: string) => {
    if (divRef.current) {
      setComposerElementText(divRef.current, text);
      focusComposerForTyping({ moveCursorToEnd: true });
    }
    setHasText(!!text.trim());
    publishComposerText(text);
    syncMobileComposerMetrics();
  }, [focusComposerForTyping, publishComposerText, syncMobileComposerMetrics]);

  const selectQuickSuggestion = (value: string) => {
    const activeHistory = getNavigableHistory(
      quickData.data,
      activeSessionIncognito ? undefined : activeSession?.name,
    );
    if (quickSuggestionKind === 'command' && value.toLocaleLowerCase() === SESSION_MODEL_COMMAND) {
      const nextValue = `${SESSION_MODEL_COMMAND} `;
      setQuickSuggestionKind('model');
      setQuickSuggestionQuery('');
      setQuickSuggestionHighlightIdx(0);
      fillInput(nextValue);
      syncHistoryEditOrDraft(nextValue, activeHistory);
      if (supportsDynamicTransportModels(activeSession?.agentType)) {
        dynamicTransportModels.refresh();
      }
      return;
    }
    const nextValue = quickSuggestionKind === 'model' ? `${SESSION_MODEL_COMMAND} ${value}` : value;
    setQuickSuggestionKind(null);
    setQuickSuggestionQuery('');
    fillInput(nextValue);
    syncHistoryEditOrDraft(nextValue, activeHistory);
  };

  const selectSkillSuggestion = useCallback((skill: AgentSkillEntry) => {
    const current = divRef.current ? readComposerElementText(divRef.current) : '';
    const before = current.replace(/(?:^|\s)\$[a-z0-9._-]*$/iu, (match) => match.startsWith(' ') ? ' ' : '');
    fillInput(`${before}${before && !before.endsWith(' ') ? ' ' : ''}${buildAgentSkillMarker(skill)} `);
    closeQuickSuggestions();
  }, [closeQuickSuggestions]);

  const appendToInput = (paths: string[]) => {
    if (!paths.length) return;
    closeQuickSuggestions();
    const suffix = paths.join(' ');
    let nextText = suffix;
    if (divRef.current) {
      const current = readComposerElementText(divRef.current);
      nextText = current ? `${current} ${suffix}` : suffix;
      setComposerElementText(divRef.current, nextText);
      focusComposerForTyping({ moveCursorToEnd: true });
    }
    setHasText(true);
    publishComposerText(nextText);
    syncMobileComposerMetrics();
  };

  /**
   * Insert a `;;(name)` alias marker at the caret via the shared, value-secret
   * helper (never the resolved value; never sends). When the inline `;query`
   * fragment is still present at the end of the composer (the inline `;`
   * autocomplete path), it is stripped first so we don't leave a stray `;dep`
   * before the inserted marker. Used by both the inline picker and the
   * `@别名` category.
   */
  const insertAliasMarker = useCallback((name: string) => {
    const el = divRef.current;
    if (el) {
      const current = readComposerElementText(el);
      // Strip a trailing inline `;query` fragment (the inline `;` autocomplete
      // path), keeping any boundary whitespace that preceded the `;`. When no
      // such fragment is present (the `@别名` path), the text is unchanged.
      const stripped = current.replace(/(^|\s);[\p{L}\p{N}._-]{0,20}$/u, (_m, lead: string) => lead);
      setComposerElementText(el, stripped);
      focusComposerForTyping({ moveCursorToEnd: true });
    }
    insertAliasMarkerAtCaret(name);
    const nextText = el ? readComposerElementText(el) : '';
    setHasText(!!nextText.trim());
    publishComposerText(nextText);
    syncMobileComposerMetrics();
  }, [focusComposerForTyping, publishComposerText, syncMobileComposerMetrics]);

  const insertTaskPairReference = useCallback((title: string) => {
    const el = divRef.current;
    const current = el ? readComposerElementText(el) : '';
    fillInput(replaceTaskPairReferenceTrigger(current, title));
  }, [fillInput]);

  const insertCloudDocReference = useCallback((doc: { id: string; name: string }) => {
    const el = divRef.current;
    const current = el ? readComposerElementText(el) : '';
    fillInput(replaceInlineCloudDocTrigger(current, doc));
  }, [fillInput]);

  /**
   * Insert a `^^(nodeId)-(displayName)` machine reference at the caret via the
   * shared helper (stable marker plus render-only note; never resolves or sends),
   * mirroring `insertAliasMarker`.
   * When the inline `^query` fragment is still present at the end of the composer
   * (the inline `^` autocomplete path), it is stripped first so we don't leave a
   * stray `^dep` before the inserted marker. Used by both the inline picker and
   * the `@machine` category.
   */
  const insertMachineMarker = useCallback((nodeId: string, displayName: string) => {
    const el = divRef.current;
    if (el) {
      const current = readComposerElementText(el);
      // Strip a trailing inline `^query` fragment (the inline `^` autocomplete
      // path), keeping any boundary whitespace. When no such fragment is present
      // (the `@machine` path), the text is unchanged.
      const stripped = stripInlineMachineTrigger(current);
      setComposerElementText(el, stripped);
      focusComposerForTyping({ moveCursorToEnd: true });
    }
    insertMachineMarkerAtCaret(nodeId, displayName);
    const nextText = el ? readComposerElementText(el) : '';
    setHasText(!!nextText.trim());
    publishComposerText(nextText);
    syncMobileComposerMetrics();
  }, [focusComposerForTyping, publishComposerText, syncMobileComposerMetrics]);

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
    const cwd = activeSession?.projectDir
      ?? (isShareScopedSession ? FS_SESSION_ROOT_PATH : undefined);
    if (!cwd) return null;
    return `${cwd.replace(/[\\/]+$/, '')}/openspec/changes`;
  }, [activeSession?.projectDir, isShareScopedSession]);
  const openSpecChangeListCacheKey = useMemo(() => (
    openSpecChangesPath ? buildOpenSpecChangeListCacheKey(serverId, openSpecChangesPath) : null
  ), [openSpecChangesPath, serverId]);

  const openOpenSpecChangeFolder = useCallback((changeName: string) => {
    if (!openSpecChangesPath) return;
    setOpenSpecFolderPath(`${openSpecChangesPath}/${changeName}`);
    setOpenSpecAuditMenu(null);
    setOpenSpecProposeMenuOpen(false);
    setOpenSpecExecuteMenu(null);
    setOpenSpecAutoLauncherChange(null);
    setOpenSpecOpen(false);
  }, [openSpecChangesPath]);

  const openOpenSpecAutoLauncher = useCallback((changeName: string) => {
    setOpenSpecAuditMenu(null);
    setOpenSpecProposeMenuOpen(false);
    setOpenSpecExecuteMenu(null);
    setOpenSpecAutoLauncherChange(changeName);
  }, []);

  const launchOpenSpecAutoDeliver = useCallback((changeName: string, presetId: OpenSpecAutoDeliverPresetId, options?: {
    selectedTeamComboId: string;
    materializedLimits: OpenSpecAutoDeliverMaterializedLimits;
    locale?: string;
    autoCommitPush: boolean;
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
    openSpecTaskStatsRequestIdRef.current = null;
    if (!ws || !openSpecChangesPath) {
      setOpenSpecLoading(false);
      setOpenSpecChanges([]);
      setOpenSpecError(null);
      return;
    }
    const cached = openSpecChangeListCacheKey
      ? openSpecChangeListCacheRef.current.get(openSpecChangeListCacheKey)
      : undefined;
    if (cached) {
      setOpenSpecChanges(cached.changes);
    }
    setOpenSpecLoading(true);
    setOpenSpecError(null);
    let requestId: string;
    try {
      requestId = ws.fsListDir(openSpecChangesPath, false, false);
    } catch {
      setOpenSpecLoading(false);
      if (!cached) setOpenSpecChanges([]);
      setOpenSpecError(t('openspec.load_unavailable'));
      return;
    }
    openSpecRequestIdRef.current = requestId;
    openSpecRequestTimerRef.current = setTimeout(() => {
      if (openSpecRequestIdRef.current !== requestId) return;
      openSpecRequestIdRef.current = null;
      openSpecTaskStatsRequestIdRef.current = null;
      openSpecRequestTimerRef.current = null;
      setOpenSpecLoading(false);
      if (!cached) setOpenSpecChanges([]);
      setOpenSpecError(t('openspec.load_timeout'));
    }, OPENSPEC_LIST_REQUEST_TIMEOUT_MS);
  }, [clearOpenSpecRequestTimer, openSpecChangeListCacheKey, openSpecChangesPath, t, ws]);

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
      return { position: 'fixed', bottom: '60px', right: '12px', maxHeight: 'calc(var(--imcodes-ui-vh, 100vh) * 0.6)', zIndex: 2147483646 } as const;
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
                openSpecTaskStatsRequestIdRef.current = null;
                setOpenSpecLoading(false);
                setOpenSpecOpen(false);
                setOpenSpecAuditMenu(null);
                setOpenSpecProposeMenuOpen(false);
                setOpenSpecExecuteMenu(null);
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

  useEffect(() => {
    if (!modelOpen || typeof window === 'undefined') return;
    const refreshLayout = () => setModelLayoutTick((tick) => tick + 1);
    const viewport = window.visualViewport;
    window.addEventListener('resize', refreshLayout);
    window.addEventListener('scroll', refreshLayout, true);
    viewport?.addEventListener('resize', refreshLayout);
    viewport?.addEventListener('scroll', refreshLayout);
    return () => {
      window.removeEventListener('resize', refreshLayout);
      window.removeEventListener('scroll', refreshLayout, true);
      viewport?.removeEventListener('resize', refreshLayout);
      viewport?.removeEventListener('scroll', refreshLayout);
    };
  }, [modelOpen]);

  const modelDropdownStyle = useMemo((): JSX.CSSProperties | undefined => {
    if (!modelOpen || typeof window === 'undefined') return undefined;
    const trigger = modelButtonRef.current ?? modelRef.current;
    if (!trigger) return undefined;
    const rect = trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    return computeModelDropdownStyle(rect, {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      visualViewportWidth: viewport?.width,
      visualViewportHeight: viewport?.height,
      visualViewportOffsetTop: viewport?.offsetTop,
      safeAreaTop: readSafeAreaTopPx(),
      safeAreaBottom: readSafeAreaBottomPx(),
    });
  }, [modelLayoutTick, modelOpen]);

  const renderModelDropdown = useCallback((content: ComponentChildren) => {
    const dropdown = (
      <div
        class="menu-dropdown menu-dropdown-models"
        ref={modelDropdownRef}
        style={modelDropdownStyle}
      >
        {content}
      </div>
    );
    if (typeof document !== 'undefined') {
      return createPortal(dropdown, document.body);
    }
    return dropdown;
  }, [modelDropdownStyle]);

  const activeSub = (subSessions ?? []).find((s) => s.sessionName === activeSession?.name);
  const rootSession = activeSub?.parentSession || activeSession?.name || '';
  const quickDelegationTeamMembers = useMemo(() => new Set(
    p2pSavedConfig?.sessions
      ? getEnabledP2pMemberNames(p2pSavedConfig.sessions, { scopeSession: rootSession })
      : [],
  ), [p2pSavedConfig, rootSession]);
  const quickDelegationCandidates = useMemo<QuickAgentDelegationCandidate[]>(() => {
    // Match the ordinary @agent picker: the current root session and its
    // direct sub-sessions form one delegation group. `session.project` is not
    // a safe UI scope here because daemon worker records can share the project
    // name while belonging to hidden/legacy session generations.
    if (!activeSession?.name || !rootSession) return [];
    const byName = new Map<string, QuickAgentDelegationCandidate>();
    const add = (candidate: QuickAgentDelegationCandidate) => {
      if (candidate.sessionName === activeSession?.name) return;
      if (candidate.agentType === 'shell' || candidate.agentType === 'script') return;
      if (!byName.has(candidate.sessionName)) byName.set(candidate.sessionName, candidate);
    };
    for (const session of sessions ?? []) {
      if (session.name !== rootSession) continue;
      add({
        sessionName: session.name,
        agentType: session.agentType,
        label: session.label,
        model: resolveEffectiveSessionModel(session),
        teamMember: quickDelegationTeamMembers.has(session.name),
      });
    }
    for (const session of subSessions ?? []) {
      if (session.parentSession !== rootSession) continue;
      add({
        sessionName: session.sessionName,
        agentType: session.type,
        label: session.label,
        model: resolveEffectiveSessionModel(session),
        teamMember: quickDelegationTeamMembers.has(session.sessionName),
      });
    }
    return [...byName.values()];
  }, [activeSession?.name, quickDelegationTeamMembers, rootSession, sessions, subSessions]);

  // ── Dedicated execution routing preference ──────────────────────────────
  // Reads the SHARED preference (the same one Team Settings edits). Generic
  // execution dispatch now lives in UsageFooter; SessionControls still
  // consumes the preference for P2P/Team and
  // OpenSpec-specific execution surfaces.
  const executionRouting = useExecutionRouting(serverId ?? null);
  const configuredExecutionSession = executionRouting.templateSessionName;
  const executionSessionDisplayName = useMemo(() => {
    if (!configuredExecutionSession) return null;
    const sub = (subSessions ?? []).find((s) => s.sessionName === configuredExecutionSession);
    if (sub && !isExecutionCloneTemplateLike(sub)) return buildExecutionTemplateLabel({
      shortName: sub.label || sub.sessionName.split('_').pop() || sub.sessionName,
      agentType: sub.type,
      ccPreset: sub.ccPresetId,
      qwenModel: sub.qwenModel,
      requestedModel: sub.requestedModel,
      activeModel: sub.activeModel,
      modelDisplay: sub.modelDisplay,
    });
    return null;
  }, [configuredExecutionSession, subSessions]);
  const hasValidExecutionDefault = Boolean(
    configuredExecutionSession
    && executionSessionDisplayName
    && configuredExecutionSession !== activeSession?.name,
  );

  // ── OpenSpec left-panel Execute dropdown routing (task 2.4) ──────────────
  // Unlike the GENERIC dropdown, the OpenSpec Execute dropdown is an ACTION +
  // contextual-editor surface for the SAME shared dedicated-execution-routing
  // preference. It:
  //   - pins the valid saved execution template session FIRST,
  //   - lists eligible non-current / non-main sub-sessions below it,
  //   - can SET or CLEAR the shared default (clear is allowed HERE per design
  //     Decision 2 — it is NOT allowed in the generic dropdown), and
  //   - dispatches the OpenSpec-specific implement prompt (current change) to a
  //     chosen session.
  // Eligibility is DAEMON-AUTHORITATIVE (`executionTemplateEligible` + reason);
  // the UI renders the flag and never recomputes eligibility client-side. This
  // mirrors the P2pConfigPanel template scan.
  const openSpecExecutionTemplateScan = useMemo(() => {
    const eligible: Array<{ sessionName: string; shortName: string; sdk: string; preset: string | null; model: string | null }> = [];
    const seen = new Set<string>();
    const push = (sessionName: string, shortName: string, sdk: string, preset: string | null, model: string | null) => {
      if (seen.has(sessionName)) return;
      seen.add(sessionName);
      eligible.push({ sessionName, shortName, sdk, preset, model });
    };
    // GROUP-SCOPED: execution targets are attached non-main sub-sessions only.
    // Main sessions (brain/orchestrator/worker `wN`) are not execution templates.
    // Attached sub-sessions of THIS group only (strict parentSession === group root;
    // a sub-session with no/other parent is NOT in the current group and is excluded).
    for (const s of subSessions ?? []) {
      if (OPENSPEC_EXEC_EXCLUDED_TYPES.has(s.type)) continue;
      if (s.sessionName === activeSession?.name) continue;
      if (!rootSession || s.parentSession !== rootSession) continue;
      if (isExecutionCloneTemplateLike(s)) continue;
      if (s.executionTemplateEligible === false) continue;
      push(
        s.sessionName,
        s.label || s.sessionName.split('_').pop() || s.sessionName,
        s.type,
        s.ccPresetId ?? null,
        resolveEffectiveSessionModel(s) ?? null,
      );
    }
    return eligible;
  }, [subSessions, activeSession?.name, rootSession]);

  // The pinned/default item: the saved template, but only when it still resolves
  // to a valid (display-resolvable, non-current) session in this project.
  const openSpecPinnedExecutionSession = useMemo(() => {
    if (!hasValidExecutionDefault || !configuredExecutionSession || !executionSessionDisplayName) return null;
    const sub = (subSessions ?? []).find((s) => s.sessionName === configuredExecutionSession);
    if (!sub || isExecutionCloneTemplateLike(sub)) return null;
    return {
      sessionName: configuredExecutionSession,
      shortName: sub.label || sub.sessionName.split('_').pop() || sub.sessionName,
      sdk: sub.type,
      preset: sub.ccPresetId ?? null,
      model: resolveEffectiveSessionModel(sub) ?? null,
    };
  }, [hasValidExecutionDefault, configuredExecutionSession, executionSessionDisplayName, subSessions]);

  // Eligible sessions to list BELOW the pinned default (de-duplicated against it).
  const openSpecExecutionCandidates = useMemo(() => (
    openSpecExecutionTemplateScan.filter((c) => c.sessionName !== openSpecPinnedExecutionSession?.sessionName)
  ), [openSpecExecutionTemplateScan, openSpecPinnedExecutionSession]);

  // Dispatch the OpenSpec implement prompt for `changeNameArg` to `target`.
  // This is OpenSpec-specific wording (reuses `openspec.implement_prompt`), in
  // contrast to the generic dispatch above. Reuses the plain cross-session send.
  // The change is now always known per-row (passed in by the Execute button).
  const dispatchOpenSpecExecution = useCallback((target: string, changeNameArg: string) => {
    if (!ws || !openSpecChangesPath || !changeNameArg) return;
    const reference = toComposerReference(`${openSpecChangesPath}/${changeNameArg}`);
    const prompt = t('openspec.implement_prompt', { reference });
    ws.sendSessionMessage(target, prompt);
  }, [ws, openSpecChangesPath, toComposerReference, t]);

  // Build the per-change Execute dropdown content. Same dispatch/set-default/
  // clear menu the global footer used to render, but the change is bound per
  // row so there is no "no change selected" state and no disabled guards.
  const buildOpenSpecExecuteMenuContent = useCallback((changeName: string): ComponentChildren => (
    <div role="menu" data-testid={`openspec-execute-menu-${changeName}`}>
      <div class="p2p-menu-section-label">{t('openspec.execute.dispatch_heading')}</div>
      {openSpecPinnedExecutionSession && (
        <button
          type="button"
          role="menuitem"
          class="menu-item openspec-execute-pinned"
          data-testid="openspec-execute-pinned"
          onClick={() => {
            dispatchOpenSpecExecution(openSpecPinnedExecutionSession.sessionName, changeName);
            setOpenSpecExecuteMenu(null);
            setOpenSpecOpen(false);
          }}
        >
          <span aria-hidden="true">★ </span>
          {t('openspec.execute.dispatch_to', { name: formatExecLabel(openSpecPinnedExecutionSession.shortName, openSpecPinnedExecutionSession.sdk, openSpecPinnedExecutionSession.preset, openSpecPinnedExecutionSession.model) })}
        </button>
      )}
      {openSpecExecutionCandidates.map((candidate) => (
        <button
          key={candidate.sessionName}
          type="button"
          role="menuitem"
          class="menu-item"
          data-testid={`openspec-execute-session-${candidate.sessionName}`}
          onClick={() => {
            dispatchOpenSpecExecution(candidate.sessionName, changeName);
            setOpenSpecExecuteMenu(null);
            setOpenSpecOpen(false);
          }}
        >
          {t('openspec.execute.dispatch_to', { name: formatExecLabel(candidate.shortName, candidate.sdk, candidate.preset, candidate.model) })}
        </button>
      ))}
      {!openSpecPinnedExecutionSession && openSpecExecutionCandidates.length === 0 && (
        <div class="p2p-menu-section-label openspec-section-meta" data-testid="openspec-execute-empty">
          {t('openspec.execute.no_sessions')}
        </div>
      )}
      <div class="openspec-execute-divider" role="separator" />
      <div class="p2p-menu-section-label">{t('openspec.execute.default_heading')}</div>
      {openSpecExecutionCandidates.map((candidate) => (
        <button
          key={`set-${candidate.sessionName}`}
          type="button"
          role="menuitem"
          class="menu-item"
          data-testid={`openspec-execute-set-${candidate.sessionName}`}
          onClick={() => {
            void executionRouting.setTemplateSessionName(candidate.sessionName);
            setOpenSpecExecuteMenu(null);
          }}
        >
          {t('openspec.execute.set_default', { name: formatExecLabel(candidate.shortName, candidate.sdk, candidate.preset, candidate.model) })}
        </button>
      ))}
      {openSpecPinnedExecutionSession && (
        <button
          type="button"
          role="menuitem"
          class="menu-item openspec-execute-clear"
          data-testid="openspec-execute-clear"
          onClick={() => {
            void executionRouting.setTemplateSessionName(null);
            setOpenSpecExecuteMenu(null);
          }}
        >
          {t('openspec.execute.clear_default')}
        </button>
      )}
    </div>
  ), [t, openSpecPinnedExecutionSession, openSpecExecutionCandidates, dispatchOpenSpecExecution, executionRouting]);

  const hasConfiguredP2pParticipants = useMemo(() => {
    if (!p2pSavedConfig?.sessions) return false;
    return getEnabledP2pMemberNames(p2pSavedConfig.sessions, { scopeSession: rootSession }).length > 0;
  }, [p2pSavedConfig, rootSession]);

  // A session that is itself an enabled P2P participant ("member") must not
  // start its own Team discussion from its Team dropdown — discussions spawn
  // their own sub-sessions, so a member launching one would nest the team
  // under a participant. The host/root session (the launcher) is never a
  // member. When this is true we reject the combo/workflow launch and steer
  // the user to start the discussion from another (non-member) session.
  const isCurrentSessionP2pMember = useMemo(() => {
    const name = activeSession?.name;
    if (!name || name === rootSession) return false;
    const entry = sanitizeP2pSavedConfig(p2pSavedConfig ?? { sessions: {}, rounds: 1 }, { scopeSession: rootSession }).sessions[name];
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
    if (!ws || !canSharedSessionSend) return Promise.resolve({ ok: false, error: P2P_CONFIG_ERROR.SAVE_TIMEOUT });
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
  }, [canSharedSessionSend, resolvePendingP2pConfigSave, ws]);

  const handleP2pDropdownRoundsChange = useCallback((nextRounds: number) => {
    const cfg: P2pSavedConfig = sanitizeP2pSavedConfig({
      ...(p2pSavedConfig ?? { sessions: {}, rounds: 1 }),
      rounds: nextRounds,
      updatedAt: Date.now(),
    }, { scopeSession: rootSession });
    setP2pSavedConfig(cfg);
    void p2pSavedConfigPref.save(cfg).catch(() => {});
    if (rootSession) {
      void persistP2pConfigToDaemon(rootSession, cfg, { awaitAck: false });
    }
  }, [p2pSavedConfig, p2pSavedConfigPref, persistP2pConfigToDaemon, rootSession]);

  useEffect(() => {
    setP2pSavedConfig(p2pSavedConfigPref.value
      ? sanitizeP2pSavedConfig(p2pSavedConfigPref.value, { scopeSession: rootSession })
      : null);
  }, [p2pSavedConfigPref.value, rootSession]);

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
          openSpecTaskStatsRequestIdRef.current = null;
          setOpenSpecLoading(false);
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
      if (msg.type !== 'fs.ls_response') return;
      const statsRequestId = openSpecTaskStatsRequestIdRef.current;
      if (statsRequestId && msg.requestId === statsRequestId) {
        openSpecTaskStatsRequestIdRef.current = null;
        if (msg.status !== 'ok') return;
        const stats = collectOpenSpecTaskStats(msg.entries);
        if (openSpecChangesPath && stats.size > 0) {
          for (const [changeName, taskStats] of stats.entries()) {
            openSpecTaskStatsCacheRef.current.set(openSpecTaskStatsCacheKey(openSpecChangesPath, changeName), taskStats);
          }
        }
        setOpenSpecChanges((current) => {
          const next = mergeOpenSpecTaskStats(current, stats);
          if (openSpecChangeListCacheKey && next.length > 0) {
            openSpecChangeListCacheRef.current.set(openSpecChangeListCacheKey, { changes: next });
          }
          return next;
        });
        return;
      }
      const requestId = openSpecRequestIdRef.current;
      if (!requestId || msg.requestId !== requestId) return;
      openSpecRequestIdRef.current = null;
      clearOpenSpecRequestTimer();
      setOpenSpecLoading(false);
      if (msg.status === 'error') {
        const errorText = msg.error ?? null;
        if (errorText === FS_READ_ERROR_CODES.FORBIDDEN_PATH || /enoent|not found|no such file/i.test(errorText ?? '')) {
          if (openSpecChangeListCacheKey) openSpecChangeListCacheRef.current.delete(openSpecChangeListCacheKey);
          setOpenSpecChanges([]);
          setOpenSpecError(null);
          return;
        }
        setOpenSpecError(formatOpenSpecLoadError(errorText));
        return;
      }
      const changes = (msg.entries ?? [])
        .filter((entry) => entry.isDir && !OPENSPEC_NON_CHANGE_DIR_NAMES.has(entry.name))
        .map((entry) => ({
          name: entry.name,
          taskStats: openSpecChangesPath
            ? openSpecTaskStatsCacheRef.current.get(openSpecTaskStatsCacheKey(openSpecChangesPath, entry.name))
            : undefined,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      setOpenSpecChanges(changes);
      if (openSpecChangeListCacheKey) {
        openSpecChangeListCacheRef.current.set(openSpecChangeListCacheKey, { changes });
      }
      setOpenSpecError(null);
      if (ws && openSpecChangesPath && changes.length > 0) {
        try {
          openSpecTaskStatsRequestIdRef.current = ws.fsListDir(openSpecChangesPath, false, false, { includeOpenSpecTaskStats: true });
        } catch {
          openSpecTaskStatsRequestIdRef.current = null;
        }
      }
    });
  }, [clearOpenSpecRequestTimer, formatOpenSpecLoadError, openSpecChangeListCacheKey, openSpecChangesPath, openSpecOpen, persistP2pConfigToDaemon, p2pSavedConfig, refreshOpenSpecChanges, rejectAllPendingP2pConfigSaves, resolvePendingP2pConfigSave, rootSession, serverId, t, ws]);

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

  const buildDelegateLabel = useCallback((session: string) => {
    const sub = (subSessions ?? []).find(s => s.sessionName === session);
    const main = (sessions ?? []).find(s => s.name === session);
    return sub?.label || main?.label || session.replace(/^deck_sub_/, '').split('_').pop() || session;
  }, [sessions, subSessions]);

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
    const selection = buildP2pConfigSelection(sanitizeP2pSavedConfig(p2pSavedConfig, { scopeSession: rootSession }), mode);
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
  }, [activeSession?.name, activeSession?.projectDir, i18n?.language, p2pSavedConfig, rootSession, ws]);

  const buildSendPayload = useCallback((options?: string | BuildSendPayloadOptions): PendingSendPayload | null => {
    const normalizedOptions: BuildSendPayloadOptions =
      typeof options === 'string' ? { modeOverride: options } : (options ?? {});
    let text = normalizedOptions.textOverride ?? getText();
    // Capture the user's OWN composed body BEFORE any synthetic @-prefix,
    // delegation/P2P rewrite, quote block, or attachment refs are concatenated.
    // Alias markers (A′) resolve against THIS body only — a `;;(secret)` buried
    // in a quoted historical message or attachment path must never pull the
    // current user's alias value into resolvedAliases (audit finding Cx1-3).
    const composerBody = text;
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
    if (((!text && attachments.length === 0 && !pendingDelegateTarget) && !allowEmptyCombo) || !activeSession) return null;

    // Build P2P routing as structured WS fields — keep text clean for display.
    const extra: Record<string, unknown> = {};
    const pendingTargets = normalizedOptions.syntheticAtTargets
      ? [...normalizedOptions.syntheticAtTargets]
      : [...pendingAtTargetsRef.current];

    let delegation: PendingSendPayload['delegation'];
    if (pendingDelegateTarget && !normalizedOptions.syntheticAtTargets) {
      const task = text.trim();
      delegation = {
        targetSession: pendingDelegateTarget.session,
        targetLabel: pendingDelegateTarget.label,
        task,
      };
      text = buildAgentDelegationOrchestrationPrompt({
        targetSession: pendingDelegateTarget.session,
        targetLabel: pendingDelegateTarget.label,
        task,
        uiLocale: i18n.resolvedLanguage ?? i18n.language,
      });
    } else if (pendingTargets.length > 0) {
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
        const cfg = override?.config
          ? sanitizeP2pSavedConfig(override.config, { scopeSession: rootSession })
          : (p2pSavedConfig ? sanitizeP2pSavedConfig(p2pSavedConfig, { scopeSession: rootSession }) : null);
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
      // Dedicated execution routing (task 2.7): forward the resolved per-project
      // routing preference so the daemon final-execution stage can delegate
      // implementation work to an ephemeral execution clone. Disabled/absent
      // keeps the run's existing in-session execution path byte-identical.
      // Carry the resolved global limits alongside the template identity so the
      // daemon normalizer can honor user-configured caps/timeouts instead of
      // falling back to fixed defaults (item 14).
      if (executionRouting.enabled && executionRouting.templateSessionName) {
        extra.dedicatedExecutionRouting = {
          enabled: true,
          templateSessionName: executionRouting.templateSessionName,
          maxParallelClones: executionRouting.limits.maxParallelClones,
          maxQueuedClones: executionRouting.limits.maxQueuedClones,
          cloneHardTimeoutMs: executionRouting.limits.cloneHardTimeoutMs,
          cloneRetentionMs: executionRouting.limits.cloneRetentionMs,
        };
      }
    }

    if (isShellLike) {
      extra.verbatim = true;
    }

    // Prepend quotes (delegation sends must be a clean task only; validation blocks quotes).
    const effectiveQuotes = [
      ...(quotes ?? []),
      ...(taskQuote ? [taskQuote] : []),
    ];
    if (!pendingDelegateTarget && effectiveQuotes.length > 0 && !isShellLike) {
      const quoteBlock = effectiveQuotes.map((q) => `> ${q.replace(/\n/g, '\n> ')}`).join('\n\n');
      text = text ? `${quoteBlock}\n\n${text}` : quoteBlock;
    }
    // Prepend attachment references.
    // R3 v2 PR-ρ/υ — Keep the compact user-facing tag (`#1`, `#2`, ...)
    // but map it to the full daemon path, not just the display filename.
    // The path is what the receiving LLM can actually open.
    if (!pendingDelegateTarget && attachments.length > 0) {
      if (!isShellLike) {
        const refs = attachments.map((a) => `#${a.seq}:(${a.path})`).join(' ');
        text = text ? `${refs} ${text}` : refs;
      } else if (!text) {
        text = attachments.map((a) => a.path).join(' ');
      }
    }
    // Compose-time alias resolution (A′). Resolve ONLY against the user's own
    // composed body (`composerBody`) — NOT the concatenated `text` that now also
    // carries quotes / attachment refs / synthetic prefixes — so a `;;(secret)`
    // inside quoted history or an attachment path can't leak the current user's
    // alias value (Cx1-3). The final `text` keeps its markers as-is; the map
    // rides in `extra` so it reaches the daemon via BOTH the WS send and the
    // HTTP fallback (see sendSessionMessage), but never the composer or the
    // optimistic/timeline user bubble. Attached only when a marker actually
    // resolved, so ordinary sends stay byte-identical.
    //
    // Fail-safe (Cx1-4): if the body references markers but the alias list is
    // not successfully loaded (still loading or errored), do NOT send a stale/
    // empty map — that would silently deliver literal markers. Block with a
    // recoverable inline warning and kick off a refetch instead.
    if (parseAliasMarkers(composerBody).length > 0 && (!aliasLoaded || aliasError != null)) {
      showSendWarning(t('alias.error.list_unavailable'));
      refetchAliases();
      return null;
    }
    Object.assign(extra, buildAliasSendExtra(composerBody, aliasAll));
    // Compose-time machine resolution (out-of-band `resolvedMachines` hint).
    // Resolved against the user's own composed body only (parity with aliases).
    // No fail-closed gate: an unresolved `^^(name)` marker stays literal/visible
    // and is simply not resolved — the server re-validates every serverId.
    Object.assign(extra, buildMachineSendExtra(composerBody, machineAll));
    return { text, extra, ...(delegation ? { delegation } : {}) };
  }, [activeSession, aliasAll, aliasError, aliasLoaded, isShellLike, machineAll, applySavedP2pConfigSelection, attachments, pendingDelegateTarget, executionRouting.enabled, executionRouting.templateSessionName, executionRouting.limits, i18n?.language, onRemoveQuote, onRemoveTaskQuote, p2pExcludeSameType, p2pMode, p2pSavedConfig, quotes, refetchAliases, rootSession, sessions, showSendWarning, subSessions, t, taskQuote]);

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

    // Compose-time alias resolution (A′) — same contract + fail-safe as
    // buildSendPayload. `cleanText` is the user's body with @-targets stripped;
    // there are no quotes/attachments on this path, so it IS the composed body.
    if (parseAliasMarkers(cleanText).length > 0 && (!aliasLoaded || aliasError != null)) {
      showSendWarning(t('alias.error.list_unavailable'));
      refetchAliases();
      return null;
    }
    Object.assign(extra, buildAliasSendExtra(cleanText, aliasAll));
    // Compose-time machine resolution — same contract as buildSendPayload, no
    // fail-closed gate (unresolved markers stay literal).
    Object.assign(extra, buildMachineSendExtra(cleanText, machineAll));
    return { text: cleanText, extra };
  }, [activeSession, aliasAll, aliasError, aliasLoaded, machineAll, applySavedP2pConfigSelection, i18n?.language, p2pExcludeSameType, p2pMode, p2pSavedConfig, refetchAliases, sessions, showSendWarning, subSessions, t]);

  const makeCommandId = useCallback(() => (
    globalThis.crypto?.randomUUID?.() ?? `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`
  ), []);

  const cancelActiveTransportTurn = useCallback((commandId = makeCommandId(), stopQueueIds?: string[]): string | null => {
    if (!activeSession) return null;
    trackShareCancelCommand(commandId);
    const payload = {
      sessionName: activeSession.name,
      commandId,
      ...(stopQueueIds ? { [TRANSPORT_STOP_QUEUE_FIELDS.IDS]: stopQueueIds } : {}),
      ...(activeSession.sharedState?.activeDispatchId ? { observedDispatchId: activeSession.sharedState.activeDispatchId } : {}),
    };
    if (!ws) {
      if (!serverId) return null;
      void cancelSessionViaHttp(serverId, payload).catch((fallbackErr) => {
        const refusal = shareCancelFailureFromHttpError(fallbackErr);
        if (refusal) notifyShareCancelFailure({ ...refusal, session: activeSession.name });
        console.warn('session.cancel HTTP fallback failed', fallbackErr);
      });
      requestActiveTimelineRefreshAfterUserAction();
      return commandId;
    }
    try {
      ws.sendSessionCommandUrgent('cancel', payload);
      requestActiveTimelineRefreshAfterUserAction();
    } catch (err) {
      if (!serverId) throw err;
      void cancelSessionViaHttp(serverId, payload).catch((fallbackErr) => {
        const refusal = shareCancelFailureFromHttpError(fallbackErr);
        if (refusal) notifyShareCancelFailure({ ...refusal, session: activeSession.name });
        console.warn('session.cancel HTTP fallback failed', fallbackErr);
      });
      requestActiveTimelineRefreshAfterUserAction();
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
  // A pointer activation dispatches pointerdown and then click. Queue append
  // removes the optimistic rows during pointerdown, so a delayed click must
  // still be recognized as the same activation instead of seeing an empty
  // queue and turning into a real cancel. Keep this event-correlated; a time
  // window is insufficient when streaming work stalls the main thread.
  const stopPointerActivationRef = useRef(false);

  const showStopFeedback = useCallback(() => {
    stopPressGuardRef.current = Date.now();
    setStopRequested(true);
  }, []);

  // A refused Stop must not keep the optimistic "stopping" pulse: the toast says
  // why, and the button is ready for another tap.
  useEffect(() => {
    const onRefused = (event: Event) => {
      const failedSession = (event as CustomEvent<{ session?: string }>).detail?.session;
      if (!failedSession || failedSession === activeSession?.name) setStopRequested(false);
    };
    window.addEventListener(SHARE_CANCEL_FAILED_EVENT, onRefused);
    return () => window.removeEventListener(SHARE_CANCEL_FAILED_EVENT, onRefused);
  }, [activeSession?.name]);

  const handleStopPress = useCallback(() => {
    const now = Date.now();
    if (now - stopPressGuardRef.current < 600) return; // dedupe pointerdown + click
    showStopFeedback();
    cancelActiveTransportTurn();
  }, [cancelActiveTransportTurn, showStopFeedback]);

  const escapeKeyboardOwnerOpen = atPickerOpen
    || aliasPickerOpen
    || machinePickerOpen
    || taskPairPickerOpen
    || cloudDocPickerOpen
    || quickSuggestionKind !== null
    || quickOpen
    || modelOpen
    || autoOpen
    || thinkingOpen
    || cloneDialogOpen
    || voiceOpen
    || p2pOpen
    || p2pConfigOpen
    || openSpecOpen
    || !!mobileFileBrowserOpen;

  const shouldProtectTransportEscape = useCallback((e: KeyboardEvent): boolean => {
    if (e.key !== 'Escape') return true;
    if (e.defaultPrevented) return true;
    if (imeComposingRef.current || isImeComposingKeyEvent(e)) return true;
    if (Date.now() - lastImeCompositionAtRef.current < IME_ESCAPE_CANCEL_GRACE_MS) return true;
    if (escapeKeyboardOwnerOpen || isModalKeyboardOwnerOpen()) return true;

    const composer = divRef.current;
    const target = e.target instanceof Node ? e.target : null;
    const active = typeof document !== 'undefined' && document.activeElement instanceof Node
      ? document.activeElement
      : null;
    const targetIsComposer = !!composer && !!target && composer.contains(target);
    const activeIsComposer = !!composer && !!active && composer.contains(active);

    // If a different text entry owns focus (rename input, picker field, hidden
    // terminal helper textarea, etc.), Esc belongs to that owner, not to the
    // transport turn. Window/body/chat-surface focus is allowed to cancel.
    if (target && isTextEntryKeyboardOwner(target) && !targetIsComposer) return true;
    if (active && isTextEntryKeyboardOwner(active) && !activeIsComposer) return true;

    return false;
  }, [escapeKeyboardOwnerOpen]);

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
      uiLocale: i18n?.resolvedLanguage ?? i18n?.language,
      commandId,
    };
    const markSendFailed = (err: unknown) => {
      console.warn('session.send HTTP fallback failed', err);
      failedQueuedCommandIdsRef.current.add(commandId);
      setOptimisticQueuedEntries((prev) => {
        if (!prev) return prev;
        let changed = false;
        const next = prev.map((entry) => {
          if (entry.clientMessageId !== commandId || entry.status === 'failed') return entry;
          changed = true;
          return { ...entry, status: 'failed' as const };
        });
        return changed ? next : prev;
      });
      onSendFailed?.(commandId, err instanceof Error ? err.message : String(err || 'Send failed'));
    };
    dispatchSessionSend(ws, serverId, payload, markSendFailed);
    requestActiveTimelineRefreshAfterUserAction();
    return commandId;
  }, [activeSession, cancelActiveTransportTurn, effectiveRuntimeType, i18n?.language, i18n?.resolvedLanguage, makeCommandId, onSendFailed, serverId, showStopFeedback, ws]);

  // Provider model metadata is authoritative when available. If a persisted
  // effort is no longer supported after switching models, immediately clamp
  // it and tell the daemon so the next turn cannot send an invalid value.
  useEffect(() => {
    const supported = selectedDynamicModel?.supportedEffortLevels;
    const current = activeSession?.effort as TransportEffortLevel | undefined;
    if (activeSession?.agentType !== 'codex-sdk' || !supported?.length || !current) return;
    const clamped = clampTransportEffort(current, supported);
    if (!clamped || clamped === current) return;
    const key = `${activeSession.name}:${selectedDynamicModel?.id}:${current}->${clamped}`;
    if (effortClampAppliedRef.current === key) return;
    effortClampAppliedRef.current = key;
    sendSessionMessage(`/thinking ${clamped}`);
    showEffortClampNotice(current, clamped);
  }, [activeSession?.agentType, activeSession?.effort, activeSession?.name, selectedDynamicModel?.id, selectedDynamicModel?.supportedEffortLevels, sendSessionMessage, showEffortClampNotice]);

  const sendQueuedMessageMutation = useCallback((
    type: 'session.edit_queued_message' | 'session.undo_queued_message' | typeof TRANSPORT_QUEUE_COMMANDS.APPEND_MESSAGES,
    payload: Record<string, unknown>,
  ) => {
    if (!ws || !activeSession) return false;
    const commandId = globalThis.crypto?.randomUUID?.() ?? `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    ws.send({
      type,
      sessionName: activeSession.name,
      commandId,
      ...payload,
    });
    return commandId;
  }, [activeSession, ws]);

  const finalizeSend = useCallback((
    payload: PendingSendPayload,
    options?: { clearComposer?: boolean; programmaticDelegation?: boolean; retainOnRejection?: boolean },
  ): 'accepted' | 'rejected' => {
    if (!activeSession) return 'rejected';
    if (uploading && !options?.programmaticDelegation) {
      showSendWarning(t('upload.uploading'));
      return 'rejected';
    }
    const isP2pSend = (
      Array.isArray(payload.extra.p2pAtTargets) && payload.extra.p2pAtTargets.length > 0
      || (typeof payload.extra.p2pMode === 'string' && payload.extra.p2pMode.length > 0)
      || (payload.extra.p2pSessionConfig != null && typeof payload.extra.p2pSessionConfig === 'object')
    );
    const isDelegationSend = Boolean(payload.delegation);
    const directAppendRequested = effectiveRuntimeType === 'transport'
      && directAppendMode
      && !isP2pSend
      && !isDelegationSend
      && !payload.text.trim().startsWith('/');
    const effectiveSendExtra = directAppendRequested
      ? { ...payload.extra, deliveryMode: SESSION_SEND_DELIVERY_MODES.APPEND }
      : payload.extra;
    const clearComposerState = () => {
      pendingAtTargetsRef.current = [];
      pendingConfigOverrideRef.current = null;
      setPendingDelegateTarget(null);
      if (divRef.current) setComposerElementText(divRef.current, '');
      setHasText(false);
      publishComposerText('');
      setMobileComposerExpanded(false);
      setMobileComposerMultiline(false);
      setAttachments([]);
      setAttachmentsExpanded(false);
      if (quotes && quotes.length > 0) {
        for (let i = quotes.length - 1; i >= 0; i--) onRemoveQuote?.(i);
      }
      if (taskQuote) onRemoveTaskQuote?.();
      atSelectionLockRef.current = false;
      atSelectionSnapshotRef.current = '';
      setAliasPickerOpen(false);
      setAliasQuery('');
      setQuickSuggestionKind(null);
      setQuickSuggestionQuery('');
      histIdxRef.current = -1;
      draftRef.current = '';
      historyEditsRef.current.clear();
      if (draftKey) safeSessionStorageRemoveItem(draftKey);
      if (attachmentDraftKey) safeSessionStorageRemoveItem(attachmentDraftKey);
    };
    if (effectiveRuntimeType === 'transport' && !isP2pSend && !isDelegationSend && payload.text.trim() === '/stop') {
      showStopFeedback();
      if (!cancelActiveTransportTurn()) return 'rejected';
      if (options?.clearComposer) clearComposerState();
      return 'accepted';
    }
    if (editingQueuedMessageId && effectiveRuntimeType === 'transport' && !options?.programmaticDelegation) {
      const previousEntry = queuedTransportEntries.find((entry) => entry.clientMessageId === editingQueuedMessageId);
      let mutationCommandId: string | false = false;
      try {
        mutationCommandId = sendQueuedMessageMutation('session.edit_queued_message', {
          clientMessageId: editingQueuedMessageId,
          text: payload.text,
          // The daemon drops the previous expansion (it belongs to the old
          // text) and re-expands from this; without it an edited message that
          // still references an alias loses its value.
          ...buildAliasSendExtra(payload.text, aliasAll),
        });
        if (!mutationCommandId) return 'rejected';
      } catch {
        return 'rejected';
      }
      if (previousEntry) {
        queuedMutationRollbackRef.current.set(mutationCommandId, { type: 'edit', entry: previousEntry });
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
      return 'accepted';
    }
    const commandId = makeCommandId();
    let localFailure: string | undefined;
    try {
      if (!sendSessionMessage(payload.text, effectiveSendExtra, commandId)) return 'rejected';
    } catch (err) {
      localFailure = err instanceof Error ? err.message : String(err || 'Send failed');
    }
    const activeIncognitoNow = isIncognitoSession(activeSession)
      || isIncognitoTimelineSession(serverId ?? null, activeSession.name);
    if (!localFailure && !activeIncognitoNow) quickData.recordHistory(payload.delegation?.task ?? payload.text, activeSession.name);
    // An Append-mode send is headed INTO the running turn, not behind it, so it
    // belongs in the timeline immediately (optimistic bubble reconciled by the
    // daemon's user.message for the same id), not in the FIFO card strip.
    // Parking it as a queue card made it vanish whenever a snapshot/delivery
    // frame retired the card before the timeline echo arrived.
    const shouldShowAsQueued = effectiveRuntimeType === 'transport'
      && transportSendShouldQueue
      && !directAppendRequested
      && !isP2pSend
      && !isDelegationSend
      && !payload.text.trim().startsWith('/');
    if (shouldShowAsQueued) {
      const queuedAtMs = Date.now();
      setOptimisticQueuedEntries((prev) => {
        const source = prev ?? incomingQueuedTransportEntries;
        if (source.some((entry) => entry.clientMessageId === commandId)) return source;
        return [...source, {
          clientMessageId: commandId,
          text: payload.text,
          status: localFailure || failedQueuedCommandIdsRef.current.has(commandId) ? 'failed' : 'sending',
          queuedAfterVersion: incomingQueuedTransportVersion,
          queuedAtMs,
        }];
      });
    }
    // Snapshot attachments before clearComposer wipes them so the optimistic
    // bubble surfaces the same badges the confirmed message will.
    const attachmentSnapshot = !options?.programmaticDelegation && attachments.length > 0
      ? attachments.map((a) => ({
          // Keep the opaque upload handle in the timeline payload.  The
          // daemonPath remains for provider/model file access, but must never
          // be used as the browser download identifier (it exposes a host path
          // and is rejected by the authenticated upload route).
          id: attachmentDownloadId(a.id, a.path) ?? a.id ?? a.path,
          daemonPath: a.path,
          originalName: a.name,
      }))
      : undefined;
    const suppressOptimisticUserBubble = shouldHideOptimisticUserMessageForSessionControl(payload.text) && !localFailure;
    if (!shouldShowAsQueued && !suppressOptimisticUserBubble) {
      onSend?.(activeSession.name, payload.text, {
        commandId,
        ...(attachmentSnapshot ? { attachments: attachmentSnapshot } : {}),
        ...(effectiveSendExtra && Object.keys(effectiveSendExtra).length > 0 ? { extra: effectiveSendExtra } : {}),
        ...(localFailure ? { localFailure } : {}),
      });
    }
    if (options?.clearComposer && (!localFailure || !options.retainOnRejection)) {
      clearComposerState();
    }
    return localFailure ? 'rejected' : 'accepted';
  }, [activeSession, attachmentDraftKey, cancelActiveTransportTurn, directAppendMode, draftKey, editingQueuedMessageId, effectiveRuntimeType, incomingQueuedTransportEntries, incomingQueuedTransportVersion, makeCommandId, onRemoveQuote, onRemoveTaskQuote, onSend, publishComposerText, quickData, queuedTransportEntries, quotes, sendQueuedMessageMutation, sendSessionMessage, serverId, showSendWarning, showStopFeedback, t, taskQuote, transportSendShouldQueue, uploading]);

  const handleQueuedMessageEdit = useCallback((entry: { clientMessageId: string; text: string }) => {
    if (!isEditableQueuedEntry(entry)) return;
    histIdxRef.current = -1;
    historyEditsRef.current.clear();
    fillInput(entry.text);
    setEditingQueuedMessageId(entry.clientMessageId);
  }, [isEditableQueuedEntry]);

  const handleQueuedMessageDelete = useCallback((entry: { clientMessageId: string; text: string }) => {
    if (!isEditableQueuedEntry(entry)) return;
    if (editingQueuedMessageId === entry.clientMessageId || (!editingQueuedMessageId && getText() === entry.text)) {
      if (divRef.current) setComposerElementText(divRef.current, '');
      setHasText(false);
      publishComposerText('');
      setMobileComposerExpanded(false);
      setMobileComposerMultiline(false);
      histIdxRef.current = -1;
      draftRef.current = '';
      historyEditsRef.current.clear();
    }
    if (editingQueuedMessageId === entry.clientMessageId) setEditingQueuedMessageId(null);
    // ALWAYS ask the backend to drop it — even when the entry still looks "local"
    // (present optimistically but not yet echoed in the authoritative snapshot).
    // The WS enqueue for this message is ordered BEFORE this delete, so the daemon
    // has almost always ALREADY persisted it to the SQLite queue. The old
    // "local => remove locally and skip the backend undo" shortcut is exactly why
    // deletes didn't reach the backend: the message reappeared on the next
    // authoritative snapshot and stayed queued server-side. Deleting a message the
    // backend never received is safe — the daemon treats an absent id as an
    // idempotent success, so no rollback fires.
    let mutationCommandId: string | false = false;
    try {
      mutationCommandId = sendQueuedMessageMutation('session.undo_queued_message', {
        clientMessageId: entry.clientMessageId,
      });
    } catch {
      return;
    }
    // Without a mutation command there is no authoritative cancellation. Keep
    // the row visible rather than pretending a local-only delete succeeded.
    if (!mutationCommandId) return;
    queuedMutationRollbackRef.current.set(mutationCommandId, { type: 'undo', entry: { ...entry, status: 'queued' } });
    setOptimisticQueuedEntries((prev) => {
      const source = prev ?? incomingQueuedTransportEntries;
      return source.filter((item) => item.clientMessageId !== entry.clientMessageId);
    });
    setOptimisticallyRemovedQueuedIds((prev) => {
      if (prev.has(entry.clientMessageId)) return prev;
      return new Set([...prev, entry.clientMessageId]);
    });
  }, [editingQueuedMessageId, incomingQueuedTransportEntries, isEditableQueuedEntry, publishComposerText, sendQueuedMessageMutation]);

  const handleQueuedMessagesAppend = useCallback((entries: LocalQueuedTransportEntry[]): boolean => {
    if (!activeSession) return false;
    const appendable = entries.filter((entry) => (
      entry.status !== 'failed' && isEditableQueuedEntry(entry)
    ));
    if (appendable.length === 0) return false;
    let mutationCommandId: string | false = false;
    try {
      mutationCommandId = sendQueuedMessageMutation(TRANSPORT_QUEUE_COMMANDS.APPEND_MESSAGES, {
        clientMessageIds: appendable.map((entry) => entry.clientMessageId),
      });
    } catch {
      mutationCommandId = false;
    }
    if (!mutationCommandId) {
      showSendWarning(transportQueueAppendFailedLabel);
      return false;
    }
    queuedMutationRollbackRef.current.set(mutationCommandId, {
      type: 'append',
      entries: appendable.map((entry) => ({ ...entry, status: 'queued' })),
      queue: queuedTransportEntries.map((entry) => ({ ...entry })),
      acceptedSnapshotSeq: acceptedQueueSnapshotSeqRef.current,
    });
    // Move the selected rows into the visible conversation immediately. The
    // daemon emits the same clientMessageId after provider admission, so the
    // normal optimistic reconciliation replaces these rows without duplication.
    // If admission rejects, the ack path above removes them while restoring the
    // queue. This keeps correctness authoritative without making the user wait
    // for the provider round-trip (or a best-effort timeline broadcast).
    for (const entry of appendable) {
      onSend?.(activeSession.name, entry.text, {
        commandId: entry.clientMessageId,
        queueAppend: true,
      });
    }
    const appendIds = new Set(appendable.map((entry) => entry.clientMessageId));
    setOptimisticQueuedEntries((prev) => {
      const source = prev ?? incomingQueuedTransportEntries;
      return source.filter((entry) => !appendIds.has(entry.clientMessageId));
    });
    setOptimisticallyRemovedQueuedIds((prev) => new Set([...prev, ...appendIds]));
    return true;
  }, [activeSession, incomingQueuedTransportEntries, isEditableQueuedEntry, onSend, queuedTransportEntries, sendQueuedMessageMutation, showSendWarning, transportQueueAppendFailedLabel]);

  const handleStopButtonPress = useCallback(() => {
    const queued = queuedTransportEntries.filter((entry) => entry.status !== 'failed');
    if (queued.length > 0) {
      if (pendingStopQueueRef.current) return;
      const now = Date.now();
      if (now - stopPressGuardRef.current < 600) return;
      stopPressGuardRef.current = now;
      const commandId = makeCommandId();
      const timer = setTimeout(() => {
        if (pendingStopQueueRef.current?.commandId !== commandId) return;
        pendingStopQueueRef.current = null;
        showSendWarning(t('session.stop_queue_unconfirmed'));
      }, TRANSPORT_STOP_QUEUE_TIMEOUT_MS * 3);
      // Stop is sent on the priority lane. The daemon owns native admission,
      // definitive refusal and confirmed cancel; the browser never resends text.
      pendingStopQueueRef.current = { commandId, timer };
      try {
        if (!cancelActiveTransportTurn(commandId, queued.map((entry) => entry.clientMessageId))) throw new Error('Stop unavailable');
        showAppendSuccessNotice(t('session.stop_queue_pending'));
      } catch {
        clearTimeout(timer);
        pendingStopQueueRef.current = null;
        showSendWarning(t('session.stop_queue_unconfirmed'));
      }
      return;
    }
    handleStopPress();
  }, [queuedTransportEntries, cancelActiveTransportTurn, handleStopPress, makeCommandId, showAppendSuccessNotice, showSendWarning, t]);

  // Escape and the visible Stop button must share the same queue-first policy.
  // Keeping a separate direct-cancel path here would let one Escape press skip
  // queued messages even though the button correctly appends them first.
  const handleTransportEscapeCancel = useCallback((e: KeyboardEvent): boolean => {
    if (
      effectiveRuntimeType !== 'transport'
      || !isRunningSessionState(activeSession?.state)
      || shouldProtectTransportEscape(e)
    ) {
      return false;
    }
    e.preventDefault();
    e.stopPropagation();
    handleStopButtonPress();
    return true;
  }, [activeSession?.state, effectiveRuntimeType, handleStopButtonPress, shouldProtectTransportEscape]);

  useEffect(() => {
    const enabled = !compact && (keyboardActive ?? true);
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      handleTransportEscapeCancel(e);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [compact, handleTransportEscapeCancel, keyboardActive]);

  const handleQueuedMessageRetry = useCallback((entry: LocalQueuedTransportEntry) => {
    if (entry.status !== 'failed') return;
    let commandId: string | null = null;
    try {
      // Re-resolve the markers in the retried text. The failed entry's text
      // keeps its `;;(name)` markers (values never live on the timeline), so a
      // bare resend would deliver the literal marker to a legend agent and
      // fail closed on shell/script. Resolving here — instead of replaying a
      // stored map — also keeps alias VALUES out of queue component state and
      // picks up any edit made since the original send.
      commandId = sendSessionMessage(entry.text, buildAliasSendExtra(entry.text, aliasAll));
    } catch {
      commandId = null;
    }
    if (!commandId) return;
    let dismissCommandId: string | false = false;
    try {
      dismissCommandId = sendQueuedMessageMutation('session.undo_queued_message', {
        clientMessageId: entry.clientMessageId,
      });
    } catch {
      dismissCommandId = false;
    }
    if (dismissCommandId) {
      queuedMutationRollbackRef.current.set(dismissCommandId, { type: 'undo', entry });
      setOptimisticallyRemovedQueuedIds((prev) => new Set([...prev, entry.clientMessageId]));
    }
    setOptimisticQueuedEntries((prev) => {
      const source = prev ?? incomingQueuedTransportEntries;
      const next = source.filter((item) => item.clientMessageId !== entry.clientMessageId);
      next.push({
        clientMessageId: commandId,
        text: entry.text,
        status: failedQueuedCommandIdsRef.current.has(commandId) ? 'failed' : 'sending',
        queuedAfterVersion: incomingQueuedTransportVersion,
        queuedAtMs: Date.now(),
      });
      return next;
    });
  }, [aliasAll, incomingQueuedTransportEntries, incomingQueuedTransportVersion, sendQueuedMessageMutation, sendSessionMessage]);

  const maybePersistComboSendSkip = useCallback(() => {
    if (!rememberComboSendChoice) return;
    setSkipComboSendConfirm(true);
    void comboSkipPref.save(true).catch(() => {});
  }, [comboSkipPref, rememberComboSendChoice]);

  const getSendValidationError = useCallback((payload: PendingSendPayload): string | null => {
    const text = (payload.delegation?.task ?? payload.text).trim();
    if (payload.delegation) {
      if (!text) return t('delegation.warning_empty_task');
      if (isDelegationUnsupportedControlText(text)) return t('delegation.warning_control_command');
      if (attachments.length > 0) return t('delegation.warning_attachments');
      if ((quotes?.length ?? 0) > 0 || Boolean(taskQuote)) return t('delegation.warning_quotes');
      if (/(^|\s)@[^@\s][^\s]*/.test(text)) return t('delegation.warning_file_refs');
      if (text.includes('@@') || p2pMode !== 'solo' || pendingAtTargetsRef.current.length > 0 || pendingConfigOverrideRef.current) {
        return t('delegation.warning_p2p_tokens');
      }
    }
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
  }, [attachments.length, hasConfiguredP2pParticipants, p2pMode, quotes, t, taskQuote]);

  const requestSend = useCallback((
    payload: PendingSendPayload | null,
    options?: {
      clearComposer?: boolean;
      retainOnRejection?: boolean;
      onConfirmedAccepted?: () => void;
      onConfirmedRejected?: () => void;
      onCanceled?: () => void;
    },
  ): 'accepted' | 'pending' | 'rejected' => {
    closeQuickSuggestions();
    if (!payload) return 'rejected';
    const validationError = getSendValidationError(payload);
    if (validationError) {
      showSendWarning(validationError);
      return 'rejected';
    }
    clearSendWarning();
    const comboMode = typeof payload.extra.p2pMode === 'string' ? payload.extra.p2pMode : null;
    if (comboMode && isComboMode(comboMode) && !skipComboSendConfirm) {
      setRememberComboSendChoice(false);
      const confirmation: PendingComboSendConfirmation = {
        payload,
        modeLabel: getP2pModeLabel(comboMode, t),
        clearComposer: !!options?.clearComposer,
        retainOnRejection: !!options?.retainOnRejection,
        onConfirmedAccepted: options?.onConfirmedAccepted,
        onConfirmedRejected: options?.onConfirmedRejected,
        onCanceled: options?.onCanceled,
      };
      pendingComboSendConfirmRef.current = confirmation;
      setPendingComboSendConfirm(confirmation);
      return 'pending';
    }
    return finalizeSend(payload, options);
  }, [clearSendWarning, closeQuickSuggestions, finalizeSend, getSendValidationError, showSendWarning, skipComboSendConfirm, t]);

  const setVoiceInputModelLoadingHandler = useCallback(
    (cb: ((loading: boolean, variant?: string) => void) | null) => {
      if (Object.prototype.hasOwnProperty.call(VoiceInput, 'onModelLoading')) {
        VoiceInput.onModelLoading?.(cb);
      }
    },
    [],
  );

  const stopInlineVoice = useCallback((options?: {
    abort?: boolean;
    restoreCaret?: boolean;
    skipStateUpdate?: boolean;
  }) => {
    const abort = options?.abort ?? true;
    const wasActive = inlineVoiceActiveRef.current;
    const activeToken = inlineVoiceTokenRef.current;
    if (abort) {
      inlineVoiceTokenRef.current += 1;
      inlineVoiceDrainingTokenRef.current = null;
    } else if (wasActive) {
      // Keep the active token valid while VoiceInput.stopListening({ abort: false }) drains trailing results.
      inlineVoiceDrainingTokenRef.current = activeToken;
    }
    if (inlineVoiceRecognizingTimerRef.current !== null) {
      clearTimeout(inlineVoiceRecognizingTimerRef.current);
      inlineVoiceRecognizingTimerRef.current = null;
    }
    inlineVoiceActiveRef.current = false;
    if (!options?.skipStateUpdate) {
      setInlineVoiceActive(false);
      setInlineVoiceRecognizing(false);
      setInlineVoiceLevel(0);
      setVoiceModelLoading(false);
    }
    if (wasActive) {
      VoiceInput.onAudioLevel(null);
      setVoiceInputModelLoadingHandler(null);
    }
    const caretTarget = inlineVoiceSegmentRef.current.caretAfterSegment;
    detachInlineVoiceRobotHost(inlineVoiceRobotHostRef.current);
    if (
      options?.restoreCaret
      && divRef.current
      && typeof document !== 'undefined'
      && document.activeElement === divRef.current
    ) {
      setComposerCaretOffset(divRef.current, caretTarget);
    }
    if (wasActive) {
      void Promise.resolve(VoiceInput.stopListening({ abort }))
        .catch(() => {})
        .finally(() => {
          if (!abort && inlineVoiceDrainingTokenRef.current === activeToken && inlineVoiceTokenRef.current === activeToken) {
            inlineVoiceDrainingTokenRef.current = null;
            inlineVoiceTokenRef.current += 1;
          }
        });
    }
  }, []);

  const handleSend = useCallback(() => {
    if (inlineVoiceActiveRef.current || inlineVoiceDrainingTokenRef.current !== null) {
      stopInlineVoice({ abort: true, restoreCaret: false });
    }
    const outcome = requestSend(buildSendPayload(), { clearComposer: true });
    if (outcome === 'rejected' && !inputDisabledRef.current && divRef.current) {
      const el = divRef.current;
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      if (
        !composerFocusedRef.current
        || el.getAttribute('contenteditable') !== 'true'
        || active !== el
      ) {
        focusComposerForTyping({ moveCursorToEnd: true });
      }
    }
  }, [buildSendPayload, focusComposerForTyping, requestSend]);

  const handleQuickAgentDelegationDispatch = useCallback((input: {
    sessionName: string;
    label: string;
    task: string;
    preset: QuickAgentDelegationPreset;
  }) => {
    const task = input.task.trim();
    if (!task) {
      setQuickDelegationError(t('delegation.warning_empty_task'));
      return;
    }
    if (isDelegationUnsupportedControlText(task)) {
      setQuickDelegationError(t('delegation.warning_control_command'));
      return;
    }
    setQuickDelegationError(null);
    const outcome = finalizeSend({
      text: buildAgentDelegationOrchestrationPrompt({
        targetSession: input.sessionName,
        targetLabel: input.label,
        task,
        auditCycle: input.preset === 'audit',
        uiLocale: i18n.resolvedLanguage ?? i18n.language,
      }),
      extra: {},
      delegation: {
        targetSession: input.sessionName,
        targetLabel: input.label,
        task,
      },
    }, { programmaticDelegation: true });
    if (outcome === 'accepted') {
      setPeerAuditOpen(false);
      return;
    }
    setQuickDelegationError(t('peerAuditQuick.sendFailed'));
  }, [finalizeSend, i18n.language, i18n.resolvedLanguage, t]);

  const handleDirectComboSelect = useCallback((mode: string, roundsOverride?: number) => {
    setP2pOpen(false);
    if (isCurrentSessionP2pMember) {
      showSendWarning(t('p2p.member_cannot_initiate_discussion'));
      return;
    }
    const selection = p2pSavedConfig
      ? buildP2pConfigSelection(sanitizeP2pSavedConfig(p2pSavedConfig, { scopeSession: rootSession }), mode, roundsOverride ?? p2pSavedConfig.rounds ?? 1)
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
  }, [buildSendPayload, isCurrentSessionP2pMember, p2pSavedConfig, requestSend, rootSession, showSendWarning, t]);

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
    const chosenConfig: P2pSavedConfig = sanitizeP2pSavedConfig({ ...p2pSavedConfig, activeWorkflowId: workflowId }, { scopeSession: rootSession });
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
  }, [buildSendPayload, isCurrentSessionP2pMember, p2pSavedConfig, requestSend, rootSession, showSendWarning, t, workflowLibraryItems]);

  const handleComboSendCancel = useCallback(() => {
    const pending = pendingComboSendConfirmRef.current;
    maybePersistComboSendSkip();
    pendingComboSendConfirmRef.current = null;
    setPendingComboSendConfirm(null);
    setRememberComboSendChoice(false);
    pending?.onCanceled?.();
  }, [maybePersistComboSendSkip]);

  const handleComboSendConfirm = useCallback(() => {
    const pending = pendingComboSendConfirmRef.current;
    if (!pending) return;
    // Consume the authority before sending. A repeated click or stale handler
    // can therefore never dispatch the same voice transcript twice.
    pendingComboSendConfirmRef.current = null;
    maybePersistComboSendSkip();
    setPendingComboSendConfirm(null);
    setRememberComboSendChoice(false);
    const outcome = finalizeSend(pending.payload, {
      clearComposer: pending.clearComposer,
      retainOnRejection: pending.retainOnRejection,
    });
    if (outcome === 'accepted') pending.onConfirmedAccepted?.();
    else pending.onConfirmedRejected?.();
  }, [finalizeSend, maybePersistComboSendSkip]);

  const sendOpenSpecPrompt = useCallback((text: string) => {
    finalizeSend({ text, extra: {} }, { clearComposer: false });
  }, [finalizeSend]);

  // Voice is an alternate editor for the same composer, not a separate send
  // lane. Reuse the ordinary payload builder so the current attachment/quote/
  // routing snapshot is sent and cleared with the same success semantics.
  const handleVoiceSend = useCallback((
    voiceText: string,
    options?: {
      onRejected?: () => void;
      onPendingCanceled?: () => void;
    },
  ) => {
    return requestSend(buildSendPayload({ textOverride: voiceText }), {
      clearComposer: true,
      retainOnRejection: true,
      onConfirmedAccepted: () => {
        setVoiceOpen(false);
        setVoiceOverlayInitialText(null);
        setVoiceOverlayAutoStart(true);
      },
      onConfirmedRejected: options?.onRejected,
      onCanceled: options?.onPendingCanceled,
    });
  }, [buildSendPayload, requestSend]);

  const openStandardVoiceOverlay = useCallback(() => {
    if (inputDisabledRef.current) return;
    if (!hasVoiceNotepadDraft && VoiceInput.isAvailable()) {
      primeVoiceInputGesture({ deferAudioPause: false });
    }
    setVoiceOverlayInitialText(null);
    setVoiceOverlayAutoStart(true);
    setVoiceOpen(true);
  }, [hasVoiceNotepadDraft]);

  const pulseInlineRecognizing = useCallback(() => {
    setInlineVoiceRecognizing(true);
    if (inlineVoiceRecognizingTimerRef.current !== null) {
      clearTimeout(inlineVoiceRecognizingTimerRef.current);
    }
    inlineVoiceRecognizingTimerRef.current = setTimeout(() => {
      inlineVoiceRecognizingTimerRef.current = null;
      setInlineVoiceRecognizing(false);
    }, 900);
  }, []);

  const interruptInlineVoiceForManualEdit = useCallback(() => {
    if (!inlineVoiceActiveRef.current && inlineVoiceDrainingTokenRef.current === null) return;
    const wasActive = inlineVoiceActiveRef.current;
    inlineVoiceTokenRef.current += 1;
    inlineVoiceDrainingTokenRef.current = null;
    if (inlineVoiceRecognizingTimerRef.current !== null) {
      clearTimeout(inlineVoiceRecognizingTimerRef.current);
      inlineVoiceRecognizingTimerRef.current = null;
    }
    inlineVoiceActiveRef.current = false;
    setInlineVoiceActive(false);
    setInlineVoiceRecognizing(false);
    setInlineVoiceLevel(0);
    setVoiceModelLoading(false);
    VoiceInput.onAudioLevel(null);
    setVoiceInputModelLoadingHandler(null);
    // Detach the robot badge without rewriting root text so browser-inserted edits stay intact.
    detachInlineVoiceRobotHost(inlineVoiceRobotHostRef.current);
    if (wasActive) {
      void Promise.resolve(VoiceInput.stopListening({ abort: true })).catch(() => {});
    }
  }, []);
  interruptInlineVoiceRef.current = interruptInlineVoiceForManualEdit;

  const startInlineVoice = useCallback((): boolean => {
    if (inputDisabledRef.current || !VoiceInput.isAvailable()) return false;
    const el = divRef.current;
    if (!el || !el.isConnected) return false;
    const existingSel = getComposerSelectionOffsets(el);
    if (typeof document === 'undefined' || document.activeElement !== el) {
      focusComposerForTyping(existingSel ? undefined : { moveCursorToEnd: true });
      if (existingSel) {
        setComposerCaretOffset(el, existingSel.end);
      }
    }
    const fullText = readComposerElementText(el, { preserveEditingLines: true });
    const start = existingSel ? Math.min(existingSel.start, fullText.length) : fullText.length;
    const end = existingSel ? Math.min(existingSel.end, fullText.length) : fullText.length;
    const prefix = fullText.slice(0, start);
    const selectedText = fullText.slice(start, end);
    const suffix = fullText.slice(end);
    const robotHost = inlineVoiceRobotHostRef.current ?? createInlineVoiceRobotHost();
    inlineVoiceRobotHostRef.current = robotHost;
    inlineVoiceSegmentRef.current = {
      prefix,
      selectedText,
      suffix,
      partial: '',
      hasCommittedPartial: false,
      caretAfterSegment: start + selectedText.length,
    };

    programmaticVoiceWriteRef.current = true;
    try {
      writeInlineVoiceSegmentDom(el, prefix + selectedText, suffix, robotHost, true);
    } finally {
      programmaticVoiceWriteRef.current = false;
    }

    const token = ++inlineVoiceTokenRef.current;
    inlineVoiceDrainingTokenRef.current = null;
    inlineVoiceActiveRef.current = true;
    setInlineVoiceActive(true);
    setInlineVoiceRecognizing(false);
    setInlineVoiceLevel(0);
    setVoiceModelLoading(false);
    setInlineVoicePermissionTarget(null);
    primeVoiceInputGesture({ deferAudioPause: false });

    setVoiceInputModelLoadingHandler((loading) => {
      if (!mountedRef.current || inlineVoiceTokenRef.current !== token || !inlineVoiceActiveRef.current) return;
      setVoiceModelLoading(loading);
    });

    VoiceInput.onAudioLevel((rawLevel) => {
      if (!mountedRef.current || inlineVoiceTokenRef.current !== token || !inlineVoiceActiveRef.current) return;
      setInlineVoiceLevel(clampVoiceRobotLevel(rawLevel));
    });

    let started = false;
    void Promise.resolve(VoiceInput.startListening(
      (partial) => {
        const isCurrentToken = inlineVoiceTokenRef.current === token;
        const isActiveOrDraining = inlineVoiceActiveRef.current || inlineVoiceDrainingTokenRef.current === token;
        if (!isCurrentToken || !isActiveOrDraining) return;
        const target = divRef.current;
        if (!target) return;
        const seg = inlineVoiceSegmentRef.current;
        if (!partial && !seg.hasCommittedPartial) return;
        seg.hasCommittedPartial = true;
        seg.partial = partial;
        const needSep = seg.prefix.length > 0
          && !/[\s\n]$/.test(seg.prefix)
          && partial.length > 0
          && !/^[,.!?;:，。！？；：\s]/.test(partial);
        const sep = needSep ? ' ' : '';
        const before = `${seg.prefix}${sep}${partial}`;
        seg.caretAfterSegment = before.length;

        programmaticVoiceWriteRef.current = true;
        try {
          writeInlineVoiceSegmentDom(
            target,
            before,
            seg.suffix,
            inlineVoiceActiveRef.current ? inlineVoiceRobotHostRef.current : null,
            typeof document !== 'undefined' && document.activeElement === target,
          );
        } finally {
          programmaticVoiceWriteRef.current = false;
        }

        const currentPlain = readComposerElementText(target);
        const currentEditing = readComposerElementText(target, { preserveEditingLines: true });
        setHasText(!!currentPlain.trim());
        publishComposerText(currentPlain);
        syncHistoryEditOrDraft(
          currentEditing,
          getNavigableHistory(quickData.data, activeSessionIncognito ? undefined : activeSession?.name),
        );
        syncMobileComposerMetrics();
        if (inlineVoiceActiveRef.current) {
          pulseInlineRecognizing();
        }
      },
      (listening) => {
        if (inlineVoiceTokenRef.current !== token) return;
        if (listening) {
          started = true;
          return;
        }
        if (started && inlineVoiceActiveRef.current) {
          stopInlineVoice({
            abort: false,
            restoreCaret: typeof document !== 'undefined' && document.activeElement === divRef.current,
          });
        }
      },
      (err) => {
        if (inlineVoiceTokenRef.current !== token) return;
        stopInlineVoice({
          abort: true,
          restoreCaret: typeof document !== 'undefined' && document.activeElement === divRef.current,
        });
        const trimmedErr = err?.trim() ?? '';
        if (trimmedErr && /permission_denied|not-allowed/i.test(trimmedErr)) {
          setInlineVoicePermissionTarget(VoiceInput.getPcAppPermissionDeniedTarget?.() ?? 'mic');
        } else if (trimmedErr) {
          showSendWarning(trimmedErr);
        }
      },
    )).then((ok) => {
      if (inlineVoiceTokenRef.current !== token) return;
      if (ok === false && inlineVoiceActiveRef.current) {
        stopInlineVoice({
          abort: true,
          restoreCaret: typeof document !== 'undefined' && document.activeElement === divRef.current,
        });
      }
    }).catch(() => {
      if (inlineVoiceTokenRef.current !== token) return;
      if (inlineVoiceActiveRef.current) {
        stopInlineVoice({
          abort: true,
          restoreCaret: typeof document !== 'undefined' && document.activeElement === divRef.current,
        });
      }
    });

    return true;
  }, [
    activeSession?.name,
    activeSessionIncognito,
    focusComposerForTyping,
    publishComposerText,
    pulseInlineRecognizing,
    quickData.data,
    showSendWarning,
    stopInlineVoice,
    syncHistoryEditOrDraft,
    syncMobileComposerMetrics,
  ]);

  const handleQuickGrantVoicePermission = useCallback(async () => {
    const bridge = getPcAppBridge();
    if (!bridge?.voice) return;
    const perms = await bridge.voice.requestPermissions?.().catch(() => null);
    if (perms && perms.mic === 'granted' && (perms.speech === 'granted' || perms.speech === 'unavailable')) {
      setInlineVoicePermissionTarget(null);
      VoiceInput.clearPcAppPermissionDeniedTarget?.();
      startInlineVoice();
      return;
    }
    const target: 'microphone' | 'speech' = perms?.mic !== 'granted'
      ? 'microphone'
      : (inlineVoicePermissionTarget === 'speech' || perms?.speech !== 'granted' ? 'speech' : 'microphone');
    await bridge.voice.openPrivacySettings?.(target).catch(() => false);
  }, [inlineVoicePermissionTarget, startInlineVoice]);

  const handleVoiceButtonActivate = useCallback(() => {
    if (inputDisabledRef.current) return;
    if (inlineDesktopVoiceRef.current || isNativeMacDesktop() || isPcAppInlineVoiceSupported()) {
      if (inlineVoiceActiveRef.current) {
        stopInlineVoice({ abort: false, restoreCaret: true });
      } else {
        startInlineVoice();
      }
      return;
    }
    openStandardVoiceOverlay();
  }, [openStandardVoiceOverlay, startInlineVoice, stopInlineVoice]);

  const keyboardActiveRef = useRef(keyboardActive);
  keyboardActiveRef.current = keyboardActive;
  const pendingDelegateTargetRef = useRef(pendingDelegateTarget);
  pendingDelegateTargetRef.current = pendingDelegateTarget;
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;

  const handleMacVoiceShortcutTrigger = useCallback((): boolean => {
    if (inputDisabledRef.current || !VoiceInput.isAvailable()) return false;
    if (inlineVoiceActiveRef.current) {
      stopInlineVoice({ abort: true, restoreCaret: false });
      const currentText = divRef.current ? readComposerElementText(divRef.current).trim() : '';
      if (currentText.length > 0 || attachmentDraftRef.current.length > 0 || pendingDelegateTargetRef.current) {
        handleSendRef.current();
      }
      return true;
    }
    return startInlineVoice();
  }, [startInlineVoice, stopInlineVoice]);

  const handleMacVoiceShortcutStopOnly = useCallback((): boolean => {
    if (inputDisabledRef.current || !inlineVoiceActiveRef.current) return false;
    stopInlineVoice({ abort: false, restoreCaret: true });
    return true;
  }, [stopInlineVoice]);

  useEffect(() => registerMacVoiceComposerHandler({
    isActive: () => keyboardActiveRef.current !== false,
    isInlineVoiceActive: () => inlineVoiceActiveRef.current,
    isFocused: () => composerFocusedRef.current || (
      typeof document !== 'undefined' && !!divRef.current && document.activeElement === divRef.current
    ),
    triggerToggleOrSubmit: handleMacVoiceShortcutTrigger,
    stopWithoutSubmit: handleMacVoiceShortcutStopOnly,
  }), [handleMacVoiceShortcutStopOnly, handleMacVoiceShortcutTrigger]);

  useEffect(() => {
    if (inputDisabled && (inlineVoiceActiveRef.current || inlineVoiceDrainingTokenRef.current !== null)) {
      stopInlineVoice({ abort: true, restoreCaret: false });
    }
  }, [inputDisabled, stopInlineVoice]);

  useEffect(() => () => {
    if (inlineVoiceActiveRef.current || inlineVoiceDrainingTokenRef.current !== null) {
      stopInlineVoice({ abort: true, restoreCaret: false, skipStateUpdate: !mountedRef.current });
    }
  }, [activeSession?.name, stopInlineVoice]);

  const clearVoiceHoldStartTimeout = useCallback((expectedTx?: NonNullable<typeof voiceHoldTxRef.current>) => {
    if (expectedTx && voiceHoldStartTimeoutOwnerRef.current !== expectedTx) {
      return;
    }
    if (voiceHoldStartTimeoutRef.current !== null) {
      clearTimeout(voiceHoldStartTimeoutRef.current);
      voiceHoldStartTimeoutRef.current = null;
    }
    voiceHoldStartTimeoutOwnerRef.current = null;
  }, []);

  const clearVoiceHoldDropTimer = useCallback(() => {
    if (voiceHoldDropTimerRef.current !== null) {
      clearTimeout(voiceHoldDropTimerRef.current);
      voiceHoldDropTimerRef.current = null;
    }
    if (voiceHoldDropCancelRef.current !== null) {
      const cancel = voiceHoldDropCancelRef.current;
      voiceHoldDropCancelRef.current = null;
      cancel();
    }
  }, []);

  const clearVoiceHoldTimers = useCallback(() => {
    if (voiceHoldTimerRef.current !== null) {
      clearTimeout(voiceHoldTimerRef.current);
      voiceHoldTimerRef.current = null;
    }
    if (voiceHoldSlideTimerRef.current !== null) {
      clearTimeout(voiceHoldSlideTimerRef.current);
      voiceHoldSlideTimerRef.current = null;
    }
    clearVoiceHoldStartTimeout();
    if (voiceHoldRecognizingTimerRef.current !== null) {
      clearTimeout(voiceHoldRecognizingTimerRef.current);
      voiceHoldRecognizingTimerRef.current = null;
    }
    clearVoiceHoldDropTimer();
  }, [clearVoiceHoldDropTimer, clearVoiceHoldStartTimeout]);

  const clearComposerVoiceWindowListeners = useCallback(() => {
    voiceWindowCleanupRef.current?.();
    voiceWindowCleanupRef.current = null;
  }, []);

  const attachComposerVoiceWindowListeners = useCallback(() => {
    clearComposerVoiceWindowListeners();
    if (typeof window === 'undefined') return;
    const onWinPointerMove = (e: Event) => voicePointerMoveHandlerRef.current(e as PointerEvent);
    const onWinPointerUp = (e: Event) => voicePointerEndHandlerRef.current(e as PointerEvent, false);
    const onWinPointerCancel = (e: Event) => voicePointerEndHandlerRef.current(e as PointerEvent, true);
    const onWinTouchMove = (e: Event) => {
      if ((voiceHoldPendingRef.current || voiceHoldActiveRef.current) && e.cancelable) {
        e.preventDefault();
      }
    };
    window.addEventListener('pointermove', onWinPointerMove);
    window.addEventListener('pointerup', onWinPointerUp);
    window.addEventListener('pointercancel', onWinPointerCancel);
    window.addEventListener('touchmove', onWinTouchMove, { passive: false });
    voiceWindowCleanupRef.current = () => {
      window.removeEventListener('pointermove', onWinPointerMove);
      window.removeEventListener('pointerup', onWinPointerUp);
      window.removeEventListener('pointercancel', onWinPointerCancel);
      window.removeEventListener('touchmove', onWinTouchMove);
    };
  }, [clearComposerVoiceWindowListeners]);

  const pulseVoiceHoldRecognizing = useCallback((durationMs = 1500) => {
    const activePhase = voiceHoldTxRef.current?.phase;
    if (!voiceHoldActiveRef.current || (activePhase !== 'starting' && activePhase !== 'recording')) return;
    setVoiceHoldRecognizing(true);
    if (voiceHoldRecognizingTimerRef.current !== null) {
      clearTimeout(voiceHoldRecognizingTimerRef.current);
    }
    voiceHoldRecognizingTimerRef.current = setTimeout(() => {
      voiceHoldRecognizingTimerRef.current = null;
      if (voiceHoldActiveRef.current) setVoiceHoldRecognizing(false);
    }, durationMs);
  }, []);

  const releaseVoiceHoldInteraction = useCallback(() => {
    voiceHoldPointerRef.current = null;
    setComposerVoicePending(false);
    voiceHoldActiveRef.current = false;
    voiceHoldLiveAudioRef.current = false;
    clearVoiceHoldTimers();
    clearComposerVoiceWindowListeners();
    clearComposerVoiceTouchLock(
      divRef.current,
      inputDisabledRef.current || (voiceHoldReadyRef.current && !composerFocusedRef.current),
    );
    VoiceInput.onAudioLevel(null);
    setVoiceInputModelLoadingHandler(null);
    if (mountedRef.current) {
      setVoiceHoldLiveAudio(false);
      setVoiceHoldRecognizing(false);
      setVoiceHoldActive(false);
      setVoiceModelLoading(false);
    }
  }, [clearComposerVoiceWindowListeners, clearVoiceHoldTimers, setComposerVoicePending]);

  const measureVoiceHoldBottomClearance = useCallback((): number | null => {
    const composerEl = composerRef.current
      ?? (divRef.current?.closest('.controls-composer') as HTMLElement | null)
      ?? divRef.current;
    const viewportHeightPx = voiceHoldHudRef.current?.getBottomPx()
      ?? (typeof window !== 'undefined'
        ? (window.visualViewport?.height || window.innerHeight || document.documentElement?.clientHeight || 0)
        : 0);
    return computeVoiceHoldBottomClearancePx(composerEl, viewportHeightPx, getActiveCssZoom());
  }, []);

  useLayoutEffect(() => {
    if (!voiceHoldHudActive) return;
    const update = () => {
      const next = measureVoiceHoldBottomClearance();
      setVoiceHoldBottomClearance((prev) => (prev === next ? prev : next));
    };
    update();
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', update);
    }
    vv?.addEventListener('resize', update);
    const composerEl = composerRef.current ?? divRef.current;
    const observer = typeof ResizeObserver === 'function' && composerEl
      ? new ResizeObserver(update)
      : null;
    if (observer && composerEl) observer.observe(composerEl);
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', update);
      }
      vv?.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [measureVoiceHoldBottomClearance, voiceHoldHudActive, mobileComposerExpanded]);

  const closeVoiceHoldHud = useCallback(() => {
    clearVoiceHoldDropTimer();
    voiceHoldDragXRef.current = 0;
    voiceHoldHudRef.current?.setDragX(0);
    voiceHoldHudRef.current?.resetBars();
    if (mountedRef.current) {
      setVoiceHoldHudActive(false);
      setVoiceHoldPhase('starting');
      setVoiceHoldZone('send');
      setVoiceHoldDropY(null);
      setVoiceHoldBottomClearance(null);
      setVoiceHoldService(null);
    }
  }, [clearVoiceHoldDropTimer]);

  const resetVoiceHoldInteractionState = useCallback(() => {
    releaseVoiceHoldInteraction();
    closeVoiceHoldHud();
  }, [closeVoiceHoldHud, releaseVoiceHoldInteraction]);

  const disarmTouchTapCompatMouseShield = useCallback(() => {
    touchTapCompatShieldCleanupRef.current?.();
    touchTapCompatShieldCleanupRef.current = null;
  }, []);

  /**
   * Focusing the composer synchronously on a short touch `pointerup` or failed-hold
   * click fallback (or initial mobile tap focus) can trigger `.input-focused` /
   * `.subcard-bar` hiding and shift the composer downward before the browser
   * dispatches compatibility `mousedown` / `click`. Guard against that stale
   * compatibility `mousedown` landing on `.chat-view` (`tabIndex={-1}`) and stealing
   * focus back out of the composer, and shield against the paired compatibility
   * `click` landing outside the composer on shifted chat content (e.g.
   * `.chat-local-image-preview-img`, `.chat-attachment-dl`).
   */
  const armTouchTapCompatMouseShield = useCallback(() => {
    disarmTouchTapCompatMouseShield();
    if (typeof document === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      document.removeEventListener('pointerdown', onNewInteraction, true);
      document.removeEventListener('touchstart', onNewInteraction, true);
      document.removeEventListener('keydown', onNewInteraction, true);
      document.removeEventListener('mousedown', onCompatMouseDown, true);
      document.removeEventListener('click', onCompatClick, true);
      if (touchTapCompatShieldCleanupRef.current === cleanup) {
        touchTapCompatShieldCleanupRef.current = null;
      }
    };
    const onNewInteraction = () => {
      cleanup();
    };
    const onCompatMouseDown = (ev: MouseEvent) => {
      const el = divRef.current;
      if (el && document.activeElement === el) {
        ev.preventDefault();
      }
    };
    const onCompatClick = (ev: MouseEvent) => {
      const el = divRef.current;
      const target = ev.target;
      const insideComposerOrBanner = !!(
        (el && target instanceof Node && el.contains(target))
        || (target instanceof Element && target.closest('.voice-hold-error-banner'))
      );
      if (!insideComposerOrBanner) {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation?.();
      }
      cleanup();
    };
    document.addEventListener('pointerdown', onNewInteraction, true);
    document.addEventListener('touchstart', onNewInteraction, true);
    document.addEventListener('keydown', onNewInteraction, true);
    document.addEventListener('mousedown', onCompatMouseDown, true);
    document.addEventListener('click', onCompatClick, true);
    timer = setTimeout(cleanup, 500);
    touchTapCompatShieldCleanupRef.current = cleanup;
  }, [disarmTouchTapCompatMouseShield]);

  /** Restore editability and focus the composer on any short tap or failed hold. */
  const fallbackToComposerClick = useCallback((pointerType?: string) => {
    pendingMobileInitialEndFocusRef.current = null;
    if (!mountedRef.current || inputDisabledRef.current) {
      didPrimeVoiceGestureRef.current = false;
      didPrimeVoiceGestureRef.current = false;
    cancelVoiceInputGesturePrime();
      return;
    }
    suppressComposerClickFocusRef.current = false;
    if (suppressComposerClickTimerRef.current !== null) {
      clearTimeout(suppressComposerClickTimerRef.current);
      suppressComposerClickTimerRef.current = null;
    }
    if (pointerType === 'touch') {
      armTouchTapCompatMouseShield();
    }
    focusComposerForTyping({ moveCursorToEnd: true });
  }, [armTouchTapCompatMouseShield, focusComposerForTyping]);

  const updateVoiceHoldZoneFromDx = useCallback((
    tx: NonNullable<typeof voiceHoldTxRef.current>,
    dx: number,
    hapticOnChange = true,
  ) => {
    const clampedDragX = Math.round(Math.max(-VOICE_HOLD_SLIDE_MAX_PX, Math.min(VOICE_HOLD_SLIDE_MAX_PX, dx)));
    voiceHoldDragXRef.current = clampedDragX;
    voiceHoldHudRef.current?.setDragX(clampedDragX);
    let nextZone: 'send' | 'cancel' | 'edit' = 'send';
    if (dx <= -VOICE_HOLD_CANCEL_THRESHOLD_PX) nextZone = 'cancel';
    else if (dx >= VOICE_HOLD_EDIT_THRESHOLD_PX) nextZone = 'edit';

    if (nextZone !== tx.zone) {
      tx.zone = nextZone;
      voiceHoldZoneRef.current = nextZone;
      setVoiceHoldZone(nextZone);
      if (hapticOnChange) {
        triggerVoiceHoldHaptic('selection', 12);
      }
    }
  }, []);

  const waitForVoiceHoldDrop = useCallback((): Promise<boolean> => {
    clearVoiceHoldDropTimer();
    if (prefersVoiceHoldReducedMotion()) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let finished = false;
      const cancel = () => {
        if (finished) return;
        finished = true;
        resolve(false);
      };
      voiceHoldDropCancelRef.current = cancel;
      voiceHoldDropTimerRef.current = setTimeout(() => {
        voiceHoldDropTimerRef.current = null;
        if (voiceHoldDropCancelRef.current === cancel) {
          voiceHoldDropCancelRef.current = null;
        }
        if (!finished) {
          finished = true;
          resolve(true);
        }
      }, VOICE_HOLD_DROP_ANIMATION_MS);
    });
  }, [clearVoiceHoldDropTimer]);

  const restoreVoiceHoldToComposer = useCallback((text: string, protectTouchCompat = false) => {
    if (!mountedRef.current) return;
    suppressComposerClickFocusRef.current = false;
    if (suppressComposerClickTimerRef.current !== null) {
      clearTimeout(suppressComposerClickTimerRef.current);
      suppressComposerClickTimerRef.current = null;
    }
    if (protectTouchCompat && !inputDisabledRef.current) {
      armTouchTapCompatMouseShield();
    }
    fillInput(text);
    syncHistoryEditOrDraft(
      text,
      getNavigableHistory(quickData.data, activeSessionIncognito ? undefined : activeSession?.name),
    );
    if (draftKey) safeSessionStorageSetItem(draftKey, text);
  }, [
    activeSession?.name,
    activeSessionIncognito,
    armTouchTapCompatMouseShield,
    draftKey,
    fillInput,
    quickData.data,
    syncHistoryEditOrDraft,
  ]);

  const finalizeVoiceHold = useCallback((
    tx: NonNullable<typeof voiceHoldTxRef.current>,
    outcome: 'send' | 'cancel' | 'edit' | 'failed',
  ): Promise<void> => {
    if (tx.drainPromise !== null) return tx.drainPromise;

    const shouldKeepHudForDrain = outcome === 'send' || outcome === 'edit';
    if (shouldKeepHudForDrain) {
      releaseVoiceHoldInteraction();
      voiceHoldHudRef.current?.resetBars();
      if (mountedRef.current) {
        setVoiceHoldPhase('draining');
        setVoiceHoldHudActive(true);
      }
    } else {
      resetVoiceHoldInteractionState();
    }

    // Any hold that never succeeded in active capture falls back to typing focus
    // (regardless of slide zone), whereas explicit slide-to-cancel after active
    // recording stops cleanly without popping open the keyboard.
    const didPreRecordingFallback =
      !tx.didStartRecording
      && (outcome === 'failed' || outcome === 'cancel');
    if (didPreRecordingFallback) {
      fallbackToComposerClick(tx.pointerType);
    }

    const abortMode = outcome === 'cancel' || outcome === 'failed';
    if (outcome === 'cancel') {
      if (tx.didStartRecording) {
        triggerVoiceHoldHaptic('warning', 15);
      }
      // Cancel discards immediately: detach the active transaction right away so
      // another hold or short tap never waits on slow/hung native stop/start drains.
      tx.settled = true;
      tx.phase = 'settled';
      if (voiceHoldTxRef.current === tx) {
        voiceHoldTxRef.current = null;
      }
      const stopTask = Promise.resolve(VoiceInput.stopListening({ abort: true })).catch(() => {});
      tx.drainPromise = Promise.allSettled([
        tx.startPromise ?? Promise.resolve(false),
        stopTask,
      ]).then(() => {});
      return tx.drainPromise;
    }

    tx.phase = outcome === 'failed' ? 'failed' : 'draining';

    tx.drainPromise = (async () => {
      let drainTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        // Always join the idempotent VoiceInput.stopListening() barrier BEFORE
        // awaiting startPromise:
        // 1. If native start is still pending (permission / first PCM / startingCall),
        //    stopListening immediately aborts it via the generation barrier.
        // 2. For normal send/edit drains, await the finite stopListening() barrier
        //    without an arbitrary timeout so delayed final tails are preserved and
        //    delivered once, while keeping voiceHoldTxRef non-null against overlapping holds.
        // 3. For failed outcomes, bound recovery with VOICE_HOLD_FAILED_DRAIN_TIMEOUT_MS.
        const stopTask = Promise.resolve(
          VoiceInput.stopListening(abortMode ? { abort: true } : undefined),
        ).catch(() => {});
        if (!tx.startPromise) {
          await Promise.resolve();
        }
        const work = (async () => {
          const started = tx.startPromise ? await tx.startPromise : false;
          await stopTask;
          return started;
        })();

        let timedOut = false;
        let started = false;
        if (outcome === 'failed') {
          const raceResult = await Promise.race([
            work.then((ok) => ({ timedOut: false as const, started: ok })),
            new Promise<{ timedOut: true; started: false }>((resolve) => {
              drainTimer = setTimeout(() => {
                drainTimer = null;
                resolve({ timedOut: true, started: false });
              }, VOICE_HOLD_FAILED_DRAIN_TIMEOUT_MS);
            }),
          ]);
          if (drainTimer !== null) {
            clearTimeout(drainTimer);
            drainTimer = null;
          }
          timedOut = raceResult.timedOut;
          started = raceResult.started;
        } else {
          started = await work;
        }

        if (
          timedOut
          || tx.settled
          || outcome === 'failed'
          || tx.phase === 'failed'
          || !started
          || (!tx.didStartRecording && !tx.transcript.trim())
          || tx.error !== null
          || !mountedRef.current
        ) {
          if (
            !didPreRecordingFallback
            && (!started || !tx.didStartRecording || tx.error !== null || timedOut)
            && !tx.didStartRecording
            && mountedRef.current
          ) {
            fallbackToComposerClick(tx.pointerType);
          }
          tx.settled = true;
          tx.phase = 'settled';
          closeVoiceHoldHud();
          return;
        }

        const spoken = tx.transcript.trim();
        const base = tx.baseText;
        const combined = base
          ? (spoken ? `${base}${base.endsWith(' ') || base.endsWith('\n') ? '' : ' '}${spoken}` : base)
          : spoken;

        if (outcome === 'edit') {
          triggerVoiceHoldHaptic('light', 12);
          tx.settled = true;
          tx.phase = 'settled';
          closeVoiceHoldHud();
          setVoiceOverlayInitialText(combined);
          setVoiceOverlayAutoStart(false);
          setVoiceOpen(true);
          return;
        }
        if (spoken && combined.trim()) {
          const dropY = computeVoiceHoldDropOffsetPx(voiceHoldTranscriptRef.current, divRef.current);
          tx.phase = 'dropping';
          if (mountedRef.current) {
            setVoiceHoldDropY(dropY);
            setVoiceHoldPhase('dropping');
          }
          const completed = await waitForVoiceHoldDrop();
          if (!completed || tx.settled || !mountedRef.current) {
            return;
          }
          tx.settled = true;
          tx.phase = 'settled';
          closeVoiceHoldHud();
          const finalText = combined.trim();
          const restoreFromModal = () => restoreVoiceHoldToComposer(finalText, false);
          const sendOutcome = handleVoiceSend(finalText, {
            onRejected: restoreFromModal,
            onPendingCanceled: restoreFromModal,
          });
          if (sendOutcome === 'rejected') {
            restoreVoiceHoldToComposer(finalText, tx.pointerType === 'touch');
          } else {
            triggerVoiceHoldHaptic('success', 18);
          }
          return;
        }
        tx.settled = true;
        tx.phase = 'settled';
        closeVoiceHoldHud();
      } finally {
        if (drainTimer !== null) {
          clearTimeout(drainTimer);
          drainTimer = null;
        }
        if (!tx.settled) {
          tx.settled = true;
          tx.phase = 'settled';
        }
        if (mountedRef.current && voiceHoldTxRef.current === tx) {
          closeVoiceHoldHud();
        }
        if (voiceHoldTxRef.current === tx) {
          voiceHoldTxRef.current = null;
        }
      }
    })();

    return tx.drainPromise;
  }, [
    closeVoiceHoldHud,
    fallbackToComposerClick,
    handleVoiceSend,
    releaseVoiceHoldInteraction,
    resetVoiceHoldInteractionState,
    restoreVoiceHoldToComposer,
    waitForVoiceHoldDrop,
  ]);

  const retireOrphanedVoiceHold = useCallback(() => {
    const orphanTx = voiceHoldTxRef.current;
    if (orphanTx && !orphanTx.settled && orphanTx.awaitingNativePermission) {
      orphanTx.settled = true;
      orphanTx.phase = 'settled';
      if (voiceHoldTxRef.current === orphanTx) {
        voiceHoldTxRef.current = null;
      }
      resetVoiceHoldInteractionState();
      return;
    }
    if (
      orphanTx
      && !orphanTx.settled
      && orphanTx.drainPromise === null
      && (orphanTx.phase === 'starting' || orphanTx.phase === 'recording' || orphanTx.phase === 'ended')
    ) {
      void finalizeVoiceHold(orphanTx, 'cancel');
      return;
    }
    didPrimeVoiceGestureRef.current = false;
    cancelVoiceInputGesturePrime();
    if (orphanTx && !orphanTx.settled && orphanTx.drainPromise !== null) {
      releaseVoiceHoldInteraction();
      return;
    }
    resetVoiceHoldInteractionState();
  }, [finalizeVoiceHold, releaseVoiceHoldInteraction, resetVoiceHoldInteractionState]);

  const handleComposerVoiceLostPointerCapture = useCallback((event: PointerEvent) => {
    if (handledVoicePointerEventsRef.current.has(event)) return;
    handledVoicePointerEventsRef.current.add(event);
    if (event.isPrimary === false) return;
    const ptr = voiceHoldPointerRef.current;
    if (!ptr) return;
    if (event.pointerId !== undefined && event.pointerId !== ptr.id) return;
    const tx = voiceHoldTxRef.current;
    if (tx && (tx.settled || tx.phase === 'draining' || tx.phase === 'dropping' || tx.drainPromise !== null)) {
      return;
    }
    // Capture loss is non-terminal across pending/primed/starting/recording:
    // keep the hold timer, primed capture, and window pointerup/cancel tracking alive.
    ptr.captureLost = true;
  }, []);

  /** Transition a pending pointer press into active voice capture (shared by hold timer and slide promotion). */
  const activateComposerVoiceHold = useCallback((
    ptr: NonNullable<typeof voiceHoldPointerRef.current>,
    initialDx = 0,
    captureTarget?: EventTarget | null,
  ) => {
    clearVoiceHoldTimers();
    pendingMobileInitialEndFocusRef.current = null;
    didPrimeVoiceGestureRef.current = false;
    setComposerVoicePending(false);
    if (!mountedRef.current || voiceHoldTxRef.current !== null) {
      voiceHoldPointerRef.current = null;
      clearComposerVoiceWindowListeners();
      if (mountedRef.current && !inputDisabledRef.current) {
        fallbackToComposerClick(ptr.pointerType);
      } else {
        clearComposerVoiceTouchLock(
          divRef.current,
          inputDisabledRef.current || (voiceHoldReadyRef.current && !composerFocusedRef.current),
        );
      }
      return;
    }

    // Dismiss any active keyboard, selection, or iOS magnifying loupe before starting voice capture.
    updateComposerFocused(false);
    applyComposerVoiceTouchLock(divRef.current, true);
    try { divRef.current?.blur(); } catch { /* ignore */ }
    try { window.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
    triggerVoiceHoldHaptic('medium', 20);

    // Defer setPointerCapture until hold actually activates so normal taps and scrolling stay interference-free.
    const captureEl = captureTarget instanceof HTMLElement ? captureTarget : divRef.current;
    try {
      captureEl?.setPointerCapture?.(ptr.id);
    } catch { /* ignore unsupported pointer capture */ }

    const base = divRef.current ? readComposerElementText(divRef.current) : '';
    const tx = {
      id: ++voiceHoldTokenRef.current,
      baseText: base,
      transcript: '',
      zone: 'send' as 'send' | 'cancel' | 'edit',
      phase: 'starting' as 'starting' | 'recording' | 'ended' | 'draining' | 'dropping' | 'failed' | 'settled',
      error: null as string | null,
      pointerType: ptr.pointerType,
      hudShownAt: Date.now(),
      readyHapticFired: false,
      didStartRecording: false,
      settled: false,
      startSettled: false,
      awaitingNativePermission: false,
      pointerEndedDuringPermissionPrompt: null as 'up' | 'cancel' | null,
      startPromise: null as Promise<boolean> | null,
      drainPromise: null as Promise<void> | null,
    };
    voiceHoldTxRef.current = tx;
    voiceHoldActiveRef.current = true;
    voiceHoldZoneRef.current = 'send';
    voiceHoldLiveAudioRef.current = false;
    voiceHoldDragXRef.current = 0;
    voiceHoldHudRef.current?.resetBars();
    voiceHoldHudRef.current?.setDragX(0);
    setVoiceHoldText('');
    setVoiceHoldZone('send');
    setVoiceHoldDropY(null);
    setVoiceHoldBottomClearance(measureVoiceHoldBottomClearance());
    setVoiceHoldPhase('starting');
    setVoiceHoldLiveAudio(false);
    setVoiceHoldRecognizing(false);
    setVoiceHoldActive(true);
    setVoiceHoldHudActive(true);
    setVoiceHoldService(getActiveVoiceServiceFrom(VoiceInput));
    if (initialDx !== 0) {
      updateVoiceHoldZoneFromDx(tx, initialDx, false);
    }

    const failTransaction = (errCode: string) => {
      if (voiceHoldTxRef.current !== tx || tx.settled || tx.error !== null) return;
      clearVoiceHoldStartTimeout(tx);
      tx.phase = 'failed';
      tx.error = errCode || 'permission_denied';
      if (mountedRef.current) {
        setVoiceHoldError(tx.error);
      }
      if (tx.drainPromise !== null) {
        closeVoiceHoldHud();
        return;
      }
      void finalizeVoiceHold(tx, 'failed');
    };

    const beginVoiceHoldCapture = () => {
      if (voiceHoldTxRef.current !== tx || tx.settled || tx.error !== null) return;
      clearVoiceHoldStartTimeout();
      voiceHoldStartTimeoutOwnerRef.current = tx;
      voiceHoldStartTimeoutRef.current = setTimeout(() => {
        if (voiceHoldStartTimeoutOwnerRef.current !== tx) return;
        voiceHoldStartTimeoutRef.current = null;
        voiceHoldStartTimeoutOwnerRef.current = null;
        if (
          voiceHoldTxRef.current === tx
          && tx.phase === 'starting'
          && !tx.settled
          && tx.drainPromise === null
        ) {
          failTransaction('Speech recognition timed out');
        }
      }, VOICE_HOLD_START_TIMEOUT_MS);

      setVoiceInputModelLoadingHandler((loading) => {
        if (
          !mountedRef.current
          || voiceHoldTxRef.current !== tx
          || tx.settled
          || tx.error !== null
          || (tx.phase !== 'starting' && tx.phase !== 'recording')
        ) return;
        setVoiceModelLoading(loading);
      });

      VoiceInput.onAudioLevel((rawLevel) => {
        if (
          !mountedRef.current
          || voiceHoldTxRef.current !== tx
          || tx.settled
          || tx.error !== null
          || (tx.phase !== 'starting' && tx.phase !== 'recording')
        ) return;
        const raw = Math.max(0, Math.min(1, Number.isFinite(rawLevel) ? rawLevel : 0));
        const level = normalizeVoiceWaveformLevel(raw);
        if (level > 0.02 && !voiceHoldLiveAudioRef.current) {
          voiceHoldLiveAudioRef.current = true;
          setVoiceHoldLiveAudio(true);
        }
        if (raw > 0.025) pulseVoiceHoldRecognizing(1800);
        voiceHoldHudRef.current?.pushLevel(level);
      });

      tx.startPromise = VoiceInput.startListening(
        (partial) => {
          if (voiceHoldTxRef.current !== tx || tx.settled || tx.error !== null) return;
          tx.transcript = partial;
          if (tx.phase === 'starting' && partial.trim()) {
            clearVoiceHoldStartTimeout(tx);
            tx.didStartRecording = true;
            tx.phase = 'recording';
            if (mountedRef.current) {
              setVoiceHoldPhase('recording');
            }
          }
          if (
            mountedRef.current
            && voiceHoldTxRef.current === tx
            && (tx.phase === 'starting' || tx.phase === 'recording' || tx.phase === 'draining')
          ) {
            setVoiceHoldText(partial);
            if (tx.phase === 'starting' || tx.phase === 'recording') {
              pulseVoiceHoldRecognizing(900);
            }
          }
        },
        (listening) => {
          if (voiceHoldTxRef.current !== tx || tx.settled || tx.error !== null) return;
          if (listening) {
            if (tx.phase !== 'starting' && tx.phase !== 'recording') return;
            const wasStarting = tx.phase === 'starting';
            clearVoiceHoldStartTimeout(tx);
            tx.didStartRecording = true;
            tx.phase = 'recording';
            if (wasStarting && !tx.readyHapticFired && Date.now() - tx.hudShownAt >= 120) {
              tx.readyHapticFired = true;
              triggerVoiceHoldHaptic('light', 12);
            }
            if (mountedRef.current) {
              setVoiceHoldPhase('recording');
            }
            return;
          }
          if (tx.phase === 'starting' && !tx.didStartRecording) {
            failTransaction('permission_denied');
            return;
          }
          if (tx.phase !== 'recording') return;
          tx.phase = 'ended';
          if (voiceHoldRecognizingTimerRef.current !== null) {
            clearTimeout(voiceHoldRecognizingTimerRef.current);
            voiceHoldRecognizingTimerRef.current = null;
          }
          voiceHoldLiveAudioRef.current = false;
          voiceHoldHudRef.current?.resetBars();
          if (mountedRef.current) {
            setVoiceHoldPhase('ended');
            setVoiceHoldRecognizing(false);
            setVoiceHoldLiveAudio(false);
          }
        },
        (err) => {
          failTransaction(err || 'permission_denied');
        },
      ).then(
        (started) => {
          tx.startSettled = true;
          if (voiceHoldTxRef.current !== tx || tx.settled) {
            return false;
          }
          if (!started || tx.error !== null) {
            clearVoiceHoldStartTimeout(tx);
            if (tx.drainPromise === null) {
              failTransaction(tx.error ?? 'permission_denied');
            }
            return false;
          }
          if (tx.didStartRecording && tx.phase === 'starting') {
            clearVoiceHoldStartTimeout(tx);
            tx.phase = 'recording';
          }
          return true;
        },
        (err) => {
          tx.startSettled = true;
          if (voiceHoldTxRef.current !== tx || tx.settled) {
            return false;
          }
          clearVoiceHoldStartTimeout(tx);
          if (tx.drainPromise === null) {
            failTransaction(err instanceof Error ? err.message : 'permission_denied');
          }
          return false;
        },
      );
    };

    const isCapacitorNativeFn = readVoiceInputMethod<() => boolean>('isCapacitorNative');
    const ensureNativeMicPermissionForHoldFn = readVoiceInputMethod<() => Promise<{ granted: boolean; prompted: boolean }>>(
      'ensureNativeMicPermissionForHold',
    );
    const isNativeMicPermissionKnownGrantedFn = readVoiceInputMethod<() => boolean>(
      'isNativeMicPermissionKnownGranted',
    );
    const shouldPreflightNativeMic =
      isCapacitorNativeFn?.() === true
      && typeof ensureNativeMicPermissionForHoldFn === 'function'
      && isNativeMicPermissionKnownGrantedFn?.() !== true;

    if (shouldPreflightNativeMic && ensureNativeMicPermissionForHoldFn) {
      tx.awaitingNativePermission = true;
      void ensureNativeMicPermissionForHoldFn().then(
        ({ granted, prompted }) => {
          tx.awaitingNativePermission = false;
          if (!mountedRef.current || voiceHoldTxRef.current !== tx || tx.settled || tx.phase === 'failed') {
            return;
          }
          if (!granted) {
            failTransaction('permission_denied');
            return;
          }
          if (prompted) {
            // System permission dialog interrupted touch input: settle quietly with no error
            // so the user's very next hold starts recording right away.
            clearVoiceHoldStartTimeout(tx);
            tx.settled = true;
            tx.phase = 'settled';
            if (voiceHoldTxRef.current === tx) {
              voiceHoldTxRef.current = null;
            }
            resetVoiceHoldInteractionState();
            closeVoiceHoldHud();
            return;
          }
          const endedDuringCheck = tx.pointerEndedDuringPermissionPrompt;
          if (endedDuringCheck === 'cancel') {
            void finalizeVoiceHold(tx, 'cancel');
            return;
          }
          if (endedDuringCheck === 'up') {
            fallbackToComposerClick(tx.pointerType);
            clearVoiceHoldStartTimeout(tx);
            tx.settled = true;
            tx.phase = 'settled';
            if (voiceHoldTxRef.current === tx) {
              voiceHoldTxRef.current = null;
            }
            resetVoiceHoldInteractionState();
            closeVoiceHoldHud();
            return;
          }
          beginVoiceHoldCapture();
        },
        () => {
          tx.awaitingNativePermission = false;
          failTransaction('permission_denied');
        },
      );
      return;
    }

    beginVoiceHoldCapture();
  }, [
    clearComposerVoiceWindowListeners,
    clearVoiceHoldStartTimeout,
    closeVoiceHoldHud,
    fallbackToComposerClick,
    finalizeVoiceHold,
    pulseVoiceHoldRecognizing,
    updateVoiceHoldZoneFromDx,
  ]);

  const handleComposerVoicePointerDown = useCallback((event: PointerEvent) => {
    if (handledVoicePointerEventsRef.current.has(event)) return;
    handledVoicePointerEventsRef.current.add(event);
    suppressComposerClickFocusRef.current = false;
    if (suppressComposerClickTimerRef.current !== null) {
      clearTimeout(suppressComposerClickTimerRef.current);
      suppressComposerClickTimerRef.current = null;
    }
    const mobile = typeof window !== 'undefined' && window.innerWidth <= 640;
    if (!mobile || inputDisabled || voiceOpen) return;
    if (event.button !== undefined && event.button !== 0) return;
    if (event.isPrimary === false) return;

    if (voiceHoldActiveRef.current || voiceHoldPendingRef.current || voiceHoldPointerRef.current !== null) {
      // A primary pointerdown cannot legitimately begin while a previous primary pointer
      // is still physically held; recover any orphaned pending/active lease whose
      // terminal pointerup/pointercancel was lost after capture loss or OS interruption.
      retireOrphanedVoiceHold();
    }

    const el = divRef.current;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const isFocusedEditable = !!el
      && (active === el || (active !== null && el.contains(active)))
      && el.getAttribute('contenteditable') !== 'false';
    if (isFocusedEditable) {
      // Once the composer is focused / IME is active, all taps, moves, and
      // long-presses stay 100% native so selection, cursor placement, and
      // copy/paste callouts are never hijacked by voice capture or touch locks.
      pendingMobileInitialEndFocusRef.current = null;
      return;
    }

    // Track initial unfocused mobile tap intent regardless of VoiceInput availability so
    // the first tap onto an already contenteditable="true" composer places caret at END
    // even when browser mousedown/focus fires before click.
    pendingMobileInitialEndFocusRef.current = {
      pointerId: event.pointerId ?? 1,
      startX: event.clientX ?? 0,
      startY: event.clientY ?? 0,
      pointerType: event.pointerType || 'touch',
    };

    if (!VoiceInput.isAvailable()) return;
    // Never call event.preventDefault() on pointerdown: doing so suppresses
    // iOS/Android native tap-to-focus and prevents the soft keyboard / IME
    // from opening when tapping the composer. While an earlier drain settles,
    // pointerdown still tracks short taps cleanly and falls back to typing if
    // hold cannot acquire the mic.
    setVoiceHoldError((prev) => (prev === null ? prev : null));
    const pointerId = event.pointerId ?? 1;
    const pointerType = event.pointerType || 'touch';
    const startX = event.clientX ?? 0;
    const startY = event.clientY ?? 0;
    const now = Date.now();
    const ptr = {
      id: pointerId,
      startX,
      startY,
      wasFocused: false,
      pointerType,
      slideIntentDx: null as number | null,
      downAt: now,
      lastActivityAt: now,
      captureLost: false,
    };
    voiceHoldPointerRef.current = ptr;
    setComposerVoicePending(true);
    applyComposerVoiceTouchLock(el, false);
    attachComposerVoiceWindowListeners();
    if (voiceHoldTxRef.current === null && shouldPrimeVoiceInputOnPointerDown()) {
      didPrimeVoiceGestureRef.current = primeVoiceInputGesture({ deferAudioPause: true });
    }

    if (voiceHoldTimerRef.current !== null) clearTimeout(voiceHoldTimerRef.current);
    voiceHoldTimerRef.current = setTimeout(() => {
      activateComposerVoiceHold(ptr, 0, el);
    }, VOICE_HOLD_UNFOCUSED_DELAY_MS);
  }, [
    inputDisabled,
    voiceOpen,
    activateComposerVoiceHold,
    attachComposerVoiceWindowListeners,
    retireOrphanedVoiceHold,
    setComposerVoicePending,
  ]);

  const handleComposerVoicePointerMove = useCallback((event: PointerEvent) => {
    if (handledVoicePointerEventsRef.current.has(event)) return;
    handledVoicePointerEventsRef.current.add(event);
    if (event.isPrimary === false) return;
    const ptr = voiceHoldPointerRef.current;
    const tx = voiceHoldTxRef.current;
    if (ptr && event.pointerId !== undefined && event.pointerId !== ptr.id) return;
    if (!ptr && !tx) {
      const pendingEndFocus = pendingMobileInitialEndFocusRef.current;
      if (pendingEndFocus && (event.pointerId === undefined || event.pointerId === pendingEndFocus.pointerId)) {
        const dist = Math.hypot((event.clientX ?? 0) - pendingEndFocus.startX, (event.clientY ?? 0) - pendingEndFocus.startY);
        if (dist > VOICE_HOLD_MOVE_SLOP_PX) {
          pendingMobileInitialEndFocusRef.current = null;
        }
      }
      return;
    }
    if (ptr) {
      ptr.lastActivityAt = Date.now();
    }

    if (!tx) {
      if (!ptr) return;
      const dx = (event.clientX ?? 0) - ptr.startX;
      const dy = (event.clientY ?? 0) - ptr.startY;
      const dist = Math.hypot(dx, dy);
      const elapsed = Date.now() - ptr.downAt;
      const hasHorizontalSlideIntent =
        !ptr.wasFocused
        && Math.abs(dx) >= VOICE_HOLD_SLIDE_PROMOTE_PX
        && Math.abs(dx) > Math.abs(dy) * 1.2;

      // Never start mic capture inside the <=140ms tap protection window;
      // past 90ms recognize horizontal intent and promote once the tap guard clears.
      if (hasHorizontalSlideIntent && elapsed >= VOICE_HOLD_TAP_GUARD_MS) {
        if (event.cancelable) event.preventDefault();
        activateComposerVoiceHold(ptr, dx, divRef.current);
        return;
      }
      if (hasHorizontalSlideIntent && elapsed >= VOICE_HOLD_SLIDE_INTENT_MS) {
        ptr.slideIntentDx = dx;
        if (voiceHoldSlideTimerRef.current === null) {
          const remainingMs = Math.max(1, VOICE_HOLD_TAP_GUARD_MS - elapsed);
          voiceHoldSlideTimerRef.current = setTimeout(() => {
            voiceHoldSlideTimerRef.current = null;
            if (voiceHoldPointerRef.current !== ptr || voiceHoldTxRef.current !== null) return;
            activateComposerVoiceHold(ptr, ptr.slideIntentDx ?? 0, divRef.current);
          }, remainingMs);
        }
        return;
      }
      ptr.slideIntentDx = null;
      if (voiceHoldSlideTimerRef.current !== null) {
        clearTimeout(voiceHoldSlideTimerRef.current);
        voiceHoldSlideTimerRef.current = null;
      }
      if (dist > VOICE_HOLD_MOVE_SLOP_PX) {
        const isStrongVerticalScroll =
          Math.abs(dy) >= VOICE_HOLD_SCROLL_ABORT_PX
          && Math.abs(dy) > Math.abs(dx) * 1.5;
        resetVoiceHoldInteractionState();
        if (!isStrongVerticalScroll) {
          fallbackToComposerClick(ptr.pointerType);
        } else {
          didPrimeVoiceGestureRef.current = false;
          cancelVoiceInputGesturePrime();
        }
      }
      return;
    }
    if (tx.phase !== 'starting' && tx.phase !== 'recording' && tx.phase !== 'ended') {
      if (tx.phase === 'failed') {
        void finalizeVoiceHold(tx, 'failed');
      }
      return;
    }
    if (!ptr) return;

    const dx = (event.clientX ?? 0) - ptr.startX;
    event.preventDefault();
    updateVoiceHoldZoneFromDx(tx, dx);
  }, [
    activateComposerVoiceHold,
    fallbackToComposerClick,
    finalizeVoiceHold,
    resetVoiceHoldInteractionState,
    updateVoiceHoldZoneFromDx,
  ]);

  const handleComposerVoicePointerEnd = useCallback((event: PointerEvent, cancelled = false) => {
    if (handledVoicePointerEventsRef.current.has(event)) return;
    handledVoicePointerEventsRef.current.add(event);
    if (event.isPrimary === false) return;
    const ptr = voiceHoldPointerRef.current;
    const tx = voiceHoldTxRef.current;
    if (ptr && event.pointerId !== undefined && event.pointerId !== ptr.id) return;
    if (!ptr && !tx) {
      const pendingEndFocus = pendingMobileInitialEndFocusRef.current;
      if (
        pendingEndFocus
        && (event.pointerId === undefined || event.pointerId === pendingEndFocus.pointerId)
      ) {
        if (cancelled) {
          pendingMobileInitialEndFocusRef.current = null;
        } else if ((event.pointerType || pendingEndFocus.pointerType) === 'touch') {
          armTouchTapCompatMouseShield();
        }
      }
      return;
    }
    const resolvedPointerType = ptr?.pointerType || event.pointerType || tx?.pointerType || 'touch';
    voiceHoldPointerRef.current = null;
    setComposerVoicePending(false);

    if (voiceHoldTimerRef.current !== null || voiceHoldSlideTimerRef.current !== null || !tx) {
      clearVoiceHoldTimers();
      clearComposerVoiceWindowListeners();
      // Any short release or pending pointercancel before active recording focuses typing immediately,
      // then cleans up any primed gesture after focus is in place.
      fallbackToComposerClick(resolvedPointerType);
      return;
    }

    clearComposerVoiceWindowListeners();
    if (tx.settled || tx.drainPromise !== null) {
      if (!tx.didStartRecording && (tx.phase === 'failed' || tx.error !== null)) {
        fallbackToComposerClick(resolvedPointerType);
      }
      return;
    }
    if (tx.awaitingNativePermission) {
      event.preventDefault();
      tx.pointerEndedDuringPermissionPrompt = cancelled ? 'cancel' : 'up';
      applyComposerVoiceTouchLock(divRef.current, false);
      return;
    }
    event.preventDefault();
    if ((cancelled || tx.error !== null) && !tx.didStartRecording) {
      try { divRef.current?.blur(); } catch { /* ignore */ }
      void finalizeVoiceHold(tx, 'failed');
      return;
    }
    suppressComposerClickFocusRef.current = true;
    if (suppressComposerClickTimerRef.current !== null) {
      clearTimeout(suppressComposerClickTimerRef.current);
    }
    suppressComposerClickTimerRef.current = setTimeout(() => {
      suppressComposerClickTimerRef.current = null;
      suppressComposerClickFocusRef.current = false;
    }, 80);
    try { divRef.current?.blur(); } catch { /* ignore */ }
    const finalZone: 'send' | 'cancel' | 'edit' = cancelled ? 'cancel' : tx.zone;
    void finalizeVoiceHold(tx, tx.error !== null ? 'failed' : finalZone);
  }, [armTouchTapCompatMouseShield, clearComposerVoiceWindowListeners, fallbackToComposerClick, finalizeVoiceHold]);

  voicePointerMoveHandlerRef.current = handleComposerVoicePointerMove;
  voicePointerEndHandlerRef.current = handleComposerVoicePointerEnd;

  useEffect(() => {
    const el = divRef.current;
    if (!el) return;
    const onDown = (e: Event) => handleComposerVoicePointerDown(e as PointerEvent);
    const onMove = (e: Event) => handleComposerVoicePointerMove(e as PointerEvent);
    const onUp = (e: Event) => handleComposerVoicePointerEnd(e as PointerEvent, false);
    const onCancel = (e: Event) => handleComposerVoicePointerEnd(e as PointerEvent, true);
    const onLostCapture = (e: Event) => handleComposerVoiceLostPointerCapture(e as PointerEvent);
    const onSelectStart = (e: Event) => {
      if (voiceHoldPendingRef.current || voiceHoldActiveRef.current) {
        e.preventDefault();
      }
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('lostpointercapture', onLostCapture);
    el.addEventListener('selectstart', onSelectStart);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('lostpointercapture', onLostCapture);
      el.removeEventListener('selectstart', onSelectStart);
    };
  }, [handleComposerVoiceLostPointerCapture, handleComposerVoicePointerDown, handleComposerVoicePointerMove, handleComposerVoicePointerEnd]);

  useEffect(() => {
    const initialEl = divRef.current;
    return () => {
      if (suppressComposerClickTimerRef.current !== null) {
        clearTimeout(suppressComposerClickTimerRef.current);
        suppressComposerClickTimerRef.current = null;
      }
      if (suppressNextVoiceButtonClickTimerRef.current !== null) {
        clearTimeout(suppressNextVoiceButtonClickTimerRef.current);
        suppressNextVoiceButtonClickTimerRef.current = null;
      }
      suppressNextVoiceButtonClickRef.current = false;
      suppressComposerClickFocusRef.current = false;
      disarmTouchTapCompatMouseShield();
      clearVoiceHoldTimers();
      clearComposerVoiceWindowListeners();
      didPrimeVoiceGestureRef.current = false;
    cancelVoiceInputGesturePrime();
      voiceHoldPointerRef.current = null;
      voiceHoldPendingRef.current = false;
      clearComposerVoiceTouchLock(divRef.current ?? initialEl, inputDisabledRef.current);
      const tx = voiceHoldTxRef.current;
      if (tx) {
        tx.settled = true;
        tx.phase = 'settled';
        voiceHoldTxRef.current = null;
      }
      if (voiceHoldActiveRef.current) {
        voiceHoldActiveRef.current = false;
        VoiceInput.onAudioLevel(null);
        setVoiceInputModelLoadingHandler(null);
        setVoiceModelLoading(false);
        void VoiceInput.stopListening({ abort: true });
      }
    };
  }, [clearComposerVoiceWindowListeners, clearVoiceHoldTimers, disarmTouchTapCompatMouseShield]);

  useLayoutEffect(() => {
    if (!voiceHoldHudActive || voiceHoldPhase === 'dropping') return;
    const el = voiceHoldTranscriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [voiceHoldHudActive, voiceHoldPhase, voiceHoldText]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (imeComposingRef.current || isImeComposingKeyEvent(e)) return;

    // When @ picker is open, it owns Enter/Arrow/Escape.
    if (atPickerOpen && (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape')) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (quickSuggestionKind !== null) {
      if (handleQuickSuggestionNavigationKey(e)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setQuickSuggestionKind(null);
        setQuickSuggestionQuery('');
        return;
      }
      if (quickSuggestionKind === 'skill' && (e.key === 'Tab' || e.key === 'Enter')) {
        if (skillSuggestions.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          const skill = skillSuggestions[activeQuickSuggestionIndex];
          if (skill) selectSkillSuggestion(skill);
          return;
        }
        // A failed/empty skill lookup must not consume Enter; it remains the
        // ordinary send key so typing can continue without a dead composer.
        if (e.key === 'Tab') return;
      }
      const exactCommand = quickSuggestionKind === 'command'
        ? quickSuggestions.find(
            (command) => command.toLocaleLowerCase() === `/${quickSuggestionQuery}`.toLocaleLowerCase(),
          )
        : undefined;
      if (e.key === 'Enter' && exactCommand?.toLocaleLowerCase() === SESSION_MODEL_COMMAND) {
        e.preventDefault();
        e.stopPropagation();
        selectQuickSuggestion(exactCommand);
        return;
      }
      if (quickSuggestionKind === 'command' && e.key === 'Enter' && quickSuggestions.some(
        (command) => command.toLocaleLowerCase() === `/${quickSuggestionQuery}`.toLocaleLowerCase(),
      )) {
        // A fully typed command keeps the established one-Enter send behavior.
        // Only incomplete queries (or Tab) are claimed as autocomplete picks.
        setQuickSuggestionKind(null);
        setQuickSuggestionQuery('');
      } else if ((e.key === 'Tab' || e.key === 'Enter') && quickSuggestions.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        const suggestion = quickSuggestions[activeQuickSuggestionIndex];
        if (suggestion) selectQuickSuggestion(suggestion);
        return;
      }
    }

    // When the inline `;` alias picker is open, it owns Enter/Tab/Arrow/Escape.
    // Enter/Tab on a highlighted row inserts the marker; with no results Enter
    // still falls through to normal send (the picker only claims Enter when it
    // can accept something). With the picker CLOSED, none of this runs and
    // Enter reaches the normal send path below.
    if (aliasPickerOpen) {
      if (handleAliasNavigationKey(e)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setAliasPickerOpen(false);
        setAliasQuery('');
        return;
      }
      if ((e.key === 'Tab' || e.key === 'Enter') && aliasFiltered.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        const chosen = aliasFiltered[activeAliasIndex];
        setAliasPickerOpen(false);
        setAliasQuery('');
        aliasJustClosedRef.current = true;
        setTimeout(() => { aliasJustClosedRef.current = false; }, 150);
        if (chosen) insertAliasMarker(chosen.name);
        return;
      }
    }

    // When the inline `^` machine picker is open, it owns Enter/Tab/Arrow/Escape,
    // mirroring the alias picker. Online state never changes selectability.
    if (machinePickerOpen) {
      const count = visibleMachines.length;
      if (handleMachineNavigationKey(e)) return;
      if (machineGroups.length > 0 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        e.stopPropagation();
        const delta = e.key === 'ArrowLeft' ? -1 : 1;
        setMachineGroup(stepMachineGroupTab(machineAll, activeMachineGroup, delta));
        setMachineHighlightIdx(0);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMachinePickerOpen(false);
        setMachineQuery('');
        return;
      }
      if ((e.key === 'Tab' || e.key === 'Enter') && count > 0) {
        e.preventDefault();
        e.stopPropagation();
        const chosen = visibleMachines[activeMachineIndex];
        setMachinePickerOpen(false);
        setMachineQuery('');
        machineJustClosedRef.current = true;
        setTimeout(() => { machineJustClosedRef.current = false; }, 150);
        if (chosen?.nodeId) insertMachineMarker(chosen.nodeId, chosen.displayName);
        return;
      }
    }

    if (taskPairPickerOpen) {
      if (handleTaskPairNavigationKey(e)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setTaskPairPickerOpen(false);
        setTaskPairQuery('');
        return;
      }
      if ((e.key === 'Tab' || e.key === 'Enter') && filteredTaskPairReferences.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        const chosen = filteredTaskPairReferences[activeTaskPairIndex];
        setTaskPairPickerOpen(false);
        setTaskPairQuery('');
        taskPairJustClosedRef.current = true;
        setTimeout(() => { taskPairJustClosedRef.current = false; }, 150);
        if (chosen) insertTaskPairReference(chosen.title);
        return;
      }
    }

    if (cloudDocPickerOpen) {
      const isPostCompositionCommitWindow = cloudDocImeCommitAtRef.current > 0
        && Date.now() - cloudDocImeCommitAtRef.current < 80;
      const isImeCommitKey = !e.ctrlKey && !e.metaKey && !e.altKey
        && ((e.key === 'Enter' && !e.shiftKey) || e.key === ' ' || e.key === 'Tab');
      if (isPostCompositionCommitWindow && isImeCommitKey) {
        // WebKit fires compositionend before the trailing IME commit keydown with
        // isComposing=false; absorb one commit keystroke without selecting or closing.
        cloudDocImeCommitAtRef.current = 0;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      cloudDocImeCommitAtRef.current = 0;
      if (handleCloudDocNavigationKey(e)) return;
      if (e.key === ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        closeCloudDocPicker();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeCloudDocPicker();
        return;
      }
      if (e.key === 'Tab' && filteredCloudDocs.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        const chosen = filteredCloudDocs[activeCloudDocIndex];
        closeCloudDocPicker(true);
        if (chosen) insertCloudDocReference(chosen);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        const chosen = filteredCloudDocs[activeCloudDocIndex];
        closeCloudDocPicker(true);
        if (chosen) insertCloudDocReference(chosen);
        return;
      }
    }

    if (e.key === 'Escape' && handleTransportEscapeCancel(e)) {
      return;
    }

    // Block Enter right after the machine picker closes (the same Enter that
    // accepted a row must not also send).
    if (e.key === 'Enter' && machineJustClosedRef.current) {
      e.preventDefault();
      machineJustClosedRef.current = false;
      return;
    }

    // Block Enter right after the alias picker closes (the same Enter that
    // accepted a row must not also send).
    if (e.key === 'Enter' && aliasJustClosedRef.current) {
      e.preventDefault();
      aliasJustClosedRef.current = false;
      return;
    }
    if (e.key === 'Enter' && taskPairJustClosedRef.current) {
      e.preventDefault();
      taskPairJustClosedRef.current = false;
      return;
    }
    if (e.key === 'Enter' && cloudDocJustClosedRef.current) {
      e.preventDefault();
      cloudDocJustClosedRef.current = false;
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

    // Use session-scoped history, falling back to global history if session has no entries.
    // Never look up per-session history under an incognito session's name.
    const history = getNavigableHistory(quickData.data, activeSessionIncognito ? undefined : activeSession?.name);
    if (
      (e.key === 'ArrowUp' || e.key === 'ArrowDown')
      && !e.metaKey
      && !e.ctrlKey
      && !e.altKey
      && !e.shiftKey
      && history.length > 0
    ) {
      // Only intercept when caret is on first/last visual line to avoid breaking multiline editing
      const atTop = getCaretLineBoundary('up');
      const atBottom = getCaretLineBoundary('down');

      if (e.key === 'ArrowUp' && atTop) {
        e.preventDefault();
        const currentText = divRef.current
          ? readComposerElementText(divRef.current, { preserveEditingLines: true })
          : '';
        syncHistoryEditOrDraft(currentText, history);
        if (histIdxRef.current === -1 && draftKey) {
          safeSessionStorageSetItem(draftKey, draftRef.current);
        }
        const next = Math.min(histIdxRef.current + 1, history.length - 1);
        if (next !== histIdxRef.current || histIdxRef.current === -1) {
          histIdxRef.current = next;
          fillInput(historyEditsRef.current.get(next) ?? history[next]);
        }
        return;
      }

      if (e.key === 'ArrowDown' && atBottom) {
        e.preventDefault();
        if (histIdxRef.current === -1) return;
        const currentText = divRef.current
          ? readComposerElementText(divRef.current, { preserveEditingLines: true })
          : '';
        syncHistoryEditOrDraft(currentText, history);
        const next = histIdxRef.current - 1;
        if (next < 0) {
          histIdxRef.current = -1;
          fillInput(draftRef.current);
        } else {
          histIdxRef.current = next;
          fillInput(historyEditsRef.current.get(next) ?? history[next]);
        }
        return;
      }
    }
  };

  // On mobile, focusing contenteditable can scroll the document body — force it back
  const handleFocus = () => {
    updateComposerFocused(true);
    if (window.scrollY !== 0) window.scrollTo(0, 0);
    if (document.documentElement.scrollTop !== 0) document.documentElement.scrollTop = 0;
    if (document.body.scrollTop !== 0) document.body.scrollTop = 0;
  };

  const handleBlur = () => {
    pendingMobileInitialEndFocusRef.current = null;
    updateComposerFocused(false);
    closeQuickSuggestions();
  };

  const startComposerUploads = useCallback(async (
    entries: ReadonlyArray<{
      file: File;
      clientUploadId?: string;
      fromPersistedStore?: boolean;
      autoRetryEpoch?: string;
      autoRetryCount?: number;
    }>,
  ): Promise<boolean> => {
    if (entries.length === 0 || !serverId) return false;
    setBackgroundTransferKeepAliveLabels({
      title: t('upload.bg_notification_title'),
      text: t('upload.bg_notification_text'),
    });
    const uploadKey = composerUploadKey;
    const uploadAttachmentDraftKey = attachmentDraftKey;
    const uploadSessionName = isShareScopedSession && activeSession?.name ? activeSession.name : undefined;
    const prepared = entries.map((entry) => {
      const now = Date.now();
      const id = createComposerUploadId();
      const clientUploadId = entry.clientUploadId ?? resolveResumableUploadIdentity({
        serverId,
        ...(uploadSessionName ? { sessionName: uploadSessionName } : {}),
        file: entry.file,
      }).clientUploadId;
      return {
        file: entry.file,
        clientUploadId,
        fromPersistedStore: !!entry.fromPersistedStore,
        autoRetryCount: entry.autoRetryCount ?? 0,
        item: {
          id,
          name: entry.file.name || 'file',
          progress: 0,
          status: 'uploading' as const,
          transport: FILE_UPLOAD_TRANSPORT_MODE.CONNECTING,
          totalBytes: entry.file.size,
          startedAt: now,
          lastSampleAt: now,
          lastSampleBytes: 0,
          speedBps: 0,
          updatedAt: now,
          ...(entry.autoRetryEpoch ? { lastAutoRetryEpoch: entry.autoRetryEpoch } : {}),
          ...(entry.autoRetryCount ? { autoRetryCount: entry.autoRetryCount } : {}),
        },
      };
    });
    for (const entry of prepared) {
      composerUploadRetryFiles.set(entry.item.id, entry.file);
      composerUploadClientIds.set(entry.item.id, entry.clientUploadId);
    }
    addComposerUploadItems(uploadKey, prepared.map((entry) => entry.item));

    const settledUploadIds: string[] = [];
    // Uploads run concurrently, but composer sequence numbers follow the
    // user's selection order rather than whichever transfer happens to finish
    // first.  Keep each completed path immediately, then project the completed
    // subset in `prepared` order before the transient row becomes `done`.
    const completedAttachments = new Map<string, ComposerAttachmentRecord>();
    const uploadedAttachments = await Promise.all(prepared.map(async (entry): Promise<ComposerAttachmentRecord | null> => {
      const { file: initialFile, clientUploadId, fromPersistedStore, autoRetryCount, item: uploadItem } = entry;
      let effectiveFile = initialFile;
      const attemptStartEpoch = getComposerUploadWakeEpoch();
      const abortController = new AbortController();
      const persistAbortController = new AbortController();
      const onUploadAbortForPersist = () => persistAbortController.abort();
      abortController.signal.addEventListener('abort', onUploadAbortForPersist, { once: true });
      composerUploadAbortControllers.set(uploadItem.id, abortController);
      try {
        // Stream 4 MiB chunks into IndexedDB (up to 128 MiB total budget) on both
        // web and native before starting transport so the CONNECTING row survives
        // app-switching, WebView reload, and OS temporary-URI eviction.
        if (!fromPersistedStore && !activeSessionIncognito && initialFile.size <= PENDING_UPLOAD_MAX_FILE_BYTES) {
          const persisted = await persistPendingUploadFile({
            clientUploadId,
            serverId,
            sessionName: uploadSessionName ?? '',
            composerKey: uploadKey,
            file: initialFile,
            signal: persistAbortController.signal,
          }).catch((err) => {
            if (err instanceof Error && (err.name === 'AbortError' || err.name === 'NotReadableError')) {
              throw err;
            }
            return { persisted: false, snapshotFile: null as File | null };
          });
          if (abortController.signal.aborted) {
            void deletePendingUpload(clientUploadId);
            throw new DOMException('Aborted', 'AbortError');
          }
          if (persisted.snapshotFile) {
            effectiveFile = persisted.snapshotFile;
            composerUploadRetryFiles.set(uploadItem.id, effectiveFile);
          }
        }

        if (!connectedRef.current || isUploadEnvironmentSuspended()) {
          updateComposerUploadItem(uploadKey, uploadItem.id, {
            status: 'uploading',
            transport: FILE_UPLOAD_TRANSPORT_MODE.CONNECTING,
            waitingForConnection: true,
          });
          return null;
        }

        const result = await uploadFileWithDirectFallback({
          ws,
          serverId,
          ...(uploadSessionName ? { sessionName: uploadSessionName } : {}),
          file: effectiveFile,
          clientUploadId,
          onProgress: (pct) => {
            updateComposerUploadProgress(uploadKey, uploadItem.id, pct);
          },
          onMode: (transport) => {
            updateComposerUploadTransport(uploadKey, uploadItem.id, transport);
          },
          signal: abortController.signal,
        });
        const daemonPath = typeof result.attachment?.daemonPath === 'string'
          ? result.attachment.daemonPath.trim()
          : '';
        // A transfer is not composer-complete until the daemon path has been
        // committed to the attachment list.  In particular, status recovery,
        // relay fallback, retry, and reconnect all resolve through this same
        // branch; marking the progress row done first briefly enabled Send
        // while `attachments` was still empty, which produced text-only sends.
        if (!daemonPath) throw new Error('attachment_path_missing');
        persistAbortController.abort();
        void deletePendingUpload(clientUploadId);
        composerUploadClientIds.delete(uploadItem.id);
        const attachment: ComposerAttachmentRecord = {
          path: daemonPath,
          name: effectiveFile.name,
          seq: 0,
          ...(result.attachment.id ? { id: result.attachment.id } : {}),
          ...(result.attachment.serverId ? { serverId: result.attachment.serverId } : { serverId }),
        };
        rememberAttachmentPreview(daemonPath, effectiveFile);
        completedAttachments.set(uploadItem.id, attachment);
        const orderedCompleted = prepared
          .map((preparedEntry) => completedAttachments.get(preparedEntry.item.id))
          .filter((item): item is ComposerAttachmentRecord => !!item);
        const completedPaths = new Set(orderedCompleted.map((item) => item.path));
        if (uploadAttachmentDraftKey) {
          appendStoredComposerAttachment(uploadAttachmentDraftKey, attachment);
          const stored = parseStoredComposerAttachments(safeSessionStorageGetItem(uploadAttachmentDraftKey));
          const next = renumberAttachments([
            ...stored.filter((item) => !completedPaths.has(item.path)),
            ...orderedCompleted,
          ]);
          // Unbounded: the default draft cap would truncate this JSON.
          safeSessionStorageSetItem(uploadAttachmentDraftKey, JSON.stringify(next), Number.MAX_SAFE_INTEGER);
          if (mountedRef.current && attachmentDraftKeyRef.current === uploadAttachmentDraftKey) {
            setAttachments(next);
          }
        } else {
          setAttachments((prev) => renumberAttachments([
            ...prev.filter((item) => !completedPaths.has(item.path)),
            ...orderedCompleted,
          ]));
        }
        // Keep the path on the transient row as a second invariant: a render
        // that observes `done` can never be mistaken for a sendable upload
        // without a resolved daemon path.
        updateComposerUploadProgress(uploadKey, uploadItem.id, 100);
        updateComposerUploadItem(uploadKey, uploadItem.id, { status: 'done', attachmentPath: daemonPath });
        settledUploadIds.push(uploadItem.id);
        return attachment;
      } catch (err) {
        if (abortController.signal.aborted) {
          persistAbortController.abort();
          void deletePendingUpload(clientUploadId);
          composerUploadClientIds.delete(uploadItem.id);
          removeComposerUploadItems(uploadKey, [uploadItem.id]);
          settledUploadIds.push(uploadItem.id);
          return null;
        }
        console.error('[upload] failed:', err);
        const body = err instanceof Error ? err.message : String(err);
        let errorMessage: string;
        let retryable = true;
        if ((err instanceof Error && err.name === 'NotReadableError') || body.includes('NotReadableError')) {
          errorMessage = t('upload.file_unreadable_reselect');
          retryable = false;
          persistAbortController.abort();
          if (!fromPersistedStore) {
            void deletePendingUpload(clientUploadId);
          }
        } else if (err instanceof DirectFileTransferFailure && err.code === 'relay_size_limit') {
          errorMessage = t('upload.direct_required_large', { max: MAX_UPLOAD_SIZE_MB });
          retryable = false;
          persistAbortController.abort();
          void deletePendingUpload(clientUploadId);
        } else if (
          (err instanceof DirectFileTransferFailure
            && err.code === DIRECT_FILE_TRANSFER_ERROR.INSUFFICIENT_CAPACITY)
          || isInsufficientCapacityError(body)
        ) {
          errorMessage = t('upload.insufficient_capacity');
        } else if (body.includes('daemon_offline')) {
          errorMessage = t('upload.daemon_offline');
        } else if (body.includes('file_too_large')) {
          errorMessage = t('upload.file_too_large', { max: MAX_UPLOAD_SIZE_MB });
          retryable = false;
          persistAbortController.abort();
          void deletePendingUpload(clientUploadId);
        } else {
          errorMessage = t('upload.upload_failed');
        }
        updateComposerUploadItem(uploadKey, uploadItem.id, { status: 'error', retryable, waitingForConnection: false });
        updateComposerUploadSnapshot(uploadKey, { error: errorMessage });
        setTimeout(() => updateComposerUploadSnapshot(uploadKey, { error: null }), 5000);
        if (
          retryable
          && getComposerUploadWakeEpoch() !== attemptStartEpoch
          && connectedRef.current
          && !isUploadEnvironmentSuspended()
          && autoRetryCount < MAX_COMPOSER_AUTO_RETRIES
        ) {
          queueMicrotask(() => {
            if (mountedRef.current) autoRetryFailedUploadsRef.current();
          });
        }
        return null;
      } finally {
        abortController.signal.removeEventListener('abort', onUploadAbortForPersist);
        composerUploadAbortControllers.delete(uploadItem.id);
        recoveredPendingUploadIds.delete(clientUploadId);
      }
    }));

    const successfulAttachments = uploadedAttachments.filter((entry): entry is ComposerAttachmentRecord => !!entry);
    // Successful/canceled rows are transient.  Failed rows deliberately stay
    // visible with a retry action: removing every row here made a 99%-phase
    // failure disappear immediately and look like a silent success/failure.
    removeComposerUploadItems(uploadKey, settledUploadIds);
    for (const id of settledUploadIds) {
      composerUploadRetryFiles.delete(id);
      composerUploadClientIds.delete(id);
    }
    return successfulAttachments.length > 0;
  }, [activeSession?.name, activeSessionIncognito, attachmentDraftKey, composerUploadKey, isShareScopedSession, serverId, t, ws]);

  const uploadAttachmentFiles = useCallback(async (files: readonly File[]): Promise<boolean> => (
    startComposerUploads(files.map((file) => ({ file })))
  ), [startComposerUploads]);


  const handleCancelUpload = useCallback((item: ComposerUploadItem) => {
    if (!window.confirm(t('upload.cancel_confirm', { name: item.name }))) return;
    const clientUploadId = composerUploadClientIds.get(item.id);
    if (clientUploadId) {
      recoveredPendingUploadIds.delete(clientUploadId);
      void deletePendingUpload(clientUploadId);
      composerUploadClientIds.delete(item.id);
    }
    const controller = composerUploadAbortControllers.get(item.id);
    if (controller) {
      controller.abort();
    }
    if (item.waitingForConnection || !controller) {
      composerUploadRetryFiles.delete(item.id);
      composerUploadAbortControllers.delete(item.id);
      removeComposerUploadItems(composerUploadKey, [item.id]);
    }
  }, [composerUploadKey, t]);

  const handleRetryUpload = useCallback((item: ComposerUploadItem) => {
    const file = composerUploadRetryFiles.get(item.id);
    if (!file) return;
    const clientUploadId = composerUploadClientIds.get(item.id);
    composerUploadRetryFiles.delete(item.id);
    composerUploadClientIds.delete(item.id);
    removeComposerUploadItems(composerUploadKey, [item.id]);
    updateComposerUploadSnapshot(composerUploadKey, { error: null });
    void startComposerUploads([{ file, clientUploadId, fromPersistedStore: true }]);
  }, [composerUploadKey, startComposerUploads]);

  const handleDismissFailedUpload = useCallback((item: ComposerUploadItem) => {
    const clientUploadId = composerUploadClientIds.get(item.id);
    if (clientUploadId) {
      recoveredPendingUploadIds.delete(clientUploadId);
      void deletePendingUpload(clientUploadId);
      composerUploadClientIds.delete(item.id);
    }
    composerUploadRetryFiles.delete(item.id);
    removeComposerUploadItems(composerUploadKey, [item.id]);
  }, [composerUploadKey]);

  const autoRetryFailedUploads = useCallback((waitingOnly = false) => {
    if (!connected || isUploadEnvironmentSuspended()) return;
    const wakeEpoch = getComposerUploadWakeEpoch();
    const snapshot = getComposerUploadSnapshot(composerUploadKey);
    const candidates = snapshot.uploads.filter((item) => {
      if (!composerUploadRetryFiles.has(item.id)) return false;
      if (item.status === 'uploading' && item.waitingForConnection) return true;
      if (waitingOnly) return false;
      return item.status === 'error'
        && item.retryable !== false
        && item.lastAutoRetryEpoch !== wakeEpoch
        && (item.autoRetryCount ?? 0) < MAX_COMPOSER_AUTO_RETRIES;
    });
    if (candidates.length === 0) return;
    const entries: Array<{
      file: File;
      clientUploadId?: string;
      fromPersistedStore?: boolean;
      autoRetryEpoch?: string;
      autoRetryCount?: number;
    }> = [];
    const removeIds: string[] = [];
    for (const item of candidates) {
      const file = composerUploadRetryFiles.get(item.id);
      if (!file) continue;
      const clientUploadId = composerUploadClientIds.get(item.id);
      composerUploadRetryFiles.delete(item.id);
      composerUploadClientIds.delete(item.id);
      removeIds.push(item.id);
      entries.push({
        file,
        clientUploadId,
        fromPersistedStore: true,
        ...(item.status === 'error'
          ? { autoRetryEpoch: wakeEpoch, autoRetryCount: (item.autoRetryCount ?? 0) + 1 }
          : {}),
      });
    }
    if (entries.length === 0) return;
    removeComposerUploadItems(composerUploadKey, removeIds);
    updateComposerUploadSnapshot(composerUploadKey, { error: null });
    void startComposerUploads(entries);
  }, [composerUploadKey, connected, startComposerUploads]);

  const autoRetryFailedUploadsRef = useRef(autoRetryFailedUploads);
  autoRetryFailedUploadsRef.current = autoRetryFailedUploads;
  const startComposerUploadsRef = useRef(startComposerUploads);
  startComposerUploadsRef.current = startComposerUploads;
  const prevConnectedForUploadRetryRef = useRef(connected);

  useEffect(() => {
    const wasConnected = prevConnectedForUploadRetryRef.current;
    prevConnectedForUploadRetryRef.current = connected;
    if (!wasConnected && connected) {
      composerUploadConnectEpoch += 1;
    }
    if (!connected) return;
    autoRetryFailedUploadsRef.current(wasConnected);
    const onWake = () => autoRetryFailedUploadsRef.current(false);
    const onOnline = () => {
      composerUploadOnlineEpoch += 1;
      autoRetryFailedUploadsRef.current(false);
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onWake);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onWake);
      window.addEventListener('pageshow', onWake);
      window.addEventListener('online', onOnline);
    }
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onWake);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onWake);
        window.removeEventListener('pageshow', onWake);
        window.removeEventListener('online', onOnline);
      }
    };
  }, [composerUploadKey, connected]);

  useEffect(() => {
    if (!serverId || !composerUploadKey || activeSessionIncognito) return;
    if (attachmentDraftKey && hydratedAttachmentDraftKey !== attachmentDraftKey) return;
    let canceled = false;
    void listPendingUploadsForKey(composerUploadKey, serverId).then((entries) => {
      if (canceled || entries.length === 0) return;
      const snapshot = getComposerUploadSnapshot(composerUploadKey);
      const activeClientIds = new Set(
        snapshot.uploads
          .map((item) => composerUploadClientIds.get(item.id))
          .filter((id): id is string => !!id),
      );
      const pending = entries.filter(({ meta }) => {
        if (activeClientIds.has(meta.clientUploadId)) return false;
        if (recoveredPendingUploadIds.has(meta.clientUploadId)) return false;
        recoveredPendingUploadIds.add(meta.clientUploadId);
        return true;
      });
      if (pending.length === 0) return;
      void startComposerUploadsRef.current(
        pending.map(({ meta, file }) => ({
          file,
          clientUploadId: meta.clientUploadId,
          fromPersistedStore: true,
        })),
      );
    });
    return () => {
      canceled = true;
    };
  }, [activeSessionIncognito, attachmentDraftKey, composerUploadKey, connected, hydratedAttachmentDraftKey, serverId]);

  const handleRemoveAttachment = useCallback(async (attachment: ComposerAttachmentRecord) => {
    closeQuickSuggestions();
    const attachmentKey = attachment.id ?? attachment.path;
    if (deletingAttachmentKeys.has(attachmentKey)) return;
    const inferredId = attachment.id ?? attachment.path.split(/[\\/]/).pop();
    setDeletingAttachmentKeys((current) => new Set(current).add(attachmentKey));
    try {
      if (inferredId && (attachment.serverId || serverId)) {
        if (isShareScopedSession && activeSession?.name) {
          await deleteAttachment(attachment.serverId || serverId!, inferredId, activeSession.name);
        } else {
          await deleteAttachment(attachment.serverId || serverId!, inferredId);
        }
      }
      setAttachments((current) => renumberAttachments(current.filter((entry) => entry !== attachment)));
      forgetAttachmentPreview(attachment.path);
    } catch (error) {
      console.error('[upload] delete failed:', error);
      updateComposerUploadSnapshot(composerUploadKey, { error: t('upload.delete_failed') });
      setTimeout(() => updateComposerUploadSnapshot(composerUploadKey, { error: null }), 5000);
    } finally {
      setDeletingAttachmentKeys((current) => {
        const next = new Set(current);
        next.delete(attachmentKey);
        return next;
      });
    }
  }, [activeSession?.name, closeQuickSuggestions, composerUploadKey, deletingAttachmentKeys, isShareScopedSession, serverId, t]);

  // Voice notepad, after review. A short transcript is one ordinary message
  // through the same send path as dictation. A long one is uploaded as a
  // Markdown file through the same attachment flow a long paste takes, and
  // the message carries the instruction plus the file's reference -- exactly
  // what attaching the file by hand and typing the instruction would send.
  //
  // An uploaded transcript is the notepad's, not the composer's: a retry of
  // the same transcript reuses it, an edited or now-short transcript removes
  // it first, and closing the overlay without sending removes it -- so it can
  // never ride along with some later message.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const notepadUploadRef = useRef<{ transcript: string; fileName: string } | null>(null);
  const abandonedNotepadUploadsRef = useRef(new Set<string>());
  const pendingNotepadAttachmentSendRef = useRef<PendingNotepadAttachmentSend | null>(null);
  const [notepadAttachmentSendTick, setNotepadAttachmentSendTick] = useState(0);

  const sendVoiceNotepadMessage = useCallback((text: string, onAccepted: () => void): VoiceNotepadSendOutcome => {
    const accepted = () => {
      // The composer, uploaded transcript included, has just been cleared.
      notepadUploadRef.current = null;
      onAccepted();
    };
    const outcome = requestSend(buildSendPayload({ textOverride: text }), {
      clearComposer: true,
      retainOnRejection: true,
      onConfirmedAccepted: () => {
        accepted();
        setVoiceOpen(false);
      },
    });
    if (outcome === 'accepted') accepted();
    return outcome;
  }, [buildSendPayload, requestSend]);

  /** Send once the composer's attachments are what the message needs. */
  const sendVoiceNotepadWhenReady = useCallback((
    ready: (attachments: readonly ComposerAttachmentRecord[]) => boolean,
    text: string,
    onAccepted: () => void,
  ): Promise<VoiceNotepadSendOutcome> => new Promise((resolve) => {
    const previous = pendingNotepadAttachmentSendRef.current;
    if (previous) {
      clearTimeout(previous.timer);
      previous.resolve('rejected');
    }
    const pending: PendingNotepadAttachmentSend = {
      ready,
      text,
      onAccepted,
      resolve,
      timer: setTimeout(() => {
        if (pendingNotepadAttachmentSendRef.current !== pending) return;
        pendingNotepadAttachmentSendRef.current = null;
        resolve('rejected');
      }, NOTEPAD_ATTACHMENT_SEND_TIMEOUT_MS),
    };
    pendingNotepadAttachmentSendRef.current = pending;
    setNotepadAttachmentSendTick((tick) => tick + 1);
  }), []);

  const handleVoiceNotepadSend = useCallback(async (
    request: VoiceNotepadSendRequest,
  ): Promise<VoiceNotepadSendOutcome> => {
    const transcript = request.transcript.trim();
    if (!transcript) return 'rejected';
    const attachAsFile = !isShellLike && needsNotepadTranscriptAttachment(transcript);
    if (attachAsFile && !serverId) {
      showSendWarning(t('upload.long_text_requires_attachment'));
      return 'rejected';
    }
    const previous = notepadUploadRef.current;
    const reuse = !!previous && attachAsFile && previous.transcript === transcript
      && attachmentsRef.current.some((attachment) => attachment.name === previous.fileName);
    let staleFileName: string | null = null;
    if (previous && !reuse) {
      notepadUploadRef.current = null;
      staleFileName = previous.fileName;
      const stale = attachmentsRef.current.find((attachment) => attachment.name === previous.fileName);
      if (stale) await handleRemoveAttachment(stale);
      else abandonedNotepadUploadsRef.current.add(previous.fileName);
    }
    const withoutStale = (list: readonly ComposerAttachmentRecord[]) => (
      !staleFileName || !list.some((attachment) => attachment.name === staleFileName)
    );
    if (!attachAsFile) {
      return sendVoiceNotepadWhenReady(
        withoutStale,
        buildNotepadInlineMessage(request.instruction, t('voice.notepad_transcript_label'), transcript),
        request.onAccepted,
      );
    }
    let fileName: string;
    if (reuse && previous) {
      fileName = previous.fileName;
    } else {
      fileName = buildNotepadTranscriptFileName();
      const uploaded = await uploadAttachmentFiles([
        new File([transcript], fileName, { type: 'text/markdown' }),
      ]);
      if (!uploaded) return 'rejected';
      notepadUploadRef.current = { transcript, fileName };
    }
    const reference = t('voice.notepad_transcript_attached', { name: fileName });
    const instruction = request.instruction.trim();
    return sendVoiceNotepadWhenReady(
      (list) => withoutStale(list) && list.some((attachment) => attachment.name === fileName),
      instruction ? `${instruction}\n\n${reference}` : reference,
      request.onAccepted,
    );
  }, [handleRemoveAttachment, isShellLike, sendVoiceNotepadWhenReady, serverId, showSendWarning, t, uploadAttachmentFiles]);

  // Attachment changes land on later renders: send a waiting notepad once
  // the composer is ready for it, and remove abandoned notepad uploads.
  useEffect(() => {
    const pending = pendingNotepadAttachmentSendRef.current;
    if (pending && pending.ready(attachments)) {
      pendingNotepadAttachmentSendRef.current = null;
      clearTimeout(pending.timer);
      pending.resolve(sendVoiceNotepadMessage(pending.text, pending.onAccepted));
    }
    const abandoned = abandonedNotepadUploadsRef.current;
    if (abandoned.size === 0) return;
    for (const attachment of attachments) {
      if (!abandoned.has(attachment.name)) continue;
      abandoned.delete(attachment.name);
      void handleRemoveAttachment(attachment);
    }
  }, [attachments, handleRemoveAttachment, notepadAttachmentSendTick, sendVoiceNotepadMessage]);

  // Closed without sending: the notepad stays as a local draft, and its
  // uploaded transcript leaves the composer. A send already under way keeps
  // its file.
  useEffect(() => {
    if (voiceOpen) return;
    const upload = notepadUploadRef.current;
    if (!upload || pendingNotepadAttachmentSendRef.current) return;
    notepadUploadRef.current = null;
    abandonedNotepadUploadsRef.current.add(upload.fileName);
    setNotepadAttachmentSendTick((tick) => tick + 1);
  }, [voiceOpen]);

  useEffect(() => () => {
    const pending = pendingNotepadAttachmentSendRef.current;
    if (!pending) return;
    pendingNotepadAttachmentSendRef.current = null;
    clearTimeout(pending.timer);
    pending.resolve('rejected');
  }, []);

  const handleFileUpload = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    closeQuickSuggestions();
    await uploadAttachmentFiles(Array.from(files));
  }, [closeQuickSuggestions, uploadAttachmentFiles]);

  const consumedSharedUploadIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!pendingSharedUpload || !divRef.current) return;
    if (consumedSharedUploadIdsRef.current.has(pendingSharedUpload.id)) return;
    if (!activeSession || activeSession.name !== pendingSharedUpload.sessionName) return;
    if (!serverId || serverId !== pendingSharedUpload.serverId) return;
    if (attachmentDraftKey && hydratedAttachmentDraftKey !== attachmentDraftKey) return;

    consumedSharedUploadIdsRef.current.add(pendingSharedUpload.id);
    onPendingSharedUploadConsumed?.(pendingSharedUpload.id);

    const sharedText = typeof pendingSharedUpload.text === 'string' ? pendingSharedUpload.text.trim() : '';
    if (sharedText) {
      const currentText = readComposerElementText(divRef.current);
      const nextText = currentText.trim().length === 0
        ? sharedText
        : `${currentText}${currentText.endsWith('\n') || currentText.endsWith(' ') ? '' : '\n'}${sharedText}`;
      quickPhraseInputSuppressRef.current = true;
      closeQuickSuggestions();
      setComposerElementText(divRef.current, nextText);
      setHasText(!!nextText.trim());
      publishComposerText(nextText);
      if (draftKey) safeSessionStorageSetItem(draftKey, nextText);
      divRef.current.dispatchEvent(new Event('input', { bubbles: true }));
    }

    if (pendingSharedUpload.files.length > 0) {
      closeQuickSuggestions();
      void uploadAttachmentFiles(pendingSharedUpload.files);
    }

    focusComposerForTyping({ moveCursorToEnd: true });
  }, [
    activeSession,
    attachmentDraftKey,
    closeQuickSuggestions,
    draftKey,
    focusComposerForTyping,
    hydratedAttachmentDraftKey,
    onPendingSharedUploadConsumed,
    pendingSharedUpload,
    publishComposerText,
    serverId,
    uploadAttachmentFiles,
  ]);

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
    if (inlineVoiceActiveRef.current && !programmaticVoiceWriteRef.current) {
      interruptInlineVoiceForManualEdit();
    }
    closeQuickSuggestions();
    const files = ce.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      void handleFileUpload(files);
      return;
    }
    e.preventDefault();
    const text = ce.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    if (text.length > INLINE_PASTE_TEXT_CHAR_LIMIT && !isShellLike) {
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
          focusComposerForTyping();
        }
      })();
      return;
    }
    // `execCommand('insertText')` fires a native `input` event; flag it so the
    // inline `;` alias and `^` machine triggers are skipped for this paste-driven
    // input (paste must never open either picker).
    aliasPasteSuppressRef.current = true;
    machinePasteSuppressRef.current = true;
    cloudDocPasteSuppressRef.current = true;
    quickPhraseInputSuppressRef.current = true;
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }
    if (!inserted && divRef.current) {
      const current = readComposerElementText(divRef.current, { preserveEditingLines: true });
      const next = current + text;
      setComposerElementText(divRef.current, next);
      syncHistoryEditOrDraft(
        next,
        getNavigableHistory(quickData.data, activeSessionIncognito ? undefined : activeSession?.name),
      );
    }
    queueMicrotask(() => { quickPhraseInputSuppressRef.current = false; });
    setHasText(!!(divRef.current ? readComposerElementText(divRef.current).trim() : ''));
    if (!inserted) syncMobileComposerMetrics();
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
      requestActiveTimelineRefreshAfterUserAction();
    } else {
      // Main session restart/new: 1-click confirmation
      if (confirm !== action) { startConfirm(action, 1); return; }
      if (!window.confirm(action === 'restart' ? t('session.confirm_restart_dialog') : t('session.confirm_new_dialog'))) { resetConfirm(); return; }
      ws.sendSessionCommand('restart', { project: activeSession.project, ...(action === 'new' ? { fresh: true } : {}) });
    }
    setMenuOpen(false); resetConfirm(); onAfterAction?.();
  };

  const dispatchModelSwitch = (nextModel: string): boolean => {
    if (!ws || !activeSession) return false;
    dispatchSessionModelSwitch({
      sendMessage: (text) => sendSessionMessage(text),
      setSubSessionModel: (sessionName, modelId, cwd) => ws.subSessionSetModel(sessionName, modelId, cwd),
    }, {
      sessionName: activeSession.name,
      agentType: activeSession.agentType,
      model: nextModel,
      cwd: activeSession.projectDir,
      // Role labels do not define topology: a worker-role session may still be
      // a main process session. Only the real sub-session surface owns the
      // structured stop/restart model switch.
      subSession: !!onSubStop,
    });
    return true;
  };

  const handleModelSelect = (m: ModelChoice) => {
    if (!dispatchModelSwitch(m)) return;
    setModel(m);
    try { localStorage.setItem(MODEL_STORAGE_KEY, m); } catch { /* ignore */ }
    setModelOpen(false);
    onAfterAction?.();
  };

  const handleCodexModelSelect = (m: CodexModelChoice) => {
    if (!activeSession || !dispatchModelSwitch(m)) return;
    setCodexModel(m);
    saveCodexModelPreference(m, activeSession.name);
    setModelOpen(false);
    onAfterAction?.();
  };

  const handleQwenModelSelect = (m: QwenModelChoice) => {
    if (!dispatchModelSwitch(m)) return;
    setQwenModel(m);
    try { localStorage.setItem(QWEN_MODEL_STORAGE_KEY, m); } catch { /* ignore */ }
    setModelOpen(false);
    onAfterAction?.();
  };

  const handleGenericTransportModelSelect = (m: string) => {
    if (!dispatchModelSwitch(m)) return;
    if (activeSession?.agentType === AGY_SDK_PROVIDER_ID) {
      saveAgyModelPreference(m, activeSession.name);
    }
    setModelOpen(false);
    onAfterAction?.();
  };

  const toggleModelMenu = (options: { refreshDynamic?: boolean } = {}) => {
    setModelOpen((open) => {
      const next = !open;
      if (next && options.refreshDynamic) {
        dynamicTransportModels.refresh();
      }
      return next;
    });
  };

  const handleThinkingSelect = (level: TransportEffortLevel) => {
    if (!activeSession) return;
    setThinkingOpen(false);
    sendSessionMessage(`/thinking ${level}`);
    onAfterAction?.();
  };

  const isMobileLayout = typeof window !== 'undefined' && window.innerWidth <= 640;
  const mobileLayoutRef = useRef(isMobileLayout);
  mobileLayoutRef.current = isMobileLayout;
  const isTouchMobileDevice = isMobileDevice();
  const touchMobileDeviceRef = useRef(isTouchMobileDevice);
  touchMobileDeviceRef.current = isTouchMobileDevice;
  const [, setResponsiveLayoutTick] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const syncResponsiveLayout = () => {
      const nextCompact = window.innerWidth <= 640;
      const nextTouchMobile = isMobileDevice();
      if (nextCompact !== mobileLayoutRef.current || nextTouchMobile !== touchMobileDeviceRef.current) {
        mobileLayoutRef.current = nextCompact;
        touchMobileDeviceRef.current = nextTouchMobile;
        setResponsiveLayoutTick((tick) => tick + 1);
      }
      if (nextCompact) syncMobileComposerMetrics();
    };
    return subscribeDeviceLayoutChange(syncResponsiveLayout, { includeResize: true });
  }, [syncMobileComposerMetrics]);

  const [pcVoiceDevices, setPcVoiceDevices] = useState<PcAppVoiceInputDevice[]>([]);
  const [pcVoiceSelectedDevice, setPcVoiceSelectedDevice] = useState<string>('auto');
  const pcVoiceSelectedDeviceRef = useRef(pcVoiceSelectedDevice);
  pcVoiceSelectedDeviceRef.current = pcVoiceSelectedDevice;
  const pcVoiceMountedRef = useRef(true);
  useEffect(() => {
    pcVoiceMountedRef.current = true;
    return () => {
      pcVoiceMountedRef.current = false;
    };
  }, []);
  const showPcVoiceMicSelect = !isMobileLayout && !isTouchMobileDevice && pcAppInlineVoice && Boolean(getPcAppBridge()?.voice?.getInputDevices);
  const refreshPcVoiceInputDevices = useCallback(async () => {
    const voice = getPcAppBridge()?.voice;
    if (!voice?.getInputDevices || mobileLayoutRef.current || touchMobileDeviceRef.current || !isPcAppInlineVoiceSupported()) return;
    const readSelected = voice.getInputDevice ?? voice.getSelectedInputDevice;
    try {
      const [devices, selected] = await Promise.all([
        voice.getInputDevices(),
        readSelected ? readSelected() : Promise.resolve('auto'),
      ]);
      if (!pcVoiceMountedRef.current) return;
      if (Array.isArray(devices)) {
        setPcVoiceDevices(devices);
      }
      const normalized = typeof selected === 'string' && selected.trim() ? selected.trim() : 'auto';
      pcVoiceSelectedDeviceRef.current = normalized;
      setPcVoiceSelectedDevice(normalized);
    } catch {
      // Fail soft: keep desktop voice button working even if device enumeration fails.
    }
  }, []);
  const handlePcVoiceMicSelectChange = useCallback((nextRaw: string) => {
    const nextUid = nextRaw.trim() || 'auto';
    if (nextUid === pcVoiceSelectedDeviceRef.current) return;
    pcVoiceSelectedDeviceRef.current = nextUid;
    setPcVoiceSelectedDevice(nextUid);
    const voice = getPcAppBridge()?.voice;
    const writeSelected = voice?.setInputDevice ?? voice?.setSelectedInputDevice;
    if (writeSelected) {
      void Promise.resolve(writeSelected(nextUid))
        .then((saved) => {
          if (pcVoiceMountedRef.current && typeof saved === 'string' && saved.trim()) {
            const normalized = saved.trim();
            pcVoiceSelectedDeviceRef.current = normalized;
            setPcVoiceSelectedDevice(normalized);
          }
        })
        .catch(() => {});
    }
  }, []);
  useEffect(() => {
    if (!showPcVoiceMicSelect) return;
    void refreshPcVoiceInputDevices();
    if (typeof window === 'undefined') return;
    const onWindowFocus = () => {
      void refreshPcVoiceInputDevices();
    };
    window.addEventListener('focus', onWindowFocus);
    return () => window.removeEventListener('focus', onWindowFocus);
  }, [showPcVoiceMicSelect, refreshPcVoiceInputDevices]);
  const showEmbeddedVoiceButton = isMobileLayout && VoiceInput.isAvailable() && (inlineDesktopVoice || !hasText);
  const showMobileStackedAttachmentButton = isMobileLayout
    && isTransport
    && !!serverId
    && mobileComposerMultiline
    && !mobileComposerExpanded;
  const showEmbeddedAttachmentButton = isMobileLayout
    && !!serverId
    && !showMobileStackedAttachmentButton;
  const embeddedComposerActionCount = Number(showEmbeddedVoiceButton) + Number(showEmbeddedAttachmentButton);
  const deliveryModeLabel = directAppendMode
    ? t('session.delivery_mode_append')
    : t('session.delivery_mode_queue');
  const deliveryModeDescription = directAppendMode
    ? t('session.delivery_mode_append_description')
    : t('session.delivery_mode_queue_description');
  const handleDeliveryModeToggle = () => {
    const append = !directAppendMode;
    const nextMode = append
      ? SESSION_SEND_DELIVERY_MODES.APPEND
      : SESSION_SEND_DELIVERY_MODES.QUEUE;
    void deliveryModePref.save(nextMode).catch(() => {
      showSendWarning(t('session.delivery_mode_save_failed'));
    });
    if (isMobileLayout) showDeliveryModeNotice(append);
  };
  const showOpenSpecControl = !workflowControlsHidden && !!openSpecChangesPath && !isShellLike;
  const showCompactMetaControls = !!(showOpenSpecControl || isClaudeCode || isCodex || isQwen || supportsThinking || !isShellLike);
  const composerSubSession = subSessionId
    ? subSessions?.find((session) => session.sessionName === activeSession?.name)
    : undefined;
  const composerTargetName = sessionDisplayName?.trim()
    || (composerSubSession?.label ? formatLabel(composerSubSession.label) : composerSubSession?.type?.trim())
    || activeSession?.label?.trim()
    || activeSession?.project?.trim()
    || activeSession?.name?.trim()
    || '';
  const composerParentSession = composerSubSession?.parentSession
    ? sessions?.find((session) => session.name === composerSubSession.parentSession)
    : undefined;
  const composerParentName = composerParentSession
    ? formatSessionTabLabel(composerParentSession)
    : composerSubSession?.parentSession?.trim() || '';
  const composerTargetPath = composerParentName && composerParentName !== composerTargetName
    ? `${composerParentName} → ${composerTargetName}`
    : composerTargetName;
  const showComposerTargetBase = !isMobileLayout
    && !!activeSession
    && !!composerTargetName
    && !atPickerOpen
    && !aliasPickerOpen
    && !machinePickerOpen
    && !p2pOpen
    && !quickOpen;
  const voiceHoldReady = (isMobileLayout || isTouchMobileDevice) && !inlineDesktopVoice && hasSession && connected && !inputDisabled && VoiceInput.isAvailable();
  voiceHoldReadyRef.current = voiceHoldReady;
  mobileComposerExpandedRef.current = mobileComposerExpanded;
  const sessionTargetLabel = sessionDisplayName ?? activeSession?.label ?? activeSession?.project ?? 'session';
  const basePlaceholder = !hasSession
    ? t('session.no_session')
    : !connected
      ? t('session.send_queued')
      : voiceHoldReady
        ? t('session.send_placeholder_mobile_voice', { name: sessionTargetLabel })
        : t('session.send_placeholder', { name: sessionTargetLabel });
  const placeholder = !hasSession || !connected || isMobileLayout || isTouchMobileDevice
    ? basePlaceholder
    : compact
      ? basePlaceholder
      : t('session.send_placeholder_desktop_shortcuts', { placeholder: basePlaceholder });

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
  }, [hasText, isMobileLayout, mobileComposerExpanded, isTransport, serverId, syncMobileComposerMetrics]);

  useEffect(() => {
    if (voiceHoldReady) {
      setComposerFocused((prev) => (prev === composerFocusedRef.current ? prev : composerFocusedRef.current));
    }
  }, [voiceHoldReady]);

  useEffect(() => {
    if (!voiceHoldReady || composerFocusedRef.current) return;
    prewarmVoiceInput({ requestPermission: false });
    if (typeof document === 'undefined') return;
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        prewarmVoiceInput({ requestPermission: false });
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [voiceHoldReady, composerFocused]);

  useEffect(() => {
    if ((!isMobileLayout && !isTouchMobileDevice) || typeof window === 'undefined' || typeof document === 'undefined') return;
    const vv = window.visualViewport;
    if (!vv) return;
    const readViewportHeight = () => boundedVisualViewportHeight(
      vv.height,
      window.innerHeight,
      document.documentElement.clientHeight,
      getActiveCssZoom(),
    );
    let lastWidth = window.innerWidth;
    let hadKeyboardOpen = false;
    let wasKbOpen = false;
    let baselineHeight = Math.max(window.innerHeight, readViewportHeight() ?? window.innerHeight);

    const syncKeyboardDismiss = () => {
      const el = divRef.current;
      if (!el) {
        hadKeyboardOpen = false;
        wasKbOpen = false;
        lastWidth = window.innerWidth;
        baselineHeight = 0;
        return;
      }
      if (window.innerWidth !== lastWidth) {
        lastWidth = window.innerWidth;
        hadKeyboardOpen = false;
        wasKbOpen = false;
        baselineHeight = 0;
      }
      const viewportHeight = readViewportHeight();
      const active = document.activeElement;
      const composerHasFocus = active === el || (active !== null && el.contains(active));
      if (!composerHasFocus) {
        hadKeyboardOpen = false;
        wasKbOpen = false;
        if (viewportHeight !== null) {
          baselineHeight = measureMobileKeyboardShrink({
            inputFocused: false,
            layoutHeight: window.innerHeight,
            visualHeight: viewportHeight,
            baselineHeight,
          }).baselineHeight;
        }
        return;
      }
      if (viewportHeight === null) return;
      const measured = measureMobileKeyboardShrink({
        inputFocused: true,
        layoutHeight: window.innerHeight,
        visualHeight: viewportHeight,
        baselineHeight,
        hadKeyboardOpen,
      });
      baselineHeight = measured.baselineHeight;
      const state = getMobileKeyboardState(true, measured.shrink, hadKeyboardOpen);
      const dismissed = wasKbOpen && state.hadKeyboardOpen && !state.kbOpen;
      hadKeyboardOpen = state.hadKeyboardOpen;
      wasKbOpen = state.kbOpen;
      if (!dismissed) return;
      if (voiceHoldPendingRef.current || voiceHoldActiveRef.current || voiceOpenRef.current) return;

      // Mobile browsers/WebViews often collapse the soft keyboard without blurring
      // document.activeElement. Exit edit mode explicitly so Hold-to-Talk recovers.
      pendingMobileInitialEndFocusRef.current = null;
      hadKeyboardOpen = false;
      wasKbOpen = false;
      updateComposerFocused(false);
      try {
        el.blur();
      } catch { /* ignore */ }
      clearComposerVoiceTouchLock(
        el,
        inputDisabledRef.current || voiceHoldReadyRef.current,
      );
    };

    const settledViewportUpdater = createSettledViewportUpdater(syncKeyboardDismiss);
    const schedule = settledViewportUpdater.schedule;
    const onFocusIn = (e: FocusEvent) => {
      const el = divRef.current;
      const target = e.target as Node | null;
      if (!el || !target || (target !== el && !el.contains(target))) return;
      schedule();
    };
    const onFocusOut = () => {
      const el = divRef.current;
      const active = document.activeElement;
      if (!el || (active !== el && !(active !== null && el.contains(active)))) {
        hadKeyboardOpen = false;
        wasKbOpen = false;
        schedule();
      }
    };

    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('pageshow', schedule);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    schedule();
    return () => {
      settledViewportUpdater.cancel();
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('pageshow', schedule);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, [isMobileLayout, isTouchMobileDevice]);

  return (
    <>
    {appendSuccessNotice && typeof document !== 'undefined' && createPortal(
      <div class="queue-append-success-toast" role="status" aria-live="polite">
        <span class="queue-append-success-toast-icon" aria-hidden="true">↗</span>
        <span>{appendSuccessNotice}</span>
      </div>,
      document.body,
    )}
    {deliveryModeNotice && typeof document !== 'undefined' && createPortal(
      <div
        class={`queue-append-success-toast composer-delivery-mode-toast${deliveryModeNotice.append ? ' is-append' : ' is-queue'}`}
        role="status"
        aria-live="polite"
      >
        <span class="queue-append-success-toast-icon composer-delivery-mode-toast-icon" aria-hidden="true">
          <ComposerDeliveryModeIcon append={deliveryModeNotice.append} />
        </span>
        <span>{deliveryModeNotice.message}</span>
      </div>,
      document.body,
    )}
    {supervisionModeNotice && typeof document !== 'undefined' && createPortal(
      <div
        class="queue-append-success-toast composer-supervision-mode-toast"
        data-testid="supervision-mode-toast"
        role="status"
        aria-live="polite"
      >
        <span class="queue-append-success-toast-icon" aria-hidden="true">✓</span>
        <span>{supervisionModeNotice}</span>
      </div>,
      document.body,
    )}
    {effortClampNotice && typeof document !== 'undefined' && createPortal(
      <div class="queue-append-success-toast composer-supervision-mode-toast" role="status" aria-live="polite">
        <span class="queue-append-success-toast-icon" aria-hidden="true">✓</span>
        <span>{effortClampNotice}</span>
      </div>,
      document.body,
    )}
    {mobileFileBrowserOpen && ws && activeSession && createPortal(
      <div class="mobile-fb-overlay" ref={swipeBackRef}>
        <div class="mobile-fb-header">
          <span style={{ fontSize: 13, fontWeight: 600 }}>📁 Files</span>
          <button class="fb-close" onClick={onMobileFileBrowserClose}>✕</button>
        </div>
          <FileBrowser
            ws={ws}
            serverId={serverId}
            sessionName={activeSession.name}
            scopeToSessionRoot={isShareScopedSession && sharedState?.targetKind !== 'server'}
            readOnly={isShareScopedSession && !canSharedSessionSend}
            canShare={canManageFileShares && !isShareScopedSession}
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
          onOpenNodeGroups={baseOpenNodeGroups ? handleOpenNodeGroupsFromBrowser : undefined}
        />
      </div>,
      document.body,
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
            sessionName={activeSession.name}
            scopeToSessionRoot={isShareScopedSession && sharedState?.targetKind !== 'server'}
            readOnly={isShareScopedSession && !canSharedSessionSend}
            canShare={canManageFileShares && !isShareScopedSession}
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
            onOpenNodeGroups={baseOpenNodeGroups ? handleOpenNodeGroupsFromBrowser : undefined}
          />
        </div>
      </div>
    )}
    {activeSessionIncognito && <div class="incognito-session-badge" role="status" title={t('session.incognito_hint')}>🕶️ {t('session.incognito')}</div>}
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
          continuePending={openSpecAutoDeliver.continuePending}
          onClose={() => setOpenSpecAutoDetailsOpen(false)}
          onStop={() => { openSpecAutoDeliver.stop(); }}
          onContinue={() => { openSpecAutoDeliver.continueRun(); }}
        />
      )}
      {/* Header control row — compact mode keeps meta controls and the
          queue-aware transport Stop, but hides terminal shortcuts. */}
      {!hideShortcuts && (!compact || showCompactMetaControls || isTransport) && <div class="shortcuts-row">
        {(!compact || isTransport) && <div class={`shortcuts${isTransport ? ' shortcuts-transport' : ''}`}>
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
              title={appendableQueuedTransportEntries.length > 0
                ? `${t('session.stop_plain')} · ${t('session.transport_send_queued_count', { count: appendableQueuedTransportEntries.length })}`
                : `${t('session.stop_plain')} (/stop)`}
              aria-label={t('session.stop_plain')}
              disabled={disabled || activeSession?.state === 'stopped'}
              onPointerDown={(e) => {
                e.preventDefault();
                stopPointerActivationRef.current = true;
                handleStopButtonPress();
              }}
              onClick={(e) => {
                // Pointer-origin clicks have detail > 0. Keyboard/programmatic
                // clicks have detail 0 and still need to activate the button.
                if (stopPointerActivationRef.current && e.detail > 0) {
                  stopPointerActivationRef.current = false;
                  return;
                }
                stopPointerActivationRef.current = false;
                handleStopButtonPress();
              }}
              style={activeSessionLiveStatus.sweep ? { color: '#f87171' } : undefined}
            >
              <span aria-hidden="true">■</span>
              {appendableQueuedTransportEntries.length > 0 && (
                <span class="shortcut-btn-stop-queue-count" aria-hidden="true">
                  {appendableQueuedTransportEntries.length > 99 ? '99+' : appendableQueuedTransportEntries.length}
                </span>
              )}
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
          <ComposerTargetBubble
            visibleBase={showComposerTargetBase}
            composerFocusedRef={composerFocusedRef}
            subscribeFocus={subscribeComposerFocus}
            composerTargetPath={composerTargetPath}
            composerParentName={composerParentName}
            composerTargetName={composerTargetName}
          />
        </div>}

        {!isShellLike && (
        <div class={`shortcuts-meta-scroll${autoOpen || modelOpen || thinkingOpen ? ' has-open-menu' : ''}`}>
        {/* Quick peer delegation reuses the ordinary @agent orchestration path.
            It stays separate from automatic supervision state and remains
            visible while Auto is off. */}
        {canQuickPeerAudit && (
          <div class="shortcuts-model shortcuts-model-supervision" ref={autoRef}>
            <button
              class="shortcut-btn shortcut-btn-icon shortcut-btn-peer-audit"
              data-testid="peer-audit-icon"
              onClick={() => {
                setQuickDelegationError(null);
                setPeerAuditOpen(true);
              }}
              disabled={participantControlDisabled || peerAuditOpen}
              title={t('peerAuditQuick.tooltip')}
              aria-label={t('peerAuditQuick.iconLabel')}
              aria-haspopup="dialog"
            >
              <svg
                class="shortcut-btn-peer-audit-icon"
                viewBox="0 0 24 24"
                aria-hidden="true"
                focusable="false"
              >
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="m15.3 15.3 4.2 4.2" />
                <path d="m7.7 10.6 1.8 1.8 3.8-4" />
              </svg>
              <span class="shortcut-btn-peer-audit-label">{t('peerAuditQuick.shortLabel')}</span>
            </button>
            {canQuickViewSupervision && <>
            <button
              class={`shortcut-btn shortcut-btn-auto ${quickAutoModeClass}`}
              onClick={() => setAutoOpen((open) => !open)}
              disabled={participantControlDisabled}
              title={t('session.supervision.quickTitle')}
              aria-label={t('session.supervision.quickLabel')}
              aria-haspopup="menu"
              aria-expanded={autoOpen}
            >
              <span
                class="shortcut-btn-auto-dot"
                aria-hidden="true"
              />
              <span class="shortcut-btn-auto-label">{quickSupervisionLabel}</span>
              <span class="shortcut-btn-auto-caret" aria-hidden="true">▾</span>
            </button>
            <SupervisionHeartbeatBadge
              mode={quickSupervisionMode}
              heartbeat={activeSession?.supervisionHeartbeat}
            />
            {canQuickViewSupervision && autoOpen && (
              <div class="menu-dropdown menu-dropdown-auto">
                <button
                  class={`menu-item ${quickSupervisionMode === SUPERVISION_MODE.OFF ? 'menu-item-active' : ''}`}
                  onClick={() => { void handleQuickSupervisionModeSelect(SUPERVISION_MODE.OFF); }}
                  disabled={!canQuickControlSupervision}
                >
                  {quickSupervisionMode === SUPERVISION_MODE.OFF ? '● ' : '○ '}{t('session.supervision.mode.off')}
                </button>
                <button
                  class={`menu-item ${quickSupervisionMode === SUPERVISION_MODE.SUPERVISED_AUDIT ? 'menu-item-active' : ''}`}
                  onClick={() => { void handleQuickSupervisionModeSelect(SUPERVISION_MODE.SUPERVISED_AUDIT); }}
                  disabled={!canQuickControlSupervision}
                >
                  {quickSupervisionMode === SUPERVISION_MODE.SUPERVISED_AUDIT ? '● ' : '○ '}{t('session.supervision.mode.supervised_audit')}
                </button>
                {!!onSettings && canOpenSessionSettings && (
                  <>
                    <div class="menu-divider" />
                    <button
                      class="menu-item"
                      onClick={() => {
                        setAutoOpen(false);
                        onSettings?.({ surface: 'supervision' });
                      }}
                    >
                      {t('session.supervision.settingsTitle')}
                    </button>
                  </>
                )}
              </div>
            )}
            </>}
          </div>
        )}

        {canQuickPeerAudit && peerAuditOpen && auditedSessionName && typeof document !== 'undefined' && createPortal(
          <div
            class="peer-audit-overlay"
            data-testid="peer-audit-overlay"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setQuickDelegationError(null);
                setPeerAuditOpen(false);
              }
            }}
          >
            <div
              class="peer-audit-modal"
              data-testid="peer-audit-modal"
              role="dialog"
              aria-modal="true"
            >
              <QuickAgentDelegationDialog
                currentSessionName={auditedSessionName}
                candidates={quickDelegationCandidates}
                error={quickDelegationError}
                onClose={() => {
                  setQuickDelegationError(null);
                  setPeerAuditOpen(false);
                }}
                onDispatch={handleQuickAgentDelegationDispatch}
              />
            </div>
          </div>,
          document.body,
        )}

        {/* Model selector — outside overflow-x scroll area so dropdown isn't clipped */}
        {showOpenSpecControl && (
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
                    openSpecTaskStatsRequestIdRef.current = null;
                    setOpenSpecLoading(false);
                    setOpenSpecAuditMenu(null);
                    setOpenSpecProposeMenuOpen(false);
                    setOpenSpecExecuteMenu(null);
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
                {!openSpecLoading && openSpecError && openSpecChanges.length === 0 && (
                  <div class="p2p-menu-section-label openspec-section-meta openspec-section-error">
                    {openSpecError}
                  </div>
                )}
                {!openSpecLoading && !openSpecError && openSpecChanges.length === 0 && (
                  <div class="p2p-menu-section-label openspec-section-meta">{t('openspec.empty')}</div>
                )}
                {openSpecChanges.length > 0 && openSpecChanges.map((change) => {
                  const changeName = change.name;
                  return (
                  <OpenSpecChangeRow
                    key={changeName}
                    changeName={changeName}
                    taskStats={change.taskStats}
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
                      setOpenSpecExecuteMenu(null);
                      setOpenSpecAutoLauncherChange(null);
                      setOpenSpecExpandedChange((current) => current === changeName ? null : changeName);
                    }}
                    onToggleAuditMenu={() => {
                      setOpenSpecProposeMenuOpen(false);
                      setOpenSpecExecuteMenu(null);
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
                    executeMenuOpen={openSpecExecuteMenu === changeName}
                    onToggleExecuteMenu={() => {
                      setOpenSpecAuditMenu(null);
                      setOpenSpecProposeMenuOpen(false);
                      setOpenSpecAutoLauncherChange(null);
                      setOpenSpecExecuteMenu((current) => current === changeName ? null : changeName);
                    }}
                    executeButtonRef={(el) => {
                      if (el) openSpecExecuteButtonRefs.current.set(changeName, el);
                      else openSpecExecuteButtonRefs.current.delete(changeName);
                    }}
                    renderExecuteSubmenu={(content, minWidth) => renderOpenSpecSubmenu(
                      content,
                      openSpecExecuteButtonRefs.current.get(changeName) ?? null,
                      minWidth,
                    )}
                    executeMenuContent={buildOpenSpecExecuteMenuContent(changeName)}
                  />
                  );
                })}
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
                        setOpenSpecExecuteMenu(null);
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
              ref={modelButtonRef}
              onClick={() => toggleModelMenu({
                refreshDynamic: activeSession?.agentType === 'claude-code-sdk',
              })}
              disabled={modelSwitchDisabled}
              title={displayedClaudeModel ? `Model: ${displayedClaudeModel}` : 'Model: Unknown — tap to select'}
              style={{ color: displayedClaudeModel ? '#a78bfa' : '#6b7280', fontSize: 10 }}
            >
              {claudePinnedModel ? (shortModelLabel(claudePinnedModel) ?? claudePinnedModel) : (displayedClaudeModel ?? 'unknown')}
            </button>
            {modelOpen && renderModelDropdown(
              <>
                {claudeModelSuggestions.map((m) => (
                  <button
                    key={m}
                    class={`menu-item ${displayedClaudeModel === m ? 'menu-item-active' : ''}`}
                    onClick={() => handleModelSelect(m)}
                  >
                    {displayedClaudeModel === m ? '● ' : '○ '}{m.charAt(0).toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
        {isCodex && (
          <div class="shortcuts-model" ref={modelRef}>
            <button
              class="shortcut-btn"
              ref={modelButtonRef}
              onClick={() => toggleModelMenu({
                refreshDynamic: activeSession?.agentType === 'codex-sdk',
              })}
              disabled={modelSwitchDisabled}
              title={displayedCodexModel ? `Model: ${displayedCodexModel}` : 'Model: default — tap to select'}
              style={{ color: displayedCodexModel ? '#34d399' : '#6b7280', fontSize: 10 }}
            >
              {shortModelLabel(displayedCodexModel) ?? displayedCodexModel ?? 'default'}
            </button>
            {modelOpen && renderModelDropdown(
              <>
                {codexModelSuggestions.map((m) => (
                  <button
                    key={m}
                    class={`menu-item ${displayedCodexModel === m ? 'menu-item-active' : ''}`}
                    onClick={() => handleCodexModelSelect(m)}
                  >
                    {displayedCodexModel === m ? '● ' : '○ '}{m}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
        {/* Codex keeps Fast on the thread, so a session switched to it anywhere
            stays there through every resume. Say so where the model is shown,
            and make the same chip the way back out. */}
        {isCodex && isCodexFastServiceTier(activeSession?.serviceTier) && (
          <button
            class="shortcut-btn shortcut-btn-fast-warning"
            onClick={() => {
              sendSessionMessage(CODEX_FAST_OFF_COMMAND);
              onAfterAction?.();
            }}
            title={t('session.codex_fast_mode_hint')}
          >
            <span aria-hidden="true">⚡</span>
            {t('session.codex_fast_mode')}
          </button>
        )}
        {isQwen && (
          <div class="shortcuts-model" ref={modelRef}>
            <button
              class="shortcut-btn"
              ref={modelButtonRef}
              onClick={() => setModelOpen((o) => !o)}
              disabled={modelSwitchDisabled}
              title={qwenModel
                ? t('session.qwen_model_title', { tier: qwenTierLabel, model: qwenModel })
                : t('session.qwen_source_title', { tier: qwenTierLabel })}
              style={{ color: qwenModel ? '#f59e0b' : '#6b7280', fontSize: 10 }}
            >
              {qwenTierLabel}
            </button>
            {modelOpen && renderModelDropdown(
              <>
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
              </>
            )}
          </div>
        )}
        {supportsGenericTransportModelSelect && (
          <div class="shortcuts-model" ref={modelRef}>
            <button
              class="shortcut-btn"
              ref={modelButtonRef}
              onClick={() => toggleModelMenu({ refreshDynamic: true })}
              disabled={modelSwitchDisabled}
              title={genericTransportModel ? `Model: ${genericTransportModel}` : 'Model: default — tap to select'}
              style={{ color: genericTransportModel ? '#34d399' : '#6b7280', fontSize: 10 }}
            >
              {shortModelLabel(genericTransportModel) ?? genericTransportModel ?? 'default'}
            </button>
            {modelOpen && renderModelDropdown(
              <>
                {genericTransportModelSuggestions.map((m) => (
                  <button
                    key={m}
                    class={`menu-item ${genericTransportModel === m ? 'menu-item-active' : ''}`}
                    onClick={() => handleGenericTransportModelSelect(m)}
                  >
                    {genericTransportModel === m ? '● ' : '○ '}{m}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
        {supportsThinking && (
          <div class="shortcuts-model" ref={thinkingRef}>
            <button
              class="shortcut-btn"
              onClick={() => setThinkingOpen((o) => !o)}
              disabled={participantControlDisabled}
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
                    {currentThinking === level ? '● ' : '○ '}{formatEffortLevel(level)}{level === 'ultra' ? ` — ${t('session.thinking_ultra_hint')}` : ''}
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
            disabled={participantControlDisabled || openSpecAutoActive}
            title={openSpecAutoActionLockReason ?? (p2pMode === 'solo' ? getP2pModeLabel('solo', t) : `${t('p2p.team_button', 'Team')}: ${getP2pModeLabel(p2pMode, t)}`)}
            style={{ color: getP2pModeColor(p2pMode), fontSize: 10, fontWeight: p2pMode === 'solo' ? 600 : 700 }}
          >
            {p2pMode === 'solo' ? getP2pModeLabel('solo', t) : `${t('p2p.team_button', 'Team')}:${getP2pModeLabel(p2pMode, t)}`}
          </button>
          <button
            class="shortcut-btn p2p-settings-btn"
            onClick={() => { setP2pOpen(false); openP2pConfigPanel('participants'); }}
            disabled={participantControlDisabled || openSpecAutoActive}
            title={openSpecAutoActionLockReason ?? t('p2p.settings_title')}
            aria-label={t('p2p.settings_button')}
          >
            <span class="p2p-settings-icon" aria-hidden="true">⚙</span>
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
        </div>
        )}
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
            {pendingTransportApproval.tool && pendingTransportApproval.description && (
              <div style={{ color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>
                {pendingTransportApproval.description}
              </div>
            )}
            {pendingTransportApproval.provider && typeof pendingTransportApproval.providerGeneration === 'number' && pendingTransportApproval.providerToolUseId && (
              <div style={{ color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>
                {t('session.approval.scope', {
                  provider: pendingTransportApproval.provider,
                  generation: pendingTransportApproval.providerGeneration,
                  toolUseId: pendingTransportApproval.providerToolUseId,
                })}
              </div>
            )}
            {pendingTransportApproval.inputPreview && (
              <div style={{ color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                {t('session.approval.input', { input: pendingTransportApproval.inputPreview })}
              </div>
            )}
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

      {/* Upload progress bars */}
      {uploadRows.length > 0 && (
        <div class="composer-upload-list">
          {uploadRows.map((item) => {
            const transferredBytes = Math.round((item.totalBytes * item.progress) / 100);
            const elapsedSeconds = Math.max(0, (Math.max(uploadNow, item.updatedAt) - item.startedAt) / 1000);
            const remainingBytes = Math.max(0, item.totalBytes - transferredBytes);
            const etaSeconds = item.speedBps > 0 ? remainingBytes / item.speedBps : null;
            return (
              <div
                key={item.id}
                data-testid="composer-upload-row"
                data-transport={item.transport}
                class={`composer-upload-row composer-upload-row-${item.transport}`}
              >
                <div
                  title={item.name}
                  class="composer-upload-name"
                >
                  {item.name}
                </div>
                <span
                  data-testid="composer-upload-transport"
                  data-transport={item.transport}
                  class={`composer-upload-transport composer-upload-transport-${item.transport}`}
                  title={t(`upload.transport.${item.transport}`)}
                >
                  <span class="composer-upload-transport-signal" aria-hidden="true" />
                  {t(`upload.transport.${item.transport}`)}
                </span>
                {item.status === 'uploading' && (
                  <button
                    type="button"
                    class="composer-upload-cancel"
                    onClick={() => handleCancelUpload(item)}
                    title={t('upload.cancel')}
                    aria-label={t('upload.cancel_named', { name: item.name })}
                  >{t('upload.cancel')}</button>
                )}
                {item.status === 'error' && (
                  <div class="composer-upload-error-actions">
                    <button
                      type="button"
                      class="composer-upload-retry"
                      onClick={() => handleRetryUpload(item)}
                      aria-label={`${t('upload.retry')}: ${item.name}`}
                    >{t('upload.retry')}</button>
                    <button
                      type="button"
                      class="composer-upload-dismiss"
                      onClick={() => handleDismissFailedUpload(item)}
                      aria-label={`${t('upload.dismiss_failure')}: ${item.name}`}
                    >{t('upload.dismiss_failure')}</button>
                  </div>
                )}
                <div
                  role="progressbar"
                  aria-label={t('upload.progress_aria', {
                    name: item.name,
                    transport: t(`upload.transport.${item.transport}`),
                    progress: item.progress,
                  })}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={item.progress}
                  class="composer-upload-progress-track"
                >
                  <div
                    class={`composer-upload-progress-fill${item.status === 'error' ? ' composer-upload-progress-fill-error' : ''}`}
                    style={{ width: `${item.progress}%` }}
                  />
                </div>
                <span data-testid="composer-upload-progress" class="composer-upload-progress-value">{item.progress}%</span>
                <div data-testid="composer-upload-stats" class="composer-upload-stats">
                  <span>{t('upload.transferred', {
                    transferred: formatTransferBytes(transferredBytes),
                    total: formatTransferBytes(item.totalBytes),
                  })}</span>
                  {item.speedBps > 0 && (
                    <span>{t('upload.speed', { speed: formatTransferBytes(item.speedBps) })}</span>
                  )}
                  <span>{t('upload.elapsed', { time: formatTransferDuration(elapsedSeconds) })}</span>
                  {etaSeconds !== null && item.progress < 100 && (
                    <span>{t('upload.eta', { time: formatTransferDuration(etaSeconds) })}</span>
                  )}
                  {item.progress >= 100 && <span>{t('upload.eta_done')}</span>}
                </div>
              </div>
            );
          })}
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

      {(() => {
        const serviceChip = inlineVoiceActive && inlineVoiceServiceLabel ? (
          <div
            data-testid="inline-voice-service-chip"
            class="voice-active-service-chip"
            role={voiceHudMount ? undefined : 'status'}
            aria-live={voiceHudMount ? undefined : 'polite'}
            title={inlineVoiceServiceLabel}
          >
            <span class="voice-active-service-dot" aria-hidden="true" />
            <span class="voice-active-service-text">{inlineVoiceServiceLabel}</span>
          </div>
        ) : null;
        const showLoadingChip = voiceModelLoading && voiceHudMount?.mode !== 'loading';
        const showFallbackOverlay = (!voiceHudMount && Boolean(serviceChip)) || showLoadingChip;
        // `#imcodes-voice-hud-root` carries `aria-hidden="true"` in PC App, so keep an
        // accessible zero-height status inside `.controls-wrapper` whenever the model
        // badge is portaled into the HUD or the HUD suppresses the visual loading chip.
        const srStatusParts: string[] = [];
        if (voiceHudMount && inlineVoiceActive && inlineVoiceServiceLabel) {
          srStatusParts.push(inlineVoiceServiceLabel);
        }
        if (voiceModelLoading && !showLoadingChip) {
          srStatusParts.push(t('voice.loading_model'));
        }
        return (
          <>
            {voiceHudMount && serviceChip && createPortal(serviceChip, voiceHudMount.root)}
            {srStatusParts.length > 0 && (
              <div
                data-testid="voice-hud-sr-status"
                class="voice-sr-status"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {srStatusParts.join(' · ')}
              </div>
            )}
            {showFallbackOverlay && (
              <div class="voice-inline-chips">
                {!voiceHudMount && serviceChip}
                {showLoadingChip && (
                  <div
                    data-testid="voice-model-loading-chip"
                    class="voice-model-loading-chip"
                    role="status"
                    aria-live="polite"
                  >
                    <span class="voice-model-loading-dot" aria-hidden="true" />
                    <span>{t('voice.loading_model')}</span>
                  </div>
                )}
              </div>
            )}
          </>
        );
      })()}

      {voiceHoldError && (
        <div
          class="voice-hold-error-banner"
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            padding: '4px 12px',
            fontSize: 12,
            color: '#ef4444',
            background: 'rgba(239,68,68,0.1)',
            borderRadius: 4,
            margin: '0 8px 4px',
          }}
        >
          <span>
            {voiceHoldError === 'permission_denied'
              ? t('voice.mic_permission_failed')
              : t('voice.error', { error: voiceHoldError })}
          </span>
          {voiceHoldError === 'permission_denied' && readVoiceInputMethod<() => boolean>('canOpenNativeAppSettings')?.() && (
            <button
              type="button"
              data-testid="voice-hold-open-settings-btn"
              class="btn btn-secondary"
              style={{ padding: '2px 8px', fontSize: 11, flexShrink: 0 }}
              onClick={() => { void readVoiceInputMethod<() => Promise<boolean>>('openNativeAppSettings')?.(); }}
            >
              {t('voice.open_privacy_settings')}
            </button>
          )}
        </div>
      )}

      {inlineVoicePermissionTarget && (
        <div
          data-testid="inline-voice-permission-banner"
          class="voice-hold-error-banner"
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            padding: '6px 12px',
            fontSize: 12,
            color: '#fecaca',
            background: 'rgba(239,68,68,0.14)',
            border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 6,
            margin: '0 8px 4px',
          }}
        >
          <span>
            {inlineVoicePermissionTarget === 'speech'
              ? t('voice.speech_permission_failed')
              : t('voice.mic_permission_failed')}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
            {(pcAppInlineVoice || getPcAppBridge()?.voice) && (
              <button
                type="button"
                data-testid="inline-voice-grant-btn"
                class="btn btn-secondary"
                style={{ padding: '2px 8px', fontSize: 11 }}
                onClick={() => { void handleQuickGrantVoicePermission(); }}
              >
                {t('voice.open_privacy_settings')}
              </button>
            )}
            <button
              type="button"
              aria-label={t('common.close')}
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '0 4px' }}
              onClick={() => setInlineVoicePermissionTarget(null)}
            >
              ×
            </button>
          </span>
        </div>
      )}

      {/* Delegation target chip — separate from Team/P2P routing tokens. */}
      {pendingDelegateTarget && (
        <div class="attachment-badges">
          <span class="attachment-badge" title={t('delegation.chip_title', { target: pendingDelegateTarget.label })}>
            <span class="attachment-badge-icon">🤖</span>
            <span class="attachment-badge-name">{t('delegation.chip_label', { target: pendingDelegateTarget.label })}</span>
            <button
              class="attachment-badge-remove"
              onClick={() => setPendingDelegateTarget(null)}
              title={t('common.delete')}
            >×</button>
          </span>
        </div>
      )}

      {/* Attachment badges — above input row */}
      {attachments.length > 0 && (() => {
        const shouldCollapse = attachments.length > ATTACHMENT_BADGE_COLLAPSE_THRESHOLD;
        const isCollapsed = shouldCollapse && !attachmentsExpanded;
        const visibleAttachments = isCollapsed
          ? attachments.slice(0, ATTACHMENT_BADGE_COLLAPSED_VISIBLE_COUNT)
          : attachments;
        const hiddenCount = attachments.length - visibleAttachments.length;
        const toggleTitle = isCollapsed
          ? t('upload.attachments_expand_title', { count: hiddenCount, total: attachments.length })
          : t('upload.attachments_collapse_title', { total: attachments.length });
        return (
          <div class={`attachment-badges attachment-badges-list${shouldCollapse && attachmentsExpanded ? ' is-expanded' : ''}`}>
            {visibleAttachments.map((a) => (
              <ComposerAttachmentBadge
                key={a.path}
                seq={a.seq}
                name={a.name}
                path={a.path}
                {...(a.id ? { attachmentId: a.id } : {})}
                {...((a.serverId || serverId) ? { serverId: a.serverId || serverId } : {})}
                {...(isShareScopedSession && activeSession?.name ? { sessionName: activeSession.name } : {})}
                removing={deletingAttachmentKeys.has(a.id ?? a.path)}
                onRemove={() => { void handleRemoveAttachment(a); }}
              />
            ))}
            {shouldCollapse && (
              <button
                type="button"
                class="attachment-badge attachment-badge-toggle"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setAttachmentsExpanded((prev) => !prev)}
                aria-expanded={attachmentsExpanded}
                aria-label={toggleTitle}
                title={toggleTitle}
              >
                {isCollapsed
                  ? t('upload.attachments_expand', { count: hiddenCount, total: attachments.length })
                  : t('upload.attachments_collapse', { total: attachments.length })}
              </button>
            )}
          </div>
        );
      })()}

      {/* Quote badges — above input row */}
      {((quotes && quotes.length > 0) || Boolean(taskQuote)) && (
        <div class="attachment-badges">
          {quotes?.map((q, i) => (
            <span
              key={i}
              class="attachment-badge quote-badge"
              title={q}
            >
              <span class="attachment-badge-icon">❝</span>
              <span class="attachment-badge-name">{q.slice(0, 30)}{q.length > 30 ? '…' : ''}</span>
              <button
                class="attachment-badge-remove"
                onClick={() => onRemoveQuote?.(i)}
                title={t('common.delete')}
              >×</button>
            </span>
          ))}
          {taskQuote && (
            <span
              key="task-quote"
              class="attachment-badge quote-badge task-quote-badge"
              data-testid="composer-task-quote-badge"
              title={taskQuote}
            >
              <span class="attachment-badge-icon">◈</span>
              <span class="attachment-badge-name">{taskQuote.slice(0, 40)}{taskQuote.length > 40 ? '…' : ''}</span>
              <button
                class="attachment-badge-remove"
                onClick={() => onRemoveTaskQuote?.()}
                title={t('common.delete')}
              >×</button>
            </span>
          )}
        </div>
      )}

      {/* Main input row */}
      <div class={`controls${isMobileLayout && mobileComposerMultiline ? ' controls-mobile-multiline' : ''}`}>
        {/* Quick input trigger — left of input */}
        <div class="qp-trigger-wrap" ref={quickWrapRef}>
          {isMobileLayout && (mobileComposerMultiline || mobileComposerExpanded) && (
            <button
              class="btn btn-input-expand btn-input-expand-floating"
              // Prevent the button from stealing focus / blurring the composer
              // (same trick as the picker items below) so expanding/collapsing
              // keeps the caret in place instead of the deferred focus() landing
              // it at a default position — a "focus jumps" source on mobile.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setMobileComposerExpanded((prev) => !prev);
                setTimeout(() => { focusComposerForTyping(); }, 0);
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
              if (isShellLike) {
                requestSend({ text, extra: { verbatim: true } });
              } else {
                requestSend(buildModeOnlySendPayload(text));
              }
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
            onInsertAlias={insertAliasMarker}
            machines={machineAll}
            onInsertMachine={insertMachineMarker}
            projectKey={activeSession?.contextNamespace?.projectId || activeSession?.project}
            onInsertVerificationMachine={(machine) => appendToInput([
              t('quick_input.verification_reference', {
                alias: machine.alias,
                id: machine.id,
                target: machine.target,
              }),
            ])}
            anchorRef={quickWrapRef}
          />
        </div>

        {!isMobileLayout && isTransport && (
          <button
            type="button"
            class={`composer-delivery-mode composer-delivery-mode-desktop${directAppendMode ? ' is-append' : ' is-queue'}`}
            onClick={handleDeliveryModeToggle}
            aria-pressed={directAppendMode}
            aria-label={`${deliveryModeLabel}: ${deliveryModeDescription}`}
            title={deliveryModeDescription}
            disabled={inputDisabled}
          >
            <ComposerDeliveryModeIcon append={directAppendMode} />
            <span>{deliveryModeLabel}</span>
          </button>
        )}

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
                role: s.role,
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
            projectDir={isShareScopedSession
              ? (activeSession.projectDir ?? FS_SESSION_ROOT_PATH)
              : (activeSession.projectDir ?? '')}
            sessionName={isShareScopedSession ? activeSession.name : undefined}
            onSelectFile={(path) => {
              const text = divRef.current ? readComposerElementText(divRef.current) : '';
              const before = text.replace(/@[^\s@]*$/, '');
              const nextText = `${before}@${path} `;
              setComposerElementText(divRef.current!, nextText);
              atSelectionSnapshotRef.current = nextText;
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
            onSelectDelegateAgent={(session) => {
              const text = divRef.current ? readComposerElementText(divRef.current) : '';
              const before = text.replace(/@[^\s@]*$/, '');
              if (divRef.current) setComposerElementText(divRef.current, before);
              setPendingDelegateTarget({ session, label: buildDelegateLabel(session) });
              pendingAtTargetsRef.current = [];
              pendingConfigOverrideRef.current = null;
              atSelectionSnapshotRef.current = before;
              atSelectionLockRef.current = true;
              setAtPickerOpen(false);
              setAtPickerStage('choose');
              atJustClosedRef.current = true;
              setTimeout(() => { atJustClosedRef.current = false; atSelectionLockRef.current = false; }, 150);
              setHasText(!!before.trim());
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
              setPendingDelegateTarget(null);
              const text = divRef.current ? readComposerElementText(divRef.current) : '';
              const before = text.replace(/@[^\s@]*$/, '');
              // Show short @@label in input (double-@ = P2P, single-@ = file ref)
              const label = buildAgentLabel(session, mode);
              const nextText = `${before}${label} `;
              setComposerElementText(divRef.current!, nextText);
              pendingAtTargetsRef.current.push({ session, mode, label });
              atSelectionSnapshotRef.current = nextText;
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
              setPendingDelegateTarget(null);
              // Show @@all(config) — daemon expands per config. Store custom rounds + config override.
              const text = divRef.current ? readComposerElementText(divRef.current) : '';
              const before = text.replace(/@[^\s@]*$/, '');
              const labelMode = modeOverride === 'config' ? 'config' : modeOverride;
              const label = rounds > 1 ? `@@all(${labelMode} ×${rounds})` : `@@all(${labelMode})`;
              const nextText = `${before}${label} `;
              setComposerElementText(divRef.current!, nextText);
              pendingAtTargetsRef.current.push({ session: '__all__', mode: 'config', label });
              // Store custom config + rounds for handleSend
              pendingConfigOverrideRef.current = { config, rounds, modeOverride };
              atSelectionSnapshotRef.current = nextText;
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
              const text = divRef.current ? readComposerElementText(divRef.current) : '';
              const before = text.replace(/@[^\s@]*$/, '');
              if (divRef.current) setComposerElementText(divRef.current, before);
              setHasText(before.trim().length > 0);
              setAtPickerOpen(false);
              setAtPickerStage('choose');
              atJustClosedRef.current = true;
              setTimeout(() => { atJustClosedRef.current = false; atSelectionLockRef.current = false; }, 150);
              handleDirectComboSelect(modeKey, rounds);
            }}
            onSelectAlias={(name) => {
              // @别名 → strip the trailing `@query` fragment, then insert the
              // `;;(name)` marker via the shared value-secret helper.
              const text = divRef.current ? readComposerElementText(divRef.current) : '';
              const before = text.replace(/@[^\s@]*$/, '');
              if (divRef.current) setComposerElementText(divRef.current, before);
              try {
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(divRef.current!);
                range.collapse(false);
                sel?.removeAllRanges();
                sel?.addRange(range);
              } catch { /* jsdom lacks Selection API */ }
              setAtPickerOpen(false);
              setAtPickerStage('choose');
              atJustClosedRef.current = true;
              setTimeout(() => { atJustClosedRef.current = false; atSelectionLockRef.current = false; }, 150);
              insertAliasMarker(name);
            }}
            onSelectMachine={(refName, displayName) => {
              // @machine → strip the trailing `@query` fragment, then insert the
              // stable marker plus its human-readable display note.
              const text = divRef.current ? readComposerElementText(divRef.current) : '';
              const before = text.replace(/@[^\s@]*$/, '');
              if (divRef.current) setComposerElementText(divRef.current, before);
              try {
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(divRef.current!);
                range.collapse(false);
                sel?.removeAllRanges();
                sel?.addRange(range);
              } catch { /* jsdom lacks Selection API */ }
              setAtPickerOpen(false);
              setAtPickerStage('choose');
              atJustClosedRef.current = true;
              setTimeout(() => { atJustClosedRef.current = false; atSelectionLockRef.current = false; }, 150);
              insertMachineMarker(refName, displayName);
            }}
            onSelectSkill={(skill) => {
              const text = divRef.current ? readComposerElementText(divRef.current) : '';
              const before = text.replace(/@[^\s@]*$/, '');
              const nextText = `${before}${before && !before.endsWith(' ') ? ' ' : ''}${buildAgentSkillMarker(skill)} `;
              if (divRef.current) setComposerElementText(divRef.current, nextText);
              atSelectionSnapshotRef.current = nextText;
              atSelectionLockRef.current = true;
              setAtPickerOpen(false);
              setAtPickerStage('choose');
              atJustClosedRef.current = true;
              setTimeout(() => { atJustClosedRef.current = false; atSelectionLockRef.current = false; }, 150);
              setHasText(true);
              publishComposerText(nextText);
              try {
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(divRef.current!);
                range.collapse(false);
                sel?.removeAllRanges();
                sel?.addRange(range);
              } catch { /* jsdom lacks Selection API */ }
            }}
            serverId={serverId}
            p2pConfig={p2pSavedConfig}
            onClose={() => { setAtPickerOpen(false); setAtPickerStage('choose'); }}
            onStageChange={setAtPickerStage}
            visible={true}
          />
        )}

        {quickSuggestionKind !== null
          && activeSession
          && (quickSuggestionKind === 'skill' || quickSuggestionKind !== 'phrase' || quickSuggestions.length > 0) && (
          <div
            ref={quickSuggestionPickerRef}
            class="controls-slash-picker"
            role="listbox"
            aria-label={t(quickSuggestionKind === 'command'
              ? 'quick_input.commands'
              : quickSuggestionKind === 'phrase'
                ? 'quick_input.phrases'
                : quickSuggestionKind === 'skill'
                  ? 'skill.category'
                  : 'quick_input.models')}
            style={aliasPickerContainerStyle}
          >
            <div style={aliasPickerGroupLabelStyle}>
              {t(quickSuggestionKind === 'command'
                ? 'quick_input.commands'
                : quickSuggestionKind === 'phrase'
                  ? 'quick_input.phrases'
                  : quickSuggestionKind === 'skill'
                    ? 'skill.category'
                    : 'quick_input.models')}
            </div>
            {((quickSuggestionKind === 'skill' ? skillSuggestions.length : quickSuggestions.length) === 0) && (
              <div style={aliasPickerEmptyStyle}>
                {t(quickSuggestionKind === 'command'
                  ? 'quick_input.no_command_matches'
                  : quickSuggestionKind === 'phrase'
                    ? 'quick_input.no_phrase_matches'
                    : quickSuggestionKind === 'skill'
                      ? 'skill.no_results'
                      : 'quick_input.no_model_matches')}
              </div>
            )}
            {quickSuggestionKind === 'skill' ? skillSuggestions.map((skill, idx) => {
              const highlighted = idx === activeQuickSuggestionIndex;
              return (
                <div
                  key={`${skill.name}:${skill.source ?? skill.sourceUrl ?? ''}`}
                  role="option"
                  aria-selected={highlighted}
                  data-hl={highlighted ? 'true' : undefined}
                  data-skill-name={skill.name}
                  style={highlighted ? aliasPickerItemHighlightStyle : aliasPickerItemStyle}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectSkillSuggestion(skill)}
                  title={skill.description || undefined}
                >
                  <code>{buildAgentSkillMarker(skill)}</code>
                  <span style={aliasPickerDimStyle}>{agentSkillSourceLabel(skill)}</span>
                  {skill.description ? <span style={aliasPickerDimStyle}>{skill.description}</span> : null}
                </div>
              );
            }) : quickSuggestions.map((suggestion, idx) => {
              const highlighted = idx === activeQuickSuggestionIndex;
              return (
                <div
                  key={suggestion}
                  role="option"
                  aria-selected={highlighted}
                  data-hl={highlighted ? 'true' : undefined}
                  data-slash-command={quickSuggestionKind === 'command' ? suggestion : undefined}
                  data-quick-phrase={quickSuggestionKind === 'phrase' ? suggestion : undefined}
                  data-model-command={quickSuggestionKind === 'model' ? suggestion : undefined}
                  style={highlighted ? aliasPickerItemHighlightStyle : aliasPickerItemStyle}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectQuickSuggestion(suggestion)}
                >
                  {quickSuggestionKind === 'phrase' ? <span>{suggestion}</span> : <code>{suggestion}</code>}
                </div>
              );
            })}
          </div>
        )}

        {/* Inline `;` alias autocomplete dropdown. Mirrors the @ picker's
            positioning; owns Enter/Tab/Arrow/Escape via handleKeyDown while open. */}
        {aliasPickerOpen && activeSession && (
          <div ref={aliasPickerRef} class="controls-alias-picker" role="listbox" aria-label={t('alias.category')} style={aliasPickerContainerStyle}>
            <div style={aliasPickerGroupLabelStyle}>
              {t('alias.category')} {aliasQuery ? `— "${aliasQuery}"` : ''}
            </div>
            {aliasFiltered.length === 0 && (
              <div style={aliasPickerEmptyStyle}>
                {aliasQuery ? t('alias.no_results') : t('alias.empty')}
              </div>
            )}
            {aliasFiltered.map((a, idx) => {
              const hl = idx === activeAliasIndex;
              return (
                <div
                  key={a.name}
                  role="option"
                  aria-selected={hl ? 'true' : 'false'}
                  data-alias-name={a.name}
                  data-hl={hl ? 'true' : undefined}
                  style={hl ? aliasPickerItemHighlightStyle : aliasPickerItemStyle}
                  // Use mousedown so selecting doesn't blur the composer first.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setAliasPickerOpen(false);
                    setAliasQuery('');
                    insertAliasMarker(a.name);
                  }}
                  onMouseEnter={() => setAliasHighlightIdx(idx)}
                >
                  <span style={{ fontWeight: 500, color: '#e2e8f0' }}>{a.name}</span>
                  {a.description ? <span style={aliasPickerDimStyle}>{a.description}</span> : null}
                </div>
              );
            })}
          </div>
        )}

        {/* Inline `^` machine autocomplete dropdown. Mirrors the alias dropdown;
            owns Enter/Tab/Arrow/Escape via handleKeyDown while open. Connectivity
            remains visible but does not prevent inserting a stable marker. */}
        {machinePickerOpen && activeSession && (() => {
          return (
            <div ref={machinePickerRef} class="controls-machine-picker" role="listbox" aria-label={t('machine.category')} style={aliasPickerContainerStyle}>
              <div style={aliasPickerGroupLabelStyle}>
                {t('machine.category')} {machineQuery ? `— "${machineQuery}"` : ''}
              </div>
              {machineGroups.length > 0 && (
                <div class="controlled-nodes-group-filter controls-machine-group-filter" role="tablist" aria-label={t('controlled_nodes.group_filter_label')}>
                  <MachineGroupTabs
                    machines={machineAll}
                    group={activeMachineGroup}
                    onSelect={(nextGroup) => {
                      setMachineGroup(nextGroup);
                      setMachineHighlightIdx(0);
                    }}
                    testIdPrefix="controls-machine-group"
                    preventBlur
                  />
                </div>
              )}
              {visibleMachines.length === 0 && (
                <div style={aliasPickerEmptyStyle}>
                  {machineQuery ? t('machine.no_results') : (machineAll.length > 0 ? t('controlled_nodes.team_machines_empty') : t('machine.empty'))}
                </div>
              )}
              {visibleMachines.map((m, idx) => {
                const hl = idx === activeMachineIndex;
                return (
                  <div
                    key={m.serverId}
                    role="option"
                    aria-selected={hl ? 'true' : 'false'}
                    data-machine-node-id={m.nodeId}
                    data-machine-online={m.online ? 'true' : 'false'}
                    data-hl={hl ? 'true' : undefined}
                    style={hl ? aliasPickerItemHighlightStyle : aliasPickerItemStyle}
                    // Use mousedown so selecting doesn't blur the composer first.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setMachinePickerOpen(false);
                      setMachineQuery('');
                      if (m.nodeId) insertMachineMarker(m.nodeId, m.displayName);
                    }}
                    onMouseEnter={() => setMachineHighlightIdx(idx)}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        flexShrink: 0,
                        background: m.online ? '#22c55e' : '#64748b',
                      }}
                      title={m.online ? undefined : t('machine.offline')}
                    />
                    <span style={{ fontWeight: 500, color: '#e2e8f0' }}>{m.displayName}</span>
                    <span style={aliasPickerDimStyle}>{m.nodeId ?? MACHINE_IDENTITY_UNAVAILABLE}</span>
                    {!m.online && <span style={aliasPickerDimStyle}>{t('machine.offline_hint')}</span>}
                  </div>
                );
              })}
              {machineGroups.length > 0 && (
                <div style={{ ...aliasPickerDimStyle, padding: '4px 12px 6px' }}>
                  ↑↓ · ◂▸ {t('controlled_nodes.group_filter_label')} · ⏎
                </div>
              )}
            </div>
          );
        })()}

        {taskPairPickerOpen && filteredTaskPairReferences.length > 0 && (
          <div ref={taskPairPickerRef} class="controls-task-pair-picker" role="listbox" aria-label={t('task_pair.reference_picker')} style={aliasPickerContainerStyle}>
            <div style={aliasPickerGroupLabelStyle}>{t('task_pair.reference_picker')} {taskPairQuery ? `— "${taskPairQuery}"` : ''}</div>
            {filteredTaskPairReferences.map((task, idx) => {
              const highlighted = idx === activeTaskPairIndex;
              return (
                <div
                  key={task.taskId}
                  role="option"
                  aria-selected={highlighted ? 'true' : 'false'}
                  data-task-pair-id={task.taskId}
                  data-task-pair-title={task.title}
                  style={highlighted ? aliasPickerItemHighlightStyle : aliasPickerItemStyle}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    setTaskPairPickerOpen(false);
                    setTaskPairQuery('');
                    taskPairJustClosedRef.current = true;
                    setTimeout(() => { taskPairJustClosedRef.current = false; }, 150);
                    insertTaskPairReference(task.title);
                  }}
                  onMouseEnter={() => setTaskPairHighlightIdx(idx)}
                >
                  <span
                    class="controls-task-pair-status-badge"
                    data-task-pair-status={task.status}
                    aria-label={t(taskPairReferenceStatusKey(task.status))}
                    title={t(taskPairReferenceStatusKey(task.status))}
                  >
                    {t(taskPairReferenceStatusKey(task.status))}
                  </span>
                  <span class="controls-task-pair-title">{task.title}</span>
                </div>
              );
            })}
          </div>
        )}

        {cloudDocPickerOpen && activeSession && (
          <div
            ref={cloudDocPickerRef}
            class="controls-cloud-doc-picker"
            role="listbox"
            aria-label={t('cloud_docs.quote.reference_picker')}
            style={aliasPickerContainerStyle}
          >
            <div style={aliasPickerGroupLabelStyle}>
              {t('cloud_docs.quote.reference_picker')} {cloudDocQuery ? `— "${cloudDocQuery}"` : ''}
            </div>
            {filteredCloudDocs.length === 0 && (
              <div style={aliasPickerEmptyStyle}>
                {cloudDocLoading
                  ? t('cloud_docs.quote.reference_loading')
                  : cloudDocError
                    ? t('cloud_docs.quote.reference_error')
                    : cloudDocQuery
                      ? t('cloud_docs.quote.reference_no_results')
                      : t('cloud_docs.quote.reference_empty')}
              </div>
            )}
            {filteredCloudDocs.map((doc, idx) => {
              const highlighted = idx === activeCloudDocIndex;
              return (
                <div
                  key={doc.id}
                  role="option"
                  aria-selected={highlighted ? 'true' : 'false'}
                  data-cloud-doc-id={doc.id}
                  data-cloud-doc-name={doc.name}
                  data-hl={highlighted ? 'true' : undefined}
                  style={highlighted ? aliasPickerItemHighlightStyle : aliasPickerItemStyle}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    closeCloudDocPicker(true);
                    insertCloudDocReference(doc);
                  }}
                  onMouseEnter={() => setCloudDocHighlightIdx(idx)}
                >
                  <span style={{ fontWeight: 500, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {doc.name}
                  </span>
                  {doc.folderName ? <span style={aliasPickerDimStyle}>{doc.folderName}</span> : null}
                  {doc.shared ? (
                    <span style={{ ...aliasPickerDimStyle, color: '#38bdf8' }}>
                      {t('cloud_docs.quote.reference_shared')}
                      {doc.ownerLabel ? ` · ${doc.ownerLabel}` : ''}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {/*
          contenteditable div — iOS does NOT show the password/keychain autofill bar
          for contenteditable elements, unlike <input> or <textarea>.
        */}
        {mobileComposerExpanded && <div class="controls-composer-backdrop" onClick={() => setMobileComposerExpanded(false)} />}
        <VoiceHoldHud
          ref={voiceHoldHudRef}
          active={voiceHoldHudActive}
          phase={voiceHoldPhase}
          zone={voiceHoldZone}
          dragXRef={voiceHoldDragXRef}
          dropY={voiceHoldDropY}
          bottomClearance={voiceHoldBottomClearance}
          text={voiceHoldText}
          recognizing={voiceHoldRecognizing}
          liveAudio={voiceHoldLiveAudio}
          modelLoading={voiceModelLoading}
          serviceLabel={voiceHoldServiceLabel}
          fallbackReason={voiceHoldFallbackReason}
          transcriptRef={voiceHoldTranscriptRef}
        />
        <div ref={composerRef} class={`controls-composer${embeddedComposerActionCount > 0 ? ' controls-composer-with-trailing' : ''}${mobileComposerExpanded ? ' controls-composer-mobile-expanded' : ''}${voiceHoldReady ? ' controls-composer-voice-ready' : ''}${voiceHoldPendingRef.current ? ' controls-composer-voice-pending' : ''}${voiceHoldActive ? ' controls-composer-voice-holding' : ''}${voiceHoldHudActive && voiceHoldPhase === 'dropping' ? ' controls-composer-voice-dropping' : ''}`}>
          {!isMobileLayout && !compact && (
            <>
              <div
                class="controls-composer-resize-edge resize-hover-surface"
                role="separator"
                tabIndex={0}
                aria-orientation="horizontal"
                aria-label="Resize message input from top edge"
                aria-valuemin={COMPOSER_HEIGHT_MIN_PX}
                aria-valuemax={COMPOSER_HEIGHT_MAX_PX}
                aria-valuenow={sharedComposerHeight ?? undefined}
                {...resizeHandleHoverEvents}
                onPointerDown={startComposerTopResize}
                onKeyDown={handleComposerResizeKeyDown}
              />
            </>
          )}
          <div
            ref={divRef}
            class={`controls-input${inputDisabled ? ' controls-input-disabled' : ''}${p2pMode !== 'solo' ? ' controls-input-p2p' : ''}${embeddedComposerActionCount > 0 ? ` controls-input-with-trailing controls-input-with-trailing-${embeddedComposerActionCount}` : ''}${fileDragActive ? ' controls-input-file-drag-over' : ''}`}
            data-onboarding="chat-input"
            contenteditable={inputDisabled || voiceHoldActive || (voiceHoldReady && !(composerFocused || composerFocusedRef.current)) ? 'false' : 'true'}
            role="textbox"
            aria-multiline="true"
            aria-label="Message input"
            data-placeholder={placeholder}
            spellcheck={false}
            enterkeyhint={isMobileLayout ? 'send' : undefined}
            style={{
              ...(p2pMode !== 'solo' ? { borderColor: getP2pModeColor(p2pMode), boxShadow: `0 0 0 1px ${getP2pModeColor(p2pMode)}40` } : {}),
              ...(sharedComposerHeight !== null && !isMobileLayout && !compact ? {
                height: `${sharedComposerHeight}px`,
                minHeight: `${sharedComposerHeight}px`,
                maxHeight: `${sharedComposerHeight}px`,
              } : {}),
            }}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onClick={() => {
              const el = divRef.current;
              if (!el || suppressComposerClickFocusRef.current) {
                pendingMobileInitialEndFocusRef.current = null;
                return;
              }
              if (inputDisabledRef.current) {
                pendingMobileInitialEndFocusRef.current = null;
                return;
              }
              if (
                (voiceHoldPendingRef.current || voiceHoldActiveRef.current)
                && (voiceHoldPointerRef.current?.captureLost || voiceHoldPointerRef.current === null)
              ) {
                retireOrphanedVoiceHold();
              }
              if (voiceHoldPendingRef.current || voiceHoldActiveRef.current) return;
              const shouldMoveInitialMobileToEnd = pendingMobileInitialEndFocusRef.current !== null;
              pendingMobileInitialEndFocusRef.current = null;
              const isMobileViewport = typeof window !== 'undefined' && window.innerWidth <= 640;
              if (
                shouldMoveInitialMobileToEnd
                || !composerFocusedRef.current
                || el.getAttribute('contenteditable') !== 'true'
              ) {
                focusComposerForTyping(
                  shouldMoveInitialMobileToEnd || isMobileViewport
                    ? { moveCursorToEnd: true }
                    : undefined,
                );
              }
            }}
            onPointerDown={handleComposerVoicePointerDown}
            onPointerMove={handleComposerVoicePointerMove}
            onPointerUp={(e) => handleComposerVoicePointerEnd(e, false)}
            onPointerCancel={(e) => handleComposerVoicePointerEnd(e, true)}
            onContextMenu={(e) => {
              pendingMobileInitialEndFocusRef.current = null;
              if (voiceHoldPendingRef.current || voiceHoldActiveRef.current) {
                e.preventDefault();
              }
            }}
            onInput={(event) => {
              if (inlineVoiceActiveRef.current && !programmaticVoiceWriteRef.current) {
                interruptInlineVoiceForManualEdit();
              }
              const currentText = divRef.current ? readComposerElementText(divRef.current) : '';
              const editingText = divRef.current
                ? readComposerElementText(divRef.current, { preserveEditingLines: true })
                : '';
              syncHistoryEditOrDraft(
                editingText,
                getNavigableHistory(quickData.data, activeSessionIncognito ? undefined : activeSession?.name),
              );
              setHasText(!!currentText.trim());
              publishComposerText(currentText);
              syncMobileComposerMetrics();
              if (sendWarning) clearSendWarning();
              if (voiceHoldError) setVoiceHoldError(null);
              if (atSelectionLockRef.current && currentText !== atSelectionSnapshotRef.current) {
                atSelectionLockRef.current = false;
                atSelectionSnapshotRef.current = currentText;
              }
              // Detect @/@@: use end of text (contentEditable anchorOffset is unreliable)
              const text = currentText;
              const inputIsComposing = imeComposingRef.current
                || (event as InputEvent).isComposing === true;
              const suppressQuickPhrase = quickPhraseInputSuppressRef.current;
              quickPhraseInputSuppressRef.current = false;
              const pasteSuppressed = aliasPasteSuppressRef.current;
              aliasPasteSuppressRef.current = false;
              const machinePasteSuppressed = machinePasteSuppressRef.current;
              machinePasteSuppressRef.current = false;
              const cloudDocPasteSuppressed = cloudDocPasteSuppressRef.current;
              cloudDocPasteSuppressRef.current = false;

              const closeCompetingPickersForCloudDoc = () => {
                setAtPickerOpen(false);
                setAtPickerStage('choose');
                setAtQuery('');
                setAliasPickerOpen(false);
                setAliasQuery('');
                setMachinePickerOpen(false);
                setMachineQuery('');
                setTaskPairPickerOpen(false);
                setTaskPairQuery('');
                closeQuickSuggestions();
              };

              // @@ → open the TEAM dropdown (combos / workflows). Selecting one
              // launches a team discussion immediately with the current composer
              // text as the topic. (Single-agent @@ selection was removed — it
              // had little value vs. the combo/flow team discussion.) Strip the
              // @@ trigger but keep the preceding text as the topic.
              const doubleAt = text.match(/@@[\w-]*$/);
              const cloudDocTrigger = !doubleAt && !inputIsComposing && !cloudDocPasteSuppressed
                ? matchInlineCloudDocTrigger(text)
                : null;
              const keepCloudDocDuringComposition = !doubleAt
                && inputIsComposing
                && cloudDocPickerOpen
                && !cloudDocPasteSuppressed;

              if (doubleAt) {
                const before = text.replace(/@@[\w-]*$/, '');
                if (divRef.current) setComposerElementText(divRef.current, before);
                setHasText(!!before.trim());
                closeCompetingPickersForCloudDoc();
                if (cloudDocPickerOpen) closeCloudDocPicker();
                setP2pOpen(true);
                try {
                  const sel = window.getSelection();
                  const range = document.createRange();
                  range.selectNodeContents(divRef.current!);
                  range.collapse(false);
                  sel?.removeAllRanges();
                  sel?.addRange(range);
                } catch { /* jsdom lacks Selection API */ }
              } else if (cloudDocTrigger !== null) {
                // Single-owner precedence: when `&` Cloud Docs owns the current tail
                // (including queries containing `@`, e.g. `&@`), clear all competing
                // pickers unconditionally in this render without reading stale booleans.
                closeCompetingPickersForCloudDoc();
                setCloudDocQuery(cloudDocTrigger);
                setCloudDocHighlightIdx(0);
                setCloudDocPickerOpen(true);
              } else if (keepCloudDocDuringComposition) {
                // Keep open `&` dropdown intact during IME composition while
                // preventing `@` or other triggers from opening alongside it.
                closeCompetingPickersForCloudDoc();
              } else {
                if (cloudDocPickerOpen) {
                  closeCloudDocPicker();
                }

                const skillTrigger = inputIsComposing ? null : matchInlineSkillTrigger(text);
                const modelTrigger = inputIsComposing ? null : matchModelCommandTrigger(text);
                const slashTrigger = inputIsComposing ? null : matchSlashCommandTrigger(text);
                const hasSkillSuggestions = skillTrigger !== null
                  && agentSkills.some((skill) => !skillTrigger || [skill.name, skill.description, skill.source, skill.sourceUrl]
                    .some((value) => value?.toLocaleLowerCase().includes(skillTrigger.toLocaleLowerCase())));
                if (skillTrigger !== null && hasSkillSuggestions) {
                  setQuickSuggestionKind('skill');
                  setQuickSuggestionQuery(skillTrigger);
                  setQuickSuggestionHighlightIdx(0);
                } else if (modelTrigger !== null) {
                  setQuickSuggestionKind('model');
                  setQuickSuggestionQuery(modelTrigger);
                  setQuickSuggestionHighlightIdx(0);
                } else if (slashTrigger !== null) {
                  setQuickSuggestionKind('command');
                  setQuickSuggestionQuery(slashTrigger);
                  setQuickSuggestionHighlightIdx(0);
                } else {
                  const phraseTrigger = inputIsComposing || suppressQuickPhrase
                    ? null
                    : matchQuickPhraseTrigger(text);
                  const hasPhraseSuggestions = phraseTrigger !== null
                    && getQuickPhraseSuggestions(quickData.data.phrases, phraseTrigger).length > 0;
                  if (phraseTrigger !== null && hasPhraseSuggestions) {
                    setQuickSuggestionKind('phrase');
                    setQuickSuggestionQuery(phraseTrigger);
                    setQuickSuggestionHighlightIdx(0);
                  } else if (quickSuggestionKind !== null) {
                    closeQuickSuggestions();
                  }
                }

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
                      // Keep the picker open and let the query flow through:
                      // AtPicker owns the stage and drops into file search on
                      // the first typed character.
                      setAtPickerOpen(true);
                      setAtQuery(query);
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

                // Inline `;` alias autocomplete. Independent of the @ trigger.
                // Suppressed during IME composition and on the input event that
                // immediately follows a paste (both must not open the picker).
                const aliasTrigger = (imeComposingRef.current || pasteSuppressed)
                  ? null
                  : matchInlineAliasTrigger(text);
                if (aliasTrigger !== null) {
                  setAliasQuery(aliasTrigger);
                  setAliasHighlightIdx(0);
                  setAliasPickerOpen(true);
                } else if (aliasPickerOpen) {
                  setAliasPickerOpen(false);
                  setAliasQuery('');
                }

                // Inline `^` machine autocomplete. Independent of the `@`/`;`
                // triggers. Suppressed during IME composition and on the input
                // event immediately following a paste (both must not open it).
                const machineTrigger = (imeComposingRef.current || machinePasteSuppressed)
                  ? null
                  : matchInlineMachineTrigger(text);
                if (machineTrigger !== null) {
                  setMachineQuery(machineTrigger);
                  setMachineHighlightIdx(0);
                  setMachinePickerOpen(true);
                } else if (machinePickerOpen) {
                  setMachinePickerOpen(false);
                  setMachineQuery('');
                }

                const taskPairTrigger = inputIsComposing ? null : matchTaskPairReferenceTrigger(text);
                const taskPairMatches = taskPairTrigger === null
                  ? []
                  : filterTaskPairReferences(taskPairReferences, taskPairTrigger);
                if (taskPairTrigger !== null && taskPairMatches.length > 0) {
                  setTaskPairQuery(taskPairTrigger);
                  setTaskPairHighlightIdx(0);
                  setTaskPairPickerOpen(true);
                } else if (taskPairPickerOpen) {
                  setTaskPairPickerOpen(false);
                  setTaskPairQuery('');
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
          {embeddedComposerActionCount > 0 && (
            <div class="controls-composer-trailing-actions">
              {showEmbeddedVoiceButton && (
                <button
                  class={`btn btn-voice btn-voice-embedded${inlineVoiceActive ? ' btn-voice-inline-active' : ''}`}
                  // Open on pointerdown (fires synchronously at touch-start) so the
                  // tap is never lost to the ~300ms click delay or to a re-render
                  // unmounting this conditionally-rendered button mid-gesture, and
                  // suppress the trailing synthetic click on the same tap.
                  onPointerDown={(e) => {
                    if (e.button !== undefined && e.button !== 0) return;
                    e.preventDefault();
                    suppressNextVoiceButtonClickRef.current = true;
                    if (suppressNextVoiceButtonClickTimerRef.current !== null) {
                      clearTimeout(suppressNextVoiceButtonClickTimerRef.current);
                    }
                    suppressNextVoiceButtonClickTimerRef.current = setTimeout(() => {
                      suppressNextVoiceButtonClickTimerRef.current = null;
                      suppressNextVoiceButtonClickRef.current = false;
                    }, 400);
                    handleVoiceButtonActivate();
                  }}
                  onClick={() => {
                    if (suppressNextVoiceButtonClickRef.current) {
                      suppressNextVoiceButtonClickRef.current = false;
                      if (suppressNextVoiceButtonClickTimerRef.current !== null) {
                        clearTimeout(suppressNextVoiceButtonClickTimerRef.current);
                        suppressNextVoiceButtonClickTimerRef.current = null;
                      }
                      return;
                    }
                    handleVoiceButtonActivate();
                  }}
                  disabled={inputDisabled}
                  aria-pressed={inlineDesktopVoice ? inlineVoiceActive : undefined}
                  data-voice-trigger="embedded"
                  data-inline-voice-active={inlineVoiceActive ? 'true' : undefined}
                  data-notepad-draft={hasVoiceNotepadDraft ? 'true' : undefined}
                  title={hasVoiceNotepadDraft ? t('voice.notepad_draft_indicator') : t('voice.voice_input')}
                  aria-label={t('voice.voice_input')}
                >
                  🎙
                </button>
              )}
              {showEmbeddedAttachmentButton && (
                <button
                  class="btn btn-voice btn-attachment-embedded"
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={inputDisabled || uploading}
                  title={uploading ? t('upload.uploading') : t('upload.upload_file')}
                  aria-label={uploading ? t('upload.uploading') : t('upload.upload_file')}
                >
                  {uploading ? '…' : '\u{1F4CE}'}
                </button>
              )}
            </div>
          )}
        </div>
        {isMobileLayout && isTransport && (
          <div class="composer-mobile-side-actions">
            {showMobileStackedAttachmentButton && (
              <button
                type="button"
                class="btn btn-voice btn-attachment-mobile-stacked"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => fileInputRef.current?.click()}
                disabled={inputDisabled || uploading}
                title={uploading ? t('upload.uploading') : t('upload.upload_file')}
                aria-label={uploading ? t('upload.uploading') : t('upload.upload_file')}
              >
                {uploading ? '…' : '\u{1F4CE}'}
              </button>
            )}
            <button
              type="button"
              class={`composer-delivery-mode composer-delivery-mode-mobile${directAppendMode ? ' is-append' : ' is-queue'}`}
              onClick={handleDeliveryModeToggle}
              aria-pressed={directAppendMode}
              aria-label={`${deliveryModeLabel}: ${deliveryModeDescription}`}
              title={deliveryModeDescription}
              disabled={inputDisabled}
            >
              <ComposerDeliveryModeIcon append={directAppendMode} />
            </button>
          </div>
        )}
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
            {!isMobileLayout && (
              <button
                class="btn btn-voice"
                onClick={() => fileInputRef.current?.click()}
                disabled={inputDisabled || uploading}
                title={uploading ? t('upload.uploading') : t('upload.upload_file')}
              >
                {uploading ? '...' : '\u{1F4CE}'}
              </button>
            )}
          </>
        )}
        {!isMobileLayout && VoiceInput.isAvailable() && (
          <button
            class={`btn btn-voice${inlineVoiceActive ? ' btn-voice-inline-active' : ''}`}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => handleVoiceButtonActivate()}
            disabled={inputDisabled}
            aria-pressed={inlineDesktopVoice ? inlineVoiceActive : undefined}
            data-voice-trigger="desktop"
            data-inline-voice-active={inlineVoiceActive ? 'true' : undefined}
            data-notepad-draft={hasVoiceNotepadDraft ? 'true' : undefined}
            title={hasVoiceNotepadDraft ? t('voice.notepad_draft_indicator') : t('voice.voice_input')}
          >
            🎙
          </button>
        )}
        {showPcVoiceMicSelect && (() => {
          const resolvedAutoPhysical = pcVoiceDevices.find((d) => d.isDefault && d.isPhysical)
            ?? pcVoiceDevices.find((d) => d.isPhysical)
            ?? null;
          const autoMicLabel = resolvedAutoPhysical
            ? `${t('voice.mic_auto_prefix')} · ${resolvedAutoPhysical.name}`
            : t('voice.mic_auto');
          const hasExplicitMissing = pcVoiceSelectedDevice !== 'auto'
            && !pcVoiceDevices.some((d) => d.uid === pcVoiceSelectedDevice);
          const selectedLabel = pcVoiceSelectedDevice === 'auto'
            ? autoMicLabel
            : (pcVoiceDevices.find((d) => d.uid === pcVoiceSelectedDevice)?.name ?? pcVoiceSelectedDevice);
          return (
            <select
              class="pc-voice-mic-select"
              data-testid="pc-voice-mic-select"
              aria-label={t('voice.mic_select_label')}
              title={selectedLabel}
              value={pcVoiceSelectedDevice}
              disabled={inputDisabled}
              onFocus={() => { void refreshPcVoiceInputDevices(); }}
              onPointerDown={() => { void refreshPcVoiceInputDevices(); }}
              onInput={(e) => handlePcVoiceMicSelectChange((e.currentTarget as HTMLSelectElement).value)}
              onChange={(e) => handlePcVoiceMicSelectChange((e.currentTarget as HTMLSelectElement).value)}
            >
              <option value="auto">{autoMicLabel}</option>
              {hasExplicitMissing && (
                <option value={pcVoiceSelectedDevice}>{pcVoiceSelectedDevice}</option>
              )}
              {pcVoiceDevices.map((dev) => (
                <option key={dev.uid} value={dev.uid}>{dev.name}</option>
              ))}
            </select>
          );
        })()}
        {!isMobileLayout && (
          <button
            class="btn btn-primary"
            onClick={handleSend}
            disabled={inputDisabled || uploading || (!hasText && attachments.length === 0 && !pendingDelegateTarget) || !connected}
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
              {onSettings && canOpenSessionSettings && (
                <>
                  <button
                    class="menu-item session-action-menu-item"
                    onClick={() => { onSettings({ surface: 'session' }); setMenuOpen(false); }}
                  >
                    <SessionActionMenuIcon kind="settings" />
                    <span class="session-action-menu-label">{t('session.settings')}</span>
                  </button>
                  {supportsSupervisionSurface && (
                    <button
                      class="menu-item session-action-menu-item"
                      onClick={() => { onSettings({ surface: 'supervision' }); setMenuOpen(false); }}
                    >
                      <SessionActionMenuIcon kind="settings" />
                      <span class="session-action-menu-label">{t('session.supervision.settingsTitle')}</span>
                    </button>
                  )}
                </>
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
              {(!isShareScopedSession || canManageSharedServer) && (
                <>
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
                </>
              )}
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
              {appendableQueuedTransportEntries.length > 0 && (
                <ConfirmButton
                  className="controls-queued-toggle"
                  confirmClassName="controls-queued-toggle"
                  label={t('session.transport_queue_append_all')}
                  confirmLabel={t('session.transport_queue_append_all_confirm')}
                  onConfirm={() => handleQueuedMessagesAppend(appendableQueuedTransportEntries)}
                  resetKey={appendAllConfirmationScope}
                  testId="transport-queue-append-all"
                />
              )}
              <div>
                {activeQueuedTransportEntries.length > 0
                  ? t(queuedMessageDeliveryLabelKey(activeQueuedTransportEntries.find((entry) => entry.deliveryMode === SESSION_SEND_DELIVERY_MODES.APPEND && !entry.appendFallbackReason) ?? activeQueuedTransportEntries[0] ?? {}))
                  : t('chat.sendFailedLabel', 'Send failed')}
              </div>
              <button type="button" class="controls-queued-toggle" onClick={toggleQueuedHintExpanded}>
                {t('common.hide')}
              </button>
            </div>
            <div class="controls-queued-list">
              {queuedTransportEntries.map((entry) => {
                const sharedActorLabel = formatSharedActorLabel(t, entry.sharedActor);
                return (
                <div class="controls-queued-item" key={entry.clientMessageId}>
                  {canSharedSessionSend && entry.status !== 'failed' && isEditableQueuedEntry(entry) && (
                    <button type="button" class="controls-queued-action controls-queued-action-append" onClick={() => handleQueuedMessagesAppend([entry])}>
                      {t('session.transport_queue_append')}
                    </button>
                  )}
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
                          : t(queuedMessageDeliveryLabelKey(entry))
                    }
                    title={
                      entry.status === 'failed'
                        ? t('chat.sendFailedLabel', 'Send failed')
                        : entry.status === 'sending'
                          ? t('chat.sendingLabel', 'Sending')
                          : t(queuedMessageDeliveryLabelKey(entry))
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
          <span>{t(queuedMessageDeliveryLabelKey(editingQueuedEntry))} · {t('settings.edit')}</span>
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
    {inlineVoiceActive && inlineVoiceRobotHostRef.current && createPortal(
      <VoiceStreamingRobot active={inlineVoiceActive || inlineVoiceRecognizing} level={inlineVoiceLevel} />,
      inlineVoiceRobotHostRef.current,
    )}
    <VoiceOverlay
      open={voiceOpen}
      onClose={() => {
        setVoiceOpen(false);
        setVoiceOverlayInitialText(null);
        setVoiceOverlayAutoStart(true);
      }}
      onSend={handleVoiceSend}
      onSendNotepad={handleVoiceNotepadSend}
      draftScope={voiceNotepadDraftScope}
      sessionLabel={composerTargetName}
      autoStartListening={voiceOverlayAutoStart}
      initialText={voiceOverlayInitialText !== null ? voiceOverlayInitialText : (divRef.current ? readComposerElementText(divRef.current) : '')}
    />
    {p2pConfigOpen && (
      <P2pConfigPanel
        sessions={(sessions ?? []).map(s => ({
          name: s.name,
          agentType: s.agentType,
          state: s.state,
          project: s.project,
          role: s.role,
          executionTemplateEligible: s.executionTemplateEligible,
          executionTemplateIneligibleReason: s.executionTemplateIneligibleReason,
        }))}
        subSessions={subSessions ?? []}
        activeSession={activeSession?.name}
        serverId={serverId}
        initialTab={p2pConfigInitialTab}
        onClose={() => setP2pConfigOpen(false)}
        onPersistDaemonConfig={(scopeSession, cfg) => persistP2pConfigToDaemon(scopeSession, cfg)}
        onSave={(cfg) => {
          setP2pSavedConfig(sanitizeP2pSavedConfig(cfg, { scopeSession: rootSession }));
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
