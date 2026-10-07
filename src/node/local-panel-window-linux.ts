/**
 * Linux adapter of the local-panel window: how to find, focus and start the window for the desktop user. Everything it does is
 * "run this command as that user with that display"; the decisions live in shared/local-panel-window.ts.
 *
 * A controlled node runs as root (systemd), a desktop entry runs the same CLI as the desktop user. Either way the window is started
 * as the desktop user (never root) with that user's DISPLAY, so it appears on their desktop.
 */
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chown, mkdir } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import {
  LOCAL_PANEL_APP_MODE_BROWSERS,
  LOCAL_PANEL_PROFILE_DIR_ENV,
  LOCAL_PANEL_WINDOW_TITLE,
  buildLocalPanelAppModeArgs,
} from '../../shared/local-panel-window.js';
import { AIDESK_LOCAL_UI_EXECUTABLE_NAME } from '../../shared/aidesk-product.js';
import { imcodesStateDirForHome } from '../util/imcodes-state-dir.js';
import { resolveVerifiedAideskLocalUi } from './aidesk-local-ui-artifact.js';
import { listX11DisplayNumbers, X11_SOCKET_DIR } from './linux-x11-display.js';
import { pickLinuxDesktopUserProfile, type LinuxDesktopUserProfile } from './linux-desktop-environment.js';
import type { LocalPanelWindowPlatform, LocalPanelWindowProcess } from './local-panel-window.js';

export interface LinuxPanelWindowDeps {
  uid: () => number;
  env: NodeJS.ProcessEnv;
  readPasswd: () => string;
  exists: (path: string) => boolean;
  listDisplays: () => number[];
  now: () => number;
  /** Runs a command to completion; `asUser` drops privileges to the desktop user. Resolves with the exit code (null = could not run). */
  run: (file: string, args: readonly string[], options: { asUser?: LinuxDesktopUserProfile; env: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<{ code: number | null; stdout: string }>;
  /** Starts a long-lived GUI process detached from the node; true once it has really started. */
  spawnDetached: (file: string, args: readonly string[], options: { asUser?: LinuxDesktopUserProfile; env: NodeJS.ProcessEnv }) => Promise<boolean>;
  prepareProfileParent: (dir: string, user: LinuxDesktopUserProfile | undefined) => Promise<void>;
  /** The verified native window path (manifest + hash), or undefined. */
  nativeUiPath: () => Promise<string | undefined>;
}

const realDeps = (): LinuxPanelWindowDeps => ({
  uid: () => process.getuid?.() ?? -1,
  env: process.env,
  readPasswd: () => readFileSync('/etc/passwd', 'utf8'),
  exists: existsSync,
  listDisplays: () => listX11DisplayNumbers(X11_SOCKET_DIR),
  now: Date.now,
  run: (file, args, options) => new Promise((resolve) => {
    execFile(file, [...args], {
      timeout: options.timeoutMs ?? 5_000, env: options.env, encoding: 'utf8',
      ...(options.asUser ? { uid: options.asUser.uid, gid: options.asUser.gid } : {}),
    }, (error, stdout) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  }),
  spawnDetached: (file, args, options) => new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean): void => { if (!settled) { settled = true; resolve(value); } };
    try {
      const child = spawn(file, [...args], {
        detached: true, stdio: 'ignore', env: options.env,
        ...(options.asUser ? { uid: options.asUser.uid, gid: options.asUser.gid } : {}),
      });
      child.once('error', () => done(false));
      // A GUI launcher that is still running (or handed off cleanly) after a moment started; one that died at once did not.
      child.once('exit', (code) => done(code === 0));
      child.once('spawn', () => { child.unref(); setTimeout(() => done(true), 800); });
    } catch { done(false); }
  }),
  prepareProfileParent: async (dir, user) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (user && process.getuid?.() === 0) await chown(dir, user.uid, user.gid);
  },
  nativeUiPath: () => resolveVerifiedAideskLocalUi(),
});

export function createLinuxLocalPanelWindowPlatform(overrides: Partial<LinuxPanelWindowDeps> = {}): LocalPanelWindowPlatform & {
  /** The browser profile directory used for app mode (inside the desktop user's own state directory). */
  profileDir(): string | undefined;
} {
  const deps = { ...realDeps(), ...overrides };
  const asRoot = (): boolean => deps.uid() === 0;
  const desktopUser = (): LinuxDesktopUserProfile | undefined => {
    if (!asRoot()) return undefined;
    return pickLinuxDesktopUserProfile(deps.readPasswd(), deps.exists) ?? undefined;
  };
  const homeOf = (user: LinuxDesktopUserProfile | undefined): string | undefined => user?.home ?? deps.env.HOME;
  const profileDir = (): string | undefined => {
    const override = deps.env[LOCAL_PANEL_PROFILE_DIR_ENV]?.trim();
    if (override && isAbsolute(override)) return override;
    const home = homeOf(desktopUser());
    return home ? join(imcodesStateDirForHome(home, deps.env), 'local-panel', 'browser-profile') : undefined;
  };
  /** The environment of the desktop user's graphical session: their display, their runtime dir, never root's. */
  const sessionEnv = (user: LinuxDesktopUserProfile | undefined): NodeJS.ProcessEnv | undefined => {
    const base: NodeJS.ProcessEnv = { PATH: deps.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' };
    const home = homeOf(user);
    if (home) base.HOME = home;
    if (user) base.USER = user.name;
    let display = deps.env.DISPLAY;
    if (!display && !asRoot()) return deps.env.WAYLAND_DISPLAY ? { ...base, WAYLAND_DISPLAY: deps.env.WAYLAND_DISPLAY, XDG_RUNTIME_DIR: deps.env.XDG_RUNTIME_DIR ?? '' } : undefined;
    if (!display) {
      const first = deps.listDisplays()[0];
      if (first === undefined) return undefined;
      display = `:${first}`;
    }
    base.DISPLAY = display;
    const authority = deps.env.XAUTHORITY ?? (home && deps.exists(join(home, '.Xauthority')) ? join(home, '.Xauthority') : undefined);
    if (authority) base.XAUTHORITY = authority;
    const runtime = deps.env.XDG_RUNTIME_DIR ?? (user ? `/run/user/${user.uid}` : undefined);
    if (runtime) base.XDG_RUNTIME_DIR = runtime;
    if (deps.env.WAYLAND_DISPLAY) base.WAYLAND_DISPLAY = deps.env.WAYLAND_DISPLAY;
    return base;
  };
  const which = (name: string): string | undefined => {
    for (const dir of (deps.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(delimiter)) {
      if (dir && deps.exists(join(dir, name))) return join(dir, name);
    }
    for (const dir of ['/opt/google/chrome', '/opt/microsoft/msedge', '/snap/bin', '/usr/bin']) {
      if (deps.exists(join(dir, name))) return join(dir, name);
    }
    return undefined;
  };
  const startedAtOf = async (pid: number): Promise<number | undefined> => {
    const out = await deps.run('ps', ['-o', 'etimes=', '-p', String(pid)], { env: deps.env });
    const seconds = Number.parseInt(out.stdout.trim(), 10);
    return out.code === 0 && Number.isFinite(seconds) ? deps.now() - seconds * 1000 : undefined;
  };

  return {
    platform: 'linux',
    profileDir,
    canFocus: true,
    async hasDesktop() {
      const user = desktopUser();
      if (asRoot() && !user) return false;
      return sessionEnv(user) !== undefined;
    },
    nativeUiPath() {
      return deps.nativeUiPath();
    },
    async findAppModeBrowsers() {
      const found = LOCAL_PANEL_APP_MODE_BROWSERS.linux.map(which).filter((path): path is string => path !== undefined);
      return [...new Set(found)];
    },
    async findWindowProcess() {
      const patterns = [profileDir(), `/${AIDESK_LOCAL_UI_EXECUTABLE_NAME}`].filter((value): value is string => !!value);
      for (const pattern of patterns) {
        const out = await deps.run('pgrep', ['-f', '--', pattern], { env: deps.env });
        const pids = out.stdout.split(/\s+/u).map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0).sort((a, b) => a - b);
        const pid = pids[0];
        if (pid === undefined) continue;
        const startedAtMs = await startedAtOf(pid);
        if (startedAtMs !== undefined) return { pid, startedAtMs } satisfies LocalPanelWindowProcess;
      }
      return undefined;
    },
    async probePid(pid) {
      const startedAtMs = await startedAtOf(pid);
      return startedAtMs === undefined ? { alive: false } : { alive: true, startedAtMs };
    },
    async focusWindow(window) {
      const user = desktopUser();
      const env = sessionEnv(user);
      if (!env?.DISPLAY) return false; // Wayland-only: no X tool can raise a window; the existing one is kept
      const exact = `^${LOCAL_PANEL_WINDOW_TITLE.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`;
      const asUser = user ? { asUser: user } : {};
      const xdotool = which('xdotool');
      if (xdotool) {
        // By process first (the recorded window, whichever mechanism opened it), then by the one window title.
        for (const selector of [['--pid', String(window.pid)], ['--name', exact]]) {
          const out = await deps.run(xdotool, ['search', ...selector, 'windowactivate'], { env, ...asUser });
          if (out.code === 0) return true;
          // No EWMH window manager (a bare X server, some minimal desktops) cannot "activate"; raising and focusing still works.
          const plain = await deps.run(xdotool, ['search', ...selector, 'windowraise', 'windowfocus'], { env, ...asUser });
          if (plain.code === 0) return true;
        }
      }
      const wmctrl = which('wmctrl');
      if (wmctrl) return (await deps.run(wmctrl, ['-a', LOCAL_PANEL_WINDOW_TITLE], { env, ...asUser })).code === 0;
      return false;
    },
    async launchNative(path) {
      const user = desktopUser();
      const env = sessionEnv(user);
      return env !== undefined && deps.spawnDetached(path, [], { env, ...(user ? { asUser: user } : {}) });
    },
    async launchAppMode(browser) {
      const user = desktopUser();
      const env = sessionEnv(user);
      const profile = profileDir();
      if (!env || !profile) return false;
      try { await deps.prepareProfileParent(join(profile, '..'), user); } catch { return false; }
      return deps.spawnDetached(browser, buildLocalPanelAppModeArgs(profile), { env, ...(user ? { asUser: user } : {}) });
    },
    async openDefaultBrowser(url) {
      const user = desktopUser();
      const env = sessionEnv(user);
      if (!env) return false;
      return (await deps.run('xdg-open', [url], { env, ...(user ? { asUser: user } : {}), timeoutMs: 8_000 })).code === 0;
    },
  };
}
