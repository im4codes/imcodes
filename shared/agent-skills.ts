/**
 * Agent Skills live in the cross-agent `~/.agents/skills` directory -- the
 * store Claude Code, Codex, Gemini CLI, OpenCode, Qwen Code, OpenClaw and the
 * rest already read, directly or through the links the `skills` CLI makes.
 * IM.codes does not keep a second copy: it lists that directory and runs the
 * pinned `skills` CLI to add, update and remove, on each machine it is asked
 * to, as the machine's own user.
 */

/** The `skills` CLI every daemon runs, pinned so one release behaves one way. */
export const AGENT_SKILLS_CLI_PACKAGE = 'skills@1.7.0' as const;

/** `~/.agents/skills`, relative to the home directory. */
export const AGENT_SKILLS_DIRECTORY_SEGMENTS = ['.agents', 'skills'] as const;

/** How the directory is named to people and agents, whatever the platform. */
export const AGENT_SKILLS_DIRECTORY_DISPLAY = '~/.agents/skills' as const;

/** Where the `skills` CLI records each global skill's source, beside the skills. */
export const AGENT_SKILLS_LOCK_FILE_SEGMENTS = ['.agents', '.skill-lock.json'] as const;

export const AGENT_SKILL_FILE_NAME = 'SKILL.md' as const;

/** Every agent-skills frame type starts with this. */
export const AGENT_SKILLS_MESSAGE_PREFIX = 'agent_skills.' as const;

export const AGENT_SKILLS_MSG = {
  LIST_REQUEST: `${AGENT_SKILLS_MESSAGE_PREFIX}list_request`,
  LIST_RESPONSE: `${AGENT_SKILLS_MESSAGE_PREFIX}list_response`,
  RUN_REQUEST: `${AGENT_SKILLS_MESSAGE_PREFIX}run_request`,
  RUN_RESPONSE: `${AGENT_SKILLS_MESSAGE_PREFIX}run_response`,
} as const;

export const AGENT_SKILLS_ACTION = {
  ADD: 'add',
  UPDATE: 'update',
  REMOVE: 'remove',
} as const;
export type AgentSkillsAction = typeof AGENT_SKILLS_ACTION[keyof typeof AGENT_SKILLS_ACTION];

export const AGENT_SKILLS_ERROR = {
  INVALID_REQUEST: 'invalid_request',
  DAEMON_OFFLINE: 'daemon_offline',
  TIMEOUT: 'timeout',
  /** Another add, update or remove is still running on that machine. */
  BUSY: 'busy',
  /** npm could not be found beside the daemon's Node.js. */
  CLI_UNAVAILABLE: 'cli_unavailable',
  CLI_FAILED: 'cli_failed',
} as const;
export type AgentSkillsError = typeof AGENT_SKILLS_ERROR[keyof typeof AGENT_SKILLS_ERROR];

/** Bounds, shared so the daemon, server and web agree on them. */
export const AGENT_SKILLS_LIMITS = {
  SOURCE_CHARS: 300,
  NAME_CHARS: 64,
  DESCRIPTION_CHARS: 1024,
  SKILLS: 500,
  /** The tail of the CLI's output returned with a run, for the person to read. */
  OUTPUT_CHARS: 4000,
  /** Cloning a repository can take a while on a slow link. */
  RUN_TIMEOUT_MS: 5 * 60_000,
} as const;

export interface AgentSkillEntry {
  /** The skill's directory name, which is also the name the CLI removes it by. */
  name: string;
  description: string;
  /** From the CLI's lock file when it installed the skill; absent for hand-made skills. */
  source?: string;
  sourceUrl?: string;
  installedAt?: string;
  updatedAt?: string;
}

export interface AgentSkillsListResponse {
  type: typeof AGENT_SKILLS_MSG.LIST_RESPONSE;
  requestId: string;
  skills: AgentSkillEntry[];
}

export interface AgentSkillsRunRequest {
  type: typeof AGENT_SKILLS_MSG.RUN_REQUEST;
  requestId: string;
  action: AgentSkillsAction;
  /** For add: a GitHub shorthand (owner/repo[/path]) or an https URL. */
  source?: string;
  /** For remove, and optionally update: skill directory names. */
  names?: string[];
}

export interface AgentSkillsRunResponse {
  type: typeof AGENT_SKILLS_MSG.RUN_RESPONSE;
  requestId: string;
  ok: boolean;
  error?: AgentSkillsError;
  /** The tail of the CLI's output, ANSI stripped. */
  output?: string;
  /** The machine's skills after the run. */
  skills?: AgentSkillEntry[];
}

const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/u;
const SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*(?:@[A-Za-z0-9_./-]+)?$/u;

/** A skill directory name the CLI can be told to update or remove. */
export function isAgentSkillName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= AGENT_SKILLS_LIMITS.NAME_CHARS
    && SKILL_NAME.test(value)
    && !value.includes('..');
}

/**
 * A source the CLI may add from: GitHub shorthand or an https URL. Never an
 * option (a leading '-'), never whitespace, never a local path -- a request
 * from the browser must not be able to point at arbitrary files on a machine.
 */
export function isAgentSkillSource(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const source = value.trim();
  if (source !== value || source.length === 0 || source.length > AGENT_SKILLS_LIMITS.SOURCE_CHARS) return false;
  if (/\s/u.test(source) || source.startsWith('-')) return false;
  if (SHORTHAND.test(source)) return !source.split('/').some((part) => part === '..' || part === '.');
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

export function isAgentSkillsAction(value: unknown): value is AgentSkillsAction {
  return Object.values(AGENT_SKILLS_ACTION).includes(value as AgentSkillsAction);
}

/** The run request, validated; null when anything about it is wrong. */
export function readAgentSkillsRunRequest(value: unknown): Omit<AgentSkillsRunRequest, 'type' | 'requestId'> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isAgentSkillsAction(record.action)) return null;
  const names = record.names === undefined ? undefined : record.names;
  if (names !== undefined
    && (!Array.isArray(names) || names.length > AGENT_SKILLS_LIMITS.SKILLS || !names.every(isAgentSkillName))) {
    return null;
  }
  if (record.action === AGENT_SKILLS_ACTION.ADD) {
    return isAgentSkillSource(record.source) ? { action: record.action, source: record.source } : null;
  }
  if (record.source !== undefined) return null;
  if (record.action === AGENT_SKILLS_ACTION.REMOVE && (!names || names.length === 0)) return null;
  return { action: record.action, ...(names ? { names: names as string[] } : {}) };
}
