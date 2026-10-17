#include "raw_frame_conversion.h"

#include <cstddef>
#include <memory>
#include <utility>

#include "libyuv/convert.h"
#include "libyuv/convert_argb.h"
#include "libyuv/convert_from_argb.h"

namespace imcodes::remote_desktop::macos {
namespace {

// Owns the BGRA bytes ConvertNv12FrameToBgra produces.
class OwnedFrameStorage final : public common::FrameStorage {
 public:
  explicit OwnedFrameStorage(std::size_t size)
      : size_(size), bytes_(new std::byte[size]) {}
  [[nodiscard]] const std::byte* data() const noexcept override {
    return bytes_.get();
  }
  [[nodiscard]] std::size_t size() const noexcept override { return size_; }
  std::byte* mutable_data() noexcept { return bytes_.get(); }

 private:
  std::size_t size_;
  std::unique_ptr<std::byte[]> bytes_;
};

const std::uint8_t* Bytes(const common::CapturedFrame& frame,
                          std::size_t offset) {
  return reinterpret_cast<const std::uint8_t*>(frame.storage->data()) + offset;
}

}  // namespace

bool ConvertFrameToI420(const common::CapturedFrame& frame,
                        const I420Planes& destination) {
  if (!frame.IsValid() || destination.y == nullptr || destination.u == nullptr ||
      destination.v == nullptr) {
    return false;
  }
  const int width = static_cast<int>(frame.encoded_pixels.width);
  const int height = static_cast<int>(frame.encoded_pixels.height);
  if (width != destination.width || height != destination.height ||
      (width & 1) != 0 || (height & 1) != 0) {
    return false;
  }
  const int chroma_width = width / 2;
  if (destination.y_stride < width || destination.u_stride < chroma_width ||
      destination.v_stride < chroma_width) {
    return false;
  }
  switch (frame.pixel_format) {
    case common::PixelFormat::kBgra8888:
      // The common BGRA frame is B,G,R,A in memory, which libyuv names ARGB.
      return libyuv::ARGBToI420Matrix(
                 Bytes(frame, 0), static_cast<int>(frame.row_bytes),
                 destination.y, destination.y_stride, destination.u,
                 destination.u_stride, destination.v, destination.v_stride,
                 &libyuv::kArgbH709Constants, width, height) == 0;
    case common::PixelFormat::kNv12:
      return libyuv::NV12ToI420(Bytes(frame, 0),
                                static_cast<int>(frame.row_bytes),
                                Bytes(frame, frame.uv_offset),
                                static_cast<int>(frame.uv_row_bytes),
                                destination.y, destination.y_stride,
                                destination.u, destination.u_stride,
                                destination.v, destination.v_stride, width,
                                height) == 0;
  }
  return false;
}

std::optional<common::CapturedFrame> ConvertNv12FrameToBgra(
    const common::CapturedFrame& frame, std::size_t max_bytes) {
  if (frame.pixel_format != common::PixelFormat::kNv12 || !frame.IsValid())
    return std::nullopt;
  const std::uint64_t row_bytes =
      static_cast<std::uint64_t>(frame.encoded_pixels.width) * 4;
  const std::uint64_t total = row_bytes * frame.encoded_pixels.height;
  if (total == 0 || total > max_bytes) return std::nullopt;

  auto storage = std::make_shared<OwnedFrameStorage>(static_cast<std::size_t>(total));
  if (libyuv::NV12ToARGBMatrix(
          Bytes(frame, 0), static_cast<int>(frame.row_bytes),
          Bytes(frame, frame.uv_offset), static_cast<int>(frame.uv_row_bytes),
          reinterpret_cast<std::uint8_t*>(storage->mutable_data()),
          static_cast<int>(row_bytes), &libyuv::kYuvH709Constants,
          static_cast<int>(frame.encoded_pixels.width),
          static_cast<int>(frame.encoded_pixels.height)) != 0) {
    return std::nullopt;
  }
  common::CapturedFrame converted;
  converted.encoded_pixels = frame.encoded_pixels;
  converted.pixel_format = common::PixelFormat::kBgra8888;
  converted.row_bytes = static_cast<std::uint32_t>(row_bytes);
  converted.capture_time_us = frame.capture_time_us;
  converted.color_primaries = frame.color_primaries;
  converted.repeated_unchanged = frame.repeated_unchanged;
  converted.storage = std::move(storage);
  return converted;
}

}  // namespace imcodes::remote_desktop::macos
