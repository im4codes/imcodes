import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeClaudeFileChange,
  normalizeCodexSdkFileChange,
  normalizeGeminiFileChange,
  normalizeOpenCodeFileChange,
  normalizeQwenFileChange,
} from '../../src/daemon/file-change-normalizer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'file-change', name), 'utf8')) as T;
}

describe('file-change-normalizer', () => {
  it('normalizes Claude Edit as an exact update patch', () => {
    const batch = normalizeClaudeFileChange(loadFixture('claude-edit.json'));

    expect(batch?.provider).toBe('claude-code');
    expect(batch?.patches).toEqual([
      expect.objectContaining({
        filePath: 'src/app.ts',
        operation: 'update',
        confidence: 'exact',
        beforeText: 'before',
        afterText: 'after',
      }),
    ]);
  });

  it('normalizes Claude Write as a derived create/update patch', () => {
    const batch = normalizeClaudeFileChange(loadFixture('claude-write.json'));

    expect(batch?.provider).toBe('claude-code');
    expect(batch?.patches[0]).toEqual(expect.objectContaining({
      filePath: 'src/new.ts',
      operation: 'create',
      confidence: 'derived',
      afterText: 'export const value = 1;',
    }));
  });

  it('normalizes OpenCode write as a derived create patch', () => {
    const batch = normalizeOpenCodeFileChange(loadFixture('opencode-write.json'));

    expect(batch?.provider).toBe('opencode');
    expect(batch?.patches[0]).toEqual(expect.objectContaining({
      filePath: 'src/new.ts',
      operation: 'create',
      confidence: 'derived',
      afterText: 'export {};',
    }));
  });

  it('normalizes codex-sdk fileChange arrays', () => {
    const batch = normalizeCodexSdkFileChange(loadFixture('codex-file-change.json'));

    expect(batch?.provider).toBe('codex-sdk');
    expect(batch?.patches).toHaveLength(2);
    expect(batch?.patches[0]?.confidence).toBe('exact');
    expect(batch?.patches[1]).toEqual(expect.objectContaining({
      filePath: 'src/b.ts',
      operation: 'create',
      confidence: 'derived',
      afterText: 'new file',
    }));
  });

  it('normalizes Qwen file tools from structured input', () => {
    const batch = normalizeQwenFileChange(loadFixture('qwen-write.json'));

    expect(batch?.patches[0]).toEqual(expect.objectContaining({
      filePath: 'src/qwen.ts',
      confidence: 'derived',
    }));
  });

  it('normalizes Gemini explicit file tools and ignores shell-only tools', () => {
    const batch = normalizeGeminiFileChange(loadFixture('gemini-write-file.json'));

    expect(batch?.patches[0]).toEqual(expect.objectContaining({
      filePath: 'src/gemini.ts',
      confidence: 'derived',
    }));

    expect(normalizeGeminiFileChange({
      toolName: 'run_shell_command',
      toolCallId: 'gm-2',
      args: { command: 'sed -i ...' },
      status: 'success',
    })).toBeNull();
  });

  it('does not emit patches when file identity is missing', () => {
    expect(normalizeQwenFileChange({
      toolName: 'Write',
      toolCallId: 'qw-2',
      input: { content: 'missing path' },
    })).toBeNull();
  });

  it('ignores malformed codex patches that lack a stable file path', () => {
    expect(normalizeCodexSdkFileChange({
      toolCallId: 'cx-2',
      detail: {
        input: {
          changes: [
            { op: 'update', beforeText: 'a', afterText: 'b' },
          ],
        },
      },
    })).toBeNull();
  });

  it('degrades non-text payloads to coarse patches instead of fabricating inline diffs', () => {
    const batch = normalizeQwenFileChange(loadFixture('qwen-binary.json'));

    expect(batch?.patches[0]).toEqual(expect.objectContaining({
      filePath: 'assets/logo.png',
      confidence: 'coarse',
    }));
    expect(batch?.patches[0]?.afterText).toBeUndefined();
  });
});
