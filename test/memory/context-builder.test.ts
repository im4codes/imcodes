import { describe, it, expect, vi } from 'vitest';
import { buildMemoryMd } from '../../src/memory/context-builder.js';
import type { MemorySearchResult } from '../../src/memory/interface.js';

describe('buildMemoryMd()', () => {
  it('generates markdown with section heading', async () => {
    const mockResults: MemorySearchResult[] = [
      { id: '1', content: 'Implemented auth middleware', score: 0.9, timestamp: Date.now() },
      { id: '2', content: 'Fixed JWT validation bug', score: 0.8, timestamp: Date.now() },
    ];

    const mockBackend = {
      isAvailable: vi.fn().mockResolvedValue(true),
      addObservation: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue(mockResults),
      getProjectContext: vi.fn().mockResolvedValue(mockResults),
      summarizeSession: vi.fn().mockResolvedValue('Session summary'),
    };

    const md = await buildMemoryMd(mockBackend, 'test-project', 'auth implementation');
    expect(md).toContain('auth middleware');
    expect(md).toContain('JWT');
  });

  it('returns empty string if no results', async () => {
    const mockBackend = {
      isAvailable: vi.fn().mockResolvedValue(true),
      addObservation: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([]),
      getProjectContext: vi.fn().mockResolvedValue([]),
      summarizeSession: vi.fn().mockResolvedValue(''),
    };

    const md = await buildMemoryMd(mockBackend, 'test-project', 'something');
    expect(md.trim()).toBe('');
  });

  it('handles backend errors gracefully', async () => {
    const mockBackend = {
      isAvailable: vi.fn().mockResolvedValue(true),
      addObservation: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockRejectedValue(new Error('Backend error')),
      getProjectContext: vi.fn().mockResolvedValue([]),
      summarizeSession: vi.fn().mockResolvedValue(''),
    };

    // Should not throw
    const md = await buildMemoryMd(mockBackend, 'test-project', 'query');
    expect(typeof md).toBe('string');
  });
});
