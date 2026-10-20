/**
 * Renders the daemon-injected agent-delegation protocol markers
 * (`shared/agent-delegation-markers.ts`) as compact, collapsed-by-default
 * cards instead of their raw tagged text — the exact bytes still reach the
 * receiving agent unchanged; this only changes what a human reading the
 * transcript sees.
 */
import { useTranslation } from 'react-i18next';
import type { DelegationReplyInstructionCard, DelegationSenderCard } from '@shared/agent-delegation-markers.js';

export function DelegationSenderCardView({ card }: { card: DelegationSenderCard }) {
  const { t } = useTranslation();
  return (
    <details class="delegation-protocol-card delegation-protocol-card--sender">
      <summary>
        {t('delegation.protocol.sender_summary', {
          defaultValue: 'From {{sessionName}}',
          sessionName: card.label ? `${card.label} (${card.sessionName})` : card.sessionName,
        })}
      </summary>
      <div class="delegation-protocol-card-body">
        <span class="delegation-protocol-card-field">
          {t('delegation.protocol.sender_session', 'Session')}
          {': '}
          <code>{card.sessionName}</code>
        </span>
        {card.label && (
          <span class="delegation-protocol-card-field">
            {t('delegation.protocol.sender_label', 'Label')}
            {': '}
            <code>{card.label}</code>
          </span>
        )}
      </div>
    </details>
  );
}

export function DelegationReplyInstructionCardView({ card }: { card: DelegationReplyInstructionCard }) {
  const { t } = useTranslation();
  const toolLabel = card.replyTool
    ? t(`delegation.protocol.reply_tool_${card.replyTool}`, card.replyTool)
    : t('delegation.protocol.reply_tool_generic', 'imcodes send');
  return (
    <details class="delegation-protocol-card delegation-protocol-card--reply">
      <summary>
        {t('delegation.protocol.reply_summary', {
          defaultValue: 'Reply via {{tool}}{{target}}',
          tool: toolLabel,
          target: card.target ? ` → ${card.target}` : '',
        })}
      </summary>
      <div class="delegation-protocol-card-body">
        {card.target && (
          <span class="delegation-protocol-card-field">
            {t('delegation.protocol.reply_target', 'Reply target')}
            {': '}
            <code>{card.target}</code>
          </span>
        )}
        {card.delegationId && (
          <span class="delegation-protocol-card-field">
            {t('delegation.protocol.reply_delegation_id', 'Delegation ID')}
            {': '}
            <code>{card.delegationId}</code>
          </span>
        )}
        <details class="delegation-protocol-card-raw">
          <summary>{t('delegation.protocol.reply_raw', 'Raw instruction')}</summary>
          <pre>{card.raw}</pre>
        </details>
      </div>
    </details>
  );
}
