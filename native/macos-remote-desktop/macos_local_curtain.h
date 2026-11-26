#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_LOCAL_CURTAIN_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_LOCAL_CURTAIN_H_

#include <atomic>
#include <cstdint>
#include <memory>
#include <thread>

namespace imcodes::remote_desktop::macos {

/**
 * Local screen curtain: while a remote controller works, the physical displays
 * show black and local keyboard/mouse input is ignored, but capture -- which
 * reads the framebuffer, not the panel -- keeps sending the real desktop.
 *
 * Output is darkened by zeroing each display's gamma transfer table, which
 * acts after composition. Local input is dropped by a session event tap that
 * passes only events carrying kImcodesSyntheticEventMarker.
 *
 * Fail-safe by construction: macOS restores a process's gamma changes and
 * removes its event taps when that process exits, so a crashed or killed
 * worker can never leave a Mac dark or unusable.
 */
class MacosLocalCurtain {
 public:
  MacosLocalCurtain();
  ~MacosLocalCurtain();
  MacosLocalCurtain(const MacosLocalCurtain&) = delete;
  MacosLocalCurtain& operator=(const MacosLocalCurtain&) = delete;

  /** Darkens every active display and starts dropping local input. */
  [[nodiscard]] bool Engage();
  /** Restores output and local input. Idempotent. */
  void Release() noexcept;
  /**
   * Re-applies the gamma while engaged: a display wake, mode change or the
   * lock screen can reset it. Call periodically from the owning loop.
   */
  void Refresh() noexcept;
  [[nodiscard]] bool engaged() const noexcept {
    return engaged_.load(std::memory_order_acquire);
  }

 private:
  class InputBlocker;
  std::atomic<bool> engaged_{false};
  std::unique_ptr<InputBlocker> input_blocker_;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_LOCAL_CURTAIN_H_
