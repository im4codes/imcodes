import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * How src/repo runs git / gh / glab. src/repo is compiled into the server image
 * too, so it must not import daemon-only modules (the daemon exec helper pulls
 * in the Windows lock and watchdog). It defaults to a direct promisified
 * execFile; the daemon injects its off-main-thread helper at startup.
 */
const directExecFile = promisify(execFile);

export type RepoExecFile = typeof directExecFile;

let offMain: RepoExecFile = directExecFile;
let offMainIdempotent: RepoExecFile = directExecFile;

export function setRepoExecFile(impl: { offMain: RepoExecFile; offMainIdempotent: RepoExecFile } | null): void {
  offMain = impl?.offMain ?? directExecFile;
  offMainIdempotent = impl?.offMainIdempotent ?? directExecFile;
}

/** Drop-in for `promisify(execFile)`, routed through the daemon's exec helper when one is injected. */
export const repoExecFile: RepoExecFile = ((...params: unknown[]) =>
  (offMain as unknown as (...p: unknown[]) => Promise<unknown>)(...params)) as never;

/** Same, for read-only commands that may be repeated directly if the helper dies. */
export const repoExecFileIdempotent: RepoExecFile = ((...params: unknown[]) =>
  (offMainIdempotent as unknown as (...p: unknown[]) => Promise<unknown>)(...params)) as never;
