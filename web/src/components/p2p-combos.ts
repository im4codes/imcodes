import { useCallback, useMemo } from 'preact/hooks';
import { COMBO_PRESETS, COMBO_SEPARATOR } from '@shared/p2p-modes.js';
import { PREF_KEY_P2P_CUSTOM_COMBOS } from '../constants/prefs.js';
import { parseJsonValue, usePref } from '../hooks/usePref.js';

export const CUSTOM_COMBOS_PREF_KEY = PREF_KEY_P2P_CUSTOM_COMBOS;
export const BUILDER_MODES = ['audit', 'review', 'plan', 'brainstorm', 'discuss'] as const;
export const MAX_CUSTOM_COMBOS = 5;

const MODE_COLORS: Record<string, string> = {
  config: '#94a3b8',
  audit: '#f59e0b',
  review: '#3b82f6',
  plan: '#06b6d4',
  brainstorm: '#a78bfa',
  discuss: '#22c55e',
};

const presetKeys = new Set(COMBO_PRESETS.map((combo) => combo.key));

export function comboModeColor(key: string): string {
  const last = key.split(COMBO_SEPARATOR).pop()?.trim();
  return last ? (MODE_COLORS[last] ?? '#94a3b8') : '#94a3b8';
}

export function comboModeLabel(key: string, t: (key: string) => string): string {
  return key
    .split(COMBO_SEPARATOR)
    .map((mode) => t(`p2p.mode_${mode.trim()}`))
    .join('→');
}

export function normalizeCustomCombos(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const combos: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const key = entry.trim();
    if (!key || seen.has(key) || presetKeys.has(key)) continue;
    seen.add(key);
    combos.push(key);
    if (combos.length >= MAX_CUSTOM_COMBOS) break;
  }
  return combos;
}

function parseCustomCombos(raw: unknown): string[] {
  return parseJsonValue<string[]>(raw, normalizeCustomCombos) ?? [];
}

export function useP2pCustomCombos() {
  const customCombosPref = usePref<string[]>(PREF_KEY_P2P_CUSTOM_COMBOS, {
    parse: parseCustomCombos,
    serialize: (value) => JSON.stringify(normalizeCustomCombos(value)),
  });
  const customCombos = customCombosPref.value ?? [];

  const saveCustomCombos = useCallback((combos: string[]) => {
    void customCombosPref.save(normalizeCustomCombos(combos)).catch(() => {});
  }, [customCombosPref]);

  const allCombos = useMemo(() => ({
    presets: COMBO_PRESETS,
    custom: customCombos,
  }), [customCombos]);

  return {
    customCombos,
    saveCustomCombos,
    allCombos,
  };
}
