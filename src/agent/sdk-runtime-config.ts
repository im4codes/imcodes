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

let grokCache: { expiresAt: number; value: SdkRuntimeConfig } | null = null;

async function readGrokSubscriptionType(): Promise<string | undefined> {
  try {
    const raw = await readFile(join(homedir(), '.grok', 'settings_cache.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      payload?: string | {
        settings?: {
          subscription_tier_display?: string;
          subscription_tier?: string;
        };
      };
    };
    let payload = parsed.payload;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = undefined;
      }
    }
    const settings = (payload as { settings?: { subscription_tier_display?: string; subscription_tier?: string } })?.settings;
    const tier = settings?.subscription_tier_display || settings?.subscription_tier;
    return typeof tier === 'string' && tier.trim() ? tier.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function getGrokSdkRuntimeConfig(force = false): Promise<SdkRuntimeConfig> {
  const now = Date.now();
  if (!force && grokCache && grokCache.expiresAt > now) return grokCache.value;
  try {
    const tier = await readGrokSubscriptionType();
    const value = { ...(tier ? { planLabel: tier } : {}) };
    grokCache = { expiresAt: now + CACHE_TTL_MS, value };
    return value;
  } catch {
    const value = {};
    grokCache = { expiresAt: now + CACHE_TTL_MS, value };
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
  if (model === 'opus[1M]') return 'opus';
  // The `fable` picker alias maps to the documented API id so launch works on
  // any CC build, even before `fable` is registered as a CLI alias.
  if (model === 'fable') return 'claude-fable-5';
  return model;
}
