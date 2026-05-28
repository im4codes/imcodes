import { sha256Text } from './memory-content-hash.js';

/**
 * Stable, non-reversible session-name hash for LOG redaction (NOT security).
 *
 * A raw `sessionName` can encode project/role context (e.g. `deck_myapp_brain`)
 * and the central logger only redacts `_token`/`_key`/`_secret` suffixes, so the
 * timeline catch-up request chain logs this hash instead of the raw name. Shared
 * so the daemon (`src/daemon/command-handler.ts`) and the server
 * (`server/src/routes/watch.ts`) emit the SAME identifier for a given session.
 * Response bodies / on-disk timeline events keep `sessionName` for compatibility.
 *
 * Server/daemon only (resolves to `node:crypto` via `sha256Text`); not imported
 * by the web bundle.
 */
export function hashSessionName(sessionName: string): string {
  return `s_${sha256Text(sessionName).slice(0, 12)}`;
}
