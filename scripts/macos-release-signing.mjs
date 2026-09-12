// macOS release signing for CI: import a Developer ID identity into a throwaway
// keychain, notarize, staple, and prove the material is gone afterwards.
//
// Mirrors the Windows release-signing flow (import -> sign -> verify -> assert
// cleanup) rather than inventing a second set of conventions. The parts that
// decide something are pure functions so they can be tested without an Apple
// account; the shell calls around them stay thin on purpose.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MACOS_RELEASE_SIGNING_TOOLS = Object.freeze({
  security: '/usr/bin/security',
  codesign: '/usr/bin/codesign',
  xcrun: '/usr/bin/xcrun',
  spctl: '/usr/sbin/spctl',
  ditto: '/usr/bin/ditto',
});

const SHA1_RE = /^[A-F0-9]{40}$/;
const TEAM_ID_RE = /^[A-Z0-9]{10}$/;
const IDENTITY_LINE_RE = /^\s*\d+\)\s+([A-F0-9]{40})\s+"([^"]+)"\s*$/gmu;

/**
 * The one identity that may sign a release, or a refusal that says why.
 *
 * `security find-identity` happily lists several certificates, and picking "the
 * first Developer ID" would make a release depend on keychain ordering. Worse,
 * an `Apple Development` certificate signs without complaint and only fails
 * much later at notarization, so it is rejected by name here where the message
 * can still be useful.
 */
export function selectDeveloperIdSigningIdentity(findIdentityOutput, options = {}) {
  const { teamId } = options;
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) {
    throw new Error('macOS release signing requires a 10-character Apple Team ID');
  }
  const identities = [];
  for (const match of String(findIdentityOutput ?? '').matchAll(IDENTITY_LINE_RE)) {
    identities.push({ sha1: match[1], commonName: match[2] });
  }
  if (identities.length === 0) {
    throw new Error('no code-signing identities were found in the signing keychain');
  }

  const wanted = `Developer ID Application:`;
  const developerId = identities.filter((identity) => identity.commonName.startsWith(wanted));
  if (developerId.length === 0) {
    const development = identities.filter((identity) => identity.commonName.startsWith('Apple Development:'));
    if (development.length > 0) {
      throw new Error(
        'the signing keychain holds an "Apple Development" certificate, not "Developer ID Application". '
        + 'A development certificate signs successfully and is then rejected by notarization, so it cannot '
        + 'produce a release build. Create a Developer ID Application certificate for this team.',
      );
    }
    throw new Error(`no "Developer ID Application" certificate was found; keychain holds: ${identities.map((i) => i.commonName).join(', ')}`);
  }

  const teamMatched = developerId.filter((identity) => identity.commonName.endsWith(`(${teamId})`));
  if (teamMatched.length === 0) {
    throw new Error(
      `no Developer ID Application certificate belongs to team ${teamId}; found: ${developerId.map((i) => i.commonName).join(', ')}`,
    );
  }
  if (teamMatched.length > 1) {
    // Ambiguity is refused, never resolved by ordering: two valid certificates
    // mean the operator has to say which one a release was signed with.
    throw new Error(
      `the signing keychain holds ${teamMatched.length} Developer ID Application certificates for team ${teamId}; `
      + `refusing to guess: ${teamMatched.map((i) => `${i.sha1} ${i.commonName}`).join(' | ')}`,
    );
  }

  const [identity] = teamMatched;
  if (!SHA1_RE.test(identity.sha1)) {
    throw new Error(`signing identity fingerprint is not a SHA-1 thumbprint: ${identity.sha1}`);
  }
  return Object.freeze({ ...identity });
}

/**
 * notarytool's JSON, reduced to the two facts a release depends on.
 *
 * Anything other than `Accepted` is a failure even when the command exits 0 --
 * `notarytool submit --wait` reports `Invalid` through its payload, so trusting
 * the exit code alone would ship an unnotarized binary that looks signed.
 */
export function parseNotarizationSubmission(raw) {
  let payload;
  try {
    payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error('notarytool did not return JSON');
  }
  if (payload === null || typeof payload !== 'object') {
    throw new Error('notarytool returned a non-object submission result');
  }
  const submissionId = payload.id;
  const status = payload.status;
  if (typeof submissionId !== 'string' || submissionId.length === 0) {
    throw new Error('notarytool submission is missing an id');
  }
  if (status !== 'Accepted') {
    throw new Error(`notarization was not accepted: status=${String(status)} submissionId=${submissionId}`);
  }
  return Object.freeze({ submissionId, status });
}

/**
 * The exact record shape `validMacosNotarization` accepts.
 *
 * Built from observed results only. `stapled`/`stapleValidated` are arguments
 * rather than constants so that a caller cannot claim a stapled ticket it never
 * verified -- the schema requires both to be true, and the honest way to get
 * there is to actually run `stapler validate`.
 */
export function buildNotarizationRecord(input) {
  const { submission, ticketSha256, stapled, stapleValidated } = input;
  if (!submission || typeof submission.submissionId !== 'string') {
    throw new Error('notarization record requires a parsed submission');
  }
  if (typeof ticketSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(ticketSha256)) {
    throw new Error('notarization record requires a lowercase sha256 ticket digest');
  }
  if (stapled !== true || stapleValidated !== true) {
    throw new Error('notarization record refuses to claim an unstapled or unvalidated ticket');
  }
  return Object.freeze({
    status: 'accepted',
    submissionId: submission.submissionId,
    ticketSha256,
    stapled: true,
    stapleValidated: true,
  });
}

/**
 * Cleanup is asserted, not assumed.
 *
 * The Windows job already treats leftover signing material as a build failure;
 * a private key surviving on a runner is the same problem whichever OS leaks it.
 */
export function assertSigningMaterialRemoved(input) {
  const { keychainListOutput, remainingPaths } = input;
  const leftovers = [];
  if (Array.isArray(remainingPaths) && remainingPaths.length > 0) {
    leftovers.push(...remainingPaths);
  }
  const keychainPath = input.keychainPath;
  if (typeof keychainPath === 'string' && keychainPath.length > 0
    && String(keychainListOutput ?? '').includes(keychainPath)) {
    leftovers.push(keychainPath);
  }
  if (leftovers.length > 0) {
    throw new Error(`macOS release-signing material cleanup was incomplete: ${leftovers.join(', ')}`);
  }
}

function run(tool, args, options = {}) {
  return execFileSync(tool, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

/**
 * Import the release identity into a keychain that exists only for this job.
 *
 * A temporary keychain is not decoration: importing into the login keychain
 * would leave the key behind on a self-hosted runner and would prompt on a
 * hosted one. The partition list is set so codesign can use the key without an
 * interactive unlock, which is the step whose absence produces the notorious
 * "User interaction is not allowed" failure.
 */
export function importSigningIdentity(input) {
  const { pkcs12Base64, pkcs12Password, keychainPath, keychainPassword, teamId } = input;
  const pkcs12Path = `${keychainPath}.p12`;
  writeFileSync(pkcs12Path, Buffer.from(pkcs12Base64, 'base64'), { mode: 0o600 });
  try {
    run(MACOS_RELEASE_SIGNING_TOOLS.security, ['create-keychain', '-p', keychainPassword, keychainPath]);
    run(MACOS_RELEASE_SIGNING_TOOLS.security, ['set-keychain-settings', '-lut', '21600', keychainPath]);
    run(MACOS_RELEASE_SIGNING_TOOLS.security, ['unlock-keychain', '-p', keychainPassword, keychainPath]);
    run(MACOS_RELEASE_SIGNING_TOOLS.security, [
      'import', pkcs12Path,
      '-k', keychainPath,
      '-P', pkcs12Password,
      '-T', MACOS_RELEASE_SIGNING_TOOLS.codesign,
      '-f', 'pkcs12',
    ]);
    run(MACOS_RELEASE_SIGNING_TOOLS.security, [
      'set-key-partition-list',
      '-S', 'apple-tool:,apple:',
      '-s', '-k', keychainPassword, keychainPath,
    ]);
    const existing = run(MACOS_RELEASE_SIGNING_TOOLS.security, ['list-keychains', '-d', 'user'])
      .split('\n').map((line) => line.trim().replace(/^"|"$/gu, '')).filter(Boolean);
    run(MACOS_RELEASE_SIGNING_TOOLS.security, ['list-keychains', '-d', 'user', '-s', keychainPath, ...existing]);
    const found = run(MACOS_RELEASE_SIGNING_TOOLS.security, ['find-identity', '-v', '-p', 'codesigning', keychainPath]);
    return selectDeveloperIdSigningIdentity(found, { teamId });
  } finally {
    // The PKCS#12 leaves the disk whether or not the import worked.
    rmSync(pkcs12Path, { force: true });
  }
}

/** Notarize, staple, and prove the ticket is on THIS file. */
/**
 * Can a notarization ticket be attached to this artifact at all?
 *
 * `stapler` writes the ticket into a bundle or container. A bare Mach-O has
 * nowhere to put one -- stapling an executable fails with error 73, and a zip
 * is refused outright ("Stapler is incapable of working with ZIP archive
 * files"). Both were confirmed against a real notarized binary rather than
 * inferred, because the distinction decides whether a release can be verified
 * offline.
 */
export function macosArtifactSupportsStapling(artifactPath) {
  if (typeof artifactPath !== 'string' || artifactPath.length === 0) {
    throw new Error('stapling support requires an artifact path');
  }
  return /\.(app|dmg|pkg)$/iu.test(artifactPath.replace(/\/+$/u, ''));
}

/**
 * The record for an artifact that was notarized but cannot carry its ticket.
 *
 * Separate from `buildNotarizationRecord`, which refuses to describe an
 * unstapled ticket, because that refusal is right for anything that *could*
 * have been stapled. This one states the weaker fact plainly -- Gatekeeper
 * will check this artifact online on first launch -- and refuses to be used as
 * a way around stapling something staplable.
 */
export function buildUnstapledNotarizationRecord(input) {
  const { submission, ticketSha256, artifactPath } = input;
  if (macosArtifactSupportsStapling(artifactPath)) {
    throw new Error(
      `${artifactPath} can be stapled; refusing to record it as unstapled. `
      + 'Use notarizeAndStaple so the ticket travels with the artifact.',
    );
  }
  if (!submission || typeof submission.submissionId !== 'string') {
    throw new Error('notarization record requires a parsed submission');
  }
  if (typeof ticketSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(ticketSha256)) {
    throw new Error('notarization record requires a lowercase sha256 ticket digest');
  }
  return Object.freeze({
    status: 'accepted',
    submissionId: submission.submissionId,
    ticketSha256,
    stapled: false,
    stapleValidated: false,
    unstapledReason: 'artifact_format_cannot_carry_a_ticket',
  });
}

/**
 * Notarize a bare executable.
 *
 * Apple accepts only containers for submission, so the binary is zipped for the
 * upload and the zip is thrown away afterwards -- the artifact that ships is
 * the executable, whose notarization Apple now records against its own hash.
 */
export function notarizeExecutable(input) {
  const { artifactPath, apiKeyPath, apiKeyId, apiIssuer } = input;
  if (macosArtifactSupportsStapling(artifactPath)) {
    throw new Error(`${artifactPath} is a staplable format; use notarizeAndStaple`);
  }
  const uploadPath = `${artifactPath}.notarize.zip`;
  try {
    run(MACOS_RELEASE_SIGNING_TOOLS.ditto, ['-c', '-k', '--keepParent', artifactPath, uploadPath]);
    const submitted = run(MACOS_RELEASE_SIGNING_TOOLS.xcrun, [
      'notarytool', 'submit', uploadPath,
      '--key', apiKeyPath,
      '--key-id', apiKeyId,
      '--issuer', apiIssuer,
      '--wait',
      '--output-format', 'json',
    ]);
    const submission = parseNotarizationSubmission(submitted);
    const ticketSha256 = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
    return buildUnstapledNotarizationRecord({ submission, ticketSha256, artifactPath });
  } finally {
    rmSync(uploadPath, { force: true });
  }
}

export function notarizeAndStaple(input) {
  const { artifactPath, apiKeyPath, apiKeyId, apiIssuer } = input;
  const submitted = run(MACOS_RELEASE_SIGNING_TOOLS.xcrun, [
    'notarytool', 'submit', artifactPath,
    '--key', apiKeyPath,
    '--key-id', apiKeyId,
    '--issuer', apiIssuer,
    '--wait',
    '--output-format', 'json',
  ]);
  const submission = parseNotarizationSubmission(submitted);
  run(MACOS_RELEASE_SIGNING_TOOLS.xcrun, ['stapler', 'staple', artifactPath]);
  run(MACOS_RELEASE_SIGNING_TOOLS.xcrun, ['stapler', 'validate', artifactPath]);
  const ticketSha256 = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
  return buildNotarizationRecord({ submission, ticketSha256, stapled: true, stapleValidated: true });
}

/** Delete the throwaway keychain and refuse to finish while anything remains. */
export function removeSigningMaterial(input) {
  const { keychainPath, extraPaths = [] } = input;
  try {
    run(MACOS_RELEASE_SIGNING_TOOLS.security, ['delete-keychain', keychainPath]);
  } catch {
    // Already gone, or never created: the assertion below is the real gate.
  }
  const remainingPaths = [keychainPath, `${keychainPath}.p12`, ...extraPaths]
    .filter((path) => {
      try {
        readFileSync(path);
        return true;
      } catch {
        return false;
      }
    });
  for (const path of remainingPaths) rmSync(path, { force: true });
  const stillPresent = remainingPaths.filter((path) => {
    try {
      readFileSync(path);
      return true;
    } catch {
      return false;
    }
  });
  assertSigningMaterialRemoved({
    keychainPath,
    keychainListOutput: run(MACOS_RELEASE_SIGNING_TOOLS.security, ['list-keychains', '-d', 'user']),
    remainingPaths: stillPresent,
  });
}

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required for macOS release signing`);
  }
  return value;
}

async function main(argv) {
  const mode = argv[0];
  const runnerTemp = process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? '/tmp';
  const keychainPath = join(runnerTemp, 'imcodes-macos-release-signing.keychain-db');

  if (mode === 'import') {
    const identity = importSigningIdentity({
      pkcs12Base64: requireEnv('IMCODES_MACOS_SIGNING_P12_BASE64'),
      pkcs12Password: requireEnv('IMCODES_MACOS_SIGNING_P12_PASSWORD'),
      keychainPassword: requireEnv('IMCODES_MACOS_KEYCHAIN_PASSWORD'),
      teamId: requireEnv('IMCODES_MACOS_TEAM_ID'),
      keychainPath,
    });
    process.stdout.write(`${JSON.stringify(identity)}\n`);
    return;
  }
  if (mode === 'notarize') {
    const artifactPath = argv[1];
    if (!artifactPath) throw new Error('usage: macos-release-signing.mjs notarize <artifact>');
    const credentials = {
      apiKeyPath: requireEnv('IMCODES_MACOS_NOTARY_KEY_PATH'),
      apiKeyId: requireEnv('IMCODES_MACOS_NOTARY_KEY_ID'),
      apiIssuer: requireEnv('IMCODES_MACOS_NOTARY_ISSUER'),
    };
    // The format decides, not the caller: a .app/.dmg/.pkg gets its ticket
    // attached, and a bare executable -- which Apple documents as unable to
    // carry one -- is notarized without pretending it was stapled. Leaving the
    // choice to each call site is how one of them silently stops stapling.
    const record = macosArtifactSupportsStapling(artifactPath)
      ? notarizeAndStaple({ artifactPath, ...credentials })
      : notarizeExecutable({ artifactPath, ...credentials });
    process.stdout.write(`${JSON.stringify(record)}\n`);
    return;
  }
  if (mode === 'cleanup') {
    removeSigningMaterial({
      keychainPath,
      extraPaths: [process.env.IMCODES_MACOS_NOTARY_KEY_PATH].filter(Boolean),
    });
    return;
  }
  throw new Error('usage: macos-release-signing.mjs <import|notarize|cleanup> [artifact]');
}

if (process.argv[1] && process.argv[1].endsWith('macos-release-signing.mjs')) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
