import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LIBWEBRTC_SDK_ARCHIVE_FILENAME,
  LIBWEBRTC_SDK_MANIFEST_FILENAME,
  computeLibwebrtcSdkSourceSha256,
  createLibwebrtcSdkLock,
  createLibwebrtcSdkManifest,
  validateLibwebrtcSdkNotices,
  validateLibwebrtcSdkLock,
  validateLibwebrtcSdkManifest,
  verifyLibwebrtcSdkDirectory,
  verifyLibwebrtcSdkLock,
} from '../../scripts/libwebrtc-sdk-artifacts.mjs';
import {
  PINNED_DEPOT_TOOLS_REVISION,
  PINNED_LIBWEBRTC_REVISION,
} from '../../scripts/remote-desktop-worker-artifacts.mjs';

const roots: string[] = [];
const requiredFiles = [
  'lib/imcodes_libwebrtc_sdk.lib',
  'lib/imcodes_libwebrtc_test_sdk.lib',
  'lib/imcodes_libcxx_runtime_sdk.lib',
  'toolchain/manifest/as_invoker.manifest',
  'toolchain/manifest/common_controls.manifest',
  'toolchain/manifest/compatibility.manifest',
  'toolchain/bin/clang-cl.exe',
  'toolchain/bin/lld-link.exe',
  'toolchain/bin/llvm-ml.exe',
  'toolchain/lib/clang_rt.builtins-x86_64.lib',
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'imcodes-libwebrtc-sdk-test-'));
  roots.push(root);
  const sdk = join(root, 'sdk');
  for (const directory of ['gen', 'include', 'lib', 'toolchain/bin', 'toolchain/lib', 'toolchain/manifest']) {
    await mkdir(join(sdk, directory), { recursive: true });
  }
  await Promise.all([
    writeFile(join(sdk, 'THIRD_PARTY_NOTICES.webrtc.md'), [
      '# webrtc', '```', 'webrtc license', '```', '',
      '# compiler-rt', '```', 'compiler runtime license', '```', '',
      '# googletest', '```', 'googletest license', '```', '',
      '# libc++', '```', 'libc++ license', '```', '',
      '# llvm-toolchain', '```', 'LLVM toolchain license', '```', '',
    ].join('\n')),
    writeFile(join(sdk, 'include', 'api.h'), 'header'),
    writeFile(join(sdk, 'gen', 'generated.h'), 'generated'),
    writeFile(join(sdk, 'sdk-build.json'), JSON.stringify({
      manifestVersion: 1,
      os: 'win32',
      arch: 'x64',
      libwebrtcRevision: PINNED_LIBWEBRTC_REVISION,
      depotToolsRevision: PINNED_DEPOT_TOOLS_REVISION,
      buildArgs: 'target_os=\\"win\\" target_cpu=\\"x64\\" is_debug=false is_component_build=false rtc_include_tests=true rtc_build_examples=false rtc_enable_protobuf=false use_rtti=false',
      toolchain: {
        msvc: '14.44.35207',
        windowsSdk: '10.0.26100.0',
        clang: 'llvmorg-23-init-19482-g53d18800-1',
      },
    })),
    ...requiredFiles.map((path) => writeFile(join(sdk, ...path.split('/')), `bytes:${path}`)),
  ]);
  return { root, sdk };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('fixed libwebrtc foundation SDK artifacts', () => {
  it('requires complete notices for every separately redistributed dependency', () => {
    const complete = [
      '# webrtc', '```', 'webrtc license', '```', '',
      '# compiler-rt', '```', 'compiler runtime license', '```', '',
      '# googletest', '```', 'googletest license', '```', '',
      '# libc++', '```', 'libc++ license', '```', '',
      '# llvm-toolchain', '```', 'LLVM toolchain license', '```', '',
    ].join('\n');
    expect(validateLibwebrtcSdkNotices(complete)).toBe(complete);
    expect(() => validateLibwebrtcSdkNotices(complete.replace('# googletest', '# omitted')))
      .toThrow('missing googletest');
    expect(() => validateLibwebrtcSdkNotices(complete.replace('LLVM toolchain license', '')))
      .toThrow('empty llvm-toolchain');
  });
  it('manifests only the stable dependency SDK and verifies every file', async () => {
    const { sdk } = await fixture();
    const sourceSha256 = await computeLibwebrtcSdkSourceSha256();
    const result = await createLibwebrtcSdkManifest(sdk, '1'.repeat(40));

    expect(result.manifest).toMatchObject({
      manifestVersion: 2,
      sourceSha256,
      sourceCommit: '1'.repeat(40),
      libwebrtcRevision: PINNED_LIBWEBRTC_REVISION,
    });
    expect(result.manifest.files.map((entry: { path: string }) => entry.path))
      .toEqual(expect.arrayContaining(requiredFiles));
    expect(result.manifest.files.map((entry: { path: string }) => entry.path))
      .not.toContain('imcodes-remote-desktop-worker.exe');
  });

  it('can regenerate the same SDK manifest after an interrupted publication', async () => {
    const { sdk } = await fixture();
    const first = await createLibwebrtcSdkManifest(sdk, '1'.repeat(40));
    const second = await createLibwebrtcSdkManifest(sdk, '1'.repeat(40));

    expect(second.manifest).toEqual(first.manifest);
    expect(second.manifest.files.map((entry: { path: string }) => entry.path))
      .not.toContain(LIBWEBRTC_SDK_MANIFEST_FILENAME);
  });

  it('does not fingerprint product, driver, signing, or SDK transport files', async () => {
    const expected = await computeLibwebrtcSdkSourceSha256();
    for (const implementationPath of [
      'native/windows-remote-desktop/quality_ladder.cc',
      'native/windows-remote-desktop/BUILD.gn',
      'native/windows-virtual-display/imcodes-virtual-display.inf',
      'scripts/windows-sign-release-artifact.ps1',
      'scripts/publish-libwebrtc-sdk.mjs',
      'scripts/windows-libwebrtc-sdk-archive.ps1',
    ]) {
      const original = await readFile(implementationPath);
      try {
        await writeFile(implementationPath, Buffer.concat([original, Buffer.from('\n// product-only mutation\n')]));
        await expect(computeLibwebrtcSdkSourceSha256()).resolves.toBe(expected);
      } finally {
        await writeFile(implementationPath, original);
      }
    }
  });

  it('fingerprints the dependency-only GN contract and shared revision pins', async () => {
    const expected = await computeLibwebrtcSdkSourceSha256();
    for (const dependencyInput of [
      'shared/remote-desktop-native-pins.json',
      'native/windows-remote-desktop/sdk.BUILD.gn',
      'native/windows-remote-desktop/libwebrtc-sdk.gni',
    ]) {
      const original = await readFile(dependencyInput);
      try {
        await writeFile(dependencyInput, Buffer.concat([original, Buffer.from('\n')]));
        await expect(computeLibwebrtcSdkSourceSha256()).resolves.not.toBe(expected);
      } finally {
        await writeFile(dependencyInput, original);
      }
    }
  });

  it('normalizes every SDK fingerprint input across platforms', async () => {
    for (const script of [
      'shared/remote-desktop-native-pins.json',
      'native/windows-remote-desktop/sdk.BUILD.gn',
      'native/windows-remote-desktop/libwebrtc-sdk.gni',
      'native/windows-remote-desktop/build-libwebrtc-sdk.ps1',
    ]) {
      const original = await readFile(script);
      const expected = await computeLibwebrtcSdkSourceSha256();
      try {
        await writeFile(script, original.toString('utf8').replace(/\r?\n/g, '\r\n'));
        await expect(computeLibwebrtcSdkSourceSha256()).resolves.toBe(expected);
      } finally {
        await writeFile(script, original);
      }
    }
  });

  it('fails closed on tampering, extra entries, source mismatch, and lock changes', async () => {
    const { root, sdk } = await fixture();
    await createLibwebrtcSdkManifest(sdk, '2'.repeat(40));
    await writeFile(join(sdk, 'lib', 'imcodes_libwebrtc_sdk.lib'), 'tampered');
    await expect(verifyLibwebrtcSdkDirectory(sdk)).rejects.toThrow('does not match');

    const next = await fixture();
    await createLibwebrtcSdkManifest(next.sdk, '3'.repeat(40));
    await writeFile(join(next.sdk, 'unexpected.txt'), 'unexpected');
    await expect(verifyLibwebrtcSdkDirectory(next.sdk)).rejects.toThrow('unexpected top-level');

    const clean = await fixture();
    await createLibwebrtcSdkManifest(clean.sdk, '4'.repeat(40));
    const manifest = JSON.parse(await readFile(join(clean.sdk, LIBWEBRTC_SDK_MANIFEST_FILENAME), 'utf8'));
    expect(() => validateLibwebrtcSdkManifest({ ...manifest, sourceSha256: 'f'.repeat(64) }, manifest.sourceSha256))
      .toThrow('invalid libwebrtc SDK manifest');

    const archive = join(root, LIBWEBRTC_SDK_ARCHIVE_FILENAME);
    const lockPath = join(root, 'lock.json');
    await writeFile(archive, 'fixed-sdk-archive');
    const lock = await createLibwebrtcSdkLock(archive, clean.sdk, lockPath);
    await expect(verifyLibwebrtcSdkLock(lockPath, archive, clean.sdk)).resolves.toEqual(lock);
    await writeFile(archive, 'changed-sdk-archive');
    await expect(verifyLibwebrtcSdkLock(lockPath, archive)).rejects.toThrow('does not match');
    expect(() => validateLibwebrtcSdkLock({ ...lock, releaseTag: 'latest' }, lock.sourceSha256))
      .toThrow('invalid libwebrtc SDK lock');
  });

  it('binds the generated lock to the manifest and archive digest', async () => {
    const { root, sdk } = await fixture();
    await createLibwebrtcSdkManifest(sdk, '5'.repeat(40));
    const archive = join(root, LIBWEBRTC_SDK_ARCHIVE_FILENAME);
    const lockPath = join(root, 'lock.json');
    const bytes = Buffer.from('immutable archive');
    await writeFile(archive, bytes);
    const lock = await createLibwebrtcSdkLock(archive, sdk, lockPath);

    expect(lock).toMatchObject({
      manifestVersion: 2,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sourceCommit: '5'.repeat(40),
      libwebrtcRevision: PINNED_LIBWEBRTC_REVISION,
      depotToolsRevision: PINNED_DEPOT_TOOLS_REVISION,
    });
  });
});
