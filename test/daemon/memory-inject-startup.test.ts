import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  readFileMock,
  writeFileMock,
  readdirMock,
  emitMock,
  searchLocalMemoryMock,
} = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  writeFileMock: vi.fn().mockResolvedValue(undefined),
  readdirMock: vi.fn(),
  emitMock: vi.fn(),
  searchLocalMemoryMock: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: readFileMock,
  writeFile: writeFileMock,
  readdir: readdirMock,
}));

vi.mock('os', () => ({
  homedir: () => '/tmp/home',
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: emitMock,
  },
}));

vi.mock('../../src/context/memory-search.js', () => ({
  searchLocalMemory: searchLocalMemoryMock,
}));

import { injectGeminiMemoryWithTimeline } from '../../src/daemon/memory-inject.js';

describe('injectGeminiMemoryWithTimeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readdirMock
      .mockResolvedValueOnce(['slug-1'])
      .mockResolvedValueOnce(['session-anything-12345678.json']);
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith('.json')) {
        return JSON.stringify({
          messages: [
            {
              type: 'user',
              content: [{ text: 'hi' }],
            },
          ],
        });
      }
      return '# Project context';
    });
    searchLocalMemoryMock.mockReturnValue({
      items: [
        {
          id: 'mem-1',
          type: 'processed',
          projectId: 'proj',
          scope: 'personal',
          summary: 'Fix websocket reconnect loop',
          createdAt: 1,
          hitCount: 2,
          relevanceScore: 0.81,
        },
      ],
      stats: {
        totalRecords: 1,
        matchedRecords: 1,
        recentSummaryCount: 1,
        durableCandidateCount: 0,
        projectCount: 1,
        stagedEventCount: 0,
        dirtyTargetCount: 0,
        pendingJobCount: 0,
      },
    });
  });

  it('emits startup memory.context after injecting Gemini bootstrap memory', async () => {
    await injectGeminiMemoryWithTimeline('deck_proj_brain', '12345678-abcd-efgh', '/proj', 'proj');

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(
      'deck_proj_brain',
      'memory.context',
      expect.objectContaining({
        reason: 'startup',
        injectedText: '[Related past work]\n<related-past-work advisory="true">\n- [proj] Fix websocket reconnect loop\n</related-past-work>',
        items: [
          expect.objectContaining({
            id: 'mem-1',
            projectId: 'proj',
            hitCount: 2,
            relevanceScore: 0.81,
            scope: 'personal',
          }),
        ],
      }),
      expect.any(Object),
    );
  });
});
