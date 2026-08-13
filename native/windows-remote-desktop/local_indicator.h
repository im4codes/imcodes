#ifndef IMCODES_REMOTE_DESKTOP_LOCAL_INDICATOR_H_
#define IMCODES_REMOTE_DESKTOP_LOCAL_INDICATOR_H_

#include <windows.h>

#include <atomic>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <thread>

#include "third_party/imcodes_remote_desktop/worker_policy.h"

namespace imcodes::rd {

// A native, non-dismissible disclosure shown on the interactive desktop for
// the full lifetime of every remote-desktop session. Closing the window is
// deliberately treated as "Stop all" rather than hiding the disclosure.
class LocalIndicator {
 public:
  using StopAll = std::function<void()>;
  using EnvironmentChanged = std::function<void(uint32_t)>;

  LocalIndicator();
  ~LocalIndicator();
  LocalIndicator(const LocalIndicator&) = delete;
  LocalIndicator& operator=(const LocalIndicator&) = delete;

  bool Start(StopAll stop_all, EnvironmentChanged environment_changed);
  void Update(int viewers, int controllers);
  void Stop();

 private:
  static LRESULT CALLBACK WindowProc(HWND window, UINT message,
                                     WPARAM wparam, LPARAM lparam);
  LRESULT HandleMessage(HWND window, UINT message,
                        WPARAM wparam, LPARAM lparam);
  void ThreadMain();
  void RefreshWindow();
  void RequestStopAll();

  StopAll stop_all_;
  EnvironmentChanged environment_changed_;
  std::thread thread_;
  std::mutex start_mutex_;
  std::condition_variable start_cv_;
  std::atomic<HWND> window_{nullptr};
  HWND label_ = nullptr;
  HWND button_ = nullptr;
  bool start_complete_ = false;
  bool start_ok_ = false;
  std::atomic<int> viewers_{0};
  std::atomic<int> controllers_{0};
  std::atomic<bool> stopping_{false};
  std::atomic<bool> stop_requested_{false};
};

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_LOCAL_INDICATOR_H_
