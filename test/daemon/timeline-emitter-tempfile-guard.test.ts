/**
 * Tests for the 64KB temp-file inline size guard in `timeline-emitter`.
 *
 * PR-A C2 contract:
 *   T8 — files within MAX_TEMP_FILE_INLINE_BYTES are inlined as before.
 *        Oversized files are NOT read; a warn log fires and the payload
 *        keeps the original `@ref` text + a `tempFileSize` marker so the
 *        web UI can resolve the body via the file-preview pool.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// Mock the timeline store so we capture appends without writing to disk.
const storeMocks = vi.hoisted(() => ({
  append: vi.fn(async () => undefined),
  read: vi.fn(() => []),
  getLatest: vi.fn(() => null),
  truncate: vi.fn(async () => undefined),
  cleanup: vi.fn(async () => undefined),
}));

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: storeMocks,
}));

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/util/logger.js', () => ({
  default: loggerMocks,
}));

// Skip context-store side effects in tests.
vi.mock('../../src/store/context-store.js', () => ({
  recordTurnUsage: vi.fn(),
}));

describe('timeline-emitter temp file size guard (T8)', () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'imcodes-tempfile-guard-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  function tempFilePath(): string {
    // The trusted-path regex requires `.imcodes-prompt-<hex>.md`.
    const hex = randomBytes(8).toString('hex');
    return join(tempDir!, `.imcodes-prompt-${hex}.md`);
  }

  it('T8a: small temp file (<64KB) is inlined into payload.text', async () => {
    const { TimelineEmitter } = await import('../../src/daemon/timeline-emitter.js');
    const emitter = new TimelineEmitter();
    const file = tempFilePath();
    const body = 'small body content';
    writeFileSync(file, body, 'utf-8');

    const event = emitter.emit('session-small', 'user.message', {
      text: `Read and execute all instructions in @${file}`,
    });

    expect(event).not.toBeNull();
    const payload = event!.payload as Record<string, unknown>;
    expect(payload.text).toBe(body);
    expect(payload.tempFile).toBe(file);
    expect(payload.tempFileSize).toBeUndefined();
    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });

  it('T8b: oversized temp file (>64KB) is NOT read; warn fires and tempFileSize is surfaced', async () => {
    const { TimelineEmitter } = await import('../../src/daemon/timeline-emitter.js');
    const emitter = new TimelineEmitter();
    const file = tempFilePath();
    const oversized = 'x'.repeat(100 * 1024); // 100 KB > 64 KB
    writeFileSync(file, oversized, 'utf-8');

    const originalText = `Read and execute all instructions in @${file}`;
    const event = emitter.emit('session-big', 'user.message', {
      text: originalText,
    });

    expect(event).not.toBeNull();
    const payload = event!.payload as Record<string, unknown>;
    // Original ref text preserved (NOT replaced with body)
    expect(payload.text).toBe(originalText);
    expect(payload.tempFile).toBe(file);
    expect(payload.tempFileSize).toBe(oversized.length);

    // Warn must include the size + path for ops visibility.
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-big',
        path: file,
        size: oversized.length,
        maxBytes: 64 * 1024,
      }),
      'timeline-emitter: temp file exceeds inline size; keeping @ref text',
    );
  });

  it('T8c: missing temp file is swallowed (no warn, no inline)', async () => {
    const { TimelineEmitter } = await import('../../src/daemon/timeline-emitter.js');
    const emitter = new TimelineEmitter();
    const file = join(tempDir!, '.imcodes-prompt-deadbeefdeadbeef.md');
    const originalText = `Read and execute all instructions in @${file}`;

    const event = emitter.emit('session-missing', 'user.message', {
      text: originalText,
    });

    expect(event).not.toBeNull();
    const payload = event!.payload as Record<string, unknown>;
    expect(payload.text).toBe(originalText);
    expect(payload.tempFile).toBeUndefined();
    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });
});
