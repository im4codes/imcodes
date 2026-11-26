import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runNativeOrThrow } from '../spec/support/native-exec.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const AUTH_PLUGIN_PATH = join(REPO_ROOT, 'web/ios/App/App/AuthSessionPlugin.swift');

describe('iOS AuthSessionPlugin ASWebAuthenticationSession hardening', () => {
  it('resolves active UIWindowScene key window fallback and rejects failed session.start()', () => {
    const source = readFileSync(AUTH_PLUGIN_PATH, 'utf8');

    expect(source).toContain('session.prefersEphemeralWebBrowserSession = true');
    expect(source).toContain('if !session.start()');
    expect(source).toContain('self.session = nil');
    expect(source).toContain('call.reject("Failed to start authentication session")');
    expect(source).toContain('self.bridge?.webView?.window');
    expect(source).toContain('UIApplication.shared.connectedScenes');
    expect(source).toContain('activationState == .foregroundActive');
    expect(source).toContain('windows.first(where: { $0.isKeyWindow }) ?? activeScene?.windows.first');
  });

  it('typechecks AuthSessionPlugin.swift on macOS Catalyst and iOS Simulator SDKs', async () => {
    if (process.platform !== 'darwin') return;
    const tmpDir = mkdtempSync(join(tmpdir(), 'imcodes-auth-session-swift-'));
    try {
      const stubFile = join(tmpDir, 'CapacitorStubs.swift');
      const pluginFile = join(tmpDir, 'AuthSessionPlugin.swift');

      writeFileSync(stubFile, `
import Foundation
import UIKit
import WebKit

public let CAPPluginReturnPromise = "promise"
public struct CAPPluginMethod {
    public let name: String
    public let returnType: String
    public init(name: String, returnType: String) {
        self.name = name
        self.returnType = returnType
    }
}
public protocol CAPBridgedPlugin {
    var identifier: String { get }
    var jsName: String { get }
    var pluginMethods: [CAPPluginMethod] { get }
}
public class CAPPluginCall: NSObject {
    public func getString(_ key: String) -> String? { nil }
    public func resolve(_ data: [String: Any] = [:]) {}
    public func reject(_ message: String) {}
}
public protocol CAPBridgeProtocol: AnyObject {
    var webView: WKWebView? { get }
}
open class CAPPlugin: NSObject {
    public var bridge: CAPBridgeProtocol?
    public func notifyListeners(_ eventName: String, data: [String: Any]?) {}
}
`);

      const pluginSrc = readFileSync(AUTH_PLUGIN_PATH, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== 'import Capacitor')
        .join('\n');
      writeFileSync(pluginFile, pluginSrc);

      const macSdkPath = (await runNativeOrThrow('xcrun', ['--sdk', 'macosx', '--show-sdk-path'])).trim();
      await runNativeOrThrow('xcrun', [
        '--sdk', 'macosx',
        'swiftc',
        '-typecheck',
        '-target', 'arm64-apple-ios16.0-macabi',
        '-F', `${macSdkPath}/System/iOSSupport/System/Library/Frameworks`,
        stubFile,
        pluginFile,
      ]);

      const simSdkPath = (await runNativeOrThrow('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'])).trim();
      await runNativeOrThrow('xcrun', [
        '--sdk', 'iphonesimulator',
        'swiftc',
        '-typecheck',
        '-sdk', simSdkPath,
        '-target', 'arm64-apple-ios16.0-simulator',
        stubFile,
        pluginFile,
      ]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
