/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { formatLabel } from '../src/format-label.js';
import { getAutoSessionLabelPrefix } from '../src/agent-display.js';

describe('agent display helpers', () => {
  it('normalizes legacy sdk auto labels into short readable labels', () => {
    expect(formatLabel('claude-code-sdk1')).toBe('CC1');
    expect(formatLabel('codex-sdk2')).toBe('Cx2');
    expect(formatLabel('copilot-sdk3')).toBe('Co3');
    expect(formatLabel('cursor-headless4')).toBe('Cu4');
  });

  it('uses short auto label prefixes for sdk session creation', () => {
    expect(getAutoSessionLabelPrefix('claude-code-sdk')).toBe('CC');
    expect(getAutoSessionLabelPrefix('codex-sdk')).toBe('Cx');
    expect(getAutoSessionLabelPrefix('copilot-sdk')).toBe('Co');
    expect(getAutoSessionLabelPrefix('cursor-headless')).toBe('Cu');
  });
});
