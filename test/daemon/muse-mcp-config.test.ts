import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';
import {
  IMCODES_MEMORY_MCP_LAUNCH_ARGS,
  IMCODES_MEMORY_MCP_LAUNCH_COMMAND,
} from '../../src/agent/providers/getDefaultMcpServers.js';
import {
  prepareMuseSessionMcp,
  ensureMuseModelCatalogSeeded,
} from '../../src/daemon/muse-mcp-config.js';

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('prepareMuseSessionMcp', () => {
  let dir = '';
  const legacy = () => ({ type: 'stdio', command: IMCODES_MEMORY_MCP_LAUNCH_COMMAND,
    args: [...IMCODES_MEMORY_MCP_LAUNCH_ARGS], env: {}, mode: 'optional' });
  const user = { type: 'stdio', command: 'custom', args: ['server.js'], env: { KEEP: 'yes' } };
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'imcodes-muse-mcp-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  const prepare = (configPath: string) => prepareMuseSessionMcp({ configPath, catalogPath: join(dir, 'catalog.json'), noticeMarkerPath: join(dir, 'notice') });

  it.each(['wrapped', 'direct', 'both'])('migrates legacy %s host entries, preserves user settings and backs up exactly once', async (shape) => {
    const configPath = join(dir, 'settings.json');
    const direct = { ...legacy(), command: 'imcodes', args: ['memory', 'mcp'] };
    const original = JSON.stringify({ schema_version: 1, provider: 'echo', mcpServers: { user,
      [IMCODES_MEMORY_MCP_SERVER_NAME]: shape === 'direct' ? direct : legacy(),
      ...(shape === 'both' ? { [`${IMCODES_MEMORY_MCP_SERVER_NAME}-daemon`]: legacy() } : {}),
    } });
    await writeFile(configPath, original);
    const first = await prepare(configPath);
    const second = await prepare(configPath);
    expect(first).toMatchObject({ changed: true, degraded: false, serverName: IMCODES_MEMORY_MCP_SERVER_NAME });
    expect(second).toMatchObject({ changed: false, degraded: false, serverName: IMCODES_MEMORY_MCP_SERVER_NAME });
    expect(await readFile(first.backupPath!, 'utf8')).toBe(original);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ schema_version: 1, provider: 'echo', mcpServers: { user } });
  });

  it('a fresh install does not add an anonymous host entry', async () => {
    const configPath = join(dir, 'new', 'settings.json');
    expect(await prepare(configPath)).toMatchObject({ changed: false, degraded: false, serverName: IMCODES_MEMORY_MCP_SERVER_NAME });
    await expect(readFile(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not mistake a user-configured IM.codes command for an owned anonymous entry', async () => {
    const configPath = join(dir, 'settings.json');
    const original = JSON.stringify({ mcpServers: { [IMCODES_MEMORY_MCP_SERVER_NAME]: { ...legacy(), env: { KEEP: 'yes' } } } });
    await writeFile(configPath, original);
    expect(await prepare(configPath)).toMatchObject({ changed: false, serverName: `${IMCODES_MEMORY_MCP_SERVER_NAME}-daemon` });
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  it('chooses a free session name without overwriting either user-owned name', async () => {
    const configPath = join(dir, 'settings.json');
    const original = JSON.stringify({ mcpServers: { [IMCODES_MEMORY_MCP_SERVER_NAME]: user, [`${IMCODES_MEMORY_MCP_SERVER_NAME}-daemon`]: user } });
    await writeFile(configPath, original);
    expect(await prepare(configPath)).toMatchObject({ changed: false, serverName: `${IMCODES_MEMORY_MCP_SERVER_NAME}-daemon-1` });
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  it('keeps the existing snake_case and poisoned-model repairs, with session-only registration', async () => {
    const configPath = join(dir, 'settings.json');
    await writeFile(configPath, JSON.stringify({ model: 'wander', mcp_servers: { user, [IMCODES_MEMORY_MCP_SERVER_NAME]: legacy() } }));
    expect(await prepare(configPath)).toMatchObject({ changed: true });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ schema_version: 1, mcpServers: { user } });
  });

  it('serializes concurrent migration and does not overwrite malformed settings', async () => {
    const configPath = join(dir, 'settings.json');
    await writeFile(configPath, JSON.stringify({ mcpServers: { [IMCODES_MEMORY_MCP_SERVER_NAME]: legacy() } }));
    const results = await Promise.all([prepare(configPath), prepare(configPath)]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    await writeFile(configPath, '{not json');
    await expect(prepare(configPath)).rejects.toThrow();
    expect(await readFile(configPath, 'utf8')).toBe('{not json');
  });
});

describe('ensureMuseModelCatalogSeeded', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'imcodes-muse-catalog-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('seeds default catalog when catalog file does not exist', async () => {
    const catalogPath = join(dir, '6d657461__p746268.json');
    const seeded = await ensureMuseModelCatalogSeeded({ catalogPath, skipTestDefaultPath: false });

    expect(seeded).toBe(true);
    const content = JSON.parse(await readFile(catalogPath, 'utf8'));
    expect(content.provider_id).toBe('meta');
    expect(content.rows.length).toBeGreaterThan(0);
    expect(content.rows.some((r: any) => r.model_id === 'muse-spark-1.3')).toBe(true);
  });

  it('repairs and seeds catalog when catalog file has empty rows', async () => {
    const catalogPath = join(dir, '6d657461__p746268.json');
    await writeFile(catalogPath, JSON.stringify({
      schema_version: 2,
      provider_id: 'meta',
      profile_id: 'tbh',
      source: 'provider_catalog',
      rows: [],
    }), 'utf8');

    const seeded = await ensureMuseModelCatalogSeeded({ catalogPath, skipTestDefaultPath: false });

    expect(seeded).toBe(true);
    const content = JSON.parse(await readFile(catalogPath, 'utf8'));
    expect(content.rows.length).toBeGreaterThan(0);
    expect(content.rows[0].model_id).toBe('muse-wonder-full-1.0');
  });

  it('does not overwrite when catalog already has visible models', async () => {
    const catalogPath = join(dir, '6d657461__p746268.json');
    await writeFile(catalogPath, JSON.stringify({
      schema_version: 2,
      provider_id: 'meta',
      profile_id: 'tbh',
      source: 'provider_catalog',
      rows: [{ model_id: 'custom-spark', visibility: 'visible' }],
    }), 'utf8');

    const seeded = await ensureMuseModelCatalogSeeded({ catalogPath, skipTestDefaultPath: false });

    expect(seeded).toBe(false);
    const content = JSON.parse(await readFile(catalogPath, 'utf8'));
    expect(content.rows[0].model_id).toBe('custom-spark');
  });
});
