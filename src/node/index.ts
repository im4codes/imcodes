#!/usr/bin/env node
import {
  burnEnrollmentBlob,
  loadCredential,
  persistCredential,
  readEnrollmentBlob,
  redeemEnrollment,
} from './enrollment.js';
import { createControlledNodeRuntime } from './runtime.js';

async function main(): Promise<void> {
  let credential = await loadCredential();
  if (!credential) {
    const blob = await readEnrollmentBlob();
    if (!blob) throw new Error('controlled node is not enrolled');
    credential = await redeemEnrollment(blob);
    await persistCredential(credential);
    await burnEnrollmentBlob().catch(() => {});
  }
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
