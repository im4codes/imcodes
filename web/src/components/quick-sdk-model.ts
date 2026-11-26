import { CLAUDE_CODE_CLI_SDK_AGENT_TYPE } from '@shared/agent-types.js';
import { AGY_DEFAULT_MODEL_ID, AGY_SDK_PROVIDER_ID } from '@shared/agy-agent.js';
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
  return isSessionAgentTypeSelectable(activeSession.agentType) || activeSession.agentType === 'qwen' || activeSession.agentType === CLAUDE_CODE_CLI_SDK_AGENT_TYPE;
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

export interface QuickSdkGroup {
  id: SessionAgentGroupId;
  items: SessionAgentChoice[];
}

export function getQuickSwitchableSdkGroups(
  currentAgentType: string | undefined | null,
  surface: SessionAgentSurface = 'new-session',
): QuickSdkGroup[] {
  const groups = getSessionAgentGroups(surface);
  const filtered: QuickSdkGroup[] = groups
    .map((group) => ({
      id: group.id,
      items: group.items.filter((choice) => (
        !choice.hidden
        && !NON_SWITCHABLE_AGENT_TYPES.has(choice.id)
        && isSessionAgentTypeSelectable(choice.id)
      )),
    }))
    .filter((group) => group.items.length > 0);

  if (currentAgentType && !NON_SWITCHABLE_AGENT_TYPES.has(currentAgentType)) {
    const alreadyPresent = filtered.some((g) => g.items.some((item) => item.id === currentAgentType));
    if (!alreadyPresent) {
      const hiddenMatch = groups
        .flatMap((g) => g.items)
        .find((item) => item.id === currentAgentType);
      if (hiddenMatch) {
        const targetGroup = filtered.find((g) => g.id === hiddenMatch.group);
        if (targetGroup) {
          targetGroup.items = [hiddenMatch, ...targetGroup.items];
        } else {
          filtered.unshift({ id: hiddenMatch.group, items: [hiddenMatch] });
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
  dynamicState?: Pick<TransportModelState, 'models' | 'defaultModel' | 'loading'> | null;
  cachedCatalog?: CachedTransportModelCatalog | null;
}): ResolvedCrossSdkModels {
  const { sdk, sessionName, dynamicState } = options;
  const cachedCatalog = options.cachedCatalog !== undefined
    ? options.cachedCatalog
    : readCachedTransportModels(
      `${sessionName?.trim() ?? ''}\0${sdk}\0`,
      sdk,
    );

  const dynamicIds = (dynamicState?.models ?? []).map((m) => m.id).filter(Boolean);
  const cachedIds = (cachedCatalog?.models ?? []).map((m) => m.id).filter(Boolean);
  const staticFallback = getStaticFallbackModels(sdk);

  let staticList: readonly string[] = [];
  if (sdk === 'claude-code' || sdk === 'claude-code-sdk' || sdk === CLAUDE_CODE_CLI_SDK_AGENT_TYPE) {
    staticList = CLAUDE_CODE_MODEL_IDS;
  } else if (sdk === 'codex' || sdk === 'codex-sdk') {
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
    || cachedCatalog?.defaultModel?.trim()
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
