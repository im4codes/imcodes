#ifndef IMCODES_MACOS_REMOTE_DESKTOP_AIDESK_PANEL_WINDOW_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_AIDESK_PANEL_WINDOW_H_

// The local management panel as this application's own window.
//
// The panel is a web page served by the node on the loopback. Shown in a
// browser's app mode it carries the browser's Dock icon and name; shown here,
// in a WKWebView owned by the aiDesk.to application, the Dock, the Cmd-Tab
// switcher and the menu bar all show aiDesk.to's own icon and name, and "one
// window" is the application's own business (a second request activates the
// window that exists).
//
// The web view may only ever show the panel's own origin; everything else is
// refused, and a new window is never created. Main thread only.

namespace imcodes::remote_desktop::macos {

// Opens the panel window, or brings the existing one to the front.
void ShowLocalPanelWindow();

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_AIDESK_PANEL_WINDOW_H_
