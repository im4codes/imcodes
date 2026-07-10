import { useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { fetchUsageSummary, type UsageSummaryResponse, type UsageSummaryRow } from '../api/usage-summary.js';
import { formatUsageNumber, formatUsageCost } from '../util/usage-format.js';
import { bucketRowsByWeek } from '../util/usage-group.js';
import { watchProjectionStore } from '../watch-projection.js';

interface Props {
  /** A session in the group to open on (main session, or one of its subs). */
  targetSessionName: string;
  onClose: () => void;
}

type Period = '7d' | '30d' | 'all';
type Breakdown = 'day' | 'week';

interface SessionMeta { title: string; badge: string; parent?: string; isSub: boolean; serverId: string; }

/**
 * Compact, in-session usage panel opened from the session footer. Scoped
 * STRICTLY to the current main session's group (that main + its sub-sessions —
 * never other groups), via the server `groupSession` filter. Shows the group
 * total for a chosen period, a by-day / by-week breakdown with the exact date
 * range, per-member usage, and a provider/model breakdown. Sessions are shown by
 * their friendly label (from the live session snapshot), not the raw deck_ name.
 */
export function SessionUsagePanel({ targetSessionName, onClose }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<UsageSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('30d');
  const [breakdown, setBreakdown] = useState<Breakdown>('day');

  // Session labels + group structure come from the live snapshot, so we show the
  // user's friendly names instead of raw session ids.
  const meta = useMemo(() => buildSessionMeta(), []);
  const root = useMemo(() => resolveGroupRoot(meta, targetSessionName), [meta, targetSessionName]);
  // Scope to the CURRENT server so the same session name on another machine
  // isn't merged in (that produced duplicate "Main session" rows). Falls back to
  // account-wide when the session isn't in the live snapshot.
  const serverId = meta.get(root)?.serverId ?? meta.get(targetSessionName)?.serverId;
  const range = useMemo(() => periodRange(period), [period]);
  const label = (name: string): string => meta.get(name)?.title || shortName(name);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchUsageSummary({ groupSession: root, serverId, from: range.from, to: range.to, limit: 500 })
      .then((res) => { if (!cancelled) setData(res); })
      .catch(() => { if (!cancelled) setError(t('sessionUsage.error')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [root, serverId, range.from, range.to, t]);

  const members = useMemo(() => {
    if (!data) return [] as UsageSummaryRow[];
    return [...data.byMainSession, ...data.bySubSession];
  }, [data]);
  const byWeek = useMemo(() => (data ? bucketRowsByWeek(data.byDate) : []), [data]);
  const unknown = t('usageSummary.unknown');
  const total = data?.accountTotal;

  // Exact covered range: the server echoes from/to; for "all time" fall back to
  // the first/last day that actually has data so the number isn't a mystery.
  const coveredRange = useMemo(() => {
    if (range.from && range.to) return `${range.from} → ${range.to}`;
    const dates = (data?.byDate ?? []).map((r) => r.date).filter((d): d is string => !!d).sort();
    if (dates.length === 0) return t('sessionUsage.rangeAll');
    return `${dates[0]} → ${dates[dates.length - 1]}`;
  }, [range.from, range.to, data, t]);

  return (
    <div class="session-usage-backdrop" onClick={onClose}>
      <div class="session-usage-panel" onClick={(e) => e.stopPropagation()}>
        <div class="session-usage-header">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, overflowWrap: 'anywhere' }}>{t('sessionUsage.title')}</div>
            <div style={{ fontSize: 12, color: '#94a3b8', overflowWrap: 'anywhere' }}>
              {label(root)}
              {meta.get(root)?.badge ? <span style={{ color: '#64748b' }}> · {meta.get(root)?.badge}</span> : null}
            </div>
          </div>
          <button class="btn btn-secondary" style={{ fontSize: 12, padding: '2px 8px' }} onClick={onClose} aria-label={t('sessionUsage.close')}>✕</button>
        </div>

        {/* Period selector + the exact date range it covers. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 }}>
          {(['7d', '30d', 'all'] as Period[]).map((p) => (
            <Chip key={p} active={period === p} onClick={() => setPeriod(p)}>
              {t(`sessionUsage.period.${p}`)}
            </Chip>
          ))}
          <span style={{ fontSize: 11, color: '#64748b', marginLeft: 'auto' }}>{coveredRange}</span>
        </div>

        {loading ? (
          <div style={mutedStyle}>{t('common.loading')}</div>
        ) : error ? (
          <div style={{ ...mutedStyle, color: '#f87171' }}>{error}</div>
        ) : !total || total.factCount === 0 ? (
          <div style={mutedStyle}>{t('sessionUsage.empty')}</div>
        ) : (
          <>
            <div style={headlineStyle}>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>{t('sessionUsage.group')}</div>
              <div style={{ fontSize: 26, fontWeight: 700, color: '#f8fafc' }}>{formatUsageNumber(total.totalTokens)}</div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>
                {formatUsageCost(total.costUsdMicros, unknown)}
                {' · '}{t('sessionUsage.input')} {formatUsageNumber(total.inputTokens)}
                {' · '}{t('sessionUsage.cache')} {formatUsageNumber(total.cacheTokens)}
                {' · '}{t('sessionUsage.output')} {formatUsageNumber(total.outputTokens)}
              </div>
            </div>

            {/* By day / by week. */}
            <div style={{ display: 'flex', gap: 6, margin: '12px 0 6px' }}>
              <Chip active={breakdown === 'day'} onClick={() => setBreakdown('day')}>{t('sessionUsage.byDay')}</Chip>
              <Chip active={breakdown === 'week'} onClick={() => setBreakdown('week')}>{t('sessionUsage.byWeek')}</Chip>
            </div>
            <RowList
              rows={breakdown === 'day'
                ? data!.byDate.map((r) => ({ label: r.date ?? r.key, tokens: r.totalTokens, cost: r.costUsdMicros }))
                : byWeek.map((w) => ({ label: weekRangeLabel(w.key), tokens: w.totals.totalTokens, cost: w.totals.costUsdMicros }))}
              unknown={unknown}
              emptyLabel={t('sessionUsage.empty')}
            />

            {/* Per-member (main + subs), shown by friendly label. */}
            <div style={sectionTitleStyle}>{t('sessionUsage.members')}</div>
            <RowList
              rows={members.map((m) => ({
                label: label(m.sessionName ?? m.key),
                sub: m.sessionKind === 'sub' ? t('usageSummary.subSession') : t('usageSummary.mainSession'),
                tokens: m.totalTokens,
                cost: m.costUsdMicros,
                highlight: m.sessionName === targetSessionName,
              }))}
              unknown={unknown}
              emptyLabel={t('sessionUsage.empty')}
            />

            {/* Provider / model breakdown for the group. */}
            {data!.byProviderModel.length > 0 && (
              <>
                <div style={sectionTitleStyle}>{t('usageSummary.byProviderModel')}</div>
                <RowList
                  rows={data!.byProviderModel.map((r) => ({
                    label: `${r.provider ?? r.agentType ?? unknown} / ${r.model ?? unknown}`,
                    tokens: r.totalTokens,
                    cost: r.costUsdMicros,
                  }))}
                  unknown={unknown}
                  emptyLabel={t('sessionUsage.empty')}
                />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RowList({ rows, unknown, emptyLabel }: {
  rows: { label: string; sub?: string; tokens: number; cost: number | null; highlight?: boolean }[];
  unknown: string;
  emptyLabel: string;
}) {
  if (rows.length === 0) return <div style={{ ...mutedStyle, padding: 10 }}>{emptyLabel}</div>;
  return (
    <div style={{ display: 'grid', gap: 5 }}>
      {rows.map((r, i) => (
        <div
          key={`${r.label}:${i}`}
          style={{ ...rowStyle, borderColor: r.highlight ? '#38bdf8' : '#1f2937' }}
        >
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{r.label}</span>
            {r.sub ? <span style={{ color: '#64748b', fontSize: 11 }}> {r.sub}</span> : null}
          </span>
          <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
            <span style={{ fontWeight: 700 }}>{formatUsageNumber(r.tokens)}</span>
            <span style={{ color: '#94a3b8', fontSize: 11 }}> {formatUsageCost(r.cost, unknown)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: preact.ComponentChildren }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 12,
        padding: '3px 10px',
        borderRadius: 6,
        cursor: 'pointer',
        border: `1px solid ${active ? '#475569' : '#1f2937'}`,
        background: active ? '#1e293b' : 'transparent',
        color: active ? '#f8fafc' : '#94a3b8',
      }}
    >
      {children}
    </button>
  );
}

/** Snapshot of session labels + group structure from the live projection store. */
function buildSessionMeta(): Map<string, SessionMeta> {
  const map = new Map<string, SessionMeta>();
  try {
    for (const s of watchProjectionStore.getSnapshot().sessions) {
      map.set(s.sessionName, {
        title: s.title,
        badge: s.agentBadge,
        parent: s.parentSessionName,
        isSub: s.isSubSession,
        serverId: s.serverId,
      });
    }
  } catch { /* snapshot unavailable — fall back to shortName */ }
  return map;
}

/** The group root = the target's parent when it's a sub, else the target itself. */
export function resolveGroupRoot(meta: Map<string, SessionMeta>, target: string): string {
  const m = meta.get(target);
  if (m?.isSub && m.parent && m.parent.trim()) return m.parent;
  return target;
}

export function periodRange(period: Period): { from?: string; to?: string } {
  if (period === 'all') return {};
  const days = period === '7d' ? 7 : 30;
  const now = new Date();
  const from = new Date(now);
  from.setDate(now.getDate() - days);
  return { from: toDateInput(from), to: toDateInput(now) };
}

function toDateInput(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** A week shown as its Monday→Sunday date range (unambiguous, unlike "当周"). */
function weekRangeLabel(mondayStr: string): string {
  const d = new Date(`${mondayStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return `${mondayStr} → ${d.toISOString().slice(0, 10)}`;
}

/** Fallback compact label when a session isn't in the snapshot: strip deck_{proj}_. */
function shortName(sessionName: string): string {
  const m = /^deck_[^_]+_(.+)$/.exec(sessionName);
  return m ? m[1] : sessionName;
}

const mutedStyle = { color: '#94a3b8', fontSize: 13, padding: 20, textAlign: 'center' } as const;
const headlineStyle = { background: '#0b1220', border: '1px solid #334155', borderRadius: 8, padding: 12 } as const;
const sectionTitleStyle = { fontSize: 12, color: '#94a3b8', fontWeight: 600, margin: '14px 0 6px' } as const;
const rowStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: 10,
  alignItems: 'center',
  border: '1px solid #1f2937',
  borderRadius: 6,
  padding: '8px 10px',
  background: '#111827',
} as const;
