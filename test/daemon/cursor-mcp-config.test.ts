import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';
import { ensureCursorMcpJsonHasImcodesEntry } from '../../src/daemon/cursor-mcp-config.js';

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('ensureCursorMcpJsonHasImcodesEntry', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'imcodes-cursor-mcp-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('merges the daemon entry, preserves user entries, backs up, and is idempotent', async () => {
    const configPath = join(dir, 'mcp.json');
    const noticeMarkerPath = join(dir, 'notice');
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        user: { command: 'node', args: ['server.js'], env: { KEEP: 'yes' } },
      },
    }), 'utf8');

    const first = await ensureCursorMcpJsonHasImcodesEntry({ configPath, noticeMarkerPath });
    const second = await ensureCursorMcpJsonHasImcodesEntry({ configPath, noticeMarkerPath });
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));

    expect(first.changed).toBe(true);
    expect(first.degraded).toBe(false);
    expect(first.backupPath).toBeTruthy();
    expect(second.changed).toBe(false);
    expect(second.degraded).toBe(false);
    expect(parsed.mcpServers.user).toEqual({ command: 'node', args: ['server.js'], env: { KEEP: 'yes' } });
    expect(parsed.mcpServers[IMCODES_MEMORY_MCP_SERVER_NAME]).toEqual({ command: 'imcodes', args: ['memory', 'mcp'] });
    expect(await readFile(first.backupPath!, 'utf8')).toContain('"user"');
    expect(await readFile(noticeMarkerPath, 'utf8')).toContain('Remove it by deleting');
  });

  it('does not overwrite a user-authored imcodes-memory entry', async () => {
    const configPath = join(dir, 'mcp.json');
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        [IMCODES_MEMORY_MCP_SERVER_NAME]: { command: 'custom', args: [] },
      },
    }), 'utf8');

    const result = await ensureCursorMcpJsonHasImcodesEntry({ configPath, noticeMarkerPath: join(dir, 'notice') });
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));

    expect(result.serverName).toBe(`${IMCODES_MEMORY_MCP_SERVER_NAME}-daemon`);
    expect(parsed.mcpServers[IMCODES_MEMORY_MCP_SERVER_NAME]).toEqual({ command: 'custom', args: [] });
    expect(parsed.mcpServers[`${IMCODES_MEMORY_MCP_SERVER_NAME}-daemon`]).toEqual({ command: 'imcodes', args: ['memory', 'mcp'] });
  });
});
