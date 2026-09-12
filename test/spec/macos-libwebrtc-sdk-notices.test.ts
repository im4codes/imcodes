import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MACOS_LIBWEBRTC_NOTICE_TARGETS,
  validateMacosLibwebrtcNotices,
} from '../../scripts/libwebrtc-sdk-artifacts.mjs';
import { libwebrtcSdkTarget } from '../../scripts/libwebrtc-sdk-targets.mjs';
import { PINNED_LIBWEBRTC_REVISION } from '../../shared/remote-desktop-native-pins.js';

const execute = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, '../..');
const generator = join(repositoryRoot, 'scripts/generate-macos-libwebrtc-notices.py');
const sdkNoticeTargets = libwebrtcSdkTarget('macos-arm64').noticeTargets;
const roots: string[] = [];

/**
 * A checkout stub shaped like the pinned one: the upstream license mapping the
 * generator reads, the license files it dereferences, and a `gn` that prints one
 * dependency label. The redistributed toolchain trees are mapped the way the
 * pinned checkout maps them -- `compiler-rt` and `libc++` from upstream's own
 * dictionary, `googletest` and `llvm-toolchain` from the generator's local one.
 */
async function fixture(options: { dependency?: string; upstream?: string[] } = {}) {
  const dependency = options.dependency ?? '//third_party/example:example';
  const upstream = options.upstream ?? [
    "'example': ['third_party/example/LICENSE']",
    "'compiler-rt': ['third_party/compiler-rt/src/LICENSE.TXT']",
    "'libc++': ['third_party/libc++/src/LICENSE.TXT']",
  ];
  const root = await mkdtemp(join(tmpdir(), 'imcodes-macos-sdk-notices-'));
  roots.push(root);
  const webrtc = join(root, 'webrtc');
  const build = join(webrtc, 'out/release');
  const gn = join(root, 'gn');
  const output = join(root, 'THIRD_PARTY_NOTICES.webrtc.md');
  const licenses = [
    ['LICENSE', 'WebRTC license'],
    ['third_party/example/LICENSE', 'Example license'],
    ['third_party/compiler-rt/src/LICENSE.TXT', 'LLVM Apache-2.0 with exceptions'],
    ['third_party/libc++/src/LICENSE.TXT', 'libc++ license'],
    ['third_party/googletest/src/LICENSE', 'googletest BSD-3-Clause'],
  ];
  await mkdir(join(webrtc, 'tools_webrtc/libs'), { recursive: true });
  await mkdir(build, { recursive: true });
  for (const [relative] of licenses) {
    const index = relative.lastIndexOf('/');
    if (index !== -1) await mkdir(join(webrtc, relative.slice(0, index)), { recursive: true });
  }
  await Promise.all([
    ...licenses.map(([relative, text]) => writeFile(join(webrtc, relative), `${text}\n`)),
    writeFile(join(webrtc, 'tools_webrtc/libs/generate_licenses.py'), [
      `LIB_TO_LICENSES_DICT = {${upstream.join(', ')}}`,
      'LIB_REGEX_TO_LICENSES_DICT = {}',
      '',
    ].join('\n')),
    writeFile(gn, `#!/bin/sh\nprintf '%s\\n' '${dependency}' '//third_party/imcodes_macos_remote_desktop:owned'\n`),
  ]);
  await chmod(gn, 0o755);
  return { root, webrtc, build, gn, output };
}

function graphArguments(value: Awaited<ReturnType<typeof fixture>>, targets: readonly string[]) {
  return [
    generator,
    '--webrtc-root', value.webrtc,
    '--build-directory', value.build,
    '--gn', value.gn,
    '--revision', PINNED_LIBWEBRTC_REVISION,
    ...targets.flatMap((target) => ['--target', target]),
    '--output', value.output,
  ];
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * The SDK's notices cover a different set of bytes than the product's: one
 * upstream archive plus a redistributed LLVM toolchain, rather than four
 * IM.codes executables. Both inventories come out of one generator, and the
 * failure mode that matters is the quiet one -- notices that render, validate,
 * and describe something the archive does not contain.
 */
describe('macOS SDK pinned libwebrtc notices', () => {
  it('certifies the archive the SDK actually ships, not the overlay wrapper', async () => {
    // `//:webrtc` is declared complete_static_lib, so GN never re-expands it and
    // the producer's overlay archive holds one anchor object. Describing the
    // overlay would emit a notice file that validates and covers nothing, while
    // `obj/libwebrtc.a` -- the 400MB payload that is actually staged -- went
    // unreported.
    expect(sdkNoticeTargets).toEqual(['//:webrtc']);
    const value = await fixture();
    await execute('python3', [...graphArguments(value, sdkNoticeTargets), '--target-set', 'sdk']);
    const notices = await readFile(value.output, 'utf8');
    expect(notices).toContain('targets=//:webrtc');
    expect(validateMacosLibwebrtcNotices(notices, PINNED_LIBWEBRTC_REVISION, sdkNoticeTargets))
      .toBe(notices);
  });

  it('covers the redistributed toolchain, which no GN edge accounts for', async () => {
    // clang, ld64.lld, llvm-ar, llvm-strip, libclang_rt.osx.a and the bundled
    // libc++ headers are staged into the SDK by the producer's own `cp`, not by
    // any dependency of `//:webrtc`. A graph-derived inventory alone therefore
    // ships LLVM-licensed binaries with no LLVM notice at all -- the exact gap
    // the Windows SDK generator closes with REQUIRED_REDISTRIBUTED_LIBRARIES.
    const value = await fixture();
    await execute('python3', [...graphArguments(value, sdkNoticeTargets), '--target-set', 'sdk']);
    const notices = await readFile(value.output, 'utf8');
    expect(notices).toContain('libraries=webrtc,compiler-rt,example,googletest,libc++,llvm-toolchain');
    for (const section of ['compiler-rt', 'googletest', 'libc++', 'llvm-toolchain']) {
      expect(notices).toContain(`# ${section}\n`);
    }
  });

  it('refuses to ship when a redistributed tree loses its license mapping', async () => {
    // A pin that drops or empties an upstream mapping entry must stop the
    // build. The renderer silently skips a library mapped to an empty list, so
    // without this check the LLVM notice would simply vanish from a file that
    // still validates.
    const value = await fixture({
      upstream: ["'example': ['third_party/example/LICENSE']", "'compiler-rt': []"],
    });
    await expect(execute('python3', [
      ...graphArguments(value, sdkNoticeTargets), '--target-set', 'sdk',
    ])).rejects.toThrow(/no license mapping: compiler-rt, libc\+\+/u);
    await expect(readFile(value.output)).rejects.toThrow();
  });

  it('will not certify one target set with the other set\'s labels', async () => {
    // The two inventories are not interchangeable. Emitting the product labels
    // into an SDK archive would claim it contains IM.codes executables; emitting
    // `//:webrtc` into the product build would under-report every tree reached
    // only through remote-desktop-common.
    const value = await fixture();
    await expect(execute('python3', [
      ...graphArguments(value, MACOS_LIBWEBRTC_NOTICE_TARGETS), '--target-set', 'sdk',
    ])).rejects.toThrow(/requires exactly these targets/u);
    await expect(execute('python3', [
      ...graphArguments(value, sdkNoticeTargets), '--target-set', 'product',
    ])).rejects.toThrow(/requires exactly these targets/u);
  });

  it('rejects an unknown target set instead of trusting the labels it was given', async () => {
    // Fail-closed is the whole contract: a typo'd or invented set must not
    // degrade into "certify whatever --target says", which would let any label
    // list mint a notice file that downstream validation accepts.
    const value = await fixture();
    await expect(execute('python3', [
      ...graphArguments(value, sdkNoticeTargets), '--target-set', 'everything',
    ])).rejects.toThrow(/unknown macOS notice target set/u);
  });

  it('keeps the product inventory out of the SDK validator and vice versa', async () => {
    // The staged-notices check picks its expected inventory from the target
    // registry. If that plumbing regressed to the product default, an SDK built
    // with correct notices would fail publishing, and -- worse -- a product
    // notice file dropped into an SDK would pass.
    const value = await fixture();
    await execute('python3', [...graphArguments(value, sdkNoticeTargets), '--target-set', 'sdk']);
    const notices = await readFile(value.output, 'utf8');
    expect(() => validateMacosLibwebrtcNotices(notices, PINNED_LIBWEBRTC_REVISION))
      .toThrow(/target inventory mismatch/u);
    expect(() => validateMacosLibwebrtcNotices(notices, PINNED_LIBWEBRTC_REVISION, []))
      .toThrow(/no expected target inventory/u);
  });

  it('still defaults to the product inventory for callers that predate the SDK', async () => {
    // `--target-set` and the validator's third argument both default to the
    // product list. The native build gate passes neither, and a default flip
    // would break the shipped product notices rather than the new SDK ones.
    const value = await fixture();
    await execute('python3', graphArguments(value, MACOS_LIBWEBRTC_NOTICE_TARGETS));
    const notices = await readFile(value.output, 'utf8');
    expect(validateMacosLibwebrtcNotices(notices, PINNED_LIBWEBRTC_REVISION)).toBe(notices);
    expect(notices).toContain(`targets=${MACOS_LIBWEBRTC_NOTICE_TARGETS.join(',')}`);
    // And the product inventory must not silently acquire the SDK's
    // redistributed toolchain: the product ships executables, not a compiler.
    expect(notices).toContain('libraries=webrtc,example');
  });
});
