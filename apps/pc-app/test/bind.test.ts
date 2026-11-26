import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfMiddleware } from '../../../server/src/security/csrf.js';
import type { Env } from '../../../server/src/env.js';
import {
  COOKIE_CSRF as SHARED_COOKIE_CSRF,
  COOKIE_SESSION as SHARED_COOKIE_SESSION,
  HEADER_CSRF as SHARED_HEADER_CSRF,
} from '../../../shared/cookie-names.js';
import {
  BindCoordinator,
  COOKIE_CSRF,
  COOKIE_SESSION,
  HEADER_CSRF,
  ensureBundledTmuxEnv,
  inspectMacosLaunchAgentPlist,
  parseLaunchAgentPlistPaths,
  readServerJsonOrNull,
  resolveImcodesBinPath,
  sameOriginCookie,
  sameOriginNamedCookie,
  type BindMessageBoxOptions,
  type CliRunResult,
  type CookieLike,
  type CookiesChangeEventLike,
} from '../src/bind.js';
import type { MenuItemOptionsLike } from '../src/menu.js';
import { MAIN_WINDOW_WEB_PREFERENCES } from '../src/security.js';
import { createPcAppShell, type ShellWindowLike } from '../src/shell.js';

function createFakeCookies(initial: Record<string, CookieLike[]> = {}): CookiesChangeEventLike & {
  emitChanged: (cookie: CookieLike, removed: boolean, cause?: unknown) => void;
  setCookie: (url: string, cookie: CookieLike | null) => void;
  setCookies: (url: string, cookies: CookieLike[]) => void;
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
    emitChanged: (cookie, removed, cause = 'explicit') => {
      emitter.emit('changed', {}, cookie, cause, removed);
    },
    setCookie: (url, cookie) => {
      if (cookie === null) {
        byUrl.delete(url);
      } else {
        byUrl.set(url, [cookie]);
      }
    },
    setCookies: (url, cookies) => {
      byUrl.set(url, cookies);
    },
  };
}

function createFakeShellWindow(opts: {
  webPreferences: typeof MAIN_WINDOW_WEB_PREFERENCES & { backgroundThrottling?: boolean };
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

  it('matches shared COOKIE_SESSION/COOKIE_CSRF/HEADER_CSRF constants and strictly checks cookie same-origin / domain / path / scheme', () => {
    expect(COOKIE_SESSION).toBe(SHARED_COOKIE_SESSION);
    expect(COOKIE_SESSION).toBe('rcc_session');
    expect(COOKIE_CSRF).toBe(SHARED_COOKIE_CSRF);
    expect(COOKIE_CSRF).toBe('rcc_csrf');
    expect(HEADER_CSRF).toBe(SHARED_HEADER_CSRF);
    expect(HEADER_CSRF).toBe('X-CSRF-Token');

    expect(
      sameOriginCookie({ name: 'rcc_session', domain: 'app.im.codes', path: '/', secure: true }, 'https://app.im.codes'),
    ).toBe(true);
    expect(
      sameOriginCookie({ name: 'rcc_session', domain: '.im.codes', path: '/' }, 'https://app.im.codes'),
    ).toBe(true);

    // sameOriginCookie stays scoped to COOKIE_SESSION; sameOriginNamedCookie checks COOKIE_CSRF
    expect(
      sameOriginCookie({ name: 'rcc_csrf', domain: 'app.im.codes', path: '/' }, 'https://app.im.codes'),
    ).toBe(false);
    expect(
      sameOriginNamedCookie({ name: 'rcc_csrf', domain: 'app.im.codes', path: '/' }, 'https://app.im.codes', COOKIE_CSRF),
    ).toBe(true);
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

  it('auto-binds unbound machine via cookies.on("changed") without prompting, uses authoritative cookies + CSRF headers, emits notification, and updates menu', async () => {
    const cookies = createFakeCookies({
      'https://app.im.codes': [
        { name: COOKIE_SESSION, value: 'authoritative-jwt-1' },
        { name: COOKIE_CSRF, value: 'authoritative-csrf-1' },
      ],
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
    const sentHeaders = fetchCalls[0]?.init?.headers as Record<string, string>;
    expect(sentHeaders.origin).toBe('https://app.im.codes');
    expect(sentHeaders.cookie).toBe('rcc_session=authoritative-jwt-1; rcc_csrf=authoritative-csrf-1');
    expect(sentHeaders[HEADER_CSRF]).toBe('authoritative-csrf-1');
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
      get: vi.fn((filter: { url: string; name: string }) => {
        if (filter.name === COOKIE_CSRF) {
          return Promise.resolve([{ name: COOKIE_CSRF, value: 'csrf-race' }]);
        }
        return new Promise<CookieLike[]>((resolve) => {
          resolveCookiesGet = resolve;
        });
      }),
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
      'https://app.im.codes': [
        { name: COOKIE_SESSION, value: 'persistent-jwt' },
        { name: COOKIE_CSRF, value: 'persistent-csrf' },
      ],
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
      'https://new.im.codes': [
        { name: COOKIE_SESSION, value: 'jwt-new' },
        { name: COOKIE_CSRF, value: 'csrf-new' },
      ],
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
      'https://err.im.codes': [
        { name: COOKIE_SESSION, value: 'jwt-err' },
        { name: COOKIE_CSRF, value: 'csrf-err' },
      ],
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
      'https://rebind.im.codes': [
        { name: COOKIE_SESSION, value: 'jwt-rebind' },
        { name: COOKIE_CSRF, value: 'csrf-rebind' },
      ],
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
      'https://spawn.im.codes': [
        { name: COOKIE_SESSION, value: 'jwt-spawn' },
        { name: COOKIE_CSRF, value: 'csrf-spawn' },
      ],
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

  it('never prompts automatically when already bound to the same normalized origin, while still allowing manual rebind', async () => {
    const serverJsonPath = path.join(imcodesHome, 'server.json');
    writeFileSync(
      serverJsonPath,
      JSON.stringify({
        serverId: 'srv_same',
        token: 'tok_same',
        workerUrl: 'https://im.zhinet.work/',
        serverName: 'M3',
        boundAt: 1000,
      }),
    );

    const cookies = createFakeCookies({
      'https://im.zhinet.work': [
        { name: COOKIE_SESSION, value: 'jwt-same' },
        { name: COOKIE_CSRF, value: 'csrf-same' },
      ],
    });
    const prompts: BindMessageBoxOptions[] = [];
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'k_same', apiKey: 'deck_same_1' }), { status: 201 }),
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
        return { response: 1 };
      },
      bindDeps: {
        imcodesHome,
        resourcesPath,
        plistPath,
        hostname: () => 'M3',
        probeSystemTmux: () => true,
        fetch: fetchSpy as unknown as typeof globalThis.fetch,
        runCli: cliSpy,
      },
    });

    await shell.addAndSelectServer('https://im.zhinet.work:443');

    // Auto cookie event & renewal + explicit maybeBind must emit 0 prompts and return kept_existing.
    cookies.emitChanged({ name: COOKIE_SESSION, domain: 'im.zhinet.work', path: '/' }, false);
    cookies.emitChanged({ name: COOKIE_SESSION, domain: 'im.zhinet.work', path: '/' }, true, 'overwrite');
    cookies.emitChanged({ name: COOKIE_SESSION, domain: 'im.zhinet.work', path: '/' }, false, 'explicit');
    await vi.waitFor(() => {
      expect(shell.bind.isInFlight('https://im.zhinet.work')).toBe(false);
    });
    const autoOutcome = await shell.bind.maybeBind('https://im.zhinet.work');
    expect(autoOutcome.status).toBe('kept_existing');
    expect(prompts).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Even if server.json has default :443 port and trailing slash variants, same-origin check stays silent.
    writeFileSync(
      serverJsonPath,
      JSON.stringify({
        serverId: 'srv_same',
        token: 'tok_same',
        workerUrl: 'https://im.zhinet.work:443',
        serverName: 'M3',
        boundAt: 1000,
      }),
    );
    expect((await shell.bind.maybeBind('https://im.zhinet.work')).status).toBe('kept_existing');
    expect(prompts).toHaveLength(0);

    // Malformed existing workerUrl falls back safely without throwing.
    writeFileSync(
      serverJsonPath,
      JSON.stringify({
        serverId: 'srv_bad',
        token: 'tok_bad',
        workerUrl: 'not-a-valid-url',
        serverName: 'Bad',
        boundAt: 1000,
      }),
    );
    await expect(shell.bind.maybeBind('https://im.zhinet.work')).resolves.toEqual({ status: 'bound' });
    expect(prompts).toHaveLength(1);

    // Restore valid same-origin server.json and verify explicit manual menu bind still prompts.
    writeFileSync(
      serverJsonPath,
      JSON.stringify({
        serverId: 'srv_same',
        token: 'tok_same',
        workerUrl: 'https://im.zhinet.work',
        serverName: 'M3',
        boundAt: 1000,
      }),
    );
    const manualOutcome = await shell.bind.triggerManualBind();
    expect(manualOutcome.status).toBe('bound');
    expect(prompts).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('preserves Keep Existing across Set-Cookie overwrite renewals and app restarts, and degrades gracefully on bad store', async () => {
    const serverJsonPath = path.join(imcodesHome, 'server.json');
    const initialServerJson = JSON.stringify({
      serverId: 'srv_a',
      token: 'tok_a',
      workerUrl: 'https://server-a.example',
      serverName: 'BoxA',
      boundAt: 1000,
    });
    writeFileSync(serverJsonPath, initialServerJson);

    const cookies = createFakeCookies({
      'https://server-b.example': [
        { name: COOKIE_SESSION, value: 'jwt-b' },
        { name: COOKIE_CSRF, value: 'csrf-b' },
      ],
    });
    const prompts1: BindMessageBoxOptions[] = [];
    const shell1 = createPcAppShell({
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
        prompts1.push(opts);
        return { response: 0 }; // Keep Existing
      },
      bindDeps: {
        imcodesHome,
        resourcesPath,
        plistPath,
      },
    });

    await shell1.addAndSelectServer('https://server-b.example');
    cookies.emitChanged({ name: COOKIE_SESSION, domain: 'server-b.example', path: '/' }, false, 'explicit');
    await vi.waitFor(() => {
      expect(prompts1).toHaveLength(1);
    });
    expect(shell1.bind.hasAskedThisLogin('https://server-b.example')).toBe(true);

    // Chromium sliding Set-Cookie renewal: (removed: true, cause: 'overwrite') then (removed: false, cause: 'explicit')
    cookies.emitChanged({ name: COOKIE_SESSION, domain: 'server-b.example', path: '/' }, true, 'overwrite');
    expect(shell1.bind.hasAskedThisLogin('https://server-b.example')).toBe(true);
    cookies.emitChanged({ name: COOKIE_SESSION, domain: 'server-b.example', path: '/' }, false, 'explicit');
    await new Promise((r) => setTimeout(r, 20));
    expect(prompts1).toHaveLength(1);
    expect((await shell1.bind.maybeBind('https://server-b.example')).status).toBe('already_asked');

    // Real logout (removed: true, cause: 'explicit') clears both in-memory and persisted Keep Existing state.
    cookies.emitChanged({ name: COOKIE_SESSION, domain: 'server-b.example', path: '/' }, true, 'explicit');
    expect(shell1.bind.hasAskedThisLogin('https://server-b.example')).toBe(false);

    // Re-prompt once on fresh login after real logout, then Keep Existing persists again for restart check.
    expect((await shell1.bind.maybeBind('https://server-b.example')).status).toBe('kept_existing');
    expect(prompts1).toHaveLength(2);

    // Simulated app restart (new BindCoordinator reading kept-bindings.json in userDataDir): still no prompt, server.json untouched.
    const prompts2: BindMessageBoxOptions[] = [];
    const shell2 = createPcAppShell({
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
        prompts2.push(opts);
        return { response: 0 };
      },
      bindDeps: {
        imcodesHome,
        resourcesPath,
        plistPath,
      },
    });
    await shell2.ensureWindow();
    expect((await shell2.bind.maybeBind('https://server-b.example')).status).toBe('already_asked');
    expect(prompts2).toHaveLength(0);
    expect(readFileSync(serverJsonPath, 'utf8')).toBe(initialServerJson);

    // If machine rebinds to server-c, persisted (server-a -> server-b) does not suppress prompting for (server-c -> server-b).
    writeFileSync(
      serverJsonPath,
      JSON.stringify({
        serverId: 'srv_c',
        token: 'tok_c',
        workerUrl: 'https://server-c.example',
        serverName: 'BoxC',
        boundAt: 2000,
      }),
    );
    expect((await shell2.bind.maybeBind('https://server-b.example')).status).toBe('kept_existing');
    expect(prompts2).toHaveLength(1);

    // Corrupt or unwritable kept-bindings.json path degrades silently to in-memory dedupe without throwing.
    const blockedDirAsFile = path.join(tempRoot, 'not-a-directory');
    writeFileSync(blockedDirAsFile, 'blocker');
    const corruptCoord = new BindCoordinator({
      platform: 'darwin',
      imcodesHome,
      resourcesPath,
      plistPath,
      keptBindingStorePath: path.join(blockedDirAsFile, 'kept-bindings.json'),
      getCurrentTrustedOrigin: () => 'https://server-b.example',
      onDidNavigateTrustedOrigin: () => () => {},
      showMessageBox: async () => ({ response: 0 }),
      showNotification: () => {},
    });
    expect((await corruptCoord.maybeBind('https://server-b.example', cookies)).status).toBe('kept_existing');
    expect((await corruptCoord.maybeBind('https://server-b.example', cookies)).status).toBe('already_asked');

    const corruptJsonPath = path.join(tempRoot, 'corrupt-kept.json');
    writeFileSync(corruptJsonPath, '{corrupt json');
    const corruptJsonCoord = new BindCoordinator({
      platform: 'darwin',
      imcodesHome,
      resourcesPath,
      plistPath,
      keptBindingStorePath: corruptJsonPath,
      getCurrentTrustedOrigin: () => 'https://server-b.example',
      onDidNavigateTrustedOrigin: () => () => {},
      showMessageBox: async () => ({ response: 0 }),
      showNotification: () => {},
    });
    expect((await corruptJsonCoord.maybeBind('https://server-b.example', cookies)).status).toBe('kept_existing');
  });

  it('passes real production csrfMiddleware for POST mint and DELETE revoke across custom domains and non-default ports', async () => {
    for (const rawOrigin of ['https://im.zhinet.work/', 'https://selfhost.example:8443/']) {
      const normalizedOrigin = rawOrigin.replace(/\/+$/, '');
      const app = new Hono<{ Bindings: Env }>();
      app.use('/api/*', async (c, next) => {
        c.env = {
          NODE_ENV: 'production',
          SERVER_URL: normalizedOrigin,
          ALLOWED_ORIGINS: normalizedOrigin,
        } as unknown as Env;
        await next();
      });
      app.use('/api/*', csrfMiddleware());

      const observedRequests: Array<{ method: string; path: string; origin: string | null; csrfHeader: string | null; cookie: string | null }> = [];
      app.post('/api/auth/user/me/keys', (c) => {
        observedRequests.push({
          method: 'POST',
          path: new URL(c.req.url).pathname,
          origin: c.req.header('Origin') ?? null,
          csrfHeader: c.req.header(HEADER_CSRF) ?? null,
          cookie: c.req.header('Cookie') ?? null,
        });
        return c.json({ id: 'key_prod_1', apiKey: 'deck_prod_123' }, 201);
      });
      app.delete('/api/auth/user/me/keys/:keyId', (c) => {
        observedRequests.push({
          method: 'DELETE',
          path: new URL(c.req.url).pathname,
          origin: c.req.header('Origin') ?? null,
          csrfHeader: c.req.header(HEADER_CSRF) ?? null,
          cookie: c.req.header('Cookie') ?? null,
        });
        return c.body(null, 204);
      });

      const realCsrfFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const res = await app.request(String(input), init);
        return res;
      }) as typeof globalThis.fetch;

      const cookies = createFakeCookies({
        [rawOrigin]: [
          { name: COOKIE_SESSION, value: 'prod-jwt-val' },
          { name: COOKIE_CSRF, value: 'prod-csrf-val' },
        ],
        [normalizedOrigin]: [
          { name: COOKIE_SESSION, value: 'prod-jwt-val' },
          { name: COOKIE_CSRF, value: 'prod-csrf-val' },
        ],
      });

      // 1. Happy path: POST /api/auth/user/me/keys passes production csrfMiddleware -> 201 + bound
      const notifications: Array<{ title: string; body: string }> = [];
      const shownBoxes: BindMessageBoxOptions[] = [];
      const coordOk = new BindCoordinator({
        platform: 'win32',
        imcodesHome,
        resourcesPath,
        plistPath,
        hostname: () => 'win-box',
        getCurrentTrustedOrigin: () => normalizedOrigin,
        onDidNavigateTrustedOrigin: () => () => {},
        showMessageBox: async (b) => {
          shownBoxes.push(b);
          return { response: 0 };
        },
        showNotification: (n) => notifications.push(n),
        probeSystemTmux: () => true,
        fetch: realCsrfFetch,
        runCli: async () => ({ status: 0, signal: null, timedOut: false, stdout: 'Bound', stderr: '' }),
      });

      const okOutcome = await coordOk.maybeBind(rawOrigin, cookies);
      expect(okOutcome.status).toBe('bound');
      expect(shownBoxes).toHaveLength(0);
      expect(notifications).toHaveLength(1);
      expect(observedRequests).toEqual([
        {
          method: 'POST',
          path: '/api/auth/user/me/keys',
          origin: normalizedOrigin,
          csrfHeader: 'prod-csrf-val',
          cookie: 'rcc_session=prod-jwt-val; rcc_csrf=prod-csrf-val',
        },
      ]);

      // 2. Deterministic CLI failure: DELETE rollback ALSO passes production csrfMiddleware -> 204 (not 403)
      observedRequests.length = 0;
      const failBoxes: BindMessageBoxOptions[] = [];
      const coordFail = new BindCoordinator({
        platform: 'win32',
        imcodesHome,
        resourcesPath,
        plistPath,
        hostname: () => 'win-box',
        getCurrentTrustedOrigin: () => normalizedOrigin,
        onDidNavigateTrustedOrigin: () => () => {},
        showMessageBox: async (b) => {
          failBoxes.push(b);
          return { response: 0 };
        },
        showNotification: () => {},
        probeSystemTmux: () => true,
        fetch: realCsrfFetch,
        runCli: async () => ({ status: 1, signal: null, timedOut: false, stdout: '', stderr: 'bind failed' }),
      });

      const failOutcome = await coordFail.maybeBind(rawOrigin, cookies);
      expect(failOutcome.status).toBe('failed');
      expect(failOutcome.error?.kind).toBe('cli_failed_revoked');
      expect(observedRequests).toHaveLength(2);
      expect(observedRequests[1]).toEqual({
        method: 'DELETE',
        path: '/api/auth/user/me/keys/key_prod_1',
        origin: normalizedOrigin,
        csrfHeader: 'prod-csrf-val',
        cookie: 'rcc_session=prod-jwt-val; rcc_csrf=prod-csrf-val',
      });
    }
  });

  it('defers bind cleanly when rcc_session arrives before rcc_csrf, binds once rcc_csrf lands, and ignores rcc_csrf removals on asked state', async () => {
    const origin = 'https://app.im.codes';
    const domain = 'app.im.codes';
    const cookies = createFakeCookies({
      [origin]: [{ name: COOKIE_SESSION, value: 'secret-jwt-value' }],
    });
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const shownBoxes: BindMessageBoxOptions[] = [];
    const notifications: Array<{ title: string; body: string }> = [];

    const coord = new BindCoordinator({
      platform: 'win32',
      imcodesHome,
      resourcesPath,
      plistPath,
      hostname: () => 'win-desktop',
      getCurrentTrustedOrigin: () => origin,
      onDidNavigateTrustedOrigin: () => () => {},
      showMessageBox: async (b) => {
        shownBoxes.push(b);
        return { response: 0 };
      },
      showNotification: (n) => notifications.push(n),
      probeSystemTmux: () => true,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({ url: String(url), init });
        return new Response(JSON.stringify({ id: 'k_order', apiKey: 'deck_order_1' }), { status: 201 });
      }) as typeof globalThis.fetch,
      runCli: async () => ({ status: 0, signal: null, timedOut: false, stdout: 'Bound', stderr: '' }),
    });
    coord.attachCookies(cookies);

    // 1. rcc_session arrives first without rcc_csrf -> no fetch, no error box, not marked asked
    cookies.emitChanged({ name: COOKIE_SESSION, domain, path: '/' }, false);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCalls).toHaveLength(0);
    expect(shownBoxes).toHaveLength(0);
    expect(coord.hasAskedThisLogin(origin)).toBe(false);

    // Explicit manual trigger without rcc_csrf shows sign-in guidance cleanly, never sends rcc_csrf=undefined or leaks jwt
    const manualMissing = await coord.triggerManualBind(cookies);
    expect(manualMissing.status).toBe('no_csrf_cookie');
    expect(fetchCalls).toHaveLength(0);
    expect(shownBoxes).toHaveLength(1);
    expect(JSON.stringify(shownBoxes[0])).not.toContain('secret-jwt-value');
    expect(JSON.stringify(shownBoxes[0])).not.toContain('undefined');

    // 2. rcc_csrf commits right after -> attachCookies triggers bind and succeeds
    cookies.setCookies(origin, [
      { name: COOKIE_SESSION, value: 'secret-jwt-value' },
      { name: COOKIE_CSRF, value: 'fresh-csrf-token' },
    ]);
    cookies.emitChanged({ name: COOKIE_CSRF, domain, path: '/' }, false, 'explicit');
    await vi.waitFor(() => {
      expect(notifications).toHaveLength(1);
    });
    expect(fetchCalls).toHaveLength(1);

    // 3. When bound to a different server, rcc_session before rcc_csrf must NOT prompt or set askedThisLogin,
    //    and rcc_csrf removal (both overwrite and explicit) must NOT clear askedThisLogin or loop.
    const otherOrigin = 'https://other.im.codes';
    writeFileSync(
      path.join(imcodesHome, 'server.json'),
      JSON.stringify({
        serverId: 'srv_cur',
        token: 'tok_cur',
        workerUrl: origin,
        serverName: 'win-desktop',
        boundAt: 1000,
      }),
    );
    const otherCookies = createFakeCookies({
      [otherOrigin]: [{ name: COOKIE_SESSION, value: 'other-jwt' }],
    });
    const otherPrompts: BindMessageBoxOptions[] = [];
    const coordOther = new BindCoordinator({
      platform: 'win32',
      imcodesHome,
      resourcesPath,
      plistPath,
      hostname: () => 'win-desktop',
      getCurrentTrustedOrigin: () => otherOrigin,
      onDidNavigateTrustedOrigin: () => () => {},
      showMessageBox: async (b) => {
        otherPrompts.push(b);
        return { response: 0 }; // Keep Existing
      },
      showNotification: () => {},
      probeSystemTmux: () => true,
    });
    coordOther.attachCookies(otherCookies);

    otherCookies.emitChanged({ name: COOKIE_SESSION, domain: 'other.im.codes', path: '/' }, false);
    await new Promise((r) => setTimeout(r, 20));
    expect(otherPrompts).toHaveLength(0);
    expect(coordOther.hasAskedThisLogin(otherOrigin)).toBe(false);

    otherCookies.setCookies(otherOrigin, [
      { name: COOKIE_SESSION, value: 'other-jwt' },
      { name: COOKIE_CSRF, value: 'other-csrf' },
    ]);
    otherCookies.emitChanged({ name: COOKIE_CSRF, domain: 'other.im.codes', path: '/' }, false);
    await vi.waitFor(() => {
      expect(otherPrompts).toHaveLength(1);
    });
    expect(coordOther.hasAskedThisLogin(otherOrigin)).toBe(true);

    // Sliding rcc_csrf overwrite or removal must not clear askedThisLogin or trigger re-prompt loop
    otherCookies.emitChanged({ name: COOKIE_CSRF, domain: 'other.im.codes', path: '/' }, true, 'overwrite');
    otherCookies.emitChanged({ name: COOKIE_CSRF, domain: 'other.im.codes', path: '/' }, true, 'explicit');
    expect(coordOther.hasAskedThisLogin(otherOrigin)).toBe(true);
    otherCookies.emitChanged({ name: COOKIE_CSRF, domain: 'other.im.codes', path: '/' }, false, 'explicit');
    await new Promise((r) => setTimeout(r, 20));
    expect(otherPrompts).toHaveLength(1);

    // Only non-overwrite rcc_session removal clears askedThisLogin
    otherCookies.emitChanged({ name: COOKIE_SESSION, domain: 'other.im.codes', path: '/' }, true, 'explicit');
    expect(coordOther.hasAskedThisLogin(otherOrigin)).toBe(false);
  });

  it('coalesces overlapping rcc_csrf events while in-flight auto-read or manual missing-cookie dialog is active, and drops pending recheck on logout or origin switch', async () => {
    const origin = 'https://overlap.im.codes';
    const domain = 'overlap.im.codes';

    const makeProdApp = () => {
      const app = new Hono<{ Bindings: Env }>();
      app.use('/api/*', async (c, next) => {
        c.env = {
          NODE_ENV: 'production',
          SERVER_URL: origin,
          ALLOWED_ORIGINS: origin,
        } as unknown as Env;
        await next();
      });
      app.use('/api/*', csrfMiddleware());
      let mintCount = 0;
      app.post('/api/auth/user/me/keys', () => {
        mintCount += 1;
        return Response.json({ id: `k_${mintCount}`, apiKey: `deck_overlap_${mintCount}` }, { status: 201 });
      });
      return {
        getMintCount: () => mintCount,
        fetch: ((input: string | URL | Request, init?: RequestInit) => app.request(String(input), init)) as typeof globalThis.fetch,
      };
    };

    // Case A: Auto flow has read/is waiting on empty rcc_csrf snapshot when rcc_csrf event fires concurrently.
    {
      const prod = makeProdApp();
      let resolveFirstCsrfGet!: (cookies: CookieLike[]) => void;
      let csrfReadCount = 0;
      let hasCsrfInJar = false;
      const emitter = new EventEmitter();
      const overlapCookies: CookiesChangeEventLike & {
        emitChanged: (c: CookieLike, removed: boolean, cause?: unknown) => void;
      } = {
        on: (ev, l) => emitter.on(ev, l),
        emitChanged: (c, removed, cause = 'explicit') => emitter.emit('changed', {}, c, cause, removed),
        get: async (filter) => {
          if (filter.name === COOKIE_SESSION) {
            return [{ name: COOKIE_SESSION, value: 'jwt-overlap-1' }];
          }
          csrfReadCount += 1;
          if (csrfReadCount === 1) {
            return new Promise<CookieLike[]>((resolve) => {
              resolveFirstCsrfGet = resolve;
            });
          }
          return hasCsrfInJar ? [{ name: COOKIE_CSRF, value: 'csrf-overlap-1' }] : [];
        },
      };
      const notifications: Array<{ title: string; body: string }> = [];
      const coord = new BindCoordinator({
        platform: 'win32',
        imcodesHome,
        resourcesPath,
        plistPath,
        hostname: () => 'win-overlap',
        getCurrentTrustedOrigin: () => origin,
        onDidNavigateTrustedOrigin: () => () => {},
        showMessageBox: async () => ({ response: 0 }),
        showNotification: (n) => notifications.push(n),
        probeSystemTmux: () => true,
        fetch: prod.fetch,
        runCli: async () => ({ status: 0, signal: null, timedOut: false, stdout: 'Bound', stderr: '' }),
      });
      coord.attachCookies(overlapCookies);

      const initialPromise = coord.maybeBind(origin, overlapCookies);
      await vi.waitFor(() => {
        expect(resolveFirstCsrfGet).toBeTypeOf('function');
      });

      // Concurrent rcc_csrf event lands BEFORE first maybeBind exits inFlight!
      hasCsrfInJar = true;
      overlapCookies.emitChanged({ name: COOKIE_CSRF, domain, path: '/' }, false);
      resolveFirstCsrfGet([]); // Initial read completes with empty snapshot -> exits no_csrf_cookie

      const initialOutcome = await initialPromise;
      expect(initialOutcome.status).toBe('no_csrf_cookie');

      // Without any third event or manual trigger, coalesced recheck runs once and binds cleanly.
      await vi.waitFor(() => {
        expect(notifications).toHaveLength(1);
      });
      expect(prod.getMintCount()).toBe(1);
    }

    // Case B: Manual trigger is awaiting missing-cookie dialog while rcc_csrf lands concurrently.
    {
      const prod = makeProdApp();
      let resolveDialog!: (res: { response: number }) => void;
      const emitter = new EventEmitter();
      let hasCsrf = false;
      const manualCookies: CookiesChangeEventLike & {
        emitChanged: (c: CookieLike, removed: boolean, cause?: unknown) => void;
      } = {
        on: (ev, l) => emitter.on(ev, l),
        emitChanged: (c, removed, cause = 'explicit') => emitter.emit('changed', {}, c, cause, removed),
        get: async (filter) => {
          if (filter.name === COOKIE_SESSION) return [{ name: COOKIE_SESSION, value: 'jwt-overlap-2' }];
          return hasCsrf ? [{ name: COOKIE_CSRF, value: 'csrf-overlap-2' }] : [];
        },
      };
      const notifications: Array<{ title: string; body: string }> = [];
      const coord = new BindCoordinator({
        platform: 'win32',
        imcodesHome,
        resourcesPath,
        plistPath,
        hostname: () => 'win-overlap',
        getCurrentTrustedOrigin: () => origin,
        onDidNavigateTrustedOrigin: () => () => {},
        showMessageBox: () =>
          new Promise((resolve) => {
            resolveDialog = resolve;
          }),
        showNotification: (n) => notifications.push(n),
        probeSystemTmux: () => true,
        fetch: prod.fetch,
        runCli: async () => ({ status: 0, signal: null, timedOut: false, stdout: 'Bound', stderr: '' }),
      });
      coord.attachCookies(manualCookies);

      const manualPromise = coord.triggerManualBind(manualCookies);
      await vi.waitFor(() => {
        expect(resolveDialog).toBeTypeOf('function');
      });

      // While user still hasn't dismissed missing-cookie dialog, rcc_csrf commits!
      hasCsrf = true;
      manualCookies.emitChanged({ name: COOKIE_CSRF, domain, path: '/' }, false);
      resolveDialog({ response: 0 });

      const manualOutcome = await manualPromise;
      expect(manualOutcome.status).toBe('no_csrf_cookie');

      // After dialog resolves & inFlight releases, coalesced recheck runs once and mints once.
      await vi.waitFor(() => {
        expect(notifications).toHaveLength(1);
      });
      expect(prod.getMintCount()).toBe(1);
    }

    // Case C: Pending recheck is discarded if user logs out or switches trusted origin mid-flight.
    for (const dropReason of ['logout', 'origin_switch'] as const) {
      const prod = makeProdApp();
      let currentOrigin: string | null = origin;
      let resolveDialog!: (res: { response: number }) => void;
      const emitter = new EventEmitter();
      let hasCsrf = false;
      const cookies: CookiesChangeEventLike & {
        emitChanged: (c: CookieLike, removed: boolean, cause?: unknown) => void;
      } = {
        on: (ev, l) => emitter.on(ev, l),
        emitChanged: (c, removed, cause = 'explicit') => emitter.emit('changed', {}, c, cause, removed),
        get: async (filter) => {
          if (filter.name === COOKIE_SESSION) return [{ name: COOKIE_SESSION, value: 'jwt-drop' }];
          return hasCsrf ? [{ name: COOKIE_CSRF, value: 'csrf-drop' }] : [];
        },
      };
      const coord = new BindCoordinator({
        platform: 'win32',
        imcodesHome,
        resourcesPath,
        plistPath,
        hostname: () => 'win-overlap',
        getCurrentTrustedOrigin: () => currentOrigin,
        onDidNavigateTrustedOrigin: () => () => {},
        showMessageBox: () =>
          new Promise((resolve) => {
            resolveDialog = resolve;
          }),
        showNotification: () => {},
        probeSystemTmux: () => true,
        fetch: prod.fetch,
      });
      coord.attachCookies(cookies);

      const p = coord.triggerManualBind(cookies);
      await vi.waitFor(() => {
        expect(resolveDialog).toBeTypeOf('function');
      });

      hasCsrf = true;
      cookies.emitChanged({ name: COOKIE_CSRF, domain, path: '/' }, false);
      if (dropReason === 'logout') {
        cookies.emitChanged({ name: COOKIE_SESSION, domain, path: '/' }, true, 'explicit');
      } else {
        currentOrigin = 'https://switched.im.codes';
      }
      resolveDialog({ response: 0 });
      await p;
      await new Promise((r) => setTimeout(r, 20));
      expect(prod.getMintCount()).toBe(0);
    }
  });
});
