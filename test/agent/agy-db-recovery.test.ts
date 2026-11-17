import { createRequire } from 'node:module';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agyConversationDbPath,
  createDumpCommitRewriteTransform,
  isValidAgyConversationId,
  recoverAgyConversationDbIfCorrupt,
} from '../../src/agent/agy-db-recovery.js';
import { AgyAcpProvider } from '../../src/agent/providers/agy-acp.js';
import { AGY_ACP_AGENT_NAME } from '../../shared/agy-agent.js';
import { suppressSqliteExperimentalWarning } from '../../src/util/suppress-sqlite-warning.js';
import logger from '../../src/util/logger.js';

const { DatabaseSync } = (() => {
  suppressSqliteExperimentalWarning();
  return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
})();

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const WAIT_FOR_TIMEOUT_MS = 15_000;

const tempRoots: string[] = [];
const providers: AgyAcpProvider[] = [];

afterEach(async () => {
  for (const p of providers.splice(0)) {
    await p.disconnect();
  }
  for (const dir of tempRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function makeTempHome(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'imcodes-agy-db-recovery-'));
  tempRoots.push(root);
  return root;
}

function seedConversationDb(dbPath: string, conversationId: string, rowCount = 250): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      'PRAGMA journal_mode=WAL; '
      + 'CREATE TABLE trajectory_meta(cascade_id TEXT); '
      + 'CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, error_details BLOB, step_payload BLOB);',
    );
    db.prepare('INSERT INTO trajectory_meta VALUES (?)').run(conversationId);
    const insert = db.prepare('INSERT INTO steps VALUES (?, 14, 3, ?, NULL, ?)');
    for (let i = 1; i <= rowCount; i++) {
      insert.run(i, Buffer.from(`meta-${i}`), Buffer.from(`payload-${i}-${'x'.repeat(256)}`));
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } finally {
    db.close();
  }
}

function corruptLastDatabasePage(dbPath: string): void {
  const buf = Buffer.from(readFileSync(dbPath));
  expect(buf.length).toBeGreaterThanOrEqual(8192);
  // Corrupt the B-tree page header & initial cells of the last 4KB page (keeping sqlite_schema on page 1 intact).
  const start = buf.length - 4096;
  buf.fill(0xff, start, start + 128);
  writeFileSync(dbPath, buf);
}

async function setupFakeAgyProvider(home: string, opts?: { failSecondResume?: boolean }) {
  const binPath = path.join(home, 'agy');
  const rpcLogPath = path.join(home, 'rpc.jsonl');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');

const logPath = process.env.TEST_RPC_LOG;
const failSecond = process.env.TEST_FAIL_SECOND_RESUME === '1';
const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\\n');
const record = (obj) => fs.appendFileSync(logPath, JSON.stringify(obj) + '\\n');

if (process.argv.includes('--version')) {
  console.log('1.5.6');
  process.exit(0);
}

let resumeCount = 0;

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  record({ method: req.method, params: req.params });
  switch (req.method) {
    case 'initialize':
      return send({
        id: req.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: ${JSON.stringify(AGY_ACP_AGENT_NAME)}, version: '1.5.6' },
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { resume: {}, close: {}, list: {} },
          },
        },
      });
    case 'session/resume': {
      resumeCount += 1;
      if (failSecond && resumeCount >= 2) {
        return send({ id: req.id, error: { code: -32603, message: 'persistent resume failure after heal' } });
      }
      const dbPath = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'conversations', req.params.sessionId + '.db');
      if (!fs.existsSync(dbPath)) {
        return send({ id: req.id, error: { code: -32603, message: 'conversation not found' } });
      }
      let db;
      try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        const qc = db.prepare('PRAGMA quick_check').all();
        if (qc.length !== 1 || qc[0].quick_check !== 'ok') {
          throw new Error('database disk image is malformed');
        }
        const row = db.prepare('SELECT COUNT(*) AS cnt FROM steps').get();
        if (!row || typeof row.cnt !== 'number') {
          throw new Error('missing steps');
        }
      } catch (err) {
        return send({ id: req.id, error: { code: -32603, message: 'sqlite3.DatabaseError: ' + err.message } });
      } finally {
        try { db && db.close(); } catch {}
      }
      return send({
        id: req.id,
        result: {
          sessionId: req.params.sessionId,
          models: {
            currentModelId: 'gemini-4-hydrogen-high',
            availableModels: [{ modelId: 'gemini-4-hydrogen-high', name: 'Gemini 4' }],
          },
        },
      });
    }
    case 'session/new':
      return send({ id: req.id, error: { code: -32603, message: 'session/new must not be called on resume failure' } });
    case 'session/set_model':
    case 'session/set_mode':
    case 'session/close':
      return send({ id: req.id, result: {} });
    case 'session/prompt': {
      send({
        method: 'session/update',
        params: {
          sessionId: req.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'RESUMED_OK' } },
        },
      });
      return send({
        id: req.id,
        result: { stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 4 } },
      });
    }
    default:
      return send({ id: req.id, result: {} });
  }
});
`;
  await writeFile(binPath, script, { mode: 0o700 });
  const provider = new AgyAcpProvider();
  providers.push(provider);
  await provider.connect({
    binaryPath: binPath,
    env: {
      HOME: home,
      TEST_RPC_LOG: rpcLogPath,
      ...(opts?.failSecondResume ? { TEST_FAIL_SECOND_RESUME: '1' } : {}),
    },
  });
  const readRpcMethods = async () => {
    const raw = await readFile(rpcLogPath, 'utf8').catch(() => '');
    return raw.trim().split('\n').filter(Boolean).map((l: string) => JSON.parse(l) as { method: string; params: Record<string, unknown> });
  };
  return { provider, readRpcMethods };
}

describe('Antigravity conversation DB self-healing', () => {
  it('validates UUID conversation IDs and DB paths safely', () => {
    expect(isValidAgyConversationId(VALID_UUID)).toBe(true);
    expect(isValidAgyConversationId('not-a-uuid')).toBe(false);
    expect(isValidAgyConversationId('../../evil')).toBe(false);
    expect(agyConversationDbPath('relative', VALID_UUID)).toBeUndefined();
    expect(agyConversationDbPath('/tmp/test-home', '../escape')).toBeUndefined();
    expect(agyConversationDbPath('/tmp/test-home', VALID_UUID)).toBe(
      path.join('/tmp/test-home', '.gemini', 'antigravity-cli', 'conversations', `${VALID_UUID}.db`),
    );
  });

  it('recovers a corrupted SQLite conversation DB via sqlite3 .recover, restores WAL, removes stale wal/shm, and backs up outside .db suffix', async () => {
    const home = await makeTempHome();
    const dbPath = agyConversationDbPath(home, VALID_UUID)!;
    await mkdir(path.dirname(dbPath), { recursive: true });
    seedConversationDb(dbPath, VALID_UUID, 250);
    corruptLastDatabasePage(dbPath);
    // Simulate leftover stale WAL/SHM from crashed process
    await writeFile(`${dbPath}-wal`, Buffer.alloc(64, 0xaa));
    await writeFile(`${dbPath}-shm`, Buffer.alloc(64, 0xbb));

    const res = await recoverAgyConversationDbIfCorrupt(dbPath);
    expect(res).toEqual({ recovered: true, reason: 'recovered' });

    expect(existsSync(`${dbPath}.corrupt`)).toBe(true);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    const convFiles = readdirSync(path.dirname(dbPath));
    expect(convFiles.filter((f) => f.endsWith('.db'))).toEqual([`${VALID_UUID}.db`]);
    expect(convFiles.some((f) => f.includes('.tmp'))).toBe(false);

    if (process.platform !== 'win32') {
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      expect(statSync(`${dbPath}.corrupt`).mode & 0o777).toBe(0o600);
    }

    const recoveredDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(recoveredDb.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      expect(recoveredDb.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
      expect(recoveredDb.prepare('SELECT cascade_id FROM trajectory_meta').all()).toEqual([{ cascade_id: VALID_UUID }]);
      const cnt = (recoveredDb.prepare('SELECT COUNT(*) AS cnt FROM steps').get() as { cnt: number }).cnt;
      expect(cnt).toBeGreaterThan(200);
    } finally {
      recoveredDb.close();
    }
  });

  it('automatically self-heals in AgyAcpProvider and retries session/resume once without falling back to newSession', async () => {
    const home = await makeTempHome();
    const dbPath = agyConversationDbPath(home, VALID_UUID)!;
    await mkdir(path.dirname(dbPath), { recursive: true });
    seedConversationDb(dbPath, VALID_UUID, 250);
    corruptLastDatabasePage(dbPath);

    const { provider, readRpcMethods } = await setupFakeAgyProvider(home);
    const complete = vi.fn();
    const errors = vi.fn();
    provider.onComplete(complete);
    provider.onError(errors);

    const sessionId = await provider.createSession({
      sessionKey: 'deck_test_agy_self_heal',
      sessionName: 'deck_test_agy_self_heal',
      cwd: process.cwd(),
      resumeId: VALID_UUID,
    });

    await provider.send(sessionId, 'continue after crash');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: WAIT_FOR_TIMEOUT_MS });
    expect(complete.mock.calls[0]?.[1].content).toBe('RESUMED_OK');
    expect(errors).not.toHaveBeenCalled();

    const rpcs = await readRpcMethods();
    expect(rpcs.filter((r) => r.method === 'session/resume')).toHaveLength(2);
    expect(rpcs.some((r) => r.method === 'session/new')).toBe(false);
    expect(existsSync(`${dbPath}.corrupt`)).toBe(true);
  });

  it('does not rewrite a healthy DB or retry when resumeSession fails for another reason', async () => {
    const home = await makeTempHome();
    const dbPath = agyConversationDbPath(home, VALID_UUID)!;
    await mkdir(path.dirname(dbPath), { recursive: true });
    seedConversationDb(dbPath, VALID_UUID, 40);
    const beforeBytes = readFileSync(dbPath);
    const beforeIno = statSync(dbPath).ino;

    const { provider, readRpcMethods } = await setupFakeAgyProvider(home, { failSecondResume: true });
    // Force first resumeSession to fail even though DB is healthy
    const sessionId = await provider.createSession({
      sessionKey: 'deck_test_agy_healthy_noop',
      sessionName: 'deck_test_agy_healthy_noop',
      cwd: process.cwd(),
      resumeId: VALID_UUID,
    });
    await (provider as any).startPerSessionAcpServer(sessionId, (provider as any).sessions.get(sessionId));
    const conn = (provider as any).sessions.get(sessionId).isolatedTransport.connection;
    const resumeSpy = vi.spyOn(conn, 'resumeSession').mockRejectedValue(
      Object.assign(new Error('auth expired'), { code: -32603 }),
    );

    await expect(provider.send(sessionId, 'hello')).rejects.toBeTruthy();
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(readFileSync(dbPath)).toEqual(beforeBytes);
    expect(statSync(dbPath).ino).toBe(beforeIno);
    expect(existsSync(`${dbPath}.corrupt`)).toBe(false);
    expect((await readRpcMethods()).some((r) => r.method === 'session/new')).toBe(false);
  });

  it('does nothing when conversation DB is missing on disk and does not fall back to newSession', async () => {
    const home = await makeTempHome();
    const dbPath = agyConversationDbPath(home, VALID_UUID)!;

    const { provider, readRpcMethods } = await setupFakeAgyProvider(home);
    const sessionId = await provider.createSession({
      sessionKey: 'deck_test_agy_missing_db',
      sessionName: 'deck_test_agy_missing_db',
      cwd: process.cwd(),
      resumeId: VALID_UUID,
    });

    await expect(provider.send(sessionId, 'hello')).rejects.toBeTruthy();
    const rpcs = await readRpcMethods();
    expect(rpcs.filter((r) => r.method === 'session/resume')).toHaveLength(1);
    expect(rpcs.some((r) => r.method === 'session/new')).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}.corrupt`)).toBe(false);
  });

  it('never touches real HOME DB for incognito sessions', async () => {
    const home = await makeTempHome();
    const dbPath = agyConversationDbPath(home, VALID_UUID)!;
    await mkdir(path.dirname(dbPath), { recursive: true });
    seedConversationDb(dbPath, VALID_UUID, 60);
    corruptLastDatabasePage(dbPath);
    const beforeBytes = readFileSync(dbPath);

    const { provider } = await setupFakeAgyProvider(home);
    const sessionId = await provider.createSession({
      sessionKey: 'deck_test_agy_incognito',
      sessionName: 'deck_test_agy_incognito',
      cwd: process.cwd(),
      incognito: true,
    });
    const state = (provider as any).sessions.get(sessionId);
    state.acpSessionId = VALID_UUID;
    const fakeConn = {
      resumeSession: vi.fn().mockRejectedValue(new Error('incognito resume forbidden')),
    };

    await expect((provider as any).resumeOrLoadAcpSession(sessionId, state, fakeConn)).rejects.toThrow('incognito resume forbidden');
    expect(fakeConn.resumeSession).toHaveBeenCalledTimes(1);
    expect(readFileSync(dbPath)).toEqual(beforeBytes);
    expect(existsSync(`${dbPath}.corrupt`)).toBe(false);
  });

  it('deduplicates concurrent recoveries for the same conversation DB without racing', async () => {
    const home = await makeTempHome();
    const dbPath = agyConversationDbPath(home, VALID_UUID)!;
    await mkdir(path.dirname(dbPath), { recursive: true });
    seedConversationDb(dbPath, VALID_UUID, 250);
    corruptLastDatabasePage(dbPath);

    const results = await Promise.all([
      recoverAgyConversationDbIfCorrupt(dbPath),
      recoverAgyConversationDbIfCorrupt(dbPath),
      recoverAgyConversationDbIfCorrupt(dbPath),
      recoverAgyConversationDbIfCorrupt(dbPath),
      recoverAgyConversationDbIfCorrupt(dbPath),
    ]);
    expect(results.every((r) => r.recovered && r.reason === 'recovered')).toBe(true);
    expect(readdirSync(path.dirname(dbPath)).some((f) => f.includes('.tmp'))).toBe(false);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
      expect((db.prepare('SELECT COUNT(*) AS cnt FROM steps').get() as { cnt: number }).cnt).toBeGreaterThan(200);
    } finally {
      db.close();
    }
  });

  it('handles sqlite3 ENOENT, timeout, and unrecoverable garbage gracefully without modifying the DB or leaking temp files', async () => {
    const home = await makeTempHome();
    const dbPath = agyConversationDbPath(home, VALID_UUID)!;
    await mkdir(path.dirname(dbPath), { recursive: true });
    seedConversationDb(dbPath, VALID_UUID, 200);
    corruptLastDatabasePage(dbPath);
    const corruptBytes = readFileSync(dbPath);

    // 1. Missing sqlite3 binary
    const enoentRes = await recoverAgyConversationDbIfCorrupt(dbPath, { sqliteBinary: path.join(home, 'missing-sqlite3') });
    expect(enoentRes).toMatchObject({ recovered: false, reason: 'sqlite3_enoent', failedStep: 'recover' });
    expect(readFileSync(dbPath)).toEqual(corruptBytes);
    expect(existsSync(`${dbPath}.corrupt`)).toBe(false);
    expect(readdirSync(path.dirname(dbPath)).some((f) => f.includes('.tmp'))).toBe(false);

    // 2. Timeout sqlite3 binary
    const slowBin = path.join(home, 'slow-sqlite3');
    await writeFile(slowBin, '#!/bin/sh\nsleep 5\n', { mode: 0o700 });
    chmodSync(slowBin, 0o700);
    const timeoutRes = await recoverAgyConversationDbIfCorrupt(dbPath, { sqliteBinary: slowBin, timeoutMs: 150 });
    expect(timeoutRes).toMatchObject({ recovered: false, reason: 'sqlite3_timeout', failedStep: 'recover' });
    expect(readFileSync(dbPath)).toEqual(corruptBytes);
    expect(readdirSync(path.dirname(dbPath)).some((f) => f.includes('.tmp'))).toBe(false);

    // 3. Unrecoverable non-SQLite garbage
    const garbageUuid = '22222222-2222-4222-8222-222222222222';
    const garbagePath = agyConversationDbPath(home, garbageUuid)!;
    await writeFile(garbagePath, 'totally corrupted non-sqlite payload');
    const garbageRes = await recoverAgyConversationDbIfCorrupt(garbagePath);
    expect(garbageRes).toMatchObject({ recovered: false, reason: 'sqlite3_failed' });
    expect(garbageRes.failedStep).toMatch(/^(recover|import)$/);
    expect(JSON.stringify(garbageRes)).not.toContain(home);
    expect(existsSync(`${garbagePath}.corrupt`)).toBe(false);
    expect(readdirSync(path.dirname(garbagePath)).some((f) => f.includes('.tmp'))).toBe(false);
  });

  it('recovers when sqlite3 .recover emits valid SQL and exits 1, while failing with privacy-safe diagnostics when exit-1 output is empty/invalid', async () => {
    const home = await makeTempHome();
    const validUuid = VALID_UUID;
    const validDbPath = agyConversationDbPath(home, validUuid)!;
    await mkdir(path.dirname(validDbPath), { recursive: true });
    seedConversationDb(validDbPath, validUuid, 220);
    corruptLastDatabasePage(validDbPath);

    // Wrapper simulating Apple sqlite3 returning exit code 1 after printing recovered SQL + path-bearing stderr
    const wrapperValidBin = path.join(home, 'sqlite3-exit1-valid');
    await writeFile(
      wrapperValidBin,
      [
        '#!/bin/sh',
        'for arg in "$@"; do',
        '  if [ "$arg" = ".recover" ]; then',
        '    sqlite3 "$@"',
        `    echo "Error: database disk image is malformed in ${validDbPath}" >&2`,
        '    exit 1',
        '  fi',
        'done',
        'exec sqlite3 "$@"',
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    chmodSync(wrapperValidBin, 0o700);

    const recoveredRes = await recoverAgyConversationDbIfCorrupt(validDbPath, { sqliteBinary: wrapperValidBin });
    expect(recoveredRes).toEqual({ recovered: true, reason: 'recovered' });
    const recoveredDb = new DatabaseSync(validDbPath, { readOnly: true });
    try {
      expect(recoveredDb.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      expect(recoveredDb.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
      expect((recoveredDb.prepare('SELECT COUNT(*) AS cnt FROM steps').get() as { cnt: number }).cnt).toBeGreaterThan(150);
    } finally {
      recoveredDb.close();
    }

    // Wrapper exiting 1 with empty/invalid output -> must fail with sqlite3_failed + privacy-safe diagnostics
    const invalidUuid = '44444444-4444-4444-8444-444444444444';
    const invalidDbPath = agyConversationDbPath(home, invalidUuid)!;
    seedConversationDb(invalidDbPath, invalidUuid, 120);
    corruptLastDatabasePage(invalidDbPath);

    const wrapperEmptyBin = path.join(home, 'sqlite3-exit1-empty');
    await writeFile(
      wrapperEmptyBin,
      [
        '#!/bin/sh',
        'for arg in "$@"; do',
        '  if [ "$arg" = ".recover" ]; then',
        `    echo "SQLITE_CORRUPT at ${invalidDbPath}: page 2 unusable" >&2`,
        '    exit 1',
        '  fi',
        'done',
        'exec sqlite3 "$@"',
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    chmodSync(wrapperEmptyBin, 0o700);

    const failedRes = await recoverAgyConversationDbIfCorrupt(invalidDbPath, { sqliteBinary: wrapperEmptyBin });
    expect(failedRes).toMatchObject({
      recovered: false,
      reason: 'sqlite3_failed',
      failedStep: 'recover',
      exitCode: 1,
    });
    expect(failedRes.stderrSummary).toContain('SQLITE_CORRUPT');
    expect(failedRes.stderrSummary).toContain('[path]');
    expect(JSON.stringify(failedRes)).not.toContain(home);
    expect(JSON.stringify(failedRes)).not.toContain(invalidDbPath);
  });

  it('falls back to sqlite3 .dump rewriting ROLLBACK when .recover is unsupported (even with stale WAL/SHM), while keeping garbage -> sqlite3_failed', async () => {
    const home = await makeTempHome();
    const dbPath = agyConversationDbPath(home, VALID_UUID)!;
    await mkdir(path.dirname(dbPath), { recursive: true });
    seedConversationDb(dbPath, VALID_UUID, 250);
    corruptLastDatabasePage(dbPath);
    await writeFile(`${dbPath}-wal`, Buffer.alloc(64, 0xaa));
    await writeFile(`${dbPath}-shm`, Buffer.alloc(64, 0xbb));

    const wrapperNoRecover = path.join(home, 'sqlite3-no-recover');
    await writeFile(
      wrapperNoRecover,
      [
        '#!/bin/sh',
        'for arg in "$@"; do',
        '  if [ "$arg" = ".recover" ]; then',
        '    echo \'Error: unknown command or invalid arguments: "recover". Enter ".help" for help\' >&2',
        '    exit 1',
        '  fi',
        'done',
        'exec sqlite3 "$@"',
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    chmodSync(wrapperNoRecover, 0o700);

    const recoveredRes = await recoverAgyConversationDbIfCorrupt(dbPath, { sqliteBinary: wrapperNoRecover });
    expect(recoveredRes).toEqual({ recovered: true, reason: 'recovered' });
    expect(existsSync(`${dbPath}.corrupt`)).toBe(true);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(readdirSync(path.dirname(dbPath)).some((f) => f.includes('.tmp'))).toBe(false);

    const recoveredDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(recoveredDb.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      expect(recoveredDb.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
      expect(recoveredDb.prepare('SELECT cascade_id FROM trajectory_meta').all()).toEqual([{ cascade_id: VALID_UUID }]);
      expect((recoveredDb.prepare('SELECT COUNT(*) AS cnt FROM steps').get() as { cnt: number }).cnt).toBeGreaterThan(200);
    } finally {
      recoveredDb.close();
    }

    // Non-SQLite garbage via the same .recover-less sqlite3 wrapper MUST still return sqlite3_failed without leaving temp files.
    const garbageUuid = '55555555-5555-4555-8555-555555555555';
    const garbagePath = agyConversationDbPath(home, garbageUuid)!;
    await writeFile(garbagePath, 'totally corrupted non-sqlite payload');
    const garbageBefore = readFileSync(garbagePath);
    const garbageRes = await recoverAgyConversationDbIfCorrupt(garbagePath, { sqliteBinary: wrapperNoRecover });
    expect(garbageRes).toMatchObject({ recovered: false, reason: 'sqlite3_failed' });
    expect(readFileSync(garbagePath)).toEqual(garbageBefore);
    expect(existsSync(`${garbagePath}.corrupt`)).toBe(false);
    expect(readdirSync(path.dirname(garbagePath)).some((f) => f.includes('.tmp'))).toBe(false);
  });

  it('createDumpCommitRewriteTransform rewrites ROLLBACK footer safely across arbitrary byte/UTF-8 chunk splits', async () => {
    const input = [
      'PRAGMA foreign_keys=OFF;',
      'BEGIN TRANSACTION;',
      "INSERT INTO steps VALUES(1,'hello 🚀 ROLLBACK; -- due to errors inline');",
      '/****** CORRUPTION ERROR *******/',
      'ROLLBACK; -- due to errors',
      '',
    ].join('\n');
    const bytes = Buffer.from(input, 'utf8');
    // Feed 3-byte chunks to split both multi-byte emoji UTF-8 and the footer line mid-token.
    const chunks: Buffer[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
      chunks.push(bytes.subarray(i, i + 3));
    }
    const transform = createDumpCommitRewriteTransform();
    const outChunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      Readable.from(chunks)
        .pipe(transform)
        .on('data', (c: Buffer | string) => outChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
        .on('end', resolve)
        .on('error', reject);
    });
    const output = Buffer.concat(outChunks).toString('utf8');
    expect(output).toBe([
      'PRAGMA foreign_keys=OFF;',
      'BEGIN TRANSACTION;',
      "INSERT INTO steps VALUES(1,'hello 🚀 ROLLBACK; -- due to errors inline');",
      '/****** CORRUPTION ERROR *******/',
      'COMMIT;',
      '',
    ].join('\n'));
  });

  it('retries at most once when retried session/resume still fails and logs privacy-safe diagnostics on recovery failure', async () => {
    const home = await makeTempHome();
    const dbPath = agyConversationDbPath(home, VALID_UUID)!;
    await mkdir(path.dirname(dbPath), { recursive: true });
    seedConversationDb(dbPath, VALID_UUID, 250);
    corruptLastDatabasePage(dbPath);

    // Part A: recovery succeeds, retried session/resume still fails -> max 2 calls (1 retry, no loop, no newSession)
    const { provider, readRpcMethods } = await setupFakeAgyProvider(home, { failSecondResume: true });
    const sessionId = await provider.createSession({
      sessionKey: 'deck_test_agy_retry_once',
      sessionName: 'deck_test_agy_retry_once',
      cwd: process.cwd(),
      resumeId: VALID_UUID,
    });
    await expect(provider.send(sessionId, 'hello')).rejects.toBeTruthy();
    const rpcs = await readRpcMethods();
    expect(rpcs.filter((r) => r.method === 'session/resume')).toHaveLength(2);
    expect(rpcs.some((r) => r.method === 'session/new')).toBe(false);

    // Part B: unrecoverable DB -> logs privacy-safe reason without leaking paths
    const garbageUuid = '33333333-3333-4333-8333-333333333333';
    const garbagePath = agyConversationDbPath(home, garbageUuid)!;
    await writeFile(garbagePath, 'not a database');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const sessionId2 = await provider.createSession({
      sessionKey: 'deck_test_agy_unrecoverable',
      sessionName: 'deck_test_agy_unrecoverable',
      cwd: process.cwd(),
      resumeId: garbageUuid,
    });
    await expect(provider.send(sessionId2, 'hello')).rejects.toBeTruthy();
    const warnCall = warnSpy.mock.calls.find(([fields]) => (fields as Record<string, unknown>)?.recoveryReason === 'sqlite3_failed');
    expect(warnCall).toBeTruthy();
    expect((warnCall?.[0] as Record<string, unknown>)?.recoveryFailedStep).toMatch(/^(recover|import)$/);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(home);
  });
});
