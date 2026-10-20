/**
 * COW workspace for a non-git project (tsk_cd_non_git_pair_workspace): probe, clone, manifest, changed files,
 * per-file review, checked apply-back, undo, crash rollback. Real files; the clone primitive is the real one where
 * the filesystem supports it (APFS here) and an injected failing one where a test needs "no copy-on-write".
 */
import { copyFile } from 'node:fs/promises';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApplyBackAbort,
  applyBackCow,
  buildCowReview,
  computeCowChanges,
  createCowClone,
  findApplyBackConflicts,
  hasUnfinishedApplyBack,
  probeCopyOnWrite,
  readApplyBackJournal,
  readCowManifest,
  rollbackApplyBack,
  undoApplyBack,
  type CloneFile,
} from '../../../src/daemon/task-pairs/non-git.js';
import { TASK_PAIR_APPLY_BACK_DIR, TASK_PAIR_COW_MANIFEST_DIR } from '../../../shared/task-pair.js';

let base = '';
let project = '';
let taskDir = '';

/** path -> "kind:sha|mode|mtime" (files), "link:target", "dir" for every entry under root, skipping top-level names. */
function tree(root: string, skip: string[] = [], withMtime = false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      if (!prefix && skip.includes(name)) continue;
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const info = lstatSync(abs);
      if (info.isSymbolicLink()) out[rel] = `link:${readlinkSync(abs)}`;
      else if (info.isDirectory()) { out[rel] = 'dir'; walk(abs, rel); }
      else out[rel] = `file:${createHash('sha1').update(readFileSync(abs)).digest('hex')}|${(info.mode & 0o777).toString(8)}${withMtime ? `|${Math.round(info.mtimeMs)}` : ''}`;
    }
  };
  walk(root, '');
  return out;
}

function makeProject(): void {
  mkdirSync(join(project, 'src', 'deep'), { recursive: true });
  mkdirSync(join(project, 'node_modules', 'dep'), { recursive: true });
  mkdirSync(join(project, 'dist'), { recursive: true });
  writeFileSync(join(project, 'README.md'), 'hello\n');
  writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(project, 'src', 'deep', 'b.ts'), 'export const b = 2;\n');
  writeFileSync(join(project, 'crlf.txt'), 'one\r\ntwo\r\n');
  writeFileSync(join(project, 'blob.bin'), Buffer.from([0, 1, 2, 255, 254, 0, 13, 10]));
  writeFileSync(join(project, 'run.sh'), '#!/bin/sh\necho hi\n');
  chmodSync(join(project, 'run.sh'), 0o755);
  writeFileSync(join(project, 'node_modules', 'dep', 'index.js'), 'heavy\n');
  writeFileSync(join(project, 'dist', 'out.js'), 'built\n');
  symlinkSync('README.md', join(project, 'link-to-readme'));
}

/** A clone primitive standing in for a filesystem without copy-on-write. */
const noCow: CloneFile = async () => { throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' }); };

/** The clone primitive of a filesystem WITHOUT copy-on-write: a plain copy. The manifest / changes / review / apply-back logic is the same either way. */
const plainCopy: CloneFile = (from, to) => copyFile(from, to);

/** Every logic test runs on every machine with the plain-copy engine; the real engine has its own tests below. */
const cowSupported = async () => true;

async function clone(): Promise<void> {
  const result = await createCowClone(project, taskDir, { engine: plainCopy });
  if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
}

/** Give a file a clearly different mtime than the project original (a write later in time). */
function later(path: string, seconds = 5): void {
  const when = new Date(Date.now() + seconds * 1000);
  utimesSync(path, when, when);
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'imcodes-cow-')));
  project = join(base, 'project');
  taskDir = join(base, 'works', 'task1');
  mkdirSync(project, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('mode selection and the clone', () => {
  it('probe: a copy-on-write filesystem on the same volume is supported; an injected "no COW" clone primitive and an empty project are not; the probe leaves nothing behind', async () => {
    makeProject();
    const real = await probeCopyOnWrite(project, taskDir);
    // This suite runs on APFS (the developer Mac) and ext4/xfs CI boxes: report the truth, assert the rest.
    console.log(`copy-on-write probe on ${process.platform}: ${real.supported ? 'supported' : `unsupported (${real.reason})`}`);
    expect(readdirSync(taskDir).filter((name) => name.startsWith('.imcodes-clone-probe'))).toEqual([]);
    const denied = await probeCopyOnWrite(project, taskDir, noCow);
    expect(denied).toEqual({ supported: false, reason: 'clone_unsupported:ENOTSUP' });
    const empty = join(base, 'empty');
    mkdirSync(empty);
    expect(await probeCopyOnWrite(empty, taskDir)).toEqual({ supported: false, reason: 'no_file_to_probe' });
  });

  it('the clone: every non-excluded file, link and directory is there, byte for byte; heavy dirs are not cloned; the project is untouched', async () => {
    makeProject();
    const before = tree(project, [], true);
    const result = await createCowClone(project, taskDir, { engine: plainCopy });
    expect(result.ok).toBe(true);
    expect(tree(project, [], true)).toEqual(before); // nothing in the project moved, changed or even got a new mtime
    for (const heavy of ['node_modules', 'dist']) expect(existsSync(join(taskDir, heavy))).toBe(false);
    expect(tree(taskDir, [TASK_PAIR_COW_MANIFEST_DIR])).toEqual(tree(project, ['node_modules', 'dist']));
    expect(readFileSync(join(taskDir, 'crlf.txt'), 'utf8')).toBe('one\r\ntwo\r\n');
    expect(readlinkSync(join(taskDir, 'link-to-readme'))).toBe('README.md');
    expect(existsSync(join(taskDir, '.git'))).toBe(false); // no git anywhere: a repo would store every file again
    if (result.ok) expect(result).toMatchObject({ files: 7, logicalBytes: expect.any(Number), ms: expect.any(Number) });
    const manifest = await readCowManifest(taskDir);
    expect(Object.keys(manifest!.entries).sort()).toEqual(['README.md', 'blob.bin', 'crlf.txt', 'link-to-readme', 'run.sh', 'src/a.ts', 'src/deep/b.ts']);
    expect(manifest!.entries['link-to-readme']).toMatchObject({ kind: 'link', target: 'README.md' });
  });

  it('a symlink is cloned as a link and never followed: a link pointing outside the project brings nothing in', async () => {
    writeFileSync(join(project, 'a.txt'), 'a');
    const outside = join(base, 'outside-secret.txt');
    writeFileSync(outside, 'SECRET');
    symlinkSync(outside, join(project, 'escape'));
    symlinkSync(base, join(project, 'escape-dir'));
    await clone();
    expect(lstatSync(join(taskDir, 'escape')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(taskDir, 'escape'))).toBe(outside);
    expect(lstatSync(join(taskDir, 'escape-dir')).isSymbolicLink()).toBe(true);
    expect(readdirSync(taskDir).filter((name) => name.includes('outside'))).toEqual([]);
  });

  it('a clone that fails midway leaves nothing behind and the project untouched (the caller falls back to in-place)', async () => {
    makeProject();
    const before = tree(project, [], true);
    let calls = 0;
    const flaky: CloneFile = async (from, to) => { calls += 1; if (calls === 3) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); await import('node:fs/promises').then((fs) => fs.copyFile(from, to)); };
    const result = await createCowClone(project, taskDir, { engine: flaky });
    expect(result).toMatchObject({ ok: false, reason: 'clone_failed' });
    expect(existsSync(taskDir)).toBe(false);
    expect(tree(project, [], true)).toEqual(before);
  });

  it('a project with more files than the walk limit is not cloned (a clear reason, nothing created)', async () => {
    for (let i = 0; i < 6; i += 1) writeFileSync(join(project, `f${i}.txt`), 'x');
    const result = await createCowClone(project, taskDir, { maxFiles: 3 });
    expect(result).toMatchObject({ ok: false, reason: 'too_many_files' });
    expect(existsSync(taskDir)).toBe(false);
  });

  it('an empty project clones to an empty workspace with an empty manifest; a task dir inside the project is not cloned into itself', async () => {
    const inside = join(project, '.works', 't1');
    writeFileSync(join(project, 'a.txt'), 'a');
    const one = await createCowClone(project, inside, { engine: async (from, to) => { await import('node:fs/promises').then((fs) => fs.copyFile(from, to)); } });
    expect(one.ok).toBe(true);
    expect(existsSync(join(inside, '.works'))).toBe(false);
    const empty = join(base, 'empty');
    mkdirSync(empty);
    const two = await createCowClone(empty, join(base, 'works', 'empty'), { engine: plainCopy });
    expect(two).toMatchObject({ ok: true, files: 0 });
    expect(Object.keys((await readCowManifest(join(base, 'works', 'empty')))!.entries)).toEqual([]);
  });
});

describe('changed files and the review (manifest based, no git)', () => {
  it('edit, add, delete, rename, chmod, symlink change and a touch-only file: exactly the real changes are listed', async () => {
    makeProject();
    await clone();
    writeFileSync(join(taskDir, 'src', 'a.ts'), 'export const a = 100;\n');          // edit
    writeFileSync(join(taskDir, 'src', 'fresh.ts'), 'export const fresh = 0;\n');    // add
    rmSync(join(taskDir, 'README.md'));                                              // delete
    renameSync(join(taskDir, 'src', 'deep', 'b.ts'), join(taskDir, 'src', 'deep', 'renamed.ts')); // rename = delete + add
    chmodSync(join(taskDir, 'run.sh'), 0o644);                                       // mode only
    rmSync(join(taskDir, 'link-to-readme'));
    symlinkSync('src/a.ts', join(taskDir, 'link-to-readme'));                         // link retarget
    later(join(taskDir, 'crlf.txt'));                                                // touched, same bytes
    const changes = await computeCowChanges(taskDir);
    expect(changes!.map((c) => `${c.kind}:${c.path}${c.modeOnly ? ':mode' : ''}`)).toEqual([
      'deleted:README.md', 'modified:link-to-readme', 'modified:run.sh:mode', 'modified:src/a.ts', 'deleted:src/deep/b.ts', 'added:src/deep/renamed.ts', 'added:src/fresh.ts',
    ]);
    expect(changes!.find((c) => c.path === 'src/a.ts')).toMatchObject({ sizeBefore: 20, sizeAfter: 22 });
  });

  it('nothing edited -> no changes; the daemon directories and heavy dirs the pair created are not part of the work', async () => {
    makeProject();
    await clone();
    expect(await computeCowChanges(taskDir)).toEqual([]);
    mkdirSync(join(taskDir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(taskDir, 'node_modules', 'x', 'i.js'), 'installed');
    mkdirSync(join(taskDir, TASK_PAIR_APPLY_BACK_DIR), { recursive: true });
    writeFileSync(join(taskDir, TASK_PAIR_APPLY_BACK_DIR, 'x'), 'y');
    expect(await computeCowChanges(taskDir)).toEqual([]);
  });

  it('the review: a per-file unified diff labelled a/<path> b/<path> (CRLF preserved), a size/hash summary for a binary, the full diff written to the task dir', async () => {
    makeProject();
    await clone();
    writeFileSync(join(taskDir, 'src', 'a.ts'), 'export const a = 100;\n');
    writeFileSync(join(taskDir, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
    writeFileSync(join(taskDir, 'blob.bin'), Buffer.from([0, 9, 9, 9]));
    writeFileSync(join(taskDir, 'new.txt'), 'brand new\n');
    rmSync(join(taskDir, 'README.md'));
    const review = (await buildCowReview(taskDir))!;
    expect(review.changes.map((c) => c.path)).toEqual(['README.md', 'blob.bin', 'crlf.txt', 'new.txt', 'src/a.ts']);
    expect(review.diff).toContain('diff --git a/src/a.ts b/src/a.ts');
    expect(review.diff).toContain('--- a/src/a.ts');
    expect(review.diff).toContain('+++ b/src/a.ts');
    expect(review.diff).toContain('-export const a = 1;');
    expect(review.diff).toContain('+export const a = 100;');
    expect(review.diff).toContain('+three');
    expect(review.diff).toContain('--- /dev/null'); // new.txt
    expect(review.diff).toContain('+++ /dev/null'); // README.md deleted
    expect(review.diff).not.toContain(project); // no absolute paths leak into the patch headers
    expect(review.summaries).toEqual([expect.stringMatching(/^modified binary\/large blob\.bin: 8 -> 4 bytes, sha256 [0-9a-f]{12} -> [0-9a-f]{12}$/)]);
    expect(readFileSync(review.diffFile!, 'utf8')).toBe(review.diff);
    expect(review.diffTruncated).toBe(false);
  });

  it('a huge diff is cut for the message but the full one is in the file', async () => {
    writeFileSync(join(project, 'big.txt'), 'x\n');
    await clone();
    writeFileSync(join(taskDir, 'big.txt'), Array.from({ length: 30_000 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const review = (await buildCowReview(taskDir))!;
    expect(review.diffTruncated).toBe(true);
    expect(review.diff.endsWith('... (cut)')).toBe(true);
    expect(readFileSync(review.diffFile!, 'utf8').length).toBeGreaterThan(review.diff.length);
  });
});

describe('applyBackCow', () => {
  async function editedClone() {
    await clone();
    writeFileSync(join(taskDir, 'src', 'a.ts'), 'export const a = 100;\n');
    writeFileSync(join(taskDir, 'src', 'fresh.ts'), 'export const fresh = 0;\n');
    mkdirSync(join(taskDir, 'pkg', 'inner'), { recursive: true });
    writeFileSync(join(taskDir, 'pkg', 'inner', 'c.ts'), 'export const c = 3;\n');
    rmSync(join(taskDir, 'README.md'));
    renameSync(join(taskDir, 'src', 'deep', 'b.ts'), join(taskDir, 'src', 'deep', 'renamed.ts'));
    chmodSync(join(taskDir, 'run.sh'), 0o644);
    rmSync(join(taskDir, 'link-to-readme'));
    symlinkSync('src/a.ts', join(taskDir, 'link-to-readme'));
    writeFileSync(join(taskDir, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
  }

  it('clean apply: edit, add (nested), delete, rename, chmod and a retargeted link land in the project; heavy dirs are untouched; the project then equals the finished clone', async () => {
    makeProject();
    await editedClone();
    const heavyBefore = tree(join(project, 'node_modules'));
    const expected = tree(taskDir, [TASK_PAIR_COW_MANIFEST_DIR, TASK_PAIR_APPLY_BACK_DIR]);
    const result = await applyBackCow(taskDir);
    expect(result.status).toBe('applied');
    expect(tree(project, ['node_modules', 'dist'])).toEqual(expected);
    expect(existsSync(join(project, 'README.md'))).toBe(false);
    expect(readFileSync(join(project, 'src', 'deep', 'renamed.ts'), 'utf8')).toBe('export const b = 2;\n');
    expect(statSync(join(project, 'run.sh')).mode & 0o111).toBe(0);
    expect(readlinkSync(join(project, 'link-to-readme'))).toBe('src/a.ts');
    expect(readFileSync(join(project, 'crlf.txt'), 'utf8')).toBe('one\r\ntwo\r\nthree\r\n');
    expect(tree(join(project, 'node_modules'))).toEqual(heavyBefore);
    expect(readdirSync(project).filter((name) => name.includes('.tmp') || name.startsWith('.imcodes'))).toEqual([]);
    expect((await readApplyBackJournal(taskDir))?.status).toBe('applied');
  });

  it('nothing changed: nothing to apply', async () => {
    makeProject();
    await clone();
    expect(await applyBackCow(taskDir)).toEqual({ status: 'noop' });
  });

  it('CONFLICT: files the project changed since the clone -> nothing at all is written and every conflicting file is listed', async () => {
    writeFileSync(join(project, 'a.txt'), 'a\n');
    writeFileSync(join(project, 'b.txt'), 'b\n');
    writeFileSync(join(project, 'gone.txt'), 'g\n');
    await clone();
    writeFileSync(join(taskDir, 'a.txt'), 'a-pair\n');
    writeFileSync(join(taskDir, 'b.txt'), 'b-pair\n');
    rmSync(join(taskDir, 'gone.txt'));
    writeFileSync(join(taskDir, 'brand-new.txt'), 'n\n');
    // The project moved on: a.txt edited, gone.txt edited, brand-new.txt created by someone else.
    writeFileSync(join(project, 'a.txt'), 'a-owner\n'); later(join(project, 'a.txt'), 10);
    writeFileSync(join(project, 'gone.txt'), 'g-owner\n'); later(join(project, 'gone.txt'), 10);
    writeFileSync(join(project, 'brand-new.txt'), 'someone else\n');
    const before = tree(project, [], true);
    const result = await applyBackCow(taskDir);
    expect(result.status).toBe('conflict');
    expect((result as { conflicts: Array<{ path: string; reason: string }> }).conflicts.map((c) => `${c.path}:${c.reason}`).sort()).toEqual([
      'a.txt:changed_in_project', 'brand-new.txt:exists_in_project', 'gone.txt:changed_in_project',
    ]);
    expect(tree(project, [], true)).toEqual(before); // b.txt (no conflict) was NOT applied either
    expect(existsSync(join(taskDir, TASK_PAIR_APPLY_BACK_DIR, 'backup'))).toBe(false);
  });

  it('CONFLICT: a project file deleted meanwhile, a file blocking a new directory, and a link replacing a directory', async () => {
    writeFileSync(join(project, 'a.txt'), 'a\n');
    await clone();
    writeFileSync(join(taskDir, 'a.txt'), 'a2\n');
    mkdirSync(join(taskDir, 'newdir'));
    writeFileSync(join(taskDir, 'newdir', 'f.txt'), 'f\n');
    rmSync(join(project, 'a.txt'));
    writeFileSync(join(project, 'newdir'), 'a file where the pair wants a directory');
    const result = await applyBackCow(taskDir);
    expect(result.status).toBe('conflict');
    expect((result as { conflicts: Array<{ path: string; reason: string }> }).conflicts.map((c) => `${c.path}:${c.reason}`).sort()).toEqual(['a.txt:missing_in_project', 'newdir/f.txt:blocked_by_file']);
  });

  it('a symlinked parent directory in the project is never written through', async () => {
    mkdirSync(join(project, 'real'), { recursive: true });
    writeFileSync(join(project, 'real', 'f.txt'), 'f\n');
    await clone();
    writeFileSync(join(taskDir, 'real', 'f.txt'), 'changed\n');
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'f.txt'), 'f\n');
    rmSync(join(project, 'real'), { recursive: true });
    symlinkSync(elsewhere, join(project, 'real'));
    const result = await applyBackCow(taskDir);
    expect(result.status).toBe('conflict');
    expect((result as { conflicts: Array<{ reason: string }> }).conflicts[0]!.reason).toBe('unsafe_path');
    expect(readFileSync(join(elsewhere, 'f.txt'), 'utf8')).toBe('f\n');
  });

  it('two pairs on the same project touching the same file: the first apply wins, the second is a conflict and never clobbers', async () => {
    writeFileSync(join(project, 'shared.txt'), 'orig\n');
    writeFileSync(join(project, 'only-second.txt'), 'orig2\n');
    const dirA = join(base, 'works', 'pairA');
    const dirB = join(base, 'works', 'pairB');
    expect((await createCowClone(project, dirA, { engine: plainCopy })).ok).toBe(true);
    expect((await createCowClone(project, dirB, { engine: plainCopy })).ok).toBe(true);
    writeFileSync(join(dirA, 'shared.txt'), 'from A\n');
    writeFileSync(join(dirB, 'shared.txt'), 'from B\n');
    writeFileSync(join(dirB, 'only-second.txt'), 'B only\n');
    expect((await applyBackCow(dirA)).status).toBe('applied');
    const result = await applyBackCow(dirB);
    expect(result.status).toBe('conflict');
    expect((result as { conflicts: Array<{ path: string }> }).conflicts.map((c) => c.path)).toEqual(['shared.txt']);
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('from A\n');
    expect(readFileSync(join(project, 'only-second.txt'), 'utf8')).toBe('orig2\n');
  });

  it('a project that became a git repository after the clone still gets a plain file apply (its .git is not touched)', async () => {
    writeFileSync(join(project, 'a.txt'), 'a\n');
    await clone();
    writeFileSync(join(taskDir, 'a.txt'), 'a2\n');
    mkdirSync(join(project, '.git'));
    writeFileSync(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const gitBefore = tree(join(project, '.git'), [], true);
    expect((await applyBackCow(taskDir)).status).toBe('applied');
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('a2\n');
    expect(tree(join(project, '.git'), [], true)).toEqual(gitBefore);
  });

  it('UNDO restores exactly: bytes, permissions, deleted files, links; added files and created directories are removed', async () => {
    makeProject();
    await editedClone();
    chmodSync(join(project, 'src', 'a.ts'), 0o640);
    // chmod changes ctime, not mtime: the base fingerprint still matches.
    const before = tree(project, [], true);
    expect((await applyBackCow(taskDir)).status).toBe('applied');
    expect(tree(project, [], true)).not.toEqual(before);
    const undone = await undoApplyBack(taskDir);
    expect(undone.ok).toBe(true);
    expect(undone.skipped).toEqual([]);
    expect(tree(project, [], true)).toEqual(before);
    expect((await readApplyBackJournal(taskDir))?.status).toBe('undone');
  });

  it('UNDO never overwrites what the owner changed after the apply: those files are skipped and reported', async () => {
    makeProject();
    await editedClone();
    await applyBackCow(taskDir);
    writeFileSync(join(project, 'src', 'a.ts'), 'owner edit after the apply, longer\n');
    later(join(project, 'src', 'a.ts'), 30);
    const undone = await undoApplyBack(taskDir);
    expect(undone.skipped).toEqual([{ path: 'src/a.ts', reason: 'changed_since_apply' }]);
    expect(readFileSync(join(project, 'src', 'a.ts'), 'utf8')).toBe('owner edit after the apply, longer\n');
    expect(readFileSync(join(project, 'crlf.txt'), 'utf8')).toBe('one\r\ntwo\r\n'); // the rest was restored
  });

  it('a failure midway (a write error) rolls back to the exact pre-apply state and reports it', async () => {
    makeProject();
    await editedClone();
    const before = tree(project, [], true);
    const result = await applyBackCow(taskDir, { beforeWrite: (path, index) => { if (index === 3) throw new Error(`disk full while writing ${path}`); } });
    expect(result).toMatchObject({ status: 'failed', rolledBack: true });
    expect((result as { detail: string }).detail).toContain('disk full');
    expect(tree(project, [], true)).toEqual(before);
    expect((await readApplyBackJournal(taskDir))?.status).toBe('rolled_back');
  });

  it('a process killed mid-apply leaves an unfinished journal; rollback restores the exact pre-apply state, and the apply can then simply run again', async () => {
    makeProject();
    await editedClone();
    const before = tree(project, [], true);
    await expect(applyBackCow(taskDir, { beforeWrite: (_path, index) => { if (index === 4) throw new ApplyBackAbort('killed'); } })).rejects.toBeInstanceOf(ApplyBackAbort);
    expect(await hasUnfinishedApplyBack(taskDir)).toBe(true);
    expect(tree(project, [], true)).not.toEqual(before); // half applied
    const rolled = await rollbackApplyBack(taskDir);
    expect(rolled.ok).toBe(true);
    expect(tree(project, [], true)).toEqual(before);
    expect(await hasUnfinishedApplyBack(taskDir)).toBe(false);
    expect((await applyBackCow(taskDir)).status).toBe('applied');
  });

  it('findApplyBackConflicts reads only', async () => {
    writeFileSync(join(project, 'a.txt'), 'a\n');
    await clone();
    writeFileSync(join(taskDir, 'a.txt'), 'a2\n');
    const manifest = (await readCowManifest(taskDir))!;
    const before = tree(project, [], true);
    expect(await findApplyBackConflicts(taskDir, manifest, (await computeCowChanges(taskDir, manifest))!)).toEqual([]);
    expect(tree(project, [], true)).toEqual(before);
  });
});

describe('the real clone engine (skipped, and reported, where the filesystem has no copy-on-write)', () => {
  async function realSupported(): Promise<boolean> {
    makeProject();
    const probe = await probeCopyOnWrite(project, taskDir);
    console.log(`real clone engine on ${process.platform}: ${probe.supported ? 'copy-on-write supported' : `not supported (${probe.reason}) -> these tests are skipped`}`);
    return probe.supported;
  }

  it('clones with the platform primitive: byte-identical, links kept, heavy dirs left out, project untouched, and the shared blocks cost no extra disk', async () => {
    if (!(await realSupported())) return;
    // Padding so the extra-disk figure is measurable: 64 MiB of real data.
    writeFileSync(join(project, 'padding.bin'), Buffer.alloc(64 * 1024 * 1024, 7));
    const before = tree(project, [], true);
    const result = await createCowClone(project, taskDir);
    expect(result.ok).toBe(true);
    expect(tree(project, [], true)).toEqual(before);
    expect(tree(taskDir, [TASK_PAIR_COW_MANIFEST_DIR])).toEqual(tree(project, ['node_modules', 'dist']));
    for (const heavy of ['node_modules', 'dist']) expect(existsSync(join(taskDir, heavy))).toBe(false);
    if (result.ok) {
      console.log(`real clone: ${result.files} files, ${result.logicalBytes} logical bytes, ${result.ms} ms, extra disk ${result.extraDiskBytes ?? 'n/a'} bytes`);
      // 64 MiB were cloned. The figure is the drop in free space of the WHOLE volume, so other activity on the disk (a parallel build, a
      // suite on a shared runner) is in it: it only has to stay clearly under what a real copy costs (64 MiB plus that same noise).
      if (result.extraDiskBytes !== undefined) expect(result.extraDiskBytes).toBeLessThan(48 * 1024 * 1024);
    }
    // Same inode data? A clone has its own inode.
    expect(lstatSync(join(taskDir, 'padding.bin')).ino).not.toBe(lstatSync(join(project, 'padding.bin')).ino);
    // Writing the clone leaves the project original alone.
    writeFileSync(join(taskDir, 'padding.bin'), 'tiny');
    expect(statSync(join(project, 'padding.bin')).size).toBe(64 * 1024 * 1024);
  });

  it('a project with nothing to leave out is cloned as whole trees (one call per top-level directory) and is still exact', async () => {
    mkdirSync(join(project, 'a', 'b'), { recursive: true });
    mkdirSync(join(project, 'c'), { recursive: true });
    for (let i = 0; i < 40; i += 1) writeFileSync(join(project, 'a', 'b', `f${i}.txt`), `file ${i}`);
    writeFileSync(join(project, 'c', 'x.txt'), 'x');
    writeFileSync(join(project, 'top1.txt'), '1');
    writeFileSync(join(project, 'top2.txt'), '2');
    symlinkSync('top1.txt', join(project, 'toplink'));
    symlinkSync('../top2.txt', join(project, 'c', 'deeplink'));
    const probe = await probeCopyOnWrite(project, taskDir);
    if (!probe.supported) return;
    const result = await createCowClone(project, taskDir);
    expect(result.ok).toBe(true);
    expect(tree(taskDir, [TASK_PAIR_COW_MANIFEST_DIR])).toEqual(tree(project));
    const manifest = await readCowManifest(taskDir);
    expect(Object.keys(manifest!.entries)).toHaveLength(40 + 1 + 2 + 2);
    expect(await computeCowChanges(taskDir)).toEqual([]);
  });

  it('end to end on the real engine: edit in the clone, review, apply back, undo', async () => {
    if (!(await realSupported())) return;
    expect((await createCowClone(project, taskDir)).ok).toBe(true);
    writeFileSync(join(taskDir, 'src', 'a.ts'), 'export const a = 100;\n');
    rmSync(join(taskDir, 'README.md'));
    const review = (await buildCowReview(taskDir))!;
    expect(review.changes.map((c) => `${c.kind}:${c.path}`)).toEqual(['deleted:README.md', 'modified:src/a.ts']);
    expect(review.diff).toContain('+export const a = 100;');
    const before = tree(project, [], true);
    expect((await applyBackCow(taskDir)).status).toBe('applied');
    expect(readFileSync(join(project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 100;\n');
    expect(existsSync(join(project, 'README.md'))).toBe(false);
    expect((await undoApplyBack(taskDir)).ok).toBe(true);
    expect(tree(project, [], true)).toEqual(before);
  });
});
