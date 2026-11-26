// The route worker's view of the display: a capability, not a device.
//
// This is what finally replaces `configuration.virtual_display_backend =
// nullptr` in the worker. It implements the same MacosVirtualDisplayBackend
// interface the session already consumes, so nothing downstream changes -- but
// every call becomes an authenticated round trip to the resident agent instead
// of an in-process CGVirtualDisplay owner.
//
// THE ONE MAPPING THAT IS NOT OBVIOUS, AND IS THE WHOLE POINT
//
//   Destroy()  ->  `disable`,  NEVER `release`.
//
// The interface's Destroy means "this session is finished with the display".
// The helper's release means "drop the hold and exit", which destroys the
// display itself. Wiring the first to the second is exactly the defect the
// resident owner exists to fix: the display died with the route, and the next
// route paid a full create -- on an OS where release-to-remove does not
// reliably remove, so each cycle risked stranding one.
//
// So a finished route disables. The display stays registered and warm, the
// resident agent keeps the hold, and the next route enables the same id.
//
// WHAT THIS TYPE DELIBERATELY CANNOT DO
//
//   * It has no helper descriptor, epoch or cookie seed, and no way to obtain
//     any of them. It authenticates with a ROUTE capability the agent issued.
//   * It cannot ask for `release`; the control grammar has no way to express it
//     and the agent would refuse it anyway.
//   * It cannot outlive its capability. When the agent's authority moves -- a
//     new grant, a lost helper, a changed session -- every call starts failing,
//     and failing is the correct outcome rather than silent re-acquisition
//     against a display the peer was never told about.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_ROUTE_BACKEND_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_ROUTE_BACKEND_H_

#include <cstdint>
#include <string>

#include "macos_virtual_display_adapter.h"
#include "macos_virtual_display_control_protocol.h"
#include "macos_virtual_display_helper_backend.h"

namespace imcodes::remote_desktop::macos {

/**
 * One bounded request line out, one bounded reply line back.
 *
 * Deliberately the same shape as the helper channel: it is the same concept at
 * a different layer, and two identical typedefs would be two things to keep in
 * step for no benefit.
 */
using VirtualDisplayControlExchange = VirtualDisplayHelperExchange;

struct MacosVirtualDisplayRouteOptions {
  /** The worker generation this route serves. Never zero. */
  std::uint64_t route_generation = 0;
  /** Bounded wait per round trip. A silent agent is a failed call, not a hang. */
  std::uint32_t request_timeout_ms = 5'000;
  /**
   * How many consecutive unanswered round trips before this backend latches
   * failed. Bounded so one dead agent does not make every later call pay the
   * full timeout.
   */
  std::uint32_t max_consecutive_failures = 3;

  [[nodiscard]] bool IsValid() const noexcept;
};

class MacosVirtualDisplayRouteBackend final : public MacosVirtualDisplayBackend {
 public:
  MacosVirtualDisplayRouteBackend(MacosVirtualDisplayRouteOptions options,
                                  VirtualDisplayControlExchange exchange);

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
  /** DISABLE, never release. See the header comment. */
  void Destroy() noexcept override;

  [[nodiscard]] std::string last_error() const { return last_error_; }
  /** True once the capability was obtained. Not a claim about a display. */
  [[nodiscard]] bool has_capability() const noexcept { return route_epoch_ != 0; }

 private:
  /**
   * Obtains the route capability if it is not held yet.
   *
   * Lazy on purpose: acquiring at construction would mean a worker that never
   * uses a display still takes a slot in the agent's bounded route table.
   */
  [[nodiscard]] bool EnsureCapability(std::string* error);

  /** Authors, authenticates and round-trips one relay frame. */
  [[nodiscard]] bool Relay(VirtualDisplayHelperVerb verb,
                          std::uint32_t display_id,
                          const MacosVirtualDisplayMode* mode,
                          VirtualDisplayControlReply* reply,
                          std::string* error);

  [[nodiscard]] bool Round(const std::string& request_line,
                           VirtualDisplayControlReply* reply,
                           std::string* error);

  MacosVirtualDisplayRouteOptions options_;
  VirtualDisplayControlExchange exchange_;
  std::uint64_t route_epoch_ = 0;
  std::uint64_t cookie_seed_ = 0;
  std::uint64_t request_index_ = 0;
  std::uint32_t display_id_ = 0;
  std::uint32_t consecutive_failures_ = 0;
  bool failed_ = false;
  std::string last_error_;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_ROUTE_BACKEND_H_
