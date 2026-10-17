#include "aidesk_ui_strings.h"
#include "../../shared/aidesk-local-ui-i18n.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <ctime>

namespace imcodes::aidesk::ui {
namespace {

std::size_t LocaleIndex(Locale locale) {
  return static_cast<std::size_t>(locale);
}

}  // namespace

Locale LocaleFromLanguageTag(std::string_view tag) {
  std::string normalized(tag);
  std::transform(normalized.begin(), normalized.end(), normalized.begin(),
                 [](unsigned char value) { return static_cast<char>(std::tolower(value)); });
  if (normalized.rfind("zh-tw", 0) == 0 || normalized.rfind("zh-hk", 0) == 0 ||
      normalized.rfind("zh-hant", 0) == 0) return Locale::kZhTw;
  if (normalized.rfind("zh", 0) == 0) return Locale::kZhCn;
  if (normalized.rfind("es", 0) == 0) return Locale::kEs;
  if (normalized.rfind("ru", 0) == 0) return Locale::kRu;
  if (normalized.rfind("ja", 0) == 0) return Locale::kJa;
  if (normalized.rfind("ko", 0) == 0) return Locale::kKo;
  return Locale::kEn;
}

Locale DetectLocale() {
  const char* language = std::getenv("LC_ALL");
  if (language == nullptr || *language == '\0') language = std::getenv("LC_MESSAGES");
  if (language == nullptr || *language == '\0') language = std::getenv("LANG");
  return LocaleFromLanguageTag(language == nullptr ? "en" : language);
}

std::string_view Translate(Locale locale, Text text) {
  return i18n::kText.at(static_cast<std::size_t>(text)).at(LocaleIndex(locale));
}

std::string FormatDuration(std::int64_t duration_ms) {
  const auto seconds = std::max<std::int64_t>(0, duration_ms / 1000);
  const auto hours = seconds / 3600;
  const auto minutes = (seconds % 3600) / 60;
  const auto remainder = seconds % 60;
  char output[32];
  if (hours > 0) {
    std::snprintf(output, sizeof(output), "%02lld:%02lld:%02lld",
                  static_cast<long long>(hours), static_cast<long long>(minutes),
                  static_cast<long long>(remainder));
  } else {
    std::snprintf(output, sizeof(output), "%02lld:%02lld",
                  static_cast<long long>(minutes), static_cast<long long>(remainder));
  }
  return output;
}

std::string FormatLocalTime(std::int64_t epoch_ms) {
  const std::time_t value = static_cast<std::time_t>(epoch_ms / 1000);
  std::tm local{};
#if defined(_WIN32)
  localtime_s(&local, &value);
#else
  localtime_r(&value, &local);
#endif
  char output[32];
  std::strftime(output, sizeof(output), "%Y-%m-%d %H:%M:%S", &local);
  return output;
}

}  // namespace imcodes::aidesk::ui
