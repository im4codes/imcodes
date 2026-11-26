// The ONLY production MacosVirtualDisplayBackend.
//
// It owns no CGVirtualDisplay. Every operation is a bounded, authenticated
// round trip to the resident signed helper, because the helper process IS the
// display's lifetime and this process is not. A backend that created the
// display here would strand it on any worker crash, and release-to-remove was
// measured not to remove on macOS 26.x.
//
// Three properties this type exists to guarantee:
//   * Destroy() NEVER reports removal from the fact that a call returned. The
//     helper answers with an enumerated presence, and registered-but-inactive
//     is reported as not-removed.
//   * Every frame carries the host epoch and a strictly advancing, derived
//     cookie, so a captured frame cannot be replayed and a stale worker cannot
//     act on a display the current generation owns.
//   * A hung or dead helper is a BOUNDED failure. No unbounded wait, no retry
//     storm; the deadline expires, the call fails, and display control is
//     simply unavailable.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_BACKEND_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_BACKEND_H_

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "macos_virtual_display_adapter.h"
#include "macos_virtual_display_helper_binding.h"
#include "macos_virtual_display_helper_protocol.h"

namespace imcodes::remote_desktop::macos {

/**
 * One bounded request/response exchange with the helper.
 *
 * Injectable so the whole admission, replay and failure surface is provable
 * with no helper process, no socket and no display. Returning false must mean
 * "no answer", never "assume success".
 */
using VirtualDisplayHelperExchange =
    std::function<bool(const std::string& request_line,
                       std::string* reply_line,
                       std::uint32_t timeout_ms)>;

/** Liveness of the supervised helper, as the worker sees it. */
enum class HelperLiveness {
  kAbsent,     // artifact missing or never launched
  kLaunching,  // spawned, binding not yet acknowledged
  kReady,      // bound and answering
  kFailed,     // crashed, hung, or refused its binding
};

struct MacosVirtualDisplayHelperOptions {
  VirtualDisplayHelperBinding binding;
  /** Hard per-call ceiling. A hung helper must not become a hung worker. */
  std::uint32_t request_timeout_ms = 3'000;
  /**
   * Consecutive failures tolerated before the backend latches unavailable.
   *
   * Latching matters: once the helper is gone, every later call would otherwise
   * pay the full timeout, turning one dead helper into a permanently stalled
   * session.
   */
  std::uint32_t max_consecutive_failures = 3;

  [[nodiscard]] bool IsValid() const noexcept;
};

class MacosVirtualDisplayHelperBackend final
    : public MacosVirtualDisplayBackend {
 public:
  MacosVirtualDisplayHelperBackend(MacosVirtualDisplayHelperOptions options,
                                   VirtualDisplayHelperExchange exchange);

  [[nodiscard]] common::ReadinessState ProbeSupport() noexcept override;
  bool Create(const MacosVirtualDisplayConfiguration& configuration,
              std::uint32_t* native_display_id,
              std::string* error) override;
  bool ApplyMode(std::uint32_t native_display_id,
                 const MacosVirtualDisplayMode& mode,
                 const std::vector<MacosVirtualDisplayMode>& modes,
                 std::string* error) override;
  bool WaitUntilOnline(std::uint32_t native_display_id,
                       std::uint32_t timeout_ms,
                       std::string* error) override;
  void Destroy() noexcept override;

  /**
   * EXTERNAL advertisement: may display control be claimed to anyone?
   *
   * True only once a display is actually held AND active. This is what
   * readiness reports; it is deliberately the stricter of the two questions and
   * must never be relaxed.
   */
  [[nodiscard]] bool QueryAdmitted() noexcept;

  /**
   * INTERNAL: is the helper authenticated and qualified to CREATE a display?
   *
   * Separate from QueryAdmitted because conflating them deadlocks. The adapter
   * requires ProbeSupport()==kReady before it will call Create, and
   * QueryAdmitted requires an active display -- which cannot exist until Create
   * has run. A headless host therefore could never create its first display.
   *
   * This asks the weaker, correct question: is there a live, bound, supervised
   * helper whose OS and seam qualify. It says nothing about a display existing,
   * and it is NOT what gets advertised.
   */
  [[nodiscard]] bool QualifiedToCreate() noexcept;

  /**
   * The ONLY entry point a relayed route request may reach.
   *
   * A route names a verb and, for enable, a mode. It never supplies -- and
   * never learns -- the helper epoch, cookie seed or request index: those are
   * stamped here from the launch binding this backend privately holds. A peer
   * that could stamp a helper frame itself would drive the display forever
   * under no generation anyone can revoke.
   *
   * kRelease is refused unconditionally, and that refusal is the architecture
   * rather than a precaution. The helper's lifetime IS the display's lifetime
   * and it belongs to the resident agent; a route that could release it would
   * take the display away from every other route and from the next one. A route
   * that is finished sends `disable`, which leaves the display registered and
   * warm.
   */
  [[nodiscard]] bool RelayFromRoute(const VirtualDisplayHelperCommand& request,
                                    VirtualDisplayHelperReply* reply,
                                    std::string* error);

  [[nodiscard]] HelperLiveness liveness() const noexcept { return liveness_; }
  [[nodiscard]] std::string last_error() const { return last_error_; }
  /** True once teardown was attempted and enumeration still reported it. */
  [[nodiscard]] bool leaked_on_destroy() const noexcept { return leaked_; }

 private:
  /** Stamps authentication onto a caller-built command, then round-trips it. */
  [[nodiscard]] bool Exchange(VirtualDisplayHelperCommand command,
                              VirtualDisplayHelperReply* reply,
                              std::string* error);

  MacosVirtualDisplayHelperOptions options_;
  VirtualDisplayHelperExchange exchange_;
  std::uint64_t request_index_ = 0;
  std::uint32_t consecutive_failures_ = 0;
  std::uint32_t display_id_ = 0;
  HelperLiveness liveness_ = HelperLiveness::kAbsent;
  bool leaked_ = false;
  std::string last_error_;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_BACKEND_H_
