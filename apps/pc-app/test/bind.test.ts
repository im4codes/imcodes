import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COOKIE_SESSION as SHARED_COOKIE_SESSION } from '../../../shared/cookie-names.js';
import {
  BindCoordinator,
  COOKIE_SESSION,
  ensureBundledTmuxEnv,
  inspectMacosLaunchAgentPlist,
  parseLaunchAgentPlistPaths,
  readServerJsonOrNull,
  resolveImcodesBinPath,
  sameOriginCookie,
  type BindMessageBoxOptions,
  type CliRunResult,
  type CookieLike,
  type CookiesChangeEventLike,
} from '../src/bind.js';
import type { MenuItemOptionsLike } from '../src/menu.js';
import { MAIN_WINDOW_WEB_PREFERENCES } from '../src/security.js';
import { createPcAppShell, type ShellWindowLike } from '../src/shell.js';

function createFakeCookies(initial: Record<string, CookieLike[]> = {}): CookiesChangeEventLike & {
  emitChanged: (cookie: CookieLike, removed: boolean) => void;
  setCookie: (url: string, cookie: CookieLike | null) => void;
  getCalls: Array<{ url: string; name: string }>;
} {
  const emitter = new EventEmitter();
  const byUrl = new Map<string, CookieLike[]>(Object.entries(initial));
  const getCalls: Array<{ url: string; name: string }> = [];

  return {
    getCalls,
    on: (event, listener) => emitter.on(event, listener),
    get: async (filter) => {
      getCalls.push(filter);
      const list = byUrl.get(filter.url) ?? [];
      return list.filter((c) => c.name === filter.name);
    },
    emitChanged: (cookie, removed) => {
      emitter.emit('changed', {}, cookie, 'explicit', removed);
    },
    setCookie: (url, cookie) => {
      if (cookie === null) {
        byUrl.delete(url);
      } else {
        byUrl.set(url, [cookie]);
      }
    },
  };
}

function createFakeShellWindow(opts: {
  webPreferences: typeof MAIN_WINDOW_WEB_PREFERENCES;
  cookies: CookiesChangeEventLike;
}): ShellWindowLike & {
  webContentsEmitter: EventEmitter;
  setUrlForTest: (u: string) => void;
} {
  const emitter = new EventEmitter();
  const webContentsEmitter = new EventEmitter();
  let url = '';
  const destroyed = false;

  const session = Object.assign(new EventEmitter(), {
    cookies: opts.cookies,
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    clearStorageData: vi.fn(async () => {}),
  });

  const webContents = Object.assign(webContentsEmitter, {
    getURL: () => url,
    setWindowOpenHandler: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    toggleDevTools: vi.fn(),
    session,
  });

  return {
    webContentsEmitter,
    setUrlForTest: (u: string) => {
      url = u;
    },
    isDestroyed: () => destroyed,
    on: (event: 'closed', listener: () => void) => emitter.on(event, listener),
    loadURL: async (nextUrl: string) => {
      url = nextUrl;
    },
    webContents,
  };
}

function findMenuItem(items: MenuItemOptionsLike[], id: string): MenuItemOptionsLike | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.submenu) {
      const found = findMenuItem(item.submenu, id);
      if (found) return found;
    }
  }
  return undefined;
}

describe('PC App V1 Phase B: bind flow, replace prompt, bundled tmux, and LaunchAgent checks', () => {
  let tempRoot: string;
  let userDataDir: string;
  let imcodesHome: string;
  let resourcesPath: string;
  let plistPath: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'imcodes-pc-app-phase-b-'));
    userDataDir = path.join(tempRoot, 'userData');
    imcodesHome = path.join(tempRoot, '.imcodes');
    resourcesPath = path.join(tempRoot, 'Resources');
    plistPath = path.join(tempRoot, 'imcodes.daemon.plist');
    mkdirSync(userDataDir, { recursive: true });
    mkdirSync(imcodesHome, { recursive: true });
    mkdirSync(resourcesPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('matches shared COOKIE_SESSION constant and strictly checks cookie same-origin / domain / path / scheme', () => {
    expect(COOKIE_SESSION).toBe(SHARED_COOKIE_SESSION);
    expect(COOKIE_SESSION).toBe('rcc_session');

    expect(
      sameOriginCookie({ name: 'rcc_session', domain: 'app.im.codes', path: '/', secure: true }, 'https://app.im.codes'),
    ).toBe(true);
    expect(
      sameOriginCookie({ name: 'rcc_session', domain: '.im.codes', path: '/' }, 'https://app.im.codes'),
    ).toBe(true);

    // Wrong cookie name
    expect(
      sameOriginCookie({ name: 'rcc_csrf', domain: 'app.im.codes', path: '/' }, 'https://app.im.codes'),
    ).toBe(false);
    // Sibling / unrelated domain
    expect(
      sameOriginCookie({ name: 'rcc_session', domain: 'other.im.codes', path: '/' }, 'https://app.im.codes'),
    ).toBe(false);
    expect(
      sameOriginCookie({ name: 'rcc_session', domain: 'evil.example', path: '/' }, 'https://app.im.codes'),
    ).toBe(false);
    // Path restriction mismatch
    expect(
      sameOriginCookie({ name: 'rcc_session', domain: 'app.im.codes', path: '/admin' }, 'https://app.im.codes'),
    ).toBe(false);
    // Secure cookie must not match plain http loopback
    expect(
      sameOriginCookie({ name: 'rcc_session', domain: 'localhost', path: '/', secure: true }, 'http://localhost:3000'),
    ).toBe(false);
  });

  it('auto-binds unbound machine via cookies.on("changed") without prompting, uses authoritative cookie, emits notification, and updates menu', async () => {
    const cookies = createFakeCookies({
      'https://app.im.codes': [{ name: COOKIE_SESSION, value: 'authoritative-jwt-1' }],
    });
    const notifications: Array<{ title: string; body: string }> = [];
    const messageBoxes: BindMessageBoxOptions[] = [];
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const cliCalls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    let latestMenu: MenuItemOptionsLike[] = [];

    const shell = createPcAppShell({
      platform: 'darwin',
      appName: 'IM.codes',
      userDataDir,
      createMainWindow: (opts) => createFakeShellWindow({ webPreferences: opts.webPreferences, cookies }),
      createPromptWindow: () => {
        throw new Error('unused');
      },
      setApplicationMenu: (t) => {
        latestMenu = t;
      },
      openExternal: () => {},
      showSaveDialogSync: () => undefined,
      showMessageBox: async (_win, opts) => {
        messageBoxes.push(opts);
        return { response: 0 };
      },
      showNotification: (n) => notifications.push(n),
      bindDeps: {
        imcodesHome,
        resourcesPath,
        plistPath,
        hostname: () => 'studio-mac',
        env: { PATH: '/usr/bin:/bin' },
        probeSystemTmux: () => true,
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
          fetchCalls.push({ url: String(url), init });
          return new Response(JSON.stringify({ id: 'key_123', apiKey: 'deck_secret_abc' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }) as typeof globalThis.fetch,
        runCli: async (cmd, args, opts): Promise<CliRunResult> => {
          cliCalls.push({ cmd, args, env: opts.env });
          writeFileSync(
            path.join(imcodesHome, 'server.json'),
            JSON.stringify({
              serverId: 'srv_1',
              token: 'tok_1',
              workerUrl: 'https://app.im.codes',
              serverName: 'studio-mac',
              boundAt: Date.now(),
            }),
          );
          return { status: 0, signal: null, timedOut: false, stdout: 'Bound', stderr: '' };
        },
      },
    });

    await shell.addAndSelectServer('https://app.im.codes', 'Prod');
    expect(findMenuItem(latestMenu, 'server:bind-fallback')?.label).toBe('Bind This Machine…');

    // Cookie event has stale value in payload; main must re-read authoritative cookie instead.
    cookies.emitChanged(
      { name: COOKIE_SESSION, value: 'untrusted-event-payload', domain: 'app.im.codes', path: '/' },
      false,
    );

    await vi.waitFor(() => {
      expect(notifications).toHaveLength(1);
    });

    expect(messageBoxes).toHaveLength(0);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe('https://app.im.codes/api/auth/user/me/keys');
    expect((fetchCalls[0]?.init?.headers as Record<string, string>).cookie).toBe(
      'rcc_session=authoritative-jwt-1',
    );
    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({ label: 'PC App · studio-mac' });
    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0]?.args).toEqual([
      'bind',
      'https://app.im.codes/bind/deck_secret_abc',
      'studio-mac',
    ]);
    expect(notifications[0]?.body).toContain('studio-mac');
    expect(notifications[0]?.body.toLowerCase()).toContain('auto-start on login');
    expect(findMenuItem(latestMenu, 'server:bind-fallback')?.label).toBe(
      'Rebind Machine (studio-mac · https://app.im.codes)…',
    );
  });

  it('ignores untrusted/mismatched origin cookie events completely', async () => {
    const cookies = createFakeCookies({
      'https://app.im.codes': [{ name: COOKIE_SESSION, value: 'jwt' }],
    });
    const fetchSpy = vi.fn();
    let fakeWin!: ReturnType<typeof createFakeShellWindow>;

    const shell = createPcAppShell({
      platform: 'darwin',
      appName: 'IM.codes',
      userDataDir,
      createMainWindow: (opts) => {
        fakeWin = createFakeShellWindow({ webPreferences: opts.webPreferences, cookies });
        return fakeWin;
      },
      createPromptWindow: () => {
        throw new Error('unused');
      },
      setApplicationMenu: () => {},
      openExternal: () => {},
      showSaveDialogSync: () => undefined,
      showMessageBox: async () => ({ response: 0 }),
      bindDeps: {
        imcodesHome,
        resourcesPath,
        plistPath,
        fetch: fetchSpy as unknown as typeof globalThis.fetch,
      },
    });

    await shell.ensureWindow();
    // 1. activeOrigin is null (welcome page)
    cookies.emitChanged({ name: COOKIE_SESSION, domain: 'app.im.codes', path: '/' }, false);
    // 2. activeOrigin selected, but window URL spoofed to another origin
    await shell.addAndSelectServer('https://app.im.codes');
    fakeWin.setUrlForTest('https://attacker.example');
    cookies.emitChanged({ name: COOKIE_SESSION, domain: 'attacker.example', path: '/' }, false);
    // 3. trusted origin active, but cookie belongs to another host
    fakeWin.setUrlForTest('https://app.im.codes');
    cookies.emitChanged({ name: COOKIE_SESSION, domain: 'other.im.codes', path: '/' }, false);

    await new Promise((r) => setTimeout(r, 20));
    expect(cookies.getCalls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('acquires single-flight lock synchronously before await cookies.get across concurrent cookie + did-navigate races', async () => {
    let resolveCookiesGet!: (cookies: CookieLike[]) => void;
    const delayedCookies: CookiesChangeEventLike = {
      on: () => {},
      get: vi.fn(
        () =>
          new Promise<CookieLike[]>((resolve) => {
            resolveCookiesGet = resolve;
          }),
      ),
    };
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'key_single', apiKey: 'deck_single_1' }), { status: 201 }),
    );
    const cliSpy = vi.fn(async (): Promise<CliRunResult> => ({
      status: 0,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
    }));

    let navListener: ((origin: string) => void) | null = null;
    const coord = new BindCoordinator({
      platform: 'darwin',
      imcodesHome,
      resourcesPath,
      plistPath,
      hostname: () => 'mac-race',
      getCurrentTrustedOrigin: () => 'https://race.im.codes',
      onDidNavigateTrustedOrigin: (listener) => {
        navListener = listener;
        return () => {};
      },
      showMessageBox: async () => ({ response: 0 }),
      showNotification: () => {},
      probeSystemTmux: () => true,
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
      runCli: cliSpy,
    });
    coord.attachCookies(delayedCookies);

    // Fire 3 triggers synchronously before cookies.get resolves!
    const p1 = coord.maybeBind('https://race.im.codes');
    const p2 = coord.maybeBind('https://race.im.codes');
    navListener!('https://race.im.codes');

    expect(coord.isInFlight('https://race.im.codes')).toBe(true);
    // Only ONE cookies.get call must have been dispatched because inFlight was locked synchronously!
    expect(delayedCookies.get).toHaveBeenCalledTimes(1);

    resolveCookiesGet([{ name: COOKIE_SESSION, value: 'jwt-race' }]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe('bound');
    expect(r2.status).toBe('in_flight');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(cliSpy).toHaveBeenCalledTimes(1);
    expect(coord.isInFlight('https://race.im.codes')).toBe(false);
  });

  it('triggers persistent-cookie bind check on did-navigate after startup', async () => {
    const cookies = createFakeCookies({
      'https://app.im.codes': [{ name: COOKIE_SESSION, value: 'persistent-jwt' }],
    });
    const notifications: Array<{ title: string; body: string }> = [];
    const cliSpy = vi.fn(async (): Promise<CliRunResult> => ({
      status: 0,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
    }));
    let fakeWin!: ReturnType<typeof createFakeShellWindow>;

    const shell = createPcAppShell({
      platform: 'darwin',
      appName: 'IM.codes',
      userDataDir,
      createMainWindow: (opts) => {
        fakeWin = createFakeShellWindow({ webPreferences: opts.webPreferences, cookies });
        return fakeWin;
      },
      createPromptWindow: () => {
        throw new Error('unused');
      },
      setApplicationMenu: () => {},
      openExternal: () => {},
      showSaveDialogSync: () => undefined,
      showMessageBox: async () => ({ response: 0 }),
      showNotification: (n) => notifications.push(n),
      bindDeps: {
        imcodesHome,
        resourcesPath,
        plistPath,
        hostname: () => 'mac-nav',
        probeSystemTmux: () => true,
        fetch: (async () =>
          new Response(JSON.stringify({ id: 'k_nav', apiKey: 'deck_nav' }), {
            status: 201,
          })) as typeof globalThis.fetch,
        runCli: cliSpy,
      },
    });

    await shell.addAndSelectServer('https://app.im.codes');
    fakeWin.webContentsEmitter.emit('did-navigate');

    await vi.waitFor(() => {
      expect(cliSpy).toHaveBeenCalledTimes(1);
    });
    expect(notifications).toHaveLength(1);
  });

  it('prompts once per login when bound, keeps existing binding untouched unless Replace chosen, resets asked state on removed cookie, and allows explicit menu rebind', async () => {
    const serverJsonPath = path.join(imcodesHome, 'server.json');
    writeFileSync(
      serverJsonPath,
      JSON.stringify({
        serverId: 'srv_old',
        token: 'tok_old',
        workerUrl: 'https://old.im.codes',
        serverName: 'OldBox',
        boundAt: 1000,
      }),
    );

    const cookies = createFakeCookies({
      'https://new.im.codes': [{ name: COOKIE_SESSION, value: 'jwt-new' }],
    });
    const prompts: BindMessageBoxOptions[] = [];
    let nextResponse = 0; // Keep Existing
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'k_rep', apiKey: 'deck_rep' }), { status: 201 }),
    );
    const cliSpy = vi.fn(async (): Promise<CliRunResult> => ({
      status: 0,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
    }));

    const shell = createPcAppShell({
      platform: 'darwin',
      appName: 'IM.codes',
      userDataDir,
      createMainWindow: (opts) => createFakeShellWindow({ webPreferences: opts.webPreferences, cookies }),
      createPromptWindow: () => {
        throw new Error('unused');
      },
      setApplicationMenu: () => {},
      openExternal: () => {},
      showSaveDialogSync: () => undefined,
      showMessageBox: async (_win, opts) => {
        prompts.push(opts);
        return { response: nextResponse };
      },
      bindDeps: {
        imcodesHome,
        resourcesPath,
        plistPath,
        hostname: () => 'NewBox',
        env: { PATH: '/usr/bin:/bin' },
        probeSystemTmux: () => false, // Also verify bundled tmux runs on Replace path!
        fetch: fetchSpy as unknown as typeof globalThis.fetch,
        runCli: cliSpy,
      },
    });

    // Install bundled tmux + terminfo to verify Replace also passes through ensureBundledTmuxEnv
    mkdirSync(path.join(resourcesPath, 'bin'), { recursive: true });
    mkdirSync(path.join(resourcesPath, 'terminfo'), { recursive: true });
    writeFileSync(path.join(resourcesPath, 'bin', 'tmux'), '#!/bin/sh\n');

    await shell.addAndSelectServer('https://new.im.codes');

    // First auto cookie trigger -> prompts once showing BOTH existing & target servers, Keep Existing does nothing.
    cookies.emitChanged({ name: COOKIE_SESSION, domain: 'new.im.codes', path: '/' }, false);
    await vi.waitFor(() => {
      expect(prompts).toHaveLength(1);
    });
    expect(prompts[0]?.detail).toContain('OldBox · https://old.im.codes');
    expect(prompts[0]?.detail).toContain('https://new.im.codes');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cliSpy).not.toHaveBeenCalled();

    // Second cookie change during same login -> does NOT re-prompt ("askedThisLogin")
    const secondOutcome = await shell.bind.maybeBind('https://new.im.codes');
    expect(secondOutcome.status).toBe('already_asked');
    expect(prompts).toHaveLength(1);

    // Cookie removed -> clears askedThisLogin -> fresh login prompts again
    cookies.emitChanged({ name: COOKIE_SESSION, domain: 'new.im.codes', path: '/' }, true);
    expect(shell.bind.hasAskedThisLogin('https://new.im.codes')).toBe(false);

    // Next cookie event prompts again; still Keep Existing
    const thirdOutcome = await shell.bind.maybeBind('https://new.im.codes');
    expect(thirdOutcome.status).toBe('kept_existing');
    expect(prompts).toHaveLength(2);

    // Explicit menu fallback ALWAYS prompts even though askedThisLogin is true, and choosing Replace runs unified performBind()
    nextResponse = 1; // Replace
    const manualOutcome = await shell.bind.triggerManualBind();
    expect(manualOutcome.status).toBe('bound');
    expect(prompts).toHaveLength(3);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(cliSpy).toHaveBeenCalledTimes(1);
    const cliEnv = cliSpy.mock.calls[0]?.[2]?.env;
    expect(cliEnv?.PATH?.startsWith(`${path.join(resourcesPath, 'bin')}:`)).toBe(true);
    expect(cliEnv?.TERMINFO_DIRS).toBe(`${path.join(resourcesPath, 'terminfo')}:/usr/share/terminfo`);
  });

  it('strictly separates deterministic key revoke from uncertain post-mint states without retrying', async () => {
    const cookies = createFakeCookies({
      'https://err.im.codes': [{ name: COOKIE_SESSION, value: 'jwt-err' }],
    });

    const createCoord = (opts: {
      fetchImpl: typeof globalThis.fetch;
      runCli?: BindCoordinator['performBind'] extends never ? never : (cmd: string, args: string[], o: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<CliRunResult>;
      shownBoxes: BindMessageBoxOptions[];
    }) =>
      new BindCoordinator({
        platform: 'darwin',
        imcodesHome,
        resourcesPath,
        plistPath,
        hostname: () => 'host-err',
        getCurrentTrustedOrigin: () => 'https://err.im.codes',
        onDidNavigateTrustedOrigin: () => () => {},
        showMessageBox: async (box) => {
          opts.shownBoxes.push(box);
          return { response: 0 };
        },
        showNotification: () => {},
        probeSystemTmux: () => true,
        fetch: opts.fetchImpl,
        runCli: opts.runCli,
      });

    // Case 1: Deterministic revoke (valid id + deck_ key, normal non-0 exit, server.json absent)
    {
      const shownBoxes: BindMessageBoxOptions[] = [];
      const calls: Array<{ method: string; url: string }> = [];
      const coord = createCoord({
        shownBoxes,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          const method = init?.method ?? 'GET';
          calls.push({ method, url: String(url) });
          if (method === 'POST') {
            return new Response(JSON.stringify({ id: 'key_revoke_1', apiKey: 'deck_ok_1' }), { status: 201 });
          }
          return new Response(null, { status: 204 });
        }) as typeof globalThis.fetch,
        runCli: async () => ({
          status: 1,
          signal: null,
          timedOut: false,
          stdout: '',
          stderr: 'permission denied writing plist',
        }),
      });
      const out = await coord.maybeBind('https://err.im.codes', cookies);
      expect(out.status).toBe('failed');
      expect(out.error?.kind).toBe('cli_failed_revoked');
      expect(calls).toEqual([
        { method: 'POST', url: 'https://err.im.codes/api/auth/user/me/keys' },
        { method: 'DELETE', url: 'https://err.im.codes/api/auth/user/me/keys/key_revoke_1' },
      ]);
      expect(shownBoxes[0]?.detail).toContain('permission denied writing plist');
      expect(shownBoxes[0]?.detail).toContain('imcodes bind https://err.im.codes/bind/<api-key> host-err');
    }

    // Case 2: Uncertain (mint_key_unknown on thrown network error AND malformed 201) -> NO DELETE, NO retry
    for (const mode of ['throw', 'bad201'] as const) {
      const shownBoxes: BindMessageBoxOptions[] = [];
      const calls: Array<{ method: string; url: string }> = [];
      const coord = createCoord({
        shownBoxes,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          calls.push({ method: init?.method ?? 'GET', url: String(url) });
          if (mode === 'throw') throw new Error('socket hang up');
          return new Response(JSON.stringify({ id: '', apiKey: 'bad_prefix' }), { status: 201 });
        }) as typeof globalThis.fetch,
      });
      const out = await coord.maybeBind('https://err.im.codes', cookies);
      expect(out.status).toBe('failed');
      expect(out.error?.kind).toBe('mint_key_unknown');
      expect(calls).toHaveLength(1);
      expect(shownBoxes[0]?.title).toContain('Uncertain');
    }

    // Case 3: Definite rejection (non-201 HTTP 401) -> mint_key_rejected, NO DELETE
    {
      const shownBoxes: BindMessageBoxOptions[] = [];
      const calls: Array<{ method: string; url: string }> = [];
      const coord = createCoord({
        shownBoxes,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          calls.push({ method: init?.method ?? 'GET', url: String(url) });
          return new Response('unauthorized', { status: 401 });
        }) as typeof globalThis.fetch,
      });
      const out = await coord.maybeBind('https://err.im.codes', cookies);
      expect(out.status).toBe('failed');
      expect(out.error?.kind).toBe('mint_key_rejected');
      expect(calls).toHaveLength(1);
    }

    // Case 4: CLI timeout -> NO DELETE (retain key!)
    {
      const shownBoxes: BindMessageBoxOptions[] = [];
      const calls: Array<{ method: string; url: string }> = [];
      const coord = createCoord({
        shownBoxes,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          calls.push({ method: init?.method ?? 'GET', url: String(url) });
          return new Response(JSON.stringify({ id: 'key_timeout', apiKey: 'deck_t1' }), { status: 201 });
        }) as typeof globalThis.fetch,
        runCli: async () => ({
          status: null,
          signal: 'SIGTERM',
          timedOut: true,
          stdout: '',
          stderr: 'timed out',
        }),
      });
      const out = await coord.maybeBind('https://err.im.codes', cookies);
      expect(out.status).toBe('failed');
      expect(out.error?.kind).toBe('cli_failed_uncertain');
      expect(calls).toHaveLength(1); // No DELETE!
      expect(shownBoxes[0]?.title).toContain('Uncertain');
    }

    // Case 5: CLI non-0 exit AFTER server.json appeared -> NO DELETE (retain key!)
    {
      const shownBoxes: BindMessageBoxOptions[] = [];
      const calls: Array<{ method: string; url: string }> = [];
      const coord = createCoord({
        shownBoxes,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          calls.push({ method: init?.method ?? 'GET', url: String(url) });
          return new Response(JSON.stringify({ id: 'key_present', apiKey: 'deck_p1' }), { status: 201 });
        }) as typeof globalThis.fetch,
        runCli: async () => {
          writeFileSync(
            path.join(imcodesHome, 'server.json'),
            JSON.stringify({
              serverId: 'srv_partial',
              token: 'tok_partial',
              workerUrl: 'https://err.im.codes',
              serverName: 'host-err',
              boundAt: Date.now(),
            }),
          );
          return { status: 1, signal: null, timedOut: false, stdout: '', stderr: 'launchctl load failed' };
        },
      });
      const out = await coord.maybeBind('https://err.im.codes', cookies);
      expect(out.status).toBe('failed');
      expect(out.error?.kind).toBe('cli_failed_uncertain');
      expect(calls).toHaveLength(1); // No DELETE!
      expect(shownBoxes[0]?.detail).toContain('launchctl load failed');
    }

    // Case 6: CLI spawn error (e.g. ENOENT, status null, error set) -> NO DELETE (retain key as uncertain!)
    rmSync(path.join(imcodesHome, 'server.json'), { force: true });
    {
      const shownBoxes: BindMessageBoxOptions[] = [];
      const calls: Array<{ method: string; url: string }> = [];
      const coord = createCoord({
        shownBoxes,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          calls.push({ method: init?.method ?? 'GET', url: String(url) });
          return new Response(JSON.stringify({ id: 'key_enoent', apiKey: 'deck_enoent_1' }), { status: 201 });
        }) as typeof globalThis.fetch,
        runCli: async () => ({
          status: null,
          signal: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          error: new Error('spawn ENOENT'),
        }),
      });
      const out = await coord.maybeBind('https://err.im.codes', cookies);
      expect(out.status).toBe('failed');
      expect(out.error?.kind).toBe('cli_failed_uncertain');
      expect(calls).toHaveLength(1); // POST only — DELETE must NOT be called!
      expect(shownBoxes[0]?.title).toContain('Uncertain');
      expect(shownBoxes[0]?.detail).toContain('spawn ENOENT');
      expect(shownBoxes[0]?.detail).toContain('imcodes bind https://err.im.codes/bind/<api-key> host-err');
    }

    // Case 7: CLI returns status null without error -> NO DELETE (retain key as uncertain!)
    {
      const shownBoxes: BindMessageBoxOptions[] = [];
      const calls: Array<{ method: string; url: string }> = [];
      const coord = createCoord({
        shownBoxes,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          calls.push({ method: init?.method ?? 'GET', url: String(url) });
          return new Response(JSON.stringify({ id: 'key_null_status', apiKey: 'deck_null_1' }), { status: 201 });
        }) as typeof globalThis.fetch,
        runCli: async () => ({
          status: null,
          signal: null,
          timedOut: false,
          stdout: '',
          stderr: '',
        }),
      });
      const out = await coord.maybeBind('https://err.im.codes', cookies);
      expect(out.status).toBe('failed');
      expect(out.error?.kind).toBe('cli_failed_uncertain');
      expect(calls).toHaveLength(1);
    }
  });

  it('ensureBundledTmuxEnv leaves PATH untouched when system tmux -V passes and injects bin + TERMINFO_DIRS when missing', async () => {
    const untouched = await ensureBundledTmuxEnv({
      platform: 'darwin',
      env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', FOO: '1' },
      resourcesPath,
      probeSystemTmux: () => true,
    });
    expect(untouched.usedBundledTmux).toBe(false);
    expect(untouched.env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin');
    expect(untouched.env.TERMINFO_DIRS).toBeUndefined();

    mkdirSync(path.join(resourcesPath, 'bin'), { recursive: true });
    mkdirSync(path.join(resourcesPath, 'terminfo'), { recursive: true });
    writeFileSync(path.join(resourcesPath, 'bin', 'tmux'), '');

    const bundled = await ensureBundledTmuxEnv({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin' },
      resourcesPath,
      probeSystemTmux: () => false,
    });
    expect(bundled.usedBundledTmux).toBe(true);
    expect(bundled.env.PATH).toBe(`${path.join(resourcesPath, 'bin')}:/usr/bin:/bin`);
    expect(bundled.env.TERMINFO_DIRS).toBe(`${path.join(resourcesPath, 'terminfo')}:/usr/share/terminfo`);

    // Resolve imcodes binary across IMCODES_BIN_PATH and packaged resource paths
    expect(
      resolveImcodesBinPath({
        platform: 'darwin',
        env: { IMCODES_BIN_PATH: '/custom/imcodes' },
        resourcesPath,
      }),
    ).toBe('/custom/imcodes');

    writeFileSync(path.join(resourcesPath, 'imcodes'), '');
    expect(
      resolveImcodesBinPath({
        platform: 'darwin',
        env: {},
        resourcesPath,
      }),
    ).toBe(path.join(resourcesPath, 'imcodes'));

    expect(
      resolveImcodesBinPath({
        platform: 'win32',
        env: {},
        resourcesPath,
        existsSync: (p) => p === path.join(resourcesPath, 'imcodes.exe'),
      }),
    ).toBe(path.join(resourcesPath, 'imcodes.exe'));
  });

  it('inspects macOS LaunchAgent ProgramArguments and EnvironmentVariables.PATH with distinct warnings and triggers Rebind Now without editing plist', async () => {
    const validNode = path.join(tempRoot, 'node');
    const validScript = path.join(tempRoot, 'imcodes-launch.mjs');
    const validBundledBin = path.join(tempRoot, 'IM.codes.app', 'Contents', 'Resources', 'bin');
    writeFileSync(validNode, '');
    writeFileSync(validScript, '');
    mkdirSync(validBundledBin, { recursive: true });

    const renderPlist = (nodePath: string, scriptPath: string, pathEnv: string) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>imcodes.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEnv}</string>
  </dict>
</dict>
</plist>`;

    // 1. Valid plist -> ok
    const okXml = renderPlist(validNode, validScript, `${validBundledBin}:/usr/bin:/bin`);
    writeFileSync(plistPath, okXml);
    expect(parseLaunchAgentPlistPaths(okXml)).toEqual({
      programArguments: [validNode, validScript, 'start', '--foreground'],
      pathEnv: `${validBundledBin}:/usr/bin:/bin`,
    });
    expect(inspectMacosLaunchAgentPlist({ platform: 'darwin', plistPath }).status).toBe('ok');

    // 2. ProgramArguments missing -> warns daemon cannot start
    const missingProg = path.join(tempRoot, 'gone-node');
    const badProgXml = renderPlist(missingProg, validScript, `${validBundledBin}:/usr/bin:/bin`);
    writeFileSync(plistPath, badProgXml);
    const progIssue = inspectMacosLaunchAgentPlist({ platform: 'darwin', plistPath });
    expect(progIssue.status).toBe('missing_paths');
    expect(progIssue.missingPrograms).toEqual([missingProg]);
    expect(progIssue.missingBundledPaths).toEqual([]);
    expect(progIssue.warningMessage).toContain('cannot start');

    // 3. Only bundled Contents/Resources/bin missing in PATH -> distinct bundled tmux warning
    const missingBundledBin = path.join(tempRoot, 'Moved.app', 'Contents', 'Resources', 'bin');
    const badPathXml = renderPlist(validNode, validScript, `${missingBundledBin}:/usr/bin:/bin`);
    writeFileSync(plistPath, badPathXml);
    const pathIssue = inspectMacosLaunchAgentPlist({ platform: 'darwin', plistPath });
    expect(pathIssue.status).toBe('missing_paths');
    expect(pathIssue.missingPrograms).toEqual([]);
    expect(pathIssue.missingBundledPaths).toEqual([missingBundledBin]);
    expect(pathIssue.warningMessage).toContain('cannot find bundled tmux');

    // 4. Clicking "Rebind Now" never edits plist directly and routes into performBind()
    const cookies = createFakeCookies({
      'https://rebind.im.codes': [{ name: COOKIE_SESSION, value: 'jwt-rebind' }],
    });
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'k_rebind', apiKey: 'deck_rebind_1' }), { status: 201 }),
    );
    const cliSpy = vi.fn(async (): Promise<CliRunResult> => ({
      status: 0,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
    }));
    const shownBoxes: BindMessageBoxOptions[] = [];

    const coord = new BindCoordinator({
      platform: 'darwin',
      imcodesHome,
      resourcesPath,
      plistPath,
      hostname: () => 'rebind-mac',
      getCurrentTrustedOrigin: () => 'https://rebind.im.codes',
      onDidNavigateTrustedOrigin: () => () => {},
      showMessageBox: async (box) => {
        shownBoxes.push(box);
        return { response: 1 }; // Click Rebind Now
      },
      showNotification: () => {},
      probeSystemTmux: () => true,
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
      runCli: cliSpy,
    });
    coord.attachCookies(cookies);

    const checkResult = await coord.checkLaunchAgentOnStartup();
    expect(checkResult.rebindRequested).toBe(true);
    expect(readFileSync(plistPath, 'utf8')).toBe(badPathXml); // Plist never directly modified by shell!
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(cliSpy).toHaveBeenCalledTimes(1);
    expect(shownBoxes[0]?.buttons).toEqual(['Later', 'Rebind Now']);

    // Read server.json helper returns null cleanly when missing or malformed
    expect(readServerJsonOrNull(imcodesHome)).toBeNull();
    writeFileSync(path.join(imcodesHome, 'server.json'), '{bad json');
    expect(readServerJsonOrNull(imcodesHome)).toBeNull();
    expect(existsSync(plistPath)).toBe(true);
  });

  it('exercises real defaultRunCli child spawn (stderr + non-0 revoke and 0 exit) and handles logout while prompt is open', async () => {
    const scriptBin = path.join(tempRoot, 'fake-imcodes-cli.mjs');
    writeFileSync(
      scriptBin,
      [
        '#!/usr/bin/env node',
        'if (process.env.FAKE_CLI_FAIL === "1") {',
        '  process.stderr.write("real spawn failure\\n");',
        '  process.exit(2);',
        '}',
        'process.stdout.write("bound ok\\n");',
        'process.exit(0);',
      ].join('\n'),
      { mode: 0o755 },
    );

    const cookies = createFakeCookies({
      'https://spawn.im.codes': [{ name: COOKIE_SESSION, value: 'jwt-spawn' }],
    });
    const fetchCalls: Array<{ method: string; url: string }> = [];
    const notifications: Array<{ title: string; body: string }> = [];
    const shownBoxes: BindMessageBoxOptions[] = [];

    // 1. Real spawn non-0 exit -> deterministic DELETE
    const coordFail = new BindCoordinator({
      platform: 'darwin',
      imcodesHome,
      resourcesPath,
      plistPath,
      imcodesBinPath: scriptBin,
      env: { ...process.env, FAKE_CLI_FAIL: '1' },
      hostname: () => 'spawn-mac',
      getCurrentTrustedOrigin: () => 'https://spawn.im.codes',
      onDidNavigateTrustedOrigin: () => () => {},
      showMessageBox: async (b) => {
        shownBoxes.push(b);
        return { response: 0 };
      },
      showNotification: (n) => notifications.push(n),
      probeSystemTmux: () => true,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        fetchCalls.push({ method, url: String(url) });
        if (method === 'POST') {
          return new Response(JSON.stringify({ id: 'k_spawn', apiKey: 'deck_spawn_1' }), { status: 201 });
        }
        return new Response(null, { status: 204 });
      }) as typeof globalThis.fetch,
    });
    const failOutcome = await coordFail.maybeBind('https://spawn.im.codes', cookies);
    expect(failOutcome.status).toBe('failed');
    expect(failOutcome.error?.kind).toBe('cli_failed_revoked');
    expect(shownBoxes[0]?.detail).toContain('real spawn failure');
    expect(fetchCalls).toEqual([
      { method: 'POST', url: 'https://spawn.im.codes/api/auth/user/me/keys' },
      { method: 'DELETE', url: 'https://spawn.im.codes/api/auth/user/me/keys/k_spawn' },
    ]);

    // 2. Real spawn exit 0 -> bound notification
    const coordOk = new BindCoordinator({
      platform: 'darwin',
      imcodesHome,
      resourcesPath,
      plistPath,
      imcodesBinPath: scriptBin,
      env: { ...process.env, FAKE_CLI_FAIL: '0' },
      hostname: () => 'spawn-mac',
      getCurrentTrustedOrigin: () => 'https://spawn.im.codes',
      onDidNavigateTrustedOrigin: () => () => {},
      showMessageBox: async () => ({ response: 0 }),
      showNotification: (n) => notifications.push(n),
      probeSystemTmux: () => true,
      fetch: (async () =>
        new Response(JSON.stringify({ id: 'k_spawn_ok', apiKey: 'deck_spawn_ok' }), { status: 201 })) as typeof globalThis.fetch,
    });
    const okOutcome = await coordOk.maybeBind('https://spawn.im.codes', cookies);
    expect(okOutcome.status).toBe('bound');
    expect(notifications).toHaveLength(1);

    // 3. Logout (removed: true) while replace dialog is open does not stick askedThisLogin
    writeFileSync(
      path.join(imcodesHome, 'server.json'),
      JSON.stringify({
        serverId: 'srv_cur',
        token: 'tok_cur',
        workerUrl: 'https://other.im.codes',
        serverName: 'Cur',
        boundAt: 1000,
      }),
    );
    let resolveDialog!: (res: { response: number }) => void;
    const coordLogoutRace = new BindCoordinator({
      platform: 'darwin',
      imcodesHome,
      resourcesPath,
      plistPath,
      hostname: () => 'spawn-mac',
      getCurrentTrustedOrigin: () => 'https://spawn.im.codes',
      onDidNavigateTrustedOrigin: () => () => {},
      showMessageBox: () =>
        new Promise((resolve) => {
          resolveDialog = resolve;
        }),
      showNotification: () => {},
      probeSystemTmux: () => true,
    });
    coordLogoutRace.attachCookies(cookies);
    const pendingPrompt = coordLogoutRace.maybeBind('https://spawn.im.codes', cookies);
    await vi.waitFor(() => {
      expect(resolveDialog).toBeTypeOf('function');
    });
    cookies.emitChanged({ name: COOKIE_SESSION, domain: 'spawn.im.codes', path: '/' }, true);
    resolveDialog({ response: 0 });
    const raceOutcome = await pendingPrompt;
    expect(raceOutcome.status).toBe('kept_existing');
    expect(coordLogoutRace.hasAskedThisLogin('https://spawn.im.codes')).toBe(false);
  });
});
