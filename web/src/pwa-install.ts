import { useEffect, useState } from 'preact/hooks';
import { REMOTE_DESKTOP_APP_MANIFEST_PATH } from '@shared/remote-desktop-app.js';

/**
 * Installing the remote desktop as an app: the only window a page can get that has no address strip.
 *
 * Three browser-side facts drive everything here:
 *  - Chromium (Chrome, Edge, Android) fires `beforeinstallprompt` once the page links a valid manifest; keeping the event lets a button
 *    start the install. It fires once per page load, so it is captured module-wide and survives the UI that asked for it unmounting.
 *  - Safari (Add to Dock / Add to Home Screen) and Firefox have no such event: the user needs a sentence telling them where to click,
 *    and for Firefox an honest note that its windows keep the address bar.
 *  - Once the page runs as an installed app (`display-mode: standalone`) none of this applies and the entry is hidden.
 *
 * There is no service worker anywhere in this file or this feature: installation does not need one.
 */

/** Which instruction the user gets when the browser cannot be asked to install directly. */
export const INSTALL_GUIDANCE = {
  EDGE: 'edge',
  CHROME: 'chrome',
  SAFARI_MAC: 'safari_mac',
  SAFARI_IOS: 'safari_ios',
  FIREFOX: 'firefox',
  OTHER: 'other',
} as const;
export type InstallGuidance = typeof INSTALL_GUIDANCE[keyof typeof INSTALL_GUIDANCE];

export interface InstallGuidanceInput {
  userAgent: string;
  /** `navigator.maxTouchPoints`: an iPad reports a desktop Safari user agent, only the touch points tell it apart. */
  maxTouchPoints?: number;
}

/** Which browser the instructions must describe. Pure; the user agent is the only input that tells these apart. */
export function detectInstallGuidance({ userAgent, maxTouchPoints = 0 }: InstallGuidanceInput): InstallGuidance {
  const ua = userAgent;
  // Browsers on iOS are all WebKit: only the system share sheet can add a web app, whatever the browser calls itself.
  if (/iPhone|iPad|iPod|CriOS|FxiOS|EdgiOS/.test(ua)) return INSTALL_GUIDANCE.SAFARI_IOS;
  if (/Edg\//.test(ua)) return INSTALL_GUIDANCE.EDGE;
  if (/Firefox\//.test(ua)) return INSTALL_GUIDANCE.FIREFOX;
  const chromiumBased = /Chrome\/|Chromium\//.test(ua);
  if (chromiumBased && !/OPR\//.test(ua)) return INSTALL_GUIDANCE.CHROME;
  // Opera and friends carry both a Chromium and a Safari token: only a browser with no Chromium token at all is Safari.
  if (!chromiumBased && /Safari\//.test(ua)) return maxTouchPoints > 1 ? INSTALL_GUIDANCE.SAFARI_IOS : INSTALL_GUIDANCE.SAFARI_MAC;
  return INSTALL_GUIDANCE.OTHER;
}

/** True when this page is running as an installed app (an app window, or an iOS home-screen app), not in a browser tab or popup. */
export function isStandaloneDisplayMode(win: Window = window): boolean {
  try {
    if ((win.navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
    return Boolean(win.matchMedia?.('(display-mode: standalone)').matches || win.matchMedia?.('(display-mode: fullscreen)').matches);
  } catch {
    return false;
  }
}

/**
 * Make the page advertise the remote desktop app: the manifest link is added at run time, only where the remote desktop UI is (the main
 * IM.codes pages do not advertise an app). Idempotent; an existing manifest link is left alone.
 */
export function ensureRemoteDesktopAppManifestLink(doc: Document = document): HTMLLinkElement {
  const existing = doc.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (existing) return existing;
  const link = doc.createElement('link');
  link.rel = 'manifest';
  link.href = REMOTE_DESKTOP_APP_MANIFEST_PATH;
  doc.head.appendChild(link);
  return link;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const captured = { deferred: null as BeforeInstallPromptEvent | null, installed: false };
const listeners = new Set<() => void>();
const captureInstalledOn = new WeakSet<object>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Start capturing `beforeinstallprompt` / `appinstalled` for this window (once per window). Called at page start and by the install UI;
 * Chromium fires the event only once the manifest is linked, which this module does when the UI mounts.
 */
export function installPwaInstallCapture(win: Window = window): void {
  if (captureInstalledOn.has(win)) return;
  captureInstalledOn.add(win);
  win.addEventListener('beforeinstallprompt', (event) => {
    // Without preventDefault the browser shows its own mini-infobar; keeping the event lets our button decide when to ask.
    event.preventDefault();
    captured.deferred = event as BeforeInstallPromptEvent;
    notify();
  });
  win.addEventListener('appinstalled', () => {
    captured.deferred = null;
    captured.installed = true;
    notify();
  });
}

export interface PwaInstallSnapshot {
  /** The browser handed us an install prompt: one click installs. */
  canPrompt: boolean;
  /** The app was installed during this page's life. */
  installed: boolean;
}

export function getPwaInstallSnapshot(): PwaInstallSnapshot {
  return { canPrompt: captured.deferred !== null, installed: captured.installed };
}

export function subscribePwaInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export type PwaInstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

/** Ask the browser to install. A prompt can be used once; after the user answers it is gone and the guidance takes over. */
export async function promptPwaInstall(): Promise<PwaInstallOutcome> {
  const deferred = captured.deferred;
  if (!deferred) return 'unavailable';
  captured.deferred = null;
  notify();
  try {
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    return outcome;
  } catch {
    return 'unavailable';
  }
}

/** Test seam: forget the captured state, as a fresh page load does. */
export function resetPwaInstallStateForTests(): void {
  captured.deferred = null;
  captured.installed = false;
  listeners.clear();
}

export interface PwaInstallState extends PwaInstallSnapshot {
  /** Already running as an app, or installed a moment ago: the install entry has nothing to offer. */
  hidden: boolean;
  guidance: InstallGuidance;
  prompt: () => Promise<PwaInstallOutcome>;
}

/** State for the install entry. Linking the manifest and capturing the prompt happen here, so any UI that shows the entry makes it work. */
export function usePwaInstall(): PwaInstallState {
  const [, setVersion] = useState(0);
  const [standalone, setStandalone] = useState(() => isStandaloneDisplayMode());
  useEffect(() => {
    ensureRemoteDesktopAppManifestLink();
    installPwaInstallCapture();
    const unsubscribe = subscribePwaInstall(() => setVersion((value) => value + 1));
    const media = window.matchMedia?.('(display-mode: standalone)');
    const onChange = () => setStandalone(isStandaloneDisplayMode());
    media?.addEventListener?.('change', onChange);
    return () => {
      unsubscribe();
      media?.removeEventListener?.('change', onChange);
    };
  }, []);
  const snapshot = getPwaInstallSnapshot();
  return {
    ...snapshot,
    hidden: standalone || snapshot.installed,
    guidance: detectInstallGuidance({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints }),
    prompt: promptPwaInstall,
  };
}
