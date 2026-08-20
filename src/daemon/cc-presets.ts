/**
 * CC Environment Presets — named sets of env vars for launching Claude Code
 * with alternative API providers (MiniMax, DeepSeek, OpenRouter, etc.).
 *
 * Stored in ~/.imcodes/cc-presets.json.
 * When a preset is selected, its env vars are merged into the session launch env.
 * ANTHROPIC_MODEL value is auto-copied to the 4 model override env vars.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  getCcPresetAvailableModelIds,
  getCcPresetEffectiveModel,
  normalizeCcPresetContextWindow,
  normalizeCcPresetName,
  type CcPreset,
  type CcPresetModelInfo,
} from '../../shared/cc-presets.js';
import type { DshLlmConfig } from '../../shared/deepseek-harness.js';
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
  const configuredContextWindow = typeof record.contextWindow === 'number'
    && Number.isFinite(record.contextWindow)
    && record.contextWindow > 0
    ? record.contextWindow
    : undefined;
  const effectiveModel = envRecord['ANTHROPIC_MODEL']?.trim()
    || defaultModel
    || envRecord['OPENAI_MODEL']?.trim()
    || undefined;
  const contextWindow = normalizeCcPresetContextWindow(configuredContextWindow, effectiveModel);
  return {
    name,
    env: envRecord,
    ...(contextWindow ? { contextWindow } : {}),
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
  const deduped = new Map<string, CcPreset>();
  for (const preset of raw
    .map((item) => normalizePreset(item))
    .filter((item): item is CcPreset => item !== null)) {
    // Treat preset names as references. If stale files contain `minimax` and
    // `MiniMax`, keep the last saved entry so later UI saves replace older
    // values instead of getPreset() resolving the first stale copy after restart.
    deduped.set(normalizeCcPresetName(preset.name), preset);
  }
  return [...deduped.values()];
}

export async function loadPresets(): Promise<CcPreset[]> {
  if (cachedPresets) return cachedPresets;
  try {
    const raw = await fs.readFile(PRESETS_PATH, 'utf8');
    cachedPresets = normalizePresets(JSON.parse(raw));
    return cachedPresets;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.warn({ err, path: PRESETS_PATH }, 'Failed to load CC presets');
    }
    cachedPresets = [];
    return cachedPresets;
  }
}

export async function savePresets(presets: CcPreset[]): Promise<void> {
  const normalized = normalizePresets(presets);
  await fs.mkdir(dirname(PRESETS_PATH), { recursive: true });
  const tempPath = `${PRESETS_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(normalized, null, 2), 'utf8');
  await fs.rename(tempPath, PRESETS_PATH);
  cachedPresets = normalized;
}

export async function getPreset(name: string): Promise<CcPreset | undefined> {
  const presets = await loadPresets();
  const normalized = normalizeCcPresetName(name);
  return presets.find((p) => normalizeCcPresetName(p.name) === normalized);
}

export function getPresetEffectiveModel(preset: Pick<CcPreset, 'defaultModel' | 'env'>): string | undefined {
  return getCcPresetEffectiveModel(preset);
}

export function getPresetAvailableModelIds(preset: Pick<CcPreset, 'availableModels' | 'defaultModel' | 'env'>): string[] {
  return getCcPresetAvailableModelIds(preset);
}

/** `${preset}:${model}` pairs already warned about, so launches stay quiet after the first. */
const warnedUndiscoveredPresetModels = new Set<string>();

/**
 * Warn when a preset pins a model the provider never advertised.
 *
 * Anthropic-compatible third-party endpoints accept an unknown model id without
 * an error and silently serve their own default — MiniMax answers a request for
 * `MiniMax-M.27` (a typo for `MiniMax-M2.7`) exactly like a valid one. The
 * session then runs fine on a model the preset does not name, which is
 * invisible without this check. Only advisory: an empty discovery list, or a
 * model the user legitimately knows about, must never block a launch.
 */
function warnIfPresetModelUndiscovered(preset: CcPreset, configuredModel: string | undefined): void {
  if (!configuredModel) return;
  const discovered = (preset.availableModels ?? []).map((entry) => entry.id);
  if (discovered.length === 0 || discovered.includes(configuredModel)) return;
  const key = `${preset.name}:${configuredModel}`;
  if (warnedUndiscoveredPresetModels.has(key)) return;
  warnedUndiscoveredPresetModels.add(key);
  logger.warn(
    { preset: preset.name, configuredModel, discoveredModels: discovered },
    'cc-preset: configured model is not in this provider\'s discovered model list — the endpoint may silently serve a different model',
  );
}

/**
 * Resolve a preset name to env vars ready for session launch.
 * Auto-fills MODEL_ALIASES from ANTHROPIC_MODEL if set.
 */
export async function resolvePresetEnv(
  presetName: string,
  ccSessionId?: string,
  modelOverride?: string,
): Promise<Record<string, string>> {
  const preset = await getPreset(presetName);
  if (!preset) return {};
  const env = { ...preset.env };
  // Backward compatibility: older saved presets used ANTHROPIC_AUTH_TOKEN,
  // while current Claude CLI/SDK auth reads ANTHROPIC_API_KEY in bare env mode.
  if (env['ANTHROPIC_AUTH_TOKEN'] && !env['ANTHROPIC_API_KEY']) {
    env['ANTHROPIC_API_KEY'] = env['ANTHROPIC_AUTH_TOKEN'];
  }
  const effectiveModel = modelOverride?.trim() || getPresetEffectiveModel(preset);
  if (effectiveModel) env['ANTHROPIC_MODEL'] = effectiveModel;
  // Auto-fill model aliases from ANTHROPIC_MODEL
  if (env['ANTHROPIC_MODEL']) {
    for (const alias of MODEL_ALIASES) {
      // A per-session model selection must override aliases persisted by an
      // older one-model-per-preset config. Otherwise the SDK may still route
      // "sonnet"/"opus"/"haiku" through the preset's previous default.
      if (modelOverride?.trim() || !env[alias]) env[alias] = env['ANTHROPIC_MODEL'];
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

export async function getPresetTransportOverrides(
  presetName: string,
  modelOverride?: string,
): Promise<{
  model?: string;
  systemPrompt?: string;
  contextWindow?: number;
}> {
  const preset = await getPreset(presetName);
  if (!preset) return {};
  const configuredModel = modelOverride?.trim() || getPresetEffectiveModel(preset);
  warnIfPresetModelUndiscovered(preset, configuredModel);
  const env = await resolvePresetEnv(presetName, undefined, configuredModel);
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

export async function getDshPresetTransportConfig(presetName: string): Promise<{
  env: Record<string, string>;
  llm?: DshLlmConfig;
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

  // DeepSeek Harness (dsh) is settings-based, not env-var based: the LLM
  // config (provider route + model + endpoint + key) rides in the dsh
  // overlay's `agent-default-model` row (carried here as `llm`), so only the
  // model is mirrored into env as a fallback for any env-reading path.
  const env: Record<string, string> = {};
  if (model) env['ANTHROPIC_MODEL'] = model;

  const llm = (model || baseUrl)
    ? {
        provider: normalizeCcPresetName(preset.name),
        model: model ?? availableModels[0],
        ...(baseUrl ? { baseUrl } : {}),
        ...(apiKey ? { apiKey } : {}),
      }
    : undefined;

  const runtimeFacts = (model || baseUrl) ? [
    `Authoritative runtime fact: this session is routed through the "${preset.name}" API provider preset.`,
    baseUrl ? `Authoritative provider endpoint: ${baseUrl}.` : undefined,
    model ? `Authoritative runtime model: ${model}.` : undefined,
    model ? `If the user asks which model you are using, answer exactly with "${model}".` : undefined,
    baseUrl ? `If the user asks which provider or endpoint you are using, mention "${baseUrl}".` : undefined,
    'These runtime facts override any generic default model or provider.',
  ].filter(Boolean).join(' ') : undefined;

  return {
    env,
    ...(llm ? { llm } : {}),
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
  } else if (/\/v\d+(?:$|\/)/.test(trimmed)) {
    candidates.add(`${trimmed}/models`);
  } else {
    // Anthropic-compatible providers standardize on /v1/models. Try that
    // first so MiniMax and the official Claude API do not pay a guaranteed
    // 404 round-trip through the unversioned path.
    candidates.add(`${trimmed}/v1/models`);
    candidates.add(`${trimmed}/models`);
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

class CompatibleModelsEndpointUnavailableError extends Error {}

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
      const availableModels: CcPresetModelInfo[] = [];
      const seen = new Set<string>();
      let afterId: string | undefined;
      // Anthropic's list endpoint is cursor-paginated. The page cap prevents a
      // broken compatible gateway from returning an endless has_more loop.
      for (let page = 0; page < 100; page += 1) {
        const url = new URL(endpoint);
        url.searchParams.set('limit', '1000');
        if (afterId) url.searchParams.set('after_id', afterId);
        const response = await fetch(url, {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            accept: 'application/json',
          },
        });
        if (!response.ok) {
          const message = `HTTP ${response.status} ${response.statusText}`.trim();
          if (response.status === 404 || response.status === 405) {
            throw new CompatibleModelsEndpointUnavailableError(message);
          }
          // Authentication, rate-limit, and provider failures prove that this
          // endpoint exists. Do not replace a useful 401/429/5xx diagnosis
          // with the fallback endpoint's likely 404.
          throw new Error(message);
        }
        const payload = await response.json() as unknown;
        for (const model of parseDiscoveredModels(payload)) {
          if (seen.has(model.id)) continue;
          seen.add(model.id);
          availableModels.push(model);
        }
        const payloadRecord = payload && typeof payload === 'object'
          ? payload as Record<string, unknown>
          : {};
        if (payloadRecord.has_more !== true) break;
        const nextAfterId = typeof payloadRecord.last_id === 'string'
          ? payloadRecord.last_id.trim()
          : '';
        if (!nextAfterId || nextAfterId === afterId) {
          throw new Error('Compatible models API returned an invalid pagination cursor');
        }
        afterId = nextAfterId;
        if (page === 99) {
          throw new Error('Compatible models API exceeded the pagination limit');
        }
      }
      if (availableModels.length === 0) {
        throw new Error('No models returned by compatible API');
      }
      const existingModel = getPresetEffectiveModel(preset);
      const defaultModel = existingModel ?? availableModels[0]?.id;
      return { availableModels, defaultModel, endpoint };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!(error instanceof CompatibleModelsEndpointUnavailableError)) throw lastError;
    }
  }
  throw lastError ?? new Error('Failed to discover models');
}

export interface CcPresetModelCatalog {
  preset: CcPreset;
  models: CcPresetModelInfo[];
  defaultModel?: string;
  endpoint?: string;
}

function getStoredPresetModelCatalog(preset: CcPreset): CcPresetModelCatalog {
  const discovered = preset.availableModels ?? [];
  const models = discovered.length > 0
    ? discovered
    : getPresetAvailableModelIds(preset).map((id) => ({ id }));
  const effectiveModel = getPresetEffectiveModel(preset);
  const defaultModel = effectiveModel && models.some((model) => model.id === effectiveModel)
    ? effectiveModel
    : models[0]?.id;
  return {
    preset,
    models,
    ...(defaultModel ? { defaultModel } : {}),
  };
}

/**
 * Refresh one preset's model catalog and persist it without changing the
 * preset's default model. A preset represents provider credentials/endpoint;
 * the selected model remains per-session state.
 */
export async function refreshPresetModels(presetName: string): Promise<CcPresetModelCatalog> {
  const preset = await getPreset(presetName);
  if (!preset) throw new Error(`Preset "${presetName}" not found`);
  const normalizedName = normalizeCcPresetName(preset.name);
  try {
    const discovered = await discoverPresetModels(preset);
    const latestPresets = await loadPresets();
    const latestPreset = latestPresets.find(
      (item) => normalizeCcPresetName(item.name) === normalizedName,
    ) ?? preset;
    const updatedPreset: CcPreset = {
      ...latestPreset,
      transportMode: latestPreset.transportMode ?? 'qwen-compatible-api',
      authType: latestPreset.authType ?? 'anthropic',
      availableModels: discovered.availableModels,
      lastDiscoveredAt: Date.now(),
      modelDiscoveryError: undefined,
    };
    await savePresets(latestPresets.map((item) => (
      normalizeCcPresetName(item.name) === normalizedName ? updatedPreset : item
    )));
    const catalog = getStoredPresetModelCatalog(updatedPreset);
    return { ...catalog, endpoint: discovered.endpoint };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const latestPresets = await loadPresets();
    const latestPreset = latestPresets.find(
      (item) => normalizeCcPresetName(item.name) === normalizedName,
    ) ?? preset;
    const updatedPreset: CcPreset = {
      ...latestPreset,
      modelDiscoveryError: message,
    };
    await savePresets(latestPresets.map((item) => (
      normalizeCcPresetName(item.name) === normalizedName ? updatedPreset : item
    )));
    throw error;
  }
}

export async function getPresetModelCatalog(
  presetName: string,
  force = false,
): Promise<CcPresetModelCatalog> {
  const preset = await getPreset(presetName);
  if (!preset) throw new Error(`Preset "${presetName}" not found`);
  if (force || !preset.availableModels?.length) {
    return await refreshPresetModels(preset.name);
  }
  return getStoredPresetModelCatalog(preset);
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
  return cachedPresets.find((preset) => normalizeCcPresetName(preset.name) === normalized)?.contextWindow;
}
