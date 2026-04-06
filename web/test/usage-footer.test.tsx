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
      if (key === 'session.codex_5h_short') return '5h';
      if (key === 'session.codex_wk_short') return '7d';
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
  it('renders inline CLI codex quota text in the ctx footer', () => {
    render(
      <UsageFooter
        usage={{
          inputTokens: 2000,
          cacheTokens: 1000,
          contextWindow: 1_000_000,
          model: 'coder-model',
        }}
        sessionName="deck_test_brain"
        agentType="codex"
        modelOverride="gpt-5"
        planLabel="Free"
        quotaLabel="5h 43% 2h03m 4/6 14:40 · 7d 34% 1d04h 4/8 15:48"
      />,
    );

    expect(screen.getByText('gpt-5')).toBeDefined();
    expect(screen.getByText(/5h 43% 2h03m 4\/6 14:40/)).toBeDefined();
    expect(screen.getByText(/7d 34% 1d04h 4\/8 15:48/)).toBeDefined();
  });
});
