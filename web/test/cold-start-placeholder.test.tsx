/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import type { WsClient } from '../src/ws-client.js';
import { TimelineDB } from '../src/timeline-db.js';
import { useTimeline } from '../src/hooks/useTimeline.js';

describe('cold start before the socket is up', () => {
  it('does not report the history as settled while the daemon fetch has not started', async () => {
    // Cold start: nothing cached locally AND the socket is still connecting.
    vi.spyOn(TimelineDB.prototype, 'open').mockResolvedValue();
    vi.spyOn(TimelineDB.prototype, 'getLastSeqAndEpoch').mockResolvedValue(null);
    vi.spyOn(TimelineDB.prototype, 'getRecentEvents').mockResolvedValue([]);

    const ws: WsClient = {
      get connected() { return false; },
      onMessage: () => () => {},
      sendTimelineHistoryRequest: () => 'h1',
    } as unknown as WsClient;

    function Probe() {
      const { historyStatus } = useTimeline(`deck_cold_${Date.now()}`, ws, 'srv-cold');
      const s = historyStatus?.steps;
      const inFlight = !!s && (['cache', 'daemon', 'http'] as const)
        .some((k) => s[k] === 'pending' || s[k] === 'running');
      return h('div', {
        'data-testid': 'p',
        'data-cache': s?.cache ?? '',
        'data-daemon': s?.daemon ?? '',
        'data-inflight': String(inFlight),
      });
    }
    render(h(Probe));

    // Wait for the LOCAL read to settle — asserting while `cache` is still
    // running proves nothing, because that alone makes the view look busy.
    await waitFor(() => {
      const cache = screen.getByTestId('p').getAttribute('data-cache');
      expect(cache === 'empty' || cache === 'done').toBe(true);
    });
    const el = screen.getByTestId('p');
    // History has NOT arrived yet — it is waiting for the socket. Reporting
    // every step terminal makes the view show "no messages" instead of
    // indicating that the fetch is still coming.
    expect(el.getAttribute('data-inflight')).toBe('true');
  });
});
