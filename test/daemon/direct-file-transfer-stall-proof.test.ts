import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
} from '../../shared/direct-file-transfer.js';
import {
  __observeDirectFileTransferControlForTests as observeControl,
  __resetDirectFileTransferForTests as resetProxy,
  handleDirectFileTransferCommand,
  initializeDirectFileTransfer,
  shutdownDirectFileTransfers,
} from '../../src/daemon/direct-file-transfer.js';

/**
 * Diagnostics go to a file, never stdout.
 *
 * A piped/captured stdout is buffered until the process exits, so a run that is
 * merely slow looks identical to one that is hung. That misread cost a full
 * investigation round earlier in this task; writing to a file removes the
 * ambiguity entirely.
 */
const DIAG = path.join(tmpdir(), 'dft-stall-proof.log');
const DIAG_ALT = '/tmp/dft-stall-proof.log';
const diag = (line: string): void => {
  for (const target of [DIAG, DIAG_ALT]) {
    try { appendFileSync(target, `${line}\n`); } catch { /* diagnostics only */ }
  }
};

/** Synchronously occupy the main event loop, exactly as a blocking batch would. */
function blockMainLoop(ms: number): { from: number; to: number } {
  const from = Date.now();
  while (Date.now() - from < ms) { /* deliberate: this is the failure being reproduced */ }
  return { from, to: Date.now() };
}

afterEach(async () => {
  await shutdownDirectFileTransfers().catch(() => undefined);
  resetProxy();
});

describe('direct file transfer survives a blocked daemon loop', () => {
  it('R-1: the real worker keeps producing while the main loop is fully blocked', async () => {
    await initializeDirectFileTransfer();
    // Worker-stamped emission times, captured before the proxy strips envelopes.
    const emittedAt: number[] = [];
    observeControl((at) => { emittedAt.push(at); });
    const received: unknown[] = [];
    const sender = {
      send: (message: unknown) => {
        received.push(message);
        diag(`main received: ${JSON.stringify(message).slice(0, 120)}`);
        return undefined;
      },
    };

    // A lease prepare makes the worker build a real PeerConnection and answer.
    await handleDirectFileTransferCommand({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'stall-proof-request',
      serverId: 'stall-proof-server',
      browserTabId: 'stall-proof-tab',
      leaseId: 'stall-proof-lease',
      leaseGeneration: 1,
      daemonGeneration: 1,
      iceServers: [],
      expiresAt: Date.now() + 60_000,
    }, sender);

    // Block the daemon loop hard, then let queued replies drain.
    const window = blockMainLoop(1_000);
    await new Promise((resolve) => setTimeout(resolve, 700));
    diag(`window=${window.from}..${window.to} received=${received.length}`);

    // The load-bearing assertion: the worker made progress DURING the stall.
    // Delivery is necessarily after the loop frees, so the proof is the
    // worker-stamped emission time landing inside the blocked window.
    diag(`emittedAt=${JSON.stringify(emittedAt)}`);
    expect(received.length, 'the worker replied at all').toBeGreaterThan(0);
    const producedDuringStall = emittedAt.filter((at) => at >= window.from && at <= window.to);
    // THE load-bearing assertion. Removing the worker hop puts this work back on
    // the blocked loop, where nothing can be produced until the block ends, so
    // no emission timestamp can fall inside the window and this fails.
    expect(
      producedDuringStall.length,
      'the worker must produce while the daemon loop is fully blocked',
    ).toBeGreaterThan(0);
  }, 60_000);
});
