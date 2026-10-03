// The worker's virtual-display backend, spoken entirely through the daemon.
//
// This process never owns a CGVirtualDisplay and never talks to the resident
// agent. It asks the daemon over the socket it was already authenticated on,
// and the daemon authors the control line onto the one long-lived agent lease.
//
// WHAT IS NOT HERE, BY CONSTRUCTION
//
// The helper's descriptor, epoch and cookie seed. `VirtualDisplayProxyReply`
// has no member for them, so no parse path can deliver them into this process.
// What this holds is a ROUTE capability -- a separate epoch and seed the agent
// issues per generation and can revoke without touching the helper.
//
// RELEASE IS NOT EXPRESSIBLE. `Destroy` maps to DISABLE. A worker can stop
// showing a display; it cannot destroy one it does not own, and there is no
// request shape in which it could ask.
//
// Every failure is a refusal. A display question that guessed would advertise
// a surface this machine may not have, and the caller would enable capture on
// it.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_DAEMON_BACKEND_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_DAEMON_BACKEND_H_

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "macos_virtual_display_adapter.h"
#include "macos_worker_ipc_client.h"

namespace imcodes::remote_desktop::macos {

/**
 * One bounded, serial round trip to the daemon.
 *
 * Returns false when no answer can be trusted: no lease, a timeout, a frame
 * that did not correlate, or a channel that has gone terminal. The caller does
 * not get to distinguish "not now" from "never" -- both are refusals.
 */
using VirtualDisplayDaemonExchange = std::function<bool(
    std::string_view request_json, VirtualDisplayReplyShape shape,
    VirtualDisplayProxyReply* reply)>;

/** Monotonic per-request nonce source. Zero is never a valid nonce. */
using VirtualDisplayNonceSource = std::function<std::uint64_t()>;

/** Builders for the exact per-op shapes the daemon accepts. */
[[nodiscard]] std::string BuildVirtualDisplayReadinessRequest(std::uint64_t nonce);
[[nodiscard]] std::string BuildVirtualDisplayRouteRequest();
[[nodiscard]] std::string BuildVirtualDisplayRelayRequest(
    std::string_view op, std::uint64_t route_epoch, std::uint64_t route_cookie,
    std::uint64_t request_index);
[[nodiscard]] std::string BuildVirtualDisplayDisableRequest(
    std::uint64_t route_epoch, std::uint64_t route_cookie,
    std::uint64_t request_index, std::uint64_t display_id);
[[nodiscard]] std::string BuildVirtualDisplayEnableRequest(
    std::uint64_t route_epoch, std::uint64_t route_cookie,
    std::uint64_t request_index, std::uint64_t display_id,
    std::uint32_t pixels_wide, std::uint32_t pixels_high,
    std::uint32_t refresh_millihertz, std::uint32_t scale_percent);

class DaemonProxyVirtualDisplayBackend final : public MacosVirtualDisplayBackend {
 public:
  DaemonProxyVirtualDisplayBackend(VirtualDisplayDaemonExchange exchange,
                                   VirtualDisplayNonceSource nonce,
                                   common::WorkerGeneration worker_generation,
                                   std::uint32_t expected_uid);

  [[nodiscard]] common::ReadinessState ProbeSupport() noexcept override;
  bool Create(const MacosVirtualDisplayConfiguration& configuration,
              std::uint32_t* native_display_id, std::string* error) override;
  bool ApplyMode(std::uint32_t native_display_id,
                 const MacosVirtualDisplayMode& mode,
                 const std::vector<MacosVirtualDisplayMode>& modes,
                 std::string* error) override;
  bool WaitUntilOnline(std::uint32_t native_display_id,
                       std::uint32_t timeout_ms, std::string* error) override;
  void Destroy() noexcept override;

  /** Diagnostics only; never an input to an admission decision. */
  [[nodiscard]] bool route_bound() const noexcept { return route_bound_; }
  [[nodiscard]] bool terminal() const noexcept { return terminal_; }

 private:
  [[nodiscard]] bool EnsureRoute(std::string* error);
  [[nodiscard]] bool Relay(std::string_view op, std::uint64_t display_id,
                           bool addresses_display,
                           VirtualDisplayProxyReply* reply, std::string* error);
  void GoTerminal() noexcept;

  VirtualDisplayDaemonExchange exchange_;
  VirtualDisplayNonceSource nonce_;
  common::WorkerGeneration worker_generation_ = 0;
  std::uint32_t expected_uid_ = 0;
  bool route_bound_ = false;
  bool terminal_ = false;
  std::uint64_t route_epoch_ = 0;
  std::uint64_t cookie_seed_ = 0;
  std::uint64_t request_index_ = 0;
  std::uint32_t held_display_id_ = 0;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_DAEMON_BACKEND_H_
