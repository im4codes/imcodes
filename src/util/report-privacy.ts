/**
 * The runtime's diagnostic reports (--report-on-fatalerror, process.report.writeReport) list the WHOLE environment:
 * every provider API key the service holds. Where the runtime can leave it out (node >= 22.13: `process.report.excludeEnv`)
 * it is told to, as the first thing this process does -- before any code that could die of a fatal error. Older runtimes
 * have no such switch and may not be given the CLI flag (an unknown option in NODE_OPTIONS stops node from starting), so the
 * memory guard sweeps every report it finds (memory-guard.ts: sanitizeFatalReports).
 */
export function excludeEnvironmentFromReports(report: unknown = (process as { report?: unknown }).report): boolean {
  if (!report || typeof report !== 'object' || !('excludeEnv' in report)) return false;
  try {
    (report as { excludeEnv: boolean }).excludeEnv = true;
    return true;
  } catch {
    return false;
  }
}

/**
 * May the generated unit give node `--report-exclude-env`? Only when the unit starts THIS node binary directly and this
 * node lists the flag: through the launcher script the node that runs is picked at start (`command -v node`), and one that
 * does not know the flag (22.0-22.12) would refuse to start the daemon.
 */
export function reportExcludeEnvFlagUsable(
  launchProgram: string,
  execPath: string = process.execPath,
  allowedFlags: { has(flag: string): boolean } = process.allowedNodeEnvironmentFlags,
): boolean {
  return launchProgram === execPath && allowedFlags.has('--report-exclude-env');
}

excludeEnvironmentFromReports();
