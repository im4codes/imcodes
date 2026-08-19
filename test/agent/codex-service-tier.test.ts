import { describe, it, expect, vi } from 'vitest';
import { CodexSdkProvider } from '../../src/agent/providers/codex-sdk.js';
import { CODEX_SERVICE_TIER } from '../../shared/codex-service-tier.js';

/**
 * Codex keeps the service tier on the thread, so a session switched to Fast --
 * in the Codex TUI, in the ChatGPT app, by anyone -- comes back Fast on every
 * resume. Before this, the provider neither read the tier nor could write it,
 * so IM.codes could not say a session was on Fast, and had no way back off:
 * that is the "send /fast once and it can never be turned off" report.
 */
function providerWithSession(state: Record<string, unknown> = {}): {
  provider: CodexSdkProvider;
  infos: Array<{ sessionId: string; info: Record<string, unknown> }>;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const provider = new CodexSdkProvider();
  (provider as any).sessions.set('sess-1', {
    threadId: 'thread-1',
    loaded: true,
    imcodesSessionName: 'deck_demo_brain',
    ...state,
  });
  (provider as any).threadToSession.set('thread-1', 'sess-1');
  const infos: Array<{ sessionId: string; info: Record<string, unknown> }> = [];
  (provider as any).sessionInfoCallbacks = [
    (sessionId: string, info: Record<string, unknown>) => infos.push({ sessionId, info }),
  ];
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  (provider as any).request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    requests.push({ method, params });
    return {};
  });
  (provider as any).ensureThreadLoaded = vi.fn(async () => {});
  return { provider, infos, requests };
}

describe('codex service tier', () => {
  it('declares the capability so the viewer can offer the switch', () => {
    expect(new CodexSdkProvider().capabilities.serviceTier).toBe(true);
  });

  it('reports the tier a resumed thread came back with', () => {
    const { provider, infos } = providerWithSession();
    (provider as any).handleNotification('thread/started', {
      thread: { id: 'thread-1', serviceTier: CODEX_SERVICE_TIER.FAST },
    });
    expect(infos.some((entry) => entry.info.serviceTier === CODEX_SERVICE_TIER.FAST)).toBe(true);
  });

  it('follows a tier switched on elsewhere while the session is live', () => {
    const { provider, infos } = providerWithSession({ serviceTier: CODEX_SERVICE_TIER.DEFAULT });
    (provider as any).handleNotification('thread/settings/updated', {
      threadId: 'thread-1',
      settings: { serviceTier: CODEX_SERVICE_TIER.FAST },
    });
    expect(infos.at(-1)?.info.serviceTier).toBe(CODEX_SERVICE_TIER.FAST);
  });

  it('stays quiet when the reported tier has not changed', () => {
    const { provider, infos } = providerWithSession({ serviceTier: CODEX_SERVICE_TIER.FAST });
    (provider as any).handleNotification('thread/settings/updated', {
      threadId: 'thread-1',
      settings: { serviceTier: CODEX_SERVICE_TIER.FAST },
    });
    expect(infos).toEqual([]);
  });

  it('turns Fast off on the thread, which is the only place it lives', async () => {
    const { provider, requests, infos } = providerWithSession({ serviceTier: CODEX_SERVICE_TIER.FAST });
    await provider.setServiceTier('sess-1', CODEX_SERVICE_TIER.DEFAULT);
    expect(requests).toEqual([{
      method: 'thread/settings/update',
      params: { threadId: 'thread-1', serviceTier: CODEX_SERVICE_TIER.DEFAULT },
    }]);
    expect(infos.at(-1)?.info.serviceTier).toBe(CODEX_SERVICE_TIER.DEFAULT);
  });

  it('refuses a session it does not know rather than reporting a silent success', async () => {
    const { provider } = providerWithSession();
    await expect(provider.setServiceTier('missing', CODEX_SERVICE_TIER.DEFAULT)).rejects.toThrow();
  });
});
