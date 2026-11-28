/** @vitest-environment jsdom */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const bridges = vi.hoisted(() => {
  const make = () => ({
    available: vi.fn(), requestPermissions: vi.fn(), start: vi.fn(), stop: vi.fn(), addListener: vi.fn(),
    listeners: {} as Record<string, (data: any) => void>, removals: [] as ReturnType<typeof vi.fn>[],
  });
  return { streaming: make(), platform: make() };
});
vi.mock('@capacitor/core', () => ({ registerPlugin: () => bridges.streaming }));
vi.mock('@capgo/capacitor-speech-recognition', () => ({ SpeechRecognition: bridges.platform }));
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as backend from '../src/voice-recognition-backend.js';
import * as input from '../src/components/VoiceInput.js';

beforeEach(() => {
  localStorage.clear();
  input.setVoiceRecognitionEngine('builtin');
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

  it('follows the user-selected app language in pickLocale and pickWebLocale before falling back to navigator.language', async () => {
    vi.stubGlobal('navigator', { language: 'en-US' });
    localStorage.setItem('imcodes_lang', 'ja');
    expect(input.pickLocale()).toBe('ja-JP');
    expect(input.pickWebLocale()).toBe('ja-JP');

    localStorage.setItem('imcodes_lang', 'zh-TW');
    expect(input.pickLocale()).toBe('zh-Hant');
    expect(input.pickWebLocale()).toBe('zh-TW');

    localStorage.setItem('imcodes_lang', 'zh-CN');
    expect(input.pickLocale()).toBe('zh-Hans');
    expect(input.pickWebLocale()).toBe('zh-CN');

    localStorage.setItem('imcodes_lang', 'ko');
    expect(input.pickLocale()).toBe('ko-KR');
    expect(input.pickWebLocale()).toBe('ko-KR');

    localStorage.setItem('imcodes_lang', 'es');
    expect(input.pickLocale()).toBe('es-ES');

    localStorage.setItem('imcodes_lang', 'ru');
    expect(input.pickLocale()).toBe('ru-RU');

    localStorage.setItem('imcodes_lang', 'ja');
    expect(await input.startListening(vi.fn())).toBe(true);
    expect(bridges.streaming.start).toHaveBeenCalledWith(expect.objectContaining({ language: 'ja-JP' }));
  });

  it('uses browser navigator locale instead of empty string or <html lang> in Web Speech auto mode while keeping native auto unconstrained', async () => {
    const prevDocLang = document.documentElement.lang;
    document.documentElement.lang = 'en';
    localStorage.setItem('imcodes_lang', 'en');
    try {
      vi.stubGlobal('navigator', { languages: ['zh-Hans-CN', 'en-US'], language: 'zh-CN' });
      expect(input.pickWebAutoLocale()).toBe('zh-CN');
      vi.stubGlobal('navigator', { languages: ['zh-TW'], language: 'zh-TW' });
      expect(input.pickWebAutoLocale()).toBe('zh-TW');
      vi.stubGlobal('navigator', { languages: ['fr-FR'], language: 'fr-FR' });
      expect(input.pickWebAutoLocale()).toBe('fr-FR');

      // Native StreamingSpeech in auto mode still omits language for on-device auto-detect.
      input.setVoiceLanguageMode('auto');
      expect(input.pickRecognitionLocale()).toBeUndefined();
      expect(await input.startListening(vi.fn())).toBe(true);
      expect(bridges.streaming.start).toHaveBeenCalledTimes(1);
      expect(bridges.streaming.start.mock.calls[0][0]).not.toHaveProperty('language');
      await input.stopListening();

      // Web Speech API in auto mode must resolve from navigator.languages/navigator.language,
      // never passing '' (which inherits <html lang="en">).
      const instances: Array<{ lang?: string; onstart?: () => void; onend?: () => void; start: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> }> = [];
      class MockWebSpeech {
        lang = '';
        continuous = false;
        interimResults = false;
        maxAlternatives = 1;
        onstart?: () => void;
        onend?: () => void;
        start = vi.fn(() => { queueMicrotask(() => this.onstart?.()); });
        stop = vi.fn(() => { queueMicrotask(() => this.onend?.()); });
        abort = vi.fn(() => { queueMicrotask(() => this.onend?.()); });
        constructor() { instances.push(this); }
      }
      vi.stubGlobal('Capacitor', { isNativePlatform: () => false });
      vi.stubGlobal('SpeechRecognition', MockWebSpeech as any);
      vi.stubGlobal('navigator', { languages: ['zh-CN', 'en-US'], language: 'zh-CN' });

      expect(await input.startListening(vi.fn())).toBe(true);
      expect(instances).toHaveLength(1);
      expect(instances[0].lang).toBe('zh-CN');
      await input.stopListening();

      // In follow mode, Web Speech still follows imcodes_lang ('ja' -> 'ja-JP').
      localStorage.setItem('imcodes_lang', 'ja');
      input.setVoiceLanguageMode('follow');
      expect(await input.startListening(vi.fn())).toBe(true);
      expect(instances).toHaveLength(2);
      expect(instances[1].lang).toBe('ja-JP');
    } finally {
      document.documentElement.lang = prevDocLang;
    }
  });

  it('strictly prioritizes custom offline StreamingSpeech and falls back to platform SpeechRecognition only when StreamingSpeech is unavailable or fails to start', async () => {
    localStorage.setItem('imcodes_lang', 'ja');
    // 1. When StreamingSpeech is available, platform recognizer is never touched
    expect(await input.startListening(vi.fn())).toBe(true);
    expect(bridges.streaming.start).toHaveBeenCalledTimes(1);
    expect(bridges.platform.start).not.toHaveBeenCalled();
    await input.stopListening();

    // 2. When StreamingSpeech.available() returns false, falls back to platform recognizer
    bridges.streaming.available.mockResolvedValueOnce({ available: false });
    bridges.platform.available.mockResolvedValueOnce({ available: true });
    const onResult = vi.fn();
    expect(await input.startListening(onResult)).toBe(true);
    expect(bridges.platform.start).toHaveBeenCalledTimes(1);
    expect(bridges.platform.start).toHaveBeenCalledWith(expect.objectContaining({ language: 'ja-JP' }));
    bridges.platform.listeners.partialResults?.({ matches: ['日本語 test'], isFinal: true });
    expect(onResult).toHaveBeenCalledWith('日本語 test', true);
    await input.stopListening();

    // 3. When StreamingSpeech.start() rejects with model/init error, falls back to platform recognizer
    bridges.streaming.start.mockRejectedValueOnce(new Error('Offline speech model missing'));
    bridges.platform.available.mockResolvedValueOnce({ available: true });
    expect(await input.startListening(vi.fn())).toBe(true);
    expect(bridges.platform.start).toHaveBeenCalledTimes(2);
    await input.stopListening();

    // 4. Unset imcodes_lang with hardcoded <html lang="en"> must still prefer Chinese navigator.language over <html lang>
    const prevDocLang = document.documentElement.lang;
    try {
      localStorage.removeItem('imcodes_lang');
      document.documentElement.lang = 'en';
      vi.stubGlobal('navigator', { languages: ['zh-CN', 'en-US'], language: 'zh-CN' });
      expect(input.pickLocale()).toBe('zh-Hans');
      expect(input.pickRecognitionLocale()).toBe('zh-Hans');

      // 5. In auto mode, fallback to platform recognizer still passes system locale instead of defaulting Android ASR to en-US
      input.setVoiceLanguageMode('auto');
      expect(input.pickRecognitionLocale()).toBeUndefined();
      bridges.streaming.available.mockResolvedValueOnce({ available: false });
      bridges.platform.available.mockResolvedValueOnce({ available: true });
      expect(await input.startListening(vi.fn())).toBe(true);
      expect(bridges.platform.start).toHaveBeenLastCalledWith(expect.objectContaining({ language: 'zh-CN' }));
      await input.stopListening();
    } finally {
      document.documentElement.lang = prevDocLang;
      input.setVoiceLanguageMode('follow');
    }
  });

  it('keeps all 7 locale files synchronized for all voice keys including recognizing, buffering, and hold-to-talk HUD prompts', () => {
    const locales = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'ru'];
    const requiredKeys = [
      'listening', 'paused', 'speak_now', 'voice_input', 'stop_voice', 'send',
      'mic_permission_failed', 'error', 'retry', 'recognizing', 'buffering_hint',
      'hold_to_talk', 'release_to_send', 'slide_left_cancel', 'slide_right_edit',
      'release_to_cancel', 'release_to_edit',
    ];
    const baseKeys = Object.keys(JSON.parse(read('../src/i18n/locales/en.json')).voice).sort();
    for (const locale of locales) {
      const data = JSON.parse(read(`../src/i18n/locales/${locale}.json`));
      expect(Object.keys(data.voice).sort()).toEqual(baseKeys);
      for (const key of requiredKeys) {
        expect(typeof data.voice[key]).toBe('string');
        expect(data.voice[key].trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('uses a 15s native start timeout, falls back immediately while downloading, and awaits primary stop before starting fallback', async () => {
    expect(input.NATIVE_START_TIMEOUT_MS).toBe(15_000);

    // 1. When StreamingSpeech reports downloading=true / available=false, fall back immediately without waiting on StreamingSpeech.start()
    bridges.streaming.available.mockResolvedValueOnce({ available: false, downloading: true, progress: 0.42 } as any);
    bridges.platform.available.mockResolvedValueOnce({ available: true });
    expect(await input.startListening(vi.fn())).toBe(true);
    expect(bridges.streaming.start).not.toHaveBeenCalled();
    expect(bridges.platform.start).toHaveBeenCalledTimes(1);
    await input.stopListening();

    // Reset cached downloading fallback before exercising the 15s primary start() timeout scenario.
    input.setVoiceRecognitionEngine('builtin');

    // 2. When StreamingSpeech.start() times out at 15s, fallback must wait for StreamingSpeech.stop() before starting platform recognizer
    vi.useFakeTimers();
    try {
      let releasePrimaryStop!: () => void;
      bridges.streaming.start.mockReturnValueOnce(new Promise(() => {}));
      bridges.streaming.stop.mockReturnValueOnce(new Promise<void>((resolve) => { releasePrimaryStop = resolve; }));
      bridges.platform.available.mockResolvedValueOnce({ available: true });

      const startPromise = input.startListening(vi.fn());
      await vi.advanceTimersByTimeAsync(input.NATIVE_START_TIMEOUT_MS);
      await vi.waitFor(() => expect(bridges.streaming.stop).toHaveBeenCalledTimes(1));
      expect(bridges.platform.start).toHaveBeenCalledTimes(1);

      releasePrimaryStop();
      await expect(startPromise).resolves.toBe(true);
      expect(bridges.platform.start).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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
    const rule = info.NSExtension.NSExtensionAttributes.NSExtensionActivationRule;
    expect(typeof rule).toBe('string');
    expect(rule).toContain('SUBQUERY');
    expect(rule).not.toContain('TRUEPREDICATE');
    for (const uti of ['public.item', 'public.text', 'public.url', 'public.image', 'public.movie', 'public.file-url']) {
      expect(rule).toContain(uti);
    }
    expect(plist('../ios/App/ShareActionExtension/ShareActionExtension.entitlements')['com.apple.security.application-groups']).toEqual(['group.com.im.codes']);
    const app = plist('../ios/App/App/Info.plist'); expect(app.CFBundleDocumentTypes[0].CFBundleTypeRole).toBe('Viewer'); expect(app.CFBundleLocalizations).toEqual(Object.keys(localizations)); expect(app.UIBackgroundModes).toContain('remote-notification'); expect(app.UIBackgroundModes).not.toContain('audio');
  });
  it.each(Object.entries(localizations))('packages %s display name and truthful notification + completion strings', (locale, label) => {
    const strings = read('../ios/App/ShareActionExtension/' + locale + '.lproj/InfoPlist.strings');
    expect(strings).toContain('"CFBundleDisplayName" = "' + label + '";');
    for (const key of ['share.notificationBody', 'share.openApp', 'share.done', 'share.error']) expect(strings).toContain('"' + key + '" = "');
    expect(strings).not.toContain('"share.openNow"');
    const project = read('../ios/App/App.xcodeproj/project.pbxproj'); expect(project).toContain(locale + '.lproj/InfoPlist.strings');
  });
  it('embeds the extension as a dependency with source/resource/config/signing references', () => {
    const project = read('../ios/App/App.xcodeproj/project.pbxproj');
    const ids = [...project.matchAll(/^\s*([A-F0-9]{24}) \/\*.*?\*\/ = \{/gm)].map(match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const text of ['ShareActionExtension.appex', 'com.apple.product-type.app-extension', 'Embed App Extensions', 'dstSubfolderSpec = 13', 'com.im.codes.ShareAction', 'APPLICATION_EXTENSION_API_ONLY = YES', 'ShareActionExtension/ShareActionExtension.entitlements', 'PRODUCT_BUNDLE_IDENTIFIER = com.im.codes.ShareAction', 'MARKETING_VERSION = 1.4']) expect(project).toContain(text);
    const extension = read('../ios/App/ShareActionExtension/ShareActionViewController.swift');
    expect(extension).toContain('loadFileRepresentation'); expect(extension).toContain('copyItem(at: source');
    expect(extension).toContain('moveItem(at: staging'); expect(extension).toContain('UNUserNotificationCenter.current()');
    expect(extension).toContain('share.notificationBody'); expect(extension).toContain('share.openApp');
    expect(extension).toContain('share.done'); expect(extension).toContain('completeRequest(returningItems: nil)');
    expect(extension).not.toContain('openHostApp');
    expect(extension).not.toContain('UIApplication.shared'); expect(extension).not.toContain('performSelector');
  });
  it('drains both inboxes after launch/foreground/URL and keeps unpublished or unreadable files safe', () => {
    const app = read('../ios/App/App/AppDelegate.swift'), receiver = read('../ios/App/App/AuthSessionPlugin.swift');
    expect(app).toContain('url.host?.lowercased() == "share-inbox"');
    expect(app.match(/drainInboxFilesIfNeeded\(\)/g)!.length).toBeGreaterThanOrEqual(4);
    for (const text of ['appendingPathComponent("Inbox"', 'appendingPathComponent("SharedInbox"', 'inboxScanScheduled', 'info.isSymbolicLink != true', 'isManagedInboxFile(url)', 'var consumed = false', 'drainInboxFilesIfNeeded(retryFailures:']) expect(receiver).toContain(text);
    expect(receiver).not.toContain('.skipsHiddenFiles'); // Hidden attachments such as .env must survive.
    for (const text of ['root.lastPathComponent == "SharedInbox"', 'info.isDirectory == true', 'let standardizedRoot = root.standardizedFileURL', 'file.deletingLastPathComponent().standardizedFileURL == standardizedRoot', 'file.lastPathComponent.hasPrefix(".pending-")', 'files.skipDescendants()']) expect(receiver).toContain(text);
    expect(receiver).toContain('if full { return }'); expect(receiver).toContain('call.resolve(["items": items])');
  });
});

// Execute the production receiver, not a JS reimplementation of admission/cleanup.
// Linux uses an explicitly supplied Swift toolchain; macOS uses Apple's wrapper.
const swiftCompiler = process.env.SWIFTC || (existsSync('/usr/bin/swiftc') ? '/usr/bin/swiftc' : '');
describe.skipIf(!swiftCompiler)('native Inbox capacity and progress protocol', () => {
  let root: string, executable: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'voice-share-inbox-')));
    executable = join(root, 'inbox-tests');
    const source = process.env.VOICE_INBOX_SOURCE ? readFileSync(process.env.VOICE_INBOX_SOURCE, 'utf8') : read('../ios/App/App/AuthSessionPlugin.swift');
    const receiver = source.slice(source.indexOf('@objc(ShareReceiverPlugin)'))
      .replace(/@objc\([^)]*\)\s*/g, '').replace(/@objc\s+/g, '')
      // Platform-directory and file-read adapters only: the receiver's lock,
      // admission, scan, enqueue, consume, dedupe and cleanup code is unchanged.
      .replace('FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)', '[URL(fileURLWithPath: fixtureRoot + "/Documents")]')
      .replace('FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.com.im.codes")', 'Optional(URL(fileURLWithPath: fixtureRoot + "/group"))')
      .replace('try? Data(contentsOf: url, options: [.mappedIfSafe])', 'try? fixtureRead(url)');
    const file = join(root, 'Inbox.swift');
    writeFileSync(file, swiftPeers + receiver + swiftCases);
    execFileSync(swiftCompiler, ['-swift-version', '5', file, '-o', executable], { encoding: 'utf8', timeout: 60000 });
  }, 65000);
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
  it.each(['oversize-progress', 'read-failure-progress', 'concurrent-admission', 'ordinary-overflow', 'bridge-not-ready', 'error-only-bounded-retry', 'hidden-and-staging'])('%s', (scenario) => {
    const directory = mkdtempSync(join(root, scenario + '-'));
    expect(execFileSync(executable, [scenario, directory], { encoding: 'utf8', timeout: 10000 }).trim()).toBe(scenario + ':PASS');
  });
});

const swiftPeers = `
import Foundation
public let CAPPluginReturnPromise = "promise"
public protocol CAPBridgedPlugin {}
public struct CAPPluginMethod { public init(name: String, returnType: String) {} }
public class WebView { public func evaluateJavaScript(_ code: String, completionHandler: ((Any?, Error?) -> Void)? = nil) {} }
public class Bridge { public var webView: WebView? = nil }
public class CAPPlugin { public var bridge: Bridge? = nil; public func notifyListeners(_ name: String, data: [String: Any]) {} }
public class CAPPluginCall { public var value: [String: Any] = [:]; public func resolve(_ value: [String: Any]) { self.value = value } }
public struct UTType { public init?(filenameExtension: String) {}; public var preferredMIMEType: String? { "application/octet-stream" } }
#if os(Linux)
extension URL { func startAccessingSecurityScopedResource() -> Bool { false }; func stopAccessingSecurityScopedResource() {} }
#endif
let fixtureRoot = CommandLine.arguments[2]
let readLock = NSLock(), readEntered = DispatchSemaphore(value: 0), readReleased = DispatchSemaphore(value: 0)
var gatedPath = "", readCounts: [String: Int] = [:]
func fixtureRead(_ url: URL) throws -> Data {
    readLock.lock(); readCounts[url.path, default: 0] += 1; let gate = url.path == gatedPath; readLock.unlock()
    if gate { readEntered.signal(); guard readReleased.wait(timeout: .now() + 3) == .success else { throw NSError(domain: "read gate timeout", code: 1) } }
    if url.lastPathComponent.hasPrefix("unreadable-") { throw NSError(domain: "injected read fault", code: 1) }
    return try Data(contentsOf: url, options: [.mappedIfSafe])
}
`;
const swiftCases = `
func require(_ value: Bool, _ message: String) {
    if !value { FileHandle.standardError.write(Data((message + "\\n").utf8)); exit(1) }
}
let fm = FileManager.default
let docs = URL(fileURLWithPath: fixtureRoot + "/Documents/Inbox", isDirectory: true)
let group = URL(fileURLWithPath: fixtureRoot + "/group/SharedInbox", isDirectory: true)
try fm.createDirectory(at: docs, withIntermediateDirectories: true)
try fm.createDirectory(at: group, withIntermediateDirectories: true)
func create(_ name: String, in directory: URL = docs, oversized: Bool = false) throws -> URL {
    try fm.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent(name)
    try Data("retained content".utf8).write(to: file)
    if oversized { let handle = try FileHandle(forWritingTo: file); try handle.truncate(atOffset: UInt64(ShareReceiverPlugin.maxShareBytes + 1)); try handle.close() }
    return file
}
func settle(_ receiver: ShareReceiverPlugin) {
    let queue = Mirror(reflecting: receiver).children.first { $0.label == "inboxWorker" }!.value as! DispatchQueue
    queue.sync {}; queue.sync {}
}
func consume(_ receiver: ShareReceiverPlugin) -> [[String: Any]] {
    let call = CAPPluginCall(); receiver.consumePendingShares(call); settle(receiver)
    return call.value["items"] as! [[String: Any]]
}
func names(_ items: [[String: Any]]) -> Set<String> {
    Set(items.flatMap { ($0["files"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String } })
}
let receiver = ShareReceiverPlugin(), scenario = CommandLine.arguments[1]
switch scenario {
case "oversize-progress":
    for i in 0..<20 { require(receiver.handleIncomingFileURL(try create("large-" + String(i), oversized: true)), "oversize rejected") }
    let valid = try create("valid.txt"); receiver.drainInboxFilesIfNeeded(); settle(receiver)
    let errors = consume(receiver); require(errors.count == 20 && errors.allSatisfy { $0["error"] as? String == "file_too_large" }, "oversize notices lost")
    require(names(consume(receiver)) == ["valid.txt"], "error-only oversize consumption did not refill valid backlog")
    require(!fm.fileExists(atPath: valid.path), "accepted valid source not cleaned")
case "read-failure-progress":
    for i in 0..<20 { require(receiver.handleIncomingFileURL(try create("unreadable-" + String(i))), "read failure not reported") }
    _ = try create("valid-after-fault.txt"); receiver.drainInboxFilesIfNeeded(); settle(receiver)
    require(consume(receiver).count == 20, "missing read errors")
    require(names(consume(receiver)) == ["valid-after-fault.txt"], "retained read errors blocked later valid file")
    require((try fm.contentsOfDirectory(atPath: docs.path)).count == 20, "read failure sources were deleted")
case "concurrent-admission":
    for i in 0..<19 { require(receiver.handleIncomingFileURL(try create("seed-" + String(i))), "seed not admitted") }
    let scan = try create("scan.txt"); readLock.lock(); gatedPath = scan.path; readLock.unlock()
    receiver.drainInboxFilesIfNeeded(); require(readEntered.wait(timeout: .now() + 3) == .success, "scanner did not reach read gate")
    let outside = URL(fileURLWithPath: fixtureRoot + "/external", isDirectory: true)
    let direct = try create("direct.txt", in: outside)
    let accepted = receiver.handleIncomingFileURL(direct)
    readReleased.signal(); settle(receiver)
    let batch = consume(receiver)
    require(batch.count == 20 && names(batch).contains("seed-0") && names(batch).contains("scan.txt"), "concurrent producer evicted accepted payload")
    require(!accepted && fm.fileExists(atPath: direct.path), "full temporary URL must be explicitly refused with source intact")
    require(receiver.handleIncomingFileURL(direct), "refused URL cannot retry after capacity release")
    require(names(consume(receiver)) == ["direct.txt"], "retry payload lost")
case "ordinary-overflow":
    for i in 0..<21 { _ = try create("ordinary-" + String(i)) }
    receiver.drainInboxFilesIfNeeded(); settle(receiver)
    let first = consume(receiver), second = consume(receiver)
    require(first.count == 20 && second.count == 1 && names(first + second).count == 21, "21 files not delivered in bounded batches")
    require((try fm.contentsOfDirectory(atPath: docs.path)).isEmpty, "accepted sources remain")
case "bridge-not-ready":
    for i in 0..<20 { require(receiver.handleIncomingFileURL(try create("held-" + String(i))), "held payload not admitted") }
    let overflow = try create("held-20")
    require(!receiver.handleIncomingFileURL(overflow) && fm.fileExists(atPath: overflow.path), "overflow lost before bridge was ready")
    let first = consume(receiver), second = consume(receiver)
    require(first.count == 20 && names(first).contains("held-0") && names(second) == ["held-20"], "unconsumed payload was evicted or backlog lost")
case "error-only-bounded-retry":
    let failed = try create("unreadable-one"); require(receiver.handleIncomingFileURL(failed), "error not admitted")
    require(consume(receiver).count == 1, "missing error")
    for _ in 0..<4 { require(consume(receiver).isEmpty, "automatic repeated read error") }
    require(readCounts[failed.path] == 1 && fm.fileExists(atPath: failed.path), "error-only consumption spun or deleted source")
    receiver.drainInboxFilesIfNeeded(); settle(receiver)
    require(consume(receiver).count == 1 && readCounts[failed.path] == 2, "explicit activation cannot retry read failure")
case "hidden-and-staging":
    let pending = group.appendingPathComponent(".pending-unpublished", isDirectory: true)
    _ = try create("unpublished.txt", in: pending)
    _ = try create(".env", in: group); _ = try create(".pending-regular-file", in: group)
    receiver.drainInboxFilesIfNeeded(); settle(receiver)
    require(names(consume(receiver)) == [".env", ".pending-regular-file"], "hidden files skipped or staging exposed")
    require(fm.fileExists(atPath: pending.appendingPathComponent("unpublished.txt").path), "unpublished staging consumed")
default: fatalError("unknown scenario")
}
print(scenario + ":PASS")
`;

describe('bounded offline cumulative committed + unfixed snapshots', () => {
  it('replaces corrections, suppresses duplicate partials, and accepts the identical final once', async () => {
    const result = vi.fn();
    await input.startListening(result);
    const partial = bridges.streaming.listeners.partialResults;
    partial({ matches: ['第一句。第二句结尾错'] });
    partial({ matches: ['第一句。第二句结尾错'] });
    partial({ matches: ['第一句。第二句结尾'] }); // rollback may shorten the unfixed suffix
    partial({ matches: ['第一句。第二句结尾'], isFinal: true });
    partial({ matches: ['late stale hypothesis'] });
    partial({ matches: ['duplicate final'], isFinal: true });
    expect(result.mock.calls).toEqual([
      ['第一句。第二句结尾错', false], ['第一句。第二句结尾', false], ['第一句。第二句结尾', true],
    ]);
  });
  it('holds a restart behind stop flush, then rejects old partial/final callbacks', async () => {
    const previous = vi.fn(), next = vi.fn();
    await input.startListening(previous);
    const oldPartial = bridges.streaming.listeners.partialResults;
    let release!: () => void;
    bridges.streaming.stop.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      oldPartial({ matches: ['locked sentence. final short tail'], isFinal: true });
    });
    const stop = input.stopListening();
    const restart = input.startListening(next);
    await Promise.resolve();
    expect(bridges.streaming.start).toHaveBeenCalledTimes(1);
    oldPartial({ matches: ['locked sentence. final shor'] });
    release(); await stop; expect(await restart).toBe(true);
    expect(previous).toHaveBeenLastCalledWith('locked sentence. final short tail', true);
    expect(next).not.toHaveBeenCalled();
    oldPartial({ matches: ['old capture'], isFinal: true });
    bridges.streaming.listeners.partialResults({ matches: ['new capture'] });
    expect(next.mock.calls).toEqual([['new capture', false]]);
  });
  it('delivers an empty final and ignores malformed snapshots without poisoning the session', async () => {
    const result = vi.fn(); await input.startListening(result);
    const partial = bridges.streaming.listeners.partialResults;
    partial({ matches: [null], isFinal: true });
    partial({ matches: [] });
    partial({ matches: [''], isFinal: true });
    expect(result.mock.calls).toEqual([['', true]]);
  });
});

describe('voice recognition engine preference & cache switching', () => {
  it('clears prewarm cache on engine switch so next prewarm/start resolves the newly selected engine', async () => {
    expect(input.canSwitchVoiceEngine()).toBe(true);
    await input.prewarm({ requestPermission: true });
    expect(bridges.streaming.requestPermissions).toHaveBeenCalledTimes(1);
    expect(bridges.platform.requestPermissions).not.toHaveBeenCalled();

    input.setVoiceRecognitionEngine('system');
    await input.prewarm({ requestPermission: true });
    expect(bridges.platform.requestPermissions).toHaveBeenCalledTimes(1);

    expect(await input.startListening(vi.fn())).toBe(true);
    expect(bridges.platform.start).toHaveBeenCalledTimes(1);
    expect(bridges.streaming.start).not.toHaveBeenCalled();
  });

  it('prevents an in-flight prewarm from poisoning cache after switching engines', async () => {
    let releaseAvail!: (v: { available: boolean }) => void;
    bridges.streaming.available.mockReturnValueOnce(new Promise((resolve) => { releaseAvail = resolve; }));

    const firstPrewarm = input.prewarm({ requestPermission: false });
    await vi.waitFor(() => expect(bridges.streaming.available).toHaveBeenCalledTimes(1));

    input.setVoiceRecognitionEngine('system');
    const secondPrewarm = input.prewarm({ requestPermission: false });
    releaseAvail({ available: true });

    await Promise.all([firstPrewarm, secondPrewarm]);
    expect(bridges.platform.available).toHaveBeenCalledTimes(1);
  });

  it('does not silently swap back to StreamingSpeech when system mode fails or is unavailable', async () => {
    input.setVoiceRecognitionEngine('system');
    bridges.platform.start.mockRejectedValueOnce(new Error('system recognizer unavailable'));
    const onError = vi.fn();
    expect(await input.startListening(vi.fn(), undefined, onError)).toBe(false);
    expect(bridges.streaming.start).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('system recognizer unavailable');
  });

  it('does not prompt fallback permissions during passive prewarm({ requestPermission: false }) when StreamingSpeech is unavailable', async () => {
    bridges.streaming.available.mockResolvedValueOnce({ available: false });
    await input.prewarm({ requestPermission: false });
    expect(bridges.streaming.requestPermissions).not.toHaveBeenCalled();
    expect(bridges.platform.requestPermissions).not.toHaveBeenCalled();
  });

  it('reports canSwitchVoiceEngine false when offline plugin is unavailable or on non-native browsers', () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, isPluginAvailable: () => false });
    expect(input.canSwitchVoiceEngine()).toBe(false);
    vi.stubGlobal('Capacitor', undefined);
    expect(input.canSwitchVoiceEngine()).toBe(false);
  });

  it('bounds stopListening() during unsettled start (!captureStarted) without stalling 20s and unlocks immediate retry', async () => {
    vi.useFakeTimers();
    try {
      // Hung platform.start() + hung platform.stop() while !captureStarted
      bridges.streaming.available.mockResolvedValueOnce({ available: false, downloading: true } as any);
      bridges.platform.start.mockReturnValueOnce(new Promise(() => {}));
      bridges.platform.stop.mockReturnValueOnce(new Promise(() => {}));

      const startPending = input.startListening(vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      expect(bridges.platform.start).toHaveBeenCalledTimes(1);

      // Release hold-to-talk before captureStarted becomes true -> stopListening must finish at NATIVE_UNSTARTED_STOP_DRAIN_MS (2s), NOT 20s
      let stopSettled = false;
      const stopPromise = input.stopListening().then(() => { stopSettled = true; });
      await vi.advanceTimersByTimeAsync(input.NATIVE_UNSTARTED_STOP_DRAIN_MS);
      await stopPromise;
      expect(stopSettled).toBe(true);
      await expect(startPending).resolves.toBe(false);

      // Subsequent press must start cleanly without waiting 20s behind _pendingStop
      bridges.platform.start.mockResolvedValueOnce(undefined);
      await expect(input.startListening(vi.fn())).resolves.toBe(true);
      expect(bridges.platform.start).toHaveBeenCalledTimes(2);
      await input.stopListening();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still allows up to NATIVE_STOP_DRAIN_MS (20s) for normal stopListening after captureStarted', async () => {
    vi.useFakeTimers();
    try {
      let releaseStop!: () => void;
      const onResult = vi.fn();
      await expect(input.startListening(onResult)).resolves.toBe(true);
      bridges.streaming.stop.mockReturnValueOnce(new Promise<void>((resolve) => { releaseStop = resolve; }));

      let stopSettled = false;
      const stopPromise = input.stopListening().then(() => { stopSettled = true; });
      await vi.advanceTimersByTimeAsync(16_000);
      expect(stopSettled).toBe(false);

      bridges.streaming.listeners.partialResults?.({ matches: ['late qwen3 final'], isFinal: true });
      releaseStop();
      await stopPromise;
      expect(stopSettled).toBe(true);
      expect(onResult).toHaveBeenLastCalledWith('late qwen3 final', true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows up to PC_APP_FINALIZE_DRAIN_MS (46s) even when mobile preference is system, and forwards post-stop abort:true to PC App', async () => {
    vi.stubGlobal('Capacitor', undefined);
    // Saved mobile recognizer preference = 'system' must NOT shrink PC App Qwen 46s drain budget!
    input.setVoiceRecognitionEngine('system');
    let resolveStopFalse!: () => void;
    let pcSub: ((ev: any) => void) | null = null;
    const stopCalls: Array<{ abort?: boolean }> = [];
    (globalThis as any).__IMCODES_PC_APP__ = {
      platform: 'win32',
      voice: {
        isNativeSpeechSupported: () => true,
        getPermissions: vi.fn(async () => ({ mic: 'granted', speech: 'granted' })),
        requestPermissions: vi.fn(async () => ({ mic: 'granted', speech: 'granted' })),
        getSpeechModelStatus: vi.fn(async () => ({ selectedModel: 'qwen3-0.6b', activeBackend: 'qwen3-0.6b', state: 'ready' })),
        startListening: vi.fn(async () => ({ ok: true })),
        stopListening: vi.fn((opts?: { abort?: boolean }) => {
          stopCalls.push(opts ?? {});
          if (opts?.abort) {
            resolveStopFalse?.();
            return Promise.resolve();
          }
          return new Promise<void>((resolve) => {
            resolveStopFalse = resolve;
          });
        }),
        subscribe: (fn: (ev: any) => void) => { pcSub = fn; return () => { pcSub = null; }; },
      },
    };
    vi.useFakeTimers();
    try {
      // 1) Slow 30s+ Qwen final drain succeeds even with mobile preference = 'system'
      const onResult = vi.fn();
      expect(await input.startListening(onResult)).toBe(true);
      let stopSettled = false;
      const stopPromise = input.stopListening().then(() => { stopSettled = true; });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(stopSettled).toBe(false);

      pcSub?.({ type: 'result', text: 'Windows 慢速完整终解', isFinal: true });
      pcSub?.({ type: 'end' });
      resolveStopFalse();
      await stopPromise;
      expect(stopSettled).toBe(true);
      expect(onResult).toHaveBeenLastCalledWith('Windows 慢速完整终解', true);
      expect(stopCalls).toEqual([{ abort: false }]);

      // 2) Renderer calls stopListening() -> still waiting for final decode -> stopListening({ abort: true }) MUST forward { abort: true } to PC bridge!
      stopCalls.length = 0;
      const onAbortResult = vi.fn();
      expect(await input.startListening(onAbortResult)).toBe(true);
      let firstStopDone = false;
      const inflightStop = input.stopListening().then(() => { firstStopDone = true; });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(firstStopDone).toBe(false);
      await input.stopListening({ abort: true });
      await inflightStop;
      expect(stopCalls).toEqual([{ abort: false }, { abort: true }]);
    } finally {
      vi.useRealTimers();
      delete (globalThis as any).__IMCODES_PC_APP__;
    }
  });

  it('caches SpeechRecognition fallback while StreamingSpeech is downloading and surfaces fallback errors clearly', async () => {
    // 1. First press probes StreamingSpeech (downloading) -> falls back to platform SpeechRecognition and caches it in _prewarmCache
    bridges.streaming.available.mockResolvedValueOnce({ available: false, downloading: true, progress: 0.25 } as any);
    bridges.platform.available.mockResolvedValueOnce({ available: true });
    expect(await input.startListening(vi.fn())).toBe(true);
    expect(bridges.streaming.requestPermissions).toHaveBeenCalledTimes(1);
    expect(bridges.streaming.available).toHaveBeenCalledTimes(1);
    expect(bridges.platform.requestPermissions).toHaveBeenCalledTimes(1);
    expect(bridges.platform.available).toHaveBeenCalledTimes(1);
    expect(bridges.platform.start).toHaveBeenCalledTimes(1);
    await input.stopListening();

    // 2. Second press reuses cached fallback without re-probing StreamingSpeech.available or SpeechRecognition.requestPermissions
    expect(await input.startListening(vi.fn())).toBe(true);
    expect(bridges.streaming.requestPermissions).toHaveBeenCalledTimes(1);
    expect(bridges.streaming.available).toHaveBeenCalledTimes(1);
    expect(bridges.platform.requestPermissions).toHaveBeenCalledTimes(1);
    expect(bridges.platform.available).toHaveBeenCalledTimes(1);
    expect(bridges.platform.start).toHaveBeenCalledTimes(2);
    await input.stopListening();

    // 3. Fallback availability error surfaces clearly rather than misleading 'Offline speech model unavailable'
    input.setVoiceRecognitionEngine('builtin');
    bridges.streaming.available.mockResolvedValueOnce({ available: false, downloading: true } as any);
    bridges.platform.available.mockRejectedValueOnce(new Error('SFSpeechRecognizer unavailable on device'));
    const onError = vi.fn();
    expect(await input.startListening(vi.fn(), undefined, onError)).toBe(false);
    expect(onError).toHaveBeenCalledWith('SFSpeechRecognizer unavailable on device');
  });

  it('does not pause muted video elements when starting voice input, while still pausing unmuted video and audio', async () => {
    const mutedVideo = document.createElement('video');
    mutedVideo.muted = true;
    Object.defineProperty(mutedVideo, 'paused', { configurable: true, value: false });
    const mutedVideoPause = vi.spyOn(mutedVideo, 'pause').mockImplementation(() => {});

    const defaultMutedVideo = document.createElement('video');
    defaultMutedVideo.defaultMuted = true;
    Object.defineProperty(defaultMutedVideo, 'paused', { configurable: true, value: false });
    const defaultMutedVideoPause = vi.spyOn(defaultMutedVideo, 'pause').mockImplementation(() => {});

    const unmutedVideo = document.createElement('video');
    Object.defineProperty(unmutedVideo, 'paused', { configurable: true, value: false });
    const unmutedVideoPause = vi.spyOn(unmutedVideo, 'pause').mockImplementation(() => {});

    const audio = document.createElement('audio');
    Object.defineProperty(audio, 'paused', { configurable: true, value: false });
    const audioPause = vi.spyOn(audio, 'pause').mockImplementation(() => {});

    document.body.append(mutedVideo, defaultMutedVideo, unmutedVideo, audio);
    try {
      expect(await input.startListening(vi.fn())).toBe(true);
      expect(mutedVideoPause).not.toHaveBeenCalled();
      expect(defaultMutedVideoPause).not.toHaveBeenCalled();
      expect(unmutedVideoPause).toHaveBeenCalledTimes(1);
      expect(audioPause).toHaveBeenCalledTimes(1);
      await input.stopListening();
    } finally {
      mutedVideo.remove();
      defaultMutedVideo.remove();
      unmutedVideo.remove();
      audio.remove();
    }
  });
});

describe('active voice service tracking & formatting', () => {
  it('tracks built-in model and updates live on fallback to platform system recognizer', async () => {
    const seen: Array<input.ActiveVoiceServiceInfo | null> = [];
    const unsub = input.subscribeActiveVoiceService((info) => seen.push(info));
    try {
      expect(await input.startListening(vi.fn())).toBe(true);
      expect(input.getActiveVoiceService()).toEqual({ kind: 'local_builtin' });
      expect(input.formatActiveVoiceServiceLabel(input.getActiveVoiceService(), (k) => k, true)).toBe('voice.engine_builtin');
      await input.stopListening();
      expect(input.getActiveVoiceService()).toBeNull();

      bridges.streaming.available.mockResolvedValueOnce({ available: false });
      expect(await input.startListening(vi.fn())).toBe(true);
      expect(input.getActiveVoiceService()).toEqual({ kind: 'local_system', isFallback: true });
      expect(input.formatActiveVoiceServiceLabel(input.getActiveVoiceService(), (k) => k, true))
        .toBe('voice.engine_apple (voice.service_fallback_tag)');
      expect(input.formatActiveVoiceServiceLabel(input.getActiveVoiceService(), (k) => k, false))
        .toBe('voice.engine_system (voice.service_fallback_tag)');
      await input.stopListening();
      expect(seen.some((entry) => entry?.kind === 'local_builtin')).toBe(true);
      expect(seen.some((entry) => entry?.kind === 'local_system' && entry.isFallback === true)).toBe(true);
    } finally {
      unsub();
    }
  });

  it('tracks PC App local speech models (1.7B, 0.6B, system), blocks stale system status overwrite, and preserves 25s final drain', async () => {
    vi.stubGlobal('Capacitor', undefined);
    let resolveFirstStatus!: (status: any) => void;
    let releaseSlowStop!: () => void;
    let deferStop = true;
    let pcSub: ((ev: any) => void) | null = null;
    const getSpeechModelStatus = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstStatus = resolve; }))
      .mockImplementationOnce(async () => ({ selectedModel: 'qwen3-0.6b', activeBackend: 'qwen3-0.6b', state: 'ready' }))
      .mockImplementationOnce(async () => ({ selectedModel: 'system', activeBackend: 'system', state: 'ready' }));

    (globalThis as any).__IMCODES_PC_APP__ = {
      platform: 'darwin',
      isElectron: true,
      voice: {
        isNativeSpeechSupported: () => true,
        getPermissions: vi.fn(async () => ({ mic: 'granted', speech: 'granted' })),
        requestPermissions: vi.fn(async () => ({ mic: 'granted', speech: 'granted' })),
        startListening: vi.fn(async () => ({ ok: true })),
        stopListening: vi.fn(() => (deferStop
          ? new Promise<void>((resolve) => { releaseSlowStop = resolve; })
          : Promise.resolve())),
        getSpeechModelStatus,
        subscribe: (fn: (ev: any) => void) => { pcSub = fn; return () => { pcSub = null; }; },
      },
    };

    try {
      // Session 1 starts while system status is slow; stop and immediately start Session 2 with 0.6B
      await input.startListening(vi.fn());
      await input.stopListening({ abort: true });
      const onSession2Result = vi.fn();
      await input.startListening(onSession2Result);
      await vi.waitFor(() => {
        expect(input.getActiveVoiceService()).toEqual({ kind: 'local_pc_model', label: 'Qwen3-ASR 0.6B' });
      });

      // Stale status response from Session 1 ('system') arrives LATE:
      // must NOT overwrite Session 2 label OR shrink Session 2 drain below 25s!
      resolveFirstStatus({ selectedModel: 'system', activeBackend: 'system', state: 'ready' });
      await Promise.resolve();
      await Promise.resolve();
      expect(input.getActiveVoiceService()).toEqual({ kind: 'local_pc_model', label: 'Qwen3-ASR 0.6B' });

      vi.useFakeTimers();
      try {
        let settled = false;
        const stopP = input.stopListening().then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(25_000);
        expect(settled).toBe(false);
        pcSub?.({ type: 'result', text: '乱序后25秒终解成功', isFinal: true });
        pcSub?.({ type: 'end' });
        releaseSlowStop();
        await stopP;
        expect(settled).toBe(true);
        expect(onSession2Result).toHaveBeenLastCalledWith('乱序后25秒终解成功', true);
      } finally {
        vi.useRealTimers();
      }

      deferStop = false;
      await input.startListening(vi.fn());
      await vi.waitFor(() => {
        expect(input.getActiveVoiceService()).toEqual({ kind: 'local_pc_model' });
      });
      expect(input.formatActiveVoiceServiceLabel(input.getActiveVoiceService(), (k) => k, true)).toBe('voice.engine_system');
      await input.stopListening();
    } finally {
      await input.stopListening({ abort: true });
      delete (globalThis as any).__IMCODES_PC_APP__;
    }
  });

  it('tracks browser Web Speech API and preserves active service when adopting a primed gesture', async () => {
    vi.stubGlobal('Capacitor', undefined);
    class FakeWebSpeech {
      lang = '';
      continuous = false;
      interimResults = false;
      maxAlternatives = 1;
      onstart: (() => void) | null = null;
      onaudiostart: (() => void) | null = null;
      onresult: ((ev: unknown) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        this.onstart?.();
      }
      stop() {
        this.onend?.();
      }
      abort() {
        this.onend?.();
      }
    }
    vi.stubGlobal('SpeechRecognition', FakeWebSpeech);

    expect(input.primeVoiceGesture({ deferAudioPause: true })).toBe(true);
    expect(input.getActiveVoiceService()).toEqual({ kind: 'local_web' });
    expect(await input.startListening(vi.fn())).toBe(true);
    expect(input.getActiveVoiceService()).toEqual({ kind: 'local_web' });
    expect(input.formatActiveVoiceServiceLabel(input.getActiveVoiceService(), (k) => k, false)).toBe('voice.engine_web');
    await input.stopListening();
    expect(input.getActiveVoiceService()).toBeNull();
  });
});
