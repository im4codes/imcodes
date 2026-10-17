/**
 * Bootstrap entry for the exec helper process (see exec-helper.ts).
 *
 * The forked Node process does not inherit tsx loader hooks because the host
 * clears execArgv, so under `tsx` (dev / vitest) it can't resolve our `.js`-suffixed
 * TypeScript siblings. This plain-ESM file registers tsx's loader best-effort, then
 * imports the real module. In production the register call no-ops and the compiled
 * `.js` import works directly.
 *
 * Shipped as-is via the build (copy-worker-bootstraps.mjs) — no transpilation.
 */
try {
  const { register } = await import('tsx/esm/api');
  register();
} catch {
  // tsx not installed — running pre-compiled JS, which is fine.
}

const { runExecHelperWorker } = await import('./exec-helper-worker.js');
runExecHelperWorker();
