// The agent's link to the root daemon: asymmetric mutual authentication.
//
// DIRECTION. The root LaunchDaemon LISTENS; the console-session agent DIALS.
// That is the opposite of the route socket, and deliberately so: the trust root
// is root, and only root can place an object in a directory no non-root
// principal can write. A rendezvous the agent created could be created by any
// process of that uid, so it could never prove anything about who answered.
//
// THE TWO DIRECTIONS ARE PROVEN DIFFERENTLY, BECAUSE THEY CAN BE.
//
//   agent proves the daemon  ->  the peer's kernel euid is 0, AND the socket
//                                and every one of its parent directories is
//                                root-owned, not a symlink, and not writable by
//                                group or other. Nothing else could have put an
//                                object there.
//
//   daemon proves the agent  ->  audit token plus exact designated requirement,
//                                team and bundle, plus uid / audit session.
//                                (Daemon side; not this file.)
//
// Code signing is NOT used in the agent's direction. The daemon is the Node
// binary, which on macOS is ad-hoc signed by the current build; requiring a
// Developer ID identity there would refuse every existing and development
// install permanently. Root ownership of the path is the property that is
// actually available and actually means something.
//
// A SHARED SECRET IN THE PLIST WAS ALSO REJECTED. Anything in a LaunchAgent
// plist or in the environment is readable by the local user -- `ps -E`, or just
// reading the file -- so it authenticates nobody.
//
// WHY THE RENDEZVOUS PATH MAY BE PUBLIC
//
// It is a meeting place, not a credential. Knowing where to connect buys
// nothing: the daemon still checks the agent's code identity, and the agent
// still checks that whoever answered is root and that the object it dialled
// could only have been placed by root. The authority itself -- the challenge --
// is minted per connection, inside the authenticated channel, and never
// touches the filesystem, argv or the environment.
//
// ABA. A path is not an identity. The object can be unlinked and recreated
// between the check and the connect, so device and inode are captured BEFORE
// dialling and re-checked AFTER, and any change is a refusal rather than a
// warning.
//
// The after-check RE-LSTATS THE PATH. It deliberately does not fstat the
// connected descriptor, which is the obvious implementation and is wrong:
// measured on macOS 26.2, fstat of a connected AF_UNIX socket reports a sockfs
// identity (st_dev = (dev_t)-1, and an st_ino that differs per CONNECTION),
// entirely unrelated to the filesystem inode of the bound path. Comparing that
// against the pre-connect lstat can never match, so the check would be a
// permanent false refusal -- fail-closed, but permanently broken, which is the
// same class of defect as an unreachable 0700 chain.
//
// macOS has no connectat(2), so there is no way to dial relative to a pinned
// directory descriptor either. What remains -- re-lstat -- detects the
// unlink-and-recreate window. It does not prove the descriptor refers to the
// object that was checked, and nothing available here does. The residual gap is
// closed by the other two rules rather than by this one: only root can write
// the containing directory, so only root could perform the swap at all, and
// only root may answer. "Root raced its own socket" is not a threat model.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_AUTHORITY_LINK_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_AUTHORITY_LINK_H_

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "macos_virtual_display_grant.h"

namespace imcodes::remote_desktop::macos {

/**
 * Where the root daemon publishes the authority rendezvous.
 *
 * NOT under /private/var/run, which is the obvious choice and is wrong: on
 * stock macOS that directory is `drwxrwxr-x root:daemon`, i.e. group-writable.
 * A rule that refuses group-writable ancestors -- which is the rule that makes
 * root ownership mean anything -- would therefore refuse every real machine.
 * /private/var/db is root:wheel 0755 all the way up, so the chain is clean
 * without weakening the rule to accommodate it.
 */
inline constexpr char kVirtualDisplayAuthorityDirectory[] =
    "/private/var/db/imcodes-node/runtime";
inline constexpr char kVirtualDisplayAuthoritySocketPath[] =
    "/private/var/db/imcodes-node/runtime/virtual-display-authority.sock";
/**
 * Modes the ROOT DAEMON must set explicitly after creating each object.
 *
 * Explicitly, not through umask: umask can only remove bits, so an inherited
 * permissive umask leaves the object wider than intended and an inherited
 * restrictive one leaves it unreachable. Neither failure is visible at the
 * point it is caused.
 *
 * The directory is 0711 -- traversable by a known path, never writable, so the
 * socket inside it cannot be replaced. The socket is 0622 -- root reads and
 * writes, everyone else may only CONNECT.
 */
inline constexpr std::uint32_t kVirtualDisplayAuthorityDirectoryMode = 0711;
inline constexpr std::uint32_t kVirtualDisplayAuthoritySocketMode = 0622;

/** One path component's facts, as lstat reports them. */
struct PathNodeFacts {
  bool exists = false;
  bool is_symlink = false;
  bool is_directory = false;
  bool is_socket = false;
  std::uint32_t uid = 0;
  std::uint32_t gid = 0;
  /** Permission bits only. */
  std::uint32_t mode = 0;
  std::uint64_t device = 0;
  std::uint64_t inode = 0;
};

/** Distinct so a refusal is never ambiguous in the field. */
enum class RendezvousVerdict {
  kTrusted,
  kPathUnusable,      // malformed or unbounded
  kAbsent,            // a component does not exist
  kSymlinkInPath,     // any component is a symlink
  kNotRootOwned,      // any component is owned by someone other than root
  kDirectoryWritable, // a directory is group- or world-writable
  kDirectoryNotTraversable,  // a directory denies search to the dialling agent
  kSocketNotConnectable,     // the leaf denies write to the dialling agent
  kNotADirectory,     // a parent component is not a directory
  kNotASocket,        // the leaf is not a socket
};

[[nodiscard]] const char* RendezvousVerdictText(
    RendezvousVerdict verdict) noexcept;

/**
 * Verifies every component from `/` down to the socket.
 *
 * DIRECTORIES must be root-owned and not group- or world-writable, because
 * writing a directory is what lets a principal REPLACE the object inside it.
 *
 * DIRECTORIES must ALSO grant search (x) to other. connect(2) on an AF_UNIX
 * socket requires search permission on every component of the path, so a 0700
 * chain is unreachable by the console-uid agent -- and it fails with EACCES,
 * which is indistinguishable from "the daemon is not running". Refusing it here
 * with its own verdict turns a silent, permanent outage into a named
 * misconfiguration.
 *
 * Removing other's x buys NOTHING against substitution: replacing the socket
 * requires WRITE on the containing directory, which is refused above. 0711 is
 * therefore the correct mode -- strictly the same security property as 0700,
 * and reachable.
 *
 * THE SOCKET ITSELF must be root-owned but MAY be group- or world-writable, and
 * that is not an oversight: write permission on a socket means "may connect",
 * not "may replace". Replacement is governed by the parent directory, which is
 * already locked. Refusing a connectable socket here would refuse the only
 * configuration in which a non-root agent can dial root at all.
 *
 * Pure over the injected inspector, so every counterexample is provable with no
 * filesystem.
 */
[[nodiscard]] RendezvousVerdict VerifyAuthorityRendezvous(
    const std::string& path,
    std::uint32_t dialling_uid,
    std::uint32_t dialling_gid,
    const std::function<bool(const std::string&, PathNodeFacts*)>& inspect);

/**
 * The daemon's per-connection challenge.
 *
 * Minted inside the authenticated channel and bound to the session it is for.
 * A grant presented later must match every field, so a grant minted for another
 * service generation, another audit session, or a previous connection cannot be
 * replayed into this one.
 */
struct VirtualDisplayAuthorityChallenge {
  std::string challenge;
  std::uint64_t service_generation = 0;
  std::uint32_t audit_session_id = 0;
  /**
   * Presentation lifetime in milliseconds, NOT an absolute deadline.
   *
   * Same reason as the grant's. This link forms `deadline_ms` below from this
   * duration the moment the challenge is received, on this process's own
   * CLOCK_MONOTONIC, and `AcceptGrant` is what enforces it.
   *
   * Formerly an absolute epoch deadline stamped daemon-side and compared here
   * against CLOCK_MONOTONIC -- never comparable, so the freshness check could
   * not fire.
   */
  std::uint64_t ttl_ms = 0;

  /**
   * When this promise lapses, on the RECEIVER's monotonic clock.
   *
   * Never serialized and never parsed -- it is formed locally at receipt from
   * `ttl_ms`, so the canonical wire form is unchanged. It lives on the struct
   * so every consumer of the challenge sees it: the deadline was previously
   * stored only inside the link, where nothing could act on it, and a stored
   * value nobody reads is not a check.
   */
  std::uint64_t deadline_ms = 0;

  [[nodiscard]] bool IsValid() const noexcept;
};

[[nodiscard]] bool ParseVirtualDisplayAuthorityChallenge(
    const std::string& line,
    VirtualDisplayAuthorityChallenge* challenge,
    std::string* error = nullptr);

[[nodiscard]] std::string SerializeVirtualDisplayAuthorityChallenge(
    const VirtualDisplayAuthorityChallenge& challenge);

/** Why the link is not usable. Distinct values, closed set. */
enum class AuthorityLinkState {
  kIdle,
  kRendezvousRefused,
  kPeerNotRoot,
  kSocketReplaced,     // dev/ino moved between the check and the connect
  kChallengeRefused,
  kEstablished,
  kDaemonGone,         // EOF: terminal until a new link is built
};

[[nodiscard]] const char* AuthorityLinkStateText(
    AuthorityLinkState state) noexcept;

struct AuthorityLinkSeam {
  /** lstat on one path component. */
  std::function<bool(const std::string&, PathNodeFacts*)> inspect;
  /** This process's own uid and gid, for the reachability rules. */
  std::function<std::uint32_t()> dialling_uid;
  std::function<std::uint32_t()> dialling_gid;
  /** Dials the rendezvous. Returns a descriptor or -1. */
  std::function<int(const std::string&)> dial;
  /** Kernel peer euid for a connected descriptor. UINT32_MAX when unknown. */
  std::function<std::uint32_t(int)> peer_euid;

  /** One bounded line from the daemon. False on EOF, timeout or oversize. */
  std::function<bool(int, std::string*)> read_line;
  std::function<void(int)> close_fd;
  std::function<std::uint64_t()> now_ms;

  [[nodiscard]] bool IsComplete() const noexcept;
};

/**
 * Dials the daemon, authenticates it, and holds the connection open.
 *
 * The connection is held rather than dropped because ITS LIFETIME IS THE
 * AUTHORITY'S LIFETIME: when the daemon goes away the agent must lose display
 * authority immediately, and a closed descriptor is the cheapest and most
 * reliable signal of that. A link that reconnected silently would let a
 * restarted daemon inherit an authority it never granted.
 */
class MacosVirtualDisplayAuthorityLink final {
 public:
  explicit MacosVirtualDisplayAuthorityLink(AuthorityLinkSeam seam);
  ~MacosVirtualDisplayAuthorityLink();

  MacosVirtualDisplayAuthorityLink(const MacosVirtualDisplayAuthorityLink&) =
      delete;
  MacosVirtualDisplayAuthorityLink& operator=(
      const MacosVirtualDisplayAuthorityLink&) = delete;

  /** Verifies, dials, verifies again, and consumes the daemon's challenge. */
  [[nodiscard]] bool Establish(const std::string& path, std::string* error);

  /**
   * Reads the next frame the daemon sent, whatever kind it is.
   *
   * The link is a TRANSPORT. It does not classify, because classification is
   * the owner's job and there is now more than one kind of frame on this
   * channel -- grants from the daemon and control requests the daemon is
   * proxying for a worker. An earlier version returned only grant frames and
   * silently DROPPED anything else, which consumed a control request from the
   * socket and answered nobody.
   *
   * Returns false with `state() == kDaemonGone` on EOF, which is terminal.
   */
  [[nodiscard]] bool NextFrame(std::string* frame_line, std::string* error);

  void Close();

  [[nodiscard]] AuthorityLinkState state() const noexcept { return state_; }
  [[nodiscard]] int descriptor() const noexcept { return descriptor_; }
  [[nodiscard]] const VirtualDisplayAuthorityChallenge& challenge()
      const noexcept {
    return challenge_;
  }
  [[nodiscard]] std::string last_error() const { return last_error_; }

 private:
  [[nodiscard]] bool Fail(AuthorityLinkState state,
                          const char* reason,
                          std::string* error);

  AuthorityLinkSeam seam_;
  AuthorityLinkState state_ = AuthorityLinkState::kIdle;
  int descriptor_ = -1;
  VirtualDisplayAuthorityChallenge challenge_;
  std::string last_error_;
};

/**
 * Decides whether a parsed grant may be admitted on THIS link.
 *
 * Separate from EvaluateGrantAdmission, which asks whether the grant fits the
 * agent's session. This asks the other half: whether the grant is the one the
 * daemon promised on this authenticated connection. A grant that satisfies one
 * and not the other is a grant from somewhere else.
 */
[[nodiscard]] bool GrantMatchesAuthorityChallenge(
    const VirtualDisplayGrant& grant,
    const VirtualDisplayAuthorityChallenge& challenge,
    std::string* error);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_AUTHORITY_LINK_H_
