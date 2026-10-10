import { describe, expect, it } from 'vitest';
import { filterShareDaemonMessage } from '../src/ws/share-policy.js';
import type { EffectiveCoverage, ShareTarget } from '../../shared/tab-sharing.js';
import {
  PROVIDER_QUOTA_GROUP_ID_MAX_CHARS,
  PROVIDER_QUOTA_GROUP_LABEL_MAX_CHARS,
  PROVIDER_QUOTA_MAX_GROUPS,
} from '../../shared/provider-quota.js';

const serverId = 'srv-quota-test-1';
const now = 1_800_000_000_000;

function socket(target: ShareTarget, effectiveRole: EffectiveCoverage['effectiveRole'] = 'participant') {
  return {
    userId: 'shared-user-1',
    target,
    connectedAt: now,
    ticketId: 'ticket-1',
    snapshot: {
      target,
      effectiveRole,
      historyCutoffAt: 0,
      nextCoverageRecheckAt: null,
      coveringShareIds: ['share-1'],
      primaryShareId: 'share-1',
      authorizedAt: now,
    },
  };
}

const target: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_session_1' };

describe('server share-policy participant quota projection with groups', () => {
  it('participant view keeps well-formed groups', () => {
    const rawSession = {
      name: 'deck_session_1',
      state: 'idle',
      quotaLabel: 'Gemini 5h 20% · 7d 10% | Claude/GPT 5h 50% · 7d 30%',
      quotaUsageLabel: '2/5',
      quotaMeta: {
        groups: [
          {
            id: 'gemini',
            label: 'Gemini',
            primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_700_000_000 },
            secondary: { usedPercent: 10, windowDurationMins: 10_080, resetsAt: 1_700_500_000 },
          },
          {
            id: 'claude-gpt',
            label: 'Claude/GPT',
            primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1_700_100_000 },
            secondary: { usedPercent: 30, windowDurationMins: 10_080, resetsAt: 1_700_600_000 },
          },
        ],
      },
    };

    const delivered = filterShareDaemonMessage(
      { type: 'session_list', serverId, sessions: [rawSession] },
      socket(target, 'participant'),
    );
    const [out] = delivered?.sessions as Array<Record<string, unknown>>;
    expect(out.quotaLabel).toBe('Gemini 5h 20% · 7d 10% | Claude/GPT 5h 50% · 7d 30%');
    expect(out.quotaUsageLabel).toBe('2/5');
    expect(out.quotaMeta).toEqual({
      groups: [
        {
          id: 'gemini',
          label: 'Gemini',
          primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_700_000_000 },
          secondary: { usedPercent: 10, windowDurationMins: 10_080, resetsAt: 1_700_500_000 },
        },
        {
          id: 'claude-gpt',
          label: 'Claude/GPT',
          primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1_700_100_000 },
          secondary: { usedPercent: 30, windowDurationMins: 10_080, resetsAt: 1_700_600_000 },
        },
      ],
    });
  });

  it('strips unknown keys on meta and group objects (whitelist semantics)', () => {
    const rawSession = {
      name: 'deck_session_1',
      state: 'idle',
      quotaMeta: {
        groups: [
          {
            id: 'gemini',
            label: 'Gemini',
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_700_000_000, secretToken: 'primary-token' },
            unauthorizedGroupField: 'group-secret',
          },
        ],
        extraMetaSecret: 'meta-secret',
        internalAccount: 'acct-12345',
      },
    };

    const delivered = filterShareDaemonMessage(
      { type: 'session_list', serverId, sessions: [rawSession] },
      socket(target, 'participant'),
    );
    const [out] = delivered?.sessions as Array<Record<string, unknown>>;
    const meta = out.quotaMeta as Record<string, unknown>;
    expect(meta).toEqual({
      groups: [
        {
          id: 'gemini',
          label: 'Gemini',
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_700_000_000 },
        },
      ],
    });
    expect(meta.extraMetaSecret).toBeUndefined();
    expect(meta.internalAccount).toBeUndefined();
    const group0 = (meta.groups as Array<Record<string, unknown>>)[0];
    expect(group0.unauthorizedGroupField).toBeUndefined();
    expect((group0.primary as Record<string, unknown>).secretToken).toBeUndefined();
  });

  it('clamps usedPercent to 0..100', () => {
    const rawSession = {
      name: 'deck_session_1',
      state: 'idle',
      quotaMeta: {
        groups: [
          {
            id: 'gemini',
            label: 'Gemini',
            primary: { usedPercent: 125, windowDurationMins: 300 },
            secondary: { usedPercent: -50, windowDurationMins: 10_080 },
          },
        ],
      },
    };

    const delivered = filterShareDaemonMessage(
      { type: 'session_list', serverId, sessions: [rawSession] },
      socket(target, 'participant'),
    );
    const [out] = delivered?.sessions as Array<Record<string, unknown>>;
    expect(out.quotaMeta).toEqual({
      groups: [
        {
          id: 'gemini',
          label: 'Gemini',
          primary: { usedPercent: 100, windowDurationMins: 300 },
          secondary: { usedPercent: 0, windowDurationMins: 10_080 },
        },
      ],
    });
  });

  it('bounds groups beyond the cap (8) and over-long labels and ids (64)', () => {
    const oversizedId = 'id_'.repeat(30); // 90 chars
    const oversizedLabel = 'label_'.repeat(20); // 120 chars

    const twelveGroups = Array.from({ length: 12 }, (_, i) => ({
      id: i === 0 ? oversizedId : `group-${i}`,
      label: i === 0 ? oversizedLabel : `Label ${i}`,
      primary: { usedPercent: i * 5, windowDurationMins: 300 },
    }));

    const rawSession = {
      name: 'deck_session_1',
      state: 'idle',
      quotaMeta: {
        groups: twelveGroups,
      },
    };

    const delivered = filterShareDaemonMessage(
      { type: 'session_list', serverId, sessions: [rawSession] },
      socket(target, 'participant'),
    );
    const [out] = delivered?.sessions as Array<Record<string, unknown>>;
    const groups = (out.quotaMeta as Record<string, unknown>).groups as Array<Record<string, unknown>>;

    expect(groups).toHaveLength(PROVIDER_QUOTA_MAX_GROUPS);
    expect(groups[0].id).toBe(oversizedId.slice(0, PROVIDER_QUOTA_GROUP_ID_MAX_CHARS));
    expect(groups[0].label).toBe(oversizedLabel.slice(0, PROVIDER_QUOTA_GROUP_LABEL_MAX_CHARS));
    expect(groups[7].id).toBe('group-7');
  });

  it('survives when meta has only groups, and is dropped when meta has neither windows nor groups', () => {
    // Only groups -> preserved
    const withOnlyGroups = {
      name: 'deck_session_1',
      state: 'idle',
      quotaMeta: {
        groups: [
          {
            id: 'gemini',
            label: 'Gemini',
            primary: { usedPercent: 10, windowDurationMins: 300 },
          },
        ],
      },
    };
    const deliveredWithGroups = filterShareDaemonMessage(
      { type: 'session_list', serverId, sessions: [withOnlyGroups] },
      socket(target, 'participant'),
    );
    const [outWithGroups] = deliveredWithGroups?.sessions as Array<Record<string, unknown>>;
    expect(outWithGroups.quotaMeta).toEqual({
      groups: [
        {
          id: 'gemini',
          label: 'Gemini',
          primary: { usedPercent: 10, windowDurationMins: 300 },
        },
      ],
    });

    // Neither valid windows nor valid groups -> quotaMeta is dropped
    const withEmptyMeta = {
      name: 'deck_session_1',
      state: 'idle',
      quotaMeta: {
        groups: [{ id: '   ', label: '   ' }],
      },
    };
    const deliveredEmpty = filterShareDaemonMessage(
      { type: 'session_list', serverId, sessions: [withEmptyMeta] },
      socket(target, 'participant'),
    );
    const [outEmpty] = deliveredEmpty?.sessions as Array<Record<string, unknown>>;
    expect(outEmpty.quotaMeta).toBeUndefined();
  });

  it('keeps legacy primary/secondary projection unchanged', () => {
    const legacySession = {
      name: 'deck_session_1',
      state: 'idle',
      quotaLabel: '5h 55% 5d05h · 7d 10%',
      quotaUsageLabel: '4/5',
      quotaMeta: {
        primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 1_790_419_157 },
        secondary: { usedPercent: 10, windowDurationMins: 10_080, resetsAt: 1_790_500_000 },
        plan: 'enterprise',
      },
    };

    const delivered = filterShareDaemonMessage(
      { type: 'session_list', serverId, sessions: [legacySession] },
      socket(target, 'participant'),
    );
    const [out] = delivered?.sessions as Array<Record<string, unknown>>;
    expect(out.quotaLabel).toBe('5h 55% 5d05h · 7d 10%');
    expect(out.quotaUsageLabel).toBe('4/5');
    expect(out.quotaMeta).toEqual({
      primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 1_790_419_157 },
      secondary: { usedPercent: 10, windowDurationMins: 10_080, resetsAt: 1_790_500_000 },
    });
  });
});
