import { describe, expect, it } from 'vitest';
import {
  agentSkillSourceLabel,
  buildAgentSkillMarker,
  isTopLevelAgentSkillEntry,
  parseAgentSkillMarkers,
  parseAgentSkillReference,
} from '../../shared/agent-skill-references.js';

describe('agent skill reference markers', () => {
  it('builds and parses an optional source-qualified marker', () => {
    const marker = buildAgentSkillMarker({ name: 'writer', source: 'team/skills' });
    expect(marker).toBe('$$(writer@team/skills)');
    expect(parseAgentSkillReference('writer@team/skills')).toEqual({ name: 'writer', source: 'team/skills' });
    expect(parseAgentSkillMarkers(`x ${marker} ${marker}`)).toEqual(['writer@team/skills']);
  });

  it('rejects unsafe references and provides a stable source fallback', () => {
    expect(parseAgentSkillReference('writer)')).toBeNull();
    expect(parseAgentSkillReference('../writer')).toBeNull();
    expect(parseAgentSkillReference('writer@')).toBeNull();
    expect(agentSkillSourceLabel({ name: 'writer' })).toBe('~/.agents/skills/writer');
  });

  it('keeps direct payloads and rejects deeper registry paths cross-platform', () => {
    const topLevel = [
      '~/.imcodes/skills/writer.md',
      '~/.imcodes/skills/writer/SKILL.md',
      '.imc\\skills\\writer\\skill.md',
      'skill://project_escape_hatch/writer',
      'skill://user_default/writer%2FSKILL.md',
    ];
    const nested = [
      '~/.imcodes/skills/category/writer.md',
      '.imc/skills/category/writer/SKILL.md',
      'skill://user_default/category%2Fwriter',
    ];
    for (const displayPath of topLevel) expect(isTopLevelAgentSkillEntry({ displayPath })).toBe(true);
    for (const displayPath of nested) expect(isTopLevelAgentSkillEntry({ displayPath })).toBe(false);
  });
});
