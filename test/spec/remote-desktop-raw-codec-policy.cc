#include <cstdlib>
#include <iostream>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "raw_codec_policy.h"
#include "raw_codec_settings.h"

namespace macos = imcodes::remote_desktop::macos;

namespace {

void Require(bool condition, std::string_view message) {
  if (condition) return;
  std::cerr << "raw codec policy failure: " << message << '\n';
  std::exit(1);
}

void OnlyANoHardwareMacWhoseCaptureScalesMayOfferRawCodecs() {
  // CGDisplayStream on a Mac with only Apple's software H.264 encoder: the case
  // the whole path exists for.
  const macos::RawCodecDecision pro = macos::DecideRawCodecs(false, true);
  Require(pro.allowed && pro.reason == macos::RawCodecReason::kAllowed, "no hardware + scalable capture: allowed");

  // A Mac with a hardware encoder keeps it, whatever the capture can do.
  Require(!macos::DecideRawCodecs(true, true).allowed, "hardware H.264: not allowed");
  Require(macos::DecideRawCodecs(true, true).reason == macos::RawCodecReason::kHardwareH264, "reason: hardware");
  Require(!macos::DecideRawCodecs(true, false).allowed, "hardware + unscalable capture: not allowed");
  Require(macos::DecideRawCodecs(true, false).reason == macos::RawCodecReason::kHardwareH264,
          "hardware wins as the stated reason");

  // ScreenCaptureKit (macOS >= 13) without a hardware encoder, e.g. a VM: the
  // capture would hand libvpx native-size frames forever, so H.264 stays.
  const macos::RawCodecDecision vm = macos::DecideRawCodecs(false, false);
  Require(!vm.allowed && vm.reason == macos::RawCodecReason::kCaptureCannotScale,
          "no hardware but capture cannot scale: stays on H.264");
}

void ReasonsHaveStableLogTokens() {
  Require(std::string_view(macos::RawCodecReasonName(macos::RawCodecReason::kAllowed)) == "allowed", "allowed");
  Require(std::string_view(macos::RawCodecReasonName(macos::RawCodecReason::kHardwareH264)) == "hardware_h264", "hardware");
  Require(std::string_view(macos::RawCodecReasonName(macos::RawCodecReason::kCaptureCannotScale)) == "capture_cannot_scale",
          "cannot scale");
}

macos::RawCodecEnvironmentLookup Env(const std::map<std::string, std::string>& values) {
  return [&values](const char* name) -> const char* {
    const auto it = values.find(name);
    return it == values.end() ? nullptr : it->second.c_str();
  };
}

struct FakeFiles {
  std::map<std::string, std::string> files;
  mutable std::vector<std::string> asked;
  macos::RawCodecFileReader Reader() const {
    return [this](const std::string& path) -> std::optional<std::string> {
      asked.push_back(path);
      const auto it = files.find(path);
      if (it == files.end()) return std::nullopt;
      return it->second;
    };
  }
};

void TheSettingValuesAreAutoAndOffOnly() {
  Require(macos::ParseRawCodecSetting("auto") == macos::RawCodecSetting::kAuto, "auto");
  Require(macos::ParseRawCodecSetting("OFF") == macos::RawCodecSetting::kOff, "case-insensitive");
  Require(macos::ParseRawCodecSetting("  off\r\n") == macos::RawCodecSetting::kOff, "blanks and CRLF");
  for (const char* bad : {"", "on", "false", "0", "disabled", "of f", "autooff", "vp9"})
    Require(!macos::ParseRawCodecSetting(bad).has_value(), bad);
}

void TheConfigFileIsReadLikeAShellWould() {
  Require(!macos::ParseRawCodecConfig("").raw_codecs.has_value(), "empty file");
  Require(!macos::ParseRawCodecConfig("# rawCodecs=off\n\n  \nother=1\n").raw_codecs.has_value(),
          "comments, blanks and other keys are not the key");
  Require(macos::ParseRawCodecConfig("rawCodecs=off\n").raw_codecs == macos::RawCodecSetting::kOff, "off");
  Require(macos::ParseRawCodecConfig("  rawCodecs = Off \r\nx=y").raw_codecs == macos::RawCodecSetting::kOff,
          "spaces around the key and value, CRLF");
  Require(macos::ParseRawCodecConfig("rawCodecs=off\nrawCodecs=auto\n").raw_codecs == macos::RawCodecSetting::kAuto,
          "a later line overrides");
  Require(!macos::ParseRawCodecConfig("rawCodecs2=off\nxrawCodecs=off\n").raw_codecs.has_value(),
          "only the exact key counts");
  const macos::ParsedConfig typo = macos::ParseRawCodecConfig("rawCodecs=disabled\n");
  Require(!typo.raw_codecs.has_value() && typo.invalid, "a typo is reported and is NOT off");
  const macos::ParsedConfig mixed = macos::ParseRawCodecConfig("rawCodecs=off\nrawCodecs=garbage\n");
  Require(mixed.raw_codecs == macos::RawCodecSetting::kOff && mixed.invalid, "an earlier valid value stays when a later one is bad");
}

void ResolutionPrefersTheEnvironmentThenTheFileThenAuto() {
  FakeFiles none;
  std::map<std::string, std::string> empty;
  macos::RawCodecSettings d = macos::ResolveRawCodecSettings(Env(empty), none.Reader());
  Require(d.raw_codecs == macos::RawCodecSetting::kAuto && d.source == macos::RawCodecSettingSource::kDefault &&
              !d.ignored_invalid_value, "nothing set: auto by default");

  std::map<std::string, std::string> env = {{"IMCODES_RD_RAW_CODECS", "off"}};
  macos::RawCodecSettings e = macos::ResolveRawCodecSettings(Env(env), none.Reader());
  Require(e.raw_codecs == macos::RawCodecSetting::kOff && e.source == macos::RawCodecSettingSource::kEnvironment,
          "environment off");
  Require(none.asked.empty(), "the file is not even read when the environment decided");

  FakeFiles file;
  file.files["/Users/u/.imcodes/remote-desktop-video.conf"] = "rawCodecs=off\n";
  std::map<std::string, std::string> home = {{"HOME", "/Users/u"}};
  macos::RawCodecSettings f = macos::ResolveRawCodecSettings(Env(home), file.Reader());
  Require(f.raw_codecs == macos::RawCodecSetting::kOff && f.source == macos::RawCodecSettingSource::kFile,
          "file off under $HOME/.imcodes");
  Require(file.asked.size() == 1 && file.asked[0] == "/Users/u/.imcodes/remote-desktop-video.conf", "the exact path");

  std::map<std::string, std::string> both = {{"HOME", "/Users/u"}, {"IMCODES_RD_RAW_CODECS", "auto"}};
  macos::RawCodecSettings w = macos::ResolveRawCodecSettings(Env(both), file.Reader());
  Require(w.raw_codecs == macos::RawCodecSetting::kAuto && w.source == macos::RawCodecSettingSource::kEnvironment,
          "environment auto beats a file that says off");

  FakeFiles relocated;
  relocated.files["/srv/state/remote-desktop-video.conf"] = "rawCodecs=off";
  std::map<std::string, std::string> imhome = {{"HOME", "/Users/u"}, {"IMCODES_HOME", "/srv/state"}};
  macos::RawCodecSettings r = macos::ResolveRawCodecSettings(Env(imhome), relocated.Reader());
  Require(r.raw_codecs == macos::RawCodecSetting::kOff && relocated.asked[0] == "/srv/state/remote-desktop-video.conf",
          "IMCODES_HOME relocates the state directory");

  FakeFiles unreadable;
  macos::RawCodecSettings u = macos::ResolveRawCodecSettings(Env(home), unreadable.Reader());
  Require(u.raw_codecs == macos::RawCodecSetting::kAuto && u.source == macos::RawCodecSettingSource::kDefault,
          "a missing file is the default");

  FakeFiles never;
  macos::RawCodecSettings nh = macos::ResolveRawCodecSettings(Env(empty), never.Reader());
  Require(nh.raw_codecs == macos::RawCodecSetting::kAuto && never.asked.empty(), "no HOME and no IMCODES_HOME: no file is guessed");
}

void AnInvalidValueIsIgnoredNeverTreatedAsOff() {
  FakeFiles file;
  file.files["/Users/u/.imcodes/remote-desktop-video.conf"] = "rawCodecs=off\n";
  std::map<std::string, std::string> env = {{"HOME", "/Users/u"}, {"IMCODES_RD_RAW_CODECS", "disable"}};
  macos::RawCodecSettings s = macos::ResolveRawCodecSettings(Env(env), file.Reader());
  Require(s.ignored_invalid_value, "reported");
  Require(s.raw_codecs == macos::RawCodecSetting::kOff && s.source == macos::RawCodecSettingSource::kFile,
          "an invalid environment value falls through to the file");
  FakeFiles nofile;
  std::map<std::string, std::string> only_bad = {{"IMCODES_RD_RAW_CODECS", "disable"}};
  macos::RawCodecSettings b = macos::ResolveRawCodecSettings(Env(only_bad), nofile.Reader());
  Require(b.raw_codecs == macos::RawCodecSetting::kAuto && b.ignored_invalid_value &&
              b.source == macos::RawCodecSettingSource::kDefault,
          "an invalid environment value with nothing else is the default, not off");
  FakeFiles typo;
  typo.files["/Users/u/.imcodes/remote-desktop-video.conf"] = "rawCodecs=disabled\n";
  std::map<std::string, std::string> home = {{"HOME", "/Users/u"}};
  macos::RawCodecSettings t = macos::ResolveRawCodecSettings(Env(home), typo.Reader());
  Require(t.raw_codecs == macos::RawCodecSetting::kAuto && t.ignored_invalid_value, "a typo in the file leaves the default");
}

void OffRestoresTheOldBehaviourWhateverTheMacIs() {
  using macos::RawCodecSetting;
  for (const bool hardware : {false, true})
    for (const bool scales : {false, true}) {
      const macos::RawCodecDecision off = macos::DecideRawCodecs(hardware, scales, RawCodecSetting::kOff);
      Require(!off.allowed && off.reason == macos::RawCodecReason::kDisabledBySetting, "off always disables");
      Require(macos::DecideRawCodecs(hardware, scales, RawCodecSetting::kAuto).allowed == (!hardware && scales),
              "auto: exactly the rules");
      Require(macos::DecideRawCodecs(hardware, scales).allowed == (!hardware && scales), "auto is the default argument");
    }
  Require(std::string_view(macos::RawCodecReasonName(macos::RawCodecReason::kDisabledBySetting)) == "disabled_by_setting", "token");
  Require(std::string_view(macos::RawCodecSettingSourceName(macos::RawCodecSettingSource::kFile)) == "file", "source token");
}

}  // namespace

int main() {
  OnlyANoHardwareMacWhoseCaptureScalesMayOfferRawCodecs();
  ReasonsHaveStableLogTokens();
  TheSettingValuesAreAutoAndOffOnly();
  TheConfigFileIsReadLikeAShellWould();
  ResolutionPrefersTheEnvironmentThenTheFileThenAuto();
  AnInvalidValueIsIgnoredNeverTreatedAsOff();
  OffRestoresTheOldBehaviourWhateverTheMacIs();
  std::cout << "raw codec policy counterfactuals passed\n";
  return 0;
}
