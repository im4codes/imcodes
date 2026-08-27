/**
 * Complete-set authority for the macOS virtual-display helper.
 *
 * WHY THIS TYPE EXISTS
 *
 * The native side must never establish, for itself, which helper it is allowed
 * to run. Two earlier shapes both failed that test:
 *
 *   * Reading the expected helper digest from the manifest sitting next to the
 *     worker. That is self-attestation -- whoever can replace the helper can
 *     replace that manifest in the same write, and the check passes.
 *   * Carrying the digest in the LaunchAgent plist environment. `ps -E` and any
 *     child process can read an environment, and a readable authority is a
 *     forgeable one.
 *
 * So the authority is constructed HERE, in the process that already
 * code-signature-verified the artifact set, and handed to the resident agent
 * over an authenticated control socket -- never through the filesystem, argv or
 * the environment.
 *
 * Every field is load-bearing, and the constructor below refuses rather than
 * defaults. A grant that is half-understood is worse than no grant: the agent
 * would believe it is authorised for something the daemon never described.
 */

/** Bounded so a hostile or corrupt grant can never force unbounded buffering. */
// Must match kVirtualDisplayGrantMaxBytes on the native side.
export const MACOS_VIRTUAL_DISPLAY_AUTHORITY_MAX_BYTES = 1024 as const;

/**
 * How long a grant may be presented. Short on purpose: this is a launch-time
 * capability, not a session credential, and a long-lived grant survives the
 * conditions that justified it (same console user, same audit session).
 */
export const MACOS_VIRTUAL_DISPLAY_AUTHORITY_MAX_LIFETIME_MS = 60_000 as const;

/** Challenge length matches the existing launch challenge (43-char base64url). */
export const MACOS_VIRTUAL_DISPLAY_AUTHORITY_CHALLENGE_LENGTH = 43 as const;

export const MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR = Object.freeze({
  INVALID_ARTIFACT: 'macos_virtual_display_authority_invalid_artifact',
  INVALID_SESSION: 'macos_virtual_display_authority_invalid_session',
  INVALID_CHALLENGE: 'macos_virtual_display_authority_invalid_challenge',
  INVALID_EXPIRY: 'macos_virtual_display_authority_invalid_expiry',
  /** The value handed to the serializer is not something the wire admits. */
  NOT_WIRE_CANONICAL: 'macos_virtual_display_authority_not_wire_canonical',
} as const);

import { REMOTE_DESKTOP_MACOS_TEAM_ID } from './remote-desktop-worker.js';

const SHA256_RE = /^[0-9a-f]{64}$/u;
const RELEASE_RE = /^[A-Za-z0-9._-]{1,96}$/u;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/u;
const BUNDLE_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/u;
const TEAM_RE = /^[A-Z0-9]{10}$/u;
/** Mirrors the native token grammar exactly: no spaces, no control, no Unicode. */
const TOKEN_RE = /^[A-Za-z0-9._-]{1,128}$/u;
/**
 * A requirement is a bounded wire token, not free text.
 *
 * Exported because the cross-language matrix probes exactly this boundary on
 * both sides; a test that hardcoded the number would keep passing if only one
 * side moved.
 */
// Must match kVirtualDisplayGrantMaxRequirementBytes on the native side.
export const MACOS_VIRTUAL_DISPLAY_AUTHORITY_MAX_REQUIREMENT_BYTES = 512 as const;
const MAX_REQUIREMENT_BYTES = MACOS_VIRTUAL_DISPLAY_AUTHORITY_MAX_REQUIREMENT_BYTES;
const MAX_HELPER_BYTES = 512 * 1024 * 1024;
/** UINT32_MAX is reserved on the native side, so it is not a usable uid/asid. */
const MAX_UID = 0xffff_fffe;

/**
 * The ONE designated-requirement spelling this protocol admits.
 *
 * Built here rather than accepted from the manifest, and compared for EXACT
 * equality on both sides. A substring test would accept a requirement that
 * mentions the right bundle and ALSO says other things -- an extra disjunction
 * or a second anchor widens who satisfies it.
 */
export function canonicalDesignatedRequirement(
  bundleIdentifier: string,
  teamId: string,
): string {
  // Validated BEFORE interpolation, mirroring the native side, which returns an
  // empty string for inputs it cannot vouch for. A requirement assembled from
  // an unchecked identifier is a requirement whose text an attacker chose: a
  // bundle identifier containing a quote closes the string early and the rest
  // becomes requirement syntax.
  if (!BUNDLE_RE.test(bundleIdentifier) || !TEAM_RE.test(teamId)) {
    return '';
  }
  // Every clause is load-bearing and must be spelled exactly this way on both
  // sides. `anchor apple generic` is what demands an Apple-issued chain --
  // without it a self-signed binary with the right identifier and OU satisfies
  // the requirement.
  return `identifier "${bundleIdentifier}" and anchor apple generic `
    + `and certificate leaf[subject.OU] = "${teamId}"`;
}

/** Printable ASCII only, measured in BYTES, not code points. */
function printableAscii(value: string, maximumBytes: number): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) return false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}
const SESSION_TYPES = Object.freeze(['Aqua', 'LoginWindow'] as const);
const ARCHITECTURES = Object.freeze(['arm64', 'x64'] as const);

export type MacosVirtualDisplaySessionType = typeof SESSION_TYPES[number];
export type MacosVirtualDisplayArchitecture = typeof ARCHITECTURES[number];

export interface MacosVirtualDisplayAuthority {
  /** Console user the helper must run as. A root helper has no Aqua session. */
  readonly uid: number;
  /**
   * Kernel audit session id.
   *
   * Carried because the session type alone cannot tell two successive login
   * windows apart, and a grant issued for one must not survive into the next.
   */
  readonly auditSessionId: number;
  readonly sessionType: MacosVirtualDisplaySessionType;
  /**
   * Monotonic per-agent-service generation.
   *
   * Distinct from the route generation: it rotates when the resident agent is
   * replaced, which is what lets the agent reject a grant minted for the
   * previous incarnation of itself.
   */
  readonly serviceGeneration: number;
  /** Unpredictable, single-use, and bound to this exact grant. */
  readonly challenge: string;
  /**
   * How long the grant may be PRESENTED for, in milliseconds.
   *
   * A TTL rather than an absolute deadline, because the two ends do not share
   * a clock. `macos_virtual_display_authority_link` turns this duration into a
   * deadline when it RECEIVES the challenge, using the receiver's own
   * CLOCK_MONOTONIC, and `AcceptGrant` enforces that deadline on the same
   * clock before it admits anything. The challenge ledger does not police
   * presentation expiry; it makes a challenge single-use.
   *
   * History, since it explains the shape: this field once carried an absolute
   * epoch deadline minted daemon-side. The agent compared it against
   * CLOCK_MONOTONIC, which counts from boot, so the deadline was always
   * astronomically larger than the agent's "now" and the expiry never once
   * fired. A duration is clock-agnostic and has no such failure mode.
   */
  readonly ttlMs: number;
  /** Release directory name the whole set was published under. */
  readonly releaseIdentity: string;
  /** Digest of the complete verified set, not of a single component. */
  readonly setSha256: string;
  readonly helperFileName: string;
  readonly helperSha256: string;
  readonly helperSize: number;
  /** Exact designated requirement the agent must check with SecStaticCode. */
  readonly helperDesignatedRequirement: string;
  readonly helperBundleIdentifier: string;
  readonly teamId: string;
  readonly arch: MacosVirtualDisplayArchitecture;
}

/** The minimum the constructor needs; matches VerifiedMacosRemoteDesktopArtifact. */
export interface MacosVirtualDisplayAuthorityArtifact {
  readonly setSha256: string;
  readonly releaseName?: string;
  readonly manifest: {
    readonly arch: string;
    readonly components: Record<string, { fileName: string; size: number; sha256: string }>;
    readonly codeSignature: {
      readonly teamId: string;
      readonly bundles: Record<string, {
        bundleIdentifier: string;
        designatedRequirement: string;
        hardenedRuntime: boolean;
      }>;
    };
  };
}

export interface MacosVirtualDisplayAuthorityContext {
  readonly uid: number;
  readonly auditSessionId: number;
  readonly sessionType: string;
  readonly serviceGeneration: number;
  readonly challenge: string;
  readonly lifetimeMs?: number;
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value > 0 && value <= maximum;
}

/**
 * Builds the in-memory grant from an ALREADY-VERIFIED artifact.
 *
 * This never reads the filesystem. The artifact it is handed has already had
 * every component's signature, digest and notarization checked; re-deriving any
 * of that here would only re-introduce a path where a weaker check wins.
 */
export function buildMacosVirtualDisplayAuthority(
  artifact: MacosVirtualDisplayAuthorityArtifact,
  context: MacosVirtualDisplayAuthorityContext,
): MacosVirtualDisplayAuthority {
  const helper = artifact.manifest.components.virtualDisplayHelper;
  const helperBundle = artifact.manifest.codeSignature.bundles.virtualDisplayHelper;
  if (!helper || !helperBundle
    || typeof artifact.releaseName !== 'string' || !RELEASE_RE.test(artifact.releaseName)
    || !SHA256_RE.test(artifact.setSha256)
    // The release directory name IS `sha256-` + the set digest. A pair that
    // disagrees describes two different sets, and the native side refuses it,
    // so producing one here would be an interop break rather than a warning.
    || artifact.releaseName !== `sha256-${artifact.setSha256}`
    || !SHA256_RE.test(helper.sha256)
    // Strict token: the native grammar is whitespace-delimited, so a filename
    // with a space would not survive the crossing at all.
    || !TOKEN_RE.test(helper.fileName)
    || !positiveInteger(helper.size, MAX_HELPER_BYTES)
    // BUNDLE_RE only: its character set is a strict subset of TOKEN_RE's and
    // its length bound is the same, so testing both was testing one. The
    // native side now applies the identical rule via IsBundleIdentifier.
    || !BUNDLE_RE.test(helperBundle.bundleIdentifier)
    || !printableAscii(helperBundle.designatedRequirement, MAX_REQUIREMENT_BYTES)
    // EXACT canonical spelling. Anything else is a requirement the native side
    // will refuse, so emitting it would be an interop break, not a warning.
    || helperBundle.designatedRequirement !== canonicalDesignatedRequirement(
      helperBundle.bundleIdentifier, artifact.manifest.codeSignature.teamId)
    // A helper without hardened runtime is not the helper we shipped.
    || helperBundle.hardenedRuntime !== true
    // EXACT, not shaped. This boundary accepts an already-TYPED artifact
    // object, so TypeScript proves nothing about where it came from: a
    // caller can hand-build one whose manifest names a foreign team and
    // whose designated requirement is derived from that same team, making
    // it self-consistent. Only comparing against the team the product
    // actually ships under rejects it.
    || artifact.manifest.codeSignature.teamId !== REMOTE_DESKTOP_MACOS_TEAM_ID
    || !ARCHITECTURES.some((value) => value === artifact.manifest.arch)) {
    throw new Error(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.INVALID_ARTIFACT);
  }
  if (!positiveInteger(context.uid, MAX_UID)
    || !positiveInteger(context.auditSessionId, MAX_UID)
    || !positiveInteger(context.serviceGeneration, Number.MAX_SAFE_INTEGER)
    || !SESSION_TYPES.some((value) => value === context.sessionType)) {
    throw new Error(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.INVALID_SESSION);
  }
  if (!CHALLENGE_RE.test(context.challenge)) {
    throw new Error(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.INVALID_CHALLENGE);
  }
  const lifetime = context.lifetimeMs ?? MACOS_VIRTUAL_DISPLAY_AUTHORITY_MAX_LIFETIME_MS;
  // No `nowMs`, and no safe-add.
  //
  // Both were load-bearing when this emitted `nowMs + lifetime` as an absolute
  // deadline: the sum could exceed 2^53-1, lose precision, and produce an
  // expiry nobody chose. The wire now carries the DURATION itself, so there is
  // no sum, nothing to overflow, and no reason to demand a clock reading the
  // output does not depend on. Keeping the parameter would be an API that
  // implies this value still matters to the grant -- it does not.
  if (!positiveInteger(lifetime, MACOS_VIRTUAL_DISPLAY_AUTHORITY_MAX_LIFETIME_MS)) {
    throw new Error(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.INVALID_EXPIRY);
  }
  return Object.freeze({
    uid: context.uid,
    auditSessionId: context.auditSessionId,
    sessionType: context.sessionType as MacosVirtualDisplaySessionType,
    serviceGeneration: context.serviceGeneration,
    challenge: context.challenge,
    ttlMs: lifetime,
    releaseIdentity: artifact.releaseName,
    setSha256: artifact.setSha256,
    helperFileName: helper.fileName,
    helperSha256: helper.sha256,
    helperSize: helper.size,
    helperDesignatedRequirement: helperBundle.designatedRequirement,
    helperBundleIdentifier: helperBundle.bundleIdentifier,
    teamId: artifact.manifest.codeSignature.teamId,
    arch: artifact.manifest.arch as MacosVirtualDisplayArchitecture,
  });
}

/**
 * Wire form for the control socket: one bounded `k=v` line.
 *
 * Deliberately NOT JSON. This is a security-critical parse on the native side,
 * and a bespoke JSON parser there would be more code and more attack surface
 * than this flat scalar shape needs. The grammar matches the launch binding's,
 * so there is one parsing discipline rather than two.
 *
 * Only the designated requirement can contain spaces, so it is percent-encoded;
 * everything else is already token-shaped.
 */
function percentEncode(value: string): string {
  let encoded = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '%' || character === ' ' || code < 0x20 || code > 0x7e) {
      encoded += `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
      continue;
    }
    encoded += character;
  }
  return encoded;
}

/**
 * Runtime shape check, mirroring the native `ShapeValid()` field for field.
 *
 * WHY THIS EXISTS RATHER THAN THE TYPE.
 *
 * `MacosVirtualDisplayAuthority` is a compile-time interface and the builder
 * returns a frozen object, so it was tempting to treat a value of that type as
 * already trustworthy. It is not, and neither guard survives contact with
 * ordinary JavaScript:
 *
 *   * The interface is erased at runtime. Anything can be asserted into it.
 *   * `Object.freeze` prevents mutation of THAT object; it does nothing about
 *     `{ ...authority, uid: 0 }`, which is a brand-new unfrozen object that
 *     type-checks perfectly and never went through the builder.
 *   * The builder is only one of the ways a value reaches the serializer. A
 *     check that lives in the builder protects the builder's callers, not the
 *     wire.
 *
 * So the serializer validates what it is actually handed, at the moment it is
 * handed it. Every field is re-derived from the value itself.
 */
export function macosVirtualDisplayAuthorityShapeValid(
  value: unknown,
): value is MacosVirtualDisplayAuthority {
  if (typeof value !== 'object' || value === null) return false;
  const grant = value as Record<string, unknown>;
  return positiveInteger(grant.uid, MAX_UID)
    && positiveInteger(grant.auditSessionId, MAX_UID)
    && positiveInteger(grant.serviceGeneration, Number.MAX_SAFE_INTEGER)
    && positiveInteger(grant.ttlMs, MACOS_VIRTUAL_DISPLAY_AUTHORITY_MAX_LIFETIME_MS)
    && positiveInteger(grant.helperSize, MAX_HELPER_BYTES)
    && SESSION_TYPES.some((entry) => entry === grant.sessionType)
    && ARCHITECTURES.some((entry) => entry === grant.arch)
    && typeof grant.challenge === 'string' && CHALLENGE_RE.test(grant.challenge)
    && typeof grant.releaseIdentity === 'string'
    && RELEASE_RE.test(grant.releaseIdentity)
    && typeof grant.setSha256 === 'string' && SHA256_RE.test(grant.setSha256)
    && typeof grant.helperSha256 === 'string' && SHA256_RE.test(grant.helperSha256)
    && typeof grant.helperFileName === 'string' && TOKEN_RE.test(grant.helperFileName)
    && typeof grant.helperBundleIdentifier === 'string'
    && BUNDLE_RE.test(grant.helperBundleIdentifier)
    // Pinned, not shaped: a grant is what the resident helper is told it may
    // run, so a foreign team surviving the round trip would re-open the hole
    // the artifact boundary above just closed.
    && grant.teamId === REMOTE_DESKTOP_MACOS_TEAM_ID
    && typeof grant.helperDesignatedRequirement === 'string'
    && printableAscii(grant.helperDesignatedRequirement, MAX_REQUIREMENT_BYTES);
}

/**
 * Shape PLUS every cross-field rule, mirroring the native
 * `WireCanonicalValid()`.
 *
 * This is what the serializer gates on. Gating on shape alone would let this
 * end emit a line the other end refuses -- the two halves of one contract
 * disagreeing about what is expressible, which is exactly the seam a
 * canonicalisation bypass lives in.
 */
export function macosVirtualDisplayAuthorityWireCanonicalValid(
  value: unknown,
): value is MacosVirtualDisplayAuthority {
  if (!macosVirtualDisplayAuthorityShapeValid(value)) return false;
  // The release directory name IS `sha256-` + the set digest by construction,
  // so a pair that disagrees is a grant assembled from two different sets.
  if (value.releaseIdentity !== `sha256-${value.setSha256}`) return false;
  // EXACT, not substring: a requirement that merely mentions the right bundle
  // can also say other things, and each extra clause widens who satisfies it.
  return value.helperDesignatedRequirement === canonicalDesignatedRequirement(
    value.helperBundleIdentifier, value.teamId);
}

export function serializeMacosVirtualDisplayAuthority(
  authority: MacosVirtualDisplayAuthority,
): string {
  // Validated HERE, not inherited from the builder, the interface or the
  // freeze. None of those three survive `{ ...authority, uid: 0 }`.
  if (!macosVirtualDisplayAuthorityWireCanonicalValid(authority)) {
    throw new Error(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.NOT_WIRE_CANONICAL);
  }
  const line = [
    'grant1',
    `uid=${authority.uid}`,
    `asid=${authority.auditSessionId}`,
    `session=${authority.sessionType}`,
    `svcgen=${authority.serviceGeneration}`,
    `challenge=${authority.challenge}`,
    `ttl=${authority.ttlMs}`,
    `release=${authority.releaseIdentity}`,
    `set=${authority.setSha256}`,
    `helperfile=${authority.helperFileName}`,
    `helpersha=${authority.helperSha256}`,
    `helpersize=${authority.helperSize}`,
    `dr=${percentEncode(authority.helperDesignatedRequirement)}`,
    `helperbundle=${authority.helperBundleIdentifier}`,
    `team=${authority.teamId}`,
    `arch=${authority.arch}`,
  ].join(' ');
  if (line.length > MACOS_VIRTUAL_DISPLAY_AUTHORITY_MAX_BYTES) {
    throw new Error(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.INVALID_ARTIFACT);
  }
  return line;
}
