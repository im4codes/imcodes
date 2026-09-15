#include "h264_sender_bridge.h"

#include <algorithm>
#include <condition_variable>
#include <deque>
#include <limits>
#include <mutex>
#include <utility>

namespace imcodes::remote_desktop::macos {
namespace {

constexpr std::uint32_t kMaximumPendingAccessUnits = 16;
constexpr std::size_t kMaximumPendingBytes = 256U * 1024U * 1024U;

std::optional<H264SenderProfile> MapProfile(common::H264Profile profile) {
  switch (profile) {
  case common::H264Profile::kConstrainedBaseline:
    return H264SenderProfile::kConstrainedBaseline;
  case common::H264Profile::kMain:
    return H264SenderProfile::kMain;
  case common::H264Profile::kHigh:
    return H264SenderProfile::kHigh;
  }
  return std::nullopt;
}

std::uint32_t ToRtpTimestamp90Khz(std::int64_t presentation_time_us) {
  const auto timestamp = static_cast<std::uint64_t>(presentation_time_us);
  const std::uint64_t whole_milliseconds = timestamp / 1'000U;
  const std::uint64_t remaining_microseconds = timestamp % 1'000U;
  return static_cast<std::uint32_t>(whole_milliseconds * 90U +
                                    remaining_microseconds * 90U / 1'000U);
}

} // namespace

bool H264SenderConfiguration::IsValid() const noexcept {
  if (generation == 0 || !encoded_pixels.IsValid()) {
    return false;
  }
  switch (profile) {
  case H264SenderProfile::kConstrainedBaseline:
  case H264SenderProfile::kMain:
  case H264SenderProfile::kHigh:
    return true;
  }
  return false;
}

bool H264SenderBridgeLimits::IsValid() const noexcept {
  return max_pending_access_units > 0 &&
         max_pending_access_units <= kMaximumPendingAccessUnits &&
         max_access_unit_bytes > 0 &&
         max_access_unit_bytes <= max_pending_bytes &&
         max_pending_bytes <= kMaximumPendingBytes;
}

class H264SenderBridge::Impl {
public:
  struct CallbackGate {
    std::mutex mutex;
    std::condition_variable idle;
    Impl *owner = nullptr;
    std::uint32_t active_callbacks = 0;
  };

  Impl(std::unique_ptr<H264SenderBackend> backend,
       H264SenderBridgeLimits limits)
      : backend_(std::move(backend)), limits_(limits) {
    callback_gate_->owner = this;
  }

  ~Impl() {
    Stop();
    std::unique_lock lock(callback_gate_->mutex);
    callback_gate_->owner = nullptr;
    callback_gate_->idle.wait(
        lock, [this] { return callback_gate_->active_callbacks == 0; });
  }

  bool Start(common::WorkerGeneration generation,
             common::PixelSize encoded_pixels, common::H264Profile profile) {
    const std::optional<H264SenderProfile> mapped_profile = MapProfile(profile);
    const H264SenderConfiguration configuration{
        .generation = generation,
        .encoded_pixels = encoded_pixels,
        .profile =
            mapped_profile.value_or(H264SenderProfile::kConstrainedBaseline),
    };
    if (backend_ == nullptr || !limits_.IsValid() || generation == 0 ||
        !mapped_profile.has_value() || !configuration.IsValid()) {
      return false;
    }

    common::WorkerGeneration canceled_generation = 0;
    {
      std::lock_guard lock(mutex_);
      if (generation <= last_started_generation_) {
        return false;
      }
      if (active_) {
        canceled_generation = configuration_.generation;
        ResetPendingLocked();
      }
      active_ = false;
      configuration_ = {};
      last_presentation_time_us_.reset();
    }
    if (canceled_generation != 0) {
      backend_->Cancel(canceled_generation);
    }
    if (!backend_->Start(configuration)) {
      return false;
    }

    std::lock_guard lock(mutex_);
    active_ = true;
    configuration_ = configuration;
    last_started_generation_ = generation;
    last_presentation_time_us_.reset();
    return true;
  }

  bool Submit(common::WorkerGeneration generation,
              common::H264AccessUnit access_unit) {
    H264SenderFrame pending;
    bool should_dispatch = false;
    {
      std::lock_guard lock(mutex_);
      if (!active_ || generation != configuration_.generation) {
        ++statistics_.rejected_stale_generation_access_units;
        return false;
      }
      const std::optional<H264SenderProfile> mapped_profile =
          MapProfile(access_unit.profile);
      if (!access_unit.IsValid() || !mapped_profile.has_value() ||
          *mapped_profile != configuration_.profile ||
          access_unit.bytes.size() > limits_.max_access_unit_bytes ||
          (last_presentation_time_us_.has_value() &&
           access_unit.presentation_time_us <= *last_presentation_time_us_)) {
        ++statistics_.rejected_invalid_access_units;
        return false;
      }

      pending = H264SenderFrame{
          .generation = generation,
          .submission_id = next_submission_id_++,
          .bytes = std::move(access_unit.bytes),
          .presentation_time_us = access_unit.presentation_time_us,
          .capture_time_ms = access_unit.presentation_time_us / 1'000,
          .rtp_timestamp_90khz =
              ToRtpTimestamp90Khz(access_unit.presentation_time_us),
          .profile = *mapped_profile,
          .keyframe = access_unit.keyframe,
      };

      MakeRoomLocked(pending.bytes.size());
      if (PendingCountLocked() >= limits_.max_pending_access_units ||
          pending_bytes_ > limits_.max_pending_bytes - pending.bytes.size()) {
        ++statistics_.dropped_backpressure_access_units;
        return false;
      }
      last_presentation_time_us_ = pending.presentation_time_us;
      pending_bytes_ += pending.bytes.size();
      queue_.push_back(std::move(pending));
      ++statistics_.accepted_access_units;
      UpdatePendingStatisticsLocked();
      should_dispatch = !in_flight_.has_value();
    }
    if (should_dispatch) {
      DispatchNext();
    }
    return true;
  }

  void Stop() noexcept {
    common::WorkerGeneration canceled_generation = 0;
    {
      std::lock_guard lock(mutex_);
      if (!active_ && !in_flight_.has_value() && queue_.empty()) {
        return;
      }
      canceled_generation = configuration_.generation;
      active_ = false;
      configuration_ = {};
      last_presentation_time_us_.reset();
      ResetPendingLocked();
    }
    if (backend_ != nullptr && canceled_generation != 0) {
      backend_->Cancel(canceled_generation);
    }
  }

  bool IsActive() const noexcept {
    std::lock_guard lock(mutex_);
    return active_;
  }

  std::optional<common::WorkerGeneration> ActiveGeneration() const noexcept {
    std::lock_guard lock(mutex_);
    if (!active_) {
      return std::nullopt;
    }
    return configuration_.generation;
  }

  H264SenderBridgeStatistics Statistics() const noexcept {
    std::lock_guard lock(mutex_);
    return statistics_;
  }

private:
  void MakeRoomLocked(std::size_t incoming_bytes) {
    while (!queue_.empty() &&
           (PendingCountLocked() >= limits_.max_pending_access_units ||
            pending_bytes_ > limits_.max_pending_bytes - incoming_bytes)) {
      const auto delta = std::find_if(
          queue_.begin(), queue_.end(),
          [](const H264SenderFrame &frame) { return !frame.keyframe; });
      if (delta == queue_.end()) {
        return;
      }
      pending_bytes_ -= delta->bytes.size();
      queue_.erase(delta);
      ++statistics_.dropped_backpressure_access_units;
      UpdatePendingStatisticsLocked();
    }
  }

  std::uint32_t PendingCountLocked() const {
    return static_cast<std::uint32_t>(queue_.size()) +
           (in_flight_.has_value() ? 1U : 0U);
  }

  void UpdatePendingStatisticsLocked() {
    statistics_.pending_access_units = PendingCountLocked();
    statistics_.pending_bytes = pending_bytes_;
  }

  void ResetPendingLocked() {
    queue_.clear();
    in_flight_.reset();
    pending_bytes_ = 0;
    UpdatePendingStatisticsLocked();
  }

  void DispatchNext() {
    H264SenderFrame frame;
    {
      std::lock_guard lock(mutex_);
      if (!active_ || in_flight_.has_value() || queue_.empty()) {
        return;
      }
      frame = std::move(queue_.front());
      queue_.pop_front();
      in_flight_ =
          InFlight{frame.generation, frame.submission_id, frame.bytes.size()};
      statistics_.submitted_payload_bytes += frame.bytes.size();
      UpdatePendingStatisticsLocked();
    }

    const common::WorkerGeneration generation = frame.generation;
    const std::uint64_t submission_id = frame.submission_id;
    std::weak_ptr<CallbackGate> weak_gate = callback_gate_;
    const bool submitted = backend_->Submit(
        std::move(frame),
        [weak_gate, generation, submission_id](H264SenderCompletion completion,
                                               std::size_t copied_bytes) {
          const std::shared_ptr<CallbackGate> gate = weak_gate.lock();
          if (gate == nullptr) {
            return;
          }
          Impl *owner = nullptr;
          {
            std::lock_guard lock(gate->mutex);
            if (gate->owner == nullptr) {
              return;
            }
            owner = gate->owner;
            ++gate->active_callbacks;
          }
          owner->Complete(generation, submission_id, completion, copied_bytes);
          {
            std::lock_guard lock(gate->mutex);
            --gate->active_callbacks;
            if (gate->active_callbacks == 0) {
              gate->idle.notify_all();
            }
          }
        });
    if (!submitted) {
      Complete(generation, submission_id, H264SenderCompletion::kFatal, 0);
    }
  }

  void Complete(common::WorkerGeneration generation,
                std::uint64_t submission_id, H264SenderCompletion completion,
                std::size_t copied_bytes) {
    bool dispatch_next = false;
    bool cancel_generation = false;
    {
      std::lock_guard lock(mutex_);
      if (!active_ || !in_flight_.has_value() ||
          in_flight_->generation != generation ||
          in_flight_->submission_id != submission_id ||
          configuration_.generation != generation) {
        ++statistics_.ignored_late_callbacks;
        return;
      }
      pending_bytes_ -= in_flight_->bytes;
      in_flight_.reset();
      statistics_.webrtc_owned_copy_bytes += copied_bytes;
      switch (completion) {
      case H264SenderCompletion::kAccepted:
        ++statistics_.delivered_access_units;
        dispatch_next = !queue_.empty();
        break;
      case H264SenderCompletion::kDropped:
        ++statistics_.dropped_backpressure_access_units;
        dispatch_next = !queue_.empty();
        break;
      case H264SenderCompletion::kFatal:
        ++statistics_.terminal_failures;
        active_ = false;
        configuration_ = {};
        last_presentation_time_us_.reset();
        queue_.clear();
        pending_bytes_ = 0;
        cancel_generation = true;
        break;
      }
      UpdatePendingStatisticsLocked();
    }
    if (cancel_generation) {
      backend_->Cancel(generation);
    } else if (dispatch_next) {
      DispatchNext();
    }
  }

  struct InFlight {
    common::WorkerGeneration generation;
    std::uint64_t submission_id;
    std::size_t bytes;
  };

  std::unique_ptr<H264SenderBackend> backend_;
  H264SenderBridgeLimits limits_;
  std::shared_ptr<CallbackGate> callback_gate_ =
      std::make_shared<CallbackGate>();
  mutable std::mutex mutex_;
  bool active_ = false;
  H264SenderConfiguration configuration_;
  common::WorkerGeneration last_started_generation_ = 0;
  std::optional<std::int64_t> last_presentation_time_us_;
  std::uint64_t next_submission_id_ = 1;
  std::deque<H264SenderFrame> queue_;
  std::optional<InFlight> in_flight_;
  std::size_t pending_bytes_ = 0;
  H264SenderBridgeStatistics statistics_;
};

H264SenderBridge::H264SenderBridge(std::unique_ptr<H264SenderBackend> backend,
                                   H264SenderBridgeLimits limits)
    : impl_(std::make_unique<Impl>(std::move(backend), limits)) {}

H264SenderBridge::~H264SenderBridge() = default;

bool H264SenderBridge::Start(common::WorkerGeneration generation,
                             common::PixelSize encoded_pixels,
                             common::H264Profile profile) {
  return impl_->Start(generation, encoded_pixels, profile);
}

bool H264SenderBridge::Submit(common::WorkerGeneration generation,
                              common::H264AccessUnit access_unit) {
  return impl_->Submit(generation, std::move(access_unit));
}

void H264SenderBridge::Stop() noexcept { impl_->Stop(); }

bool H264SenderBridge::IsActive() const noexcept { return impl_->IsActive(); }

std::optional<common::WorkerGeneration>
H264SenderBridge::ActiveGeneration() const noexcept {
  return impl_->ActiveGeneration();
}

H264SenderBridgeStatistics H264SenderBridge::Statistics() const noexcept {
  return impl_->Statistics();
}

} // namespace imcodes::remote_desktop::macos
