import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAEMON_USER_NOTICE_CODE } from '../../shared/daemon-user-notices.js';
import { MuseCodeSdkProvider } from '../../src/agent/providers/muse-code-sdk.js';
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
  it('defines WELCOME_SDK_PROBE_ORDER in expected order (excluding OpenCode fallback and OpenClaw)', () => {
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
    it('rejects unauthenticated lists, non-opencode models, unconfirmed non-free opencode models, and never re-admits excluded IDs', () => {
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

      // Unconfirmed non-free OpenCode model or excluded geo-blocked/deprecated models MUST return null.
      for (const blockedOnlyId of [
        'opencode/claude-sonnet-4-6',
        'opencode/other-zen-model',
        'opencode/beam-free',
        'opencode/inkling-2-small-free',
        'opencode/longcat-2.5-free',
      ]) {
        expect(selectOpenCodeFreeModel({
          isAuthenticated: true,
          models: [{ id: blockedOnlyId, name: blockedOnlyId }],
          defaultModel: blockedOnlyId,
        }), `only ${blockedOnlyId}`).toBeNull();
      }

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
    });

    it('never creates Welcome or emits free notice when OpenCode only exposes excluded or unconfirmed non-free models', async () => {
      const stateDir = makeStateDir();
      const launchSession = vi.fn(async () => {});
      const emitTimelineNotice = vi.fn();

      const result = await maybeBootstrapWelcomeSession({
        stateDir,
        allowInTest: true,
        env: {},
        listSessions: () => [],
        detectInstalledAgents: async () => ({ 'opencode-sdk': { installed: true } }),
        ensureProviderConnected: async () => ({
          listModels: async () => ({
            isAuthenticated: true,
            defaultModel: 'opencode/claude-sonnet-4-6',
            models: [
              { id: 'opencode/claude-sonnet-4-6', name: 'Claude' },
              { id: 'opencode/beam-free', name: 'Beam Free' },
              { id: 'opencode/inkling-2-small-free', name: 'Inkling' },
              { id: 'opencode/longcat-2.5-free', name: 'Longcat' },
            ],
          }),
        }),
        launchSession,
        emitTimelineNotice,
      });

      expect(result).toEqual({ status: 'no_available_sdk' });
      expect(launchSession).not.toHaveBeenCalled();
      expect(emitTimelineNotice).not.toHaveBeenCalled();
      expect(existsSync(join(stateDir, WELCOME_SENTINEL_FILENAME))).toBe(false);
    });
  });

  it('rejects Muse static fallback catalog during Welcome probe and succeeds only with live model/list verification', async () => {
    const stateDir = makeStateDir();
    const unauthMuse = new MuseCodeSdkProvider();
    (unauthMuse as unknown as {
      spawned: { connection: { command: (method: string, params: unknown) => Promise<unknown> } };
    }).spawned = {
      connection: {
        command: async () => {
          throw new Error('not logged in');
        },
      },
    };

    // Regular model picker behavior preserved: listModels still returns static fallback + isAuthenticated: true,
    // tagged as static-fallback so Welcome probe rejects it.
    const museFallbackList = await unauthMuse.listModels(true);
    expect(museFallbackList.isAuthenticated).toBe(true);
    expect(museFallbackList.modelCatalogSource).toBe('static-fallback');

    const launchSession = vi.fn(async () => {});
    const emitTimelineNotice = vi.fn();
    const fallbackResult = await maybeBootstrapWelcomeSession({
      stateDir,
      allowInTest: true,
      env: {},
      listSessions: () => [],
      detectInstalledAgents: async () => ({
        'muse-code-sdk': { installed: true },
        'opencode-sdk': { installed: true },
      }),
      ensureProviderConnected: async (id) => {
        if (id === 'muse-code-sdk') return unauthMuse;
        if (id === 'opencode-sdk') {
          return {
            listModels: async () => ({
              isAuthenticated: true,
              models: [{ id: 'opencode/big-pickle', name: 'Big Pickle' }],
            }),
          };
        }
        throw new Error(`unexpected provider ${id}`);
      },
      launchSession,
      emitTimelineNotice,
    });

    expect(fallbackResult).toEqual({
      status: 'created',
      sessionName: WELCOME_SESSION_NAME,
      agentType: 'opencode-sdk',
      model: 'opencode/big-pickle',
      fallbackUsed: true,
    });
    expect(emitTimelineNotice).toHaveBeenCalledTimes(1);

    // Positive control: Muse with live model/list response IS accepted directly without falling back to OpenCode.
    const liveStateDir = makeStateDir();
    const liveMuse = new MuseCodeSdkProvider();
    (liveMuse as unknown as {
      spawned: { connection: { command: (method: string, params: unknown) => Promise<unknown> } };
    }).spawned = {
      connection: {
        command: async () => ({
          models: [{ id: 'muse-spark-1.3', name: 'Muse Spark 1.3' }],
        }),
      },
    };
    const openCodeConnect = vi.fn();
    const liveResult = await maybeBootstrapWelcomeSession({
      stateDir: liveStateDir,
      allowInTest: true,
      env: {},
      listSessions: () => [],
      detectInstalledAgents: async () => ({
        'muse-code-sdk': { installed: true },
        'opencode-sdk': { installed: true },
      }),
      ensureProviderConnected: async (id) => {
        if (id === 'muse-code-sdk') return liveMuse;
        openCodeConnect(id);
        throw new Error('should not reach opencode');
      },
      launchSession: vi.fn(async () => {}),
    });

    expect(liveResult).toEqual({
      status: 'created',
      sessionName: WELCOME_SESSION_NAME,
      agentType: 'muse-code-sdk',
      model: 'muse-spark-1.3',
      fallbackUsed: false,
    });
    expect(openCodeConnect).not.toHaveBeenCalled();

    // Generic static-fallback guard also rejects any other provider tagged static-fallback (e.g. agy-acp).
    const staticProbe = await probeWelcomeSdkCandidate('agy-sdk', {
      installedAgents: { 'agy-sdk': { installed: true } },
      ensureProviderConnected: async () => ({
        listModels: async () => ({
          isAuthenticated: true,
          modelCatalogSource: 'static-fallback',
          models: [{ id: 'claude-sonnet-4-6' }],
        }),
      }),
    });
    expect(staticProbe).toBeNull();
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
      expect(msg).toContain('OpenCode');
      expect(msg).toContain('https://opencode.ai');
      expect(msg).not.toMatch(/Anomaly|BYOK/i);
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
      allowInTest: true,
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
      allowInTest: true,
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
      allowInTest: true,
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
        text: 'Using free starter model (opencode/big-pickle, third-party service; inputs may be used to improve models) — avoid sensitive code; purchase OpenCode credits/plan at https://opencode.ai or switch to your own SDK/model below anytime.',
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
      allowInTest: true,
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
      allowInTest: true,
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
      allowInTest: true,
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

  it('persists skipped_existing_sessions sentinel when applied remote snapshot has nonzero main or sub-sessions even with empty local store', async () => {
    for (const remoteCounts of [
      { remoteSessionCount: 1, remoteSubSessionCount: 0 },
      { remoteSessionCount: 0, remoteSubSessionCount: 1 },
    ]) {
      const stateDir = makeStateDir();
      const detectInstalledAgents = vi.fn(async () => ({ 'agy-sdk': { installed: true } }));
      const launchSession = vi.fn(async () => {});

      // Empty local listSessions(), but remote applied snapshot proves existing history (e.g. stopped remote session or remote sub-session).
      const first = await maybeBootstrapWelcomeSession({
        stateDir,
        allowInTest: true,
        env: {},
        hasWorkerCreds: true,
        workerSyncOutcome: { status: 'applied', ...remoteCounts },
        listSessions: () => [],
        detectInstalledAgents,
        launchSession,
      });

      expect(first).toEqual({ status: 'skipped_existing_sessions' });
      expect(detectInstalledAgents).not.toHaveBeenCalled();
      expect(launchSession).not.toHaveBeenCalled();
      const sentinel = JSON.parse(readFileSync(join(stateDir, WELCOME_SENTINEL_FILENAME), 'utf8'));
      expect(sentinel.status).toBe('skipped_existing_sessions');

      // Even if remote history is deleted before the next restart and applied returns 0, sentinel blocks surprise Welcome creation.
      const second = await maybeBootstrapWelcomeSession({
        stateDir,
        allowInTest: true,
        env: {},
        hasWorkerCreds: true,
        workerSyncOutcome: { status: 'applied', remoteSessionCount: 0, remoteSubSessionCount: 0 },
        listSessions: () => [],
        detectInstalledAgents,
        launchSession,
      });
      expect(second).toEqual({ status: 'already_bootstrapped' });
      expect(detectInstalledAgents).not.toHaveBeenCalled();
      expect(launchSession).not.toHaveBeenCalled();
    }
  });

  it('defers while worker sync has not yet returned applied, then bootstraps once clean 0-session sync applies', async () => {
    const stateDir = makeStateDir();
    const launchSession = vi.fn(async () => {});

    // Startup before worker sync or after retryable failure must defer WITHOUT writing sentinel.
    const deferred = await maybeBootstrapWelcomeSession({
      stateDir,
      allowInTest: true,
      env: {},
      hasWorkerCreds: true,
      workerSyncOutcome: { status: 'retryable' },
      listSessions: () => [],
      launchSession,
    });
    expect(deferred).toEqual({ status: 'deferred_worker_sync' });
    expect(existsSync(join(stateDir, WELCOME_SENTINEL_FILENAME))).toBe(false);

    // Clean 0-session worker sync triggers Welcome creation.
    const created = await maybeBootstrapWelcomeSession({
      stateDir,
      allowInTest: true,
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
      allowInTest: true,
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

  it('skips in test mode by default (even when deps object is passed), honors IMCODES_SKIP_WELCOME_SESSION=1, and guards concurrent calls + mid-probe session arrival', async () => {
    const stateDir = makeStateDir();
    const detectInDefaultTestMode = vi.fn(async () => ({ 'agy-sdk': { installed: true } }));
    const launchInDefaultTestMode = vi.fn(async () => {});
    const defaultTestGuard = await maybeBootstrapWelcomeSession({
      stateDir,
      listSessions: () => [],
      detectInstalledAgents: detectInDefaultTestMode,
      launchSession: launchInDefaultTestMode,
    });
    expect(defaultTestGuard).toEqual({ status: 'skipped_opt_out' });
    expect(detectInDefaultTestMode).not.toHaveBeenCalled();
    expect(launchInDefaultTestMode).not.toHaveBeenCalled();

    const optOut = await maybeBootstrapWelcomeSession({
      stateDir,
      allowInTest: true,
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
      allowInTest: true,
      env: {},
      listSessions: () => sessions,
      detectInstalledAgents: async () => ({ 'agy-sdk': { installed: true } }),
      ensureProviderConnected: ensureConnected,
      launchSession,
    });
    const p2 = maybeBootstrapWelcomeSession({
      stateDir,
      allowInTest: true,
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
