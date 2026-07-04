/**
 * CodexResetCredits — a small clickable affordance shown in the Codex usage
 * footer. Clicking opens a panel that lists the account's rate-limit reset
 * credits and lets the user consume one (with confirmation) to reset the
 * account's rate limits. Account-level, not per-session.
 *
 * Data flows over the existing WS bridge:
 *   list    → codex.reset_credits.list      → codex.reset_credits.list_response
 *   consume → codex.reset_credits.consume   → codex.reset_credits.consume_response
 * The codex OAuth token never reaches the browser — only the (non-secret)
 * credit list + consume outcome do.
 */
import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { WsClient, ServerMessage } from '../ws-client.js';
import { CODEX_RESET_CREDITS_MSG, type CodexResetCredit, type CodexConsumeOutcome } from '@shared/codex-reset-credits.js';

function newRequestId(): string {
  const rand = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Math.random()}`;
  return `codex-credits-${rand}`;
}

function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `idem-${Date.now()}-${Math.random()}`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  try {
    return new Date(ts).toLocaleDateString();
  } catch {
    return iso;
  }
}

export function CodexResetCredits({ wsClient, connected }: { wsClient: WsClient | null; connected: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [credits, setCredits] = useState<CodexResetCredit[] | null>(null);
  const [availableCount, setAvailableCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [consuming, setConsuming] = useState(false);
  const [outcome, setOutcome] = useState<CodexConsumeOutcome | null>(null);
  const listReqRef = useRef<string>('');
  const consumeReqRef = useRef<string>('');

  const requestList = useCallback(() => {
    if (!wsClient || !connected) { setError('offline'); return; }
    const reqId = newRequestId();
    listReqRef.current = reqId;
    setLoading(true);
    setError(null);
    setOutcome(null);
    wsClient.listCodexResetCredits(reqId);
  }, [wsClient, connected, t]);

  // Register the response handler while the panel is open.
  useEffect(() => {
    if (!open || !wsClient) return;
    const unsub = wsClient.onMessage((msg: ServerMessage) => {
      if (msg.type === CODEX_RESET_CREDITS_MSG.LIST_RESPONSE && msg.requestId === listReqRef.current) {
        setLoading(false);
        if (msg.ok) {
          setCredits(msg.credits ?? []);
          setAvailableCount(typeof msg.availableCount === 'number' ? msg.availableCount : null);
          setError(null);
        } else {
          setError(msg.error ?? 'error');
        }
      } else if (msg.type === CODEX_RESET_CREDITS_MSG.CONSUME_RESPONSE && msg.requestId === consumeReqRef.current) {
        setConsuming(false);
        setConfirmId(null);
        if (msg.ok) {
          setOutcome(msg.outcome ?? 'error');
          // Refresh the list to reflect the consumed credit.
          requestList();
        } else {
          setOutcome('error');
          setError(msg.error ?? 'error');
        }
      }
    });
    return unsub;
  }, [open, wsClient, requestList]);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next) { setOutcome(null); setConfirmId(null); requestList(); }
      return next;
    });
  }, [requestList]);

  const doConsume = useCallback((creditId: string) => {
    if (!wsClient || !connected) { setError('offline'); return; }
    const reqId = newRequestId();
    consumeReqRef.current = reqId;
    setConsuming(true);
    setError(null);
    void creditId; // server auto-selects an available credit; id is display-only.
    wsClient.consumeCodexResetCredit(reqId, newIdempotencyKey());
  }, [wsClient, connected, t]);

  const outcomeText = outcome
    ? t(`codex_credits.outcome_${outcome}`)
    : null;

  return (
    <div class="codex-credits" style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        class="codex-credits-trigger"
        onClick={toggle}
        title={t('codex_credits.title')}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', color: '#a78bfa',
          fontSize: 10, padding: '0 2px',
        }}
      >
        🎟 {t('codex_credits.button')}
        {availableCount != null ? ` (${availableCount})` : ''}
      </button>
      {open && (
        <div
          class="codex-credits-panel"
          style={{
            position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, zIndex: 50,
            minWidth: 240, maxWidth: 320, background: '#1f2937', border: '1px solid #374151',
            borderRadius: 6, padding: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.4)', fontSize: 11,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6, color: '#e5e7eb' }}>{t('codex_credits.title')}</div>
          {loading && <div style={{ color: '#9ca3af' }}>{t('codex_credits.loading')}</div>}
          {!loading && error && <div style={{ color: '#f87171' }}>{t(`codex_credits.error_${error}`, { defaultValue: t('codex_credits.error_generic') })}</div>}
          {!loading && !error && credits && credits.length === 0 && (
            <div style={{ color: '#9ca3af' }}>{t('codex_credits.none')}</div>
          )}
          {!loading && !error && credits && credits.map((c) => (
            <div key={c.id} class="codex-credits-item" style={{ padding: '4px 0', borderTop: '1px solid #374151' }}>
              <div style={{ color: '#e5e7eb' }}>{c.title || t('codex_credits.item_default_title')}</div>
              <div style={{ color: '#9ca3af', fontSize: 10 }}>
                {c.status}{c.expiresAt ? ` · ${t('codex_credits.expires', { date: formatDate(c.expiresAt) })}` : ''}
              </div>
              {c.status === 'available' && (
                confirmId === c.id ? (
                  <div style={{ marginTop: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ color: '#fbbf24', fontSize: 10 }}>{t('codex_credits.confirm')}</span>
                    <button type="button" onClick={() => doConsume(c.id)} disabled={consuming}
                      style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 10 }}>
                      {consuming ? t('codex_credits.consuming') : t('codex_credits.confirm_yes')}
                    </button>
                    <button type="button" onClick={() => setConfirmId(null)} disabled={consuming}
                      style={{ background: 'none', color: '#9ca3af', border: 'none', cursor: 'pointer', fontSize: 10 }}>
                      {t('codex_credits.cancel')}
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={() => { setOutcome(null); setConfirmId(c.id); }}
                    style={{ marginTop: 4, background: '#374151', color: '#e5e7eb', border: 'none', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 10 }}>
                    {t('codex_credits.reset_now')}
                  </button>
                )
              )}
            </div>
          ))}
          {outcomeText && (
            <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid #374151', color: outcome === 'reset' ? '#34d399' : '#fbbf24', fontSize: 10 }}>
              {outcomeText}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
