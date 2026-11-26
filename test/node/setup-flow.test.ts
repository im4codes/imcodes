import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrapControlledNodeWithDisposition,
  defaultBootstrapDeps,
  isCurrentExecutableStable,
} from '../../src/node/bootstrap.js';
import {
  EnrollDirectUnsupportedError,
  defaultInstallIdentityPath,
  defaultPendingDaemonBindPath,
  loadCredential,
  loadInstallIdentity,
  loadPendingDaemonBind,
  persistCredential,
} from '../../src/node/enrollment.js';
import { loadInstallJournal, writeInstallPhase } from '../../src/node/install-journal.js';
import { createLocalDaemonController, type LocalDaemonController } from '../../src/node/local-daemon-control.js';
import { executePendingDesktopSetup } from '../../src/node/setup-flow.js';
import {
  REMOTE_DESKTOP_LOCAL_DAEMON_ACTION,
  REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART,
  REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE,
  REMOTE_DESKTOP_LOCAL_DAEMON_REASON,
} from '../../shared/remote-desktop-local-management.js';

async function createFakeBundleAsync(root: string, version: string, platform: NodeJS.Platform): Promise<string> {
  const bundleDir = join(root, 'daemon-runtime');
  const distDir = join(bundleDir, 'package', 'dist', 'src');
  const exeDir = platform === 'win32' ? bundleDir : join(bundleDir, 'bin');
  await mkdir(distDir, { recursive: true });
  await mkdir(exeDir, { recursive: true });
  await writeFile(join(bundleDir, 'package', 'package.json'), JSON.stringify({ name: 'imcodes', version }), 'utf8');
  await writeFile(join(distDir, 'index.js'), 'console.log("daemon");\n', 'utf8');
  const exe = join(exeDir, platform === 'win32' ? 'node.exe' : 'node');
  await writeFile(exe, '#!/bin/sh\necho fake\n', 'utf8');
  if (platform !== 'win32') await chmod(exe, 0o755);
  return bundleDir;
}

describe('executePendingDesktopSetup chained bind + enroll', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'setup-flow-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makePaths(withStagedBinary = true) {
    const paths = {
      credentialPath: join(dir, 'credential.json'),
      journalPath: join(dir, 'install-journal.json'),
      stagedExecutablePath: join(dir, 'imcodes-node'),
      sourceExecutablePath: join(dir, 'imcodes-node'),
    };
    if (withStagedBinary) {
      await writeFile(paths.stagedExecutablePath, '#!/bin/sh\necho imcodes-node\n', { mode: 0o755 });
    }
    return paths;
  }

  it('reuses existing daemon on the same relay origin, records a real stagedReceipt, and runs across real isCurrentExecutableStable restarts without startService', async () => {
    const paths = await makePaths(true);
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
      }), { status: 201, headers: { 'content-type': 'application/json' } });
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

    const identity = await loadInstallIdentity(defaultInstallIdentityPath(paths.credentialPath));
    expect(identity?.installId).toBeTruthy();
    expect(identity?.nodeToken).toBe(cred.token);
    const journal = await loadInstallJournal(paths.journalPath);
    expect(journal.phase).toBe('enrolled');
    expect(journal.serverId).toBe('srv-ctrl-1');
    expect(journal.stagedReceipt?.path).toBe(paths.stagedExecutablePath);
    expect(journal.stagedReceipt?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(journal.stagedReceipt?.size).toBeGreaterThan(0);

    // Causal F3 test using REAL isCurrentExecutableStable across Restart 1 + Restart 2
    const events: string[] = [];
    const baseDeps = defaultBootstrapDeps(Date.now());
    const serviceReceipt = {
      name: 'imcodes-node',
      platform: 'linux' as const,
      action: paths.stagedExecutablePath,
    };
    const makeBootDeps = () => ({
      ...baseDeps,
      loadCredential: () => loadCredential(paths.credentialPath),
      loadInstallIdentity: () => loadInstallIdentity(defaultInstallIdentityPath(paths.credentialPath)),
      credentialPath: paths.credentialPath,
      journalPath: paths.journalPath,
      stagedExecutablePath: paths.stagedExecutablePath,
      sourceExecutablePath: paths.stagedExecutablePath,
      isStableRuntime: (j: typeof journal) => isCurrentExecutableStable(j, paths.stagedExecutablePath),
      assertElevated: async () => {},
      prepareCredentialDir: async () => {},
      ensureReleasePublisherTrust: async () => {},
      installDefinition: async () => { events.push('installDefinition'); return serviceReceipt; },
      inspectDefinition: async (receipt: typeof serviceReceipt) => receipt,
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
        runState: 'running' as const,
        errors: [],
        raw: 'running',
      }),
      startService: async () => { events.push('startService'); },
      recoverInterruptedUpgrade: undefined,
    });

    const boot1 = await bootstrapControlledNodeWithDisposition(makeBootDeps());
    expect(boot1.disposition).toBe('run_runtime');
    expect(boot1.credential?.serverId).toBe('srv-ctrl-1');
    expect(boot1.journal.phase).toBe('service_start_requested');

    const boot2 = await bootstrapControlledNodeWithDisposition(makeBootDeps());
    expect(boot2.disposition).toBe('run_runtime');
    expect(boot2.credential?.serverId).toBe('srv-ctrl-1');
    expect(events).not.toContain('startService');
  });

  it('fails closed in bootstrap when stagedReceipt is missing at files_staged+ (F3 repair boundary)', async () => {
    const paths = await makePaths(true);
    let journal = await loadInstallJournal(paths.journalPath);
    journal = await writeInstallPhase(paths.journalPath, 'elevated', { now: 1000, previous: journal });
    journal = await writeInstallPhase(paths.journalPath, 'credential_prepared', {
      now: 1001,
      previous: journal,
      installId: 'inst-1',
      nodeTokenHash: 'a'.repeat(64),
      sourceExePath: paths.stagedExecutablePath,
    });
    journal = await writeInstallPhase(paths.journalPath, 'files_staged', {
      now: 1002,
      previous: journal,
      stagedExePath: paths.stagedExecutablePath,
      // Intentionally omit stagedReceipt
    });
    journal = await writeInstallPhase(paths.journalPath, 'enrolled', {
      now: 1003,
      previous: journal,
      serverId: 'srv-ctrl-1',
    });

    const baseDeps = defaultBootstrapDeps(Date.now());
    await expect(bootstrapControlledNodeWithDisposition({
      ...baseDeps,
      loadCredential: async () => ({
        serverId: 'srv-ctrl-1',
        nodeId: '1234567890',
        token: 'tok-1',
        serverUrl: 'https://relay.example.com',
        nodeRole: 'controlled',
      }),
      loadInstallIdentity: async () => ({
        installId: 'inst-1',
        nodeToken: 'tok-1',
        nodeTokenHash: 'a'.repeat(64),
        sourceExePath: paths.stagedExecutablePath,
      }),
      credentialPath: paths.credentialPath,
      journalPath: paths.journalPath,
      stagedExecutablePath: paths.stagedExecutablePath,
      sourceExecutablePath: paths.stagedExecutablePath,
      isStableRuntime: async () => true,
      assertElevated: async () => {},
      prepareCredentialDir: async () => {},
      ensureReleasePublisherTrust: async () => {},
      recoverInterruptedUpgrade: undefined,
    })).rejects.toThrow(/staged executable receipt is missing/i);
  });

  it('stages a missing stagedExecutablePath from sourceExecutablePath on fresh install and records its receipt', async () => {
    const sourceExe = join(dir, 'downloaded-imcodes-node');
    const stagedExe = join(dir, 'staged', 'imcodes-node');
    await writeFile(sourceExe, '#!/bin/sh\necho fresh-download\n', { mode: 0o755 });
    const credentialPath = join(dir, 'credential.json');
    const journalPath = join(dir, 'install-journal.json');

    const daemon: LocalDaemonController = {
      status: vi.fn(async () => ({
        available: true,
        installed: true,
        bound: true,
        running: true,
        connectionState: REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.CONNECTED,
        autostart: REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED,
        serverId: 'srv-fresh-daemon',
        canControl: true,
        canBind: true,
        canViewLogs: true,
      })),
      logs: vi.fn(async () => ({ text: '', truncated: false })),
      prepareBind: vi.fn(async () => ({
        ok: true as const,
        statusCode: 200,
        prepared: { workerUrl: 'https://app.im.codes', serverId: 'srv-fresh-daemon', token: 'd-tok', serverName: 'ws' },
      })),
      commitBind: vi.fn(async () => ({ ok: true, statusCode: 200 })),
      performAction: vi.fn(async () => ({ ok: true, statusCode: 200 })),
      readSetupBindingInfo: vi.fn(async () => ({ bound: false, workerUrl: null, serverId: null })),
    };

    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const res = new Response(JSON.stringify({
        ok: true,
        serverId: 'srv-ctrl-stage',
        nodeId: '2468013579',
        nodeRole: 'controlled',
        idempotent: false,
        hostServerId: 'srv-fresh-daemon',
      }), { status: 201 });
      Object.defineProperty(res, 'url', { value: url });
      return res;
    }) as unknown as typeof fetch;

    await executePendingDesktopSetup({
      relayOrigin: 'https://app.im.codes',
      apiKey: 'deck_abc',
      daemonController: daemon,
      deps: {
        credentialPath,
        journalPath,
        stagedExecutablePath: stagedExe,
        sourceExecutablePath: sourceExe,
        platform: 'linux',
        arch: 'x64',
        hostname: 'workstation',
        fetchFn,
      },
    });

    const journal = await loadInstallJournal(journalPath);
    expect(journal.stagedReceipt?.path).toBe(stagedExe);
    expect(await isCurrentExecutableStable(journal, stagedExe)).toBe(true);
    expect(await readFile(stagedExe, 'utf8')).toBe('#!/bin/sh\necho fresh-download\n');
  });

  it('aborts cleanly before enrollDirectV2 when Coding Daemon fails (NOT_INSTALLED, NO_ACTIVE_USER, START failed, or missing serverId) (F4)', async () => {
    const cases: Array<{ name: string; controller: () => Pick<LocalDaemonController, 'performAction' | 'readSetupBindingInfo' | 'prepareBind' | 'commitBind'> }> = [
      {
        name: 'NOT_INSTALLED on bind',
        controller: () => ({
          readSetupBindingInfo: async () => ({ bound: false, workerUrl: null, serverId: null }),
          performAction: async () => ({ ok: false, statusCode: 409, error: REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NOT_INSTALLED }),
        }),
      },
      {
        name: 'NO_ACTIVE_USER on prepareBind',
        controller: () => ({
          readSetupBindingInfo: async () => ({ bound: false, workerUrl: null, serverId: null }),
          prepareBind: async () => ({ ok: false, statusCode: 409, error: REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NO_ACTIVE_USER }),
          commitBind: async () => ({ ok: true, statusCode: 200 }),
          performAction: async () => ({ ok: false, statusCode: 409, error: REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NO_ACTIVE_USER }),
        }),
      },
      {
        name: 'reused daemon START returns ok:false',
        controller: () => ({
          readSetupBindingInfo: async () => ({ bound: true, workerUrl: 'https://relay.example.com', serverId: 'srv-1' }),
          performAction: async () => ({ ok: false, statusCode: 500, error: 'start_failed' }),
        }),
      },
      {
        name: 'reused daemon START throws',
        controller: () => ({
          readSetupBindingInfo: async () => ({ bound: true, workerUrl: 'https://relay.example.com', serverId: 'srv-1' }),
          performAction: async () => { throw new Error('start_boom'); },
        }),
      },
      {
        name: 'BIND succeeds without serverId',
        controller: () => ({
          readSetupBindingInfo: async () => ({ bound: false, workerUrl: null, serverId: null }),
          performAction: async () => ({ ok: true, statusCode: 200 }),
        }),
      },
    ];

    for (const tc of cases) {
      const caseDir = await mkdtemp(join(tmpdir(), 'setup-f4-'));
      try {
        const credentialPath = join(caseDir, 'credential.json');
        const journalPath = join(caseDir, 'install-journal.json');
        const stagedExecutablePath = join(caseDir, 'imcodes-node');
        await writeFile(stagedExecutablePath, '#!/bin/sh\necho ok\n', { mode: 0o755 });
        const fetchFn = vi.fn() as unknown as typeof fetch;

        await expect(executePendingDesktopSetup({
          relayOrigin: 'https://relay.example.com',
          apiKey: 'deck_test',
          daemonController: tc.controller(),
          deps: {
            credentialPath,
            journalPath,
            stagedExecutablePath,
            sourceExecutablePath: stagedExecutablePath,
            platform: 'linux',
            arch: 'x64',
            hostname: 'box',
            fetchFn,
          },
        }), tc.name).rejects.toThrow();

        expect(fetchFn, tc.name).not.toHaveBeenCalled();
        await expect(readFile(credentialPath, 'utf8'), tc.name).rejects.toThrow();
        const journal = await loadInstallJournal(journalPath);
        expect(journal.phase, tc.name).toBe('uninstalled');
      } finally {
        await rm(caseDir, { recursive: true, force: true });
      }
    }
  });

  it('preserves Relay A server.json exact bytes, 0600 mode, and running daemon A when Relay B fails /api/enroll/v2/direct or daemon commit fails (F5)', async () => {
    const home = join(dir, 'Users', 'alice');
    const stateDir = join(home, '.imcodes');
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const relayAServerJson = JSON.stringify({
      serverId: 'srv-relay-a',
      token: 'tok-relay-a-secret',
      workerUrl: 'https://relay-a.example.com',
      serverName: 'alice-box',
      customFormatting: 'preserved-byte-for-byte',
    }, null, 2);
    const serverJsonPath = join(stateDir, 'server.json');
    await writeFile(serverJsonPath, relayAServerJson, { mode: 0o600 });
    await writeFile(join(stateDir, 'daemon.pid'), '44444\n');
    const procRoot = join(dir, 'proc');
    await mkdir(join(procRoot, '44444'), { recursive: true });
    await writeFile(
      join(procRoot, '44444', 'cmdline'),
      '/opt/imcodes/daemon-runtime/bin/node\0/opt/imcodes/package/dist/src/index.js\0start\0--foreground\0',
    );
    const bundleDir = await createFakeBundleAsync(dir, '1.0.0', 'linux');

    const daemonSpawns: string[][] = [];
    const daemonKills: number[] = [];
    let daemonARunning = true;
    const daemonFetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://relay-b.example.com/api/bind/direct') {
        return new Response(JSON.stringify({ serverId: 'srv-relay-b', token: 'tok-relay-b' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected daemon fetch: ${url}`);
    }) as unknown as typeof fetch;

    const realDaemon = createLocalDaemonController({
      platform: 'linux',
      env: {},
      procRoot,
      bundleDirs: [bundleDir],
      cliCandidates: [],
      currentUid: () => process.getuid!(),
      currentGid: () => process.getgid!(),
      activeUser: { platform: 'linux', username: 'alice', home, uid: process.getuid!(), gid: process.getgid!() },
      isPidAlive: () => daemonARunning,
      execText: async (file, args) => {
        if (file === 'ps') {
          return {
            stdout: daemonARunning
              ? '44444 /opt/imcodes/daemon-runtime/bin/node /opt/imcodes/package/dist/src/index.js start --foreground\n'
              : '',
            stderr: '',
          };
        }
        if (file === 'systemctl' && args[1] === 'show-environment') throw new Error('no systemd');
        return { stdout: '', stderr: '' };
      },
      killProcess: (pid) => {
        daemonKills.push(pid);
        daemonARunning = false;
      },
      spawnDetached: (file, args) => { daemonSpawns.push([file, ...args]); },
      fetchImpl: daemonFetch,
      stopWaitMs: 10,
      sleep: async () => {},
    });

    const paths = await makePaths(true);
    const enroll404Fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const res = new Response('Not Found', { status: 404 });
      Object.defineProperty(res, 'url', { value: url });
      return res;
    }) as unknown as typeof fetch;

    await expect(executePendingDesktopSetup({
      relayOrigin: 'https://relay-b.example.com',
      apiKey: 'deck_legacy_b',
      daemonController: realDaemon,
      deps: {
        ...paths,
        platform: 'linux',
        arch: 'x64',
        hostname: 'alice-box',
        fetchFn: enroll404Fetch,
      },
    })).rejects.toThrow(EnrollDirectUnsupportedError);

    // Relay A binding, exact file bytes, 0600 mode, and running daemon A were NEVER touched
    expect(await readFile(serverJsonPath, 'utf8')).toBe(relayAServerJson);
    expect((await stat(serverJsonPath)).mode & 0o777).toBe(0o600);
    expect(await realDaemon.readSetupBindingInfo?.()).toMatchObject({
      bound: true,
      workerUrl: 'https://relay-a.example.com',
      serverId: 'srv-relay-a',
      daemonInstalled: true,
    });
    expect(daemonKills).toEqual([]);
    expect(daemonSpawns).toEqual([]);
    expect(daemonARunning).toBe(true);
    await expect(readFile(paths.credentialPath, 'utf8')).rejects.toThrow();

    // Also test rollback when /v2/direct SUCCEEDS but daemon commitBind fails during startUserDaemon:
    // server.json + 0600 mode must roll back to Relay A and credential.json must NOT be written
    const enrollOkFetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const res = new Response(JSON.stringify({
        ok: true,
        serverId: 'srv-ctrl-b',
        nodeId: '9988776655',
        nodeRole: 'controlled',
        idempotent: false,
        hostServerId: 'srv-relay-b',
      }), { status: 201, headers: { 'content-type': 'application/json' } });
      Object.defineProperty(res, 'url', { value: url });
      return res;
    }) as unknown as typeof fetch;

    const failingCommitDaemon = createLocalDaemonController({
      platform: 'linux',
      env: {},
      procRoot,
      bundleDirs: [bundleDir],
      cliCandidates: [],
      currentUid: () => process.getuid!(),
      currentGid: () => process.getgid!(),
      activeUser: { platform: 'linux', username: 'alice', home, uid: process.getuid!(), gid: process.getgid!() },
      isPidAlive: () => daemonARunning,
      execText: async (file, args) => {
        if (file === 'ps') {
          return {
            stdout: daemonARunning
              ? '44444 /opt/imcodes/daemon-runtime/bin/node /opt/imcodes/package/dist/src/index.js start --foreground\n'
              : '',
            stderr: '',
          };
        }
        if (file === 'systemctl' && args[1] === 'show-environment') throw new Error('no systemd');
        return { stdout: '', stderr: '' };
      },
      killProcess: (pid) => {
        daemonKills.push(pid);
        daemonARunning = false;
      },
      spawnDetached: () => {
        // First spawn (Relay B start) fails; rollback spawn restores daemon A
        if (!daemonARunning && daemonSpawns.length === 0) {
          daemonSpawns.push(['fail-first']);
          throw new Error('spawn_b_failed');
        }
        daemonARunning = true;
        daemonSpawns.push(['restored-a']);
      },
      fetchImpl: daemonFetch,
      stopWaitMs: 10,
      sleep: async () => {},
    });

    await expect(executePendingDesktopSetup({
      relayOrigin: 'https://relay-b.example.com',
      apiKey: 'deck_b_commit_fail',
      daemonController: failingCommitDaemon,
      deps: {
        ...paths,
        platform: 'linux',
        arch: 'x64',
        hostname: 'alice-box',
        fetchFn: enrollOkFetch,
      },
    })).rejects.toThrow(/start_failed|daemon_bind_failed/);

    expect(await readFile(serverJsonPath, 'utf8')).toBe(relayAServerJson);
    expect((await stat(serverJsonPath)).mode & 0o777).toBe(0o600);
    expect(daemonARunning).toBe(true);
    await expect(readFile(paths.credentialPath, 'utf8')).rejects.toThrow();
  });

  it('F3-R2: persists files_staged + stagedReceipt before saving credential, so crash after credential fsync rolls forward cleanly in bootstrap', async () => {
    const paths = await makePaths(true);
    const daemon: LocalDaemonController = {
      status: vi.fn(async () => ({
        available: true,
        installed: true,
        bound: true,
        running: true,
        connectionState: REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.CONNECTED,
        autostart: REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED,
        serverId: 'srv-daemon-f3',
        canControl: true,
        canBind: true,
        canViewLogs: true,
      })),
      logs: vi.fn(async () => ({ text: '', truncated: false })),
      performAction: vi.fn(async () => ({ ok: true, statusCode: 200 })),
      readSetupBindingInfo: vi.fn(async () => ({
        bound: true,
        workerUrl: 'https://relay.example.com',
        serverId: 'srv-daemon-f3',
      })),
    };
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const res = new Response(JSON.stringify({
        ok: true,
        serverId: 'srv-ctrl-f3',
        nodeId: '1234567899',
        nodeRole: 'controlled',
        idempotent: false,
        hostServerId: 'srv-daemon-f3',
      }), { status: 201, headers: { 'content-type': 'application/json' } });
      Object.defineProperty(res, 'url', { value: url });
      return res;
    }) as unknown as typeof fetch;

    // Simulate process exit / write failure immediately after credential.json fsync completes (before enrolled write)
    await expect(executePendingDesktopSetup({
      relayOrigin: 'https://relay.example.com',
      apiKey: 'deck_f3_crash',
      daemonController: daemon,
      deps: {
        ...paths,
        platform: 'linux',
        arch: 'x64',
        hostname: 'f3-box',
        fetchFn,
        persistCredentialFn: async (cred, path) => {
          await persistCredential(cred, path);
          throw new Error('simulated_crash_after_credential_fsync');
        },
      },
    })).rejects.toThrow('simulated_crash_after_credential_fsync');

    // credential.json exists on disk AND journal is already at files_staged WITH stagedReceipt
    const savedCred = await loadCredential(paths.credentialPath);
    expect(savedCred?.serverId).toBe('srv-ctrl-f3');
    const preCrashJournal = await loadInstallJournal(paths.journalPath);
    expect(preCrashJournal.phase).toBe('files_staged');
    expect(preCrashJournal.stagedReceipt).toBeDefined();

    // Next bootstrap must roll forward files_staged -> enrolled -> service_start_requested without manual recovery error
    const baseDeps = defaultBootstrapDeps(Date.now());
    const serviceReceipt = { name: 'imcodes-node.service', platform: 'linux' as const, action: paths.stagedExecutablePath };
    const makeRollForwardDeps = () => ({
      ...baseDeps,
      loadCredential: () => loadCredential(paths.credentialPath),
      loadInstallIdentity: () => loadInstallIdentity(defaultInstallIdentityPath(paths.credentialPath)),
      credentialPath: paths.credentialPath,
      journalPath: paths.journalPath,
      stagedExecutablePath: paths.stagedExecutablePath,
      sourceExecutablePath: paths.stagedExecutablePath,
      isStableRuntime: (j: typeof preCrashJournal) => isCurrentExecutableStable(j, paths.stagedExecutablePath),
      assertElevated: async () => {},
      prepareCredentialDir: async () => {},
      ensureReleasePublisherTrust: async () => {},
      installDefinition: async () => serviceReceipt,
      inspectDefinition: async () => serviceReceipt,
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
        runState: 'running' as const,
        errors: [],
        raw: 'running',
      }),
      startService: async () => {},
      recoverInterruptedUpgrade: undefined,
    });
    const boot = await bootstrapControlledNodeWithDisposition(makeRollForwardDeps());
    expect(boot.disposition).toBe('run_runtime');
    expect(boot.journal.phase).toBe('service_start_requested');
    expect(boot.journal.serverId).toBe('srv-ctrl-f3');
  });

  it('F3-R2: failure during executable staging leaves credential absent and stays recoverable via pending_setup + retry', async () => {
    const credentialPath = join(dir, 'credential.json');
    const journalPath = join(dir, 'install-journal.json');
    const sourceExe = join(dir, 'source-node');
    const stagedExe = join(dir, 'staged', 'imcodes-node');

    const daemon: LocalDaemonController = {
      status: vi.fn(async () => ({
        available: true,
        installed: true,
        bound: true,
        running: true,
        connectionState: REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.CONNECTED,
        autostart: REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED,
        serverId: 'srv-daemon-stage',
        canControl: true,
        canBind: true,
        canViewLogs: true,
      })),
      logs: vi.fn(async () => ({ text: '', truncated: false })),
      performAction: vi.fn(async () => ({ ok: true, statusCode: 200 })),
      readSetupBindingInfo: vi.fn(async () => ({
        bound: true,
        workerUrl: 'https://relay.example.com',
        serverId: 'srv-daemon-stage',
      })),
    };
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const res = new Response(JSON.stringify({
        ok: true,
        serverId: 'srv-ctrl-stage',
        nodeId: '2234567890',
        nodeRole: 'controlled',
        idempotent: false,
        hostServerId: 'srv-daemon-stage',
      }), { status: 201, headers: { 'content-type': 'application/json' } });
      Object.defineProperty(res, 'url', { value: url });
      return res;
    }) as unknown as typeof fetch;

    // Source binary missing on first attempt -> staging fails BEFORE credential write
    await expect(executePendingDesktopSetup({
      relayOrigin: 'https://relay.example.com',
      apiKey: 'deck_stage_retry',
      daemonController: daemon,
      deps: {
        credentialPath,
        journalPath,
        stagedExecutablePath: stagedExe,
        sourceExecutablePath: sourceExe,
        platform: 'linux',
        arch: 'x64',
        hostname: 'stage-box',
        fetchFn,
      },
    })).rejects.toThrow();

    expect(await loadCredential(credentialPath)).toBeNull();
    expect((await loadInstallJournal(journalPath)).phase).toBe('credential_prepared');
    expect(fetchFn).not.toHaveBeenCalled();

    // Restart still enters pending_setup cleanly, then retry with valid source succeeds
    await writeFile(sourceExe, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    const baseDeps = defaultBootstrapDeps(Date.now());
    const bootPending = await bootstrapControlledNodeWithDisposition({
      ...baseDeps,
      loadCredential: () => loadCredential(credentialPath),
      loadInstallIdentity: () => loadInstallIdentity(defaultInstallIdentityPath(credentialPath)),
      credentialPath,
      journalPath,
      stagedExecutablePath: stagedExe,
      sourceExecutablePath: sourceExe,
      isStableRuntime: async () => false,
      assertElevated: async () => {},
      prepareCredentialDir: async () => {},
      ensureReleasePublisherTrust: async () => {},
      recoverInterruptedUpgrade: undefined,
    });
    expect(bootPending.disposition).toBe('pending_setup');

    const cred = await executePendingDesktopSetup({
      relayOrigin: 'https://relay.example.com',
      apiKey: 'deck_stage_retry',
      daemonController: daemon,
      deps: {
        credentialPath,
        journalPath,
        stagedExecutablePath: stagedExe,
        sourceExecutablePath: sourceExe,
        platform: 'linux',
        arch: 'x64',
        hostname: 'stage-box',
        fetchFn,
      },
    });
    expect(cred.serverId).toBe('srv-ctrl-stage');
    expect((await loadInstallJournal(journalPath)).phase).toBe('enrolled');
    expect((await loadInstallJournal(journalPath)).stagedReceipt).toBeDefined();
  });

  it('F5-R2: persists pending bind at 0600 before enroll, reuses B1 across lost enroll response and commitBind rollback even when /api/bind/direct generates new IDs, and cleans up on completion', async () => {
    const home = join(dir, 'home-r2');
    const stateDir = join(home, '.imcodes');
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const relayAServerJson = JSON.stringify({
      serverId: 'srv-relay-a',
      token: 'tok-relay-a',
      workerUrl: 'https://relay-a.example.com',
      serverName: 'alice-box',
    }, null, 2);
    const serverJsonPath = join(stateDir, 'server.json');
    await writeFile(serverJsonPath, relayAServerJson, { mode: 0o600 });
    await writeFile(join(stateDir, 'daemon.pid'), '55555\n');
    const procRoot = join(dir, 'proc-r2');
    await mkdir(join(procRoot, '55555'), { recursive: true });
    await writeFile(
      join(procRoot, '55555', 'cmdline'),
      '/opt/imcodes/daemon-runtime/bin/node\0/opt/imcodes/package/dist/src/index.js\0start\0--foreground\0',
    );
    const bundleDir = await createFakeBundleAsync(dir, '1.0.0', 'linux');
    const paths = await makePaths(true);
    const pendingBindPath = defaultPendingDaemonBindPath(paths.credentialPath);

    let daemonARunning = true;
    let bindDirectCalls = 0;
    const daemonFetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://relay-b.example.com/api/bind/direct') {
        bindDirectCalls += 1;
        return new Response(JSON.stringify({
          serverId: `srv-relay-b-${bindDirectCalls}`,
          token: `tok-relay-b-${bindDirectCalls}`,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected daemon fetch: ${url}`);
    }) as unknown as typeof fetch;

    const enrolledNodes = new Map<string, { serverId: string; hostServerId: string }>();
    let dropFirstEnrollResponse = true;
    const enrollFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const body = JSON.parse(String(init?.body ?? '{}')) as { nodeTokenHash: string; hostServerId: string };
      const existing = enrolledNodes.get(body.nodeTokenHash);
      if (existing) {
        if (existing.hostServerId !== body.hostServerId) {
          const conflictRes = new Response(JSON.stringify({ error: 'host_server_conflict' }), { status: 409 });
          Object.defineProperty(conflictRes, 'url', { value: url });
          return conflictRes;
        }
        const replayRes = new Response(JSON.stringify({
          ok: true,
          serverId: existing.serverId,
          nodeId: '7777777777',
          nodeRole: 'controlled',
          idempotent: true,
          hostServerId: existing.hostServerId,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
        Object.defineProperty(replayRes, 'url', { value: url });
        return replayRes;
      }
      enrolledNodes.set(body.nodeTokenHash, { serverId: 'srv-ctrl-r2', hostServerId: body.hostServerId });
      if (dropFirstEnrollResponse) {
        dropFirstEnrollResponse = false;
        throw new TypeError('network response lost after server committed');
      }
      const createdRes = new Response(JSON.stringify({
        ok: true,
        serverId: 'srv-ctrl-r2',
        nodeId: '7777777777',
        nodeRole: 'controlled',
        idempotent: false,
        hostServerId: body.hostServerId,
      }), { status: 201, headers: { 'content-type': 'application/json' } });
      Object.defineProperty(createdRes, 'url', { value: url });
      return createdRes;
    }) as unknown as typeof fetch;

    const makeController = (failFirstSpawn: boolean) => {
      let spawns = 0;
      return createLocalDaemonController({
        platform: 'linux',
        env: {},
        procRoot,
        bundleDirs: [bundleDir],
        cliCandidates: [],
        currentUid: () => process.getuid!(),
        currentGid: () => process.getgid!(),
        activeUser: { platform: 'linux', username: 'alice', home, uid: process.getuid!(), gid: process.getgid!() },
        isPidAlive: () => daemonARunning,
        execText: async (file, args) => {
          if (file === 'systemctl' && args[1] === 'show-environment') throw new Error('no systemd');
          return { stdout: '', stderr: '' };
        },
        killProcess: () => { daemonARunning = false; },
        spawnDetached: () => {
          spawns += 1;
          if (failFirstSpawn && spawns === 1) throw new Error('spawn_b_failed');
          daemonARunning = true;
        },
        fetchImpl: daemonFetch,
        stopWaitMs: 10,
        sleep: async () => {},
      });
    };

    // Attempt 1: prepareBind gets srv-relay-b-1, server commits N->srv-relay-b-1, HTTP response drops
    await expect(executePendingDesktopSetup({
      relayOrigin: 'https://relay-b.example.com',
      apiKey: 'deck_b_retry',
      daemonController: makeController(false),
      deps: { ...paths, pendingBindPath, platform: 'linux', arch: 'x64', hostname: 'alice-box', fetchFn: enrollFetch },
    })).rejects.toThrow(/network response lost/);

    expect(bindDirectCalls).toBe(1);
    expect(await readFile(serverJsonPath, 'utf8')).toBe(relayAServerJson);
    expect((await stat(pendingBindPath)).mode & 0o777).toBe(0o600);
    expect((await loadPendingDaemonBind(pendingBindPath))?.prepared.serverId).toBe('srv-relay-b-1');

    // Attempt 2 (fresh controller / restarted process): reuses srv-relay-b-1 (NO /bind/direct call), commitBind fails -> rolls back A, pendingBind kept
    await expect(executePendingDesktopSetup({
      relayOrigin: 'https://relay-b.example.com',
      apiKey: 'deck_b_retry',
      daemonController: makeController(true),
      deps: { ...paths, pendingBindPath, platform: 'linux', arch: 'x64', hostname: 'alice-box', fetchFn: enrollFetch },
    })).rejects.toThrow(/start_failed|daemon_bind_failed/);

    expect(bindDirectCalls).toBe(1);
    expect(await readFile(serverJsonPath, 'utf8')).toBe(relayAServerJson);
    expect((await stat(serverJsonPath)).mode & 0o777).toBe(0o600);
    expect(daemonARunning).toBe(true);
    expect(await loadCredential(paths.credentialPath)).toBeNull();
    const savedPending = await loadPendingDaemonBind(pendingBindPath);
    expect(savedPending?.prepared.serverId).toBe('srv-relay-b-1');

    // Also verify pending bind is NOT reused if active user changes (no hostServerId leakage across OS users)
    const bobController = createLocalDaemonController({
      platform: 'linux',
      env: {},
      procRoot,
      bundleDirs: [bundleDir],
      cliCandidates: [],
      currentUid: () => process.getuid!(),
      currentGid: () => process.getgid!(),
      activeUser: { platform: 'linux', username: 'bob', home: join(dir, 'bob-home'), uid: process.getuid!(), gid: process.getgid!() },
      fetchImpl: daemonFetch,
    });
    expect((await bobController.readSetupBindingInfo?.())?.activeUserKey).not.toBe(
      (await makeController(false).readSetupBindingInfo?.())?.activeUserKey,
    );
    expect(await bobController.commitBind?.(savedPending!.prepared)).toMatchObject({
      ok: false,
      error: 'active_user_changed',
    });

    // Attempt 3 (fresh controller / restarted process): reuses srv-relay-b-1, gets 200 idempotent (NO 409 conflict), commits B1, clears pendingBind
    const finalCred = await executePendingDesktopSetup({
      relayOrigin: 'https://relay-b.example.com',
      apiKey: 'deck_b_retry',
      daemonController: makeController(false),
      deps: { ...paths, pendingBindPath, platform: 'linux', arch: 'x64', hostname: 'alice-box', fetchFn: enrollFetch },
    });

    expect(bindDirectCalls).toBe(1);
    expect(finalCred.serverId).toBe('srv-ctrl-r2');
    expect(JSON.parse(await readFile(serverJsonPath, 'utf8')).serverId).toBe('srv-relay-b-1');
    expect((await stat(serverJsonPath)).mode & 0o777).toBe(0o600);
    expect((await loadCredential(paths.credentialPath))?.serverId).toBe('srv-ctrl-r2');
    expect((await loadInstallJournal(paths.journalPath)).phase).toBe('enrolled');
    expect(await loadPendingDaemonBind(pendingBindPath)).toBeNull();
    expect(enrolledNodes.size).toBe(1);
  });
});
