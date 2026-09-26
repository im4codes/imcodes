/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_CREDIT_HISTORY_MSG } from '@shared/codex-credit-history.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US', resolvedLanguage: 'en-US' },
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'codex_credit_balance.spent') return `Spent ${String(options?.amount ?? '')}`;
      if (key === 'codex_credit_balance.balance_now') return `balance ${String(options?.amount ?? '')}`;
      return key;
    },
  }),
}));

import { CodexCreditBalance, formatCodexCreditSnapshotTime } from '../src/components/CodexCreditBalance.js';
import type { ServerMessage, WsClient } from '../src/ws-client.js';

afterEach(() => cleanup());

describe('CodexCreditBalance', () => {
  it('shows the formatted current balance on the trigger without opening the panel', () => {
    const wsClient = {
      requestCodexCreditHistory: vi.fn(),
      onMessage: vi.fn(() => () => {}),
    } as unknown as WsClient;
    const view = render(<CodexCreditBalance wsClient={wsClient} connected balance="12.5" unlimited={false} />);
    expect(view.container.querySelector('.codex-credit-balance-trigger')?.textContent).toContain('$12.50');
    // No request should fire until the trigger is actually clicked.
    expect(wsClient.requestCodexCreditHistory).not.toHaveBeenCalled();
  });

  it('shows the infinity glyph for an unlimited account instead of a dollar amount', () => {
    const wsClient = {
      requestCodexCreditHistory: vi.fn(),
      onMessage: vi.fn(() => () => {}),
    } as unknown as WsClient;
    const view = render(<CodexCreditBalance wsClient={wsClient} connected balance="0" unlimited />);
    expect(view.container.querySelector('.codex-credit-balance-trigger')?.textContent).toContain('∞');
  });

  it('requests history on click and renders one derived consumption event from two snapshots', async () => {
    let handler: ((message: ServerMessage) => void) | null = null;
    const requestCodexCreditHistory = vi.fn();
    const wsClient = {
      requestCodexCreditHistory,
      onMessage: vi.fn((next: (message: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      }),
    } as unknown as WsClient;
    const view = render(<CodexCreditBalance wsClient={wsClient} connected balance="7.50" unlimited={false} />);

    fireEvent.click(view.container.querySelector('.codex-credit-balance-trigger')!);
    await waitFor(() => expect(requestCodexCreditHistory).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(handler).not.toBeNull());
    const requestId = requestCodexCreditHistory.mock.calls[0]?.[0] as string;

    const older = { capturedAt: 1_000, balance: '10.00', hasCredits: true, unlimited: false };
    const newer = { capturedAt: 2_000, balance: '7.50', hasCredits: true, unlimited: false };

    act(() => {
      handler?.({
        type: CODEX_CREDIT_HISTORY_MSG.RESPONSE,
        requestId,
        ok: true,
        // Newest first — the same order listCodexCreditSnapshots returns.
        snapshots: [newer, older],
      } as ServerMessage);
    });

    await waitFor(() => {
      const item = view.container.querySelector('.codex-credit-balance-item');
      expect(item?.textContent).toContain('Spent 2.50');
      expect(item?.textContent).toContain('balance $7.50');
      expect(item?.textContent).toContain(formatCodexCreditSnapshotTime(2_000, 'en-US'));
    });
  });

  it('shows a no-consumption message when every recorded snapshot is a top-up or unchanged', async () => {
    let handler: ((message: ServerMessage) => void) | null = null;
    const requestCodexCreditHistory = vi.fn();
    const wsClient = {
      requestCodexCreditHistory,
      onMessage: vi.fn((next: (message: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      }),
    } as unknown as WsClient;
    const view = render(<CodexCreditBalance wsClient={wsClient} connected balance="20.00" unlimited={false} />);

    fireEvent.click(view.container.querySelector('.codex-credit-balance-trigger')!);
    await waitFor(() => expect(handler).not.toBeNull());
    const requestId = requestCodexCreditHistory.mock.calls[0]?.[0] as string;

    act(() => {
      handler?.({
        type: CODEX_CREDIT_HISTORY_MSG.RESPONSE,
        requestId,
        ok: true,
        snapshots: [{ capturedAt: 2_000, balance: '20.00', hasCredits: true, unlimited: false }],
      } as ServerMessage);
    });

    await waitFor(() => {
      expect(view.container.textContent).toContain('codex_credit_balance.no_consumption');
    });
  });
});
