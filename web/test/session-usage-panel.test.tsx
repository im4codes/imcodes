/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionUsagePanel } from '../src/components/SessionUsagePanel.js';
import { fetchUsageSummary } from '../src/api/usage-summary.js';
import { createEmptyUsageSummaryResponse, createEmptyUsageSummaryRow } from '@shared/usage-analytics.js';
import type { UsageSummaryResponse } from '@shared/usage-analytics.js';

vi.mock('../src/api/usage-summary.js', () => ({
  fetchUsageSummary: vi.fn(),
}));

vi.mock('../src/watch-projection.js', () => ({
  watchProjectionStore: {
    getSnapshot: vi.fn(() => ({ sessions: [] })),
  },
}));

// t must be reference-stable across renders: SessionUsagePanel's data-fetch
// effect lists `t` in its dependency array, so a fresh function per call (as
// a naive inline mock would produce) makes the effect look "changed" on
// every render, causing an infinite refetch loop -- and OOMing the test
// worker instead of failing fast. See the identical note in
// FileBrowser.test.tsx.
const translation = { t: (key: string) => key };
vi.mock('react-i18next', () => ({
  useTranslation: () => translation,
}));

function summaryWithTotal(overrides: Partial<UsageSummaryResponse['accountTotal']>): UsageSummaryResponse {
  return {
    ...createEmptyUsageSummaryResponse(),
    accountTotal: { ...createEmptyUsageSummaryRow('account'), factCount: 1, ...overrides },
  };
}

describe('SessionUsagePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => cleanup());

  it('shows input, cache, and output as separate tiles, each with its own share of the total', async () => {
    // Reproduces the "hard to read" report: input/cache/output used to be
    // crammed into one inline text line with no percentages at all.
    vi.mocked(fetchUsageSummary).mockResolvedValue(summaryWithTotal({
      inputTokens: 30,
      cacheTokens: 50,
      outputTokens: 20,
      totalTokens: 100,
    }));

    render(<SessionUsagePanel targetSessionName="deck_alpha_brain" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('sessionUsage.input')).toBeDefined());
    expect(screen.getByText('sessionUsage.cache')).toBeDefined();
    expect(screen.getByText('sessionUsage.output')).toBeDefined();

    // Each category's own count is visible (not merged into one string).
    expect(screen.getByText('30')).toBeDefined();
    expect(screen.getByText('50')).toBeDefined();
    expect(screen.getByText('20')).toBeDefined();

    // Cache (and every other category) shows its share of the total as a
    // percentage, not just a raw count.
    expect(screen.getByText('30%')).toBeDefined();
    expect(screen.getByText('50%')).toBeDefined();
    expect(screen.getByText('20%')).toBeDefined();
  });

  it('shows a dash share instead of a broken percentage when the total is zero', async () => {
    vi.mocked(fetchUsageSummary).mockResolvedValue(summaryWithTotal({
      inputTokens: 0,
      cacheTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }));

    render(<SessionUsagePanel targetSessionName="deck_alpha_brain" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('sessionUsage.input')).toBeDefined());
    expect(screen.getAllByText('—').length).toBe(3);
  });
});
