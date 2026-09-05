#!/usr/bin/env node
// CI guard (task 7.2): the controlled-node thin entry MUST NOT pull `node-pty`,
// `node-datachannel`, or any other native `.node` addon into its bundle.
// Besides breaking SEA packaging, a native WebRTC addon would make controlled-
// node replacement depend on the full daemon's acknowledged quiesce protocol.
// Bundle the production entry with esbuild and fail on any reachable native
// module instead.
import { build } from 'esbuild';

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
console.log(`✅ thin controlled-node dependency graph is native-free (${inputs.length} modules, node-pty and node-datachannel excluded).`);
