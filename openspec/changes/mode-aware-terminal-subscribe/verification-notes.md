# mode-aware-terminal-subscribe — Verification Notes

This file records implementation-time verification evidence for the remaining rollout/manual tasks.

## Verified in-repo

### Automated compatibility evidence

#### Old client -> new bridge
- Covered by `server/test/bridge.test.ts`
- Evidence:
  - missing `raw` is treated as raw-enabled for backward compatibility
  - binary still reaches the subscriber in that legacy case

#### New client -> new bridge
- Covered by:
  - `server/test/bridge.test.ts`
  - `server/test/terminal-streaming.test.ts`
  - `web/test/ws-client.test.ts`
  - `web/test/components/SubSessionWindow.test.tsx`
  - `web/test/app-terminal-subscribe-mode.test.ts`
  - `test/e2e/mode-aware-terminal-subscribe.test.ts`
- Evidence:
  - explicit `raw:false` / `raw:true` are sent by the web client
  - bridge aggregates `totalRefs` / `rawRefs`
  - binary is forwarded only to `raw:true`
  - text/control/session-scoped delivery still reaches passive subscribers
  - reconnect replay preserves explicit effective `raw`
  - real tmux -> daemon command handler -> bridge -> browser E2E confirms:
    - mixed-mode passive/raw subscribers are split correctly
    - downgrading the last raw subscriber stops browser-side binary delivery
    - daemon reconnect preserves the effective raw-mode routing behavior

#### New bridge/client -> current daemon
- Covered by:
  - `src/daemon/command-handler.ts` inline transport comment
  - `server/test/terminal-streaming.test.ts`
- Evidence:
  - daemon subscribe handling remains session-based
  - daemon transport remains text+binary capable
  - bridge may send explicit `raw:false` upstream without breaking terminal diff delivery

## Not fully verified in-repo

### New client -> old bridge
- Not directly reproducible from the current tree because the old bridge implementation is not present as a runnable test target.
- Expected behavior per spec:
  - explicit `raw` may be ignored
  - behavior degrades to legacy raw-enabled subscription semantics

### Full manual verification (task 4.3)
- Not completed in this implementation session.
- Still requires a live environment check for:
  1. chat-only browser tab no longer receiving raw binary traffic in practice
  2. two-browser mixed-mode session behavior against a running daemon
  3. rollout behavior across intentionally version-skewed client/bridge deployments

## Suggested manual checklist

1. Open one browser in chat view only for a session.
   - Expected: no visible terminal breakage; binary frame traffic should not appear for that socket.
2. Open a second browser on the same session in terminal view.
   - Expected: first browser remains chat-safe; second browser receives terminal output normally.
3. Close terminal view in the second browser while keeping chat open in the first.
   - Expected: binary forwarding stops; passive continuity remains intact.
4. Force daemon reconnect.
   - Expected: effective `raw` mode is restored from current live browser state, not stale queued actions.
5. Run a version-skew check with new web client against an older bridge build.
   - Expected: explicit `raw` is ignored and behavior degrades to legacy raw-enabled semantics without protocol failure.
