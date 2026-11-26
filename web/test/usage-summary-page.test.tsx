import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageSummaryPage } from '../src/pages/UsageSummaryPage.js';
import { fetchUsageSummary } from '../src/api/usage-summary.js';
import type { UsageSummaryResponse } from '@shared/usage-analytics.js';

vi.mock('../src/api/usage-summary.js', () => ({
  fetchUsageSummary: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function row(overrides: Partial<UsageSummaryResponse['accountTotal']> = {}): UsageSummaryResponse['accountTotal'] {
  return {
    key: 'row',
    factCount: 1,
    inputTokens: 10,
    cacheTokens: 2,
    outputTokens: 8,
    totalTokens: 20,
    costUsdMicros: 1234,
    costCompleteness: 'known',
    ...overrides,
  };
}

function summary(overrides: Partial<UsageSummaryResponse> = {}): UsageSummaryResponse {
  return {
    accountTotal: row({ key: 'account', factCount: 3, totalTokens: 72, costUsdMicros: 2468, costCompleteness: 'partial' }),
    byDate: [row({ key: '2026-07-09', date: '2026-07-09', totalTokens: 72 })],
    byServer: [row({ key: 'srv-1', serverId: 'srv-1', totalTokens: 40 })],
    byProviderModel: [
      row({ key: 'openai:gpt-5', provider: 'openai', model: 'gpt-5', totalTokens: 52 }),
      row({ key: 'unknown:unknown', provider: null, model: null, totalTokens: 20, costUsdMicros: null, costCompleteness: 'unknown' }),
    ],
    byMainSession: [row({ key: 'main', serverId: 'srv-1', sessionName: 'deck_alpha_brain', sessionKind: 'main', totalTokens: 52 })],
    bySubSession: [row({
      key: 'sub',
      serverId: 'srv-1',
      sessionName: 'deck_sub_child',
      sessionKind: 'sub',
      parentSessionName: 'deck_alpha_brain',
      metadataCompleteness: 'partial',
      totalTokens: 20,
      costUsdMicros: null,
      costCompleteness: 'unknown',
    })],
    byParentSession: [row({ key: 'deck_alpha_brain', parentSessionName: 'deck_alpha_brain', totalTokens: 20 })],
    bySessionModelDate: [row({ key: 'session-model-date', date: '2026-07-09', sessionName: 'deck_alpha_brain', model: 'gpt-5', totalTokens: 52 })],
    meta: { from: '2026-07-01', to: '2026-07-09', generatedAtMs: 1, filters: {} },
    ...overrides,
  };
}

describe('UsageSummaryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchUsageSummary).mockResolvedValue(summary());
  });

  afterEach(() => cleanup());

  it('renders account totals, dimensions, main/sub distinction, and partial labels from server summary data', async () => {
    render(<UsageSummaryPage onBack={vi.fn()} />);

    expect(await screen.findByText('usageSummary.totalTokens')).toBeDefined();
    expect(screen.getAllByText('72').length).toBeGreaterThan(0);
    // srv-1 now appears both as a filter dropdown <option> and the "By server"
    // row, so assert on presence rather than uniqueness.
    expect(screen.getAllByText('srv-1').length).toBeGreaterThan(0);
    expect(screen.getByText('openai / gpt-5')).toBeDefined();
    expect(screen.getByText('usageSummary.unknown / usageSummary.unknown')).toBeDefined();
    expect(screen.getByText('deck_alpha_brain · usageSummary.mainSession')).toBeDefined();
    expect(screen.getByText('deck_sub_child · usageSummary.subSession · usageSummary.parent: deck_alpha_brain')).toBeDefined();
    expect(screen.getByText('usageSummary.partialMetadata')).toBeDefined();
  });

  it('applies date, server, provider, model, session, and kind filters', async () => {
    render(<UsageSummaryPage onBack={vi.fn()} />);
    await screen.findByText('usageSummary.totalTokens');

    fireEvent.input(screen.getByLabelText('usageSummary.from'), { target: { value: '2026-07-01' } });
    fireEvent.input(screen.getByLabelText('usageSummary.to'), { target: { value: '2026-07-09' } });
    fireEvent.input(screen.getByLabelText('usageSummary.server'), { target: { value: 'srv-1' } });
    fireEvent.input(screen.getByLabelText('usageSummary.provider'), { target: { value: 'openai' } });
    fireEvent.input(screen.getByLabelText('usageSummary.model'), { target: { value: 'gpt-5' } });
    fireEvent.input(screen.getByLabelText('usageSummary.session'), { target: { value: 'deck_sub_child' } });
    fireEvent.input(screen.getByLabelText('usageSummary.kind'), { target: { value: 'sub' } });
    fireEvent.click(screen.getByText('usageSummary.apply'));

    await waitFor(() => {
      expect(fetchUsageSummary).toHaveBeenLastCalledWith(expect.objectContaining({
        from: '2026-07-01',
        to: '2026-07-09',
        serverId: 'srv-1',
        provider: 'openai',
        model: 'gpt-5',
        sessionName: 'deck_sub_child',
        sessionKind: 'sub',
      }));
    });
  });

  it('shows the empty state for empty summaries', async () => {
    vi.mocked(fetchUsageSummary).mockResolvedValueOnce(summary({
      accountTotal: row({ key: 'account', factCount: 0, totalTokens: 0, costUsdMicros: null, costCompleteness: 'unknown' }),
      byDate: [],
      byServer: [],
      byProviderModel: [],
      byMainSession: [],
      bySubSession: [],
      byParentSession: [],
      bySessionModelDate: [],
    }));

    render(<UsageSummaryPage onBack={vi.fn()} />);

    expect(await screen.findByText('usageSummary.empty')).toBeDefined();
  });

  it('shows localized denial handling when the summary request is rejected', async () => {
    vi.mocked(fetchUsageSummary).mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }));

    render(<UsageSummaryPage onBack={vi.fn()} />);

    expect(await screen.findByText('usageSummary.error')).toBeDefined();
  });
});
