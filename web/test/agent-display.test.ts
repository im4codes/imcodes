/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { formatLabel } from '../src/format-label.js';
import { getAutoSessionLabelPrefix } from '../src/agent-display.js';
import { HERMES_AGENT_PROVIDER_ID } from '../../shared/hermes-agent.js';

describe('agent display helpers', () => {
  it('normalizes legacy sdk auto labels into short readable labels', () => {
    expect(formatLabel('claude-code-sdk1')).toBe('CC1');
    expect(formatLabel('codex-sdk2')).toBe('Cx2');
    expect(formatLabel('copilot-sdk3')).toBe('Co3');
    expect(formatLabel('cursor-headless4')).toBe('Cu4');
    expect(formatLabel('opencode-sdk5')).toBe('OC5');
    expect(formatLabel('deepseek-harness6')).toBe('Ds6');
    expect(formatLabel('pi7')).toBe('Pi7');
    expect(formatLabel('codebuddy-cn8')).toBe('CB8');
    expect(formatLabel('codebuddy-international9')).toBe('CB9');
  });

  it('uses short auto label prefixes for sdk session creation', () => {
    expect(getAutoSessionLabelPrefix('claude-code-sdk')).toBe('CC');
    expect(getAutoSessionLabelPrefix('codex-sdk')).toBe('Cx');
    expect(getAutoSessionLabelPrefix('copilot-sdk')).toBe('Co');
    expect(getAutoSessionLabelPrefix('cursor-headless')).toBe('Cu');
    expect(getAutoSessionLabelPrefix('grok-sdk')).toBe('Gr');
    expect(getAutoSessionLabelPrefix(HERMES_AGENT_PROVIDER_ID)).toBe('He');
    expect(getAutoSessionLabelPrefix('opencode-sdk')).toBe('OC');
    expect(getAutoSessionLabelPrefix('deepseek-harness')).toBe('Ds');
    expect(getAutoSessionLabelPrefix('pi')).toBe('Pi');
    expect(getAutoSessionLabelPrefix('codebuddy-cn')).toBe('CB');
    expect(getAutoSessionLabelPrefix('codebuddy-international')).toBe('CB');
  });
});
