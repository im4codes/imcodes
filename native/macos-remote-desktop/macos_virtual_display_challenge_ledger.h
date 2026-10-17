// Single-use ledger for grant challenges.
//
// WHY A SINGLE `spent_challenge` STRING WAS NOT ENOUGH
//
// It remembered only the LAST challenge, which leaves two live replays:
//
//   * A -> B -> A. Presenting A, then B, then A again succeeds, because B
//     overwrote the memory of A. The challenge is supposed to be single-use for
//     the life of the grant window, not "not the immediately previous one".
//   * Two concurrent A. Both callers read "not spent", both proceed, and two
//     helpers get started for one challenge. Checking and recording must be one
//     atomic step, not two.
//
// So the ledger is: RESERVE atomically, then either COMMIT or ROLL BACK.
// Reservation is what makes a concurrent duplicate lose; rollback is what stops
// a failed spawn from burning a challenge the daemon may legitimately retry.
//
// Entries are scoped to the service generation that admitted them and are
// dropped once they expire, so the set stays bounded without ever forgetting a
// challenge while it could still be replayed.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_CHALLENGE_LEDGER_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_CHALLENGE_LEDGER_H_

#include <cstdint>
#include <map>
#include <mutex>
#include <string>

namespace imcodes::remote_desktop::macos {

/** Hard cap. A flood of distinct challenges must not become unbounded memory. */
inline constexpr std::size_t kChallengeLedgerMaxEntries = 256;

enum class ChallengeReservation {
  kReserved,       // this caller owns it; must Commit or Rollback
  kAlreadyPending, // another caller is mid-flight with the same challenge
  kAlreadySpent,   // consumed earlier in this generation's window
  kRejected,       // malformed, or the ledger is full
};

class VirtualDisplayChallengeLedger final {
 public:
  /**
   * Atomically claims a challenge for this generation.
   *
   * Check-and-record is ONE step under the lock. Splitting it is precisely how
   * two concurrent presentations of the same challenge both win.
   */
  [[nodiscard]] ChallengeReservation Reserve(std::uint64_t service_generation,
                                             const std::string& challenge,
                                             std::uint64_t expires_at_ms,
                                             std::uint64_t now_ms);

  /** Promotes a reservation to spent. It stays spent until it expires. */
  void Commit(std::uint64_t service_generation, const std::string& challenge);

  /**
   * Releases a reservation without spending it.
   *
   * A refused or failed launch must not burn the challenge: the daemon is
   * entitled to retry with the same grant, and a burned challenge would lock it
   * out of its own capability.
   */
  void Rollback(std::uint64_t service_generation, const std::string& challenge);

  /**
   * Drops everything for a generation.
   *
   * A rotated service generation cannot be replayed into anyway, so keeping its
   * entries is pure growth.
   */
  void ForgetGeneration(std::uint64_t service_generation);

  [[nodiscard]] std::size_t size() const;

 private:
  struct Entry {
    std::uint64_t expires_at_ms = 0;
    bool committed = false;
  };
  /** Keyed by (generation, challenge) so two generations never collide. */
  using Key = std::pair<std::uint64_t, std::string>;

  void PruneExpiredLocked(std::uint64_t now_ms);

  mutable std::mutex mutex_;
  std::map<Key, Entry> entries_;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_CHALLENGE_LEDGER_H_
