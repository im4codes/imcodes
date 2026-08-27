#include "value_types.h"

#include <algorithm>
#include <cmath>
#include <unordered_set>

namespace imcodes::remote_desktop::common {

namespace {

bool Finite(double value) noexcept {
  return std::isfinite(value);
}

}  // namespace

bool PixelSize::IsValid() const noexcept {
  return width > 0 && height > 0 && width <= 16'384 && height <= 16'384;
}

bool LogicalRect::IsValid() const noexcept {
  return Finite(x) && Finite(y) && Finite(width) && Finite(height) &&
         width > 0.0 && height > 0.0 && width <= 1'000'000.0 &&
         height <= 1'000'000.0;
}

LogicalPoint LogicalRect::MapNormalized(double normalized_x,
                                        double normalized_y) const noexcept {
  const double bounded_x = std::clamp(normalized_x, 0.0, 1.0);
  const double bounded_y = std::clamp(normalized_y, 0.0, 1.0);
  return LogicalPoint{x + bounded_x * width, y + bounded_y * height};
}

bool DisplayTopology::IsValid() const noexcept {
  if (display_id.empty() || display_id.size() > 256 || generation == 0 ||
      !encoded_pixels.IsValid() || !logical_input_bounds.IsValid() ||
      !Finite(scale) || scale <= 0.0 || scale > 16.0) {
    return false;
  }
  switch (rotation) {
    case DisplayRotation::k0:
    case DisplayRotation::k90:
    case DisplayRotation::k180:
    case DisplayRotation::k270:
      return true;
  }
  return false;
}

bool DesktopTopology::IsValid() const noexcept {
  if (generation == 0 || revision == 0 || displays.empty() ||
      displays.size() > 32) {
    return false;
  }
  std::unordered_set<std::string> ids;
  for (const DisplayTopology& display : displays) {
    if (!display.IsValid() || display.generation != generation ||
        !ids.insert(display.display_id).second) {
      return false;
    }
  }
  return true;
}

const DisplayTopology* DesktopTopology::FindDisplay(
    const std::string& display_id) const noexcept {
  const auto it = std::find_if(
      displays.begin(), displays.end(), [&](const DisplayTopology& display) {
        return display.display_id == display_id;
      });
  return it == displays.end() ? nullptr : &*it;
}

bool CapturedFrame::IsValid() const noexcept {
  if (!encoded_pixels.IsValid() || capture_time_us < 0 || !storage ||
      storage->data() == nullptr) {
    return false;
  }
  switch (pixel_format) {
    case PixelFormat::kBgra8888: {
      const std::uint64_t minimum_row =
          static_cast<std::uint64_t>(encoded_pixels.width) * 4;
      const std::uint64_t required =
          static_cast<std::uint64_t>(row_bytes) * encoded_pixels.height;
      return row_bytes >= minimum_row && required > 0 &&
             required <= storage->size();
    }
  }
  return false;
}

bool H264AccessUnit::IsValid() const noexcept {
  return !bytes.empty() && presentation_time_us >= 0;
}

bool CapabilityReadiness::ViewReady() const noexcept {
  return capture == ReadinessState::kReady &&
         encoder == ReadinessState::kReady &&
         disclosure == ReadinessState::kReady &&
         graphical_session == ReadinessState::kReady;
}

bool CapabilityReadiness::ControlReady() const noexcept {
  return ViewReady() && input == ReadinessState::kReady;
}

}  // namespace imcodes::remote_desktop::common
