/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

const apiFetchMock = vi.fn();
const getApiBaseUrlMock = vi.fn(() => 'https://app.im.codes');
vi.mock('../../src/api.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getApiBaseUrl: () => getApiBaseUrlMock(),
}));

import { API_KEYS_PAGE_SIZE, ApiKeyManager } from '../../src/components/ApiKeyManager.js';

function makeKey(index: number, revoked = false) {
  return {
    id: `key-${index}`,
    label: `cli-key-${index}`,
    createdAt: 1_700_000_000_000 + index * 1000,
    revokedAt: revoked ? 1_700_000_500_000 : null,
  };
}

describe('ApiKeyManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(),
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows bind URL and bind command after generating a key', async () => {
    apiFetchMock.mockResolvedValueOnce({ id: 'key-1', apiKey: 'imc_test_123' });
    const onKeysChanged = vi.fn();

    render(<ApiKeyManager keys={[]} onKeysChanged={onKeysChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'api_key.generate' }));

    await waitFor(() => {
      expect(screen.getByText('https://app.im.codes/bind/imc_test_123')).toBeDefined();
      expect(screen.getByText('imcodes bind https://app.im.codes/bind/imc_test_123')).toBeDefined();
    });
    expect(onKeysChanged).toHaveBeenCalledOnce();
  });

  it('copies the full bind command', async () => {
    apiFetchMock.mockResolvedValueOnce({ id: 'key-1', apiKey: 'imc_test_123' });

    render(<ApiKeyManager keys={[]} onKeysChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'api_key.generate' }));

    await screen.findByText('imcodes bind https://app.im.codes/bind/imc_test_123');
    fireEvent.click(screen.getByRole('button', { name: 'api_key.copy_bind_command' }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('imcodes bind https://app.im.codes/bind/imc_test_123');
  });

  it('paginates keys and clamps to the last valid page when keys shrink', async () => {
    const keys = Array.from({ length: API_KEYS_PAGE_SIZE * 2 + 2 }, (_, idx) => makeKey(idx + 1));
    const view = render(<ApiKeyManager keys={keys} onKeysChanged={vi.fn()} />);

    expect(screen.getByText('cli-key-1')).toBeTruthy();
    expect(screen.queryByText(`cli-key-${API_KEYS_PAGE_SIZE + 1}`)).toBeNull();
    expect(screen.getByText('api_key.pagination_page:{"page":1,"totalPages":3}')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'api_key.prev_page' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'api_key.next_page' }));
    expect(screen.getByText(`cli-key-${API_KEYS_PAGE_SIZE + 1}`)).toBeTruthy();
    expect(screen.getByText('api_key.pagination_page:{"page":2,"totalPages":3}')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'api_key.next_page' }));
    expect(screen.getByText(`cli-key-${API_KEYS_PAGE_SIZE * 2 + 1}`)).toBeTruthy();
    expect(screen.getByText('api_key.pagination_page:{"page":3,"totalPages":3}')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'api_key.next_page' }) as HTMLButtonElement).disabled).toBe(true);

    const shrunk = keys.slice(0, API_KEYS_PAGE_SIZE + 1);
    view.rerender(<ApiKeyManager keys={shrunk} onKeysChanged={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('api_key.pagination_page:{"page":2,"totalPages":2}')).toBeTruthy();
      expect(screen.getByText(`cli-key-${API_KEYS_PAGE_SIZE + 1}`)).toBeTruthy();
    });
  });

  it('filters by All / Active / Revoked and resets page to 1 when switching filters', () => {
    const keys = [
      ...Array.from({ length: 7 }, (_, idx) => makeKey(idx + 1, false)),
      makeKey(8, true),
      makeKey(9, true),
    ];

    render(<ApiKeyManager keys={keys} onKeysChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'api_key.next_page' }));
    expect(screen.getByText('api_key.pagination_page:{"page":2,"totalPages":2}')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /api_key\.filter_revoked/ }));
    expect(screen.getByText('cli-key-8')).toBeTruthy();
    expect(screen.getByText('cli-key-9')).toBeTruthy();
    expect(screen.queryByText('cli-key-1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /api_key\.filter_active/ }));
    expect(screen.getByText('cli-key-1')).toBeTruthy();
    expect(screen.queryByText('cli-key-8')).toBeNull();
    expect(screen.getByText('api_key.pagination_page:{"page":1,"totalPages":2}')).toBeTruthy();
  });

  it('reveals a newly created key banner even when Revoked filter was active', async () => {
    apiFetchMock.mockResolvedValueOnce({ id: 'key-new', apiKey: 'imc_fresh_999' });
    const keys = [makeKey(1, false)];

    render(<ApiKeyManager keys={keys} onKeysChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /api_key\.filter_revoked/ }));
    expect(screen.getByText('api_key.empty_filtered')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'api_key.generate' }));

    await waitFor(() => {
      expect(screen.getByText('imc_fresh_999')).toBeTruthy();
      expect(screen.getByText('cli-key-1')).toBeTruthy();
    });
  });

  it('localizes the revoke dialog flow and handles revoke errors', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('network fail'));
    render(<ApiKeyManager keys={[makeKey(1, false)]} onKeysChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'api_key.revoke' }));
    expect(screen.getByText('api_key.revoke_dialog_title')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'api_key.revoke_dialog_continue' }));

    fireEvent.input(screen.getByPlaceholderText('cli-key-1'), { target: { value: 'cli-key-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'api_key.revoke_dialog_confirm_btn' }));

    await waitFor(() => {
      expect(screen.getByText('api_key.revoke_error')).toBeTruthy();
    });
  });
});
