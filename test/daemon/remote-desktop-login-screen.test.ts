import { describe, expect, it, vi, afterEach } from 'vitest';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REMOTE_DESKTOP_LOGIN_SCREEN_ERROR } from '../../shared/remote-desktop-login-screen.js';
import { installLoginScreenControl } from '../../src/daemon/remote-desktop-login-screen.js';

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

function installer(bytes = Buffer.alloc(4096, 7)) {
  return vi.fn(async () => new Response(bytes, { status: 200 }));
}

describe('installLoginScreenControl', () => {
  it('fetches the installer the ticket personalises, then elevates it', async () => {
    const dir = await root();
    const fetchImpl = installer();
    const elevated: string[] = [];
    const failure = await installLoginScreenControl({
      ticket,
      root: dir,
      loadCredential: async () => ({
        serverUrl: 'https://example.test',
        serverId: 'server_1',
        token: 'token_1',
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      elevate: async (executable) => { elevated.push(executable); },
    });

    expect(failure).toBeNull();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.test/api/enroll/v2/download');
    // The ticket is the whole authorisation: it is what personalises the
    // executable with an enrolment blob.
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ticket}`);
    expect(elevated).toHaveLength(1);
    expect(readdirSync(join(dir, 'login-screen'))).toEqual([
      expect.stringMatching(/^imcodes-node-[0-9a-f]{16}\.exe$/),
    ]);
  });

  it('names the download by content so a retry cannot elevate a stale one', async () => {
    const dir = await root();
    const elevated: string[] = [];
    const run = (bytes: Buffer) => installLoginScreenControl({
      ticket,
      root: dir,
      loadCredential: async () => ({
        serverUrl: 'https://example.test', serverId: 's', token: 't',
      }),
      fetchImpl: installer(bytes) as unknown as typeof fetch,
      elevate: async (executable) => { elevated.push(executable); },
    });
    await run(Buffer.alloc(4096, 1));
    await run(Buffer.alloc(4096, 2));
    expect(new Set(elevated).size).toBe(2);
  });

  it('reports an unbound daemon rather than guessing a server', async () => {
    const fetchImpl = installer();
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

  it('reports a rejected ticket without elevating anything', async () => {
    const elevate = vi.fn(async () => {});
    const failure = await installLoginScreenControl({
      ticket,
      root: await root(),
      loadCredential: async () => ({
        serverUrl: 'https://example.test', serverId: 's', token: 't',
      }),
      fetchImpl: (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch,
      elevate,
    });
    expect(failure).toBe(REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED);
    expect(elevate).not.toHaveBeenCalled();
  });

  it('refuses to elevate a body too small to be an installer', async () => {
    const elevate = vi.fn(async () => {});
    const failure = await installLoginScreenControl({
      ticket,
      root: await root(),
      loadCredential: async () => ({
        serverUrl: 'https://example.test', serverId: 's', token: 't',
      }),
      fetchImpl: installer(Buffer.alloc(16)) as unknown as typeof fetch,
      elevate,
    });
    expect(failure).toBe(REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED);
    expect(elevate).not.toHaveBeenCalled();
  });

  it('reports a dismissed prompt as declined', async () => {
    const failure = await installLoginScreenControl({
      ticket,
      root: await root(),
      loadCredential: async () => ({
        serverUrl: 'https://example.test', serverId: 's', token: 't',
      }),
      fetchImpl: installer() as unknown as typeof fetch,
      elevate: async () => { throw new Error('The operation was canceled by the user'); },
    });
    expect(failure).toBe(REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.ELEVATION_DECLINED);
  });

  it('announces the download and the wait for approval, in that order', async () => {
    const states: string[] = [];
    await installLoginScreenControl({
      ticket,
      root: await root(),
      loadCredential: async () => ({
        serverUrl: 'https://example.test', serverId: 's', token: 't',
      }),
      fetchImpl: installer() as unknown as typeof fetch,
      elevate: async () => {},
      onState: (state) => states.push(state),
    });
    expect(states).toEqual(['downloading', 'elevating']);
  });
});
