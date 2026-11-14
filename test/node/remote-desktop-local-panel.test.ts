import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { REMOTE_DESKTOP_ACCESS_MODE } from '../../shared/remote-desktop.js';
import { AIDESK_PRODUCT_NAME } from '../../shared/aidesk-product.js';
import { LOCAL_PANEL_EXTERNAL_PATH, LOCAL_PANEL_WINDOW_TITLE } from '../../shared/local-panel-window.js';
import {
  REMOTE_DESKTOP_LOCAL_ACTION,
  REMOTE_DESKTOP_LOCAL_DAEMON_ACTION,
  REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART,
  REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE,
  REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE,
  REMOTE_DESKTOP_LOCAL_MANAGEMENT,
} from '../../shared/remote-desktop-local-management.js';
import {
  applyRemoteDesktopAccessPaused,
  loadRemoteDesktopAccessPaused,
  persistRemoteDesktopAccessPaused,
} from '../../src/node/remote-desktop-access-state.js';
import { renderLocalPanelPage } from '../../src/node/local-panel-page.js';
import { startRemoteDesktopLocalPanel, type RemoteDesktopLocalPanel } from '../../src/node/remote-desktop-local-panel.js';

const roots: string[] = [];
const panels: RemoteDesktopLocalPanel[] = [];

afterEach(async () => {
  await Promise.all(panels.splice(0).map((panel) => panel.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.useRealTimers();
});

describe('remote desktop local access state', () => {
  it('persists pause across restart and fails closed on a malformed protected file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-rd-access-'));
    roots.push(root);
    const path = join(root, 'state.json');
    expect(await loadRemoteDesktopAccessPaused(path)).toBe(false);
    await persistRemoteDesktopAccessPaused(true, path);
    expect(await loadRemoteDesktopAccessPaused(path)).toBe(true);
    await persistRemoteDesktopAccessPaused(false, path);
    expect(await loadRemoteDesktopAccessPaused(path)).toBe(false);
    await writeFile(path, '{bad', { mode: 0o600 });
    await chmod(path, 0o600);
    expect(await loadRemoteDesktopAccessPaused(path)).toBe(true);
  });

  it('closes the live gate before persisting pause and persists resume before reopening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-rd-access-order-'));
    roots.push(root);
    const path = join(root, 'state.json');
    const events: string[] = [];
    const enforce = vi.fn(async (paused: boolean) => {
      events.push(`gate:${paused}:${await loadRemoteDesktopAccessPaused(path)}`);
    });

    await applyRemoteDesktopAccessPaused(true, enforce, path);
    expect(events).toEqual(['gate:true:false']);
    expect(await loadRemoteDesktopAccessPaused(path)).toBe(true);

    events.length = 0;
    await applyRemoteDesktopAccessPaused(false, enforce, path);
    expect(events).toEqual(['gate:false:false']);
    expect(await loadRemoteDesktopAccessPaused(path)).toBe(false);
  });
});

describe('remote desktop local panel', () => {
  it('uses a loopback session + CSRF gate and controls real connection handles independently', async () => {
    let paused = false;
    const setPaused = vi.fn(async (next: boolean) => { paused = next; });
    const stopAll = vi.fn(async () => {});
    const disconnect = vi.fn(async (id: string) => id === 'opaque-one');
    const connections = [
      { id: 'opaque-one', label: '#1', connectedAt: 1_700_000_000_000, mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW },
      { id: 'opaque-two', label: '#2', connectedAt: 1_700_000_001_000, mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL },
    ];
    const panel = await startRemoteDesktopLocalPanel({
      publicNodeId: '1234567890',
      serverUrl: 'https://example.test/',
      status: () => ({ paused, connections }),
      setPaused,
      stopAll,
      disconnect,
      port: 0,
    });
    panels.push(panel);

    const page = await fetch(panel.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
    const html = await page.text();
    const csrf = /"csrf":"([^"]+)"/.exec(html)?.[1];
    expect(csrf).toBeTruthy();
    expect(html).toContain('aideskNode=1234567890');
    expect(html).toContain('aideskAction=share');

    // A second window must get independent authority without revoking the
    // first panel window, which may still be monitoring or confirming.
    const secondPage = await fetch(panel.url);
    expect(secondPage.status).toBe(200);
    // Seven explicit locale dictionaries are embedded in the one shared UI.
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko']) {
      expect(html).toMatch(new RegExp(`['"]?${locale}['"]?:`));
    }

    const state = await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH, panel.url), {
      headers: { cookie },
    });
    expect(await state.json()).toEqual({ publicNodeId: '1234567890', paused: false, connections });

    const actionUrl = new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.ACTION_PATH, panel.url);
    const forged = await fetch(actionUrl, {
      method: 'POST', headers: { cookie, origin: 'https://evil.test', 'content-type': 'application/json', [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: csrf! },
      body: JSON.stringify({ action: 'pause' }),
    });
    expect(forged.status).toBe(403);
    expect(setPaused).not.toHaveBeenCalled();

    const post = (body: unknown) => fetch(actionUrl, {
      method: 'POST', headers: { cookie, origin: new URL(panel.url).origin, 'content-type': 'application/json', [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: csrf! },
      body: JSON.stringify(body),
    });
    expect((await post({ action: 'disconnect', id: 'opaque-one' })).status).toBe(200);
    expect(disconnect).toHaveBeenCalledWith('opaque-one');
    expect((await post({ action: 'pause' })).status).toBe(200);
    expect(setPaused).toHaveBeenCalledWith(true);
    expect((await post({ action: 'stop_all' })).status).toBe(200);
    expect(stopAll).toHaveBeenCalledTimes(1);
    expect((await post({ action: 'resume' })).status).toBe(200);
    expect(setPaused).toHaveBeenCalledWith(false);
  });

  it('adds the host name and permission state to /api/state when the node supplies them, and only well formed ones', async () => {
    const extras = vi.fn(() => ({
      deviceName: 'work-mac.local',
      permissions: { screenRecording: 'granted', accessibility: 'bogus', fullDiskAccess: 'unknown' },
      secret: 'never forwarded',
    }));
    const panel = await startRemoteDesktopLocalPanel({
      publicNodeId: '1234567890', serverUrl: 'https://example.test/',
      status: () => ({ paused: false, connections: [] }),
      extras: extras as never,
      setPaused: async () => {}, stopAll: async () => {}, disconnect: async () => false,
      port: 0,
    });
    panels.push(panel);
    const page = await fetch(panel.url);
    const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0]!;
    const state = await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH, panel.url), { headers: { cookie } });
    expect(await state.json()).toEqual({
      publicNodeId: '1234567890', paused: false, connections: [],
      deviceName: 'work-mac.local',
      permissions: { screenRecording: 'granted', fullDiskAccess: 'unknown' },
    });
  });

  it('keeps /api/state exactly as before when the node supplies no extras, or its extras throw', async () => {
    for (const extras of [undefined, () => { throw new Error('boom'); }]) {
      const panel = await startRemoteDesktopLocalPanel({
        publicNodeId: '1234567890', serverUrl: 'https://example.test/',
        status: () => ({ paused: true, connections: [] }),
        ...(extras ? { extras } : {}),
        setPaused: async () => {}, stopAll: async () => {}, disconnect: async () => false,
        port: 0,
      });
      panels.push(panel);
      const page = await fetch(panel.url);
      const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0]!;
      const state = await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH, panel.url), { headers: { cookie } });
      expect(await state.json()).toEqual({ publicNodeId: '1234567890', paused: true, connections: [] });
    }
  });

  /** The real page, with its real script, in jsdom: `fetch` is the test's own node. */
  async function openPageInDom(options: {
    state?: () => Record<string, unknown>;
    languages?: string[];
    extraFetch?: (url: string, init?: RequestInit) => unknown;
    storage?: Record<string, string>;
    beforeParse?: (window: import('jsdom').DOMWindow) => void;
  } = {}) {
    const panel = await startRemoteDesktopLocalPanel({
      publicNodeId: '1234567890', serverUrl: 'https://example.test/',
      status: () => ({ paused: false, connections: [] }),
      setPaused: async () => {}, stopAll: async () => {}, disconnect: async () => false,
      port: 0,
    });
    panels.push(panel);
    const html = await (await fetch(panel.url)).text();
    const baseState = { publicNodeId: '1234567890', paused: false, connections: [] as unknown[] };
    const fetchClient = vi.fn(async (url: string, init?: RequestInit) => {
      const custom = options.extraFetch?.(url, init);
      if (custom) return custom as { ok: boolean; json: () => Promise<unknown> };
      if (url === REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH) return { ok: true, json: async () => ({ ...baseState, ...(options.state?.() ?? {}) }) };
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const storage = { ...(options.storage ?? {}) };
    const dom = new JSDOM(html, {
      url: panel.url,
      runScripts: 'dangerously',
      beforeParse(window) {
        Object.defineProperty(window, 'fetch', { configurable: true, value: fetchClient });
        Object.defineProperty(window.navigator, 'languages', { configurable: true, value: options.languages ?? ['en-US'] });
        Object.defineProperty(window.navigator, 'language', { configurable: true, value: (options.languages ?? ['en-US'])[0] });
        Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          value: {
            getItem: (key: string) => (key in storage ? storage[key]! : null),
            setItem: (key: string, value: string) => { storage[key] = value; },
            removeItem: (key: string) => { delete storage[key]; },
          },
        });
        options.beforeParse?.(window);
      },
    });
    return { dom, fetchClient, storage, panel, html };
  }
  const byId = (dom: JSDOM, id: string) => dom.window.document.getElementById(id) as HTMLElement;
  const posts = (fetchClient: ReturnType<typeof vi.fn>) => fetchClient.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, init]) => ({ url: url as string, body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown> }));

  it('asks twice before disconnecting one connection or everyone, shows live durations, and refreshes after each action', async () => {
    const connections = [{ id: 'opaque-one', label: '1', connectedAt: Date.now() - 2_000, mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW }];
    const { dom, fetchClient } = await openPageInDom({ state: () => ({ connections }) });
    try {
      await vi.waitFor(() => expect(byId(dom, 'statusText').textContent).toBe('In use'));
      expect(byId(dom, 'count').textContent).toBe('1');
      const duration = dom.window.document.querySelector('[data-since]') as HTMLElement;
      expect(duration.textContent).toBe('00:02');
      dom.window.Date.now = () => connections[0]!.connectedAt + 65_000;
      await vi.waitFor(() => expect(duration.textContent).toBe('01:05'), { timeout: 3_000 });

      const disconnect = dom.window.document.querySelector('.conn button') as HTMLButtonElement;
      disconnect.click();
      expect(byId(dom, 'modal').hidden).toBe(false);
      expect(posts(fetchClient)).toEqual([]);
      byId(dom, 'cancel').click();
      expect(byId(dom, 'modal').hidden).toBe(true);
      expect(posts(fetchClient)).toEqual([]);
      disconnect.click();
      byId(dom, 'confirmAction').click();
      await vi.waitFor(() => expect(posts(fetchClient)).toEqual([{ url: '/api/action', body: { action: REMOTE_DESKTOP_LOCAL_ACTION.DISCONNECT, id: 'opaque-one' } }]));
      const statePolls = () => fetchClient.mock.calls.filter(([url, init]) => url === REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH && (init as RequestInit).method === undefined).length;
      await vi.waitFor(() => expect(statePolls()).toBeGreaterThanOrEqual(2));

      byId(dom, 'stopAll').click();
      expect(byId(dom, 'modal').hidden).toBe(false);
      expect(posts(fetchClient)).toHaveLength(1);
      byId(dom, 'confirmAction').click();
      await vi.waitFor(() => expect(posts(fetchClient)).toHaveLength(2));
      expect(posts(fetchClient)[1]!.body.action).toBe(REMOTE_DESKTOP_LOCAL_ACTION.STOP_ALL);
      expect(fetchClient).toHaveBeenCalledWith('/api/state', { cache: 'no-store' });
    } finally { dom.window.close(); }
  });

  it('the dialog is modal: Escape closes it, Tab stays inside it and focus returns to the opener', async () => {
    const connections = [{ id: 'a', label: '1', connectedAt: Date.now() - 1_000, mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL }];
    const { dom, fetchClient } = await openPageInDom({ state: () => ({ connections }) });
    try {
      await vi.waitFor(() => expect(byId(dom, 'count').textContent).toBe('1'));
      const opener = byId(dom, 'stopAll');
      opener.focus();
      opener.click();
      expect(dom.window.document.activeElement).toBe(byId(dom, 'cancel'));
      const press = (init: KeyboardEventInit) => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
      byId(dom, 'confirmAction').focus();
      press({ key: 'Tab' });
      expect(dom.window.document.activeElement).toBe(byId(dom, 'cancel'));
      press({ key: 'Tab', shiftKey: true });
      expect(dom.window.document.activeElement).toBe(byId(dom, 'confirmAction'));
      press({ key: 'Escape' });
      expect(byId(dom, 'modal').hidden).toBe(true);
      expect(dom.window.document.activeElement).toBe(opener);
      expect(posts(fetchClient)).toEqual([]);
    } finally { dom.window.close(); }
  });

  it('the switch says On/Off in words, is allowed-vs-paused consistently with the banner and pill, and toggles the right action', async () => {
    let paused = false;
    const { dom, fetchClient } = await openPageInDom({ state: () => ({ paused }) });
    try {
      const sw = byId(dom, 'allowSwitch');
      await vi.waitFor(() => expect(byId(dom, 'statusPill').hidden).toBe(false));
      expect(byId(dom, 'statusText').textContent).toBe('Online');
      expect(sw.getAttribute('aria-checked')).toBe('true');
      expect(byId(dom, 'swOn').textContent).toBe('On');
      expect(byId(dom, 'pausedBanner').hidden).toBe(true);
      sw.click();
      await vi.waitFor(() => expect(posts(fetchClient).map((p) => p.body.action)).toEqual([REMOTE_DESKTOP_LOCAL_ACTION.PAUSE]));
      paused = true;
      await vi.waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('false'), { timeout: 3_000 });
      expect(byId(dom, 'swOff').textContent).toBe('Off');
      expect(byId(dom, 'pausedBanner').hidden).toBe(false);
      expect(byId(dom, 'statusText').textContent).toBe('Paused');
      expect(byId(dom, 'allowHelp').textContent).toBe('Nobody can connect until you turn this on.');
      byId(dom, 'resume').click();
      await vi.waitFor(() => expect(posts(fetchClient).map((p) => p.body.action)).toEqual([REMOTE_DESKTOP_LOCAL_ACTION.PAUSE, REMOTE_DESKTOP_LOCAL_ACTION.RESUME]));
    } finally { dom.window.close(); }
  });

  it('keeps keyboard focus on the switch while its action runs and after it completes', async () => {
    let paused = false;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { dom, fetchClient } = await openPageInDom({
      state: () => ({ paused }),
      extraFetch: (url) => (url === REMOTE_DESKTOP_LOCAL_MANAGEMENT.ACTION_PATH ? gate.then(() => ({ ok: true, json: async () => ({ ok: true }) })) : undefined),
    });
    try {
      const sw = byId(dom, 'allowSwitch') as HTMLButtonElement;
      await vi.waitFor(() => expect(byId(dom, 'statusPill').hidden).toBe(false));
      sw.focus();
      sw.click();
      await vi.waitFor(() => expect(posts(fetchClient)).toHaveLength(1));
      // While the request is in flight: still focused, not disabled, marked busy, and a second press does nothing.
      expect(dom.window.document.activeElement).toBe(sw);
      expect(sw.disabled).toBe(false);
      sw.click();
      expect(posts(fetchClient)).toHaveLength(1);
      release?.();
      paused = true;
      await vi.waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('false'), { timeout: 3_000 });
      expect(dom.window.document.activeElement).toBe(sw);
      expect(sw.getAttribute('aria-busy')).toBe('false');
    } finally { dom.window.close(); }
  });

  it('shows the node unreachable and recovers, without losing the last state', async () => {
    let down = false;
    const { dom } = await openPageInDom({
      state: () => ({ connections: [{ id: 'a', label: '1', connectedAt: Date.now(), mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW }] }),
      extraFetch: (url) => (down && url === REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH ? { ok: false } : undefined),
    });
    try {
      await vi.waitFor(() => expect(byId(dom, 'count').textContent).toBe('1'));
      expect(byId(dom, 'offlineBanner').hidden).toBe(true);
      down = true;
      await vi.waitFor(() => expect(byId(dom, 'offlineBanner').hidden).toBe(false), { timeout: 3_000 });
      expect(byId(dom, 'statusText').textContent).toBe('Offline');
      expect(byId(dom, 'count').textContent).toBe('1');
      down = false;
      await vi.waitFor(() => expect(byId(dom, 'offlineBanner').hidden).toBe(true), { timeout: 3_000 });
    } finally { dom.window.close(); }
  });

  it('shows the host name and permission tiles only when the node sends them, and the tile button asks for that pane only', async () => {
    let extras: Record<string, unknown> = {};
    const { dom, fetchClient } = await openPageInDom({ state: () => extras });
    try {
      await vi.waitFor(() => expect(byId(dom, 'statusText').textContent).toBe('Online'));
      expect(byId(dom, 'permsCard').hidden).toBe(true);
      expect(byId(dom, 'deviceName').textContent).toBe('This computer');
      extras = { deviceName: '<img src=x onerror=alert(1)>', permissions: { screenRecording: 'granted', accessibility: 'unknown', fullDiskAccess: 'denied' } };
      await vi.waitFor(() => expect(byId(dom, 'permsCard').hidden).toBe(false), { timeout: 3_000 });
      expect(byId(dom, 'deviceName').textContent).toBe('<img src=x onerror=alert(1)>');
      expect(byId(dom, 'deviceName').querySelector('img')).toBeNull();
      expect(dom.window.document.querySelectorAll('.perm')).toHaveLength(3);
      expect(dom.window.document.querySelectorAll('.perm.ok')).toHaveLength(1);
      const buttons = [...dom.window.document.querySelectorAll('.perm button')] as HTMLButtonElement[];
      expect(buttons.map((b) => b.getAttribute('data-target'))).toEqual(['accessibility', 'fullDiskAccess']);
      buttons[1]!.click();
      await vi.waitFor(() => expect(posts(fetchClient)).toEqual([{ url: REMOTE_DESKTOP_LOCAL_MANAGEMENT.OPEN_SETTINGS_PATH, body: { target: 'fullDiskAccess' } }]));
    } finally { dom.window.close(); }
  });

  it('follows the system language, lets the person pick another that sticks, and "Follow system" goes back', async () => {
    const { dom, storage } = await openPageInDom({ languages: ['de-DE', 'zh-Hant-TW', 'en'] });
    try {
      await vi.waitFor(() => expect(byId(dom, 'statusText').textContent).toBe('上線'));
      expect(dom.window.document.documentElement.lang).toBe('zh-TW');
      expect(dom.window.document.title).toBe(LOCAL_PANEL_WINDOW_TITLE);
      const select = byId(dom, 'langSelect') as HTMLSelectElement;
      expect(select.value).toBe('system');
      expect([...select.options].map((o) => o.value)).toEqual(['system', 'en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko']);
      select.value = 'ru';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      expect(byId(dom, 'statusText').textContent).toBe('В сети');
      expect(dom.window.document.documentElement.lang).toBe('ru');
      expect(storage['aidesk-local-lang']).toBe('ru');
      select.value = 'system';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      expect(byId(dom, 'statusText').textContent).toBe('上線');
      expect('aidesk-local-lang' in storage).toBe(false);
    } finally { dom.window.close(); }
  });

  it('a remembered choice beats the system language; junk in storage is ignored; blocked storage does not break the page', async () => {
    const remembered = await openPageInDom({ languages: ['en-US'], storage: { 'aidesk-local-lang': 'ko' } });
    try {
      await vi.waitFor(() => expect(byId(remembered.dom, 'statusText').textContent).toBe('온라인'));
      expect((byId(remembered.dom, 'langSelect') as HTMLSelectElement).value).toBe('ko');
    } finally { remembered.dom.window.close(); }
    const junk = await openPageInDom({ languages: ['es-ES'], storage: { 'aidesk-local-lang': 'klingon' } });
    try {
      await vi.waitFor(() => expect(byId(junk.dom, 'statusText').textContent).toBe('En línea'));
    } finally { junk.dom.window.close(); }
    const blocked = await openPageInDom({
      languages: ['ja'],
      beforeParse(window) {
        Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new window.DOMException('denied', 'SecurityError'); } });
      },
    });
    try {
      await vi.waitFor(() => expect(byId(blocked.dom, 'statusText').textContent).toBe('オンライン'));
      const select = byId(blocked.dom, 'langSelect') as HTMLSelectElement;
      select.value = 'en';
      expect(() => select.dispatchEvent(new blocked.dom.window.Event('change', { bubbles: true }))).not.toThrow();
      expect(byId(blocked.dom, 'statusText').textContent).toBe('Online');
    } finally { blocked.dom.window.close(); }
  });

  it('copies the raw ID (the display is grouped 3-3-4) and falls back when the async clipboard is missing', async () => {
    const written: string[] = [];
    const { dom } = await openPageInDom({
      beforeParse(window) {
        Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { written.push(text); } } });
      },
    });
    try {
      expect(byId(dom, 'nodeId').textContent).toBe('123 456 7890');
      byId(dom, 'copy').click();
      await vi.waitFor(() => expect(written).toEqual(['1234567890']));
      await vi.waitFor(() => expect(byId(dom, 'toast').textContent).toBe('Copied'));
    } finally { dom.window.close(); }
    const execCalls: string[] = [];
    const fallback = await openPageInDom({
      beforeParse(window) {
        Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: undefined });
        (window.document as unknown as { execCommand: (c: string) => boolean }).execCommand = (command: string) => { execCalls.push(command); return true; };
      },
    });
    try {
      byId(fallback.dom, 'copy').click();
      expect(execCalls).toEqual(['copy']);
    } finally { fallback.dom.window.close(); }
  });

  it('renders hundreds of connections quickly and does not rebuild the list (or steal focus) when nothing changed', async () => {
    const many = Array.from({ length: 300 }, (_, index) => ({
      id: `id-${index}`, label: String(index + 1), connectedAt: Date.now() - index * 1_000,
      mode: index % 7 === 0 ? REMOTE_DESKTOP_ACCESS_MODE.CONTROL : REMOTE_DESKTOP_ACCESS_MODE.VIEW,
    }));
    const { dom, fetchClient } = await openPageInDom({ state: () => ({ connections: many }) });
    try {
      const started = Date.now();
      await vi.waitFor(() => expect(dom.window.document.querySelectorAll('.conn')).toHaveLength(300));
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(byId(dom, 'count').textContent).toBe('300');
      expect(byId(dom, 'navBadge').className).toBe('badge ctl');
      const first = dom.window.document.querySelector('.conn button') as HTMLButtonElement;
      first.focus();
      const polls = () => fetchClient.mock.calls.filter(([url]) => url === REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH).length;
      const before = polls();
      await vi.waitFor(() => expect(polls()).toBeGreaterThan(before), { timeout: 3_000 });
      // The same state came back: the same elements are still there and the focused button still has focus.
      expect(dom.window.document.querySelector('.conn button')).toBe(first);
      expect(dom.window.document.activeElement).toBe(first);
    } finally { dom.window.close(); }
  });

  it('keeps one section visible at a time and marks the current one', async () => {
    const { dom } = await openPageInDom();
    try {
      const pages = () => ['home', 'settings', 'about'].map((name) => !(dom.window.document.querySelector(`.page[data-page="${name}"]`) as HTMLElement).hidden);
      expect(pages()).toEqual([true, false, false]);
      (dom.window.document.querySelector('.nav[data-page="about"]') as HTMLButtonElement).click();
      expect(pages()).toEqual([false, false, true]);
      expect(dom.window.document.querySelector('.nav[aria-current="page"]')?.getAttribute('data-page')).toBe('about');
      expect(byId(dom, 'aboutId').textContent).toBe('123 456 7890');
    } finally { dom.window.close(); }
  });
});

describe('remote desktop local panel: independent window entry', () => {
  async function startPanel(extra: Partial<Parameters<typeof startRemoteDesktopLocalPanel>[0]> = {}) {
    const panel = await startRemoteDesktopLocalPanel({
      publicNodeId: '1234567890', serverUrl: 'https://example.test/',
      status: () => ({ paused: false, connections: [] }),
      setPaused: async () => {}, stopAll: async () => {}, disconnect: async () => true, port: 0, ...extra,
    });
    panels.push(panel);
    return panel;
  }
  const openUrl = (panel: RemoteDesktopLocalPanel) => new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.OPEN_WINDOW_PATH, panel.url);
  const nativeHeaders = { [REMOTE_DESKTOP_LOCAL_MANAGEMENT.OPEN_WINDOW_HEADER]: '1' };

  it('the page title is the window title the single-instance focus looks for', async () => {
    const panel = await startPanel();
    const html = await (await fetch(panel.url)).text();
    expect(html).toContain(`<title>${LOCAL_PANEL_WINDOW_TITLE}</title>`);
    expect(LOCAL_PANEL_WINDOW_TITLE).toBe(AIDESK_PRODUCT_NAME);
  });

  it('open-window: a native client (custom header, no Origin) gets the decision; a web page cannot trigger it', async () => {
    const openWindow = vi.fn(async () => ({ ok: true, reason: 'opened_app_mode_window' }));
    const panel = await startPanel({ openWindow });
    const ok = await fetch(openUrl(panel), { method: 'POST', headers: nativeHeaders });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, reason: 'opened_app_mode_window' });
    expect(openWindow).toHaveBeenCalledTimes(1);
    // no custom header (a plain cross-site form post), a wrong header value, or any Origin (every browser cross-site POST) -> refused
    for (const headers of [{}, { [REMOTE_DESKTOP_LOCAL_MANAGEMENT.OPEN_WINDOW_HEADER]: '0' }, { ...nativeHeaders, origin: 'https://evil.test' }, { ...nativeHeaders, origin: new URL(panel.url).origin }]) {
      expect((await fetch(openUrl(panel), { method: 'POST', headers })).status).toBe(403);
    }
    expect((await fetch(openUrl(panel), { method: 'GET', headers: nativeHeaders })).status).not.toBe(200);
    expect(openWindow).toHaveBeenCalledTimes(1);
  });

  it('open-window: nothing could be opened is a 502 (the native client then uses its own fallback); an older panel without the handler is a 501; concurrent clicks share one open', async () => {
    const failing = await startPanel({ openWindow: async () => ({ ok: false, reason: 'launch_failed' }) });
    expect((await fetch(openUrl(failing), { method: 'POST', headers: nativeHeaders })).status).toBe(502);
    const throwing = await startPanel({ openWindow: async () => { throw new Error('boom'); } });
    expect((await fetch(openUrl(throwing), { method: 'POST', headers: nativeHeaders })).status).toBe(502);
    const absent = await startPanel();
    expect((await fetch(openUrl(absent), { method: 'POST', headers: nativeHeaders })).status).toBe(501);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const openWindow = vi.fn(async () => { await gate; return { ok: true, reason: 'focused_existing_window' }; });
    const shared = await startPanel({ openWindow });
    const first = fetch(openUrl(shared), { method: 'POST', headers: nativeHeaders });
    const second = fetch(openUrl(shared), { method: 'POST', headers: nativeHeaders });
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(openWindow).toHaveBeenCalledTimes(1);
  });

  it('open-window: when the open outlasts the answer budget the client is told it is in progress (200), once, and the open continues', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const openWindow = vi.fn(async () => { await gate; return { ok: true, reason: 'opened_app_mode_window' }; });
    const panel = await startPanel({ openWindow, openWindowAnswerBudgetMs: 60 });
    const started = Date.now();
    const answer = await fetch(openUrl(panel), { method: 'POST', headers: nativeHeaders });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ok: true, reason: 'in_progress' });
    expect(openWindow).toHaveBeenCalledTimes(1);
    release();
  });

  it('open-window is refused for a request whose Host is not exactly the panel', async () => {
    const panel = await startPanel({ openWindow: async () => ({ ok: true, reason: 'x' }) });
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: Number(new URL(panel.url).port), path: REMOTE_DESKTOP_LOCAL_MANAGEMENT.OPEN_WINDOW_PATH, method: 'POST', headers: { host: 'evil.test', ...nativeHeaders } }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      req.once('error', reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it('open-external: only the two fixed targets, only with the session, CSRF and the panel\'s own Origin; never a URL from the request', async () => {
    const openExternal = vi.fn(async () => true);
    const panel = await startPanel({ openExternal });
    const page = await fetch(panel.url);
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
    const csrf = /"csrf":"([^"]+)"/.exec(await page.text())![1]!;
    const url = new URL(LOCAL_PANEL_EXTERNAL_PATH, panel.url);
    const origin = new URL(panel.url).origin;
    const post = (body: unknown, headers: Record<string, string> = {}) => fetch(url, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: csrf, ...headers }, body: JSON.stringify(body),
    });
    expect((await post({ target: 'manage' })).status).toBe(200);
    expect((await post({ target: 'share' })).status).toBe(200);
    expect(openExternal.mock.calls.map((call) => call[0])).toEqual(['manage', 'share']);
    for (const bad of [{ target: 'https://evil.test/' }, { target: 'ftp' }, { url: 'https://evil.test/' }, {}, { target: 7 }]) {
      expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await post({ target: 'manage' }, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await post({ target: 'manage' }, { [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: 'wrong' })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers: { origin, 'content-type': 'application/json', [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: csrf }, body: '{"target":"manage"}' })).status).toBe(401);
    expect(openExternal).toHaveBeenCalledTimes(2);
    const refused = await startPanel({ openExternal: async () => false });
    const refusedPage = await fetch(refused.url);
    const refusedCookie = refusedPage.headers.get('set-cookie')!.split(';')[0]!;
    const refusedCsrf = /"csrf":"([^"]+)"/.exec(await refusedPage.text())![1]!;
    expect((await fetch(new URL(LOCAL_PANEL_EXTERNAL_PATH, refused.url), { method: 'POST', headers: { cookie: refusedCookie, origin: new URL(refused.url).origin, 'content-type': 'application/json', [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: refusedCsrf }, body: '{"target":"share"}' })).status).toBe(502);
  });

  it('the page sends Share and Web management through open-external, and only opens a window itself when that is refused', async () => {
    const panel = await startPanel({ openExternal: async () => true });
    const html = await (await fetch(panel.url)).text();
    for (const accepting of [true, false]) {
      const opened: string[] = [];
      const fetchClient = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === LOCAL_PANEL_EXTERNAL_PATH) return { ok: accepting };
        return { ok: true, json: async () => ({ publicNodeId: '1234567890', paused: false, connections: [] }), init };
      });
      const dom = new JSDOM(html, {
        url: panel.url, runScripts: 'dangerously',
        beforeParse(window) {
          Object.defineProperty(window, 'fetch', { configurable: true, value: fetchClient });
          window.open = ((url: string) => { opened.push(url); return null; }) as never;
        },
      });
      try {
        (dom.window.document.getElementById('share') as HTMLButtonElement).click();
        (dom.window.document.getElementById('manage') as HTMLButtonElement).click();
        const sent = () => fetchClient.mock.calls.filter(([url]) => url === LOCAL_PANEL_EXTERNAL_PATH).map(([, init]) => JSON.parse(String((init as RequestInit).body)).target);
        await vi.waitFor(() => expect(sent()).toEqual(['share', 'manage']));
        if (accepting) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(opened).toEqual([]);
        } else {
          await vi.waitFor(() => expect(opened).toHaveLength(2));
          expect(opened.every((url) => url.startsWith('https://example.test/'))).toBe(true);
        }
        // Never a link in the document itself.
        expect(dom.window.document.querySelectorAll('a[href]')).toHaveLength(0);
      } finally { dom.window.close(); }
    }
  });
});

describe('remote desktop local panel: open-settings', () => {
  async function start(extra: Partial<Parameters<typeof startRemoteDesktopLocalPanel>[0]> = {}) {
    const panel = await startRemoteDesktopLocalPanel({
      publicNodeId: '1234567890', serverUrl: 'https://example.test/',
      status: () => ({ paused: false, connections: [] }),
      setPaused: async () => {}, stopAll: async () => {}, disconnect: async () => true, port: 0, ...extra,
    });
    panels.push(panel);
    const page = await fetch(panel.url);
    const html = await page.text();
    return {
      panel,
      cookie: (page.headers.get('set-cookie') ?? '').split(';')[0]!,
      csrf: /"csrf":"([^"]+)"/u.exec(html)![1]!,
      origin: new URL(panel.url).origin,
      post: (body: unknown, headers: Record<string, string>) => fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.OPEN_SETTINGS_PATH, panel.url), {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
      }),
    };
  }

  it('opens only a fixed pane chosen by key, behind the same gate as every other mutation', async () => {
    const openSettings = vi.fn(async () => true);
    const { cookie, csrf, origin, post } = await start({ openSettings });
    const good = { cookie, origin, [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: csrf };
    for (const target of ['screenRecording', 'accessibility', 'fullDiskAccess']) {
      expect((await post({ target }, good)).status).toBe(200);
    }
    expect(openSettings.mock.calls.map((call) => call[0])).toEqual(['screenRecording', 'accessibility', 'fullDiskAccess']);

    openSettings.mockClear();
    // No cookie / wrong origin / missing or wrong CSRF -> refused before the handler is reached.
    expect((await post({ target: 'accessibility' }, { origin, [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: csrf })).status).toBe(401);
    expect((await post({ target: 'accessibility' }, { cookie, origin: 'https://evil.test', [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: csrf })).status).toBe(403);
    expect((await post({ target: 'accessibility' }, { cookie, origin })).status).toBe(403);
    expect((await post({ target: 'accessibility' }, { cookie, origin, [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: 'wrong' })).status).toBe(403);
    // The page cannot name a URL, a path, a pane of its own invention, or anything that is not exactly one of the three keys.
    for (const body of [{ target: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera' }, { target: '../etc' }, { target: 'camera' }, { target: 7 }, { url: 'https://evil.test' }, {}, { target: 'toString' }, { target: '__proto__' }]) {
      expect((await post(body, good)).status, JSON.stringify(body)).toBe(400);
    }
    expect(openSettings).not.toHaveBeenCalled();
  });

  it('answers 501 without a handler (not macOS), 502 when the pane could not be opened, 502 when the handler throws', async () => {
    const none = await start();
    expect((await none.post({ target: 'accessibility' }, { cookie: none.cookie, origin: none.origin, [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: none.csrf })).status).toBe(501);
    const refuses = await start({ openSettings: async () => false });
    expect((await refuses.post({ target: 'accessibility' }, { cookie: refuses.cookie, origin: refuses.origin, [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: refuses.csrf })).status).toBe(502);
    const throws = await start({ openSettings: async () => { throw new Error('boom'); } });
    expect((await throws.post({ target: 'accessibility' }, { cookie: throws.cookie, origin: throws.origin, [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: throws.csrf })).status).toBe(502);
  });

  it('keeps the page headers exactly as they were: same CSP, loopback Host only', async () => {
    const { panel } = await start();
    const response = await fetch(panel.url);
    expect(response.headers.get('content-security-policy'))
      .toBe("default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    const url = new URL(panel.url);
    expect(url.hostname).toBe('127.0.0.1');
  });
});

describe('local panel Coding Daemon endpoints and UI', () => {
  async function startWithDaemon(extra?: Partial<Parameters<typeof startRemoteDesktopLocalPanel>[0]>) {
    const panel = await startRemoteDesktopLocalPanel({
      publicNodeId: '1234567890',
      serverUrl: 'https://example.test/',
      status: () => ({ paused: false, connections: [] }),
      setPaused: async () => {},
      stopAll: async () => {},
      disconnect: async () => true,
      port: 0,
      ...extra,
    });
    panels.push(panel);
    const page = await fetch(panel.url);
    const html = await page.text();
    return {
      panel,
      html,
      cookie: (page.headers.get('set-cookie') ?? '').split(';')[0]!,
      csrf: /"csrf":"([^"]+)"/u.exec(html)![1]!,
      origin: new URL(panel.url).origin,
    };
  }

  it('keeps /api/state free of daemon and answers 501 on daemon routes when handlers are omitted', async () => {
    const { panel, cookie, csrf, origin } = await startWithDaemon();
    const stateRes = await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH, panel.url), {
      headers: { cookie },
    });
    expect(stateRes.status).toBe(200);
    const state = await stateRes.json() as Record<string, unknown>;
    expect('daemon' in state).toBe(false);

    const logsRes = await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.DAEMON_LOGS_PATH, panel.url), {
      headers: { cookie },
    });
    expect(logsRes.status).toBe(501);

    const actionRes = await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.ACTION_PATH, panel.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin,
        [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: csrf,
      },
      body: JSON.stringify({ action: REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START }),
    });
    expect(actionRes.status).toBe(501);
  });

  it('gates daemon actions and logs behind session cookie, Origin, CSRF, and sanitizes state', async () => {
    const daemonAction = vi.fn(async (action: string, payload?: { bindUrl?: unknown }) => {
      if (action === REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND && payload?.bindUrl === 'bad') {
        return { ok: false, statusCode: 400, error: 'invalid_bind_url' };
      }
      return { ok: true, statusCode: 200 };
    });
    const daemonLogs = vi.fn(async () => ({ text: 'daemon line 1\ndaemon line 2\n', truncated: false, source: 'logs/daemon.log' }));
    const { panel, cookie, csrf, origin } = await startWithDaemon({
      daemon: async () => ({
        available: true,
        installed: true,
        bound: true,
        running: true,
        connectionState: REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.CONNECTED,
        autostart: REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED,
        runtimeSource: REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE.BUNDLE,
        version: '1.2.3',
        pid: 4242,
        serverId: 'srv_1',
        serverHost: 'app.example.test',
        serverOrigin: 'https://app.example.test',
        userName: 'alice',
        lastError: 'Bearer hidden_tok_999 failed',
        canControl: true,
        canBind: true,
        canViewLogs: true,
      }),
      daemonAction,
      daemonLogs,
    });

    // State includes sanitized daemon snapshot
    const stateRes = await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH, panel.url), { headers: { cookie } });
    expect(stateRes.status).toBe(200);
    const state = await stateRes.json() as { daemon?: { lastError?: string; userName?: string } };
    expect(state.daemon?.userName).toBe('alice');
    expect(state.daemon?.lastError).not.toContain('hidden_tok_999');

    // Logs require cookie
    expect((await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.DAEMON_LOGS_PATH, panel.url))).status).toBe(401);
    const logsOk = await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.DAEMON_LOGS_PATH, panel.url), { headers: { cookie } });
    expect(logsOk.status).toBe(200);
    expect(await logsOk.json()).toMatchObject({ text: 'daemon line 1\ndaemon line 2\n', truncated: false });

    // CSRF/Origin gate on daemon actions
    expect((await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.ACTION_PATH, panel.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://evil.test', [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: csrf },
      body: JSON.stringify({ action: REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.RESTART }),
    })).status).toBe(403);
    expect((await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.ACTION_PATH, panel.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin },
      body: JSON.stringify({ action: REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.RESTART }),
    })).status).toBe(403);

    // Valid daemon action succeeds; rejected bind returns mapped status code
    const restartOk = await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.ACTION_PATH, panel.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin, [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: csrf },
      body: JSON.stringify({ action: REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.RESTART }),
    });
    expect(restartOk.status).toBe(200);
    const badBind = await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.ACTION_PATH, panel.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin, [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: csrf },
      body: JSON.stringify({ action: REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND, bindUrl: 'bad' }),
    });
    expect(badBind.status).toBe(400);
    expect(daemonAction).toHaveBeenCalledTimes(2);
  });

  it('renders daemon card, clears bind URL input immediately upon submit, and loads sanitized logs in DOM', async () => {
    let running = false;
    const dispatched: Array<{ action: string; bindUrl?: unknown }> = [];
    const { panel, html, cookie } = await startWithDaemon({
      daemon: async () => ({
        available: true,
        installed: true,
        bound: true,
        running,
        connectionState: running
          ? REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.CONNECTED
          : REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.DISCONNECTED,
        autostart: REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.DISABLED,
        runtimeSource: REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE.BUNDLE,
        version: '1.2.3',
        userName: 'alice',
        serverHost: 'app.example.test',
        serverOrigin: 'https://app.example.test',
        canControl: true,
        canBind: true,
        canViewLogs: true,
      }),
      daemonAction: async (action, payload) => {
        dispatched.push({ action, bindUrl: payload?.bindUrl });
        if (action === REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START) running = true;
        return { ok: true, statusCode: 200 };
      },
      daemonLogs: async () => ({ text: 'hello from daemon log\n', truncated: false, source: 'logs/daemon.log' }),
    });

    const nodeFetch = globalThis.fetch;
    const authedFetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof input === 'string' ? new URL(input, panel.url).toString() : input;
      const headers = new Headers(init?.headers);
      headers.set('cookie', cookie);
      if (init?.method === 'POST') headers.set('origin', new URL(panel.url).origin);
      return nodeFetch(target, { ...init, headers });
    };

    const dom = new JSDOM(html, {
      url: panel.url,
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        (win as unknown as { fetch: typeof authedFetch }).fetch = authedFetch;
        Object.defineProperty(win.navigator, 'languages', { value: ['en-US'], configurable: true });
      },
    });
    const doc = dom.window.document;
    await new Promise((r) => setTimeout(r, 80));

    const daemonCard = doc.getElementById('daemonCard') as HTMLElement;
    expect(daemonCard.hidden).toBe(false);
    expect(doc.getElementById('daemonStatusText')?.textContent).toBe('Stopped');

    // Start action updates card state
    (doc.getElementById('daemonStart') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 80));
    expect(dispatched.some((d) => d.action === REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START)).toBe(true);
    expect(doc.getElementById('daemonStatusText')?.textContent).toBe('Running');

    // Bind modal clears secret input immediately upon submit
    (doc.getElementById('daemonBindBtn') as HTMLButtonElement).click();
    const bindInput = doc.getElementById('daemonBindInput') as HTMLInputElement;
    bindInput.value = 'https://app.example.test/bind/secret_key_xyz';
    const form = doc.getElementById('daemonBindForm') as HTMLFormElement;
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    expect(bindInput.value).toBe('');
    await new Promise((r) => setTimeout(r, 80));
    expect(dispatched.some((d) => d.action === REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND && d.bindUrl === 'https://app.example.test/bind/secret_key_xyz')).toBe(true);

    // Logs modal fetches and shows textContent cleanly
    (doc.getElementById('daemonLogsBtn') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 80));
    expect(doc.getElementById('daemonLogsPre')?.textContent).toContain('hello from daemon log');

    dom.window.close();
  });

  it('redacts JSON/KV/Bearer secrets in /api/state, /api/daemon/logs, and DOM, and keeps Remote Desktop actions non-blocked during hung bind', async () => {
    let releaseBind!: () => void;
    const bindGate = new Promise<void>((resolve) => { releaseBind = resolve; });
    let paused = false;

    const { panel, html, cookie, csrf } = await startWithDaemon({
      state: () => ({ paused, connections: [] }),
      setPaused: async (next) => { paused = next; },
      daemon: async () => ({
        available: true,
        installed: true,
        bound: true,
        running: true,
        connectionState: REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.CONNECTED,
        autostart: REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED,
        runtimeSource: REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE.BUNDLE,
        userName: 'alice',
        lastError: '{"token":"state-json-secret","apiKey":"state-apikey-secret"} tokenizer ready',
        canControl: true,
        canBind: true,
        canViewLogs: true,
      }),
      daemonLogs: async () => ({
        text: 'log line {"bindKey":"dom-json-secret"} token count: 7 Bearer dom-bearer-secret\n',
        truncated: false,
        source: 'logs/daemon.log',
      }),
      daemonAction: async (action) => {
        if (action === REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND) {
          await bindGate;
        }
        return { ok: true, statusCode: 200 };
      },
    });

    const origin = new URL(panel.url).origin;
    const stateRes = await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH, panel.url), { headers: { cookie } });
    const stateBody = await stateRes.json() as { daemon?: { lastError?: string } };
    expect(stateBody.daemon?.lastError).toContain('tokenizer ready');
    expect(stateBody.daemon?.lastError).not.toContain('state-json-secret');
    expect(stateBody.daemon?.lastError).not.toContain('state-apikey-secret');

    const logsRes = await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.DAEMON_LOGS_PATH, panel.url), { headers: { cookie } });
    const logsBody = await logsRes.json() as { text: string };
    expect(logsBody.text).toContain('token count: 7');
    expect(logsBody.text).not.toContain('dom-json-secret');
    expect(logsBody.text).not.toContain('dom-bearer-secret');

    // JSDOM check on redacted textContent
    const nodeFetch = globalThis.fetch;
    const authedFetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof input === 'string' ? new URL(input, panel.url).toString() : input;
      const headers = new Headers(init?.headers);
      headers.set('cookie', cookie);
      return nodeFetch(target, { ...init, headers });
    };
    const dom = new JSDOM(html, {
      url: panel.url,
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        (win as unknown as { fetch: typeof authedFetch }).fetch = authedFetch;
        Object.defineProperty(win.navigator, 'languages', { value: ['en-US'], configurable: true });
      },
    });
    const doc = dom.window.document;
    await new Promise((r) => setTimeout(r, 80));
    expect(doc.getElementById('daemonHint')?.textContent).toContain('tokenizer ready');
    expect(doc.getElementById('daemonHint')?.textContent).not.toContain('state-json-secret');
    (doc.getElementById('daemonLogsBtn') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 80));
    expect(doc.getElementById('daemonLogsPre')?.textContent).toContain('token count: 7');
    expect(doc.getElementById('daemonLogsPre')?.textContent).not.toContain('dom-json-secret');
    dom.window.close();

    // Concurrency isolation: start a blocked daemon bind, verify Remote Desktop pause finishes immediately
    const hungBindPromise = fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.ACTION_PATH, panel.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin, [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: csrf },
      body: JSON.stringify({ action: REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND, bindUrl: 'https://app.example.test/bind/abc123' }),
    });
    const pauseRes = await Promise.race([
      fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.ACTION_PATH, panel.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin, [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: csrf },
        body: JSON.stringify({ action: REMOTE_DESKTOP_LOCAL_ACTION.PAUSE }),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('pause blocked behind daemon bind')), 500)),
    ]);
    expect(pauseRes.status).toBe(200);
    expect(paused).toBe(true);
    releaseBind();
    const settledBind = await hungBindPromise;
    expect(settledBind.status).toBe(200);
  });

  it('F3-R2: isolates UI busy state per domain across real DOM clicks and both completion orders', async () => {
    const html = renderLocalPanelPage({
      publicNodeId: '1234567890',
      csrf: 'csrf-f3',
      manageUrl: 'https://example.test/m',
      shareUrl: 'https://example.test/s',
    });

    let paused = false;
    let conns = [{ id: 'c1', label: 'Viewer', mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL, connectedAt: Date.now() - 1000 }];
    const actions: string[] = [];
    let releaseBind: (() => void) | undefined;
    let releaseRemote: (() => void) | undefined;
    let holdBind = true;
    let holdRemote = false;

    const currentState = () => ({
      publicNodeId: '1234567890',
      paused,
      connections: conns,
      daemon: {
        available: true,
        installed: true,
        bound: true,
        running: true,
        connectionState: REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.CONNECTED,
        autostart: REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED,
        runtimeSource: REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE.BUNDLE,
        canControl: true,
        canBind: true,
        canViewLogs: true,
      },
    });

    const waitUntil = async (fn: () => boolean) => {
      for (let i = 0; i < 100 && !fn(); i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(fn()).toBe(true);
    };

    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:43751/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        (win as unknown as { fetch: typeof fetch }).fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as { action: string };
            actions.push(body.action);
            if (body.action === REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND && holdBind) {
              await new Promise<void>((r) => { releaseBind = r; });
              return new Response('{}', { status: 200 });
            }
            if (body.action === REMOTE_DESKTOP_LOCAL_ACTION.PAUSE) {
              if (holdRemote) await new Promise<void>((r) => { releaseRemote = r; });
              paused = true;
              return new Response('{}', { status: 200 });
            }
            if (body.action === REMOTE_DESKTOP_LOCAL_ACTION.RESUME) {
              if (holdRemote) await new Promise<void>((r) => { releaseRemote = r; });
              paused = false;
              return new Response('{}', { status: 200 });
            }
            if (body.action === REMOTE_DESKTOP_LOCAL_ACTION.STOP_ALL) {
              conns = [];
              return new Response('{}', { status: 200 });
            }
            return new Response('{}', { status: 200 });
          }
          return new Response(JSON.stringify(currentState()), { status: 200 });
        }) as unknown as typeof fetch;
      },
    });

    try {
      const doc = dom.window.document;
      await waitUntil(() => !(doc.getElementById('daemonCard') as HTMLElement).hidden);

      const allowSwitch = doc.getElementById('allowSwitch') as HTMLButtonElement;
      const stopAll = doc.getElementById('stopAll') as HTMLButtonElement;
      const confirmAction = doc.getElementById('confirmAction') as HTMLButtonElement;
      const daemonBindBtn = doc.getElementById('daemonBindBtn') as HTMLButtonElement;
      const daemonBindInput = doc.getElementById('daemonBindInput') as HTMLInputElement;
      const daemonBindForm = doc.getElementById('daemonBindForm') as HTMLFormElement;
      const daemonStop = doc.getElementById('daemonStop') as HTMLButtonElement;
      const daemonAutostartSwitch = doc.getElementById('daemonAutostartSwitch') as HTMLButtonElement;

      // 1) Start a pending daemon BIND via real DOM form submission
      daemonBindBtn.click();
      daemonBindInput.value = 'https://app.example.test/bind/real_dom_key';
      daemonBindForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await waitUntil(() => actions.includes(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND));

      expect(daemonBindBtn.disabled).toBe(true);
      expect(daemonStop.disabled).toBe(true);
      expect(daemonAutostartSwitch.getAttribute('aria-busy')).toBe('true');
      expect(allowSwitch.disabled).toBe(false);
      expect(allowSwitch.getAttribute('aria-busy')).toBe('false');

      // Duplicate daemon clicks during daemon busy are ignored
      daemonStop.click();
      daemonAutostartSwitch.click();
      expect(actions).toEqual([REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND]);

      // 2) Real Remote Desktop click (#allowSwitch) fires PAUSE immediately while BIND stays pending,
      //    and PAUSE finishing first does NOT clear daemon busy state.
      allowSwitch.click();
      await waitUntil(() => actions.includes(REMOTE_DESKTOP_LOCAL_ACTION.PAUSE));
      await waitUntil(() => paused && allowSwitch.getAttribute('aria-busy') === 'false');
      expect(daemonBindBtn.disabled).toBe(true);
      expect(daemonAutostartSwitch.getAttribute('aria-busy')).toBe('true');

      // Also verify #stopAll -> #confirmAction works while BIND is still pending
      stopAll.click();
      confirmAction.click();
      await waitUntil(() => actions.includes(REMOTE_DESKTOP_LOCAL_ACTION.STOP_ALL));
      expect(daemonBindBtn.disabled).toBe(true);

      releaseBind?.();
      await waitUntil(() => !daemonBindBtn.disabled && daemonAutostartSwitch.getAttribute('aria-busy') === 'false');

      // 3) Reverse completion order: BIND finishes while RESUME is still pending;
      //    remote domain MUST remain busy and deduplicate duplicate #allowSwitch clicks until RESUME finishes.
      actions.length = 0;
      holdRemote = true;
      daemonBindBtn.click();
      daemonBindInput.value = 'https://app.example.test/bind/real_dom_key_2';
      daemonBindForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await waitUntil(() => actions.includes(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND));

      allowSwitch.click();
      await waitUntil(() => actions.includes(REMOTE_DESKTOP_LOCAL_ACTION.RESUME));
      expect(allowSwitch.getAttribute('aria-busy')).toBe('true');

      releaseBind?.();
      await waitUntil(() => !daemonBindBtn.disabled);
      expect(allowSwitch.getAttribute('aria-busy')).toBe('true');

      // Same-domain duplicate click while RESUME is pending must still be dropped
      allowSwitch.click();
      await new Promise((r) => setTimeout(r, 20));
      expect(actions.filter((a) => a === REMOTE_DESKTOP_LOCAL_ACTION.RESUME)).toHaveLength(1);

      releaseRemote?.();
      await waitUntil(() => !paused && allowSwitch.getAttribute('aria-busy') === 'false');
    } finally {
      releaseBind?.();
      releaseRemote?.();
      dom.window.close();
    }
  });

  it('F3-R3: applies continuous finite slow poll responses without starvation and rejects stale out-of-order responses/errors', async () => {
    const html = renderLocalPanelPage({
      publicNodeId: '1234567890',
      csrf: 'csrf-poll',
      manageUrl: 'https://example.test/m',
      shareUrl: 'https://example.test/s',
    });

    const pending: Array<{ resolve: (r: Response) => void; reject: (err: unknown) => void }> = [];
    let pollCb: (() => void) | undefined;

    const flush = async () => {
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
    };

    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:43751/',
      runScripts: 'dangerously',
      beforeParse(win) {
        (win as unknown as { setInterval: (cb: () => void, ms: number) => number }).setInterval = (cb, ms) => {
          if (ms === 2000) pollCb = cb;
          return ms;
        };
        (win as unknown as { fetch: typeof fetch }).fetch = (() =>
          new Promise<Response>((resolve, reject) => {
            pending.push({ resolve, reject });
          })) as unknown as typeof fetch;
      },
    });

    try {
      const doc = dom.window.document;
      expect(pending).toHaveLength(1);
      expect(typeof pollCb).toBe('function');

      // 1) Continuous finite slow responses (next 2s poll always starts before prior 2.5s response completes)
      for (let i = 0; i < 5; i += 1) {
        pollCb!();
        pending[i]!.resolve(new Response(JSON.stringify({
          publicNodeId: '1234567890',
          paused: false,
          connections: [],
          deviceName: `SLOW-HEALTHY-${i}`,
          daemon: {
            available: true,
            installed: true,
            bound: true,
            running: true,
            connectionState: REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.CONNECTED,
            autostart: REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED,
            runtimeSource: REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE.BUNDLE,
            canControl: true,
            canBind: true,
            canViewLogs: true,
          },
        }), { status: 200 }));
        await flush();
      }
      expect((doc.getElementById('daemonCard') as HTMLElement).hidden).toBe(false);
      expect((doc.getElementById('allowSwitch') as HTMLButtonElement).disabled).toBe(false);
      expect(doc.getElementById('deviceName')?.textContent).toBe('SLOW-HEALTHY-4');

      // Resolve leftover pending[5] cleanly as req #6
      pending[5]!.resolve(new Response(JSON.stringify({
        publicNodeId: '1234567890',
        paused: false,
        connections: [],
        deviceName: 'CURRENT-6',
        daemon: {
          available: true,
          installed: true,
          bound: true,
          running: true,
          connectionState: REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.CONNECTED,
          autostart: REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED,
          runtimeSource: REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE.BUNDLE,
          canControl: true,
          canBind: true,
          canViewLogs: true,
        },
      }), { status: 200 }));
      await flush();

      // 2) Out-of-order completion: req #8 and #9 start; req #9 resolves newer state FIRST;
      //    older req #8 resolving later with stale payload must be dropped.
      pollCb!(); // pending[6] (seq 7)
      pollCb!(); // pending[7] (seq 8)
      pollCb!(); // pending[8] (seq 9)
      pending[8]!.resolve(new Response(JSON.stringify({
        publicNodeId: '1234567890',
        paused: true,
        connections: [],
        deviceName: 'NEWER-9',
        daemon: {
          available: true,
          installed: true,
          bound: true,
          running: true,
          connectionState: REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.CONNECTED,
          autostart: REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED,
          runtimeSource: REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE.BUNDLE,
          canControl: true,
          canBind: true,
          canViewLogs: true,
        },
      }), { status: 200 }));
      await flush();
      expect(doc.getElementById('deviceName')?.textContent).toBe('NEWER-9');
      expect((doc.getElementById('offlineBanner') as HTMLElement).hidden).toBe(true);

      // Stale older success (pending[6]) and stale older error (pending[7]) must NOT roll back state or flash offline
      pending[6]!.resolve(new Response(JSON.stringify({
        publicNodeId: '1234567890',
        paused: false,
        connections: [],
        deviceName: 'STALE-7',
      }), { status: 200 }));
      pending[7]!.reject(new Error('stale network failure'));
      await flush();

      expect(doc.getElementById('deviceName')?.textContent).toBe('NEWER-9');
      expect((doc.getElementById('offlineBanner') as HTMLElement).hidden).toBe(true);
      expect((doc.getElementById('pausedBanner') as HTMLElement).hidden).toBe(false);
    } finally {
      dom.window.close();
    }
  });
});

describe('Desktop Phase 2B pending_setup mode & switchToRuntime', () => {
  const created: RemoteDesktopLocalPanel[] = [];

  afterEach(async () => {
    while (created.length > 0) {
      await created.pop()?.close();
    }
  });

  it('supports browser auth handoff (/setup/callback state validation + nonce exchange) and transitions live without rebinding port', async () => {
    const { DESKTOP_SETUP_CALLBACK_PATH, DESKTOP_SETUP_LOCAL_ACTION } = await import('../../shared/desktop-setup-auth.js');
    const openedUrls: string[] = [];
    let currentTime = 1_700_000_000_000;
    const panel = await startRemoteDesktopLocalPanel({
      publicNodeId: '',
      serverUrl: '',
      port: 0,
      status: () => ({ paused: false, connections: [] }),
      setPaused: async () => {},
      stopAll: async () => {},
      disconnect: async () => false,
      setup: {
        prefilledRelayUrl: 'https://relay.example.com',
        existingDaemonBound: true,
        existingDaemonRelayUrl: 'https://relay.example.com',
        now: () => currentTime,
        stateTtlMs: 60_000,
        openBrowser: async (url) => {
          openedUrls.push(url);
          return true;
        },
        fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          expect(url).toBe('https://relay.example.com/api/auth/token-exchange');
          const sent = JSON.parse(String(init?.body ?? '{}')) as { nonce?: string };
          expect(sent.nonce).toBe('nonce-valid-1');
          const res = new Response(JSON.stringify({ apiKey: 'deck_exchanged_1', userId: 'u-1', keyId: 'k-1' }), { status: 200 });
          Object.defineProperty(res, 'url', { value: url });
          return res;
        }) as unknown as typeof fetch,
        bindRelayAndEnroll: vi.fn(async (relayOrigin, apiKey, onStep) => {
          expect(relayOrigin).toBe('https://relay.example.com');
          expect(apiKey).toBe('deck_exchanged_1');
          onStep('binding_daemon');
          onStep('enrolling_node');
          return {
            serverId: 'srv-ctrl-1',
            nodeId: '7778889990',
            token: 'node-tok-secret',
            serverUrl: 'https://relay.example.com',
            nodeRole: 'controlled',
          };
        }),
        onSetupComplete: async () => {
          panel.switchToRuntime({
            publicNodeId: '7778889990',
            serverUrl: 'https://relay.example.com',
            status: () => ({ paused: false, connections: [] }),
            setPaused: async () => {},
            stopAll: async () => {},
            disconnect: async () => false,
          });
        },
      },
    });
    created.push(panel);

    const origin = new URL(panel.url).origin;
    const home = await fetch(panel.url);
    expect(home.status).toBe(200);
    const html = await home.text();
    const cookie = (home.headers.get('set-cookie') ?? '').split(';')[0]!;
    const csrf = /"csrf":"([^"]+)"/u.exec(html)![1]!;

    // /api/state exposes setup status with prefilled relay URL
    const st1 = await (await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH, origin), { headers: { cookie } })).json() as {
      setup?: { setupRequired: boolean; prefilledRelayUrl: string; existingDaemonBound?: boolean };
    };
    expect(st1.setup).toMatchObject({
      setupRequired: true,
      prefilledRelayUrl: 'https://relay.example.com',
      existingDaemonBound: true,
    });

    // Wrong state on /setup/callback fails cleanly
    const badState = await fetch(new URL(`${DESKTOP_SETUP_CALLBACK_PATH}?nonce=nonce-valid-1&state=wrongstatewrongstate`, origin));
    expect(badState.status).toBe(400);

    // Start browser auth -> generates loopback callback state & opens relay login
    const startRes = await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.ACTION_PATH, origin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin,
        [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: csrf,
      },
      body: JSON.stringify({ action: DESKTOP_SETUP_LOCAL_ACTION.START_BROWSER_AUTH, relayUrl: 'https://relay.example.com' }),
    });
    expect(startRes.status).toBe(200);
    expect(openedUrls).toHaveLength(1);
    const loginUrl = new URL(openedUrls[0]!);
    const cbParam = new URL(loginUrl.searchParams.get('desktop_callback')!);
    expect(cbParam.origin).toBe(origin);
    expect(cbParam.pathname).toBe(DESKTOP_SETUP_CALLBACK_PATH);
    const state = cbParam.searchParams.get('state')!;
    expect(state.length).toBeGreaterThanOrEqual(16);

    // Mismatched state is rejected while pendingBrowserAuth stays armed
    const wrongState = await fetch(new URL(`${DESKTOP_SETUP_CALLBACK_PATH}?nonce=nonce-valid-1&state=${'x'.repeat(state.length)}`, origin));
    expect(wrongState.status).toBe(400);

    // Valid callback executes exchange -> bind/enroll -> switchToRuntime on exact same listening port
    const okCb = await fetch(new URL(`${DESKTOP_SETUP_CALLBACK_PATH}?nonce=nonce-valid-1&state=${encodeURIComponent(state)}`, origin));
    expect(okCb.status).toBe(200);
    expect(await okCb.text()).toContain('Connected to IM.codes');

    // Replay of the same state fails immediately (setup mode is already disarmed)
    const replayCb = await fetch(new URL(`${DESKTOP_SETUP_CALLBACK_PATH}?nonce=nonce-valid-1&state=${encodeURIComponent(state)}`, origin));
    expect(replayCb.status).toBe(404);

    // Same server now returns bound state without setup, plus manageUrl & shareUrl
    const st2 = await (await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH, origin), { headers: { cookie } })).json() as {
      publicNodeId: string;
      manageUrl?: string;
      shareUrl?: string;
      setup?: unknown;
    };
    expect(st2.publicNodeId).toBe('7778889990');
    expect(st2.setup).toBeUndefined();
    expect(st2.manageUrl).toContain('7778889990');
    expect(st2.shareUrl).toContain('7778889990');
  });

  it('supports manual <relay>/bind/<apiKey> binding and rejects invalid links', async () => {
    const { DESKTOP_SETUP_LOCAL_ACTION } = await import('../../shared/desktop-setup-auth.js');
    const bindSpy = vi.fn(async () => ({
      serverId: 'srv-manual-1',
      nodeId: '1020304050',
      token: 'tok-man',
      serverUrl: 'https://relay.example.com',
      nodeRole: 'controlled' as const,
    }));
    const panel = await startRemoteDesktopLocalPanel({
      publicNodeId: '',
      serverUrl: '',
      port: 0,
      status: () => ({ paused: false, connections: [] }),
      setPaused: async () => {},
      stopAll: async () => {},
      disconnect: async () => false,
      setup: {
        prefilledRelayUrl: 'https://app.im.codes',
        openBrowser: async () => false,
        bindRelayAndEnroll: bindSpy,
        onSetupComplete: async () => {
          panel.switchToRuntime({
            publicNodeId: '1020304050',
            serverUrl: 'https://relay.example.com',
            status: () => ({ paused: false, connections: [] }),
            setPaused: async () => {},
            stopAll: async () => {},
            disconnect: async () => false,
          });
        },
      },
    });
    created.push(panel);

    const origin = new URL(panel.url).origin;
    const home = await fetch(panel.url);
    const html = await home.text();
    const cookie = (home.headers.get('set-cookie') ?? '').split(';')[0]!;
    const csrf = /"csrf":"([^"]+)"/u.exec(html)![1]!;

    const badBind = await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.ACTION_PATH, origin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin,
        [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: csrf,
      },
      body: JSON.stringify({ action: DESKTOP_SETUP_LOCAL_ACTION.BIND_MANUAL, bindUrl: 'https://relay.example.com/not-bind' }),
    });
    expect(badBind.status).toBe(400);

    const goodBind = await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.ACTION_PATH, origin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin,
        [REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER]: csrf,
      },
      body: JSON.stringify({ action: DESKTOP_SETUP_LOCAL_ACTION.BIND_MANUAL, bindUrl: 'https://relay.example.com/bind/deck_manual_secret_99' }),
    });
    expect(goodBind.status).toBe(200);
    expect(bindSpy).toHaveBeenCalledWith('https://relay.example.com', 'deck_manual_secret_99', expect.any(Function));

    const st = await (await fetch(new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH, origin), { headers: { cookie } })).json() as {
      publicNodeId: string;
      setup?: unknown;
    };
    expect(st.publicNodeId).toBe('1020304050');
    expect(st.setup).toBeUndefined();
  });
});

