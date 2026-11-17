import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { HISTORY_RETENTION } from '../../src/store/history-retention.js';

const entry = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
let home: string | undefined;
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = undefined; });

describe('history CLI subprocess', () => {
  it('query/set/off persist, help explains scope, extra/invalid arguments do not mutate; no CLI SQLite writer', () => {
    home = mkdtempSync(join(tmpdir(), 'imcodes-history-cli-'));
    const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', entry, 'history', ...args], {
      env: { ...process.env, IMCODES_HOME: home!, HOME: home!, USERPROFILE: home! }, encoding: 'utf8', timeout: 20_000,
    });
    const query = run('keep');
    expect(query.status, query.stderr).toBe(0);
    expect(JSON.parse(query.stdout.trim()).keepDays).toBeNull();
    expect(existsSync(join(home, HISTORY_RETENTION.fileName))).toBe(false);
    const set = run('keep', '3');
    expect(set.status, set.stderr).toBe(0);
    expect(JSON.parse(set.stdout.trim()).keepDays).toBe(3);
    const saved = readFileSync(join(home, HISTORY_RETENTION.fileName), 'utf8');
    for (const args of [['keep', '3', 'extra'], ['keep', 'off', 'extra'], ['keep', '0'], ['keep', '-1'], ['keep', '1.1'], ['keep', 'NaN'], ['keep', '100000001']]) {
      const bad = run(...args);
      expect(bad.status, bad.stdout + bad.stderr).not.toBe(0);
      expect(readFileSync(join(home, HISTORY_RETENTION.fileName), 'utf8')).toBe(saved);
    }
    expect(JSON.parse(run('keep').stdout.trim()).keepDays).toBe(3);
    const help = run('keep', '--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('03:00');
    expect(help.stdout).toContain('JSONL');
    expect(JSON.parse(run('keep', 'off').stdout.trim()).keepDays).toBeNull();
    expect(existsSync(join(home, 'timeline.sqlite'))).toBe(false);
  }, 120_000);
});
