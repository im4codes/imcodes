import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REMOTE_DESKTOP_ENCODER_CLASS } from '../../shared/remote-desktop.js';

const ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('macOS worker quality report tells the truth about the encoder', () => {
  const workerMain = read('native/macos-remote-desktop/macos_remote_desktop_worker_main.mm');
  const constants = read('native/remote-desktop-common/data_channel_constants.h');
  const common = read('native/remote-desktop-common/platform_interfaces.h');
  const encoder = read('native/macos-remote-desktop/video_toolbox_h264_encoder.mm');

  it('no longer writes "hardware" unconditionally', () => {
    expect(workerMain).not.toMatch(/root\["encoderClass"\]\s*=\s*"hardware"/);
    expect(workerMain).toContain('session_->encoder_class() == rd::common::EncoderClass::kHardware');
    expect(workerMain).toContain('imcodes::rd::kEncoderClassHardware');
    expect(workerMain).toContain('imcodes::rd::kEncoderClassSoftware');
    // Unknown is never reported as hardware: only a proven hardware class is.
    expect(workerMain).toMatch(/kHardware\s*\?\s*imcodes::rd::kEncoderClassHardware\s*:\s*imcodes::rd::kEncoderClassSoftware/);
  });

  it('reports the encoder\'s own dropped-frame count instead of a constant zero', () => {
    expect(workerMain).not.toMatch(/root\["droppedFrames"\]\s*=\s*Json::UInt64\(0\)/);
    expect(workerMain).toContain('Json::UInt64(session_->dropped_frames())');
  });

  it('keeps the shared tokens the web client validates', () => {
    expect(REMOTE_DESKTOP_ENCODER_CLASS.HARDWARE).toBe('hardware');
    expect(REMOTE_DESKTOP_ENCODER_CLASS.SOFTWARE).toBe('software');
    expect(constants).toContain('kEncoderClassHardware[] = "hardware"');
    expect(constants).toContain('kEncoderClassSoftware[] = "software"');
  });

  it('adapters that say nothing change nothing: the defaults are unknown and zero', () => {
    expect(common).toMatch(/virtual EncoderClass ImplementationClass\(\) const noexcept \{\s*return EncoderClass::kUnknown;/);
    expect(common).toMatch(/virtual std::uint64_t DroppedFrames\(\) const noexcept \{\s*return 0;/);
  });

  it('maps the VideoToolbox session kind to the class without inventing hardware', () => {
    expect(encoder).toMatch(/case VideoToolboxEncoderKind::kHardware:\s*return common::EncoderClass::kHardware;/);
    expect(encoder).toMatch(/case VideoToolboxEncoderKind::kQualifiedAppleSoftware:\s*return common::EncoderClass::kSoftware;/);
  });
});
