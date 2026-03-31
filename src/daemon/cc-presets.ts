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
import logger from '../util/logger.js';

const PRESETS_PATH = join(homedir(), '.imcodes', 'cc-presets.json');

export interface CcPreset {
  name: string;
  env: Record<string, string>;
}

let cachedPresets: CcPreset[] | null = null;

/** Model env vars that should all match ANTHROPIC_MODEL when set. */
const MODEL_ALIASES = [
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
];

export async function loadPresets(): Promise<CcPreset[]> {
  if (cachedPresets) return cachedPresets;
  try {
    const raw = await fs.readFile(PRESETS_PATH, 'utf8');
    cachedPresets = JSON.parse(raw) as CcPreset[];
    return cachedPresets;
  } catch {
    cachedPresets = [];
    return cachedPresets;
  }
}

export async function savePresets(presets: CcPreset[]): Promise<void> {
  cachedPresets = presets;
  await fs.writeFile(PRESETS_PATH, JSON.stringify(presets, null, 2), 'utf8');
}

export async function getPreset(name: string): Promise<CcPreset | undefined> {
  const presets = await loadPresets();
  return presets.find((p) => p.name === name);
}

/**
 * Resolve a preset name to env vars ready for session launch.
 * Auto-fills MODEL_ALIASES from ANTHROPIC_MODEL if set.
 */
export async function resolvePresetEnv(presetName: string): Promise<Record<string, string>> {
  const preset = await getPreset(presetName);
  if (!preset) return {};
  const env = { ...preset.env };
  // Auto-fill model aliases from ANTHROPIC_MODEL
  if (env['ANTHROPIC_MODEL']) {
    for (const alias of MODEL_ALIASES) {
      if (!env[alias]) env[alias] = env['ANTHROPIC_MODEL'];
    }
  }
  logger.debug({ preset: presetName, keys: Object.keys(env) }, 'Resolved CC preset env');
  return env;
}

export function invalidateCache(): void {
  cachedPresets = null;
}
