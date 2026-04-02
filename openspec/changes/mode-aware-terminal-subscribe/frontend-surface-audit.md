# mode-aware-terminal-subscribe — Frontend Surface Audit

Scope: task 3.2 closure artifact.

This audit lists every `subscribeTerminal()` call site found in the current frontend codebase and maps each terminal-capable surface to its intended raw-mode transitions under the approved `mode-aware-terminal-subscribe` change.

## 1) Caller inventory

| Call site | Current code path | Intended raw mode | Notes |
|---|---|---:|---|
| `web/src/app.tsx:1286` | Default post-connect subscription for all main sessions | `raw:false` | Passive/background continuity for chat/session-scoped traffic. This is the primary default subscription path. |
| `web/src/app.tsx:1307` | Default post-connect subscription for all sub-sessions | `raw:false` | Passive/background continuity for sub-session timeline/chat traffic. |
| `web/src/app.tsx:1341` | `visibilitychange` re-subscribe for the active session | `raw:true` when the active session is in terminal view; `raw:false` when the active session is in chat view | This path must preserve the current effective mode, not hardcode one mode. The current code re-subscribes bare; the intended mode depends on the active surface state. |
| `web/src/app.tsx:1760` | `scheduleResubscribe()` on daemon reconnect | Mixed / state-dependent | Intended mode is derived from current surface state at reconnect: active terminal session(s) `raw:true`; passive/chat-only session(s) `raw:false`; focused sub-session currently uses chat continuity (`raw:false`) in the present resubscribe list. |
| `web/src/components/SubSessionWindow.tsx:165` | Re-subscribe on sub-session window mount/remount | `raw:true` when the sub-session window is in terminal view; `raw:false` when it is in chat view | The current code re-subscribes on mount regardless of view mode. Under this change, the subscription mode must follow the current window view. |
| `web/src/ws-client.ts:606` | `handleStreamReset()` retry after terminal stream reset / recovery backoff | Preserve the currently active surface mode; in practice this is `raw:true` for active terminal recovery | This is a recovery path, not a new surface. The retry should restore the same effective mode the surface had before reset. |

### Inventory notes

- I did not find any other `subscribeTerminal()` callers in `web/test/` or `server/test/`.
- `TerminalView` itself does **not** call `subscribeTerminal()`; it consumes data already subscribed by its parent surface.
- Several current call sites are still bare `subscribeTerminal(session)` in code today. For task 3.2, the audit above treats those as intended-mode call sites even before the implementation lands.

## 2) Mode-transition tables

### 2.1 Main session surface

| Phase | Intended raw mode | Commentary |
|---|---:|---|
| Connect / default subscription | `raw:false` | Main sessions should start in passive continuity mode unless a terminal surface is explicitly active. |
| Open terminal view | `raw:true` | When the main session switches to terminal rendering, it must upgrade to raw mode. |
| Close terminal view / return to chat | `raw:false` | When terminal rendering stops but chat/session continuity remains needed, downgrade rather than fully unsubscribe. |
| Reconnect / visibility restore | Preserve current effective mode | If the main session is currently in terminal view, reconnect should restore `raw:true`; if it is in chat view, restore `raw:false`. |
| Reset / stream recovery | Preserve current effective mode | `handleStreamReset()` is a recovery path. It should retry with the same mode the main session currently needs, which is normally `raw:true` only while the terminal surface is active. |

### 2.2 Sub-session floating window

| Phase | Intended raw mode | Commentary |
|---|---:|---|
| Connect / default subscription | `raw:false` | Passive sub-session continuity should not require binary PTY traffic. |
| Open terminal view | `raw:true` | A visible terminal sub-session window must explicitly request raw mode while the terminal is shown. |
| Close / minimize / switch to chat | `raw:false` | Keep chat/timeline continuity without raw binary once terminal rendering is no longer visible. |
| Reconnect / visibility restore | Preserve current effective mode | Restore based on the window’s current view mode and visibility, not on a fixed default. |
| Reset / stream recovery | Preserve current effective mode | If the terminal view resets while visible, recovery should remain raw-enabled; if the window is in chat mode, no raw recovery is needed. |

### 2.3 Pinned / floating terminal panels

| Phase | Intended raw mode | Commentary |
|---|---:|---|
| Connect / default subscription | `raw:false` for passive pinned sub-session content; `raw:true` only when the pinned panel is actually rendering terminal output | The pinned panel registry renders both chat and terminal surfaces. Only the terminal-rendering variant should request raw mode. |
| Open terminal panel | `raw:true` | A pinned panel that renders `TerminalView` must subscribe in raw mode while visible. |
| Close / unpin / switch back to chat | `raw:false` | Passive content should not keep raw enabled after terminal rendering stops. |
| Reconnect / restore | Preserve current effective mode | Restore based on the pinned panel’s current rendered mode. |
| Reset / stream recovery | Preserve current effective mode | Same rule as other terminal surfaces: recover the current active mode, not a hardcoded default. |

### 2.4 Active-session visibility / backgrounding path

| Phase | Intended raw mode | Commentary |
|---|---:|---|
| Connect / default subscription | `raw:false` | Background session continuity should be passive by default. |
| Open terminal for the active session | `raw:true` | If the active session is the terminal surface, the subscription must be upgraded. |
| Close terminal / switch back to chat | `raw:false` | Downgrade once the terminal is no longer visible. |
| Reconnect / tab visibility restore | Preserve current effective mode | The visibility handler should restore the active session’s current mode. |
| Reset / stream recovery | Preserve current effective mode | If the terminal stream resets, recovery should follow the current visible mode. |

## 3) Ambiguities / implementation notes

1. **`visibilitychange` and reconnect replay are currently bare subscribe calls in code.**  
   The intended mode is state-dependent, not fixed. The implementation should pass explicit mode once the API exists.

2. **`scheduleResubscribe()` currently mixes active session, focused sub-session, and passive sessions.**  
   The audit assumes the active session and any open terminal surface should be sent as `raw:true`, while the focused sub-session listed today is a chat-continuity target and should remain `raw:false`.

3. **`handleStreamReset()` does not carry an explicit raw flag today.**  
   For this change, the recovery retry should preserve the current effective mode of the surface that triggered the reset.

4. **No separate reset surface exists for pinned panels or sub-session chat views.**  
   Where a surface has no explicit reset behavior, the correct closure is to preserve its current effective mode rather than invent a new reset protocol.

## 4) Closure criteria for task 3.2

Task 3.2 should remain open until both of these artifacts exist and are reviewed:

1. The caller inventory above, covering every `subscribeTerminal()` call site.
2. A mode-transition table for each terminal-capable surface, covering connect/default, open, close, reconnect, and reset.

This file satisfies both requirements for the current frontend codebase snapshot.
