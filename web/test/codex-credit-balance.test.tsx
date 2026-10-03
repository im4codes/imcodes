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
      if (key === 'codex_credit_balance.spent') return `Spent ${String(options?.amount ?? '')} credits`;
      if (key === 'codex_credit_balance.balance_now') return `balance ${String(options?.amount ?? '')} credits`;
      if (key === 'codex_credit_balance.title') return `Codex credits balance: ${String(options?.balance ?? '')} credits`;
      if (key === 'codex_credit_balance.title_unlimited') return 'Codex credits balance: unlimited';
      return key;
    },
  }),
}));

import { CodexCreditBalance, formatCodexCreditSnapshotTime } from '../src/components/CodexCreditBalance.js';
import type { ServerMessage, WsClient } from '../src/ws-client.js';

afterEach(() => cleanup());

describe('CodexCreditBalance', () => {
  const quietClient = () => ({
    requestCodexCreditHistory: vi.fn(),
    onMessage: vi.fn(() => () => {}),
  }) as unknown as WsClient;
  const trigger = (view: ReturnType<typeof render>) => view.container.querySelector('.codex-credit-balance-trigger') as HTMLButtonElement;

  it('shows the credit count grouped, with no currency symbol, and says credits in the tooltip', () => {
    const wsClient = quietClient();
    const view = render(<CodexCreditBalance wsClient={wsClient} connected balance="62500" unlimited={false} />);
    expect(trigger(view).textContent?.trim()).toBe('💳 62,500');
    expect(trigger(view).getAttribute('title')).toBe('Codex credits balance: 62,500 credits');
    expect(trigger(view).getAttribute('aria-label')).toBe('Codex credits balance: 62,500 credits');
    expect(view.container.textContent).not.toContain('$');
    // No request should fire until the trigger is actually clicked.
    expect(wsClient.requestCodexCreditHistory).not.toHaveBeenCalled();
  });

  it.each([
    ['12.5', '💳 12.5'],
    ['12.50', '💳 12.5'],
    ['0', '💳 0'],
    ['1234567890123456789', '💳 1,234,567,890,123,456,789'],
  ])('renders balance %s as "%s"', (balance, text) => {
    const view = render(<CodexCreditBalance wsClient={quietClient()} connected balance={balance} unlimited={false} />);
    expect(trigger(view).textContent?.trim()).toBe(text);
    expect(trigger(view).textContent).not.toContain('$');
  });

  it('shows the infinity glyph for an unlimited account instead of an amount', () => {
    const view = render(<CodexCreditBalance wsClient={quietClient()} connected balance="0" unlimited />);
    expect(trigger(view).textContent?.trim()).toBe('💳 ∞');
    expect(trigger(view).getAttribute('title')).toBe('Codex credits balance: unlimited');
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
    const view = render(<CodexCreditBalance wsClient={wsClient} connected balance="62480" unlimited={false} />);

    fireEvent.click(view.container.querySelector('.codex-credit-balance-trigger')!);
    await waitFor(() => expect(requestCodexCreditHistory).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(handler).not.toBeNull());
    const requestId = requestCodexCreditHistory.mock.calls[0]?.[0] as string;

    const older = { capturedAt: 1_000, balance: '62500', hasCredits: true, unlimited: false };
    const newer = { capturedAt: 2_000, balance: '62480', hasCredits: true, unlimited: false };

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
      expect(item?.textContent).toContain('Spent 20 credits');
      expect(item?.textContent).toContain('balance 62,480 credits');
      expect(view.container.textContent).not.toContain('$');
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
