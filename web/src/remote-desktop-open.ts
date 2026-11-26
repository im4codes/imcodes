import { sanitizeRemoteDesktopCitationId } from '../../shared/remote-desktop-reference.js';
import { REMOTE_DESKTOP_CAPABILITY } from '../../shared/remote-desktop.js';
import { daemonRemoteDesktopMachine, type MachineListItem } from './api/machines.js';
import { canOpenRemoteDesktopMachine } from './remote-desktop-profile.js';
import { remoteDesktopHostKey } from './remote-desktop-connection-manager.js';
import type { RemoteDesktopWorkspaceState } from './remote-desktop-workspace-state.js';

export interface RemoteDesktopServerCandidate {
  id: string;
  name: string;
  status?: string;
}

export interface RemoteDesktopUnavailableInfo {
  reason: 'offline' | 'unavailable';
  displayName: string;
  machine?: MachineListItem;
}

export interface OpenRemoteDesktopReferenceDeps {
  workspace: RemoteDesktopWorkspaceState;
  machines: readonly MachineListItem[];
  refetchMachines?: () => Promise<readonly MachineListItem[] | null>;
  servers?: readonly RemoteDesktopServerCandidate[];
  selectedServerId?: string | null;
  selectedServerCapabilities?: readonly string[];
  openRemoteDesktop: (machine: MachineListItem) => void;
  openRemoteDesktopById: (initialPublicNodeId?: string) => void;
  openControlledNodes?: () => void;
  notifyUnavailable?: (info: RemoteDesktopUnavailableInfo) => void;
}

const PUBLIC_GUEST_NODE_ID_RE = /^[5-9]\d{9}$/;

function matchMachineByRefId(
  machines: readonly MachineListItem[],
  id: string,
): { machine: MachineListItem; openable: boolean } | null {
  const byNodeId = machines.find((m) => m.nodeId === id);
  if (byNodeId) return { machine: byNodeId, openable: canOpenRemoteDesktopMachine(byNodeId) };

  const byHostLink = machines.find((m) => m.hostServerId === id && canOpenRemoteDesktopMachine(m));
  if (byHostLink) return { machine: byHostLink, openable: true };

  const byServerId = machines.find((m) => m.serverId === id);
  if (byServerId) return { machine: byServerId, openable: canOpenRemoteDesktopMachine(byServerId) };

  const byRemoteDesktopHostId = machines.find((m) => m.remoteDesktopHostId === id);
  if (byRemoteDesktopHostId) {
    return { machine: byRemoteDesktopHostId, openable: canOpenRemoteDesktopMachine(byRemoteDesktopHostId) };
  }

  const byHostLinkAny = machines.find((m) => m.hostServerId === id);
  if (byHostLinkAny) return { machine: byHostLinkAny, openable: false };

  return null;
}

/**
 * Resolve a Remote Desktop reference ID (`nodeId`, `serverId`, `remoteDesktopHostId`,
 * or 10-digit public guest node ID) and open/focus its Remote Desktop window.
 */
export async function openRemoteDesktopReference(
  rawId: string,
  deps: OpenRemoteDesktopReferenceDeps,
): Promise<'workspace' | 'machine' | 'daemon' | 'guest' | 'nodes' | 'offline' | 'unavailable' | 'ignored'> {
  const id = sanitizeRemoteDesktopCitationId(rawId);
  if (!id) return 'ignored';

  // 1. Check already-open workspace hosts first so clicking immediately focuses/unminimizes that tab.
  const openMachines = Object.values(deps.workspace.hosts).map((entry) => entry.machine);
  const openMatch = matchMachineByRefId(openMachines, id);
  if (openMatch && deps.workspace.hosts[remoteDesktopHostKey(openMatch.machine)]) {
    deps.openRemoteDesktop(openMatch.machine);
    return 'workspace';
  }

  // 2. Check cached controlled-node machine inventory, refetching once if not yet matched.
  let machineList = deps.machines;
  let match = matchMachineByRefId(machineList, id);
  if (!match && deps.refetchMachines) {
    try {
      const refreshed = await deps.refetchMachines();
      if (Array.isArray(refreshed)) {
        machineList = refreshed;
        match = matchMachineByRefId(machineList, id);
      }
    } catch {
      // Fall through cleanly to daemon/guest fallbacks below.
    }
  }

  if (match) {
    if (match.openable) {
      deps.openRemoteDesktop(match.machine);
      return 'machine';
    }
    const displayName = match.machine.displayName || match.machine.refName || id;
    if (!match.machine.online) {
      deps.notifyUnavailable?.({
        reason: 'offline',
        displayName,
        machine: match.machine,
      });
      return 'offline';
    }
    if (deps.notifyUnavailable) {
      deps.notifyUnavailable({
        reason: 'unavailable',
        displayName,
        machine: match.machine,
      });
      return 'unavailable';
    }
    if (deps.openControlledNodes) {
      deps.openControlledNodes();
      return 'nodes';
    }
    return 'unavailable';
  }

  // 3. Check FULL daemon servers matching `id` by serverId.
  const matchedServer = (deps.servers ?? []).find((srv) => srv.id === id) ?? null;
  const selectedCapable = deps.selectedServerId === id
    && (deps.selectedServerCapabilities?.includes(REMOTE_DESKTOP_CAPABILITY) ?? false);
  if (matchedServer || selectedCapable) {
    if (matchedServer && matchedServer.status === 'offline' && !selectedCapable) {
      deps.notifyUnavailable?.({
        reason: 'offline',
        displayName: matchedServer.name || id,
      });
      return 'offline';
    }
    deps.openRemoteDesktop(
      daemonRemoteDesktopMachine(id, matchedServer?.name ?? null),
    );
    return 'daemon';
  }

  // 4. Fallback to 10-digit public guest node ID dialog.
  if (PUBLIC_GUEST_NODE_ID_RE.test(id)) {
    deps.openRemoteDesktopById(id);
    return 'guest';
  }

  if (deps.openControlledNodes) {
    deps.openControlledNodes();
    return 'nodes';
  }
  return 'ignored';
}
