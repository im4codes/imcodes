/**
 * StartSubSessionDialog — choose type (cc/cc-sdk/codex/codex-sdk/opencode/gemini/qwen/shell/openclaw) and launch a sub-session.
 */
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { WsClient } from '../ws-client.js';
import type { RemoteSession } from '../hooks/useProviderStatus.js';
import { parseString, usePref } from '../hooks/usePref.js';
import { PREF_KEY_DEFAULT_SHELL } from '../constants/prefs.js';
import { CLAUDE_SDK_EFFORT_LEVELS, CODEX_SDK_EFFORT_LEVELS, COPILOT_SDK_EFFORT_LEVELS, MUSE_SDK_EFFORT_LEVELS, OPENCLAW_THINKING_LEVELS, PI_EFFORT_LEVELS, QWEN_EFFORT_LEVELS, clampTransportEffort, formatEffortLevel, type TransportEffortLevel } from '@shared/effort-levels.js';
import { getSessionAgentGroups, getSessionAgentLabel, isSessionAgentTypeSelectable, SESSION_AGENT_GROUP_LABEL_KEYS } from './session-agent-options.js';
import { SdkModeRecommendation } from './SdkModeRecommendation.js';
import { QwenCodingPlanHint } from './QwenCodingPlanHint.js';
import { useTransportModels, supportsDynamicTransportModels } from '../hooks/useTransportModels.js';
import { useCcPresets } from '../hooks/useCcPresets.js';
import { CcPresetEditorPanel } from './CcPresetManager.js';
import { ModelCombobox } from './ModelCombobox.js';
import { usePresetModelSelection } from '../hooks/usePresetModelSelection.js';
import {
  CUSTOM_PROVIDER_SDK_AGENT_TYPES,
  getCcPresetAvailableModelIds,
  getCcPresetEffectiveModel,
  normalizeCcPresetName,
} from '@shared/cc-presets.js';
import {
  AGY_MODEL_IDS,
  CODEX_MODEL_IDS,
  CURSOR_HEADLESS_MODEL_IDS,
  DEFAULT_CLAUDE_CODE_MODEL_ID,
  DEFAULT_OPENCODE_MODEL_ID,
  mergeModelSuggestions,
  resolveCodexAutoDefaultModel,
} from '../../../src/shared/models/options.js';
import { loadAgyModelPreference, saveAgyModelPreference } from '../agy-model-preference.js';
import {
  CODEBUDDY_CHINA_DEFAULT_MODEL,
  CODEBUDDY_CHINA_MODEL_FALLBACK,
  CODEBUDDY_INTERNATIONAL_MODEL_FALLBACK,
  CODEBUDDY_PROVIDER_IDS,
  isCodeBuddyProviderId,
} from '@shared/codebuddy.js';
import { HERMES_AGENT_PROVIDER_ID } from '@shared/hermes-agent.js';
import { AGY_DEFAULT_MODEL_ID, AGY_SDK_PROVIDER_ID } from '@shared/agy-agent.js';
import { CLAUDE_CODE_CLI_SDK_AGENT_TYPE, isShellLikeAgentType } from '@shared/agent-types.js';
import { SESSION_INCOGNITO_CAPABILITY, supportsSessionIncognito } from '@shared/session-incognito-types.js';
import { IncognitoCreateOption } from './IncognitoCreateOption.js';

/** Upper bound on how many identical sub-sessions one launch can request at once. */
const MAX_SUB_SESSION_LAUNCH_COUNT = 20;
const CURSOR_HEADLESS_MODEL_SUGGESTIONS = [...CURSOR_HEADLESS_MODEL_IDS] as const;
const COPILOT_SDK_MODEL_SUGGESTIONS = ['gpt-5.4', 'gpt-5.4-mini'] as const;
const CODEX_SDK_MODEL_SUGGESTIONS = [...CODEX_MODEL_IDS] as const;
const MUSE_SDK_MODEL_SUGGESTIONS = ['muse-spark-1.3', 'muse-spark', 'muse-wonder', 'muse-fast'] as const;
const AGY_SDK_MODEL_SUGGESTIONS = [...AGY_MODEL_IDS] as const;
const responsiveDialogStyle = {
  // Hard-cap against the visual viewport instead of relying on flex padding.
  // iOS can still render a 380px fixed-ish dialog inside a 390px viewport,
  // which clips the custom-provider help text into one-character columns.
  width: 'calc(var(--imcodes-ui-vw, 100vw) - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px) - 32px)',
  maxWidth: 660,
  minWidth: 0,
  boxSizing: 'border-box',
  // Long help/preset labels (e.g. Qwen provider URLs) must wrap inside the
  // narrow viewport instead of forcing the dialog to grow past max-width.
  overflowWrap: 'anywhere',
} as const;

interface Props {
  ws: WsClient | null;
  serverId?: string;
  defaultCwd?: string;
  /** Optional consumer-owned filter. The ordinary launcher remains unchanged. */
  allowedAgentTypes?: readonly string[];
  /** True for shared-session / shared-server participants: hides and blocks shell/script sessions. */
  forbidShellAgentTypes?: boolean;
  /** Lets a caller place the reused launcher above another modal. */
  overlayClassName?: string;
  isProviderConnected: (id: string) => boolean;
  getRemoteSessions: (providerId: string) => RemoteSession[];
  refreshSessions: (providerId: string) => void;
  onStart: (type: string, shellBin?: string, cwd?: string, label?: string, extra?: Record<string, unknown>) => void;
  onClose: () => void;
  onToast?: (message: string) => void;
}

type OpenClawMode = 'new' | 'bind';

export function resolveDefaultSubSessionType(allowedAgentTypes?: readonly string[]): string {
  if (!allowedAgentTypes || allowedAgentTypes.length === 0) {
    return AGY_SDK_PROVIDER_ID;
  }
  const selectableAllowed = allowedAgentTypes.filter(isSessionAgentTypeSelectable);
  if (selectableAllowed.includes(AGY_SDK_PROVIDER_ID)) {
    return AGY_SDK_PROVIDER_ID;
  }
  return selectableAllowed[0] ?? AGY_SDK_PROVIDER_ID;
}

export function StartSubSessionDialog({ ws, serverId, defaultCwd, allowedAgentTypes, forbidShellAgentTypes = false, overlayClassName, isProviderConnected: _isProviderConnected, getRemoteSessions, refreshSessions, onStart, onClose, onToast }: Props) {
  const { t } = useTranslation();
  const initialType = useMemo(() => {
    const resolved = resolveDefaultSubSessionType(allowedAgentTypes);
    return forbidShellAgentTypes && isShellLikeAgentType(resolved) ? AGY_SDK_PROVIDER_ID : resolved;
  }, [allowedAgentTypes, forbidShellAgentTypes]);
  const [type, setType] = useState(initialType);
  const [lastUnlockedType, setLastUnlockedType] = useState(initialType);
  const [customProviderSdk, setCustomProviderSdk] = useState(false);
  const [shells, setShells] = useState<string[]>([]);
  const [shellBin, setShellBin] = useState<string>('/bin/bash');
  const cwd = defaultCwd ?? '';
  const [label, setLabel] = useState('');
  const [countInput, setCountInput] = useState('1');
  const [scriptCmd, setScriptCmd] = useState('');
  const [scriptInterval, setScriptInterval] = useState('5');
  const [detectingShells, setDetectingShells] = useState(false);
  const [thinking, setThinking] = useState<TransportEffortLevel>('high');
  const [requestedModel, setRequestedModel] = useState(() => (
    initialType === AGY_SDK_PROVIDER_ID ? (loadAgyModelPreference() || AGY_DEFAULT_MODEL_ID) : ''
  ));
  const [incognito, setIncognito] = useState(false);
  const canIncognito = !!ws?.getDaemonCapabilitySnapshot?.()?.capabilities.includes(SESSION_INCOGNITO_CAPABILITY) && !ws?.isDaemonCapabilityStale?.();

  // OpenClaw-specific state
  const [ocMode, setOcMode] = useState<OpenClawMode>('new');
  const [ocSessionKey, setOcSessionKey] = useState('');
  const [description, setDescription] = useState('');
  const [ocSelectedSession, setOcSelectedSession] = useState('');

  // CC env presets
  const {
    presets: ccPresets,
    loaded: ccPresetsLoaded,
    loading: ccPresetsLoading,
    refreshing: ccPresetsRefreshing,
    saving: savingPreset,
    discovering: discoveringPreset,
    error: presetError,
    setError: setPresetError,
    savePreset: saveCcPreset,
    deletePreset: deleteCcPreset,
    discoverModels: discoverCcPresetModels,
  } = useCcPresets(ws, { enabled: true });
  const [ccPreset, setCcPreset] = useState<string>('');
  const [ccInitPrompt, setCcInitPrompt] = useState<string>('');
  const [showPresetEditor, setShowPresetEditor] = useState(false);
  const ccPresetRef = useRef(ccPreset);
  ccPresetRef.current = ccPreset;
  const ccPresetEpochRef = useRef(0);
  const requestedModelEpochRef = useRef(0);
  const selectCcPreset = (nextPreset: string) => {
    ccPresetEpochRef.current += 1;
    requestedModelEpochRef.current += 1;
    ccPresetRef.current = nextPreset;
    setCcPreset(nextPreset);
  };
  const suppressEditorAutoSelectRef = useRef(false);
  const handleEditorSavePreset = async (preset: Parameters<typeof saveCcPreset>[0]) => {
    const epochAtStart = ccPresetEpochRef.current;
    const result = await saveCcPreset(preset);
    suppressEditorAutoSelectRef.current = Boolean(result.ok && ccPresetEpochRef.current !== epochAtStart);
    if (suppressEditorAutoSelectRef.current) {
      queueMicrotask(() => { suppressEditorAutoSelectRef.current = false; });
    }
    return result;
  };
  const handleEditorDeletePreset = async (presetName: string) => {
    const epochAtStart = ccPresetEpochRef.current;
    const result = await deleteCcPreset(presetName);
    suppressEditorAutoSelectRef.current = Boolean(
      result.ok
      && (ccPresetEpochRef.current !== epochAtStart
        || (ccPresetRef.current && normalizeCcPresetName(ccPresetRef.current) !== normalizeCcPresetName(presetName))),
    );
    if (suppressEditorAutoSelectRef.current) {
      queueMicrotask(() => { suppressEditorAutoSelectRef.current = false; });
    }
    return result;
  };
  const handleEditorSelectPresetName = (nextName: string) => {
    if (suppressEditorAutoSelectRef.current) {
      suppressEditorAutoSelectRef.current = false;
      return;
    }
    selectCcPreset(nextName);
  };
  const handleDiscoverPresetModels = async (preset: Parameters<typeof discoverCcPresetModels>[0]) => {
    const selectionAtStart = ccPresetRef.current;
    const epochAtStart = ccPresetEpochRef.current;
    const modelEpochAtStart = requestedModelEpochRef.current;
    const result = await discoverCcPresetModels(preset);
    if (!result.ok || !result.preset) return result;
    const currentSelection = ccPresetRef.current;
    if (
      ccPresetEpochRef.current === epochAtStart
      && (currentSelection === result.preset.name || (!currentSelection && selectionAtStart === ''))
    ) {
      const shouldAutoSelectModel = requestedModelEpochRef.current === modelEpochAtStart;
      if (!currentSelection) selectCcPreset(result.preset.name);
      if (shouldAutoSelectModel) {
        const nextModel = getCcPresetEffectiveModel(result.preset)
          ?? getCcPresetAvailableModelIds(result.preset)[0];
        if (nextModel) setRequestedModel(nextModel);
      }
    }
    return result;
  };
  const selectType = (nextType: string) => {
    if (!isSessionAgentTypeSelectable(nextType)) return;
    if (forbidShellAgentTypes && isShellLikeAgentType(nextType)) return;
    if (customProviderSdk && !CUSTOM_PROVIDER_SDK_AGENT_TYPES.has(nextType)) return;
    if (incognito && !supportsSessionIncognito(nextType)) return;
    if (nextType !== type) {
      if (nextType === AGY_SDK_PROVIDER_ID) {
        setRequestedModel(loadAgyModelPreference() || AGY_DEFAULT_MODEL_ID);
      } else {
        setRequestedModel('');
      }
    }
    setType(nextType);
    if (!customProviderSdk) setLastUnlockedType(nextType);
    setPresetError('');
  };
  const toggleCustomProviderSdk = (enabled: boolean) => {
    setCustomProviderSdk(enabled);
    setPresetError('');
    if (enabled) {
      if (!ccPreset && ccPresets.length > 0) selectCcPreset(ccPresets[0].name);
      if (!CUSTOM_PROVIDER_SDK_AGENT_TYPES.has(type)) {
        setLastUnlockedType(type);
        setRequestedModel('');
        setType('claude-code-sdk');
      }
      return;
    }
    if (lastUnlockedType !== type) {
      if (lastUnlockedType === AGY_SDK_PROVIDER_ID) {
        setRequestedModel(loadAgyModelPreference() || AGY_DEFAULT_MODEL_ID);
      } else {
        setRequestedModel('');
      }
    }
    setType(lastUnlockedType);
  };
  const selectedCcPreset = useMemo(
    () => (CUSTOM_PROVIDER_SDK_AGENT_TYPES.has(type) ? ccPresets.find((preset) => preset.name === ccPreset) : undefined),
    [type, ccPreset, ccPresets],
  );
  const selectedPresetModels = useMemo(
    () => selectedCcPreset ? getCcPresetAvailableModelIds(selectedCcPreset) : [],
    [selectedCcPreset],
  );

  // Remote sessions come from the provider status hook (pushed on connect, cached in DB)
  const ocRemoteSessions = getRemoteSessions('openclaw');

  const agentGroups = getSessionAgentGroups('sub-session');
  const allowedAgentTypeSet = useMemo(
    () => allowedAgentTypes ? new Set(allowedAgentTypes.filter(isSessionAgentTypeSelectable)) : null,
    [allowedAgentTypes],
  );

  useEffect(() => {
    if (!allowedAgentTypeSet || allowedAgentTypeSet.has(type)) return;
    const fallback = allowedAgentTypeSet.has(AGY_SDK_PROVIDER_ID)
      ? AGY_SDK_PROVIDER_ID
      : allowedAgentTypeSet.values().next().value;
    if (fallback) {
      setType(fallback);
      setLastUnlockedType(fallback);
      if (fallback === AGY_SDK_PROVIDER_ID) {
        setRequestedModel(loadAgyModelPreference() || AGY_DEFAULT_MODEL_ID);
      } else {
        setRequestedModel('');
      }
    }
  }, [allowedAgentTypeSet, allowedAgentTypes, type]);

  // Load saved shell preference from server
  const defaultShellPref = usePref<string>(PREF_KEY_DEFAULT_SHELL, { parse: parseString });
  useEffect(() => {
    if (defaultShellPref.value) setShellBin(defaultShellPref.value);
  }, [defaultShellPref.value]);

  // Request shell detection from daemon
  useEffect(() => {
    if (!ws) return;

    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'subsession.shells') {
        setShells(msg.shells);
        setDetectingShells(false);
        setShellBin((prev) => (msg.shells.includes(prev) ? prev : (msg.shells[0] ?? prev)));
      }
    });

    setDetectingShells(true);
    ws.subSessionDetectShells();
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  // Auto-generate a session key when switching to openclaw new mode
  useEffect(() => {
    if (type === 'openclaw' && ocMode === 'new' && !ocSessionKey) {
      setOcSessionKey(`oc-${Math.random().toString(36).slice(2, 10)}`);
    }
  }, [type, ocMode, ocSessionKey]);

  useEffect(() => {
    setThinking('high');
  }, [type]);

  useEffect(() => {
    if (!customProviderSdk) return;
    if (!CUSTOM_PROVIDER_SDK_AGENT_TYPES.has(type)) setType('claude-code-sdk');
    if (!ccPreset && ccPresets.length > 0) setCcPreset(ccPresets[0].name);
  }, [ccPreset, ccPresets, customProviderSdk, type]);

  // A bind-mode OpenClaw launch connects to one specific EXISTING external
  // session, so repeating it does not mean "N sessions" -- it always launches
  // exactly one, regardless of the quantity field.
  const canLaunchMultiple = !(type === 'openclaw' && ocMode === 'bind');
  const launchCount = canLaunchMultiple
    ? Math.min(MAX_SUB_SESSION_LAUNCH_COUNT, Math.max(1, parseInt(countInput, 10) || 1))
    : 1;

  const canStartType = isSessionAgentTypeSelectable(type)
    && !(forbidShellAgentTypes && isShellLikeAgentType(type))
    && (!allowedAgentTypeSet || allowedAgentTypeSet.has(type));
  const incognitoBlocked = incognito && (!canIncognito || !supportsSessionIncognito(type));
  const handleStart = () => {
    if (!canStartType || incognitoBlocked) return;
    const desc = description.trim() || undefined;
    if (customProviderSdk && !ccPreset) {
      setPresetError(t('new_session.custom_provider_preset_required'));
      setShowPresetEditor(true);
      return;
    }
    if (type === 'script') {
      if (!scriptCmd.trim()) return;
      const interval = Math.max(1, parseInt(scriptInterval, 10) || 5);
      const escaped = scriptCmd.trim().replace(/'/g, "'\\''");
      const wrapper = `bash -c 'while true; do clear; ${escaped}; sleep ${interval}; done'`;
      onStart('script', wrapper, cwd || undefined, label || scriptCmd.trim().slice(0, 30), {
        ...(desc ? { description: desc } : {}),
        ...(launchCount > 1 ? { launchCount } : {}),
      });
      return;
    }
    if (type === 'openclaw') {
      const extra =
        ocMode === 'bind'
          ? { ocMode: 'bind', ocSessionId: ocSelectedSession, description: desc, thinking }
          : {
            ocMode: 'new', ocSessionKey: ocSessionKey.trim(), description: desc, thinking,
            ...(launchCount > 1 ? { launchCount } : {}),
          };
      onStart('openclaw', undefined, cwd || undefined, label || undefined, extra);
      return;
    }
    const selectedShell = type === 'shell' ? (shellBin || undefined) : undefined;
    if (type === 'shell' && selectedShell) {
      void defaultShellPref.save(selectedShell).catch(() => {});
    }
    const extra: Record<string, unknown> = {};
    if (desc) extra.description = desc;
    if (ccPreset && (type === 'claude-code' || CUSTOM_PROVIDER_SDK_AGENT_TYPES.has(type))) extra.ccPreset = ccPreset;
    if (ccInitPrompt.trim() && type === 'claude-code') extra.ccInitPrompt = ccInitPrompt.trim();
    if ((type === 'claude-code-sdk' || type === CLAUDE_CODE_CLI_SDK_AGENT_TYPE || type === 'codex-sdk' || type === 'copilot-sdk' || type === 'cursor-headless' || type === 'opencode-sdk' || type === 'grok-sdk' || type === 'kimi-sdk' || type === 'muse-code-sdk' || type === HERMES_AGENT_PROVIDER_ID || type === AGY_SDK_PROVIDER_ID || type === 'deepseek-harness' || type === 'pi' || isCodeBuddyProviderId(type) || type === 'qwen') && requestedModel.trim()) {
      extra.requestedModel = requestedModel.trim();
      if (type === AGY_SDK_PROVIDER_ID) {
        saveAgyModelPreference(requestedModel.trim());
      }
    }
    if (type === 'claude-code-sdk' || type === CLAUDE_CODE_CLI_SDK_AGENT_TYPE || type === 'codex-sdk' || type === 'copilot-sdk' || type === 'muse-code-sdk' || type === 'pi' || type === 'qwen') extra.thinking = thinking;
    if (incognito) extra.incognito = true;
    if (launchCount > 1) extra.launchCount = launchCount;
    onStart(type, selectedShell, cwd || undefined, label || undefined, Object.keys(extra).length > 0 ? extra : undefined);
  };

  const dynamicModelsAgentType = supportsDynamicTransportModels(type) ? type : null;
  const creationTargetScope = serverId?.trim()
    || (ws as { getServerId?: () => string } | null)?.getServerId?.()?.trim()
    || ws?.getDaemonCapabilitySnapshot?.()?.daemonId?.trim()
    || undefined;
  const transportModels = useTransportModels(
    ws,
    dynamicModelsAgentType,
    CUSTOM_PROVIDER_SDK_AGENT_TYPES.has(type) ? ccPreset : undefined,
    undefined,
    creationTargetScope,
  );
  const selectedDynamicModel = transportModels.models.find((model) => model.id === requestedModel);
  const thinkingLevels = (type === 'claude-code-sdk' || type === CLAUDE_CODE_CLI_SDK_AGENT_TYPE)
    ? CLAUDE_SDK_EFFORT_LEVELS
    : type === 'codex-sdk'
      ? (selectedDynamicModel?.supportedEffortLevels ?? CODEX_SDK_EFFORT_LEVELS)
      : type === 'copilot-sdk'
        ? COPILOT_SDK_EFFORT_LEVELS
        : type === 'muse-code-sdk'
          ? (selectedDynamicModel?.supportedEffortLevels ?? MUSE_SDK_EFFORT_LEVELS)
          : type === 'qwen'
            ? QWEN_EFFORT_LEVELS
            : type === 'pi'
              ? PI_EFFORT_LEVELS
            : type === 'openclaw'
              ? OPENCLAW_THINKING_LEVELS
              : [];
  const supportsCcPreset = type === 'claude-code' || CUSTOM_PROVIDER_SDK_AGENT_TYPES.has(type);
  const showCcPresetControls = customProviderSdk || supportsCcPreset;
  const providerPresetLabel = customProviderSdk
    ? t('new_session.custom_provider_preset')
    : type === 'qwen'
      ? t('new_session.compatible_api_via_qwen')
      : t('new_session.api_provider');
  useEffect(() => {
    if ((type !== 'codex-sdk' && type !== 'muse-code-sdk') || !selectedDynamicModel?.supportedEffortLevels?.length) return;
    const clamped = clampTransportEffort(thinking, selectedDynamicModel.supportedEffortLevels);
    if (clamped && clamped !== thinking) setThinking(clamped);
  }, [selectedDynamicModel?.id, selectedDynamicModel?.supportedEffortLevels, thinking, type]);
  const supportsModelSelection = type === 'claude-code-sdk' || type === CLAUDE_CODE_CLI_SDK_AGENT_TYPE || type === 'codex-sdk' || type === 'copilot-sdk' || type === 'cursor-headless' || type === 'opencode-sdk' || type === 'grok-sdk' || type === 'kimi-sdk' || type === 'muse-code-sdk' || type === HERMES_AGENT_PROVIDER_ID || type === AGY_SDK_PROVIDER_ID || type === 'deepseek-harness' || type === 'pi' || isCodeBuddyProviderId(type) || (type === 'qwen' && !!selectedCcPreset);
  const modelSuggestions = useMemo(() => (
    CUSTOM_PROVIDER_SDK_AGENT_TYPES.has(type) && selectedCcPreset
      ? mergeModelSuggestions(
          selectedPresetModels,
          transportModels.models.map((model) => model.id),
        )
    : transportModels.models.length > 0
      ? (type === 'codex-sdk'
          ? transportModels.models.map((model) => model.id)
        : type === 'muse-code-sdk'
          ? mergeModelSuggestions(MUSE_SDK_MODEL_SUGGESTIONS, transportModels.models.map((model) => model.id))
        : type === AGY_SDK_PROVIDER_ID
          ? transportModels.models.map((model) => model.id)
        : type === CODEBUDDY_PROVIDER_IDS.CHINA
          ? mergeModelSuggestions(CODEBUDDY_CHINA_MODEL_FALLBACK, transportModels.models.map((model) => model.id))
        : type === CODEBUDDY_PROVIDER_IDS.INTERNATIONAL
          ? mergeModelSuggestions(CODEBUDDY_INTERNATIONAL_MODEL_FALLBACK, transportModels.models.map((model) => model.id))
        : transportModels.models.map((model) => model.id))
      : type === 'codex-sdk'
        ? [...CODEX_SDK_MODEL_SUGGESTIONS]
      : type === 'copilot-sdk'
        ? [...COPILOT_SDK_MODEL_SUGGESTIONS]
        : type === 'cursor-headless'
          ? [...CURSOR_HEADLESS_MODEL_SUGGESTIONS]
        : type === 'muse-code-sdk'
          ? [...MUSE_SDK_MODEL_SUGGESTIONS]
        : type === AGY_SDK_PROVIDER_ID
          ? [...AGY_SDK_MODEL_SUGGESTIONS]
        : type === 'qwen'
            ? selectedPresetModels
            : type === CODEBUDDY_PROVIDER_IDS.CHINA
                ? [...CODEBUDDY_CHINA_MODEL_FALLBACK]
                : type === CODEBUDDY_PROVIDER_IDS.INTERNATIONAL
                  ? [...CODEBUDDY_INTERNATIONAL_MODEL_FALLBACK]
              : []
  ), [transportModels.models, type, selectedPresetModels, selectedCcPreset]);

  usePresetModelSelection({
    agentType: type,
    preset: selectedCcPreset,
    suggestions: modelSuggestions,
    setRequestedModel,
  });

  const codexModelManuallySelectedRef = useRef(false);
  const claudeCodeModelManuallySelectedRef = useRef(false);
  const openCodeModelManuallySelectedRef = useRef(false);
  const lastTargetRef = useRef<string | WsClient | null>(serverId?.trim() || ws || null);
  useEffect(() => {
    const nextTarget = serverId?.trim() || ws || null;
    if (lastTargetRef.current && nextTarget && lastTargetRef.current !== nextTarget) {
      codexModelManuallySelectedRef.current = false;
      claudeCodeModelManuallySelectedRef.current = false;
      openCodeModelManuallySelectedRef.current = false;
      if (
        (type === 'codex-sdk' ||
          type === 'claude-code-sdk' ||
          type === CLAUDE_CODE_CLI_SDK_AGENT_TYPE ||
          type === 'opencode-sdk') &&
        !selectedCcPreset
      ) {
        setRequestedModel('');
      }
    }
    lastTargetRef.current = nextTarget;
  }, [serverId, selectedCcPreset, type, ws]);

  useEffect(() => {
    if (type !== 'codex-sdk' || selectedCcPreset) {
      codexModelManuallySelectedRef.current = false;
      return;
    }
    setRequestedModel((current) => {
      const trimmed = current.trim();
      if (codexModelManuallySelectedRef.current && trimmed) return trimmed;
      return resolveCodexAutoDefaultModel(modelSuggestions, transportModels.defaultModel) ?? '';
    });
  }, [type, selectedCcPreset, modelSuggestions, transportModels.defaultModel, serverId]);

  useEffect(() => {
    const isClaudeCode = type === 'claude-code-sdk' || type === CLAUDE_CODE_CLI_SDK_AGENT_TYPE;
    if (!isClaudeCode || selectedCcPreset) {
      claudeCodeModelManuallySelectedRef.current = false;
      return;
    }
    setRequestedModel((current) => {
      const trimmed = current.trim();
      if (claudeCodeModelManuallySelectedRef.current && trimmed) return trimmed;
      if (modelSuggestions.length === 0 || modelSuggestions.includes(DEFAULT_CLAUDE_CODE_MODEL_ID)) {
        return DEFAULT_CLAUDE_CODE_MODEL_ID;
      }
      return transportModels.defaultModel ?? modelSuggestions[0] ?? DEFAULT_CLAUDE_CODE_MODEL_ID;
    });
  }, [type, selectedCcPreset, modelSuggestions, transportModels.defaultModel, serverId]);

  useEffect(() => {
    if (type !== 'opencode-sdk' || selectedCcPreset) {
      openCodeModelManuallySelectedRef.current = false;
      return;
    }
    setRequestedModel((current) => {
      const trimmed = current.trim();
      if (openCodeModelManuallySelectedRef.current && trimmed) return trimmed;
      if (modelSuggestions.length === 0 || modelSuggestions.includes(DEFAULT_OPENCODE_MODEL_ID)) {
        return DEFAULT_OPENCODE_MODEL_ID;
      }
      return transportModels.defaultModel ?? modelSuggestions[0] ?? DEFAULT_OPENCODE_MODEL_ID;
    });
  }, [type, selectedCcPreset, modelSuggestions, transportModels.defaultModel, serverId]);

  useEffect(() => {
    if (!isCodeBuddyProviderId(type)) return;
    setRequestedModel((current) => {
      const preferred = type === CODEBUDDY_PROVIDER_IDS.CHINA
        ? CODEBUDDY_CHINA_DEFAULT_MODEL
        : transportModels.defaultModel ?? CODEBUDDY_INTERNATIONAL_MODEL_FALLBACK[0];
      const trimmed = current.trim();
      if (trimmed && modelSuggestions.includes(trimmed)) return trimmed;
      if (modelSuggestions.includes(preferred)) return preferred;
      return modelSuggestions[0] ?? preferred;
    });
  }, [type, modelSuggestions, transportModels.defaultModel]);

  useEffect(() => {
    if (type !== 'muse-code-sdk') return;
    setRequestedModel((current) => {
      const trimmed = current.trim();
      if (trimmed && (modelSuggestions.length === 0 || modelSuggestions.includes(trimmed))) return trimmed;
      const fallback = transportModels.defaultModel ?? MUSE_SDK_MODEL_SUGGESTIONS[0];
      if (modelSuggestions.length === 0 || modelSuggestions.includes(fallback)) return fallback;
      return modelSuggestions[0] ?? fallback;
    });
  }, [type, modelSuggestions, transportModels.defaultModel]);

  const agyModelManuallySelectedRef = useRef(false);
  useEffect(() => {
    if (type !== AGY_SDK_PROVIDER_ID) {
      agyModelManuallySelectedRef.current = false;
      return;
    }
    setRequestedModel((current) => {
      const trimmed = current.trim();
      const stored = loadAgyModelPreference();
      if (agyModelManuallySelectedRef.current && trimmed && (modelSuggestions.length === 0 || modelSuggestions.includes(trimmed))) {
        return trimmed;
      }
      if (stored && (modelSuggestions.length === 0 || modelSuggestions.includes(stored))) {
        return stored;
      }
      const fallback = transportModels.defaultModel ?? AGY_DEFAULT_MODEL_ID;
      if (modelSuggestions.length === 0 || modelSuggestions.includes(fallback)) return fallback;
      return modelSuggestions[0] ?? fallback;
    });
  }, [type, modelSuggestions, transportModels.defaultModel]);

  return (
    <div class={`dialog-overlay${overlayClassName ? ` ${overlayClassName}` : ''}`}>
      <div class="dialog session-launch-dialog" style={responsiveDialogStyle}>
        <div class="dialog-header">
          <span>{t('subsessionBar.new_sub_session')}</span>
          <button class="dialog-close" onClick={onClose}>×</button>
        </div>

        <div class="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Type selection */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('session.type')}</div>
            <div class="session-agent-groups">
              {agentGroups.map((group) => {
                const allowedItems = allowedAgentTypeSet
                  ? group.items.filter((choice) => allowedAgentTypeSet.has(choice.id))
                  : group.items;
                const visibleItems = customProviderSdk
                  ? allowedItems.filter((choice) => CUSTOM_PROVIDER_SDK_AGENT_TYPES.has(choice.id))
                  : allowedItems;
                if (visibleItems.length === 0) return null;
                return (
                  <div key={group.id} class="session-agent-group">
                    <div class="session-agent-group-title">{t(SESSION_AGENT_GROUP_LABEL_KEYS[group.id])}</div>
                    <div class="session-agent-grid">
                      {visibleItems.map((choice) => {
                        const shellBlocked = forbidShellAgentTypes && isShellLikeAgentType(choice.id);
                        return (
                        <button
                          key={choice.id}
                          type="button"
                          class={`session-agent-card${type === choice.id ? ' active' : ''}`}
                          data-agent-type={choice.id}
                          // Hidden choices (e.g. qwen, or shell/script for shared participants) stay real DOM nodes --
                          // just invisible and out of the tab/accessibility
                          // order -- rather than being omitted from
                          // visibleItems, so the underlying data/behavior
                          // stays fully intact for any test still querying
                          // it directly. A hidden choice that was explicitly
                          // allow-listed via allowedAgentTypes (e.g. the
                          // supervision-pool worker-type picker, which still
                          // legitimately offers qwen as a backend) is a
                          // deliberate exception and renders normally. Unavailable Claude CLI SDK
                          // is never restored by an allow-list.
                          style={(shellBlocked || (choice.hidden && (!isSessionAgentTypeSelectable(choice.id) || !allowedAgentTypeSet?.has(choice.id)))) ? { display: 'none' } : undefined}
                          disabled={shellBlocked || !isSessionAgentTypeSelectable(choice.id) || (incognito && !supportsSessionIncognito(choice.id)) || (customProviderSdk && !CUSTOM_PROVIDER_SDK_AGENT_TYPES.has(choice.id))}
                          aria-pressed={type === choice.id}
                          onClick={() => selectType(choice.id)}
                        >
                          <span class="session-agent-card-icon" aria-hidden="true">{choice.icon}</span>
                          <span>{getSessionAgentLabel(t, choice)}</span>
                        </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <SdkModeRecommendation agentType={type} />
            <div style={{ marginTop: 10 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                }}
              >
                {/*
                 * Mirror NewSessionDialog: width:auto + margin:0 defend
                 * against any global `input { width: 100% }` rule (this
                 * dialog doesn't currently use .form-group but the
                 * regression must stay symmetric). flex:1 1 auto + minWidth:0
                 * on the span lets the label text wrap normally inside the
                 * dialog instead of overflowing.
                 */}
                <input
                  type="checkbox"
                  checked={customProviderSdk}
                  onChange={(e) => toggleCustomProviderSdk((e.target as HTMLInputElement).checked)}
                  style={{ flex: '0 0 auto', width: 'auto', margin: 0 }}
                />
                <span
                  style={{
                    color: '#e2e8f0',
                    fontSize: 13,
                    overflowWrap: 'break-word',
                    minWidth: 0,
                    flex: '1 1 auto',
                  }}
                >
                  {t('new_session.custom_provider_sdk')}
                </span>
              </label>
              <div
                style={{
                  marginLeft: 24,
                  marginTop: 4,
                  color: '#94a3b8',
                  fontSize: 12,
                  lineHeight: 1.35,
                }}
              >
                {t('new_session.custom_provider_sdk_help')}
              </div>
            </div>
            <QwenCodingPlanHint selected={customProviderSdk || type === 'qwen'} />
          </div>

          {/* Script command (only for script type) */}
          {type === 'script' && (
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Command</div>
              <input
                class="input"
                placeholder="e.g. df -h, kubectl get pods, htop -t"
                value={scriptCmd}
                onInput={(e) => setScriptCmd((e.target as HTMLInputElement).value)}
                style={{ width: '100%' }}
                autoFocus
              />
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 12, marginBottom: 8 }}>Interval (seconds)</div>
              <input
                class="input"
                type="number"
                min="1"
                value={scriptInterval}
                onInput={(e) => setScriptInterval((e.target as HTMLInputElement).value)}
                style={{ width: 80 }}
              />
            </div>
          )}

          {/* Shell binary picker (only for shell type) */}
          {type === 'shell' && (
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Shell</div>
              {detectingShells ? (
                <div style={{ fontSize: 12, color: '#64748b' }}>Detecting shells...</div>
              ) : shells.length > 0 ? (
                <select
                  class="input"
                  value={shellBin}
                  onInput={(e) => setShellBin((e.target as HTMLSelectElement).value)}
                  style={{ width: '100%' }}
                >
                  {shells.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : (
                <input
                  class="input"
                  placeholder="/bin/bash"
                  value={shellBin}
                  onInput={(e) => setShellBin((e.target as HTMLInputElement).value)}
                  style={{ width: '100%' }}
                />
              )}
            </div>
          )}

          {/* OpenClaw-specific options — always show, even if provider not yet connected */}
          {type === 'openclaw' && (
            <>
              <div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('session.sessionMode')}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <button
                    class={`subsession-type-btn${ocMode === 'new' ? ' active' : ''}`}
                    onClick={() => setOcMode('new')}
                  >
                    {t('session.newSession')}
                  </button>
                  <button
                    class={`subsession-type-btn${ocMode === 'bind' ? ' active' : ''}`}
                    onClick={() => setOcMode('bind')}
                  >
                    {t('session.bindExisting')}
                  </button>
                </div>
              </div>

              {ocMode === 'bind' ? (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: '#94a3b8' }}>{t('session.selectSession')}</div>
                    <button
                      type="button"
                      class="btn btn-secondary"
                      onClick={() => refreshSessions('openclaw')}
                      style={{ fontSize: 10, padding: '2px 8px', lineHeight: 1.4 }}
                      title={t('common.refresh')}
                    >
                      {t('common.refresh')}
                    </button>
                  </div>
                  {ocRemoteSessions.length === 0 ? (
                    <div style={{ fontSize: 12, color: '#64748b' }}>{t('session.noSessions')}</div>
                  ) : (
                    <select
                      class="input"
                      value={ocSelectedSession}
                      onInput={(e) => setOcSelectedSession((e.target as HTMLSelectElement).value)}
                      style={{ width: '100%' }}
                    >
                      <option value="">{t('session.selectSession')}</option>
                      {ocRemoteSessions.map((s) => (
                        <option key={s.key} value={s.key}>{s.displayName || s.key}</option>
                      ))}
                    </select>
                  )}
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('session.sessionKey')}</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      class="input"
                      type="text"
                      value={ocSessionKey}
                      onInput={(e) => setOcSessionKey((e.target as HTMLInputElement).value)}
                      autoComplete="off"
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      class="btn btn-secondary"
                      onClick={() => setOcSessionKey(`oc-${Math.random().toString(36).slice(2, 10)}`)}
                      style={{ whiteSpace: 'nowrap', fontSize: 12 }}
                    >
                      {t('session.autoGenerate')}
                    </button>
                  </div>
                </div>
              )}

            </>
          )}

          {/* CC env preset selector + editor */}
          {showCcPresetControls && (
            <>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>{providerPresetLabel}</span>
                  <button type="button" style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: 11, padding: 0 }} onClick={() => setShowPresetEditor(!showPresetEditor)}>
                    {showPresetEditor ? `▾ ${t('common.close')}` : t('new_session.api_provider_add_edit')}
                  </button>
                </div>
	                {ccPresets.length > 0 ? (
	                  <select class="input" value={ccPreset} onInput={(e) => selectCcPreset((e.target as HTMLSelectElement).value)} style={{ width: '100%' }}>
	                    <option value="">{t('new_session.api_provider_default')}</option>
	                    {ccPresets.map((p) => <option key={p.name} value={p.name}>{p.name}{getCcPresetEffectiveModel(p) ? ` (${getCcPresetEffectiveModel(p)})` : ''}</option>)}
	                  </select>
                ) : !showPresetEditor && (
                  <div style={{ fontSize: 11, color: '#475569' }}>{t('new_session.api_provider_default')}</div>
                )}
              </div>

              {showPresetEditor && (
                <CcPresetEditorPanel
                  ws={ws}
                  presets={ccPresets}
                  loaded={ccPresetsLoaded}
                  loading={ccPresetsLoading}
                  refreshing={ccPresetsRefreshing}
                  saving={savingPreset}
                  discovering={discoveringPreset}
                  error={presetError}
                  onClearError={() => setPresetError('')}
                  onError={setPresetError}
                  onSavePreset={handleEditorSavePreset}
                  onDeletePreset={handleEditorDeletePreset}
                  onDiscoverModels={handleDiscoverPresetModels}
                  selectedPresetName={ccPreset}
                  onSelectPresetName={handleEditorSelectPresetName}
                  onToast={onToast}
                  radioName="subsession-preset-auth-type"
                  compact
                />
              )}

              {ccPreset && (
                <div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Extra init prompt</div>
                  <textarea class="input" placeholder="Additional instruction..." value={ccInitPrompt} rows={2} onInput={(e) => setCcInitPrompt((e.target as HTMLTextAreaElement).value)} style={{ width: '100%', resize: 'vertical' }} />
                </div>
              )}
            </>
          )}

          {/* Working directory */}
          {thinkingLevels.length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('session.thinking')}</div>
              <select
                class="input"
                value={thinking}
                onInput={(e) => setThinking((e.target as HTMLSelectElement).value as TransportEffortLevel)}
                style={{ width: '100%' }}
              >
                {thinkingLevels.map((level) => (
                  <option key={level} value={level}>{formatEffortLevel(level)}{level === 'ultra' ? ` — ${t('session.thinking_ultra_hint')}` : ''}</option>
                ))}
              </select>
            </div>
          )}

          {supportsModelSelection && (
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('session.supervision.model')}</div>
              {((type === 'qwen' || type === 'claude-code-sdk' || type === CLAUDE_CODE_CLI_SDK_AGENT_TYPE) || (Boolean(selectedCcPreset) && CUSTOM_PROVIDER_SDK_AGENT_TYPES.has(type))) && modelSuggestions.length > 0 ? (
                <select
                  class="input"
                  value={requestedModel}
                  onInput={(e) => {
                    const val = (e.target as HTMLSelectElement).value;
                    if (type === AGY_SDK_PROVIDER_ID) agyModelManuallySelectedRef.current = true;
                    if (type === 'codex-sdk' && !selectedCcPreset) {
                      codexModelManuallySelectedRef.current = val.trim().length > 0;
                    }
                    if ((type === 'claude-code-sdk' || type === CLAUDE_CODE_CLI_SDK_AGENT_TYPE) && !selectedCcPreset) {
                      claudeCodeModelManuallySelectedRef.current = val.trim().length > 0;
                    }
                    if (type === 'opencode-sdk' && !selectedCcPreset) {
                      openCodeModelManuallySelectedRef.current = val.trim().length > 0;
                    }
                    requestedModelEpochRef.current += 1;
                    setRequestedModel(val);
                  }}
                  style={{ width: '100%' }}
                >
                  {requestedModel.trim() && !modelSuggestions.includes(requestedModel.trim()) && (
                    <option value={requestedModel.trim()}>{requestedModel.trim()}</option>
                  )}
                  {modelSuggestions.map((model) => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              ) : (
                <ModelCombobox
                  className="input"
                  id={`sub-session-model-${type}`}
                  options={modelSuggestions}
                  placeholder={t('session.supervision.selectModel')}
                  value={requestedModel}
                  onChange={(val) => {
                    if (type === AGY_SDK_PROVIDER_ID) agyModelManuallySelectedRef.current = true;
                    if (type === 'codex-sdk' && !selectedCcPreset) {
                      codexModelManuallySelectedRef.current = val.trim().length > 0;
                    }
                    if ((type === 'claude-code-sdk' || type === CLAUDE_CODE_CLI_SDK_AGENT_TYPE) && !selectedCcPreset) {
                      claudeCodeModelManuallySelectedRef.current = val.trim().length > 0;
                    }
                    if (type === 'opencode-sdk' && !selectedCcPreset) {
                      openCodeModelManuallySelectedRef.current = val.trim().length > 0;
                    }
                    requestedModelEpochRef.current += 1;
                    setRequestedModel(val);
                  }}
                  style={{ width: '100%' }}
                />
              )}
              {type === 'grok-sdk' && transportModels.error && (
                <div role="alert" style={{ marginTop: 6, color: '#fca5a5', fontSize: 12 }}>
                  {t('new_session.grok_prerequisite_error', { error: transportModels.error })}
                </div>
              )}
              {type === HERMES_AGENT_PROVIDER_ID && transportModels.error && (
                <div role="alert" style={{ marginTop: 6, color: '#fca5a5', fontSize: 12 }}>
                  {t('new_session.hermes_prerequisite_error', { error: transportModels.error })}
                </div>
              )}
              {type === AGY_SDK_PROVIDER_ID && transportModels.error && (
                <div role="alert" style={{ marginTop: 6, color: '#fca5a5', fontSize: 12 }}>
                  {t('new_session.agy_prerequisite_error', { error: transportModels.error })}
                </div>
              )}
            </div>
          )}

          {/* Working directory */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('session.subsessionWorkingDirectory')}</div>
            <div class="input-with-browse">
              <input
                class="input"
                placeholder={t('session.subsessionWorkingDirectoryPlaceholder')}
                value={cwd}
                disabled
                readOnly
                aria-disabled="true"
              />
            </div>
            <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 4, lineHeight: 1.4 }}>
              {t('session.subsessionWorkingDirectoryLocked')}
            </div>
          </div>

          {/* Label */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Label (optional)</div>
            <input
              class="input"
              placeholder="e.g. backend"
              value={label}
              onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
              style={{ width: '100%' }}
            />
          </div>

          {/* Quantity: launch several identical sub-sessions at once */}
          {canLaunchMultiple && (
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('new_session.launch_count')}</div>
              <input
                class="input"
                type="number"
                min={1}
                max={MAX_SUB_SESSION_LAUNCH_COUNT}
                value={countInput}
                onInput={(e) => setCountInput((e.target as HTMLInputElement).value)}
                style={{ width: 120 }}
                aria-label={t('new_session.launch_count')}
              />
              {launchCount > 1 && (
                <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 4, lineHeight: 1.4 }}>
                  {t('new_session.launch_count_hint', { count: launchCount })}
                </div>
              )}
            </div>
          )}

          {/* Description / persona */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{t('session.description')}</div>
            <textarea
              class="input"
              placeholder={t('session.descriptionPlaceholder')}
              value={description}
              onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
              rows={2}
              style={{ width: '100%', resize: 'vertical' }}
            />
          </div>
        </div>

        <IncognitoCreateOption
          incognito={incognito}
          canIncognito={canIncognito}
          agentType={type}
          onChange={setIncognito}
        />

        <div class="dialog-footer">
          <button class="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button class={`btn btn-primary${incognito ? ' incognito-launch-btn' : ''}`} onClick={handleStart} disabled={!canStartType || incognitoBlocked}>Launch</button>
        </div>
      </div>
    </div>
  );
}
