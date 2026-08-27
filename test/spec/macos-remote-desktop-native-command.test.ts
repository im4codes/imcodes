import { runNative } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const NATIVE = resolve(ROOT, 'native/macos-remote-desktop');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

const CONTRACT_SOURCES = [
  'native/macos-remote-desktop/macos_native_command_v1.cc',
  'native/macos-remote-desktop/macos_worker_ipc_client.cc',
  'native/macos-remote-desktop/macos_disclosure_control.cc',
  'native/macos-remote-desktop/macos_host_command_dispatch.cc',
  'native/macos-remote-desktop/macos_worker_control.cc',
] as const;

describe('macOS remote-desktop native command, IPC and disclosure seams', () => {
  const build = read('native/macos-remote-desktop/BUILD.gn');
  const directory = process.platform === 'darwin'
    ? mkdtempSync(resolve(tmpdir(), 'imcodes-macos-rd-cmd-'))
    : null;

  afterAll(async () => {
    if (directory !== null) rmSync(directory, { recursive: true, force: true });
  });

  it('keeps the contract layers free of OS and framework types', async () => {
    // These translation units are the shared vocabulary between the daemon and
    // the executables. An OS type here would make the contract untestable
    // without a live desktop and would leak platform detail into a layer the
    // common core deliberately keeps neutral.
    for (const path of CONTRACT_SOURCES) {
      const source = read(path);
      expect(source, path).not.toMatch(/#(include|import)\s*[<"](AppKit|Foundation|CoreGraphics|ApplicationServices|Security|ScreenCaptureKit|VideoToolbox)/);
      expect(source, path).not.toMatch(/\b(NSString|NSWindow|CFStringRef|CGDirectDisplayID|dispatch_queue_t)\b/);
      expect(source, path).not.toMatch(/#include\s*"(api|pc|rtc_base|media|p2p)\//);
    }
  });

  it('declares each contract layer as its own build target', async () => {
    for (const target of [
      'macos_native_command_v1',
      'macos_worker_ipc_client',
      'macos_disclosure_control',
      'macos_worker_control',
    ]) {
      expect(build, target).toContain(`source_set("${target}")`);
    }
    // The worker executable must actually depend on all three, or the seams
    // would compile in isolation while the shipped binary used something else.
    const depsBlock = (target: string): string => {
      const body = build.slice(build.indexOf(`rtc_executable("${target}")`));
      const start = body.indexOf('deps = [');
      expect(start, `${target} declares deps`).toBeGreaterThanOrEqual(0);
      return body.slice(start, body.indexOf(']', start));
    };
    const workerDeps = depsBlock('imcodes_remote_desktop_worker');
    for (const target of [
      'macos_disclosure_control',
      'macos_native_command_v1',
      'macos_worker_ipc_client',
      'macos_worker_control',
      'macos_remote_desktop_session',
      'pinned_libwebrtc_transport_backend',
    ]) {
      expect(workerDeps, target).toContain(`:${target}`);
    }
    expect(depsBlock('imcodes_remote_desktop_disclosure'))
      .toContain(':macos_disclosure_control');
  });

  it('runs the production counterfactual under ASan and UBSan', async () => {
    if (process.platform !== 'darwin') return;
    const executable = resolve(directory!, 'native-command-test');
    const compile = await runNative('xcrun', [
      'clang++',
      '-std=c++20',
      '-Wall', '-Wextra', '-Werror',
      '-fsanitize=address,undefined',
      '-fno-omit-frame-pointer',
      '-pthread',
      '-mmacosx-version-min=12.3',
      '-I', NATIVE,
      '-I', resolve(ROOT, 'native/remote-desktop-common'),
      resolve(ROOT, 'test/spec/macos-remote-desktop-native-command-test.cc'),
      ...CONTRACT_SOURCES.map((path) => resolve(ROOT, path)),
      '-o', executable,
    ], { cwd: directory! });
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);

    const run = await runNative(executable, [], { cwd: directory! });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  }, 120_000);

  it('compiles the contract layers for both release architectures', async () => {
    if (process.platform !== 'darwin') return;
    for (const architecture of ['arm64', 'x86_64'] as const) {
      for (const path of CONTRACT_SOURCES) {
        const compile = await runNative('xcrun', [
          'clang++',
          '-std=c++20',
          '-Wall', '-Wextra', '-Werror',
          '-mmacosx-version-min=12.3',
          '-arch', architecture,
          '-I', NATIVE,
          '-I', resolve(ROOT, 'native/remote-desktop-common'),
          '-c', resolve(ROOT, path),
          '-o', resolve(directory!, `${architecture}-${path.split('/').pop()}.o`),
        ], { cwd: directory! });
        expect(compile.status, `${architecture} ${path}: ${compile.stderr}`).toBe(0);
      }
    }
  }, 180_000);
});
