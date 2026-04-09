import { describe, expect, it } from 'vitest';

import { getSelectedServerName } from '../src/server-selection.js';

describe('getSelectedServerName', () => {
  it('uses the persisted fallback before the server list is loaded', () => {
    expect(getSelectedServerName('srv-2', [], 'Server Two')).toBe('Server Two');
  });

  it('switches to the current server name once the server list is available', () => {
    expect(getSelectedServerName(
      'srv-2',
      [
        { id: 'srv-1', name: 'Server One' },
        { id: 'srv-2', name: 'Server Two' },
      ],
      'Server One',
    )).toBe('Server Two');
  });

  it('drops a stale fallback when the selected server is not in the loaded list', () => {
    expect(getSelectedServerName(
      'srv-2',
      [{ id: 'srv-1', name: 'Server One' }],
      'Server One',
    )).toBeNull();
  });
});
