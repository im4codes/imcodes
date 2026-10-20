#include <array>
#include <charconv>
#include <cstdint>
#include <map>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

#include <windows.h>
#include <shellapi.h>

#include "third_party/imcodes_remote_desktop/clipboard_watchdog.h"

namespace {

using imcodes::remote_desktop::clipboard_watchdog::WatchRequest;

bool ParseSafeEpoch(std::wstring_view value, std::string* output) {
  if (value.size() < 16 || value.size() > 128) return false;
  output->clear();
  output->reserve(value.size());
  for (const wchar_t character : value) {
    if (!(character >= L'a' && character <= L'z') &&
        !(character >= L'A' && character <= L'Z') &&
        !(character >= L'0' && character <= L'9') && character != L'-' &&
        character != L'_') {
      return false;
    }
    output->push_back(static_cast<char>(character));
  }
  return true;
}

bool SafeReadyEvent(std::wstring_view value) {
  constexpr std::wstring_view prefix = L"Local\\IMCodesClipboardWatchdog-";
  if (!value.starts_with(prefix) || value.size() > 128) return false;
  for (const wchar_t character : value.substr(prefix.size())) {
    if (!((character >= L'a' && character <= L'f') ||
          (character >= L'A' && character <= L'F') ||
          (character >= L'0' && character <= L'9'))) {
      return false;
    }
  }
  return value.size() > prefix.size();
}

template <typename Integer>
bool ParseUnsigned(const std::wstring& value, Integer* output) {
  if (value.empty()) return false;
  std::string ascii;
  ascii.reserve(value.size());
  for (const wchar_t character : value) {
    if (character < L'0' || character > L'9') return false;
    ascii.push_back(static_cast<char>(character));
  }
  const auto [end, error] =
      std::from_chars(ascii.data(), ascii.data() + ascii.size(), *output);
  return error == std::errc{} && end == ascii.data() + ascii.size();
}

int Main(int count, wchar_t** arguments) {
  using namespace imcodes::remote_desktop::clipboard_watchdog;
  if (count == 2 && std::wstring_view(arguments[1]) == L"--sanitize") {
    return Sanitize();
  }
  if (count != 12 || std::wstring_view(arguments[1]) != L"--watch") return 2;

  std::map<std::wstring, std::wstring> values;
  for (int index = 2; index + 1 < count; index += 2) {
    const std::wstring key(arguments[index]);
    if (!key.starts_with(L"--") || values.contains(key)) return 2;
    values.emplace(key, arguments[index + 1]);
  }
  static constexpr std::array<std::wstring_view, 5> kKeys = {
      L"--epoch", L"--sha256", L"--deadline-at", L"--baseline-sequence",
      L"--ready-event"};
  if (values.size() != kKeys.size()) return 2;
  for (const auto key : kKeys) {
    if (!values.contains(std::wstring(key))) return 2;
  }

  WatchRequest request{};
  if (!ParseSafeEpoch(values[L"--epoch"], &request.epoch_id) ||
      !ParseSha256Hex(values[L"--sha256"], &request.expected_hash) ||
      !ParseUnsigned(values[L"--deadline-at"], &request.deadline_unix_ms) ||
      !ParseUnsigned(values[L"--baseline-sequence"],
                     &request.baseline_sequence) ||
      !SafeReadyEvent(values[L"--ready-event"])) {
    return 2;
  }
  request.ready_event = values[L"--ready-event"];
  return Run(request);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  int count = 0;
  wchar_t** arguments = CommandLineToArgvW(GetCommandLineW(), &count);
  if (!arguments) return 2;
  const int result = Main(count, arguments);
  LocalFree(arguments);
  return result;
}
