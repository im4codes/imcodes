/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_LOGIN_SCREEN_STATE } from '@shared/remote-desktop-login-screen.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../src/api.js', () => ({
  ApiError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  controlledNodeDownloadErrorKey: () => 'controlled_nodes.download_error',
  createControlledNodeInstallCommand: vi.fn(),
}));

vi.mock('../src/api/machines.js', () => ({
  artifactSelectionKey: (t: { os: string; arch: string }) => `${t.os}:${t.arch}`,
  buildControlledNodeDownloadTargets: () => [],
  installMachineRemoteDesktopWorker: vi.fn(async () => undefined),
  listAvailableExecutables: vi.fn(async () => ({ items: [] })),
  requestMachineRemoteDesktopPermissions: vi.fn(async () => undefined),
  setMachineHostServer: vi.fn(async () => undefined),
}));

import { DaemonRemoteDesktopSetup } from '../src/components/DaemonRemoteDesktopSetup.js';

describe('DaemonRemoteDesktopSetup follow-up polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('continues polling past 3 minutes so Linux apt XFCE provisioning completes', () => {
    const onChanged = vi.fn();
    render(
      <DaemonRemoteDesktopSetup
        serverId="srv-1"
        serverName="Test Daemon"
        machines={[]}
        onClose={vi.fn()}
        onOpen={vi.fn()}
        onChanged={onChanged}
        installHere={{
          state: { state: REMOTE_DESKTOP_LOGIN_SCREEN_STATE.COMPLETED },
          start: vi.fn(),
        }}
      />,
    );

    // Past the old 180s (60 * 3s) limit, still polling up to 15 minutes (300 * 3s).
    vi.advanceTimersByTime(240_000);
    expect(onChanged).toHaveBeenCalledTimes(80);

    // Bounded at 300 reads (900s) without running forever.
    vi.advanceTimersByTime(720_000);
    expect(onChanged).toHaveBeenCalledTimes(300);
  });
});
