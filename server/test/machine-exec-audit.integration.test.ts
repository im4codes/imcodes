import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import {
  createMachineExecAuditIntent,
  updateMachineExecAuditResult,
} from '../src/security/machine-exec-audit.js';

let db: Database;
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  await db.close();
});

describe('durable machine exec semantic audit', () => {
  it('persists pending intent before updating the same row to a truthful outcome', async () => {
    const userId = `u_${hex(4)}`;
    const sourceServerId = `s_${hex(4)}`;
    const targetServerId = `t_${hex(4)}`;
    const correlationId = hex(16);
    await createUser(db, userId);
    await createServer(db, sourceServerId, userId, 'source', sha256(hex(16)));
    await createServer(db, targetServerId, userId, 'target', sha256(hex(16)));

    await createMachineExecAuditIntent(db, {
      correlationId,
      userId,
      sourceServerId,
      targetServerId,
      commandSha256: sha256('whoami'),
      commandLength: Buffer.byteLength('whoami', 'utf8'),
      shell: 'sh',
      now: 100,
    });
    const pending = await db.queryOne<{ outcome: string }>(
      'SELECT outcome FROM machine_exec_audit WHERE correlation_id = $1',
      [correlationId],
    );
    expect(pending?.outcome).toBe('pending');

    await expect(updateMachineExecAuditResult(db, correlationId, {
      outcome: 'completed',
      exitCode: 0,
      timedOut: false,
      durationMs: 25,
      now: 125,
    })).resolves.toBe(true);
    const done = await db.queryOne<{ outcome: string; exit_code: number; duration_ms: number }>(
      'SELECT outcome, exit_code, duration_ms FROM machine_exec_audit WHERE correlation_id = $1',
      [correlationId],
    );
    expect(done).toEqual({ outcome: 'completed', exit_code: 0, duration_ms: 25 });
  });

  it('rejects duplicate correlation intent instead of producing two audit rows', async () => {
    const userId = `u_${hex(4)}`;
    const sourceServerId = `s_${hex(4)}`;
    const targetServerId = `t_${hex(4)}`;
    const correlationId = hex(16);
    await createUser(db, userId);
    await createServer(db, sourceServerId, userId, 'source', sha256(hex(16)));
    await createServer(db, targetServerId, userId, 'target', sha256(hex(16)));
    const intent = {
      correlationId,
      userId,
      sourceServerId,
      targetServerId,
      commandSha256: sha256('id'),
      commandLength: 2,
      shell: 'sh',
      now: 200,
    };
    await createMachineExecAuditIntent(db, intent);
    await expect(createMachineExecAuditIntent(db, intent)).rejects.toThrow();
  });
});
