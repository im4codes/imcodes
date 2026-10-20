#ifndef IMCODES_MACOS_REMOTE_DESKTOP_RAW_CODEC_SETTINGS_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_RAW_CODEC_SETTINGS_H_

#include <functional>
#include <optional>
#include <string>
#include <string_view>

#include "raw_codec_policy.h"

namespace imcodes::remote_desktop::macos {

// The kill switch for the VP9/VP8 path. `auto` (the default) lets a Mac with no
// hardware H.264 encoder use it; `off` restores the H.264 behaviour exactly.
//
// Where it is read, in order (the first one that states a valid value wins):
//   1. the environment variable IMCODES_RD_RAW_CODECS=auto|off of the worker;
//   2. the line `rawCodecs=auto|off` in remote-desktop-video.conf in the state
//      directory of the user the worker runs as: $IMCODES_HOME if set, else
//      $HOME/.imcodes (blank lines and `#` comments allowed, nothing else is read);
//   3. the default, auto.
// An unrecognised value is ignored (and reported), never treated as `off`: a typo
// must not silently disable what the user asked for, nor enable anything extra.
//
// The worker reads it once per remote-desktop route, i.e. at the start of each
// session, so editing the file takes effect on the next session with no restart of
// the worker or of the OS session.

inline constexpr char kRawCodecsEnvVar[] = "IMCODES_RD_RAW_CODECS";
inline constexpr char kRawCodecsConfigFile[] = "remote-desktop-video.conf";
inline constexpr char kRawCodecsConfigKey[] = "rawCodecs";

// Second, independent switch (default off): ask the capture for NV12 (420v) instead
// of BGRA while raw codecs are allowed. Off by default because the capture then
// stays BGRA for both codecs: VP9 converts BGRA -> I420 with libyuv in a few
// milliseconds, and an H.264 fallback needs no conversion back. NV12 saves capture
// bandwidth but is unproven against a real capture (matrix, text edges), so it is
// opt-in for A/B measurement: IMCODES_RD_NV12=on|off, or `nv12Capture=on` in the
// same file, resolved exactly like rawCodecs.
inline constexpr char kNv12CaptureEnvVar[] = "IMCODES_RD_NV12";
inline constexpr char kNv12CaptureConfigKey[] = "nv12Capture";

enum class RawCodecSettingSource { kDefault, kEnvironment, kFile };

struct RawCodecSettings {
  RawCodecSetting raw_codecs = RawCodecSetting::kAuto;
  RawCodecSettingSource source = RawCodecSettingSource::kDefault;
  bool nv12_capture = false;
  RawCodecSettingSource nv12_source = RawCodecSettingSource::kDefault;
  // A value was present but not recognised (and therefore ignored).
  bool ignored_invalid_value = false;
};

using RawCodecEnvironmentLookup = std::function<const char*(const char*)>;
// Returns the file's text, or nullopt when it does not exist or is unreadable.
// The reader is responsible for refusing anything but a small regular file.
using RawCodecFileReader = std::function<std::optional<std::string>(const std::string&)>;

// "auto" / "off", ASCII case-insensitive, surrounding blanks ignored.
[[nodiscard]] std::optional<RawCodecSetting> ParseRawCodecSetting(std::string_view text);

// The value of `rawCodecs=` in a remote-desktop-video.conf text: nullopt when the
// key is absent. A present-but-invalid value yields `invalid` = true. Later lines
// override earlier ones, like a shell would.
struct ParsedConfig {
  std::optional<RawCodecSetting> raw_codecs;
  std::optional<bool> nv12_capture;
  bool invalid = false;
};

// "on" / "off", ASCII case-insensitive, surrounding blanks ignored.
[[nodiscard]] std::optional<bool> ParseOnOff(std::string_view text);
[[nodiscard]] ParsedConfig ParseRawCodecConfig(std::string_view text);

// Resolves the effective setting from the environment and the config file.
[[nodiscard]] RawCodecSettings ResolveRawCodecSettings(
    const RawCodecEnvironmentLookup& environment, const RawCodecFileReader& read_file);

[[nodiscard]] const char* RawCodecSettingSourceName(RawCodecSettingSource source) noexcept;

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_RAW_CODEC_SETTINGS_H_
