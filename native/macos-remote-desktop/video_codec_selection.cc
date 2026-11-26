#include "video_codec_selection.h"

#include <cctype>
#include <charconv>
#include <cstddef>
#include <map>
#include <optional>
#include <utility>

namespace imcodes::remote_desktop::macos {
namespace {

std::string Upper(std::string_view text) {
  std::string out(text);
  for (char& c : out)
    c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
  return out;
}

bool IsUtilityCodec(std::string_view upper_name) {
  return upper_name == "RTX" || upper_name == "RED" || upper_name == "ULPFEC" ||
         upper_name == "FLEXFEC-03";
}

std::vector<std::string_view> Split(std::string_view text, char separator) {
  std::vector<std::string_view> parts;
  while (!text.empty()) {
    const std::size_t at = text.find(separator);
    const std::string_view part = text.substr(0, at);
    if (!part.empty()) parts.push_back(part);
    if (at == std::string_view::npos) break;
    text.remove_prefix(at + 1);
  }
  return parts;
}

std::optional<int> ParseInt(std::string_view text) {
  int value = 0;
  const auto result = std::from_chars(text.data(), text.data() + text.size(), value);
  if (result.ec != std::errc() || result.ptr != text.data() + text.size())
    return std::nullopt;
  return value;
}

// The first m=video section: its m= line payload types and its rtpmap names.
struct VideoSection {
  std::vector<int> payload_order;
  std::map<int, std::string> names;  // payload type -> upper-case codec name
};

std::optional<VideoSection> FirstVideoSection(std::string_view sdp) {
  VideoSection section;
  bool in_video = false;
  bool found = false;
  while (!sdp.empty()) {
    const std::size_t end = sdp.find('\n');
    std::string_view line = sdp.substr(0, end);
    sdp = end == std::string_view::npos ? std::string_view{} : sdp.substr(end + 1);
    while (!line.empty() && (line.back() == '\r' || line.back() == ' '))
      line.remove_suffix(1);
    if (line.rfind("m=", 0) == 0) {
      if (found) break;  // only the first video section
      if (line.rfind("m=video ", 0) != 0) {
        in_video = false;
        continue;
      }
      // m=video <port> <proto> <pt>...
      const std::vector<std::string_view> fields = Split(line, ' ');
      if (fields.size() < 4) return std::nullopt;
      const std::optional<int> port = ParseInt(fields[1]);
      if (!port.has_value() || *port == 0) return std::nullopt;  // rejected
      for (std::size_t i = 3; i < fields.size(); ++i) {
        if (const std::optional<int> pt = ParseInt(fields[i]))
          section.payload_order.push_back(*pt);
      }
      in_video = true;
      found = true;
      continue;
    }
    if (!in_video || line.rfind("a=rtpmap:", 0) != 0) continue;
    // a=rtpmap:<pt> <name>/<clock>[/<channels>]
    const std::string_view rest = line.substr(9);
    const std::size_t space = rest.find(' ');
    if (space == std::string_view::npos) continue;
    const std::optional<int> pt = ParseInt(rest.substr(0, space));
    if (!pt.has_value()) continue;
    std::string_view name = rest.substr(space + 1);
    name = name.substr(0, name.find('/'));
    section.names[*pt] = Upper(name);
  }
  if (!found) return std::nullopt;
  return section;
}

}  // namespace

int AnswerCodecRank(std::string_view codec_name, bool raw_allowed) {
  if (!raw_allowed) return 0;
  const std::string name = Upper(codec_name);
  if (name == "VP9") return 0;
  if (name == "VP8") return 1;
  if (name == "H264") return 2;
  return 3;
}

std::vector<std::string> ListVideoCodecNames(std::string_view sdp) {
  std::vector<std::string> names;
  const std::optional<VideoSection> section = FirstVideoSection(sdp);
  if (!section.has_value()) return names;
  for (const int pt : section->payload_order) {
    const auto it = section->names.find(pt);
    if (it != section->names.end()) names.push_back(it->second);
  }
  return names;
}

NegotiatedVideoCodec ParseAnsweredVideoCodec(std::string_view answer_sdp) {
  for (const std::string& name : ListVideoCodecNames(answer_sdp)) {
    if (IsUtilityCodec(name)) continue;
    if (name == "VP9") return NegotiatedVideoCodec::kVp9;
    if (name == "VP8") return NegotiatedVideoCodec::kVp8;
    if (name == "H264") return NegotiatedVideoCodec::kH264;
    return NegotiatedVideoCodec::kUnknown;  // a codec this node does not produce
  }
  return NegotiatedVideoCodec::kUnknown;
}

}  // namespace imcodes::remote_desktop::macos
