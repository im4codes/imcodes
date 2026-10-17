import { MACOS_PRIVACY_PANE_URL, isRemoteDesktopLocalPermissionTarget, type RemoteDesktopLocalPermissionTarget } from '../../shared/remote-desktop-local-management.js';
import { launchMacosUserSessionCommand, resolveMacosUserSession } from './user-session-launcher.js';

/**
 * Opens one pane of macOS System Settings (Privacy & Security) in the signed-in user's own session, so the person at the machine can
 * switch a permission on. The pane is chosen by KEY from a fixed table; the caller never supplies a URL. False when there is no such
 * pane, no signed-in user, or this is not macOS.
 */
export async function openMacosPrivacyPane(target: RemoteDesktopLocalPermissionTarget, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform !== 'darwin' || !isRemoteDesktopLocalPermissionTarget(target)) return false;
  try {
    const user = await resolveMacosUserSession();
    launchMacosUserSessionCommand(user, { executable: '/usr/bin/open', args: [MACOS_PRIVACY_PANE_URL[target]!] });
    return true;
  } catch {
    return false;
  }
}
