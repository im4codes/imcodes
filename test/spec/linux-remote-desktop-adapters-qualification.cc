// Linux-only, on-host qualification of the concrete platform adapters.
//
// Exercises capture, input (including release), clipboard, display topology
// and lifecycle against a live X server, and proves the portal path stays
// unavailable. Exit 0 means the X11 fallback qualified end to end; any other
// exit names the failure.

#include <cstdio>
#include <string>

#include "../../native/linux-remote-desktop/linux_platform_adapters.h"

namespace rd = imcodes::remote_desktop::linux_platform;
namespace common = imcodes::remote_desktop::common;

namespace {

int Fail(const char* rule, int code) {
  std::fprintf(stderr, "adapter qualification failed: %s\n", rule);
  return code;
}

}  // namespace

int main() {
  auto connection = rd::X11Connection::Open();
  if (!connection) return Fail("cannot open X display", 10);

  auto adapters = rd::LinuxPlatformAdapters::Create(connection);
  if (!adapters) return Fail("cannot build adapters", 11);

  std::printf("active capture backend: %s\n",
              std::string(rd::CaptureBackendName(adapters->active_capture_backend())).c_str());

  // ── The portal must stay unavailable in this slice ───────────────────────
  rd::PortalCaptureAdapter portal(adapters->facts());
  if (portal.ProbeReadiness() != common::ReadinessState::kUnavailable) {
    return Fail("portal capture must not report ready in this slice", 20);
  }
  std::printf("portal unavailable reason: %s\n", portal.unavailable_reason().c_str());
  if (portal.Start(common::DisplayTopology{}, [](common::CapturedFrame) {})) {
    return Fail("portal capture must refuse to start", 21);
  }
  if (adapters->active_capture_backend() == rd::CaptureBackend::kPortalPipeWire) {
    return Fail("portal must never be the active backend in this slice", 22);
  }

  // ── Display topology ─────────────────────────────────────────────────────
  auto& display = adapters->display();
  if (display.ProbeReadiness() != common::ReadinessState::kReady) {
    return Fail("display adapter must be ready on a RANDR server", 30);
  }
  const auto topology = display.EnumerateTopology();
  if (!topology.has_value() || topology->displays.empty()) {
    return Fail("topology enumeration must return at least one display", 31);
  }
  const std::string first_id = topology->displays.front().display_id;
  std::printf("topology: %zu display(s), first=%s %ux%u\n",
              topology->displays.size(), first_id.c_str(),
              topology->displays.front().encoded_pixels.width,
              topology->displays.front().encoded_pixels.height);
  if (!display.SelectDisplay(first_id)) {
    return Fail("selecting an enumerated display must succeed", 32);
  }
  if (display.SelectDisplay("not-a-real-display")) {
    return Fail("selecting an unknown display must fail closed", 33);
  }
  // Unimplemented operations must be advertised false AND refuse.
  if (topology->displays.front().operations.set_mode
      || topology->displays.front().operations.set_scale) {
    return Fail("unimplemented display operations must advertise false", 34);
  }
  if (display.SetMode(first_id, common::PixelSize{640, 480})
      || display.SetScale(first_id, 2.0)) {
    return Fail("unimplemented display operations must refuse", 35);
  }

  // ── Capture ──────────────────────────────────────────────────────────────
  auto& capture = adapters->capture();
  if (capture.ProbeReadiness() != common::ReadinessState::kReady) {
    return Fail("X11 capture must be ready on a live server", 40);
  }
  common::CapturedFrame frame;
  if (!static_cast<rd::X11CaptureAdapter&>(capture)
           .CaptureOnce(topology->displays.front(), &frame)) {
    return Fail("single-frame capture must succeed", 41);
  }
  if (!frame.encoded_pixels.IsValid() || frame.storage == nullptr) {
    return Fail("captured frame must carry pixels and storage", 42);
  }
  if (frame.pixel_format != common::PixelFormat::kBgra8888) {
    return Fail("captured frame must honour the BGRA8888 contract", 43);
  }
  const std::size_t expected =
      static_cast<std::size_t>(frame.row_bytes) * frame.encoded_pixels.height;
  if (frame.storage->size() < expected || frame.row_bytes < frame.encoded_pixels.width * 4) {
    return Fail("captured frame storage must cover its own stride", 44);
  }
  std::printf("capture: %ux%u row_bytes=%u bytes=%zu\n",
              frame.encoded_pixels.width, frame.encoded_pixels.height,
              frame.row_bytes, frame.storage->size());

  bool sink_saw_frame = false;
  if (!capture.Start(topology->displays.front(),
                     [&](common::CapturedFrame delivered) {
                       sink_saw_frame = delivered.storage != nullptr;
                     })) {
    return Fail("capture Start must deliver a frame", 45);
  }
  if (!sink_saw_frame) return Fail("capture sink must receive a real frame", 46);
  capture.Stop();

  // ── Input injection and release ──────────────────────────────────────────
  auto& input = adapters->input();
  if (input.ProbeReadiness() != common::ReadinessState::kReady) {
    return Fail("input adapter must be ready with XTEST", 50);
  }
  if (!input.MovePointer(common::LogicalPoint{412.0, 233.0})) {
    return Fail("pointer move must succeed", 51);
  }
  if (input.held_count() != 0) return Fail("pointer move must hold nothing", 52);

  if (!input.EmitButton("left", true)) return Fail("button press must succeed", 53);
  if (input.held_count() != 1) return Fail("pressed button must be tracked", 54);
  if (!input.EmitKey("Shift_L", true)) return Fail("key press must succeed", 55);
  if (input.held_count() != 2) return Fail("pressed key must be tracked", 56);

  // Release everything the adapter emitted, and only that.
  input.ReleaseAllEmittedState();
  if (input.held_count() != 0) {
    return Fail("ReleaseAllEmittedState must clear every held input", 57);
  }
  if (input.EmitButton("nonsense", true)) {
    return Fail("unknown button must fail closed", 58);
  }
  if (input.EmitKey("definitely_not_a_keysym", true)) {
    return Fail("unknown key must fail closed", 59);
  }
  if (input.held_count() != 0) {
    return Fail("rejected input must not be tracked as held", 60);
  }
  if (!input.EmitWheel(0.0, 2.0)) return Fail("wheel must succeed", 61);
  if (input.held_count() != 0) return Fail("wheel must never stay held", 62);
  if (!input.EmitText("hi")) return Fail("text must succeed", 63);
  if (input.held_count() != 0) return Fail("text must not leave keys held", 64);
  std::printf("input: move/button/key/wheel/text verified, nothing held\n");

  // ── Clipboard round trip ─────────────────────────────────────────────────
  auto& clipboard = adapters->clipboard();
  if (clipboard.ProbeReadiness() != common::ReadinessState::kReady) {
    return Fail("clipboard must be ready with XFIXES", 70);
  }
  const std::string payload = "imcodes-linux-clipboard-\xE6\xB5\x8B\xE8\xAF\x95";
  if (!clipboard.PasteText(payload)) {
    return Fail("taking CLIPBOARD ownership must succeed", 71);
  }
  std::string read_back;
  if (!clipboard.CopySelection(&read_back)) {
    return Fail("reading back the clipboard must succeed", 72);
  }
  if (read_back != payload) {
    std::fprintf(stderr, "clipboard mismatch: wrote %s read %s\n",
                 payload.c_str(), read_back.c_str());
    return Fail("clipboard round trip must preserve bytes", 73);
  }
  std::printf("clipboard: round trip preserved %zu bytes incl. non-ascii\n",
              payload.size());

  // ── Lifecycle ────────────────────────────────────────────────────────────
  auto& monitor = adapters->session_monitor();
  if (monitor.ProbeReadiness() != common::ReadinessState::kReady) {
    return Fail("session monitor must be ready with a session bus", 80);
  }
  bool saw_ready = false;
  bool saw_locked = false;
  if (!monitor.Start([&](common::GraphicalSessionEvent event) {
        if (event == common::GraphicalSessionEvent::kReady) saw_ready = true;
        if (event == common::GraphicalSessionEvent::kLocked) saw_locked = true;
      })) {
    return Fail("session monitor must start", 81);
  }
  if (!saw_ready) return Fail("session monitor must report readiness first", 82);
  monitor.Emit(common::GraphicalSessionEvent::kLocked);
  if (!saw_locked) return Fail("session monitor must deliver transitions", 83);
  monitor.Stop();
  saw_locked = false;
  monitor.Emit(common::GraphicalSessionEvent::kLocked);
  if (saw_locked) return Fail("stopped monitor must not deliver events", 84);

  // ── Disclosure stays unavailable ─────────────────────────────────────────
  auto& disclosure = adapters->disclosure();
  if (disclosure.ProbeReadiness() != common::ReadinessState::kUnavailable) {
    return Fail("disclosure must stay unavailable in this slice", 90);
  }
  if (disclosure.Show(1, 1)) return Fail("disclosure must refuse to show", 91);

  // ── Aggregate readiness ──────────────────────────────────────────────────
  const auto readiness = adapters->MeasureReadiness();
  if (readiness.disclosure != common::ReadinessState::kUnavailable) {
    return Fail("aggregate must not invent a disclosure surface", 100);
  }
  if (readiness.encoder != readiness.capture) {
    return Fail("encoder readiness must track capture", 101);
  }
  if (!adapters->IsAdvertisableNow()) {
    return Fail("a fully qualified X11 session must be advertisable", 102);
  }
  std::printf("aggregate: advertisable=1 (capture+input+display all ready)\n");
  std::printf("linux adapter qualification: ok\n");
  return 0;
}
