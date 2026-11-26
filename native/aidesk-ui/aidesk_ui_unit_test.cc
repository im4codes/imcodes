#include "aidesk_ui_strings.h"
#include "../remote-desktop-common/local_management_ipc.h"

#include <cstdlib>
#include <iostream>
#include <string>

namespace {
void Check(bool value, const char* message) {
  if (!value) { std::cerr << message << '\n'; std::exit(1); }
}
}

int main() {
  using namespace imcodes::aidesk::ui;
  using namespace imcodes::remote_desktop::common;
  Check(LocaleFromLanguageTag("zh-Hant-HK") == Locale::kZhTw, "traditional locale");
  Check(LocaleFromLanguageTag("zh-CN") == Locale::kZhCn, "simplified locale");
  Check(LocaleFromLanguageTag("es-MX") == Locale::kEs, "spanish locale");
  Check(!Translate(Locale::kJa, Text::kDisconnect).empty(), "seven-language text");
  Check(FormatDuration(65'000) == "01:05", "short duration");
  Check(FormatDuration(3'661'000) == "01:01:01", "long duration");
  const std::string bootstrap =
      "{\"version\":1,\"protocolVersion\":1,\"endpoint\":\"/tmp/a.sock\","
      "\"bootstrapSecret\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\","
      "\"runtimeVersion\":\"2026.9.1\",\"productVersion\":\"2026.9.1\"}";
  const auto parsed = ParseLocalManagementBootstrap(bootstrap);
  Check(parsed.has_value() && parsed->endpoint == "/tmp/a.sock", "bootstrap parse");
  Check(!ParseLocalManagementBootstrap(bootstrap + "x").has_value(), "bootstrap reject");
  for (int locale = static_cast<int>(Locale::kEn);
       locale <= static_cast<int>(Locale::kKo); ++locale) {
    for (int text = static_cast<int>(Text::kProductName);
         text <= static_cast<int>(Text::kAccessPaused); ++text) {
      Check(!Translate(static_cast<Locale>(locale), static_cast<Text>(text)).empty(),
            "translation completeness");
    }
  }
  return 0;
}
