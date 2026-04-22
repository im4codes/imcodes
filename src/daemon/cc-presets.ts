/**
 * CC Environment Presets — named sets of env vars for launching Claude Code
 * with alternative API providers (MiniMax, DeepSeek, OpenRouter, etc.).
 *
 * Stored in ~/.imcodes/cc-presets.json.
 * When a preset is selected, its env vars are merged into the session launch env.
 * ANTHROPIC_MODEL value is auto-copied to the 4 model override env vars.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CcPreset, CcPresetModelInfo } from '../../shared/cc-presets.js';
import logger from '../util/logger.js';

const PRESETS_PATH = join(homedir(), '.imcodes', 'cc-presets.json');

let cachedPresets: CcPreset[] | null = null;

/** ccSessionId → contextWindow (set when preset env is resolved for a session). */
const sessionContextWindows = new Map<string, number>();

/** Model env vars that should all match ANTHROPIC_MODEL when set. */
const MODEL_ALIASES = [
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
];

function normalizePresetModel(raw: unknown): CcPresetModelInfo | null {
  if (typeof raw === 'string') {
    const id = raw.trim();
    return id ? { id } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return null;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  return name ? { id, name } : { id };
}

function normalizePreset(raw: unknown): CcPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name) return null;
  const envRecord = record.env && typeof record.env === 'object'
    ? Object.entries(record.env as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, value]) => {
        if (typeof value === 'string') acc[key] = value;
        return acc;
      }, {})
    : {};
  const availableModels = Array.isArray(record.availableModels)
    ? record.availableModels
        .map((item) => normalizePresetModel(item))
        .filter((item): item is CcPresetModelInfo => item !== null)
    : undefined;
  const defaultModel = typeof record.defaultModel === 'string'
    ? record.defaultModel.trim()
    : '';
  return {
    name,
    env: envRecord,
    ...(typeof record.contextWindow === 'number' ? { contextWindow: record.contextWindow } : {}),
    ...(typeof record.initMessage === 'string' ? { initMessage: record.initMessage } : {}),
    ...(record.transportMode === 'qwen-compatible-api' || record.transportMode === 'claude-cli-preset'
      ? { transportMode: record.transportMode }
      : {}),
    ...(record.authType === 'anthropic' ? { authType: record.authType } : {}),
    ...(availableModels?.length ? { availableModels } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(typeof record.lastDiscoveredAt === 'number' ? { lastDiscoveredAt: record.lastDiscoveredAt } : {}),
    ...(typeof record.modelDiscoveryError === 'string' ? { modelDiscoveryError: record.modelDiscoveryError } : {}),
  };
}

function normalizePresets(raw: unknown): CcPreset[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizePreset(item))
    .filter((item): item is CcPreset => item !== null);
}

export async function loadPresets(): Promise<CcPreset[]> {
  if (cachedPresets) return cachedPresets;
  try {
    const raw = await fs.readFile(PRESETS_PATH, 'utf8');
    cachedPresets = normalizePresets(JSON.parse(raw));
    return cachedPresets;
  } catch {
    cachedPresets = [];
    return cachedPresets;
  }
}

export async function savePresets(presets: CcPreset[]): Promise<void> {
  cachedPresets = normalizePresets(presets);
  await fs.writeFile(PRESETS_PATH, JSON.stringify(cachedPresets, null, 2), 'utf8');
}

function normalizePresetName(name: string): string {
  return name.trim().toLowerCase();
}

export async function getPreset(name: string): Promise<CcPreset | undefined> {
  const presets = await loadPresets();
  const normalized = normalizePresetName(name);
  return presets.find((p) => normalizePresetName(p.name) === normalized);
}

export function getPresetEffectiveModel(preset: Pick<CcPreset, 'defaultModel' | 'env'>): string | undefined {
  const model = preset.defaultModel?.trim() || preset.env['ANTHROPIC_MODEL']?.trim() || '';
  return model || undefined;
}

export function getPresetAvailableModelIds(preset: Pick<CcPreset, 'availableModels' | 'defaultModel' | 'env'>): string[] {
  const discovered = preset.availableModels
    ?.map((item) => item.id.trim())
    .filter(Boolean) ?? [];
  if (discovered.length > 0) return [...new Set(discovered)];
  const fallback = getPresetEffectiveModel(preset);
  return fallback ? [fallback] : [];
}

/**
 * Resolve a preset name to env vars ready for session launch.
 * Auto-fills MODEL_ALIASES from ANTHROPIC_MODEL if set.
 */
export async function resolvePresetEnv(presetName: string, ccSessionId?: string): Promise<Record<string, string>> {
  const preset = await getPreset(presetName);
  if (!preset) return {};
  const env = { ...preset.env };
  // Backward compatibility: older saved presets used ANTHROPIC_AUTH_TOKEN,
  // while current Claude CLI/SDK auth reads ANTHROPIC_API_KEY in bare env mode.
  if (env['ANTHROPIC_AUTH_TOKEN'] && !env['ANTHROPIC_API_KEY']) {
    env['ANTHROPIC_API_KEY'] = env['ANTHROPIC_AUTH_TOKEN'];
  }
  const effectiveModel = getPresetEffectiveModel(preset);
  if (effectiveModel) env['ANTHROPIC_MODEL'] = effectiveModel;
  // Auto-fill model aliases from ANTHROPIC_MODEL
  if (env['ANTHROPIC_MODEL']) {
    for (const alias of MODEL_ALIASES) {
      if (!env[alias]) env[alias] = env['ANTHROPIC_MODEL'];
    }
  }
  // Set context window hint as env var so daemon can report it in usage events
  if (preset.contextWindow) {
    env['IMCODES_CONTEXT_WINDOW'] = String(preset.contextWindow);
    // Also cache for watcher lookup
    if (ccSessionId) sessionContextWindows.set(ccSessionId, preset.contextWindow);
  }
  logger.debug({ preset: presetName, keys: Object.keys(env) }, 'Resolved CC preset env');
  return env;
}

export async function getPresetTransportOverrides(presetName: string): Promise<{
  model?: string;
  systemPrompt?: string;
  contextWindow?: number;
}> {
  const preset = await getPreset(presetName);
  if (!preset) return {};
  const env = await resolvePresetEnv(presetName);
  const configuredModel = getPresetEffectiveModel(preset);
  const configuredBaseUrl = env['ANTHROPIC_BASE_URL']?.trim() || undefined;
  const runtimeFacts = [
    `Authoritative runtime fact: this session is using the Claude Code preset "${preset.name}".`,
    configuredBaseUrl ? `Authoritative provider endpoint: ${configuredBaseUrl}.` : undefined,
    configuredModel ? `Authoritative runtime model: ${configuredModel}.` : undefined,
    configuredModel ? `If the user asks which model you are using, answer exactly with "${configuredModel}".` : 'If the user asks which model or provider you are using, answer with the authoritative runtime facts above.',
    configuredBaseUrl ? `If the user asks which provider or endpoint you are using, mention "${configuredBaseUrl}".` : undefined,
    'These runtime facts override any generic Claude Code tool schema, enum, or default.',
    'Do not answer with Sonnet, Opus, Haiku, or any inferred Claude default unless that exact value matches the authoritative runtime model above.',
  ].filter(Boolean).join(' ');
  return {
    ...(configuredModel ? { model: configuredModel } : {}),
    ...(runtimeFacts ? { systemPrompt: runtimeFacts } : {}),
    ...(preset.contextWindow ? { contextWindow: preset.contextWindow } : {}),
  };
}

export async function getQwenPresetTransportConfig(presetName: string): Promise<{
  env: Record<string, string>;
  settings?: Record<string, unknown>;
  model?: string;
  availableModels?: string[];
  systemPrompt?: string;
  contextWindow?: number;
}> {
  const preset = await getPreset(presetName);
  if (!preset) return { env: {} };

  const resolvedEnv = await resolvePresetEnv(presetName);
  const availableModels = getPresetAvailableModelIds(preset);
  const model = getPresetEffectiveModel(preset) ?? availableModels[0];
  const baseUrl = resolvedEnv['ANTHROPIC_BASE_URL']?.trim() || undefined;
  const apiKey = resolvedEnv['ANTHROPIC_API_KEY']?.trim()
    || resolvedEnv['ANTHROPIC_AUTH_TOKEN']?.trim()
    || undefined;

  const env: Record<string, string> = {};
  if (baseUrl) {
    env['ANTHROPIC_BASE_URL'] = baseUrl;
    // qwen CLI reads OPENAI_BASE_URL for --auth-type anthropic (OpenAI-compatible).
    // Also set ANTHROPIC_BASE_URL for completeness.
    env['OPENAI_BASE_URL'] = baseUrl;
  }
  if (apiKey) {
    env['ANTHROPIC_API_KEY'] = apiKey;
    // qwen CLI reads OPENAI_API_KEY for --auth-type anthropic (OpenAI-compatible).
    // Also set ANTHROPIC_API_KEY for completeness.
    env['OPENAI_API_KEY'] = apiKey;
  }
  if (model) env['ANTHROPIC_MODEL'] = model;

  const providerModels = availableModels.length > 0 ? availableModels : (model ? [model] : []);
  const settings: Record<string, unknown> | undefined = (baseUrl && apiKey && providerModels.length > 0)
    ? {
        security: {
          auth: {
            selectedType: 'anthropic',
          },
        },
        model: {
          name: model ?? providerModels[0],
        },
        modelProviders: {
          anthropic: providerModels.map((providerModelId) => ({
            id: providerModelId,
            name: preset.availableModels?.find((item) => item.id === providerModelId)?.name?.trim() || providerModelId,
            envKey: 'ANTHROPIC_API_KEY',
            baseUrl,
            ...(preset.contextWindow
              ? {
                  generationConfig: {
                    contextWindowSize: preset.contextWindow,
                  },
                }
              : {}),
          })),
        },
      }
    : undefined;

  // Override the qwen CLI's built-in "I am Qwen Code, developed by Alibaba"
  // identity. With --auth-type anthropic the tool wrapper is still Qwen CLI,
  // but the actual model serving each turn is whatever the preset points at
  // (MiniMax, GLM, Kimi, etc.). Without this override the CLI's baked-in
  // system prompt makes the model introduce itself as Qwen / 通义千问 even
  // though it's actually a different provider — confusing and factually
  // wrong. We piggy-back on --append-system-prompt (which qwen.ts forwards
  // from payload.systemText) to inject authoritative runtime facts.
  const runtimeFacts = (model || baseUrl) ? [
    `Authoritative runtime fact: this session is routed through the "${preset.name}" API provider preset.`,
    baseUrl ? `Authoritative provider endpoint: ${baseUrl}.` : undefined,
    model ? `Authoritative runtime model: ${model}. You are NOT running on Qwen / 通义千问 weights, regardless of what the host CLI's default system prompt says.` : undefined,
    model ? `If the user asks which model you are using, answer exactly with "${model}".` : 'If the user asks which model or provider you are using, answer with the authoritative runtime facts above.',
    baseUrl ? `If the user asks which provider or endpoint you are using, mention "${baseUrl}".` : undefined,
    'These runtime facts override any generic "Qwen Code" / "Alibaba Group" / "通义千问" identity baked into the Qwen CLI wrapper — the wrapper is just the tool harness; the weights serving this turn are the authoritative model named above.',
  ].filter(Boolean).join(' ') : undefined;

  return {
    env,
    ...(settings ? { settings } : {}),
    ...(model ? { model } : {}),
    ...(availableModels.length ? { availableModels } : {}),
    ...(runtimeFacts ? { systemPrompt: runtimeFacts } : {}),
    ...(preset.contextWindow ? { contextWindow: preset.contextWindow } : {}),
  };
}

function getDiscoveryCandidates(baseUrl: string): string[] {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return [];
  const candidates = new Set<string>();
  if (trimmed.endsWith('/models')) {
    candidates.add(trimmed);
  } else {
    candidates.add(`${trimmed}/models`);
    if (!/\/v\d+(?:$|\/)/.test(trimmed)) candidates.add(`${trimmed}/v1/models`);
  }
  return [...candidates];
}

function parseDiscoveredModels(payload: unknown): CcPresetModelInfo[] {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const rawModels = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  const seen = new Set<string>();
  const models: CcPresetModelInfo[] = [];
  for (const item of rawModels) {
    if (!item || typeof item !== 'object') continue;
    const model = item as Record<string, unknown>;
    const id = typeof model.id === 'string' ? model.id.trim() : '';
    if (!id || seen.has(id)) continue;
    const displayName = typeof model.display_name === 'string'
      ? model.display_name.trim()
      : typeof model.name === 'string'
        ? model.name.trim()
        : '';
    seen.add(id);
    models.push(displayName ? { id, name: displayName } : { id });
  }
  return models;
}

export async function discoverPresetModels(preset: CcPreset): Promise<{
  availableModels: CcPresetModelInfo[];
  defaultModel?: string;
  endpoint: string;
}> {
  const env = { ...preset.env };
  const baseUrl = env['ANTHROPIC_BASE_URL']?.trim() || '';
  const apiKey = env['ANTHROPIC_API_KEY']?.trim() || env['ANTHROPIC_AUTH_TOKEN']?.trim() || '';
  if (!baseUrl) throw new Error('Preset is missing ANTHROPIC_BASE_URL');
  if (!apiKey) throw new Error('Preset is missing ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN');

  let lastError: Error | null = null;
  for (const endpoint of getDiscoveryCandidates(baseUrl)) {
    try {
      const response = await fetch(endpoint, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          accept: 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      }
      const payload = await response.json() as unknown;
      const availableModels = parseDiscoveredModels(payload);
      if (availableModels.length === 0) {
        throw new Error('No models returned by compatible API');
      }
      const existingModel = getPresetEffectiveModel(preset);
      const defaultModel = availableModels.some((item) => item.id === existingModel)
        ? existingModel
        : (availableModels[0]?.id ?? undefined);
      return { availableModels, defaultModel, endpoint };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error('Failed to discover models');
}

/** Default init message for non-Anthropic providers (no native web search). */
const DEFAULT_INIT_MESSAGE = 'For web searches, use: curl -s "https://html.duckduckgo.com/html/?q=QUERY" | head -200. Replace QUERY with URL-encoded search terms.';

/** Get the init message for a preset (uses default if not specified). */
export function getPresetInitMessage(preset: CcPreset): string {
  return preset.initMessage ?? DEFAULT_INIT_MESSAGE;
}

export function invalidateCache(): void {
  cachedPresets = null;
}

/** Look up cached contextWindow for a CC session UUID. Returns undefined if not found. */
export function getSessionContextWindow(ccSessionId: string): number | undefined {
  return sessionContextWindows.get(ccSessionId);
}

export function getCachedPresetContextWindow(presetName: string | null | undefined): number | undefined {
  const normalized = presetName?.trim().toLowerCase();
  if (!normalized || !cachedPresets) return undefined;
  return cachedPresets.find((preset) => normalizePresetName(preset.name) === normalized)?.contextWindow;
}
