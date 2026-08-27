#include "macos_host_command_dispatch.h"

namespace imcodes::remote_desktop::macos {
namespace {

constexpr char kTerminalCapabilityUnavailable[] = "capability_unavailable";
constexpr char kTerminalPeerFailed[] = "peer_failed";
constexpr char kTerminalProtocolError[] = "protocol_error";
constexpr char kTerminalStoppedByController[] = "stopped_by_controller";

HostCommandResult EmissionFailure() {
  return {HostCommandDisposition::kTerminate, kDiagMessageEmissionFailed};
}

HostCommandResult Rejected(const rd::Authority& authority,
                           std::string_view terminal_reason,
                           HostCommandSessionSeam* session,
                           HostCommandMessageSink* sink) {
  if (session != nullptr) (void)session->Stop(authority);
  if (sink == nullptr || !sink->EmitTerminal(authority, terminal_reason)) {
    return EmissionFailure();
  }
  return {HostCommandDisposition::kTerminate, kDiagCommandRejected};
}

}  // namespace

HostCommandResult DispatchHostCommand(
    const rd::Signal& signal,
    std::int64_t now_unix_ms,
    std::int64_t now_monotonic_ms,
    HostCommandSessionSeam* session,
    HostCommandDisclosureSeam* disclosure,
    HostCommandMessageSink* sink) {
  if (session == nullptr || sink == nullptr || now_unix_ms < 0 ||
      now_monotonic_ms < 0) {
    return {HostCommandDisposition::kTerminate, kDiagMalformedCommand};
  }

  if (signal.kind == rd::Signal::Kind::kStop) {
    if (!session->Stop(signal.authority)) {
      return {HostCommandDisposition::kTerminate, kDiagCommandRejected};
    }
    if (!sink->EmitTerminal(signal.authority,
                            kTerminalStoppedByController)) {
      return EmissionFailure();
    }
    return {HostCommandDisposition::kTerminate, {}};
  }

  // Every remaining command either creates or mutates a live route. The
  // separate signed disclosure must still be visible at the exact dispatch
  // boundary; a readiness result sampled earlier is not sufficient.
  if (disclosure == nullptr || !disclosure->route_admissible()) {
    return Rejected(signal.authority, kTerminalCapabilityUnavailable, session,
                    sink);
  }

  switch (signal.kind) {
    case rd::Signal::Kind::kPrepare:
      if (!session->Prepare(signal.authority, now_unix_ms,
                            now_monotonic_ms)) {
        return Rejected(signal.authority, kTerminalCapabilityUnavailable,
                        session, sink);
      }
      if (!sink->EmitInitialMode(signal.authority)) return EmissionFailure();
      return {HostCommandDisposition::kContinue, {}};

    case rd::Signal::Kind::kOffer: {
      std::string answer;
      if (!session->NegotiateOffer(signal.authority, signal.sdp, &answer) ||
          answer.empty()) {
        return Rejected(signal.authority, kTerminalPeerFailed, session, sink);
      }
      if (!sink->EmitAnswer(signal.authority, answer)) {
        return EmissionFailure();
      }
      return {HostCommandDisposition::kContinue, {}};
    }

    case rd::Signal::Kind::kIce:
      if (!session->AddRemoteIce(signal.authority, signal.mid,
                                 signal.candidate)) {
        return Rejected(signal.authority, kTerminalProtocolError, session,
                        sink);
      }
      return {HostCommandDisposition::kContinue, {}};

    case rd::Signal::Kind::kLease:
      if (!session->RenewLease(signal.authority, now_unix_ms,
                               now_monotonic_ms)) {
        return Rejected(signal.authority, kTerminalProtocolError, session,
                        sink);
      }
      return {HostCommandDisposition::kContinue, {}};

    case rd::Signal::Kind::kMode:
      if (!session->SetMode(signal.authority, signal.reason, now_unix_ms,
                            now_monotonic_ms)) {
        return Rejected(signal.authority, kTerminalProtocolError, session,
                        sink);
      }
      if (!sink->EmitModeState(signal.authority, signal.reason)) {
        return EmissionFailure();
      }
      return {HostCommandDisposition::kContinue, {}};

    case rd::Signal::Kind::kStop:
      break;
  }
  return {HostCommandDisposition::kTerminate, kDiagMalformedCommand};
}

}  // namespace imcodes::remote_desktop::macos
