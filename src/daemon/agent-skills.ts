import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import {
  AGENT_SKILL_FILE_NAME,
  AGENT_SKILLS_ACTION,
  AGENT_SKILLS_CLI_PACKAGE,
  AGENT_SKILLS_DIRECTORY_SEGMENTS,
  AGENT_SKILLS_ERROR,
  AGENT_SKILLS_LIMITS,
  AGENT_SKILLS_LOCK_FILE_SEGMENTS,
  AGENT_SKILLS_MSG,
  isAgentSkillName,
  readAgentSkillsRunRequest,
  type AgentSkillEntry,
  type AgentSkillsError,
  type AgentSkillsRunRequest,
} from '../../shared/agent-skills.js';
import { resolveNpmCliJs } from '../util/node-datachannel-repair.mjs';

/** A SKILL.md larger than this is not read for its description. */
const MAX_SKILL_FILE_BYTES = 256 * 1024;

function firstString(record: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

/**
 * The skill's description from its SKILL.md frontmatter. Third-party skills
 * carry keys of their own, so only `description` is read and nothing else about
 * the file is judged here: the agents that load it decide what it means.
 */
async function readDescription(skillDirectory: string): Promise<string> {
  try {
    const path = join(skillDirectory, AGENT_SKILL_FILE_NAME);
    const facts = await stat(path);
    if (!facts.isFile() || facts.size > MAX_SKILL_FILE_BYTES) return '';
    const text = await readFile(path, 'utf8');
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
    if (!match) return '';
    const value = parseDocument(match[1], { prettyErrors: false }).toJS({ maxAliasCount: 0 }) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    return firstString(value as Record<string, unknown>, 'description', AGENT_SKILLS_LIMITS.DESCRIPTION_CHARS) ?? '';
  } catch {
    return '';
  }
}

async function readLock(homeDir: string): Promise<Record<string, Record<string, unknown>>> {
  try {
    const value = JSON.parse(await readFile(join(homeDir, ...AGENT_SKILLS_LOCK_FILE_SEGMENTS), 'utf8')) as unknown;
    const skills = (value as { skills?: unknown } | null)?.skills;
    return skills && typeof skills === 'object' && !Array.isArray(skills)
      ? skills as Record<string, Record<string, unknown>>
      : {};
  } catch {
    return {};
  }
}

/**
 * Every skill in `~/.agents/skills`: a directory (or a link to one -- a Windows
 * junction included, which `stat` follows) holding a SKILL.md.
 */
export async function listAgentSkills(homeDir: string = homedir()): Promise<AgentSkillEntry[]> {
  const root = join(homeDir, ...AGENT_SKILLS_DIRECTORY_SEGMENTS);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const lock = await readLock(homeDir);
  const skills: AgentSkillEntry[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (skills.length >= AGENT_SKILLS_LIMITS.SKILLS) break;
    if (!isAgentSkillName(name)) continue;
    const directory = join(root, name);
    try {
      if (!(await stat(directory)).isDirectory()) continue;
      if (!(await stat(join(directory, AGENT_SKILL_FILE_NAME))).isFile()) continue;
    } catch {
      continue;
    }
    const locked = lock[name] ?? {};
    skills.push({
      name,
      description: await readDescription(directory),
      ...(firstString(locked, 'source', AGENT_SKILLS_LIMITS.SOURCE_CHARS) ? { source: firstString(locked, 'source', AGENT_SKILLS_LIMITS.SOURCE_CHARS) } : {}),
      ...(firstString(locked, 'sourceUrl', AGENT_SKILLS_LIMITS.SOURCE_CHARS) ? { sourceUrl: firstString(locked, 'sourceUrl', AGENT_SKILLS_LIMITS.SOURCE_CHARS) } : {}),
      ...(firstString(locked, 'installedAt', 40) ? { installedAt: firstString(locked, 'installedAt', 40) } : {}),
      ...(firstString(locked, 'updatedAt', 40) ? { updatedAt: firstString(locked, 'updatedAt', 40) } : {}),
    });
  }
  return skills;
}

/** The CLI arguments for one request; the request is already validated. */
export function agentSkillsCliArguments(request: Omit<AgentSkillsRunRequest, 'type' | 'requestId'>): string[] {
  const names = request.names ?? [];
  switch (request.action) {
    case AGENT_SKILLS_ACTION.ADD:
      // Global, every detected agent linked, no prompt: the one install the
      // person asked for, on this machine, for this machine's user.
      return ['add', request.source!, '--global', '--yes'];
    case AGENT_SKILLS_ACTION.UPDATE:
      return ['update', ...names, '--global', '--yes'];
    case AGENT_SKILLS_ACTION.REMOVE:
      return ['remove', ...names, '--global', '--yes'];
  }
  return [];
}

export type AgentSkillsCliRunner = (args: readonly string[]) => Promise<{ ok: boolean; output: string; error?: AgentSkillsError }>;

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '').replace(/\r/gu, '');
}

function tail(text: string): string {
  const clean = stripAnsi(text).trim();
  return clean.length > AGENT_SKILLS_LIMITS.OUTPUT_CHARS ? clean.slice(-AGENT_SKILLS_LIMITS.OUTPUT_CHARS) : clean;
}

/**
 * Run `npm exec --yes skills@<pinned> -- ...` through this daemon's own Node.js
 * and npm: no shell anywhere (on Windows `npx` is a `.cmd`, which would need
 * one), and no dependency on what happens to be first on PATH.
 */
export const runAgentSkillsCli: AgentSkillsCliRunner = (args) => new Promise((resolve) => {
  const npmCli = resolveNpmCliJs(undefined);
  if (!npmCli) {
    resolve({ ok: false, output: '', error: AGENT_SKILLS_ERROR.CLI_UNAVAILABLE });
    return;
  }
  const child = spawn(process.execPath, [npmCli, 'exec', '--yes', AGENT_SKILLS_CLI_PACKAGE, '--', ...args], {
    cwd: homedir(),
    env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', DO_NOT_TRACK: '1', npm_config_update_notifier: 'false', npm_config_fund: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  let output = '';
  const append = (chunk: Buffer) => {
    output += chunk.toString('utf8');
    if (output.length > AGENT_SKILLS_LIMITS.OUTPUT_CHARS * 4) output = output.slice(-AGENT_SKILLS_LIMITS.OUTPUT_CHARS * 2);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, AGENT_SKILLS_LIMITS.RUN_TIMEOUT_MS);
  timer.unref?.();
  child.once('error', () => {
    clearTimeout(timer);
    resolve({ ok: false, output: tail(output), error: AGENT_SKILLS_ERROR.CLI_UNAVAILABLE });
  });
  child.once('close', (code) => {
    clearTimeout(timer);
    if (timedOut) resolve({ ok: false, output: tail(output), error: AGENT_SKILLS_ERROR.TIMEOUT });
    else if (code === 0) resolve({ ok: true, output: tail(output) });
    else resolve({ ok: false, output: tail(output), error: AGENT_SKILLS_ERROR.CLI_FAILED });
  });
});

/**
 * One add, update or remove at a time on a machine: two CLIs rewriting the same
 * directory and lock file would leave either one's result half applied.
 */
export function createAgentSkillsRunner(options: {
  homeDir?: string;
  runCli?: AgentSkillsCliRunner;
} = {}) {
  let running = false;
  return async (request: Omit<AgentSkillsRunRequest, 'type' | 'requestId'>): Promise<{
    ok: boolean;
    error?: AgentSkillsError;
    output?: string;
    skills: AgentSkillEntry[];
  }> => {
    if (running) {
      return { ok: false, error: AGENT_SKILLS_ERROR.BUSY, skills: await listAgentSkills(options.homeDir) };
    }
    running = true;
    try {
      const result = await (options.runCli ?? runAgentSkillsCli)(agentSkillsCliArguments(request));
      return {
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
        ...(result.output ? { output: result.output } : {}),
        skills: await listAgentSkills(options.homeDir),
      };
    } finally {
      running = false;
    }
  };
}

/**
 * This machine's one runner, shared by the server-routed requests and the
 * agent-facing install tool so both honour the same one-at-a-time rule.
 */
export const runAgentSkillsOnThisMachine = createAgentSkillsRunner();

/**
 * Answer one agent-skills request from the server. The request comes from a
 * browser the server has already authorised for this machine; everything in
 * it is still validated here before anything runs.
 */
export async function handleAgentSkillsCommand(
  cmd: Record<string, unknown>,
  send: (message: Record<string, unknown>) => void,
  run: ReturnType<typeof createAgentSkillsRunner> = runAgentSkillsOnThisMachine,
): Promise<void> {
  const requestId = typeof cmd.requestId === 'string' && cmd.requestId.length <= 128 ? cmd.requestId : undefined;
  if (!requestId) return;
  if (cmd.type === AGENT_SKILLS_MSG.LIST_REQUEST) {
    send({ type: AGENT_SKILLS_MSG.LIST_RESPONSE, requestId, skills: await listAgentSkills() });
    return;
  }
  if (cmd.type !== AGENT_SKILLS_MSG.RUN_REQUEST) return;
  const request = readAgentSkillsRunRequest(cmd);
  if (!request) {
    send({ type: AGENT_SKILLS_MSG.RUN_RESPONSE, requestId, ok: false, error: AGENT_SKILLS_ERROR.INVALID_REQUEST });
    return;
  }
  send({ type: AGENT_SKILLS_MSG.RUN_RESPONSE, requestId, ...(await run(request)) });
}
