// CGDisplayStream capture backend for pre-14.4 login windows.
//
// This exists because ScreenCaptureKit only serves the login window from macOS
// 14.4. Below that the only API that can see the login screen is
// CGDisplayStream, so a build that ships to both needs both.
//
// It implements `ScreenCaptureKitBackend` rather than introducing a second
// interface. That is the whole point: the LoginWindow supervisor drives
// whichever backend it selects with one identical set of enumeration, start,
// first-frame, backpressure and teardown bounds, and a second interface would
// let this path quietly acquire its own.
//
// CGDisplayStream is deprecated. That is accepted knowingly and confined to the
// implementation file: the replacement is the very API that cannot serve this
// surface on the releases this backend exists for.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_CG_DISPLAY_STREAM_BACKEND_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_CG_DISPLAY_STREAM_BACKEND_H_

#include <memory>

#include "screen_capture_kit_adapter.h"

namespace imcodes::remote_desktop::macos {

/**
 * Creates the real CGDisplayStream backend.
 *
 * Returns null when CoreGraphics reports no usable display, so a caller cannot
 * mistake "constructed" for "able to capture". Readiness is probed, never
 * requested: TCC onboarding stays an explicit local-product responsibility.
 */
[[nodiscard]] std::unique_ptr<ScreenCaptureKitBackend>
CreateCgDisplayStreamBackend();

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_CG_DISPLAY_STREAM_BACKEND_H_
