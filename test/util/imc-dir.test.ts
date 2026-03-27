import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { imcDir, imcSubDir, ensureImcDir } from '../../src/util/imc-dir.js';

describe('imc-dir utilities', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'imc-dir-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('imcDir', () => {
    it('returns {projectDir}/.imc', () => {
      expect(imcDir('/home/user/project')).toBe('/home/user/project/.imc');
    });

    it('works with trailing slash', () => {
      // join normalizes this
      expect(imcDir('/home/user/project')).toBe('/home/user/project/.imc');
    });
  });

  describe('imcSubDir', () => {
    it('returns {projectDir}/.imc/{sub}', () => {
      expect(imcSubDir('/home/user/project', 'discussions')).toBe(
        '/home/user/project/.imc/discussions',
      );
    });

    it('works with different sub names', () => {
      expect(imcSubDir('/proj', 'refs')).toBe('/proj/.imc/refs');
      expect(imcSubDir('/proj', 'uploads')).toBe('/proj/.imc/uploads');
      expect(imcSubDir('/proj', 'temp')).toBe('/proj/.imc/temp');
    });
  });

  describe('ensureImcDir', () => {
    it('creates .imc directory when called without sub', async () => {
      const dir = await ensureImcDir(tmpDir);
      expect(dir).toBe(join(tmpDir, '.imc'));
      expect(existsSync(dir)).toBe(true);
    });

    it('creates .imc/{sub} directory when called with sub', async () => {
      const dir = await ensureImcDir(tmpDir, 'refs');
      expect(dir).toBe(join(tmpDir, '.imc', 'refs'));
      expect(existsSync(dir)).toBe(true);
    });

    it('adds .imc/ to .gitignore when not present', async () => {
      await ensureImcDir(tmpDir, 'discussions');
      const gitignore = await readFile(join(tmpDir, '.gitignore'), 'utf8');
      expect(gitignore).toContain('.imc/');
    });

    it('does not duplicate .imc/ in .gitignore if already present', async () => {
      // Pre-create .gitignore with .imc/ already listed
      await writeFile(join(tmpDir, '.gitignore'), 'node_modules/\n.imc/\n');

      await ensureImcDir(tmpDir, 'refs');
      const gitignore = await readFile(join(tmpDir, '.gitignore'), 'utf8');

      // Count occurrences of .imc/
      const matches = gitignore.match(/\.imc\//g);
      expect(matches).toHaveLength(1);
    });

    it('appends .imc/ on a new line if .gitignore does not end with newline', async () => {
      await writeFile(join(tmpDir, '.gitignore'), 'node_modules/');
      await ensureImcDir(tmpDir);

      const gitignore = await readFile(join(tmpDir, '.gitignore'), 'utf8');
      expect(gitignore).toBe('node_modules/\n.imc/\n');
    });

    it('creates .gitignore if it does not exist', async () => {
      await ensureImcDir(tmpDir);
      const gitignore = await readFile(join(tmpDir, '.gitignore'), 'utf8');
      expect(gitignore).toBe('.imc/\n');
    });

    it('is idempotent — multiple calls do not corrupt .gitignore', async () => {
      await ensureImcDir(tmpDir, 'discussions');
      await ensureImcDir(tmpDir, 'refs');
      await ensureImcDir(tmpDir, 'temp');

      const gitignore = await readFile(join(tmpDir, '.gitignore'), 'utf8');
      const matches = gitignore.match(/\.imc\//g);
      expect(matches).toHaveLength(1);
    });
  });
});
