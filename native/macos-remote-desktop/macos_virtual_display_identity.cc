#include "macos_virtual_display_identity.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <pwd.h>
#include <unistd.h>

#include <vector>

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

namespace imcodes::remote_desktop::macos {
namespace {

// splitmix64. Chosen for one property that matters here: a single-bit input
// change avalanches across the whole output, so generation N+1 does not land
// adjacent to the poisoned generation N.
std::uint64_t Mix(std::uint64_t value) noexcept {
  value += 0x9E3779B97F4A7C15ULL;
  value = (value ^ (value >> 30U)) * 0xBF58476D1CE4E5B9ULL;
  value = (value ^ (value >> 27U)) * 0x94D049BB133111EBULL;
  return value ^ (value >> 31U);
}

bool ModeIsPrivate(mode_t mode) noexcept {
  return (mode & (S_IRWXG | S_IRWXO)) == 0;
}

}  // namespace

bool VirtualDisplayIdentity::IsValid() const noexcept {
  return vendor_id == kAiDeskVirtualDisplayVendorId &&
         product_id == kAiDeskVirtualDisplayProductId && serial_number != 0 &&
         slot < kAiDeskVirtualDisplayMaxSlots &&
         identity_generation < kAiDeskVirtualDisplayMaxIdentityGeneration;
}

std::string VirtualDisplayIdentity::DebugString() const {
  char buffer[128];
  std::snprintf(buffer, sizeof(buffer),
                "vendor=0x%04x product=0x%04x serial=%u slot=%u generation=%u",
                vendor_id, product_id, serial_number, slot, identity_generation);
  return std::string(buffer);
}

std::uint32_t DeriveVirtualDisplaySerial(
    std::uint64_t instance_id,
    std::uint32_t slot,
    std::uint32_t identity_generation) noexcept {
  const std::uint64_t mixed =
      Mix(instance_id ^ (static_cast<std::uint64_t>(slot) << 40U) ^
          (static_cast<std::uint64_t>(identity_generation) << 52U));
  const auto folded = static_cast<std::uint32_t>(mixed) ^
                      static_cast<std::uint32_t>(mixed >> 32U);
  // Zero is rejected by the private API; Chromium records that a serial of 0
  // was crashing. Map it to a fixed non-zero value rather than re-deriving,
  // so the function stays total and deterministic.
  return folded == 0 ? 1U : folded;
}

bool CanAdvanceIdentityGeneration(std::uint32_t identity_generation) noexcept {
  return identity_generation + 1U < kAiDeskVirtualDisplayMaxIdentityGeneration;
}

VirtualDisplayIdentity DeriveVirtualDisplayIdentity(
    std::uint64_t instance_id,
    std::uint32_t slot,
    std::uint32_t identity_generation) noexcept {
  VirtualDisplayIdentity identity;
  // An unusable instance id must not produce a plausible identity. Returning an
  // invalid one forces the caller to fail closed instead of creating a display
  // under an identity that may already be registered.
  if (instance_id == 0 || slot >= kAiDeskVirtualDisplayMaxSlots ||
      identity_generation >= kAiDeskVirtualDisplayMaxIdentityGeneration) {
    identity.serial_number = 0;
    identity.slot = slot;
    identity.identity_generation = identity_generation;
    return identity;
  }
  identity.slot = slot;
  identity.identity_generation = identity_generation;
  identity.serial_number =
      DeriveVirtualDisplaySerial(instance_id, slot, identity_generation);
  return identity;
}

bool ParseInstanceId(const std::string& contents,
                     std::uint64_t* instance_id) noexcept {
  if (instance_id == nullptr)
    return false;
  // Bounded before anything else: a huge file at this path is a rejection, not
  // an allocation.
  if (contents.empty() || contents.size() > 32)
    return false;
  std::size_t end = contents.size();
  // Exactly one optional trailing newline is tolerated; anything else is not.
  if (end > 0 && contents[end - 1] == '\n')
    --end;
  if (end == 0 || end > 20)
    return false;
  std::uint64_t value = 0;
  for (std::size_t index = 0; index < end; ++index) {
    const char digit = contents[index];
    if (digit < '0' || digit > '9')
      return false;
    // Overflow-safe accumulate. A truncated-but-numeric file must be rejected,
    // not wrapped into a different valid-looking id.
    if (value > (UINT64_MAX - static_cast<std::uint64_t>(digit - '0')) / 10U)
      return false;
    value = value * 10U + static_cast<std::uint64_t>(digit - '0');
  }
  if (value == 0)
    return false;
  *instance_id = value;
  return true;
}

std::string FormatInstanceId(std::uint64_t instance_id) {
  char buffer[32];
  std::snprintf(buffer, sizeof(buffer), "%llu\n",
                static_cast<unsigned long long>(instance_id));
  return std::string(buffer);
}

IdentityStoreResult LoadOrCreateInstanceId(const std::string& path,
                                           std::uint64_t candidate_instance_id) {
  IdentityStoreResult result;
  if (path.empty()) {
    result.detail = "empty identity store path";
    return result;
  }

  // O_NOFOLLOW is the whole point: a symlink planted at this path must be a
  // hard rejection, never a redirect we follow into somewhere we then chmod.
  int fd = ::open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd >= 0) {
    struct stat info {};
    if (::fstat(fd, &info) != 0) {
      ::close(fd);
      result.detail = "could not stat the identity store";
      return result;
    }
    if (!S_ISREG(info.st_mode)) {
      ::close(fd);
      result.status = IdentityStoreStatus::kRejected;
      result.detail = "identity store is not a regular file";
      return result;
    }
    if (info.st_uid != ::geteuid()) {
      ::close(fd);
      result.status = IdentityStoreStatus::kRejected;
      result.detail = "identity store is owned by another user";
      return result;
    }
    if (!ModeIsPrivate(info.st_mode)) {
      ::close(fd);
      result.status = IdentityStoreStatus::kRejected;
      result.detail = "identity store is group- or world-accessible";
      return result;
    }
    char buffer[64];
    const ssize_t read_bytes = ::read(fd, buffer, sizeof(buffer));
    ::close(fd);
    if (read_bytes < 0) {
      result.detail = "could not read the identity store";
      return result;
    }
    std::uint64_t parsed = 0;
    if (!ParseInstanceId(std::string(buffer, static_cast<std::size_t>(read_bytes)),
                         &parsed)) {
      result.status = IdentityStoreStatus::kRejected;
      result.detail = "identity store contents are malformed";
      return result;
    }
    result.status = IdentityStoreStatus::kLoaded;
    result.instance_id = parsed;
    return result;
  }
  if (errno == ELOOP) {
    result.status = IdentityStoreStatus::kRejected;
    result.detail = "identity store path is a symlink";
    return result;
  }
  if (errno != ENOENT) {
    result.detail = "could not open the identity store";
    return result;
  }
  if (candidate_instance_id == 0) {
    result.detail = "no candidate instance id was supplied";
    return result;
  }

  // Atomic create: temp in the SAME directory (so rename cannot cross a device),
  // fsync the file, rename, then fsync the directory. A crash at any point
  // leaves either no file or a complete one — never a truncated id that would
  // parse as a different display identity.
  const std::size_t separator = path.find_last_of('/');
  const std::string directory =
      separator == std::string::npos ? std::string(".") : path.substr(0, separator);
  std::string temporary = path + ".tmp";
  ::unlink(temporary.c_str());
  const int temp_fd =
      ::open(temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
             S_IRUSR | S_IWUSR);
  if (temp_fd < 0) {
    result.detail = "could not create the identity store";
    return result;
  }
  const std::string body = FormatInstanceId(candidate_instance_id);
  const ssize_t written =
      ::write(temp_fd, body.data(), body.size());
  if (written < 0 || static_cast<std::size_t>(written) != body.size() ||
      ::fsync(temp_fd) != 0) {
    ::close(temp_fd);
    ::unlink(temporary.c_str());
    result.detail = "could not durably write the identity store";
    return result;
  }
  ::close(temp_fd);
  if (::rename(temporary.c_str(), path.c_str()) != 0) {
    ::unlink(temporary.c_str());
    result.detail = "could not commit the identity store";
    return result;
  }
  // Without this the rename itself can be lost on power failure, which would
  // resurrect the previous identity while a display registered under the new
  // one is still stranded.
  const int dir_fd = ::open(directory.c_str(), O_RDONLY | O_CLOEXEC);
  if (dir_fd >= 0) {
    ::fsync(dir_fd);
    ::close(dir_fd);
  }
  result.status = IdentityStoreStatus::kCreated;
  result.instance_id = candidate_instance_id;
  return result;
}

std::string InstanceIdPathForUid(std::uint32_t uid) {
  if (uid == 0)
    return std::string();  // root has no Aqua container to own this
  struct passwd record {};
  struct passwd* result = nullptr;
  // Bounded buffer; a uid whose entry does not fit is a refusal, not a guess.
  std::vector<char> buffer(4096);
  if (::getpwuid_r(static_cast<uid_t>(uid), &record, buffer.data(),
                   buffer.size(), &result) != 0 ||
      result == nullptr || result->pw_dir == nullptr ||
      result->pw_dir[0] != '/') {
    return std::string();
  }
  const std::string home(result->pw_dir);
  if (home.size() > 512)
    return std::string();
  return home + "/Library/Application Support/aiDesk/virtual-display-instance-id";
}

std::string IdentityGenerationPathForUid(std::uint32_t uid, std::uint32_t slot) {
  const std::string base = InstanceIdPathForUid(uid);
  if (base.empty() || slot >= kAiDeskVirtualDisplayMaxSlots)
    return std::string();
  return base + ".generation." + std::to_string(slot);
}

std::uint32_t LoadIdentityGeneration(const std::string& path) {
  if (path.empty())
    return 0;
  // Same safety rules as the instance id: no symlink, our uid, private mode.
  const int fd = ::open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0)
    return 0;
  struct stat info {};
  if (::fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) ||
      info.st_uid != ::geteuid() || !ModeIsPrivate(info.st_mode)) {
    ::close(fd);
    return 0;
  }
  char buffer[32];
  const ssize_t read_bytes = ::read(fd, buffer, sizeof(buffer));
  ::close(fd);
  if (read_bytes <= 0)
    return 0;
  std::uint64_t value = 0;
  if (!ParseInstanceId(std::string(buffer, static_cast<std::size_t>(read_bytes)),
                       &value)) {
    return 0;
  }
  // Out of range means the file is not describing a generation we can honour;
  // starting from zero is the safe reading, not clamping to the maximum.
  if (value >= kAiDeskVirtualDisplayMaxIdentityGeneration)
    return 0;
  return static_cast<std::uint32_t>(value);
}

bool StoreIdentityGeneration(const std::string& path, std::uint32_t generation) {
  if (path.empty() || generation >= kAiDeskVirtualDisplayMaxIdentityGeneration)
    return false;
  // ParseInstanceId rejects zero, so generation 0 is represented by removing
  // the file rather than by writing an unparseable value.
  if (generation == 0) {
    ::unlink(path.c_str());
    return true;
  }
  const std::string temporary = path + ".tmp";
  ::unlink(temporary.c_str());
  const int fd = ::open(temporary.c_str(),
                        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                        S_IRUSR | S_IWUSR);
  if (fd < 0)
    return false;
  const std::string body = FormatInstanceId(generation);
  const ssize_t written = ::write(fd, body.data(), body.size());
  const bool durable =
      written >= 0 && static_cast<std::size_t>(written) == body.size() &&
      ::fsync(fd) == 0;
  ::close(fd);
  if (!durable || ::rename(temporary.c_str(), path.c_str()) != 0) {
    ::unlink(temporary.c_str());
    return false;
  }
  return true;
}

std::string DefaultInstanceIdPath() {
  const char* home = std::getenv("HOME");
  if (home == nullptr || *home == '\0')
    return std::string();
  return std::string(home) +
         "/Library/Application Support/aiDesk/virtual-display-instance-id";
}

}  // namespace imcodes::remote_desktop::macos
