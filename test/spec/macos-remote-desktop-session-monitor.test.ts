import { runNativeOrThrow } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

describe('macOS graphical-session monitor', () => {
  it.skipIf(process.platform !== 'darwin')(
    'compiles and fences active-user lifecycle notifications',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'imcodes-macos-session-monitor-'));
      const output = join(directory, 'session-monitor-test');
      try {
        await runNativeOrThrow('clang++', [
          '-std=c++20',
          '-fobjc-arc',
          '-fsanitize=address,undefined',
          '-fno-omit-frame-pointer',
          '-Werror=unguarded-availability-new',
          '-mmacosx-version-min=12.3',
          '-framework', 'AppKit',
          '-framework', 'Foundation',
          join(ROOT, 'native/macos-remote-desktop/macos_session_monitor.mm'),
          join(ROOT, 'native/remote-desktop-common/value_types.cc'),
          join(ROOT, 'test/spec/macos-remote-desktop-session-monitor-test.mm'),
          '-o', output,
        ], { cwd: ROOT });
        await runNativeOrThrow(output, [], { cwd: ROOT });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('binds the production source to the complete lifecycle notification set', async () => {
    const source = readFileSync(
      join(ROOT, 'native/macos-remote-desktop/macos_session_monitor.mm'),
      'utf8',
    );
    for (const token of [
      'NSWorkspaceWillSleepNotification',
      'NSWorkspaceDidWakeNotification',
      'NSWorkspaceSessionDidResignActiveNotification',
      'NSWorkspaceSessionDidBecomeActiveNotification',
      'NSWorkspaceWillPowerOffNotification',
      'com.apple.screenIsLocked',
      'com.apple.screenIsUnlocked',
    ]) {
      expect(source).toContain(token);
    }
    expect(source).toContain('event_generation != generation_');
    const build = readFileSync(
      join(ROOT, 'native/macos-remote-desktop/BUILD.gn'),
      'utf8',
    );
    expect(build).toContain('source_set("macos_session_monitor")');
    expect(build).toContain('"macos_session_monitor.mm"');
    expect(build).toContain('"AppKit.framework"');
  });
});
