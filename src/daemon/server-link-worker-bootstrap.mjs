// Worker bootstrap for the core ServerLink lane. The plain JS entry point is
// loadable by Node in production and registers tsx when running from source.
try {
  const { register } = await import('tsx/esm/api');
  register();
} catch {
  // Production bundles do not need a TypeScript loader.
}
await import('./server-link-worker.js');
