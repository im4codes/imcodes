// One-shot filesystem delegation for the signed aiDesk.to app.
//
// The root controlled node cannot list ~/Desktop, ~/Documents, ~/Downloads unless its OWN bare executable holds Full Disk Access,
// which System Settings shows as an unnamed exec. The aiDesk.to app (`to.aidesk.app`) is the identity the user sees, so the node asks
// the app to do the one syscall it is denied: it writes a request file only root can have created and runs
//   aidesk-agent --aidesk-fs-request <file>
// in the user's session. The node decides WHICH paths may be read (its file-preview path policy); this helper only supplies the TCC
// identity. It runs as the user, so it can read nothing a root process could not.
//
// Because any process of the same user can run this executable with any argument, the helper authenticates the REQUEST, not the
// caller: the file must sit in the per-user request directory, reached through directories that are root-owned and not world-writable,
// be a regular file owned by root and not writable by group/other, and be unexpired. A same-user process cannot create such a file.
//
// Plain POSIX C++17 (no Objective-C, no AppKit) so the logic builds and is tested on any POSIX host.
//
// Request file (`key=value` lines): v=1, op=list, path_hex=<hex UTF-8 path>, created_ms, expires_ms, nonce=<hex>.
// Answer (stdout): see shared/macos-fs-delegate.ts, the single description of the framing.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_AIDESK_FS_DELEGATE_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_AIDESK_FS_DELEGATE_H_

#include <sys/types.h>

#include <cstddef>
#include <cstdint>
#include <string>

namespace imcodes::aidesk::fs_delegate {

inline constexpr char kRequestFlag[] = "--aidesk-fs-request";
// Root-owned tree the node creates: <root>/<uid>/<request>.req. Every directory in it is root:wheel 0755 so a user can search it but never create in it.
inline constexpr char kProductionRuntimeRoot[] = "/private/var/run/imcodes-node/fs-delegate";
// Mirror of MACOS_FS_DELEGATE_LIMITS in shared/macos-fs-delegate.ts.
inline constexpr std::int64_t kRequestTtlMs = 10'000;
inline constexpr std::int64_t kMaxClockSkewMs = 1'000;
inline constexpr std::size_t kMaxPathBytes = 4096;
inline constexpr std::size_t kMaxEntries = 20'000;
inline constexpr std::size_t kMaxAnswerBytes = 3'500'000;

struct Options {
  // The only directory a request file may live in.
  std::string request_dir;
  // Directories from this one down to `request_dir` must be root-owned (trusted) and not world-writable. Everything above it is the
  // system's own (/private/var/run, ...) and is not inspected. Production: /private/var/run/imcodes-node.
  std::string trusted_chain_start;
  // Who may own the directories and the request file. Production: 0 (root); tests use the test's own uid.
  uid_t trusted_owner_uid = 0;
  std::int64_t now_ms = 0;
  std::size_t max_entries = kMaxEntries;
  std::size_t max_answer_bytes = kMaxAnswerBytes;
};

// Validate and answer one request. `*answer` receives the complete stdout text (framing in shared/macos-fs-delegate.ts); it is ALWAYS a
// well-formed answer, either a result or `error <reason>`. Returns 0 (every well-formed answer, refusals included, exits 0: the reason
// is in the answer, a non-zero exit is reserved for usage errors).
int RunFsDelegateRequest(const std::string& request_file, const Options& options, std::string* answer);

// Entry point for `aidesk-agent --aidesk-fs-request <file>`: production options (per-user request directory, root trust, wall clock),
// answer on stdout. Returns the process exit code.
int FsDelegateMain(int argc, char** argv);

// True when argv is exactly `--aidesk-fs-request <file>`.
bool IsFsDelegateInvocation(int argc, char** argv);

}  // namespace imcodes::aidesk::fs_delegate

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_AIDESK_FS_DELEGATE_H_
