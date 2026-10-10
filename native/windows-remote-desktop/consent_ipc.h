#ifndef IMCODES_REMOTE_DESKTOP_CONSENT_IPC_H_
#define IMCODES_REMOTE_DESKTOP_CONSENT_IPC_H_

#include <cstdint>
#include <optional>
#include <string>

#include "third_party/imcodes_remote_desktop/consent_prompt.h"
#include "third_party/imcodes_remote_desktop/json_protocol.h"

namespace imcodes::rd {

/**
 * Consent frames share the worker pipe with session signalling but are a
 * separate, narrow protocol.
 *
 * The session `Signal` union authenticates every frame against a tracked
 * session (requestId/sessionId/capability). A consent request has none of
 * those by definition -- it exists precisely because no session has been
 * authorized yet -- so carrying it there would mean either forging a session
 * or weakening the check that protects real ones.
 *
 * These literals are duplicated from shared/remote-desktop-access.ts because
 * C++ cannot import it. test/spec/windows-remote-desktop-build-manifests.test.ts
 * asserts the TS contract, the Node adapter and this header all agree, so the
 * three cannot drift apart silently.
 */
namespace consent_ipc {

inline constexpr char kAsk[] = "worker.consent.ask";
inline constexpr char kAnswer[] = "worker.consent.answer";
inline constexpr char kDismiss[] = "worker.consent.dismiss";
inline constexpr char kSurfaceQuery[] = "worker.consent.surface_query";
inline constexpr char kSurfaceState[] = "worker.consent.surface_state";

inline constexpr char kOutcomeAllowed[] = "allowed";
inline constexpr char kOutcomeDenied[] = "denied";
inline constexpr char kOutcomeTimedOut[] = "timed_out";
inline constexpr char kOutcomeCancelled[] = "cancelled";
inline constexpr char kOutcomeUnavailable[] = "unavailable";

/** Upper bound on how long a prompt may stay on screen, whatever is asked. */
inline constexpr uint32_t kMaxDeadlineMs = 60'000;

}  // namespace consent_ipc

struct ConsentAsk {
  std::string approval_id;
  std::string requester_label;
  bool control_mode = false;
  uint32_t deadline_ms = 0;
};

enum class ConsentFrameKind { kAsk, kDismiss, kSurfaceQuery };

struct ConsentFrame {
  ConsentFrameKind kind;
  ConsentAsk ask;
  std::string approval_id;
};

/**
 * Returns nullopt for anything that is not a well-formed consent frame,
 * including a frame whose deadline is absent, zero or beyond the cap. A
 * partially-trusted parse is not acceptable on the pipe that carries the
 * answer to a security question.
 */
std::optional<ConsentFrame> ParseConsentFrame(const Json::Value& root);

/** `outcome` must be one of the consent_ipc::kOutcome* literals. */
Json::Value ConsentAnswerEnvelope(const std::string& approval_id,
                                  const char* outcome);

Json::Value ConsentSurfaceStateEnvelope(bool ui_available,
                                        bool interactive_session,
                                        bool protected_desktop_active);

/** Maps a prompt outcome onto the wire literal. Never invents a decision. */
const char* ConsentOutcomeLiteral(ConsentPrompt::Outcome outcome);

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_CONSENT_IPC_H_
