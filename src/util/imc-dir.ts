/**
 * .imc/ — project-level interaction directory for IM.codes.
 * Used for P2P discussions, file exchanges, temp artifacts, etc.
 * Auto-creates the directory and adds to .gitignore if needed.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const IMC_DIR = '.imc';

/** Get the .imc root directory for a project. */
export function imcDir(projectDir: string): string {
  return join(projectDir, IMC_DIR);
}

/** Get a subdirectory under .imc/ (e.g. 'discussions', 'uploads', 'temp'). */
export function imcSubDir(projectDir: string, sub: string): string {
  return join(projectDir, IMC_DIR, sub);
}

/** Ensure .imc/ subdirectory exists and is in .gitignore. */
export async function ensureImcDir(projectDir: string, sub?: string): Promise<string> {
  const dir = sub ? imcSubDir(projectDir, sub) : imcDir(projectDir);
  await mkdir(dir, { recursive: true });

  // Auto-add .imc/ to .gitignore if not present
  try {
    const gitignorePath = join(projectDir, '.gitignore');
    const content = await readFile(gitignorePath, 'utf8').catch(() => '');
    if (!content.includes('.imc/') && !content.includes('.imc\n')) {
      const line = content.endsWith('\n') || content === '' ? '.imc/\n' : '\n.imc/\n';
      await writeFile(gitignorePath, content + line);
    }
  } catch { /* best effort */ }

  return dir;
}
