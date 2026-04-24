import type { SessionRecord } from '../store/session-store.js';
import type { SessionContextBootstrapState } from '../../shared/session-context-bootstrap.js';
import { listSessions, upsertSession } from '../store/session-store.js';
import { getQwenRuntimeConfig } from '../agent/qwen-runtime-config.js';
import { getQwenDisplayMetadata } from '../agent/provider-display.js';
import { getQwenOAuthQuotaUsageLabel } from '../agent/provider-quota.js';
import { getClaudeSdkRuntimeConfig } from '../agent/sdk-runtime-config.js';
import { getCodexRuntimeConfig } from '../agent/codex-runtime-config.js';
import { getCopilotRuntimeConfig } from '../agent/copilot-runtime-config.js';
import { getCursorRuntimeConfig } from '../agent/cursor-runtime-config.js';
import { providerQuotaMetaEquals } from '../../shared/provider-quota.js';
import { QWEN_AUTH_TYPES } from '../../shared/qwen-auth.js';
import { getTransportRuntime } from '../agent/session-manager.js';

export interface SessionListItem extends SessionContextBootstrapState {
  name: string;
  project: string;
  role: string;
  agentType: string;
  agentVersion?: string;
  state: string;
  projectDir?: string;
  runtimeType?: string;
  providerId?: string;
  providerSessionId?: string;
  qwenModel?: string;
  requestedModel?: string;
  activeModel?: string;
  qwenAuthType?: string;
  qwenAuthLimit?: string;
  qwenAvailableModels?: string[];
  copilotAvailableModels?: string[];
  cursorAvailableModels?: string[];
  codexAvailableModels?: string[];
  modelDisplay?: string;
  planLabel?: string;
  permissionLabel?: string;
  quotaLabel?: string;
  quotaUsageLabel?: string;
  quotaMeta?: import('../../shared/provider-quota.js').ProviderQuotaMeta;
  effort?: import('../../shared/effort-levels.js').TransportEffortLevel;
  description?: string;
  label?: string;
  transportConfig?: Record<string, unknown>;
  transportPendingMessages?: string[];
  transportPendingMessageEntries?: Array<{ clientMessageId: string; text: string }>;
}

function resolveTransportSessionListState(
  record: SessionRecord,
  runtime: ReturnType<typeof getTransportRuntime> | undefined,
): SessionListItem['state'] {
  if (!runtime) return record.state;
  const status = runtime.getStatus();
  if (status === 'error') return 'error';
  if (status === 'streaming' || status === 'thinking' || status === 'tool_running' || status === 'permission') {
    return 'running';
  }
  if (status === 'idle') return 'idle';
  return record.state;
}

function baseItem(s: SessionRecord): SessionListItem {
  const runtime = s.runtimeType === 'transport' ? getTransportRuntime(s.name) : undefined;
  return {
    name: s.name,
    project: s.projectName,
    role: s.role,
    agentType: s.agentType,
    agentVersion: s.agentVersion,
    state: resolveTransportSessionListState(s, runtime),
    projectDir: s.projectDir,
    runtimeType: s.runtimeType,
    providerId: s.providerId,
    providerSessionId: s.providerSessionId,
    qwenModel: s.qwenModel,
    requestedModel: s.requestedModel,
    activeModel: s.activeModel,
    qwenAuthType: s.qwenAuthType,
    qwenAuthLimit: s.qwenAuthLimit,
    qwenAvailableModels: s.qwenAvailableModels,
    copilotAvailableModels: s.copilotAvailableModels,
    cursorAvailableModels: s.cursorAvailableModels,
    codexAvailableModels: s.codexAvailableModels,
    modelDisplay: s.modelDisplay ?? s.activeModel,
    planLabel: s.planLabel,
    permissionLabel: s.permissionLabel,
    quotaLabel: s.quotaLabel,
    quotaUsageLabel: s.quotaUsageLabel,
    quotaMeta: s.quotaMeta,
    effort: s.effort,
    contextNamespace: s.contextNamespace,
    contextNamespaceDiagnostics: s.contextNamespaceDiagnostics,
    contextRemoteProcessedFreshness: s.contextRemoteProcessedFreshness,
    contextLocalProcessedFreshness: s.contextLocalProcessedFreshness,
    contextRetryExhausted: s.contextRetryExhausted,
    contextSharedPolicyOverride: s.contextSharedPolicyOverride,
    description: s.description,
    label: s.label,
    transportConfig: s.transportConfig,
    transportPendingMessages: runtime?.pendingMessages ?? [],
    transportPendingMessageEntries: runtime?.pendingEntries ?? [],
  };
}

function getPermissionLabel(agentType: string): string | undefined {
  return (agentType === 'claude-code' || agentType === 'claude-code-sdk' || agentType === 'codex' || agentType === 'codex-sdk')
    ? 'all'
    : undefined;
}

function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function maybePersistHydratedQwenSession(original: SessionRecord, hydrated: Partial<SessionRecord>): void {
  const next: SessionRecord = { ...original, ...hydrated };
  if (
    next.qwenModel === original.qwenModel
    && next.qwenAuthType === original.qwenAuthType
    && next.qwenAuthLimit === original.qwenAuthLimit
    && arraysEqual(next.qwenAvailableModels, original.qwenAvailableModels)
    && next.modelDisplay === original.modelDisplay
    && next.planLabel === original.planLabel
    && next.quotaLabel === original.quotaLabel
    && next.quotaUsageLabel === original.quotaUsageLabel
  ) {
    return;
  }
  upsertSession({ ...next, updatedAt: Date.now() });
}

export async function buildSessionList(): Promise<SessionListItem[]> {
  const sessions = listSessions().filter((s) => !s.name.startsWith('deck_sub_'));
  const needsQwenHydration = sessions.some((s) => s.agentType === 'qwen');
  const needsClaudeSdkHydration = sessions.some((s) => s.agentType === 'claude-code-sdk');
  const needsCodexHydration = sessions.some((s) => (s.agentType === 'codex' || s.agentType === 'codex-sdk'));
  const needsCopilotHydration = sessions.some((s) => s.agentType === 'copilot-sdk');
  const needsCursorHydration = sessions.some((s) => s.agentType === 'cursor-headless');
  const qwenRuntime = needsQwenHydration ? await getQwenRuntimeConfig().catch(() => null) : null;
  const claudeSdkRuntime = needsClaudeSdkHydration ? await getClaudeSdkRuntimeConfig().catch(() => ({}) as import('../agent/sdk-runtime-config.js').SdkRuntimeConfig) : null;
  const codexRuntime = needsCodexHydration ? await getCodexRuntimeConfig().catch(() => ({}) as import('../agent/codex-runtime-config.js').CodexRuntimeConfig) : null;
  const copilotRuntime = needsCopilotHydration ? await getCopilotRuntimeConfig().catch(() => null) : null;
  const cursorRuntime = needsCursorHydration ? await getCursorRuntimeConfig().catch(() => null) : null;

  // Collect preset-pinned models for all qwen sessions that have a ccPreset.
  // Doing this once (before the map) avoids per-session dynamic imports inside
  // a synchronous .map() callback. The preset model takes priority over
  // qwenRuntime available models for display so preset sessions (e.g. MiniMax)
  // show the correct model even when qwenRuntime hasn't loaded yet.
  const presetModelBySession = new Map<string, { defaultModel?: string; availableModels: string[] }>();
  if (needsQwenHydration) {
    const { getPreset, getPresetAvailableModelIds, getPresetEffectiveModel } = await import('./cc-presets.js');
    for (const s of sessions) {
      if (s.agentType === 'qwen' && s.ccPreset) {
        const preset = await getPreset(s.ccPreset);
        presetModelBySession.set(s.name, {
          defaultModel: preset ? getPresetEffectiveModel(preset) : undefined,
          availableModels: preset ? getPresetAvailableModelIds(preset) : [],
        });
      }
    }
  }

  return sessions.map((s) => {
    if (s.agentType === 'claude-code-sdk') {
      const hydrated: Partial<SessionRecord> = {
        ...(claudeSdkRuntime?.planLabel ? { planLabel: claudeSdkRuntime.planLabel } : {}),
        permissionLabel: getPermissionLabel(s.agentType),
      };
      if (hydrated.planLabel !== s.planLabel || hydrated.permissionLabel !== s.permissionLabel || hydrated.quotaLabel !== s.quotaLabel || hydrated.quotaUsageLabel != s.quotaUsageLabel) {
        upsertSession({ ...s, ...hydrated, updatedAt: Date.now() });
      }
      return { ...baseItem(s), ...hydrated };
    }
    if (s.agentType === 'codex' || s.agentType === 'codex-sdk') {
      const hydrated: Partial<SessionRecord> = {
        ...(codexRuntime?.availableModels?.length ? { codexAvailableModels: codexRuntime.availableModels } : {}),
        planLabel: codexRuntime?.planLabel,
        permissionLabel: getPermissionLabel(s.agentType),
        quotaLabel: codexRuntime?.quotaLabel,
        quotaUsageLabel: codexRuntime?.quotaUsageLabel,
        quotaMeta: codexRuntime?.quotaMeta,
      };
      if (
        hydrated.planLabel !== s.planLabel
        || !arraysEqual(hydrated.codexAvailableModels, s.codexAvailableModels)
        || hydrated.permissionLabel !== s.permissionLabel
        || hydrated.quotaLabel !== s.quotaLabel
        || hydrated.quotaUsageLabel != s.quotaUsageLabel
        || !providerQuotaMetaEquals(hydrated.quotaMeta, s.quotaMeta)
      ) {
        upsertSession({ ...s, ...hydrated, updatedAt: Date.now() });
      }
      return { ...baseItem(s), ...hydrated };
    }
    if (s.agentType === 'copilot-sdk') {
      const available = copilotRuntime?.availableModels?.length
        ? copilotRuntime.availableModels
        : s.copilotAvailableModels;
      const hydrated: Partial<SessionRecord> = {
        ...(available?.length ? { copilotAvailableModels: available } : {}),
      };
      if (!arraysEqual(hydrated.copilotAvailableModels, s.copilotAvailableModels)) {
        upsertSession({ ...s, ...hydrated, updatedAt: Date.now() });
      }
      return { ...baseItem(s), ...hydrated };
    }
    if (s.agentType === 'cursor-headless') {
      const available = cursorRuntime?.availableModels?.length
        ? cursorRuntime.availableModels
        : s.cursorAvailableModels;
      const hydrated: Partial<SessionRecord> = {
        ...(available?.length ? { cursorAvailableModels: available } : {}),
      };
      if (!arraysEqual(hydrated.cursorAvailableModels, s.cursorAvailableModels)) {
        upsertSession({ ...s, ...hydrated, updatedAt: Date.now() });
      }
      return { ...baseItem(s), ...hydrated };
    }
    if (s.agentType !== 'qwen') return baseItem(s);

    // Preset-backed qwen sessions run `qwen --auth-type anthropic` against a
    // user-provided API key. The user-level `~/.qwen/settings.json` tier
    // ("Free / qwen-oauth") and the "Limit: No longer available" string from
    // `qwen auth status` don't apply in that context — override them so the
    // footer shows "BYO" + the preset's pinned model instead of "coder-model
    // No longer available". Non-preset qwen sessions keep the OAuth-derived
    // tier labels so users see the real state of their CLI auth.
    const presetActive = !!s.ccPreset;
    const presetConfig = presetModelBySession.get(s.name);
    const presetModel = presetConfig?.defaultModel;
    const presetModels = presetConfig?.availableModels ?? [];

    const qwenAuthType = presetActive
      ? QWEN_AUTH_TYPES.API_KEY
      : (s.qwenAuthType ?? qwenRuntime?.authType);
    const qwenAuthLimit = presetActive
      ? undefined
      : (s.qwenAuthLimit ?? qwenRuntime?.authLimit);
    const qwenAvailableModels = presetActive
      ? (presetModels.length
          ? presetModels
          : (s.qwenAvailableModels?.length
              ? s.qwenAvailableModels
              : (qwenRuntime?.availableModels?.length ? qwenRuntime.availableModels : undefined)))
      : (s.qwenAvailableModels?.length
          ? s.qwenAvailableModels
          : (qwenRuntime?.availableModels?.length ? qwenRuntime.availableModels : undefined));
    const qwenModel = presetActive
      ? ((s.qwenModel && qwenAvailableModels?.includes(s.qwenModel))
          ? s.qwenModel
          : (presetModel ?? qwenAvailableModels?.[0] ?? s.qwenModel))
      : (s.qwenModel ?? qwenAvailableModels?.[0]);
    // For preset-backed sessions, keep a valid user-selected model visible.
    // Fall back to the preset default only when the stored selection is stale.
    const displayModel = presetActive
      ? (qwenModel ?? presetModel ?? s.modelDisplay)
      : (s.modelDisplay ?? qwenModel);
    const displayMetadata = getQwenDisplayMetadata({
      model: displayModel,
      authType: qwenAuthType,
      authLimit: qwenAuthLimit,
      quotaUsageLabel: !presetActive && qwenAuthType === 'qwen-oauth' ? getQwenOAuthQuotaUsageLabel() : undefined,
    });

    const hydrated: Partial<SessionRecord> = {
      ...(qwenModel ? { qwenModel } : {}),
      qwenAuthType,
      qwenAuthLimit,
      ...(qwenAvailableModels?.length ? { qwenAvailableModels } : {}),
      ...displayMetadata,
    };
    maybePersistHydratedQwenSession(s, hydrated);

    return {
      ...baseItem(s),
      ...hydrated,
    };
  });
}
