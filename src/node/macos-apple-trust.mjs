/**
 * Real Apple trust checks for a shipped macOS component.
 *
 * EXTRACTED, NOT COPIED. The daemon-side artifact verifier and the packager
 * must agree byte-for-byte about what "verified" means; two implementations of
 * that would drift, and the weaker one is the one an attacker uses.
 *
 * It lives under src/ rather than scripts/ for a deployment reason, not a
 * stylistic one: `postbuild` copies src/**\/*.mjs into dist/src/, and the npm
 * `files` list publishes dist/, config/ and bin/ only. A shared module under
 * scripts/ is simply absent from the published package, so the daemon would
 * throw ERR_MODULE_NOT_FOUND at import time -- a failure that no source-tree
 * test can see.
 *
 * What a manifest says about a binary is a CLAIM. These functions are what turn
 * a claim into evidence:
 *   * `lipo -archs`      -- exactly one slice, exactly the expected one.
 *   * `codesign --verify --strict` -- the signature actually validates.
 *   * `codesign -d`      -- identifier, team, AND the hardened-runtime flag.
 *   * `codesign -d -r-`  -- the designated requirement matches exactly.
 *   * `spctl --assess`   -- Gatekeeper finds nothing wrong with the signature
 *                           or the notarization. What it PRINTS depends on the
 *                           artifact's format; see
 *                           `macosGatekeeperAssessmentIsNotarized`.
 *   * `stapler validate` -- the ticket is actually stapled to THIS file, for
 *                           the artifact formats that can carry one.
 *
 * That last qualifier is Apple's, not a concession: tickets are created for
 * standalone binaries but cannot be attached to them. The shipped components
 * are bare Mach-O executables, so demanding a stapled ticket from them demands
 * something that cannot exist -- and `spctl` remains the substantive check
 * either way, because an un-notarized binary is reported differently -- with a
 * `source=` line naming the refusal -- and no such line appears for one Apple
 * did notarize. What is genuinely lost is offline
 * verification: an unstapled binary is assessed against Apple's service, so a
 * machine with no network cannot start one.
 *
 * A packager that compared only Identifier and TeamIdentifier would accept a
 * same-team binary with the wrong designated requirement, no hardened runtime,
 * no notarization and the wrong architecture -- every one of which the manifest
 * would still cheerfully describe as correct.
 */

export const MACOS_APPLE_TOOLS = Object.freeze({
  lipo: '/usr/bin/lipo',
  codesign: '/usr/bin/codesign',
  spctl: '/usr/sbin/spctl',
  xcrun: '/usr/bin/xcrun',
});

/**
 * Invocations whose non-zero exit is an ANSWER, not a malfunction.
 *
 * `spctl --assess` exits 3 to say "rejected" and `stapler validate` exits
 * non-zero to say "no ticket" -- in both cases the text they print is the
 * verdict the caller asked for. A command runner that treats every non-zero
 * exit as a failure throws before the check that would have read it, so the
 * daemon rejected its own correctly notarized components with spctl's output
 * as the error message and no check ever ran.
 *
 * Keyed on the SUBCOMMAND, not just the binary. `xcrun` is a launcher: it is
 * only `xcrun stapler` whose exit status is an answer, and admitting every
 * `xcrun` would silently swallow the failure of, say, a future `xcrun
 * notarytool` -- the exact class of mistake this whole function exists to
 * undo.
 *
 * Everything absent from this list keeps failing loudly: a non-zero `codesign
 * --verify` means the signature is invalid, and swallowing that would turn a
 * broken artifact into an accepted one.
 */
const MACOS_APPLE_VERDICT_INVOCATIONS = Object.freeze([
  { executable: MACOS_APPLE_TOOLS.spctl, subcommand: '--assess' },
  { executable: MACOS_APPLE_TOOLS.xcrun, subcommand: 'stapler' },
]);

export function macosAppleCommandIsVerdict(executable, args) {
  const first = Array.isArray(args) ? args[0] : undefined;
  return MACOS_APPLE_VERDICT_INVOCATIONS.some(
    (entry) => entry.executable === executable && entry.subcommand === first,
  );
}

/**
 * Whether an execFile error from an Apple tool is a real failure.
 *
 * A non-zero EXIT from a verdict tool is not: `spctl --assess` exits 3 to say
 * "rejected", and that text is the answer the caller wanted. Anything that is
 * not an exit status -- a spawn failure, a timeout, a buffer overrun -- stays
 * fatal for every tool, including the verdict ones, because then there is no
 * verdict to read.
 *
 * Node reports an exit status as a numeric `code` on the error; a spawn
 * failure carries a string code such as 'ENOENT', and a timeout carries
 * `killed: true` with a signal. Distinguishing them by TYPE rather than by
 * presence is what keeps a missing binary from being read as a rejection.
 */
export function macosAppleCommandFailed(error, executable, args) {
  if (!error) return false;
  if (error.killed === true || error.signal) return true;
  if (typeof error.code !== 'number') return true;
  return !macosAppleCommandIsVerdict(executable, args);
}

export const MACOS_APPLE_TRUST_ERROR = Object.freeze({
  ARCHITECTURE_MISMATCH: 'macos_apple_trust_architecture_mismatch',
  CODE_IDENTITY_MISMATCH: 'macos_apple_trust_code_identity_mismatch',
  DESIGNATED_REQUIREMENT_MISMATCH: 'macos_apple_trust_designated_requirement_mismatch',
  NOTARIZATION_REJECTED: 'macos_apple_trust_notarization_rejected',
  STAPLE_INVALID: 'macos_apple_trust_staple_invalid',
});

/**
 * Quote a requirement literal exactly as codesign does.
 *
 * Bare only when the WHOLE literal is a letter followed by letters and digits.
 * An underscore, a hyphen, a leading digit or a dot quotes it -- so every
 * bundle identifier is quoted and only a team ID is ever bare. Established by
 * reading `codesign -d -r-` back off a probe signed with a real Developer ID
 * certificate; see shared/macos-code-requirement.ts for the observed table.
 */
export function macosCodeRequirementLiteral(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('code requirement literal requires a value');
  }
  return /^[A-Za-z][A-Za-z0-9]*$/u.test(value) ? value : `"${value}"`;
}

/**
 * Whether a notarization ticket can be attached to this artifact at all.
 *
 * Apple: "Although tickets are created for standalone binaries, it's not
 * currently possible to staple tickets to them." Only bundles and the two
 * container formats can carry one.
 *
 * Path-based, and deliberately fail-closed in the direction that matters: an
 * artifact NAMED like a container is held to the stapling requirement, so the
 * only way to escape that requirement is to genuinely not be one.
 */
export function macosArtifactCanCarryNotarizationTicket(artifactPath) {
  if (typeof artifactPath !== 'string' || artifactPath.length === 0) {
    throw new Error('notarization ticket support requires an artifact path');
  }
  return /\.(app|dmg|pkg)$/iu.test(artifactPath.replace(/\/+$/u, ''));
}

/**
 * Whether Gatekeeper's assessment says this artifact is notarized.
 *
 * Not one string, because Gatekeeper answers differently depending on what it
 * was handed, and the difference is not cosmetic. Read off the tool itself,
 * with one Developer ID certificate and one binary, changing only whether it
 * had been through the notary service:
 *
 *   Developer ID, notarized    rejected (the code is valid but does not seem
 *                              to be an app)          <- no source= line
 *   Developer ID, NOT notarized
 *                              rejected
 *                              source=Unnotarized Developer ID
 *   Apple Development          rejected
 *                              origin=Apple Development: ...
 *   ad-hoc signed              rejected
 *   unsigned                   rejected
 *                              source=no usable signature
 *
 * `source=Notarized Developer ID` is emitted for BUNDLES. A standalone Mach-O
 * executable never gets it: Gatekeeper stops at "does not seem to be an app",
 * which it reaches only after finding nothing wrong with the signature or the
 * notarization. Requiring the bundle wording of a bare executable was
 * unsatisfiable -- the daemon would have refused its own correctly notarized
 * components on a user's Mac, and the release guard refused to publish them.
 *
 * The standalone form is still substantive: every un-notarized variant above
 * is distinguishable from it, and each carries a `source=` line explaining the
 * refusal, so the absence of one is the assertion.
 */
export function macosGatekeeperAssessmentIsNotarized(assessment, artifactPath) {
  if (typeof assessment !== 'string') return false;
  if (macosArtifactCanCarryNotarizationTicket(artifactPath)) {
    return /(?:^|\n).*:\s*accepted\s*(?:\n|$)/iu.test(assessment)
      && /(?:^|\n)source=Notarized Developer ID\s*(?:\n|$)/u.test(assessment);
  }
  return /the code is valid but does not seem to be an app/iu.test(assessment)
    && !/(?:^|\n)source=/u.test(assessment);
}

/**
 * Whether Gatekeeper's refusal is "I have not seen the ticket yet".
 *
 * The verdict for a freshly notarized, UNSTAPLED binary is eventually
 * consistent: Gatekeeper has to ask Apple, and the answer is not available the
 * instant `notarytool` returns Accepted. Measured on one machine, with the
 * same certificate, by re-signing a binary (new cdhash, so a new ticket) and
 * polling after each submission completed:
 *
 *   immediately                    one sample
 *   32 seconds                     one sample
 *   between 211 seconds and ~10m   one sample
 *
 * A build that samples this once therefore fails at random -- which is what it
 * did, on the second architecture of a release whose first had passed.
 *
 * Narrow on purpose. This is the ONE refusal a propagation delay produces:
 * the chain is Apple's and the leaf is a Developer ID, and only the ticket is
 * missing. `source=no usable signature`, a missing origin, or any other
 * wording is a real defect and must fail at once rather than after a timeout.
 */
export function macosGatekeeperAssessmentIsPendingNotarization(assessment) {
  if (typeof assessment !== 'string') return false;
  return /(?:^|\n)source=Unnotarized Developer ID\s*(?:\n|$)/u.test(assessment)
    && /(?:^|\n)origin=Developer ID Application:/u.test(assessment);
}

export function appleCommandOutput(result) {
  return `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
}

export function appleLineValue(output, prefix) {
  const line = output.split(/\r?\n/u).find((entry) => entry.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim();
}

/**
 * @param {string} executablePath
 * @param {{ bundleIdentifier: string, designatedRequirement: string }} identity
 * @param {{ status: string, stapled: boolean, stapleValidated: boolean }} notarization
 * @param {string} teamId
 * @param {'arm64'|'x64'} expectedArch
 * @param {(tool: string, args: readonly string[]) => Promise<{stdout: string, stderr: string}>} execute
 */
export async function verifyMacosAppleTrust(
  executablePath, identity, notarization, teamId, expectedArch, execute,
) {
  const expectedLipoArch = expectedArch === 'x64' ? 'x86_64' : 'arm64';
  const lipoOutput = appleCommandOutput(
    await execute(MACOS_APPLE_TOOLS.lipo, ['-archs', executablePath]),
  ).trim();
  const architectures = lipoOutput.split(/\s+/u).filter(Boolean);
  // Exactly one slice: a universal binary is not the thin artifact the runtime
  // verifier qualified, and "contains the right arch" is not the same claim.
  if (architectures.length !== 1 || architectures[0] !== expectedLipoArch) {
    throw new Error(MACOS_APPLE_TRUST_ERROR.ARCHITECTURE_MISMATCH);
  }

  await execute(MACOS_APPLE_TOOLS.codesign, [
    '--verify', '--strict', '--verbose=4', executablePath,
  ]);
  const signatureDetails = appleCommandOutput(
    await execute(MACOS_APPLE_TOOLS.codesign, ['-d', '--verbose=4', executablePath]),
  );
  if (appleLineValue(signatureDetails, 'Identifier=') !== identity.bundleIdentifier
    || appleLineValue(signatureDetails, 'TeamIdentifier=') !== teamId
    // Hardened runtime is read from the CodeDirectory flags, not from the
    // manifest's own boolean: a binary can claim it and not have it.
    || !/^CodeDirectory .* flags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/imu.test(signatureDetails)) {
    throw new Error(MACOS_APPLE_TRUST_ERROR.CODE_IDENTITY_MISMATCH);
  }

  const requirementOutput = appleCommandOutput(
    await execute(MACOS_APPLE_TOOLS.codesign, ['-d', '-r-', executablePath]),
  );
  if (appleLineValue(requirementOutput, 'designated =>') !== identity.designatedRequirement) {
    throw new Error(MACOS_APPLE_TRUST_ERROR.DESIGNATED_REQUIREMENT_MISMATCH);
  }

  const assessment = appleCommandOutput(await execute(
    MACOS_APPLE_TOOLS.spctl, ['--assess', '--type', 'execute', '--verbose=4', executablePath],
  ));
  if (!macosGatekeeperAssessmentIsNotarized(assessment, executablePath)
    || notarization?.status !== 'accepted') {
    throw new Error(MACOS_APPLE_TRUST_ERROR.NOTARIZATION_REJECTED);
  }

  if (macosArtifactCanCarryNotarizationTicket(executablePath)) {
    const staple = appleCommandOutput(
      await execute(MACOS_APPLE_TOOLS.xcrun, ['stapler', 'validate', executablePath]),
    );
    if (!/(?:validate action worked|validated)/iu.test(staple)
      || notarization?.stapled !== true
      || notarization?.stapleValidated !== true) {
      throw new Error(MACOS_APPLE_TRUST_ERROR.STAPLE_INVALID);
    }
    return;
  }

  // A format that cannot carry a ticket must SAY so, and say why. Without this
  // the absence of a staple is indistinguishable from a manifest that simply
  // omitted the claim, which is exactly the downgrade an attacker would want.
  if (notarization?.stapled !== false
    || notarization?.stapleValidated !== false
    || notarization?.unstapledReason !== 'artifact_format_cannot_carry_a_ticket') {
    throw new Error(MACOS_APPLE_TRUST_ERROR.STAPLE_INVALID);
  }
}

/**
 * The directory must contain EXACTLY the manifest plus the components it names.
 *
 * An extra file is not harmless: it ships inside the signed bundle, and nothing
 * downstream describes or verifies it.
 */
export async function assertExactComponentSetEntries(directory, expectedNames, readdir) {
  const expected = new Set(expectedNames);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length !== expected.size
    || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()
      || !expected.has(entry.name))) {
    throw new Error('macos_apple_trust_unexpected_entries');
  }
}
