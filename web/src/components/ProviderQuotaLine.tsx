import { useEffect, useMemo, useState } from 'preact/hooks';
import { formatProviderQuotaLabel, type ProviderQuotaMeta } from '@shared/provider-quota.js';

export function isCompactProviderQuotaAgent(agentType: string | null | undefined): boolean {
  return agentType === 'codex' || agentType === 'codex-sdk' || agentType === 'claude-code-sdk';
}

/**
 * Keep every compact quota surface on the same provider formatter and clock.
 * In particular, 5h and 7d remain one text node (with the provider's ` · `
 * separator) rather than drifting into independently formatted rows.
 */
export function useProviderQuotaLabel({
  quotaLabel,
  quotaMeta,
  now,
}: {
  quotaLabel?: string | null;
  quotaMeta?: ProviderQuotaMeta | null;
  now?: number;
}): string | null | undefined {
  const [quotaNow, setQuotaNow] = useState(() => Date.now());

  useEffect(() => {
    if (!quotaMeta || now !== undefined) return;
    let intervalId: number | undefined;
    const tick = () => setQuotaNow(Date.now());
    tick();
    const delay = Math.max(250, 60_000 - (Date.now() % 60_000));
    const timeoutId = window.setTimeout(() => {
      tick();
      intervalId = window.setInterval(tick, 60_000);
    }, delay);
    return () => {
      window.clearTimeout(timeoutId);
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, [now, quotaMeta]);

  return useMemo(() => {
    if (!quotaMeta) return quotaLabel;
    return formatProviderQuotaLabel(quotaMeta, now ?? quotaNow) ?? quotaLabel;
  }, [now, quotaLabel, quotaMeta, quotaNow]);
}

export function ProviderQuotaLine({
  text,
  className = '',
  title,
}: {
  text: string;
  className?: string;
  title?: string;
}) {
  return (
    <span
      class={`session-usage-codex-line session-usage-codex-line-compact${className ? ` ${className}` : ''}`}
      title={title}
    >
      {text}
    </span>
  );
}
