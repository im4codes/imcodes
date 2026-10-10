/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/preact';
import { h } from 'preact';

const toolPref = vi.hoisted(() => ({
  value: true as boolean | null,
  save: vi.fn(async (_value: boolean) => undefined),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'session.provider_quota_title') return `Quota: ${String(opts?.value ?? '')}`;
      return key;
    },
  }),
}));

vi.mock('../../src/cost-tracker.js', () => ({
  getSessionCost: () => 0,
  getWeeklyCost: () => 0,
  getMonthlyCost: () => 0,
  formatCost: (n: number) => `$${n.toFixed(2)}`,
}));

vi.mock('../../src/hooks/usePref.js', () => ({
  parseBooleanish: (raw: unknown) => (raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null),
  usePref: () => ({
    value: toolPref.value,
    rawValue: toolPref.value,
    loaded: true,
    loading: false,
    stale: false,
    error: null,
    save: toolPref.save,
    set: () => undefined,
    reload: async () => toolPref.value,
  }),
}));

vi.mock('../../src/api/usage-summary.js', () => ({
  fetchUsageSummary: vi.fn(() => new Promise(() => undefined)),
}));

import {
  isCompactProviderQuotaAgent,
  ProviderQuotaLine,
} from '../../src/components/ProviderQuotaLine.js';
import { UsageFooter } from '../../src/components/UsageFooter.js';
import {
  AGY_SDK_PROVIDER_ID,
  PROVIDER_QUOTA_GROUP_ID,
  PROVIDER_QUOTA_GROUP_LABEL,
} from '@shared/agy-agent.js';
import {
  formatProviderQuotaTitle,
  type ProviderQuotaMeta,
} from '@shared/provider-quota.js';

describe('ProviderQuotaLine and UsageFooter grouped quota rendering', () => {
  afterEach(() => {
    cleanup();
  });

  const fixedNowMs = 1_717_038_000_000;
  const fixedNowSec = Math.floor(fixedNowMs / 1000);

  const geminiReset5hSec = fixedNowSec + 3 * 3600 + 10 * 60;
  const geminiReset7dSec = fixedNowSec + 5 * 86400 + 2 * 3600;
  const claudeReset5hSec = fixedNowSec + 1 * 3600 + 5 * 60;
  const claudeReset7dSec = fixedNowSec + 2 * 86400 + 3 * 3600;

  const groupedMeta: ProviderQuotaMeta = {
    groups: [
      {
        id: PROVIDER_QUOTA_GROUP_ID.GEMINI,
        label: PROVIDER_QUOTA_GROUP_LABEL.GEMINI,
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: geminiReset5hSec },
        secondary: { usedPercent: 4, windowDurationMins: 10_080, resetsAt: geminiReset7dSec },
      },
      {
        id: PROVIDER_QUOTA_GROUP_ID.CLAUDE_GPT,
        label: PROVIDER_QUOTA_GROUP_LABEL.CLAUDE_GPT,
        primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: claudeReset5hSec },
        secondary: { usedPercent: 41, windowDurationMins: 10_080, resetsAt: claudeReset7dSec },
      },
    ],
  };

  it('isCompactProviderQuotaAgent recognizes AGY_SDK_PROVIDER_ID alongside codex and claude', () => {
    expect(isCompactProviderQuotaAgent(AGY_SDK_PROVIDER_ID)).toBe(true);
    expect(isCompactProviderQuotaAgent('agy-sdk')).toBe(true);
    expect(isCompactProviderQuotaAgent('codex')).toBe(true);
    expect(isCompactProviderQuotaAgent('codex-sdk')).toBe(true);
    expect(isCompactProviderQuotaAgent('claude-code-sdk')).toBe(true);
    expect(isCompactProviderQuotaAgent('gemini')).toBe(false);
    expect(isCompactProviderQuotaAgent('shell')).toBe(false);
    expect(isCompactProviderQuotaAgent('script')).toBe(false);
    expect(isCompactProviderQuotaAgent(undefined)).toBe(false);
    expect(isCompactProviderQuotaAgent(null)).toBe(false);
  });

  it('renders ProviderQuotaLine as a single text node and passes title attribute', () => {
    const text = 'Gemini 5h 12% 3h10m · 7d 4% 5d02h';
    const title = 'Gemini Full Detail Tooltip';
    const { container } = render(
      <ProviderQuotaLine text={text} className="session-usage-codex-line-grouped" title={title} />,
    );

    const span = container.querySelector('.session-usage-codex-line-compact');
    expect(span).toBeTruthy();
    expect(span?.classList.contains('session-usage-codex-line')).toBe(true);
    expect(span?.classList.contains('session-usage-codex-line-compact')).toBe(true);
    expect(span?.classList.contains('session-usage-codex-line-grouped')).toBe(true);
    expect(span?.getAttribute('title')).toBe(title);
    expect(span?.textContent).toBe(text);
    expect(span?.childNodes.length).toBe(1);
  });

  it('renders grouped quota for agy-sdk in UsageFooter on one row with title tooltip and ellipsis class', () => {
    const expectedTitle = formatProviderQuotaTitle(groupedMeta, fixedNowMs);
    const { container } = render(
      <UsageFooter
        usage={{
          inputTokens: 1000,
          cacheTokens: 500,
          contextWindow: 1_000_000,
          model: 'gemini-2.5-pro',
        }}
        sessionName="deck_test_agy"
        agentType={AGY_SDK_PROVIDER_ID}
        quotaMeta={groupedMeta}
        now={fixedNowMs}
      />,
    );

    const lineElements = container.querySelectorAll('.session-usage-codex-line-compact');
    expect(lineElements).toHaveLength(1);

    const quotaElement = lineElements[0] as HTMLElement;
    expect(quotaElement.textContent).toBe(
      'Gemini 5h 12% 3h10m · 7d 4% 5d02h | Claude/GPT 5h 80% 1h05m · 7d 41% 2d03h',
    );
    expect(quotaElement.classList.contains('session-usage-codex-line-grouped')).toBe(true);
    expect(quotaElement.getAttribute('title')).toBe(expectedTitle);
    expect(expectedTitle).toContain('\n');
  });

  it('keeps title attribute and grouped class absent for legacy non-grouped quota', () => {
    const legacyMeta: ProviderQuotaMeta = {
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: geminiReset5hSec },
    };

    const { container } = render(
      <UsageFooter
        usage={{
          inputTokens: 1000,
          cacheTokens: 500,
          contextWindow: 1_000_000,
          model: 'codex-model',
        }}
        sessionName="deck_test_legacy"
        agentType="codex-sdk"
        quotaMeta={legacyMeta}
        now={fixedNowMs}
      />,
    );

    const lineElements = container.querySelectorAll('.session-usage-codex-line-compact');
    expect(lineElements).toHaveLength(1);

    const quotaElement = lineElements[0] as HTMLElement;
    expect(quotaElement.classList.contains('session-usage-codex-line-grouped')).toBe(false);
    expect(quotaElement.getAttribute('title')).toBeNull();
  });

  it('does not render compact provider quota line for non-compact agents', () => {
    const { container } = render(
      <UsageFooter
        usage={{
          inputTokens: 1000,
          cacheTokens: 500,
          contextWindow: 1_000_000,
          model: 'gemini-pro',
        }}
        sessionName="deck_test_gemini"
        agentType="gemini"
        quotaMeta={groupedMeta}
        now={fixedNowMs}
      />,
    );

    const lineElements = container.querySelectorAll('.session-usage-codex-line-compact');
    expect(lineElements).toHaveLength(0);
  });
});
