/** The node's side of the aidesk-local-ui asset route: what it asks for, what it refuses, what it leaves on disk. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTROLLED_NODE_ARTIFACT_HEADERS } from '../../shared/controlled-node-artifacts.js';
import { downloadControlledNodeAideskLocalUiFile } from '../../src/node/self-upgrade.js';

const temps: string[] = [];
const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'aidesk-dl-')); temps.push(dir); return dir; };
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const credential = { serverId: 'srv', token: 'tok', serverUrl: 'https://example.test' };
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function respond(bytes: Buffer, over: Record<string, string> = {}, status = 200): typeof fetch {
  return (async () => new Response(status === 200 ? new Uint8Array(bytes) : null, {
    status,
    headers: {
      [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: sha(bytes),
      [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(bytes.length),
      [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'aidesk-local-ui.exe',
      ...over,
    },
  })) as unknown as typeof fetch;
}

const base = (dir: string, fetchImpl: typeof fetch, over: Partial<Parameters<typeof downloadControlledNodeAideskLocalUiFile>[0]> = {}) => ({
  credential, dir, fetchImpl, asset: 'aidesk-local-ui' as const, expectedFileName: 'aidesk-local-ui.exe', maxBytes: 1024, ...over,
});

describe('downloadControlledNodeAideskLocalUiFile', () => {
  it('asks for exactly the named asset of the Windows x64 target with the node\'s token, and leaves only the file (no generic .manifest.json)', async () => {
    const bytes = Buffer.from('MZ-host');
    let requested = '';
    let authorization = '';
    const dir = temp();
    const result = await downloadControlledNodeAideskLocalUiFile(base(dir, (async (url: string, init?: RequestInit) => {
      requested = String(url);
      authorization = String((init?.headers as Record<string, string>).Authorization);
      return respond(bytes)(url, init);
    }) as unknown as typeof fetch));
    const url = new URL(requested);
    expect(url.pathname).toBe('/api/enroll/v2/node-artifact');
    expect(Object.fromEntries(url.searchParams)).toEqual({ serverId: 'srv', os: 'win', arch: 'x64', asset: 'aidesk-local-ui' });
    expect(authorization).toBe('Bearer tok');
    expect(result).toMatchObject({ sha256: sha(bytes), sizeBytes: bytes.length });
    expect(readdirSync(dir)).toEqual(['aidesk-local-ui.exe']);
    expect(readFileSync(join(dir, 'aidesk-local-ui.exe'))).toEqual(bytes);
  });

  it('treats 400 (a server that does not know the asset), 404 and 503 as "not published" and anything else as an error', async () => {
    for (const status of [400, 404, 503]) {
      expect(await downloadControlledNodeAideskLocalUiFile(base(temp(), respond(Buffer.alloc(0), {}, status))), String(status)).toBeUndefined();
    }
    await expect(downloadControlledNodeAideskLocalUiFile(base(temp(), respond(Buffer.alloc(0), {}, 500)))).rejects.toThrow(/download_failed_500/u);
    await expect(downloadControlledNodeAideskLocalUiFile(base(temp(), respond(Buffer.alloc(0), {}, 401)))).rejects.toThrow(/download_failed_401/u);
  });

  it('refuses a wrong file name, a missing or oversize declared size, a hash that is not the bytes\' and a body longer than declared; nothing lands', async () => {
    const bytes = Buffer.from('MZ-host');
    const cases: Array<[string, typeof fetch, RegExp, number?]> = [
      ['file name', respond(bytes, { [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'evil.exe' }), /artifact_filename_mismatch/u],
      ['no declared size', respond(bytes, { [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: '' }), /artifact_too_large/u],
      ['oversize', respond(bytes), /artifact_too_large/u, 3],
      ['hash', respond(bytes, { [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: 'ab'.repeat(32) }), /artifact_sha256_mismatch/u],
      ['longer than declared', respond(bytes, { [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: '3' }), /artifact_size_mismatch/u],
    ];
    for (const [label, fetchImpl, message, maxBytes] of cases) {
      const dir = temp();
      await expect(downloadControlledNodeAideskLocalUiFile(base(dir, fetchImpl, maxBytes ? { maxBytes } : {})), label).rejects.toThrow(message);
      expect(readdirSync(dir), label).toEqual([]);
    }
  });
});
