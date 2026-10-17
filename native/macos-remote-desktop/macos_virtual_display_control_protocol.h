// Control-socket protocol for the resident virtual-display agent.
//
// WHO TALKS TO WHOM
//
//   Node (has already verified the artifact set)
//        --  grant1 ... -->  resident LaunchAgent   "here is the authority"
//   route worker
//        --  ctl1 verb=route -->                    "give me a capability"
//        --  ctl1 verb=relay -->                    "do this to the display"
//   readiness probe
//        --  ctl1 verb=ready -->                    "is control available"
//
// TWO TOP-LEVEL FRAMES, DISPATCHED ON PREFIX
//
// A grant arrives as ITSELF -- the same `grant1 ...` line the producer
// serialised -- not wrapped inside a control frame. Wrapping would have meant
// percent-encoding a whitespace-delimited line inside another whitespace-
// delimited line, which needs a second copy of a codec that today exists in
// exactly one place. Two self-describing prefixes on one socket cost nothing
// and keep the authority line byte-identical from producer to consumer, so the
// canonical-closure guarantee still means something at the far end.
//
// TWO AUTHENTICATION LAYERS THAT MUST NOT LEAK INTO EACH OTHER
//
// The helper has its own launch binding: an unpredictable epoch and cookie seed
// that ONLY the supervisor knows. A route worker knows neither and must never
// learn either -- a peer that can stamp a helper frame can drive the display
// forever, under no generation anyone can revoke.
//
// So `relay` does NOT carry a helper frame. It carries the SEMANTIC request
// (verb plus mode parameters) authenticated by the ROUTE grant's own epoch and
// derived cookie. The agent validates that, then builds a FRESH helper command
// stamped with the helper epoch and cookie it holds privately. The two
// credentials never appear in the same message.
//
// An opaque pass-through was the obvious shape and it is wrong: it would let a
// worker send `release` for a generation it does not own, or re-stamp a frame
// with any epoch it liked, because the agent would have no way to tell a
// forwarded frame from an authored one.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_CONTROL_PROTOCOL_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_CONTROL_PROTOCOL_H_

#include <cstdint>
#include <string>
#include <string_view>

#include "macos_virtual_display_helper_protocol.h"

namespace imcodes::remote_desktop::macos {

/** Bounded so a hostile peer cannot force unbounded buffering. */
inline constexpr std::size_t kVirtualDisplayControlMaxBytes = 512;

/** Prefix of a control frame. A grant frame keeps its own `grant1 ` prefix. */
inline constexpr std::string_view kVirtualDisplayControlRequestPrefix = "ctl1 ";
inline constexpr std::string_view kVirtualDisplayControlReplyPrefix = "ctl1r ";

enum class VirtualDisplayControlVerb {
  kInvalid,
  /** Zero-mutation readiness question. Never creates, never holds. */
  kReady,
  /** A route asks for its capability. Never returns the helper descriptor. */
  kRoute,
  /** A route asks for a display action, authenticated by its route grant. */
  kRelay,
};

struct VirtualDisplayControlRequest {
  VirtualDisplayControlVerb verb = VirtualDisplayControlVerb::kInvalid;

  /** kReady: echoed in the answer so a reply cannot be replayed as fresh. */
  std::uint64_t nonce = 0;

  /** kRoute and kRelay: which route is asking. */
  std::uint64_t route_generation = 0;

  /**
   * kRelay: the ROUTE grant's credentials, never the helper's.
   *
   * `route_cookie` must be derivable from the cookie seed this agent issued to
   * this route, and `request_index` must strictly advance, so a captured relay
   * frame cannot be replayed later.
   */
  std::uint64_t route_epoch = 0;
  std::uint64_t route_cookie = 0;
  std::uint64_t request_index = 0;

  /** kRelay: the semantic request. Never a pre-stamped helper frame. */
  VirtualDisplayHelperVerb helper_verb = VirtualDisplayHelperVerb::kInvalid;
  std::uint32_t display_id = 0;
  std::uint32_t pixels_wide = 0;
  std::uint32_t pixels_high = 0;
  std::uint32_t refresh_millihertz = 0;
  std::uint32_t scale_percent = 0;

  [[nodiscard]] bool IsValid() const noexcept;
};

struct VirtualDisplayControlReply {
  bool ok = false;
  /** Closed-set reason. Empty only when ok. */
  std::string error;

  /** kReady. */
  std::uint64_t nonce = 0;
  bool qualified_to_create = false;
  bool display_control_admitted = false;

  /**
   * kRoute. The capability, and deliberately nothing else: no descriptor, no
   * path, no helper epoch, no helper cookie seed.
   */
  std::uint64_t route_generation = 0;
  std::uint64_t route_epoch = 0;
  std::uint64_t cookie_seed = 0;
  std::uint32_t uid = 0;

  /** kRelay: the helper's answer, re-stated. The helper frame never crosses. */
  std::uint32_t display_id = 0;
  bool admitted = false;
  /** "absent" | "inactive" | "active" */
  std::string presence;

  [[nodiscard]] bool IsValid() const noexcept;
};

/**
 * Classifies one inbound line WITHOUT interpreting it.
 *
 * The server needs to know which of the two top-level frames it is holding
 * before it can decide who is allowed to send it, and that decision must not
 * require parsing the body first.
 */
enum class VirtualDisplayControlFrame {
  kUnknown,
  kGrant,    // `grant1 ...` -- hand to the agent verbatim
  kControl,  // `ctl1 ...`   -- parse as a control request
};

[[nodiscard]] VirtualDisplayControlFrame ClassifyVirtualDisplayControlFrame(
    std::string_view line) noexcept;

[[nodiscard]] bool ParseVirtualDisplayControlRequest(
    const std::string& line,
    VirtualDisplayControlRequest* request,
    std::string* error = nullptr);

[[nodiscard]] std::string SerializeVirtualDisplayControlRequest(
    const VirtualDisplayControlRequest& request);

[[nodiscard]] bool ParseVirtualDisplayControlReply(
    const std::string& line,
    VirtualDisplayControlReply* reply,
    std::string* error = nullptr);

[[nodiscard]] std::string SerializeVirtualDisplayControlReply(
    const VirtualDisplayControlReply& reply);

/** Spelling of every verb on the wire. One place, both directions. */
[[nodiscard]] const char* VirtualDisplayControlVerbText(
    VirtualDisplayControlVerb verb) noexcept;
[[nodiscard]] VirtualDisplayControlVerb ParseVirtualDisplayControlVerb(
    std::string_view text) noexcept;

/** Spelling of a helper verb on the control wire. One place, both directions. */
[[nodiscard]] const char* VirtualDisplayHelperVerbText(
    VirtualDisplayHelperVerb verb) noexcept;
[[nodiscard]] VirtualDisplayHelperVerb ParseVirtualDisplayHelperVerbText(
    std::string_view text) noexcept;

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_CONTROL_PROTOCOL_H_
