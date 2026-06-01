import { describe, expect, it } from 'vitest';
import { geminiPlanEntriesToInput } from '../../src/agent/providers/gemini-sdk.js';

describe('geminiPlanEntriesToInput', () => {
  it('maps ACP plan entries ({content,status}) to a { plan } checklist input', () => {
    const input = geminiPlanEntriesToInput([
      { content: 'Design login UI', priority: 'high', status: 'completed' },
      { content: 'Implement auth API', priority: 'medium', status: 'in_progress' },
      { content: 'Add validation', priority: 'low', status: 'pending' },
    ]);
    expect(input).toEqual({
      plan: [
        { content: 'Design login UI', status: 'completed' },
        { content: 'Implement auth API', status: 'in_progress' },
        { content: 'Add validation', status: 'pending' },
      ],
    });
  });

  it('falls back to `title` and defaults missing status to pending', () => {
    expect(geminiPlanEntriesToInput([{ title: 'Step A' }])).toEqual({
      plan: [{ content: 'Step A', status: 'pending' }],
    });
  });

  it('drops entries without text and returns null when nothing usable', () => {
    expect(geminiPlanEntriesToInput([{ status: 'pending' }, { content: '   ' }])).toBeNull();
    expect(geminiPlanEntriesToInput([])).toBeNull();
    expect(geminiPlanEntriesToInput(undefined)).toBeNull();
    expect(geminiPlanEntriesToInput('nope')).toBeNull();
  });
});
