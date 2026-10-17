# tsk_nbm / asg_nbp R6 — identity-limit-expansion-r6-ui-normalized-counter-clean-authority-48b897534

Clean-authority successor of R5 (same scope: audited UI normalized-counter class). No code bytes changed from the
green R5 result; they are adopted under R6 after verification.

- Base: exact 48b897534d88269a7729c63677773489a8ac7a4c.
- Verification: all 79 product/evidence files in the worktree hash-match the green R5 freeze
  (1cb3481389c79b5f538e66b2c2f0143e441f7412504f2fe54cd13d687cb2c07e) with no extra changed files. That includes
  web/src/components/SessionIdentityTabs.tsx and shared/session-identity.ts (sha256 78094d04557f5fc937a52a3e75bc8e98ddc091340379115e335c6b2fa10ef6e2).
  The invalid R5 binding 6fc975 (R4 bytes) is not used.
- R6 file events recorded for shared/session-identity.ts, web/src/components/SessionIdentityTabs.tsx,
  web/test/components/SessionIdentityTabs.limit.test.tsx, test/shared/session-identity.test.ts.
- Fix, counterexamples, mutants (7/7 KILLED) and full validation (tsc x3 + build 0; daemon 6710/0; agent 1106/0;
  server 6/6; web identity+i18n 29/29; web components 1553/0) are in evidence-r5/R5-UI-NORMALIZED-COUNTER.md and
  apply byte-for-byte to R6.
