import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  getRuntimeAuthoredContext,
  getSharedContextDiagnostics,
  listTeams,
  type RuntimeAuthoredContextBindingView,
  type SharedContextDiagnosticsView,
  type TeamSummary,
} from '../api.js';

const CD_IS_MOBILE = typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

const shellStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: CD_IS_MOBILE ? 10 : 14,
  padding: CD_IS_MOBILE ? 8 : 12,
  color: '#e2e8f0',
  overflow: 'auto',
  WebkitOverflowScrolling: 'touch',
  background: 'radial-gradient(circle at top left, rgba(14,165,233,0.12), transparent 30%), #0b1220',
  fontSize: CD_IS_MOBILE ? 12 : 13,
} as const;

const sectionStyle = {
  border: '1px solid #334155',
  borderRadius: CD_IS_MOBILE ? 10 : 16,
  padding: CD_IS_MOBILE ? 10 : 14,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  background: 'linear-gradient(180deg, #111827 0%, #0f172a 100%)',
  boxShadow: 'inset 0 1px 0 rgba(148,163,184,0.06)',
} as const;

const heroStyle = {
  ...sectionStyle,
  gap: 14,
  background: 'linear-gradient(145deg, rgba(30,41,59,0.98) 0%, rgba(15,23,42,0.98) 100%)',
  border: '1px solid rgba(56,189,248,0.18)',
} as const;

const rowStyle = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
  alignItems: 'center',
} as const;

const inputStyle = {
  flex: CD_IS_MOBILE ? '1 1 100%' : '1 1 180px',
  minWidth: 0,
  background: '#0f172a',
  color: '#e2e8f0',
  border: '1px solid #334155',
  borderRadius: 8,
  padding: CD_IS_MOBILE ? '10px 12px' : '8px 10px',
  fontSize: CD_IS_MOBILE ? 14 : 13,
} as const;

const buttonStyle = {
  background: '#0ea5e9',
  color: '#eff6ff',
  border: 'none',
  borderRadius: 8,
  padding: CD_IS_MOBILE ? '10px 16px' : '8px 12px',
  cursor: 'pointer',
  fontWeight: 700,
  fontSize: CD_IS_MOBILE ? 14 : 13,
  ...(CD_IS_MOBILE ? { width: '100%' as const } : {}),
} as const;

const helperTextStyle = {
  color: '#94a3b8',
  fontSize: 13,
  lineHeight: 1.5,
} as const;

const statGridStyle = {
  display: 'grid',
  gridTemplateColumns: CD_IS_MOBILE ? 'repeat(2, 1fr)' : 'repeat(auto-fit, minmax(140px, 1fr))',
  gap: CD_IS_MOBILE ? 6 : 10,
} as const;

const statCardStyle = {
  borderRadius: 12,
  padding: '12px 14px',
  border: '1px solid rgba(51,65,85,0.9)',
  background: 'rgba(15,23,42,0.75)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
} as const;

const splitSectionStyle = {
  display: 'grid',
  gridTemplateColumns: CD_IS_MOBILE ? '1fr' : 'repeat(auto-fit, minmax(320px, 1fr))',
  gap: 12,
  alignItems: 'start',
} as const;

const resourceListStyle = {
  display: 'grid',
  gap: 10,
} as const;

const resourceCardStyle = {
  borderRadius: 12,
  padding: '12px 14px',
  border: '1px solid rgba(51,65,85,0.9)',
  background: 'rgba(15,23,42,0.78)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
} as const;

const metaGridStyle = {
  display: 'grid',
  gridTemplateColumns: CD_IS_MOBILE ? 'repeat(2, 1fr)' : 'repeat(auto-fit, minmax(140px, 1fr))',
  gap: CD_IS_MOBILE ? 6 : 8,
} as const;

const metaCardStyle = {
  borderRadius: 10,
  border: '1px solid rgba(51,65,85,0.9)',
  background: 'rgba(2,6,23,0.55)',
  padding: '8px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
} as const;

interface Props {
  enterpriseId?: string;
  canonicalRepoId?: string;
  workspaceId?: string;
  enrollmentId?: string;
  language?: string;
  filePath?: string;
  persistedSnapshot?: {
    label: string;
    diagnostics: SharedContextDiagnosticsView;
    bindings: RuntimeAuthoredContextBindingView[];
  } | null;
  onStateChange?: (next: {
    enterpriseId: string;
    canonicalRepoId: string;
    workspaceId: string;
    enrollmentId: string;
    language: string;
    filePath: string;
  }) => void;
}

function StatCard({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div style={statCardStyle}>
      <span style={{ color: '#94a3b8', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</span>
      <strong style={{ fontSize: 22, lineHeight: 1.1 }}>{value}</strong>
      {detail ? <span style={{ color: '#94a3b8', fontSize: 12 }}>{detail}</span> : null}
    </div>
  );
}

function MetaCard({ label, value }: { label: string; value: string | number | boolean }) {
  return (
    <div style={metaCardStyle}>
      <span style={{ color: '#94a3b8', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      <span style={{ color: '#e2e8f0', fontSize: 13, lineHeight: 1.4 }}>{String(value)}</span>
    </div>
  );
}

function SectionHeading({ title, description, action }: { title: string; description?: string; action?: ComponentChildren }) {
  return (
    <div style={{ ...rowStyle, justifyContent: 'space-between', alignItems: 'flex-start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <strong>{title}</strong>
        {description ? <span style={helperTextStyle}>{description}</span> : null}
      </div>
      {action ? <div style={{ flexShrink: 0 }}>{action}</div> : null}
    </div>
  );
}

export function ContextDiagnosticsPanel(props: Props) {
  const { t } = useTranslation();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [enterpriseId, setEnterpriseId] = useState(props.enterpriseId ?? '');
  const [canonicalRepoId, setCanonicalRepoId] = useState(props.canonicalRepoId ?? '');
  const [workspaceId, setWorkspaceId] = useState(props.workspaceId ?? '');
  const [enrollmentId, setEnrollmentId] = useState(props.enrollmentId ?? '');
  const [language, setLanguage] = useState(props.language ?? '');
  const [filePath, setFilePath] = useState(props.filePath ?? '');
  const [diagnostics, setDiagnostics] = useState<SharedContextDiagnosticsView | null>(null);
  const [bindings, setBindings] = useState<RuntimeAuthoredContextBindingView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void listTeams()
      .then((nextTeams) => {
        setTeams(nextTeams);
        if (!enterpriseId && nextTeams[0]) setEnterpriseId(nextTeams[0].id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const load = useCallback(async () => {
    if (!enterpriseId || !canonicalRepoId.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const [nextDiagnostics, nextBindings] = await Promise.all([
        getSharedContextDiagnostics(enterpriseId, canonicalRepoId.trim(), {
          workspaceId: workspaceId.trim() || undefined,
          enrollmentId: enrollmentId.trim() || undefined,
          language: language.trim() || undefined,
          filePath: filePath.trim() || undefined,
        }),
        getRuntimeAuthoredContext(enterpriseId, {
          canonicalRepoId: canonicalRepoId.trim(),
          workspaceId: workspaceId.trim() || undefined,
          enrollmentId: enrollmentId.trim() || undefined,
          language: language.trim() || undefined,
          filePath: filePath.trim() || undefined,
        }),
      ]);
      setDiagnostics(nextDiagnostics);
      setBindings(nextBindings);
      props.onStateChange?.({
        enterpriseId,
        canonicalRepoId: canonicalRepoId.trim(),
        workspaceId,
        enrollmentId,
        language,
        filePath,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [canonicalRepoId, enterpriseId, enrollmentId, filePath, language, props, workspaceId]);

  return (
    <div style={shellStyle}>
      <div style={heroStyle}>
        <div style={{ ...rowStyle, justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <strong style={{ fontSize: 22, lineHeight: 1.1 }}>{t('sharedContext.diagnostics.title')}</strong>
            <span style={helperTextStyle}>
              Inspect how the runtime resolved visibility, freshness, and authored bindings for one shared-context target.
            </span>
          </div>
          <button style={buttonStyle} onClick={() => void load()}>{t('sharedContext.diagnostics.load')}</button>
        </div>
        <div style={rowStyle}>
          <select value={enterpriseId} onChange={(e) => setEnterpriseId((e.currentTarget as HTMLSelectElement).value)} style={inputStyle}>
            <option value="">{t('sharedContext.management.selectEnterprise')}</option>
            {teams.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
          <input value={canonicalRepoId} onInput={(e) => setCanonicalRepoId((e.currentTarget as HTMLInputElement).value)} placeholder={t('sharedContext.management.canonicalRepoId')} style={inputStyle} />
          <input value={workspaceId} onInput={(e) => setWorkspaceId((e.currentTarget as HTMLInputElement).value)} placeholder={t('sharedContext.diagnostics.workspaceId')} style={inputStyle} />
          <input value={enrollmentId} onInput={(e) => setEnrollmentId((e.currentTarget as HTMLInputElement).value)} placeholder={t('sharedContext.diagnostics.enrollmentId')} style={inputStyle} />
          <input value={language} onInput={(e) => setLanguage((e.currentTarget as HTMLInputElement).value)} placeholder={t('sharedContext.management.language')} style={inputStyle} />
          <input value={filePath} onInput={(e) => setFilePath((e.currentTarget as HTMLInputElement).value)} placeholder={t('sharedContext.diagnostics.filePath')} style={inputStyle} />
        </div>
        <div style={statGridStyle}>
          <StatCard label="Enterprise" value={teams.find((team) => team.id === enterpriseId)?.name ?? 'Unselected'} />
          <StatCard label="Repository" value={canonicalRepoId.trim() || 'Unset'} detail={workspaceId.trim() || 'No workspace override'} />
          <StatCard label="Language" value={language.trim() || 'Any'} detail={filePath.trim() || 'No file filter'} />
        </div>
        {loading && <div style={helperTextStyle}>{t('sharedContext.loading')}</div>}
        {error && <div style={{ color: '#fca5a5' }}>{error}</div>}
      </div>

      {diagnostics ? (
        <div style={splitSectionStyle}>
          <div style={sectionStyle}>
            <SectionHeading
              title="Runtime Decision"
              description="This is the live shared-context decision the runtime would use for dispatch."
            />
            <div style={statGridStyle}>
              <StatCard label={t('sharedContext.diagnostics.mode')} value={diagnostics.retrievalMode} />
              <StatCard label={t('sharedContext.diagnostics.visibility')} value={diagnostics.visibilityState} />
              <StatCard label={t('sharedContext.diagnostics.remoteProcessed')} value={diagnostics.remoteProcessedFreshness} />
              <StatCard label="Bindings" value={diagnostics.diagnostics.activeBindingCount} detail={`${diagnostics.diagnostics.appliedDocumentVersionIds.length} versions applied`} />
            </div>
            <div style={metaGridStyle}>
              <MetaCard label={t('sharedContext.diagnostics.derivedOnDemand')} value={diagnostics.diagnostics.derivedOnDemand} />
              <MetaCard label={t('sharedContext.diagnostics.persistedSnapshotAvailable')} value={diagnostics.diagnostics.persistedSnapshotAvailable} />
              <MetaCard label="Allow degraded" value={diagnostics.policy.allowDegradedProviderSupport} />
              <MetaCard label="Allow local fallback" value={diagnostics.policy.allowLocalFallback} />
              <MetaCard label="Require full support" value={diagnostics.policy.requireFullProviderSupport} />
            </div>
            <div style={{ ...resourceCardStyle, gap: 6 }}>
              <strong>{t('sharedContext.diagnostics.appliedVersions')}</strong>
              <div style={helperTextStyle}>
                {diagnostics.diagnostics.appliedDocumentVersionIds.join(', ') || t('sharedContext.empty')}
              </div>
            </div>
          </div>

          <div style={sectionStyle}>
            <SectionHeading
              title={t('sharedContext.diagnostics.runtimeBindings')}
              description="These are the authored context fragments currently selected for the provided repo, language, and path."
              action={<span style={helperTextStyle}>{bindings.length} bindings</span>}
            />
            {bindings.length === 0 ? (
              <div style={helperTextStyle}>{t('sharedContext.empty')}</div>
            ) : (
              <div style={resourceListStyle}>
                {bindings.map((binding) => (
                  <div key={binding.bindingId} style={resourceCardStyle}>
                    <div style={{ ...rowStyle, justifyContent: 'space-between' }}>
                      <strong>{binding.mode} · {binding.scope}</strong>
                      <span style={helperTextStyle}>{binding.documentVersionId}</span>
                    </div>
                    <pre style={{ whiteSpace: 'pre-wrap', margin: 0, color: '#cbd5e1', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5, lineHeight: 1.5 }}>
                      {binding.content}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {props.persistedSnapshot ? (
        <div style={sectionStyle}>
          <SectionHeading
            title={t('sharedContext.diagnostics.snapshotTitle')}
            description="Persisted snapshots are for migration and audit comparison, not live authority."
            action={<span style={helperTextStyle}>{props.persistedSnapshot.label}</span>}
          />
          <div style={statGridStyle}>
            <StatCard label={t('sharedContext.diagnostics.mode')} value={props.persistedSnapshot.diagnostics.retrievalMode} />
            <StatCard label={t('sharedContext.diagnostics.remoteProcessed')} value={props.persistedSnapshot.diagnostics.remoteProcessedFreshness} />
            <StatCard label={t('sharedContext.diagnostics.snapshotBindings')} value={props.persistedSnapshot.bindings.length} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
