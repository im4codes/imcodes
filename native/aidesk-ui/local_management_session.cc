#include "local_management_session.h"

#include <array>
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <sstream>
#include <utility>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <cerrno>
#include <cstring>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#endif

namespace imcodes::aidesk::ui {
namespace common = remote_desktop::common;
namespace {

using namespace std::chrono_literals;

std::string ReadFile(const std::string& path) {
  std::ifstream stream(path, std::ios::binary);
  std::ostringstream contents;
  contents << stream.rdbuf();
  return stream.good() || stream.eof() ? contents.str() : std::string();
}

std::string Token(const char* prefix, std::uint64_t sequence) {
  const auto now = std::chrono::steady_clock::now().time_since_epoch().count();
  return std::string(prefix) + "_" + std::to_string(now) + "_" +
         std::to_string(sequence);
}

class Stream final {
 public:
  ~Stream() { Close(); }
  bool Connect(const std::string& endpoint) {
    Close();
#if defined(_WIN32)
    const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                              endpoint.data(),
                                              static_cast<int>(endpoint.size()),
                                              nullptr, 0);
    if (required <= 0) return false;
    std::wstring wide(static_cast<std::size_t>(required), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, endpoint.data(),
                            static_cast<int>(endpoint.size()), wide.data(),
                            required) != required) return false;
    handle_ = CreateFileW(wide.c_str(), GENERIC_READ | GENERIC_WRITE, 0,
                          nullptr, OPEN_EXISTING, 0, nullptr);
    return handle_ != INVALID_HANDLE_VALUE;
#else
    if (endpoint.empty() || endpoint.size() >= sizeof(sockaddr_un::sun_path)) return false;
    fd_ = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd_ < 0) return false;
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, endpoint.c_str(), endpoint.size() + 1);
    if (connect(fd_, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) != 0) {
      Close();
      return false;
    }
    timeval timeout{0, 250000};
    setsockopt(fd_, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    return true;
#endif
  }
  bool Write(std::string_view bytes) {
    std::size_t offset = 0;
    while (offset < bytes.size()) {
#if defined(_WIN32)
      DWORD written = 0;
      if (!::WriteFile(handle_, bytes.data() + offset,
                       static_cast<DWORD>(bytes.size() - offset),
                       &written, nullptr)) return false;
      if (written == 0) return false;
      offset += written;
#else
      const ssize_t count = write(fd_, bytes.data() + offset, bytes.size() - offset);
      if (count <= 0) return false;
      offset += static_cast<std::size_t>(count);
#endif
    }
    return true;
  }
  int Read(char* buffer, std::size_t size) {
#if defined(_WIN32)
    DWORD available = 0;
    if (!PeekNamedPipe(handle_, nullptr, 0, nullptr, &available, nullptr)) return -1;
    if (available == 0) {
      Sleep(50);
      return 0;
    }
    DWORD read = 0;
    if (!::ReadFile(handle_, buffer,
                    static_cast<DWORD>(std::min<std::size_t>(size, available)),
                    &read, nullptr)) return -1;
    return static_cast<int>(read);
#else
    const ssize_t count = read(fd_, buffer, size);
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) return 0;
    return static_cast<int>(count);
#endif
  }
  void Close() {
#if defined(_WIN32)
    if (handle_ != INVALID_HANDLE_VALUE) CloseHandle(handle_);
    handle_ = INVALID_HANDLE_VALUE;
#else
    if (fd_ >= 0) close(fd_);
    fd_ = -1;
#endif
  }
 private:
#if defined(_WIN32)
  HANDLE handle_ = INVALID_HANDLE_VALUE;
#else
  int fd_ = -1;
#endif
};

}  // namespace

std::string DefaultLocalManagementBootstrapPath() {
#if defined(_WIN32)
  const char* program_data = std::getenv("ProgramData");
  return std::string(program_data == nullptr ? "C:\\ProgramData" : program_data) +
         "\\imcodes-node\\aidesk-local-management-v1.json";
#elif defined(__APPLE__)
  return "/Library/Application Support/imcodes-node/aidesk-local-management-v1.json";
#else
  return "/var/lib/imcodes-node/aidesk-local-management-v1.json";
#endif
}

LocalManagementSession::LocalManagementSession(std::string bootstrap_path,
                                               Observer observer)
    : bootstrap_path_(std::move(bootstrap_path)), observer_(std::move(observer)) {}

LocalManagementSession::~LocalManagementSession() { Stop(); }

void LocalManagementSession::Start() {
  if (running_.exchange(true)) return;
  thread_ = std::thread([this] { Run(); });
}

void LocalManagementSession::Stop() {
  if (!running_.exchange(false)) return;
  changed_.notify_all();
  if (thread_.joinable()) thread_.join();
}

bool LocalManagementSession::SendAction(common::LocalManagementAction action,
                                        std::uint64_t expected_revision,
                                        std::string connection_id) {
  if (!running_ || expected_revision == 0) return false;
  {
    std::lock_guard lock(mutex_);
    if (actions_.size() >= 16) return false;
    actions_.push_back({action, expected_revision, std::move(connection_id)});
  }
  changed_.notify_all();
  return true;
}

void LocalManagementSession::Publish(SessionUpdate update) {
  if (std::getenv("AIDESK_UI_DIAGNOSTICS") != nullptr) {
    std::cerr << "aidesk_ui_state=" << static_cast<int>(update.state)
              << " snapshot=" << (update.snapshot ? 1 : 0)
              << " ack=" << (update.ack ? 1 : 0)
              << " error=" << update.error << '\n';
  }
  if (observer_) observer_(std::move(update));
}

void LocalManagementSession::Run() {
  std::uint64_t sequence = 1;
  auto backoff = 250ms;
  while (running_) {
    Publish({SessionState::kStarting});
    const auto bootstrap = common::ParseLocalManagementBootstrap(ReadFile(bootstrap_path_));
    if (!bootstrap) {
      Publish({SessionState::kStopped, std::nullopt, std::nullopt, "bootstrap_unavailable"});
      std::unique_lock lock(mutex_);
      changed_.wait_for(lock, backoff, [this] { return !running_ || !actions_.empty(); });
      backoff = std::min(backoff * 2, 5000ms);
      continue;
    }
    Stream stream;
    if (!stream.Connect(bootstrap->endpoint)) {
      Publish({SessionState::kStopped, std::nullopt, std::nullopt, "service_unavailable"});
      std::unique_lock lock(mutex_);
      changed_.wait_for(lock, backoff, [this] { return !running_; });
      backoff = std::min(backoff * 2, 5000ms);
      continue;
    }
    common::LocalManagementClientCore client(
        bootstrap->bootstrap_secret, "aidesk-fltk-ui-v1", bootstrap->product_version);
    const auto hello = client.EncodeHello(Token("hello", sequence++));
    if (!hello || !stream.Write(*hello)) continue;
    backoff = 250ms;
    auto next_refresh = std::chrono::steady_clock::now() + 1s;
    bool reconnect = false;
    while (running_ && !reconnect) {
      PendingAction pending{common::LocalManagementAction::kPause, 0, {}};
      bool have_action = false;
      {
        std::lock_guard lock(mutex_);
        if (!actions_.empty()) {
          pending = std::move(actions_.front());
          actions_.pop_front();
          have_action = true;
        }
      }
      if (have_action) {
        const auto encoded = client.EncodeAction(Token("action", sequence++),
                                                  pending.expected_revision,
                                                  pending.action,
                                                  pending.connection_id);
        if (!encoded || !stream.Write(*encoded)) { reconnect = true; continue; }
      }
      const auto now = std::chrono::steady_clock::now();
      if (client.authenticated() && now >= next_refresh) {
        const auto refresh = client.EncodeRefresh(Token("refresh", sequence++));
        if (!refresh || !stream.Write(*refresh)) { reconnect = true; continue; }
        next_refresh = now + 1s;
      }
      std::array<char, 16384> buffer{};
      const int count = stream.Read(buffer.data(), buffer.size());
      if (count < 0) { reconnect = true; continue; }
      if (count == 0) continue;
      std::vector<common::LocalManagementEvent> events;
      if (!client.Consume(std::string_view(buffer.data(), static_cast<std::size_t>(count)),
                          &events)) {
        Publish({SessionState::kVersionMismatch, std::nullopt, std::nullopt,
                 "protocol_rejected"});
        reconnect = true;
        continue;
      }
      for (auto& event : events) {
        SessionUpdate update;
        update.state = SessionState::kConnected;
        if (event.welcome) update.snapshot = event.welcome->snapshot;
        if (event.snapshot) update.snapshot = std::move(event.snapshot);
        if (event.ack) update.ack = std::move(event.ack);
        if (event.kind == common::LocalManagementEvent::Kind::kError) {
          update.error = event.error;
          if (event.error == common::kLocalManagementVersionMismatchError)
            update.state = SessionState::kVersionMismatch;
          reconnect = true;
        }
        Publish(std::move(update));
      }
    }
  }
}

}  // namespace imcodes::aidesk::ui
