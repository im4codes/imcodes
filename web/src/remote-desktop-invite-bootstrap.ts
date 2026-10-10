import {
  isRemoteDesktopLinkTokenHash,
  parseRemoteDesktopLinkFragment,
} from '@shared/remote-desktop-access.js';

export type RemoteDesktopInviteBootstrapResult =
  | { status: 'unavailable' }
  | { status: 'invite'; token: string }
  | { status: 'resume'; tokenHash: string };

type BootstrapEnvironment = {
  fragment: string;
  resumeTokenHash?: unknown;
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
  if (token) return Promise.resolve({ status: 'invite', token });
  return Promise.resolve(isRemoteDesktopLinkTokenHash(environment.resumeTokenHash)
    ? { status: 'resume', tokenHash: environment.resumeTokenHash }
    : { status: 'unavailable' });
}
