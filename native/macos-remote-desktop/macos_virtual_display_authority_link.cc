#include "macos_virtual_display_authority_link.h"

#include <string_view>
#include <utility>

namespace imcodes::remote_desktop::macos {
namespace {

/** Bounded so a hostile line cannot force unbounded buffering. */
constexpr std::size_t kChallengeMaxBytes = 256;
/** Root, and only root. */
constexpr std::uint32_t kRootUid = 0;
/** Group-write and other-write, the two bits that let someone else replace. */
constexpr std::uint32_t kWritableByOthers = 0020U | 0002U;
/**
 * POSIX access classes. Which triple applies is decided by owner, then group,
 * then other -- and the FIRST match wins even if a later one would be more
 * permissive, which is the part people get wrong.
 */
constexpr std::uint32_t kOwnerShift = 6;
constexpr std::uint32_t kGroupShift = 3;
constexpr std::uint32_t kOtherShift = 0;
constexpr std::uint32_t kWrite = 2;
constexpr std::uint32_t kExecute = 1;

/**
 * Whether `uid`/`gid` may perform `want` on an object with these facts.
 *
 * One rule, used for both "can the agent traverse this directory" and "can the
 * agent connect to this socket". Two hardcoded bit tests would have been two
 * places to get the class selection wrong.
 */
bool Permits(const PathNodeFacts& facts, std::uint32_t uid, std::uint32_t gid,
             std::uint32_t want) noexcept {
  // root bypasses the permission triples entirely.
  if (uid == kRootUid) return true;
  const std::uint32_t shift = facts.uid == uid   ? kOwnerShift
                              : facts.gid == gid ? kGroupShift
                                                 : kOtherShift;
  return ((facts.mode >> shift) & want) == want;
}
/** Longest path we will walk. A cycle cannot occur, but a hostile length can. */
constexpr std::size_t kMaxPathBytes = 1024;

bool ParseUnsigned(std::string_view value, std::uint64_t* out) noexcept {
  if (value.empty() || value.size() > 20) return false;
  // Leading zeros make two spellings of one value, which would break the
  // canonical closure the same way a reordered key would.
  if (value.size() > 1 && value.front() == '0') return false;
  std::uint64_t accumulated = 0;
  for (const char character : value) {
    if (character < '0' || character > '9') return false;
    const std::uint64_t digit = static_cast<std::uint64_t>(character - '0');
    if (accumulated > (UINT64_MAX - digit) / 10) return false;
    accumulated = accumulated * 10 + digit;
  }
  *out = accumulated;
  return true;
}

bool IsChallengeToken(std::string_view value) noexcept {
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

/** Every ancestor of `path`, from "/" down, then `path` itself. */
bool SplitAncestors(const std::string& path, std::vector<std::string>* out) {
  if (path.empty() || path.front() != '/' || path.size() > kMaxPathBytes)
    return false;
  // A trailing slash, an empty component or a dot component would make the
  // walked chain differ from the chain the kernel resolves.
  if (path.back() == '/') return false;
  out->push_back("/");
  std::string current;
  std::size_t index = 1;
  while (index <= path.size()) {
    if (index == path.size() || path[index] == '/') {
      const std::string component = path.substr(0, index);
      if (component.size() == current.size()) return false;  // empty component
      const std::string leaf = component.substr(component.rfind('/') + 1);
      if (leaf.empty() || leaf == "." || leaf == "..") return false;
      out->push_back(component);
      current = component;
    }
    ++index;
  }
  return out->size() >= 2;
}

}  // namespace

const char* RendezvousVerdictText(RendezvousVerdict verdict) noexcept {
  switch (verdict) {
    case RendezvousVerdict::kTrusted: return "trusted";
    case RendezvousVerdict::kPathUnusable: return "rendezvous_path_unusable";
    case RendezvousVerdict::kAbsent: return "rendezvous_absent";
    case RendezvousVerdict::kSymlinkInPath: return "rendezvous_symlink_in_path";
    case RendezvousVerdict::kNotRootOwned: return "rendezvous_not_root_owned";
    case RendezvousVerdict::kDirectoryWritable:
      return "rendezvous_directory_writable";
    case RendezvousVerdict::kDirectoryNotTraversable:
      return "rendezvous_directory_not_traversable";
    case RendezvousVerdict::kSocketNotConnectable:
      return "socket_not_connectable";
    case RendezvousVerdict::kNotADirectory: return "rendezvous_not_a_directory";
    case RendezvousVerdict::kNotASocket: return "rendezvous_not_a_socket";
  }
  return "rendezvous_path_unusable";
}

RendezvousVerdict VerifyAuthorityRendezvous(
    const std::string& path,
    std::uint32_t dialling_uid,
    std::uint32_t dialling_gid,
    const std::function<bool(const std::string&, PathNodeFacts*)>& inspect) {
  if (inspect == nullptr) return RendezvousVerdict::kPathUnusable;
  std::vector<std::string> chain;
  if (!SplitAncestors(path, &chain)) return RendezvousVerdict::kPathUnusable;

  for (std::size_t index = 0; index < chain.size(); ++index) {
    const bool is_leaf = index + 1 == chain.size();
    PathNodeFacts facts;
    if (!inspect(chain[index], &facts) || !facts.exists)
      return RendezvousVerdict::kAbsent;
    // lstat, not stat: a symlink ANYWHERE in the chain means the object the
    // kernel resolves is not the object we checked, so the check proves
    // nothing about what we will actually dial.
    if (facts.is_symlink) return RendezvousVerdict::kSymlinkInPath;
    // The one property that carries the whole scheme.
    if (facts.uid != kRootUid) return RendezvousVerdict::kNotRootOwned;

    if (!is_leaf) {
      if (!facts.is_directory) return RendezvousVerdict::kNotADirectory;
      // Writing a DIRECTORY is what lets a principal replace the object inside
      // it, so this is the bit that actually prevents substitution.
      if ((facts.mode & kWritableByOthers) != 0)
        return RendezvousVerdict::kDirectoryWritable;
      // connect(2) needs search on EVERY component. A 0700 chain is
      // unreachable by a console-uid agent and fails with EACCES, which looks
      // exactly like "the daemon is not running" -- a silent, permanent
      // outage. Named here instead. Note this is NOT a weakening: substitution
      // needs WRITE on the directory, refused just above, so 0711 has the same
      // security property as 0700 and is actually reachable.
      if (!Permits(facts, dialling_uid, dialling_gid, kExecute))
        return RendezvousVerdict::kDirectoryNotTraversable;
      continue;
    }
    if (!facts.is_socket) return RendezvousVerdict::kNotASocket;
    // The socket's write bits are NOT an anti-substitution control -- write on
    // a socket means "may connect", and replacement is governed by the
    // directory above, which is already locked. They ARE a reachability fact,
    // so a socket this process cannot connect to is named here instead of
    // surfacing later as a bare EACCES that reads exactly like "the daemon is
    // not running".
    if (!Permits(facts, dialling_uid, dialling_gid, kWrite))
      return RendezvousVerdict::kSocketNotConnectable;
  }
  return RendezvousVerdict::kTrusted;
}

bool VirtualDisplayAuthorityChallenge::IsValid() const noexcept {
  return IsChallengeToken(challenge) && service_generation != 0 &&
         service_generation <= kVirtualDisplayGrantMaxSafeInteger &&
         audit_session_id != 0 && audit_session_id != UINT32_MAX &&
         ttl_ms != 0 && ttl_ms <= kVirtualDisplayGrantMaxLifetimeMs;
}

bool ParseVirtualDisplayAuthorityChallenge(
    const std::string& line,
    VirtualDisplayAuthorityChallenge* challenge,
    std::string* error) {
  const auto reject = [&](const char* reason) {
    if (error != nullptr) *error = reason;
    return false;
  };
  if (challenge == nullptr || line.empty() || line.size() > kChallengeMaxBytes)
    return reject("challenge_frame_unusable");
  std::string_view view(line);
  if (!view.empty() && view.back() == '\n') view.remove_suffix(1);
  if (!view.empty() && view.back() == '\r') view.remove_suffix(1);
  if (!view.empty() && (view.back() == '\n' || view.back() == '\r'))
    return reject("challenge_frame_unusable");
  const std::string line_canonical(view);
  if (view.rfind("chal1 ", 0) != 0) return reject("challenge_prefix_unknown");
  view.remove_prefix(6);

  VirtualDisplayAuthorityChallenge parsed;
  bool seen[4] = {};
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
    if (equals == std::string_view::npos || equals == 0)
      return reject("challenge_token_unstructured");
    const std::string_view key = token.substr(0, equals);
    const std::string_view value = token.substr(equals + 1);
    std::uint64_t number = 0;
    if (key == "challenge") {
      if (!mark(0)) return reject("challenge_field_malformed");
      parsed.challenge = std::string(value);
    } else if (key == "svcgen") {
      if (!mark(1) || !ParseUnsigned(value, &number))
        return reject("challenge_field_malformed");
      parsed.service_generation = number;
    } else if (key == "asid") {
      if (!mark(2) || !ParseUnsigned(value, &number) || number > 0xFFFFFFFFULL)
        return reject("challenge_field_malformed");
      parsed.audit_session_id = static_cast<std::uint32_t>(number);
    } else if (key == "ttl") {
      if (!mark(3) || !ParseUnsigned(value, &number))
        return reject("challenge_field_malformed");
      parsed.ttl_ms = number;
    } else {
      return reject("challenge_unknown_key");
    }
  }
  for (const bool present : seen) {
    if (!present) return reject("challenge_field_missing");
  }
  if (!parsed.IsValid()) return reject("challenge_field_malformed");
  if (SerializeVirtualDisplayAuthorityChallenge(parsed) != line_canonical)
    return reject("challenge_not_canonical");
  *challenge = std::move(parsed);
  return true;
}

std::string SerializeVirtualDisplayAuthorityChallenge(
    const VirtualDisplayAuthorityChallenge& challenge) {
  if (!challenge.IsValid()) return std::string();
  std::string line = "chal1 challenge=";
  line += challenge.challenge;
  line += " svcgen=" + std::to_string(challenge.service_generation);
  line += " asid=" + std::to_string(challenge.audit_session_id);
  line += " ttl=" + std::to_string(challenge.ttl_ms);
  if (line.size() > kChallengeMaxBytes) return std::string();
  return line;
}

bool GrantMatchesAuthorityChallenge(
    const VirtualDisplayGrant& grant,
    const VirtualDisplayAuthorityChallenge& challenge,
    std::string* error) {
  const auto reject = [&](const char* reason) {
    if (error != nullptr) *error = reason;
    return false;
  };
  if (!challenge.IsValid()) return reject("link_not_established");
  // The challenge is what proves this grant came through THIS authenticated
  // connection. A grant carrying any other challenge was minted somewhere we
  // did not authenticate.
  if (grant.challenge != challenge.challenge)
    return reject("grant_challenge_mismatch");
  // A grant for a previous incarnation of the daemon's service is stale even
  // though its challenge matched -- which can only happen if it was replayed.
  if (grant.service_generation != challenge.service_generation)
    return reject("grant_service_generation_mismatch");
  // An audit session id is what distinguishes two successive login windows.
  if (grant.audit_session_id != challenge.audit_session_id)
    return reject("grant_audit_session_mismatch");
  // The grant may not outlive the promise it was made under. Both are now
  // durations in the same units, so this compares like with like instead of
  // one clock's instant against another's.
  if (grant.ttl_ms > challenge.ttl_ms)
    return reject("grant_outlives_challenge");
  return true;
}

const char* AuthorityLinkStateText(AuthorityLinkState state) noexcept {
  switch (state) {
    case AuthorityLinkState::kIdle: return "idle";
    case AuthorityLinkState::kRendezvousRefused: return "rendezvous_refused";
    case AuthorityLinkState::kPeerNotRoot: return "peer_not_root";
    case AuthorityLinkState::kSocketReplaced: return "socket_replaced";
    case AuthorityLinkState::kChallengeRefused: return "challenge_refused";
    case AuthorityLinkState::kEstablished: return "established";
    case AuthorityLinkState::kDaemonGone: return "daemon_gone";
  }
  return "idle";
}

bool AuthorityLinkSeam::IsComplete() const noexcept {
  return inspect != nullptr && dialling_uid != nullptr &&
         dialling_gid != nullptr && dial != nullptr && peer_euid != nullptr &&
         read_line != nullptr && close_fd != nullptr && now_ms != nullptr;
}

MacosVirtualDisplayAuthorityLink::MacosVirtualDisplayAuthorityLink(
    AuthorityLinkSeam seam)
    : seam_(std::move(seam)) {}

MacosVirtualDisplayAuthorityLink::~MacosVirtualDisplayAuthorityLink() {
  Close();
}

bool MacosVirtualDisplayAuthorityLink::Fail(AuthorityLinkState state,
                                            const char* reason,
                                            std::string* error) {
  state_ = state;
  last_error_ = reason;
  if (error != nullptr) *error = reason;
  if (descriptor_ >= 0 && seam_.close_fd != nullptr) {
    seam_.close_fd(descriptor_);
    descriptor_ = -1;
  }
  challenge_ = VirtualDisplayAuthorityChallenge();
  return false;
}

bool MacosVirtualDisplayAuthorityLink::Establish(const std::string& path,
                                                 std::string* error) {
  if (!seam_.IsComplete())
    return Fail(AuthorityLinkState::kIdle, "link_not_wired", error);
  Close();

  // 1. The rendezvous must be one only root could have placed.
  const RendezvousVerdict verdict = VerifyAuthorityRendezvous(
      path, seam_.dialling_uid(), seam_.dialling_gid(), seam_.inspect);
  if (verdict != RendezvousVerdict::kTrusted) {
    return Fail(AuthorityLinkState::kRendezvousRefused,
                RendezvousVerdictText(verdict), error);
  }
  // 2. Capture the object's identity BEFORE dialling.
  PathNodeFacts before;
  if (!seam_.inspect(path, &before) || !before.exists) {
    return Fail(AuthorityLinkState::kRendezvousRefused, "rendezvous_absent",
                error);
  }

  const int descriptor = seam_.dial(path);
  if (descriptor < 0) {
    return Fail(AuthorityLinkState::kRendezvousRefused,
                "rendezvous_unreachable", error);
  }
  descriptor_ = descriptor;

  // 3. Whoever answered must be root. This is the check that makes the path
  //    check mean something: together they say "root put it there AND root is
  //    on the other end of it".
  if (seam_.peer_euid(descriptor_) != kRootUid)
    return Fail(AuthorityLinkState::kPeerNotRoot, "peer_not_root", error);

  // 4. ABA. The object could have been unlinked and recreated between the
  //    check and the connect, so the path is re-inspected and must still name
  //    the same object.
  //
  //    NOT fstat of the connected descriptor: measured on macOS, that reports a
  //    sockfs identity unrelated to the path's inode, so the comparison could
  //    never match and the check would be a permanent false refusal. See the
  //    header for why re-lstat is the strongest thing actually available here,
  //    and which other rules close the residual gap.
  PathNodeFacts after;
  if (!seam_.inspect(path, &after) || !after.exists ||
      after.device != before.device || after.inode != before.inode) {
    return Fail(AuthorityLinkState::kSocketReplaced, "socket_replaced", error);
  }

  // 5. The daemon's challenge, minted inside this authenticated channel.
  std::string line;
  if (!seam_.read_line(descriptor_, &line))
    return Fail(AuthorityLinkState::kDaemonGone, "daemon_gone", error);
  VirtualDisplayAuthorityChallenge challenge;
  std::string parse_error;
  if (!ParseVirtualDisplayAuthorityChallenge(line, &challenge, &parse_error)) {
    return Fail(AuthorityLinkState::kChallengeRefused, "challenge_refused",
                error);
  }
  // The deadline is formed HERE, from the challenge's TTL and this process's
  // own monotonic clock. Comparing a daemon-stamped epoch instant against
  // `seam_.now_ms()` -- which counts from boot -- meant the check could never
  // fire, so an arbitrarily old challenge was always accepted as fresh.
  const std::uint64_t received_at_ms = seam_.now_ms();
  if (received_at_ms == 0) {
    return Fail(AuthorityLinkState::kChallengeRefused, "challenge_refused",
                error);
  }
  // Carried ON the challenge so every consumer can act on it. Storing it only
  // inside the link meant nothing downstream could see it, and a deadline
  // nobody reads is not a check.
  challenge.deadline_ms = received_at_ms + challenge.ttl_ms;
  challenge_ = challenge;
  state_ = AuthorityLinkState::kEstablished;
  last_error_.clear();
  return true;
}

bool MacosVirtualDisplayAuthorityLink::NextFrame(std::string* frame_line,
                                                 std::string* error) {
  if (state_ != AuthorityLinkState::kEstablished || frame_line == nullptr) {
    if (error != nullptr) *error = "link_not_established";
    return false;
  }
  std::string line;
  if (!seam_.read_line(descriptor_, &line)) {
    // EOF is TERMINAL. The daemon's connection lifetime IS the authority's
    // lifetime; a link that reconnected silently would let a restarted daemon
    // inherit an authority it never granted.
    return Fail(AuthorityLinkState::kDaemonGone, "daemon_gone", error);
  }
  // Handed up unclassified. A frame the owner cannot make sense of is answered
  // with a refusal, not by closing the link: one bad frame must not become a
  // lost display.
  *frame_line = std::move(line);
  return true;
}

void MacosVirtualDisplayAuthorityLink::Close() {
  if (descriptor_ >= 0 && seam_.close_fd != nullptr) {
    seam_.close_fd(descriptor_);
  }
  descriptor_ = -1;
  challenge_ = VirtualDisplayAuthorityChallenge();
  if (state_ == AuthorityLinkState::kEstablished)
    state_ = AuthorityLinkState::kIdle;
}

}  // namespace imcodes::remote_desktop::macos
