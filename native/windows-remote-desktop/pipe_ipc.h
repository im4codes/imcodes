#ifndef THIRD_PARTY_IMCODES_REMOTE_DESKTOP_PIPE_IPC_H_
#define THIRD_PARTY_IMCODES_REMOTE_DESKTOP_PIPE_IPC_H_

#include <windows.h>

#include <chrono>
#include <cstddef>
#include <mutex>
#include <string>

namespace imcodes::rd {

/**
 * The worker's end of the daemon pipe.
 *
 * Overlapped, and that is the whole point. Windows serialises I/O on a
 * non-overlapped handle: with the read loop parked in `ReadFile` waiting for the
 * daemon's next message, every outbound `WriteFile` on the same handle waits
 * with it. Measured on a real node, that made each frame the worker emits --
 * status, display topology, ICE, input readiness -- leave only when the daemon
 * happened to speak next, so the whole session advanced one lease renewal at a
 * time: five seconds per hop, ten before a fresh connection would accept a
 * click, with hover motion piling up on the signalling thread in between.
 *
 * Both directions use their own OVERLAPPED and their own event, so a pending
 * read never delays a write.
 */
class PipeChannel {
 public:
  PipeChannel() = default;
  ~PipeChannel();

  PipeChannel(const PipeChannel&) = delete;
  PipeChannel& operator=(const PipeChannel&) = delete;

  /** Connects to an existing pipe, retrying only while it reports busy. */
  bool Connect(const std::wstring& path, std::chrono::milliseconds timeout);

  /** Adopts an already-opened overlapped handle. Used by tests. */
  bool Adopt(HANDLE pipe);

  bool valid() const { return pipe_ != INVALID_HANDLE_VALUE && pipe_ != nullptr; }
  HANDLE handle() const { return pipe_; }

  /** Writes every byte, or fails. Safe to call from any thread. */
  bool Write(const std::string& bytes);

  /**
   * Reads whatever is available into `buffer`, returning the byte count, or 0
   * when the pipe is gone.
   */
  size_t Read(char* buffer, size_t capacity);

  void Close();

 private:
  HANDLE pipe_ = INVALID_HANDLE_VALUE;
  HANDLE write_event_ = nullptr;
  HANDLE read_event_ = nullptr;
  std::mutex write_mutex_;
};

}  // namespace imcodes::rd

#endif  // THIRD_PARTY_IMCODES_REMOTE_DESKTOP_PIPE_IPC_H_
