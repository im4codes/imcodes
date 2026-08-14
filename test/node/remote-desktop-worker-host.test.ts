import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_MODE_REASON,
  REMOTE_DESKTOP_PROTOCOL_VERSION,
  REMOTE_DESKTOP_TERMINAL_REASON,
  type RemoteDesktopDaemonMessage,
} from '../../shared/remote-desktop.js';
import { WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN } from '../../shared/remote-desktop-qualification.js';
import {
  REMOTE_DESKTOP_WORKER_FILENAME,
  REMOTE_DESKTOP_WORKER_HELLO_TYPE,
  REMOTE_DESKTOP_WORKER_IPC_VERSION,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_FILES,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME,
  validateRemoteDesktopWorkerManifest,
  type RemoteDesktopWorkerManifest,
} from '../../shared/remote-desktop-worker.js';
import {
  RemoteDesktopWorkerHost,
  verifyRemoteDesktopWorkerArtifact,
  verifyWindowsAuthenticodeSigners,
  type VerifiedRemoteDesktopWorkerArtifact,
} from '../../src/node/remote-desktop-worker-host.js';
import {
  launchWindowsActiveUserCommand,
  launchWindowsActiveUserElevatedCommand,
} from '../../src/node/windows-user-session.js';

const requestId = 'request_12345678';
const sessionId = 'session_12345678';
const capability = 'a'.repeat(43);

const manifest: RemoteDesktopWorkerManifest = {
  manifestVersion: 2,
  workerVersion: '1.0.0',
  protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
  ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
  os: 'win32',
  arch: 'x64',
  fileName: REMOTE_DESKTOP_WORKER_FILENAME,
  size: 1024,
  sha256: 'b'.repeat(64),
  authenticodeSignerSha256: 'c'.repeat(64),
  libwebrtcRevision: WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.libwebrtcRevision,
  virtualDisplay: {
    archiveFileName: 'imcodes-virtual-display.zip',
    packageManifestFileName: 'imcodes-virtual-display.manifest.json',
    size: 2048,
    sha256: 'd'.repeat(64),
  },
  toolchain: {
    msvc: '19.44',
    windowsSdk: '10.0.26100.0',
    cmake: '3.31.6',
    ninja: '1.12.1',
    depotTools: WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.depotToolsRevision,
  },
};

const artifact: VerifiedRemoteDesktopWorkerArtifact = {
  executablePath: 'C:\\ProgramData\\imcodes-node\\remote-desktop-worker\\imcodes-remote-desktop-worker.exe',
  manifestPath: 'worker.manifest.json',
  virtualDisplayDirectory: 'C:\\ProgramData\\imcodes-node\\remote-desktop-worker\\win32-x64\\virtual-display',
  manifest,
};
const trustedHostOptions = {
  trustedSignerSha256: manifest.authenticodeSignerSha256,
  verifyArtifactForLaunch: async () => artifact,
} as const;

let cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function quotedArgs(argsLine: string): string[] {
  return [...argsLine.matchAll(/"([^"]*)"/g)].map((match) => match[1]!);
}

describe('remote desktop worker artifact and IPC host', () => {
  it('accepts only the exact pinned immutable manifest contract', () => {
    expect(validateRemoteDesktopWorkerManifest(manifest)).toEqual(manifest);
    expect(validateRemoteDesktopWorkerManifest({ ...manifest, protocolVersion: 1 })).toBeNull();
    expect(validateRemoteDesktopWorkerManifest({ ...manifest, protocolVersion: 3 })).toBeNull();
    expect(validateRemoteDesktopWorkerManifest({ ...manifest, extra: true })).toBeNull();
    expect(validateRemoteDesktopWorkerManifest({ ...manifest, sha256: 'not-a-digest' })).toBeNull();
    expect(validateRemoteDesktopWorkerManifest({ ...manifest, authenticodeSignerSha256: 'not-a-digest' })).toBeNull();
    expect(validateRemoteDesktopWorkerManifest({ ...manifest, libwebrtcRevision: 'latest' })).toBeNull();
  });

  it('does not advertise the worker on non-Windows or without a verified artifact', () => {
    expect(new RemoteDesktopWorkerHost(() => {}, {
      ...trustedHostOptions, platform: 'darwin', artifact,
    }).available()).toBe(false);
    expect(new RemoteDesktopWorkerHost(() => {}, {
      ...trustedHostOptions, platform: 'win32', artifact: null,
    }).available()).toBe(false);
    expect(new RemoteDesktopWorkerHost(() => {}, { platform: 'win32', artifact }).available()).toBe(false);
  });

  it('anchors the on-disk manifest to the compiled signer and rejects extra package files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-rd-artifact-trust-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const platform = join(root, 'win32-x64');
    const virtualDisplay = join(platform, 'virtual-display');
    await mkdir(virtualDisplay, { recursive: true });
    const executablePath = join(platform, REMOTE_DESKTOP_WORKER_FILENAME);
    const workerBytes = Buffer.from('signed-worker-placeholder');
    const archiveBytes = Buffer.from('signed-driver-archive-placeholder');
    await writeFile(executablePath, workerBytes);
    await writeFile(join(platform, 'imcodes-virtual-display.zip'), archiveBytes);
    const virtualFiles = REMOTE_DESKTOP_VIRTUAL_DISPLAY_FILES.map((name) => ({
      name,
      bytes: Buffer.from(`package:${name}`),
    }));
    for (const file of virtualFiles) await writeFile(join(virtualDisplay, file.name), file.bytes);
    await writeFile(join(virtualDisplay, REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME), JSON.stringify({
      manifestVersion: 1,
      hardwareId: 'ImcodesVirtualDisplay',
      dllSignerSha256: manifest.authenticodeSignerSha256,
      catalogSignerSha256: manifest.authenticodeSignerSha256,
      files: virtualFiles.map((file) => ({
        name: file.name,
        size: file.bytes.length,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
      })),
    }));
    const onDiskManifest = {
      ...manifest,
      size: workerBytes.length,
      sha256: createHash('sha256').update(workerBytes).digest('hex'),
      virtualDisplay: {
        ...manifest.virtualDisplay,
        size: archiveBytes.length,
        sha256: createHash('sha256').update(archiveBytes).digest('hex'),
      },
    };
    await writeFile(`${executablePath}.manifest.json`, JSON.stringify(onDiskManifest));
    expect(verifyRemoteDesktopWorkerArtifact(
      executablePath,
      manifest.authenticodeSignerSha256,
    )).toMatchObject({ executablePath });
    await writeFile(`${executablePath}.manifest.json`, JSON.stringify({
      ...onDiskManifest,
      protocolVersion: 1,
    }));
    expect(verifyRemoteDesktopWorkerArtifact(
      executablePath,
      manifest.authenticodeSignerSha256,
      manifest.workerVersion,
    )).toMatchObject({ executablePath, manifest: { protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION } });
    expect(verifyRemoteDesktopWorkerArtifact(
      executablePath,
      manifest.authenticodeSignerSha256,
      'different-node-version',
    )).toBeNull();
    expect(verifyRemoteDesktopWorkerArtifact(executablePath, 'd'.repeat(64))).toBeNull();
    await writeFile(join(virtualDisplay, 'unexpected.bin'), 'not-allowed');
    expect(verifyRemoteDesktopWorkerArtifact(
      executablePath,
      manifest.authenticodeSignerSha256,
    )).toBeNull();
  });

  it('checks Authenticode status and the compiled signer without a shell command', async () => {
    let invocation: { file: string; args: readonly string[] } | null = null;
    const child = new EventEmitter();
    await expect(verifyWindowsAuthenticodeSigners(
      [artifact.executablePath],
      manifest.authenticodeSignerSha256,
      ((file, args, _options, callback) => {
        invocation = { file, args: args ?? [] };
        callback?.(null, '', '');
        return child;
      }) as unknown as typeof import('node:child_process').execFile,
    )).resolves.toBe(true);
    expect(invocation?.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    const encodedIndex = invocation!.args.indexOf('-EncodedCommand') + 1;
    const script = Buffer.from(invocation!.args[encodedIndex]!, 'base64').toString('utf16le');
    expect(script).toContain('Get-AuthenticodeSignature -LiteralPath');
    expect(script).toContain(manifest.authenticodeSignerSha256);
    expect(script).toContain(Buffer.from(JSON.stringify([artifact.executablePath]), 'utf8').toString('base64'));
    expect(script).not.toContain('Invoke-Expression');
  });

  it('launches from a non-inherited active-user environment without daemon credentials', () => {
    let launchArgs: readonly string[] = [];
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = () => {};
    const previous = process.env.IMCODES_NODE_TOKEN;
    process.env.IMCODES_NODE_TOKEN = 'must-not-be-inherited-by-worker';
    try {
      launchWindowsActiveUserCommand(
        artifact.executablePath,
        '--pipe "safe" --nonce "ephemeral"',
        ((_command: string, args: readonly string[]) => {
          launchArgs = args;
          return child;
        }) as never,
      );
    } finally {
      if (previous === undefined) delete process.env.IMCODES_NODE_TOKEN;
      else process.env.IMCODES_NODE_TOKEN = previous;
    }
    const encodedIndex = launchArgs.indexOf('-EncodedCommand') + 1;
    const script = Buffer.from(launchArgs[encodedIndex]!, 'base64').toString('utf16le');
    expect(script).toContain('CreateEnvironmentBlock(out env, primary, false)');
    expect(script).toContain('WTSGetActiveConsoleSessionId');
    expect(script).toContain('s.State == WTSDisconnected');
    expect(script).toContain('s.SessionID <= 0 || !HasUserToken(s.SessionID)');
    expect(script).toContain('s.SessionID == console && console > 0 && s.State == WTSActive');
    expect(script).toContain('activeCandidate == -2');
    expect(script).toContain('ambiguous active user sessions');
    expect(script.indexOf('s.SessionID == console && console > 0 && s.State == WTSActive'))
      .toBeLessThan(script.indexOf('if (s.State == WTSActive)'));
    expect(script).not.toContain('must-not-be-inherited-by-worker');
    expect(script).not.toContain('IMCODES_NODE_TOKEN');
    expect(script).toContain('[ImcodesUserProc]::Start($exe, $argsLine, $false)');
  });

  it('uses only the active administrator linked token for the verified desktop worker', () => {
    let launchArgs: readonly string[] = [];
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = () => {};
    launchWindowsActiveUserElevatedCommand(
      artifact.executablePath,
      '--pipe "safe" --nonce "ephemeral"',
      ((_command: string, args: readonly string[]) => {
        launchArgs = args;
        return child;
      }) as never,
    );
    const encodedIndex = launchArgs.indexOf('-EncodedCommand') + 1;
    const script = Buffer.from(launchArgs[encodedIndex]!, 'base64').toString('utf16le');
    expect(script).toContain('const int TokenLinkedToken = 19;');
    expect(script).toContain('elevationType == TokenElevationTypeLimited');
    expect(script).toContain('launchToken = linkedToken;');
    expect(script).toContain('[ImcodesUserProc]::Start($exe, $argsLine, $true)');
    expect(script).toContain('if (linkedToken != IntPtr.Zero) CloseHandle(linkedToken);');
  });

  it('authenticates one active-user worker and forwards only strict bounded envelopes', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-test-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const pipePath = join(temp, 'worker.sock');
    const received: RemoteDesktopDaemonMessage[] = [];
    let helper: net.Socket | null = null;
    let helperBuffer = '';
    const host = new RemoteDesktopWorkerHost((message) => received.push(message), {
      ...trustedHostOptions,
      platform: 'win32',
      artifact,
      pipePath,
      allowPipeClients: () => {},
      launch: (_executable, argsLine) => {
        const args = quotedArgs(argsLine);
        expect(args).toEqual(['--pipe', pipePath, '--nonce', expect.any(String)]);
        const nonce = args[3]!;
        helper = net.createConnection(pipePath, () => {
          helper!.write(`${JSON.stringify({
            type: REMOTE_DESKTOP_WORKER_HELLO_TYPE,
            ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
            nonce,
            pid: 42,
          })}\n`);
        });
        helper.setEncoding('utf8');
        helper.on('data', (chunk) => { helperBuffer += String(chunk); });
      },
    });
    cleanup.push(() => { host.close(); helper?.destroy(); });

    const prepare = {
      type: REMOTE_DESKTOP_MSG.PREPARE,
      requestId,
      sessionId,
      capability,
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 7,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      iceServers: ['stun:stun.example.test:3478'],
    } as const;
    await expect(host.handle(prepare)).resolves.toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(JSON.parse(helperBuffer.trim())).toEqual(prepare);

    helper!.write(`${JSON.stringify({
      type: REMOTE_DESKTOP_MSG.MODE_STATE,
      requestId,
      sessionId,
      capability,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      reason: REMOTE_DESKTOP_MODE_REASON.INITIAL,
    })}\n`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(received).toEqual([expect.objectContaining({ type: REMOTE_DESKTOP_MSG.MODE_STATE })]);

    // Extra keys never cross from a compromised worker to the Server.
    helper!.write(`${JSON.stringify({
      type: REMOTE_DESKTOP_MSG.MODE_STATE,
      requestId,
      sessionId,
      capability,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      reason: REMOTE_DESKTOP_MODE_REASON.INITIAL,
      leakedCredential: 'no',
    })}\n`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(1);

    // A valid-looking frame with another capability is rejected at the pipe
    // boundary rather than relying only on the later Server check.
    helper!.write(`${JSON.stringify({
      type: REMOTE_DESKTOP_MSG.MODE_STATE,
      requestId,
      sessionId,
      capability: 'b'.repeat(43),
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      reason: REMOTE_DESKTOP_MODE_REASON.INITIAL,
    })}\n`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(1);

    const tracked = (host as unknown as {
      tracked: Map<string, { capability: Buffer }>;
    }).tracked;
    const capabilityBytes = tracked.get(sessionId)!.capability;
    await expect(host.handle({
      type: REMOTE_DESKTOP_MSG.STOP,
      requestId,
      sessionId,
      capability,
    })).resolves.toBe(true);
    expect(tracked.size).toBe(0);
    expect([...capabilityBytes]).toEqual(new Array(capabilityBytes.length).fill(0));
  });

  it('launches a content-free release-only recovery after an active worker crashes', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-crash-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const pipePath = join(temp, 'worker.sock');
    let helper: net.Socket | null = null;
    const launch = vi.fn((_executable: string, argsLine: string) => {
      if (argsLine === '--release-all-input') return;
      const args = quotedArgs(argsLine);
      helper = net.createConnection(pipePath, () => {
        helper!.write(`${JSON.stringify({
          type: REMOTE_DESKTOP_WORKER_HELLO_TYPE,
          ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
          nonce: args[3],
          pid: 43,
        })}\n`);
      });
    });
    const verifyArtifactForLaunch = vi.fn(async () => artifact);
    const received: RemoteDesktopDaemonMessage[] = [];
    const host = new RemoteDesktopWorkerHost((message) => received.push(message), {
      ...trustedHostOptions,
      verifyArtifactForLaunch,
      platform: 'win32',
      artifact,
      pipePath,
      allowPipeClients: () => {},
      launch,
    });
    cleanup.push(() => { host.close(); helper?.destroy(); });
    await expect(host.handle({
      type: REMOTE_DESKTOP_MSG.PREPARE,
      requestId,
      sessionId,
      capability,
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 7,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: ['stun:stun.example.test:3478'],
    })).resolves.toBe(true);
    helper!.destroy();
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2));
    expect(verifyArtifactForLaunch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[1]).toEqual([
      artifact.executablePath,
      '--release-all-input',
    ]);
    expect(JSON.stringify(launch.mock.calls[1])).not.toContain(capability);
    expect(received).toContainEqual(expect.objectContaining({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      reason: 'worker_failed',
    }));
  });

  it('discards a poisoned worker pipe after a failed write and cold-starts the next session', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-write-failure-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const pipePath = join(temp, 'worker.sock');
    const helpers: net.Socket[] = [];
    const launch = vi.fn((_executable: string, argsLine: string) => {
      if (argsLine === '--release-all-input') return;
      const args = quotedArgs(argsLine);
      const helper = net.createConnection(pipePath, () => {
        helper.write(`${JSON.stringify({
          type: REMOTE_DESKTOP_WORKER_HELLO_TYPE,
          ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
          nonce: args[3],
          pid: 60 + helpers.length,
        })}\n`);
      });
      helpers.push(helper);
    });
    const verifyArtifactForLaunch = vi.fn(async () => artifact);
    const received: RemoteDesktopDaemonMessage[] = [];
    const host = new RemoteDesktopWorkerHost((message) => received.push(message), {
      ...trustedHostOptions,
      verifyArtifactForLaunch,
      platform: 'win32',
      artifact,
      pipePath,
      allowPipeClients: () => {},
      launch,
    });
    cleanup.push(() => {
      host.close();
      for (const helper of helpers) helper.destroy();
    });
    const first = {
      type: REMOTE_DESKTOP_MSG.PREPARE,
      requestId,
      sessionId,
      capability,
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 7,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      reconnectAttempt: 0,
      iceServers: ['stun:stun.example.test:3478'],
    } as const;
    await expect(host.handle(first)).resolves.toBe(true);

    const poisonedSocket = (host as unknown as { socket: net.Socket }).socket;
    vi.spyOn(poisonedSocket, 'write').mockImplementation(((_chunk: unknown, callback: unknown) => {
      if (typeof callback === 'function') callback(new Error('simulated broken pipe'));
      return false;
    }) as never);
    await expect(host.handle({
      ...first,
      requestId: 'request_poisoned',
      sessionId: 'session_poisoned',
      capability: 'b'.repeat(43),
    })).resolves.toBe(true);

    expect(poisonedSocket.destroyed).toBe(true);
    expect((host as unknown as { socket: net.Socket | null }).socket).toBeNull();
    expect(received).toContainEqual(expect.objectContaining({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      sessionId: 'session_poisoned',
      reason: REMOTE_DESKTOP_TERMINAL_REASON.WORKER_FAILED,
    }));
    await vi.waitFor(() => expect(launch.mock.calls.some(([, args]) => (
      args === '--release-all-input'
    ))).toBe(true));

    await expect(host.handle({
      ...first,
      requestId: 'request_recovered',
      sessionId: 'session_recovered',
      capability: 'c'.repeat(43),
    })).resolves.toBe(true);
    const workerLaunches = launch.mock.calls.filter(([, args]) => args !== '--release-all-input');
    expect(workerLaunches).toHaveLength(2);
    expect(verifyArtifactForLaunch).toHaveBeenCalledTimes(3);
    expect((host as unknown as { socket: net.Socket }).socket).not.toBe(poisonedSocket);
  });

  it('recycles an idle warm worker before a bounded browser reconnect', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-reconnect-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const pipePath = join(temp, 'worker.sock');
    const helpers: net.Socket[] = [];
    const launch = vi.fn((_executable: string, argsLine: string) => {
      const args = quotedArgs(argsLine);
      const helper = net.createConnection(pipePath, () => {
        helper.write(`${JSON.stringify({
          type: REMOTE_DESKTOP_WORKER_HELLO_TYPE,
          ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
          nonce: args[3],
          pid: 80 + helpers.length,
        })}\n`);
      });
      helpers.push(helper);
    });
    const verifyArtifactForLaunch = vi.fn(async () => artifact);
    const host = new RemoteDesktopWorkerHost(() => {}, {
      ...trustedHostOptions,
      verifyArtifactForLaunch,
      platform: 'win32',
      artifact,
      pipePath,
      allowPipeClients: () => {},
      launch,
    });
    cleanup.push(() => {
      host.close();
      for (const helper of helpers) helper.destroy();
    });
    const first = {
      type: REMOTE_DESKTOP_MSG.PREPARE,
      requestId,
      sessionId,
      capability,
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 7,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      reconnectAttempt: 0,
      iceServers: ['stun:stun.example.test:3478'],
    } as const;
    await expect(host.handle(first)).resolves.toBe(true);
    const firstHostSocket = (host as unknown as { socket: net.Socket }).socket;
    await expect(host.handle({
      type: REMOTE_DESKTOP_MSG.STOP,
      requestId,
      sessionId,
      capability,
    })).resolves.toBe(true);
    await expect(host.handle({
      ...first,
      requestId: 'request_reconnect',
      sessionId: 'session_reconnect',
      capability: 'b'.repeat(43),
      reconnectAttempt: 1,
    })).resolves.toBe(true);

    expect(launch).toHaveBeenCalledTimes(2);
    expect(verifyArtifactForLaunch).toHaveBeenCalledTimes(2);
    expect(firstHostSocket.destroyed).toBe(true);
  });

  it('retries an enumerated-but-non-presenting desktop once through the shared virtual display', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-headless-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const pipePath = join(temp, 'worker.sock');
    let helper: net.Socket | null = null;
    let helperBuffer = '';
    const controller = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      stdin: { end: ReturnType<typeof vi.fn> };
    };
    controller.exitCode = null;
    controller.stdin = {
      end: vi.fn(() => {
        controller.exitCode = 0;
        controller.emit('exit', 0);
      }),
    };
    const launchVirtualDisplay = vi.fn(() => controller);
    const activateVirtualDisplay = vi.fn();
    const received: RemoteDesktopDaemonMessage[] = [];
    const host = new RemoteDesktopWorkerHost((message) => received.push(message), {
      ...trustedHostOptions,
      platform: 'win32',
      artifact,
      pipePath,
      allowPipeClients: () => {},
      wait: async () => {},
      launchVirtualDisplay,
      activateVirtualDisplay,
      launch: (_executable, argsLine) => {
        const args = quotedArgs(argsLine);
        helper = net.createConnection(pipePath, () => {
          helper!.write(`${JSON.stringify({
            type: REMOTE_DESKTOP_WORKER_HELLO_TYPE,
            ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
            nonce: args[3],
            pid: 44,
          })}\n`);
        });
        helper!.setEncoding('utf8');
        helper!.on('data', (chunk) => { helperBuffer += String(chunk); });
      },
    });
    cleanup.push(() => { host.close(); helper?.destroy(); });
    const prepare = {
      type: REMOTE_DESKTOP_MSG.PREPARE,
      requestId,
      sessionId,
      capability,
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 7,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: ['stun:stun.example.test:3478'],
    } as const;
    await expect(host.handle(prepare)).resolves.toBe(true);
    helper!.write(`${JSON.stringify({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      requestId,
      sessionId,
      capability,
      reason: 'media_unavailable',
    })}\n`);
    await vi.waitFor(() => {
      expect(helperBuffer.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
        prepare,
        prepare,
      ]);
    });
    expect(launchVirtualDisplay).toHaveBeenCalledOnce();
    expect(activateVirtualDisplay).toHaveBeenCalledOnce();
    expect(activateVirtualDisplay).toHaveBeenCalledWith(artifact.executablePath);
    expect(received).toEqual([]);

    helper!.write(`${JSON.stringify({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      requestId,
      sessionId,
      capability,
      reason: 'media_unavailable',
    })}\n`);
    await vi.waitFor(() => expect(received).toEqual([
      expect.objectContaining({ reason: 'media_unavailable' }),
    ]));
    expect(controller.stdin.end).toHaveBeenCalledOnce();
  });

  it('shares one headless controller across concurrent sessions and removes it only after the last session', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-shared-headless-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const pipePath = join(temp, 'worker.sock');
    let helper: net.Socket | null = null;
    let helperBuffer = '';
    const controller = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      stdin: { end: ReturnType<typeof vi.fn> };
    };
    controller.exitCode = null;
    controller.stdin = {
      end: vi.fn(() => {
        controller.exitCode = 0;
        controller.emit('exit', 0);
      }),
    };
    const launchVirtualDisplay = vi.fn(() => controller);
    const activateVirtualDisplay = vi.fn();
    const host = new RemoteDesktopWorkerHost(() => {}, {
      ...trustedHostOptions,
      platform: 'win32',
      artifact,
      pipePath,
      allowPipeClients: () => {},
      wait: async () => {},
      launchVirtualDisplay,
      activateVirtualDisplay,
      launch: (_executable, argsLine) => {
        const args = quotedArgs(argsLine);
        helper = net.createConnection(pipePath, () => {
          helper!.write(`${JSON.stringify({
            type: REMOTE_DESKTOP_WORKER_HELLO_TYPE,
            ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
            nonce: args[3],
            pid: 45,
          })}\n`);
        });
        helper!.setEncoding('utf8');
        helper!.on('data', (chunk) => { helperBuffer += String(chunk); });
      },
    });
    cleanup.push(() => { host.close(); helper?.destroy(); });
    const first = {
      type: REMOTE_DESKTOP_MSG.PREPARE,
      requestId,
      sessionId,
      capability,
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 7,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: ['stun:stun.example.test:3478'],
    } as const;
    const second = {
      ...first,
      requestId: 'request_abcdefgh',
      sessionId: 'session_abcdefgh',
      capability: 'b'.repeat(43),
    } as const;
    await expect(host.handle(first)).resolves.toBe(true);
    await expect(host.handle(second)).resolves.toBe(true);
    for (const prepare of [first, second]) {
      helper!.write(`${JSON.stringify({
        type: REMOTE_DESKTOP_MSG.TERMINAL,
        requestId: prepare.requestId,
        sessionId: prepare.sessionId,
        capability: prepare.capability,
        reason: REMOTE_DESKTOP_TERMINAL_REASON.MEDIA_UNAVAILABLE,
      })}\n`);
    }
    await vi.waitFor(() => {
      const messages = helperBuffer.trim().split('\n').map((line) => JSON.parse(line));
      expect(messages.filter((message) => message.type === REMOTE_DESKTOP_MSG.PREPARE
        && message.sessionId === first.sessionId)).toHaveLength(2);
      expect(messages.filter((message) => message.type === REMOTE_DESKTOP_MSG.PREPARE
        && message.sessionId === second.sessionId)).toHaveLength(2);
    });
    expect(launchVirtualDisplay).toHaveBeenCalledOnce();
    expect(activateVirtualDisplay).toHaveBeenCalledOnce();

    await expect(host.handle({
      type: REMOTE_DESKTOP_MSG.STOP,
      requestId: first.requestId,
      sessionId: first.sessionId,
      capability: first.capability,
    })).resolves.toBe(true);
    expect(controller.stdin.end).not.toHaveBeenCalled();
    await expect(host.handle({
      type: REMOTE_DESKTOP_MSG.STOP,
      requestId: second.requestId,
      sessionId: second.sessionId,
      capability: second.capability,
    })).resolves.toBe(true);
    expect(controller.stdin.end).toHaveBeenCalledOnce();
  });

  it('does not loop virtual-display recovery after the shared controller crashes', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-controller-crash-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const pipePath = join(temp, 'worker.sock');
    let helper: net.Socket | null = null;
    let helperBuffer = '';
    const controller = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      stdin: { end(): void };
    };
    controller.exitCode = null;
    controller.stdin = { end: vi.fn() };
    const launchVirtualDisplay = vi.fn(() => controller);
    const received: RemoteDesktopDaemonMessage[] = [];
    const host = new RemoteDesktopWorkerHost((message) => received.push(message), {
      ...trustedHostOptions,
      platform: 'win32',
      artifact,
      pipePath,
      allowPipeClients: () => {},
      wait: async () => {},
      launchVirtualDisplay,
      activateVirtualDisplay: vi.fn(),
      launch: (_executable, argsLine) => {
        const args = quotedArgs(argsLine);
        helper = net.createConnection(pipePath, () => {
          helper!.write(`${JSON.stringify({
            type: REMOTE_DESKTOP_WORKER_HELLO_TYPE,
            ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
            nonce: args[3],
            pid: 46,
          })}\n`);
        });
        helper!.setEncoding('utf8');
        helper!.on('data', (chunk) => { helperBuffer += String(chunk); });
      },
    });
    cleanup.push(() => { host.close(); helper?.destroy(); });
    const prepare = {
      type: REMOTE_DESKTOP_MSG.PREPARE,
      requestId,
      sessionId,
      capability,
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 7,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: ['stun:stun.example.test:3478'],
    } as const;
    await expect(host.handle(prepare)).resolves.toBe(true);
    const mediaUnavailable = {
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      requestId,
      sessionId,
      capability,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.MEDIA_UNAVAILABLE,
    } as const;
    helper!.write(`${JSON.stringify(mediaUnavailable)}\n`);
    await vi.waitFor(() => {
      const messages = helperBuffer.trim().split('\n').map((line) => JSON.parse(line));
      expect(messages.filter((message) => message.type === REMOTE_DESKTOP_MSG.PREPARE)).toHaveLength(2);
    });
    controller.exitCode = 31;
    controller.emit('exit', 31);
    helper!.write(`${JSON.stringify(mediaUnavailable)}\n`);
    await vi.waitFor(() => expect(received).toEqual([
      expect.objectContaining({
        type: REMOTE_DESKTOP_MSG.TERMINAL,
        reason: REMOTE_DESKTOP_TERMINAL_REASON.MEDIA_UNAVAILABLE,
      }),
    ]));
    expect(launchVirtualDisplay).toHaveBeenCalledOnce();
  });
});
