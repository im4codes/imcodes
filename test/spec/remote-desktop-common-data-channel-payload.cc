// Counterfactuals for the browser-created DataChannel payload parser.
//
// Every case below is a shape the browser could actually send, or that a
// compromised peer could send instead. The parser is the only thing between
// that peer and the input injectors, so "ignored" is never an acceptable
// outcome for an unexpected member.

#include <cstdio>
#include <cstdlib>
#include <string>

#include "data_channel_payload.h"

namespace rd = imcodes::rd;

namespace {

int g_failures = 0;

void Check(bool condition, const char* label) {
  if (condition)
    return;
  std::fprintf(stderr, "FAIL %s\n", label);
  ++g_failures;
}

std::string Correlation() {
  return R"("protocolVersion":2,"sessionId":"session_1","sequence":7,)"
         R"("layoutRevision":3,"inputEpoch":5)";
}

bool Accepts(const std::string& json, rd::DataChannelMessage* out) {
  return rd::ParseDataChannelMessage(json, out);
}

bool Rejects(const std::string& json) {
  rd::DataChannelMessage message;
  return !rd::ParseDataChannelMessage(json, &message);
}

void PointerMoveRequiresBothCoordinatesAndNothingElse() {
  rd::DataChannelMessage message;
  Check(Accepts(R"({"type":"remote_desktop.data.pointer",)" + Correlation() +
                    R"(,"kind":"move","x":0.25,"y":0.5})",
                &message),
        "a well-formed move is accepted");
  Check(message.kind == rd::DataChannelMessageKind::kPointer,
        "a move parses as a pointer message");
  Check(message.correlation.session_id == "session_1" &&
            message.correlation.sequence == 7 &&
            message.correlation.layout_revision == 3 &&
            message.correlation.input_epoch == 5,
        "correlation is carried through exactly");
  Check(message.pointer.x.has_value() && message.pointer.y.has_value(),
        "a move carries both coordinates");

  Check(Rejects(R"({"type":"remote_desktop.data.pointer",)" + Correlation() +
                R"(,"kind":"move","x":0.25})"),
        "a move without y is refused");
  Check(Rejects(R"({"type":"remote_desktop.data.pointer",)" + Correlation() +
                R"(,"kind":"move","x":1.5,"y":0.5})"),
        "an out-of-range coordinate is refused");
  // A button on a move is not a harmless extra: it is a click the validator
  // never authorized.
  Check(Rejects(R"({"type":"remote_desktop.data.pointer",)" + Correlation() +
                R"(,"kind":"move","x":0.25,"y":0.5,"button":"left"})"),
        "a button on a move is refused");
  Check(Rejects(R"({"type":"remote_desktop.data.pointer",)" + Correlation() +
                R"(,"kind":"move","x":0.25,"y":0.5,"deltaX":1})"),
        "a wheel delta on a move is refused");
  // Epoch zero is the absence of a route. Injecting under it would mean
  // injecting outside every lease the session ever granted, so each injecting
  // arm has to refuse it in its own right.
  Check(Rejects(R"({"type":"remote_desktop.data.pointer",)"
                R"("protocolVersion":2,"sessionId":"s","sequence":1,)"
                R"("layoutRevision":1,"inputEpoch":0,"kind":"move",)"
                R"("x":0.5,"y":0.5})"),
        "a pointer under a zero input epoch is refused");
  Check(Rejects(R"({"type":"remote_desktop.data.keyboard",)"
                R"("protocolVersion":2,"sessionId":"s","sequence":1,)"
                R"("layoutRevision":1,"inputEpoch":0,"kind":"text",)"
                R"("text":"a"})"),
        "a keyboard commit under a zero input epoch is refused");
}

void PointerButtonAndWheelAreConstrainedByKind() {
  rd::DataChannelMessage message;
  Check(Accepts(R"({"type":"remote_desktop.data.pointer",)" + Correlation() +
                    R"(,"kind":"button_down","button":"right"})",
                &message),
        "a button press without coordinates is accepted");
  Check(message.pointer.button.has_value() &&
            *message.pointer.button == rd::PointerButton::kRight,
        "the exact button is carried");

  Check(Rejects(R"({"type":"remote_desktop.data.pointer",)" + Correlation() +
                R"(,"kind":"button_down","button":"thumb"})"),
        "an unknown button is refused");
  Check(Rejects(R"({"type":"remote_desktop.data.pointer",)" + Correlation() +
                R"(,"kind":"button_down"})"),
        "a button press without a button is refused");

  Check(Accepts(R"({"type":"remote_desktop.data.pointer",)" + Correlation() +
                    R"(,"kind":"wheel","deltaX":-12.5,"deltaY":40})",
                &message),
        "a bounded wheel is accepted");
  Check(Rejects(R"({"type":"remote_desktop.data.pointer",)" + Correlation() +
                R"(,"kind":"wheel","deltaX":100000,"deltaY":0})"),
        "an unbounded wheel delta is refused");
  Check(Rejects(R"({"type":"remote_desktop.data.pointer",)" + Correlation() +
                R"(,"kind":"wheel","deltaX":1,"deltaY":1,"button":"left"})"),
        "a button on a wheel is refused");
}

void KeyboardTextAndKeysAreMutuallyExclusive() {
  rd::DataChannelMessage message;
  Check(Accepts(R"({"type":"remote_desktop.data.keyboard",)" + Correlation() +
                    R"(,"kind":"key_down","code":"KeyA","key":"a",)"
                    R"("repeat":false})",
                &message),
        "a well-formed key press is accepted");
  Check(message.keyboard.repeat.has_value() && !*message.keyboard.repeat,
        "repeat is carried through");

  Check(Rejects(R"({"type":"remote_desktop.data.keyboard",)" + Correlation() +
                R"(,"kind":"key_down","code":"KeyA","key":"a"})"),
        "a key press without repeat is refused");
  // Text and key fields together would let one message be replayed as both.
  Check(Rejects(R"({"type":"remote_desktop.data.keyboard",)" + Correlation() +
                R"(,"kind":"key_down","code":"KeyA","key":"a",)"
                R"("repeat":false,"text":"a"})"),
        "text alongside a key press is refused");
  Check(Accepts(R"({"type":"remote_desktop.data.keyboard",)" + Correlation() +
                    R"(,"kind":"text","text":"hello"})",
                &message),
        "a text commit is accepted");
  Check(Rejects(R"({"type":"remote_desktop.data.keyboard",)" + Correlation() +
                R"(,"kind":"text","text":"hello","repeat":true})"),
        "repeat on a text commit is refused");
}

void CorrelationIsMandatoryAndBounded() {
  Check(Rejects(R"({"type":"remote_desktop.data.release_all",)"
                R"("protocolVersion":1,"sessionId":"s","sequence":1,)"
                R"("layoutRevision":1,"inputEpoch":1})"),
        "a wrong protocol version is refused");
  // Epoch zero is the absence of a route, not a route numbered zero.
  Check(Rejects(R"({"type":"remote_desktop.data.release_all",)"
                R"("protocolVersion":2,"sessionId":"s","sequence":1,)"
                R"("layoutRevision":1,"inputEpoch":0})"),
        "a zero input epoch is refused");
  Check(Rejects(R"({"type":"remote_desktop.data.release_all",)"
                R"("protocolVersion":2,"sessionId":"","sequence":1,)"
                R"("layoutRevision":1,"inputEpoch":1})"),
        "an empty session id is refused");
  Check(Rejects(R"({"type":"remote_desktop.data.release_all",)"
                R"("protocolVersion":2,"sessionId":"s","sequence":-1,)"
                R"("layoutRevision":1,"inputEpoch":1})"),
        "a negative sequence is refused");
  Check(Rejects(R"({"type":"remote_desktop.data.release_all",)"
                R"("protocolVersion":2,"sessionId":"s","sequence":1.5,)"
                R"("layoutRevision":1,"inputEpoch":1})"),
        "a fractional sequence is refused");
  // Past 2^53 a JSON integer is no longer exact, so it cannot be trusted as a
  // replay guard.
  Check(Rejects(R"({"type":"remote_desktop.data.release_all",)"
                R"("protocolVersion":2,"sessionId":"s",)"
                R"("sequence":9007199254740993,"layoutRevision":1,)"
                R"("inputEpoch":1})"),
        "a sequence past exact integer range is refused");

  rd::DataChannelMessage message;
  Check(Accepts(R"({"type":"remote_desktop.data.release_all",)" +
                    Correlation() + R"(})",
                &message),
        "a well-formed release_all is accepted");
  Check(message.kind == rd::DataChannelMessageKind::kReleaseAll,
        "release_all parses as release_all");
  Check(Rejects(R"({"type":"remote_desktop.data.release_all",)" +
                Correlation() + R"(,"kind":"move"})"),
        "release_all carries no kind");
}

void StructuralAbuseIsRefusedNotIgnored() {
  Check(Rejects(R"({"type":"remote_desktop.data.release_all",)" +
                Correlation() + R"(,"extra":1})"),
        "an unknown member is refused, not ignored");
  Check(Rejects(R"({"type":"remote_desktop.data.release_all",)" +
                Correlation() + R"(,"sequence":9})"),
        "a duplicate member is refused");
  Check(Rejects(R"({"type":"remote_desktop.data.release_all",)" +
                Correlation() + R"(,"nested":{"a":1}})"),
        "a nested object is refused");
  Check(Rejects(R"({"type":"remote_desktop.data.release_all",)" +
                Correlation() + R"(,"list":[1]})"),
        "an array is refused");
  Check(Rejects(R"({"type":"remote_desktop.data.release_all",)" +
                Correlation() + R"(,"missing":null})"),
        "a null is refused");
  Check(Rejects(R"({"type":"remote_desktop.data.release_all",)" +
                Correlation() + R"(}) trailing"),
        "a trailing byte is refused");
  Check(Rejects("{"), "a truncated object is refused");
  Check(Rejects(""), "an empty payload is refused");
  Check(Rejects(std::string("{\"type\":\"remote_desktop.data.release_all\",")
                + std::string(rd::kMaxDataMessageBytes, 'a') + "}"),
        "an oversized payload is refused");
  // Worker-to-browser types must never be accepted as input.
  Check(Rejects(R"({"type":"remote_desktop.data.control_rejected",)" +
                Correlation() + R"(})"),
        "a worker-to-browser type is refused on the input path");
}

void ControlCarriesTypedOptionalOperations() {
  rd::DataChannelMessage message;
  Check(Accepts(R"({"type":"remote_desktop.data.control",)" + Correlation() +
                    R"(,"kind":"set_display_mode","displayId":"d1",)"
                    R"("width":1920,"height":1080})",
                &message),
        "a display mode command is accepted");
  Check(message.kind == rd::DataChannelMessageKind::kControl,
        "control parses as control");
  Check(message.control.kind == "set_display_mode",
        "the exact control kind token is preserved");
  Check(message.control.width.has_value() && *message.control.width == 1920,
        "typed width is carried");
  Check(Rejects(R"({"type":"remote_desktop.data.control",)" + Correlation() +
                R"(,"kind":"set_display_mode","displayId":"d1",)"
                R"("width":-1,"height":1080})"),
        "a negative width is refused");
  Check(Rejects(R"({"type":"remote_desktop.data.control",)" + Correlation() +
                R"(,"kind":"set_display_mode","displayId":"d1",)"
                R"("width":1920,"height":1080,"unknown":1})"),
        "an unknown control member is refused");
  Check(Rejects(R"({"type":"remote_desktop.data.control",)" + Correlation() +
                R"(,"kind":"set_display_mode","displayId":"d1",)"
                R"("width":320,"height":240})"),
        "a display mode below the shared lower bound is refused");
  Check(Rejects(R"({"type":"remote_desktop.data.control",)" + Correlation() +
                R"(,"kind":"hello","displayId":"d1"})"),
        "hello cannot smuggle a display operation");
  Check(Rejects(R"({"type":"remote_desktop.data.control",)" + Correlation() +
                R"(,"kind":"set_display_scale","displayId":"d1",)"
                R"("dpiScalePercent":130})"),
        "display scale is restricted to the shared closed set");
  Check(Accepts(R"({"type":"remote_desktop.data.control",)" + Correlation() +
                    R"(,"kind":"frame_presented","displayId":"d1",)"
                    R"("frameWidth":1920,"frameHeight":1080})",
                &message),
        "a bounded frame acknowledgement is accepted");
  Check(Rejects(R"({"type":"remote_desktop.data.control",)" + Correlation() +
                R"(,"kind":"future_control"})"),
        "an unknown control kind is refused rather than preserved");
}

}  // namespace

int main() {
  PointerMoveRequiresBothCoordinatesAndNothingElse();
  PointerButtonAndWheelAreConstrainedByKind();
  KeyboardTextAndKeysAreMutuallyExclusive();
  CorrelationIsMandatoryAndBounded();
  StructuralAbuseIsRefusedNotIgnored();
  ControlCarriesTypedOptionalOperations();

  if (g_failures != 0) {
    std::fprintf(stderr, "%d data-channel payload failure(s)\n", g_failures);
    return EXIT_FAILURE;
  }
  std::printf("remote-desktop common data channel payload counterfactual ok\n");
  return EXIT_SUCCESS;
}
