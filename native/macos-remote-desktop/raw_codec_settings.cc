#include "raw_codec_settings.h"

#include <cctype>
#include <cstddef>
#include <utility>

namespace imcodes::remote_desktop::macos {
namespace {

std::string_view Trim(std::string_view text) {
  while (!text.empty() && std::isspace(static_cast<unsigned char>(text.front())))
    text.remove_prefix(1);
  while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back())))
    text.remove_suffix(1);
  return text;
}

std::string Lower(std::string_view text) {
  std::string out(text);
  for (char& c : out)
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return out;
}

}  // namespace

std::optional<RawCodecSetting> ParseRawCodecSetting(std::string_view text) {
  const std::string value = Lower(Trim(text));
  if (value == "auto") return RawCodecSetting::kAuto;
  if (value == "off") return RawCodecSetting::kOff;
  return std::nullopt;
}

ParsedConfig ParseRawCodecConfig(std::string_view text) {
  ParsedConfig parsed;
  while (!text.empty()) {
    const std::size_t end = text.find('\n');
    std::string_view line = Trim(text.substr(0, end));
    text = end == std::string_view::npos ? std::string_view{} : text.substr(end + 1);
    if (line.empty() || line.front() == '#') continue;
    const std::size_t equals = line.find('=');
    if (equals == std::string_view::npos) continue;
    if (Trim(line.substr(0, equals)) != kRawCodecsConfigKey) continue;
    const std::optional<RawCodecSetting> value =
        ParseRawCodecSetting(line.substr(equals + 1));
    if (value.has_value()) {
      parsed.raw_codecs = value;
      parsed.invalid = false;
    } else {
      // Remember that the LAST statement was unusable; an earlier valid one stays.
      parsed.invalid = true;
    }
  }
  return parsed;
}

RawCodecSettings ResolveRawCodecSettings(const RawCodecEnvironmentLookup& environment,
                                         const RawCodecFileReader& read_file) {
  RawCodecSettings settings;
  const auto env = [&](const char* name) -> std::string_view {
    const char* value = environment ? environment(name) : nullptr;
    return value != nullptr ? std::string_view(value) : std::string_view{};
  };

  const std::string_view from_env = env(kRawCodecsEnvVar);
  if (!Trim(from_env).empty()) {
    if (const std::optional<RawCodecSetting> value = ParseRawCodecSetting(from_env)) {
      settings.raw_codecs = *value;
      settings.source = RawCodecSettingSource::kEnvironment;
      return settings;
    }
    settings.ignored_invalid_value = true;
  }

  std::string directory(env("IMCODES_HOME"));
  if (directory.empty()) {
    const std::string_view home = env("HOME");
    if (!home.empty()) directory = std::string(home) + "/.imcodes";
  }
  if (!directory.empty() && read_file) {
    if (const std::optional<std::string> text =
            read_file(directory + "/" + kRawCodecsConfigFile)) {
      const ParsedConfig parsed = ParseRawCodecConfig(*text);
      if (parsed.raw_codecs.has_value()) {
        settings.raw_codecs = *parsed.raw_codecs;
        settings.source = RawCodecSettingSource::kFile;
      }
      if (parsed.invalid) settings.ignored_invalid_value = true;
    }
  }
  return settings;
}

const char* RawCodecSettingSourceName(RawCodecSettingSource source) noexcept {
  switch (source) {
    case RawCodecSettingSource::kDefault: return "default";
    case RawCodecSettingSource::kEnvironment: return "environment";
    case RawCodecSettingSource::kFile: return "file";
  }
  return "unknown";
}

}  // namespace imcodes::remote_desktop::macos
