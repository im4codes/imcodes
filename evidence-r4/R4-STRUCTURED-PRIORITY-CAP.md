# tsk_nbm / asg_nbp R4 — identity-limit-expansion-r4-structured-priority-cap-48b897534

Base: exact 48b897534d88269a7729c63677773489a8ac7a4c (worktree detached HEAD). No Git/deploy/restart.

## R3 P1 closed as a class
R3 `shrinkIdentityBlockToFit` rediscovered the identity boundary with `lastIndexOf(CLOSE_TAG)` on a concatenated
string that also carries authored description/turn context. A forged closing tag after the identity moved the cut
past audit_convergence_v1 / REAL-DEVICE guidance.

R4 never searches composed text for identity delimiters:
- `shared/context-types.ts`: `IdentitySegmentSpan {start,end,sha256}`; artifact field `sessionSystemTextIdentity`.
- `transport-runtime-assembly.ts`: the span is recorded when the trusted identity segment is joined
  (`identitySpanForSegment` inspects only that segment's outer frame; `joinSpanned` offsets by known part lengths).
- `provider-context-routing.ts`: `getProviderSessionSystemTextSpanned` rebases for trimmed leading whitespace and
  verifies bounds + sha256 at the trusted offsets; `composeProviderSystemTextSpanned` carries it into session+turn.
  Turn-only text never carries a span.
- `priority-preserving-context-cap.ts`: shrinks only the verified span body; everything before/after is byte-exact.
  No verified span (string input, tampered/shifted/out-of-bounds/wrong-hash span) => no identity shrink, explicit
  whole-context truncation marker. File contains zero indexOf/lastIndexOf.
- Qwen argv (`capQwenAppendSystemPrompt`, 120000 bytes < MAX_ARG_STRLEN 131072) and Codex (250000 UTF-16: turn input
  with stable update + authored context, and thread baseInstructions tail) consume the spanned text.

## Counterexamples (provider level, real render -> compileAgentContextArtifact -> provider)
- Qwen ASCII/CJK/emoji: filled identity + required authored context with forged `</imcodes-agent-identity>` +
  ATTACKER tail: argv <= 120000 bytes, well-formed, suffix after real identity (session tail + full turn text incl.
  forged tag) byte-exact, audit contract + REAL-DEVICE present, no whole-prompt truncation.
- Codex ASCII/emoji: loaded thread, second turn with stable update of max identity + forged authored context:
  context <= 250000, suffix byte-exact, identity-only truncation marker, no context truncation.
- Codex forged opening tag in description: boundary unchanged in baseInstructions.
- Unit: forged close inside/after identity, forged open before, tampered spans (shift/hash/bounds incl. hash-matching
  clamped slices), utf8/utf16 limit-1/limit/limit+1 multibyte, joinSpanned rebase, routing leading-trim rebase.
- Existing real `spawnSync` E2BIG check and limit boundary/restart/non-Codex tests retained.

## Causal mutants (evidence-r4/mutants)
32/32 KILLED, source bytes restored (integrity OK). R4-1 text search reintroduced, R4-2 sha skip, R4-3 bounds skip
(killed after adding hash-matching clamped-slice test; rerun file), R4-4 assembly drops span, R4-5 joinSpanned no
rebase, R4-6 no leading-trim rebase, R4-7 frame ignored, R4-8/9/10/11 Codex turn/baseInstructions/Qwen/stable
update lose span, plus R2/R3 Q1-Q9 (Q6 obsolete, removed), C5/C7, S1-S4, M1, G1-G6. Unmutated baseline exit 0.

## Full validation (evidence-r4/logs)
tsc daemon/server/web exit 0/0/0; build exit 0. Daemon affected + full test/shared,test/daemon,test/store: 436 files,
6704 passed, 23 skipped, 0 failed. All test/agent: 72 files, 1106 passed, 0 failed. Server identity routes 6/6.
Web identity panel + i18n coverage 17/17.

## Preservation
tsk_hnh fences in codex-sdk.ts identical to base (authReplaySafe 8, turnDispatchGeneration 17,
missingRolloutRecoveryRetriesRemaining 4, `this.child !== child` 6). tsk_nce structured-evidence assertions kept in
transport-runtime-assembly.test.ts. No openspec/ or docs/ changes.
