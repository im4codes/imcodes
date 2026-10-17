# tsk_nbm / asg_nbp R5 — identity-limit-expansion-r5-ui-normalized-counter-48b897534

Base: exact 48b897534d88269a7729c63677773489a8ac7a4c. R4 bytes retained; only the audited UI unit class changed.
No Git/deploy/restart.

## R4 P1 closed as a class
R4 web/src/components/SessionIdentityTabs.tsx rendered `Array.from(draft.content).length` while every gate counts
code points after NFC + trim. `("é").repeat(200000)` displayed 400000/200000 while the gate accepted it.

Fix: `shared/session-identity.ts` exports `sessionIdentityContentLength(value)` =
`Array.from(normalizeSessionIdentityContent(value)).length`, the single authoritative unit. `sessionIdentityContentError`
(used by server route, MCP set/send, send-tool, command-handler and the web gate) and the web character counter
both use it for every scope. No other UI surface renders an identity count (grep web/src, mobile).

## Counterexamples
- web/test/components/SessionIdentityTabs.limit.test.tsx: for user, project and session scopes: NFC-decomposed at
  limit and limit+1, surrounding whitespace at limit and limit+1. The displayed count equals the normalized count
  (raw length is larger). displayed>limit <=> gate rejects <=> scoped error shown. Existing emoji limit-1/limit/limit+1 kept.
- test/shared/session-identity.test.ts: length unit cases (decomposed, padded, emoji, CJK+newline, empty) and gate
  agreement at limit/limit+1 for decomposed and padded input in every scope.

## Causal mutants (evidence-r5/mutants), compile-clean, integrity OK
U1 UI raw code points, U2 UI skips NFC, U3 UI skips trim, U4/U5 shared length skips normalization (daemon + web
views), S4 validator counts UTF-16 (re-anchored), G6 web gate removed: 7/7 KILLED. R4's other 30 mutants target
unchanged bytes (evidence-r4/mutants, 32/32).

## Full validation (evidence-r5/logs)
tsc daemon/server/web 0/0/0; build 0. Daemon affected + full test/shared,test/daemon,test/store: 6710 passed,
23 skipped, 0 failed. All test/agent: 1106 passed, 0 failed. Server identity routes 6/6. Web identity + i18n
coverage 29/29. All web/test/components: 1553 passed, 8 skipped, 0 failed.

## Preservation
tsk_hnh codex-sdk fences unchanged from R4 (codex-sdk.ts not touched in R5). No openspec/ or docs/ changes.
