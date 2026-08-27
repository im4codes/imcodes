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
 *   * `spctl --assess`   -- Gatekeeper accepts it as a Notarized Developer ID.
 *   * `stapler validate` -- the ticket is actually stapled to THIS file.
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

export const MACOS_APPLE_TRUST_ERROR = Object.freeze({
  ARCHITECTURE_MISMATCH: 'macos_apple_trust_architecture_mismatch',
  CODE_IDENTITY_MISMATCH: 'macos_apple_trust_code_identity_mismatch',
  DESIGNATED_REQUIREMENT_MISMATCH: 'macos_apple_trust_designated_requirement_mismatch',
  NOTARIZATION_REJECTED: 'macos_apple_trust_notarization_rejected',
  STAPLE_INVALID: 'macos_apple_trust_staple_invalid',
});

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
  if (!/(?:^|\n).*:\s*accepted\s*(?:\n|$)/iu.test(assessment)
    || !/(?:^|\n)source=Notarized Developer ID\s*(?:\n|$)/u.test(assessment)
    || notarization?.status !== 'accepted') {
    throw new Error(MACOS_APPLE_TRUST_ERROR.NOTARIZATION_REJECTED);
  }

  const staple = appleCommandOutput(
    await execute(MACOS_APPLE_TOOLS.xcrun, ['stapler', 'validate', executablePath]),
  );
  if (!/(?:validate action worked|validated)/iu.test(staple)
    || notarization?.stapled !== true
    || notarization?.stapleValidated !== true) {
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
