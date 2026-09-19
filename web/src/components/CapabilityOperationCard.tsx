import { useTranslation } from 'react-i18next';
import {
  CAPABILITY_FINDING_SEVERITY,
  CAPABILITY_INSTALL_STATE,
  CAPABILITY_INSTALL_STATES,
  isCapabilityInstallCancellable,
  isCapabilityInstallTerminal,
} from '@shared/capability-management.js';
import type { CapabilityFindingView, CapabilityOperationView } from '../api/capabilities.js';

interface Props {
  operation: CapabilityOperationView;
  busy?: boolean;
  offline?: boolean;
  onInstall?: () => void;
  onCancel?: () => void;
  onRetry?: () => void;
}

function translationSuffix(value: string | undefined): string {
  return (value ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function Finding({ finding }: { finding: CapabilityFindingView }) {
  const { t } = useTranslation();
  const severity = translationSuffix(finding.severity);
  return (
    <li class={`capability-finding capability-finding-${severity}`}>
      <span class="capability-finding-severity">{t(`capabilities.severity.${severity}`)}</span>
      <span class="capability-finding-summary">{finding.message}</span>
      {finding.path && <code>{finding.path}</code>}
    </li>
  );
}

export function CapabilityOperationCard({ operation, busy = false, offline = false, onInstall, onCancel, onRetry }: Props) {
  const { t } = useTranslation();
  const state = translationSuffix(operation.state);
  const stateIndex = CAPABILITY_INSTALL_STATES.indexOf(operation.state);
  const progress = Math.max(0, Math.min(100, operation.progress ?? Math.round(((stateIndex + 1) / CAPABILITY_INSTALL_STATES.length) * 100)));
  const prominentFindings = (operation.findings ?? []).filter((finding) => {
    const severity = finding.severity.toLowerCase();
    return severity === CAPABILITY_FINDING_SEVERITY.CRITICAL || severity === CAPABILITY_FINDING_SEVERITY.HIGH;
  });
  const otherFindings = (operation.findings ?? []).filter((finding) => (
    finding.severity !== CAPABILITY_FINDING_SEVERITY.CRITICAL
    && finding.severity !== CAPABILITY_FINDING_SEVERITY.HIGH
  ));
  const terminal = operation.terminal ?? isCapabilityInstallTerminal(operation.state);
  const canConfirm = (operation.canConfirm ?? true) && operation.state === CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION;
  const canCancel = isCapabilityInstallCancellable(operation.state) && operation.canCancel !== false;
  const hasConfirmationEvidence = Boolean(operation.artifactDigest && operation.auditDigest);
  const warnings = [
    ...(operation.hasScripts ? [{ key: 'scripts', command: undefined }] : []),
    ...(operation.hasExecutables ? [{ key: 'executables', command: undefined }] : []),
    ...(operation.stdioCommand?.length ? [{ key: 'stdio', command: operation.stdioCommand.join(' ') }] : []),
  ];

  return (
    <section
      class={`capability-operation-card capability-operation-${state}`}
      aria-labelledby={`capability-operation-${operation.id}`}
      aria-live="polite"
    >
      <header class="capability-operation-header">
        <div>
          <span class="capability-eyebrow">{t('capabilities.operationTitle')}</span>
          <h3 id={`capability-operation-${operation.id}`}>
            {operation.displayName ?? operation.capabilityName ?? operation.sourceLabel ?? t('capabilities.pendingName')}
          </h3>
        </div>
        <span class={`capability-state capability-state-${state}`}>{t(`capabilities.state.${state}`)}</span>
      </header>

      {!terminal && progress > 0 && (
        <div class="capability-progress" aria-label={t('capabilities.progressLabel', { progress })}>
          <span style={{ width: `${progress}%` }} />
        </div>
      )}

      {offline && <div class="capability-inline-alert">{t('capabilities.offlineKeepingState')}</div>}
      {operation.statusDetail && <p class="capability-status-detail">{operation.statusDetail}</p>}
      {operation.errorCode && (
        <p class="capability-inline-alert" role="alert">
          {t('capabilities.operationError', { code: operation.errorCode })}
        </p>
      )}
      {canConfirm && !hasConfirmationEvidence && (
        <p class="capability-inline-alert" role="alert">{t('capabilities.confirmationEvidenceMissing')}</p>
      )}

      <dl class="capability-facts">
        {operation.kind && <><dt>{t('capabilities.kindLabel')}</dt><dd>{t(`capabilities.kind.${translationSuffix(operation.kind)}`)}</dd></>}
        {operation.scope && <><dt>{t('capabilities.scopeLabel')}</dt><dd>{t(`capabilities.scope.${translationSuffix(operation.scope)}`)}</dd></>}
        {operation.sourceLabel && <><dt>{t('capabilities.sourceLabel')}</dt><dd>{operation.sourceLabel}</dd></>}
        {operation.artifactDigest && <><dt>{t('capabilities.artifactDigestLabel')}</dt><dd><code class="capability-digest">{operation.artifactDigest}</code></dd></>}
        {operation.readiness && <><dt>{t('capabilities.readinessLabel')}</dt><dd>{t(`capabilities.readiness.${translationSuffix(operation.readiness)}`)}</dd></>}
      </dl>

      {(canConfirm || operation.providers.length > 0) && (
        <div class="capability-card-section">
          <h4>{t('capabilities.providersLabel')}</h4>
          {operation.providers.length
            ? <div class="capability-chip-row">{operation.providers.map((provider) => <code key={provider}>{provider}</code>)}</div>
            : <p>{t('capabilities.allCompatibleProviders')}</p>}
        </div>
      )}

      {(canConfirm || operation.machines.length > 0) && (
        <div class="capability-card-section">
          <h4>{t('capabilities.machinesLabel')}</h4>
          {operation.machines.length
            ? <div class="capability-chip-row">{operation.machines.map((machine) => <code key={machine}>{machine}</code>)}</div>
            : <p>{t('capabilities.allAllowedMachines')}</p>}
        </div>
      )}

      {!!operation.updateDiff?.length && (
        <div class="capability-card-section">
          <h4>{t('capabilities.updateChanges')}</h4>
          <ul>{operation.updateDiff.map((line) => <li key={line}>{line}</li>)}</ul>
        </div>
      )}

      {!!warnings.length && (
        <div class="capability-card-section capability-risk-section">
          <h4>{t('capabilities.riskDetails')}</h4>
          <ul>{warnings.map((warning) => (
            <li class="capability-warning" key={warning.key}>
              <strong>{t(`capabilities.warning.${warning.key}`)}</strong>
              {warning.command && <code class="capability-command">{warning.command}</code>}
            </li>
          ))}</ul>
        </div>
      )}

      {!!prominentFindings.length && (
        <div class="capability-card-section capability-risk-section" role="alert">
          <h4>{t('capabilities.blockingFindings')}</h4>
          <ul>{prominentFindings.map((finding, index) => <Finding key={`${finding.code}-${index}`} finding={finding} />)}</ul>
        </div>
      )}

      {!!otherFindings.length && (
        <div class="capability-card-section">
          <h4>{t('capabilities.otherFindings')}</h4>
          <ul>{otherFindings.map((finding, index) => <Finding key={`${finding.code}-${index}`} finding={finding} />)}</ul>
        </div>
      )}

      {!!operation.tools?.length && (
        <div class="capability-card-section">
          <h4>{t('capabilities.toolsLabel')}</h4>
          <div class="capability-chip-row">{operation.tools.map((tool) => <code key={tool}>{tool}</code>)}</div>
        </div>
      )}

      {!!operation.permissions?.length && (
        <div class="capability-card-section">
          <h4>{t('capabilities.permissionsLabel')}</h4>
          <div class="capability-chip-row">{operation.permissions.map((permission) => <span key={permission}>{permission}</span>)}</div>
        </div>
      )}

      <footer class="capability-operation-actions">
        {canConfirm && onInstall && (
          <button class="capability-button capability-button-primary" disabled={busy || offline || !hasConfirmationEvidence} onClick={onInstall}>
            {busy ? t('capabilities.working') : t('capabilities.installConfirm')}
          </button>
        )}
        {canCancel && onCancel && (
          <button class="capability-button" disabled={busy} onClick={onCancel}>
            {t('common.cancel')}
          </button>
        )}
        {operation.retryable && onRetry && (
          <button class="capability-button" disabled={busy || offline} onClick={onRetry}>
            {t('capabilities.retry')}
          </button>
        )}
      </footer>
    </section>
  );
}
