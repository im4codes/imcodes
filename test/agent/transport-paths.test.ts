import { describe, expect, it } from 'vitest';

import { normalizeTransportCwd } from '../../src/agent/transport-paths.js';

describe('normalizeTransportCwd', () => {
  it('returns an absolute cwd on non-Windows hosts', () => {
    const result = normalizeTransportCwd('test/fixtures');
    expect(result).toBeDefined();
    expect(result).not.toBe('test/fixtures');
  });

  it('normalizes backslashes to forward slashes on Windows', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      expect(normalizeTransportCwd('C:\\Users\\admin\\project')).toBe('C:/Users/admin/project');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });
});
