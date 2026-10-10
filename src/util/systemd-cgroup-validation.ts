export const REQUIRED_DAEMON_KILL_MODE = 'control-group';
export const REQUIRED_DAEMON_SHUTDOWN_PHASES = ['session', 'mcp', 'browser', 'container'] as const;

export interface SystemdShutdownAuthoritySnapshot {
  killMode: string;
  sendSigkill: string;
  timeoutStopUs: string;
  controlGroup: string;
  mainPid: number;
}

export function assertSystemdShutdownAuthority(snapshot: SystemdShutdownAuthoritySnapshot): void {
  if (snapshot.killMode !== REQUIRED_DAEMON_KILL_MODE) {
    throw new Error(`systemd KillMode must be ${REQUIRED_DAEMON_KILL_MODE}, received ${snapshot.killMode || 'missing'}`);
  }
  if (snapshot.sendSigkill !== 'yes') {
    throw new Error(`systemd SendSIGKILL must be yes, received ${snapshot.sendSigkill || 'missing'}`);
  }
  if (!snapshot.controlGroup.startsWith('/') || snapshot.mainPid <= 0) {
    throw new Error(`systemd service lacks live cgroup authority: controlGroup=${snapshot.controlGroup || 'missing'} mainPid=${snapshot.mainPid}`);
  }
  if (!/^\d+(ms|s|min)?$/.test(snapshot.timeoutStopUs) && !/^\d+$/.test(snapshot.timeoutStopUs)) {
    throw new Error(`systemd TimeoutStopUSec is invalid: ${snapshot.timeoutStopUs || 'missing'}`);
  }
}

export function assertPidsInControlGroup(
  controlGroup: string,
  pids: readonly number[],
  memberships: ReadonlyMap<number, string>,
): void {
  for (const pid of pids) {
    const membership = memberships.get(pid) ?? '';
    const inGroup = membership.split('\n').some((line) => line.endsWith(`:${controlGroup}`));
    if (!inGroup) throw new Error(`pid ${pid} escaped daemon control group ${controlGroup}: ${membership || 'missing'}`);
  }
}

export function assertDaemonDescendants(
  daemonPid: number,
  pids: readonly number[],
  parents: ReadonlyMap<number, number>,
): void {
  for (const pid of pids) {
    let cursor = pid;
    const visited = new Set<number>();
    while (cursor > 1 && cursor !== daemonPid && !visited.has(cursor)) {
      visited.add(cursor);
      cursor = parents.get(cursor) ?? 0;
    }
    if (cursor !== daemonPid) throw new Error(`pid ${pid} is not a descendant of daemon pid ${daemonPid}`);
  }
}

export function assertNoCgroupSurvivors(pids: readonly number[], alivePids: ReadonlySet<number>, cgroupPids: readonly number[]): void {
  const survivors = pids.filter((pid) => alivePids.has(pid));
  if (survivors.length > 0 || cgroupPids.length > 0) {
    throw new Error(`daemon shutdown leaked pids=${JSON.stringify(survivors)} cgroupPids=${JSON.stringify(cgroupPids)}`);
  }
}

export function assertOrderedShutdownLog(log: string): void {
  let cursor = -1;
  for (const phase of REQUIRED_DAEMON_SHUTDOWN_PHASES) {
    const next = log.indexOf(`Daemon shutdown phase ${phase === 'mcp' ? 'MCP' : phase} started`, cursor + 1);
    if (next < 0) throw new Error(`missing shutdown phase log: ${phase}`);
    if (next <= cursor) throw new Error(`shutdown phase out of order: ${phase}`);
    cursor = next;
  }
}
