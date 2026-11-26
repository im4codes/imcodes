#ifndef IMCODES_REMOTE_DESKTOP_COMMON_VIDEO_SENDER_BITRATE_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_VIDEO_SENDER_BITRATE_H_

// Header-only on purpose: it needs libwebrtc, which the platform-neutral
// common target does not link. Each worker includes it from its own
// libwebrtc-linked sources.

#include <cstdint>

#include "api/media_stream_interface.h"
#include "api/peer_connection_interface.h"
#include "api/rtp_parameters.h"
#include "api/rtp_sender_interface.h"

namespace imcodes::rd {

// Bounds every video encoding the peer sends.
//
// An encoding without max_bitrate_bps is capped by libwebrtc at
// GetMaxDefaultVideoBitrateKbps() -- 2.5 Mbps for anything above 960x540 --
// whatever the bandwidth estimate or SetBitrate() allow (pinned revision,
// video/config/encoder_stream_factory.cc). Measured on a 5K Mac: the encoder
// target settled at exactly 2.50 Mbps on a direct route, i.e. 720p15.
//
// Call it once, before negotiation, with the hard per-viewer maximum. After
// negotiation a changed bound reconfigures -- and may reset -- the encoder;
// a viewer's own ceiling moves the estimator bound (SetBitrate) instead.
//
// Returns false when a video sender refused the parameters; true otherwise,
// including when there is no video sender yet.
inline bool ApplyVideoSenderBitrateLimits(webrtc::PeerConnectionInterface& peer,
                                          std::uint32_t min_bps,
                                          std::uint32_t max_bps) {
  for (const auto& sender : peer.GetSenders()) {
    if (!sender->track() || sender->track()->kind() !=
                                webrtc::MediaStreamTrackInterface::kVideoKind) {
      continue;
    }
    webrtc::RtpParameters parameters = sender->GetParameters();
    for (webrtc::RtpEncodingParameters& encoding : parameters.encodings) {
      encoding.min_bitrate_bps = static_cast<int>(min_bps);
      encoding.max_bitrate_bps = static_cast<int>(max_bps);
    }
    if (!parameters.encodings.empty() && !sender->SetParameters(parameters).ok()) {
      return false;
    }
  }
  return true;
}

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_VIDEO_SENDER_BITRATE_H_
