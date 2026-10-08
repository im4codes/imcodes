/**
 * The macOS launch agent of the daemon: render it, and bring an existing one to the launch target that Full Disk Access can reach.
 * The decision itself is shared/macos-daemon-launch.ts; this file does the reading and writing.
 */
import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import {
  MACOS_DAEMON_LAUNCH,
  MACOS_LAUNCH_MIGRATION_MODE,
  MACOS_LAUNCH_PROGRAM_KIND,
  classifyMacosLaunchProgram,
  macosLaunchNeedsMigration,
  parsePlistProgramArguments,
  planMacosDaemonLaunch,
  renderPlistProgramArgumentItems,
  replacePlistProgramArguments,
  xmlEscapeText,
  type MacosDaemonLaunchFacts,
  type MacosExistingLaunch,
  type MacosLaunchMigrationMode,
} from '../../shared/macos-daemon-launch.js';
import { findDaemonPackageRoot } from './launch-target.js';

function realOrSelf(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/**
 * The node path to put in the plist: the first `node` on PATH that is the very binary running now. That is a name which survives
 * `brew upgrade node` (/opt/homebrew/bin/node keeps pointing at the new version) -- launchd resolves it on every start -- while the
 * running binary's real path (a versioned Cellar directory) would be gone after `brew cleanup`. Full Disk Access is keyed to the
 * REAL path, which is what `imcodes doctor` prints; this is only the name launchd starts.
 */
export function resolveStableNodePath(execPath: string = process.execPath, pathEnv: string = process.env.PATH ?? ''): string {
  const real = realOrSelf(execPath);
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir.startsWith('/')) continue;
    const candidate = join(dir, 'node');
    if (existsSync(candidate) && realOrSelf(candidate) === real) return candidate;
  }
  return real;
}

function readHead(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(2);
    const read = readSync(fd, buffer, 0, 2, 0);
    return buffer.toString('latin1', 0, read);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* nothing to close */ }
  }
}

export function describeExistingMacosLaunch(programArguments: readonly string[]): MacosExistingLaunch {
  const program = programArguments[0] ?? '';
  const kind = program === ''
    ? MACOS_LAUNCH_PROGRAM_KIND.OTHER
    : classifyMacosLaunchProgram({ exists: existsSync(program), head: readHead(program), basename: basename(program) });
  return { programArguments, kind };
}

export function resolveMacosDaemonLaunchFacts(options: { entry?: string; node?: string; pathEnv?: string } = {}): MacosDaemonLaunchFacts {
  // argv[1] is the npm bin SYMLINK when the CLI was started by name; the package root is found from the real file.
  const entry = realOrSelf(options.entry ?? process.argv[1]!);
  const root = findDaemonPackageRoot(entry);
  const bootstrap = root ? join(root, MACOS_DAEMON_LAUNCH.BOOTSTRAP_RELATIVE) : undefined;
  return {
    node: resolveStableNodePath(options.node ?? process.execPath, options.pathEnv),
    entry,
    ...(bootstrap && existsSync(bootstrap) ? { bootstrap } : {}),
  };
}

/** ProgramArguments for a plist about to be written; `existingXml` (a re-bind) keeps a node binary the user already runs. */
export function planMacosPlistProgramArguments(facts: MacosDaemonLaunchFacts, existingXml?: string): string[] {
  const existingArgs = existingXml === undefined ? undefined : parsePlistProgramArguments(existingXml);
  return planMacosDaemonLaunch(facts, existingArgs ? describeExistingMacosLaunch(existingArgs) : undefined);
}

export interface MacosLaunchAgentPlistInput {
  label: string;
  programArguments: readonly string[];
  logPath: string;
  pathEnv: string;
  home: string;
  /** Environment of a scoped (non-default) state home. */
  scoped?: { stateHome: string; defaultHomeParent: string };
  nodeOptions: string;
}

/** The plist `imcodes bind` writes. */
export function renderMacosLaunchAgentPlist(input: MacosLaunchAgentPlistInput): string {
  const scopedEnv = input.scoped
    ? `    <key>IMCODES_HOME</key>
    <string>${xmlEscapeText(input.scoped.stateHome)}</string>
    <key>IMCODES_DEFAULT_HOME</key>
    <string>${xmlEscapeText(input.scoped.defaultHomeParent)}</string>
`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscapeText(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
${renderPlistProgramArgumentItems(input.programArguments)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscapeText(input.pathEnv)}</string>
    <key>HOME</key>
    <string>${xmlEscapeText(input.home)}</string>
${scopedEnv}
    <!-- See bind-flow.ts.installSystemdService for rationale on these flags
         (V8 lazy-GC + heap-limit OOM cascade observed on production daemons). -->
    <key>NODE_OPTIONS</key>
    <string>${xmlEscapeText(input.nodeOptions)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscapeText(input.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscapeText(input.logPath)}</string>
</dict>
</plist>`;
}

export const MACOS_LAUNCH_ENSURE_REASON = {
  NO_PLIST: 'no_plist',
  NO_PROGRAM_ARGUMENTS: 'no_program_arguments',
  /** The program is a script (or a missing file) that is neither our launcher nor a node binary: someone's own wrapper, left alone. */
  CUSTOM_PROGRAM: 'custom_program',
  UNCHANGED: 'unchanged',
  REWRITTEN: 'rewritten',
  WRITE_FAILED: 'write_failed',
} as const;
export type MacosLaunchEnsureReason = typeof MACOS_LAUNCH_ENSURE_REASON[keyof typeof MACOS_LAUNCH_ENSURE_REASON];

export interface MacosLaunchEnsureResult {
  changed: boolean;
  reason: MacosLaunchEnsureReason;
  from?: string[];
  to?: string[];
}

export const MACOS_LAUNCH_BACKUP_SUFFIX = '.pre-launch-target';

const OWN_LAUNCHER = basename(MACOS_DAEMON_LAUNCH.PREFLIGHT_RELATIVE);

/**
 * Bring an existing launch agent to the launch target the generator produces now. Only the ProgramArguments array is replaced; the
 * original is kept once as `<plist>.pre-launch-target`. At daemon start (`startup`) only a plist whose program is our own shell
 * launcher (or a node that no longer exists) is rewritten; a plist that already runs node directly -- including one made by hand --
 * is not touched, and any other script is somebody's own wrapper and is never touched.
 */
export function ensureMacosLaunchAgentTarget(options: {
  plistPath: string;
  mode: MacosLaunchMigrationMode;
  entry?: string;
  node?: string;
  pathEnv?: string;
}): MacosLaunchEnsureResult {
  const { plistPath } = options;
  if (!existsSync(plistPath)) return { changed: false, reason: MACOS_LAUNCH_ENSURE_REASON.NO_PLIST };
  const xml = readFileSync(plistPath, 'utf8');
  const args = parsePlistProgramArguments(xml);
  if (!args || args.length === 0) return { changed: false, reason: MACOS_LAUNCH_ENSURE_REASON.NO_PROGRAM_ARGUMENTS };
  const existing = describeExistingMacosLaunch(args);
  const programName = basename(args[0]!);
  const ours = programName === OWN_LAUNCHER || /^node([0-9._-].*)?$/u.test(programName);
  if ((existing.kind === MACOS_LAUNCH_PROGRAM_KIND.SCRIPT || existing.kind === MACOS_LAUNCH_PROGRAM_KIND.MISSING) && !ours) {
    return { changed: false, reason: MACOS_LAUNCH_ENSURE_REASON.CUSTOM_PROGRAM, from: args };
  }
  const planned = planMacosDaemonLaunch(resolveMacosDaemonLaunchFacts(options), existing);
  if (!macosLaunchNeedsMigration(existing, planned, options.mode)) {
    return { changed: false, reason: MACOS_LAUNCH_ENSURE_REASON.UNCHANGED, from: args };
  }
  const rewritten = replacePlistProgramArguments(xml, planned);
  if (rewritten === undefined) return { changed: false, reason: MACOS_LAUNCH_ENSURE_REASON.NO_PROGRAM_ARGUMENTS };
  try {
    const backup = `${plistPath}${MACOS_LAUNCH_BACKUP_SUFFIX}`;
    if (!existsSync(backup)) copyFileSync(plistPath, backup);
    const temp = `${plistPath}.${process.pid}.tmp`;
    writeFileSync(temp, rewritten, 'utf8');
    renameSync(temp, plistPath);
  } catch {
    return { changed: false, reason: MACOS_LAUNCH_ENSURE_REASON.WRITE_FAILED, from: args, to: planned };
  }
  return { changed: true, reason: MACOS_LAUNCH_ENSURE_REASON.REWRITTEN, from: args, to: planned };
}

/**
 * Makes launchd read the plist again. Run by a helper that outlives this job: the unload ends the daemon that asked for it, so the
 * load has to come from another process (its own session, so launchd's process-group cleanup does not take it down).
 */
export function restartMacosLaunchAgentDetached(plistPath: string, spawnFn: typeof spawn = spawn): void {
  const script = 'sleep 2; /bin/launchctl unload "$1" 2>/dev/null; /bin/launchctl load -w "$1" || { sleep 3; /bin/launchctl load -w "$1"; }';
  const child = spawnFn('/bin/sh', ['-c', script, 'imcodes-relaunch', plistPath], { detached: true, stdio: 'ignore' });
  child.unref();
}

export { MACOS_LAUNCH_MIGRATION_MODE };
