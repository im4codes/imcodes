// Counterexamples for the single-use challenge ledger.
#include "macos_virtual_display_challenge_ledger.h"

#include <atomic>
#include <cassert>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

namespace rd = imcodes::remote_desktop::macos;

namespace {

constexpr std::uint64_t kGeneration = 7;
constexpr std::uint64_t kNow = 1'000'000;
constexpr std::uint64_t kExpiry = 2'000'000;

void AbaReplayIsRefused() {
  // A -> B -> A. A single "last challenge" string forgets A the moment B
  // arrives, so the third step succeeds and the capability is used twice.
  rd::VirtualDisplayChallengeLedger ledger;
  const std::string a(43, 'A');
  const std::string b(43, 'B');

  assert(ledger.Reserve(kGeneration, a, kExpiry, kNow) ==
         rd::ChallengeReservation::kReserved);
  ledger.Commit(kGeneration, a);
  assert(ledger.Reserve(kGeneration, b, kExpiry, kNow) ==
         rd::ChallengeReservation::kReserved);
  ledger.Commit(kGeneration, b);
  // A is still spent, even though B came after it.
  assert(ledger.Reserve(kGeneration, a, kExpiry, kNow) ==
         rd::ChallengeReservation::kAlreadySpent);
}

void ConcurrentDuplicatesProduceExactlyOneWinner() {
  // Two callers present the SAME challenge at the same instant. Check-and-record
  // must be one atomic step, or both observe "free" and two helpers start for
  // one capability.
  rd::VirtualDisplayChallengeLedger ledger;
  const std::string challenge(43, 'A');
  constexpr int kThreads = 16;
  std::atomic<int> reserved{0};
  std::atomic<int> refused{0};
  std::atomic<int> ready{0};
  std::atomic<bool> go{false};

  std::vector<std::thread> threads;
  threads.reserve(kThreads);
  for (int index = 0; index < kThreads; ++index) {
    threads.emplace_back([&] {
      ready.fetch_add(1, std::memory_order_acq_rel);
      // Barrier: every thread races the same instant, not a staggered queue.
      while (!go.load(std::memory_order_acquire)) {
      }
      const auto outcome = ledger.Reserve(kGeneration, challenge, kExpiry, kNow);
      if (outcome == rd::ChallengeReservation::kReserved)
        reserved.fetch_add(1, std::memory_order_acq_rel);
      else
        refused.fetch_add(1, std::memory_order_acq_rel);
    });
  }
  while (ready.load(std::memory_order_acquire) < kThreads) {
  }
  go.store(true, std::memory_order_release);
  for (auto& thread : threads) thread.join();

  assert(reserved.load() == 1);
  assert(refused.load() == kThreads - 1);
  assert(ledger.size() == 1);
}

void RollbackDoesNotBurnAChallenge() {
  // A failed launch must not lock the daemon out of retrying with the grant it
  // legitimately holds.
  rd::VirtualDisplayChallengeLedger ledger;
  const std::string challenge(43, 'A');
  assert(ledger.Reserve(kGeneration, challenge, kExpiry, kNow) ==
         rd::ChallengeReservation::kReserved);
  ledger.Rollback(kGeneration, challenge);
  assert(ledger.size() == 0);
  assert(ledger.Reserve(kGeneration, challenge, kExpiry, kNow) ==
         rd::ChallengeReservation::kReserved);

  // But a COMMITTED challenge may not be un-spent.
  ledger.Commit(kGeneration, challenge);
  ledger.Rollback(kGeneration, challenge);
  assert(ledger.Reserve(kGeneration, challenge, kExpiry, kNow) ==
         rd::ChallengeReservation::kAlreadySpent);
}

void InFlightIsDistinctFromSpent() {
  rd::VirtualDisplayChallengeLedger ledger;
  const std::string challenge(43, 'A');
  assert(ledger.Reserve(kGeneration, challenge, kExpiry, kNow) ==
         rd::ChallengeReservation::kReserved);
  // A second presentation while the first is mid-flight is a distinct
  // diagnosis from a replay of a completed one.
  assert(ledger.Reserve(kGeneration, challenge, kExpiry, kNow) ==
         rd::ChallengeReservation::kAlreadyPending);
}

void GenerationsDoNotCollide() {
  rd::VirtualDisplayChallengeLedger ledger;
  const std::string challenge(43, 'A');
  assert(ledger.Reserve(7, challenge, kExpiry, kNow) ==
         rd::ChallengeReservation::kReserved);
  ledger.Commit(7, challenge);
  // A rotated agent cannot be replayed into anyway, so the same string under a
  // new generation is a different capability.
  assert(ledger.Reserve(8, challenge, kExpiry, kNow) ==
         rd::ChallengeReservation::kReserved);
  ledger.ForgetGeneration(7);
  assert(ledger.size() == 1);
}

void ExpiredEntriesArePrunedAndTheLedgerStaysBounded() {
  rd::VirtualDisplayChallengeLedger ledger;
  for (int index = 0; index < 10; ++index) {
    const std::string challenge(43, static_cast<char>('a' + index));
    assert(ledger.Reserve(kGeneration, challenge, kExpiry, kNow) ==
           rd::ChallengeReservation::kReserved);
    ledger.Commit(kGeneration, challenge);
  }
  assert(ledger.size() == 10);
  // Past every expiry, the next reservation prunes them: an expired challenge
  // is refused by the expiry check anyway, so keeping it is pure growth.
  assert(ledger.Reserve(kGeneration, std::string(43, 'z'), kExpiry + 1'000'000,
                        kExpiry + 1) == rd::ChallengeReservation::kReserved);
  assert(ledger.size() == 1);

  // A flood of distinct challenges is REFUSED at the cap rather than evicting
  // the oldest -- evicting is exactly how a flood buys a replay of an old one.
  rd::VirtualDisplayChallengeLedger flooded;
  std::size_t accepted = 0;
  for (std::size_t index = 0; index < rd::kChallengeLedgerMaxEntries + 32; ++index) {
    std::string challenge(43, 'A');
    challenge[0] = static_cast<char>('a' + (index % 26));
    challenge[1] = static_cast<char>('a' + ((index / 26) % 26));
    if (flooded.Reserve(kGeneration, challenge, kExpiry, kNow) ==
        rd::ChallengeReservation::kReserved) {
      ++accepted;
    }
  }
  assert(accepted == rd::kChallengeLedgerMaxEntries);
  assert(flooded.size() == rd::kChallengeLedgerMaxEntries);
}

void MalformedReservationsAreRefused() {
  rd::VirtualDisplayChallengeLedger ledger;
  const std::string challenge(43, 'A');
  assert(ledger.Reserve(0, challenge, kExpiry, kNow) ==
         rd::ChallengeReservation::kRejected);
  assert(ledger.Reserve(kGeneration, "", kExpiry, kNow) ==
         rd::ChallengeReservation::kRejected);
  assert(ledger.Reserve(kGeneration, challenge, 0, kNow) ==
         rd::ChallengeReservation::kRejected);
  assert(ledger.Reserve(kGeneration, challenge, kExpiry, 0) ==
         rd::ChallengeReservation::kRejected);
  // Already expired at the moment of reservation.
  assert(ledger.Reserve(kGeneration, challenge, kNow, kNow) ==
         rd::ChallengeReservation::kRejected);
  assert(ledger.size() == 0);
}

}  // namespace

int main() {
  AbaReplayIsRefused();
  ConcurrentDuplicatesProduceExactlyOneWinner();
  RollbackDoesNotBurnAChallenge();
  InFlightIsDistinctFromSpent();
  GenerationsDoNotCollide();
  ExpiredEntriesArePrunedAndTheLedgerStaysBounded();
  MalformedReservationsAreRefused();
  std::printf("macos virtual display ledger counterfactual ok\n");
  return 0;
}
