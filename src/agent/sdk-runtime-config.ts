import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_CODE_MODEL_IDS, CODEX_MODEL_IDS } from '../shared/models/options.js';
const CACHE_TTL_MS = 30_000;

export interface SdkRuntimeConfig {
  planLabel?: string;
}

function capitalize(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

let claudeCache: { expiresAt: number; value: SdkRuntimeConfig } | null = null;

async function readClaudeSubscriptionType(): Promise<string | undefined> {
  try {
    const raw = await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { subscriptionType?: string };
      claudeAi?: { subscriptionType?: string };
    };
    const value = parsed.claudeAiOauth?.subscriptionType ?? parsed.claudeAi?.subscriptionType;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function getClaudeSdkRuntimeConfig(force = false): Promise<SdkRuntimeConfig> {
  const now = Date.now();
  if (!force && claudeCache && claudeCache.expiresAt > now) return claudeCache.value;
  try {
    const subscriptionType = await readClaudeSubscriptionType();
    const planLabel = capitalize(subscriptionType);
    const value = { ...(planLabel ? { planLabel } : {}) };
    claudeCache = { expiresAt: now + CACHE_TTL_MS, value };
    return value;
  } catch {
    const value = {};
    claudeCache = { expiresAt: now + CACHE_TTL_MS, value };
    return value;
  }
}

export function getClaudeSdkAvailableModels(): readonly string[] {
  return CLAUDE_CODE_MODEL_IDS;
}

export function getCodexSdkAvailableModels(): readonly string[] {
  return CODEX_MODEL_IDS;
}

export function normalizeClaudeSdkModelForProvider(model: string): string {
  return model === 'opus[1M]' ? 'opus' : model;
}
