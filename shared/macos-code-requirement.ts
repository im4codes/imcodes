/**
 * The one place the canonical Apple designated requirement is spelled in
 * TypeScript.
 *
 * It lives in `shared/` because both the worker manifest validator and the
 * virtual-display authority validate the SAME manifest field, and they had
 * drifted into two different spellings of it: one demanded the Developer ID
 * marker extensions, the other did not. Since the comparison is byte equality,
 * no manifest could satisfy both -- the virtual-display path could never
 * authenticate, and nothing said so.
 *
 * Two further copies exist because they cannot import this file:
 * `src/node/macos-apple-trust.mjs` (plain .mjs, run directly by build scripts
 * on a machine with no TypeScript) and
 * `native/macos-remote-desktop/macos_code_requirement.h`.
 * `test/node/macos-code-requirement-agreement.test.ts` asserts all of them
 * produce identical text.
 */

/**
 * Quote a requirement literal exactly as codesign does.
 *
 * The rule is NOT the identifier syntax it looks like. It was determined by
 * signing a probe binary with a real Developer ID certificate and reading back
 * what `codesign -d -r-` printed, because two plausible-looking rules inferred
 * from samples were both wrong. The observed table:
 *
 *   helper      -> helper        abc     -> abc
 *   helper1     -> helper1       A1      -> A1
 *   Helper      -> Helper
 *   _helper     -> "_helper"     a_b     -> "a_b"     __      -> "__"
 *   1abc        -> "1abc"        ab-cd   -> "ab-cd"
 *   a.b         -> "a.b"         a.b.c   -> "a.b.c"   a..b    -> "a..b"
 *   .a          -> ".a"          a.      -> "a."      a-b.c   -> "a-b.c"
 *
 * So: bare only when the WHOLE literal is a letter followed by letters and
 * digits. An underscore quotes it. A dot quotes it -- which means every bundle
 * identifier is always quoted, and only a team ID is ever bare.
 *
 * Two earlier versions of this cost a release each. The first quoted
 * everything, generalised from one sample whose team ID began with a digit.
 * The second treated the literal as dot-separated segments and required each
 * to be identifier-shaped, which passed all four samples then available and
 * still got `cc.example.helper` and `_helper` wrong.
 */
export function codeRequirementLiteral(value: string): string {
  return /^[A-Za-z][A-Za-z0-9]*$/u.test(value) ? value : `"${value}"`;
}

/**
 * Exactly what codesign derives for a Developer ID Application certificate.
 *
 * Every clause is load-bearing. `anchor apple generic` is what demands an
 * Apple-issued chain -- without it a self-signed binary carrying the right
 * identifier and OU satisfies the requirement. The two marker OIDs are what
 * distinguish a Developer ID leaf from an Apple Development certificate issued
 * to the same team, which is otherwise free to impersonate the product.
 */
export function appleDesignatedRequirement(
  bundleIdentifier: string,
  teamId: string,
): string {
  return `identifier ${codeRequirementLiteral(bundleIdentifier)} and anchor apple generic`
    + ' and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */'
    + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */'
    + ` and certificate leaf[subject.OU] = ${codeRequirementLiteral(teamId)}`;
}
