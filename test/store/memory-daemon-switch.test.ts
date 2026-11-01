import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getMemoryDaemonSwitchStatus,
  isMemoryDaemonEnabled,
  setMemoryDaemonEnabled,
} from '../../src/store/memory-daemon-switch.js';

const originalPath = process.env.IMCODES_MEMORY_DAEMON_SWITCH_PATH;

afterEach(() => {
  if (originalPath === undefined) delete process.env.IMCODES_MEMORY_DAEMON_SWITCH_PATH;
  else process.env.IMCODES_MEMORY_DAEMON_SWITCH_PATH = originalPath;
});

describe('persistent daemon memory switch', () => {
  it('defaults enabled, persists disable/enable, and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-memory-switch-'));
    const path = join(dir, 'state', 'memory-switch.json');
    process.env.IMCODES_MEMORY_DAEMON_SWITCH_PATH = path;

    expect(isMemoryDaemonEnabled()).toBe(true);
    expect(setMemoryDaemonEnabled(false).enabled).toBe(false);
    expect(isMemoryDaemonEnabled()).toBe(false);
    expect(setMemoryDaemonEnabled(false).enabled).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8')).enabled).toBe(false);
    expect(setMemoryDaemonEnabled(true).enabled).toBe(true);
    expect(isMemoryDaemonEnabled()).toBe(true);
    expect(getMemoryDaemonSwitchStatus().path).toBe(path);
  });

  it('fails safely to enabled for malformed state and does not delete it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-memory-switch-'));
    const path = join(dir, 'memory-switch.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, '{not-json', 'utf8');
    process.env.IMCODES_MEMORY_DAEMON_SWITCH_PATH = path;
    expect(isMemoryDaemonEnabled()).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('{not-json');
  });
});
