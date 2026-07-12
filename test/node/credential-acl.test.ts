import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, chmod, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistCredential, loadCredential } from '../../src/node/enrollment.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';

const cred = { serverId: 's1', token: 't1', serverUrl: 'https://im.example', nodeRole: NODE_ROLE.CONTROLLED } as const;
const isWin = process.platform === 'win32';

describe.skipIf(isWin)('controlled credential ACL (10.10, POSIX)', () => {
  let dir: string;
  let path: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'imcodes-cred-')); path = join(dir, 'nested', 'credential.json'); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('persists with 0600 file + 0700 dir and loads back', async () => {
    await persistCredential(cred, path);
    const fileMode = (await stat(path)).mode & 0o777;
    expect(fileMode & 0o077).toBe(0); // no group/world bits
    const loaded = await loadCredential(path);
    expect(loaded).toMatchObject({ serverId: 's1', nodeRole: NODE_ROLE.CONTROLLED });
  });

  it('refuses to load a group/world-readable credential', async () => {
    await persistCredential(cred, path);
    await chmod(path, 0o644); // world-readable
    expect(await loadCredential(path)).toBeNull();
  });

  it('refuses to load a symlinked credential', async () => {
    const real = join(dir, 'real.json');
    await writeFile(real, JSON.stringify(cred), { mode: 0o600 });
    const link = join(dir, 'link.json');
    await symlink(real, link);
    expect(await loadCredential(link)).toBeNull();
  });

  it('refuses to persist over a pre-existing symlink', async () => {
    const real = join(dir, 'real2.json');
    await writeFile(real, '{}', { mode: 0o600 });
    const link = join(dir, 'link2.json');
    await symlink(real, link);
    await expect(persistCredential(cred, link)).rejects.toThrow(/symlink/);
  });
});
