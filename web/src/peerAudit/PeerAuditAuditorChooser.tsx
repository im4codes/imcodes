/**
 * PeerAuditAuditorChooser — reusable chooser UI for the auditor sub-session.
 *
 * Renders: loading, chooser list with eligibility/model/provider badge,
 * sent_unrevocable indicator, same-model reason banner, no-candidate
 * fallback, single-flight aria-busy.
 *
 * Does NOT render the trigger button — the trigger lives in SessionControls.
 * Does NOT touch supervision mode/loop counters.
 */

import { useTranslation } from 'react-i18next';
import { assertNeverPeerAudit } from '@shared/peer-audit.js';
import type {
  PeerAuditCandidate,
  PeerAuditCandidateList,
  PeerAuditControllerApi,
  PeerAuditState,
} from './types.js';

interface PeerAuditAuditorChooserProps {
  api: PeerAuditControllerApi;
  onClose: () => void;
}

const PROVIDER_BADGE: Record<string, { label: string; color: string }> = {
  anthropic: { label: 'A', color: '#d97706' },
  openai: { label: 'O', color: '#10b981' },
  google: { label: 'G', color: '#3b82f6' },
  qwen: { label: 'Q', color: '#a855f7' },
  openclaw: { label: 'X', color: '#64748b' },
  unknown: { label: '?', color: '#94a3b8' },
};

const DISPOSITION_LABEL: Record<PeerAuditCandidate['dispositionCapability'], string> = {
  sent: 'sent',
  queued: 'queued',
  sent_unrevocable: 'sent_unrevocable',
};

function reasonKey(reason: Extract<PeerAuditState, { kind: 'chooser' }>['reason']): string {
  switch (reason) {
    case 'missing_target':
      return 'peerAuditQuick.chooserReason.missing_target';
    case 'self_target':
      return 'peerAuditQuick.chooserReason.self_target';
    case 'stale_target':
      return 'peerAuditQuick.chooserReason.stale_target';
    case 'same_model_remembered':
      return 'peerAuditQuick.chooserReason.same_model_remembered';
    case 'unknown_model_remembered':
      return 'peerAuditQuick.chooserReason.unknown_model_remembered';
    case 'no_candidate':
      return 'peerAuditQuick.chooserReason.no_candidate';
    case 'model_changed_since_click':
      return 'peerAuditQuick.chooserReason.model_changed_since_click';
    case 'config_repair':
      return 'peerAuditQuick.chooserReason.config_repair';
  }
}

function candidateReasonKey(reason: PeerAuditCandidate['reason']): string {
  switch (reason) {
    case 'self': return 'peerAuditQuick.self_target';
    case 'not_direct_child': return 'peerAuditQuick.not_direct_child';
    case 'cross_project': return 'peerAuditQuick.cross_project';
    case 'execution_clone': return 'peerAuditQuick.execution_clone';
    case 'not_reply_capable': return 'peerAuditQuick.not_reply_capable';
    case 'busy_state': return 'peerAuditQuick.wrong_state';
    case 'unknown_identity': return 'peerAuditQuick.unknown_identity';
    case 'eligible': return 'peerAuditQuick.chooserReason.missing_target';
  }
  return assertNeverPeerAudit(reason);
}

export function PeerAuditAuditorChooser({ api, onClose }: PeerAuditAuditorChooserProps) {
  const { t } = useTranslation();
  const { state } = api;

  if (state.kind === 'loading') {
    return (
      <div
        class="peer-audit-chooser"
        data-testid="peer-audit-chooser-loading"
        role="dialog"
        aria-label={t('peerAuditQuick.chooserTitle')}
      >
        <div class="peer-audit-chooser-loading">{t('common.loading')}</div>
      </div>
    );
  }

  if (state.kind === 'consent') {
    return (
      <div
        class="peer-audit-chooser"
        data-testid="peer-audit-chooser-consent"
        role="dialog"
        aria-label={t('peerAuditQuick.consentTitle')}
      >
        <h3>{t('peerAuditQuick.consentTitle')}</h3>
        <p>{t('peerAuditQuick.consentBody', { auditor: state.auditorLabel })}</p>
        <p data-testid="peer-audit-consent-identity">
          {state.normalizedModelId} · {state.providerFamily}
        </p>
        <p>{t('peerAuditQuick.selectionWillPersist')}</p>
        <div class="peer-audit-chooser-actions">
          <button type="button" onClick={() => api.cancelConsent()}>
            {t('common.cancel')}
          </button>
          <button type="button" onClick={() => api.confirmConsent()} autoFocus>
            {t('peerAuditQuick.consentConfirm')}
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === 'chooser') {
    return (
      <ChooserPanel api={api} list={state.candidates} reason={reasonKey(state.reason)} onClose={onClose} />
    );
  }

  // starting / pending / result / error / idle: chooser is not visible.
  return null;
}

interface ChooserPanelProps {
  api: PeerAuditControllerApi;
  list: PeerAuditCandidateList | null;
  reason: string;
  onClose: () => void;
}

function ChooserPanel({ api, list, reason, onClose }: ChooserPanelProps) {
  const { t } = useTranslation();

  return (
    <div
      class="peer-audit-chooser"
      data-testid="peer-audit-chooser"
      role="dialog"
      aria-label={t('peerAuditQuick.chooserTitle')}
      aria-busy="false"
    >
      <h3>{t('peerAuditQuick.chooserTitle')}</h3>
      <div class="peer-audit-chooser-reason" data-testid="peer-audit-chooser-reason">
        {t(reason)}
      </div>
      <PeerAuditCandidatePicker list={list} onSelect={(candidate) => api.selectCandidate(candidate)} />
      <div class="peer-audit-chooser-actions">
        <button type="button" onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}

export function PeerAuditCandidatePicker({
  list,
  selectedSessionInstanceId,
  onSelect,
}: {
  list: PeerAuditCandidateList | null;
  selectedSessionInstanceId?: string;
  onSelect: (candidate: PeerAuditCandidate) => void;
}) {
  const { t } = useTranslation();
  const eligible = list?.candidates.filter((candidate) => candidate.eligible) ?? [];
  const ineligible = list?.candidates.filter((candidate) => !candidate.eligible) ?? [];
  return (
    <div class="peer-audit-candidate-picker" data-testid="peer-audit-candidate-picker">
      {eligible.length === 0 && (
        <div class="peer-audit-chooser-empty" data-testid="peer-audit-chooser-empty">
          {t('peerAuditQuick.noCandidate')}
        </div>
      )}
      {eligible.length > 0 && (
        <ul class="peer-audit-chooser-list" data-testid="peer-audit-chooser-list">
          {eligible.map((candidate) => (
            <CandidateRow
              key={candidate.sessionInstanceId}
              candidate={candidate}
              selected={candidate.sessionInstanceId === selectedSessionInstanceId}
              onSelect={() => onSelect(candidate)}
            />
          ))}
        </ul>
      )}
      {ineligible.length > 0 && (
        <details class="peer-audit-chooser-ineligible">
          <summary>{t('peerAuditQuick.ineligibleCollapsed', { count: ineligible.length })}</summary>
          <ul>
            {ineligible.map((candidate) => (
              <li key={candidate.sessionInstanceId} data-testid="peer-audit-chooser-ineligible-row">
                <span>{candidate.label} · {candidate.name}</span>
                <span>{candidate.normalizedModelId} · {candidate.providerFamily} · {candidate.liveState}</span>
                <span>{t(candidateReasonKey(candidate.reason))}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

interface CandidateRowProps {
  candidate: PeerAuditCandidate;
  selected?: boolean;
  onSelect: () => void;
}

function CandidateRow({ candidate, selected = false, onSelect }: CandidateRowProps) {
  const { t } = useTranslation();
  const badge = PROVIDER_BADGE[candidate.providerFamily] ?? PROVIDER_BADGE.unknown;
  return (
    <li>
      <button
        type="button"
        class="peer-audit-chooser-row"
        data-testid="peer-audit-chooser-row"
        data-provider-family={candidate.providerFamily}
        data-disposition={candidate.dispositionCapability}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span
          class="peer-audit-provider-badge"
          aria-label={t('peerAuditQuick.providerBadge', { provider: candidate.providerFamily })}
          style={{ background: badge.color }}
        >
          {badge.label}
        </span>
        <span class="peer-audit-chooser-row-label">{candidate.label}</span>
        <span class="peer-audit-chooser-row-name">{candidate.name}</span>
        <span class="peer-audit-chooser-row-model">{candidate.normalizedModelId}</span>
        <span class="peer-audit-chooser-row-state">{candidate.liveState}</span>
        <span class="peer-audit-chooser-row-disposition">
          {t(`peerAuditQuick.disposition.${DISPOSITION_LABEL[candidate.dispositionCapability]}`)}
        </span>
      </button>
    </li>
  );
}
