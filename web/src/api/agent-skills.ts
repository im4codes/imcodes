import { apiFetch, ApiError } from '../api.js';
import {
  AGENT_SKILLS_ERROR,
  type AgentSkillAuditVerdict,
  type AgentSkillEntry,
  type AgentSkillSearchResult,
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

/** Search the skills.sh directory; throws when it is unavailable. */
export async function searchAgentSkillsDirectory(query: string): Promise<AgentSkillSearchResult[]> {
  const response = await apiFetch<{ results?: AgentSkillSearchResult[] }>(
    `/api/agent-skills/directory/search?q=${encodeURIComponent(query)}`,
  );
  return Array.isArray(response.results) ? response.results : [];
}

/** skills.sh's audits of named skills of one owner/repo; throws when unavailable. */
export async function auditAgentSkills(
  source: string,
  skills: string[],
): Promise<Record<string, AgentSkillAuditVerdict[]>> {
  const params = new URLSearchParams({ source, skills: skills.join(',') });
  const response = await apiFetch<{ audits?: Record<string, AgentSkillAuditVerdict[]> }>(
    `/api/agent-skills/directory/audit?${params.toString()}`,
  );
  return response.audits ?? {};
}
