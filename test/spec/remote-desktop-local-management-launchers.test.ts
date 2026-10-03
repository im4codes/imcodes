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
});
