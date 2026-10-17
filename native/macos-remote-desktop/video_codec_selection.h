#ifndef IMCODES_MACOS_REMOTE_DESKTOP_VIDEO_CODEC_SELECTION_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_VIDEO_CODEC_SELECTION_H_

#include <algorithm>
#include <string>
#include <string_view>
#include <vector>

#include "raw_video_path.h"

namespace imcodes::remote_desktop::macos {

// SDP-level codec choice, free of libwebrtc so the negotiation rules are
// testable without a pinned checkout.
//
// The browser is the offerer and lists every codec it can receive (its own
// preference puts H.264 first, but nothing is removed). This node answers, and
// the answer's codec order is what picks the codec it SENDS. A Mac with no
// hardware H.264 encoder prefers VP9 (libvpx, several times faster than Apple's
// software H.264 on the same cores), then VP8, then H.264; any other Mac applies
// no preference and answers exactly as before.

// Lower rank is answered earlier. With raw codecs not allowed every codec has the
// same rank, so a stable sort changes nothing. Codecs that are neither VP9, VP8
// nor H.264 (RTX, RED, FEC) rank after them, keeping their relative order.
[[nodiscard]] int AnswerCodecRank(std::string_view codec_name, bool raw_allowed);

// Orders `codecs` (anything with a codec name) by AnswerCodecRank, stably.
template <class Codec, class NameOf>
void SortByAnswerPreference(std::vector<Codec>& codecs, NameOf name_of,
                            bool raw_allowed) {
  if (!raw_allowed) return;
  std::stable_sort(codecs.begin(), codecs.end(),
                   [&](const Codec& a, const Codec& b) {
                     return AnswerCodecRank(name_of(a), true) <
                            AnswerCodecRank(name_of(b), true);
                   });
}

// Codec names (upper case) on the first m=video section of `sdp`, in the order of
// its m= line (payload-type order), resolved through a=rtpmap. Empty when there
// is no video section, or it is rejected (port 0). Includes RTX/RED/FEC entries.
[[nodiscard]] std::vector<std::string> ListVideoCodecNames(std::string_view sdp);

// The codec a video section actually carries: its first entry that is a media
// codec (not RTX/RED/FEC). kUnknown for no section, a rejected one, or a codec
// this node does not produce.
[[nodiscard]] NegotiatedVideoCodec ParseAnsweredVideoCodec(
    std::string_view answer_sdp);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_VIDEO_CODEC_SELECTION_H_
