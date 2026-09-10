import { describe, it, expect } from 'vitest';
import {
  assertSigningMaterialRemoved,
  buildNotarizationRecord,
  parseNotarizationSubmission,
  selectDeveloperIdSigningIdentity,
} from '../../scripts/macos-release-signing.mjs';

const TEAM = 'M675E26Q67';
const DEV_ID_LINE = `  1) ${'A'.repeat(40)} "Developer ID Application: Lei Sun (${TEAM})"`;

describe('macOS release signing identity selection', () => {
  it('returns the fingerprint, because a common name can match more than one certificate', () => {
    const identity = selectDeveloperIdSigningIdentity(
      `${DEV_ID_LINE}\n     1 valid identities found\n`,
      { teamId: TEAM },
    );
    expect(identity.sha1).toBe('A'.repeat(40));
    expect(identity.commonName).toBe(`Developer ID Application: Lei Sun (${TEAM})`);
  });

  it('names the Apple Development mistake instead of failing later at notarization', () => {
    // This is the exact certificate a machine has when nobody has created a
    // Developer ID yet. It signs without complaint, so the failure would
    // otherwise surface as an opaque notarization rejection minutes later.
    expect(() => selectDeveloperIdSigningIdentity(
      `  1) ${'B'.repeat(40)} "Apple Development: Lei Sun (9N4BU2QZ39)"\n     1 valid identities found\n`,
      { teamId: TEAM },
    )).toThrow(/Apple Development.*not "Developer ID Application"/su);
  });

  it('refuses to guess between two Developer ID certificates for the same team', () => {
    // Keychain order is not a release decision. Two valid certificates means a
    // person has to say which one signed the build.
    const output = [
      DEV_ID_LINE,
      `  2) ${'C'.repeat(40)} "Developer ID Application: Lei Sun (${TEAM})"`,
      '     2 valid identities found',
    ].join('\n');
    expect(() => selectDeveloperIdSigningIdentity(output, { teamId: TEAM }))
      .toThrow(/refusing to guess/u);
  });

  it('rejects a Developer ID belonging to a different team', () => {
    expect(() => selectDeveloperIdSigningIdentity(
      `  1) ${'D'.repeat(40)} "Developer ID Application: Someone Else (ZZZZZZZZZZ)"\n`,
      { teamId: TEAM },
    )).toThrow(/no Developer ID Application certificate belongs to team M675E26Q67/u);
  });

  it('rejects an empty keychain and a malformed team id before touching any tool', () => {
    expect(() => selectDeveloperIdSigningIdentity('', { teamId: TEAM }))
      .toThrow(/no code-signing identities/u);
    expect(() => selectDeveloperIdSigningIdentity(DEV_ID_LINE, { teamId: 'nope' }))
      .toThrow(/10-character Apple Team ID/u);
  });
});

describe('notarization result handling', () => {
  const submissionId = '2efe2717-52ef-43a5-96dc-0797e4ca1041';

  it('accepts only an Accepted submission', () => {
    const parsed = parseNotarizationSubmission(JSON.stringify({ id: submissionId, status: 'Accepted' }));
    expect(parsed).toEqual({ submissionId, status: 'Accepted' });
  });

  it('treats Invalid as a failure even though notarytool exits 0', () => {
    // `notarytool submit --wait` reports rejection through its payload, not its
    // exit code. Trusting the exit code would ship an unnotarized binary that
    // every later check still describes as "signed".
    expect(() => parseNotarizationSubmission(JSON.stringify({ id: submissionId, status: 'Invalid' })))
      .toThrow(/notarization was not accepted: status=Invalid/u);
  });

  it('rejects a payload that is not JSON or has no submission id', () => {
    expect(() => parseNotarizationSubmission('not json')).toThrow(/did not return JSON/u);
    expect(() => parseNotarizationSubmission(JSON.stringify({ status: 'Accepted' })))
      .toThrow(/missing an id/u);
  });

  it('builds exactly the record shape the artifact schema accepts', () => {
    const record = buildNotarizationRecord({
      submission: { submissionId, status: 'Accepted' },
      ticketSha256: 'a'.repeat(64),
      stapled: true,
      stapleValidated: true,
    });
    expect(record).toEqual({
      status: 'accepted',
      submissionId,
      ticketSha256: 'a'.repeat(64),
      stapled: true,
      stapleValidated: true,
    });
    expect(Object.keys(record).sort())
      .toEqual(['stapleValidated', 'stapled', 'status', 'submissionId', 'ticketSha256']);
  });

  it('refuses to claim a ticket it did not verify', () => {
    const submission = { submissionId, status: 'Accepted' };
    expect(() => buildNotarizationRecord({
      submission, ticketSha256: 'a'.repeat(64), stapled: true, stapleValidated: false,
    })).toThrow(/unstapled or unvalidated/u);
    expect(() => buildNotarizationRecord({
      submission, ticketSha256: 'NOTAHASH', stapled: true, stapleValidated: true,
    })).toThrow(/lowercase sha256/u);
  });
});

describe('signing material cleanup', () => {
  const keychainPath = '/tmp/imcodes-macos-release-signing.keychain-db';

  it('passes only when the keychain is unlisted and no files remain', () => {
    expect(() => assertSigningMaterialRemoved({
      keychainPath,
      keychainListOutput: '    "/Users/runner/Library/Keychains/login.keychain-db"\n',
      remainingPaths: [],
    })).not.toThrow();
  });

  it('fails while the keychain is still on the search list', () => {
    // A deleted file whose keychain entry survives still means the runner is
    // carrying release-signing state into whatever runs next.
    expect(() => assertSigningMaterialRemoved({
      keychainPath,
      keychainListOutput: `    "${keychainPath}"\n`,
      remainingPaths: [],
    })).toThrow(/cleanup was incomplete/u);
  });

  it('fails while any private-key file remains on disk', () => {
    expect(() => assertSigningMaterialRemoved({
      keychainPath,
      keychainListOutput: '',
      remainingPaths: [`${keychainPath}.p12`],
    })).toThrow(/cleanup was incomplete.*\.p12/su);
  });
});
