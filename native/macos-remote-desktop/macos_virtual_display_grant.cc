#include "macos_virtual_display_grant.h"

#include <cstdio>
#include <string_view>

namespace imcodes::remote_desktop::macos {
namespace {

bool IsLowerHex64(std::string_view value) noexcept {
  if (value.size() != 64) return false;
  for (const char character : value) {
    const bool hex = (character >= '0' && character <= '9') ||
                     (character >= 'a' && character <= 'f');
    if (!hex) return false;
  }
  return true;
}

/** Team IDs are exactly ten upper-case alphanumerics. */
bool IsTeamId(std::string_view value) noexcept {
  if (value.size() != 10) return false;
  for (const char character : value) {
    const bool allowed = (character >= 'A' && character <= 'Z') ||
                         (character >= '0' && character <= '9');
    if (!allowed) return false;
  }
  return true;
}

/** No control bytes, no non-ASCII. A requirement is a wire token, not text. */
bool IsPrintableAscii(std::string_view value) noexcept {
  for (const unsigned char character : value) {
    if (character < 0x20 || character > 0x7e) return false;
  }
  return true;
}

bool IsToken(std::string_view value, std::size_t maximum) noexcept {
  if (value.empty() || value.size() > maximum) return false;
  for (const char character : value) {
    const bool allowed = (character >= 'a' && character <= 'z') ||
                         (character >= 'A' && character <= 'Z') ||
                         (character >= '0' && character <= '9') ||
                         character == '.' || character == '-' || character == '_';
    if (!allowed) return false;
  }
  return true;
}

/**
 * Byte-for-byte equivalent of the producer's BUNDLE_RE:
 * `^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$`.
 *
 * NOT IsToken. IsToken also admits `_` and admits a leading `.` or `-`, and a
 * bundle identifier is neither of those things. The gap mattered because the
 * identifier is interpolated into the designated requirement: if the two ends
 * disagree about which identifiers are spellable, the producer can mint a
 * requirement the consumer refuses (a grant that cannot be delivered) or -- the
 * direction that actually hurts -- the consumer can accept an identifier the
 * producer would never have emitted, which is an identifier chosen by whoever
 * wrote the line instead of by the release.
 *
 * Leading punctuation is refused separately from the character set because
 * `.bad` and `-bad` are made only of admissible characters; it is their
 * POSITION that is wrong.
 */
bool IsBundleIdentifier(std::string_view value) noexcept {
  if (value.empty() || value.size() > 128) return false;
  const char first = value.front();
  const bool first_alnum = (first >= 'a' && first <= 'z') ||
                           (first >= 'A' && first <= 'Z') ||
                           (first >= '0' && first <= '9');
  if (!first_alnum) return false;
  for (const char character : value.substr(1)) {
    const bool allowed = (character >= 'a' && character <= 'z') ||
                         (character >= 'A' && character <= 'Z') ||
                         (character >= '0' && character <= '9') ||
                         character == '.' || character == '-';
    if (!allowed) return false;
  }
  return true;
}

bool IsChallenge(std::string_view value) noexcept {
  if (value.size() != kVirtualDisplayGrantChallengeLength) return false;
  for (const char character : value) {
    const bool allowed = (character >= 'a' && character <= 'z') ||
                         (character >= 'A' && character <= 'Z') ||
                         (character >= '0' && character <= '9') ||
                         character == '-' || character == '_';
    if (!allowed) return false;
  }
  return true;
}

bool ParseUnsigned(std::string_view text, std::uint64_t* out) noexcept {
  if (out == nullptr || text.empty() || text.size() > 20) return false;
  if (text.size() > 1 && text.front() == '0') return false;  // one encoding only
  std::uint64_t value = 0;
  for (const char digit : text) {
    if (digit < '0' || digit > '9') return false;
    const auto increment = static_cast<std::uint64_t>(digit - '0');
    if (value > (UINT64_MAX - increment) / 10U) return false;  // never wrap
    value = value * 10U + increment;
  }
  *out = value;
  return true;
}

/**
 * CANONICAL percent-decoding. Only %20 and %25 are legal.
 *
 * Over-encoding (%41 for 'A') is refused rather than decoded. Accepting it
 * would mean one designated requirement has many valid encodings, so
 * Serialize(Parse(line)) would not reproduce the input and two different lines
 * would name the same authority -- which is exactly how a canonicalisation
 * mismatch becomes a bypass.
 */
bool PercentDecode(std::string_view text, std::string* out) {
  if (out == nullptr) return false;
  out->clear();
  out->reserve(text.size());
  for (std::size_t index = 0; index < text.size(); ++index) {
    if (text[index] != '%') {
      // Control characters never survive the grammar.
      if (text[index] < 0x20 || text[index] > 0x7e) return false;
      out->push_back(text[index]);
      continue;
    }
    if (index + 2 >= text.size()) return false;
    const auto hex = [](char c) -> int {
      if (c >= '0' && c <= '9') return c - '0';
      if (c >= 'A' && c <= 'F') return c - 'A' + 10;
      return -1;
    };
    const int high = hex(text[index + 1]);
    const int low = hex(text[index + 2]);
    if (high < 0 || low < 0) return false;
    const int decoded = high * 16 + low;
    // ONLY the two characters the encoder itself produces.
    if (decoded != 0x20 && decoded != 0x25) return false;
    // And they must be spelled in upper case, so there is one encoding per
    // character rather than two.
    if (text[index + 1] != '2' ||
        (text[index + 2] != '0' && text[index + 2] != '5')) {
      return false;
    }
    out->push_back(static_cast<char>(decoded));
    index += 2;
  }
  return true;
}

std::string PercentEncode(const std::string& text) {
  static const char kHex[] = "0123456789ABCDEF";
  std::string encoded;
  encoded.reserve(text.size());
  for (const unsigned char character : text) {
    if (character == '%' || character == ' ' || character < 0x20 || character > 0x7e) {
      encoded.push_back('%');
      encoded.push_back(kHex[character >> 4]);
      encoded.push_back(kHex[character & 0x0F]);
      continue;
    }
    encoded.push_back(static_cast<char>(character));
  }
  return encoded;
}

}  // namespace

std::string CanonicalDesignatedRequirement(const std::string& bundle_identifier,
                                           const std::string& team_id) {
  if (!IsBundleIdentifier(bundle_identifier) || !IsTeamId(team_id))
    return std::string();
  return "identifier \"" + bundle_identifier +
         "\" and anchor apple generic and certificate leaf[subject.OU] = \"" +
         team_id + "\"";
}

bool VirtualDisplayGrant::ShapeValid() const noexcept {
  // Zero is never a default here: every one of these is a binding, and a
  // defaulted binding authorises something nobody described.
  return uid != 0 && uid != UINT32_MAX &&
         audit_session_id != 0 && audit_session_id != UINT32_MAX &&
         service_generation != 0 &&
         service_generation <= kVirtualDisplayGrantMaxSafeInteger &&
         ttl_ms != 0 && ttl_ms <= kVirtualDisplayGrantMaxLifetimeMs &&
         helper_size != 0 && helper_size <= kVirtualDisplayGrantMaxHelperBytes &&
         (session_type == "Aqua" || session_type == "LoginWindow") &&
         (arch == "arm64" || arch == "x64") &&
         IsChallenge(challenge) &&
         IsToken(release_identity, 96) &&
         IsLowerHex64(set_sha256) && IsLowerHex64(helper_sha256) &&
         IsToken(helper_file_name, 128) &&
         IsBundleIdentifier(helper_bundle_identifier) &&
         IsTeamId(team_id) &&
         IsPrintableAscii(helper_designated_requirement) &&
         !helper_designated_requirement.empty() &&
         helper_designated_requirement.size() <=
             kVirtualDisplayGrantMaxRequirementBytes;
}

bool VirtualDisplayGrant::WireCanonicalValid() const noexcept {
  if (!ShapeValid())
    return false;
  // The release directory name IS `sha256-` + the set digest by construction.
  if (release_identity != "sha256-" + set_sha256)
    return false;
  // EXACT, not substring. A requirement that merely mentions the right bundle
  // can also say other things.
  return helper_designated_requirement ==
         CanonicalDesignatedRequirement(helper_bundle_identifier, team_id);
}

bool AgentSessionContext::IsValid() const noexcept {
  return uid != 0 && audit_session_id != 0 && service_generation != 0 &&
         (session_type == "Aqua" || session_type == "LoginWindow");
}

bool ParseVirtualDisplayGrant(const std::string& line,
                              VirtualDisplayGrant* grant,
                              std::string* error) {
  const auto reject = [&](const char* reason) {
    if (error != nullptr) *error = reason;
    return false;
  };
  if (grant == nullptr || line.empty() ||
      line.size() > kVirtualDisplayGrantMaxBytes) {
    return reject("grant_frame_unusable");
  }
  std::string_view view(line);
  // AT MOST ONE line terminator, because the canonical form is compared after
  // stripping. Unbounded stripping meant `line`, `line\n`, `line\n\n` and every
  // longer run were all accepted and all reduced to the same canonical text --
  // so arbitrarily many distinct byte frames named one authority, and the
  // closure check below could not see the difference. One `\n`, one `\r`, or one
  // `\r\n` is a line ending; anything beyond that is a second frame's worth of
  // bytes riding along inside the first.
  if (!view.empty() && view.back() == '\n') view.remove_suffix(1);
  if (!view.empty() && view.back() == '\r') view.remove_suffix(1);
  if (!view.empty() && (view.back() == '\n' || view.back() == '\r'))
    return reject("grant_frame_unusable");
  const std::string line_canonical(view);
  if (view.rfind("grant1 ", 0) != 0) return reject("grant_prefix_unknown");
  view.remove_prefix(7);

  VirtualDisplayGrant parsed;
  bool seen[15] = {};
  const auto mark = [&seen](int slot) {
    if (seen[slot]) return false;
    seen[slot] = true;
    return true;
  };
  while (!view.empty()) {
    const std::size_t space = view.find(' ');
    const std::string_view token = view.substr(0, space);
    view = space == std::string_view::npos ? std::string_view()
                                           : view.substr(space + 1);
    const std::size_t equals = token.find('=');
    // A token with no `k=` at all is a DIFFERENT failure from a field whose
    // value is wrong, and the two want different operator responses. It is also
    // what a value containing a space degrades into: the grammar is
    // whitespace-delimited, so `helperfile=a b` arrives as `helperfile=a` plus
    // a bare `b`. Folding that into "malformed field" would hide the fact that
    // the producer emitted a value it was never allowed to emit.
    if (equals == std::string_view::npos || equals == 0)
      return reject("grant_token_unstructured");
    const std::string_view key = token.substr(0, equals);
    const std::string_view value = token.substr(equals + 1);
    std::uint64_t number = 0;
    std::string decoded;
    if (key == "uid") {
      if (!mark(0) || !ParseUnsigned(value, &number) || number > 0xFFFFFFFFULL)
        return reject("grant_field_malformed");
      parsed.uid = static_cast<std::uint32_t>(number);
    } else if (key == "asid") {
      if (!mark(1) || !ParseUnsigned(value, &number) || number > 0xFFFFFFFFULL)
        return reject("grant_field_malformed");
      parsed.audit_session_id = static_cast<std::uint32_t>(number);
    } else if (key == "session") {
      if (!mark(2)) return reject("grant_field_malformed");
      parsed.session_type = std::string(value);
    } else if (key == "svcgen") {
      if (!mark(3) || !ParseUnsigned(value, &number) ||
          number > kVirtualDisplayGrantMaxSafeInteger) {
        return reject("grant_field_malformed");
      }
      parsed.service_generation = number;
    } else if (key == "challenge") {
      if (!mark(4)) return reject("grant_field_malformed");
      parsed.challenge = std::string(value);
    } else if (key == "ttl") {
      if (!mark(5) || !ParseUnsigned(value, &number) ||
          number > kVirtualDisplayGrantMaxSafeInteger) {
        return reject("grant_field_malformed");
      }
      parsed.ttl_ms = number;
    } else if (key == "release") {
      if (!mark(6)) return reject("grant_field_malformed");
      parsed.release_identity = std::string(value);
    } else if (key == "set") {
      if (!mark(7)) return reject("grant_field_malformed");
      parsed.set_sha256 = std::string(value);
    } else if (key == "helperfile") {
      if (!mark(8)) return reject("grant_field_malformed");
      parsed.helper_file_name = std::string(value);
    } else if (key == "helpersha") {
      if (!mark(9)) return reject("grant_field_malformed");
      parsed.helper_sha256 = std::string(value);
    } else if (key == "helpersize") {
      // 512 MiB: mirrored from the producer, which refuses anything larger.
      if (!mark(10) || !ParseUnsigned(value, &number) ||
          number > 512ULL * 1024ULL * 1024ULL) {
        return reject("grant_field_malformed");
      }
      parsed.helper_size = number;
    } else if (key == "dr") {
      if (!mark(11) || !PercentDecode(value, &decoded)) return reject("grant_field_malformed");
      parsed.helper_designated_requirement = decoded;
    } else if (key == "helperbundle") {
      if (!mark(12)) return reject("grant_field_malformed");
      parsed.helper_bundle_identifier = std::string(value);
    } else if (key == "team") {
      if (!mark(13)) return reject("grant_field_malformed");
      parsed.team_id = std::string(value);
    } else if (key == "arch") {
      if (!mark(14)) return reject("grant_field_malformed");
      parsed.arch = std::string(value);
    } else {
      // Unknown key: refuse. Ignoring it would let a future field be silently
      // dropped by an older agent that then believes it understood the grant.
      return reject("grant_unknown_key");
    }
  }
  // COMPLETENESS, reported separately from shape: "absent" and "present but
  // wrong" call for different operator responses.
  for (const bool present : seen) {
    if (!present) return reject("grant_field_missing");
  }
  // SHAPE. Each field individually well-formed. ShapeValid() has its own
  // per-field counterexamples, so it and the completeness loop above are
  // provably doing different work.
  if (!parsed.ShapeValid()) return reject("grant_field_malformed");
  // CROSS-FIELD. Individually valid fields can still describe two different
  // releases: the release directory name is `sha256-` + the set digest by
  // construction, so a pair that disagrees is a grant assembled from two sets.
  if (parsed.release_identity != "sha256-" + parsed.set_sha256)
    return reject("grant_release_set_mismatch");
  // EXACT canonical requirement, not a substring match.
  //
  // A substring test ("does it mention this bundle and this team") accepts a
  // requirement that ALSO says other things -- an extra disjunction or a second
  // anchor widens who satisfies it, and the widened set is not the one the
  // release described.
  if (parsed.helper_designated_requirement !=
      CanonicalDesignatedRequirement(parsed.helper_bundle_identifier,
                                     parsed.team_id)) {
    return reject("grant_requirement_not_canonical");
  }
  // CANONICAL CLOSURE, LAST.
  //
  // Re-serialising must reproduce the input byte for byte. That subsumes key
  // order and encoding choice: if two distinct lines could name the same
  // authority, one of them fails here. It runs last because Serialize() also
  // refuses every cross-field violation above, so running it first would report
  // "not canonical" where a specific, actionable reason exists.
  if (SerializeVirtualDisplayGrant(parsed) != line_canonical)
    return reject("grant_not_canonical");
  *grant = std::move(parsed);
  return true;
}

std::string SerializeVirtualDisplayGrant(const VirtualDisplayGrant& grant) {
  // WireCanonicalValid, named directly rather than through the IsValid alias.
  // The serializer must be incapable of emitting a line its own parser refuses,
  // and that obligation should not depend on what an alias currently forwards
  // to -- redefining IsValid must not silently weaken the wire contract.
  if (!grant.WireCanonicalValid()) return std::string();
  std::string line = "grant1";
  const auto add = [&line](const char* key, const std::string& value) {
    line += ' ';
    line += key;
    line += '=';
    line += value;
  };
  add("uid", std::to_string(grant.uid));
  add("asid", std::to_string(grant.audit_session_id));
  add("session", grant.session_type);
  add("svcgen", std::to_string(grant.service_generation));
  add("challenge", grant.challenge);
  add("ttl", std::to_string(grant.ttl_ms));
  add("release", grant.release_identity);
  add("set", grant.set_sha256);
  add("helperfile", grant.helper_file_name);
  add("helpersha", grant.helper_sha256);
  add("helpersize", std::to_string(grant.helper_size));
  add("dr", PercentEncode(grant.helper_designated_requirement));
  add("helperbundle", grant.helper_bundle_identifier);
  add("team", grant.team_id);
  add("arch", grant.arch);
  return line.size() > kVirtualDisplayGrantMaxBytes ? std::string() : line;
}

GrantAdmission EvaluateGrantAdmission(const VirtualDisplayGrant& grant,
                                      const AgentSessionContext& observed,
                                      std::uint64_t now_ms) noexcept {
  if (!grant.IsValid() || !observed.IsValid() || now_ms == 0)
    return GrantAdmission::kMalformed;
  if (grant.uid != observed.uid)
    return GrantAdmission::kUidMismatch;
  // The audit session is what distinguishes two successive login windows. A
  // grant that survived one would authorise a helper in a session it was never
  // issued for.
  if (grant.audit_session_id != observed.audit_session_id)
    return GrantAdmission::kAuditSessionMismatch;
  if (grant.session_type != observed.session_type)
    return GrantAdmission::kSessionTypeMismatch;
  // Rotates when the agent is replaced, so a grant minted for a previous
  // incarnation cannot be presented to this one.
  if (grant.service_generation != observed.service_generation)
    return GrantAdmission::kServiceGenerationMismatch;
  // NO WALL-CLOCK EXPIRY CHECK HERE, deliberately.
  //
  // The grant carries a DURATION, not a deadline, and a duration cannot be
  // judged at the instant it arrives: "now minus now" is zero against any TTL,
  // so a check written here would be one that cannot fail -- worse than none,
  // because it reads like protection.
  //
  // Expiry is enforced one level up, and BEFORE this function is reached:
  // `macos_virtual_display_authority_link` forms `received_at_ms + ttl_ms` on
  // this process's CLOCK_MONOTONIC when the challenge arrives, and
  // `AcceptGrant` refuses `now_ms >= challenge.deadline_ms` ahead of
  // admission, the ledger reserve and any helper start. The challenge ledger
  // does NOT enforce presentation expiry -- it enforces single use.
  // `IsValid()` already bounds `ttl_ms`.
  //
  // The older shape was an absolute epoch deadline stamped daemon-side and
  // compared here against CLOCK_MONOTONIC: always far in this clock's future,
  // so the check could never fire and every late grant was admitted.
  return GrantAdmission::kAdmitted;
}

const char* GrantAdmissionText(GrantAdmission admission) noexcept {
  switch (admission) {
    case GrantAdmission::kAdmitted: return "admitted";
    case GrantAdmission::kMalformed: return "malformed";
    case GrantAdmission::kUidMismatch: return "uid_mismatch";
    case GrantAdmission::kAuditSessionMismatch: return "audit_session_mismatch";
    case GrantAdmission::kSessionTypeMismatch: return "session_type_mismatch";
    case GrantAdmission::kServiceGenerationMismatch:
      return "service_generation_mismatch";
    case GrantAdmission::kExpired: return "expired";
    case GrantAdmission::kChallengeReplayed: return "challenge_replayed";
  }
  return "refused";
}

}  // namespace imcodes::remote_desktop::macos
