#include "macos_host_command_dispatch.h"

namespace imcodes::remote_desktop::macos {
namespace {

constexpr char kTerminalCapabilityUnavailable[] = "capability_unavailable";
constexpr char kTerminalPeerFailed[] = "peer_failed";
constexpr char kTerminalProtocolError[] = "protocol_error";
constexpr char kTerminalStoppedByController[] = "stopped_by_controller";
constexpr char kTerminalSessionLimit[] = "session_limit";

HostCommandResult EmissionFailure() {
  return {HostCommandDisposition::kTerminate, kDiagMessageEmissionFailed};
}

// The worker ends with its last route; while other viewers remain it serves
// them.
HostCommandDisposition AfterRouteEnded(const HostCommandSessionSeam* session) {
  return session != nullptr && session->live_routes() > 0
             ? HostCommandDisposition::kContinue
             : HostCommandDisposition::kTerminate;
}

HostCommandResult Rejected(const rd::Authority& authority,
                           std::string_view terminal_reason,
                           HostCommandSessionSeam* session,
                           HostCommandMessageSink* sink) {
  if (session != nullptr) (void)session->Stop(authority);
  if (sink == nullptr || !sink->EmitTerminal(authority, terminal_reason)) {
    return EmissionFailure();
  }
  return {AfterRouteEnded(session), kDiagCommandRejected};
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

  // Several viewers share this worker. A command for a route it does not
  // serve -- a late one for a route that already ended -- is dropped while
  // other routes live: answering it by ending the worker would take every
  // other viewer down with it. A new viewer's PREPARE opens a route, up to
  // the cap every worker shares.
  if (!session->Serves(signal.authority) && session->live_routes() > 0) {
    if (signal.kind != rd::Signal::Kind::kPrepare) {
      return {HostCommandDisposition::kContinue, kDiagCommandRejected};
    }
    if (session->live_routes() >= session->max_routes()) {
      if (!sink->EmitTerminal(signal.authority, kTerminalSessionLimit)) {
        return EmissionFailure();
      }
      return {HostCommandDisposition::kContinue, kDiagCommandRejected};
    }
  }

  if (signal.kind == rd::Signal::Kind::kStop) {
    if (!session->Stop(signal.authority)) {
      return {AfterRouteEnded(session), kDiagCommandRejected};
    }
    if (!sink->EmitTerminal(signal.authority,
                            kTerminalStoppedByController)) {
      return EmissionFailure();
    }
    return {AfterRouteEnded(session), {}};
  }

  // PREPARE is the operation that creates a route and synchronously raises its
  // separate signed disclosure. Requiring a visible disclosure before PREPARE
  // would force an idle resident worker to invent a viewer. Every mutation of
  // an existing route still requires the disclosure before dispatch.
  if (signal.kind != rd::Signal::Kind::kPrepare &&
      (disclosure == nullptr || !disclosure->route_admissible())) {
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
      // Prepare may only succeed after the route-owned Show() has received the
      // disclosure process's visible-ready acknowledgement. Re-check here so
      // an implementation that returns success without that proof still fails
      // closed at the exact admission boundary.
      if (disclosure == nullptr || !disclosure->route_admissible()) {
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
