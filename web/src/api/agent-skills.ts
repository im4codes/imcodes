import { apiFetch, ApiError } from '../api.js';
import {
  AGENT_SKILLS_ERROR,
  type AgentSkillEntry,
  type AgentSkillsAction,
  type AgentSkillsError,
} from '@shared/agent-skills.js';

export interface AgentSkillsRunResult {
  ok: boolean;
  error?: AgentSkillsError | string;
  output?: string;
  skills?: AgentSkillEntry[];
}

/** The skills in one machine's `~/.agents/skills`. */
export async function listAgentSkills(serverId: string): Promise<AgentSkillEntry[]> {
  const response = await apiFetch<{ skills?: AgentSkillEntry[] }>(
    `/api/agent-skills?serverId=${encodeURIComponent(serverId)}`,
  );
  return Array.isArray(response.skills) ? response.skills : [];
}

/**
 * One add, update or remove on one machine. A refusal or failure comes back as
 * a result rather than a throw, so installing on several machines can report
 * each one.
 */
export async function runAgentSkills(
  serverId: string,
  request: { action: AgentSkillsAction; source?: string; names?: string[] },
): Promise<AgentSkillsRunResult> {
  try {
    return await apiFetch<AgentSkillsRunResult>(`/api/agent-skills/run?serverId=${encodeURIComponent(serverId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof ApiError && error.code ? error.code : AGENT_SKILLS_ERROR.DAEMON_OFFLINE,
    };
  }
}
