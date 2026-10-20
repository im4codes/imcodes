#ifndef IMCODES_MACOS_REMOTE_DESKTOP_WORKER_VIDEO_LOG_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_WORKER_VIDEO_LOG_H_

#include <cstddef>
#include <mutex>
#include <string>
#include <string_view>

namespace imcodes::remote_desktop::macos {

// The worker's stderr goes to /dev/null (launch-agent plist), so what it decides
// about video -- the raw-codec decision, the negotiated codec, the encoder that
// came up -- is written to a small file the node can read instead. It lives in the
// node's own per-user runtime directory (IMCODES_REMOTE_DESKTOP_RUNTIME_DIR, mode
// 0700, owned by the session's user), next to the IPC sockets.
//
// One line per event: a UTC timestamp, then key=value pairs. Nothing from the
// user's content, no secrets, no free text.
inline constexpr char kWorkerVideoLogFileName[] = "worker-video.log";
inline constexpr std::size_t kWorkerVideoLogMaxBytes = 64 * 1024;
inline constexpr std::size_t kWorkerVideoLogMaxLineBytes = 512;

class WorkerVideoLog {
 public:
  // An empty `path` disables the log (Append returns false). `max_bytes` bounds the
  // file: when it would be exceeded the file is renamed to `<path>.1` (replacing an
  // older one) and a fresh file is started, so two files hold at most ~2x the bound.
  explicit WorkerVideoLog(std::string path,
                          std::size_t max_bytes = kWorkerVideoLogMaxBytes)
      : path_(std::move(path)), max_bytes_(max_bytes) {}

  // Appends one event line. Newlines and control bytes in `line` become spaces and
  // the line is cut at kWorkerVideoLogMaxLineBytes. The file is opened with
  // O_NOFOLLOW (a planted symlink is refused) and mode 0600. Never throws, never
  // blocks on anything but the filesystem; false when nothing was written.
  bool Append(std::string_view line);

  [[nodiscard]] const std::string& path() const noexcept { return path_; }

 private:
  const std::string path_;
  const std::size_t max_bytes_;
  std::mutex mutex_;
};

// The log's path inside a runtime directory ("" when there is no directory).
[[nodiscard]] std::string WorkerVideoLogPath(std::string_view runtime_directory);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_WORKER_VIDEO_LOG_H_
