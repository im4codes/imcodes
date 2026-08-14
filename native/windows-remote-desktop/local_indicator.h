#ifndef IMCODES_REMOTE_DESKTOP_LOCAL_INDICATOR_H_
#define IMCODES_REMOTE_DESKTOP_LOCAL_INDICATOR_H_

#include <windows.h>

#include <atomic>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <thread>

#include "third_party/imcodes_remote_desktop/worker_policy.h"

namespace imcodes::rd {

// A native disclosure shown on the interactive desktop for the full lifetime
// of every remote-desktop session. It can collapse to a persistent corner
// affordance, but never disappears while a viewer is connected. Input is also
// dispatched on this window's interactive-desktop thread so SendInput cannot
// silently target a non-interactive service/thread desktop.
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
  UINT DispatchInput(UINT count, LPINPUT inputs, int size);
  bool InputAvailable();
  DWORD ClipboardSequence() const;
  std::optional<std::u16string> ReadClipboardText(
      DWORD previous_sequence);
  void Stop();

 private:
  static LRESULT CALLBACK WindowProc(HWND window, UINT message,
                                     WPARAM wparam, LPARAM lparam);
  LRESULT HandleMessage(HWND window, UINT message,
                        WPARAM wparam, LPARAM lparam);
  void ThreadMain();
  void RefreshWindow();
  void PaintWindow(HWND window);
  void AnchorToCorner(HWND window);
  void SetCollapsed(bool collapsed, bool persist);
  void RequestStopAll();

  StopAll stop_all_;
  EnvironmentChanged environment_changed_;
  std::thread thread_;
  std::mutex start_mutex_;
  std::condition_variable start_cv_;
  std::atomic<HWND> window_{nullptr};
  bool start_complete_ = false;
  bool start_ok_ = false;
  bool collapsed_ = false;
  bool wts_registered_ = false;
  std::atomic<int> viewers_{0};
  std::atomic<int> controllers_{0};
  std::atomic<bool> stopping_{false};
  std::atomic<bool> stop_requested_{false};
};

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_LOCAL_INDICATOR_H_
