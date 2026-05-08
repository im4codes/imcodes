import { describe, expect, it } from 'vitest';
import { MEMORY_DEFAULTS } from '../../shared/memory-defaults.js';
import { MEMORY_RENDER_KINDS, isMemoryRenderKind } from '../../shared/memory-render-kind.js';
import {
  SKILL_ENVELOPE_CLOSE,
  SKILL_ENVELOPE_COLLISION_PATTERN,
  SKILL_ENVELOPE_COLLISION_POLICY,
  SKILL_ENVELOPE_OPEN,
  SKILL_MAX_BYTES,
  containsSkillEnvelopeDelimiter,
  renderSkillEnvelope,
  sanitizeSkillEnvelopeContent,
} from '../../shared/skill-envelope.js';

describe('skill envelope shared contract', () => {
  it('defines render kinds for memory context injection', () => {
    expect(MEMORY_RENDER_KINDS).toEqual(['summary', 'preference', 'note', 'skill', 'pinned', 'citation_preview']);
    expect(isMemoryRenderKind('citation_preview')).toBe(true);
    expect(isMemoryRenderKind('memory_note')).toBe(false);
  });

  it('exports canonical skill envelope constants and cap', () => {
    expect(SKILL_ENVELOPE_OPEN).toBe('<<<imcodes-skill v1>>>');
    expect(SKILL_ENVELOPE_CLOSE).toBe('<<<imcodes-skill-end>>>');
    expect(SKILL_ENVELOPE_COLLISION_PATTERN.test('<<<imcodes-skill')).toBe(true);
    SKILL_ENVELOPE_COLLISION_PATTERN.lastIndex = 0;
    expect(SKILL_ENVELOPE_COLLISION_POLICY).toBe('escape');
    expect(SKILL_MAX_BYTES).toBe(MEMORY_DEFAULTS.skillMaxBytes);
  });

  it('escapes delimiter collisions by default and can reject on request', () => {
    const content = 'Never include <<<imcodes-skill v1>>> inside a skill.';
    expect(containsSkillEnvelopeDelimiter(content)).toBe(true);
    const escaped = sanitizeSkillEnvelopeContent(content);
    expect(escaped).toMatchObject({ ok: true, collision: true });
    expect(escaped.content).not.toContain('<<<imcodes-skill v1>>>');
    const rejected = sanitizeSkillEnvelopeContent(content, 'reject');
    expect(rejected).toMatchObject({ ok: false, collision: true });
  });

  it('renders content inside the envelope and caps by UTF-8 bytes', () => {
    const rendered = renderSkillEnvelope('Use the repo tests.');
    expect(rendered).toBe('<<<imcodes-skill v1>>>\nUse the repo tests.\n<<<imcodes-skill-end>>>');

    const oversized = '好'.repeat(SKILL_MAX_BYTES);
    const sanitized = sanitizeSkillEnvelopeContent(oversized);
    expect(new TextEncoder().encode(sanitized.content).byteLength).toBeLessThanOrEqual(SKILL_MAX_BYTES);
  });
});
