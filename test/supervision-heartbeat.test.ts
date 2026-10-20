import { describe, expect, it } from 'vitest';
import {
  SUPERVISION_HEARTBEAT_KIND,
  SUPERVISION_HEARTBEAT_STATE,
  parseSupervisionHeartbeatSnapshot,
} from '../shared/supervision-heartbeat.js';

describe('supervision heartbeat wire contract', () => {
  it('round-trips armed deadlines and strips stale deadline data from paused states', () => {
    expect(parseSupervisionHeartbeatSnapshot({
      state: SUPERVISION_HEARTBEAT_STATE.ARMED,
      kind: SUPERVISION_HEARTBEAT_KIND.AUDIT,
      nextHeartbeatAt: 2_000,
      updatedAt: 1_000,
    })).toEqual({
      state: SUPERVISION_HEARTBEAT_STATE.ARMED,
      kind: SUPERVISION_HEARTBEAT_KIND.AUDIT,
      nextHeartbeatAt: 2_000,
      updatedAt: 1_000,
    });

    expect(parseSupervisionHeartbeatSnapshot({
      state: SUPERVISION_HEARTBEAT_STATE.PAUSED_NEEDS_INPUT,
      kind: SUPERVISION_HEARTBEAT_KIND.WAITING,
      nextHeartbeatAt: 9_999,
      updatedAt: 1_000,
    })).toEqual({
      state: SUPERVISION_HEARTBEAT_STATE.PAUSED_NEEDS_INPUT,
      kind: SUPERVISION_HEARTBEAT_KIND.WAITING,
      updatedAt: 1_000,
    });
  });

  it('fails closed on malformed state, kind, timestamp, or incomplete armed data', () => {
    expect(parseSupervisionHeartbeatSnapshot(null)).toBeNull();
    expect(parseSupervisionHeartbeatSnapshot({ state: 'future', updatedAt: 1 })).toBeNull();
    expect(parseSupervisionHeartbeatSnapshot({ state: 'armed', updatedAt: 1 })).toBeNull();
    expect(parseSupervisionHeartbeatSnapshot({
      state: 'armed', kind: 'future', nextHeartbeatAt: 2, updatedAt: 1,
    })).toBeNull();
    expect(parseSupervisionHeartbeatSnapshot({
      state: 'armed', kind: 'waiting', nextHeartbeatAt: Number.NaN, updatedAt: 1,
    })).toBeNull();
  });
});
