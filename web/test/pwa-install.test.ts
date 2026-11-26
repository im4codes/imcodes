/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_APP_MANIFEST_PATH } from '@shared/remote-desktop-app.js';
import {
  INSTALL_GUIDANCE,
  detectInstallGuidance,
  ensureRemoteDesktopAppManifestLink,
  getPwaInstallSnapshot,
  installPwaInstallCapture,
  isStandaloneDisplayMode,
  promptPwaInstall,
  resetPwaInstallStateForTests,
  subscribePwaInstall,
} from '../src/pwa-install.js';

const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:156.0) Gecko/20100101 Firefox/156.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/151.0.0.0 Mobile/15E148 Safari/604.1',
  firefoxIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/156.0 Mobile/15E148 Safari/605.1.15',
  // iPadOS asks for the desktop site by default: it looks like Safari on a Mac and only the touch points tell it apart.
  safariIpadDesktopMode: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  operaWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 OPR/120.0.0.0',
  unknown: 'SomeBrowser/1.0',
};

describe('detectInstallGuidance: which instruction the user needs', () => {
  it.each([
    ['Chrome on Windows', UA.chromeWin, 0, INSTALL_GUIDANCE.CHROME],
    ['Chrome on Android', UA.chromeAndroid, 5, INSTALL_GUIDANCE.CHROME],
    ['Edge', UA.edgeWin, 0, INSTALL_GUIDANCE.EDGE],
    ['Firefox', UA.firefoxLinux, 0, INSTALL_GUIDANCE.FIREFOX],
    ['Safari on a Mac', UA.safariMac, 0, INSTALL_GUIDANCE.SAFARI_MAC],
    ['Safari on an iPhone', UA.safariIphone, 5, INSTALL_GUIDANCE.SAFARI_IOS],
    ['Chrome on an iPhone (WebKit underneath)', UA.chromeIphone, 5, INSTALL_GUIDANCE.SAFARI_IOS],
    ['Firefox on an iPhone (WebKit underneath)', UA.firefoxIphone, 5, INSTALL_GUIDANCE.SAFARI_IOS],
    ['an iPad asking for the desktop site', UA.safariIpadDesktopMode, 5, INSTALL_GUIDANCE.SAFARI_IOS],
    ['Opera (Chromium, but not Chrome)', UA.operaWin, 0, INSTALL_GUIDANCE.OTHER],
    ['an unknown browser', UA.unknown, 0, INSTALL_GUIDANCE.OTHER],
  ])('%s', (_label, userAgent, maxTouchPoints, expected) => {
    expect(detectInstallGuidance({ userAgent, maxTouchPoints })).toBe(expected);
  });

  it('never tells a Mac Safari user (no touch) to use the iOS share sheet', () => {
    expect(detectInstallGuidance({ userAgent: UA.safariMac, maxTouchPoints: 0 })).toBe(INSTALL_GUIDANCE.SAFARI_MAC);
    expect(detectInstallGuidance({ userAgent: UA.safariMac })).toBe(INSTALL_GUIDANCE.SAFARI_MAC);
  });
});

describe('isStandaloneDisplayMode', () => {
  const fakeWindow = (matches: Record<string, boolean>, standalone?: boolean) => ({
    navigator: { standalone },
    matchMedia: (query: string) => ({ matches: matches[query] === true }),
  }) as unknown as Window;

  it('is true for an installed app window, for a fullscreen app, and for an iOS home-screen app', () => {
    expect(isStandaloneDisplayMode(fakeWindow({ '(display-mode: standalone)': true }))).toBe(true);
    expect(isStandaloneDisplayMode(fakeWindow({ '(display-mode: fullscreen)': true }))).toBe(true);
    expect(isStandaloneDisplayMode(fakeWindow({}, true))).toBe(true);
  });

  it('is false in a tab or a pop-up (both report display-mode: browser)', () => {
    expect(isStandaloneDisplayMode(fakeWindow({ '(display-mode: browser)': true }))).toBe(false);
    expect(isStandaloneDisplayMode(fakeWindow({}, false))).toBe(false);
  });

  it('is false rather than throwing when the browser has no matchMedia at all', () => {
    expect(isStandaloneDisplayMode({ navigator: {} } as unknown as Window)).toBe(false);
    expect(isStandaloneDisplayMode({ get navigator(): Navigator { throw new Error('denied'); } } as unknown as Window)).toBe(false);
  });
});

describe('ensureRemoteDesktopAppManifestLink', () => {
  afterEach(() => { document.head.innerHTML = ''; });

  it('adds one manifest link pointing at the remote desktop app manifest, and never a second', () => {
    const first = ensureRemoteDesktopAppManifestLink();
    const second = ensureRemoteDesktopAppManifestLink();
    expect(second).toBe(first);
    expect(first.rel).toBe('manifest');
    expect(first.getAttribute('href')).toBe(REMOTE_DESKTOP_APP_MANIFEST_PATH);
    expect(document.head.querySelectorAll('link[rel="manifest"]')).toHaveLength(1);
  });

  it('leaves a manifest the page already declares alone', () => {
    const own = document.createElement('link');
    own.rel = 'manifest';
    own.href = '/their.webmanifest';
    document.head.appendChild(own);
    expect(ensureRemoteDesktopAppManifestLink()).toBe(own);
    expect(own.getAttribute('href')).toBe('/their.webmanifest');
  });
});

describe('the install prompt', () => {
  let target: EventTarget;
  beforeEach(() => {
    resetPwaInstallStateForTests();
    target = new EventTarget();
    installPwaInstallCapture(target as unknown as Window);
  });

  function offerInstall(outcome: 'accepted' | 'dismissed' = 'accepted') {
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & { prompt: ReturnType<typeof vi.fn>; userChoice: Promise<{ outcome: string }> };
    event.prompt = vi.fn(async () => {});
    event.userChoice = Promise.resolve({ outcome });
    target.dispatchEvent(event);
    return event;
  }

  it('is captured (and the browser\'s own mini-infobar suppressed) so a button can start the install', () => {
    expect(getPwaInstallSnapshot().canPrompt).toBe(false);
    const event = offerInstall();
    expect(event.defaultPrevented).toBe(true);
    expect(getPwaInstallSnapshot()).toEqual({ canPrompt: true, installed: false });
  });

  it('is captured once per window however many times the capture is requested', () => {
    installPwaInstallCapture(target as unknown as Window);
    installPwaInstallCapture(target as unknown as Window);
    const seen: number[] = [];
    subscribePwaInstall(() => seen.push(1));
    offerInstall();
    expect(seen).toHaveLength(1);
  });

  it('asks the browser once and reports the answer; a prompt cannot be reused', async () => {
    const event = offerInstall('dismissed');
    await expect(promptPwaInstall()).resolves.toBe('dismissed');
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(getPwaInstallSnapshot().canPrompt).toBe(false);
    await expect(promptPwaInstall()).resolves.toBe('unavailable');
    expect(event.prompt).toHaveBeenCalledTimes(1);
  });

  it('reports "accepted" for an accepted install', async () => {
    offerInstall('accepted');
    await expect(promptPwaInstall()).resolves.toBe('accepted');
  });

  it('is "unavailable" (not an exception) when the browser refuses to show the prompt', async () => {
    const event = offerInstall();
    event.prompt.mockRejectedValueOnce(new Error('not allowed'));
    await expect(promptPwaInstall()).resolves.toBe('unavailable');
  });

  it('is unavailable until the browser has offered one', async () => {
    await expect(promptPwaInstall()).resolves.toBe('unavailable');
  });

  it('records that the app was installed, drops the prompt and tells subscribers', () => {
    offerInstall();
    const seen: number[] = [];
    const unsubscribe = subscribePwaInstall(() => seen.push(1));
    target.dispatchEvent(new Event('appinstalled'));
    expect(getPwaInstallSnapshot()).toEqual({ canPrompt: false, installed: true });
    expect(seen).toHaveLength(1);
    unsubscribe();
    target.dispatchEvent(new Event('appinstalled'));
    expect(seen).toHaveLength(1);
  });
});
