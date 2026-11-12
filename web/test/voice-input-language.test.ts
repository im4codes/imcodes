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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    for (const text of ['ShareActionExtension.appex', 'com.apple.product-type.app-extension', 'Embed App Extensions', 'dstSubfolderSpec = 13', 'com.im.codes.ShareAction', 'APPLICATION_EXTENSION_API_ONLY = YES', 'ShareActionExtension/ShareActionExtension.entitlements', 'PRODUCT_BUNDLE_IDENTIFIER = com.im.codes.ShareAction', 'MARKETING_VERSION = 1.2']) expect(project).toContain(text);
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
    for (const text of ['root.lastPathComponent == "SharedInbox"', 'info.isDirectory == true', 'file.deletingLastPathComponent().standardizedFileURL == root.standardizedFileURL', 'file.lastPathComponent.hasPrefix(".pending-")', 'files.skipDescendants()']) expect(receiver).toContain(text);
    expect(receiver).toContain('if full { return }'); expect(receiver).toContain('call.resolve(["items": items])');
  });
});

// Execute the production receiver, not a JS reimplementation of admission/cleanup.
// Linux uses an explicitly supplied Swift toolchain; macOS uses Apple's wrapper.
const swiftCompiler = process.env.SWIFTC || (existsSync('/usr/bin/swiftc') ? '/usr/bin/swiftc' : '');
describe.skipIf(!swiftCompiler)('native Inbox capacity and progress protocol', () => {
  let root: string, executable: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'voice-share-inbox-'));
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
