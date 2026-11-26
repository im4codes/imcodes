/**
 * Full Disk Access on macOS: what the daemon probes, how the result is stored, and what the user is told to grant.
 *
 * Measured facts this relies on (macOS 12.7.6 and 26.2, see the task evidence):
 *  - The grant belongs to ONE binary, by its real path (and the code requirement stored with it). It covers the daemon and every
 *    process the daemon starts -- agent CLIs, shells, tmux and its panes -- because they inherit the responsible process.
 *  - A tmux pane inherits from the process that STARTED the tmux server, not from whoever asked for the pane: a server started
 *    before the grant (or from another app) keeps denying until it is restarted.
 *  - A different path (Homebrew Cellar version, nvm version) is a different binary and needs its own grant; an in-place upgrade of a
 *    Developer-ID-signed node (the nodejs.org installer) keeps its code requirement and normally keeps working.
 *
 * Pure: the probe itself (opening the file, asking tmux) lives in src/util/macos-full-disk-access.ts.
 */

/** Readable only with Full Disk Access (exists on every macOS since 10.14; a plain user process gets EPERM). */
export const MACOS_FDA_PROBE_PATH = '/Library/Application Support/com.apple.TCC/TCC.db';

export const MACOS_FDA_STATE = {
  GRANTED: 'granted',
  DENIED: 'denied',
  /** The probe could not decide (file missing, odd errno, not macOS). Never reported as a problem. */
  UNKNOWN: 'unknown',
} as const;
export type MacosFdaState = typeof MACOS_FDA_STATE[keyof typeof MACOS_FDA_STATE];

export const MACOS_FDA_PANE_STATE = {
  GRANTED: 'granted',
  DENIED: 'denied',
  /** There is no tmux server to ask (nothing to restart). */
  NO_SERVER: 'no_server',
  UNKNOWN: 'unknown',
} as const;
export type MacosFdaPaneState = typeof MACOS_FDA_PANE_STATE[keyof typeof MACOS_FDA_PANE_STATE];

export const MACOS_NODE_INSTALL_KIND = {
  /** /opt/homebrew/Cellar/node/<version>/bin/node: every `brew upgrade node` is a new path. */
  HOMEBREW: 'homebrew',
  /** nvm / fnm / volta / asdf / mise / n: one path per version. */
  VERSION_MANAGER: 'version_manager',
  /** /usr/local/bin/node from the nodejs.org package: one path, Developer ID signed. */
  SYSTEM_PACKAGE: 'system_package',
  OTHER: 'other',
} as const;
export type MacosNodeInstallKind = typeof MACOS_NODE_INSTALL_KIND[keyof typeof MACOS_NODE_INSTALL_KIND];

export function classifyMacosNodeInstall(realPath: string): MacosNodeInstallKind {
  if (/\/Cellar\/node(@[^/]+)?\//u.test(realPath) || /^\/(opt\/homebrew|usr\/local\/Homebrew)\//u.test(realPath)) return MACOS_NODE_INSTALL_KIND.HOMEBREW;
  if (/\/(\.nvm|\.fnm|\.volta|\.asdf|\.nodenv|\.local\/share\/(mise|fnm)|n\/versions)\//u.test(realPath) || /\/versions\/node\//u.test(realPath)) {
    return MACOS_NODE_INSTALL_KIND.VERSION_MANAGER;
  }
  if (realPath === '/usr/local/bin/node') return MACOS_NODE_INSTALL_KIND.SYSTEM_PACKAGE;
  return MACOS_NODE_INSTALL_KIND.OTHER;
}

/** Whether a Node upgrade (or switching versions) changes the binary the grant was made for. */
export function nodeUpgradeNeedsNewGrant(kind: MacosNodeInstallKind): boolean {
  return kind !== MACOS_NODE_INSTALL_KIND.SYSTEM_PACKAGE;
}

/** The open() outcome of the probe file, as an errno code or undefined for success. */
export function fdaStateFromOpenError(code: string | undefined): MacosFdaState {
  if (code === undefined) return MACOS_FDA_STATE.GRANTED;
  if (code === 'EPERM' || code === 'EACCES') return MACOS_FDA_STATE.DENIED;
  return MACOS_FDA_STATE.UNKNOWN;
}

/** What the daemon writes after probing itself (and the tmux server it uses); `imcodes doctor` reads it. */
export interface MacosFdaStatusRecord {
  /** Bumped when the shape changes; an unknown version is ignored by readers. */
  version: 1;
  checkedAtMs: number;
  pid: number;
  /** The file TCC sees: the real path of the node binary running the daemon. */
  nodePath: string;
  nodeKind: MacosNodeInstallKind;
  daemon: MacosFdaState;
  pane: MacosFdaPaneState;
}

export const MACOS_FDA_STATUS_FILE = 'fda-status.json';

const FDA_STATES = new Set<string>(Object.values(MACOS_FDA_STATE));
const PANE_STATES = new Set<string>(Object.values(MACOS_FDA_PANE_STATE));
const NODE_KINDS = new Set<string>(Object.values(MACOS_NODE_INSTALL_KIND));

export function parseMacosFdaStatusRecord(raw: string): MacosFdaStatusRecord | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version !== 1
      || typeof value.checkedAtMs !== 'number' || !Number.isFinite(value.checkedAtMs)
      || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid)
      || typeof value.nodePath !== 'string' || value.nodePath === ''
      || typeof value.nodeKind !== 'string' || !NODE_KINDS.has(value.nodeKind)
      || typeof value.daemon !== 'string' || !FDA_STATES.has(value.daemon)
      || typeof value.pane !== 'string' || !PANE_STATES.has(value.pane)) return undefined;
    return value as unknown as MacosFdaStatusRecord;
  } catch {
    return undefined;
  }
}

export interface MacosFdaReportInput {
  /** What the last daemon probe recorded; undefined when the daemon has not written one. */
  record?: MacosFdaStatusRecord;
  /** Whether the pid in the record is still a running process. */
  recordProcessAlive: boolean;
  /** The node binary the plist runs now (real path): what to grant even before the daemon has probed anything. */
  plistNodePath?: string;
  /** The plist's program is a script (an old launch target): nothing the user grants can reach the daemon. */
  plistRunsScript: boolean;
}

export interface MacosFdaReport {
  /** True when something needs the user's attention. */
  needsAction: boolean;
  lines: string[];
}

function grantSteps(nodePath: string): string[] {
  return [
    `  1. System Settings > Privacy & Security > Full Disk Access > "+"`,
    `  2. Press Cmd+Shift+G in the file dialog and paste:  ${nodePath}`,
    `  3. Turn it on, then run:  imcodes restart`,
  ];
}

function regrantLine(kind: MacosNodeInstallKind): string {
  switch (kind) {
    case MACOS_NODE_INSTALL_KIND.HOMEBREW:
      return 'Homebrew puts each Node version at a new path: after "brew upgrade node" run "imcodes doctor" and grant the new path it prints.';
    case MACOS_NODE_INSTALL_KIND.VERSION_MANAGER:
      return 'A Node version manager keeps one binary per version: after switching or upgrading Node, run "imcodes doctor" and grant the path it prints.';
    case MACOS_NODE_INSTALL_KIND.SYSTEM_PACKAGE:
      return 'This is the signed Node from nodejs.org (a Developer ID package): upgrading it in place normally keeps the grant.';
    default:
      return 'If the Node binary changes (new version or new location), run "imcodes doctor" and grant the path it prints.';
  }
}

/** The text `imcodes doctor` prints. Never tells anyone to install anything: the grant target is the Node the daemon already runs. */
export function buildMacosFdaReport(input: MacosFdaReportInput): MacosFdaReport {
  const lines: string[] = [];
  if (input.plistRunsScript) {
    lines.push('The launch agent still starts the daemon through a script, so a Full Disk Access grant cannot reach it.');
    lines.push('Run "imcodes restart" (or "imcodes bind"): the launch agent is rewritten to start Node directly.');
    return { needsAction: true, lines };
  }
  const record = input.record;
  const nodePath = record?.nodePath ?? input.plistNodePath;
  if (!record || !input.recordProcessAlive) {
    lines.push('Full Disk Access: not checked yet (the daemon records a probe each time it starts).');
    if (nodePath) lines.push(`The daemon runs: ${nodePath}`);
    return { needsAction: false, lines };
  }
  if (record.daemon === MACOS_FDA_STATE.DENIED) {
    lines.push('Full Disk Access: NOT granted. The daemon and the agent sessions it starts cannot read protected folders (Desktop, Documents, Downloads, /Volumes ...).');
    lines.push('Grant it once to the Node binary the daemon runs:');
    lines.push(...grantSteps(record.nodePath));
    lines.push(regrantLine(record.nodeKind));
    return { needsAction: true, lines };
  }
  if (record.daemon === MACOS_FDA_STATE.GRANTED && record.pane === MACOS_FDA_PANE_STATE.DENIED) {
    lines.push('Full Disk Access: granted to the daemon, but the running tmux server was started before the grant, so shells and agents inside it are still denied.');
    lines.push('New agent sessions work once tmux is restarted. This ends every session in the current tmux server, so do it when none are busy:  tmux kill-server');
    return { needsAction: true, lines };
  }
  if (record.daemon === MACOS_FDA_STATE.GRANTED) {
    lines.push(`Full Disk Access: granted to ${record.nodePath} (daemon and agent sessions).`);
    lines.push(regrantLine(record.nodeKind));
    return { needsAction: false, lines };
  }
  lines.push('Full Disk Access: could not be determined on this system.');
  return { needsAction: false, lines };
}
