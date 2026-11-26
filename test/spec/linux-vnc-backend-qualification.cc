// Real-target qualification for VncCaptureAdapter: no mocks, no loopback
// fixture -- connects to an actual x11vnc server (host/port from argv,
// defaulting to 127.0.0.1:5900) and proves the DES self-check, the RFB
// handshake, and a handful of real captured frames all work end to end.
#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>

#include "../../native/linux-remote-desktop/linux_vnc_backend.h"
#include "../../native/remote-desktop-common/value_types.h"

using imcodes::remote_desktop::linux_platform::DecryptVncPasswordFile;
using imcodes::remote_desktop::linux_platform::ProbeVncServer;
using imcodes::remote_desktop::linux_platform::VncCaptureAdapter;
using imcodes::remote_desktop::common::CapturedFrame;
using imcodes::remote_desktop::common::DisplayTopology;
using imcodes::remote_desktop::common::DisplayTopology;

int main(int argc, char** argv) {
  const std::string host = argc > 1 ? argv[1] : "127.0.0.1";
  const std::uint16_t port = argc > 2 ? static_cast<std::uint16_t>(std::atoi(argv[2])) : 5900;
  const std::string password_file = argc > 3 ? argv[3] : "";

  if (!ProbeVncServer(host, port, 1000)) {
    std::fprintf(stderr, "FAILED: ProbeVncServer could not reach %s:%d\n", host.c_str(), port);
    return 1;
  }
  std::fprintf(stderr, "ok -- ProbeVncServer found a real RFB server at %s:%d\n", host.c_str(), port);

  std::string password;
  if (!password_file.empty()) {
    password = DecryptVncPasswordFile(password_file);
    if (password.empty()) {
      std::fprintf(stderr, "FAILED: DecryptVncPasswordFile produced nothing from %s\n", password_file.c_str());
      return 2;
    }
    std::fprintf(stderr, "ok -- decrypted a %zu-byte password from %s\n", password.size(), password_file.c_str());
  }

  VncCaptureAdapter adapter(host, port, password);
  if (adapter.ProbeReadiness() != imcodes::remote_desktop::common::ReadinessState::kReady) {
    std::fprintf(stderr, "FAILED: VncCaptureAdapter::ProbeReadiness() != kReady\n");
    return 3;
  }
  std::fprintf(stderr, "ok -- VncCaptureAdapter::ProbeReadiness() == kReady\n");

  int frames_received = 0;
  int last_width = 0, last_height = 0;
  DisplayTopology topology;  // encoded_pixels left invalid on purpose: the
                             // adapter must fall back to the server's own
                             // ServerInit size, exercising that path too.
  const bool started = adapter.Start(topology, [&](CapturedFrame frame) {
    ++frames_received;
    last_width = static_cast<int>(frame.encoded_pixels.width);
    last_height = static_cast<int>(frame.encoded_pixels.height);
    const std::size_t expected_size =
        static_cast<std::size_t>(frame.row_bytes) * frame.encoded_pixels.height;
    if (frame.storage == nullptr || frame.storage->size() != expected_size) {
      std::fprintf(stderr, "FAILED: frame storage size mismatch (%zu vs expected %zu)\n",
                   frame.storage ? frame.storage->size() : 0, expected_size);
      std::exit(4);
    }
    if (frame.pixel_format != imcodes::remote_desktop::common::PixelFormat::kBgra8888) {
      std::fprintf(stderr, "FAILED: frame is not BGRA8888\n");
      std::exit(5);
    }
  });
  if (!started) {
    std::fprintf(stderr, "FAILED: VncCaptureAdapter::Start() returned false\n");
    return 6;
  }

  // Give the poll thread real wall-clock time to connect, handshake, and
  // deliver several frames at its ~30fps cadence.
  const int wait_ms = argc > 4 ? std::atoi(argv[4]) : 1500;
  std::this_thread::sleep_for(std::chrono::milliseconds(wait_ms));
  adapter.Stop();

  if (frames_received < 3) {
    std::fprintf(stderr, "FAILED: only received %d frame(s) in %dms\n", frames_received, wait_ms);
    return 7;
  }
  std::fprintf(stderr, "ok -- received %d real VNC frames, %dx%d\n",
              frames_received, last_width, last_height);
  return 0;
}
