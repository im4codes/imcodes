/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK,
  DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL,
  SUPERVISION_USER_DEFAULT_PREF_KEY,
} from '@shared/supervision-config.js';
import { CODEX_MODEL_IDS } from '../../src/shared/models/options.js';
import {
  fetchSupervisorDefaults,
  patchSession,
  patchSubSession,
  saveSupervisorDefaults,
} from '../src/api.js';

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
      timeoutMs: 20_000,
      promptVersion: 'custom_prompt_v1',
      maxAutoContinueStreak: DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK,
      maxAutoContinueTotal: DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL,
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
    })).resolves.toEqual({
      backend: 'qwen',
      model: 'qwen3-coder-plus',
      timeoutMs: 15_000,
      promptVersion: 'supervision_decision_v1',
      maxAutoContinueStreak: DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK,
      maxAutoContinueTotal: DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/preferences/${SUPERVISION_USER_DEFAULT_PREF_KEY}`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          value: {
            backend: 'qwen',
            model: 'qwen3-coder-plus',
            timeoutMs: 15_000,
            promptVersion: 'supervision_decision_v1',
            maxAutoContinueStreak: DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK,
            maxAutoContinueTotal: DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL,
          },
        }),
      }),
    );
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
});
