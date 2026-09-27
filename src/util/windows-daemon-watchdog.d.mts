export function canonicalWatchdogPath(homePath: string): string;
export function watchdogCommandLineMatchesHome(
  commandLine: string,
  stateHome: string,
  defaultStateHome?: string,
): boolean;
export function parseWatchdogProcessListing(
  output: string,
  stateHome: string,
  defaultStateHome?: string,
): number[];
export function daemonCommandLineMatchesHome(
  commandLine: string,
  stateHome: string,
  defaultStateHome?: string,
): boolean;
export function parseDaemonProcessListing(
  output: string,
  stateHome: string,
  defaultStateHome?: string,
): number[];
