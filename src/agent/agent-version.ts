import { exec as execCb, execFile as execFileCb } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentType } from './detect.js';
import { resolveOpenCodeCliAsync, type ResolvedOpenCodeCli } from './opencode-cli-path.js';

const execAsync = promisify(execCb);
const execFileAsync = promisify(execFileCb);
const cache = new Map<string, Promise<string | undefined>>();

export interface OpenCodeVersionDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resolveCli?: () => Promise<ResolvedOpenCodeCli>;
  execShell?: (command: string, opts: { timeout: number }) => Promise<{ stdout: string; stderr: string }>;
  execFileFn?: (
    file: string,
    args: readonly string[],
    opts: { timeout: number; windowsVerbatimArguments?: boolean },
  ) => Promise<{ stdout: string; stderr: string }>;
}

function normalizeVersion(output: string): string | undefined {
  const line = output
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean);
  return line || undefined;
}

export async function resolveOpenCodeVersion(deps: OpenCodeVersionDeps = {}): Promise<string | undefined> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const resolveCli = deps.resolveCli ?? (() => resolveOpenCodeCliAsync({ platform, env }));
  const execShell = deps.execShell ?? ((cmd, opts) => execAsync(cmd, opts));
  const execFileFn = deps.execFileFn ?? ((file, args, opts) => execFileAsync(file, [...args], opts));

  try {
    const resolved = await resolveCli();
    if (resolved.source === 'missing') return undefined;

    // Preserve baseline shell lookup for PATH-resolved CLIs (including Windows .cmd/.bat npm shims).
    if (resolved.source === 'path') {
      const { stdout, stderr } = await execShell('opencode --version', { timeout: 5000 });
      return normalizeVersion(stdout || stderr);
    }

    const bin = resolved.resolvedPath ?? resolved.executable;
    if (platform === 'win32' && /\.(cmd|bat)$/iu.test(bin)) {
      const comSpec = env.ComSpec || env.COMSPEC || path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
      const { stdout, stderr } = await execFileFn(comSpec, ['/d', '/s', '/c', `""${bin}" --version"`], {
        timeout: 5000,
        windowsVerbatimArguments: true,
      });
      return normalizeVersion(stdout || stderr);
    }

    const { stdout, stderr } = await execFileFn(bin, ['--version'], { timeout: 5000 });
    return normalizeVersion(stdout || stderr);
  } catch {
    return undefined;
  }
}

async function resolveVersion(agentType: AgentType, shellBin?: string): Promise<string | undefined> {
  if (agentType === 'opencode') {
    return resolveOpenCodeVersion();
  }
  let command: string | null = null;
  switch (agentType) {
    case 'claude-code':
      command = 'claude --version';
      break;
    case 'codex':
      command = 'codex --version';
      break;
    case 'shell':
      command = shellBin ? `${JSON.stringify(shellBin)} --version` : null;
      break;
    case 'script':
      command = null;
      break;
  }
  if (!command) return undefined;
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: 5000 });
    return normalizeVersion(stdout || stderr);
  } catch {
    return undefined;
  }
}

export async function getAgentVersion(agentType: AgentType, shellBin?: string): Promise<string | undefined> {
  const key = `${agentType}:${shellBin ?? ''}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = resolveVersion(agentType, shellBin);
    cache.set(key, pending);
  }
  return pending;
}
