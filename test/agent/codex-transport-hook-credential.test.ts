import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildCodexMcpThreadConfig } from '../../src/agent/providers/codex-sdk.js';
import { closeHookServer, startHookServer } from '../../src/daemon/hook-server.js';
import { MEMORY_MCP_HTTP_PATH } from '../../src/daemon/memory-mcp-http.js';
import { HOOK_SESSION_CREDENTIAL_ENV } from '../../shared/hook-session-credential.js';
import {
  launchTransportSession,
  restoreTransportSessions,
  stopTransportRuntimeSession,
} from '../../src/agent/session-manager.js';
import * as store from '../../src/store/session-store.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import {
  CONNECTION_MODES,
  SESSION_OWNERSHIP,
  type SessionConfig,
  type TransportProvider,
} from '../../src/agent/transport-provider.js';

const capturedConfigs: SessionConfig[] = [];

const fakeProvider: TransportProvider = {
  id: 'codex-sdk',
  connectionMode: CONNECTION_MODES.LOCAL_SDK,
  sessionOwnership: SESSION_OWNERSHIP.SHARED,
  capabilities: {
    streaming: true,
    toolCalling: true,
    approval: false,
    sessionRestore: true,
    multiTurn: true,
    attachments: false,
  },
  connect: async () => {},
  disconnect: async () => {},
  createSession: async (config) => {
    capturedConfigs.push(config);
    return config.sessionKey;
  },
  endSession: async () => {},
  send: async () => {},
  onDelta: () => () => {},
  onComplete: () => () => {},
  onError: () => () => {},
};

vi.mock('../../src/agent/provider-registry.js', () => ({
  ensureProviderConnected: async () => fakeProvider,
  getProvider: () => fakeProvider,
}));

vi.mock('../../src/agent/runtime-context-bootstrap.js', () => ({
  resolveTransportContextBootstrap: async () => ({ namespace: undefined, diagnostics: [] }),
  buildTransportStartupMemory: async () => undefined,
}));

vi.mock('../../src/daemon/session-resource-service.js', () => ({
  registerTmuxSessionResource: async () => undefined,
  releaseSessionChildResources: async () => ({ released: 0, failed: 0 }),
  releaseSessionResources: async () => ({ released: 0, failed: 0 }),
  initializeSessionResourceLifecycle: async () => ({ released: 0, preserved: 0, failed: 0 }),
  resourceOwnerEnv: () => ({}),
}));

describe('Codex transport launch/restore HTTP MCP credential binding', () => {
  let home: string;
  let hookServer: http.Server | null = null;
  let hookPort = 0;

  beforeEach(async () => {
    capturedConfigs.length = 0;
    home = mkdtempSync(path.join(tmpdir(), 'codex-cred-launch-'));
    mkdirSync(path.join(home, '.imcodes'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('IMCODES_HOME', path.join(home, '.imcodes'));
    resetTransportQueueStoreForTests();
    store.resetSessionStoreAuthorityForTests();
    await store.loadStore({ probe: false });

    const started = await startHookServer(() => {}, {
      authorityHome: path.join(home, '.imcodes'),
      bindListener: (srv) => new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
          srv.removeListener('error', reject);
          resolve();
        });
      }),
      invokeMemoryMcpTool: async (caller) => ({ status: 'ok', session: caller.sessionName }),
    });
    hookServer = started.server;
    hookPort = started.port;
  });

  afterEach(async () => {
    await stopTransportRuntimeSession('deck_codexcred_brain').catch(() => {});
    if (hookServer) {
      await closeHookServer(hookServer).catch(() => {});
      hookServer = null;
    }
    vi.restoreAllMocks();
    await store.flushStore().catch(() => {});
    await store.waitForSessionStoreSnapshotForTests();
    resetTransportQueueStoreForTests();
    store.resetSessionStoreAuthorityForTests();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('mints, preserves across resume, rotates on fresh launch, and backfills missing credentials on restore', async () => {
    await launchTransportSession({
      name: 'deck_codexcred_brain',
      projectName: 'codexcred',
      role: 'brain',
      agentType: 'codex-sdk',
      projectDir: home,
      fresh: true,
    });

    const firstRecord = store.getSession('deck_codexcred_brain')!;
    expect(firstRecord.hookCredential).toBeTruthy();
    expect(firstRecord.sessionInstanceId).toBeTruthy();
    const firstConfig = capturedConfigs.at(-1)!;
    expect(firstConfig.env?.[HOOK_SESSION_CREDENTIAL_ENV]).toBe(firstRecord.hookCredential);

    // The exact thread config generated from this launch authenticates against /mcp.
    const firstThreadCfg = buildCodexMcpThreadConfig(firstConfig) as Record<string, any>;
    const firstEntry = firstThreadCfg.mcp_servers['imcodes-memory'];
    expect(firstEntry.url).toBe(`http://127.0.0.1:${hookPort}${MEMORY_MCP_HTTP_PATH}`);
    const client1 = new Client({ name: 'codex-launch-1', version: '1' });
    await client1.connect(new StreamableHTTPClientTransport(new URL(firstEntry.url), {
      requestInit: { headers: firstEntry.http_headers },
    }));
    await expect(client1.callTool({ name: 'search_memory', arguments: { query: 'hello' } }))
      .resolves.toMatchObject({ structuredContent: { status: 'ok', session: 'deck_codexcred_brain' } });
    await client1.close().catch(() => {});

    // Non-fresh relaunch preserves the session credential.
    await stopTransportRuntimeSession('deck_codexcred_brain');
    await launchTransportSession({
      name: 'deck_codexcred_brain',
      projectName: 'codexcred',
      role: 'brain',
      agentType: 'codex-sdk',
      projectDir: home,
      fresh: false,
    });
    expect(store.getSession('deck_codexcred_brain')?.hookCredential).toBe(firstRecord.hookCredential);

    // Fresh launch rotates the credential, invalidating the prior credential against /mcp.
    await stopTransportRuntimeSession('deck_codexcred_brain');
    await launchTransportSession({
      name: 'deck_codexcred_brain',
      projectName: 'codexcred',
      role: 'brain',
      agentType: 'codex-sdk',
      projectDir: home,
      fresh: true,
    });
    const rotatedRecord = store.getSession('deck_codexcred_brain')!;
    expect(rotatedRecord.hookCredential).toBeTruthy();
    expect(rotatedRecord.hookCredential).not.toBe(firstRecord.hookCredential);
    const staleClient = new Client({ name: 'codex-stale', version: '1' });
    await expect(staleClient.connect(new StreamableHTTPClientTransport(new URL(firstEntry.url), {
      requestInit: { headers: firstEntry.http_headers },
    }))).rejects.toThrow();

    // Restore of a pre-credential persisted session backfills hookCredential + injects it.
    await stopTransportRuntimeSession('deck_codexcred_brain');
    const legacyRecord = { ...store.getSession('deck_codexcred_brain')!, hookCredential: undefined, state: 'idle' as const };
    store.upsertSession(legacyRecord);
    await restoreTransportSessions('codex-sdk', { sessionName: 'deck_codexcred_brain', concurrency: 1, interSessionDelayMs: 0 });
    const restoredRecord = store.getSession('deck_codexcred_brain')!;
    expect(restoredRecord.hookCredential).toBeTruthy();
    const restoredConfig = capturedConfigs.at(-1)!;
    expect(restoredConfig.env?.[HOOK_SESSION_CREDENTIAL_ENV]).toBe(restoredRecord.hookCredential);
    const restoredEntry = (buildCodexMcpThreadConfig(restoredConfig) as Record<string, any>).mcp_servers['imcodes-memory'];
    const clientRestored = new Client({ name: 'codex-restored', version: '1' });
    await clientRestored.connect(new StreamableHTTPClientTransport(new URL(restoredEntry.url), {
      requestInit: { headers: restoredEntry.http_headers },
    }));
    await expect(clientRestored.callTool({ name: 'search_memory', arguments: { query: 'restored' } }))
      .resolves.toMatchObject({ structuredContent: { status: 'ok', session: 'deck_codexcred_brain' } });
    await clientRestored.close().catch(() => {});
  });
});
