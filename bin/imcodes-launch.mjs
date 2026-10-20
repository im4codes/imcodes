#!/usr/bin/env node
// imcodes-launch.mjs -- what the macOS launch agent runs under `node` (the plist's program is the node binary itself).
//
// Why not the shell supervisor: macOS decides Full Disk Access from the program launchd starts. A plist that starts a script makes the
// access check run as `/usr/bin/env`, which no grant can ever name; a plist that starts node makes it run as node, which the user can
// grant (and that grant is inherited by the agents and tmux panes the daemon starts). The self-healing the shell supervisor does -- a
// half-finished `npm install -g` leaves empty dependency directories and the daemon dies on its first import -- still has to run before
// the daemon is imported, so it runs here, as a CHILD of this node process (a child cannot change who is responsible), then the real
// entry is imported into this very process.
//
// Builtins only, on purpose: node_modules being broken is exactly when this has to work. The literals below are pinned to the shared
// constants (shared/macos-daemon-launch.ts) by test/util/imcodes-launch-bootstrap.test.ts.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(PKG_ROOT, 'dist', 'src', 'index.js');
const PREFLIGHT = join(PKG_ROOT, 'bin', 'imcodes-launch.sh');
const PREFLIGHT_ONLY_ENV = 'IMCODES_LAUNCH_PREFLIGHT_ONLY';
const NODE_BIN_ENV = 'IMCODES_NODE_BIN';
// A reinstall over a slow link is the longest thing the preflight does.
const PREFLIGHT_TIMEOUT_MS = 20 * 60 * 1000;

function log(line) {
  process.stderr.write(`[imcodes-launch ${new Date().toISOString()}] ${line}\n`);
}

if (process.platform !== 'win32' && existsSync(PREFLIGHT)) {
  const result = spawnSync('/bin/bash', [PREFLIGHT, ...process.argv.slice(2)], {
    stdio: 'inherit',
    timeout: PREFLIGHT_TIMEOUT_MS,
    env: { ...process.env, [PREFLIGHT_ONLY_ENV]: '1', [NODE_BIN_ENV]: process.execPath },
  });
  // The preflight is best effort: whatever it did or failed to do, try to start the daemon (a retry by launchd repairs again).
  if (result.error) log(`preflight did not run: ${result.error.message}`);
  else if (result.status !== 0) log(`preflight exited with ${result.status ?? result.signal}; starting the daemon anyway`);
}

// Everything below sees the daemon entry as the program's script: self-restarts, recovery units and the main-module check read argv[1].
process.argv = [process.argv[0], ENTRY, ...process.argv.slice(2)];
try {
  await import(pathToFileURL(ENTRY).href);
} catch (error) {
  log(`cannot start the daemon: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
}
