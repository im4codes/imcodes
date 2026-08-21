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
  REMOTE_DESKTOP_WORKER_CRASH_TYPE,
  REMOTE_DESKTOP_WORKER_FILENAME,
  REMOTE_DESKTOP_WORKER_HELLO_TYPE,
  REMOTE_DESKTOP_WORKER_IPC_VERSION,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_FILES,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME,
  validateRemoteDesktopWorkerManifest,
  type RemoteDesktopWorkerCrash,
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
  launchWindowsRemoteDesktopCommand,
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

function decodePowerShellStdinCommand(value: string): string {
  const encoded = value.match(/FromBase64String\('([^']+)'\)/)?.[1];
  if (!encoded) throw new Error('PowerShell stdin command did not contain the launcher');
  return Buffer.from(encoded, 'base64').toString('utf8');
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
    let script = '';
    const child = new EventEmitter() as EventEmitter & {
      stdin: EventEmitter & { end(value: string, encoding: BufferEncoding): void };
      unref(): void;
    };
    child.stdin = new EventEmitter() as typeof child.stdin;
    child.stdin.end = (value, encoding) => {
      script = decodePowerShellStdinCommand(Buffer.from(value, encoding).toString('utf8'));
    };
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
    expect(launchArgs).toEqual([
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-',
    ]);
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
    expect(script).toContain('[ImcodesUserProc]::Start($exe, $argsLine, $false, $false, $false)');
  });

  it('uses only the active administrator linked token for the verified desktop worker', () => {
    let launchArgs: readonly string[] = [];
    let script = '';
    const child = new EventEmitter() as EventEmitter & {
      stdin: EventEmitter & { end(value: string, encoding: BufferEncoding): void };
      unref(): void;
    };
    child.stdin = new EventEmitter() as typeof child.stdin;
    child.stdin.end = (value, encoding) => {
      script = decodePowerShellStdinCommand(Buffer.from(value, encoding).toString('utf8'));
    };
    child.unref = () => {};
    launchWindowsActiveUserElevatedCommand(
      artifact.executablePath,
      '--pipe "safe" --nonce "ephemeral"',
      ((_command: string, args: readonly string[]) => {
        launchArgs = args;
        return child;
      }) as never,
    );
    expect(launchArgs).toEqual([
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-',
    ]);
    expect(script).toContain('const int TokenLinkedToken = 19;');
    expect(script).toContain('elevationType == TokenElevationTypeLimited');
    expect(script).toContain('launchToken = linkedToken;');
    expect(script).toContain('[ImcodesUserProc]::Start($exe, $argsLine, $true, $false, $false)');
    expect(script).toContain('if (linkedToken != IntPtr.Zero) CloseHandle(linkedToken);');
  });

  it('launches the authenticated SYSTEM worker in the selected user session before falling back to console', () => {
    let launchArgs: readonly string[] = [];
    let script = '';
    const child = new EventEmitter() as EventEmitter & {
      stdin: EventEmitter & { end(value: string, encoding: BufferEncoding): void };
      unref(): void;
    };
    child.stdin = new EventEmitter() as typeof child.stdin;
    child.stdin.end = (value, encoding) => {
      script = decodePowerShellStdinCommand(Buffer.from(value, encoding).toString('utf8'));
    };
    child.unref = () => {};
    launchWindowsRemoteDesktopCommand(
      artifact.executablePath,
      '--pipe "safe" --nonce "ephemeral"',
      ((_command: string, args: readonly string[]) => {
        launchArgs = args;
        return child;
      }) as never,
    );
    expect(launchArgs).toEqual([
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-',
    ]);
    expect(script).toContain('WindowsIdentity.GetCurrent().User.Value != "S-1-5-18"');
    expect(script).toContain('SetTokenInformation(primary, TokenSessionId, ref sid, sizeof(int))');
    expect(script).toContain('if (TryInteractiveSessionId(out sid))');
    expect(script).toContain('if (TryDisconnectedUserSessionId(out sid))');
    expect(script).toContain('ReconnectSessionToConsole(sid);');
    expect(script).toContain('StartSystemInSession(exe, argsLine, sid,');
    expect(script).toContain('Path.Combine(Environment.SystemDirectory, "tscon.exe")');
    expect(script).toContain('sid.ToString(System.Globalization.CultureInfo.InvariantCulture) + " /dest:console"');
    expect(script).toContain('process.WaitForExit(15000)');
    expect(script).toContain('try { process.Kill(); } catch { }');
    expect(script).toContain('argsLine + " --secure-console"');
    expect(script).toContain('"winsta0\\\\Winlogon"');
    expect(script).toContain('[ImcodesUserProc]::Start($exe, $argsLine, $true, $true, $false)');
    // A lingering LogonUI process must never decide the desktop again: it kept
    // logged-in machines on the privileged Winlogon worker, which can neither
    // capture nor inject there.
    expect(script).not.toContain('GetProcessesByName');
    expect(script.indexOf('if (TryInteractiveSessionId(out sid))'))
      .toBeLessThan(script.indexOf('if (TryDisconnectedUserSessionId(out sid))'));
    expect(script.indexOf('if (TryDisconnectedUserSessionId(out sid))'))
      .toBeLessThan(script.lastIndexOf('WTSGetActiveConsoleSessionId()'));
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

  it('kills and reports a worker that never completes PREPARE, so the panel can retry', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-prepare-watchdog-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const pipePath = join(temp, 'worker.sock');
    const received: RemoteDesktopDaemonMessage[] = [];
    const terminated: number[] = [];
    const timedOut = vi.fn();
    let helper: net.Socket | null = null;
    const host = new RemoteDesktopWorkerHost((message) => received.push(message), {
      ...trustedHostOptions,
      platform: 'win32',
      artifact,
      pipePath,
      allowPipeClients: () => {},
      prepareReadyTimeoutMs: 20,
      terminateProcess: (pid) => terminated.push(pid),
      onPrepareTimeout: timedOut,
      launch: (_executable, argsLine) => {
        const args = quotedArgs(argsLine);
        const nonce = args[3]!;
        helper = net.createConnection(pipePath, () => {
          helper!.write(`${JSON.stringify({
            type: REMOTE_DESKTOP_WORKER_HELLO_TYPE,
            ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
            nonce,
            pid: 91,
          })}\n`);
        });
      },
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
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      iceServers: [],
    })).resolves.toBe(true);

    // Do not write MODE_STATE: this models a D3D/DXGI call wedging the native
    // signaling thread before it can read the browser's OFFER or STOP.
    await vi.waitFor(() => expect(received).toEqual([
      expect.objectContaining({
        type: REMOTE_DESKTOP_MSG.TERMINAL,
        requestId,
        sessionId,
        reason: REMOTE_DESKTOP_TERMINAL_REASON.WORKER_FAILED,
      }),
    ]), { timeout: 1_000 });
    expect(terminated).toEqual([91]);
    expect(timedOut).toHaveBeenCalledTimes(1);
    const tracked = (host as unknown as { tracked: Map<string, unknown> }).tracked;
    expect(tracked.size).toBe(0);
  });

  it('does not arm a late PREPARE watchdog after an immediate MODE_STATE', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-prepare-ready-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const pipePath = join(temp, 'worker.sock');
    const received: RemoteDesktopDaemonMessage[] = [];
    const terminated: number[] = [];
    let helper: net.Socket | null = null;
    let buffered = '';
    const host = new RemoteDesktopWorkerHost((message) => received.push(message), {
      ...trustedHostOptions,
      platform: 'win32',
      artifact,
      pipePath,
      allowPipeClients: () => {},
      prepareReadyTimeoutMs: 20,
      terminateProcess: (pid) => terminated.push(pid),
      launch: (_executable, argsLine) => {
        const nonce = quotedArgs(argsLine)[3]!;
        helper = net.createConnection(pipePath, () => {
          helper!.write(`${JSON.stringify({
            type: REMOTE_DESKTOP_WORKER_HELLO_TYPE,
            ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
            nonce,
            pid: 92,
          })}\n`);
        });
        helper.setEncoding('utf8');
        helper.on('data', (chunk) => {
          buffered += String(chunk);
          if (!buffered.includes('\n')) return;
          buffered = '';
          helper!.write(`${JSON.stringify({
            type: REMOTE_DESKTOP_MSG.MODE_STATE,
            requestId,
            sessionId,
            capability,
            mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
            inputEpoch: 0,
            reason: REMOTE_DESKTOP_MODE_REASON.INITIAL,
          })}\n`);
        });
      },
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
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      iceServers: [],
    })).resolves.toBe(true);
    await vi.waitFor(() => expect(received).toEqual([
      expect.objectContaining({ type: REMOTE_DESKTOP_MSG.MODE_STATE, sessionId }),
    ]));
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(terminated).toEqual([]);
  });

  it('replaces a worker that answers PREPARE with protected_desktop, exactly once', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-desktop-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const pipePath = join(temp, 'worker.sock');
    const received: RemoteDesktopDaemonMessage[] = [];
    const helpers: net.Socket[] = [];
    const forced: (boolean | undefined)[] = [];
    let workerNonce = '';
    const host = new RemoteDesktopWorkerHost((message) => received.push(message), {
      ...trustedHostOptions,
      platform: 'win32',
      artifact,
      pipePath,
      allowPipeClients: () => {},
      launch: (_executable, argsLine, forceSecureConsole) => {
        if (argsLine.includes('--release-all-input')) return;
        forced.push(forceSecureConsole);
        workerNonce = quotedArgs(argsLine)[3]!;
        const helper = net.createConnection(pipePath, () => {
          helper.write(`${JSON.stringify({
            type: REMOTE_DESKTOP_WORKER_HELLO_TYPE,
            ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
            nonce: workerNonce,
            pid: 90 + helpers.length,
          })}\n`);
        });
        helpers.push(helper);
      },
    });
    cleanup.push(() => { host.close(); helpers.forEach((helper) => helper.destroy()); });

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
    await vi.waitFor(() => expect(helpers).toHaveLength(1));

    const protectedDesktop = {
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      requestId,
      sessionId,
      capability,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.PROTECTED_DESKTOP,
    };
    helpers[0]!.write(`${JSON.stringify(protectedDesktop)}\n`);

    // The first answer is absorbed: a second worker is launched onto the
    // privileged desktop and the same PREPARE is replayed to it. The browser
    // is asked for a fresh peer on the same grant instead of losing it.
    await vi.waitFor(() => expect(helpers).toHaveLength(2));
    expect(forced).toEqual([false, true]);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({
      type: REMOTE_DESKTOP_MSG.RENEGOTIATE,
      requestId,
      sessionId,
      capability,
    });

    // A second protected_desktop is terminal: no launch loop.
    helpers[1]!.write(`${JSON.stringify(protectedDesktop)}\n`);
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[1]).toMatchObject({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.PROTECTED_DESKTOP,
    });
    expect(helpers).toHaveLength(2);
  });

  it('sends the replacement to the user desktop when the privileged worker reports the switch', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-unlock-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const pipePath = join(temp, 'worker.sock');
    const received: RemoteDesktopDaemonMessage[] = [];
    const helpers: net.Socket[] = [];
    const forced: (boolean | undefined)[] = [];
    const host = new RemoteDesktopWorkerHost((message) => received.push(message), {
      ...trustedHostOptions,
      platform: 'win32',
      artifact,
      pipePath,
      allowPipeClients: () => {},
      launch: (_executable, argsLine, forceSecureConsole) => {
        if (argsLine.includes('--release-all-input')) return;
        forced.push(forceSecureConsole);
        const nonce = quotedArgs(argsLine)[3]!;
        // The hello is written from an async connect callback, so the index has
        // to be captured now rather than read from the growing array later.
        const index = helpers.length;
        const helper = net.createConnection(pipePath, () => {
          helper.write(`${JSON.stringify({
            type: REMOTE_DESKTOP_WORKER_HELLO_TYPE,
            ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
            nonce,
            pid: 70 + index,
            // This worker owns the sign-in desktop, so its replacement has to
            // go to the user's desktop — the direction a real sign-in takes.
            secureConsole: index === 0,
          })}\n`);
        });
        helpers.push(helper);
      },
    });
    cleanup.push(() => { host.close(); helpers.forEach((helper) => helper.destroy()); });

    await expect(host.handle({
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
    })).resolves.toBe(true);
    await vi.waitFor(() => expect(helpers).toHaveLength(1));

    helpers[0]!.write(`${JSON.stringify({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      requestId,
      sessionId,
      capability,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.PROTECTED_DESKTOP,
    })}\n`);

    await vi.waitFor(() => expect(helpers).toHaveLength(2));
    expect(forced).toEqual([false, false]);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({ type: REMOTE_DESKTOP_MSG.RENEGOTIATE, sessionId });
  });

  it('hands the sign-in secret to the worker on stdin, never on a command line', async () => {
    const spawned: Array<{ args: readonly string[]; stdin: string }> = [];
    const spawnUnlockSecret = ((_executable: string, args: readonly string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: { end(chunk?: Buffer): void };
      };
      let written = '';
      child.stdin = { end: (chunk?: Buffer) => { written = chunk?.toString('utf8') ?? ''; } };
      queueMicrotask(() => {
        spawned.push({ args, stdin: written });
        child.emit('exit', 0);
      });
      return child;
    }) as never;
    const host = new RemoteDesktopWorkerHost(() => {}, {
      ...trustedHostOptions,
      platform: 'win32',
      artifact,
      spawnUnlockSecret,
    });
    cleanup.push(() => host.close());

    await expect(host.applyAutoUnlockSecret('hunter2')).resolves.toBe(true);
    await expect(host.applyAutoUnlockSecret(null)).resolves.toBe(true);

    expect(spawned.map((call) => call.args)).toEqual([
      ['--set-unlock-secret'],
      ['--clear-unlock-secret'],
    ]);
    // The secret reaches the worker only through stdin: argv is readable by any
    // local process through WMI.
    expect(spawned[0]!.stdin).toBe('hunter2');
    expect(spawned[0]!.args.join(' ')).not.toContain('hunter2');
    expect(spawned[1]!.stdin).toBe('');
  });

  it('reports the stored-secret state from the worker exit code alone', async () => {
    const exitCodes = [0, 22];
    const spawnUnlockSecret = (() => {
      const child = new EventEmitter() as EventEmitter & { stdin: null };
      child.stdin = null;
      queueMicrotask(() => child.emit('exit', exitCodes.shift() ?? 22));
      return child;
    }) as never;
    const host = new RemoteDesktopWorkerHost(() => {}, {
      ...trustedHostOptions,
      platform: 'win32',
      artifact,
      spawnUnlockSecret,
    });
    cleanup.push(() => host.close());

    await expect(host.autoUnlockConfigured()).resolves.toBe(true);
    await expect(host.autoUnlockConfigured()).resolves.toBe(false);
  });

  it('surfaces a native worker crash frame and ignores forged ones', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-fault-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const pipePath = join(temp, 'worker.sock');
    const received: RemoteDesktopDaemonMessage[] = [];
    const crashes: RemoteDesktopWorkerCrash[] = [];
    let helper: net.Socket | null = null;
    let workerNonce = '';
    const host = new RemoteDesktopWorkerHost((message) => received.push(message), {
      ...trustedHostOptions,
      platform: 'win32',
      artifact,
      pipePath,
      allowPipeClients: () => {},
      onWorkerCrash: (crash) => crashes.push(crash),
      launch: (_executable, argsLine) => {
        workerNonce = quotedArgs(argsLine)[3]!;
        helper = net.createConnection(pipePath, () => {
          helper!.write(`${JSON.stringify({
            type: REMOTE_DESKTOP_WORKER_HELLO_TYPE,
            ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
            nonce: workerNonce,
            pid: 44,
          })}\n`);
        });
      },
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
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      iceServers: [],
    })).resolves.toBe(true);

    // Another process cannot forge a crash report without the worker nonce.
    helper!.write(`${JSON.stringify({
      type: REMOTE_DESKTOP_WORKER_CRASH_TYPE,
      ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
      nonce: 'c'.repeat(43),
      pid: 44,
      exceptionCode: 0xc0000005,
      module: 'imcodes-remote-desktop-worker.exe',
      moduleOffset: 4242,
    })}\n`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(crashes).toHaveLength(0);

    helper!.write(`${JSON.stringify({
      type: REMOTE_DESKTOP_WORKER_CRASH_TYPE,
      ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
      nonce: workerNonce,
      pid: 44,
      exceptionCode: 0xc0000005,
      module: 'imcodes-remote-desktop-worker.exe',
      moduleOffset: 4242,
    })}\n`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(crashes).toEqual([expect.objectContaining({
      exceptionCode: 0xc0000005,
      module: 'imcodes-remote-desktop-worker.exe',
      moduleOffset: 4242,
      pid: 44,
    })]);
    // The crash frame is diagnostic only: it never reaches the Server path.
    expect(received).toHaveLength(0);
  });

  it('launches a content-free release-only recovery after an active worker crashes', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-crash-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const pipePath = join(temp, 'worker.sock');
    let helper: net.Socket | null = null;
    const launch = vi.fn((_executable: string, argsLine: string) => {
      if (argsLine.includes('--release-all-input')) return;
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
    // The host now hands the launcher the unserialised args as well, so a
    // launcher that spawns the worker directly need not re-parse the line this
    // host just quoted.
    expect(launch.mock.calls[1]).toEqual([
      artifact.executablePath,
      '"--release-all-input"',
      false,
      ['--release-all-input'],
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
      if (argsLine.includes('--release-all-input')) return;
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
    await vi.waitFor(() => expect(launch.mock.calls.some(([, argsLine]) => (
      String(argsLine).includes('--release-all-input')
    ))).toBe(true));

    await expect(host.handle({
      ...first,
      requestId: 'request_recovered',
      sessionId: 'session_recovered',
      capability: 'c'.repeat(43),
    })).resolves.toBe(true);
    const workerLaunches = launch.mock.calls.filter(([, argsLine]) => (
      !String(argsLine).includes('--release-all-input')
    ));
    expect(workerLaunches).toHaveLength(2);
    expect(verifyArtifactForLaunch).toHaveBeenCalledTimes(3);
    expect((host as unknown as { socket: net.Socket }).socket).not.toBe(poisonedSocket);
  });

  it('transparently replaces a stale idle worker pipe before admitting the next session', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-idle-write-failure-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const pipePath = join(temp, 'worker.sock');
    const helpers: net.Socket[] = [];
    const helperBuffers: string[] = [];
    const launch = vi.fn((_executable: string, argsLine: string) => {
      const args = quotedArgs(argsLine);
      const index = helpers.length;
      helperBuffers.push('');
      const helper = net.createConnection(pipePath, () => {
        helper.write(`${JSON.stringify({
          type: REMOTE_DESKTOP_WORKER_HELLO_TYPE,
          ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
          nonce: args[3],
          pid: 90 + index,
        })}\n`);
      });
      helper.setEncoding('utf8');
      helper.on('data', (chunk) => { helperBuffers[index] += String(chunk); });
      helpers.push(helper);
    });
    const received: RemoteDesktopDaemonMessage[] = [];
    const host = new RemoteDesktopWorkerHost((message) => received.push(message), {
      ...trustedHostOptions,
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
      iceServers: ['stun:stun.example.test:3478'],
    } as const;
    await expect(host.handle(first)).resolves.toBe(true);
    await expect(host.handle({
      type: REMOTE_DESKTOP_MSG.STOP,
      requestId,
      sessionId,
      capability,
    })).resolves.toBe(true);

    const staleSocket = (host as unknown as { socket: net.Socket }).socket;
    vi.spyOn(staleSocket, 'write').mockImplementation(((_chunk: unknown, callback: unknown) => {
      if (typeof callback === 'function') callback(new Error('simulated stale idle pipe'));
      return false;
    }) as never);
    const recovered = {
      ...first,
      requestId: 'request_idle_recovered',
      sessionId: 'session_idle_recovered',
      capability: 'd'.repeat(43),
    } as const;
    await expect(host.handle(recovered)).resolves.toBe(true);

    expect(staleSocket.destroyed).toBe(true);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(received).not.toContainEqual(expect.objectContaining({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      sessionId: recovered.sessionId,
    }));
    await vi.waitFor(() => expect(helperBuffers[1]).toContain(recovered.sessionId));
    expect(JSON.parse(helperBuffers[1]!.trim())).toEqual(recovered);
    expect((host as unknown as { socket: net.Socket }).socket).not.toBe(staleSocket);
  });

  it('cold-starts when the idle pipe closes between the check and the write', async () => {
    // The worker-failed the operator actually saw: after a quiet period the
    // warm worker has exited, its pipe still looks alive when the host checks
    // it, and the close lands before the PREPARE can be written. That must
    // cold-start a replacement, not end the session the browser just opened.
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-idle-close-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const pipePath = join(temp, 'worker.sock');
    const helpers: net.Socket[] = [];
    const helperBuffers: string[] = [];
    const launch = vi.fn((_executable: string, argsLine: string) => {
      const args = quotedArgs(argsLine);
      const index = helpers.length;
      helperBuffers.push('');
      const helper = net.createConnection(pipePath, () => {
        helper.write(`${JSON.stringify({
          type: REMOTE_DESKTOP_WORKER_HELLO_TYPE,
          ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
          nonce: args[3],
          pid: 70 + index,
        })}\n`);
      });
      helper.setEncoding('utf8');
      helper.on('data', (chunk) => { helperBuffers[index] += String(chunk); });
      helpers.push(helper);
    });
    const received: RemoteDesktopDaemonMessage[] = [];
    const host = new RemoteDesktopWorkerHost((message) => received.push(message), {
      ...trustedHostOptions,
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
      iceServers: ['stun:stun.example.test:3478'],
    } as const;
    await expect(host.handle(first)).resolves.toBe(true);
    await expect(host.handle({
      type: REMOTE_DESKTOP_MSG.STOP, requestId, sessionId, capability,
    })).resolves.toBe(true);

    const staleSocket = (host as unknown as { socket: net.Socket }).socket;
    const next = {
      ...first,
      requestId: 'request_idle_closed',
      sessionId: 'session_idle_closed',
      capability: 'e'.repeat(43),
    } as const;
    // Pin the race deterministically: the pipe passes the liveness check and
    // the close lands before the PREPARE can be written. Only the first start
    // is sabotaged, so the cold-started replacement is free to succeed.
    const internals = host as unknown as {
      ensureStarted(force?: boolean): Promise<void>;
      socket: net.Socket | null;
    };
    const realEnsureStarted = internals.ensureStarted.bind(host);
    let closeDuringStart = true;
    vi.spyOn(internals, 'ensureStarted').mockImplementation(async (force?: boolean) => {
      await realEnsureStarted(force);
      if (closeDuringStart) {
        closeDuringStart = false;
        internals.socket?.destroy();
      }
    });
    await expect(host.handle(next)).resolves.toBe(true);

    expect(launch).toHaveBeenCalledTimes(3);
    expect(received).not.toContainEqual(expect.objectContaining({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.WORKER_FAILED,
    }));
    await vi.waitFor(() => expect(helperBuffers[2]).toContain(next.sessionId));
    expect(JSON.parse(helperBuffers[2]!.trim())).toEqual(next);
    expect((host as unknown as { socket: net.Socket }).socket).not.toBe(staleSocket);
  });

  it('drops the authority when the replacement worker never comes up', async () => {
    // Without this, the session stays in `tracked` forever: the Server has
    // already ended it and will never send STOP, so nothing untracks it, its
    // capability is never wiped, and every later PREPARE sees a busy host and
    // skips this very recovery.
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-recovery-fail-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const pipePath = join(temp, 'worker.sock');
    const received: RemoteDesktopDaemonMessage[] = [];
    const host = new RemoteDesktopWorkerHost((message) => received.push(message), {
      ...trustedHostOptions,
      platform: 'win32',
      artifact,
      pipePath,
      allowPipeClients: () => {},
      launch: vi.fn(),
    });
    cleanup.push(() => host.close());
    const internals = host as unknown as {
      ensureStarted(force?: boolean): Promise<void>;
      tracked: Map<string, unknown>;
      socket: net.Socket | null;
    };
    // Both starts report success with nothing behind them.
    vi.spyOn(internals, 'ensureStarted').mockImplementation(async () => {
      internals.socket = null;
    });

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
    })).rejects.toThrow(/recovery_failed/);
    expect(internals.tracked.size).toBe(0);
  });

  it('starts one worker when two sessions are admitted at the same time', async () => {
    // `handle()` runs once per inbound message with no serialization, so the
    // check that decides to cold start and the memo that records it must be set
    // without an await in between — or both callers tear down the listener and
    // launch their own worker.
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-single-flight-'));
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
          pid: 60 + helpers.length,
        })}\n`);
      });
      helper.setEncoding('utf8');
      helper.on('data', () => {});
      helpers.push(helper);
    });
    const host = new RemoteDesktopWorkerHost(() => {}, {
      ...trustedHostOptions,
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
    const prepare = (suffix: string) => ({
      type: REMOTE_DESKTOP_MSG.PREPARE,
      requestId: `request_1234567${suffix}`,
      sessionId: `session_1234567${suffix}`,
      capability: suffix.repeat(43),
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 7,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: ['stun:stun.example.test:3478'],
    } as const);

    const [first, second] = await Promise.all([
      host.handle(prepare('a')),
      host.handle(prepare('b')),
    ]);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(helpers).toHaveLength(1);
  });

  it('drops a connection that never finishes the handshake', async () => {
    // The pipe admits any authenticated local process and the hello timer is an
    // idle timer, so an unfinished handshake must still be bounded — otherwise
    // it holds the listener's connection count up and the next start with it.
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-handshake-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const pipePath = join(temp, 'worker.sock');
    const silent: net.Socket[] = [];
    const tricklers: ReturnType<typeof setInterval>[] = [];
    cleanup.push(() => { for (const timer of tricklers) clearInterval(timer); });
    const launch = vi.fn(() => {
      const socket = net.createConnection(pipePath, () => {
        // Trickles a byte well inside the idle window and never completes a
        // line: the inactivity timer alone never fires, so only a deadline on
        // the whole handshake can end this.
        socket.write('{');
        const timer = setInterval(() => {
          if (!socket.destroyed) socket.write(' ');
        }, 200);
        timer.unref?.();
        tricklers.push(timer);
      });
      socket.on('error', () => {});
      silent.push(socket);
    });
    const host = new RemoteDesktopWorkerHost(() => {}, {
      ...trustedHostOptions,
      platform: 'win32',
      artifact,
      pipePath,
      allowPipeClients: () => {},
      launch,
      connectTimeoutMs: 1_000,
    });
    cleanup.push(() => {
      host.close();
      for (const socket of silent) socket.destroy();
    });
    const internals = host as unknown as { pendingHelloSockets: Set<net.Socket> };

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
    })).rejects.toThrow();
    // The half-open connection is torn down on its own deadline rather than
    // left holding the listener.
    await vi.waitFor(() => expect(internals.pendingHelloSockets.size).toBe(0),
      { timeout: 6_000, interval: 50 });
    expect(silent[0]?.destroyed).toBe(true);
  });

  it('waits for its own cold start instead of failing the offer that follows', async () => {
    // The browser sends its offer about a second after the PREPARE that
    // admitted the session, while the cold start that PREPARE began is still
    // running — verifying the signed artifact alone takes seconds on a real
    // node. Declining the offer is reported as `worker_failed`, which ends a
    // session that was seconds away from working.
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-offer-race-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const pipePath = join(temp, 'worker.sock');
    const helpers: net.Socket[] = [];
    const helperBuffers: string[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    cleanup.push(() => { for (const timer of timers) clearTimeout(timer); });
    const launch = vi.fn((_executable: string, argsLine: string) => {
      const args = quotedArgs(argsLine);
      const index = helpers.length;
      helperBuffers.push('');
      // A cold start that takes real time, the way a signed launch does.
      timers.push(setTimeout(() => {
        const helper = net.createConnection(pipePath, () => {
          helper.write(`${JSON.stringify({
            type: REMOTE_DESKTOP_WORKER_HELLO_TYPE,
            ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
            nonce: args[3],
            pid: 80 + index,
          })}\n`);
        });
        helper.setEncoding('utf8');
        helper.on('data', (chunk) => { helperBuffers[index] += String(chunk); });
        helpers.push(helper);
      }, 250));
    });
    const received: RemoteDesktopDaemonMessage[] = [];
    const host = new RemoteDesktopWorkerHost((message) => received.push(message), {
      ...trustedHostOptions,
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
    const offer = {
      type: REMOTE_DESKTOP_MSG.OFFER,
      requestId,
      sessionId,
      capability,
      sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
    } as const;

    // Both in flight together, exactly as they arrive over the link.
    const [prepared, offered] = await Promise.all([
      host.handle(prepare),
      host.handle(offer),
    ]);
    expect(prepared).toBe(true);
    expect(offered).toBe(true);
    expect(received).not.toContainEqual(expect.objectContaining({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
    }));
    await vi.waitFor(() => expect(helperBuffers[0]).toContain('"sdp"'));
    const delivered = helperBuffers[0]!.trim().split('\n').map((line) => JSON.parse(line));
    expect(delivered.map((message) => message.type)).toEqual([
      REMOTE_DESKTOP_MSG.PREPARE,
      REMOTE_DESKTOP_MSG.OFFER,
    ]);
  });

  it('recycles an idle warm worker before every new session', async () => {
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
      reconnectAttempt: 0,
    })).resolves.toBe(true);

    expect(launch).toHaveBeenCalledTimes(2);
    expect(verifyArtifactForLaunch).toHaveBeenCalledTimes(2);
    expect(firstHostSocket.destroyed).toBe(true);
  });

  it('adds a shared virtual display only after an explicit headless result', async () => {
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
      reason: REMOTE_DESKTOP_TERMINAL_REASON.MEDIA_UNAVAILABLE,
    })}\n`);
    await vi.waitFor(() => expect(received).toEqual([
      expect.objectContaining({ reason: REMOTE_DESKTOP_TERMINAL_REASON.MEDIA_UNAVAILABLE }),
    ]));
    expect(launchVirtualDisplay).not.toHaveBeenCalled();
    expect(activateVirtualDisplay).not.toHaveBeenCalled();

    const headlessPrepare = {
      ...prepare,
      requestId: 'request_headless',
      sessionId: 'session_headless',
      capability: 'b'.repeat(43),
    } as const;
    await expect(host.handle(headlessPrepare)).resolves.toBe(true);
    helper!.write(`${JSON.stringify({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      requestId: headlessPrepare.requestId,
      sessionId: headlessPrepare.sessionId,
      capability: headlessPrepare.capability,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.HEADLESS_DISPLAY,
    })}\n`);
    await vi.waitFor(() => {
      expect(helperBuffer.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
        prepare,
        headlessPrepare,
        headlessPrepare,
      ]);
    });
    expect(launchVirtualDisplay).toHaveBeenCalledOnce();
    expect(activateVirtualDisplay).toHaveBeenCalledOnce();
    expect(activateVirtualDisplay).toHaveBeenCalledWith(artifact.executablePath);
    expect(received).toEqual([
      expect.objectContaining({ reason: REMOTE_DESKTOP_TERMINAL_REASON.MEDIA_UNAVAILABLE }),
    ]);

    helper!.write(`${JSON.stringify({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      requestId: headlessPrepare.requestId,
      sessionId: headlessPrepare.sessionId,
      capability: headlessPrepare.capability,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.MEDIA_UNAVAILABLE,
    })}\n`);
    await vi.waitFor(() => expect(received).toEqual([
      expect.objectContaining({ reason: REMOTE_DESKTOP_TERMINAL_REASON.MEDIA_UNAVAILABLE }),
      expect.objectContaining({ reason: REMOTE_DESKTOP_TERMINAL_REASON.MEDIA_UNAVAILABLE }),
    ]));
    expect(controller.stdin.end).toHaveBeenCalledOnce();
  });

  it('terminates an orphaned virtual-display controller after its pipe-close grace period', async () => {
    const controller = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      stdin: { end: ReturnType<typeof vi.fn> };
      kill: ReturnType<typeof vi.fn>;
    };
    controller.exitCode = null;
    controller.stdin = { end: vi.fn() };
    controller.kill = vi.fn(() => {
      controller.exitCode = 1;
      controller.emit('exit', 1);
      return true;
    });
    const host = new RemoteDesktopWorkerHost(() => {}, {
      platform: 'win32',
      artifact,
      virtualDisplayShutdownGraceMs: 0,
    });
    (host as unknown as { virtualDisplayController: typeof controller | null })
      .virtualDisplayController = controller;

    (host as unknown as { stopVirtualDisplayController(): void })
      .stopVirtualDisplayController();
    await vi.waitFor(() => expect(controller.kill).toHaveBeenCalledOnce());
    expect(controller.stdin.end).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight virtual display start when its only session stops', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'imcodes-rd-host-cancel-headless-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const pipePath = join(temp, 'worker.sock');
    let helper: net.Socket | null = null;
    let releaseVirtualVerification: (() => void) | undefined;
    const virtualVerification = new Promise<void>((resolve) => {
      releaseVirtualVerification = resolve;
    });
    let verificationCount = 0;
    const verifyArtifactForLaunch = vi.fn(async () => {
      verificationCount++;
      if (verificationCount > 1) await virtualVerification;
      return artifact;
    });
    const launchVirtualDisplay = vi.fn(() => {
      throw new Error('cancelled virtual display must not launch');
    });
    const activateVirtualDisplay = vi.fn();
    const host = new RemoteDesktopWorkerHost(() => {}, {
      ...trustedHostOptions,
      verifyArtifactForLaunch,
      platform: 'win32',
      artifact,
      pipePath,
      allowPipeClients: () => {},
      launchVirtualDisplay,
      activateVirtualDisplay,
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
      reason: REMOTE_DESKTOP_TERMINAL_REASON.HEADLESS_DISPLAY,
    })}\n`);
    await vi.waitFor(() => expect(verifyArtifactForLaunch).toHaveBeenCalledTimes(2));
    await expect(host.handle({
      type: REMOTE_DESKTOP_MSG.STOP,
      requestId,
      sessionId,
      capability,
    })).resolves.toBe(true);
    releaseVirtualVerification!();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(launchVirtualDisplay).not.toHaveBeenCalled();
    expect(activateVirtualDisplay).not.toHaveBeenCalled();
    expect((host as unknown as {
      virtualDisplayController: unknown;
      virtualDisplayStartPromise: unknown;
    })).toMatchObject({
      virtualDisplayController: null,
      virtualDisplayStartPromise: null,
    });
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
        reason: REMOTE_DESKTOP_TERMINAL_REASON.HEADLESS_DISPLAY,
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
      reason: REMOTE_DESKTOP_TERMINAL_REASON.HEADLESS_DISPLAY,
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
        reason: REMOTE_DESKTOP_TERMINAL_REASON.HEADLESS_DISPLAY,
      }),
    ]));
    expect(launchVirtualDisplay).toHaveBeenCalledOnce();
  });
});
