/**
 * Bootstrap entry for the embedding worker.
 *
 * Why this file exists: `new Worker(url)` spawns a fresh Node process whose
 * loader hooks are NOT inherited from the parent. Under `tsx` (dev / vitest)
 * this means the worker can't resolve `.js`-suffixed TypeScript siblings.
 *
 * This file is plain ESM JavaScript — loadable by Node without any TS
 * support. It best-effort registers the tsx loader inside the worker, then
 * dynamically imports the real worker module. In production (where the
 * whole tree is compiled to JS), the register call silently no-ops and the
 * `.js` import works directly.
 *
 * We ship this file as-is via the Docker/build step — no TS transpilation
 * needed or wanted (that would defeat the purpose of a bootstrap).
 *
 * Mirrors `src/daemon/jsonl-parse-worker-bootstrap.mjs` — keep the two in
 * sync if the loader-registration story changes upstream.
 */

try {
  const { register } = await import('tsx/esm/api');
  register();
} catch {
  // tsx not installed — pre-compiled JS, fine.
}

await import('./embedding-worker.js');
