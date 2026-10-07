/**
 * macOS adapter of the local-panel window. As the root launchd service it starts everything in the console user's Aqua session
 * (launchctl asuser, the same path every other macOS user-session launch uses); run by the user (the app or a desktop entry) it
 * starts them directly. Decisions live in shared/local-panel-window.ts.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chown, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  LOCAL_PANEL_APP_MODE_BROWSERS,
  LOCAL_PANEL_PROFILE_DIR_ENV,
  buildLocalPanelAppModeArgs,
} from '../../shared/local-panel-window.js';
import { AIDESK_LOCAL_UI_EXECUTABLE_NAME } from '../../shared/aidesk-product.js';
import { imcodesStateDirForHome } from '../util/imcodes-state-dir.js';
import { resolveVerifiedAideskLocalUi } from './aidesk-local-ui-artifact.js';
import {
  resolveMacosUserSession,
  runMacosUserSessionCommand,
  type MacosUserSession,
} from './user-session-launcher.js';
import type { LocalPanelWindowPlatform } from './local-panel-window.js';

export interface MacosPanelWindowDeps {
  uid: () => number;
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  now: () => number;
  resolveUser: () => Promise<MacosUserSession>;
  /** Runs a command (no session switch) to completion. */
  run: (file: string, args: readonly string[]) => Promise<{ code: number | null; stdout: string }>;
  /** Runs a command to completion inside the console user's graphical session; false when it failed. */
  runInSession: (user: MacosUserSession, file: string, args: readonly string[]) => Promise<boolean>;
  /** Starts a long-lived GUI process in the user's session (or directly when already the user); true once it started. */
  startInSession: (user: MacosUserSession | undefined, file: string, args: readonly string[]) => Promise<boolean>;
  prepareProfileParent: (dir: string, user: MacosUserSession | undefined) => Promise<void>;
  /** The verified native window (inside the signed app), or undefined. */
  nativeUiPath: () => Promise<string | undefined>;
}

const realDeps = (): MacosPanelWindowDeps => ({
  uid: () => process.getuid?.() ?? -1,
  env: process.env,
  exists: existsSync,
  now: Date.now,
  resolveUser: () => resolveMacosUserSession(),
  run: (file, args) => new Promise((resolve) => {
    execFile(file, [...args], { timeout: 5_000, encoding: 'utf8' }, (error, stdout) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  }),
  runInSession: async (user, file, args) => {
    try { await runMacosUserSessionCommand(user, { executable: file, args }, 8_000); return true; } catch { return false; }
  },
  startInSession: (user, file, args) => new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean): void => { if (!settled) { settled = true; resolve(value); } };
    // As root the process is started by launchctl in the user's session (fire and forget, like every other macOS user-session
    // launch); as the user it is spawned directly.
    if (user) {
      void import('./user-session-launcher.js').then(({ launchMacosUserSessionCommand }) => {
        try { launchMacosUserSessionCommand(user, { executable: file, args }); done(true); } catch { done(false); }
      }).catch(() => done(false));
      return;
    }
    try {
      const child = spawn(file, [...args], { detached: true, stdio: 'ignore' });
      child.once('error', () => done(false));
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

export function createMacosLocalPanelWindowPlatform(overrides: Partial<MacosPanelWindowDeps> = {}): LocalPanelWindowPlatform & { profileDir(): Promise<string | undefined> } {
  const deps = { ...realDeps(), ...overrides };
  const asRoot = (): boolean => deps.uid() === 0;
  /** The console user when running as root; undefined when already the user. */
  let cachedUser: Promise<MacosUserSession | undefined> | undefined;
  const sessionUser = (): Promise<MacosUserSession | undefined> => {
    cachedUser ??= asRoot() ? deps.resolveUser().catch(() => undefined) : Promise.resolve(undefined);
    return cachedUser;
  };
  const homeOf = async (): Promise<string | undefined> => (await sessionUser())?.home ?? deps.env.HOME;
  const profileDir = async (): Promise<string | undefined> => {
    const override = deps.env[LOCAL_PANEL_PROFILE_DIR_ENV]?.trim();
    if (override && isAbsolute(override)) return override;
    const home = await homeOf();
    return home ? join(imcodesStateDirForHome(home, deps.env), 'local-panel', 'browser-profile') : undefined;
  };
  const browserExecutable = async (name: string): Promise<string | undefined> => {
    const home = await homeOf();
    const roots = ['/Applications', ...(home ? [join(home, 'Applications')] : [])];
    for (const root of roots) {
      const path = join(root, `${name}.app`, 'Contents', 'MacOS', name);
      if (deps.exists(path)) return path;
    }
    return undefined;
  };
  const startedAtOf = async (pid: number): Promise<number | undefined> => {
    const out = await deps.run('/bin/ps', ['-o', 'etime=', '-p', String(pid)]);
    // etime is [[dd-]hh:]mm:ss
    const text = out.stdout.trim();
    if (out.code !== 0 || !text) return undefined;
    const [dayPart, clock] = text.includes('-') ? text.split('-') as [string, string] : ['0', text];
    const parts = clock.split(':').map(Number);
    if (parts.some((value) => !Number.isFinite(value)) || parts.length < 2 || parts.length > 3) return undefined;
    const [seconds = 0, minutes = 0, hours = 0] = [...parts].reverse();
    return deps.now() - (((Number(dayPart) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  };

  return {
    platform: 'darwin',
    profileDir,
    canFocus: true,
    async hasDesktop() {
      // As root there must be a console user with a graphical (Aqua) session; started by the user, there is one by definition.
      return asRoot() ? (await sessionUser()) !== undefined : true;
    },
    nativeUiPath() {
      return deps.nativeUiPath();
    },
    async findAppModeBrowsers() {
      const found = await Promise.all(LOCAL_PANEL_APP_MODE_BROWSERS.darwin.map(browserExecutable));
      return found.filter((path): path is string => path !== undefined);
    },
    async findWindowProcess() {
      const patterns = [await profileDir(), `/${AIDESK_LOCAL_UI_EXECUTABLE_NAME}`].filter((value): value is string => !!value);
      for (const pattern of patterns) {
        const out = await deps.run('/usr/bin/pgrep', ['-f', '--', pattern]);
        const pid = out.stdout.split(/\s+/u).map(Number).filter((value) => Number.isSafeInteger(value) && value > 0).sort((a, b) => a - b)[0];
        if (pid === undefined) continue;
        const startedAtMs = await startedAtOf(pid);
        if (startedAtMs !== undefined) return { pid, startedAtMs };
      }
      return undefined;
    },
    async probePid(pid) {
      const startedAtMs = await startedAtOf(pid);
      return startedAtMs === undefined ? { alive: false } : { alive: true, startedAtMs };
    },
    async focusWindow(window) {
      const script = `tell application "System Events" to set frontmost of (first process whose unix id is ${window.pid}) to true`;
      const user = await sessionUser();
      if (user) return deps.runInSession(user, '/usr/bin/osascript', ['-e', script]);
      return (await deps.run('/usr/bin/osascript', ['-e', script])).code === 0;
    },
    async launchNative(path) {
      return deps.startInSession(await sessionUser(), path, []);
    },
    async launchAppMode(browser) {
      const profile = await profileDir();
      if (!profile) return false;
      const user = await sessionUser();
      try { await deps.prepareProfileParent(join(profile, '..'), user); } catch { return false; }
      return deps.startInSession(user, browser, buildLocalPanelAppModeArgs(profile));
    },
    async openDefaultBrowser(url) {
      const user = await sessionUser();
      if (user) return deps.runInSession(user, '/usr/bin/open', [url]);
      return (await deps.run('/usr/bin/open', [url])).code === 0;
    },
  };
}
