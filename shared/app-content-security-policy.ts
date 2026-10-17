/**
 * The Content-Security-Policy the server sends with the web app's HTML.
 *
 * One definition for the server header and for the tests that load the app under the real policy. `blob:` is allowed
 * only where the page itself shows or reads data it created from a file the user picked: `img-src` (the composer's
 * attachment preview and the lightbox are `<img src="blob:...">`) and `connect-src` (the lightbox's Save / Copy read that
 * same blob back with fetch). A blob URL can only name data created by this origin's own scripts; neither source reaches
 * the network, and script, frame, object and media sources are untouched.
 */
export const APP_CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'default-src': ["'self'"],
  // Vite bundles an inline runtime; tighten with hashes in future.
  'script-src': ["'self'", "'unsafe-inline'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'connect-src': ["'self'", 'wss:', 'ws:', 'https://api.github.com', 'blob:'],
  'worker-src': ["'self'", 'blob:'],
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  'font-src': ["'self'"],
  'frame-ancestors': ["'none'"],
});

export function buildAppContentSecurityPolicy(
  directives: Readonly<Record<string, readonly string[]>> = APP_CSP_DIRECTIVES,
): string {
  return Object.entries(directives).map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}
