// Node-issued complete-set grant, as the resident agent sees it.
//
// WHAT THIS REPLACES
//
// The worker used to establish for itself which helper it was allowed to run --
// first from a manifest in its own directory (self-attestation: whoever can
// replace the helper can replace that manifest in the same write), then from
// the LaunchAgent plist environment (`ps -E` and every child can read it). Both
// were removed. The authority is now minted by the process that ALREADY
// code-signature-verified the artifact set and handed to the resident agent
// over an authenticated control socket.
//
// WIRE FORM
//
// One bounded `k=v` line, the same grammar the launch binding uses. Not JSON:
// this is a security-critical parse, and a bespoke JSON parser here would be
// more code and more attack surface than the flat scalar shape needs. The
// grammar rejects unknown keys, repeated keys, oversized fields and any value
// it does not fully understand -- a partially applied grant is an agent that
// believes it is authorised for something the daemon never described.
//
// EVERY FIELD IS A BINDING, NOT A HINT
//
//   * uid / audit session / session type -- the grant is for ONE console
//     session. An audit session id is what distinguishes two successive login
//     windows, so a grant that outlived one would authorise a helper in a
//     session it was never issued for.
//   * serviceGeneration -- rotates when the resident agent is replaced, so the
//     agent can refuse a grant minted for a previous incarnation of itself.
//   * challenge -- unpredictable and single-use.
//   * expiry -- this is a launch capability, not a session credential.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_GRANT_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_GRANT_H_

#include <cstdint>
#include <string>

namespace imcodes::remote_desktop::macos {

/** Bounded so a hostile grant cannot force unbounded buffering. */
inline constexpr std::size_t kVirtualDisplayGrantMaxBytes = 1024;
/** Matches the launch challenge: 43-character base64url. */
inline constexpr std::size_t kVirtualDisplayGrantChallengeLength = 43;
/**
 * Numeric ceiling, mirrored from JavaScript.
 *
 * The producer is TypeScript, where every number is a double: anything above
 * 2^53-1 silently loses precision on the way out. Accepting a larger value here
 * would mean honouring a number the producer could not have meant.
 */
/** Upper bound on the presentation TTL; mirrors the TypeScript constant. */
inline constexpr std::uint64_t kVirtualDisplayGrantMaxLifetimeMs = 60'000;
inline constexpr std::uint64_t kVirtualDisplayGrantMaxSafeInteger =
    9007199254740991ULL;
/** Mirrored from the producer, which refuses a larger component outright. */
inline constexpr std::uint64_t kVirtualDisplayGrantMaxHelperBytes =
    512ULL * 1024ULL * 1024ULL;
/** A designated requirement is a bounded wire token, not free text. */
inline constexpr std::size_t kVirtualDisplayGrantMaxRequirementBytes = 512;

struct VirtualDisplayGrant {
  std::uint32_t uid = 0;
  std::uint32_t audit_session_id = 0;
  /** "Aqua" or "LoginWindow". Nothing else is admissible. */
  std::string session_type;
  std::uint64_t service_generation = 0;
  std::string challenge;
  /**
   * Presentation lifetime in milliseconds, NOT an absolute deadline.
   *
   * The deadline is formed by the authority link at the moment it receives the
   * challenge -- `received_at_ms + ttl_ms` on THIS process's CLOCK_MONOTONIC
   * -- and `MacosVirtualDisplayAgent::AcceptGrant` enforces it on that same
   * clock. Both sides of the comparison therefore come from one clock domain.
   *
   * It used to be an absolute epoch deadline stamped daemon-side, compared
   * here against CLOCK_MONOTONIC: always far in this clock's future, so the
   * expiry silently never fired. A duration cannot fail that way.
   */
  std::uint64_t ttl_ms = 0;
  std::string release_identity;
  std::string set_sha256;
  std::string helper_file_name;
  std::string helper_sha256;
  std::uint64_t helper_size = 0;
  std::string helper_designated_requirement;
  std::string helper_bundle_identifier;
  std::string team_id;
  /** "arm64" or "x64". */
  std::string arch;

  /**
   * Per-field shape only. Says nothing about whether the fields agree with
   * each other, and is therefore NOT sufficient to put a grant on the wire.
   */
  [[nodiscard]] bool ShapeValid() const noexcept;

  /**
   * Shape PLUS every cross-field rule the parser enforces.
   *
   * This is what the serializer must use. A serializer that only checked shape
   * could emit a line its own parser refuses -- two sides of one contract
   * disagreeing about what is expressible, which is exactly the kind of gap a
   * canonicalisation bypass lives in.
   */
  [[nodiscard]] bool WireCanonicalValid() const noexcept;

  /** Retained name, defined as the wire-canonical question. */
  [[nodiscard]] bool IsValid() const noexcept { return WireCanonicalValid(); }
};

/**
 * The ONE designated-requirement spelling this protocol admits.
 *
 * A substring test ("does the requirement mention this bundle") accepts a
 * requirement that ALSO says other things -- extra disjunctions, a second
 * anchor, a trailing clause that widens it. Only exact equality against a
 * requirement we construct ourselves pins the signer.
 */
[[nodiscard]] std::string CanonicalDesignatedRequirement(
    const std::string& bundle_identifier, const std::string& team_id);

/**
 * Parses exactly one grant line.
 *
 * Values are percent-escaped for the two fields that can contain spaces (the
 * designated requirement) so the grammar stays whitespace-delimited without
 * losing content.
 *
 * FRAMING. The caller is NOT assumed to have stripped the line ending, because
 * both callers exist: a getline payload arrives bare, a raw socket read keeps
 * whatever the writer sent. So exactly one terminator is tolerated -- `\n`,
 * `\r`, or `\r\n` -- and anything beyond that is refused as
 * `grant_frame_unusable`. The bound is not tidiness: the canonical-closure
 * check below compares against the STRIPPED text, so unbounded stripping would
 * let arbitrarily many distinct byte frames all name one authority while the
 * closure check remained structurally unable to tell them apart.
 */
/**
 * `error` receives a distinct diagnosis.
 *
 * "missing" and "malformed" are different failures with different operator
 * responses, and reporting both as one bool made the completeness check
 * indistinguishable from the shape checks -- so neither could be shown to be
 * doing work the other was not.
 */
[[nodiscard]] bool ParseVirtualDisplayGrant(const std::string& line,
                                            VirtualDisplayGrant* grant,
                                            std::string* error = nullptr);

[[nodiscard]] std::string SerializeVirtualDisplayGrant(
    const VirtualDisplayGrant& grant);

/** What the agent actually observes about itself, from the kernel. */
struct AgentSessionContext {
  std::uint32_t uid = 0;
  std::uint32_t audit_session_id = 0;
  std::string session_type;
  std::uint64_t service_generation = 0;

  [[nodiscard]] bool IsValid() const noexcept;
};

/** Distinct so a refusal is never ambiguous in the field. */
enum class GrantAdmission {
  kAdmitted,
  kMalformed,
  kUidMismatch,
  kAuditSessionMismatch,
  kSessionTypeMismatch,
  kServiceGenerationMismatch,
  kExpired,
  kChallengeReplayed,
};

/**
 * Decides whether a grant may be honoured RIGHT NOW.
 *
 * Replay is NOT decided here: a single "last challenge" cannot see A -> B -> A
 * and cannot make two concurrent presentations lose. That belongs to the
 * generation-scoped ledger, which reserves atomically. Every unmet condition
 * here is its own refusal, and there is no
 * "close enough" -- an agent that accepts a grant for a neighbouring session is
 * an agent that hands display ownership to the wrong login window.
 */
/**
 * `now_ms` is THIS process's monotonic clock.
 *
 * Presentation expiry is not decided here -- see the note at the definition.
 * `AcceptGrant` has already rejected an expired challenge against the deadline
 * the authority link formed at receipt, on this same monotonic clock, before
 * calling this function. The challenge ledger is not what enforces that
 * deadline: it enforces single use.
 */
[[nodiscard]] GrantAdmission EvaluateGrantAdmission(
    const VirtualDisplayGrant& grant,
    const AgentSessionContext& observed,
    std::uint64_t now_ms) noexcept;

[[nodiscard]] const char* GrantAdmissionText(GrantAdmission admission) noexcept;

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_GRANT_H_
