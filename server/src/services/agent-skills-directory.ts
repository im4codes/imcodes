/**
 * The skills.sh directory, for the Agent Skills tab: search, and the security
 * audits skills.sh runs on every skill. The browser cannot call either
 * directly (no CORS), so the server does, with a short cache. Everything that
 * comes back is re-validated before it reaches a browser: it is text from the
 * internet.
 */
import {
  AGENT_SKILLS_DIRECTORY,
  isAgentSkillName,
  isAgentSkillRepository,
  type AgentSkillAuditVerdict,
  type AgentSkillSearchResult,
} from '../../../shared/agent-skills.js';
import { getJsonWithin, processFetch, TtlCache, type Fetch } from './cached-json-fetch.js';

const SEARCH_CACHE_MS = 60_000;
const AUDIT_CACHE_MS = 10 * 60_000;

const getJson = (fetchImpl: Fetch, url: string) => getJsonWithin(fetchImpl, url, AGENT_SKILLS_DIRECTORY.TIMEOUT_MS);

function readSearch(value: unknown): AgentSkillSearchResult[] {
  const skills = (value as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(skills)) throw new Error('directory_shape');
  return skills.flatMap((raw): AgentSkillSearchResult[] => {
    const record = raw as Record<string, unknown> | null;
    const name = record?.skillId ?? record?.name;
    const source = record?.source;
    if (!isAgentSkillName(name) || !isAgentSkillRepository(source)) return [];
    const installs = typeof record?.installs === 'number' && Number.isFinite(record.installs) ? Math.max(0, Math.floor(record.installs)) : 0;
    return [{ name, source, installs }];
  }).slice(0, AGENT_SKILLS_DIRECTORY.SEARCH_LIMIT);
}

function readAudit(value: unknown, skills: readonly string[]): Record<string, AgentSkillAuditVerdict[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('directory_shape');
  const bySkill = value as Record<string, unknown>;
  const out: Record<string, AgentSkillAuditVerdict[]> = {};
  for (const skill of skills) {
    const auditors = bySkill[skill];
    if (!auditors || typeof auditors !== 'object' || Array.isArray(auditors)) continue;
    out[skill] = Object.entries(auditors as Record<string, unknown>).flatMap(([auditor, raw]): AgentSkillAuditVerdict[] => {
      const record = raw as Record<string, unknown> | null;
      if (!/^[a-z0-9_-]{1,32}$/iu.test(auditor) || typeof record?.risk !== 'string' || !/^[a-z_-]{1,24}$/iu.test(record.risk)) return [];
      return [{
        auditor,
        risk: record.risk.toLowerCase(),
        ...(typeof record.score === 'number' && Number.isFinite(record.score) ? { score: record.score } : {}),
        ...(typeof record.analyzedAt === 'string' && record.analyzedAt.length <= 40 ? { analyzedAt: record.analyzedAt } : {}),
      }];
    });
  }
  return out;
}

export function createAgentSkillsDirectory(options: { fetchImpl?: Fetch; now?: () => number } = {}) {
  const fetchImpl: Fetch = options.fetchImpl ?? processFetch;
  const now = options.now ?? Date.now;
  const searches = new TtlCache<AgentSkillSearchResult[]>(SEARCH_CACHE_MS);
  const audits = new TtlCache<Record<string, AgentSkillAuditVerdict[]>>(AUDIT_CACHE_MS);

  return {
    /** Skills matching `query`, most installed first. Throws when the directory fails. */
    async search(query: string): Promise<AgentSkillSearchResult[]> {
      const key = query.toLowerCase();
      const cached = searches.get(key, now());
      if (cached) return cached;
      const params = new URLSearchParams({ q: query, limit: String(AGENT_SKILLS_DIRECTORY.SEARCH_LIMIT) });
      const results = readSearch(await getJson(fetchImpl, `${AGENT_SKILLS_DIRECTORY.SEARCH_URL}?${params.toString()}`))
        .sort((left, right) => right.installs - left.installs);
      searches.set(key, results, now());
      return results;
    },

    /** Each auditor's verdict on each named skill of `source`. Throws when the directory fails. */
    async audit(source: string, skills: readonly string[]): Promise<Record<string, AgentSkillAuditVerdict[]>> {
      const key = `${source.toLowerCase()}\0${[...skills].sort().join(',')}`;
      const cached = audits.get(key, now());
      if (cached) return cached;
      const params = new URLSearchParams({ source, skills: skills.join(',') });
      const results = readAudit(await getJson(fetchImpl, `${AGENT_SKILLS_DIRECTORY.AUDIT_URL}?${params.toString()}`), skills);
      audits.set(key, results, now());
      return results;
    },
  };
}

export type AgentSkillsDirectory = ReturnType<typeof createAgentSkillsDirectory>;
