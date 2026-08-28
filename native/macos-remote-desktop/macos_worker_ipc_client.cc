#include "macos_worker_ipc_client.h"

#include <unistd.h>

#include <cstring>

namespace imcodes::remote_desktop::macos {
namespace {

constexpr std::uint64_t kMaxWorkerGeneration = 9'007'199'254'740'991ULL;

bool IsChallengeCharacter(char value) noexcept {
  return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z') ||
         (value >= '0' && value <= '9') || value == '-' || value == '_';
}

bool ValidChallenge(std::string_view value) noexcept {
  if (value.size() != kLaunchChallengeLength) return false;
  for (const char character : value) {
    if (!IsChallengeCharacter(character)) return false;
  }
  return true;
}

bool ParseUnsigned(std::string_view text, std::uint64_t* out) noexcept {
  if (text.empty() || text.size() > 19) return false;
  if (text.size() > 1 && text[0] == '0') return false;
  std::uint64_t value = 0;
  for (const char digit : text) {
    if (digit < '0' || digit > '9') return false;
    value = value * 10 + static_cast<std::uint64_t>(digit - '0');
  }
  if (value == 0 || value > kMaxWorkerGeneration) return false;
  *out = value;
  return true;
}

bool ContainsControlCharacter(std::string_view value) noexcept {
  for (const char character : value) {
    const auto byte = static_cast<unsigned char>(character);
    if (byte < 0x20 || byte == 0x7f) return true;
  }
  return false;
}





void SkipWhitespace(std::string_view text, std::size_t* cursor) noexcept {
  while (*cursor < text.size()) {
    const char character = text[*cursor];
    if (character != ' ' && character != '\t') break;
    ++*cursor;
  }
}

// Reads a bare JSON string with no escape handling. The envelope fields this
// parser accepts are all constrained alphabets, so a value containing a
// backslash is rejected rather than unescaped.
bool ReadPlainString(std::string_view text, std::size_t* cursor,
                     std::string* out) {
  SkipWhitespace(text, cursor);
  if (*cursor >= text.size() || text[*cursor] != '"') return false;
  ++*cursor;
  const std::size_t start = *cursor;
  while (*cursor < text.size() && text[*cursor] != '"') {
    if (text[*cursor] == '\\') return false;
    ++*cursor;
  }
  if (*cursor >= text.size()) return false;
  out->assign(text.substr(start, *cursor - start));
  ++*cursor;
  return true;
}

// Captures one balanced JSON object, tracking string state so a brace inside a
// string cannot end it early.
bool ReadBalancedObject(std::string_view text, std::size_t* cursor,
                        std::string* out) {
  SkipWhitespace(text, cursor);
  if (*cursor >= text.size() || text[*cursor] != '{') return false;
  const std::size_t start = *cursor;
  std::size_t depth = 0;
  bool in_string = false;
  bool escaped = false;
  while (*cursor < text.size()) {
    const char character = text[*cursor];
    if (in_string) {
      if (escaped) {
        escaped = false;
      } else if (character == '\\') {
        escaped = true;
      } else if (character == '"') {
        in_string = false;
      }
    } else if (character == '"') {
      in_string = true;
    } else if (character == '{') {
      ++depth;
    } else if (character == '}') {
      --depth;
      if (depth == 0) {
        ++*cursor;
        out->assign(text.substr(start, *cursor - start));
        return true;
      }
    }
    ++*cursor;
  }
  return false;
}

bool ExpectLiteral(std::string_view text, std::size_t* cursor,
                   std::string_view literal) noexcept {
  SkipWhitespace(text, cursor);
  if (text.size() - *cursor < literal.size()) return false;
  if (text.compare(*cursor, literal.size(), literal) != 0) return false;
  *cursor += literal.size();
  return true;
}

// Extracts a plain `"type":"value"` member from a command object without
// parsing the whole document. Absence is not an error here; the session layer
// performs the authoritative validation.
void ExtractCommandType(std::string_view object, std::string* out) {
  constexpr std::string_view needle = "\"type\"";
  const std::size_t at = object.find(needle);
  if (at == std::string_view::npos) return;
  std::size_t cursor = at + needle.size();
  SkipWhitespace(object, &cursor);
  if (cursor >= object.size() || object[cursor] != ':') return;
  ++cursor;
  std::string value;
  if (ReadPlainString(object, &cursor, &value)) *out = std::move(value);
}


// Reads `"key":<digits>` at the cursor. Bounded and exact: no sign, no
// exponent, no leading zero run, so a numeric field cannot smuggle a different
// value past the caller's range check.
bool ReadUnsignedMember(std::string_view text, std::size_t* cursor,
                        const char* key, std::uint64_t* out) {
  if (!ExpectLiteral(text, cursor, key)) return false;
  SkipWhitespace(text, cursor);
  const std::size_t start = *cursor;
  while (*cursor < text.size() && text[*cursor] >= '0' && text[*cursor] <= '9') {
    ++(*cursor);
  }
  return ParseUnsigned(text.substr(start, *cursor - start), out);
}

/**
 * Pulls one member out of an already-balanced JSON object.
 *
 * Deliberately not a general parser. It matches `"<name>":` only at a depth of
 * one and only outside strings, so a value that merely CONTAINS the key text
 * cannot be mistaken for the member itself -- an error string carrying
 * `"admitted":true` would otherwise read as an admission.
 */
bool FindMemberValue(std::string_view object, std::string_view name,
                     std::string_view* out) {
  if (object.size() < 2 || object.front() != '{') return false;
  std::size_t cursor = 1;
  int depth = 0;
  bool in_string = false;
  while (cursor < object.size()) {
    const char c = object[cursor];
    if (in_string) {
      if (c == '\\') { cursor += 2; continue; }
      if (c == '"') in_string = false;
      ++cursor;
      continue;
    }
    if (c == '"') {
      const std::size_t key_start = cursor + 1;
      const std::size_t key_end = object.find('"', key_start);
      if (key_end == std::string_view::npos) return false;
      if (depth == 0 && object.substr(key_start, key_end - key_start) == name) {
        std::size_t value = key_end + 1;
        SkipWhitespace(object, &value);
        if (value >= object.size() || object[value] != ':') return false;
        ++value;
        SkipWhitespace(object, &value);
        std::size_t end = value;
        int nested = 0;
        bool value_string = false;
        while (end < object.size()) {
          const char v = object[end];
          if (value_string) {
            if (v == '\\') { end += 2; continue; }
            if (v == '"') value_string = false;
            ++end;
            continue;
          }
          if (v == '"') { value_string = true; ++end; continue; }
          if (v == '{' || v == '[') { ++nested; ++end; continue; }
          if (v == '}' || v == ']') {
            if (nested == 0) break;
            --nested; ++end; continue;
          }
          if (v == ',' && nested == 0) break;
          ++end;
        }
        *out = object.substr(value, end - value);
        return true;
      }
      cursor = key_end + 1;
      continue;
    }
    if (c == '{' || c == '[') ++depth;
    else if (c == '}' || c == ']') --depth;
    ++cursor;
  }
  return false;
}

std::uint64_t MemberUnsigned(std::string_view object, std::string_view name) {
  std::string_view value;
  std::uint64_t parsed = 0;
  if (!FindMemberValue(object, name, &value)) return 0;
  return ParseUnsigned(value, &parsed) ? parsed : 0;
}

void MemberString(std::string_view object, std::string_view name,
                  std::string* out) {
  std::string_view value;
  out->clear();
  if (!FindMemberValue(object, name, &value)) return;
  if (value.size() < 2 || value.front() != '"' || value.back() != '"') return;
  out->assign(value.substr(1, value.size() - 2));
}


/**
 * Whether the object's members are exactly `names`.
 *
 * Depth-one keys only, and outside strings, so a value containing key-shaped
 * text is not mistaken for a member.
 */
bool ObjectHasExactKeys(std::string_view object,
                        const std::vector<std::string_view>& names) {
  if (object.size() < 2 || object.front() != '{') return false;
  std::vector<std::string_view> seen;
  std::size_t cursor = 1;
  int depth = 0;
  bool in_string = false;
  bool expect_key = true;
  while (cursor < object.size()) {
    const char c = object[cursor];
    if (in_string) {
      if (c == '\\') { cursor += 2; continue; }
      if (c == '"') in_string = false;
      ++cursor;
      continue;
    }
    if (c == '"') {
      if (depth == 0 && expect_key) {
        const std::size_t start = cursor + 1;
        const std::size_t end = object.find('"', start);
        if (end == std::string_view::npos) return false;
        const std::string_view key = object.substr(start, end - start);
        for (const std::string_view already : seen) {
          if (already == key) return false;  // duplicate member
        }
        seen.push_back(key);
        expect_key = false;
        cursor = end + 1;
        continue;
      }
      in_string = true;
      ++cursor;
      continue;
    }
    if (c == '{' || c == '[') { ++depth; ++cursor; continue; }
    if (c == '}' || c == ']') { --depth; ++cursor; continue; }
    if (c == ',' && depth == 0) { expect_key = true; ++cursor; continue; }
    ++cursor;
  }
  if (seen.size() != names.size()) return false;
  for (const std::string_view name : names) {
    bool found = false;
    for (const std::string_view key : seen) {
      if (key == name) { found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}

/** `true` or `false` and nothing else; absent is not false. */
bool StrictFlag(std::string_view object, std::string_view name, bool* out) {
  std::string_view value;
  if (!FindMemberValue(object, name, &value)) return false;
  if (value == "true") { *out = true; return true; }
  if (value == "false") { *out = false; return true; }
  return false;
}

bool IsPresenceToken(std::string_view value) {
  return value == "absent" || value == "inactive" || value == "active";
}

}  // namespace

bool ReadWorkerLaunchContext(EnvironmentLookup lookup,
                             WorkerLaunchContext* out) {
  if (lookup == nullptr || out == nullptr) return false;
  const char* socket_path = lookup(kEnvSocketPath);
  const char* challenge = lookup(kEnvLaunchChallenge);
  const char* generation = lookup(kEnvWorkerGeneration);
  const char* session_type = lookup(kEnvSessionType);
  const char* audit_session = lookup(kEnvAuditSessionId);
  if (socket_path == nullptr || challenge == nullptr || generation == nullptr ||
      session_type == nullptr || audit_session == nullptr) {
    return false;
  }
  const std::string_view socket_view(socket_path);
  // A relative or oversized socket path would let the process be steered at a
  // path the host never protected.
  if (socket_view.empty() || socket_view.size() > 1024 ||
      socket_view.front() != '/' || ContainsControlCharacter(socket_view)) {
    return false;
  }
  if (!ValidChallenge(challenge)) return false;
  std::uint64_t parsed_generation = 0;
  if (!ParseUnsigned(generation, &parsed_generation)) return false;

  // Exactly the two session types this agent is loaded into. An unrecognized
  // value is a hard failure: the capability profile is derived from it, so
  // guessing would decide what the worker may do.
  const std::string_view session_view(session_type);
  if (session_view != "Aqua" && session_view != "LoginWindow") return false;
  std::uint64_t parsed_audit = 0;
  if (!ParseUnsigned(audit_session, &parsed_audit) || parsed_audit == 0
      || parsed_audit > 0xFFFFFFFFull) {
    return false;
  }

  out->socket_path.assign(socket_view);
  out->challenge.assign(challenge);
  out->worker_generation = parsed_generation;
  out->session_type.assign(session_view);
  out->audit_session_id = static_cast<std::uint32_t>(parsed_audit);
  // The uid is taken from the kernel, never from the environment: an
  // environment variable is writable by whoever launched the process.
  out->uid = static_cast<std::uint32_t>(::getuid());
  return true;
}

bool BuildHelloFrame(const WorkerLaunchContext& context, std::string* out) {
  if (out == nullptr) return false;
  if (!ValidChallenge(context.challenge)) return false;
  if (context.worker_generation == 0 ||
      context.worker_generation > kMaxWorkerGeneration) {
    return false;
  }
  std::string frame;
  frame.reserve(192);
  frame.append("{\"type\":\"").append(kIpcMessageHello).append("\"");
  frame.append(",\"ipcVersion\":").append(std::to_string(kWorkerIpcVersion));
  frame.append(",\"workerGeneration\":")
      .append(std::to_string(context.worker_generation));
  frame.append(",\"challenge\":\"").append(context.challenge).append("\"}");
  if (frame.size() >= kIpcMaxFrameBytes) return false;
  *out = std::move(frame);
  return true;
}

bool BuildBootstrapHelloFrame(const BootstrapHelloContext& context,
                              std::string* out) {
  if (out == nullptr || context.uid == 0 || context.audit_session_id == 0 ||
      (context.session_type != "Aqua" &&
       context.session_type != "LoginWindow") ||
      !ValidChallenge(context.instance_nonce)) {
    return false;
  }
  std::string frame;
  frame.reserve(256);
  frame.append("{\"type\":\"").append(kBootstrapMessageHello).append("\"");
  frame.append(",\"bootstrapVersion\":")
      .append(std::to_string(kBootstrapVersion));
  frame.append(",\"uid\":").append(std::to_string(context.uid));
  frame.append(",\"auditSessionId\":")
      .append(std::to_string(context.audit_session_id));
  frame.append(",\"sessionType\":\"").append(context.session_type).append("\"");
  frame.append(",\"instanceNonce\":\"")
      .append(context.instance_nonce).append("\"}");
  if (frame.size() >= kIpcMaxFrameBytes) return false;
  *out = std::move(frame);
  return true;
}

bool ParseBootstrapGrantFrame(std::string_view frame,
                              const BootstrapHelloContext& expected,
                              BootstrapGrant* out) {
  if (out == nullptr || frame.empty() || frame.size() >= kIpcMaxFrameBytes ||
      frame.front() != '{' || frame.back() != '}' ||
      ContainsControlCharacter(frame) || expected.uid == 0 ||
      expected.audit_session_id == 0 ||
      !ValidChallenge(expected.instance_nonce) ||
      (expected.session_type != "Aqua" &&
       expected.session_type != "LoginWindow") ||
      !ObjectHasExactKeys(frame,
          {"type", "bootstrapVersion", "uid", "auditSessionId",
           "sessionType", "instanceNonce", "workerGeneration", "challenge",
           "socketPath"})) {
    return false;
  }
  std::string type;
  std::string session_type;
  std::string nonce;
  std::string challenge;
  std::string socket_path;
  MemberString(frame, "type", &type);
  MemberString(frame, "sessionType", &session_type);
  MemberString(frame, "instanceNonce", &nonce);
  MemberString(frame, "challenge", &challenge);
  MemberString(frame, "socketPath", &socket_path);
  const std::uint64_t version = MemberUnsigned(frame, "bootstrapVersion");
  const std::uint64_t uid = MemberUnsigned(frame, "uid");
  const std::uint64_t audit_session = MemberUnsigned(frame, "auditSessionId");
  const std::uint64_t generation = MemberUnsigned(frame, "workerGeneration");
  const std::string expected_socket =
      std::string(kGraphicalRuntimeRoot) + "/" + std::to_string(expected.uid) +
      "/" + std::to_string(expected.audit_session_id) +
      "/remote-desktop-agent.sock";
  if (type != kBootstrapMessageGrant || version != kBootstrapVersion ||
      uid != expected.uid || audit_session != expected.audit_session_id ||
      session_type != expected.session_type || nonce != expected.instance_nonce ||
      generation == 0 || generation > kMaxWorkerGeneration ||
      !ValidChallenge(challenge) || socket_path != expected_socket) {
    return false;
  }
  out->uid = expected.uid;
  out->audit_session_id = expected.audit_session_id;
  out->session_type = expected.session_type;
  out->instance_nonce = expected.instance_nonce;
  out->worker_generation = generation;
  out->challenge = std::move(challenge);
  out->socket_path = std::move(socket_path);
  return true;
}

bool IsGraphicalBootstrapLaunchContext(const WorkerLaunchContext& context) {
  if (context.uid == 0 || context.audit_session_id == 0 ||
      (context.session_type != "Aqua" &&
       context.session_type != "LoginWindow")) {
    return false;
  }
  const std::string expected_socket =
      std::string(kGraphicalRuntimeRoot) + "/" + std::to_string(context.uid) +
      "/" + std::to_string(context.audit_session_id) +
      "/remote-desktop-agent.sock";
  return context.socket_path == expected_socket;
}

bool ParseIpcAuthenticationAcknowledgement(
    std::string_view frame,
    const WorkerLaunchContext& expected,
    IpcAuthenticationAcknowledgement* out) {
  if (out == nullptr || !IsGraphicalBootstrapLaunchContext(expected) ||
      frame.empty() || frame.size() >= kIpcMaxFrameBytes ||
      frame.front() != '{' || frame.back() != '}' ||
      ContainsControlCharacter(frame) ||
      !ObjectHasExactKeys(frame,
          {"type", "ipcVersion", "workerGeneration", "uid",
           "auditSessionId", "pidVersion", "sessionType",
           "launchChallenge"})) {
    return false;
  }
  std::string type;
  std::string session_type;
  std::string challenge;
  MemberString(frame, "type", &type);
  MemberString(frame, "sessionType", &session_type);
  MemberString(frame, "launchChallenge", &challenge);
  const std::uint64_t version = MemberUnsigned(frame, "ipcVersion");
  const std::uint64_t generation = MemberUnsigned(frame, "workerGeneration");
  const std::uint64_t uid = MemberUnsigned(frame, "uid");
  const std::uint64_t audit_session = MemberUnsigned(frame, "auditSessionId");
  const std::uint64_t pid_version = MemberUnsigned(frame, "pidVersion");
  if (type != kIpcMessageAuthenticated || version != kWorkerIpcVersion ||
      generation != expected.worker_generation || uid != expected.uid ||
      audit_session != expected.audit_session_id || pid_version == 0 ||
      pid_version > 0xffff'ffffULL || session_type != expected.session_type ||
      challenge != expected.challenge || !ValidChallenge(challenge)) {
    return false;
  }
  out->uid = expected.uid;
  out->audit_session_id = expected.audit_session_id;
  out->pid_version = static_cast<std::uint32_t>(pid_version);
  out->worker_generation = expected.worker_generation;
  out->session_type = expected.session_type;
  out->launch_challenge = expected.challenge;
  return true;
}

bool BuildWorkerMessageFrame(std::uint64_t worker_generation,
                             std::string_view message_json, std::string* out) {
  if (out == nullptr) return false;
  if (worker_generation == 0 || worker_generation > kMaxWorkerGeneration) {
    return false;
  }
  if (message_json.empty() || message_json.front() != '{' ||
      message_json.back() != '}') {
    return false;
  }
  // A control character would either break the newline framing or be rejected
  // by the host decoder; refusing here keeps the failure local and explicit.
  if (ContainsControlCharacter(message_json)) return false;
  std::string frame;
  frame.reserve(message_json.size() + 128);
  frame.append("{\"type\":\"").append(kIpcMessageWorkerMessage).append("\"");
  frame.append(",\"ipcVersion\":").append(std::to_string(kWorkerIpcVersion));
  frame.append(",\"workerGeneration\":")
      .append(std::to_string(worker_generation));
  frame.append(",\"message\":").append(message_json).append("}");
  if (frame.size() >= kIpcMaxFrameBytes) return false;
  *out = std::move(frame);
  return true;
}

HostFrameOutcome ParseHostCommandFrame(std::string_view frame,
                                       std::uint64_t expected_generation,
                                       HostCommandFrame* out) {
  if (out == nullptr) return HostFrameOutcome::kMalformed;
  if (frame.empty() || frame.size() >= kIpcMaxFrameBytes) {
    return HostFrameOutcome::kMalformed;
  }
  if (ContainsControlCharacter(frame)) return HostFrameOutcome::kMalformed;

  std::size_t cursor = 0;
  if (!ExpectLiteral(frame, &cursor, "{")) return HostFrameOutcome::kMalformed;

  // Exactly four keys, in the order the host emits them. Accepting a reordered
  // or extended envelope here would weaken the guarantee the TypeScript
  // `hasExactRemoteDesktopKeys` check provides on the other side.
  if (!ExpectLiteral(frame, &cursor, "\"type\":")) {
    return HostFrameOutcome::kMalformed;
  }
  std::string type;
  if (!ReadPlainString(frame, &cursor, &type)) {
    return HostFrameOutcome::kMalformed;
  }
  if (type != kIpcMessageHostCommand) return HostFrameOutcome::kMalformed;

  if (!ExpectLiteral(frame, &cursor, ",") ||
      !ExpectLiteral(frame, &cursor, "\"ipcVersion\":")) {
    return HostFrameOutcome::kMalformed;
  }
  SkipWhitespace(frame, &cursor);
  const std::size_t version_start = cursor;
  while (cursor < frame.size() && frame[cursor] >= '0' &&
         frame[cursor] <= '9') {
    ++cursor;
  }
  std::uint64_t ipc_version = 0;
  if (!ParseUnsigned(frame.substr(version_start, cursor - version_start),
                     &ipc_version) ||
      ipc_version != static_cast<std::uint64_t>(kWorkerIpcVersion)) {
    return HostFrameOutcome::kMalformed;
  }

  if (!ExpectLiteral(frame, &cursor, ",") ||
      !ExpectLiteral(frame, &cursor, "\"workerGeneration\":")) {
    return HostFrameOutcome::kMalformed;
  }
  SkipWhitespace(frame, &cursor);
  const std::size_t generation_start = cursor;
  while (cursor < frame.size() && frame[cursor] >= '0' &&
         frame[cursor] <= '9') {
    ++cursor;
  }
  std::uint64_t generation = 0;
  if (!ParseUnsigned(frame.substr(generation_start, cursor - generation_start),
                     &generation)) {
    return HostFrameOutcome::kMalformed;
  }

  if (!ExpectLiteral(frame, &cursor, ",") ||
      !ExpectLiteral(frame, &cursor, "\"command\":")) {
    return HostFrameOutcome::kMalformed;
  }
  std::string command_json;
  if (!ReadBalancedObject(frame, &cursor, &command_json)) {
    return HostFrameOutcome::kMalformed;
  }
  if (!ExpectLiteral(frame, &cursor, "}")) {
    return HostFrameOutcome::kMalformed;
  }
  SkipWhitespace(frame, &cursor);
  // Trailing bytes mean this is not exactly one envelope.
  if (cursor != frame.size()) return HostFrameOutcome::kMalformed;

  // Structure is proven before generation, so a stale frame is reported as
  // stale rather than being mistaken for corruption.
  if (generation != expected_generation) return HostFrameOutcome::kStale;

  out->worker_generation = generation;
  out->command_json = std::move(command_json);
  out->command_type.clear();
  ExtractCommandType(out->command_json, &out->command_type);
  return HostFrameOutcome::kAccepted;
}

HostFrameKind ClassifyHostFrame(std::string_view frame) noexcept {
  // Type is the first member the host emits, so the classification is a prefix
  // comparison rather than a parse. A frame that is not one of the two known
  // envelopes stays kUnknown and the caller decides -- guessing here would
  // route a malformed frame into a parser that reports the wrong reason.
  std::size_t cursor = 0;
  if (!ExpectLiteral(frame, &cursor, "{")) return HostFrameKind::kUnknown;
  if (!ExpectLiteral(frame, &cursor, "\"type\":")) return HostFrameKind::kUnknown;
  std::string type;
  if (!ReadPlainString(frame, &cursor, &type)) return HostFrameKind::kUnknown;
  if (type == kIpcMessageHostCommand) return HostFrameKind::kHostCommand;
  if (type == kIpcMessageVirtualDisplayReply) {
    return HostFrameKind::kVirtualDisplayReply;
  }
  return HostFrameKind::kUnknown;
}

bool BuildVirtualDisplayRequestFrame(std::uint64_t worker_generation,
                                     std::uint64_t request_id,
                                     std::string_view request_json,
                                     std::string* out) {
  if (out == nullptr) return false;
  if (worker_generation == 0 || worker_generation > kMaxWorkerGeneration) {
    return false;
  }
  // Request ids are 1-based: zero is "no request outstanding", and a frame
  // numbered zero would correlate against that sentinel.
  if (request_id == 0 || request_id > kMaxWorkerGeneration) return false;
  if (request_json.empty() || request_json.front() != '{' ||
      request_json.back() != '}') {
    return false;
  }
  if (ContainsControlCharacter(request_json)) return false;
  std::string frame;
  frame.reserve(request_json.size() + 160);
  frame.append("{\"type\":").append("\"").append(
      kIpcMessageVirtualDisplayRequest).append("\"");
  frame.append(",\"ipcVersion\":").append(std::to_string(kWorkerIpcVersion));
  frame.append(",\"workerGeneration\":")
      .append(std::to_string(worker_generation));
  frame.append(",\"requestId\":").append(std::to_string(request_id));
  frame.append(",\"request\":").append(request_json).append("}");
  if (frame.size() >= kIpcMaxFrameBytes) return false;
  *out = std::move(frame);
  return true;
}

HostFrameOutcome ParseVirtualDisplayReplyFrame(
    std::string_view frame, std::uint64_t expected_generation,
    VirtualDisplayReplyShape shape, VirtualDisplayReplyFrame* out) {
  if (out == nullptr) return HostFrameOutcome::kMalformed;
  if (frame.empty() || frame.size() >= kIpcMaxFrameBytes) {
    return HostFrameOutcome::kMalformed;
  }
  if (ContainsControlCharacter(frame)) return HostFrameOutcome::kMalformed;

  std::size_t cursor = 0;
  if (!ExpectLiteral(frame, &cursor, "{")) return HostFrameOutcome::kMalformed;
  if (!ExpectLiteral(frame, &cursor, "\"type\":")) {
    return HostFrameOutcome::kMalformed;
  }
  std::string type;
  if (!ReadPlainString(frame, &cursor, &type)) {
    return HostFrameOutcome::kMalformed;
  }
  if (type != kIpcMessageVirtualDisplayReply) {
    return HostFrameOutcome::kMalformed;
  }

  std::uint64_t ipc_version = 0;
  if (!ExpectLiteral(frame, &cursor, ",") ||
      !ReadUnsignedMember(frame, &cursor, "\"ipcVersion\":", &ipc_version) ||
      ipc_version != static_cast<std::uint64_t>(kWorkerIpcVersion)) {
    return HostFrameOutcome::kMalformed;
  }
  std::uint64_t generation = 0;
  if (!ExpectLiteral(frame, &cursor, ",") ||
      !ReadUnsignedMember(frame, &cursor, "\"workerGeneration\":",
                          &generation)) {
    return HostFrameOutcome::kMalformed;
  }
  std::uint64_t request_id = 0;
  if (!ExpectLiteral(frame, &cursor, ",") ||
      !ReadUnsignedMember(frame, &cursor, "\"requestId\":", &request_id)) {
    return HostFrameOutcome::kMalformed;
  }
  if (!ExpectLiteral(frame, &cursor, ",") ||
      !ExpectLiteral(frame, &cursor, "\"reply\":")) {
    return HostFrameOutcome::kMalformed;
  }
  std::string reply_json;
  if (!ReadBalancedObject(frame, &cursor, &reply_json)) {
    return HostFrameOutcome::kMalformed;
  }
  if (!ExpectLiteral(frame, &cursor, "}")) {
    return HostFrameOutcome::kMalformed;
  }
  SkipWhitespace(frame, &cursor);
  if (cursor != frame.size()) return HostFrameOutcome::kMalformed;

  // Structure before generation, so a stale reply is reported as stale.
  if (generation != expected_generation) return HostFrameOutcome::kStale;
  if (request_id == 0) return HostFrameOutcome::kMalformed;

  VirtualDisplayProxyReply reply;
  bool ok = false;
  if (!StrictFlag(reply_json, "ok", &ok)) return HostFrameOutcome::kMalformed;
  reply.ok = ok;

  if (!ok) {
    // A refusal is exactly `{ok,error}`. Understanding half of a refusal is
    // how a reason gets attributed to the wrong request.
    if (!ObjectHasExactKeys(reply_json, {"ok", "error"})) {
      return HostFrameOutcome::kMalformed;
    }
    MemberString(reply_json, "error", &reply.error);
    if (reply.error.empty()) return HostFrameOutcome::kMalformed;
  } else if (shape == VirtualDisplayReplyShape::kReadiness) {
    if (!ObjectHasExactKeys(reply_json, {"ok", "nonce", "qualifiedToCreate",
                                         "displayControlAdmitted"})) {
      return HostFrameOutcome::kMalformed;
    }
    reply.nonce = MemberUnsigned(reply_json, "nonce");
    if (reply.nonce == 0) return HostFrameOutcome::kMalformed;
    if (!StrictFlag(reply_json, "qualifiedToCreate", &reply.qualified_to_create)
        || !StrictFlag(reply_json, "displayControlAdmitted",
                       &reply.display_control_admitted)) {
      return HostFrameOutcome::kMalformed;
    }
  } else if (shape == VirtualDisplayReplyShape::kRoute) {
    if (!ObjectHasExactKeys(reply_json, {"ok", "routeGeneration", "routeEpoch",
                                         "cookieSeed", "uid"})) {
      return HostFrameOutcome::kMalformed;
    }
    reply.route_generation = MemberUnsigned(reply_json, "routeGeneration");
    reply.route_epoch = MemberUnsigned(reply_json, "routeEpoch");
    reply.cookie_seed = MemberUnsigned(reply_json, "cookieSeed");
    reply.uid = MemberUnsigned(reply_json, "uid");
    // A route answer without a capability is not a route answer.
    if (reply.route_generation == 0 || reply.route_epoch == 0
        || reply.cookie_seed == 0 || reply.uid == 0) {
      return HostFrameOutcome::kMalformed;
    }
  } else {
    const bool with_display = ObjectHasExactKeys(
        reply_json, {"ok", "admitted", "presence", "displayId"});
    if (!with_display
        && !ObjectHasExactKeys(reply_json, {"ok", "admitted", "presence"})) {
      return HostFrameOutcome::kMalformed;
    }
    if (!StrictFlag(reply_json, "admitted", &reply.admitted)) {
      return HostFrameOutcome::kMalformed;
    }
    MemberString(reply_json, "presence", &reply.presence);
    // Closed set. An unknown presence would fall to a caller's default branch,
    // and that branch reads as "not shown".
    if (!IsPresenceToken(reply.presence)) return HostFrameOutcome::kMalformed;
    if (with_display) {
      reply.display_id = MemberUnsigned(reply_json, "displayId");
      if (reply.display_id == 0) return HostFrameOutcome::kMalformed;
    }
  }

  out->worker_generation = generation;
  out->request_id = request_id;
  out->reply = std::move(reply);
  return HostFrameOutcome::kAccepted;
}

bool FrameReader::Feed(std::string_view chunk,
                       std::vector<std::string>* frames) {
  if (frames == nullptr || overflowed_) return false;
  for (const char character : chunk) {
    if (character == '\n') {
      frames->emplace_back(std::move(buffer_));
      buffer_.clear();
      continue;
    }
    if (buffer_.size() + 1 >= max_frame_bytes_) {
      // Do not resynchronize: a reader that skips ahead to the next newline
      // can be walked past a frame boundary by an oversized peer.
      overflowed_ = true;
      buffer_.clear();
      return false;
    }
    buffer_.push_back(character);
  }
  return true;
}

}  // namespace imcodes::remote_desktop::macos
