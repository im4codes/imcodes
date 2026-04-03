import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import logger from '../util/logger.js';
import { QWEN_AUTH_TYPES, type QwenAuthType } from '../../shared/qwen-auth.js';
import {
  QWEN_CODING_PLAN_MODEL_IDS,
  QWEN_OAUTH_MODEL_IDS,
} from '../../shared/qwen-models.js';

const execFileAsync = promisify(execFile);
const QWEN_SETTINGS_PATH = join(homedir(), '.qwen', 'settings.json');
const CACHE_TTL_MS = 30_000;

interface QwenRuntimeConfig {
  authType: QwenAuthType;
  availableModels: string[];
}

let cached: { expiresAt: number; value: QwenRuntimeConfig } | null = null;

interface QwenSettings {
  security?: {
    auth?: {
      selectedType?: string;
    };
  };
  modelProviders?: Record<string, Array<{ id?: string; envKey?: string; baseUrl?: string }>>;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isCodingPlanModelProvider(entry: { envKey?: string; baseUrl?: string } | undefined): boolean {
  if (!entry) return false;
  if (entry.envKey === 'BAILIAN_CODING_PLAN_API_KEY') return true;
  return typeof entry.baseUrl === 'string' && /coding(?:-intl)?\.dashscope\.aliyuncs\.com\/v1/.test(entry.baseUrl);
}

async function readSettings(): Promise<QwenSettings | null> {
  try {
    const raw = await readFile(QWEN_SETTINGS_PATH, 'utf8');
    return JSON.parse(raw) as QwenSettings;
  } catch {
    return null;
  }
}

async function detectAuthTypeFromStatus(): Promise<QwenAuthType | null> {
  try {
    const { stdout } = await execFileAsync('qwen', ['auth', 'status']);
    if (/Qwen OAuth/i.test(stdout)) return QWEN_AUTH_TYPES.OAUTH;
    if (/Coding Plan/i.test(stdout)) return QWEN_AUTH_TYPES.CODING_PLAN;
    if (/API[- ]?KEY/i.test(stdout) || /API Key/i.test(stdout)) return QWEN_AUTH_TYPES.API_KEY;
  } catch (err) {
    logger.debug({ err }, 'Failed to detect qwen auth status from CLI');
  }
  return null;
}

function detectAuthTypeFromSettings(settings: QwenSettings | null): QwenAuthType {
  const selectedType = settings?.security?.auth?.selectedType;
  if (selectedType === QWEN_AUTH_TYPES.OAUTH) return QWEN_AUTH_TYPES.OAUTH;

  const providers = settings?.modelProviders ?? {};
  const selectedProviders = Array.isArray(selectedType) ? [] : (selectedType ? (providers[selectedType] ?? []) : []);
  if (selectedProviders.some((entry) => isCodingPlanModelProvider(entry))) {
    return QWEN_AUTH_TYPES.CODING_PLAN;
  }
  if (selectedType) {
    return QWEN_AUTH_TYPES.API_KEY;
  }

  const allProviders = Object.values(providers).flat();
  if (allProviders.some((entry) => isCodingPlanModelProvider(entry))) return QWEN_AUTH_TYPES.CODING_PLAN;
  if (allProviders.length > 0) return QWEN_AUTH_TYPES.API_KEY;
  return QWEN_AUTH_TYPES.UNKNOWN;
}

function getAvailableModelsFromSettings(settings: QwenSettings | null, authType: QwenAuthType): string[] {
  if (authType === QWEN_AUTH_TYPES.OAUTH) return [...QWEN_OAUTH_MODEL_IDS];
  if (authType === QWEN_AUTH_TYPES.CODING_PLAN) return [...QWEN_CODING_PLAN_MODEL_IDS];

  const selectedType = settings?.security?.auth?.selectedType;
  const providers = settings?.modelProviders ?? {};
  const selectedProviders = selectedType ? (providers[selectedType] ?? []) : [];
  const ids = selectedProviders.map((entry) => entry.id).filter((id): id is string => typeof id === 'string');
  return dedupe(ids);
}

export async function getQwenRuntimeConfig(force = false): Promise<QwenRuntimeConfig> {
  if (!force && cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const settings = await readSettings();
  const authFromStatus = await detectAuthTypeFromStatus();
  const authType = authFromStatus ?? detectAuthTypeFromSettings(settings);
  const availableModels = getAvailableModelsFromSettings(settings, authType);

  const value = {
    authType,
    availableModels,
  };
  cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}
