#ifndef IMCODES_REMOTE_DESKTOP_COMMON_PLATFORM_INTERFACES_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_PLATFORM_INTERFACES_H_

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "value_types.h"

namespace webrtc {
class VideoEncoderFactory;
class VideoTrackSourceInterface;
}  // namespace webrtc

namespace imcodes::remote_desktop::common {

// Must match shared/remote-desktop-local-management.ts. The local panel is
// loopback-only; platform indicators only launch it and never carry authority.
inline constexpr char kLocalManagementUrl[] = "http://127.0.0.1:43751/";
inline constexpr char kLocalManagementStateUrl[] =
    "http://127.0.0.1:43751/api/state";

using CapturedFrameSink = std::function<void(CapturedFrame)>;
using H264AccessUnitSink = std::function<void(H264AccessUnit)>;

class CaptureAdapter {
 public:
  virtual ~CaptureAdapter() = default;
  [[nodiscard]] virtual ReadinessState ProbeReadiness() = 0;
  virtual bool Start(const DisplayTopology& display,
                     CapturedFrameSink sink) = 0;
  virtual void Stop() noexcept = 0;

  // Capture at the output size instead of the display's native size.
  //
  // A capture API that can scale in the compositor/GPU hands over frames that
  // are already the size the encoder will use, so the worker does not copy and
  // resample a native-size frame on the CPU for every frame it sends. That
  // matters on a 5K display: a native BGRA frame is ~52 MB.
  //
  // The defaults say "not supported": the capture then always delivers the
  // display's native size, exactly as before, and nothing below applies.
  [[nodiscard]] virtual bool SupportsOutputSize() const noexcept {
    return false;
  }
  // Asks the capture to deliver frames of `size` from now on. Never blocks on
  // the capture API: the switch happens in the background, and OutputSize()
  // changes when frames of the new size are actually flowing. Returns false
  // when the capture cannot do it (unsupported, or not running).
  virtual bool SetOutputSize(PixelSize size) {
    (void)size;
    return false;
  }
  // The size frames are delivered at right now; empty = the display's native
  // size. Cheap and lock-free: it is read on the per-frame path.
  [[nodiscard]] virtual std::optional<PixelSize> OutputSize() const noexcept {
    return std::nullopt;
  }
};

struct EncoderConfiguration {
  PixelSize encoded_pixels;
  std::uint32_t frame_rate = 0;
  std::uint32_t bitrate_bps = 0;
  H264Profile profile = H264Profile::kConstrainedBaseline;
  // Favour a current picture over a smooth one. The encoder keeps one frame in
  // flight and drops whatever arrives while it is busy (so it always works on
  // the newest frame instead of a queue), and a measured encode time that is
  // too slow for that to keep latency low steps the output size down (see
  // encode_speed_governor.h). Off by default: every existing path keeps its
  // behaviour.
  bool latency_first = false;
};

// What the encoder in use really is. kUnknown until one has been configured (or
// when an adapter does not say); callers must not read it as hardware.
enum class EncoderClass : std::uint8_t {
  kUnknown,
  kHardware,
  kSoftware,
};

class EncoderAdapter {
 public:
  virtual ~EncoderAdapter() = default;
  [[nodiscard]] virtual ReadinessState ProbeReadiness() = 0;
  virtual bool Configure(const EncoderConfiguration& configuration,
                         H264AccessUnitSink sink) = 0;
  virtual bool Encode(CapturedFrame frame, bool request_keyframe) = 0;
  virtual void Stop() noexcept = 0;

  // Telemetry for the viewer's quality report. The defaults are "don't know" and
  // "none dropped", so an adapter that does not implement them changes nothing.
  [[nodiscard]] virtual EncoderClass ImplementationClass() const noexcept {
    return EncoderClass::kUnknown;
  }
  // Frames the encoder dropped instead of encoding (it was busy with a newer or
  // older one), since it was configured.
  [[nodiscard]] virtual std::uint64_t DroppedFrames() const noexcept {
    return 0;
  }
};

// There are two lossless media delivery models behind the common platform
// boundary. macOS captures a platform frame and submits encoded H.264 access
// units through CaptureAdapter/EncoderAdapter. Windows already exposes a
// pooled VideoTrackSource to the pinned libwebrtc stack and installs its Media
// Foundation codec through VideoEncoderFactory. Converting that source to a
// CPU-addressable CapturedFrame, or pulling encoded bytes back out of
// libwebrtc, would add a readback/copy and create a second transport path.
//
// These interfaces describe that second delivery model using only upstream
// libwebrtc types. They deliberately contain no OS handle and require a typed
// RAII lease, so a platform implementation can retain source-pool ownership
// without callers downcasting the source or learning its native descriptor.
class NativeVideoSourceLease {
 public:
  virtual ~NativeVideoSourceLease() = default;
  [[nodiscard]] virtual bool Start() = 0;
  [[nodiscard]] virtual bool WaitForFirstFrame(
      std::chrono::milliseconds timeout) = 0;
  [[nodiscard]] virtual webrtc::VideoTrackSourceInterface* source()
      const noexcept = 0;
  [[nodiscard]] virtual std::string_view display_id() const noexcept = 0;
  [[nodiscard]] virtual std::string_view source_identity() const noexcept = 0;
  [[nodiscard]] virtual PixelSize encoded_pixels() const noexcept = 0;
  [[nodiscard]] virtual std::uint64_t captured_frames() const noexcept = 0;
  [[nodiscard]] virtual std::uint64_t dropped_frames() const noexcept = 0;
  [[nodiscard]] virtual bool protected_content_masked() const noexcept = 0;
};

class NativeCaptureAdapter {
 public:
  virtual ~NativeCaptureAdapter() = default;
  [[nodiscard]] virtual ReadinessState ProbeReadiness() = 0;
  [[nodiscard]] virtual std::unique_ptr<NativeVideoSourceLease> Acquire(
      const DisplayTopology& display) = 0;
};

class NativeEncoderFactoryAdapter {
 public:
  virtual ~NativeEncoderFactoryAdapter() = default;
  [[nodiscard]] virtual ReadinessState ProbeReadiness() = 0;
  // Ownership moves exactly once into the pinned PeerConnection factory.
  // Returning nullptr after transfer prevents an adapter from accidentally
  // installing the same platform encoder into a second WebRTC stack.
  [[nodiscard]] virtual std::unique_ptr<webrtc::VideoEncoderFactory>
  TakeFactory() = 0;
};

class InputAdapter {
 public:
  virtual ~InputAdapter() = default;
  [[nodiscard]] virtual ReadinessState ProbeReadiness() = 0;
  virtual bool MovePointer(const LogicalPoint& point) = 0;
  virtual bool EmitKey(std::string_view key, bool pressed) = 0;
  virtual bool EmitButton(std::string_view button, bool pressed) = 0;
  virtual bool EmitWheel(double delta_x, double delta_y) = 0;
  virtual bool EmitText(std::string_view text) = 0;
  virtual void ReleaseAllEmittedState() noexcept = 0;
  // Run when a session is about to start: release the modifier keys the
  // platform still reports as held that this adapter never emitted, and
  // return how many were released. See latched_modifiers.h for why a session
  // has to start on a clean keyboard. An adapter that cannot read the
  // platform's keyboard state releases nothing.
  virtual std::size_t ReleaseLatchedModifiers() noexcept { return 0; }
};

class ClipboardAdapter {
 public:
  virtual ~ClipboardAdapter() = default;
  [[nodiscard]] virtual ReadinessState ProbeReadiness() = 0;
  virtual bool PasteText(std::string_view text) = 0;
  virtual bool CopySelection(std::string* text) = 0;
};

class DisplayAdapter {
 public:
  virtual ~DisplayAdapter() = default;
  [[nodiscard]] virtual ReadinessState ProbeReadiness() = 0;
  virtual std::optional<DesktopTopology> EnumerateTopology() = 0;
  virtual bool SelectDisplay(std::string_view display_id) = 0;
  virtual bool SetMode(std::string_view display_id, PixelSize pixels) = 0;
  virtual bool SetScale(std::string_view display_id, double scale) = 0;
};

class DisclosureAdapter {
 public:
  virtual ~DisclosureAdapter() = default;
  [[nodiscard]] virtual ReadinessState ProbeReadiness() = 0;
  virtual bool Show(std::uint32_t viewers, std::uint32_t controllers) = 0;
  virtual void Hide() noexcept = 0;
};

enum class GraphicalSessionEvent : std::uint8_t {
  kReady,
  kLocked,
  kUnlocked,
  kUserChanged,
  kSleeping,
  kWoke,
  kEnded,
};

class SessionMonitor {
 public:
  using Observer = std::function<void(GraphicalSessionEvent)>;

  virtual ~SessionMonitor() = default;
  [[nodiscard]] virtual ReadinessState ProbeReadiness() = 0;
  virtual bool Start(Observer observer) = 0;
  virtual void Stop() noexcept = 0;
};

struct PlatformAdapters {
  CaptureAdapter& capture;
  EncoderAdapter& encoder;
  InputAdapter& input;
  ClipboardAdapter& clipboard;
  DisplayAdapter& display;
  DisclosureAdapter& disclosure;
  SessionMonitor& session_monitor;
};

}  // namespace imcodes::remote_desktop::common

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_PLATFORM_INTERFACES_H_
