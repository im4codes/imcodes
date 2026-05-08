// Re-export of the canonical `shared/repo-types.ts`.
//
// This used to be a `120000` symlink (`../../shared/repo-types.ts`).
// Symlinks don't survive a default Windows git checkout (`core.symlinks=false`,
// the default unless the user has Developer Mode or runs as admin), where
// git materializes them as plain text files containing the link target —
// which `tsc` then fails to parse with TS1128, breaking `npm run build`
// and every script that depends on it (including `scripts/restart-daemon.cmd`).
//
// A re-export file works identically on every OS without requiring symlinks.
// Daemon and server still import from `'../shared/repo-types.js'`; this file
// transparently forwards to the canonical `shared/repo-types.ts`.
export * from '../../shared/repo-types.js';
