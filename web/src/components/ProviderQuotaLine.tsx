import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  formatProviderQuotaLabel,
  stripPercentDecimals,
  type ProviderQuotaMeta,
} from '@shared/provider-quota.js';
import { AGY_SDK_PROVIDER_ID } from '@shared/agy-agent.js';
import { isMobileLayout } from '../mobile-device.js';

export function isCompactProviderQuotaAgent(agentType: string | null | undefined): boolean {
  return agentType === 'codex' || agentType === 'codex-sdk' || agentType === 'claude-code-sdk' || agentType === AGY_SDK_PROVIDER_ID || agentType === 'grok-sdk' || agentType === 'muse-code-sdk';
}

/**
 * Keep every compact quota surface on the same provider formatter and clock.
 * In particular, 5h and 7d remain one text node (with the provider's ` · `
 * separator) rather than drifting into independently formatted rows.
 *
 * On mobile viewports / mobile devices, decimal places are omitted (e.g. "5%"
 * instead of "5.45%") to fit within narrow screen widths.
 */
export function useProviderQuotaLabel({
  quotaLabel,
  quotaMeta,
  now,
  precision,
  isMobile,
}: {
  quotaLabel?: string | null;
  quotaMeta?: ProviderQuotaMeta | null;
  now?: number;
  precision?: number;
  isMobile?: boolean;
}): string | null | undefined {
  const [quotaNow, setQuotaNow] = useState(() => Date.now());
  const [mobileLayout, setMobileLayout] = useState(() => (typeof window !== 'undefined' ? isMobileLayout() : false));

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const update = () => setMobileLayout(isMobileLayout());
    update();
    const media = window.matchMedia?.('(max-width: 720px)');
    media?.addEventListener?.('change', update);
    window.addEventListener('resize', update);
    return () => {
      media?.removeEventListener?.('change', update);
      window.removeEventListener('resize', update);
    };
  }, []);

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
    const isNarrow = isMobile ?? mobileLayout;
    const targetPrecision = precision !== undefined ? precision : (isNarrow ? 0 : undefined);
    if (!quotaMeta) {
      return isNarrow ? stripPercentDecimals(quotaLabel) : quotaLabel;
    }
    const formatted = formatProviderQuotaLabel(
      quotaMeta,
      now ?? quotaNow,
      targetPrecision !== undefined ? { precision: targetPrecision } : undefined,
    );
    if (formatted) return formatted;
    return isNarrow ? stripPercentDecimals(quotaLabel) : quotaLabel;
  }, [isMobile, mobileLayout, now, precision, quotaLabel, quotaMeta, quotaNow]);
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
