import { describe, expect, it, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CONTROLLED_NODE_ENROLL_STDIN_FLAG,
  CONTROLLED_NODE_INSTALL_PAYLOAD_PATH,
  CONTROLLED_NODE_INSTALL_SUBCOMMAND,
  type ControlledNodeInstallPayloadResponse,
} from '../../shared/controlled-node-install.js';
import { REMOTE_DESKTOP_LOGIN_SCREEN_ERROR } from '../../shared/remote-desktop-login-screen.js';
import {
  buildElevatedLoginScreenInnerScript,
  ElevatedLoginScreenInstallError,
  elevateLoginScreenInstaller,
  installLoginScreenControl,
} from '../../src/daemon/remote-desktop-login-screen.js';

const ticket = 'ticket_abcdefghijklmnop';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'imcodes-login-screen-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const credential = {
  serverUrl: 'https://example.test',
  serverId: 'server_1',
  token: 'token_1',
};

function makePayload(
  bytes: Buffer,
  overrides: Partial<ControlledNodeInstallPayloadResponse> = {},
): ControlledNodeInstallPayloadResponse {
  return {
    artifactUrl: 'https://r2.example.test/releases/imcodes-node-win32-x64.exe?X-Amz-Signature=sig',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    abiProfile: 'modern',
    enrollment: {
      serverUrl: 'https://example.test',
      enrollToken: 'enroll_secret_token_123',
      ownerName: 'win-box',
    },
    ...overrides,
  };
}

function twoStepFetch(
  bytes = Buffer.alloc(4096, 7),
  payloadOverrides: Partial<ControlledNodeInstallPayloadResponse> = {},
) {
  const payload = makePayload(bytes, payloadOverrides);
  const mock = vi.fn(async (inputUrl: string | URL, init?: RequestInit) => {
    const url = typeof inputUrl === 'string' ? inputUrl : inputUrl.toString();
    if (url.endsWith(CONTROLLED_NODE_INSTALL_PAYLOAD_PATH)) {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(bytes, { status: 200 });
  });
  return { mock, payload };
}

describe('installLoginScreenControl', () => {
  it('exchanges the ticket via install-payload, downloads from R2 without Authorization, verifies sha256, and elevates with temp 0o600 enrollment file then cleans up', async () => {
    const dir = await root();
    const bytes = Buffer.alloc(4096, 7);
    const { mock: fetchImpl, payload } = twoStepFetch(bytes);
    const elevated: Array<{ executable: string; enrollmentFile: string; enrollJson: string; mode: number }> = [];

    const failure = await installLoginScreenControl({
      ticket,
      root: dir,
      loadCredential: async () => credential,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      elevate: async (executable, enrollmentFile) => {
        const enrollJson = readFileSync(enrollmentFile, 'utf8');
        const mode = statSync(enrollmentFile).mode & 0o777;
        elevated.push({ executable, enrollmentFile, enrollJson, mode });
      },
    });

    expect(failure).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [payloadUrl, payloadInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(payloadUrl).toBe(`https://example.test${CONTROLLED_NODE_INSTALL_PAYLOAD_PATH}`);
    expect(payloadInit.method).toBe('POST');
    expect(payloadInit.redirect).toBe('error');
    expect((payloadInit.headers as Record<string, string>).Authorization).toBe(`Bearer ${ticket}`);

    const [artifactUrl, artifactInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(artifactUrl).toBe(payload.artifactUrl);
    expect(artifactInit.method).toBe('GET');
    expect(artifactInit.redirect).toBe('manual');
    expect(artifactInit.headers).toBeUndefined();

    expect(elevated).toHaveLength(1);
    expect(elevated[0]!.executable).toMatch(new RegExp(`imcodes-node-${payload.sha256.slice(0, 16)}\\.exe$`));
    expect(JSON.parse(elevated[0]!.enrollJson)).toEqual(payload.enrollment);
    if (process.platform !== 'win32') {
      expect(elevated[0]!.mode).toBe(0o600);
    }
    expect(existsSync(elevated[0]!.enrollmentFile)).toBe(false);
    expect(existsSync(elevated[0]!.executable)).toBe(false);
    expect(readdirSync(join(dir, 'login-screen'))).toEqual([]);
  });

  it('uses distinct per-attempt paths and content-hashed executable names across downloads', async () => {
    const dir = await root();
    const elevated: string[] = [];
    const run = (bytes: Buffer) => installLoginScreenControl({
      ticket,
      root: dir,
      loadCredential: async () => credential,
      fetchImpl: twoStepFetch(bytes).mock as unknown as typeof fetch,
      elevate: async (executable) => { elevated.push(executable); },
    });
    expect(await run(Buffer.alloc(4096, 1))).toBeNull();
    expect(await run(Buffer.alloc(4096, 2))).toBeNull();
    expect(new Set(elevated).size).toBe(2);
  });

  it('follows up to 5 HTTPS-only redirects without Authorization and rejects >5 redirects, HTTP downgrade, or credentialed URLs', async () => {
    const bytes = Buffer.alloc(2048, 3);
    const payload = makePayload(bytes, { artifactUrl: 'https://origin.example.test/start.exe' });

    const hopFetch = vi.fn(async (inputUrl: string | URL) => {
      const url = typeof inputUrl === 'string' ? inputUrl : inputUrl.toString();
      if (url.endsWith(CONTROLLED_NODE_INSTALL_PAYLOAD_PATH)) {
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      const match = /\/hop-(\d+)/.exec(url);
      const hop = match ? Number(match[1]) : 0;
      if (url.endsWith('/start.exe')) {
        return new Response(null, { status: 302, headers: { Location: 'https://cdn1.example.test/hop-1' } });
      }
      if (hop > 0 && hop < 5) {
        return new Response(null, { status: 302, headers: { Location: `https://cdn${hop + 1}.example.test/hop-${hop + 1}` } });
      }
      return new Response(bytes, { status: 200 });
    });

    const elevate = vi.fn(async () => {});
    const okResult = await installLoginScreenControl({
      ticket,
      root: await root(),
      loadCredential: async () => credential,
      fetchImpl: hopFetch as unknown as typeof fetch,
      elevate,
    });
    expect(okResult).toBeNull();
    expect(hopFetch).toHaveBeenCalledTimes(7); // 1 payload POST + 1 initial GET + 5 redirects
    expect(elevate).toHaveBeenCalledTimes(1);

    // 6 redirects fails closed without elevating.
    const tooManyFetch = vi.fn(async (inputUrl: string | URL) => {
      const url = typeof inputUrl === 'string' ? inputUrl : inputUrl.toString();
      if (url.endsWith(CONTROLLED_NODE_INSTALL_PAYLOAD_PATH)) {
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      const hop = /\/hop-(\d+)/.exec(url)?.[1];
      const nextHop = hop ? Number(hop) + 1 : 1;
      return new Response(null, { status: 302, headers: { Location: `https://cdn.example.test/hop-${nextHop}` } });
    });
    const elevateTooMany = vi.fn(async () => {});
    expect(await installLoginScreenControl({
      ticket,
      root: await root(),
      loadCredential: async () => credential,
      fetchImpl: tooManyFetch as unknown as typeof fetch,
      elevate: elevateTooMany,
    })).toBe(REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED);
    expect(elevateTooMany).not.toHaveBeenCalled();

    // HTTP downgrade redirect fails closed without elevating.
    const downgradeFetch = vi.fn(async (inputUrl: string | URL) => {
      const url = typeof inputUrl === 'string' ? inputUrl : inputUrl.toString();
      if (url.endsWith(CONTROLLED_NODE_INSTALL_PAYLOAD_PATH)) {
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      return new Response(null, { status: 302, headers: { Location: 'http://insecure.example.test/node.exe' } });
    });
    const elevateDowngrade = vi.fn(async () => {});
    expect(await installLoginScreenControl({
      ticket,
      root: await root(),
      loadCredential: async () => credential,
      fetchImpl: downgradeFetch as unknown as typeof fetch,
      elevate: elevateDowngrade,
    })).toBe(REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED);
    expect(elevateDowngrade).not.toHaveBeenCalled();

    // Credential-bearing URL is refused without even fetching artifactUrl.
    const credPayloadFetch = twoStepFetch(bytes, {
      artifactUrl: 'https://user:secret@r2.example.test/imcodes-node.exe',
    }).mock;
    const elevateCred = vi.fn(async () => {});
    expect(await installLoginScreenControl({
      ticket,
      root: await root(),
      loadCredential: async () => credential,
      fetchImpl: credPayloadFetch as unknown as typeof fetch,
      elevate: elevateCred,
    })).toBe(REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED);
    expect(credPayloadFetch).toHaveBeenCalledTimes(1);
    expect(elevateCred).not.toHaveBeenCalled();
  });

  it('rejects non-HTTPS artifactUrl when server is HTTPS, sha256 mismatch, size mismatch, and invalid payloads without elevating', async () => {
    const bytes = Buffer.alloc(2048, 5);
    const cases: Array<() => typeof fetch> = [
      () => twoStepFetch(bytes, { artifactUrl: 'http://plain.example.test/imcodes-node.exe' }).mock as unknown as typeof fetch,
      () => twoStepFetch(bytes, { sha256: '0'.repeat(64) }).mock as unknown as typeof fetch,
      () => twoStepFetch(bytes, { sizeBytes: bytes.length + 100 }).mock as unknown as typeof fetch,
      () => twoStepFetch(Buffer.alloc(0), { sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'), sizeBytes: 0 }).mock as unknown as typeof fetch,
      () => (async () => new Response(JSON.stringify({ ok: false }), { status: 200 })) as unknown as typeof fetch,
      () => (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch,
    ];

    for (const makeFetch of cases) {
      const elevate = vi.fn(async () => {});
      const failure = await installLoginScreenControl({
        ticket,
        root: await root(),
        loadCredential: async () => credential,
        fetchImpl: makeFetch(),
        elevate,
      });
      expect(failure).toBe(REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED);
      expect(elevate).not.toHaveBeenCalled();
    }
  });

  it('reports an unbound daemon rather than guessing a server', async () => {
    const fetchImpl = twoStepFetch().mock;
    const failure = await installLoginScreenControl({
      ticket,
      root: await root(),
      loadCredential: async () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      elevate: async () => {},
    });
    expect(failure).toBe(REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.NOT_BOUND);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('distinguishes UAC declined from elevated installer non-zero exit and always removes enrollment.json', async () => {
    const dir = await root();
    let seenEnrollPath = '';
    const declined = await installLoginScreenControl({
      ticket,
      root: dir,
      loadCredential: async () => credential,
      fetchImpl: twoStepFetch().mock as unknown as typeof fetch,
      elevate: async (_exe, enrollPath) => {
        seenEnrollPath = enrollPath;
        throw new Error('The operation was canceled by the user');
      },
    });
    expect(declined).toBe(REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.ELEVATION_DECLINED);
    expect(existsSync(seenEnrollPath)).toBe(false);
    expect(readdirSync(join(dir, 'login-screen'))).toEqual([]);

    const dir2 = await root();
    let seenEnrollPath2 = '';
    const failedInstall = await installLoginScreenControl({
      ticket,
      root: dir2,
      loadCredential: async () => credential,
      fetchImpl: twoStepFetch().mock as unknown as typeof fetch,
      elevate: async (_exe, enrollPath) => {
        seenEnrollPath2 = enrollPath;
        throw new ElevatedLoginScreenInstallError(2);
      },
    });
    expect(failedInstall).toBe(REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.INSTALL_FAILED);
    expect(existsSync(seenEnrollPath2)).toBe(false);
    expect(readdirSync(join(dir2, 'login-screen'))).toEqual([]);
  });

  it('announces the download and the wait for approval, in that order', async () => {
    const states: string[] = [];
    await installLoginScreenControl({
      ticket,
      root: await root(),
      loadCredential: async () => credential,
      fetchImpl: twoStepFetch().mock as unknown as typeof fetch,
      elevate: async () => {},
      onState: (state) => states.push(state),
    });
    expect(states).toEqual(['downloading', 'elevating']);
  });
});

describe('elevateLoginScreenInstaller', () => {
  it('escapes Windows paths with spaces and single quotes, sets UTF-8 no-BOM, invokes install --enroll-stdin, and maps exit code failures', async () => {
    const exe = "C:\\Users\\O'Connor\\Local App\\imcodes-node.exe";
    const enroll = "C:\\Users\\O'Connor\\Local App\\enrollment.json";

    const inner = buildElevatedLoginScreenInnerScript(exe, enroll);
    expect(inner).toContain('New-Object System.Text.UTF8Encoding($false)');
    expect(inner).toContain('$OutputEncoding = $utf8NoBom');
    expect(inner).toContain('[Console]::OutputEncoding = $utf8NoBom');
    expect(inner).toContain("ReadAllText('C:\\Users\\O''Connor\\Local App\\enrollment.json', $utf8NoBom)");
    expect(inner).toContain(`& 'C:\\Users\\O''Connor\\Local App\\imcodes-node.exe' ${CONTROLLED_NODE_INSTALL_SUBCOMMAND} ${CONTROLLED_NODE_ENROLL_STDIN_FLAG}`);
    expect(inner).toContain('exit $LASTEXITCODE');

    const invocations: Array<{ file: string; args: readonly string[] }> = [];
    await elevateLoginScreenInstaller(exe, enroll, async (file, args) => {
      invocations.push({ file, args });
    });
    expect(invocations).toHaveLength(1);
    const cmd = invocations[0]!.args[invocations[0]!.args.length - 1]!;
    expect(cmd).toContain('-Verb RunAs -Wait -PassThru');
    const encodedMatch = /-EncodedCommand',\s*'([A-Za-z0-9+/=]+)'/.exec(cmd);
    expect(encodedMatch).not.toBeNull();
    const decoded = Buffer.from(encodedMatch![1]!, 'base64').toString('utf16le');
    expect(decoded).toBe(inner);

    await expect(
      elevateLoginScreenInstaller(exe, enroll, async () => {
        throw new Error('elevated install exited 1');
      }),
    ).rejects.toBeInstanceOf(ElevatedLoginScreenInstallError);
  });
});
