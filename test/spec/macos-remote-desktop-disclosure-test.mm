#include "macos_local_disclosure.h"

#include <sysexits.h>

#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace common = imcodes::remote_desktop::common;
namespace macos = imcodes::remote_desktop::macos;

namespace {

void Require(bool condition, const char *message) {
  if (!condition) {
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
  }
}

class FakeDisclosureBackend final : public macos::MacosLocalDisclosureBackend {
public:
  common::ReadinessState ProbeReadiness() noexcept override {
    call_order.emplace_back("probe");
    common::ReadinessState next_readiness = readiness;
    if (ready_probe_budget == 0) {
      next_readiness = common::ReadinessState::kUnavailable;
    } else if (ready_probe_budget > 0) {
      --ready_probe_budget;
    }
    return visible && next_readiness == common::ReadinessState::kReady
               ? common::ReadinessState::kReady
               : common::ReadinessState::kUnavailable;
  }

  bool Show(std::uint32_t next_viewers, std::uint32_t next_controllers,
            std::uint64_t next_generation,
            macos::MacosDisclosureEventSink next_event_sink) noexcept override {
    call_order.emplace_back("show");
    ++show_count;
    viewers = next_viewers;
    controllers = next_controllers;
    generation = next_generation;
    event_sink = std::move(next_event_sink);
    visible = show_succeeds;
    if (event_during_show && event_sink) {
      visible = false;
      event_sink(macos::MacosDisclosureEvent::kWindowFailed, generation);
    }
    return show_succeeds;
  }

  void Hide() noexcept override {
    call_order.emplace_back("hide");
    ++hide_count;
    visible = false;
  }

  void Fire(macos::MacosDisclosureEvent event, std::uint64_t event_generation) {
    visible = false;
    if (event_sink) {
      event_sink(event, event_generation);
    }
  }

  common::ReadinessState readiness = common::ReadinessState::kReady;
  // Negative means every probe uses `readiness`; zero forces unavailable.
  // A positive value allows exactly that many ready probes before loss.
  int ready_probe_budget = -1;
  std::vector<std::string> call_order;
  macos::MacosDisclosureEventSink event_sink;
  bool show_succeeds = true;
  bool event_during_show = false;
  bool visible = false;
  std::uint32_t viewers = 0;
  std::uint32_t controllers = 0;
  std::uint64_t generation = 0;
  int show_count = 0;
  int hide_count = 0;
};

} // namespace

int main() {
  {
    auto process_backend = std::make_unique<FakeDisclosureBackend>();
    FakeDisclosureBackend* process_backend_ptr = process_backend.get();
    macos::MacosLocalDisclosureAdapter process_adapter(
        std::move(process_backend), [](std::uint64_t) {});
    int ready_count = 0;
    int failed_count = 0;
    int probe_count = 0;
    int loop_count = 0;
    std::uint64_t expected_generation = 7;
    auto run_process = [&](macos::DisclosureStartupOutcome outcome,
                           bool probe_only = false) {
      ready_count = 0;
      failed_count = 0;
      probe_count = 0;
      loop_count = 0;
      return macos::RunDisclosureProcessAfterStartup(
          outcome, expected_generation, probe_only, process_adapter,
          macos::DisclosureProcessCallbacks{
              .emit_ready = [&](std::uint64_t generation) {
                Require(generation == expected_generation,
                        "Ready preserves the exact generation");
                ++ready_count;
                return true;
              },
              .emit_failed = [&](std::uint64_t generation) {
                Require(generation == expected_generation,
                        "Failed preserves the exact generation");
                ++failed_count;
              },
              .report_probe_success = [&] { ++probe_count; },
              .run_visible_loop = [&] {
                ++loop_count;
                return 73;
              },
          });
    };

    for (const macos::DisclosureStartupOutcome failure : {
             macos::DisclosureStartupOutcome::kBeginSessionFailed,
             macos::DisclosureStartupOutcome::kShowFailed,
             macos::DisclosureStartupOutcome::kNotVisible,
             macos::DisclosureStartupOutcome::kReadinessLost,
         }) {
      for (const bool probe_only : {false, true}) {
        Require(run_process(failure, probe_only) == EX_UNAVAILABLE,
                "every failed startup returns unavailable, including probes");
        Require(failed_count == 1 && ready_count == 0 && loop_count == 0 &&
                    probe_count == 0,
                "failed startup emits Failed before probe, Ready, or run");
      }
    }

    Require(process_adapter.BeginSession(expected_generation) &&
                process_adapter.Show(1, 0),
            "normal process fixture starts from a visible disclosure");
    const int hide_count_before_loop = process_backend_ptr->hide_count;
    Require(run_process(macos::DisclosureStartupOutcome::kVisibleAndReady) ==
                73,
            "visible-and-ready startup enters the production loop");
    Require(ready_count == 1 && failed_count == 0 && loop_count == 1 &&
                probe_count == 0 &&
                process_backend_ptr->hide_count == hide_count_before_loop + 1,
            "visible startup emits Ready, runs, and performs final cleanup");

    expected_generation = 8;
    Require(process_adapter.BeginSession(expected_generation) &&
                process_adapter.Show(1, 0),
            "probe-only fixture starts from a visible disclosure");
    const int hide_count_before_probe = process_backend_ptr->hide_count;
    Require(run_process(macos::DisclosureStartupOutcome::kVisibleAndReady,
                        true) == EX_OK,
            "probe-only visible startup exits successfully");
    Require(ready_count == 0 && failed_count == 0 && loop_count == 0 &&
                probe_count == 1 &&
                process_backend_ptr->hide_count == hide_count_before_probe + 1,
            "probe-only reports success without Ready and performs bounded cleanup");
  }

  {
    std::vector<std::uint64_t> startup_stops;
    auto startup_backend = std::make_unique<FakeDisclosureBackend>();
    FakeDisclosureBackend* startup_backend_ptr = startup_backend.get();
    macos::MacosLocalDisclosureAdapter startup(
        std::move(startup_backend),
        [&startup_stops](std::uint64_t generation) {
          startup_stops.push_back(generation);
        });
    Require(macos::RunDisclosureStartup(startup, 10, 2, 1) ==
                macos::DisclosureStartupOutcome::kVisibleAndReady,
            "production startup shows before confirming readiness");
    Require(startup_backend_ptr->call_order ==
                std::vector<std::string>{"show", "probe", "probe"},
            "no readiness probe may run before the disclosure is shown");
    Require(startup.IsVisible() && startup_stops.empty(),
            "successful startup leaves one visible disclosure without Stop");
    startup.Hide();
    Require(startup_backend_ptr->call_order ==
                std::vector<std::string>{"show", "probe", "probe", "hide"},
            "probe-only cleanup can hide the confirmed surface exactly once");
  }

  {
    auto missing_stop_backend = std::make_unique<FakeDisclosureBackend>();
    FakeDisclosureBackend* missing_stop_ptr = missing_stop_backend.get();
    macos::MacosLocalDisclosureAdapter missing_stop(
        std::move(missing_stop_backend), {});
    Require(macos::RunDisclosureStartup(missing_stop, 11, 1, 0) ==
                macos::DisclosureStartupOutcome::kBeginSessionFailed,
            "startup reports a missing trusted Stop boundary");
    Require(missing_stop_ptr->call_order.empty(),
            "BeginSession failure cannot touch the disclosure backend");
  }

  {
    std::vector<std::uint64_t> show_failure_stops;
    auto show_failure_backend = std::make_unique<FakeDisclosureBackend>();
    FakeDisclosureBackend* show_failure_ptr = show_failure_backend.get();
    show_failure_ptr->show_succeeds = false;
    macos::MacosLocalDisclosureAdapter show_failure(
        std::move(show_failure_backend),
        [&show_failure_stops](std::uint64_t generation) {
          show_failure_stops.push_back(generation);
        });
    Require(macos::RunDisclosureStartup(show_failure, 12, 1, 0) ==
                macos::DisclosureStartupOutcome::kShowFailed,
            "startup reports backend window creation failure");
    Require(show_failure_ptr->call_order ==
                std::vector<std::string>{"show", "hide"},
            "failed Show tears down without probing an absent surface");
    Require(show_failure_stops == std::vector<std::uint64_t>{12} &&
                !show_failure.IsVisible(),
            "failed Show revokes the exact generation and leaves no surface");
  }

  {
    std::vector<std::uint64_t> readiness_loss_stops;
    auto readiness_loss_backend = std::make_unique<FakeDisclosureBackend>();
    FakeDisclosureBackend* readiness_loss_ptr = readiness_loss_backend.get();
    readiness_loss_ptr->ready_probe_budget = 1;
    macos::MacosLocalDisclosureAdapter readiness_loss(
        std::move(readiness_loss_backend),
        [&readiness_loss_stops](std::uint64_t generation) {
          readiness_loss_stops.push_back(generation);
        });
    Require(macos::RunDisclosureStartup(readiness_loss, 13, 1, 0) ==
                macos::DisclosureStartupOutcome::kReadinessLost,
            "startup distinguishes readiness loss after visible Show");
    Require(readiness_loss_ptr->call_order ==
                std::vector<std::string>{"show", "probe", "probe", "hide"},
            "post-Show readiness loss performs one fail-closed cleanup");
    Require(readiness_loss_stops == std::vector<std::uint64_t>{13} &&
                !readiness_loss.IsVisible(),
            "readiness loss revokes the exact generation and hides the window");
  }

  {
    auto no_stop_backend = std::make_unique<FakeDisclosureBackend>();
    macos::MacosLocalDisclosureAdapter no_stop(std::move(no_stop_backend), {});
    Require(!no_stop.BeginSession(1),
            "readiness cannot start without a trusted local Stop boundary");
  }

  std::vector<std::uint64_t> stopped_generations;
  auto backend = std::make_unique<FakeDisclosureBackend>();
  FakeDisclosureBackend *backend_ptr = backend.get();
  macos::MacosLocalDisclosureAdapter disclosure(
      std::move(backend), [&stopped_generations](std::uint64_t generation) {
        stopped_generations.push_back(generation);
      });

  Require(disclosure.ProbeReadiness() == common::ReadinessState::kUnavailable,
          "disclosure is unavailable before an active generation");
  Require(disclosure.BeginSession(41), "first generation starts");
  Require(disclosure.ProbeReadiness() == common::ReadinessState::kUnavailable,
          "route readiness remains unavailable before the window is visible");
  Require(disclosure.Show(2, 1), "bounded local disclosure becomes visible");
  Require(disclosure.IsVisible() && backend_ptr->visible,
          "successful Show owns a visible disclosure");
  Require(backend_ptr->viewers == 2 && backend_ptr->controllers == 1,
          "backend receives only viewer/controller counts");
  Require(disclosure.ProbeReadiness() == common::ReadinessState::kReady,
          "readiness becomes ready only after visibility confirmation");

  backend_ptr->Fire(macos::MacosDisclosureEvent::kLocalStop, 41);
  Require(stopped_generations == std::vector<std::uint64_t>{41},
          "trusted local Stop ends all routes for the live generation");
  Require(disclosure.ProbeReadiness() == common::ReadinessState::kUnavailable,
          "local Stop synchronously revokes disclosure readiness");
  backend_ptr->Fire(macos::MacosDisclosureEvent::kWindowClosed, 41);
  Require(stopped_generations.size() == 1,
          "duplicate local events cannot dispatch Stop twice");
  const int hide_count_before_duplicate_cleanup = backend_ptr->hide_count;
  disclosure.Hide();
  disclosure.Hide();
  Require(backend_ptr->hide_count == hide_count_before_duplicate_cleanup,
          "duplicate Hide does not repeat backend cleanup");

  Require(disclosure.BeginSession(50), "next generation starts");
  Require(disclosure.Show(1, 0), "viewer-only disclosure is valid");
  const macos::MacosDisclosureEventSink stale_sink = backend_ptr->event_sink;
  Require(disclosure.BeginSession(51), "new generation replaces the old one");
  stale_sink(macos::MacosDisclosureEvent::kWindowClosed, 50);
  Require(stopped_generations.size() == 1,
          "a stale window callback cannot stop a newer generation");
  Require(disclosure.Show(3, 2), "new generation can become ready");
  backend_ptr->Fire(macos::MacosDisclosureEvent::kWindowClosed, 51);
  Require(stopped_generations.back() == 51 && stopped_generations.size() == 2,
          "closing the live window fails closed");

  Require(disclosure.BeginSession(60), "crash fixture starts");
  Require(disclosure.Show(1, 1), "crash fixture becomes visible");
  disclosure.ReportProcessCrash(59);
  Require(stopped_generations.size() == 2,
          "stale process crash cannot stop the live generation");
  Require(disclosure.IsVisible(),
          "stale process crash cannot hide the live disclosure");
  disclosure.ReportProcessCrash(60);
  Require(stopped_generations.back() == 60 && stopped_generations.size() == 3,
          "live disclosure process crash stops all routes");
  disclosure.ReportProcessCrash(60);
  Require(stopped_generations.size() == 3,
          "duplicate crash notification is idempotent");

  Require(disclosure.BeginSession(70), "bounds fixture starts");
  Require(!disclosure.Show(macos::kMacosDisclosureMaxViewers + 1, 0),
          "viewer count is bounded before reaching AppKit");
  Require(!disclosure.Show(1, macos::kMacosDisclosureMaxControllers + 1),
          "controller count is bounded before reaching AppKit");
  Require(!disclosure.Show(1, 2),
          "controller count cannot exceed the visible viewer count");
  Require(backend_ptr->show_count == 4,
          "invalid counts never reach the disclosure backend");
  Require(disclosure.Show(macos::kMacosDisclosureMaxViewers,
                          macos::kMacosDisclosureMaxControllers),
          "the documented participant bounds remain usable");

  backend_ptr->readiness = common::ReadinessState::kUnavailable;
  Require(disclosure.ProbeReadiness() == common::ReadinessState::kUnavailable,
          "lost window readiness is immediately unavailable");
  Require(stopped_generations.back() == 70 && stopped_generations.size() == 4,
          "lost window readiness invokes fail-closed Stop");

  backend_ptr->readiness = common::ReadinessState::kReady;
  backend_ptr->show_succeeds = false;
  Require(disclosure.BeginSession(80), "show-failure fixture starts");
  Require(!disclosure.Show(1, 0), "window creation failure rejects Show");
  Require(stopped_generations.back() == 80 && stopped_generations.size() == 5,
          "window creation failure invokes fail-closed Stop");

  backend_ptr->show_succeeds = true;
  backend_ptr->event_during_show = true;
  Require(disclosure.BeginSession(90), "in-show failure fixture starts");
  Require(!disclosure.Show(1, 0),
          "a failure callback during Show cannot transiently grant readiness");
  Require(stopped_generations.back() == 90 && stopped_generations.size() == 6,
          "in-show failure stops the exact generation once");

  backend_ptr->event_during_show = false;
  Require(disclosure.BeginSession(110) && disclosure.Show(1, 0),
          "monotonic-generation fixture becomes visible");
  const int hide_count_before_stale_begin = backend_ptr->hide_count;
  Require(!disclosure.BeginSession(109),
          "stale BeginSession cannot replace the live generation");
  Require(disclosure.IsVisible() &&
              backend_ptr->hide_count == hide_count_before_stale_begin,
          "stale BeginSession cannot hide the live disclosure");
  disclosure.Hide();

  macos::MacosDisclosureEventSink callback_after_destruction;
  {
    auto dying_backend = std::make_unique<FakeDisclosureBackend>();
    FakeDisclosureBackend *dying_backend_ptr = dying_backend.get();
    macos::MacosLocalDisclosureAdapter dying(
        std::move(dying_backend),
        [&stopped_generations](std::uint64_t generation) {
          stopped_generations.push_back(generation);
        });
    Require(dying.BeginSession(100) && dying.Show(1, 0),
            "destruction fixture becomes visible");
    callback_after_destruction = dying_backend_ptr->event_sink;
  }
  callback_after_destruction(macos::MacosDisclosureEvent::kLocalStop, 100);
  Require(stopped_generations.size() == 6,
          "late AppKit callback cannot outlive the adapter");

  std::cout << "macOS local disclosure adapter tests passed\n";
  return 0;
}
