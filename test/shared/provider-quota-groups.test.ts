import { describe, expect, it } from 'vitest';
import {
  PROVIDER_QUOTA_GROUP_ID_MAX_CHARS,
  PROVIDER_QUOTA_GROUP_LABEL_MAX_CHARS,
  PROVIDER_QUOTA_MAX_GROUPS,
  formatProviderQuotaLabel,
  formatProviderQuotaTitle,
  formatResetDateTime,
  providerQuotaMetaEquals,
  sanitizeProviderQuotaGroup,
  sanitizeProviderQuotaMeta,
  type ProviderQuotaGroup,
  type ProviderQuotaMeta,
} from '../../shared/provider-quota.js';
import {
  PROVIDER_QUOTA_GROUP_ID,
  PROVIDER_QUOTA_GROUP_LABEL,
} from '../../shared/agy-agent.js';

describe('provider-quota groups and formatting contract', () => {
  const fixedNowMs = 1_717_038_000_000; // 2024-05-30T03:00:00.000Z
  const fixedNowSec = Math.floor(fixedNowMs / 1000);

  const geminiReset5hSec = fixedNowSec + 3 * 3600 + 10 * 60; // +3h10m
  const geminiReset7dSec = fixedNowSec + 5 * 86400 + 2 * 3600; // +5d02h
  const claudeReset5hSec = fixedNowSec + 1 * 3600 + 5 * 60; // +1h05m
  const claudeReset7dSec = fixedNowSec + 2 * 86400 + 3 * 3600; // +2d03h

  const geminiGroup: ProviderQuotaGroup = {
    id: PROVIDER_QUOTA_GROUP_ID.GEMINI,
    label: PROVIDER_QUOTA_GROUP_LABEL.GEMINI,
    primary: {
      usedPercent: 12,
      windowDurationMins: 300,
      resetsAt: geminiReset5hSec,
    },
    secondary: {
      usedPercent: 4,
      windowDurationMins: 10_080,
      resetsAt: geminiReset7dSec,
    },
  };

  const claudeGptGroup: ProviderQuotaGroup = {
    id: PROVIDER_QUOTA_GROUP_ID.CLAUDE_GPT,
    label: PROVIDER_QUOTA_GROUP_LABEL.CLAUDE_GPT,
    primary: {
      usedPercent: 80,
      windowDurationMins: 300,
      resetsAt: claudeReset5hSec,
    },
    secondary: {
      usedPercent: 41,
      windowDurationMins: 10_080,
      resetsAt: claudeReset7dSec,
    },
  };

  it('renders a single-line label for grouped quota joining groups with " | " and omitting absolute reset date-times', () => {
    const meta: ProviderQuotaMeta = {
      groups: [geminiGroup, claudeGptGroup],
    };

    const label = formatProviderQuotaLabel(meta, fixedNowMs);
    expect(label).toBe('Gemini 5h 12% 3h10m · 7d 4% 5d02h | Claude/GPT 5h 80% 1h05m · 7d 41% 2d03h');
    expect(label).not.toContain('\n');

    // Confirm absolute reset date-time strings are omitted
    const abs5h = formatResetDateTime(geminiReset5hSec);
    const abs7d = formatResetDateTime(geminiReset7dSec);
    expect(abs5h).toBeDefined();
    expect(label).not.toContain(abs5h!);
    expect(abs7d).toBeDefined();
    expect(label).not.toContain(abs7d!);
  });

  it('omits usedPercent when not present on a window in grouped mode', () => {
    const meta: ProviderQuotaMeta = {
      groups: [
        {
          id: PROVIDER_QUOTA_GROUP_ID.GEMINI,
          label: PROVIDER_QUOTA_GROUP_LABEL.GEMINI,
          primary: {
            windowDurationMins: 300,
            resetsAt: geminiReset5hSec,
          },
          secondary: {
            usedPercent: 4,
            windowDurationMins: 10_080,
            resetsAt: geminiReset7dSec,
          },
        },
      ],
    };

    const label = formatProviderQuotaLabel(meta, fixedNowMs);
    expect(label).toBe('Gemini 5h 3h10m · 7d 4% 5d02h');
  });

  it('handles groups with only primary or only secondary window', () => {
    const primaryOnly: ProviderQuotaMeta = {
      groups: [
        {
          id: PROVIDER_QUOTA_GROUP_ID.GEMINI,
          label: PROVIDER_QUOTA_GROUP_LABEL.GEMINI,
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: geminiReset5hSec },
        },
      ],
    };
    expect(formatProviderQuotaLabel(primaryOnly, fixedNowMs)).toBe('Gemini 5h 12% 3h10m');

    const secondaryOnly: ProviderQuotaMeta = {
      groups: [
        {
          id: PROVIDER_QUOTA_GROUP_ID.CLAUDE_GPT,
          label: PROVIDER_QUOTA_GROUP_LABEL.CLAUDE_GPT,
          secondary: { usedPercent: 41, windowDurationMins: 10_080, resetsAt: claudeReset7dSec },
        },
      ],
    };
    expect(formatProviderQuotaLabel(secondaryOnly, fixedNowMs)).toBe('Claude/GPT 7d 41% 2d03h');
  });

  it('prefers groups over legacy primary/secondary windows when both are present', () => {
    const meta: ProviderQuotaMeta = {
      primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: fixedNowSec + 60 },
      secondary: { usedPercent: 99, windowDurationMins: 10_080, resetsAt: fixedNowSec + 60 },
      groups: [geminiGroup, claudeGptGroup],
    };

    const label = formatProviderQuotaLabel(meta, fixedNowMs);
    expect(label).toBe('Gemini 5h 12% 3h10m · 7d 4% 5d02h | Claude/GPT 5h 80% 1h05m · 7d 41% 2d03h');
    expect(label).not.toContain('99%');

    const title = formatProviderQuotaTitle(meta, fixedNowMs);
    expect(title).toContain('Gemini 5h 12% 3h10m');
    expect(title).toContain('Claude/GPT 5h 80% 1h05m');
    expect(title).not.toContain('99%');
  });

  it('formatProviderQuotaTitle returns full multi-line detail with absolute resets', () => {
    const meta: ProviderQuotaMeta = {
      groups: [geminiGroup, claudeGptGroup],
    };

    const title = formatProviderQuotaTitle(meta, fixedNowMs);
    expect(title).toBeDefined();

    const lines = title!.split('\n');
    expect(lines).toHaveLength(2);

    const absGemini5h = formatResetDateTime(geminiReset5hSec)!;
    const absGemini7d = formatResetDateTime(geminiReset7dSec)!;
    const absClaude5h = formatResetDateTime(claudeReset5hSec)!;
    const absClaude7d = formatResetDateTime(claudeReset7dSec)!;

    expect(lines[0]).toBe(`Gemini 5h 12% 3h10m ${absGemini5h} · 7d 4% 5d02h ${absGemini7d}`);
    expect(lines[1]).toBe(`Claude/GPT 5h 80% 1h05m ${absClaude5h} · 7d 41% 2d03h ${absClaude7d}`);
  });

  it('providerQuotaMetaEquals compares groups order-sensitively by id, label, and windows', () => {
    const metaA: ProviderQuotaMeta = {
      groups: [geminiGroup, claudeGptGroup],
    };
    const metaB: ProviderQuotaMeta = {
      groups: [geminiGroup, claudeGptGroup],
    };
    expect(providerQuotaMetaEquals(metaA, metaB)).toBe(true);

    // Reversed order
    const metaReversed: ProviderQuotaMeta = {
      groups: [claudeGptGroup, geminiGroup],
    };
    expect(providerQuotaMetaEquals(metaA, metaReversed)).toBe(false);

    // Mismatched group id
    const metaDiffId: ProviderQuotaMeta = {
      groups: [{ ...geminiGroup, id: 'other' }, claudeGptGroup],
    };
    expect(providerQuotaMetaEquals(metaA, metaDiffId)).toBe(false);

    // Mismatched group label
    const metaDiffLabel: ProviderQuotaMeta = {
      groups: [{ ...geminiGroup, label: 'Gemini 2.0' }, claudeGptGroup],
    };
    expect(providerQuotaMetaEquals(metaA, metaDiffLabel)).toBe(false);

    // Mismatched window usedPercent
    const metaDiffPercent: ProviderQuotaMeta = {
      groups: [
        {
          ...geminiGroup,
          primary: { ...geminiGroup.primary, usedPercent: 13 },
        },
        claudeGptGroup,
      ],
    };
    expect(providerQuotaMetaEquals(metaA, metaDiffPercent)).toBe(false);

    // Groups vs no groups
    expect(providerQuotaMetaEquals(metaA, { primary: geminiGroup.primary })).toBe(false);
    expect(providerQuotaMetaEquals({ groups: [] }, {})).toBe(true);
    expect(providerQuotaMetaEquals(undefined, undefined)).toBe(true);
  });

  it('keeps legacy output byte-for-byte identical when no groups are present (snapshots computed before change)', () => {
    const legacyPrimaryOnly: ProviderQuotaMeta = {
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: geminiReset5hSec },
    };
    const legacyBoth: ProviderQuotaMeta = {
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: geminiReset5hSec },
      secondary: { usedPercent: 4, windowDurationMins: 10_080, resetsAt: geminiReset7dSec },
    };
    const legacyNoPercent: ProviderQuotaMeta = {
      primary: { windowDurationMins: 300, resetsAt: geminiReset5hSec },
      secondary: { usedPercent: 4, windowDurationMins: 10_080, resetsAt: geminiReset7dSec },
    };

    expect(formatProviderQuotaLabel(null, fixedNowMs)).toBeUndefined();
    expect(formatProviderQuotaLabel({}, fixedNowMs)).toBeUndefined();

    const absGemini5h = formatResetDateTime(geminiReset5hSec)!;
    const absGemini7d = formatResetDateTime(geminiReset7dSec)!;

    expect(formatProviderQuotaLabel(legacyPrimaryOnly, fixedNowMs)).toBe(`5h 12% 3h10m ${absGemini5h}`);
    expect(formatProviderQuotaLabel(legacyBoth, fixedNowMs)).toBe(`5h 12% 3h10m ${absGemini5h} · 7d 4% 5d02h ${absGemini7d}`);
    expect(formatProviderQuotaLabel(legacyNoPercent, fixedNowMs)).toBe(`5h 3h10m ${absGemini5h} · 7d 4% 5d02h ${absGemini7d}`);

    expect(providerQuotaMetaEquals(legacyBoth, { ...legacyBoth })).toBe(true);
    expect(providerQuotaMetaEquals(legacyBoth, legacyPrimaryOnly)).toBe(false);
  });

  it('sanitizes and projects grouped quota metadata preserving valid fields and discarding invalid ones', () => {
    const raw = {
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 123456 },
      groups: [
        {
          id: 'gemini',
          label: 'Gemini',
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 123456 },
          secondary: { usedPercent: 4, windowDurationMins: 10_080, resetsAt: 654321 },
          extraInternalField: 'should-be-stripped',
        },
        {
          id: '', // invalid: empty id
          label: 'Empty',
          primary: { usedPercent: 10 },
        },
      ],
      internalDaemonSecret: 'forbidden',
    };

    const sanitized = sanitizeProviderQuotaMeta(raw);
    expect(sanitized).toEqual({
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 123456 },
      groups: [
        {
          id: 'gemini',
          label: 'Gemini',
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 123456 },
          secondary: { usedPercent: 4, windowDurationMins: 10_080, resetsAt: 654321 },
        },
      ],
    });
    expect((sanitized as Record<string, unknown>).internalDaemonSecret).toBeUndefined();
    expect((sanitized?.groups?.[0] as Record<string, unknown>).extraInternalField).toBeUndefined();
  });

  it('enforces trust-boundary limits on groups count, label length, id length, and clamps percent', () => {
    const oversizedId = 'a'.repeat(PROVIDER_QUOTA_GROUP_ID_MAX_CHARS + 50);
    const oversizedLabel = 'b'.repeat(PROVIDER_QUOTA_GROUP_LABEL_MAX_CHARS + 50);

    const single = sanitizeProviderQuotaGroup({
      id: `  ${oversizedId}  `,
      label: `  ${oversizedLabel}  `,
      primary: { usedPercent: 150, windowDurationMins: 300, resetsAt: 1000 },
      secondary: { usedPercent: -20, windowDurationMins: 10_080, resetsAt: 2000 },
      unknownGarbage: 123,
    });

    expect(single).toBeDefined();
    expect(single!.id).toBe(oversizedId.slice(0, PROVIDER_QUOTA_GROUP_ID_MAX_CHARS));
    expect(single!.label).toBe(oversizedLabel.slice(0, PROVIDER_QUOTA_GROUP_LABEL_MAX_CHARS));
    expect(single!.primary?.usedPercent).toBe(100);
    expect(single!.secondary?.usedPercent).toBe(0);
    expect((single as Record<string, unknown>).unknownGarbage).toBeUndefined();

    // Max groups bounding (PROVIDER_QUOTA_MAX_GROUPS = 8)
    const tenGroups = Array.from({ length: 10 }, (_, i) => ({
      id: `group-${i}`,
      label: `Group ${i}`,
      primary: { usedPercent: i * 10, windowDurationMins: 300 },
    }));

    const rawInput = {
      groups: tenGroups,
      extraKey: 'dropped',
    };
    const inputCopy = JSON.parse(JSON.stringify(rawInput));

    const sanitized = sanitizeProviderQuotaMeta(rawInput);
    expect(sanitized).toBeDefined();
    expect(sanitized!.groups).toHaveLength(PROVIDER_QUOTA_MAX_GROUPS);
    expect(sanitized!.groups![0].id).toBe('group-0');
    expect(sanitized!.groups![7].id).toBe('group-7');
    expect((sanitized as Record<string, unknown>).extraKey).toBeUndefined();

    // Verify rawInput was not mutated
    expect(rawInput).toEqual(inputCopy);
  });

  it('drops empty groups and returns undefined for empty metadata', () => {
    // Only whitespace in id or label
    expect(sanitizeProviderQuotaGroup({ id: '   ', label: 'Valid', primary: { usedPercent: 50 } })).toBeUndefined();
    expect(sanitizeProviderQuotaGroup({ id: 'valid', label: '   ', primary: { usedPercent: 50 } })).toBeUndefined();

    // Group with no valid primary or secondary windows
    expect(sanitizeProviderQuotaGroup({ id: 'valid', label: 'Valid' })).toBeUndefined();
    expect(sanitizeProviderQuotaGroup({ id: 'valid', label: 'Valid', primary: {} })).toBeUndefined();

    // Meta with only invalid groups and no windows returns undefined
    expect(sanitizeProviderQuotaMeta({ groups: [{ id: ' ' }] })).toBeUndefined();
    expect(sanitizeProviderQuotaMeta({})).toBeUndefined();

    // Meta with only groups (no primary/secondary windows) survives
    const onlyGroupsMeta = sanitizeProviderQuotaMeta({
      groups: [{ id: 'gemini', label: 'Gemini', primary: { usedPercent: 5 } }],
    });
    expect(onlyGroupsMeta).toEqual({
      groups: [{ id: 'gemini', label: 'Gemini', primary: { usedPercent: 5 } }],
    });
  });
});
