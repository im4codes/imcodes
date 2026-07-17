import { useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  QUICK_AGENT_DELEGATION_PRESETS,
  buildQuickAgentDelegationTask,
  type QuickAgentDelegationPreset,
} from '@shared/agent-delegation.js';
import { getAgentBadgeConfig, getAutoSessionLabelPrefix } from '../agent-display.js';

export interface QuickAgentDelegationCandidate {
  sessionName: string;
  agentType: string;
  label?: string | null;
  model?: string | null;
  state: string;
  /** Enabled member of the current root session's saved Team configuration. */
  teamMember?: boolean;
}

interface QuickAgentDelegationDialogProps {
  currentSessionName: string;
  candidates: QuickAgentDelegationCandidate[];
  error?: string | null;
  onClose: () => void;
  onDispatch: (input: { sessionName: string; label: string; task: string }) => void;
}

const QUICK_TARGET_STORAGE_KEY = 'quickAgentDelegationTargets:v1';
const QUICK_TARGET_STORAGE_LIMIT = 32;
const INTERNAL_SESSION_TOKEN_RE = /(?:^|[^a-z0-9])deck_[a-z0-9_-]+/i;
const UNAVAILABLE_STATES = new Set(['stopped', 'error', 'unknown']);

function opaqueSessionKey(value: string): string {
  let hash = 14_695_981_039_346_656_037n;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n);
  }
  return `s${hash.toString(36)}`;
}

interface RememberedTargetEntry { source: string; target: string }

function readStoredTargets(): RememberedTargetEntry[] {
  const parsed = JSON.parse(localStorage.getItem(QUICK_TARGET_STORAGE_KEY) ?? '[]') as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const source = (item as { source?: unknown }).source;
    const target = (item as { target?: unknown }).target;
    return typeof source === 'string' && /^s[0-9a-z]+$/.test(source)
      && typeof target === 'string' && /^s[0-9a-z]+$/.test(target)
      ? [{ source, target }]
      : [];
  });
}

function visibleCandidateLabel(candidate: QuickAgentDelegationCandidate): string {
  const label = candidate.label?.trim();
  return label && !INTERNAL_SESSION_TOKEN_RE.test(label)
    ? label
    : getAutoSessionLabelPrefix(candidate.agentType);
}

function readRememberedTarget(currentSessionName: string): string | null {
  try {
    const source = opaqueSessionKey(currentSessionName);
    return readStoredTargets().find((item) => item.source === source)?.target ?? null;
  } catch {
    return null;
  }
}

function rememberTarget(currentSessionName: string, targetSessionName: string): void {
  try {
    const entries = readStoredTargets();
    const source = opaqueSessionKey(currentSessionName);
    const next = entries.filter((item) => item.source !== source);
    next.unshift({ source, target: opaqueSessionKey(targetSessionName) });
    localStorage.setItem(QUICK_TARGET_STORAGE_KEY, JSON.stringify(next.slice(0, QUICK_TARGET_STORAGE_LIMIT)));
  } catch {
    // Remembering the convenience target is best effort only.
  }
}

export function QuickAgentDelegationDialog({
  currentSessionName,
  candidates,
  error,
  onClose,
  onDispatch,
}: QuickAgentDelegationDialogProps) {
  const { t } = useTranslation();
  const remembered = readRememberedTarget(currentSessionName);
  const [preset, setPreset] = useState<QuickAgentDelegationPreset>('audit');
  const [customTask, setCustomTask] = useState('');
  const orderedCandidates = useMemo(() => {
    if (!remembered) return candidates;
    const rememberedIndex = candidates.findIndex((candidate) => opaqueSessionKey(candidate.sessionName) === remembered);
    if (rememberedIndex <= 0) return candidates;
    return [candidates[rememberedIndex]!, ...candidates.slice(0, rememberedIndex), ...candidates.slice(rememberedIndex + 1)];
  }, [candidates, remembered]);
  const candidateLabels = useMemo(() => {
    const labels = new Map<string, string>();
    const fallbackCounts = new Map<string, number>();
    for (const candidate of orderedCandidates) {
      const base = visibleCandidateLabel(candidate);
      const hasSafeExplicitLabel = Boolean(candidate.label?.trim() && !INTERNAL_SESSION_TOKEN_RE.test(candidate.label.trim()));
      if (hasSafeExplicitLabel) {
        labels.set(candidate.sessionName, base);
        continue;
      }
      const key = `${candidate.agentType}\u0000${candidate.model?.trim() ?? ''}`;
      const total = orderedCandidates.filter((item) => (
        item.agentType === candidate.agentType
        && (item.model?.trim() ?? '') === (candidate.model?.trim() ?? '')
        && !(item.label?.trim() && !INTERNAL_SESSION_TOKEN_RE.test(item.label.trim()))
      )).length;
      const ordinal = (fallbackCounts.get(key) ?? 0) + 1;
      fallbackCounts.set(key, ordinal);
      labels.set(candidate.sessionName, total > 1 ? `${base} ${ordinal}` : base);
    }
    return labels;
  }, [orderedCandidates]);
  const task = buildQuickAgentDelegationTask(preset, customTask);

  const dispatch = (candidate: QuickAgentDelegationCandidate) => {
    if (!task || UNAVAILABLE_STATES.has(candidate.state)) return;
    rememberTarget(currentSessionName, candidate.sessionName);
    onDispatch({
      sessionName: candidate.sessionName,
      label: candidateLabels.get(candidate.sessionName) ?? visibleCandidateLabel(candidate),
      task,
    });
  };

  return (
    <div class="peer-audit-chooser quick-agent-delegation" data-testid="quick-agent-delegation-dialog">
      <h3>{t('peerAuditQuick.chooserTitle')}</h3>
      <p>{t('peerAuditQuick.delegationDescription')}</p>
      {error && <div class="peer-audit-chooser-error" role="alert" data-testid="quick-agent-delegation-error">{error}</div>}

      <div class="quick-agent-delegation-presets" role="group" aria-label={t('peerAuditQuick.modeLabel')}>
        {QUICK_AGENT_DELEGATION_PRESETS.map((item) => (
          <button
            type="button"
            class={preset === item ? 'quick-agent-delegation-preset active' : 'quick-agent-delegation-preset'}
            aria-pressed={preset === item}
            onClick={() => setPreset(item)}
          >
            {t(`peerAuditQuick.mode.${item}`)}
          </button>
        ))}
      </div>

      {preset === 'custom' && (
        <textarea
          class="quick-agent-delegation-custom"
          data-testid="quick-agent-delegation-custom"
          value={customTask}
          rows={4}
          autoFocus
          placeholder={t('peerAuditQuick.customPlaceholder')}
          onInput={(event) => setCustomTask(event.currentTarget.value)}
        />
      )}

      {candidates.length === 0 ? (
        <div class="peer-audit-chooser-empty" data-testid="quick-agent-delegation-empty">
          {t('peerAuditQuick.noCandidate')}
        </div>
      ) : (
        <ul class="peer-audit-chooser-list" data-testid="quick-agent-delegation-candidates">
          {orderedCandidates.map((candidate) => {
            const badge = getAgentBadgeConfig(candidate.agentType);
            const typeLabel = getAutoSessionLabelPrefix(candidate.agentType);
            const displayLabel = candidateLabels.get(candidate.sessionName) ?? visibleCandidateLabel(candidate);
            const model = candidate.model?.trim() || t('peerAuditQuick.unknownModel');
            const unavailable = UNAVAILABLE_STATES.has(candidate.state);
            return (
              <li key={candidate.sessionName}>
                <button
                  type="button"
                  class="peer-audit-chooser-row"
                  data-testid="quick-agent-delegation-candidate"
                  disabled={!task || unavailable}
                  onClick={() => dispatch(candidate)}
                >
                  <span class="peer-audit-chooser-row-main">
                    <span
                      class="peer-audit-provider-badge"
                      style={{ background: badge?.color ?? '#64748b' }}
                    >
                      {typeLabel}
                    </span>
                    {displayLabel !== typeLabel && (
                      <span class="peer-audit-chooser-row-label">{displayLabel}</span>
                    )}
                    {candidate.teamMember && (
                      <span class="p2p-tag quick-agent-delegation-team-tag">
                        {t('session.p2p_tag')}
                      </span>
                    )}
                  </span>
                  <span class="peer-audit-chooser-row-meta">
                    <span class="peer-audit-chooser-row-model">{model}</span>
                    {unavailable
                      ? <span class="quick-agent-delegation-state unavailable">{t('peerAuditQuick.unavailable')}</span>
                      : candidate.state !== 'idle' && <span class="quick-agent-delegation-state">{t('peerAuditQuick.busy')}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div class="peer-audit-chooser-actions">
        <button type="button" onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}
