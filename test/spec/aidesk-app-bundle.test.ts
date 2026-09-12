import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  AIDESK_APP_NAME,
  AIDESK_ARCHITECTURES,
  AIDESK_BUNDLE_ID,
  AIDESK_COMPUTER_USE_EXECUTABLE,
  AIDESK_MAIN_EXECUTABLE,
  aideskSigningOrder,
  buildAideskInfoPlist,
} from '../../scripts/build-aidesk-app.mjs';
import { macosArtifactSupportsStapling } from '../../scripts/macos-release-signing.mjs';

import {
  MACOS_AIDESK_APP_NAME,
  MACOS_AIDESK_BUNDLE_ID,
  MACOS_AIDESK_TEAM_ID,
} from '../../src/node/macos-computer-use.js';

/**
 * The bundle exists so that macOS attributes Screen Recording and
 * Accessibility to one application the person actually chose, instead of to
 * whichever process happened to launch a helper. Everything here guards a
 * property that, if it broke, would show up as "permissions keep being asked
 * for" rather than as a failure anyone could trace.
 */
describe('aiDesk application bundle', () => {
  it('is named and identified exactly as the runtime looks for it', () => {
    // The runtime finds the bundle by name and accepts it by identifier. A
    // rename on either side silently stops the app being recognised, and the
    // symptom is a permission prompt that never sticks.
    expect(AIDESK_APP_NAME).toBe(MACOS_AIDESK_APP_NAME);
    expect(AIDESK_BUNDLE_ID).toBe(MACOS_AIDESK_BUNDLE_ID);
  });

  it('declares the identifier the signed bundle must carry', () => {
    const plist = buildAideskInfoPlist({ version: '2026.9.1', minimumSystemVersion: '12.3' });
    expect(plist).toContain(`<string>${MACOS_AIDESK_BUNDLE_ID}</string>`);
    expect(plist).toContain(`<string>${AIDESK_MAIN_EXECUTABLE}</string>`);
    // An agent, not something to alt-tab to: it owns permissions and execs
    // into helpers, and has no window of its own.
    expect(plist).toContain('<key>LSUIElement</key>');
  });

  it('refuses a version or system floor it cannot describe', () => {
    // A malformed Info.plist produces a bundle that signs and then fails to
    // launch, so it is refused while the message can still be useful.
    expect(() => buildAideskInfoPlist({ version: '', minimumSystemVersion: '12.3' }))
      .toThrow(/version string/u);
    expect(() => buildAideskInfoPlist({ version: '1.0', minimumSystemVersion: 'twelve' }))
      .toThrow(/minimum system version/u);
  });

  it('signs inside out, bundle last, and finds helpers where the dispatcher looks', () => {
    // Two properties in one list. The order: a signature covers everything
    // nested under it, so signing the bundle first leaves a seal describing
    // helpers that are then replaced.
    //
    // And the path: `ExecAiDeskProductHelper` builds `Contents/Helpers/<name>`
    // and nothing else. A helper beside the main executable produces a bundle
    // that signs, notarizes and installs perfectly, and then answers every
    // dispatch with `aidesk_product_helper_exec_failed` -- which is exactly
    // what running it did before this was fixed.
    const order = aideskSigningOrder('/build/aiDesk.app');
    expect(order).toEqual([
      '/build/aiDesk.app/Contents/Helpers/OpenComputerUse',
      '/build/aiDesk.app/Contents/MacOS/aidesk-agent',
      '/build/aiDesk.app',
    ]);
    expect(order[order.length - 1]).toBe('/build/aiDesk.app');
  });

  it('puts helpers at the exact path the native dispatcher builds', () => {
    // Read from the source of truth rather than restated here, so a change on
    // either side has to be made on both.
    const dispatcher = readFileSync(
      'native/macos-remote-desktop/macos_permission_onboarding.mm', 'utf8',
    );
    expect(dispatcher).toContain('Contents/Helpers/%s');
    expect(aideskSigningOrder('/x')[0]).toContain('/Contents/Helpers/');
  });

  it('ships one binary that runs on both architectures', () => {
    // Apple silicon and Intel Macs install the same artifact; a thin slice
    // would fail on half the fleet at launch.
    expect([...AIDESK_ARCHITECTURES]).toEqual(['arm64', 'x86_64']);
  });

  it('carries the Computer Use executable, never the upstream bundle', () => {
    const source = readFileSync('scripts/build-aidesk-app.mjs', 'utf8');
    expect(AIDESK_COMPUTER_USE_EXECUTABLE).toBe('OpenComputerUse');
    // Nesting the upstream .app would put a second application, with its own
    // identifier and its own grants, inside ours -- the exact thing one
    // authorisation is meant to avoid.
    expect(source).toContain('Contents/MacOS');
    expect(source).toMatch(/expected exactly one \.app/u);
  });

  it('keeps the daemon out of the bundle', () => {
    // The daemon replaces its own executable on every self-upgrade. Inside a
    // signed bundle that breaks the seal, and the permissions granted to the
    // bundle can go with it -- so upgrades would cost the user their grants,
    // several times a day.
    const source = readFileSync('scripts/build-aidesk-app.mjs', 'utf8');
    expect(source).not.toContain('imcodes-node-macos');
  });

  it('pins the signing identity by fingerprint and hardens the runtime', () => {
    const source = readFileSync('scripts/build-aidesk-app.mjs', 'utf8');
    expect(source).toContain("'--options', 'runtime'");
    expect(source).toContain('must be a SHA-1 fingerprint');
    // Verified with `--deep`, or the nested signatures the order above exists
    // to protect would never be checked.
    expect(source).toContain("'--deep'");
    // A developer with no release identity must still get a runnable app.
    expect(source).toContain("args.push('--sign', '-')");
  });

  it('expects the team the runtime verifier demands', () => {
    // `verifyMacosComputerUseAppBundle` accepts the bundle only when the
    // signature names this team and a Developer ID authority.
    expect(MACOS_AIDESK_TEAM_ID).toBe('M675E26Q67');
  });
});

/**
 * The disk image is what the download button hands out. Everything asserted
 * here is a property a user would experience directly: whether the window can
 * be dragged from, and whether a first launch needs the network.
 */
describe('aiDesk disk image', () => {
  const source = readFileSync('scripts/build-aidesk-app.mjs', 'utf8');

  it('is a format that can carry its notarization ticket', () => {
    // UDZO is a UDIF image, which `stapler` accepts. A sparse or raw image
    // would notarize and then refuse the ticket, and the failure would be a
    // first launch that needs the network -- invisible until someone is
    // offline.
    expect(source).toContain("'-format', 'UDZO'");
    expect(macosArtifactSupportsStapling('/build/aiDesk.to-2026.9.1.dmg')).toBe(true);
  });

  it('gives the window something to drag into', () => {
    // Without the symlink the image is a puzzle: a lone app icon and nowhere
    // obvious to put it.
    expect(source).toContain("'/Applications'");
  });

  it('copies the app verbatim rather than resolving its symlinks', () => {
    // Dereferencing a symlink inside a signed bundle rewrites its contents,
    // and the seal then describes a bundle that no longer exists.
    expect(source).toContain('verbatimSymlinks: true');
  });

  it('signs the image itself, not only the app inside it', () => {
    // So a tampered download is refused before anything is mounted, rather
    // than at the moment the app is first launched.
    expect(source).toContain('export function signAideskDmg');
    expect(source).toContain('must be a SHA-1 fingerprint');
  });

  it('refuses to build an image around an app that is not there', () => {
    expect(source).toMatch(/app bundle not found/u);
  });
});
