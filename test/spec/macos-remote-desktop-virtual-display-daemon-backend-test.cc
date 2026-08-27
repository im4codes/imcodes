// Counterfactuals for the worker's daemon-proxied virtual-display backend.
//
// Every case is a way the display path could report success it did not have.

#include "macos_virtual_display_daemon_backend.h"
#include "macos_worker_ipc_client.h"

#include <cstdio>
#include <cstdlib>
#include <string>
#include <string_view>
#include <vector>

namespace macos = imcodes::remote_desktop::macos;
namespace common = imcodes::remote_desktop::common;

namespace {

int g_failures = 0;

void Check(bool condition, const char* what) {
  if (condition) return;
  std::fprintf(stderr, "FAILED: %s\n", what);
  ++g_failures;
}

struct FakeDaemon {
  std::vector<std::string> asked;
  std::vector<macos::VirtualDisplayProxyReply> answers;
  bool unreachable = false;

  macos::VirtualDisplayDaemonExchange Exchange() {
    return [this](std::string_view request,
                  macos::VirtualDisplayReplyShape,
                  macos::VirtualDisplayProxyReply* reply) {
      asked.emplace_back(request);
      if (unreachable || answers.empty()) return false;
      *reply = answers.front();
      answers.erase(answers.begin());
      return true;
    };
  }

  [[nodiscard]] bool AskedAny(std::string_view needle) const {
    for (const std::string& line : asked) {
      if (line.find(needle) != std::string::npos) return true;
    }
    return false;
  }
};

macos::VirtualDisplayProxyReply RouteReply(std::uint64_t generation,
                                           std::uint32_t uid = 501) {
  macos::VirtualDisplayProxyReply reply;
  reply.ok = true;
  reply.route_generation = generation;
  reply.route_epoch = 9;
  reply.cookie_seed = 8;
  reply.uid = uid;
  return reply;
}

macos::VirtualDisplayProxyReply ReadinessReply(std::uint64_t nonce, bool ok) {
  macos::VirtualDisplayProxyReply reply;
  reply.ok = true;
  reply.nonce = nonce;
  reply.qualified_to_create = ok;
  reply.display_control_admitted = ok;
  return reply;
}

macos::VirtualDisplayNonceSource Nonces(std::uint64_t* counter) {
  return [counter]() { return ++(*counter); };
}

void ReadinessIsZeroMutation() {
  FakeDaemon daemon;
  std::uint64_t counter = 0;
  daemon.answers.push_back(ReadinessReply(1, true));
  macos::DaemonProxyVirtualDisplayBackend backend(daemon.Exchange(),
                                                  Nonces(&counter), 7, 501);
  Check(backend.ProbeSupport() == common::ReadinessState::kReady,
        "a qualified readiness answer reports ready");
  Check(daemon.asked.size() == 1, "readiness is exactly one round trip");
  // The shape itself cannot ask for a mutation.
  Check(daemon.asked[0] == "{\"op\":\"readiness\",\"nonce\":1}",
        "readiness carries a nonce and nothing else");
  Check(!daemon.AskedAny("hold") && !daemon.AskedAny("enable")
            && !daemon.AskedAny("route") && !daemon.AskedAny("disable"),
        "readiness never holds, enables, routes or disables");
  Check(!backend.route_bound(), "readiness does not bind a route capability");
}

void ReadinessFailsClosed() {
  {  // Unreachable daemon is false, never "probably".
    FakeDaemon daemon;
    daemon.unreachable = true;
    std::uint64_t counter = 0;
    macos::DaemonProxyVirtualDisplayBackend backend(daemon.Exchange(),
                                                    Nonces(&counter), 7, 501);
    Check(backend.ProbeSupport() == common::ReadinessState::kUnavailable,
          "an unreachable daemon is not ready");
  }
  {  // A stale nonce proves only that SOMETHING answered.
    FakeDaemon daemon;
    std::uint64_t counter = 0;
    daemon.answers.push_back(ReadinessReply(999, true));
    macos::DaemonProxyVirtualDisplayBackend backend(daemon.Exchange(),
                                                    Nonces(&counter), 7, 501);
    Check(backend.ProbeSupport() == common::ReadinessState::kUnavailable,
          "a readiness answer to another question is refused");
    Check(backend.terminal(),
          "answering the wrong question puts the channel terminal");
  }
  {  // Not qualified is not ready: qualification IS the create gate.
    FakeDaemon daemon;
    std::uint64_t counter = 0;
    macos::VirtualDisplayProxyReply unqualified = ReadinessReply(1, true);
    unqualified.qualified_to_create = false;
    daemon.answers.push_back(unqualified);
    macos::DaemonProxyVirtualDisplayBackend backend(daemon.Exchange(),
                                                    Nonces(&counter), 7, 501);
    Check(backend.ProbeSupport() == common::ReadinessState::kUnavailable,
          "an unqualified host cannot create");
  }
  {  // THE HEADLESS FIRST-CREATE CASE.
    //
    // Nothing is admitted and nothing is active, because no display exists
    // yet. Requiring admission here meant the first create could never happen:
    // no display until admitted, no admission until a display. Qualification
    // alone must gate creation.
    FakeDaemon daemon;
    std::uint64_t counter = 0;
    macos::VirtualDisplayProxyReply headless = ReadinessReply(1, true);
    headless.display_control_admitted = false;
    headless.admitted = false;
    headless.presence = "absent";
    daemon.answers.push_back(headless);
    macos::DaemonProxyVirtualDisplayBackend backend(daemon.Exchange(),
                                                    Nonces(&counter), 7, 501);
    Check(backend.ProbeSupport() == common::ReadinessState::kReady,
          "a qualified headless host may still create its first display");
  }
}

void RouteIdentityIsEnforced() {
  for (const auto& bad : std::vector<macos::VirtualDisplayProxyReply>{
           RouteReply(8),          // another generation
           RouteReply(7, 502),     // another uid
       }) {
    FakeDaemon daemon;
    std::uint64_t counter = 0;
    daemon.answers.push_back(bad);
    macos::DaemonProxyVirtualDisplayBackend backend(daemon.Exchange(),
                                                    Nonces(&counter), 7, 501);
    std::uint32_t display = 0;
    std::string error;
    macos::MacosVirtualDisplayConfiguration configuration;
    configuration.worker_generation = 7;
    Check(!backend.Create(configuration, &display, &error),
          "a route capability for another principal is refused");
    Check(backend.terminal(), "a mismatched route puts the channel terminal");
    Check(display == 0, "no display id is produced by a refused route");
  }
}

void TerminalIsSticky() {
  FakeDaemon daemon;
  std::uint64_t counter = 0;
  daemon.answers.push_back(RouteReply(8));       // wrong generation
  daemon.answers.push_back(RouteReply(7));       // would be correct
  macos::DaemonProxyVirtualDisplayBackend backend(daemon.Exchange(),
                                                  Nonces(&counter), 7, 501);
  std::uint32_t display = 0;
  std::string error;
  macos::MacosVirtualDisplayConfiguration configuration;
  configuration.worker_generation = 7;
  Check(!backend.Create(configuration, &display, &error), "first attempt fails");
  const std::size_t asked_once = daemon.asked.size();
  Check(!backend.Create(configuration, &display, &error),
        "a terminal channel is not retried into agreement");
  Check(daemon.asked.size() == asked_once,
        "a terminal channel does not reach the daemon again");
}

void DestroyOnlyDisables() {
  FakeDaemon daemon;
  std::uint64_t counter = 0;
  daemon.answers.push_back(RouteReply(7));
  macos::VirtualDisplayProxyReply hold;
  hold.ok = true;
  hold.admitted = true;
  hold.display_id = 42;
  daemon.answers.push_back(hold);
  macos::VirtualDisplayProxyReply disabled;
  disabled.ok = true;
  disabled.admitted = true;
  disabled.presence = "absent";
  daemon.answers.push_back(disabled);

  macos::DaemonProxyVirtualDisplayBackend backend(daemon.Exchange(),
                                                  Nonces(&counter), 7, 501);
  std::uint32_t display = 0;
  std::string error;
  macos::MacosVirtualDisplayConfiguration configuration;
  configuration.worker_generation = 7;
  Check(backend.Create(configuration, &display, &error) && display == 42,
        "hold yields the agent's display id");
  backend.Destroy();
  Check(daemon.AskedAny("\"op\":\"disable\""), "Destroy disables");
  // Release is not expressible: no builder emits it and no path can ask.
  Check(!daemon.AskedAny("release"), "Destroy never releases");
  for (const std::string& line : daemon.asked) {
    Check(line.find("cookieSeed") == std::string::npos
              && line.find("seed") == std::string::npos
              && line.find("helper") == std::string::npos,
          "no helper credential is ever put on the wire by this process");
  }
}

void NotActiveIsNotOnline() {
  FakeDaemon daemon;
  std::uint64_t counter = 0;
  daemon.answers.push_back(RouteReply(7));
  macos::VirtualDisplayProxyReply hold;
  hold.ok = true;
  hold.admitted = true;
  hold.display_id = 42;
  daemon.answers.push_back(hold);
  macos::VirtualDisplayProxyReply status;
  status.ok = true;
  status.admitted = true;
  status.presence = "inactive";  // registered, not shown
  daemon.answers.push_back(status);

  macos::DaemonProxyVirtualDisplayBackend backend(daemon.Exchange(),
                                                  Nonces(&counter), 7, 501);
  std::uint32_t display = 0;
  std::string error;
  macos::MacosVirtualDisplayConfiguration configuration;
  configuration.worker_generation = 7;
  Check(backend.Create(configuration, &display, &error), "hold succeeds");
  Check(!backend.WaitUntilOnline(display, 100, &error),
        "registered-but-inactive is not online -- that is a black screen "
        "reporting itself ready");
}

void RequestIndexStrictlyAdvances() {
  FakeDaemon daemon;
  std::uint64_t counter = 0;
  daemon.answers.push_back(RouteReply(7));
  macos::VirtualDisplayProxyReply ok;
  ok.ok = true;
  ok.admitted = true;
  ok.display_id = 42;
  ok.presence = "active";
  for (int i = 0; i < 4; ++i) daemon.answers.push_back(ok);

  macos::DaemonProxyVirtualDisplayBackend backend(daemon.Exchange(),
                                                  Nonces(&counter), 7, 501);
  std::uint32_t display = 0;
  std::string error;
  macos::MacosVirtualDisplayConfiguration configuration;
  configuration.worker_generation = 7;
  Check(backend.Create(configuration, &display, &error), "hold succeeds");
  Check(backend.WaitUntilOnline(display, 100, &error), "status succeeds");
  Check(daemon.AskedAny("\"requestIndex\":1"), "the first relay is index 1");
  Check(daemon.AskedAny("\"requestIndex\":2"), "the next relay advances");
  // A repeated index would let a captured frame be replayed.
  std::size_t index_one = 0;
  for (const std::string& line : daemon.asked) {
    if (line.find("\"requestIndex\":1") != std::string::npos) ++index_one;
  }
  Check(index_one == 1, "no request index is ever reused");
}

std::string ReplyFrame(std::string_view reply_json) {
  std::string frame = "{\"type\":\"remote_desktop.macos_ipc.virtual_display_reply\"";
  frame.append(",\"ipcVersion\":1,\"workerGeneration\":7,\"requestId\":1,\"reply\":");
  frame.append(reply_json).append("}");
  return frame;
}

void ReplyParserIsPerOpStrict() {
  using macos::HostFrameOutcome;
  using macos::VirtualDisplayReplyShape;
  macos::VirtualDisplayReplyFrame parsed;

  const auto parse = [&parsed](std::string_view json,
                               VirtualDisplayReplyShape shape) {
    return macos::ParseVirtualDisplayReplyFrame(ReplyFrame(json), 7, shape,
                                                &parsed);
  };

  // Canonical shapes are accepted.
  Check(parse(R"({"ok":true,"nonce":5,"qualifiedToCreate":true,)"
              R"("displayControlAdmitted":false})",
              VirtualDisplayReplyShape::kReadiness) == HostFrameOutcome::kAccepted,
        "a canonical readiness answer parses");
  Check(parsed.reply.qualified_to_create && !parsed.reply.display_control_admitted,
        "an explicit false is carried as false, not as absent");
  Check(parse(R"({"ok":true,"routeGeneration":7,"routeEpoch":9,)"
              R"("cookieSeed":8,"uid":501})",
              VirtualDisplayReplyShape::kRoute) == HostFrameOutcome::kAccepted,
        "a canonical route answer parses");
  Check(parse(R"({"ok":true,"admitted":true,"presence":"active"})",
              VirtualDisplayReplyShape::kRelay) == HostFrameOutcome::kAccepted,
        "a canonical relay answer parses");

  // An unknown or extra key is refused, not ignored. Ignoring it means acting
  // on a frame we only partly understood.
  Check(parse(R"({"ok":true,"nonce":5,"qualifiedToCreate":true,)"
              R"("displayControlAdmitted":true,"surprise":1})",
              VirtualDisplayReplyShape::kReadiness) != HostFrameOutcome::kAccepted,
        "an extra key on readiness is refused");
  // A missing flag is not a false one.
  Check(parse(R"({"ok":true,"nonce":5,"qualifiedToCreate":true})",
              VirtualDisplayReplyShape::kReadiness) != HostFrameOutcome::kAccepted,
        "a truncated readiness answer is refused, not read as a negative");
  // Wrong op: a route answer must not satisfy a readiness question, or a
  // capability would be read out of a zero-mutation reply.
  Check(parse(R"({"ok":true,"routeGeneration":7,"routeEpoch":9,)"
              R"("cookieSeed":8,"uid":501})",
              VirtualDisplayReplyShape::kReadiness) != HostFrameOutcome::kAccepted,
        "a route answer does not satisfy a readiness request");
  Check(parse(R"({"ok":true,"nonce":5,"qualifiedToCreate":true,)"
              R"("displayControlAdmitted":true})",
              VirtualDisplayReplyShape::kRoute) != HostFrameOutcome::kAccepted,
        "a readiness answer does not satisfy a route request");
  // Strict booleans: 1 is not true.
  Check(parse(R"({"ok":true,"nonce":5,"qualifiedToCreate":1,)"
              R"("displayControlAdmitted":false})",
              VirtualDisplayReplyShape::kReadiness) != HostFrameOutcome::kAccepted,
        "a non-boolean flag is refused");
  // Closed presence set.
  Check(parse(R"({"ok":true,"admitted":true,"presence":"probably"})",
              VirtualDisplayReplyShape::kRelay) != HostFrameOutcome::kAccepted,
        "an unknown presence is refused");
  // A route answer without a capability is not a route answer.
  Check(parse(R"({"ok":true,"routeGeneration":7,"routeEpoch":0,)"
              R"("cookieSeed":8,"uid":501})",
              VirtualDisplayReplyShape::kRoute) != HostFrameOutcome::kAccepted,
        "a route answer with no epoch is refused");
  // A refusal is exactly {ok,error}.
  Check(parse(R"({"ok":false,"error":"denied"})",
              VirtualDisplayReplyShape::kRelay) == HostFrameOutcome::kAccepted,
        "a canonical refusal parses");
  Check(parse(R"({"ok":false,"error":"denied","admitted":true})",
              VirtualDisplayReplyShape::kRelay) != HostFrameOutcome::kAccepted,
        "a refusal carrying a capability is refused");
}

}  // namespace

int main() {
  ReplyParserIsPerOpStrict();
  ReadinessIsZeroMutation();
  ReadinessFailsClosed();
  RouteIdentityIsEnforced();
  TerminalIsSticky();
  DestroyOnlyDisables();
  NotActiveIsNotOnline();
  RequestIndexStrictlyAdvances();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d daemon-backend counterfactual(s) failed\n",
                 g_failures);
    return 1;
  }
  std::printf("macos virtual display daemon backend counterfactual ok\n");
  return 0;
}
