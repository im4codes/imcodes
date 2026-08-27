#include "macos_slvirtual_display_backend.h"

#include <algorithm>
#include <utility>

namespace imcodes::remote_desktop::macos {

SLVirtualDisplayBackend::SLVirtualDisplayBackend(
    std::unique_ptr<SLVirtualDisplayRuntime> runtime,
    std::uint32_t maximum_removal_polls)
    : runtime_(std::move(runtime)),
      maximum_removal_polls_(maximum_removal_polls) {}

SLVirtualDisplayBackend::~SLVirtualDisplayBackend() {
  Destroy();
}

common::ReadinessState SLVirtualDisplayBackend::ProbeSupport() noexcept {
  std::string error;
  return runtime_ != nullptr && maximum_removal_polls_ != 0 &&
                 runtime_->ProbeVerifiedRuntime(&error)
             ? common::ReadinessState::kReady
             : common::ReadinessState::kUnavailable;
}

bool SLVirtualDisplayBackend::Create(
    const MacosVirtualDisplayConfiguration& configuration,
    std::uint32_t* native_display_id,
    std::string* error) {
  if (native_display_id == nullptr || error == nullptr || runtime_ == nullptr ||
      !configuration.IsValid() || instance_.object != 0) {
    return false;
  }
  *native_display_id = 0;
  if (ProbeSupport() != common::ReadinessState::kReady) {
    *error = "SLVirtualDisplay runtime is not verified for this OS build";
    return false;
  }

  SLVirtualDisplayInstance candidate;
  if (!runtime_->CreateExact(configuration, &candidate, error))
    return false;
  if (!candidate.IsValid() ||
      candidate.generation != configuration.worker_generation ||
      !runtime_->ExactInstanceEndorsesDestroy(candidate)) {
    runtime_->ReleaseObject(candidate);
    *error = "created SLVirtualDisplay instance cannot prove exact destroy support";
    return false;
  }

  instance_ = candidate;
  destroy_invoked_ = false;
  removal_verified_ = false;
  if (!runtime_->ApplySettings(instance_, configuration.modes.front(),
                               configuration.modes, error)) {
    const std::string activation_error =
        error->empty() ? "SLVirtualDisplay activation failed" : *error;
    std::string cleanup_error;
    if (!DestroyAndVerify(&cleanup_error) && !cleanup_error.empty()) {
      *error = activation_error + "; cleanup not verified: " + cleanup_error;
    } else {
      *error = activation_error;
    }
    return false;
  }
  *native_display_id = instance_.display_id;
  error->clear();
  return true;
}

bool SLVirtualDisplayBackend::ApplyMode(
    std::uint32_t native_display_id,
    const MacosVirtualDisplayMode& mode,
    const std::vector<MacosVirtualDisplayMode>& modes,
    std::string* error) {
  if (error == nullptr || runtime_ == nullptr || !instance_.IsValid() ||
      native_display_id != instance_.display_id || !mode.IsValid()) {
    return false;
  }
  return runtime_->ApplySettings(instance_, mode, modes, error);
}

bool SLVirtualDisplayBackend::WaitUntilOnline(std::uint32_t native_display_id,
                                              std::uint32_t timeout_ms,
                                              std::string* error) {
  if (error == nullptr || runtime_ == nullptr || !instance_.IsValid() ||
      native_display_id != instance_.display_id || timeout_ms == 0) {
    return false;
  }
  const std::uint32_t polls = std::min(maximum_removal_polls_,
                                       std::max(1u, timeout_ms / 10u));
  for (std::uint32_t poll = 0; poll < polls; ++poll) {
    bool active = false;
    bool visible = false;
    if (runtime_->QueryPresence(instance_, &active, &visible) && active && visible) {
      error->clear();
      return true;
    }
    runtime_->SleepForRemovalPoll();
  }
  *error = "SLVirtualDisplay did not become active and visible before deadline";
  return false;
}

bool SLVirtualDisplayBackend::DestroyAndVerify(std::string* error) noexcept {
  if (error == nullptr || runtime_ == nullptr)
    return false;
  if (instance_.object == 0) {
    error->clear();
    return removal_verified_;
  }
  if (!runtime_->ExactInstanceEndorsesDestroy(instance_)) {
    *error = "owned SLVirtualDisplay instance identity or destroy IMP changed";
    return false;
  }
  if (!destroy_invoked_) {
    if (!runtime_->InvokeExactDestroy(instance_, error))
      return false;
    destroy_invoked_ = true;
  }
  for (std::uint32_t poll = 0; poll < maximum_removal_polls_; ++poll) {
    bool active = true;
    bool visible = true;
    if (runtime_->QueryPresence(instance_, &active, &visible) && !active && !visible) {
      removal_verified_ = true;
      ReleaseVerifiedInstance();
      error->clear();
      return true;
    }
    runtime_->SleepForRemovalPoll();
  }
  *error = "SLVirtualDisplay destroy was invoked but removal was not verified";
  return false;
}

void SLVirtualDisplayBackend::Destroy() noexcept {
  std::string ignored;
  (void)DestroyAndVerify(&ignored);
}

void SLVirtualDisplayBackend::ReleaseVerifiedInstance() noexcept {
  runtime_->ReleaseObject(instance_);
  instance_ = {};
}

}  // namespace imcodes::remote_desktop::macos
