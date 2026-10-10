#ifndef IMCODES_MACOS_REMOTE_DESKTOP_ENCODER_DESCRIPTION_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_ENCODER_DESCRIPTION_H_

#include <optional>
#include <string>

#include "../remote-desktop-common/platform_interfaces.h"
#include "raw_video_path.h"

namespace imcodes::remote_desktop::macos {

// What is ACTUALLY encoding a route, in the tokens of the encoder data message
// (data_channel_constants.h). Pure: built from facts the worker already holds, so
// the viewer's status bar, the worker's log and the tests all read one description.
struct EncoderDescription {
  std::string codec;           // kEncoderCodecVp9 / Vp8 / H264 / Pending
  std::string implementation;  // kEncoderClassSoftware / Hardware
  std::string name;            // display only: "libvpx", "Apple H.264 (SW)", ...
  int threads = 0;             // encoder threads / the capped core count, 0 = unknown
  std::string raw_codecs;      // the node's raw-codec decision (kRawCodecs*)

  bool operator==(const EncoderDescription&) const = default;
};

struct EncoderDescriptionInput {
  NegotiatedVideoCodec negotiated = NegotiatedVideoCodec::kUnknown;
  bool raw_codecs_allowed = false;
  std::optional<RawEncoderFacts> raw_facts;
  // The VideoToolbox encoder's class, used only when H.264 is what was negotiated.
  common::EncoderClass h264_class = common::EncoderClass::kUnknown;
  RawCodecPolicyState policy;
};

[[nodiscard]] EncoderDescription DescribeEncoder(const EncoderDescriptionInput& input);

// When to tell a viewer what is encoding. A viewer that has just opened its control
// channel (a new peer after renegotiation or an ICE restart, another viewer on the same
// route) has been told nothing yet and must be told again even if the description has
// not changed; an unchanged description is not repeated to a viewer that already has it;
// nothing is said before a codec exists; and a message the channel did not take stays
// owed. Pure, so the whole rule is tested without a worker.
class EncoderAnnouncement {
 public:
  // True when `description` should be sent now.
  [[nodiscard]] bool Needed(const EncoderDescription& description) const;
  // The channel took the message.
  void Sent(const EncoderDescription& description);
  // A (re)opened control channel: whoever is on the other end knows nothing yet.
  void ChannelOpened() { last_sent_.reset(); }

 private:
  std::optional<EncoderDescription> last_sent_;
};

// One log line of key=value pairs, no free text and nothing from the user's
// content. `event` names why it is written (decision, started, changed).
[[nodiscard]] std::string FormatEncoderLogLine(
    const char* event, const EncoderDescription& description,
    const RawCodecPolicyState& policy, std::uint32_t width, std::uint32_t height);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_ENCODER_DESCRIPTION_H_
