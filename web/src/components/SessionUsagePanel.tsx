import { useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { fetchUsageSummary, type UsageSummaryResponse } from '../api/usage-summary.js';
import { formatUsageNumber, formatUsageCost } from '../util/usage-format.js';
import { computeSessionGroup, emptyUsageTotals, type UsageTotals } from '../util/usage-group.js';

interface Props {
  /** The session whose group to open on. */
  targetSessionName: string;
  onClose: () => void;
}

const GROUP_SCOPE = '__group__';

/**
 * Compact, in-session usage panel opened from the session footer. Shows the
 * whole session group's aggregate (main + its sub-sessions), lets you focus a
 * single member, and switch to any other session's group — all from ONE
 * account-wide fetch (switching recomputes client-side, no refetch).
 */
export function SessionUsagePanel({ targetSessionName, onClose }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<UsageSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState(targetSessionName);
  // GROUP_SCOPE = the whole group aggregate; otherwise a specific member sessionName.
  const [focus, setFocus] = useState<string>(GROUP_SCOPE);

  useEffect(() => { setTarget(targetSessionName); setFocus(GROUP_SCOPE); }, [targetSessionName]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Account-wide, all-time, generous limit so an entire group's sessions are
    // present and switching between groups never needs another round-trip.
    fetchUsageSummary({ limit: 500 })
      .then((res) => { if (!cancelled) setData(res); })
      .catch(() => { if (!cancelled) setError(t('sessionUsage.error')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [t]);

  const group = useMemo(() => computeSessionGroup(data, target), [data, target]);
  const allSessions = useMemo(() => {
    if (!data) return [] as string[];
    return Array.from(new Set(
      [...data.byMainSession, ...data.bySubSession]
        .map((r) => r.sessionName)
        .filter((s): s is string => !!s),
    )).sort();
  }, [data]);

  const focused: UsageTotals = focus === GROUP_SCOPE
    ? group.groupTotals
    : (group.members.find((m) => m.sessionName === focus)?.totals ?? emptyUsageTotals());
  const unknown = t('usageSummary.unknown');

  return (
    <div class="session-usage-backdrop" onClick={onClose}>
      <div class="session-usage-panel" onClick={(e) => e.stopPropagation()}>
        <div class="session-usage-header">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, overflowWrap: 'anywhere' }}>{t('sessionUsage.title')}</div>
            <div style={{ fontSize: 12, color: '#94a3b8', overflowWrap: 'anywhere' }}>{group.root || target}</div>
          </div>
          <button class="btn btn-secondary" style={{ fontSize: 12, padding: '2px 8px' }} onClick={onClose} aria-label={t('sessionUsage.close')}>✕</button>
        </div>

        {/* Switch to any other session's group. */}
        {allSessions.length > 0 && (
          <label style={{ display: 'grid', gap: 4, marginBottom: 10 }}>
            <span style={{ fontSize: 11, color: '#94a3b8' }}>{t('sessionUsage.switchLabel')}</span>
            <select
              value={target}
              onInput={(e) => { setTarget((e.currentTarget as HTMLSelectElement).value); setFocus(GROUP_SCOPE); }}
              style={selectStyle}
            >
              {!allSessions.includes(target) && <option value={target}>{target}</option>}
              {allSessions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        )}

        {loading ? (
          <div style={mutedStyle}>{t('common.loading')}</div>
        ) : error ? (
          <div style={{ ...mutedStyle, color: '#f87171' }}>{error}</div>
        ) : group.members.length === 0 ? (
          <div style={mutedStyle}>{t('sessionUsage.empty')}</div>
        ) : (
          <>
            {/* Scope chips: whole group, or a single member. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              <ScopeChip active={focus === GROUP_SCOPE} onClick={() => setFocus(GROUP_SCOPE)}>
                {t('sessionUsage.group')}
              </ScopeChip>
              {group.members.map((m) => (
                <ScopeChip
                  key={m.sessionName}
                  active={focus === m.sessionName}
                  current={m.sessionName === targetSessionName}
                  onClick={() => setFocus(m.sessionName)}
                >
                  {shortName(m.sessionName)}{m.sessionName === targetSessionName ? ' ·' : ''}
                </ScopeChip>
              ))}
            </div>

            {/* Focused scope headline. */}
            <div style={headlineStyle}>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>
                {focus === GROUP_SCOPE ? t('sessionUsage.group') : shortName(focus)}
              </div>
              <div style={{ fontSize: 26, fontWeight: 700, color: '#f8fafc' }}>{formatUsageNumber(focused.totalTokens)}</div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>
                {formatUsageCost(focused.costUsdMicros, unknown)}
                {' · '}
                {t('sessionUsage.input')} {formatUsageNumber(focused.inputTokens)}
                {' · '}
                {t('sessionUsage.cache')} {formatUsageNumber(focused.cacheTokens)}
                {' · '}
                {t('sessionUsage.output')} {formatUsageNumber(focused.outputTokens)}
              </div>
            </div>

            {/* Per-member breakdown. */}
            <div style={{ display: 'grid', gap: 5, marginTop: 10 }}>
              {group.members.map((m) => (
                <button
                  key={m.sessionName}
                  onClick={() => setFocus(m.sessionName)}
                  style={{
                    ...memberRowStyle,
                    borderColor: m.sessionName === targetSessionName ? '#38bdf8' : '#1f2937',
                    background: focus === m.sessionName ? '#0b2536' : '#111827',
                  }}
                >
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
                    <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{shortName(m.sessionName)}</span>
                    <span style={{ color: '#64748b', fontSize: 11 }}> {m.kind === 'main' ? t('usageSummary.mainSession') : t('usageSummary.subSession')}</span>
                  </span>
                  <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <span style={{ fontWeight: 700 }}>{formatUsageNumber(m.totals.totalTokens)}</span>
                    <span style={{ color: '#94a3b8', fontSize: 11 }}> {formatUsageCost(m.totals.costUsdMicros, unknown)}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ScopeChip({ active, current, onClick, children }: { active: boolean; current?: boolean; onClick: () => void; children: preact.ComponentChildren }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 12,
        padding: '3px 9px',
        borderRadius: 6,
        cursor: 'pointer',
        border: `1px solid ${current ? '#38bdf8' : active ? '#475569' : '#1f2937'}`,
        background: active ? '#1e293b' : 'transparent',
        color: active ? '#f8fafc' : '#94a3b8',
        maxWidth: 180,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

/** Trim the `deck_{project}_` prefix for a compact display label. */
function shortName(sessionName: string): string {
  const m = /^deck_[^_]+_(.+)$/.exec(sessionName);
  return m ? m[1] : sessionName;
}

const selectStyle = {
  background: '#111827',
  border: '1px solid #334155',
  borderRadius: 6,
  color: '#e2e8f0',
  padding: '6px 8px',
  minWidth: 0,
  width: '100%',
} as const;
const mutedStyle = {
  color: '#94a3b8',
  fontSize: 13,
  padding: 20,
  textAlign: 'center',
} as const;
const headlineStyle = {
  background: '#0b1220',
  border: '1px solid #334155',
  borderRadius: 8,
  padding: 12,
} as const;
const memberRowStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: 10,
  alignItems: 'center',
  border: '1px solid #1f2937',
  borderRadius: 6,
  padding: '8px 10px',
  cursor: 'pointer',
  fontFamily: 'inherit',
} as const;
