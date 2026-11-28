import { exec as execCb, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentType } from './detect.js';
import { resolveOpenCodeCliAsync } from './opencode-cli-path.js';

const execAsync = promisify(execCb);
const execFileAsync = promisify(execFileCb);
const cache = new Map<string, Promise<string | undefined>>();

function normalizeVersion(output: string): string | undefined {
  const line = output
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean);
  return line || undefined;
}

async function resolveVersion(agentType: AgentType, shellBin?: string): Promise<string | undefined> {
  if (agentType === 'opencode') {
    try {
      const resolved = await resolveOpenCodeCliAsync();
      if (resolved.source === 'missing') return undefined;
      const bin = resolved.resolvedPath ?? resolved.executable;
      const { stdout, stderr } = await execFileAsync(bin, ['--version'], { timeout: 5000 });
      return normalizeVersion(stdout || stderr);
    } catch {
      return undefined;
    }
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
