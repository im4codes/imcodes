# Exact-head validation: resource claims + main-checkout guard

- Machine: local macOS host (same checkout machine), worktree `/Users/k/.imcodes/worktrees/imcodes/deck_sub_2h4w4508/pair_tsk_cd_pair_resource_claims/repo`
- HEAD under audit: `86a94a54c8b8172e6564b5ad69ce1f412d5d81fb` (resource-claim/guard repair plus catalog publication). Parent implementation was `8a24fdfa242cdf6e41be544e9437959c3254fc88`.
- Base: `d8b7f03eadc79d86ff3881c99ee92a3c54322057` in sibling `base-check` worktree.
- Main checkout remained untouched.

## HEAD commands/results

- `pnpm exec tsc --noEmit`: PASS
- `pnpm exec tsc`: PASS
- `./server/node_modules/.bin/tsc --noEmit -p server/tsconfig.json`: PASS
- `./web/node_modules/.bin/tsc --noEmit -p web/tsconfig.json`: PASS
- `(cd server && npm run build)`: PASS
- `(cd web && npm run build)`: PASS
- Focused resource/guard: `pnpm exec vitest run test/daemon/task-pairs/resource-claims.test.ts test/daemon/task-pairs/scheduler.test.ts --pool=threads --maxWorkers=2`: 2 files, 74 tests PASS.
- MCP catalog regression focus (after catalog/group repair): 3 files, 52 tests PASS.
- `pnpm test:unit`: 886 files passed, 2 skipped? Full run before the catalog publication commit: 897 files, 886 passed, 2 failed, 9 skipped; 12,012 passed, 3 failed, 83 skipped. The two failures are `test/node/remote-desktop-worker-artifacts.test.ts` (2 tests; missing isolated fixture artifact). The third transient full-suite failure was `test/daemon/direct-file-transfer.test.ts` live-upload capacity test; isolated rerun `pnpm exec vitest run test/daemon/direct-file-transfer.test.ts --project daemon --minWorkers=1 --maxWorkers=1` passed 1 file/47 tests.
- `pnpm test:server`: 120 files, 1 skipped; 1,556 passed, 1 skipped.
- `pnpm test:web`: 354 files; 4,775 passed, 9 skipped.
- `pnpm test:e2e`: 28 files passed, 3 skipped; 169 passed, 5 skipped.

## Base commands/results

- `pnpm exec tsc --noEmit`: PASS.
- Server/web tsc and builds: PASS (`server tsc`, `server npm run build`, `web tsc`, `web npm run build`).
- `pnpm test:unit`: 895 files passed, 1 failed, 9 skipped; 11,976 passed, 2 failed, 80 skipped. The only failures are the same two `remote-desktop-worker-artifacts.test.ts` fixture-artifact checks.
- Named base comparison for HEAD's transient direct-transfer failure: `../repo/node_modules/.bin/vitest run test/daemon/direct-file-transfer.test.ts test/node/remote-desktop-worker-artifacts.test.ts --project daemon --minWorkers=1 --maxWorkers=3`: direct-file 47/47 passed; only the same 2 artifact tests failed.
- `pnpm test:server`: 103 files passed, 17 failed, 1 skipped; 1,412 passed, 7 failed, 1 skipped (base-only existing environment/auth setup failures; HEAD server suite has 1,556/1,556 pass).
- `pnpm test:web`: 353 files passed; 4,766 passed, 9 skipped.
- `pnpm test:e2e`: 28 files passed, 3 skipped; 169 passed, 5 skipped.

Focused and full-suite raw logs are retained under `/tmp/pair-*` during validation; this summary is inside the pair worktree.
