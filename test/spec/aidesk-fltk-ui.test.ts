import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const source = async (path: string) => await readFile(new URL(path, root), 'utf8');

describe('aiDesk FLTK native management window', () => {
  it('uses one toolkit-neutral IPC authority and keeps browser/webview code out of the UI', async () => {
    const [ui, session, common, cmake] = await Promise.all([
      source('native/aidesk-ui/aidesk_ui.cc'),
      source('native/aidesk-ui/local_management_session.cc'),
      source('native/remote-desktop-common/local_management_ipc.h'),
      source('native/aidesk-ui/CMakeLists.txt'),
    ]);
    expect(ui).toContain('LocalManagementSession');
    expect(session).toContain('LocalManagementClientCore');
    expect(session).toContain('ParseLocalManagementBootstrap');
    expect(common).not.toMatch(/#include\s+[<"](?:FL\/|AppKit|windows\.h|X11\/)/u);
    expect(`${ui}\n${session}`).not.toMatch(/WKWebView|WebView2|WebKitGTK|Electron|127\.0\.0\.1/u);
    expect(cmake).toContain('FLTK_BUILD_SHARED_LIBS OFF');
    expect(cmake).toContain('aidesk_jsoncpp STATIC');
  });

  it('initializes FLTK cross-thread wakeups and exposes every required action through the same callbacks', async () => {
    const [ui, mac, windows] = await Promise.all([
      source('native/aidesk-ui/aidesk_ui.cc'),
      source('native/aidesk-ui/accessibility_bridge_macos.mm'),
      source('native/aidesk-ui/accessibility_bridge_windows.cc'),
    ]);
    expect(ui).toContain('Fl::lock();');
    for (const action of ['kPause', 'kResume', 'kStopAll', 'kDisconnect']) {
      expect(ui).toContain(action);
    }
    expect(ui).toContain('Text::kStopAllConfirm');
    expect(ui).toContain('Text::kDisconnectConfirm');
    expect(ui).toContain('button->do_callback()');
    expect(mac).toContain('accessibilityPerformPress');
    expect(mac).toContain('NSAccessibilityLayoutChangedNotification');
    expect(windows).toContain('UIA/MSAA HWND semantic mirror with Invoke forwarding');
    expect(windows).toContain('BN_CLICKED');
  });

  it('keeps all visible copy in one complete seven-locale table and provides keyboard and text status cues', async () => {
    const [strings, stringsHeader, ui] = await Promise.all([
      source('shared/aidesk-local-ui-i18n.h'),
      source('native/aidesk-ui/aidesk_ui_strings.h'),
      source('native/aidesk-ui/aidesk_ui.cc'),
    ]);
    expect(strings).toContain('using Row = std::array<const char*, 7>');
    for (const locale of ['kEn', 'kZhCn', 'kZhTw', 'kEs', 'kRu', 'kJa', 'kKo']) {
      expect(stringsHeader).toContain(locale);
    }
    expect(ui).toContain("FL_CTRL + 'c'");
    expect(ui).toContain("FL_ALT + 'p'");
    expect(ui).toContain("FL_ALT + 's'");
    expect(ui).toContain('status_->copy_label(status.c_str())');
    expect(ui).toContain('status_->labelcolor(status_color)');
  });

  it('keeps legacy panel behavior while preferring the packaged native UI from every entry point', async () => {
    const [entry, agent, packager, product] = await Promise.all([
      source('src/node/aidesk-desktop-entry.ts'),
      source('native/macos-remote-desktop/aidesk_agent_main.mm'),
      source('scripts/build-aidesk-app.mjs'),
      source('shared/aidesk-product.json'),
    ]);
    expect(entry).toContain('resolveAideskLocalUiExecutable');
    expect(entry).toContain('if (existsSync(nativeUi))');
    expect(entry).toContain('const url = localPanelUrl()');
    expect(agent).toContain('Contents/Helpers');
    expect(agent).toContain('kLocalManagementUrl');
    expect(agent).toContain('openURL:url');
    expect(packager).toContain('AIDESK_LOCAL_UI_EXECUTABLE');
    expect(product).toContain('"localUiExecutableName": "aidesk-local-ui"');
  });

  it('makes all three SDK builders opt in to the same pinned FLTK/jsoncpp build without changing old jobs', async () => {
    const [mac, linux, windows] = await Promise.all([
      source('native/macos-remote-desktop/build-worker-from-sdk.sh'),
      source('native/linux-remote-desktop/build-worker-from-sdk.sh'),
      source('native/windows-remote-desktop/build-worker-from-sdk.ps1'),
    ]);
    expect(mac).toContain('--fltk-root');
    expect(linux).toContain('--fltk-root');
    expect(windows).toContain('$FltkRoot');
    expect(mac).toMatch(/if \[\[ -n "\$FLTK_ROOT" \|\| -n "\$JSONCPP_ROOT" \]\]/u);
    expect(linux).toMatch(/if \[\[ -n "\$FLTK_ROOT" \|\| -n "\$JSONCPP_ROOT" \]\]/u);
    expect(windows).toContain('[string]::IsNullOrWhiteSpace($FltkRoot)');
    expect(windows).toContain('FltkRoot and JsoncppRoot must be supplied together');
  });
});
