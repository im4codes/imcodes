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
import { mergeSessionListEntry, type IncomingSessionListEntry } from '../src/session-list-merge.js';
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
    }));

    expect(merged.label).toBe('Main Brain');
    expect(merged.modelDisplay).toBe('gpt-5.4');
    expect(merged.effort).toBe('high');
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
