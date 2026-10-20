// Counterfactuals for the helper binding, admission and helper-backed backend.
// Every case is a failure mode a reviewer named, not a hypothetical.
#include "macos_virtual_display_helper_backend.h"
#include "macos_virtual_display_helper_binding.h"
#include "macos_virtual_display_helper_protocol.h"

#include <cassert>
#include <cstdio>
#include <string>
#include <utility>
#include <vector>

namespace rd = imcodes::remote_desktop::macos;

namespace {

rd::VirtualDisplayHelperBinding Binding() {
  rd::VirtualDisplayHelperBinding binding;
  binding.epoch = 0xA11CE5;
  binding.cookie_seed = 0xC0FFEE123;
  binding.uid = 501;
  binding.generation = 7;
  binding.release_identity = "aidesk-v4";
  return binding;
}

rd::HelperAdmissionRequest RequestFor(const rd::VirtualDisplayHelperBinding& b,
                                      std::uint64_t index) {
  rd::HelperAdmissionRequest request;
  request.epoch = b.epoch;
  request.generation = b.generation;
  request.request_index = index;
  request.cookie = rd::DeriveHelperCookie(b.cookie_seed, index);
  request.running_uid = b.uid;
  return request;
}

void BindingRoundTripsAndRejectsMalformed() {
  const auto binding = Binding();
  rd::VirtualDisplayHelperBinding parsed;
  assert(rd::ParseVirtualDisplayHelperBinding(
      rd::SerializeVirtualDisplayHelperBinding(binding), &parsed));
  assert(parsed.epoch == binding.epoch && parsed.uid == binding.uid);
  assert(parsed.generation == binding.generation);
  assert(parsed.release_identity == binding.release_identity);

  rd::VirtualDisplayHelperBinding ignored;
  // Every field is load-bearing; a zero in any of them is unusable, not default.
  assert(!rd::ParseVirtualDisplayHelperBinding("v1 epoch=0 cookie=1 uid=501 generation=7 release=a", &ignored));
  assert(!rd::ParseVirtualDisplayHelperBinding("v1 cookie=1 uid=501 generation=7 release=a", &ignored));
  // Unknown key: refused, never silently ignored.
  assert(!rd::ParseVirtualDisplayHelperBinding("v1 epoch=1 cookie=1 uid=501 generation=7 release=a extra=9", &ignored));
  // Repeated key must not be last-wins.
  assert(!rd::ParseVirtualDisplayHelperBinding("v1 epoch=1 epoch=2 cookie=1 uid=501 generation=7 release=a", &ignored));
  assert(!rd::ParseVirtualDisplayHelperBinding("v2 epoch=1 cookie=1 uid=501 generation=7 release=a", &ignored));
  assert(!rd::ParseVirtualDisplayHelperBinding(std::string(400, 'x'), &ignored));
}

void HelperNeverSelfBindsFromTheFirstFrame() {
  const auto binding = Binding();
  const auto request = RequestFor(binding, 1);
  // THE rule: unbound helper answers nothing. "First frame wins" would let a
  // stale worker, a racing second worker, or any process of this uid that
  // connected first own the display.
  assert(rd::EvaluateHelperAdmission(binding, /*bound=*/false, 0, request) ==
         rd::HelperAdmission::kNotBound);
  assert(rd::EvaluateHelperAdmission({}, /*bound=*/true, 0, request) ==
         rd::HelperAdmission::kNotBound);
  assert(rd::EvaluateHelperAdmission(binding, true, 0, request) ==
         rd::HelperAdmission::kAdmitted);
}

void CookieAndEpochReplayAreRefused() {
  const auto binding = Binding();
  // Spending index 3 must retire 3 and everything below it.
  assert(rd::EvaluateHelperAdmission(binding, true, 3, RequestFor(binding, 3)) ==
         rd::HelperAdmission::kCookieReplay);
  assert(rd::EvaluateHelperAdmission(binding, true, 3, RequestFor(binding, 2)) ==
         rd::HelperAdmission::kCookieReplay);
  assert(rd::EvaluateHelperAdmission(binding, true, 3, RequestFor(binding, 4)) ==
         rd::HelperAdmission::kAdmitted);
  // A cookie not derivable from the bound seed cannot be minted by a peer that
  // never saw it.
  auto forged = RequestFor(binding, 9);
  forged.cookie ^= 1U;
  assert(rd::EvaluateHelperAdmission(binding, true, 0, forged) ==
         rd::HelperAdmission::kCookieUnbound);
  // A different host epoch is a replay from a superseded host.
  auto stale_epoch = RequestFor(binding, 9);
  stale_epoch.epoch += 1;
  assert(rd::EvaluateHelperAdmission(binding, true, 0, stale_epoch) ==
         rd::HelperAdmission::kEpochMismatch);
  // A stale worker that has not noticed it was replaced.
  auto stale_gen = RequestFor(binding, 9);
  stale_gen.generation += 1;
  assert(rd::EvaluateHelperAdmission(binding, true, 0, stale_gen) ==
         rd::HelperAdmission::kGenerationMismatch);
  auto wrong_uid = RequestFor(binding, 9);
  wrong_uid.running_uid += 1;
  assert(rd::EvaluateHelperAdmission(binding, true, 0, wrong_uid) ==
         rd::HelperAdmission::kUidMismatch);
  // Cookies must not be guessable from a neighbour.
  const std::uint64_t a = rd::DeriveHelperCookie(binding.cookie_seed, 1);
  const std::uint64_t b = rd::DeriveHelperCookie(binding.cookie_seed, 2);
  assert(a != b && a != 0 && b != 0);
  assert((a > b ? a - b : b - a) > 1024);
}

// A scripted helper. Each entry is the reply to the Nth request; an empty
// string means "no answer at all", i.e. a hung or dead helper.
struct ScriptedHelper {
  explicit ScriptedHelper(std::vector<std::string> scripted)
      : replies(std::move(scripted)) {}

  std::vector<std::string> replies;
  std::size_t index = 0;
  std::vector<std::string> seen;

  rd::VirtualDisplayHelperExchange Exchange() {
    return [this](const std::string& request, std::string* reply,
                  std::uint32_t) {
      seen.push_back(request);
      if (index >= replies.size() || replies[index].empty()) {
        ++index;
        return false;
      }
      *reply = replies[index++];
      return true;
    };
  }
};

std::string ReplyLine(bool ok, std::uint64_t generation, std::uint32_t display_id,
                      const std::string& presence, std::uint64_t cookie,
                      bool admitted, const std::string& error = "") {
  rd::VirtualDisplayHelperReply reply;
  reply.ok = ok;
  reply.generation = generation;
  reply.display_id = display_id;
  reply.presence = presence;
  reply.cookie = cookie;
  reply.admitted = admitted;
  reply.error = error;
  return rd::SerializeVirtualDisplayHelperReply(reply);
}

std::uint64_t CookieFor(std::uint64_t index) {
  return rd::DeriveHelperCookie(Binding().cookie_seed, index);
}

rd::MacosVirtualDisplayHelperOptions Options() {
  rd::MacosVirtualDisplayHelperOptions options;
  options.binding = Binding();
  return options;
}

void ReadinessRefusesWhenTheHelperOnlyExists() {
  // Helper answers, correctly, but holds nothing. That must NOT read as display
  // control being available.
  ScriptedHelper helper{std::vector<std::string>{ReplyLine(true, 7, 0, "absent", CookieFor(1), false)}};
  rd::MacosVirtualDisplayHelperBackend backend(Options(), helper.Exchange());
  assert(!backend.QueryAdmitted());
  assert(backend.ProbeSupport() != imcodes::remote_desktop::common::ReadinessState::kReady);

  // Registered-but-inactive is likewise not display control.
  ScriptedHelper inactive{std::vector<std::string>{ReplyLine(true, 7, 5, "inactive", CookieFor(1), true)}};
  rd::MacosVirtualDisplayHelperBackend inactive_backend(Options(), inactive.Exchange());
  assert(!inactive_backend.QueryAdmitted());

  // Held and active: the only shape that qualifies.
  ScriptedHelper live{std::vector<std::string>{ReplyLine(true, 7, 5, "active", CookieFor(1), true)}};
  rd::MacosVirtualDisplayHelperBackend live_backend(Options(), live.Exchange());
  assert(live_backend.QueryAdmitted());
}

void UnboundTransportOrBindingIsPermanentlyFailed() {
  rd::MacosVirtualDisplayHelperBackend no_transport(Options(), nullptr);
  assert(no_transport.liveness() == rd::HelperLiveness::kFailed);
  assert(!no_transport.QueryAdmitted());

  rd::MacosVirtualDisplayHelperOptions unbound;  // default binding is invalid
  ScriptedHelper helper{std::vector<std::string>{ReplyLine(true, 7, 5, "active", CookieFor(1), true)}};
  rd::MacosVirtualDisplayHelperBackend backend(unbound, helper.Exchange());
  assert(backend.liveness() == rd::HelperLiveness::kFailed);
  assert(!backend.QueryAdmitted());
  // It must not even have tried to talk: a missing binding is not a retryable
  // condition.
  assert(helper.seen.empty());
}

void HungHelperFailsBoundedAndLatches() {
  // Every request times out.
  ScriptedHelper dead{std::vector<std::string>{"", "", "", "", ""}};
  auto options = Options();
  options.max_consecutive_failures = 3;
  rd::MacosVirtualDisplayHelperBackend backend(options, dead.Exchange());
  assert(!backend.QueryAdmitted());
  assert(!backend.QueryAdmitted());
  assert(!backend.QueryAdmitted());
  assert(backend.liveness() == rd::HelperLiveness::kFailed);
  const std::size_t attempts = dead.seen.size();
  // Latched: further calls must not keep paying the timeout.
  assert(!backend.QueryAdmitted());
  assert(dead.seen.size() == attempts);
}

void ReplyNotBoundToTheRequestIsFatal() {
  // Correct-looking reply carrying someone else's cookie.
  ScriptedHelper crossed{std::vector<std::string>{ReplyLine(true, 7, 5, "active", CookieFor(999), true)}};
  rd::MacosVirtualDisplayHelperBackend backend(Options(), crossed.Exchange());
  assert(!backend.QueryAdmitted());
  assert(backend.liveness() == rd::HelperLiveness::kFailed);
}

void DestroyNeverReportsRemovalItDidNotObserve() {
  // Hold, then release with the display STILL registered-inactive.
  ScriptedHelper helper{std::vector<std::string>{
      ReplyLine(true, 7, 5, "active", CookieFor(1), true),   // hold
      ReplyLine(true, 7, 5, "inactive", CookieFor(2), true), // release
  }};
  rd::MacosVirtualDisplayHelperBackend backend(Options(), helper.Exchange());
  std::uint32_t id = 0;
  std::string error;
  rd::MacosVirtualDisplayConfiguration configuration;
  configuration.worker_generation = 7;
  assert(backend.Create(configuration, &id, &error));
  assert(id == 5);
  backend.Destroy();
  // Registered-but-inactive is NOT removed, and saying otherwise is how a leak
  // gets reported as a clean shutdown.
  assert(backend.leaked_on_destroy());

  ScriptedHelper clean{std::vector<std::string>{
      ReplyLine(true, 7, 5, "active", CookieFor(1), true),
      ReplyLine(true, 7, 5, "absent", CookieFor(2), true),
  }};
  rd::MacosVirtualDisplayHelperBackend removed(Options(), clean.Exchange());
  assert(removed.Create(configuration, &id, &error));
  removed.Destroy();
  assert(!removed.leaked_on_destroy());
}

void WaitUntilOnlineDemandsActiveNotMerelyRegistered() {
  ScriptedHelper helper{std::vector<std::string>{
      ReplyLine(true, 7, 5, "active", CookieFor(1), true),    // hold
      ReplyLine(true, 7, 5, "inactive", CookieFor(2), true),  // status
  }};
  rd::MacosVirtualDisplayHelperBackend backend(Options(), helper.Exchange());
  std::uint32_t id = 0;
  std::string error;
  rd::MacosVirtualDisplayConfiguration configuration;
  configuration.worker_generation = 7;
  assert(backend.Create(configuration, &id, &error));
  assert(!backend.WaitUntilOnline(id, 1000, &error));
  assert(error.find("registered") != std::string::npos);
}

}  // namespace

int main() {
  BindingRoundTripsAndRejectsMalformed();
  HelperNeverSelfBindsFromTheFirstFrame();
  CookieAndEpochReplayAreRefused();
  ReadinessRefusesWhenTheHelperOnlyExists();
  UnboundTransportOrBindingIsPermanentlyFailed();
  HungHelperFailsBoundedAndLatches();
  ReplyNotBoundToTheRequestIsFatal();
  DestroyNeverReportsRemovalItDidNotObserve();
  WaitUntilOnlineDemandsActiveNotMerelyRegistered();
  std::printf("macos virtual display helper counterfactual ok\n");
  return 0;
}
