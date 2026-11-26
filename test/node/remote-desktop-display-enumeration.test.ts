import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('remote desktop physical display enumeration', () => {
  it('trusts the DXGI attached-to-desktop contract without requiring monitor children', () => {
    const source = readFileSync(resolve(
      process.cwd(),
      'native/windows-remote-desktop/display_capture.cc',
    ), 'utf8');

    // Windows 10 + Intel HD 4000 can expose an attached primary DXGI output
    // while EnumDisplayDevices(adapter, ...) returns no child monitor. Gating
    // the DXGI output on that unrelated legacy enumeration makes a live
    // desktop look headless and prevents WebRTC from ever producing an answer.
    expect(source).toContain(
      'if (FAILED(output->GetDesc(&desc)) || !desc.AttachedToDesktop) continue;',
    );
    expect(source).not.toContain('HasActiveMonitorTarget');
    expect(source).not.toContain('EnumDisplayDevicesW(device_name');
  });
});
