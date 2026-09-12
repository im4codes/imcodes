import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { libwebrtcSdkTarget } from '../../scripts/libwebrtc-sdk-targets.mjs';

const consumer = readFileSync('native/macos-remote-desktop/build-worker-from-sdk.sh', 'utf8');
const componentsBuild = readFileSync('native/macos-remote-desktop/BUILD.gn', 'utf8');

/**
 * The consumer is what makes the SDK worth producing: it builds the shipped
 * macOS components from a published archive, with no WebRTC checkout, no gn
 * and no ninja. Every assertion below is a way it failed while being written.
 */
describe('macOS remote-desktop consumer', () => {
  it('takes its compile flags from the SDK rather than restating them', () => {
    // A hand-assembled flag set compiles cleanly, links with zero undefined
    // symbols, and segfaults inside a WebRTC constructor, because one omitted
    // define changed a struct layout. The SDK records the configuration GN
    // used; the consumer's job is to not have an opinion about it.
    expect(consumer).toContain('sdk-compile-flags.json');
    expect(consumer).toContain('compileFlags');
    expect(consumer).toContain('cxxFlags');
    expect(consumer).toContain('includeDirs');
    expect(consumer).toContain('systemIncludeDirs');
  });

  it('passes those flags through a response file, not a subshell variable', () => {
    // 145 flags re-quoted through `xargs` lose members silently. Dropping the
    // two `-isystem` libc++ paths made every `#include <cstddef>` fail, which
    // reads like a broken toolchain rather than a lost argument.
    expect(consumer).toContain('RESPONSE_FILE');
    expect(consumer).toMatch(/"@\$RESPONSE_FILE"|"@\$rsp"|"@\$main_rsp"/u);
  });

  it('reads the ARC source set out of BUILD.gn instead of listing it again', () => {
    // The two must agree exactly. A file that needs ARC and is compiled
    // without it fails loudly -- `#error ... requires Objective-C ARC` -- but
    // the reverse is silent: manual retain/release compiled under ARC is a
    // lifetime change, not a build error.
    expect(consumer).toContain('fobjc-arc');
    expect(consumer).toContain('BUILD.gn');
    expect(consumer).toContain('the parser is out of date');
    // And BUILD.gn must still be parseable by that parser.
    expect(componentsBuild).toContain('-fobjc-arc');
  });

  it('links the dependencies libwebrtc.a does not contain', () => {
    // Three separate archives, each absent for its own reason: libc++ because
    // it is only linked at a final link and never archived; jsoncpp because
    // `//:webrtc` does not depend on it at all; libbsm because it is a system
    // library BUILD.gn names explicitly for the audit-token reader.
    expect(consumer).toContain('libimcodes_macos_libcxx_runtime_sdk.a');
    expect(consumer).toContain('libjsoncpp.a');
    expect(consumer).toContain('-lbsm');
    // And the SDK must actually ship the two it is expected to carry.
    const required = libwebrtcSdkTarget('macos-arm64').requiredFiles;
    expect(required).toContain('lib/libjsoncpp.a');
    expect(required).toContain('lib/libimcodes_macos_libcxx_runtime_sdk.a');
  });

  it('refuses an SDK whose compiler cannot run on this machine', () => {
    // Both SDKs are cross-compiled on Apple silicon, so the x64 SDK ships an
    // arm64 clang. On an Intel builder the only symptom is "bad CPU type in
    // executable", which says nothing about which of the many binaries failed.
    expect(consumer).toContain('hostArch');
    expect(consumer).toMatch(/cannot run on a \$HOST_ARCH host/u);
  });

  it('builds every shipped component and refuses a fat one', () => {
    // The build plan declares universalBinary = false and the runtime verifier
    // rejects a fat Mach-O, so a universal component would install and then
    // fail verification on the machine it was installed on.
    for (const main of [
      'macos_remote_desktop_worker_main.mm',
      'macos_launch_agent_main.mm',
      'macos_remote_desktop_disclosure_main.mm',
      'macos_virtual_display_helper_main.mm',
    ]) {
      expect(consumer).toContain(main);
    }
    expect(consumer).toContain('is not thin');
    expect(consumer).toContain('lipo -info');
  });

  it('keeps the aiDesk agent and the build spike out of the components', () => {
    // The agent is the app bundle's entry point and links none of this; the
    // spike is a probe. Compiling either into the shared archive would put a
    // second `main` in it.
    expect(consumer).toContain('build_spike.mm');
    expect(consumer).toContain('aidesk_agent_main.mm');
    expect(consumer).toMatch(/EXCLUDED_SOURCES=\(/u);
  });
});
