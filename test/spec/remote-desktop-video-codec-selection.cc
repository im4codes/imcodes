// SDP codec choice for the raw (VP9) path: which codec an answer carries, and the
// order this node answers in. Free of libwebrtc.
#include <cstdlib>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

#include "video_codec_selection.h"

namespace macos = imcodes::remote_desktop::macos;
using macos::NegotiatedVideoCodec;

namespace {

void Require(bool condition, std::string_view message) {
  if (condition) return;
  std::cerr << "video codec selection failure: " << message << '\n';
  std::exit(1);
}

// A Chrome-shaped offer: H.264 first (the web client's receive preference), then
// VP8, VP9, AV1, with RTX/RED/FEC entries between.
const char kChromeOffer[] =
    "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\n"
    "a=mid:0\r\na=sctp-port:5000\r\n"
    "m=video 9 UDP/TLS/RTP/SAVPF 102 103 96 97 98 99 100 101 45 46 127 125\r\n"
    "c=IN IP4 0.0.0.0\r\na=mid:1\r\na=recvonly\r\n"
    "a=rtpmap:102 H264/90000\r\na=rtpmap:103 rtx/90000\r\na=fmtp:103 apt=102\r\n"
    "a=rtpmap:96 VP8/90000\r\na=rtpmap:97 rtx/90000\r\na=fmtp:97 apt=96\r\n"
    "a=rtpmap:98 VP9/90000\r\na=fmtp:98 profile-id=0\r\n"
    "a=rtpmap:99 rtx/90000\r\na=fmtp:99 apt=98\r\n"
    "a=rtpmap:100 VP9/90000\r\na=fmtp:100 profile-id=2\r\n"
    "a=rtpmap:101 rtx/90000\r\na=fmtp:101 apt=100\r\n"
    "a=rtpmap:45 AV1/90000\r\na=rtpmap:46 rtx/90000\r\n"
    "a=rtpmap:127 red/90000\r\na=rtpmap:125 ulpfec/90000\r\n";

std::string Answer(const std::string& m_line, const std::string& maps) {
  return "v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
         "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
         m_line + "\r\nc=IN IP4 0.0.0.0\r\na=mid:1\r\na=sendonly\r\n" + maps;
}

void ListsTheOfferedCodecsInPayloadOrder() {
  const std::vector<std::string> names = macos::ListVideoCodecNames(kChromeOffer);
  const std::vector<std::string> expected = {"H264", "RTX", "VP8", "RTX", "VP9", "RTX",
                                             "VP9", "RTX", "AV1", "RTX", "RED", "ULPFEC"};
  Require(names == expected, "m=video payload order, resolved through rtpmap");
  Require(macos::ListVideoCodecNames("v=0\r\nm=audio 9 RTP/AVP 111\r\na=rtpmap:111 opus/48000/2\r\n").empty(),
          "no video section: empty");
  Require(macos::ListVideoCodecNames("m=video 0 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n").empty(),
          "a rejected section (port 0) carries nothing");
  Require(macos::ListVideoCodecNames("m=video 9 UDP/TLS/RTP/SAVPF 96 97\r\na=rtpmap:96 VP8/90000\r\n") ==
              std::vector<std::string>{"VP8"},
          "a payload type with no rtpmap is skipped, not guessed");
  Require(macos::ListVideoCodecNames("m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 vp9/90000\r\n") ==
              std::vector<std::string>{"VP9"},
          "case-insensitive");
}

void TheAnsweredCodecIsTheFirstMediaCodec() {
  Require(macos::ParseAnsweredVideoCodec(Answer("m=video 9 UDP/TLS/RTP/SAVPF 98 99 102",
                                                "a=rtpmap:98 VP9/90000\r\na=rtpmap:99 rtx/90000\r\na=rtpmap:102 H264/90000\r\n")) ==
              NegotiatedVideoCodec::kVp9,
          "VP9 first");
  Require(macos::ParseAnsweredVideoCodec(Answer("m=video 9 UDP/TLS/RTP/SAVPF 103 96 102",
                                                "a=rtpmap:103 rtx/90000\r\na=rtpmap:96 VP8/90000\r\na=rtpmap:102 H264/90000\r\n")) ==
              NegotiatedVideoCodec::kVp8,
          "a leading RTX entry is skipped");
  Require(macos::ParseAnsweredVideoCodec(Answer("m=video 9 UDP/TLS/RTP/SAVPF 102 103",
                                                "a=rtpmap:102 H264/90000\r\na=rtpmap:103 rtx/90000\r\n")) ==
              NegotiatedVideoCodec::kH264,
          "an old node answering only H.264");
  Require(macos::ParseAnsweredVideoCodec(Answer("m=video 9 UDP/TLS/RTP/SAVPF 45", "a=rtpmap:45 AV1/90000\r\n")) ==
              NegotiatedVideoCodec::kUnknown,
          "a codec this node does not produce is never mistaken for one it does");
  Require(macos::ParseAnsweredVideoCodec(Answer("m=video 0 UDP/TLS/RTP/SAVPF 96", "a=rtpmap:96 VP9/90000\r\n")) ==
              NegotiatedVideoCodec::kUnknown,
          "a rejected video section negotiated nothing");
  Require(macos::ParseAnsweredVideoCodec("") == NegotiatedVideoCodec::kUnknown, "empty answer");
  Require(macos::ParseAnsweredVideoCodec("m=video 9 UDP/TLS/RTP/SAVPF 103\r\na=rtpmap:103 rtx/90000\r\n") ==
              NegotiatedVideoCodec::kUnknown,
          "only utility codecs");
}

struct Cap { std::string name; int original_index; };

std::vector<Cap> Capabilities() {
  // What libwebrtc lists for the sender: the order it builds, VP8/VP9/H264 and utility codecs.
  return {{"H264", 0}, {"rtx", 1}, {"VP8", 2}, {"rtx", 3}, {"VP9", 4}, {"rtx", 5}, {"red", 6}, {"ulpfec", 7}};
}

std::vector<std::string> Names(const std::vector<Cap>& caps) {
  std::vector<std::string> out;
  for (const Cap& c : caps) out.push_back(c.name);
  return out;
}

void ANodeWithoutHardwareAnswersVp9ThenVp8ThenH264() {
  std::vector<Cap> caps = Capabilities();
  macos::SortByAnswerPreference(caps, [](const Cap& c) { return c.name; }, true);
  const std::vector<std::string> expected = {"VP9", "VP8", "H264", "rtx", "rtx", "rtx", "red", "ulpfec"};
  Require(Names(caps) == expected, "VP9, VP8, H.264, then the utility codecs in their own order");
  // The utility codecs keep their relative order (a stable sort, not a reshuffle).
  Require(caps[3].original_index == 1 && caps[4].original_index == 3 && caps[5].original_index == 5,
          "RTX entries stay in order");
}

void AHardwareNodeAppliesNoPreferenceAtAll() {
  std::vector<Cap> caps = Capabilities();
  const std::vector<Cap> before = caps;
  macos::SortByAnswerPreference(caps, [](const Cap& c) { return c.name; }, false);
  Require(Names(caps) == Names(before), "order untouched: the answer is what it always was");
  Require(macos::AnswerCodecRank("VP9", false) == macos::AnswerCodecRank("H264", false),
          "no rank difference when raw codecs are off");
}

void AnOfferWithoutVp9FallsThroughToTheNextBestCodec() {
  // Model of libwebrtc's answer: this node's preference order, restricted to what
  // the offer carries.
  const auto first_answered = [](const std::vector<std::string>& offered) {
    std::vector<Cap> caps = Capabilities();
    macos::SortByAnswerPreference(caps, [](const Cap& c) { return c.name; }, true);
    for (const Cap& cap : caps) {
      if (cap.name == "rtx" || cap.name == "red" || cap.name == "ulpfec") continue;
      for (const std::string& name : offered)
        if (name == (cap.name == "VP8" ? "VP8" : cap.name == "VP9" ? "VP9" : "H264"))
          return cap.name;
    }
    return std::string("none");
  };
  Require(first_answered(macos::ListVideoCodecNames(kChromeOffer)) == "VP9", "a full offer: VP9");
  Require(first_answered({"H264", "RTX", "VP8", "RTX"}) == "VP8", "an offer without VP9: VP8");
  Require(first_answered({"H264", "RTX"}) == "H264", "an offer with only H.264: H.264");
  Require(first_answered({"AV1"}) == "none", "nothing we can send");
}

}  // namespace

int main() {
  ListsTheOfferedCodecsInPayloadOrder();
  TheAnsweredCodecIsTheFirstMediaCodec();
  ANodeWithoutHardwareAnswersVp9ThenVp8ThenH264();
  AHardwareNodeAppliesNoPreferenceAtAll();
  AnOfferWithoutVp9FallsThroughToTheNextBestCodec();
  std::cout << "video codec selection counterfactuals passed\n";
  return 0;
}
