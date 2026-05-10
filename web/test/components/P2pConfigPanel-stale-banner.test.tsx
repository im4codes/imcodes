/**
 * @vitest-environment jsdom
 *
 * Audit fix (7c2570e9 follow-up to e940d73f-a8e / N4) regression tests.
 *
 * The 7c2570e9 screenshot reproduced the "DAEMON 失联" banner persisting
 * even after my N4 ws-client fix shipped. Root cause: the panel computed
 * staleness inline from `capabilitySnapshot.observedAt` (which is only
 * refreshed by `daemon.hello`, not by routine heartbeats), so a long-
 * lived browser page tripped the 30 s TTL after the first hello and the
 * banner stuck. The N4 fix lived in `WsClient.isDaemonCapabilityStale()`
 * but the panel never called it.
 *
 * The PR-φ follow-up adds `isStale()` to the source interface and the
 * panel now defers to it. These tests pin the contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, cleanup, act } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallbackOrOpts?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOpts === 'string') return fallbackOrOpts;
      if (fallbackOrOpts && typeof fallbackOrOpts === 'object' && typeof fallbackOrOpts.defaultValue === 'string') {
        return fallbackOrOpts.defaultValue as string;
      }
      return _key.split('.').pop() ?? _key;
    },
  }),
}));

const getUserPrefMock = vi.fn();
const saveUserPrefMock = vi.fn();
vi.mock('../../src/api.js', () => ({
  getUserPref: (...args: unknown[]) => getUserPrefMock(...args),
  saveUserPref: (...args: unknown[]) => saveUserPrefMock(...args),
  onUserPrefChanged: (_cb: (key: string, value: unknown) => void) => () => {},
}));

import {
  P2pConfigPanel,
  type P2pConfigPanelCapabilitySource,
  type P2pConfigPanelCapabilitySnapshot,
} from '../../src/components/P2pConfigPanel.js';
import { P2P_WORKFLOW_CAPABILITY_V1, P2P_CAPABILITY_FRESHNESS_TTL_MS } from '@shared/p2p-workflow-constants.js';

const seedSnapshot = (observedAt: number): P2pConfigPanelCapabilitySnapshot => ({
  daemonId: 'd1',
  capabilities: [P2P_WORKFLOW_CAPABILITY_V1],
  helloEpoch: 1,
  sentAt: observedAt,
  observedAt,
});

async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

const renderPanel = (source: P2pConfigPanelCapabilitySource | null) =>
  render(
    h(P2pConfigPanel, {
      sessions: [{ name: 'deck_x_brain', agentType: 'claude-code-sdk', state: 'running' }],
      subSessions: [],
      activeSession: 'deck_x_brain',
      serverId: 'srv-1',
      initialTab: 'advanced',
      onClose: () => {},
      onSave: () => {},
      daemonCapabilitySource: source,
    } as never),
  );

describe('P2pConfigPanel capability_stale banner — N4 follow-up (7c2570e9)', () => {
  beforeEach(() => {
    getUserPrefMock.mockReset();
    saveUserPrefMock.mockReset();
    saveUserPrefMock.mockResolvedValue(undefined);
    // Saved config carries `advancedPresetKey` so `hasAdvancedConfig === true`
    // and the stale banner branch is reachable. Without this, banner is
    // hidden regardless of staleness because the gate is `hasAdvancedConfig
    // && !futureSchemaDetected && capabilityStale`.
    getUserPrefMock.mockResolvedValue({
      sessions: {},
      rounds: 1,
      hopTimeoutMinutes: 5,
      advancedPresetKey: 'audit',
      advancedRunTimeoutMinutes: 30,
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('hides banner when source.isStale() returns false even if observedAt is far past TTL', async () => {
    // observedAt is 5 minutes old — the legacy inline check would say "stale".
    // But isStale() returns false (simulating live daemon with recent
    // daemon.stats messages bumping daemonLastSeenAt). Banner MUST stay hidden.
    const ancientObservedAt = Date.now() - 5 * 60_000;
    const source: P2pConfigPanelCapabilitySource = {
      getSnapshot: () => seedSnapshot(ancientObservedAt),
      subscribe: () => () => {},
      isStale: () => false,
    };
    const { container } = renderPanel(source);
    await flush();
    expect(container.querySelector('[data-testid="p2p-capability-stale-banner"]')).toBeNull();
  });

  it('shows banner when source.isStale() returns true even if observedAt is fresh', async () => {
    const freshObservedAt = Date.now();
    const source: P2pConfigPanelCapabilitySource = {
      getSnapshot: () => seedSnapshot(freshObservedAt),
      subscribe: () => () => {},
      isStale: () => true,
    };
    const { container } = renderPanel(source);
    await flush();
    expect(container.querySelector('[data-testid="p2p-capability-stale-banner"]')).not.toBeNull();
  });

  it('falls back to observedAt-based check when source omits isStale (legacy fixture)', async () => {
    const ancientObservedAt = Date.now() - P2P_CAPABILITY_FRESHNESS_TTL_MS - 5_000;
    const source: P2pConfigPanelCapabilitySource = {
      getSnapshot: () => seedSnapshot(ancientObservedAt),
      subscribe: () => () => {},
      // isStale intentionally omitted
    };
    const { container } = renderPanel(source);
    await flush();
    expect(container.querySelector('[data-testid="p2p-capability-stale-banner"]')).not.toBeNull();
  });

  it('hides banner with legacy fixture when observedAt is recent', async () => {
    const source: P2pConfigPanelCapabilitySource = {
      getSnapshot: () => seedSnapshot(Date.now()),
      subscribe: () => () => {},
    };
    const { container } = renderPanel(source);
    await flush();
    expect(container.querySelector('[data-testid="p2p-capability-stale-banner"]')).toBeNull();
  });
});
