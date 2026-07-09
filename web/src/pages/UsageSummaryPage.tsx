import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  fetchUsageSummary,
  type UsageSummaryQuery,
  type UsageSummaryResponse,
  type UsageSummaryRow,
} from '../api/usage-summary.js';

interface Props {
  onBack: () => void;
}

export function UsageSummaryPage({ onBack }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState<UsageSummaryQuery>(() => defaultQuery());
  const [draft, setDraft] = useState<UsageSummaryQuery>(() => defaultQuery());
  const [summary, setSummary] = useState<UsageSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextQuery: UsageSummaryQuery) => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchUsageSummary(nextQuery);
      setSummary(next);
    } catch {
      setError(t('usageSummary.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load(query);
  }, [load, query]);

  const totalCost = useMemo(() => formatCost(summary?.accountTotal.costUsdMicros ?? null, t), [summary, t]);

  const updateDraft = (key: keyof UsageSummaryQuery, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value || undefined }));
  };

  const applyFilters = () => {
    const clean: UsageSummaryQuery = {};
    for (const [key, value] of Object.entries(draft)) {
      if (value !== undefined && value !== '') {
        (clean as Record<string, unknown>)[key] = value;
      }
    }
    setQuery(clean);
  };

  return (
    <div style={{ background: '#0a0e1a', color: '#e2e8f0', minHeight: '100%', padding: 20, overflowY: 'auto' }}>
      <div style={{ maxWidth: 1120, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <button class="btn btn-secondary" onClick={onBack}>{t('usageSummary.back')}</button>
          <h1 style={{ margin: 0, fontSize: 24 }}>{t('usageSummary.title')}</h1>
          <button class="btn" style={{ marginLeft: 'auto' }} onClick={() => void load(query)}>{t('common.refresh')}</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 16 }}>
          <FilterInput label={t('usageSummary.from')} type="date" value={draft.from ?? ''} onInput={(value) => updateDraft('from', value)} />
          <FilterInput label={t('usageSummary.to')} type="date" value={draft.to ?? ''} onInput={(value) => updateDraft('to', value)} />
          <FilterInput label={t('usageSummary.server')} value={draft.serverId ?? ''} onInput={(value) => updateDraft('serverId', value)} />
          <FilterInput label={t('usageSummary.provider')} value={draft.provider ?? ''} onInput={(value) => updateDraft('provider', value)} />
          <FilterInput label={t('usageSummary.model')} value={draft.model ?? ''} onInput={(value) => updateDraft('model', value)} />
          <FilterInput label={t('usageSummary.session')} value={draft.sessionName ?? ''} onInput={(value) => updateDraft('sessionName', value)} />
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('usageSummary.kind')}</span>
            <select
              value={draft.sessionKind ?? ''}
              onInput={(event) => updateDraft('sessionKind', (event.currentTarget as HTMLSelectElement).value)}
              style={inputStyle}
            >
              <option value="">{t('usageSummary.anyKind')}</option>
              <option value="main">{t('usageSummary.mainSession')}</option>
              <option value="sub">{t('usageSummary.subSession')}</option>
            </select>
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('usageSummary.order')}</span>
            <select
              value={draft.order ?? 'desc'}
              onInput={(event) => updateDraft('order', (event.currentTarget as HTMLSelectElement).value)}
              style={inputStyle}
            >
              <option value="desc">{t('usageSummary.desc')}</option>
              <option value="asc">{t('usageSummary.asc')}</option>
            </select>
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
          <button class="btn" onClick={applyFilters}>{t('usageSummary.apply')}</button>
          <button class="btn btn-secondary" onClick={() => { const next = defaultQuery(); setDraft(next); setQuery(next); }}>{t('usageSummary.clear')}</button>
        </div>

        {loading ? (
          <div style={mutedBlockStyle}>{t('common.loading')}</div>
        ) : error ? (
          <div style={{ ...mutedBlockStyle, color: '#f87171' }}>{error}</div>
        ) : !summary || summary.accountTotal.factCount === 0 ? (
          <div style={mutedBlockStyle}>{t('usageSummary.empty')}</div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 16 }}>
              <Metric label={t('usageSummary.totalTokens')} value={formatNumber(summary.accountTotal.totalTokens)} />
              <Metric label={t('usageSummary.facts')} value={formatNumber(summary.accountTotal.factCount)} />
              <Metric label={t('usageSummary.cost')} value={totalCost} detail={t(`usageSummary.costCompleteness.${summary.accountTotal.costCompleteness}`)} />
            </div>
            <Section title={t('usageSummary.byDate')} rows={summary.byDate} renderLabel={(row) => row.date ?? row.label ?? row.key} t={t} />
            <Section title={t('usageSummary.byServer')} rows={summary.byServer} renderLabel={(row) => row.serverId ?? row.label ?? row.key} t={t} />
            <Section title={t('usageSummary.byProviderModel')} rows={summary.byProviderModel} renderLabel={(row) => `${labelOrUnknown(row.provider, t)} / ${labelOrUnknown(row.model, t)}`} t={t} />
            <Section title={t('usageSummary.byMainSession')} rows={summary.byMainSession} renderLabel={(row) => `${row.sessionName ?? row.key} · ${t('usageSummary.mainSession')}`} t={t} />
            <Section title={t('usageSummary.bySubSession')} rows={summary.bySubSession} renderLabel={(row) => `${row.sessionName ?? row.key} · ${t('usageSummary.subSession')} · ${t('usageSummary.parent')}: ${labelOrUnknown(row.parentSessionName, t)}`} t={t} />
            <Section title={t('usageSummary.byParentSession')} rows={summary.byParentSession} renderLabel={(row) => labelOrUnknown(row.parentSessionName ?? row.label, t)} t={t} />
            <Section title={t('usageSummary.bySessionModelDate')} rows={summary.bySessionModelDate} renderLabel={(row) => `${row.date ?? ''} · ${row.sessionName ?? row.key} · ${labelOrUnknown(row.model, t)}`} t={t} />
          </>
        )}
      </div>
    </div>
  );
}

function defaultQuery(): UsageSummaryQuery {
  const now = new Date();
  const from = new Date(now);
  from.setDate(now.getDate() - 30);
  return {
    from: toDateInput(from),
    to: toDateInput(now),
    order: 'desc',
  };
}

function FilterInput(props: { label: string; value: string; type?: string; onInput: (value: string) => void }) {
  return (
    <label style={fieldStyle}>
      <span style={labelStyle}>{props.label}</span>
      <input
        type={props.type ?? 'text'}
        value={props.value}
        onInput={(event) => props.onInput((event.currentTarget as HTMLInputElement).value)}
        style={inputStyle}
      />
    </label>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div style={metricStyle}>
      <div style={{ color: '#94a3b8', fontSize: 12 }}>{label}</div>
      <div style={{ color: '#f8fafc', fontSize: 24, fontWeight: 700 }}>{value}</div>
      {detail && <div style={{ color: '#64748b', fontSize: 12 }}>{detail}</div>}
    </div>
  );
}

function Section({
  title,
  rows,
  renderLabel,
  t,
}: {
  title: string;
  rows: UsageSummaryRow[];
  renderLabel: (row: UsageSummaryRow) => string;
  t: (key: string) => string;
}) {
  return (
    <section style={{ marginBottom: 18 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>{title}</h2>
      {rows.length === 0 ? (
        <div style={smallEmptyStyle}>{t('usageSummary.noRows')}</div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {rows.map((row) => (
            <div key={`${title}:${row.key}`} style={rowStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: '#e2e8f0', fontWeight: 600, overflowWrap: 'anywhere' }}>{renderLabel(row)}</div>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>
                  {row.metadataCompleteness === 'partial' ? t('usageSummary.partialMetadata') : null}
                </div>
              </div>
              <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <div style={{ fontWeight: 700 }}>{formatNumber(row.totalTokens)}</div>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>{formatCost(row.costUsdMicros, t)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function labelOrUnknown(value: string | null | undefined, t: (key: string) => string): string {
  return value && value.trim() ? value : t('usageSummary.unknown');
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatCost(micros: number | null, t: (key: string) => string): string {
  if (micros == null) return t('usageSummary.unknown');
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(micros / 1_000_000);
}

function toDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const fieldStyle = { display: 'grid', gap: 4 } as const;
const labelStyle = { color: '#94a3b8', fontSize: 12 } as const;
const inputStyle = {
  background: '#111827',
  border: '1px solid #334155',
  borderRadius: 6,
  color: '#e2e8f0',
  padding: '8px 10px',
  minWidth: 0,
} as const;
const metricStyle = {
  background: '#111827',
  border: '1px solid #334155',
  borderRadius: 8,
  padding: 14,
} as const;
const rowStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: 12,
  alignItems: 'center',
  background: '#111827',
  border: '1px solid #1f2937',
  borderRadius: 6,
  padding: '10px 12px',
} as const;
const mutedBlockStyle = {
  background: '#111827',
  border: '1px solid #334155',
  borderRadius: 8,
  color: '#94a3b8',
  padding: 24,
  textAlign: 'center',
} as const;
const smallEmptyStyle = {
  color: '#64748b',
  fontSize: 13,
  padding: '8px 0',
} as const;
