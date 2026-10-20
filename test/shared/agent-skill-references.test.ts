import { describe, expect, it } from 'vitest';
import {
  agentSkillSourceLabel,
  buildAgentSkillMarker,
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
});
