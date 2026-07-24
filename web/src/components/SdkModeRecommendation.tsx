import { useTranslation } from 'react-i18next';
import { getSessionRuntimeType } from '@shared/agent-types.js';

/**
 * A banner shown under the agent-type picker when starting a main session or a
 * sub-session.
 *
 *  - SDK (transport) agent selected → a green recommendation: SDK streams
 *    output in real time and is more stable.
 *  - CLI (process) agent selected → a red warning: the CLI/process backend has
 *    been downgraded to reduced maintenance, and SDK is the actively developed
 *    path.
 *
 * All copy is i18n-driven (session.sdk_recommendation.*).
 */
export function SdkModeRecommendation({ agentType }: { agentType: string }) {
  const { t } = useTranslation();
  const isProcess = getSessionRuntimeType(agentType) === 'process';

  const theme = isProcess
    ? { bg: 'rgba(239, 68, 68, 0.10)', border: 'rgba(239, 68, 68, 0.55)', title: '#fca5a5', text: '#fecaca', icon: '⚠️' }
    : { bg: 'rgba(34, 197, 94, 0.10)', border: 'rgba(34, 197, 94, 0.45)', title: '#86efac', text: '#bbf7d0', icon: '✅' };

  const titleKey = isProcess ? 'session.sdk_recommendation.warn_title' : 'session.sdk_recommendation.title';
  const bodyKey = isProcess ? 'session.sdk_recommendation.warn_body' : 'session.sdk_recommendation.body';

  return (
    <div
      role="note"
      style={{
        marginTop: 10,
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '8px 12px',
        background: theme.bg,
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        color: theme.text,
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <span aria-hidden="true">{theme.icon}</span>
      <span style={{ minWidth: 0, overflowWrap: 'break-word' }}>
        <strong style={{ color: theme.title }}>{t(titleKey)}</strong>{' '}
        {t(bodyKey)}
      </span>
    </div>
  );
}
