/**
 * Auto-apply SQL migrations on startup.
 * Tracks applied migrations in a `_migrations` table.
 * Idempotent — safe to run on every startup.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgDatabase } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

export async function runMigrations(db: PgDatabase): Promise<void> {
  // Ensure migrations tracking table exists
  await db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at BIGINT NOT NULL
    )
  `);

  // Get already-applied migrations
  const { results } = await db.prepare('SELECT name FROM _migrations ORDER BY name').bind().all<{ name: string }>();
  const applied = new Set(results.map((r) => r.name));

  // Discover migration files sorted by name
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    console.log(`[migrate] Applying ${file}...`);
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
    await db.exec(sql);
    await db.prepare('INSERT INTO _migrations (name, applied_at) VALUES ($1, $2)').bind(file, Date.now()).run();
    console.log(`[migrate] Applied ${file}`);
  }

  console.log('[migrate] All migrations up to date');
}
