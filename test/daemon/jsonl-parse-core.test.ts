/**
 * Unit tests for the pure Claude-Code JSONL parser.
 *
 * Focus: the parser emits the same instruction sequence that the
 * (historical) inline `parseLine` in jsonl-watcher emitted. jsonl-watcher's
 * own test file remains the source of truth for end-to-end watcher behavior;
 * here we verify the pure module in isolation — no timers, no fs.
 */

import { describe, it, expect } from 'vitest';
import {
  createParseContext,
  parseLines,
  forgetSession,
  type EmitInstruction,
} from '../../src/daemon/jsonl-parse-core.js';

function jsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function typesOf(emits: EmitInstruction[]): string[] {
  return emits.map((e) => e.type);
}

describe('jsonl-parse-core', () => {
  it('emits assistant.text for string content (no usage for string form)', () => {
    const ctx = createParseContext();
    const line = jsonlLine({
      type: 'assistant',
      timestamp: '2026-04-24T00:00:00.000Z',
      // String-form content short-circuits before the usage extraction path,
      // matching the original jsonl-watcher behavior.
      message: { content: 'hello', usage: { input_tokens: 5 }, model: 'claude' },
    });
    const { emits } = parseLines(ctx, {
      sessionName: 's1',
      items: [{ line, lineByteOffset: 0 }],
    });
    expect(typesOf(emits)).toEqual(['assistant.text']);
    expect(emits[0].payload.text).toBe('hello');
    expect(emits[0].payload.streaming).toBe(false);
  });

  it('emits usage.update after array-form assistant content', () => {
    const ctx = createParseContext();
    const line = jsonlLine({
      type: 'assistant',
      timestamp: '2026-04-24T00:00:00.000Z',
      message: {
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 5 },
        model: 'claude',
      },
    });
    const { emits } = parseLines(ctx, {
      sessionName: 's1',
      items: [{ line, lineByteOffset: 0 }],
    });
    expect(typesOf(emits)).toEqual(['assistant.text', 'usage.update']);
  });

  it('emits assistant.thinking for thinking blocks', () => {
    const ctx = createParseContext();
    const line = jsonlLine({
      type: 'assistant',
      timestamp: '2026-04-24T00:00:00.000Z',
      message: { content: [{ type: 'thinking', thinking: 'pondering' }] },
    });
    const { emits } = parseLines(ctx, {
      sessionName: 's1',
      items: [{ line, lineByteOffset: 0 }],
    });
    expect(typesOf(emits)).toEqual(['assistant.thinking']);
    expect(emits[0].payload.text).toBe('pondering');
  });

  it('emits user.message for plain user text', () => {
    const ctx = createParseContext();
    const line = jsonlLine({
      type: 'user',
      timestamp: '2026-04-24T00:00:00.000Z',
      message: { content: 'hi' },
    });
    const { emits } = parseLines(ctx, {
      sessionName: 's1',
      items: [{ line, lineByteOffset: 0 }],
    });
    expect(typesOf(emits)).toEqual(['user.message']);
    expect(emits[0].payload.text).toBe('hi');
  });

  it('replaces system-injected user text with agent.status processing', () => {
    const ctx = createParseContext();
    const line = jsonlLine({
      type: 'user',
      timestamp: '2026-04-24T00:00:00.000Z',
      message: { content: '<system-reminder>refresh memory</system-reminder>' },
    });
    const { emits } = parseLines(ctx, {
      sessionName: 's1',
      items: [{ line, lineByteOffset: 0 }],
    });
    expect(typesOf(emits)).toEqual(['agent.status']);
    expect(emits[0].payload.status).toBe('processing');
  });

  it('correlates tool_use with tool_result via pending map', () => {
    const ctx = createParseContext();
    const useLine = jsonlLine({
      type: 'assistant',
      timestamp: '2026-04-24T00:00:00.000Z',
      message: {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }],
      },
    });
    const resultLine = jsonlLine({
      type: 'user',
      timestamp: '2026-04-24T00:00:01.000Z',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'output' }],
      },
    });

    const { emits: firstEmits } = parseLines(ctx, {
      sessionName: 's1',
      items: [{ line: useLine, lineByteOffset: 0 }],
    });
    expect(typesOf(firstEmits)).toEqual(['tool.call']);
    expect(firstEmits[0].payload.tool).toBe('Bash');
    expect(ctx.pendingToolCalls.get('s1')?.has('tu_1')).toBe(true);

    const { emits: secondEmits } = parseLines(ctx, {
      sessionName: 's1',
      items: [{ line: resultLine, lineByteOffset: 1 }],
    });
    expect(typesOf(secondEmits)).toEqual(['tool.result']);
    // After a successful take, pending map entry is cleared.
    expect(ctx.pendingToolCalls.get('s1')?.has('tu_1') ?? false).toBe(false);
  });

  it('emits file.change + hidden tool rows for Edit tool once the result arrives', () => {
    const ctx = createParseContext();
    const editUse = jsonlLine({
      type: 'assistant',
      timestamp: '2026-04-24T00:00:00.000Z',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_edit',
          name: 'Edit',
          input: { file_path: '/tmp/x.ts', old_string: 'a', new_string: 'b' },
        }],
      },
    });
    const editResult = jsonlLine({
      type: 'user',
      timestamp: '2026-04-24T00:00:01.000Z',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_edit',
          content: 'Edited',
          toolUseResult: {
            type: 'update',
            filePath: '/tmp/x.ts',
            oldString: 'a',
            newString: 'b',
          },
        }],
      },
    });

    // Edit's call is DEFERRED — no tool.call emitted here, just state tracked.
    const { emits: useEmits } = parseLines(ctx, {
      sessionName: 's1',
      items: [{ line: editUse, lineByteOffset: 0 }],
    });
    expect(typesOf(useEmits)).toEqual([]);

    const { emits: resultEmits } = parseLines(ctx, {
      sessionName: 's1',
      items: [{ line: editResult, lineByteOffset: 1 }],
    });
    // Expect (hidden) tool.call + (hidden) tool.result + file.change
    expect(typesOf(resultEmits)).toEqual(['tool.call', 'tool.result', 'file.change']);
    expect(resultEmits[0].metadata.hidden).toBe(true);
    expect(resultEmits[1].metadata.hidden).toBe(true);
    expect(resultEmits[2].type).toBe('file.change');
  });

  it('emits usage.update with preset context window when model is unknown', () => {
    const ctx = createParseContext();
    const line = jsonlLine({
      type: 'assistant',
      timestamp: '2026-04-24T00:00:00.000Z',
      message: {
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
        // Unknown model name → inferContextWindow returns undefined → preset wins.
        model: 'custom-model-xyz',
      },
    });
    const { emits } = parseLines(ctx, {
      sessionName: 's1',
      items: [{ line, lineByteOffset: 0 }],
      presetContextWindow: 400_000,
    });
    const usage = emits.find((e) => e.type === 'usage.update');
    expect(usage).toBeDefined();
    expect(usage!.payload.contextWindow).toBe(400_000);
    expect(usage!.payload.inputTokens).toBe(110); // 100 + cache_creation_input_tokens
    expect(usage!.payload.cacheTokens).toBe(50);
    expect(usage!.payload.model).toBe('custom-model-xyz');
  });

  it('prefers inferred context window over preset when model is known', () => {
    const ctx = createParseContext();
    const line = jsonlLine({
      type: 'assistant',
      timestamp: '2026-04-24T00:00:00.000Z',
      message: {
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1 },
        model: 'claude-sonnet-4',
      },
    });
    const { emits } = parseLines(ctx, {
      sessionName: 's1',
      items: [{ line, lineByteOffset: 0 }],
      presetContextWindow: 400_000,
    });
    const usage = emits.find((e) => e.type === 'usage.update');
    // claude-sonnet-4 infers to 1M which takes precedence over preset.
    expect(usage!.payload.contextWindow).toBe(1_000_000);
  });

  it('ignores invalid JSON and empty lines', () => {
    const ctx = createParseContext();
    const { emits } = parseLines(ctx, {
      sessionName: 's1',
      items: [
        { line: '', lineByteOffset: 0 },
        { line: '   ', lineByteOffset: 1 },
        { line: '{not-json}', lineByteOffset: 2 },
      ],
    });
    expect(emits).toEqual([]);
  });

  it('generates stable eventIds tied to byte offset', () => {
    const ctx = createParseContext();
    const line = jsonlLine({
      type: 'assistant',
      timestamp: '2026-04-24T00:00:00.000Z',
      message: { content: 'hello' },
    });
    const first = parseLines(ctx, { sessionName: 's1', items: [{ line, lineByteOffset: 42 }] });
    const second = parseLines(createParseContext(), { sessionName: 's1', items: [{ line, lineByteOffset: 42 }] });
    // Same session + offset + line → same eventId regardless of ctx
    expect(first.emits[0].metadata.eventId).toBe(second.emits[0].metadata.eventId);
    expect(first.emits[0].metadata.eventId).toContain(':42:');
  });

  it('forgetSession drops pending tool state for that session only', () => {
    const ctx = createParseContext();
    const useA = jsonlLine({
      type: 'assistant',
      timestamp: '2026-04-24T00:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'tu_a', name: 'Bash', input: { command: 'a' } }] },
    });
    const useB = jsonlLine({
      type: 'assistant',
      timestamp: '2026-04-24T00:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'tu_b', name: 'Bash', input: { command: 'b' } }] },
    });
    parseLines(ctx, { sessionName: 'sA', items: [{ line: useA, lineByteOffset: 0 }] });
    parseLines(ctx, { sessionName: 'sB', items: [{ line: useB, lineByteOffset: 0 }] });
    expect(ctx.pendingToolCalls.get('sA')?.has('tu_a')).toBe(true);
    expect(ctx.pendingToolCalls.get('sB')?.has('tu_b')).toBe(true);
    forgetSession(ctx, 'sA');
    expect(ctx.pendingToolCalls.has('sA')).toBe(false);
    expect(ctx.pendingToolCalls.get('sB')?.has('tu_b')).toBe(true);
  });
});
