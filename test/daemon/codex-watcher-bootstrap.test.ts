import { beforeEach, describe, expect, it, vi } from 'vitest';

const writeFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mkdirMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const readdirMock = vi.hoisted(() => vi.fn().mockRejectedValue(new Error('missing')));
const execMock = vi.hoisted(() => vi.fn((cmd: string, cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
  cb?.(null, { stdout: cmd.includes('--version') ? 'codex-cli 0.113.0\n' : '', stderr: '' });
  return {} as any;
}));
const readProjectMemoryMock = vi.hoisted(() => vi.fn().mockResolvedValue('# Project context'));
const appendAgentSendDocsMock = vi.hoisted(() => vi.fn((memory: string | null) => `${memory ?? ''}\n\nAGENT_SEND_DOCS`.trim()));
const buildSessionBootstrapContextMock = vi.hoisted(() => vi.fn().mockResolvedValue('# Project context\n\nAGENT_SEND_DOCS'));
const buildCodexMemoryEntryMock = vi.hoisted(() => vi.fn((memory: string, timestamp: string) => JSON.stringify({
  timestamp,
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: memory }] },
})));
const readProcessedMemoryItemsMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const timelineEmitMock = vi.hoisted(() => vi.fn());

vi.mock('fs/promises', () => ({
  watch: vi.fn(),
  readdir: readdirMock,
  stat: vi.fn(),
  open: vi.fn(),
  mkdir: mkdirMock,
  writeFile: writeFileMock,
}));

vi.mock('os', () => ({
  homedir: () => '/tmp/home',
}));

vi.mock('node:child_process', () => ({
  exec: execMock,
}));

vi.mock('../../src/daemon/memory-inject.js', () => ({
  readProjectMemory: readProjectMemoryMock,
  appendAgentSendDocs: appendAgentSendDocsMock,
  buildSessionBootstrapContext: buildSessionBootstrapContextMock,
  buildCodexMemoryEntry: buildCodexMemoryEntryMock,
  readProcessedMemoryItems: readProcessedMemoryItemsMock,
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: timelineEmitMock,
  },
}));

import { ensureSessionFile } from '../../src/daemon/codex-watcher.js';

describe('ensureSessionFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readdirMock.mockRejectedValue(new Error('missing'));
    readProcessedMemoryItemsMock.mockResolvedValue([]);
    delete process.env.IMCODES_SHARED_CONTEXT_LEGACY_INJECTION_DISABLED;
  });

  it('uses buildSessionBootstrapContext before legacy injection is disabled', async () => {
    await ensureSessionFile('uuid-1', '/proj');

    expect(buildSessionBootstrapContextMock).toHaveBeenCalledWith('/proj', 'proj');
    expect(buildCodexMemoryEntryMock).toHaveBeenCalledWith(expect.any(String), expect.any(String));
  });

  it('uses a neutral bootstrap message instead of legacy memory when legacy injection is disabled', async () => {
    process.env.IMCODES_SHARED_CONTEXT_LEGACY_INJECTION_DISABLED = 'true';

    await ensureSessionFile('uuid-2', '/proj');

    expect(buildSessionBootstrapContextMock).not.toHaveBeenCalled();
    expect(buildCodexMemoryEntryMock).toHaveBeenCalledWith(
      'Shared context bootstrap deferred to runtime assembly.',
      expect.any(String),
    );
  });

  it('emits a startup memory.context timeline event when processed memory exists', async () => {
    readProcessedMemoryItemsMock.mockResolvedValue([
      {
        id: 'mem-1',
        type: 'processed',
        projectId: 'proj',
        scope: 'personal',
        summary: 'Fix websocket reconnect loop',
        createdAt: 1,
        hitCount: 3,
        relevanceScore: 0.77,
      },
    ]);

    await ensureSessionFile('uuid-3', '/proj', 'deck_proj_brain');

    expect(timelineEmitMock).toHaveBeenCalledWith(
      'deck_proj_brain',
      'memory.context',
      expect.objectContaining({
        reason: 'startup',
        injectedText: '[Related past work]\n- [proj] Fix websocket reconnect loop',
      }),
      expect.any(Object),
    );
  });
});
