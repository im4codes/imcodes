#include "macos_virtual_display_challenge_ledger.h"

#include <vector>

namespace imcodes::remote_desktop::macos {

void VirtualDisplayChallengeLedger::PruneExpiredLocked(std::uint64_t now_ms) {
  // An expired challenge cannot be replayed into an admission anyway -- the
  // expiry check refuses it first -- so keeping it is pure growth.
  for (auto it = entries_.begin(); it != entries_.end();) {
    it = (now_ms >= it->second.expires_at_ms) ? entries_.erase(it) : std::next(it);
  }
}

ChallengeReservation VirtualDisplayChallengeLedger::Reserve(
    std::uint64_t service_generation,
    const std::string& challenge,
    std::uint64_t expires_at_ms,
    std::uint64_t now_ms) {
  if (service_generation == 0 || challenge.empty() || challenge.size() > 128 ||
      expires_at_ms == 0 || now_ms == 0 || now_ms >= expires_at_ms) {
    return ChallengeReservation::kRejected;
  }
  // ONE critical section for check AND record. Two concurrent presentations of
  // the same challenge must not both observe "free".
  const std::lock_guard<std::mutex> guard(mutex_);
  PruneExpiredLocked(now_ms);
  const Key key{service_generation, challenge};
  const auto existing = entries_.find(key);
  if (existing != entries_.end()) {
    return existing->second.committed ? ChallengeReservation::kAlreadySpent
                                      : ChallengeReservation::kAlreadyPending;
  }
  if (entries_.size() >= kChallengeLedgerMaxEntries) {
    // Refuse rather than evict: evicting the oldest entry is exactly how a
    // flood of fresh challenges buys a replay of an old one.
    return ChallengeReservation::kRejected;
  }
  entries_.emplace(key, Entry{expires_at_ms, false});
  return ChallengeReservation::kReserved;
}

void VirtualDisplayChallengeLedger::Commit(std::uint64_t service_generation,
                                           const std::string& challenge) {
  const std::lock_guard<std::mutex> guard(mutex_);
  const auto entry = entries_.find(Key{service_generation, challenge});
  if (entry != entries_.end())
    entry->second.committed = true;
}

void VirtualDisplayChallengeLedger::Rollback(std::uint64_t service_generation,
                                             const std::string& challenge) {
  const std::lock_guard<std::mutex> guard(mutex_);
  const auto entry = entries_.find(Key{service_generation, challenge});
  // Only an UNCOMMITTED reservation may be released. Rolling back a committed
  // one would un-spend a challenge that really was used.
  if (entry != entries_.end() && !entry->second.committed)
    entries_.erase(entry);
}

void VirtualDisplayChallengeLedger::ForgetGeneration(
    std::uint64_t service_generation) {
  const std::lock_guard<std::mutex> guard(mutex_);
  for (auto it = entries_.begin(); it != entries_.end();) {
    it = it->first.first == service_generation ? entries_.erase(it) : std::next(it);
  }
}

std::size_t VirtualDisplayChallengeLedger::size() const {
  const std::lock_guard<std::mutex> guard(mutex_);
  return entries_.size();
}

}  // namespace imcodes::remote_desktop::macos
