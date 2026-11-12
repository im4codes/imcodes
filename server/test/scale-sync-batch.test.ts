import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createSubSessionsBatch } from '../src/db/queries.js';
import { WsBridge } from '../src/ws/bridge.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import {
  SUBSESSION_CREATED_BATCH_MSG,
  SUBSESSION_SYNC_BATCH_MAX_ITEMS,
  SUBSESSION_SYNC_BATCH_MSG,
} from '../../shared/scale-limits.js';

class MockWs extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  bufferedAmount = 0;
  sentFrames: string[] = [];
  send(data: string): void {
    this.sentFrames.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit('close', 1000, Buffer.from(''));
  }
  ping(): void {}
}

describe('server subsession batch sync & compatibility', () => {
  it('deduplicates duplicate (id, serverId) rows inside createSubSessionsBatch keeping the latest entry', async () => {
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const mockDb = {
      execute: async (sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        return { changes: 1 };
      },
    } as unknown as Database;

    await createSubSessionsBatch(mockDb, []);
    expect(executed).toHaveLength(0);

    await createSubSessionsBatch(mockDb, [
      { id: 's1', serverId: 'srv1', type: 'qwen', shellBin: null, cwd: '/old', label: 'old', ccSessionId: null },
      { id: 's2', serverId: 'srv1', type: 'shell', shellBin: '/bin/bash', cwd: '/two', label: 'two', ccSessionId: null },
      { id: 's1', serverId: 'srv1', type: 'qwen', shellBin: null, cwd: '/new', label: 'new', ccSessionId: null },
    ]);

    expect(executed).toHaveLength(1);
    expect(executed[0]!.params).toHaveLength(2 * 21);
    // Latest entry for s1 is retained (/new, new).
    expect(executed[0]!.params).toContain('/new');
    expect(executed[0]!.params).toContain('new');
    expect(executed[0]!.params).not.toContain('/old');
  });

  it('handles subsession.sync.batch with chunked DB writes and routes batch vs legacy vs share-scoped browser frames', async () => {
    const serverId = `batch-bridge-${Date.now()}`;
    const bridge = WsBridge.get(serverId);
    const tokenHash = createHash('sha256').update('tok').digest('hex');
    const executeCalls: number[] = [];
    const db = {
      queryOne: async (sql: string) => {
        if (sql.includes('token_hash')) {
          return { token_hash: tokenHash, owner_status: 'active', node_role: 'full', user_id: 'owner-1', revoked_at: null };
        }
        return null;
      },
      query: async () => [],
      execute: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO sub_sessions')) executeCalls.push(params.length / 21);
        return { changes: 1 };
      },
      exec: async () => {},
      transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
      close: () => {},
    } as unknown as Database;

    const env = {
      DB: db,
      JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
      BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
      SERVER_URL: 'https://app.im.codes',
      ALLOWED_ORIGINS: '',
      TRUSTED_PROXIES: '',
      BIND_HOST: '127.0.0.1',
      PORT: '3000',
      NODE_ENV: 'test',
      GITHUB_CLIENT_ID: '',
      GITHUB_CLIENT_SECRET: '',
      DATABASE_URL: '',
    } as Env;

    const daemonWs = new MockWs();
    bridge.handleDaemonConnection(daemonWs as never, db, env);
    daemonWs.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: 'tok', serverId })));
    await new Promise((r) => setTimeout(r, 30));

    // 1. Batch-capable owner browser
    const batchBrowser = new MockWs();
    bridge.handleBrowserConnection(batchBrowser as never, 'owner-1', db);
    batchBrowser.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'subsession.rebuild_all', subSessions: [], supportsCreatedBatch: true })),
    );
    // Bridge forwards supportsSyncBatch: true to daemon
    const rebuildForwarded = daemonWs.sentFrames.map((f) => JSON.parse(f) as Record<string, unknown>)
      .find((m) => m.type === 'subsession.rebuild_all');
    expect(rebuildForwarded?.supportsSyncBatch).toBe(true);

    // 2. Legacy owner browser (did not advertise supportsCreatedBatch)
    const legacyBrowser = new MockWs();
    bridge.handleBrowserConnection(legacyBrowser as never, 'owner-1', db);

    // 3. Share-scoped browser covering only `deck_proj_allowed_brain`
    const shareTarget = {
      kind: 'main' as const,
      serverId,
      sessionName: 'deck_proj_allowed_brain',
    };
    const shareSnapshot = {
      target: shareTarget,
      effectiveRole: 'participant' as const,
      historyCutoffAt: Date.now() - 1_000,
      nextCoverageRecheckAt: null,
      coveringShareIds: ['share-1'],
      primaryShareId: 'share-1',
      authorizedAt: Date.now(),
    };
    bridge.setShareCoverageResolverForTests(async () => shareSnapshot as never);
    const shareBrowser = new MockWs();
    bridge.handleShareBrowserConnection(shareBrowser as never, 'guest-1', db, {
      ticketId: 'tick-1',
      target: shareTarget as never,
      snapshot: shareSnapshot as never,
    });
    // Even if a share browser sends supportsCreatedBatch, it must receive per-item share-filtered frames only.
    shareBrowser.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'subsession.rebuild_all', subSessions: [], supportsCreatedBatch: true })),
    );

    const total = SUBSESSION_SYNC_BATCH_MAX_ITEMS + 5;
    const items = Array.from({ length: total }, (_, i) => ({
      id: `sync_b_${i}`,
      sessionType: 'qwen',
      runtimeType: 'transport',
      providerId: 'qwen',
      providerSessionId: `p-${i}`,
      cwd: i === 0 ? '/proj/allowed' : `/proj/other_${i}`,
      label: `w_${i}`,
      parentSession: i === 0 ? 'deck_proj_allowed_brain' : `deck_proj_other_${i}_brain`,
      state: 'idle',
    }));

    batchBrowser.sentFrames = [];
    legacyBrowser.sentFrames = [];
    shareBrowser.sentFrames = [];

    daemonWs.emit('message', Buffer.from(JSON.stringify({ type: SUBSESSION_SYNC_BATCH_MSG, items })));
    await vi.waitFor(() => {
      const legacyCreated = legacyBrowser.sentFrames
        .map((f) => JSON.parse(f) as Record<string, unknown>)
        .filter((m) => m.type === 'subsession.created');
      expect(legacyCreated).toHaveLength(total);
    });

    // Two DB batch chunks: 50 + 5
    expect(executeCalls).toEqual([SUBSESSION_SYNC_BATCH_MAX_ITEMS, 5]);

    // Batch-capable browser gets two `subsession.created.batch` frames totaling 55 items
    const batchOut = batchBrowser.sentFrames
      .map((f) => JSON.parse(f) as { type: string; items?: unknown[] })
      .filter((m) => m.type === SUBSESSION_CREATED_BATCH_MSG);
    expect(batchOut).toHaveLength(2);
    expect(batchOut[0]!.items).toHaveLength(SUBSESSION_SYNC_BATCH_MAX_ITEMS);
    expect(batchOut[1]!.items).toHaveLength(5);

    // Share-scoped browser NEVER gets subsession.created.batch and NEVER leaks other sessions' subs
    const shareMsgs = shareBrowser.sentFrames.map((f) => JSON.parse(f) as Record<string, unknown>);
    expect(shareMsgs.some((m) => m.type === SUBSESSION_CREATED_BATCH_MSG)).toBe(false);
    const shareCreatedIds = shareMsgs.filter((m) => m.type === 'subsession.created').map((m) => m.id);
    expect(shareCreatedIds).toEqual(['sync_b_0']);
  });
});
