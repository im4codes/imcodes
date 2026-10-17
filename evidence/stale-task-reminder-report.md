# Stale task reminder classification and suppression

## Scope

IMG_1315/IMG_1311 were supplied as descriptions rather than image/OCR files.
The visible titles were therefore matched only against the durable pair store;
the 17:56 timestamp is not used as evidence.  Every row below names the exact
pair id, status, material head/base, workspace state, and the read-only
`git -C /Users/k/codes/codedeck/codedeck merge-base --is-ancestor HEAD origin/dev`
check.  At capture time `origin/dev` resolved to
`ea5d889572f9e76e0cf6ed9e21ee8ee5e022c6a1`.

## Authoritative classification

| Producer/card source | Durable key and source of truth | Classification | Suppression/lifecycle |
| --- | --- | --- | --- |
| Finished-pair integration reminder | `integrationKey=<head>@<endedAt>`; `material.head`, `workspace.base`, and `inspectPairIntegration()` against the configured integration ref | **live reminder** only while status is `done`, not dismissed, the worktree is readable, and the head is not ancestor/patch-equivalent; **historical replay** when its queued digest is later admitted after all listed rows are integrated/dismissed | `integrationReminderCount`/`integrationReminderLastAt` survive restart; `integrationIntegratedAt` is terminal; `integrationDismissedAt` is terminal; queued aggregate admission drops an all-terminal digest |
| Workspace kept/unreadable notice | `workspaceKeptReminderKey=<path>\\0<endedAt>\\0<reason>`; `workspace.status=kept`, `keptReason` | **live recovery reminder** when the retention sweep cannot inspect/remove a workspace; not a merge/integration verdict | One successful delivery is suppressed durably; `workspaceKeptReminderCount` allows at most three attempts with a 15-minute backoff after `no_session`/`failed`; restart preserves the watermark |
| Task-bound nudge | `task-pair-nudge:<taskId>:<reason>:<messageId>` plus the pair row | **live** only while the pair is open; **historical replay** is dropped at queue admission after the pair is terminal | Queue admission uses the pair status; unknown rows remain authorized conservatively |
| Marker/replay event | Durable `task_pair_events.id` and `store.hasEvent()` | **historical replay** when the same event id is re-seen; no new transition or reminder is produced | Event-id dedup is persisted in SQLite and survives reconnect/restart |

## IMG_1315 card-by-card reconciliation

| Visible card text (durable title match) | Pair/status and exact material | Integration fact (`origin/dev` check) | Verdict in the current flow and why |
| --- | --- | --- | --- |
| `修复 Shell 静态画面卡顿` | `tsk_cd_shell_static_frame_latency`, **rework**; base `ea5d889572f9e76e0cf6ed9e21ee8ee5e022c6a1`, round-2 head `27de05daf55b394082caf0c0ca84a30d22b07882`; workspace active | `merge-base --is-ancestor 27de05... origin/dev` exited **1** | **Live rework/audit reminder**, not history and not an integration reminder. The pair is open and its latest event is `REWORK` at `1791108004409`; its card remains valid until a new READY/PASS. |
| `自动给执行者发任务心跳` | `tsk_cd_pair_idle_heartbeat`, **done**; material head `bb241f5fa4844d59d95a8194b95b835ead99bbd7`, base `dc0e1c2b4c53ad471eec738d5a2cf5c8df1e33c9`; workspace removed | `merge-base --is-ancestor bb241f5f... origin/dev` exited **1**; durable events show PASS then DONE, and a later `workspace_removed` | **Terminal historical replay; suppress.** It is not a live task and has no unresolved work. A replayed `task-pair-nudge:tsk_cd_pair_idle_heartbeat:<reason>:<messageId>` must be dropped by terminal admission. |
| `修复 memory-mcp-bootstrap 测试在满载下超时` | `tsk_cd_mcp_bootstrap_test_flake`, **done**; material head `a1bf0c6b17d1a7f6136a24de797508a86e1d83de`, base `4e58796cf7e616af83ce2b0ce92d7ae266eb87a5`; workspace ended | `merge-base --is-ancestor a1bf0c6b... origin/dev` exited **1**; durable row ended with DONE at `1790694554406` | **Terminal historical replay; suppress.** The title is the unambiguous memory-MCP match; no live reminder is authorized after terminal status. |
| `memory MCP 后端 exit 2 崩溃循环` (same screenshot wording may match this second memory row) | `tsk_cd_memory_mcp_orphan_spin`, **done**; material head `5a6b78999e71ea82592350ed86a4c31d883d24d8`, base `7d86c720822fefe2210fa1ded39605949d2eaba1`; workspace removed | `merge-base --is-ancestor 5a6b7899... origin/dev` exited **1**; terminal DONE at `1790499242693` | **Terminal historical replay; suppress.** This row is listed because the screenshot says “memory mcp” without a complete title; neither memory row is live. |
| `链路修复后续：关闭时补写用量记录、兼容不回 ACK 的旧服务器` | `tsk_cd_link_ack_followups`, **done**; material head `0931d66ff2a9a3e16d17cd9e7e4a29ec073bd209`, base `3792d02f56cdca77a65c89b7336b77d7d32eb74a`; workspace removed | `merge-base --is-ancestor 0931d66f... origin/dev` exited **1**; durable PASS then DONE at `1790395838614` | **Terminal historical replay; suppress.** The card is an old ACK task, not a new delivery/reminder. |
| `心跳与聊天消息和其他工作隔离` (if this is the heartbeat card shown in IMG_1315) | `tsk_cd_core_lane_isolation`, **done**; material head `72817c644d12577496b7e01446e682f7e2816aef`, base `55b420b2b0d43b07651cae78ec8e335d3e819d02`; workspace ended | `merge-base --is-ancestor 72817c64... origin/dev` exited **1**; durable PASS then DONE; Brain merge was a squash outside this stale-row DB snapshot | **Terminal historical replay; suppress.** The exact pair events include PASS/DONE and `workspace_removed`; it is not a live card. |

The ancestry result is deliberately reported rather than guessed: these old
material heads are not ancestors of the current `origin/dev` tip in this local
checkout.  That is **not** evidence that a squash is absent, so the rows are
classified by their durable terminal status and event history, not relabeled
as “unmerged” from a false ancestry inference.  An actual unmerged DONE pair
would be a **live integration reminder** only when `integration-drift` says
`unintegrated`; this report found no such open row among the screenshot title
matches.  A dismissed/terminal row is suppression-eligible even when an old
queued message is replayed.

## Why old cards remain visible

The screenshot stream combines live pair projection with replay of durable
`task_pair_events` and queued reminder messages.  A terminal row can therefore
remain visible as a historical replay until the client consumes the replay;
its presence is not proof of a current reminder.  Before this change,
`sendTaskPairMessage()` emitted the optimistic card before checking the pending
transport queue, so reconnect/scheduler races could create a second card.  The
new in-flight key is `target\0taskId\0reason`; the integration digest key is
`task-pair-nudge:__integration__:integration-drift:<messageId>`; workspace
retention uses `${workspace.path}\0${endedAt}\0${reason}`.  These keys explain
both the old replay and the one live rework card without relying on timestamp
or colour.

## Producer and dedupe findings

`sendTaskPairMessage()` is the common reminder producer.  Before this change it
checked the transport pending queue *after* emitting `user.message`, so a
reconnect could create a duplicate automation card even when transport returned
`skipped_pending`.  The check now precedes the projection and an in-flight key
(`target\\0taskId\\0reason`) coalesces scheduler/replay races.  The queued
aggregate integration digest is additionally checked against every listed pair
before resend; a digest is dropped only when all rows are known and integrated
or dismissed, while missing/unknown rows remain authorized.

## Exact reconciliation procedure

For each screenshot card, read `taskId/title` from the card, then query the
pair store for `status`, `workspace`, `material.head`, `material.base`,
`integrationDismissedAt`, and the liveness keys above.  Verify the named HEAD
with `git -C <workspace> rev-parse`, compare it with the integration ref, and
label the card `live`, `historical replay`, or `suppressed` using the table
above.  No workspace, commit, or user history is deleted by this change.

## Validation record

Machine: local macOS checkout at
`/Users/k/.imcodes/worktrees/imcodes/deck_sub_2h4w4508/pair_tsk_cd_stale_task_reminder_report_sol/repo`.
The exact HEAD is recorded in the READY marker; the validation below was run
before committing that HEAD and the report itself is content-only.

* Focused daemon regression: `npx vitest run --project daemon test/daemon/task-pairs/delivery.test.ts test/daemon/delegation-reply-ended-task-redelivery.test.ts test/daemon/task-pairs/integration-drift.test.ts --maxWorkers=2` — **3 files, 50 passed, 0 failed, 0 skipped**.
* Workspace/delivery regression: `npx vitest run --project daemon test/daemon/task-pairs/pairs-workspace.test.ts test/daemon/task-pairs/delivery.test.ts test/daemon/delegation-reply-ended-task-redelivery.test.ts --maxWorkers=2` — **3 files, 43 passed, 0 failed, 0 skipped**.
* Root typecheck: `npx tsc --noEmit --pretty false` — **pass**.
* Full daemon suite: `npx vitest run --project daemon --maxWorkers=2` — **968 files: 953 passed, 6 failed, 9 skipped; 13,176 tests: 13,079 passed, 10 failed, 87 skipped**. Failures were pre-existing environment/timing surfaces (macOS worker-artifact temp-module resolution, local-panel clock, main-checkout guard timing, non-git CoW disk budget, and an in-audit notification timing assertion); none touched the changed reminder/delivery paths.
* Server suite: `npx vitest run --project server --maxWorkers=2` — **123 files: 104 passed, 18 failed, 1 skipped; 1,449 tests: 1,440 passed, 8 failed, 1 skipped**. Failures are dependency/environment (`pg`, `node-cron`, `@simplewebauthn/server`) plus existing timeout/auth fixtures; no changed server files are involved.
* Web suite: `npx vitest run --project web --maxWorkers=2` — **379 files: 144 passed, 235 failed; 1,517 tests: 1,361 passed, 151 failed, 5 skipped**. Failing imports are missing Capacitor packages (`@capacitor/preferences`, `@capacitor/push-notifications`, etc.) in this checkout; reminder code is daemon-only.
* Server/web typechecks: `npx tsc -p server/tsconfig.json --noEmit --pretty false` and `npx tsc -p web/tsconfig.json --noEmit --pretty false` both fail on the same missing dependency families. Identical commands on an archived base (`ea5d889572f9e76e0cf6ed9e21ee8ee5e022c6a1`) produced the same first errors (`pg`/`proxy-addr`/`node-cron`/`@simplewebauthn/server`; web `@capacitor/*`/`preact`/`react-i18next`), proving environment failures. The archived base vitest run could not initialize because the shared Vitest module resolved `test/setup/isolated-home-global.ts` to the parent worktree; this harness-path failure is retained in `evidence/logs/base-known-failures.log` rather than misreported as a product result.
