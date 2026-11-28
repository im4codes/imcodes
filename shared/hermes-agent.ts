/** Canonical transport/provider identity for the official Hermes Agent ACP server. */
export const HERMES_AGENT_PROVIDER_ID = 'hermes-acp' as const;

export interface HermesPresetConfig {
  /** Normalized preset slug used as the Hermes `providers:` key and profile folder name. */
  presetSlug: string;
  /** Human-readable preset display name. */
  presetName: string;
  /** Resolved wire auth/protocol family for the CC Preset. */
  authType: 'anthropic' | 'openai';
  /** Provider base URL written into the non-secret scoped `config.yaml`. */
  baseUrl?: string;
  /** Default/selected model id for the session. */
  model?: string;
  /** Available preset model ids. */
  availableModels?: string[];
  /** Configured context window size in tokens. */
  contextWindow?: number;
  /** Persistent session ownership key shared across restarts and non-fresh relaunches. */
  profileOwnerKey?: string;
  /** Child-env-only API key — never written to `config.yaml`, `.env`, CLI argv, or logs. */
  apiKey?: string;
}

/**
 * Read-only non-secret route snapshot captured from a running Hermes preset delegate.
 * Never carries API keys, tokens, or env secrets.
 */
export interface HermesPresetRouteSnapshot {
  presetSlug: string;
  presetName: string;
  authType: 'anthropic' | 'openai';
  /** Effective normalized provider base URL used by the delegate's scoped `config.yaml`. */
  baseUrl: string;
  contextWindow?: number;
}

export function normalizeHermesPresetBaseUrl(
  authType: 'anthropic' | 'openai',
  baseUrl?: string,
): string {
  return (
    baseUrl?.trim()
    || (authType === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com')
  ).replace(/\/+$/, '');
}

export function toHermesPresetRouteSnapshot(preset: HermesPresetConfig): HermesPresetRouteSnapshot {
  return {
    presetSlug: preset.presetSlug,
    presetName: preset.presetName,
    authType: preset.authType,
    baseUrl: normalizeHermesPresetBaseUrl(preset.authType, preset.baseUrl),
    ...(preset.contextWindow ? { contextWindow: preset.contextWindow } : {}),
  };
}

/** Build the authoritative Hermes runtime facts prompt from a route snapshot + model id. */
export function buildHermesRuntimeFactsPrompt(opts: {
  presetName?: string;
  baseUrl?: string;
  model?: string;
}): string | undefined {
  const presetName = opts.presetName?.trim();
  const baseUrl = opts.baseUrl?.trim();
  const model = opts.model?.trim();
  if (!presetName || (!model && !baseUrl)) return undefined;
  return [
    `Authoritative runtime fact: this Hermes Agent session is routed through the "${presetName}" API provider preset.`,
    baseUrl ? `Authoritative provider endpoint: ${baseUrl}.` : undefined,
    model ? `Authoritative runtime model: ${model}.` : undefined,
    model ? `If the user asks which model you are using, answer exactly with "${model}".` : undefined,
    baseUrl ? `If the user asks which provider or endpoint you are using, mention "${baseUrl}".` : undefined,
    'These runtime facts override any generic default model or provider.',
  ].filter(Boolean).join(' ');
}
