import { useTranslation } from 'react-i18next';
import type { SharedContextRuntimeBackend } from '@shared/context-types.js';
import {
  getCcPresetAvailableModelIds,
  getCcPresetEffectiveModel,
  type CcPreset,
} from '@shared/cc-presets.js';
import { doesSharedContextBackendSupportPresets } from '@shared/shared-context-runtime-config.js';

export type RuntimeModelPresetEntry = Pick<
  CcPreset,
  'name' | 'env' | 'availableModels' | 'defaultModel'
>;

/**
 * Shared model/preset picker for memory processing and automatic supervision.
 * A preset is an endpoint/env bundle, not merely another model name, so the
 * two dimensions remain visible. Its discovered model catalog stays
 * selectable just like the New Session dialog; choosing a model must not
 * silently clear the provider route.
 */
export function RuntimeModelPresetSelector({
  backend,
  model,
  preset,
  presets,
  modelOptions,
  onChange,
  idPrefix,
  disabled = false,
}: {
  backend: SharedContextRuntimeBackend;
  model: string;
  preset: string;
  presets: readonly RuntimeModelPresetEntry[];
  modelOptions: readonly string[];
  onChange: (next: { model: string; preset: string }) => void;
  idPrefix: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const supportsPresets = doesSharedContextBackendSupportPresets(backend);
  const trimmedModel = model.trim();
  const trimmedPreset = preset.trim();
  const activePreset = supportsPresets
    ? presets.find((entry) => entry.name === trimmedPreset)
    : undefined;
  const presetModelOptions = activePreset
    ? getCcPresetAvailableModelIds(activePreset)
    : [];
  const selectableModels = [...new Set([
    ...(activePreset ? presetModelOptions : []),
    ...modelOptions,
  ])];
  const handlePresetSelect = (event: Event) => {
    const nextPreset = (event.target as HTMLSelectElement).value;
    const entry = presets.find((candidate) => candidate.name === nextPreset);
    onChange({
      model: entry ? (getCcPresetEffectiveModel(entry) || trimmedModel) : trimmedModel,
      preset: nextPreset,
    });
  };
  const handleModelSelect = (event: Event) => onChange({
    model: (event.target as HTMLSelectElement).value,
    preset: activePreset ? trimmedPreset : '',
  });
  if (modelOptions.length === 0 && (!supportsPresets || presets.length === 0)) return null;

  return (
    <div style={selectorGroupStyle} data-testid={`${idPrefix}-runtime-model-preset-selector`}>
      {supportsPresets && presets.length > 0 ? (
        <label style={fieldStyle}>
          <span style={dimensionLabelStyle}>{t('sharedContext.management.processingPresetLabel')}</span>
          <select
            class="input"
            aria-label={`${idPrefix}:preset`}
            value={trimmedPreset}
            disabled={disabled}
            onInput={handlePresetSelect}
            onChange={handlePresetSelect}
            style={{ width: '100%' }}
          >
            <option value="">{t('sharedContext.management.processingPresetNone')}</option>
            {presets.map((entry) => (
              <option key={`${idPrefix}:preset:${entry.name}`} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <label style={fieldStyle}>
        <span style={dimensionLabelStyle}>{t('sharedContext.management.processingModelLabel')}</span>
        <select
          class="input"
          aria-label={`${idPrefix}:model`}
          value={trimmedModel}
          disabled={disabled}
          onInput={handleModelSelect}
          onChange={handleModelSelect}
          style={{ width: '100%' }}
        >
          {activePreset && selectableModels.length === 0 ? (
            <option value="">{t('sharedContext.management.processingModelDefinedByPreset')}</option>
          ) : null}
          {trimmedModel && !selectableModels.includes(trimmedModel) ? (
            <option value={trimmedModel}>{trimmedModel}</option>
          ) : null}
          {selectableModels.map((modelId) => (
            <option key={`${idPrefix}:model:${backend}:${modelId}`} value={modelId}>{modelId}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

const dimensionLabelStyle = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: '#64748b',
  marginBottom: 4,
} as const;

const selectorGroupStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 12,
} as const;

const fieldStyle = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
} as const;
