/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const bridges = vi.hoisted(() => {
  const make = () => ({
    available: vi.fn(), requestPermissions: vi.fn(), start: vi.fn(), stop: vi.fn(), addListener: vi.fn(),
    listeners: {} as Record<string, (data: any) => void>, removals: [] as ReturnType<typeof vi.fn>[],
  });
  return { streaming: make(), platform: make() };
});
vi.mock('@capacitor/core', () => ({ registerPlugin: () => bridges.streaming }));
vi.mock('@capgo/capacitor-speech-recognition', () => ({ SpeechRecognition: bridges.platform }));
import { readFileSync } from 'node:fs';
import * as backend from '../src/voice-recognition-backend.js';
import * as input from '../src/components/VoiceInput.js';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('Capacitor', { isNativePlatform: () => true, isPluginAvailable: () => true });
  for (const bridge of [bridges.streaming, bridges.platform]) {
    bridge.listeners = {}; bridge.removals = [];
    bridge.available.mockReset().mockResolvedValue({ available: true });
    bridge.requestPermissions.mockReset().mockResolvedValue({ speechRecognition: 'granted' });
    bridge.start.mockReset().mockResolvedValue(undefined);
    bridge.stop.mockReset().mockResolvedValue(undefined);
    bridge.addListener.mockReset().mockImplementation(async (name, fn) => {
      bridge.listeners[name] = fn;
      const remove = vi.fn(async () => {}); bridge.removals.push(remove); return { remove };
    });
  }
});
afterEach(async () => { await input.stopListening(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('multilingual plugin session ownership', () => {
  it('stops and drains the original plugin even if bridge availability changes', async () => {
    const onResult = vi.fn(); expect(await input.startListening(onResult)).toBe(true);
    const oldPartial = bridges.streaming.listeners.partialResults, oldState = bridges.streaming.listeners.listeningState;
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, isPluginAvailable: () => false });
    let release!: () => void; bridges.streaming.stop.mockReturnValueOnce(new Promise<void>(resolve => { release = resolve; }));
    const stopping = input.stopListening(); oldPartial({ matches: ['最后 hello'], isFinal: true });
    expect(onResult).toHaveBeenLastCalledWith('最后 hello', true); release(); await stopping;
    expect(bridges.streaming.stop).toHaveBeenCalledTimes(1); expect(bridges.platform.stop).not.toHaveBeenCalled();
    expect(bridges.streaming.removals.every(remove => remove.mock.calls.length === 1)).toBe(true);
    const next = vi.fn(); expect(await input.startListening(next)).toBe(true);
    oldPartial({ matches: ['stale'] }); oldState({ status: 'stopped' });
    expect(next).not.toHaveBeenCalled(); expect(input.isListening()).toBe(true);
  });
  it('does not spawn a recognizer after a pending permission check is cancelled', async () => {
    let release!: (value: { speechRecognition: string }) => void;
    bridges.streaming.requestPermissions.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const starting = input.startListening(vi.fn());
    await vi.waitFor(() => expect(bridges.streaming.requestPermissions).toHaveBeenCalledTimes(1));
    const stopping = input.stopListening(); release({ speechRecognition: 'granted' });
    expect(await starting).toBe(false); await stopping; expect(bridges.streaming.start).not.toHaveBeenCalled();
  });
});

function read(relative: string): string { return readFileSync(new URL(relative, import.meta.url), 'utf8'); }
function plist(relative: string): any {
  const document = new DOMParser().parseFromString(read(relative), 'application/xml');
  expect(document.querySelector('parsererror')).toBeNull();
  function value(node: Element): any {
    if (node.tagName === 'dict') {
      const children = [...node.children]; const result: Record<string, unknown> = {};
      for (let i=0;i<children.length;i+=2) { expect(children[i].tagName).toBe('key'); result[children[i].textContent!] = value(children[i+1]); }
      return result;
    }
    if (node.tagName === 'array') return [...node.children].map(value);
    if (node.tagName === 'integer') return Number(node.textContent);
    if (node.tagName === 'true' || node.tagName === 'false') return node.tagName === 'true';
    return node.textContent;
  }
  return value(document.documentElement.children[0]);
}

describe('iOS localized Action extension and shared Inbox handoff', () => {
  const localizations = { en:'Send to IM.codes', 'zh-Hans':'发送到 IM.codes', 'zh-Hant':'傳送到 IM.codes', ja:'IM.codes に送信', ko:'IM.codes로 보내기', es:'Enviar a IM.codes', ru:'Отправить в IM.codes' };
  it('declares a vertical Action extension with bounded file/image/movie/URL activation and the correct App Group', () => {
    const info = plist('../ios/App/ShareActionExtension/Info.plist');
    expect(info.CFBundleDisplayName).toBe('Send to IM.codes');
    expect(info.CFBundleLocalizations).toEqual(Object.keys(localizations));
    expect(info.NSExtension.NSExtensionPointIdentifier).toBe('com.apple.ui-services');
    expect(info.NSExtension.NSExtensionPrincipalClass).toBe('$(PRODUCT_MODULE_NAME).ShareActionViewController');
    expect(info.NSExtension.NSExtensionAttributes.NSExtensionActivationRule).toEqual({ NSExtensionActivationSupportsFileWithMaxCount:10, NSExtensionActivationSupportsImageWithMaxCount:10, NSExtensionActivationSupportsMovieWithMaxCount:5, NSExtensionActivationSupportsWebURLWithMaxCount:1 });
    expect(plist('../ios/App/ShareActionExtension/ShareActionExtension.entitlements')['com.apple.security.application-groups']).toEqual(['group.com.im.codes']);
    const app = plist('../ios/App/App/Info.plist'); expect(app.CFBundleDocumentTypes[0].CFBundleTypeRole).toBe('Viewer'); expect(app.CFBundleLocalizations).toEqual(Object.keys(localizations));
  });
  it.each(Object.entries(localizations))('packages %s display name and truthful cannot-open fallback', (locale, label) => {
    const strings = read('../ios/App/ShareActionExtension/' + locale + '.lproj/InfoPlist.strings');
    expect(strings).toContain('"CFBundleDisplayName" = "' + label + '";');
    for (const key of ['share.openApp', 'share.done', 'share.error']) expect(strings).toContain('"' + key + '" = "');
    const project = read('../ios/App/App.xcodeproj/project.pbxproj'); expect(project).toContain(locale + '.lproj/InfoPlist.strings');
  });
  it('embeds the extension as a dependency with source/resource/config/signing references', () => {
    const project = read('../ios/App/App.xcodeproj/project.pbxproj');
    const ids = [...project.matchAll(/^\s*([A-F0-9]{24}) \/\*.*?\*\/ = \{/gm)].map(match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const text of ['ShareActionExtension.appex', 'com.apple.product-type.app-extension', 'Embed App Extensions', 'dstSubfolderSpec = 13', 'com.im.codes.ShareAction', 'APPLICATION_EXTENSION_API_ONLY = YES', 'ShareActionExtension/ShareActionExtension.entitlements', 'PRODUCT_BUNDLE_IDENTIFIER = com.im.codes.ShareAction', 'MARKETING_VERSION = 1.2']) expect(project).toContain(text);
    const extension = read('../ios/App/ShareActionExtension/ShareActionViewController.swift');
    expect(extension).toContain('loadFileRepresentation'); expect(extension).toContain('copyItem(at: source');
    expect(extension).toContain('moveItem(at: staging'); expect(extension).toContain('extensionContext?.open');
    expect(extension).toContain('if opened'); expect(extension).toContain('share.openApp');
    expect(extension).not.toContain('UIApplication.shared'); expect(extension).not.toContain('performSelector');
  });
  it('drains both inboxes after launch/foreground/URL and keeps unpublished or unreadable files safe', () => {
    const app = read('../ios/App/App/AppDelegate.swift'), receiver = read('../ios/App/App/AuthSessionPlugin.swift');
    expect(app).toContain('url.host?.lowercased() == "share-inbox"');
    expect(app.match(/drainInboxFilesIfNeeded\(\)/g)!.length).toBeGreaterThanOrEqual(4);
    for (const text of ['appendingPathComponent("Inbox"', 'appendingPathComponent("SharedInbox"', '.skipsHiddenFiles', 'inboxScanScheduled', 'info.isSymbolicLink != true', 'isManagedInboxFile(url)', 'var consumed = false', 'drainInboxFilesIfNeeded()']) expect(receiver).toContain(text);
    expect(receiver).toContain('if full { return }'); expect(receiver).toContain('call.resolve(["items": items])');
  });
});
