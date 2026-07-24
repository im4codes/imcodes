import { useTranslation } from 'react-i18next';
import { getSessionRuntimeType } from '@shared/agent-types.js';

/**
 * A small green recommendation banner nudging users toward SDK (transport)
 * agents when starting a main session or a sub-session. SDK sessions stream
 * output in real time and avoid the tmux/CLI process backend, so they are
 * more stable. When a CLI (process) agent is currently selected, an extra
 * line invites the user to switch.
 *
 * All copy is i18n-driven (session.sdk_recommendation.*).
 */
export function SdkModeRecommendation({ agentType }: { agentType: string }) {
  const { t } = useTranslation();
  const isProcess = getSessionRuntimeType(agentType) === 'process';
  return (
    <div
      role="note"
      style={{
        marginTop: 10,
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '8px 12px',
        background: 'rgba(34, 197, 94, 0.10)',
        border: '1px solid rgba(34, 197, 94, 0.45)',
        borderRadius: 6,
        color: '#bbf7d0',
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <span aria-hidden="true">✅</span>
      <span style={{ minWidth: 0, overflowWrap: 'break-word' }}>
        <strong style={{ color: '#86efac' }}>{t('session.sdk_recommendation.title')}</strong>{' '}
        {t('session.sdk_recommendation.body')}
        {isProcess ? <>{' '}{t('session.sdk_recommendation.process_hint')}</> : null}
      </span>
    </div>
  );
}
