import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentAvailabilityMap } from '../../shared/agent-availability.js';
import {
  CLAUDE_CODE_CLI_SDK_AGENT_TYPE,
  isClaudeCodeFamily,
  isCodexFamily,
} from '../../shared/agent-types.js';
import { AGY_FALLBACK_MODEL_IDS, AGY_SDK_PROVIDER_ID } from '../../shared/agy-agent.js';
import { AGY_USAGE_MAX_PERSISTED_AGE_MS } from '../../shared/agy-usage.js';
import { HERMES_AGENT_PROVIDER_ID } from '../../shared/hermes-agent.js';
import { resolvePeerAuditProviderFamily } from '../../shared/peer-audit.js';
import { QWEN_MODEL_IDS } from '../../shared/qwen-models.js';
import {
  classifySdkModelTiers,
  normalizeModelTierKnowledgeProvider,
  type ExecutionPoolSdkCatalogSource,
  type ExecutionPoolSdkSummary,
  type LearnedModelTierRecord,
} from '../../shared/supervision-execution-pool.js';
import { detectInstalledAgents } from '../agent/agent-availability.js';
import { getCodexRuntimeConfig } from '../agent/codex-runtime-config.js';
import { getCodexHome } from '../util/codex-rollout-path.js';
import { detectLocalAuthContext, hasLocalAuthCandidate, type LocalAuthContext } from '../agent/local-auth-context.js';
import { getProvider } from '../agent/provider-registry.js';
import type { TransportProvider } from '../agent/transport-provider.js';
import { CLAUDE_CODE_MODEL_IDS, CODEX_MODEL_IDS, MUSE_MODEL_IDS } from '../shared/models/options.js';
import { getSession, listSessions, type SessionRecord } from '../store/session-store.js';
import { imcodesStatePath } from '../util/imcodes-state-dir.js';
import { loadModelTierKnowledge } from './model-tier-knowledge.js';

const PROBE_TIMEOUT_MS = 1_500;

const CANDIDATE_SDKS = [
  AGY_SDK_PROVIDER_ID,
  'codex-sdk',
  'claude-code-sdk',
  'grok-sdk',
  'copilot-sdk',
  'qwen',
  'kimi-sdk',
  'muse-code-sdk',
  'opencode-sdk',
  'cursor-headless',
  'deepseek-harness',
  'qoder-sdk',
  'pi',
  HERMES_AGENT_PROVIDER_ID,
] as const;

const SKIP_LIVE_LIST_MODELS_SDKS = new Set<string>([
  'claude-code-sdk',
  CLAUDE_CODE_CLI_SDK_AGENT_TYPE,
  'codex-sdk',
]);

export interface ExecutionPoolBrainSnapshot {
  provider: string;
  providerFamily: string;
  model?: string;
}

export interface ExecutionPoolSdkProbeResult {
  currentBrain: ExecutionPoolBrainSnapshot;
  sdks: ExecutionPoolSdkSummary[];
}

export type ProbeableProviderList = {
  models?: Array<{ id: string }>;
  isAuthenticated?: boolean;
  error?: string;
};

export interface SdkExecutionPoolProbeDeps {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  listSessions?: () => SessionRecord[];
  getSession?: (name: string) => SessionRecord | undefined;
  detectInstalledAgents?: () => Promise<AgentAvailabilityMap>;
  detectLocalAuthContext?: (providerId: string, env: NodeJS.ProcessEnv) => Promise<LocalAuthContext>;
  getProvider?: (id: string) => (Pick<TransportProvider, 'id'> & {
    getCachedModels?: () => ProbeableProviderList | null;
    listModels?: (force?: boolean) => Promise<ProbeableProviderList | null | undefined>;
  }) | undefined;
  getCodexRuntimeConfig?: typeof getCodexRuntimeConfig;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  loadKnowledge?: () => LearnedModelTierRecord[];
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (!(ms > 0)) return promise;
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function safeJsonFileNonEmpty(
  path: string,
  fileExists: (p: string) => boolean,
  readFileFn: (p: string) => string,
): Record<string, unknown> | null {
  try {
    if (!fileExists(path)) return null;
    const raw = readFileFn(path);
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hasFreshPersistedAt(parsed: Record<string, unknown>, nowMs: number): boolean {
  const ts = typeof parsed.at === 'number'
    ? parsed.at
    : typeof parsed.updatedAt === 'number'
      ? parsed.updatedAt
      : null;
  if (ts === null || !Number.isFinite(ts)) return false;
  if (ts > nowMs + 60_000) return false;
  return nowMs - ts < AGY_USAGE_MAX_PERSISTED_AGE_MS;
}

function hasValidAgyQuotaCache(
  nowMs: number,
  env: NodeJS.ProcessEnv,
  fileExists: (p: string) => boolean,
  readFileFn: (p: string) => string,
): boolean {
  const path = imcodesStatePath('agy-usage-quota.json');
  void env;
  const parsed = safeJsonFileNonEmpty(path, fileExists, readFileFn);
  if (!parsed) return false;
  if (!hasFreshPersistedAt(parsed, nowMs)) return false;
  const value = parsed.value && typeof parsed.value === 'object' ? (parsed.value as Record<string, unknown>) : parsed;
  return Boolean(value.quotaMeta && typeof value.quotaMeta === 'object');
}

function hasValidClaudeLocalAuth(
  nowMs: number,
  env: NodeJS.ProcessEnv,
  homeDir: string,
  fileExists: (p: string) => boolean,
  readFileFn: (p: string) => string,
): boolean {
  if (env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim()) return true;
  const creds = safeJsonFileNonEmpty(join(homeDir, '.claude', '.credentials.json'), fileExists, readFileFn);
  const oauth = creds?.claudeAiOauth && typeof creds.claudeAiOauth === 'object'
    ? (creds.claudeAiOauth as { accessToken?: unknown; expiresAt?: unknown })
    : undefined;
  if (typeof oauth?.accessToken === 'string' && oauth.accessToken.trim().length > 0) {
    if (typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt) && nowMs >= oauth.expiresAt) {
      return false;
    }
    return true;
  }
  const quotaCache = safeJsonFileNonEmpty(imcodesStatePath('claude-usage-quota.json'), fileExists, readFileFn);
  if (quotaCache && quotaCache.value && typeof quotaCache.value === 'object' && hasFreshPersistedAt(quotaCache, nowMs)) {
    return true;
  }
  return false;
}

function matchesProviderFamilyOrCanonical(sessionAgentType: string, sdkProvider: string): boolean {
  const normSession = normalizeModelTierKnowledgeProvider(sessionAgentType);
  const normSdk = normalizeModelTierKnowledgeProvider(sdkProvider);
  if (normSession === normSdk) return true;
  if (isClaudeCodeFamily(sessionAgentType) && sdkProvider === 'claude-code-sdk') return true;
  if (isCodexFamily(sessionAgentType) && sdkProvider === 'codex-sdk') return true;
  return false;
}

function isLiveSessionRecord(session: SessionRecord): boolean {
  return session.state !== 'error' && session.state !== 'stopped';
}

function sessionObservedModelsForSdk(sessions: readonly SessionRecord[], sdkProvider: string): string[] {
  const collected: string[] = [];
  const push = (val: unknown) => {
    if (typeof val !== 'string') return;
    const trimmed = val.trim();
    if (trimmed && !collected.includes(trimmed)) collected.push(trimmed);
  };
  for (const session of sessions) {
    if (!matchesProviderFamilyOrCanonical(session.agentType, sdkProvider)) continue;
    if (!isLiveSessionRecord(session)) continue;
    push(session.activeModel);
    if (!session.activeModel && hasVerifiedSessionRuntimeEvidence(session)) {
      push(session.requestedModel);
    }
    if (sdkProvider === 'codex-sdk' && Array.isArray(session.codexAvailableModels)) {
      for (const m of session.codexAvailableModels) push(m);
    }
    if (sdkProvider === 'qwen' && Array.isArray(session.qwenAvailableModels)) {
      for (const m of session.qwenAvailableModels) push(m);
    }
    if (sdkProvider === 'copilot-sdk' && Array.isArray(session.copilotAvailableModels)) {
      for (const m of session.copilotAvailableModels) push(m);
    }
    if (sdkProvider === 'cursor-headless' && Array.isArray(session.cursorAvailableModels)) {
      for (const m of session.cursorAvailableModels) push(m);
    }
  }
  return collected;
}

function staticFallbackModelsForSdk(sdkProvider: string): readonly string[] {
  switch (sdkProvider) {
    case AGY_SDK_PROVIDER_ID:
      return AGY_FALLBACK_MODEL_IDS;
    case 'codex-sdk':
      return CODEX_MODEL_IDS;
    case 'claude-code-sdk':
    case CLAUDE_CODE_CLI_SDK_AGENT_TYPE:
      return CLAUDE_CODE_MODEL_IDS;
    case 'qwen':
      return QWEN_MODEL_IDS;
    case 'muse-code-sdk':
      return MUSE_MODEL_IDS;
    default:
      return [];
  }
}

function hasVerifiedSessionRuntimeEvidence(session: SessionRecord): boolean {
  if (session.activeModel?.trim()) return true;
  if (
    session.ccSessionId?.trim()
    || session.codexSessionId?.trim()
    || session.geminiSessionId?.trim()
    || session.opencodeSessionId?.trim()
  ) {
    return true;
  }
  return (session.state === 'idle' || session.state === 'running')
    && Boolean(session.sessionInstanceId?.trim() && session.runtimeEpoch?.trim());
}

function hasVerifiedActiveSessionForSdk(
  sessions: readonly SessionRecord[],
  sdkProvider: string,
  callerSessionName?: string,
): boolean {
  return sessions.some((s) => {
    if (!matchesProviderFamilyOrCanonical(s.agentType, sdkProvider)) return false;
    if (!isLiveSessionRecord(s)) return false;
    if (callerSessionName && s.name === callerSessionName) return true;
    return hasVerifiedSessionRuntimeEvidence(s);
  });
}

function isStaticMuseFallbackList(
  sdkProvider: string,
  providerList: ProbeableProviderList | null | undefined,
  hasActiveSession: boolean,
): boolean {
  if (sdkProvider !== 'muse-code-sdk' || hasActiveSession || !providerList?.models?.length) return false;
  if (providerList.models.length !== MUSE_MODEL_IDS.length) return false;
  return providerList.models.every((m, idx) => m.id === MUSE_MODEL_IDS[idx]);
}

/**
 * Lightweight, non-blocking local + live-cache SDK availability & model catalog probe.
 * Never spawns heavy CLI processes and never emits tokens/credentials.
 */
export async function probeExecutionPoolSdks(
  options: { callerSessionName?: string; deps?: SdkExecutionPoolProbeDeps } = {},
): Promise<ExecutionPoolSdkProbeResult> {
  const deps = options.deps ?? {};
  const env = deps.env ?? process.env;
  const nowMs = (deps.now ?? Date.now)();
  const homeDir = deps.homeDir ?? env.HOME?.trim() ?? homedir();
  const fileExists = deps.fileExists ?? existsSync;
  const readFileFn = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const getSess = deps.getSession ?? getSession;
  const listSess = deps.listSessions ?? (() => listSessions());
  const getProv = deps.getProvider ?? ((id: string) => getProvider(id) as {
    id: string;
    getCachedModels?: () => ProbeableProviderList | null;
    listModels?: (force?: boolean) => Promise<ProbeableProviderList | null | undefined>;
  } | undefined);
  const loadCodexCfg = deps.getCodexRuntimeConfig ?? getCodexRuntimeConfig;
  const loadKnowledge = deps.loadKnowledge ?? (() => loadModelTierKnowledge());
  const authProbe = deps.detectLocalAuthContext ?? detectLocalAuthContext;

  const sessions = listSess();
  const callerRecord = options.callerSessionName ? getSess(options.callerSessionName) : undefined;
  const currentBrainProvider = callerRecord?.agentType
    ? normalizeModelTierKnowledgeProvider(callerRecord.agentType)
    : 'claude-code-sdk';
  const currentBrainFamily = resolvePeerAuditProviderFamily({
    agentType: callerRecord?.agentType ?? currentBrainProvider,
    providerId: currentBrainProvider,
  });
  const currentBrainModel = callerRecord?.activeModel ?? callerRecord?.requestedModel;

  const installedAgents = await withTimeout(
    (deps.detectInstalledAgents ?? (() => detectInstalledAgents()))(),
    PROBE_TIMEOUT_MS,
    {} as AgentAvailabilityMap,
  );
  const knowledge = loadKnowledge();

  // Codex cold file/cache check (does NOT spawn app-server)
  const codexHome = getCodexHome(env);
  const codexModelsCacheExists = fileExists(join(codexHome, 'models_cache.json'));
  const codexCfg = await withTimeout(
    loadCodexCfg({ probe: false, useFileCatalogOnCold: true }),
    PROBE_TIMEOUT_MS,
    {} as Awaited<ReturnType<typeof getCodexRuntimeConfig>>,
  );

  // Determine candidate provider list (always keep currentBrainProvider even if non-standard)
  const candidateProviders: string[] = [...CANDIDATE_SDKS];
  if (!candidateProviders.includes(currentBrainProvider)) {
    candidateProviders.unshift(currentBrainProvider);
  }

  const sdks: ExecutionPoolSdkSummary[] = [];

  for (const sdkProvider of candidateProviders) {
    const providerFamily = resolvePeerAuditProviderFamily({ agentType: sdkProvider, providerId: sdkProvider });
    const liveProvider = getProv(sdkProvider);
    const observedModels = sessionObservedModelsForSdk(sessions, sdkProvider);
    const installed = installedAgents[sdkProvider as keyof AgentAvailabilityMap]?.installed === true;
    const isBrainSdk = Boolean(
      callerRecord
      && isLiveSessionRecord(callerRecord)
      && (sdkProvider === currentBrainProvider || matchesProviderFamilyOrCanonical(callerRecord.agentType, sdkProvider)),
    );
    const healthySession = hasVerifiedActiveSessionForSdk(sessions, sdkProvider, options.callerSessionName);

    let providerList: ProbeableProviderList | null = liveProvider?.getCachedModels?.() ?? null;
    if (
      !providerList
      && !liveProvider?.getCachedModels
      && typeof liveProvider?.listModels === 'function'
      && (installed || healthySession || isBrainSdk)
      && !SKIP_LIVE_LIST_MODELS_SDKS.has(sdkProvider)
    ) {
      providerList = (await withTimeout(
        Promise.resolve().then(() => liveProvider.listModels!(false)).catch(() => null),
        PROBE_TIMEOUT_MS,
        null,
      )) ?? null;
    }

    const staticMuseFallback = isStaticMuseFallbackList(sdkProvider, providerList, healthySession || isBrainSdk);
    const effectiveProviderList = staticMuseFallback ? null : providerList;
    const explicitUnauthenticated = effectiveProviderList?.isAuthenticated === false;

    let loggedIn = isBrainSdk || healthySession;

    if (!loggedIn && !explicitUnauthenticated) {
      if (sdkProvider === AGY_SDK_PROVIDER_ID) {
        loggedIn = Boolean(
          effectiveProviderList?.isAuthenticated === true
          || (effectiveProviderList?.models?.length && !effectiveProviderList.error)
          || hasValidAgyQuotaCache(nowMs, env, fileExists, readFileFn),
        );
      } else if (sdkProvider === 'claude-code-sdk') {
        if (hasValidClaudeLocalAuth(nowMs, env, homeDir, fileExists, readFileFn)) {
          loggedIn = true;
        } else if (hasLocalAuthCandidate(sdkProvider, env)) {
          const ctx = await withTimeout(authProbe(sdkProvider, env), PROBE_TIMEOUT_MS, {
            providerId: sdkProvider, method: 'unsupported', source: 'none', authenticated: false, reusable: false, env: {},
          });
          loggedIn = ctx.authenticated;
        }
      } else if (sdkProvider === 'codex-sdk') {
        if (effectiveProviderList?.isAuthenticated === true || Boolean(codexCfg.planLabel)) {
          loggedIn = true;
        } else {
          const ctx = await withTimeout(authProbe(sdkProvider, env), PROBE_TIMEOUT_MS, {
            providerId: sdkProvider, method: 'unsupported', source: 'none', authenticated: false, reusable: false, env: {},
          });
          loggedIn = ctx.authenticated;
        }
      } else {
        if (
          effectiveProviderList?.isAuthenticated === true
          || (effectiveProviderList?.isAuthenticated === undefined && Boolean(effectiveProviderList?.models?.length) && !effectiveProviderList?.error)
        ) {
          loggedIn = true;
        } else if (hasLocalAuthCandidate(sdkProvider, env)) {
          const ctx = await withTimeout(authProbe(sdkProvider, env), PROBE_TIMEOUT_MS, {
            providerId: sdkProvider, method: 'unsupported', source: 'none', authenticated: false, reusable: false, env: {},
          });
          loggedIn = ctx.authenticated;
        }
      }
    }

    // Only surface SDKs that are logged in, installed, or currently hosting the Brain.
    if (!loggedIn && !installed && !isBrainSdk) continue;

    // Collect model catalog with strict priority: live_catalog > session_observed > static_fallback
    // Never mix historical session_observed models into an authoritative live_catalog.
    let rawModels: string[] = [];
    let source: ExecutionPoolSdkCatalogSource = 'static_fallback';

    if (
      effectiveProviderList?.models?.length
      && !effectiveProviderList.error
      && effectiveProviderList.isAuthenticated !== false
    ) {
      rawModels = effectiveProviderList.models.map((m) => m.id);
      source = 'live_catalog';
    } else if (sdkProvider === 'codex-sdk' && codexCfg.availableModels?.length && (codexModelsCacheExists || codexCfg.planLabel || Boolean(liveProvider))) {
      // Distinguish live/file-cached Codex catalog from static CODEX_MODEL_IDS fallback
      const matchesStaticExactly = codexCfg.availableModels.length === CODEX_MODEL_IDS.length
        && codexCfg.availableModels.every((m, idx) => m === CODEX_MODEL_IDS[idx]);
      if (codexModelsCacheExists || !matchesStaticExactly) {
        rawModels = [...codexCfg.availableModels];
        source = 'live_catalog';
      }
    }

    if (rawModels.length === 0 && observedModels.length > 0) {
      rawModels = [...observedModels];
      source = 'session_observed';
    }

    if (rawModels.length === 0) {
      rawModels = [...staticFallbackModelsForSdk(sdkProvider)];
      source = 'static_fallback';
    } else if (sdkProvider === 'claude-code-sdk' && source === 'session_observed') {
      // When no preset/provider live list exists for claude-code-sdk, append standard static options
      // behind any session-observed models so picker aliases remain selectable alongside observed IDs.
      rawModels = [...rawModels, ...CLAUDE_CODE_MODEL_IDS];
    }

    const classified = classifySdkModelTiers(sdkProvider, rawModels, knowledge);
    sdks.push({
      provider: sdkProvider,
      providerFamily,
      loggedIn,
      models: classified.models,
      tiers: classified.tiers,
      unknownModels: classified.unknownModels,
      source,
    });
  }

  return {
    currentBrain: {
      provider: currentBrainProvider,
      providerFamily: currentBrainFamily,
      ...(currentBrainModel ? { model: currentBrainModel } : {}),
    },
    sdks,
  };
}
