import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';
import {
  IMCODES_MEMORY_MCP_LAUNCH_ARGS,
  IMCODES_MEMORY_MCP_LAUNCH_COMMAND,
} from '../../src/agent/providers/getDefaultMcpServers.js';
import { ensureMuseMcpConfigHasImcodesEntry } from '../../src/daemon/muse-mcp-config.js';

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('ensureMuseMcpConfigHasImcodesEntry', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'imcodes-muse-mcp-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('merges the daemon entry, preserves user entries, backs up, and is idempotent', async () => {
    const configPath = join(dir, 'settings.json');
    const noticeMarkerPath = join(dir, 'notice');
    await writeFile(configPath, JSON.stringify({
      schema_version: 1,
      mcpServers: {
        user: { type: 'stdio', command: 'node', args: ['server.js'], env: { KEEP: 'yes' } },
      },
    }), 'utf8');

    const first = await ensureMuseMcpConfigHasImcodesEntry({ configPath, noticeMarkerPath });
    const second = await ensureMuseMcpConfigHasImcodesEntry({ configPath, noticeMarkerPath });
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));

    expect(first.changed).toBe(true);
    expect(first.degraded).toBe(false);
    expect(first.backupPath).toBeTruthy();
    expect(second.changed).toBe(false);
    expect(second.degraded).toBe(false);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.provider).toBeUndefined();
    expect(parsed.model).toBeUndefined();
    expect(parsed.mcpServers.user).toEqual({ type: 'stdio', command: 'node', args: ['server.js'], env: { KEEP: 'yes' } });
    expect(parsed.mcpServers[IMCODES_MEMORY_MCP_SERVER_NAME]).toEqual({
      type: 'stdio',
      command: IMCODES_MEMORY_MCP_LAUNCH_COMMAND,
      args: [...IMCODES_MEMORY_MCP_LAUNCH_ARGS],
      env: {},
      mode: 'optional',
    });
    expect(await readFile(first.backupPath!, 'utf8')).toContain('"user"');
    expect(await readFile(noticeMarkerPath, 'utf8')).toContain('Remove it by deleting');
  });

  it('sanitizes and strips poisoned wander model from existing settings.json', async () => {
    const configPath = join(dir, 'settings.json');
    const noticeMarkerPath = join(dir, 'notice');
    await writeFile(configPath, JSON.stringify({
      schema_version: 1,
      model: 'wander',
      mcpServers: {
        [IMCODES_MEMORY_MCP_SERVER_NAME]: {
          type: 'stdio',
          command: IMCODES_MEMORY_MCP_LAUNCH_COMMAND,
          args: [...IMCODES_MEMORY_MCP_LAUNCH_ARGS],
          env: {},
          mode: 'optional',
        },
      },
    }), 'utf8');

    const result = await ensureMuseMcpConfigHasImcodesEntry({ configPath, noticeMarkerPath });
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));

    expect(result.changed).toBe(true);
    expect(parsed.model).toBeUndefined();
    expect(parsed.mcpServers[IMCODES_MEMORY_MCP_SERVER_NAME]).toBeDefined();
  });

  it('migrates legacy mcp_servers snake_case to mcpServers camelCase to prevent Muse loader failure', async () => {
    const configPath = join(dir, 'settings.json');
    await writeFile(configPath, JSON.stringify({
      schema_version: 1,
      mcp_servers: {
        legacy: { type: 'stdio', command: 'legacy-bin', args: [] },
      },
    }), 'utf8');

    const result = await ensureMuseMcpConfigHasImcodesEntry({ configPath, noticeMarkerPath: join(dir, 'notice') });
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));

    expect(result.changed).toBe(true);
    expect(parsed.mcp_servers).toBeUndefined();
    expect(parsed.mcpServers.legacy).toEqual({ type: 'stdio', command: 'legacy-bin', args: [] });
    expect(parsed.mcpServers[IMCODES_MEMORY_MCP_SERVER_NAME]).toBeDefined();
  });

  it('does not overwrite a user-authored imcodes-memory entry', async () => {
    const configPath = join(dir, 'settings.json');
    await writeFile(configPath, JSON.stringify({
      schema_version: 1,
      mcpServers: {
        [IMCODES_MEMORY_MCP_SERVER_NAME]: { type: 'stdio', command: 'custom', args: [] },
      },
    }), 'utf8');

    const result = await ensureMuseMcpConfigHasImcodesEntry({ configPath, noticeMarkerPath: join(dir, 'notice') });
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));

    expect(result.serverName).toBe(`${IMCODES_MEMORY_MCP_SERVER_NAME}-daemon`);
    expect(parsed.mcpServers[IMCODES_MEMORY_MCP_SERVER_NAME]).toEqual({ type: 'stdio', command: 'custom', args: [] });
    expect(parsed.mcpServers[`${IMCODES_MEMORY_MCP_SERVER_NAME}-daemon`]).toEqual({
      type: 'stdio',
      command: IMCODES_MEMORY_MCP_LAUNCH_COMMAND,
      args: [...IMCODES_MEMORY_MCP_LAUNCH_ARGS],
      env: {},
      mode: 'optional',
    });
  });
});
