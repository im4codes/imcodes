import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  PINNED_DEPOT_TOOLS_REVISION,
  PINNED_LIBWEBRTC_REVISION,
} from '../../scripts/remote-desktop-worker-artifacts.mjs';

const producer = readFileSync('native/macos-remote-desktop/build-libwebrtc-sdk.sh', 'utf8');

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

  it('compiles against the floor the product declares, not the host default', () => {
    // Objects built for a newer deployment target assume runtime the product
    // promises to work without. This is the one build argument whose drift
    // would not fail the build, only the machines it ships to.
    expect(producer).toContain('MINIMUM_MACOS_VERSION="12.3"');
    expect(producer).toContain('mac_deployment_target=\\"$MINIMUM_MACOS_VERSION\\"');
  });
});
