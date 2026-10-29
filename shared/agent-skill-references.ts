import { isAgentSkillName, type AgentSkillEntry } from './agent-skills.js';

/** The composer marker used for a skill reference. */
export const AGENT_SKILL_REFERENCE_MARKER = '$$(' as const;

/** Keep references small: this is a name/source selector, never file content. */
export const AGENT_SKILL_REFERENCE_MAX_CHARS = 300 as const;

export interface AgentSkillReference {
  name: string;
  source?: string;
}

/**
 * Whether a listed skill is a direct payload of one of the supported skill
 * roots. Registry builders intentionally recurse so that runtime resolution
 * can still find legacy/nested entries, but the composer should only expose
 * the root's own skills. Keep this test on the redacted display/URI fields so
 * no host path is ever sent to the browser.
 */
export function isTopLevelAgentSkillEntry(
  skill: Pick<AgentSkillEntry, 'displayPath' | 'uri'>,
): boolean {
  const value = skill.displayPath?.trim() || skill.uri?.trim();
  if (!value) return true;
  const normalized = value.replace(/\\/gu, '/');
  const roots = ['~/.agents/skills', '~/.imcodes/skills', '.agents/skills', '.imc/skills'];
  const root = roots.find((candidate) => normalized === candidate || normalized.startsWith(`${candidate}/`));
  if (root) {
    const relative = normalized.slice(root.length).replace(/^\/+/, '');
    const segments = relative.split('/').filter(Boolean);
    return segments.length === 1
      || (segments.length === 2 && segments[1]!.toLocaleLowerCase() === 'skill.md');
  }
  if (normalized.toLocaleLowerCase().startsWith('skill://')) {
    // Registry URIs encode the registry key (which may contain `/`) into one
    // URI segment. Decode before applying the same direct-payload rule.
    const slash = normalized.indexOf('/', 'skill://'.length);
    if (slash < 0) return true;
    let key = normalized.slice(slash + 1);
    try { key = decodeURIComponent(key); } catch { return true; }
    const segments = key.split('/').filter(Boolean);
    // Managed/opaque registry URIs do not expose a filesystem hierarchy; the
    // registry entry itself is the top-level payload.
    const layer = normalized.slice('skill://'.length, slash).toLocaleLowerCase();
    if (layer === 'managed' || layer === 'managed_registry') return true;
    return segments.length === 1
      || (segments.length === 2 && segments[1]!.toLocaleLowerCase() === 'skill.md');
  }
  // Opaque source URIs and redacted paths cannot prove nesting. Keep them so
  // a valid top-level managed/source entry is not hidden fail-closed.
  return true;
}

/** Build the safe marker shown in the human-facing composer/timeline. */
export function buildAgentSkillMarker(skill: Pick<AgentSkillEntry, 'name' | 'source' | 'sourceUrl' | 'uri' | 'displayPath'>): string {
  const source = skill.source?.trim() || skill.sourceUrl?.trim() || skill.uri?.trim() || skill.displayPath?.trim();
  return `${AGENT_SKILL_REFERENCE_MARKER}${skill.name}${source ? `@${source}` : ''})`;
}

/** Parse one marker body, accepting `name` or the disambiguating `name@source`. */
export function parseAgentSkillReference(value: unknown): AgentSkillReference | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > AGENT_SKILL_REFERENCE_MAX_CHARS) return null;
  const at = raw.indexOf('@');
  const name = (at < 0 ? raw : raw.slice(0, at)).trim();
  const source = at < 0 ? undefined : raw.slice(at + 1).trim();
  if (!isAgentSkillName(name)) return null;
  if (source !== undefined && (!source || source.length > AGENT_SKILL_REFERENCE_MAX_CHARS || /[\r\n()]/u.test(source))) return null;
  return source ? { name, source } : { name };
}

/** Extract distinct valid marker bodies in first-occurrence order. */
export function parseAgentSkillMarkers(text: string): string[] {
  if (!text || !text.includes(AGENT_SKILL_REFERENCE_MARKER)) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  const pattern = /\$\$\(([^()\r\n]{1,300})\)/gu;
  for (const match of text.matchAll(pattern)) {
    const body = match[1]?.trim();
    if (!body || !parseAgentSkillReference(body) || seen.has(body)) continue;
    seen.add(body);
    found.push(body);
  }
  return found;
}

/** Human-facing source label, with a stable fallback for hand-made skills. */
export function agentSkillSourceLabel(skill: Pick<AgentSkillEntry, 'name' | 'source' | 'sourceUrl' | 'uri' | 'displayPath' | 'layer'>): string {
  return skill.source?.trim()
    || skill.sourceUrl?.trim()
    || skill.displayPath?.trim()
    || skill.uri?.trim()
    || (skill.layer ? `${skill.layer}:${skill.name}` : `~/.agents/skills/${skill.name}`);
}
