import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linuxControlledNodeUpgradeUnit, scheduleLinuxControlledNodeUpgrade } from '../../src/node/linux-upgrade-scheduler.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('systemd219 upgrade scheduler class', () => {
  it('escapes all systemd parsing forms without passing a path through a shell', () => {
    const unit = linuxControlledNodeUpgradeUnit('/opt/with space/%n/$VAR/quote"\\file.sh', '/run/systemd/system/own.service');
    expect(unit).toContain('ExecStart=/bin/sh "/opt/with space/%%n/$$VAR/quote\\"\\\\file.sh"');
    expect(unit).toContain('TimeoutStartSec=25min');
    expect(unit).toContain('TimeoutStopSec=5min');
    for (const invalid of ['relative', '/opt/new\nline', '/opt/new\0line', '/opt/new\rline']) {
      expect(() => linuxControlledNodeUpgradeUnit(invalid, '/run/own.service')).toThrow();
    }
  });

  it('retains an explicit scoped home in the independent cgroup, without expanding dollar variables', () => {
    const unit = linuxControlledNodeUpgradeUnit('/opt/one.sh', '/run/own.service', '/opt/scoped/%n/$HOME/"quote');
    expect(unit).toContain('Environment="IMCODES_HOME=/opt/scoped/%%n/$HOME/\\"quote"');
    const originalHome = process.env.IMCODES_HOME;
    delete process.env.IMCODES_HOME;
    try { expect(linuxControlledNodeUpgradeUnit('/opt/one.sh', '/run/own.service')).not.toContain('Environment='); }
    finally { if (originalHome !== undefined) process.env.IMCODES_HOME = originalHome; }
    for (const invalid of ['relative', '/opt/new\nline', '/opt/new\0line']) {
      expect(() => linuxControlledNodeUpgradeUnit('/opt/one.sh', '/run/own.service', invalid)).toThrow();
    }
  });

  it('never overwrites an existing generation and removes only its own unpublished file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-unit-generation-test-'));
    dirs.push(dir);
    const run = vi.fn();
    const unit = 'imcodes-node-upgrade-test';
    scheduleLinuxControlledNodeUpgrade(unit, '/opt/one.sh', run, { unitDirectory: dir });
    const original = await readFile(join(dir, unit + '.service'), 'utf8');
    expect(() => scheduleLinuxControlledNodeUpgrade(unit, '/opt/two.sh', run, { unitDirectory: dir })).toThrow();
    expect(await readFile(join(dir, unit + '.service'), 'utf8')).toBe(original);
    expect(await readdir(dir)).toEqual([unit + '.service']);
    expect(run).toHaveBeenCalledTimes(2);
    for (const invalid of ['unrelated', '../imcodes-node-upgrade-test', 'imcodes-node-upgrade-x.service', 'imcodes-node-upgrade-x\nother']) {
      expect(() => scheduleLinuxControlledNodeUpgrade(invalid, '/opt/one.sh', run, { unitDirectory: dir })).toThrow('invalid_upgrade_unit_name');
    }
  });

  it('cleans atomic publication after a start failure and retains the authoritative error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-unit-start-test-'));
    dirs.push(dir);
    const calls: string[][] = [];
    const run = (_file: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args.includes('start')) throw new Error('start denied');
    };
    expect(() => scheduleLinuxControlledNodeUpgrade('imcodes-node-upgrade-start-failure', '/opt/one.sh', run, { unitDirectory: dir })).toThrow('start denied');
    expect(await readdir(dir)).toEqual([]);
    expect(calls).toEqual([['daemon-reload'], ['--no-block', 'start', 'imcodes-node-upgrade-start-failure.service'], ['daemon-reload']]);
  });
});
