#ifndef IMCODES_MACOS_REMOTE_DESKTOP_NS_PASTEBOARD_CLIPBOARD_ADAPTER_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_NS_PASTEBOARD_CLIPBOARD_ADAPTER_H_

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <string_view>

#include "../remote-desktop-common/platform_interfaces.h"

namespace imcodes::remote_desktop::macos {

enum class ClipboardBackendResult : std::uint8_t {
  kSuccess,
  kUnavailable,
  kTimedOut,
  kCanceled,
  kInvalidText,
  kTextTooLarge,
  kFailure,
};

enum class ClipboardErrorCode : std::uint8_t {
  kNone,
  kSessionInactive,
  kPermissionUnavailable,
  kOperationBusy,
  kInvalidUtf8,
  kTextTooLarge,
  kDeadlineExceeded,
  kStaleChange,
  kActionFailed,
  kBackendFailure,
};

struct ClipboardError {
  ClipboardErrorCode code = ClipboardErrorCode::kNone;
  std::string message;
};

inline constexpr std::size_t kNSPasteboardClipboardMaxTextBytes = 12 * 1024;
inline constexpr std::uint32_t kNSPasteboardClipboardMaxDeadlineMs = 5'000;

struct NSPasteboardClipboardOptions {
  // Matches the existing remote-desktop clipboard protocol bound. Keeping the
  // adapter bound independent also prevents an oversized pasteboard allocation
  // before the common protocol has a chance to reject it.
  std::size_t max_text_bytes = kNSPasteboardClipboardMaxTextBytes;
  std::uint32_t operation_timeout_ms = 350;
};

using ClipboardAction =
    std::function<bool(std::uint64_t deadline_monotonic_ms)>;
using ClipboardOperationAlive = std::function<bool()>;

// These callbacks are the narrow bridge to the permission-checked CGEvent
// input adapter. They synchronously request exactly one Command-C/Command-V
// action and must honor the supplied absolute deadline.

// Objective-C and NSPasteboard values stay behind this project-owned seam.
// Implementations must perform only the requested operation; they must not
// install observers or retain clipboard text after returning.
class NSPasteboardBackend {
public:
  virtual ~NSPasteboardBackend() = default;
  [[nodiscard]] virtual common::ReadinessState ProbeReadiness() noexcept = 0;
  virtual ClipboardBackendResult
  ReadChangeCount(std::uint64_t deadline_monotonic_ms,
                  std::int64_t *change_count) noexcept = 0;
  virtual ClipboardBackendResult
  WriteText(std::string_view text, std::uint64_t deadline_monotonic_ms,
            std::int64_t *observed_change_count) noexcept = 0;
  virtual ClipboardBackendResult ReadTextAfterChange(
      std::int64_t baseline_change_count, std::size_t max_text_bytes,
      std::uint64_t deadline_monotonic_ms,
      ClipboardOperationAlive operation_alive, std::string *text,
      std::int64_t *observed_change_count) noexcept = 0;
};

class NSPasteboardClipboardAdapter final : public common::ClipboardAdapter {
public:
  NSPasteboardClipboardAdapter(ClipboardAction request_copy,
                               ClipboardAction request_paste,
                               NSPasteboardClipboardOptions options = {});
  NSPasteboardClipboardAdapter(std::unique_ptr<NSPasteboardBackend> backend,
                               ClipboardAction request_copy,
                               ClipboardAction request_paste,
                               NSPasteboardClipboardOptions options = {});
  ~NSPasteboardClipboardAdapter() override;

  NSPasteboardClipboardAdapter(const NSPasteboardClipboardAdapter &) = delete;
  NSPasteboardClipboardAdapter &
  operator=(const NSPasteboardClipboardAdapter &) = delete;

  // The LaunchAgent/session owner must explicitly bracket route lifetime. A
  // stopped adapter rejects operations and invalidates in-flight correlation.
  bool StartSession();
  void StopSession() noexcept;
  [[nodiscard]] bool SessionActive() const noexcept;

  // Side-effect-free capability probe for cold admission. This deliberately
  // does not claim an active route; StartSession and every operation retain
  // their callback, generation and liveness gates.
  [[nodiscard]] common::ReadinessState ProbeCapability() noexcept;
  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  bool PasteText(std::string_view text) override;
  bool CopySelection(std::string *text) override;

  [[nodiscard]] ClipboardError LastError() const;

private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace imcodes::remote_desktop::macos

#endif // IMCODES_MACOS_REMOTE_DESKTOP_NS_PASTEBOARD_CLIPBOARD_ADAPTER_H_
