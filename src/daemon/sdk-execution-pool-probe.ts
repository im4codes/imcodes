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
] as const;

export interface ExecutionPoolBrainSnapshot {
  provider: string;
  providerFamily: string;
  model?: string;
}

export interface ExecutionPoolSdkProbeResult {
  currentBrain: ExecutionPoolBrainSnapshot;
  sdks: ExecutionPoolSdkSummary[];
}

export interface SdkExecutionPoolProbeDeps {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  listSessions?: () => SessionRecord[];
  getSession?: (name: string) => SessionRecord | undefined;
  detectInstalledAgents?: () => Promise<AgentAvailabilityMap>;
  detectLocalAuthContext?: (providerId: string, env: NodeJS.ProcessEnv) => Promise<LocalAuthContext>;
  getProvider?: (id: string) => (Pick<TransportProvider, 'id'> & { getCachedModels?: () => { models?: Array<{ id: string }>; isAuthenticated?: boolean } | null }) | undefined;
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

function hasValidAgyQuotaCache(
  env: NodeJS.ProcessEnv,
  fileExists: (p: string) => boolean,
  readFileFn: (p: string) => string,
): boolean {
  const path = imcodesStatePath('agy-usage-quota.json');
  void env;
  const parsed = safeJsonFileNonEmpty(path, fileExists, readFileFn);
  if (!parsed) return false;
  const value = parsed.value && typeof parsed.value === 'object' ? (parsed.value as Record<string, unknown>) : parsed;
  return Boolean(value.quotaMeta && typeof value.quotaMeta === 'object');
}

function hasValidClaudeLocalAuth(
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
    if (typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt) && Date.now() >= oauth.expiresAt) {
      return false;
    }
    return true;
  }
  const quotaCache = safeJsonFileNonEmpty(imcodesStatePath('claude-usage-quota.json'), fileExists, readFileFn);
  if (quotaCache) return true;
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

function sessionObservedModelsForSdk(sessions: readonly SessionRecord[], sdkProvider: string): string[] {
  const collected: string[] = [];
  const push = (val: unknown) => {
    if (typeof val !== 'string') return;
    const trimmed = val.trim();
    if (trimmed && !collected.includes(trimmed)) collected.push(trimmed);
  };
  for (const session of sessions) {
    if (!matchesProviderFamilyOrCanonical(session.agentType, sdkProvider)) continue;
    push(session.activeModel);
    push(session.requestedModel);
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

function hasHealthySessionForSdk(sessions: readonly SessionRecord[], sdkProvider: string, callerSessionName?: string): boolean {
  return sessions.some((s) => {
    if (!matchesProviderFamilyOrCanonical(s.agentType, sdkProvider)) return false;
    if (callerSessionName && s.name === callerSessionName) return true;
    return s.state !== 'error' && Boolean(s.activeModel || s.requestedModel || s.state === 'idle' || s.state === 'running');
  });
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
  const homeDir = deps.homeDir ?? env.HOME?.trim() ?? homedir();
  const fileExists = deps.fileExists ?? existsSync;
  const readFileFn = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const getSess = deps.getSession ?? getSession;
  const listSess = deps.listSessions ?? (() => listSessions());
  const getProv = deps.getProvider ?? ((id: string) => getProvider(id) as { id: string; getCachedModels?: () => { models?: Array<{ id: string }>; isAuthenticated?: boolean } | null } | undefined);
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
    const cachedProviderList = liveProvider?.getCachedModels?.() ?? null;
    const observedModels = sessionObservedModelsForSdk(sessions, sdkProvider);
    const installed = installedAgents[sdkProvider as keyof AgentAvailabilityMap]?.installed === true;
    const isBrainSdk = sdkProvider === currentBrainProvider
      || matchesProviderFamilyOrCanonical(callerRecord?.agentType ?? '', sdkProvider);
    const healthySession = hasHealthySessionForSdk(sessions, sdkProvider, options.callerSessionName);

    let loggedIn = isBrainSdk || healthySession;

    if (!loggedIn) {
      if (sdkProvider === AGY_SDK_PROVIDER_ID) {
        loggedIn = Boolean(
          cachedProviderList?.isAuthenticated === true
          || (cachedProviderList?.models && cachedProviderList.models.length > 0)
          || hasValidAgyQuotaCache(env, fileExists, readFileFn),
        );
      } else if (sdkProvider === 'claude-code-sdk') {
        if (hasValidClaudeLocalAuth(env, homeDir, fileExists, readFileFn)) {
          loggedIn = true;
        } else if (hasLocalAuthCandidate(sdkProvider, env)) {
          const ctx = await withTimeout(authProbe(sdkProvider, env), PROBE_TIMEOUT_MS, {
            providerId: sdkProvider, method: 'unsupported', source: 'none', authenticated: false, reusable: false, env: {},
          });
          loggedIn = ctx.authenticated;
        }
      } else if (sdkProvider === 'codex-sdk') {
        if (cachedProviderList?.isAuthenticated === true || Boolean(codexCfg.planLabel)) {
          loggedIn = true;
        } else {
          const ctx = await withTimeout(authProbe(sdkProvider, env), PROBE_TIMEOUT_MS, {
            providerId: sdkProvider, method: 'unsupported', source: 'none', authenticated: false, reusable: false, env: {},
          });
          loggedIn = ctx.authenticated;
        }
      } else {
        if (cachedProviderList?.isAuthenticated === true) {
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
    let rawModels: string[] = [];
    let source: ExecutionPoolSdkCatalogSource = 'static_fallback';

    if (cachedProviderList?.models?.length) {
      rawModels = cachedProviderList.models.map((m) => m.id);
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
    } else if (observedModels.length > 0) {
      // Prepend any session-observed models (e.g. brain's activeModel) not yet in live cache
      rawModels = [...observedModels, ...rawModels];
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
