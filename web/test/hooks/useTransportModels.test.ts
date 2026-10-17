/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    expect(fallback?.defaultModel).toBe('gemini-3.8-flash-high');
  });

  it('initializes useTransportModels with static fallback for AGY so initial state is never empty', () => {
    const { result } = renderHook(() => useTransportModels(null, AGY_SDK_PROVIDER_ID));
    expect(result.current.models.length).toBeGreaterThan(0);
    expect(result.current.defaultModel).toBe('gemini-3.8-flash-high');
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
  it('keeps the fallback and default when refresh is clicked while disconnected', () => {
    const { result } = renderHook(() => useTransportModels(null, AGY_SDK_PROVIDER_ID));
    act(() => result.current.refresh());
    expect(result.current.models.length).toBeGreaterThan(0);
    expect(result.current.defaultModel).toBe('gemini-3.8-flash-high');
    expect(result.current.loading).toBe(false);
  });

  it('uses Antigravity fallback when agent information arrives after mount without a socket', () => {
    const { result, rerender } = renderHook(({ agent }) => useTransportModels(null, agent), { initialProps: { agent: null as string | null } });
    expect(result.current.models).toEqual([]);
    rerender({ agent: AGY_SDK_PROVIDER_ID });
    expect(result.current.models.length).toBeGreaterThan(0);
    expect(result.current.defaultModel).toBe('gemini-3.8-flash-high');
  });

  it('retains models and reports errors when the live catalog dispatch throws', () => {
    const ws = {
      connected: true,
      onMessage: () => () => {},
      requestTransportModels: () => { throw new Error('socket went away'); },
    } as unknown as WsClient;
    const { result } = renderHook(() => useTransportModels(ws, AGY_SDK_PROVIDER_ID));
    expect(result.current.models.length).toBeGreaterThan(0);
    expect(result.current.defaultModel).toBe('gemini-3.8-flash-high');
    expect(result.current.error).toBe('socket went away');
    expect(result.current.loading).toBe(false);
  });

  it('keeps a live catalog and its metadata through refresh failure and an empty error reply', () => {
    let listener: ((msg: unknown) => void) | undefined;
    const request = vi.fn(() => 'live-request');
    const ws = { connected: true, onMessage: (cb: (msg: unknown) => void) => { listener = cb; return () => {}; }, requestTransportModels: request } as unknown as WsClient;
    const { result } = renderHook(() => useTransportModels(ws, AGY_SDK_PROVIDER_ID));
    act(() => listener?.({ type: TRANSPORT_MSG.MODELS_RESPONSE, agentType: AGY_SDK_PROVIDER_ID, requestId: 'live-request', models: [{ id: 'live-only' }], defaultModel: 'live-only', isAuthenticated: true }));
    request.mockImplementationOnce(() => { throw new Error('refresh failed'); });
    act(() => result.current.refresh());
    expect(result.current.models).toEqual([{ id: 'live-only' }]);
    expect(result.current.defaultModel).toBe('live-only');
    act(() => listener?.({ type: TRANSPORT_MSG.MODELS_RESPONSE, agentType: AGY_SDK_PROVIDER_ID, models: [], error: 'probe timeout' }));
    expect(result.current.models).toEqual([{ id: 'live-only' }]);
    expect(result.current.defaultModel).toBe('live-only');
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.error).toBe('probe timeout');
  });

  it('does not replace the refreshed catalog with an older response or another session broadcast', () => {
    let listener: ((msg: unknown) => void) | undefined;
    let seq = 0;
    const ws = { connected: true, onMessage: (cb: (msg: unknown) => void) => { listener = cb; return () => {}; }, requestTransportModels: () => `req-${++seq}` } as unknown as WsClient;
    const { result } = renderHook(() => useTransportModels(ws, AGY_SDK_PROVIDER_ID, null, 'current-session'));
    act(() => result.current.refresh());
    act(() => listener?.({ type: TRANSPORT_MSG.MODELS_RESPONSE, agentType: AGY_SDK_PROVIDER_ID, requestId: 'req-2', models: [{ id: 'current' }] }));
    act(() => listener?.({ type: TRANSPORT_MSG.MODELS_RESPONSE, agentType: AGY_SDK_PROVIDER_ID, requestId: 'req-1', models: [{ id: 'stale' }] }));
    act(() => listener?.({ type: TRANSPORT_MSG.MODELS_RESPONSE, agentType: AGY_SDK_PROVIDER_ID, sessionName: 'other-session', models: [{ id: 'foreign' }] }));
    expect(result.current.models).toEqual([{ id: 'current' }]);
  });

  it('settles synchronous queue-full responses instead of leaving the fallback loading forever', () => {
    let listener: ((msg: unknown) => void) | undefined;
    const ws = {
      connected: true,
      onMessage: (cb: (msg: unknown) => void) => { listener = cb; return () => {}; },
      requestTransportModels: () => {
        listener?.({ type: TRANSPORT_MSG.MODELS_RESPONSE, agentType: AGY_SDK_PROVIDER_ID, requestId: 'queue-full', models: [], error: 'queue_full' });
        return 'queue-full';
      },
    } as unknown as WsClient;
    const { result } = renderHook(() => useTransportModels(ws, AGY_SDK_PROVIDER_ID));
    expect(result.current.models.length).toBeGreaterThan(0);
    expect(result.current.defaultModel).toBe('gemini-3.8-flash-high');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe('queue_full');
  });

  it('rejects blank model IDs instead of replacing fallback options with invisible rows', () => {
    let listener: ((msg: unknown) => void) | undefined;
    const ws = { connected: true, onMessage: (cb: (msg: unknown) => void) => { listener = cb; return () => {}; }, requestTransportModels: () => 'invalid-ids' } as unknown as WsClient;
    const { result } = renderHook(() => useTransportModels(ws, AGY_SDK_PROVIDER_ID));
    const before = result.current.models;
    act(() => listener?.({ type: TRANSPORT_MSG.MODELS_RESPONSE, agentType: AGY_SDK_PROVIDER_ID, requestId: 'invalid-ids', models: [{ id: '' }, { id: '  ' }, { id: null }] }));
    expect(result.current.models).toEqual(before);
    expect(result.current.loading).toBe(false);
  });

  it('refreshes on reconnect using the live socket flag and retains models during the probe', () => {
    let listener: ((msg: unknown) => void) | undefined;
    const request = vi.fn(() => 'reconnect');
    const ws = { connected: false, onMessage: (cb: (msg: unknown) => void) => { listener = cb; return () => {}; }, requestTransportModels: request } as unknown as WsClient;
    const { result } = renderHook(() => useTransportModels(ws, AGY_SDK_PROVIDER_ID));
    expect(request).not.toHaveBeenCalled();
    (ws as unknown as { connected: boolean }).connected = true;
    act(() => listener?.({ type: 'daemon.reconnected' }));
    expect(request).toHaveBeenCalled();
    expect(result.current.models.length).toBeGreaterThan(0);
    expect(result.current.loading).toBe(true);
    act(() => listener?.({ type: TRANSPORT_MSG.MODELS_RESPONSE, agentType: AGY_SDK_PROVIDER_ID, requestId: 'reconnect', models: [{ id: 'live-reconnected' }] }));
    expect(result.current.models).toEqual([{ id: 'live-reconnected' }]);
    expect(result.current.loading).toBe(false);
  });

  it.each(['cached-session\0agy-sdk\0', '\0agy-sdk\0'])('ignores persisted blank catalogs at %s and falls back immediately', (key) => {
    window.sessionStorage.setItem('imcodes:transport-models:' + key, JSON.stringify({ models: [{ id: '' }, { id: '  ' }] }));
    const { result } = renderHook(() => useTransportModels(null, AGY_SDK_PROVIDER_ID, null, 'cached-session'));
    expect(result.current.models.length).toBeGreaterThan(0);
    expect(result.current.models.every((model) => model.id.trim().length > 0)).toBe(true);
  });

  it('updates old persisted catalog defaults to Flash High without losing model options', () => {
    window.sessionStorage.setItem('imcodes:transport-models:old-session\0agy-sdk\0', JSON.stringify({
      models: [{ id: 'gemini-4-argon-medium' }, { id: 'gemini-3.8-flash-high' }],
      defaultModel: 'gemini-4-argon-medium',
    }));
    const { result } = renderHook(() => useTransportModels(null, AGY_SDK_PROVIDER_ID, null, 'old-session'));
    expect(result.current.models).toHaveLength(2);
    expect(result.current.defaultModel).toBe('gemini-3.8-flash-high');
  });

  it('fully overwrites memory and stored catalogs with newer models and reuses the cache on remount', () => {
    const key = 'replace-session\0agy-sdk\0';
    writeCachedTransportModels(key, AGY_SDK_PROVIDER_ID, { models: [{ id: 'old-only' }], defaultModel: 'old-only' });
    let listener: ((msg: unknown) => void) | undefined;
    const ws = { connected: true, onMessage: (cb: (msg: unknown) => void) => { listener = cb; return () => {}; }, requestTransportModels: () => 'replace-request' } as unknown as WsClient;
    const { result, unmount } = renderHook(() => useTransportModels(ws, AGY_SDK_PROVIDER_ID, null, 'replace-session'));
    expect(result.current.models).toEqual([{ id: 'old-only' }]);
    const fresh = [{ id: 'gemini-3.8-flash-high' }, { id: 'new-only' }];
    act(() => listener?.({ type: TRANSPORT_MSG.MODELS_RESPONSE, agentType: AGY_SDK_PROVIDER_ID, requestId: 'replace-request', models: fresh, defaultModel: 'gemini-3.8-flash-high', isAuthenticated: true }));
    expect(result.current.models).toEqual(fresh);
    expect(readCachedTransportModels(key, AGY_SDK_PROVIDER_ID)?.models).toEqual(fresh);
    expect(JSON.parse(window.sessionStorage.getItem('imcodes:transport-models:' + key)!).models).toEqual(fresh);
    act(() => listener?.({ type: TRANSPORT_MSG.MODELS_RESPONSE, agentType: AGY_SDK_PROVIDER_ID, requestId: 'replace-request', models: [], error: 'probe failed' }));
    expect(result.current.models).toEqual(fresh);
    unmount();
    const next = renderHook(() => useTransportModels(null, AGY_SDK_PROVIDER_ID, null, 'replace-session'));
    expect(next.result.current.models).toEqual(fresh);
    expect(next.result.current.defaultModel).toBe('gemini-3.8-flash-high');
  });

});
