/** Upgrade a populated pre-security DB, including retries and either previously applied 100 filename. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDatabase, type Database } from '../src/db/client.js';
import { isMigrationFile, runMigrations } from '../src/db/migrate.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { USER_STATUS } from '../../shared/user-status.js';

const dir = fileURLToPath(new URL('../src/db/migrations/', import.meta.url));
const machineFile = '100_machine_execute_grant_and_audit.sql';
const userFile = '100_user_sessions_valid_after.sql';
let admin: Database;
beforeAll(() => { admin = createDatabase(process.env.TEST_DATABASE_URL!); });
afterAll(async () => { await admin.close(); });

it.each(['partial-ddl', machineFile, userFile])('populated upgrade/retry with %s keeps values and tracks both full filenames', async (prior) => {
  // A separate database avoids conflating public constraint names with another test's schema.
  const name = `imcodes_test_security_${randomBytes(6).toString('hex')}`;
  await admin.exec(`CREATE DATABASE "${name}"`);
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  const db = createDatabase(url.toString());
  try {
    await db.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)');
    const files = (await readdir(dir)).filter(isMigrationFile).filter((f) => parseInt(f, 10) < 100)
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    for (const file of files) {
      await db.exec(await readFile(`${dir}${file}`, 'utf8'));
      await db.execute('INSERT INTO _migrations VALUES ($1,$2)', [file, Date.now()]);
    }
    const now = Date.now();
    for (const id of ['existing-owner', 'existing-grantee']) {
      await db.execute('INSERT INTO users (id,status,created_at) VALUES ($1,$2,$3)', [id, USER_STATUS.ACTIVE, now]);
    }
    for (const [id, enabled] of [['existing-on', true], ['existing-off', false]] as const) {
      await db.execute("INSERT INTO servers (id,user_id,name,token_hash,node_role,exec_enabled,created_at,node_id) VALUES ($1,'existing-owner',$1,'unused',$4,$2,$3,$5)", [id, enabled, now, NODE_ROLE.CONTROLLED, enabled ? '1000000001' : '1000000002']);
    }
    for (const [id, revoked] of [['existing-share', null], ['soft-deleted-share', now]] as const) {
      await db.execute("INSERT INTO server_shares (id,server_id,target_user_id,role,created_by,created_at,updated_at,revoked_at) VALUES ($1,$4,'existing-grantee','participant','existing-owner',$2,$2,$3)", [id, now, revoked, revoked === null ? 'existing-on' : 'existing-off']);
    }
    await db.execute("INSERT INTO machine_exec_audit (correlation_id,user_id,target_server_id,command_sha256,command_length,shell,outcome,created_at,updated_at) VALUES ('old-audit','existing-owner','existing-on',$1,7,'sh','completed',$2,$2)", ['a'.repeat(64), now]);
    if (prior === 'partial-ddl') {
      // Persisted DDL before a crash / absent tracking row: retry must finish, not skip either migration.
      await db.exec('ALTER TABLE server_shares ADD COLUMN exec_granted BOOLEAN NOT NULL DEFAULT FALSE');
      await db.exec("ALTER TABLE machine_exec_audit ADD COLUMN action TEXT NOT NULL DEFAULT 'exec'");
      await db.exec('ALTER TABLE users ADD COLUMN sessions_valid_after BIGINT NOT NULL DEFAULT 0');
    } else {
      await db.exec(await readFile(`${dir}${prior}`, 'utf8'));
      await db.execute('INSERT INTO _migrations VALUES ($1,$2)', [prior, now]);
    }
    // A second owner writes while the first performs the remaining upgrade.
    await Promise.all([
      runMigrations(db),
      db.execute('INSERT INTO users (id,status,created_at) VALUES ($1,$2,$3)', ['concurrent-owner', USER_STATUS.ACTIVE, now]),
    ]);
    await runMigrations(db);
    expect((await db.query<{ name: string }>('SELECT name FROM _migrations WHERE name LIKE $1 ORDER BY name', ['100_%'])).map((r) => r.name)).toEqual([machineFile, userFile]);
    expect(await db.query('SELECT id,exec_enabled FROM servers ORDER BY id')).toEqual([
      { id: 'existing-off', exec_enabled: false }, { id: 'existing-on', exec_enabled: true },
    ]);
    expect(await db.query('SELECT id,exec_granted,revoked_at FROM server_shares ORDER BY id')).toEqual([
      { id: 'existing-share', exec_granted: false, revoked_at: null },
      { id: 'soft-deleted-share', exec_granted: false, revoked_at: now },
    ]);
    expect(await db.queryOne('SELECT outcome,action,decision FROM machine_exec_audit WHERE correlation_id=$1', ['old-audit'])).toEqual({ outcome: 'completed', action: 'exec', decision: 'allowed' });
    expect(await db.queryOne('SELECT sessions_valid_after FROM users WHERE id=$1', ['concurrent-owner'])).toEqual({ sessions_valid_after: 0 });
    await db.execute("INSERT INTO servers (id,user_id,name,token_hash,node_role,created_at,node_id) VALUES ('new-node','concurrent-owner','new','unused',$2,$1,'1000000003')", [now, NODE_ROLE.CONTROLLED]);
    expect(await db.queryOne('SELECT exec_enabled FROM servers WHERE id=$1', ['new-node'])).toEqual({ exec_enabled: false });
    await db.execute('UPDATE users SET sessions_valid_after=$2 WHERE id=$1', ['existing-owner', now]);
    await runMigrations(db);
    expect(await db.queryOne('SELECT sessions_valid_after FROM users WHERE id=$1', ['existing-owner'])).toEqual({ sessions_valid_after: now });
  } finally {
    await db.close();
    await admin.exec(`DROP DATABASE "${name}"`);
  }
});
