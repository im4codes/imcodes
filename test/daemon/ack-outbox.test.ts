import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AckOutbox } from '../../src/daemon/ack-outbox.js';
import { MSG_COMMAND_ACK } from '../../shared/ack-protocol.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'imcodes-ack-outbox-'));
  file = join(dir, 'ack-outbox.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The not-found append ack is the ONLY reliable carrier of the recipient-gated
 * queue authority; the timeline session.state beside it is best-effort. That
 * makes verbatim persistence and replay of `extras` load-bearing rather than
 * incidental metadata: if a restart or a reconnect dropped those fields, the
 * browser would receive the error without the snapshot and restore the ghost
 * card the canonical queue no longer has.
 */
describe('ack outbox queue-authority extras', () => {
  const authority = {
    queueEpoch: 'queue-epoch-1',
    queueAuthorityId: 'queue-authority-1',
    pendingMessageVersion: 8,
    pendingMessageEntries: [],
    failedMessageEntries: [],
    queueReconcilesCommandId: 'cmd-append-1',
  };

  it('replays the full queue authority verbatim after a process restart', async () => {
    const first = new AckOutbox(file);
    await first.init(0);
    await first.enqueue({
      commandId: 'cmd-append-1',
      sessionName: 'deck_transport_brain',
      status: 'error',
      error: 'Queued message not found',
      extras: { ...authority },
      ts: Date.now(),
    });
    await first.close();

    // A fresh instance reads only what reached disk.
    const restarted = new AckOutbox(file);
    await restarted.init(0);
    const sent: Record<string, unknown>[] = [];
    await restarted.flushOnReconnect((msg) => {
      sent.push(msg as unknown as Record<string, unknown>);
      return true;
    });
    await restarted.close();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: MSG_COMMAND_ACK,
      commandId: 'cmd-append-1',
      session: 'deck_transport_brain',
      status: 'error',
      error: 'Queued message not found',
      ...authority,
    });
  });

  it('keeps the authority pending when the send fails, so a later reconnect still carries it', async () => {
    const outbox = new AckOutbox(file);
    await outbox.init(0);
    await outbox.enqueue({
      commandId: 'cmd-append-2',
      sessionName: 'deck_transport_brain',
      status: 'error',
      error: 'Queued message not found',
      extras: { ...authority, queueReconcilesCommandId: 'cmd-append-2' },
      ts: Date.now(),
    });

    await outbox.flushOnReconnect(() => false);
    expect(outbox.snapshot().map((entry) => entry.commandId)).toEqual(['cmd-append-2']);

    const sent: Record<string, unknown>[] = [];
    await outbox.flushOnReconnect((msg) => {
      sent.push(msg as unknown as Record<string, unknown>);
      return true;
    });
    await outbox.close();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      queueEpoch: 'queue-epoch-1',
      queueAuthorityId: 'queue-authority-1',
      pendingMessageVersion: 8,
      queueReconcilesCommandId: 'cmd-append-2',
    });
  });
});
