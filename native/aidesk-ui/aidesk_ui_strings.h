#ifndef IMCODES_AIDESK_UI_STRINGS_H_
#define IMCODES_AIDESK_UI_STRINGS_H_

#include <cstdint>
#include <string>
#include <string_view>

namespace imcodes::aidesk::ui {

enum class Text {
  kProductName,
  kPublicId,
  kCopy,
  kCopied,
  kServiceReady,
  kServiceStarting,
  kServiceStopped,
  kServiceRepairRequired,
  kVersionMismatch,
  kConnections,
  kNoConnections,
  kViewing,
  kControlling,
  kConnectedAt,
  kDuration,
  kDisconnect,
  kDisconnectConfirm,
  kPause,
  kResume,
  kStopAll,
  kStopAllConfirm,
  kConfirmAgain,
  kCancel,
  kWebManagement,
  kShare,
  kActionPending,
  kActionFailed,
  kServiceUnavailable,
  kAccessPaused,
};

enum class Locale { kEn, kZhCn, kZhTw, kEs, kRu, kJa, kKo };

Locale LocaleFromLanguageTag(std::string_view tag);
Locale DetectLocale();
std::string_view Translate(Locale locale, Text text);
std::string FormatDuration(std::int64_t duration_ms);
std::string FormatLocalTime(std::int64_t epoch_ms);

}  // namespace imcodes::aidesk::ui

#endif  // IMCODES_AIDESK_UI_STRINGS_H_
