import {
  bootstrapRemoteDesktopInvite,
  type RemoteDesktopInviteBootstrapResult,
} from './remote-desktop-invite-bootstrap.js';
import { REMOTE_DESKTOP_INVITE_HISTORY_STATE_KEY } from './remote-desktop-access-crypto.js';

declare global {
  interface Window {
    __IMCODES_REMOTE_DESKTOP_INVITE_BOOTSTRAP__?: Promise<RemoteDesktopInviteBootstrapResult>;
    __IMCODES_REMOTE_DESKTOP_INVITE_REQUESTED__?: boolean;
  }
}

const historyRecord = window.history.state && typeof window.history.state === 'object'
  ? window.history.state as Record<string, unknown>
  : {};
const resumeTokenHash = historyRecord[REMOTE_DESKTOP_INVITE_HISTORY_STATE_KEY];
const cleanState = { ...historyRecord };
delete cleanState[REMOTE_DESKTOP_INVITE_HISTORY_STATE_KEY];
const hasInviteFragment = window.location.hash.startsWith('#invite=');
const cleanUrl = hasInviteFragment
  ? '/remote-desktop/access'
  : `${window.location.pathname}${window.location.search}`;
window.__IMCODES_REMOTE_DESKTOP_INVITE_REQUESTED__ = hasInviteFragment;
window.__IMCODES_REMOTE_DESKTOP_INVITE_BOOTSTRAP__ = bootstrapRemoteDesktopInvite({
  fragment: window.location.hash,
  resumeTokenHash,
  scrub: () => window.history.replaceState(hasInviteFragment ? cleanState : historyRecord, '', cleanUrl),
});
