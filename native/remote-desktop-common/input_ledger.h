#ifndef IMCODES_REMOTE_DESKTOP_COMMON_INPUT_LEDGER_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_INPUT_LEDGER_H_

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>

#include "value_types.h"

namespace imcodes::remote_desktop::common {

class InputAdapter;

inline constexpr std::size_t kMaximumControllerIdBytes = 128;
inline constexpr std::size_t kMaximumInputTokenBytes = 64;
inline constexpr std::size_t kMaximumInputTextBytes = 4096;
inline constexpr double kMaximumWheelDelta = 10'000.0;

enum class InputResult : std::uint8_t {
  kApplied,
  kCapabilityUnavailable,
  kTerminal,
  kStaleEpoch,
  kStaleSequence,
  kStaleTopology,
  kUnknownDisplay,
  kInvalidInput,
  kAdapterFailure,
};

struct InputStamp {
  std::string controller_id;
  InputEpoch epoch = 0;
  InputSequence sequence = 0;
  TopologyRevision topology_revision = 0;
};

// Owns all controller authority and held-input bookkeeping. Platform backends
// see only transitions that have passed epoch, sequence, topology and payload
// validation; they never reimplement ownership or replay protection.
class InputLedger {
 public:
  explicit InputLedger(InputAdapter& backend) noexcept;

  InputLedger(const InputLedger&) = delete;
  InputLedger& operator=(const InputLedger&) = delete;

  InputResult ApplyPointer(const InputStamp& stamp,
                           TopologyRevision current_topology_revision,
                           const LogicalPoint& point);
  InputResult ApplyKey(const InputStamp& stamp,
                       TopologyRevision current_topology_revision,
                       std::string_view key,
                       bool pressed);
  InputResult ApplyButton(const InputStamp& stamp,
                          TopologyRevision current_topology_revision,
                          std::string_view button,
                          bool pressed);
  // Emits one atomic click only when no controller currently owns the button.
  // This prevents a click from releasing another controller's held state.
  InputResult ClickButton(const InputStamp& stamp,
                          TopologyRevision current_topology_revision,
                          std::string_view button);
  InputResult ApplyWheel(const InputStamp& stamp,
                         TopologyRevision current_topology_revision,
                         double delta_x,
                         double delta_y);
  InputResult ApplyText(const InputStamp& stamp,
                        TopologyRevision current_topology_revision,
                        std::string_view text);

  InputResult ReleaseController(std::string_view controller_id) noexcept;
  void ReleaseAll() noexcept;

  [[nodiscard]] std::size_t controller_count() const noexcept {
    return controllers_.size();
  }

 private:
  struct ControllerState {
    InputEpoch epoch = 0;
    InputSequence last_sequence = 0;
    std::unordered_set<std::string> keys;
    std::unordered_set<std::string> buttons;
  };

  InputResult ValidateStamp(const InputStamp& stamp,
                            TopologyRevision current_topology_revision,
                            ControllerState** controller);
  InputResult ApplyOwnedTransition(
      const InputStamp& stamp,
      TopologyRevision current_topology_revision,
      std::string_view value,
      bool pressed,
      std::unordered_map<std::string, std::unordered_set<std::string>>* owners,
      std::unordered_set<std::string> ControllerState::* owned_values,
      bool (InputAdapter::*emit)(std::string_view, bool));
  bool ReleaseControllerState(const std::string& controller_id,
                              ControllerState* controller) noexcept;

  InputAdapter& backend_;
  std::unordered_map<std::string, ControllerState> controllers_;
  std::unordered_map<std::string, std::unordered_set<std::string>> key_owners_;
  std::unordered_map<std::string, std::unordered_set<std::string>>
      button_owners_;
};

}  // namespace imcodes::remote_desktop::common

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_INPUT_LEDGER_H_
