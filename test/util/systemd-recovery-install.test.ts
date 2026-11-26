import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  installRecoveryUnits,
  removeRecoveryUnits,
  type RecoveryUnitDeps,
} from '../../src/util/systemd-recovery-install.js';
import {
  RECOVERY_SERVICE_UNIT,
  RECOVERY_TIMER_UNIT,
  renderRecoveryExecStart,
} from '../../src/util/systemd-unit.js';

const SERVICE_DIR = '/home/tester/.config/systemd/user';
const EXEC_START = renderRecoveryExecStart('/usr/local/bin/node', '/opt/imcodes/dist/src/index.js');

function harness(seed: Record<string, string> = {}, timerEnabled = false) {
  const files = new Map<string, string>(Object.entries(seed));
  const systemctl: string[][] = [];
  const deps: RecoveryUnitDeps = {
    serviceDir: SERVICE_DIR,
    readFile: (path) => files.get(path) ?? null,
    writeFile: (path, content) => { files.set(path, content); },
    removeFile: (path) => { files.delete(path); },
    exists: (path) => files.has(path),
    isTimerEnabled: () => timerEnabled,
    runSystemctl: (args) => { systemctl.push(args); },
  };
  return { deps, files, systemctl };
}

const servicePath = join(SERVICE_DIR, RECOVERY_SERVICE_UNIT);
const timerPath = join(SERVICE_DIR, RECOVERY_TIMER_UNIT);

describe('recovery unit installation', () => {
  it('installs both units and enables the timer on a clean machine', () => {
    const h = harness();
    const outcome = installRecoveryUnits(EXEC_START, h.deps);

    expect(outcome).toEqual({ serviceWritten: true, timerWritten: true, reloaded: true, enabled: true });
    expect(h.files.get(servicePath)).toContain(`ExecStart=${EXEC_START}`);
    expect(h.files.get(timerPath)).toContain(`Unit=${RECOVERY_SERVICE_UNIT}`);
    expect(h.systemctl).toEqual([['daemon-reload'], ['enable', '--now', RECOVERY_TIMER_UNIT]]);
  });

  it('is idempotent across a repeated install or upgrade', () => {
    const h = harness();
    installRecoveryUnits(EXEC_START, h.deps);
    const before = new Map(h.files);
    h.systemctl.length = 0;

    // Second run on an already-enabled machine must touch nothing at all.
    const enabled = harness(Object.fromEntries(before), true);
    const outcome = installRecoveryUnits(EXEC_START, enabled.deps);

    expect(outcome).toEqual({ serviceWritten: false, timerWritten: false, reloaded: false, enabled: false });
    expect(enabled.systemctl).toEqual([]);
    expect(enabled.files).toEqual(before);
  });

  it('re-enables when the units are present but the timer was disabled', () => {
    const h0 = harness();
    installRecoveryUnits(EXEC_START, h0.deps);
    const h = harness(Object.fromEntries(h0.files), false);

    const outcome = installRecoveryUnits(EXEC_START, h.deps);
    expect(outcome).toMatchObject({ serviceWritten: false, timerWritten: false, reloaded: false, enabled: true });
    expect(h.systemctl).toEqual([['enable', '--now', RECOVERY_TIMER_UNIT]]);
  });

  it('rewrites and reloads when the shipped unit content changes', () => {
    const h = harness({ [servicePath]: '[Unit]\nDescription=stale\n', [timerPath]: '[Timer]\nOnUnitActiveSec=9999\n' }, true);
    const outcome = installRecoveryUnits(EXEC_START, h.deps);

    expect(outcome).toMatchObject({ serviceWritten: true, timerWritten: true, reloaded: true });
    expect(h.files.get(servicePath)).toContain(`ExecStart=${EXEC_START}`);
    expect(h.systemctl[0]).toEqual(['daemon-reload']);
  });

  it('rewrites only the unit whose content drifted', () => {
    const h0 = harness();
    installRecoveryUnits(EXEC_START, h0.deps);
    const seed = Object.fromEntries(h0.files);
    seed[servicePath] = '[Unit]\nDescription=drifted\n';
    const h = harness(seed, true);

    expect(installRecoveryUnits(EXEC_START, h.deps))
      .toMatchObject({ serviceWritten: true, timerWritten: false, reloaded: true });
  });

  it('removes both units and disables the timer', () => {
    const h0 = harness();
    installRecoveryUnits(EXEC_START, h0.deps);
    const h = harness(Object.fromEntries(h0.files), true);

    expect(removeRecoveryUnits(h.deps)).toEqual({ removed: [RECOVERY_TIMER_UNIT, RECOVERY_SERVICE_UNIT] });
    expect(h.files.has(servicePath)).toBe(false);
    expect(h.files.has(timerPath)).toBe(false);
    expect(h.systemctl).toEqual([
      ['disable', '--now', RECOVERY_TIMER_UNIT],
      ['daemon-reload'],
    ]);
  });

  it('removal is a no-op when nothing is installed', () => {
    const h = harness();
    expect(removeRecoveryUnits(h.deps)).toEqual({ removed: [] });
    expect(h.systemctl).toEqual([]);
  });

  it('does not claim installation succeeded when systemctl rejects enablement', () => {
    const h = harness();
    h.deps.runSystemctl = (args) => {
      if (args[0] === 'enable') throw new Error('systemctl denied');
    };
    expect(() => installRecoveryUnits(EXEC_START, h.deps)).toThrow('systemctl denied');
  });
});
