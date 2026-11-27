/**
 * Auto-apply SQL migrations on startup.
 * Tracks applied migrations in a `_migrations` table.
 * Idempotent — safe to run on every startup.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

/**
 * Sort migration filenames by their numeric prefix (not string comparison).
 * Handles any width: 001, 035, 100, 1000, etc. — avoids string sort pitfalls
 * where "99_foo" > "100_bar".
 */
function sortMigrations(files: string[]): string[] {
  return files.sort((a, b) => {
    const numA = parseInt(a, 10);
    const numB = parseInt(b, 10);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    return a.localeCompare(b);
  });
}

/** Only canonical migration names may execute; ignore archive metadata/dotfiles. */
export function isMigrationFile(file: string): boolean {
  return /^\d{3}_[A-Za-z0-9][A-Za-z0-9_.-]*\.sql$/.test(file);
}

export async function runMigrations(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    // Serialize concurrent startup migrations across replicas on a single connection
    // before touching or reading `_migrations`, then re-read inside the lock.
    await tx.queryOne("SELECT pg_advisory_xact_lock(hashtextextended('imcodes:_migrations', 0))");

    await tx.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       TEXT PRIMARY KEY,
        applied_at BIGINT NOT NULL
      )
    `);

    const results = await tx.query<{ name: string }>('SELECT name FROM _migrations ORDER BY name');
    const applied = new Set(results.map((r) => r.name));

    const files = sortMigrations(
      (await readdir(MIGRATIONS_DIR)).filter(isMigrationFile),
    );

    for (const file of files) {
      if (applied.has(file)) continue;

      console.log(`[migrate] Applying ${file}...`);
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
      await tx.exec(sql);
      await tx.execute(
        'INSERT INTO _migrations (name, applied_at) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
        [file, Date.now()],
      );
      console.log(`[migrate] Applied ${file}`);
    }
  });

  console.log('[migrate] All migrations up to date');
}
