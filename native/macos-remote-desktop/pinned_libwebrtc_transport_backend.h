#ifndef IMCODES_MACOS_REMOTE_DESKTOP_PINNED_LIBWEBRTC_TRANSPORT_BACKEND_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_PINNED_LIBWEBRTC_TRANSPORT_BACKEND_H_

#include <memory>

#include "macos_transport_session_adapter.h"

namespace imcodes::remote_desktop::macos {

// Builds the PeerConnection backend on the repository-pinned upstream
// libwebrtc. ICE, DTLS-SRTP, SCTP, RTP/RTCP, pacing and congestion control are
// upstream's; this translation unit only creates the peer, opens the three
// required DataChannels and forwards observer callbacks back into `adapter`
// with the route stamp attached.
//
// The caller must call BindAdapter() on the result before StartTransport().
// Returns nullptr only when allocation fails, so a caller can never mistake a
// missing transport for a working one.
std::unique_ptr<MacosPeerConnectionBackend>
CreatePinnedLibwebrtcTransportBackend();

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_PINNED_LIBWEBRTC_TRANSPORT_BACKEND_H_
