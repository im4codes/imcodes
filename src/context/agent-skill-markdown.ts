import { parseDocument } from 'yaml';
import { AGENT_SKILLS_LIMITS } from '../../shared/agent-skills.js';
import type { SkillMetadata } from '../../shared/skill-store.js';

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
}

/**
 * Extract metadata and body from third-party agent SKILL.md files cleanly.
 * Unlike IM.codes-authored managed skills, third-party skills often carry
 * arbitrary YAML frontmatter keys (`version: 3`, `license`, nested `metadata`,
 * `allowed-tools`, etc.) or omit `schemaVersion` / `category`.
 */
export function parseExternalAgentSkillMarkdown(
  markdown: string,
  fallback: { name: string; category?: string },
): { metadata: SkillMetadata; content: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  let record: Record<string, unknown> = {};
  let content = markdown;
  if (match) {
    content = markdown.slice(match[0].length);
    try {
      const parsed = parseDocument(match[1], { prettyErrors: false }).toJS({ maxAliasCount: 0 }) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        record = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed third-party YAML still previews cleanly using folder fallback.
    }
  }
  const nestedMetadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown>
    : undefined;
  const name = cleanString(record.name, 200) ?? fallback.name;
  const category = cleanString(record.category, 100)
    ?? (nestedMetadata ? cleanString(nestedMetadata.category, 100) : undefined)
    ?? fallback.category
    ?? 'agent';
  const description = cleanString(record.description, AGENT_SKILLS_LIMITS.DESCRIPTION_CHARS);
  return {
    metadata: {
      schemaVersion: 1,
      name,
      category,
      ...(description ? { description } : {}),
    },
    content,
  };
}
