#include "third_party/imcodes_remote_desktop/account_shell.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <initializer_list>
#include <limits>
#include <optional>
#include <string_view>
#include <utility>
#include <vector>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <bcrypt.h>
#include <shellapi.h>
#include <shlobj.h>
#include <wincrypt.h>
#include <winhttp.h>

namespace imcodes::remote_desktop::account_shell {
namespace {

constexpr uint32_t kStoreMagic = 0x53414d49;  // IMAS.
constexpr uint16_t kStoreVersion = 1;
constexpr size_t kMaximumStoreBytes = 16 * 1024;
constexpr size_t kMaximumHttpBodyBytes = 64 * 1024;
constexpr DWORD kHttpTimeoutMs = 15'000;
constexpr DWORD kLoopbackTimeoutMs = 90'000;
constexpr DWORD kWatchdogReadyTimeoutMs = 5'000;
constexpr DWORD kWatchdogSanitizeTimeoutMs = 5'000;
constexpr wchar_t kWatchdogExecutable[] = L"imcodes-clipboard-watchdog.exe";
constexpr wchar_t kWatchdogReadyPrefix[] =
    L"Local\\IMCodesClipboardWatchdog-";
constexpr std::string_view kLinkHashDomain =
    "imcodes.remote-desktop.link.v1";
constexpr std::string_view kLinkPolicyHashDomain =
    "imcodes.remote-desktop.link-policy.v1";
constexpr uint64_t kOneHourMs = 60 * 60 * 1000;
constexpr uint64_t kSixHoursMs = 6 * kOneHourMs;
constexpr uint64_t kOneDayMs = 24 * kOneHourMs;
constexpr uint64_t kSevenDaysMs = 7 * kOneDayMs;
constexpr uint64_t kThirtyDaysMs = 30 * kOneDayMs;

struct StoreHeader {
  uint32_t magic = kStoreMagic;
  uint16_t version = kStoreVersion;
  uint16_t fields = 8;
  uint64_t expires_at = 0;
  uint8_t revoked = 0;
  uint8_t reserved[7]{};
};

class ScopedHandle {
 public:
  explicit ScopedHandle(HANDLE handle = INVALID_HANDLE_VALUE) : handle_(handle) {}
  ~ScopedHandle() {
    if (handle_ != INVALID_HANDLE_VALUE && handle_ != nullptr) CloseHandle(handle_);
  }
  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;
  HANDLE get() const { return handle_; }
  bool valid() const { return handle_ != INVALID_HANDLE_VALUE && handle_ != nullptr; }

 private:
  HANDLE handle_;
};

class ScopedInternet {
 public:
  explicit ScopedInternet(HINTERNET handle = nullptr) : handle_(handle) {}
  ~ScopedInternet() { if (handle_) WinHttpCloseHandle(handle_); }
  ScopedInternet(const ScopedInternet&) = delete;
  ScopedInternet& operator=(const ScopedInternet&) = delete;
  HINTERNET get() const { return handle_; }
  bool valid() const { return handle_ != nullptr; }

 private:
  HINTERNET handle_;
};

class ScopedSocket {
 public:
  explicit ScopedSocket(SOCKET socket = INVALID_SOCKET) : socket_(socket) {}
  ~ScopedSocket() { if (socket_ != INVALID_SOCKET) closesocket(socket_); }
  ScopedSocket(const ScopedSocket&) = delete;
  ScopedSocket& operator=(const ScopedSocket&) = delete;
  ScopedSocket(ScopedSocket&& other) noexcept : socket_(other.socket_) {
    other.socket_ = INVALID_SOCKET;
  }
  ScopedSocket& operator=(ScopedSocket&& other) noexcept {
    if (this == &other) return *this;
    if (socket_ != INVALID_SOCKET) closesocket(socket_);
    socket_ = other.socket_;
    other.socket_ = INVALID_SOCKET;
    return *this;
  }
  SOCKET get() const { return socket_; }
  bool valid() const { return socket_ != INVALID_SOCKET; }

 private:
  SOCKET socket_;
};

class ScopedWinsock {
 public:
  ScopedWinsock() {
    WSADATA data{};
    started_ = WSAStartup(MAKEWORD(2, 2), &data) == 0;
  }
  ~ScopedWinsock() { if (started_) WSACleanup(); }
  ScopedWinsock(const ScopedWinsock&) = delete;
  ScopedWinsock& operator=(const ScopedWinsock&) = delete;
  bool started() const { return started_; }

 private:
  bool started_ = false;
};

uint64_t UnixMillisecondsNow() {
  return static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch()).count());
}

std::optional<std::filesystem::path> SessionPath() {
  PWSTR local_app_data = nullptr;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_CREATE,
                                  nullptr, &local_app_data)) ||
      !local_app_data) {
    return std::nullopt;
  }
  std::filesystem::path path(local_app_data);
  CoTaskMemFree(local_app_data);
  path /= L"IM.codes";
  path /= L"remote-desktop";
  path /= L"account-session.bin";
  return path;
}

void AppendUint32(uint32_t value, std::vector<uint8_t>* output) {
  for (unsigned shift = 0; shift < 32; shift += 8) {
    output->push_back(static_cast<uint8_t>((value >> shift) & 0xff));
  }
}

bool ReadUint32(const std::vector<uint8_t>& input, size_t* offset, uint32_t* value) {
  if (*offset > input.size() || input.size() - *offset < 4) return false;
  *value = 0;
  for (unsigned shift = 0; shift < 32; shift += 8) {
    *value |= static_cast<uint32_t>(input[(*offset)++]) << shift;
  }
  return true;
}

bool AppendString(std::string_view value, std::vector<uint8_t>* output) {
  if (value.size() > 4096 || value.size() > std::numeric_limits<uint32_t>::max()) {
    return false;
  }
  AppendUint32(static_cast<uint32_t>(value.size()), output);
  output->insert(output->end(), value.begin(), value.end());
  return output->size() <= kMaximumStoreBytes;
}

bool ReadString(const std::vector<uint8_t>& input, size_t* offset,
                std::string* output) {
  uint32_t size = 0;
  if (!ReadUint32(input, offset, &size) || size > 4096 ||
      *offset > input.size() || input.size() - *offset < size) {
    return false;
  }
  output->assign(reinterpret_cast<const char*>(input.data() + *offset), size);
  *offset += size;
  return true;
}

std::vector<uint8_t> SerializeSession(const NativeAccountSession& session) {
  StoreHeader header{};
  header.expires_at = session.state.expires_at;
  header.revoked = session.state.revoked ? 1 : 0;
  std::vector<uint8_t> output(sizeof(header));
  std::memcpy(output.data(), &header, sizeof(header));
  for (const std::string_view field : {
           std::string_view(session.state.session_id),
           std::string_view(session.state.user_id),
           std::string_view(session.state.client_id),
           std::string_view(session.state.issuer),
           std::string_view(session.state.audience),
           std::string_view(session.access_token),
           std::string_view(kNativeClientId),
           std::string_view(kNativeAudience)}) {
    if (!AppendString(field, &output)) return {};
  }
  return output;
}

std::optional<NativeAccountSession> DeserializeSession(
    const std::vector<uint8_t>& input) {
  if (input.size() < sizeof(StoreHeader) || input.size() > kMaximumStoreBytes) {
    return std::nullopt;
  }
  StoreHeader header{};
  std::memcpy(&header, input.data(), sizeof(header));
  if (header.magic != kStoreMagic || header.version != kStoreVersion ||
      header.fields != 8 || header.revoked > 1 ||
      std::any_of(std::begin(header.reserved), std::end(header.reserved),
                  [](uint8_t value) { return value != 0; })) {
    return std::nullopt;
  }
  NativeAccountSession session{};
  session.state.expires_at = header.expires_at;
  session.state.revoked = header.revoked != 0;
  size_t offset = sizeof(header);
  std::string client_pin;
  std::string audience_pin;
  if (!ReadString(input, &offset, &session.state.session_id) ||
      !ReadString(input, &offset, &session.state.user_id) ||
      !ReadString(input, &offset, &session.state.client_id) ||
      !ReadString(input, &offset, &session.state.issuer) ||
      !ReadString(input, &offset, &session.state.audience) ||
      !ReadString(input, &offset, &session.access_token) ||
      !ReadString(input, &offset, &client_pin) ||
      !ReadString(input, &offset, &audience_pin) || offset != input.size() ||
      client_pin != kNativeClientId || audience_pin != kNativeAudience ||
      session.access_token.size() < 48 || session.access_token.size() > 512) {
    return std::nullopt;
  }
  return session;
}

bool ProtectBytes(const std::vector<uint8_t>& clear,
                  std::vector<uint8_t>* sealed) {
  if (clear.empty() || clear.size() > kMaximumStoreBytes) return false;
  DATA_BLOB input{static_cast<DWORD>(clear.size()),
                  const_cast<BYTE*>(clear.data())};
  DATA_BLOB output{};
  if (!CryptProtectData(&input, L"IM.codes account shell session", nullptr,
                        nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)) {
    return false;
  }
  sealed->assign(output.pbData, output.pbData + output.cbData);
  SecureZeroMemory(output.pbData, output.cbData);
  LocalFree(output.pbData);
  return sealed->size() <= kMaximumStoreBytes;
}

bool UnprotectBytes(const std::vector<uint8_t>& sealed,
                    std::vector<uint8_t>* clear) {
  if (sealed.empty() || sealed.size() > kMaximumStoreBytes) return false;
  DATA_BLOB input{static_cast<DWORD>(sealed.size()),
                  const_cast<BYTE*>(sealed.data())};
  DATA_BLOB output{};
  if (!CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr,
                          CRYPTPROTECT_UI_FORBIDDEN, &output)) {
    return false;
  }
  const bool bounded = output.cbData > 0 && output.cbData <= kMaximumStoreBytes;
  if (bounded) clear->assign(output.pbData, output.pbData + output.cbData);
  SecureZeroMemory(output.pbData, output.cbData);
  LocalFree(output.pbData);
  return bounded;
}

std::string Base64Url(const uint8_t* bytes, DWORD size) {
  DWORD required = 0;
  if (!CryptBinaryToStringA(bytes, size,
                            CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF,
                            nullptr, &required) || required == 0) {
    return {};
  }
  std::string encoded(required, '\0');
  if (!CryptBinaryToStringA(bytes, size,
                            CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF,
                            encoded.data(), &required)) {
    return {};
  }
  if (!encoded.empty() && encoded.back() == '\0') encoded.pop_back();
  while (!encoded.empty() && encoded.back() == '=') encoded.pop_back();
  std::replace(encoded.begin(), encoded.end(), '+', '-');
  std::replace(encoded.begin(), encoded.end(), '/', '_');
  return encoded;
}

std::optional<PkceRequest> GeneratePkce() {
  std::array<uint8_t, 64> verifier_bytes{};
  std::array<uint8_t, 32> state_bytes{};
  if (BCryptGenRandom(nullptr, verifier_bytes.data(),
                      static_cast<ULONG>(verifier_bytes.size()),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0 ||
      BCryptGenRandom(nullptr, state_bytes.data(),
                      static_cast<ULONG>(state_bytes.size()),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
    return std::nullopt;
  }
  PkceRequest request{};
  request.verifier = Base64Url(verifier_bytes.data(),
                               static_cast<DWORD>(verifier_bytes.size()));
  request.state = Base64Url(state_bytes.data(),
                            static_cast<DWORD>(state_bytes.size()));
  SecureZeroMemory(verifier_bytes.data(), verifier_bytes.size());
  SecureZeroMemory(state_bytes.data(), state_bytes.size());
  if (!IsValidPkceVerifier(request.verifier) ||
      !IsCanonicalBase64Url32(request.state)) {
    return std::nullopt;
  }
  std::array<uint8_t, 32> digest{};
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM,
                                  nullptr, 0) != 0) {
    return std::nullopt;
  }
  const NTSTATUS status = BCryptHash(
      algorithm, nullptr, 0,
      reinterpret_cast<PUCHAR>(request.verifier.data()),
      static_cast<ULONG>(request.verifier.size()), digest.data(),
      static_cast<ULONG>(digest.size()));
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (status != 0) return std::nullopt;
  request.challenge = Base64Url(digest.data(), static_cast<DWORD>(digest.size()));
  SecureZeroMemory(digest.data(), digest.size());
  return IsCanonicalBase64Url32(request.challenge)
             ? std::optional<PkceRequest>(std::move(request))
             : std::nullopt;
}

std::optional<std::string> GenerateOpaque32() {
  std::array<uint8_t, 32> bytes{};
  if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
    return std::nullopt;
  }
  std::string value = Base64Url(bytes.data(), static_cast<DWORD>(bytes.size()));
  SecureZeroMemory(bytes.data(), bytes.size());
  return IsCanonicalBase64Url32(value)
             ? std::optional<std::string>(std::move(value))
             : std::nullopt;
}

bool Sha256(std::initializer_list<std::pair<const uint8_t*, size_t>> parts,
            std::array<uint8_t, 32>* output) {
  if (!output) return false;
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_size = 0;
  DWORD result_size = 0;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM,
                                  nullptr, 0) != 0 ||
      BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                        reinterpret_cast<PUCHAR>(&object_size),
                        sizeof(object_size), &result_size, 0) != 0 ||
      object_size == 0) {
    if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
    return false;
  }
  std::vector<uint8_t> object(object_size);
  bool ok = BCryptCreateHash(algorithm, &hash, object.data(), object_size,
                             nullptr, 0, 0) == 0;
  for (const auto& [bytes, size] : parts) {
    if (!ok || (!bytes && size != 0) ||
        size > std::numeric_limits<ULONG>::max() ||
        BCryptHashData(hash, const_cast<PUCHAR>(bytes),
                       static_cast<ULONG>(size), 0) != 0) {
      ok = false;
      break;
    }
  }
  if (ok) {
    ok = BCryptFinishHash(hash, output->data(),
                          static_cast<ULONG>(output->size()), 0) == 0;
  }
  if (hash) BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  SecureZeroMemory(object.data(), object.size());
  if (!ok) SecureZeroMemory(output->data(), output->size());
  return ok;
}

std::string LowerHex(const uint8_t* bytes, size_t size) {
  constexpr char digits[] = "0123456789abcdef";
  std::string output(size * 2, '0');
  for (size_t index = 0; index < size; ++index) {
    output[index * 2] = digits[bytes[index] >> 4];
    output[index * 2 + 1] = digits[bytes[index] & 0x0f];
  }
  return output;
}

std::wstring WidenLowerHex(const uint8_t* bytes, size_t size) {
  const std::string ascii = LowerHex(bytes, size);
  return std::wstring(ascii.begin(), ascii.end());
}

void SecureClear(std::string* value) {
  if (!value) return;
  if (!value->empty()) SecureZeroMemory(value->data(), value->size());
  value->clear();
}

void SecureClear(std::wstring* value) {
  if (!value) return;
  if (!value->empty()) {
    SecureZeroMemory(value->data(), value->size() * sizeof(wchar_t));
  }
  value->clear();
}

std::wstring Utf8ToWide(std::string_view value) {
  if (value.empty() || value.size() > std::numeric_limits<int>::max()) return {};
  const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                            value.data(),
                                            static_cast<int>(value.size()),
                                            nullptr, 0);
  if (required <= 0) return {};
  std::wstring output(static_cast<size_t>(required), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), output.data(),
                          required) != required) {
    return {};
  }
  return output;
}

std::string WideToUtf8(std::wstring_view value) {
  if (value.empty() || value.size() > std::numeric_limits<int>::max()) return {};
  const int required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
                                            value.data(),
                                            static_cast<int>(value.size()),
                                            nullptr, 0, nullptr, nullptr);
  if (required <= 0) return {};
  std::string output(static_cast<size_t>(required), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), output.data(),
                          required, nullptr, nullptr) != required) {
    return {};
  }
  return output;
}

std::wstring UrlEncode(std::string_view value) {
  constexpr wchar_t hex[] = L"0123456789ABCDEF";
  std::wstring output;
  for (const unsigned char character : value) {
    if ((character >= 'a' && character <= 'z') ||
        (character >= 'A' && character <= 'Z') ||
        (character >= '0' && character <= '9') || character == '-' ||
        character == '_' || character == '.' || character == '~') {
      output.push_back(static_cast<wchar_t>(character));
    } else {
      output.push_back(L'%');
      output.push_back(hex[character >> 4]);
      output.push_back(hex[character & 0xf]);
    }
  }
  return output;
}

bool ExtractQueryValue(std::string_view target, std::string_view key,
                       std::string* output) {
  const size_t question = target.find('?');
  if (question == std::string_view::npos) return false;
  size_t offset = question + 1;
  while (offset < target.size()) {
    const size_t end = target.find('&', offset);
    const std::string_view pair = target.substr(
        offset, end == std::string_view::npos ? target.size() - offset
                                              : end - offset);
    const size_t equals = pair.find('=');
    if (equals != std::string_view::npos && pair.substr(0, equals) == key) {
      const std::string_view value = pair.substr(equals + 1);
      if (value.empty() || value.size() > 512 ||
          !std::all_of(value.begin(), value.end(), [](char character) {
            return (character >= 'a' && character <= 'z') ||
                   (character >= 'A' && character <= 'Z') ||
                   (character >= '0' && character <= '9') ||
                   character == '-' || character == '_';
          })) {
        return false;
      }
      output->assign(value);
      return true;
    }
    if (end == std::string_view::npos) break;
    offset = end + 1;
  }
  return false;
}

std::optional<AuthorizationResult> WaitForLoopback(
    const PkceRequest& request, SOCKET listener) {
  fd_set read_set;
  FD_ZERO(&read_set);
  FD_SET(listener, &read_set);
  timeval timeout{static_cast<long>(kLoopbackTimeoutMs / 1000), 0};
  if (select(0, &read_set, nullptr, nullptr, &timeout) != 1) return std::nullopt;
  ScopedSocket client(accept(listener, nullptr, nullptr));
  if (!client.valid()) return std::nullopt;
  std::array<char, 8193> input{};
  const int received = recv(client.get(), input.data(), 8192, 0);
  if (received <= 0) return std::nullopt;
  std::string_view request_text(input.data(), static_cast<size_t>(received));
  const size_t line_end = request_text.find("\r\n");
  if (line_end == std::string_view::npos) return std::nullopt;
  const std::string_view line = request_text.substr(0, line_end);
  constexpr std::string_view prefix = "GET ";
  constexpr std::string_view suffix = " HTTP/1.1";
  if (!line.starts_with(prefix) || !line.ends_with(suffix)) return std::nullopt;
  const std::string_view target = line.substr(
      prefix.size(), line.size() - prefix.size() - suffix.size());
  if (!target.starts_with("/oauth/callback?")) return std::nullopt;
  AuthorizationResult result{};
  if (!ExtractQueryValue(target, "code", &result.code) ||
      !ExtractQueryValue(target, "state", &result.state) ||
      result.state != request.state ||
      !IsCanonicalBase64Url32(result.code)) {
    return std::nullopt;
  }
  constexpr std::string_view body =
      "Authorization complete. Return to IM.codes Remote Desktop.";
  const std::string response =
      "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\n"
      "Cache-Control: no-store\r\nContent-Length: " +
      std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" +
      std::string(body);
  send(client.get(), response.data(), static_cast<int>(response.size()), 0);
  return result;
}

std::optional<ScopedSocket> CreateExactLoopbackListener() {
  ScopedSocket listener(socket(AF_INET, SOCK_STREAM, IPPROTO_TCP));
  if (!listener.valid()) return std::nullopt;
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port = htons(kNativeLoopbackPort);
  if (InetPtonW(AF_INET, L"127.0.0.1", &address.sin_addr) != 1 ||
      bind(listener.get(), reinterpret_cast<sockaddr*>(&address),
           sizeof(address)) == SOCKET_ERROR ||
      listen(listener.get(), 1) == SOCKET_ERROR) {
    return std::nullopt;
  }
  return std::optional<ScopedSocket>(std::move(listener));
}

bool JsonString(std::string_view body, std::string_view field,
                std::string* output) {
  const std::string needle = "\"" + std::string(field) + "\":\"";
  const size_t start = body.find(needle);
  if (start == std::string_view::npos) return false;
  size_t offset = start + needle.size();
  output->clear();
  while (offset < body.size() && output->size() <= 4096) {
    const char character = body[offset++];
    if (character == '"') return true;
    if (character == '\\') {
      if (offset >= body.size()) return false;
      const char escaped = body[offset++];
      if (escaped != '"' && escaped != '\\' && escaped != '/') return false;
      output->push_back(escaped);
    } else if (static_cast<unsigned char>(character) < 0x20) {
      return false;
    } else {
      output->push_back(character);
    }
  }
  return false;
}

bool JsonUint64(std::string_view body, std::string_view field, uint64_t* output) {
  const std::string needle = "\"" + std::string(field) + "\":";
  const size_t start = body.find(needle);
  if (start == std::string_view::npos) return false;
  size_t offset = start + needle.size();
  uint64_t value = 0;
  size_t digits = 0;
  while (offset < body.size() && body[offset] >= '0' && body[offset] <= '9') {
    const uint64_t digit = static_cast<uint64_t>(body[offset++] - '0');
    if (value > (std::numeric_limits<uint64_t>::max() - digit) / 10) return false;
    value = value * 10 + digit;
    ++digits;
  }
  if (digits == 0) return false;
  *output = value;
  return true;
}

std::optional<std::string_view> JsonObjectAfter(std::string_view body,
                                                std::string_view field,
                                                size_t start_at = 0) {
  const std::string needle = "\"" + std::string(field) + "\":{";
  const size_t start = body.find(needle, start_at);
  if (start == std::string_view::npos) return std::nullopt;
  const size_t object_start = start + needle.size() - 1;
  size_t depth = 0;
  bool in_string = false;
  bool escaped = false;
  for (size_t index = object_start; index < body.size(); ++index) {
    const char character = body[index];
    if (in_string) {
      if (escaped) {
        escaped = false;
      } else if (character == '\\') {
        escaped = true;
      } else if (character == '"') {
        in_string = false;
      }
      continue;
    }
    if (character == '"') {
      in_string = true;
    } else if (character == '{') {
      ++depth;
    } else if (character == '}') {
      if (depth == 0) return std::nullopt;
      --depth;
      if (depth == 0) return body.substr(object_start, index - object_start + 1);
    }
  }
  return std::nullopt;
}

std::optional<OwnerInvitationLink> ParseOwnerInvitationLink(
    std::string_view object) {
  OwnerInvitationLink link{};
  std::string kind;
  std::string mode;
  if (object.size() > 16 * 1024 ||
      !JsonString(object, "id", &link.id) ||
      !JsonString(object, "label", &link.label) ||
      !JsonString(object, "kind", &kind) ||
      !JsonString(object, "mode", &mode) ||
      !JsonString(object, "state", &link.state) ||
      !IsBoundedOpaqueId(link.id) || link.label.empty() ||
      link.label.size() > 256 ||
      (link.state != "active" && link.state != "revoked" &&
       link.state != "expired")) {
    return std::nullopt;
  }
  if (kind == "attended") {
    link.kind = InvitationLinkKind::kAttended;
  } else if (kind == "unattended") {
    link.kind = InvitationLinkKind::kUnattended;
  } else {
    return std::nullopt;
  }
  if (mode == "view") {
    link.mode = InvitationLinkMode::kView;
  } else if (mode == "control") {
    link.mode = InvitationLinkMode::kControl;
  } else {
    return std::nullopt;
  }
  return link;
}

std::optional<std::vector<OwnerInvitationLink>> ParseOwnerInvitationLinks(
    std::string_view body) {
  constexpr std::string_view prefix = "{\"links\":[";
  if (!body.starts_with(prefix) || !body.ends_with("]}") ||
      body.size() > kMaximumHttpBodyBytes) {
    return std::nullopt;
  }
  std::vector<OwnerInvitationLink> links;
  size_t offset = prefix.size();
  while (offset < body.size() - 2) {
    if (links.size() >= 256 || body[offset] != '{') return std::nullopt;
    size_t depth = 0;
    bool in_string = false;
    bool escaped = false;
    size_t end = offset;
    for (; end < body.size() - 1; ++end) {
      const char character = body[end];
      if (in_string) {
        if (escaped) escaped = false;
        else if (character == '\\') escaped = true;
        else if (character == '"') in_string = false;
        continue;
      }
      if (character == '"') in_string = true;
      else if (character == '{') ++depth;
      else if (character == '}') {
        if (depth == 0) return std::nullopt;
        --depth;
        if (depth == 0) break;
      }
    }
    if (end >= body.size() - 1) return std::nullopt;
    const auto link = ParseOwnerInvitationLink(
        body.substr(offset, end - offset + 1));
    if (!link) return std::nullopt;
    links.push_back(*link);
    offset = end + 1;
    if (offset == body.size() - 2) break;
    if (body[offset] != ',') return std::nullopt;
    ++offset;
  }
  return links;
}

std::string JsonEscape(std::string_view value) {
  std::string output;
  output.reserve(value.size() + 8);
  for (const char character : value) {
    if (character == '"' || character == '\\') output.push_back('\\');
    if (static_cast<unsigned char>(character) < 0x20) return {};
    output.push_back(character);
  }
  return output;
}

bool IsSupportedLinkDuration(std::optional<uint64_t> duration_ms) {
  if (!duration_ms) return true;
  return *duration_ms == kOneHourMs || *duration_ms == kSixHoursMs ||
         *duration_ms == kOneDayMs || *duration_ms == kSevenDaysMs ||
         *duration_ms == kThirtyDaysMs;
}

std::optional<std::filesystem::path> WatchdogPath() {
  std::wstring module(32'768, L'\0');
  const DWORD length = GetModuleFileNameW(nullptr, module.data(),
                                          static_cast<DWORD>(module.size()));
  if (length == 0 || length >= static_cast<DWORD>(module.size())) {
    return std::nullopt;
  }
  module.resize(length);
  std::filesystem::path path(module);
  path = path.parent_path() / kWatchdogExecutable;
  const DWORD attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES ||
      (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ||
      (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    return std::nullopt;
  }
  return path;
}

std::optional<std::wstring> RandomReadyEventName() {
  std::array<uint8_t, 16> bytes{};
  if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
    return std::nullopt;
  }
  std::wstring name(kWatchdogReadyPrefix);
  name += WidenLowerHex(bytes.data(), bytes.size());
  SecureZeroMemory(bytes.data(), bytes.size());
  return name;
}

bool SetClipboardOptOut(UINT format) {
  HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, sizeof(DWORD));
  if (!memory) return false;
  auto* value = static_cast<DWORD*>(GlobalLock(memory));
  if (!value) {
    GlobalFree(memory);
    return false;
  }
  *value = 0;
  GlobalUnlock(memory);
  if (!SetClipboardData(format, memory)) {
    GlobalFree(memory);
    return false;
  }
  return true;
}

bool WriteInvitationClipboard(std::wstring_view invitation_link) {
  if (invitation_link.empty() || invitation_link.size() > 4096 ||
      !OpenClipboard(nullptr)) {
    return false;
  }
  const size_t bytes = (invitation_link.size() + 1) * sizeof(wchar_t);
  HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, bytes);
  auto* destination = memory ? static_cast<wchar_t*>(GlobalLock(memory))
                             : nullptr;
  if (!destination) {
    if (memory) GlobalFree(memory);
    CloseClipboard();
    return false;
  }
  std::memcpy(destination, invitation_link.data(),
              invitation_link.size() * sizeof(wchar_t));
  destination[invitation_link.size()] = L'\0';
  GlobalUnlock(memory);
  const UINT history = RegisterClipboardFormatW(L"CanIncludeInClipboardHistory");
  const UINT cloud = RegisterClipboardFormatW(L"CanUploadToCloudClipboard");
  const bool transferred = EmptyClipboard() &&
      SetClipboardData(CF_UNICODETEXT, memory) != nullptr;
  if (transferred) memory = nullptr;
  const bool complete = transferred && history != 0 && cloud != 0 &&
                        SetClipboardOptOut(history) &&
                        SetClipboardOptOut(cloud);
  if (!complete) EmptyClipboard();
  CloseClipboard();
  if (memory) GlobalFree(memory);
  return complete;
}

std::optional<DWORD> RunWatchdogProcess(std::wstring arguments,
                                        DWORD timeout_ms,
                                        HANDLE ready_event = nullptr) {
  const auto executable = WatchdogPath();
  if (!executable) return std::nullopt;
  const std::filesystem::path directory = executable->parent_path();
  std::wstring command = L"\"" + executable->wstring() + L"\" " + arguments;
  STARTUPINFOW startup{sizeof(startup)};
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(executable->c_str(), command.data(), nullptr, nullptr,
                      FALSE, CREATE_NO_WINDOW, nullptr,
                      directory.c_str(), &startup, &process)) {
    return std::nullopt;
  }
  CloseHandle(process.hThread);
  DWORD wait = WAIT_FAILED;
  if (ready_event) {
    HANDLE handles[] = {ready_event, process.hProcess};
    wait = WaitForMultipleObjects(2, handles, FALSE, timeout_ms);
    if (wait == WAIT_OBJECT_0) {
      CloseHandle(process.hProcess);
      return STILL_ACTIVE;
    }
  } else {
    wait = WaitForSingleObject(process.hProcess, timeout_ms);
  }
  DWORD exit_code = STILL_ACTIVE;
  if (wait != WAIT_OBJECT_0 + (ready_event ? 1 : 0) ||
      !GetExitCodeProcess(process.hProcess, &exit_code)) {
    CloseHandle(process.hProcess);
    return std::nullopt;
  }
  CloseHandle(process.hProcess);
  return exit_code;
}

std::optional<PrivacyPhase> ParsePrivacyPhase(std::string_view value) {
  if (value == "starting") return PrivacyPhase::kStarting;
  if (value == "active") return PrivacyPhase::kActive;
  if (value == "ending") return PrivacyPhase::kEnding;
  if (value == "recovery_required") return PrivacyPhase::kRecoveryRequired;
  if (value == "ended") return PrivacyPhase::kEnded;
  return std::nullopt;
}

const char* PrivacyPhaseName(PrivacyPhase phase) {
  switch (phase) {
    case PrivacyPhase::kStarting:
      return "starting";
    case PrivacyPhase::kActive:
      return "active";
    case PrivacyPhase::kEnding:
      return "ending";
    case PrivacyPhase::kRecoveryRequired:
      return "recovery_required";
    case PrivacyPhase::kEnded:
      return "ended";
  }
  return "";
}

}  // namespace

bool ProtectedSessionStore::Save(const NativeAccountSession& session,
                                 std::string_view expected_issuer) const {
  if (!ValidateSessionState(session.state, expected_issuer,
                            UnixMillisecondsNow())) {
    return false;
  }
  std::vector<uint8_t> clear = SerializeSession(session);
  std::vector<uint8_t> sealed;
  if (clear.empty() || !ProtectBytes(clear, &sealed)) {
    SecureZeroMemory(clear.data(), clear.size());
    return false;
  }
  SecureZeroMemory(clear.data(), clear.size());
  const auto path = SessionPath();
  if (!path) return false;
  std::error_code error;
  std::filesystem::create_directories(path->parent_path(), error);
  if (error) return false;
  const std::filesystem::path temporary = path->wstring() + L".tmp";
  ScopedHandle file(CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr,
                                CREATE_ALWAYS,
                                FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_TEMPORARY,
                                nullptr));
  DWORD written = 0;
  const bool wrote = file.valid() &&
                     WriteFile(file.get(), sealed.data(),
                               static_cast<DWORD>(sealed.size()), &written,
                               nullptr) &&
                     written == static_cast<DWORD>(sealed.size()) &&
                     FlushFileBuffers(file.get());
  SecureZeroMemory(sealed.data(), sealed.size());
  if (!wrote || !MoveFileExW(temporary.c_str(), path->c_str(),
                             MOVEFILE_REPLACE_EXISTING |
                                 MOVEFILE_WRITE_THROUGH)) {
    DeleteFileW(temporary.c_str());
    return false;
  }
  return true;
}

std::optional<NativeAccountSession> ProtectedSessionStore::Load(
    std::string_view expected_issuer) const {
  const auto path = SessionPath();
  if (!path) return std::nullopt;
  const DWORD attributes = GetFileAttributesW(path->c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES ||
      (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
      (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    return std::nullopt;
  }
  ScopedHandle file(CreateFileW(path->c_str(), GENERIC_READ, FILE_SHARE_READ,
                                nullptr, OPEN_EXISTING,
                                FILE_ATTRIBUTE_NORMAL |
                                    FILE_FLAG_OPEN_REPARSE_POINT,
                                nullptr));
  LARGE_INTEGER size{};
  if (!file.valid() || !GetFileSizeEx(file.get(), &size) ||
      size.QuadPart <= 0 || size.QuadPart > kMaximumStoreBytes) {
    return std::nullopt;
  }
  std::vector<uint8_t> sealed(static_cast<size_t>(size.QuadPart));
  DWORD read = 0;
  if (!ReadFile(file.get(), sealed.data(), static_cast<DWORD>(sealed.size()),
                &read, nullptr) ||
      read != static_cast<DWORD>(sealed.size())) {
    SecureZeroMemory(sealed.data(), sealed.size());
    return std::nullopt;
  }
  std::vector<uint8_t> clear;
  const bool unprotected = UnprotectBytes(sealed, &clear);
  SecureZeroMemory(sealed.data(), sealed.size());
  if (!unprotected) return std::nullopt;
  auto session = DeserializeSession(clear);
  SecureZeroMemory(clear.data(), clear.size());
  if (!session || !ValidateSessionState(session->state, expected_issuer,
                                        UnixMillisecondsNow())) {
    return std::nullopt;
  }
  return session;
}

bool ProtectedSessionStore::Remove() const {
  const auto path = SessionPath();
  if (!path) return false;
  return DeleteFileW(path->c_str()) || GetLastError() == ERROR_FILE_NOT_FOUND;
}

OwnerApiClient::OwnerApiClient(std::wstring server_origin)
    : server_origin_(std::move(server_origin)) {
  URL_COMPONENTS components{};
  components.dwStructSize = sizeof(components);
  components.dwSchemeLength = static_cast<DWORD>(-1);
  components.dwHostNameLength = static_cast<DWORD>(-1);
  components.dwUrlPathLength = static_cast<DWORD>(-1);
  components.dwExtraInfoLength = static_cast<DWORD>(-1);
  valid_ = WinHttpCrackUrl(server_origin_.c_str(),
                           static_cast<DWORD>(server_origin_.size()), 0,
                           &components) &&
           components.nScheme == INTERNET_SCHEME_HTTPS &&
           components.dwHostNameLength > 0 &&
           components.dwUrlPathLength <= 1 &&
           components.dwExtraInfoLength == 0;
  if (valid_) {
    issuer_ = WideToUtf8(server_origin_);
    valid_ = !issuer_.empty();
  }
}

OwnerApiClient::~OwnerApiClient() {
  ClearPendingInvitationCreation();
}

void OwnerApiClient::ClearPendingInvitationCreation() {
  if (!pending_invitation_creation_) return;
  SecureClear(&pending_invitation_creation_->raw_token);
  SecureClear(&pending_invitation_creation_->grant_token);
  SecureClear(&pending_invitation_creation_->request_json);
  SecureClear(&pending_invitation_creation_->action_digest);
  SecureClear(&pending_invitation_creation_->token_hash);
  SecureClear(&pending_invitation_creation_->policy_hash);
  SecureClear(&pending_invitation_creation_->creation_request_id);
  SecureClear(&pending_invitation_creation_->label);
  pending_invitation_creation_.reset();
}

std::optional<PkceRequest> OwnerApiClient::CreatePkceRequest() const {
  return valid_ ? GeneratePkce() : std::nullopt;
}

std::optional<std::string> OwnerApiClient::CreateRequestId() const {
  return valid_ ? GenerateOpaque32() : std::nullopt;
}

std::optional<AuthorizationResult> OwnerApiClient::AuthorizeWithSystemBrowser(
    const PkceRequest& request) const {
  if (!valid_ || !IsCanonicalBase64Url32(request.state) ||
      !IsValidPkceVerifier(request.verifier) ||
      !IsCanonicalBase64Url32(request.challenge)) {
    return std::nullopt;
  }
  ScopedWinsock winsock;
  if (!winsock.started()) return std::nullopt;
  auto listener = CreateExactLoopbackListener();
  if (!listener) return std::nullopt;
  const std::wstring authorize =
      server_origin_ + L"/api/auth/remote-desktop/native/authorize?client_id=" +
      UrlEncode(kNativeClientId) + L"&redirect_uri=" +
      UrlEncode(kNativeRedirectUri) + L"&code_challenge=" +
      UrlEncode(request.challenge) + L"&code_challenge_method=S256&state=" +
      UrlEncode(request.state);
  const auto launched = reinterpret_cast<INT_PTR>(ShellExecuteW(
      nullptr, L"open", authorize.c_str(), nullptr, nullptr, SW_SHOWNORMAL));
  if (launched <= 32) return std::nullopt;
  return WaitForLoopback(request, listener->get());
}

std::optional<NativeAccountSession> OwnerApiClient::ExchangeAuthorizationCode(
    const PkceRequest& request,
    const AuthorizationResult& authorization) const {
  if (authorization.state != request.state ||
      !IsCanonicalBase64Url32(authorization.code)) {
    return std::nullopt;
  }
  const std::string issuer = WideToUtf8(server_origin_);
  const std::string body =
      "{\"code\":\"" + JsonEscape(authorization.code) +
      "\",\"codeVerifier\":\"" + JsonEscape(request.verifier) +
      "\",\"state\":\"" + JsonEscape(request.state) +
      "\",\"clientId\":\"" + std::string(kNativeClientId) +
      "\",\"redirectUri\":\"" + std::string(kNativeRedirectUri) +
      "\",\"issuer\":\"" + JsonEscape(issuer) +
      "\",\"audience\":\"" + std::string(kNativeAudience) + "\"}";
  const auto response = Request(
      L"POST", L"/api/auth/remote-desktop/native/exchange", body, {});
  if (!response || response->status != 200) return std::nullopt;
  NativeAccountSession session{};
  if (!JsonString(response->body, "accessToken", &session.access_token) ||
      !JsonString(response->body, "sessionId", &session.state.session_id) ||
      !JsonString(response->body, "userId", &session.state.user_id) ||
      !JsonString(response->body, "clientId", &session.state.client_id) ||
      !JsonString(response->body, "issuer", &session.state.issuer) ||
      !JsonString(response->body, "audience", &session.state.audience) ||
      !JsonUint64(response->body, "expiresAt", &session.state.expires_at) ||
      !ValidateSessionState(session.state, issuer, UnixMillisecondsNow())) {
    SecureZeroMemory(session.access_token.data(), session.access_token.size());
    return std::nullopt;
  }
  return session;
}

bool OwnerApiClient::RevokeSession(const NativeAccountSession& session) const {
  if (!ValidateSessionState(session.state, issuer_, UnixMillisecondsNow())) {
    return false;
  }
  const auto response = Request(
      L"POST", L"/api/auth/remote-desktop/native/session/revoke", "{}",
      session.access_token);
  return response && response->status == 200;
}

bool OwnerApiClient::RequestLaunchContext(
    const NativeAccountSession& session,
    std::string_view canonical_host_id) const {
  if (!ValidateSessionState(session.state, issuer_, UnixMillisecondsNow()) ||
      !IsBoundedOpaqueId(canonical_host_id)) {
    return false;
  }
  const std::string body =
      "{\"hostId\":\"" + JsonEscape(canonical_host_id) + "\"}";
  const auto response = Request(
      L"POST", L"/api/auth/remote-desktop/shell/launch-context/issue",
      body, session.access_token);
  if (!response || response->status != 202) return false;
  std::string status;
  uint64_t expires_at = 0;
  if (!JsonString(response->body, "status", &status) ||
      !JsonUint64(response->body, "expiresAt", &expires_at) ||
      status != "accepted" || expires_at <= UnixMillisecondsNow()) {
    return false;
  }
  return response->body ==
      "{\"status\":\"accepted\",\"expiresAt\":" +
          std::to_string(expires_at) + "}";
}

std::optional<PrivacyEpochState> OwnerApiClient::BeginPrivacy(
    const NativeAccountSession& session,
    const LaunchContext& launch_context,
    std::string_view expected_host_id,
    uint64_t expected_endpoint_generation,
    uint64_t now_ms) const {
  if (!ValidateSessionState(session.state, issuer_, now_ms) ||
      !ValidateLaunchContext(launch_context, expected_host_id,
                             expected_endpoint_generation, now_ms)) {
    return std::nullopt;
  }
  // LaunchContext is submitted only so the Server can one-use redeem the
  // local presentation. Bearer account authority remains the sole Owner
  // authority and the context never substitutes for it.
  const std::string body =
      "{\"hostId\":\"" + JsonEscape(expected_host_id) +
      "\",\"launchContext\":{\"hostId\":\"" +
      JsonEscape(launch_context.host_id) + "\",\"launchId\":\"" +
      JsonEscape(launch_context.launch_id) +
      "\",\"endpointGeneration\":" +
      std::to_string(launch_context.endpoint_generation) +
      ",\"issuedAt\":" + std::to_string(launch_context.issued_at) +
      ",\"expiresAt\":" + std::to_string(launch_context.expires_at) + "}}";
  const auto response = Request(
      L"POST", L"/api/remote-desktop/guest/privacy/begin", body,
      session.access_token);
  if (!response || response->status != 200) return std::nullopt;
  PrivacyEpochState state{};
  state.host_id = std::string(expected_host_id);
  std::string phase;
  if (!JsonString(response->body, "epochId", &state.epoch_id) ||
      !JsonUint64(response->body, "revision", &state.revision) ||
      !JsonString(response->body, "phase", &phase) ||
      !IsBoundedOpaqueId(state.epoch_id) || state.revision == 0) {
    return std::nullopt;
  }
  const auto parsed_phase = ParsePrivacyPhase(phase);
  if (!parsed_phase || (*parsed_phase != PrivacyPhase::kStarting &&
                        *parsed_phase != PrivacyPhase::kActive)) {
    return std::nullopt;
  }
  const std::string canonical =
      "{\"epochId\":\"" + JsonEscape(state.epoch_id) +
      "\",\"revision\":" + std::to_string(state.revision) +
      ",\"phase\":\"" + PrivacyPhaseName(*parsed_phase) + "\"}";
  if (response->body != canonical) return std::nullopt;
  state.phase = *parsed_phase;
  return state;
}

std::optional<PrivacyPhase> OwnerApiClient::GetPrivacyStatus(
    const NativeAccountSession& session,
    const PrivacyEpochState& epoch) const {
  if (!ValidateSessionState(session.state, issuer_, UnixMillisecondsNow()) ||
      !IsBoundedOpaqueId(epoch.host_id) ||
      !IsBoundedOpaqueId(epoch.epoch_id) || epoch.revision == 0) {
    return std::nullopt;
  }
  const std::wstring path =
      L"/api/remote-desktop/guest/privacy/status?hostId=" +
      Utf8ToWide(epoch.host_id) + L"&epochId=" + Utf8ToWide(epoch.epoch_id) +
      L"&revision=" + std::to_wstring(epoch.revision);
  const auto response = Request(L"GET", path, {}, session.access_token);
  if (!response || response->status != 200) return std::nullopt;
  std::string value;
  if (!JsonString(response->body, "status", &value)) return std::nullopt;
  const auto phase = ParsePrivacyPhase(value);
  if (!phase || response->body !=
          "{\"status\":\"" + std::string(PrivacyPhaseName(*phase)) + "\"}") {
    return std::nullopt;
  }
  return phase;
}

std::optional<PrivacyPhase> OwnerApiClient::EndPrivacy(
    const NativeAccountSession& session,
    const PrivacyEpochState& epoch) const {
  if (!ValidateSessionState(session.state, issuer_, UnixMillisecondsNow()) ||
      !IsBoundedOpaqueId(epoch.host_id) ||
      !IsBoundedOpaqueId(epoch.epoch_id) || epoch.revision == 0) {
    return std::nullopt;
  }
  const std::string body =
      "{\"hostId\":\"" + JsonEscape(epoch.host_id) +
      "\",\"epochId\":\"" + JsonEscape(epoch.epoch_id) +
      "\",\"revision\":" + std::to_string(epoch.revision) + "}";
  const auto response = Request(
      L"POST", L"/api/remote-desktop/guest/privacy/end", body,
      session.access_token);
  if (!response || response->status != 200) return std::nullopt;
  std::string value;
  if (!JsonString(response->body, "status", &value)) return std::nullopt;
  const auto phase = ParsePrivacyPhase(value);
  if (!phase || (*phase != PrivacyPhase::kEnding &&
                 *phase != PrivacyPhase::kEnded) ||
      response->body !=
          "{\"status\":\"" + std::string(PrivacyPhaseName(*phase)) + "\"}") {
    return std::nullopt;
  }
  return phase;
}

bool OwnerApiClient::ReportPrivacyRecovery(
    const NativeAccountSession& session,
    const PrivacyEpochState& epoch,
    uint64_t endpoint_generation,
    std::string_view reason) const {
  if (!ValidateSessionState(session.state, issuer_, UnixMillisecondsNow()) ||
      !IsBoundedOpaqueId(epoch.host_id) ||
      !IsBoundedOpaqueId(epoch.epoch_id) || epoch.revision == 0 ||
      (reason != kClipboardWatchdogFailedReason &&
       reason != kClipboardWatchdogCrashedReason &&
       reason != kClipboardCleanupUncertainReason)) {
    return false;
  }
  const std::string body =
      "{\"hostId\":\"" + JsonEscape(epoch.host_id) +
      "\",\"epochId\":\"" + JsonEscape(epoch.epoch_id) +
      "\",\"revision\":" + std::to_string(epoch.revision) +
      ",\"endpointGeneration\":" + std::to_string(endpoint_generation) +
      ",\"reason\":\"" + JsonEscape(reason) + "\"}";
  const auto response = Request(
      L"POST", L"/api/remote-desktop/guest/privacy/recovery", body,
      session.access_token);
  return response && response->status == 200 &&
         response->body == "{\"status\":\"recovery_required\"}";
}

std::optional<HttpResponse> OwnerApiClient::BeginStepUp(
    const NativeAccountSession& session,
    std::string_view canonical_host_id,
    std::string_view request_id,
    uint64_t deadline,
    std::string_view canonical_action_json) const {
  const uint64_t now = UnixMillisecondsNow();
  if (!IsBoundedOpaqueId(canonical_host_id) ||
      !IsCanonicalBase64Url32(request_id) ||
      canonical_action_json.empty() || canonical_action_json.size() > 16 * 1024 ||
      canonical_action_json.front() != '{' || canonical_action_json.back() != '}' ||
      deadline <= now || deadline - now > kMaximumStepUpLifetimeMs ||
      !ValidateSessionState(session.state, issuer_, now)) {
    return std::nullopt;
  }
  const std::string body =
      "{\"canonicalHostId\":\"" + JsonEscape(canonical_host_id) +
      "\",\"requestId\":\"" + JsonEscape(request_id) +
      "\",\"deadline\":" + std::to_string(deadline) +
      ",\"action\":" + std::string(canonical_action_json) + "}";
  return Request(L"POST", L"/api/auth/remote-desktop/step-up/begin", body,
                 session.access_token);
}

std::optional<StepUpState> OwnerApiClient::CompleteStepUpWithSystemBrowser(
    const NativeAccountSession& session,
    const HttpResponse& begin_response,
    std::string_view canonical_host_id,
    std::string_view request_id,
    uint64_t expected_deadline) const {
  const uint64_t now = UnixMillisecondsNow();
  std::string challenge_id;
  std::string action_digest;
  uint64_t deadline = 0;
  if (begin_response.status != 200 ||
      !ValidateSessionState(session.state, issuer_, now) ||
      !IsBoundedOpaqueId(canonical_host_id) ||
      !IsCanonicalBase64Url32(request_id) ||
      !JsonString(begin_response.body, "challengeId", &challenge_id) ||
      !JsonString(begin_response.body, "actionDigest", &action_digest) ||
      !JsonUint64(begin_response.body, "deadline", &deadline) ||
      !IsCanonicalBase64Url32(challenge_id) ||
      action_digest.size() != 64 ||
      !std::all_of(action_digest.begin(), action_digest.end(), [](char value) {
        return (value >= '0' && value <= '9') ||
               (value >= 'a' && value <= 'f');
      }) ||
      deadline != expected_deadline || deadline <= now ||
      deadline - now > kMaximumStepUpLifetimeMs) {
    return std::nullopt;
  }

  // The browser receives only the non-authorizing challenge identifier. It
  // performs user-verified WebAuthn and records a content-free completion.
  // The raw one-use grant returns solely over this native Bearer/TLS channel,
  // never through browser URL/history/DOM or a loopback callback.
  const std::wstring authorize =
      server_origin_ + L"/remote-desktop/native-step-up?challengeId=" +
      UrlEncode(challenge_id);
  const auto launched = reinterpret_cast<INT_PTR>(ShellExecuteW(
      nullptr, L"open", authorize.c_str(), nullptr, nullptr, SW_SHOWNORMAL));
  if (launched <= 32) return std::nullopt;

  const std::string claim_body =
      "{\"challengeId\":\"" + JsonEscape(challenge_id) + "\"}";
  while (UnixMillisecondsNow() < deadline) {
    const auto response = Request(
        L"POST", L"/api/auth/remote-desktop/step-up/native/claim",
        claim_body, session.access_token);
    if (!response) return std::nullopt;
    if (response->status == 200) {
      StepUpState step_up{};
      step_up.canonical_host_id = std::string(canonical_host_id);
      step_up.request_id = std::string(request_id);
      step_up.action_digest = action_digest;
      if (!JsonString(response->body, "grantToken", &step_up.grant_token) ||
          !JsonUint64(response->body, "expiresAt", &step_up.expires_at)) {
        return std::nullopt;
      }
      std::string returned_digest;
      if (!JsonString(response->body, "actionDigest", &returned_digest) ||
          returned_digest != action_digest ||
          !ValidateStepUpState(step_up, canonical_host_id, request_id,
                               action_digest,
                               UnixMillisecondsNow())) {
        SecureZeroMemory(step_up.grant_token.data(),
                         step_up.grant_token.size());
        return std::nullopt;
      }
      return step_up;
    }
    if (response->status != 409) return std::nullopt;
    Sleep(500);
  }
  return std::nullopt;
}

std::optional<HttpResponse> OwnerApiClient::GetOwnerMetadata(
    const NativeAccountSession& session,
    std::wstring_view path_and_query) const {
  if (!path_and_query.starts_with(L"/api/remote-desktop/") ||
      path_and_query.find(L"//") != std::wstring_view::npos ||
      !ValidateSessionState(session.state, issuer_, UnixMillisecondsNow())) {
    return std::nullopt;
  }
  return Request(L"GET", path_and_query, {}, session.access_token);
}

std::optional<std::string> OwnerApiClient::GetOwnerPublicId(
    const NativeAccountSession& session,
    std::string_view canonical_host_id) const {
  if (!IsBoundedOpaqueId(canonical_host_id)) return std::nullopt;
  const auto response = GetOwnerMetadata(
      session, L"/api/remote-desktop/guest/host?hostId=" +
                   Utf8ToWide(canonical_host_id));
  std::string public_id;
  if (!response || response->status != 200 ||
      !JsonString(response->body, "publicNodeId", &public_id) ||
      !IsBoundedOpaqueId(public_id)) {
    return std::nullopt;
  }
  return public_id;
}

std::optional<std::string> OwnerApiClient::RotateOwnerPublicId(
    const NativeAccountSession& session,
    const LaunchContext& launch_context,
    const SecretUiState& secret_ui,
    std::string_view expected_host_id,
    uint64_t expected_endpoint_generation,
    uint64_t now_ms) const {
  if (!secret_ui.signed_in || !secret_ui.launch_context_current ||
      !secret_ui.privacy_active ||
      !ValidateLaunchContext(launch_context, expected_host_id,
                             expected_endpoint_generation, now_ms)) {
    return std::nullopt;
  }
  const auto request_id = CreateRequestId();
  if (!request_id) return std::nullopt;
  const std::string action =
      "{\"hostId\":\"" + JsonEscape(expected_host_id) +
      "\",\"kind\":\"remote_desktop.public_id.rotate\"}";
  const uint64_t deadline = now_ms + 60'000;
  const auto begin = BeginStepUp(session, expected_host_id, *request_id,
                                 deadline, action);
  if (!begin) return std::nullopt;
  auto step_up = CompleteStepUpWithSystemBrowser(
      session, *begin, expected_host_id, *request_id, deadline);
  if (!step_up) return std::nullopt;
  const std::string body =
      "{\"hostId\":\"" + JsonEscape(expected_host_id) +
      "\",\"requestId\":\"" + JsonEscape(*request_id) +
      "\",\"stepUpGrant\":\"" + JsonEscape(step_up->grant_token) + "\"}";
  SecretUiState authorized_ui = secret_ui;
  authorized_ui.step_up_current = true;
  const auto response = CallOwnerMutation(
      session, launch_context, authorized_ui, expected_host_id,
      expected_endpoint_generation, &*step_up, *request_id,
      step_up->action_digest, L"POST",
      L"/api/remote-desktop/guest/host/rotate", body,
      UnixMillisecondsNow());
  std::string public_id;
  if (!response || response->status != 200 ||
      !JsonString(response->body, "publicNodeId", &public_id) ||
      !IsBoundedOpaqueId(public_id)) {
    return std::nullopt;
  }
  return public_id;
}

std::optional<std::vector<OwnerInvitationLink>>
OwnerApiClient::GetOwnerInvitationLinks(
    const NativeAccountSession& session,
    std::string_view canonical_host_id) const {
  if (!IsBoundedOpaqueId(canonical_host_id)) return std::nullopt;
  const auto response = GetOwnerMetadata(
      session, L"/api/remote-desktop/guest/links?hostId=" +
                   Utf8ToWide(canonical_host_id));
  if (!response || response->status != 200) return std::nullopt;
  return ParseOwnerInvitationLinks(response->body);
}

std::optional<CreatedInvitationLink>
OwnerApiClient::CreateOwnerInvitationLink(
    const NativeAccountSession& session,
    const LaunchContext& launch_context,
    const PrivacyEpochState& privacy_epoch,
    const SecretUiState& secret_ui,
    std::string_view expected_host_id,
    uint64_t expected_endpoint_generation,
    InvitationLinkKind kind,
    InvitationLinkMode mode,
    std::string_view label,
    std::optional<uint64_t> duration_ms,
    uint64_t now_ms) {
  if (!secret_ui.signed_in || !secret_ui.launch_context_current ||
      !secret_ui.privacy_active || privacy_epoch.host_id != expected_host_id ||
      privacy_epoch.revision == 0 ||
      !IsBoundedOpaqueId(privacy_epoch.epoch_id) || label.empty() ||
      label.size() > 256 ||
      !std::all_of(label.begin(), label.end(), [](char value) {
        return static_cast<unsigned char>(value) >= 0x20;
      }) || !IsSupportedLinkDuration(duration_ms) ||
      (kind == InvitationLinkKind::kAttended) != !duration_ms ||
      !ValidateLaunchContext(launch_context, expected_host_id,
                             expected_endpoint_generation, now_ms)) {
    return std::nullopt;
  }

  std::array<uint8_t, 32> policy_digest{};
  const uint8_t separator = 0;
  const std::string kind_name(InvitationLinkKindName(kind));
  const std::string mode_name(InvitationLinkModeName(mode));
  const std::string escaped_label = JsonEscape(label);
  const std::string policy =
      "[\"" + JsonEscape(expected_host_id) + "\",\"" + kind_name +
      "\",\"" + mode_name + "\"," +
      (duration_ms ? std::to_string(*duration_ms) : "null") +
      ",\"" + escaped_label + "\"]";
  if (escaped_label.empty() ||
      !Sha256({
        {reinterpret_cast<const uint8_t*>(kLinkPolicyHashDomain.data()),
         kLinkPolicyHashDomain.size()},
        {&separator, 1},
        {reinterpret_cast<const uint8_t*>(policy.data()), policy.size()}},
        &policy_digest)) {
    return std::nullopt;
  }
  const std::string policy_hash = LowerHex(policy_digest.data(),
                                           policy_digest.size());
  SecureZeroMemory(policy_digest.data(), policy_digest.size());

  // A previous dispatch may have committed even though WinHTTP lost the
  // response. Never mint a second authority in that state: only the exact
  // host/epoch/policy action can replay the retained grant and raw bearer.
  if (pending_invitation_creation_) {
    if (!PendingInvitationMatches(
            *pending_invitation_creation_, privacy_epoch, expected_host_id,
            expected_endpoint_generation, kind, mode, label, duration_ms,
            policy_hash)) {
      return std::nullopt;
    }
    return DispatchPendingInvitationCreation(session);
  }

  std::array<uint8_t, 32> raw{};
  std::array<uint8_t, 32> token_digest{};
  if (BCryptGenRandom(nullptr, raw.data(), static_cast<ULONG>(raw.size()),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
    return std::nullopt;
  }
  if (!Sha256({
        {reinterpret_cast<const uint8_t*>(kLinkHashDomain.data()),
         kLinkHashDomain.size()},
        {&separator, 1},
        {raw.data(), raw.size()}}, &token_digest)) {
    SecureZeroMemory(raw.data(), raw.size());
    return std::nullopt;
  }
  std::string raw_token = Base64Url(raw.data(), static_cast<DWORD>(raw.size()));
  SecureZeroMemory(raw.data(), raw.size());
  if (!IsCanonicalBase64Url32(raw_token)) {
    SecureClear(&raw_token);
    return std::nullopt;
  }
  const std::string token_hash = LowerHex(token_digest.data(),
                                          token_digest.size());
  SecureZeroMemory(token_digest.data(), token_digest.size());

  const auto request_id = CreateRequestId();
  if (!request_id) {
    SecureClear(&raw_token);
    return std::nullopt;
  }
  const std::string action =
      "{\"kind\":\"remote_desktop.link.create\",\"hostId\":\"" +
      JsonEscape(expected_host_id) + "\",\"creationRequestId\":\"" +
      JsonEscape(*request_id) + "\",\"tokenHash\":\"" + token_hash +
      "\",\"policyHash\":\"" + policy_hash + "\"}";
  const uint64_t deadline = now_ms + 60'000;
  const auto begin = BeginStepUp(session, expected_host_id, *request_id,
                                 deadline, action);
  auto step_up = begin ? CompleteStepUpWithSystemBrowser(
                             session, *begin, expected_host_id, *request_id,
                             deadline)
                       : std::nullopt;
  if (!step_up) {
    SecureClear(&raw_token);
    return std::nullopt;
  }
  std::string request =
      "{\"hostId\":\"" + JsonEscape(expected_host_id) +
      "\",\"creationRequestId\":\"" + JsonEscape(*request_id) +
      "\",\"tokenHashVersion\":\"v1\",\"tokenHash\":\"" + token_hash +
      "\",\"kind\":\"" + kind_name + "\",\"mode\":\"" + mode_name +
      "\",\"label\":\"" + escaped_label + "\"" +
      (duration_ms ? ",\"durationMs\":" + std::to_string(*duration_ms) : "") +
      "}";

  // Keep one bounded memory-only recovery tuple before the first dispatch.
  // The raw bearer and consumed grant never leave this process except in their
  // respective TLS request fields, and are securely erased on every terminal
  // lifecycle path.
  PendingInvitationCreation pending{};
  pending.canonical_host_id = std::string(expected_host_id);
  pending.endpoint_generation = expected_endpoint_generation;
  pending.privacy_epoch_id = privacy_epoch.epoch_id;
  pending.privacy_revision = privacy_epoch.revision;
  pending.kind = kind;
  pending.mode = mode;
  pending.label = std::string(label);
  pending.duration_ms = duration_ms;
  pending.creation_request_id = *request_id;
  pending.raw_token = raw_token;
  pending.token_hash = token_hash;
  pending.policy_hash = policy_hash;
  pending.request_json = request;
  pending.action_digest = step_up->action_digest;
  pending.grant_token = step_up->grant_token;
  pending_invitation_creation_ = std::move(pending);

  std::string body =
      "{\"request\":" + request + ",\"privacyEpoch\":{\"epochId\":\"" +
      JsonEscape(privacy_epoch.epoch_id) + "\",\"revision\":" +
      std::to_string(privacy_epoch.revision) + "},\"stepUpGrant\":\"" +
      JsonEscape(step_up->grant_token) + "\"}";
  SecretUiState authorized_ui = secret_ui;
  authorized_ui.step_up_current = true;
  const auto response = CallOwnerMutation(
      session, launch_context, authorized_ui, expected_host_id,
      expected_endpoint_generation, &*step_up, *request_id,
      step_up->action_digest, L"POST", L"/api/remote-desktop/guest/links",
      body, UnixMillisecondsNow());
  SecureClear(&body);
  SecureClear(&request);
  SecureClear(&raw_token);
  return CompletePendingInvitationCreation(response);
}

bool OwnerApiClient::PendingInvitationMatches(
    const PendingInvitationCreation& pending,
    const PrivacyEpochState& privacy_epoch,
    std::string_view expected_host_id,
    uint64_t expected_endpoint_generation,
    InvitationLinkKind kind,
    InvitationLinkMode mode,
    std::string_view label,
    std::optional<uint64_t> duration_ms,
    std::string_view policy_hash) const {
  return pending.canonical_host_id == expected_host_id &&
         pending.endpoint_generation == expected_endpoint_generation &&
         pending.privacy_epoch_id == privacy_epoch.epoch_id &&
         pending.privacy_revision == privacy_epoch.revision &&
         pending.kind == kind && pending.mode == mode &&
         pending.label == label && pending.duration_ms == duration_ms &&
         pending.policy_hash == policy_hash &&
         IsCanonicalBase64Url32(pending.creation_request_id) &&
         IsCanonicalBase64Url32(pending.raw_token) &&
         pending.token_hash.size() == 64 &&
         pending.action_digest.size() == 64 &&
         pending.grant_token.starts_with(kStepUpGrantPrefix) &&
         !pending.request_json.empty() &&
         pending.request_json.size() <= kMaximumHttpBodyBytes;
}

std::optional<CreatedInvitationLink>
OwnerApiClient::DispatchPendingInvitationCreation(
    const NativeAccountSession& session) {
  if (!pending_invitation_creation_ ||
      !ValidateSessionState(session.state, issuer_, UnixMillisecondsNow())) {
    return std::nullopt;
  }
  const auto& pending = *pending_invitation_creation_;
  std::string body =
      "{\"request\":" + pending.request_json +
      ",\"privacyEpoch\":{\"epochId\":\"" +
      JsonEscape(pending.privacy_epoch_id) + "\",\"revision\":" +
      std::to_string(pending.privacy_revision) +
      "},\"stepUpGrant\":\"" + JsonEscape(pending.grant_token) + "\"}";
  const auto response = Request(
      L"POST", L"/api/remote-desktop/guest/links", body,
      session.access_token);
  SecureClear(&body);
  return CompletePendingInvitationCreation(response);
}

std::optional<CreatedInvitationLink>
OwnerApiClient::CompletePendingInvitationCreation(
    const std::optional<HttpResponse>& response) {
  if (!pending_invitation_creation_) return std::nullopt;
  // No HTTP response is an indeterminate dispatch. Retain the exact tuple.
  if (!response) return std::nullopt;
  // A bounded 4xx response is a definitive rejection before any usable
  // original result. A 5xx response can still follow a committed transaction,
  // so retain it just like a dropped/malformed success and require exact replay.
  if (response->status >= 400 && response->status < 500) {
    ClearPendingInvitationCreation();
    return std::nullopt;
  }
  if (response->status != 200 && response->status != 201) {
    return std::nullopt;
  }
  const auto object = JsonObjectAfter(response->body, "link");
  const auto link = object ? ParseOwnerInvitationLink(*object) : std::nullopt;
  if (!link) {
    // A malformed success could follow a commit; retain and replay rather than
    // orphaning the raw bearer or creating a second link.
    return std::nullopt;
  }
  CreatedInvitationLink created{};
  created.link = *link;
  created.invitation_url = server_origin_ + L"/#invite=v1." +
                           Utf8ToWide(pending_invitation_creation_->raw_token);
  if (created.invitation_url.size() > 4096) {
    SecureClear(&created.invitation_url);
    return std::nullopt;
  }
  ClearPendingInvitationCreation();
  return created;
}

namespace {

std::optional<OwnerInvitationLink> MutateOwnerInvitationLink(
    const OwnerApiClient& api,
    const NativeAccountSession& session,
    const LaunchContext& launch_context,
    const PrivacyEpochState& privacy_epoch,
    const SecretUiState& secret_ui,
    std::string_view expected_host_id,
    uint64_t expected_endpoint_generation,
    std::string_view link_id,
    std::string_view mutation,
    std::wstring_view method,
    uint64_t now_ms) {
  if (!IsBoundedOpaqueId(link_id) ||
      privacy_epoch.host_id != expected_host_id ||
      privacy_epoch.revision == 0 ||
      !IsBoundedOpaqueId(privacy_epoch.epoch_id)) {
    return std::nullopt;
  }
  const auto request_id = api.CreateRequestId();
  if (!request_id) return std::nullopt;
  const std::string action =
      "{\"kind\":\"remote_desktop.link.mutate\",\"hostId\":\"" +
      JsonEscape(expected_host_id) + "\",\"linkId\":\"" +
      JsonEscape(link_id) + "\",\"mutation\":\"" +
      JsonEscape(mutation) + "\",\"label\":null,\"expiresAt\":null}";
  const uint64_t deadline = now_ms + 60'000;
  const auto begin = api.BeginStepUp(session, expected_host_id, *request_id,
                                     deadline, action);
  auto step_up = begin ? api.CompleteStepUpWithSystemBrowser(
                             session, *begin, expected_host_id, *request_id,
                             deadline)
                       : std::nullopt;
  if (!step_up) return std::nullopt;
  std::string body =
      "{\"hostId\":\"" + JsonEscape(expected_host_id) +
      "\",\"requestId\":\"" + JsonEscape(*request_id) + "\"" +
      (method == L"PATCH" ? ",\"mutation\":\"" +
                                JsonEscape(mutation) + "\"" : "") +
      ",\"privacyEpoch\":{\"epochId\":\"" +
      JsonEscape(privacy_epoch.epoch_id) + "\",\"revision\":" +
      std::to_string(privacy_epoch.revision) + "},\"stepUpGrant\":\"" +
      JsonEscape(step_up->grant_token) + "\"}";
  SecretUiState authorized_ui = secret_ui;
  authorized_ui.step_up_current = true;
  const std::wstring path = L"/api/remote-desktop/guest/links/" +
                            Utf8ToWide(link_id);
  const auto response = api.CallOwnerMutation(
      session, launch_context, authorized_ui, expected_host_id,
      expected_endpoint_generation, &*step_up, *request_id,
      step_up->action_digest, method, path, body,
      UnixMillisecondsNow());
  SecureClear(&body);
  if (!response || response->status != 200) return std::nullopt;
  const auto object = JsonObjectAfter(response->body, "link");
  return object ? ParseOwnerInvitationLink(*object) : std::nullopt;
}

}  // namespace

std::optional<OwnerInvitationLink>
OwnerApiClient::ReduceOwnerInvitationLinkToView(
    const NativeAccountSession& session,
    const LaunchContext& launch_context,
    const PrivacyEpochState& privacy_epoch,
    const SecretUiState& secret_ui,
    std::string_view expected_host_id,
    uint64_t expected_endpoint_generation,
    std::string_view link_id,
    uint64_t now_ms) const {
  return MutateOwnerInvitationLink(
      *this, session, launch_context, privacy_epoch, secret_ui,
      expected_host_id, expected_endpoint_generation, link_id,
      "reduce_to_view", L"PATCH", now_ms);
}

std::optional<OwnerInvitationLink>
OwnerApiClient::RevokeOwnerInvitationLink(
    const NativeAccountSession& session,
    const LaunchContext& launch_context,
    const PrivacyEpochState& privacy_epoch,
    const SecretUiState& secret_ui,
    std::string_view expected_host_id,
    uint64_t expected_endpoint_generation,
    std::string_view link_id,
    uint64_t now_ms) const {
  return MutateOwnerInvitationLink(
      *this, session, launch_context, privacy_epoch, secret_ui,
      expected_host_id, expected_endpoint_generation, link_id, "revoke",
      L"DELETE", now_ms);
}

bool OwnerApiClient::MutateOwnerUnattendedPassword(
    const NativeAccountSession& session,
    const LaunchContext& launch_context,
    const PrivacyEpochState& privacy_epoch,
    const SecretUiState& secret_ui,
    std::string_view expected_host_id,
    uint64_t expected_endpoint_generation,
    PasswordMutationAction action,
    std::string* password,
    uint64_t now_ms) const {
  const bool needs_password = action != PasswordMutationAction::kDisable;
  const bool invalid_password = password &&
      (password->size() < 12 || password->size() > 256 ||
       std::any_of(password->begin(), password->end(), [](char value) {
         return static_cast<unsigned char>(value) < 0x20;
       }));
  if (privacy_epoch.host_id != expected_host_id ||
      privacy_epoch.revision == 0 ||
      !IsBoundedOpaqueId(privacy_epoch.epoch_id) ||
      needs_password != (password != nullptr) || invalid_password) {
    if (password) SecureClear(password);
    return false;
  }
  const auto request_id = CreateRequestId();
  if (!request_id) {
    if (password) SecureClear(password);
    return false;
  }
  const std::string action_name(PasswordMutationActionName(action));
  const std::string step_up_action =
      "{\"type\":\"remote_desktop.unattended_password.mutation.v1\","
      "\"hostId\":\"" + JsonEscape(expected_host_id) +
      "\",\"action\":\"" + action_name + "\",\"requestId\":\"" +
      JsonEscape(*request_id) + "\"}";
  const uint64_t deadline = now_ms + 60'000;
  const auto begin = BeginStepUp(session, expected_host_id, *request_id,
                                 deadline, step_up_action);
  auto step_up = begin ? CompleteStepUpWithSystemBrowser(
                             session, *begin, expected_host_id, *request_id,
                             deadline)
                       : std::nullopt;
  if (!step_up) {
    if (password) SecureClear(password);
    return false;
  }
  std::string mutation =
      "{\"hostId\":\"" + JsonEscape(expected_host_id) +
      "\",\"action\":\"" + action_name + "\",\"requestId\":\"" +
      JsonEscape(*request_id) + "\"";
  if (password) mutation += ",\"password\":\"" + JsonEscape(*password) + "\"";
  mutation += "}";
  std::string body =
      "{\"mutation\":" + mutation +
      ",\"privacyEpoch\":{\"epochId\":\"" +
      JsonEscape(privacy_epoch.epoch_id) + "\",\"revision\":" +
      std::to_string(privacy_epoch.revision) + "},\"stepUpGrant\":\"" +
      JsonEscape(step_up->grant_token) + "\"}";
  if (password) SecureClear(password);
  SecretUiState authorized_ui = secret_ui;
  authorized_ui.step_up_current = true;
  const auto response = CallOwnerMutation(
      session, launch_context, authorized_ui, expected_host_id,
      expected_endpoint_generation, &*step_up, *request_id,
      step_up->action_digest, L"POST",
      L"/api/remote-desktop/unattended-password", body,
      UnixMillisecondsNow());
  SecureClear(&mutation);
  SecureClear(&body);
  return response && response->status == 200;
}

std::optional<HttpResponse> OwnerApiClient::CallOwnerMutation(
    const NativeAccountSession& session,
    const LaunchContext& launch_context,
    const SecretUiState& secret_ui,
    std::string_view expected_host_id,
    uint64_t expected_endpoint_generation,
    StepUpState* step_up,
    std::string_view expected_request_id,
    std::string_view expected_action_digest,
    std::wstring_view method,
    std::wstring_view path_and_query,
    std::string_view json_body,
    uint64_t now_ms) const {
  if ((method != L"POST" && method != L"PATCH" && method != L"DELETE") ||
      !path_and_query.starts_with(L"/api/remote-desktop/") ||
      path_and_query.find(L"//") != std::wstring_view::npos ||
      json_body.empty() || json_body.size() > kMaximumHttpBodyBytes ||
      !ValidateSessionState(session.state, issuer_, now_ms) ||
      !ValidateLaunchContext(launch_context, expected_host_id,
                             expected_endpoint_generation, now_ms) ||
      !SecretUiEnabled(secret_ui) ||
      !step_up ||
      !ValidateStepUpState(*step_up, expected_host_id,
                           expected_request_id, expected_action_digest,
                           now_ms) ||
      json_body.find("\"stepUpGrant\":\"" +
                     JsonEscape(step_up->grant_token) + "\"") ==
          std::string_view::npos) {
    return std::nullopt;
  }
  // A dispatched native mutation never reuses its local grant, regardless of
  // transport outcome. The Server separately consumes the signed grant in the
  // same transaction as the authority change.
  if (!ConsumeStepUp(step_up, expected_host_id, expected_request_id,
                     expected_action_digest, now_ms)) {
    return std::nullopt;
  }
  const auto response = Request(method, path_and_query, json_body,
                                session.access_token);
  SecureZeroMemory(step_up->grant_token.data(), step_up->grant_token.size());
  step_up->grant_token.clear();
  return response;
}

std::optional<HttpResponse> OwnerApiClient::Request(
    std::wstring_view method, std::wstring_view path_and_query,
    std::string_view json_body, std::string_view bearer) const {
  if (!valid_ || method.empty() || path_and_query.empty() ||
      path_and_query.size() > 4096 || json_body.size() > kMaximumHttpBodyBytes) {
    return std::nullopt;
  }
  URL_COMPONENTS components{};
  components.dwStructSize = sizeof(components);
  components.dwHostNameLength = static_cast<DWORD>(-1);
  components.dwUrlPathLength = static_cast<DWORD>(-1);
  if (!WinHttpCrackUrl(server_origin_.c_str(),
                       static_cast<DWORD>(server_origin_.size()), 0,
                       &components) || components.nScheme != INTERNET_SCHEME_HTTPS) {
    return std::nullopt;
  }
  const std::wstring host(components.lpszHostName, components.dwHostNameLength);
  ScopedInternet session(WinHttpOpen(L"IM.codes Remote Desktop/1.0",
                                     WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                                     WINHTTP_NO_PROXY_NAME,
                                     WINHTTP_NO_PROXY_BYPASS, 0));
  if (!session.valid() ||
      !WinHttpSetTimeouts(session.get(), kHttpTimeoutMs, kHttpTimeoutMs,
                          kHttpTimeoutMs, kHttpTimeoutMs)) {
    return std::nullopt;
  }
  ScopedInternet connection(WinHttpConnect(session.get(), host.c_str(),
                                            components.nPort, 0));
  if (!connection.valid()) return std::nullopt;
  const std::wstring method_copy(method);
  const std::wstring path_copy(path_and_query);
  ScopedInternet request(WinHttpOpenRequest(
      connection.get(), method_copy.c_str(), path_copy.c_str(), nullptr,
      WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE));
  if (!request.valid()) return std::nullopt;
  std::wstring headers = L"Accept: application/json\r\nContent-Type: application/json\r\n";
  if (!bearer.empty()) {
    const std::wstring wide_bearer = Utf8ToWide(bearer);
    if (wide_bearer.empty()) return std::nullopt;
    headers += L"Authorization: Bearer " + wide_bearer + L"\r\n";
  }
  if (!WinHttpSendRequest(
          request.get(), headers.c_str(), static_cast<DWORD>(headers.size()),
          json_body.empty() ? WINHTTP_NO_REQUEST_DATA
                            : const_cast<char*>(json_body.data()),
          static_cast<DWORD>(json_body.size()),
          static_cast<DWORD>(json_body.size()), 0) ||
      !WinHttpReceiveResponse(request.get(), nullptr)) {
    return std::nullopt;
  }
  DWORD status = 0;
  DWORD status_size = sizeof(status);
  if (!WinHttpQueryHeaders(request.get(),
                           WINHTTP_QUERY_STATUS_CODE |
                               WINHTTP_QUERY_FLAG_NUMBER,
                           WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size,
                           WINHTTP_NO_HEADER_INDEX)) {
    return std::nullopt;
  }
  HttpResponse response{status, {}};
  for (;;) {
    DWORD available = 0;
    if (!WinHttpQueryDataAvailable(request.get(), &available)) return std::nullopt;
    if (available == 0) break;
    if (available > kMaximumHttpBodyBytes - response.body.size()) {
      return std::nullopt;
    }
    const size_t offset = response.body.size();
    response.body.resize(offset + available);
    DWORD read = 0;
    if (!WinHttpReadData(request.get(), response.body.data() + offset,
                         available, &read) || read == 0) {
      return std::nullopt;
    }
    response.body.resize(offset + read);
  }
  return response;
}

bool CopyInvitationLinkWithWatchdog(std::wstring_view invitation_link,
                                    std::string_view epoch_id,
                                    uint64_t* cleanup_deadline_ms) {
  if (!cleanup_deadline_ms || !IsBoundedOpaqueId(epoch_id) ||
      invitation_link.size() < 9 || invitation_link.size() > 4096 ||
      !invitation_link.starts_with(L"https://")) {
    return false;
  }
  std::array<uint8_t, 32> hash{};
  if (!Sha256({
        {reinterpret_cast<const uint8_t*>(invitation_link.data()),
         invitation_link.size() * sizeof(wchar_t)}}, &hash)) {
    return false;
  }
  const uint32_t baseline = GetClipboardSequenceNumber();
  const uint64_t deadline = UnixMillisecondsNow() +
                            kClipboardCleanupLifetimeMs;
  const auto ready_name = RandomReadyEventName();
  if (!ready_name) return false;
  ScopedHandle ready(CreateEventW(nullptr, TRUE, FALSE, ready_name->c_str()));
  if (!ready.valid()) return false;
  const std::wstring arguments =
      L"--watch --epoch " + Utf8ToWide(epoch_id) + L" --sha256 " +
      WidenLowerHex(hash.data(), hash.size()) + L" --deadline-at " +
      std::to_wstring(deadline) + L" --baseline-sequence " +
      std::to_wstring(baseline) + L" --ready-event " + *ready_name;
  SecureZeroMemory(hash.data(), hash.size());
  const auto launched = RunWatchdogProcess(arguments, kWatchdogReadyTimeoutMs,
                                            ready.get());
  if (!launched || *launched != STILL_ACTIVE ||
      !WriteInvitationClipboard(invitation_link)) {
    return false;
  }
  *cleanup_deadline_ms = deadline;
  return true;
}

ClipboardCleanupStatus ReconcileClipboardWatchdog() {
  const auto result = RunWatchdogProcess(L"--sanitize",
                                         kWatchdogSanitizeTimeoutMs);
  if (!result) return ClipboardCleanupStatus::kFailed;
  if (*result == 0) return ClipboardCleanupStatus::kClean;
  if (*result == 31 || *result == STILL_ACTIVE) {
    return ClipboardCleanupStatus::kPending;
  }
  return ClipboardCleanupStatus::kFailed;
}

}  // namespace imcodes::remote_desktop::account_shell
