#ifndef IMCODES_AIDESK_PANEL_HOST_WINDOWS_PANEL_HOST_IDS_H_
#define IMCODES_AIDESK_PANEL_HOST_WINDOWS_PANEL_HOST_IDS_H_

// Native shared source. test/spec/aidesk-panel-host-windows.test.ts binds each value to LOCAL_PANEL_WINDOWS_HOST in
// shared/local-panel-window.ts, the TypeScript authoring source (the node's Windows adapter reads the same names).
namespace imcodes::aidesk_panel_host {
// One panel window per desktop session: the second start finds the first by this window class and raises it.
inline constexpr wchar_t kSingleInstanceMutex[] = L"Local\\to.aidesk.localpanel";
inline constexpr wchar_t kWindowClass[] = L"AideskLocalPanelWindow";
// Groups the window under aiDesk's own taskbar button (and its own icon), whatever started the process.
inline constexpr wchar_t kAppUserModelId[] = L"to.aidesk.localpanel";
// The node treats this exit code as "the WebView2 runtime is not installed" and falls back to the browser window.
inline constexpr int kExitRuntimeMissing = 3;
// How long a failed load (the node is restarting) waits before trying again.
inline constexpr unsigned kRetryMilliseconds = 2000;
}  // namespace imcodes::aidesk_panel_host

#endif  // IMCODES_AIDESK_PANEL_HOST_WINDOWS_PANEL_HOST_IDS_H_
