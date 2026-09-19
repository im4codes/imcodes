#include "third_party/imcodes_remote_desktop/windows_platform_adapters.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <thread>
#include <utility>

#include "third_party/imcodes_remote_desktop/display_preferences.h"
#include "third_party/imcodes_remote_desktop/json_protocol.h"
#include "third_party/imcodes_remote_desktop/worker_policy.h"

namespace imcodes::rd {
namespace {

class WindowsDxgiCaptureSourceLease final
    : public common::NativeVideoSourceLease {
 public:
  WindowsDxgiCaptureSourceLease(
      webrtc::scoped_refptr<DxgiDesktopSource> source,
      WindowsReleaseCaptureTrack release)
      : source_(std::move(source)),
        release_(std::move(release)),
        display_(source_ ? source_->display() : DisplayInfo{}),
        source_identity_(source_ ? DisplaySourceKey(display_) : std::string{}) {}

  ~WindowsDxgiCaptureSourceLease() override {
    if (!source_) return;
    source_ = nullptr;
    if (release_) release_(display_);
  }

  bool Start() override {
    if (!source_) return false;
    source_->Start();
    return true;
  }

  bool WaitForFirstFrame(std::chrono::milliseconds timeout) override {
    return source_ && source_->WaitForFirstFrame(timeout);
  }

  webrtc::VideoTrackSourceInterface *source() const noexcept override {
    return source_.get();
  }

  std::string_view display_id() const noexcept override {
    return display_.id;
  }

  std::string_view source_identity() const noexcept override {
    return source_identity_;
  }

  common::PixelSize encoded_pixels() const noexcept override {
    return WindowsEncodedPixels(display_);
  }

  std::uint64_t captured_frames() const noexcept override {
    return source_ ? source_->captured_frames() : 0;
  }

  std::uint64_t dropped_frames() const noexcept override {
    return source_ ? source_->dropped_frames() : 0;
  }

  bool protected_content_masked() const noexcept override {
    return source_ && source_->protected_content_masked();
  }

 private:
  webrtc::scoped_refptr<DxgiDesktopSource> source_;
  WindowsReleaseCaptureTrack release_;
  DisplayInfo display_;
  std::string source_identity_;
};

common::DisplayRotation ToCommonRotation(int degrees) noexcept {
  switch (degrees) {
    case 90:
      return common::DisplayRotation::k90;
    case 180:
      return common::DisplayRotation::k180;
    case 270:
      return common::DisplayRotation::k270;
    default:
      return common::DisplayRotation::k0;
  }
}

std::optional<std::u16string> Utf8ToUtf16(std::string_view value) {
  static_assert(sizeof(wchar_t) == sizeof(char16_t));
  if (value.empty() || value.size() > kMaxClipboardTextBytes ||
      value.size() >
          static_cast<std::size_t>(std::numeric_limits<int>::max())) {
    return std::nullopt;
  }
  const int bytes = static_cast<int>(value.size());
  const int units = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                        value.data(), bytes, nullptr, 0);
  if (units <= 0) return std::nullopt;
  std::u16string result(static_cast<std::size_t>(units), u'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), bytes,
                          reinterpret_cast<wchar_t *>(result.data()),
                          units) != units) {
    return std::nullopt;
  }
  return result;
}

std::optional<std::string> Utf16ToUtf8(const std::u16string &value) {
  static_assert(sizeof(wchar_t) == sizeof(char16_t));
  if (value.empty() || value.size() > 4096 ||
      value.size() >
          static_cast<std::size_t>(std::numeric_limits<int>::max())) {
    return std::nullopt;
  }
  const int units = static_cast<int>(value.size());
  const auto *wide = reinterpret_cast<const wchar_t *>(value.data());
  const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide,
                                        units, nullptr, 0, nullptr, nullptr);
  if (bytes <= 0 || bytes > static_cast<int>(kMaxClipboardTextBytes)) {
    return std::nullopt;
  }
  std::string result(static_cast<std::size_t>(bytes), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, units,
                          result.data(), bytes, nullptr, nullptr) != bytes) {
    return std::nullopt;
  }
  return result;
}

}  // namespace

WindowsDxgiCaptureTrackAdapter::WindowsDxgiCaptureTrackAdapter(
    WindowsAcquireCaptureTrack acquire, WindowsReleaseCaptureTrack release)
    : acquire_(std::move(acquire)), release_(std::move(release)) {}

common::ReadinessState WindowsDxgiCaptureTrackAdapter::ProbeReadiness() {
  return acquire_ && release_ ? common::ReadinessState::kReady
                              : common::ReadinessState::kUnavailable;
}

std::unique_ptr<common::NativeVideoSourceLease>
WindowsDxgiCaptureTrackAdapter::Acquire(
    const common::DisplayTopology &display) {
  if (ProbeReadiness() != common::ReadinessState::kReady ||
      !display.IsValid() || !display.operations.selectable) {
    return nullptr;
  }
  auto source = acquire_(display);
  if (!source || source->display().id != display.display_id ||
      WindowsEncodedPixels(source->display()).width !=
          display.encoded_pixels.width ||
      WindowsEncodedPixels(source->display()).height !=
          display.encoded_pixels.height) {
    if (source && release_) release_(source->display());
    return nullptr;
  }
  return std::make_unique<WindowsDxgiCaptureSourceLease>(std::move(source),
                                                         release_);
}

WindowsWebRtcEncoderFactoryAdapter::WindowsWebRtcEncoderFactoryAdapter(
    std::unique_ptr<webrtc::VideoEncoderFactory> factory) noexcept
    : factory_(std::move(factory)) {}

common::ReadinessState WindowsWebRtcEncoderFactoryAdapter::ProbeReadiness() {
  if (factory_ == nullptr) return common::ReadinessState::kUnavailable;
  const auto formats = factory_->GetSupportedFormats();
  const bool h264 = std::any_of(
      formats.begin(), formats.end(), [](const webrtc::SdpVideoFormat &format) {
        return _stricmp(format.name.c_str(), "H264") == 0;
      });
  return h264 ? common::ReadinessState::kReady
              : common::ReadinessState::kUnavailable;
}

std::unique_ptr<webrtc::VideoEncoderFactory>
WindowsWebRtcEncoderFactoryAdapter::TakeFactory() {
  if (ProbeReadiness() != common::ReadinessState::kReady) return nullptr;
  return std::move(factory_);
}

std::optional<common::GraphicalSessionEvent> ToCommonGraphicalSessionEvent(
    std::uint32_t event_mask) noexcept {
  switch (event_mask) {
    case kEnvironmentSuspend:
      return common::GraphicalSessionEvent::kSleeping;
    case kEnvironmentResume:
      return common::GraphicalSessionEvent::kWoke;
    case kEnvironmentSessionLocked:
      return common::GraphicalSessionEvent::kLocked;
    case kEnvironmentSessionUnlocked:
      return common::GraphicalSessionEvent::kUnlocked;
    case kEnvironmentSessionUnavailable:
      // LocalIndicator deliberately coalesces logoff and disconnect because
      // Windows follows the replacement desktop in-place. Preserve that
      // non-terminal behavior as a user/session transition.
      return common::GraphicalSessionEvent::kUserChanged;
    case kEnvironmentSessionAvailable:
      return common::GraphicalSessionEvent::kReady;
    default:
      return std::nullopt;
  }
}

std::uint32_t WindowsEnvironmentMask(
    common::GraphicalSessionEvent event) noexcept {
  switch (event) {
    case common::GraphicalSessionEvent::kReady:
      return kEnvironmentSessionAvailable;
    case common::GraphicalSessionEvent::kLocked:
      return kEnvironmentSessionLocked;
    case common::GraphicalSessionEvent::kUnlocked:
      return kEnvironmentSessionUnlocked;
    case common::GraphicalSessionEvent::kUserChanged:
    case common::GraphicalSessionEvent::kEnded:
      return kEnvironmentSessionUnavailable;
    case common::GraphicalSessionEvent::kSleeping:
      return kEnvironmentSuspend;
    case common::GraphicalSessionEvent::kWoke:
      return kEnvironmentResume;
  }
  return 0;
}

common::PixelSize WindowsEncodedPixels(const DisplayInfo &display) noexcept {
  if (display.width <= 0 || display.height <= 0) return {};
  return {static_cast<std::uint32_t>(display.width),
          static_cast<std::uint32_t>(display.height)};
}

common::LogicalRect WindowsLogicalInputBounds(
    const DisplayInfo &display) noexcept {
  return {
      static_cast<double>(display.desktop_rect.left),
      static_cast<double>(display.desktop_rect.top),
      static_cast<double>(display.desktop_rect.right -
                          display.desktop_rect.left),
      static_cast<double>(display.desktop_rect.bottom -
                          display.desktop_rect.top),
  };
}

common::DisplayTopology ToCommonDisplayTopology(
    const DisplayInfo &display, common::WorkerGeneration generation) noexcept {
  return {
      display.id,
      generation,
      WindowsEncodedPixels(display),
      WindowsLogicalInputBounds(display),
      display.dpi_scale,
      ToCommonRotation(display.rotation_degrees),
      common::DisplayOperations{
          .selectable = display.available,
          .set_mode = display.available && !display.device_name.empty(),
          .set_scale = display.available && !display.device_name.empty(),
      },
  };
}

std::optional<common::DesktopTopology> ToCommonDesktopTopology(
    const std::vector<DisplayInfo> &displays,
    common::WorkerGeneration generation, common::TopologyRevision revision) {
  common::DesktopTopology topology{generation, revision, {}};
  topology.displays.reserve(displays.size());
  for (const DisplayInfo &display : displays) {
    topology.displays.push_back(ToCommonDisplayTopology(display, generation));
  }
  return topology.IsValid()
             ? std::optional<common::DesktopTopology>(std::move(topology))
             : std::nullopt;
}

WindowsDisplayAdapter::WindowsDisplayAdapter(WindowsDisplayList displays)
    : displays_(std::move(displays)) {}

void WindowsDisplayAdapter::SetTopologyVersion(
    common::WorkerGeneration generation,
    common::TopologyRevision revision) noexcept {
  generation_ = generation == 0 ? 1 : generation;
  revision_ = revision == 0 ? 1 : revision;
}

common::ReadinessState WindowsDisplayAdapter::ProbeReadiness() {
  return displays_ && !displays_().empty()
             ? common::ReadinessState::kReady
             : common::ReadinessState::kUnavailable;
}

std::optional<common::DesktopTopology>
WindowsDisplayAdapter::EnumerateTopology() {
  if (!displays_) return std::nullopt;
  return ToCommonDesktopTopology(displays_(), generation_, revision_);
}

const DisplayInfo *WindowsDisplayAdapter::Find(
    std::string_view display_id) const noexcept {
  if (!displays_) return nullptr;
  const auto &values = displays_();
  const auto found = std::find_if(
      values.begin(), values.end(),
      [&](const DisplayInfo &display) { return display.id == display_id; });
  return found == values.end() ? nullptr : &*found;
}

bool WindowsDisplayAdapter::SelectDisplay(std::string_view display_id) {
  const DisplayInfo *display = Find(display_id);
  return display != nullptr && display->available;
}

bool WindowsDisplayAdapter::SetMode(std::string_view display_id,
                                    common::PixelSize pixels) {
  const DisplayInfo *display = Find(display_id);
  if (display == nullptr || display->device_name.empty() ||
      !IsAllowedRemoteDisplayMode(static_cast<int>(pixels.width),
                                  static_cast<int>(pixels.height))) {
    return false;
  }
  DEVMODEW mode{};
  mode.dmSize = sizeof(mode);
  if (!EnumDisplaySettingsExW(display->device_name.c_str(),
                              ENUM_CURRENT_SETTINGS, &mode, EDS_RAWMODE)) {
    return false;
  }
  mode.dmPelsWidth = pixels.width;
  mode.dmPelsHeight = pixels.height;
  mode.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
  if (ChangeDisplaySettingsExW(display->device_name.c_str(), &mode, nullptr,
                               CDS_TEST, nullptr) != DISP_CHANGE_SUCCESSFUL ||
      ChangeDisplaySettingsExW(display->device_name.c_str(), &mode, nullptr,
                               CDS_UPDATEREGISTRY,
                               nullptr) != DISP_CHANGE_SUCCESSFUL) {
    return false;
  }
  if (display->imcodes_virtual) {
    SaveVirtualDisplayPreferences(
        {static_cast<int>(pixels.width), static_cast<int>(pixels.height),
         RecommendedRemoteDisplayScale(static_cast<int>(pixels.width),
                                       static_cast<int>(pixels.height))});
  }
  return true;
}

bool WindowsDisplayAdapter::SetScale(std::string_view display_id,
                                     double scale) {
  if (!std::isfinite(scale)) return false;
  const int percent = static_cast<int>(std::lround(scale * 100.0));
  const DisplayInfo *display = Find(display_id);
  if (display == nullptr || display->device_name.empty() ||
      !IsAllowedRemoteDisplayScale(percent) ||
      !SetDisplayDpiScale(*display, percent)) {
    return false;
  }
  if (display->imcodes_virtual) {
    SaveVirtualDisplayPreferences({display->width, display->height, percent});
  }
  return true;
}

WindowsClipboardAdapter::WindowsClipboardAdapter(
    InputArbiter &input, WindowsClipboardSequence sequence,
    WindowsReadClipboardText read_text, std::string controller_id)
    : input_(input),
      sequence_(std::move(sequence)),
      read_text_(std::move(read_text)),
      controller_id_(std::move(controller_id)) {}

common::ReadinessState WindowsClipboardAdapter::ProbeReadiness() {
  return input_.Available() && sequence_ && read_text_
             ? common::ReadinessState::kReady
             : common::ReadinessState::kUnavailable;
}

bool WindowsClipboardAdapter::PasteText(std::string_view text) {
  const auto decoded = Utf8ToUtf16(text);
  return decoded && input_.Text(*decoded);
}

bool WindowsClipboardAdapter::CopySelection(std::string *text) {
  if (text == nullptr || ProbeReadiness() != common::ReadinessState::kReady) {
    return false;
  }
  text->clear();
  const DWORD previous_sequence = sequence_();
  if (!input_.CopyShortcut(controller_id_)) return false;
  for (int attempt = 0; attempt < 6; ++attempt) {
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    const auto value = read_text_(previous_sequence);
    if (!value) continue;
    const auto encoded = Utf16ToUtf8(*value);
    if (!encoded) return false;
    *text = *encoded;
    return true;
  }
  return false;
}

WindowsDisclosureSessionAdapter::WindowsDisclosureSessionAdapter(
    WindowsIndicatorStart start, WindowsIndicatorShow show,
    WindowsIndicatorAction hide, WindowsIndicatorAction stop,
    WindowsEnvironmentSink residual_environment)
    : start_(std::move(start)),
      show_(std::move(show)),
      hide_(std::move(hide)),
      stop_(std::move(stop)),
      residual_environment_(std::move(residual_environment)) {}

WindowsDisclosureSessionAdapter::~WindowsDisclosureSessionAdapter() { Stop(); }

common::ReadinessState WindowsDisclosureSessionAdapter::ProbeReadiness() {
  if (!start_ || !show_ || !hide_ || !stop_) {
    return common::ReadinessState::kUnavailable;
  }
  return started_ ? common::ReadinessState::kReady
                  : common::ReadinessState::kUnknown;
}

bool WindowsDisclosureSessionAdapter::Show(std::uint32_t viewers,
                                           std::uint32_t controllers) {
  if (!started_ || viewers == 0 || controllers > viewers || !show_) {
    return false;
  }
  return show_(viewers, controllers);
}

void WindowsDisclosureSessionAdapter::Hide() noexcept {
  if (started_ && hide_) hide_();
}

bool WindowsDisclosureSessionAdapter::Start(Observer observer) {
  if (started_) return true;
  if (!observer || !start_ || !show_ || !hide_ || !stop_) return false;
  // LocalIndicator may own a joinable thread even when Start reports that its
  // window initialization failed. Dispose that failed attempt before retrying
  // so a later desktop transition can make a fresh bounded start.
  if (start_attempted_) Stop();
  observer_ = std::move(observer);
  start_attempted_ = true;
  started_ = start_([this](std::uint32_t event_mask) {
    const auto event = ToCommonGraphicalSessionEvent(event_mask);
    if (event) {
      if (observer_) observer_(*event);
      return;
    }
    if (residual_environment_) residual_environment_(event_mask);
  });
  // LocalIndicator::Start can report a failed window initialization while its
  // std::thread remains joinable.  Do not leave that failed event producer
  // alive until a later retry/destructor: synchronously join it before this
  // failed Start returns, then drop the observer it captured.
  if (!started_) Stop();
  return started_;
}

void WindowsDisclosureSessionAdapter::Stop() noexcept {
  if (!start_attempted_) return;
  start_attempted_ = false;
  started_ = false;
  if (stop_) stop_();
  observer_ = {};
}

}  // namespace imcodes::rd
