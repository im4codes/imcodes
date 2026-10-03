#include "macos_auto_unlock_record_io.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstdlib>
#include <sstream>
#include <vector>

#include "macos_auto_unlock_paths.h"

namespace imcodes::remote_desktop::macos {

namespace {
constexpr char kLedgerVersion[] = "aidesk-auto-unlock-ledger-v1";
constexpr char kLedgerSeparator = '\n';
}  // namespace

std::string SerializeAutoUnlockLedger(const AutoUnlockLedgerRecord& record) {
  // A nonce containing the separator would re-parse into different fields than
  // it was written from, so it is refused rather than emitted.
  if (record.last_nonce.find(kLedgerSeparator) != std::string::npos) return {};
  return std::string(kLedgerVersion) + kLedgerSeparator +
         std::to_string(record.attempts) + kLedgerSeparator +
         std::to_string(record.locked_out_until_ms) + kLedgerSeparator +
         record.last_nonce;
}

bool ParseAutoUnlockLedger(const std::string& text,
                           AutoUnlockLedgerRecord* out) {
  if (out == nullptr || text.empty()) return false;
  std::vector<std::string> fields;
  std::string field;
  std::istringstream in(text);
  while (std::getline(in, field, kLedgerSeparator)) fields.push_back(field);
  // A truncated write (crash between write and rename is prevented by fsync +
  // rename, but a torn legacy file must still be refused) has the wrong shape.
  if (fields.size() != 4 || fields[0] != kLedgerVersion) return false;

  errno = 0;
  char* end = nullptr;
  const long long attempts = std::strtoll(fields[1].c_str(), &end, 10);
  if (errno == ERANGE || end == nullptr || *end != '\0' || fields[1].empty())
    return false;
  errno = 0;
  end = nullptr;
  const long long locked = std::strtoll(fields[2].c_str(), &end, 10);
  if (errno == ERANGE || end == nullptr || *end != '\0' || fields[2].empty())
    return false;
  if (attempts < 0 || locked < 0) return false;

  out->attempts = static_cast<int>(attempts);
  out->locked_out_until_ms = static_cast<std::int64_t>(locked);
  out->last_nonce = fields[3];
  return true;
}

AutoUnlockDirectoryState InspectAutoUnlockDirectory(
    const std::string& path, std::uint32_t required_owner,
    unsigned int required_mode) {
  struct stat info = {};
  // lstat, never stat: a symlinked drop-box pointing somewhere privileged is
  // exactly the shape this refuses.
  if (::lstat(path.c_str(), &info) != 0) return AutoUnlockDirectoryState::kAbsent;
  if (!S_ISDIR(info.st_mode)) return AutoUnlockDirectoryState::kUnsafe;
  if (info.st_uid != required_owner) return AutoUnlockDirectoryState::kUnsafe;
  if (required_mode != 0 && (info.st_mode & 0777) != required_mode)
    return AutoUnlockDirectoryState::kUnsafe;
  return AutoUnlockDirectoryState::kUsable;
}

std::string ReadValidatedAutoUnlockRecord(const std::string& path,
                                          std::uint32_t expected_owner_uid,
                                          std::size_t limit) {
  const int fd = ::open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return {};

  std::string contents;
  struct stat info = {};
  if (::fstat(fd, &info) == 0 && S_ISREG(info.st_mode) &&
      info.st_uid == expected_owner_uid &&
      (info.st_mode & 0777) == kAutoUnlockRecordMode &&
      info.st_nlink == 1 &&
      static_cast<std::size_t>(info.st_size) <= limit) {
    char buffer[512];
    ssize_t read_bytes = 0;
    while ((read_bytes = ::read(fd, buffer, sizeof(buffer))) > 0) {
      contents.append(buffer, static_cast<std::size_t>(read_bytes));
      if (contents.size() > limit) { contents.clear(); break; }
    }
  }
  ::close(fd);
  return contents;
}

bool WriteAutoUnlockRecordAtomically(const std::string& path,
                                     const std::string& contents) {
  const std::string temporary = path + ".tmp";
  ::unlink(temporary.c_str());
  const int fd = ::open(temporary.c_str(),
                        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                        kAutoUnlockRecordMode);
  if (fd < 0) return false;
  // open()'s mode argument is masked by umask, and the reader requires EXACTLY
  // kAutoUnlockRecordMode. Without this the writer's own record can be refused
  // by the validator on any host with an unusual umask.
  if (::fchmod(fd, kAutoUnlockRecordMode) != 0) {
    ::close(fd);
    ::unlink(temporary.c_str());
    return false;
  }
  const char* bytes = contents.data();
  std::size_t remaining = contents.size();
  bool ok = true;
  while (remaining > 0) {
    const ssize_t written = ::write(fd, bytes, remaining);
    if (written <= 0) { ok = false; break; }
    bytes += written;
    remaining -= static_cast<std::size_t>(written);
  }
  // Durability before visibility: a rename that outruns the data would leave a
  // truncated record, which reads as fresh and forgives a spent attempt.
  if (ok && ::fsync(fd) != 0) ok = false;
  ::close(fd);
  if (!ok || ::rename(temporary.c_str(), path.c_str()) != 0) {
    ::unlink(temporary.c_str());
    return false;
  }
  return true;
}

}  // namespace imcodes::remote_desktop::macos
