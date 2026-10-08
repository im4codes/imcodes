/**
 * What launchd runs for the macOS daemon, decided in ONE place.
 *
 * Why it matters: macOS attributes "Full Disk Access" (TCC) to the program launchd starts, not to what that program later becomes. A
 * plist whose first program is an `#!/usr/bin/env bash` script gets its access checked as `/usr/bin/env` on older macOS (measured on
 * macOS 12.7.6: responsible_path=/usr/bin/env, authValue=0, and a persistent `/usr/bin/env` denial row in the system TCC database),
 * which nobody can grant sensibly -- so the user's grant on `node` never applied to the daemon or the agent sessions it starts.
 * The program in the plist must therefore be the absolute `node` binary itself. The self-healing the old shell launcher did (repair a
 * half-finished npm install) runs INSIDE that node process (bin/imcodes-launch.mjs), where it cannot change who is responsible.
 *
 * Pure: no filesystem, no process. The effects (reading a plist, finding node, restarting the job) live in
 * src/util/macos-launch-agent.ts.
 */

export const MACOS_DAEMON_LAUNCH = {
  /** Plain-JS entry the plist runs under node: preflight (self-healing), then the real entry. Builtins only. */
  BOOTSTRAP_RELATIVE: 'bin/imcodes-launch.mjs',
  /** The shell supervisor; also run by the bootstrap in preflight-only mode, and still the Linux systemd entry. */
  PREFLIGHT_RELATIVE: 'bin/imcodes-launch.sh',
  ENTRY_RELATIVE: 'dist/src/index.js',
  /** Set by the bootstrap: the shell supervisor repairs the install and exits instead of exec'ing node. */
  PREFLIGHT_ONLY_ENV: 'IMCODES_LAUNCH_PREFLIGHT_ONLY',
  /** The node the supervisor/preflight must use (already read by bin/imcodes-launch.sh). */
  NODE_BIN_ENV: 'IMCODES_NODE_BIN',
  START_ARGS: ['start', '--foreground'],
} as const;

export const MACOS_LAUNCH_PROGRAM_KIND = {
  /** An absolute node binary: TCC sees the program that actually does the work. */
  NODE: 'node',
  /** A script with an interpreter line: TCC attributes access to the interpreter (`/usr/bin/env`). */
  SCRIPT: 'script',
  /** The program is not there any more (node removed, nvm version switched). */
  MISSING: 'missing',
  /** Some other executable: left alone. */
  OTHER: 'other',
} as const;
export type MacosLaunchProgramKind = typeof MACOS_LAUNCH_PROGRAM_KIND[keyof typeof MACOS_LAUNCH_PROGRAM_KIND];

export const MACOS_LAUNCH_MIGRATION_MODE = {
  /** A running daemon looking at its own plist: only fix what makes Full Disk Access unusable. */
  STARTUP: 'startup',
  /** bind / upgrade / restart: bring the whole launch target to what the generator produces now. */
  REGENERATE: 'regenerate',
} as const;
export type MacosLaunchMigrationMode = typeof MACOS_LAUNCH_MIGRATION_MODE[keyof typeof MACOS_LAUNCH_MIGRATION_MODE];

/** A file that starts with `#!` is run by its interpreter, and that interpreter is what macOS records. */
export function hasInterpreterLine(head: string): boolean {
  return head.startsWith('#!');
}

export function classifyMacosLaunchProgram(facts: { exists: boolean; head: string; basename: string }): MacosLaunchProgramKind {
  if (!facts.exists) return MACOS_LAUNCH_PROGRAM_KIND.MISSING;
  if (hasInterpreterLine(facts.head)) return MACOS_LAUNCH_PROGRAM_KIND.SCRIPT;
  // node, node22, node-v22 ... never a script (checked above), whatever it is called inside an nvm/Homebrew tree.
  return /^node([0-9._-].*)?$/u.test(facts.basename) ? MACOS_LAUNCH_PROGRAM_KIND.NODE : MACOS_LAUNCH_PROGRAM_KIND.OTHER;
}

export interface MacosDaemonLaunchFacts {
  /** The node the plist should run when nothing better is already configured: absolute, stable (see resolveStableNodePath). */
  node: string;
  /** `<package>/dist/src/index.js` */
  entry: string;
  /** `<package>/bin/imcodes-launch.mjs` when this install ships it (older packages do not). */
  bootstrap?: string;
}

export interface MacosExistingLaunch {
  programArguments: readonly string[];
  kind: MacosLaunchProgramKind;
}

/**
 * The ProgramArguments the plist gets. A node binary the plist already runs is KEPT (the user may have granted Full Disk Access to
 * exactly that file; switching to another path would silently drop the grant), including a hand-made direct-node plist.
 */
export function planMacosDaemonLaunch(facts: MacosDaemonLaunchFacts, existing?: MacosExistingLaunch): string[] {
  const keepProgram = existing !== undefined && existing.kind === MACOS_LAUNCH_PROGRAM_KIND.NODE && existing.programArguments[0] !== undefined;
  const program = keepProgram ? existing.programArguments[0]! : facts.node;
  return [program, facts.bootstrap ?? facts.entry, ...MACOS_DAEMON_LAUNCH.START_ARGS];
}

export function sameProgramArguments(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Whether the existing plist must be rewritten. A plist that already runs node directly is never touched at daemon start. */
export function macosLaunchNeedsMigration(
  existing: MacosExistingLaunch,
  planned: readonly string[],
  mode: MacosLaunchMigrationMode,
): boolean {
  if (mode === MACOS_LAUNCH_MIGRATION_MODE.STARTUP) {
    return existing.kind === MACOS_LAUNCH_PROGRAM_KIND.SCRIPT || existing.kind === MACOS_LAUNCH_PROGRAM_KIND.MISSING;
  }
  return !sameProgramArguments(existing.programArguments, planned);
}

// ---- the plist's ProgramArguments array (a text edit: every other key, comment and environment variable stays byte for byte) ----

const PROGRAM_ARGUMENTS_BLOCK = /(<key>ProgramArguments<\/key>\s*)<array>([\s\S]*?)<\/array>/u;

export function xmlEscapeText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function xmlUnescapeText(value: string): string {
  return value.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&amp;/gu, '&');
}

/** `<string>` items of `<key>ProgramArguments</key>`, or undefined when the plist has none. */
export function parsePlistProgramArguments(xml: string): string[] | undefined {
  const block = PROGRAM_ARGUMENTS_BLOCK.exec(xml);
  if (!block) return undefined;
  return [...block[2]!.matchAll(/<string>([\s\S]*?)<\/string>/gu)].map((match) => xmlUnescapeText(match[1]!));
}

export function renderPlistProgramArgumentItems(args: readonly string[]): string {
  return args.map((arg) => `    <string>${xmlEscapeText(arg)}</string>`).join('\n');
}

/** The plist with only its ProgramArguments replaced; undefined when it has no such array. */
export function replacePlistProgramArguments(xml: string, args: readonly string[]): string | undefined {
  if (!PROGRAM_ARGUMENTS_BLOCK.test(xml)) return undefined;
  return xml.replace(PROGRAM_ARGUMENTS_BLOCK, (_whole, head: string) => `${head}<array>\n${renderPlistProgramArgumentItems(args)}\n  </array>`);
}
