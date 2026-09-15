/**
 * CodexCreditBalance — the account's pay-as-you-go usage credit balance
 * (bought once the plan's included 5h/weekly quota runs out), shown as a
 * small live badge immediately to the left of the Codex quota block.
 * Clicking it opens a panel listing recorded consumption (balance decreases
 * between recorded snapshots — a top-up is not consumption).
 *
 * DIFFERENT from CodexResetCredits (the 🎟 button to its left): that spends a
 * bonus credit to force-reset the 5h/weekly rate-limit window early, and has
 * no balance of its own. This shows a real spendable dollar balance.
 *
 * The current balance rides the ordinary session-sync channel (props, from
 * SessionRecord.codexCreditsBalance) so it's always up to date without the
 * panel ever being opened. History flows over the existing WS bridge:
 *   codex.credit_history.request → codex.credit_history.response
 * mirroring CodexResetCredits' list/consume round trip exactly.
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { WsClient, ServerMessage } from '../ws-client.js';
import {
  CODEX_CREDIT_HISTORY_MSG,
  type CodexCreditSnapshot,
  formatCodexCreditBalance,
  deriveCodexCreditConsumptionEvents,
} from '@shared/codex-credit-history.js';

const PANEL_WIDTH = 280;
const PANEL_MARGIN = 8;

function newRequestId(): string {
  const rand = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Math.random()}`;
  return `codex-credit-hist-${rand}`;
}

export function formatCodexCreditSnapshotTime(capturedAt: number, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(capturedAt));
  } catch {
    return new Date(capturedAt).toLocaleString();
  }
}

interface Props {
  wsClient: WsClient | null;
  connected: boolean;
  /** SessionRecord.codexCreditsBalance — the caller only renders this component once a value has actually been observed. */
  balance?: string | null;
  unlimited?: boolean | null;
}

export function CodexCreditBalance({ wsClient, connected, balance, unlimited }: Props) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [snapshots, setSnapshots] = useState<CodexCreditSnapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [panelPosition, setPanelPosition] = useState<{ left: number; bottom: number; maxWidth: number; maxHeight: number } | null>(null);
  const reqRef = useRef<string>('');

  const updatePanelPosition = useCallback(() => {
    if (typeof window === 'undefined') return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const maxWidth = Math.max(120, window.innerWidth - PANEL_MARGIN * 2);
    const width = Math.min(PANEL_WIDTH, maxWidth);
    const desiredLeft = rect.left + (rect.width / 2) - (width / 2);
    const maxLeft = Math.max(PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN);
    const left = Math.min(Math.max(PANEL_MARGIN, desiredLeft), maxLeft);
    const bottom = Math.max(PANEL_MARGIN, window.innerHeight - rect.top + 4);
    const maxHeight = Math.max(120, rect.top - PANEL_MARGIN - 4);
    setPanelPosition({ left, bottom, maxWidth: width, maxHeight });
  }, []);

  const requestHistory = useCallback(() => {
    if (!wsClient || !connected) { setError('offline'); return; }
    const reqId = newRequestId();
    reqRef.current = reqId;
    setLoading(true);
    setError(null);
    wsClient.requestCodexCreditHistory(reqId);
  }, [wsClient, connected]);

  // Register the response handler while the panel is open.
  useEffect(() => {
    if (!open || !wsClient) return;
    const unsub = wsClient.onMessage((msg: ServerMessage) => {
      if (msg.type === CODEX_CREDIT_HISTORY_MSG.RESPONSE && msg.requestId === reqRef.current) {
        setLoading(false);
        if (msg.ok) {
          setSnapshots(msg.snapshots ?? []);
          setError(null);
        } else {
          setError(msg.error ?? 'error');
        }
      }
    });
    return unsub;
  }, [open, wsClient]);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next) {
        updatePanelPosition();
        requestHistory();
      }
      return next;
    });
  }, [requestHistory, updatePanelPosition]);

  useEffect(() => {
    if (!open) {
      setPanelPosition(null);
      return;
    }
    updatePanelPosition();
    window.addEventListener('resize', updatePanelPosition);
    window.addEventListener('scroll', updatePanelPosition, true);
    return () => {
      window.removeEventListener('resize', updatePanelPosition);
      window.removeEventListener('scroll', updatePanelPosition, true);
    };
  }, [open, updatePanelPosition]);

  const events = useMemo(() => deriveCodexCreditConsumptionEvents(snapshots ?? []), [snapshots]);
  const displayBalance = formatCodexCreditBalance(balance ?? undefined, unlimited === true);

  return (
    <div class="codex-credit-balance">
      <button
        ref={triggerRef}
        type="button"
        class="codex-credit-balance-trigger"
        onClick={toggle}
        title={t('codex_credit_balance.title')}
      >
        💳 {displayBalance}
      </button>
      {open && (
        <div
          class="codex-credit-balance-panel"
          style={{
            left: panelPosition ? `${panelPosition.left}px` : `${PANEL_MARGIN}px`,
            bottom: panelPosition ? `${panelPosition.bottom}px` : `${PANEL_MARGIN}px`,
            maxWidth: panelPosition ? `${panelPosition.maxWidth}px` : `calc(100vw - ${PANEL_MARGIN * 2}px)`,
            maxHeight: panelPosition ? `${panelPosition.maxHeight}px` : `calc(100vh - ${PANEL_MARGIN * 2}px)`,
          }}
        >
          <div class="codex-credit-balance-panel-header">
            <div class="codex-credit-balance-panel-title">{t('codex_credit_balance.history_title')}</div>
            <button
              type="button"
              class="codex-credit-balance-refresh"
              onClick={requestHistory}
              disabled={loading || !connected}
              title={t('codex_credits.refresh')}
              aria-label={t('codex_credits.refresh')}
            >
              ↻
            </button>
          </div>
          {loading && <div style={{ color: '#9ca3af' }}>{t('codex_credits.loading')}</div>}
          {!loading && error && <div style={{ color: '#f87171' }}>{t('codex_credit_balance.error_generic')}</div>}
          {!loading && !error && events.length === 0 && (
            <div style={{ color: '#9ca3af' }}>{t('codex_credit_balance.no_consumption')}</div>
          )}
          {!loading && !error && events.map((event) => (
            <div key={event.atCapturedAt} class="codex-credit-balance-item" style={{ padding: '4px 0', borderTop: '1px solid #374151' }}>
              <div style={{ color: '#e5e7eb' }}>
                {t('codex_credit_balance.spent', { amount: event.spent })}
              </div>
              <div style={{ color: '#9ca3af', fontSize: 10 }}>
                {formatCodexCreditSnapshotTime(event.atCapturedAt, i18n.resolvedLanguage ?? i18n.language)}
                {' · '}
                {t('codex_credit_balance.balance_now', { amount: formatCodexCreditBalance(event.toBalance) })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
