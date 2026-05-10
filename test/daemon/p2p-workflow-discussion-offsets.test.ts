import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  __resetReadOffsetsForTests,
  clearReadOffsetsForRun,
  getRecordedReadOffset,
  readP2pDiscussionWithOffset,
} from '../../src/daemon/p2p-workflow-discussion-offsets.js';

// Naming pattern matched by `shared/test-session-guard.ts::PROJECT_DIR_PATTERNS`
// (`/^.*imc_p2p_wf_test_.*/i`) so leaked fixtures are recognised as test data.
function makeTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'imc_p2p_wf_test_offsets_'));
}

describe('readP2pDiscussionWithOffset (Tasks 5.4 / 12.4)', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    __resetReadOffsetsForTests();
    dir = makeTestDir();
    filePath = join(dir, 'discussion.md');
  });

  afterEach(() => {
    __resetReadOffsetsForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('first read records offset and returns fresh content', async () => {
    const initial = '## User Request\nhello world\n';
    writeFileSync(filePath, initial, 'utf8');

    const result = await readP2pDiscussionWithOffset({
      runId: 'run-1',
      sourceKey: 'discussion-a',
      filePath,
      policy: 'reset',
    });

    expect(result.reset).toBe('fresh');
    expect(result.content).toBe(initial);
    expect(result.diagnostics).toEqual([]);
    expect(result.newOffset.byteOffset).toBe(Buffer.byteLength(initial, 'utf8'));
    expect(result.newOffset.sizeAtOffset).toBe(Buffer.byteLength(initial, 'utf8'));
    expect(result.newOffset.sha256Prefix).toMatch(/^[a-f0-9]{16}$/);

    const recorded = getRecordedReadOffset('run-1', 'discussion-a');
    expect(recorded).not.toBeNull();
    expect(recorded!.byteOffset).toBe(result.newOffset.byteOffset);
    expect(recorded!.sha256Prefix).toBe(result.newOffset.sha256Prefix);
  });

  it('second incremental read returns only new bytes appended after previous offset', async () => {
    const first = '## User Request\nhello\n';
    writeFileSync(filePath, first, 'utf8');
    const firstResult = await readP2pDiscussionWithOffset({
      runId: 'run-2', sourceKey: 'discussion-b', filePath, policy: 'reset',
    });
    expect(firstResult.reset).toBe('fresh');

    const appended = '\n## Hop 1\nmore content here\n';
    appendFileSync(filePath, appended, 'utf8');

    const secondResult = await readP2pDiscussionWithOffset({
      runId: 'run-2', sourceKey: 'discussion-b', filePath, policy: 'reset',
    });

    expect(secondResult.reset).toBe('incremental');
    expect(secondResult.diagnostics).toEqual([]);
    expect(secondResult.content).toBe(appended);
    expect(secondResult.newOffset.byteOffset).toBe(
      Buffer.byteLength(first + appended, 'utf8'),
    );
    expect(secondResult.newOffset.sizeAtOffset).toBe(secondResult.newOffset.byteOffset);
  });

  it('mismatch (file rotated/truncated) with policy: reset returns full bounded read + safe_reset diagnostic', async () => {
    writeFileSync(filePath, 'original content here\n', 'utf8');
    await readP2pDiscussionWithOffset({
      runId: 'run-3', sourceKey: 'discussion-c', filePath, policy: 'reset',
    });

    // Simulate rotation: rewrite the file with completely different shorter content.
    writeFileSync(filePath, 'rotated\n', 'utf8');

    const result = await readP2pDiscussionWithOffset({
      runId: 'run-3', sourceKey: 'discussion-c', filePath, policy: 'reset',
    });

    expect(result.reset).toBe('mismatch_safe_reset');
    expect(result.content).toBe('rotated\n');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'missing_context_source',
      severity: 'warning',
      runId: 'run-3',
    });
    expect(result.newOffset.byteOffset).toBe(Buffer.byteLength('rotated\n', 'utf8'));
  });

  it('mismatch with policy: fail returns fail_closed + error diagnostic and does not advance offset', async () => {
    writeFileSync(filePath, 'aaaaaaaaaaaaa\n', 'utf8');
    const firstResult = await readP2pDiscussionWithOffset({
      runId: 'run-4', sourceKey: 'discussion-d', filePath, policy: 'fail',
    });
    const recordedBefore = getRecordedReadOffset('run-4', 'discussion-d');
    expect(recordedBefore).not.toBeNull();
    expect(firstResult.reset).toBe('fresh');

    // Rewrite the file with different bytes preceding the recorded offset.
    writeFileSync(filePath, 'bbbbbbbbbbbbb\n', 'utf8');

    let thrown: unknown;
    try {
      await readP2pDiscussionWithOffset({
        runId: 'run-4', sourceKey: 'discussion-d', filePath, policy: 'fail',
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const wrapped = thrown as Error & {
      code?: string;
      result?: { reset?: string; diagnostics?: Array<{ code: string; severity: string }> };
    };
    expect(wrapped.code).toBe('discussion_read_offset_mismatch');
    expect(wrapped.result?.reset).toBe('mismatch_fail_closed');
    expect(wrapped.result?.diagnostics?.[0]).toMatchObject({
      code: 'missing_context_source',
      severity: 'error',
    });

    // Offset must NOT have advanced past the previously recorded value.
    const recordedAfter = getRecordedReadOffset('run-4', 'discussion-d');
    expect(recordedAfter).toEqual(recordedBefore);
  });

  it("clearReadOffsetsForRun drops only that run's offsets", async () => {
    writeFileSync(filePath, 'shared file\n', 'utf8');
    await readP2pDiscussionWithOffset({
      runId: 'run-A', sourceKey: 'discussion-x', filePath, policy: 'reset',
    });
    await readP2pDiscussionWithOffset({
      runId: 'run-B', sourceKey: 'discussion-x', filePath, policy: 'reset',
    });

    expect(getRecordedReadOffset('run-A', 'discussion-x')).not.toBeNull();
    expect(getRecordedReadOffset('run-B', 'discussion-x')).not.toBeNull();

    clearReadOffsetsForRun('run-A');

    expect(getRecordedReadOffset('run-A', 'discussion-x')).toBeNull();
    expect(getRecordedReadOffset('run-B', 'discussion-x')).not.toBeNull();
  });

  it('bounded maxBytes truncates content but advances offset by amount actually consumed', async () => {
    const payload = 'X'.repeat(2048);
    writeFileSync(filePath, payload, 'utf8');

    const result = await readP2pDiscussionWithOffset({
      runId: 'run-5', sourceKey: 'discussion-e', filePath, policy: 'reset', maxBytes: 100,
    });

    expect(result.reset).toBe('fresh');
    expect(result.content).toHaveLength(100);
    expect(result.newOffset.byteOffset).toBe(100);
    // sizeAtOffset still reflects current full file size, even though we capped
    // the read — the offset is *where we stopped*, the size is *where the file
    // currently ends*.
    expect(result.newOffset.sizeAtOffset).toBe(2048);

    // Subsequent incremental call resumes from byte 100 and continues capped.
    const second = await readP2pDiscussionWithOffset({
      runId: 'run-5', sourceKey: 'discussion-e', filePath, policy: 'reset', maxBytes: 100,
    });
    expect(second.reset).toBe('incremental');
    expect(second.content).toHaveLength(100);
    expect(second.newOffset.byteOffset).toBe(200);
  });
});
