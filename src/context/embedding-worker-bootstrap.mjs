/**
 * Bootstrap entry for the embedding inference worker.
 *
 * `new Worker(url)` spawns a fresh Node thread whose loader hooks are NOT
 * inherited, so under `tsx` (dev / vitest) the worker can't resolve our
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

await import('./embedding-worker.js');
