import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Find the project root by walking up from __dirname looking for package.json.
 * Works whether running from src/ (ts-node/vitest) or dist/src/ (compiled).
 */
function find(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  // Fallback: assume two levels up from this file (src/util/ → root)
  return resolve(__dirname, '../..');
}

export const PROJECT_ROOT = find();
