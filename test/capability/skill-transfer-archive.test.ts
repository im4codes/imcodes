import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SKILL_TRANSFER_ARCHIVE_TESTING,
  buildSkillTransferArchive,
  extractSkillTransferArchive,
} from '../../src/capability/skill-transfer-archive.js';

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('deterministic managed Skill transfer archive', () => {
  const temporary: string[] = [];
  afterEach(async () => {
    await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('builds byte-identical archives and restores exact content, executable bits, and tree digest', async () => {
    const source = await mkdtemp(join(tmpdir(), 'imcodes-transfer-source-'));
    const parent = await mkdtemp(join(tmpdir(), 'imcodes-transfer-target-'));
    const destination = join(parent, 'package');
    temporary.push(source, parent);
    await mkdir(join(source, 'scripts'));
    await writeFile(join(source, 'SKILL.md'), '---\nname: transfer-skill\ndescription: Transfer Skill.\n---\nVerified instructions.\n');
    await writeFile(join(source, 'scripts', 'check.sh'), '#!/bin/sh\nexit 0\n');
    await chmod(join(source, 'scripts', 'check.sh'), 0o700);

    const first = buildSkillTransferArchive(source);
    const second = buildSkillTransferArchive(source, first.treeDigest);
    expect(second.bytes.equals(first.bytes)).toBe(true);
    expect(second).toMatchObject({
      blobDigest: first.blobDigest,
      blobByteSize: first.bytes.length,
      treeDigest: first.treeDigest,
    });
    extractSkillTransferArchive({
      bytes: first.bytes,
      blobDigest: first.blobDigest,
      treeDigest: first.treeDigest,
      destination,
    });
    expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toContain('Verified instructions.');
    await expect(stat(join(destination, 'scripts', 'check.sh'))
      .then((value) => (value.mode & 0o111) !== 0)).resolves.toBe(true);
    expect(buildSkillTransferArchive(destination).treeDigest).toBe(first.treeDigest);
  });

  it('rejects changed transfer bytes, wrong tree authority, traversal entries, and source links', async () => {
    const source = await mkdtemp(join(tmpdir(), 'imcodes-transfer-source-'));
    const parent = await mkdtemp(join(tmpdir(), 'imcodes-transfer-target-'));
    temporary.push(source, parent);
    await writeFile(join(source, 'SKILL.md'), '---\nname: transfer-skill\ndescription: Transfer Skill.\n---\nBody.\n');
    const archive = buildSkillTransferArchive(source);
    const tampered = Buffer.from(archive.bytes);
    tampered[tampered.length - 1] ^= 1;
    expect(() => extractSkillTransferArchive({
      bytes: tampered, blobDigest: archive.blobDigest, treeDigest: archive.treeDigest,
      destination: join(parent, 'tampered'),
    })).toThrowError(expect.objectContaining({ code: 'blob_digest_mismatch' }));
    expect(() => extractSkillTransferArchive({
      bytes: archive.bytes, blobDigest: archive.blobDigest, treeDigest: '0'.repeat(64),
      destination: join(parent, 'wrong-tree'),
    })).toThrowError(expect.objectContaining({ code: 'tree_digest_mismatch' }));

    const file = Buffer.from('x');
    const header = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      treeDigest: '1'.repeat(64),
      files: [{ path: '../outside', size: 1, sha256: digest(file), executable: false }],
    }));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    const traversal = Buffer.concat([SKILL_TRANSFER_ARCHIVE_TESTING.magic, length, header, file]);
    expect(() => extractSkillTransferArchive({
      bytes: traversal, blobDigest: digest(traversal), treeDigest: '1'.repeat(64),
      destination: join(parent, 'traversal'),
    })).toThrowError(expect.objectContaining({ code: 'invalid_path' }));

    await symlink(join(source, 'SKILL.md'), join(source, 'linked.md'));
    expect(() => buildSkillTransferArchive(source)).toThrowError(expect.objectContaining({ code: 'link_not_allowed' }));
  });
});
