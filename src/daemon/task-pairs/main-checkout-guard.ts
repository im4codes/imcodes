import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const CREDENTIAL_PATH = /(?:token|secret|password|credential|id_rsa|\.pem$|\.key$|\.env(?:\.|$))/iu;
export interface MainCheckoutGuardNotice { project: string; root: string; paths: string[]; credentialPaths: string[] }
export interface MainCheckoutGuardOptions { exec?: (root: string) => Promise<string>; brainActive?: boolean; writerSession?: string; pairParticipants?: readonly string[]; brainSession?: string }
export class MainCheckoutGuard {
  readonly #seen = new Map<string, Set<string>>();
  async inspect(project: string, root: string, options: MainCheckoutGuardOptions = {}): Promise<MainCheckoutGuardNotice | undefined> {
    if (options.brainActive || (options.writerSession && options.brainSession && options.writerSession === options.brainSession)) return undefined;
    if (options.writerSession && options.pairParticipants && !options.pairParticipants.includes(options.writerSession)) return undefined;
    let output: string;
    try { output = await (options.exec ?? (async (cwd) => String((await execFileAsync('git', ['-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout)))(root); } catch { return undefined; }
    const paths = output.split('\0').map((entry) => entry ? entry.slice(3).trim() : '').filter(Boolean);
    if (!paths.length) return undefined;
    const key = project + '\0' + root; const seen = this.#seen.get(key) ?? new Set<string>();
    const fresh = paths.filter((path) => !seen.has(path)); paths.forEach((path) => seen.add(path)); this.#seen.set(key, seen);
    if (!fresh.length) return undefined;
    return { project, root, paths: fresh, credentialPaths: fresh.filter((path) => CREDENTIAL_PATH.test(path)) };
  }
  reset(project: string, root: string): void { this.#seen.delete(project + '\0' + root); }
}
export const mainCheckoutGuard = new MainCheckoutGuard();
