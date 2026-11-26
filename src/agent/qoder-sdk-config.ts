import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { ProviderConfig, ProviderError, SessionConfig } from './transport-provider.js';
import { PROVIDER_ERROR_CODES } from './transport-provider.js';
import { PROVIDER_STATUS_REASON } from '../../shared/provider-status-reasons.js';

export const QODER_PROVIDER_ID = 'qoder-sdk' as const;
export const QODER_DEFAULT_ACCESS_TOKEN_ENV_VAR = 'QODER_PERSONAL_ACCESS_TOKEN' as const;
export const QODER_CONFIG_MAX_BYTES = 16 * 1024;
export const QODER_CONFIG_MAX_STRING_CHARS = 2048;
export const QODER_CONFIG_MAX_ARRAY_ITEMS = 32;
export const QODER_CONFIG_MAX_DEPTH = 5;
export const QODER_APPROVAL_TIMEOUT_MS = 60_000;
export const QODER_SANITIZED_TRUNCATED = '[TRUNCATED]' as const;
export const QODER_SANITIZED_REDACTED = '[REDACTED]' as const;

export const QODER_READINESS_REASON = {
  RUNTIME_MISSING: PROVIDER_STATUS_REASON.QODER_RUNTIME_MISSING,
  RUNTIME_INCOMPATIBLE: PROVIDER_STATUS_REASON.QODER_RUNTIME_INCOMPATIBLE,
  AUTH_MISSING: PROVIDER_STATUS_REASON.QODER_AUTH_MISSING,
  AUTH_FAILED: PROVIDER_STATUS_REASON.QODER_AUTH_FAILED,
  MCP_IDENTITY_MISSING: PROVIDER_STATUS_REASON.QODER_MCP_IDENTITY_MISSING,
  MCP_STATUS_UNAVAILABLE: PROVIDER_STATUS_REASON.QODER_MCP_STATUS_UNAVAILABLE,
  UNPROVEN_CAPABILITY: PROVIDER_STATUS_REASON.QODER_UNPROVEN_CAPABILITY,
  CONFIG_REJECTED: PROVIDER_STATUS_REASON.QODER_CONFIG_REJECTED,
  SUPPLY_CHAIN_PRECHECK_FAILED: PROVIDER_STATUS_REASON.QODER_SUPPLY_CHAIN_PRECHECK_FAILED,
} as const;

export type QoderAuthMode = 'pat-env' | 'qodercli';
export type QoderPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'auto' | 'bypassPermissions' | 'yolo';

export interface QoderTransportConfig {
  authMode: QoderAuthMode;
  accessTokenEnvVar: string;
  pathToQoderCLIExecutable?: string;
  pathToQoderWorkerRuntime?: string;
  useWorkerRuntime: boolean;
  model?: string;
  permissionMode: QoderPermissionMode;
  allowDangerousPermissionBypass: boolean;
  debug: boolean;
  controlRequestTimeoutMs: number;
  approvalBridgeTimeoutMs: number;
  closeGraceMs: number;
}

export type QoderTransportConfigResult = {
  ok: true;
  config: QoderTransportConfig;
  warnings: string[];
} | {
  ok: false;
  error: ProviderError;
};

const ALLOWED_KEYS = new Set([
  'authMode',
  'accessTokenEnvVar',
  'pathToQoderCLIExecutable',
  'pathToQoderWorkerRuntime',
  'useWorkerRuntime',
  'model',
  'permissionMode',
  'allowDangerousPermissionBypass',
  'debug',
  'controlRequestTimeoutMs',
  'approvalBridgeTimeoutMs',
  'closeGraceMs',
]);

const FORBIDDEN_KEYS = new Set([
  'apiKey',
  'token',
  'accessToken',
  'pat',
  'env',
  'mcpServers',
  'extraMcpServers',
  'allowedMcpServerNames',
  'skills',
  'plugins',
  'settings',
  'extensions',
  'attachments',
  'cloudAgent',
  'experimentalCloudAgent',
  'agents',
  'agent',
  'resolveModel',
  'sandbox',
  'extraArgs',
]);

const SECRET_KEY_RE = /(?:access[-_]?token|auth[-_]?token|api[-_]?key|authorization|credential|password|secret|(?:^|[_-])(?:token|pat)(?:$|[_-]))/i;
const SECRET_VALUE_TEST_RE = /\b(?:Bearer\s+[A-Za-z0-9._-]{8,}|sk-[A-Za-z0-9_-]{12,}|qdr_[A-Za-z0-9_-]{12,})\b/;
const SECRET_VALUE_REDACT_RE = /\b(?:Bearer\s+[A-Za-z0-9._-]{8,}|sk-[A-Za-z0-9_-]{12,}|qdr_[A-Za-z0-9_-]{12,})\b/g;
const ACCESS_TOKEN_ENV_VAR_RE = /^(?:QODER(?:_[A-Z0-9]+)*(?:_TOKEN|_PAT|_API_KEY)|IMCODES_QODER(?:_[A-Z0-9]+)*(?:_TOKEN|_PAT|_API_KEY))$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function error(message: string, details?: Record<string, unknown>): ProviderError {
  return {
    code: PROVIDER_ERROR_CODES.CONFIG_ERROR,
    message,
    recoverable: false,
    details: {
      reason: QODER_READINESS_REASON.CONFIG_REJECTED,
      ...(details ?? {}),
    },
  };
}

function readObjectBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return QODER_CONFIG_MAX_BYTES + 1;
  }
}

function validateShape(value: unknown, path = 'transportConfig', depth = 0): string | null {
  if (depth > QODER_CONFIG_MAX_DEPTH) return `${path} exceeds max depth ${QODER_CONFIG_MAX_DEPTH}`;
  if (typeof value === 'string' && value.length > QODER_CONFIG_MAX_STRING_CHARS) {
    return `${path} exceeds max string length`;
  }
  if (Array.isArray(value)) {
    if (value.length > QODER_CONFIG_MAX_ARRAY_ITEMS) return `${path} exceeds max array length`;
    for (let i = 0; i < value.length; i += 1) {
      const nested = validateShape(value[i], `${path}[${i}]`, depth + 1);
      if (nested) return nested;
    }
  } else if (isRecord(value)) {
    for (const [key, nestedValue] of Object.entries(value)) {
      if (!ALLOWED_KEYS.has(key) && SECRET_KEY_RE.test(key)) return `${path}.${key} is a secret-like field`;
      const nested = validateShape(nestedValue, `${path}.${key}`, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw error(`${key} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > QODER_CONFIG_MAX_STRING_CHARS) throw error(`${key} is too long`);
  if (looksLikeQoderSecret(trimmed)) throw error(`${key} appears to contain a secret value`);
  return trimmed;
}

function readBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw error(`${key} must be a boolean`);
  return value;
}

function readBoundedInteger(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = record[key];
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value)) throw error(`${key} must be an integer`);
  return Math.min(max, Math.max(min, value as number));
}

function mergeConfigObjects(providerConfig: ProviderConfig, sessionSettings: SessionConfig['settings']): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  if (isRecord(providerConfig.qoder)) Object.assign(merged, providerConfig.qoder);
  if (isRecord(providerConfig.transportConfig)) Object.assign(merged, providerConfig.transportConfig);
  if (isRecord(sessionSettings)) Object.assign(merged, sessionSettings);
  return merged;
}

export function normalizeQoderTransportConfig(
  providerConfig: ProviderConfig = {},
  sessionSettings?: SessionConfig['settings'],
): QoderTransportConfigResult {
  const raw = mergeConfigObjects(providerConfig, sessionSettings);
  if (readObjectBytes(raw) > QODER_CONFIG_MAX_BYTES) {
    return { ok: false, error: error('Qoder transport config is too large') };
  }
  const shapeError = validateShape(raw);
  if (shapeError) return { ok: false, error: error(shapeError) };

  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return { ok: false, error: error(`Qoder transport config field ${key} is not supported in v1`, { field: key }) };
    }
    if (!ALLOWED_KEYS.has(key)) {
      return { ok: false, error: error(`Unknown Qoder transport config field ${key}`, { field: key }) };
    }
  }

  try {
    const authMode = readString(raw, 'authMode') ?? 'pat-env';
    if (authMode !== 'pat-env' && authMode !== 'qodercli') throw error('authMode must be pat-env or qodercli');
    const permissionMode = readString(raw, 'permissionMode') ?? 'default';
    if (!['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions', 'yolo'].includes(permissionMode)) {
      throw error('permissionMode is not supported for Qoder');
    }
    const allowDangerousPermissionBypass = readBoolean(raw, 'allowDangerousPermissionBypass', false);
    if ((permissionMode === 'bypassPermissions' || permissionMode === 'yolo') && !allowDangerousPermissionBypass) {
      throw error('Dangerous Qoder permission bypass requires allowDangerousPermissionBypass=true');
    }
    const accessTokenEnvVar = readString(raw, 'accessTokenEnvVar') ?? QODER_DEFAULT_ACCESS_TOKEN_ENV_VAR;
    if (!ACCESS_TOKEN_ENV_VAR_RE.test(accessTokenEnvVar)) {
      throw error('accessTokenEnvVar must be a Qoder-specific token env var name');
    }
    return {
      ok: true,
      config: {
        authMode,
        accessTokenEnvVar,
        pathToQoderCLIExecutable: readString(raw, 'pathToQoderCLIExecutable'),
        pathToQoderWorkerRuntime: readString(raw, 'pathToQoderWorkerRuntime'),
        useWorkerRuntime: readBoolean(raw, 'useWorkerRuntime', false),
        model: readString(raw, 'model'),
        permissionMode: permissionMode as QoderPermissionMode,
        allowDangerousPermissionBypass,
        debug: readBoolean(raw, 'debug', false),
        controlRequestTimeoutMs: readBoundedInteger(raw, 'controlRequestTimeoutMs', 60_000, 1_000, 120_000),
        approvalBridgeTimeoutMs: readBoundedInteger(raw, 'approvalBridgeTimeoutMs', QODER_APPROVAL_TIMEOUT_MS, 1_000, 120_000),
        closeGraceMs: readBoundedInteger(raw, 'closeGraceMs', 2_000, 100, 30_000),
      },
      warnings: [],
    };
  } catch (err) {
    if (isProviderError(err)) return { ok: false, error: err };
    return { ok: false, error: error(err instanceof Error ? err.message : String(err)) };
  }
}

function isProviderError(value: unknown): value is ProviderError {
  return !!value && typeof value === 'object' && typeof (value as ProviderError).code === 'string';
}

export function looksLikeQoderSecret(value: string): boolean {
  return SECRET_VALUE_TEST_RE.test(value);
}

export function sanitizeQoderValue(
  value: unknown,
  options: {
    maxDepth?: number;
    maxArrayItems?: number;
    maxStringChars?: number;
    maxObjectKeys?: number;
  } = {},
): unknown {
  const maxDepth = options.maxDepth ?? QODER_CONFIG_MAX_DEPTH;
  const maxArrayItems = options.maxArrayItems ?? QODER_CONFIG_MAX_ARRAY_ITEMS;
  const maxStringChars = options.maxStringChars ?? QODER_CONFIG_MAX_STRING_CHARS;
  const maxObjectKeys = options.maxObjectKeys ?? QODER_CONFIG_MAX_ARRAY_ITEMS;
  const seen = new WeakSet<object>();

  const visit = (candidate: unknown, depth: number, keyHint?: string): unknown => {
    if (keyHint && SECRET_KEY_RE.test(keyHint)) return QODER_SANITIZED_REDACTED;
    if (candidate === null || candidate === undefined) return candidate;
    if (typeof candidate === 'string') {
      if (looksLikeQoderSecret(candidate)) return QODER_SANITIZED_REDACTED;
      return candidate.length <= maxStringChars ? candidate : `${candidate.slice(0, maxStringChars)}${QODER_SANITIZED_TRUNCATED}`;
    }
    if (typeof candidate === 'number' || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'bigint') return candidate.toString();
    if (typeof candidate !== 'object') return String(candidate);
    if (depth >= maxDepth) return QODER_SANITIZED_TRUNCATED;
    if (seen.has(candidate)) return '[CIRCULAR]';
    seen.add(candidate);

    if (Array.isArray(candidate)) {
      const output = candidate.slice(0, maxArrayItems).map((entry) => visit(entry, depth + 1));
      if (candidate.length > maxArrayItems) output.push(QODER_SANITIZED_TRUNCATED);
      return output;
    }

    const output: Record<string, unknown> = {};
    const entries = Object.entries(candidate as Record<string, unknown>);
    for (const [key, nested] of entries.slice(0, maxObjectKeys)) {
      output[key] = visit(nested, depth + 1, key);
    }
    if (entries.length > maxObjectKeys) output[QODER_SANITIZED_TRUNCATED] = entries.length - maxObjectKeys;
    return output;
  };

  return visit(value, 0);
}

export function previewQoderValue(value: unknown, maxLength = 512): string {
  let text: string;
  try {
    text = JSON.stringify(sanitizeQoderValue(value));
  } catch {
    text = redactQoderDiagnostic(value, maxLength);
  }
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`;
}

export function redactQoderDiagnostic(value: unknown, maxLength = 240): string {
  const text = typeof value === 'string' ? value : value instanceof Error ? value.message : String(value);
  const redacted = text
    .replace(SECRET_VALUE_REDACT_RE, QODER_SANITIZED_REDACTED)
    .replace(/(QODER_PERSONAL_ACCESS_TOKEN=)[^\s]+/g, '$1[REDACTED]');
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength - 1)}...`;
}

export async function inspectQoderSdkPackage(): Promise<{
  version?: string;
  qoderCliVersion?: string;
  license?: string;
  hasInstallScript?: boolean;
  bundledQoderCliPath?: string;
  bundledQoderCliPresent: boolean;
  runtimeManifest?: Record<string, unknown>;
}> {
  const require = createRequire(import.meta.url);
  const indexPath = require.resolve('@qoder-ai/qoder-agent-sdk');
  const packageRoot = dirname(dirname(indexPath));
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
  const runtimeManifest = await readOptionalJson(join(packageRoot, 'dist', 'runtime-manifest.json'));
  const binaryName = process.platform === 'win32' ? 'qodercli.exe' : 'qodercli';
  const bundledQoderCliPath = join(packageRoot, 'dist', '_bundled', binaryName);
  const bundledQoderCliPresent = await pathExistsExecutable(bundledQoderCliPath);
  return {
    version: typeof packageJson.version === 'string' ? packageJson.version : undefined,
    qoderCliVersion: typeof packageJson.qoderCliVersion === 'string' ? packageJson.qoderCliVersion : undefined,
    license: typeof packageJson.license === 'string' ? packageJson.license : undefined,
    hasInstallScript: isRecord(packageJson.scripts) && typeof packageJson.scripts.postinstall === 'string',
    bundledQoderCliPath,
    bundledQoderCliPresent,
    ...(runtimeManifest ? { runtimeManifest } : {}),
  };
}

async function readOptionalJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function pathExistsExecutable(path: string | undefined): Promise<boolean> {
  if (!path) return false;
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    try {
      await access(path, fsConstants.F_OK);
      return process.platform === 'win32';
    } catch {
      return false;
    }
  }
}
