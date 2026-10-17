# tsk_nbm R3 — identity-limit-expansion-r3-current-dev-48b897534-qwen-safe

## Why R3
The R2 bundle was built on cb210825 and was not hash-exact integrable onto current dev 48b897534, because both touch test/agent/transport-runtime-assembly.test.ts. The R2 auditor was cancelled before auditing. R3 carries the same implementation, re-based onto exact 48b897534.

## Migration (verified)
- Worktree detached at exact 48b897534d88269a7729c63677773489a8ac7a4c (was cb210825bbe13e89368ce56409ddaf26482e332a). R2 changes re-applied via git stash, with a full pre-migration backup of the tracked diff and untracked files.
- Dev delta cb210825..48b897534: one commit (48b897534 "fix(audit): accept structured validation evidence", tsk_nce), 5 paths: shared/audit-convergence.ts, src/daemon/supervision-prompts.ts, test/agent/transport-runtime-assembly.test.ts, test/daemon/supervision-prompts.test.ts, test/shared/audit-convergence.test.ts.
- Overlap with this task: exactly one path, test/agent/transport-runtime-assembly.test.ts. Auto-merge produced zero conflicts. Semantic check: all 5 tsk_nce structured-evidence assertion lines added on dev are present in the merged file, and this task's "identity through provider-neutral assembly" describe is present.
- tsk_hnh Codex fences preserved: occurrence counts of authReplaySafe (8), turnDispatchGeneration (17), missingRolloutRecoveryRetriesRemaining (4) and `this.child !== child` (6) are identical between dev 48b897534 and the merged codex-sdk.ts. This task's codex-sdk.ts diff removes no line mentioning rollout, replay or generation; it removes only the old 180k constant, its stale comment and the old head-keeping cap body.

## Validation on exact 48b897534 + this change (structured results)
- tsc daemon / server / web: exit 0, 0, 0. npm run build: exit 0.
- Daemon: the affected agent tests (priority-preserving-context-cap, qwen-provider, codex-sdk-provider, transport-runtime-assembly) plus full test/shared, test/daemon and test/store ran together: 436 files, 6678 passed, 23 skipped, 1 failed. The single failure is test/daemon/memory-mcp-stdio-lifecycle.test.ts "exits when it was already reparented before it ever ran, stdin still held". Isolated it fails 0/6 with this change and 0/6 on a git-archive of base 48b897534, and it imports no identity, Codex or Qwen code, so it is unrelated load-sensitive flakiness.
- The dev-changed tests (test/shared/audit-convergence.test.ts, test/daemon/supervision-prompts.test.ts) are inside that run and pass.
- Server identity routes: 6/6. Web identity panel + i18n: 19/19.
- Focused unmutated baseline for the mutant set: 9 files, 536/536.

## Mutants (compile-clean, rerun on R3 bytes)
22/22 KILLED: Q1-Q9 (Qwen byte-safe priority-preserving argv cap and shared shrink), C5/C7 (Codex ceiling and UTF-16 measure), S1-S4 (scope limits and code-point counting), M1 (MCP description), G1-G6 (one gate deletion per enforcement layer). The worktree fingerprint over the tracked diff plus untracked sources was identical before and after the run (9a67ff08696ebbfc), so no mutant residue could have produced a false kill.
