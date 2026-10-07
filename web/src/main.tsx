import { render } from 'preact';
import { marked } from 'marked';
import { App } from './app.js';
import { configure, configureExpectedUserId } from './api.js';
import { RemoteDesktopStandalone } from './components/RemoteDesktopStandalone.js';
import { RemoteDesktopWallStandalone } from './components/RemoteDesktopWallStandalone.js';
import { RemoteDesktopGuestAccess } from './components/RemoteDesktopGuestAccess.js';
import {
  REMOTE_DESKTOP_NATIVE_STEP_UP_PATH,
  RemoteDesktopNativeStepUp,
} from './pages/RemoteDesktopNativeStepUp.js';
import { applyNativePlatformClasses } from './native-platform.js';
import {
  isRemoteDesktopWallWindow,
  readRemoteDesktopWindowServerId,
  resolveRemoteDesktopAppEntry,
} from './remote-desktop-window.js';
import { ensureRemoteDesktopAppManifestLink, installPwaInstallCapture } from './pwa-install.js';
import './styles.css';
import './i18n/index.js';
// Bundled programmer webfonts (OFL 1.1). JetBrains Mono is the default;
// Cascadia Mono is available in the chat font picker even when it is not
// installed on the user's machine. Only regular + bold weights are loaded
// because italic / other weights are not needed for chat rendering.
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/cascadia-mono/latin-400.css';
import '@fontsource/cascadia-mono/latin-700.css';

// Global marked config: all links open in new tab
marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const titleAttr = title ? ` title="${title}"` : '';
      return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

applyNativePlatformClasses();

// The installable remote desktop app (`/remote-desktop/app/`) reuses the two standalone-window screens: the machine wall, or the one
// machine a `?machine=` deep link names. The manifest link is added here so an installed app's own start page keeps it up to date.
const remoteDesktopAppEntry = resolveRemoteDesktopAppEntry(window.location.pathname, window.location.search);
if (remoteDesktopAppEntry) ensureRemoteDesktopAppManifestLink();
// Chromium fires its install prompt once per page load: listen from the start, whatever UI asks for it later.
installPwaInstallCapture();
const remoteDesktopServerId = readRemoteDesktopWindowServerId() ?? remoteDesktopAppEntry?.machineId ?? null;
const remoteDesktopWallEntry = isRemoteDesktopWallWindow() || (remoteDesktopAppEntry !== null && remoteDesktopAppEntry.machineId === null);
const remoteDesktopNativeStepUpEntry = window.location.pathname === REMOTE_DESKTOP_NATIVE_STEP_UP_PATH;
const remoteDesktopGuestEntry = window.__IMCODES_REMOTE_DESKTOP_INVITE_REQUESTED__ === true
  || window.location.pathname === '/remote-desktop/access';
if (remoteDesktopNativeStepUpEntry) {
  render(<RemoteDesktopNativeStepUp />, document.getElementById('app')!);
} else if (remoteDesktopGuestEntry) {
  document.documentElement.classList.add('remote-desktop-standalone-root');
  render(
    <RemoteDesktopGuestAccess bootstrap={window.__IMCODES_REMOTE_DESKTOP_INVITE_BOOTSTRAP__} />,
    document.getElementById('app')!,
  );
} else if (remoteDesktopServerId || remoteDesktopWallEntry) {
  try {
    const raw = localStorage.getItem('rcc_auth');
    const auth = raw ? JSON.parse(raw) as { userId?: unknown; baseUrl?: unknown } : null;
    if (typeof auth?.baseUrl === 'string') configure(auth.baseUrl);
    if (typeof auth?.userId === 'string') configureExpectedUserId(auth.userId);
  } catch { /* API falls back to same-origin session authentication. */ }
  document.documentElement.classList.add('remote-desktop-standalone-root');
  render(
    remoteDesktopWallEntry
      ? <RemoteDesktopWallStandalone />
      : <RemoteDesktopStandalone serverId={remoteDesktopServerId!} />,
    document.getElementById('app')!,
  );
} else {
  render(<App />, document.getElementById('app')!);
}
