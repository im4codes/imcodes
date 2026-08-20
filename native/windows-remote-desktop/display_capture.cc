#include "third_party/imcodes_remote_desktop/display_capture.h"

#include <d3d11.h>
#include <dxgi1_2.h>
#include <shellscalingapi.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstring>
#include <iomanip>
#include <optional>
#include <sstream>
#include <utility>

#include "api/make_ref_counted.h"
#include "api/video/i420_buffer.h"
#include "libyuv/convert.h"
#include "libyuv/rotate.h"
#include "rtc_base/logging.h"
#include "system_wrappers/include/clock.h"
#include "third_party/imcodes_remote_desktop/json_protocol.h"
#include "third_party/imcodes_remote_desktop/worker_policy.h"

namespace imcodes::rd {
namespace {

/** The name Windows gives a desktop handle, empty when it cannot be read. */
std::wstring DesktopNameOf(HDESK desktop) {
  wchar_t name[64]{};
  DWORD needed = 0;
  if (!GetUserObjectInformationW(desktop, UOI_NAME, name, sizeof(name),
                                 &needed)) {
    return {};
  }
  return name;
}

std::string Narrow(const wchar_t* value) {
  if (!value || !*value) return {};
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value,
                                       -1, nullptr, 0, nullptr, nullptr);
  if (size <= 1) return {};
  std::string result(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1,
                      result.data(), size, nullptr, nullptr);
  result.pop_back();
  return result;
}

std::string DisplayId(const LUID& luid, UINT output_index) {
  std::ostringstream id;
  id << "display_" << std::hex << std::setw(8) << std::setfill('0')
     << static_cast<uint32_t>(luid.HighPart) << std::setw(8)
     << static_cast<uint32_t>(luid.LowPart) << "_" << std::dec << output_index;
  return id.str();
}

int RotationDegrees(DXGI_MODE_ROTATION rotation) {
  switch (rotation) {
    case DXGI_MODE_ROTATION_ROTATE90:
      return 90;
    case DXGI_MODE_ROTATION_ROTATE180:
      return 180;
    case DXGI_MODE_ROTATION_ROTATE270:
      return 270;
    default:
      return 0;
  }
}

bool IsImcodesVirtualDisplay(const wchar_t* device_name) {
  for (DWORD index = 0;; ++index) {
    DISPLAY_DEVICEW device{};
    device.cb = sizeof(device);
    if (!EnumDisplayDevicesW(nullptr, index, &device, 0)) return false;
    if (lstrcmpiW(device.DeviceName, device_name) != 0) continue;
    return lstrcmpW(device.DeviceString, L"IM.codes Headless Display") == 0 &&
           lstrcmpiW(device.DeviceID, L"ImcodesVirtualDisplay") == 0;
  }
}

constexpr DISPLAYCONFIG_DEVICE_INFO_TYPE kGetSourceDpiScale =
    static_cast<DISPLAYCONFIG_DEVICE_INFO_TYPE>(-3);
constexpr DISPLAYCONFIG_DEVICE_INFO_TYPE kSetSourceDpiScale =
    static_cast<DISPLAYCONFIG_DEVICE_INFO_TYPE>(-4);

struct DisplayConfigSourceDpiScaleGet {
  DISPLAYCONFIG_DEVICE_INFO_HEADER header{};
  int32_t min_scale_relative = 0;
  int32_t current_scale_relative = 0;
  int32_t max_scale_relative = 0;
};

struct DisplayConfigSourceDpiScaleSet {
  DISPLAYCONFIG_DEVICE_INFO_HEADER header{};
  int32_t scale_relative = 0;
};

static_assert(sizeof(DisplayConfigSourceDpiScaleGet) == 32);
static_assert(sizeof(DisplayConfigSourceDpiScaleSet) == 24);

std::optional<DISPLAYCONFIG_PATH_SOURCE_INFO> FindDisplayConfigSource(
    const std::wstring& device_name) {
  for (int attempt = 0; attempt < 3; ++attempt) {
    UINT32 path_count = 0;
    UINT32 mode_count = 0;
    LONG result = GetDisplayConfigBufferSizes(
        QDC_ONLY_ACTIVE_PATHS, &path_count, &mode_count);
    if (result != ERROR_SUCCESS || path_count == 0) return std::nullopt;
    std::vector<DISPLAYCONFIG_PATH_INFO> paths(path_count);
    std::vector<DISPLAYCONFIG_MODE_INFO> modes(mode_count);
    result = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &path_count,
                                paths.data(), &mode_count, modes.data(),
                                nullptr);
    if (result == ERROR_INSUFFICIENT_BUFFER) continue;
    if (result != ERROR_SUCCESS) return std::nullopt;
    paths.resize(path_count);
    for (const auto& path : paths) {
      DISPLAYCONFIG_SOURCE_DEVICE_NAME source_name{};
      source_name.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
      source_name.header.size = sizeof(source_name);
      source_name.header.adapterId = path.sourceInfo.adapterId;
      source_name.header.id = path.sourceInfo.id;
      if (DisplayConfigGetDeviceInfo(&source_name.header) == ERROR_SUCCESS &&
          _wcsicmp(source_name.viewGdiDeviceName, device_name.c_str()) == 0) {
        return path.sourceInfo;
      }
    }
    return std::nullopt;
  }
  return std::nullopt;
}

libyuv::RotationMode LibyuvRotation(int degrees) {
  switch (degrees) {
    case 90:
      return libyuv::kRotate90;
    case 180:
      return libyuv::kRotate180;
    case 270:
      return libyuv::kRotate270;
    default:
      return libyuv::kRotate0;
  }
}

}  // namespace

/**
 * The resolutions a display's driver actually offers, deduplicated across
 * refresh rates and colour depths and ordered largest first. Bounded, because
 * a driver may enumerate hundreds of near-identical modes and the browser only
 * needs the distinct sizes an operator can pick.
 */
std::vector<DisplayMode> EnumerateDisplayModes(const std::wstring& device_name,
                                              int current_width,
                                              int current_height) {
  std::vector<DisplayMode> modes;
  if (device_name.empty()) return modes;
  DEVMODEW mode{};
  mode.dmSize = sizeof(mode);
  // Walks the whole enumeration rather than stopping at the first N: order is
  // the driver's business, so trimming happens after sorting.
  for (DWORD index = 0;
       index < kMaxEnumeratedDisplayModes &&
       EnumDisplaySettingsExW(device_name.c_str(), index, &mode, 0);
       ++index) {
    modes.push_back({static_cast<int>(mode.dmPelsWidth),
                     static_cast<int>(mode.dmPelsHeight)});
  }
  FinalizeDisplayModeList(&modes, current_width, current_height);
  return modes;
}

std::vector<DisplayInfo> EnumerateDisplays() {
  std::vector<DisplayInfo> displays;
  Microsoft::WRL::ComPtr<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return displays;
  for (UINT adapter_index = 0; displays.size() < kMaxDisplays;
       ++adapter_index) {
    Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
    if (factory->EnumAdapters1(adapter_index, &adapter) == DXGI_ERROR_NOT_FOUND)
      break;
    DXGI_ADAPTER_DESC1 adapter_desc{};
    if (FAILED(adapter->GetDesc1(&adapter_desc))) continue;
    for (UINT output_index = 0; displays.size() < kMaxDisplays;
         ++output_index) {
      Microsoft::WRL::ComPtr<IDXGIOutput> output;
      if (adapter->EnumOutputs(output_index, &output) == DXGI_ERROR_NOT_FOUND)
        break;
      DXGI_OUTPUT_DESC desc{};
      if (FAILED(output->GetDesc(&desc)) || !desc.AttachedToDesktop) continue;
      DisplayInfo info;
      info.id = DisplayId(adapter_desc.AdapterLuid, output_index);
      info.label = Narrow(desc.DeviceName);
      info.device_name = desc.DeviceName;
      info.desktop_rect = desc.DesktopCoordinates;
      info.width = desc.DesktopCoordinates.right - desc.DesktopCoordinates.left;
      info.height = desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top;
      info.rotation_degrees = RotationDegrees(desc.Rotation);
      info.primary = desc.DesktopCoordinates.left == 0 &&
                     desc.DesktopCoordinates.top == 0;
      info.imcodes_virtual = IsImcodesVirtualDisplay(desc.DeviceName);
      if (info.imcodes_virtual) info.label = "IM.codes Headless Display";
      info.adapter_luid = adapter_desc.AdapterLuid;
      info.output_index = output_index;
      UINT dpi_x = 96;
      UINT dpi_y = 96;
      if (SUCCEEDED(GetDpiForMonitor(desc.Monitor, MDT_EFFECTIVE_DPI,
                                     &dpi_x, &dpi_y))) {
        info.dpi_scale = std::clamp(static_cast<double>(dpi_x) / 96.0,
                                    0.5, 8.0);
      }
      info.modes =
          EnumerateDisplayModes(info.device_name, info.width, info.height);
      if (info.width > 0 && info.height > 0) displays.push_back(info);
    }
  }
  std::stable_sort(displays.begin(), displays.end(),
                   [](const DisplayInfo& left, const DisplayInfo& right) {
                     if (left.primary != right.primary) return left.primary;
                     if (left.desktop_rect.top != right.desktop_rect.top)
                       return left.desktop_rect.top < right.desktop_rect.top;
                     return left.desktop_rect.left < right.desktop_rect.left;
                   });
  return displays;
}

std::string DisplaySourceKey(const DisplayInfo& display) {
  std::ostringstream key;
  key << display.id << ':' << display.desktop_rect.left << ':'
      << display.desktop_rect.top << ':' << display.desktop_rect.right << ':'
      << display.desktop_rect.bottom << ':' << display.rotation_degrees;
  return key.str();
}

CursorSnapshotSource SelectCursorSnapshotSource(bool native_available,
                                                bool dxgi_available) {
  if (native_available) return CursorSnapshotSource::kNative;
  if (dxgi_available) return CursorSnapshotSource::kDxgi;
  return CursorSnapshotSource::kNone;
}

bool CursorSnapshotChanged(const CursorSnapshot& previous,
                           const CursorSnapshot& current) {
  return previous.available != current.available ||
         (current.available &&
          (previous.position.x != current.position.x ||
           previous.position.y != current.position.y ||
           previous.handle != current.handle ||
           previous.flags != current.flags));
}

namespace {

CursorSnapshot ReadCursorSnapshot() {
  CURSORINFO cursor{};
  cursor.cbSize = sizeof(cursor);
  CursorSnapshot snapshot;
  snapshot.available = GetCursorInfo(&cursor) == TRUE;
  if (snapshot.available) {
    snapshot.position = cursor.ptScreenPos;
    snapshot.handle = cursor.hCursor;
    snapshot.flags = cursor.flags;
  }
  return snapshot;
}

}  // namespace

bool SetDisplayDpiScale(const DisplayInfo& display, int percent) {
  static constexpr std::array<int, 12> kDpiScalePercents = {
      100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500};
  if (display.device_name.empty()) return false;
  const auto desired = std::find(kDpiScalePercents.begin(),
                                 kDpiScalePercents.end(), percent);
  if (desired == kDpiScalePercents.end()) return false;
  const auto source = FindDisplayConfigSource(display.device_name);
  if (!source) return false;

  DisplayConfigSourceDpiScaleGet get{};
  get.header.type = kGetSourceDpiScale;
  get.header.size = sizeof(get);
  get.header.adapterId = source->adapterId;
  get.header.id = source->id;
  if (DisplayConfigGetDeviceInfo(&get.header) != ERROR_SUCCESS ||
      get.min_scale_relative > 0 || get.max_scale_relative < 0) {
    return false;
  }
  const int recommended_index = -get.min_scale_relative;
  const int desired_index = static_cast<int>(desired - kDpiScalePercents.begin());
  const int relative = desired_index - recommended_index;
  if (recommended_index < 0 ||
      recommended_index >= static_cast<int>(kDpiScalePercents.size()) ||
      relative < get.min_scale_relative || relative > get.max_scale_relative) {
    return false;
  }

  DisplayConfigSourceDpiScaleSet set{};
  set.header.type = kSetSourceDpiScale;
  set.header.size = sizeof(set);
  set.header.adapterId = source->adapterId;
  set.header.id = source->id;
  set.scale_relative = relative;
  return DisplayConfigSetDeviceInfo(&set.header) == ERROR_SUCCESS;
}

webrtc::scoped_refptr<DxgiDesktopSource> DxgiDesktopSource::Create(
    const DisplayInfo& display,
    CaptureFallback fallback) {
  return webrtc::make_ref_counted<DxgiDesktopSource>(display, fallback);
}

DxgiDesktopSource::DxgiDesktopSource(DisplayInfo display,
                                     CaptureFallback fallback)
    : VideoTrackSource(/*remote=*/false),
      display_(std::move(display)),
      fallback_(fallback) {}

DxgiDesktopSource::~DxgiDesktopSource() {
  Stop();
  if (cursor_dc_) {
    if (cursor_old_bitmap_) SelectObject(cursor_dc_, cursor_old_bitmap_);
    if (cursor_bitmap_) DeleteObject(cursor_bitmap_);
    DeleteDC(cursor_dc_);
  }
}

void DxgiDesktopSource::Start() {
  bool expected = false;
  if (!running_.compare_exchange_strong(expected, true)) return;
  capture_thread_ = std::thread([this] { CaptureLoop(); });
}

void DxgiDesktopSource::Stop() {
  if (!running_.exchange(false)) return;
  first_frame_condition_.notify_all();
  if (capture_thread_.joinable()) capture_thread_.join();
  std::lock_guard<std::mutex> lock(state_mutex_);
  ResetDuplication();
}

bool DxgiDesktopSource::WaitForFirstFrame(
    std::chrono::milliseconds timeout) {
  if (captured_frames_.load() > 0) return true;
  std::unique_lock<std::mutex> lock(first_frame_mutex_);
  return first_frame_condition_.wait_for(lock, timeout, [this] {
    return captured_frames_.load() > 0 || !running_.load();
  }) && captured_frames_.load() > 0;
}

bool DxgiDesktopSource::InitializeDuplication() {
  ResetDuplication();
  Microsoft::WRL::ComPtr<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return false;
  Microsoft::WRL::ComPtr<IDXGIAdapter1> selected_adapter;
  for (UINT index = 0;; ++index) {
    Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
    if (factory->EnumAdapters1(index, &adapter) == DXGI_ERROR_NOT_FOUND) break;
    DXGI_ADAPTER_DESC1 desc{};
    if (SUCCEEDED(adapter->GetDesc1(&desc)) &&
        desc.AdapterLuid.HighPart == display_.adapter_luid.HighPart &&
        desc.AdapterLuid.LowPart == display_.adapter_luid.LowPart) {
      selected_adapter = adapter;
      break;
    }
  }
  if (!selected_adapter) return false;
  const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1,
                                      D3D_FEATURE_LEVEL_11_0,
                                      D3D_FEATURE_LEVEL_10_1,
                                      D3D_FEATURE_LEVEL_10_0};
  D3D_FEATURE_LEVEL selected_level{};
  UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
  HRESULT hr = D3D11CreateDevice(selected_adapter.Get(),
                                 D3D_DRIVER_TYPE_UNKNOWN, nullptr, flags,
                                 levels, ARRAYSIZE(levels), D3D11_SDK_VERSION,
                                 &device_, &selected_level, &context_);
  if (FAILED(hr)) return false;
  Microsoft::WRL::ComPtr<IDXGIOutput> output;
  if (FAILED(selected_adapter->EnumOutputs(display_.output_index, &output)))
    return false;
  Microsoft::WRL::ComPtr<IDXGIOutput1> output1;
  if (FAILED(output.As(&output1)) ||
      FAILED(output1->DuplicateOutput(device_.Get(), &duplication_))) {
    return false;
  }
  return true;
}

void DxgiDesktopSource::ResetDuplication() {
  staging_.Reset();
  duplication_.Reset();
  context_.Reset();
  device_.Reset();
  surface_width_ = 0;
  surface_height_ = 0;
  last_cursor_snapshot_ = {};
  last_frame_ = nullptr;
  last_broadcast_us_ = 0;
}

void DxgiDesktopSource::RequestDesktopRebind(const std::wstring& desktop_name) {
  {
    std::lock_guard<std::mutex> lock(desktop_request_mutex_);
    requested_desktop_ = desktop_name;
  }
  desktop_rebind_requested_.store(true);
}

std::wstring DxgiDesktopSource::BoundDesktop() const {
  std::lock_guard<std::mutex> lock(desktop_request_mutex_);
  return bound_desktop_name_;
}

// Returns false while the move has not happened yet, so the caller can keep the
// request pending. Windows refuses the open and the bind for as long as it is
// mid-switch, and a source that swallowed that failure would sit on a desktop
// it can no longer read for the rest of the session — a picture frozen with no
// way back.
bool DxgiDesktopSource::BindCaptureThreadToRequestedDesktop() {
  std::wstring requested;
  {
    std::lock_guard<std::mutex> lock(desktop_request_mutex_);
    requested = requested_desktop_;
  }
  HDESK target = requested.empty()
      ? OpenInputDesktop(0, FALSE, GENERIC_ALL)
      : OpenDesktopW(requested.c_str(), 0, FALSE, GENERIC_ALL);
  if (!target) return false;
  if (!SetThreadDesktop(target)) {
    CloseDesktop(target);
    return false;
  }
  if (bound_desktop_) CloseDesktop(bound_desktop_);
  bound_desktop_ = target;
  {
    std::lock_guard<std::mutex> lock(desktop_request_mutex_);
    bound_desktop_name_ = requested.empty() ? DesktopNameOf(target) : requested;
  }
  // The duplication and any GDI fallback belong to the desktop left behind.
  ResetDuplication();
  gdi_active_ = false;
  first_frame_waits_ = 0;
  return true;
}

void DxgiDesktopSource::CaptureLoop() {
  SetThreadDescription(GetCurrentThread(), L"IM.codes DXGI capture");
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  auto next_frame = std::chrono::steady_clock::now();
  while (running_) {
    {
      std::lock_guard<std::mutex> lock(state_mutex_);
      // Kept pending until the bind actually lands: a switch that is refused
      // this tick is retried on the next one instead of stranding capture.
      if (desktop_rebind_requested_.load() &&
          BindCaptureThreadToRequestedDesktop()) {
        desktop_rebind_requested_.store(false);
      }
      bool captured = false;
      last_capture_waited_ = false;
      if (gdi_active_) {
        captured = CaptureDesktopGdi();
      } else if (!duplication_ && !InitializeDuplication()) {
        captured = false;
      } else {
        captured = CaptureOne();
      }
      if (gdi_active_ && ++gdi_dxgi_retry_ticks_ >= kGdiFallbackDxgiRetryTicks) {
        // Give the hardware path a chance to come back: a desktop that stopped
        // presenting can start again, and GDI is the slower fallback.
        gdi_dxgi_retry_ticks_ = 0;
        if (InitializeDuplication() && CaptureOne()) {
          gdi_active_ = false;
          captured = true;
        }
      }
      if (AdvanceGdiFallbackState(captured,
                                  fallback_ == CaptureFallback::kDesktopGdi,
                                  &first_frame_waits_)) {
        gdi_active_ = true;
        gdi_dxgi_retry_ticks_ = 0;
        ResetDuplication();
        captured = CaptureDesktopGdi();
      }
      if (captured) {
        consecutive_failures_ = 0;
        first_frame_waits_ = 0;
      } else {
        // A static desktop normally produces DXGI wait timeouts. Preserve the
        // duplication in that case; only real capture failures drive reset.
        if (!last_capture_waited_) ++consecutive_failures_;
        ++dropped_frames_;
      }
      if (consecutive_failures_ >= 5) {
        if (!gdi_active_) ResetDuplication();
        consecutive_failures_ = 0;
      }
    }
    next_frame += std::chrono::milliseconds(33);
    std::this_thread::sleep_until(next_frame);
    if (std::chrono::steady_clock::now() - next_frame >
        std::chrono::milliseconds(250)) {
      next_frame = std::chrono::steady_clock::now();
    }
  }
  CoUninitialize();
}

bool DxgiDesktopSource::CaptureOne() {
  DXGI_OUTDUPL_FRAME_INFO frame_info{};
  Microsoft::WRL::ComPtr<IDXGIResource> resource;
  const HRESULT acquired =
      duplication_->AcquireNextFrame(16, &frame_info, &resource);
  const CaptureAcquireAction acquire_action =
      ClassifyCaptureAcquireResult(acquired);
  if (acquire_action == CaptureAcquireAction::kWait) {
    last_capture_waited_ = true;
    const CursorSnapshot cursor = ReadCursorSnapshot();
    if (cursor.available &&
        CursorSnapshotChanged(last_cursor_snapshot_, cursor) &&
        BroadcastStagingFrame()) {
      return true;
    }
    // A completely static desktop may not yield another DXGI frame for a long
    // time. Re-submit the last immutable buffer at a bounded cadence so an
    // upstream PLI/keyframe request can recover without turning capture into a
    // screenshot poll or continuously re-encoding an unchanged desktop.
    const int64_t now_us =
        webrtc::Clock::GetRealTimeClock()->TimeInMicroseconds();
    if (last_frame_ && now_us - last_broadcast_us_ >= 2'000'000)
      BroadcastFrame(last_frame_);
    return last_frame_ != nullptr;
  }
  if (acquire_action == CaptureAcquireAction::kReset) {
    ResetDuplication();
    return false;
  }
  if (acquire_action != CaptureAcquireAction::kFrame) return false;
  struct ReleaseFrame {
    IDXGIOutputDuplication* duplication;
    ~ReleaseFrame() { duplication->ReleaseFrame(); }
  } release{duplication_.Get()};

  if (!ConsumeFrameMetadata(frame_info)) return false;

  Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
  if (FAILED(resource.As(&texture))) return false;
  D3D11_TEXTURE2D_DESC desc{};
  texture->GetDesc(&desc);
  if (desc.Width == 0 || desc.Height == 0 ||
      desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
    return false;
  }
  if (!staging_ || surface_width_ != desc.Width ||
      surface_height_ != desc.Height) {
    D3D11_TEXTURE2D_DESC staging_desc = desc;
    staging_desc.BindFlags = 0;
    staging_desc.MiscFlags = 0;
    staging_desc.Usage = D3D11_USAGE_STAGING;
    staging_desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    staging_desc.ArraySize = 1;
    staging_desc.MipLevels = 1;
    staging_desc.SampleDesc.Count = 1;
    if (FAILED(device_->CreateTexture2D(&staging_desc, nullptr, &staging_)))
      return false;
    surface_width_ = desc.Width;
    surface_height_ = desc.Height;
  }
  context_->CopyResource(staging_.Get(), texture.Get());
  return BroadcastStagingFrame();
}

bool DxgiDesktopSource::BroadcastStagingFrame() {
  if (!staging_ || !context_ || surface_width_ == 0 || surface_height_ == 0)
    return false;
  D3D11_MAPPED_SUBRESOURCE mapped{};
  if (FAILED(context_->Map(staging_.Get(), 0, D3D11_MAP_READ, 0, &mapped)))
    return false;
  const bool cursor_ready = EnsureCursorSurface(surface_width_, surface_height_);
  if (!cursor_ready) {
    context_->Unmap(staging_.Get(), 0);
    return false;
  }
  for (UINT row = 0; row < surface_height_; ++row) {
    std::memcpy(cursor_bits_ + static_cast<size_t>(row) * surface_width_ * 4,
                static_cast<const uint8_t*>(mapped.pData) +
                    static_cast<size_t>(row) * mapped.RowPitch,
                static_cast<size_t>(surface_width_) * 4);
  }
  context_->Unmap(staging_.Get(), 0);
  return BroadcastBgraFrame(static_cast<int>(surface_width_),
                            static_cast<int>(surface_height_));
}

bool DxgiDesktopSource::CaptureDesktopGdi() {
  ++gdi_attempts_;
  if (display_.width <= 0 || display_.height <= 0 ||
      !EnsureCursorSurface(display_.width, display_.height)) {
    gdi_last_error_ = ERROR_INVALID_DATA;
    return false;
  }
  const HDC screen = GetDC(nullptr);
  if (!screen) {
    gdi_last_error_ = GetLastError();
    return false;
  }
  SetLastError(ERROR_SUCCESS);
  const BOOL copied = BitBlt(
      cursor_dc_, 0, 0, display_.width, display_.height, screen,
      display_.desktop_rect.left, display_.desktop_rect.top,
      SRCCOPY | CAPTUREBLT);
  ReleaseDC(nullptr, screen);
  if (!copied) {
    gdi_last_error_ = GetLastError();
    return false;
  }
  GdiFlush();
  if (!BroadcastBgraFrame(display_.width, display_.height)) {
    gdi_last_error_ = ERROR_INVALID_PIXEL_FORMAT;
    return false;
  }
  gdi_last_error_ = ERROR_SUCCESS;
  return true;
}

bool DxgiDesktopSource::BroadcastBgraFrame(int width, int height) {
  if (!cursor_bits_ || width <= 0 || height <= 0) return false;
  CompositeCursor(cursor_bits_, width * 4, width, height);

  auto raw = webrtc::I420Buffer::Create(width, height);
  if (libyuv::ARGBToI420(cursor_bits_, width * 4,
                         raw->MutableDataY(), raw->StrideY(),
                         raw->MutableDataU(), raw->StrideU(),
                         raw->MutableDataV(), raw->StrideV(), width,
                         height) != 0) {
    return false;
  }
  webrtc::scoped_refptr<webrtc::I420Buffer> output = raw;
  if (display_.rotation_degrees != 0) {
    const bool swap = display_.rotation_degrees == 90 ||
                      display_.rotation_degrees == 270;
    output = webrtc::I420Buffer::Create(swap ? height : width,
                                        swap ? width : height);
    if (libyuv::I420Rotate(
            raw->DataY(), raw->StrideY(), raw->DataU(), raw->StrideU(),
            raw->DataV(), raw->StrideV(), output->MutableDataY(),
            output->StrideY(), output->MutableDataU(), output->StrideU(),
            output->MutableDataV(), output->StrideV(), width, height,
            LibyuvRotation(display_.rotation_degrees)) != 0) {
      return false;
    }
  }
  last_frame_ = output;
  last_cursor_snapshot_ = ReadCursorSnapshot();
  BroadcastFrame(output);
  return true;
}

void DxgiDesktopSource::BroadcastFrame(
    const webrtc::scoped_refptr<webrtc::I420Buffer>& buffer) {
  const int64_t now_us =
      webrtc::Clock::GetRealTimeClock()->TimeInMicroseconds();
  webrtc::VideoFrame frame = webrtc::VideoFrame::Builder()
                                  .set_video_frame_buffer(buffer)
                                  .set_timestamp_us(now_us)
                                  .set_rotation(webrtc::kVideoRotation_0)
                                  .build();
  broadcaster_.OnFrame(frame);
  last_broadcast_us_ = now_us;
  captured_frames_++;
  first_frame_condition_.notify_all();
}

bool DxgiDesktopSource::ConsumeFrameMetadata(
    const DXGI_OUTDUPL_FRAME_INFO& frame_info) {
  protected_content_masked_ = frame_info.ProtectedContentMaskedOut != FALSE;
  if (protected_content_masked_) return false;
  if (frame_info.TotalMetadataBufferSize > 0) {
    if (frame_metadata_.size() < frame_info.TotalMetadataBufferSize)
      frame_metadata_.resize(frame_info.TotalMetadataBufferSize);
    UINT move_bytes = 0;
    auto* moves = reinterpret_cast<DXGI_OUTDUPL_MOVE_RECT*>(
        frame_metadata_.data());
    if (FAILED(duplication_->GetFrameMoveRects(
            static_cast<UINT>(frame_metadata_.size()), moves,
            &move_bytes)) || move_bytes > frame_metadata_.size()) {
      return false;
    }
    UINT dirty_bytes = 0;
    auto* dirty = reinterpret_cast<RECT*>(frame_metadata_.data() + move_bytes);
    if (FAILED(duplication_->GetFrameDirtyRects(
            static_cast<UINT>(frame_metadata_.size() - move_bytes), dirty,
            &dirty_bytes)) ||
        static_cast<size_t>(move_bytes) + dirty_bytes >
            frame_metadata_.size()) {
      return false;
    }
    move_regions_ += move_bytes / sizeof(DXGI_OUTDUPL_MOVE_RECT);
    dirty_regions_ += dirty_bytes / sizeof(RECT);
  }

  if (frame_info.PointerShapeBufferSize > 0) {
    if (pointer_shape_.size() < frame_info.PointerShapeBufferSize)
      pointer_shape_.resize(frame_info.PointerShapeBufferSize);
    UINT required = 0;
    DXGI_OUTDUPL_POINTER_SHAPE_INFO shape{};
    if (FAILED(duplication_->GetFramePointerShape(
            static_cast<UINT>(pointer_shape_.size()), pointer_shape_.data(),
            &required, &shape)) || required > pointer_shape_.size() ||
        shape.Width == 0 || shape.Height == 0 || shape.Pitch == 0) {
      return false;
    }
    pointer_shape_.resize(required);
    pointer_shape_info_ = shape;
    pointer_shape_valid_ = true;
    ++pointer_updates_;
  }
  if (frame_info.LastMouseUpdateTime.QuadPart != 0) {
    pointer_position_ = frame_info.PointerPosition.Position;
    pointer_visible_ = frame_info.PointerPosition.Visible != FALSE;
    pointer_position_known_ = true;
    ++pointer_updates_;
  }
  return true;
}

bool DxgiDesktopSource::EnsureCursorSurface(int width, int height) {
  if (cursor_dc_ && cursor_width_ == width && cursor_height_ == height)
    return true;
  if (cursor_dc_) {
    if (cursor_old_bitmap_) SelectObject(cursor_dc_, cursor_old_bitmap_);
    DeleteObject(cursor_bitmap_);
    DeleteDC(cursor_dc_);
  }
  cursor_dc_ = CreateCompatibleDC(nullptr);
  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = width;
  info.bmiHeader.biHeight = -height;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  cursor_bitmap_ = CreateDIBSection(cursor_dc_, &info, DIB_RGB_COLORS,
                                    reinterpret_cast<void**>(&cursor_bits_),
                                    nullptr, 0);
  if (!cursor_dc_ || !cursor_bitmap_ || !cursor_bits_) return false;
  cursor_old_bitmap_ = SelectObject(cursor_dc_, cursor_bitmap_);
  cursor_width_ = width;
  cursor_height_ = height;
  return true;
}

void DxgiDesktopSource::CompositeCursor(uint8_t* bgra, int stride,
                                        int width, int height) {
  CURSORINFO cursor{};
  cursor.cbSize = sizeof(cursor);
  const bool native_available = GetCursorInfo(&cursor) && cursor.hCursor &&
      (cursor.flags & (CURSOR_SHOWING | CURSOR_SUPPRESSED)) != 0;
  const bool dxgi_available =
      pointer_position_known_ && pointer_visible_ && pointer_shape_valid_;

  // A click injected through SendInput can make Desktop Duplication report a
  // visible pointer and then leave its position cached forever on some display
  // stacks. Hover movement uses SetCursorPos, so continuing to prefer that DXGI
  // snapshot makes the viewer's cursor freeze immediately after the first
  // click. USER32 owns the actual cursor and reports its current screen
  // position on every frame, including suppressed pointers on headless nodes.
  if (SelectCursorSnapshotSource(native_available, dxgi_available) ==
      CursorSnapshotSource::kNative) {
    ICONINFO icon{};
    if (GetIconInfo(cursor.hCursor, &icon)) {
      const int x = cursor.ptScreenPos.x - display_.desktop_rect.left -
                    static_cast<int>(icon.xHotspot);
      const int y = cursor.ptScreenPos.y - display_.desktop_rect.top -
                    static_cast<int>(icon.yHotspot);
      const BOOL drawn = DrawIconEx(cursor_dc_, x, y, cursor.hCursor, 0, 0, 0,
                                    nullptr, DI_NORMAL);
      if (icon.hbmColor) DeleteObject(icon.hbmColor);
      if (icon.hbmMask) DeleteObject(icon.hbmMask);
      if (drawn) return;
    }
  }

  if (dxgi_available) CompositeDxgiCursor(bgra, stride, width, height);
}

void DxgiDesktopSource::CompositeDxgiCursor(uint8_t* bgra, int stride,
                                            int width, int height) {
  if (!bgra || stride < width * 4 || pointer_shape_.empty()) return;
  const int cursor_x = pointer_position_.x;
  const int cursor_y = pointer_position_.y;
  const UINT shape_width = pointer_shape_info_.Width;
  UINT shape_height = pointer_shape_info_.Height;
  if (pointer_shape_info_.Type ==
      DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME) {
    if ((shape_height & 1) != 0) return;
    shape_height /= 2;
  }

  for (UINT sy = 0; sy < shape_height; ++sy) {
    const int dy = cursor_y + static_cast<int>(sy);
    if (dy < 0 || dy >= height) continue;
    for (UINT sx = 0; sx < shape_width; ++sx) {
      const int dx = cursor_x + static_cast<int>(sx);
      if (dx < 0 || dx >= width) continue;
      uint8_t* destination = bgra + static_cast<size_t>(dy) * stride +
                             static_cast<size_t>(dx) * 4;
      if (pointer_shape_info_.Type ==
          DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME) {
        const size_t byte_index = static_cast<size_t>(sy) *
                                      pointer_shape_info_.Pitch +
                                  sx / 8;
        const size_t xor_index = static_cast<size_t>(sy + shape_height) *
                                     pointer_shape_info_.Pitch +
                                 sx / 8;
        if (xor_index >= pointer_shape_.size()) return;
        const uint8_t bit = static_cast<uint8_t>(0x80u >> (sx & 7));
        const uint8_t and_mask =
            (pointer_shape_[byte_index] & bit) != 0 ? 0xff : 0x00;
        const uint8_t xor_mask =
            (pointer_shape_[xor_index] & bit) != 0 ? 0xff : 0x00;
        for (int channel = 0; channel < 3; ++channel)
          destination[channel] =
              static_cast<uint8_t>((destination[channel] & and_mask) ^
                                   xor_mask);
        destination[3] = 0xff;
        continue;
      }

      const size_t source_index = static_cast<size_t>(sy) *
                                      pointer_shape_info_.Pitch +
                                  static_cast<size_t>(sx) * 4;
      if (source_index + 4 > pointer_shape_.size()) return;
      const uint8_t* source = pointer_shape_.data() + source_index;
      if (pointer_shape_info_.Type ==
          DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR) {
        for (int channel = 0; channel < 3; ++channel) {
          destination[channel] = source[3] == 0
                                     ? destination[channel] ^ source[channel]
                                     : source[channel];
        }
        destination[3] = 0xff;
        continue;
      }
      if (pointer_shape_info_.Type !=
          DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR) {
        return;
      }
      const uint32_t alpha = source[3];
      const uint32_t inverse = 255 - alpha;
      for (int channel = 0; channel < 3; ++channel) {
        destination[channel] = static_cast<uint8_t>(
            std::min<uint32_t>(255, source[channel] +
                                        destination[channel] * inverse / 255));
      }
      destination[3] = 0xff;
    }
  }
}

}  // namespace imcodes::rd
