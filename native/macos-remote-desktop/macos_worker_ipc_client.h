#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_WORKER_IPC_CLIENT_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_WORKER_IPC_CLIENT_H_

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace imcodes::remote_desktop::macos {

// Mirrors src/node/macos-remote-desktop-ipc.ts MACOS_REMOTE_DESKTOP_IPC_MESSAGE
// and src/node/macos-remote-desktop-launch-agent.ts
// MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT. A cross-layer guard test
// compares every token below against the TypeScript source byte-for-byte.
inline constexpr char kIpcMessageHello[] = "remote_desktop.macos_ipc.hello";
inline constexpr char kIpcMessageHostCommand[] =
    "remote_desktop.macos_ipc.host_command";
inline constexpr char kIpcMessageVirtualDisplayRequest[] =
    "remote_desktop.macos_ipc.virtual_display_request";
inline constexpr char kIpcMessageVirtualDisplayReply[] =
    "remote_desktop.macos_ipc.virtual_display_reply";
inline constexpr char kIpcMessageWorkerMessage[] =
    "remote_desktop.macos_ipc.worker_message";
inline constexpr char kIpcMessageAuthenticated[] =
    "remote_desktop.macos_ipc.authenticated";
inline constexpr char kBootstrapMessageHello[] =
    "remote_desktop.macos_bootstrap.hello";
inline constexpr char kBootstrapMessageGrant[] =
    "remote_desktop.macos_bootstrap.grant";
inline constexpr std::int64_t kBootstrapVersion = 1;

inline constexpr char kEnvRuntimeDirectory[] =
    "IMCODES_REMOTE_DESKTOP_RUNTIME_DIR";
inline constexpr char kEnvSocketPath[] = "IMCODES_REMOTE_DESKTOP_SOCKET";
inline constexpr char kEnvLaunchAgentLabel[] =
    "IMCODES_REMOTE_DESKTOP_LAUNCH_AGENT_LABEL";
inline constexpr char kEnvWorkerGeneration[] =
    "IMCODES_REMOTE_DESKTOP_WORKER_GENERATION";
inline constexpr char kEnvLaunchChallenge[] =
    "IMCODES_REMOTE_DESKTOP_LAUNCH_CHALLENGE";
inline constexpr char kEnvBundleIdentifier[] =
    "IMCODES_REMOTE_DESKTOP_BUNDLE_IDENTIFIER";
inline constexpr char kEnvTeamId[] = "IMCODES_REMOTE_DESKTOP_TEAM_ID";
inline constexpr char kEnvSessionType[] = "IMCODES_REMOTE_DESKTOP_SESSION_TYPE";
inline constexpr char kEnvAuditSessionId[] =
    "IMCODES_REMOTE_DESKTOP_AUDIT_SESSION_ID";
inline constexpr char kEnvBootstrapSocket[] =
    "IMCODES_REMOTE_DESKTOP_BOOTSTRAP_SOCKET";
inline constexpr char kGlobalBootstrapSocketPath[] =
    "/private/var/run/imcodes-node/remote-desktop-bootstrap.sock";
inline constexpr char kGraphicalRuntimeRoot[] =
    "/private/var/run/imcodes-node/graphical-sessions";

// Mirrors REMOTE_DESKTOP_WORKER_IPC_VERSION.
inline constexpr std::int64_t kWorkerIpcVersion = 1;

// Mirrors MACOS_REMOTE_DESKTOP_IPC_MAX_FRAME_BYTES. Any frame at or above this
// is refused before parsing, so an oversized peer cannot force unbounded
// buffering in this process.
inline constexpr std::size_t kIpcMaxFrameBytes = 256 * 1024 + 16 * 1024;

// The host challenge is a 43-character base64url value (CHALLENGE_RE).
inline constexpr std::size_t kLaunchChallengeLength = 43;

struct WorkerLaunchContext {
  std::string socket_path;
  std::string challenge;
  std::uint64_t worker_generation = 0;
  /**
   * Which session launchd loaded this agent into, and the kernel audit session
   * and uid it belongs to.
   *
   * Required, not optional. Defaulting the session type would make a worker
   * launched at the login window indistinguishable from an Aqua one, and the
   * capability profile is derived from exactly this value -- a default would
   * silently hand the login window the full user surface.
   */
  std::string session_type;
  std::uint32_t audit_session_id = 0;
  std::uint32_t uid = 0;
};

struct BootstrapHelloContext {
  std::uint32_t uid = 0;
  std::uint32_t audit_session_id = 0;
  std::string session_type;
  std::string instance_nonce;
};

struct BootstrapGrant {
  std::uint32_t uid = 0;
  std::uint32_t audit_session_id = 0;
  std::string session_type;
  std::string instance_nonce;
  std::uint64_t worker_generation = 0;
  std::string challenge;
  std::string socket_path;
};

struct IpcAuthenticationAcknowledgement {
  std::uint32_t uid = 0;
  std::uint32_t audit_session_id = 0;
  std::uint32_t pid_version = 0;
  std::uint64_t worker_generation = 0;
  std::string session_type;
  std::string launch_challenge;
};

/** Exact one-shot global-agent bootstrap frames. */
[[nodiscard]] bool BuildBootstrapHelloFrame(
    const BootstrapHelloContext& context, std::string* out);
[[nodiscard]] bool ParseBootstrapGrantFrame(
    std::string_view frame, const BootstrapHelloContext& expected,
    BootstrapGrant* out);

/** True only for the uid/asid path minted by the global bootstrap ledger. */
[[nodiscard]] bool IsGraphicalBootstrapLaunchContext(
    const WorkerLaunchContext& context);

/** Exact daemon acknowledgement following native IPC peer verification. */
[[nodiscard]] bool ParseIpcAuthenticationAcknowledgement(
    std::string_view frame,
    const WorkerLaunchContext& expected,
    IpcAuthenticationAcknowledgement* out);

// Reads the fixed environment the LaunchAgent plist installs. Every field is
// required and validated; a missing or malformed value is a hard failure
// rather than a default, because a defaulted generation or challenge would let
// this process attach to a session it was not launched for.
//
// `lookup` returns nullptr for an unset variable.
using EnvironmentLookup = const char* (*)(const char* name);
[[nodiscard]] bool ReadWorkerLaunchContext(EnvironmentLookup lookup,
                                           WorkerLaunchContext* out);

// Serializes the exact hello frame the host parser accepts. Returns false if
// the context is not admissible.
[[nodiscard]] bool BuildHelloFrame(const WorkerLaunchContext& context,
                                   std::string* out);

// Wraps an already-serialized daemon message in the worker envelope. `message`
// must be a complete JSON object; this function does not inspect it beyond
// rejecting control characters and enforcing the frame bound.
[[nodiscard]] bool BuildWorkerMessageFrame(std::uint64_t worker_generation,
                                           std::string_view message_json,
                                           std::string* out);

// Which envelope a frame is, decided before it is fully parsed.
//
// The socket carries host commands and virtual-display replies interleaved on
// one stream. One reader must therefore be able to route a frame without
// running the wrong parser first: feeding a reply to ParseHostCommandFrame
// yields kMalformed, and this loop treats kMalformed as a hard protocol stop.
enum class HostFrameKind : std::uint8_t {
  kUnknown,
  kHostCommand,
  kVirtualDisplayReply,
};

[[nodiscard]] HostFrameKind ClassifyHostFrame(std::string_view frame) noexcept;

enum class HostFrameOutcome : std::uint8_t {
  kAccepted,
  // Structurally malformed, oversized, wrong version, or wrong type.
  kMalformed,
  // Well-formed but addressed to a different generation.
  kStale,
};

struct HostCommandFrame {
  std::uint64_t worker_generation = 0;
  // Raw JSON text of the `command` member. The session layer validates it; the
  // frame layer only proves the envelope.
  std::string command_json;
  // The `type` member of the command, when present as a plain string.
  std::string command_type;
};

// Parses one HOST_COMMAND envelope. This is a bounded structural parse, not a
// general JSON parser: it accepts exactly the four expected keys and rejects
// anything else, so an unexpected member cannot ride along into the session.
[[nodiscard]] HostFrameOutcome ParseHostCommandFrame(
    std::string_view frame, std::uint64_t expected_generation,
    HostCommandFrame* out);

/**
 * Serializes one virtual-display request envelope.
 *
 * `request_json` is authored by the caller and passed through unmodified: the
 * daemon re-validates it against the exact per-op key set, and re-encoding it
 * here would only create a second place for the two shapes to drift.
 */
[[nodiscard]] bool BuildVirtualDisplayRequestFrame(
    std::uint64_t worker_generation, std::uint64_t request_id,
    std::string_view request_json, std::string* out);

/**
 * The daemon's answer, already reduced to the fields a worker may act on.
 *
 * The helper's own descriptor, epoch and cookie seed are absent by
 * construction -- they are not members here, so no parse path can deliver them
 * into this process. `route_epoch` and `cookie_seed` are the ROUTE capability
 * the agent issues per generation, which is a different credential that the
 * agent can revoke without touching the helper.
 */
struct VirtualDisplayProxyReply {
  bool ok = false;
  std::string error;
  std::uint64_t nonce = 0;
  bool qualified_to_create = false;
  bool display_control_admitted = false;
  std::uint64_t route_generation = 0;
  std::uint64_t route_epoch = 0;
  std::uint64_t cookie_seed = 0;
  std::uint64_t uid = 0;
  std::uint64_t display_id = 0;
  bool admitted = false;
  std::string presence;
};

/**
 * Which canonical answer shape is expected.
 *
 * The op is required, exactly as it is on the daemon's parser. A reply parser
 * that accepts any key set is one that will read a route capability out of a
 * readiness answer, or silently ignore a field it did not understand.
 */
enum class VirtualDisplayReplyShape : std::uint8_t {
  kReadiness,
  kRoute,
  kRelay,
};

struct VirtualDisplayReplyFrame {
  std::uint64_t worker_generation = 0;
  std::uint64_t request_id = 0;
  VirtualDisplayProxyReply reply;
};

/**
 * Parses one virtual-display reply envelope.
 *
 * Returns kStale for a frame addressed to another generation so the caller can
 * refuse it without treating it as corruption. Request-id correlation is the
 * caller's, because only the caller knows which request is outstanding.
 */
[[nodiscard]] HostFrameOutcome ParseVirtualDisplayReplyFrame(
    std::string_view frame, std::uint64_t expected_generation,
    VirtualDisplayReplyShape shape, VirtualDisplayReplyFrame* out);

// Newline-delimited frame accumulator with a hard bound. Feed returns false
// once the buffer would exceed the frame limit; the caller must then terminate
// rather than resynchronize, because a resynchronizing reader can be steered
// past a frame boundary.
class FrameReader {
 public:
  explicit FrameReader(std::size_t max_frame_bytes = kIpcMaxFrameBytes)
      : max_frame_bytes_(max_frame_bytes) {}

  [[nodiscard]] bool Feed(std::string_view chunk,
                          std::vector<std::string>* frames);
  [[nodiscard]] bool overflowed() const noexcept { return overflowed_; }
  [[nodiscard]] std::size_t buffered() const noexcept { return buffer_.size(); }

 private:
  std::string buffer_;
  std::size_t max_frame_bytes_;
  bool overflowed_ = false;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_WORKER_IPC_CLIENT_H_
