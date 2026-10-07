/**
 * The native aiDesk window (Layer 2) is DEFERRED: the panel page is the one UI, shown in the app window and in the browser fallback.
 * Its pinned-source build action and scripts are kept, ready, but are NOT wired into either release workflow and nothing is added to
 * the artifact set; the checks below keep the unwired action internally consistent (pinned sources, signing order, macOS packaging)
 * so wiring it later is a two-step change (one step per workflow + the upload glob), and pin that nothing wires it by accident.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('native aiDesk window release wiring', () => {
  const action = read('.github/actions/build-aidesk-ui/action.yml');

  it('is not wired into either release workflow and adds nothing to the artifact set (deferred; the panel page is the only UI)', () => {
    for (const path of ['.github/workflows/build-node-exe.yml', '.github/workflows/ci.yml']) {
      const workflow = read(path);
      expect(workflow, path).not.toContain('build-aidesk-ui');
      expect(workflow, path).not.toContain('aidesk-local-ui/**');
    }
  });

  it('builds from the pinned, verified sources only (build time), with the same package set that was exercised on Linux', () => {
    expect(action).toContain('node scripts/fetch-aidesk-ui-deps.mjs');
    expect(action).not.toMatch(/curl|wget|Invoke-WebRequest/iu);
    for (const library of ['libx11-dev', 'libxft-dev', 'libxext-dev', 'libxinerama-dev', 'libxcursor-dev', 'libxfixes-dev', 'libxrender-dev', 'libfontconfig1-dev', 'libpng-dev', 'libjpeg-dev', 'zlib1g-dev', 'ninja-build']) {
      expect(action).toContain(library);
    }
  });

  it('Windows signs and verifies the executable BEFORE the manifest records its hash; the manifest names the release signer', () => {
    const signAt = action.indexOf('-Mode Sign');
    const verifyAt = action.indexOf('-Mode Verify');
    const writeAt = action.indexOf('aidesk-ui-artifact.mjs write $art win32 x64');
    expect(signAt).toBeGreaterThan(-1);
    expect(signAt).toBeLessThan(verifyAt);
    expect(verifyAt).toBeLessThan(writeAt);
    expect(action).toContain('$env:AIDESK_SIGNER_SHA256');
    expect(action).toContain("throw 'The Windows release-signing certificate must be imported");
  });

  it('macOS builds a universal binary and hands it to the app bundle build (which copies it into Contents/Helpers and signs it)', () => {
    expect(action).toContain('CMAKE_OSX_ARCHITECTURES: arm64;x86_64');
    expect(action).toContain('AIDESK_LOCAL_UI_EXECUTABLE=$BIN');
    expect(action).toContain('lipo -archs');
    const packager = read('scripts/build-aidesk-app.mjs');
    expect(packager).toContain('process.env.AIDESK_LOCAL_UI_EXECUTABLE');
    expect(packager).toContain("join(bundlePath, 'Contents', AIDESK_HELPERS_DIR, AIDESK_LOCAL_UI_EXECUTABLE)");
  });

  it('system image libraries are linked only on Linux; macOS and Windows use FLTK\'s own statically linked copies', () => {
    const cmake = read('native/aidesk-ui/CMakeLists.txt');
    expect(cmake).toMatch(/if\(UNIX AND NOT APPLE\)\s+set\(OPTION_USE_SYSTEM_LIBJPEG ON/u);
    expect(cmake).toMatch(/else\(\)\s+set\(OPTION_USE_SYSTEM_LIBJPEG OFF/u);
  });

  it('the pinned source lock is what the CMake build and the FLTK licence expect', () => {
    const lock = JSON.parse(read('native/aidesk-ui/dependencies.lock.json')) as { dependencies: Record<string, { version: string; sha256: string }> };
    expect(lock.dependencies.fltk?.version).toBe('1.4.5');
    expect(lock.dependencies.fltk?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(lock.dependencies.jsoncpp?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(read('native/aidesk-ui/CMakeLists.txt')).toContain('Pinned FLTK 1.4.5 source root');
  });
});
