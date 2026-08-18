#include "third_party/imcodes_remote_desktop/display_capture.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cwchar>
#include <iomanip>
#include <iterator>
#include <sstream>
#include <string>
#include <thread>

#include "test/gtest.h"

namespace imcodes::rd {
namespace {

bool InventoryEnabled() {
  wchar_t value[8] = {};
  const DWORD length = GetEnvironmentVariableW(
      L"IMCODES_RUN_DISPLAY_INVENTORY", value, std::size(value));
  return (length > 0 && length < std::size(value) && value[0] == L'1') ||
         std::wcsstr(GetCommandLineW(), L"--imcodes-display-inventory") !=
             nullptr;
}

bool CaptureLivenessEnabled() {
  wchar_t value[8] = {};
  const DWORD length = GetEnvironmentVariableW(
      L"IMCODES_RUN_DISPLAY_CAPTURE_LIVENESS", value, std::size(value));
  return length > 0 && length < std::size(value) && value[0] == L'1';
}

bool SecureConsoleEnabled() {
  wchar_t value[8] = {};
  const DWORD length = GetEnvironmentVariableW(
      L"IMCODES_RUN_SECURE_CONSOLE_CAPTURE", value, std::size(value));
  return (length > 0 && length < std::size(value) && value[0] == L'1') ||
         std::wcsstr(GetCommandLineW(), L"--secure-console") != nullptr;
}

bool RequireImcodesVirtualDisplay() {
  wchar_t value[8] = {};
  const DWORD length = GetEnvironmentVariableW(
      L"IMCODES_TEST_IMCODES_VIRTUAL_DISPLAY", value, std::size(value));
  return length > 0 && length < std::size(value) && value[0] == L'1';
}

class MetadataOnlyFrameSink final
    : public webrtc::VideoSinkInterface<webrtc::VideoFrame> {
 public:
  void OnFrame(const webrtc::VideoFrame& frame) override {
    width_ = frame.width();
    height_ = frame.height();
    frames_++;
  }

  uint64_t frames() const { return frames_.load(); }
  int width() const { return width_.load(); }
  int height() const { return height_.load(); }

 private:
  std::atomic<uint64_t> frames_{0};
  std::atomic<int> width_{0};
  std::atomic<int> height_{0};
};

std::string UserObjectName(HANDLE object) {
  wchar_t value[256] = {};
  DWORD required = 0;
  if (!object || !GetUserObjectInformationW(object, UOI_NAME, value,
                                             sizeof(value), &required)) {
    return "unavailable";
  }
  std::string result;
  for (const wchar_t character : value) {
    if (character == L'\0') break;
    result.push_back(character <= 0x7f ? static_cast<char>(character) : '?');
  }
  return result.empty() ? "unavailable" : result;
}

class BoundedDesktopStimulus final {
 public:
  explicit BoundedDesktopStimulus(const RECT& bounds)
      : origin_x_(bounds.left + 8), origin_y_(bounds.top + 8) {
    window_ = CreateWindowExW(
        WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE, L"STATIC", L"",
        WS_POPUP | WS_VISIBLE, origin_x_, origin_y_, 48, 48, nullptr, nullptr,
        GetModuleHandleW(nullptr), nullptr);
    if (window_) {
      ShowWindow(window_, SW_SHOWNOACTIVATE);
      UpdateWindow(window_);
    }
  }

  ~BoundedDesktopStimulus() {
    if (window_) DestroyWindow(window_);
  }

  bool created() const { return window_ != nullptr; }

  void Move(int offset) {
    if (!window_) return;
    SetWindowPos(window_, HWND_TOPMOST, origin_x_ + offset, origin_y_, 48, 48,
                 SWP_NOACTIVATE | SWP_SHOWWINDOW);
    RedrawWindow(window_, nullptr, nullptr,
                 RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN);
    GdiFlush();
  }

 private:
  HWND window_ = nullptr;
  int origin_x_ = 0;
  int origin_y_ = 0;
};

TEST(DisplayCaptureTest, ReportsSanitizedInteractiveTopology) {
  if (!InventoryEnabled()) {
    GTEST_SKIP() << "set IMCODES_RUN_DISPLAY_INVENTORY=1 in the active session";
  }
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  const std::vector<DisplayInfo> displays = EnumerateDisplays();
  RecordProperty("display_count", static_cast<int>(displays.size()));
  RecordProperty("topology_state",
                 displays.empty() ? "unavailable" : "available");
  for (size_t index = 0; index < displays.size(); ++index) {
    const DisplayInfo& display = displays[index];
    std::ostringstream value;
    value << "bounds=" << display.desktop_rect.left << ','
          << display.desktop_rect.top << ',' << display.desktop_rect.right
          << ',' << display.desktop_rect.bottom << ";physical="
          << display.width << 'x' << display.height << ";rotation="
          << display.rotation_degrees << ";dpiScale=" << std::fixed
          << std::setprecision(2) << display.dpi_scale << ";primary="
          << (display.primary ? "true" : "false");
    RecordProperty("display_" + std::to_string(index), value.str());
  }
}

TEST(DisplayCaptureTest, ProducesFramesWithoutPersistingPixels) {
  if (!CaptureLivenessEnabled()) {
    GTEST_SKIP() << "set IMCODES_RUN_DISPLAY_CAPTURE_LIVENESS=1 in the active session";
  }
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  const std::vector<DisplayInfo> displays = EnumerateDisplays();
  ASSERT_FALSE(displays.empty());
  auto selected = displays.begin();
  if (RequireImcodesVirtualDisplay()) {
    selected = std::find_if(displays.begin(), displays.end(),
                            [](const DisplayInfo& display) {
                              return display.imcodes_virtual;
                            });
    ASSERT_NE(selected, displays.end());
  }
  RecordProperty("selected_imcodes_virtual", selected->imcodes_virtual);
  auto source = DxgiDesktopSource::Create(
      *selected, SecureConsoleEnabled() ? CaptureFallback::kSecureDesktopGdi
                                       : CaptureFallback::kNone);
  ASSERT_TRUE(source);
  MetadataOnlyFrameSink sink;
  source->AddOrUpdateSink(&sink, webrtc::VideoSinkWants());
  source->Start();
  DWORD session_id = 0;
  ProcessIdToSessionId(GetCurrentProcessId(), &session_id);
  RecordProperty("process_session_id", static_cast<int>(session_id));
  RecordProperty("window_station", UserObjectName(GetProcessWindowStation()));
  RecordProperty("thread_desktop",
                 UserObjectName(GetThreadDesktop(GetCurrentThreadId())));
  RecordProperty("remote_session", GetSystemMetrics(SM_REMOTESESSION) != 0);

  // Desktop Duplication is change-driven and need not return an initial frame
  // on a perfectly static desktop. Create and move one small, non-activating
  // test-only window on this process's desktop. This is bounded and reversible,
  // and the test still never inspects or persists frame contents.
  std::this_thread::sleep_for(std::chrono::milliseconds(750));
  BoundedDesktopStimulus stimulus(selected->desktop_rect);
  RecordProperty("stimulus_created", stimulus.created());
  for (int offset = 0; offset < 48 && sink.frames() == 0; offset += 4) {
    stimulus.Move(offset);
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  const auto deadline = std::chrono::steady_clock::now() +
                        std::chrono::seconds(10);
  while (sink.frames() == 0 && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  source->Stop();
  source->RemoveSink(&sink);
  RecordProperty("frames_observed", static_cast<int>(sink.frames()));
  RecordProperty("frame_width", sink.width());
  RecordProperty("frame_height", sink.height());
  RecordProperty("capture_failures",
                 static_cast<int>(source->dropped_frames()));
  RecordProperty("secure_gdi_attempts",
                 static_cast<int>(source->secure_gdi_attempts()));
  RecordProperty("secure_gdi_last_error",
                 static_cast<int>(source->secure_gdi_last_error()));
  EXPECT_GT(sink.frames(), 0u);
  EXPECT_EQ(sink.width(), selected->width);
  EXPECT_EQ(sink.height(), selected->height);
}

}  // namespace
}  // namespace imcodes::rd
