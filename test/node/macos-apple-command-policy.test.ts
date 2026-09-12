import { describe, expect, it } from 'vitest';

import {
  MACOS_APPLE_TOOLS,
  macosAppleCommandFailed,
  macosAppleCommandIsVerdict,
  macosGatekeeperAssessmentIsNotarized,
} from '../../src/node/macos-apple-trust.mjs';

/**
 * Two policies that decide whether a correctly built, correctly notarized
 * component is accepted on a user's Mac. Both were wrong in the same
 * direction -- refusing what Apple's own tools call fine -- and neither
 * failure was reachable from a unit test, because the tests injected a command
 * runner that never produced a non-zero exit and fixtures that spelled an
 * assessment Gatekeeper does not emit for these artifacts.
 */
describe('macOS Apple command policy', () => {
  const exitStatus = (code: number) => Object.assign(new Error('exited'), { code });

  it('treats a verdict invocation exit status as an answer, not a failure', () => {
    // spctl exits 3 to say "rejected". That is the result of the assessment,
    // and the check that reads it never ran while this threw.
    expect(macosAppleCommandFailed(
      exitStatus(3), MACOS_APPLE_TOOLS.spctl, ['--assess', '--type', 'execute', '/tmp/x'],
    )).toBe(false);
    expect(macosAppleCommandFailed(
      exitStatus(1), MACOS_APPLE_TOOLS.xcrun, ['stapler', 'validate', '/tmp/x'],
    )).toBe(false);
  });

  it('keeps a non-zero exit fatal for every other tool', () => {
    // A failing `codesign --verify` means the signature is invalid. Swallowing
    // it would turn a broken artifact into an accepted one.
    expect(macosAppleCommandFailed(exitStatus(1), MACOS_APPLE_TOOLS.codesign, ['--verify'])).toBe(true);
    expect(macosAppleCommandFailed(exitStatus(1), MACOS_APPLE_TOOLS.lipo, ['-archs'])).toBe(true);
  });

  it('does not extend the exemption to other subcommands of the same launcher', () => {
    // `xcrun` is a launcher, not a tool. Only `xcrun stapler` answers with its
    // exit status; admitting every `xcrun` would silently swallow the failure
    // of a future `xcrun notarytool` -- the exact mistake this undoes.
    expect(macosAppleCommandIsVerdict(MACOS_APPLE_TOOLS.xcrun, ['stapler', 'validate'])).toBe(true);
    expect(macosAppleCommandIsVerdict(MACOS_APPLE_TOOLS.xcrun, ['notarytool', 'submit'])).toBe(false);
    expect(macosAppleCommandIsVerdict(MACOS_APPLE_TOOLS.spctl, ['--status'])).toBe(false);
    expect(macosAppleCommandIsVerdict(MACOS_APPLE_TOOLS.xcrun, undefined)).toBe(false);
    expect(macosAppleCommandFailed(
      exitStatus(1), MACOS_APPLE_TOOLS.xcrun, ['notarytool', 'submit'],
    )).toBe(true);
  });

  it('keeps a spawn failure or timeout fatal even for a verdict invocation', () => {
    // With no process there is no verdict. A missing binary reports a STRING
    // code, and a timeout reports a signal -- reading either as "rejected but
    // fine" would accept an artifact nothing assessed.
    expect(macosAppleCommandFailed(
      Object.assign(new Error('not found'), { code: 'ENOENT' }),
      MACOS_APPLE_TOOLS.spctl, ['--assess'],
    )).toBe(true);
    expect(macosAppleCommandFailed(
      Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }),
      MACOS_APPLE_TOOLS.spctl, ['--assess'],
    )).toBe(true);
    expect(macosAppleCommandFailed(null, MACOS_APPLE_TOOLS.spctl, ['--assess'])).toBe(false);
  });

  /**
   * Every string below was read off `spctl --assess --type execute -vv` on
   * this machine, with one Developer ID certificate and one binary, changing
   * only whether it had been through the notary service.
   */
  describe('Gatekeeper assessment', () => {
    const standalone = '/tmp/imcodes-remote-desktop-worker';
    const bundle = '/tmp/IMCodes.app';

    it('accepts the wording a notarized standalone executable actually gets', () => {
      expect(macosGatekeeperAssessmentIsNotarized(
        `${standalone}: rejected (the code is valid but does not seem to be an app)\n`,
        standalone,
      )).toBe(true);
    });

    it('refuses every un-notarized variant, each of which names its reason', () => {
      for (const assessment of [
        `${standalone}: rejected\nsource=Unnotarized Developer ID\n`,
        `${standalone}: rejected\nsource=no usable signature\n`,
        `${standalone}: rejected\nsource=Insufficient Context\n`,
        `${standalone}: rejected\n`,
        `${standalone}: rejected\norigin=Apple Development: Someone (ABCDE12345)\n`,
      ]) {
        expect(macosGatekeeperAssessmentIsNotarized(assessment, standalone)).toBe(false);
      }
    });

    it('still demands the bundle wording from a bundle', () => {
      // A bundle DOES get `source=Notarized Developer ID`, so relaxing the
      // rule for standalone executables must not relax it for bundles: the
      // standalone wording says "not an app", which an app is not entitled to.
      expect(macosGatekeeperAssessmentIsNotarized(
        `${bundle}: accepted\nsource=Notarized Developer ID\n`, bundle,
      )).toBe(true);
      expect(macosGatekeeperAssessmentIsNotarized(
        `${bundle}: rejected (the code is valid but does not seem to be an app)\n`, bundle,
      )).toBe(false);
      expect(macosGatekeeperAssessmentIsNotarized(
        `${bundle}: accepted\nsource=Developer ID\n`, bundle,
      )).toBe(false);
    });
  });
});
