import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('macOS NV12 capture (CGDisplayStream 420v)', () => {
  const common = read('native/remote-desktop-common/platform_interfaces.h');
  const values = read('native/remote-desktop-common/value_types.h');
  const cg = read('native/macos-remote-desktop/cg_display_stream_backend.mm');
  const adapter = read('native/macos-remote-desktop/screen_capture_kit_adapter.mm');
  const header = read('native/macos-remote-desktop/screen_capture_kit_adapter.h');
  const session = read('native/macos-remote-desktop/macos_remote_desktop_session.mm');
  const vt = read('native/macos-remote-desktop/video_toolbox_h264_encoder.h');

  it('defaults every capture and every encoder to BGRA, so nothing changes until an encoder asks', () => {
    expect(common).toMatch(/virtual bool SetPixelFormat\(PixelFormat format\) \{\s*return format == PixelFormat::kBgra8888;/);
    expect(common).toMatch(/virtual PixelFormat PreferredInputFormat\(\) const noexcept \{\s*return PixelFormat::kBgra8888;/);
    expect(header).toMatch(/virtual bool SupportsPixelFormat\(\s*common::PixelFormat format\) const noexcept \{\s*return format == common::PixelFormat::kBgra8888;/);
    // The VideoToolbox H.264 encoder keeps taking BGRA: it does not override the preference.
    expect(vt).not.toContain('PreferredInputFormat');
    // The ScreenCaptureKit backend does not offer NV12.
    const sck = adapter.slice(adapter.indexOf('class AppleScreenCaptureKitBackend'), adapter.indexOf('struct DeliveryState'));
    expect(sck.length).toBeGreaterThan(500);
    expect(sck).not.toContain('SupportsPixelFormat');
    expect(sck).not.toContain('kNv12');
  });

  it('describes an NV12 frame with its own chroma plane layout', () => {
    expect(values).toMatch(/kNv12,/);
    expect(values).toContain('std::uint32_t uv_offset = 0;');
    expect(values).toContain('std::uint32_t uv_row_bytes = 0;');
  });

  it('asks CGDisplayStream for 420v with an explicit BT.709 matrix, only when NV12 was requested', () => {
    expect(cg).toContain('kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange');
    expect(cg).toContain('kCGDisplayStreamYCbCrMatrix_ITU_R_709_2');
    expect(cg).toMatch(/nv12 \? 3 : 2/);
    expect(cg).toMatch(/nv12 \? kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange\s*:\s*kCVPixelFormatType_32BGRA/);
  });

  it('copies both planes, each with its own stride, into one owned buffer', () => {
    const copy = cg.slice(cg.indexOf('bool CopyNv12Planes('), cg.indexOf('Copies one IOSurface into an owned buffer.'));
    expect(copy).toContain('IOSurfaceGetPlaneCount(surface) != 2');
    expect(copy).toContain('IOSurfaceGetBaseAddressOfPlane(surface, 0)');
    expect(copy).toContain('IOSurfaceGetBaseAddressOfPlane(surface, 1)');
    expect(copy).toContain('IOSurfaceGetBytesPerRowOfPlane(surface, 0)');
    expect(copy).toContain('IOSurfaceGetBytesPerRowOfPlane(surface, 1)');
    expect(copy).toContain('chroma_height != height / 2');
    expect(copy).toContain('out->uv_offset = static_cast<std::uint32_t>(luma_bytes);');
  });

  it('the capture adapter passes the format to the initial and every retarget stream, and refuses a change while running', () => {
    expect(adapter.match(/\.pixel_format = format,/g)?.length).toBe(2);
    expect(adapter).toMatch(/bool SetPixelFormat\(common::PixelFormat format\) \{\s*if \(backend == nullptr \|\| !backend->SupportsPixelFormat\(format\)\) return false;/);
    expect(adapter).toMatch(/if \(running\) return false;\s*pixel_format = format;/);
  });

  it('the session feeds the capture in the format the encoder prefers and falls back to BGRA', () => {
    expect(session).toMatch(/SetPixelFormat\(\s*dependencies_\.adapters\.encoder\.PreferredInputFormat\(\)\)\) \{\s*\(void\)dependencies_\.adapters\.capture\.SetPixelFormat\(\s*common::PixelFormat::kBgra8888\);/);
    const start = session.indexOf('SetPixelFormat(');
    const captureStart = session.indexOf('dependencies_.adapters.capture.Start(');
    expect(start).toBeGreaterThan(0);
    expect(captureStart).toBeGreaterThan(start);
  });
});
