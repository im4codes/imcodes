import type { TFunction } from 'i18next';
import type { RemoteDesktopDisplay } from '@shared/remote-desktop.js';

/**
 * What a viewer calls one display of the remote machine.
 *
 * Nodes report technical labels -- `\\.\DISPLAY1` on Windows, internal ids
 * such as `macos-display:5:3` on macOS and Linux -- and two identical monitors
 * share one model name anyway. Displays are therefore named by their position
 * in the node's list, with the main display marked; callers keep the node's
 * own label available as a tooltip.
 */
export function remoteDesktopDisplayName(
  t: TFunction,
  displays: readonly Pick<RemoteDesktopDisplay, 'id'>[],
  display: Pick<RemoteDesktopDisplay, 'id' | 'primary'>,
): string {
  const number = displays.findIndex((candidate) => candidate.id === display.id) + 1;
  return display.primary
    ? t('remote_desktop.display_name_main', { number })
    : t('remote_desktop.display_name', { number });
}
