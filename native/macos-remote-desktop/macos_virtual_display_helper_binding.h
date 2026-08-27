// Launch-time identity binding for the resident virtual-display helper.
//
// THE RULE THIS EXISTS TO ENFORCE: the helper must not bind its own authority
// from the first frame it happens to receive.
//
// If the first HOLD on the socket established the generation, then anything
// that could reach the socket first would own the display: a stale worker that
// has not noticed it was superseded, a racing second worker, or any process of
// the same uid that connected before the real host did. "First frame wins" is
// not authentication, it is a race.
//
// So the binding arrives out of band, at launch, on an inherited descriptor:
//   * The host generates an UNPREDICTABLE epoch and per-session cookie seed
//     from the system CSPRNG. Unpredictable matters because every later command
//     is authenticated by echoing them; a counter would let a stale peer guess
//     the next one.
//   * It is passed on an inherited fd rather than argv, because argv is visible
//     to every process of this uid through `ps`, and a readable epoch is a
//     forgeable one.
//   * It carries the Aqua uid, the release identity and the generation the host
//     intends to own, so the helper can refuse a launch context that does not
//     match the one it is running in.
//   * It must be consumed BEFORE any command is accepted. A helper that has not
//     been bound answers nothing.
//
// All of this is pure parsing and comparison so it is provable with no helper,
// no socket, no display and no WindowServer.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_BINDING_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_BINDING_H_

#include <cstdint>
#include <string>

namespace imcodes::remote_desktop::macos {

/** Hard cap for the single binding line, newline included. */
// 320: the binding carries a release name of `sha256-` + 64 hex = 71
// characters plus four numeric fields; 256 left no headroom.
inline constexpr std::size_t kVirtualDisplayHelperBindingMaxBytes = 320;

struct VirtualDisplayHelperBinding {
  /** Unpredictable, host-generated. Never derived from a counter or a clock. */
  std::uint64_t epoch = 0;
  /** Unpredictable seed the host mixes into every per-request cookie. */
  std::uint64_t cookie_seed = 0;
  /** Console (Aqua) uid the helper must actually be running as. */
  std::uint32_t uid = 0;
  /** Route generation this helper is permitted to serve. */
  std::uint64_t generation = 0;
  /** Signed release identity of the selected artifact set. */
  std::string release_identity;

  [[nodiscard]] bool IsValid() const noexcept;
};

/**
 * Parses exactly one binding line: `v1 epoch=<hex> cookie=<hex> uid=<dec>
 * generation=<dec> release=<token>`.
 *
 * Rejects anything oversized, malformed, duplicated, zero-valued or carrying an
 * unknown key. A partially understood binding is refused rather than
 * best-effort accepted, because a binding that is half-applied is a helper that
 * believes it is authenticated while the host believes something else.
 */
[[nodiscard]] bool ParseVirtualDisplayHelperBinding(
    const std::string& line,
    VirtualDisplayHelperBinding* binding);

[[nodiscard]] std::string SerializeVirtualDisplayHelperBinding(
    const VirtualDisplayHelperBinding& binding);

/** Why a command was refused. Distinct values so a refusal is never ambiguous. */
enum class HelperAdmission {
  kAdmitted,
  kNotBound,          // no launch binding was ever consumed
  kEpochMismatch,     // replay from a different (or superseded) host epoch
  kGenerationMismatch,// stale worker that has not noticed it was replaced
  kCookieReplay,      // this exact cookie was already spent
  kCookieUnbound,     // cookie is not derivable from the bound seed
  kUidMismatch,       // running as a uid the host did not bind
};

/**
 * Per-request cookie derived from the bound seed and a monotonic request index.
 *
 * Derived rather than free-form so the helper can verify a cookie belongs to
 * THIS binding without keeping an unbounded set of issued values, and so a peer
 * that never saw the seed cannot mint one.
 */
[[nodiscard]] std::uint64_t DeriveHelperCookie(std::uint64_t cookie_seed,
                                               std::uint64_t request_index) noexcept;

struct HelperAdmissionRequest {
  std::uint64_t epoch = 0;
  std::uint64_t generation = 0;
  std::uint64_t cookie = 0;
  std::uint64_t request_index = 0;
  std::uint32_t running_uid = 0;
};

/**
 * Decides whether a command may act.
 *
 * `highest_spent_index` is the replay floor: cookies must strictly advance, so
 * a captured frame cannot be replayed later. Every unmet condition is a
 * distinct refusal, and there is no "close enough".
 */
[[nodiscard]] HelperAdmission EvaluateHelperAdmission(
    const VirtualDisplayHelperBinding& binding,
    bool bound,
    std::uint64_t highest_spent_index,
    const HelperAdmissionRequest& request) noexcept;

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_BINDING_H_
