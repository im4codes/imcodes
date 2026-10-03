import { runNative } from './support/native-exec.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const NATIVE = resolve(ROOT, 'native/macos-remote-desktop');
const COMMON = resolve(ROOT, 'native/remote-desktop-common');

describe('macOS virtual-display daemon-proxy backend', () => {
  it('runs the display counterfactual under ASan and UBSan', async () => {
    if (process.platform !== 'darwin') return;
    const directory = mkdtempSync(join(tmpdir(), 'imcodes-vd-backend-'));
    try {
      const output = join(directory, 'daemon-backend');
      const compile = await runNative('xcrun', [
        'clang++', '-std=c++20',
        '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
        '-Wall', '-Wextra', '-Werror',
        '-I', NATIVE, '-I', COMMON,
        resolve(NATIVE, 'macos_virtual_display_daemon_backend.cc'),
        resolve(NATIVE, 'macos_virtual_display_helper_binding.cc'),
        resolve(NATIVE, 'macos_worker_ipc_client.cc'),
        resolve(NATIVE, 'macos_virtual_display_adapter.cc'),
        resolve(NATIVE, 'screen_capture_kit_limits.cc'),
        resolve(COMMON, 'value_types.cc'),
        resolve(ROOT, 'test/spec/macos-remote-desktop-virtual-display-daemon-backend-test.cc'),
        '-o', output,
      ], { encoding: 'utf8' });
      expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
      const run = await runNative(output, [], {
        env: {
          ...process.env,
          ASAN_OPTIONS: 'halt_on_error=1:abort_on_error=1',
          UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1',
        },
      });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('macos virtual display daemon backend counterfactual ok');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it('injects the daemon backend into the production session', async () => {
    const worker = readFileSyncSafe(resolve(NATIVE, 'macos_remote_desktop_worker_main.mm'));
    // The nullptr this replaced meant every display request was refused before
    // it could be asked.
    expect(worker).toContain('DaemonProxyVirtualDisplayBackend');
    expect(worker).not.toMatch(/configuration\.virtual_display_backend\s*=\s*nullptr/u);
    // One reader. A second concurrent read of this descriptor would split a
    // frame between two accumulators.
    expect(worker).toContain('display_channel.ReadFrames(&frames)');
    expect(worker).toContain('display_channel.Exchange(request, shape, reply)');
    // Off-thread exchange is refused rather than racing the loop's reader.
    expect(worker).toContain('std::this_thread::get_id() != owner_');
  });
});

function readFileSyncSafe(path: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('node:fs').readFileSync(path, 'utf8') as string;
}
