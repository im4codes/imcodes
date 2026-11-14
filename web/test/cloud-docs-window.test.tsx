/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import {
  buildCloudDocsWindowUrl,
  CLOUD_DOCS_QUOTE_CHANNEL,
  isCloudDocsStandaloneWindow,
  openCloudDocsWindow,
  publishCloudDocQuote,
  readCloudDocsWindowParams,
  subscribeCloudDocQuotes,
} from '../src/cloud-docs-window.js';
import { resetCloudDocsWindowNoticeForTests } from '../src/cloud-docs-window-notice.js';
import { CloudDocsWindowBlockedNotice } from '../src/components/CloudDocsWindowBlockedNotice.js';
import { hydrateStandaloneAuthFromStorage } from '../src/standalone-auth.js';
import * as api from '../src/api.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'cloud_docs.window_blocked': 'Your browser blocked the Cloud Docs window.',
      'cloud_docs.window_blocked_dismiss': 'Dismiss',
    })[key] ?? key,
  }),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const stylesCss = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetCloudDocsWindowNoticeForTests();
  vi.restoreAllMocks();
});

describe('cloud-docs-window helpers & blocked notice', () => {
  it('detects standalone query flag and parses valid optional params', () => {
    expect(isCloudDocsStandaloneWindow('')).toBe(false);
    expect(isCloudDocsStandaloneWindow('?cloudDocs=0')).toBe(false);
    expect(isCloudDocsStandaloneWindow('?cloudDocs=1')).toBe(true);
    expect(isCloudDocsStandaloneWindow('?cloudDocs=true')).toBe(true);

    expect(
      readCloudDocsWindowParams('?cloudDocs=1&cloudDocsTab=shared&cloudDocsFolder=fld-1&cloudDocsDoc=doc-9'),
    ).toEqual({
      tab: 'shared',
      folderId: 'fld-1',
      docId: 'doc-9',
    });

    expect(readCloudDocsWindowParams('?cloudDocs=1&cloudDocsTab=invalid&cloudDocsFolder=%20')).toEqual({});
  });

  it('builds clean standalone URLs stripping unrelated query and hash state', () => {
    const url = buildCloudDocsWindowUrl(
      { tab: 'my_docs', folderId: 'f1' },
      'https://app.im.codes/?remoteDesktopServer=srv-1#session=main',
    );
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://app.im.codes/');
    expect(parsed.searchParams.get('cloudDocs')).toBe('1');
    expect(parsed.searchParams.get('cloudDocsTab')).toBe('my_docs');
    expect(parsed.searchParams.get('cloudDocsFolder')).toBe('f1');
    expect(parsed.searchParams.get('remoteDesktopServer')).toBeNull();
    expect(parsed.hash).toBe('');
  });

  it('opens detached popup without noopener feature and severs opener on success', () => {
    const fakePopup = { opener: window } as unknown as Window;
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakePopup);

    const opened = openCloudDocsWindow({ tab: 'my_docs' });
    expect(opened).toBe(fakePopup);
    expect(fakePopup.opener).toBeNull();
    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, target, features] = openSpy.mock.calls[0]!;
    expect(String(url)).toContain('cloudDocs=1');
    expect(String(url)).toContain('cloudDocsTab=my_docs');
    expect(target).toBe('_blank');
    expect(features).toContain('popup=yes');
    expect(features).not.toContain('noopener');
  });

  it('publishes visible dismissible blocked notice when window.open returns null', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(<CloudDocsWindowBlockedNotice />);
    expect(screen.queryByTestId('cloud-docs-window-blocked')).toBeNull();

    let result: Window | null = null;
    act(() => {
      result = openCloudDocsWindow();
    });
    expect(result).toBeNull();

    const alert = screen.getByTestId('cloud-docs-window-blocked');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('Your browser blocked the Cloud Docs window.');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('cloud-docs-window-blocked')).toBeNull();
  });

  it('hydrates auth when rcc_auth is valid and falls back safely when missing or corrupted', () => {
    const configureSpy = vi.spyOn(api, 'configure').mockImplementation(() => {});
    const userSpy = vi.spyOn(api, 'configureExpectedUserId').mockImplementation(() => {});

    // Missing rcc_auth
    expect(() => hydrateStandaloneAuthFromStorage()).not.toThrow();
    expect(configureSpy).not.toHaveBeenCalled();
    expect(userSpy).not.toHaveBeenCalled();

    // Corrupted JSON
    localStorage.setItem('rcc_auth', '{not-json');
    expect(() => hydrateStandaloneAuthFromStorage()).not.toThrow();
    expect(configureSpy).not.toHaveBeenCalled();

    // Valid rcc_auth
    localStorage.setItem('rcc_auth', JSON.stringify({ baseUrl: 'https://hub.example', userId: 'u-42' }));
    hydrateStandaloneAuthFromStorage();
    expect(configureSpy).toHaveBeenCalledWith('https://hub.example');
    expect(userSpy).toHaveBeenCalledWith('u-42');
  });

  it('includes full-bleed standalone CSS rules for root and CloudDocsPanel', () => {
    expect(stylesCss).toContain('.cloud-docs-standalone-root');
    expect(stylesCss).toContain('.cloud-docs-panel.is-standalone');
  });

  it('routes ?cloudDocs=1 in main entrypoint without rcc_auth and renders standalone CloudDocsPanel', async () => {
    vi.resetModules();
    const renderSpy = vi.fn();
    vi.doMock('preact', async () => {
      const actual = await vi.importActual<typeof import('preact')>('preact');
      return { ...actual, render: renderSpy };
    });
    vi.doMock('../src/i18n/index.js', () => ({}));
    vi.doMock('../src/styles.css', () => ({}));
    vi.doMock('../src/app.js', () => ({ App: () => null }));
    vi.doMock('../src/components/CloudDocsPanel.js', () => ({ CloudDocsPanel: () => null }));
    vi.doMock('../src/pwa-install.js', () => ({
      ensureRemoteDesktopAppManifestLink: () => {},
      installPwaInstallCapture: () => {},
      isStandaloneDisplayMode: () => false,
    }));

    document.documentElement.className = '';
    const appRoot = document.createElement('div');
    appRoot.id = 'app';
    document.body.appendChild(appRoot);
    window.history.replaceState({}, '', '/?cloudDocs=1&cloudDocsTab=shared&cloudDocsFolder=fld-9&cloudDocsDoc=doc-7');

    await import('../src/main.js');

    expect(document.documentElement.classList.contains('cloud-docs-standalone-root')).toBe(true);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    const vnode = renderSpy.mock.calls[0]![0] as { props?: Record<string, unknown> };
    expect(vnode.props).toMatchObject({
      standalone: true,
      initialTab: 'shared',
      initialFolderId: 'fld-9',
      initialDocId: 'doc-7',
    });

    appRoot.remove();
    document.documentElement.className = '';
    window.history.replaceState({}, '', '/');
    vi.doUnmock('preact');
    vi.doUnmock('../src/i18n/index.js');
    vi.doUnmock('../src/styles.css');
    vi.doUnmock('../src/app.js');
    vi.doUnmock('../src/components/CloudDocsPanel.js');
    vi.doUnmock('../src/pwa-install.js');
    vi.resetModules();
  });

  it('publishes and subscribes Cloud Docs quotes across same-origin BroadcastChannel safely', () => {
    const channels = new Map<string, Set<(event: MessageEvent<unknown>) => void>>();
    const origBC = globalThis.BroadcastChannel;

    class MockBroadcastChannel {
      name: string;
      private listeners = new Set<(event: MessageEvent<unknown>) => void>();
      constructor(name: string) {
        this.name = name;
        if (!channels.has(name)) channels.set(name, new Set());
      }
      addEventListener(type: string, fn: (event: MessageEvent<unknown>) => void) {
        if (type !== 'message') return;
        this.listeners.add(fn);
        channels.get(this.name)!.add(fn);
      }
      removeEventListener(type: string, fn: (event: MessageEvent<unknown>) => void) {
        if (type !== 'message') return;
        this.listeners.delete(fn);
        channels.get(this.name)?.delete(fn);
      }
      postMessage(data: unknown) {
        for (const fn of channels.get(this.name) ?? []) {
          fn({ data } as MessageEvent<unknown>);
        }
      }
      close() {
        for (const fn of this.listeners) channels.get(this.name)?.delete(fn);
        this.listeners.clear();
      }
    }

    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
    try {
      const received: unknown[] = [];
      const unsubscribe = subscribeCloudDocQuotes((target) => {
        received.push(target);
      });

      expect(publishCloudDocQuote({ kind: 'cloud_doc', docId: 'd1', name: 'Spec.docx' })).toBe(true);
      expect(publishCloudDocQuote({ kind: 'server_file', path: '/repo/README.md', name: 'README.md', serverId: 's1' })).toBe(true);

      // Invalid messages on channel must be ignored
      const rawChannel = new MockBroadcastChannel(CLOUD_DOCS_QUOTE_CHANNEL);
      rawChannel.postMessage({ type: 'cloud_doc_quote', target: { kind: 'cloud_doc', docId: '', name: 'bad' } });
      rawChannel.postMessage({ type: 'other_event' });
      rawChannel.close();

      expect(received).toEqual([
        { kind: 'cloud_doc', docId: 'd1', name: 'Spec.docx' },
        { kind: 'server_file', path: '/repo/README.md', name: 'README.md', serverId: 's1' },
      ]);

      unsubscribe();
      expect(publishCloudDocQuote({ kind: 'cloud_doc', docId: 'd2', name: 'After.docx' })).toBe(true);
      expect(received).toHaveLength(2);
    } finally {
      vi.stubGlobal('BroadcastChannel', origBC);
    }
  });
});
