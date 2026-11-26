/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const i18nState = vi.hoisted(() => ({
  language: 'zh-CN',
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: {
      get language() {
        return i18nState.language;
      },
      get resolvedLanguage() {
        return i18nState.language;
      },
    },
  }),
}));

const preferenceState = vi.hoisted(() => ({
  store: new Map<string, string>(),
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: preferenceState.store.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      preferenceState.store.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      preferenceState.store.delete(key);
    }),
  },
}));

vi.mock('../../src/util/clipboard.js', () => ({
  readFromClipboard: vi.fn(async () => ({ ok: false, reason: 'empty' })),
}));

import { ServerSetupPage } from '../../src/pages/ServerSetupPage.js';
import { DEFAULT_SERVER_URL, addServerToList } from '../../src/native.js';

describe('ServerSetupPage locale-default servers', () => {
  beforeEach(() => {
    preferenceState.store.clear();
    localStorage.clear();
    i18nState.language = 'zh-CN';
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    vi.stubGlobal('__LOCALE_DEFAULT_SERVERS__', [
      { url: 'https://cn.example.com', locales: ['zh'], label: 'China Relay' },
    ]);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows matching compile-time default server without remove button in zh-CN and hides it in en', async () => {
    await addServerToList('https://custom.example.com');
    const { rerender } = render(<ServerSetupPage onConnect={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('https://cn.example.com')).toBeTruthy());
    expect(screen.getByText(DEFAULT_SERVER_URL)).toBeTruthy();
    expect(screen.getByText('China Relay')).toBeTruthy();
    expect(screen.getByText('https://custom.example.com')).toBeTruthy();

    // Only custom.example.com has a remove button; DEFAULT_SERVER_URL and cn.example.com do not.
    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    expect(removeButtons).toHaveLength(1);

    // Switch language to English and re-render: cn.example.com disappears immediately.
    i18nState.language = 'en';
    rerender(<ServerSetupPage onConnect={vi.fn()} />);

    await waitFor(() => expect(screen.queryByText('https://cn.example.com')).toBeNull());
    expect(screen.getByText(DEFAULT_SERVER_URL)).toBeTruthy();
    expect(screen.getByText('https://custom.example.com')).toBeTruthy();

    // Removing custom server works cleanly.
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('https://custom.example.com')).toBeNull());
  });
});
