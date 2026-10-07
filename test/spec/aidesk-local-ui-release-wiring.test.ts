/**
 * The native aiDesk window is built, described and uploaded by the SAME release steps in both workflows (one composite action), from
 * pinned sources, and signed (Windows) before its manifest records it. The Linux build below was also run for real in a container.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('native aiDesk window release wiring', () => {
  const action = read('.github/actions/build-aidesk-ui/action.yml');

  it('both release workflows run the one composite action right before the node executable build and upload its output', () => {
    for (const path of ['.github/workflows/build-node-exe.yml', '.github/workflows/ci.yml']) {
      const workflow = read(path);
      const stepAt = workflow.indexOf('uses: ./.github/actions/build-aidesk-ui');
      const buildAt = workflow.indexOf('run: npm run build:node-exe');
      expect(stepAt, path).toBeGreaterThan(-1);
      expect(stepAt, path).toBeLessThan(buildAt);
      expect(workflow.match(/build-aidesk-ui/gu), path).toHaveLength(1);
      expect(workflow, path).toContain('dist-node-exe/aidesk-local-ui/**');
      expect(workflow, path).toContain('windows-signing-cert-thumbprint: ${{ env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT }}');
      // the Windows signing identity is imported by an earlier step of the same job
      expect(workflow.indexOf('Import Windows release-signing certificate'), path).toBeLessThan(stepAt);
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
