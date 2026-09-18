import { REMOTE_DESKTOP_CAPABILITY } from '@shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_INSTALLABLE_CAPABILITY,
  REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY,
} from '@shared/remote-desktop-install.js';
import type { MachineListItem } from './api/machines.js';
import {
  REMOTE_DESKTOP_WEB_READINESS,
  resolveRemoteDesktopWebReadiness,
} from './remote-desktop-profile.js';

/**
 * What a controlled node still needs before it can serve remote desktop.
 * Shared by the machine list and by a daemon's own remote-desktop button,
 * which steers to the node on the same computer.
 */

export function machineAccessRole(machine: MachineListItem): 'owner' | 'viewer' | 'participant' {
  // The field is optional on the wire so a newly upgraded Web remains usable
  // with an older Server, whose machine list was owner-only.
  return machine.accessRole ?? 'owner';
}

/**
 * The machine has its components and is waiting on the one grant only a person
 * at it can give. Distinct from "cannot do remote desktop": the two need
 * opposite things from the operator.
 */
export function needsRemoteDesktopPermission(machine: MachineListItem): boolean {
  return machine.online
    && machine.execEnabled
    && machineAccessRole(machine) === 'owner'
    && resolveRemoteDesktopWebReadiness(machine.capabilities).kind
      === REMOTE_DESKTOP_WEB_READINESS.SCREEN_RECORDING_REQUIRED;
}

export function canInstallRemoteDesktopWorker(machine: MachineListItem): boolean {
  return machineAccessRole(machine) === 'owner'
    && machine.online
    && !machine.updateAvailable
    // Either platform's "needs one download first" signal. They are separate
    // wire values because the Windows one says `windows` in its name and the
    // two installs are different operations, but to this button they mean the
    // same thing.
    && (Boolean(machine.capabilities?.includes(REMOTE_DESKTOP_INSTALLABLE_CAPABILITY))
      || Boolean(machine.capabilities?.includes(REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY)))
    && !machine.capabilities?.includes(REMOTE_DESKTOP_CAPABILITY);
}
