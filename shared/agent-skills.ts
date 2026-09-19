/**
 * Agent Skills live in the cross-agent `~/.agents/skills` directory -- the
 * store Claude Code, Codex, Gemini CLI, OpenCode, Qwen Code, OpenClaw and the
 * rest already read, directly or through the links the `skills` CLI makes.
 * IM.codes does not keep a second copy: it lists that directory and runs the
 * pinned `skills` CLI to add, update and remove, on each machine it is asked
 * to, as the machine's own user.
 */

import { MACHINE_CONFIG_REQUEST_ERROR } from './machine-config-request.js';

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
  DAEMON_OFFLINE: MACHINE_CONFIG_REQUEST_ERROR.DAEMON_OFFLINE,
  TIMEOUT: MACHINE_CONFIG_REQUEST_ERROR.TIMEOUT,
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
  /**
   * Commands the skill declares it needs (`metadata.requires.bins`, or
   * OpenClaw's `metadata.openclaw.requires.bins`) that this machine's PATH does
   * not have: installed, the skill would load but could not work.
   */
  missingBins?: string[];
}

/** A command name a skill may require; anything else is ignored. */
export function isAgentSkillBinName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(value);
}

/**
 * The skills.sh directory, reached through the IM.codes server: search, and
 * the security audits skills.sh runs on every skill. Both are the endpoints the
 * `skills` CLI itself calls; they are undocumented, so a failure is reported as
 * the directory being unavailable and installing by source keeps working.
 */
export const AGENT_SKILLS_DIRECTORY = {
  SEARCH_URL: 'https://skills.sh/api/search',
  AUDIT_URL: 'https://add-skill.vercel.sh/audit',
  PAGE_URL: 'https://skills.sh',
  SEARCH_LIMIT: 20,
  QUERY_CHARS: 100,
  AUDIT_SKILLS: 50,
  TIMEOUT_MS: 5_000,
} as const;

export const AGENT_SKILLS_DIRECTORY_ERROR = {
  UNAVAILABLE: 'directory_unavailable',
} as const;

export interface AgentSkillSearchResult {
  /** The skill's name inside its repository. */
  name: string;
  /** owner/repo -- what `skills add` installs from. */
  source: string;
  installs: number;
}

/** One auditor's verdict on one skill, as skills.sh reports it. */
export interface AgentSkillAuditVerdict {
  auditor: string;
  risk: string;
  score?: number;
  analyzedAt?: string;
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
  /** For remove; optionally for update, and for add to install only these skills of the source. */
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

/** Exactly a GitHub `owner/repo`: what the skills.sh directory names a source by. */
export function isAgentSkillRepository(value: unknown): value is string {
  return isAgentSkillSource(value) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value);
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
    // With names, only those skills of the source; without, all of them.
    return isAgentSkillSource(record.source)
      ? { action: record.action, source: record.source, ...(names && names.length > 0 ? { names: names as string[] } : {}) }
      : null;
  }
  if (record.source !== undefined) return null;
  if (record.action === AGENT_SKILLS_ACTION.REMOVE && (!names || names.length === 0)) return null;
  return { action: record.action, ...(names ? { names: names as string[] } : {}) };
}
