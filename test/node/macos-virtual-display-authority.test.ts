import { describe, expect, it } from 'vitest';

import { REMOTE_DESKTOP_MACOS_TEAM_ID } from '../../shared/remote-desktop-worker.js';
import {
  MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR,
  MACOS_VIRTUAL_DISPLAY_AUTHORITY_MAX_LIFETIME_MS,
  buildMacosVirtualDisplayAuthority,
  serializeMacosVirtualDisplayAuthority,
  type MacosVirtualDisplayAuthorityArtifact,
  type MacosVirtualDisplayAuthorityContext,
} from '../../shared/macos-virtual-display-authority.js';

const REQUIREMENT = 'identifier "cc.imcodes.node.virtual-display-helper" and anchor apple generic '
  + `and certificate leaf[subject.OU] = "${REMOTE_DESKTOP_MACOS_TEAM_ID}"`;

function artifact(
  overrides: Partial<MacosVirtualDisplayAuthorityArtifact> = {},
  helperOverrides: Record<string, unknown> = {},
  bundleOverrides: Record<string, unknown> = {},
): MacosVirtualDisplayAuthorityArtifact {
  return {
    setSha256: 'd'.repeat(64),
    releaseName: `sha256-${'d'.repeat(64)}`,
    manifest: {
      arch: 'arm64',
      components: {
        virtualDisplayHelper: {
          fileName: 'imcodes-virtual-display-helper',
          size: 4096,
          sha256: 'e'.repeat(64),
          ...helperOverrides,
        } as never,
      },
      codeSignature: {
        teamId: REMOTE_DESKTOP_MACOS_TEAM_ID,
        bundles: {
          virtualDisplayHelper: {
            bundleIdentifier: 'cc.imcodes.node.virtual-display-helper',
            designatedRequirement: REQUIREMENT,
            hardenedRuntime: true,
            ...bundleOverrides,
          } as never,
        },
      },
    },
    ...overrides,
  } as MacosVirtualDisplayAuthorityArtifact;
}

function context(
  overrides: Partial<MacosVirtualDisplayAuthorityContext> = {},
): MacosVirtualDisplayAuthorityContext {
  return {
    uid: 501,
    auditSessionId: 100_003,
    sessionType: 'Aqua',
    serviceGeneration: 7,
    challenge: 'A'.repeat(43),
    ...overrides,
  };
}

describe('macOS virtual-display complete-set authority', () => {
  it('refuses a SELF-CONSISTENT foreign-team artifact before any helper authority', () => {
    // The forged-object case. `MacosVirtualDisplayAuthorityArtifact` is a plain
    // TypeScript type, so a caller can hand-build one; TypeScript proves only
    // its SHAPE, never that it came out of verification. Here the manifest names
    // a foreign team AND the designated requirement is derived from that same
    // team, so nothing inside the object disagrees with anything else. It is
    // rejected solely because the team is not the one the product ships under.
    for (const foreign of ['ABCDE12345', 'ZZZZZ99999']) {
      const requirement = 'identifier "cc.imcodes.node.virtual-display-helper" '
        + `and anchor apple generic and certificate leaf[subject.OU] = "${foreign}"`;
      const forged = artifact({}, {}, { designatedRequirement: requirement });
      (forged.manifest.codeSignature as { teamId: string }).teamId = foreign;
      expect(
        () => buildMacosVirtualDisplayAuthority(forged, context()),
        foreign,
      ).toThrow(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.INVALID_ARTIFACT);
    }
  });

  it('is constructed from the verified artifact and never from the filesystem', () => {
    const authority = buildMacosVirtualDisplayAuthority(artifact(), context());
    expect(authority.helperSha256).toBe('e'.repeat(64));
    expect(authority.setSha256).toBe('d'.repeat(64));
    expect(authority.releaseIdentity).toBe(`sha256-${'d'.repeat(64)}`);
    expect(authority.helperDesignatedRequirement).toBe(REQUIREMENT);
    // Bound to the exact session it was minted for. A grant that outlived its
    // audit session would authorise a helper in a login window it was never
    // issued for.
    expect(authority.uid).toBe(501);
    expect(authority.auditSessionId).toBe(100_003);
    expect(authority.serviceGeneration).toBe(7);
    // Short-lived by construction: this is a launch capability, not a session
    // credential. A DURATION, not a deadline -- the agent measures it on its
    // own monotonic clock, where this process's epoch instant means nothing.
    expect(authority.ttlMs).toBe(MACOS_VIRTUAL_DISPLAY_AUTHORITY_MAX_LIFETIME_MS);
    expect(Object.isFrozen(authority)).toBe(true);
  });

  it('refuses an artifact that cannot fully describe the helper', () => {
    const cases: Array<[string, () => unknown]> = [
      ['missing release name', () => buildMacosVirtualDisplayAuthority(
        artifact({ releaseName: undefined }), context())],
      ['malformed release name', () => buildMacosVirtualDisplayAuthority(
        artifact({ releaseName: 'not/a/release' }), context())],
      ['malformed set digest', () => buildMacosVirtualDisplayAuthority(
        artifact({ setSha256: 'nothex' }), context())],
      ['malformed helper digest', () => buildMacosVirtualDisplayAuthority(
        artifact({}, { sha256: 'A'.repeat(64) }), context())],
      ['zero helper size', () => buildMacosVirtualDisplayAuthority(
        artifact({}, { size: 0 }), context())],
      ['empty helper filename', () => buildMacosVirtualDisplayAuthority(
        artifact({}, { fileName: '' }), context())],
      ['blank designated requirement', () => buildMacosVirtualDisplayAuthority(
        artifact({}, {}, { designatedRequirement: '' }), context())],
      // A helper without hardened runtime is not the helper we shipped.
      ['no hardened runtime', () => buildMacosVirtualDisplayAuthority(
        artifact({}, {}, { hardenedRuntime: false }), context())],
      ['malformed team id', () => buildMacosVirtualDisplayAuthority(
        { ...artifact(), manifest: { ...artifact().manifest,
          codeSignature: { ...artifact().manifest.codeSignature, teamId: 'bad' } } },
        context())],
    ];
    for (const [label, run] of cases) {
      expect(run, `accepted an artifact with a ${label}`)
        .toThrow(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.INVALID_ARTIFACT);
    }
  });

  it('refuses a session, challenge or expiry it cannot bind to', () => {
    expect(() => buildMacosVirtualDisplayAuthority(artifact(), context({ uid: 0 })))
      .toThrow(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.INVALID_SESSION);
    expect(() => buildMacosVirtualDisplayAuthority(artifact(), context({ auditSessionId: 0 })))
      .toThrow(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.INVALID_SESSION);
    expect(() => buildMacosVirtualDisplayAuthority(artifact(), context({ serviceGeneration: 0 })))
      .toThrow(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.INVALID_SESSION);
    expect(() => buildMacosVirtualDisplayAuthority(artifact(), context({ sessionType: 'Console' })))
      .toThrow(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.INVALID_SESSION);
    // A short or non-base64url challenge is guessable, and every later frame is
    // authenticated by echoing it.
    expect(() => buildMacosVirtualDisplayAuthority(artifact(), context({ challenge: 'A'.repeat(42) })))
      .toThrow(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.INVALID_CHALLENGE);
    expect(() => buildMacosVirtualDisplayAuthority(artifact(), context({ challenge: `${'A'.repeat(42)}/` })))
      .toThrow(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.INVALID_CHALLENGE);
    // A lifetime beyond the ceiling would let a launch capability behave like a
    // session credential.
    expect(() => buildMacosVirtualDisplayAuthority(artifact(),
      context({ lifetimeMs: MACOS_VIRTUAL_DISPLAY_AUTHORITY_MAX_LIFETIME_MS + 1 })))
      .toThrow(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.INVALID_EXPIRY);
    expect(() => buildMacosVirtualDisplayAuthority(artifact(), context({ lifetimeMs: 0 })))
      .toThrow(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.INVALID_EXPIRY);
  });

  it('serialises to one bounded k=v line the native parser accepts', () => {
    const line = serializeMacosVirtualDisplayAuthority(
      buildMacosVirtualDisplayAuthority(artifact(), context()));
    // Must stay under the native ceiling; the native side refuses anything
    // larger before parsing.
    expect(line.length).toBeLessThanOrEqual(1024);
    expect(line).not.toContain('\n');
    expect(line.startsWith('grant1 ')).toBe(true);
    // Exactly the 15 keys the native grammar knows. An unknown key is refused
    // there, so an extra one here would be a hard interop break rather than a
    // forward-compatible addition.
    const keys = line.split(' ').slice(1).map((token) => token.split('=')[0]);
    expect([...keys].sort()).toEqual([
      'arch', 'asid', 'challenge', 'dr', 'helperbundle',
      'helperfile', 'helpersha', 'helpersize', 'release', 'session', 'set',
      'svcgen', 'team', 'ttl', 'uid',
    ]);
    // The designated requirement contains spaces and quotes and must survive
    // the whitespace-delimited grammar; a truncated requirement would make the
    // agent check the wrong thing.
    const dr = line.split(' ').find((token) => token.startsWith('dr='))!;
    expect(dr).toContain('%20');
    expect(dr).not.toContain(' ');
  });
});
