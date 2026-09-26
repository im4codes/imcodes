#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_WORKER_CONTROL_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_WORKER_CONTROL_H_

#include <cstdint>
#include <string>
#include <string_view>

namespace imcodes::remote_desktop::macos {

// Local control seam that lets a short-lived cleanup process reach the
// long-lived worker that actually owns the session.
//
// This exists because the daemon invokes --imcodes-release-input-v1 and
// --imcodes-stop-capture-v1 as a *fresh* sibling process, with an empty
// environment (macosRemoteDesktopNativeCommandInvocation passes env: {}). Such
// a process owns nothing, so answering from its own state would always report
// failure — or, worse, report success while releasing nothing. The command must
// reach the live generation and get a proof back.
//
// The path is derived from the compile-time runtime root and the caller's own
// uid, because the environment carries nothing.

// Mirrors MACOS_REMOTE_DESKTOP_RUNTIME_ROOT in src/node/macos-user-session.ts.
inline constexpr char kControlRuntimeRoot[] =
    "/private/var/run/imcodes-node/user-sessions";
inline constexpr char kControlRuntimeLeaf[] = "remote-desktop";
inline constexpr char kControlSocketName[] = "remote-desktop-control.sock";

// Directory 0700 and socket 0600, matching the host's own protection of the
// IPC socket. A wider mode would let another local user drive cleanup.
inline constexpr int kControlDirectoryMode = 0700;
inline constexpr int kControlSocketMode = 0600;

inline constexpr char kControlProtocolTag[] = "IMCODES_CONTROL_V1";
inline constexpr char kControlVerbReleaseInput[] = "RELEASE_INPUT";
inline constexpr char kControlVerbStopCapture[] = "STOP_CAPTURE";
inline constexpr char kControlStatusOk[] = "OK";
inline constexpr char kControlStatusError[] = "ERR";

// Reasons are a closed set so a caller can branch on them without parsing
// free text.
inline constexpr char kControlErrorGenerationMismatch[] = "generation_mismatch";
inline constexpr char kControlErrorNoActiveSession[] = "no_active_session";
inline constexpr char kControlErrorUnsupported[] = "unsupported";

inline constexpr std::size_t kControlMaxLineBytes = 256;

enum class ControlVerb : std::uint8_t {
  kReleaseInput,
  kStopCapture,
};

// `/private/var/run/imcodes-node/user-sessions/<uid>/remote-desktop/<name>`.
// Returns false when the result would exceed the sockaddr_un limit rather than
// producing a truncated path that would silently bind somewhere else.
[[nodiscard]] bool BuildControlSocketPath(std::uint32_t uid, std::string* out);

// `IMCODES_CONTROL_V1 <VERB> <generation>`; generation 0 means "whatever the
// worker currently owns".
[[nodiscard]] bool SerializeControlRequest(ControlVerb verb,
                                           std::uint64_t generation,
                                           std::string* out);
[[nodiscard]] bool ParseControlRequest(std::string_view line, ControlVerb* verb,
                                       std::uint64_t* generation);

// `IMCODES_CONTROL_V1 OK <generation>` proves which generation acted, so an
// exit status can never mean "something, somewhere, was cleaned up".
[[nodiscard]] bool SerializeControlOk(std::uint64_t generation,
                                      std::string* out);
[[nodiscard]] bool SerializeControlError(std::string_view reason,
                                         std::string* out);

struct ControlResponse {
  bool ok = false;
  std::uint64_t generation = 0;
  std::string error;
};

[[nodiscard]] bool ParseControlResponse(std::string_view line,
                                        ControlResponse* out);

// Decides whether a request may act, without performing the action. Kept
// separate from the socket so the rule is testable on its own.
//
// `active_generation` of 0 means the worker owns no session.
[[nodiscard]] bool ControlRequestMayAct(std::uint64_t requested_generation,
                                        std::uint64_t active_generation,
                                        std::string* error_reason);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_WORKER_CONTROL_H_
