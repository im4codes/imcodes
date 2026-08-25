/**
 * @vitest-environment jsdom
 *
 * ControlledNodesPanel (tasks 12.2/12.3): download buttons gated by server
 * availability + machine list with exec toggle and revoke.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlledNodeAvailability, MachineListItem } from '../src/api/machines.js';
import { REMOTE_DESKTOP_CAPABILITY } from '@shared/remote-desktop.js';
import { CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY } from '@shared/controlled-node-auto-unlock.js';
import { REMOTE_DESKTOP_INSTALLABLE_CAPABILITY } from '@shared/remote-desktop-install.js';

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
let machinesLoaded = true;
let machinesLoading = false;
const refetch = vi.fn(async (): Promise<MachineListItem[] | null> => null);
vi.mock('../src/hooks/useMachines.js', () => ({
  useMachines: () => ({ machines, filtered: machines, loaded: machinesLoaded, loading: machinesLoading, error: null, stale: false, refetch }),
}));

const setMachineExecEnabled = vi.fn(async () => {});
const revokeMachine = vi.fn(async () => {});
const renameMachine = vi.fn(async () => {});
const installMachineRemoteDesktopWorker = vi.fn(async () => {});
const listAvailableExecutables = vi.fn(async (): Promise<ControlledNodeAvailability> => ({
  available: ['win', 'mac', 'linux'],
  artifacts: [
    { os: 'win', filename: 'imcodes-node.exe', sizeBytes: 12_345_678, sha256: 'abc', arch: 'x64' },
    { os: 'mac', filename: 'imcodes-node-macos', sizeBytes: 22_000_000, sha256: 'abd', arch: 'universal' },
    { os: 'linux', filename: 'imcodes-node-linux', sizeBytes: 9_876_543, sha256: 'def', arch: 'x64' },
  ],
}));
vi.mock('../src/api/machines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/machines.js')>();
  return {
    ...actual,
    setMachineExecEnabled: (...a: unknown[]) => setMachineExecEnabled(...a),
    revokeMachine: (...a: unknown[]) => revokeMachine(...a),
    renameMachine: (...a: unknown[]) => renameMachine(...a),
    installMachineRemoteDesktopWorker: (...a: unknown[]) => installMachineRemoteDesktopWorker(...a),
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
const createControlledNodeRemoteInstallLink = vi.fn(async () => ({
  url: 'https://im.example.test/api/enroll/v2/bootstrap#ticket=remote-raw-ticket',
  expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  ticketId: 'tid-remote-1',
}));
const listSharesForTarget = vi.fn(async () => []);
const createShare = vi.fn(async () => ({
  id: 'share-1', targetUserId: 'user-2', role: 'viewer' as const, status: 'active' as const,
}));
vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api.js')>();
  return {
    ...actual,
    downloadControlledNodeExecutable: (...a: unknown[]) => downloadControlledNodeExecutable(...a),
    createControlledNodeRemoteInstallLink: (...a: unknown[]) => createControlledNodeRemoteInstallLink(...a),
    beginControlledNodeDesktopDownload: () => beginControlledNodeDesktopDownload(),
    listSharesForTarget: (...a: unknown[]) => listSharesForTarget(...a),
    createShare: (...a: unknown[]) => createShare(...a),
  };
});

vi.mock('../src/components/RemoteDesktopOwnerAccess.js', () => ({
  RemoteDesktopOwnerAccess: ({ hostId, endpointLabel }: { hostId: string | null; endpointLabel: string }) => (
    <div data-testid="remote-desktop-owner-access">{hostId ?? 'missing-host'}:{endpointLabel}</div>
  ),
}));

import {
  CONTROLLED_NODE_PRESENCE_REFRESH_MS,
  ControlledNodesPanel,
} from '../src/components/ControlledNodesPanel.js';

/** Set by the clipboard-denied test; `vi.unstubAllGlobals` does not cover
 *  properties defined directly on `document`. */
let restoreExecCommand: (() => void) | null = null;

afterEach(() => {
  restoreExecCommand?.();
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  machines = [];
  machinesLoaded = true;
  machinesLoading = false;
  refetch.mockResolvedValue(null);
});

const machine = (over: Partial<MachineListItem>): MachineListItem => ({ serverId: 's', refName: 'r', displayName: 'D', online: true, execEnabled: false, ...over });

function rejectRefreshAfterInitialLoad(): void {
  refetch
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new TypeError('Failed to fetch'));
}

describe('ControlledNodesPanel (12.3)', () => {
  it('refreshes DB-backed presence while open and stops polling after close', async () => {
    vi.useFakeTimers();
    try {
      const rendered = render(<ControlledNodesPanel />);
      expect(CONTROLLED_NODE_PRESENCE_REFRESH_MS).toBe(5_000);
      expect(refetch).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_999);
      });
      expect(refetch).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(refetch).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(refetch).toHaveBeenCalledTimes(3);

      rendered.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(refetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes immediately when a throttled background tab becomes visible', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const rendered = render(<ControlledNodesPanel />);
    expect(refetch).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(refetch).toHaveBeenCalledTimes(2);

    rendered.unmount();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(refetch).toHaveBeenCalledTimes(2);
    visibility.mockRestore();
  });

  it('keeps background presence reloads visually quiet for an empty loaded list', () => {
    machinesLoaded = true;
    machinesLoading = true;
    const { container } = render(<ControlledNodesPanel />);

    expect(container.textContent).toContain('controlled_nodes.empty');
    expect(container.querySelector('.controlled-nodes-refresh')?.hasAttribute('disabled')).toBe(false);
    expect(container.querySelector('.controlled-nodes-refresh-icon')?.classList.contains('is-spinning')).toBe(false);
  });

  it('keeps one stable refresh warning across repeated failures and clears it after recovery', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    refetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(null);
    const { container } = render(<ControlledNodesPanel />);

    await waitFor(() => expect(container.textContent).toContain('controlled_nodes.refresh_error'));
    const firstAlert = container.querySelector('.controlled-nodes-presence-error');
    expect(firstAlert).toBeTruthy();

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(2));
    expect(container.querySelector('.controlled-nodes-presence-error')).toBe(firstAlert);

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(container.querySelector('.controlled-nodes-presence-error')).toBeNull());
    visibility.mockRestore();
  });

  it('renders the node-grid hierarchy and live machine metrics', async () => {
    machines = [
      machine({ serverId: 'online', refName: 'win-edge', displayName: 'Edge One', os: 'win', online: true, execEnabled: true }),
      machine({ serverId: 'offline', refName: 'linux-edge', displayName: 'Edge Two', os: 'linux', online: false, execEnabled: false }),
    ];
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('Edge One'));

    expect(container.querySelector('.controlled-nodes-hero')).toBeTruthy();
    expect(Array.from(container.querySelectorAll('.controlled-nodes-metric strong')).map((node) => node.textContent)).toEqual(['2', '1', '1']);
    expect(container.querySelector('.controlled-nodes-machine-row.is-online code')?.textContent).toBe('win-edge');
    expect(container.querySelector('.controlled-nodes-machine-row.is-offline code')?.textContent).toBe('linux-edge');
    expect(container.querySelector('.controlled-nodes-exec-toggle.is-enabled')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('labels each node with its reported version and marks only the stale one', async () => {
    machines = [
      machine({ serverId: 'current', refName: 'cur', displayName: 'Current', online: true, daemonVersion: '2026.8.3447-dev.3884' }),
      machine({ serverId: 'stale', refName: 'old', displayName: 'Stale', online: true, daemonVersion: '2026.8.3400-dev.3800', updateAvailable: true }),
      machine({ serverId: 'silent', refName: 'quiet', displayName: 'Silent', online: false }),
    ];
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('Current'));

    const rows = Array.from(container.querySelectorAll('.controlled-nodes-machine-row'));
    expect(rows).toHaveLength(3);
    const chipTitles = rows.map((row) => row.querySelector('.controlled-nodes-version')?.getAttribute('title') ?? null);
    expect(chipTitles).toEqual([
      'controlled_nodes.version_current',
      'controlled_nodes.version_outdated',
      // A node that never reported a version gets no version chip at all
      // rather than a chip claiming it is current.
      null,
    ]);
    expect(container.querySelectorAll('.controlled-nodes-version.is-outdated')).toHaveLength(1);
    expect(rows[1]?.querySelector('.controlled-nodes-version.is-outdated')).toBeTruthy();
    expect(rows[2]?.textContent).toContain('controlled_nodes.version_unknown');
  });

  it('offers auto unlock only on a node whose worker can hold the secret', async () => {
    machines = [
      machine({
        serverId: 'win-capable',
        refName: 'w1',
        displayName: 'Windows box',
        os: 'win',
        capabilities: [REMOTE_DESKTOP_CAPABILITY, CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY],
      }),
      // Same OS, older build: no advertisement, so no promise of the feature.
      machine({ serverId: 'win-old', refName: 'w2', displayName: 'Old Windows', os: 'win', capabilities: [REMOTE_DESKTOP_CAPABILITY] }),
      machine({ serverId: 'linux', refName: 'l1', displayName: 'Linux box', os: 'linux' }),
    ];
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('Windows box'));

    const rows = Array.from(container.querySelectorAll('.controlled-nodes-machine-row'));
    expect(rows.map((row) => Boolean(row.querySelector('.controlled-nodes-auto-unlock'))))
      .toEqual([true, false, false]);
  });

  it('offers one download button per canonical (os, arch) artifact', async () => {
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('controlled_nodes.download_action'));
    // The os/arch detail moved into the button's title when the row gained a
    // second action; assert it is still reachable rather than silently dropped.
    expect(container.querySelector('.controlled-nodes-download-btn')?.getAttribute('title'))
      .toContain('controlled_nodes.download_target');
    const downloadBtns = Array.from(container.querySelectorAll('.controlled-nodes-download-btn'));
    expect(downloadBtns).toHaveLength(3); // win x64, mac Universal 2, linux x64
    expect(container.textContent).toContain('universal');
    expect(container.querySelector('.controlled-nodes-download-item.is-win')).toBeTruthy();
    expect(container.querySelector('.controlled-nodes-download-item.is-mac')).toBeTruthy();
    expect(container.querySelector('.controlled-nodes-download-item.is-linux')).toBeTruthy();
  });

  it('shows artifact metadata (arch + size) when present', async () => {
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('x64'));
    expect(container.textContent).toContain('universal');
    expect(container.textContent).toContain('21.0 MB');
    expect(container.textContent).toContain('9.4 MB');
  });

  it('clicking a download button uses desktop flow with the Capacitor web shim present', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => false });
    const { container } = render(<ControlledNodesPanel />);
    const btn = await waitFor(() => {
      const b = container.querySelector('.controlled-nodes-download-item.is-win .controlled-nodes-download-btn');
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

  it('copies a remote install link without navigating anywhere', async () => {
    // The operator is not at the target machine, so the useful outcome is a
    // string on the clipboard — explicitly NOT a download in this browser.
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText } });
    const { container } = render(<ControlledNodesPanel />);
    const btn = await waitFor(() => {
      const b = container.querySelector('.controlled-nodes-download-item.is-win .controlled-nodes-copy-link-btn');
      if (!b) throw new Error('win x64 copy-link button not found');
      return b;
    });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(createControlledNodeRemoteInstallLink).toHaveBeenCalledWith({ os: 'win', arch: 'x64' });
      expect(writeText).toHaveBeenCalledWith(
        'https://im.example.test/api/enroll/v2/bootstrap#ticket=remote-raw-ticket',
      );
    });
    // Minting a link must never start a local download or open a window.
    expect(downloadControlledNodeExecutable).not.toHaveBeenCalled();
    expect(beginControlledNodeDesktopDownload).not.toHaveBeenCalled();
  });

  it('gives the two row actions a real side-by-side rule, not just a comment', () => {
    // jsdom does not compute layout, so this is a static contract check: the
    // container the component renders must actually have a multi-column rule,
    // and neither child may keep the full-width/push-to-bottom sizing that
    // made them stack. It cannot prove pixels — a browser check would — but it
    // does prove the markup and the stylesheet agree about the intent.
    // Resolved against this module: these tests run both from the repo root
    // and from `web/` via the package's own `npm test`, and a cwd-relative
    // literal is ENOENT under one of them. Not `new URL(..., import.meta.url)`
    // — Vite rewrites that pattern for asset resolution and yields `undefined`
    // for an argument it cannot statically resolve.
    const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const read = (relative: string): string => readFileSync(resolve(webRoot, relative), 'utf8');
    const markup = read('src/components/ControlledNodesPanel.tsx');
    const css = read('src/styles.css');
    expect(markup).toContain('class="controlled-nodes-download-actions"');

    const rule = (selector: string): string => {
      const at = css.indexOf(`${selector} {`);
      expect({ selector, defined: at >= 0 }).toEqual({ selector, defined: true });
      return css.slice(at, css.indexOf('}', at));
    };

    const container = rule('.controlled-nodes-download-actions');
    expect(container).toMatch(/display:\s*(grid|flex)/);
    expect(container).toMatch(/grid-template-columns|flex-direction:\s*row/);
    // The container now owns bottom alignment for the pair.
    expect(container).toContain('margin-top: auto');

    for (const selector of ['.controlled-nodes-download-btn', '.controlled-nodes-copy-link-btn']) {
      const child = rule(selector);
      expect({ selector, fullWidth: /width:\s*100%/.test(child) })
        .toEqual({ selector, fullWidth: false });
      expect({ selector, pushesItself: /margin-top:\s*auto/.test(child) })
        .toEqual({ selector, pushesItself: false });
    }
  });

  it('reports a denied clipboard instead of claiming the link was copied', async () => {
    // The mint succeeded but the operator never received the URL. Showing
    // "copied" here would send them to the target machine with an empty
    // clipboard and no way to tell what went wrong.
    const writeText = vi.fn(async () => { throw new Error('denied'); });
    vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText } });
    // Define rather than spy. `document.execCommand` is not implemented by
    // jsdom; it exists only when a setup file polyfills it, and the CI unit
    // project loads a different setup than the workspace project does. Spying
    // therefore throws "execCommand does not exist" in exactly one of the two
    // runners. Defining it makes the fallback deterministically fail here no
    // matter which setup is loaded, which is the behaviour under test.
    const previousExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');
    Object.defineProperty(document, 'execCommand', {
      configurable: true, writable: true, value: vi.fn(() => false),
    });
    restoreExecCommand = () => {
      if (previousExecCommand) Object.defineProperty(document, 'execCommand', previousExecCommand);
      else delete (document as { execCommand?: unknown }).execCommand;
      restoreExecCommand = null;
    };

    const { container } = render(<ControlledNodesPanel />);
    const btn = await waitFor(() => {
      const b = container.querySelector('.controlled-nodes-download-item.is-win .controlled-nodes-copy-link-btn');
      if (!b) throw new Error('copy-link button not found');
      return b;
    });
    fireEvent.click(btn);

    await waitFor(() => {
      const alert = container.querySelector('.controlled-nodes-error');
      expect(alert?.textContent).toContain('controlled_nodes.copy_install_link_clipboard_error');
    });
    expect(createControlledNodeRemoteInstallLink).toHaveBeenCalled();
    // Neither the success flash nor the expiry may appear for a copy that
    // never reached the clipboard.
    expect(btn.textContent).not.toContain('controlled_nodes.copy_install_link_copied');
    expect(container.textContent).not.toContain('controlled_nodes.copy_install_link_expires_at');
  });

  it('offers the copy-link action on every platform row, beside the download button', async () => {
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => {
      if (!container.querySelector('.controlled-nodes-download-item.is-win')) {
        throw new Error('rows not rendered');
      }
    });
    for (const os of ['win', 'mac', 'linux']) {
      const row = container.querySelector(`.controlled-nodes-download-item.is-${os}`);
      expect(row?.querySelector('.controlled-nodes-download-btn')).toBeTruthy();
      expect(row?.querySelector('.controlled-nodes-copy-link-btn')).toBeTruthy();
    }
  });

  it('shows the link expiry and a copied confirmation, and surfaces mint failures', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText } });
    const { container } = render(<ControlledNodesPanel />);
    const btn = await waitFor(() => {
      const b = container.querySelector('.controlled-nodes-download-item.is-win .controlled-nodes-copy-link-btn');
      if (!b) throw new Error('copy-link button not found');
      return b;
    });

    fireEvent.click(btn);
    await waitFor(() => {
      expect(btn.textContent).toContain('controlled_nodes.copy_install_link_copied');
    });
    // The long window is only useful if the operator can see when it ends.
    expect(container.textContent).toContain('controlled_nodes.copy_install_link_expires_at');

    // A mint failure must be visible, not swallowed into a silent no-op.
    createControlledNodeRemoteInstallLink.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(btn);
    await waitFor(() => {
      expect(container.querySelector('.controlled-nodes-error')).toBeTruthy();
    });
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

  it('shows that the downloaded installer is permanent and reusable', async () => {
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('controlled_nodes.usage_step4'));
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

  it('does not report a successful exec toggle as failed when its refresh fails', async () => {
    rejectRefreshAfterInitialLoad();
    machines = [machine({ serverId: 'srv-toggle-refresh', displayName: 'Toggle Node', execEnabled: false })];
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('Toggle Node'));

    fireEvent.click(container.querySelector('.controlled-nodes-exec-toggle')!);

    await waitFor(() => expect(setMachineExecEnabled).toHaveBeenCalledWith('srv-toggle-refresh', true));
    await waitFor(() => expect(container.textContent).toContain('controlled_nodes.refresh_error'));
    expect(container.textContent).not.toContain('controlled_nodes.error_generic');
  });

  it('opens fixed-target sharing for an owner machine', async () => {
    machines = [machine({ serverId: 'shared-machine', displayName: 'Office Node', accessRole: 'owner' })];
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('Office Node'));
    fireEvent.click(container.querySelector('.share-revoke-btn')!);

    await waitFor(() => expect(container.textContent).toContain('controlled_nodes.share.title'));
    expect(listSharesForTarget).toHaveBeenCalledWith(
      'shared-machine',
      { kind: 'server', serverId: 'shared-machine' },
    );
    expect(container.querySelector('[role="radiogroup"][aria-label="share.target.label"]')).toBeNull();
  });

  it('contains a failed post-share refresh without rejecting or marking the share failed', async () => {
    rejectRefreshAfterInitialLoad();
    machines = [machine({ serverId: 'share-refresh', displayName: 'Share Refresh', accessRole: 'owner' })];
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('Share Refresh'));
    fireEvent.click(container.querySelector('.share-revoke-btn')!);

    const recipient = await waitFor(() => {
      const input = container.querySelector('#share-target-user');
      if (!(input instanceof HTMLInputElement)) throw new Error('share recipient input not found');
      return input;
    });
    fireEvent.input(recipient, { target: { value: 'user-2' } });
    fireEvent.click(container.querySelector('.ask-btn-submit')!);

    await waitFor(() => expect(createShare).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.textContent).toContain('controlled_nodes.refresh_error'));
    expect(container.querySelector('.share-error')).toBeNull();
    expect(container.textContent).not.toContain('controlled_nodes.error_generic');
  });

  it('keeps owner controls hidden for shared Viewer and Participant machines', async () => {
    machines = [
      machine({ serverId: 'viewer', displayName: 'Viewer Node', accessRole: 'viewer', execEnabled: false }),
      machine({ serverId: 'participant', displayName: 'Participant Node', accessRole: 'participant', execEnabled: true }),
    ];
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('Participant Node'));

    expect(container.querySelector('.share-revoke-btn')).toBeNull();
    expect(container.querySelector('.controlled-nodes-rename')).toBeNull();
    expect(container.querySelector('.controlled-nodes-exec-toggle')).toBeNull();
    expect(container.querySelector('.controlled-nodes-revoke')).toBeNull();
    expect(container.textContent).toContain('controlled_nodes.share.view_only');
    expect(container.textContent).toContain('controlled_nodes.exec_on');
  });

  it('shows Remote Desktop only for an operable Windows Owner or Participant with the exact capability', async () => {
    machines = [
      machine({ serverId: 'owner-ready', displayName: 'Owner Ready', os: 'win', accessRole: 'owner', execEnabled: true, capabilities: [REMOTE_DESKTOP_CAPABILITY] }),
      machine({ serverId: 'participant-ready', displayName: 'Participant Ready', os: 'win', accessRole: 'participant', execEnabled: true, capabilities: [REMOTE_DESKTOP_CAPABILITY] }),
      machine({ serverId: 'viewer', displayName: 'Viewer', os: 'win', accessRole: 'viewer', execEnabled: true, capabilities: [REMOTE_DESKTOP_CAPABILITY] }),
      machine({ serverId: 'disabled', displayName: 'Disabled', os: 'win', accessRole: 'owner', execEnabled: false, capabilities: [REMOTE_DESKTOP_CAPABILITY] }),
      machine({ serverId: 'offline', displayName: 'Offline', os: 'win', accessRole: 'owner', online: false, execEnabled: true, capabilities: [REMOTE_DESKTOP_CAPABILITY] }),
      machine({ serverId: 'old-node', displayName: 'Old Node', os: 'win', accessRole: 'owner', execEnabled: true }),
      machine({ serverId: 'linux', displayName: 'Linux', os: 'linux', accessRole: 'owner', execEnabled: true, capabilities: [REMOTE_DESKTOP_CAPABILITY] }),
    ];
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('Owner Ready'));

    const buttons = container.querySelectorAll('.controlled-nodes-remote-desktop');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.closest('li')?.textContent).toContain('Owner Ready');
    expect(buttons[1]?.closest('li')?.textContent).toContain('Participant Ready');
  });

  it('offers quick worker installation only for an online supported Owner node', async () => {
    machines = [
      machine({ serverId: 'missing', displayName: 'Missing Worker', os: 'win', accessRole: 'owner', online: true, capabilities: [REMOTE_DESKTOP_INSTALLABLE_CAPABILITY] }),
      machine({ serverId: 'viewer', displayName: 'Shared Viewer', os: 'win', accessRole: 'viewer', online: true, capabilities: [REMOTE_DESKTOP_INSTALLABLE_CAPABILITY] }),
      machine({ serverId: 'offline', displayName: 'Offline Win', os: 'win', accessRole: 'owner', online: false, capabilities: [REMOTE_DESKTOP_INSTALLABLE_CAPABILITY] }),
      machine({ serverId: 'linux', displayName: 'Linux', os: 'linux', accessRole: 'owner', online: true, capabilities: [REMOTE_DESKTOP_INSTALLABLE_CAPABILITY] }),
      machine({ serverId: 'already-ready', displayName: 'Already Ready', os: 'win', accessRole: 'owner', online: true, capabilities: [REMOTE_DESKTOP_INSTALLABLE_CAPABILITY, REMOTE_DESKTOP_CAPABILITY] }),
      machine({ serverId: 'updating', displayName: 'Updating', os: 'win', accessRole: 'owner', online: true, updateAvailable: true, capabilities: [REMOTE_DESKTOP_INSTALLABLE_CAPABILITY] }),
    ];
    const { container } = render(<ControlledNodesPanel />);
    const button = await waitFor(() => {
      const candidate = container.querySelector('.controlled-nodes-install-worker');
      if (!(candidate instanceof HTMLButtonElement)) throw new Error('install button not found');
      return candidate;
    });

    expect(container.querySelectorAll('.controlled-nodes-install-worker')).toHaveLength(1);
    expect(button.closest('li')?.textContent).toContain('Missing Worker');
    expect(button.textContent).toBe('remote_desktop.install_worker');
    fireEvent.click(button);
    await waitFor(() => expect(installMachineRemoteDesktopWorker).toHaveBeenCalledWith('missing'));
    expect(refetch).toHaveBeenCalled();
  });

  it('keeps the quick-install action visible after a bounded install failure', async () => {
    installMachineRemoteDesktopWorker.mockRejectedValueOnce(new Error('unavailable'));
    machines = [machine({
      serverId: 'repair-failed',
      displayName: 'Repair Me',
      os: 'win',
      accessRole: 'owner',
      online: true,
      capabilities: [REMOTE_DESKTOP_INSTALLABLE_CAPABILITY],
    })];
    const { container } = render(<ControlledNodesPanel />);
    const button = await waitFor(() => container.querySelector('.controlled-nodes-install-worker') as HTMLButtonElement);
    fireEvent.click(button);

    await waitFor(() => expect(container.textContent).toContain('remote_desktop.install_failed'));
    expect(container.querySelector('.controlled-nodes-install-worker')).not.toBeNull();
    expect((container.querySelector('.controlled-nodes-install-worker') as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens the Remote Desktop panel from the machine action', async () => {
    const onOpenRemoteDesktop = vi.fn();
    machines = [
      machine({
        serverId: 'desktop-ready',
        displayName: 'Desktop Ready',
        os: 'win',
        accessRole: 'owner',
        execEnabled: true,
        capabilities: [REMOTE_DESKTOP_CAPABILITY],
      }),
    ];
    const { container } = render(
      <ControlledNodesPanel onOpenRemoteDesktop={onOpenRemoteDesktop} />,
    );
    await waitFor(() => expect(container.querySelector('.controlled-nodes-remote-desktop')).not.toBeNull());

    fireEvent.click(container.querySelector('.controlled-nodes-remote-desktop')!);

    expect(onOpenRemoteDesktop).toHaveBeenCalledTimes(1);
    expect(onOpenRemoteDesktop).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'desktop-ready',
      displayName: 'Desktop Ready',
    }));
    expect(container.querySelector('.remote-desktop-panel')).toBeNull();
  });

  it('keeps one Share entry and opens Owner invitations inside that dialog without connecting', async () => {
    const onOpenRemoteDesktop = vi.fn();
    machines = [
      machine({
        serverId: 'desktop-owner',
        remoteDesktopHostId: 'canonical-host-owner',
        displayName: 'Owner Desktop',
        os: 'win',
        accessRole: 'owner',
        execEnabled: true,
        capabilities: [REMOTE_DESKTOP_CAPABILITY],
      }),
      machine({
        serverId: 'desktop-participant',
        remoteDesktopHostId: 'canonical-host-participant',
        displayName: 'Participant Desktop',
        os: 'win',
        accessRole: 'participant',
        execEnabled: true,
        capabilities: [REMOTE_DESKTOP_CAPABILITY],
      }),
    ];
    const { container, getByTestId } = render(
      <ControlledNodesPanel onOpenRemoteDesktop={onOpenRemoteDesktop} />,
    );
    await waitFor(() => expect(container.querySelectorAll('.controlled-nodes-remote-desktop')).toHaveLength(2));

    expect(container.querySelector('.controlled-nodes-remote-desktop-access')).toBeNull();
    const ownerCard = [...container.querySelectorAll('.controlled-nodes-machine-row')]
      .find((card) => card.textContent?.includes('Owner Desktop'))!;
    const shareButton = ownerCard.querySelector('.controlled-nodes-machine-actions > .share-revoke-btn');
    expect(shareButton).not.toBeNull();
    fireEvent.click(shareButton!);

    const shareTabs = container.querySelectorAll('.share-dialog-tab');
    expect(shareTabs).toHaveLength(2);
    fireEvent.click(shareTabs[1]!);

    expect(onOpenRemoteDesktop).not.toHaveBeenCalled();
    expect(getByTestId('remote-desktop-owner-access').textContent)
      .toBe('canonical-host-owner:Owner Desktop');
    expect(container.querySelector('.remote-desktop-panel')).toBeNull();
  });

  it('renames only the mutable display name and refreshes the list', async () => {
    machines = [machine({ serverId: 'srv-rename', refName: 'stable-ref', displayName: 'Old name' })];
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('Old name'));

    fireEvent.click(container.querySelector('.controlled-nodes-rename')!);
    const input = container.querySelector('.controlled-nodes-rename-input') as HTMLInputElement;
    expect(input.value).toBe('Old name');
    fireEvent.input(input, { target: { value: 'New display name' } });
    fireEvent.click(container.querySelector('.controlled-nodes-rename-save')!);

    await waitFor(() => expect(renameMachine).toHaveBeenCalledWith('srv-rename', 'New display name'));
    expect(refetch).toHaveBeenCalled();
    expect(container.textContent).toContain('stable-ref');
  });

  it('does not report a successful rename as failed when its refresh fails', async () => {
    rejectRefreshAfterInitialLoad();
    machines = [machine({ serverId: 'rename-refresh', displayName: 'Old refresh name' })];
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('Old refresh name'));

    fireEvent.click(container.querySelector('.controlled-nodes-rename')!);
    fireEvent.input(container.querySelector('.controlled-nodes-rename-input')!, { target: { value: 'New refresh name' } });
    fireEvent.click(container.querySelector('.controlled-nodes-rename-save')!);

    await waitFor(() => expect(renameMachine).toHaveBeenCalledWith('rename-refresh', 'New refresh name'));
    await waitFor(() => expect(container.textContent).toContain('controlled_nodes.refresh_error'));
    expect(container.textContent).not.toContain('controlled_nodes.error_generic');
  });

  it('rejects an invalid display name before calling the API', async () => {
    machines = [machine({ serverId: 'srv-invalid', displayName: 'Old name' })];
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('Old name'));
    fireEvent.click(container.querySelector('.controlled-nodes-rename')!);
    fireEvent.input(container.querySelector('.controlled-nodes-rename-input')!, { target: { value: '   ' } });
    fireEvent.click(container.querySelector('.controlled-nodes-rename-save')!);

    await waitFor(() => expect(container.textContent).toContain('controlled_nodes.rename_invalid'));
    expect(renameMachine).not.toHaveBeenCalled();
  });

  it('revoke asks for confirmation before calling the API', async () => {
    machines = [machine({ serverId: 'srv2', displayName: 'Mac' })];
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('Mac'));
    const revoke = container.querySelector('.controlled-nodes-revoke');
    expect(revoke).toBeTruthy();
    fireEvent.click(revoke!);
    expect(confirmSpy).toHaveBeenCalled();
    expect(revokeMachine).not.toHaveBeenCalled(); // declined
    confirmSpy.mockReturnValue(true);
    fireEvent.click(revoke!);
    await waitFor(() => expect(revokeMachine).toHaveBeenCalledWith('srv2'));
    confirmSpy.mockRestore();
  });

  it('does not report a successful revoke as failed when its refresh fails', async () => {
    rejectRefreshAfterInitialLoad();
    machines = [machine({ serverId: 'revoke-refresh', displayName: 'Revoke Refresh' })];
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = render(<ControlledNodesPanel />);
    await waitFor(() => expect(container.textContent).toContain('Revoke Refresh'));

    fireEvent.click(container.querySelector('.controlled-nodes-revoke')!);

    await waitFor(() => expect(revokeMachine).toHaveBeenCalledWith('revoke-refresh'));
    await waitFor(() => expect(container.textContent).toContain('controlled_nodes.refresh_error'));
    expect(container.textContent).not.toContain('controlled_nodes.error_generic');
    confirmSpy.mockRestore();
  });
});
