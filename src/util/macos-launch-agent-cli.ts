/**
 * `node macos-launch-agent-cli.js ensure --plist <file> --entry <dist/src/index.js> [--node <node>] [--mode startup|regenerate]`
 *
 * What the upgrade script runs, from the package it just installed, to bring the launch agent to that package's launch target (so the
 * script never carries a second copy of the decision). Prints one JSON line; the exit status is 0 whenever the command line was valid
 * (a plist that is left alone is not an error), 2 for misuse.
 */
import { pathToFileURL } from 'node:url';
import { MACOS_LAUNCH_MIGRATION_MODE, type MacosLaunchMigrationMode } from '../../shared/macos-daemon-launch.js';
import { ensureMacosLaunchAgentTarget } from './macos-launch-agent.js';

const MODES = new Set<string>(Object.values(MACOS_LAUNCH_MIGRATION_MODE));

export function runMacosLaunchAgentCli(argv: readonly string[], write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): number {
  const [command, ...rest] = argv;
  const option = (name: string): string | undefined => {
    const index = rest.indexOf(`--${name}`);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  const plist = option('plist');
  const entry = option('entry');
  const mode = option('mode') ?? MACOS_LAUNCH_MIGRATION_MODE.REGENERATE;
  if (command !== 'ensure' || !plist || !entry || !MODES.has(mode)) {
    write(JSON.stringify({ error: 'usage: ensure --plist <file> --entry <index.js> [--node <node>] [--mode startup|regenerate]' }));
    return 2;
  }
  write(JSON.stringify(ensureMacosLaunchAgentTarget({ plistPath: plist, entry, node: option('node'), mode: mode as MacosLaunchMigrationMode })));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runMacosLaunchAgentCli(process.argv.slice(2));
}
