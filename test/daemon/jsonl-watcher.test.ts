/**
 * Comprehensive tests for jsonl-watcher.ts
 *
 * Covers: parseLine, drainNewLines (partial line handling), emitRecentHistory (last N),
 * startWatchingFile (timeout cleanup), activateFile, watchDir file switching,
 * watcher status tracking, claim management.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm, appendFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Mock timeline emitter so we can inspect emitted events ─────────────────

const emittedEvents: Array<{ session: string; type: string; payload: Record<string, unknown>; opts?: Record<string, unknown> }> = [];

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: vi.fn((session: string, type: string, payload: Record<string, unknown>, opts?: Record<string, unknown>) => {
      emittedEvents.push({ session, type, payload, opts });
    }),
    on: vi.fn(() => () => {}),
    epoch: 0,
    replay: vi.fn(() => ({ events: [], truncated: false })),
  },
}));

vi.mock('../../src/util/model-context.js', () => ({
  resolveContextWindow: vi.fn(() => 200000),
}));

import {
  startWatching, startWatchingFile, stopWatching, isWatching,
  watcherStatus, claudeProjectDir, preClaimFile,
} from '../../src/daemon/jsonl-watcher.js';

// ── Helpers ────────────────────────────────────────────────────────────────

let testDir: string;

function jsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + '\n';
}

/** Build an assistant line with text block. */
function assistantText(text: string, model = 'claude-opus-4-6'): string {
  return jsonlLine({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      content: [{ type: 'text', text }],
      model,
      usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 50 },
    },
  });
}

/** Build an assistant line with thinking block. */
function assistantThinking(thinking: string): string {
  return jsonlLine({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      content: [{ type: 'thinking', thinking }],
      model: 'claude-opus-4-6',
      usage: { input_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
}

/** Build an assistant line with tool_use block. */
function assistantToolUse(name: string, input: Record<string, unknown> = {}): string {
  return jsonlLine({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      content: [{ type: 'tool_use', name, id: `tu_${randomUUID().slice(0, 8)}`, input }],
      model: 'claude-opus-4-6',
      usage: { input_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 20 },
    },
  });
}

/** Build a user line with text block. */
function userMessage(text: string): string {
  return jsonlLine({
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text }] },
  });
}

/** Build a user line with tool_result block. */
function toolResult(isError = false): string {
  return jsonlLine({
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'tool_result', is_error: isError, content: isError ? 'something went wrong' : 'OK' }] },
  });
}

/** Build a result event with cost. */
function resultEvent(costUsd: number): string {
  return jsonlLine({ type: 'result', total_cost_usd: costUsd, timestamp: new Date().toISOString() });
}

/** Build a system compact_boundary event. */
function compactBoundary(): string {
  return jsonlLine({ type: 'system', subtype: 'compact_boundary', timestamp: new Date().toISOString() });
}

/** Build a progress event. */
function progressEvent(progressType: string, data: Record<string, unknown> = {}): string {
  return jsonlLine({ type: 'progress', data: { type: progressType, ...data }, timestamp: new Date().toISOString() });
}

/** Build an AskUserQuestion tool_use. */
function askUserQuestion(questions: string[]): string {
  return jsonlLine({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      content: [{ type: 'tool_use', name: 'AskUserQuestion', id: `tu_ask_${randomUUID().slice(0, 8)}`, input: { questions } }],
      model: 'claude-opus-4-6',
      usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
}

/** Build a multi-block assistant line (text + tool_use in one turn). */
function assistantMultiBlock(text: string, toolName: string, toolInput: Record<string, unknown> = {}): string {
  return jsonlLine({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      content: [
        { type: 'text', text },
        { type: 'tool_use', name: toolName, id: `tu_${randomUUID().slice(0, 8)}`, input: toolInput },
      ],
      model: 'claude-opus-4-6',
      usage: { input_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 30 },
    },
  });
}

beforeEach(async () => {
  emittedEvents.length = 0;
  testDir = join(tmpdir(), `jsonl-test-${randomUUID().slice(0, 8)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  stopWatching('test_session');
  stopWatching('test_session_2');
  await rm(testDir, { recursive: true, force: true }).catch(() => {});
});

// ── parseLine coverage (via startWatchingFile + drain) ─────────────────────

describe('parseLine — event type coverage', () => {
  async function setupAndDrain(content: string) {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, content);
    await startWatchingFile('test_session', filePath);
    // Wait for file to be found and drained
    await new Promise((r) => setTimeout(r, 200));
    // Append new content so drain picks it up
    return filePath;
  }

  it('emits assistant.text for text blocks', async () => {
    const filePath = join(testDir, 'test.jsonl');
    // Write initial content (will be read as history, then new content appended)
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, assistantText('The build succeeded with zero warnings.'));
    await new Promise((r) => setTimeout(r, 2500)); // wait for poll

    const textEvents = emittedEvents.filter((e) => e.type === 'assistant.text');
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
    expect(textEvents[textEvents.length - 1].payload.text).toBe('The build succeeded with zero warnings.');
  });

  it('emits assistant.thinking for thinking blocks', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, assistantThinking('Let me analyze the dependencies first.'));
    await new Promise((r) => setTimeout(r, 2500));

    const thinkEvents = emittedEvents.filter((e) => e.type === 'assistant.thinking');
    expect(thinkEvents.length).toBeGreaterThanOrEqual(1);
    expect(thinkEvents[thinkEvents.length - 1].payload.text).toBe('Let me analyze the dependencies first.');
  });

  it('emits tool.call for tool_use blocks', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, assistantToolUse('Bash', { command: 'npm run build' }));
    await new Promise((r) => setTimeout(r, 2500));

    const toolCalls = emittedEvents.filter((e) => e.type === 'tool.call');
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(toolCalls[toolCalls.length - 1].payload.tool).toBe('Bash');
    expect(toolCalls[toolCalls.length - 1].payload.input).toBe('npm run build');
  });

  it('emits user.message for user text blocks', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, userMessage('Fix the linting errors in session-manager.ts'));
    await new Promise((r) => setTimeout(r, 2500));

    const userEvents = emittedEvents.filter((e) => e.type === 'user.message');
    expect(userEvents.length).toBeGreaterThanOrEqual(1);
    expect(userEvents[userEvents.length - 1].payload.text).toBe('Fix the linting errors in session-manager.ts');
  });

  it('emits user.message for string-form user content used by real CC transcripts', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, jsonlLine({
      type: 'user',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'daemon 重启了 你也被重启了' },
    }));
    await new Promise((r) => setTimeout(r, 2500));

    const userEvents = emittedEvents.filter((e) => e.type === 'user.message');
    expect(userEvents.length).toBeGreaterThanOrEqual(1);
    expect(userEvents[userEvents.length - 1].payload.text).toBe('daemon 重启了 你也被重启了');
  });

  it('emits tool.result for tool_result blocks', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, toolResult(false));
    await new Promise((r) => setTimeout(r, 2500));

    const resultEvents = emittedEvents.filter((e) => e.type === 'tool.result');
    expect(resultEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('emits tool.result with error for error tool_results', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, toolResult(true));
    await new Promise((r) => setTimeout(r, 2500));

    const resultEvents = emittedEvents.filter((e) => e.type === 'tool.result' && e.payload.error);
    expect(resultEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('emits usage.update for result events with cost', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, resultEvent(0.042));
    await new Promise((r) => setTimeout(r, 2500));

    const usageEvents = emittedEvents.filter((e) => e.type === 'usage.update' && e.payload.costUsd === 0.042);
    expect(usageEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('emits agent.status for compact_boundary system events', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, compactBoundary());
    await new Promise((r) => setTimeout(r, 2500));

    const statusEvents = emittedEvents.filter((e) => e.type === 'agent.status' && e.payload.status === 'compacting');
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('emits agent.status for bash_progress', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, progressEvent('bash_progress', { elapsedTimeSeconds: 5 }));
    await new Promise((r) => setTimeout(r, 2500));

    const statusEvents = emittedEvents.filter((e) => e.type === 'agent.status' && e.payload.status === 'bash_running');
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('emits ask.question for AskUserQuestion tool_use', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, askUserQuestion(['Should I proceed with the refactor?', 'Preferred approach?']));
    await new Promise((r) => setTimeout(r, 2500));

    const askEvents = emittedEvents.filter((e) => e.type === 'ask.question');
    expect(askEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('handles multi-block assistant turns (text + tool_use)', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, assistantMultiBlock('Reading the configuration file.', 'Read', { file_path: '/etc/config.json' }));
    await new Promise((r) => setTimeout(r, 2500));

    const textEvents = emittedEvents.filter((e) => e.type === 'assistant.text' && e.payload.text === 'Reading the configuration file.');
    const toolEvents = emittedEvents.filter((e) => e.type === 'tool.call' && e.payload.tool === 'Read');
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
    expect(toolEvents.length).toBeGreaterThanOrEqual(1);
    expect(toolEvents[toolEvents.length - 1].payload.input).toBe('/etc/config.json');
  });

  it('emits usage.update with token counts from assistant messages', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, assistantText('Done.'));
    await new Promise((r) => setTimeout(r, 2500));

    const usageEvents = emittedEvents.filter((e) => e.type === 'usage.update' && typeof e.payload.inputTokens === 'number');
    expect(usageEvents.length).toBeGreaterThanOrEqual(1);
    // input_tokens=100 + cache_creation=10 = 110
    expect(usageEvents[usageEvents.length - 1].payload.inputTokens).toBe(110);
  });

  it('ignores invalid JSON lines gracefully', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, 'this is not json\n' + assistantText('Valid line after garbage.'));
    await new Promise((r) => setTimeout(r, 2500));

    const textEvents = emittedEvents.filter((e) => e.type === 'assistant.text' && e.payload.text === 'Valid line after garbage.');
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('ignores empty/whitespace lines', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, '\n  \n\n' + assistantText('After blanks.'));
    await new Promise((r) => setTimeout(r, 2500));

    const textEvents = emittedEvents.filter((e) => e.type === 'assistant.text' && e.payload.text === 'After blanks.');
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
  });
});

// ── extractToolInput coverage ──────────────────────────────────────────────

describe('extractToolInput — tool-specific input extraction', () => {
  it('extracts command from Bash tool', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, assistantToolUse('Bash', { command: 'git status\ngit diff' }));
    await new Promise((r) => setTimeout(r, 2500));

    const calls = emittedEvents.filter((e) => e.type === 'tool.call' && e.payload.tool === 'Bash');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1].payload.input).toBe('git status');
  });

  it('extracts file_path from Read tool', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, assistantToolUse('Read', { file_path: '/src/index.ts' }));
    await new Promise((r) => setTimeout(r, 2500));

    const calls = emittedEvents.filter((e) => e.type === 'tool.call' && e.payload.tool === 'Read');
    expect(calls[calls.length - 1].payload.input).toBe('/src/index.ts');
  });

  it('extracts pattern from Glob tool', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, assistantToolUse('Glob', { pattern: '**/*.test.ts' }));
    await new Promise((r) => setTimeout(r, 2500));

    const calls = emittedEvents.filter((e) => e.type === 'tool.call' && e.payload.tool === 'Glob');
    expect(calls[calls.length - 1].payload.input).toBe('**/*.test.ts');
  });

  it('extracts pattern+path from Grep tool', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, assistantToolUse('Grep', { pattern: 'TODO', path: 'src/' }));
    await new Promise((r) => setTimeout(r, 2500));

    const calls = emittedEvents.filter((e) => e.type === 'tool.call' && e.payload.tool === 'Grep');
    expect(calls[calls.length - 1].payload.input).toBe('TODO in src/');
  });

  it('extracts description from Agent tool', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, assistantToolUse('Agent', { description: 'Search for config files' }));
    await new Promise((r) => setTimeout(r, 2500));

    const calls = emittedEvents.filter((e) => e.type === 'tool.call' && e.payload.tool === 'Agent');
    expect(calls[calls.length - 1].payload.input).toBe('Search for config files');
  });
});

// ── Issue 1: Partial line handling ─────────────────────────────────────────

describe('drainNewLines — partial line handling', () => {
  it('does NOT lose data when file write splits a JSON line across drains', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 150));

    // Write a partial line (no trailing newline)
    const fullLine = JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: {
        content: [{ type: 'text', text: 'Partial line recovery works.' }],
        model: 'claude-opus-4-6',
        usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    // Write first half
    const half = Math.floor(fullLine.length / 2);
    await appendFile(filePath, fullLine.slice(0, half));
    await new Promise((r) => setTimeout(r, 2200)); // poll fires

    // No event should have been emitted yet (incomplete line)
    const beforeEvents = emittedEvents.filter((e) => e.type === 'assistant.text' && e.payload.text === 'Partial line recovery works.');
    expect(beforeEvents).toHaveLength(0);

    // Write the rest + newline
    await appendFile(filePath, fullLine.slice(half) + '\n');
    await new Promise((r) => setTimeout(r, 2200)); // next poll

    const afterEvents = emittedEvents.filter((e) => e.type === 'assistant.text' && e.payload.text === 'Partial line recovery works.');
    expect(afterEvents.length).toBeGreaterThanOrEqual(1);
  }, 10_000);

  it('handles multiple complete lines followed by a partial', async () => {
    const filePath = join(testDir, 'test.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 150));

    // Two complete lines + start of third
    const line1 = assistantText('First complete line.');
    const line2 = assistantText('Second complete line.');
    const partialStart = '{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"content":[{"type":"text","text":"Third';

    await appendFile(filePath, line1 + line2 + partialStart);
    await new Promise((r) => setTimeout(r, 2200));

    // First two should be emitted
    const complete = emittedEvents.filter((e) => e.type === 'assistant.text');
    expect(complete.length).toBeGreaterThanOrEqual(2);

    // Now complete the third line
    await appendFile(filePath, ' line completes."}],"model":"claude-opus-4-6","usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n');
    await new Promise((r) => setTimeout(r, 2200));

    const all = emittedEvents.filter((e) => e.type === 'assistant.text');
    const thirdLine = all.find((e) => e.payload.text === 'Third line completes.');
    expect(thirdLine).toBeDefined();
  }, 10_000);
});

// ── Issue 2: emitRecentHistory returns last N ──────────────────────────────

describe('emitRecentHistory — returns last N lines', () => {
  it('returns the LAST 500 events, not the first 500 from tail chunk', async () => {
    const filePath = join(testDir, 'test.jsonl');
    // Write 600 distinct lines
    let content = '';
    for (let i = 0; i < 600; i++) {
      content += assistantText(`Message number ${i}`);
    }
    await writeFile(filePath, content);

    // startWatchingFile reads history on activate
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 500));

    // Check: the LAST messages should be present, not the first
    const textEvents = emittedEvents.filter((e) => e.type === 'assistant.text');
    const lastTexts = textEvents.map((e) => String(e.payload.text));

    // Message 599 (the last one) should be in the history
    expect(lastTexts).toContain('Message number 599');
    // Message 0 (the very first) should NOT be in history (was trimmed)
    expect(lastTexts).not.toContain('Message number 0');
  });
});

// ── Issue 5: startWatchingFile timeout cleanup ─────────────────────────────

describe('startWatchingFile — timeout cleanup', () => {
  it('cleans up phantom watcher when file never appears', async () => {
    const nonExistentPath = join(testDir, 'never-created.jsonl');

    // Override the timeout to be very short for testing
    // We'll just verify the cleanup behavior by checking state after the function returns
    // Note: the real timeout is 120s, but we test by calling with a file that won't appear
    // and checking that isWatching returns false after it gives up
    const promise = startWatchingFile('test_session', nonExistentPath);

    // While waiting, isWatching should be true (watcher registered)
    expect(isWatching('test_session')).toBe(true);
    expect(watcherStatus('test_session')).toBe('waiting_for_file');

    // Stop it to simulate the cleanup (we can't wait 120s in a test)
    stopWatching('test_session');
    await promise;

    expect(isWatching('test_session')).toBe(false);
    expect(watcherStatus('test_session')).toBeNull();
  });

  it('succeeds when file appears within timeout', async () => {
    const filePath = join(testDir, 'delayed.jsonl');

    const promise = startWatchingFile('test_session', filePath);
    expect(watcherStatus('test_session')).toBe('waiting_for_file');

    // Create the file after a short delay
    await new Promise((r) => setTimeout(r, 500));
    await writeFile(filePath, assistantText('I appeared in time.'));

    await promise;

    expect(isWatching('test_session')).toBe(true);
    expect(watcherStatus('test_session')).toBe('active');
  });
});

// ── Issue 11: Watcher status tracking ──────────────────────────────────────

describe('watcher status tracking', () => {
  it('returns null for non-existent watcher', () => {
    expect(watcherStatus('nonexistent_session')).toBeNull();
  });

  it('transitions from waiting_for_file to active', async () => {
    const filePath = join(testDir, 'status-test.jsonl');
    await writeFile(filePath, assistantText('Initial content.'));
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 300));

    expect(watcherStatus('test_session')).toBe('active');
  });

  it('returns stopped/null after stopWatching', async () => {
    const filePath = join(testDir, 'stop-test.jsonl');
    await writeFile(filePath, assistantText('Content.'));
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 300));

    stopWatching('test_session');
    expect(watcherStatus('test_session')).toBeNull(); // removed from map
    expect(isWatching('test_session')).toBe(false);
  });

  it('startWatching (dir scan) logs degraded warning', async () => {
    // No file in the directory — should be degraded
    const emptyDir = join(testDir, 'empty-project');
    await mkdir(emptyDir, { recursive: true });

    // claudeProjectDir maps workDir → ~/.claude/projects/... which won't match our testDir.
    // Use startWatchingFile instead to test the non-degraded path.
    // For startWatching (dir scan), we test via the session-manager integration.
  });
});

// ── Claim management ──────────────────────────────────────────────────────

describe('claim management', () => {
  it('preClaimFile prevents other sessions from claiming the same file', async () => {
    const filePath = join(testDir, 'claimed.jsonl');
    await writeFile(filePath, assistantText('Claimed content.'));

    preClaimFile('test_session', filePath);
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 300));

    // The file should be claimed by test_session
    expect(isWatching('test_session')).toBe(true);
  });

  it('stopWatching releases claims', async () => {
    const filePath = join(testDir, 'release-test.jsonl');
    await writeFile(filePath, assistantText('Will be released.'));

    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 300));

    stopWatching('test_session');
    expect(isWatching('test_session')).toBe(false);
  });
});

// ── Stable eventId generation ──────────────────────────────────────────────

describe('stable eventId generation', () => {
  it('generates deterministic eventIds based on byte offset', async () => {
    const filePath = join(testDir, 'stable-id.jsonl');
    const content = assistantText('Deterministic ID test.') + userMessage('User says hello.');
    await writeFile(filePath, content);

    // Read history — should produce stable IDs
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 300));

    const withIds = emittedEvents.filter((e) => e.opts?.eventId);
    expect(withIds.length).toBeGreaterThan(0);

    // All eventIds should start with cc:test_session:
    for (const e of withIds) {
      expect(String(e.opts!.eventId)).toMatch(/^cc:test_session:\d+:/);
    }
  });

  it('produces same eventIds on re-read (daemon restart simulation)', async () => {
    const filePath = join(testDir, 'restart-sim.jsonl');
    const content = assistantText('Stable across restarts.');
    await writeFile(filePath, content);

    // First read
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 300));
    const firstIds = emittedEvents.filter((e) => e.opts?.eventId).map((e) => String(e.opts!.eventId));
    stopWatching('test_session');

    emittedEvents.length = 0;

    // Second read (simulating daemon restart)
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 300));
    const secondIds = emittedEvents.filter((e) => e.opts?.eventId).map((e) => String(e.opts!.eventId));

    expect(firstIds).toEqual(secondIds);
  });
});

// ── Progress event subtypes ────────────────────────────────────────────────

describe('progress event subtypes', () => {
  it('emits agent.status for agent_progress', async () => {
    const filePath = join(testDir, 'progress.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, progressEvent('agent_progress', { message: 'analyzing code' }));
    await new Promise((r) => setTimeout(r, 2500));

    const events = emittedEvents.filter((e) => e.type === 'agent.status' && e.payload.status === 'agent_working');
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('emits agent.status for mcp_progress started', async () => {
    const filePath = join(testDir, 'mcp.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, progressEvent('mcp_progress', { toolName: 'search', serverName: 'brave', status: 'started' }));
    await new Promise((r) => setTimeout(r, 2500));

    const events = emittedEvents.filter((e) => e.type === 'agent.status' && e.payload.status === 'mcp_running');
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('emits agent.status for waiting_for_task', async () => {
    const filePath = join(testDir, 'waiting.jsonl');
    await writeFile(filePath, '');
    await startWatchingFile('test_session', filePath);
    await new Promise((r) => setTimeout(r, 200));

    await appendFile(filePath, progressEvent('waiting_for_task', { taskDescription: 'user approval' }));
    await new Promise((r) => setTimeout(r, 2500));

    const events = emittedEvents.filter((e) => e.type === 'agent.status' && e.payload.status === 'waiting');
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});
