import { hostname } from 'node:os';
import {
  REMOTE_DESKTOP_LOCAL_PERMISSION_STATE,
  type RemoteDesktopLocalExtras,
  type RemoteDesktopLocalPermissionState,
} from '../../shared/remote-desktop-local-management.js';

export interface LocalPanelExtrasInput {
  platform: NodeJS.Platform;
  /** Remote desktop is up on this node: its worker is running with a full capture profile. */
  remoteDesktopEnabled: boolean;
  /**
   * macOS only: the remote-desktop worker is installed and answering but advertises no capture, which is exactly what a missing
   * Screen Recording permission looks like to the node.
   */
  screenRecordingRequired: boolean;
  /** The remote-desktop input adapter is advertised. */
  inputAvailable: boolean;
  hostName?: string;
}

/**
 * What the panel shows besides the connection list. Nothing is probed here: every answer is read off state the node already
 * keeps for its capability advertisement, and a permission whose state the node cannot know is `unknown`, never `denied`.
 * Windows and Linux have no such permissions, so they send none (the panel shows no permission strip).
 */
export function buildLocalPanelExtras(input: LocalPanelExtrasInput): RemoteDesktopLocalExtras {
  const out: RemoteDesktopLocalExtras = {};
  const name = (input.hostName ?? safeHostname()).trim();
  if (name) out.deviceName = name;
  if (input.platform !== 'darwin') return out;
  const { GRANTED, DENIED, UNKNOWN } = REMOTE_DESKTOP_LOCAL_PERMISSION_STATE;
  const screenRecording: RemoteDesktopLocalPermissionState = input.remoteDesktopEnabled
    ? GRANTED
    : input.screenRecordingRequired ? DENIED : UNKNOWN;
  // The input adapter is only advertised once the worker can inject input, which is what the Accessibility permission allows;
  // its absence is not proof the permission is missing (the worker may simply not be ready), so it is never reported as denied.
  const accessibility: RemoteDesktopLocalPermissionState = input.remoteDesktopEnabled && input.inputAvailable ? GRANTED : UNKNOWN;
  // Full Disk Access is held by the aiDesk.to app identity and is only learned when a file listing hits it; until the node records
  // that outcome it cannot say, and says so.
  out.permissions = { screenRecording, accessibility, fullDiskAccess: UNKNOWN };
  return out;
}

function safeHostname(): string {
  try { return hostname(); } catch { return ''; }
}
