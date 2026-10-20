import { describe, expect, it } from 'vitest';
import type { MachineListItem } from '../src/api/machines.js';
import {
  REMOTE_DESKTOP_WALL_TAB_ID,
  REMOTE_DESKTOP_WORKSPACE_MAX_HOSTS,
  activateRemoteDesktopWorkspaceTab,
  closeRemoteDesktopWorkspaceHost,
  createRemoteDesktopWorkspaceState,
  openRemoteDesktopWorkspaceHost,
  reorderRemoteDesktopWorkspaceHost,
} from '../src/remote-desktop-workspace-state.js';

function machine(serverId: string, canonicalHostId = serverId): MachineListItem & { remoteDesktopHostId: string } {
  return {
    serverId,
    remoteDesktopHostId: canonicalHostId,
    refName: serverId,
    displayName: serverId,
    os: 'win',
    online: true,
    execEnabled: true,
    accessRole: 'owner',
    capabilities: ['remote-desktop-v1'],
  };
}

describe('remote desktop workspace state', () => {
  it('upserts a canonical host and activates its existing tab without duplication', () => {
    let state = openRemoteDesktopWorkspaceHost(createRemoteDesktopWorkspaceState(), machine('endpoint-a', 'host-1'));
    state = openRemoteDesktopWorkspaceHost(state, { ...machine('endpoint-b', 'host-1'), displayName: 'Renamed' });

    expect(state.orderedHostKeys).toEqual(['host-1']);
    expect(state.activeTabId).toBe('host-1');
    expect(state.hosts['host-1']?.machine).toMatchObject({ serverId: 'endpoint-b', displayName: 'Renamed' });
  });

  it('keeps different hosts ordered, supports deterministic reorder, and selects a neighbor on close', () => {
    let state = createRemoteDesktopWorkspaceState();
    state = openRemoteDesktopWorkspaceHost(state, machine('a'));
    state = openRemoteDesktopWorkspaceHost(state, machine('b'));
    state = openRemoteDesktopWorkspaceHost(state, machine('c'));
    state = reorderRemoteDesktopWorkspaceHost(state, 'c', -1);
    state = closeRemoteDesktopWorkspaceHost(state, 'c');

    expect(state.orderedHostKeys).toEqual(['a', 'b']);
    expect(state.activeTabId).toBe('b');
    state = closeRemoteDesktopWorkspaceHost(state, 'b');
    state = closeRemoteDesktopWorkspaceHost(state, 'a');
    expect(state.activeTabId).toBe(REMOTE_DESKTOP_WALL_TAB_ID);
  });

  it('bounds host presentation state without evicting an existing connection tab', () => {
    let state = createRemoteDesktopWorkspaceState();
    for (let index = 0; index < REMOTE_DESKTOP_WORKSPACE_MAX_HOSTS + 1; index += 1) {
      state = openRemoteDesktopWorkspaceHost(state, machine(`host-${index}`));
    }
    expect(state.orderedHostKeys).toHaveLength(REMOTE_DESKTOP_WORKSPACE_MAX_HOSTS);
    expect(state.hosts[`host-${REMOTE_DESKTOP_WORKSPACE_MAX_HOSTS}`]).toBeUndefined();

    const unchanged = activateRemoteDesktopWorkspaceTab(state, 'missing');
    expect(unchanged).toBe(state);
  });
});
