#ifndef IMCODES_REMOTE_DESKTOP_LINUX_LINUX_CAPTURE_SELECTION_H_
#define IMCODES_REMOTE_DESKTOP_LINUX_LINUX_CAPTURE_SELECTION_H_

#include <cstdint>
#include <string_view>

#include "linux_capability_probe.h"

namespace imcodes::remote_desktop::linux_platform {

/** Which capture backend a session may actually use. */
enum class CaptureBackend : std::uint8_t {
  /** No qualified backend; the host must keep reporting unsupported. */
  kNone,
  /** Preferred: xdg-desktop-portal ScreenCast negotiating a PipeWire stream. */
  kPortalPipeWire,
  /** Explicit fallback: direct X11 server capture (XShm when available). */
  kX11Shm,
};

/**
 * Choose the capture backend for a session.
 *
 * Portal/PipeWire is preferred wherever it is genuinely available, because it
 * is the only sanctioned path under Wayland and it keeps the compositor in
 * control of consent. X11 is an explicit, deliberately narrower fallback: it
 * is only selected when the session really is X11, never as a way to work
 * around a Wayland session whose portal refused.
 *
 * Selecting a backend is not permission to stream. `ProbeCaptureReadiness`
 * still gates the session, and a backend may be selected while readiness is
 * unavailable — the caller must check both.
 */
[[nodiscard]] CaptureBackend SelectCaptureBackend(const SessionFacts& facts) noexcept;

/** Stable identifier for logs, evidence and readiness reporting. */
[[nodiscard]] std::string_view CaptureBackendName(CaptureBackend backend) noexcept;

/**
 * Whether the selected backend is usable right now.
 *
 * Both conditions must hold: a backend was selected AND capture readiness
 * proved out. This is the single question a caller should ask before starting
 * a capture, so no call site can accidentally use one half of the answer.
 */
[[nodiscard]] bool CaptureBackendUsable(const SessionFacts& facts) noexcept;

}  // namespace imcodes::remote_desktop::linux_platform

#endif  // IMCODES_REMOTE_DESKTOP_LINUX_LINUX_CAPTURE_SELECTION_H_
