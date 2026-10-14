/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { supportsDynamicTransportModels } from '../../src/hooks/useTransportModels.js';
import { CODEBUDDY_PROVIDER_IDS } from '@shared/codebuddy.js';
import { AGY_SDK_PROVIDER_ID } from '@shared/agy-agent.js';
import { HERMES_AGENT_PROVIDER_ID } from '@shared/hermes-agent.js';

/**
 * `supportsDynamicTransportModels` is the root model-selection registry for the
 * web app: every picker (new session, sub-session, session controls) gates its
 * model UI on it. An agent missing here has no reachable model entry point even
 * when the daemon fully implements `/model` and `listModels()` for it.
 */
describe('supportsDynamicTransportModels', () => {
  it('accepts every transport agent whose daemon provider answers transport.list_models', () => {
    const supported = [
      'claude-code-sdk',
      'copilot-sdk',
      'cursor-headless',
      'codex-sdk',
      'opencode-sdk',
      'gemini-sdk',
      'grok-sdk',
      AGY_SDK_PROVIDER_ID,
      'kimi-sdk',
      HERMES_AGENT_PROVIDER_ID,
      'deepseek-harness',
      'pi',
      'qwen',
      CODEBUDDY_PROVIDER_IDS.CHINA,
      CODEBUDDY_PROVIDER_IDS.INTERNATIONAL,
    ];
    for (const agentType of supported) {
      expect(supportsDynamicTransportModels(agentType), agentType).toBe(true);
    }
  });

  it('treats DSH and Pi like the other empty-catalogue providers', () => {
    // DSH/Pi resolve third-party provider routes from the selected preset,
    // so its catalogue is always empty — the same free-text case as Kimi/Grok.
    for (const agentType of ['deepseek-harness', 'pi', 'kimi-sdk', HERMES_AGENT_PROVIDER_ID, 'grok-sdk', 'cursor-headless']) {
      expect(supportsDynamicTransportModels(agentType), agentType).toBe(true);
    }
  });

  it('rejects agents with no daemon model plumbing', () => {
    const unsupported = ['claude-code', 'codex', 'opencode', 'gemini', 'shell', 'script', 'openclaw', 'qoder-sdk', '', undefined, null];
    for (const agentType of unsupported) {
      expect(supportsDynamicTransportModels(agentType), String(agentType)).toBe(false);
    }
  });
});

import { renderHook, act } from '@testing-library/preact';
import {
  useTransportModels,
  getStaticFallbackModels,
  readCachedTransportModels,
  writeCachedTransportModels,
  __clearTransportModelCacheForTests,
} from '../../src/hooks/useTransportModels.js';
import { TRANSPORT_MSG } from '@shared/transport-events.js';
import type { WsClient } from '../../src/ws-client.js';

describe('useTransportModels caching and fallbacks', () => {
  beforeEach(() => {
    __clearTransportModelCacheForTests();
  });

  it('provides static fallback models for AGY_SDK_PROVIDER_ID immediately', () => {
    const fallback = getStaticFallbackModels(AGY_SDK_PROVIDER_ID);
    expect(fallback).not.toBeNull();
    expect(fallback?.models.length).toBeGreaterThan(0);
    expect(fallback?.models.map((m) => m.id)).toContain('gemini-4-argon-medium');
    expect(fallback?.defaultModel).toBe('gemini-4-argon-medium');
  });

  it('initializes useTransportModels with static fallback for AGY so initial state is never empty', () => {
    const { result } = renderHook(() => useTransportModels(null, AGY_SDK_PROVIDER_ID));
    expect(result.current.models.length).toBeGreaterThan(0);
    expect(result.current.models.map((m) => m.id)).toContain('gemini-4-argon-medium');
  });

  it('caches models in memory and sessionStorage when MODELS_RESPONSE arrives', () => {
    let messageListener: ((msg: unknown) => void) | undefined;
    const fakeWs = {
      connected: true,
      onMessage: (cb: (msg: unknown) => void) => {
        messageListener = cb;
        return () => {};
      },
      requestTransportModels: () => 'req-1',
    } as unknown as WsClient;

    const { result } = renderHook(() => useTransportModels(fakeWs, AGY_SDK_PROVIDER_ID, undefined, 'sess-1'));
    expect(result.current.models.length).toBeGreaterThan(0);

    act(() => {
      messageListener?.({
        type: TRANSPORT_MSG.MODELS_RESPONSE,
        agentType: AGY_SDK_PROVIDER_ID,
        requestId: 'req-1',
        models: [{ id: 'gemini-4-argon-high' }, { id: 'custom-agy-model' }],
        defaultModel: 'gemini-4-argon-high',
        isAuthenticated: true,
      });
    });

    expect(result.current.models.map((m) => m.id)).toEqual(['gemini-4-argon-high', 'custom-agy-model']);

    const cached = readCachedTransportModels('sess-1\0agy-sdk\0', AGY_SDK_PROVIDER_ID);
    expect(cached?.models.map((m) => m.id)).toEqual(['gemini-4-argon-high', 'custom-agy-model']);
  });

  it('preserves cached models when switching between sessions of the same provider', () => {
    writeCachedTransportModels('\0agy-sdk\0', AGY_SDK_PROVIDER_ID, {
      models: [{ id: 'cached-agy-1' }],
      defaultModel: 'cached-agy-1',
      isAuthenticated: true,
    });

    const { result } = renderHook(() => useTransportModels(null, AGY_SDK_PROVIDER_ID, undefined, 'session-2'));
    expect(result.current.models.map((m) => m.id)).toEqual(['cached-agy-1']);
  });

  it('does not wipe models if an error response arrives with 0 models', () => {
    let messageListener: ((msg: unknown) => void) | undefined;
    const fakeWs = {
      connected: true,
      onMessage: (cb: (msg: unknown) => void) => {
        messageListener = cb;
        return () => {};
      },
      requestTransportModels: () => 'req-2',
    } as unknown as WsClient;

    const { result } = renderHook(() => useTransportModels(fakeWs, AGY_SDK_PROVIDER_ID, undefined, 'sess-err'));
    const initialCount = result.current.models.length;
    expect(initialCount).toBeGreaterThan(0);

    act(() => {
      messageListener?.({
        type: TRANSPORT_MSG.MODELS_RESPONSE,
        agentType: AGY_SDK_PROVIDER_ID,
        requestId: 'req-2',
        models: [],
        error: 'timeout probe',
      });
    });

    expect(result.current.models.length).toBe(initialCount);
    expect(result.current.error).toBe('timeout probe');
  });
});
