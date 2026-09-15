#include "input_ledger.h"

#include <cmath>
#include <utility>

#include "platform_interfaces.h"

namespace imcodes::remote_desktop::common {

namespace {

bool IsBoundedToken(std::string_view value) noexcept {
  if (value.empty() || value.size() > kMaximumInputTokenBytes)
    return false;
  for (const unsigned char character : value) {
    const bool alpha_numeric = (character >= 'a' && character <= 'z') ||
                               (character >= 'A' && character <= 'Z') ||
                               (character >= '0' && character <= '9');
    if (!alpha_numeric && character != '_' && character != '-' &&
        character != '.') {
      return false;
    }
  }
  return true;
}

bool IsBoundedUtf8(std::string_view value) noexcept {
  if (value.empty() || value.size() > kMaximumInputTextBytes)
    return false;
  std::size_t offset = 0;
  while (offset < value.size()) {
    const auto first = static_cast<unsigned char>(value[offset]);
    if (first == 0)
      return false;
    if (first <= 0x7f) {
      ++offset;
      continue;
    }

    std::size_t continuation_count = 0;
    std::uint32_t code_point = 0;
    if (first >= 0xc2 && first <= 0xdf) {
      continuation_count = 1;
      code_point = first & 0x1f;
    } else if (first >= 0xe0 && first <= 0xef) {
      continuation_count = 2;
      code_point = first & 0x0f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      continuation_count = 3;
      code_point = first & 0x07;
    } else {
      return false;
    }
    if (offset + continuation_count >= value.size())
      return false;
    for (std::size_t index = 1; index <= continuation_count; ++index) {
      const auto next = static_cast<unsigned char>(value[offset + index]);
      if ((next & 0xc0) != 0x80)
        return false;
      code_point = (code_point << 6) | (next & 0x3f);
    }
    if ((continuation_count == 2 && code_point < 0x800) ||
        (continuation_count == 3 && code_point < 0x10000) ||
        (code_point >= 0xd800 && code_point <= 0xdfff) ||
        code_point > 0x10ffff) {
      return false;
    }
    offset += continuation_count + 1;
  }
  return true;
}

}  // namespace

InputLedger::InputLedger(InputAdapter& backend) noexcept : backend_(backend) {}

InputResult InputLedger::ValidateStamp(
    const InputStamp& stamp,
    TopologyRevision current_topology_revision,
    ControllerState** controller) {
  if (current_topology_revision == 0 ||
      stamp.topology_revision != current_topology_revision) {
    return InputResult::kStaleTopology;
  }
  if (stamp.controller_id.empty() ||
      stamp.controller_id.size() > kMaximumControllerIdBytes ||
      stamp.epoch == 0 || stamp.sequence == 0) {
    return InputResult::kInvalidInput;
  }

  auto [it, inserted] = controllers_.try_emplace(stamp.controller_id);
  ControllerState& state = it->second;
  if (inserted) {
    state.epoch = stamp.epoch;
  } else if (stamp.epoch < state.epoch) {
    return InputResult::kStaleEpoch;
  } else if (stamp.epoch > state.epoch) {
    if (!ReleaseControllerState(stamp.controller_id, &state)) {
      return InputResult::kAdapterFailure;
    }
    state.epoch = stamp.epoch;
    state.last_sequence = 0;
  }
  if (stamp.sequence <= state.last_sequence) {
    return InputResult::kStaleSequence;
  }
  state.last_sequence = stamp.sequence;
  *controller = &state;
  return InputResult::kApplied;
}

InputResult InputLedger::ApplyPointer(
    const InputStamp& stamp,
    TopologyRevision current_topology_revision,
    const LogicalPoint& point) {
  if (!std::isfinite(point.x) || !std::isfinite(point.y)) {
    return InputResult::kInvalidInput;
  }
  ControllerState* controller = nullptr;
  const InputResult validation =
      ValidateStamp(stamp, current_topology_revision, &controller);
  if (validation != InputResult::kApplied)
    return validation;
  (void)controller;
  return backend_.MovePointer(point) ? InputResult::kApplied
                                     : InputResult::kAdapterFailure;
}

InputResult InputLedger::ApplyOwnedTransition(
    const InputStamp& stamp,
    TopologyRevision current_topology_revision,
    std::string_view value,
    bool pressed,
    std::unordered_map<std::string, std::unordered_set<std::string>>* owners,
    std::unordered_set<std::string> ControllerState::* owned_values,
    bool (InputAdapter::*emit)(std::string_view, bool)) {
  if (!IsBoundedToken(value))
    return InputResult::kInvalidInput;
  ControllerState* controller = nullptr;
  const InputResult validation =
      ValidateStamp(stamp, current_topology_revision, &controller);
  if (validation != InputResult::kApplied)
    return validation;

  const std::string owned(value);
  auto& controller_values = controller->*owned_values;
  bool should_emit = false;
  if (pressed) {
    if (controller_values.insert(owned).second) {
      auto& value_owners = (*owners)[owned];
      should_emit = value_owners.empty();
      value_owners.insert(stamp.controller_id);
    }
  } else if (controller_values.erase(owned) > 0) {
    auto owner = owners->find(owned);
    if (owner != owners->end()) {
      owner->second.erase(stamp.controller_id);
      should_emit = owner->second.empty();
      if (should_emit)
        owners->erase(owner);
    }
  }

  if (should_emit && !(backend_.*emit)(value, pressed)) {
    return InputResult::kAdapterFailure;
  }
  return InputResult::kApplied;
}

InputResult InputLedger::ApplyKey(const InputStamp& stamp,
                                  TopologyRevision current_topology_revision,
                                  std::string_view key,
                                  bool pressed) {
  return ApplyOwnedTransition(stamp, current_topology_revision, key, pressed,
                              &key_owners_, &ControllerState::keys,
                              &InputAdapter::EmitKey);
}

InputResult InputLedger::ApplyButton(const InputStamp& stamp,
                                     TopologyRevision current_topology_revision,
                                     std::string_view button,
                                     bool pressed) {
  return ApplyOwnedTransition(stamp, current_topology_revision, button, pressed,
                              &button_owners_, &ControllerState::buttons,
                              &InputAdapter::EmitButton);
}

InputResult InputLedger::ClickButton(const InputStamp& stamp,
                                     TopologyRevision current_topology_revision,
                                     std::string_view button) {
  if (button.empty() || button.size() > kMaximumInputTokenBytes) {
    return InputResult::kInvalidInput;
  }
  const auto owners = button_owners_.find(std::string(button));
  if (owners != button_owners_.end() && !owners->second.empty()) {
    return InputResult::kInvalidInput;
  }
  ControllerState* controller = nullptr;
  const InputResult validation =
      ValidateStamp(stamp, current_topology_revision, &controller);
  if (validation != InputResult::kApplied)
    return validation;
  (void)controller;
  return backend_.EmitButton(button, true) && backend_.EmitButton(button, false)
             ? InputResult::kApplied
             : InputResult::kAdapterFailure;
}

InputResult InputLedger::ApplyWheel(const InputStamp& stamp,
                                    TopologyRevision current_topology_revision,
                                    double delta_x,
                                    double delta_y) {
  if (!std::isfinite(delta_x) || !std::isfinite(delta_y) ||
      delta_x < -kMaximumWheelDelta || delta_x > kMaximumWheelDelta ||
      delta_y < -kMaximumWheelDelta || delta_y > kMaximumWheelDelta) {
    return InputResult::kInvalidInput;
  }
  ControllerState* controller = nullptr;
  const InputResult validation =
      ValidateStamp(stamp, current_topology_revision, &controller);
  if (validation != InputResult::kApplied)
    return validation;
  (void)controller;
  return backend_.EmitWheel(delta_x, delta_y) ? InputResult::kApplied
                                              : InputResult::kAdapterFailure;
}

InputResult InputLedger::ApplyText(const InputStamp& stamp,
                                   TopologyRevision current_topology_revision,
                                   std::string_view text) {
  if (!IsBoundedUtf8(text))
    return InputResult::kInvalidInput;
  ControllerState* controller = nullptr;
  const InputResult validation =
      ValidateStamp(stamp, current_topology_revision, &controller);
  if (validation != InputResult::kApplied)
    return validation;
  (void)controller;
  return backend_.EmitText(text) ? InputResult::kApplied
                                 : InputResult::kAdapterFailure;
}

bool InputLedger::ReleaseControllerState(const std::string& controller_id,
                                         ControllerState* controller) noexcept {
  bool released = true;
  for (const std::string& key : controller->keys) {
    auto owners = key_owners_.find(key);
    if (owners == key_owners_.end())
      continue;
    owners->second.erase(controller_id);
    if (owners->second.empty()) {
      released = backend_.EmitKey(key, false) && released;
      key_owners_.erase(owners);
    }
  }
  for (const std::string& button : controller->buttons) {
    auto owners = button_owners_.find(button);
    if (owners == button_owners_.end())
      continue;
    owners->second.erase(controller_id);
    if (owners->second.empty()) {
      released = backend_.EmitButton(button, false) && released;
      button_owners_.erase(owners);
    }
  }
  controller->keys.clear();
  controller->buttons.clear();
  return released;
}

InputResult InputLedger::ReleaseController(
    std::string_view controller_id) noexcept {
  const auto it = controllers_.find(std::string(controller_id));
  if (it == controllers_.end())
    return InputResult::kApplied;
  const bool released = ReleaseControllerState(it->first, &it->second);
  controllers_.erase(it);
  return released ? InputResult::kApplied : InputResult::kAdapterFailure;
}

void InputLedger::ReleaseAll() noexcept {
  // The backend is the final authority for emitted OS state. Always invoke its
  // idempotent release seam, even when bookkeeping is empty: an adapter may
  // have emitted a transition immediately before reporting failure.
  backend_.ReleaseAllEmittedState();
  controllers_.clear();
  key_owners_.clear();
  button_owners_.clear();
}

}  // namespace imcodes::remote_desktop::common
