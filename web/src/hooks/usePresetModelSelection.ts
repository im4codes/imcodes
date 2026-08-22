import { useEffect, useRef } from 'preact/hooks';
import {
  CUSTOM_PROVIDER_SDK_AGENT_TYPES,
  getCcPresetEffectiveModel,
  normalizeCcPresetName,
  type CcPreset,
} from '@shared/cc-presets.js';

interface PresetModelSelectionOptions {
  agentType: string;
  preset: CcPreset | undefined;
  suggestions: readonly string[];
  setRequestedModel: (value: string | ((current: string) => string)) => void;
}

/**
 * Keeps the model bound to the selected provider route. A provider/preset
 * switch must select that route's own default even when the previous model id
 * happens to exist in both catalogs; later catalog refreshes only clamp values
 * which are no longer valid.
 */
export function usePresetModelSelection({
  agentType,
  preset,
  suggestions,
  setRequestedModel,
}: PresetModelSelectionOptions): void {
  const routeIdentity = CUSTOM_PROVIDER_SDK_AGENT_TYPES.has(agentType) && preset
    ? `${agentType}\0${normalizeCcPresetName(preset.name)}`
    : '';
  const previousRouteIdentity = useRef<string>('');

  useEffect(() => {
    if (!routeIdentity || !preset) {
      previousRouteIdentity.current = '';
      return;
    }

    const fallback = getCcPresetEffectiveModel(preset) ?? suggestions[0] ?? '';
    const routeChanged = previousRouteIdentity.current !== routeIdentity;
    previousRouteIdentity.current = routeIdentity;

    setRequestedModel((current) => {
      if (routeChanged) return fallback;
      const trimmed = current.trim();
      if (suggestions.length === 0 || (trimmed && suggestions.includes(trimmed))) {
        return current || fallback;
      }
      return suggestions.includes(fallback) ? fallback : (suggestions[0] ?? fallback);
    });
  }, [preset, routeIdentity, setRequestedModel, suggestions]);
}
