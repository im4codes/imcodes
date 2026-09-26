#ifndef IMCODES_REMOTE_DESKTOP_CONSENT_PROMPT_H_
#define IMCODES_REMOTE_DESKTOP_CONSENT_PROMPT_H_

#include <windows.h>

#include <atomic>
#include <cstdint>
#include <string>

namespace imcodes::rd {

/**
 * The attended-consent prompt: the local human's Allow/Deny gate.
 *
 * Deliberately a SEPARATE window from LocalIndicator rather than a mode of it.
 * The indicator carries "a session is running, here is Stop" and must stay
 * visible and clickable for the entire session -- including while this prompt
 * is up, because a prompt is exactly when an operator is most likely to want
 * Stop. Folding consent into the indicator would either hide Stop behind the
 * question or make one window mean two different things.
 *
 * The prompt renders only what the daemon passes and nothing a requester can
 * choose beyond a length-bounded label, which is drawn as inert text.
 */
class ConsentPrompt {
 public:
  enum class Outcome {
    // The human clicked. These two are the only values that may become a
    // decision; every other terminal state is a cancel.
    kAllowed,
    kDenied,
    // Not answered. Kept distinct so the caller can report an enumerated
    // cancel reason instead of a generic failure.
    kTimedOut,
    kCancelled,
    kUnavailable,
  };

  ConsentPrompt();
  ~ConsentPrompt();
  ConsentPrompt(const ConsentPrompt&) = delete;
  ConsentPrompt& operator=(const ConsentPrompt&) = delete;

  /**
   * Show the prompt and block the calling thread until answered, cancelled or
   * `deadline_ms` elapses. Returns kUnavailable when no interactive desktop is
   * attached or the protected desktop is in front -- the caller must treat
   * that as a cancel, never as a denial the requester could retry past.
   *
   * `requester_label` is untrusted, already length-bounded by the contract,
   * and drawn with DT_NOPREFIX so it cannot forge an accelerator or a second
   * line of chrome.
   */
  Outcome Ask(const std::wstring& requester_label, bool control_mode,
              uint32_t deadline_ms, uint64_t cancellation_generation);

  /**
   * Capture before dispatching a request to the prompt thread. Passing the
   * captured value to Ask makes a Dismiss that arrives before that thread is
   * scheduled observable instead of letting Ask reset and lose it.
   */
  uint64_t cancellation_generation() const {
    return cancellation_generation_.load();
  }

  /** Idempotent. Safe from another thread and for a prompt already closed. */
  void Cancel();

 private:
  static LRESULT CALLBACK WindowProc(HWND window, UINT message,
                                     WPARAM wparam, LPARAM lparam);
  LRESULT HandleMessage(HWND window, UINT message, WPARAM wparam,
                        LPARAM lparam);
  void PaintWindow(HWND window);
  void Finish(Outcome outcome);

  std::atomic<HWND> window_{nullptr};
  std::atomic<bool> finished_{false};
  std::atomic<uint64_t> cancellation_generation_{0};
  Outcome outcome_ = Outcome::kCancelled;
  std::wstring requester_label_;
  bool control_mode_ = false;
};

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_CONSENT_PROMPT_H_
