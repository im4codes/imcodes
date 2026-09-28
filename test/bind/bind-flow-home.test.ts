import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('bind credential state home isolation', () => {
  const originalHome = process.env.IMCODES_HOME;
  const originalDefault = process.env.IMCODES_DEFAULT_HOME;
  const roots: string[] = [];

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.IMCODES_HOME;
    else process.env.IMCODES_HOME = originalHome;
    if (originalDefault === undefined) delete process.env.IMCODES_DEFAULT_HOME;
    else process.env.IMCODES_DEFAULT_HOME = originalDefault;
    vi.resetModules();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('loads credentials from IMCODES_HOME instead of the default ~/.imcodes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-bind-home-'));
    roots.push(root);
    const scoped = join(root, 'scoped', '.imcodes');
    const defaultHome = join(root, 'default', '.imcodes');
    await mkdir(scoped, { recursive: true });
    await mkdir(defaultHome, { recursive: true });
    await writeFile(join(defaultHome, 'server.json'), JSON.stringify({ serverId: 'default', token: 'default', workerUrl: 'https://default' }));
    await writeFile(join(scoped, 'server.json'), JSON.stringify({ serverId: 'scoped', token: 'scoped', workerUrl: 'https://scoped' }));
    process.env.IMCODES_HOME = scoped;
    process.env.IMCODES_DEFAULT_HOME = defaultHome;

    const { loadCredentials } = await import('../../src/bind/bind-flow.js');
    await expect(loadCredentials()).resolves.toMatchObject({ serverId: 'scoped', workerUrl: 'https://scoped' });
  });
});
