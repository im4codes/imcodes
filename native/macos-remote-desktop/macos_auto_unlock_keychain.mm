// Requested before any libc header so `memset_s` is declared. Ordinary memset
// is not usable here: the compiler is free to elide a write to storage it can
// prove is dead, which is exactly the write that must survive.
#define __STDC_WANT_LIB_EXT1__ 1

#include "macos_auto_unlock_keychain.h"

#include <Security/Security.h>

#include <cstring>
#include <string.h>
#include <vector>

// The classic file-keychain API is deprecated. Silenced deliberately and only
// here: the modern replacement cannot express "only this signed binary may read
// this item", and widening the ACL is the one thing this feature must not do.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

namespace imcodes::remote_desktop::macos {
namespace {

/** Bounds mirroring the TypeScript contract; a guard, not a policy. */
constexpr std::size_t kMaxSecretLength = 256;
constexpr std::size_t kMaxFieldLength = 256;

struct CFReleaser {
  void operator()(CFTypeRef ref) const noexcept {
    if (ref != nullptr) CFRelease(ref);
  }
};

/** Overwrites and then releases; a plain `clear()` would leave the bytes. */
void ZeroBytes(char* bytes, std::size_t length) noexcept {
  if (bytes == nullptr || length == 0) return;
  // `memset_s` cannot be optimized away the way `memset` can.
  (void)memset_s(bytes, length, 0, length);
}

struct ZeroingBuffer {
  explicit ZeroingBuffer(std::size_t length) : bytes(length) {}
  ~ZeroingBuffer() { ZeroBytes(bytes.data(), bytes.size()); }

  std::vector<char> bytes;
};

[[nodiscard]] bool ReferenceIsWellFormed(
    const AutoUnlockCredentialReference& reference) {
  // Only the System keychain. A caller that could name another path could name
  // a keychain it already controls and read back its own item.
  if (reference.keychain_path != kSystemKeychainPath) return false;
  if (reference.service.empty() || reference.service.size() > kMaxFieldLength) {
    return false;
  }
  if (reference.account.empty() || reference.account.size() > kMaxFieldLength) {
    return false;
  }
  return !reference.designated_requirement.empty()
      && reference.designated_requirement.size() <= kMaxFieldLength;
}

[[nodiscard]] SecKeychainRef OpenSystemKeychain() {
  SecKeychainRef keychain = nullptr;
  if (SecKeychainOpen(kSystemKeychainPath, &keychain) != errSecSuccess) {
    return nullptr;
  }
  return keychain;
}

/**
 * Builds an ACL that admits exactly one trusted application.
 *
 * `SecAccessCreate` with a one-element trusted list is what restricts the item.
 * Passing an empty list or `nullptr` would produce the broad "any application"
 * ACL, which is the failure mode this whole file exists to avoid, so the
 * trusted application is created first and a failure aborts before any access
 * object is made.
 */
[[nodiscard]] SecAccessRef CreateSingleApplicationAccess(
    const std::string& agent_path, const std::string& label) {
  SecTrustedApplicationRef trusted = nullptr;
  if (SecTrustedApplicationCreateFromPath(agent_path.c_str(), &trusted)
          != errSecSuccess
      || trusted == nullptr) {
    return nullptr;
  }
  const void* entries[] = {trusted};
  CFArrayRef trusted_list = CFArrayCreate(kCFAllocatorDefault, entries, 1,
                                          &kCFTypeArrayCallBacks);
  CFStringRef label_ref = CFStringCreateWithCString(
      kCFAllocatorDefault, label.c_str(), kCFStringEncodingUTF8);
  SecAccessRef access = nullptr;
  if (trusted_list != nullptr && label_ref != nullptr) {
    (void)SecAccessCreate(label_ref, trusted_list, &access);
  }
  if (label_ref != nullptr) CFRelease(label_ref);
  if (trusted_list != nullptr) CFRelease(trusted_list);
  CFRelease(trusted);
  return access;
}

}  // namespace

bool AgentSatisfiesDesignatedRequirement(const std::string& agent_path,
                                         const std::string& requirement) {
  if (agent_path.empty() || requirement.empty()) return false;

  CFStringRef path_ref = CFStringCreateWithCString(
      kCFAllocatorDefault, agent_path.c_str(), kCFStringEncodingUTF8);
  if (path_ref == nullptr) return false;
  CFURLRef url = CFURLCreateWithFileSystemPath(kCFAllocatorDefault, path_ref,
                                               kCFURLPOSIXPathStyle, false);
  CFRelease(path_ref);
  if (url == nullptr) return false;

  SecStaticCodeRef code = nullptr;
  const OSStatus created =
      SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code);
  CFRelease(url);
  if (created != errSecSuccess || code == nullptr) return false;

  CFStringRef requirement_ref = CFStringCreateWithCString(
      kCFAllocatorDefault, requirement.c_str(), kCFStringEncodingUTF8);
  SecRequirementRef parsed = nullptr;
  OSStatus status = errSecCSReqFailed;
  if (requirement_ref != nullptr
      && SecRequirementCreateWithString(requirement_ref, kSecCSDefaultFlags,
                                        &parsed) == errSecSuccess
      && parsed != nullptr) {
    // kSecCSCheckAllArchitectures: a universal binary whose other slice is
    // unsigned must not pass because the running slice happens to be signed.
    // Both constants come from unrelated anonymous enums; combining them
    // needs an explicit widening or the compiler treats it as enum arithmetic.
    const SecCSFlags flags =
        static_cast<SecCSFlags>(static_cast<std::uint32_t>(kSecCSDefaultFlags)
                                | static_cast<std::uint32_t>(
                                      kSecCSCheckAllArchitectures));
    status = SecStaticCodeCheckValidity(code, flags, parsed);
  }
  if (requirement_ref != nullptr) CFRelease(requirement_ref);
  if (parsed != nullptr) CFRelease(parsed);
  CFRelease(code);
  return status == errSecSuccess;
}

AutoUnlockEnrollmentStatus EnrollSystemKeychainCredential(
    const AutoUnlockCredentialReference& reference,
    const std::string& agent_path,
    char* secret,
    std::size_t secret_length) {
  if (secret == nullptr || secret_length == 0
      || secret_length > kMaxSecretLength) {
    ZeroBytes(secret, secret_length);
    return AutoUnlockEnrollmentStatus::kInvalidReference;
  }
  if (!ReferenceIsWellFormed(reference)) {
    ZeroBytes(secret, secret_length);
    return AutoUnlockEnrollmentStatus::kInvalidReference;
  }
  // Verify BEFORE creating the ACL. Creating first and validating afterwards
  // would leave a window in which a broad item exists on disk.
  if (!AgentSatisfiesDesignatedRequirement(
          agent_path, reference.designated_requirement)) {
    ZeroBytes(secret, secret_length);
    return AutoUnlockEnrollmentStatus::kSignerRejected;
  }

  SecKeychainRef keychain = OpenSystemKeychain();
  if (keychain == nullptr) {
    ZeroBytes(secret, secret_length);
    return AutoUnlockEnrollmentStatus::kStoreFailed;
  }
  SecAccessRef access =
      CreateSingleApplicationAccess(agent_path, reference.service);
  if (access == nullptr) {
    CFRelease(keychain);
    ZeroBytes(secret, secret_length);
    return AutoUnlockEnrollmentStatus::kStoreFailed;
  }

  // Replace rather than accumulate: a stale item with an older ACL would still
  // be readable by whoever that ACL named.
  (void)DeleteSystemKeychainCredential(reference);

  // The item is created with its service/account attributes and its content in
  // one call, with `access` already attached: the ACL is therefore in force
  // from the moment the item exists on disk, never a moment later.
  SecKeychainAttribute attributes[] = {
      {kSecServiceItemAttr, static_cast<UInt32>(reference.service.size()),
       const_cast<char*>(reference.service.c_str())},
      {kSecAccountItemAttr, static_cast<UInt32>(reference.account.size()),
       const_cast<char*>(reference.account.c_str())},
  };
  SecKeychainAttributeList attribute_list = {
      static_cast<UInt32>(sizeof(attributes) / sizeof(attributes[0])),
      attributes};

  SecKeychainItemRef item = nullptr;
  const OSStatus written = SecKeychainItemCreateFromContent(
      kSecGenericPasswordItemClass, &attribute_list,
      static_cast<UInt32>(secret_length), secret, keychain, access, &item);
  if (item != nullptr) CFRelease(item);
  CFRelease(access);
  CFRelease(keychain);
  ZeroBytes(secret, secret_length);
  return written == errSecSuccess ? AutoUnlockEnrollmentStatus::kOk
                                  : AutoUnlockEnrollmentStatus::kStoreFailed;
}

AutoUnlockEnrollmentStatus DeleteSystemKeychainCredential(
    const AutoUnlockCredentialReference& reference) {
  if (!ReferenceIsWellFormed(reference)) {
    return AutoUnlockEnrollmentStatus::kInvalidReference;
  }
  SecKeychainRef keychain = OpenSystemKeychain();
  if (keychain == nullptr) return AutoUnlockEnrollmentStatus::kStoreFailed;

  SecKeychainItemRef item = nullptr;
  const OSStatus found = SecKeychainFindGenericPassword(
      keychain, static_cast<UInt32>(reference.service.size()),
      reference.service.c_str(),
      static_cast<UInt32>(reference.account.size()),
      reference.account.c_str(), nullptr, nullptr, &item);
  OSStatus removed = found;
  if (found == errSecSuccess && item != nullptr) {
    removed = SecKeychainItemDelete(item);
  }
  if (item != nullptr) CFRelease(item);
  CFRelease(keychain);
  return removed == errSecSuccess ? AutoUnlockEnrollmentStatus::kOk
                                  : AutoUnlockEnrollmentStatus::kStoreFailed;
}

bool ConsumeSystemKeychainCredential(
    const AutoUnlockCredentialReference& reference,
    const AutoUnlockCredentialConsumer& consumer) {
  if (!ReferenceIsWellFormed(reference) || !consumer) return false;
  SecKeychainRef keychain = OpenSystemKeychain();
  if (keychain == nullptr) return false;

  UInt32 length = 0;
  void* data = nullptr;
  const OSStatus status = SecKeychainFindGenericPassword(
      keychain, static_cast<UInt32>(reference.service.size()),
      reference.service.c_str(),
      static_cast<UInt32>(reference.account.size()),
      reference.account.c_str(), &length, &data, nullptr);
  CFRelease(keychain);
  // A missing item and an ACL denial both land here, and both return false.
  if (status != errSecSuccess || data == nullptr) return false;
  if (length == 0 || length > kMaxSecretLength) {
    (void)SecKeychainItemFreeContent(nullptr, data);
    return false;
  }

  // Copy into a buffer this function owns so the span handed out has a lifetime
  // that ends here regardless of what the framework does with its own.
  ZeroingBuffer buffer(static_cast<std::size_t>(length));
  std::memcpy(buffer.bytes.data(), data, buffer.bytes.size());
  (void)SecKeychainItemFreeContent(nullptr, data);

  // ZeroingBuffer owns the cleanup so stack unwinding cannot bypass it when a
  // test or future non-Chromium consumer throws from the callback.
  return consumer(buffer.bytes.data(), buffer.bytes.size());
}

bool SystemKeychainCredentialBackend::ConsumeCredential(
    const AutoUnlockCredentialReference& reference,
    const AutoUnlockCredentialConsumer& consumer) {
  return ConsumeSystemKeychainCredential(reference, consumer);
}

bool SystemKeychainCredentialBackend::VerifySigner(
    const AutoUnlockCredentialReference& reference) {
  return AgentSatisfiesDesignatedRequirement(
      agent_path_, reference.designated_requirement);
}

}  // namespace imcodes::remote_desktop::macos

#pragma clang diagnostic pop
