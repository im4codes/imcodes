/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const apiFetchMock = vi.fn();
const getApiBaseUrlMock = vi.fn(() => 'https://app.im.codes');
vi.mock('../../src/api.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getApiBaseUrl: () => getApiBaseUrlMock(),
}));

import { ApiKeyManager } from '../../src/components/ApiKeyManager.js';

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
});
