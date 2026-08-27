/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_CAPABILITY } from '@shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_INPUT_CAPABILITY,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
} from '@shared/remote-desktop-access.js';
import {
  REMOTE_DESKTOP_CAPTURE_CAPABILITY,
  REMOTE_DESKTOP_ENCODER_CAPABILITY,
  REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY,
  REMOTE_DESKTOP_SESSION_CAPABILITY,
} from '@shared/remote-desktop-platform.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { RemoteDesktopReadiness } from '../src/components/RemoteDesktopReadiness.js';

const MAC_VIEW = [
  REMOTE_DESKTOP_SESSION_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
  REMOTE_DESKTOP_CAPTURE_CAPABILITY.MACOS_SCREEN_CAPTURE_KIT,
  REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
] as const;

afterEach(cleanup);

describe('RemoteDesktopReadiness', () => {
  it('does not infer macOS readiness from a legacy Windows or absent profile', () => {
    const legacy = render(<RemoteDesktopReadiness capabilities={[REMOTE_DESKTOP_CAPABILITY]} />);
    expect(legacy.container.querySelector('.remote-desktop-readiness')).toBeNull();
    legacy.rerender(<RemoteDesktopReadiness capabilities={undefined} />);
    expect(legacy.container.querySelector('.remote-desktop-readiness')).toBeNull();
  });

  it('separates Screen Recording from Accessibility when capture is unavailable', () => {
    const result = render(<RemoteDesktopReadiness capabilities={[
      REMOTE_DESKTOP_SESSION_CAPABILITY,
      REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
      REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
      REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
    ]} />);
    expect(result.container.querySelector('[data-readiness="screen_recording_required"]')).not.toBeNull();
    expect(result.container.querySelector('[data-permission="screen-recording"]')?.textContent)
      .toContain('remote_desktop.macos_permission_required');
    expect(result.container.querySelector('[data-permission="accessibility"]')?.textContent)
      .toContain('remote_desktop.macos_permission_required');
    expect(result.container.textContent).toContain('remote_desktop.macos_screen_recording_guidance');
  });

  it('presents macOS View-only plus explicit unsupported action boundaries', () => {
    const result = render(<RemoteDesktopReadiness capabilities={MAC_VIEW} />);
    expect(result.container.querySelector('[data-readiness="view_only"]')).not.toBeNull();
    expect(result.container.querySelector('[data-permission="screen-recording"]')?.textContent)
      .toContain('remote_desktop.macos_permission_ready');
    expect(result.container.querySelector('[data-permission="accessibility"]')?.textContent)
      .toContain('remote_desktop.macos_permission_required');
    expect(result.container.textContent).toContain('remote_desktop.macos_view_only');
    expect(result.container.textContent).toContain('remote_desktop.macos_unsupported_lock_screen');
    expect(result.container.textContent).toContain('remote_desktop.macos_unsupported_capture_privacy');
    expect(result.container.textContent).toContain('remote_desktop.macos_unsupported_display_control');
  });

  it('mutates from macOS Control readiness to View-only without changing component paths', () => {
    const control = [
      ...MAC_VIEW,
      REMOTE_DESKTOP_INPUT_CAPABILITY,
      REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY,
    ];
    const result = render(<RemoteDesktopReadiness capabilities={control} />);
    expect(result.container.querySelector('[data-readiness="ready"]')).not.toBeNull();
    expect(result.container.querySelector('[data-permission="accessibility"]')?.textContent)
      .toContain('remote_desktop.macos_permission_ready');
    expect(result.container.textContent).toContain('remote_desktop.macos_control_ready');

    result.rerender(<RemoteDesktopReadiness capabilities={MAC_VIEW} />);
    expect(result.container.querySelector('[data-readiness="view_only"]')).not.toBeNull();
    expect(result.container.textContent).toContain('remote_desktop.macos_view_only');
    expect(result.container.textContent).not.toContain('remote_desktop.macos_control_ready');
  });

  it('shows one generic fail-closed message for an unknown adapter', () => {
    const result = render(<RemoteDesktopReadiness capabilities={[
      ...MAC_VIEW,
      'remote.desktop.capture.macos.future.v9',
    ]} />);
    expect(result.container.querySelector('[data-readiness="unsupported_profile"]')).not.toBeNull();
    expect(result.container.textContent).toContain('remote_desktop.macos_profile_unsupported');
    expect(result.container.querySelector('[data-permission]')).toBeNull();
  });
});
