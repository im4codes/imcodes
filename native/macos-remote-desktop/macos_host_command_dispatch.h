#ifndef IMCODES_MACOS_REMOTE_DESKTOP_HOST_COMMAND_DISPATCH_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_HOST_COMMAND_DISPATCH_H_

#include <cstdint>
#include <string>
#include <string_view>

#include "../remote-desktop-common/signaling_types.h"

namespace imcodes::remote_desktop::macos {

// Diagnostics written to stderr. Named so tests assert exact failure classes
// rather than prose.
inline constexpr char kDiagDisclosureNotAdmissible[] =
    "macos_remote_desktop_worker_disclosure_not_admissible";
inline constexpr char kDiagMalformedCommand[] =
    "macos_remote_desktop_worker_malformed_command";
inline constexpr char kDiagCommandRejected[] =
    "macos_remote_desktop_worker_command_rejected";
inline constexpr char kDiagMessageEmissionFailed[] =
    "macos_remote_desktop_worker_message_emission_failed";

/** The production session operations driven by authenticated host commands. */
class HostCommandSessionSeam {
 public:
  virtual ~HostCommandSessionSeam() = default;

  virtual bool Prepare(const rd::Authority& authority,
                       std::int64_t now_unix_ms,
                       std::int64_t now_monotonic_ms) = 0;
  // Negotiation is bounded and synchronous at this seam. The pinned backend
  // may use asynchronous libwebrtc observers internally, but it must not
  // retain a per-dispatch sink after this call returns.
  virtual bool NegotiateOffer(const rd::Authority& authority,
                              std::string_view offer_sdp,
                              std::string* answer_sdp) = 0;
  virtual bool AddRemoteIce(const rd::Authority& authority,
                            std::string_view media_id,
                            std::string_view candidate) = 0;
  virtual bool RenewLease(const rd::Authority& authority,
                          std::int64_t now_unix_ms,
                          std::int64_t now_monotonic_ms) = 0;
  virtual bool SetMode(const rd::Authority& authority,
                       std::string_view reason,
                       std::int64_t now_unix_ms,
                       std::int64_t now_monotonic_ms) = 0;
  virtual bool Stop(const rd::Authority& authority) = 0;
};

/** Route admission owned by the separate signed disclosure component. */
class HostCommandDisclosureSeam {
 public:
  virtual ~HostCommandDisclosureSeam() = default;
  [[nodiscard]] virtual bool route_admissible() const = 0;
};

/** Typed upstream message emission; JSON encoding stays in one protocol layer. */
class HostCommandMessageSink {
 public:
  virtual ~HostCommandMessageSink() = default;
  [[nodiscard]] virtual bool EmitInitialMode(
      const rd::Authority& authority) = 0;
  [[nodiscard]] virtual bool EmitAnswer(const rd::Authority& authority,
                                        std::string_view answer_sdp) = 0;
  [[nodiscard]] virtual bool EmitModeState(const rd::Authority& authority,
                                           std::string_view reason) = 0;
  [[nodiscard]] virtual bool EmitTerminal(const rd::Authority& authority,
                                          std::string_view reason,
                                          std::string_view detail = {}) = 0;
};

enum class HostCommandDisposition { kContinue, kTerminate };

struct HostCommandResult {
  HostCommandDisposition disposition = HostCommandDisposition::kTerminate;
  std::string_view diagnostic;
};

/** Applies one strictly parsed daemon command. */
[[nodiscard]] HostCommandResult DispatchHostCommand(
    const rd::Signal& signal,
    std::int64_t now_unix_ms,
    std::int64_t now_monotonic_ms,
    HostCommandSessionSeam* session,
    HostCommandDisclosureSeam* disclosure,
    HostCommandMessageSink* sink);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_HOST_COMMAND_DISPATCH_H_
