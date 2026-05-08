/**
 * Bootstrap entry for the file preview read worker.
 *
 * Worker threads do not inherit tsx's loader hooks from the parent process.
 * This plain ESM file mirrors `jsonl-parse-worker-bootstrap.mjs`: in dev and
 * Vitest it registers tsx inside the worker, while production loads the
 * compiled `.js` worker directly from `dist/`.
 */

try {
  const { register } = await import('tsx/esm/api');
  register();
} catch {
  // Production build: tsx is not needed because the worker is already JS.
}

await import('./file-preview-read-worker.js');
