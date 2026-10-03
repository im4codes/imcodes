import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { REMOTE_DESKTOP_ACCESS_MODE } from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_LOCAL_ACTION,
  REMOTE_DESKTOP_LOCAL_MANAGEMENT,
} from '../../shared/remote-desktop-local-management.js';
import {
  applyRemoteDesktopAccessPaused,
  loadRemoteDesktopAccessPaused,
  persistRemoteDesktopAccessPaused,
} from '../../src/node/remote-desktop-access-state.js';
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

  it('contains a two-step stop confirmation and live duration refresh in the shared client', async () => {
    const panel = await startRemoteDesktopLocalPanel({
      publicNodeId: '1234567890', serverUrl: 'https://example.test/',
      status: () => ({ paused: false, connections: [] }),
      setPaused: async () => {}, stopAll: async () => {}, disconnect: async () => false,
      port: 0,
    });
    panels.push(panel);
    const html = await (await fetch(panel.url)).text();
    expect(html).toContain('E.stop.onclick=()=>ask(B.actions.STOP_ALL)');
    expect(html).toContain('E.confirmAction.onclick=()=>');
    expect(html).toContain('setInterval(tick,1000)');
  });

  it('runs the rendered client without relying on named-window element globals', async () => {
    const panel = await startRemoteDesktopLocalPanel({
      publicNodeId: '1234567890', serverUrl: 'https://example.test/',
      status: () => ({ paused: false, connections: [] }),
      setPaused: async () => {}, stopAll: async () => {}, disconnect: async () => false,
      port: 0,
    });
    panels.push(panel);
    const html = await (await fetch(panel.url)).text();
    const clientConnections = [{
      id: 'opaque-one', label: '#1', connectedAt: Date.now() - 2_000,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
    }];
    const fetchClient = vi.fn(async () => ({
      ok: true,
      json: async () => ({ publicNodeId: '1234567890', paused: false, connections: clientConnections }),
    }));
    const dom = new JSDOM(html, {
      url: panel.url,
      runScripts: 'dangerously',
      beforeParse(window) {
        Object.defineProperty(window, 'fetch', { configurable: true, value: fetchClient });
        Object.defineProperty(window.navigator, 'clipboard', {
          configurable: true,
          value: { writeText: vi.fn(async () => {}) },
        });
        window.HTMLDialogElement.prototype.showModal = function showModal() {
          this.setAttribute('open', '');
        };
        window.HTMLDialogElement.prototype.close = function close() {
          this.removeAttribute('open');
        };
      },
    });
    try {
      await vi.waitFor(() => expect(dom.window.document.getElementById('status')?.textContent)
        .toBe('1 active connection(s)'));
      const duration = dom.window.document.querySelector('[data-since]') as HTMLElement;
      expect(duration.textContent).toBe('00:02');
      dom.window.Date.now = () => clientConnections[0]!.connectedAt + 65_000;
      dom.window.eval('tick()');
      expect(duration.textContent).toBe('01:05');

      const disconnect = dom.window.document.querySelector('.connection button') as HTMLButtonElement;
      disconnect.click();
      expect(dom.window.document.getElementById('confirm')?.hasAttribute('open')).toBe(true);
      expect(fetchClient.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
      (dom.window.document.getElementById('cancel') as HTMLButtonElement).click();
      disconnect.click();
      (dom.window.document.getElementById('confirmAction') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(fetchClient.mock.calls.some(([, init]) => (
        init?.method === 'POST'
        && JSON.parse(String(init.body)).action === REMOTE_DESKTOP_LOCAL_ACTION.DISCONNECT
        && JSON.parse(String(init.body)).id === 'opaque-one'
      ))).toBe(true));
      await vi.waitFor(() => expect(fetchClient.mock.calls.filter(([url, init]) => (
        url === REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH && init?.method === undefined
      ))).toHaveLength(2));
      (dom.window.document.getElementById('stop') as HTMLButtonElement).click();
      expect(dom.window.document.getElementById('confirm')?.hasAttribute('open')).toBe(true);
      expect(fetchClient.mock.calls.some(([, init]) => (
        init?.method === 'POST'
        && JSON.parse(String(init.body)).action === REMOTE_DESKTOP_LOCAL_ACTION.STOP_ALL
      ))).toBe(false);
      (dom.window.document.getElementById('confirmAction') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(fetchClient.mock.calls.some(([, init]) => (
        init?.method === 'POST'
        && JSON.parse(String(init.body)).action === REMOTE_DESKTOP_LOCAL_ACTION.STOP_ALL
      ))).toBe(true));
      await vi.waitFor(() => expect(fetchClient.mock.calls.filter(([url, init]) => (
        url === REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH && init?.method === undefined
      ))).toHaveLength(3));
      expect(fetchClient).toHaveBeenCalledWith('/api/state', { cache: 'no-store' });
    } finally {
      dom.window.close();
    }
  });
});
