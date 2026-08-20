#ifndef IMCODES_REMOTE_DESKTOP_DISPLAY_CAPTURE_H_
#define IMCODES_REMOTE_DESKTOP_DISPLAY_CAPTURE_H_

#include <windows.h>
#include <dxgi1_2.h>

#include "third_party/imcodes_remote_desktop/worker_policy.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <wrl/client.h>

#include "api/scoped_refptr.h"
#include "api/video/i420_buffer.h"
#include "api/video/video_frame.h"
#include "api/video/video_broadcaster.h"
#include "pc/video_track_source.h"

struct ID3D11Device;
struct ID3D11DeviceContext;
struct ID3D11Texture2D;
struct IDXGIOutput1;
struct IDXGIOutputDuplication;

namespace imcodes::rd {

struct DisplayInfo {
  std::string id;
  std::string label;
  std::wstring device_name;
  RECT desktop_rect{};
  int width = 0;
  int height = 0;
  int rotation_degrees = 0;
  double dpi_scale = 1.0;
  bool primary = false;
  bool available = true;
  // Set only for the exact in-box IM.codes IDD adapter identity. This is not
  // inferred from a vendor/GPU name and therefore cannot select an unrelated
  // third-party virtual-display adapter.
  bool imcodes_virtual = false;
  LUID adapter_luid{};
  UINT output_index = 0;
  /**
   * The resolutions this driver reports, largest first and deduplicated across
   * refresh rates. A GPU with no monitor attached often offers exactly one, so
   * a fixed menu of common sizes leaves the operator clicking entries that can
   * never apply.
   */
  std::vector<DisplayMode> modes;
};

std::vector<DisplayInfo> EnumerateDisplays();
std::string DisplaySourceKey(const DisplayInfo& display);
// Windows exposes per-source DPI through DisplayConfig device-info packets.
// The packet ids remain undocumented, so this helper validates every size,
// source identity and supported scale before applying a change and otherwise
// fails closed without changing the display.
bool SetDisplayDpiScale(const DisplayInfo& display, int percent);

enum class CursorSnapshotSource { kNone, kNative, kDxgi };

// Prefer the live USER32 cursor whenever it is available. Some display
// drivers stop advancing Desktop Duplication's cached pointer position after
// a synthesized click even though SetCursorPos continues to move the real
// cursor. The native snapshot is authoritative; DXGI remains a fallback for
// desktops where USER32 cannot expose one.
CursorSnapshotSource SelectCursorSnapshotSource(bool native_available,
                                                bool dxgi_available);

enum class CaptureFallback {
  kNone,
  // DXGI can hold a duplication open yet never present a first frame: the
  // sign-in desktop does it, and so does an idle desktop on a machine with no
  // monitor attached (AcquireNextFrame returns DXGI_ERROR_WAIT_TIMEOUT
  // forever). GDI still reads those desktops. Engaged only after DXGI has
  // failed to produce any frame at all, and never persisted to disk.
  kDesktopGdi,
};

// DXGI Desktop Duplication capture source. Capture is obtained from a D3D11
// output duplication surface, copied through one reusable staging texture and
// delivered as post-rotation I420 frames to libwebrtc. When DXGI never presents
// a first frame at all, capture falls back to an in-memory GDI read of the same
// desktop rather than stalling the session. It never calls the
// Computer Use screenshot path and never emits still-image application data.
class DxgiDesktopSource : public webrtc::VideoTrackSource {
 public:
  static webrtc::scoped_refptr<DxgiDesktopSource> Create(
      const DisplayInfo& display,
      CaptureFallback fallback = CaptureFallback::kNone);

  void Start();
  void Stop();
  /**
   * Ask the capture thread to move to a named desktop. Windows switches
   * desktops when a session locks or a user signs in, and a locked session
   * refuses screen reads from the user's own desktop, so capture and input can
   * legitimately sit on different ones. Applied on the capture thread so no
   * lock is held across the switch; an empty name means the input desktop.
   */
  void RequestDesktopRebind(const std::wstring& desktop_name);

  /**
   * The desktop this source is actually reading, empty until the first bind
   * succeeds. The caller must never assume a requested rebind took effect: a
   * desktop switch can refuse the open for as long as Windows is mid-flight,
   * and a source left on the desktop it was already on captures nothing.
   */
  std::wstring BoundDesktop() const;
  // A headless console placeholder can enumerate successfully while DXGI
  // waits forever for its first presented frame. Keep that state out of the
  // WebRTC session with one bounded admission wait.
  bool WaitForFirstFrame(std::chrono::milliseconds timeout);
  const DisplayInfo& display() const { return display_; }
  uint64_t captured_frames() const { return captured_frames_.load(); }
  uint64_t dropped_frames() const { return dropped_frames_.load(); }
  uint64_t dirty_regions() const { return dirty_regions_.load(); }
  uint64_t move_regions() const { return move_regions_.load(); }
  uint64_t pointer_updates() const { return pointer_updates_.load(); }
  uint64_t gdi_attempts() const { return gdi_attempts_.load(); }
  DWORD gdi_last_error() const { return gdi_last_error_.load(); }
  bool protected_content_masked() const {
    return protected_content_masked_.load();
  }

  bool is_screencast() const override { return true; }

 protected:
  DxgiDesktopSource(DisplayInfo display, CaptureFallback fallback);
  ~DxgiDesktopSource() override;
  webrtc::VideoSourceInterface<webrtc::VideoFrame>* source() override {
    return &broadcaster_;
  }

 private:
  bool InitializeDuplication();
  void ResetDuplication();
  void CaptureLoop();
  bool CaptureOne();
  bool CaptureDesktopGdi();
  bool BindCaptureThreadToRequestedDesktop();
  bool BroadcastBgraFrame(int width, int height);
  void BroadcastFrame(
      const webrtc::scoped_refptr<webrtc::I420Buffer>& frame);
  bool ConsumeFrameMetadata(const DXGI_OUTDUPL_FRAME_INFO& frame_info);
  bool EnsureCursorSurface(int width, int height);
  void CompositeCursor(uint8_t* bgra, int stride, int width, int height);
  void CompositeDxgiCursor(uint8_t* bgra, int stride, int width, int height);

  const DisplayInfo display_;
  const CaptureFallback fallback_;
  webrtc::VideoBroadcaster broadcaster_;
  std::mutex state_mutex_;
  std::atomic<bool> running_{false};
  std::thread capture_thread_;
  std::mutex first_frame_mutex_;
  std::condition_variable first_frame_condition_;
  std::atomic<uint64_t> captured_frames_{0};
  std::atomic<uint64_t> dropped_frames_{0};
  std::atomic<uint64_t> dirty_regions_{0};
  std::atomic<uint64_t> move_regions_{0};
  std::atomic<uint64_t> pointer_updates_{0};
  std::atomic<bool> desktop_rebind_requested_{true};
  mutable std::mutex desktop_request_mutex_;
  std::wstring requested_desktop_;
  std::wstring bound_desktop_name_;
  HDESK bound_desktop_ = nullptr;
  std::atomic<uint64_t> gdi_attempts_{0};
  std::atomic<DWORD> gdi_last_error_{ERROR_SUCCESS};
  std::atomic<bool> protected_content_masked_{false};
  int consecutive_failures_ = 0;
  int first_frame_waits_ = 0;
  int gdi_dxgi_retry_ticks_ = 0;
  bool gdi_active_ = false;
  bool last_capture_waited_ = false;

  Microsoft::WRL::ComPtr<ID3D11Device> device_;
  Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
  Microsoft::WRL::ComPtr<IDXGIOutputDuplication> duplication_;
  Microsoft::WRL::ComPtr<ID3D11Texture2D> staging_;
  UINT surface_width_ = 0;
  UINT surface_height_ = 0;
  std::vector<uint8_t> frame_metadata_;
  std::vector<uint8_t> pointer_shape_;
  DXGI_OUTDUPL_POINTER_SHAPE_INFO pointer_shape_info_{};
  POINT pointer_position_{};
  bool pointer_shape_valid_ = false;
  bool pointer_position_known_ = false;
  bool pointer_visible_ = false;
  webrtc::scoped_refptr<webrtc::I420Buffer> last_frame_;
  int64_t last_broadcast_us_ = 0;

  HDC cursor_dc_ = nullptr;
  HBITMAP cursor_bitmap_ = nullptr;
  HGDIOBJ cursor_old_bitmap_ = nullptr;
  uint8_t* cursor_bits_ = nullptr;
  int cursor_width_ = 0;
  int cursor_height_ = 0;
};

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_DISPLAY_CAPTURE_H_
