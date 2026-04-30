import { describe, expect, it } from 'vitest';
import { compressToolEvent } from '../../src/context/tool-compressors.js';

describe('tool compressors', () => {
  it('summarizes oversized git status bash output with a recoverable placeholder', () => {
    const output = [
      'On branch dev',
      'Changes not staged for commit:',
      '  modified:   src/context/summary-compressor.ts',
      'Untracked files:',
      '  test/context/tool-compressors.test.ts',
      ...Array.from({ length: 200 }, (_, i) => `noise line ${i}`),
    ].join('\n');
    const compressed = compressToolEvent('Bash', output, 'evt-bash', 120);
    expect(compressed.length).toBeLessThan(output.length);
    expect(compressed).toContain('Bash output summary');
    expect(compressed).toContain('modified:   src/context/summary-compressor.ts');
    expect(compressed).toContain('[event:evt-bash');
    expect(compressed).toContain('retrievable via chat_get_event');
  });

  it('uses callable placeholders for unknown oversized tools and identity for small content', () => {
    expect(compressToolEvent('Unknown', 'small output', 'evt-small', 100)).toBe('small output');
    const large = 'x'.repeat(5000);
    const compressed = compressToolEvent('Unknown', large, 'evt-large', 100);
    expect(compressed).toBe('[event:evt-large — 5KB elided, retrievable via chat_get_event]');
    expect(compressed).not.toContain('[Old tool output cleared]');
  });
});
