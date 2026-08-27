// Counterfactual for the macOS transport session adapter.
//
// Every case below asserts a fail-closed property: the adapter must refuse to
// widen authority when the backend, the route or the callback stamp is wrong.
// A permissive backend must not be able to turn any of these into a success.

#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "../remote-desktop-common/data_channel_constants.h"
#include "macos_transport_session_adapter.h"

namespace rd = imcodes::remote_desktop;
namespace macos = imcodes::remote_desktop::macos;

namespace {

int g_failures = 0;

void Check(bool condition, const char* label) {
  if (condition)
    return;
  std::fprintf(stderr, "FAIL %s\n", label);
  ++g_failures;
}

// Deliberately maximally permissive: it says yes to everything and records
// what it was asked to do. Any refusal observed in a test therefore came from
// the adapter, not from the backend.
class PermissiveBackend final : public macos::MacosPeerConnectionBackend {
 public:
  void BindAdapter(
      macos::MacosTransportSessionAdapter* adapter) noexcept override {
    adapter_ = adapter;
  }

  void BindMediaSender(
      macos::MacosMediaSenderBinder* binder) noexcept override {
    ++bind_media_calls;
    (void)binder;
  }
  int bind_media_calls = 0;

  bool Open(
      const macos::MacosTransportBackendConfiguration& configuration) override {
    ++open_calls;
    last_identity = configuration.identity;
    return !fail_open;
  }

  [[nodiscard]] bool NegotiateOffer(std::string_view offer_sdp,
                                    std::string* answer_sdp) override {
    ++negotiate_calls;
    last_offer.assign(offer_sdp);
    if (reentrant_adapter != nullptr) {
      macos::MacosTransportSessionAdapter* nested = reentrant_adapter;
      reentrant_adapter = nullptr;
      reentry_observed = true;
      std::string ignored;
      reentry_allowed = nested->NegotiateOffer("v=0\r\nnested", &ignored);
    }
    if (close_during_negotiate != nullptr) {
      macos::MacosTransportSessionAdapter* victim = close_during_negotiate;
      close_during_negotiate = nullptr;
      victim->CloseTransport();
    }
    if (fail_negotiate)
      return false;
    if (answer_sdp != nullptr)
      *answer_sdp = answer_to_return;
    return true;
  }
  int negotiate_calls = 0;
  bool fail_negotiate = false;
  std::string last_offer;
  std::string answer_to_return = "v=0\r\nanswer";
  macos::MacosTransportSessionAdapter* reentrant_adapter = nullptr;
  bool reentry_observed = false;
  bool reentry_allowed = false;
  // Closes the route from inside the negotiation, modelling a Stop that lands
  // while upstream is still running the chain.
  macos::MacosTransportSessionAdapter* close_during_negotiate = nullptr;

  bool AddRemoteIceCandidate(
      const rd::common::IceCandidate& candidate) override {
    remote_candidates.push_back(candidate.candidate);
    return true;
  }

  bool EmitLocalIceCandidate(
      const rd::common::IceCandidate& candidate) override {
    local_candidates.push_back(candidate.candidate);
    return true;
  }

  bool SendDataChannel(rd::common::DataChannelKind channel,
                       std::string_view payload) override {
    sent_channels.push_back(channel);
    sent_payloads.emplace_back(payload);
    return true;
  }

  bool ApplyBitrate(std::uint32_t min_bps,
                    std::uint32_t start_bps,
                    std::uint32_t max_bps) override {
    bitrate_calls.push_back({min_bps, start_bps, max_bps});
    return true;
  }

  void CloseDataChannel(rd::common::DataChannelKind channel) noexcept override {
    closed_channels.push_back(channel);
  }

  void Close() noexcept override {
    ++close_calls;
    if (external_close_calls != nullptr)
      ++*external_close_calls;
  }

  // Lets a test observe teardown after the adapter has already destroyed this
  // backend. Reading the backend itself at that point would be a use-after-
  // free, which the sanitizers correctly reject.
  int* external_close_calls = nullptr;

  macos::MacosTransportSessionAdapter* adapter_ = nullptr;
  bool fail_open = false;
  int open_calls = 0;
  int close_calls = 0;
  rd::common::RouteAuthorityIdentity last_identity;
  std::vector<std::string> remote_candidates;
  std::vector<std::string> local_candidates;
  std::vector<rd::common::DataChannelKind> sent_channels;
  std::vector<std::string> sent_payloads;
  std::vector<rd::common::DataChannelKind> closed_channels;
  struct Bitrate {
    std::uint32_t min_bps;
    std::uint32_t start_bps;
    std::uint32_t max_bps;
  };
  std::vector<Bitrate> bitrate_calls;
};

class RecordingSink final : public macos::MacosTransportCallbackSink {
 public:
  void OnPeerConnectionState(const rd::common::TransportCallbackStamp&,
                             rd::common::PeerConnectionState state) override {
    peer_states.push_back(state);
  }
  void OnDataChannelState(const rd::common::TransportCallbackStamp&,
                          rd::common::DataChannelKind channel,
                          rd::common::DataChannelState state) override {
    channel_states.push_back({channel, state});
  }
  void OnDataChannelMessage(const rd::common::TransportCallbackStamp&,
                            rd::common::DataChannelKind channel,
                            std::string payload) override {
    message_channels.push_back(channel);
    messages.push_back(std::move(payload));
  }
  void OnLocalIceCandidate(const rd::common::TransportCallbackStamp&,
                           rd::common::IceCandidate candidate) override {
    emitted.push_back(candidate.candidate);
  }
  void OnTransportPath(const rd::common::TransportCallbackStamp&,
                       rd::common::TransportPath path) override {
    paths.push_back(path);
  }
  void OnQualityTarget(const rd::common::TransportCallbackStamp&,
                       rd::common::QualityTarget target) override {
    quality_targets.push_back(target);
  }
  void OnTerminal(rd::common::TransportTerminalReason reason) override {
    terminals.push_back(reason);
  }

  std::vector<rd::common::PeerConnectionState> peer_states;
  std::vector<rd::common::DataChannelKind> message_channels;
  std::vector<std::string> messages;
  struct ChannelEvent {
    rd::common::DataChannelKind channel;
    rd::common::DataChannelState state;
  };
  std::vector<ChannelEvent> channel_states;
  std::vector<std::string> emitted;
  std::vector<rd::common::TransportPath> paths;
  std::vector<rd::common::QualityTarget> quality_targets;
  std::vector<rd::common::TransportTerminalReason> terminals;
};

rd::common::RouteAuthority ValidAuthority() {
  rd::common::RouteAuthority authority;
  authority.identity.request_id = "req-1";
  authority.identity.session_id = "sess-1";
  authority.identity.negotiated_capability_binding = "binding-1";
  authority.identity.daemon_generation = 7;
  authority.identity.route_generation = 3;
  authority.expires_at_unix_ms = 1;
  authority.lease_expires_at_unix_ms = 1;
  authority.mode = rd::common::TransportSessionMode::kControl;
  authority.input_epoch = 11;
  return authority;
}

struct Fixture {
  RecordingSink sink;
  PermissiveBackend* backend = nullptr;
  std::unique_ptr<macos::MacosTransportSessionAdapter> adapter;

  Fixture() {
    auto owned = std::make_unique<PermissiveBackend>();
    backend = owned.get();
    adapter = std::make_unique<macos::MacosTransportSessionAdapter>(
        std::move(owned), sink);
    backend->BindAdapter(adapter.get());
  }
};

void RequiredChannelsAreExactlyThree() {
  std::size_t count = 0;
  bool control = false;
  bool keyboard = false;
  bool pointer = false;
  for (const auto kind : macos::kRequiredDataChannels) {
    ++count;
    control = control || kind == rd::common::DataChannelKind::kControl;
    keyboard = keyboard || kind == rd::common::DataChannelKind::kKeyboard;
    pointer = pointer || kind == rd::common::DataChannelKind::kPointer;
  }
  Check(count == 3, "required channel count is three");
  Check(control && keyboard && pointer, "required channels are exact");
  // Distinct, non-empty labels: two channels sharing a label would silently
  // collapse into one at the SCTP layer.
  const std::string a =
      macos::DataChannelLabel(rd::common::DataChannelKind::kControl);
  const std::string b =
      macos::DataChannelLabel(rd::common::DataChannelKind::kKeyboard);
  const std::string c =
      macos::DataChannelLabel(rd::common::DataChannelKind::kPointer);
  Check(!a.empty() && !b.empty() && !c.empty(), "labels are non-empty");
  Check(a != b && b != c && a != c, "labels are distinct");
}

void RejectsInvalidRoute() {
  Fixture fixture;
  rd::common::RouteAuthority authority;  // default: invalid identity
  Check(!fixture.adapter->StartTransport(authority),
        "invalid route is refused");
  Check(fixture.backend->open_calls == 0,
        "invalid route never reaches the backend");
  Check(!fixture.adapter->started(), "invalid route does not latch started");
}

void RejectsRestartAndPartialOpen() {
  Fixture fixture;
  Check(fixture.adapter->StartTransport(ValidAuthority()),
        "valid route starts");
  Check(fixture.backend->open_calls == 1, "backend opened once");
  Check(!fixture.adapter->StartTransport(ValidAuthority()),
        "adapter is single-shot");
  Check(fixture.backend->open_calls == 1, "restart never re-opens backend");

  Fixture failing;
  failing.backend->fail_open = true;
  Check(!failing.adapter->StartTransport(ValidAuthority()),
        "failed open is refused");
  Check(!failing.adapter->started(), "failed open does not latch started");
  // A partially opened peer must not be usable.
  rd::common::IceCandidate candidate;
  candidate.media_id = "0";
  candidate.candidate = "candidate:1 1 udp 1 1.2.3.4 1 typ host";
  Check(!failing.adapter->AddRemoteIceCandidate(candidate),
        "failed open leaves candidates refused");
}

void RejectsWorkBeforeStartAndAfterClose() {
  Fixture fixture;
  rd::common::IceCandidate candidate;
  candidate.media_id = "0";
  candidate.candidate = "candidate:1 1 udp 1 1.2.3.4 1 typ host";
  rd::common::QualitySelection quality;
  quality.bitrate_bps = 1'000'000;

  Check(!fixture.adapter->AddRemoteIceCandidate(candidate),
        "remote candidate refused before start");
  Check(!fixture.adapter->EmitLocalIceCandidate(candidate),
        "local candidate refused before start");
  Check(!fixture.adapter->ApplyQuality(quality),
        "quality refused before start");

  Check(fixture.adapter->StartTransport(ValidAuthority()), "starts");
  Check(fixture.adapter->AddRemoteIceCandidate(candidate),
        "remote candidate accepted while open");
  fixture.adapter->CloseTransport();
  Check(fixture.backend->close_calls == 1, "close reaches backend once");
  Check(!fixture.adapter->AddRemoteIceCandidate(candidate),
        "remote candidate refused after close");
  Check(!fixture.adapter->EmitLocalIceCandidate(candidate),
        "local candidate refused after close");
  Check(!fixture.adapter->ApplyQuality(quality), "quality refused after close");
  fixture.adapter->CloseTransport();
  Check(fixture.backend->close_calls == 1, "close is idempotent");
}

void RejectsOversizedAndEmptyCandidates() {
  Fixture fixture;
  Check(fixture.adapter->StartTransport(ValidAuthority()), "starts");

  rd::common::IceCandidate empty;
  empty.media_id = "0";
  Check(!fixture.adapter->AddRemoteIceCandidate(empty),
        "empty candidate refused");

  rd::common::IceCandidate oversized;
  oversized.media_id = "0";
  oversized.candidate.assign(rd::common::kTransportMaximumIceCandidateBytes + 1,
                             'a');
  Check(!fixture.adapter->AddRemoteIceCandidate(oversized),
        "oversized candidate refused");

  rd::common::IceCandidate oversized_mid;
  oversized_mid.media_id.assign(
      rd::common::kTransportMaximumIceMediaIdBytes + 1, 'm');
  oversized_mid.candidate = "candidate:1 1 udp 1 1.2.3.4 1 typ host";
  Check(!fixture.adapter->AddRemoteIceCandidate(oversized_mid),
        "oversized media id refused");
  Check(fixture.backend->remote_candidates.empty(),
        "no malformed candidate reaches the backend");
}

void RejectsOutOfRangeQuality() {
  Fixture fixture;
  Check(fixture.adapter->StartTransport(ValidAuthority()), "starts");

  rd::common::QualitySelection zero;
  zero.bitrate_bps = 0;
  Check(!fixture.adapter->ApplyQuality(zero), "zero bitrate refused");

  rd::common::QualitySelection excessive;
  excessive.bitrate_bps = rd::common::kTransportMaximumQualityTargetBps + 1;
  Check(!fixture.adapter->ApplyQuality(excessive), "over-cap bitrate refused");
  Check(fixture.backend->bitrate_calls.empty(),
        "no out-of-range bitrate reaches the backend");

  rd::common::QualitySelection accepted;
  accepted.bitrate_bps = 2'000'000;
  Check(fixture.adapter->ApplyQuality(accepted), "in-range bitrate accepted");
  Check(fixture.backend->bitrate_calls.size() == 1, "one bitrate applied");
  const auto& applied = fixture.backend->bitrate_calls.front();
  Check(applied.max_bps == 2'000'000, "max matches the selection");
  Check(applied.min_bps > 0 && applied.min_bps <= applied.max_bps,
        "min is positive and bounded by max");
}

void ReleaseControlRequiresExactIdentity() {
  Fixture fixture;
  const auto authority = ValidAuthority();
  Check(fixture.adapter->StartTransport(authority), "starts");

  rd::common::RouteAuthorityIdentity other = authority.identity;
  other.request_id = "req-2";
  fixture.adapter->ReleaseControlAuthority(other, 99);
  Check(fixture.backend->closed_channels.empty(),
        "mismatched identity releases nothing");
  Check(fixture.adapter->released_input_epoch() == 0,
        "mismatched identity records no epoch");

  rd::common::RouteAuthorityIdentity stale_generation = authority.identity;
  stale_generation.route_generation += 1;
  fixture.adapter->ReleaseControlAuthority(stale_generation, 99);
  Check(fixture.backend->closed_channels.empty(),
        "mismatched route generation releases nothing");

  fixture.adapter->ReleaseControlAuthority(authority.identity, 11);
  Check(fixture.adapter->released_input_epoch() == 11, "epoch recorded");
  // Control-bearing channels close; the view path stays open.
  bool keyboard = false;
  bool pointer = false;
  bool control = false;
  for (const auto channel : fixture.backend->closed_channels) {
    keyboard = keyboard || channel == rd::common::DataChannelKind::kKeyboard;
    pointer = pointer || channel == rd::common::DataChannelKind::kPointer;
    control = control || channel == rd::common::DataChannelKind::kControl;
  }
  Check(keyboard && pointer, "input channels are released");
  Check(!control, "view channel survives control release");
}

void StaleStampCallbacksAreDropped() {
  Fixture fixture;
  const auto authority = ValidAuthority();
  Check(fixture.adapter->StartTransport(authority), "starts");
  const auto good = fixture.adapter->stamp();

  rd::common::TransportCallbackStamp stale = good;
  stale.route_generation += 1;
  fixture.adapter->ReportPeerConnectionState(
      stale, rd::common::PeerConnectionState::kConnected);
  fixture.adapter->ReportDataChannelState(stale,
                                          rd::common::DataChannelKind::kControl,
                                          rd::common::DataChannelState::kOpen);
  fixture.adapter->ReportTransportPath(stale,
                                       rd::common::TransportPath::kDirect);
  Check(fixture.sink.peer_states.empty(), "stale peer state dropped");
  Check(fixture.sink.channel_states.empty(), "stale channel state dropped");
  Check(fixture.sink.paths.empty(), "stale path dropped");

  rd::common::TransportCallbackStamp stale_daemon = good;
  stale_daemon.daemon_generation += 1;
  fixture.adapter->ReportPeerConnectionState(
      stale_daemon, rd::common::PeerConnectionState::kConnected);
  Check(fixture.sink.peer_states.empty(), "stale daemon generation dropped");

  fixture.adapter->ReportPeerConnectionState(
      good, rd::common::PeerConnectionState::kConnected);
  Check(fixture.sink.peer_states.size() == 1, "current stamp is delivered");

  // After close, even a matching stamp must not reach the sink.
  fixture.adapter->CloseTransport();
  fixture.adapter->ReportPeerConnectionState(
      good, rd::common::PeerConnectionState::kFailed);
  Check(fixture.sink.peer_states.size() == 1,
        "callback after close is dropped");
}

void MalformedLocalCandidateNeverReachesSink() {
  Fixture fixture;
  Check(fixture.adapter->StartTransport(ValidAuthority()), "starts");
  const auto stamp = fixture.adapter->stamp();

  rd::common::IceCandidate empty;
  empty.media_id = "0";
  fixture.adapter->ReportLocalIceCandidate(stamp, empty);
  rd::common::IceCandidate oversized;
  oversized.media_id = "0";
  oversized.candidate.assign(rd::common::kTransportMaximumIceCandidateBytes + 1,
                             'a');
  fixture.adapter->ReportLocalIceCandidate(stamp, oversized);
  Check(fixture.sink.emitted.empty(), "malformed local candidates dropped");

  rd::common::IceCandidate good;
  good.media_id = "0";
  good.candidate = "candidate:1 1 udp 1 1.2.3.4 1 typ host";
  fixture.adapter->ReportLocalIceCandidate(stamp, good);
  Check(fixture.sink.emitted.size() == 1, "well-formed candidate delivered");
}

void TerminalClosesBeforeNotifying() {
  Fixture fixture;
  Check(fixture.adapter->StartTransport(ValidAuthority()), "starts");
  fixture.adapter->OnTerminal(rd::common::TransportTerminalReason::kPeerFailed);
  Check(fixture.backend->close_calls == 1, "terminal closes the backend");
  Check(fixture.sink.terminals.size() == 1, "terminal reported once");
  Check(fixture.adapter->closed(), "terminal marks the adapter closed");
  fixture.adapter->OnTerminal(
      rd::common::TransportTerminalReason::kAdapterFailure);
  Check(fixture.backend->close_calls == 1,
        "reentrant terminal does not close twice");
  Check(fixture.sink.terminals.size() == 1,
        "reentrant terminal does not notify the sink twice");
  // Nothing may be admitted after a terminal notification.
  rd::common::QualitySelection quality;
  quality.bitrate_bps = 1'000'000;
  Check(!fixture.adapter->ApplyQuality(quality), "work refused after terminal");
}

void DiagnosticsAreRecordedNotActedOn() {
  Fixture fixture;
  Check(fixture.adapter->StartTransport(ValidAuthority()), "starts");
  rd::common::TransportDiagnostics diagnostics;
  diagnostics.sequence = 42;
  fixture.adapter->PublishDiagnostics(diagnostics);
  Check(fixture.adapter->last_diagnostics_sequence() == 42,
        "diagnostics sequence recorded");
  Check(fixture.backend->close_calls == 0,
        "diagnostics do not mutate the peer");
}

void DestructorClosesTransport() {
  int closes = 0;
  {
    Fixture fixture;
    fixture.backend->external_close_calls = &closes;
    Check(fixture.adapter->StartTransport(ValidAuthority()), "starts");
    fixture.adapter.reset();
  }
  Check(closes == 1, "destructor closes the transport exactly once");
}

}  // namespace

void NegotiationRequiresAStartedOpenRoute() {
  Fixture fixture;
  std::string answer;

  // Before StartTransport there is no route to negotiate for.
  Check(!fixture.adapter->NegotiateOffer("v=0\r\noffer", &answer),
        "negotiation before start is refused");
  Check(fixture.backend->negotiate_calls == 0,
        "a refused negotiation never reaches the backend");

  Check(fixture.adapter->StartTransport(ValidAuthority()), "route starts");
  Check(fixture.adapter->NegotiateOffer("v=0\r\noffer", &answer),
        "negotiation succeeds on a started route");
  Check(answer == fixture.backend->answer_to_return,
        "the backend answer is returned");
  Check(fixture.backend->last_offer == "v=0\r\noffer",
        "the exact offer is forwarded");

  fixture.adapter->CloseTransport();
  const int calls = fixture.backend->negotiate_calls;
  Check(!fixture.adapter->NegotiateOffer("v=0\r\noffer", &answer),
        "negotiation after close is refused");
  Check(fixture.backend->negotiate_calls == calls,
        "a closed route never reaches the backend");
}

void NegotiationBoundsAndFailuresProduceNoAnswer() {
  Fixture fixture;
  Check(fixture.adapter->StartTransport(ValidAuthority()), "route starts");

  std::string answer = "untouched";
  Check(!fixture.adapter->NegotiateOffer("", &answer),
        "an empty offer is refused");
  Check(
      !fixture.adapter->NegotiateOffer(
          std::string(macos::kMacosTransportMaximumSdpBytes + 1, 'a'), &answer),
      "an oversized offer is refused");
  Check(!fixture.adapter->NegotiateOffer("v=0", nullptr),
        "a null answer destination is refused");
  Check(answer == "untouched",
        "a refused negotiation leaves the destination untouched");

  fixture.backend->fail_negotiate = true;
  Check(!fixture.adapter->NegotiateOffer("v=0\r\noffer", &answer),
        "a backend failure is reported as failure");
  Check(answer == "untouched", "a failed negotiation writes no answer");

  // The adapter, not the backend, owns the bound: a permissive backend that
  // returns an out-of-bounds or empty answer must still be refused.
  fixture.backend->fail_negotiate = false;
  fixture.backend->answer_to_return =
      std::string(macos::kMacosTransportMaximumSdpBytes + 1, 'b');
  Check(!fixture.adapter->NegotiateOffer("v=0\r\noffer", &answer),
        "an oversized answer is refused even when the backend accepts it");
  fixture.backend->answer_to_return.clear();
  Check(!fixture.adapter->NegotiateOffer("v=0\r\noffer", &answer),
        "an empty answer is refused");
  Check(answer == "untouched", "no refused path writes an answer");
}

void AnswerIsRefusedWhenTheRouteClosedMidNegotiation() {
  Fixture fixture;
  Check(fixture.adapter->StartTransport(ValidAuthority()), "route starts");
  // Upstream succeeds, but the route was torn down while it was working.
  // Publishing the answer anyway would install a peer for a session that has
  // already stopped, and the precondition check cannot catch it: the route was
  // still open when the call began.
  fixture.backend->close_during_negotiate = fixture.adapter.get();

  std::string answer = "untouched";
  Check(!fixture.adapter->NegotiateOffer("v=0\\r\\noffer", &answer),
        "an answer for a route closed mid-negotiation is refused");
  Check(answer == "untouched",
        "a route closed mid-negotiation writes no answer");
}

void OverlappingNegotiationIsRefusedNotQueued() {
  Fixture fixture;
  Check(fixture.adapter->StartTransport(ValidAuthority()), "route starts");
  // Re-entry from inside the backend is the only way a single-threaded caller
  // can overlap two chains. Two overlapping chains would both reach
  // SetLocalDescription and the later answer would silently win.
  fixture.backend->reentrant_adapter = fixture.adapter.get();

  std::string answer;
  Check(fixture.adapter->NegotiateOffer("v=0\r\nouter", &answer),
        "the first negotiation completes");
  Check(fixture.backend->reentry_observed,
        "the re-entrant attempt actually ran");
  Check(!fixture.backend->reentry_allowed,
        "a second offer while one is in flight is refused");
  Check(!fixture.adapter->negotiation_in_flight(),
        "the in-flight marker is cleared once the chain settles");
}

void DataPayloadsAreBoundedAndGenerationFenced() {
  Fixture fixture;
  Check(!fixture.adapter->SendDataChannel(rd::common::DataChannelKind::kControl,
                                          "{}"),
        "data send before start is refused");
  Check(fixture.adapter->StartTransport(ValidAuthority()), "route starts");
  Check(fixture.adapter->SendDataChannel(rd::common::DataChannelKind::kControl,
                                         "{\"ok\":true}"),
        "bounded data send reaches the backend");
  Check(fixture.backend->sent_payloads.size() == 1,
        "one payload reaches the backend");
  Check(!fixture.adapter->SendDataChannel(
            rd::common::DataChannelKind::kControl,
            std::string(imcodes::rd::kMaxDataMessageBytes + 1, 'x')),
        "oversized outbound payload is refused");

  auto stale = fixture.adapter->stamp();
  stale.route_generation += 1;
  fixture.adapter->ReportDataChannelMessage(
      stale, rd::common::DataChannelKind::kKeyboard, "stale");
  Check(fixture.sink.messages.empty(), "stale inbound payload is dropped");
  fixture.adapter->ReportDataChannelMessage(
      fixture.adapter->stamp(), rd::common::DataChannelKind::kKeyboard,
      "current");
  Check(fixture.sink.messages.size() == 1 &&
            fixture.sink.messages.front() == "current",
        "current bounded inbound payload reaches the sink");
}

void ProductionStyleLocalIceUsesTheOutboundEmitter() {
  RecordingSink sink;
  auto owned = std::make_unique<PermissiveBackend>();
  PermissiveBackend* backend = owned.get();
  std::vector<std::string> emitted;
  macos::MacosTransportSessionAdapter adapter(
      std::move(owned), sink, {},
      [&emitted](const rd::common::IceCandidate& candidate) {
        emitted.push_back(candidate.candidate);
        return true;
      });
  backend->BindAdapter(&adapter);
  Check(adapter.StartTransport(ValidAuthority()), "route starts");
  rd::common::IceCandidate candidate{"0",
                                     "candidate:1 1 udp 1 1.2.3.4 1 typ host"};
  Check(adapter.EmitLocalIceCandidate(candidate),
        "local ICE is emitted to the signaling boundary");
  Check(emitted.size() == 1, "the outbound emitter receives local ICE");
  Check(backend->local_candidates.empty(),
        "production-style local ICE is never pushed back into libwebrtc");
}

void QualityTargetsAreGenerationFenced() {
  Fixture fixture;
  Check(fixture.adapter->StartTransport(ValidAuthority()), "route starts");
  const rd::common::QualityTarget target{2'000'000,
                                         rd::common::PixelSize{1920, 1080}};
  auto stale = fixture.adapter->stamp();
  ++stale.route_generation;
  fixture.adapter->ReportQualityTarget(stale, target);
  Check(fixture.sink.quality_targets.empty(),
        "stale quality target is dropped");
  fixture.adapter->ReportQualityTarget(fixture.adapter->stamp(), target);
  Check(fixture.sink.quality_targets.size() == 1 &&
            fixture.sink.quality_targets.front().bitrate_bps ==
                target.bitrate_bps,
        "current quality target reaches the common core sink");
  fixture.adapter->CloseTransport();
  fixture.adapter->ReportQualityTarget(fixture.adapter->stamp(), target);
  Check(fixture.sink.quality_targets.size() == 1,
        "quality target after close is dropped");
}

int main() {
  RequiredChannelsAreExactlyThree();
  RejectsInvalidRoute();
  RejectsRestartAndPartialOpen();
  RejectsWorkBeforeStartAndAfterClose();
  RejectsOversizedAndEmptyCandidates();
  RejectsOutOfRangeQuality();
  ReleaseControlRequiresExactIdentity();
  StaleStampCallbacksAreDropped();
  MalformedLocalCandidateNeverReachesSink();
  TerminalClosesBeforeNotifying();
  DiagnosticsAreRecordedNotActedOn();
  DestructorClosesTransport();
  NegotiationRequiresAStartedOpenRoute();
  NegotiationBoundsAndFailuresProduceNoAnswer();
  AnswerIsRefusedWhenTheRouteClosedMidNegotiation();
  OverlappingNegotiationIsRefusedNotQueued();
  DataPayloadsAreBoundedAndGenerationFenced();
  ProductionStyleLocalIceUsesTheOutboundEmitter();
  QualityTargetsAreGenerationFenced();

  if (g_failures != 0) {
    std::fprintf(stderr, "%d transport counterfactual failure(s)\n",
                 g_failures);
    return EXIT_FAILURE;
  }
  std::printf("macos transport session adapter counterfactual ok\n");
  return EXIT_SUCCESS;
}
