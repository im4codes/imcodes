import { runNative } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('macOS explicit NSPasteboard clipboard adapter', () => {
  const header = read(
    'native/macos-remote-desktop/ns_pasteboard_clipboard_adapter.h',
  );
  const implementation = read(
    'native/macos-remote-desktop/ns_pasteboard_clipboard_adapter.mm',
  );

  it('keeps Apple and Objective-C types behind the adapter PImpl/backend seam', async () => {
    expect(header).toContain('public common::ClipboardAdapter');
    expect(header).toContain('class Impl;');
    expect(header).toContain('std::unique_ptr<Impl> impl_');
    expect(header).not.toMatch(
      /#import|\bNSPasteboard\s*\*|\bNSString\s*\*|\bNSData\s*\*|\bNSInteger\b/,
    );
    expect(implementation).toContain('#import <AppKit/AppKit.h>');
    expect(implementation).toContain('[NSPasteboard generalPasteboard]');
  });

  it('implements explicit bounded correlation without ambient synchronization', async () => {
    expect(implementation).toContain('ReadChangeCount(deadline, &baseline)');
    expect(implementation).toContain('observed == baseline');
    expect(implementation).toContain('ReadTextAfterChange(');
    expect(implementation).toContain('IsValidBoundedUtf8');
    expect(implementation).toContain('StillCurrent(generation)');
    expect(implementation).toContain('operation_timeout_ms');
    expect(implementation).not.toMatch(
      /dispatch_source|dispatch_async|NSTimer|addObserver|addLocalMonitorForEvents|std::thread\s+[A-Za-z_]/,
    );
  });

  it('separates cold backend capability from route liveness and consent', () => {
    expect(header).toContain('ProbeCapability() noexcept');
    expect(implementation).toMatch(
      /StartSession\(\)[\s\S]{0,260}!request_copy_[\s\S]{0,120}!request_paste_[\s\S]{0,220}ProbeCapability\(\)/u,
    );
    expect(implementation).toMatch(
      /ProbeReadiness\(\)[\s\S]{0,180}!SessionActive\(\)[\s\S]{0,140}ProbeCapability\(\)/u,
    );
  });

  it('does not log, serialize or retain clipboard payloads in adapter state', async () => {
    expect(implementation).not.toMatch(
      /NSLog|os_log|fprintf|std::cerr|std::cout|writeToFile|NSUserDefaults|setObject:.*forKey:/,
    );
    const state = implementation.slice(
      implementation.indexOf('std::unique_ptr<NSPasteboardBackend> backend_'),
      implementation.indexOf('NSPasteboardClipboardAdapter::NSPasteboardClipboardAdapter'),
    );
    expect(state).not.toMatch(/std::string\s+(clipboard|text|payload|secret)/i);
  });

  it('compiles production Objective-C++ for macOS 13 arm64 and x86_64', async () => {
    if (process.platform !== 'darwin') return;

    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-macos-clipboard-obj-'));
    try {
      for (const architecture of ['arm64', 'x86_64']) {
        const object = resolve(directory, `clipboard-${architecture}.o`);
        const compile = await runNative('xcrun', [
          'clang++',
          '-std=c++20',
          '-fobjc-arc',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-Wunguarded-availability-new',
          '-mmacosx-version-min=12.3',
          '-arch', architecture,
          '-I', resolve(ROOT, 'native/macos-remote-desktop'),
          '-I', resolve(ROOT, 'native/remote-desktop-common'),
          '-c', resolve(
            ROOT,
            'native/macos-remote-desktop/ns_pasteboard_clipboard_adapter.mm',
          ),
          '-o', object,
        ], { encoding: 'utf8' });
        expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('runs deterministic stale/bounds/timeout/session-stop fakes under sanitizers', async () => {
    if (process.platform !== 'darwin') return;

    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-macos-clipboard-test-'));
    const executable = resolve(directory, 'clipboard-test');
    try {
      const compile = await runNative('xcrun', [
        'clang++',
        '-std=c++20',
        '-fobjc-arc',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-Wunguarded-availability-new',
        '-fsanitize=address,undefined',
        '-fno-omit-frame-pointer',
        '-mmacosx-version-min=12.3',
        '-I', resolve(ROOT, 'native/macos-remote-desktop'),
        '-I', resolve(ROOT, 'native/remote-desktop-common'),
        resolve(ROOT, 'test/spec/macos-remote-desktop-clipboard-test.mm'),
        resolve(
          ROOT,
          'native/macos-remote-desktop/ns_pasteboard_clipboard_adapter.mm',
        ),
        '-framework', 'AppKit',
        '-framework', 'Foundation',
        '-o', executable,
      ], { encoding: 'utf8' });
      expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);

      const run = await runNative(executable, [], {
        env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' },
      });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
