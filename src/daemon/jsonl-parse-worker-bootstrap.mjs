/**
 * Bootstrap entry for the JSONL parse worker.
 *
 * Why this file exists: `new Worker(url)` spawns a fresh Node process whose
 * loader hooks are NOT inherited from the parent. Under `tsx` (dev / vitest)
 * this means the worker can't resolve our `.js`-suffixed TypeScript siblings.
 *
 * This file is plain ESM JavaScript — loadable by Node without any TS support.
 * It best-effort registers the tsx loader inside the worker, then dynamically
 * imports the real worker module. In production (where the whole tree is
 * compiled to JS), the register call silently no-ops and the `.js` import
 * works directly.
 *
 * We ship this file as-is via the Docker/build step — no TS transpilation
 * needed or wanted (that would defeat the purpose of a bootstrap).
 */

// Best-effort: register tsx's ESM loader so imports below can resolve .ts files.
// Wrapped in try/catch so production builds (no `tsx` in node_modules) silently
// continue with the pre-compiled .js worker.
try {
  const { register } = await import('tsx/esm/api');
  register();
} catch {
  // tsx not installed — we're running pre-compiled JS, which is fine.
}

// The worker's real implementation. In dev, tsx resolves this to .ts;
// in prod, Node loads the compiled .js directly.
await import('./jsonl-parse-worker.js');
