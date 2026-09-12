import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { macosCodeRequirementLiteral } from '../../src/node/macos-apple-trust.mjs';
import {
  appleDesignatedRequirement,
  codeRequirementLiteral,
} from '../../shared/macos-code-requirement.js';
import { remoteDesktopCodeRequirementLiteral } from '../../scripts/remote-desktop-worker-artifacts.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The rule cannot be imported everywhere it is needed, so it exists four
 * times: once in `shared/` for TypeScript, once in `src/node/*.mjs` for build
 * scripts that run without TypeScript, once in `scripts/*.mjs` because
 * `shared/` is copied into the Docker image alone and must not import from
 * `src/`, and once in a C++ header for the native components.
 *
 * Four copies of a string compared for byte equality is four chances to ship a
 * component that can never authenticate, which is what happened: two native
 * validators still demanded a requirement without the Developer ID markers,
 * and the release guard quoted a team ID that codesign leaves bare.
 */
const LITERAL_CASES: ReadonlyArray<readonly [string, string]> = [
  // Every one of these was READ BACK from a probe binary signed with a real
  // Developer ID certificate, not reasoned about. Two rules that looked right
  // -- "quote everything" and "quote unless every dot-separated segment is
  // identifier-shaped" -- each passed the samples then available and each
  // failed a release.
  //
  // Bare: a letter followed by letters and digits, and nothing else.
  ['helper', 'helper'],
  ['helper1', 'helper1'],
  ['Helper', 'Helper'],
  ['abc', 'abc'],
  ['A1', 'A1'],
  // Our team ID is in that class, which is why it must NOT be quoted.
  ['M675E26Q67', 'M675E26Q67'],
  // An underscore quotes it. This is the case the segment-based rule got
  // wrong, and nothing in the requirement grammar suggests it.
  ['_helper', '"_helper"'],
  ['a_b', '"a_b"'],
  ['__', '"__"'],
  // A leading digit quotes it.
  ['1abc', '"1abc"'],
  ['5QTX4F9G92', '"5QTX4F9G92"'],
  // A hyphen quotes it.
  ['ab-cd', '"ab-cd"'],
  // A dot quotes it -- so every bundle identifier is always quoted, however
  // ordinary it looks.
  ['a.b', '"a.b"'],
  ['a.b.c', '"a.b.c"'],
  ['a..b', '"a..b"'],
  ['.a', '".a"'],
  ['a.', '"a."'],
  ['a-b.c', '"a-b.c"'],
  ['cc.example.helper', '"cc.example.helper"'],
  ['cc.imcodes.node.remote-desktop-worker', '"cc.imcodes.node.remote-desktop-worker"'],
  ['org.115browser.115Browser', '"org.115browser.115Browser"'],
  ['', '""'],
];


describe('macOS code requirement literal agreement', () => {
  it.each(LITERAL_CASES)('quotes %j as %j in every implementation', (value, expected) => {
    expect(codeRequirementLiteral(value)).toBe(expected);
    expect(remoteDesktopCodeRequirementLiteral(value)).toBe(expected);
    // The .mjs copy refuses an empty value outright rather than returning `""`,
    // because it is called by a build script where an empty identifier is a
    // missing argument, not a literal to encode.
    if (value !== '') expect(macosCodeRequirementLiteral(value)).toBe(expected);
  });

  it('builds the exact text codesign emits for a Developer ID signature', () => {
    // The golden. Note the asymmetry: the bundle identifier is quoted for its
    // hyphens, the team ID is not. Both were verified against a real Developer
    // ID signature.
    expect(appleDesignatedRequirement('cc.imcodes.node.remote-desktop-worker', 'M675E26Q67')).toBe(
      'identifier "cc.imcodes.node.remote-desktop-worker" and anchor apple generic'
      + ' and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */'
      + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */'
      + ' and certificate leaf[subject.OU] = M675E26Q67',
    );
  });

  /**
   * The native copy is pinned through the golden literal its own test spells
   * out, rather than by compiling the header here: if that literal ever drifts
   * from this rule, one of the two tests fails and names which.
   */
  it('agrees with the literal the native peer-identity test pins', async () => {
    const source = await readFile(
      new URL('../spec/macos-remote-desktop-peer-identity-test.mm', import.meta.url), 'utf8',
    );
    const bundleIdentifier = 'cc.imcodes.node.remote-desktop-agent';
    const teamId = 'ABCDE12345';
    expect(source).toContain(`constexpr char kBundleIdentifier[] = "${bundleIdentifier}";`);
    expect(source).toContain(`constexpr char kTeamId[] = "${teamId}";`);
    // Reassembled the way C++ adjacent-string concatenation joins it.
    const golden = appleDesignatedRequirement(bundleIdentifier, teamId);
    // Exactly the adjacent string literals C++ concatenates for this field,
    // and nothing else in the file.
    const field = source.slice(source.indexOf('.designated_requirement ='));
    const spelled = [...field.slice(0, field.indexOf('",\n') + 1).matchAll(/"((?:[^"\\]|\\.)*)"/gu)]
      .map((match) => match[1]!.replace(/\\"/gu, '"'))
      .join('');
    expect(spelled).toBe(golden);
  });

  /**
   * The header must not grow a second spelling of the requirement. Both native
   * translation units had one, and both were stale.
   */
  it('leaves the native requirement spelled in exactly one header', async () => {
    const matches = await Promise.all([
      'native/macos-remote-desktop/macos_peer_identity.mm',
      'native/macos-remote-desktop/macos_virtual_display_grant.cc',
      'native/macos-remote-desktop/macos_code_requirement.h',
    ].map(async (path) => [path, await readFile(new URL(path, `file://${repositoryRoot}`), 'utf8')] as const));
    for (const [path, source] of matches) {
      const spellings = source.split('subject.OU').length - 1;
      expect(`${path}:${spellings}`).toBe(`${path}:${path.endsWith('.h') ? 1 : 0}`);
    }
  });
});
