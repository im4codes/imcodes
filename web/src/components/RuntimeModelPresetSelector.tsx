import { useTranslation } from 'react-i18next';
import type { SharedContextRuntimeBackend } from '@shared/context-types.js';
import { getCcPresetEffectiveModel, type CcPreset } from '@shared/cc-presets.js';
import { doesSharedContextBackendSupportPresets } from '@shared/shared-context-runtime-config.js';

export type RuntimeModelPresetEntry = Pick<
  CcPreset,
  'name' | 'env' | 'availableModels' | 'defaultModel'
>;

/**
 * Shared model/preset picker for memory processing and automatic supervision.
 * A preset is an endpoint/env bundle, not merely another model name, so the
 * two dimensions remain visible while selection is kept mutually consistent.
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
  const presetPinnedModel = activePreset ? (getCcPresetEffectiveModel(activePreset) ?? '') : '';
  if (modelOptions.length === 0 && (!supportsPresets || presets.length === 0)) return null;

  return (
    <div style={chipGroupStyle} data-testid={`${idPrefix}-runtime-model-preset-selector`}>
      {supportsPresets && presets.length > 0 ? (
        <div style={compactChipRowStyle}>
          <span style={inlineDimensionLabelStyle}>{t('sharedContext.management.processingPresetLabel')}</span>
          <button
            type="button"
            aria-label={`${idPrefix}:preset:none`}
            aria-pressed={!trimmedPreset}
            title={t('sharedContext.management.processingPresetNoneTitle')}
            style={neutralChipStyle(!trimmedPreset)}
            disabled={disabled}
            onClick={() => onChange({ model: trimmedModel, preset: '' })}
          >
            {t('sharedContext.management.processingPresetNone')}
          </button>
          {presets.map((entry) => {
            const active = trimmedPreset === entry.name;
            const pinned = getCcPresetEffectiveModel(entry);
            return (
              <button
                key={`${idPrefix}:preset:${entry.name}`}
                type="button"
                aria-label={`${idPrefix}:preset:${entry.name}`}
                aria-pressed={active}
                title={pinned
                  ? t('sharedContext.management.processingPresetBundleModelTitle', { model: pinned })
                  : t('sharedContext.management.processingPresetBundleTitle', { preset: entry.name })}
                style={presetChipStyle(active)}
                disabled={disabled}
                onClick={() => onChange({ model: pinned || trimmedModel, preset: entry.name })}
              >
                <span aria-hidden="true">⚙</span>
                <span>{entry.name}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div style={compactChipRowStyle}>
        <span style={inlineDimensionLabelStyle}>{t('sharedContext.management.processingModelLabel')}</span>
        {activePreset ? (
          <button
            type="button"
            aria-label={`model:${backend}:${presetPinnedModel || '(preset)'}`}
            aria-pressed={true}
            disabled
            title={t('sharedContext.management.processingModelPresetTitle')}
            style={{ ...modelChipStyle(true), cursor: 'default', opacity: 0.95 }}
          >
            {presetPinnedModel || t('sharedContext.management.processingModelDefinedByPreset')}
          </button>
        ) : modelOptions.map((modelId) => {
          const active = trimmedModel === modelId;
          return (
            <button
              key={`${idPrefix}:model:${backend}:${modelId}`}
              type="button"
              aria-label={`model:${backend}:${modelId}`}
              aria-pressed={active}
              style={modelChipStyle(active)}
              disabled={disabled}
              onClick={() => onChange({ model: modelId, preset: '' })}
            >
              {modelId}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const baseChipStyle = {
  borderRadius: 8,
  padding: '3px 8px',
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1.35,
  cursor: 'pointer',
  transition: 'background 0.15s, border-color 0.15s, color 0.15s',
} as const;

function modelChipStyle(active: boolean) {
  return {
    ...baseChipStyle,
    color: active ? '#fff' : '#cbd5e1',
    background: active ? '#0f766e' : '#1e293b',
    border: active ? '1px solid #2dd4bf' : '1px solid rgba(148,163,184,0.25)',
    fontWeight: active ? 700 : 600,
  } as const;
}

function presetChipStyle(active: boolean) {
  return {
    ...baseChipStyle,
    color: active ? '#fff' : '#c4b5fd',
    background: active ? '#7c3aed' : '#1e1b3a',
    border: active ? '1px solid #a78bfa' : '1px solid #4c1d95',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    fontWeight: active ? 700 : 600,
  } as const;
}

function neutralChipStyle(active: boolean) {
  return {
    ...baseChipStyle,
    color: active ? '#fff' : '#9ca3af',
    background: active ? '#374151' : '#1f2937',
    border: active ? '1px solid #6b7280' : '1px solid #374151',
    fontWeight: active ? 700 : 600,
  } as const;
}

const compactChipRowStyle = {
  display: 'flex',
  gap: 4,
  flexWrap: 'wrap',
  alignItems: 'center',
} as const;

const inlineDimensionLabelStyle = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: '#64748b',
  marginRight: 6,
  minWidth: 44,
  flex: '0 0 auto',
} as const;

const chipGroupStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
} as const;
