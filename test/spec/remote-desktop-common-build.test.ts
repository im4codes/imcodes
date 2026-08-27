import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMON = resolve(ROOT, 'native', 'remote-desktop-common');
const MACOS = resolve(ROOT, 'native', 'macos-remote-desktop');

function source(name: string): string {
  return readFileSync(resolve(COMMON, name), 'utf8');
}

describe('remote-desktop common native target', () => {
  const files = readdirSync(COMMON).filter((name) => /\.(?:cc|h)$/.test(name));
  const allSource = files.map((name) => source(name)).join('\n');

  it('declares one platform-neutral source target with every common source', () => {
    const build = source('BUILD.gn');
    expect(build).toContain('source_set("remote_desktop_common")');
    for (const file of files) {
      expect(build, `${file} belongs to the common target`).toContain(`"${file}"`);
    }
  });

  it('does not include operating-system SDK or future Linux backend headers', () => {
    const forbiddenIncludes = [
      /#\s*include\s*[<"][^">]*(?:windows|d3d|dxgi|wrl|mfapi|mfidl|wtsapi)[^">]*[>"]/i,
      /#\s*include\s*[<"][^">]*(?:AppKit|Foundation|ScreenCaptureKit|VideoToolbox|CoreGraphics|CoreVideo)[^">]*[>"]/,
      /#\s*include\s*[<"][^">]*(?:X11|pipewire|libei|portal)[^">]*[>"]/i,
    ];
    for (const pattern of forbiddenIncludes) {
      expect(allSource).not.toMatch(pattern);
    }
  });

  it('requires macOS adapters to name the common target boundary explicitly', () => {
    const commonHeaders = new Set(
      readdirSync(COMMON).filter((name) => name.endsWith('.h')),
    );
    const macosSources = readdirSync(MACOS)
      .filter((name) => /\.(?:cc|h|mm)$/.test(name))
      .map((name) => ({ name, text: readFileSync(resolve(MACOS, name), 'utf8') }));
    for (const { name, text } of macosSources) {
      for (const header of commonHeaders) {
        expect(
          text,
          `${name} must not rely on checkout-specific include search paths for ${header}`,
        ).not.toContain(`#include "${header}"`);
      }
    }
  });

  it('keeps OS-owned native types and compile switches out of the contract', () => {
    for (const token of [
      'HWND',
      'HRESULT',
      'DXGI_',
      'ID3D11',
      'CGDirectDisplayID',
      'CVPixelBuffer',
      'SCStream',
      'xdp_portal',
      'wl_display',
      '_WIN32',
      '__APPLE__',
    ]) {
      expect(allSource, `${token} is adapter-owned`).not.toContain(token);
    }
  });

  it('makes encoded and logical geometry different value types', () => {
    const values = source('value_types.h');
    expect(values).toContain('PixelSize encoded_pixels;');
    expect(values).toContain('LogicalRect logical_input_bounds;');
    expect(values).not.toContain('PixelSize input_bounds');
  });

  it('exposes narrow adapter seams without a generic platform god object', () => {
    const interfaces = source('platform_interfaces.h');
    for (const adapter of [
      'CaptureAdapter',
      'EncoderAdapter',
      'NativeVideoSourceLease',
      'NativeCaptureAdapter',
      'NativeEncoderFactoryAdapter',
      'InputAdapter',
      'ClipboardAdapter',
      'DisplayAdapter',
      'DisclosureAdapter',
      'SessionMonitor',
    ]) {
      expect(interfaces).toContain(`class ${adapter}`);
    }
    expect(interfaces).not.toContain('class DesktopPlatform');
  });

  it('defines migration seams for JSON, ICE ordering and the quality ladder', () => {
    const contracts = source('protocol_contracts.h');
    expect(contracts).toContain('class JsonProtocolCodec');
    expect(contracts).toContain('class IceCandidateQueue');
    expect(contracts).toContain('class QualityLadder');
    expect(contracts).toContain('virtual std::vector<IceCandidate> TakeAll() = 0;');
  });

  it('keeps all controller ownership exclusively inside InputLedger', () => {
    const sessionHeader = source('session_core.h');
    const sessionSource = source('session_core.cc');
    const ledgerHeader = source('input_ledger.h');
    expect(sessionHeader).toContain('InputLedger input_ledger_;');
    for (const duplicatedState of [
      'struct ControllerState',
      'controllers_',
      'key_owners_',
      'button_owners_',
    ]) {
      expect(`${sessionHeader}\n${sessionSource}`).not.toContain(duplicatedState);
      expect(ledgerHeader).toContain(duplicatedState);
    }
  });
});
