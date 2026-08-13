#ifndef IMCODES_REMOTE_DESKTOP_VIRTUAL_DISPLAY_CONTROLLER_H_
#define IMCODES_REMOTE_DESKTOP_VIRTUAL_DISPLAY_CONTROLLER_H_

namespace imcodes::rd {

// Runs only in the SYSTEM node process. The software-device lifetime is bound
// to stdin: when the parent closes the pipe or exits, the monitor is removed.
int RunVirtualDisplayController();

// Runs on the logged-in user's default desktop after the SYSTEM controller has
// created the IDD. It attaches only the exact IM.codes adapter as a secondary
// display and leaves every existing physical/third-party adapter unchanged.
int ActivateVirtualDisplayForCurrentUser();

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_VIRTUAL_DISPLAY_CONTROLLER_H_
