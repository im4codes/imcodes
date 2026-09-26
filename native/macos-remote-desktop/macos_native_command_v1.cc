#include "macos_native_command_v1.h"

#include <algorithm>
#include <cstring>
#include <set>
#include <string_view>

namespace imcodes::remote_desktop::macos {
namespace {

constexpr char kGenerationArgument[] = "--generation";
constexpr std::size_t kMaxGenerationDigits = 19;

bool IsKnownSessionState(std::string_view state) noexcept {
  return state == kNativeSessionStateActiveUnlocked ||
         state == kNativeSessionStateLocked ||
         state == kNativeSessionStateSleeping ||
         state == kNativeSessionStateInactive;
}

void AppendBool(std::string* out, const char* key, bool value) {
  out->append(",\"").append(key).append("\":").append(value ? "true" : "false");
}

// Parses a plain bounded decimal. Anything else — sign, whitespace, leading
// zero, overflow — is rejected rather than coerced, because a coerced
// generation would let a cleanup command act on the wrong session.
bool ParseGeneration(const char* text, std::uint64_t* out) noexcept {
  if (text == nullptr || out == nullptr)
    return false;
  const std::size_t length = std::strlen(text);
  if (length == 0 || length > kMaxGenerationDigits)
    return false;
  if (length > 1 && text[0] == '0')
    return false;
  std::uint64_t value = 0;
  for (std::size_t index = 0; index < length; ++index) {
    const char digit = text[index];
    if (digit < '0' || digit > '9')
      return false;
    value = value * 10 + static_cast<std::uint64_t>(digit - '0');
  }
  *out = value;
  return true;
}

}  // namespace

bool SerializeNativeReadinessV1(const NativeReadinessV1& snapshot,
                                std::string* out) {
  if (out == nullptr)
    return false;
  if (!IsKnownSessionState(snapshot.session_state))
    return false;
  if (snapshot.active_aqua_user_uids.size() > kNativeReadinessMaxActiveUids) {
    return false;
  }
  // The daemon rejects zero/duplicate uids outright. Catching it here keeps a
  // malformed probe from producing output that only fails much later.
  std::set<std::uint32_t> seen;
  for (const std::uint32_t uid : snapshot.active_aqua_user_uids) {
    if (uid == 0)
      return false;
    if (!seen.insert(uid).second)
      return false;
  }

  std::string encoded;
  encoded.reserve(512);
  encoded.append("{\"version\":")
      .append(std::to_string(kNativeReadinessVersionV1));
  encoded.append(",\"activeAquaUserUids\":[");
  bool first = true;
  for (const std::uint32_t uid : snapshot.active_aqua_user_uids) {
    if (!first)
      encoded.append(",");
    encoded.append(std::to_string(uid));
    first = false;
  }
  encoded.append("]");
  // session_state is validated above against the closed set, so it needs no
  // escaping; no other string is emitted by this contract.
  encoded.append(",\"sessionState\":\"")
      .append(snapshot.session_state)
      .append("\"");
  AppendBool(&encoded, "screenRecording", snapshot.screen_recording);
  AppendBool(&encoded, "encoder", snapshot.encoder);
  AppendBool(&encoded, "accessibility", snapshot.accessibility);
  AppendBool(&encoded, "clipboard", snapshot.clipboard);
  AppendBool(&encoded, "disclosure", snapshot.disclosure);
  AppendBool(&encoded, "lifecycleObservation", snapshot.lifecycle_observation);
  AppendBool(&encoded, "releaseInput", snapshot.release_input);
  AppendBool(&encoded, "stopCapture", snapshot.stop_capture);
  AppendBool(&encoded, "virtualDisplay", snapshot.virtual_display);
  encoded.append("}");
  *out = std::move(encoded);
  return true;
}

bool NativeCleanupCapabilityV1(const NativeCleanupTarget* cleanup) noexcept {
  // Mirrors the dispatch guard below exactly. Keep the two in step: if this
  // ever says true where dispatch says `cleanup_unavailable`, the daemon would
  // admit a route whose input could never be released.
  return cleanup != nullptr;
}

NativeCommandResult RunNativeCommandV1(int argc,
                                       const char* const argv[],
                                       NativeReadinessProbe* probe,
                                       NativeCleanupTarget* cleanup,
                                       NativePermissionOnboarding* onboarding) {
  NativeCommandResult result;
  if (argv == nullptr || argc < 2)
    return result;

  std::string_view command;
  std::uint64_t generation = 0;
  bool generation_seen = false;
  bool generation_bad = false;
  for (int index = 1; index < argc; ++index) {
    if (argv[index] == nullptr)
      continue;
    const std::string_view token(argv[index]);
    if (token == kNativeCommandReadinessV1 ||
        token == kNativeCommandRequestPermissionsV1 ||
        token == kNativeCommandReleaseInputV1 ||
        token == kNativeCommandStopCaptureV1) {
      // A second command token is a usage error: silently honouring the first
      // would let a caller believe it ran something it did not.
      if (!command.empty())
        generation_bad = true;
      command = token;
      continue;
    }
    if (token == kGenerationArgument) {
      if (index + 1 >= argc || generation_seen ||
          !ParseGeneration(argv[index + 1], &generation)) {
        generation_bad = true;
      }
      generation_seen = true;
      ++index;
      continue;
    }
    if (!command.empty())
      generation_bad = true;
  }

  if (command.empty())
    return result;

  if (generation_bad) {
    result.outcome = NativeCommandOutcome::kUsage;
    result.stderr_text = "macos_remote_desktop_native_command_usage\n";
    return result;
  }

  if (command == kNativeCommandReadinessV1) {
    if (generation_seen) {
      // Readiness is a whole-machine observation; scoping it to a generation
      // would imply a per-session answer this contract does not have.
      result.outcome = NativeCommandOutcome::kUsage;
      result.stderr_text = "macos_remote_desktop_native_command_usage\n";
      return result;
    }
    NativeReadinessV1 snapshot;
    if (probe == nullptr || !probe->Collect(&snapshot)) {
      result.outcome = NativeCommandOutcome::kFailed;
      result.stderr_text = "macos_remote_desktop_readiness_probe_failed\n";
      return result;
    }
    // Overwritten, not merged: the probe observes the machine, but only this
    // function holds the cleanup target, so only this function can answer
    // whether cleanup is serviceable. A probe that tried to guess is ignored.
    const bool cleanup_capable = NativeCleanupCapabilityV1(cleanup);
    snapshot.release_input = cleanup_capable;
    snapshot.stop_capture = cleanup_capable;
    std::string encoded;
    if (!SerializeNativeReadinessV1(snapshot, &encoded)) {
      result.outcome = NativeCommandOutcome::kFailed;
      result.stderr_text = "macos_remote_desktop_readiness_unrepresentable\n";
      return result;
    }
    result.outcome = NativeCommandOutcome::kOk;
    result.stdout_text = std::move(encoded);
    result.stdout_text.append("\n");
    return result;
  }

  if (command == kNativeCommandRequestPermissionsV1) {
    if (generation_seen) {
      result.outcome = NativeCommandOutcome::kUsage;
      result.stderr_text = "macos_remote_desktop_native_command_usage\n";
      return result;
    }
    if (onboarding == nullptr || !onboarding->RequestRegistration()) {
      result.outcome = NativeCommandOutcome::kFailed;
      result.stderr_text =
          "macos_remote_desktop_permission_registration_failed\n";
      return result;
    }
    result.outcome = NativeCommandOutcome::kOk;
    result.stdout_text =
        "macos_remote_desktop_permission_registration_requested\n";
    return result;
  }

  if (cleanup == nullptr) {
    result.outcome = NativeCommandOutcome::kFailed;
    result.stderr_text = "macos_remote_desktop_cleanup_unavailable\n";
    return result;
  }

  const bool acted = command == kNativeCommandReleaseInputV1
                         ? cleanup->ReleaseAllInput(generation)
                         : cleanup->StopCapture(generation);
  if (!acted) {
    // Idempotent in effect, not in status: repeating the command is safe, but
    // a run that could not act on the active generation must not look like a
    // successful cleanup.
    result.outcome = NativeCommandOutcome::kFailed;
    result.stderr_text = command == kNativeCommandReleaseInputV1
                             ? "macos_remote_desktop_release_input_no_active_"
                               "generation\n"
                             : "macos_remote_desktop_stop_capture_no_active_"
                               "generation\n";
    return result;
  }
  result.outcome = NativeCommandOutcome::kOk;
  result.stdout_text = command == kNativeCommandReleaseInputV1
                           ? "macos_remote_desktop_release_input_ok\n"
                           : "macos_remote_desktop_stop_capture_ok\n";
  return result;
}

}  // namespace imcodes::remote_desktop::macos
