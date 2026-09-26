#include "macos_session_identity.h"

#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

#include <bsm/audit.h>
#include <bsm/audit_session.h>
#include <unistd.h>

#include "macos_login_window_capture.h"

// `CGSessionCopyCurrentDictionary` is the window server's own answer to "which
// session am I in". It is declared in CoreGraphics but not in the modular
// headers, so it is declared here rather than reached for through a private
// header.
extern "C" CFDictionaryRef CGSessionCopyCurrentDictionary(void);

namespace imcodes::remote_desktop::macos {
namespace {

// Window-server session dictionary keys. They are literal strings rather than
// exported constants in the SDK, and their spelling is not uniform -- the login
// key is `kCGSession...` with one S while its neighbours are `kCGSSession...`
// with two. A misspelled key reads as absent, which for the login key means a
// logged-in desktop classifies as a login window, so these were taken from a
// live dump of the dictionary rather than from memory.
constexpr char kLoginDoneKey[] = "kCGSessionLoginDoneKey";
constexpr char kOnConsoleKey[] = "kCGSSessionOnConsoleKey";
constexpr char kUserNameKey[] = "kCGSSessionUserNameKey";
constexpr char kAuditIdKey[] = "kCGSSessionAuditIDKey";

[[nodiscard]] bool BoolValue(NSDictionary* session, const char* key,
                             bool* present) {
  id value = session[[NSString stringWithUTF8String:key]];
  const bool found = [value isKindOfClass:[NSNumber class]];
  if (present != nullptr) *present = found;
  return found && [(NSNumber*)value boolValue];
}

[[nodiscard]] std::uint32_t UnsignedValue(NSDictionary* session,
                                          const char* key) {
  id value = session[[NSString stringWithUTF8String:key]];
  if (![value isKindOfClass:[NSNumber class]]) return 0;
  const long long raw = [(NSNumber*)value longLongValue];
  if (raw <= 0 || raw > 0xFFFFFFFFll) return 0;
  return static_cast<std::uint32_t>(raw);
}

}  // namespace

std::string_view ClassifyMacosSessionType(
    const MacosSessionIdentityObservation& observation) {
  // Ordered, and every gate below is fail-closed.
  //
  // The audit session and uid are checked first because the whole point of the
  // classification is to bind capture authority to one principal: a session
  // type without an audit session cannot tell two successive login windows
  // apart, and `CaptureSessionBinding::IsComplete` would reject it anyway.
  if (observation.audit_session_id == 0) return {};
  if (!observation.session_dictionary_available) return {};
  // The window server must be describing the same session the kernel put this
  // process in. If it is not, neither answer describes this process.
  if (observation.window_server_audit_session_id != observation.audit_session_id) {
    return {};
  }
  if (!observation.on_console) {
    // Not the console session. Refused rather than treated as Aqua: see the
    // header. Checked before the login state because a background session's
    // login state says nothing about the surface an operator asked to reach.
    return {};
  }
  // Two independent signals, and they must agree. Requiring both is what stops
  // a single misread key from deciding the profile: if `login_done` were read
  // through a misspelled key it would be false on a logged-in desktop, and the
  // named console user contradicts that.
  if (observation.login_done && observation.has_console_user) {
    return kSessionTypeAqua;
  }
  if (!observation.login_done && !observation.has_console_user) {
    // No login has completed and no user is named. That is the login window,
    // and it is the only state in which the restricted profile applies.
    //
    // Note this is NOT the lock screen: a locked desktop is a logged-in Aqua
    // session that reports a user and a completed login, and it keeps the Aqua
    // profile it already had.
    return kSessionTypeLoginWindow;
  }
  // The two signals disagree. Refused: one of them is being misread, and the
  // wrong answer either hands the login window a user's clipboard or denies a
  // real desktop its own.
  return {};
}

bool MacosSessionIdentityMatches(
    const MacosSessionIdentityObservation& observation,
    std::string_view declared_session_type,
    std::uint32_t declared_audit_session_id,
    std::uint32_t declared_uid) {
  const std::string_view classified = ClassifyMacosSessionType(observation);
  // An unclassifiable observation matches nothing, including an empty
  // declaration: two unknowns are not an agreement.
  if (classified.empty()) return false;
  return classified == declared_session_type
      && observation.audit_session_id == declared_audit_session_id
      && observation.uid == declared_uid;
}

MacosSessionIdentityObservation ObserveMacosSessionIdentity() {
  MacosSessionIdentityObservation observation;
  observation.uid = static_cast<std::uint32_t>(::getuid());

  auditinfo_addr_t audit_info{};
  if (::getaudit_addr(&audit_info, sizeof(audit_info)) == 0) {
    observation.audit_session_id =
        static_cast<std::uint32_t>(audit_info.ai_asid);
  }

  @autoreleasepool {
    CFDictionaryRef raw = CGSessionCopyCurrentDictionary();
    if (raw != nullptr) {
      NSDictionary* session = (__bridge NSDictionary*)raw;
      observation.session_dictionary_available = true;
      observation.login_done =
          BoolValue(session, kLoginDoneKey, &observation.login_done_present);
      observation.on_console =
          BoolValue(session, kOnConsoleKey, &observation.on_console_present);
      // A logged-in session names its user; the login window has none. Kept as
      // a separate signal so a single misread key cannot decide the profile on
      // its own.
      observation.has_console_user =
          [session[[NSString stringWithUTF8String:kUserNameKey]]
              isKindOfClass:[NSString class]];
      observation.window_server_audit_session_id =
          UnsignedValue(session, kAuditIdKey);
      CFRelease(raw);
    }
  }
  return observation;
}

}  // namespace imcodes::remote_desktop::macos
