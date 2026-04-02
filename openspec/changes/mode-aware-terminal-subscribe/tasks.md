## 1. Protocol and daemon support

- [x] 1.1 Extend the frontend `subscribeTerminal` API and related message types so terminal subscriptions can explicitly request `raw:true` or `raw:false`.
- [x] 1.2 No daemon change required for binary production. The daemon unconditionally wires `send` and `sendRaw` on every subscriber. Binary filtering is bridge-only. Confirm this behavior is correct and document it explicitly in daemon comments if needed.
- [ ] 1.3 Preserve backward compatibility for subscriptions that do not yet send an explicit `raw` flag during rollout, and verify the old/new client, bridge, and daemon combinations behave according to the rollout matrix.

## 2. Bridge aggregation and routing

- [x] 2.1 Replace session-only browser subscription tracking in the bridge with per-WebSocket per-session mode metadata and aggregate `totalRefs` / `rawRefs` counts.
- [x] 2.2 Implement idempotent mode replacement, late-action ordering rules, and bridge-side effective session forwarding mode transitions (upgrade to raw, downgrade to non-raw, unsubscribe) based on aggregate `rawRefs`/`totalRefs` changes.
- [x] 2.3 Make daemon reconnect replay derive terminal state from current aggregate bridge state rather than stale queued terminal messages, and filter raw binary PTY forwarding so only `raw:true` subscribers receive binary frames.

## 3. Frontend call sites and UX behavior

- [x] 3.1 Change app-wide default session and sub-session subscriptions to use `raw:false` for passive/chat continuity.
- [x] 3.2 Audit and update every terminal-opening surface — including main session terminal mode, sub-session windows, visibility/resume flows, reconnect restore paths, and any pinned/floating terminal panels — so terminal rendering requests `raw:true` only while needed. Completion requires two artifacts: (1) a caller inventory listing all `subscribeTerminal` call sites and their `raw` mode; (2) for each terminal-capable surface, a mode-transition table documenting the expected `raw` mode at connect/default, open, close, reconnect, and reset. Task is not closed without both artifacts.
- [x] 3.3 Verify visibility-resume, reconnect, and terminal reset flows preserve correct mode without re-enabling raw binary for chat-only views or dropping non-binary continuity unnecessarily.

## 4. Verification

- [x] 4.1 Add bridge tests for mixed-mode multi-client subscriptions, duplicate/idempotent mode declarations, late async actions, daemon mode upgrades/downgrades, reconnect replay authority, overflow/reset handling, and binary filtering.
- [x] 4.2 Add frontend tests covering passive non-raw subscription defaults, terminal-mode upgrade/downgrade behavior, and recovery behavior when switching back to `raw:true`.
- [ ] 4.3 Manually verify that chat-only sessions stop receiving unnecessary binary traffic, terminal rendering still works correctly across multiple browsers, and mixed-version rollout combinations match the compatibility rules.
