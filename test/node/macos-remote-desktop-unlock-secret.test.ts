import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MACOS_REMOTE_DESKTOP_UNLOCK_SECRET_FILE,
  MACOS_REMOTE_DESKTOP_UNLOCK_SECRET_MAX_BYTES,
  createMacosRemoteDesktopUnlockSecretStore,
} from '../../src/node/macos-remote-desktop-unlock-secret.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'imcodes-unlock-store-'));
  roots.push(root);
  return join(root, 'remote-desktop-unlock');
}

describe('macOS sign-in secret store', () => {
  it('stores privately, reveals exactly, and clears', async () => {
    const dir = await directory();
    const store = createMacosRemoteDesktopUnlockSecretStore(dir);
    expect(await store.configured()).toBe(false);
    expect(await store.reveal()).toBeNull();

    const value = 'p@ss "wörd" \\ 密码';
    expect(await store.store(value)).toBe(true);
    expect(await store.configured()).toBe(true);
    expect(await store.reveal()).toBe(value);
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(dir, MACOS_REMOTE_DESKTOP_UNLOCK_SECRET_FILE))).mode & 0o777).toBe(0o600);

    expect(await store.clear()).toBe(true);
    expect(await store.configured()).toBe(false);
  });

  it('refuses values that cannot be a sign-in secret', async () => {
    const store = createMacosRemoteDesktopUnlockSecretStore(await directory());
    expect(await store.store('')).toBe(false);
    expect(await store.store('a\0b')).toBe(false);
    expect(await store.store('x'.repeat(MACOS_REMOTE_DESKTOP_UNLOCK_SECRET_MAX_BYTES + 1))).toBe(false);
    expect(await store.configured()).toBe(false);
  });

  it('never reveals a file others could read or a symlink', async () => {
    const dir = await directory();
    const store = createMacosRemoteDesktopUnlockSecretStore(dir);
    expect(await store.store('hunter2')).toBe(true);
    const file = join(dir, MACOS_REMOTE_DESKTOP_UNLOCK_SECRET_FILE);
    await chmod(file, 0o644);
    expect(await store.reveal()).toBeNull();

    await rm(file);
    const elsewhere = join(dir, '..', 'planted');
    await writeFile(elsewhere, 'planted', { mode: 0o600 });
    await symlink(elsewhere, file);
    expect(await store.reveal()).toBeNull();
    expect(await store.configured()).toBe(false);
  });
});
