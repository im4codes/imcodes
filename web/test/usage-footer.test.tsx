/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { h } from 'preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'session.provider_plan_title') return `Plan: ${String(opts?.value ?? '')}`;
      if (key === 'session.provider_quota_title') return `Quota: ${String(opts?.value ?? '')}`;
      if (key === 'session.provider_quota_usage_title') return `Quota usage: ${String(opts?.value ?? '')}`;
      if (key === 'session.provider_plan_free') return 'Free';
      if (key === 'session.provider_plan_paid') return 'Paid';
      if (key === 'session.provider_plan_byo') return 'BYO';
      if (key === 'chat.thinking_running') return `thinking ${String(opts?.sec ?? '')}`;
      return key;
    },
  }),
}));

vi.mock('../src/cost-tracker.js', () => ({
  getSessionCost: () => 0,
  getWeeklyCost: () => 0,
  getMonthlyCost: () => 0,
  formatCost: (n: number) => `$${n.toFixed(2)}`,
}));

import { UsageFooter } from '../src/components/UsageFooter.js';

describe('UsageFooter', () => {
  it('renders generic plan and quota badges with translated plan labels', () => {
    render(
      <UsageFooter
        usage={{ inputTokens: 2000, cacheTokens: 1000, contextWindow: 1_000_000, model: 'coder-model' }}
        sessionName="deck_test_brain"
        modelOverride="qwen3-coder-plus"
        planLabel="Free"
        quotaLabel="1,000/day"
        quotaUsageLabel="today 12/1000 · 1m 1/60"
      />,
    );

    expect(screen.getByText('Free')).toBeDefined();
    // quotaLabel + quotaUsageLabel are combined into a single inline element
    expect(screen.getByText('1,000/day · today 12/1000 · 1m 1/60')).toBeDefined();
    expect(screen.getByText('qwen3-coder-plus')).toBeDefined();
  });
});
