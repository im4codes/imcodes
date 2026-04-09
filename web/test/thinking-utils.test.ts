import { describe, expect, it } from 'vitest';

import { getActiveStatusText } from '../src/thinking-utils.js';

describe('getActiveStatusText', () => {
  it('returns the latest trailing status label', () => {
    expect(getActiveStatusText([
      { type: 'assistant.text', payload: { text: 'done' } },
      { type: 'agent.status', payload: { status: 'compacting', label: 'Compacting conversation...' } },
    ])).toBe('Compacting conversation...');
  });

  it('treats an unlabeled trailing status as an explicit clear', () => {
    expect(getActiveStatusText([
      { type: 'agent.status', payload: { status: 'compacting', label: 'Compacting conversation...' } },
      { type: 'agent.status', payload: { status: null, label: null } },
    ])).toBeNull();
  });
});
