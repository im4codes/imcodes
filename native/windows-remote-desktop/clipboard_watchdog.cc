#include "third_party/imcodes_remote_desktop/clipboard_watchdog.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstring>
#include <cwchar>
#include <filesystem>
#include <limits>
#include <optional>
#include <string_view>
#include <vector>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <bcrypt.h>
#include <shlobj.h>
#include <wincrypt.h>

#include "third_party/imcodes_remote_desktop/clipboard_watchdog_policy.h"

namespace imcodes::remote_desktop::clipboard_watchdog {
namespace {

constexpr uint32_t kMarkerMagic = 0x57434d49;  // IMCW, little-endian.
constexpr uint16_t kMarkerVersion = 1;
constexpr size_t kMaximumEpochBytes = 128;
constexpr DWORD kClipboardRetryCount = 20;
constexpr DWORD kClipboardRetryDelayMs = 25;
constexpr DWORD kPollDelayMs = 100;
constexpr wchar_t kInstanceMutex[] = L"Local\\IMCodesClipboardWatchdog";

#pragma pack(push, 1)
struct PersistedMarker {
  uint32_t magic = kMarkerMagic;
  uint16_t version = kMarkerVersion;
  uint8_t phase = static_cast<uint8_t>(MarkerPhase::kArmed);
  uint8_t reserved = 0;
  uint32_t sequence = 0;
  uint64_t deadline_unix_ms = 0;
  uint16_t epoch_size = 0;
  std::array<uint8_t, kMaximumEpochBytes> epoch{};
  Sha256 expected_hash{};
};
#pragma pack(pop)

static_assert(sizeof(PersistedMarker) < 256);

enum class MarkerLoadResult { kAbsent, kLoaded, kUnavailable };
enum class ClipboardReadResult { kRead, kUnavailable };

class ScopedSingleInstance {
 public:
  ScopedSingleInstance() : handle_(CreateMutexW(nullptr, FALSE, kInstanceMutex)) {
    if (!handle_) return;
    const DWORD wait = WaitForSingleObject(handle_, 0);
    acquired_ = wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED;
  }
  ~ScopedSingleInstance() {
    if (acquired_) ReleaseMutex(handle_);
    if (handle_) CloseHandle(handle_);
  }
  ScopedSingleInstance(const ScopedSingleInstance&) = delete;
  ScopedSingleInstance& operator=(const ScopedSingleInstance&) = delete;
  bool acquired() const { return acquired_; }

 private:
  HANDLE handle_ = nullptr;
  bool acquired_ = false;
};

uint64_t UnixMillisecondsNow() {
  return static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch())
          .count());
}

std::optional<std::filesystem::path> MarkerPath() {
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
  path /= L"clipboard-watchdog.bin";
  return path;
}

bool Protect(const PersistedMarker& marker, std::vector<uint8_t>* sealed) {
  DATA_BLOB input{
      static_cast<DWORD>(sizeof(marker)),
      reinterpret_cast<BYTE*>(const_cast<PersistedMarker*>(&marker))};
  DATA_BLOB output{};
  if (!CryptProtectData(&input, L"IM.codes clipboard watchdog", nullptr,
                        nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)) {
    return false;
  }
  sealed->assign(output.pbData, output.pbData + output.cbData);
  SecureZeroMemory(output.pbData, output.cbData);
  LocalFree(output.pbData);
  return true;
}

bool Unprotect(const std::vector<uint8_t>& sealed, PersistedMarker* marker) {
  if (sealed.empty() || sealed.size() > 4096) return false;
  DATA_BLOB input{static_cast<DWORD>(sealed.size()),
                  const_cast<BYTE*>(sealed.data())};
  DATA_BLOB output{};
  if (!CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr,
                          CRYPTPROTECT_UI_FORBIDDEN, &output)) {
    return false;
  }
  const bool exact = output.cbData == sizeof(*marker);
  if (exact) std::memcpy(marker, output.pbData, sizeof(*marker));
  SecureZeroMemory(output.pbData, output.cbData);
  LocalFree(output.pbData);
  if (!exact || marker->magic != kMarkerMagic ||
      marker->version != kMarkerVersion || marker->reserved != 0 ||
      marker->epoch_size == 0 || marker->epoch_size > kMaximumEpochBytes ||
      (marker->phase != static_cast<uint8_t>(MarkerPhase::kArmed) &&
       marker->phase != static_cast<uint8_t>(MarkerPhase::kOwned))) {
    SecureZeroMemory(marker, sizeof(*marker));
    return false;
  }
  return true;
}

bool PersistMarker(const PersistedMarker& marker) {
  const auto path = MarkerPath();
  if (!path) return false;
  std::error_code error;
  std::filesystem::create_directories(path->parent_path(), error);
  if (error) return false;

  std::vector<uint8_t> sealed;
  if (!Protect(marker, &sealed)) return false;
  const std::filesystem::path temporary = path->wstring() + L".tmp";
  HANDLE file = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr,
                            CREATE_ALWAYS,
                            FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_TEMPORARY,
                            nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0;
  const bool wrote = sealed.size() <= std::numeric_limits<DWORD>::max() &&
                     WriteFile(file, sealed.data(),
                               static_cast<DWORD>(sealed.size()), &written,
                               nullptr) &&
                     written == static_cast<DWORD>(sealed.size()) &&
                     FlushFileBuffers(file);
  CloseHandle(file);
  SecureZeroMemory(sealed.data(), sealed.size());
  if (!wrote ||
      !MoveFileExW(temporary.c_str(), path->c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    DeleteFileW(temporary.c_str());
    return false;
  }
  return true;
}

MarkerLoadResult LoadMarker(PersistedMarker* marker) {
  const auto path = MarkerPath();
  if (!path) return MarkerLoadResult::kUnavailable;
  HANDLE file = CreateFileW(path->c_str(), GENERIC_READ, FILE_SHARE_READ,
                            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL,
                            nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    return GetLastError() == ERROR_FILE_NOT_FOUND
               ? MarkerLoadResult::kAbsent
               : MarkerLoadResult::kUnavailable;
  }
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file, &size) || size.QuadPart <= 0 ||
      size.QuadPart > 4096) {
    CloseHandle(file);
    return MarkerLoadResult::kUnavailable;
  }
  std::vector<uint8_t> sealed(static_cast<size_t>(size.QuadPart));
  DWORD read = 0;
  const bool read_ok = ReadFile(file, sealed.data(),
                                static_cast<DWORD>(sealed.size()), &read,
                                nullptr) &&
                       read == static_cast<DWORD>(sealed.size());
  CloseHandle(file);
  const bool decoded = read_ok && Unprotect(sealed, marker);
  SecureZeroMemory(sealed.data(), sealed.size());
  return decoded ? MarkerLoadResult::kLoaded
                 : MarkerLoadResult::kUnavailable;
}

bool RemoveMarker() {
  const auto path = MarkerPath();
  if (!path) return false;
  return DeleteFileW(path->c_str()) || GetLastError() == ERROR_FILE_NOT_FOUND;
}

bool OpenClipboardWithRetry() {
  for (DWORD attempt = 0; attempt < kClipboardRetryCount; ++attempt) {
    if (OpenClipboard(nullptr)) return true;
    Sleep(kClipboardRetryDelayMs);
  }
  return false;
}

bool HashBytes(const uint8_t* bytes, size_t size, Sha256* output) {
  if (!output || size > std::numeric_limits<ULONG>::max()) return false;
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr,
                                  0) != 0) {
    return false;
  }
  const NTSTATUS status = BCryptHash(
      algorithm, nullptr, 0, const_cast<PUCHAR>(bytes),
      static_cast<ULONG>(size), output->data(),
      static_cast<ULONG>(output->size()));
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return status == 0;
}

bool ReadOpenClipboardHash(uint32_t* sequence,
                           bool* has_text,
                           Sha256* hash) {
  *sequence = GetClipboardSequenceNumber();
  *has_text = false;
  bool ok = true;
  HANDLE data = GetClipboardData(CF_UNICODETEXT);
  if (data) {
    const auto* text = static_cast<const wchar_t*>(GlobalLock(data));
    if (!text) {
      ok = false;
    } else {
      const size_t characters = wcsnlen_s(
          text, GlobalSize(data) / sizeof(wchar_t));
      if (characters == GlobalSize(data) / sizeof(wchar_t)) {
        ok = false;
      } else {
        *has_text = true;
        ok = HashBytes(reinterpret_cast<const uint8_t*>(text),
                       characters * sizeof(wchar_t), hash);
      }
      GlobalUnlock(data);
    }
  }
  return ok;
}

ClipboardReadResult ReadClipboardHash(uint32_t* sequence,
                                      bool* has_text,
                                      Sha256* hash) {
  if (!OpenClipboardWithRetry()) return ClipboardReadResult::kUnavailable;
  const bool ok = ReadOpenClipboardHash(sequence, has_text, hash);
  CloseClipboard();
  return ok ? ClipboardReadResult::kRead
            : ClipboardReadResult::kUnavailable;
}

bool SetOptOutFormat(UINT format) {
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

int ReconcileMarker(const PersistedMarker& marker) {
  // Hash/sequence verification and EmptyClipboard share one clipboard lock;
  // a local replacement cannot race into the gap and be erased.
  if (!OpenClipboardWithRetry()) return 20;
  uint32_t current_sequence = 0;
  bool has_text = false;
  Sha256 current_hash{};
  if (!ReadOpenClipboardHash(&current_sequence, &has_text, &current_hash)) {
    CloseClipboard();
    return 20;  // Keep the marker: cleanup is not proven.
  }
  const bool matches = has_text && current_hash == marker.expected_hash;
  const auto phase = static_cast<MarkerPhase>(marker.phase);
  if (DecideCleanup(phase, marker.sequence, current_sequence, matches) ==
      CleanupDecision::kClear) {
    if (!EmptyClipboard()) {
      CloseClipboard();
      return 21;
    }
  }
  CloseClipboard();
  return RemoveMarker() ? 0 : 22;
}

}  // namespace

bool ParseSha256Hex(const std::wstring& value, Sha256* output) {
  if (!output || value.size() != output->size() * 2) return false;
  auto digit = [](wchar_t character) -> int {
    if (character >= L'0' && character <= L'9') return character - L'0';
    if (character >= L'a' && character <= L'f') return character - L'a' + 10;
    if (character >= L'A' && character <= L'F') return character - L'A' + 10;
    return -1;
  };
  for (size_t index = 0; index < output->size(); ++index) {
    const int high = digit(value[index * 2]);
    const int low = digit(value[index * 2 + 1]);
    if (high < 0 || low < 0) return false;
    (*output)[index] = static_cast<uint8_t>((high << 4) | low);
  }
  return true;
}

bool WriteShellOwnedInvitationLink(const std::wstring& invitation_link,
                                   uint32_t* sequence,
                                   Sha256* hash) {
  // This API has no password variant. The signed UI may pass only the HTTPS
  // invitation-link result from the Owner API, and the bytes are never sent to
  // the watchdog CLI or persisted marker.
  if (!sequence || !hash || invitation_link.size() < 9 ||
      invitation_link.size() > 4096 ||
      invitation_link.rfind(L"https://", 0) != 0 ||
      std::any_of(invitation_link.begin(), invitation_link.end(),
                  [](wchar_t character) { return character < 0x20; }) ||
      !HashBytes(reinterpret_cast<const uint8_t*>(invitation_link.data()),
                 invitation_link.size() * sizeof(wchar_t), hash)) {
    return false;
  }
  if (!OpenClipboardWithRetry()) return false;
  const size_t bytes = (invitation_link.size() + 1) * sizeof(wchar_t);
  HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, bytes);
  wchar_t* destination = memory ? static_cast<wchar_t*>(GlobalLock(memory))
                                : nullptr;
  if (!destination) {
    if (memory) GlobalFree(memory);
    CloseClipboard();
    return false;
  }
  std::memcpy(destination, invitation_link.c_str(), bytes);
  GlobalUnlock(memory);

  const UINT history = RegisterClipboardFormatW(L"CanIncludeInClipboardHistory");
  const UINT cloud = RegisterClipboardFormatW(L"CanUploadToCloudClipboard");
  const bool emptied = EmptyClipboard() != FALSE;
  const bool text_transferred =
      emptied && SetClipboardData(CF_UNICODETEXT, memory) != nullptr;
  if (text_transferred) memory = nullptr;  // The clipboard owns it now.
  const bool success = text_transferred && history != 0 && cloud != 0 &&
                       SetOptOutFormat(history) && SetOptOutFormat(cloud);
  if (success) {
    *sequence = GetClipboardSequenceNumber();
  } else {
    EmptyClipboard();  // Never leave a copy that can enter history/cloud.
  }
  CloseClipboard();
  if (memory) GlobalFree(memory);
  return success;
}

int Run(const WatchRequest& request) {
  ScopedSingleInstance instance;
  if (!instance.acquired()) return 16;
  const uint64_t wall_now = UnixMillisecondsNow();
  if (request.epoch_id.empty() ||
      request.epoch_id.size() > kMaximumEpochBytes ||
      request.deadline_unix_ms <= wall_now ||
      request.deadline_unix_ms - wall_now > kCleanupDelayMs ||
      request.ready_event.empty()) {
    return 10;
  }
  const auto monotonic_deadline = std::chrono::steady_clock::now() +
      std::chrono::milliseconds(request.deadline_unix_ms - wall_now);

  PersistedMarker marker{};
  marker.phase = static_cast<uint8_t>(MarkerPhase::kArmed);
  marker.sequence = request.baseline_sequence;
  marker.deadline_unix_ms = request.deadline_unix_ms;
  marker.epoch_size = static_cast<uint16_t>(request.epoch_id.size());
  for (size_t index = 0; index < request.epoch_id.size(); ++index) {
    marker.epoch[index] = static_cast<uint8_t>(request.epoch_id[index]);
  }
  marker.expected_hash = request.expected_hash;

  // WAL ordering: a shell may copy only after this durable marker exists.
  if (!PersistMarker(marker)) return 11;
  HANDLE ready = CreateEventW(nullptr, TRUE, FALSE, request.ready_event.c_str());
  if (!ready) return 12;
  const bool signaled = SetEvent(ready) != FALSE;
  CloseHandle(ready);
  if (!signaled) return 13;

  while (std::chrono::steady_clock::now() < monotonic_deadline) {
    uint32_t current_sequence = 0;
    bool has_text = false;
    Sha256 current_hash{};
    if (ReadClipboardHash(&current_sequence, &has_text, &current_hash) ==
        ClipboardReadResult::kRead) {
      const bool matches = has_text && current_hash == request.expected_hash;
      if (marker.phase == static_cast<uint8_t>(MarkerPhase::kArmed) &&
          ShouldAdoptClipboard(request.baseline_sequence, current_sequence,
                               matches)) {
        PersistedMarker owned = marker;
        owned.phase = static_cast<uint8_t>(MarkerPhase::kOwned);
        owned.sequence = current_sequence;
        // If the stronger observation cannot be persisted, keep the durable
        // ARMED record and continue. Its hash-only crash rule can still clear
        // this exact value at the deadline; exiting here would strand it.
        if (PersistMarker(owned)) marker = owned;
      } else if (marker.phase == static_cast<uint8_t>(MarkerPhase::kOwned) &&
                 current_sequence != marker.sequence && !matches) {
        // A local replacement wins immediately and must never be erased later.
        return RemoveMarker() ? 0 : 15;
      }
    }
    Sleep(kPollDelayMs);
  }
  return ReconcileMarker(marker);
}

int Sanitize() {
  ScopedSingleInstance instance;
  if (!instance.acquired()) return 31;
  PersistedMarker marker{};
  const MarkerLoadResult result = LoadMarker(&marker);
  if (result == MarkerLoadResult::kAbsent) return 0;
  if (result != MarkerLoadResult::kLoaded) return 30;
  return ReconcileMarker(marker);
}

}  // namespace imcodes::remote_desktop::clipboard_watchdog
