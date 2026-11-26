import { describe, it, expect } from 'vitest';
import {
  createEmptyUsageSummaryResponse,
  createEmptyUsageSummaryRow,
  type UsageSummaryResponse,
  type UsageSummaryRow,
} from '@shared/usage-analytics.js';
import { computeSessionGroup, deriveFacetOptions, bucketRowsByWeek, mondayOfWeekUtc, mergeUsageRowsBySession } from '../src/util/usage-group.js';

function row(over: Partial<UsageSummaryRow>): UsageSummaryRow {
  return { ...createEmptyUsageSummaryRow(over.key ?? 'k'), ...over };
}

function makeResponse(over: Partial<UsageSummaryResponse>): UsageSummaryResponse {
  return { ...createEmptyUsageSummaryResponse(), ...over };
}

describe('computeGroup', () => {
  const res = makeResponse({
    byMainSession: [
      row({ key: 'deck_p_brain', sessionName: 'deck_p_brain', totalTokens: 100, inputTokens: 60, cacheTokens: 10, outputTokens: 30, costUsdMicros: 1000 }),
    ],
    bySubSession: [
      row({ key: 'deck_p_w1', sessionName: 'deck_p_w1', parentSessionName: 'deck_p_brain', totalTokens: 50, costUsdMicros: 500 }),
      row({ key: 'deck_p_w2', sessionName: 'deck_p_w2', parentSessionName: 'deck_p_brain', totalTokens: 20, costUsdMicros: null }),
      row({ key: 'deck_other_w1', sessionName: 'deck_other_w1', parentSessionName: 'deck_other_brain', totalTokens: 999, costUsdMicros: 7 }),
    ],
  });

  it('aggregates a main session with its sub-sessions', () => {
    const g = computeSessionGroup(res, 'deck_p_brain');
    expect(g.root).toBe('deck_p_brain');
    expect(g.members.map((m) => `${m.kind}:${m.sessionName}`)).toEqual([
      'main:deck_p_brain', 'sub:deck_p_w1', 'sub:deck_p_w2',
    ]);
    expect(g.groupTotals.totalTokens).toBe(170);
    // cost sums only the non-null members (w2 is null, so 1000 + 500).
    expect(g.groupTotals.costUsdMicros).toBe(1500);
  });

  it('resolves the group root from a sub-session up to its parent', () => {
    const g = computeSessionGroup(res, 'deck_p_w1');
    expect(g.root).toBe('deck_p_brain');
    expect(g.groupTotals.totalTokens).toBe(170);
  });

  it('handles a group with no main-session facts (subs only)', () => {
    const g = computeSessionGroup(res, 'deck_other_w1');
    expect(g.root).toBe('deck_other_brain');
    expect(g.members).toHaveLength(1);
    expect(g.members[0]).toMatchObject({ kind: 'sub', sessionName: 'deck_other_w1' });
    expect(g.groupTotals.totalTokens).toBe(999);
  });

  it('returns costUsdMicros null when no member reports a cost', () => {
    const noCost = makeResponse({
      byMainSession: [row({ sessionName: 'deck_z_brain', totalTokens: 5, costUsdMicros: null })],
    });
    const g = computeSessionGroup(noCost, 'deck_z_brain');
    expect(g.groupTotals.costUsdMicros).toBeNull();
  });

  it('is empty for null data or unknown session', () => {
    expect(computeSessionGroup(null, 'x').members).toEqual([]);
    expect(computeSessionGroup(res, 'deck_nope').members).toEqual([]);
  });
});

describe('deriveFacetOptions', () => {
  it('returns distinct, sorted, non-empty options and drops nulls', () => {
    const res = makeResponse({
      byServer: [row({ serverId: 's2' }), row({ serverId: 's1' }), row({ serverId: 's1' }), row({ serverId: '' })],
      byProviderModel: [
        row({ provider: 'openai', model: 'gpt-5' }),
        row({ provider: 'openai', model: 'gpt-4' }),
        row({ provider: null, model: null }),
      ],
      byMainSession: [row({ sessionName: 'deck_p_brain' })],
      bySubSession: [row({ sessionName: 'deck_p_w1' }), row({ sessionName: 'deck_p_brain' })],
    });
    const opts = deriveFacetOptions(res);
    expect(opts.servers).toEqual(['s1', 's2']);
    expect(opts.providers).toEqual(['openai']);
    expect(opts.models).toEqual(['gpt-4', 'gpt-5']);
    expect(opts.sessions).toEqual(['deck_p_brain', 'deck_p_w1']);
  });

  it('returns empty lists for null input', () => {
    expect(deriveFacetOptions(null)).toEqual({ servers: [], providers: [], models: [], sessions: [] });
  });
});

describe('mergeUsageRowsBySession', () => {
  it('merges the same session name across servers and sorts by tokens desc', () => {
    const merged = mergeUsageRowsBySession([
      // deck_cd_brain appears once per server → must collapse to one row.
      row({ sessionName: 'deck_cd_brain', sessionKind: 'main', totalTokens: 10, costUsdMicros: 100 }),
      row({ sessionName: 'deck_cd_brain', sessionKind: 'main', totalTokens: 999, costUsdMicros: null }),
      row({ sessionName: 'deck_cd_w1', sessionKind: 'sub', totalTokens: 5, costUsdMicros: 5 }),
    ]);
    expect(merged).toHaveLength(2);
    // sorted desc: merged brain (1009) before w1 (5)
    expect(merged[0]).toMatchObject({ sessionName: 'deck_cd_brain', kind: 'main' });
    expect(merged[0].totals.totalTokens).toBe(1009);
    expect(merged[0].totals.costUsdMicros).toBe(100); // 100 + null → 100
    expect(merged[1]).toMatchObject({ sessionName: 'deck_cd_w1', kind: 'sub' });
    expect(merged[1].totals.totalTokens).toBe(5);
  });

  it('treats a session as main if any occurrence is main', () => {
    const merged = mergeUsageRowsBySession([
      row({ sessionName: 'x', sessionKind: 'sub', totalTokens: 1 }),
      row({ sessionName: 'x', sessionKind: 'main', totalTokens: 1 }),
    ]);
    expect(merged[0].kind).toBe('main');
  });
});

describe('week bucketing', () => {
  it('mondayOfWeekUtc returns the UTC Monday of the week', () => {
    const m = mondayOfWeekUtc('2026-07-08');
    expect(new Date(`${m}T00:00:00Z`).getUTCDay()).toBe(1); // Monday
    expect(m <= '2026-07-08').toBe(true);
  });

  it('buckets per-day rows into 7-day weeks and sums totals (cost null-safe)', () => {
    // 2026-07-08 and 2026-07-15 are exactly 7 days apart → guaranteed different weeks.
    const weeks = bucketRowsByWeek([
      row({ date: '2026-07-08', totalTokens: 10, costUsdMicros: 100 }),
      row({ date: '2026-07-08', totalTokens: 5, costUsdMicros: null }),
      row({ date: '2026-07-15', totalTokens: 20, costUsdMicros: 200 }),
      row({ date: undefined, totalTokens: 999 }), // no date → ignored
    ]);
    expect(weeks).toHaveLength(2);
    expect(weeks[0].totals.totalTokens).toBe(15);
    expect(weeks[0].totals.costUsdMicros).toBe(100); // 100 + null → 100
    expect(weeks[1].totals.totalTokens).toBe(20);
    expect(weeks[0].key < weeks[1].key).toBe(true); // ascending
    expect(new Date(`${weeks[0].key}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(new Date(`${weeks[1].key}T00:00:00Z`).getUTCDay()).toBe(1);
  });
});
