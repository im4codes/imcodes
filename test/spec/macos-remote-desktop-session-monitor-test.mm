#include <cstdlib>
#include <functional>
#include <iostream>
#include <memory>
#include <utility>
#include <vector>

#include "../../native/macos-remote-desktop/macos_session_monitor.h"

namespace {

using imcodes::remote_desktop::common::GraphicalSessionEvent;
using imcodes::remote_desktop::common::ReadinessState;
using imcodes::remote_desktop::macos::MacosSessionEventSink;
using imcodes::remote_desktop::macos::MacosSessionMonitor;
using imcodes::remote_desktop::macos::MacosSessionMonitorBackend;

void Require(bool condition, const char *message) {
  if (condition)
    return;
  std::cerr << message << '\n';
  std::exit(1);
}

class FakeBackend final : public MacosSessionMonitorBackend {
public:
  ReadinessState ProbeReadiness() override { return readiness; }

  bool Start(std::uint64_t generation,
             MacosSessionEventSink next_sink) override {
    ++start_count;
    active_generation = generation;
    sink = std::move(next_sink);
    if (fire_during_start && sink) {
      sink(GraphicalSessionEvent::kReady, active_generation);
    }
    return start_result;
  }

  void Stop() noexcept override { ++stop_count; }

  void Fire(GraphicalSessionEvent event) {
    if (sink)
      sink(event, active_generation);
  }

  ReadinessState readiness = ReadinessState::kReady;
  bool start_result = true;
  bool fire_during_start = false;
  int start_count = 0;
  int stop_count = 0;
  std::uint64_t active_generation = 0;
  MacosSessionEventSink sink;
};

bool TestForwardsEveryLifecycleBoundary() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend *raw = backend.get();
  MacosSessionMonitor monitor(std::move(backend));
  std::vector<GraphicalSessionEvent> events;
  Require(monitor.Start(
              [&](GraphicalSessionEvent event) { events.push_back(event); }),
          "monitor should start");
  for (GraphicalSessionEvent event : {
           GraphicalSessionEvent::kReady,
           GraphicalSessionEvent::kLocked,
           GraphicalSessionEvent::kUnlocked,
           GraphicalSessionEvent::kUserChanged,
           GraphicalSessionEvent::kSleeping,
           GraphicalSessionEvent::kWoke,
           GraphicalSessionEvent::kEnded,
       }) {
    raw->Fire(event);
  }
  Require(events.size() == 7, "all lifecycle boundaries should be forwarded");
  monitor.Stop();
  Require(raw->stop_count >= 2,
          "start and explicit stop should clean registration");
  return true;
}

bool TestStaleCallbacksCannotReviveStoppedGeneration() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend *raw = backend.get();
  MacosSessionMonitor monitor(std::move(backend));
  int callbacks = 0;
  Require(monitor.Start([&](GraphicalSessionEvent) { ++callbacks; }),
          "first monitor start should succeed");
  const MacosSessionEventSink stale_sink = raw->sink;
  const std::uint64_t stale_generation = raw->active_generation;
  monitor.Stop();
  stale_sink(GraphicalSessionEvent::kWoke, stale_generation);
  Require(callbacks == 0, "stale callback after stop must be ignored");

  Require(monitor.Start([&](GraphicalSessionEvent) { ++callbacks; }),
          "second monitor start should succeed");
  stale_sink(GraphicalSessionEvent::kReady, stale_generation);
  Require(callbacks == 0, "stale callback after restart must be ignored");
  raw->Fire(GraphicalSessionEvent::kReady);
  Require(callbacks == 1, "current generation callback should be delivered");
  return true;
}

bool TestUnavailableAndFailedStartStayClosed() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend *raw = backend.get();
  MacosSessionMonitor monitor(std::move(backend));
  raw->readiness = ReadinessState::kUnavailable;
  Require(monitor.ProbeReadiness() == ReadinessState::kUnavailable,
          "unavailable readiness should remain unavailable");
  Require(!monitor.Start([](GraphicalSessionEvent) {}),
          "unavailable backend must fail closed");
  raw->readiness = ReadinessState::kReady;
  raw->start_result = false;
  Require(!monitor.Start([](GraphicalSessionEvent) {}),
          "backend registration failure must fail closed");
  return true;
}

bool TestSynchronousInitialEventDoesNotDeadlockOrDisappear() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend *raw = backend.get();
  raw->fire_during_start = true;
  MacosSessionMonitor monitor(std::move(backend));
  int callbacks = 0;
  Require(monitor.Start([&](GraphicalSessionEvent event) {
    if (event == GraphicalSessionEvent::kReady)
      ++callbacks;
  }),
          "monitor should accept a synchronous initial event");
  Require(callbacks == 1, "synchronous initial event must be delivered once");
  return true;
}

} // namespace

int main() {
  return TestForwardsEveryLifecycleBoundary() &&
                 TestStaleCallbacksCannotReviveStoppedGeneration() &&
                 TestUnavailableAndFailedStartStayClosed() &&
                 TestSynchronousInitialEventDoesNotDeadlockOrDisappear()
             ? 0
             : 1;
}
