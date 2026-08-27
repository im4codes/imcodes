#include "data_channel_payload.h"

#include <cmath>
#include <cstdlib>
#include <map>
#include <string>
#include <string_view>
#include <vector>

namespace imcodes::rd {
namespace {

/** One scalar member. Nested values are refused, so there is no object arm. */
struct Scalar {
  enum class Type { kString, kNumber, kBool } type = Type::kString;
  std::string text;  // decoded string value
  double number = 0.0;
  bool boolean = false;
};

using Members = std::map<std::string, Scalar>;

void SkipWhitespace(std::string_view text, std::size_t* index) {
  while (*index < text.size()) {
    const char c = text[*index];
    if (c != ' ' && c != '\t' && c != '\n' && c != '\r')
      return;
    ++*index;
  }
}

/**
 * Reads one JSON string.
 *
 * Escapes are restricted to the set the wire actually uses. `\u` is refused
 * rather than decoded: a half-implemented surrogate decoder is a classic source
 * of smuggled control characters, and no field in this contract needs one.
 */
[[nodiscard]] bool ReadString(std::string_view text,
                              std::size_t* index,
                              std::string* out) {
  if (*index >= text.size() || text[*index] != '"')
    return false;
  ++*index;
  out->clear();
  while (*index < text.size()) {
    const char c = text[*index];
    if (c == '"') {
      ++*index;
      return true;
    }
    if (c == '\\') {
      ++*index;
      if (*index >= text.size())
        return false;
      switch (text[*index]) {
        case '"':
          out->push_back('"');
          break;
        case '\\':
          out->push_back('\\');
          break;
        case '/':
          out->push_back('/');
          break;
        case 'b':
          out->push_back('\b');
          break;
        case 'f':
          out->push_back('\f');
          break;
        case 'n':
          out->push_back('\n');
          break;
        case 'r':
          out->push_back('\r');
          break;
        case 't':
          out->push_back('\t');
          break;
        default:
          return false;
      }
      ++*index;
      continue;
    }
    // Raw control characters are not legal JSON and have no use here.
    if (static_cast<unsigned char>(c) < 0x20)
      return false;
    out->push_back(c);
    ++*index;
  }
  return false;
}

[[nodiscard]] bool ReadNumber(std::string_view text,
                              std::size_t* index,
                              double* out) {
  const std::size_t start = *index;
  if (*index < text.size() && text[*index] == '-')
    ++*index;
  bool digits = false;
  while (*index < text.size() && text[*index] >= '0' && text[*index] <= '9') {
    digits = true;
    ++*index;
  }
  if (*index < text.size() && text[*index] == '.') {
    ++*index;
    bool fraction = false;
    while (*index < text.size() && text[*index] >= '0' && text[*index] <= '9') {
      fraction = true;
      ++*index;
    }
    if (!fraction)
      return false;
  }
  if (*index < text.size() && (text[*index] == 'e' || text[*index] == 'E')) {
    ++*index;
    if (*index < text.size() && (text[*index] == '+' || text[*index] == '-')) {
      ++*index;
    }
    bool exponent = false;
    while (*index < text.size() && text[*index] >= '0' && text[*index] <= '9') {
      exponent = true;
      ++*index;
    }
    if (!exponent)
      return false;
  }
  if (!digits)
    return false;
  const std::string literal(text.substr(start, *index - start));
  char* end = nullptr;
  const double parsed = std::strtod(literal.c_str(), &end);
  if (end == nullptr || *end != '\0')
    return false;
  if (!std::isfinite(parsed))
    return false;
  *out = parsed;
  return true;
}

/** Flat object only. A nested object or array is a shape this contract has no
 *  field for, so it is refused rather than skipped. */
[[nodiscard]] bool ParseFlatObject(std::string_view text, Members* out) {
  std::size_t index = 0;
  SkipWhitespace(text, &index);
  if (index >= text.size() || text[index] != '{')
    return false;
  ++index;
  SkipWhitespace(text, &index);
  if (index < text.size() && text[index] == '}') {
    ++index;
    SkipWhitespace(text, &index);
    return index == text.size();
  }
  while (true) {
    SkipWhitespace(text, &index);
    std::string name;
    if (!ReadString(text, &index, &name))
      return false;
    // A duplicate member means two values for one field; which one wins would
    // depend on parser order, so neither may.
    if (out->find(name) != out->end())
      return false;
    SkipWhitespace(text, &index);
    if (index >= text.size() || text[index] != ':')
      return false;
    ++index;
    SkipWhitespace(text, &index);
    if (index >= text.size())
      return false;

    Scalar scalar;
    const char c = text[index];
    if (c == '"') {
      if (!ReadString(text, &index, &scalar.text))
        return false;
      scalar.type = Scalar::Type::kString;
    } else if (c == 't' || c == 'f') {
      const std::string_view rest = text.substr(index);
      if (rest.rfind("true", 0) == 0) {
        scalar.boolean = true;
        index += 4;
      } else if (rest.rfind("false", 0) == 0) {
        scalar.boolean = false;
        index += 5;
      } else {
        return false;
      }
      scalar.type = Scalar::Type::kBool;
    } else if (c == '-' || (c >= '0' && c <= '9')) {
      if (!ReadNumber(text, &index, &scalar.number))
        return false;
      scalar.type = Scalar::Type::kNumber;
    } else {
      // Covers `null`, `{` and `[`: all shapes with no field in this contract.
      return false;
    }
    out->emplace(std::move(name), std::move(scalar));

    SkipWhitespace(text, &index);
    if (index >= text.size())
      return false;
    if (text[index] == ',') {
      ++index;
      continue;
    }
    if (text[index] == '}') {
      ++index;
      break;
    }
    return false;
  }
  SkipWhitespace(text, &index);
  // A trailing byte means the frame was not exactly one object.
  return index == text.size();
}

[[nodiscard]] const Scalar* Find(const Members& members, const char* name) {
  const auto it = members.find(name);
  return it == members.end() ? nullptr : &it->second;
}

[[nodiscard]] bool HasExactKeys(const Members& members,
                                const std::vector<std::string>& required,
                                const std::vector<std::string>& optional) {
  for (const std::string& name : required) {
    if (members.find(name) == members.end())
      return false;
  }
  for (const auto& [name, ignored] : members) {
    (void)ignored;
    bool allowed = false;
    for (const std::string& candidate : required) {
      if (candidate == name) {
        allowed = true;
        break;
      }
    }
    if (!allowed) {
      for (const std::string& candidate : optional) {
        if (candidate == name) {
          allowed = true;
          break;
        }
      }
    }
    // Unknown members are refused, not ignored: an ignored member is one a
    // later consumer can still read.
    if (!allowed)
      return false;
  }
  return true;
}

[[nodiscard]] bool ReadUnsigned(const Scalar* scalar, std::uint64_t* out) {
  if (scalar == nullptr || scalar->type != Scalar::Type::kNumber)
    return false;
  const double value = scalar->number;
  if (value < 0.0)
    return false;
  // Beyond 2^53 an integer is no longer exactly representable, so a value that
  // large did not survive JSON intact and must not be trusted as a sequence.
  if (value > 9007199254740991.0)
    return false;
  if (value != std::floor(value))
    return false;
  *out = static_cast<std::uint64_t>(value);
  return true;
}

[[nodiscard]] bool ReadBoundedString(const Scalar* scalar,
                                     std::size_t max_bytes,
                                     std::string* out) {
  if (scalar == nullptr || scalar->type != Scalar::Type::kString)
    return false;
  if (scalar->text.empty() || scalar->text.size() > max_bytes)
    return false;
  *out = scalar->text;
  return true;
}

[[nodiscard]] bool ReadRange(const Scalar* scalar,
                             double low,
                             double high,
                             double* out) {
  if (scalar == nullptr || scalar->type != Scalar::Type::kNumber)
    return false;
  if (!(scalar->number >= low && scalar->number <= high))
    return false;
  *out = scalar->number;
  return true;
}

[[nodiscard]] bool ReadCorrelation(const Members& members,
                                   InputCorrelation* out) {
  const Scalar* protocol = Find(members, "protocolVersion");
  if (protocol == nullptr || protocol->type != Scalar::Type::kNumber) {
    return false;
  }
  if (protocol->number != static_cast<double>(kDataProtocolVersion)) {
    return false;
  }
  if (!ReadBoundedString(Find(members, "sessionId"), kMaxSessionIdBytes,
                         &out->session_id)) {
    return false;
  }
  if (!ReadUnsigned(Find(members, "sequence"), &out->sequence))
    return false;
  if (!ReadUnsigned(Find(members, "layoutRevision"), &out->layout_revision)) {
    return false;
  }
  if (!ReadUnsigned(Find(members, "inputEpoch"), &out->input_epoch)) {
    return false;
  }
  return true;
}

[[nodiscard]] bool Absent(const Members& members, const char* name) {
  return members.find(name) == members.end();
}

[[nodiscard]] bool ParsePointerKind(const std::string& text, PointerKind* out) {
  if (text == "move") {
    *out = PointerKind::kMove;
    return true;
  }
  if (text == "button_down") {
    *out = PointerKind::kButtonDown;
    return true;
  }
  if (text == "button_up") {
    *out = PointerKind::kButtonUp;
    return true;
  }
  if (text == "button_click") {
    *out = PointerKind::kButtonClick;
    return true;
  }
  if (text == "wheel") {
    *out = PointerKind::kWheel;
    return true;
  }
  return false;
}

[[nodiscard]] bool ParsePointerButton(const std::string& text,
                                      PointerButton* out) {
  if (text == "left") {
    *out = PointerButton::kLeft;
    return true;
  }
  if (text == "middle") {
    *out = PointerButton::kMiddle;
    return true;
  }
  if (text == "right") {
    *out = PointerButton::kRight;
    return true;
  }
  if (text == "back") {
    *out = PointerButton::kBack;
    return true;
  }
  if (text == "forward") {
    *out = PointerButton::kForward;
    return true;
  }
  return false;
}

[[nodiscard]] bool ParseKeyboardKind(const std::string& text,
                                     KeyboardKind* out) {
  if (text == "key_down") {
    *out = KeyboardKind::kKeyDown;
    return true;
  }
  if (text == "key_up") {
    *out = KeyboardKind::kKeyUp;
    return true;
  }
  if (text == "text") {
    *out = KeyboardKind::kText;
    return true;
  }
  return false;
}

[[nodiscard]] bool ReadOptionalNormalized(const Members& members,
                                          const char* name,
                                          std::optional<double>* out) {
  const Scalar* scalar = Find(members, name);
  if (scalar == nullptr)
    return true;
  double value = 0.0;
  if (!ReadRange(scalar, 0.0, 1.0, &value))
    return false;
  *out = value;
  return true;
}

[[nodiscard]] bool ParsePointer(const Members& members,
                                DataChannelMessage* out) {
  if (!HasExactKeys(members,
                    {"type", "protocolVersion", "sessionId", "sequence",
                     "layoutRevision", "inputEpoch", "kind"},
                    {"x", "y", "button", "deltaX", "deltaY"})) {
    return false;
  }
  if (!ReadCorrelation(members, &out->correlation))
    return false;
  // An input epoch of zero is not a route: it is the absence of one.
  if (out->correlation.input_epoch == 0)
    return false;

  std::string kind_text;
  if (!ReadBoundedString(Find(members, "kind"), 32, &kind_text))
    return false;
  if (!ParsePointerKind(kind_text, &out->pointer.kind))
    return false;

  if (out->pointer.kind == PointerKind::kMove) {
    double x = 0.0;
    double y = 0.0;
    if (!ReadRange(Find(members, "x"), 0.0, 1.0, &x))
      return false;
    if (!ReadRange(Find(members, "y"), 0.0, 1.0, &y))
      return false;
    if (!Absent(members, "button") || !Absent(members, "deltaX") ||
        !Absent(members, "deltaY")) {
      return false;
    }
    out->pointer.x = x;
    out->pointer.y = y;
    return true;
  }

  if (out->pointer.kind == PointerKind::kWheel) {
    double delta_x = 0.0;
    double delta_y = 0.0;
    if (!ReadRange(Find(members, "deltaX"), -kMaxWheelDelta, kMaxWheelDelta,
                   &delta_x)) {
      return false;
    }
    if (!ReadRange(Find(members, "deltaY"), -kMaxWheelDelta, kMaxWheelDelta,
                   &delta_y)) {
      return false;
    }
    if (!Absent(members, "button"))
      return false;
    if (!ReadOptionalNormalized(members, "x", &out->pointer.x))
      return false;
    if (!ReadOptionalNormalized(members, "y", &out->pointer.y))
      return false;
    out->pointer.delta_x = delta_x;
    out->pointer.delta_y = delta_y;
    return true;
  }

  std::string button_text;
  if (!ReadBoundedString(Find(members, "button"), 32, &button_text)) {
    return false;
  }
  PointerButton button = PointerButton::kLeft;
  if (!ParsePointerButton(button_text, &button))
    return false;
  if (!Absent(members, "deltaX") || !Absent(members, "deltaY"))
    return false;
  if (!ReadOptionalNormalized(members, "x", &out->pointer.x))
    return false;
  if (!ReadOptionalNormalized(members, "y", &out->pointer.y))
    return false;
  out->pointer.button = button;
  return true;
}

[[nodiscard]] bool ParseKeyboard(const Members& members,
                                 DataChannelMessage* out) {
  if (!HasExactKeys(members,
                    {"type", "protocolVersion", "sessionId", "sequence",
                     "layoutRevision", "inputEpoch", "kind"},
                    {"code", "key", "repeat", "text"})) {
    return false;
  }
  if (!ReadCorrelation(members, &out->correlation))
    return false;
  if (out->correlation.input_epoch == 0)
    return false;

  std::string kind_text;
  if (!ReadBoundedString(Find(members, "kind"), 32, &kind_text))
    return false;
  if (!ParseKeyboardKind(kind_text, &out->keyboard.kind))
    return false;

  if (out->keyboard.kind == KeyboardKind::kText) {
    std::string text;
    if (!ReadBoundedString(Find(members, "text"), kMaxKeyTextBytes, &text)) {
      return false;
    }
    if (!Absent(members, "code") || !Absent(members, "key") ||
        !Absent(members, "repeat")) {
      return false;
    }
    out->keyboard.text = std::move(text);
    return true;
  }

  std::string code;
  std::string key;
  if (!ReadBoundedString(Find(members, "code"), kMaxKeyCodeBytes, &code)) {
    return false;
  }
  if (!ReadBoundedString(Find(members, "key"), kMaxKeyValueBytes, &key)) {
    return false;
  }
  const Scalar* repeat = Find(members, "repeat");
  if (repeat == nullptr || repeat->type != Scalar::Type::kBool)
    return false;
  if (!Absent(members, "text"))
    return false;
  out->keyboard.code = std::move(code);
  out->keyboard.key = std::move(key);
  out->keyboard.repeat = repeat->boolean;
  return true;
}

[[nodiscard]] bool ReadOptionalUnsigned(const Members& members,
                                        const char* name,
                                        std::optional<std::uint64_t>* out) {
  const Scalar* scalar = Find(members, name);
  if (scalar == nullptr)
    return true;
  std::uint64_t value = 0;
  if (!ReadUnsigned(scalar, &value))
    return false;
  *out = value;
  return true;
}

[[nodiscard]] bool ParseControl(const Members& members,
                                DataChannelMessage* out) {
  if (!HasExactKeys(
          members,
          {"type", "protocolVersion", "sessionId", "sequence", "layoutRevision",
           "inputEpoch", "kind"},
          {"displayId", "width", "height", "dpiScalePercent", "requestId",
           "frameWidth", "frameHeight", "acknowledgedSequence"})) {
    return false;
  }
  // Control carries no input epoch requirement beyond correlation: unlike
  // pointer and keyboard it is not an injection, and shared/remote-desktop.ts
  // does not require a positive epoch here either.
  if (!ReadCorrelation(members, &out->correlation))
    return false;

  if (!ReadBoundedString(Find(members, "kind"), 64, &out->control.kind)) {
    return false;
  }

  const Scalar* display = Find(members, "displayId");
  if (display != nullptr) {
    std::string value;
    if (!ReadBoundedString(display, kMaxDisplayIdBytes, &value))
      return false;
    out->control.display_id = std::move(value);
  }
  const Scalar* request = Find(members, "requestId");
  if (request != nullptr) {
    std::string value;
    if (!ReadBoundedString(request, kMaxRequestIdBytes, &value))
      return false;
    out->control.request_id = std::move(value);
  }
  if (!ReadOptionalUnsigned(members, "width", &out->control.width) ||
      !ReadOptionalUnsigned(members, "height", &out->control.height) ||
      !ReadOptionalUnsigned(members, "dpiScalePercent",
                            &out->control.dpi_scale_percent) ||
      !ReadOptionalUnsigned(members, "frameWidth", &out->control.frame_width) ||
      !ReadOptionalUnsigned(members, "frameHeight",
                            &out->control.frame_height) ||
      !ReadOptionalUnsigned(members, "acknowledgedSequence",
                            &out->control.acknowledged_sequence)) {
    return false;
  }

  const auto absent = [&members](const char* name) {
    return members.find(name) == members.end();
  };
  const auto no_optional_fields = [&]() {
    return absent("displayId") && absent("width") && absent("height") &&
           absent("dpiScalePercent") && absent("requestId") &&
           absent("frameWidth") && absent("frameHeight") &&
           absent("acknowledgedSequence");
  };

  if (out->control.kind == "hello" || out->control.kind == "keepalive" ||
      out->control.kind == "unlock") {
    return no_optional_fields();
  }
  if (out->control.kind == "select_display") {
    return out->control.display_id.has_value() && absent("width") &&
           absent("height") && absent("dpiScalePercent") &&
           absent("requestId") && absent("frameWidth") &&
           absent("frameHeight") && absent("acknowledgedSequence");
  }
  if (out->control.kind == "set_display_mode") {
    return out->control.display_id.has_value() &&
           out->control.width.has_value() && out->control.height.has_value() &&
           *out->control.width >= 480 && *out->control.width <= 16'384 &&
           *out->control.height >= 480 && *out->control.height <= 16'384 &&
           absent("dpiScalePercent") && absent("requestId") &&
           absent("frameWidth") && absent("frameHeight") &&
           absent("acknowledgedSequence");
  }
  if (out->control.kind == "set_display_scale") {
    if (!out->control.display_id.has_value() ||
        !out->control.dpi_scale_percent.has_value() || !absent("width") ||
        !absent("height") || !absent("requestId") || !absent("frameWidth") ||
        !absent("frameHeight") || !absent("acknowledgedSequence")) {
      return false;
    }
    switch (*out->control.dpi_scale_percent) {
      case 100:
      case 125:
      case 150:
      case 175:
      case 200:
      case 225:
      case 250:
      case 300:
        return true;
      default:
        return false;
    }
  }
  if (out->control.kind == "copy_selection") {
    return out->control.request_id.has_value() && absent("displayId") &&
           absent("width") && absent("height") && absent("dpiScalePercent") &&
           absent("frameWidth") && absent("frameHeight") &&
           absent("acknowledgedSequence");
  }
  if (out->control.kind == "frame_presented") {
    return out->control.display_id.has_value() &&
           out->control.frame_width.has_value() &&
           out->control.frame_height.has_value() &&
           *out->control.frame_width > 0 &&
           *out->control.frame_width <= 16'384 &&
           *out->control.frame_height > 0 &&
           *out->control.frame_height <= 16'384 && absent("width") &&
           absent("height") && absent("dpiScalePercent") &&
           absent("requestId") && absent("acknowledgedSequence");
  }
  if (out->control.kind == "input_ack") {
    return out->control.acknowledged_sequence.has_value() &&
           absent("displayId") && absent("width") && absent("height") &&
           absent("dpiScalePercent") && absent("requestId") &&
           absent("frameWidth") && absent("frameHeight");
  }
  return false;
}

[[nodiscard]] bool ParseReleaseAll(const Members& members,
                                   DataChannelMessage* out) {
  if (!HasExactKeys(members,
                    {"type", "protocolVersion", "sessionId", "sequence",
                     "layoutRevision", "inputEpoch"},
                    {})) {
    return false;
  }
  if (!ReadCorrelation(members, &out->correlation))
    return false;
  return out->correlation.input_epoch != 0;
}

}  // namespace

bool ParseDataChannelMessage(std::string_view payload,
                             DataChannelMessage* out) {
  if (out == nullptr)
    return false;
  if (payload.empty() || payload.size() > kMaxDataMessageBytes)
    return false;

  Members members;
  if (!ParseFlatObject(payload, &members))
    return false;

  const Scalar* type = Find(members, "type");
  if (type == nullptr || type->type != Scalar::Type::kString)
    return false;

  DataChannelMessage parsed;
  if (type->text == kPointerType) {
    parsed.kind = DataChannelMessageKind::kPointer;
    if (!ParsePointer(members, &parsed))
      return false;
  } else if (type->text == kKeyboardType) {
    parsed.kind = DataChannelMessageKind::kKeyboard;
    if (!ParseKeyboard(members, &parsed))
      return false;
  } else if (type->text == kControlType) {
    parsed.kind = DataChannelMessageKind::kControl;
    if (!ParseControl(members, &parsed))
      return false;
  } else if (type->text == kReleaseAllType) {
    parsed.kind = DataChannelMessageKind::kReleaseAll;
    if (!ParseReleaseAll(members, &parsed))
      return false;
  } else {
    // Worker-to-browser types and anything unknown are refused on this path.
    return false;
  }

  *out = std::move(parsed);
  return true;
}

}  // namespace imcodes::rd
