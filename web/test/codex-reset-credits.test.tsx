/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_RESET_CREDITS_MSG } from '@shared/codex-reset-credits.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US', resolvedLanguage: 'en-US' },
    t: (key: string, options?: Record<string, unknown>) => (
      key === 'codex_credits.expires' ? `expires ${String(options?.date ?? '')}` : key
    ),
  }),
}));

import { CodexResetCredits, formatCodexCreditExpiry } from '../src/components/CodexResetCredits.js';
import type { ServerMessage, WsClient } from '../src/ws-client.js';

afterEach(() => cleanup());

describe('CodexResetCredits expiry display', () => {
  it('formats ISO expiry values with local date and time down to seconds', () => {
    const value = '2026-08-12T17:29:37.000Z';
    const expected = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(value));

    expect(formatCodexCreditExpiry(value, 'en-US')).toBe(expected);
  });

  it('also accepts backend Unix-second expiry values', () => {
    expect(formatCodexCreditExpiry('1786555777', 'en-US')).toBe(
      formatCodexCreditExpiry('2026-08-12T17:29:37.000Z', 'en-US'),
    );
  });

  it('renders the precise formatter output in the reset-credit panel', async () => {
    let handler: ((message: ServerMessage) => void) | null = null;
    const listCodexResetCredits = vi.fn();
    const wsClient = {
      listCodexResetCredits,
      consumeCodexResetCredit: vi.fn(),
      onMessage: vi.fn((next: (message: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      }),
    } as unknown as WsClient;
    const view = render(<CodexResetCredits wsClient={wsClient} connected />);

    fireEvent.click(view.container.querySelector('.codex-credits-trigger')!);
    await waitFor(() => expect(listCodexResetCredits).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(handler).not.toBeNull());
    const requestId = listCodexResetCredits.mock.calls[0]?.[0] as string;
    const expiresAt = '2026-08-12T17:29:37.000Z';

    act(() => {
      handler?.({
        type: CODEX_RESET_CREDITS_MSG.LIST_RESPONSE,
        requestId,
        ok: true,
        credits: [{ id: 'credit-1', status: 'available', expiresAt, title: 'Full reset' }],
        availableCount: 1,
      } as ServerMessage);
    });

    await waitFor(() => {
      expect(view.container.querySelector('.codex-credits-item')?.textContent).toContain(
        formatCodexCreditExpiry(expiresAt, 'en-US'),
      );
    });
  });
});
