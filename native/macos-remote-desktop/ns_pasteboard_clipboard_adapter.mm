#include "ns_pasteboard_clipboard_adapter.h"

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <limits>
#include <mutex>
#include <thread>
#include <utility>

namespace imcodes::remote_desktop::macos {
namespace {

constexpr std::uint32_t kExplicitReadIntervalMs = 5;

std::uint64_t MonotonicMilliseconds() noexcept {
  const auto elapsed = std::chrono::steady_clock::now().time_since_epoch();
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count());
}

std::uint64_t SaturatingDeadline(std::uint32_t timeout_ms) noexcept {
  const std::uint64_t now = MonotonicMilliseconds();
  return now > std::numeric_limits<std::uint64_t>::max() - timeout_ms
             ? std::numeric_limits<std::uint64_t>::max()
             : now + timeout_ms;
}

bool DeadlineExpired(std::uint64_t deadline_monotonic_ms) noexcept {
  return MonotonicMilliseconds() >= deadline_monotonic_ms;
}

bool IsValidBoundedUtf8(std::string_view text, std::size_t maximum_bytes,
                        ClipboardErrorCode *error) noexcept {
  if (text.empty()) {
    *error = ClipboardErrorCode::kInvalidUtf8;
    return false;
  }
  if (text.size() > maximum_bytes) {
    *error = ClipboardErrorCode::kTextTooLarge;
    return false;
  }

  std::size_t offset = 0;
  while (offset < text.size()) {
    const auto first = static_cast<unsigned char>(text[offset]);
    std::uint32_t code_point = 0;
    std::size_t continuation_count = 0;
    if (first <= 0x7f) {
      code_point = first;
    } else if (first >= 0xc2 && first <= 0xdf) {
      code_point = first & 0x1f;
      continuation_count = 1;
    } else if (first >= 0xe0 && first <= 0xef) {
      code_point = first & 0x0f;
      continuation_count = 2;
    } else if (first >= 0xf0 && first <= 0xf4) {
      code_point = first & 0x07;
      continuation_count = 3;
    } else {
      *error = ClipboardErrorCode::kInvalidUtf8;
      return false;
    }
    if (continuation_count == 0) {
      ++offset;
      continue;
    }
    if (offset + continuation_count >= text.size()) {
      *error = ClipboardErrorCode::kInvalidUtf8;
      return false;
    }
    for (std::size_t index = 1; index <= continuation_count; ++index) {
      const auto byte = static_cast<unsigned char>(text[offset + index]);
      if ((byte & 0xc0) != 0x80) {
        *error = ClipboardErrorCode::kInvalidUtf8;
        return false;
      }
      code_point = (code_point << 6) | (byte & 0x3f);
    }
    const bool overlong = (continuation_count == 1 && code_point < 0x80) ||
                          (continuation_count == 2 && code_point < 0x800) ||
                          (continuation_count == 3 && code_point < 0x10000);
    if (overlong || (code_point >= 0xd800 && code_point <= 0xdfff) ||
        code_point > 0x10ffff) {
      *error = ClipboardErrorCode::kInvalidUtf8;
      return false;
    }
    offset += continuation_count + 1;
  }
  return true;
}

ClipboardError ErrorForBackendResult(ClipboardBackendResult result) {
  switch (result) {
  case ClipboardBackendResult::kUnavailable:
    return {ClipboardErrorCode::kPermissionUnavailable,
            "clipboard unavailable in the active graphical session"};
  case ClipboardBackendResult::kTimedOut:
    return {ClipboardErrorCode::kDeadlineExceeded,
            "clipboard operation deadline exceeded"};
  case ClipboardBackendResult::kCanceled:
    return {ClipboardErrorCode::kSessionInactive, "clipboard session stopped"};
  case ClipboardBackendResult::kInvalidText:
    return {ClipboardErrorCode::kInvalidUtf8,
            "clipboard text is not valid UTF-8"};
  case ClipboardBackendResult::kTextTooLarge:
    return {ClipboardErrorCode::kTextTooLarge,
            "clipboard text exceeds the byte bound"};
  case ClipboardBackendResult::kFailure:
    return {ClipboardErrorCode::kBackendFailure,
            "clipboard operation unavailable"};
  case ClipboardBackendResult::kSuccess:
    return {};
  }
}

bool ConvertChangeCount(NSInteger value, std::int64_t *output) noexcept {
  if (value < 0 || output == nullptr) {
    return false;
  }
  *output = static_cast<std::int64_t>(value);
  return true;
}

class AppleNSPasteboardBackend final : public NSPasteboardBackend {
public:
  common::ReadinessState ProbeReadiness() noexcept override {
    @autoreleasepool {
      NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
      return pasteboard != nil && [pasteboard changeCount] >= 0
                 ? common::ReadinessState::kReady
                 : common::ReadinessState::kUnavailable;
    }
  }

  ClipboardBackendResult
  ReadChangeCount(std::uint64_t deadline_monotonic_ms,
                  std::int64_t *change_count) noexcept override {
    if (DeadlineExpired(deadline_monotonic_ms) || change_count == nullptr) {
      return ClipboardBackendResult::kTimedOut;
    }
    @autoreleasepool {
      NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
      if (pasteboard == nil) {
        return ClipboardBackendResult::kUnavailable;
      }
      return ConvertChangeCount([pasteboard changeCount], change_count)
                 ? ClipboardBackendResult::kSuccess
                 : ClipboardBackendResult::kFailure;
    }
  }

  ClipboardBackendResult
  WriteText(std::string_view text, std::uint64_t deadline_monotonic_ms,
            std::int64_t *observed_change_count) noexcept override {
    if (DeadlineExpired(deadline_monotonic_ms) ||
        observed_change_count == nullptr) {
      return ClipboardBackendResult::kTimedOut;
    }
    @autoreleasepool {
      NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
      if (pasteboard == nil) {
        return ClipboardBackendResult::kUnavailable;
      }
      NSString *value = [[NSString alloc] initWithBytes:text.data()
                                                 length:text.size()
                                               encoding:NSUTF8StringEncoding];
      if (value == nil) {
        return ClipboardBackendResult::kFailure;
      }
      [pasteboard clearContents];
      if (![pasteboard setString:value forType:NSPasteboardTypeString] ||
          DeadlineExpired(deadline_monotonic_ms)) {
        return DeadlineExpired(deadline_monotonic_ms)
                   ? ClipboardBackendResult::kTimedOut
                   : ClipboardBackendResult::kFailure;
      }
      return ConvertChangeCount([pasteboard changeCount], observed_change_count)
                 ? ClipboardBackendResult::kSuccess
                 : ClipboardBackendResult::kFailure;
    }
  }

  ClipboardBackendResult ReadTextAfterChange(
      std::int64_t baseline_change_count, std::size_t max_text_bytes,
      std::uint64_t deadline_monotonic_ms,
      ClipboardOperationAlive operation_alive, std::string *text,
      std::int64_t *observed_change_count) noexcept override {
    if (text == nullptr || observed_change_count == nullptr ||
        !operation_alive) {
      return ClipboardBackendResult::kFailure;
    }
    text->clear();
    while (!DeadlineExpired(deadline_monotonic_ms)) {
      if (!operation_alive()) {
        return ClipboardBackendResult::kCanceled;
      }
      @autoreleasepool {
        NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
        if (pasteboard == nil) {
          return ClipboardBackendResult::kUnavailable;
        }
        std::int64_t current_change_count = 0;
        if (!ConvertChangeCount([pasteboard changeCount],
                                &current_change_count)) {
          return ClipboardBackendResult::kFailure;
        }
        if (current_change_count != baseline_change_count) {
          NSString *value = [pasteboard stringForType:NSPasteboardTypeString];
          if (value == nil) {
            return ClipboardBackendResult::kFailure;
          }
          NSData *bytes = [value dataUsingEncoding:NSUTF8StringEncoding
                              allowLossyConversion:NO];
          if (bytes == nil || [bytes length] == 0) {
            return ClipboardBackendResult::kInvalidText;
          }
          if ([bytes length] > max_text_bytes) {
            return ClipboardBackendResult::kTextTooLarge;
          }
          text->assign(static_cast<const char *>([bytes bytes]),
                       [bytes length]);
          *observed_change_count = current_change_count;
          return ClipboardBackendResult::kSuccess;
        }
      }
      const std::uint64_t now = MonotonicMilliseconds();
      if (now >= deadline_monotonic_ms) {
        break;
      }
      const auto remaining = deadline_monotonic_ms - now;
      std::this_thread::sleep_for(std::chrono::milliseconds(
          std::min<std::uint64_t>(remaining, kExplicitReadIntervalMs)));
    }
    return ClipboardBackendResult::kTimedOut;
  }
};

std::unique_ptr<NSPasteboardBackend> CreateSystemBackend() {
  return std::make_unique<AppleNSPasteboardBackend>();
}

} // namespace

class NSPasteboardClipboardAdapter::Impl {
public:
  Impl(std::unique_ptr<NSPasteboardBackend> backend,
       ClipboardAction request_copy, ClipboardAction request_paste,
       NSPasteboardClipboardOptions options)
      : backend_(std::move(backend)), request_copy_(std::move(request_copy)),
        request_paste_(std::move(request_paste)),
        options_(NormalizeOptions(options)) {}

  bool StartSession() {
    StopSession();
    if (backend_ == nullptr || !request_copy_ || !request_paste_ ||
        options_.max_text_bytes == 0 || options_.operation_timeout_ms == 0 ||
        backend_->ProbeReadiness() != common::ReadinessState::kReady) {
      SetError({ClipboardErrorCode::kPermissionUnavailable,
                "clipboard unavailable in the active graphical session"});
      return false;
    }
    generation_.fetch_add(1, std::memory_order_acq_rel);
    active_.store(true, std::memory_order_release);
    SetError({});
    return true;
  }

  void StopSession() noexcept {
    active_.store(false, std::memory_order_release);
    generation_.fetch_add(1, std::memory_order_acq_rel);
  }

  bool SessionActive() const noexcept {
    return active_.load(std::memory_order_acquire);
  }

  common::ReadinessState ProbeReadiness() {
    if (!SessionActive() || backend_ == nullptr) {
      return common::ReadinessState::kUnavailable;
    }
    return backend_->ProbeReadiness();
  }

  bool PasteText(std::string_view text) {
    std::unique_lock operation_lock(operation_mutex_, std::try_to_lock);
    if (!operation_lock.owns_lock()) {
      SetError({ClipboardErrorCode::kOperationBusy,
                "another explicit clipboard operation is active"});
      return false;
    }
    const std::uint64_t generation = BeginOperation();
    if (generation == 0) {
      return false;
    }
    ClipboardErrorCode validation_error = ClipboardErrorCode::kNone;
    if (!IsValidBoundedUtf8(text, options_.max_text_bytes, &validation_error)) {
      SetError({validation_error,
                validation_error == ClipboardErrorCode::kTextTooLarge
                    ? "clipboard text exceeds the byte bound"
                    : "clipboard text is not valid UTF-8"});
      return false;
    }
    const std::uint64_t deadline =
        SaturatingDeadline(options_.operation_timeout_ms);
    std::int64_t baseline = 0;
    ClipboardBackendResult result =
        backend_->ReadChangeCount(deadline, &baseline);
    if (!HandleBackendResult(result, generation)) {
      return false;
    }
    if (!CheckDeadline(deadline, generation)) {
      return false;
    }
    std::int64_t observed = baseline;
    result = backend_->WriteText(text, deadline, &observed);
    if (!HandleBackendResult(result, generation)) {
      return false;
    }
    if (observed == baseline) {
      SetError({ClipboardErrorCode::kStaleChange,
                "pasteboard did not produce a correlated change"});
      return false;
    }
    if (!CheckDeadline(deadline, generation)) {
      return false;
    }
    if (!request_paste_(deadline) || !StillCurrent(generation)) {
      SetError(!StillCurrent(generation)
                   ? ErrorForBackendResult(ClipboardBackendResult::kCanceled)
                   : ClipboardError{ClipboardErrorCode::kActionFailed,
                                    "explicit paste action was rejected"});
      return false;
    }
    if (!CheckDeadline(deadline, generation)) {
      return false;
    }
    SetError({});
    return true;
  }

  bool CopySelection(std::string *text) {
    if (text == nullptr) {
      SetError(
          {ClipboardErrorCode::kBackendFailure, "copy output is unavailable"});
      return false;
    }
    text->clear();
    std::unique_lock operation_lock(operation_mutex_, std::try_to_lock);
    if (!operation_lock.owns_lock()) {
      SetError({ClipboardErrorCode::kOperationBusy,
                "another explicit clipboard operation is active"});
      return false;
    }
    const std::uint64_t generation = BeginOperation();
    if (generation == 0) {
      return false;
    }
    const std::uint64_t deadline =
        SaturatingDeadline(options_.operation_timeout_ms);
    std::int64_t baseline = 0;
    ClipboardBackendResult result =
        backend_->ReadChangeCount(deadline, &baseline);
    if (!HandleBackendResult(result, generation)) {
      return false;
    }
    if (!CheckDeadline(deadline, generation)) {
      return false;
    }
    if (!request_copy_(deadline) || !StillCurrent(generation)) {
      SetError(!StillCurrent(generation)
                   ? ErrorForBackendResult(ClipboardBackendResult::kCanceled)
                   : ClipboardError{ClipboardErrorCode::kActionFailed,
                                    "explicit copy action was rejected"});
      return false;
    }
    if (!CheckDeadline(deadline, generation)) {
      return false;
    }

    std::string candidate;
    std::int64_t observed = baseline;
    result = backend_->ReadTextAfterChange(
        baseline, options_.max_text_bytes, deadline,
        [this, generation] { return StillCurrent(generation); }, &candidate,
        &observed);
    if (!HandleBackendResult(result, generation)) {
      return false;
    }
    if (observed == baseline) {
      SetError({ClipboardErrorCode::kStaleChange,
                "copy did not produce a correlated pasteboard change"});
      return false;
    }
    ClipboardErrorCode validation_error = ClipboardErrorCode::kNone;
    if (!IsValidBoundedUtf8(candidate, options_.max_text_bytes,
                            &validation_error)) {
      SetError({validation_error,
                validation_error == ClipboardErrorCode::kTextTooLarge
                    ? "clipboard text exceeds the byte bound"
                    : "clipboard text is not valid UTF-8"});
      return false;
    }
    if (!CheckDeadline(deadline, generation)) {
      return false;
    }
    *text = std::move(candidate);
    SetError({});
    return true;
  }

  ClipboardError LastError() const {
    std::lock_guard lock(error_mutex_);
    return last_error_;
  }

private:
  static NSPasteboardClipboardOptions
  NormalizeOptions(NSPasteboardClipboardOptions options) noexcept {
    options.max_text_bytes =
        std::min(options.max_text_bytes, kNSPasteboardClipboardMaxTextBytes);
    options.operation_timeout_ms = std::min(
        options.operation_timeout_ms, kNSPasteboardClipboardMaxDeadlineMs);
    return options;
  }

  std::uint64_t BeginOperation() {
    if (!SessionActive()) {
      SetError({ClipboardErrorCode::kSessionInactive,
                "clipboard session is not active"});
      return 0;
    }
    if (backend_ == nullptr ||
        backend_->ProbeReadiness() != common::ReadinessState::kReady) {
      SetError({ClipboardErrorCode::kPermissionUnavailable,
                "clipboard unavailable in the active graphical session"});
      return 0;
    }
    const std::uint64_t generation =
        generation_.load(std::memory_order_acquire);
    if (generation == 0 || !StillCurrent(generation)) {
      SetError({ClipboardErrorCode::kSessionInactive,
                "clipboard session is not active"});
      return 0;
    }
    return generation;
  }

  bool StillCurrent(std::uint64_t generation) const noexcept {
    return active_.load(std::memory_order_acquire) &&
           generation_.load(std::memory_order_acquire) == generation;
  }

  bool HandleBackendResult(ClipboardBackendResult result,
                           std::uint64_t generation) {
    if (!StillCurrent(generation)) {
      SetError(ErrorForBackendResult(ClipboardBackendResult::kCanceled));
      return false;
    }
    if (result != ClipboardBackendResult::kSuccess) {
      SetError(ErrorForBackendResult(result));
      return false;
    }
    return true;
  }

  bool CheckDeadline(std::uint64_t deadline, std::uint64_t generation) {
    if (!StillCurrent(generation)) {
      SetError(ErrorForBackendResult(ClipboardBackendResult::kCanceled));
      return false;
    }
    if (DeadlineExpired(deadline)) {
      SetError(ErrorForBackendResult(ClipboardBackendResult::kTimedOut));
      return false;
    }
    return true;
  }

  void SetError(ClipboardError error) {
    std::lock_guard lock(error_mutex_);
    last_error_ = std::move(error);
  }

  std::unique_ptr<NSPasteboardBackend> backend_;
  ClipboardAction request_copy_;
  ClipboardAction request_paste_;
  NSPasteboardClipboardOptions options_;
  std::atomic<bool> active_{false};
  std::atomic<std::uint64_t> generation_{0};
  std::mutex operation_mutex_;
  mutable std::mutex error_mutex_;
  ClipboardError last_error_;
};

NSPasteboardClipboardAdapter::NSPasteboardClipboardAdapter(
    ClipboardAction request_copy, ClipboardAction request_paste,
    NSPasteboardClipboardOptions options)
    : NSPasteboardClipboardAdapter(CreateSystemBackend(),
                                   std::move(request_copy),
                                   std::move(request_paste), options) {}

NSPasteboardClipboardAdapter::NSPasteboardClipboardAdapter(
    std::unique_ptr<NSPasteboardBackend> backend, ClipboardAction request_copy,
    ClipboardAction request_paste, NSPasteboardClipboardOptions options)
    : impl_(std::make_unique<Impl>(std::move(backend), std::move(request_copy),
                                   std::move(request_paste), options)) {}

NSPasteboardClipboardAdapter::~NSPasteboardClipboardAdapter() { StopSession(); }

bool NSPasteboardClipboardAdapter::StartSession() {
  return impl_->StartSession();
}

void NSPasteboardClipboardAdapter::StopSession() noexcept {
  impl_->StopSession();
}

bool NSPasteboardClipboardAdapter::SessionActive() const noexcept {
  return impl_->SessionActive();
}

common::ReadinessState NSPasteboardClipboardAdapter::ProbeReadiness() {
  return impl_->ProbeReadiness();
}

bool NSPasteboardClipboardAdapter::PasteText(std::string_view text) {
  return impl_->PasteText(text);
}

bool NSPasteboardClipboardAdapter::CopySelection(std::string *text) {
  return impl_->CopySelection(text);
}

ClipboardError NSPasteboardClipboardAdapter::LastError() const {
  return impl_->LastError();
}

} // namespace imcodes::remote_desktop::macos
