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

// A daemon upgrade can briefly leave the child on an older system Node even
// though the bundled parent is current. Probe the builtin before importing the
// SQLite-owning worker so Windows reports an actionable diagnostic instead of
// an opaque ERR_UNKNOWN_BUILTIN_MODULE and an endless respawn loop.
try {
  const { createRequire } = await import('node:module');
  createRequire(import.meta.url)('node:sqlite');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const detail = `[context-store-worker] node:sqlite unavailable; node=${process.version} execPath=${process.execPath}; ${message}`;
  console.error(detail);
  if (typeof process.send === 'function') {
    try {
      process.send(
        { type: 'worker_runtime_error', code: 'node_sqlite_unavailable', message: detail },
        () => { try { process.disconnect?.(); } catch { /* already disconnected */ } },
      );
    } catch { /* exiting */ }
  }
  process.exitCode = 78;
}

if (process.exitCode !== 78) await import('./context-store-worker.js');
