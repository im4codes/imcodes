#include "third_party/imcodes_remote_desktop/unlock_secret.h"

#include <dpapi.h>
#include <sddl.h>
#include <shlobj.h>

#include <vector>

namespace imcodes::rd {
namespace {

constexpr wchar_t kDirectoryName[] = L"imcodes-node";
constexpr wchar_t kFileName[] = L"remote-desktop-unlock.bin";

// LOCAL_SYSTEM full control and nothing else: not Administrators, not the
// signed-in user. An administrator can still take ownership, but that is a
// deliberate, auditable act rather than an ordinary read.
constexpr wchar_t kSystemOnlySddl[] = L"D:P(A;;FA;;;SY)";

std::wstring ProgramDataPath() {
  PWSTR folder = nullptr;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_ProgramData, 0, nullptr, &folder))) {
    return {};
  }
  std::wstring path(folder);
  CoTaskMemFree(folder);
  return path;
}

void SecureWipe(std::wstring* value) {
  if (!value || value->empty()) return;
  SecureZeroMemory(value->data(), value->size() * sizeof(wchar_t));
  value->clear();
}

bool WriteSystemOnlyFile(const std::wstring& path,
                         const BYTE* data,
                         DWORD size) {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          kSystemOnlySddl, SDDL_REVISION_1, &descriptor, nullptr)) {
    return false;
  }
  SECURITY_ATTRIBUTES attributes{};
  attributes.nLength = sizeof(attributes);
  attributes.lpSecurityDescriptor = descriptor;
  attributes.bInheritHandle = FALSE;
  // CREATE_ALWAYS keeps the DACL of an existing file, so remove any previous
  // blob first and create the file fresh with the restrictive descriptor.
  DeleteFileW(path.c_str());
  const HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, &attributes,
                                  CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  LocalFree(descriptor);
  if (file == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0;
  const bool ok = WriteFile(file, data, size, &written, nullptr) &&
                  written == size;
  CloseHandle(file);
  if (!ok) DeleteFileW(path.c_str());
  return ok;
}

bool ReadWholeFile(const std::wstring& path, std::vector<BYTE>* out) {
  const HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ,
                                  nullptr, OPEN_EXISTING,
                                  FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER size{};
  // A DPAPI blob for a short secret is well under this; anything larger is not
  // ours and is refused rather than allocated.
  if (!GetFileSizeEx(file, &size) || size.QuadPart <= 0 ||
      size.QuadPart > 64 * 1024) {
    CloseHandle(file);
    return false;
  }
  out->resize(static_cast<size_t>(size.QuadPart));
  DWORD read = 0;
  const bool ok = ReadFile(file, out->data(), static_cast<DWORD>(out->size()),
                           &read, nullptr) &&
                  read == out->size();
  CloseHandle(file);
  if (!ok) out->clear();
  return ok;
}

}  // namespace

std::wstring UnlockSecret::Path() {
  const std::wstring root = ProgramDataPath();
  if (root.empty()) return {};
  return root + L"\\" + kDirectoryName + L"\\" + kFileName;
}

bool UnlockSecret::Store(const std::wstring& secret) {
  if (secret.empty()) return Clear();
  const std::wstring path = Path();
  if (path.empty()) return false;

  DATA_BLOB input{};
  input.cbData = static_cast<DWORD>(secret.size() * sizeof(wchar_t));
  input.pbData = reinterpret_cast<BYTE*>(const_cast<wchar_t*>(secret.data()));
  DATA_BLOB output{};
  // Machine scope: the node service runs as LOCAL_SYSTEM and there is no user
  // profile to bind to at the sign-in screen, which is exactly when this is
  // needed. The blob is therefore useless on any other machine.
  if (!CryptProtectData(&input, L"imcodes remote desktop unlock", nullptr,
                        nullptr, nullptr, CRYPTPROTECT_LOCAL_MACHINE,
                        &output)) {
    return false;
  }
  const bool stored = WriteSystemOnlyFile(path, output.pbData, output.cbData);
  SecureZeroMemory(output.pbData, output.cbData);
  LocalFree(output.pbData);
  return stored;
}

bool UnlockSecret::Clear() {
  const std::wstring path = Path();
  if (path.empty()) return false;
  if (DeleteFileW(path.c_str())) return true;
  return GetLastError() == ERROR_FILE_NOT_FOUND ||
         GetLastError() == ERROR_PATH_NOT_FOUND;
}

bool UnlockSecret::Configured() {
  const std::wstring path = Path();
  if (path.empty()) return false;
  return GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES;
}

bool UnlockSecret::Load(std::wstring* secret) {
  if (!secret) return false;
  SecureWipe(secret);
  const std::wstring path = Path();
  if (path.empty()) return false;
  std::vector<BYTE> blob;
  if (!ReadWholeFile(path, &blob)) return false;

  DATA_BLOB input{};
  input.cbData = static_cast<DWORD>(blob.size());
  input.pbData = blob.data();
  DATA_BLOB output{};
  const bool decrypted = CryptUnprotectData(&input, nullptr, nullptr, nullptr,
                                            nullptr, 0, &output) != FALSE;
  SecureZeroMemory(blob.data(), blob.size());
  if (!decrypted) return false;
  if ((output.cbData % sizeof(wchar_t)) != 0) {
    SecureZeroMemory(output.pbData, output.cbData);
    LocalFree(output.pbData);
    return false;
  }
  secret->assign(reinterpret_cast<const wchar_t*>(output.pbData),
                 output.cbData / sizeof(wchar_t));
  SecureZeroMemory(output.pbData, output.cbData);
  LocalFree(output.pbData);
  return !secret->empty();
}

}  // namespace imcodes::rd
