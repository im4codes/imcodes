import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AGY_SDK_PROVIDER_ID } from '../../shared/agy-agent.js';
import { isClaudeCodeSdkAgentType } from '../../shared/agent-types.js';
import { CODEBUDDY_PROVIDER_IDS } from '../../shared/codebuddy.js';
import {
  DAEMON_USER_NOTICE_CODE,
  attachDaemonUserNotice,
  formatDaemonUserNoticeEnglish,
} from '../../shared/daemon-user-notices.js';
import { HERMES_AGENT_PROVIDER_ID } from '../../shared/hermes-agent.js';
import type { AgentAvailabilityMap } from '../../shared/agent-availability.js';
import type { WorkerSessionSyncStatus } from '../../shared/worker-session-snapshot.js';
import { detectInstalledAgentsWithMetadata } from '../agent/agent-availability.js';
import { ensureProviderConnected } from '../agent/provider-registry.js';
import { launchTransportSession } from '../agent/session-manager.js';
import type { ProviderConfig, ProviderModelList, TransportProvider } from '../agent/transport-provider.js';
import { listSessions, type SessionRecord } from '../store/session-store.js';
import { imcodesStateDir } from '../util/imcodes-state-dir.js';
import logger from '../util/logger.js';
import { timelineEmitter } from './timeline-emitter.js';

export const WELCOME_PROJECT_NAME = 'welcome' as const;
export const WELCOME_SESSION_NAME = 'deck_welcome_brain' as const;
export const WELCOME_SESSION_LABEL = 'Welcome' as const;
export const WELCOME_SENTINEL_FILENAME = 'welcome-session-bootstrapped.json' as const;
export const WELCOME_FALLBACK_PROVIDER_ID = 'opencode-sdk' as const;

/**
 * Exact New Session dialog transport SDK probe priority order:
 * Antigravity -> Codex SDK -> Claude Code SDK -> remaining visible transport SDKs
 * (excluding hidden providers and OpenCode, which serves as the keyless fallback).
 */
export const WELCOME_SDK_PROBE_ORDER = [
  AGY_SDK_PROVIDER_ID,
  'codex-sdk',
  'claude-code-sdk',
  'qoder-sdk',
  'copilot-sdk',
  'cursor-headless',
  'grok-sdk',
  'kimi-sdk',
  'muse-code-sdk',
  HERMES_AGENT_PROVIDER_ID,
  'deepseek-harness',
  'pi',
  CODEBUDDY_PROVIDER_IDS.CHINA,
  CODEBUDDY_PROVIDER_IDS.INTERNATIONAL,
] as const;

export type WelcomePrimarySdkId = typeof WELCOME_SDK_PROBE_ORDER[number];
export type WelcomeCandidateSdkId = WelcomePrimarySdkId | typeof WELCOME_FALLBACK_PROVIDER_ID;

const DEFAULT_PROBE_TIMEOUT_MS = 12_000;
const OPENCODE_PROVIDER_PREFIX = 'opencode/';
const OPENCODE_BIG_PICKLE_ID = 'opencode/big-pickle';
const OPENCODE_EXCLUDED_FREE_MODELS = new Set<string>([
  'opencode/beam-free',
  'opencode/inkling-2-small-free',
  'opencode/longcat-2.5-free',
]);
const OPENCODE_DEPRIORITIZED_FREE_MODELS = new Set<string>([
  'opencode/glm-5.3-flash-free',
]);

function isOpenCodeFreeSuffix(id: string): boolean {
  return /free/i.test(id.slice(OPENCODE_PROVIDER_PREFIX.length));
}

function isReliableOpenCodeFreeCandidate(id: string): boolean {
  if (!id.startsWith(OPENCODE_PROVIDER_PREFIX)) return false;
  if (OPENCODE_EXCLUDED_FREE_MODELS.has(id)) return false;
  return id === OPENCODE_BIG_PICKLE_ID || isOpenCodeFreeSuffix(id);
}

/**
 * Pick a live keyless OpenCode free model while avoiding known geo-blocked or deprecated IDs:
 * 1. Confirmed OpenCode `defaultModel` (free or `opencode/big-pickle`, non-excluded)
 * 2. `opencode/big-pickle`
 * 3. Reliable verified free models (`*deepseek*free*`, `*nemotron*lightning*free*`, `*mimo*free*`)
 * 4. Other non-excluded `opencode/*free*` (deprioritizing slow/flaky IDs)
 * 5. Any remaining non-excluded `opencode/*` fallback
 */
export function selectOpenCodeFreeModel(modelList: ProviderModelList): string | null {
  if (modelList.isAuthenticated !== true || !Array.isArray(modelList.models) || modelList.models.length === 0) {
    return null;
  }
  const openCodeModels = modelList.models.filter(
    (m) => typeof m.id === 'string' && m.id.startsWith(OPENCODE_PROVIDER_PREFIX),
  );
  if (openCodeModels.length === 0) return null;

  const eligibleModels = openCodeModels.filter((m) => !OPENCODE_EXCLUDED_FREE_MODELS.has(m.id));
  const pool = eligibleModels.length > 0 ? eligibleModels : openCodeModels;

  if (
    typeof modelList.defaultModel === 'string'
    && pool.some((m) => m.id === modelList.defaultModel)
    && isReliableOpenCodeFreeCandidate(modelList.defaultModel)
    && !OPENCODE_DEPRIORITIZED_FREE_MODELS.has(modelList.defaultModel)
  ) {
    return modelList.defaultModel;
  }

  const bigPickle = pool.find((m) => m.id === OPENCODE_BIG_PICKLE_ID);
  if (bigPickle) return bigPickle.id;

  const preferredPatterns: RegExp[] = [
    /^opencode\/.*deepseek.*free/i,
    /^opencode\/.*nemotron.*lightning.*free/i,
    /^opencode\/.*mimo.*free/i,
  ];
  for (const pattern of preferredPatterns) {
    const match = pool.find((m) => pattern.test(m.id));
    if (match) return match.id;
  }

  const otherFree = pool.find(
    (m) => isOpenCodeFreeSuffix(m.id) && !OPENCODE_DEPRIORITIZED_FREE_MODELS.has(m.id),
  );
  if (otherFree) return otherFree.id;

  const deprioritizedFree = pool.find((m) => isOpenCodeFreeSuffix(m.id));
  if (deprioritizedFree) return deprioritizedFree.id;

  if (typeof modelList.defaultModel === 'string' && pool.some((m) => m.id === modelList.defaultModel)) {
    return modelList.defaultModel;
  }

  return pool[0]?.id ?? null;
}

export interface WelcomeWorkerSyncOutcomeLike {
  status: WorkerSessionSyncStatus;
  remoteSessionCount?: number;
  remoteSubSessionCount?: number;
}

export interface WelcomeSentinelRecord {
  status: 'created' | 'skipped_existing_sessions';
  at: number;
  sessionName?: string;
  agentType?: string;
  model?: string;
  fallbackUsed?: boolean;
}

export interface WelcomeSdkProbeSelection {
  providerId: WelcomeCandidateSdkId;
  model: string;
}

export type WelcomeBootstrapResult =
  | { status: 'skipped_opt_out' }
  | { status: 'already_bootstrapped' }
  | { status: 'deferred_worker_sync' }
  | { status: 'skipped_existing_sessions' }
  | { status: 'no_available_sdk' }
  | {
    status: 'created';
    sessionName: string;
    agentType: WelcomeCandidateSdkId;
    model: string;
    fallbackUsed: boolean;
  };

export interface WelcomeProbeCandidateDeps {
  installedAgents: Partial<AgentAvailabilityMap>;
  ensureProviderConnected: (id: string, config: ProviderConfig) => Promise<Pick<TransportProvider, 'listModels'>>;
  timeoutMs?: number;
}

export interface WelcomeBootstrapDeps {
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  hasWorkerCreds?: boolean;
  workerSyncOutcome?: WelcomeWorkerSyncOutcomeLike | null;
  probeTimeoutMs?: number;
  listSessions?: () => Pick<SessionRecord, 'name'>[];
  detectInstalledAgents?: () => Promise<Partial<AgentAvailabilityMap>>;
  ensureProviderConnected?: (id: string, config: ProviderConfig) => Promise<Pick<TransportProvider, 'listModels'>>;
  launchSession?: (opts: {
    name: string;
    projectName: string;
    role: 'brain';
    agentType: WelcomeCandidateSdkId;
    projectDir: string;
    fresh: true;
    ccSessionId?: string;
    label: string;
    requestedModel: string;
  }) => Promise<void>;
  emitTimelineNotice?: (
    sessionId: string,
    payload: Record<string, unknown>,
  ) => void;
  onSessionCreated?: () => Promise<void> | void;
}

const singleFlightBySentinel = new Map<string, Promise<WelcomeBootstrapResult>>();

async function withBoundedTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (!(timeoutMs > 0)) return await promise;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Probe one transport SDK without burning LLM tokens.
 * Uninstalled SDKs are skipped immediately; hung or unauthenticated probes fail soft (`null`).
 */
export async function probeWelcomeSdkCandidate(
  providerId: WelcomeCandidateSdkId,
  deps: WelcomeProbeCandidateDeps,
): Promise<WelcomeSdkProbeSelection | null> {
  if (deps.installedAgents[providerId]?.installed !== true) {
    return null;
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let modelList: ProviderModelList | null = null;
  try {
    modelList = await withBoundedTimeout(
      (async () => {
        const provider = await deps.ensureProviderConnected(providerId, {});
        if (typeof provider.listModels !== 'function') return null;
        return await provider.listModels(true);
      })(),
      timeoutMs,
    );
  } catch (err) {
    logger.debug({ err, providerId }, 'welcome bootstrap: SDK probe failed');
    return null;
  }

  if (!modelList || modelList.isAuthenticated !== true || !Array.isArray(modelList.models) || modelList.models.length === 0) {
    return null;
  }

  if (providerId === WELCOME_FALLBACK_PROVIDER_ID) {
    const freeModel = selectOpenCodeFreeModel(modelList);
    return freeModel ? { providerId, model: freeModel } : null;
  }

  const preferred = typeof modelList.defaultModel === 'string'
    && modelList.models.some((m) => m.id === modelList.defaultModel)
    ? modelList.defaultModel
    : modelList.models[0]?.id;
  if (!preferred) return null;

  return { providerId, model: preferred };
}

function writeSentinelAtomic(sentinelPath: string, stateDir: string, record: WelcomeSentinelRecord): void {
  mkdirSync(stateDir, { recursive: true });
  const tmpPath = `${sentinelPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, sentinelPath);
}

/**
 * One-time bootstrap of the default `Welcome` conversation on genuinely fresh installations.
 * Non-blocking and fail-soft: never crashes daemon startup or overwrites existing sessions.
 */
export async function maybeBootstrapWelcomeSession(
  deps?: WelcomeBootstrapDeps,
): Promise<WelcomeBootstrapResult> {
  const env = deps?.env ?? process.env;
  if (env.IMCODES_SKIP_WELCOME_SESSION === '1') {
    return { status: 'skipped_opt_out' };
  }
  if (!deps && (env.VITEST || env.NODE_ENV === 'test')) {
    return { status: 'skipped_opt_out' };
  }

  const stateDir = deps?.stateDir ?? imcodesStateDir(env);
  const sentinelPath = join(stateDir, WELCOME_SENTINEL_FILENAME);

  const existingFlight = singleFlightBySentinel.get(sentinelPath);
  if (existingFlight) {
    return await existingFlight;
  }

  const task = runBootstrap(stateDir, sentinelPath, deps);
  singleFlightBySentinel.set(sentinelPath, task);
  try {
    return await task;
  } finally {
    if (singleFlightBySentinel.get(sentinelPath) === task) {
      singleFlightBySentinel.delete(sentinelPath);
    }
  }
}

async function runBootstrap(
  stateDir: string,
  sentinelPath: string,
  deps?: WelcomeBootstrapDeps,
): Promise<WelcomeBootstrapResult> {
  const now = deps?.now ?? (() => Date.now());
  const readSessions = deps?.listSessions ?? (() => listSessions());

  if (existsSync(sentinelPath)) {
    return { status: 'already_bootstrapped' };
  }

  if (readSessions().length > 0) {
    writeSentinelAtomic(sentinelPath, stateDir, { status: 'skipped_existing_sessions', at: now() });
    return { status: 'skipped_existing_sessions' };
  }

  const hasWorkerCreds = deps?.hasWorkerCreds ?? false;
  if (hasWorkerCreds) {
    const outcome = deps?.workerSyncOutcome;
    const isCleanZeroSnapshot = outcome?.status === 'applied'
      && (outcome.remoteSessionCount ?? 0) === 0
      && (outcome.remoteSubSessionCount ?? 0) === 0;
    if (!isCleanZeroSnapshot) {
      // Do NOT write sentinel yet — wait until a subsequent worker sync succeeds.
      return { status: 'deferred_worker_sync' };
    }
  }

  let installedAgents: Partial<AgentAvailabilityMap>;
  try {
    installedAgents = deps?.detectInstalledAgents
      ? await deps.detectInstalledAgents()
      : (await detectInstalledAgentsWithMetadata({ forceRefresh: true })).agents;
  } catch (err) {
    logger.warn({ err }, 'welcome bootstrap: failed to detect installed agents');
    return { status: 'no_available_sdk' };
  }

  const connect = deps?.ensureProviderConnected ?? ((id: string, cfg: ProviderConfig) => ensureProviderConnected(id, cfg));
  const timeoutMs = deps?.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  let selected: WelcomeSdkProbeSelection | null = null;
  for (const providerId of WELCOME_SDK_PROBE_ORDER) {
    selected = await probeWelcomeSdkCandidate(providerId, {
      installedAgents,
      ensureProviderConnected: connect,
      timeoutMs,
    });
    if (selected) break;
  }

  if (!selected) {
    selected = await probeWelcomeSdkCandidate(WELCOME_FALLBACK_PROVIDER_ID, {
      installedAgents,
      ensureProviderConnected: connect,
      timeoutMs,
    });
  }

  if (!selected) {
    logger.info('welcome bootstrap: no installed and authenticated SDK or OpenCode fallback available; skipping');
    return { status: 'no_available_sdk' };
  }

  // Re-check guards after asynchronous SDK probing in case sessions arrived mid-probe.
  if (existsSync(sentinelPath)) {
    return { status: 'already_bootstrapped' };
  }
  if (readSessions().length > 0) {
    writeSentinelAtomic(sentinelPath, stateDir, { status: 'skipped_existing_sessions', at: now() });
    return { status: 'skipped_existing_sessions' };
  }

  const projectDir = join(stateDir, 'projects', WELCOME_PROJECT_NAME);
  await mkdir(projectDir, { recursive: true });

  const launch = deps?.launchSession ?? ((opts) => launchTransportSession(opts));
  await launch({
    name: WELCOME_SESSION_NAME,
    projectName: WELCOME_PROJECT_NAME,
    role: 'brain',
    agentType: selected.providerId,
    projectDir,
    fresh: true,
    ...(isClaudeCodeSdkAgentType(selected.providerId) ? { ccSessionId: randomUUID() } : {}),
    label: WELCOME_SESSION_LABEL,
    requestedModel: selected.model,
  });

  const fallbackUsed = selected.providerId === WELCOME_FALLBACK_PROVIDER_ID;
  writeSentinelAtomic(sentinelPath, stateDir, {
    status: 'created',
    sessionName: WELCOME_SESSION_NAME,
    agentType: selected.providerId,
    model: selected.model,
    fallbackUsed,
    at: now(),
  });

  if (fallbackUsed) {
    const noticeText = formatDaemonUserNoticeEnglish(DAEMON_USER_NOTICE_CODE.WELCOME_OPENCODE_FREE_MODEL, {
      model: selected.model,
    });
    const noticePayload = {
      ...attachDaemonUserNotice(
        DAEMON_USER_NOTICE_CODE.WELCOME_OPENCODE_FREE_MODEL,
        noticeText,
        { model: selected.model },
      ),
      streaming: false,
      memoryExcluded: true,
    };
    if (deps?.emitTimelineNotice) {
      deps.emitTimelineNotice(WELCOME_SESSION_NAME, noticePayload);
    } else {
      timelineEmitter.emit(
        WELCOME_SESSION_NAME,
        'assistant.text',
        noticePayload,
        { source: 'daemon', confidence: 'high' },
      );
    }
  }

  await deps?.onSessionCreated?.();
  logger.info(
    { sessionName: WELCOME_SESSION_NAME, agentType: selected.providerId, model: selected.model, fallbackUsed },
    'welcome bootstrap: created default Welcome session',
  );

  return {
    status: 'created',
    sessionName: WELCOME_SESSION_NAME,
    agentType: selected.providerId,
    model: selected.model,
    fallbackUsed,
  };
}
