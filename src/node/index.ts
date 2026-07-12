#!/usr/bin/env node
import { bootstrapControlledNode, defaultBootstrapDeps } from './bootstrap.js';
import { createControlledNodeRuntime } from './runtime.js';

async function main(): Promise<void> {
  // Journaled first-run bootstrap: prepares the protected credential dir BEFORE
  // redeeming the one-time token and backs off (never re-redeems) if persist
  // fails — see bootstrap.ts / task 10.10. A normal boot just loads the credential.
  const credential = await bootstrapControlledNode(defaultBootstrapDeps(Date.now()));
  const runtime = createControlledNodeRuntime(credential);
  runtime.start();
  const stop = () => {
    runtime.stop();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

void main().catch((error) => {
  process.stderr.write(`imcodes-node: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
