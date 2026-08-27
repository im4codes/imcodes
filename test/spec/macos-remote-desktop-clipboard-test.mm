#include <chrono>
#include <cstdint>
#include <iostream>
#include <limits>
#include <memory>
#include <string>
#include <string_view>
#include <thread>
#include <utility>

#include "ns_pasteboard_clipboard_adapter.h"

namespace clipboard = imcodes::remote_desktop::macos;
namespace common = imcodes::remote_desktop::common;

namespace {

bool Check(bool condition, const char *message) {
  if (!condition) {
    std::cerr << message << '\n';
  }
  return condition;
}

class FakeBackend final : public clipboard::NSPasteboardBackend {
public:
  common::ReadinessState readiness = common::ReadinessState::kReady;
  clipboard::ClipboardBackendResult change_result =
      clipboard::ClipboardBackendResult::kSuccess;
  clipboard::ClipboardBackendResult write_result =
      clipboard::ClipboardBackendResult::kSuccess;
  clipboard::ClipboardBackendResult read_result =
      clipboard::ClipboardBackendResult::kSuccess;
  std::int64_t current_change_count = 10;
  std::int64_t read_change_count = 11;
  std::string read_text = "copied text";
  std::string written_text;
  std::uint64_t change_deadline = 0;
  std::uint64_t write_deadline = 0;
  std::uint64_t read_deadline = 0;
  std::int64_t read_baseline = -1;
  std::size_t read_bound = 0;
  int readiness_calls = 0;
  int change_calls = 0;
  int write_calls = 0;
  int read_calls = 0;
  bool write_advances_change = true;
  std::function<void()> on_read;

  common::ReadinessState ProbeReadiness() noexcept override {
    ++readiness_calls;
    return readiness;
  }

  clipboard::ClipboardBackendResult
  ReadChangeCount(std::uint64_t deadline_monotonic_ms,
                  std::int64_t *change_count) noexcept override {
    ++change_calls;
    change_deadline = deadline_monotonic_ms;
    if (change_result == clipboard::ClipboardBackendResult::kSuccess) {
      *change_count = current_change_count;
    }
    return change_result;
  }

  clipboard::ClipboardBackendResult
  WriteText(std::string_view text, std::uint64_t deadline_monotonic_ms,
            std::int64_t *observed_change_count) noexcept override {
    ++write_calls;
    write_deadline = deadline_monotonic_ms;
    written_text.assign(text);
    if (write_result == clipboard::ClipboardBackendResult::kSuccess) {
      if (write_advances_change) {
        ++current_change_count;
      }
      *observed_change_count = current_change_count;
    }
    return write_result;
  }

  clipboard::ClipboardBackendResult ReadTextAfterChange(
      std::int64_t baseline_change_count, std::size_t max_text_bytes,
      std::uint64_t deadline_monotonic_ms,
      clipboard::ClipboardOperationAlive operation_alive, std::string *text,
      std::int64_t *observed_change_count) noexcept override {
    ++read_calls;
    read_baseline = baseline_change_count;
    read_bound = max_text_bytes;
    read_deadline = deadline_monotonic_ms;
    if (on_read) {
      on_read();
    }
    if (!operation_alive()) {
      return clipboard::ClipboardBackendResult::kCanceled;
    }
    if (read_result == clipboard::ClipboardBackendResult::kSuccess) {
      *text = read_text;
      *observed_change_count = read_change_count;
    }
    return read_result;
  }
};

struct Fixture {
  std::unique_ptr<FakeBackend> owned = std::make_unique<FakeBackend>();
  FakeBackend *fake = owned.get();
  int copy_actions = 0;
  int paste_actions = 0;
  std::uint64_t copy_deadline = 0;
  std::uint64_t paste_deadline = 0;
  clipboard::NSPasteboardClipboardAdapter adapter{
      std::move(owned),
      [this](std::uint64_t deadline) {
        ++copy_actions;
        copy_deadline = deadline;
        return true;
      },
      [this](std::uint64_t deadline) {
        ++paste_actions;
        paste_deadline = deadline;
        return true;
      },
      {.max_text_bytes = 32, .operation_timeout_ms = 125}};
};

bool TestExplicitPasteAndCopyCorrelation() {
  Fixture fixture;
  if (!Check(fixture.adapter.StartSession(), "session should start") ||
      !Check(fixture.adapter.ProbeReadiness() == common::ReadinessState::kReady,
             "active adapter should report ready") ||
      !Check(fixture.fake->read_calls == 0 && fixture.copy_actions == 0 &&
                 fixture.paste_actions == 0,
             "session start must not poll or synchronize the pasteboard")) {
    return false;
  }

  const std::string pasted = "hello \xE4\xB8\x96\xE7\x95\x8C";
  if (!Check(fixture.adapter.PasteText(pasted),
             "explicit bounded paste should succeed") ||
      !Check(
          fixture.fake->written_text == pasted &&
              fixture.fake->change_calls == 1 &&
              fixture.fake->write_calls == 1 && fixture.paste_actions == 1,
          "paste must snapshot, write once and invoke one explicit action") ||
      !Check(fixture.fake->change_deadline == fixture.fake->write_deadline &&
                 fixture.fake->write_deadline == fixture.paste_deadline,
             "paste phases must share one absolute deadline")) {
    return false;
  }

  fixture.fake->read_change_count = fixture.fake->current_change_count + 1;
  std::string copied = "must be cleared";
  if (!Check(fixture.adapter.CopySelection(&copied),
             "new correlated copy should succeed") ||
      !Check(copied == "copied text" && fixture.copy_actions == 1 &&
                 fixture.fake->read_calls == 1,
             "copy must return only the one explicitly correlated value") ||
      !Check(fixture.fake->read_baseline ==
                     fixture.fake->current_change_count &&
                 fixture.fake->read_bound == 32 &&
                 fixture.copy_deadline == fixture.fake->read_deadline,
             "copy must bind baseline, byte bound and one deadline")) {
    return false;
  }

  const int reads_after_request = fixture.fake->read_calls;
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  return Check(fixture.fake->read_calls == reads_after_request,
               "adapter must not continue polling after the explicit request");
}

bool TestStaleCopyIsUnavailable() {
  Fixture fixture;
  if (!fixture.adapter.StartSession()) {
    return false;
  }
  fixture.fake->read_change_count = fixture.fake->current_change_count;
  std::string copied = "old secret";
  return Check(!fixture.adapter.CopySelection(&copied),
               "stale change count must be rejected") &&
         Check(copied.empty(), "stale clipboard text must not escape") &&
         Check(fixture.adapter.LastError().code ==
                   clipboard::ClipboardErrorCode::kStaleChange,
               "stale correlation must remain distinguishable");
}

bool TestStalePasteIsUnavailable() {
  Fixture fixture;
  if (!fixture.adapter.StartSession()) {
    return false;
  }
  fixture.fake->write_advances_change = false;
  return Check(!fixture.adapter.PasteText("new text"),
               "paste without a new change count must be rejected") &&
         Check(fixture.paste_actions == 0,
               "stale paste must not inject a paste shortcut") &&
         Check(fixture.adapter.LastError().code ==
                   clipboard::ClipboardErrorCode::kStaleChange,
               "stale paste correlation must remain distinguishable");
}

bool TestTextBoundsAndUtf8() {
  Fixture fixture;
  if (!fixture.adapter.StartSession()) {
    return false;
  }
  fixture.fake->read_text = std::string(33, 'x');
  fixture.fake->read_change_count = fixture.fake->current_change_count + 1;
  std::string copied;
  if (!Check(!fixture.adapter.CopySelection(&copied),
             "oversized copied text must fail closed") ||
      !Check(copied.empty(), "oversized copied text must not escape") ||
      !Check(fixture.adapter.LastError().code ==
                 clipboard::ClipboardErrorCode::kTextTooLarge,
             "copy byte bound must be reported") ||
      !Check(!fixture.adapter.PasteText(std::string(33, 'p')),
             "oversized paste must fail before backend access") ||
      !Check(fixture.fake->write_calls == 0 && fixture.paste_actions == 0,
             "invalid paste must not mutate the pasteboard or inject input")) {
    return false;
  }

  const std::string invalid_utf8("\xF0\x28\x8C\x28", 4);
  return Check(!fixture.adapter.PasteText(invalid_utf8),
               "invalid UTF-8 must fail closed") &&
         Check(fixture.adapter.LastError().code ==
                   clipboard::ClipboardErrorCode::kInvalidUtf8,
               "invalid UTF-8 must remain distinguishable");
}

bool TestTimeoutAndPermissionFailures() {
  Fixture fixture;
  fixture.fake->readiness = common::ReadinessState::kUnavailable;
  if (!Check(!fixture.adapter.StartSession(),
             "unavailable active-user pasteboard must reject session") ||
      !Check(fixture.adapter.ProbeReadiness() ==
                 common::ReadinessState::kUnavailable,
             "failed session must remain unavailable") ||
      !Check(fixture.adapter.LastError().code ==
                 clipboard::ClipboardErrorCode::kPermissionUnavailable,
             "permission/session unavailability must fail closed")) {
    return false;
  }

  fixture.fake->readiness = common::ReadinessState::kReady;
  if (!fixture.adapter.StartSession()) {
    return false;
  }
  fixture.fake->read_result = clipboard::ClipboardBackendResult::kTimedOut;
  std::string copied;
  if (!Check(!fixture.adapter.CopySelection(&copied),
             "copy deadline expiration must fail") ||
      !Check(copied.empty(), "timed-out copy must not return text") ||
      !Check(fixture.adapter.LastError().code ==
                 clipboard::ClipboardErrorCode::kDeadlineExceeded,
             "timeout must remain distinguishable")) {
    return false;
  }

  fixture.fake->read_result = clipboard::ClipboardBackendResult::kSuccess;
  fixture.fake->readiness = common::ReadinessState::kUnavailable;
  const int previous_change_calls = fixture.fake->change_calls;
  return Check(!fixture.adapter.PasteText("permission revoked"),
               "permission loss during a session must fail closed") &&
         Check(fixture.fake->change_calls == previous_change_calls,
               "permission loss must reject before pasteboard mutation") &&
         Check(fixture.adapter.LastError().code ==
                   clipboard::ClipboardErrorCode::kPermissionUnavailable,
               "mid-session permission loss must remain distinguishable");
}

bool TestSessionStopRejectsLateText() {
  Fixture fixture;
  if (!fixture.adapter.StartSession()) {
    return false;
  }
  fixture.fake->read_change_count = fixture.fake->current_change_count + 1;
  fixture.fake->on_read = [&fixture] { fixture.adapter.StopSession(); };
  std::string copied = "must be cleared";
  if (!Check(!fixture.adapter.CopySelection(&copied),
             "session stop must invalidate in-flight correlation") ||
      !Check(copied.empty(), "late text after stop must not escape") ||
      !Check(!fixture.adapter.SessionActive(), "session must remain stopped") ||
      !Check(fixture.adapter.LastError().code ==
                 clipboard::ClipboardErrorCode::kSessionInactive,
             "stopped generation must be reported")) {
    return false;
  }
  return Check(!fixture.adapter.PasteText("after stop") &&
                   fixture.paste_actions == 0,
               "stopped session must reject later paste input");
}

bool TestRejectedActionDoesNotReadOrClaimSuccess() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend *fake = backend.get();
  clipboard::NSPasteboardClipboardAdapter adapter(
      std::move(backend), [](std::uint64_t) { return false; },
      [](std::uint64_t) { return false; },
      {.max_text_bytes = 32, .operation_timeout_ms = 100});
  if (!adapter.StartSession()) {
    return false;
  }
  std::string copied;
  if (!Check(!adapter.CopySelection(&copied),
             "rejected copy shortcut must fail") ||
      !Check(fake->read_calls == 0,
             "rejected copy shortcut must not read stale pasteboard text") ||
      !Check(adapter.LastError().code ==
                 clipboard::ClipboardErrorCode::kActionFailed,
             "action denial must be explicit")) {
    return false;
  }
  return Check(!adapter.PasteText("bounded") && fake->write_calls == 1,
               "rejected paste action must report failure after one write");
}

bool TestConfigurationCannotWidenProtocolBounds() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend *fake = backend.get();
  fake->read_change_count = fake->current_change_count + 1;
  clipboard::NSPasteboardClipboardAdapter adapter(
      std::move(backend), [](std::uint64_t) { return true; },
      [](std::uint64_t) { return true; },
      {.max_text_bytes = std::numeric_limits<std::size_t>::max(),
       .operation_timeout_ms = std::numeric_limits<std::uint32_t>::max()});
  if (!adapter.StartSession()) {
    return false;
  }
  std::string copied;
  if (!Check(adapter.CopySelection(&copied),
             "bounded copy should survive oversized configuration") ||
      !Check(fake->read_bound == clipboard::kNSPasteboardClipboardMaxTextBytes,
             "configuration must not widen the protocol byte bound")) {
    return false;
  }
  const std::string oversized(clipboard::kNSPasteboardClipboardMaxTextBytes + 1,
                              'x');
  const int writes_before = fake->write_calls;
  return Check(!adapter.PasteText(oversized),
               "protocol-oversized paste must remain rejected") &&
         Check(fake->write_calls == writes_before,
               "widened configuration must not reach the pasteboard");
}

} // namespace

int main() {
  if (!TestExplicitPasteAndCopyCorrelation() || !TestStaleCopyIsUnavailable() ||
      !TestStalePasteIsUnavailable() || !TestTextBoundsAndUtf8() ||
      !TestTimeoutAndPermissionFailures() ||
      !TestSessionStopRejectsLateText() ||
      !TestRejectedActionDoesNotReadOrClaimSuccess() ||
      !TestConfigurationCannotWidenProtocolBounds()) {
    return 1;
  }
  return 0;
}
