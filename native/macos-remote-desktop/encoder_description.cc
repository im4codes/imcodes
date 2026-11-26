#include "encoder_description.h"

#include <sstream>

namespace imcodes::remote_desktop::macos {
namespace {

constexpr char kLibvpxName[] = "libvpx";
constexpr char kVideoToolboxHardwareName[] = "VideoToolbox (hardware)";
constexpr char kAppleSoftwareName[] = "Apple H.264 (SW)";
constexpr char kPendingName[] = "pending";

}  // namespace

EncoderDescription DescribeEncoder(const EncoderDescriptionInput& input) {
  EncoderDescription description;
  description.raw_codecs = RawCodecReasonName(input.policy.reason);
  // What the route was told about raw codecs and what the negotiation produced are
  // two facts; a raw codec is in use only when BOTH say so.
  const bool raw_in_use = input.raw_codecs_allowed && IsRawCodec(input.negotiated);
  if (raw_in_use) {
    description.codec = input.negotiated == NegotiatedVideoCodec::kVp9
                            ? imcodes::rd::kEncoderCodecVp9
                            : imcodes::rd::kEncoderCodecVp8;
    description.implementation = imcodes::rd::kEncoderClassSoftware;
    description.name = input.raw_facts.has_value() && !input.raw_facts->implementation.empty()
                           ? input.raw_facts->implementation
                           : kLibvpxName;
    description.threads = input.raw_facts.has_value() ? input.raw_facts->cores : 0;
    return description;
  }
  if (input.negotiated == NegotiatedVideoCodec::kH264) {
    description.codec = imcodes::rd::kEncoderCodecH264;
    const bool hardware = input.h264_class == common::EncoderClass::kHardware;
    description.implementation = hardware ? imcodes::rd::kEncoderClassHardware
                                          : imcodes::rd::kEncoderClassSoftware;
    description.name = hardware ? kVideoToolboxHardwareName : kAppleSoftwareName;
    return description;
  }
  // Nothing negotiated yet (or a codec this node does not produce): say so rather
  // than guess. Software is the safe class: hardware is never claimed without proof.
  description.codec = imcodes::rd::kEncoderCodecPending;
  description.implementation = imcodes::rd::kEncoderClassSoftware;
  description.name = kPendingName;
  return description;
}

bool EncoderAnnouncement::Needed(const EncoderDescription& description) const {
  if (description.codec == imcodes::rd::kEncoderCodecPending) return false;
  return !last_sent_.has_value() || !(*last_sent_ == description);
}

void EncoderAnnouncement::Sent(const EncoderDescription& description) {
  last_sent_ = description;
}

std::string FormatEncoderLogLine(const char* event,
                                 const EncoderDescription& description,
                                 const RawCodecPolicyState& policy,
                                 std::uint32_t width, std::uint32_t height) {
  std::ostringstream line;
  line << "event=" << event << " codec=" << description.codec
       << " implementation=" << description.implementation << " name=\""
       << description.name << "\" threads=" << description.threads
       << " size=" << width << "x" << height
       << " raw_codecs=" << description.raw_codecs
       << " setting_source=" << RawCodecSettingSourceName(policy.setting_source)
       << " nv12_capture=" << (policy.nv12_capture ? 1 : 0)
       << " invalid_value_ignored=" << (policy.invalid_value_ignored ? 1 : 0);
  return line.str();
}

}  // namespace imcodes::remote_desktop::macos
