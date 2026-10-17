// The libyuv-facing frame conversion for the raw (VP9) path. Needs libyuv; the
// .test.ts compiles libyuv's own sources when IMCODES_LIBYUV_SOURCE points at a
// checkout (the pinned libwebrtc SDK ships the same library).
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <memory>
#include <string_view>
#include <vector>

#include "raw_frame_conversion.h"

namespace common = imcodes::remote_desktop::common;
namespace macos = imcodes::remote_desktop::macos;

namespace {

void Require(bool condition, std::string_view message) {
  if (condition) return;
  std::cerr << "raw frame conversion failure: " << message << '\n';
  std::exit(1);
}

class Storage final : public common::FrameStorage {
 public:
  explicit Storage(std::size_t n) : bytes_(n) {}
  const std::byte* data() const noexcept override { return bytes_.data(); }
  std::size_t size() const noexcept override { return bytes_.size(); }
  std::byte* mutable_data() { return bytes_.data(); }
 private:
  std::vector<std::byte> bytes_;
};

// A BGRA frame (B,G,R,A in memory) filled with one colour, with row padding so a
// stride bug cannot hide.
common::CapturedFrame SolidBgra(std::uint32_t w, std::uint32_t h, std::uint8_t r,
                                std::uint8_t g, std::uint8_t b,
                                std::uint32_t padding = 16) {
  common::CapturedFrame f;
  f.encoded_pixels = {w, h};
  f.pixel_format = common::PixelFormat::kBgra8888;
  f.row_bytes = w * 4 + padding;
  auto storage = std::make_shared<Storage>(static_cast<std::size_t>(f.row_bytes) * h);
  auto* p = reinterpret_cast<std::uint8_t*>(storage->mutable_data());
  std::memset(p, 0xEE, static_cast<std::size_t>(f.row_bytes) * h);  // padding is poison
  for (std::uint32_t y = 0; y < h; ++y)
    for (std::uint32_t x = 0; x < w; ++x) {
      std::uint8_t* px = p + static_cast<std::size_t>(y) * f.row_bytes + x * 4;
      px[0] = b; px[1] = g; px[2] = r; px[3] = 255;
    }
  f.storage = storage;
  return f;
}

struct Planes {
  Planes(int w, int h)
      : width(w), height(h), y(static_cast<std::size_t>(w) * h),
        u(static_cast<std::size_t>(w / 2) * (h / 2)),
        v(static_cast<std::size_t>(w / 2) * (h / 2)) {}
  macos::I420Planes View() {
    return {y.data(), width, u.data(), width / 2, v.data(), width / 2, width, height};
  }
  int width, height;
  std::vector<std::uint8_t> y, u, v;
};

bool Near(int a, int b, int tol) { return a - b <= tol && b - a <= tol; }

void KnownColoursLandOnTheBt709LimitedRangeValues() {
  struct Case { std::uint8_t r, g, b; int y, u, v; const char* name; };
  // BT.709 limited range: Y = 16 + 219*(0.2126R+0.7152G+0.0722B), Cb/Cr centred on 128.
  const Case cases[] = {
      {255, 255, 255, 235, 128, 128, "white"},
      {0, 0, 0, 16, 128, 128, "black"},
      {255, 0, 0, 63, 102, 240, "red"},
      {0, 255, 0, 173, 42, 26, "green"},
      {0, 0, 255, 32, 240, 118, "blue"},
  };
  for (const Case& c : cases) {
    auto frame = SolidBgra(64, 32, c.r, c.g, c.b);
    Planes out(64, 32);
    Require(macos::ConvertFrameToI420(frame, out.View()), c.name);
    for (int i = 0; i < 64 * 32; ++i) Require(Near(out.y[i], c.y, 2), c.name);
    for (std::size_t i = 0; i < out.u.size(); ++i) {
      Require(Near(out.u[i], c.u, 2), c.name);
      Require(Near(out.v[i], c.v, 2), c.name);
    }
  }
  // Counterfactual: BT.601 would give red Y=82 -- a different, wrong picture.
  auto red = SolidBgra(64, 32, 255, 0, 0);
  Planes out(64, 32);
  Require(macos::ConvertFrameToI420(red, out.View()) && out.y[0] != 82, "not the 601 matrix");
}

common::CapturedFrame PatternNv12(std::uint32_t w, std::uint32_t h,
                                  std::uint32_t luma_pad, std::uint32_t chroma_pad) {
  common::CapturedFrame f;
  f.encoded_pixels = {w, h};
  f.pixel_format = common::PixelFormat::kNv12;
  f.row_bytes = w + luma_pad;
  f.uv_offset = f.row_bytes * h;
  f.uv_row_bytes = w + chroma_pad;
  auto storage = std::make_shared<Storage>(f.uv_offset + static_cast<std::size_t>(f.uv_row_bytes) * (h / 2));
  auto* p = reinterpret_cast<std::uint8_t*>(storage->mutable_data());
  std::memset(p, 0xEE, storage->size());
  for (std::uint32_t y = 0; y < h; ++y)
    for (std::uint32_t x = 0; x < w; ++x) p[y * f.row_bytes + x] = static_cast<std::uint8_t>((x * 7 + y * 3) & 0xFF);
  for (std::uint32_t y = 0; y < h / 2; ++y)
    for (std::uint32_t x = 0; x < w / 2; ++x) {
      p[f.uv_offset + y * f.uv_row_bytes + 2 * x] = static_cast<std::uint8_t>((x + 2 * y) & 0xFF);       // Cb
      p[f.uv_offset + y * f.uv_row_bytes + 2 * x + 1] = static_cast<std::uint8_t>((x * 5 + y) & 0xFF);   // Cr
    }
  f.storage = storage;
  return f;
}

void Nv12IsAPureSplitWithNoColourArithmetic() {
  auto frame = PatternNv12(64, 32, 32, 48);  // padded strides on both planes
  Planes out(64, 32);
  Require(macos::ConvertFrameToI420(frame, out.View()), "converts");
  for (int y = 0; y < 32; ++y)
    for (int x = 0; x < 64; ++x)
      Require(out.y[y * 64 + x] == ((x * 7 + y * 3) & 0xFF), "luma is copied exactly");
  for (int y = 0; y < 16; ++y)
    for (int x = 0; x < 32; ++x) {
      Require(out.u[y * 32 + x] == ((x + 2 * y) & 0xFF), "Cb de-interleaved exactly");
      Require(out.v[y * 32 + x] == ((x * 5 + y) & 0xFF), "Cr de-interleaved exactly");
    }
}

void Nv12ToBgraAndBackStaysClose() {
  auto frame = PatternNv12(64, 32, 0, 0);
  // Keep the pattern in the legal video range so the round trip is meaningful.
  auto* p = reinterpret_cast<std::uint8_t*>(const_cast<std::byte*>(frame.storage->data()));
  for (std::uint32_t i = 0; i < frame.uv_offset; ++i) p[i] = static_cast<std::uint8_t>(16 + (p[i] % 200));
  for (std::size_t i = frame.uv_offset; i < frame.storage->size(); ++i) p[i] = static_cast<std::uint8_t>(64 + (p[i] % 128));
  auto bgra = macos::ConvertNv12FrameToBgra(frame, 1U << 20);
  Require(bgra.has_value() && bgra->IsValid(), "NV12 -> BGRA");
  Require(bgra->pixel_format == common::PixelFormat::kBgra8888 && bgra->row_bytes == 64 * 4, "BGRA layout");
  Require(bgra->encoded_pixels.width == 64 && bgra->encoded_pixels.height == 32, "same size");
  Planes back(64, 32);
  Require(macos::ConvertFrameToI420(*bgra, back.View()), "BGRA -> I420");
  long long diff = 0;
  for (int i = 0; i < 64 * 32; ++i) diff += std::abs(int(back.y[i]) - int(p[i]));
  Require(diff / (64 * 32) <= 3, "luma survives NV12 -> BGRA -> I420 on the same (709) matrix");
}

void RefusalsAreExplicit() {
  auto frame = SolidBgra(64, 32, 1, 2, 3);
  Planes ok(64, 32);
  Require(macos::ConvertFrameToI420(frame, ok.View()), "baseline");
  Planes wrong_size(32, 32);
  Require(!macos::ConvertFrameToI420(frame, wrong_size.View()), "destination of another size");
  macos::I420Planes missing = ok.View();
  missing.v = nullptr;
  Require(!macos::ConvertFrameToI420(frame, missing), "missing plane");
  macos::I420Planes narrow = ok.View();
  narrow.y_stride = 8;
  Require(!macos::ConvertFrameToI420(frame, narrow), "stride smaller than the width");
  common::CapturedFrame invalid = frame;
  invalid.storage = nullptr;
  Require(!macos::ConvertFrameToI420(invalid, ok.View()), "frame with no storage");
  common::CapturedFrame odd = SolidBgra(63, 32, 1, 2, 3);
  Planes odd_planes(62, 32);
  Require(!macos::ConvertFrameToI420(odd, odd_planes.View()), "odd width");
  Require(!macos::ConvertNv12FrameToBgra(frame, 1U << 20).has_value(), "BGRA input is not NV12");
  auto nv = PatternNv12(64, 32, 0, 0);
  Require(!macos::ConvertNv12FrameToBgra(nv, 100).has_value(), "bounded allocation");
}

}  // namespace

int main() {
  KnownColoursLandOnTheBt709LimitedRangeValues();
  Nv12IsAPureSplitWithNoColourArithmetic();
  Nv12ToBgraAndBackStaysClose();
  RefusalsAreExplicit();
  std::cout << "raw frame conversion counterfactuals passed\n";
  return 0;
}
