// What the viewer and the worker's log are told is actually encoding a route:
// the description builder and the worker's small event log. libwebrtc-free.
#include <sys/stat.h>
#include <unistd.h>

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "../remote-desktop-common/data_channel_constants.h"
#include "encoder_description.h"
#include "worker_video_log.h"

namespace common = imcodes::remote_desktop::common;
namespace macos = imcodes::remote_desktop::macos;
namespace fs = std::filesystem;

namespace {

void Require(bool condition, std::string_view message) {
  if (condition) return;
  std::cerr << "encoder description failure: " << message << '\n';
  std::exit(1);
}

macos::EncoderDescriptionInput Input(macos::NegotiatedVideoCodec negotiated, bool raw_allowed) {
  macos::EncoderDescriptionInput input;
  input.negotiated = negotiated;
  input.raw_codecs_allowed = raw_allowed;
  input.policy.reason = raw_allowed ? macos::RawCodecReason::kAllowed : macos::RawCodecReason::kHardwareH264;
  return input;
}

void BeforeNegotiationNothingIsClaimed() {
  const macos::EncoderDescription d = macos::DescribeEncoder(Input(macos::NegotiatedVideoCodec::kUnknown, true));
  Require(d.codec == imcodes::rd::kEncoderCodecPending, "pending");
  Require(d.implementation == imcodes::rd::kEncoderClassSoftware, "never hardware without proof");
  Require(d.threads == 0 && d.raw_codecs == imcodes::rd::kRawCodecsAllowed, "policy is still reported");
}

void Vp9IsReportedAsLibvpxSoftwareWithItsThreads() {
  macos::EncoderDescriptionInput input = Input(macos::NegotiatedVideoCodec::kVp9, true);
  macos::RawEncoderFacts facts;
  facts.codec = macos::NegotiatedVideoCodec::kVp9;
  facts.implementation = "libvpx";
  facts.cores = 12;
  facts.width = 2560;
  facts.height = 1350;
  input.raw_facts = facts;
  const macos::EncoderDescription d = macos::DescribeEncoder(input);
  Require(d.codec == imcodes::rd::kEncoderCodecVp9 && d.implementation == imcodes::rd::kEncoderClassSoftware, "vp9 software");
  Require(d.name == "libvpx" && d.threads == 12, "the encoder's own name and the capped core count");

  input.negotiated = macos::NegotiatedVideoCodec::kVp8;
  Require(macos::DescribeEncoder(input).codec == imcodes::rd::kEncoderCodecVp8, "vp8");

  input.raw_facts.reset();
  const macos::EncoderDescription before_init = macos::DescribeEncoder(Input(macos::NegotiatedVideoCodec::kVp9, true));
  Require(before_init.name == "libvpx" && before_init.threads == 0, "negotiated but the encoder has not reported yet: still libvpx, threads unknown");
  facts.implementation.clear();
  input.negotiated = macos::NegotiatedVideoCodec::kVp9;
  input.raw_facts = facts;
  Require(macos::DescribeEncoder(input).name == "libvpx", "an empty implementation name falls back to libvpx");
}

void H264IsReportedByTheVideoToolboxClass() {
  macos::EncoderDescriptionInput input = Input(macos::NegotiatedVideoCodec::kH264, false);
  input.h264_class = common::EncoderClass::kHardware;
  macos::EncoderDescription d = macos::DescribeEncoder(input);
  Require(d.codec == imcodes::rd::kEncoderCodecH264 && d.implementation == imcodes::rd::kEncoderClassHardware, "hardware");
  Require(d.name == "VideoToolbox (hardware)", "hardware name");
  input.h264_class = common::EncoderClass::kSoftware;
  d = macos::DescribeEncoder(input);
  Require(d.implementation == imcodes::rd::kEncoderClassSoftware && d.name == "Apple H.264 (SW)", "software");
  input.h264_class = common::EncoderClass::kUnknown;
  Require(macos::DescribeEncoder(input).implementation == imcodes::rd::kEncoderClassSoftware, "unknown class is software");
}

void ARawCodecIsOnlyClaimedWhenBothThePolicyAndTheNegotiationSayYes() {
  // VP9 negotiated but this route is not allowed raw codecs (should not happen): not claimed.
  const macos::EncoderDescription d = macos::DescribeEncoder(Input(macos::NegotiatedVideoCodec::kVp9, false));
  Require(d.codec == imcodes::rd::kEncoderCodecPending, "no VP9 claim without the policy");
}

void TheKillSwitchIsVisibleOnAnH264Route() {
  macos::EncoderDescriptionInput input = Input(macos::NegotiatedVideoCodec::kH264, false);
  input.policy.reason = macos::RawCodecReason::kDisabledBySetting;
  input.h264_class = common::EncoderClass::kSoftware;
  const macos::EncoderDescription d = macos::DescribeEncoder(input);
  Require(d.codec == imcodes::rd::kEncoderCodecH264 && d.raw_codecs == imcodes::rd::kRawCodecsDisabledBySetting,
          "H.264 forced by the setting says so");
  input.policy.reason = macos::RawCodecReason::kCaptureCannotScale;
  Require(macos::DescribeEncoder(input).raw_codecs == imcodes::rd::kRawCodecsCaptureCannotScale, "capture reason");
  input.policy.reason = macos::RawCodecReason::kHardwareH264;
  Require(macos::DescribeEncoder(input).raw_codecs == imcodes::rd::kRawCodecsHardwareH264, "hardware reason");
}

void TheLogLineHasNoFreeTextAndNoNewline() {
  macos::EncoderDescriptionInput input = Input(macos::NegotiatedVideoCodec::kVp9, true);
  macos::RawEncoderFacts facts;
  facts.codec = macos::NegotiatedVideoCodec::kVp9;
  facts.implementation = "libvpx";
  facts.cores = 8;
  input.raw_facts = facts;
  input.policy.setting_source = macos::RawCodecSettingSource::kFile;
  input.policy.nv12_capture = true;
  input.policy.invalid_value_ignored = true;
  const std::string line = macos::FormatEncoderLogLine("encoder", macos::DescribeEncoder(input), input.policy, 2560, 1350);
  Require(line == "event=encoder codec=vp9 implementation=software name=\"libvpx\" threads=8 size=2560x1350 "
                  "raw_codecs=allowed setting_source=file nv12_capture=1 invalid_value_ignored=1", line);
  Require(line.find('\n') == std::string::npos, "one line");
}

void AViewerWhoJustOpenedItsChannelIsTold() {
  macos::EncoderDescriptionInput input = Input(macos::NegotiatedVideoCodec::kVp9, true);
  const macos::EncoderDescription vp9 = macos::DescribeEncoder(input);
  const macos::EncoderDescription pending = macos::DescribeEncoder(Input(macos::NegotiatedVideoCodec::kUnknown, true));
  macos::EncoderAnnouncement announcement;
  Require(!announcement.Needed(pending), "nothing before a codec exists");
  Require(announcement.Needed(vp9), "the first description is owed");
  Require(announcement.Needed(vp9), "and stays owed until the channel took it");
  announcement.Sent(vp9);
  Require(!announcement.Needed(vp9), "an unchanged description is not repeated to a viewer that has it");
  // The control channel re-opens (a new peer, another viewer): the same description is owed again.
  announcement.ChannelOpened();
  Require(announcement.Needed(vp9), "a re-opened channel is told again although nothing changed");
  announcement.Sent(vp9);
  announcement.ChannelOpened();
  Require(announcement.Needed(vp9), "every open, not only the second");
  announcement.Sent(vp9);
  // A change is sent; the same change is not repeated.
  macos::EncoderDescriptionInput h264_input = Input(macos::NegotiatedVideoCodec::kH264, false);
  h264_input.h264_class = common::EncoderClass::kSoftware;
  const macos::EncoderDescription h264 = macos::DescribeEncoder(h264_input);
  Require(announcement.Needed(h264), "a change is owed");
  announcement.Sent(h264);
  Require(!announcement.Needed(h264), "and sent once");
  // Pending after a codec was announced (the encoder was released) is still not announced.
  Require(!announcement.Needed(pending), "pending is never announced");
}

fs::path MakeTemp() {
  std::string pattern = (fs::temp_directory_path() / "imcodes-rd-vlog-XXXXXX").string();
  std::vector<char> buffer(pattern.begin(), pattern.end());
  buffer.push_back('\0');
  Require(::mkdtemp(buffer.data()) != nullptr, "mkdtemp");
  return fs::path(buffer.data());
}

std::string Slurp(const fs::path& path) {
  std::ifstream in(path, std::ios::binary);
  std::stringstream buffer;
  buffer << in.rdbuf();
  return buffer.str();
}

void TheLogAppendsTimestampedSanitisedLinesWithMode0600() {
  const fs::path dir = MakeTemp();
  macos::WorkerVideoLog log(macos::WorkerVideoLogPath(dir.string()));
  Require(log.path() == (dir / "worker-video.log").string(), "path inside the runtime directory");
  Require(log.Append("event=a x=1") && log.Append("evil\nnewline\x01 and\rcr"), "append");
  const std::string text = Slurp(log.path());
  std::istringstream lines(text);
  std::string first, second, extra;
  std::getline(lines, first);
  std::getline(lines, second);
  Require(!std::getline(lines, extra), "exactly two lines: an embedded newline did not split a line");
  Require(first.size() > 25 && first[4] == '-' && first[10] == 'T' && first.find("Z event=a x=1") != std::string::npos, "UTC timestamp then the line");
  Require(second.find("evil newline  and cr") != std::string::npos, "control bytes became spaces");
  struct stat info {};
  Require(::stat(log.path().c_str(), &info) == 0 && (info.st_mode & 0777) == 0600, "mode 0600");
  Require(!macos::WorkerVideoLog("").Append("x"), "an empty path disables the log");
  Require(macos::WorkerVideoLogPath("").empty() && macos::WorkerVideoLogPath("/a/b/") == "/a/b/worker-video.log", "path helper");
  fs::remove_all(dir);
}

void ALongLineIsCutAndTheFileIsBoundedByRotation() {
  const fs::path dir = MakeTemp();
  macos::WorkerVideoLog log((dir / "v.log").string(), 2000);
  Require(log.Append(std::string(5000, 'x')), "long line accepted");
  Require(Slurp(dir / "v.log").size() <= macos::kWorkerVideoLogMaxLineBytes + 2, "cut at the line bound");
  for (int i = 0; i < 40; ++i) Require(log.Append("event=fill " + std::to_string(i)), "fill");
  Require(fs::exists(dir / "v.log.1"), "rotated once the bound was passed");
  Require(fs::file_size(dir / "v.log") <= 2000 && fs::file_size(dir / "v.log.1") <= 2000, "each file within the bound");
  const std::string live = Slurp(dir / "v.log");
  Require(live.find("fill 39") != std::string::npos, "the newest line is in the live file");
  fs::remove_all(dir);
}

void ASymlinkIsRefused() {
  const fs::path dir = MakeTemp();
  const fs::path target = dir / "victim";
  { std::ofstream(target) << "keep\n"; }
  fs::create_symlink(target, dir / "worker-video.log");
  macos::WorkerVideoLog log(macos::WorkerVideoLogPath(dir.string()));
  Require(!log.Append("event=planted"), "a planted symlink is refused (O_NOFOLLOW)");
  Require(Slurp(target) == "keep\n", "the symlink's target is untouched");
  fs::remove_all(dir);
}

void ConcurrentAppendsStayWholeLines() {
  const fs::path dir = MakeTemp();
  macos::WorkerVideoLog shared(macos::WorkerVideoLogPath(dir.string()));
  macos::WorkerVideoLog second(macos::WorkerVideoLogPath(dir.string()));  // another route: own mutex, same file
  std::vector<std::thread> threads;
  for (int t = 0; t < 6; ++t)
    threads.emplace_back([&, t] {
      macos::WorkerVideoLog& log = t % 2 == 0 ? shared : second;
      for (int i = 0; i < 100; ++i) (void)log.Append("event=race thread=" + std::to_string(t) + " n=" + std::to_string(i));
    });
  for (auto& thread : threads) thread.join();
  std::istringstream lines(Slurp(dir / "worker-video.log"));
  std::string line;
  int count = 0;
  while (std::getline(lines, line)) {
    ++count;
    Require(line.find(" event=race thread=") != std::string::npos && line.back() != 'x' && line.find("n=") != std::string::npos,
            "an interleaved or torn line: " + line);
  }
  Require(count == 600, "every line arrived whole (600 expected)");
  fs::remove_all(dir);
}

}  // namespace

int main() {
  BeforeNegotiationNothingIsClaimed();
  Vp9IsReportedAsLibvpxSoftwareWithItsThreads();
  H264IsReportedByTheVideoToolboxClass();
  ARawCodecIsOnlyClaimedWhenBothThePolicyAndTheNegotiationSayYes();
  TheKillSwitchIsVisibleOnAnH264Route();
  TheLogLineHasNoFreeTextAndNoNewline();
  AViewerWhoJustOpenedItsChannelIsTold();
  TheLogAppendsTimestampedSanitisedLinesWithMode0600();
  ALongLineIsCutAndTheFileIsBoundedByRotation();
  ASymlinkIsRefused();
  ConcurrentAppendsStayWholeLines();
  std::cout << "encoder description counterfactuals passed\n";
  return 0;
}
