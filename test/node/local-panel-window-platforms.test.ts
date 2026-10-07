/**
 * The three thin OS adapters of the local-panel window, driven with fake machines: which user/display a window is started for, which
 * command lines are run, how the running window is found and focused. Real-device behavior is checked separately on real machines.
 */
import { describe, expect, it } from 'vitest';
import { localPanelUrl } from '../../shared/local-panel-window.js';
import { createLinuxLocalPanelWindowPlatform } from '../../src/node/local-panel-window-linux.js';
import { createMacosLocalPanelWindowPlatform } from '../../src/node/local-panel-window-macos.js';
import {
  buildWindowsPanelProcessQuery,
  buildWindowsPanelWindowCommand,
  createWindowsLocalPanelWindowPlatform,
} from '../../src/node/local-panel-window-windows.js';

const PASSWD = 'root:x:0:0:root:/root:/bin/bash\nalice:x:1000:1000:Alice:/home/alice:/bin/bash\nbob:x:1001:1001:Bob:/home/bob:/bin/bash\nnobody:x:65534:65534::/nonexistent:/usr/sbin/nologin\n';

function decodePowerShell(command: string): string {
  const encoded = /-EncodedCommand (\S+)/u.exec(command)?.[1] ?? '';
  return Buffer.from(encoded, 'base64').toString('utf16le');
}
const decodeB64 = (text: string): string => Buffer.from(text, 'base64').toString('utf8');

describe('Linux adapter', () => {
  function linux(over: Partial<Parameters<typeof createLinuxLocalPanelWindowPlatform>[0]> = {}) {
    const commands: Array<{ file: string; args: readonly string[]; asUser?: string; display?: string }> = [];
    const spawned: Array<{ file: string; args: readonly string[]; asUser?: string; env: NodeJS.ProcessEnv }> = [];
    const platform = createLinuxLocalPanelWindowPlatform({
      uid: () => 0,
      env: { PATH: '/usr/bin:/bin' },
      readPasswd: () => PASSWD,
      exists: (path) => ['/home/alice', '/usr/bin/chromium', '/usr/bin/xdotool', '/usr/bin/google-chrome'].includes(path),
      listDisplays: () => [0],
      now: () => 1_000_000,
      run: async (file, args, options) => {
        commands.push({ file, args, ...(options.asUser ? { asUser: options.asUser.name } : {}), ...(options.env.DISPLAY ? { display: options.env.DISPLAY } : {}) });
        if (file === 'pgrep') return { code: 0, stdout: '4242\n4300\n' };
        if (file === 'ps') return { code: 0, stdout: ' 120\n' };
        return { code: 0, stdout: '' };
      },
      spawnDetached: async (file, args, options) => { spawned.push({ file, args, ...(options.asUser ? { asUser: options.asUser.name } : {}), env: options.env }); return true; },
      prepareProfileParent: async () => undefined,
      nativeUiPath: async () => '/opt/imcodes/aidesk-local-ui',
      ...over,
    });
    return { platform, commands, spawned };
  }

  it('a root service starts the window as the desktop user, on that user\'s display, with their home -- never as root', async () => {
    const { platform, spawned } = linux();
    expect(await platform.hasDesktop()).toBe(true);
    expect(await platform.launchAppMode('/usr/bin/chromium')).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ file: '/usr/bin/chromium', asUser: 'alice' });
    expect(spawned[0]!.env).toMatchObject({ DISPLAY: ':0', HOME: '/home/alice', USER: 'alice', XDG_RUNTIME_DIR: '/run/user/1000' });
    expect(spawned[0]!.args).toContain(`--app=${localPanelUrl()}`);
    expect(spawned[0]!.args.join(' ')).toContain('--user-data-dir=/home/alice/.imcodes/local-panel/browser-profile');
    expect(platform.profileDir()).toBe('/home/alice/.imcodes/local-panel/browser-profile');
  });

  it('no desktop: a root service with no X display, with no desktop user, or a user session without DISPLAY/WAYLAND', async () => {
    expect(await linux({ listDisplays: () => [] }).platform.hasDesktop()).toBe(false);
    expect(await linux({ readPasswd: () => 'root:x:0:0::/root:/bin/bash\n' }).platform.hasDesktop()).toBe(false);
    expect(await linux({ uid: () => 1000, env: { HOME: '/home/alice', PATH: '/usr/bin' } }).platform.hasDesktop()).toBe(false);
    expect(await linux({ uid: () => 1000, env: { HOME: '/home/alice', PATH: '/usr/bin', DISPLAY: ':1' } }).platform.hasDesktop()).toBe(true);
    expect(await linux({ uid: () => 1000, env: { HOME: '/home/alice', PATH: '/usr/bin', WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000' } }).platform.hasDesktop()).toBe(true);
  });

  it('started by the user it spawns directly with their own environment (no uid switch)', async () => {
    const { platform, spawned } = linux({ uid: () => 1000, env: { HOME: '/home/alice', PATH: '/usr/bin', DISPLAY: ':1' } });
    await platform.launchAppMode('/usr/bin/chromium');
    expect(spawned[0]).not.toHaveProperty('asUser');
    expect(spawned[0]!.env.DISPLAY).toBe(':1');
  });

  it('finds app-mode browsers in preference order and de-duplicates', async () => {
    const { platform } = linux({ exists: (path) => ['/home/alice', '/usr/bin/chromium', '/usr/bin/google-chrome'].includes(path) });
    expect(await platform.findAppModeBrowsers()).toEqual(['/usr/bin/google-chrome', '/usr/bin/chromium']);
    expect(await linux({ exists: (path) => path === '/home/alice' }).platform.findAppModeBrowsers()).toEqual([]);
  });

  it('finds the window by its profile (lowest pid) and its start time from the process age', async () => {
    const { platform, commands } = linux();
    expect(await platform.findWindowProcess()).toEqual({ pid: 4242, startedAtMs: 1_000_000 - 120_000 });
    expect(commands[0]).toMatchObject({ file: 'pgrep' });
    expect(commands[0]!.args.join(' ')).toContain('/home/alice/.imcodes/local-panel/browser-profile');
  });

  it('a dead pid is not alive', async () => {
    const { platform } = linux({ run: async () => ({ code: 1, stdout: '' }) });
    expect(await platform.probePid(7)).toEqual({ alive: false });
  });

  it('focus uses xdotool as the desktop user, falls back to wmctrl, and is refused without an X display', async () => {
    const { platform, commands } = linux();
    expect(await platform.focusWindow({ pid: 1, startedAtMs: 1 })).toBe(true);
    expect(commands.at(-1)).toMatchObject({ file: '/usr/bin/xdotool', asUser: 'alice', display: ':0' });
    // a bare X server (no window manager) refuses windowactivate: raising + focusing is the fallback
    const bare = linux({ run: async (file, args) => ({ code: args.includes('windowactivate') ? 1 : 0, stdout: file === 'pgrep' ? '1\n' : '' }) });
    expect(await bare.platform.focusWindow({ pid: 1, startedAtMs: 1 })).toBe(true);
    const none = linux({ listDisplays: () => [] });
    expect(await none.platform.focusWindow({ pid: 1, startedAtMs: 1 })).toBe(false);
    const wm = linux({ exists: (path) => ['/home/alice', '/usr/bin/wmctrl'].includes(path) });
    expect(await wm.platform.focusWindow({ pid: 1, startedAtMs: 1 })).toBe(true);
    expect(wm.commands.at(-1)?.file).toBe('/usr/bin/wmctrl');
    const neither = linux({ exists: (path) => path === '/home/alice' });
    expect(await neither.platform.focusWindow({ pid: 1, startedAtMs: 1 })).toBe(false);
  });

  it('the default browser is xdg-open as the desktop user with the panel URL', async () => {
    const { platform, commands } = linux();
    expect(await platform.openDefaultBrowser(localPanelUrl())).toBe(true);
    expect(commands.at(-1)).toMatchObject({ file: 'xdg-open', args: [localPanelUrl()], asUser: 'alice' });
  });

  it('the native window is whatever the verifier returned (nothing when it did not verify)', async () => {
    expect(await linux({ nativeUiPath: async () => undefined }).platform.nativeUiPath()).toBeUndefined();
    expect(await linux().platform.nativeUiPath()).toBe('/opt/imcodes/aidesk-local-ui');
  });
});

describe('macOS adapter', () => {
  const user = { name: 'k', uid: 501, gid: 20, home: '/Users/k', tempDir: '/var/folders/x/T/' };
  function mac(over: Partial<Parameters<typeof createMacosLocalPanelWindowPlatform>[0]> = {}) {
    const started: Array<{ user?: string; file: string; args: readonly string[] }> = [];
    const inSession: Array<{ file: string; args: readonly string[] }> = [];
    const runs: Array<{ file: string; args: readonly string[] }> = [];
    const platform = createMacosLocalPanelWindowPlatform({
      uid: () => 0, env: {}, now: () => 10_000_000, resolveUser: async () => user,
      exists: (path) => ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].includes(path),
      run: async (file, args) => {
        runs.push({ file, args });
        if (file === '/usr/bin/pgrep') return { code: 0, stdout: '900\n' };
        if (file === '/bin/ps') return { code: 0, stdout: ' 1-02:03:04\n' };
        return { code: 0, stdout: '' };
      },
      runInSession: async (_user, file, args) => { inSession.push({ file, args }); return true; },
      startInSession: async (u, file, args) => { started.push({ ...(u ? { user: u.name } : {}), file, args }); return true; },
      prepareProfileParent: async () => undefined,
      nativeUiPath: async () => '/Applications/aiDesk.app/Contents/Helpers/aidesk-local-ui',
      ...over,
    });
    return { platform, started, inSession, runs };
  }

  it('as root it starts the browser in the console user\'s session with that user\'s profile; with no console user there is no desktop', async () => {
    const { platform, started } = mac();
    expect(await platform.hasDesktop()).toBe(true);
    expect(await platform.findAppModeBrowsers()).toEqual([
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]);
    await platform.launchAppMode('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(started[0]).toMatchObject({ user: 'k', file: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    expect(started[0]!.args.join(' ')).toContain('--user-data-dir=/Users/k/.imcodes/local-panel/browser-profile');
    expect(await mac({ resolveUser: async () => { throw new Error('no console user'); } }).platform.hasDesktop()).toBe(false);
    expect(await mac({ uid: () => 501, env: { HOME: '/Users/k' }, resolveUser: async () => { throw new Error('unused'); } }).platform.hasDesktop()).toBe(true);
  });

  it('finds the window and converts the process age [dd-]hh:mm:ss into a start time', async () => {
    const { platform } = mac();
    const age = ((1 * 24 + 2) * 60 + 3) * 60 + 4;
    expect(await platform.findWindowProcess()).toEqual({ pid: 900, startedAtMs: 10_000_000 - age * 1000 });
    expect(await mac({ run: async () => ({ code: 0, stdout: ' 05:07\n' }) }).platform.probePid(1)).toEqual({ alive: true, startedAtMs: 10_000_000 - (5 * 60 + 7) * 1000 });
    expect(await mac({ run: async () => ({ code: 1, stdout: '' }) }).platform.probePid(1)).toEqual({ alive: false });
  });

  it('focuses by process id through System Events in the user\'s session, and opens the default browser with /usr/bin/open', async () => {
    const { platform, inSession } = mac();
    expect(await platform.focusWindow({ pid: 900, startedAtMs: 1 })).toBe(true);
    expect(inSession[0]!.file).toBe('/usr/bin/osascript');
    expect(inSession[0]!.args.join(' ')).toContain('unix id is 900');
    expect(await platform.openDefaultBrowser(localPanelUrl())).toBe(true);
    expect(inSession[1]).toEqual({ file: '/usr/bin/open', args: [localPanelUrl()] });
  });

  it('the native window is the verified helper inside the signed app, or nothing', async () => {
    expect(await mac().platform.nativeUiPath()).toBe('/Applications/aiDesk.app/Contents/Helpers/aidesk-local-ui');
    expect(await mac({ nativeUiPath: async () => undefined }).platform.nativeUiPath()).toBeUndefined();
  });
});

describe('Windows adapter', () => {
  it('the app-mode script resolves the browser from App Paths in the user\'s session, builds the profile under LOCALAPPDATA and passes the shared arguments', () => {
    const script = decodePowerShell(buildWindowsPanelWindowCommand({ kind: 'launch_app', browser: 'msedge.exe' }, 'C:\\Temp\\result.txt'));
    expect(script).toContain('App Paths');
    expect(script).toContain('$env:LOCALAPPDATA');
    expect(script).toContain('IM.codes\\local-panel\\browser-profile');
    expect(script).toContain('Start-Process');
    const embedded = [...script.matchAll(/D '([A-Za-z0-9+/=]+)'/gu)].map((match) => decodeB64(match[1]!));
    expect(embedded).toContain('msedge.exe');
    expect(embedded).toContain('C:\\Temp\\result.txt');
    const args = JSON.parse(embedded.find((value) => value.startsWith('[')) ?? '[]') as string[];
    expect(args).toContain(`--app=${localPanelUrl()}`);
    expect(args.some((arg) => arg.startsWith('--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'))).toBe(true);
    expect(args.some((arg) => arg.includes('__LOCAL_PANEL_PROFILE__'))).toBe(true);
  });

  it('the focus script targets the window by process id and by title, restores it if minimised and activates it', () => {
    const script = decodePowerShell(buildWindowsPanelWindowCommand({ kind: 'focus', pid: 4321 }));
    expect(script).toContain('Focus(4321,');
    expect(script).toContain('SetForegroundWindow');
    expect(script).toContain('IsIconic');
    expect(script).not.toContain('Report $resultPath');
  });

  it('the default-browser script opens exactly the URL it is given', () => {
    const script = decodePowerShell(buildWindowsPanelWindowCommand({ kind: 'default_browser', url: localPanelUrl() }));
    expect([...script.matchAll(/D '([A-Za-z0-9+/=]+)'/gu)].map((match) => decodeB64(match[1]!))).toContain(localPanelUrl());
    expect(script).toContain('Start-Process');
  });

  it('every script reports failed on error, and never reads credentials or the daemon directories', () => {
    for (const op of [{ kind: 'launch_app', browser: 'chrome.exe' }, { kind: 'focus', pid: 1 }, { kind: 'default_browser', url: localPanelUrl() }] as const) {
      const script = decodePowerShell(buildWindowsPanelWindowCommand(op));
      expect(script).toContain("trap{Report 'failed'");
      expect(script).not.toMatch(/credential|ProgramData|\.imcodes\b|imcodes-node/iu);
    }
  });

  it('the process query finds the app-mode browser by its profile and the native window by name', () => {
    const query = buildWindowsPanelProcessQuery();
    expect(query).toContain('local-panel');
    expect(query).toContain('browser-profile');
    expect(query).toContain('aidesk-local-ui.exe');
  });

  it('as SYSTEM, a desktop exists only while a user session runs explorer; the window process is parsed from the query output', async () => {
    const env = { USERNAME: 'DESKTOP-1$' };
    const base = { env, exists: () => false, runOp: async () => 'ok', launchNative: async () => true, nativeUiPath: async () => 'C:\\Program Files\\IM.codes\\aidesk-local-ui.exe' };
    expect(await createWindowsLocalPanelWindowPlatform({ ...base, powershell: async () => '1\r\n' }).hasDesktop()).toBe(true);
    expect(await createWindowsLocalPanelWindowPlatform({ ...base, powershell: async () => '' }).hasDesktop()).toBe(false);
    expect(await createWindowsLocalPanelWindowPlatform({ ...base, env: { USERNAME: 'alice' }, powershell: async () => '' }).hasDesktop()).toBe(true);
    const found = createWindowsLocalPanelWindowPlatform({ ...base, powershell: async () => '5120 1790000000123\r\n' });
    expect(await found.findWindowProcess()).toEqual({ pid: 5120, startedAtMs: 1_790_000_000_123 });
    expect(await createWindowsLocalPanelWindowPlatform({ ...base, powershell: async () => '' }).findWindowProcess()).toBeUndefined();
    expect(await createWindowsLocalPanelWindowPlatform({ ...base, powershell: async () => 'garbage' }).findWindowProcess()).toBeUndefined();
  });

  it('operations map the script word to success; only an absolute existing native path is offered; browsers are the shared list', async () => {
    const ops: string[] = [];
    const platform = createWindowsLocalPanelWindowPlatform({
      env: { USERNAME: 'alice' }, powershell: async () => '', launchNative: async () => true,
      runOp: async (op) => { ops.push(op.kind); return op.kind === 'launch_app' && op.browser === 'msedge.exe' ? 'ok' : 'not_found'; },
      exists: () => true, nativeUiPath: async () => 'C:\\Program Files\\IM.codes\\aidesk-local-ui.exe',
    });
    expect(await platform.launchAppMode('msedge.exe')).toBe(true);
    expect(await platform.launchAppMode('chrome.exe')).toBe(false);
    expect(await platform.focusWindow({ pid: 1, startedAtMs: 1 })).toBe(false);
    expect(await platform.findAppModeBrowsers()).toEqual(['msedge.exe', 'chrome.exe', 'brave.exe']);
    expect(await platform.nativeUiPath()).toBe('C:\\Program Files\\IM.codes\\aidesk-local-ui.exe');
    expect(await createWindowsLocalPanelWindowPlatform({ env: {}, powershell: async () => '', runOp: async () => 'ok', launchNative: async () => true, exists: () => true, nativeUiPath: async () => 'relative\\aidesk-local-ui.exe' }).nativeUiPath()).toBeUndefined();
    expect(ops).toEqual(['launch_app', 'launch_app', 'focus']);
  });
});
