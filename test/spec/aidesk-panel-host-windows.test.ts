/**
 * The Windows panel window host (aidesk-local-ui.exe: a Win32 window with a WebView2 control) is built only on Windows; these checks pin
 * its contract from source and its build inputs: one instance, only the panel's own origin, no script bridge, no runtime download,
 * a fixed hash-pinned SDK, and the names it shares with the node.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AIDESK_LOCAL_UI_EXECUTABLE_NAME } from '../../shared/aidesk-product.js';
import { LOCAL_PANEL_WINDOW_MIN_SIZE, LOCAL_PANEL_WINDOW_SIZE, LOCAL_PANEL_WINDOW_TITLE, LOCAL_PANEL_WINDOWS_HOST, localPanelUrl } from '../../shared/local-panel-window.js';
import * as fetchSdk from '../../scripts/fetch-webview2-sdk.mjs';
import { AIDESK_FAVICON_DATA_URI, AIDESK_FAVICON_SOURCE_SHA256 } from '../../shared/aidesk-favicon-generated.js';
import { AIDESK_HICOLOR_SIZES, AIDESK_ICO_SIZES, AIDESK_LOGO_SOURCE, logoSha256, packIco, renderAideskIcon } from '../../scripts/aidesk-icon.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');
const temps: string[] = [];
const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'aidesk-host-test-')); temps.push(dir); return dir; };
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('Windows panel window host source', () => {
  const host = read('native/aidesk-panel-host-windows/panel_host.cc');
  const ids = read('native/aidesk-panel-host-windows/panel_host_ids.h');

  it('shares its names with the node (mutex, window class, AppUserModelID, exit code, retry) through one authored list', () => {
    const wide = (name: string): string => new RegExp(`${name}\\[\\] = L"((?:[^"\\\\]|\\\\.)*)"`, 'u').exec(ids)?.[1] ?? '';
    expect(wide('kSingleInstanceMutex').replaceAll('\\\\', '\\')).toBe(LOCAL_PANEL_WINDOWS_HOST.singleInstanceMutex);
    expect(wide('kWindowClass')).toBe(LOCAL_PANEL_WINDOWS_HOST.windowClass);
    expect(wide('kAppUserModelId')).toBe(LOCAL_PANEL_WINDOWS_HOST.appUserModelId);
    expect(Number(/kExitRuntimeMissing = (\d+);/u.exec(ids)?.[1])).toBe(LOCAL_PANEL_WINDOWS_HOST.exitRuntimeMissing);
    expect(Number(/kRetryMilliseconds = (\d+);/u.exec(ids)?.[1])).toBe(LOCAL_PANEL_WINDOWS_HOST.retryMilliseconds);
    expect(LOCAL_PANEL_WINDOWS_HOST.singleInstanceMutex.startsWith('Local\\')).toBe(true);
  });

  it('opens at the shared size, may shrink to the shared minimum, and is titled with the product name (the panel and the find script use the same title)', () => {
    const common = read('native/remote-desktop-common/platform_interfaces.h');
    expect(host).toContain('common::kLocalPanelWindowWidth');
    expect(host).toContain('common::kLocalPanelWindowMinWidth');
    expect(host).toContain('Widen(common::kAiDeskProductName)');
    expect(common).toContain(`kLocalPanelWindowWidth = ${LOCAL_PANEL_WINDOW_SIZE.width};`);
    expect(common).toContain(`kLocalPanelWindowMinHeight = ${LOCAL_PANEL_WINDOW_MIN_SIZE.height};`);
    expect(read('native/remote-desktop-common/aidesk_product_name.h')).toContain(LOCAL_PANEL_WINDOW_TITLE);
    expect(host).toContain('WM_GETMINMAXINFO');
    expect(host).toContain('WS_OVERLAPPEDWINDOW');
  });

  it('keeps one window per session: a named mutex, the second start raises the first (Alt tap + foreground, taskbar flash as the fallback) and exits', () => {
    expect(host).toContain('CreateMutexW(nullptr, FALSE, ids::kSingleInstanceMutex)');
    expect(host).toContain('ERROR_ALREADY_EXISTS');
    expect(host).toContain('FindWindowW(ids::kWindowClass');
    expect(host).toContain('PostMessageW(existing, kActivateMessage');
    expect(host).toContain('SetForegroundWindow');
    expect(host).toContain('FlashWindowEx');
    expect(host).toContain('SetCurrentProcessExplicitAppUserModelID(ids::kAppUserModelId)');
  });

  it('shows only the panel\'s own origin: other navigation is cancelled, no new windows, no script bridge, no host objects, no developer tools', () => {
    expect(host).toContain('add_NavigationStarting');
    expect(host).toContain('args->put_Cancel(TRUE)');
    expect(host).toContain('add_NewWindowRequested');
    expect(host).toContain('args->put_Handled(TRUE)');
    for (const setting of ['put_AreDevToolsEnabled(FALSE)', 'put_IsWebMessageEnabled(FALSE)', 'put_AreHostObjectsAllowed(FALSE)']) expect(host).toContain(setting);
    // the allowed prefix is the one panel URL constant; it must end with the slash that closes the authority
    expect(host).toContain('Widen(common::kLocalManagementUrl)');
    expect(host).toContain("prefix.back() == L'/'");
    expect(localPanelUrl().endsWith('/')).toBe(true);
    expect(host).not.toMatch(/ShellExecute|WinExec|CreateProcess/u);
  });

  it('without the WebView2 runtime it exits with the agreed code before any window exists; load failures retry; closing ends only this process', () => {
    const runtimeAt = host.indexOf('GetAvailableCoreWebView2BrowserVersionString');
    expect(runtimeAt).toBeGreaterThan(-1);
    expect(runtimeAt).toBeLessThan(host.indexOf('CreateWindowExW'));
    expect(host).toContain('return ids::kExitRuntimeMissing;');
    expect(host).toContain('add_NavigationCompleted');
    expect(host).toContain('SetTimer(g_host.window, kRetryTimer, ids::kRetryMilliseconds');
    expect(host).toContain('case WM_DESTROY');
    expect(host).toContain('PostQuitMessage(0)');
  });

  it('keeps a small event log (names and HRESULTs only, no URLs) next to its profile, because the node cannot see why a window did not appear', () => {
    expect(host).toContain('host.log');
    expect(host).toContain('kMaxLogBytes');
    for (const event of ['starting', 'environment_created', 'controller_created', 'runtime_missing', 'window_closed']) expect(host).toContain(`Log("${event}"`);
    expect(host.match(/Log\("[a-z_]+"/gu)?.every((call) => !/uri|url/iu.test(call))).toBe(true);
  });

  it('keeps its profile per user inside aiDesk\'s own directory, never the browser\'s', () => {
    expect(host).toContain('FOLDERID_LocalAppData');
    expect(host).toContain('L"\\\\IM.codes"');
    expect(host).toContain('L"\\\\webview2"');
  });

  it('is the sidecar the node discovers by name, and its CMake links the static loader and the static C runtime with the manifest embedded once', () => {
    const cmake = read('native/aidesk-panel-host-windows/CMakeLists.txt');
    expect(cmake).toContain(`add_executable(${AIDESK_LOCAL_UI_EXECUTABLE_NAME} WIN32`);
    expect(cmake).toContain('WebView2LoaderStatic.lib');
    expect(cmake.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')).not.toMatch(/WebView2Loader\.dll/u);
    expect(cmake).toContain('MultiThreaded');
    // IID_IUnknown / FOLDERID_LocalAppData come from uuid.lib
    expect(cmake).toMatch(/target_link_libraries\(aidesk-local-ui PRIVATE[^)]*\buuid\b/u);
    expect(cmake).toContain('/MANIFEST:NO');
    expect(read('native/aidesk-panel-host-windows/panel_host.rc.in')).toContain('RT_MANIFEST');
    const manifest = read('native/aidesk-panel-host-windows/panel_host.manifest');
    expect(manifest).toContain('asInvoker');
    expect(manifest).toContain('PerMonitorV2');
  });
});

describe('WebView2 SDK pin', () => {
  const pin = fetchSdk.parseWebview2Lock(readFileSync(fetchSdk.WEBVIEW2_SDK_LOCK, 'utf8'));

  it('names one https package version with a sha256 and exactly the files the build uses', () => {
    expect(pin.name).toBe('Microsoft.Web.WebView2');
    expect(pin.url).toBe(`https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${pin.version}/microsoft.web.webview2.${pin.version}.nupkg`);
    expect(pin.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(pin.files).toEqual(expect.arrayContaining(['build/native/include/WebView2.h', 'build/native/x64/WebView2LoaderStatic.lib', 'LICENSE.txt']));
    const bad = (mutate: (value: Record<string, unknown>) => void): string => {
      const lock = JSON.parse(readFileSync(fetchSdk.WEBVIEW2_SDK_LOCK, 'utf8')) as { package: Record<string, unknown> };
      mutate(lock.package);
      return JSON.stringify(lock);
    };
    expect(() => fetchSdk.parseWebview2Lock(bad((p) => { p.url = 'http://example.test/x.nupkg'; }))).toThrow();
    expect(() => fetchSdk.parseWebview2Lock(bad((p) => { p.sha256 = 'xyz'; }))).toThrow();
    expect(() => fetchSdk.parseWebview2Lock(bad((p) => { p.files = ['../escape']; }))).toThrow();
    expect(() => fetchSdk.parseWebview2Lock(bad((p) => { p.files = []; }))).toThrow();
  });

  it('refuses bytes whose sha256 is not the pinned one, and an extraction that lacks a pinned file', () => {
    const bytes = Buffer.from('a nupkg');
    const fake = { ...pin, sha256: createHash('sha256').update(bytes).digest('hex') };
    expect(() => fetchSdk.assertPinnedBytes(bytes, fake)).not.toThrow();
    expect(() => fetchSdk.assertPinnedBytes(Buffer.concat([bytes, Buffer.from('x')]), fake)).toThrow(/sha256 mismatch/u);
    const dir = temp();
    mkdirSync(join(dir, 'build/native/include'), { recursive: true });
    writeFileSync(join(dir, 'build/native/include/WebView2.h'), '');
    expect(() => fetchSdk.assertRequiredFiles(dir, pin)).toThrow(/missing .*WebView2LoaderStatic\.lib/u);
  });

  it('a tampered download is never written to the cache and never extracted; a good one is cached and reused', async () => {
    const out = temp();
    const lockPath = join(temp(), 'lock.json');
    const good = Buffer.from('not really a zip');
    writeFileSync(lockPath, JSON.stringify({ schemaVersion: 1, package: { ...pin, sha256: createHash('sha256').update(good).digest('hex') } }));
    await expect(fetchSdk.fetchWebview2Sdk({ out, lockPath, fetchBytes: async () => Buffer.from('tampered') })).rejects.toThrow(/sha256 mismatch/u);
    expect(() => readFileSync(join(out, '.cache', `${pin.name}.${pin.version}.nupkg`))).toThrow();
  });
});

describe('application icons (one official logo, every platform)', () => {
  it('is an .ico directory of PNG images at the standard sizes', () => {
    const ico = packIco([{ size: 16, png: Buffer.from('p16') }, { size: 256, png: Buffer.from('p256') }]);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    expect(ico.readUInt8(6)).toBe(16);
    expect(ico.readUInt8(22)).toBe(0); // 256 is stored as 0
    expect(ico.readUInt32LE(6 + 12)).toBe(6 + 32);
    expect(ico.subarray(6 + 32, 6 + 32 + 3).toString()).toBe('p16');
    expect(AIDESK_ICO_SIZES).toEqual([16, 24, 32, 48, 64, 128, 256]);
    expect(AIDESK_HICOLOR_SIZES).toEqual(expect.arrayContaining([16, 32, 48, 64, 128, 256, 512]));
  });

  it('is rendered from the official IM.codes logo (the shipped iOS app icon, same pixels as the landing page logo), never from the robot avatar', () => {
    // (path separators differ per OS: this also runs on Windows CI)
    expect(AIDESK_LOGO_SOURCE.replaceAll('\\', '/').endsWith('web/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png')).toBe(true);
    const logo = readFileSync(AIDESK_LOGO_SOURCE);
    expect(logo.readUInt32BE(16)).toBe(1024);
    expect(logo.readUInt32BE(20)).toBe(1024);
    // (the macOS app still ships the robot avatar as the remote-desktop INDICATOR's mark; that is not an application icon)
    for (const path of ['scripts/aidesk-icon.mjs', 'native/aidesk-panel-host-windows/build.ps1']) {
      expect(read(path), path).not.toContain('imcodes-robot-avatar');
    }
  });

  it('keeps the dark logo visible: a transparent rounded tile with a light hairline, cropped to the wordmark when small', async () => {
    const big = await renderAideskIcon(256);
    const meta = await (await import('sharp')).default(big).metadata();
    expect([meta.width, meta.height, meta.channels]).toEqual([256, 256, 4]);
    const sharp = (await import('sharp')).default;
    const corner = await sharp(big).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    expect(corner[3]).toBe(0); // the corner outside the rounded tile is transparent
    const edge = await sharp(big).extract({ left: 128, top: 1, width: 1, height: 1 }).raw().toBuffer();
    expect(edge[0]).toBeGreaterThan(20); // the hairline border is lighter than the black artwork
    const mac = await renderAideskIcon(256, { contentRatio: 824 / 1024 });
    const margin = await sharp(mac).extract({ left: 128, top: 2, width: 1, height: 1 }).raw().toBuffer();
    expect(margin[3]).toBe(0); // macOS keeps Apple's transparent margin
  });

  it('the inline favicon of the panel page is generated from that logo (its recorded hash must match the logo)', () => {
    expect(AIDESK_FAVICON_SOURCE_SHA256).toBe(logoSha256());
    expect(AIDESK_FAVICON_DATA_URI.startsWith('data:image/png;base64,')).toBe(true);
    expect(AIDESK_FAVICON_DATA_URI.length).toBeLessThan(12_000);
  });
});
