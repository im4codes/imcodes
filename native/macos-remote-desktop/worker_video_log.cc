#include "worker_video_log.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>

namespace imcodes::remote_desktop::macos {
namespace {

std::string Timestamp() {
  struct timespec now {};
  ::clock_gettime(CLOCK_REALTIME, &now);
  struct tm utc {};
  ::gmtime_r(&now.tv_sec, &utc);
  // Each field is clamped to its printed width, so the buffer is provably enough.
  char buffer[64];
  const int milliseconds = static_cast<int>((now.tv_nsec / 1'000'000) % 1000);
  std::snprintf(buffer, sizeof(buffer), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                (utc.tm_year + 1900) % 10000, (utc.tm_mon + 1) % 100,
                utc.tm_mday % 100, utc.tm_hour % 100, utc.tm_min % 100,
                utc.tm_sec % 100, milliseconds);
  return buffer;
}

}  // namespace

std::string WorkerVideoLogPath(std::string_view runtime_directory) {
  if (runtime_directory.empty()) return {};
  std::string path(runtime_directory);
  if (path.back() != '/') path.push_back('/');
  path += kWorkerVideoLogFileName;
  return path;
}

bool WorkerVideoLog::Append(std::string_view line) {
  if (path_.empty()) return false;
  std::string text = Timestamp();
  text.push_back(' ');
  const std::size_t room = kWorkerVideoLogMaxLineBytes > text.size()
                               ? kWorkerVideoLogMaxLineBytes - text.size() - 1
                               : 0;
  for (std::size_t i = 0; i < line.size() && i < room; ++i) {
    const unsigned char c = static_cast<unsigned char>(line[i]);
    text.push_back(c < 0x20 || c == 0x7f ? ' ' : static_cast<char>(c));
  }
  text.push_back('\n');

  std::lock_guard lock(mutex_);
  struct stat before {};
  if (::lstat(path_.c_str(), &before) == 0 &&
      static_cast<std::size_t>(before.st_size) + text.size() > max_bytes_) {
    // Replaces an older rotated file; the live name is then created fresh below.
    (void)::rename(path_.c_str(), (path_ + ".1").c_str());
  }
  const int fd = ::open(path_.c_str(),
                        O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return false;
  const ssize_t written = ::write(fd, text.data(), text.size());
  ::close(fd);
  return written == static_cast<ssize_t>(text.size());
}

}  // namespace imcodes::remote_desktop::macos
