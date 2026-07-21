import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { isValidP2pComboPipeline } from '@shared/p2p-modes.js';
import { PREF_KEY_OPENSPEC_AUTO_DELIVER_AUTO_COMMIT_PUSH } from '../constants/prefs.js';
import { parseBooleanish, usePref } from '../hooks/usePref.js';
import {
  OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET,
  OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO,
  OPENSPEC_AUTO_DELIVER_PRESETS,
  OPENSPEC_AUTO_DELIVER_ROUND_BOUNDS,
  isOpenSpecAutoDeliverActiveProjection,
  isOpenSpecAutoDeliverTerminalStatus,
  materializedPresetLimits,
  type OpenSpecAutoDeliverModuleScore,
  type OpenSpecAutoDeliverPresetId,
  type OpenSpecAutoDeliverProjection,
} from '../openspec-auto-deliver.js';
import { useNowTicker } from '../hooks/useNowTicker.js';
import { comboModeLabel, useP2pCustomCombos } from './p2p-combos.js';

export interface OpenSpecAutoDeliverLauncherProps {
  changeName: string | null;
  open: boolean;
  disabled?: boolean;
  conflictProjection?: OpenSpecAutoDeliverProjection | null;
  launchPending?: boolean;
  error?: string | null;
  onClose: () => void;
  onLaunch: (changeName: string, presetId: OpenSpecAutoDeliverPresetId, options: {
    selectedTeamComboId: string;
    materializedLimits: ReturnType<typeof materializedPresetLimits>;
    locale?: string;
    autoCommitPush: boolean;
  }) => void;
  onViewCurrent?: () => void;
}

export interface OpenSpecAutoDeliverRunBarProps {
  projection: OpenSpecAutoDeliverProjection;
  stopPending?: boolean;
  compact?: boolean;
  onView: () => void;
  onStop: () => void;
  onToggleCompact?: () => void;
  onHide?: () => void;
}

export interface OpenSpecAutoDeliverDetailsPanelProps {
  projection: OpenSpecAutoDeliverProjection | null;
  stopPending?: boolean;
  continuePending?: boolean;
  embedded?: boolean;
  showActions?: boolean;
  onClose: () => void;
  onStop: () => void;
  onContinue: () => void;
}

type TranslationFn = (key: string, opts?: Record<string, unknown>) => string;

export type ProgressMetricKind = 'overall' | 'round' | 'tasks' | 'prompts' | 'stage';

export interface ProgressMetric {
  current: number;
  total: number;
  percent: number;
  kind: ProgressMetricKind;
}

export interface OpenSpecAutoDeliverProgressMetrics {
  overall: ProgressMetric;
  currentStage: ProgressMetric;
}

const OVERALL_PROGRESS_PHASES = [
  'proposed',
  'spec_audit_repair',
  'implementation_task_loop',
  'implementation_audit_repair',
  'commit_push',
] as const;
const OVERALL_PROGRESS_TOTAL = OVERALL_PROGRESS_PHASES.length + 1;
const DETAILS_SIZE_STORAGE_KEY = 'rcc_openspec_auto_deliver_details_size';
const DETAILS_DEFAULT_SIZE = { width: 920, height: 780 };
const DETAILS_MIN_SIZE = { width: 420, height: 360 };

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function desktopDetailsMaxSize(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 1200, height: 900 };
  return {
    width: Math.max(DETAILS_MIN_SIZE.width, window.innerWidth - 32),
    height: Math.max(DETAILS_MIN_SIZE.height, window.innerHeight - 32),
  };
}

function readDetailsSizePreference(): { width: number; height: number } {
  const maxSize = desktopDetailsMaxSize();
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(DETAILS_SIZE_STORAGE_KEY) : null;
    const parsed = raw ? JSON.parse(raw) as { width?: unknown; height?: unknown } : null;
    return {
      width: clampNumber(parsed?.width, DETAILS_MIN_SIZE.width, maxSize.width, DETAILS_DEFAULT_SIZE.width),
      height: clampNumber(parsed?.height, DETAILS_MIN_SIZE.height, maxSize.height, DETAILS_DEFAULT_SIZE.height),
    };
  } catch {
    return {
      width: Math.min(DETAILS_DEFAULT_SIZE.width, maxSize.width),
      height: Math.min(DETAILS_DEFAULT_SIZE.height, maxSize.height),
    };
  }
}

function isDesktopDetailsViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return !window.matchMedia?.('(max-width: 768px)').matches;
}

function writeDetailsSizePreference(size: { width: number; height: number }): void {
  try {
    localStorage.setItem(DETAILS_SIZE_STORAGE_KEY, JSON.stringify(size));
  } catch { /* ignore */ }
}

function formatElapsed(ms: number): string {
  const safe = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function stageKey(stage: string): string {
  return `openspec.auto.stage.${stage}`;
}

function statusKey(status: string): string {
  return `openspec.auto.status.${status}`;
}

function projectionStatus(projection: OpenSpecAutoDeliverProjection): string {
  return typeof projection.status === 'string' && projection.status ? projection.status : 'unknown';
}

function projectionStage(projection: OpenSpecAutoDeliverProjection): string {
  return typeof projection.stage === 'string' && projection.stage ? projection.stage : 'unknown';
}

function projectionTitle(projection: OpenSpecAutoDeliverProjection): string {
  return projection.visibility === 'conflict' ? projection.owningMainSessionName : projection.changeName;
}

function taskProgressText(projection: OpenSpecAutoDeliverProjection, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const stats = projection.taskStats;
  if (!stats || stats.total <= 0) return t('openspec.auto.tasks_unknown');
  return t('openspec.auto.tasks_progress', { checked: stats.checked, total: stats.total });
}

function clampProgressValue(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(total, value));
}

function progressMetric(current: number, total: number, kind: ProgressMetricKind): ProgressMetric {
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 1;
  const safeCurrent = clampProgressValue(current, safeTotal);
  return {
    current: safeCurrent,
    total: safeTotal,
    percent: Math.round((safeCurrent / safeTotal) * 100),
    kind,
  };
}

function counterPairMetric(pair: { current: number; total: number } | undefined): ProgressMetric {
  if (pair && pair.total > 0) return progressMetric(pair.current, pair.total, 'round');
  return progressMetric(0, 1, 'round');
}

export function computeOpenSpecAutoDeliverProgress(projection: OpenSpecAutoDeliverProjection): OpenSpecAutoDeliverProgressMetrics {
  const status = projectionStatus(projection);
  const stage = projectionStage(projection);
  const terminal = isOpenSpecAutoDeliverTerminalStatus(status);
  const phaseIndex = OVERALL_PROGRESS_PHASES.indexOf(stage as typeof OVERALL_PROGRESS_PHASES[number]);
  const overallCurrent = terminal
    ? OVERALL_PROGRESS_TOTAL
    : phaseIndex >= 0 ? phaseIndex + 1 : 1;
  let currentStage = progressMetric(0, 1, 'stage');

  if (terminal) {
    currentStage = progressMetric(1, 1, 'stage');
  } else if (stage === 'spec_audit_repair') {
    currentStage = counterPairMetric(projection.specAuditRound);
  } else if (stage === 'implementation_audit_repair') {
    currentStage = counterPairMetric(projection.implementationAuditRound);
  } else if (stage === 'implementation_task_loop') {
    const stats = projection.taskStats;
    if (stats && stats.total > 0) {
      currentStage = progressMetric(stats.checked, stats.total, 'tasks');
    } else if (projection.materializedLimits?.maxImplementationPrompts && projection.materializedLimits.maxImplementationPrompts > 0) {
      currentStage = progressMetric(projection.implementationPromptCount ?? 0, projection.materializedLimits.maxImplementationPrompts, 'prompts');
    }
  } else if (stage === 'commit_push') {
    currentStage = progressMetric(0, 1, 'stage');
  }

  return {
    overall: progressMetric(overallCurrent, OVERALL_PROGRESS_TOTAL, 'overall'),
    currentStage,
  };
}

function humanizeAutoDeliverCode(value: string): string {
  if (/\s/.test(value) && !value.includes('_')) return value;
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function translateAutoDeliverReason(value: string | null | undefined, t: (key: string, opts?: Record<string, unknown>) => string): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('quality_gate_low_score:')) {
    const modules = value.slice('quality_gate_low_score:'.length).replace(/,/g, ', ');
    const key = 'openspec.auto.reason.quality_gate_low_score';
    const fallback = `Quality gate stopped for low module score: ${modules}`;
    const translated = t(key, {
      modules,
      defaultValue: fallback,
    });
    return translated === key ? fallback : translated;
  }
  if (value.startsWith('auto_commit_push_failed:')) {
    const detail = value.slice('auto_commit_push_failed:'.length);
    const key = 'openspec.auto.reason.auto_commit_push_failed';
    const fallback = `Auto commit/push failed: ${detail}`;
    const translated = t(key, {
      detail,
      defaultValue: fallback,
    });
    return translated === key ? fallback : translated;
  }
  if (value.startsWith('auto_commit_push_git_status_failed:')) {
    const detail = value.slice('auto_commit_push_git_status_failed:'.length);
    const key = 'openspec.auto.reason.auto_commit_push_git_status_failed';
    const fallback = `Auto commit/push could not read git status: ${detail}`;
    const translated = t(key, {
      detail,
      defaultValue: fallback,
    });
    return translated === key ? fallback : translated;
  }
  if (value.startsWith('auto_commit_push_preexisting_changes:')) {
    const files = value.slice('auto_commit_push_preexisting_changes:'.length).replace(/,/g, ', ');
    const key = 'openspec.auto.reason.auto_commit_push_preexisting_changes';
    const fallback = `Auto commit/push skipped because product files were already dirty before launch: ${files}`;
    const translated = t(key, {
      files,
      defaultValue: fallback,
    });
    return translated === key ? fallback : translated;
  }
  if (value.startsWith('auto_commit_push_incomplete:')) {
    const files = value.slice('auto_commit_push_incomplete:'.length).replace(/,/g, ', ');
    const key = 'openspec.auto.reason.auto_commit_push_incomplete';
    const fallback = `Auto commit/push needs human review because product files are still dirty after the commit/push step: ${files}`;
    const translated = t(key, {
      files,
      defaultValue: fallback,
    });
    return translated === key ? fallback : translated;
  }
  if (value.startsWith('auto_commit_push_not_pushed:')) {
    const count = value.slice('auto_commit_push_not_pushed:'.length);
    const key = 'openspec.auto.reason.auto_commit_push_not_pushed';
    const fallback = `Auto commit/push needs human review because ${count} commit(s) are still ahead of upstream.`;
    const translated = t(key, {
      count,
      defaultValue: fallback,
    });
    return translated === key ? fallback : translated;
  }
  if (value.startsWith('auto_commit_push_forbidden_paths:')) {
    const files = value.slice('auto_commit_push_forbidden_paths:'.length).replace(/,/g, ', ');
    const key = 'openspec.auto.reason.auto_commit_push_forbidden_paths';
    const fallback = `Auto commit/push needs human review because local planning files were committed: ${files}`;
    const translated = t(key, {
      files,
      defaultValue: fallback,
    });
    return translated === key ? fallback : translated;
  }
  if (value.startsWith('auto_commit_push_unexpected_files:')) {
    const files = value.slice('auto_commit_push_unexpected_files:'.length).replace(/,/g, ', ');
    const key = 'openspec.auto.reason.auto_commit_push_unexpected_files';
    const fallback = `Auto commit/push needs human review because the commit included files outside the current Auto Deliver change: ${files}`;
    const translated = t(key, {
      files,
      defaultValue: fallback,
    });
    return translated === key ? fallback : translated;
  }
  const key = `openspec.auto.reason.${value}`;
  const fallback = humanizeAutoDeliverCode(value);
  const translated = t(key, { defaultValue: fallback });
  return translated === key ? fallback : translated;
}

export function translateAutoDeliverMessage(value: string | null | undefined, t: TranslationFn): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('spec_repair_prompt_dispatched:')) {
    const reason = value.slice('spec_repair_prompt_dispatched:'.length);
    const reasonText = translateAutoDeliverReason(reason, t) ?? humanizeAutoDeliverCode(reason);
    const key = 'openspec.auto.lifecycle.spec_repair_prompt_dispatched';
    const fallback = `Spec repair prompt sent from audit findings: ${reasonText}`;
    const translated = t(key, { reason: reasonText, defaultValue: fallback });
    return translated === key ? fallback : translated;
  }
  if (value.startsWith('implementation_repair_prompt_dispatched:')) {
    const reason = value.slice('implementation_repair_prompt_dispatched:'.length);
    const reasonText = translateAutoDeliverReason(reason, t) ?? humanizeAutoDeliverCode(reason);
    const key = 'openspec.auto.lifecycle.implementation_repair_prompt_dispatched';
    const fallback = `Implementation repair prompt sent from audit findings: ${reasonText}`;
    const translated = t(key, { reason: reasonText, defaultValue: fallback });
    return translated === key ? fallback : translated;
  }
  const key = `openspec.auto.lifecycle.${value}`;
  const fallback = `__missing_${key}__`;
  const translated = t(key, { defaultValue: fallback });
  if (translated !== fallback && translated !== key && translated !== value) return translated;
  return translateAutoDeliverReason(value, t);
}

function uncheckedTaskLabels(projection: OpenSpecAutoDeliverProjection): string[] {
  if (projection.taskStats?.uncheckedLabels?.length) return projection.taskStats.uncheckedLabels;
  return projection.taskStats?.items
    ?.filter((item) => !item.checked)
    .map((item) => item.label)
    .filter(Boolean)
    ?? [];
}

function formatRoundPair(pair: { current: number; total: number } | undefined, fallback?: number): string | number | undefined {
  if (pair) return `${pair.current}/${pair.total}`;
  return fallback;
}

function formatEvidenceSummary(summary: string | undefined, t: (key: string, opts?: Record<string, unknown>) => string): string | undefined {
  if (!summary) return undefined;
  return translateAutoDeliverMessage(summary, t);
}

function projectionElapsedMs(projection: OpenSpecAutoDeliverProjection, now: number): number {
  if (projection.visibility !== 'full') return 0;
  if (typeof projection.elapsedMs === 'number' && Number.isFinite(projection.elapsedMs)) return projection.elapsedMs;
  if (typeof projection.startedAt === 'number' && Number.isFinite(projection.startedAt)) return now - projection.startedAt;
  return 0;
}

function progressPercentText(metric: ProgressMetric, t: TranslationFn): string {
  return t('openspec.auto.progress_percent', { percent: metric.percent });
}

function progressCountText(metric: ProgressMetric, t: TranslationFn): string {
  return t('openspec.auto.progress_count', { current: metric.current, total: metric.total });
}

function currentStageProgressText(projection: OpenSpecAutoDeliverProjection, metric: ProgressMetric, t: TranslationFn): string {
  if (metric.kind === 'tasks') return taskProgressText(projection, t);
  if (metric.kind === 'prompts') {
    return t('openspec.auto.prompt_progress', { count: metric.current, total: metric.total });
  }
  if (metric.kind === 'round') return progressCountText(metric, t);
  const stage = projectionStage(projection);
  return t(stageKey(stage), { defaultValue: stage });
}

function progressLineValue(primary: string, metric: ProgressMetric, t: TranslationFn): string {
  return `${primary} · ${progressPercentText(metric, t)}`;
}

function ProgressLine({ label, value, percent }: { label: string; value: string; percent: number }) {
  return (
    <div class="discussions-progress-line">
      <div class="discussions-progress-line-head">
        <span class="discussions-progress-line-label">{label}</span>
        <span class="discussions-progress-line-value">{value}</span>
      </div>
      <div class="discussions-progress-bar openspec-auto-progressbar">
        <div
          class="discussions-progress-fill openspec-auto-progressfill"
          style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      </div>
    </div>
  );
}

export function OpenSpecAutoDeliverLauncher({
  changeName,
  open,
  disabled = false,
  conflictProjection,
  launchPending = false,
  error,
  onClose,
  onLaunch,
  onViewCurrent,
}: OpenSpecAutoDeliverLauncherProps) {
  const { t, i18n } = useTranslation();
  const autoCommitPushPref = usePref<boolean>(PREF_KEY_OPENSPEC_AUTO_DELIVER_AUTO_COMMIT_PUSH, { parse: parseBooleanish });
  const autoCommitPush = autoCommitPushPref.value === true;
  const [presetId, setPresetId] = useState<OpenSpecAutoDeliverPresetId>(OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET);
  const defaultLimits = materializedPresetLimits(OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET);
  const [specRounds, setSpecRounds] = useState<number>(defaultLimits.specAuditRepairRounds);
  const [implementationRounds, setImplementationRounds] = useState<number>(defaultLimits.implementationAuditRepairRounds);
  const [maxImplementationPrompts, setMaxImplementationPrompts] = useState<number>(defaultLimits.maxImplementationPrompts);
  const [maxElapsedMinutes, setMaxElapsedMinutes] = useState<number>(defaultLimits.maxElapsedMinutes);
  const [selectedTeamComboId, setSelectedTeamComboId] = useState<string>(OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO);
  const { allCombos } = useP2pCustomCombos();
  const hasConflict = isOpenSpecAutoDeliverActiveProjection(conflictProjection);
  const comboOptions = useMemo(() => {
    const options: Array<{ key: string; label: string; custom?: boolean }> = [
      ...allCombos.presets.map((combo) => ({
        key: combo.key,
        label: comboModeLabel(combo.key, t),
      })),
      ...allCombos.custom.map((key) => ({ key, label: comboModeLabel(key, t), custom: true })),
    ];
    const seen = new Set<string>();
    return options.filter((option) => {
      if (seen.has(option.key)) return false;
      seen.add(option.key);
      return true;
    });
  }, [allCombos]);

  useEffect(() => {
    if (!open) return;
    const defaults = materializedPresetLimits(OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET);
    setPresetId(OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET);
    setSpecRounds(defaults.specAuditRepairRounds);
    setImplementationRounds(defaults.implementationAuditRepairRounds);
    setMaxImplementationPrompts(defaults.maxImplementationPrompts);
    setMaxElapsedMinutes(defaults.maxElapsedMinutes);
    setSelectedTeamComboId(OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO);
  }, [open, changeName]);
  const handleAutoCommitPushChange = useCallback((event: Event) => {
    const checked = (event.target as HTMLInputElement).checked;
    autoCommitPushPref.set(checked);
    void autoCommitPushPref.save(checked).catch(() => {});
  }, [autoCommitPushPref]);

  if (!open) return null;

  const selectedLimits = {
    specAuditRepairRounds: specRounds,
    implementationAuditRepairRounds: implementationRounds,
    maxImplementationPrompts,
    maxElapsedMinutes,
  };
  const invalidRounds = !Number.isInteger(specRounds)
    || specRounds < OPENSPEC_AUTO_DELIVER_ROUND_BOUNDS.specMin
    || specRounds > OPENSPEC_AUTO_DELIVER_ROUND_BOUNDS.specMax
    || !Number.isInteger(implementationRounds)
    || implementationRounds < OPENSPEC_AUTO_DELIVER_ROUND_BOUNDS.implementationMin
    || implementationRounds > OPENSPEC_AUTO_DELIVER_ROUND_BOUNDS.implementationMax;
  const incompatibleCombo = !isValidP2pComboPipeline(selectedTeamComboId);
  const validationError = !changeName
    ? 'openspec.auto.error.missing_change'
    : invalidRounds
      ? 'openspec.auto.error.invalid_rounds'
      : incompatibleCombo
        ? 'openspec.auto.error.combo_unsupported'
      : error;
  const handleTeamComboChange = (event: Event) => {
    setSelectedTeamComboId((event.target as HTMLSelectElement).value);
  };
  return (
    <div class="openspec-auto-launcher" data-testid="openspec-auto-launcher">
      <div class="openspec-auto-launcher-head">
        <div>
          <div class="openspec-auto-kicker">{t('openspec.auto.launcher_title')}</div>
          <div class="openspec-auto-change">{changeName ?? t('openspec.auto.no_change')}</div>
        </div>
        <button class="openspec-auto-icon-btn" type="button" onClick={onClose} aria-label={t('common.close')}>
          ×
        </button>
      </div>
      {hasConflict && conflictProjection ? (
        <div class="openspec-auto-warning" data-testid="openspec-auto-conflict">
          <div>
            {t('openspec.auto.conflict_active', {
              change: conflictProjection.visibility === 'full'
                ? conflictProjection.changeName
                : conflictProjection.owningMainSessionName,
            })}
          </div>
          {error && <div class="openspec-auto-warning-subtle">{error.includes('.') ? t(error) : error}</div>}
          <button class="btn btn-secondary openspec-auto-mini-btn" type="button" onClick={onViewCurrent}>
            {t('openspec.auto.view')}
          </button>
        </div>
      ) : (
        <>
          <div class="openspec-auto-preset-grid">
            {OPENSPEC_AUTO_DELIVER_PRESETS.map((preset) => {
              const active = preset.id === presetId;
              return (
                <button
                  key={preset.id}
                  type="button"
                  class={`openspec-auto-preset ${active ? 'openspec-auto-preset-active' : ''}`}
                  data-testid={`openspec-auto-preset-${preset.id}`}
                  onClick={() => {
                    setPresetId(preset.id);
                    setSpecRounds(preset.specAuditRepairRounds);
                    setImplementationRounds(preset.implementationAuditRepairRounds);
                    setMaxImplementationPrompts(preset.maxImplementationPrompts);
                    setMaxElapsedMinutes(preset.maxElapsedMinutes);
                  }}
                >
                  <span>{t(preset.labelKey)}</span>
                  <small>
                    {t('openspec.auto.preset_limits', {
                      spec: preset.specAuditRepairRounds,
                      impl: preset.implementationAuditRepairRounds,
                    })}
                  </small>
                </button>
              );
            })}
          </div>
          <div class="openspec-auto-controls-grid">
            <label class="openspec-auto-field">
              <span>{t('openspec.auto.spec_rounds')}</span>
              <input
                type="number"
                min={OPENSPEC_AUTO_DELIVER_ROUND_BOUNDS.specMin}
                max={OPENSPEC_AUTO_DELIVER_ROUND_BOUNDS.specMax}
                value={specRounds}
                onInput={(event) => {
                  const customLimits = materializedPresetLimits('custom');
                  setPresetId('custom');
                  setMaxImplementationPrompts(customLimits.maxImplementationPrompts);
                  setMaxElapsedMinutes(customLimits.maxElapsedMinutes);
                  setSpecRounds(Number((event.target as HTMLInputElement).value));
                }}
              />
            </label>
            <label class="openspec-auto-field">
              <span>{t('openspec.auto.impl_rounds')}</span>
              <input
                type="number"
                min={OPENSPEC_AUTO_DELIVER_ROUND_BOUNDS.implementationMin}
                max={OPENSPEC_AUTO_DELIVER_ROUND_BOUNDS.implementationMax}
                value={implementationRounds}
                onInput={(event) => {
                  const customLimits = materializedPresetLimits('custom');
                  setPresetId('custom');
                  setMaxImplementationPrompts(customLimits.maxImplementationPrompts);
                  setMaxElapsedMinutes(customLimits.maxElapsedMinutes);
                  setImplementationRounds(Number((event.target as HTMLInputElement).value));
                }}
              />
            </label>
            <label class="openspec-auto-field openspec-auto-field-wide">
              <span>{t('openspec.auto.team_combo')}</span>
              <select value={selectedTeamComboId} onInput={handleTeamComboChange} onChange={handleTeamComboChange}>
                {comboOptions.map((combo) => (
                  <option key={combo.key} value={combo.key}>
                    {combo.custom ? `${combo.label} (${t('openspec.auto.custom')})` : combo.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label class="openspec-auto-checkbox">
            <input
              type="checkbox"
              checked={autoCommitPush}
              onChange={handleAutoCommitPushChange}
              aria-label={t('openspec.auto.auto_commit_push')}
            />
            <span>
              <strong>{t('openspec.auto.auto_commit_push')}</strong>
              <small>{t('openspec.auto.auto_commit_push_help')}</small>
            </span>
          </label>
          <div class="openspec-auto-launcher-meta">
            {t('openspec.auto.materialized_limits', {
              spec: selectedLimits.specAuditRepairRounds,
              impl: selectedLimits.implementationAuditRepairRounds,
            })}
          </div>
          {validationError && (
            <div class="openspec-auto-error" data-testid="openspec-auto-error">
              {validationError.includes('.') ? t(validationError) : validationError}
            </div>
          )}
          <button
            class="btn btn-primary openspec-auto-start-btn"
            type="button"
            disabled={disabled || !changeName || launchPending || invalidRounds || incompatibleCombo}
            onClick={() => {
              if (disabled || !changeName || launchPending || invalidRounds || incompatibleCombo) return;
              const locale = i18n?.language;
              onLaunch(changeName, presetId, {
                selectedTeamComboId,
                materializedLimits: selectedLimits,
                ...(locale ? { locale } : {}),
                autoCommitPush,
              });
            }}
          >
            {launchPending ? t('common.starting') : t('openspec.auto.start')}
          </button>
        </>
      )}
    </div>
  );
}

export function OpenSpecAutoDeliverRunBar({
  projection,
  stopPending = false,
  compact = false,
  onView,
  onStop,
  onToggleCompact,
  onHide,
}: OpenSpecAutoDeliverRunBarProps) {
  const { t } = useTranslation();
  const status = projectionStatus(projection);
  const stage = projectionStage(projection);
  const active = !isOpenSpecAutoDeliverTerminalStatus(status);
  const now = useNowTicker(active);
  const elapsed = formatElapsed(projectionElapsedMs(projection, now));
  const stageLabel = t(stageKey(stage), stage);
  const taskText = taskProgressText(projection, t);
  const canStop = projection.canStop !== false && active;
  const statusLabel = t(statusKey(status), status);
  const title = projectionTitle(projection);
  const progress = computeOpenSpecAutoDeliverProgress(projection);
  const overallText = progressLineValue(progressCountText(progress.overall, t), progress.overall, t);
  const currentStageText = progressLineValue(currentStageProgressText(projection, progress.currentStage, t), progress.currentStage, t);
  const latestMessage = translateAutoDeliverMessage(projection.recentFinding, t);

  if (compact) {
    return (
      <div class="openspec-auto-runbar openspec-auto-runbar-compact discussions-progress-card" data-testid="openspec-auto-runbar">
        <div class="discussions-progress-head openspec-auto-runbar-head">
          <div class="discussions-progress-titlewrap">
            <div class="discussions-progress-kicker">{t('openspec.auto.kicker')}</div>
            <div class="discussions-progress-title">{title}</div>
          </div>
          <span class="discussions-progress-badge discussions-progress-badge-phase">{stageLabel}</span>
          <span class="discussions-progress-badge">{overallText}</span>
          {latestMessage && <span class="discussions-progress-badge">{latestMessage}</span>}
          <button class="discussions-progress-stop openspec-auto-view-btn" type="button" onClick={onView}>
            {t('openspec.auto.view')}
          </button>
          {onToggleCompact && (
            <button class="discussions-progress-stop openspec-auto-view-btn" type="button" onClick={onToggleCompact}>
              {t('openspec.auto.expand')}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div class="openspec-auto-runbar discussions-progress-card" data-testid="openspec-auto-runbar">
      <div class="discussions-progress-head openspec-auto-runbar-head">
        <div class="discussions-progress-titlewrap">
          <div class="discussions-progress-kicker">{t('openspec.auto.kicker')}</div>
          <div class="discussions-progress-title">{title}</div>
        </div>
        <span class="p2p-timer p2p-timer-total">{elapsed}</span>
        <button class="discussions-progress-stop openspec-auto-view-btn" type="button" onClick={onView}>
          {t('openspec.auto.view')}
        </button>
        {onToggleCompact && (
          <button class="discussions-progress-stop openspec-auto-view-btn" type="button" onClick={onToggleCompact}>
            {t('openspec.auto.compact')}
          </button>
        )}
        {onHide && (
          <button class="discussions-progress-stop openspec-auto-view-btn" type="button" onClick={onHide}>
            {t('common.hide')}
          </button>
        )}
        {canStop && (
          <button class="discussions-progress-stop" type="button" disabled={stopPending} onClick={onStop}>
            {stopPending ? t('openspec.auto.stopping') : t('openspec.auto.stop')}
          </button>
        )}
      </div>
      <div class="discussions-progress-meta">
        <span class="discussions-progress-badge discussions-progress-badge-mode">
          {statusLabel}
        </span>
        <span class="discussions-progress-badge discussions-progress-badge-phase">{stageLabel}</span>
        <span class="discussions-progress-badge">{taskText}</span>
        {projection.implementationPromptCount != null && (
          <span class="discussions-progress-badge">
            {t('openspec.auto.prompt_count', { count: projection.implementationPromptCount })}
          </span>
        )}
      </div>
      <div class="discussions-progress-lines">
        <ProgressLine
          label={t('openspec.auto.overall_progress')}
          value={overallText}
          percent={progress.overall.percent}
        />
        <ProgressLine
          label={t('openspec.auto.current_stage_progress')}
          value={currentStageText}
          percent={progress.currentStage.percent}
        />
      </div>
      {latestMessage && (
        <div class="openspec-auto-finding">
          <span class="openspec-auto-finding-label">{t('openspec.auto.latest_message')}</span>
          <span>{latestMessage}</span>
        </div>
      )}
    </div>
  );
}


type AutoDeliverScoreItem = Pick<OpenSpecAutoDeliverModuleScore, 'module' | 'score' | 'maxScore' | 'max_score' | 'summary'>;

function scoreMax(score?: AutoDeliverScoreItem | null): number {
  const max = score?.maxScore ?? score?.max_score ?? 10;
  return Number.isFinite(max) && max > 0 ? max : 10;
}

function scoreText(score?: AutoDeliverScoreItem | null): string {
  if (!score) return '—';
  return `${score.score}/${scoreMax(score)}`;
}

function scoreRating(score?: AutoDeliverScoreItem | null): number {
  if (!score) return 0;
  const max = scoreMax(score);
  return Math.max(0, Math.min(5, Math.round((score.score / max) * 5)));
}

function findScoreByModule(scores: AutoDeliverScoreItem[], candidates: string[]): AutoDeliverScoreItem | null {
  const normalizedCandidates = candidates.map((candidate) => candidate.toLowerCase());
  return scores.find((score) => {
    const moduleId = typeof score.module === 'string' ? score.module.toLowerCase() : '';
    return normalizedCandidates.some((candidate) => moduleId === candidate || moduleId.includes(candidate));
  }) ?? null;
}

function StarScore({ score }: { score?: AutoDeliverScoreItem | null }) {
  const rating = scoreRating(score);
  return (
    <div class="openspec-auto-hero-stars" aria-label={score ? scoreText(score) : undefined}>
      {[0, 1, 2, 3, 4].map((index) => (
        <span class={index < rating ? 'is-active' : ''} key={index}>★</span>
      ))}
    </div>
  );
}

function HeroScoreCard({
  label,
  score,
  tone,
  pendingLabel,
}: {
  label: string;
  score?: AutoDeliverScoreItem | null;
  tone: 'spec' | 'impl';
  pendingLabel: string;
}) {
  return (
    <div class={`openspec-auto-hero-score openspec-auto-hero-score-${tone}${score ? '' : ' openspec-auto-hero-score-pending'}`}>
      <span class="openspec-auto-hero-score-label">{label}</span>
      <div class="openspec-auto-hero-score-main">
        <strong>{scoreText(score)}</strong>
        <StarScore score={score} />
      </div>
      <small>{score?.summary || pendingLabel}</small>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value?: string | number | null }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div class="openspec-auto-detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ScoreGrid({
  scores,
  t,
  keyPrefix,
}: {
  scores: AutoDeliverScoreItem[];
  t: TranslationFn;
  keyPrefix: string;
}) {
  return (
    <div class="openspec-auto-score-grid">
      {scores.map((score) => {
        const moduleId = typeof score.module === 'string' && score.module ? score.module : 'unknown';
        return (
          <div class="openspec-auto-score" key={`${keyPrefix}:${moduleId}`}>
            <span>{t(`openspec.auto.score_module.${moduleId}`, { defaultValue: moduleId })}</span>
            <strong>{score.score}/{score.maxScore ?? score.max_score ?? 10}</strong>
            {score.summary && <small>{score.summary}</small>}
          </div>
        );
      })}
    </div>
  );
}

export function OpenSpecAutoDeliverDetailsPanel({
  projection,
  stopPending = false,
  continuePending = false,
  embedded = false,
  showActions = true,
  onClose,
  onStop,
  onContinue,
}: OpenSpecAutoDeliverDetailsPanelProps) {
  const { t } = useTranslation();
  const status = projection ? projectionStatus(projection) : 'unknown';
  const stage = projection ? projectionStage(projection) : 'unknown';
  const active = projection ? !isOpenSpecAutoDeliverTerminalStatus(status) : false;
  const canContinue = projection?.visibility === 'full' && projection.canContinue === true && !active;
  const now = useNowTicker(active);
  const elapsed = projection ? formatElapsed(projectionElapsedMs(projection, now)) : '00:00';
  // `implementation` in a SPEC acceptance audit means artifact
  // implementation-readiness, not completed product implementation. Only a
  // final implementation-stage snapshot may populate the Final Impl card.
  // Likewise, transient `moduleScores` are never final acceptance evidence.
  const finalScoreItems = useMemo(
    () => projection?.finalAfterRepair?.moduleScores ?? [],
    [projection?.finalAfterRepair],
  );
  const preRepairScoreItems = useMemo(() => projection?.auditBeforeRepair?.moduleScores ?? [], [projection?.auditBeforeRepair]);
  const auditResults = useMemo(() => projection?.auditResults ?? [], [projection?.auditResults]);
  const progress = projection ? computeOpenSpecAutoDeliverProgress(projection) : null;
  const implementationHasStarted = (projection?.implementationPromptCount ?? 0) > 0
    || stage === 'implementation_task_loop'
    || stage === 'implementation_audit_repair'
    || stage === 'commit_push'
    || stage === 'passed';
  const acceptedSpecScore = useMemo(() => {
    const currentSnapshotScore = findScoreByModule(finalScoreItems, ['spec']);
    if (currentSnapshotScore) return currentSnapshotScore;
    if (!implementationHasStarted) return undefined;
    const latestAcceptedSpecAudit = [...auditResults]
      .reverse()
      .find((result) => result.stage === 'spec_audit_repair' && result.verdict === 'PASS');
    return findScoreByModule(latestAcceptedSpecAudit?.moduleScores ?? [], ['spec']);
  }, [auditResults, finalScoreItems, implementationHasStarted]);
  const displayedFinalScoreItems = useMemo(() => (
    finalScoreItems.length > 0
      ? finalScoreItems
      : acceptedSpecScore ? [acceptedSpecScore] : []
  ), [acceptedSpecScore, finalScoreItems]);
  const finalSpecScore = acceptedSpecScore;
  const finalImplementationScore = useMemo(() => (
    projection?.finalAfterRepair?.stage === 'implementation_audit_repair'
      ? findScoreByModule(finalScoreItems, ['implementation', 'impl', 'code'])
      : undefined
  ), [finalScoreItems, projection?.finalAfterRepair?.stage]);
  const displayedVerdict = useMemo(() => {
    if (!implementationHasStarted) return projection?.latestVerdict;
    return [...auditResults]
      .reverse()
      .find((result) => result.stage === 'implementation_audit_repair')
      ?.verdict;
  }, [auditResults, implementationHasStarted, projection?.latestVerdict]);
  const latestMessage = translateAutoDeliverMessage(projection?.recentFinding, t);
  const repairingFromAudit = stage === 'implementation_task_loop'
    && projection?.recentFinding?.startsWith('implementation_repair_prompt_dispatched:');
  const [detailsSize] = useState(readDetailsSizePreference);
  const detailsPanelRef = useRef<HTMLDivElement | null>(null);
  const detailsPanelStyle = useMemo(
    () => `--openspec-auto-details-width:${detailsSize.width}px;--openspec-auto-details-height:${detailsSize.height}px;`,
    [detailsSize.height, detailsSize.width],
  );
  useEffect(() => {
    if (embedded) return undefined;
    const node = detailsPanelRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver((entries) => {
      if (!isDesktopDetailsViewport()) return;
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const maxSize = desktopDetailsMaxSize();
      const next = {
        width: clampNumber(rect.width, DETAILS_MIN_SIZE.width, maxSize.width, DETAILS_DEFAULT_SIZE.width),
        height: clampNumber(rect.height, DETAILS_MIN_SIZE.height, maxSize.height, DETAILS_DEFAULT_SIZE.height),
      };
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => writeDetailsSizePreference(next), 120);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (saveTimer) clearTimeout(saveTimer);
    };
  }, [embedded]);
  if (!projection) return null;

  const panel = (
      <div
        ref={detailsPanelRef}
        class={`openspec-auto-details-panel${embedded ? ' openspec-auto-details-panel-embedded' : ''}`}
        style={embedded ? undefined : detailsPanelStyle}
      >
        <div class="openspec-auto-details-head">
          <div>
            <div class="openspec-auto-kicker">{t('openspec.auto.details_title')}</div>
            <h3>{projectionTitle(projection)}</h3>
          </div>
          {!embedded && (
            <button class="openspec-auto-icon-btn" type="button" onClick={onClose} aria-label={t('common.close')}>
              ×
            </button>
          )}
        </div>
        <div class="openspec-auto-hero" data-testid="openspec-auto-hero">
          <div class="openspec-auto-hero-top">
            <div>
              <span>{t('openspec.auto.score_overview', { defaultValue: 'Score overview' })}</span>
              <strong>{t(statusKey(status), status)} · {t(stageKey(stage), stage)}</strong>
            </div>
            <div class="openspec-auto-hero-chips">
              <span>{t('openspec.auto.elapsed')} {elapsed}</span>
              {projection.presetId && <span>{projection.presetId}</span>}
            </div>
          </div>
          <div class="openspec-auto-hero-scores">
            <HeroScoreCard
              label={t('openspec.auto.final_spec_score', { defaultValue: t('openspec.auto.score_module.spec', { defaultValue: 'Spec' }) })}
              score={finalSpecScore}
              tone="spec"
              pendingLabel={t('openspec.auto.score_pending', { defaultValue: 'Pending final audit' })}
            />
            <HeroScoreCard
              label={t('openspec.auto.final_impl_score', { defaultValue: t('openspec.auto.score_module.implementation', { defaultValue: 'Implementation' }) })}
              score={finalImplementationScore}
              tone="impl"
              pendingLabel={t('openspec.auto.score_pending', { defaultValue: 'Pending final audit' })}
            />
          </div>
          {progress && (
            <div class="openspec-auto-hero-progress">
              <ProgressLine
                label={t('openspec.auto.overall_progress')}
                value={`${t('openspec.auto.progress_count', { current: progress.overall.current, total: progress.overall.total })} · ${t('openspec.auto.progress_percent', { percent: progress.overall.percent })}`}
                percent={progress.overall.percent}
              />
              <ProgressLine
                label={t('openspec.auto.current_stage_progress')}
                value={`${t('openspec.auto.progress_count', { current: progress.currentStage.current, total: progress.currentStage.total })} · ${t('openspec.auto.progress_percent', { percent: progress.currentStage.percent })}`}
                percent={progress.currentStage.percent}
              />
            </div>
          )}
          {latestMessage && (
            <div class="openspec-auto-hero-message">
              <span>{t('openspec.auto.latest_message')}</span>
              <strong>{latestMessage}</strong>
            </div>
          )}
        </div>
        <div class="openspec-auto-detail-grid">
          <DetailRow label={t('openspec.auto.preset_label')} value={projection.presetId} />
          <DetailRow label={t('openspec.auto.owning_session')} value={projection.owningMainSessionName} />
          <DetailRow label={t('openspec.auto.launched_from')} value={projection.launchedFromSessionName} />
          <DetailRow label={t('openspec.auto.execution_session')} value={projection.targetImplementationSessionName} />
          <DetailRow label={t('openspec.auto.spec_round')} value={formatRoundPair(projection.specAuditRound, projection.specAuditRepairRound)} />
          <DetailRow label={t('openspec.auto.impl_round')} value={formatRoundPair(projection.implementationAuditRound, projection.implementationAuditRepairRound)} />
          <DetailRow label={t('openspec.auto.prompt_count_label')} value={projection.implementationPromptCount} />
          <DetailRow label={t('openspec.auto.active_p2p')} value={projection.activeP2pRunId} />
          <DetailRow label={t('openspec.auto.combo_id')} value={projection.selectedTeamComboId ? comboModeLabel(projection.selectedTeamComboId, t) : undefined} />
          <DetailRow label={t('openspec.auto.active_prompt')} value={projection.activeOpenSpecPromptId} />
          <DetailRow label={t('openspec.auto.verdict')} value={displayedVerdict} />
          {projection.visibility === 'conflict' && (
            <DetailRow label={t('openspec.auto.conflict_summary')} value={translateAutoDeliverReason(projection.conflictReason, t)} />
          )}
          <DetailRow label={t('openspec.auto.terminal_reason')} value={translateAutoDeliverReason(projection.terminalReason, t)} />
        </div>
        <div class="openspec-auto-detail-section">
          <h4>{t('openspec.auto.task_stats')}</h4>
          <div class="openspec-auto-detail-note">{taskProgressText(projection, t)}</div>
          {uncheckedTaskLabels(projection).length ? (
            <ul>
              {uncheckedTaskLabels(projection).slice(0, 5).map((label) => <li key={label}>{label}</li>)}
            </ul>
          ) : null}
        </div>
        <div class="openspec-auto-detail-section">
          <h4>{t('openspec.auto.audit_results')}</h4>
          {auditResults.length === 0 ? (
            <div class="openspec-auto-detail-note">{t('openspec.auto.audit_results_empty')}</div>
          ) : (
            <div class="openspec-auto-audit-results">
              {auditResults.map((result) => (
                <div class="openspec-auto-audit-result" key={`${result.stage}:${result.roundIndex}:${result.attemptId}`}>
                  <div class="openspec-auto-audit-result-head">
                    <span>
                      {t(stageKey(result.stage), result.stage)} · {t('openspec.auto.round_index', { count: result.roundIndex })}
                    </span>
                    <strong>{result.verdict}</strong>
                  </div>
                  <ScoreGrid scores={result.moduleScores} t={t} keyPrefix={result.attemptId} />
                  {result.requiredChanges.length > 0 && (
                    <div class="openspec-auto-detail-note">
                      {t('openspec.auto.required_changes')}: {result.requiredChanges.slice(0, 3).join('; ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        {preRepairScoreItems.length > 0 && (
          <div class="openspec-auto-detail-section">
            <h4>{t('openspec.auto.pre_repair_scores')}</h4>
            <div class="openspec-auto-detail-note">
              {t('openspec.auto.score_snapshot_meta', {
                round: projection.auditBeforeRepair?.roundIndex,
                reason: translateAutoDeliverReason(projection.auditBeforeRepair?.summary, t) ?? projection.auditBeforeRepair?.summary,
              })}
            </div>
            <ScoreGrid scores={preRepairScoreItems} t={t} keyPrefix="audit-before-repair" />
          </div>
        )}
        <div class="openspec-auto-detail-section">
          <h4>{t('openspec.auto.final_scores')}</h4>
          {repairingFromAudit && preRepairScoreItems.length > 0 && (
            <div class="openspec-auto-detail-note">{t('openspec.auto.scores_pending_repair_rescore')}</div>
          )}
          {displayedFinalScoreItems.length === 0 ? (
            <div class="openspec-auto-detail-note">{t('openspec.auto.scores_empty')}</div>
          ) : (
            <ScoreGrid scores={displayedFinalScoreItems} t={t} keyPrefix="final-after-repair" />
          )}
        </div>
        {(projection.latestRepairSummary || projection.evidence?.length) && (
          <div class="openspec-auto-detail-section">
            <h4>{t('openspec.auto.evidence')}</h4>
            {projection.latestRepairSummary && <div class="openspec-auto-detail-note">{projection.latestRepairSummary}</div>}
            {projection.evidence?.map((item) => (
              <div class="openspec-auto-evidence" key={`${item.summary ?? item.label}:${item.source ?? item.provenance ?? ''}`}>
                <span>{formatEvidenceSummary(item.summary ?? item.label, t)}</span>
                {(item.source || item.provenance) && <small>{t(`openspec.auto.provenance.${item.source ?? item.provenance}`)}</small>}
                {item.stale && <small>{t('openspec.auto.evidence_stale')}</small>}
              </div>
            ))}
          </div>
        )}
        {showActions && (
          <div class="openspec-auto-details-actions">
          {canContinue && (
            <button class="btn btn-secondary" type="button" disabled={continuePending} onClick={onContinue}>
              {continuePending ? t('openspec.auto.continuing') : t('openspec.auto.continue')}
            </button>
          )}
          {active && projection.canStop !== false && (
            <button class="btn btn-secondary" type="button" disabled={stopPending} onClick={onStop}>
              {stopPending ? t('openspec.auto.stopping') : t('openspec.auto.stop')}
            </button>
          )}
          <button class="btn btn-primary" type="button" onClick={onClose}>
            {t('common.close')}
          </button>
          </div>
        )}
      </div>
  );

  if (embedded) {
    return (
      <div class="openspec-auto-details-embedded" data-testid="openspec-auto-details">
        {panel}
      </div>
    );
  }

  return (
    <div class="openspec-auto-details-backdrop" data-testid="openspec-auto-details">
      {panel}
    </div>
  );
}

export function OpenSpecAutoDeliverCurrentRunEntry({
  projection,
  onView,
}: {
  projection: OpenSpecAutoDeliverProjection;
  onView: () => void;
}) {
  const { t } = useTranslation();
  const redacted = projection.visibility === 'conflict';
  const status = projectionStatus(projection);
  const stage = projectionStage(projection);
  const route = [
    projection.owningMainSessionName,
    projection.targetImplementationSessionName,
  ].filter(Boolean).join(' → ');
  const latestMessage = projection.visibility === 'full'
    ? translateAutoDeliverMessage(projection.recentFinding, t)
    : undefined;
  const conflictReason = projection.visibility === 'conflict'
    ? translateAutoDeliverReason(projection.conflictReason, t)
    : undefined;
  return (
    <div
      class={`openspec-auto-current-run${redacted ? ' openspec-auto-current-run-redacted' : ''}`}
      data-testid={redacted ? 'openspec-auto-conflict-entry' : 'openspec-auto-current-entry'}
    >
      <div>
        <div class="openspec-auto-kicker">{t('openspec.auto.current_run')}</div>
        <div class="openspec-auto-current-title">
          {redacted ? projection.owningMainSessionName : projection.changeName}
        </div>
        <div class="openspec-auto-current-meta">
          {t(statusKey(status), status)} · {t(stageKey(stage), stage)}
        </div>
        {!redacted && route && (
          <div class="openspec-auto-current-meta">{route}</div>
        )}
        {!redacted && latestMessage && (
          <div class="openspec-auto-current-meta">{latestMessage}</div>
        )}
        {redacted && (
          <div class="openspec-auto-current-meta">{conflictReason ?? t('openspec.auto.redacted_conflict')}</div>
        )}
        {redacted && <div class="openspec-auto-current-meta">{t('openspec.auto.conflict_summary')}</div>}
      </div>
      {!redacted && (
        <button class="btn btn-secondary openspec-auto-mini-btn" type="button" onClick={onView}>
          {t('openspec.auto.view')}
        </button>
      )}
    </div>
  );
}
