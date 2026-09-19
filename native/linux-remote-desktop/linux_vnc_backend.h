#ifndef IMCODES_REMOTE_DESKTOP_LINUX_LINUX_VNC_BACKEND_H_
#define IMCODES_REMOTE_DESKTOP_LINUX_LINUX_VNC_BACKEND_H_

// A minimal RFB (VNC) protocol CLIENT, used as common::CaptureAdapter's
// fallback path when this host has no X11/XTest access of its own but a VNC
// server is already reachable -- reusing an existing setup instead of
// requiring one. NOT the preferred path: X11CaptureAdapter (direct
// XGetImage, one capture-then-encode hop) is strictly lower latency and
// lower CPU than routing frames through a second, independent RFB
// encode/decode round trip, so LinuxPlatformAdapters::Create() only reaches
// for this when Portal and direct X11 both fail their own readiness probe.
// See linux_platform_adapters.cc's own comment at the call site for the
// exact selection order.
//
// Deliberately minimal for a first, correct slice: RFB 3.3-3.8 version
// handshake, security types None (1) and VNC Authentication (2, the classic
// DES challenge-response -- see the standalone DES implementation in the
// .cc, validated against the FIPS 46-3 published test vector), Raw encoding
// only (no Hextile/Tight/ZRLE -- bandwidth-hungry but trivially correct,
// matching X11CaptureAdapter's own "plain XGetImage over XShm" choice for
// the same reason), full-frame (non-incremental) FramebufferUpdateRequest
// polling rather than dirty-rect tracking.

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <thread>

#include "../remote-desktop-common/platform_interfaces.h"

namespace imcodes::remote_desktop::linux_platform {

/**
 * Decrypt a classic vncpasswd-format password file (the format `x11vnc
 * -storepasswd` / `vncpasswd` write, and `~/.vnc/passwd` traditionally
 * holds): 8 bytes, DES-ECB "encrypted" with the fixed key the RFB spec
 * itself publishes. That fixed key is not a secret -- it is the same for
 * every VNC installation on earth -- so this is a decode, not a break: any
 * program that can read the file can already recover the plaintext
 * password this same way. Returns empty on any read/format failure.
 */
std::string DecryptVncPasswordFile(const std::string& path);

/**
 * A quick, side-effect-free check for "is there really an RFB server
 * listening here" -- a TCP connect plus reading (not answering) the
 * server's version line, with a short timeout. Used both by
 * VncCaptureAdapter::ProbeReadiness() and by LinuxPlatformAdapters::Create()
 * to decide whether VNC is even a candidate before committing to it.
 */
bool ProbeVncServer(const std::string& host, std::uint16_t port,
                    int timeout_ms) noexcept;

class VncCaptureAdapter final : public common::CaptureAdapter {
 public:
  // `password` is optional: pass what DecryptVncPasswordFile() found, or an
  // empty string for a server that only offers security type 1 (None).
  VncCaptureAdapter(std::string host, std::uint16_t port,
                    std::string password) noexcept;
  ~VncCaptureAdapter() override;

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  bool Start(const common::DisplayTopology& display,
             common::CapturedFrameSink sink) override;
  void Stop() noexcept override;

 private:
  void PollLoop(common::PixelSize requested, common::CapturedFrameSink sink);

  std::string host_;
  std::uint16_t port_;
  std::string password_;
  std::atomic<bool> running_{false};
  std::thread poll_thread_;
};

}  // namespace imcodes::remote_desktop::linux_platform

#endif  // IMCODES_REMOTE_DESKTOP_LINUX_LINUX_VNC_BACKEND_H_
