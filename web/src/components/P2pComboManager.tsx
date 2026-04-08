import { useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { COMBO_PRESETS, COMBO_SEPARATOR } from '@shared/p2p-modes.js';
import { BUILDER_MODES, MAX_CUSTOM_COMBOS, comboModeColor, comboModeLabel } from './p2p-combos.js';

interface Props {
  customCombos: string[];
  onCustomCombosChange: (combos: string[]) => void;
  onSelectCombo?: (key: string) => void;
  highlightedComboKey?: string | null;
  onHoverCombo?: (key: string) => void;
  compact?: boolean;
}

const chipStyle: Record<string, string | number> = {
  padding: '3px 10px',
  borderRadius: 6,
  border: '1px solid #475569',
  background: '#1e293b',
  color: '#e2e8f0',
  fontSize: 12,
  cursor: 'pointer',
};

const compactChipStyle: Record<string, string | number> = {
  ...chipStyle,
  fontSize: 10,
  padding: '2px 6px',
};

const builderRowStyle: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  flexWrap: 'wrap',
};

const sectionStyle: Record<string, string | number> = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const sectionLabelStyle: Record<string, string | number> = {
  fontSize: 11,
  fontWeight: 700,
  color: '#94a3b8',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const emptyStateStyle: Record<string, string | number> = {
  color: '#64748b',
  fontSize: 12,
};

function comboChipStyle(color: string, compact: boolean, highlighted: boolean): Record<string, string | number> {
  const base = compact ? compactChipStyle : chipStyle;
  if (!highlighted) return base;
  return {
    ...base,
    borderColor: color,
    color,
    boxShadow: `0 0 0 1px ${color}55, 0 0 18px ${color}22`,
  };
}

export function P2pComboManager({
  customCombos,
  onCustomCombosChange,
  onSelectCombo,
  highlightedComboKey,
  onHoverCombo,
  compact = false,
}: Props) {
  const { t } = useTranslation();
  const [buildingCombo, setBuildingCombo] = useState<string[]>([]);

  const canAddMore = customCombos.length < MAX_CUSTOM_COMBOS;
  const buildingKey = buildingCombo.join(COMBO_SEPARATOR);
  const buildingColor = comboModeColor(buildingKey);
  const canSaveBuilding = buildingCombo.length >= 2
    && canAddMore
    && !customCombos.includes(buildingKey)
    && !COMBO_PRESETS.some((preset) => preset.key === buildingKey);

  const allCustomComboKeys = useMemo(() => new Set(customCombos), [customCombos]);

  const saveBuildingCombo = () => {
    if (!canSaveBuilding) return;
    onCustomCombosChange([...customCombos, buildingKey]);
    setBuildingCombo([]);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 8 : 10 }}>
      <div style={sectionStyle}>
        <div style={sectionLabelStyle}>{t('p2p.combo_presets')}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {COMBO_PRESETS.map((combo) => {
            const color = comboModeColor(combo.key);
            return (
              <button
                key={combo.key}
                type="button"
                style={comboChipStyle(color, compact, highlightedComboKey === combo.key)}
                onClick={() => onSelectCombo?.(combo.key)}
                onMouseEnter={() => onHoverCombo?.(combo.key)}
              >
                {comboModeLabel(combo.key, t)}
              </button>
            );
          })}
        </div>
      </div>

      <div style={sectionStyle}>
        <div style={sectionLabelStyle}>{t('p2p.combo_custom')}</div>
        {customCombos.length === 0 ? (
          <div style={emptyStateStyle}>{t('p2p.combo_custom_empty')}</div>
        ) : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {customCombos.map((key) => {
              const color = comboModeColor(key);
              const label = comboModeLabel(key, t);
              const base = compact ? compactChipStyle : chipStyle;
              return (
                <span key={key} style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <button
                    type="button"
                    style={{
                      ...comboChipStyle(color, compact, highlightedComboKey === key),
                      borderRadius: '6px 0 0 6px',
                    }}
                    onClick={() => onSelectCombo?.(key)}
                    onMouseEnter={() => onHoverCombo?.(key)}
                  >
                    {label}
                  </button>
                  <button
                    type="button"
                    style={{
                      ...base,
                      borderRadius: '0 6px 6px 0',
                      borderLeft: 'none',
                      padding: compact ? '2px 4px' : '3px 6px',
                      color: '#64748b',
                    }}
                    title={t('common.delete')}
                    onClick={() => onCustomCombosChange(customCombos.filter((combo) => combo !== key))}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}
      </div>

      {(canAddMore || buildingCombo.length > 0) && (
        <div style={sectionStyle}>
          <div style={sectionLabelStyle}>{t('p2p.combo_builder')}</div>
          <div style={builderRowStyle}>
            {buildingCombo.length > 0 && (
              <span style={{ fontSize: compact ? 10 : 12, color: buildingColor, fontWeight: 600 }}>
                {buildingCombo.map((mode) => t(`p2p.mode_${mode}`)).join('→')}
              </span>
            )}
            {buildingCombo.length > 0 && (
              <button
                type="button"
                style={{
                  ...(compact ? compactChipStyle : chipStyle),
                  padding: compact ? '1px 4px' : '2px 6px',
                  color: '#64748b',
                }}
                onClick={() => setBuildingCombo((combo) => combo.slice(0, -1))}
              >
                ←
              </button>
            )}
            {buildingCombo.length >= 2 && (
              <button
                type="button"
                style={{
                  ...(compact ? compactChipStyle : chipStyle),
                  padding: compact ? '1px 6px' : '2px 8px',
                  borderColor: canSaveBuilding ? '#22c55e' : '#475569',
                  color: canSaveBuilding ? '#22c55e' : '#64748b',
                  cursor: canSaveBuilding ? 'pointer' : 'not-allowed',
                }}
                disabled={!canSaveBuilding}
                onClick={saveBuildingCombo}
              >
                ✓
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {BUILDER_MODES.map((mode) => {
              const previewKey = buildingCombo.length > 0 ? `${buildingKey}${COMBO_SEPARATOR}${mode}` : mode;
              const alreadyExists = allCustomComboKeys.has(previewKey) || COMBO_PRESETS.some((preset) => preset.key === previewKey);
              return (
                <button
                  key={mode}
                  type="button"
                  style={{
                    ...(compact ? compactChipStyle : chipStyle),
                    padding: compact ? '1px 6px' : '2px 8px',
                    color: alreadyExists ? '#94a3b8' : chipStyle.color,
                  }}
                  onClick={() => setBuildingCombo((combo) => [...combo, mode])}
                >
                  +{t(`p2p.mode_${mode}`)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
