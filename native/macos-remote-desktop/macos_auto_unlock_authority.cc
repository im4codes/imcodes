#include "macos_auto_unlock_authority.h"

#include <cerrno>
#include <cstdlib>
#include <sstream>
#include <vector>

namespace imcodes::remote_desktop::macos {
namespace {

constexpr char kFieldSeparator = '\n';
// v2 adds route_generation and nonce. The version string is part of the record,
// so a v1 record left behind by an older build is refused rather than parsed
// into the wrong fields.
constexpr char kRecordVersion[] = "aidesk-auto-unlock-authority-v2";

bool ContainsSeparator(const std::string& value) noexcept {
  return value.find(kFieldSeparator) != std::string::npos;
}

// strtoll, not stoll: the production toolchain builds with -fno-exceptions, so
// a throwing parser cannot even compile there. Every rejection path below sets
// *ok = false, which every caller treats as a refusal.
std::int64_t ParseInt(const std::string& value, bool* ok) noexcept {
  *ok = false;
  if (value.empty()) return 0;
  errno = 0;
  char* end = nullptr;
  const long long parsed = std::strtoll(value.c_str(), &end, 10);
  if (errno == ERANGE || end == nullptr || *end != '\0' ||
      end == value.c_str()) {
    return 0;
  }
  *ok = true;
  return parsed;
}

}  // namespace

bool AutoUnlockAuthority::IsValid() const noexcept {
  if (policy.empty() || surface.empty() || designated_requirement.empty())
    return false;
  if (enrolled.local_user_name.empty() || enrolled.local_user_uid == 0)
    return false;
  // generation 0 is the "unbound" sentinel; accepting it would let an authority
  // that names no generation satisfy a generation check.
  if (enrolled.worker_generation == 0 || enrolled.audit_session_id == 0)
    return false;
  // Same reasoning as generation 0: an authority naming no route, or carrying no
  // nonce, would satisfy a route check and a replay check that mean nothing.
  if (route_generation == 0 || nonce.empty()) return false;
  if (nonce.size() > kAutoUnlockNonceMaxBytes) return false;
  if (issued_at_ms <= 0 || expires_at_ms <= issued_at_ms)
    return false;
  if (expires_at_ms - issued_at_ms > kAutoUnlockAuthorityMaxLifetimeMs)
    return false;
  return true;
}

bool AutoUnlockAuthorityStore::IsComplete() const noexcept {
  return take && discard;
}

std::string SerializeAutoUnlockAuthority(const AutoUnlockAuthority& authority) {
  // Refuse to emit anything containing the separator rather than produce a
  // record that would re-parse into different fields than it was written from.
  for (const std::string& field :
       {authority.policy, authority.surface, authority.designated_requirement,
        authority.enrolled.local_user_name, authority.enrolled.session_type,
        authority.nonce}) {
    if (ContainsSeparator(field))
      return {};
  }
  std::ostringstream out;
  out << kRecordVersion << kFieldSeparator << authority.policy << kFieldSeparator
      << authority.surface << kFieldSeparator
      << authority.enrolled.local_user_uid << kFieldSeparator
      << authority.enrolled.local_user_name << kFieldSeparator
      << authority.enrolled.session_type << kFieldSeparator
      << authority.enrolled.audit_session_id << kFieldSeparator
      << authority.enrolled.worker_generation << kFieldSeparator
      << authority.designated_requirement << kFieldSeparator
      << authority.route_generation << kFieldSeparator << authority.nonce
      << kFieldSeparator << authority.issued_at_ms << kFieldSeparator
      << authority.expires_at_ms;
  return out.str();
}

std::optional<AutoUnlockAuthority> ParseAutoUnlockAuthority(
    const std::string& serialized) {
  if (serialized.empty() || serialized.size() > kAutoUnlockAuthorityMaxBytes)
    return std::nullopt;
  std::vector<std::string> fields;
  std::istringstream in(serialized);
  std::string field;
  while (std::getline(in, field, kFieldSeparator))
    fields.push_back(field);
  if (fields.size() != 13 || fields[0] != kRecordVersion)
    return std::nullopt;

  AutoUnlockAuthority authority;
  bool ok = true;
  authority.policy = fields[1];
  authority.surface = fields[2];
  authority.enrolled.local_user_uid =
      static_cast<std::uint32_t>(ParseInt(fields[3], &ok));
  if (!ok) return std::nullopt;
  authority.enrolled.local_user_name = fields[4];
  authority.enrolled.session_type = fields[5];
  authority.enrolled.audit_session_id =
      static_cast<std::uint32_t>(ParseInt(fields[6], &ok));
  if (!ok) return std::nullopt;
  authority.enrolled.worker_generation =
      static_cast<decltype(authority.enrolled.worker_generation)>(
          ParseInt(fields[7], &ok));
  if (!ok) return std::nullopt;
  authority.designated_requirement = fields[8];
  authority.route_generation =
      static_cast<decltype(authority.route_generation)>(ParseInt(fields[9], &ok));
  if (!ok) return std::nullopt;
  authority.nonce = fields[10];
  authority.issued_at_ms = ParseInt(fields[11], &ok);
  if (!ok) return std::nullopt;
  authority.expires_at_ms = ParseInt(fields[12], &ok);
  if (!ok) return std::nullopt;
  return authority.IsValid() ? std::optional<AutoUnlockAuthority>(authority)
                             : std::nullopt;
}

AutoUnlockAuthorityResult ConsumeAutoUnlockAuthority(
    std::uint32_t uid,
    std::uint32_t audit_session_id,
    std::int64_t now_ms,
    const AutoUnlockAuthorityStore& store) {
  AutoUnlockAuthorityResult result;
  if (!store.IsComplete() || uid == 0 || audit_session_id == 0 || now_ms <= 0) {
    result.status = AutoUnlockAuthorityStatus::kUnavailable;
    return result;
  }

  // take() removes as it reads. Everything below is therefore operating on a
  // record no other attempt can still find.
  const std::optional<std::string> serialized = store.take(uid, audit_session_id);
  if (!serialized.has_value()) {
    result.status = AutoUnlockAuthorityStatus::kAbsent;
    return result;
  }

  const std::optional<AutoUnlockAuthority> parsed =
      ParseAutoUnlockAuthority(*serialized);
  if (!parsed.has_value()) {
    store.discard(uid, audit_session_id);
    result.status = AutoUnlockAuthorityStatus::kMalformed;
    return result;
  }

  // The record names the session it was issued for. A record that named a
  // different one would let an unlock approved for one graphical session be
  // spent in another.
  if (parsed->enrolled.local_user_uid != uid ||
      parsed->enrolled.audit_session_id != audit_session_id) {
    store.discard(uid, audit_session_id);
    result.status = AutoUnlockAuthorityStatus::kSessionMismatch;
    return result;
  }
  if (now_ms >= parsed->expires_at_ms) {
    store.discard(uid, audit_session_id);
    result.status = AutoUnlockAuthorityStatus::kExpired;
    return result;
  }

  result.status = AutoUnlockAuthorityStatus::kConsumed;
  result.authority = *parsed;
  return result;
}

}  // namespace imcodes::remote_desktop::macos
