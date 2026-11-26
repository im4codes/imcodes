import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAEMON_USER_NOTICE_CODE } from '../../shared/daemon-user-notices.js';
import {
  WELCOME_FALLBACK_PROVIDER_ID,
  WELCOME_PROJECT_NAME,
  WELCOME_SDK_PROBE_ORDER,
  WELCOME_SENTINEL_FILENAME,
  WELCOME_SESSION_LABEL,
  WELCOME_SESSION_NAME,
  maybeBootstrapWelcomeSession,
  probeWelcomeSdkCandidate,
  selectOpenCodeFreeModel,
} from '../../src/daemon/welcome-session-bootstrap.js';

const tempDirs: string[] = [];

function makeStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'welcome-bootstrap-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('welcome-session-bootstrap', () => {
  it('defines WELCOME_SDK_PROBE_ORDER in exact New Session dialog transport SDK order (excluding OpenCode fallback and OpenClaw)', () => {
    expect([...WELCOME_SDK_PROBE_ORDER]).toEqual([
      'agy-sdk',
      'codex-sdk',
      'claude-code-sdk',
      'qoder-sdk',
      'copilot-sdk',
      'cursor-headless',
      'grok-sdk',
      'kimi-sdk',
      'muse-code-sdk',
      'hermes-acp',
      'deepseek-harness',
      'pi',
      'codebuddy-cn',
      'codebuddy-international',
    ]);
    expect(WELCOME_SDK_PROBE_ORDER).not.toContain(WELCOME_FALLBACK_PROVIDER_ID);
    expect(WELCOME_SDK_PROBE_ORDER).not.toContain('openclaw');
  });

  describe('selectOpenCodeFreeModel', () => {
    it('avoids geo-blocked/deprecated models (beam-free, inkling-2-small-free, longcat-2.5-free) and follows reliable free priority', () => {
      expect(selectOpenCodeFreeModel({
        isAuthenticated: false,
        models: [{ id: 'opencode/gpt-5-nano-free', name: 'Free' }],
      })).toBeNull();

      expect(selectOpenCodeFreeModel({
        isAuthenticated: true,
        models: [
          { id: 'anthropic/claude-sonnet-4-5', name: 'Claude' },
          { id: 'openai/gpt-5', name: 'GPT-5' },
        ],
        defaultModel: 'anthropic/claude-sonnet-4-5',
      })).toBeNull();

      // OpenCode v1.19.6 real-device model list: never pick beam-free when big-pickle or deepseek-v4.1-flash-free exists.
      expect(selectOpenCodeFreeModel({
        isAuthenticated: true,
        models: [
          { id: 'opencode/beam-free', name: 'Beam Free' },
          { id: 'opencode/inkling-2-small-free', name: 'Inkling' },
          { id: 'opencode/longcat-2.5-free', name: 'Longcat' },
          { id: 'opencode/glm-5.3-flash-free', name: 'GLM Flash Free' },
          { id: 'opencode/deepseek-v4.1-flash-free', name: 'DeepSeek v4.1 Flash Free' },
          { id: 'opencode/big-pickle', name: 'Big Pickle' },
        ],
        defaultModel: 'opencode/beam-free',
      })).toBe('opencode/big-pickle');

      expect(selectOpenCodeFreeModel({
        isAuthenticated: true,
        models: [
          { id: 'opencode/beam-free', name: 'Beam Free' },
          { id: 'opencode/glm-5.3-flash-free', name: 'GLM Flash Free' },
          { id: 'opencode/deepseek-v4.1-flash-free', name: 'DeepSeek v4.1 Flash Free' },
        ],
      })).toBe('opencode/deepseek-v4.1-flash-free');

      expect(selectOpenCodeFreeModel({
        isAuthenticated: true,
        models: [
          { id: 'opencode/beam-free', name: 'Beam Free' },
          { id: 'opencode/nemotron-3.5-lightning-free', name: 'Nemotron Free' },
          { id: 'opencode/flint-40b-free', name: 'Flint Free' },
        ],
      })).toBe('opencode/nemotron-3.5-lightning-free');

      expect(selectOpenCodeFreeModel({
        isAuthenticated: true,
        models: [
          { id: 'opencode/beam-free', name: 'Beam Free' },
          { id: 'opencode/mimo-v2.6-flash-free', name: 'MiMo Free' },
          { id: 'opencode/iceman-free', name: 'Iceman Free' },
        ],
      })).toBe('opencode/mimo-v2.6-flash-free');

      // Confirmed reliable opencode/ defaultModel wins when eligible.
      expect(selectOpenCodeFreeModel({
        isAuthenticated: true,
        models: [
          { id: 'opencode/big-pickle', name: 'Big Pickle' },
          { id: 'opencode/deepseek-v4.1-flash-free', name: 'DeepSeek v4.1 Flash Free' },
        ],
        defaultModel: 'opencode/deepseek-v4.1-flash-free',
      })).toBe('opencode/deepseek-v4.1-flash-free');

      expect(selectOpenCodeFreeModel({
        isAuthenticated: true,
        models: [{ id: 'opencode/other-zen-model', name: 'Zen' }],
      })).toBe('opencode/other-zen-model');
    });
  });

  it('keeps welcome_opencode_free_model copy strictly single-line and low-key across all 7 locales', () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'ru']) {
      const json = JSON.parse(
        readFileSync(join(process.cwd(), 'web', 'src', 'i18n', 'locales', `${locale}.json`), 'utf8'),
      ) as { chat?: { daemon_notice?: Record<string, string> } };
      const msg = json.chat?.daemon_notice?.welcome_opencode_free_model;
      expect(typeof msg).toBe('string');
      expect(msg).toContain('{{model}}');
      expect(msg).not.toMatch(/[\r\n]/);
      expect(msg).not.toMatch(/OpenCode|Anomaly|BYOK/i);
    }
  });

  it('selects the highest-priority authenticated SDK first without connecting lower-priority SDKs or emitting OpenCode notice', async () => {
    const stateDir = makeStateDir();
    const connectCalls: string[] = [];
    const launchSession = vi.fn(async () => {});
    const emitTimelineNotice = vi.fn();
    const onSessionCreated = vi.fn(async () => {});

    const result = await maybeBootstrapWelcomeSession({
      stateDir,
      env: {},
      now: () => 1_700_000_000_000,
      listSessions: () => [],
      detectInstalledAgents: async () => ({
        'agy-sdk': { installed: true, authenticated: true },
        'codex-sdk': { installed: true, authenticated: true },
        'opencode-sdk': { installed: true, authenticated: true },
      }),
      ensureProviderConnected: async (id) => {
        connectCalls.push(id);
        return {
          listModels: async () => ({
            isAuthenticated: true,
            defaultModel: 'claude-opus-4-6',
            models: [{ id: 'claude-opus-4-6', name: 'Opus 4.6' }],
          }),
        };
      },
      launchSession,
      emitTimelineNotice,
      onSessionCreated,
    });

    expect(result).toEqual({
      status: 'created',
      sessionName: WELCOME_SESSION_NAME,
      agentType: 'agy-sdk',
      model: 'claude-opus-4-6',
      fallbackUsed: false,
    });
    expect(connectCalls).toEqual(['agy-sdk']);
    expect(launchSession).toHaveBeenCalledTimes(1);
    expect(launchSession).toHaveBeenCalledWith({
      name: WELCOME_SESSION_NAME,
      projectName: WELCOME_PROJECT_NAME,
      role: 'brain',
      agentType: 'agy-sdk',
      projectDir: join(stateDir, 'projects', WELCOME_PROJECT_NAME),
      fresh: true,
      label: WELCOME_SESSION_LABEL,
      requestedModel: 'claude-opus-4-6',
    });
    expect(existsSync(join(stateDir, 'projects', WELCOME_PROJECT_NAME))).toBe(true);
    expect(emitTimelineNotice).not.toHaveBeenCalled();
    expect(onSessionCreated).toHaveBeenCalledTimes(1);

    const sentinel = JSON.parse(readFileSync(join(stateDir, WELCOME_SENTINEL_FILENAME), 'utf8'));
    expect(sentinel).toMatchObject({
      status: 'created',
      sessionName: WELCOME_SESSION_NAME,
      agentType: 'agy-sdk',
      model: 'claude-opus-4-6',
      fallbackUsed: false,
      at: 1_700_000_000_000,
    });
  });

  it('skips uninstalled and unauthenticated SDKs in priority order and supplies ccSessionId for claude-code-sdk', async () => {
    const stateDir = makeStateDir();
    const connectCalls: string[] = [];
    const launchSession = vi.fn(async () => {});

    const result = await maybeBootstrapWelcomeSession({
      stateDir,
      env: {},
      listSessions: () => [],
      detectInstalledAgents: async () => ({
        'agy-sdk': { installed: false },
        'codex-sdk': { installed: true, authenticated: false },
        'claude-code-sdk': { installed: true, authenticated: true },
        'opencode-sdk': { installed: true, authenticated: true },
      }),
      ensureProviderConnected: async (id) => {
        connectCalls.push(id);
        if (id === 'codex-sdk') {
          return {
            listModels: async () => ({
              isAuthenticated: false,
              models: [],
            }),
          };
        }
        return {
          listModels: async () => ({
            isAuthenticated: true,
            defaultModel: 'claude-sonnet-4-6',
            models: [{ id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' }],
          }),
        };
      },
      launchSession,
    });

    expect(result).toEqual({
      status: 'created',
      sessionName: WELCOME_SESSION_NAME,
      agentType: 'claude-code-sdk',
      model: 'claude-sonnet-4-6',
      fallbackUsed: false,
    });
    expect(connectCalls).toEqual(['codex-sdk', 'claude-code-sdk']);
    expect(launchSession).toHaveBeenCalledWith(
      expect.objectContaining({
        name: WELCOME_SESSION_NAME,
        agentType: 'claude-code-sdk',
        requestedModel: 'claude-sonnet-4-6',
        ccSessionId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      }),
    );
  });

  it('falls back to OpenCode keyless free model and emits one privacy/provider daemon notice', async () => {
    const stateDir = makeStateDir();
    const launchSession = vi.fn(async () => {});
    const emitTimelineNotice = vi.fn();
    const onSessionCreated = vi.fn(async () => {});

    const result = await maybeBootstrapWelcomeSession({
      stateDir,
      env: {},
      listSessions: () => [],
      detectInstalledAgents: async () => ({
        'agy-sdk': { installed: false },
        'codex-sdk': { installed: true },
        'opencode-sdk': { installed: true },
      }),
      ensureProviderConnected: async (id) => {
        if (id === 'codex-sdk') {
          return {
            listModels: async () => ({ isAuthenticated: false, models: [{ id: 'gpt-5', name: 'GPT-5' }] }),
          };
        }
        if (id === 'opencode-sdk') {
          return {
            listModels: async () => ({
              isAuthenticated: true,
              defaultModel: 'anthropic/claude-sonnet-4-5',
              models: [
                { id: 'anthropic/claude-sonnet-4-5', name: 'Claude' },
                { id: 'opencode/beam-free', name: 'Beam Free' },
                { id: 'opencode/big-pickle', name: 'Big Pickle' },
                { id: 'opencode/deepseek-v4.1-flash-free', name: 'DeepSeek v4.1 Flash Free' },
              ],
            }),
          };
        }
        throw new Error(`unexpected provider ${id}`);
      },
      launchSession,
      emitTimelineNotice,
      onSessionCreated,
    });

    expect(result).toEqual({
      status: 'created',
      sessionName: WELCOME_SESSION_NAME,
      agentType: 'opencode-sdk',
      model: 'opencode/big-pickle',
      fallbackUsed: true,
    });
    expect(launchSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: 'opencode-sdk',
        requestedModel: 'opencode/big-pickle',
      }),
    );
    expect(emitTimelineNotice).toHaveBeenCalledTimes(1);
    expect(emitTimelineNotice).toHaveBeenCalledWith(
      WELCOME_SESSION_NAME,
      expect.objectContaining({
        streaming: false,
        memoryExcluded: true,
        noticeCode: DAEMON_USER_NOTICE_CODE.WELCOME_OPENCODE_FREE_MODEL,
        noticeParams: { model: 'opencode/big-pickle' },
        text: 'Using free starter model (opencode/big-pickle, third-party service; inputs may be used to improve models) — avoid sensitive code, or switch to your own SDK/model below anytime.',
      }),
    );
    expect(onSessionCreated).toHaveBeenCalledTimes(1);
  });

  it('does not recreate Welcome on subsequent restarts even if Welcome session was deleted', async () => {
    const stateDir = makeStateDir();
    let sessions: Array<{ name: string }> = [];
    const launchSession = vi.fn(async () => {
      sessions.push({ name: WELCOME_SESSION_NAME });
    });

    const first = await maybeBootstrapWelcomeSession({
      stateDir,
      env: {},
      listSessions: () => sessions,
      detectInstalledAgents: async () => ({ 'agy-sdk': { installed: true } }),
      ensureProviderConnected: async () => ({
        listModels: async () => ({
          isAuthenticated: true,
          defaultModel: 'gemini-2.5-pro',
          models: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
        }),
      }),
      launchSession,
    });
    expect(first.status).toBe('created');

    // Simulate user deleting the Welcome conversation, then daemon restarting.
    sessions = [];
    const detectAgain = vi.fn(async () => ({ 'agy-sdk': { installed: true } }));
    const second = await maybeBootstrapWelcomeSession({
      stateDir,
      env: {},
      listSessions: () => sessions,
      detectInstalledAgents: detectAgain,
      launchSession,
    });

    expect(second).toEqual({ status: 'already_bootstrapped' });
    expect(detectAgain).not.toHaveBeenCalled();
    expect(launchSession).toHaveBeenCalledTimes(1);
  });

  it('writes skipped sentinel and never creates Welcome when existing sessions are already present', async () => {
    const stateDir = makeStateDir();
    const detectInstalledAgents = vi.fn(async () => ({ 'agy-sdk': { installed: true } }));
    const launchSession = vi.fn(async () => {});

    const result = await maybeBootstrapWelcomeSession({
      stateDir,
      env: {},
      listSessions: () => [{ name: 'deck_existing_brain' }],
      detectInstalledAgents,
      launchSession,
    });

    expect(result).toEqual({ status: 'skipped_existing_sessions' });
    expect(detectInstalledAgents).not.toHaveBeenCalled();
    expect(launchSession).not.toHaveBeenCalled();

    const sentinel = JSON.parse(readFileSync(join(stateDir, WELCOME_SENTINEL_FILENAME), 'utf8'));
    expect(sentinel.status).toBe('skipped_existing_sessions');
  });

  it('defers while worker sync has not yet returned a clean 0-session snapshot, then bootstraps once clean sync applies', async () => {
    const stateDir = makeStateDir();
    const launchSession = vi.fn(async () => {});

    // Startup before worker sync or after retryable failure must defer WITHOUT writing sentinel.
    const deferred = await maybeBootstrapWelcomeSession({
      stateDir,
      env: {},
      hasWorkerCreds: true,
      workerSyncOutcome: { status: 'retryable' },
      listSessions: () => [],
      launchSession,
    });
    expect(deferred).toEqual({ status: 'deferred_worker_sync' });
    expect(existsSync(join(stateDir, WELCOME_SENTINEL_FILENAME))).toBe(false);

    // Worker sync applied with >0 remote sub-sessions must also defer (re-checks/never assumes empty).
    const deferredRemoteSub = await maybeBootstrapWelcomeSession({
      stateDir,
      env: {},
      hasWorkerCreds: true,
      workerSyncOutcome: { status: 'applied', remoteSessionCount: 0, remoteSubSessionCount: 2 },
      listSessions: () => [],
      launchSession,
    });
    expect(deferredRemoteSub).toEqual({ status: 'deferred_worker_sync' });
    expect(existsSync(join(stateDir, WELCOME_SENTINEL_FILENAME))).toBe(false);

    // Clean 0-session worker sync triggers Welcome creation.
    const created = await maybeBootstrapWelcomeSession({
      stateDir,
      env: {},
      hasWorkerCreds: true,
      workerSyncOutcome: { status: 'applied', remoteSessionCount: 0, remoteSubSessionCount: 0 },
      listSessions: () => [],
      detectInstalledAgents: async () => ({ 'codex-sdk': { installed: true } }),
      ensureProviderConnected: async () => ({
        listModels: async () => ({
          isAuthenticated: true,
          defaultModel: 'gpt-5.4',
          models: [{ id: 'gpt-5.4', name: 'GPT-5.4' }],
        }),
      }),
      launchSession,
    });
    expect(created).toMatchObject({ status: 'created', agentType: 'codex-sdk', model: 'gpt-5.4' });
  });

  it('handles hung/throwing probes via bounded timeout and returns no_available_sdk cleanly when nothing is usable', async () => {
    const stateDir = makeStateDir();
    const launchSession = vi.fn(async () => {});

    const hungProbe = await probeWelcomeSdkCandidate('agy-sdk', {
      installedAgents: { 'agy-sdk': { installed: true } },
      timeoutMs: 25,
      ensureProviderConnected: async () => ({
        listModels: () => new Promise(() => {}),
      }),
    });
    expect(hungProbe).toBeNull();

    const result = await maybeBootstrapWelcomeSession({
      stateDir,
      env: {},
      probeTimeoutMs: 25,
      listSessions: () => [],
      detectInstalledAgents: async () => ({
        'agy-sdk': { installed: true },
        'opencode-sdk': { installed: false },
      }),
      ensureProviderConnected: async () => {
        throw new Error('connect exploded');
      },
      launchSession,
    });

    expect(result).toEqual({ status: 'no_available_sdk' });
    expect(launchSession).not.toHaveBeenCalled();
    expect(existsSync(join(stateDir, WELCOME_SENTINEL_FILENAME))).toBe(false);
  });

  it('honors IMCODES_SKIP_WELCOME_SESSION=1 opt-out and guards concurrent calls + mid-probe session arrival', async () => {
    const stateDir = makeStateDir();
    const optOut = await maybeBootstrapWelcomeSession({
      stateDir,
      env: { IMCODES_SKIP_WELCOME_SESSION: '1' },
      listSessions: () => [],
    });
    expect(optOut).toEqual({ status: 'skipped_opt_out' });

    // Concurrent calls share single-flight execution; mid-probe session arrival aborts creation.
    let sessions: Array<{ name: string }> = [];
    let resolveProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => { resolveProbe = resolve; });
    const ensureConnected = vi.fn(async () => {
      await probeGate;
      return {
        listModels: async () => ({
          isAuthenticated: true,
          defaultModel: 'gemini-2.5-pro',
          models: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
        }),
      };
    });
    const launchSession = vi.fn(async () => {});

    const p1 = maybeBootstrapWelcomeSession({
      stateDir,
      env: {},
      listSessions: () => sessions,
      detectInstalledAgents: async () => ({ 'agy-sdk': { installed: true } }),
      ensureProviderConnected: ensureConnected,
      launchSession,
    });
    const p2 = maybeBootstrapWelcomeSession({
      stateDir,
      env: {},
      listSessions: () => sessions,
      detectInstalledAgents: async () => ({ 'agy-sdk': { installed: true } }),
      ensureProviderConnected: ensureConnected,
      launchSession,
    });

    await new Promise((r) => setTimeout(r, 20));
    sessions = [{ name: 'deck_user_created_mid_probe' }];
    resolveProbe();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(ensureConnected).toHaveBeenCalledTimes(1);
    expect(r1).toEqual({ status: 'skipped_existing_sessions' });
    expect(r2).toEqual({ status: 'skipped_existing_sessions' });
    expect(launchSession).not.toHaveBeenCalled();
  });
});
