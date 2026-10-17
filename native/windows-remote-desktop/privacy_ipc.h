#ifndef IMCODES_REMOTE_DESKTOP_PRIVACY_IPC_H_
#define IMCODES_REMOTE_DESKTOP_PRIVACY_IPC_H_

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "third_party/imcodes_remote_desktop/json_protocol.h"

namespace imcodes::rd {

/**
 * Management-privacy frames.
 *
 * The owner is about to type a password into a shell on this machine while
 * remote viewers are watching it. Between SHIELD and a proven RELEASE, no real
 * desktop pixel may reach any route.
 *
 * Like consent, these do NOT ride the session `Signal` union: that union
 * authenticates every frame against a tracked session, and the privacy barrier
 * is host-wide rather than per-session. They share the authenticated pipe and
 * nothing else -- there is deliberately no second credential or nonce.
 *
 * The literals are duplicated from src/node/remote-desktop-privacy-ipc.ts
 * because C++ cannot import it;
 * test/spec/windows-remote-desktop-build-manifests.test.ts asserts the two
 * agree so they cannot drift.
 */
namespace privacy_ipc {

inline constexpr char kShield[] = "worker.privacy.shield";
inline constexpr char kShielded[] = "worker.privacy.shielded";
inline constexpr char kRelease[] = "worker.privacy.release";
inline constexpr char kReleased[] = "worker.privacy.released";

/**
 * How long RELEASE may wait for a real frame captured strictly after cleanup.
 * Bounded because the alternative to waiting forever is not "restore anyway"
 * -- it is "stay shielded", which is the safe outcome.
 */
inline constexpr uint32_t kFreshFrameTimeoutMs = 4'000;

}  // namespace privacy_ipc

enum class PrivacyFrameKind { kShield, kRelease };

struct PrivacyRouteGeneration {
  std::string route_id;
  int64_t route_generation = 0;
};

struct PrivacyFrame {
  PrivacyFrameKind kind;
  std::string epoch_id;
  int64_t revision = 0;
  /** Only meaningful for kShield; the worker never interprets it further. */
  std::string presentation_source;
  /** Durable complete route snapshot supplied by the owning Server. */
  std::vector<PrivacyRouteGeneration> expected_routes;
};

/** nullopt for anything not a well-formed privacy frame. */
std::optional<PrivacyFrame> ParsePrivacyFrame(const Json::Value& root);

/**
 * `input_released` must be the real result of releasing held input, never a
 * constant: a viewer whose key is still down would keep typing into a secret
 * surface it can no longer see.
 */
Json::Value PrivacyShieldedEnvelope(
    const std::string& epoch_id,
    int64_t revision,
    int64_t worker_generation,
    bool input_released,
    const std::vector<PrivacyRouteGeneration>& routes);

Json::Value PrivacyReleasedEnvelope(const std::string& epoch_id,
                                    bool secret_cleanup_complete,
                                    int64_t fresh_frame_worker_generation);

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_PRIVACY_IPC_H_
