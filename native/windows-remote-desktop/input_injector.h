#ifndef IMCODES_REMOTE_DESKTOP_INPUT_INJECTOR_H_
#define IMCODES_REMOTE_DESKTOP_INPUT_INJECTOR_H_

#include <windows.h>

#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <set>
#include <string>

#include "third_party/imcodes_remote_desktop/display_capture.h"

namespace imcodes::rd {

// Coordinates concurrent controllers on the one Windows input desktop.
// Per-peer ledgers remain independent, while the global reference counts keep
// one peer's release-all from releasing a key/button another peer still owns.
class InputArbiter {
 public:
  using SendInputFn = std::function<UINT(UINT, LPINPUT, int)>;

  explicit InputArbiter(SendInputFn send_input = {});
  bool KeyDown(const std::string& owner, const std::string& code, bool repeat);
  bool KeyUp(const std::string& owner, const std::string& code);
  bool ButtonDown(const std::string& owner, const std::string& button);
  bool ButtonUp(const std::string& owner, const std::string& button);
  bool Move(const DisplayInfo& display, double x, double y);
  bool Wheel(double delta_x, double delta_y);
  bool Text(const std::u16string& value);
  void ReleaseOwner(const std::string& owner);
  bool RetryPendingReleases();

 private:
  bool Dispatch(INPUT* inputs, UINT count);
  bool SendKey(const std::string& code, bool down);
  bool SendButton(const std::string& button, bool down);

  const SendInputFn send_input_;
  std::mutex mutex_;
  std::map<std::string, std::set<std::string>> key_owners_;
  std::map<std::string, std::set<std::string>> button_owners_;
};

// Crash-recovery path used by the service after the worker pipe disappears.
// It emits key/button-up only for the documented remote-input allowlist and
// carries no session, key history, credential, or user content.
bool ReleaseAllSupportedInput(InputArbiter::SendInputFn send_input = {});

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_INPUT_INJECTOR_H_
