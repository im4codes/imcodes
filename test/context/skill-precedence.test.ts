import { describe, expect, it } from 'vitest';
import {
  loadBuiltinSkillSources,
  selectSkillSourcesForContext,
  skillSourceFromMarkdown,
} from '../../shared/skill-store.js';
import { EMPTY_BUILTIN_SKILL_MANIFEST } from '../../shared/builtin-skill-manifest.js';

function skill(name: string, layer: Parameters<typeof skillSourceFromMarkdown>[0]['layer'], content: string, extraFrontMatter = '') {
  return skillSourceFromMarkdown({
    layer,
    markdown: [
      '---',
      'schemaVersion: 1',
      `name: ${name}`,
      'category: ops',
      extraFrontMatter,
      '---',
      content,
    ].filter(Boolean).join('\n'),
  });
}

describe('skill precedence and enforcement contract', () => {
  it('keeps ordinary precedence above workspace/org/builtin fallback', () => {
    const sources = [
      skill('Deploy', 'builtin_fallback', 'builtin'),
      skill('Deploy', 'org_shared', 'org'),
      skill('Deploy', 'workspace_shared', 'workspace'),
      skill('Deploy', 'user_default', 'user default'),
      skill('Deploy', 'user_project', 'user project'),
      skill('Deploy', 'project_escape_hatch', 'project escape hatch'),
    ];

    const selected = selectSkillSourcesForContext(sources);

    expect(selected.ordinary).toHaveLength(1);
    expect(selected.ordinary[0]?.layer).toBe('project_escape_hatch');
    expect(selected.ordinary[0]?.content).toBe('project escape hatch');
    expect(selected.skipped.map((entry) => entry.reason)).toEqual([
      'lower_precedence',
      'lower_precedence',
      'lower_precedence',
      'lower_precedence',
      'lower_precedence',
    ]);
  });

  it('injects enforced workspace/org skills as a separate policy axis', () => {
    const selected = selectSkillSourcesForContext([
      skill('Deploy', 'user_default', 'user default'),
      skill('Deploy', 'workspace_shared', 'workspace enforced', 'enforcement: enforced'),
      skill('Deploy', 'org_shared', 'org additive'),
    ]);

    expect(selected.ordinary.map((source) => [source.layer, source.content])).toEqual([
      ['user_default', 'user default'],
    ]);
    expect(selected.enforced.map((source) => [source.layer, source.content])).toEqual([
      ['workspace_shared', 'workspace enforced'],
    ]);
  });

  it('keeps the built-in fallback loader empty for this wave', () => {
    expect(loadBuiltinSkillSources(EMPTY_BUILTIN_SKILL_MANIFEST)).toEqual([]);
  });
});
