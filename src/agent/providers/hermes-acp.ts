import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AcpClientConnection } from './acp-client-adapter.js';
import type {
  ApprovalRequest,
  ProviderActiveWorkSnapshotOptions,
  ProviderCancelOptions,
  ProviderConfig,
  ProviderDelegationNotification,
  ProviderError,
  ProviderModelList,
  ProviderStatusUpdate,
  ProviderUsageUpdate,
  RemoteSessionInfo,
  RemoteSessionListOptions,
  SessionConfig,
  SessionInfoUpdate,
  ToolCallEvent,
} from '../transport-provider.js';
import {
  normalizeProviderPayload,
  PROVIDER_ERROR_CODES,
} from '../transport-provider.js';
import {
  AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES,
  type AgentDelegationNotificationResult,
} from '../../../shared/agent-delegation.js';
import type { AgentMessage, MessageDelta } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import type { TransportEffortLevel } from '../../../shared/effort-levels.js';
import {
  HERMES_AGENT_PROVIDER_ID,
  normalizeHermesPresetBaseUrl,
  toHermesPresetRouteSnapshot,
  type HermesPresetConfig,
  type HermesPresetRouteSnapshot,
} from '../../../shared/hermes-agent.js';
import type { ProviderActiveWorkSnapshot } from '../../../shared/session-activity-types.js';
import { isSessionCompactCommandText } from '../../../shared/session-control-commands.js';
import { SESSION_MODEL_APPLIED, type SessionModelApplied } from '../../../shared/session-model-control.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import { execFileOffMain } from '../../util/exec-helper.js';
import { suppressSqliteExperimentalWarning } from '../../util/suppress-sqlite-warning.js';
import { resolveImcodesHome } from '../../util/windows-daemon-lock.js';
import logger from '../../util/logger.js';
import { composeMessageSideProviderPrompt } from '../provider-context-routing.js';
import { getTurnPayloadSystemPromptRebuilder } from '../transport-runtime-assembly.js';
import { KimiSdkProvider, type AcpCliProviderProfile } from './kimi-sdk.js';

const require = createRequire(import.meta.url);
suppressSqliteExperimentalWarning();
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const ANTHROPIC_EXTRA_PIN = 'anthropic==0.125.0';
const inFlightAnthropicInstalls = new Map<string, Promise<string | undefined>>();

const HERMES_CLI_NAME = 'hermes';
const HERMES_API_KEY_ENV = 'IMCODES_HERMES_API_KEY';
const HERMES_WRAPPED_CONNECTION = Symbol('imcodes.hermes.wrappedConnection');

const HERMES_PROFILE: AcpCliProviderProfile = {
  id: HERMES_AGENT_PROVIDER_ID,
  displayName: 'Hermes Agent',
  binary: HERMES_CLI_NAME,
  args: ['acp'],
  approval: 'bridge',
  loadFailure: 'error',
  privacySafeErrors: true,
  // Hermes 0.20.x persists session/new but does not advertise session/close.
  // Populate the catalogue from real new/load/resume responses instead of
  // manufacturing uncloseable probe conversations from the model picker.
  modelDiscovery: 'session-metadata-only',
  resourceLinkAttachments: true,
  activePromptPrefix: '/steer ',
  compact: {
    execution: 'slash-command',
    providerCommand: '/compress',
    verified: true,
    completion: 'command-result',
    cancellation: 'provider-cancel',
    reason: 'The official Hermes ACP server advertises and handles /compress locally.',
  },
};

type HermesUsagePayload = NonNullable<ProviderUsageUpdate['usage']>;

interface PresetDelegateEntry {
  key: string;
  configHash: string;
  provider: HermesAcpProvider;
  routes: Set<string>;
}

function configuredBinaryPath(config: ProviderConfig): string | undefined {
  const direct = typeof config.binaryPath === 'string' ? config.binaryPath.trim() : '';
  if (direct) return direct;
  const configured = process.env.HERMES_CLI_PATH?.trim();
  return configured || undefined;
}

/** Resolve official installer layouts even when a partial install completed
 *  before creating its PATH wrapper. */
export function resolveHermesBinaryPath(config: ProviderConfig): string {
  const configured = configuredBinaryPath(config);
  if (configured) return configured;

  const userHome = homedir();
  const executable = process.platform === 'win32' ? 'hermes.exe' : HERMES_CLI_NAME;
  const candidates = process.platform === 'win32'
    ? [
        path.join(userHome, '.hermes', 'hermes-agent', 'venv', 'Scripts', executable),
        path.join(userHome, '.hermes', 'bin', executable),
        path.join(userHome, '.local', 'bin', executable),
      ]
    : [
        path.join(userHome, '.hermes', 'bin', executable),
        path.join(userHome, '.local', 'bin', executable),
        path.join(userHome, '.hermes', 'hermes-agent', 'venv', 'bin', executable),
      ];
  return candidates.find((candidate) => existsSync(candidate)) ?? HERMES_CLI_NAME;
}

/**
 * Resolve the already-provisioned Hermes PM virtualenv binary (`~/.hermes/installs/<key>/facts.json`)
 * so preset-isolated `HERMES_HOME` profiles reuse the installed Python environment in ~1s instead
 * of triggering a 25s+ `uv` venv rebuild per preset profile.
 */
function resolveHermesPmVenvBinary(): string | undefined {
  const installsRoot = path.join(homedir(), '.hermes', 'installs');
  if (!existsSync(installsRoot)) return undefined;
  const executable = process.platform === 'win32' ? 'hermes.exe' : HERMES_CLI_NAME;
  const binSubdir = process.platform === 'win32' ? 'Scripts' : 'bin';
  try {
    for (const entry of readdirSync(installsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const factsPath = path.join(installsRoot, entry.name, 'facts.json');
      if (!existsSync(factsPath)) continue;
      const facts = JSON.parse(readFileSync(factsPath, 'utf8')) as {
        packages?: { venv?: { environment?: unknown } };
      };
      const venvEnv = typeof facts?.packages?.venv?.environment === 'string'
        ? facts.packages.venv.environment.trim()
        : '';
      if (!venvEnv) continue;
      const candidate = path.join(venvEnv, binSubdir, executable);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function venvHasAnthropicPackage(venvRoot: string): boolean {
  const winSitePackages = path.join(venvRoot, 'Lib', 'site-packages', 'anthropic');
  if (existsSync(winSitePackages)) return true;
  const libDir = path.join(venvRoot, 'lib');
  if (!existsSync(libDir)) return false;
  try {
    for (const entry of readdirSync(libDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('python')) continue;
      if (existsSync(path.join(libDir, entry.name, 'site-packages', 'anthropic'))) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function resolveHermesUvBinary(): string {
  const uvExe = process.platform === 'win32' ? 'uv.exe' : 'uv';
  const toolsRoot = path.join(homedir(), '.hermes', 'tools');
  if (existsSync(toolsRoot)) {
    try {
      for (const entry of readdirSync(toolsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('uv-')) continue;
        const candidate = path.join(toolsRoot, entry.name, uvExe);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // Fallback to PATH uv.
    }
  }
  return uvExe;
}

/**
 * Hermes installs `[all]` without the optional `anthropic` extra by default, and
 * spawning with `HERMES_HOME` pointed at an isolated preset profile would otherwise
 * fail with `ImportError` (or trigger a 25s+ per-profile venv sync). Pre-stage `anthropic`
 * once into `<imcodesHome>/hermes-pydeps/anthropic` without touching `~/.hermes`.
 */
async function ensureHermesAnthropicExtra(pmVenvBinary: string): Promise<string | undefined> {
  const binDir = path.dirname(pmVenvBinary);
  const venvRoot = path.dirname(binDir);
  if (venvHasAnthropicPackage(venvRoot)) return undefined;

  const pydepsDir = path.join(resolveImcodesHome(), 'hermes-pydeps', 'anthropic');
  if (existsSync(path.join(pydepsDir, 'anthropic'))) return pydepsDir;

  const existing = inFlightAnthropicInstalls.get(pydepsDir);
  if (existing) return existing;

  const job = (async (): Promise<string | undefined> => {
    const pythonBin = path.join(binDir, process.platform === 'win32' ? 'python.exe' : 'python');
    if (!existsSync(pythonBin)) return undefined;
    const uvBin = resolveHermesUvBinary();
    const uvCacheDir = path.join(resolveImcodesHome(), 'hermes-pydeps', 'uv-cache');
    try {
      mkdirSync(path.dirname(pydepsDir), { recursive: true });
      mkdirSync(uvCacheDir, { recursive: true });
      await execFileOffMain(
        uvBin,
        ['pip', 'install', '--python', pythonBin, '--target', pydepsDir, ANTHROPIC_EXTRA_PIN],
        {
          env: {
            ...process.env,
            UV_CACHE_DIR: uvCacheDir,
          },
          timeout: 60_000,
        },
      );
      return existsSync(path.join(pydepsDir, 'anthropic')) ? pydepsDir : undefined;
    } catch (err) {
      logger.warn({ err, pydepsDir }, 'Failed to stage Hermes anthropic extra; falling back to venv environment');
      return undefined;
    } finally {
      inFlightAnthropicInstalls.delete(pydepsDir);
    }
  })();

  inFlightAnthropicInstalls.set(pydepsDir, job);
  return job;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isOfficialOpenAiHost(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname === 'api.openai.com' || hostname.endsWith('.openai.com');
  } catch {
    return false;
  }
}

function resolveHermesPresetApiMode(preset: HermesPresetConfig, baseUrl: string): string {
  if (preset.authType === 'anthropic') return 'anthropic_messages';
  return isOfficialOpenAiHost(baseUrl) ? 'codex_responses' : 'chat_completions';
}

export function resolveHermesPresetRouteHash(preset: HermesPresetConfig): string {
  return sha256Hex(buildHermesPresetConfigYaml(preset)).slice(0, 12);
}

function formatHermesOwnerDir(ownerKey: string): string {
  const sanitized = ownerKey
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const digest = sha256Hex(ownerKey.trim()).slice(0, 12);
  return sanitized ? `${sanitized}-${digest}` : digest;
}

/**
 * Resolve the IM.codes-owned HERMES_HOME directory for a preset route.
 * When `ownerKey` is supplied, storage binds persistently to session ownership
 * (`routeId`) rather than the current model or preset revision so online model
 * switches never strand conversation history in a different directory.
 * Generic `HERMES_HOME` env vars are ignored so IM.codes never mutates user/shared configs.
 */
export function resolveHermesPresetProfileDir(preset: HermesPresetConfig, ownerKey?: string): string {
  const trimmedOwner = ownerKey?.trim();
  if (trimmedOwner) {
    return path.join(
      resolveImcodesHome(),
      'hermes-profiles',
      'routes',
      formatHermesOwnerDir(trimmedOwner),
    );
  }
  return path.join(
    resolveImcodesHome(),
    'hermes-profiles',
    preset.presetSlug,
    resolveHermesPresetRouteHash(preset),
  );
}

/**
 * Render non-secret scoped `config.yaml` for a CC Preset Hermes profile.
 * Never embeds API keys or tokens on disk — credentials pass only through child env.
 */
export function buildHermesPresetConfigYaml(preset: HermesPresetConfig): string {
  const baseUrl = normalizeHermesPresetBaseUrl(preset.authType, preset.baseUrl);
  const apiMode = resolveHermesPresetApiMode(preset, baseUrl);
  const models: string[] = [];
  for (const candidate of [preset.model, ...(preset.availableModels ?? [])]) {
    const trimmed = candidate?.trim();
    if (trimmed && !models.includes(trimmed)) models.push(trimmed);
  }
  const defaultModel = preset.model?.trim() || models[0] || '';
  const lines: string[] = [
    '# Auto-generated by IM.codes for CC Preset isolation (non-secret runtime config only).',
    'model:',
    ...(defaultModel ? [`  default: ${JSON.stringify(defaultModel)}`] : []),
    `  provider: ${JSON.stringify(`custom:${preset.presetSlug}`)}`,
    ...(preset.contextWindow ? [`  context_length: ${Math.trunc(preset.contextWindow)}`] : []),
    'providers:',
    `  ${preset.presetSlug}:`,
    `    name: ${JSON.stringify(preset.presetName)}`,
    `    base_url: ${JSON.stringify(baseUrl)}`,
    `    api_mode: ${JSON.stringify(apiMode)}`,
    `    key_env: ${JSON.stringify(HERMES_API_KEY_ENV)}`,
    '    discover_models: false',
  ];
  if (models.length > 0) {
    lines.push('    models:');
    for (const modelId of models) {
      if (preset.contextWindow) {
        lines.push(`      ${JSON.stringify(modelId)}:`);
        lines.push(`        context_length: ${Math.trunc(preset.contextWindow)}`);
      } else {
        lines.push(`      ${JSON.stringify(modelId)}: {}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

interface HermesStateDbInspection {
  valid: boolean;
  hasSession: boolean;
  sessionCount: number;
}

function inspectHermesStateDb(dbPath: string, resumeId: string): HermesStateDbInspection {
  if (!existsSync(dbPath)) return { valid: false, hasSession: false, sessionCount: 0 };
  let db: InstanceType<typeof DatabaseSync> | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5_000 });
    const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM sessions').get() as { cnt?: number } | undefined;
    const hitRow = db.prepare('SELECT 1 AS found FROM sessions WHERE id = ? LIMIT 1').get(resumeId) as { found?: number } | undefined;
    return {
      valid: true,
      hasSession: hitRow?.found === 1,
      sessionCount: typeof countRow?.cnt === 'number' ? countRow.cnt : 0,
    };
  } catch {
    return { valid: false, hasSession: false, sessionCount: 0 };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function listCandidateHermesStateDirs(profilesRoot: string, currentProfileDir: string): string[] {
  if (!existsSync(profilesRoot)) return [];
  const candidates: string[] = [];
  const pushIfHasDb = (dir: string) => {
    if (dir === currentProfileDir) return;
    if (existsSync(path.join(dir, 'state.db'))) candidates.push(dir);
  };
  try {
    for (const level1 of readdirSync(profilesRoot, { withFileTypes: true })) {
      if (!level1.isDirectory()) continue;
      const dir1 = path.join(profilesRoot, level1.name);
      pushIfHasDb(dir1);
      try {
        for (const level2 of readdirSync(dir1, { withFileTypes: true })) {
          if (!level2.isDirectory()) continue;
          pushIfHasDb(path.join(dir1, level2.name));
        }
      } catch {
        // Ignore transient directory read error.
      }
    }
  } catch {
    return [];
  }
  const routesPrefix = path.join(profilesRoot, 'routes') + path.sep;
  return candidates.sort((a, b) => {
    const aIsRoute = a.startsWith(routesPrefix);
    const bIsRoute = b.startsWith(routesPrefix);
    if (aIsRoute !== bIsRoute) return aIsRoute ? -1 : 1;
    return a.localeCompare(b);
  });
}

const ALLOWED_HERMES_SCHEMA_TABLES = new Set([
  'schema_version',
  'state_meta',
  'runtime_epoch',
  'system_prompts',
  'sessions',
  'messages',
  'session_model_usage',
  'session_admissions',
  'worker_executions',
  'worker_receipts',
  'gateway_routing',
  'gateway_hygiene_state',
  'conversation_generations',
  'gateway_heartbeats',
  'compression_locks',
  'session_turn_leases',
  'async_delegations',
  'resumable_subagents',
]);

function isMessagesFtsArtifactName(name: string): boolean {
  return name === 'messages_fts' || name.startsWith('messages_fts_');
}

function quoteSqliteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function resolveOwnedDelegations(
  snapDb: InstanceType<typeof DatabaseSync>,
  retainedIds: Set<string>,
): { ownedRows: Array<Record<string, unknown>>; cols: string[]; ownedIds: Set<string> } {
  const cols = (snapDb.prepare('PRAGMA table_info("async_delegations")').all() as Array<{ name?: string }>)
    .map((c) => c.name)
    .filter((n): n is string => typeof n === 'string');
  if (!cols.includes('delegation_id')) {
    throw new Error('async_delegations missing delegation_id');
  }
  const uniqueRetainedKeys = new Set<string>();
  const excludedKeys = new Set<string>();
  const sessionCols = (snapDb.prepare('PRAGMA table_info("sessions")').all() as Array<{ name?: string }>)
    .map((c) => c.name)
    .filter((n): n is string => typeof n === 'string');
  if (sessionCols.includes('session_key')) {
    const allSessionRows = snapDb.prepare('SELECT id, session_key FROM sessions').all() as Array<{
      id?: unknown;
      session_key?: unknown;
    }>;
    for (const r of allSessionRows) {
      if (typeof r.id !== 'string' || typeof r.session_key !== 'string') continue;
      const key = r.session_key.trim();
      if (!key) continue;
      if (retainedIds.has(r.id)) uniqueRetainedKeys.add(key);
      else excludedKeys.add(key);
    }
    for (const k of excludedKeys) uniqueRetainedKeys.delete(k);
  }

  const selectSql = `SELECT ${cols.map(quoteSqliteIdent).join(', ')} FROM async_delegations`;
  const rows = snapDb.prepare(selectSql).all() as Array<Record<string, unknown>>;
  const ownedRows: Array<Record<string, unknown>> = [];
  const ownedIds = new Set<string>();
  const idFields = ['parent_session_id', 'origin_session_id', 'origin_ui_session_id'] as const;

  for (const row of rows) {
    const delegationId = typeof row.delegation_id === 'string' ? row.delegation_id : '';
    if (!delegationId) continue;
    const populatedIds = idFields
      .map((field) => (typeof row[field] === 'string' ? row[field].trim() : ''))
      .filter(Boolean);
    let owned = false;
    if (populatedIds.length > 0) {
      owned = populatedIds.every((id) => retainedIds.has(id));
    } else {
      const originSession = typeof row.origin_session === 'string' ? row.origin_session.trim() : '';
      owned = originSession.length > 0 && uniqueRetainedKeys.has(originSession);
    }
    if (owned) {
      ownedRows.push(row);
      ownedIds.add(delegationId);
    }
  }

  return { ownedRows, cols, ownedIds };
}

function resolveOwnedSubagents(
  snapDb: InstanceType<typeof DatabaseSync>,
  retainedIds: Set<string>,
  ownedDelegationIds: Set<string>,
): { ownedRows: Array<Record<string, unknown>>; cols: string[] } {
  const cols = (snapDb.prepare('PRAGMA table_info("resumable_subagents")').all() as Array<{ name?: string }>)
    .map((c) => c.name)
    .filter((n): n is string => typeof n === 'string');
  if (!cols.includes('subagent_id') || !cols.includes('record_json')) {
    throw new Error('resumable_subagents missing required columns');
  }
  const selectSql = `SELECT ${cols.map(quoteSqliteIdent).join(', ')} FROM resumable_subagents`;
  const rows = snapDb.prepare(selectSql).all() as Array<Record<string, unknown>>;
  const ownedRows: Array<Record<string, unknown>> = [];
  const sessionRecordFields = ['parent_session_id', 'origin_session_id', 'origin_ui_session_id', 'session_id'] as const;

  for (const row of rows) {
    if (typeof row.record_json !== 'string' || !row.record_json.trim()) continue;
    let parsed: Record<string, unknown> | null = null;
    try {
      const raw = JSON.parse(row.record_json);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        parsed = raw as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }
    if (!parsed) continue;

    const recordSessionIds = sessionRecordFields
      .map((field) => (typeof parsed![field] === 'string' ? (parsed![field] as string).trim() : ''))
      .filter(Boolean);
    if (recordSessionIds.some((id) => !retainedIds.has(id))) continue;

    const unitId = typeof parsed.unit_id === 'string'
      ? parsed.unit_id.trim()
      : (typeof parsed.delegation_id === 'string' ? parsed.delegation_id.trim() : '');
    const ownedByDelegation = unitId.length > 0 && ownedDelegationIds.has(unitId);
    const ownedBySession = recordSessionIds.length > 0 && recordSessionIds.every((id) => retainedIds.has(id));
    if (!ownedByDelegation && !ownedBySession) continue;

    ownedRows.push(row);
  }

  return { ownedRows, cols };
}

function extractSingleHermesSessionDatabase(sourceDbPath: string, targetDbPath: string, resumeId: string): boolean {
  const targetDir = path.dirname(targetDbPath);
  const stagingDir = mkdtempSync(path.join(targetDir, '.seed-staging-'));
  let srcDb: InstanceType<typeof DatabaseSync> | null = null;
  let snapRo: InstanceType<typeof DatabaseSync> | null = null;
  let exportDb: InstanceType<typeof DatabaseSync> | null = null;
  try {
    if (process.platform !== 'win32') chmodSync(stagingDir, 0o700);
    const snapshotDbPath = path.join(stagingDir, 'snapshot.db');
    const stagedExportDb = path.join(stagingDir, 'export.db');

    srcDb = new DatabaseSync(sourceDbPath, { readOnly: true, timeout: 5_000 });
    srcDb.exec(`VACUUM INTO '${snapshotDbPath.replace(/'/g, "''")}'`);
    srcDb.close();
    srcDb = null;

    snapRo = new DatabaseSync(snapshotDbPath, { readOnly: true, timeout: 5_000 });
    const masterRows = snapRo.prepare(
      "SELECT name, type, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name?: unknown; type?: unknown; tbl_name?: unknown; sql?: unknown }>;

    const ALLOWED_HERMES_FTS_VIEWS = new Set([
      'messages_fts_src',
      'messages_fts_trigram_src',
    ]);
    const ALLOWED_HERMES_FTS_VIRTUAL_TABLES = new Set([
      'messages_fts',
      'messages_fts_trigram',
    ]);
    const HERMES_FTS_SHADOW_TABLES = new Set([
      'messages_fts_data',
      'messages_fts_idx',
      'messages_fts_content',
      'messages_fts_docsize',
      'messages_fts_config',
      'messages_fts_trigram_data',
      'messages_fts_trigram_idx',
      'messages_fts_trigram_content',
      'messages_fts_trigram_docsize',
      'messages_fts_trigram_config',
    ]);

    const tableSqlMap = new Map<string, string>();
    const tableColsMap = new Map<string, string[]>();
    const viewSqls: string[] = [];
    const ftsTableSqlMap = new Map<string, string>();
    const indexSqls: string[] = [];
    const triggerSqls: string[] = [];

    for (const row of masterRows) {
      const name = typeof row.name === 'string' ? row.name : '';
      const type = typeof row.type === 'string' ? row.type : '';
      const tblName = typeof row.tbl_name === 'string' ? row.tbl_name : '';
      const sql = typeof row.sql === 'string' ? row.sql : '';
      if (!name) continue;
      if (type === 'table') {
        if (ALLOWED_HERMES_FTS_VIRTUAL_TABLES.has(name)) {
          if (!sql.trim()) {
            logger.warn({ table: name, sourceDbPath }, 'Refusing legacy Hermes DB migration: missing FTS table DDL');
            return false;
          }
          ftsTableSqlMap.set(name, sql);
          continue;
        }
        if (HERMES_FTS_SHADOW_TABLES.has(name)) {
          continue;
        }
        if (!ALLOWED_HERMES_SCHEMA_TABLES.has(name)) {
          logger.warn({ table: name, sourceDbPath }, 'Refusing legacy Hermes DB migration: unsupported schema table');
          return false;
        }
        if (!sql.trim()) {
          logger.warn({ table: name, sourceDbPath }, 'Refusing legacy Hermes DB migration: missing table DDL');
          return false;
        }
        tableSqlMap.set(name, sql);
        const cols = (snapRo.prepare(`PRAGMA table_info(${quoteSqliteIdent(name)})`).all() as Array<{ name?: string }>)
          .map((c) => c.name)
          .filter((c): c is string => typeof c === 'string');
        tableColsMap.set(name, cols);
      } else if (type === 'view') {
        if (!ALLOWED_HERMES_FTS_VIEWS.has(name) || !sql.trim()) {
          logger.warn({ view: name, sourceDbPath }, 'Refusing legacy Hermes DB migration: unsupported schema view');
          return false;
        }
        viewSqls.push(sql);
      } else if (type === 'index' && sql.trim() && !isMessagesFtsArtifactName(tblName)) {
        indexSqls.push(sql);
      } else if (type === 'trigger' && sql.trim()) {
        triggerSqls.push(sql);
      }
    }

    const sessionsCols = tableColsMap.get('sessions');
    const messagesCols = tableColsMap.get('messages');
    if (!sessionsCols?.includes('id') || !messagesCols?.includes('session_id')) {
      logger.warn({ sourceDbPath }, 'Refusing legacy Hermes DB migration: missing core sessions/messages columns');
      return false;
    }
    if (tableColsMap.has('system_prompts') && !tableColsMap.get('system_prompts')?.includes('hash')) return false;
    if (tableColsMap.has('session_model_usage') && !tableColsMap.get('session_model_usage')?.includes('session_id')) return false;
    if (tableColsMap.has('session_admissions') && !tableColsMap.get('session_admissions')?.includes('target_session_id')) return false;
    if (tableColsMap.has('worker_executions') && (!tableColsMap.get('worker_executions')?.includes('execution_id') || !tableColsMap.get('worker_executions')?.includes('session_id'))) return false;
    if (tableColsMap.has('worker_receipts') && !tableColsMap.get('worker_receipts')?.includes('execution_id')) return false;

    const retainedIds = new Set<string>();
    const promptHashes = new Set<string>();
    const hasParentCol = sessionsCols.includes('parent_session_id');
    const hasPromptHashCol = sessionsCols.includes('system_prompt_hash');
    const hasToolNamesCol = sessionsCols.includes('tool_names');

    let cursor: string | undefined = resumeId;
    while (cursor && !retainedIds.has(cursor)) {
      const row = snapRo.prepare('SELECT * FROM sessions WHERE id = ? LIMIT 1').get(cursor) as Record<string, unknown> | undefined;
      if (!row) {
        if (cursor === resumeId) return false;
        break;
      }
      retainedIds.add(cursor);
      if (hasPromptHashCol && typeof row.system_prompt_hash === 'string' && row.system_prompt_hash.trim()) {
        promptHashes.add(row.system_prompt_hash);
      }
      if (hasToolNamesCol && typeof row.tool_names === 'string' && row.tool_names.trim()) {
        promptHashes.add(row.tool_names);
      }
      cursor = hasParentCol && typeof row.parent_session_id === 'string' && row.parent_session_id.trim()
        ? row.parent_session_id.trim()
        : undefined;
    }

    const retainedList = [...retainedIds];
    const promptHashList = [...promptHashes];
    const delegationData = tableColsMap.has('async_delegations')
      ? resolveOwnedDelegations(snapRo, retainedIds)
      : { ownedRows: [] as Array<Record<string, unknown>>, cols: [] as string[], ownedIds: new Set<string>() };
    const subagentData = tableColsMap.has('resumable_subagents')
      ? resolveOwnedSubagents(snapRo, retainedIds, delegationData.ownedIds)
      : { ownedRows: [] as Array<Record<string, unknown>>, cols: [] as string[] };

    snapRo.close();
    snapRo = null;

    exportDb = new DatabaseSync(stagedExportDb, { timeout: 5_000 });
    exportDb.exec('PRAGMA foreign_keys = OFF;');
    for (const ddl of tableSqlMap.values()) {
      exportDb.exec(ddl);
    }

    exportDb.exec(`ATTACH DATABASE '${snapshotDbPath.replace(/'/g, "''")}' AS src;`);
    const copyTableRows = (tableName: string, whereClause?: string, params: unknown[] = []) => {
      const cols = tableColsMap.get(tableName);
      if (!cols?.length) return;
      const colList = cols.map(quoteSqliteIdent).join(', ');
      const sql = `INSERT INTO main.${quoteSqliteIdent(tableName)} (${colList}) SELECT ${colList} FROM src.${quoteSqliteIdent(tableName)}${whereClause ? ` WHERE ${whereClause}` : ''}`;
      exportDb!.prepare(sql).run(...(params as Array<null | number | bigint | string | Uint8Array>));
    };

    const insertExplicitRows = (
      tableName: string,
      cols: string[],
      rows: Array<Record<string, unknown>>,
    ) => {
      if (!cols.length || rows.length === 0) return;
      const colList = cols.map(quoteSqliteIdent).join(', ');
      const placeholders = cols.map(() => '?').join(', ');
      const stmt = exportDb!.prepare(
        `INSERT INTO main.${quoteSqliteIdent(tableName)} (${colList}) VALUES (${placeholders})`,
      );
      for (const row of rows) {
        stmt.run(...(cols.map((c) => row[c] ?? null) as Array<null | number | bigint | string | Uint8Array>));
      }
    };

    const retainedPlaceholders = retainedList.map(() => '?').join(', ');
    if (tableColsMap.has('schema_version')) copyTableRows('schema_version');
    if (tableColsMap.has('state_meta')) copyTableRows('state_meta');
    if (tableColsMap.has('system_prompts') && promptHashList.length > 0) {
      const hashPlaceholders = promptHashList.map(() => '?').join(', ');
      copyTableRows('system_prompts', `hash IN (${hashPlaceholders})`, promptHashList);
    }
    copyTableRows('sessions', `id IN (${retainedPlaceholders})`, retainedList);
    copyTableRows('messages', `session_id IN (${retainedPlaceholders})`, retainedList);
    if (tableColsMap.has('session_model_usage')) {
      copyTableRows('session_model_usage', `session_id IN (${retainedPlaceholders})`, retainedList);
    }
    if (tableColsMap.has('session_admissions')) {
      copyTableRows('session_admissions', `target_session_id IN (${retainedPlaceholders})`, retainedList);
    }
    if (tableColsMap.has('worker_executions')) {
      copyTableRows('worker_executions', `session_id IN (${retainedPlaceholders})`, retainedList);
    }
    if (tableColsMap.has('worker_receipts') && tableColsMap.has('worker_executions')) {
      copyTableRows('worker_receipts', 'execution_id IN (SELECT execution_id FROM main.worker_executions)');
    }
    if (tableColsMap.has('async_delegations')) {
      insertExplicitRows('async_delegations', delegationData.cols, delegationData.ownedRows);
    }
    if (tableColsMap.has('resumable_subagents')) {
      insertExplicitRows('resumable_subagents', subagentData.cols, subagentData.ownedRows);
    }
    exportDb.exec('DETACH DATABASE src;');

    if (tableColsMap.has('state_meta')) {
      exportDb.exec("DELETE FROM state_meta WHERE key IN ('fts_rebuild_high_water', 'fts_rebuild_progress');");
    }
    for (const ddl of indexSqls) exportDb.exec(ddl);
    for (const ddl of viewSqls) exportDb.exec(ddl);
    for (const ddl of ftsTableSqlMap.values()) exportDb.exec(ddl);
    for (const ftsName of ftsTableSqlMap.keys()) {
      const ident = quoteSqliteIdent(ftsName);
      exportDb.exec(`INSERT INTO ${ident}(${ident}) VALUES('rebuild');`);
      exportDb.exec(`INSERT INTO ${ident}(${ident}) VALUES('integrity-check');`);
    }
    for (const ddl of triggerSqls) exportDb.exec(ddl);

    exportDb.exec('PRAGMA foreign_keys = ON;');
    const fkViolations = exportDb.prepare('PRAGMA foreign_key_check').all();
    if (fkViolations.length > 0) {
      logger.warn({ sourceDbPath, resumeId, fkViolations }, 'Refusing legacy Hermes DB migration: foreign key check failed');
      return false;
    }
    const integrityRow = exportDb.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    if (integrityRow?.integrity_check !== 'ok') {
      logger.warn({ sourceDbPath, resumeId, integrityRow }, 'Refusing legacy Hermes DB migration: integrity check failed');
      return false;
    }
    const targetHit = exportDb.prepare('SELECT 1 AS found FROM sessions WHERE id = ? LIMIT 1').get(resumeId) as { found?: number } | undefined;
    if (targetHit?.found !== 1) return false;

    exportDb.close();
    exportDb = null;

    const verifyRo = inspectHermesStateDb(stagedExportDb, resumeId);
    if (!verifyRo.valid || !verifyRo.hasSession) return false;

    if (process.platform !== 'win32') chmodSync(stagedExportDb, 0o600);
    for (const sidecar of ['-wal', '-shm']) {
      const sidecarPath = `${targetDbPath}${sidecar}`;
      if (existsSync(sidecarPath)) {
        try { unlinkSync(sidecarPath); } catch { /* ignore */ }
      }
    }
    renameSync(stagedExportDb, targetDbPath);
    return true;
  } catch (err) {
    logger.warn({ err, sourceDbPath, targetDbPath, resumeId }, 'Refusing legacy Hermes DB migration: staging failed');
    return false;
  } finally {
    try { srcDb?.close(); } catch { /* ignore */ }
    try { snapRo?.close(); } catch { /* ignore */ }
    try { exportDb?.close(); } catch { /* ignore */ }
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

function copyMatchingSessionArtifacts(sourceDir: string, profileDir: string, resumeId: string): void {
  const sourceSessionsDir = path.join(sourceDir, 'sessions');
  if (!existsSync(sourceSessionsDir)) return;
  const targetSessionsDir = path.join(profileDir, 'sessions');
  try {
    const entries = readdirSync(sourceSessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.includes(resumeId)) continue;
      mkdirSync(targetSessionsDir, { recursive: true, mode: 0o700 });
      const destFile = path.join(targetSessionsDir, entry.name);
      if (!existsSync(destFile)) {
        copyFileSync(path.join(sourceSessionsDir, entry.name), destFile);
      }
    }
  } catch {
    // Best-effort copy for auxiliary per-session files; state.db snapshot is authoritative.
  }
}

function seedPresetStateByResumeIdIfNeeded(profileDir: string, resumeId: string): void {
  const targetDb = path.join(profileDir, 'state.db');
  const targetInfo = inspectHermesStateDb(targetDb, resumeId);
  if (targetInfo.valid && targetInfo.hasSession) return;
  // Never overwrite an unrelated active database belonging to other conversations.
  if (targetInfo.valid && targetInfo.sessionCount > 0) return;

  const profilesRoot = path.join(resolveImcodesHome(), 'hermes-profiles');
  const matches = listCandidateHermesStateDirs(profilesRoot, profileDir).filter((candidateDir) => (
    inspectHermesStateDb(path.join(candidateDir, 'state.db'), resumeId).hasSession
  ));
  // Require unique authoritative ownership for one-time legacy migration; never guess among duplicates.
  if (matches.length !== 1) return;
  const sourceDir = matches[0]!;

  if (extractSingleHermesSessionDatabase(path.join(sourceDir, 'state.db'), targetDb, resumeId)) {
    copyMatchingSessionArtifacts(sourceDir, profileDir, resumeId);
  }
}

function materializeHermesPresetProfile(profileDir: string, preset: HermesPresetConfig, resumeId?: string): void {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(profileDir, 'config.yaml');
  const renderedYaml = buildHermesPresetConfigYaml(preset);
  if (!existsSync(configPath) || readFileSync(configPath, 'utf8') !== renderedYaml) {
    writeFileSync(configPath, renderedYaml, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
  if (resumeId) {
    seedPresetStateByResumeIdIfNeeded(profileDir, resumeId);
  }
}

function rewriteCompactCommand(text: string): string {
  const trimmed = text.trim();
  const rest = trimmed.slice('/compact'.length).trim();
  return rest ? `/compress ${rest}` : '/compress';
}

function stripPresetModelPrefix(model: string | undefined, presetSlug: string | undefined): string | undefined {
  if (!model || !presetSlug) return model;
  const prefix = `custom:${presetSlug}:`;
  return model.toLowerCase().startsWith(prefix.toLowerCase()) ? model.slice(prefix.length) : model;
}

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeHermesPromptUsage(rawUsage: unknown): HermesUsagePayload | undefined {
  if (!rawUsage || typeof rawUsage !== 'object') return undefined;
  const rec = rawUsage as Record<string, unknown>;
  const inputTokens = positiveFiniteNumber(rec.inputTokens) ?? positiveFiniteNumber(rec.input_tokens);
  const outputTokens = positiveFiniteNumber(rec.outputTokens) ?? positiveFiniteNumber(rec.output_tokens);
  const cachedReadTokens = positiveFiniteNumber(rec.cachedReadTokens) ?? positiveFiniteNumber(rec.cache_read_input_tokens);
  const cacheCreationTokens = positiveFiniteNumber(rec.cacheCreationTokens) ?? positiveFiniteNumber(rec.cache_creation_input_tokens);
  if (inputTokens === undefined && outputTokens === undefined && cachedReadTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(cachedReadTokens !== undefined ? { cache_read_input_tokens: cachedReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cache_creation_input_tokens: cacheCreationTokens } : {}),
  };
}

function createListenerRegistry<Args extends unknown[]>() {
  const listeners = new Set<(...args: Args) => void>();
  return {
    add(cb: (...args: Args) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    emit(...args: Args): void {
      for (const cb of [...listeners]) cb(...args);
    },
  };
}

/** Official Nous Research Hermes Agent transport over its stdio ACP server. */
export class HermesAcpProvider extends KimiSdkProvider {
  private readonly isPresetDelegate: boolean;
  private baseConfig: ProviderConfig | null = null;
  private rawConnectConfig: ProviderConfig | null = null;

  private readonly deltaListeners = createListenerRegistry<[string, MessageDelta]>();
  private readonly completeListeners = createListenerRegistry<[string, AgentMessage]>();
  private readonly errorListeners = createListenerRegistry<[string, ProviderError]>();
  private readonly toolCallListeners = createListenerRegistry<[string, ToolCallEvent]>();
  private readonly sessionInfoListeners = createListenerRegistry<[string, SessionInfoUpdate]>();
  private readonly statusListeners = createListenerRegistry<[string, ProviderStatusUpdate]>();
  private readonly usageListeners = createListenerRegistry<[string, ProviderUsageUpdate]>();
  private readonly approvalListeners = createListenerRegistry<[string, ApprovalRequest]>();

  private readonly presetDelegates = new Map<string, PresetDelegateEntry>();
  private readonly sessionDelegates = new Map<string, PresetDelegateEntry>();
  private readonly sessionContextWindows = new Map<string, number>();
  private readonly sessionPresetSlugs = new Map<string, string>();
  private readonly routeAcpIds = new Map<string, string>();
  private readonly capturedPromptUsage = new Map<string, HermesUsagePayload>();
  private readonly pendingModelSwitches = new Map<string, Promise<unknown>>();
  private readonly liveSwitchAcpCounts = new Map<string, number>();
  private readonly startupModelFailures = new Map<string, { modelId: string; error: ProviderError }>();
  private readonly routeConfirmAwaiters = new Map<string, () => Promise<string | undefined>>();
  private readonly activeTurnPayloads = new Map<string, ProviderContextPayload>();
  private readonly routePresetSnapshots = new Map<string, HermesPresetRouteSnapshot>();

  constructor(options?: { isPresetDelegate?: boolean }) {
    super(HERMES_PROFILE);
    this.isPresetDelegate = options?.isPresetDelegate === true;
    this.capabilities.activeDelegationNotification = AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE;

    let rawConnection: AcpClientConnection | null = this.connection;
    Object.defineProperty(this, 'connection', {
      configurable: true,
      enumerable: true,
      get: () => rawConnection,
      set: (next: AcpClientConnection | null) => {
        rawConnection = next ? this.wrapConnection(next) : null;
      },
    });

    super.onDelta((sessionId, delta) => {
      this.deltaListeners.emit(sessionId, delta);
    });
    super.onComplete((sessionId, message) => {
      const acpSessionId = typeof message.metadata?.resumeId === 'string'
        ? message.metadata.resumeId
        : this.routeAcpIds.get(sessionId);
      const capturedUsage = acpSessionId ? this.capturedPromptUsage.get(acpSessionId) : undefined;
      if (acpSessionId) this.capturedPromptUsage.delete(acpSessionId);

      const contextWindow = this.sessionContextWindows.get(sessionId);
      const existingUsage = message.metadata?.usage && typeof message.metadata.usage === 'object'
        ? message.metadata.usage as HermesUsagePayload
        : undefined;
      const mergedUsage: HermesUsagePayload | undefined = (capturedUsage || existingUsage || contextWindow)
        ? {
            ...(capturedUsage ?? {}),
            ...(existingUsage ?? {}),
            ...(contextWindow && !(existingUsage?.model_context_window ?? capturedUsage?.model_context_window)
              ? { model_context_window: contextWindow }
              : {}),
          }
        : undefined;

      const presetSlug = this.sessionPresetSlugs.get(sessionId);
      const normalizedModel = typeof message.metadata?.model === 'string'
        ? stripPresetModelPrefix(message.metadata.model, presetSlug)
        : undefined;

      const enrichedMessage: AgentMessage = (mergedUsage || normalizedModel !== message.metadata?.model)
        ? {
            ...message,
            metadata: {
              ...message.metadata,
              ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
              ...(mergedUsage ? { usage: mergedUsage } : {}),
            },
          }
        : message;

      if (mergedUsage) {
        this.usageListeners.emit(sessionId, {
          messageId: enrichedMessage.id,
          finalized: true,
          usage: mergedUsage,
          ...(normalizedModel ? { model: normalizedModel } : {}),
        });
      }
      this.completeListeners.emit(sessionId, enrichedMessage);
    });
    super.onError((sessionId, error) => {
      this.errorListeners.emit(sessionId, error);
    });
    super.onToolCall((sessionId, tool) => {
      this.toolCallListeners.emit(sessionId, tool);
    });
    super.onSessionInfo((sessionId, info) => {
      if (typeof info.resumeId === 'string' && info.resumeId) {
        this.routeAcpIds.set(sessionId, info.resumeId);
      }
      const presetSlug = this.sessionPresetSlugs.get(sessionId);
      const normalizedModel = stripPresetModelPrefix(info.model, presetSlug);
      const normalizedInfo = normalizedModel !== info.model ? { ...info, model: normalizedModel } : info;
      this.sessionInfoListeners.emit(sessionId, normalizedInfo);
    });
    super.onStatus((sessionId, status) => {
      this.statusListeners.emit(sessionId, status);
    });
    super.onUsage((sessionId, usage) => {
      this.usageListeners.emit(sessionId, usage);
    });
    super.onApprovalRequest((sessionId, request) => {
      this.approvalListeners.emit(sessionId, request);
    });
  }

  private findRouteIdForAcpSession(acpSessionId: string): string | undefined {
    for (const [routeId, mappedAcpId] of this.routeAcpIds.entries()) {
      if (mappedAcpId === acpSessionId) return routeId;
    }
    const sessions = (this as unknown as {
      sessions?: Map<string, { acpSessionId?: string }>;
    }).sessions;
    if (sessions) {
      for (const [routeId, state] of sessions.entries()) {
        if (state.acpSessionId === acpSessionId) return routeId;
      }
    }
    return undefined;
  }

  private getSessionModelForAcpSession(acpSessionId: string): string | undefined {
    const routeId = this.findRouteIdForAcpSession(acpSessionId);
    if (!routeId) return undefined;
    const sessions = (this as unknown as {
      sessions?: Map<string, { model?: string }>;
    }).sessions;
    return sessions?.get(routeId)?.model;
  }

  private isPresetAcpSession(acpSessionId: string): boolean {
    if (this.isPresetDelegate) return true;
    const routeId = this.findRouteIdForAcpSession(acpSessionId);
    return Boolean(routeId && this.sessionPresetSlugs.has(routeId));
  }

  private emitConfirmedModelInfo(acpSessionId: string, rawModel: string): void {
    const routeId = this.findRouteIdForAcpSession(acpSessionId);
    if (!routeId) return;
    const presetSlug = this.sessionPresetSlugs.get(routeId);
    const normalizedModel = stripPresetModelPrefix(rawModel, presetSlug);
    if (!normalizedModel) return;
    const routeSnapshot = this.routePresetSnapshots.get(routeId);
    this.sessionInfoListeners.emit(routeId, {
      model: normalizedModel,
      ...(routeSnapshot ? { hermesRouteSnapshot: { ...routeSnapshot } } : {}),
    });
  }

  /**
   * Non-secret route snapshot captured from the preset config materialized for this running route.
   * Never contains API keys or tokens.
   */
  getRoutePresetSnapshot(routeId: string): HermesPresetRouteSnapshot | undefined {
    const own = this.routePresetSnapshots.get(routeId);
    if (own) return { ...own };
    const delegateSnap = this.sessionDelegates.get(routeId)?.provider.getRoutePresetSnapshot(routeId);
    return delegateSnap ? { ...delegateSnap } : undefined;
  }

  private toModelProviderError(err: unknown): ProviderError {
    if (err && typeof err === 'object' && 'code' in err && 'message' in err && 'recoverable' in err) {
      return err as ProviderError;
    }
    return {
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      message: err instanceof Error ? err.message : String(err),
      recoverable: true,
    };
  }

  setRouteModelConfirmAwaiter(
    routeId: string,
    awaiter: (() => Promise<string | undefined>) | undefined,
  ): void {
    if (awaiter) {
      this.routeConfirmAwaiters.set(routeId, awaiter);
      this.sessionDelegates.get(routeId)?.provider.setRouteModelConfirmAwaiter(routeId, awaiter);
    } else {
      this.routeConfirmAwaiters.delete(routeId);
      this.sessionDelegates.get(routeId)?.provider.setRouteModelConfirmAwaiter(routeId, undefined);
    }
  }

  private wrapConnection(connection: AcpClientConnection): AcpClientConnection {
    if ((connection as unknown as Record<symbol, unknown>)[HERMES_WRAPPED_CONNECTION]) {
      return connection;
    }
    return new Proxy(connection, {
      get: (target, prop) => {
        if (prop === HERMES_WRAPPED_CONNECTION) return true;
        const value = Reflect.get(target, prop, target);
        if ((prop === 'newSession' || prop === 'loadSession' || prop === 'resumeSession') && typeof value === 'function') {
          return (params: Record<string, unknown>) => {
            const rawPromise = Promise.resolve(
              (value as (p: Record<string, unknown>) => Promise<Record<string, unknown>>).call(target, params),
            );
            return rawPromise.then((result) => {
              const acpSid = (typeof result?.sessionId === 'string' && result.sessionId)
                ? result.sessionId
                : (typeof params?.sessionId === 'string' ? params.sessionId : undefined);
              if (acpSid) {
                this.startupModelFailures.delete(acpSid);
                if (typeof target.unstable_setSessionModel !== 'function' && this.isPresetAcpSession(acpSid)) {
                  const modelsObj = result?.models as { currentModelId?: unknown } | null | undefined;
                  if (typeof modelsObj?.currentModelId === 'string' && modelsObj.currentModelId) {
                    this.emitConfirmedModelInfo(acpSid, modelsObj.currentModelId);
                  }
                }
              }
              return result;
            });
          };
        }
        if (prop === 'prompt' && typeof value === 'function') {
          return async (params: Parameters<AcpClientConnection['prompt']>[0]) => {
            const acpSid = params?.sessionId;
            let effectiveParams = params;
            if (acpSid && this.isPresetAcpSession(acpSid)) {
              const inFlight = this.pendingModelSwitches.get(acpSid);
              if (inFlight) {
                await inFlight.catch(() => {});
              }
              const failure = this.startupModelFailures.get(acpSid);
              const targetModel = this.getSessionModelForAcpSession(acpSid);
              if (failure && (!targetModel || targetModel === failure.modelId)) {
                throw failure.error;
              }
              const routeId = this.findRouteIdForAcpSession(acpSid);
              const awaiter = routeId ? this.routeConfirmAwaiters.get(routeId) : undefined;
              const turnPayload = routeId ? this.activeTurnPayloads.get(routeId) : undefined;
              if (awaiter) {
                const committedSystemPrompt = await awaiter();
                const rebuilder = turnPayload ? getTurnPayloadSystemPromptRebuilder(turnPayload) : undefined;
                const isSlashControl = turnPayload?.userMessage?.trim().startsWith('/') === true;
                if (
                  rebuilder
                  && !isSlashControl
                  && committedSystemPrompt !== rebuilder.initialSystemPrompt
                  && Array.isArray(params?.prompt)
                  && params.prompt[0]?.type === 'text'
                ) {
                  const rebuiltPayload = rebuilder.rebuild(committedSystemPrompt);
                  const rebuiltText = composeMessageSideProviderPrompt(rebuiltPayload, {
                    includeSessionSystemText: true,
                  });
                  effectiveParams = {
                    ...params,
                    prompt: [{ type: 'text', text: rebuiltText }, ...params.prompt.slice(1)],
                  };
                }
              }
            }
            const result = await Promise.resolve((value as AcpClientConnection['prompt']).call(target, effectiveParams));
            this.capturePromptResponseUsage(acpSid, result);
            return result;
          };
        }
        if (prop === 'unstable_setSessionModel' && typeof value === 'function') {
          return (params: Parameters<NonNullable<AcpClientConnection['unstable_setSessionModel']>>[0]) => {
            const rawPromise = Promise.resolve(
              (value as NonNullable<AcpClientConnection['unstable_setSessionModel']>).call(target, params),
            );
            const acpSid = params?.sessionId;
            const modelId = params?.modelId;
            if (!acpSid) return rawPromise;
            const isPreset = this.isPresetAcpSession(acpSid);
            if (!isPreset) {
              // Default Hermes uses best-effort setSessionAgentId: never block or fail sends.
              return rawPromise;
            }
            const isExplicitLiveSwitch = (this.liveSwitchAcpCounts.get(acpSid) ?? 0) > 0;
            const tracked = rawPromise.then(
              async () => {
                this.startupModelFailures.delete(acpSid);
                if (!isExplicitLiveSwitch && typeof modelId === 'string' && modelId) {
                  this.emitConfirmedModelInfo(acpSid, modelId);
                  const routeId = this.findRouteIdForAcpSession(acpSid);
                  const awaiter = routeId ? this.routeConfirmAwaiters.get(routeId) : undefined;
                  if (awaiter) await awaiter();
                }
              },
              (err: unknown) => {
                if (!isExplicitLiveSwitch && typeof modelId === 'string' && modelId) {
                  this.startupModelFailures.set(acpSid, {
                    modelId,
                    error: this.toModelProviderError(err),
                  });
                }
                throw err;
              },
            ).finally(() => {
              if (this.pendingModelSwitches.get(acpSid) === tracked) {
                this.pendingModelSwitches.delete(acpSid);
              }
            });
            this.pendingModelSwitches.set(acpSid, tracked);
            return tracked;
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  private capturePromptResponseUsage(acpSessionId: string | undefined, result: unknown): void {
    if (!acpSessionId || !result || typeof result !== 'object') return;
    const usage = normalizeHermesPromptUsage((result as { usage?: unknown }).usage);
    if (usage) {
      this.capturedPromptUsage.set(acpSessionId, usage);
    }
  }

  private wirePresetDelegate(delegate: HermesAcpProvider): void {
    delegate.onDelta((sessionId, delta) => this.deltaListeners.emit(sessionId, delta));
    delegate.onComplete((sessionId, message) => this.completeListeners.emit(sessionId, message));
    delegate.onError((sessionId, error) => this.errorListeners.emit(sessionId, error));
    delegate.onToolCall((sessionId, tool) => this.toolCallListeners.emit(sessionId, tool));
    delegate.onSessionInfo((sessionId, info) => this.sessionInfoListeners.emit(sessionId, info));
    delegate.onStatus((sessionId, status) => this.statusListeners.emit(sessionId, status));
    delegate.onUsage((sessionId, usage) => this.usageListeners.emit(sessionId, usage));
    delegate.onApprovalRequest((sessionId, request) => this.approvalListeners.emit(sessionId, request));
  }

  private async acquirePresetDelegate(
    routeId: string,
    profileDir: string,
    preset: HermesPresetConfig,
    sessionEnv: Record<string, string> | undefined,
  ): Promise<{ entry: PresetDelegateEntry; childEnv: Record<string, string> }> {
    const baseEnv = (this.baseConfig?.env as Record<string, string> | undefined) ?? {};
    const explicitBinary = configuredBinaryPath(this.rawConnectConfig ?? {});
    const pmVenvBinary = explicitBinary ? undefined : resolveHermesPmVenvBinary();
    const binaryPath = explicitBinary ?? pmVenvBinary ?? resolveHermesBinaryPath(this.baseConfig ?? {});
    const anthropicPydeps = (preset.authType === 'anthropic' && pmVenvBinary)
      ? await ensureHermesAnthropicExtra(pmVenvBinary)
      : undefined;
    const existingPythonPath = sessionEnv?.PYTHONPATH ?? baseEnv.PYTHONPATH;
    const pythonPath = anthropicPydeps
      ? (existingPythonPath ? `${anthropicPydeps}${path.delimiter}${existingPythonPath}` : anthropicPydeps)
      : undefined;

    // Never pass a caller's generic HERMES_HOME into a preset child — bind it strictly to
    // the IM.codes-owned profileDir for this preset routing revision.
    const childEnv: Record<string, string> = {
      ...baseEnv,
      ...(sessionEnv ?? {}),
      HERMES_HOME: profileDir,
      ...(pmVenvBinary ? { HERMES_DISABLE_LAZY_INSTALLS: '1' } : {}),
      ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
      ...(preset.apiKey ? { [HERMES_API_KEY_ENV]: preset.apiKey } : {}),
    };

    const sessionEnvDigest = sha256Hex(
      JSON.stringify(Object.entries(childEnv).sort(([a], [b]) => a.localeCompare(b))),
    );
    const configHash = resolveHermesPresetRouteHash(preset);
    const delegateKey = sha256Hex(JSON.stringify({
      routeId,
      binaryPath,
      profileDir,
      configHash,
      pythonPath: pythonPath ?? '',
      sessionEnvDigest,
    }));

    let entry = this.presetDelegates.get(delegateKey);
    if (!entry) {
      const delegate = new HermesAcpProvider({ isPresetDelegate: true });
      this.wirePresetDelegate(delegate);
      entry = { key: delegateKey, configHash, provider: delegate, routes: new Set() };
      this.presetDelegates.set(delegateKey, entry);
      try {
        await delegate.connect({
          ...(this.baseConfig ?? {}),
          binaryPath,
          env: childEnv,
        });
      } catch (err) {
        this.presetDelegates.delete(delegateKey);
        await delegate.disconnect().catch(() => {});
        throw err;
      }
    }
    return { entry, childEnv };
  }

  private async releaseRouteDelegate(routeId: string): Promise<void> {
    const entry = this.sessionDelegates.get(routeId);
    if (!entry) return;
    this.sessionDelegates.delete(routeId);
    entry.routes.delete(routeId);
    if (entry.routes.size === 0 && this.presetDelegates.get(entry.key) === entry) {
      this.presetDelegates.delete(entry.key);
      await entry.provider.disconnect().catch(() => {});
    }
  }

  override async connect(config: ProviderConfig): Promise<void> {
    this.rawConnectConfig = config;
    const resolvedConfig: ProviderConfig = {
      ...config,
      binaryPath: resolveHermesBinaryPath(config),
    };
    this.baseConfig = resolvedConfig;
    await super.connect(resolvedConfig);
  }

  override async disconnect(): Promise<void> {
    const delegates = [...this.presetDelegates.values()];
    this.presetDelegates.clear();
    this.sessionDelegates.clear();
    this.sessionContextWindows.clear();
    this.sessionPresetSlugs.clear();
    this.routeAcpIds.clear();
    this.capturedPromptUsage.clear();
    this.pendingModelSwitches.clear();
    this.liveSwitchAcpCounts.clear();
    this.startupModelFailures.clear();
    this.routeConfirmAwaiters.clear();
    this.activeTurnPayloads.clear();
    this.routePresetSnapshots.clear();
    await Promise.all([
      super.disconnect(),
      ...delegates.map((entry) => entry.provider.disconnect().catch(() => {})),
    ]);
  }

  override async createSession(config: SessionConfig): Promise<string> {
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const priorDelegate = this.sessionDelegates.get(routeId);

    if (!this.isPresetDelegate && config.hermesPreset) {
      const preset = config.hermesPreset;
      const profileOwnerKey = preset.profileOwnerKey?.trim() || routeId;
      const profileDir = resolveHermesPresetProfileDir(preset, profileOwnerKey);
      const configHash = resolveHermesPresetRouteHash(preset);
      if (priorDelegate && priorDelegate.configHash !== configHash) {
        await this.releaseRouteDelegate(routeId);
      }
      materializeHermesPresetProfile(profileDir, preset, config.resumeId);
      const { entry, childEnv } = await this.acquirePresetDelegate(routeId, profileDir, preset, config.env);
      const latestPrior = this.sessionDelegates.get(routeId);
      if (latestPrior && latestPrior !== entry) {
        await this.releaseRouteDelegate(routeId);
      }
      entry.routes.add(routeId);
      this.sessionDelegates.set(routeId, entry);
      const routeSnapshot = toHermesPresetRouteSnapshot(preset);
      this.routePresetSnapshots.set(routeId, routeSnapshot);
      entry.provider.routePresetSnapshots.set(routeId, routeSnapshot);
      const registeredAwaiter = this.routeConfirmAwaiters.get(routeId);
      if (registeredAwaiter) {
        entry.provider.setRouteModelConfirmAwaiter(routeId, registeredAwaiter);
      }
      if (preset.contextWindow) {
        this.sessionContextWindows.set(routeId, preset.contextWindow);
        entry.provider.sessionContextWindows.set(routeId, preset.contextWindow);
      }
      this.sessionPresetSlugs.set(routeId, preset.presetSlug);
      entry.provider.sessionPresetSlugs.set(routeId, preset.presetSlug);
      const resolvedAgentId = config.agentId?.trim() || preset.model?.trim() || undefined;
      return await entry.provider.createSession({
        ...config,
        ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
        env: childEnv,
      });
    }

    if (priorDelegate) {
      await this.releaseRouteDelegate(routeId);
    }
    this.routePresetSnapshots.delete(routeId);
    if (config.hermesPreset?.contextWindow) {
      this.sessionContextWindows.set(routeId, config.hermesPreset.contextWindow);
    }
    if (config.hermesPreset?.presetSlug) {
      this.sessionPresetSlugs.set(routeId, config.hermesPreset.presetSlug);
    }
    return await super.createSession(config);
  }

  override async endSession(sessionId: string): Promise<void> {
    const entry = this.sessionDelegates.get(sessionId);
    this.sessionContextWindows.delete(sessionId);
    this.sessionPresetSlugs.delete(sessionId);
    this.routeAcpIds.delete(sessionId);
    this.routeConfirmAwaiters.delete(sessionId);
    this.activeTurnPayloads.delete(sessionId);
    this.routePresetSnapshots.delete(sessionId);
    if (entry) {
      await entry.provider.endSession(sessionId);
      await this.releaseRouteDelegate(sessionId);
      return;
    }
    await super.endSession(sessionId);
  }

  override async detachSession(sessionId: string): Promise<void> {
    const entry = this.sessionDelegates.get(sessionId);
    this.sessionContextWindows.delete(sessionId);
    this.sessionPresetSlugs.delete(sessionId);
    this.routeAcpIds.delete(sessionId);
    this.routeConfirmAwaiters.delete(sessionId);
    this.activeTurnPayloads.delete(sessionId);
    this.routePresetSnapshots.delete(sessionId);
    if (entry) {
      await entry.provider.detachSession(sessionId);
      await this.releaseRouteDelegate(sessionId);
      return;
    }
    await super.detachSession(sessionId);
  }

  override async restoreSession(sessionId: string): Promise<boolean> {
    const entry = this.sessionDelegates.get(sessionId);
    if (entry) return await entry.provider.restoreSession(sessionId);
    return await super.restoreSession(sessionId);
  }

  override async send(
    sessionId: string,
    payloadOrMessage: string | ProviderContextPayload,
    attachments?: TransportAttachment[],
    extraSystemPrompt?: string,
  ): Promise<void> {
    const entry = this.sessionDelegates.get(sessionId);
    if (entry) {
      await entry.provider.send(sessionId, payloadOrMessage, attachments, extraSystemPrompt);
      return;
    }

    const isPresetRoute = this.isPresetDelegate || this.sessionPresetSlugs.has(sessionId);
    if (isPresetRoute) {
      const acpSessionId = this.findAcpSessionForRoute(sessionId);
      const pendingModelSwitch = acpSessionId ? this.pendingModelSwitches.get(acpSessionId) : undefined;
      if (pendingModelSwitch) {
        // Confirmation rejections belong to the switch caller; once settled, proceed on the confirmed model.
        await pendingModelSwitch.catch(() => {});
      }
    }

    const normalized = normalizeProviderPayload(payloadOrMessage, attachments, extraSystemPrompt);
    if (isPresetRoute && typeof payloadOrMessage === 'object' && payloadOrMessage !== null) {
      this.activeTurnPayloads.set(sessionId, payloadOrMessage);
    }
    try {
      if (isSessionCompactCommandText(normalized.userMessage)) {
        await super.send(sessionId, {
          ...normalized,
          assembledMessage: rewriteCompactCommand(normalized.userMessage),
        });
      } else {
        await super.send(sessionId, payloadOrMessage, attachments, extraSystemPrompt);
      }

      if (isPresetRoute) {
        const acpSessionId = this.findAcpSessionForRoute(sessionId);
        const failure = acpSessionId ? this.startupModelFailures.get(acpSessionId) : undefined;
        const targetModel = acpSessionId ? this.getSessionModelForAcpSession(acpSessionId) : undefined;
        if (failure && (!targetModel || targetModel === failure.modelId)) {
          throw failure.error;
        }
      }
    } finally {
      this.activeTurnPayloads.delete(sessionId);
    }
  }

  override async cancel(sessionId: string, options?: ProviderCancelOptions): Promise<void> {
    const entry = this.sessionDelegates.get(sessionId);
    if (entry) {
      await entry.provider.cancel(sessionId, options);
      return;
    }
    await super.cancel(sessionId, options);
  }

  override async cancelAndWait(sessionId: string): Promise<void> {
    const entry = this.sessionDelegates.get(sessionId);
    if (entry) {
      await entry.provider.cancelAndWait(sessionId);
      return;
    }
    await super.cancelAndWait(sessionId);
  }

  override setSessionAgentId(sessionId: string, agentId: string): void {
    const entry = this.sessionDelegates.get(sessionId);
    if (entry) {
      entry.provider.setSessionAgentId(sessionId, agentId);
      return;
    }
    super.setSessionAgentId(sessionId, agentId);
  }

  async applySessionModel(sessionId: string, agentId: string): Promise<SessionModelApplied> {
    const entry = this.sessionDelegates.get(sessionId);
    if (entry) {
      return await entry.provider.applySessionModel(sessionId, agentId);
    }
    const sessions = (this as unknown as {
      sessions: Map<string, {
        acpSessionId?: string;
        loaded?: boolean;
        cancelled?: boolean;
        model?: string;
        modelIsDefault?: boolean;
      }>;
    }).sessions;
    const state = sessions.get(sessionId);
    if (!state) {
      const error: ProviderError = {
        code: PROVIDER_ERROR_CODES.SESSION_NOT_FOUND,
        message: 'ACP model session not found',
        recoverable: false,
      };
      throw error;
    }
    const isPresetRoute = this.isPresetDelegate || this.sessionPresetSlugs.has(sessionId);
    if (!isPresetRoute) {
      super.setSessionAgentId(sessionId, agentId);
      return SESSION_MODEL_APPLIED.NEXT_START;
    }
    const connection = (this as unknown as { connection?: AcpClientConnection | null }).connection ?? null;
    if (!state.loaded || !state.acpSessionId || !connection || state.cancelled) {
      state.model = agentId;
      state.modelIsDefault = false;
      return SESSION_MODEL_APPLIED.NEXT_START;
    }
    const setter = connection.unstable_setSessionModel;
    if (typeof setter !== 'function') {
      state.model = agentId;
      state.modelIsDefault = false;
      return SESSION_MODEL_APPLIED.NEXT_START;
    }
    const acpSid = state.acpSessionId;
    this.liveSwitchAcpCounts.set(acpSid, (this.liveSwitchAcpCounts.get(acpSid) ?? 0) + 1);
    try {
      await setter.call(connection, {
        sessionId: acpSid,
        modelId: agentId,
      });
    } finally {
      const nextCount = (this.liveSwitchAcpCounts.get(acpSid) ?? 1) - 1;
      if (nextCount > 0) this.liveSwitchAcpCounts.set(acpSid, nextCount);
      else this.liveSwitchAcpCounts.delete(acpSid);
    }
    if (sessions.get(sessionId) !== state || state.cancelled) {
      const error: ProviderError = {
        code: PROVIDER_ERROR_CODES.CANCELLED,
        message: 'ACP session owner changed or stopped',
        recoverable: true,
      };
      throw error;
    }
    this.startupModelFailures.delete(acpSid);
    state.model = agentId;
    state.modelIsDefault = false;
    return SESSION_MODEL_APPLIED.LIVE;
  }

  private findAcpSessionForRoute(sessionId: string): string | undefined {
    const mapped = this.routeAcpIds.get(sessionId);
    if (mapped) return mapped;
    const sessions = (this as unknown as {
      sessions?: Map<string, { acpSessionId?: string }>;
    }).sessions;
    return sessions?.get(sessionId)?.acpSessionId;
  }

  override setSessionEffort(sessionId: string, effort: TransportEffortLevel): void {
    const entry = this.sessionDelegates.get(sessionId);
    if (entry) {
      entry.provider.setSessionEffort(sessionId, effort);
      return;
    }
    super.setSessionEffort(sessionId, effort);
  }

  override refreshSessionSystemText(sessionId: string): void {
    const entry = this.sessionDelegates.get(sessionId);
    if (entry) {
      entry.provider.refreshSessionSystemText(sessionId);
      return;
    }
    super.refreshSessionSystemText(sessionId);
  }

  override async respondApproval(sessionId: string, requestId: string, approved: boolean): Promise<void> {
    const entry = this.sessionDelegates.get(sessionId);
    if (entry) {
      await entry.provider.respondApproval(sessionId, requestId, approved);
      return;
    }
    await super.respondApproval(sessionId, requestId, approved);
  }

  override getSessionDiagnostics(sessionId: string): Record<string, unknown> | null {
    const entry = this.sessionDelegates.get(sessionId);
    if (entry) return entry.provider.getSessionDiagnostics(sessionId);
    return super.getSessionDiagnostics(sessionId);
  }

  override getActiveWorkSnapshot(
    sessionId: string,
    options?: ProviderActiveWorkSnapshotOptions,
  ): ProviderActiveWorkSnapshot | null {
    const entry = this.sessionDelegates.get(sessionId);
    if (entry) return entry.provider.getActiveWorkSnapshot(sessionId, options);
    return super.getActiveWorkSnapshot(sessionId, options);
  }

  override async checkSessionCompaction(sessionId: string): Promise<boolean> {
    const entry = this.sessionDelegates.get(sessionId);
    if (entry) return await entry.provider.checkSessionCompaction(sessionId);
    return await super.checkSessionCompaction(sessionId);
  }

  override async listSessions(options: RemoteSessionListOptions = {}): Promise<RemoteSessionInfo[]> {
    const baseSessions = await super.listSessions(options);
    const delegateResults = await Promise.all(
      [...this.presetDelegates.values()].map((entry) =>
        entry.provider.listSessions(options).catch(() => [] as RemoteSessionInfo[]),
      ),
    );
    const merged = new Map<string, RemoteSessionInfo>();
    for (const item of baseSessions) merged.set(item.key, item);
    for (const list of delegateResults) {
      for (const item of list) merged.set(item.key, item);
    }
    return [...merged.values()];
  }

  override onDelta(cb: (sessionId: string, delta: MessageDelta) => void): () => void {
    return this.deltaListeners.add(cb);
  }

  override onComplete(cb: (sessionId: string, message: AgentMessage) => void): () => void {
    return this.completeListeners.add(cb);
  }

  override onError(cb: (sessionId: string, error: ProviderError) => void): () => void {
    return this.errorListeners.add(cb);
  }

  override onToolCall(cb: (sessionId: string, tool: ToolCallEvent) => void): void {
    this.toolCallListeners.add(cb);
  }

  override onSessionInfo(cb: (sessionId: string, info: SessionInfoUpdate) => void): () => void {
    return this.sessionInfoListeners.add(cb);
  }

  override onStatus(cb: (sessionId: string, status: ProviderStatusUpdate) => void): () => void {
    return this.statusListeners.add(cb);
  }

  override onUsage(cb: (sessionId: string, usage: ProviderUsageUpdate) => void): () => void {
    return this.usageListeners.add(cb);
  }

  override onApprovalRequest(cb: (sessionId: string, request: ApprovalRequest) => void): void {
    this.approvalListeners.add(cb);
  }

  notifyActiveDelegation(
    sessionId: string,
    notification: ProviderDelegationNotification,
  ): Promise<AgentDelegationNotificationResult> {
    const entry = this.sessionDelegates.get(sessionId);
    if (entry) return entry.provider.notifyActiveDelegation(sessionId, notification);
    return this.queueActiveAcpPrompt(sessionId, notification);
  }

  override async listModels(force?: boolean): Promise<ProviderModelList> {
    const result = await super.listModels(force);
    if (result.models.length > 0) return result;
    return {
      ...result,
      isAuthenticated: false,
      error: 'No Hermes model is configured. Run `hermes model` and complete an official OAuth or provider setup, then refresh.',
    };
  }

  protected override async validateConnectedAgent(
    initializeResult: Record<string, unknown>,
    _config: ProviderConfig,
  ): Promise<void> {
    if (initializeResult.protocolVersion !== 1) {
      throw {
        code: PROVIDER_ERROR_CODES.CONFIG_ERROR,
        message: 'The installed Hermes Agent does not support the required ACP protocol version.',
        recoverable: false,
      };
    }
    const agentInfo = asRecord(initializeResult.agentInfo);
    if (agentInfo.name !== 'hermes-agent') {
      throw {
        code: PROVIDER_ERROR_CODES.CONFIG_ERROR,
        message: 'The configured executable is not the official Hermes Agent ACP server.',
        recoverable: false,
      };
    }
    const capabilities = asRecord(initializeResult.agentCapabilities);
    const sessionCapabilities = asRecord(capabilities.sessionCapabilities);
    if (capabilities.loadSession !== true
      || !isCapabilityObject(sessionCapabilities.list)
      || !isCapabilityObject(sessionCapabilities.resume)) {
      throw {
        code: PROVIDER_ERROR_CODES.CONFIG_ERROR,
        message: 'The installed Hermes Agent lacks required ACP session restore capabilities. Upgrade Hermes Agent and retry.',
        recoverable: false,
      };
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isCapabilityObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
