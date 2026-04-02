/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, cleanup } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key.split('.').pop() ?? key,
  }),
}));

import { P2pProgressCard } from '../../src/components/P2pProgressCard.js';

describe('P2pProgressCard', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows round-local hop progress instead of global hop index', () => {
    render(
      <P2pProgressCard
        discussion={{
          id: 'p2p_run_1',
          topic: 'P2P audit · brain',
          state: 'running',
          modeKey: 'audit',
          currentRound: 2,
          maxRounds: 3,
          completedHops: 3,
          totalHops: 2,
          activeHop: 4,
          activeRoundHop: 2,
          activePhase: 'hop',
          nodes: [],
        }}
      />,
    );

    expect(screen.getAllByText('H2/2').length).toBeGreaterThan(0);
    expect(screen.queryByText('H4/2')).toBeNull();
  });
});
