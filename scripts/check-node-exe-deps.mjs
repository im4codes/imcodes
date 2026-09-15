#!/usr/bin/env node
// CI guard (task 7.2): the controlled-node thin entry MUST NOT pull `node-pty`,
// `node-datachannel`, or any other native `.node` addon into its bundle.
// Besides breaking SEA packaging, a native WebRTC addon would make controlled-
// node replacement depend on the full daemon's acknowledged quiesce protocol.
// Bundle the production entry with esbuild and fail on any reachable native
// module instead.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const THIN_ENTRY = 'src/node/index.ts';
// `ws` lazily requires these optional native accelerators inside try/catch; they
// are never required for correctness, so mark them external (not a violation).
const OPTIONAL_NATIVE = ['bufferutil', 'utf8-validate'];
const FORBIDDEN = [
  'node-pty',
  'node_pty',
  'node-datachannel',
  '.node',
  'node-gyp-build',
  'prebuild-install',
];

const result = await build({
  entryPoints: [THIN_ENTRY],
  bundle: true,
  platform: 'node',
  format: 'esm',
  metafile: true,
  write: false,
  logLevel: 'silent',
  external: OPTIONAL_NATIVE,
});

const inputs = Object.keys(result.metafile.inputs);
const violations = inputs.filter((p) => FORBIDDEN.some((n) => p.includes(n)));

if (violations.length > 0) {
  console.error('❌ thin controlled-node bundle pulls in native module(s):');
  for (const v of violations) console.error('   -', v);
  process.exit(1);
}

// Bundle membership was never the whole property, and checking only that let a
// fleet-wide outage through. `src/agent/tmux.ts` never imports `node-pty`; it
// calls `createRequire(...).resolve('node-pty')` from a module-level
// initializer that THROWS when the addon is absent. esbuild therefore saw no
// forbidden input, this guard printed a green line, and `imcodes-node.exe`
// still died at startup on every Windows node with
// "node-pty not found. Reinstall imcodes." — no process, so every self-upgrade
// failed its post-restart health check and rolled back.
//
// Judge the built artifact by RUNNING it, not by reading the graph. Two earlier
// attempts to infer this statically were both wrong: the metafile reports such
// an edge with an unresolved specifier AND `external: true`, and an unused
// static import is tree-shaken away entirely, so source-level reachability
// reports violations that do not exist in the artifact.
//
// `IMCODES_MUX=conpty` makes that same module-level initializer throw on any
// non-Windows host, so this reproduces the production failure mode portably:
// if tmux is initialized eagerly the process dies before `--version` can run.
const probeDir = mkdtempSync(join(tmpdir(), 'imcodes-node-eager-init-'));
const probePath = join(probeDir, 'thin-entry.cjs');
try {
  await build({
    entryPoints: [THIN_ENTRY],
    bundle: true, platform: 'node', format: 'cjs', outfile: probePath,
    external: OPTIONAL_NATIVE, logLevel: 'silent',
    define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
  });
  const probe = spawnSync(process.execPath, [probePath, '--version'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, IMCODES_MUX: 'conpty', IMCODES_TEST: '' },
  });
  if (probe.status !== 0) {
    console.error('❌ thin controlled-node entry fails during module initialization:');
    for (const line of (probe.stderr || '(no stderr)').split('\n').slice(0, 6)) {
      console.error('   ' + line);
    }
    console.error('   A module reached by a STATIC import threw while loading. Import it');
    console.error('   lazily at the call site (`await import(...)`) so startup cannot depend on it.');
    process.exit(1);
  }
} finally {
  rmSync(probeDir, { recursive: true, force: true });
}

console.log(`✅ thin controlled-node dependency graph is native-free (${inputs.length} modules, node-pty and node-datachannel excluded)`
  + ', and its bundle completes module initialization with no terminal backend available.');
