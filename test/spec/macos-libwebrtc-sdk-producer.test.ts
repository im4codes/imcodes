import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  PINNED_DEPOT_TOOLS_REVISION,
  PINNED_LIBWEBRTC_REVISION,
} from '../../scripts/remote-desktop-worker-artifacts.mjs';
import { libwebrtcSdkTarget } from '../../scripts/libwebrtc-sdk-targets.mjs';

const producer = readFileSync('native/macos-remote-desktop/build-libwebrtc-sdk.sh', 'utf8');
const registry = readFileSync('scripts/libwebrtc-sdk-targets.mjs', 'utf8');
const NOTICES_GENERATOR = 'scripts/generate-macos-libwebrtc-notices.py';

/**
 * The macOS SDK producer runs unattended for hours on a build host nobody is
 * watching. Every assertion below corresponds to a way it has actually failed,
 * and each of those failures looked, from the outside, like the build was
 * simply still working.
 */
describe('macOS libwebrtc SDK producer', () => {
  it('refuses to start without a HOME', () => {
    // depot_tools bootstraps vpython and its CIPD client into HOME. Started
    // with none -- which is what a LaunchDaemon gives you -- `cipd selfupdate`
    // does not fail: it blocks forever, at zero CPU, before the first line of
    // output. The build looks alive and makes no progress at all.
    expect(producer).toMatch(/-n "\$\{HOME:-\}" && -d "\$\{HOME:-\}"/u);
    expect(producer).toMatch(/HOME must be set/u);
  });

  it('configures the gclient solution from the file gclient looks for', () => {
    // `gclient config` must be keyed on `.gclient`, never on the presence of
    // the checkout. An interrupted first run leaves the clone on disk and the
    // solution unwritten, and from then on every run dies with "client not
    // configured" while the checkout sits there looking complete.
    const configured = producer.match(/if \[\[ ! -f "\$CHECKOUT_ROOT\/\.gclient" \]\]; then\n\s*\( cd "\$CHECKOUT_ROOT" && gclient config /u);
    expect(configured).not.toBeNull();
    // And the clone must not be the thing that guards it.
    expect(producer).not.toMatch(/! -d "\$WEBRTC_ROOT\/\.git" \]\]; then[\s\S]{0,200}gclient config/u);
  });

  it('does not claim a vpython bypass it has not spelled correctly', () => {
    // depot_tools honours VPYTHON_BYPASS only for one exact sentence. Any
    // other value is silently ignored, so a bypass that looks set in the
    // script is not in effect -- and the failure surfaces much later, inside
    // the managed Python that was supposed to be skipped.
    const bypass = producer.match(/VPYTHON_BYPASS=(?:'([^']*)'|"([^"]*)")/u);
    if (bypass) {
      expect(bypass[1] ?? bypass[2])
        .toBe('manually managed python not supported by chrome operations');
    }
  });

  it('stays on the pinned revisions the rest of the build agrees on', () => {
    // The SDK's whole value is that it is the same upstream every consumer was
    // compiled against. A producer reading its revisions from anywhere but the
    // shared pin file could publish an SDK no consumer can link.
    expect(producer).toContain('shared/remote-desktop-native-pins.json');
    expect(producer).toContain('libwebrtcRevision');
    expect(producer).toContain('depotToolsRevision');
    expect(PINNED_LIBWEBRTC_REVISION).toMatch(/^[0-9a-f]{40}$/u);
    expect(PINNED_DEPOT_TOOLS_REVISION).toMatch(/^[0-9a-f]{40}$/u);
    // depot_tools rolls itself forward on every invocation unless told not to,
    // which would quietly move the producer off the pin mid-build.
    expect(producer).toContain('DEPOT_TOOLS_UPDATE=0');
  });

  it('bootstraps depot_tools explicitly, since pinning it suppresses that', () => {
    // DEPOT_TOOLS_UPDATE=0 also skips the one-time bootstrap that writes
    // `python3_bin_reldir.txt`, without which depot_tools' `python3` shim
    // refuses to run. Nothing fails at that point: the entire checkout syncs
    // -- twenty-five gigabytes, half an hour -- and only then does a late
    // gclient hook die with "need to initialize depot_tools".
    expect(producer).toContain('python3_bin_reldir.txt');
    expect(producer).toContain('ensure_bootstrap');
  });

  it('opens the //:webrtc visibility seam and puts it back', () => {
    // `//:webrtc` allows only `//:default` and `//:webrtc_lib_link_test` to
    // depend on it, so the SDK target cannot without widening that list. Two
    // properties matter and both are easy to lose:
    //
    // The patch must be restored -- the checkout is shared with the product
    // build and with the other architecture's run, and a leaked edit would
    // make the next `gclient sync` report a dirty tree.
    //
    // And it must be restored LATE. ninja regenerates whenever a BUILD.gn is
    // newer than build.ninja, so restoring between `gn gen` and `ninja` makes
    // the first ninja invocation regenerate against the unpatched file and
    // fail with the same visibility error the patch just fixed.
    expect(producer).toContain('trap restore_root_build EXIT');
    expect(producer).toMatch(/restore_root_build\(\) \{/u);
    expect(producer).toContain('webrtc_lib_link_test');
    // Fail closed: a textual patch that matched twice, or not at all, would
    // build a different graph than the one described here.
    expect(producer).toContain('source.count(needle) != 1');
    // The restore trap must be installed before the graph is generated, or a
    // failure in `gn gen` itself leaks the edit.
    const trapAt = producer.indexOf('trap restore_root_build EXIT');
    // The invocation, not the prose: `gn gen` is named in comments above this
    // point, and matching one of those would assert nothing about ordering.
    const genAt = producer.indexOf('gn gen "$BUILD_DIR"');
    expect(trapAt).toBeGreaterThan(-1);
    expect(genAt).toBeGreaterThan(trapAt);
  });

  it('builds one architecture at a time and refuses any other', () => {
    // The macOS remote-desktop components must be thin: the build plan sets
    // `universalBinary: false` and the runtime verifier rejects a fat Mach-O.
    // A universal SDK would produce components that fail verification on the
    // machine they were installed on.
    expect(producer).toMatch(/case "\$TARGET_CPU" in arm64\|x64\)/u);
    expect(producer).toContain('--target-cpu must be arm64 or x64');
  });

  it('will not take the filesystem root as a directory it is about to erase', () => {
    // `--artifact-root` is removed wholesale before staging.
    expect(producer).toContain('rm -rf "$ARTIFACT_ROOT"');
    expect(producer).toMatch(/"\$directory" != "\/" && "\$directory" == \/\*/u);
  });

  it('ships the C++ runtime the objects were compiled against, as a real archive', () => {
    // libwebrtc.a does not contain libc++: it is linked at the final link
    // step, never archived. Without this every std::__Cr:: symbol -- each
    // std::string method, operator new, __cxa_guard_acquire -- is undefined at
    // a consumer's link, and the system libc++ cannot stand in because those
    // names only exist in Chromium's __Cr inline namespace.
    expect(producer).toContain('libimcodes_macos_libcxx_runtime_sdk.a');
    // The build's own libc++.a is `!<thin>`: a 174KB index of paths into the
    // build directory. Copying it would stage and publish something that
    // references object files which never travel with it.
    expect(producer).toContain('llvm-ar');
    expect(producer).toContain("== '!<arch>'");
    // An unmatched glob expands to the pattern itself, which would archive one
    // nonexistent path instead of failing.
    expect(producer).toMatch(/-f "\$\{LIBCXX_OBJECTS\[0\]\}"/u);
    // And the runtime must be built for the TARGET toolchain. Nothing here
    // links a final binary, so libc++ is never compiled unless asked for by
    // name -- and on an arm64 host building arm64 the omission is invisible,
    // because the host tools' own objects are already the right architecture.
    expect(producer).toContain('buildtools/third_party/libc++:libc++');
    expect(producer).toContain('buildtools/third_party/libc++abi:libc++abi');
  });

  it('ships the compile configuration instead of making consumers guess it', () => {
    // Guessing it does not fail to link. A hand-assembled define set compiled
    // cleanly, linked with zero undefined symbols, and segfaulted inside a
    // WebRTC constructor, because one omitted define changed a struct layout.
    // The anchor target exists so GN records this; nothing else in the SDK
    // carries it.
    expect(producer).toContain('sdk-compile-flags.json');
    expect(producer).toContain('imcodes_macos_libwebrtc_sdk.ninja');
    expect(producer).toContain("'defines', 'include_dirs', 'cflags', 'cflags_cc'");
  });

  it('drops -isysroot together with the path that follows it', () => {
    // They are two tokens. Removing the flag in one pass and its argument in
    // another leaves the path behind as a bare argument, and clang then reads
    // `sdk/xcode_links/MacOSX26.5.sdk` as a source file it cannot open -- which
    // is exactly what the first version did. The macOS SDK is deliberately not
    // carried: it comes from the consumer's own Xcode.
    expect(producer).toContain('DROP_WITH_ARGUMENT');
    expect(producer).toContain('xcode_links');
    // A second pass over the same list is the shape of the bug.
    expect(producer).not.toMatch(/abi_flags = \[flag for flag in abi_flags/u);
  });

  it('refuses a staged archive that is fat or the wrong architecture', () => {
    // The components must be thin; and a cross-compile that quietly staged the
    // host's libc++ would produce an archive that links nowhere.
    expect(producer).toContain('EXPECTED_MACHO_ARCH');
    expect(producer).toContain('staged archive is not thin');
    expect(producer).toMatch(/x64\) EXPECTED_MACHO_ARCH="x86_64"/u);
  });

  it('records the architecture of the compiler it ships, not of the target', () => {
    // Both SDKs are produced on Apple silicon, so the x64 SDK contains an
    // arm64 clang that cross-compiles. That is correct, and it is unusable on
    // an Intel builder -- where it fails with "bad CPU type in executable",
    // an error that says nothing about why. Recording the host architecture is
    // what lets a consumer refuse the SDK by name before it tries to run it.
    expect(producer).toContain('TOOLCHAIN_HOST_ARCH="$(uname -m)"');
    expect(producer).toContain("'hostArch': host_arch");
  });

  it('never discards the error stream of a probe it then requires', () => {
    // One run died in the metadata region leaving a complete staging tree, no
    // sdk-build.json, and not one line of output -- because xcodebuild's
    // stderr went to /dev/null. The cause is still unknown; that it was
    // silent is the defect being fixed here.
    expect(producer).not.toMatch(/xcodebuild[^\n]*2>\/dev\/null/u);
    expect(producer).not.toMatch(/xcrun[^\n]*2>\/dev\/null/u);
    expect(producer).toContain('xcodebuild -version failed');
    expect(producer).toContain('xcrun --show-sdk-version failed');
  });

  it('compiles against the same macOS floor the product declares', () => {
    // 12.3 is chosen for Intel: it is ScreenCaptureKit's actual platform floor,
    // and it keeps Intel Macs stuck on Monterey eligible without a second
    // legacy implementation. The value is declared in code-identity.json and
    // restated in the producer, and the two governing Intel support must not
    // drift -- the SDK would compile for one floor while the product promised
    // another, and every component's LC_BUILD_VERSION comes from the SDK side.
    const identity = JSON.parse(
      readFileSync('native/macos-remote-desktop/code-identity.json', 'utf8'),
    ) as { minimumMacosVersion: string };
    const declared = producer.match(/^MINIMUM_MACOS_VERSION="([^"]+)"$/mu);
    expect(declared).not.toBeNull();
    expect(declared?.[1]).toBe(identity.minimumMacosVersion);
  });

  it('compiles against the floor the product declares, not the host default', () => {
    // Objects built for a newer deployment target assume runtime the product
    // promises to work without. This is the one build argument whose drift
    // would not fail the build, only the machines it ships to.
    expect(producer).toContain('MINIMUM_MACOS_VERSION="12.3"');
    expect(producer).toContain('mac_deployment_target=\\"$MINIMUM_MACOS_VERSION\\"');
  });

  it('generates the notices file the staging contract requires', () => {
    // THIRD_PARTY_NOTICES.webrtc.md is a required top-level staging entry, so
    // an SDK produced without it builds for hours and then fails at publish,
    // after the checkout the rebuild would need has already been reused.
    expect(producer).toContain(NOTICES_GENERATOR);
    expect(producer).toContain('NOTICES_OUTPUT="$ARTIFACT_ROOT/THIRD_PARTY_NOTICES.webrtc.md"');
    expect(libwebrtcSdkTarget('macos-arm64').requiredTopLevelEntries)
      .toContain('THIRD_PARTY_NOTICES.webrtc.md');
  });

  it('asks for the SDK inventory, not the product executables', () => {
    // Passing the four product labels here would certify an archive that
    // contains no IM.codes executable at all, and the generator is fail-closed
    // precisely so that mix-up cannot render.
    const targets = libwebrtcSdkTarget('macos-arm64').noticeTargets;
    expect(targets).toEqual(['//:webrtc']);
    expect(producer).toContain('--target-set sdk');
    for (const target of targets) expect(producer).toContain(`--target "${target}"`);
    expect(producer).not.toContain('imcodes_macos_remote_desktop');
  });

  it('generates notices while the //:webrtc visibility seam is still open', () => {
    // The generator runs `gn desc`, which reloads the whole graph. With the
    // seam closed the overlay's `deps = [ "//:webrtc" ]` is rejected exactly as
    // it is during `gn gen`, so notices generated after an early restore fail
    // with a visibility error that reads like a BUILD.gn bug.
    const trapAt = producer.indexOf('trap restore_root_build EXIT');
    const generateAt = producer.indexOf(`vpython3 "$NOTICES_GENERATOR"`);
    expect(trapAt).toBeGreaterThan(-1);
    expect(generateAt).toBeGreaterThan(trapAt);
    // And the seam is only ever closed by the trap -- an explicit restore
    // before this point would reintroduce the failure the trap exists to avoid.
    expect(producer.indexOf('restore_root_build', generateAt)).toBe(-1);
  });

  it('fails loudly when the generator produces nothing', () => {
    // The generator writes atomically: a failure leaves no file rather than a
    // truncated one. Unchecked, the producer would print "built the macOS
    // libwebrtc SDK" over a staging directory that cannot be published.
    expect(producer).toContain('[[ -s "$NOTICES_OUTPUT" ]]');
    expect(producer).toContain('macOS SDK notices generation produced no output');
  });

  it('normalizes the notices mode, which the uniform-mode pass has already run', () => {
    // Modes are baked into the archive digest. The `find ... chmod 0644` sweep
    // happens before this file exists, so a notices file left at the build
    // account's umask makes two byte-identical builds hash differently.
    const sweepAt = producer.indexOf('find "$ARTIFACT_ROOT" -type f');
    const chmodAt = producer.indexOf('chmod 0644 "$NOTICES_OUTPUT"');
    expect(sweepAt).toBeGreaterThan(-1);
    expect(chmodAt).toBeGreaterThan(sweepAt);
  });

  it('counts the notices generator as part of the SDK it produces', () => {
    // `sourceInputs` IS the SDK's identity. A generator change that altered the
    // notices without changing the fingerprint would leave the published
    // archive and its recorded source hash describing different contents.
    expect(libwebrtcSdkTarget('macos-arm64').sourceInputs).toContain(NOTICES_GENERATOR);
    expect(libwebrtcSdkTarget('macos-x64').sourceInputs).toContain(NOTICES_GENERATOR);
    // The marker that said so is gone, not merely satisfied alongside it.
    expect(registry).not.toContain('TODO(macos-sdk-notices)');
  });
});
