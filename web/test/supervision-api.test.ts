/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK,
  DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL,
  SUPERVISION_USER_DEFAULT_PREF_KEY,
} from '@shared/supervision-config.js';
import { DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS } from '@shared/supervision-execution-pool.js';
import { CODEX_MODEL_IDS } from '../../src/shared/models/options.js';
import {
  fetchSupervisorDefaults,
  fetchSessionSupervisorDefaults,
  patchSession,
  patchSessionSupervision,
  patchSubSession,
  saveSessionSupervisorDefaults,
  saveSupervisorDefaults,
} from '../src/api.js';

/**
 * The pools a legacy backend+model preference migrates into.
 *
 * A preference written before execution pools existed carries only backend and
 * model, so the normalizer migrates it into a single-config primary pool and
 * marks it configured. Spelling that out here keeps the round-trip exact: the
 * browser must persist exactly what it normalized -- no field invented on the
 * way in, none dropped on the way out to the PUT body.
 */
function migratedPools(agentType: string, providerFamily: string, model: string) {
  return {
    state: 'configured',
    primaryDevelopmentPool: {
      configs: [{
        agentType,
        providerFamily,
        runtimeType: 'transport',
        model,
        capabilityId: `supervision-exec-v1:transport:${agentType}:${providerFamily}:${model}`,
      }],
      controls: { ...DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS.primary },
    },
    economyTaskPool: {
      configs: [],
      controls: { ...DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS.economy },
    },
  };
}

/** Asserted twice: as the resolved value AND as the persisted PUT payload. */
const EXPECTED_QWEN_DEFAULTS = {
  backend: 'qwen',
  model: 'qwen3-coder-plus',
  timeoutMs: 30_000,
  promptVersion: 'supervision_decision_v1',
  maxAutoContinueStreak: DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK,
  maxAutoContinueTotal: DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL,
  executionPools: migratedPools('qwen', 'qwen', 'qwen3-coder-plus'),
};

const fetchMock = vi.fn();

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

describe('supervision API helpers', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads supervisor defaults from the shared preference key', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      value: {
        backend: 'codex-sdk',
        model: CODEX_MODEL_IDS[0],
        timeoutMs: 20_000,
        promptVersion: 'custom_prompt_v1',
      },
    }));

    await expect(fetchSupervisorDefaults()).resolves.toEqual({
      backend: 'codex-sdk',
      model: CODEX_MODEL_IDS[0],
      timeoutMs: 30_000,
      promptVersion: 'custom_prompt_v1',
      maxAutoContinueStreak: DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK,
      maxAutoContinueTotal: DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL,
      executionPools: migratedPools('codex-sdk', 'codex', CODEX_MODEL_IDS[0]),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/preferences/${SUPERVISION_USER_DEFAULT_PREF_KEY}`,
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('saves normalized supervisor defaults through the shared preference key', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(saveSupervisorDefaults({
      backend: 'qwen',
      model: 'qwen3-coder-plus',
      timeoutMs: 15_000,
      promptVersion: 'supervision_decision_v1',
    })).resolves.toEqual(EXPECTED_QWEN_DEFAULTS);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/preferences/${SUPERVISION_USER_DEFAULT_PREF_KEY}`);
    expect(init.method).toBe('PUT');
    // Parse rather than string-compare: the round-trip contract is the VALUE
    // persisted, not the key order the normalizer happens to emit.
    expect(JSON.parse(String(init.body))).toEqual({ value: EXPECTED_QWEN_DEFAULTS });
  });

  it('loads the machine owner supervision defaults through a covered session', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      defaults: {
        backend: 'claude-code-sdk',
        model: 'MiniMax-M2.7',
        preset: 'MiniMax Owner',
        timeoutMs: 50_000,
        promptVersion: 'supervision_decision_v1',
      },
    }));

    await expect(fetchSessionSupervisorDefaults('srv owner', 'deck_proj_brain')).resolves.toEqual(expect.objectContaining({
      backend: 'claude-code-sdk',
      model: 'MiniMax-M2.7',
      preset: 'MiniMax Owner',
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/server/srv%20owner/sessions/deck_proj_brain/supervision/defaults',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('saves supervision defaults to the machine owner rather than the participant preference', async () => {
    const defaults = {
      backend: 'qwen' as const,
      model: 'MiniMax-M2.7',
      preset: 'MiniMax Owner',
      timeoutMs: 50_000,
      promptVersion: 'supervision_decision_v1',
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, defaults }));

    await expect(saveSessionSupervisorDefaults('srv-1', 'deck_proj_brain', defaults)).resolves.toEqual(expect.objectContaining({
      backend: 'qwen',
      model: 'MiniMax-M2.7',
      preset: 'MiniMax Owner',
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/server/srv-1/sessions/deck_proj_brain/supervision/defaults',
      expect.objectContaining({ method: 'PUT' }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      defaults: expect.objectContaining({
        backend: 'qwen',
        model: 'MiniMax-M2.7',
        preset: 'MiniMax Owner',
      }),
    });
  });

  it('includes transportConfig and model fields when patching sessions', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await patchSession('srv-1', 'deck_proj_brain', {
      agentType: 'codex-sdk',
      requestedModel: 'gpt-5.4',
      activeModel: 'gpt-5.4',
      effort: 'high',
      transportConfig: { supervision: { mode: 'supervised' } },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/server/srv-1/sessions/deck_proj_brain',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          agentType: 'codex-sdk',
          requestedModel: 'gpt-5.4',
          activeModel: 'gpt-5.4',
          effort: 'high',
          transportConfig: { supervision: { mode: 'supervised' } },
        }),
      }),
    );
  });

  it('includes transportConfig and model fields when patching sub-sessions', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await patchSubSession('srv-1', 'sub-1234', {
      type: 'claude-code-sdk',
      requestedModel: 'sonnet',
      activeModel: 'sonnet',
      effort: 'medium',
      transportConfig: { supervision: { mode: 'supervised_audit' } },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/server/srv-1/sub-sessions/sub-1234',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          type: 'claude-code-sdk',
          requestedModel: 'sonnet',
          activeModel: 'sonnet',
          effort: 'medium',
          transportConfig: { supervision: { mode: 'supervised_audit' } },
        }),
      }),
    );
  });

  it('patches only supervision through the covered-session endpoint', async () => {
    const transportConfig = { supervision: { mode: 'supervised' } };
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, transportConfig }));

    await expect(patchSessionSupervision('srv-1', 'deck_sub_child', {
      mode: 'supervised',
      backend: 'codex-sdk',
      model: 'gpt-5.4',
      timeoutMs: 30_000,
      promptVersion: 'supervision_decision_v1',
    })).resolves.toEqual(transportConfig);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/server/srv-1/sessions/deck_sub_child/supervision',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          supervision: {
            mode: 'supervised',
            backend: 'codex-sdk',
            model: 'gpt-5.4',
            timeoutMs: 30_000,
            promptVersion: 'supervision_decision_v1',
          },
        }),
      }),
    );
  });
});
