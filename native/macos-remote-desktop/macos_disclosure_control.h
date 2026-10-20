#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_DISCLOSURE_CONTROL_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_DISCLOSURE_CONTROL_H_

#include <cstdint>
#include <string>
#include <string_view>

namespace imcodes::remote_desktop::macos {

// Bounded local control seam between the separate signed disclosure process
// and the worker that owns the session.
//
// It is deliberately a one-way, newline-delimited, fixed-token stream on the
// disclosure process's stdout. The disclosure component holds no route
// authority and receives no credential, so the seam only has to carry "the
// window is up", "the user pressed Stop", "the window went away" and "the
// window failed". Anything richer would give a UI process influence over
// session state it has no business holding.
inline constexpr char kDisclosureEventReady[] = "IMCODES_DISCLOSURE_READY";
inline constexpr char kDisclosureEventStop[] = "IMCODES_DISCLOSURE_STOP";
inline constexpr char kDisclosureEventClosed[] = "IMCODES_DISCLOSURE_CLOSED";
inline constexpr char kDisclosureEventFailed[] = "IMCODES_DISCLOSURE_FAILED";

inline constexpr std::size_t kDisclosureEventMaxLineBytes = 128;

enum class DisclosureEvent : std::uint8_t {
  kReady,
  kStop,
  kClosed,
  kFailed,
};

// `<TOKEN> <generation>` with a single space and no trailing whitespace.
[[nodiscard]] bool SerializeDisclosureEvent(DisclosureEvent event,
                                            std::uint64_t generation,
                                            std::string* out);

// Fails closed on any deviation: unknown token, missing or malformed
// generation, extra fields, control characters, or an over-long line.
[[nodiscard]] bool ParseDisclosureEvent(std::string_view line,
                                        DisclosureEvent* event,
                                        std::uint64_t* generation);

// Worker-side admission state for the separate disclosure component.
//
// The rule this class exists to enforce: a route may be admitted only while a
// disclosure process has confirmed a visible window for the current
// generation. Ready is not sticky — Stop, Closed and Failed all revoke it, and
// a Ready for a different generation never grants it.
class DisclosureAdmission {
 public:
  explicit DisclosureAdmission(std::uint64_t generation) noexcept
      : generation_(generation) {}

  // Returns false when the event does not apply to the tracked generation, so
  // a late event from a replaced disclosure cannot revoke a live session.
  bool Apply(DisclosureEvent event, std::uint64_t generation) noexcept;

  [[nodiscard]] bool route_admissible() const noexcept { return ready_; }
  [[nodiscard]] bool stop_requested() const noexcept { return stop_requested_; }
  [[nodiscard]] bool terminated() const noexcept { return terminated_; }
  [[nodiscard]] std::uint64_t generation() const noexcept {
    return generation_;
  }

 private:
  std::uint64_t generation_;
  bool ready_ = false;
  bool stop_requested_ = false;
  bool terminated_ = false;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_DISCLOSURE_CONTROL_H_
