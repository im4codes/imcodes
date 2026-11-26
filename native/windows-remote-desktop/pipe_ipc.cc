#include "third_party/imcodes_remote_desktop/pipe_ipc.h"

#include <algorithm>

namespace imcodes::rd {
namespace {

constexpr DWORD kMaxChunkBytes = 64 * 1024;

// Completes one overlapped operation, waiting for it when it is still pending.
bool AwaitOverlapped(HANDLE pipe, OVERLAPPED* overlapped, BOOL started,
                     DWORD* transferred) {
  if (!started && GetLastError() != ERROR_IO_PENDING) return false;
  return GetOverlappedResult(pipe, overlapped, transferred, TRUE) != FALSE;
}

}  // namespace

PipeChannel::~PipeChannel() {
  Close();
}

bool PipeChannel::Connect(const std::wstring& path,
                          std::chrono::milliseconds timeout) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  do {
    HANDLE pipe = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0,
                              nullptr, OPEN_EXISTING,
                              FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED,
                              nullptr);
    if (pipe != INVALID_HANDLE_VALUE) return Adopt(pipe);
    if (GetLastError() != ERROR_PIPE_BUSY) return false;
    WaitNamedPipeW(path.c_str(), 250);
  } while (std::chrono::steady_clock::now() < deadline);
  return false;
}

bool PipeChannel::Adopt(HANDLE pipe) {
  if (pipe == INVALID_HANDLE_VALUE || pipe == nullptr) return false;
  Close();
  write_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  read_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!write_event_ || !read_event_) {
    if (write_event_) CloseHandle(write_event_);
    if (read_event_) CloseHandle(read_event_);
    write_event_ = nullptr;
    read_event_ = nullptr;
    CloseHandle(pipe);
    return false;
  }
  pipe_ = pipe;
  return true;
}

bool PipeChannel::Write(const std::string& bytes) {
  if (!valid()) return false;
  std::lock_guard<std::mutex> lock(write_mutex_);
  size_t offset = 0;
  while (offset < bytes.size()) {
    const DWORD remaining = static_cast<DWORD>(
        std::min<size_t>(bytes.size() - offset, kMaxChunkBytes));
    OVERLAPPED overlapped{};
    overlapped.hEvent = write_event_;
    ResetEvent(write_event_);
    DWORD written = 0;
    const BOOL started = WriteFile(pipe_, bytes.data() + offset, remaining,
                                   nullptr, &overlapped);
    if (!AwaitOverlapped(pipe_, &overlapped, started, &written) ||
        written == 0) {
      return false;
    }
    offset += written;
  }
  return true;
}

size_t PipeChannel::Read(char* buffer, size_t capacity) {
  if (!valid() || capacity == 0) return 0;
  OVERLAPPED overlapped{};
  overlapped.hEvent = read_event_;
  ResetEvent(read_event_);
  DWORD read = 0;
  const BOOL started =
      ReadFile(pipe_, buffer, static_cast<DWORD>(std::min<size_t>(
                                  capacity, kMaxChunkBytes)),
               nullptr, &overlapped);
  if (!AwaitOverlapped(pipe_, &overlapped, started, &read)) return 0;
  return static_cast<size_t>(read);
}

void PipeChannel::Close() {
  if (pipe_ != INVALID_HANDLE_VALUE && pipe_ != nullptr) {
    CancelIoEx(pipe_, nullptr);
    CloseHandle(pipe_);
  }
  pipe_ = INVALID_HANDLE_VALUE;
  if (write_event_) CloseHandle(write_event_);
  if (read_event_) CloseHandle(read_event_);
  write_event_ = nullptr;
  read_event_ = nullptr;
}

}  // namespace imcodes::rd
