import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { measureAsyncPerf, percentile, round2 } from './perf-helpers.js';

vi.mock('../../../src/agent/tmux.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/agent/tmux.js')>();
  return {
    ...actual,
    sessionExists: vi.fn(async () => true),
    newSession: vi.fn(async () => {}),
    killSession: vi.fn(async () => {}),
    getPaneId: vi.fn(async () => '%1'),
  };
});

// Mock DB & auth only for Server Watch + Bridge isolation (never mock Daemon store/sync or watchRoutes/WsBridge logic).
const mockDbState = {
  mainSessions: [] as Array<Record<string, unknown>>,
  subSessions: [] as Array<Record<string, unknown>>,
  executeCalls: 0,
};

vi.mock('../../../server/src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'perf-user');
    c.set('role', 'owner');
    await next();
  },
  resolveServerRole: vi.fn(async () => 'owner'),
}));

vi.mock('../../../server/src/db/queries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/src/db/queries.js')>();
  return {
    ...actual,
    getFullServersByUserId: vi.fn(async () => [{ id: 'perf-srv', name: 'Perf Server' }]),
    getServerById: vi.fn(async () => ({ id: 'perf-srv', name: 'Perf Server' })),
    getDbSessionsByServer: vi.fn(async () => mockDbState.mainSessions),
    getSubSessionsByServer: vi.fn(async () => mockDbState.subSessions),
    getUserPref: vi.fn(async () => null),
    getSessionTextTailCache: vi.fn(async () => null),
    replaceSessionTextTailCache: vi.fn(async () => {}),
    upsertSessionTextTailCacheEvent: vi.fn(async () => {}),
    createSubSession: vi.fn(async (...args: unknown[]) => {
      mockDbState.executeCalls += 1;
      return { id: args[1], server_id: args[2] };
    }),
  };
});

import { handleWebCommand } from '../../../src/daemon/command-handler.js';
import { buildSessionList } from '../../../src/daemon/session-list.js';
import { listSessions, removeSession, upsertSession } from '../../../src/store/session-store.js';
function chunkSubSessionRebuildBatches<T>(items: readonly T[], maxBytes = 48 * 1024): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 64;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + 2;
    if (current.length > 0 && currentBytes + itemBytes > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = 64;
    }
    current.push(item);
    currentBytes += itemBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
import { WsBridge } from '../../../server/src/ws/bridge.js';
import { watchRoutes } from '../../../server/src/routes/watch.js';
import type { ServerLink } from '../../../src/daemon/server-link.js';
import type { Env } from '../../../server/src/env.js';

const MAIN_COUNT = 100;
const SUBS_PER_MAIN = 10;
const TOTAL_SUBS = MAIN_COUNT * SUBS_PER_MAIN; // 1000
const AGENT_TYPES = ['claude-code-sdk', 'codex-sdk', 'qwen', 'shell'] as const;

class MockWs extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  sentFrames: string[] = [];
  bufferedAmount = 0;

  send(data: string): void {
    this.sentFrames.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit('close', 1000, Buffer.from(''));
  }
  ping(): void {}
}

function makeMockDb() {
  const tokenHash = createHash('sha256').update('perf-token').digest('hex');
  return {
    queryOne: async (sql: string) => {
      if (sql.includes('token_hash')) {
        return { token_hash: tokenHash, owner_status: 'active', node_role: 'full', user_id: 'perf-user', revoked_at: null };
      }
      return null;
    },
    query: async () => [],
    execute: async () => {
      mockDbState.executeCalls += 1;
      return { changes: 1 };
    },
    exec: async () => {},
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(makeMockDb()),
    close: () => {},
  } as unknown as import('../../../server/src/db/client.js').Database;
}

function makeEnv(): Env {
  return {
    DB: makeMockDb(),
    JWT_SIGNING_KEY: 'perf-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'https://perf.local',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'test',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    DATABASE_URL: '',
  } as Env;
}

function seedDaemonStore100x1000() {
  for (const s of listSessions()) removeSession(s.name);
  const now = Date.now();
  const rebuildPayload: Array<{
    id: string;
    type: string;
    runtimeType: 'process' | 'transport';
    providerId: string;
    providerSessionId: string | null;
    cwd: string;
    label: string;
    parentSession: string;
    requestedModel?: string;
    activeModel?: string;
  }> = [];

  for (let m = 0; m < MAIN_COUNT; m++) {
    const mainName = `deck_proj_${m}_brain`;
    upsertSession({
      name: mainName,
      projectName: `proj_${m}`,
      role: 'brain',
      agentType: AGENT_TYPES[m % AGENT_TYPES.length]!,
      projectDir: `/tmp/perf/proj_${m}`,
      state: m % 5 === 0 ? 'running' : 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: now,
      updatedAt: now,
    });
    for (let s = 0; s < SUBS_PER_MAIN; s++) {
      const idx = m * SUBS_PER_MAIN + s;
      const agentType = AGENT_TYPES[idx % AGENT_TYPES.length]!;
      const runtimeType = agentType === 'shell' ? 'process' : 'transport';
      const id = `sub_${idx}`;
      rebuildPayload.push({
        id,
        type: agentType,
        runtimeType,
        providerId: agentType,
        providerSessionId: runtimeType === 'transport' ? `prov_${idx}` : null,
        cwd: `/tmp/perf/proj_${m}`,
        label: `worker ${idx}`,
        parentSession: mainName,
        ...(runtimeType === 'transport' ? { requestedModel: 'sonnet', activeModel: 'sonnet' } : {}),
      });
    }
  }
  return rebuildPayload;
}

describe('100 main + 1000 sub-session extreme scale backend benchmark', () => {
  const report: Record<string, unknown> = {
    label: process.env.PERF_LABEL ?? 'unlabeled',
    mainSessions: MAIN_COUNT,
    subSessions: TOTAL_SUBS,
  };

  beforeEach(() => {
    mockDbState.executeCalls = 0;
  });

  afterAll(() => {
    console.log(`[PERF_SCALE_BACKEND] ${JSON.stringify(report)}`);
  });

  it('benchmarks Daemon handleSubSessionRebuildAll + buildSessionList at 100+1000 scale', async () => {
    const rebuildPayload = seedDaemonStore100x1000();
    const batches = chunkSubSessionRebuildBatches(rebuildPayload);

    const emittedFrames: Array<Record<string, unknown>> = [];
    let serializedBytes = 0;
    const syncedSubIds = new Set<string>();
    let lastFrameAt = 0;

    const mockServerLink = {
      send: (msg: Record<string, unknown>) => {
        emittedFrames.push(msg);
        serializedBytes += Buffer.byteLength(JSON.stringify(msg), 'utf8');
        lastFrameAt = performance.now();
        if (msg.type === 'subsession.sync' && typeof msg.id === 'string') {
          syncedSubIds.add(msg.id);
        } else if (msg.type === 'subsession.sync.batch' && Array.isArray(msg.items)) {
          for (const item of msg.items as Array<{ id?: unknown }>) {
            if (typeof item?.id === 'string') syncedSubIds.add(item.id);
          }
        }
      },
    } as unknown as ServerLink;

    const rebuildPerf = await measureAsyncPerf(async () => {
      for (const batch of batches) {
        handleWebCommand({ type: 'subsession.rebuild_all', subSessions: batch, supportsSyncBatch: true }, mockServerLink);
      }
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (syncedSubIds.size >= TOTAL_SUBS) {
          // Wait one short settle tick to catch any trailing syncs.
          await new Promise((r) => setTimeout(r, 40));
          break;
        }
        // If patched daemon coalesces/skips redundant syncs cleanly, also stop once quiet for 250ms and store updated.
        if (syncedSubIds.size > 0 && performance.now() - lastFrameAt > 300 && listSessions().length >= MAIN_COUNT + TOTAL_SUBS) {
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      // Edge: even if 0 frames synced (unlikely on cold rebuild), wait for sessions in store
      while (listSessions().length < MAIN_COUNT + TOTAL_SUBS && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
    });

    const listSamples: number[] = [];
    const listPerf = await measureAsyncPerf(async () => {
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const built = await buildSessionList();
        listSamples.push(performance.now() - t0);
        expect(built.length).toBeGreaterThanOrEqual(MAIN_COUNT);
      }
    });

    report.daemonRebuild = {
      ...rebuildPerf.stats,
      batchesReceived: batches.length,
      outboundFrames: emittedFrames.length,
      syncedSubIds: syncedSubIds.size,
      serializedKb: round2(serializedBytes / 1024),
    };
    report.daemonBuildSessionList = {
      ...listPerf.stats,
      p50CallMs: percentile(listSamples, 50),
      p99CallMs: percentile(listSamples, 99),
      maxCallMs: percentile(listSamples, 100),
    };

    expect(listSessions().length).toBeGreaterThanOrEqual(MAIN_COUNT + TOTAL_SUBS);
  });

  it('benchmarks Server WsBridge subsession.sync ingestion + 3-browser broadcast & /watch/sessions N+1 RPCs', async () => {
    const serverId = `perf-srv-${Date.now()}`;
    const bridge = WsBridge.get(serverId);
    const db = makeMockDb();
    const env = makeEnv();
    const daemonWs = new MockWs();
    bridge.handleDaemonConnection(daemonWs as never, db, env);
    daemonWs.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: 'perf-token', serverId })));
    await new Promise((r) => setTimeout(r, 30));

    // Attach 3 connected browsers listening to broadcasts with batch capability
    const browserSockets = [new MockWs(), new MockWs(), new MockWs()];
    for (const bws of browserSockets) {
      bridge.handleBrowserConnection(bws as never, 'perf-user', db);
      bws.emit('message', Buffer.from(JSON.stringify({ type: 'subsession.rebuild_all', subSessions: [], supportsCreatedBatch: true })));
    }

    const syncMessages = Array.from({ length: TOTAL_SUBS }, (_, idx) => ({
      type: 'subsession.sync',
      id: `sub_${idx}`,
      sessionType: AGENT_TYPES[idx % AGENT_TYPES.length],
      runtimeType: idx % 4 === 3 ? 'process' : 'transport',
      providerId: AGENT_TYPES[idx % AGENT_TYPES.length],
      providerSessionId: idx % 4 === 3 ? null : `prov_${idx}`,
      cwd: `/tmp/perf/proj_${Math.floor(idx / SUBS_PER_MAIN)}`,
      label: `worker ${idx}`,
      parentSession: `deck_proj_${Math.floor(idx / SUBS_PER_MAIN)}_brain`,
      state: 'idle',
      requestedModel: 'sonnet',
      activeModel: 'sonnet',
    }));

    const preFrameCounts = browserSockets.map((b) => b.sentFrames.length);
    const bridgeSyncPerf = await measureAsyncPerf(async () => {
      for (let i = 0; i < syncMessages.length; i += 50) {
        daemonWs.emit('message', Buffer.from(JSON.stringify({
          type: 'subsession.sync.batch',
          items: syncMessages.slice(i, i + 50),
        })));
      }
      // Allow async DB promises to settle
      await new Promise((r) => setTimeout(r, 60));
    });

    const browserFramesDelta = browserSockets.reduce((sum, b, i) => sum + (b.sentFrames.length - preFrameCounts[i]!), 0);
    const browserBytesDelta = browserSockets.reduce(
      (sum, b, i) => sum + b.sentFrames.slice(preFrameCounts[i]!).reduce((s, f) => s + Buffer.byteLength(f, 'utf8'), 0),
      0,
    );

    report.serverBridgeSync1000 = {
      ...bridgeSyncPerf.stats,
      dbExecuteCalls: mockDbState.executeCalls,
      browserFramesTotal: browserFramesDelta,
      browserBroadcastKb: round2(browserBytesDelta / 1024),
    };

    // Prepare Watch route 100 main + 1000 sub dataset
    mockDbState.mainSessions = Array.from({ length: MAIN_COUNT }, (_, m) => ({
      name: `deck_proj_${m}_brain`,
      project_name: `proj_${m}`,
      label: `Main ${m}`,
      state: 'idle',
      agent_type: 'claude-code-sdk',
    }));
    mockDbState.subSessions = Array.from({ length: TOTAL_SUBS }, (_, idx) => ({
      id: `sub_${idx}`,
      server_id: serverId,
      type: 'claude-code-sdk',
      label: `Sub ${idx}`,
      closed_at: null,
      parent_session: `deck_proj_${Math.floor(idx / SUBS_PER_MAIN)}_brain`,
      state: 'idle',
    }));

    let currentInFlight = 0;
    let peakInFlight = 0;
    let rpcCalls = 0;
    const getRecentSpy = vi.spyOn(WsBridge.prototype, 'getRecentTextForWatch').mockImplementation(async () => {
      rpcCalls += 1;
      currentInFlight += 1;
      if (currentInFlight > peakInFlight) peakInFlight = currentInFlight;
      await new Promise((r) => setTimeout(r, 8));
      currentInFlight -= 1;
      return [{ text: 'recent preview text', ts: Date.now() }];
    });

    const app = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();
    app.route('/api', watchRoutes);

    const watchSamples: number[] = [];
    const watchPerf = await measureAsyncPerf(async () => {
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        const res = await app.request(
          `/api/watch/sessions?serverId=${encodeURIComponent(serverId)}`,
          { method: 'GET' },
          env,
        );
        expect(res.status).toBe(200);
        const body = await res.json() as { sessions: unknown[]; subSessions?: unknown[] };
        expect(body.sessions.length).toBeGreaterThanOrEqual(MAIN_COUNT);
        watchSamples.push(performance.now() - t0);
      }
    });

    getRecentSpy.mockRestore();

    report.serverWatch100x1000 = {
      ...watchPerf.stats,
      p50ReqMs: percentile(watchSamples, 50),
      p99ReqMs: percentile(watchSamples, 99),
      maxReqMs: percentile(watchSamples, 100),
      totalWatchTextCalls: rpcCalls,
      peakConcurrentWatchTextCalls: peakInFlight,
    };

    daemonWs.close();
    for (const bws of browserSockets) bws.close();
  });
});
