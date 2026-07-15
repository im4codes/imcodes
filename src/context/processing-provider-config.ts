import type { SharedContextRuntimeBackend } from '../../shared/context-types.js';
import { doesSharedContextBackendSupportPresets } from '../../shared/shared-context-runtime-config.js';

export interface ProcessingBackendSelection {
  backend: SharedContextRuntimeBackend | string;
  model?: string;
  preset?: string;
}

export interface ProcessingProviderSessionConfig {
  cacheKey: string;
  env?: Record<string, string>;
  settings?: string | Record<string, unknown>;
  agentId?: string;
}

export async function resolveProcessingProviderSessionConfig(
  selection: ProcessingBackendSelection,
): Promise<ProcessingProviderSessionConfig> {
  const model = selection.model?.trim() || undefined;
  const preset = selection.preset?.trim() || undefined;

  if (doesSharedContextBackendSupportPresets(selection.backend as SharedContextRuntimeBackend) && preset) {
    switch (selection.backend) {
      case 'qwen': {
        const { getQwenPresetTransportConfig } = await import('../daemon/cc-presets.js');
        const presetConfig = await getQwenPresetTransportConfig(preset);
        return {
          cacheKey: JSON.stringify({
            backend: selection.backend,
            preset,
            model: presetConfig.model ?? model ?? null,
            env: presetConfig.env,
            settings: presetConfig.settings ?? null,
          }),
          ...(presetConfig.env ? { env: presetConfig.env } : {}),
          ...(presetConfig.settings ? { settings: presetConfig.settings } : {}),
          ...(presetConfig.model ?? model ? { agentId: presetConfig.model ?? model } : {}),
        };
      }
      case 'claude-code-sdk': {
        // Native Claude Code SDK path: the preset's ANTHROPIC_BASE_URL/API_KEY/
        // pinned ANTHROPIC_MODEL env is applied directly (no OpenAI-compat
        // settings shim). resolvePresetEnv already pins ANTHROPIC_MODEL.
        const { resolvePresetEnv } = await import('../daemon/cc-presets.js');
        const env = await resolvePresetEnv(preset);
        const resolvedModel = env['ANTHROPIC_MODEL']?.trim() || model;
        return {
          cacheKey: JSON.stringify({
            backend: selection.backend,
            preset,
            model: resolvedModel ?? null,
            env,
          }),
          ...(Object.keys(env).length > 0 ? { env } : {}),
          ...(resolvedModel ? { agentId: resolvedModel } : {}),
        };
      }
    }
  }

  return {
    cacheKey: JSON.stringify({ backend: selection.backend, model: model ?? null }),
    ...(model ? { agentId: model } : {}),
  };
}
