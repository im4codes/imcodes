// Counterexamples for the resident agent's control-socket grammar.
//
// This is the frame a route worker, a readiness probe and the Node daemon all
// speak, so it is a security boundary in the same sense the grant line is. It
// is proven here with no socket, no agent, no helper and no display.

#include "macos_virtual_display_control_protocol.h"

#include <cassert>
#include <cstdio>
#include <string>

namespace rd = imcodes::remote_desktop::macos;

namespace {

rd::VirtualDisplayControlRequest Ready() {
  rd::VirtualDisplayControlRequest request;
  request.verb = rd::VirtualDisplayControlVerb::kReady;
  request.nonce = 0x0123456789ABCDEFULL;
  return request;
}

rd::VirtualDisplayControlRequest Route() {
  rd::VirtualDisplayControlRequest request;
  request.verb = rd::VirtualDisplayControlVerb::kRoute;
  request.route_generation = 7;
  return request;
}

rd::VirtualDisplayControlRequest Relay(rd::VirtualDisplayHelperVerb verb) {
  rd::VirtualDisplayControlRequest request;
  request.verb = rd::VirtualDisplayControlVerb::kRelay;
  request.route_generation = 7;
  request.route_epoch = 0xFEEDFACEULL;
  request.route_cookie = 0xC00C1EULL;
  request.request_index = 3;
  request.helper_verb = verb;
  if (verb == rd::VirtualDisplayHelperVerb::kEnable) {
    request.display_id = 42;
    request.pixels_wide = 1920;
    request.pixels_high = 1080;
    request.refresh_millihertz = 60'000;
    request.scale_percent = 200;
  } else if (verb == rd::VirtualDisplayHelperVerb::kDisable) {
    request.display_id = 42;
  }
  return request;
}

std::string ReplaceField(const std::string& line, const char* key,
                         const std::string& value) {
  const std::size_t at = line.find(key);
  assert(at != std::string::npos);  // a typo'd key would silently test nothing
  const std::size_t end = line.find(' ', at);
  return line.substr(0, at) + key + value
      + (end == std::string::npos ? "" : line.substr(end));
}

// Every verb must survive the crossing unchanged, and the wire form must be
// closed: re-serialising a parsed frame reproduces the input byte for byte.
void RoundTripsAndIsCanonical() {
  for (const auto& request : {Ready(), Route(),
                              Relay(rd::VirtualDisplayHelperVerb::kHold),
                              Relay(rd::VirtualDisplayHelperVerb::kStatus),
                              Relay(rd::VirtualDisplayHelperVerb::kDisable),
                              Relay(rd::VirtualDisplayHelperVerb::kEnable)}) {
    const std::string line = rd::SerializeVirtualDisplayControlRequest(request);
    assert(!line.empty());
    assert(line.rfind("ctl1 ", 0) == 0);
    rd::VirtualDisplayControlRequest parsed;
    std::string error;
    assert(rd::ParseVirtualDisplayControlRequest(line, &parsed, &error));
    assert(rd::SerializeVirtualDisplayControlRequest(parsed) == line);
    assert(parsed.verb == request.verb);
    assert(parsed.helper_verb == request.helper_verb);
    assert(parsed.nonce == request.nonce);
    assert(parsed.route_generation == request.route_generation);
    assert(parsed.route_cookie == request.route_cookie);
    assert(parsed.request_index == request.request_index);
    assert(parsed.pixels_wide == request.pixels_wide);
    assert(parsed.scale_percent == request.scale_percent);
  }
}

// A route may NOT ask for release. The helper's lifetime is the display's
// lifetime and it belongs to the resident agent; a route that could release it
// would take the display away from every other route, and from the next one.
void AReleaseIsNotSomethingARouteMayAskFor() {
  const rd::VirtualDisplayControlRequest request =
      Relay(rd::VirtualDisplayHelperVerb::kRelease);
  assert(!request.IsValid());
  // Unrepresentable, not merely refused on receipt: the serializer will not
  // emit it, so no honest producer can even put it on the wire.
  assert(rd::SerializeVirtualDisplayControlRequest(request).empty());

  // And forging one by hand is refused by the parser.
  const std::string enable = rd::SerializeVirtualDisplayControlRequest(
      Relay(rd::VirtualDisplayHelperVerb::kEnable));
  rd::VirtualDisplayControlRequest parsed;
  std::string error;
  assert(!rd::ParseVirtualDisplayControlRequest(
      ReplaceField(enable, "op=", "release"), &parsed, &error));
}

// Credentials belong to exactly one verb. A `ready` frame carrying a route
// cookie is a frame whose author is confused about which question they asked,
// and honouring the parts we understood is how a half-applied request becomes
// an action nobody described.
void CredentialsDoNotLeakAcrossVerbs() {
  rd::VirtualDisplayControlRequest ready = Ready();
  ready.route_cookie = 99;
  assert(!ready.IsValid());
  assert(rd::SerializeVirtualDisplayControlRequest(ready).empty());

  rd::VirtualDisplayControlRequest route = Route();
  route.route_epoch = 1;
  assert(!route.IsValid());

  // A relay with no credential at all is the interesting direction: it is what
  // an unauthenticated peer would send.
  {
    rd::VirtualDisplayControlRequest relay =
        Relay(rd::VirtualDisplayHelperVerb::kStatus);
    relay.route_epoch = 0;
    assert(!relay.IsValid());
  }
  {
    rd::VirtualDisplayControlRequest relay =
        Relay(rd::VirtualDisplayHelperVerb::kStatus);
    relay.route_cookie = 0;
    assert(!relay.IsValid());
  }
  {
    rd::VirtualDisplayControlRequest relay =
        Relay(rd::VirtualDisplayHelperVerb::kStatus);
    // Index zero cannot advance past a floor of zero, so it can never be
    // admitted; refusing it here keeps "sent but silently ignored" impossible.
    relay.request_index = 0;
    assert(!relay.IsValid());
  }
  {
    rd::VirtualDisplayControlRequest relay =
        Relay(rd::VirtualDisplayHelperVerb::kStatus);
    relay.route_generation = 0;
    assert(!relay.IsValid());
  }
}

// Mode parameters belong to kEnable and nothing else. Carrying them elsewhere
// means the peer described an action the agent will not take, and silently
// dropping that description is how a mode selection is lost without anyone
// being told.
void ModeParametersBelongOnlyToEnable() {
  for (const auto verb : {rd::VirtualDisplayHelperVerb::kHold,
                          rd::VirtualDisplayHelperVerb::kStatus,
                          rd::VirtualDisplayHelperVerb::kDisable}) {
    rd::VirtualDisplayControlRequest relay = Relay(verb);
    relay.pixels_wide = 1920;
    assert(!relay.IsValid());
    relay = Relay(verb);
    relay.scale_percent = 100;
    assert(!relay.IsValid());
  }
  // hold and status address no display; disable must name one.
  for (const auto verb : {rd::VirtualDisplayHelperVerb::kHold,
                          rd::VirtualDisplayHelperVerb::kStatus}) {
    rd::VirtualDisplayControlRequest relay = Relay(verb);
    relay.display_id = 5;
    assert(!relay.IsValid());
  }
  {
    rd::VirtualDisplayControlRequest relay =
        Relay(rd::VirtualDisplayHelperVerb::kDisable);
    relay.display_id = 0;
    assert(!relay.IsValid());
  }
  // Enable needs every mode field, and each is separately required, so no one
  // of them can be carrying the others.
  {
    for (int which = 0; which < 5; ++which) {
      rd::VirtualDisplayControlRequest relay =
          Relay(rd::VirtualDisplayHelperVerb::kEnable);
      switch (which) {
        case 0: relay.display_id = 0; break;
        case 1: relay.pixels_wide = 0; break;
        case 2: relay.pixels_high = 0; break;
        case 3: relay.refresh_millihertz = 0; break;
        default: relay.scale_percent = 0; break;
      }
      assert(!relay.IsValid());
    }
  }
  // Bounds mirror the helper's own, so a route learns its request was refused
  // instead of watching it vanish at the next hop.
  for (int which = 0; which < 4; ++which) {
    rd::VirtualDisplayControlRequest relay =
        Relay(rd::VirtualDisplayHelperVerb::kEnable);
    switch (which) {
      case 0: relay.pixels_wide = 16'385; break;
      case 1: relay.pixels_high = 16'385; break;
      case 2: relay.refresh_millihertz = 240'001; break;
      default: relay.scale_percent = 401; break;
    }
    assert(!relay.IsValid());
  }
}

void MalformedFramesAreRefused() {
  const std::string good = rd::SerializeVirtualDisplayControlRequest(Ready());
  rd::VirtualDisplayControlRequest parsed;
  std::string error;

  assert(!rd::ParseVirtualDisplayControlRequest("", &parsed, &error));
  assert(error == "control_frame_unusable");
  assert(!rd::ParseVirtualDisplayControlRequest(
      std::string(rd::kVirtualDisplayControlMaxBytes + 1, 'x'), &parsed, &error));
  assert(error == "control_frame_unusable");

  // Wrong prefix, including a grant frame: a control parser must not quietly
  // make sense of the other top-level frame type.
  assert(!rd::ParseVirtualDisplayControlRequest("ctl2 verb=ready nonce=1",
                                                &parsed, &error));
  assert(error == "control_prefix_unknown");
  assert(!rd::ParseVirtualDisplayControlRequest("grant1 uid=501", &parsed,
                                                &error));
  assert(error == "control_prefix_unknown");

  // Unknown key, unknown verb, unstructured token, duplicate key.
  assert(!rd::ParseVirtualDisplayControlRequest(good + " future=1", &parsed,
                                                &error));
  assert(error == "control_unknown_key");
  assert(!rd::ParseVirtualDisplayControlRequest(
      ReplaceField(good, "verb=", "destroy"), &parsed, &error));
  assert(error == "control_verb_unknown");
  assert(!rd::ParseVirtualDisplayControlRequest(good + " stray", &parsed,
                                                &error));
  assert(error == "control_token_unstructured");
  assert(!rd::ParseVirtualDisplayControlRequest(good + " nonce=2", &parsed,
                                                &error));
  assert(error == "control_field_malformed");

  // No verb at all.
  assert(!rd::ParseVirtualDisplayControlRequest("ctl1 nonce=1", &parsed,
                                                &error));
  assert(error == "control_field_missing");

  // Leading zeros make two spellings of one value, which would break the
  // closure the same way a reordered key would.
  assert(!rd::ParseVirtualDisplayControlRequest(
      ReplaceField(good, "nonce=", "007"), &parsed, &error));
  assert(error == "control_field_malformed");

  // Reordered keys are a second line naming one request.
  assert(!rd::ParseVirtualDisplayControlRequest("ctl1 nonce=1 verb=ready",
                                                &parsed, &error));
  assert(error == "control_not_canonical");

  // At most one line terminator, for the same reason the grant bounds it.
  for (const char* suffix : {"", "\n", "\r", "\r\n"}) {
    assert(rd::ParseVirtualDisplayControlRequest(good + suffix, &parsed, &error));
  }
  for (const char* suffix : {"\n\n", "\r\n\r\n", "\n\r"}) {
    assert(!rd::ParseVirtualDisplayControlRequest(good + suffix, &parsed, &error));
    assert(error == "control_frame_unusable");
  }
}

// A refusal must not also carry a capability: a peer that reads the fields
// before the verdict would find a usable one.
void ARefusedReplyCarriesNothingUsable() {
  rd::VirtualDisplayControlReply reply;
  reply.ok = false;
  reply.error = "route_not_admitted";
  assert(reply.IsValid());
  assert(!rd::SerializeVirtualDisplayControlReply(reply).empty());

  for (int which = 0; which < 6; ++which) {
    rd::VirtualDisplayControlReply hostile;
    hostile.ok = false;
    hostile.error = "route_not_admitted";
    switch (which) {
      case 0: hostile.route_epoch = 1; break;
      case 1: hostile.cookie_seed = 1; break;
      case 2: hostile.uid = 501; break;
      case 3: hostile.qualified_to_create = true; break;
      case 4: hostile.display_control_admitted = true; break;
      default: hostile.admitted = true; break;
    }
    assert(!hostile.IsValid());
    assert(rd::SerializeVirtualDisplayControlReply(hostile).empty());
  }

  // An ok reply may not carry an error, and a refusal must name one.
  {
    rd::VirtualDisplayControlReply hostile;
    hostile.ok = true;
    hostile.error = "something";
    assert(!hostile.IsValid());
  }
  {
    rd::VirtualDisplayControlReply hostile;
    hostile.ok = false;
    assert(!hostile.IsValid());
  }
  // Free text is refused: it is both a parsing hazard on a whitespace-delimited
  // wire and a way to leak agent detail to a peer that only needed "no".
  {
    rd::VirtualDisplayControlReply hostile;
    hostile.ok = false;
    hostile.error = "not a token";
    assert(!hostile.IsValid());
  }
}

void RepliesRoundTripAndAreCanonical() {
  rd::VirtualDisplayControlReply route;
  route.ok = true;
  route.route_generation = 7;
  route.route_epoch = 0xFEEDFACEULL;
  route.cookie_seed = 0xC0FFEEULL;
  route.uid = 501;

  rd::VirtualDisplayControlReply ready;
  ready.ok = true;
  ready.nonce = 0x0123456789ABCDEFULL;
  ready.qualified_to_create = true;
  ready.display_control_admitted = false;

  rd::VirtualDisplayControlReply relay;
  relay.ok = true;
  relay.display_id = 42;
  relay.admitted = true;
  relay.presence = "active";

  rd::VirtualDisplayControlReply refused;
  refused.ok = false;
  refused.error = "route_epoch_mismatch";

  for (const auto& original : {route, ready, relay, refused}) {
    const std::string line = rd::SerializeVirtualDisplayControlReply(original);
    assert(!line.empty());
    assert(line.rfind("ctl1r ", 0) == 0);
    rd::VirtualDisplayControlReply parsed;
    std::string error;
    assert(rd::ParseVirtualDisplayControlReply(line, &parsed, &error));
    assert(rd::SerializeVirtualDisplayControlReply(parsed) == line);
    assert(parsed.ok == original.ok);
    assert(parsed.error == original.error);
    assert(parsed.nonce == original.nonce);
    assert(parsed.route_epoch == original.route_epoch);
    assert(parsed.cookie_seed == original.cookie_seed);
    assert(parsed.display_id == original.display_id);
    assert(parsed.admitted == original.admitted);
    assert(parsed.presence == original.presence);
  }

  // Presence is a closed set: "probably active" is not an answer.
  rd::VirtualDisplayControlReply hostile = relay;
  hostile.presence = "maybe";
  assert(!hostile.IsValid());
  const std::string line = rd::SerializeVirtualDisplayControlReply(relay);
  rd::VirtualDisplayControlReply parsed;
  std::string error;
  assert(!rd::ParseVirtualDisplayControlReply(
      ReplaceField(line, "presence=", "maybe"), &parsed, &error));
}

// The frame classifier must decide WHICH top-level frame it holds without
// interpreting it: the server has to know who is allowed to send something
// before it does any work on that something's behalf.
void FramesAreClassifiedWithoutBeingParsed() {
  assert(rd::ClassifyVirtualDisplayControlFrame("grant1 uid=501 asid=2") ==
         rd::VirtualDisplayControlFrame::kGrant);
  assert(rd::ClassifyVirtualDisplayControlFrame("ctl1 verb=ready nonce=1") ==
         rd::VirtualDisplayControlFrame::kControl);
  // Deliberately classified, though neither would survive its own parser: the
  // classifier's job is routing, and refusing to route an unparseable frame
  // would mean parsing it first.
  assert(rd::ClassifyVirtualDisplayControlFrame("grant1 nonsense") ==
         rd::VirtualDisplayControlFrame::kGrant);
  assert(rd::ClassifyVirtualDisplayControlFrame("ctl1 nonsense") ==
         rd::VirtualDisplayControlFrame::kControl);
  // A prefix without its separating space is not that prefix.
  assert(rd::ClassifyVirtualDisplayControlFrame("grant1") ==
         rd::VirtualDisplayControlFrame::kUnknown);
  assert(rd::ClassifyVirtualDisplayControlFrame("ctl1") ==
         rd::VirtualDisplayControlFrame::kUnknown);
  assert(rd::ClassifyVirtualDisplayControlFrame("ctl1r ok=1") ==
         rd::VirtualDisplayControlFrame::kUnknown);
  assert(rd::ClassifyVirtualDisplayControlFrame("") ==
         rd::VirtualDisplayControlFrame::kUnknown);
}

}  // namespace

int main() {
  RoundTripsAndIsCanonical();
  AReleaseIsNotSomethingARouteMayAskFor();
  CredentialsDoNotLeakAcrossVerbs();
  ModeParametersBelongOnlyToEnable();
  MalformedFramesAreRefused();
  ARefusedReplyCarriesNothingUsable();
  RepliesRoundTripAndAreCanonical();
  FramesAreClassifiedWithoutBeingParsed();
  std::printf("macos virtual display control counterfactual ok\n");
  return 0;
}
