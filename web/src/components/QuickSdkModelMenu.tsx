import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { AGY_SDK_PROVIDER_ID } from '@shared/agy-agent.js';
import { patchSession, patchSubSession } from '../api.js';
import { saveAgyModelPreference } from '../agy-model-preference.js';
import { supportsDynamicTransportModels, useTransportModels } from '../hooks/useTransportModels.js';
import type { SessionInfo } from '../types.js';
import type { WsClient } from '../ws-client.js';
import { getSessionAgentLabel } from './session-agent-options.js';
import {
  findQuickSdkChoice,
  getQuickSwitchableSdkGroups,
  resolveCrossSdkModels,
} from './quick-sdk-model.js';

export interface QuickSdkSavedFields {
  type: string;
  requestedModel: string | null;
  activeModel: null;
  modelDisplay: null;
}

export interface SameSdkModelItem {
  id: string;
  label?: string;
  title?: string;
}

interface QuickSdkModelMenuProps {
  ws: WsClient | null;
  activeSession: SessionInfo | null | undefined;
  serverId?: string | null;
  subSessionId?: string;
  modelOpen: boolean;
  splitAllowed: boolean;
  switching?: boolean;
  onSwitchingChange?: (switching: boolean) => void;
  currentSdk: string;
  currentModel: string | null;
  sameSdkItems: readonly SameSdkModelItem[];
  onSelectSameSdkModel: (model: string) => void;
  onClose: () => void;
  onAfterAction?: () => void;
  onSessionSaved?: (fields: QuickSdkSavedFields) => void;
  onSwitchError?: (message: string) => void;
}

export function QuickSdkModelMenu({
  ws,
  activeSession,
  serverId,
  subSessionId,
  modelOpen,
  splitAllowed,
  switching: switchingProp,
  onSwitchingChange,
  currentSdk,
  currentModel,
  sameSdkItems,
  onSelectSameSdkModel,
  onClose,
  onAfterAction,
  onSessionSaved,
  onSwitchError,
}: QuickSdkModelMenuProps) {
  const { t } = useTranslation();
  const [previewSdk, setPreviewSdk] = useState<string>(currentSdk);
  const [internalSwitching, setInternalSwitching] = useState(false);
  const switching = switchingProp ?? internalSwitching;
  const switchingRef = useRef(false);
  switchingRef.current = switching;
  const mountedRef = useRef(true);

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

  // Default preview column to the session's current SDK every time the menu opens.
  useEffect(() => {
    if (modelOpen) {
      setPreviewSdk(currentSdk);
    }
  }, [modelOpen, currentSdk]);

  const sdkGroups = useMemo(
    () => getQuickSwitchableSdkGroups(currentSdk, subSessionId ? 'sub-session' : 'new-session'),
    [currentSdk, subSessionId],
  );

  const isCrossSdkPreview = splitAllowed && previewSdk !== currentSdk;

  // Lazy discovery: ONLY query daemon models for a different previewed SDK while
  // the dropdown is open. Never fan out across SDKs when closed or on mount.
  const crossSdkDynamicAgentType =
    modelOpen && isCrossSdkPreview && supportsDynamicTransportModels(previewSdk)
      ? previewSdk
      : null;

  const crossSdkDynamicModels = useTransportModels(
    ws,
    crossSdkDynamicAgentType,
    undefined,
    activeSession?.name,
  );

  const crossSdkCatalog = useMemo(() => {
    if (!isCrossSdkPreview) {
      return { models: [] as string[], defaultModel: null as string | null, loading: false };
    }
    return resolveCrossSdkModels({
      sdk: previewSdk,
      sessionName: activeSession?.name,
      dynamicState: crossSdkDynamicModels,
    });
  }, [isCrossSdkPreview, previewSdk, activeSession?.name, crossSdkDynamicModels]);

  const previewChoice = useMemo(
    () => findQuickSdkChoice(sdkGroups, previewSdk),
    [sdkGroups, previewSdk],
  );
  const previewSdkLabel = previewChoice
    ? getSessionAgentLabel(t, previewChoice)
    : previewSdk;

  const handleCrossSdkSwitch = async (nextSdk: string, nextModel: string | null) => {
    if (switchingRef.current || !activeSession || !serverId?.trim()) return;
    updateSwitching(true);
    onClose();
    try {
      if (subSessionId) {
        await patchSubSession(serverId, subSessionId, {
          type: nextSdk,
          requestedModel: nextModel,
          activeModel: null,
        });
      } else {
        await patchSession(serverId, activeSession.name, {
          agentType: nextSdk,
          requestedModel: nextModel,
          activeModel: null,
        });
      }
      if (nextSdk === AGY_SDK_PROVIDER_ID && nextModel) {
        saveAgyModelPreference(nextModel, activeSession.name);
      }
      onSessionSaved?.({
        type: nextSdk,
        requestedModel: nextModel,
        activeModel: null,
        modelDisplay: null,
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
            onClick={() => onSelectSameSdkModel(item.id)}
            title={item.title ?? item.id}
          >
            {currentModel === item.id ? '● ' : '○ '}{item.label ?? item.id}
          </button>
        ))}
      </>
    );
  }

  return (
    <div
      class="quick-sdk-model-split"
      data-testid="quick-sdk-model-split"
      data-preview-sdk={previewSdk}
      data-switching={switching ? 'true' : 'false'}
    >
      <div
        class="quick-sdk-model-sdks"
        role="listbox"
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
                return (
                  <button
                    key={choice.id}
                    type="button"
                    role="option"
                    aria-selected={isPreview}
                    data-sdk-id={choice.id}
                    class={`quick-sdk-item${isPreview ? ' is-preview' : ''}${isCurrent ? ' is-current' : ''}`}
                    onClick={() => setPreviewSdk(choice.id)}
                    title={label}
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
        role="listbox"
        aria-label={t('session.quickSwitch.modelsTitle')}
      >
        <div class="quick-sdk-col-header quick-sdk-col-header-models">
          <span class="quick-sdk-col-title">{previewSdkLabel}</span>
          {isCrossSdkPreview && (
            <span class="quick-sdk-handoff-badge" title={t('session.quickSwitch.handoffHint')}>
              {t('session.quickSwitch.handoffHint')}
            </span>
          )}
        </div>
        <div class="quick-sdk-col-scroll">
          {!isCrossSdkPreview ? (
            sameSdkItems.length > 0 ? (
              sameSdkItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={currentModel === item.id}
                  class={`menu-item quick-sdk-model-item${currentModel === item.id ? ' menu-item-active' : ''}`}
                  onClick={() => onSelectSameSdkModel(item.id)}
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
            <>
              <button
                type="button"
                data-testid="quick-sdk-default-switch"
                class="menu-item quick-sdk-model-item quick-sdk-default-item"
                disabled={switching}
                onClick={() => void handleCrossSdkSwitch(previewSdk, crossSdkCatalog.defaultModel)}
                title={crossSdkCatalog.defaultModel
                  ? `${t('session.quickSwitch.useDefaultModel')} (${crossSdkCatalog.defaultModel})`
                  : t('session.quickSwitch.useDefaultModel')}
              >
                <span class="quick-sdk-model-item-text">↻ {t('session.quickSwitch.useDefaultModel')}</span>
                {crossSdkCatalog.defaultModel && (
                  <span class="quick-sdk-default-tag">{crossSdkCatalog.defaultModel}</span>
                )}
              </button>

              {crossSdkCatalog.loading && (
                <div class="quick-sdk-status-row" data-testid="quick-sdk-loading">
                  {t('session.quickSwitch.loadingModels')}
                </div>
              )}

              {crossSdkCatalog.models.map((modelId) => (
                <button
                  key={modelId}
                  type="button"
                  role="option"
                  aria-selected={false}
                  data-cross-model-id={modelId}
                  class="menu-item quick-sdk-model-item"
                  disabled={switching}
                  onClick={() => void handleCrossSdkSwitch(previewSdk, modelId)}
                  title={modelId}
                >
                  <span class="quick-sdk-model-item-text">○ {modelId}</span>
                </button>
              ))}

              {!crossSdkCatalog.loading && crossSdkCatalog.models.length === 0 && (
                <div class="quick-sdk-empty-row" data-testid="quick-sdk-empty">
                  {t('session.quickSwitch.noModels')}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
