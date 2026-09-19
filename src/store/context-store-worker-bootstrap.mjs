/**
 * Bootstrap entry for the context-store worker.
 *
 * The forked Node process does not inherit tsx loader hooks because the host
 * deliberately clears execArgv, so under `tsx` (dev / vitest) it can't resolve our
 * `.js`-suffixed TypeScript siblings. This plain-ESM file registers tsx's
 * loader best-effort, then imports the real worker module. In production the
 * register call no-ops and the compiled `.js` import works directly.
 *
 * Shipped as-is via the build (copy-worker-bootstraps.mjs) — no transpilation.
 */
try {
  const { register } = await import('tsx/esm/api');
  register();
} catch {
  // tsx not installed — running pre-compiled JS, which is fine.
}

await import('./context-store-worker.js');
