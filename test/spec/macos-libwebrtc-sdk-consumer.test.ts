import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { libwebrtcSdkTarget } from '../../scripts/libwebrtc-sdk-targets.mjs';
import { readSource } from '../helpers/read-source.js';

const consumer = readSource('native/macos-remote-desktop/build-worker-from-sdk.sh');
const componentsBuild = readSource('native/macos-remote-desktop/BUILD.gn');

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

  it('puts the deployment target on the link line and reads it back', () => {
    // Compiling with `-mmacos-version-min` is not enough. Without it when
    // LINKING, the linker writes LC_BUILD_VERSION from its own default -- the
    // host SDK -- and the component announces `minos 26.0`: a binary that
    // refuses to launch on every macOS older than the build machine's. It
    // builds, it runs on the builder, and it is broken for almost everyone.
    // Specifically on the link invocation, not merely defined somewhere: the
    // whole defect is that it was present when compiling and absent when
    // linking.
    expect(consumer).toMatch(
      /-isysroot "\$SYSROOT" "\$DEPLOYMENT_TARGET_FLAG"[\s\S]{0,80}-fuse-ld=lld/u,
    );
    expect(consumer).toContain('-mmacos-version-min');
    // Taken from the SDK's recorded flags, so the objects and the load command
    // cannot disagree, and never hardcoded here.
    expect(consumer).not.toMatch(/-mmacos-version-min=\d/u);
    // And read back out of the Mach-O: a flag on the command line is not
    // evidence that the load command carries it.
    expect(consumer).toContain('otool -l');
    expect(consumer).toContain('announces minos');
  });

  it('keeps the aiDesk agent and the build spike out of the components', () => {
    // The agent is the app bundle's entry point and links none of this; the
    // spike is a probe. Compiling either into the shared archive would put a
    // second `main` in it.
    expect(consumer).toContain('build_spike.mm');
    expect(consumer).toContain('aidesk_agent_main.mm');
    expect(consumer).toMatch(/EXCLUDED_SOURCES=\(/u);
  });

  it('never compiles an ARC-only source without ARC: it is a BUILD.gn ARC target, or excluded from the worker glob', () => {
    // The worker script globs native/macos-remote-desktop/*.mm. A file that needs ARC (the aiDesk panel window uses __weak) and is not one
    // of BUILD.gn's -fobjc-arc sources would be compiled without it there and fail the whole worker build -- which is how a source that
    // belongs only to the app bundle once broke the macOS CI.
    const directory = 'native/macos-remote-desktop';
    const arc = new Set<string>();
    for (const match of componentsBuild.matchAll(/^\w+\("([^"]+)"\) \{([\s\S]*?)\n\}/gmu)) {
      if (!match[2]!.includes('fobjc-arc')) continue;
      const sources = /sources = \[([\s\S]*?)\]/u.exec(match[2]!);
      for (const name of sources?.[1]!.match(/"([^"]+)"/gu) ?? []) if (name.endsWith('.mm"')) arc.add(name.slice(1, -1));
    }
    expect(arc.size).toBeGreaterThan(10);
    const excluded = new Set(/EXCLUDED_SOURCES=\(([^)]*)\)/u.exec(consumer)?.[1]?.split(/\s+/u).filter(Boolean));
    // A source that REQUIRES ARC (__weak, __bridge_transfer, an explicit #error) and is not a BUILD.gn ARC target would be compiled
    // without it by the glob; the older manual-retain/release sources outside BUILD.gn's list are written for that and unaffected.
    const needsArc = /__weak|__bridge_transfer|__autoreleasing|requires Objective-C ARC/u;
    const wronglyCompiled = readdirSync(directory)
      .filter((name) => name.endsWith('.mm') && !arc.has(name) && !excluded.has(name))
      .filter((name) => needsArc.test(readSource(`${directory}/${name}`)));
    expect(wronglyCompiled, 'needs ARC but build-worker-from-sdk.sh compiles it without: add to BUILD.gn (with -fobjc-arc) or to EXCLUDED_SOURCES').toEqual([]);
    // every source of the aiDesk app build that the worker does not own must be excluded from the worker build
    const agent = JSON.parse(readSource(`${directory}/aidesk-agent-build.json`)) as { sources: string[] };
    const appOnly = agent.sources.filter((name) => name.endsWith('.mm') && !arc.has(name));
    expect(appOnly.filter((name) => !excluded.has(name))).toEqual([]);
    expect(appOnly).toContain('aidesk_panel_window.mm');
    // and the app-only source says itself that it needs ARC, so no other path can compile it silently wrong
    expect(readSource(`${directory}/aidesk_panel_window.mm`)).toContain('#error "aidesk_panel_window.mm requires Objective-C ARC"');
  });
});
