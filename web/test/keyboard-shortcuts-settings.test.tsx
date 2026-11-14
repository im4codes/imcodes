/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { SettingsPage } from '../src/pages/SettingsPage.js';
import { KeyboardShortcutsSection } from '../src/components/KeyboardShortcutsSection.js';
import { KEYBOARD_SHORTCUTS_PREF_KEY } from '../src/keyboard-shortcuts.js';
import { DEFAULT_PUSH_NOTIFICATION_TYPES } from '@shared/push-notifications.js';

const apiFetchMock = vi.fn();
const getUserPrefMock = vi.fn();
const saveUserPrefMock = vi.fn();

vi.mock('../src/api.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getUserPref: (...args: unknown[]) => getUserPrefMock(...args),
  saveUserPref: (...args: unknown[]) => saveUserPrefMock(...args),
  passwordChange: vi.fn(),
  passkeyVerifyBegin: vi.fn(),
  passwordSetupWithPasskey: vi.fn(),
  updateDisplayName: vi.fn(),
}));

vi.mock('../src/components/PasskeyManager.js', () => ({
  PasskeyManager: () => <div data-testid="passkey-manager" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const dict: Record<string, string> = {
        'settings.title': 'Settings',
        'settings.back': '← Back',
        'settings.tab_profile': 'Profile',
        'settings.tab_notifications': 'Notifications',
        'settings.tab_security': 'Security',
        'settings.tab_shortcuts': 'Shortcuts',
        'settings.tab_guide': 'User Guide',
        'settings.shortcuts.title': 'Keyboard Shortcuts',
        'settings.shortcuts.desc': 'Customize desktop navigation shortcuts.',
        'settings.shortcuts.secondary_desc': 'Primary and Secondary bindings per action.',
        'settings.shortcuts.platform_mac': 'macOS defaults',
        'settings.shortcuts.platform_other': 'Windows / Linux defaults',
        'settings.shortcuts.slot_primary': 'Primary',
        'settings.shortcuts.slot_secondary': 'Secondary',
        'settings.shortcuts.reset_all': 'Reset all',
        'settings.shortcuts.clear': 'Clear',
        'settings.shortcuts.reset': 'Reset',
        'settings.shortcuts.unassigned': 'Not set',
        'settings.shortcuts.recording_prompt': 'Press shortcut…',
        'settings.shortcuts.record_aria': 'Record shortcut for {{action}}',
        'settings.shortcuts.record_slot_aria': 'Record {{slot}} shortcut for {{action}}',
        'settings.shortcuts.clear_slot_aria': 'Clear {{slot}} shortcut for {{action}}',
        'settings.shortcuts.reset_slot_aria': 'Reset {{slot}} shortcut for {{action}}',
        'settings.shortcuts.modifier_required': 'Use a modifier key (Cmd, Ctrl, or Alt) or a function key (F1–F24).',
        'settings.shortcuts.reassigned_notice': 'Assigned shortcut and cleared conflicting binding from “{{action}}”.',
        'settings.shortcuts.conflict_warning': 'Conflicts with: {{actions}}',
        'settings.shortcuts.hint': 'Press Esc to cancel recording.',
        'settings.shortcuts.actions.server_prev.title': 'Previous Server',
        'settings.shortcuts.actions.server_prev.desc': 'Switch up',
        'settings.shortcuts.actions.server_next.title': 'Next Server',
        'settings.shortcuts.actions.server_next.desc': 'Switch down',
        'settings.shortcuts.actions.tab_prev.title': 'Previous Tab',
        'settings.shortcuts.actions.tab_prev.desc': 'Switch left',
        'settings.shortcuts.actions.tab_next.title': 'Next Tab',
        'settings.shortcuts.actions.tab_next.desc': 'Switch right',
        'settings.shortcuts.actions.subsession_close_all.title': 'Close All Sub-Sessions',
        'settings.shortcuts.actions.subsession_close_all.desc': 'Minimize all open sub-session windows',
        'settings.shortcuts.subsession_quick.title': 'Sub-session Quick Shortcuts',
        'settings.shortcuts.subsession_quick.desc': 'Choose modifiers for 1–9 open or minimize.',
        'settings.shortcuts.subsession_quick.open_label': 'Toggle sub-session #',
        'settings.shortcuts.subsession_quick.modifiers_aria': 'Sub-session quick shortcut modifier keys',
        'settings.shortcuts.subsession_quick.min_one_hint': 'Keep at least one modifier key selected.',
        'settings.shortcuts.subsession_quick.reset_aria': 'Reset sub-session quick shortcut modifiers',
      };
      let out = dict[key] ?? key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
        }
      }
      return out;
    },
  }),
}));

describe('SettingsPage shortcuts tab & interactive key recorder', () => {
  beforeEach(() => {
    localStorage.clear();
    apiFetchMock.mockReset().mockResolvedValue({
      ok: true,
      types: DEFAULT_PUSH_NOTIFICATION_TYPES,
    });
    getUserPrefMock.mockReset().mockResolvedValue(null);
    saveUserPrefMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('exposes the Shortcuts tab in SettingsPage and renders macOS defaults when isMacOverride=true', () => {
    render(
      <SettingsPage
        displayName="Ada"
        username="ada"
        hasPassword={true}
        onBack={vi.fn()}
        onDisplayNameChanged={vi.fn()}
        onUserAuthUpdated={vi.fn()}
      />,
    );

    const shortcutsTab = screen.getByRole('tab', { name: 'Shortcuts' });
    fireEvent.click(shortcutsTab);

    expect(screen.getByTestId('keyboard-shortcuts-card')).toBeDefined();
    expect(screen.getByText('Previous Server')).toBeDefined();
    expect(screen.getByText('Next Server')).toBeDefined();
    expect(screen.getByText('Previous Tab')).toBeDefined();
    expect(screen.getByText('Next Tab')).toBeDefined();
    expect(screen.getByText('Close All Sub-Sessions')).toBeDefined();

    cleanup();
    render(<KeyboardShortcutsSection isMacOverride={true} />);
    expect(screen.getByText('macOS defaults')).toBeDefined();
    expect(screen.getByTestId('shortcut-record-serverPrev').textContent).toContain('⌥');
    expect(screen.getByTestId('shortcut-record-serverPrev').textContent).toContain('I');
    expect(screen.getByTestId('shortcut-record-serverNext').textContent).toContain('⌥');
    expect(screen.getByTestId('shortcut-record-serverNext').textContent).toContain('K');
    expect(screen.getByTestId('shortcut-record-tabPrev').textContent).toContain('⌥');
    expect(screen.getByTestId('shortcut-record-tabPrev').textContent).toContain('J');
    expect(screen.getByTestId('shortcut-record-tabNext').textContent).toContain('⌥');
    expect(screen.getByTestId('shortcut-record-tabNext').textContent).toContain('L');
    expect(screen.getByTestId('shortcut-record-subSessionCloseAll').textContent).toContain('⌃');
    expect(screen.getByTestId('shortcut-record-subSessionCloseAll').textContent).toContain('0');
    expect(screen.getByTestId('shortcut-record-subSessionCloseAll-secondary').textContent).toContain('Not set');
    // macOS secondary defaults preserve Ctrl+W/S/A/D
    expect(screen.getByTestId('shortcut-record-serverPrev-secondary').textContent).toContain('⌃');
    expect(screen.getByTestId('shortcut-record-serverPrev-secondary').textContent).toContain('W');
    expect(screen.getByTestId('shortcut-record-serverNext-secondary').textContent).toContain('⌃');
    expect(screen.getByTestId('shortcut-record-serverNext-secondary').textContent).toContain('S');
    expect(screen.getByTestId('shortcut-record-tabPrev-secondary').textContent).toContain('⌃');
    expect(screen.getByTestId('shortcut-record-tabPrev-secondary').textContent).toContain('A');
    expect(screen.getByTestId('shortcut-record-tabNext-secondary').textContent).toContain('⌃');
    expect(screen.getByTestId('shortcut-record-tabNext-secondary').textContent).toContain('D');
    const resetTabPrev = screen.getByTestId('shortcut-reset-tabPrev') as HTMLButtonElement;
    expect(resetTabPrev.disabled).toBe(true);
    expect((screen.getByTestId('shortcut-reset-tabPrev-secondary') as HTMLButtonElement).disabled).toBe(true);

    // Clearing ONLY secondary Ctrl+A on macOS leaves primary ⌥J intact and persists across reload without resurrecting Ctrl+A
    fireEvent.click(screen.getByTestId('shortcut-clear-tabPrev-secondary'));
    expect(screen.getByTestId('shortcut-record-tabPrev-secondary').textContent).toContain('Not set');
    expect(screen.getByTestId('shortcut-record-tabPrev').textContent).toContain('⌥');
    expect(screen.getByTestId('shortcut-record-tabPrev').textContent).toContain('J');
    expect((screen.getByTestId('shortcut-clear-tabPrev-secondary') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('shortcut-reset-tabPrev-secondary') as HTMLButtonElement).disabled).toBe(false);
    const macStored = JSON.parse(localStorage.getItem(`rcc_sync_${KEYBOARD_SHORTCUTS_PREF_KEY}`) ?? '{}');
    expect(macStored.v).toEqual({ secondary: { tabPrev: null } });

    cleanup();
    render(<KeyboardShortcutsSection isMacOverride={true} />);
    expect(screen.getByTestId('shortcut-record-tabPrev-secondary').textContent).toContain('Not set');
    expect(screen.getByTestId('shortcut-record-tabPrev').textContent).toContain('⌥');
    expect(screen.getByTestId('shortcut-record-tabPrev').textContent).toContain('J');

    // Resetting secondary tabPrev restores ⌃A
    fireEvent.click(screen.getByTestId('shortcut-reset-tabPrev-secondary'));
    expect(screen.getByTestId('shortcut-record-tabPrev-secondary').textContent).toContain('⌃');
    expect(screen.getByTestId('shortcut-record-tabPrev-secondary').textContent).toContain('A');

    // Clearing primary tabPrev leaves secondary ⌃A intact
    fireEvent.click(screen.getByTestId('shortcut-clear-tabPrev'));
    expect(screen.getByTestId('shortcut-record-tabPrev').textContent).toContain('Not set');
    expect(screen.getByTestId('shortcut-record-tabPrev-secondary').textContent).toContain('⌃');
    expect(screen.getByTestId('shortcut-record-tabPrev-secondary').textContent).toContain('A');
    fireEvent.click(screen.getByTestId('shortcut-reset-tabPrev'));

    // Explicitly overriding tabPrev to Meta+ArrowLeft persists as a custom override
    fireEvent.click(screen.getByTestId('shortcut-record-tabPrev'));
    fireEvent.keyDown(document, { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true });
    expect(screen.getByTestId('shortcut-record-tabPrev').textContent).toContain('⌘');
    expect(screen.getByTestId('shortcut-record-tabPrev').textContent).toContain('←');
    expect((screen.getByTestId('shortcut-reset-tabPrev') as HTMLButtonElement).disabled).toBe(false);

    // Re-recording Option+j (even as macOS dead-key/Option glyph) matches macOS default and clears the override
    fireEvent.click(screen.getByTestId('shortcut-record-tabPrev'));
    fireEvent.keyDown(document, { key: 'Dead', code: 'KeyJ', altKey: true });
    expect(screen.getByTestId('shortcut-record-tabPrev').textContent).toContain('⌥');
    expect(screen.getByTestId('shortcut-record-tabPrev').textContent).toContain('J');
    expect((screen.getByTestId('shortcut-reset-tabPrev') as HTMLButtonElement).disabled).toBe(true);
  });

  it('records custom shortcut via keydown, handles Esc cancel, rejects plain typing key, clears conflicts, and persists via useSyncedPreference', () => {
    render(<KeyboardShortcutsSection isMacOverride={false} />);
    expect(screen.getByText('Windows / Linux defaults')).toBeDefined();
    expect(screen.getByTestId('shortcut-record-serverPrev').textContent).toContain('Alt');
    expect(screen.getByTestId('shortcut-record-serverPrev').textContent).toContain('I');
    expect(screen.getByTestId('shortcut-record-serverNext').textContent).toContain('Alt');
    expect(screen.getByTestId('shortcut-record-serverNext').textContent).toContain('K');
    expect(screen.getByTestId('shortcut-record-tabPrev').textContent).toContain('Alt');
    expect(screen.getByTestId('shortcut-record-tabPrev').textContent).toContain('J');
    expect(screen.getByTestId('shortcut-record-tabNext').textContent).toContain('Alt');
    expect(screen.getByTestId('shortcut-record-tabNext').textContent).toContain('L');
    expect(screen.getByTestId('shortcut-record-subSessionCloseAll').textContent).toContain('Ctrl');
    expect(screen.getByTestId('shortcut-record-subSessionCloseAll').textContent).toContain('0');
    // Windows / Linux secondary defaults are unassigned
    expect(screen.getByTestId('shortcut-record-tabPrev-secondary').textContent).toContain('Not set');
    expect((screen.getByTestId('shortcut-clear-tabPrev-secondary') as HTMLButtonElement).disabled).toBe(true);

    // Recording a custom 2nd combo on Windows/Linux secondary slot
    const tabPrevSecondaryBtn = screen.getByTestId('shortcut-record-tabPrev-secondary');
    fireEvent.click(tabPrevSecondaryBtn);
    fireEvent.keyDown(document, { key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true });
    expect(tabPrevSecondaryBtn.textContent).toContain('Ctrl');
    expect(tabPrevSecondaryBtn.textContent).toContain('←');

    // Assigning Ctrl+ArrowLeft to tabNext-secondary clears tabPrev-secondary without error
    fireEvent.click(screen.getByTestId('shortcut-record-tabNext-secondary'));
    fireEvent.keyDown(document, { key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true });
    expect(screen.getByTestId('shortcut-record-tabPrev-secondary').textContent).toContain('Not set');
    expect(screen.getByTestId('shortcut-record-tabNext-secondary').textContent).toContain('Ctrl');
    expect(screen.getByTestId('shortcut-record-tabNext-secondary').textContent).toContain('←');
    fireEvent.click(screen.getByTestId('shortcuts-reset-all'));

    // Start recording tabPrev -> press Escape to cancel without mutating
    const tabPrevBtn = screen.getByTestId('shortcut-record-tabPrev');
    fireEvent.click(tabPrevBtn);
    expect(tabPrevBtn.getAttribute('data-shortcut-recording')).toBe('true');
    expect(screen.getByText('Press shortcut…')).toBeDefined();

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    expect(tabPrevBtn.getAttribute('data-shortcut-recording')).toBeNull();
    expect(tabPrevBtn.textContent).toContain('Alt');
    expect(tabPrevBtn.textContent).toContain('J');

    // Start recording tabPrev -> bare modifier ignored, plain letter rejected with hint, then Alt+Shift+k accepted
    fireEvent.click(tabPrevBtn);
    fireEvent.keyDown(document, { key: 'Control', code: 'ControlLeft', ctrlKey: true });
    expect(tabPrevBtn.getAttribute('data-shortcut-recording')).toBe('true');

    fireEvent.keyDown(document, { key: 'a', code: 'KeyA' });
    expect(screen.getByTestId('shortcuts-status-notice').textContent).toContain('Use a modifier key');
    expect(tabPrevBtn.getAttribute('data-shortcut-recording')).toBe('true');

    fireEvent.keyDown(document, { key: 'k', code: 'KeyK', altKey: true, shiftKey: true });
    expect(tabPrevBtn.getAttribute('data-shortcut-recording')).toBeNull();
    expect(tabPrevBtn.textContent).toContain('Alt');
    expect(tabPrevBtn.textContent).toContain('Shift');
    expect(tabPrevBtn.textContent).toContain('K');

    const stored = JSON.parse(localStorage.getItem(`rcc_sync_${KEYBOARD_SHORTCUTS_PREF_KEY}`) ?? '{}');
    expect(stored.v).toEqual({ tabPrev: 'Alt+Shift+k' });
    expect(saveUserPrefMock).toHaveBeenCalledWith(
      KEYBOARD_SHORTCUTS_PREF_KEY,
      expect.stringContaining('"tabPrev":"Alt+Shift+k"'),
      expect.anything(),
    );

    // Assigning Alt+Shift+k to tabNext clears conflicting tabPrev and notices user
    const tabNextBtn = screen.getByTestId('shortcut-record-tabNext');
    fireEvent.click(tabNextBtn);
    fireEvent.keyDown(document, { key: 'k', code: 'KeyK', altKey: true, shiftKey: true });
    expect(tabNextBtn.textContent).toContain('K');
    expect(screen.getByTestId('shortcut-record-tabPrev').textContent).toContain('Not set');
    expect(screen.getByTestId('shortcuts-status-notice').textContent).toContain('Previous Tab');

    // Single reset restores tabPrev to Windows/Linux default (Alt+J)
    fireEvent.click(screen.getByTestId('shortcut-reset-tabPrev'));
    expect(screen.getByTestId('shortcut-record-tabPrev').textContent).toContain('Alt');
    expect(screen.getByTestId('shortcut-record-tabPrev').textContent).toContain('J');

    // Clear serverPrev disables it
    fireEvent.click(screen.getByTestId('shortcut-clear-serverPrev'));
    expect(screen.getByTestId('shortcut-record-serverPrev').textContent).toContain('Not set');

    // Reset all restores everything to Windows/Linux platform defaults (Alt+I/K/J/L)
    fireEvent.click(screen.getByTestId('shortcuts-reset-all'));
    expect(screen.getByTestId('shortcut-record-serverPrev').textContent).toContain('Alt');
    expect(screen.getByTestId('shortcut-record-serverPrev').textContent).toContain('I');
    expect(screen.getByTestId('shortcut-record-serverNext').textContent).toContain('Alt');
    expect(screen.getByTestId('shortcut-record-serverNext').textContent).toContain('K');
    expect(screen.getByTestId('shortcut-record-tabPrev').textContent).toContain('Alt');
    expect(screen.getByTestId('shortcut-record-tabPrev').textContent).toContain('J');
    expect(screen.getByTestId('shortcut-record-tabNext').textContent).toContain('Alt');
    expect(screen.getByTestId('shortcut-record-tabNext').textContent).toContain('L');
    expect(screen.getByTestId('shortcut-record-tabNext-secondary').textContent).toContain('Not set');
  });

  it('records Ctrl+Shift++ and bare/Shift navigation keys, rejects Shift+typing, and retains bindings across reload', () => {
    render(<KeyboardShortcutsSection isMacOverride={false} />);

    // Reject Shift+letter as normal typing
    const tabNextBtn = screen.getByTestId('shortcut-record-tabNext');
    fireEvent.click(tabNextBtn);
    fireEvent.keyDown(document, { key: 'A', code: 'KeyA', shiftKey: true });
    expect(screen.getByTestId('shortcuts-status-notice').textContent).toContain('Use a modifier key');
    expect(tabNextBtn.getAttribute('data-shortcut-recording')).toBe('true');

    // Capture Ctrl+Shift++ -> canonicalized, persisted, rendered as Ctrl / Shift / +
    fireEvent.keyDown(document, { key: '+', code: 'Equal', ctrlKey: true, shiftKey: true });
    expect(tabNextBtn.getAttribute('data-shortcut-recording')).toBeNull();
    expect(tabNextBtn.textContent).toContain('Ctrl');
    expect(tabNextBtn.textContent).toContain('Shift');
    expect(tabNextBtn.textContent).toContain('+');

    // Capture bare Home and Shift+PageDown for serverPrev / serverNext
    const serverPrevBtn = screen.getByTestId('shortcut-record-serverPrev');
    fireEvent.click(serverPrevBtn);
    fireEvent.keyDown(document, { key: 'Home', code: 'Home' });
    expect(serverPrevBtn.textContent).toContain('Home');

    const serverNextBtn = screen.getByTestId('shortcut-record-serverNext');
    fireEvent.click(serverNextBtn);
    fireEvent.keyDown(document, { key: 'PageDown', code: 'PageDown', shiftKey: true });
    expect(serverNextBtn.textContent).toContain('Shift');
    expect(serverNextBtn.textContent).toContain('PgDn');

    const stored = JSON.parse(localStorage.getItem(`rcc_sync_${KEYBOARD_SHORTCUTS_PREF_KEY}`) ?? '{}');
    expect(stored.v).toEqual({
      tabNext: 'Ctrl+Shift+Plus',
      serverPrev: 'Home',
      serverNext: 'Shift+PageDown',
    });

    // Simulate reload: unmount and remount KeyboardShortcutsSection, assert persisted keycaps survive intact
    cleanup();
    render(<KeyboardShortcutsSection isMacOverride={false} />);
    const reloadedTabNext = screen.getByTestId('shortcut-record-tabNext');
    expect(reloadedTabNext.textContent).toContain('Ctrl');
    expect(reloadedTabNext.textContent).toContain('Shift');
    expect(reloadedTabNext.textContent).toContain('+');
    expect(screen.getByTestId('shortcut-record-serverPrev').textContent).toContain('Home');
    expect(screen.getByTestId('shortcut-record-serverNext').textContent).toContain('PgDn');
    expect(screen.getByTestId('shortcut-record-tabPrev-secondary').textContent).toContain('Not set');
  });

  it('reassigned duplicate across macOS primary & secondary slots clears conflicting non-null default cleanly', () => {
    render(<KeyboardShortcutsSection isMacOverride={true} />);
    // Assign Ctrl+a (tabPrev secondary default on macOS) onto serverPrev primary -> clears tabPrev secondary to null cleanly
    fireEvent.click(screen.getByTestId('shortcut-record-serverPrev'));
    fireEvent.keyDown(document, { key: 'a', code: 'KeyA', ctrlKey: true });
    expect(screen.getByTestId('shortcut-record-serverPrev').textContent).toContain('⌃');
    expect(screen.getByTestId('shortcut-record-serverPrev').textContent).toContain('A');
    expect(screen.getByTestId('shortcut-record-tabPrev-secondary').textContent).toContain('Not set');

    cleanup();
    render(<KeyboardShortcutsSection isMacOverride={true} />);
    expect(screen.getByTestId('shortcut-record-serverPrev').textContent).toContain('⌃');
    expect(screen.getByTestId('shortcut-record-serverPrev').textContent).toContain('A');
    expect(screen.getByTestId('shortcut-record-tabPrev-secondary').textContent).toContain('Not set');
  });

  it('configures multi-modifier combinations for sub-session digit shortcuts, prevents empty set, persists, and resets', () => {
    render(<KeyboardShortcutsSection isMacOverride={false} />);

    const ctrlBtn = screen.getByTestId('subsession-mod-ctrl') as HTMLButtonElement;
    const altBtn = screen.getByTestId('subsession-mod-alt') as HTMLButtonElement;
    const shiftBtn = screen.getByTestId('subsession-mod-shift') as HTMLButtonElement;
    const resetAllBtn = screen.getByTestId('shortcuts-reset-all') as HTMLButtonElement;

    // Default: only Ctrl active, disabled as last modifier, preview shows Ctrl + 1–9 (no static + 0 preview)
    expect(ctrlBtn.getAttribute('aria-pressed')).toBe('true');
    expect(ctrlBtn.disabled).toBe(true);
    expect(altBtn.getAttribute('aria-pressed')).toBe('false');
    expect(resetAllBtn.disabled).toBe(true);
    expect(screen.queryByTestId('subsession-mod-reset')).toBeNull();
    expect(screen.getByTestId('subsession-quick-preview-open').textContent).toContain('Ctrl');
    expect(screen.getByTestId('subsession-quick-preview-open').textContent).toContain('1–9');
    expect(screen.queryByTestId('subsession-quick-preview-close')).toBeNull();

    // Toggle Alt on -> Ctrl + Alt active; now Ctrl is unlocked
    fireEvent.click(altBtn);
    expect(ctrlBtn.getAttribute('aria-pressed')).toBe('true');
    expect(ctrlBtn.disabled).toBe(false);
    expect(altBtn.getAttribute('aria-pressed')).toBe('true');
    expect(resetAllBtn.disabled).toBe(false);
    expect(screen.getByTestId('subsession-mod-reset')).toBeTruthy();

    // Uncheck Ctrl -> only Alt active (Alt is now locked last)
    fireEvent.click(ctrlBtn);
    expect(ctrlBtn.getAttribute('aria-pressed')).toBe('false');
    expect(altBtn.getAttribute('aria-pressed')).toBe('true');
    expect(altBtn.disabled).toBe(true);

    // Switch to Ctrl+Shift -> verify preview + persisted preference survive reload
    fireEvent.click(ctrlBtn);
    fireEvent.click(shiftBtn);
    fireEvent.click(altBtn);
    expect(screen.getByTestId('subsession-quick-preview-open').textContent).toContain('Ctrl');
    expect(screen.getByTestId('subsession-quick-preview-open').textContent).toContain('Shift');
    const stored = JSON.parse(localStorage.getItem(`rcc_sync_${KEYBOARD_SHORTCUTS_PREF_KEY}`) ?? '{}');
    expect(stored.v).toEqual({ subSessionQuickModifiers: ['ctrl', 'shift'] });

    cleanup();
    render(<KeyboardShortcutsSection isMacOverride={true} />);
    expect(screen.getByTestId('subsession-mod-ctrl').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('subsession-mod-shift').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('subsession-quick-preview-open').textContent).toContain('⌃');
    expect(screen.getByTestId('subsession-quick-preview-open').textContent).toContain('⇧');

    // Per-section reset restores default Ctrl only
    fireEvent.click(screen.getByTestId('subsession-mod-reset'));
    expect((screen.getByTestId('subsession-mod-ctrl') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('subsession-mod-shift').getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('subsession-mod-reset')).toBeNull();
    expect((screen.getByTestId('shortcuts-reset-all') as HTMLButtonElement).disabled).toBe(true);
  });

  it('supports interactive recording, clearing, resetting, and conflict reassignment on subSessionCloseAll', () => {
    render(<KeyboardShortcutsSection isMacOverride={false} />);

    const closeAllBtn = screen.getByTestId('shortcut-record-subSessionCloseAll');
    expect(closeAllBtn.textContent).toContain('Ctrl');
    expect(closeAllBtn.textContent).toContain('0');

    // Record custom Alt+Shift+x on subSessionCloseAll
    fireEvent.click(closeAllBtn);
    expect(closeAllBtn.getAttribute('data-shortcut-recording')).toBe('true');
    fireEvent.keyDown(document, { key: 'x', code: 'KeyX', altKey: true, shiftKey: true });
    expect(closeAllBtn.getAttribute('data-shortcut-recording')).toBeNull();
    expect(closeAllBtn.textContent).toContain('Alt');
    expect(closeAllBtn.textContent).toContain('Shift');
    expect(closeAllBtn.textContent).toContain('X');

    // Assigning Alt+i (default serverPrev) to subSessionCloseAll clears serverPrev cleanly
    fireEvent.click(closeAllBtn);
    fireEvent.keyDown(document, { key: 'i', code: 'KeyI', altKey: true });
    expect(closeAllBtn.textContent).toContain('Alt');
    expect(closeAllBtn.textContent).toContain('I');
    expect(screen.getByTestId('shortcut-record-serverPrev').textContent).toContain('Not set');
    expect(screen.getByTestId('shortcuts-status-notice').textContent).toContain('Previous Server');

    // Clear and reset subSessionCloseAll back to Ctrl+0
    fireEvent.click(screen.getByTestId('shortcut-clear-subSessionCloseAll'));
    expect(closeAllBtn.textContent).toContain('Not set');
    fireEvent.click(screen.getByTestId('shortcut-reset-subSessionCloseAll'));
    expect(closeAllBtn.textContent).toContain('Ctrl');
    expect(closeAllBtn.textContent).toContain('0');
  });
});
