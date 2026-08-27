#include "macos_media_sender_binder.h"

#include <utility>

namespace imcodes::remote_desktop::macos {

MediaSenderBindingId MacosMediaSenderBinder::Bind(
    std::unique_ptr<H264SenderBackend> sender) {
  if (sender == nullptr) return kInvalidMediaSenderBinding;
  std::lock_guard lock(mutex_);
  // Two live encoders for one session would mean two packetizers producing two
  // RTP streams for the same track. Refuse rather than silently replace.
  if (sender_ != nullptr) return kInvalidMediaSenderBinding;
  sender_ = std::shared_ptr<H264SenderBackend>(std::move(sender));
  if (configured_) {
    // The session configured us while no encoder existed -- either before the
    // first negotiation, or between a teardown and its replacement. Replay it
    // exactly once so the newly bound sender starts in the session's current
    // state; nothing upstream issues a second Start.
    if (!sender_->Start(configuration_)) {
      // Half-started is worse than unbound: leave no sender rather than one
      // upstream refused. The configuration survives for the next attempt --
      // it belongs to the generation, not to this failed encoder.
      sender_.reset();
      return kInvalidMediaSenderBinding;
    }
  }
  binding_ = next_binding_++;
  return binding_;
}

void MacosMediaSenderBinder::Unbind(MediaSenderBindingId binding) noexcept {
  std::lock_guard lock(mutex_);
  // A stale encoder tearing itself down must not detach its successor. Without
  // this, libwebrtc constructing the replacement before destroying the old
  // encoder silently unbound the live sender and every later frame was dropped
  // as "not yet bound" -- a state indistinguishable from ordinary negotiation.
  if (binding == kInvalidMediaSenderBinding || binding != binding_) return;
  sender_.reset();
  binding_ = kInvalidMediaSenderBinding;
  // configuration_ deliberately survives; only Cancel(generation) revokes it.
}

bool MacosMediaSenderBinder::bound() const noexcept {
  std::lock_guard lock(mutex_);
  return sender_ != nullptr;
}

MediaSenderBindingId MacosMediaSenderBinder::binding() const noexcept {
  std::lock_guard lock(mutex_);
  return binding_;
}

bool MacosMediaSenderBinder::configured() const noexcept {
  std::lock_guard lock(mutex_);
  return configured_;
}

std::uint64_t MacosMediaSenderBinder::dropped_before_bind() const noexcept {
  std::lock_guard lock(mutex_);
  return dropped_before_bind_;
}

bool MacosMediaSenderBinder::Start(
    const H264SenderConfiguration& configuration) {
  if (!configuration.IsValid()) return false;
  std::lock_guard lock(mutex_);
  configuration_ = configuration;
  configured_ = true;
  if (sender_ == nullptr) {
    // Not an error: the session legitimately configures before negotiation
    // produces an encoder. The configuration is retained for Bind() to replay.
    return true;
  }
  return sender_->Start(configuration);
}

bool MacosMediaSenderBinder::Submit(H264SenderFrame frame,
                                    H264SenderCompletionCallback completion) {
  std::unique_lock lock(mutex_);
  if (sender_ == nullptr) {
    ++dropped_before_bind_;
    lock.unlock();
    // Explicitly dropped, never queued: buffering access units for an encoder
    // that may never arrive would trade a visible gap for unbounded memory and
    // a burst of stale frames at bind time.
    if (completion) completion(H264SenderCompletion::kDropped, 0);
    return true;
  }
  if (!configured_ || frame.generation != configuration_.generation) {
    lock.unlock();
    // Reported as a DROP that was consumed, exactly like the unbound branch
    // above -- not as a refusal.
    //
    // `H264SenderBackend` (h264_sender_bridge.h) states that a false return
    // transfers no ownership and must NOT invoke completion. Doing both meant
    // one submission was completed twice: this `kDropped`, then the bridge's
    // `Complete(..., kFatal)` on the false return. The kDropped arrives first,
    // clears `in_flight_`, and the kFatal that follows no longer matches, so
    // `H264SenderBridge::Impl::Complete` discards it as `ignored_late_callbacks`.
    // The bridge then stays `active_` forever, never issues `Cancel`, and
    // reports a terminal failure as recoverable backpressure.
    //
    // `true` rather than suppressing the completion, because a stale generation
    // is an ordinary consequence of renegotiation, not a failure of the sender.
    // Returning false would have the bridge tear itself down on every
    // generation change.
    if (completion) completion(H264SenderCompletion::kDropped, 0);
    return true;
  }
  // Copy the reference under the lock, then release it before calling
  // upstream. The copy is what makes this safe: a concurrent Unbind() may reset
  // the member the instant the lock drops, but it cannot destroy the sender
  // while this call still holds a reference to it.
  const std::shared_ptr<H264SenderBackend> sender = sender_;
  lock.unlock();
  return sender->Submit(std::move(frame), std::move(completion));
}

void MacosMediaSenderBinder::Cancel(
    common::WorkerGeneration generation) noexcept {
  std::unique_lock lock(mutex_);
  // Cancel is the ONLY revocation of the retained configuration: it is scoped
  // to a generation, which is what the configuration actually belongs to.
  if (configured_ && configuration_.generation == generation) {
    configured_ = false;
    configuration_ = H264SenderConfiguration{};
  }
  const std::shared_ptr<H264SenderBackend> sender = sender_;
  lock.unlock();
  if (sender != nullptr) sender->Cancel(generation);
}

}  // namespace imcodes::remote_desktop::macos
