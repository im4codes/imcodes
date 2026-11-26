import type { SharedContextRuntimeBackend } from '../../shared/context-types.js';
import {
  DEFAULT_OPENCLAW_CONTEXT_MODEL,
  doesSharedContextBackendSupportPresets,
} from '../../shared/shared-context-runtime-config.js';

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
  sessionModel?: string;
}

export async function resolveProcessingProviderSessionConfig(
  selection: ProcessingBackendSelection,
): Promise<ProcessingProviderSessionConfig> {
  const model = selection.model?.trim() || undefined;
  const preset = selection.preset?.trim() || undefined;

  if (doesSharedContextBackendSupportPresets(selection.backend as SharedContextRuntimeBackend) && preset) {
    switch (selection.backend) {
      case 'claude-code-sdk': {
        // Native Claude Code SDK path: the preset's ANTHROPIC_BASE_URL/API_KEY/
        // pinned ANTHROPIC_MODEL env is applied directly (no OpenAI-compat
        // settings shim). resolvePresetEnv already pins ANTHROPIC_MODEL.
        const { resolvePresetEnv } = await import('../daemon/cc-presets.js');
        const env = await resolvePresetEnv(preset, undefined, model);
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
      case 'codex-sdk': {
        const { getCodexPresetTransportConfig } = await import('../daemon/cc-presets.js');
        const presetConfig = await getCodexPresetTransportConfig(preset, model);
        return {
          cacheKey: JSON.stringify({
            backend: selection.backend,
            preset,
            model: presetConfig.model ?? model ?? null,
            env: presetConfig.env,
          }),
          ...(presetConfig.env ? { env: presetConfig.env } : {}),
          ...(presetConfig.model ?? model ? { agentId: presetConfig.model ?? model } : {}),
        };
      }
    }
  }

  if (selection.backend === 'openclaw') {
    // OpenClaw's SessionConfig.agentId identifies the gateway agent (default 'main'),
    // not a model ID. Keep agentId unset so OpenClaw uses its configured gateway agent,
    // and pass non-default manual model selections via sessionModel.
    const sessionModel = model && model !== DEFAULT_OPENCLAW_CONTEXT_MODEL ? model : undefined;
    return {
      cacheKey: JSON.stringify({ backend: selection.backend, model: model ?? null }),
      ...(sessionModel ? { sessionModel } : {}),
    };
  }

  return {
    cacheKey: JSON.stringify({ backend: selection.backend, model: model ?? null }),
    ...(model ? { agentId: model } : {}),
  };
}
