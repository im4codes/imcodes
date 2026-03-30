import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname_esm = dirname(fileURLToPath(import.meta.url));

/**
 * Find the project root by walking up from this file looking for package.json.
 * Works whether running from src/ (ts-node/vitest) or dist/src/ (compiled).
 */
function find(): string {
  let dir = __dirname_esm;
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  // Fallback: assume two levels up from this file (src/util/ → root)
  return resolve(__dirname_esm, '../..');
}

export const PROJECT_ROOT = find();
