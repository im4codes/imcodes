#include "macos_virtual_display_adapter.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

namespace imcodes::remote_desktop::macos {
namespace {

constexpr std::uint32_t kMaximumDimension = 8192;
constexpr std::uint32_t kMaximumModes = 16;
constexpr std::uint32_t kMaximumTimeoutMs = 30'000;
constexpr std::size_t kMaximumNameBytes = 128;

bool SamePixels(common::PixelSize left, common::PixelSize right) noexcept {
  return left.width == right.width && left.height == right.height;
}

bool SameScale(double left, double right) noexcept {
  return std::abs(left - right) <= std::numeric_limits<double>::epsilon();
}

std::string DisplayId(common::WorkerGeneration generation,
                      std::uint32_t native_display_id) {
  return "macos-display:" + std::to_string(generation) + ":" +
         std::to_string(native_display_id);
}

}  // namespace

bool MacosVirtualDisplayMode::IsValid() const noexcept {
  return pixels.IsValid() && pixels.width <= kMaximumDimension &&
         pixels.height <= kMaximumDimension && std::isfinite(scale) &&
         (SameScale(scale, 1.0) || SameScale(scale, 2.0)) &&
         std::isfinite(refresh_rate_hz) && refresh_rate_hz >= 30.0 &&
         refresh_rate_hz <= 60.0;
}

bool MacosVirtualDisplayConfiguration::IsValid() const noexcept {
  if (worker_generation == 0 || name.empty() ||
      name.size() > kMaximumNameBytes || vendor_id == 0 || product_id == 0 ||
      serial_number == 0 || online_timeout_ms == 0 ||
      online_timeout_ms > kMaximumTimeoutMs || modes.empty() ||
      modes.size() > kMaximumModes) {
    return false;
  }
  for (std::size_t index = 0; index < modes.size(); ++index) {
    if (!modes[index].IsValid())
      return false;
    for (std::size_t previous = 0; previous < index; ++previous) {
      if (SamePixels(modes[index].pixels, modes[previous].pixels) &&
          SameScale(modes[index].scale, modes[previous].scale)) {
        return false;
      }
    }
  }
  return true;
}

std::uint32_t MacosVirtualDisplaySerialForGeneration(
    common::WorkerGeneration generation) noexcept {
  if (generation == 0)
    return 0;
  const auto folded = static_cast<std::uint32_t>(generation) ^
                      static_cast<std::uint32_t>(generation >> 32U);
  return folded == 0 ? 1U : folded;
}

MacosVirtualDisplayAdapter::MacosVirtualDisplayAdapter(
    common::DisplayAdapter& display,
    std::unique_ptr<MacosVirtualDisplayBackend> backend,
    MacosVirtualDisplayConfiguration configuration,
    MacosVirtualDisplayCreationPredicate should_create)
    : display_(display),
      backend_(std::move(backend)),
      configuration_(std::move(configuration)),
      should_create_(std::move(should_create)) {
  if (!configuration_.modes.empty())
    current_mode_ = configuration_.modes.front();
}

MacosVirtualDisplayAdapter::~MacosVirtualDisplayAdapter() {
  ReleaseVirtualDisplay();
}

common::ReadinessState MacosVirtualDisplayAdapter::ProbeReadiness() {
  return display_.ProbeReadiness();
}

common::ReadinessState
MacosVirtualDisplayAdapter::ProbeVirtualDisplayReadiness() noexcept {
  if (!configuration_.IsValid() || !backend_)
    return common::ReadinessState::kUnavailable;
  return backend_->ProbeSupport();
}

std::optional<common::DesktopTopology>
MacosVirtualDisplayAdapter::EnumerateTopology() {
  auto topology = DecorateTopology(display_.EnumerateTopology());
  if (topology)
    return topology;
  if (native_display_id_ != 0) {
    last_error_ = "owned virtual display disappeared from topology";
    ReleaseVirtualDisplay();
    return std::nullopt;
  }
  if (!should_create_ || !should_create_())
    return std::nullopt;
  if (!EnsureVirtualDisplay())
    return std::nullopt;
  topology = DecorateTopology(display_.EnumerateTopology());
  if (!topology) {
    last_error_ = "created virtual display was not enumerated";
    ReleaseVirtualDisplay();
  }
  return topology;
}

bool MacosVirtualDisplayAdapter::SelectDisplay(std::string_view display_id) {
  return display_.SelectDisplay(display_id);
}

bool MacosVirtualDisplayAdapter::SetMode(std::string_view display_id,
                                         common::PixelSize pixels) {
  if (display_id.empty() || display_id != display_id_ ||
      native_display_id_ == 0 || !backend_)
    return false;
  const MacosVirtualDisplayMode* mode = FindMode(pixels, current_mode_.scale);
  if (mode == nullptr)
    return false;
  std::string error;
  if (!backend_->ApplyMode(native_display_id_, *mode, configuration_.modes,
                           &error) ||
      !backend_->WaitUntilOnline(native_display_id_,
                                 configuration_.online_timeout_ms, &error)) {
    last_error_ =
        error.empty() ? "virtual display mode change failed" : std::move(error);
    return false;
  }
  current_mode_ = *mode;
  return true;
}

bool MacosVirtualDisplayAdapter::SetScale(std::string_view display_id,
                                          double scale) {
  if (display_id.empty() || display_id != display_id_ ||
      native_display_id_ == 0 || !backend_)
    return false;
  const MacosVirtualDisplayMode* mode = FindMode(current_mode_.pixels, scale);
  if (mode == nullptr)
    return false;
  std::string error;
  if (!backend_->ApplyMode(native_display_id_, *mode, configuration_.modes,
                           &error) ||
      !backend_->WaitUntilOnline(native_display_id_,
                                 configuration_.online_timeout_ms, &error)) {
    last_error_ = error.empty() ? "virtual display scale change failed"
                                : std::move(error);
    return false;
  }
  current_mode_ = *mode;
  return true;
}

bool MacosVirtualDisplayAdapter::owns_virtual_display() const noexcept {
  return native_display_id_ != 0;
}

std::uint32_t MacosVirtualDisplayAdapter::native_virtual_display_id()
    const noexcept {
  return native_display_id_;
}

std::string MacosVirtualDisplayAdapter::virtual_display_id() const {
  return display_id_;
}

std::string MacosVirtualDisplayAdapter::last_error() const {
  return last_error_;
}

void MacosVirtualDisplayAdapter::ReleaseVirtualDisplay() noexcept {
  if (backend_ && native_display_id_ != 0)
    backend_->Destroy();
  native_display_id_ = 0;
  display_id_.clear();
}

bool MacosVirtualDisplayAdapter::EnsureVirtualDisplay() {
  if (native_display_id_ != 0)
    return true;
  if (ProbeVirtualDisplayReadiness() != common::ReadinessState::kReady) {
    last_error_ = "virtual display runtime is unavailable";
    return false;
  }
  std::uint32_t display_id = 0;
  std::string error;
  if (!backend_->Create(configuration_, &display_id, &error) ||
      display_id == 0 ||
      !backend_->WaitUntilOnline(display_id, configuration_.online_timeout_ms,
                                 &error)) {
    backend_->Destroy();
    last_error_ =
        error.empty() ? "virtual display creation failed" : std::move(error);
    return false;
  }
  native_display_id_ = display_id;
  display_id_ = DisplayId(configuration_.worker_generation, display_id);
  current_mode_ = configuration_.modes.front();
  last_error_.clear();
  return true;
}

std::optional<common::DesktopTopology>
MacosVirtualDisplayAdapter::DecorateTopology(
    std::optional<common::DesktopTopology> topology) {
  if (!topology || !topology->IsValid())
    return std::nullopt;
  if (native_display_id_ == 0)
    return topology;
  bool found = false;
  for (auto& display : topology->displays) {
    if (display.display_id != display_id_)
      continue;
    found = true;
    display.operations.set_mode = true;
    display.operations.set_scale = true;
  }
  return found ? std::move(topology) : std::nullopt;
}

const MacosVirtualDisplayMode* MacosVirtualDisplayAdapter::FindMode(
    common::PixelSize pixels,
    double scale) const noexcept {
  const auto found = std::find_if(
      configuration_.modes.begin(), configuration_.modes.end(),
      [pixels, scale](const MacosVirtualDisplayMode& mode) {
        return SamePixels(mode.pixels, pixels) && SameScale(mode.scale, scale);
      });
  return found == configuration_.modes.end() ? nullptr : &*found;
}

}  // namespace imcodes::remote_desktop::macos
