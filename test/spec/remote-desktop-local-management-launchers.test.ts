import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REMOTE_DESKTOP_LOCAL_MANAGEMENT } from '../../shared/remote-desktop-local-management.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('aiDesk local management launchers', () => {
  it('keeps one C++ URL and the TypeScript loopback endpoint byte-identical', () => {
    const common = read('native/remote-desktop-common/platform_interfaces.h');
    expect(common).toContain(
      `kLocalManagementUrl[] = "http://${REMOTE_DESKTOP_LOCAL_MANAGEMENT.HOST}:${REMOTE_DESKTOP_LOCAL_MANAGEMENT.PORT}/"`,
    );
  });

  it('opens the shared panel from the macOS app and collapsed disclosure badge', () => {
    const app = read('native/macos-remote-desktop/aidesk_agent_main.mm');
    const disclosure = read('native/macos-remote-desktop/macos_local_disclosure.mm');
    expect(app).toContain('kLocalManagementUrl');
    expect(app).toContain('openURL:url');
    expect(disclosure).toContain('[owner openManagement]');
    expect(disclosure).toContain('kLocalManagementUrl');
  });

  it('opens the same panel from Windows and Linux disclosure icons', () => {
    const windows = read('native/windows-remote-desktop/local_indicator.cc');
    const linux = read('native/linux-remote-desktop/linux_x11_backend.cc');
    expect(windows).toContain('ShellExecuteW(');
    expect(windows).toContain('common::kLocalManagementUrl');
    expect(linux).toContain('ButtonPressMask');
    expect(linux).toContain('common::kLocalManagementUrl');
    expect(linux).toContain('execlp("xdg-open"');
  });

  it('keeps native stop-all affordances behind two deliberate clicks', () => {
    const mac = read('native/macos-remote-desktop/macos_local_disclosure.mm');
    expect(mac).toContain('if (!self.confirmingStop)');
    expect(mac).toContain('self.confirmingStop = YES');
    expect(mac.indexOf('if (!self.confirmingStop)')).toBeLessThan(
      mac.indexOf('[owner stopPressed:nil]'),
    );

    const windows = read('native/windows-remote-desktop/local_indicator.cc');
    expect(windows).toContain('if (!confirming_stop_.exchange(true))');
    expect(windows.indexOf('if (!confirming_stop_.exchange(true))')).toBeLessThan(
      windows.indexOf('if (stop_all_) stop_all_()'),
    );
  });

  it('keeps the native open-window request byte-identical with the TypeScript contract', () => {
    const header = read('native/remote-desktop-common/local_management_open_window.h');
    expect(header).toContain(`kLocalManagementHost[] = "${REMOTE_DESKTOP_LOCAL_MANAGEMENT.HOST}"`);
    expect(header).toContain(`kLocalManagementPort = ${REMOTE_DESKTOP_LOCAL_MANAGEMENT.PORT}`);
    expect(header).toContain(`kLocalManagementOpenWindowPath[] = "${REMOTE_DESKTOP_LOCAL_MANAGEMENT.OPEN_WINDOW_PATH}"`);
    expect(header).toContain(`kLocalManagementOpenWindowHeader[] = "${REMOTE_DESKTOP_LOCAL_MANAGEMENT.OPEN_WINDOW_HEADER}"`);
    // no Origin: that is what tells a native client from a web page
    const builder = header.slice(header.indexOf('LocalManagementOpenWindowRequest()'), header.indexOf('LocalManagementHttpStatus(std::string_view'));
    expect(builder).not.toMatch(/Origin/u);
    expect(read('native/remote-desktop-common/BUILD.gn').match(/local_management_open_window\.h/gu)).toHaveLength(2);
    // the OS-neutral contract carries no compile switches or socket code (remote-desktop-common-build.test.ts); POSIX sockets live beside it
    expect(header).not.toMatch(/_WIN32|sys\/socket\.h/u);
    expect(read('native/posix-shared/local_management_open_window_posix.h')).toContain('RequestLocalManagementWindow(');
  });

  it('every platform asks the node to open the window first and keeps its previous open only as the fallback', () => {
    const windows = read('native/windows-remote-desktop/local_indicator.cc');
    expect(windows.indexOf('RequestNodeOpenPanelWindow()')).toBeGreaterThan(-1);
    expect(windows.indexOf('if (RequestNodeOpenPanelWindow()) return;')).toBeLessThan(windows.indexOf('ShellExecuteW(nullptr, L"open"'));
    expect(windows).toContain('std::thread([] {');
    expect(windows.indexOf('#include <winsock2.h>')).toBeLessThan(windows.indexOf('local_indicator.h"'));

    const linux = read('native/linux-remote-desktop/linux_x11_backend.cc');
    expect(linux).toContain('posix-shared/local_management_open_window_posix.h');
    expect(linux.indexOf('common::RequestLocalManagementWindow()')).toBeGreaterThan(-1);
    expect(linux.indexOf('common::RequestLocalManagementWindow()')).toBeLessThan(linux.indexOf('execlp("xdg-open"'));

    const app = read('native/macos-remote-desktop/aidesk_agent_main.mm');
    const disclosure = read('native/macos-remote-desktop/macos_local_disclosure.mm');
    for (const source of [app, disclosure]) {
      expect(source).toContain('RequestLocalManagementWindow()');
      expect(source).toContain('dispatch_get_global_queue');
    }
    expect(app.indexOf('RequestLocalManagementWindow()')).toBeLessThan(app.indexOf('OpenLocalManagementPanelDirectly(); });'));
    expect(disclosure.indexOf('RequestLocalManagementWindow()')).toBeLessThan(disclosure.indexOf('openURL:url'));
  });
});
