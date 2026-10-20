/** @vitest-environment jsdom */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_APP_SCOPE } from '@shared/remote-desktop-app.js';
import {
  REMOTE_DESKTOP_WINDOW_BLOCKED_NOTICE_MS,
  RemoteDesktopWindowBlockedNotice,
} from '../src/components/RemoteDesktopWindowBlockedNotice.js';
import { resetPwaInstallStateForTests } from '../src/pwa-install.js';
import {
  openRemoteDesktopWallWindow,
  openRemoteDesktopWindow,
  resolveRemoteDesktopAppEntry,
} from '../src/remote-desktop-window.js';
import { resetRemoteDesktopWindowNoticeForTests } from '../src/remote-desktop-window-notice.js';
import { stubDisplayMode } from './support/display-mode.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let displayMode: ReturnType<typeof stubDisplayMode>;

beforeEach(() => {
  resetPwaInstallStateForTests();
  resetRemoteDesktopWindowNoticeForTests();
  displayMode = stubDisplayMode('browser');
});
afterEach(() => {
  cleanup();
  displayMode.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.head.innerHTML = '';
});

const NOTICE = 'remote-desktop-window-blocked';

describe('a blocked remote desktop window is never silent', () => {
  it('tells the user, with both ways out, when the browser blocks a machine window', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(<RemoteDesktopWindowBlockedNotice />);
    expect(screen.queryByTestId(NOTICE)).toBeNull();
    act(() => { expect(openRemoteDesktopWindow('srv-1')).toBeNull(); });
    const notice = screen.getByTestId(NOTICE);
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toContain('remote_desktop.window_blocked');
    // the second way out: installing the app (an app window is not a pop-up)
    expect(screen.getByTestId('remote-desktop-install-app')).not.toBeNull();
  });

  it('tells the user when the browser blocks the wall window too', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(<RemoteDesktopWindowBlockedNotice />);
    act(() => { expect(openRemoteDesktopWallWindow()).toBeNull(); });
    expect(screen.getByTestId(NOTICE)).not.toBeNull();
  });

  it('says nothing when the window opened', () => {
    vi.spyOn(window, 'open').mockReturnValue({} as Window);
    render(<RemoteDesktopWindowBlockedNotice />);
    act(() => { expect(openRemoteDesktopWindow('srv-1')).not.toBeNull(); });
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it('can be dismissed, and comes back the next time a window is blocked', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(<RemoteDesktopWindowBlockedNotice />);
    act(() => { openRemoteDesktopWindow('srv-1'); });
    fireEvent.click(screen.getByLabelText('remote_desktop.window_blocked_dismiss'));
    expect(screen.queryByTestId(NOTICE)).toBeNull();
    act(() => { openRemoteDesktopWindow('srv-1'); });
    expect(screen.getByTestId(NOTICE)).not.toBeNull();
  });

  it('goes away by itself after a while, and a second block restarts the time', () => {
    vi.useFakeTimers();
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(<RemoteDesktopWindowBlockedNotice />);
    act(() => { openRemoteDesktopWindow('srv-1'); });
    act(() => { vi.advanceTimersByTime(REMOTE_DESKTOP_WINDOW_BLOCKED_NOTICE_MS - 1); });
    expect(screen.getByTestId(NOTICE)).not.toBeNull();
    act(() => { openRemoteDesktopWindow('srv-1'); });
    act(() => { vi.advanceTimersByTime(REMOTE_DESKTOP_WINDOW_BLOCKED_NOTICE_MS - 1); });
    expect(screen.getByTestId(NOTICE)).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it('does not offer to install an app from inside the installed app (the entry hides itself)', () => {
    displayMode.set('standalone');
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(<RemoteDesktopWindowBlockedNotice />);
    act(() => { openRemoteDesktopWindow('srv-1'); });
    expect(screen.getByTestId(NOTICE)).not.toBeNull();
    expect(screen.queryByTestId('remote-desktop-install-app')).toBeNull();
  });

  it('does not depend on the size the browser gave the window (Chrome ignores the requested size): it neither reads nor resizes it', () => {
    const trap = (name: string) => () => { throw new Error(`the opener must not depend on ${name}`); };
    const chosenByTheBrowser = {
      get innerWidth(): number { return trap('innerWidth')(); },
      get outerWidth(): number { return trap('outerWidth')(); },
      get innerHeight(): number { return trap('innerHeight')(); },
      get outerHeight(): number { return trap('outerHeight')(); },
      resizeTo: trap('resizeTo'),
      resizeBy: trap('resizeBy'),
      moveTo: trap('moveTo'),
    } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(chosenByTheBrowser);
    expect(() => openRemoteDesktopWindow('srv-1')).not.toThrow();
    expect(() => openRemoteDesktopWallWindow()).not.toThrow();
  });
});

describe('inside the installed app another window is another app window, not a pop-up', () => {
  it('opens the app\'s own deep link, with no window features (a feature string would make it a pop-up with an address strip)', () => {
    displayMode.set('standalone');
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    openRemoteDesktopWindow('srv-1');
    expect(open).toHaveBeenCalledTimes(1);
    const [url, target, features] = open.mock.calls[0]!;
    expect(url).toBe(`${window.location.origin}${REMOTE_DESKTOP_APP_SCOPE}?machine=srv-1`);
    expect(target).toBe('_blank');
    expect(features).toBeUndefined();
  });

  it('opens the app start page for the wall', () => {
    displayMode.set('standalone');
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    openRemoteDesktopWallWindow();
    expect(open.mock.calls[0]![0]).toBe(`${window.location.origin}${REMOTE_DESKTOP_APP_SCOPE}`);
  });

  it('is still told when the browser blocks that window', () => {
    displayMode.set('standalone');
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(<RemoteDesktopWindowBlockedNotice />);
    act(() => { openRemoteDesktopWindow('srv-1'); });
    expect(screen.getByTestId(NOTICE)).not.toBeNull();
  });

  it('keeps opening a pop-up with the machine query in a plain browser tab (the existing path, unchanged)', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    openRemoteDesktopWindow('srv-1');
    expect(String(open.mock.calls[0]![0])).toContain('remoteDesktopServer=srv-1');
    expect(String(open.mock.calls[0]![2])).toContain('popup=yes');
  });
});

describe('the installed-app entry route', () => {
  it('is the machine wall for the app path, and one machine for a deep link', () => {
    expect(resolveRemoteDesktopAppEntry('/remote-desktop/app/', '')).toEqual({ machineId: null });
    expect(resolveRemoteDesktopAppEntry('/remote-desktop/app', '')).toEqual({ machineId: null });
    expect(resolveRemoteDesktopAppEntry('/remote-desktop/app/', '?machine=srv-1')).toEqual({ machineId: 'srv-1' });
  });

  it('ignores a machine id that is not a plausible server id (the wall opens instead of a broken window)', () => {
    expect(resolveRemoteDesktopAppEntry('/remote-desktop/app/', '?machine=a/b')).toEqual({ machineId: null });
  });

  it('is nothing for every other page, including the guest access page and the main app', () => {
    for (const path of ['/', '/remote-desktop/access', '/remote-desktop/native-step-up', '/remote-desktop/app/extra']) {
      expect(resolveRemoteDesktopAppEntry(path, '?machine=srv-1'), path).toBeNull();
    }
  });
});

describe('nothing opens a remote desktop window behind the notice\'s back', () => {
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });

  it('builds the window URLs only in remote-desktop-window.ts, whose openers report a block', () => {
    const offenders = sources(srcDir)
      .filter((file) => relative(srcDir, file) !== 'remote-desktop-window.ts')
      .filter((file) => /buildRemoteDesktop(Wall)?WindowUrl\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(srcDir, file));
    expect(offenders).toEqual([]);
  });

  it('has the one notice host mounted by the main app and by both standalone windows', () => {
    const mountedIn = ['app.tsx', 'components/RemoteDesktopStandalone.tsx', 'components/RemoteDesktopWallStandalone.tsx']
      .filter((file) => readFileSync(join(srcDir, file), 'utf8').includes('<RemoteDesktopWindowBlockedNotice />'));
    expect(mountedIn).toEqual(['app.tsx', 'components/RemoteDesktopStandalone.tsx', 'components/RemoteDesktopWallStandalone.tsx']);
  });
});
