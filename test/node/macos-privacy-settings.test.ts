import { describe, expect, it } from 'vitest';
import { MACOS_PRIVACY_PANE_URL, REMOTE_DESKTOP_LOCAL_PERMISSION } from '../../shared/remote-desktop-local-management.js';
import { openMacosPrivacyPane } from '../../src/node/macos-privacy-settings.js';

describe('macOS privacy panes', () => {
  it('maps every permission key to exactly one System Settings deep link', () => {
    expect(Object.keys(MACOS_PRIVACY_PANE_URL).sort()).toEqual(Object.values(REMOTE_DESKTOP_LOCAL_PERMISSION).sort());
    for (const url of Object.values(MACOS_PRIVACY_PANE_URL)) expect(url).toMatch(/^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_[A-Za-z]+$/u);
    expect(new Set(Object.values(MACOS_PRIVACY_PANE_URL)).size).toBe(3);
  });
  it('does nothing off macOS and refuses a key that is not in the table', async () => {
    for (const platform of ['win32', 'linux'] as const) expect(await openMacosPrivacyPane('accessibility', platform)).toBe(false);
    expect(await openMacosPrivacyPane('camera' as never, 'darwin')).toBe(false);
    expect(await openMacosPrivacyPane('toString' as never, 'darwin')).toBe(false);
  });
});
