/** Repo detection — platform, CLI, auth, branch. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RepoContext, RepoInfo, RepoPlatform, RepoRemote, RepoStatus } from './types.js';

const execFileAsync = promisify(execFile);

const GH_MIN_VERSION = '2.0.0';
const GLAB_MIN_VERSION = '1.22.0';

// Known hosts — checked before CLI probe
const KNOWN_HOSTS: Record<string, RepoPlatform> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
};

interface ParsedRemote {
  name: string;
  url: string;
  host: string;
  owner: string;
  repo: string;
}

/** Parse a single remote URL (HTTPS or SSH) into components. */
function parseRemoteUrl(url: string): { host: string; owner: string; repo: string } | null {
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (httpsMatch) return { host: httpsMatch[1], owner: httpsMatch[2], repo: httpsMatch[3] };

  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/^git@([^:]+):([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (sshMatch) return { host: sshMatch[1], owner: sshMatch[2], repo: sshMatch[3] };

  // SSH with ssh:// prefix: ssh://git@github.com/owner/repo.git
  const sshUrlMatch = url.match(/^ssh:\/\/[^@]+@([^/]+)\/([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (sshUrlMatch) return { host: sshUrlMatch[1], owner: sshUrlMatch[2], repo: sshUrlMatch[3] };

  return null;
}

/** Parse `git remote -v` output into structured remotes. */
function parseRemotes(output: string): ParsedRemote[] {
  const seen = new Set<string>();
  const remotes: ParsedRemote[] = [];
  for (const line of output.split('\n')) {
    // format: origin\thttps://github.com/o/r.git (fetch)
    const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
    if (!match) continue;
    const [, name, url] = match;
    if (seen.has(name)) continue;
    seen.add(name);
    const parsed = parseRemoteUrl(url);
    if (parsed) {
      remotes.push({ name, url, ...parsed });
    }
  }
  return remotes;
}

/** Resolve SSH alias to actual hostname via `ssh -G`. */
async function resolveSSHHost(alias: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ssh', ['-G', alias], { timeout: 3000 });
    const match = stdout.match(/^hostname\s+(\S+)/m);
    return match ? match[1] : alias;
  } catch {
    return alias;
  }
}

/** Determine platform for a host — known hosts first, SSH alias, then CLI probe. */
async function detectPlatform(host: string): Promise<RepoPlatform> {
  // 1. Known hosts (direct match)
  if (KNOWN_HOSTS[host]) return KNOWN_HOSTS[host];

  // 2. Resolve SSH alias (e.g. github-work → github.com via ~/.ssh/config)
  const resolved = await resolveSSHHost(host);
  if (resolved !== host && KNOWN_HOSTS[resolved]) return KNOWN_HOSTS[resolved];

  // 3. CLI auth host probe — try gh on both alias and resolved hostname
  const hostsToTry = resolved !== host ? [resolved, host] : [host];
  for (const h of hostsToTry) {
    try {
      await execFileAsync('gh', ['auth', 'status', '--hostname', h], { timeout: 5000 });
      return 'github';
    } catch { /* not a gh host or gh not installed */ }
  }

  // 4. glab: parse `glab auth status` output for all authenticated hosts (supports self-hosted GitLab)
  try {
    const { stderr, stdout } = await execFileAsync('glab', ['auth', 'status'], { timeout: 5000 });
    // glab outputs host lines to both stdout and stderr depending on version
    const output = (stdout + '\n' + stderr).toLowerCase();
    for (const h of hostsToTry) {
      if (output.includes(h.toLowerCase())) return 'gitlab';
    }
  } catch { /* glab not installed or not authenticated */ }

  return 'unknown';
}

/** Compare semver strings. Returns -1, 0, or 1. */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/** Extract version string from CLI output. */
function extractVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

/** Check CLI availability and version. */
async function checkCli(
  platform: RepoPlatform,
  cwd: string,
): Promise<{ status: RepoStatus; cliVersion?: string; cliMinVersion?: string }> {
  const cli = platform === 'github' ? 'gh' : 'glab';
  const minVersion = platform === 'github' ? GH_MIN_VERSION : GLAB_MIN_VERSION;

  // Check if CLI exists
  try {
    await execFileAsync('which', [cli], { timeout: 3000 });
  } catch {
    return { status: 'cli_missing' };
  }

  // Check version
  try {
    const { stdout } = await execFileAsync(cli, ['--version'], { timeout: 3000, cwd });
    const version = extractVersion(stdout);
    if (!version) return { status: 'cli_outdated', cliMinVersion: minVersion };
    if (compareSemver(version, minVersion) < 0) {
      return { status: 'cli_outdated', cliVersion: version, cliMinVersion: minVersion };
    }
    return { status: 'ok', cliVersion: version };
  } catch {
    return { status: 'cli_missing' };
  }
}

/** Check CLI auth status. */
async function checkAuth(platform: RepoPlatform, host: string): Promise<boolean> {
  try {
    if (platform === 'github') {
      await execFileAsync('gh', ['auth', 'status', '--hostname', host], { timeout: 5000 });
    } else {
      // glab: verify the specific host is authenticated (supports self-hosted)
      const { stdout, stderr } = await execFileAsync('glab', ['auth', 'status'], { timeout: 5000 });
      const output = (stdout + '\n' + stderr).toLowerCase();
      if (!output.includes(host.toLowerCase())) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Get current git branch. */
async function getCurrentBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd, timeout: 3000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Get default branch from git. */
async function getDefaultBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], { cwd, timeout: 3000 });
    // Returns e.g. "origin/main" — strip the remote prefix
    const full = stdout.trim();
    return full.replace(/^[^/]+\//, '') || undefined;
  } catch {
    return undefined;
  }
}

/** Main detection entry point. */
export async function detectRepo(projectDir: string): Promise<RepoContext> {
  // 1. Parse remotes
  let remoteOutput: string;
  try {
    const { stdout } = await execFileAsync('git', ['remote', '-v'], { cwd: projectDir, timeout: 5000 });
    remoteOutput = stdout;
  } catch {
    return { info: null, status: 'no_repo' };
  }

  const remotes = parseRemotes(remoteOutput);
  if (remotes.length === 0) {
    return { info: null, status: 'no_repo' };
  }

  // 2. Select remote — prefer 'origin', else multiple_remotes
  let selected: ParsedRemote;
  if (remotes.length === 1) {
    selected = remotes[0];
  } else {
    const origin = remotes.find((r) => r.name === 'origin');
    if (origin) {
      selected = origin;
    } else {
      return {
        info: null,
        status: 'multiple_remotes',
        remotes: remotes.map((r) => ({ name: r.name, url: r.url, platform: KNOWN_HOSTS[r.host] ?? 'unknown' })),
      };
    }
  }

  // 3. Detect platform (resolve SSH aliases like github-work → github.com)
  const resolvedHost = await resolveSSHHost(selected.host);
  const platform = await detectPlatform(selected.host);
  if (platform === 'unknown') {
    return { info: null, status: 'unknown_platform' };
  }

  // Use resolved host for CLI auth checks (alias won't work with gh auth --hostname)
  const authHost = KNOWN_HOSTS[resolvedHost] ? resolvedHost : selected.host;

  // 4. Check CLI
  const cliCheck = await checkCli(platform, projectDir);
  if (cliCheck.status !== 'ok') {
    return {
      info: { platform, owner: selected.owner, repo: selected.repo, remoteUrl: selected.url },
      status: cliCheck.status,
      cliVersion: cliCheck.cliVersion,
      cliMinVersion: cliCheck.cliMinVersion,
    };
  }

  // 5. Check auth
  const cliAuth = await checkAuth(platform, authHost);
  if (!cliAuth) {
    return {
      info: { platform, owner: selected.owner, repo: selected.repo, remoteUrl: selected.url },
      status: 'unauthorized',
      cliVersion: cliCheck.cliVersion,
      cliAuth: false,
    };
  }

  // 6. Get branch info
  const [currentBranch, defaultBranch] = await Promise.all([
    getCurrentBranch(projectDir),
    getDefaultBranch(projectDir),
  ]);

  return {
    info: {
      platform,
      owner: selected.owner,
      repo: selected.repo,
      remoteUrl: selected.url,
      defaultBranch,
      currentBranch,
      ...(selected.host !== 'github.com' && selected.host !== 'gitlab.com'
        ? { apiUrl: `https://${selected.host}${platform === 'github' ? '/api/v3' : '/api/v4'}` }
        : {}),
    },
    status: 'ok',
    cliVersion: cliCheck.cliVersion,
    cliAuth: true,
  };
}

// Re-export helpers for testing
export { parseRemoteUrl, parseRemotes, compareSemver, extractVersion };
