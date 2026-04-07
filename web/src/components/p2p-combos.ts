import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { COMBO_PRESETS, COMBO_SEPARATOR } from '@shared/p2p-modes.js';
import { getUserPref, saveUserPref } from '../api.js';

export const CUSTOM_COMBOS_PREF_KEY = 'p2p_custom_combos';
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
const subscribers = new Set<(combos: string[]) => void>();
let cachedCustomCombos: string[] | null = null;
let loadPromise: Promise<string[]> | null = null;

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

function publishCustomCombos(combos: string[]) {
  cachedCustomCombos = combos;
  for (const subscriber of subscribers) subscriber(combos);
}

async function loadCustomCombos(force = false): Promise<string[]> {
  if (!force && cachedCustomCombos !== null) return cachedCustomCombos;
  if (!loadPromise) {
    loadPromise = getUserPref(CUSTOM_COMBOS_PREF_KEY)
      .then((raw) => {
        if (typeof raw !== 'string') return [];
        try {
          return normalizeCustomCombos(JSON.parse(raw));
        } catch {
          return [];
        }
      })
      .catch(() => [])
      .then((combos) => {
        cachedCustomCombos = combos;
        return combos;
      })
      .finally(() => {
        loadPromise = null;
      });
  }
  return loadPromise;
}

export function useP2pCustomCombos() {
  const [customCombos, setCustomCombos] = useState<string[]>(cachedCustomCombos ?? []);

  useEffect(() => {
    subscribers.add(setCustomCombos);
    if (cachedCustomCombos !== null) setCustomCombos(cachedCustomCombos);
    void loadCustomCombos(true).then((combos) => publishCustomCombos(combos)).catch(() => {});
    return () => {
      subscribers.delete(setCustomCombos);
    };
  }, []);

  const saveCustomCombos = useCallback((combos: string[]) => {
    const normalized = normalizeCustomCombos(combos);
    publishCustomCombos(normalized);
    void saveUserPref(CUSTOM_COMBOS_PREF_KEY, JSON.stringify(normalized)).catch(() => {});
  }, []);

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
