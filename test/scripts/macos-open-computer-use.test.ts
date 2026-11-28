import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertUniversalBinaryCompat,
  assertWeakLinkedFramework,
  compareMacosVersions,
  FORBIDDEN_LEGACY_MACOS_SYMBOLS,
  LEGACY_OCU_LOCK_PATH,
  LEGACY_OCU_PATCH_PATH,
  loadUpstreamLock,
  parseMachoMinOsVersions,
} from '../../scripts/build-macos-legacy-open-computer-use.mjs';

const ROOT = resolve(__dirname, '..', '..');
const tempDirs: string[] = [];

function createTempBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'imcodes-ocu-compat-test-'));
  tempDirs.push(dir);
  const bin = join(dir, 'OpenComputerUseLegacy');
  writeFileSync(bin, 'fake-macho');
  return bin;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('macOS 12+ legacy OpenComputerUse builder & CI wiring', () => {
  it('pins the exact MIT upstream commit and macOS 12 compat patch', () => {
    const lock = loadUpstreamLock(LEGACY_OCU_LOCK_PATH);
    expect(lock).toEqual({
      repository: 'https://github.com/iFurySt/open-computer-use.git',
      version: '1.1.6',
      commit: '0da1c69712a64048136419c51aa80b0f68c59104',
      license: 'MIT',
      minMacosVersion: '12.0',
    });
    expect(existsSync(LEGACY_OCU_PATCH_PATH)).toBe(true);
    const patch = readFileSync(LEGACY_OCU_PATCH_PATH, 'utf8');
    expect(patch).toContain('.macOS(.v12)');
    expect(patch).toContain('"-weak_framework", "-Xlinker", "ScreenCaptureKit"');
    expect(patch).toContain('NSBezierPath(rect: dirtyRect).fill()');
    expect(patch).toContain('CGWindowListCreateImage');
    expect(patch).toContain('if #available(macOS 14.0, *)');
    expect(patch).toContain('CADisplayLink');
  });

  it('parses and compares Mach-O minimum macOS versions across load commands', () => {
    expect(compareMacosVersions('12.0', '12.0')).toBe(0);
    expect(compareMacosVersions('12.0', '12.3')).toBe(-1);
    expect(compareMacosVersions('14.0', '12.0')).toBe(1);

    expect(parseMachoMinOsVersions(`
Load command 9
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos 12.0
      sdk 26.5
`)).toEqual(['12.0']);

    expect(parseMachoMinOsVersions(`
Load command 9
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version 10.15
      sdk 14.0
`)).toEqual(['10.15']);
  });

  it('enforces weak-linked ScreenCaptureKit and rejects hard-linked references', () => {
    expect(() => assertWeakLinkedFramework(
      '\t/System/Library/Frameworks/ScreenCaptureKit.framework/Versions/A/ScreenCaptureKit (compatibility version 1.0.0, current version 1.0.0, weak)\n',
      'ScreenCaptureKit',
    )).not.toThrow();

    expect(() => assertWeakLinkedFramework(
      '\t/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit (compatibility version 45.0.0, current version 2685.0.0)\n',
      'ScreenCaptureKit',
    )).not.toThrow();

    expect(() => assertWeakLinkedFramework(
      '\t/System/Library/Frameworks/ScreenCaptureKit.framework/Versions/A/ScreenCaptureKit (compatibility version 1.0.0, current version 1.0.0)\n',
      'ScreenCaptureKit',
    )).toThrow(/weak-linked/u);
  });

  it('validates Universal 2 slices, rejects minos > 12.0, forbidden AppKit symbols, and hard-linked ScreenCaptureKit', () => {
    const bin = createTempBinary();
    const okTool = (file: string, args: readonly string[]) => {
      if (file === '/usr/bin/lipo') return '';
      if (file === '/usr/bin/otool' && args.includes('-l')) {
        return '      cmd LC_BUILD_VERSION\n    minos 12.0\n      sdk 26.5\n';
      }
      if (file === '/usr/bin/nm') return '_NSLog\n';
      if (file === '/usr/bin/otool' && args.includes('-L')) {
        return '\t/System/Library/Frameworks/ScreenCaptureKit.framework/Versions/A/ScreenCaptureKit (compatibility version 1.0.0, current version 1.0.0, weak)\n';
      }
      return '';
    };

    expect(() => assertUniversalBinaryCompat({ binaryPath: bin, maxMinos: '12.0', runTool: okTool })).not.toThrow();

    // Reject minos 14.0 on x86_64 slice
    expect(() => assertUniversalBinaryCompat({
      binaryPath: bin,
      maxMinos: '12.0',
      runTool: (file, args) => {
        if (file === '/usr/bin/otool' && args.includes('-l') && args.includes('x86_64')) {
          return '      cmd LC_BUILD_VERSION\n    minos 14.0\n      sdk 26.5\n';
        }
        return okTool(file, args);
      },
    })).toThrow(/announces minos 14\.0, expected <= 12\.0/u);

    // Reject crashing AppKit CGRect.fill symbol
    expect(() => assertUniversalBinaryCompat({
      binaryPath: bin,
      maxMinos: '12.0',
      runTool: (file, args) => {
        if (file === '/usr/bin/nm' && args.includes('x86_64')) {
          return `${FORBIDDEN_LEGACY_MACOS_SYMBOLS[0]}\n`;
        }
        return okTool(file, args);
      },
    })).toThrow(/forbidden macOS 14\+ symbol/u);

    // Reject hard-linked ScreenCaptureKit
    expect(() => assertUniversalBinaryCompat({
      binaryPath: bin,
      maxMinos: '12.0',
      runTool: (file, args) => {
        if (file === '/usr/bin/otool' && args.includes('-L') && args.includes('x86_64')) {
          return '\t/System/Library/Frameworks/ScreenCaptureKit.framework/Versions/A/ScreenCaptureKit (compatibility version 1.0.0, current version 1.0.0)\n';
        }
        return okTool(file, args);
      },
    })).toThrow(/weak-linked/u);
  });

  it('wires macOS legacy OCU build before build:node-exe in ci.yml and build-node-exe.yml without altering official upstream copy', () => {
    for (const file of ['.github/workflows/ci.yml', '.github/workflows/build-node-exe.yml']) {
      const workflow = readFileSync(join(ROOT, file), 'utf8');
      const buildLegacy = workflow.indexOf('node scripts/build-macos-legacy-open-computer-use.mjs');
      const buildExe = workflow.indexOf('run: npm run build:node-exe');
      expect(buildLegacy, file).toBeGreaterThan(-1);
      expect(buildExe, file).toBeGreaterThan(buildLegacy);
      expect(workflow, file).toContain('IMCODES_MACOS_LEGACY_OCU_BINARY=');
      expect(workflow, file).toContain('IMCODES_REQUIRE_MACOS_LEGACY_OCU=1');
    }

    const copyHelper = readFileSync(join(ROOT, 'scripts', 'copy-computer-use-helper.mjs'), 'utf8');
    expect(copyHelper).toContain("const macosBundleId = 'com.ifuryst.opencomputeruse'");
    expect(copyHelper).toContain("const macosTeamId = 'J9P29FA5BX'");

    const onboardingHeader = readFileSync(join(ROOT, 'native', 'macos-remote-desktop', 'macos_permission_onboarding.h'), 'utf8');
    const onboardingMm = readFileSync(join(ROOT, 'native', 'macos-remote-desktop', 'macos_permission_onboarding.mm'), 'utf8');
    expect(onboardingHeader).toContain('kAiDeskComputerUseLegacyHelperName[] =');
    expect(onboardingHeader).toContain('"OpenComputerUseLegacy"');
    expect(onboardingMm).toContain('SelectComputerUseHelperNameForDarwinRelease');
    expect(onboardingMm).toContain('::uname(&system_info)');
    expect(onboardingMm).toContain('major >= 21 && major < 23');
  });
});
