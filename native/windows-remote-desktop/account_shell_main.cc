#include <charconv>
#include <cstdint>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <wincrypt.h>
#include <shellapi.h>

#include "third_party/imcodes_remote_desktop/account_shell.h"

namespace {

using imcodes::remote_desktop::account_shell::LaunchContext;

constexpr size_t kMaximumLaunchContextBytes = 1024;
constexpr std::wstring_view kLaunchMode = L"--remote-desktop-signed-shell";
constexpr std::wstring_view kServerOriginArgument = L"--server-origin";
constexpr std::wstring_view kContextArgument = L"--launch-context-b64";
constexpr std::wstring_view kBootstrapHostArgument = L"--bootstrap-host-id";

std::string NarrowValidatedAscii(std::wstring_view value) {
  std::string narrowed;
  narrowed.reserve(value.size());
  for (const wchar_t character : value) {
    narrowed.push_back(static_cast<char>(character));
  }
  return narrowed;
}

uint64_t UnixMillisecondsNow() {
  FILETIME file_time{};
  GetSystemTimeAsFileTime(&file_time);
  ULARGE_INTEGER value{};
  value.LowPart = file_time.dwLowDateTime;
  value.HighPart = file_time.dwHighDateTime;
  constexpr uint64_t kWindowsToUnixEpoch100ns = 116444736000000000ULL;
  return value.QuadPart <= kWindowsToUnixEpoch100ns
             ? 0
             : (value.QuadPart - kWindowsToUnixEpoch100ns) / 10000ULL;
}

std::optional<std::string> DecodeBase64Url(std::wstring_view encoded) {
  if (encoded.empty() || encoded.size() > 1366 || encoded.size() % 4 == 1) {
    return std::nullopt;
  }
  std::string padded;
  padded.reserve(encoded.size() + 3);
  for (wchar_t character : encoded) {
    if (character >= L'A' && character <= L'Z' ||
        character >= L'a' && character <= L'z' ||
        character >= L'0' && character <= L'9') {
      padded.push_back(static_cast<char>(character));
    } else if (character == L'-') {
      padded.push_back('+');
    } else if (character == L'_') {
      padded.push_back('/');
    } else {
      return std::nullopt;
    }
  }
  while (padded.size() % 4 != 0) padded.push_back('=');
  DWORD decoded_size = 0;
  if (!CryptStringToBinaryA(padded.data(), static_cast<DWORD>(padded.size()),
                            CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT,
                            nullptr, &decoded_size, nullptr, nullptr) ||
      decoded_size == 0 || decoded_size > kMaximumLaunchContextBytes) {
    return std::nullopt;
  }
  std::string decoded(decoded_size, '\0');
  if (!CryptStringToBinaryA(padded.data(), static_cast<DWORD>(padded.size()),
                            CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT,
                            reinterpret_cast<BYTE*>(decoded.data()),
                            &decoded_size, nullptr, nullptr) ||
      decoded_size != decoded.size()) {
    return std::nullopt;
  }
  return decoded;
}

class LaunchContextParser {
 public:
  explicit LaunchContextParser(std::string_view input) : input_(input) {}

  std::optional<LaunchContext> Parse() {
    LaunchContext context{};
    bool host = false;
    bool launch = false;
    bool issued = false;
    bool expires = false;
    bool generation = false;
    SkipWhitespace();
    if (!Consume('{')) return std::nullopt;
    SkipWhitespace();
    for (;;) {
      if (Peek('}')) break;
      const auto key = ParseAsciiString();
      SkipWhitespace();
      if (!key || !Consume(':')) return std::nullopt;
      SkipWhitespace();
      if (*key == "hostId" && !host) {
        const auto value = ParseAsciiString();
        if (!value) return std::nullopt;
        context.host_id = *value;
        host = true;
      } else if (*key == "launchId" && !launch) {
        const auto value = ParseAsciiString();
        if (!value) return std::nullopt;
        context.launch_id = *value;
        launch = true;
      } else if (*key == "issuedAt" && !issued) {
        if (!ParseInteger(&context.issued_at)) return std::nullopt;
        issued = true;
      } else if (*key == "expiresAt" && !expires) {
        if (!ParseInteger(&context.expires_at)) return std::nullopt;
        expires = true;
      } else if (*key == "endpointGeneration" && !generation) {
        if (!ParseInteger(&context.endpoint_generation)) return std::nullopt;
        generation = true;
      } else {
        // Unknown and duplicate fields are equally invalid. Launch context is
        // an exact five-field presentation identity, never an extension bag.
        return std::nullopt;
      }
      SkipWhitespace();
      if (Consume(',')) {
        SkipWhitespace();
        continue;
      }
      break;
    }
    if (!Consume('}')) return std::nullopt;
    SkipWhitespace();
    if (position_ != input_.size() || !host || !launch || !issued ||
        !expires || !generation) {
      return std::nullopt;
    }
    return context;
  }

 private:
  void SkipWhitespace() {
    while (position_ < input_.size() &&
           (input_[position_] == ' ' || input_[position_] == '\t' ||
            input_[position_] == '\r' || input_[position_] == '\n')) {
      ++position_;
    }
  }

  bool Peek(char expected) const {
    return position_ < input_.size() && input_[position_] == expected;
  }

  bool Consume(char expected) {
    if (!Peek(expected)) return false;
    ++position_;
    return true;
  }

  std::optional<std::string> ParseAsciiString() {
    if (!Consume('"')) return std::nullopt;
    const size_t start = position_;
    while (position_ < input_.size() && input_[position_] != '"') {
      const unsigned char value = static_cast<unsigned char>(input_[position_]);
      // Context IDs and keys are ASCII and never need escapes. Refusing every
      // escape avoids alternate spellings of a security-relevant field name.
      if (value < 0x20 || value > 0x7e || value == '\\') return std::nullopt;
      ++position_;
    }
    if (!Consume('"')) return std::nullopt;
    return std::string(input_.substr(start, position_ - start - 1));
  }

  bool ParseInteger(uint64_t* output) {
    if (!output || position_ >= input_.size() || input_[position_] < '0' ||
        input_[position_] > '9') {
      return false;
    }
    const char* begin = input_.data() + position_;
    const char* end = begin;
    while (end < input_.data() + input_.size() && *end >= '0' && *end <= '9') {
      ++end;
    }
    uint64_t parsed = 0;
    const auto result = std::from_chars(begin, end, parsed);
    if (result.ec != std::errc{} || result.ptr != end ||
        parsed > 9'007'199'254'740'991ULL) {
      return false;
    }
    position_ += static_cast<size_t>(end - begin);
    *output = parsed;
    return true;
  }

  std::string_view input_;
  size_t position_ = 0;
};

std::optional<LaunchContext> DecodeLaunchContext(std::wstring_view encoded) {
  const auto json = DecodeBase64Url(encoded);
  if (!json) return std::nullopt;
  const auto context = LaunchContextParser(*json).Parse();
  if (!context ||
      !imcodes::remote_desktop::account_shell::ValidateLaunchContext(
          *context, context->host_id, context->endpoint_generation,
          UnixMillisecondsNow())) {
    return std::nullopt;
  }
  return context;
}

bool IsCanonicalNetworkOrigin(std::wstring_view value) {
  if (!imcodes::remote_desktop::account_shell::IsCanonicalHttpsOrigin(value)) {
    return false;
  }
  constexpr std::wstring_view prefix = L"https://";
  const std::wstring_view authority = value.substr(prefix.size());
  const size_t close = authority.find(L']');
  if (authority.front() == L'[') {
    if (close == std::wstring_view::npos) return false;
    const std::wstring host(authority.substr(1, close - 1));
    IN6_ADDR address{};
    wchar_t canonical[INET6_ADDRSTRLEN]{};
    return InetPtonW(AF_INET6, host.c_str(), &address) == 1 &&
           InetNtopW(AF_INET6, &address, canonical, INET6_ADDRSTRLEN) &&
           host == canonical;
  }
  const size_t colon = authority.find(L':');
  const std::wstring host(authority.substr(0, colon));
  if (host.find_first_not_of(L"0123456789.") == std::wstring::npos) {
    IN_ADDR address{};
    wchar_t canonical[INET_ADDRSTRLEN]{};
    return InetPtonW(AF_INET, host.c_str(), &address) == 1 &&
           InetNtopW(AF_INET, &address, canonical, INET_ADDRSTRLEN) &&
           host == canonical;
  }
  return true;
}

int Main(int count, wchar_t** arguments) {
  // Match the Node launcher exactly. No token, privacy epoch or extension field
  // is accepted on argv. The bootstrap host is non-authorizing: it can only
  // sign in and request the real one-use context through the Server/Node path.
  if (count != 6 || std::wstring_view(arguments[1]) != kLaunchMode ||
      std::wstring_view(arguments[2]) != kServerOriginArgument) {
    return 2;
  }
  const std::wstring_view server_origin = arguments[3];
  if (!IsCanonicalNetworkOrigin(server_origin)) {
    return 2;
  }
  const std::wstring_view binding = arguments[4];
  if (binding == kContextArgument) {
    const auto context = DecodeLaunchContext(arguments[5]);
    if (!context) return 2;
    return imcodes::remote_desktop::account_shell::RunAccountShell(
        std::wstring(server_origin), context, context->host_id,
        context->endpoint_generation);
  }
  if (binding == kBootstrapHostArgument) {
    const std::wstring_view host = arguments[5];
    if (host.empty() || host.size() > 128 ||
        host.find_first_not_of(
            L"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-") !=
            std::wstring_view::npos) {
      return 2;
    }
    return imcodes::remote_desktop::account_shell::RunAccountShell(
        std::wstring(server_origin), std::nullopt,
        NarrowValidatedAscii(host), 0);
  }
  return 2;
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
