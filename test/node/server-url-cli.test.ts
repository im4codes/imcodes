import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTROLLED_NODE_ENDPOINTS_FILE } from '../../shared/controlled-node-endpoints.js';
import { readEndpointState } from '../../src/node/server-endpoints.js';
import { SERVER_URL_CLI_USAGE, runServerUrlCommand } from '../../src/node/server-url-cli.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function run(args: string[], options: { elevated?: boolean; path?: string } = {}) {
  const path = options.path ?? join(await mkdtemp(join(tmpdir(), 'imcodes-server-url-')), CONTROLLED_NODE_ENDPOINTS_FILE);
  dirs.push(join(path, '..'));
  let out = '';
  let err = '';
  const code = await runServerUrlCommand(args, {
    isElevated: () => options.elevated ?? true,
    endpointsPath: path,
    stdout: (text) => { out += text; },
    stderr: (text) => { err += text; },
  });
  return { code, out, err, path };
}

describe('imcodes-node set-server-url', () => {
  it('adds an https origin as an alternate address, idempotently', async () => {
    const first = await run(['https://im-proxy.koca.win']);
    expect(first.code).toBe(0);
    expect(first.out).toContain('https://im-proxy.koca.win');
    expect((await readEndpointState(first.path)).pinned).toEqual(['https://im-proxy.koca.win']);
    const again = await run(['https://im-proxy.koca.win/'], { path: first.path });
    expect(again.code).toBe(0);
    expect((await readEndpointState(first.path)).pinned).toEqual(['https://im-proxy.koca.win']);
  });

  it('refuses every write without Administrator/root, and writes nothing', async () => {
    const result = await run(['https://im-proxy.koca.win'], { elevated: false });
    expect(result.code).toBe(1);
    expect(result.err).toContain('Administrator/root');
    expect((await readEndpointState(result.path)).pinned).toEqual([]);
    for (const args of [['--clear'], ['--remove', 'https://x.example']]) {
      expect((await run(args, { elevated: false })).code).toBe(1);
    }
  });

  it.each([
    ['http://evil.example'], ['https://user:pw@x.example'], ['https://x.example/path'], ['ftp://x.example'], ['not a url'],
  ])('rejects %s with a plain message and writes nothing', async (value) => {
    const result = await run([value]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('plain https origin');
    expect((await readEndpointState(result.path)).pinned).toEqual([]);
  });

  it('removes, clears and lists (listing needs no privilege)', async () => {
    const added = await run(['https://a.example']);
    await run(['https://b.example'], { path: added.path });
    expect((await run(['--list'], { path: added.path, elevated: false })).out).toContain('https://a.example, https://b.example');
    await run(['--remove', 'https://a.example'], { path: added.path });
    expect((await readEndpointState(added.path)).pinned).toEqual(['https://b.example']);
    await run(['--clear'], { path: added.path });
    expect((await readEndpointState(added.path)).pinned).toEqual([]);
  });

  it('prints usage for no arguments and for nonsense, without touching the file', async () => {
    const none = await run([]);
    expect(none.code).toBe(2);
    expect(none.out).toBe(`${SERVER_URL_CLI_USAGE}\n`);
    const nonsense = await run(['--bogus', 'x']);
    expect(nonsense.code).toBe(2);
    expect(nonsense.err).toContain('usage:');
    expect((await readEndpointState(nonsense.path)).pinned).toEqual([]);
  });
});
