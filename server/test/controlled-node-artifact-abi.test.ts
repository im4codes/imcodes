import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactCatalog } from '../src/services/controlled-node-artifact-catalog.js';
import { CONTROLLED_NODE_ABI_GLIBC217, CONTROLLED_NODE_ABI_MODERN, CONTROLLED_NODE_ABI_PROFILES } from '../../shared/controlled-node-abi.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'imcodes-test-artifact-abi-'));
  dirs.push(dir);
  const catalog = new ArtifactCatalog();
  const pin = CONTROLLED_NODE_ABI_PROFILES.GLIBC217;
  const compat = {
    schemaVersion: 1,
    artifact: { os: 'linux', arch: 'x64', abiProfile: CONTROLLED_NODE_ABI_GLIBC217, fileName: pin.fileName,
      size: 6, sha256: createHash('sha256').update('compat').digest('hex') },
    build: { version: '2026.10.1' },
    toolchain: { nodeProvider: pin.provider, nodeVersion: pin.nodeVersion, nodeArchive: pin.nodeArchive,
      nodeArchiveSha256: pin.nodeArchiveSha256, nodeBinarySha256: pin.nodeBinarySha256, seaBlobSha256: 'c'.repeat(64) },
  };
  const modern = { schemaVersion: 1,
    artifact: { os: 'linux', arch: 'x64', fileName: 'imcodes-node-linux', size: 6, sha256: createHash('sha256').update('modern').digest('hex') },
    build: { version: '2026.10.1' },
  };
  const save = async () => {
    await writeFile(join(dir, pin.fileName), 'compat');
    await writeFile(join(dir, `${pin.fileName}.manifest.json`), JSON.stringify(compat));
    await writeFile(join(dir, 'imcodes-node-linux'), 'modern');
    await writeFile(join(dir, 'imcodes-node-linux.manifest.json'), JSON.stringify(modern));
  };
  await save();
  return { dir, catalog, compat, modern, save };
}
describe('ABI-partitioned artifact catalog', () => {
  it('keeps same-version variants distinct under concurrent cached lookup and invalidation', async () => {
    const { dir, catalog } = await fixture();
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => catalog.ensureVerified(dir, 'linux', 'x64',
      index % 2 ? CONTROLLED_NODE_ABI_GLIBC217 : CONTROLLED_NODE_ABI_MODERN)));
    for (let index = 0; index < results.length; index++) {
      expect(results[index]).toMatchObject({ ok: true, descriptor: { filename: index % 2 ? CONTROLLED_NODE_ABI_PROFILES.GLIBC217.fileName : 'imcodes-node-linux' } });
    }
    catalog.invalidate(dir, 'linux', 'x64', CONTROLLED_NODE_ABI_GLIBC217);
    expect(await catalog.listAvailable(dir)).toHaveLength(2);
    expect(await catalog.ensureVerified(dir, 'linux', 'arm64', CONTROLLED_NODE_ABI_GLIBC217)).toMatchObject({ ok: false });
  });
  it.each(['nodeProvider', 'nodeVersion', 'nodeArchive', 'nodeArchiveSha256', 'nodeBinarySha256', 'seaBlobSha256'] as const)
  ('rejects unpinned compat %s without affecting official modern', async (field) => {
    const { dir, catalog, compat, save } = await fixture();
    compat.toolchain[field] = 'untrusted';
    await save();
    expect(await catalog.ensureVerified(dir, 'linux', 'x64', CONTROLLED_NODE_ABI_GLIBC217)).toMatchObject({ ok: false });
    expect(await catalog.ensureVerified(dir, 'linux', 'x64')).toMatchObject({ ok: true });
  });
  it.each([undefined, null, 'unknown', CONTROLLED_NODE_ABI_MODERN])('refuses mislabeled compat manifest %j', async (abiProfile) => {
    const { dir, catalog, compat, save } = await fixture();
    Object.assign(compat.artifact, { abiProfile });
    await save();
    expect(await catalog.ensureVerified(dir, 'linux', 'x64', CONTROLLED_NODE_ABI_GLIBC217)).toMatchObject({ ok: false });
  });
  it('never substitutes a modern package with a compatibility manifest or mismatched bytes', async () => {
    const { dir, catalog, modern, save } = await fixture();
    Object.assign(modern.artifact, { abiProfile: CONTROLLED_NODE_ABI_GLIBC217 });
    await save();
    expect(await catalog.ensureVerified(dir, 'linux', 'x64')).toMatchObject({ ok: false });
    await writeFile(join(dir, CONTROLLED_NODE_ABI_PROFILES.GLIBC217.fileName), 'broken');
    expect(await catalog.ensureVerified(dir, 'linux', 'x64', CONTROLLED_NODE_ABI_GLIBC217)).toMatchObject({ ok: false, reason: 'mismatch' });
  });
});
