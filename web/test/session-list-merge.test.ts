/**
 * Integration tests for `mergeSessionListEntry` — the merge step that turns
 * a daemon `session_list` broadcast entry into the web's `SessionInfo`.
 *
 * Regression scope: the "Auto dropdown 自动跳回关闭状态" bug. Symptoms as
 * reported by the user (with screenshot): user enables supervised via the
 * Auto dropdown; the UI flashes back to "off" within ~1s even though the
 * PATCH succeeded and the daemon eventually persists the supervision
 * snapshot. Root cause: a stale daemon `session_list` broadcast arrives
 * between the optimistic UI update and the authoritative post-PATCH
 * broadcast, with `transportConfig` either empty `{}` or carrying
 * unrelated keys without `supervision`. The prior code coalesced with
 * `??`, treating `{}` and `{ k: v }` as truthy and wiping supervision.
 *
 * These tests live at the web integration boundary (post-refactor extract
 * of app.tsx's inline setSessions mapper) so the full merge contract is
 * verified end-to-end, not only the inner `mergeTransportConfigPreservingSupervision`.
 */
import { describe, expect, it } from 'vitest';
import {
  SUPERVISION_MODE,
  SUPERVISION_TRANSPORT_CONFIG_KEY,
  type SessionSupervisionSnapshot,
} from '@shared/supervision-config.js';
import {
  isNavigableMainSession,
  isSubSessionName,
  isWorkerSessionName,
  mergeSessionListEntry,
  parseMainSessionName,
  type IncomingSessionListEntry,
} from '../src/session-list-merge.js';
import type { SessionInfo } from '../src/types.js';

const BASE_INCOMING: IncomingSessionListEntry = {
  name: 'deck_proj_brain',
  project: 'proj',
  role: 'brain',
  agentType: 'codex-sdk',
  state: 'idle',
  runtimeType: 'transport',
};

const SUPERVISED_SNAPSHOT: SessionSupervisionSnapshot = {
  mode: SUPERVISION_MODE.SUPERVISED,
  backend: 'codex-sdk',
  model: 'gpt-5.3-codex-spark',
  timeoutMs: 12_000,
  promptVersion: 'supervision_decision_v1',
  maxParseRetries: 1,
};

function makeExisting(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    name: 'deck_proj_brain',
    project: 'proj',
    role: 'brain',
    agentType: 'codex-sdk',
    state: 'idle',
    runtimeType: 'transport',
    transportConfig: {
      [SUPERVISION_TRANSPORT_CONFIG_KEY]: SUPERVISED_SNAPSHOT,
    },
    ...overrides,
  };
}

describe('mergeSessionListEntry — supervision preservation', () => {
  it('preserves user-enabled supervision when daemon broadcasts an empty transportConfig', () => {
    const existing = makeExisting();

    const merged = mergeSessionListEntry({
      ...BASE_INCOMING,
      transportConfig: {},
    }, existing);

    expect(merged.transportConfig).toEqual({
      [SUPERVISION_TRANSPORT_CONFIG_KEY]: SUPERVISED_SNAPSHOT,
    });
  });

  it('preserves supervision when broadcast omits the field entirely (undefined transportConfig)', () => {
    const existing = makeExisting();

    const merged = mergeSessionListEntry({
      ...BASE_INCOMING,
      // no transportConfig key at all — common in lean heartbeat snapshots
    }, existing);

    expect(merged.transportConfig).toEqual({
      [SUPERVISION_TRANSPORT_CONFIG_KEY]: SUPERVISED_SNAPSHOT,
    });
  });

  it('preserves supervision while layering unrelated broadcast keys on top', () => {
    const existing = makeExisting();

    const merged = mergeSessionListEntry({
      ...BASE_INCOMING,
      transportConfig: { ccPreset: 'MiniMax', someServerOnlyKey: 'x' },
    }, existing);

    expect(merged.transportConfig).toMatchObject({
      ccPreset: 'MiniMax',
      someServerOnlyKey: 'x',
      [SUPERVISION_TRANSPORT_CONFIG_KEY]: SUPERVISED_SNAPSHOT,
    });
  });

  it('replaces supervision with the broadcast value when daemon sends an authoritative snapshot', () => {
    const existing = makeExisting();
    const incomingOffSnapshot: SessionSupervisionSnapshot = {
      mode: SUPERVISION_MODE.OFF,
    } as SessionSupervisionSnapshot;

    const merged = mergeSessionListEntry({
      ...BASE_INCOMING,
      transportConfig: { [SUPERVISION_TRANSPORT_CONFIG_KEY]: incomingOffSnapshot },
    }, existing);

    expect(
      (merged.transportConfig as Record<string, unknown>)[SUPERVISION_TRANSPORT_CONFIG_KEY],
    ).toMatchObject({ mode: SUPERVISION_MODE.OFF });
  });

  it('returns null when neither side has transportConfig (no supervision to defend)', () => {
    const merged = mergeSessionListEntry(BASE_INCOMING, makeExisting({ transportConfig: null }));
    expect(merged.transportConfig).toBeNull();
  });

  it('full lifecycle: optimistic enable → stale empty broadcast → authoritative broadcast', () => {
    // Step 1: UI has no supervision yet.
    let state: SessionInfo = makeExisting({ transportConfig: null });

    // Step 2: user flips Auto → supervised. app.tsx's onTransportConfigSaved path
    // writes this to state optimistically (simulated here).
    state = {
      ...state,
      transportConfig: {
        [SUPERVISION_TRANSPORT_CONFIG_KEY]: SUPERVISED_SNAPSHOT,
      },
    };

    // Step 3: a stale session_list broadcast from the daemon lands between
    // PATCH dispatch and the daemon's own upsert — transportConfig is `{}`.
    state = mergeSessionListEntry({ ...BASE_INCOMING, transportConfig: {} }, state);
    expect(state.transportConfig).toEqual({
      [SUPERVISION_TRANSPORT_CONFIG_KEY]: SUPERVISED_SNAPSHOT,
    });

    // Step 4: the authoritative broadcast arrives with the persisted snapshot.
    state = mergeSessionListEntry({
      ...BASE_INCOMING,
      transportConfig: { [SUPERVISION_TRANSPORT_CONFIG_KEY]: SUPERVISED_SNAPSHOT },
    }, state);
    expect(state.transportConfig).toEqual({
      [SUPERVISION_TRANSPORT_CONFIG_KEY]: SUPERVISED_SNAPSHOT,
    });

    // Step 5: user disables supervision → server PATCH → daemon broadcasts
    // { mode: 'off' }. That IS authoritative; merge must honor it.
    state = mergeSessionListEntry({
      ...BASE_INCOMING,
      transportConfig: { [SUPERVISION_TRANSPORT_CONFIG_KEY]: { mode: SUPERVISION_MODE.OFF } },
    }, state);
    expect(
      (state.transportConfig as Record<string, unknown>)[SUPERVISION_TRANSPORT_CONFIG_KEY],
    ).toMatchObject({ mode: SUPERVISION_MODE.OFF });
  });
});

describe('mergeSessionListEntry — general field behavior', () => {
  it('copies incoming non-supervision fields across', () => {
    const merged = mergeSessionListEntry({
      ...BASE_INCOMING,
      label: 'Main Brain',
      modelDisplay: 'gpt-5.4',
      planLabel: 'Pro',
    }, makeExisting({ label: 'old', modelDisplay: 'old-model' }));

    expect(merged.label).toBe('Main Brain');
    expect(merged.modelDisplay).toBe('gpt-5.4');
    expect(merged.planLabel).toBe('Pro');
  });

  it('falls back to existing for fields omitted by the broadcast', () => {
    const merged = mergeSessionListEntry(BASE_INCOMING, makeExisting({
      label: 'Main Brain',
      modelDisplay: 'gpt-5.4',
      effort: 'high',
      contextNamespace: { scope: 'personal', projectId: 'repo-existing' },
      contextNamespaceDiagnostics: ['namespace:existing'],
    }));

    expect(merged.label).toBe('Main Brain');
    expect(merged.modelDisplay).toBe('gpt-5.4');
    expect(merged.effort).toBe('high');
    expect(merged.contextNamespace).toEqual({ scope: 'personal', projectId: 'repo-existing' });
    expect(merged.contextNamespaceDiagnostics).toEqual(['namespace:existing']);
  });

  it('copies incoming context namespace for project-scoped memory tools', () => {
    const merged = mergeSessionListEntry({
      ...BASE_INCOMING,
      contextNamespace: { scope: 'personal', projectId: 'repo-current' },
      contextNamespaceDiagnostics: ['namespace:explicit'],
    }, makeExisting({
      contextNamespace: { scope: 'personal', projectId: 'repo-old' },
      contextNamespaceDiagnostics: ['namespace:old'],
    }));

    expect(merged.contextNamespace).toEqual({ scope: 'personal', projectId: 'repo-current' });
    expect(merged.contextNamespaceDiagnostics).toEqual(['namespace:explicit']);
  });

  it('preserves codex quota display when a transient broadcast omits or nulls it', () => {
    const existing = makeExisting({
      agentType: 'codex',
      planLabel: 'Pro',
      quotaLabel: '5h 22% 1h10m 4/6 14:40',
      quotaUsageLabel: 'legacy usage text',
      quotaMeta: {
        primary: { usedPercent: 22, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      },
    });

    const omitted = mergeSessionListEntry({
      ...BASE_INCOMING,
      agentType: 'codex',
    }, existing);
    expect(omitted.planLabel).toBe('Pro');
    expect(omitted.quotaLabel).toBe('5h 22% 1h10m 4/6 14:40');
    expect(omitted.quotaUsageLabel).toBe('legacy usage text');
    expect(omitted.quotaMeta?.primary?.usedPercent).toBe(22);

    const nulled = mergeSessionListEntry({
      ...BASE_INCOMING,
      agentType: 'codex',
      planLabel: null,
      quotaLabel: null,
      quotaUsageLabel: null,
      quotaMeta: null,
    }, existing);
    expect(nulled.planLabel).toBe('Pro');
    expect(nulled.quotaLabel).toBe('5h 22% 1h10m 4/6 14:40');
    expect(nulled.quotaUsageLabel).toBe('legacy usage text');
    expect(nulled.quotaMeta?.primary?.usedPercent).toBe(22);
  });

  it('preserves claude-code-sdk quota when a transient session_list omits it (no flicker)', () => {
    const existing = makeExisting({
      agentType: 'claude-code-sdk',
      planLabel: 'Max',
      quotaLabel: '5h 14% 4h27m 5/31 00:40 · 7d 45% 2d19h 6/2 16:00',
      quotaMeta: {
        primary: { usedPercent: 14, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: 1_800_500_000 },
      },
    });
    // A buildSessionList pass where the /api/oauth/usage poll was null (idle /
    // 30-min throttle / transient): the daemon omits quota. The footer must keep
    // the last value, not flicker blank.
    const merged = mergeSessionListEntry({ ...BASE_INCOMING, agentType: 'claude-code-sdk' }, existing);
    expect(merged.quotaLabel).toBe('5h 14% 4h27m 5/31 00:40 · 7d 45% 2d19h 6/2 16:00');
    expect(merged.quotaMeta?.primary?.usedPercent).toBe(14);
    expect(merged.quotaMeta?.secondary?.usedPercent).toBe(45);
  });

  it('allows non-codex quota display to clear when daemon reports no quota', () => {
    const existing = makeExisting({
      agentType: 'qwen',
      planLabel: 'Free',
      quotaLabel: '1,000/day',
      quotaUsageLabel: 'today 5/1000',
      quotaMeta: {
        primary: { usedPercent: 5, windowDurationMins: 1440, resetsAt: 1_800_000_000 },
      },
    });

    const merged = mergeSessionListEntry({
      ...BASE_INCOMING,
      agentType: 'qwen',
      planLabel: null,
      quotaLabel: null,
      quotaUsageLabel: null,
      quotaMeta: null,
    }, existing);

    expect(merged.planLabel).toBeUndefined();
    expect(merged.quotaLabel).toBeUndefined();
    expect(merged.quotaUsageLabel).toBeUndefined();
    expect(merged.quotaMeta).toBeUndefined();
  });

  it('preserves and infers transport runtime type when a partial broadcast omits runtimeType', () => {
    const merged = mergeSessionListEntry({
      ...BASE_INCOMING,
      runtimeType: undefined,
      agentType: 'copilot-sdk',
    }, makeExisting({ agentType: 'copilot-sdk', runtimeType: 'transport' }));

    expect(merged.runtimeType).toBe('transport');
  });

  it('clears pending messages when daemon reports a terminal state', () => {
    const existing = makeExisting({
      state: 'running',
      transportPendingMessages: ['pending one'],
      transportPendingMessageEntries: [{ clientMessageId: 'id-1', text: 'pending one' }],
    });

    const merged = mergeSessionListEntry({ ...BASE_INCOMING, state: 'idle' }, existing);

    expect(merged.transportPendingMessages).toEqual([]);
    expect(merged.transportPendingMessageEntries).toEqual([]);
  });

  it('keeps the existing pending queue on running state when broadcast omits it', () => {
    const existing = makeExisting({
      state: 'running',
      transportPendingMessages: ['pending one'],
      transportPendingMessageEntries: [{ clientMessageId: 'id-1', text: 'pending one' }],
    });

    const merged = mergeSessionListEntry({ ...BASE_INCOMING, state: 'running' }, existing);

    expect(merged.transportPendingMessages).toEqual(['pending one']);
    expect(merged.transportPendingMessageEntries).toEqual([{ clientMessageId: 'id-1', text: 'pending one' }]);
  });

  it('keeps an explicit queued snapshot even when the daemon session state is idle', () => {
    const existing = makeExisting({
      state: 'running',
      transportPendingMessages: ['stale pending'],
      transportPendingMessageEntries: [{ clientMessageId: 'id-stale', text: 'stale pending' }],
    });

    const merged = mergeSessionListEntry({
      ...BASE_INCOMING,
      state: 'idle',
      transportPendingMessages: ['pending one'],
      transportPendingMessageEntries: [{ clientMessageId: 'id-1', text: 'pending one' }],
    }, existing);

    expect(merged.transportPendingMessages).toEqual(['pending one']);
    expect(merged.transportPendingMessageEntries).toEqual([{ clientMessageId: 'id-1', text: 'pending one' }]);
  });

  it('clears the existing queue when running snapshot carries explicit empty arrays', () => {
    const existing = makeExisting({
      state: 'running',
      transportPendingMessages: ['pending one'],
      transportPendingMessageEntries: [{ clientMessageId: 'id-1', text: 'pending one' }],
    });

    const merged = mergeSessionListEntry({
      ...BASE_INCOMING,
      state: 'running',
      transportPendingMessages: [],
      transportPendingMessageEntries: [],
    }, existing);

    expect(merged.transportPendingMessages).toEqual([]);
    expect(merged.transportPendingMessageEntries).toEqual([]);
  });
});

describe('session navigation visibility', () => {
  it('parses main brain and worker session names without losing underscored project slugs', () => {
    expect(parseMainSessionName('deck_my_proj_brain')).toEqual({
      project: 'my_proj',
      role: 'brain',
    });
    expect(parseMainSessionName('deck_my_proj_w12')).toEqual({
      project: 'my_proj',
      role: 'w12',
    });
  });

  it('identifies sub-sessions and worker main sessions as hidden from top-level navigation', () => {
    expect(isSubSessionName('deck_sub_abc123')).toBe(true);
    expect(isWorkerSessionName('deck_proj_w1')).toBe(true);
    expect(isNavigableMainSession({ name: 'deck_sub_abc123', role: 'brain' })).toBe(false);
    expect(isNavigableMainSession({ name: 'deck_proj_w1', role: 'w1' })).toBe(false);
    expect(isNavigableMainSession({ name: 'deck_proj_w1', role: 'brain' })).toBe(false);
  });

  it('keeps only brain sessions visible as independent top-level windows', () => {
    expect(isNavigableMainSession({ name: 'deck_proj_brain', role: 'brain' })).toBe(true);
    expect(isNavigableMainSession({ name: 'deck_proj_brain', role: 'w1' })).toBe(false);
    expect(isNavigableMainSession({ name: 'custom_session', role: 'brain' })).toBe(true);
  });
});

describe('mergeSessionListEntry — pending-queue version guard', () => {
  // Regression: UI/daemon queue desync. A `session_list` heartbeat can be
  // built before a drain but delivered after it. Without the version guard it
  // would replace the (correctly cleared) queue with its stale pre-drain
  // snapshot, resurrecting already-drained entries in the UI.
  const existing: SessionInfo = {
    name: 'deck_proj_brain',
    project: 'proj',
    role: 'brain',
    agentType: 'codex-sdk',
    state: 'running',
    runtimeType: 'transport',
    transportPendingMessages: [],
    transportPendingMessageEntries: [],
    transportPendingMessageVersion: 7,
  };

  it('ignores a stale snapshot (older version) and keeps the existing cleared queue', () => {
    const merged = mergeSessionListEntry({
      ...BASE_INCOMING,
      state: 'running',
      transportPendingMessages: ['stale one', 'stale two'],
      transportPendingMessageEntries: [
        { clientMessageId: 'm1', text: 'stale one' },
        { clientMessageId: 'm2', text: 'stale two' },
      ],
      transportPendingMessageVersion: 5, // older than existing (7)
    }, existing);
    expect(merged.transportPendingMessages).toEqual([]);
    expect(merged.transportPendingMessageEntries).toEqual([]);
    expect(merged.transportPendingMessageVersion).toBe(7);
  });

  it('applies a newer snapshot and advances the baseline', () => {
    const merged = mergeSessionListEntry({
      ...BASE_INCOMING,
      state: 'queued',
      transportPendingMessages: ['fresh one'],
      transportPendingMessageEntries: [{ clientMessageId: 'm9', text: 'fresh one' }],
      transportPendingMessageVersion: 9,
    }, existing);
    expect(merged.transportPendingMessageEntries).toEqual([{ clientMessageId: 'm9', text: 'fresh one' }]);
    expect(merged.transportPendingMessageVersion).toBe(9);
  });

  it('accepts an equal-version snapshot (idempotent redelivery)', () => {
    const merged = mergeSessionListEntry({
      ...BASE_INCOMING,
      state: 'queued',
      transportPendingMessages: ['v7 entry'],
      transportPendingMessageEntries: [{ clientMessageId: 'm7', text: 'v7 entry' }],
      transportPendingMessageVersion: 7,
    }, existing);
    expect(merged.transportPendingMessageEntries).toEqual([{ clientMessageId: 'm7', text: 'v7 entry' }]);
    expect(merged.transportPendingMessageVersion).toBe(7);
  });

  it('accepts a fresh-runtime snapshot (version 0) even when the baseline is higher', () => {
    // After a provider restart the runtime version resets to 0; that snapshot
    // must win so the queue does not get stuck behind a stale-high baseline.
    const merged = mergeSessionListEntry({
      ...BASE_INCOMING,
      state: 'idle',
      transportPendingMessages: [],
      transportPendingMessageEntries: [],
      transportPendingMessageVersion: 0,
    }, existing);
    expect(merged.transportPendingMessageVersion).toBe(0);
  });

  it('applies snapshots from a legacy daemon that omits the version (backward compatible)', () => {
    const merged = mergeSessionListEntry({
      ...BASE_INCOMING,
      state: 'queued',
      transportPendingMessages: ['legacy one'],
      transportPendingMessageEntries: [{ clientMessageId: 'mL', text: 'legacy one' }],
      // no transportPendingMessageVersion
    }, existing);
    expect(merged.transportPendingMessageEntries).toEqual([{ clientMessageId: 'mL', text: 'legacy one' }]);
    // Baseline unchanged when the snapshot is unversioned.
    expect(merged.transportPendingMessageVersion).toBe(7);
  });
});
