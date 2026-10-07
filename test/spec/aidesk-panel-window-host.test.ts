/**
 * The macOS aiDesk app shows the local management panel in its own window (a WKWebView), so the Dock, Cmd-Tab and the menu bar show
 * aiDesk's icon and name instead of a browser's. These checks pin the contract the native source (built only on macOS) must keep.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOCAL_PANEL_WINDOW_MIN_SIZE, LOCAL_PANEL_WINDOW_SIZE } from '../../shared/local-panel-window.js';
import { AIDESK_PANEL_HOST_PLIST_KEY } from '../../shared/aidesk-product.js';
import { AIDESK_ICONSET_ENTRIES, AIDESK_ICON_FILE, buildAideskInfoPlist } from '../../scripts/build-aidesk-app.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('macOS panel window host', () => {
  const host = read('native/macos-remote-desktop/aidesk_panel_window.mm');
  const common = read('native/remote-desktop-common/platform_interfaces.h');
  const main = read('native/macos-remote-desktop/aidesk_agent_main.mm');

  it('opens at the size the shared constant says and may be resized down to its minimum (one source for every host)', () => {
    const constant = (name: string): number => Number(new RegExp(`${name} = (\\d+);`, 'u').exec(common)?.[1]);
    expect(constant('kLocalPanelWindowWidth')).toBe(LOCAL_PANEL_WINDOW_SIZE.width);
    expect(constant('kLocalPanelWindowHeight')).toBe(LOCAL_PANEL_WINDOW_SIZE.height);
    expect(constant('kLocalPanelWindowMinWidth')).toBe(LOCAL_PANEL_WINDOW_MIN_SIZE.width);
    expect(constant('kLocalPanelWindowMinHeight')).toBe(LOCAL_PANEL_WINDOW_MIN_SIZE.height);
    expect(host).toContain('NSWindowStyleMaskResizable');
    expect(host).toContain('contentMinSize');
  });

  it('shows the panel\'s own origin and nothing else: navigation outside it is cancelled, no window is ever created, nothing is persisted', () => {
    expect(host).toContain('[WKWebsiteDataStore nonPersistentDataStore]');
    expect(host).toContain('decidePolicyForNavigationAction');
    expect(host).toContain('WKNavigationActionPolicyCancel');
    // the allowed origin is derived from the one panel URL constant (scheme, host and port), with no credentials
    expect(host).toContain('common::kLocalManagementUrl');
    expect(host).toMatch(/url\.user != nil \|\| url\.password != nil/u);
    expect(host).toMatch(/createWebViewWithConfiguration[\s\S]*return nil;/u);
    expect(host).not.toMatch(/openURL|NSWorkspace/u);
  });

  it('keeps one window, survives closing it, and the product name is the window title', () => {
    expect(host).toContain('if (self.window == nil) [self createWindow];');
    expect(host).toContain('windowWillClose');
    expect(host).toContain('window.title = @(common::kAiDeskProductName)');
    expect(host).toContain('releasedWhenClosed = NO');
    // nothing quits the application when the window closes
    expect(host).not.toContain('applicationShouldTerminateAfterLastWindowClosed');
  });

  it('has the key equivalents a web view needs (copy/paste/select all, close, minimize, quit) in the panel\'s seven languages', () => {
    for (const selector of ['cut:', 'copy:', 'paste:', 'selectAll:', 'performClose:', 'performMiniaturize:', 'terminate:']) expect(host).toContain(`@selector(${selector})`);
    for (const code of ['zh-Hans', 'zh-Hant', 'es', 'ru', 'ja', 'ko']) expect(host).toContain(`@"${code}"`);
  });

  it('the app shows it for a Dock/status-item/reopen click and for `--aidesk-open-panel`, without going through the node', () => {
    expect(main).toContain('macos::ShowLocalPanelWindow()');
    expect(main).toContain('applicationShouldHandleReopen');
    expect(main).toContain('--aidesk-open-panel');
    expect(main).not.toContain('RequestLocalManagementWindow');
  });

  it('is compiled into the app with WebKit, and the Info.plist declares the marker the node reads plus local-network ATS', () => {
    const packager = read('scripts/build-aidesk-app.mjs');
    expect(packager).toContain("join(source, 'aidesk_panel_window.mm')");
    expect(packager).toContain("'-framework', 'WebKit'");
    const plist = buildAideskInfoPlist({ version: '2026.10.1', minimumSystemVersion: '12.3' });
    expect(plist).toContain(`<key>${AIDESK_PANEL_HOST_PLIST_KEY}</key>\n  <true/>`);
    expect(plist).toContain('<key>NSAllowsLocalNetworking</key><true/>');
    expect(plist).not.toContain('NSAllowsArbitraryLoads');
  });

  it('the bundle has an application icon (CFBundleIconFile + an .icns made from the canonical logo), so the Dock shows aiDesk\'s mark and not the generic icon', () => {
    const plist = buildAideskInfoPlist({ version: '2026.10.1', minimumSystemVersion: '12.3' });
    expect(plist).toContain(`<key>CFBundleIconFile</key>\n  <string>${AIDESK_ICON_FILE}</string>`);
    expect(AIDESK_ICONSET_ENTRIES.map(([name]) => name)).toEqual(expect.arrayContaining(['icon_16x16', 'icon_512x512@2x']));
    expect(new Set(AIDESK_ICONSET_ENTRIES.map(([name]) => name)).size).toBe(AIDESK_ICONSET_ENTRIES.length);
    const packager = read('scripts/build-aidesk-app.mjs');
    expect(packager).toContain("'/usr/bin/iconutil', ['-c', 'icns'");
    expect(packager.indexOf('buildAideskIcns(join(bundlePath')).toBeLessThan(packager.indexOf('signAideskApp(bundlePath);\n  return bundlePath'));
  });
});
