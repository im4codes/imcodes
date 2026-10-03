import { runNative } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

describe('macOS generation-owned virtual display', () => {
  const header = read('native/macos-remote-desktop/macos_virtual_display_adapter.h');
  const adapter = read('native/macos-remote-desktop/macos_virtual_display_adapter.cc');
  const apple = read('native/macos-remote-desktop/apple_virtual_display_backend.mm');
  const build = read('native/macos-remote-desktop/BUILD.gn');
  const directory = process.platform === 'darwin'
    ? mkdtempSync(resolve(tmpdir(), 'aidesk-virtual-display-'))
    : null;

  afterAll(async () => {
    if (directory !== null) rmSync(directory, { recursive: true, force: true });
  });

  it('keeps private Apple runtime types behind the macOS backend', async () => {
    expect(header).not.toMatch(/@interface|CGVirtualDisplayDescriptor|objc\/runtime/);
    expect(adapter).not.toMatch(/CGVirtualDisplay|objc_msgSend|NSClassFromString/);
    expect(apple).toContain('NSClassFromString(@"CGVirtualDisplay")');
    expect(apple).toContain('class_getInstanceMethod');
    expect(apple).toContain('CGGetOnlineDisplayList');
    expect(apple).not.toContain('@interface CGVirtualDisplay');
    const descriptorRelease = apple.indexOf('objc_release((__bridge id)descriptor_)');
    const settingsRelease = apple.indexOf('objc_release((__bridge id)settings_)');
    const displayRelease = apple.indexOf('objc_release((__bridge id)display_)');
    expect(descriptorRelease).toBeGreaterThan(-1);
    expect(settingsRelease).toBeGreaterThan(descriptorRelease);
    expect(displayRelease).toBeGreaterThan(settingsRelease);
    expect(apple).toContain('descriptor_ = RetainOpaque(descriptor)');
    expect(apple).toContain('settings_ = retained_settings');
  });

  it('uses bounded approved modes and an aiDesk generation-owned identity', async () => {
    expect(header).toContain('aiDesk.to Virtual Display');
    expect(header).toContain('online_timeout_ms = 5\'000');
    expect(adapter).toContain('kMaximumDimension = 8192');
    expect(adapter).toContain('kMaximumModes = 16');
    expect(adapter).toContain('macos-display:');
    expect(adapter).toContain('display.operations.set_mode = true');
    expect(adapter).toContain('display.operations.set_scale = true');
  });

  it('is a production GN dependency of the macOS session', async () => {
    expect(build).toContain('source_set("macos_virtual_display_adapter")');
    expect(build).toContain('"apple_virtual_display_backend.mm"');
    expect(build).toContain('":macos_virtual_display_adapter"');
  });

  it('runs headless, physical-display and teardown counterfactuals under sanitizers', async () => {
    if (process.platform !== 'darwin') return;
    const executable = resolve(directory!, 'virtual-display-test');
    const compile = await runNative('xcrun', [
      'clang++', '-std=c++20', '-Wall', '-Wextra', '-Werror',
      '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
      '-mmacosx-version-min=12.3',
      '-I', resolve(ROOT, 'native/macos-remote-desktop'),
      '-I', resolve(ROOT, 'native/remote-desktop-common'),
      resolve(ROOT, 'test/spec/macos-remote-desktop-virtual-display-test.cc'),
      resolve(ROOT, 'native/macos-remote-desktop/macos_virtual_display_adapter.cc'),
      resolve(ROOT, 'native/remote-desktop-common/value_types.cc'),
      '-o', executable,
    ], { cwd: directory! });
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
    const run = await runNative(executable, [], { cwd: directory! });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain('macos virtual display adapter counterfactual ok');
  }, 120_000);

  it('compiles the core and private backend for arm64 and x86_64', async () => {
    if (process.platform !== 'darwin') return;
    for (const architecture of ['arm64', 'x86_64'] as const) {
      for (const [source, language] of [
        ['native/macos-remote-desktop/macos_virtual_display_adapter.cc', 'c++'],
        ['native/macos-remote-desktop/apple_virtual_display_backend.mm', 'objective-c++'],
      ] as const) {
        const output = resolve(directory!, `${architecture}-${language}.o`);
        const compile = await runNative('xcrun', [
          'clang++', '-std=c++20', '-Wall', '-Wextra', '-Werror',
          '-mmacosx-version-min=12.3', '-arch', architecture,
          ...(language === 'objective-c++' ? ['-fobjc-arc'] : []),
          '-I', resolve(ROOT, 'native/macos-remote-desktop'),
          '-I', resolve(ROOT, 'native/remote-desktop-common'),
          '-c', resolve(ROOT, source), '-o', output,
        ], { cwd: directory! });
        expect(compile.status, `${architecture}/${source}: ${compile.stdout}\n${compile.stderr}`).toBe(0);
      }
    }
  }, 120_000);
});
