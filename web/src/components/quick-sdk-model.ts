import {
  CLAUDE_CODE_CLI_SDK_AGENT_TYPE,
  isClaudeCodeFamily,
  isCodexFamily,
} from '@shared/agent-types.js';
import { AGY_DEFAULT_MODEL_ID, AGY_SDK_PROVIDER_ID } from '@shared/agy-agent.js';
import { CUSTOM_PROVIDER_SDK_AGENT_TYPES } from '@shared/cc-presets.js';
import {
  CODEBUDDY_CHINA_MODEL_FALLBACK,
  CODEBUDDY_INTERNATIONAL_MODEL_FALLBACK,
  CODEBUDDY_PROVIDER_IDS,
} from '@shared/codebuddy.js';
import { getKnownQwenModelOptions } from '@shared/qwen-models.js';
import {
  AGY_MODEL_IDS,
  CLAUDE_CODE_MODEL_IDS,
  CODEX_MODEL_IDS,
  mergeModelSuggestions,
} from '../../../src/shared/models/options.js';
import {
  buildTransportModelCatalogIdentity,
  getStaticFallbackModels,
  readCachedTransportModels,
  supportsDynamicTransportModels,
  type CachedTransportModelCatalog,
  type TransportModelState,
} from '../hooks/useTransportModels.js';
import type { SessionInfo } from '../types.js';
import {
  getSessionAgentGroups,
  isSessionAgentTypeSelectable,
  type SessionAgentChoice,
  type SessionAgentGroupId,
  type SessionAgentSurface,
} from './session-agent-options.js';

export const QUICK_CURSOR_HEADLESS_MODEL_SUGGESTIONS = ['gpt-5.2'] as const;
export const QUICK_COPILOT_SDK_MODEL_SUGGESTIONS = ['gpt-5.4', 'gpt-5.4-mini'] as const;
export const QUICK_MUSE_SDK_MODEL_SUGGESTIONS = ['muse-spark-1.3', 'muse-spark', 'muse-wonder', 'muse-fast'] as const;
export const QUICK_AGY_SDK_MODEL_SUGGESTIONS = [...AGY_MODEL_IDS] as const;

const NON_SWITCHABLE_AGENT_TYPES = new Set(['shell', 'script', 'openclaw']);

export interface QuickSdkEligibilityInput {
  activeSession: SessionInfo | null | undefined;
  serverId?: string | null;
  activeSessionIncognito: boolean;
  canSharedSessionSend: boolean;
  modelSwitchDisabled: boolean;
}

export function isQuickSdkSwitchAllowed({
  activeSession,
  serverId,
  activeSessionIncognito,
  canSharedSessionSend,
  modelSwitchDisabled,
}: QuickSdkEligibilityInput): boolean {
  if (!activeSession || !serverId?.trim()) return false;
  if (activeSessionIncognito || !canSharedSessionSend || modelSwitchDisabled) return false;
  if (NON_SWITCHABLE_AGENT_TYPES.has(activeSession.agentType)) return false;
  return isSessionAgentTypeSelectable(activeSession.agentType)
    || activeSession.agentType === 'qwen'
    || activeSession.agentType === CLAUDE_CODE_CLI_SDK_AGENT_TYPE;
}

export function supportsQuickModelTrigger(
  agentType: string | undefined | null,
  splitAllowed: boolean,
): boolean {
  if (!agentType || NON_SWITCHABLE_AGENT_TYPES.has(agentType)) return false;
  if (
    agentType === 'claude-code'
    || agentType === 'claude-code-sdk'
    || agentType === 'codex'
    || agentType === 'codex-sdk'
    || agentType === 'qwen'
    || supportsDynamicTransportModels(agentType)
  ) {
    return true;
  }
  return splitAllowed && isSessionAgentTypeSelectable(agentType);
}

/**
 * Mirrors daemon `isPresetCompatibleAgentSwitch`: custom presets carry across
 * same-family transitions (`claude-code` <-> `claude-code-sdk`, `codex` <->
 * `codex-sdk`) when targeting a preset-capable SDK, and clear otherwise.
 */
export function isPresetCompatibleCrossSdkSwitch(
  sourceAgentType: string | undefined | null,
  targetAgentType: string | undefined | null,
): boolean {
  if (!sourceAgentType || !targetAgentType) return false;
  if (!CUSTOM_PROVIDER_SDK_AGENT_TYPES.has(targetAgentType)) return false;
  if (sourceAgentType === targetAgentType) return true;
  if (isClaudeCodeFamily(sourceAgentType) && isClaudeCodeFamily(targetAgentType)) return true;
  if (isCodexFamily(sourceAgentType) && isCodexFamily(targetAgentType)) return true;
  return false;
}

export function resolveEffectiveCrossSdkPreset(
  sourceAgentType: string | undefined | null,
  targetAgentType: string | undefined | null,
  sourceCcPreset: string | undefined | null,
): string | null {
  const trimmed = sourceCcPreset?.trim() ?? '';
  if (!trimmed) return null;
  return isPresetCompatibleCrossSdkSwitch(sourceAgentType, targetAgentType) ? trimmed : null;
}

export interface QuickSdkGroup {
  id: SessionAgentGroupId;
  items: SessionAgentChoice[];
}

/**
 * Cross-SDK switch targets are strictly Transport SDKs (plus the active
 * session's own agent type so current CLI sessions still keep their existing
 * zero-restart same-SDK list while switching out only to Transport SDKs).
 * Non-current CLI process targets cannot accept `requestedModel` via handoff
 * relaunch and must not be offered as destinations.
 */
export function getQuickSwitchableSdkGroups(
  currentAgentType: string | undefined | null,
  surface: SessionAgentSurface = 'new-session',
): QuickSdkGroup[] {
  const groups = getSessionAgentGroups(surface);
  const filtered: QuickSdkGroup[] = groups
    .map((group) => ({
      id: group.id,
      items: group.items.filter((choice) => (
        choice.group === 'transport'
        && !choice.hidden
        && !NON_SWITCHABLE_AGENT_TYPES.has(choice.id)
        && isSessionAgentTypeSelectable(choice.id)
      )),
    }))
    .filter((group) => group.items.length > 0);

  if (currentAgentType && !NON_SWITCHABLE_AGENT_TYPES.has(currentAgentType)) {
    const alreadyPresent = filtered.some((g) => g.items.some((item) => item.id === currentAgentType));
    if (!alreadyPresent) {
      const currentMatch = groups
        .flatMap((g) => g.items)
        .find((item) => item.id === currentAgentType);
      if (currentMatch) {
        const targetGroup = filtered.find((g) => g.id === currentMatch.group);
        if (targetGroup) {
          targetGroup.items = [currentMatch, ...targetGroup.items];
        } else {
          filtered.push({ id: currentMatch.group, items: [currentMatch] });
        }
      }
    }
  }
  return filtered;
}

export function findQuickSdkChoice(
  groups: readonly QuickSdkGroup[],
  sdkId: string,
): SessionAgentChoice | undefined {
  for (const group of groups) {
    const match = group.items.find((item) => item.id === sdkId);
    if (match) return match;
  }
  return undefined;
}

export interface ResolvedCrossSdkModels {
  models: string[];
  defaultModel: string | null;
  loading: boolean;
}

export function resolveCrossSdkModels(options: {
  sdk: string;
  sessionName?: string | null;
  ccPreset?: string | null;
  targetScope?: string | null;
  dynamicState?: Pick<TransportModelState, 'models' | 'defaultModel' | 'loading'> | null;
  cachedCatalog?: CachedTransportModelCatalog | null;
}): ResolvedCrossSdkModels {
  const { sdk, sessionName, ccPreset, targetScope, dynamicState } = options;
  const normalizedPreset = ccPreset?.trim() || null;
  const catalogIdentity = buildTransportModelCatalogIdentity({
    agentType: sdk,
    ccPreset: normalizedPreset,
    sessionName,
    targetScope,
  });
  const cachedCatalog = options.cachedCatalog !== undefined
    ? options.cachedCatalog
    : readCachedTransportModels(catalogIdentity, sdk, targetScope);

  const dynamicIds = (dynamicState?.models ?? []).map((m) => m.id).filter(Boolean);
  const cachedIds = (cachedCatalog?.models ?? []).map((m) => m.id).filter(Boolean);
  const staticFallback = normalizedPreset ? null : getStaticFallbackModels(sdk);

  let staticList: readonly string[] = [];
  if (!normalizedPreset) {
    if (sdk === 'claude-code-sdk' || sdk === CLAUDE_CODE_CLI_SDK_AGENT_TYPE) {
      staticList = CLAUDE_CODE_MODEL_IDS;
    } else if (sdk === 'codex-sdk') {
      staticList = CODEX_MODEL_IDS;
    } else if (sdk === 'qwen') {
      staticList = getKnownQwenModelOptions().map((entry) => entry.id);
    } else if (sdk === AGY_SDK_PROVIDER_ID) {
      staticList = QUICK_AGY_SDK_MODEL_SUGGESTIONS;
    } else if (sdk === 'copilot-sdk') {
      staticList = QUICK_COPILOT_SDK_MODEL_SUGGESTIONS;
    } else if (sdk === 'cursor-headless') {
      staticList = QUICK_CURSOR_HEADLESS_MODEL_SUGGESTIONS;
    } else if (sdk === 'muse-code-sdk') {
      staticList = QUICK_MUSE_SDK_MODEL_SUGGESTIONS;
    } else if (sdk === CODEBUDDY_PROVIDER_IDS.CHINA) {
      staticList = CODEBUDDY_CHINA_MODEL_FALLBACK;
    } else if (sdk === CODEBUDDY_PROVIDER_IDS.INTERNATIONAL) {
      staticList = CODEBUDDY_INTERNATIONAL_MODEL_FALLBACK;
    } else if (staticFallback) {
      staticList = staticFallback.models.map((m) => m.id);
    }
  }

  let models: string[];
  if (sdk === 'muse-code-sdk') {
    models = mergeModelSuggestions(staticList, dynamicIds.length > 0 ? dynamicIds : cachedIds);
  } else if (dynamicIds.length > 0) {
    models = dynamicIds;
  } else if (cachedIds.length > 0) {
    models = cachedIds;
  } else {
    models = [...staticList];
  }

  const resolvedDefault =
    dynamicState?.defaultModel?.trim()
    || (!normalizedPreset ? cachedCatalog?.defaultModel?.trim() : undefined)
    || (normalizedPreset ? cachedCatalog?.defaultModel?.trim() : undefined)
    || (sdk === AGY_SDK_PROVIDER_ID ? AGY_DEFAULT_MODEL_ID : null)
    || staticFallback?.defaultModel?.trim()
    || models[0]
    || null;

  return {
    models,
    defaultModel: resolvedDefault,
    loading: Boolean(dynamicState?.loading),
  };
}
