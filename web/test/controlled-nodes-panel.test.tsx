/**
 * @vitest-environment jsdom
 *
 * ControlledNodesPanel (tasks 12.2/12.3): download buttons gated by server
 * availability + machine list with exec toggle and revoke.
 */
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlledNodeAvailability, MachineListItem } from '../src/api/machines.js';

const translate = (key: string, options?: Record<string, string>) =>
  key === 'controlled_nodes.artifact_meta' && options?.detail ? options.detail : key;
const testI18n = { language: 'en', changeLanguage: vi.fn() };
vi.mock('react-i18next', () => ({
  // Keep these references stable across renders. A new `t` function on every
  // render would retrigger the component's availability effect indefinitely.
  useTranslation: () => ({ t: translate, i18n: testI18n }),
}));

// Mutable machine list + spies shared across the mock and assertions.
let machines: MachineListItem[] = [];
const refetch = vi.fn(() => { /* re-read handled by test via rerender */ });
vi.mock('../src/hooks/useMachines.js', () => ({
  useMachines: () => ({ machines, filtered: machines, loaded: true, loading: false, error: null, stale: false, refetch }),
}));

const setMachineExecEnabled = vi.fn(async () => {});
const revokeMachine = vi.fn(async () => {});
const listAvailableExecutables = vi.fn(async (): Promise<ControlledNodeAvailability> => ({
  available: ['win', 'mac', 'linux'],
  artifacts: [
    { os: 'win', filename: 'imcodes-node.exe', sizeBytes: 12_345_678, sha256: 'abc', arch: 'x64' },
    { os: 'mac', filename: 'imcodes-node-macos', sizeBytes: 11_000_000, sha256: 'abd', arch: 'arm64' },
    { os: 'linux', filename: 'imcodes-node-linux', sizeBytes: 9_876_543, sha256: 'def', arch: 'x64' },
  ],
}));
vi.mock('../src/api/machines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/machines.js')>();
  return {
    ...actual,
    setMachineExecEnabled: (...a: unknown[]) => setMachineExecEnabled(...a),
    revokeMachine: (...a: unknown[]) => revokeMachine(...a),
    listAvailableExecutables: () => listAvailableExecutables(),
  };
});

const downloadControlledNodeExecutable = vi.fn(async () => ({
  version: 2 as const,
  ticket: 'raw-ticket',
  ticketId: 'tid-1',
  os: 'win' as const,
  arch: 'x64' as const,
  filename: 'imcodes-node.exe',
  sizeBytes: 12_345_678,
  sha256: 'abc',
  expiresAt: Date.now() + 60_000,
}));
const beginControlledNodeDesktopDownload = vi.fn(() => ({
  location: { href: 'about:blank' },
  closed: false,
  close: vi.fn(),
}));
vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api.js')>();
  return {
    ...actual,
    downloadControlledNodeExecutable: (...a: unknown[]) => downloadControlledNodeExecutable(...a),
    beginControlledNodeDesktopDownload: () => beginControlledNodeDesktopDownload(),
  };
});

import { ControlledNodesPanel } from '../src/components/ControlledNodesPanel.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  machines = [];
});

const machine = (over: Partial<MachineListItem>): MachineListItem => ({ serverId: 's', refName: 'r', displayName: 'D', online: true, execEnabled: false, ...over });

describe('ControlledNodesPanel (12.3)', () => {
  it('offers one download button per canonical (os, arch) artifact', async () => {
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('controlled_nodes.download_target'));
    const downloadBtns = Array.from(container.querySelectorAll('.controlled-nodes-download-btn'));
    expect(downloadBtns).toHaveLength(3); // win x64, mac arm64, linux x64
    expect(container.textContent).toContain('arm64');
  });

  it('shows artifact metadata (arch + size) when present', async () => {
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('x64'));
    expect(container.textContent).toContain('arm64');
    expect(container.textContent).toContain('11.8 MB');
    expect(container.textContent).toContain('9.4 MB');
  });

  it('clicking a download button uses desktop flow with the Capacitor web shim present', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => false });
    const { container } = render(<ControlledNodesPanel />);
    const btn = await waitFor(() => {
      const b = Array.from(container.querySelectorAll('.controlled-nodes-download-btn')).find((x) =>
        x.textContent === 'controlled_nodes.download_target',
      );
      if (!b) throw new Error('win x64 download button not found');
      return b;
    });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(beginControlledNodeDesktopDownload).toHaveBeenCalled();
      expect(downloadControlledNodeExecutable).toHaveBeenCalledWith(
        { os: 'win', arch: 'x64' },
        expect.objectContaining({ desktopWindow: expect.anything() }),
      );
    });
    const preOpenOrder = beginControlledNodeDesktopDownload.mock.invocationCallOrder[0] ?? 0;
    const downloadOrder = downloadControlledNodeExecutable.mock.invocationCallOrder[0] ?? 0;
    expect(preOpenOrder).toBeLessThan(downloadOrder);
  });

  it('fail-closes when artifacts lack arch metadata', async () => {
    listAvailableExecutables.mockResolvedValueOnce({
      available: ['win', 'mac'],
      artifacts: [
        { os: 'win', filename: 'imcodes-node.exe', sizeBytes: 1000, sha256: null } as never,
        { os: 'mac', filename: 'imcodes-node-macos', sizeBytes: 2000, sha256: null } as never,
      ],
    });
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => {
      expect(container.querySelectorAll('.controlled-nodes-download-btn')).toHaveLength(0);
      expect(container.textContent).toContain('controlled_nodes.no_executables');
    });
  });

  it('shows availability error distinct from empty catalog', async () => {
    listAvailableExecutables.mockRejectedValueOnce(new Error('network'));
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('controlled_nodes.availability_error'));
    expect(container.textContent).not.toContain('controlled_nodes.no_executables');
  });

  it('shows neutral empty catalog when availability succeeds with no targets', async () => {
    listAvailableExecutables.mockResolvedValueOnce({ available: [], artifacts: [] });
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('controlled_nodes.no_executables'));
    expect(container.textContent).not.toContain('controlled_nodes.availability_error');
  });

  it('shows neutral empty catalog when legacy error field is present on availability', async () => {
    listAvailableExecutables.mockResolvedValueOnce({
      available: [],
      artifacts: [],
      error: 'executable_dir_not_configured',
    } as ControlledNodeAvailability & { error: string });
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('controlled_nodes.no_executables'));
    expect(container.textContent).not.toContain('controlled_nodes.availability_error');
  });

  it('shows ticket expiry hint after a successful download mint', async () => {
    const { container } = render(<ControlledNodesPanel />);
    const btn = await waitFor(() => {
      const b = container.querySelector('.controlled-nodes-download-btn');
      if (!b) throw new Error('download button not found');
      return b;
    });
    fireEvent.click(btn);
    await waitFor(() => expect(container.textContent).toContain('controlled_nodes.ticket_expires_at'));
  });

  it('maps mint executable_not_built to a specific message', async () => {
    const { ApiError, controlledNodeDownloadErrorKey } = await import('../src/api.js');
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.querySelector('.controlled-nodes-download-btn')).toBeTruthy());
    downloadControlledNodeExecutable.mockRejectedValueOnce(new ApiError(503, '{"error":"executable_not_built"}'));
    fireEvent.click(container.querySelector('.controlled-nodes-download-btn')!);
    await waitFor(() => {
      expect(container.textContent).toContain(controlledNodeDownloadErrorKey(new ApiError(503, '{"error":"executable_not_built"}')));
    });
  });

  it('shows an empty state when there are no machines', async () => {
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('controlled_nodes.empty'));
  });

  it('renders a machine row and toggles exec via the API', async () => {
    machines = [machine({ serverId: 'srv1', refName: 'win-a1', displayName: 'Win Box', online: true, execEnabled: false })];
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('Win Box'));
    const toggle = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'controlled_nodes.exec_off');
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle!);
    await waitFor(() => expect(setMachineExecEnabled).toHaveBeenCalledWith('srv1', true));
    expect(refetch).toHaveBeenCalled();
  });

  it('revoke asks for confirmation before calling the API', async () => {
    machines = [machine({ serverId: 'srv2', displayName: 'Mac' })];
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('Mac'));
    const revoke = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'controlled_nodes.revoke');
    fireEvent.click(revoke!);
    expect(confirmSpy).toHaveBeenCalled();
    expect(revokeMachine).not.toHaveBeenCalled(); // declined
    confirmSpy.mockReturnValue(true);
    fireEvent.click(revoke!);
    await waitFor(() => expect(revokeMachine).toHaveBeenCalledWith('srv2'));
    confirmSpy.mockRestore();
  });
});
