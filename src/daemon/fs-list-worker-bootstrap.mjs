try {
  const { register } = await import('tsx/esm/api');
  register();
} catch {
  // Production build: worker files are already compiled JavaScript.
}

await import('./fs-list-worker.js');
