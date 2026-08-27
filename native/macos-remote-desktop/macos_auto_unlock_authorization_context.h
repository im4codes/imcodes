// Credential handoff to Apple's Authorization Services engine.
//
// This seam deliberately does not type through CGEvent. The authorization
// plug-in supplies a username and password as volatile, non-extractable engine
// context, then Apple's built-in password mechanism performs verification.
// No credential is retained by this object or returned to its caller.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_AUTO_UNLOCK_AUTHORIZATION_CONTEXT_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_AUTO_UNLOCK_AUTHORIZATION_CONTEXT_H_

#include <cstddef>
#include <string>

#include "macos_auto_unlock_controller.h"

namespace imcodes::remote_desktop::macos {

class AutoUnlockAuthorizationContextWriter {
 public:
  virtual ~AutoUnlockAuthorizationContextWriter() = default;
  [[nodiscard]] virtual bool SetVolatileUsername(const char* bytes,
                                                  std::size_t length) = 0;
  [[nodiscard]] virtual bool SetVolatilePassword(const char* bytes,
                                                  std::size_t length) = 0;
  virtual void ClearUsername() noexcept = 0;
  virtual void ClearPassword() noexcept = 0;
};

// Success means only that both values were copied into private volatile
// authorization context; it never means the OS password verifier accepted
// them.
class AuthorizationContextAutoUnlockInjector final : public AutoUnlockInjector {
 public:
  AuthorizationContextAutoUnlockInjector(
      AutoUnlockAuthorizationContextWriter& writer,
      std::string local_user_name);

  [[nodiscard]] bool Available() const override;
  [[nodiscard]] bool Inject(const char* bytes, std::size_t length) override;

 private:
  AutoUnlockAuthorizationContextWriter& writer_;
  std::string local_user_name_;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_AUTO_UNLOCK_AUTHORIZATION_CONTEXT_H_
