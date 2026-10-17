#ifndef IMCODES_AIDESK_UI_LOCAL_MANAGEMENT_SESSION_H_
#define IMCODES_AIDESK_UI_LOCAL_MANAGEMENT_SESSION_H_

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <thread>

#include "../remote-desktop-common/local_management_ipc.h"

namespace imcodes::aidesk::ui {

enum class SessionState { kStarting, kConnected, kStopped, kVersionMismatch };

struct SessionUpdate {
  SessionState state = SessionState::kStarting;
  std::optional<remote_desktop::common::LocalManagementSnapshot> snapshot;
  std::optional<remote_desktop::common::LocalManagementAck> ack;
  std::string error;
};

class LocalManagementSession final {
 public:
  using Observer = std::function<void(SessionUpdate)>;

  LocalManagementSession(std::string bootstrap_path, Observer observer);
  ~LocalManagementSession();
  LocalManagementSession(const LocalManagementSession&) = delete;
  LocalManagementSession& operator=(const LocalManagementSession&) = delete;

  void Start();
  void Stop();
  bool SendAction(remote_desktop::common::LocalManagementAction action,
                  std::uint64_t expected_revision,
                  std::string connection_id = {});

 private:
  struct PendingAction {
    remote_desktop::common::LocalManagementAction action;
    std::uint64_t expected_revision;
    std::string connection_id;
  };

  void Run();
  void Publish(SessionUpdate update);

  std::string bootstrap_path_;
  Observer observer_;
  std::atomic<bool> running_{false};
  std::thread thread_;
  std::mutex mutex_;
  std::condition_variable changed_;
  std::deque<PendingAction> actions_;
};

std::string DefaultLocalManagementBootstrapPath();

}  // namespace imcodes::aidesk::ui

#endif  // IMCODES_AIDESK_UI_LOCAL_MANAGEMENT_SESSION_H_
