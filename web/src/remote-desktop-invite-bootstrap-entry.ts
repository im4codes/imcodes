import {
  bootstrapRemoteDesktopInvite,
  type RemoteDesktopInviteBootstrapResult,
} from './remote-desktop-invite-bootstrap.js';

declare global {
  interface Window {
    __IMCODES_REMOTE_DESKTOP_INVITE_BOOTSTRAP__?: Promise<RemoteDesktopInviteBootstrapResult>;
    __IMCODES_REMOTE_DESKTOP_INVITE_REQUESTED__?: boolean;
  }
}

const cleanUrl = `${window.location.pathname}${window.location.search}`;
window.__IMCODES_REMOTE_DESKTOP_INVITE_REQUESTED__ = window.location.hash.startsWith('#invite=');
window.__IMCODES_REMOTE_DESKTOP_INVITE_BOOTSTRAP__ = bootstrapRemoteDesktopInvite({
  fragment: window.location.hash,
  scrub: () => window.history.replaceState(window.history.state, '', cleanUrl),
});
