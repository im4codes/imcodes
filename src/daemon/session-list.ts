import type { SessionRecord } from '../store/session-store.js';
import { listSessions, upsertSession } from '../store/session-store.js';
import { getQwenRuntimeConfig } from '../agent/qwen-runtime-config.js';
import { getQwenDisplayMetadata } from '../agent/provider-display.js';
import { getQwenOAuthQuotaUsageLabel } from '../agent/provider-quota.js';
import { getClaudeSdkRuntimeConfig } from '../agent/sdk-runtime-config.js';
import { getCodexRuntimeConfig } from '../agent/codex-runtime-config.js';

export interface SessionListItem {
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
  qwenAuthType?: string;
  qwenAuthLimit?: string;
  qwenAvailableModels?: string[];
  modelDisplay?: string;
  planLabel?: string;
  quotaLabel?: string;
  quotaUsageLabel?: string;
  description?: string;
  label?: string;
}

function baseItem(s: SessionRecord): SessionListItem {
  return {
    name: s.name,
    project: s.projectName,
    role: s.role,
    agentType: s.agentType,
    agentVersion: s.agentVersion,
    state: s.state,
    projectDir: s.projectDir,
    runtimeType: s.runtimeType,
    providerId: s.providerId,
    providerSessionId: s.providerSessionId,
    qwenModel: s.qwenModel,
    qwenAuthType: s.qwenAuthType,
    qwenAuthLimit: s.qwenAuthLimit,
    qwenAvailableModels: s.qwenAvailableModels,
    modelDisplay: s.modelDisplay,
    planLabel: s.planLabel,
    quotaLabel: s.quotaLabel,
    quotaUsageLabel: s.quotaUsageLabel,
    description: s.description,
    label: s.label,
  };
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
  const qwenRuntime = needsQwenHydration ? await getQwenRuntimeConfig().catch(() => null) : null;
  const claudeSdkRuntime = needsClaudeSdkHydration ? await getClaudeSdkRuntimeConfig().catch(() => ({}) as import('../agent/sdk-runtime-config.js').SdkRuntimeConfig) : null;
  const codexRuntime = needsCodexHydration ? await getCodexRuntimeConfig().catch(() => ({}) as import('../agent/codex-runtime-config.js').CodexRuntimeConfig) : null;

  return sessions.map((s) => {
    if (s.agentType === 'claude-code-sdk') {
      const hydrated: Partial<SessionRecord> = {
        ...(claudeSdkRuntime?.planLabel ? { planLabel: claudeSdkRuntime.planLabel } : {}),
        
      };
      if (hydrated.planLabel !== s.planLabel || hydrated.quotaLabel !== s.quotaLabel || hydrated.quotaUsageLabel != s.quotaUsageLabel) {
        upsertSession({ ...s, ...hydrated, updatedAt: Date.now() });
      }
      return { ...baseItem(s), ...hydrated };
    }
    if (s.agentType === 'codex' || s.agentType === 'codex-sdk') {
      const hydrated: Partial<SessionRecord> = {
        ...(codexRuntime?.planLabel ? { planLabel: codexRuntime.planLabel } : {}),
        ...(codexRuntime?.quotaLabel ? { quotaLabel: codexRuntime.quotaLabel } : {}),
        ...(codexRuntime?.quotaUsageLabel ? { quotaUsageLabel: codexRuntime.quotaUsageLabel } : {}),
      };
      if (hydrated.planLabel !== s.planLabel || hydrated.quotaLabel !== s.quotaLabel || hydrated.quotaUsageLabel != s.quotaUsageLabel) {
        upsertSession({ ...s, ...hydrated, updatedAt: Date.now() });
      }
      return { ...baseItem(s), ...hydrated };
    }
    if (s.agentType !== 'qwen') return baseItem(s);

    const qwenAuthType = s.qwenAuthType ?? qwenRuntime?.authType;
    const qwenAuthLimit = s.qwenAuthLimit ?? qwenRuntime?.authLimit;
    const qwenAvailableModels = s.qwenAvailableModels?.length
      ? s.qwenAvailableModels
      : (qwenRuntime?.availableModels?.length ? qwenRuntime.availableModels : undefined);
    const qwenModel = s.qwenModel ?? qwenAvailableModels?.[0];
    const displayMetadata = getQwenDisplayMetadata({
      model: qwenModel,
      authType: qwenAuthType,
      authLimit: qwenAuthLimit,
      quotaUsageLabel: qwenAuthType === 'qwen-oauth' ? getQwenOAuthQuotaUsageLabel() : undefined,
    });

    const hydrated: Partial<SessionRecord> = {
      ...(qwenModel ? { qwenModel } : {}),
      ...(qwenAuthType ? { qwenAuthType } : {}),
      ...(qwenAuthLimit ? { qwenAuthLimit } : {}),
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
