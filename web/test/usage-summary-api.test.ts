import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fetchUsageSummary } from '../src/api/usage-summary.js';
import { apiFetch } from '../src/api.js';

vi.mock('../src/api.js', () => ({
  apiFetch: vi.fn(),
}));

describe('usage summary API client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiFetch).mockResolvedValue({ ok: true });
  });

  it('serializes summary filters through the server summary API', async () => {
    await fetchUsageSummary({
      from: '2026-07-01',
      to: '2026-07-09',
      serverId: 'srv-1',
      provider: 'openai',
      model: 'gpt-5',
      sessionName: 'deck_alpha_brain',
      sessionKind: 'sub',
      parentSessionName: 'deck_parent_brain',
      order: 'desc',
      limit: 25,
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/token-usage/summary?from=2026-07-01&to=2026-07-09&serverId=srv-1&provider=openai&model=gpt-5&sessionName=deck_alpha_brain&sessionKind=sub&parentSessionName=deck_parent_brain&order=desc&limit=25');
  });
});
