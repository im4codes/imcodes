import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, linkSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  CONTROLLED_NODE_POSIX_UPGRADE_SCRIPT_STOP_TIMEOUT_MIN,
  CONTROLLED_NODE_POSIX_UPGRADE_SCRIPT_TIMEOUT_MIN,
  CONTROLLED_NODE_SERVICE,
} from '../../shared/controlled-node-service.js';
import { shellQuote } from '../util/shell-quote.js';

const SYSTEM_UNIT_DIRECTORY = '/run/systemd/system';

function systemdArgument(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('invalid_systemd_unit_argument');
  // Exec* uses systemd's parser, NOT shell parsing; escape specifiers/env too.
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

/** Static units use the stable 219 grammar, not systemd-run's versioned property allowlist. */
export function linuxControlledNodeUpgradeUnit(
  scriptPath: string, unitPath: string, imcodesHome = process.env.IMCODES_HOME,
): string {
  if (!isAbsolute(scriptPath) || !isAbsolute(unitPath)) throw new Error('upgrade_unit_requires_absolute_paths');
  if (imcodesHome !== undefined && (!isAbsolute(imcodesHome) || /[\r\n\0]/.test(imcodesHome))) {
    throw new Error('upgrade_unit_requires_absolute_imcodes_home');
  }
  const environment = imcodesHome === undefined ? ''
    : `Environment="IMCODES_HOME=${imcodesHome.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"\n`;
  return `[Unit]
Description=IM.codes isolated controlled-node upgrade
[Service]
Type=oneshot
${environment}ExecStart=/bin/sh ${systemdArgument(scriptPath)}
TimeoutStartSec=${CONTROLLED_NODE_POSIX_UPGRADE_SCRIPT_TIMEOUT_MIN}min
TimeoutStopSec=${CONTROLLED_NODE_POSIX_UPGRADE_SCRIPT_STOP_TIMEOUT_MIN}min
# Remove only this generation's runtime definition, including timeout/failure.
ExecStopPost=/bin/sh -c ${systemdArgument(`/bin/rm -f -- ${shellQuote(unitPath)}; /bin/systemctl daemon-reload`)}
`;
}

/**
 * Independently owned cgroup, atomically published exclusive generation, bounded
 * start/stop and post-stop cleanup. systemctl --no-block exists in systemd219;
 * no transient Type/Timeout property allowlist or --collect is required.
 */
export function scheduleLinuxControlledNodeUpgrade(
  unitName: string,
  scriptPath: string,
  runCommand: (file: string, args: readonly string[]) => void = (file, args) => {
    execFileSync(file, [...args], { stdio: 'ignore' });
  },
  options: { unitDirectory?: string } = {},
): void {
  const prefix = `${CONTROLLED_NODE_SERVICE.LINUX_UNIT.replace(/\.service$/, '')}-upgrade-`;
  if (!unitName.startsWith(prefix) || !/^[a-zA-Z0-9-]{1,160}$/.test(unitName)
    || unitName.length <= prefix.length) throw new Error('invalid_upgrade_unit_name');
  const unitPath = join(options.unitDirectory ?? SYSTEM_UNIT_DIRECTORY, `${unitName}.service`);
  const content = linuxControlledNodeUpgradeUnit(scriptPath, unitPath);
  const temporary = `${unitPath}.${process.pid}.tmp`;
  let published = false;
  let temporaryCreated = false;
  try {
    const fd = openSync(temporary, 'wx', 0o644);
    temporaryCreated = true;
    try {
      writeFileSync(fd, content, 'utf8');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    // link is an atomic no-replace publication; an old generation is never overwritten.
    linkSync(temporary, unitPath);
    published = true;
    unlinkSync(temporary);
    temporaryCreated = false;
    runCommand('/bin/systemctl', ['daemon-reload']);
    runCommand('/bin/systemctl', ['--no-block', 'start', `${unitName}.service`]);
  } catch (error) {
    if (temporaryCreated) { try { unlinkSync(temporary); } catch { /* retain authoritative error */ } }
    if (published) {
      try { unlinkSync(unitPath); } catch { /* owned generation only */ }
      try { runCommand('/bin/systemctl', ['daemon-reload']); } catch { /* retain start error */ }
    }
    throw error;
  }
}
