import { parseRemoteDesktopLinkFragment } from '@shared/remote-desktop-access.js';

export type RemoteDesktopInviteBootstrapResult =
  | { status: 'unavailable' }
  | { status: 'invite'; token: string };

type BootstrapEnvironment = {
  fragment: string;
  scrub: () => void;
};

/**
 * Read the bearer once and synchronously remove it from the address bar and
 * browser history before the ordinary application bundle starts. The token
 * stays only in this in-memory result; challenge/proof begins after WebCrypto
 * creates the non-exportable browser key.
 */
export function bootstrapRemoteDesktopInvite(
  environment: BootstrapEnvironment,
): Promise<RemoteDesktopInviteBootstrapResult> {
  const token = parseRemoteDesktopLinkFragment(environment.fragment);
  environment.scrub();
  return Promise.resolve(token ? { status: 'invite', token } : { status: 'unavailable' });
}
