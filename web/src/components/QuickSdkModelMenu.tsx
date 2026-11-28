import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { AGY_SDK_PROVIDER_ID } from '@shared/agy-agent.js';
import {
  CUSTOM_PROVIDER_SDK_AGENT_TYPES,
  getCcPresetEffectiveModel,
  normalizeCcPresetName,
  type CcPreset,
} from '@shared/cc-presets.js';
import { patchSession, patchSubSession } from '../api.js';
import { saveAgyModelPreference } from '../agy-model-preference.js';
import { useAgentAvailability } from '../hooks/useAgentAvailability.js';
import { useCcPresets } from '../hooks/useCcPresets.js';
import { isShareScopedState } from '../tab-sharing-ui.js';
import type { AgentAvailabilityMap } from '@shared/agent-availability.js';
import {
  buildTransportModelCatalogIdentity,
  supportsDynamicTransportModels,
  useTransportModels,
} from '../hooks/useTransportModels.js';
import type { SessionInfo } from '../types.js';
import type { WsClient } from '../ws-client.js';
import type { AppliedSessionRestartState } from '@shared/session-restart-contract.js';
import {
  captureSessionSwitchBaseline,
  isSessionSwitchSupersededBySync,
  type SessionSwitchBaseline,
  type SessionSwitchComparable,
} from '../session-state-updates.js';
import { getSessionAgentLabel } from './session-agent-options.js';
import {
  findQuickSdkChoice,
  getQuickSwitchableSdkGroups,
  resolveCrossSdkModels,
  resolveEffectiveCrossSdkPreset,
} from './quick-sdk-model.js';

export interface QuickSdkSavedFields {
  type: string;
  requestedModel: string | null;
  activeModel: string | null;
  modelDisplay: string | null;
  ccPreset?: string | null;
}

export interface SameSdkModelItem {
  id: string;
  label?: string;
  title?: string;
}

export function isQuickSdkUnavailable(
  sdkId: string,
  currentSdk: string,
  availability: AgentAvailabilityMap | null | undefined,
): boolean {
  return sdkId !== currentSdk && availability?.[sdkId]?.installed === false;
}

interface CrossSdkPreviewCatalogProps {
  ws: WsClient | null;
  sessionName: string | undefined;
  targetScope: string | undefined;
  previewSdk: string;
  effectivePreset: string | null;
  effectivePresetEntry?: CcPreset | null;
  switching: boolean;
  onSelectCrossModel: (modelId: string | null) => void;
}

/**
 * Keyed per `(targetScope, sessionName, previewSdk, effectivePreset)` by parent
 * so changing the previewed SDK or preset remounts cleanly with fresh
 * `useTransportModels` state and zero cross-SDK/preset stale bleed.
 */
function CrossSdkPreviewCatalog({
  ws,
  sessionName,
  targetScope,
  previewSdk,
  effectivePreset,
  effectivePresetEntry,
  switching,
  onSelectCrossModel,
}: CrossSdkPreviewCatalogProps) {
  const { t } = useTranslation();
  const dynamicModels = useTransportModels(
    ws,
    supportsDynamicTransportModels(previewSdk) ? previewSdk : null,
    effectivePreset,
    sessionName,
    targetScope,
  );

  const catalog = useMemo(
    () => resolveCrossSdkModels({
      sdk: previewSdk,
      sessionName,
      ccPreset: effectivePreset,
      presetEntry: effectivePresetEntry,
      targetScope,
      dynamicState: dynamicModels,
    }),
    [previewSdk, sessionName, effectivePreset, effectivePresetEntry, targetScope, dynamicModels],
  );

  return (
    <>
      <button
        type="button"
        data-testid="quick-sdk-default-switch"
        class="menu-item quick-sdk-model-item quick-sdk-default-item"
        disabled={switching}
        onClick={() => onSelectCrossModel(catalog.defaultModel)}
        title={catalog.defaultModel
          ? `${t('session.quickSwitch.useDefaultModel')} (${catalog.defaultModel})`
          : t('session.quickSwitch.useDefaultModel')}
      >
        <span class="quick-sdk-model-item-text">↻ {t('session.quickSwitch.useDefaultModel')}</span>
        {catalog.defaultModel && (
          <span class="quick-sdk-default-tag">{catalog.defaultModel}</span>
        )}
      </button>

      {catalog.loading && (
        <div class="quick-sdk-status-row" data-testid="quick-sdk-loading">
          {t('session.quickSwitch.loadingModels')}
        </div>
      )}

      {catalog.models.map((modelId) => (
        <button
          key={modelId}
          type="button"
          data-cross-model-id={modelId}
          class="menu-item quick-sdk-model-item"
          disabled={switching}
          onClick={() => onSelectCrossModel(modelId)}
          title={modelId}
        >
          <span class="quick-sdk-model-item-text">○ {modelId}</span>
        </button>
      ))}

      {!catalog.loading && catalog.models.length === 0 && (
        <div class="quick-sdk-empty-row" data-testid="quick-sdk-empty">
          {t('session.quickSwitch.noModels')}
        </div>
      )}
    </>
  );
}

interface QuickSdkModelMenuProps {
  ws: WsClient | null;
  activeSession: SessionInfo | null | undefined;
  serverId?: string | null;
  subSessionId?: string;
  modelOpen: boolean;
  splitAllowed: boolean;
  disabled?: boolean;
  switching?: boolean;
  onSwitchingChange?: (switching: boolean) => void;
  currentSdk: string;
  currentModel: string | null;
  sameSdkItems: readonly SameSdkModelItem[];
  onSelectSameSdkModel: (model: string) => void;
  onClose: () => void;
  onAfterAction?: () => void;
  onSessionSaved?: (fields: QuickSdkSavedFields) => void;
  getLiveSession?: () => SessionSwitchComparable | null | undefined;
  onSessionSwitchCommit?: (
    sessionName: string,
    baseline: SessionSwitchBaseline | null,
    applied: AppliedSessionRestartState | null,
  ) => void;
  onSwitchError?: (message: string) => void;
  onOpenCcPresetManager?: () => void;
}

export function QuickSdkModelMenu({
  ws,
  activeSession,
  serverId,
  subSessionId,
  modelOpen,
  splitAllowed,
  disabled = false,
  switching: switchingProp,
  onSwitchingChange,
  currentSdk,
  currentModel,
  sameSdkItems,
  onSelectSameSdkModel,
  onClose,
  onAfterAction,
  onSessionSaved,
  getLiveSession,
  onSessionSwitchCommit,
  onSwitchError,
  onOpenCcPresetManager,
}: QuickSdkModelMenuProps) {
  const { t } = useTranslation();
  const currentPreset = activeSession?.ccPreset?.trim() ?? '';
  const [previewSdk, setPreviewSdk] = useState<string>(currentSdk);
  const [previewPreset, setPreviewPreset] = useState<string>(currentPreset);
  const [internalSwitching, setInternalSwitching] = useState(false);
  const switching = switchingProp ?? internalSwitching;
  const actionDisabled = Boolean(disabled || switching);
  const switchingRef = useRef(false);
  switchingRef.current = switching;
  const mountedRef = useRef(true);
  const prevOpenRef = useRef(false);

  const { availability: agentAvailability } = useAgentAvailability(ws, { enabled: splitAllowed && modelOpen });
  const { presets: ccPresets } = useCcPresets(ws, { enabled: splitAllowed && modelOpen });

  const updateSwitching = (next: boolean) => {
    switchingRef.current = next;
    onSwitchingChange?.(next);
    if (mountedRef.current) {
      setInternalSwitching(next);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Default preview column & preset to the session's current SDK/preset every time the menu opens or currentSdk changes.
  useEffect(() => {
    const justOpened = modelOpen && !prevOpenRef.current;
    prevOpenRef.current = modelOpen;
    if (justOpened || (modelOpen && prevOpenRef.current)) {
      if (justOpened) {
        setPreviewSdk(currentSdk);
        setPreviewPreset(currentPreset);
      }
    }
  }, [modelOpen, currentSdk, currentPreset]);

  useEffect(() => {
    if (modelOpen) {
      setPreviewSdk(currentSdk);
      setPreviewPreset(currentPreset);
    }
  }, [currentSdk, currentPreset, modelOpen]);

  // If availability probe completes while user already clicked an uninstalled preview SDK,
  // snap the preview column cleanly back to the active SDK so the right rail cannot PATCH it.
  useEffect(() => {
    if (modelOpen && isQuickSdkUnavailable(previewSdk, currentSdk, agentAvailability)) {
      setPreviewSdk(currentSdk);
      setPreviewPreset(currentPreset);
    }
  }, [modelOpen, previewSdk, currentSdk, currentPreset, agentAvailability]);

  const handleSelectPreviewSdk = (nextSdk: string) => {
    if (isQuickSdkUnavailable(nextSdk, currentSdk, agentAvailability)) return;
    setPreviewSdk(nextSdk);
    if (nextSdk === currentSdk) {
      setPreviewPreset(currentPreset);
    } else {
      setPreviewPreset(resolveEffectiveCrossSdkPreset(currentSdk, nextSdk, currentPreset) ?? '');
    }
  };

  const sdkGroups = useMemo(
    () => getQuickSwitchableSdkGroups(currentSdk, subSessionId ? 'sub-session' : 'new-session'),
    [currentSdk, subSessionId],
  );

  const effectiveTargetScope = useMemo(
    () => serverId?.trim()
      || (ws as { getServerId?: () => string } | null)?.getServerId?.()?.trim()
      || ws?.getDaemonCapabilitySnapshot?.()?.daemonId?.trim()
      || undefined,
    [serverId, ws],
  );

  const previewSupportsPreset = CUSTOM_PROVIDER_SDK_AGENT_TYPES.has(previewSdk);
  const effectivePreviewPreset = previewSupportsPreset ? (previewPreset.trim() || null) : null;
  const matchedPreviewPreset = useMemo(
    () => (effectivePreviewPreset
      ? ccPresets.find((p) => normalizeCcPresetName(p.name) === normalizeCcPresetName(effectivePreviewPreset))
      : undefined),
    [ccPresets, effectivePreviewPreset],
  );
  const isCrossSdkPreview = splitAllowed && previewSdk !== currentSdk;
  const isPresetSwitch = splitAllowed && previewSupportsPreset && (effectivePreviewPreset ?? '') !== currentPreset;
  const isRelaunchSwitch = isCrossSdkPreview || isPresetSwitch;

  const previewIdentityKey = useMemo(
    () => buildTransportModelCatalogIdentity({
      agentType: previewSdk,
      ccPreset: effectivePreviewPreset,
      sessionName: activeSession?.name,
      targetScope: effectiveTargetScope,
    }),
    [previewSdk, effectivePreviewPreset, activeSession?.name, effectiveTargetScope],
  );

  const previewChoice = useMemo(
    () => findQuickSdkChoice(sdkGroups, previewSdk),
    [sdkGroups, previewSdk],
  );
  const previewSdkLabel = previewChoice
    ? getSessionAgentLabel(t, previewChoice)
    : previewSdk;

  const handleSameSdkSelect = (modelId: string) => {
    if (disabled || switchingRef.current) return;
    onSelectSameSdkModel(modelId);
  };

  const handleCrossSdkSwitch = async (nextSdk: string, nextModel: string | null, nextPreset: string | null) => {
    if (disabled || switchingRef.current || !activeSession || !serverId?.trim()) return;
    if (isQuickSdkUnavailable(nextSdk, currentSdk, agentAvailability)) return;
    const baseline = captureSessionSwitchBaseline(activeSession);
    const nextEffectivePreset = CUSTOM_PROVIDER_SDK_AGENT_TYPES.has(nextSdk)
      ? (nextPreset?.trim() || null)
      : null;
    updateSwitching(true);
    onClose();
    try {
      const response = subSessionId
        ? await patchSubSession(serverId, subSessionId, {
            type: nextSdk,
            requestedModel: nextModel,
            activeModel: null,
            ccPresetId: nextEffectivePreset,
          })
        : await patchSession(serverId, activeSession.name, {
            agentType: nextSdk,
            requestedModel: nextModel,
            activeModel: null,
            ccPreset: nextEffectivePreset,
          });
      if (response?.pending) {
        onSwitchError?.(t('session.quickSwitch.switchPending'));
        return;
      }
      if (response?.superseded || response?.ok === false) {
        return;
      }
      const applied = response?.applied;
      const latestSession = getLiveSession?.();
      if (isSessionSwitchSupersededBySync(latestSession, baseline, applied)) {
        return;
      }
      const savedType = applied ? applied.agentType : nextSdk;
      const savedModel = applied ? applied.requestedModel : nextModel;
      const savedActiveModel = applied ? applied.activeModel : null;
      const savedModelDisplay = applied ? (applied.modelDisplay ?? applied.activeModel) : null;
      const savedPreset = applied ? applied.ccPreset : nextEffectivePreset;
      onSessionSwitchCommit?.(activeSession.name, baseline, applied ?? null);
      if (savedType === AGY_SDK_PROVIDER_ID && savedModel) {
        saveAgyModelPreference(savedModel, activeSession.name);
      }
      onSessionSaved?.({
        type: savedType,
        requestedModel: savedModel,
        activeModel: savedActiveModel,
        modelDisplay: savedModelDisplay,
        ccPreset: savedPreset,
      });
      onAfterAction?.();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      onSwitchError?.(t('session.quickSwitch.switchFailed', { error: detail }));
    } finally {
      updateSwitching(false);
    }
  };

  if (!splitAllowed) {
    return (
      <>
        {sameSdkItems.map((item) => (
          <button
            key={item.id}
            type="button"
            class={`menu-item ${currentModel === item.id ? 'menu-item-active' : ''}`}
            disabled={actionDisabled}
            onClick={() => handleSameSdkSelect(item.id)}
            title={item.title ?? item.id}
          >
            {currentModel === item.id ? '● ' : '○ '}{item.label ?? item.id}
          </button>
        ))}
      </>
    );
  }

  const hasSelectedPresetInList = !previewPreset
    || ccPresets.some((p) => normalizeCcPresetName(p.name) === normalizeCcPresetName(previewPreset));

  return (
    <div
      class="quick-sdk-model-split"
      data-testid="quick-sdk-model-split"
      data-preview-sdk={previewSdk}
      data-preview-preset={effectivePreviewPreset ?? ''}
      data-switching={switching ? 'true' : 'false'}
    >
      <div
        class="quick-sdk-model-sdks"
        aria-label={t('session.quickSwitch.sdkTitle')}
      >
        <div class="quick-sdk-col-header">
          <span>{t('session.quickSwitch.sdkTitle')}</span>
        </div>
        <div class="quick-sdk-col-scroll">
          {sdkGroups.map((group, groupIdx) => (
            <div key={group.id} class="quick-sdk-group">
              {groupIdx > 0 && <div class="quick-sdk-group-divider" />}
              {group.items.map((choice) => {
                const isCurrent = choice.id === currentSdk;
                const isPreview = choice.id === previewSdk;
                const label = getSessionAgentLabel(t, choice);
                const availability = agentAvailability?.[choice.id];
                const isUnavailable = isQuickSdkUnavailable(choice.id, currentSdk, agentAvailability);
                const unavailableReason = availability?.reason?.trim();
                const tooltip = isUnavailable
                  ? `${label} — ${t('new_session.agent_not_installed_hint')}${unavailableReason ? `: ${unavailableReason}` : ''}`
                  : label;
                return (
                  <button
                    key={choice.id}
                    type="button"
                    aria-pressed={isPreview}
                    aria-disabled={isUnavailable ? 'true' : undefined}
                    data-sdk-id={choice.id}
                    data-installed={availability ? String(availability.installed) : undefined}
                    class={`quick-sdk-item${isPreview ? ' is-preview' : ''}${isCurrent ? ' is-current' : ''}${isUnavailable ? ' is-unavailable' : ''}`}
                    disabled={actionDisabled || isUnavailable}
                    onClick={() => { if (!isUnavailable) handleSelectPreviewSdk(choice.id); }}
                    title={tooltip}
                  >
                    <span class="quick-sdk-item-icon" aria-hidden="true">{choice.icon}</span>
                    <span class="quick-sdk-item-label">{label}</span>
                    {isCurrent && (
                      <span class="quick-sdk-item-dot" aria-hidden="true">●</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div
        class="quick-sdk-model-models"
        aria-label={t('session.quickSwitch.modelsTitle')}
      >
        <div class="quick-sdk-col-header quick-sdk-col-header-models">
          <span class="quick-sdk-col-title">{previewSdkLabel}</span>
          {isRelaunchSwitch && (
            <span
              class="quick-sdk-handoff-badge"
              title={isCrossSdkPreview ? t('session.quickSwitch.handoffHint') : t('session.quickSwitch.presetRelaunchHint')}
            >
              {isCrossSdkPreview ? t('session.quickSwitch.handoffHint') : t('session.quickSwitch.presetRelaunchHint')}
            </span>
          )}
        </div>

        {previewSupportsPreset && (
          <div class="quick-sdk-preset-bar" data-testid="quick-sdk-preset-bar">
            <span class="quick-sdk-preset-label">{t('session.quickSwitch.presetLabel')}</span>
            <select
              data-testid="quick-sdk-preset-select"
              aria-label={t('session.quickSwitch.presetLabel')}
              class="quick-sdk-preset-select"
              value={previewPreset}
              disabled={actionDisabled}
              onInput={(e) => setPreviewPreset((e.target as HTMLSelectElement).value)}
              onChange={(e) => setPreviewPreset((e.target as HTMLSelectElement).value)}
            >
              <option value="">{t('session.quickSwitch.presetDefault')}</option>
              {!hasSelectedPresetInList && previewPreset && (
                <option value={previewPreset}>{previewPreset}</option>
              )}
              {ccPresets.map((p) => {
                const effModel = getCcPresetEffectiveModel(p);
                return (
                  <option key={p.name} value={p.name}>
                    {effModel ? `${p.name} (${effModel})` : p.name}
                  </option>
                );
              })}
            </select>
            {onOpenCcPresetManager && !isShareScopedState(activeSession?.sharedState) && (
              <button
                type="button"
                class="quick-sdk-preset-manage-btn"
                data-testid="quick-sdk-manage-presets"
                disabled={actionDisabled}
                onClick={() => {
                  onClose();
                  onOpenCcPresetManager();
                }}
                title={t('session.quickSwitch.managePresets')}
                aria-label={t('session.quickSwitch.managePresets')}
              >
                ⚙
              </button>
            )}
          </div>
        )}

        <div class="quick-sdk-col-scroll">
          {!isRelaunchSwitch ? (
            sameSdkItems.length > 0 ? (
              sameSdkItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={currentModel === item.id}
                  class={`menu-item quick-sdk-model-item${currentModel === item.id ? ' menu-item-active' : ''}`}
                  disabled={actionDisabled}
                  onClick={() => handleSameSdkSelect(item.id)}
                  title={item.title ?? item.id}
                >
                  <span class="quick-sdk-model-item-text">
                    {currentModel === item.id ? '● ' : '○ '}{item.label ?? item.id}
                  </span>
                </button>
              ))
            ) : (
              <div class="quick-sdk-empty-row">{t('session.quickSwitch.noModelsCurrent')}</div>
            )
          ) : (
            modelOpen && (
              <CrossSdkPreviewCatalog
                key={previewIdentityKey}
                ws={ws}
                sessionName={activeSession?.name}
                targetScope={effectiveTargetScope}
                previewSdk={previewSdk}
                effectivePreset={effectivePreviewPreset}
                effectivePresetEntry={matchedPreviewPreset}
                switching={actionDisabled}
                onSelectCrossModel={(modelId) => void handleCrossSdkSwitch(previewSdk, modelId, effectivePreviewPreset)}
              />
            )
          )}
        </div>
      </div>
    </div>
  );
}
