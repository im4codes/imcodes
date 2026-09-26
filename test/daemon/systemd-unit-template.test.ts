import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  RECOVERY_CHECK_INTERVAL_SEC,
  RECOVERY_SERVICE_UNIT,
  RECOVERY_TIMER_UNIT,
  SYSTEMD_START_LIMIT_BURST,
  SYSTEMD_START_LIMIT_INTERVAL_SEC,
  boundedStartAttempts,
  renderRecoveryExecStart,
  renderRecoveryService,
  renderRecoveryTimer,
  renderSystemdStartLimitBlock,
  renderSystemdTerminalDiagnostics,
  unboundedStartAttemptsPerDay,
} from '../../src/util/systemd-unit.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The `[Unit]` section of the unit template literal in an installer flow. */
function unitSection(relativePath: string): string {
  const source = readFileSync(join(repoRoot, relativePath), 'utf8');
  const start = source.indexOf('const unit = `[Unit]');
  expect(start, `${relativePath} must render a unit template`).toBeGreaterThan(-1);
  const serviceIndex = source.indexOf('[Service]', start);
  expect(serviceIndex, `${relativePath} must have a [Service] section`).toBeGreaterThan(-1);
  return source.slice(start, serviceIndex);
}

function serviceSection(relativePath: string): string {
  const source = readFileSync(join(repoRoot, relativePath), 'utf8');
  const serviceIndex = source.indexOf('[Service]', source.indexOf('const unit = `[Unit]'));
  return source.slice(serviceIndex, source.indexOf('`;', serviceIndex));
}

const INSTALLERS = ['src/bind/bind-flow.ts', 'src/setup/setup-flow.ts'];

describe('Linux unit templates', () => {
  it.each(INSTALLERS)('%s bounds restart authority inside [Unit]', (relativePath) => {
    // systemd >= 230 only honours StartLimit* in [Unit]; in [Service] they are
    // silently ignored, which is indistinguishable from having no bound at all.
    expect(unitSection(relativePath)).toContain('${renderSystemdStartLimitBlock()}');
    expect(serviceSection(relativePath)).not.toContain('StartLimit');
  });

  it.each(INSTALLERS)('%s keeps KillMode=control-group', (relativePath) => {
    // Residual cgroup members are exactly what leaves a unit falsely active.
    expect(serviceSection(relativePath)).toContain('KillMode=control-group');
  });

  it.each(INSTALLERS)('%s records terminal diagnostics', (relativePath) => {
    expect(serviceSection(relativePath)).toContain('${renderSystemdTerminalDiagnostics()}');
  });

  it.each(INSTALLERS)('%s still declares a restart policy and spacing', (relativePath) => {
    const service = serviceSection(relativePath);
    expect(service).toMatch(/Restart=(always|on-failure)/);
    expect(service).toContain('RestartSec=5');
  });

  it('renders both StartLimit directives', () => {
    expect(renderSystemdStartLimitBlock()).toBe(
      `StartLimitIntervalSec=${SYSTEMD_START_LIMIT_INTERVAL_SEC}\nStartLimitBurst=${SYSTEMD_START_LIMIT_BURST}`,
    );
  });

  it('exports the three variables systemd only provides to ExecStopPost', () => {
    const diagnostics = renderSystemdTerminalDiagnostics();
    expect(diagnostics.startsWith('ExecStopPost=')).toBe(true);
    for (const variable of ['$SERVICE_RESULT', '$EXIT_CODE', '$EXIT_STATUS']) {
      expect(diagnostics).toContain(variable);
    }
  });

  it('proves an unrecoverable launch cannot loop thousands of times', () => {
    // Without a start limit, RestartSec=5 alone yields 17280 executions per day.
    expect(unboundedStartAttemptsPerDay(5)).toBe(17_280);
    expect(boundedStartAttempts()).toBe(SYSTEMD_START_LIMIT_BURST);
    expect(boundedStartAttempts()).toBeLessThan(10);
    // The bound is absolute, not a rate: systemd fails the unit and stops.
    expect(boundedStartAttempts()).toBeLessThan(unboundedStartAttemptsPerDay(5) / 1000);
  });
});

describe('shipped recovery trigger units', () => {
  const execStart = renderRecoveryExecStart('/usr/local/bin/node', '/opt/imcodes/dist/src/index.js');

  it('invokes the daemon entry directly, not the self-healing launcher', () => {
    // The launcher may reinstall dependencies; that is right for a long-lived
    // daemon and wrong for a diagnostic that runs every couple of minutes.
    expect(execStart).toBe('/usr/local/bin/node /opt/imcodes/dist/src/index.js recover-service');
    expect(execStart).not.toContain('imcodes-launch.sh');
  });

  it('quotes spaces and neutralizes systemd percent specifiers in executable paths', () => {
    expect(renderRecoveryExecStart('/opt/Node Runtime/node', '/home/a%user/IM codes/index.js')).toBe(
      '"/opt/Node Runtime/node" "/home/a%%user/IM codes/index.js" recover-service',
    );
  });

  it('runs the check as a bounded oneshot', () => {
    const unit = renderRecoveryService(execStart);
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain(`ExecStart=${execStart}`);
    // The check itself must never become a restart source.
    expect(unit).not.toContain('Restart=always');
    expect(unit).not.toContain('Restart=on-failure');
  });

  it('bounds the check unit and gives it terminal diagnostics', () => {
    const unit = renderRecoveryService(execStart);
    const unitSectionText = unit.slice(0, unit.indexOf('[Service]'));
    expect(unitSectionText).toContain(`StartLimitIntervalSec=${SYSTEMD_START_LIMIT_INTERVAL_SEC}`);
    expect(unitSectionText).toContain(`StartLimitBurst=${SYSTEMD_START_LIMIT_BURST}`);
    expect(unit).toContain('ExecStopPost=');
  });

  it('drives the check from a timer, not a busy loop', () => {
    const timer = renderRecoveryTimer();
    expect(timer).toContain(`Unit=${RECOVERY_SERVICE_UNIT}`);
    expect(timer).toContain(`OnUnitActiveSec=${RECOVERY_CHECK_INTERVAL_SEC}`);
    expect(timer).toContain('WantedBy=timers.target');
    // A sub-minute cadence would be polling rather than a wedge-breaker.
    expect(RECOVERY_CHECK_INTERVAL_SEC).toBeGreaterThanOrEqual(60);
  });

  it('names the pair consistently', () => {
    expect(RECOVERY_SERVICE_UNIT).toBe('imcodes-recovery.service');
    expect(RECOVERY_TIMER_UNIT).toBe('imcodes-recovery.timer');
    expect(renderRecoveryTimer()).toContain(RECOVERY_SERVICE_UNIT);
  });
});

describe('installers ship the recovery trigger', () => {
  it.each(INSTALLERS)('%s installs the recovery units', (relativePath) => {
    const source = readFileSync(join(repoRoot, relativePath), 'utf8');
    expect(source).toContain('installRecoveryUnits(renderRecoveryExecStart(');
  });
});
