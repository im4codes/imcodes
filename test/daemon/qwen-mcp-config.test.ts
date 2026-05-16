import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';
import { MEMORY_MCP_PROVIDER_STATUS_REASON } from '../../shared/memory-ws.js';
import { IMCODES_MEMORY_MCP_ARGS, IMCODES_MEMORY_MCP_COMMAND } from '../../src/agent/providers/getDefaultMcpServers.js';
import { ensureQwenMcpHasImcodesEntry } from '../../src/daemon/qwen-mcp-config.js';

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('ensureQwenMcpHasImcodesEntry', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'imcodes-qwen-mcp-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('adds the daemon server once and never removes entries', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    let present = false;
    const execFileImpl = vi.fn(async (file: string, args: string[]) => {
      calls.push({ file, args });
      if (args.join(' ') === 'mcp list') {
        return {
          stdout: JSON.stringify({
            servers: present
              ? [{ name: IMCODES_MEMORY_MCP_SERVER_NAME, command: IMCODES_MEMORY_MCP_COMMAND, args: [...IMCODES_MEMORY_MCP_ARGS] }]
              : [{ name: 'user' }],
          }),
          stderr: '',
        };
      }
      if (args[0] === 'mcp' && args[1] === 'add') {
        present = true;
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected qwen args: ${args.join(' ')}`);
    });

    const first = await ensureQwenMcpHasImcodesEntry({ execFileImpl, noticeMarkerPath: join(dir, 'notice') });
    const second = await ensureQwenMcpHasImcodesEntry({ execFileImpl, noticeMarkerPath: join(dir, 'notice') });

    expect(first.changed).toBe(true);
    expect(first.degraded).toBe(false);
    expect(first.safeToAllow).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.degraded).toBe(false);
    expect(second.safeToAllow).toBe(true);
    expect(calls.some((call) => call.args.includes('remove'))).toBe(false);
    expect(calls.filter((call) => call.args[0] === 'mcp' && call.args[1] === 'add')).toHaveLength(1);
  });

  it('uses a daemon-specific conflict name instead of allowing a user-authored imcodes-memory entry', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const execFileImpl = vi.fn(async (file: string, args: string[]) => {
      calls.push({ file, args });
      if (args.join(' ') === 'mcp list') {
        return { stdout: JSON.stringify({ servers: [{ name: IMCODES_MEMORY_MCP_SERVER_NAME, command: 'custom', args: [] }] }), stderr: '' };
      }
      if (args[0] === 'mcp' && args[1] === 'add') return { stdout: '', stderr: '' };
      throw new Error(`unexpected qwen args: ${args.join(' ')}`);
    });

    const result = await ensureQwenMcpHasImcodesEntry({ execFileImpl, noticeMarkerPath: join(dir, 'notice') });

    expect(result).toMatchObject({
      serverName: `${IMCODES_MEMORY_MCP_SERVER_NAME}-daemon`,
      changed: true,
      degraded: false,
      safeToAllow: true,
    });
    expect(calls.some((call) => call.args.includes(IMCODES_MEMORY_MCP_SERVER_NAME) && !call.args.includes(`${IMCODES_MEMORY_MCP_SERVER_NAME}-daemon`))).toBe(false);
  });

  it('degrades without blocking when qwen mcp list fails', async () => {
    const result = await ensureQwenMcpHasImcodesEntry({
      noticeMarkerPath: join(dir, 'notice'),
      execFileImpl: vi.fn(async () => {
        throw new Error('qwen mcp list failed');
      }),
    });

    expect(result).toMatchObject({
      serverName: IMCODES_MEMORY_MCP_SERVER_NAME,
      changed: false,
      degraded: true,
      safeToAllow: false,
      reason: MEMORY_MCP_PROVIDER_STATUS_REASON.MCP_REGISTRATION_FAILED,
    });
  });

  it('parses text qwen mcp list output and preserves user-authored imcodes-memory entries', async () => {
    const execFileImpl = vi.fn(async (_file: string, args: string[]) => {
      if (args.join(' ') === 'mcp list') return { stdout: 'Name Command\nimcodes-memory custom', stderr: '' };
      if (args[0] === 'mcp' && args[1] === 'add') return { stdout: '', stderr: '' };
      throw new Error(`unexpected qwen args: ${args.join(' ')}`);
    });

    const result = await ensureQwenMcpHasImcodesEntry({
      noticeMarkerPath: join(dir, 'notice'),
      execFileImpl,
    });

    expect(result).toMatchObject({
      serverName: `${IMCODES_MEMORY_MCP_SERVER_NAME}-daemon`,
      changed: true,
      degraded: false,
      safeToAllow: true,
    });
    expect(execFileImpl).toHaveBeenCalledTimes(2);
  });

  it('parses text qwen mcp list output for the daemon entry', async () => {
    const execFileImpl = vi.fn(async (_file: string, args: string[]) => {
      if (args.join(' ') === 'mcp list') return { stdout: 'Name Command\nimcodes-memory imcodes memory mcp', stderr: '' };
      throw new Error(`unexpected qwen args: ${args.join(' ')}`);
    });

    const result = await ensureQwenMcpHasImcodesEntry({
      noticeMarkerPath: join(dir, 'notice'),
      execFileImpl,
    });

    expect(result).toMatchObject({
      serverName: IMCODES_MEMORY_MCP_SERVER_NAME,
      changed: false,
      degraded: false,
      safeToAllow: true,
    });
    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });

  it('parses connected qwen mcp list output with ANSI status markers', async () => {
    const execFileImpl = vi.fn(async (_file: string, args: string[]) => {
      if (args.join(' ') === 'mcp list') {
        return {
          stdout: 'Configured MCP servers:\n\u001b[32m✓\u001b[0m imcodes-memory: imcodes memory mcp (stdio) - Connected\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected qwen args: ${args.join(' ')}`);
    });

    const result = await ensureQwenMcpHasImcodesEntry({
      noticeMarkerPath: join(dir, 'notice'),
      execFileImpl,
    });

    expect(result).toMatchObject({
      serverName: IMCODES_MEMORY_MCP_SERVER_NAME,
      changed: false,
      degraded: false,
      safeToAllow: true,
    });
    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });
});
