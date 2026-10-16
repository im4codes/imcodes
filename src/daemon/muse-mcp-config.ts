import { resolveImcodesHome } from '../util/windows-daemon-lock.js';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import logger from '../util/logger.js';
import {
  IMCODES_MEMORY_MCP_LAUNCH_ARGS,
  IMCODES_MEMORY_MCP_LAUNCH_COMMAND,
  isImcodesMemoryMcpLaunch,
} from '../agent/providers/getDefaultMcpServers.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';
import type { ProviderConfig } from '../agent/transport-provider.js';

const DAEMON_CONFLICT_SERVER_NAME = `${IMCODES_MEMORY_MCP_SERVER_NAME}-daemon`;
function noticeMarker(): string { return join(resolveImcodesHome(), 'muse-mcp-notice-shown'); }

export interface MuseMcpEnsureOptions {
  configPath?: string;
  catalogPath?: string;
  noticeMarkerPath?: string;
  skipTestDefaultPath?: boolean;
}

export interface MuseMcpEnsureResult {
  serverName: string;
  configPath: string;
  backupPath?: string;
  changed: boolean;
  degraded: boolean;
  reason?: string;
}

export function defaultMuseSettingsPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg || join(homedir(), '.config');
  return join(base, 'muse', 'settings.json');
}

export function defaultMuseModelCatalogPath(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const base = xdg || join(homedir(), '.local', 'share');
  return join(base, 'muse', 'model-catalog', '6d657461__p746268.json');
}

export const DEFAULT_MUSE_CATALOG_PAYLOAD = {
  schema_version: 2,
  provider_id: 'meta',
  profile_id: 'tbh',
  source: 'provider_catalog',
  rows: [
    {
      model_id: 'muse-wonder-full-1.0',
      provider_id: 'meta',
      profile_id: 'tbh',
      display_label: 'muse-wonder-full-1.0',
      visibility: 'visible',
      release_date: '2026-10-12',
      display_order: 0,
      is_current: true,
      is_default: true,
      roles: ['chat', 'edit'],
      context_limit: 1007997,
      output_limit: 128000,
      description: 'Muse Wonder Full 1.0',
      reasoning_effort_variants: [
        { tier: 'high', description: null },
        { tier: 'low', description: null },
        { tier: 'max', description: null },
        { tier: 'medium', description: null },
        { tier: 'minimal', description: null },
        { tier: 'xhigh', description: null },
      ],
      supports_video: false,
      supports_image_generation: false,
    },
    {
      model_id: 'muse-wonder-1.0',
      provider_id: 'meta',
      profile_id: 'tbh',
      display_label: 'muse-wonder-1.0',
      visibility: 'visible',
      release_date: '2026-10-12',
      display_order: 1,
      is_current: true,
      is_default: false,
      roles: ['chat', 'edit'],
      context_limit: 1007997,
      output_limit: 128000,
      description: 'Muse Wonder 1.0',
      reasoning_effort_variants: [
        { tier: 'high', description: null },
        { tier: 'low', description: null },
        { tier: 'max', description: null },
        { tier: 'medium', description: null },
        { tier: 'minimal', description: null },
        { tier: 'xhigh', description: null },
      ],
      supports_video: false,
      supports_image_generation: false,
    },
    {
      model_id: 'muse-spark-1.3',
      provider_id: 'meta',
      profile_id: 'tbh',
      display_label: 'muse-spark-1.3',
      visibility: 'visible',
      release_date: '2026-09-02',
      display_order: 2,
      is_current: true,
      is_default: false,
      roles: ['chat', 'edit'],
      context_limit: 1007997,
      output_limit: 128000,
      description: 'Muse Spark 1.3',
      reasoning_effort_variants: [
        { tier: 'high', description: null },
        { tier: 'low', description: null },
        { tier: 'max', description: null },
        { tier: 'medium', description: null },
        { tier: 'minimal', description: null },
        { tier: 'xhigh', description: 'Use this for deepest analysis and complex fixes.' },
      ],
      supports_video: false,
      supports_image_generation: false,
    },
  ],
};

export async function ensureMuseModelCatalogSeeded(options: { catalogPath?: string; skipTestDefaultPath?: boolean } = {}): Promise<boolean> {
  const catalogPath = options.catalogPath ?? defaultMuseModelCatalogPath();
  if (!options.catalogPath && options.skipTestDefaultPath !== false && process.env.VITEST === 'true') {
    return false;
  }
  try {
    let needsSeeding = false;
    try {
      const raw = await readFile(catalogPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) {
        needsSeeding = true;
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT' || err instanceof SyntaxError) {
        needsSeeding = true;
      } else {
        throw err;
      }
    }

    if (needsSeeding) {
      await mkdir(dirname(catalogPath), { recursive: true });
      const tmpPath = `${catalogPath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmpPath, `${JSON.stringify(DEFAULT_MUSE_CATALOG_PAYLOAD, null, 2)}\n`, 'utf8');
      await rename(tmpPath, catalogPath);
      logger.info({ catalogPath }, 'Seeded Muse Code model catalog cache');
      return true;
    }
    return false;
  } catch (err) {
    logger.warn({ err, catalogPath }, 'Failed to seed Muse Code model catalog');
    return false;
  }
}

function daemonEntry(): Record<string, unknown> {
  return {
    type: 'stdio',
    command: IMCODES_MEMORY_MCP_LAUNCH_COMMAND,
    args: [...IMCODES_MEMORY_MCP_LAUNCH_ARGS],
    env: {},
    mode: 'optional',
  };
}

function isSameDaemonEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isImcodesMemoryMcpLaunch(record.command, record.args);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await mkdir(lockPath);
      try {
        return await fn();
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for lock ${lockPath}`);
}

async function writeNoticeOnce(markerPath: string, message: string): Promise<void> {
  if (await pathExists(markerPath)) return;
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, `${new Date().toISOString()}\n${message}\n`, 'utf8');
  logger.warn({ message }, 'Muse Code MCP auto-configuration notice');
}

export function museMcpEnsureOptionsFromConfig(config: ProviderConfig): MuseMcpEnsureOptions {
  const configPath = typeof (config as any).museSettingsPath === 'string' && (config as any).museSettingsPath.trim()
    ? (config as any).museSettingsPath.trim()
    : undefined;
  return configPath ? { configPath, skipTestDefaultPath: false } : {};
}

export async function ensureMuseMcpConfigHasImcodesEntry(options: MuseMcpEnsureOptions = {}): Promise<MuseMcpEnsureResult> {
  const configPath = options.configPath ?? defaultMuseSettingsPath();
  if (!options.configPath && options.skipTestDefaultPath !== false && process.env.VITEST === 'true') {
    return {
      serverName: IMCODES_MEMORY_MCP_SERVER_NAME,
      configPath,
      changed: false,
      degraded: true,
      reason: 'muse_mcp_autoconfig_skipped_under_test',
    };
  }
  const lockPath = `${configPath}.lock`;
  return withLock(lockPath, async () => {
    await mkdir(dirname(configPath), { recursive: true });
    let parsed: Record<string, unknown> = {};
    let raw = '';
    try {
      raw = await readFile(configPath, 'utf8');
      parsed = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }

    // Muse drops MCP entirely if mcp_servers snake_case is present alongside mcpServers camelCase.
    // Migrate any legacy snake_case entries to camelCase.
    let mcpServers: Record<string, unknown> = {};
    let hadSnakeCase = false;
    if (parsed.mcp_servers && typeof parsed.mcp_servers === 'object' && !Array.isArray(parsed.mcp_servers)) {
      hadSnakeCase = true;
      mcpServers = { ...(parsed.mcp_servers as Record<string, unknown>) };
      delete parsed.mcp_servers;
    }
    if (parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) {
      mcpServers = { ...mcpServers, ...(parsed.mcpServers as Record<string, unknown>) };
    }

    const hadPoisonedModel = parsed.model === 'wander' || parsed.model === 'wander-code';
    if (hadPoisonedModel) {
      delete parsed.model;
    }

    await ensureMuseModelCatalogSeeded({ catalogPath: options.catalogPath, skipTestDefaultPath: options.skipTestDefaultPath }).catch(() => false);

    if (!hadPoisonedModel && !hadSnakeCase && (isSameDaemonEntry(mcpServers[IMCODES_MEMORY_MCP_SERVER_NAME]) || isSameDaemonEntry(mcpServers[DAEMON_CONFLICT_SERVER_NAME]))) {
      return {
        serverName: isSameDaemonEntry(mcpServers[IMCODES_MEMORY_MCP_SERVER_NAME]) ? IMCODES_MEMORY_MCP_SERVER_NAME : DAEMON_CONFLICT_SERVER_NAME,
        configPath,
        changed: false,
        degraded: false,
      };
    }

    const serverName = mcpServers[IMCODES_MEMORY_MCP_SERVER_NAME] === undefined || isSameDaemonEntry(mcpServers[IMCODES_MEMORY_MCP_SERVER_NAME])
      ? IMCODES_MEMORY_MCP_SERVER_NAME
      : DAEMON_CONFLICT_SERVER_NAME;

    const backupPath = raw
      ? `${configPath}.imcodes-backup-${Date.now()}`
      : undefined;
    if (backupPath) {
      await writeFile(backupPath, raw, 'utf8');
    }

    const next: Record<string, unknown> = {
      schema_version: parsed.schema_version ?? 1,
      ...parsed,
      mcpServers: {
        ...mcpServers,
        [serverName]: daemonEntry(),
      },
    };

    const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmpPath, configPath);
    const message = [
      `Added Muse Code MCP entry "${serverName}" to ${configPath}.`,
      `Remove it by deleting mcpServers.${serverName} from that file.`,
      backupPath ? `Restore the previous file from ${backupPath}.` : 'No previous file existed, so no backup was needed.',
      'IM.codes supplies MCP identity through session-scoped MSP configuration for each managed session.',
    ].join(' ');
    await writeNoticeOnce(options.noticeMarkerPath ?? noticeMarker(), message);
    return {
      serverName,
      configPath,
      backupPath,
      changed: true,
      degraded: false,
    };
  });
}
