import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapControlledNodeWithDisposition, defaultBootstrapDeps } from '../../src/node/bootstrap.js';
import { EnrollDirectUnsupportedError, defaultInstallIdentityPath, loadCredential, loadInstallIdentity } from '../../src/node/enrollment.js';
import { loadInstallJournal } from '../../src/node/install-journal.js';
import { executePendingDesktopSetup } from '../../src/node/setup-flow.js';
import type { LocalDaemonController } from '../../src/node/local-daemon-control.js';
import {
  REMOTE_DESKTOP_LOCAL_DAEMON_ACTION,
  REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART,
  REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE,
  REMOTE_DESKTOP_LOCAL_DAEMON_REASON,
} from '../../shared/remote-desktop-local-management.js';

describe('executePendingDesktopSetup chained bind + enroll', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'setup-flow-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makePaths() {
    return {
      credentialPath: join(dir, 'credential.json'),
      journalPath: join(dir, 'install-journal.json'),
      stagedExecutablePath: join(dir, 'imcodes-node'),
    };
  }

  it('reuses existing daemon on the same relay origin without overwriting its serverId, enrolls node, and allows bootstrap run_runtime', async () => {
    const paths = makePaths();
    const daemonActions: Array<{ action: string; payload?: unknown }> = [];
    const daemon: LocalDaemonController = {
      status: vi.fn(async () => ({
        available: true,
        installed: true,
        bound: true,
        running: false,
        connectionState: REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.DISCONNECTED,
        autostart: REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.DISABLED,
        serverId: 'srv-existing-daemon',
        serverOrigin: 'https://relay.example.com',
        canControl: true,
        canBind: true,
        canViewLogs: true,
      })),
      logs: vi.fn(async () => ({ text: '', truncated: false })),
      performAction: vi.fn(async (action, payload) => {
        daemonActions.push({ action, payload });
        return { ok: true, statusCode: 200 };
      }),
      readSetupBindingInfo: vi.fn(async () => ({
        bound: true,
        workerUrl: 'https://relay.example.com',
        serverId: 'srv-existing-daemon',
      })),
    };

    const requests: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const auth = new Headers(init?.headers).get('authorization');
      requests.push({ url, body, auth });
      const res = new Response(JSON.stringify({
        ok: true,
        serverId: 'srv-ctrl-1',
        nodeId: '1234567890',
        nodeRole: 'controlled',
        refName: 'ctrl-1',
        displayName: 'mac-mini',
        idempotent: false,
        hostServerId: 'srv-existing-daemon',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      Object.defineProperty(res, 'url', { value: url });
      return res;
    }) as unknown as typeof fetch;

    const steps: string[] = [];
    const cred = await executePendingDesktopSetup({
      relayOrigin: 'https://relay.example.com',
      apiKey: 'deck_test_key_1234',
      daemonController: daemon,
      deps: {
        ...paths,
        platform: 'darwin',
        arch: 'arm64',
        hostname: 'mac-mini.local',
        fetchFn,
      },
      onStep: (step) => steps.push(step),
    });

    expect(steps).toEqual(['binding_daemon', 'enrolling_node']);
    // Reused daemon: START sent, BIND not sent
    expect(daemonActions).toEqual([{ action: REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START, payload: undefined }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://relay.example.com/api/enroll/v2/direct');
    expect(requests[0]!.auth).toBe('Bearer deck_test_key_1234');
    expect(requests[0]!.body.hostServerId).toBe('srv-existing-daemon');

    expect(cred).toMatchObject({
      serverId: 'srv-ctrl-1',
      nodeId: '1234567890',
      serverUrl: 'https://relay.example.com',
      nodeRole: 'controlled',
      displayName: 'mac-mini',
    });

    // Durable artifacts written sequentially and bootstrapControlledNodeWithDisposition transitions cleanly
    const identity = await loadInstallIdentity(defaultInstallIdentityPath(paths.credentialPath));
    expect(identity?.installId).toBeTruthy();
    expect(identity?.nodeToken).toBe(cred.token);
    const journal = await loadInstallJournal(paths.journalPath);
    expect(journal.phase).toBe('enrolled');
    expect(journal.serverId).toBe('srv-ctrl-1');

    const baseDeps = defaultBootstrapDeps(Date.now());
    const serviceReceipt = {
      name: 'imcodes-node',
      platform: 'linux' as const,
      action: paths.stagedExecutablePath,
    };
    const bootRes = await bootstrapControlledNodeWithDisposition({
      ...baseDeps,
      loadCredential: () => loadCredential(paths.credentialPath),
      loadInstallIdentity: () => loadInstallIdentity(defaultInstallIdentityPath(paths.credentialPath)),
      credentialPath: paths.credentialPath,
      journalPath: paths.journalPath,
      stagedExecutablePath: paths.stagedExecutablePath,
      sourceExecutablePath: paths.stagedExecutablePath,
      isStableRuntime: async () => true,
      assertElevated: async () => {},
      prepareCredentialDir: async () => {},
      ensureReleasePublisherTrust: async () => {},
      installDefinition: async () => serviceReceipt,
      inspectDefinition: async (receipt) => receipt,
      inspectServiceState: async () => ({
        installed: true,
        action: paths.stagedExecutablePath,
        effectiveAction: paths.stagedExecutablePath,
        loadedActionMatches: true,
        loaded: true,
        bootEnabled: true,
        principal: 'root',
        restartPolicy: 'on-failure',
        observedDefinitionSha256: null,
        definitionMatches: true,
        runState: 'running',
        errors: [],
        raw: 'running',
      }),
      startService: async () => {},
      verifyStagedExecutable: async () => {},
      openVerifiedEnrollmentSource: async () => ({
        sourcePath: paths.stagedExecutablePath,
        identity: { size: 0, mtimeMs: 0, ctimeMs: 0 },
        statSize: async () => 0,
        readExactly: async () => Buffer.alloc(0),
        readEnrollmentBlobWithRange: async () => null,
        stageTrailerFreeExecutable: async () => { throw new Error('unexpected_stage'); },
        cleanupEnrollmentSource: async () => 'skipped',
        close: async () => {},
      }),
      recoverInterruptedUpgrade: undefined,
    });
    expect(bootRes.disposition).toBe('run_runtime');
    expect(bootRes.credential?.serverId).toBe('srv-ctrl-1');
  });

  it('binds a fresh daemon with relay/bind/apiKey, reads its new serverId, and links hostServerId', async () => {
    const paths = makePaths();
    let currentServerId: string | undefined;
    const daemon: LocalDaemonController = {
      status: vi.fn(async () => ({
        available: true,
        installed: true,
        bound: Boolean(currentServerId),
        running: Boolean(currentServerId),
        connectionState: REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.CONNECTED,
        autostart: REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED,
        ...(currentServerId ? { serverId: currentServerId } : {}),
        canControl: true,
        canBind: true,
        canViewLogs: true,
      })),
      logs: vi.fn(async () => ({ text: '', truncated: false })),
      performAction: vi.fn(async (action, payload) => {
        if (action === REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND && payload?.bindUrl === 'https://app.im.codes/bind/deck_abc') {
          currentServerId = 'srv-fresh-daemon';
        }
        return { ok: true, statusCode: 200 };
      }),
      readSetupBindingInfo: vi.fn(async () => ({
        bound: Boolean(currentServerId),
        workerUrl: currentServerId ? 'https://app.im.codes' : null,
        serverId: currentServerId ?? null,
      })),
    };

    let receivedHostServerId: unknown;
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      receivedHostServerId = body.hostServerId;
      const res = new Response(JSON.stringify({
        ok: true,
        serverId: 'srv-ctrl-2',
        nodeId: '9876543210',
        nodeRole: 'controlled',
        idempotent: false,
        hostServerId: 'srv-fresh-daemon',
      }), { status: 200 });
      Object.defineProperty(res, 'url', { value: url });
      return res;
    }) as unknown as typeof fetch;

    const cred = await executePendingDesktopSetup({
      relayOrigin: 'https://app.im.codes',
      apiKey: 'deck_abc',
      daemonController: daemon,
      deps: { ...paths, platform: 'linux', arch: 'x64', hostname: 'workstation', fetchFn },
    });
    expect(receivedHostServerId).toBe('srv-fresh-daemon');
    expect(cred.nodeId).toBe('9876543210');
  });

  it('proceeds without hostServerId when daemon is NOT_INSTALLED, and does not persist credential on 404 unsupported server', async () => {
    const paths = makePaths();
    const daemon: LocalDaemonController = {
      status: vi.fn(async () => ({
        available: true,
        installed: false,
        bound: false,
        running: false,
        connectionState: REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.UNKNOWN,
        autostart: REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.DISABLED,
        reason: REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NOT_INSTALLED,
        canControl: false,
        canBind: false,
        canViewLogs: false,
      })),
      logs: vi.fn(async () => ({ text: '', truncated: false })),
      performAction: vi.fn(async () => ({ ok: false, statusCode: 400, error: REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NOT_INSTALLED })),
      readSetupBindingInfo: vi.fn(async () => ({ bound: false, workerUrl: null, serverId: null })),
    };

    const fetch404 = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const res = new Response('Not Found', { status: 404 });
      Object.defineProperty(res, 'url', { value: url });
      return res;
    }) as unknown as typeof fetch;

    await expect(executePendingDesktopSetup({
      relayOrigin: 'https://legacy.example.com',
      apiKey: 'deck_old',
      daemonController: daemon,
      deps: { ...paths, platform: 'linux', arch: 'x64', hostname: 'box', fetchFn: fetch404 },
    })).rejects.toThrow(EnrollDirectUnsupportedError);

    // Must not have written credential.json or advanced journal to enrolled
    await expect(readFile(paths.credentialPath, 'utf8')).rejects.toThrow();
    const journal = await loadInstallJournal(paths.journalPath);
    expect(journal.phase).toBe('credential_prepared');
  });
});
