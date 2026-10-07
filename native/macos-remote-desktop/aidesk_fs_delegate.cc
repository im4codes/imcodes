#include "aidesk_fs_delegate.h"

#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

namespace imcodes::aidesk::fs_delegate {
namespace {

// Stable reason codes; the same strings as MACOS_FS_DELEGATE_REASON in shared/macos-fs-delegate.ts.
constexpr char kBadRequestFile[] = "bad_request_file";
constexpr char kRequestDirUntrusted[] = "request_dir_untrusted";
constexpr char kRequestOwnerUntrusted[] = "request_owner_untrusted";
constexpr char kRequestExpired[] = "request_expired";
constexpr char kRequestExpiryTooFar[] = "request_expiry_too_far";
constexpr char kRequestCreatedInFuture[] = "request_created_in_future";
constexpr char kUnsupportedVersion[] = "unsupported_version";
constexpr char kUnsupportedOp[] = "unsupported_op";
constexpr char kBadPath[] = "bad_path";
constexpr char kPermissionDenied[] = "permission_denied";
constexpr char kNotFound[] = "not_found";
constexpr char kNotDirectory[] = "not_directory";
constexpr char kSymlinkRefused[] = "symlink_refused";
constexpr char kChangedDuringRead[] = "changed_during_read";
constexpr char kIoError[] = "io_error";

constexpr char kAnswerMagic[] = "IMCODES-FS-V1";
constexpr std::size_t kMaxRequestFileBytes = 4096 + 512;

std::string ErrorAnswer(const char* reason) {
  return std::string(kAnswerMagic) + "\nerror " + reason + "\n";
}

std::string Hex(const std::string& bytes) {
  static const char kDigits[] = "0123456789abcdef";
  std::string out;
  out.reserve(bytes.size() * 2);
  for (unsigned char c : bytes) {
    out.push_back(kDigits[c >> 4]);
    out.push_back(kDigits[c & 0x0f]);
  }
  return out;
}

bool Unhex(const std::string& hex, std::string* out) {
  if (hex.size() % 2 != 0) return false;
  auto nibble = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
  };
  out->clear();
  out->reserve(hex.size() / 2);
  for (std::size_t i = 0; i < hex.size(); i += 2) {
    const int hi = nibble(hex[i]);
    const int lo = nibble(hex[i + 1]);
    if (hi < 0 || lo < 0) return false;
    out->push_back(static_cast<char>((hi << 4) | lo));
  }
  return true;
}

const char* ReasonForErrno(int error) {
  switch (error) {
    case EACCES:
    case EPERM:
      return kPermissionDenied;
    case ENOENT:
      return kNotFound;
    case ENOTDIR:
      return kNotDirectory;
    case ELOOP:
      return kSymlinkRefused;
    default:
      return kIoError;
  }
}

// A path every component of which is a plain name: absolute, no empty, `.` or `..` component, no NUL, bounded.
bool IsStrictAbsolutePath(const std::string& path) {
  if (path.empty() || path.size() > kMaxPathBytes || path[0] != '/') return false;
  if (path.find('\0') != std::string::npos) return false;
  std::size_t start = 1;
  while (start <= path.size()) {
    std::size_t end = path.find('/', start);
    if (end == std::string::npos) end = path.size();
    const std::string part = path.substr(start, end - start);
    if (part.empty()) {
      // a trailing slash is the only empty component allowed ("/" itself, or "/a/")
      if (end != path.size()) return false;
    } else if (part == "." || part == "..") {
      return false;
    }
    start = end + 1;
  }
  return true;
}

std::string DirName(const std::string& path) {
  const std::size_t slash = path.rfind('/');
  if (slash == std::string::npos) return ".";
  return slash == 0 ? "/" : path.substr(0, slash);
}

std::string BaseName(const std::string& path) {
  const std::size_t slash = path.rfind('/');
  return slash == std::string::npos ? path : path.substr(slash + 1);
}

bool IsSafeRequestName(const std::string& name) {
  if (name.empty() || name.size() > 96 || name[0] == '.') return false;
  for (char c : name) {
    const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.';
    if (!ok) return false;
  }
  return true;
}

// The directory chain is inspected with lstat BEFORE the request file is opened: from `trusted_chain_start` down to `request_dir`
// every component must be a real directory (no symlink), owned by the trusted uid and not world-writable; the final directory must not
// be group-writable either.
const char* CheckRequestDirectoryChain(const Options& options) {
  const std::string& dir = options.request_dir;
  const std::string& start = options.trusted_chain_start;
  if (!IsStrictAbsolutePath(dir) || !IsStrictAbsolutePath(start)) return kRequestDirUntrusted;
  const std::string start_prefix = start == "/" ? "/" : start + "/";
  if (dir != start && dir.compare(0, start_prefix.size(), start_prefix) != 0) return kRequestDirUntrusted;
  std::vector<std::string> chain;
  for (std::string current = dir;; current = DirName(current)) {
    chain.push_back(current);
    if (current == start) break;
    if (current == "/") return kRequestDirUntrusted;
  }
  for (const std::string& component : chain) {
    struct stat st;
    if (lstat(component.c_str(), &st) != 0) return kRequestDirUntrusted;
    if (!S_ISDIR(st.st_mode)) return kRequestDirUntrusted;  // a symlink reports S_IFLNK here, so it is refused too
    if (st.st_uid != options.trusted_owner_uid) return kRequestDirUntrusted;
    if ((st.st_mode & S_IWOTH) != 0) return kRequestDirUntrusted;
    if (component == dir && (st.st_mode & S_IWGRP) != 0) return kRequestDirUntrusted;
  }
  return nullptr;
}

bool ParseInt64(const std::string& text, std::int64_t* out) {
  if (text.empty() || text.size() > 18) return false;
  std::int64_t value = 0;
  for (char c : text) {
    if (c < '0' || c > '9') return false;
    value = value * 10 + (c - '0');
  }
  *out = value;
  return true;
}

struct ParsedRequest {
  std::string op;
  std::string path;
  std::int64_t created_ms = 0;
  std::int64_t expires_ms = 0;
};

// Returns nullptr on success, else a reason.
const char* ParseRequestText(const std::string& text, const Options& options, ParsedRequest* parsed) {
  std::map<std::string, std::string> fields;
  std::size_t position = 0;
  while (position < text.size()) {
    std::size_t end = text.find('\n', position);
    if (end == std::string::npos) return kBadRequestFile;  // every line must be newline-terminated
    const std::string line = text.substr(position, end - position);
    position = end + 1;
    const std::size_t equals = line.find('=');
    if (equals == std::string::npos || equals == 0) return kBadRequestFile;
    const std::string key = line.substr(0, equals);
    if (fields.count(key) != 0) return kBadRequestFile;
    fields[key] = line.substr(equals + 1);
  }
  static const char* const kKeys[] = {"v", "op", "path_hex", "created_ms", "expires_ms", "nonce"};
  if (fields.size() != sizeof(kKeys) / sizeof(kKeys[0])) return kBadRequestFile;
  for (const char* key : kKeys) {
    if (fields.count(key) == 0) return kBadRequestFile;
  }
  if (fields["v"] != "1") return kUnsupportedVersion;
  if (fields["op"] != "list") return kUnsupportedOp;
  parsed->op = fields["op"];
  const std::string& nonce = fields["nonce"];
  if (nonce.size() < 16 || nonce.size() > 128) return kBadRequestFile;
  for (char c : nonce) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return kBadRequestFile;
  }
  if (!Unhex(fields["path_hex"], &parsed->path)) return kBadRequestFile;
  if (!IsStrictAbsolutePath(parsed->path)) return kBadPath;
  if (!ParseInt64(fields["created_ms"], &parsed->created_ms) || !ParseInt64(fields["expires_ms"], &parsed->expires_ms)) {
    return kBadRequestFile;
  }
  // Time. A request is good for kRequestTtlMs and no longer; a clock rolled back (or a file claiming a far-future expiry) is refused.
  if (parsed->created_ms > options.now_ms + kMaxClockSkewMs) return kRequestCreatedInFuture;
  if (parsed->expires_ms <= options.now_ms) return kRequestExpired;
  if (parsed->expires_ms > options.now_ms + kRequestTtlMs + kMaxClockSkewMs) return kRequestExpiryTooFar;
  if (parsed->expires_ms < parsed->created_ms || parsed->expires_ms - parsed->created_ms > kRequestTtlMs) return kRequestExpiryTooFar;
  return nullptr;
}

// Reads the request file after the directory chain passed. The file is opened without following symlinks and judged by fstat on the
// descriptor it was opened as, so nothing can swap it between the check and the read.
const char* ReadRequestFile(const std::string& path, const Options& options, std::string* text) {
  const int fd = open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  if (fd < 0) return kBadRequestFile;
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) { close(fd); return kBadRequestFile; }
  if (st.st_uid != options.trusted_owner_uid) { close(fd); return kRequestOwnerUntrusted; }
  if ((st.st_mode & (S_IWGRP | S_IWOTH)) != 0 || st.st_nlink != 1) { close(fd); return kRequestOwnerUntrusted; }
  if (st.st_size <= 0 || static_cast<std::size_t>(st.st_size) > kMaxRequestFileBytes) { close(fd); return kBadRequestFile; }
  text->assign(static_cast<std::size_t>(st.st_size), '\0');
  std::size_t read_total = 0;
  while (read_total < text->size()) {
    const ssize_t n = read(fd, &(*text)[read_total], text->size() - read_total);
    if (n <= 0) break;
    read_total += static_cast<std::size_t>(n);
  }
  close(fd);
  if (read_total != text->size()) return kBadRequestFile;
  return nullptr;
}

std::string ListDirectory(const std::string& requested, const Options& options) {
  char resolved[PATH_MAX];
  if (realpath(requested.c_str(), resolved) == nullptr) return ErrorAnswer(ReasonForErrno(errno));
  const std::string real_path = resolved;
  struct stat link_stat;
  if (lstat(real_path.c_str(), &link_stat) != 0) return ErrorAnswer(ReasonForErrno(errno));
  if (S_ISLNK(link_stat.st_mode)) return ErrorAnswer(kSymlinkRefused);
  if (!S_ISDIR(link_stat.st_mode)) return ErrorAnswer(kNotDirectory);
  const int dir_fd = open(real_path.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (dir_fd < 0) return ErrorAnswer(ReasonForErrno(errno));
  struct stat open_stat;
  if (fstat(dir_fd, &open_stat) != 0 || open_stat.st_dev != link_stat.st_dev || open_stat.st_ino != link_stat.st_ino) {
    close(dir_fd);
    return ErrorAnswer(kChangedDuringRead);
  }
  DIR* dir = fdopendir(dir_fd);
  if (dir == nullptr) {
    const int error = errno;
    close(dir_fd);
    return ErrorAnswer(ReasonForErrno(error));
  }
  std::string body = std::string(kAnswerMagic) + "\nrealpath " + Hex(real_path) + "\n";
  std::size_t count = 0;
  bool truncated = false;
  errno = 0;
  while (struct dirent* entry = readdir(dir)) {
    const std::string name = entry->d_name;
    if (name == "." || name == "..") continue;
    if (count >= options.max_entries || body.size() >= options.max_answer_bytes) {
      truncated = true;
      break;
    }
    char kind = 'o';
    struct stat entry_stat;
    if (fstatat(dirfd(dir), name.c_str(), &entry_stat, AT_SYMLINK_NOFOLLOW) == 0) {
      if (S_ISDIR(entry_stat.st_mode)) kind = 'd';
      else if (S_ISREG(entry_stat.st_mode)) kind = 'f';
    }
    body += "entry ";
    body.push_back(kind);
    body.push_back(' ');
    body += Hex(name);
    body.push_back('\n');
    ++count;
  }
  const int read_error = errno;
  closedir(dir);
  if (read_error != 0) return ErrorAnswer(ReasonForErrno(read_error));
  body += "end " + std::to_string(count) + (truncated ? " 1\n" : " 0\n");
  return body;
}

}  // namespace

bool IsFsDelegateInvocation(int argc, char** argv) {
  return argc == 3 && std::strcmp(argv[1], kRequestFlag) == 0;
}

int RunFsDelegateRequest(const std::string& request_file, const Options& options, std::string* answer) {
  // 1. The request must be a plain file name inside the one request directory.
  if (!IsStrictAbsolutePath(request_file) || DirName(request_file) != options.request_dir ||
      !IsSafeRequestName(BaseName(request_file))) {
    *answer = ErrorAnswer(kBadRequestFile);
    return 0;
  }
  // 2. lstat the directory chain, THEN open the file.
  if (const char* reason = CheckRequestDirectoryChain(options)) {
    *answer = ErrorAnswer(reason);
    return 0;
  }
  std::string text;
  if (const char* reason = ReadRequestFile(request_file, options, &text)) {
    *answer = ErrorAnswer(reason);
    return 0;
  }
  ParsedRequest parsed;
  if (const char* reason = ParseRequestText(text, options, &parsed)) {
    *answer = ErrorAnswer(reason);
    return 0;
  }
  *answer = ListDirectory(parsed.path, options);
  return 0;
}

int FsDelegateMain(int argc, char** argv) {
  if (!IsFsDelegateInvocation(argc, argv)) return 64;  // EX_USAGE
  Options options;
#ifdef IMCODES_FS_DELEGATE_TEST_RUNTIME_ROOT
  // A compile-time constant that exists ONLY in a throw-away test build (scripts/build-aidesk-app.mjs never defines it; a test asserts
  // that). It lets a scoped test app use its own trust tree instead of the default node's /private/var/run/imcodes-node. There is no
  // environment variable or argument that moves the directory: a process of the same user could set those.
  const std::string runtime_root = IMCODES_FS_DELEGATE_TEST_RUNTIME_ROOT;
  options.trusted_chain_start = DirName(runtime_root);
#else
  const std::string runtime_root = kProductionRuntimeRoot;
  options.trusted_chain_start = "/private/var/run/imcodes-node";
#endif
  options.request_dir = runtime_root + "/" + std::to_string(static_cast<unsigned long>(getuid()));
  options.trusted_owner_uid = 0;
  options.now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  std::string answer;
  RunFsDelegateRequest(argv[2], options, &answer);
  const std::size_t written = std::fwrite(answer.data(), 1, answer.size(), stdout);
  std::fflush(stdout);
  return written == answer.size() ? 0 : 74;  // EX_IOERR
}

}  // namespace imcodes::aidesk::fs_delegate
