#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_SLVIRTUAL_DISPLAY_BACKEND_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_SLVIRTUAL_DISPLAY_BACKEND_H_

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "macos_virtual_display_adapter.h"

namespace imcodes::remote_desktop::macos {

struct SLVirtualDisplayInstance {
  std::uintptr_t object = 0;
  std::uintptr_t destroy_implementation = 0;
  common::WorkerGeneration generation = 0;
  std::uint32_t display_id = 0;

  [[nodiscard]] bool IsValid() const noexcept {
    return object != 0 && destroy_implementation != 0 && generation != 0 &&
           display_id != 0;
  }
};

// Injectable boundary around the private Objective-C runtime. The production
// implementation resolves and type-checks every method before creating an
// object, then records the exact created object's destroy IMP in the instance.
class SLVirtualDisplayRuntime {
 public:
  virtual ~SLVirtualDisplayRuntime() = default;
  virtual bool ProbeVerifiedRuntime(std::string* error) noexcept = 0;
  virtual bool CreateExact(const MacosVirtualDisplayConfiguration& configuration,
                           SLVirtualDisplayInstance* instance,
                           std::string* error) = 0;
  virtual bool ExactInstanceEndorsesDestroy(
      const SLVirtualDisplayInstance& instance) noexcept = 0;
  virtual bool ApplySettings(const SLVirtualDisplayInstance& instance,
                             const MacosVirtualDisplayMode& selected,
                             const std::vector<MacosVirtualDisplayMode>& modes,
                             std::string* error) = 0;
  virtual bool QueryPresence(const SLVirtualDisplayInstance& instance,
                             bool* active,
                             bool* visible) noexcept = 0;
  virtual bool InvokeExactDestroy(const SLVirtualDisplayInstance& instance,
                                  std::string* error) noexcept = 0;
  virtual void SleepForRemovalPoll() noexcept = 0;
  virtual void ReleaseObject(const SLVirtualDisplayInstance& instance) noexcept = 0;
};

class SLVirtualDisplayBackend final : public MacosVirtualDisplayBackend {
 public:
  explicit SLVirtualDisplayBackend(
      std::unique_ptr<SLVirtualDisplayRuntime> runtime,
      std::uint32_t maximum_removal_polls = 500);
  ~SLVirtualDisplayBackend() override;

  common::ReadinessState ProbeSupport() noexcept override;
  bool Create(const MacosVirtualDisplayConfiguration& configuration,
              std::uint32_t* native_display_id,
              std::string* error) override;
  bool ApplyMode(std::uint32_t native_display_id,
                 const MacosVirtualDisplayMode& mode,
                 const std::vector<MacosVirtualDisplayMode>& modes,
                 std::string* error) override;
  bool WaitUntilOnline(std::uint32_t native_display_id,
                       std::uint32_t timeout_ms,
                       std::string* error) override;
  void Destroy() noexcept override;

  [[nodiscard]] bool DestroyAndVerify(std::string* error) noexcept;
  [[nodiscard]] bool removal_verified() const noexcept {
    return removal_verified_;
  }
  [[nodiscard]] const SLVirtualDisplayInstance& owned_instance() const noexcept {
    return instance_;
  }

 private:
  void ReleaseVerifiedInstance() noexcept;

  std::unique_ptr<SLVirtualDisplayRuntime> runtime_;
  SLVirtualDisplayInstance instance_;
  std::uint32_t maximum_removal_polls_ = 0;
  bool destroy_invoked_ = false;
  bool removal_verified_ = false;
};

[[nodiscard]] std::unique_ptr<SLVirtualDisplayRuntime>
CreateSystemSLVirtualDisplayRuntime();
// Production wiring should retain this concrete type until teardown so it can
// use DestroyAndVerify(error). Create() returns true only after the exact
// instance's destroy IMP is endorsed and initial settings are active.
[[nodiscard]] std::unique_ptr<SLVirtualDisplayBackend>
CreateSLVirtualDisplayBackend();

}  // namespace imcodes::remote_desktop::macos

#endif
