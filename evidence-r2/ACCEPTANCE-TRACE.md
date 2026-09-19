# tsk_nbm R2 — acceptance → evidence (structured; raw logs are supporting only)

Base: exact origin/dev cb210825bbe13e89368ce56409ddaf26482e332a (worktree migrated; no commits made).

## Current-dev semantic reconciliation with tsk_hnh (cb210825 "fix(codex): recover missing rollout without replay")
- Only files overlapping: src/agent/providers/codex-sdk.ts and test/agent/codex-sdk-provider.test.ts. 3-way stash merge applied with zero conflicts.
- Verified after merge: my codex-sdk.ts change set (54 lines) and test change set (161 lines) are line-identical to R1; counts of every tsk_hnh fence (`missingRolloutRecoveryRetriesRemaining > 0`, `&& authReplaySafe`, `state.turnDispatchGeneration === turnDispatchGeneration`, `if (this.child !== child) return;`) are identical between the merged file and cb210825. tsk_hnh touches recovery/resume only; my change touches the injection cap. No behavioural overlap.
- Full codex-sdk-provider suite (tsk_hnh tests + mine): passes (logs/05).

## Acceptance
1. Codex 250000 preserves system/developer/security/supervision priority; user identity never displaces higher-authority text; other providers keep their limits.
   - Shared src/agent/priority-preserving-context-cap.ts: overflow is spent inside the user-authored identity block only (head kept, marker, LAST closing tag, code-point-safe cut); plain cut only if even an empty identity cannot fit.
   - Codex uses it with UTF-16 measure and 250_000. RED on base (R1): base drops the audit_convergence_v1 contract.
   - Qwen (the E2BIG finding): capQwenAppendSystemPrompt with UTF-8 byte measure and QWEN_APPEND_SYSTEM_PROMPT_MAX_BYTES = 120_000 < LINUX_MAX_ARG_STRLEN 131_072 (NUL included). Byte-safe, deterministic, priority-preserving. Claude Agent SDK and Qoder SDK send system prompts over the stdin initialize message and are unchanged. No other provider limit changed.
2. Overlap / no unaudited bytes / no Git before PASS. R1 overlap check (tsk_n27/tsk_n23/tsk_hqx) still holds; the only new base delta (tsk_hnh) was reconciled above. Nothing staged, committed, pushed, deployed or restarted.
3. Units and every path: identity limits count Unicode code points after NFC+trim (shared validator used by server API, daemon MCP set, MCP send_message ingress, send-tool, command-handler, web panel). Codex budget: UTF-16 units. Qwen budget: UTF-8 bytes (argv).
4. Boundary / multibyte / restart / provider / gate mutants:
   - shared: limit-1/limit/limit+1 per scope, emoji, newlines, NFC, trim, combined max.
   - server route: every scope at limit accepted, limit+1 rejected; 200k emoji (>800KB body) stored and read back.
   - store: fresh-process restart restores a filled multibyte three-scope identity byte-for-byte.
   - helper: exact budget untouched; one unit over cut inside identity only; ASCII/CJK/emoji never split, longest legal prefix; forged tag; fallbacks.
   - Codex: end-to-end priority, forged tag, surrogate at two budgets, under-budget untouched, CJK fills the UTF-16 budget.
   - Qwen: filled ASCII/CJK/emoji identities → sent argument ≤ 120000 bytes, well-formed, supervision contract and closing tag kept; real spawnSync of the exact sent argument exits 0; uncapped control E2BIG (per-argument on Linux; >ARG_MAX on any POSIX for filled emoji). RED on base qwen.ts: 5 failed (logs/08), including the real emoji E2BIG spawn on macOS.
   - Mutants: mutants/r2-mutants-results.txt — 22/22 KILLED (Q1–Q9 helper/Qwen, C5/C7 Codex, S1–S4, M1, G1–G6 one per enforcement layer).
5. Consistency across write/read/composition/transport/UI: shared validator everywhere; Codex and Qwen use the same deterministic priority-preserving cap with their own transport unit.

## Structured results (this revision, base cb210825)
- tsc daemon/server/web: exit 0. Build: exit 0.
- Daemon affected suites: 435 files / 6678 tests passed, 0 failed.
- Server identity routes 6/6. Web identity + i18n 19/19.

## Honest notes
- On macOS the 200k-CJK real-spawn test cannot go RED (no per-argument limit; ~600KB single argument is spawnable); its E2BIG control runs on Linux only. The filled-emoji real-spawn test does exercise E2BIG on macOS.
- QWEN fallback: if non-identity system text alone exceeded 120000 bytes, a byte-safe head cut applies. That cannot be caused by user identity, which is always spent first.
