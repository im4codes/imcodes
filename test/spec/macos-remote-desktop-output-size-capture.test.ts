import { runNative } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('macOS output-size capture (CGDisplayStream scales in WindowServer)', () => {
  const common = read('native/remote-desktop-common/platform_interfaces.h');
  const header = read('native/macos-remote-desktop/screen_capture_kit_adapter.h');
  const adapter = read('native/macos-remote-desktop/screen_capture_kit_adapter.mm');
  const cg = read('native/macos-remote-desktop/cg_display_stream_backend.mm');
  const session = read('native/macos-remote-desktop/macos_remote_desktop_session.mm');

  it('defaults every capture to "native size only", so Windows, Linux and ScreenCaptureKit are unchanged', () => {
    const base = common.slice(common.indexOf('class CaptureAdapter'), common.indexOf('struct EncoderConfiguration'));
    expect(base).toMatch(/virtual bool SupportsOutputSize\(\) const noexcept \{\s*return false;/);
    expect(base).toMatch(/virtual bool SetOutputSize\(PixelSize size\) \{[\s\S]{0,40}return false;/);
    expect(base).toMatch(/virtual std::optional<PixelSize> OutputSize\(\) const noexcept \{\s*return std::nullopt;/);
    // The backend seam has the same default.
    expect(header).toMatch(/virtual bool SupportsOutputSize\(\) const noexcept \{\s*return false;/);
  });

  it('only the CGDisplayStream backend opts in; the ScreenCaptureKit backend does not', () => {
    expect(cg).toMatch(/bool SupportsOutputSize\(\) const noexcept override \{ return true; \}/);
    const sck = adapter.slice(adapter.indexOf('class AppleScreenCaptureKitBackend'), adapter.indexOf('struct DeliveryState'));
    expect(sck.length).toBeGreaterThan(500);
    expect(sck).not.toContain('SupportsOutputSize');
  });

  it('switches make-before-break: the new stream delivers a frame before the old one stops', () => {
    const retarget = adapter.slice(adapter.indexOf('void Retarget('));
    const start = retarget.indexOf('fresh->Start(');
    const firstFrame = retarget.indexOf('fresh->WaitForFirstFrame(');
    const oldStop = retarget.indexOf('previous->Stop(');
    expect(start).toBeGreaterThan(0);
    expect(firstFrame).toBeGreaterThan(start);
    expect(oldStop).toBeGreaterThan(firstFrame);
    // A failed switch keeps the running stream.
    expect(retarget).toMatch(/if \(fresh\) fresh->Stop\([^)]*\);[\s\S]{0,200}if \(generation == run_generation\) requested_size = current_size;[\s\S]{0,40}return;/);
  });

  it('warms the new stream up without holding the stream mutex, so Stop()/Start() never wait for it', () => {
    const retarget = adapter.slice(adapter.indexOf('void Retarget('), adapter.indexOf('const common::WorkerGeneration worker_generation;'));
    const warm = retarget.indexOf('fresh->WaitForFirstFrame(');
    const lock = retarget.indexOf('std::lock_guard stream_lock(stream_mutex);');
    expect(warm).toBeGreaterThan(0);
    expect(lock).toBeGreaterThan(warm);
    // Only the swap runs under the lock, and it re-checks the capture is still the one it was started for.
    expect(retarget).toMatch(/still_running = running && generation == run_generation;/);
    // A stream that lost the race is stopped outside the lock.
    expect(retarget.slice(retarget.indexOf('// Whichever stream lost'))).toContain('fresh->Stop(');
  });

  it('keeps a size requested before the capture runs and applies it when Start() finishes', () => {
    expect(adapter).toMatch(/if \(!running\) \{[\s\S]{0,260}pending_request = size;\s*return false;/);
    expect(adapter).toContain('early = pending_request;');
    expect(adapter).toContain('if (early.has_value()) (void)SetOutputSize(*early);');
    // Start() must not forget it; only Stop() does.
    expect(adapter).toContain('StopLocked(/*forget_pending_request=*/false);');
    expect(adapter).toContain('StopLocked(/*forget_pending_request=*/true);');
  });

  it('a stream only delivers while it belongs to the capture that created it', () => {
    expect(adapter).toContain('FrameSinkFor(generation), ErrorSinkFor(generation)');
    expect(adapter.match(/FrameSinkFor\(generation\), ErrorSinkFor\(generation\)/g)?.length).toBe(2);
    expect(adapter).toContain('if (cell->load(std::memory_order_acquire) != generation) return;');
  });

  it('never blocks the caller of SetOutputSize and never upscales', () => {
    const setSize = adapter.slice(adapter.indexOf('bool SetOutputSize('), adapter.indexOf('std::optional<common::PixelSize> OutputSize() const noexcept {'));
    expect(setSize).toContain('dispatch_async(retarget_queue');
    expect(setSize).toContain('std::min(size.width, native_size.width)');
    expect(setSize).toContain('std::min(size.height, native_size.height)');
    // The per-frame read is lock-free.
    expect(adapter).toMatch(/std::atomic<std::uint64_t> output_size\{0\}/);
    expect(adapter).toContain('output_size.load(std::memory_order_acquire)');
  });

  it('the session expects the capture\'s current output size and falls back to the display size', () => {
    expect(session).toContain('dependencies_.adapters.capture.OutputSize()');
    expect(session).toMatch(/capture_size\.has_value\(\)\s*\?\s*\*capture_size/);
    expect(session).toContain('display->encoded_pixels');
  });

  it('retargets the capture to the encoder size only when the capture supports it', () => {
    expect(session).toMatch(/void RetargetCaptureToEncoder\(\) \{\s*if \(!capture_\.SupportsOutputSize\(\)\) return;/);
    expect(session).toContain('capture_.SetOutputSize(configuration->encoded_pixels)');
  });

  it('copies a captured surface without zero-filling it first', () => {
    expect(cg).toContain('std::unique_ptr<std::byte[]> bytes(new std::byte[byte_count]);');
    expect(cg).not.toMatch(/std::vector<std::byte> bytes\(row_bytes \* height\)/);
  });

  it('compiles, links and runs the injected-backend switching fake (darwin only)', async () => {
    if (process.platform !== 'darwin') return;
    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-macos-output-size-test-'));
    const executable = resolve(directory, 'output-size-test');
    try {
      const compile = await runNative('xcrun', [
        'clang++',
        '-std=c++20',
        '-fobjc-arc',
        '-fblocks',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-Wunguarded-availability-new',
        '-fsanitize=address,undefined',
        '-fno-omit-frame-pointer',
        '-mmacosx-version-min=12.3',
        '-I', resolve(ROOT, 'native/macos-remote-desktop'),
        '-I', resolve(ROOT, 'native/remote-desktop-common'),
        resolve(ROOT, 'test/spec/macos-remote-desktop-output-size-capture-test.mm'),
        resolve(ROOT, 'native/macos-remote-desktop/screen_capture_kit_adapter.mm'),
        resolve(ROOT, 'native/macos-remote-desktop/screen_capture_kit_limits.cc'),
        resolve(ROOT, 'native/remote-desktop-common/value_types.cc'),
        '-framework', 'CoreGraphics',
        '-framework', 'CoreMedia',
        '-framework', 'CoreVideo',
        '-framework', 'Foundation',
        '-framework', 'ScreenCaptureKit',
        '-o', executable,
      ], { encoding: 'utf8' });
      expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
      const run = await runNative(executable, [], { encoding: 'utf8' });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('macos output-size capture counterfactuals passed');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
