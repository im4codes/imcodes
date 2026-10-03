#ifndef IMCODES_MACOS_REMOTE_DESKTOP_PINNED_LIBWEBRTC_H264_SENDER_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_PINNED_LIBWEBRTC_H264_SENDER_H_

#include <memory>

#include "h264_sender_bridge.h"

namespace webrtc {
class EncodedImageCallback;
}

namespace imcodes::remote_desktop::macos {

// Wraps the encoded-image callback owned by the repository-pinned upstream
// libwebrtc sender. The callback must outlive the returned backend. No network
// or packetization implementation is exposed by this adapter.
std::unique_ptr<H264SenderBackend>
CreatePinnedLibwebrtcH264Sender(webrtc::EncodedImageCallback *callback);

} // namespace imcodes::remote_desktop::macos

#endif // IMCODES_MACOS_REMOTE_DESKTOP_PINNED_LIBWEBRTC_H264_SENDER_H_
