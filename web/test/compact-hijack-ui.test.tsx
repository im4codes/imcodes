/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { COMPACT_HIJACK_GLOBAL_PREF_KEY } from '../../shared/compact-hijack.js';

const patchSessionMock = vi.fn().mockResolvedValue({ ok: true });
const patchSubSessionMock = vi.fn().mockResolvedValue({ ok: true });
const getUserPrefMock = vi.fn();
const saveUserPrefMock = vi.fn().mockResolvedValue(undefined);
const apiFetchMock = vi.fn().mockResolvedValue({ ok: false });

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
}));

vi.mock('../src/api.js', () => ({
  ApiError: class ApiError extends Error {},
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  patchSession: (...args: unknown[]) => patchSessionMock(...args),
  patchSubSession: (...args: unknown[]) => patchSubSessionMock(...args),
  getUserPref: (...args: unknown[]) => getUserPrefMock(...args),
  saveUserPref: (...args: unknown[]) => saveUserPrefMock(...args),
  onUserPrefChanged: () => () => undefined,
  fetchSupervisorDefaults: vi.fn().mockResolvedValue(null),
  fetchSessionSupervisorDefaults: vi.fn().mockResolvedValue(null),
  fetchSessionSupervisorExecutionPoolCatalog: vi.fn().mockResolvedValue([]),
  saveSessionSupervisorDefaults: vi.fn(),
  saveSupervisorDefaults: vi.fn(),
  fetchSessionIdentityProfile: vi.fn().mockResolvedValue(null),
  saveSessionIdentityProfile: vi.fn(),
  clearSessionIdentityProfile: vi.fn(),
  updateDisplayName: vi.fn(),
  passwordChange: vi.fn(),
  passkeyVerifyBegin: vi.fn(),
  passwordSetupWithPasskey: vi.fn(),
  listPasskeys: vi.fn().mockResolvedValue({ credentials: [] }),
  deletePasskey: vi.fn(),
  passkeyRegisterBegin: vi.fn(),
  passkeyRegisterComplete: vi.fn(),
}));

vi.mock('../src/native.js', () => ({ isNative: () => false }));
vi.mock('../src/plugins/auth-session.js', () => ({ default: { start: vi.fn() } }));
vi.mock('../src/biometric-auth.js', () => ({ getAuthKey: vi.fn() }));
vi.mock('../src/components/PasskeyManager.js', () => ({ PasskeyManager: () => <div /> }));
vi.mock('../src/components/KeyboardShortcutsSection.js', () => ({ KeyboardShortcutsSection: () => <div /> }));
vi.mock('../src/components/SessionIdentityTabs.js', () => ({ SessionIdentityTabs: () => <div /> }));
vi.mock('../src/components/file-browser-lazy.js', () => ({ FileBrowser: () => <div /> }));

import { SettingsPage } from '../src/pages/SettingsPage.js';
import { SessionSettingsDialog } from '../src/components/SessionSettingsDialog.js';

describe('Compact Hijack Web UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserPrefMock.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders global Compact Hijack toggle in SettingsPage and persists updates via compact_hijack.global.v1', async () => {
    render(
      <SettingsPage
        userId="u1"
        username="owner"
        displayName="Owner"
        onDisplayNameUpdated={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    const checkbox = screen.getByRole('checkbox', {
      name: 'settings.compact_hijack_toggle_label',
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(saveUserPrefMock).toHaveBeenCalledWith(COMPACT_HIJACK_GLOBAL_PREF_KEY, { enabled: true });
    });
  });

  it('renders inherit/on/off selector in SessionSettingsDialog for owned session and saves compactHijack', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      <SessionSettingsDialog
        surface="session"
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description=""
        cwd="/tmp/proj"
        type="claude-code-sdk"
        canConfigureCompactHijack={true}
        transportConfig={{ uiLocale: 'en' }}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    const select = screen.getByLabelText('session.compactHijack.title') as HTMLSelectElement;
    expect(select.value).toBe('inherit');

    select.value = 'on';
    fireEvent.input(select);
    fireEvent.change(select);
    await waitFor(() => {
      expect((screen.getByText('common.save') as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByText('common.save'));

    await waitFor(() => {
      expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', {
        transportConfig: { uiLocale: 'en', compactHijack: 'on' },
      });
    });
  });

  it('hides Compact Hijack selector completely when canConfigureCompactHijack is false (shared session)', () => {
    render(
      <SessionSettingsDialog
        surface="session"
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description=""
        cwd="/tmp/proj"
        type="claude-code-sdk"
        canConfigureCompactHijack={false}
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('session-compact-hijack-field')).toBeNull();
  });
});
