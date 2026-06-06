import { useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET,
  OPENSPEC_AUTO_DELIVER_PRESETS,
  isOpenSpecAutoDeliverActiveProjection,
  isOpenSpecAutoDeliverTerminalStatus,
  materializedPresetLimits,
  type OpenSpecAutoDeliverPresetId,
  type OpenSpecAutoDeliverProjection,
} from '../openspec-auto-deliver.js';
import { useNowTicker } from '../hooks/useNowTicker.js';

export interface OpenSpecAutoDeliverLauncherProps {
  changeName: string | null;
  open: boolean;
  disabled?: boolean;
  conflictProjection?: OpenSpecAutoDeliverProjection | null;
  launchPending?: boolean;
  error?: string | null;
  onClose: () => void;
  onLaunch: (changeName: string, presetId: OpenSpecAutoDeliverPresetId) => void;
  onViewCurrent?: () => void;
}

export interface OpenSpecAutoDeliverRunBarProps {
  projection: OpenSpecAutoDeliverProjection;
  stopPending?: boolean;
  onView: () => void;
  onStop: () => void;
}

export interface OpenSpecAutoDeliverDetailsPanelProps {
  projection: OpenSpecAutoDeliverProjection | null;
  stopPending?: boolean;
  onClose: () => void;
  onStop: () => void;
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

function taskProgressText(projection: OpenSpecAutoDeliverProjection, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const stats = projection.taskStats;
  if (!stats || stats.total <= 0) return t('openspec.auto.tasks_unknown');
  return t('openspec.auto.tasks_progress', { checked: stats.checked, total: stats.total });
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

function projectionElapsedMs(projection: OpenSpecAutoDeliverProjection, now: number): number {
  if (typeof projection.elapsedMs === 'number' && Number.isFinite(projection.elapsedMs)) return projection.elapsedMs;
  if (typeof projection.startedAt === 'number' && Number.isFinite(projection.startedAt)) return now - projection.startedAt;
  return 0;
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
  const { t } = useTranslation();
  const [presetId, setPresetId] = useState<OpenSpecAutoDeliverPresetId>(OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET);
  const hasConflict = isOpenSpecAutoDeliverActiveProjection(conflictProjection);

  useEffect(() => {
    if (open) setPresetId(OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET);
  }, [open, changeName]);

  if (!open) return null;

  const selectedLimits = materializedPresetLimits(presetId);
  const validationError = !changeName ? 'openspec.auto.error.missing_change' : error;
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
          <div>{t('openspec.auto.conflict_active', { change: conflictProjection.changeName })}</div>
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
                  onClick={() => setPresetId(preset.id)}
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
            disabled={disabled || !changeName || launchPending}
            onClick={() => changeName && onLaunch(changeName, presetId)}
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
  onView,
  onStop,
}: OpenSpecAutoDeliverRunBarProps) {
  const { t } = useTranslation();
  const active = !isOpenSpecAutoDeliverTerminalStatus(projection.status);
  const now = useNowTicker(active);
  const elapsed = formatElapsed(projectionElapsedMs(projection, now));
  const stageLabel = t(stageKey(projection.stage), projection.stage);
  const taskText = taskProgressText(projection, t);
  const canStop = projection.canStop !== false && active;

  return (
    <div class="openspec-auto-runbar discussions-progress-card" data-testid="openspec-auto-runbar">
      <div class="discussions-progress-head openspec-auto-runbar-head">
        <div class="discussions-progress-titlewrap">
          <div class="discussions-progress-kicker">{t('openspec.auto.kicker')}</div>
          <div class="discussions-progress-title">{projection.changeName}</div>
        </div>
        <span class="p2p-timer p2p-timer-total">{elapsed}</span>
        <button class="discussions-progress-stop openspec-auto-view-btn" type="button" onClick={onView}>
          {t('openspec.auto.view')}
        </button>
        {canStop && (
          <button class="discussions-progress-stop" type="button" disabled={stopPending} onClick={onStop}>
            {stopPending ? t('openspec.auto.stopping') : t('openspec.auto.stop')}
          </button>
        )}
      </div>
      <div class="discussions-progress-meta">
        <span class="discussions-progress-badge discussions-progress-badge-mode">
          {t(statusKey(projection.status), projection.status)}
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
        <div class="discussions-progress-line">
          <div class="discussions-progress-line-head">
            <span class="discussions-progress-line-label">{t('openspec.auto.tasks')}</span>
            <span class="discussions-progress-line-value">{taskText}</span>
          </div>
          <div class="discussions-progress-bar openspec-auto-taskbar">
            <div
              class="discussions-progress-fill openspec-auto-taskfill"
              style={{ width: `${projection.taskStats && projection.taskStats.total > 0 ? Math.min(100, (projection.taskStats.checked / projection.taskStats.total) * 100) : 0}%` }}
            />
          </div>
        </div>
      </div>
      {projection.recentFinding && (
        <div class="openspec-auto-finding">{projection.recentFinding}</div>
      )}
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

export function OpenSpecAutoDeliverDetailsPanel({
  projection,
  stopPending = false,
  onClose,
  onStop,
}: OpenSpecAutoDeliverDetailsPanelProps) {
  const { t } = useTranslation();
  const active = projection ? !isOpenSpecAutoDeliverTerminalStatus(projection.status) : false;
  const now = useNowTicker(active);
  const elapsed = projection ? formatElapsed(projectionElapsedMs(projection, now)) : '00:00';
  const scoreItems = useMemo(() => projection?.moduleScores ?? [], [projection?.moduleScores]);
  if (!projection) return null;

  return (
    <div class="openspec-auto-details-backdrop" data-testid="openspec-auto-details">
      <div class="openspec-auto-details-panel">
        <div class="openspec-auto-details-head">
          <div>
            <div class="openspec-auto-kicker">{t('openspec.auto.details_title')}</div>
            <h3>{projection.changeName}</h3>
          </div>
          <button class="openspec-auto-icon-btn" type="button" onClick={onClose} aria-label={t('common.close')}>
            ×
          </button>
        </div>
        <div class="openspec-auto-detail-grid">
          <DetailRow label={t('openspec.auto.status_label')} value={t(statusKey(projection.status), projection.status)} />
          <DetailRow label={t('openspec.auto.stage_label')} value={t(stageKey(projection.stage), projection.stage)} />
          <DetailRow label={t('openspec.auto.elapsed')} value={elapsed} />
          <DetailRow label={t('openspec.auto.preset_label')} value={projection.presetId} />
          <DetailRow label={t('openspec.auto.owning_session')} value={projection.owningMainSessionName} />
          <DetailRow label={t('openspec.auto.launched_from')} value={projection.launchedFromSessionName} />
          <DetailRow label={t('openspec.auto.execution_session')} value={projection.targetImplementationSessionName} />
          <DetailRow label={t('openspec.auto.spec_round')} value={formatRoundPair(projection.specAuditRound, projection.specAuditRepairRound)} />
          <DetailRow label={t('openspec.auto.impl_round')} value={formatRoundPair(projection.implementationAuditRound, projection.implementationAuditRepairRound)} />
          <DetailRow label={t('openspec.auto.prompt_count_label')} value={projection.implementationPromptCount} />
          <DetailRow label={t('openspec.auto.active_p2p')} value={projection.activeP2pRunId} />
          <DetailRow label={t('openspec.auto.combo_id')} value={projection.activeComboId} />
          <DetailRow label={t('openspec.auto.verdict')} value={projection.latestVerdict} />
          <DetailRow label={t('openspec.auto.terminal_reason')} value={projection.terminalReason} />
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
          <h4>{t('openspec.auto.scores')}</h4>
          {scoreItems.length === 0 ? (
            <div class="openspec-auto-detail-note">{t('openspec.auto.scores_empty')}</div>
          ) : (
            <div class="openspec-auto-score-grid">
              {scoreItems.map((score) => (
                <div class="openspec-auto-score" key={score.module}>
                  <span>{t(`openspec.auto.score_module.${score.module}`, score.module)}</span>
                  <strong>{score.score}/{score.maxScore ?? 10}</strong>
                  {score.summary && <small>{score.summary}</small>}
                </div>
              ))}
            </div>
          )}
        </div>
        {(projection.latestRepairSummary || projection.recentFinding || projection.evidence?.length) && (
          <div class="openspec-auto-detail-section">
            <h4>{t('openspec.auto.evidence')}</h4>
            {projection.latestRepairSummary && <div class="openspec-auto-detail-note">{projection.latestRepairSummary}</div>}
            {projection.recentFinding && <div class="openspec-auto-detail-note">{projection.recentFinding}</div>}
            {projection.evidence?.map((item) => (
              <div class="openspec-auto-evidence" key={`${item.summary ?? item.label}:${item.source ?? item.provenance ?? ''}`}>
                <span>{item.summary ?? item.label}</span>
                {(item.source || item.provenance) && <small>{t(`openspec.auto.provenance.${item.source ?? item.provenance}`)}</small>}
                {item.stale && <small>{t('openspec.auto.evidence_stale')}</small>}
              </div>
            ))}
          </div>
        )}
        <div class="openspec-auto-details-actions">
          {active && projection.canStop !== false && (
            <button class="btn btn-secondary" type="button" disabled={stopPending} onClick={onStop}>
              {stopPending ? t('openspec.auto.stopping') : t('openspec.auto.stop')}
            </button>
          )}
          <button class="btn btn-primary" type="button" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
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
  const route = [
    projection.owningMainSessionName,
    projection.targetImplementationSessionName,
  ].filter(Boolean).join(' → ');
  return (
    <div
      class={`openspec-auto-current-run${redacted ? ' openspec-auto-current-run-redacted' : ''}`}
      data-testid={redacted ? 'openspec-auto-conflict-entry' : 'openspec-auto-current-entry'}
    >
      <div>
        <div class="openspec-auto-kicker">{t('openspec.auto.current_run')}</div>
        <div class="openspec-auto-current-title">{projection.changeName}</div>
        <div class="openspec-auto-current-meta">
          {t(statusKey(projection.status), projection.status)} · {t(stageKey(projection.stage), projection.stage)}
        </div>
        {!redacted && route && (
          <div class="openspec-auto-current-meta">{route}</div>
        )}
        {redacted && (
          <div class="openspec-auto-current-meta">{projection.conflictReason ?? t('openspec.auto.redacted_conflict')}</div>
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
