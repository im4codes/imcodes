import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  elevatedPipeAclCommand,
  runElevatedRemoteDesktopHost,
} from '../../src/node/remote-desktop-elevated-runtime.js';
import { REMOTE_DESKTOP_ELEVATED_SERVICE } from '../../src/node/remote-desktop-elevated-install.js';

const userSid = 'S-1-5-21-9-9-9-1001';
const secret = 'a'.repeat(43);
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function stagedRoot(options: { secret?: string; config?: unknown } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'imcodes-rd-elevated-runtime-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  if (options.secret !== undefined) {
    await writeFile(join(dir, REMOTE_DESKTOP_ELEVATED_SERVICE.SECRET_FILE), options.secret);
  }
  if (options.config !== undefined) {
    await writeFile(
      join(dir, REMOTE_DESKTOP_ELEVATED_SERVICE.CONFIG_FILE),
      JSON.stringify(options.config),
    );
  }
  await mkdir(join(dir, 'remote-desktop-worker', 'win32-x64'), { recursive: true });
  return dir;
}

describe('runElevatedRemoteDesktopHost', () => {
  it('refuses to run when nothing was staged for it', async () => {
    const root = await stagedRoot();
    await expect(runElevatedRemoteDesktopHost({ root })).rejects.toThrow(/not_installed/);
  });

  it('refuses to run with a secret but no served account', async () => {
    const root = await stagedRoot({ secret });
    await expect(runElevatedRemoteDesktopHost({ root })).rejects.toThrow(/not_installed/);
  });

  it('serves the staged account and restricts the pipe to it', async () => {
    const root = await stagedRoot({ secret, config: { userSid } });
    const restricted: string[] = [];
    const worker = { handle: vi.fn(async () => true), close: vi.fn() };
    const host = await runElevatedRemoteDesktopHost({
      root,
      restrictPipe: (pipePath) => { restricted.push(pipePath); },
      createWorkerHost: () => worker as never,
    });
    cleanup.push(() => host.close());
    expect(restricted).toHaveLength(1);
  });

  it('points the worker at the staged bundle, never at a user directory', async () => {
    const root = await stagedRoot({ secret, config: { userSid } });
    const paths: string[] = [];
    const host = await runElevatedRemoteDesktopHost({
      root,
      restrictPipe: () => {},
      createWorkerHost: (executablePath) => {
        paths.push(executablePath);
        return { handle: vi.fn(async () => true), close: vi.fn() } as never;
      },
    });
    cleanup.push(() => host.close());
    expect(paths).toEqual([
      join(root, 'remote-desktop-worker', 'win32-x64', 'imcodes-remote-desktop-worker.exe'),
    ]);
  });

  it('grants the pipe to SYSTEM and the served account only', () => {
    const command = elevatedPipeAclCommand('\\\\.\\pipe\\imcodes-remote-desktop-elevated', userSid);
    expect(command).toEqual([
      '\\\\.\\pipe\\imcodes-remote-desktop-elevated',
      '/grant:r', '*S-1-5-18:F',
      '/grant:r', `*${userSid}:RW`,
    ]);
    // `/grant:r` replaces rather than adds: no inherited ACE may survive and let
    // another account drive a LocalSystem worker.
    expect(command).not.toContain('/grant');
    expect(command.join(' ')).not.toContain('S-1-5-11');
  });
});
