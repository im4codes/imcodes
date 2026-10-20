#include "macos_session_monitor.h"

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

#include <mutex>
#include <utility>
#include <vector>

namespace imcodes::remote_desktop::macos {
namespace {

class SystemMacosSessionMonitorBackend final
    : public MacosSessionMonitorBackend {
public:
  common::ReadinessState ProbeReadiness() override {
    @autoreleasepool {
      if (![NSThread isMainThread] || NSWorkspace.sharedWorkspace == nil) {
        return common::ReadinessState::kUnavailable;
      }
      return common::ReadinessState::kReady;
    }
  }

  bool Start(std::uint64_t generation,
             MacosSessionEventSink event_sink) override {
    if (!event_sink || ProbeReadiness() != common::ReadinessState::kReady) {
      return false;
    }
    Stop();
    @autoreleasepool {
      generation_ = generation;
      event_sink_ = std::move(event_sink);
      NSNotificationCenter *workspace_center =
          NSWorkspace.sharedWorkspace.notificationCenter;
      NSDistributedNotificationCenter *distributed_center =
          NSDistributedNotificationCenter.defaultCenter;

      Add(workspace_center, NSWorkspaceWillSleepNotification,
          common::GraphicalSessionEvent::kSleeping);
      Add(workspace_center, NSWorkspaceDidWakeNotification,
          common::GraphicalSessionEvent::kWoke);
      Add(workspace_center, NSWorkspaceSessionDidResignActiveNotification,
          common::GraphicalSessionEvent::kUserChanged);
      Add(workspace_center, NSWorkspaceSessionDidBecomeActiveNotification,
          common::GraphicalSessionEvent::kReady);
      Add(workspace_center, NSWorkspaceWillPowerOffNotification,
          common::GraphicalSessionEvent::kEnded);
      Add(distributed_center, @"com.apple.screenIsLocked",
          common::GraphicalSessionEvent::kLocked);
      Add(distributed_center, @"com.apple.screenIsUnlocked",
          common::GraphicalSessionEvent::kUnlocked);
      return !registrations_.empty();
    }
  }

  void Stop() noexcept override {
    @autoreleasepool {
      for (const Registration &registration : registrations_) {
        [registration.center removeObserver:registration.token];
      }
      registrations_.clear();
      event_sink_ = {};
      generation_ = 0;
    }
  }

private:
  struct Registration {
    __strong NSNotificationCenter *center;
    __strong id token;
  };

  void Add(NSNotificationCenter *center, NSNotificationName name,
           common::GraphicalSessionEvent event) {
    const std::uint64_t generation = generation_;
    MacosSessionEventSink sink = event_sink_;
    id token = [center addObserverForName:name
                                   object:nil
                                    queue:NSOperationQueue.mainQueue
                               usingBlock:^(__unused NSNotification *note) {
                                 if (sink)
                                   sink(event, generation);
                               }];
    if (token != nil)
      registrations_.push_back({center, token});
  }

  std::vector<Registration> registrations_;
  MacosSessionEventSink event_sink_;
  std::uint64_t generation_ = 0;
};

std::unique_ptr<MacosSessionMonitorBackend> CreateSystemBackend() {
  return std::make_unique<SystemMacosSessionMonitorBackend>();
}

} // namespace

class MacosSessionMonitor::Impl {
public:
  explicit Impl(std::unique_ptr<MacosSessionMonitorBackend> backend)
      : backend_(std::move(backend)) {}

  common::ReadinessState ProbeReadiness() {
    std::lock_guard operation_lock(operation_mutex_);
    return backend_ ? backend_->ProbeReadiness()
                    : common::ReadinessState::kUnavailable;
  }

  bool Start(Observer observer) {
    if (!observer)
      return false;
    std::lock_guard operation_lock(operation_mutex_);
    StopLocked();
    if (!backend_ ||
        backend_->ProbeReadiness() != common::ReadinessState::kReady) {
      return false;
    }
    std::uint64_t generation = 0;
    {
      std::lock_guard state_lock(state_mutex_);
      generation = ++generation_;
      observer_ = std::move(observer);
      running_ = true;
    }
    const bool started =
        backend_->Start(generation, [this](common::GraphicalSessionEvent event,
                                           std::uint64_t event_generation) {
          Observer observer_copy;
          {
            std::lock_guard callback_lock(state_mutex_);
            if (!running_ || event_generation != generation_)
              return;
            observer_copy = observer_;
          }
          if (observer_copy)
            observer_copy(event);
        });
    if (!started) {
      std::lock_guard state_lock(state_mutex_);
      if (generation_ == generation) {
        running_ = false;
        observer_ = {};
      }
      return false;
    }
    return true;
  }

  void Stop() noexcept {
    std::lock_guard operation_lock(operation_mutex_);
    StopLocked();
  }

private:
  void StopLocked() noexcept {
    {
      std::lock_guard state_lock(state_mutex_);
      ++generation_;
      running_ = false;
      observer_ = {};
    }
    if (backend_)
      backend_->Stop();
  }

  std::mutex operation_mutex_;
  std::mutex state_mutex_;
  std::unique_ptr<MacosSessionMonitorBackend> backend_;
  Observer observer_;
  std::uint64_t generation_ = 0;
  bool running_ = false;
};

MacosSessionMonitor::MacosSessionMonitor()
    : MacosSessionMonitor(CreateSystemBackend()) {}

MacosSessionMonitor::MacosSessionMonitor(
    std::unique_ptr<MacosSessionMonitorBackend> backend)
    : impl_(std::make_unique<Impl>(std::move(backend))) {}

MacosSessionMonitor::~MacosSessionMonitor() { impl_->Stop(); }

common::ReadinessState MacosSessionMonitor::ProbeReadiness() {
  return impl_->ProbeReadiness();
}

bool MacosSessionMonitor::Start(Observer observer) {
  return impl_->Start(std::move(observer));
}

void MacosSessionMonitor::Stop() noexcept { impl_->Stop(); }

} // namespace imcodes::remote_desktop::macos
