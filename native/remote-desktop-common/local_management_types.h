#ifndef IMCODES_REMOTE_DESKTOP_COMMON_LOCAL_MANAGEMENT_TYPES_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_LOCAL_MANAGEMENT_TYPES_H_

namespace imcodes::remote_desktop::common {
// Must equal REMOTE_DESKTOP_LOCAL_WORKER_MSG.ACCESS_STATE in
// shared/remote-desktop-local-management.ts. A cross-language test binds it.
inline constexpr char kLocalAccessStateType[] = "local_access_state";
}  // namespace imcodes::remote_desktop::common

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_LOCAL_MANAGEMENT_TYPES_H_
