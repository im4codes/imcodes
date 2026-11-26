import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runNativeOrThrow } from '../spec/support/native-exec.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const IOS_APP_ROOT = join(REPO_ROOT, 'web/ios/App');
const APP_DIR = join(IOS_APP_ROOT, 'App');

describe('iOS UIScene lifecycle migration for iPhone Duo / foldables', () => {
  it('declares UIApplicationSceneManifest in Info.plist with single-scene resizable Main storyboard config', () => {
    const plist = readFileSync(join(APP_DIR, 'Info.plist'), 'utf8');
    expect(plist).toContain('<key>UIApplicationSceneManifest</key>');
    expect(plist).toContain('<key>UIApplicationSupportsMultipleScenes</key>');
    expect(plist).toMatch(/<key>UIApplicationSupportsMultipleScenes<\/key>\s*<false\/>/);
    expect(plist).toContain('<key>UIWindowSceneSessionRoleApplication</key>');
    expect(plist).toContain('<string>Default Configuration</string>');
    expect(plist).toContain('<string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>');
    expect(plist).toContain('<string>Main</string>');
    // Must stay resizable for live fold/unfold and Split View transitions
    expect(plist).not.toMatch(/<key>UIRequiresFullScreen<\/key>\s*<true\/>/);
  });

  it('implements SceneDelegate.swift forwarding lifecycle, URL/activity handoff, and geometry updates to AppDelegate', () => {
    const sceneDelegatePath = join(APP_DIR, 'SceneDelegate.swift');
    expect(existsSync(sceneDelegatePath)).toBe(true);
    const source = readFileSync(sceneDelegatePath, 'utf8');

    expect(source).toContain('class SceneDelegate: UIResponder, UIWindowSceneDelegate');
    expect(source).toContain('func scene(');
    expect(source).toContain('willConnectTo session: UISceneSession');
    expect(source).toContain('func sceneDidBecomeActive(_ scene: UIScene)');
    expect(source).toContain('func sceneWillResignActive(_ scene: UIScene)');
    expect(source).toContain('func sceneWillEnterForeground(_ scene: UIScene)');
    expect(source).toContain('openURLContexts URLContexts: Set<UIOpenURLContext>');
    expect(source).toContain('continue userActivity: NSUserActivity');
    expect(source).toContain('windowScene(');
    expect(source).toContain('didUpdate previousCoordinateSpace: UICoordinateSpace');
    expect(source).toContain('AppDelegate.shared?.attachSceneWindow(window)');
    expect(source).toContain('AppDelegate.shared?.handleSceneDidBecomeActive(window: window)');
    expect(source).toContain('AppDelegate.shared?.handleSceneWillEnterForeground(window: window)');
    expect(source).toContain('AppDelegate.shared?.handleSceneWillResignActive()');
    expect(source).toContain('AppDelegate.shared?.handleSceneGeometryDidUpdate(window: window)');
    expect(source).toContain('AppDelegate.shared?.handleOpenURL(context.url)');
    expect(source).toContain('AppDelegate.shared?.handleContinueUserActivity(');
  });

  it('wires AppDelegate.swift scene configuration/handlers cleanly and registers SceneDelegate.swift in project.pbxproj', () => {
    const appDelegate = readFileSync(join(APP_DIR, 'AppDelegate.swift'), 'utf8');
    expect(appDelegate).toContain('static weak var shared: AppDelegate?');
    expect(appDelegate).toContain('configurationForConnecting connectingSceneSession: UISceneSession');
    expect(appDelegate).toContain('func attachSceneWindow(_ sceneWindow: UIWindow?)');
    expect(appDelegate).toContain('func handleSceneDidBecomeActive(window sceneWindow: UIWindow? = nil)');
    expect(appDelegate).toContain('func handleSceneWillEnterForeground(window sceneWindow: UIWindow? = nil)');
    expect(appDelegate).toContain('func handleSceneWillResignActive()');
    expect(appDelegate).toContain('func handleSceneGeometryDidUpdate(window sceneWindow: UIWindow? = nil)');
    expect(appDelegate).toContain('func handleOpenURL(_ url: URL');
    expect(appDelegate).toContain('func handleContinueUserActivity(_ userActivity: NSUserActivity');
    expect(appDelegate).toContain('if bridge.plugin(withName: "StreamingSpeech") == nil');
    expect(appDelegate).toContain('bridge.registerPluginInstance(StreamingSpeechPlugin())');
    expect(appDelegate).not.toMatch(/NSClassFromString|NSSelectorFromString|\bSelector\s*\(|\bperform\s*\(|value\(forKey:|setValue\(|_UI|_WK/);

    const pbxproj = readFileSync(join(IOS_APP_ROOT, 'App.xcodeproj/project.pbxproj'), 'utf8');
    expect(pbxproj).toContain('/* SceneDelegate.swift */');
    expect(pbxproj).toContain('/* SceneDelegate.swift in Sources */');
    expect(pbxproj.match(/MARKETING_VERSION = 1\.3;/g)).toHaveLength(10);
  });

  it('typechecks SceneDelegate.swift + AppDelegate.swift together on macOS Catalyst SDK', async () => {
    if (process.platform !== 'darwin') return;
    const tmpDir = mkdtempSync(join(tmpdir(), 'imcodes-scene-swift-'));
    try {
      const sdkPath = (await runNativeOrThrow('xcrun', ['--sdk', 'macosx', '--show-sdk-path'])).trim();
      const stubFile = join(tmpDir, 'Stubs.swift');
      const appDelegateFile = join(tmpDir, 'AppDelegate.swift');
      const sceneDelegateFile = join(tmpDir, 'SceneDelegate.swift');

      writeFileSync(stubFile, `
import UIKit
import WebKit
import Foundation

class CAPBridgePlugin: NSObject {}
typealias CAPPlugin = CAPBridgePlugin
protocol CAPBridgeProtocol: AnyObject {
    var webView: WKWebView? { get }
    func plugin(withName: String) -> CAPPlugin?
    func registerPluginInstance(_ plugin: CAPBridgePlugin)
}
class CAPBridgeViewController: UIViewController {
    var bridge: CAPBridgeProtocol?
    func setServerBasePath(path: String) {}
}
class ApplicationDelegateProxy {
    static let shared = ApplicationDelegateProxy()
    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool { true }
    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool { true }
}
extension Notification.Name {
    static let capacitorDidRegisterForRemoteNotifications = Notification.Name("capacitorDidRegisterForRemoteNotifications")
    static let capacitorDidFailToRegisterForRemoteNotifications = Notification.Name("capacitorDidFailToRegisterForRemoteNotifications")
}
class WatchBridge { static let shared = WatchBridge(); func activate() {} }
class ShareReceiverPlugin: CAPBridgePlugin {
    static let shared = ShareReceiverPlugin()
    func drainInboxFilesIfNeeded() {}
    func handleIncomingFileURL(_ url: URL) -> Bool { true }
    func flushToWebView() {}
}
class AuthSessionPlugin: CAPBridgePlugin {}
class WatchBridgePlugin: CAPBridgePlugin {}
class FileTransferKeepAlivePlugin: CAPBridgePlugin {}
class StreamingSpeechPlugin: CAPBridgePlugin {}
class IosSpeechModelDownloader {
    static func handleBackgroundSessionEvents(identifier: String, completionHandler: @escaping () -> Void) -> Bool { false }
}
`);

      const appDelegateSrc = readFileSync(join(APP_DIR, 'AppDelegate.swift'), 'utf8')
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          return trimmed !== 'import Capacitor' && trimmed !== 'import StreamingSpeechPlugin' && trimmed !== '@UIApplicationMain';
        })
        .join('\n');
      writeFileSync(appDelegateFile, appDelegateSrc);
      writeFileSync(sceneDelegateFile, readFileSync(join(APP_DIR, 'SceneDelegate.swift'), 'utf8'));

      await runNativeOrThrow('xcrun', [
        '--sdk', 'macosx',
        'swiftc',
        '-typecheck',
        '-target', 'arm64-apple-ios16.0-macabi',
        '-F', `${sdkPath}/System/iOSSupport/System/Library/Frameworks`,
        stubFile,
        appDelegateFile,
        sceneDelegateFile,
      ]);

      const simSdkPath = (await runNativeOrThrow('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'])).trim();
      await runNativeOrThrow('xcrun', [
        '--sdk', 'iphonesimulator',
        'swiftc',
        '-typecheck',
        '-sdk', simSdkPath,
        '-target', 'arm64-apple-ios16.0-simulator',
        stubFile,
        appDelegateFile,
        sceneDelegateFile,
      ]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
