// Provider registry — manages transport provider lifecycle
// For now only OpenClaw, but designed for future providers

import type { TransportProvider, ProviderConfig } from './transport-provider.js';
import { wireProviderToRelay, broadcastProviderStatus } from '../daemon/transport-relay.js';
import logger from '../util/logger.js';
import { CODEBUDDY_PROVIDER_IDS } from '../../shared/codebuddy.js';
import { HERMES_AGENT_PROVIDER_ID } from '../../shared/hermes-agent.js';
import { AGY_SDK_PROVIDER_ID } from '../../shared/agy-agent.js';
import { clearTransportRestoreBackoffForProvider } from './transport-restore-backoff.js';
import { CLAUDE_CODE_CLI_SDK_AGENT_TYPE } from '../../shared/agent-types.js';
import {
  clearProviderRetiring,
  isProviderRetiring,
  markProviderRetiring,
} from './provider-registry-state.js';

const providers = new Map<string, TransportProvider>();
const providerOps = new Map<string, Promise<void>>();
interface PendingEnsureEntry {
  promise: Promise<TransportProvider>;
  waiters: number;
}
const pendingEnsureConnects = new Map<string, PendingEnsureEntry>();

function runSerialized<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = providerOps.get(id) ?? Promise.resolve();
  const task = prev.catch(() => {}).then(fn);
  const tail = task.then(() => undefined, () => undefined).finally(() => {
    if (providerOps.get(id) === tail) {
      providerOps.delete(id);
    }
  });
  providerOps.set(id, tail);
  return task;
}

/** ServerLink reference for sync pipeline — set by daemon startup. */
let _serverLink: { send(msg: object): void } | null = null;
export function setProviderRegistryServerLink(link: { send(msg: object): void }): void { _serverLink = link; }

export function getProvider(id: string): TransportProvider | undefined {
  return providers.get(id);
}

/**
 * Returns true iff `provider` is still the live, non-retiring instance registered for `id`.
 * `disconnectProviderUnlocked` marks the active instance retiring synchronously before awaiting
 * `provider.disconnect()` so concurrent launches and syncs cannot publish against a disconnecting gateway.
 */
export function isCurrentProvider(id: string, provider: TransportProvider): boolean {
  return providers.get(id) === provider && !isProviderRetiring(provider);
}

export function getAllProviders(): TransportProvider[] {
  return [...providers.values()];
}

export async function ensureProviderConnected(
  id: string,
  config: ProviderConfig = {},
  options?: { signal?: AbortSignal },
): Promise<TransportProvider> {
  if (!providerOps.has(id) && providers.has(id)) {
    return providers.get(id)!;
  }
  const signal = options?.signal;
  if (signal?.aborted) {
    throw new Error(`Provider ensure aborted: ${id}`);
  }
  let entry = pendingEnsureConnects.get(id);
  if (!entry) {
    const created: PendingEnsureEntry = { promise: null!, waiters: 0 };
    const pending = runSerialized(id, async () => {
      if (created.waiters <= 0) {
        if (pendingEnsureConnects.get(id) === created) {
          pendingEnsureConnects.delete(id);
        }
        throw new Error(`Provider ensure superseded before connect: ${id}`);
      }
      const current = providers.get(id);
      if (current) return current;
      await connectProviderUnlocked(id, config);
      const connected = providers.get(id);
      if (!connected) throw new Error(`Provider failed to connect: ${id}`);
      return connected;
    }).finally(() => {
      if (pendingEnsureConnects.get(id) === created) {
        pendingEnsureConnects.delete(id);
      }
    });
    created.promise = pending;
    // Prevent unhandled rejection when all aborted callers leave before queued execution.
    pending.catch(() => {});
    pendingEnsureConnects.set(id, created);
    entry = created;
  }

  const activeEntry = entry;
  activeEntry.waiters += 1;
  if (!signal) {
    try {
      return await activeEntry.promise;
    } finally {
      activeEntry.waiters = Math.max(0, activeEntry.waiters - 1);
    }
  }

  return await new Promise<TransportProvider>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      activeEntry.waiters = Math.max(0, activeEntry.waiters - 1);
      if (activeEntry.waiters === 0 && pendingEnsureConnects.get(id) === activeEntry) {
        pendingEnsureConnects.delete(id);
      }
      reject(new Error(`Provider ensure aborted: ${id}`));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    activeEntry.promise.then(
      (provider) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        activeEntry.waiters = Math.max(0, activeEntry.waiters - 1);
        resolve(provider);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        activeEntry.waiters = Math.max(0, activeEntry.waiters - 1);
        reject(err);
      },
    );
  });
}

async function connectProviderUnlocked(id: string, config: ProviderConfig): Promise<void> {
  // If already connected, disconnect first
  if (providers.has(id)) {
    await disconnectProviderUnlocked(id);
  }

  const provider = await createProvider(id, config);
  try {
    await provider.connect(config);
  } catch (err) {
    await provider.disconnect().catch(() => {});
    throw err;
  }
  clearProviderRetiring(provider);
  providers.set(id, provider);
  // A reconnected provider may now be able to do what it could not before.
  clearTransportRestoreBackoffForProvider(id);
  wireProviderToRelay(provider);

  // Materialize OC sessions before broadcasting status (sessions appear before catalog)
  if (id === 'openclaw' && !_serverLink) {
    logger.warn('connectProvider: _serverLink is null — oc-sync skipped (WS not connected yet?)');
  }
  if (id === 'openclaw' && _serverLink) {
    try {
      const { syncOcSessions } = await import('../daemon/oc-session-sync.js');
      await syncOcSessions(_serverLink as any, { connectTimeProvider: provider });
    } catch (err) {
      logger.warn({ err }, 'OC session auto-sync failed — continuing without materialization');
    }
  }

  broadcastProviderStatus(id, true);
  logger.info({ provider: id }, 'Provider connected');

  // Persist config so autoReconnectProviders can restore on daemon restart
  if (id === 'openclaw' && config.url && config.token) {
    import('./openclaw-config.js')
      .then(({ saveConfig }) => saveConfig({ url: config.url!, token: config.token! }))
      .catch((e) => logger.warn({ err: e }, 'Failed to persist openclaw config'));
  }
}

export function connectProvider(id: string, config: ProviderConfig): Promise<void> {
  // Invalidate any older ensureProviderConnected coalescer so subsequent ensure callers
  // wait behind this explicit reconnect rather than resolving with a superseded instance.
  pendingEnsureConnects.delete(id);
  return runSerialized(id, () => connectProviderUnlocked(id, config));
}

async function disconnectProviderUnlocked(id: string): Promise<void> {
  const provider = providers.get(id);
  if (!provider) return;
  markProviderRetiring(provider);
  try {
    await provider.disconnect();
  } finally {
    if (providers.get(id) === provider) {
      providers.delete(id);
    }
    broadcastProviderStatus(id, false);
    logger.info({ provider: id }, 'Provider disconnected');
  }
}

export function disconnectProvider(id: string): Promise<void> {
  // Invalidate any older ensureProviderConnected coalescer so subsequent ensure callers
  // see the post-disconnect boundary rather than reusing a about-to-be-disconnected handle.
  pendingEnsureConnects.delete(id);
  return runSerialized(id, () => disconnectProviderUnlocked(id));
}

export async function disconnectAll(): Promise<void> {
  const ids = new Set([...providers.keys(), ...providerOps.keys()]);
  await Promise.all([...ids].map((id) => disconnectProvider(id)));
}

async function createProvider(id: string, config: ProviderConfig): Promise<TransportProvider> {
  switch (id) {
    case 'openclaw': {
      const { OpenClawProvider } = await import('./providers/openclaw.js');
      return new OpenClawProvider();
    }
    case 'qwen': {
      const { QwenProvider } = await import('./providers/qwen.js');
      return new QwenProvider();
    }
    case 'kimi-sdk': {
      const { KimiV2Provider } = await import('./providers/kimi-v2.js');
      return new KimiV2Provider();
    }
    case HERMES_AGENT_PROVIDER_ID: {
      const { HermesAcpProvider } = await import('./providers/hermes-acp.js');
      return new HermesAcpProvider();
    }
    case 'grok-sdk': {
      const { GrokSdkProvider } = await import('./providers/grok-sdk.js');
      return new GrokSdkProvider();
    }
    case AGY_SDK_PROVIDER_ID: {
      const { createAgyProvider } = await import('./providers/agy-acp.js');
      return createAgyProvider(config);
    }
    case 'claude-code-sdk': {
      const { ClaudeCodeSdkProvider } = await import('./providers/claude-code-sdk.js');
      return new ClaudeCodeSdkProvider();
    }
    case CLAUDE_CODE_CLI_SDK_AGENT_TYPE: {
      const { ClaudeCodeCliSdkProvider } = await import('./providers/claude-code-cli-sdk.js');
      return new ClaudeCodeCliSdkProvider();
    }
    case 'codex-sdk': {
      const { CodexSdkProvider } = await import('./providers/codex-sdk.js');
      return new CodexSdkProvider();
    }
    case 'qoder-sdk': {
      const { QoderSdkProvider } = await import('./providers/qoder-sdk.js');
      return new QoderSdkProvider();
    }
    case 'cursor-headless': {
      const { CursorHeadlessProvider } = await import('./providers/cursor-headless.js');
      return new CursorHeadlessProvider();
    }
    case 'copilot-sdk': {
      const { CopilotSdkProvider } = await import('./providers/copilot-sdk.js');
      return new CopilotSdkProvider();
    }
    case 'opencode-sdk': {
      const { OpenCodeSdkProvider } = await import('./providers/opencode-sdk.js');
      return new OpenCodeSdkProvider();
    }
    case 'deepseek-harness': {
      const { DeepseekHarnessProvider } = await import('./providers/deepseek-harness.js');
      return new DeepseekHarnessProvider();
    }
    case 'pi': {
      const { PiProvider } = await import('./providers/pi.js');
      return new PiProvider();
    }
    case 'muse-code-sdk': {
      const { MuseCodeSdkProvider } = await import('./providers/muse-code-sdk.js');
      return new MuseCodeSdkProvider();
    }
    case CODEBUDDY_PROVIDER_IDS.CHINA: {
      const { CodeBuddyChinaProvider } = await import('./providers/codebuddy.js');
      return new CodeBuddyChinaProvider();
    }
    case CODEBUDDY_PROVIDER_IDS.INTERNATIONAL: {
      const { CodeBuddyInternationalProvider } = await import('./providers/codebuddy.js');
      return new CodeBuddyInternationalProvider();
    }
    default:
      throw new Error(`Unknown provider: ${id}`);
  }
}
