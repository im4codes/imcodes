// Real POSIX seam for MacosVirtualDisplaySupervisor.
//
// Separate from the state machine on purpose: the decision rules are proven
// against a fake OS with no process, no descriptor and no display, and this
// file contributes only syscalls.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_SUPERVISOR_POSIX_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_SUPERVISOR_POSIX_H_

#include <string>

#include "macos_virtual_display_supervisor.h"

namespace imcodes::remote_desktop::macos {

/**
 * The release this executable was selected from, i.e. the name of its own
 * directory. Empty when it cannot be established, which the supervisor treats
 * as a refusal rather than binding to an unknown release.
 */
[[nodiscard]] std::string SelectedReleaseIdentity();

/** Builds the production seam. Never spawns anything by itself. */
[[nodiscard]] SupervisorSeam CreatePosixSupervisorSeam();

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_SUPERVISOR_POSIX_H_
