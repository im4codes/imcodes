// Production AuthorizationRightStore over AuthorizationRightGet/Set/Remove.
//
// The opaque `serialized` field carried through the transaction is the right's
// COMPLETE definition, serialised as an XML property list. That matters: a
// definition rebuilt from the keys we happen to model is not the definition we
// replaced, and restoring an approximation to system.login.console can leave a
// Mac that cannot log in.
//
// This file performs no installation. It is the adapter the installer consumes;
// the caller decides whether it is pointed at the real AuthorizationDB or at a
// fixture.

#import <CoreFoundation/CoreFoundation.h>
#import <Security/Authorization.h>
#import <Security/AuthorizationDB.h>

#include <string>

#include "macos_auto_unlock_rights.h"

namespace imcodes::remote_desktop::macos {
namespace {

std::string CopyPlistString(CFTypeRef value) {
  if (value == nullptr) return {};
  CFErrorRef error = nullptr;
  CFDataRef data = CFPropertyListCreateData(
      kCFAllocatorDefault, value, kCFPropertyListXMLFormat_v1_0, 0, &error);
  if (data == nullptr) {
    if (error != nullptr) CFRelease(error);
    return {};
  }
  const std::string serialized(
      reinterpret_cast<const char*>(CFDataGetBytePtr(data)),
      static_cast<std::size_t>(CFDataGetLength(data)));
  CFRelease(data);
  return serialized;
}

CFTypeRef CreatePlistFromString(const std::string& serialized) {
  if (serialized.empty()) return nullptr;
  CFDataRef data = CFDataCreate(
      kCFAllocatorDefault,
      reinterpret_cast<const UInt8*>(serialized.data()),
      static_cast<CFIndex>(serialized.size()));
  if (data == nullptr) return nullptr;
  CFErrorRef error = nullptr;
  CFTypeRef plist = CFPropertyListCreateWithData(
      kCFAllocatorDefault, data, kCFPropertyListImmutable, nullptr, &error);
  CFRelease(data);
  if (error != nullptr) CFRelease(error);
  return plist;
}

}  // namespace

AuthorizationRightStore CreateSystemAuthorizationRightStore(
    AuthorizationRef authorization) {
  AuthorizationRightStore store;

  store.read = [](const std::string& name)
      -> std::optional<std::string> {
    CFDictionaryRef definition = nullptr;
    if (AuthorizationRightGet(name.c_str(), &definition) !=
            errAuthorizationSuccess ||
        definition == nullptr) {
      // Absent is a value, not an error: the installer records it as "created"
      // so uninstall removes rather than restores an empty definition.
      return std::nullopt;
    }
    const std::string serialized = CopyPlistString(definition);
    CFRelease(definition);
    if (serialized.empty()) return std::nullopt;
    return serialized;
  };

  store.write = [authorization](const std::string& name,
                                const std::string& serialized,
                                std::string* error) {
    if (authorization == nullptr) {
      *error = "no authorization reference for right modification";
      return false;
    }
    CFTypeRef plist = CreatePlistFromString(serialized);
    if (plist == nullptr) {
      *error = "right definition is not a valid property list";
      return false;
    }
    if (CFGetTypeID(plist) != CFDictionaryGetTypeID()) {
      CFRelease(plist);
      *error = "right definition is not a dictionary";
      return false;
    }
    const OSStatus status = AuthorizationRightSet(
        authorization, name.c_str(), static_cast<CFDictionaryRef>(plist),
        nullptr, nullptr, nullptr);
    CFRelease(plist);
    if (status != errAuthorizationSuccess) {
      *error = "AuthorizationRightSet failed with status " +
               std::to_string(static_cast<int>(status));
      return false;
    }
    return true;
  };

  store.remove = [authorization](const std::string& name, std::string* error) {
    if (authorization == nullptr) {
      *error = "no authorization reference for right removal";
      return false;
    }
    const OSStatus status = AuthorizationRightRemove(authorization, name.c_str());
    if (status != errAuthorizationSuccess) {
      *error = "AuthorizationRightRemove failed with status " +
               std::to_string(static_cast<int>(status));
      return false;
    }
    return true;
  };

  return store;
}

}  // namespace imcodes::remote_desktop::macos
