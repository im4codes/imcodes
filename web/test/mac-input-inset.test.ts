/**
 * @vitest-environment jsdom
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAC_BOTTOM_INSET_CSS_VAR,
  MAC_BOTTOM_INSET_EVENT,
  applyMacBottomInsetCssVar,
  computeVisualViewportBottomInsetPx,
  installMacInputInset,
  isMacEditableTarget,
  readNativeMacBottomInsetPx,
  resolveMacBottomInsetCssPx,
} from '../src/mac-input-inset';
import { IOS_MAC_DESKTOP_CLASS } from '../src/native-platform';
import { applyUiScale, writeUiScale } from '../src/ui-scale';

describe('mac-input-inset unit & boundary behavior', () => {
  beforeEach(() => {
    localStorage.clear();
    applyUiScale(100);
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-native-platform');
    document.documentElement.style.removeProperty(MAC_BOTTOM_INSET_CSS_VAR);
    delete (window as unknown as Record<string, unknown>).Capacitor;
    delete (window as unknown as Record<string, unknown>).__IMCODES_NATIVE_HOST__;
    delete (window as unknown as Record<string, unknown>).__IMCODES_MAC_BOTTOM_INSET__;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    applyUiScale(100);
    document.documentElement.className = '';
    document.documentElement.style.removeProperty(MAC_BOTTOM_INSET_CSS_VAR);
    document.body.innerHTML = '';
    delete (window as unknown as Record<string, unknown>).Capacitor;
    delete (window as unknown as Record<string, unknown>).__IMCODES_NATIVE_HOST__;
    delete (window as unknown as Record<string, unknown>).__IMCODES_MAC_BOTTOM_INSET__;
  });

  it('resolves max(native, visualViewport) without double-counting across 60%–150% UI scales', () => {
    expect(resolveMacBottomInsetCssPx({ nativeInsetPx: 44, visualViewportInsetPx: 0, cssZoom: 1 })).toBe(44);
    expect(resolveMacBottomInsetCssPx({ nativeInsetPx: 0, visualViewportInsetPx: 44, cssZoom: 1.25 })).toBe(35.2);
    // Both channels reporting 44px must yield 44px effective shift (35.2px @ 1.25x), never 88px.
    expect(resolveMacBottomInsetCssPx({ nativeInsetPx: 44, visualViewportInsetPx: 42, cssZoom: 1.25 })).toBe(35.2);

    for (const scalePct of [60, 75, 90, 100, 115, 125, 130, 150]) {
      const zoom = scalePct / 100;
      const cssPx = resolveMacBottomInsetCssPx({ nativeInsetPx: 44, visualViewportInsetPx: 44, cssZoom: zoom });
      const renderedShift = cssPx * zoom;
      expect(renderedShift).toBeGreaterThanOrEqual(44);
      expect(renderedShift).toBeLessThanOrEqual(44.002);
    }

    expect(resolveMacBottomInsetCssPx({ nativeInsetPx: 0, visualViewportInsetPx: 0, cssZoom: 1.25 })).toBe(0);
    expect(resolveMacBottomInsetCssPx({ nativeInsetPx: 1, visualViewportInsetPx: 1.5, cssZoom: 1 })).toBe(0);
  });

  it('computes visualViewport bottom occlusion while rejecting pinch-zoom, top offset, jitter, and bogus full-screen values', () => {
    expect(computeVisualViewportBottomInsetPx({
      innerHeight: 800,
      visualViewportHeight: 756,
      visualViewportOffsetTop: 0,
      visualViewportScale: 1,
    })).toBe(44);

    // Viewport shifted down without bottom shrink is not bottom occlusion
    expect(computeVisualViewportBottomInsetPx({
      innerHeight: 800,
      visualViewportHeight: 756,
      visualViewportOffsetTop: 44,
      visualViewportScale: 1,
    })).toBe(0);

    // Trackpad pinch-to-zoom shrinks visualViewport.height with scale > 1 — must NOT trigger bottom inset
    expect(computeVisualViewportBottomInsetPx({
      innerHeight: 800,
      visualViewportHeight: 533.33,
      visualViewportOffsetTop: 0,
      visualViewportScale: 1.5,
    })).toBe(0);

    // Sub-2px rounding noise and >=80% bogus values return 0
    expect(computeVisualViewportBottomInsetPx({
      innerHeight: 800,
      visualViewportHeight: 799,
      visualViewportOffsetTop: 0,
      visualViewportScale: 1,
    })).toBe(0);
    expect(computeVisualViewportBottomInsetPx({
      innerHeight: 800,
      visualViewportHeight: 100,
      visualViewportOffsetTop: 0,
      visualViewportScale: 1,
    })).toBe(0);
  });

  it('leaves non-Mac platforms (regular web, Android, iPhone, touch iPad) completely untouched', () => {
    applyMacBottomInsetCssVar(document.documentElement, 44);
    expect(document.documentElement.style.getPropertyValue(MAC_BOTTOM_INSET_CSS_VAR)).toBe('44px');

    // Web mode -> clears stale var and stays inert
    const disposeWeb = installMacInputInset();
    expect(document.documentElement.style.getPropertyValue(MAC_BOTTOM_INSET_CSS_VAR)).toBe('');
    expect(document.documentElement.classList.contains(IOS_MAC_DESKTOP_CLASS)).toBe(false);
    window.dispatchEvent(new CustomEvent(MAC_BOTTOM_INSET_EVENT, { detail: { inset: 44 } }));
    expect(document.documentElement.style.getPropertyValue(MAC_BOTTOM_INSET_CSS_VAR)).toBe('');
    disposeWeb();

    // Android native -> inert
    (window as unknown as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
    };
    const disposeAndroid = installMacInputInset();
    window.dispatchEvent(new CustomEvent(MAC_BOTTOM_INSET_EVENT, { detail: { inset: 44 } }));
    expect(document.documentElement.style.getPropertyValue(MAC_BOTTOM_INSET_CSS_VAR)).toBe('');
    disposeAndroid();
  });

  it('syncs native & visualViewport channels on Mac, adapts to live UI scale changes, never sets .kb-open/.input-focused, and resets on blur/resize', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });
    (window as unknown as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
    (window as unknown as Record<string, unknown>).__IMCODES_NATIVE_HOST__ = {
      isMacDesktop: true,
      pageZoomApplied: false,
      scaleMode: 'designed-for-ipad',
    };

    const textarea = document.createElement('textarea');
    const button = document.createElement('button');
    document.body.append(textarea, button);
    expect(isMacEditableTarget(textarea)).toBe(true);
    expect(isMacEditableTarget(button)).toBe(false);

    writeUiScale(125);
    document.documentElement.classList.add('kb-open', 'input-focused');

    const dispose = installMacInputInset();
    expect(document.documentElement.classList.contains(IOS_MAC_DESKTOP_CLASS)).toBe(true);
    expect(document.documentElement.classList.contains('kb-open')).toBe(false);
    expect(document.documentElement.classList.contains('input-focused')).toBe(false);

    textarea.focus();
    window.dispatchEvent(new CustomEvent(MAC_BOTTOM_INSET_EVENT, { detail: { inset: 44 } }));
    expect(readNativeMacBottomInsetPx(window)).toBe(44);
    expect(document.documentElement.style.getPropertyValue(MAC_BOTTOM_INSET_CSS_VAR)).toBe('35.2px');
    expect(document.documentElement.classList.contains('kb-open')).toBe(false);
    expect(document.documentElement.classList.contains('input-focused')).toBe(false);

    // Dynamic UI scale change while bar is visible recomputes CSS var immediately
    writeUiScale(100);
    expect(document.documentElement.style.getPropertyValue(MAC_BOTTOM_INSET_CSS_VAR)).toBe('44px');
    writeUiScale(125);
    expect(document.documentElement.style.getPropertyValue(MAC_BOTTOM_INSET_CSS_VAR)).toBe('35.2px');

    // Blurring editable input without a follow-up native hide event still clears stale inset
    textarea.blur();
    button.focus();
    await new Promise((r) => setTimeout(r, 15));
    expect(document.documentElement.style.getPropertyValue(MAC_BOTTOM_INSET_CSS_VAR)).toBe('');

    // Window resize while no input is focused clears any stale native inset
    window.dispatchEvent(new CustomEvent(MAC_BOTTOM_INSET_EVENT, { detail: { inset: 40 } }));
    expect(document.documentElement.style.getPropertyValue(MAC_BOTTOM_INSET_CSS_VAR)).toBe('32px');
    Object.defineProperty(window, 'innerHeight', { value: 760, configurable: true, writable: true });
    window.dispatchEvent(new Event('resize'));
    expect(document.documentElement.style.getPropertyValue(MAC_BOTTOM_INSET_CSS_VAR)).toBe('');

    dispose();
  });

  it('keeps AppDelegate.swift strictly on public UIKit/WebKit APIs and verifies WKWebView recursive assistant clearing + overlap geometry', { timeout: 30000 }, () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const appDelegatePath = resolve(here, '../ios/App/App/AppDelegate.swift');
    const source = readFileSync(appDelegatePath, 'utf8');

    expect(source).toContain('static func clearInputAssistantItems(for webView: WKWebView?)');
    expect(source).toContain('assistant.leadingBarButtonGroups = []');
    expect(source).toContain('assistant.trailingBarButtonGroups = []');
    expect(source).toContain('assistant.allowsHidingShortcuts = true');
    expect(source).toContain('stack.append(contentsOf: current.subviews)');
    expect(source).toContain('UIResponder.keyboardWillShowNotification');
    expect(source).toContain('UIResponder.keyboardWillChangeFrameNotification');
    expect(source).toContain('UIResponder.keyboardWillHideNotification');
    expect(source).toContain('window.__IMCODES_MAC_BOTTOM_INSET__');
    expect(source).toContain("CustomEvent('imcodes:mac-bottom-inset'");

    // Strictly forbid private API reflection / selectors
    expect(source).not.toMatch(/NSClassFromString|NSSelectorFromString|\bSelector\s*\(|\bperform\s*\(|value\(forKey:|setValue\(|_UI|_WK/);

    if (process.platform === 'darwin') {
      const tmpDir = mkdtempSync(join(tmpdir(), 'imcodes-mac-inset-swift-'));
      try {
        const sdkPath = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
        const stubFile = join(tmpDir, 'Stubs.swift');
        const delegateFile = join(tmpDir, 'AppDelegateUnderTest.swift');
        const mainFile = join(tmpDir, 'Main.swift');
        const binFile = join(tmpDir, 'mac-inset-check');

        writeFileSync(stubFile, `
import UIKit
import WebKit
import Foundation

class CAPBridgePlugin: NSObject {}
protocol CAPBridgeProtocol: AnyObject {
    var webView: WKWebView? { get }
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
`);

        const strippedDelegate = source
          .split('\n')
          .filter((line) => line.trim() !== 'import Capacitor' && line.trim() !== '@UIApplicationMain')
          .join('\n');
        writeFileSync(delegateFile, strippedDelegate);

        writeFileSync(mainFile, `
import UIKit
import WebKit

@main
struct Runner {
    static func check(_ cond: @autoclosure () -> Bool, _ msg: String) {
        if !cond() {
            fputs("FAIL: \\(msg)\\n", stderr)
            exit(1)
        }
    }

    static func main() {
        let bounds = CGRect(x: 0, y: 0, width: 1280, height: 800)

        // 1. Bottom-docked 44pt bar -> 44pt overlap
        let docked = AppDelegate.computeMacBottomOverlapPoints(
            viewBounds: bounds,
            convertedKeyboardFrame: CGRect(x: 0, y: 756, width: 1280, height: 44)
        )
        check(abs(docked - 44) < 0.01, "expected 44pt docked overlap, got \\(docked)")

        // 2. Floating IME candidate box detached from bottom -> 0
        let detached = AppDelegate.computeMacBottomOverlapPoints(
            viewBounds: bounds,
            convertedKeyboardFrame: CGRect(x: 320, y: 690, width: 260, height: 42)
        )
        check(detached == 0, "detached floating IME box must be 0, got \\(detached)")

        // 3. Narrow floating candidate popup touching bottom -> 0
        let narrow = AppDelegate.computeMacBottomOverlapPoints(
            viewBounds: bounds,
            convertedKeyboardFrame: CGRect(x: 320, y: 760, width: 240, height: 40)
        )
        check(narrow == 0, "narrow popup must be 0, got \\(narrow)")

        // 4. Offscreen hidden keyboard below window -> 0
        let hidden = AppDelegate.computeMacBottomOverlapPoints(
            viewBounds: bounds,
            convertedKeyboardFrame: CGRect(x: 0, y: 800, width: 1280, height: 44)
        )
        check(hidden == 0, "offscreen keyboard must be 0, got \\(hidden)")

        // 5. Recursive WKWebView + scrollView subview UITextInputAssistantItem clearing
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        let simulatedContentView = UIView(frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        let dummyItem = UIBarButtonItem(title: "Done", style: .plain, target: nil, action: nil)
        let group = UIBarButtonItemGroup(barButtonItems: [dummyItem], representativeItem: nil)
        webView.inputAssistantItem.leadingBarButtonGroups = [group]
        simulatedContentView.inputAssistantItem.leadingBarButtonGroups = [group]
        simulatedContentView.inputAssistantItem.trailingBarButtonGroups = [group]
        webView.scrollView.addSubview(simulatedContentView)

        AppDelegate.clearInputAssistantItems(for: webView)
        check(webView.inputAssistantItem.leadingBarButtonGroups.isEmpty, "webView leading groups should be cleared")
        check(simulatedContentView.inputAssistantItem.leadingBarButtonGroups.isEmpty, "subview leading groups should be cleared")
        check(simulatedContentView.inputAssistantItem.trailingBarButtonGroups.isEmpty, "subview trailing groups should be cleared")
        check(simulatedContentView.inputAssistantItem.allowsHidingShortcuts == true, "allowsHidingShortcuts should be true")
    }
}
`);

        execFileSync('xcrun', [
          '--sdk', 'macosx',
          'swiftc',
          '-target', 'arm64-apple-ios16.0-macabi',
          '-F', `${sdkPath}/System/iOSSupport/System/Library/Frameworks`,
          stubFile,
          delegateFile,
          mainFile,
          '-o', binFile,
        ], { stdio: 'pipe' });
        execFileSync(binFile, [], { stdio: 'pipe' });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });
});
