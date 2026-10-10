#!/usr/bin/env node
// Explicit community-provider entry point. Modern builds never route through it.
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CONTROLLED_NODE_ABI_PROFILES, resolveNodeExeAbiProfile } from './controlled-node-abi.mjs';
import { verifyNodeExeManifestSet } from './node-exe-artifacts.mjs';

const pin = CONTROLLED_NODE_ABI_PROFILES.GLIBC217;
resolveNodeExeAbiProfile(pin.id, process.platform, process.arch);
execFileSync(process.execPath, ['scripts/build-node-exe.mjs'], {
  stdio: 'inherit', env: { ...process.env, NODE_EXE_ABI_PROFILE: pin.id },
});
await verifyNodeExeManifestSet(resolve('dist-node-exe'), [pin.fileName]);
execFileSync(resolve('dist-node-exe', pin.fileName), ['--version'], { stdio: 'inherit' });
// The deploy job verifies every platform marker against its own immutable SHA.
if (process.env.GITHUB_SHA) {
  if (!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA)) throw new Error('invalid_source_revision');
  await writeFile(resolve('dist-node-exe', `source-commit-${pin.id}.txt`), process.env.GITHUB_SHA);
}
