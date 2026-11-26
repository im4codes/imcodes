#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTHENTICATED_SESSION_READINESS_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTHENTICATED_SESSION_READINESS_H_

#include <cstdint>
#include <string>

#include "macos_login_window_capture.h"
#include "../remote-desktop-common/value_types.h"

namespace imcodes::remote_desktop::macos {

inline constexpr char kGraphicalReadinessMessageType[] =
    "remote_desktop.macos_ipc.graphical_readiness";

/** Evidence returned by the daemon only after it authenticates the IPC peer. */
struct AuthenticatedGraphicalPeer {
  std::uint32_t uid = 0;
  std::uint32_t audit_session_id = 0;
  std::uint32_t pid_version = 0;
  std::uint64_t worker_generation = 0;
  std::string session_type;
  std::string launch_challenge;
};

/**
 * Builds the only post-composition readiness attestation.
 *
 * `binding` is the kernel-rechecked worker binding, `peer` is the daemon's IPC
 * authentication acknowledgement, and `observed` comes from the composed
 * session's real adapters. All three must describe the same instance.
 */
[[nodiscard]] bool BuildAuthenticatedGraphicalReadinessFrame(
    const CaptureSessionBinding& binding,
    const AuthenticatedGraphicalPeer& peer,
    const common::CapabilityReadiness& observed,
    bool cleanup_reachable,
    std::string* out);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTHENTICATED_SESSION_READINESS_H_
