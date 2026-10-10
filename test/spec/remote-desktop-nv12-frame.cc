#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <string_view>
#include <vector>

#include "value_types.h"

namespace common = imcodes::remote_desktop::common;

namespace {

void Require(bool condition, std::string_view message) {
  if (condition) return;
  std::cerr << "nv12 frame failure: " << message << '\n';
  std::exit(1);
}

class Bytes final : public common::FrameStorage {
 public:
  explicit Bytes(std::size_t size) : bytes_(size, std::byte{0x10}) {}
  const std::byte* data() const noexcept override { return bytes_.data(); }
  std::size_t size() const noexcept override { return bytes_.size(); }

 private:
  std::vector<std::byte> bytes_;
};

// 64x32: luma 64*32 = 2048 bytes, chroma 64*16 = 1024 bytes, total 3072.
common::CapturedFrame Nv12(std::uint32_t width = 64, std::uint32_t height = 32,
                           std::uint32_t row_bytes = 64, std::uint32_t uv_offset = 2048,
                           std::uint32_t uv_row_bytes = 64, std::size_t storage = 3072) {
  common::CapturedFrame frame;
  frame.encoded_pixels = {width, height};
  frame.pixel_format = common::PixelFormat::kNv12;
  frame.row_bytes = row_bytes;
  frame.uv_offset = uv_offset;
  frame.uv_row_bytes = uv_row_bytes;
  frame.capture_time_us = 1;
  frame.storage = std::make_shared<Bytes>(storage);
  return frame;
}

}  // namespace

int main() {
  Require(Nv12().IsValid(), "a tightly packed NV12 frame is valid");
  Require(Nv12(64, 32, 80, 2560, 80, 80 * 32 + 80 * 16).IsValid(), "padded strides are valid");
  Require(!Nv12(63, 32).IsValid(), "odd width: 4:2:0 needs even dimensions");
  Require(!Nv12(64, 31).IsValid(), "odd height");
  Require(!Nv12(64, 32, 63).IsValid(), "luma stride narrower than the width");
  Require(!Nv12(64, 32, 64, 2048, 63).IsValid(), "chroma stride narrower than the width");
  Require(!Nv12(64, 32, 64, 2047).IsValid(), "chroma plane overlapping the luma plane");
  Require(!Nv12(64, 32, 64, 2048, 64, 3071).IsValid(), "storage one byte short of the chroma plane");
  Require(Nv12(64, 32, 64, 2048, 64, 3072).IsValid(), "storage exactly the size of both planes");
  Require(!Nv12(64, 32, 0).IsValid(), "zero luma stride");
  common::CapturedFrame bgra;
  bgra.encoded_pixels = {4, 4};
  bgra.pixel_format = common::PixelFormat::kBgra8888;
  bgra.row_bytes = 16;
  bgra.capture_time_us = 1;
  bgra.storage = std::make_shared<Bytes>(64);
  Require(bgra.IsValid(), "a BGRA frame is unchanged");
  Require(bgra.uv_offset == 0 && bgra.uv_row_bytes == 0, "the chroma fields default to zero");
  std::cout << "nv12 frame counterfactuals passed\n";
  return 0;
}
