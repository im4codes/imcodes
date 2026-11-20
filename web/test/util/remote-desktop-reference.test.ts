/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_CAPABILITY } from '@shared/remote-desktop.js';
import type { MachineListItem } from '../../src/api/machines.js';
import {
  formatCloudDocQuoteBadge,
  formatCloudDocQuoteText,
  getCloudDocQuoteKey,
} from '../../src/cloud-docs-reference.js';
import { openRemoteDesktopReference } from '../../src/remote-desktop-open.js';
import {
  createRemoteDesktopWorkspaceState,
  openRemoteDesktopWorkspaceHost,
} from '../../src/remote-desktop-workspace-state.js';

function makeMachine(overrides: Partial<MachineListItem> = {}): MachineListItem {
  return {
    serverId: 'srv-default',
    refName: 'default-box',
    displayName: 'Default Box',
    os: 'win',
    online: true,
    execEnabled: true,
    accessRole: 'owner',
    capabilities: [REMOTE_DESKTOP_CAPABILITY],
    ...overrides,
  };
}

describe('remote desktop quote & open helpers', () => {
  it('formats remote_desktop quote keys, badges, and sanitized send text', () => {
    const target = {
      kind: 'remote_desktop' as const,
      id: '5123456789',
      serverId: 'srv-1',
      nodeId: '5123456789',
      name: 'Mac "Mini" [Lab]\n| 01',
    };
    expect(getCloudDocQuoteKey(target)).toBe('remote_desktop:5123456789');
    expect(formatCloudDocQuoteBadge(target)).toBe('[RemoteDesktop: Mac "Mini" Lab 01 | id=5123456789]');
    expect(formatCloudDocQuoteText(target)).toBe('[RemoteDesktop: Mac "Mini" Lab 01 | id=5123456789] ');
  });

  it('opens an already-open workspace host immediately without fetching machines', async () => {
    const openMachine = makeMachine({ serverId: 'srv-node', nodeId: '5123456789', displayName: 'Open Node' });
    const workspace = openRemoteDesktopWorkspaceHost(createRemoteDesktopWorkspaceState(), openMachine);
    const openRemoteDesktop = vi.fn();
    const refetchMachines = vi.fn();

    const result = await openRemoteDesktopReference('5123456789', {
      workspace,
      machines: [],
      refetchMachines,
      openRemoteDesktop,
      openRemoteDesktopById: vi.fn(),
      openControlledNodes: vi.fn(),
    });

    expect(result).toBe('workspace');
    expect(openRemoteDesktop).toHaveBeenCalledWith(openMachine);
    expect(refetchMachines).not.toHaveBeenCalled();
  });

  it('resolves controlled nodeId, hostServerId-linked node, FULL daemon serverId, remoteDesktopHostId, and 10-digit guest fallback', async () => {
    const node = makeMachine({ serverId: 'cn_host', nodeId: '6000000001', displayName: 'CN Node' });
    const linked = makeMachine({ serverId: 'cn_linked', nodeId: '6000000002', hostServerId: 'srv-linked', displayName: 'Linked Node' });
    const hostMapped = makeMachine({
      serverId: 'srv-other',
      remoteDesktopHostId: 'rd-host-42',
      displayName: 'Host Mapped',
    });

    const openRemoteDesktop = vi.fn();
    const openRemoteDesktopById = vi.fn();
    const openControlledNodes = vi.fn();
    const baseDeps = {
      workspace: createRemoteDesktopWorkspaceState(),
      machines: [node, linked, hostMapped],
      servers: [{ id: 'srv-full-daemon', name: 'Full Daemon Mac', status: 'online' }],
      openRemoteDesktop,
      openRemoteDesktopById,
      openControlledNodes,
    };

    expect(await openRemoteDesktopReference('6000000001', baseDeps)).toBe('machine');
    expect(openRemoteDesktop).toHaveBeenLastCalledWith(node);

    expect(await openRemoteDesktopReference('srv-linked', baseDeps)).toBe('machine');
    expect(openRemoteDesktop).toHaveBeenLastCalledWith(linked);

    expect(await openRemoteDesktopReference('srv-full-daemon', baseDeps)).toBe('daemon');
    expect(openRemoteDesktop).toHaveBeenLastCalledWith(expect.objectContaining({
      serverId: 'srv-full-daemon',
      displayName: 'Full Daemon Mac',
      capabilities: [REMOTE_DESKTOP_CAPABILITY],
    }));

    expect(await openRemoteDesktopReference('rd-host-42', baseDeps)).toBe('machine');
    expect(openRemoteDesktop).toHaveBeenLastCalledWith(hostMapped);

    const refetchMachines = vi.fn(async () => [node]);
    expect(await openRemoteDesktopReference('7123456789', {
      ...baseDeps,
      machines: [],
      refetchMachines,
    })).toBe('guest');
    expect(refetchMachines).toHaveBeenCalledTimes(1);
    expect(openRemoteDesktopById).toHaveBeenCalledWith('7123456789');

    expect(await openRemoteDesktopReference('unknown-srv', {
      ...baseDeps,
      machines: [],
      refetchMachines: vi.fn(async () => []),
    })).toBe('nodes');
    expect(openControlledNodes).toHaveBeenCalledTimes(1);
  });
});
