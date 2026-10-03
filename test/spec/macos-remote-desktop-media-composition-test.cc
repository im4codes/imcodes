// Production counterfactuals for the worker's media composition.
//
// The defect these guard: the worker used to build
// MacosRemoteDesktopProductionConfiguration with only worker_generation +
// transport, while CreateWithPinnedLibwebrtcSender returns nullptr unless
// pinned_libwebrtc_sender_backend is set. Every ordinary launch therefore
// failed composition, and the failure was invisible because no test asserted
// that a real sender is supplied.
//
// The binder is the production sender. These cases prove it is fail-closed
// before upstream produces an encoder callback, and a straight delegate after.

#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "../../native/remote-desktop-common/input_ledger.h"
#include "../../native/remote-desktop-common/platform_interfaces.h"
#include "h264_sender_bridge.h"
#include "macos_media_sender_binder.h"

namespace rd = imcodes::remote_desktop;
namespace macos = imcodes::remote_desktop::macos;

namespace {

int g_failures = 0;

void Check(bool condition, const char* label) {
  if (condition) return;
  std::fprintf(stderr, "FAIL %s\n", label);
  ++g_failures;
}

// Stands in for the sender CreatePinnedLibwebrtcH264Sender returns once
// upstream hands over its EncodedImageCallback.
class RecordingSender final : public macos::H264SenderBackend {
 public:
  explicit RecordingSender(bool accept_start = true)
      : accept_start_(accept_start) {}

  bool Start(const macos::H264SenderConfiguration& configuration) override {
    ++start_calls;
    started_generation = configuration.generation;
    return accept_start_;
  }
  bool Submit(macos::H264SenderFrame frame,
              macos::H264SenderCompletionCallback completion) override {
    ++submit_calls;
    if (external_submit_calls != nullptr) ++*external_submit_calls;
    submitted_generations.push_back(frame.generation);
    if (completion) completion(macos::H264SenderCompletion::kAccepted, 1);
    return true;
  }
  void Cancel(rd::common::WorkerGeneration generation) noexcept override {
    ++cancel_calls;
    cancelled_generation = generation;
  }

  // Lets a test observe delegation after the binder has destroyed this sender.
  // Reading the sender itself then is a use-after-free, which the sanitizers
  // correctly reject.
  int* external_submit_calls = nullptr;

  int start_calls = 0;
  int submit_calls = 0;
  int cancel_calls = 0;
  rd::common::WorkerGeneration started_generation = 0;
  rd::common::WorkerGeneration cancelled_generation = 0;
  std::vector<rd::common::WorkerGeneration> submitted_generations;

 private:
  bool accept_start_;
};

macos::H264SenderConfiguration Configuration(
    rd::common::WorkerGeneration generation) {
  macos::H264SenderConfiguration configuration;
  configuration.generation = generation;
  configuration.encoded_pixels = rd::common::PixelSize{1280, 720};
  configuration.profile = macos::H264SenderProfile::kConstrainedBaseline;
  return configuration;
}

macos::H264SenderFrame Frame(rd::common::WorkerGeneration generation) {
  macos::H264SenderFrame frame;
  frame.generation = generation;
  frame.submission_id = 1;
  frame.bytes = std::vector<std::byte>(16, std::byte{0x41});
  frame.profile = macos::H264SenderProfile::kConstrainedBaseline;
  frame.keyframe = true;
  return frame;
}

// ---------------------------------------------------------------------------

void UnboundBinderRefusesFramesInsteadOfPretending() {
  macos::MacosMediaSenderBinder binder;
  Check(!binder.bound(), "starts unbound");

  // Configuring before an encoder exists is normal: the session configures at
  // Start, upstream produces the encoder only after negotiation.
  Check(binder.Start(Configuration(7)), "configure before bind is accepted");

  macos::H264SenderCompletion outcome = macos::H264SenderCompletion::kAccepted;
  bool completed = false;
  Check(binder.Submit(Frame(7),
                      [&](macos::H264SenderCompletion result, std::uint64_t) {
                        outcome = result;
                        completed = true;
                      }),
        "submit before bind is handled");
  Check(completed, "completion is always invoked");
  // The frame must be explicitly dropped, never queued: buffering for an
  // encoder that may never arrive trades a visible gap for unbounded memory
  // and a burst of stale frames at bind time.
  Check(outcome == macos::H264SenderCompletion::kDropped,
        "frame before bind is dropped, not accepted");
  Check(binder.dropped_before_bind() == 1, "drop is counted");
}

void BindReplaysTheConfigurationTheSessionAlreadySet() {
  macos::MacosMediaSenderBinder binder;
  Check(binder.Start(Configuration(7)), "configured before bind");

  auto sender = std::make_unique<RecordingSender>();
  RecordingSender* view = sender.get();
  Check(binder.Bind(std::move(sender)) != macos::kInvalidMediaSenderBinding, "bind succeeds");
  Check(binder.bound(), "reports bound");
  // Without replay the newly bound sender would never be started and would
  // reject every frame.
  Check(view->start_calls == 1, "configuration is replayed on bind");
  Check(view->started_generation == 7, "replayed generation matches");
}

void BindIsRefusedWhenTheReplayedStartFails() {
  macos::MacosMediaSenderBinder binder;
  Check(binder.Start(Configuration(7)), "configured");
  auto sender = std::make_unique<RecordingSender>(/*accept_start=*/false);
  Check(binder.Bind(std::move(sender)) == macos::kInvalidMediaSenderBinding,
        "failed replay refuses the bind");
  // A half-started sender must not be retained.
  Check(!binder.bound(), "no binding is kept after a failed replay");
}

void SecondBindIsRefused() {
  macos::MacosMediaSenderBinder binder;
  Check(binder.Bind(std::make_unique<RecordingSender>()) != macos::kInvalidMediaSenderBinding,
        "first bind");
  // Two live encoders for one session would mean two packetizers producing two
  // RTP streams for the same track.
  Check(binder.Bind(std::make_unique<RecordingSender>()) == macos::kInvalidMediaSenderBinding,
        "second bind is refused");
  Check(binder.bound(), "first binding survives the refusal");
}

void BoundBinderDelegatesEveryFrame() {
  macos::MacosMediaSenderBinder binder;
  auto sender = std::make_unique<RecordingSender>();
  RecordingSender* view = sender.get();
  const macos::MediaSenderBindingId binding = binder.Bind(std::move(sender));
  Check(binding != macos::kInvalidMediaSenderBinding, "bind");
  Check(binder.Start(Configuration(9)), "start after bind");
  Check(view->start_calls == 1, "start reaches the sender");

  bool completed = false;
  macos::H264SenderCompletion outcome = macos::H264SenderCompletion::kDropped;
  Check(binder.Submit(Frame(9),
                      [&](macos::H264SenderCompletion result, std::uint64_t) {
                        outcome = result;
                        completed = true;
                      }),
        "submit delegates");
  Check(view->submit_calls == 1, "frame reaches upstream sender");
  Check(completed && outcome == macos::H264SenderCompletion::kAccepted,
        "upstream completion is propagated");
  Check(binder.dropped_before_bind() == 0, "no drops once bound");
}

// ---------------------------------------------------------------------------
// COMPOSITION: the binder behind the bridge.
//
// Each component's own suite passed while this was broken, because neither
// runs the other: the bridge's tests use a compliant FakeSender, and the
// binder's tests call it standalone where nothing reacts to its return value.
// The defect lived exactly in the seam.
//
// The binder used to invoke `completion(kDropped)` AND return false for a
// stale generation. `H264SenderBridge::Impl::DispatchNext` answers a false
// return with `Complete(..., kFatal)`, so ONE submission produced TWO
// completions. The kDropped landed first and cleared `in_flight_`; the kFatal
// then matched nothing and was discarded as `ignored_late_callbacks`. The
// bridge stayed active for ever, never issued Cancel, and reported a terminal
// failure as ordinary backpressure.
void BinderBehindBridgeCompletesEachSubmissionExactlyOnce() {
  auto binder = std::make_unique<macos::MacosMediaSenderBinder>();
  macos::MacosMediaSenderBinder *view = binder.get();
  auto sender = std::make_unique<RecordingSender>();
  Check(view->Bind(std::move(sender)) != macos::kInvalidMediaSenderBinding,
        "bind the upstream sender");

  macos::H264SenderBridge bridge(std::move(binder));
  Check(bridge.Start(9, rd::common::PixelSize{1280, 720},
                     rd::common::H264Profile::kConstrainedBaseline),
        "bridge starts generation 9");

  // Renegotiation cancels the binder WITHOUT telling the bridge. This is the
  // real sequence: the two layers have independent lifecycles.
  view->Cancel(9);

  rd::common::H264AccessUnit unit;
  unit.bytes = std::vector<std::byte>(16, std::byte{0x41});
  unit.presentation_time_us = 1;
  unit.profile = rd::common::H264Profile::kConstrainedBaseline;
  unit.keyframe = true;
  Check(bridge.Submit(9, unit), "bridge accepts the access unit");

  const macos::H264SenderBridgeStatistics stats = bridge.Statistics();
  // THE LOAD-BEARING ASSERTION. A second completion for one submission can only
  // arrive as a late callback, so a non-zero count here means the submission
  // was completed twice and one of the two verdicts was thrown away.
  Check(stats.ignored_late_callbacks == 0,
        "one submission yields exactly one completion");
  Check(stats.dropped_backpressure_access_units == 1,
        "the stale frame is counted as a drop");
  Check(stats.terminal_failures == 0,
        "a stale generation is not a terminal failure");
  // And the bridge is still usable: tearing it down on a renegotiation would
  // end video for the session.
  Check(bridge.IsActive(), "the bridge survives a stale-generation drop");
}

// ---------------------------------------------------------------------------
// PRODUCTION SEQUENCE: Start -> Bind -> Unbind -> Bind, with NO second Start.
//
// This is what a mid-session encoder replacement actually looks like. The
// bridge calls Start once, at the session's generation. libwebrtc then tears
// its encoder down and builds another; nothing above the binder ever calls
// Start again, because from the session's point of view nothing changed.
//
// Unbind used to clear configured_/configuration_, so the replacement bound
// into an unconfigured binder and every later access unit hit the
// stale-generation branch and was dropped. The session stayed "connected", the
// bridge stayed active, statistics showed only backpressure -- and the remote
// screen simply stopped updating.
void ReplacementBindReplaysConfigurationWithoutASecondStart() {
  macos::MacosMediaSenderBinder binder;

  Check(binder.Start(Configuration(9)), "session configures generation 9");

  auto first = std::make_unique<RecordingSender>();
  RecordingSender* first_view = first.get();
  const macos::MediaSenderBindingId first_binding = binder.Bind(std::move(first));
  Check(first_binding != macos::kInvalidMediaSenderBinding, "first encoder binds");
  Check(first_view->start_calls == 1, "configuration replayed onto the first sender");

  binder.Unbind(first_binding);
  // THE PROPERTY: the configuration belongs to the generation, not the encoder.
  Check(binder.configured(), "configuration survives the encoder teardown");

  auto second = std::make_unique<RecordingSender>();
  RecordingSender* second_view = second.get();
  const macos::MediaSenderBindingId second_binding =
      binder.Bind(std::move(second));
  Check(second_binding != macos::kInvalidMediaSenderBinding, "replacement binds");
  Check(second_binding != first_binding, "each binding has its own identity");

  // Exactly once: a replay per bind, never a second one and never none.
  Check(second_view->start_calls == 1,
        "replacement is started exactly once, with no second bridge Start");

  bool completed = false;
  macos::H264SenderCompletion outcome = macos::H264SenderCompletion::kFatal;
  Check(binder.Submit(Frame(9),
                      [&](macos::H264SenderCompletion result, std::uint64_t) {
                        completed = true;
                        outcome = result;
                      }),
        "the next access unit is accepted");
  Check(second_view->submit_calls == 1,
        "the next access unit reaches upstream");
  Check(completed && outcome == macos::H264SenderCompletion::kAccepted,
        "delivered=1, dropped=0");
  Check(binder.dropped_before_bind() == 0, "nothing was dropped before bind");
}

// A dead encoder must not detach its successor.
//
// libwebrtc may construct the replacement encoder before destroying the one it
// replaces, so the old Release()/destructor can run AFTER the new bind. An
// unconditional Unbind() there detached the live sender, and because the binder
// then looked simply "not yet bound" -- a normal state during negotiation --
// every later frame was dropped with no error recorded anywhere.
void StaleEncoderTeardownCannotDetachItsReplacement() {
  macos::MacosMediaSenderBinder binder;
  Check(binder.Start(Configuration(9)), "configure generation 9");

  auto first = std::make_unique<RecordingSender>();
  const macos::MediaSenderBindingId stale = binder.Bind(std::move(first));
  Check(stale != macos::kInvalidMediaSenderBinding, "first encoder binds");
  binder.Unbind(stale);

  auto second = std::make_unique<RecordingSender>();
  RecordingSender* live = second.get();
  const macos::MediaSenderBindingId current = binder.Bind(std::move(second));
  Check(current != macos::kInvalidMediaSenderBinding, "replacement binds");

  // The replaced encoder's teardown arrives LATE, carrying its own dead token.
  binder.Unbind(stale);

  Check(binder.bound(), "a stale teardown must not detach the live sender");
  Check(binder.binding() == current, "the live binding is untouched");

  bool completed = false;
  macos::H264SenderCompletion outcome = macos::H264SenderCompletion::kFatal;
  Check(binder.Submit(Frame(9),
                      [&](macos::H264SenderCompletion result, std::uint64_t) {
                        completed = true;
                        outcome = result;
                      }),
        "media continues after the stale teardown");
  Check(live->submit_calls == 1, "the frame still reaches the live sender");
  Check(completed && outcome == macos::H264SenderCompletion::kAccepted,
        "delivered=1, dropped=0 after a stale teardown");
  Check(binder.dropped_before_bind() == 0,
        "a stale teardown produces no silent drops");
}

// Cancel -- and only Cancel -- revokes the retained configuration.
void OnlyCancelRevokesTheRetainedConfiguration() {
  macos::MacosMediaSenderBinder binder;
  Check(binder.Start(Configuration(9)), "configure generation 9");
  auto sender = std::make_unique<RecordingSender>();
  const macos::MediaSenderBindingId binding = binder.Bind(std::move(sender));
  Check(binding != macos::kInvalidMediaSenderBinding, "bind");

  binder.Unbind(binding);
  Check(binder.configured(), "Unbind retains the configuration");

  // A different generation must not revoke it.
  binder.Cancel(8);
  Check(binder.configured(), "another generation's Cancel changes nothing");

  binder.Cancel(9);
  Check(!binder.configured(), "Cancel(9) revokes it");

  auto late = std::make_unique<RecordingSender>();
  RecordingSender* late_view = late.get();
  Check(binder.Bind(std::move(late)) != macos::kInvalidMediaSenderBinding,
        "a post-Cancel bind still succeeds");
  Check(late_view->start_calls == 0,
        "with no retained configuration there is nothing to replay");
}

void StaleGenerationIsRefusedEvenWhenBound() {
  macos::MacosMediaSenderBinder binder;
  auto sender = std::make_unique<RecordingSender>();
  RecordingSender* view = sender.get();
  const macos::MediaSenderBindingId binding = binder.Bind(std::move(sender));
  Check(binding != macos::kInvalidMediaSenderBinding, "bind");
  Check(binder.Start(Configuration(9)), "start");

  // The return value is TRUE, and that is the contract, not a concession.
  //
  // This assertion used to read `!binder.Submit(...)` together with
  // `Check(completed, ...)`, which codified a violation of the
  // `H264SenderBackend` contract in h264_sender_bridge.h: "a false return
  // transfers no ownership and must not invoke completion". Doing both
  // completed one submission twice, and `H264SenderBridge` silently discarded
  // the second -- the terminal one. The test did not merely miss that; it
  // locked it in, which is why the bug survived every run of this suite.
  bool completed = false;
  macos::H264SenderCompletion outcome = macos::H264SenderCompletion::kFatal;
  Check(binder.Submit(Frame(8),
                      [&](macos::H264SenderCompletion result, std::uint64_t) {
                        completed = true;
                        outcome = result;
                      }),
        "a stale generation is consumed, not refused");
  Check(completed, "the stale frame is completed exactly once");
  Check(outcome == macos::H264SenderCompletion::kDropped,
        "a stale generation is a drop, never a terminal failure");
  Check(view->submit_calls == 0, "stale frame never reaches upstream");
}

void UnbindReturnsToFailClosedAndRequiresReconfiguration() {
  macos::MacosMediaSenderBinder binder;
  auto sender = std::make_unique<RecordingSender>();
  RecordingSender* view = sender.get();
  int submits = 0;
  view->external_submit_calls = &submits;
  const macos::MediaSenderBindingId binding = binder.Bind(std::move(sender));
  Check(binding != macos::kInvalidMediaSenderBinding, "bind");
  Check(binder.Start(Configuration(9)), "start");
  Check(binder.Submit(Frame(9), {}), "frame delegates while bound");
  Check(submits == 1, "delegated once");

  // Upstream releasing the encoder must not leave a submission path open to a
  // dead callback.
  binder.Unbind(binding);
  Check(!binder.bound(), "unbound after release");

  macos::H264SenderCompletion outcome = macos::H264SenderCompletion::kAccepted;
  Check(binder.Submit(Frame(9), [&](macos::H264SenderCompletion result,
                                    std::uint64_t) { outcome = result; }),
        "submit after unbind is handled");
  Check(outcome == macos::H264SenderCompletion::kDropped,
        "frame after unbind is dropped");
  // Counted externally: `view` was destroyed by Unbind().
  Check(submits == 1, "no frame reaches the released sender");

  // A rebind REPLAYS the retained configuration. It belongs to the session's
  // generation, not to the encoder instance that went away: nothing above the
  // binder issues a second Start when libwebrtc swaps encoders, so a
  // replacement that bound unconfigured would drop every subsequent frame while
  // the session still reported healthy.
  //
  // This assertion previously read `start_calls == 0` with a comment asserting
  // the configuration was stale. That belief was the defect -- the test locked
  // in a silent media outage.
  auto replacement = std::make_unique<RecordingSender>();
  RecordingSender* replacement_view = replacement.get();
  Check(binder.Bind(std::move(replacement)) != macos::kInvalidMediaSenderBinding,
        "rebind succeeds");
  Check(replacement_view->start_calls == 1,
        "rebind replays the retained configuration exactly once");
}

void CancelReachesTheBoundSender() {
  macos::MacosMediaSenderBinder binder;
  auto sender = std::make_unique<RecordingSender>();
  RecordingSender* view = sender.get();
  const macos::MediaSenderBindingId binding = binder.Bind(std::move(sender));
  Check(binding != macos::kInvalidMediaSenderBinding, "bind");
  Check(binder.Start(Configuration(9)), "start");
  binder.Cancel(9);
  Check(view->cancel_calls == 1, "cancel delegates");
  Check(view->cancelled_generation == 9, "cancel carries the generation");

  // Cancelling the active generation clears the configuration, so a later
  // frame for it must not be treated as configured. It is CONSUMED and
  // dropped, not refused: the contract forbids invoking completion on a false
  // return, and a post-cancel frame is ordinary, not a sender failure.
  macos::H264SenderCompletion outcome = macos::H264SenderCompletion::kAccepted;
  Check(binder.Submit(Frame(9), [&](macos::H264SenderCompletion result,
                                    std::uint64_t) { outcome = result; }),
        "frame after cancel is consumed, not refused");
  Check(outcome == macos::H264SenderCompletion::kDropped,
        "refused frame is reported dropped");
}

void InvalidConfigurationIsRefused() {
  macos::MacosMediaSenderBinder binder;
  macos::H264SenderConfiguration invalid;  // generation 0, zero pixels
  Check(!binder.Start(invalid), "invalid configuration is refused");
  Check(binder.Bind(nullptr) == macos::kInvalidMediaSenderBinding,
        "null sender is refused");
}

// ---------------------------------------------------------------------------
// Cleanup: release-all must actually release held input.
// ---------------------------------------------------------------------------

// Records exactly what the OS was told, so a "success" that emitted nothing is
// distinguishable from a real release.
class RecordingInputAdapter final : public rd::common::InputAdapter {
 public:
  rd::common::ReadinessState ProbeReadiness() override {
    return rd::common::ReadinessState::kReady;
  }
  bool MovePointer(const rd::common::LogicalPoint&) override { return true; }
  bool EmitKey(std::string_view key, bool pressed) override {
    transitions.push_back(std::string(pressed ? "+" : "-") + std::string(key));
    return true;
  }
  bool EmitButton(std::string_view button, bool pressed) override {
    transitions.push_back(std::string(pressed ? "+" : "-") +
                          std::string(button));
    return true;
  }
  bool EmitWheel(double, double) override { return true; }
  bool EmitText(std::string_view) override { return true; }
  void ReleaseAllEmittedState() noexcept override { ++release_all_calls; }

  std::vector<std::string> transitions;
  int release_all_calls = 0;
};

rd::common::InputStamp Stamp(const char* controller, std::uint64_t sequence) {
  rd::common::InputStamp stamp;
  stamp.controller_id = controller;
  stamp.epoch = 1;
  stamp.sequence = sequence;
  stamp.topology_revision = 1;
  return stamp;
}

void ReleaseControllerWithEmptyIdReleasesNothing() {
  RecordingInputAdapter adapter;
  rd::common::InputLedger ledger(adapter);
  Check(ledger.ApplyKey(Stamp("controller-a", 1), 1, "KeyA", true) ==
            rd::common::InputResult::kApplied,
        "controller holds a key down");
  Check(ledger.ApplyButton(Stamp("controller-a", 2), 1, "Left", true) ==
            rd::common::InputResult::kApplied,
        "controller holds a button down");
  Check(ledger.controller_count() == 1, "one controller tracked");
  adapter.transitions.clear();

  // This is the defect: the empty id is not in the controller map, so the
  // ledger reports success having emitted nothing. A cleanup command wired to
  // this would return a generation-stamped OK while the key and button stay
  // down on the user's machine.
  Check(ledger.ReleaseController(std::string_view{}) ==
            rd::common::InputResult::kApplied,
        "empty id reports success");
  Check(adapter.transitions.empty(), "empty id emits no release");
  Check(adapter.release_all_calls == 0, "empty id never reaches the backend");
  Check(ledger.controller_count() == 1, "controller is still held");

  // The correct seam reaches the backend unconditionally.
  ledger.ReleaseAll();
  Check(adapter.release_all_calls == 1, "ReleaseAll reaches the input backend");
  Check(ledger.controller_count() == 0, "all controllers dropped");
}

void ReleaseAllClearsHeldStateForNamedControllers() {
  RecordingInputAdapter adapter;
  rd::common::InputLedger ledger(adapter);
  Check(ledger.ApplyKey(Stamp("controller-a", 1), 1, "KeyA", true) ==
            rd::common::InputResult::kApplied,
        "a holds a key");
  Check(ledger.ApplyKey(Stamp("controller-b", 1), 1, "KeyB", true) ==
            rd::common::InputResult::kApplied,
        "b holds a key");
  Check(ledger.controller_count() == 2, "two controllers tracked");

  ledger.ReleaseAll();
  Check(adapter.release_all_calls == 1, "backend release-all invoked once");
  Check(ledger.controller_count() == 0, "both controllers dropped");

  // Idempotent: repeating it must still reach the backend, because the backend
  // is the final authority on emitted OS state.
  ledger.ReleaseAll();
  Check(adapter.release_all_calls == 2, "release-all stays idempotent");
}

// ---------------------------------------------------------------------------
// Concurrency: an in-flight Submit must survive a concurrent Unbind.
// ---------------------------------------------------------------------------

// Blocks inside Submit/Cancel until released, so the race is deterministic
// rather than timing-dependent: the test can prove Unbind ran strictly while
// the call was inside upstream.
class BlockingSender final : public macos::H264SenderBackend {
 public:
  explicit BlockingSender(std::atomic<int>* destroyed)
      : destroyed_(destroyed) {}
  ~BlockingSender() override {
    if (destroyed_ != nullptr) destroyed_->fetch_add(1);
  }

  bool Start(const macos::H264SenderConfiguration&) override { return true; }

  bool Submit(macos::H264SenderFrame frame,
              macos::H264SenderCompletionCallback completion) override {
    {
      std::unique_lock lock(mutex_);
      entered_ = true;
      entered_cv_.notify_all();
      release_cv_.wait(lock, [&] { return released_; });
    }
    // Touch members after the wait: if the object had been freed underneath
    // this call, ASan reports a use-after-free right here.
    ++submit_calls;
    last_generation = frame.generation;
    // Mirrored outside the object: once this call returns it drops the last
    // reference and the sender is destroyed, so the test cannot read members
    // afterwards without a use-after-free.
    if (external_generation != nullptr) {
      external_generation->store(static_cast<int>(frame.generation));
    }
    if (completion) completion(macos::H264SenderCompletion::kAccepted, 1);
    return true;
  }

  void Cancel(rd::common::WorkerGeneration generation) noexcept override {
    ++cancel_calls;
    last_cancelled = generation;
    if (external_cancelled != nullptr) {
      external_cancelled->store(static_cast<int>(generation));
    }
  }

  std::atomic<int>* external_generation = nullptr;
  std::atomic<int>* external_cancelled = nullptr;

  void WaitUntilEntered() {
    std::unique_lock lock(mutex_);
    entered_cv_.wait(lock, [&] { return entered_; });
  }
  void Release() {
    std::lock_guard lock(mutex_);
    released_ = true;
    release_cv_.notify_all();
  }

  int submit_calls = 0;
  int cancel_calls = 0;
  rd::common::WorkerGeneration last_generation = 0;
  rd::common::WorkerGeneration last_cancelled = 0;

 private:
  std::atomic<int>* destroyed_;
  std::mutex mutex_;
  std::condition_variable entered_cv_;
  std::condition_variable release_cv_;
  bool entered_ = false;
  bool released_ = false;
};

void InFlightSubmitSurvivesConcurrentUnbind() {
  std::atomic<int> destroyed{0};
  macos::MacosMediaSenderBinder binder;
  std::atomic<int> delivered_generation{0};
  auto sender = std::make_unique<BlockingSender>(&destroyed);
  BlockingSender* view = sender.get();
  view->external_generation = &delivered_generation;
  const macos::MediaSenderBindingId binding = binder.Bind(std::move(sender));
  Check(binding != macos::kInvalidMediaSenderBinding, "bind");
  Check(binder.Start(Configuration(9)), "start");

  bool completed = false;
  macos::H264SenderCompletion outcome = macos::H264SenderCompletion::kDropped;
  std::thread submitter([&] {
    completed =
        binder.Submit(Frame(9), [&](macos::H264SenderCompletion result,
                                    std::uint64_t) { outcome = result; });
  });

  // Unbind strictly while the submit is parked inside upstream. Before the
  // shared_ptr fix this reset the unique_ptr and freed the sender underneath
  // the blocked call.
  view->WaitUntilEntered();
  binder.Unbind(binding);
  Check(!binder.bound(), "unbind takes effect immediately");
  // The in-flight call holds its own reference, so nothing may be destroyed
  // yet.
  Check(destroyed.load() == 0, "sender is not destroyed under an active call");

  view->Release();
  submitter.join();
  Check(completed, "in-flight submit completed");
  Check(outcome == macos::H264SenderCompletion::kAccepted,
        "in-flight submit was delivered, not dropped");
  // Read from the mirror: `view` is legitimately destroyed by now.
  Check(delivered_generation.load() == 9, "correct generation delivered");
  // The last reference goes away with the completed call.
  Check(destroyed.load() == 1, "sender destroyed exactly once, after the call");

  // New submissions after Unbind take the fail-closed path.
  macos::H264SenderCompletion after = macos::H264SenderCompletion::kAccepted;
  Check(binder.Submit(Frame(9), [&](macos::H264SenderCompletion result,
                                    std::uint64_t) { after = result; }),
        "post-unbind submit handled");
  Check(after == macos::H264SenderCompletion::kDropped,
        "post-unbind submit is dropped");
}

void InFlightSubmitSurvivesConcurrentCancel() {
  std::atomic<int> destroyed{0};
  macos::MacosMediaSenderBinder binder;
  std::atomic<int> cancelled{0};
  auto sender = std::make_unique<BlockingSender>(&destroyed);
  BlockingSender* view = sender.get();
  view->external_cancelled = &cancelled;
  const macos::MediaSenderBindingId binding = binder.Bind(std::move(sender));
  Check(binding != macos::kInvalidMediaSenderBinding, "bind");
  Check(binder.Start(Configuration(11)), "start");

  std::thread submitter([&] { (void)binder.Submit(Frame(11), {}); });
  view->WaitUntilEntered();

  // Cancel from another thread while the submit is parked. It must not block
  // (no lock is held across upstream) and must not free the sender.
  binder.Cancel(11);
  Check(destroyed.load() == 0, "cancel does not destroy an in-use sender");

  view->Release();
  submitter.join();
  Check(cancelled.load() == 11,
        "cancel reached the sender with its generation");

  // Cancel cleared the configuration, so the next frame for that generation is
  // dropped rather than delivered -- and consumed, not refused, so the bridge
  // above does not add a second (terminal) completion for the same submission.
  macos::H264SenderCompletion outcome = macos::H264SenderCompletion::kAccepted;
  Check(binder.Submit(Frame(11), [&](macos::H264SenderCompletion result,
                                     std::uint64_t) { outcome = result; }),
        "frame after cancel is consumed, not refused");
  Check(outcome == macos::H264SenderCompletion::kDropped,
        "refused frame reports dropped");
}

}  // namespace

int main() {
  UnboundBinderRefusesFramesInsteadOfPretending();
  BindReplaysTheConfigurationTheSessionAlreadySet();
  BindIsRefusedWhenTheReplayedStartFails();
  SecondBindIsRefused();
  BoundBinderDelegatesEveryFrame();
  StaleGenerationIsRefusedEvenWhenBound();
  BinderBehindBridgeCompletesEachSubmissionExactlyOnce();
  ReplacementBindReplaysConfigurationWithoutASecondStart();
  StaleEncoderTeardownCannotDetachItsReplacement();
  OnlyCancelRevokesTheRetainedConfiguration();
  UnbindReturnsToFailClosedAndRequiresReconfiguration();
  CancelReachesTheBoundSender();
  InvalidConfigurationIsRefused();
  ReleaseControllerWithEmptyIdReleasesNothing();
  ReleaseAllClearsHeldStateForNamedControllers();
  InFlightSubmitSurvivesConcurrentUnbind();
  InFlightSubmitSurvivesConcurrentCancel();

  if (g_failures != 0) {
    std::fprintf(stderr, "%d media composition failure(s)\n", g_failures);
    return EXIT_FAILURE;
  }
  std::printf("macos media sender binder counterfactual ok\n");
  return EXIT_SUCCESS;
}
