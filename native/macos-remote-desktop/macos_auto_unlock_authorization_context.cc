#include "macos_auto_unlock_authorization_context.h"

#include <utility>

namespace imcodes::remote_desktop::macos {
namespace {

constexpr std::size_t kMaximumUsernameBytes = 256;
constexpr std::size_t kMaximumCredentialBytes = 256;

}  // namespace

AuthorizationContextAutoUnlockInjector::AuthorizationContextAutoUnlockInjector(
    AutoUnlockAuthorizationContextWriter& writer,
    std::string local_user_name)
    : writer_(writer), local_user_name_(std::move(local_user_name)) {}

bool AuthorizationContextAutoUnlockInjector::Available() const {
  return !local_user_name_.empty() &&
         local_user_name_.size() <= kMaximumUsernameBytes;
}

bool AuthorizationContextAutoUnlockInjector::Inject(const char* bytes,
                                                     std::size_t length) {
  if (!Available() || bytes == nullptr || length == 0 ||
      length > kMaximumCredentialBytes) {
    return false;
  }
  writer_.ClearUsername();
  writer_.ClearPassword();
  if (!writer_.SetVolatileUsername(local_user_name_.data(),
                                   local_user_name_.size())) {
    writer_.ClearUsername();
    return false;
  }
  if (!writer_.SetVolatilePassword(bytes, length)) {
    writer_.ClearPassword();
    writer_.ClearUsername();
    return false;
  }
  return true;
}

}  // namespace imcodes::remote_desktop::macos
