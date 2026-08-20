import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  REMOTE_DESKTOP_ELEVATED_SERVICE,
  elevatedRemoteDesktopRoot,
  installElevatedRemoteDesktopHost,
  readElevatedRemoteDesktopConfig,
  readElevatedRemoteDesktopSecret,
} from '../../src/node/remote-desktop-elevated-install.js';

const userSid = 'S-1-5-21-1-2-3-1001';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function stagedSources() {
  const dir = await mkdtemp(join(tmpdir(), 'imcodes-rd-elevated-install-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const sourceExecutable = join(dir, 'imcodes-node.exe');
  await writeFile(sourceExecutable, 'MZ-signed-runtime');
  const sourceWorkerDirectory = join(dir, 'worker');
  await mkdir(sourceWorkerDirectory, { recursive: true });
  await writeFile(join(sourceWorkerDirectory, 'imcodes-remote-desktop-worker.exe'), 'MZ-worker');
  await writeFile(join(sourceWorkerDirectory, 'imcodes-virtual-display.zip'), 'PK-archive');
  return { dir, sourceExecutable, sourceWorkerDirectory, root: join(dir, 'root') };
}

function install(overrides: Record<string, unknown> = {}) {
  const commands: Array<{ file: string; args: readonly string[] }> = [];
  const acls: string[][] = [];
  return {
    commands,
    acls,
    run: (input: Record<string, unknown>) => installElevatedRemoteDesktopHost({
      userSid,
      assertElevated: () => {},
      verifySigners: async () => true,
      trustedSignerSha256: 'a'.repeat(64),
      runCommand: (file, args) => { commands.push({ file, args }); },
      applyAcl: (entries) => { for (const entry of entries) acls.push([...entry]); },
      ...input,
      ...overrides,
    } as never),
  };
}

describe('installElevatedRemoteDesktopHost', () => {
  it('refuses to install without elevation', async () => {
    const sources = await stagedSources();
    const harness = install({
      assertElevated: () => { throw new Error('requires Administrator'); },
    });
    await expect(harness.run({ ...sources })).rejects.toThrow(/Administrator/);
    // Nothing may be staged by a failed attempt.
    expect(existsSync(sources.root)).toBe(false);
    expect(harness.commands).toHaveLength(0);
  });

  it('copies the runtime and worker out of the user directory before registering', async () => {
    const sources = await stagedSources();
    const harness = install();
    const result = await harness.run({ ...sources });

    expect(existsSync(join(result.root, REMOTE_DESKTOP_ELEVATED_SERVICE.EXECUTABLE))).toBe(true);
    expect(existsSync(join(
      result.root, 'remote-desktop-worker', 'win32-x64', 'imcodes-remote-desktop-worker.exe',
    ))).toBe(true);
    // The whole bundle has to come across, not just the executable: the worker
    // verifies its own directory contents exactly.
    expect(existsSync(join(
      result.root, 'remote-desktop-worker', 'win32-x64', 'imcodes-virtual-display.zip',
    ))).toBe(true);

    const registerIndex = harness.commands.findIndex((command) => command.args.includes('/Create'));
    const copiedExecutable = harness.acls.findIndex((entry) => (
      entry[0]?.endsWith(REMOTE_DESKTOP_ELEVATED_SERVICE.EXECUTABLE) ?? false
    ));
    expect(registerIndex).toBeGreaterThanOrEqual(0);
    expect(copiedExecutable).toBeGreaterThanOrEqual(0);
  });

  it('registers a SYSTEM task that runs the host flag, and starts it', async () => {
    const sources = await stagedSources();
    const harness = install();
    const result = await harness.run({ ...sources });

    const create = harness.commands.find((command) => command.args.includes('/Create'))!;
    expect(create.file).toBe('schtasks');
    expect(create.args).toContain(REMOTE_DESKTOP_ELEVATED_SERVICE.WINDOWS_TASK);
    const taskXml = readFileSync(join(result.root, 'task.xml'), 'utf16le');
    expect(taskXml).toContain('<UserId>S-1-5-18</UserId>');
    expect(taskXml).toContain(REMOTE_DESKTOP_ELEVATED_SERVICE.HOST_FLAG);
    // The flag is fixed by the registration, never supplied by a caller later.
    expect(taskXml).not.toContain(REMOTE_DESKTOP_ELEVATED_SERVICE.INSTALL_FLAG);
    expect(harness.commands.at(-1)).toMatchObject({
      file: 'schtasks',
      args: ['/Run', '/TN', REMOTE_DESKTOP_ELEVATED_SERVICE.WINDOWS_TASK],
    });
  });

  it('grants the enabling user read on the secret, and nobody else write on the root', async () => {
    const sources = await stagedSources();
    const harness = install();
    const result = await harness.run({ ...sources });

    const secret = readElevatedRemoteDesktopSecret(result.root);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readElevatedRemoteDesktopConfig(result.root)).toEqual({ userSid });

    const secretAcls = harness.acls.filter((entry) => (
      entry[0]?.endsWith(REMOTE_DESKTOP_ELEVATED_SERVICE.SECRET_FILE) ?? false
    ));
    expect(secretAcls).toEqual(expect.arrayContaining([
      [expect.any(String), '/grant:r', `*${userSid}:R`],
      [expect.any(String), '/inheritance:r'],
      [expect.any(String), '/setowner', '*S-1-5-18'],
    ]));
    // Read, never write: the account being served must not be able to change
    // what authenticates it.
    expect(secretAcls.some((entry) => entry[2] === `*${userSid}:F`)).toBe(false);
  });

  it('refuses to register anything the Authenticode check rejects', async () => {
    const sources = await stagedSources();
    const harness = install({ verifySigners: async () => false });
    await expect(harness.run({ ...sources })).rejects.toThrow(/authenticity_failed/);
    // A rejected bundle must not be left staged, and no task may be registered.
    expect(existsSync(sources.root)).toBe(false);
    expect(harness.commands).toHaveLength(0);
  });

  it('reports nothing installed when the root is absent', () => {
    expect(readElevatedRemoteDesktopSecret(join(tmpdir(), 'imcodes-absent-root'))).toBe('');
    expect(readElevatedRemoteDesktopConfig(join(tmpdir(), 'imcodes-absent-root'))).toBeNull();
  });

  it('keeps the privileged root out of any per-user directory', () => {
    expect(elevatedRemoteDesktopRoot('D:\\ProgramData')).toBe(
      join('D:\\ProgramData', 'imcodes', 'remote-desktop-elevated'),
    );
  });
});
